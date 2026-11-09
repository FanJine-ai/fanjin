import crypto from "node:crypto";
import { hasUpstreamRealPersonRejection } from "@/lib/portraitUpstreamRejection";
import { isPortraitProviderRefusal, PORTRAIT_PROVIDER_REFUSAL_MESSAGE } from "@/lib/portraitSubmissionPolicy";
import type { Knex } from "knex";
import { PORTRAIT_ADMISSION_TABLE } from "@/lib/migrations/portraitAssetAdmission";
import { type PortraitAdmissionDto, readPortraitAdmission } from "@/lib/portraitAdmissionStore";
import { PortraitAdmissionWorkflowError } from "@/lib/portraitAdmissionError";
import { canRecoverPortraitFace, portraitRecoveryHistory, readPortraitEvidence } from "@/lib/portraitFailure";

function fail(status: number, code: string, message: string): never {
  throw new PortraitAdmissionWorkflowError(status, code, message);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(row[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function sha256(value: unknown): string {
  return crypto.createHash("sha256").update(
    typeof value === "string" ? value : stableJson(value),
  ).digest("hex");
}

function positiveInteger(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    fail(400, "portrait_request_invalid", `${name} 无效`);
  }
  return parsed;
}

async function lockedAdmission(input: {
  database: Knex | Knex.Transaction;
  workspaceId: string;
  projectId: number;
  assetVersionId: number;
}): Promise<Record<string, any>> {
  const row = await input.database(PORTRAIT_ADMISSION_TABLE)
    .where({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      assetVersionId: input.assetVersionId,
    })
    .forUpdate()
    .first();
  if (!row) fail(404, "portrait_admission_not_found", "素材人像准入记录不存在");
  return row;
}

export async function retryPortraitAdmissionChecks(input: {
  database: Knex;
  workspaceId: string;
  projectId: number;
  assetVersionId: number;
  expectedRevision?: number | null;
  now?: number;
}): Promise<PortraitAdmissionDto> {
  const projectId = positiveInteger(input.projectId, "projectId");
  const assetVersionId = positiveInteger(input.assetVersionId, "assetVersionId");
  const now = input.now ?? Date.now();
  await input.database.transaction(async (trx) => {
    const row = await lockedAdmission({
      database: trx,
      workspaceId: input.workspaceId,
      projectId,
      assetVersionId,
    });
    if (input.expectedRevision != null && Number(row.revision) !== Number(input.expectedRevision)) {
      fail(409, "portrait_revision_conflict", "素材状态已更新，请刷新后重试");
    }
    if (hasUpstreamRealPersonRejection(row)) {
      fail(409, "portrait_upstream_review_required", "火山已拒绝该人物参考，请确认真实来源并登记，或联系管理员复核");
    }
    if (isPortraitProviderRefusal(row.safeErrorCode)) {
      fail(409, "portrait_provider_review_required", PORTRAIT_PROVIDER_REFUSAL_MESSAGE);
    }
    // A timed-out provider mutation may already have succeeded upstream. It
    // must be reconciled by an operator instead of being turned back into a
    // user-retryable POST that could create a duplicate group or asset.
    if (String(row.safeErrorCode) === "VOLC_PORTRAIT_OUTCOME_UNKNOWN") {
      fail(
        409,
        "portrait_provider_outcome_unknown",
        "上游创建结果待管理员核对，不能自动重试",
      );
    }
    if (["queued", "scanning"].includes(String(row.faceScanState))) {
      fail(
        409,
        "portrait_scan_pending",
        "人像预检尚未完成，不能重置正在执行的检测",
      );
    }
    if (["pending", "in_review"].includes(String(row.manualReviewState || ""))) {
      fail(
        409,
        "portrait_manual_review_pending",
        "视频全片人工复核已创建，普通用户不能重置或绕过复核",
      );
    }
    if (
      String(row.manualReviewState) === "completed"
      && String(row.manualReviewDecision) === "uncertain"
    ) {
      fail(
        409,
        "portrait_manual_review_final",
        "平台人工复核仍无法确认，请更换素材或由管理员创建新的复核代次",
      );
    }
    const changes: Record<string, unknown> = {};
    if (canRecoverPortraitFace(row)) {
      const recoveryEvidence = {
        version: "portrait-detector-recovery-request/v1",
        sourceSha256: row.sourceSha256,
        recoveryHistory: [...portraitRecoveryHistory(row), {
          requestedAt: now,
          revision: Number(row.revision),
          previousEvidenceHash: row.detectorEvidenceHash,
          diagnostic: readPortraitEvidence(row)?.diagnostic,
        }],
      };
      Object.assign(changes, {
        faceScanState: "queued", faceScanCoverage: "none", faceCount: null,
        detectorName: null, detectorVersion: null, detectorConfidence: null,
        detectorEvidenceHash: sha256(recoveryEvidence), detectorEvidenceJson: stableJson(recoveryEvidence),
        subjectKind: "pending", declarationState: "pending", complianceState: "pending", providerSyncState: "not_needed",
      });
    }
    if (["failed", "stale"].includes(String(row.providerSyncState))) {
      Object.assign(changes, { providerSyncState: "queued" });
    }
    // Explicit recorded auth rejection is the sole detector recovery path.
    // Legacy failures, timeouts and possibly-dispatched results stay fenced.
    if (Object.keys(changes).length > 0) {
      Object.assign(changes, {
        safeErrorCode: null,
        safeErrorMessage: null,
        revision: Number(row.revision) + 1,
        updatedAt: now,
      });
      await trx(PORTRAIT_ADMISSION_TABLE).where({ id: row.id }).update(changes);
    }
  });
  const result = await readPortraitAdmission({
    database: input.database,
    workspaceId: input.workspaceId,
    projectId,
    assetVersionId,
  });
  if (!result) fail(500, "portrait_admission_missing_after_write", "素材准入记录写入失败");
  return result;
}
