import express from "express";
import { z } from "zod";
import { BillingError, publicBillingErrorDetails } from "@/lib/billing";
import { executeRelayChat, RelayChatError } from "@/lib/relayChat";
import { resolveRelayPrincipalId } from "@/lib/relayUtils";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { requireActiveWorkspacePermission } from "@/middleware/permissions";
import { requireIdempotencyKey } from "@/middleware/idempotencyKey";
import { listWorkbenchTextModels } from "@/lib/workbenchTextModelCatalog";
import { logger } from "@/lib/logger";
import { buildCanvasArtifactMessages, canvasTextContextSchema, canvasTextOperationSchema, parseCanvasArtifactResponse, type CanvasTextArtifactResult } from "@/lib/canvasTextArtifacts";
import {
  beginDurableCommand,
  completeDurableCommand,
  DurableCommandIdempotencyError,
} from "@/lib/durableCommandIdempotency";

const router = express.Router();
const MAX_CANVAS_TEXT_CHARACTERS = 1_000_000;

export default router.post(
  "/",
  requireActiveWorkspacePermission("generation:create"),
  requireIdempotencyKey,
  (req, res, next) => {
    if (typeof req.body.prompt === "string" && req.body.prompt.trim().length > MAX_CANVAS_TEXT_CHARACTERS) {
      return res.status(400).send({
        message: "正文超过100万字符，请按章节拆分到多个文本节点后提取；正文和已有卡片已保留，本次未调用模型",
        code: "CANVAS_TEXT_INPUT_TOO_LONG",
      });
    }
    next();
  },
  validateFields({
    prompt: z.string().trim().min(1).max(MAX_CANVAS_TEXT_CHARACTERS),
    model: z.string().trim().min(1).max(200),
    operation: canvasTextOperationSchema.optional(),
    instruction: z.string().trim().max(4_000).optional(),
    context: canvasTextContextSchema.optional(),
  }),
  async (req, res) => {
    const workspaceId = String((req as any).auth?.workspaceId || "");
    const input = {
      prompt: String(req.body.prompt).trim(), model: String(req.body.model).trim(),
      ...(req.body.operation ? {
        operation: canvasTextOperationSchema.parse(req.body.operation),
        instruction: String(req.body.instruction || "").trim(),
        context: canvasTextContextSchema.parse(req.body.context || []),
      } : {}),
    };
    let reservation;
    let invocationStarted = false;
    let completionReceived = false;
    try {
      reservation = await beginDurableCommand<{ text: string; cards?: CanvasTextArtifactResult[] } | { message: string; code: string }>({
        workspaceId,
        actorUserId: Number((req as any).auth?.user?.id || 0),
        scope: "workbench:canvas:text",
        idempotencyKey: req.header("idempotency-key"),
        request: input,
      });
      if (reservation.kind === "replay") {
        return res.status(reservation.responseStatus).send(
          reservation.responseStatus >= 400
            ? reservation.responseBody
            : success(reservation.responseBody),
        );
      }
      const models = await listWorkbenchTextModels(workspaceId);
      const model = models.find((candidate) => candidate.id === input.model);
      if (!model) {
        const body = { message: "所选文本模型不可用，请重新选择模型", code: "CANVAS_TEXT_MODEL_UNAVAILABLE" };
        await completeDurableCommand(reservation, body, 400);
        return res.status(400).send(body);
      }
      invocationStarted = true;
      const maxOutputTokens = input.operation ? 32_768 : 8_192;
      const completion = await executeRelayChat({
        model: model.id,
        messages: input.operation
          ? buildCanvasArtifactMessages({ ...input, operation: input.operation })
          : [{ role: "user", content: input.prompt }],
        max_tokens: maxOutputTokens,
        stream: false,
      }, {
        workspaceId,
        apiKeyId: null,
        principalId: resolveRelayPrincipalId(req),
        requestId: String((req as any).requestId || "").trim() || null,
        idempotencyKey: `canvas-text:${String(req.header("idempotency-key") || "").trim()}`,
        ...(input.operation ? { purpose: "script_asset_extraction" as const } : {}),
      });
      completionReceived = true;
      const choice = completion.response?.choices?.[0];
      const content = choice?.message?.content;
      const text = (typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.map((part: any) => typeof part === "string" ? part : part?.text || "").join("")
          : "").trim();
      const outputBudgetExhausted = Number(completion.usage?.outputTokens || 0) >= maxOutputTokens;
      const truncatedMessage = input.operation === "shots"
        ? "模型输出达到上限，分镜未完整返回；正文和已有卡片已保留。请减少分镜数量或简化描述后重试"
        : "模型输出达到上限，素材提取结果未完整返回；正文和已有卡片已保留。请限定提取范围、简化描述或更换文本模型后重试";
      if (input.operation && (choice?.finish_reason === "length" || (!text && outputBudgetExhausted))) {
        logger.warn({ operation: input.operation, model: input.model, finishReason: choice?.finish_reason, outputTokens: completion.usage?.outputTokens, maxOutputTokens }, "Canvas artifact output reached its token limit");
        const body = { message: truncatedMessage, code: "CANVAS_TEXT_ARTIFACT_TRUNCATED" };
        await completeDurableCommand(reservation, body, 422);
        return res.status(422).send(body);
      }
      if (!text) {
        const body = { message: "文本模型已响应，但未返回正文", code: "CANVAS_TEXT_EMPTY_RESULT" };
        await completeDurableCommand(reservation, body, 422);
        return res.status(422).send(body);
      }
      let cards: CanvasTextArtifactResult[] | undefined;
      if (input.operation) {
        try {
          cards = parseCanvasArtifactResponse(text, input.operation, input.context);
        } catch (error) {
          logger.warn({
            operation: input.operation, model: input.model, finishReason: choice?.finish_reason, outputTokens: completion.usage?.outputTokens,
            failureKind: error instanceof SyntaxError ? "json" : "validation",
            validationMessage: error instanceof Error ? error.message.slice(0, 1000) : "unknown",
            issues: error instanceof z.ZodError ? error.issues.map(({ code, path }) => ({ code, path })) : undefined,
          }, "Canvas artifact response validation failed");
          const truncated = outputBudgetExhausted && error instanceof SyntaxError;
          const body = {
            message: truncated ? truncatedMessage : "模型已返回，但提取结果格式无效，旧结果已保留；重试将发起新的生成",
            code: truncated ? "CANVAS_TEXT_ARTIFACT_TRUNCATED" : "CANVAS_TEXT_ARTIFACT_INVALID",
          };
          await completeDurableCommand(reservation, body, 422);
          return res.status(422).send(body);
        }
      }
      const result = { text, ...(cards ? { cards } : {}) };
      await completeDurableCommand(reservation, result);
      return res.status(200).send(success(result));
    } catch (error) {
      logger.warn({
        requestId: String((req as any).requestId || ""), operation: input.operation, model: input.model,
        invocationStarted, completionReceived,
        upstreamStatus: error instanceof RelayChatError ? error.statusCode : undefined,
        upstreamMayHaveAccepted: error instanceof RelayChatError ? error.upstreamMayHaveAccepted : undefined,
        upstreamFailure: error instanceof RelayChatError ? error.upstreamFailure : undefined,
        errorType: error instanceof Error ? error.name : "unknown",
      }, "Canvas text request did not complete");
      if (error instanceof DurableCommandIdempotencyError) {
        return res.status(error.status).send({ message: error.message, code: error.code });
      }
      const insufficientBalance = (error instanceof BillingError && error.status === 402)
        || (error instanceof RelayChatError && error.statusCode === 402);
      const contextExceeded = error instanceof RelayChatError
        && error.statusCode === 400 && !error.upstreamMayHaveAccepted
        && /maximum context length|context[_ ](?:length|window)|too many (?:input )?tokens|上下文.{0,20}(?:超|限制)|输入.{0,20}(?:过长|超出)/i.test(error.message);
      const uncertain = !completionReceived && (error instanceof RelayChatError
        ? error.upstreamMayHaveAccepted
        : invocationStarted);
      const status = insufficientBalance ? 402 : contextExceeded ? 400 : uncertain ? 409 : 503;
      const body = {
        message: insufficientBalance
          ? "余额不足，请充值后重试"
          : contextExceeded
            ? "正文超过所选模型的上下文容量，请按章节拆分到多个文本节点后提取；正文和已有卡片已保留"
          : uncertain
            ? "文本请求结果暂未确认，请保留当前请求，避免重复计费"
            : completionReceived
              ? "文本模型已响应，但结果保存失败，请勿重复提交"
              : "文本生成服务暂不可用，请检查模型配置或稍后重试",
        code: insufficientBalance
          ? "CANVAS_TEXT_INSUFFICIENT_BALANCE"
          : contextExceeded ? "CANVAS_TEXT_CONTEXT_EXCEEDED"
          : uncertain ? "CANVAS_TEXT_PENDING_RECONCILE" : "CANVAS_TEXT_UNAVAILABLE",
        ...(error instanceof BillingError && publicBillingErrorDetails(error)
          ? { data: publicBillingErrorDetails(error) }
          : {}),
      };
      if (reservation && !completionReceived) {
        await completeDurableCommand(reservation, body, status).catch(() => undefined);
      }
      return res.status(status).send(body);
    }
  },
);
