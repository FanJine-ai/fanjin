import type { Knex } from "knex";
import { v4 as uuid } from "uuid";

import { db } from "@/utils/db";
import {
  DOMAIN_VERIFICATION_TABLE,
  TENANT_DOMAIN_OPERATION_TABLE,
  TENANT_DOMAIN_TABLE,
  TenantDomainError,
  preflightTenantDomain,
  rowToDomain,
  tenantDomainById,
  type TenantDomainRecord,
} from "@/lib/tenantDomain";
import { resetTenantRuntimeSnapshotCache } from "@/lib/tenantDirectory";

/**
 * 0.1.4 域名发布编排（R3 修正，设计文档 §12.3）：
 *
 * publishTenantDomain 只把域名从 ready 推进到 activating 并持久化 operation；
 * active 只能由完整的观察证据链产生：
 *   1. 预检（所有权/ICP/证书/容量）
 *   2. load-balancer provider 创建/更新域名与证书绑定
 *   3. 回读云端 observed binding（绝不以 desired 冒充 observed）
 *   4. 发布并回读运行时租户 snapshot revision
 *   5. 对该域名执行 required public smoke
 *   6. 全部成功后原子写入 active 且 observedRevision=desiredRevision
 *
 * FANJIN_TENANT_INGRESS_CLOUD_ENABLED!=1 时域名保持 activating 并返回 pending
 * operation，绝不标记 active。任一步失败记录安全错误码并执行补偿；补偿完成回
 * ready，补偿失败进入 failed 人工处理状态，绝不虚报“已回滚”。
 *
 * 所有云端能力通过 TenantDomainOrchestrator 依赖注入；单元测试使用 Fake，
 * 默认不得访问公网。
 */

const INGRESS_BINDING_TABLE = "o_tenant_ingress_binding";
const INGRESS_CLUSTER_TABLE = "o_ingress_cluster";
const CERTIFICATE_TABLE = "o_tenant_certificate";

export type TenantDomainIngressBindingRefs = {
  providerDomainExtensionId: string | null;
  providerRuleId: string | null;
  serverGroupId: string | null;
};

export type TenantDomainCertificateRef = {
  id: string;
  provider: string | null;
  providerCertificateId: string | null;
  commonName: string | null;
  sans: string[];
};

export interface TenantDomainOrchestrator {
  /** 步骤 2：创建/更新域名与证书绑定（必须幂等，重放不得重复创建云端资源）。 */
  bindDomain(input: {
    domain: TenantDomainRecord;
    certificate: TenantDomainCertificateRef | null;
    ingressClusterId: string | null;
  }): Promise<TenantDomainIngressBindingRefs>;
  /** 步骤 3：回读云端 observed binding 状态。 */
  readObservedBinding(input: {
    domain: TenantDomainRecord;
    binding: TenantDomainIngressBindingRefs;
  }): Promise<{
    state: "bound" | "unbound" | "pending";
    binding: TenantDomainIngressBindingRefs | null;
  }>;
  /** 步骤 4：发布运行时租户快照并回读 revision。 */
  publishRuntimeSnapshot(input: {
    domain: TenantDomainRecord;
    desiredRevision: number;
  }): Promise<{ revision: string }>;
  /** 步骤 5：对该域名执行 required public smoke。 */
  runRequiredSmoke(input: {
    domain: TenantDomainRecord;
    expectedTenantId: string;
  }): Promise<{ ok: boolean; failures: string[] }>;
  /** 补偿：移除绑定（幂等）。 */
  unbindDomain(input: { domain: TenantDomainRecord }): Promise<void>;
}

export class TenantDomainOrchestrationError extends TenantDomainError {
  constructor(message: string, status: number, code: string) {
    super(message, status, code);
    this.name = "TenantDomainOrchestrationError";
  }
}

export function tenantIngressCloudEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.FANJIN_TENANT_INGRESS_CLOUD_ENABLED || "").trim() === "1";
}

export type TenantDomainActivationStatus = "pending_cloud" | "active";

export type PublishTenantDomainResult = {
  domain: TenantDomainRecord;
  operationId: string;
  status: TenantDomainActivationStatus;
  pendingCloudSteps: string[];
  evidence: {
    observedBindingState: string | null;
    runtimeSnapshotRevision: string | null;
    smokeFailures: string[] | null;
  } | null;
};

const PENDING_CLOUD_STEPS = [
  "bind_domain",
  "read_observed_binding",
  "publish_runtime_snapshot",
  "required_public_smoke",
] as const;

// ---------------------------------------------------------------------------
// Operation 持久化（幂等、可恢复、按 domain/revision/type 去重）
// ---------------------------------------------------------------------------

async function createActivationOperation(
  trx: Knex.Transaction,
  input: {
    tenantId: string;
    domainId: string;
    requestedRevision: number;
    requestedByUserId?: number | null;
    currentStep: string;
  },
): Promise<string> {
  const idempotencyKey = `op:activate:${input.domainId}:${input.requestedRevision}`;
  const existing = await trx(TENANT_DOMAIN_OPERATION_TABLE).where({ idempotencyKey }).first();
  if (existing) return String(existing.id);
  const operationId = uuid();
  const timestamp = Date.now();
  await trx(TENANT_DOMAIN_OPERATION_TABLE).insert({
    id: operationId,
    idempotencyKey,
    tenantId: input.tenantId,
    domainId: input.domainId,
    operationType: "activate",
    requestedRevision: input.requestedRevision,
    state: "queued",
    currentStep: input.currentStep,
    attemptCount: 0,
    nextAttemptAt: null,
    requestedByUserId: input.requestedByUserId ?? null,
    approvedByUserId: null,
    result: "{}",
    errorCode: null,
    errorMessage: null,
    createdAt: timestamp,
    startedAt: null,
    finishedAt: null,
    updatedAt: timestamp,
  });
  return operationId;
}

async function markOperationRunning(operationId: string, step: string): Promise<void> {
  const timestamp = Date.now();
  await db(TENANT_DOMAIN_OPERATION_TABLE)
    .where({ id: operationId })
    .whereIn("state", ["queued", "running"])
    .update({
      state: "running",
      currentStep: step,
      attemptCount: db.raw("attemptCount + 1"),
      startedAt: db.raw("COALESCE(startedAt, ?)", [timestamp]),
      errorMessage: null,
      errorCode: null,
      updatedAt: timestamp,
    });
}

async function finishOperation(
  operationId: string,
  result: {
    state: "succeeded" | "failed" | "cancelled";
    errorCode?: string | null;
    errorMessage?: string | null;
    payload?: Record<string, unknown>;
  },
): Promise<void> {
  const timestamp = Date.now();
  await db(TENANT_DOMAIN_OPERATION_TABLE)
    .where({ id: operationId })
    .update({
      state: result.state,
      currentStep: null,
      errorCode: result.errorCode ?? null,
      errorMessage: result.errorMessage ?? null,
      result: JSON.stringify(result.payload ?? {}),
      finishedAt: timestamp,
      updatedAt: timestamp,
    });
}

function safeStepErrorCode(error: unknown): { code: string; message: string } {
  const code = String((error as { code?: unknown })?.code || "");
  if (/^[A-Z][A-Z0-9_]{3,63}$/.test(code)) {
    return { code, message: String((error as Error)?.message || code) };
  }
  return { code: "DOMAIN_ORCHESTRATION_FAILED", message: "域名发布编排步骤失败" };
}

// ---------------------------------------------------------------------------
// 辅助读取
// ---------------------------------------------------------------------------

async function resolveCertificateRef(
  database: Knex | Knex.Transaction,
  domain: TenantDomainRecord,
): Promise<TenantDomainCertificateRef | null> {
  if (!domain.certificateId) return null;
  const row = await (database as any)(CERTIFICATE_TABLE).where({ id: domain.certificateId }).first();
  if (!row) return null;
  let sans: string[] = [];
  try {
    sans = JSON.parse(String(row.sans || "[]"));
  } catch {
    sans = [];
  }
  return {
    id: String(row.id),
    provider: row.provider ? String(row.provider) : null,
    providerCertificateId: row.providerCertificateId ? String(row.providerCertificateId) : null,
    commonName: row.commonName ? String(row.commonName) : null,
    sans,
  };
}

async function resolveIngressClusterId(
  database: Knex | Knex.Transaction,
): Promise<string | null> {
  const row = await (database as any)(INGRESS_CLUSTER_TABLE)
    .whereNot({ status: "retired" })
    .orderBy("createdAt", "asc")
    .first();
  return row ? String(row.id) : null;
}

async function upsertIngressBinding(
  database: Knex | Knex.Transaction,
  input: {
    domainId: string;
    ingressClusterId: string | null;
    certificateId: string | null;
    refs: TenantDomainIngressBindingRefs;
    desiredState: "bound" | "unbound";
    observedState: "bound" | "unbound" | "pending";
  },
): Promise<void> {
  const timestamp = Date.now();
  const existing = await (database as any)(INGRESS_BINDING_TABLE)
    .where({ domainId: input.domainId })
    .first();
  const patch = {
    ingressClusterId: input.ingressClusterId,
    certificateId: input.certificateId,
    providerDomainExtensionId: input.refs.providerDomainExtensionId,
    providerRuleId: input.refs.providerRuleId,
    serverGroupId: input.refs.serverGroupId,
    desiredState: input.desiredState,
    observedState: input.observedState,
    lastReconciledAt: timestamp,
    updatedAt: timestamp,
  };
  if (existing) {
    await (database as any)(INGRESS_BINDING_TABLE).where({ id: existing.id }).update(patch);
    return;
  }
  await (database as any)(INGRESS_BINDING_TABLE).insert({
    id: uuid(),
    domainId: input.domainId,
    ...patch,
    metadata: "{}",
    createdAt: timestamp,
  });
}

// ---------------------------------------------------------------------------
// 发布 / 激活编排
// ---------------------------------------------------------------------------

/**
 * 发布域名：ready → activating（+持久化 operation）。
 * cloud enabled 且提供 orchestrator 时执行完整编排并在全部证据就绪后原子写入
 * active；cloud disabled 时保持 activating 并返回 pending operation。
 */
export async function publishTenantDomain(input: {
  domainId: string;
  operatorUserId?: number | null;
  orchestrator?: TenantDomainOrchestrator | null;
  env?: NodeJS.ProcessEnv;
}): Promise<PublishTenantDomainResult> {
  const env = input.env ?? process.env;
  const cloudEnabled = tenantIngressCloudEnabled(env);
  const orchestrator = input.orchestrator ?? null;
  if (cloudEnabled && !orchestrator) {
    throw new TenantDomainOrchestrationError(
      "云端编排器不可用，拒绝发布域名",
      503,
      "DOMAIN_ORCHESTRATOR_UNAVAILABLE",
    );
  }

  const phase = await db.transaction(async (trx) => {
    const row = await trx(TENANT_DOMAIN_TABLE)
      .where({ id: input.domainId })
      .whereNull("deletedAt")
      .forUpdate()
      .first();
    if (!row) throw new TenantDomainError("域名不存在", 404, "DOMAIN_NOT_FOUND");
    const domain = rowToDomain(row);
    if (domain.lifecycleState === "active") {
      throw new TenantDomainError("域名已处于生效状态", 409, "DOMAIN_STATE_INVALID");
    }
    if (["activating", "suspending"].includes(domain.lifecycleState)) {
      throw new TenantDomainError("域名状态迁移中，请先恢复或中止当前操作", 409, "DOMAIN_STATE_INVALID");
    }
    const preflight = await preflightTenantDomain({ domainId: domain.id, database: trx });
    if (!preflight.passed) {
      throw new TenantDomainError(
        `预检未通过：${preflight.blockers.join(", ")}`,
        409,
        "DOMAIN_PREFLIGHT_FAILED",
      );
    }
    const timestamp = Date.now();
    const newRevision = domain.desiredRevision + 1;
    const updated = await trx(TENANT_DOMAIN_TABLE)
      .where({ id: domain.id, desiredRevision: domain.desiredRevision })
      .update({
        lifecycleState: "activating",
        activatedAt: null,
        suspendedAt: null,
        desiredRevision: newRevision,
        failureCode: null,
        failureMessage: null,
        updatedAt: timestamp,
        updatedByUserId: input.operatorUserId ?? null,
      });
    if (Number(updated || 0) !== 1) {
      throw new TenantDomainError("域名状态已变化，请重试", 409, "DOMAIN_STATE_CONFLICT");
    }
    const operationId = await createActivationOperation(trx, {
      tenantId: domain.tenantId,
      domainId: domain.id,
      requestedRevision: newRevision,
      requestedByUserId: input.operatorUserId,
      currentStep: cloudEnabled ? "queued" : "awaiting_cloud_orchestrator",
    });
    const refreshed = await trx(TENANT_DOMAIN_TABLE).where({ id: domain.id }).first();
    return { domain: rowToDomain(refreshed), operationId, newRevision };
  });

  if (!cloudEnabled) {
    return {
      domain: phase.domain,
      operationId: phase.operationId,
      status: "pending_cloud",
      pendingCloudSteps: [...PENDING_CLOUD_STEPS],
      evidence: null,
    };
  }

  return await runActivationOrchestration({
    domain: phase.domain,
    operationId: phase.operationId,
    desiredRevision: phase.newRevision,
    orchestrator: orchestrator!,
  });
}

/**
 * 执行激活编排步骤 2-6。操作记录按步骤推进 checkpoint；任一步失败执行补偿。
 * 进程崩溃后可通过 recoverTenantDomainOperations 从 checkpoint 重新驱动
 * （bindDomain 必须幂等，重放不重复创建云端资源）。
 */
export async function runActivationOrchestration(input: {
  domain: TenantDomainRecord;
  operationId: string;
  desiredRevision: number;
  orchestrator: TenantDomainOrchestrator;
  /** 恢复模式：跳过 operation 状态字段的乐观校验。 */
  recovery?: boolean;
}): Promise<PublishTenantDomainResult> {
  const { domain, operationId, desiredRevision, orchestrator } = input;
  let observedBindingState: string | null = null;
  let runtimeSnapshotRevision: string | null = null;
  let smokeFailures: string[] | null = null;

  try {
    await markOperationRunning(operationId, "bind_domain");
    const certificate = await resolveCertificateRef(db, domain);
    const ingressClusterId = await resolveIngressClusterId(db);
    if (!ingressClusterId) {
      throw new TenantDomainOrchestrationError(
        "未登记入口集群，无法执行云端绑定",
        503,
        "DOMAIN_INGRESS_CLUSTER_MISSING",
      );
    }
    const refs = await orchestrator.bindDomain({ domain, certificate, ingressClusterId });
    await upsertIngressBinding(db, {
      domainId: domain.id,
      ingressClusterId,
      certificateId: domain.certificateId,
      refs,
      desiredState: "bound",
      observedState: "pending",
    });

    await markOperationRunning(operationId, "read_observed_binding");
    const observed = await orchestrator.readObservedBinding({ domain, binding: refs });
    observedBindingState = observed.state;
    if (observed.state !== "bound" || !observed.binding) {
      throw new TenantDomainOrchestrationError(
        "云端未观察到域名绑定生效",
        502,
        "DOMAIN_BINDING_NOT_OBSERVED",
      );
    }
    await upsertIngressBinding(db, {
      domainId: domain.id,
      ingressClusterId,
      certificateId: domain.certificateId,
      refs: observed.binding,
      desiredState: "bound",
      observedState: "bound",
    });

    await markOperationRunning(operationId, "publish_runtime_snapshot");
    const snapshot = await orchestrator.publishRuntimeSnapshot({ domain, desiredRevision });
    runtimeSnapshotRevision = String(snapshot.revision || "");
    if (!runtimeSnapshotRevision) {
      throw new TenantDomainOrchestrationError(
        "运行时快照 revision 回读失败",
        502,
        "DOMAIN_SNAPSHOT_REVISION_MISSING",
      );
    }

    await markOperationRunning(operationId, "required_public_smoke");
    const smoke = await orchestrator.runRequiredSmoke({ domain, expectedTenantId: domain.tenantId });
    smokeFailures = smoke.failures || [];
    if (!smoke.ok) {
      throw new TenantDomainOrchestrationError(
        `域名公网探测未通过：${(smoke.failures || []).join(", ")}`,
        502,
        "DOMAIN_PUBLIC_SMOKE_FAILED",
      );
    }

    // 步骤 6：全部证据就绪后原子写入 active。
    const activated = await db.transaction(async (trx) => {
      const updated = await trx(TENANT_DOMAIN_TABLE)
        .where({ id: domain.id, desiredRevision })
        .update({
          lifecycleState: "active",
          activatedAt: Date.now(),
          suspendedAt: null,
          observedRevision: desiredRevision,
          failureCode: null,
          failureMessage: null,
          updatedAt: Date.now(),
        });
      if (Number(updated || 0) !== 1) {
        throw new TenantDomainError("域名状态已变化，激活未被写入", 409, "DOMAIN_STATE_CONFLICT");
      }
      const refreshed = await trx(TENANT_DOMAIN_TABLE).where({ id: domain.id }).first();
      return rowToDomain(refreshed);
    });
    await finishOperation(operationId, {
      state: "succeeded",
      payload: {
        observedBindingState,
        runtimeSnapshotRevision,
        smokeFailures,
        desiredRevision,
      },
    });
    resetTenantRuntimeSnapshotCache();
    return {
      domain: activated,
      operationId,
      status: "active",
      pendingCloudSteps: [],
      evidence: { observedBindingState, runtimeSnapshotRevision, smokeFailures },
    };
  } catch (error) {
    const failure = safeStepErrorCode(error);
    // 补偿：尽力移除云端绑定；结果如实记录，绝不虚报已回滚。
    let compensation: "completed" | "failed" = "failed";
    let compensationError: string | null = null;
    try {
      await orchestrator.unbindDomain({ domain });
      compensation = "completed";
    } catch (unbindError) {
      compensationError = String((unbindError as Error)?.message || "unbind_failed");
    }
    await finishOperation(operationId, {
      state: "failed",
      errorCode: failure.code,
      errorMessage: failure.message,
      payload: { compensation, compensationError, observedBindingState, runtimeSnapshotRevision, smokeFailures },
    });
    const timestamp = Date.now();
    if (compensation === "completed") {
      await db(TENANT_DOMAIN_TABLE).where({ id: domain.id }).update({
        lifecycleState: "ready",
        failureCode: failure.code,
        failureMessage: failure.message,
        updatedAt: timestamp,
      });
      resetTenantRuntimeSnapshotCache();
      throw new TenantDomainOrchestrationError(
        `域名发布失败（已补偿回 ready）：${failure.message}`,
        409,
        failure.code,
      );
    }
    await db(TENANT_DOMAIN_TABLE).where({ id: domain.id }).update({
      lifecycleState: "failed",
      failureCode: "DOMAIN_COMPENSATION_FAILED",
      failureMessage: `发布失败且补偿未完成：${failure.message}；补偿错误：${compensationError || "unknown"}`,
      updatedAt: timestamp,
    });
    resetTenantRuntimeSnapshotCache();
    throw new TenantDomainOrchestrationError(
      `域名发布失败且补偿未完成，需人工处理：${failure.message}`,
      502,
      "DOMAIN_COMPENSATION_FAILED",
    );
  }
}

// ---------------------------------------------------------------------------
// 中止 / 恢复
// ---------------------------------------------------------------------------

/**
 * 中止 activating 域名的发布：cloud disabled 直接取消回 ready；
 * cloud enabled 走补偿（unbind），补偿失败进入 failed 人工状态。
 */
export async function abortTenantDomainActivation(input: {
  domainId: string;
  operatorUserId?: number | null;
  orchestrator?: TenantDomainOrchestrator | null;
  env?: NodeJS.ProcessEnv;
}): Promise<TenantDomainRecord> {
  const env = input.env ?? process.env;
  const cloudEnabled = tenantIngressCloudEnabled(env);
  const orchestrator = input.orchestrator ?? null;
  if (cloudEnabled && !orchestrator) {
    throw new TenantDomainOrchestrationError(
      "云端编排器不可用，拒绝中止域名发布",
      503,
      "DOMAIN_ORCHESTRATOR_UNAVAILABLE",
    );
  }

  const domain = await db.transaction(async (trx) => {
    const row = await trx(TENANT_DOMAIN_TABLE)
      .where({ id: input.domainId })
      .whereNull("deletedAt")
      .forUpdate()
      .first();
    if (!row) throw new TenantDomainError("域名不存在", 404, "DOMAIN_NOT_FOUND");
    const current = rowToDomain(row);
    if (current.lifecycleState !== "activating") {
      throw new TenantDomainError("仅激活中的域名可以中止发布", 409, "DOMAIN_STATE_INVALID");
    }
    const operation = await trx(TENANT_DOMAIN_OPERATION_TABLE)
      .where({ domainId: current.id, operationType: "activate" })
      .whereIn("state", ["queued", "running"])
      .orderBy("createdAt", "desc")
      .first();
    const timestamp = Date.now();
    if (!cloudEnabled || !orchestrator) {
      if (operation) {
        await trx(TENANT_DOMAIN_OPERATION_TABLE).where({ id: operation.id }).update({
          state: "cancelled",
          currentStep: null,
          errorCode: "DOMAIN_ACTIVATION_ABORTED",
          errorMessage: "管理员中止发布（云端未启用）",
          finishedAt: timestamp,
          updatedAt: timestamp,
        });
      }
      await trx(TENANT_DOMAIN_TABLE).where({ id: current.id }).update({
        lifecycleState: "ready",
        failureCode: "DOMAIN_ACTIVATION_ABORTED",
        failureMessage: "管理员中止发布",
        updatedAt: timestamp,
        updatedByUserId: input.operatorUserId ?? null,
      });
      return rowToDomain(await trx(TENANT_DOMAIN_TABLE).where({ id: current.id }).first());
    }
    // cloud enabled：标记 suspending，云端补偿在事务提交后执行。
    await trx(TENANT_DOMAIN_TABLE).where({ id: current.id }).update({
      lifecycleState: "suspending",
      updatedAt: timestamp,
    });
    return rowToDomain(await trx(TENANT_DOMAIN_TABLE).where({ id: current.id }).first());
  });

  if (domain.lifecycleState !== "suspending") return domain;

  try {
    await orchestrator!.unbindDomain({ domain });
  } catch (error) {
    const timestamp = Date.now();
    await db(TENANT_DOMAIN_TABLE).where({ id: domain.id }).update({
      lifecycleState: "failed",
      failureCode: "DOMAIN_COMPENSATION_FAILED",
      failureMessage: `中止发布补偿失败：${String((error as Error)?.message || "unbind_failed")}`,
      updatedAt: timestamp,
    });
    resetTenantRuntimeSnapshotCache();
    throw new TenantDomainOrchestrationError(
      "中止发布补偿失败，需人工处理",
      502,
      "DOMAIN_COMPENSATION_FAILED",
    );
  }
  const timestamp = Date.now();
  const operation = await db(TENANT_DOMAIN_OPERATION_TABLE)
    .where({ domainId: domain.id, operationType: "activate" })
    .whereIn("state", ["queued", "running"])
    .orderBy("createdAt", "desc")
    .first();
  if (operation) {
    await db(TENANT_DOMAIN_OPERATION_TABLE).where({ id: operation.id }).update({
      state: "cancelled",
      currentStep: null,
      errorCode: "DOMAIN_ACTIVATION_ABORTED",
      errorMessage: "管理员中止发布（已补偿）",
      finishedAt: timestamp,
      updatedAt: timestamp,
    });
  }
  await db(TENANT_DOMAIN_TABLE).where({ id: domain.id }).update({
    lifecycleState: "ready",
    failureCode: "DOMAIN_ACTIVATION_ABORTED",
    failureMessage: "管理员中止发布（已补偿）",
    updatedAt: timestamp,
    updatedByUserId: input.operatorUserId ?? null,
  });
  resetTenantRuntimeSnapshotCache();
  return rowToDomain(await db(TENANT_DOMAIN_TABLE).where({ id: domain.id }).first());
}

/**
 * 崩溃恢复：重新驱动 queued/running 的激活或暂停操作。
 * bind/unbind 均要求幂等，重放不重复创建/误删云端资源；已 succeeded 的
 * 操作不会重跑。父级 tenant_suspend operation 由管理员以同 revision 重试。
 */
export async function recoverTenantDomainOperations(input: {
  orchestrator: TenantDomainOrchestrator;
  limit?: number;
}): Promise<{
  recovered: number;
  results: Array<{ domainId: string; operationId: string; status: string }>;
}> {
  const limit = Math.max(1, Math.min(50, Number(input.limit || 10)));
  const rows = await db(TENANT_DOMAIN_OPERATION_TABLE)
    .whereIn("operationType", ["activate", "suspend"])
    .whereIn("state", ["queued", "running"])
    .orderBy("createdAt", "asc")
    .limit(limit);
  const results: Array<{ domainId: string; operationId: string; status: string }> = [];
  for (const row of rows) {
    const domainId = String(row.domainId || "");
    if (!domainId) continue;
    const domain = await tenantDomainById(db, domainId);
    try {
      if (String(row.operationType) === "activate") {
        if (domain.lifecycleState !== "activating") continue;
        const outcome = await runActivationOrchestration({
          domain,
          operationId: String(row.id),
          desiredRevision: Number(row.requestedRevision),
          orchestrator: input.orchestrator,
          recovery: true,
        });
        results.push({ domainId, operationId: String(row.id), status: outcome.status });
      } else {
        const needsObservedUnbind = domain.lifecycleState === "suspended"
          && domain.observedRevision !== domain.desiredRevision;
        if (domain.lifecycleState !== "suspending" && !needsObservedUnbind) continue;
        const suspended = await suspendTenantDomain({
          domainId,
          operatorUserId: row.requestedByUserId == null ? null : Number(row.requestedByUserId),
          orchestrator: input.orchestrator,
          env: { ...process.env, FANJIN_TENANT_INGRESS_CLOUD_ENABLED: "1" },
        });
        results.push({ domainId, operationId: String(row.id), status: suspended.lifecycleState });
      }
    } catch (error) {
      results.push({
        domainId,
        operationId: String(row.id),
        status: String((error as { code?: unknown })?.code || "failed"),
      });
    }
  }
  return { recovered: results.length, results };
}

// ---------------------------------------------------------------------------
// 暂停 / 恢复（desired 与 observed 严格区分）
// ---------------------------------------------------------------------------

/**
 * 暂停域名：cloud enabled 时通过 orchestrator 解绑并回读 observed=unbound 后
 * 才写 suspended 且 observedRevision=desiredRevision；cloud disabled 时仅推进
 * desired 状态，observedRevision 保持不变（不伪造云端成功）。
 */
export async function suspendTenantDomain(input: {
  domainId: string;
  operatorUserId?: number | null;
  orchestrator?: TenantDomainOrchestrator | null;
  env?: NodeJS.ProcessEnv;
}): Promise<TenantDomainRecord> {
  const env = input.env ?? process.env;
  const cloudEnabled = tenantIngressCloudEnabled(env);
  const orchestrator = input.orchestrator ?? null;
  if (cloudEnabled && !orchestrator) {
    throw new TenantDomainOrchestrationError(
      "云端编排器不可用，拒绝暂停域名",
      503,
      "DOMAIN_ORCHESTRATOR_UNAVAILABLE",
    );
  }
  const phase = await db.transaction(async (trx) => {
    const row = await trx(TENANT_DOMAIN_TABLE)
      .where({ id: input.domainId })
      .whereNull("deletedAt")
      .forUpdate()
      .first();
    if (!row) throw new TenantDomainError("域名不存在", 404, "DOMAIN_NOT_FOUND");
    const domain = rowToDomain(row);
    const suspendedAndObserved = domain.lifecycleState === "suspended"
      && (!cloudEnabled || domain.observedRevision === domain.desiredRevision);
    if (suspendedAndObserved) {
      return {
        domain,
        newRevision: domain.desiredRevision,
        operationId: null,
        alreadySuspended: true,
      };
    }
    if (!["active", "suspending", "failed", "suspended"].includes(domain.lifecycleState)) {
      throw new TenantDomainError("仅生效中的域名可以暂停", 409, "DOMAIN_STATE_INVALID");
    }
    const timestamp = Date.now();
    const newRevision = domain.lifecycleState === "active"
      ? domain.desiredRevision + 1
      : domain.desiredRevision;
    const idempotencyKey = `op:suspend:${domain.id}:${newRevision}`;
    let operation = await trx(TENANT_DOMAIN_OPERATION_TABLE).where({ idempotencyKey }).first();
    if (domain.lifecycleState !== "active" && !operation) {
      throw new TenantDomainError("域名暂停操作缺少可恢复 checkpoint", 409, "DOMAIN_SUSPEND_CHECKPOINT_MISSING");
    }
    if (domain.lifecycleState === "active") {
      const updated = await trx(TENANT_DOMAIN_TABLE)
        .where({ id: domain.id, desiredRevision: domain.desiredRevision, lifecycleState: "active" })
        .update({
          lifecycleState: "suspending",
          suspendedAt: timestamp,
          desiredRevision: newRevision,
          failureCode: null,
          failureMessage: null,
          updatedAt: timestamp,
          updatedByUserId: input.operatorUserId ?? null,
        });
      if (Number(updated || 0) !== 1) {
        throw new TenantDomainError("域名状态已变化，请重试", 409, "DOMAIN_STATE_CONFLICT");
      }
      if (!operation) {
        const operationId = uuid();
        await trx(TENANT_DOMAIN_OPERATION_TABLE).insert({
          id: operationId,
          idempotencyKey,
          tenantId: domain.tenantId,
          domainId: domain.id,
          operationType: "suspend",
          requestedRevision: newRevision,
          state: "queued",
          currentStep: cloudEnabled ? "unbind_domain" : "awaiting_cloud_orchestrator",
          attemptCount: 0,
          nextAttemptAt: null,
          requestedByUserId: input.operatorUserId ?? null,
          approvedByUserId: null,
          result: "{}",
          errorCode: null,
          errorMessage: null,
          createdAt: timestamp,
          startedAt: null,
          finishedAt: null,
          updatedAt: timestamp,
        });
        operation = await trx(TENANT_DOMAIN_OPERATION_TABLE).where({ id: operationId }).first();
      }
    } else {
      // Retry the exact durable suspension intent after a crash/provider error,
      // or after a desired-only suspension performed while cloud orchestration was disabled.
      await trx(TENANT_DOMAIN_TABLE).where({ id: domain.id, desiredRevision: newRevision }).update({
        lifecycleState: "suspending",
        failureCode: null,
        failureMessage: null,
        updatedAt: timestamp,
        updatedByUserId: input.operatorUserId ?? null,
      });
      await trx(TENANT_DOMAIN_OPERATION_TABLE).where({ id: operation.id }).update({
        state: "queued",
        currentStep: cloudEnabled ? "unbind_domain" : "awaiting_cloud_orchestrator",
        errorCode: null,
        errorMessage: null,
        finishedAt: null,
        updatedAt: timestamp,
      });
    }
    const refreshed = rowToDomain(await trx(TENANT_DOMAIN_TABLE).where({ id: domain.id }).first());
    return {
      domain: refreshed,
      newRevision,
      operationId: String(operation.id),
      alreadySuspended: false,
    };
  });

  if (phase.alreadySuspended) return phase.domain;

  if (!cloudEnabled || !orchestrator) {
    // 云端未启用：仅推进 desired，不推进 observed（诚实记录）。
    const timestamp = Date.now();
    await db.transaction(async (trx) => {
      await trx(TENANT_DOMAIN_TABLE)
        .where({ id: phase.domain.id, desiredRevision: phase.newRevision, lifecycleState: "suspending" })
        .update({ lifecycleState: "suspended", updatedAt: timestamp });
      await trx(TENANT_DOMAIN_OPERATION_TABLE).where({ id: phase.operationId }).update({
        state: "queued",
        currentStep: "awaiting_cloud_orchestrator",
        attemptCount: trx.raw("attemptCount + 1"),
        startedAt: trx.raw("COALESCE(startedAt, ?)", [timestamp]),
        result: JSON.stringify({ cloudEnabled: false }),
        updatedAt: timestamp,
      });
    });
    resetTenantRuntimeSnapshotCache();
    return rowToDomain(await db(TENANT_DOMAIN_TABLE).where({ id: phase.domain.id }).first());
  }

  try {
    await markOperationRunning(phase.operationId!, "unbind_domain");
    await orchestrator.unbindDomain({ domain: phase.domain });
    await markOperationRunning(phase.operationId!, "read_observed_unbound");
    const observed = await orchestrator.readObservedBinding({
      domain: phase.domain,
      binding: {
        providerDomainExtensionId: null,
        providerRuleId: null,
        serverGroupId: null,
      },
    });
    if (observed.state !== "unbound") {
      throw new TenantDomainOrchestrationError(
        "云端尚未观察到域名解绑，暂停未生效",
        502,
        "DOMAIN_UNBIND_NOT_OBSERVED",
      );
    }
    const timestamp = Date.now();
    await db.transaction(async (trx) => {
      const updated = await trx(TENANT_DOMAIN_TABLE).where({
        id: phase.domain.id,
        desiredRevision: phase.newRevision,
        lifecycleState: "suspending",
      }).update({
        lifecycleState: "suspended",
        observedRevision: phase.newRevision,
        failureCode: null,
        failureMessage: null,
        updatedAt: timestamp,
      });
      if (Number(updated || 0) !== 1) {
        throw new TenantDomainError("域名状态已变化，暂停结果未被写入", 409, "DOMAIN_STATE_CONFLICT");
      }
      await trx(INGRESS_BINDING_TABLE).where({ domainId: phase.domain.id }).update({
        providerDomainExtensionId: null,
        providerRuleId: null,
        serverGroupId: null,
        desiredState: "unbound",
        observedState: "unbound",
        lastReconciledAt: timestamp,
        updatedAt: timestamp,
      });
      await trx(TENANT_DOMAIN_OPERATION_TABLE).where({ id: phase.operationId }).update({
        state: "succeeded",
        currentStep: null,
        nextAttemptAt: null,
        result: JSON.stringify({ observedBindingState: observed.state }),
        errorCode: null,
        errorMessage: null,
        finishedAt: timestamp,
        updatedAt: timestamp,
      });
    });
    resetTenantRuntimeSnapshotCache();
    return rowToDomain(await db(TENANT_DOMAIN_TABLE).where({ id: phase.domain.id }).first());
  } catch (error) {
    const failure = safeStepErrorCode(error);
    const timestamp = Date.now();
    await db.transaction(async (trx) => {
      await trx(TENANT_DOMAIN_TABLE)
        .where({ id: phase.domain.id, desiredRevision: phase.newRevision })
        .update({
          lifecycleState: "failed",
          failureCode: failure.code,
          failureMessage: `域名暂停失败：${failure.message}`,
          updatedAt: timestamp,
        });
      await trx(TENANT_DOMAIN_OPERATION_TABLE).where({ id: phase.operationId }).update({
        state: "failed",
        currentStep: null,
        errorCode: failure.code,
        errorMessage: failure.message,
        result: JSON.stringify({ observedBindingState: null }),
        finishedAt: timestamp,
        updatedAt: timestamp,
      });
    });
    resetTenantRuntimeSnapshotCache();
    throw new TenantDomainOrchestrationError(
      `域名暂停失败（需人工处理）：${failure.message}`,
      502,
      failure.code,
    );
  }
}

/**
 * 恢复已暂停域名：cloud enabled 且提供 orchestrator 时走完整激活编排；
 * 否则仅回到 ready 等待发布（不伪造 active）。
 */
export async function restoreTenantDomain(input: {
  domainId: string;
  operatorUserId?: number | null;
  orchestrator?: TenantDomainOrchestrator | null;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  domain: TenantDomainRecord;
  status: TenantDomainActivationStatus;
  operationId: string | null;
  pendingCloudSteps: string[];
}> {
  const env = input.env ?? process.env;
  const cloudEnabled = tenantIngressCloudEnabled(env);
  const orchestrator = input.orchestrator ?? null;
  if (cloudEnabled && !orchestrator) {
    throw new TenantDomainOrchestrationError(
      "云端编排器不可用，拒绝恢复域名",
      503,
      "DOMAIN_ORCHESTRATOR_UNAVAILABLE",
    );
  }
  const phase = await db.transaction(async (trx) => {
    const row = await trx(TENANT_DOMAIN_TABLE)
      .where({ id: input.domainId })
      .whereNull("deletedAt")
      .forUpdate()
      .first();
    if (!row) throw new TenantDomainError("域名不存在", 404, "DOMAIN_NOT_FOUND");
    const domain = rowToDomain(row);
    if (domain.lifecycleState !== "suspended") {
      throw new TenantDomainError("仅已暂停的域名可以恢复", 409, "DOMAIN_STATE_INVALID");
    }
    const preflight = await preflightTenantDomain({ domainId: domain.id, database: trx });
    if (!preflight.passed) {
      throw new TenantDomainError(
        `恢复预检未通过：${preflight.blockers.join(", ")}`,
        409,
        "DOMAIN_PREFLIGHT_FAILED",
      );
    }
    const timestamp = Date.now();
    const newRevision = domain.desiredRevision + 1;
    await trx(TENANT_DOMAIN_TABLE)
      .where({ id: domain.id, desiredRevision: domain.desiredRevision })
      .update({
        lifecycleState: "activating",
        suspendedAt: null,
        desiredRevision: newRevision,
        failureCode: null,
        failureMessage: null,
        updatedAt: timestamp,
        updatedByUserId: input.operatorUserId ?? null,
      });
    const operationId = await createActivationOperation(trx, {
      tenantId: domain.tenantId,
      domainId: domain.id,
      requestedRevision: newRevision,
      requestedByUserId: input.operatorUserId,
      currentStep: cloudEnabled ? "queued" : "awaiting_cloud_orchestrator",
    });
    const refreshed = rowToDomain(await trx(TENANT_DOMAIN_TABLE).where({ id: domain.id }).first());
    return { domain: refreshed, operationId, newRevision };
  });

  if (!cloudEnabled || !orchestrator) {
    return {
      domain: phase.domain,
      status: "pending_cloud",
      operationId: phase.operationId,
      pendingCloudSteps: [...PENDING_CLOUD_STEPS],
    };
  }
  const outcome = await runActivationOrchestration({
    domain: phase.domain,
    operationId: phase.operationId,
    desiredRevision: phase.newRevision,
    orchestrator,
  });
  return {
    domain: outcome.domain,
    status: outcome.status,
    operationId: outcome.operationId,
    pendingCloudSteps: outcome.pendingCloudSteps,
  };
}
