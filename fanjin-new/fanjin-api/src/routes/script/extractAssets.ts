import express from "express";
import { z } from "zod";

import { hashIdempotencyRequest } from "@/agent-runtime/idempotency";
import { consumeRelayChatCompletionStream } from "@/agent-runtime/relayChatStreamConsumer";
import { BillingError, publicBillingErrorDetails } from "@/lib/billing";
import {
  beginDurableCommand,
  abandonDurableCommand,
  completeDurableCommand,
  DurableCommandIdempotencyError,
  mutateDurableCommandCheckpoint,
  type DurableCommandReservation,
} from "@/lib/durableCommandIdempotency";
import { executeDurableProjectMutation } from "@/lib/durableProjectMutation";
import { isPostgresClient } from "@/lib/dbDialect";
import { extractJsonObject } from "@/lib/quickCreate";
import { executeRelayChat, RelayChatError, type RelayChatResult } from "@/lib/relayChat";
import { resolveRelayPrincipalId } from "@/lib/relayUtils";
import { success } from "@/lib/responseFormat";
import {
  buildScriptAssetExtractionPrompt,
  buildStoredScriptAssetProposal,
  confirmScriptAssetProposal,
  findRecoverableScriptAssetProposal,
  normalizeScriptAssetModelOutput,
  parseStoredScriptAssetProposal,
  publicScriptAssetProposal,
  readScriptAssetExtractionBillingState,
  scriptContentHash,
  ScriptAssetExtractionError,
  type ScriptAssetConfirmationInput,
  type ScriptAssetSnapshot,
  type StoredScriptAssetProposal,
} from "@/lib/scriptAssetExtraction";
import { listWorkbenchTextModels } from "@/lib/workbenchTextModelCatalog";
import { requireIdempotencyKey } from "@/middleware/idempotencyKey";
import { validateFields } from "@/middleware/middleware";
import { requireProjectPermission } from "@/middleware/projectAccess";
import { db } from "@/utils/db";
import { loadScriptAssetBatchProposals, mergeScriptAssetProposals, MAX_EXTRACTION_BATCHES, MAX_MERGED_SCRIPT_ASSETS } from "@/lib/scriptAssetBatch";

const router = express.Router();

type ExtractionErrorBody = { message: string; code: string; data?: unknown; claimEpoch?: number };
type ExtractionStoredResponse = StoredScriptAssetProposal | ExtractionErrorBody;
type ExtractionCheckpoint = {
  phase: "queued" | "preparing" | "dispatching" | "provider_succeeded";
  attempt: number;
  claimEpoch: number;
  projectId: number;
  requestedModel: string | null;
  model: string | null;
  proposalId: string | null;
  scripts: ScriptAssetSnapshot[];
  storedProposal?: StoredScriptAssetProposal;
  recoveryTargetId?: string;
};

class ExtractionRecoveryBindingConflict extends Error {
  constructor(readonly referenceId: string) {
    super("资产提取恢复绑定状态已变化");
    this.name = "ExtractionRecoveryBindingConflict";
  }
}

const confirmationAssetSchema = z.object({
  clientId: z.string().trim().min(1).max(120),
  type: z.enum(["role", "scene", "tool"]),
  name: z.string().trim().min(1).max(200),
  describe: z.string().max(5_000).default(""),
  prompt: z.string().max(8_000).default(""),
  parentClientId: z.string().trim().min(1).max(120).optional().nullable(),
  stateLabel: z.string().trim().max(100).optional().nullable(),
});

function assistantText(result: RelayChatResult): string {
  const content = result.response?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.map((part: unknown) => {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object") return "";
    return typeof (part as Record<string, unknown>).text === "string"
      ? String((part as Record<string, unknown>).text)
      : "";
  }).join("").trim();
}

function identity(req: express.Request) {
  return {
    workspaceId: String((req as any).auth?.workspaceId || "").trim(),
    actorUserId: Number((req as any).auth?.user?.id || 0),
  };
}

function sendDurableError(res: express.Response, error: unknown) {
  if (error instanceof DurableCommandIdempotencyError) {
    return res.status(error.status).send({ message: error.message, code: error.code });
  }
  if (error instanceof ScriptAssetExtractionError) {
    return res.status(error.status).send({
      message: error.message,
      code: error.code,
      ...(error.data !== undefined ? { data: error.data } : {}),
    });
  }
  return null;
}

function publicExtractionError(body: ExtractionErrorBody): Omit<ExtractionErrorBody, "claimEpoch"> {
  return {
    message: body.message,
    code: body.code,
    ...(body.data !== undefined ? { data: body.data } : {}),
  };
}

async function resetDispatchToQueued(
  reservation: DurableCommandReservation<ExtractionStoredResponse> | undefined,
  options: { incrementAttempt?: boolean } = {},
) {
  if (reservation?.kind !== "resume") return;
  await mutateDurableCommandCheckpoint<ExtractionStoredResponse, ExtractionCheckpoint>(
    reservation,
    (checkpoint) => checkpoint.phase === "dispatching" || checkpoint.phase === "preparing"
      ? {
          ...checkpoint,
          phase: "queued",
          attempt: Math.max(0, Number(checkpoint.attempt) || 0)
            + (checkpoint.phase === "dispatching" && options.incrementAttempt ? 1 : 0),
        }
      : checkpoint,
  );
}

async function bindExtractionRecoveryTarget(
  reservation: DurableCommandReservation<ExtractionStoredResponse> | undefined,
  recoveryTargetId: string,
) {
  const targetId = String(recoveryTargetId || "").trim();
  if (reservation?.kind !== "resume" || !targetId || targetId === reservation.id) {
    throw new ExtractionRecoveryBindingConflict(
      reservation?.kind === "resume" ? reservation.id : targetId,
    );
  }
  const mutation = await mutateDurableCommandCheckpoint<ExtractionStoredResponse, ExtractionCheckpoint>(
    reservation,
    (checkpoint) => {
      const existingTargetId = String(checkpoint.recoveryTargetId || "").trim();
      if (checkpoint.phase === "provider_succeeded") {
        throw new ExtractionRecoveryBindingConflict(reservation.id);
      }
      if (existingTargetId && existingTargetId !== targetId) {
        throw new ExtractionRecoveryBindingConflict(existingTargetId);
      }
      return { ...checkpoint, recoveryTargetId: targetId };
    },
  );
  if (
    mutation.kind !== "resume"
    || String(mutation.checkpoint.recoveryTargetId || "").trim() !== targetId
  ) {
    const checkpoint = mutation.kind === "resume" ? mutation.checkpoint : null;
    throw new ExtractionRecoveryBindingConflict(
      String(checkpoint?.recoveryTargetId || reservation.id).trim(),
    );
  }
}

function extractionRecoveryBindingFailure(recoveryTargetId: string): ExtractionErrorBody {
  return {
    message: "资产提取恢复绑定未能持久化，系统已停止继续派发，请联系管理员核对",
    code: "script_asset_extraction_recovery_binding_failed",
    data: { referenceId: recoveryTargetId, canStartNewAttempt: false },
  };
}

async function bindExtractionRecoveryTargetFailClosed(
  reservation: DurableCommandReservation<ExtractionStoredResponse> | undefined,
  recoveryTargetId: string,
): Promise<ExtractionErrorBody | null> {
  try {
    await bindExtractionRecoveryTarget(reservation, recoveryTargetId);
    return null;
  } catch (error) {
    if (error instanceof ExtractionRecoveryBindingConflict) {
      return {
        message: "该资产提取请求的恢复状态已变化，请刷新当前请求状态",
        code: "script_asset_extraction_in_progress",
        data: { referenceId: error.referenceId, canStartNewAttempt: false },
      };
    }
    let terminalizationFailed = false;
    const failure = extractionRecoveryBindingFailure(recoveryTargetId);
    if (reservation) {
      try {
        await completeDurableCommand(reservation, failure, 409);
      } catch {
        terminalizationFailed = true;
      }
    }
    return terminalizationFailed
      ? {
          ...failure,
          message: "资产提取恢复绑定与终结均未能持久化；系统将依据历史任务时序阻止该请求派发，请联系管理员核对",
          data: {
            referenceId: recoveryTargetId,
            canStartNewAttempt: false,
            recoveryFence: "causal_peer",
          },
        }
      : failure;
  }
}

function extractionClaimEpoch(value: unknown): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  const claimEpoch = Number((value as { claimEpoch?: unknown }).claimEpoch || 0);
  return Number.isSafeInteger(claimEpoch) && claimEpoch > 0 ? claimEpoch : 0;
}

function blocksNewExtractionAttempt(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const stored = value as { kind?: unknown; code?: unknown };
  if (stored.kind === "script_asset_extraction_proposal/v1") return false;
  const code = String(stored.code || "");
  if ([
    "script_asset_extraction_retry_allowed",
    "script_asset_model_output_invalid",
  ].includes(code)) return false;
  return extractionClaimEpoch(value) > 0 || [
    "script_asset_extraction_manual_required",
    "script_asset_extraction_settled_without_proposal",
  ].includes(code);
}

function isCausalRecoveryPeer(
  currentCreatedAt: number,
  peer: { createdAt?: unknown; updatedAt?: unknown },
  stored: unknown,
) {
  const peerCreatedAt = Number(peer.createdAt || 0);
  const peerUpdatedAt = Number(peer.updatedAt || 0);
  return Number.isSafeInteger(currentCreatedAt)
    && currentCreatedAt > 0
    && Number.isSafeInteger(peerCreatedAt)
    && peerCreatedAt > 0
    && peerCreatedAt < currentCreatedAt
    && Number.isSafeInteger(peerUpdatedAt)
    && peerUpdatedAt >= currentCreatedAt
    && extractionClaimEpoch(stored) > 0;
}

function checkpointCanNeedCausalRecoveryFence(status: unknown, stored: unknown) {
  if (String(status) !== "checkpointed" || !stored || typeof stored !== "object" || Array.isArray(stored)) {
    return false;
  }
  const phase = String((stored as { phase?: unknown }).phase || "");
  return phase === "queued" || phase === "preparing";
}

async function findCausalScriptAssetRecoveryTarget(input: {
  workspaceId: string;
  projectId: number;
  requestHash: string;
  currentCommand: Record<string, unknown>;
}) {
  const currentCreatedAt = Number(input.currentCommand.createdAt || 0);
  if (!Number.isSafeInteger(currentCreatedAt) || currentCreatedAt <= 0) {
    throw new ScriptAssetExtractionError(500, "script_asset_recovery_invalid", "资产提取请求缺少有效的创建时间");
  }
  const peers = await db("o_agent_idempotency")
    .where({
      workspaceId: input.workspaceId,
      resourceType: "project",
      resourceId: String(input.projectId),
      requestHash: input.requestHash,
    })
    .whereIn("status", ["checkpointed", "completed"])
    .whereNot({ id: String(input.currentCommand.id || "") })
    .where("scopeKey", "like", `script:asset-extraction:proposal:${input.workspaceId}:%`)
    .where("createdAt", "<", currentCreatedAt)
    .where("updatedAt", ">=", currentCreatedAt)
    .orderBy("updatedAt", "desc")
    .limit(50);
  for (const peer of peers) {
    try {
      const stored = JSON.parse(String(peer.responseBody || "null"));
      if (isCausalRecoveryPeer(currentCreatedAt, peer, stored)) {
        return { row: peer, stored };
      }
    } catch {
      // Invalid or legacy peers cannot establish a causal dispatch fence.
    }
  }
  return null;
}

async function findBlockingTerminalScriptAssetExtraction(input: {
  workspaceId: string;
  projectId: number;
  requestHash: string;
  currentCommandId: string;
}) {
  const peers = await db("o_agent_idempotency")
    .where({
      workspaceId: input.workspaceId,
      resourceType: "project",
      resourceId: String(input.projectId),
      requestHash: input.requestHash,
      status: "completed",
    })
    .whereNot({ id: input.currentCommandId })
    .where("scopeKey", "like", `script:asset-extraction:proposal:${input.workspaceId}:%`)
    .orderBy("updatedAt", "desc")
    .limit(50);
  for (const peer of peers) {
    try {
      const stored = JSON.parse(String(peer.responseBody || "null"));
      if (blocksNewExtractionAttempt(stored)) return { row: peer, stored };
    } catch {
      // Invalid legacy terminal rows do not grant or deny retry authority.
    }
  }
  return null;
}

function sameScriptSnapshots(
  checkpointScripts: ScriptAssetSnapshot[],
  currentScripts: ScriptAssetSnapshot[],
): boolean {
  if (checkpointScripts.length !== currentScripts.length) return false;
  const currentById = new Map(currentScripts.map((script) => [script.id, script]));
  return checkpointScripts.every((snapshot) => {
    const current = currentById.get(snapshot.id);
    return current?.contentHash === snapshot.contentHash && current.name === snapshot.name;
  });
}

async function claimExtractionPreparation(input: {
  reservation: DurableCommandReservation<ExtractionStoredResponse>;
  workspaceId: string;
  projectId: number;
  requestedModel: string | null;
  scripts: ScriptAssetSnapshot[];
  requestHash: string;
}) {
  return await mutateDurableCommandCheckpoint<ExtractionStoredResponse, ExtractionCheckpoint>(
    input.reservation,
    async (checkpoint, transaction) => {
      if (checkpoint.phase !== "queued" && checkpoint.phase !== "preparing") {
        throw new ScriptAssetExtractionError(409, "script_asset_proposal_conflict", "资产提取请求状态已变化");
      }
      let projectLock = transaction("o_project")
        .where({ id: input.projectId, workspaceId: input.workspaceId })
        .select("id")
        .first();
      if (isPostgresClient(transaction)) projectLock = projectLock.forUpdate();
      if (!await projectLock) {
        throw new ScriptAssetExtractionError(404, "script_asset_source_not_found", "项目不存在或无权访问");
      }
      const currentCommand = await transaction("o_agent_idempotency")
        .where({ id: input.reservation.kind === "resume" ? input.reservation.id : "" })
        .select("createdAt")
        .first();
      const currentCreatedAt = Number(currentCommand?.createdAt || 0);
      if (!Number.isSafeInteger(currentCreatedAt) || currentCreatedAt <= 0) {
        throw new ScriptAssetExtractionError(500, "script_asset_recovery_invalid", "资产提取请求缺少有效的创建时间");
      }
      const peers = await transaction("o_agent_idempotency")
        .where({
          workspaceId: input.workspaceId,
          resourceType: "project",
          resourceId: String(input.projectId),
          requestHash: input.requestHash,
        })
        .whereIn("status", ["checkpointed", "completed"])
        .whereNot({ id: input.reservation.kind === "resume" ? input.reservation.id : "" })
        .where("scopeKey", "like", `script:asset-extraction:proposal:${input.workspaceId}:%`)
        .select("id", "status", "responseBody", "createdAt", "updatedAt");
      let maxClaimEpoch = Math.max(0, Number(checkpoint.claimEpoch) || 0);
      for (const peer of peers) {
        try {
          const parsed = JSON.parse(String(peer.responseBody || "null")) as ExtractionCheckpoint;
          if (String(peer.status) === "completed" && blocksNewExtractionAttempt(parsed)) {
            throw new ScriptAssetExtractionError(
              409,
              "script_asset_extraction_manual_required",
              "较早的资产提取已进入人工核对状态，未获得新的派发授权",
              { referenceId: String(peer.id), canStartNewAttempt: false },
            );
          }
          if (isCausalRecoveryPeer(currentCreatedAt, peer, parsed)) {
            throw new ScriptAssetExtractionError(
              409,
              "script_asset_extraction_pending_reconcile",
              "该请求创建时较早的资产提取尚未终结，请刷新其处理状态并使用新的请求重试",
              { referenceId: String(peer.id), canStartNewAttempt: false },
            );
          }
          if (String(peer.status) === "completed") {
            maxClaimEpoch = Math.max(maxClaimEpoch, Math.max(0, Number(parsed.claimEpoch) || 0));
            if ((parsed as unknown as { kind?: unknown })?.kind !== "script_asset_extraction_proposal/v1") {
              continue;
            }
            const proposal = parseStoredScriptAssetProposal(parsed);
            if (
              proposal.proposalId === String(peer.id)
              && !proposal.confirmed
              && proposal.projectId === input.projectId
              && sameScriptSnapshots(proposal.scriptSnapshots, input.scripts)
            ) {
              return {
                ...checkpoint,
                phase: "provider_succeeded",
                claimEpoch: Math.max(maxClaimEpoch, Math.max(0, Number(proposal.claimEpoch) || 0)),
                model: proposal.model,
                proposalId: proposal.proposalId,
                storedProposal: proposal,
              };
            }
            continue;
          }
          if (
            parsed.projectId !== input.projectId
            || parsed.requestedModel !== input.requestedModel
            || !Array.isArray(parsed.scripts)
            || !sameScriptSnapshots(parsed.scripts, input.scripts)
          ) continue;
          maxClaimEpoch = Math.max(maxClaimEpoch, Math.max(0, Number(parsed.claimEpoch) || 0));
          if (parsed.phase === "dispatching") {
            throw new ScriptAssetExtractionError(
              409,
              "script_asset_extraction_pending_reconcile",
              "同一批剧本的资产提取可能已被模型受理，正在等待结果与账务核对",
              { referenceId: String(peer.id), canStartNewAttempt: false },
            );
          }
          if (
            parsed.phase === "provider_succeeded"
            || (
              parsed.phase === "preparing"
              && Date.now() - Number(peer.updatedAt || 0) <= 2 * 60 * 1_000
            )
          ) {
            throw new ScriptAssetExtractionError(
              409,
              "script_asset_extraction_in_progress",
              "同一批剧本的资产提取正在处理，请稍后重试",
              { referenceId: String(peer.id), canStartNewAttempt: false },
            );
          }
        } catch (error) {
          if (error instanceof ScriptAssetExtractionError) throw error;
          // Ignore unrelated or older checkpoint formats.
        }
      }
      if (!Number.isSafeInteger(maxClaimEpoch) || maxClaimEpoch >= Number.MAX_SAFE_INTEGER) {
        throw new ScriptAssetExtractionError(500, "script_asset_recovery_invalid", "资产提取恢复序号无效");
      }
      return { ...checkpoint, phase: "preparing", claimEpoch: maxClaimEpoch + 1 };
    },
  );
}

async function promoteExtractionToDispatching(input: {
  reservation: DurableCommandReservation<ExtractionStoredResponse>;
  workspaceId: string;
  projectId: number;
  requestedModel: string | null;
  scripts: ScriptAssetSnapshot[];
  model: string;
  requestHash: string;
}) {
  return await mutateDurableCommandCheckpoint<ExtractionStoredResponse, ExtractionCheckpoint>(
    input.reservation,
    async (checkpoint, transaction) => {
      if (checkpoint.phase !== "preparing") {
        throw new ScriptAssetExtractionError(409, "script_asset_proposal_conflict", "资产提取请求状态已变化");
      }
      const claimEpoch = Math.max(0, Number(checkpoint.claimEpoch) || 0);
      if (!Number.isSafeInteger(claimEpoch) || claimEpoch <= 0) {
        throw new ScriptAssetExtractionError(409, "script_asset_proposal_conflict", "资产提取请求缺少有效的执行权");
      }
      let projectLock = transaction("o_project")
        .where({ id: input.projectId, workspaceId: input.workspaceId })
        .select("id")
        .first();
      if (isPostgresClient(transaction)) projectLock = projectLock.forUpdate();
      if (!await projectLock) {
        throw new ScriptAssetExtractionError(404, "script_asset_source_not_found", "项目不存在或无权访问");
      }
      const currentCommand = await transaction("o_agent_idempotency")
        .where({ id: input.reservation.kind === "resume" ? input.reservation.id : "" })
        .select("createdAt")
        .first();
      const currentCreatedAt = Number(currentCommand?.createdAt || 0);
      if (!Number.isSafeInteger(currentCreatedAt) || currentCreatedAt <= 0) {
        throw new ScriptAssetExtractionError(500, "script_asset_recovery_invalid", "资产提取请求缺少有效的创建时间");
      }
      const peers = await transaction("o_agent_idempotency")
        .where({
          workspaceId: input.workspaceId,
          resourceType: "project",
          resourceId: String(input.projectId),
          requestHash: input.requestHash,
        })
        .whereIn("status", ["checkpointed", "completed"])
        .whereNot({ id: input.reservation.kind === "resume" ? input.reservation.id : "" })
        .where("scopeKey", "like", `script:asset-extraction:proposal:${input.workspaceId}:%`)
        .select("id", "status", "responseBody", "createdAt", "updatedAt");
      for (const peer of peers) {
        try {
          const parsed = JSON.parse(String(peer.responseBody || "null")) as ExtractionCheckpoint;
          if (String(peer.status) === "completed" && blocksNewExtractionAttempt(parsed)) {
            throw new ScriptAssetExtractionError(
              409,
              "script_asset_extraction_manual_required",
              "较早的资产提取已进入人工核对状态，未获得新的派发授权",
              { referenceId: String(peer.id), canStartNewAttempt: false },
            );
          }
          if (isCausalRecoveryPeer(currentCreatedAt, peer, parsed)) {
            throw new ScriptAssetExtractionError(
              409,
              "script_asset_extraction_pending_reconcile",
              "该请求创建时较早的资产提取尚未终结，请刷新其处理状态并使用新的请求重试",
              { referenceId: String(peer.id), canStartNewAttempt: false },
            );
          }
          if (String(peer.status) === "completed") {
            if (Math.max(0, Number(parsed.claimEpoch) || 0) > claimEpoch) {
              throw new ScriptAssetExtractionError(
                409,
                "script_asset_extraction_in_progress",
                "该资产提取已由更新的恢复请求完成，请刷新后重试",
                { referenceId: String(peer.id), canStartNewAttempt: false },
              );
            }
            continue;
          }
          if (
            parsed.projectId !== input.projectId
            || parsed.requestedModel !== input.requestedModel
            || !Array.isArray(parsed.scripts)
            || !sameScriptSnapshots(parsed.scripts, input.scripts)
          ) continue;
          if (parsed.phase === "dispatching") {
            throw new ScriptAssetExtractionError(
              409,
              "script_asset_extraction_pending_reconcile",
              "同一批剧本的资产提取可能已被模型受理，正在等待结果与账务核对",
              { referenceId: String(peer.id), canStartNewAttempt: false },
            );
          }
          const peerClaimEpoch = Math.max(0, Number(parsed.claimEpoch) || 0);
          if (
            parsed.phase === "provider_succeeded"
            || (parsed.phase === "preparing" && peerClaimEpoch >= claimEpoch)
          ) {
            throw new ScriptAssetExtractionError(
              409,
              "script_asset_extraction_in_progress",
              "该资产提取已由更新的恢复请求接管，请刷新后重试",
              { referenceId: String(peer.id), canStartNewAttempt: false },
            );
          }
        } catch (error) {
          if (error instanceof ScriptAssetExtractionError) throw error;
          // Ignore unrelated or older checkpoint formats.
        }
      }
      return {
        ...checkpoint,
        phase: "dispatching",
        attempt: Math.max(0, Number(checkpoint.attempt) || 0),
        model: input.model,
        proposalId: input.reservation.kind === "resume" ? input.reservation.id : null,
      };
    },
  );
}

router.post(
  "/status",
  requireProjectPermission("generation:create"),
  requireIdempotencyKey,
  validateFields({ projectId: z.number().int().positive() }),
  async (req, res) => {
    const projectId = Number(req.body.projectId);
    const { workspaceId, actorUserId } = identity(req);
    const idempotencyKey = String(req.header("idempotency-key") || "").trim();
    const requestedCommandRow = await db("o_agent_idempotency")
      .where({
        workspaceId,
        actorUserId,
        scopeKey: `script:asset-extraction:proposal:${workspaceId}:${actorUserId}`,
        idempotencyKey,
        resourceType: "project",
        resourceId: String(projectId),
      })
      .first();
    if (!requestedCommandRow) {
      return res.status(404).send({
        message: "未找到该资产提取尝试，请重新选择剧本后发起",
        code: "script_asset_extraction_attempt_not_found",
      });
    }
    let commandRow = requestedCommandRow;
    let stored: unknown;
    try {
      stored = JSON.parse(String(commandRow.responseBody || "null"));
    } catch {
      return res.status(500).send({
        message: "资产提取状态记录已损坏，请联系管理员处理",
        code: "script_asset_recovery_invalid",
      });
    }
    const visitedCommandIds = new Set([String(commandRow.id)]);
    for (let depth = 0; ; depth += 1) {
      const recoveryTargetId = String(
        String(commandRow.status) === "checkpointed"
        && stored
        && typeof stored === "object"
        && !Array.isArray(stored)
          ? (stored as ExtractionCheckpoint).recoveryTargetId || ""
          : "",
      ).trim();
      if (!recoveryTargetId) break;
      if (depth >= 8) {
        return res.status(200).send(success({
          state: "manual_required",
          referenceId: String(commandRow.id),
          canStartNewAttempt: false,
          code: "script_asset_extraction_recovery_binding_too_deep",
          message: "资产提取恢复绑定层级异常，需人工核对后才能新建尝试",
        }));
      }
      if (visitedCommandIds.has(recoveryTargetId)) {
        return res.status(200).send(success({
          state: "manual_required",
          referenceId: recoveryTargetId,
          canStartNewAttempt: false,
          code: "script_asset_extraction_recovery_binding_invalid",
          message: "资产提取恢复绑定形成循环，需人工核对后才能新建尝试",
        }));
      }
      const targetRow = await db("o_agent_idempotency")
        .where({
          id: recoveryTargetId,
          workspaceId,
          resourceType: "project",
          resourceId: String(projectId),
          requestHash: String(requestedCommandRow.requestHash),
        })
        .whereIn("status", ["checkpointed", "completed"])
        .where("scopeKey", "like", `script:asset-extraction:proposal:${workspaceId}:%`)
        .first();
      if (!targetRow) {
        return res.status(200).send(success({
          state: "manual_required",
          referenceId: recoveryTargetId,
          canStartNewAttempt: false,
          code: "script_asset_extraction_recovery_target_missing",
          message: "绑定的资产提取恢复目标不存在或已失效，需人工核对后才能新建尝试",
        }));
      }
      visitedCommandIds.add(recoveryTargetId);
      commandRow = targetRow;
      try {
        stored = JSON.parse(String(commandRow.responseBody || "null"));
      } catch {
        return res.status(200).send(success({
          state: "manual_required",
          referenceId: recoveryTargetId,
          canStartNewAttempt: false,
          code: "script_asset_extraction_recovery_target_invalid",
          message: "绑定的资产提取恢复目标已损坏，需人工核对后才能新建尝试",
        }));
      }
    }
    if (checkpointCanNeedCausalRecoveryFence(commandRow.status, stored)) {
      const blockingTerminal = await findBlockingTerminalScriptAssetExtraction({
        workspaceId,
        projectId,
        requestHash: String(requestedCommandRow.requestHash),
        currentCommandId: String(commandRow.id),
      });
      if (blockingTerminal) {
        const targetId = String(blockingTerminal.row.id || "");
        if (!targetId || visitedCommandIds.has(targetId)) {
          return res.status(200).send(success({
            state: "manual_required",
            referenceId: targetId || String(commandRow.id),
            canStartNewAttempt: false,
            code: "script_asset_extraction_recovery_binding_invalid",
            message: "资产提取人工核对链路异常，需管理员处理",
          }));
        }
        visitedCommandIds.add(targetId);
        commandRow = blockingTerminal.row;
        stored = blockingTerminal.stored;
      }
    }
    for (let depth = 0; checkpointCanNeedCausalRecoveryFence(commandRow.status, stored); depth += 1) {
      if (depth >= 8) {
        return res.status(200).send(success({
          state: "manual_required",
          referenceId: String(commandRow.id),
          canStartNewAttempt: false,
          code: "script_asset_extraction_recovery_binding_too_deep",
          message: "资产提取历史恢复链路层级异常，需人工核对后才能新建尝试",
        }));
      }
      const causalTarget = await findCausalScriptAssetRecoveryTarget({
        workspaceId,
        projectId,
        requestHash: String(requestedCommandRow.requestHash),
        currentCommand: commandRow,
      });
      if (!causalTarget) break;
      const targetId = String(causalTarget.row.id || "");
      if (!targetId || visitedCommandIds.has(targetId)) {
        return res.status(200).send(success({
          state: "manual_required",
          referenceId: targetId || String(commandRow.id),
          canStartNewAttempt: false,
          code: "script_asset_extraction_recovery_binding_invalid",
          message: "资产提取历史恢复链路异常，需人工核对后才能新建尝试",
        }));
      }
      visitedCommandIds.add(targetId);
      commandRow = causalTarget.row;
      stored = causalTarget.stored;
    }
    const referenceId = String(commandRow.id);
    const isRecoveryFollower = String(requestedCommandRow.id) !== referenceId;
    if (String(commandRow.status) === "completed") {
      try {
        const proposal = parseStoredScriptAssetProposal(stored);
        return res.status(200).send(success({
          state: "proposal_ready",
          referenceId,
          canStartNewAttempt: false,
          proposal: publicScriptAssetProposal(proposal),
        }));
      } catch {
        const errorBody = stored && typeof stored === "object" && !Array.isArray(stored)
          ? stored as ExtractionErrorBody
          : null;
        const retryAllowed = [
          "script_asset_extraction_retry_allowed",
          "script_asset_model_output_invalid",
        ].includes(String(errorBody?.code || ""));
        return res.status(200).send(success({
          state: retryAllowed ? "retry_allowed" : "manual_required",
          referenceId,
          canStartNewAttempt: retryAllowed,
          retryMode: retryAllowed ? "new_attempt" : null,
          code: errorBody?.code || "script_asset_extraction_terminal",
          message: errorBody?.message || "该资产提取尝试已经结束",
        }));
      }
    }
    if (String(commandRow.status) !== "checkpointed" || !stored || typeof stored !== "object") {
      return res.status(200).send(success({
        state: "in_progress",
        referenceId,
        canStartNewAttempt: false,
        message: "资产提取请求正在建立恢复检查点",
      }));
    }
    const checkpoint = stored as ExtractionCheckpoint;
    if (checkpoint.projectId !== projectId) {
      return res.status(409).send({
        message: "资产提取请求与项目绑定不一致",
        code: "script_asset_proposal_conflict",
      });
    }
    if (checkpoint.phase === "provider_succeeded") {
      const proposal = parseStoredScriptAssetProposal(checkpoint.storedProposal);
      await completeDurableCommand(
        { kind: "resume", id: referenceId, checkpoint },
        proposal,
      );
      return res.status(200).send(success({
        state: "proposal_ready",
        referenceId,
        canStartNewAttempt: false,
        proposal: publicScriptAssetProposal(proposal),
      }));
    }
    if (checkpoint.phase === "queued") {
      return res.status(200).send(success({
        state: "retry_allowed",
        referenceId,
        canStartNewAttempt: isRecoveryFollower,
        retryMode: isRecoveryFollower ? "new_attempt" : "same_attempt",
        message: isRecoveryFollower
          ? "绑定的较早请求已确认未到达供应商，请显式发起新的提取尝试"
          : "上次调用未到达供应商，可使用原请求继续重试",
      }));
    }
    if (checkpoint.phase === "preparing") {
      const preparationActive = Date.now() - Number(commandRow.updatedAt || 0) <= 2 * 60 * 1_000;
      return res.status(200).send(success({
        state: preparationActive ? "in_progress" : "retry_allowed",
        referenceId,
        canStartNewAttempt: !preparationActive && isRecoveryFollower,
        retryMode: preparationActive ? null : (isRecoveryFollower ? "new_attempt" : "same_attempt"),
        message: preparationActive
          ? "资产提取正在准备，请稍后刷新"
          : isRecoveryFollower
            ? "绑定的较早请求准备租约已结束，请显式发起新的提取尝试"
            : "准备租约已结束，可使用原请求继续重试",
      }));
    }
    if (checkpoint.phase !== "dispatching") {
      return res.status(500).send({
        message: "资产提取状态无法识别，请联系管理员处理",
        code: "script_asset_recovery_invalid",
      });
    }
    const billing = await readScriptAssetExtractionBillingState({
      database: db,
      workspaceId,
      actorUserId: Number(commandRow.actorUserId),
      commandId: referenceId,
      attempt: Math.max(0, Number(checkpoint.attempt) || 0),
    });
    if (billing.state === "released") {
      const terminal: ExtractionErrorBody = {
        message: "该次调用已确认未扣费且不会再返回结果，可由你主动发起新的提取尝试",
        code: "script_asset_extraction_retry_allowed",
        data: { referenceId, canStartNewAttempt: true },
        claimEpoch: Math.max(0, Number(checkpoint.claimEpoch) || 0),
      };
      await completeDurableCommand(
        { kind: "resume", id: referenceId, checkpoint },
        terminal,
        409,
      );
      return res.status(200).send(success({
        state: "retry_allowed",
        referenceId,
        reconcileJobId: billing.reconcileJobId,
        canStartNewAttempt: true,
        retryMode: "new_attempt",
        message: terminal.message,
      }));
    }
    const noReservationStillFresh = billing.state === "no_reservation"
      && Date.now() - Number(commandRow.updatedAt || 0) <= 2 * 60 * 1_000;
    if (billing.state === "pending" || noReservationStillFresh) {
      return res.status(200).send(success({
        state: "pending_reconcile",
        referenceId,
        reconcileJobId: billing.reconcileJobId,
        canStartNewAttempt: false,
        message: "该次调用仍在等待模型结果与账务核对，系统不会自动重发",
      }));
    }
    const settledWithoutProposal = billing.state === "settled";
    return res.status(200).send(success({
      state: "manual_required",
      referenceId,
      reconcileJobId: billing.reconcileJobId,
      canStartNewAttempt: false,
      code: settledWithoutProposal
        ? "script_asset_extraction_settled_without_proposal"
        : "script_asset_extraction_manual_required",
      message: settledWithoutProposal
        ? "账务已结算但没有可交付的资产提案，需人工核对后才能新建尝试"
        : "模型调用未取得可用结果，预扣状态需要平台核对。为避免重复扣费，暂不能再次提取；请联系平台并提供请求编号",
    }));
  },
);

router.post(
  "/",
  requireProjectPermission("generation:create"),
  requireIdempotencyKey,
  (req, res, next) => {
    if (Array.isArray(req.body?.scriptIds) && req.body.scriptIds.length > 20) {
      return res.status(400).send({
        code: "script_asset_batch_too_large",
        message: `每批最多提取 20 条剧本，当前选择了 ${req.body.scriptIds.length} 条，请分批提取`,
        data: { maximumScripts: 20, selectedScripts: req.body.scriptIds.length },
      });
    }
    next();
  },
  validateFields({
    projectId: z.number().int().positive(),
    scriptIds: z.array(z.number().int().positive()).min(1).max(20)
      .refine((ids) => new Set(ids).size === ids.length, "剧本 ID 不能重复"),
    model: z.string().trim().min(1).max(200).optional(),
  }),
  async (req, res) => {
    const projectId = Number(req.body.projectId);
    const scriptIds = [...req.body.scriptIds].map(Number).sort((a, b) => a - b);
    const { workspaceId, actorUserId } = identity(req);
    let command: DurableCommandReservation<ExtractionStoredResponse> | undefined;
    let providerInvocationStarted = false;
    try {
      const rows = await db("o_script")
        .where({ projectId })
        .whereIn("id", scriptIds)
        .select("id", "name", "content");
      if (rows.length !== scriptIds.length) {
        throw new ScriptAssetExtractionError(404, "script_asset_source_not_found", "一个或多个剧本不存在或不属于当前项目");
      }
      const rowById = new Map(rows.map((row) => [Number(row.id), row]));
      const scripts: ScriptAssetSnapshot[] = scriptIds.map((id) => {
        const row = rowById.get(id)!;
        const content = String(row.content || "");
        return {
          id,
          name: String(row.name || `剧本 ${id}`),
          content,
          contentHash: scriptContentHash(content),
        };
      });
      const totalCharacters = scripts.reduce((sum, script) => sum + script.content.length, 0);
      if (totalCharacters > 120_000) {
        throw new ScriptAssetExtractionError(413, "script_asset_source_too_large", "每批剧本正文不能超过 12 万字，请减少选择或拆分较长的剧本后提取");
      }

      const requestedModel = String(req.body.model || "").trim();
      const requestIdentity = {
        projectId,
        scriptIds,
        model: requestedModel || null,
        scriptSnapshots: scripts.map(({ id, name, contentHash }) => ({ id, name, contentHash })),
      };
      const requestHash = hashIdempotencyRequest(requestIdentity);
      command = await beginDurableCommand<ExtractionStoredResponse>({
        workspaceId,
        actorUserId,
        scope: "script:asset-extraction:proposal",
        idempotencyKey: req.header("idempotency-key"),
        request: requestIdentity,
        resourceType: "project",
        resourceId: projectId,
        initialCheckpoint: {
          phase: "queued",
          attempt: 0,
          claimEpoch: 0,
          projectId,
          requestedModel: requestedModel || null,
          model: null,
          proposalId: null,
          scripts,
        } satisfies ExtractionCheckpoint,
      });
      if (command.kind === "replay") {
        if (command.responseStatus >= 400) {
          return res.status(command.responseStatus).send(
            publicExtractionError(command.responseBody as ExtractionErrorBody),
          );
        }
        return res.status(command.responseStatus).send(
          success(publicScriptAssetProposal(parseStoredScriptAssetProposal(command.responseBody))),
        );
      }
      if (command.kind !== "resume") {
        throw new ScriptAssetExtractionError(500, "script_asset_recovery_invalid", "资产提取命令未建立恢复检查点");
      }
      const recoverable = await findRecoverableScriptAssetProposal({
        database: db,
        workspaceId,
        projectId,
        requestedModel: requestedModel || null,
        scripts,
        requestHash,
      });
      if (recoverable?.state === "dispatching") {
        if (recoverable.reservationId !== command.id) {
          const bindingFailure = await bindExtractionRecoveryTargetFailClosed(
            command,
            recoverable.reservationId,
          );
          if (bindingFailure) {
            return res.status(409).send(publicExtractionError(bindingFailure));
          }
        }
        return res.status(409).send({
          message: "同一批剧本的资产提取可能已被模型受理，正在等待结果与账务核对",
          code: "script_asset_extraction_pending_reconcile",
          data: { referenceId: recoverable.reservationId, canStartNewAttempt: false },
        });
      }
      if (recoverable?.state === "preparing") {
        if (recoverable.reservationId !== command.id) {
          const bindingFailure = await bindExtractionRecoveryTargetFailClosed(
            command,
            recoverable.reservationId,
          );
          if (bindingFailure) {
            return res.status(409).send(publicExtractionError(bindingFailure));
          }
        }
        return res.status(409).send({
          message: "同一批剧本的资产提取正在处理，请稍后重试",
          code: "script_asset_extraction_in_progress",
          data: { referenceId: recoverable.reservationId, canStartNewAttempt: false },
        });
      }
      if (recoverable?.state === "provider_succeeded") {
        await completeDurableCommand(
          { kind: "resume", id: recoverable.reservationId, checkpoint: {} },
          recoverable.proposal,
        );
      }
      if (recoverable) {
        await completeDurableCommand(command, recoverable.proposal);
        return res.status(200).send(success(publicScriptAssetProposal(recoverable.proposal)));
      }
      let checkpoint = command.checkpoint as ExtractionCheckpoint;
      const recoveryTargetId = String(checkpoint.recoveryTargetId || "").trim();
      if (recoveryTargetId) {
        // A follower is recovery evidence for another durable command, never a
        // second provider attempt. Even after the target is released or
        // terminal, this key must keep following /status; only an explicit new
        // idempotency key may enter the claim/dispatch path.
        return res.status(409).send({
          message: "该请求已绑定到较早的资产提取任务，请刷新处理状态；如已确认释放，请显式发起新的提取尝试",
          code: "script_asset_extraction_pending_reconcile",
          data: { referenceId: recoveryTargetId, canStartNewAttempt: false },
        });
      }
      if (
        checkpoint.projectId !== projectId
        || checkpoint.requestedModel !== (requestedModel || null)
      ) {
        throw new ScriptAssetExtractionError(409, "script_asset_proposal_conflict", "资产提取请求与恢复检查点不一致");
      }
      if (checkpointCanNeedCausalRecoveryFence("checkpointed", checkpoint)) {
        const currentCommandRow = await db("o_agent_idempotency")
          .where({
            id: command.id,
            workspaceId,
            resourceType: "project",
            resourceId: String(projectId),
            requestHash,
          })
          .where("scopeKey", "like", `script:asset-extraction:proposal:${workspaceId}:%`)
          .first();
        if (!currentCommandRow) {
          throw new ScriptAssetExtractionError(500, "script_asset_recovery_invalid", "资产提取请求的恢复证据不存在");
        }
        const blockingTerminal = await findBlockingTerminalScriptAssetExtraction({
          workspaceId,
          projectId,
          requestHash,
          currentCommandId: command.id,
        });
        if (blockingTerminal) {
          const targetId = String(blockingTerminal.row.id);
          const bindingFailure = await bindExtractionRecoveryTargetFailClosed(command, targetId);
          if (bindingFailure) {
            return res.status(409).send(publicExtractionError(bindingFailure));
          }
          return res.status(409).send({
            message: "较早的资产提取已进入人工核对状态，未获得新的派发授权",
            code: "script_asset_extraction_manual_required",
            data: { referenceId: targetId, canStartNewAttempt: false },
          });
        }
        const causalTarget = await findCausalScriptAssetRecoveryTarget({
          workspaceId,
          projectId,
          requestHash,
          currentCommand: currentCommandRow,
        });
        if (causalTarget) {
          return res.status(409).send({
            message: "该请求创建时较早的资产提取尚未终结，请刷新处理状态；仅可在其终结后显式发起新请求",
            code: "script_asset_extraction_pending_reconcile",
            data: { referenceId: String(causalTarget.row.id), canStartNewAttempt: false },
          });
        }
      }
      if (checkpoint.phase === "dispatching") {
        return res.status(409).send({
          message: "资产提取请求可能已被模型受理，正在等待结果与账务核对，请勿更换请求重试",
          code: "script_asset_extraction_pending_reconcile",
          data: { referenceId: command.id, canStartNewAttempt: false },
        });
      }
      if (checkpoint.phase === "provider_succeeded") {
        const stored = parseStoredScriptAssetProposal(checkpoint.storedProposal);
        await completeDurableCommand(command, stored);
        return res.status(200).send(success(publicScriptAssetProposal(stored)));
      }
      if (!sameScriptSnapshots(checkpoint.scripts, scripts)) {
        throw new ScriptAssetExtractionError(
          409,
          "script_asset_proposal_stale",
          "剧本内容已变化，请使用新请求重新提取资产",
        );
      }

      const preparation = await claimExtractionPreparation({
        reservation: command,
        workspaceId,
        projectId,
        requestedModel: requestedModel || null,
        scripts,
        requestHash,
      });
      if (preparation.kind === "replay") {
        if (preparation.responseStatus >= 400) {
          return res.status(preparation.responseStatus).send(
            publicExtractionError(preparation.responseBody as ExtractionErrorBody),
          );
        }
        return res.status(preparation.responseStatus).send(
          success(publicScriptAssetProposal(parseStoredScriptAssetProposal(preparation.responseBody))),
        );
      }
      command = preparation;
      checkpoint = preparation.checkpoint;
      if (checkpoint.phase === "provider_succeeded") {
        const stored = parseStoredScriptAssetProposal(checkpoint.storedProposal);
        await completeDurableCommand(preparation, stored);
        return res.status(200).send(success(publicScriptAssetProposal(stored)));
      }

      const availableModels = await listWorkbenchTextModels(workspaceId);
      const model = checkpoint.requestedModel
        ? availableModels.find((item) => item.id === checkpoint.requestedModel)?.id
        : availableModels[0]?.id;
      if (!model) {
        await resetDispatchToQueued(command);
        throw new ScriptAssetExtractionError(503, "script_asset_model_unavailable", "当前工作区没有可执行的文本模型");
      }

      const dispatched = await promoteExtractionToDispatching({
        reservation: command,
        workspaceId,
        projectId,
        requestedModel: requestedModel || null,
        scripts,
        model,
        requestHash,
      });
      if (dispatched.kind === "replay") {
        if (dispatched.responseStatus >= 400) {
          return res.status(dispatched.responseStatus).send(
            publicExtractionError(dispatched.responseBody as ExtractionErrorBody),
          );
        }
        return res.status(dispatched.responseStatus).send(
          success(publicScriptAssetProposal(parseStoredScriptAssetProposal(dispatched.responseBody))),
        );
      }
      if (dispatched.kind !== "resume") {
        throw new ScriptAssetExtractionError(409, "script_asset_proposal_conflict", "资产提取请求状态已变化");
      }
      command = dispatched;
      checkpoint = dispatched.checkpoint;
      providerInvocationStarted = true;
      const completion = await executeRelayChat({
        model,
        messages: [{ role: "user", content: buildScriptAssetExtractionPrompt(checkpoint.scripts) }],
        temperature: 0.15,
        max_tokens: 8_192,
        // Consume the relay stream on the server: long reasoning/output must
        // not wait for one buffered upstream response behind an idle timeout.
        stream: true,
        user: `script-assets:${resolveRelayPrincipalId(req) || "workspace"}`,
      }, {
        workspaceId,
        apiKeyId: null,
        principalId: resolveRelayPrincipalId(req),
        requestId: String((req as any).requestId || req.header("x-request-id") || "").trim() || null,
        idempotencyKey: `${dispatched.id}:extract:v1:attempt:${Math.max(0, Number(checkpoint.attempt) || 0)}`,
        purpose: "script_asset_extraction",
      });
      const content = assistantText(completion.stream
        ? { response: await consumeRelayChatCompletionStream(completion.stream) }
        : completion);
      if (!content) {
        throw new ScriptAssetExtractionError(422, "script_asset_model_output_invalid", "文本模型没有返回可解析的资产提案");
      }
      let rawOutput: unknown;
      try {
        rawOutput = extractJsonObject(content);
      } catch {
        throw new ScriptAssetExtractionError(422, "script_asset_model_output_invalid", "文本模型返回的资产提案不是有效 JSON");
      }
      const assets = normalizeScriptAssetModelOutput(rawOutput, checkpoint.scripts);
      const stored = buildStoredScriptAssetProposal({
        proposalId: dispatched.id,
        projectId,
        model,
        claimEpoch: Math.max(0, Number(checkpoint.claimEpoch) || 0),
        scripts: checkpoint.scripts,
        assets,
      });
      const persisted = await mutateDurableCommandCheckpoint<ExtractionStoredResponse, ExtractionCheckpoint>(
        dispatched,
        (current) => ({ ...current, phase: "provider_succeeded", storedProposal: stored }),
      );
      if (persisted.kind === "replay") {
        if (persisted.responseStatus >= 400) {
          return res.status(persisted.responseStatus).send(
            publicExtractionError(persisted.responseBody as ExtractionErrorBody),
          );
        }
        return res.status(persisted.responseStatus).send(
          success(publicScriptAssetProposal(parseStoredScriptAssetProposal(persisted.responseBody))),
        );
      }
      if (persisted.kind !== "resume") {
        throw new ScriptAssetExtractionError(409, "script_asset_proposal_conflict", "资产提取提案保存状态已变化");
      }
      command = persisted;
      await completeDurableCommand(persisted, stored);
      return res.status(200).send(success(publicScriptAssetProposal(stored)));
    } catch (error) {
      if (error instanceof ScriptAssetExtractionError) {
        const recoveryTargetId = error.data && typeof error.data === "object"
          ? String((error.data as { referenceId?: unknown }).referenceId || "").trim()
          : "";
        if (recoveryTargetId) {
          const bindingFailure = await bindExtractionRecoveryTargetFailClosed(command, recoveryTargetId);
          if (bindingFailure) {
            return res.status(409).send(publicExtractionError(bindingFailure));
          }
        }
      }
      if (
        error instanceof ScriptAssetExtractionError
        && error.code === "script_asset_model_output_invalid"
        && command
      ) {
        const body = {
          message: error.message,
          code: error.code,
          claimEpoch: command.kind === "resume"
            ? Math.max(0, Number((command.checkpoint as ExtractionCheckpoint).claimEpoch) || 0)
            : 0,
        };
        await completeDurableCommand(command, body, error.status).catch(() => undefined);
      }
      const handled = sendDurableError(res, error);
      if (handled) return handled;
      if (error instanceof BillingError && error.status === 402) {
        await resetDispatchToQueued(command, { incrementAttempt: true }).catch(() => undefined);
        return res.status(402).send({
          message: error.message,
          code: "script_asset_insufficient_balance",
          ...(publicBillingErrorDetails(error) ? { data: publicBillingErrorDetails(error) } : {}),
        });
      }
      if (error instanceof RelayChatError && (error.statusCode === 402 || !error.upstreamMayHaveAccepted)) {
        await resetDispatchToQueued(command, { incrementAttempt: true }).catch(() => undefined);
        return res.status(error.statusCode === 402 ? 402 : 503).send({
          message: error.statusCode === 402 ? "工作区余额不足，请充值后重试" : "资产提取模型暂不可用，请稍后重试",
          code: error.statusCode === 402 ? "script_asset_insufficient_balance" : "script_asset_model_unavailable",
        });
      }
      if (providerInvocationStarted) {
        return res.status(409).send({
          message: "模型连接中断或响应超时，正在核对本次结果与预扣，请勿重复提取",
          code: "script_asset_extraction_pending_reconcile",
          data: {
            referenceId: command?.kind === "resume" ? command.id : null,
            canStartNewAttempt: false,
          },
        });
      }
      await resetDispatchToQueued(command).catch(() => undefined);
      return res.status(503).send({
        message: "资产提取服务暂不可用，请检查文本模型配置或稍后重试",
        code: "script_asset_model_unavailable",
      });
    }
  },
);

router.post(
  "/merge",
  requireProjectPermission("generation:create"),
  requireIdempotencyKey,
  validateFields({
    projectId: z.number().int().positive(),
    proposalIds: z.array(z.string().uuid()).min(1).max(MAX_EXTRACTION_BATCHES).refine((ids) => new Set(ids).size === ids.length, "批次提案不能重复"),
  }),
  async (req, res) => {
    const projectId = Number(req.body.projectId);
    const { workspaceId, actorUserId } = identity(req);
    const proposalIds = req.body.proposalIds as string[];
    let reservation: DurableCommandReservation<StoredScriptAssetProposal> | undefined;
    try {
      reservation = await beginDurableCommand<StoredScriptAssetProposal>({
        workspaceId, actorUserId, scope: "script:asset-extraction:batch-proposal",
        idempotencyKey: req.header("idempotency-key"), request: { projectId, mergedProposalIds: proposalIds },
        resourceType: "project", resourceId: projectId, reservationStaleAfterMs: 30_000,
      });
      if (reservation.kind === "replay") return res.status(200).send(success(publicScriptAssetProposal(reservation.responseBody)));
      if (reservation.kind !== "reserved") throw new ScriptAssetExtractionError(409, "script_asset_proposal_conflict", "汇总请求状态已变化，请使用原请求重试");
      const command = reservation;
      const merged = await db.transaction(async (transaction) => {
        const proposals = await loadScriptAssetBatchProposals(transaction, workspaceId, projectId, proposalIds);
        const proposal = mergeScriptAssetProposals(command.id, projectId, proposals);
        await completeDurableCommand(command, proposal, 200, { database: transaction as any });
        return proposal;
      });
      return res.status(200).send(success(publicScriptAssetProposal(merged)));
    } catch (error) {
      if (reservation?.kind === "reserved") await abandonDurableCommand(reservation).catch(() => undefined);
      const handled = sendDurableError(res, error);
      if (handled) return handled;
      throw error;
    }
  },
);

router.post(
  "/confirm",
  requireProjectPermission("project:write"),
  requireIdempotencyKey,
  validateFields({
    projectId: z.number().int().positive(),
    proposalId: z.string().uuid(),
    assets: z.array(confirmationAssetSchema).min(1).max(MAX_MERGED_SCRIPT_ASSETS),
  }),
  async (req, res) => {
    const projectId = Number(req.body.projectId);
    const proposalId = String(req.body.proposalId);
    const assets = req.body.assets as ScriptAssetConfirmationInput[];
    try {
      const result = await executeDurableProjectMutation({
        req,
        scope: "script:asset-extraction:confirm",
        request: { projectId, proposalId, assets },
        mutate: async (transaction) => confirmScriptAssetProposal({
          transaction,
          workspaceId: identity(req).workspaceId,
          projectId,
          proposalId,
          assets,
        }),
      });
      return res.status(result.responseStatus).send(success(result.data));
    } catch (error) {
      const handled = sendDurableError(res, error);
      if (handled) return handled;
      throw error;
    }
  },
);

export default router;
