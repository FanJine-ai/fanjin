import express from "express";
import { z } from "zod";
import { BillingError, publicBillingErrorDetails } from "@/lib/billing";
import { executeRelayChat, RelayChatError, type RelayChatResult } from "@/lib/relayChat";
import { resolveRelayPrincipalId } from "@/lib/relayUtils";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { requireActiveWorkspacePermission } from "@/middleware/permissions";
import { buildDirectorPlanPrompt, extractJsonObject, normalizeDirectorInput, normalizeDirectorPlan } from "@/lib/quickCreate";
import { listWorkbenchTextModels } from "@/lib/workbenchTextModelCatalog";
import {
  beginDurableCommand,
  completeDurableCommand,
  DurableCommandIdempotencyError,
} from "@/lib/durableCommandIdempotency";
import { requireIdempotencyKey } from "@/middleware/idempotencyKey";

const router = express.Router();

const ratioSchema = z.string().regex(/^\d{1,3}:\d{1,3}$/);

function assistantText(result: RelayChatResult): string {
  const content = result.response?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part: unknown) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      return typeof (part as Record<string, unknown>).text === "string"
        ? String((part as Record<string, unknown>).text)
        : "";
    })
    .join("")
    .trim();
}

export default router.post(
  "/",
  requireActiveWorkspacePermission("generation:create"),
  requireIdempotencyKey,
  validateFields({
    brief: z.string().min(1),
    style: z.string().optional().nullable(),
    targetType: z.string().optional().nullable(),
    ratio: ratioSchema.default("16:9"),
    llmModel: z.string().optional().default("universalAi"),
    duration: z.number().optional().default(15),
    shotCount: z.number().optional().default(3),
    projectId: z.number().int().positive().optional().nullable(),
  }),
  async (req, res) => {
    const input = normalizeDirectorInput(req.body);
    const workspaceId = String((req as any).auth?.workspaceId || "");
    const actorUserId = Number((req as any).auth?.user?.id || 0);
    let providerInvocationStarted = false;
    let commandReservation;
    try {
      const requestedModel = String(req.body.llmModel || "universalAi");
      commandReservation = await beginDurableCommand<Record<string, unknown>>({
        workspaceId,
        actorUserId,
        scope: "workbench:create:director-plan",
        idempotencyKey: req.header("idempotency-key"),
        request: {
          ...input,
          llmModel: requestedModel,
          projectId: req.body.projectId ?? null,
        },
        ...(Number.isSafeInteger(Number(req.body.projectId))
          && Number(req.body.projectId) > 0
          ? {
              resourceType: "project",
              resourceId: Number(req.body.projectId),
            }
          : {}),
      });
      if (commandReservation.kind === "replay") {
        if (commandReservation.responseStatus >= 400) {
          return res
            .status(commandReservation.responseStatus)
            .send(commandReservation.responseBody);
        }
        return res
          .status(commandReservation.responseStatus)
          .send(success(commandReservation.responseBody));
      }
      const relayModels = await listWorkbenchTextModels(workspaceId);
      const relayModel = requestedModel === "universalAi"
        ? relayModels[0]
        : relayModels.find((model) => model.id === requestedModel);
      let completionText = "";

      if (relayModel) {
        providerInvocationStarted = true;
        const completion = await executeRelayChat({
          model: relayModel.id,
          messages: [{ role: "user", content: buildDirectorPlanPrompt(input) }],
          temperature: 0.3,
          max_tokens: 4_096,
          stream: false,
          user: `quick-create-director:${resolveRelayPrincipalId(req) || "workspace"}`,
        }, {
          workspaceId,
          apiKeyId: null,
          principalId: resolveRelayPrincipalId(req),
          requestId: String((req as any).requestId || req.header("x-request-id") || "").trim() || null,
          idempotencyKey: String(req.header("idempotency-key") || "").trim() || null,
        });
        completionText = assistantText(completion);
        if (!completionText) throw new Error("Director plan model returned empty content");
      } else {
        throw new Error("No relay-backed text model is available");
      }

      const rawPlan = extractJsonObject(completionText);
      const plan = normalizeDirectorPlan(rawPlan, input);
      await completeDurableCommand(commandReservation, { plan });
      res.status(200).send(success({ plan }));
    } catch (error) {
      if (error instanceof DurableCommandIdempotencyError) {
        return res.status(error.status).send({ message: error.message, code: error.code });
      }
      if (error instanceof BillingError) {
        if (error.status !== 402) {
          const body = {
            message: "AI 规划请求可能已产生上游调用或账务状态，正在等待核对，请勿更换请求重试",
            code: "DIRECTOR_PLAN_PENDING_RECONCILE",
          };
          if (commandReservation) {
            await completeDurableCommand(commandReservation, body, 409).catch(() => undefined);
          }
          return res.status(409).send(body);
        }
        const body = {
          message: error.message,
          code: "DIRECTOR_PLAN_INSUFFICIENT_BALANCE",
          ...(publicBillingErrorDetails(error)
            ? { data: publicBillingErrorDetails(error) }
            : {}),
        };
        if (commandReservation) {
          await completeDurableCommand(commandReservation, body, error.status).catch(() => undefined);
        }
        return res.status(error.status).send(body);
      }
      if (error instanceof RelayChatError && error.statusCode === 402) {
        const body = {
          message: "工作区余额不足，请充值后重试",
          code: "DIRECTOR_PLAN_INSUFFICIENT_BALANCE",
        };
        if (commandReservation) {
          await completeDurableCommand(commandReservation, body, 402).catch(() => undefined);
        }
        return res.status(402).send(body);
      }
      if (
        error instanceof RelayChatError
        ? error.upstreamMayHaveAccepted
        : providerInvocationStarted
      ) {
        const body = {
          message: "AI 规划请求可能已被上游受理，正在等待结果与账务核对，请勿更换请求重试",
          code: "DIRECTOR_PLAN_PENDING_RECONCILE",
        };
        if (commandReservation) {
          await completeDurableCommand(commandReservation, body, 409).catch(() => undefined);
        }
        return res.status(409).send(body);
      }
      const body = {
        message: "AI 规划服务暂不可用，请检查对话模型配置或稍后重试",
        code: "DIRECTOR_PLAN_UNAVAILABLE",
      };
      if (commandReservation) {
        await completeDurableCommand(commandReservation, body, 503).catch(() => undefined);
      }
      res.status(503).send(body);
    }
  },
);
