import crypto from "node:crypto";
import type { Knex } from "knex";
import { parseAuditMetadata, writeAuditLog } from "@/lib/audit";
import { MODEL_ROUTE_CERTIFICATION_BATCH_TABLE } from "@/lib/migrations/modelRouteCertification";
import {
  certifyModelRoute,
  formatModelRouteCertificationRecord,
  ModelRouteCertificationError,
  type CertifyModelRouteInput,
  type ModelRouteCertificationDatabase,
  type ModelRouteCertificationReadiness,
  type ModelRouteCertificationRecord,
} from "@/lib/modelRouteCertification";
import { platformRoles, type PlatformRole } from "@/lib/sharedTypes";
import { acquireModelRouteCertificationAdvisoryFence } from "@/lib/modelRouteCertificationMutationFence";

export const MODEL_ROUTE_CERTIFICATION_BATCH_FORMAT =
  "fanjin-model-route-certification-batch/v1" as const;

export type ModelRouteCertificationBatchEntry = Omit<
  CertifyModelRouteInput,
  "batchId" | "releaseId" | "sourceCommit" | "certifiedByUserId" | "now"
>;

export interface ModelRouteCertificationBatch {
  format: typeof MODEL_ROUTE_CERTIFICATION_BATCH_FORMAT;
  batchId: string;
  releaseId: string;
  sourceCommit: string;
  actorUserId: number;
  entries: ModelRouteCertificationBatchEntry[];
}

export interface ModelRouteCertificationBatchReceipt {
  format: typeof MODEL_ROUTE_CERTIFICATION_BATCH_FORMAT;
  mode: "validate" | "apply";
  batchId: string;
  releaseId: string;
  sourceCommit: string;
  batchDigest: string;
  actorUserId: number;
  entryCount: number;
  certifications: Array<{
    certificationId: string;
    routeId: string;
    operationKey: string;
    pricingRuleId: string;
  }>;
  completedAt: number;
}

export interface ModelRouteCertificationReleaseBatchProof {
  format: "model-route-certification-release-batch-proof/v1";
  registryIdentity: typeof MODEL_ROUTE_CERTIFICATION_BATCH_TABLE;
  requiredAuditAction: "admin.model_route.certification_batch_apply";
  valid: boolean;
  reason: string | null;
  batchId: string | null;
  batchDigest: string | null;
  releaseId: string | null;
  sourceCommit: string | null;
  actorUserId: number | null;
  entryCount: number | null;
  appliedAt: number | null;
  requiredCertifications: Array<{
    operationKey: string;
    certificationId: string;
  }>;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function codeUnitCompare(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ModelRouteCertificationError("认证批次必须是 JSON 对象");
  }
  return value as Record<string, unknown>;
}

const TOP_LEVEL_KEYS = new Set([
  "format",
  "batchId",
  "releaseId",
  "sourceCommit",
  "actorUserId",
  "entries",
]);

const ENTRY_KEYS = new Set([
  "routeId",
  "pricingRuleId",
  "operationKey",
  "priceSourceUrl",
  "priceSourceDigest",
  "priceCheckedAt",
  "upstreamCurrency",
  "upstreamUnitPriceMicros",
  "billingCurrency",
  "billingDimension",
  "taskEvidenceId",
  "usageEvidenceId",
  "validUntil",
]);

function assertNoUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort();
  if (unknown.length > 0) {
    throw new ModelRouteCertificationError(
      `${label} 包含未知字段: ${unknown.join(", ")}`,
    );
  }
}

function safeInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new ModelRouteCertificationError(`${label} 必须是安全整数`);
  }
  return parsed;
}

function normalizeEntry(value: unknown): ModelRouteCertificationBatchEntry {
  const entry = object(value);
  assertNoUnknownKeys(entry, ENTRY_KEYS, "认证批次 entry");
  return {
    routeId: text(entry.routeId),
    pricingRuleId: text(entry.pricingRuleId),
    operationKey: text(entry.operationKey),
    priceSourceUrl: text(entry.priceSourceUrl),
    priceSourceDigest: text(entry.priceSourceDigest).toLowerCase(),
    priceCheckedAt: safeInteger(entry.priceCheckedAt, "priceCheckedAt"),
    upstreamCurrency: text(entry.upstreamCurrency).toUpperCase(),
    upstreamUnitPriceMicros: safeInteger(
      entry.upstreamUnitPriceMicros,
      "upstreamUnitPriceMicros",
    ),
    billingCurrency: text(entry.billingCurrency).toUpperCase(),
    billingDimension: text(entry.billingDimension),
    taskEvidenceId: text(entry.taskEvidenceId),
    usageEvidenceId: text(entry.usageEvidenceId),
    validUntil: safeInteger(entry.validUntil, "validUntil"),
  };
}

export function parseModelRouteCertificationBatch(
  value: unknown,
): ModelRouteCertificationBatch {
  const batch = object(value);
  assertNoUnknownKeys(batch, TOP_LEVEL_KEYS, "认证批次");
  const format = text(batch.format);
  const batchId = text(batch.batchId);
  const releaseId = text(batch.releaseId);
  const sourceCommit = text(batch.sourceCommit).toLowerCase();
  const actorUserId = safeInteger(batch.actorUserId, "actorUserId");
  if (format !== MODEL_ROUTE_CERTIFICATION_BATCH_FORMAT) {
    throw new ModelRouteCertificationError("不支持的模型路由认证批次格式");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(batchId)) {
    throw new ModelRouteCertificationError("batchId 格式无效");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(releaseId)) {
    throw new ModelRouteCertificationError("releaseId 格式无效");
  }
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(sourceCommit)) {
    throw new ModelRouteCertificationError("sourceCommit 必须是 40 或 64 位小写十六进制摘要");
  }
  if (actorUserId <= 0) {
    throw new ModelRouteCertificationError("认证人身份无效", 403);
  }
  if (!Array.isArray(batch.entries) || batch.entries.length === 0) {
    throw new ModelRouteCertificationError("认证批次 entries 不能为空");
  }
  if (batch.entries.length > 10_000) {
    throw new ModelRouteCertificationError("认证批次不能超过 10000 条");
  }
  const entries = batch.entries.map(normalizeEntry);
  const identities = new Set<string>();
  for (const entry of entries) {
    const identity = `${entry.routeId}\u0000${entry.operationKey}`;
    if (identities.has(identity)) {
      throw new ModelRouteCertificationError(
        `批次内存在重复 route/operation: ${entry.routeId}/${entry.operationKey}`,
      );
    }
    identities.add(identity);
  }
  entries.sort((left, right) => (
    codeUnitCompare(left.routeId, right.routeId)
    || codeUnitCompare(left.operationKey, right.operationKey)
  ));
  return {
    format: MODEL_ROUTE_CERTIFICATION_BATCH_FORMAT,
    batchId,
    releaseId,
    sourceCommit,
    actorUserId,
    entries,
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => codeUnitCompare(left, right))
      .map(([key, child]) => [key, stableValue(child)]),
  );
}

export function modelRouteCertificationBatchDigest(
  batch: ModelRouteCertificationBatch,
): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(stableValue(batch)), "utf8")
    .digest("hex");
}

function invalidReleaseProof(input: {
  reason: string;
  batchId?: string | null;
  batchDigest?: string | null;
  releaseId?: string | null;
  sourceCommit?: string | null;
  actorUserId?: number | null;
  entryCount?: number | null;
  appliedAt?: number | null;
  requiredCertifications?: ModelRouteCertificationReleaseBatchProof["requiredCertifications"];
}): ModelRouteCertificationReleaseBatchProof {
  return {
    format: "model-route-certification-release-batch-proof/v1",
    registryIdentity: MODEL_ROUTE_CERTIFICATION_BATCH_TABLE,
    requiredAuditAction: "admin.model_route.certification_batch_apply",
    valid: false,
    reason: input.reason,
    batchId: input.batchId ?? null,
    batchDigest: input.batchDigest ?? null,
    releaseId: input.releaseId ?? null,
    sourceCommit: input.sourceCommit ?? null,
    actorUserId: input.actorUserId ?? null,
    entryCount: input.entryCount ?? null,
    appliedAt: input.appliedAt ?? null,
    requiredCertifications: input.requiredCertifications || [],
  };
}

/**
 * Formal release proof. Runtime/Admin readiness alone is intentionally not a
 * release authority: every required operation must come from one atomically
 * applied immutable batch whose canonical digest and required audit record
 * match the exact target release and source commit.
 */
export async function evaluateModelRouteCertificationReleaseBatchProof(input: {
  database: ModelRouteCertificationDatabase;
  readiness: ModelRouteCertificationReadiness;
  expectedReleaseId: string;
  expectedSourceCommit: string;
}): Promise<ModelRouteCertificationReleaseBatchProof> {
  const expectedReleaseId = text(input.expectedReleaseId);
  const expectedSourceCommit = text(input.expectedSourceCommit).toLowerCase();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(expectedReleaseId)) {
    return invalidReleaseProof({ reason: "目标 releaseId 格式无效" });
  }
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(expectedSourceCommit)) {
    return invalidReleaseProof({ reason: "目标 sourceCommit 格式无效" });
  }
  if (!input.readiness.tableReady) {
    return invalidReleaseProof({ reason: "模型路由认证表未就绪" });
  }
  const requiredCertifications: ModelRouteCertificationReleaseBatchProof["requiredCertifications"] = [];
  const certificationRecords: ModelRouteCertificationRecord[] = [];
  for (const operationKey of input.readiness.requiredOperations) {
    const operation = input.readiness.operations.find(
      (candidate) => candidate.operationKey === operationKey,
    );
    if (!operation?.valid || !operation.certification) {
      return invalidReleaseProof({
        reason: operation?.reason || `${operationKey} 缺少有效认证`,
        requiredCertifications,
      });
    }
    certificationRecords.push(operation.certification);
    requiredCertifications.push({
      operationKey,
      certificationId: operation.certification.id,
    });
  }
  requiredCertifications.sort((left, right) => (
    codeUnitCompare(left.operationKey, right.operationKey)
  ));
  const batchIds = new Set(certificationRecords.map((record) => record.batchId));
  if (batchIds.size !== 1 || !certificationRecords[0]?.batchId) {
    return invalidReleaseProof({
      reason: "全部 required operations 必须来自同一认证批次",
      requiredCertifications,
    });
  }
  const batchId = certificationRecords[0].batchId;
  if (
    certificationRecords.some((record) => (
      record.releaseId !== expectedReleaseId
      || record.sourceCommit !== expectedSourceCommit
    ))
  ) {
    return invalidReleaseProof({
      reason: "认证批次的 releaseId/sourceCommit 与目标发布不一致",
      batchId,
      releaseId: certificationRecords[0].releaseId,
      sourceCommit: certificationRecords[0].sourceCommit,
      requiredCertifications,
    });
  }

  try {
    const registry = await input.database(MODEL_ROUTE_CERTIFICATION_BATCH_TABLE)
      .where({ batchId })
      .first();
    if (!registry) {
      return invalidReleaseProof({
        reason: "正式发布不接受未绑定 immutable batch registry 的手工认证",
        batchId,
        requiredCertifications,
      });
    }
    const registryDigest = text(registry.batchDigest).toLowerCase();
    const registryReleaseId = text(registry.releaseId);
    const registrySourceCommit = text(registry.sourceCommit).toLowerCase();
    const actorUserId = Number(registry.actorUserId);
    const entryCount = Number(registry.entryCount);
    const appliedAt = Number(registry.appliedAt);
    const proofIdentity = {
      batchId,
      batchDigest: registryDigest,
      releaseId: registryReleaseId,
      sourceCommit: registrySourceCommit,
      actorUserId,
      entryCount,
      appliedAt,
      requiredCertifications,
    };
    if (
      registryReleaseId !== expectedReleaseId
      || registrySourceCommit !== expectedSourceCommit
      || !/^[a-f0-9]{64}$/.test(registryDigest)
      || !Number.isSafeInteger(actorUserId)
      || actorUserId <= 0
      || !Number.isSafeInteger(entryCount)
      || entryCount <= 0
      || entryCount > 10_000
      || !Number.isSafeInteger(appliedAt)
      || appliedAt <= 0
    ) {
      return invalidReleaseProof({
        reason: "immutable batch registry 与目标发布或批次身份不一致",
        ...proofIdentity,
      });
    }
    const persistedRows = await input.database("o_model_route_certification")
      .where({ batchId });
    const persistedRecords = persistedRows.map(formatModelRouteCertificationRecord);
    const requiredIds = new Set(certificationRecords.map((record) => record.id));
    if (
      persistedRecords.length !== entryCount
      || certificationRecords.some((record) => !persistedRecords.some((item) => item.id === record.id))
      || persistedRecords.some((record) => (
        record.batchId !== batchId
        || record.releaseId !== registryReleaseId
        || record.sourceCommit !== registrySourceCommit
        || record.certifiedByUserId !== actorUserId
      ))
      || requiredIds.size !== certificationRecords.length
    ) {
      return invalidReleaseProof({
        reason: "批次 registry 与持久化认证行不完整或不一致",
        ...proofIdentity,
      });
    }
    const reconstructed = parseModelRouteCertificationBatch({
      format: MODEL_ROUTE_CERTIFICATION_BATCH_FORMAT,
      batchId,
      releaseId: registryReleaseId,
      sourceCommit: registrySourceCommit,
      actorUserId,
      entries: persistedRecords.map((record) => ({
        routeId: record.routeId,
        pricingRuleId: record.pricingRuleId,
        operationKey: record.operationKey,
        priceSourceUrl: record.priceSourceUrl,
        priceSourceDigest: record.priceSourceDigest,
        priceCheckedAt: record.priceCheckedAt,
        upstreamCurrency: record.upstreamCurrency,
        upstreamUnitPriceMicros: record.upstreamUnitPriceMicros,
        billingCurrency: record.billingCurrency,
        billingDimension: record.billingDimension,
        taskEvidenceId: record.taskEvidenceId,
        usageEvidenceId: record.usageEvidenceId,
        validUntil: record.validUntil,
      })),
    });
    if (modelRouteCertificationBatchDigest(reconstructed) !== registryDigest) {
      return invalidReleaseProof({
        reason: "持久化认证行的 canonical batch digest 与 registry 不一致",
        ...proofIdentity,
      });
    }
    const audit = await input.database("o_audit_log")
      .where({
        action: "admin.model_route.certification_batch_apply",
        resourceType: "model_route_certification_batch",
        resourceId: batchId,
      })
      .orderBy("createdAt", "asc")
      .first();
    const metadata = parseAuditMetadata(audit?.metadata);
    if (
      !audit
      || Number(audit.actorUserId) !== actorUserId
      || text(metadata.batchDigest).toLowerCase() !== registryDigest
      || Number(metadata.entryCount) !== entryCount
      || text(metadata.releaseId) !== registryReleaseId
      || text(metadata.sourceCommit).toLowerCase() !== registrySourceCommit
    ) {
      return invalidReleaseProof({
        reason: "批次 required audit 缺失或与 registry digest 不一致",
        ...proofIdentity,
      });
    }
    return {
      format: "model-route-certification-release-batch-proof/v1",
      registryIdentity: MODEL_ROUTE_CERTIFICATION_BATCH_TABLE,
      requiredAuditAction: "admin.model_route.certification_batch_apply",
      valid: true,
      reason: null,
      ...proofIdentity,
    };
  } catch {
    return invalidReleaseProof({
      reason: "无法校验认证批次 registry/audit，已 fail-closed",
      batchId,
      requiredCertifications,
    });
  }
}

class ValidationRollback extends Error {
  constructor(readonly receipt: ModelRouteCertificationBatchReceipt) {
    super("MODEL_ROUTE_CERTIFICATION_VALIDATION_ROLLBACK");
  }
}

function receiptFor(input: {
  batch: ModelRouteCertificationBatch;
  mode: "validate" | "apply";
  records: ModelRouteCertificationRecord[];
  completedAt: number;
}): ModelRouteCertificationBatchReceipt {
  return {
    format: MODEL_ROUTE_CERTIFICATION_BATCH_FORMAT,
    mode: input.mode,
    batchId: input.batch.batchId,
    releaseId: input.batch.releaseId,
    sourceCommit: input.batch.sourceCommit,
    batchDigest: modelRouteCertificationBatchDigest(input.batch),
    actorUserId: input.batch.actorUserId,
    entryCount: input.records.length,
    certifications: input.records.map((record) => ({
      certificationId: record.id,
      routeId: record.routeId,
      operationKey: record.operationKey,
      pricingRuleId: record.pricingRuleId,
    })),
    completedAt: input.completedAt,
  };
}

/**
 * Validates or atomically applies a complete certification bootstrap batch.
 * Validate mode executes the same database checks and intentionally rolls the
 * transaction back. Apply mode commits evidence and its required audit row
 * together, so an empty schema-43 table can be bootstrapped without bypasses.
 */
export async function executeModelRouteCertificationBatch(input: {
  database: Knex;
  batch: ModelRouteCertificationBatch | unknown;
  mode?: "validate" | "apply";
  now?: number;
}): Promise<ModelRouteCertificationBatchReceipt> {
  const batch = parseModelRouteCertificationBatch(input.batch);
  const mode = input.mode || "validate";
  if (mode !== "validate" && mode !== "apply") {
    throw new ModelRouteCertificationError("认证批次 mode 无效");
  }
  const now = input.now ?? Date.now();
  const batchDigest = modelRouteCertificationBatchDigest(batch);
  try {
    return await input.database.transaction(async (transaction) => {
      await acquireModelRouteCertificationAdvisoryFence(transaction);
      const actor = await transaction("o_user").where({ id: batch.actorUserId }).first();
      const actorRole = text(actor?.role) as PlatformRole;
      if (
        !actor
        || text(actor.status).toLowerCase() !== "active"
        || !platformRoles.includes(actorRole)
      ) {
        throw new ModelRouteCertificationError(
          "离线认证批次只允许活跃平台 root/admin/super_admin 执行",
          403,
        );
      }

      const claimedRows = await transaction(MODEL_ROUTE_CERTIFICATION_BATCH_TABLE)
        .insert({
          batchId: batch.batchId,
          batchDigest,
          releaseId: batch.releaseId,
          sourceCommit: batch.sourceCommit,
          actorUserId: batch.actorUserId,
          entryCount: batch.entries.length,
          appliedAt: now,
          createdAt: now,
        })
        .onConflict("batchId")
        .ignore()
        .returning(["batchId"]);
      const claimed = Array.isArray(claimedRows) && claimedRows.length > 0;
      const existingBatch = await transaction(MODEL_ROUTE_CERTIFICATION_BATCH_TABLE)
        .where({ batchId: batch.batchId })
        .first();
      if (!existingBatch) {
        throw new ModelRouteCertificationError(
          "认证批次注册表未能原子声明 batchId",
          409,
          "model_route_certification_batch_claim_failed",
        );
      }
      if (!claimed) {
        if (
          text(existingBatch.batchDigest).toLowerCase() !== batchDigest
          || text(existingBatch.releaseId) !== batch.releaseId
          || text(existingBatch.sourceCommit).toLowerCase() !== batch.sourceCommit
          || Number(existingBatch.actorUserId) !== batch.actorUserId
          || Number(existingBatch.entryCount) !== batch.entries.length
        ) {
          throw new ModelRouteCertificationError(
            "batchId 已绑定不同的规范认证批次",
            409,
            "model_route_certification_batch_conflict",
          );
        }
        const persistedRows = await transaction("o_model_route_certification")
          .where({ batchId: batch.batchId })
          .orderBy("routeId", "asc")
          .orderBy("operationKey", "asc")
          .orderBy("id", "asc");
        const records = persistedRows.map(formatModelRouteCertificationRecord);
        const persistedIdentities = new Set(
          records.map((record) => `${record.routeId}\u0000${record.operationKey}`),
        );
        const expectedIdentities = batch.entries.map(
          (entry) => `${entry.routeId}\u0000${entry.operationKey}`,
        );
        const audit = await transaction("o_audit_log")
          .where({
            action: "admin.model_route.certification_batch_apply",
            resourceType: "model_route_certification_batch",
            resourceId: batch.batchId,
          })
          .orderBy("createdAt", "asc")
          .first();
        const auditMetadata = parseAuditMetadata(audit?.metadata);
        if (
          records.length !== batch.entries.length
          || expectedIdentities.some((identity) => !persistedIdentities.has(identity))
          || !audit
          || text(auditMetadata.batchDigest).toLowerCase() !== batchDigest
          || Number(auditMetadata.entryCount) !== batch.entries.length
        ) {
          throw new ModelRouteCertificationError(
            "已应用的认证批次回执、证据或审计链不完整",
            409,
            "model_route_certification_batch_state_invalid",
          );
        }
        return receiptFor({
          batch,
          mode,
          records,
          completedAt: Number(existingBatch.appliedAt),
        });
      }

      const orphanedCertification = await transaction("o_model_route_certification")
        .where({ batchId: batch.batchId })
        .first();
      if (orphanedCertification) {
        throw new ModelRouteCertificationError(
          "batchId 在批次注册前已被认证行占用",
          409,
          "model_route_certification_batch_conflict",
        );
      }

      const records: ModelRouteCertificationRecord[] = [];
      for (const entry of batch.entries) {
        records.push(await certifyModelRoute(transaction, {
          ...entry,
          batchId: batch.batchId,
          releaseId: batch.releaseId,
          sourceCommit: batch.sourceCommit,
          certifiedByUserId: batch.actorUserId,
          now,
        }));
      }
      const receipt = receiptFor({ batch, mode, records, completedAt: now });
      if (mode === "validate") throw new ValidationRollback(receipt);
      await writeAuditLog(
        {
          actor: {
            actorUserId: batch.actorUserId,
            actorRole,
            actorKind: "user",
          },
        },
        {
          action: "admin.model_route.certification_batch_apply",
          resourceType: "model_route_certification_batch",
          resourceId: batch.batchId,
          required: true,
          metadata: {
            batchId: batch.batchId,
            releaseId: batch.releaseId,
            sourceCommit: batch.sourceCommit,
            batchDigest,
            entryCount: records.length,
          },
        },
        transaction,
      );
      return receipt;
    });
  } catch (error) {
    if (error instanceof ValidationRollback) return error.receipt;
    throw error;
  }
}
