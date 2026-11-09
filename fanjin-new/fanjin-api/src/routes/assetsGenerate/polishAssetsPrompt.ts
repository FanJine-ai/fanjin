import express from "express";
import u from "@/utils";
import * as zod from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { buildFallbackAssetPromptSystem, normalizeAssetType } from "@/lib/assetPromptFallback";
import { requireProjectPermission } from "@/middleware/projectAccess";
import { executeRelayChat, RelayChatError, type RelayChatResult } from "@/lib/relayChat";
import { resolveRelayPrincipalId } from "@/lib/relayUtils";
import { listWorkbenchTextModels } from "@/lib/workbenchTextModelCatalog";
import { BillingError, publicBillingErrorDetails } from "@/lib/billing";
import {
  beginDurableCommand,
  checkpointDurableCommand,
  completeDurableCommand,
  DurableCommandIdempotencyError,
  type DurableCommandReservation,
} from "@/lib/durableCommandIdempotency";
import { db } from "@/utils/db";
const router = express.Router();


type ItemType = "characters" | "props" | "scenes";
type AssetPromptCommandResponse = {
  prompt: string;
  assetsId: number;
  model: string;
};
type AssetPromptCheckpoint = {
  version: "asset-prompt-command.v1";
  phase: "provider_succeeded";
  projectId: number;
  assetsId: number;
  prompt: string;
  model: string;
};
type AssetPromptReservation = DurableCommandReservation<AssetPromptCommandResponse>;

const COMMAND_SCOPE = "assets:polish-prompt";

function commandError(code: string, message: string) {
  return { code, message };
}

function parseProviderCheckpoint(
  checkpoint: unknown,
  input: { projectId: number; assetsId: number },
): AssetPromptCheckpoint {
  const parsed = zod.object({
    version: zod.literal("asset-prompt-command.v1"),
    phase: zod.literal("provider_succeeded"),
    projectId: zod.number().int().positive(),
    assetsId: zod.number().int().positive(),
    prompt: zod.string().trim().min(1),
    model: zod.string().trim().min(1),
  }).safeParse(checkpoint);
  if (
    !parsed.success
    || parsed.data.projectId !== input.projectId
    || parsed.data.assetsId !== input.assetsId
  ) {
    throw new DurableCommandIdempotencyError(
      500,
      "idempotency_checkpoint_invalid",
      "提示词生成恢复检查点与当前资产不一致",
    );
  }
  return parsed.data;
}

async function persistProviderResult(
  reservation: AssetPromptReservation,
  checkpoint: AssetPromptCheckpoint,
): Promise<AssetPromptCommandResponse> {
  const responseBody: AssetPromptCommandResponse = {
    prompt: checkpoint.prompt,
    assetsId: checkpoint.assetsId,
    model: checkpoint.model,
  };
  await db.transaction(async (transaction) => {
    const updated = await transaction("o_assets")
      .where({
        id: checkpoint.assetsId,
        projectId: checkpoint.projectId,
        deletionState: "active",
      })
      .update({
        prompt: checkpoint.prompt,
        promptState: "已完成",
        promptErrorReason: null,
      });
    if (Number(updated) !== 1) {
      throw new DurableCommandIdempotencyError(
        409,
        "asset_prompt_target_changed",
        "资产状态已变化，请刷新后重试",
      );
    }
    await completeDurableCommand(
      reservation,
      responseBody,
      200,
      { database: transaction as typeof db },
    );
  });
  return responseBody;
}

async function completeCommandError(
  reservation: AssetPromptReservation | undefined,
  status: number,
  body: { code: string; message: string },
): Promise<void> {
  if (!reservation) return;
  await completeDurableCommand(reservation, body as unknown as AssetPromptCommandResponse, status)
    .catch(() => undefined);
}

async function markPromptState(
  projectId: number,
  assetsId: number,
  promptState: string,
  promptErrorReason: string | null,
): Promise<void> {
  await db("o_assets")
    .where({
      id: assetsId,
      projectId,
      deletionState: "active",
    })
    .update({ promptState, promptErrorReason });
}

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

//润色提示词
export default router.post(
  "/",
  requireProjectPermission("generation:create"),
  validateFields({
    assetsId: zod.number(),
    projectId: zod.number(),
    type: zod.string(),
    name: zod.string(),
    describe: zod.string(),
  }),
  async (req, res) => {
    const { assetsId, projectId, type, name, describe } = req.body;
    const workspaceId = String(
      (req as any).project?.workspaceId
      || (req as any).auth?.workspaceId
      || "",
    ).trim();
    const actorUserId = Number((req as any).auth?.user?.id || 0);
    const idempotencyKey = String(req.header("idempotency-key") || "").trim();
    if (!idempotencyKey) {
      return res.status(400).send(commandError(
        "idempotency_key_required",
        "真实文本提示词生成必须提供 Idempotency-Key，以避免重复调用与扣费",
      ));
    }
    //获取风格
    const project = await u.db("o_project")
      .where({
        id: projectId,
        workspaceId,
        deletionState: "active",
      })
      .select("artStyle", "type", "intro")
      .first();
    //如果没有找到对应的项目，返回错误
    if (!project) return res.status(404).send(error("项目不存在"));

    //查询资产是否是衍生资产
    const assetsData = await u.db("o_assets")
      .where({
        id: assetsId,
        projectId,
        deletionState: "active",
      })
      .whereIn("type", ["role", "scene", "tool"])
      .select("assetsId")
      .first();
    if (!assetsData) return res.status(404).send(error("资产不存在"));
    const typeConfig: Record<string, { promptKey: string; itemType: ItemType; label: string; nameLabel: string; visualManual: string }> = {
      role: {
        promptKey: "role-polish",
        itemType: "characters",
        label: "角色标准四视图",
        nameLabel: "角色",
        visualManual: assetsData.assetsId ? "art_character_derivative" : "art_character",
      },
      scene: {
        promptKey: "scene-polish",
        itemType: "scenes",
        label: "场景图",
        nameLabel: "场景",
        visualManual: assetsData.assetsId ? "art_scene_derivative" : "art_scene",
      },
      tool: {
        promptKey: "tool-polish",
        itemType: "props",
        label: "道具图",
        nameLabel: "道具",
        visualManual: assetsData.assetsId ? "art_prop_derivative" : "art_prop",
      },
    };

    const normalizedType = normalizeAssetType(type);
    const config = normalizedType ? typeConfig[normalizedType] : null;
    if (!config) return res.status(400).send(commandError(
      "asset_prompt_type_unsupported",
      "不支持的资产类型",
    ));
    //获取到视觉手册
    const visualManual = (await u.getArtPrompt(project.artStyle as string, "art_skills", config.visualManual)) || buildFallbackAssetPromptSystem(project, config);
    const systemPrompt = visualManual;
    let commandReservation: AssetPromptReservation | undefined;
    let providerInvocationStarted = false;
    try {
      commandReservation = await beginDurableCommand<AssetPromptCommandResponse>({
        workspaceId,
        actorUserId,
        scope: COMMAND_SCOPE,
        idempotencyKey,
        request: {
          projectId,
          assetsId,
          type: normalizedType,
          name,
          describe,
        },
      });
      if (commandReservation.kind === "replay") {
        return commandReservation.responseStatus >= 400
          ? res
              .status(commandReservation.responseStatus)
              .send(commandReservation.responseBody)
          : res
              .status(commandReservation.responseStatus)
              .send(success(commandReservation.responseBody));
      }
      if (commandReservation.kind === "resume") {
        const checkpoint = parseProviderCheckpoint(
          commandReservation.checkpoint,
          { projectId, assetsId },
        );
        const responseBody = await persistProviderResult(commandReservation, checkpoint);
        return res.status(200).send(success(responseBody));
      }

      await markPromptState(projectId, assetsId, "生成中", null);
      const relayModel = (await listWorkbenchTextModels(workspaceId))[0];
      if (!relayModel) {
        const body = commandError(
          "ASSET_PROMPT_UNAVAILABLE",
          "当前工作区没有可提交的真实文本模型路由",
        );
        await markPromptState(projectId, assetsId, "失败", body.message);
        await completeCommandError(commandReservation, 503, body);
        return res.status(503).send(body);
      }
      providerInvocationStarted = true;
      const result = await executeRelayChat({
        model: relayModel.id,
        messages: [
          {
            role: "system",
            content: systemPrompt,
          },
          {
            role: "user",
            content: `**基础参数：**
      **${config.nameLabel}设定：**
      - ${config.nameLabel}名称:${name},
      - ${config.nameLabel}描述:${describe},`,
          },
        ],
        temperature: 0.3,
        max_tokens: 2_048,
        stream: false,
        user: `asset-prompt:${resolveRelayPrincipalId(req) || "workspace"}`,
      }, {
        workspaceId,
        apiKeyId: null,
        principalId: resolveRelayPrincipalId(req),
        requestId: String((req as any).requestId || req.header("x-request-id") || "").trim() || null,
        idempotencyKey: String(req.header("idempotency-key") || "").trim() || null,
      });
      const _output = assistantText(result);

      if (!_output) {
        const body = commandError(
          "ASSET_PROMPT_PENDING_RECONCILE",
          "文本模型已响应但未返回可用提示词，正在等待结果与账务核对，请勿更换请求重试",
        );
        await markPromptState(projectId, assetsId, "待核对", body.message);
        await completeCommandError(commandReservation, 409, body);
        return res.status(409).send(body);
      }
      const checkpoint: AssetPromptCheckpoint = {
        version: "asset-prompt-command.v1",
        phase: "provider_succeeded",
        projectId,
        assetsId,
        prompt: _output,
        model: relayModel.id,
      };
      commandReservation = await checkpointDurableCommand(
        commandReservation,
        checkpoint,
      );
      const responseBody = await persistProviderResult(commandReservation, checkpoint);
      return res.status(200).send(success(responseBody));
    } catch (e: any) {
      if (e instanceof DurableCommandIdempotencyError) {
        return res.status(e.status).send({ message: e.message, code: e.code });
      }
      if (commandReservation?.kind === "resume") {
        const body = commandError(
          "ASSET_PROMPT_PERSISTENCE_RETRYABLE",
          "真实提示词已经生成，但写入资产失败；请使用相同 Idempotency-Key 重试，系统不会再次调用模型",
        );
        await markPromptState(projectId, assetsId, "写入待重试", body.message)
          .catch(() => undefined);
        return res.status(503).send(body);
      }
      if (e instanceof BillingError) {
        if (e.status === 402) {
          const body = commandError(
            "ASSET_PROMPT_INSUFFICIENT_BALANCE",
            e.message || "工作区余额不足，请充值后发起新的提示词生成",
          );
          const billingDetails = publicBillingErrorDetails(e);
          if (billingDetails) Object.assign(body, { data: billingDetails });
          await markPromptState(projectId, assetsId, "失败", body.message);
          await completeCommandError(commandReservation, 402, body);
          return res.status(402).send(body);
        }
        const body = commandError(
          "ASSET_PROMPT_PENDING_RECONCILE",
          "提示词生成的账务状态正在核对，请勿更换请求重试",
        );
        await markPromptState(projectId, assetsId, "待核对", body.message);
        await completeCommandError(commandReservation, 409, body);
        return res.status(409).send(body);
      }
      if (e instanceof RelayChatError) {
        if (e.statusCode === 402) {
          const body = commandError(
            "ASSET_PROMPT_INSUFFICIENT_BALANCE",
            "工作区余额不足，请充值后发起新的提示词生成",
          );
          await markPromptState(projectId, assetsId, "失败", body.message);
          await completeCommandError(commandReservation, 402, body);
          return res.status(402).send(body);
        }
        if (!e.upstreamMayHaveAccepted) {
          const status = e.statusCode >= 400 && e.statusCode < 500
            ? e.statusCode
            : 503;
          const body = commandError(
            "ASSET_PROMPT_UPSTREAM_REJECTED",
            "文本模型明确拒绝了本次提示词请求；可调整内容或配置后发起新的请求",
          );
          await markPromptState(projectId, assetsId, "失败", body.message);
          await completeCommandError(commandReservation, status, body);
          return res.status(status).send(body);
        }
      }
      if (providerInvocationStarted) {
        const body = commandError(
          "ASSET_PROMPT_PENDING_RECONCILE",
          "提示词请求可能已被上游受理，正在等待结果与账务核对；请使用相同 Idempotency-Key 重试",
        );
        await markPromptState(projectId, assetsId, "待核对", body.message);
        await completeCommandError(commandReservation, 409, body);
        return res.status(409).send(body);
      }
      const body = commandError(
        "ASSET_PROMPT_UNAVAILABLE",
        "提示词生成服务暂不可用，请检查真实文本模型配置后发起新的请求",
      );
      await markPromptState(projectId, assetsId, "失败", body.message);
      await completeCommandError(commandReservation, 503, body);
      return res.status(503).send(body);
    }
  },
);
