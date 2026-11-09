import type { Knex } from "knex";
import { v4 as uuid } from "uuid";

import { db } from "@/utils/db";
import {
  CommercialTenantError,
  DEFAULT_COMMERCIAL_TENANT_ID,
  type CommercialTenant,
  type TenantDirectoryMode,
  configuredTenantsForImport,
  normalizeCommercialHost,
  tenantDirectoryMode,
} from "@/lib/commercialTenant";
import type { TenantDomainOrchestrator } from "@/lib/tenantDomainOrchestration";

export { tenantDirectoryMode };
export type { TenantDirectoryMode };

export const COMMERCIAL_TENANT_DIRECTORY_TABLE = "o_commercial_tenant";
export const TENANT_DOMAIN_TABLE = "o_tenant_domain";
const TENANT_DOMAIN_OPERATION_TABLE = "o_tenant_domain_operation";

export type TenantDirectoryRecord = {
  id: string;
  name: string;
  operatorName: string;
  status: "draft" | "active" | "suspended" | "archived";
  defaultDomainId: string | null;
  rechargeEnabled: boolean;
  settlementRequired: boolean;
  wholesaleRatePpm: number;
  configRevision: number;
  configurationSource: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
};

export class TenantDirectoryError extends Error {
  status: number;
  code: string;
  details: Record<string, unknown> | null;

  constructor(
    message: string,
    status = 400,
    code = "TENANT_DIRECTORY_ERROR",
    details: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.name = "TenantDirectoryError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

type DirectoryDb = Knex | Knex.Transaction;

function rowToRecord(row: any): TenantDirectoryRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    operatorName: String(row.operatorName),
    status: String(row.status || "draft") as TenantDirectoryRecord["status"],
    defaultDomainId: row.defaultDomainId ? String(row.defaultDomainId) : null,
    rechargeEnabled: Boolean(row.rechargeEnabled),
    settlementRequired: Boolean(row.settlementRequired),
    wholesaleRatePpm: Number(row.wholesaleRatePpm || 1_000_000),
    configRevision: Number(row.configRevision || 1),
    configurationSource: String(row.configurationSource || "deployment"),
    createdAt: Number(row.createdAt || 0),
    updatedAt: Number(row.updatedAt || 0),
    deletedAt: row.deletedAt == null ? null : Number(row.deletedAt),
  };
}

/**
 * 从环境变量导入租户目录（幂等）：
 * - 已存在的租户：仅当来自 deployment 导入时同步基础字段并递增 configRevision（人工配置不覆盖）
 * - 不存在的租户：插入 draft 记录
 * 返回导入差异报告，供双读对账与迁移报告使用。
 */
export async function importTenantDirectoryFromEnv(database: DirectoryDb = db, options: {
  operatorUserId?: number | null;
  activateImported?: boolean;
} = {}): Promise<{
  created: string[];
  updated: string[];
  unchanged: string[];
  envOnlyIds: string[];
}> {
  const envTenants = configuredTenantsForImport();
  const timestamp = Date.now();
  const created: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];
  for (const tenant of envTenants) {
    const existing = await (database as any)(COMMERCIAL_TENANT_DIRECTORY_TABLE).where({ id: tenant.id }).first();
    if (!existing) {
      await (database as any)(COMMERCIAL_TENANT_DIRECTORY_TABLE).insert({
        id: tenant.id,
        name: tenant.name,
        operatorName: tenant.operatorName,
        status: options.activateImported === false ? "draft" : "active",
        defaultDomainId: null,
        rechargeEnabled: tenant.rechargeEnabled,
        settlementRequired: tenant.settlementRequired,
        wholesaleRatePpm: tenant.wholesaleRatePpm,
        legalProfile: "{}",
        configRevision: 1,
        configurationSource: "deployment",
        createdByUserId: options.operatorUserId ?? null,
        updatedByUserId: options.operatorUserId ?? null,
        createdAt: timestamp,
        updatedAt: timestamp,
        deletedAt: null,
      });
      created.push(tenant.id);
      continue;
    }
    const current = rowToRecord(existing);
    if (current.configurationSource !== "deployment") {
      unchanged.push(tenant.id);
      continue;
    }
    const drifted = current.name !== tenant.name
      || current.operatorName !== tenant.operatorName
      || current.rechargeEnabled !== tenant.rechargeEnabled
      || current.settlementRequired !== tenant.settlementRequired
      || current.wholesaleRatePpm !== tenant.wholesaleRatePpm;
    if (!drifted) {
      unchanged.push(tenant.id);
      continue;
    }
    await (database as any)(COMMERCIAL_TENANT_DIRECTORY_TABLE)
      .where({ id: tenant.id, configRevision: current.configRevision })
      .update({
        name: tenant.name,
        operatorName: tenant.operatorName,
        rechargeEnabled: tenant.rechargeEnabled,
        settlementRequired: tenant.settlementRequired,
        wholesaleRatePpm: tenant.wholesaleRatePpm,
        configRevision: current.configRevision + 1,
        updatedByUserId: options.operatorUserId ?? null,
        updatedAt: timestamp,
      });
    updated.push(tenant.id);
  }
  const dbRows: Array<{ id: unknown }> = await (database as any)(COMMERCIAL_TENANT_DIRECTORY_TABLE)
    .whereNull("deletedAt")
    .select("id");
  const dbIds = new Set(dbRows.map((row) => String(row.id)));
  const envIds = new Set(envTenants.map((tenant) => tenant.id));
  const envOnlyIds = [...dbIds].filter((id) => !envIds.has(id));
  if (database === db && (created.length > 0 || updated.length > 0)) {
    resetTenantRuntimeSnapshotCache();
  }
  return { created, updated, unchanged, envOnlyIds };
}

export async function listTenantDirectory(database: DirectoryDb = db): Promise<TenantDirectoryRecord[]> {
  const rows = await (database as any)(COMMERCIAL_TENANT_DIRECTORY_TABLE)
    .whereNull("deletedAt")
    .orderBy("id", "asc");
  return rows.map(rowToRecord);
}

export async function tenantDirectoryById(
  database: DirectoryDb,
  tenantId: string,
): Promise<TenantDirectoryRecord> {
  const normalized = String(tenantId || "").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_-]{1,63}$/.test(normalized)) {
    throw new TenantDirectoryError("商业租户 ID 格式无效", 422, "TENANT_ID_INVALID");
  }
  const row = await (database as any)(COMMERCIAL_TENANT_DIRECTORY_TABLE)
    .where({ id: normalized })
    .whereNull("deletedAt")
    .first();
  if (!row) throw new TenantDirectoryError("商业租户不存在", 404, "TENANT_NOT_FOUND");
  return rowToRecord(row);
}

/**
 * 创建商业租户（后台）。FANJIN 平台租户不允许通过该接口创建。
 * 创建成功提交后立即失效运行时快照缓存。
 */
export async function createTenantDirectoryRecord(input: {
  tenantId: string;
  name: string;
  operatorName: string;
  rechargeEnabled?: boolean;
  settlementRequired?: boolean;
  wholesaleRatePpm?: number;
  operatorUserId?: number | null;
}): Promise<TenantDirectoryRecord> {
  const tenantId = String(input.tenantId || "").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_-]{1,63}$/.test(tenantId)) {
    throw new TenantDirectoryError("商业租户 ID 格式无效", 422, "TENANT_ID_INVALID");
  }
  if (tenantId === DEFAULT_COMMERCIAL_TENANT_ID) {
    throw new TenantDirectoryError("平台默认租户不允许通过后台创建", 409, "TENANT_PLATFORM_RESERVED");
  }
  const name = String(input.name || "").trim();
  const operatorName = String(input.operatorName || "").trim();
  if (!name || name.length > 128) throw new TenantDirectoryError("租户名称无效", 422, "TENANT_NAME_INVALID");
  if (!operatorName || operatorName.length > 256) {
    throw new TenantDirectoryError("运营主体名称无效", 422, "TENANT_OPERATOR_NAME_INVALID");
  }
  const wholesaleRatePpm = Number(input.wholesaleRatePpm ?? 1_000_000);
  if (!Number.isSafeInteger(wholesaleRatePpm) || wholesaleRatePpm < 0 || wholesaleRatePpm > 1_000_000) {
    throw new TenantDirectoryError("批发结算率必须在 0-1000000 ppm 之间", 422, "TENANT_RATE_INVALID");
  }
  const record = await db.transaction(async (trx) => {
    const existing = await trx(COMMERCIAL_TENANT_DIRECTORY_TABLE).where({ id: tenantId }).first();
    if (existing && !existing.deletedAt) {
      throw new TenantDirectoryError("商业租户已存在", 409, "TENANT_ALREADY_EXISTS");
    }
    const timestamp = Date.now();
    const row = {
      id: tenantId,
      name,
      operatorName,
      status: "draft",
      defaultDomainId: null,
      rechargeEnabled: input.rechargeEnabled ?? true,
      settlementRequired: input.settlementRequired ?? true,
      wholesaleRatePpm,
      legalProfile: "{}",
      configRevision: 1,
      configurationSource: "admin",
      createdByUserId: input.operatorUserId ?? null,
      updatedByUserId: input.operatorUserId ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
      deletedAt: null,
    };
    if (existing) {
      await trx(COMMERCIAL_TENANT_DIRECTORY_TABLE).where({ id: tenantId }).update(row);
    } else {
      await trx(COMMERCIAL_TENANT_DIRECTORY_TABLE).insert(row);
    }
    return rowToRecord(row);
  });
  // R8：缓存失效必须发生在事务成功提交后。
  resetTenantRuntimeSnapshotCache();
  return record;
}

/**
 * 更新商业租户基础字段（乐观锁 configRevision）。
 * R8：通用更新不再接受 status —— 生命周期变更只能走专用命令
 * （activate/suspend/resume/archive），违反即稳定报错。
 * 更新成功提交后立即失效运行时快照缓存。
 */
export async function updateTenantDirectoryRecord(input: {
  tenantId: string;
  expectedRevision: number;
  name?: string;
  operatorName?: string;
  rechargeEnabled?: boolean;
  settlementRequired?: boolean;
  wholesaleRatePpm?: number;
  status?: never;
  operatorUserId?: number | null;
}): Promise<TenantDirectoryRecord> {
  if (input.status !== undefined) {
    throw new TenantDirectoryError(
      "生命周期状态不允许通过通用更新修改，请使用专用命令（activate/suspend/resume/archive）",
      422,
      "TENANT_LIFECYCLE_FIELD_FORBIDDEN",
    );
  }
  const record = await db.transaction(async (trx) => {
    const row = await trx(COMMERCIAL_TENANT_DIRECTORY_TABLE)
      .where({ id: String(input.tenantId || "").trim().toUpperCase() })
      .whereNull("deletedAt")
      .forUpdate()
      .first();
    if (!row) throw new TenantDirectoryError("商业租户不存在", 404, "TENANT_NOT_FOUND");
    const current = rowToRecord(row);
    if (current.configRevision !== input.expectedRevision) {
      throw new TenantDirectoryError("租户配置已被其他管理员更新，请刷新后重试", 409, "TENANT_REVISION_CONFLICT");
    }
    const patch: Record<string, unknown> = {
      configRevision: current.configRevision + 1,
      updatedByUserId: input.operatorUserId ?? null,
      updatedAt: Date.now(),
      configurationSource: "admin",
    };
    if (input.name !== undefined) {
      const name = String(input.name).trim();
      if (!name || name.length > 128) throw new TenantDirectoryError("租户名称无效", 422, "TENANT_NAME_INVALID");
      patch.name = name;
    }
    if (input.operatorName !== undefined) {
      const operatorName = String(input.operatorName).trim();
      if (!operatorName || operatorName.length > 256) {
        throw new TenantDirectoryError("运营主体名称无效", 422, "TENANT_OPERATOR_NAME_INVALID");
      }
      patch.operatorName = operatorName;
    }
    if (input.rechargeEnabled !== undefined) patch.rechargeEnabled = Boolean(input.rechargeEnabled);
    if (input.settlementRequired !== undefined) patch.settlementRequired = Boolean(input.settlementRequired);
    if (input.wholesaleRatePpm !== undefined) {
      const rate = Number(input.wholesaleRatePpm);
      if (!Number.isSafeInteger(rate) || rate < 0 || rate > 1_000_000) {
        throw new TenantDirectoryError("批发结算率必须在 0-1000000 ppm 之间", 422, "TENANT_RATE_INVALID");
      }
      patch.wholesaleRatePpm = rate;
    }
    const affected = await trx(COMMERCIAL_TENANT_DIRECTORY_TABLE)
      .where({ id: current.id, configRevision: current.configRevision })
      .update(patch);
    if (Number(affected || 0) !== 1) {
      throw new TenantDirectoryError("租户配置已被其他管理员更新，请刷新后重试", 409, "TENANT_REVISION_CONFLICT");
    }
    const updated = await trx(COMMERCIAL_TENANT_DIRECTORY_TABLE).where({ id: current.id }).first();
    return rowToRecord(updated);
  });
  // R8：缓存失效必须发生在事务成功提交后。
  resetTenantRuntimeSnapshotCache();
  return record;
}

/**
 * R8 专用激活命令：draft → active。
 * 预检：租户必须至少拥有一个当前通过发布预检的域名，
 * 不允许绕过域名/证书/入口预检直接激活。
 */
export async function activateTenantDirectoryRecord(input: {
  tenantId: string;
  expectedRevision: number;
  reason: string;
  operatorUserId?: number | null;
}): Promise<TenantDirectoryRecord> {
  const reason = String(input.reason || "").trim();
  if (reason.length < 5) {
    throw new TenantDirectoryError("激活原因必填（至少 5 字符）", 422, "TENANT_REASON_REQUIRED");
  }
  const record = await db.transaction(async (trx) => {
    const row = await trx(COMMERCIAL_TENANT_DIRECTORY_TABLE)
      .where({ id: input.tenantId })
      .whereNull("deletedAt")
      .forUpdate()
      .first();
    if (!row) throw new TenantDirectoryError("商业租户不存在", 404, "TENANT_NOT_FOUND");
    const current = rowToRecord(row);
    if (current.configRevision !== input.expectedRevision) {
      throw new TenantDirectoryError("租户配置已被其他管理员更新，请刷新后重试", 409, "TENANT_REVISION_CONFLICT");
    }
    if (current.status !== "draft") {
      throw new TenantDirectoryError("仅草稿状态的租户可以激活", 409, "TENANT_STATE_INVALID");
    }
    // 新域名完成所有权校验后通常处于 verified；ready 是发布失败补偿后的
    // 可重试状态。不能仅凭生命周期标签放行，必须对候选域名执行实时预检。
    const candidateDomains = await trx(TENANT_DOMAIN_TABLE)
      .where({ tenantId: current.id })
      .whereNull("deletedAt")
      .whereIn("lifecycleState", ["verified", "ready", "active"])
      .select("id") as Array<{ id: string }>;
    const { preflightTenantDomain } = await import("@/lib/tenantDomain");
    let passedDomainId: string | null = null;
    const blockers = new Set<string>();
    for (const domain of candidateDomains) {
      const preflight = await preflightTenantDomain({ domainId: String(domain.id), database: trx });
      if (preflight.passed) {
        passedDomainId = String(domain.id);
        break;
      }
      for (const blocker of preflight.blockers) blockers.add(blocker);
    }
    if (!passedDomainId) {
      const detail = blockers.size > 0 ? `（阻断项：${[...blockers].join(", ")}）` : "";
      throw new TenantDirectoryError(
        `激活预检未通过：租户没有当前可发布的域名${detail}`,
        409,
        "TENANT_ACTIVATE_PREFLIGHT_FAILED",
      );
    }
    const timestamp = Date.now();
    const affected = await trx(COMMERCIAL_TENANT_DIRECTORY_TABLE)
      .where({ id: current.id, configRevision: current.configRevision })
      .update({
        status: "active",
        configRevision: current.configRevision + 1,
        updatedByUserId: input.operatorUserId ?? null,
        updatedAt: timestamp,
      });
    if (Number(affected || 0) !== 1) {
      throw new TenantDirectoryError("租户配置已被其他管理员更新，请刷新后重试", 409, "TENANT_REVISION_CONFLICT");
    }
    const updated = await trx(COMMERCIAL_TENANT_DIRECTORY_TABLE).where({ id: current.id }).first();
    return rowToRecord(updated);
  });
  resetTenantRuntimeSnapshotCache();
  return record;
}

// ---------------------------------------------------------------------------
// MT-P1-01：租户完整生命周期（暂停/恢复/归档 + 依赖检查）
// ---------------------------------------------------------------------------

export type TenantLifecycleDependency = {
  code: string;
  detail: string;
  count: number;
};

async function tenantLifecycleDependencies(
  trx: Knex.Transaction,
  tenantId: string,
): Promise<TenantLifecycleDependency[]> {
  const blockers: TenantLifecycleDependency[] = [];
  const activeDomains = await trx(TENANT_DOMAIN_TABLE)
    .where({ tenantId })
    .whereNull("deletedAt")
    .whereIn("lifecycleState", ["active", "activating", "suspending"])
    .count("* as total")
    .first() as { total?: number | string } | undefined;
  if (Number(activeDomains?.total || 0) > 0) {
    blockers.push({
      code: "ACTIVE_DOMAINS",
      detail: "租户仍有生效/激活中的域名，需先暂停或删除全部域名",
      count: Number(activeDomains?.total || 0),
    });
  }
  const openPeriods = await trx("o_tenant_settlement_period")
    .where({ status: "open" })
    .count("* as total")
    .first() as { total?: number | string } | undefined;
  if (Number(openPeriods?.total || 0) > 0) {
    blockers.push({
      code: "OPEN_SETTLEMENT_PERIODS",
      detail: "存在未关账账期，归档前需完成关账",
      count: Number(openPeriods?.total || 0),
    });
  }
  // 仍有未消费现金 GU 批次的用户（该租户为收款方）需要财务确认。
  const activeLots = await trx("o_commercial_credit_lot")
    .where({ collectorTenantId: tenantId, status: "active" })
    .where("remainingMicros", ">", 0)
    .count("* as total")
    .first() as { total?: number | string } | undefined;
  if (Number(activeLots?.total || 0) > 0) {
    blockers.push({
      code: "OUTSTANDING_CREDIT_LOTS",
      detail: "该租户仍有用户未消费的现金 GU 批次（服务负债），退租需财务处置",
      count: Number(activeLots?.total || 0),
    });
  }
  return blockers;
}

/**
 * 暂停商业租户：先逐域名执行可恢复的云端解绑状态机，全部 observed=unbound
 * 后才原子关闭租户与充值。任何域名失败时租户保持 active，父 operation 记录
 * 已完成/失败域名；相同 expectedRevision 重试会继续同一批次，不会伪造全停服。
 */
export async function suspendTenantDirectoryRecord(input: {
  tenantId: string;
  expectedRevision: number;
  reason: string;
  operatorUserId?: number | null;
  orchestrator?: TenantDomainOrchestrator | null;
  env?: NodeJS.ProcessEnv;
}): Promise<{ tenant: TenantDirectoryRecord; domainsSuspended: number; operationId: string }> {
  if (input.tenantId === DEFAULT_COMMERCIAL_TENANT_ID) {
    throw new TenantDirectoryError("平台默认租户不允许暂停", 409, "TENANT_PLATFORM_RESERVED");
  }
  const reason = String(input.reason || "").trim();
  if (reason.length < 5) {
    throw new TenantDirectoryError("暂停原因必填（至少 5 字符）", 422, "TENANT_REASON_REQUIRED");
  }
  const idempotencyKey = `op:tenant_suspend:${input.tenantId}:${input.expectedRevision}`;
  const phase = await db.transaction(async (trx) => {
    const row = await trx(COMMERCIAL_TENANT_DIRECTORY_TABLE)
      .where({ id: input.tenantId })
      .whereNull("deletedAt")
      .forUpdate()
      .first();
    if (!row) throw new TenantDirectoryError("商业租户不存在", 404, "TENANT_NOT_FOUND");
    const current = rowToRecord(row);
    if (current.status === "suspended") {
      const completed = await trx(TENANT_DOMAIN_OPERATION_TABLE)
        .where({ idempotencyKey, operationType: "tenant_suspend", state: "succeeded" })
        .first();
      if (completed) {
        let result: any = {};
        try { result = JSON.parse(String(completed.result || "{}")); } catch { result = {}; }
        return {
          tenant: current,
          operationId: String(completed.id),
          domainIds: Array.isArray(result.domainIds) ? result.domainIds.map(String) : [],
          alreadyCompleted: true,
        };
      }
      throw new TenantDirectoryError("租户已处于暂停状态", 409, "TENANT_STATE_INVALID");
    }
    if (current.status === "archived") {
      throw new TenantDirectoryError("已归档租户不能暂停，请先恢复", 409, "TENANT_STATE_INVALID");
    }
    if (current.configRevision !== input.expectedRevision) {
      throw new TenantDirectoryError("租户配置已被其他管理员更新，请刷新后重试", 409, "TENANT_REVISION_CONFLICT");
    }
    if (current.status !== "active") {
      throw new TenantDirectoryError("仅生效中的租户可以暂停", 409, "TENANT_STATE_INVALID");
    }
    const timestamp = Date.now();
    let operation = await trx(TENANT_DOMAIN_OPERATION_TABLE).where({ idempotencyKey }).first();
    let domainIds: string[] = [];
    if (operation) {
      let persisted: any = {};
      try { persisted = JSON.parse(String(operation.result || "{}")); } catch { persisted = {}; }
      domainIds = Array.isArray(persisted.domainIds) ? persisted.domainIds.map(String) : [];
      if (!domainIds.length && operation.state !== "succeeded") {
        throw new TenantDirectoryError(
          "租户暂停 checkpoint 损坏，拒绝继续",
          409,
          "TENANT_SUSPEND_CHECKPOINT_INVALID",
        );
      }
      await trx(TENANT_DOMAIN_OPERATION_TABLE).where({ id: operation.id }).update({
        state: "running",
        currentStep: "suspend_domains",
        attemptCount: trx.raw("attemptCount + 1"),
        errorCode: null,
        errorMessage: null,
        finishedAt: null,
        updatedAt: timestamp,
      });
    } else {
      const domains = await trx(TENANT_DOMAIN_TABLE)
        .where({ tenantId: current.id, lifecycleState: "active" })
        .whereNull("deletedAt")
        .orderBy("createdAt", "asc")
        .select("id") as Array<{ id: string }>;
      domainIds = domains.map((domain) => String(domain.id));
      const operationId = uuid();
      await trx(TENANT_DOMAIN_OPERATION_TABLE).insert({
        id: operationId,
        idempotencyKey,
        tenantId: current.id,
        domainId: null,
        operationType: "tenant_suspend",
        requestedRevision: current.configRevision,
        state: "running",
        currentStep: "suspend_domains",
        attemptCount: 1,
        nextAttemptAt: null,
        requestedByUserId: input.operatorUserId ?? null,
        approvedByUserId: null,
        result: JSON.stringify({ reason, domainIds, completedDomainIds: [] }),
        errorCode: null,
        errorMessage: null,
        createdAt: timestamp,
        startedAt: timestamp,
        finishedAt: null,
        updatedAt: timestamp,
      });
      operation = await trx(TENANT_DOMAIN_OPERATION_TABLE).where({ id: operationId }).first();
    }
    return {
      tenant: current,
      operationId: String(operation.id),
      domainIds,
      alreadyCompleted: false,
    };
  });

  if (phase.alreadyCompleted) {
    return {
      tenant: phase.tenant,
      domainsSuspended: phase.domainIds.length,
      operationId: phase.operationId,
    };
  }

  const completedDomainIds: string[] = [];
  const { suspendTenantDomain } = await import("@/lib/tenantDomainOrchestration");
  for (const domainId of phase.domainIds) {
    try {
      const domain = await suspendTenantDomain({
        domainId,
        operatorUserId: input.operatorUserId,
        orchestrator: input.orchestrator,
        env: input.env,
      });
      if (domain.lifecycleState !== "suspended") {
        throw new TenantDirectoryError(
          "域名暂停状态未收敛",
          502,
          "TENANT_DOMAIN_SUSPEND_NOT_OBSERVED",
        );
      }
      completedDomainIds.push(domainId);
      await db(TENANT_DOMAIN_OPERATION_TABLE).where({ id: phase.operationId }).update({
        currentStep: `suspend_domain:${domainId}`,
        result: JSON.stringify({ reason, domainIds: phase.domainIds, completedDomainIds }),
        updatedAt: Date.now(),
      });
    } catch (domainError) {
      const failureCode = String((domainError as { code?: unknown })?.code || "TENANT_DOMAIN_SUSPEND_FAILED");
      const timestamp = Date.now();
      await db(TENANT_DOMAIN_OPERATION_TABLE).where({ id: phase.operationId }).update({
        state: "failed",
        currentStep: `suspend_domain:${domainId}`,
        errorCode: failureCode,
        errorMessage: "租户域名暂停未全部完成",
        result: JSON.stringify({
          reason,
          domainIds: phase.domainIds,
          completedDomainIds,
          failedDomainId: domainId,
        }),
        finishedAt: timestamp,
        updatedAt: timestamp,
      });
      resetTenantRuntimeSnapshotCache();
      throw new TenantDirectoryError(
        "租户暂停未全部完成：至少一个域名未确认云端解绑；租户仍保持生效，请修复后以同一 revision 重试",
        502,
        "TENANT_SUSPEND_PARTIAL_FAILURE",
        {
          operationId: phase.operationId,
          completedDomainIds,
          failedDomainId: domainId,
          failureCode,
        },
      );
    }
  }

  let result: TenantDirectoryRecord;
  try {
    result = await db.transaction(async (trx) => {
    const row = await trx(COMMERCIAL_TENANT_DIRECTORY_TABLE)
      .where({ id: input.tenantId })
      .whereNull("deletedAt")
      .forUpdate()
      .first();
    if (!row) throw new TenantDirectoryError("商业租户不存在", 404, "TENANT_NOT_FOUND");
    const current = rowToRecord(row);
    if (current.status === "suspended" && current.configRevision === input.expectedRevision + 1) {
      return current;
    }
    if (current.status !== "active" || current.configRevision !== input.expectedRevision) {
      throw new TenantDirectoryError(
        "域名已暂停，但租户配置同时被修改；请刷新后重试租户收口",
        409,
        "TENANT_REVISION_CONFLICT_AFTER_DOMAIN_SUSPEND",
        { operationId: phase.operationId, completedDomainIds },
      );
    }
    const remaining = await trx(TENANT_DOMAIN_TABLE)
      .whereIn("id", phase.domainIds)
      .whereNot({ lifecycleState: "suspended" })
      .whereNull("deletedAt")
      .select("id", "lifecycleState");
    if (remaining.length) {
      throw new TenantDirectoryError(
        "域名暂停状态尚未全部收敛",
        502,
        "TENANT_DOMAIN_SUSPEND_NOT_OBSERVED",
        { operationId: phase.operationId, remaining },
      );
    }
    const timestamp = Date.now();
    const affected = await trx(COMMERCIAL_TENANT_DIRECTORY_TABLE)
      .where({ id: current.id, status: "active", configRevision: current.configRevision })
      .update({
        status: "suspended",
        rechargeEnabled: false,
        configRevision: current.configRevision + 1,
        updatedByUserId: input.operatorUserId ?? null,
        updatedAt: timestamp,
      });
    if (Number(affected || 0) !== 1) {
      throw new TenantDirectoryError("租户配置已被其他管理员更新，请刷新后重试", 409, "TENANT_REVISION_CONFLICT");
    }
    await trx(TENANT_DOMAIN_OPERATION_TABLE).where({ id: phase.operationId }).update({
      state: "succeeded",
      currentStep: null,
      errorCode: null,
      errorMessage: null,
      result: JSON.stringify({ reason, domainIds: phase.domainIds, completedDomainIds }),
      finishedAt: timestamp,
      updatedAt: timestamp,
    });
    return rowToRecord(await trx(COMMERCIAL_TENANT_DIRECTORY_TABLE).where({ id: current.id }).first());
    });
  } catch (error) {
    const timestamp = Date.now();
    const failureCode = String((error as { code?: unknown })?.code || "TENANT_SUSPEND_FINALIZE_FAILED");
    await db(TENANT_DOMAIN_OPERATION_TABLE).where({ id: phase.operationId }).update({
      state: "failed",
      currentStep: "finalize_tenant",
      errorCode: failureCode,
      errorMessage: String((error as Error)?.message || "租户暂停最终收口失败"),
      result: JSON.stringify({ reason, domainIds: phase.domainIds, completedDomainIds }),
      finishedAt: timestamp,
      updatedAt: timestamp,
    });
    resetTenantRuntimeSnapshotCache();
    throw error;
  }
  // R8：缓存失效必须发生在事务成功提交后。
  resetTenantRuntimeSnapshotCache();
  return {
    tenant: result,
    domainsSuspended: completedDomainIds.length,
    operationId: phase.operationId,
  };
}

/**
 * 恢复已暂停的商业租户（域名保持 suspended，由域名管理单独恢复并重新预检）。
 */
export async function resumeTenantDirectoryRecord(input: {
  tenantId: string;
  expectedRevision: number;
  reason: string;
  operatorUserId?: number | null;
}): Promise<TenantDirectoryRecord> {
  const reason = String(input.reason || "").trim();
  if (reason.length < 5) {
    throw new TenantDirectoryError("恢复原因必填（至少 5 字符）", 422, "TENANT_REASON_REQUIRED");
  }
  const record = await db.transaction(async (trx) => {
    const row = await trx(COMMERCIAL_TENANT_DIRECTORY_TABLE)
      .where({ id: input.tenantId })
      .whereNull("deletedAt")
      .forUpdate()
      .first();
    if (!row) throw new TenantDirectoryError("商业租户不存在", 404, "TENANT_NOT_FOUND");
    const current = rowToRecord(row);
    if (current.status !== "suspended") {
      throw new TenantDirectoryError("仅已暂停的租户可以恢复", 409, "TENANT_STATE_INVALID");
    }
    if (current.configRevision !== input.expectedRevision) {
      throw new TenantDirectoryError("租户配置已被其他管理员更新，请刷新后重试", 409, "TENANT_REVISION_CONFLICT");
    }
    const timestamp = Date.now();
    const affected = await trx(COMMERCIAL_TENANT_DIRECTORY_TABLE)
      .where({ id: current.id, configRevision: current.configRevision })
      .update({
        status: "active",
        configRevision: current.configRevision + 1,
        updatedByUserId: input.operatorUserId ?? null,
        updatedAt: timestamp,
      });
    if (Number(affected || 0) !== 1) {
      throw new TenantDirectoryError("租户配置已被其他管理员更新，请刷新后重试", 409, "TENANT_REVISION_CONFLICT");
    }
    const updated = await trx(COMMERCIAL_TENANT_DIRECTORY_TABLE).where({ id: current.id }).first();
    return rowToRecord(updated);
  });
  // R8：缓存失效必须发生在事务成功提交后。
  resetTenantRuntimeSnapshotCache();
  return record;
}

/**
 * MT-P1-10 退租流程：归档商业租户。
 * 依赖检查：无生效域名、无未关账账期、无未消费现金 GU 批次。
 * 归档后禁止新增域名与收款；全局用户数据永不删除。
 */
export async function archiveTenantDirectoryRecord(input: {
  tenantId: string;
  expectedRevision: number;
  reason: string;
  operatorUserId?: number | null;
  audit?: (result: { tenantId: string; blockers: TenantLifecycleDependency[]; archived: boolean }, trx: Knex.Transaction) => Promise<void>;
}): Promise<{ tenant: TenantDirectoryRecord; blockers: TenantLifecycleDependency[] }> {
  if (input.tenantId === DEFAULT_COMMERCIAL_TENANT_ID) {
    throw new TenantDirectoryError("平台默认租户不允许归档", 409, "TENANT_PLATFORM_RESERVED");
  }
  const reason = String(input.reason || "").trim();
  if (reason.length < 5) {
    throw new TenantDirectoryError("归档原因必填（至少 5 字符）", 422, "TENANT_REASON_REQUIRED");
  }
  const result = await db.transaction(async (trx) => {
    const row = await trx(COMMERCIAL_TENANT_DIRECTORY_TABLE)
      .where({ id: input.tenantId })
      .whereNull("deletedAt")
      .forUpdate()
      .first();
    if (!row) throw new TenantDirectoryError("商业租户不存在", 404, "TENANT_NOT_FOUND");
    const current = rowToRecord(row);
    if (current.status === "archived") {
      // 幂等：已归档直接返回。
      return { tenant: current, blockers: [] };
    }
    if (current.configRevision !== input.expectedRevision) {
      throw new TenantDirectoryError("租户配置已被其他管理员更新，请刷新后重试", 409, "TENANT_REVISION_CONFLICT");
    }
    const blockers = await tenantLifecycleDependencies(trx, current.id);
    if (input.audit) {
      await input.audit({ tenantId: current.id, blockers, archived: blockers.length === 0 }, trx);
    }
    if (blockers.length) {
      throw new TenantDirectoryError(
        `归档预检未通过：${blockers.map((blocker) => blocker.code).join(", ")}`,
        409,
        "TENANT_ARCHIVE_PREFLIGHT_FAILED",
      );
    }
    const timestamp = Date.now();
    const affected = await trx(COMMERCIAL_TENANT_DIRECTORY_TABLE)
      .where({ id: current.id, configRevision: current.configRevision })
      .update({
        status: "archived",
        rechargeEnabled: false,
        configRevision: current.configRevision + 1,
        updatedByUserId: input.operatorUserId ?? null,
        updatedAt: timestamp,
      });
    if (Number(affected || 0) !== 1) {
      throw new TenantDirectoryError("租户配置已被其他管理员更新，请刷新后重试", 409, "TENANT_REVISION_CONFLICT");
    }
    const updated = await trx(COMMERCIAL_TENANT_DIRECTORY_TABLE).where({ id: current.id }).first();
    return { tenant: rowToRecord(updated), blockers: [] };
  });
  // R8：缓存失效必须发生在事务成功提交后。
  resetTenantRuntimeSnapshotCache();
  return result;
}

// ---------------------------------------------------------------------------
// MT-P1-04/06：品牌配置与告警联系人
// ---------------------------------------------------------------------------

export type TenantBrandConfig = {
  theme: string | null;
  logoUrl: string | null;
  customerServiceEmail: string | null;
  customerServiceUrl: string | null;
  agreementVersion: string | null;
  alertContacts: string[];
};

const BRAND_KEY = "brand";

function readBrandConfig(row: any): TenantBrandConfig {
  let parsed: any = {};
  try {
    parsed = JSON.parse(String(row?.legalProfile || "{}"));
  } catch {
    parsed = {};
  }
  const brand = parsed && typeof parsed === "object" ? parsed[BRAND_KEY] : null;
  const contacts = Array.isArray(brand?.alertContacts)
    ? brand.alertContacts.map((item: unknown) => String(item).trim()).filter(Boolean)
    : [];
  return {
    theme: brand?.theme ? String(brand.theme) : null,
    logoUrl: brand?.logoUrl ? String(brand.logoUrl) : null,
    customerServiceEmail: brand?.customerServiceEmail ? String(brand.customerServiceEmail) : null,
    customerServiceUrl: brand?.customerServiceUrl ? String(brand.customerServiceUrl) : null,
    agreementVersion: brand?.agreementVersion ? String(brand.agreementVersion) : null,
    alertContacts: contacts,
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * 更新租户品牌与告警联系人（乐观锁）。
 * 品牌字段存于 legalProfile JSON 的 brand 键；联系人邮箱格式校验。
 */
export async function updateTenantBrandConfig(input: {
  tenantId: string;
  expectedRevision: number;
  theme?: string | null;
  logoUrl?: string | null;
  customerServiceEmail?: string | null;
  customerServiceUrl?: string | null;
  agreementVersion?: string | null;
  alertContacts?: string[];
  operatorUserId?: number | null;
}): Promise<{ tenant: TenantDirectoryRecord; brand: TenantBrandConfig }> {
  if (input.alertContacts) {
    for (const contact of input.alertContacts) {
      if (!EMAIL_RE.test(String(contact).trim())) {
        throw new TenantDirectoryError(`告警联系人邮箱无效：${contact}`, 422, "TENANT_ALERT_CONTACT_INVALID");
      }
    }
  }
  if (input.customerServiceEmail && !EMAIL_RE.test(input.customerServiceEmail)) {
    throw new TenantDirectoryError("客服邮箱格式无效", 422, "TENANT_BRAND_INVALID");
  }
  const record = await db.transaction(async (trx) => {
    const row = await trx(COMMERCIAL_TENANT_DIRECTORY_TABLE)
      .where({ id: input.tenantId })
      .whereNull("deletedAt")
      .forUpdate()
      .first();
    if (!row) throw new TenantDirectoryError("商业租户不存在", 404, "TENANT_NOT_FOUND");
    const current = rowToRecord(row);
    if (current.configRevision !== input.expectedRevision) {
      throw new TenantDirectoryError("租户配置已被其他管理员更新，请刷新后重试", 409, "TENANT_REVISION_CONFLICT");
    }
    let profile: Record<string, unknown> = {};
    try {
      profile = JSON.parse(String(row.legalProfile || "{}"));
    } catch {
      profile = {};
    }
    const existingBrand = readBrandConfig(row);
    const nextBrand: TenantBrandConfig = {
      theme: input.theme !== undefined ? (input.theme ? String(input.theme).slice(0, 64) : null) : existingBrand.theme,
      logoUrl: input.logoUrl !== undefined ? (input.logoUrl ? String(input.logoUrl).slice(0, 512) : null) : existingBrand.logoUrl,
      customerServiceEmail: input.customerServiceEmail !== undefined
        ? (input.customerServiceEmail ? String(input.customerServiceEmail).slice(0, 254) : null)
        : existingBrand.customerServiceEmail,
      customerServiceUrl: input.customerServiceUrl !== undefined
        ? (input.customerServiceUrl ? String(input.customerServiceUrl).slice(0, 512) : null)
        : existingBrand.customerServiceUrl,
      agreementVersion: input.agreementVersion !== undefined
        ? (input.agreementVersion ? String(input.agreementVersion).slice(0, 64) : null)
        : existingBrand.agreementVersion,
      alertContacts: input.alertContacts !== undefined ? input.alertContacts.map((item) => String(item).trim()) : existingBrand.alertContacts,
    };
    profile[BRAND_KEY] = nextBrand;
    const timestamp = Date.now();
    const affected = await trx(COMMERCIAL_TENANT_DIRECTORY_TABLE)
      .where({ id: current.id, configRevision: current.configRevision })
      .update({
        legalProfile: JSON.stringify(profile),
        configRevision: current.configRevision + 1,
        updatedByUserId: input.operatorUserId ?? null,
        updatedAt: timestamp,
      });
    if (Number(affected || 0) !== 1) {
      throw new TenantDirectoryError("租户配置已被其他管理员更新，请刷新后重试", 409, "TENANT_REVISION_CONFLICT");
    }
    const updated = await trx(COMMERCIAL_TENANT_DIRECTORY_TABLE).where({ id: current.id }).first();
    return { tenant: rowToRecord(updated), brand: readBrandConfig(updated) };
  });
  // R8：品牌/Host 相关配置变更提交后立即失效运行时快照缓存。
  resetTenantRuntimeSnapshotCache();
  return record;
}

export async function readTenantBrandConfig(
  database: DirectoryDb,
  tenantId: string,
): Promise<TenantBrandConfig> {
  const row = await (database as any)(COMMERCIAL_TENANT_DIRECTORY_TABLE)
    .where({ id: tenantId })
    .whereNull("deletedAt")
    .first();
  if (!row) throw new TenantDirectoryError("商业租户不存在", 404, "TENANT_NOT_FOUND");
  return readBrandConfig(row);
}

// ---------------------------------------------------------------------------
// 运行时租户快照（数据库权威模式下的 Host 解析）
// ---------------------------------------------------------------------------

export type TenantRuntimeSnapshot = {
  revision: string;
  loadedAt: number;
  tenants: Array<{
    id: string;
    name: string;
    operatorName: string;
    status: string;
    rechargeEnabled: boolean;
    settlementRequired: boolean;
    wholesaleRatePpm: number;
    hosts: string[];
  }>;
};

type SnapshotCache = {
  snapshot: TenantRuntimeSnapshot | null;
  loading: Promise<TenantRuntimeSnapshot> | null;
};

const snapshotCache: SnapshotCache = { snapshot: null, loading: null };
// 多节点域名发布必须在公网 smoke 窗口内观察到同一 DB revision。进程本地
// 缓存仅保留 1 秒，避免某个 API 节点把旧 Host 清单继续服务 30 秒。
const SNAPSHOT_TTL_MS = 1_000;

/**
 * 读取已发布租户运行时快照：
 * - active 租户 + 其 active 域名作为 hosts
 * - activating 域名仅在 ALB binding 已回读 observed=bound 后进入暂存快照，
 *   供公网 smoke 验证；失败补偿后会立即从快照剔除
 * - 数据库目录为空时回退环境变量（首次部署/紧急回退）
 * - 进程内缓存 1 秒；configRevision 变化后自然过期
 */
export async function loadTenantRuntimeSnapshot(database: DirectoryDb = db): Promise<TenantRuntimeSnapshot> {
  const cached = snapshotCache.snapshot;
  if (cached && Date.now() - cached.loadedAt < SNAPSHOT_TTL_MS) return cached;
  if (snapshotCache.loading) return snapshotCache.loading;
  const pending = (async () => {
    const tenantRows = await (database as any)(COMMERCIAL_TENANT_DIRECTORY_TABLE)
      .whereNull("deletedAt")
      .whereIn("status", ["active"]);
    const domainRows = await (database as any)(`${TENANT_DOMAIN_TABLE} as domain`)
      .leftJoin("o_tenant_ingress_binding as binding", "binding.domainId", "domain.id")
      .whereNull("domain.deletedAt")
      .where((query: any) => query
        .where("domain.lifecycleState", "active")
        .orWhere((staged: any) => staged
          .where("domain.lifecycleState", "activating")
          .where("binding.desiredState", "bound")
          .where("binding.observedState", "bound")))
      .select(
        "domain.id",
        "domain.tenantId",
        "domain.hostname",
        "domain.lifecycleState",
        "domain.desiredRevision",
        "domain.observedRevision",
      );
    const hostsByTenant = new Map<string, string[]>();
    for (const row of domainRows) {
      const tenantId = String(row.tenantId);
      const host = normalizeCommercialHost(row.hostname);
      if (!host) continue;
      hostsByTenant.set(tenantId, [...(hostsByTenant.get(tenantId) || []), host]);
    }
    const tenants = tenantRows.map((row: any) => ({
      id: String(row.id),
      name: String(row.name),
      operatorName: String(row.operatorName),
      status: String(row.status),
      rechargeEnabled: Boolean(row.rechargeEnabled),
      settlementRequired: Boolean(row.settlementRequired),
      wholesaleRatePpm: Number(row.wholesaleRatePpm || 1_000_000),
      hosts: hostsByTenant.get(String(row.id)) || [],
    }));
    if (!tenants.length) {
      // 目录为空：回退环境变量租户（保持兼容）。
      const envTenants = configuredTenantsForImport();
      return {
        revision: `env:${Date.now()}`,
        loadedAt: Date.now(),
        tenants: envTenants.map((tenant) => ({
          id: tenant.id,
          name: tenant.name,
          operatorName: tenant.operatorName,
          status: "active",
          rechargeEnabled: tenant.rechargeEnabled,
          settlementRequired: tenant.settlementRequired,
          wholesaleRatePpm: tenant.wholesaleRatePpm,
          hosts: tenant.hosts,
        })),
      } satisfies TenantRuntimeSnapshot;
    }
    const revision = [
      ...tenantRows.map((row: any) => `tenant:${row.id}:${row.configRevision}`),
      ...domainRows.map((row: any) => `${row.id}:${row.desiredRevision}:${row.lifecycleState}:${row.observedRevision}`),
    ]
      .sort()
      .join("|");
    return {
      revision: `db:${revision}`,
      loadedAt: Date.now(),
      tenants,
    } satisfies TenantRuntimeSnapshot;
  })();
  snapshotCache.loading = pending;
  try {
    const snapshot = await pending;
    snapshotCache.snapshot = snapshot;
    return snapshot;
  } finally {
    snapshotCache.loading = null;
  }
}

/** 测试辅助：清空运行时快照缓存。 */
export function resetTenantRuntimeSnapshotCache(): void {
  snapshotCache.snapshot = null;
  snapshotCache.loading = null;
}

/**
 * 基于快照的 Host 解析（数据库权威模式）：
 * - 匹配 active 租户的 active 域名
 * - 未知 Host 在严格模式下 421 fail-closed，绝不回退默认租户
 * - 非严格模式回退默认租户（兼容期）
 */
export function resolveTenantFromSnapshot(
  snapshot: TenantRuntimeSnapshot,
  host: unknown,
  env: NodeJS.ProcessEnv = process.env,
): CommercialTenant {
  const normalizedHost = normalizeCommercialHost(host);
  const matched = snapshot.tenants.find((tenant) => tenant.hosts.includes(normalizedHost));
  if (matched) {
    return {
      id: matched.id,
      name: matched.name,
      operatorName: matched.operatorName,
      hosts: matched.hosts,
      icpNumber: null,
      valueAddedTelecomLicense: null,
      publicSecurityRegistration: null,
      customerServiceEmail: null,
      rechargeEnabled: matched.rechargeEnabled,
      settlementRequired: matched.settlementRequired,
      wholesaleRatePpm: matched.wholesaleRatePpm,
    };
  }
  const local = normalizedHost === "localhost" || normalizedHost === "127.0.0.1" || normalizedHost === "::1";
  if (!local && env.FANJIN_TENANT_STRICT_HOSTS === "1") {
    throw new CommercialTenantError("当前访问域名未登记", 421, "TENANT_HOST_UNKNOWN");
  }
  const fallbackId = env.FANJIN_DEFAULT_COMMERCIAL_TENANT_ID || DEFAULT_COMMERCIAL_TENANT_ID;
  const fallback = snapshot.tenants.find((tenant) => tenant.id === fallbackId)
    || snapshot.tenants.find((tenant) => tenant.hosts.length > 0 && tenant.hosts.includes(normalizedHost));
  if (!fallback) {
    throw new CommercialTenantError("当前访问域名未登记", 421, "TENANT_HOST_UNKNOWN");
  }
  return {
    id: fallback.id,
    name: fallback.name,
    operatorName: fallback.operatorName,
    hosts: fallback.hosts,
    icpNumber: null,
    valueAddedTelecomLicense: null,
    publicSecurityRegistration: null,
    customerServiceEmail: null,
    rechargeEnabled: fallback.rechargeEnabled,
    settlementRequired: fallback.settlementRequired,
    wholesaleRatePpm: fallback.wholesaleRatePpm,
  };
}

export { uuid };

// ---------------------------------------------------------------------------
// 运行时中间件：按目录模式解析 Host（设计文档 §15.1/§15.2）
// ---------------------------------------------------------------------------

import type { RequestHandler } from "express";
import {
  CommercialTenantError as _CommercialTenantError,
  resolveCommercialTenant,
} from "@/lib/commercialTenant";

/**
 * 0.1.4 商业租户上下文中间件：
 * - env 模式（默认）：沿用 0.1.3 同步环境变量解析，行为完全兼容
 * - db 模式：读取数据库运行时快照（active 租户 + active 域名），
 *   未知 Host 严格模式 421 fail-closed，绝不回退到默认租户
 * 响应头 X-Fanjin-Commercial-Tenant 保持不变。
 */
export const commercialTenantContextMiddlewareV2: RequestHandler = async (req, res, next) => {
  try {
    let tenant;
    if (tenantDirectoryMode() === "db") {
      const snapshot = await loadTenantRuntimeSnapshot();
      tenant = resolveTenantFromSnapshot(snapshot, req.hostname || req.headers.host);
      (req as any).tenantRuntimeSnapshotRevision = snapshot.revision;
      res.setHeader("X-Fanjin-Tenant-Snapshot-Revision", snapshot.revision);
    } else {
      tenant = resolveCommercialTenant(req.hostname || req.headers.host);
    }
    (req as any).commercialTenant = tenant;
    res.setHeader("X-Fanjin-Commercial-Tenant", tenant.id);
    next();
  } catch (error) {
    if (error instanceof _CommercialTenantError || error instanceof TenantDirectoryError) {
      const status = (error as any).status || 421;
      return res.status(status).send({ message: error.message, code: (error as any).code });
    }
    next(error);
  }
};
