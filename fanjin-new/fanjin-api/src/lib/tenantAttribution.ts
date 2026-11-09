import type { Knex } from "knex";
import { v4 as uuid } from "uuid";

import { db } from "@/utils/db";
import {
  DEFAULT_COMMERCIAL_TENANT_ID,
  normalizeCommercialHost,
  runtimeCommercialTenantById,
  settlementV2Mode,
} from "@/lib/commercialTenant";

export { settlementV2Mode };
export type { SettlementV2Mode } from "@/lib/commercialTenant";

export const USER_COMMERCIAL_PROFILE_TABLE = "o_user_commercial_profile";
export const USER_TENANT_ATTRIBUTION_HISTORY_TABLE = "o_user_tenant_attribution_history";
export const CONSUMPTION_ALLOCATION_TABLE = "o_commercial_consumption_allocation";
export const PROVIDER_COST_LEDGER_TABLE = "o_provider_cost_ledger";
export const TENANT_SETTLEMENT_PERIOD_TABLE = "o_tenant_settlement_period";

export type RegistrationSource = "public_signup" | "admin_create" | "import" | "legacy_default";

export type UserTenantAttribution = {
  userId: number;
  registeredTenantId: string;
  registrationHostname: string | null;
  registrationSource: RegistrationSource;
  ownerTenantId: string;
  ownerTenantRevision: number;
  ownerTenantChangedAt: number | null;
  ownerTenantChangedByUserId: number | null;
  ownerTenantChangeReason: string | null;
};

export class TenantAttributionError extends Error {
  status: number;
  code: string;

  constructor(message: string, status = 400, code = "TENANT_ATTRIBUTION_ERROR") {
    super(message);
    this.name = "TenantAttributionError";
    this.status = status;
    this.code = code;
  }
}

type AttributionDb = Knex | Knex.Transaction;

const VALID_SOURCES: RegistrationSource[] = ["public_signup", "admin_create", "import", "legacy_default"];

export function isConsumptionAllocationRecordingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return settlementV2Mode(env) !== "off";
}

function normalizeTenantId(value: unknown, field: string): string {
  const id = String(value || "").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_-]{1,63}$/.test(id)) {
    throw new TenantAttributionError(`${field} 无效`, 422, "ATTRIBUTION_TENANT_INVALID");
  }
  return id;
}

function normalizeRegistrationSource(value: unknown): RegistrationSource {
  const source = String(value || "").trim();
  if (VALID_SOURCES.includes(source as RegistrationSource)) return source as RegistrationSource;
  throw new TenantAttributionError("注册来源无效", 422, "ATTRIBUTION_SOURCE_INVALID");
}

function normalizeRegistrationHostname(value: unknown): string | null {
  const host = normalizeCommercialHost(value);
  return host || null;
}

function attributionFromRow(row: any): UserTenantAttribution {
  return {
    userId: Number(row.userId),
    registeredTenantId: String(row.registeredTenantId || DEFAULT_COMMERCIAL_TENANT_ID),
    registrationHostname: row.registrationHostname ? String(row.registrationHostname) : null,
    registrationSource: (String(row.registrationSource || "legacy_default") as RegistrationSource),
    ownerTenantId: String(row.ownerTenantId || row.registeredTenantId || DEFAULT_COMMERCIAL_TENANT_ID),
    ownerTenantRevision: Number(row.ownerTenantRevision || 1),
    ownerTenantChangedAt: row.ownerTenantChangedAt == null ? null : Number(row.ownerTenantChangedAt),
    ownerTenantChangedByUserId: row.ownerTenantChangedByUserId == null ? null : Number(row.ownerTenantChangedByUserId),
    ownerTenantChangeReason: row.ownerTenantChangeReason ? String(row.ownerTenantChangeReason) : null,
  };
}

/**
 * 注册链路写入用户归属（幂等）。
 * - registeredTenantId / registrationHostname / registrationSource 不可变：已存在且不同则拒绝。
 * - ownerTenantId 初始等于 registeredTenantId，ownerTenantRevision 从 1 开始。
 */
export async function ensureUserAttributionInTransaction(
  trx: AttributionDb,
  userId: number,
  input: {
    registeredTenantId: string;
    registrationHostname?: string | null;
    registrationSource: RegistrationSource;
  },
): Promise<UserTenantAttribution> {
  const normalizedUserId = Number(userId);
  if (!Number.isSafeInteger(normalizedUserId) || normalizedUserId <= 0) {
    throw new TenantAttributionError("用户 ID 无效", 422, "ATTRIBUTION_USER_INVALID");
  }
  const registeredTenantId = normalizeTenantId(input.registeredTenantId, "注册租户");
  await runtimeCommercialTenantById(trx, registeredTenantId);
  const registrationSource = normalizeRegistrationSource(input.registrationSource);
  const registrationHostname = normalizeRegistrationHostname(input.registrationHostname);

  const existing = await (trx as any)(USER_COMMERCIAL_PROFILE_TABLE).where({ userId: normalizedUserId }).first();
  if (existing) {
    const existingRegistered = String(existing.registeredTenantId || "").trim().toUpperCase();
    if (existingRegistered && existingRegistered !== registeredTenantId) {
      throw new TenantAttributionError("注册租户不可修改", 409, "ATTRIBUTION_IMMUTABLE_REGISTRATION");
    }
    const existingSource = String(existing.registrationSource || "").trim();
    if (existingSource && existingSource !== registrationSource) {
      throw new TenantAttributionError("注册来源不可修改", 409, "ATTRIBUTION_IMMUTABLE_REGISTRATION");
    }
    if (existingRegistered) return attributionFromRow(existing);
    // 旧数据缺归属字段：补齐不可变注册信息，不动 owner 侧。
    const patch: Record<string, unknown> = {
      registeredTenantId,
      registrationSource,
      registrationHostname,
      updatedAt: Date.now(),
    };
    if (!String(existing.ownerTenantId || "").trim()) {
      patch.ownerTenantId = registeredTenantId;
    }
    const affected = await (trx as any)(USER_COMMERCIAL_PROFILE_TABLE)
      .where({ userId: normalizedUserId })
      .update(patch);
    if (Number(affected || 0) !== 1) {
      throw new TenantAttributionError("用户归属更新失败，请重试", 409, "ATTRIBUTION_UPDATE_CONFLICT");
    }
    const row = await (trx as any)(USER_COMMERCIAL_PROFILE_TABLE).where({ userId: normalizedUserId }).first();
    return attributionFromRow(row);
  }

  const timestamp = Date.now();
  try {
    await (trx as any)(USER_COMMERCIAL_PROFILE_TABLE).insert({
      id: String(normalizedUserId),
      userId: normalizedUserId,
      accountType: "personal",
      commercialGroup: "default",
      pricingGroup: null,
      rechargeDiscountBps: 10000,
      billingMode: "prepaid",
      settlementType: "online",
      notes: null,
      registeredTenantId,
      registrationHostname,
      registrationSource,
      ownerTenantId: registeredTenantId,
      ownerTenantRevision: 1,
      ownerTenantChangedAt: null,
      ownerTenantChangedByUserId: null,
      ownerTenantChangeReason: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  } catch (error) {
    // 并发注册兜底：行已被创建时读取并校验。
    const row = await (trx as any)(USER_COMMERCIAL_PROFILE_TABLE).where({ userId: normalizedUserId }).first();
    if (!row) throw error;
    return attributionFromRow(row);
  }
  const row = await (trx as any)(USER_COMMERCIAL_PROFILE_TABLE).where({ userId: normalizedUserId }).first();
  if (!row) throw new TenantAttributionError("用户归属写入失败", 500, "ATTRIBUTION_WRITE_FAILED");
  return attributionFromRow(row);
}

export async function readUserAttribution(
  database: AttributionDb,
  userId: number,
): Promise<UserTenantAttribution> {
  const row = await (database as any)(USER_COMMERCIAL_PROFILE_TABLE).where({ userId: Number(userId) }).first();
  if (!row) {
    return {
      userId: Number(userId),
      registeredTenantId: DEFAULT_COMMERCIAL_TENANT_ID,
      registrationHostname: null,
      registrationSource: "legacy_default",
      ownerTenantId: DEFAULT_COMMERCIAL_TENANT_ID,
      ownerTenantRevision: 0,
      ownerTenantChangedAt: null,
      ownerTenantChangedByUserId: null,
      ownerTenantChangeReason: null,
    };
  }
  return attributionFromRow(row);
}

/**
 * 平台管理员修改用户当前所属租户。
 * - 乐观锁：expectedRevision 必须与当前 ownerTenantRevision 一致。
 * - 必填原因；写入不可变历史记录。
 * - 不移动余额、工作区、项目、素材或任何历史账单。
 */
export async function changeUserOwnerTenant(input: {
  userId: number;
  ownerTenantId: string;
  expectedRevision: number;
  reason: string;
  operatorUserId: number;
  audit?: (result: {
    userId: number;
    fromTenantId: string;
    toTenantId: string;
    revision: number;
    reason: string;
  }, trx: Knex.Transaction) => Promise<void>;
}): Promise<{
  userId: number;
  previousTenantId: string;
  ownerTenantId: string;
  ownerTenantRevision: number;
}> {
  const userId = Number(input.userId);
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new TenantAttributionError("用户 ID 无效", 422, "ATTRIBUTION_USER_INVALID");
  }
  const toTenantId = normalizeTenantId(input.ownerTenantId, "目标所属租户");
  await runtimeCommercialTenantById(db, toTenantId);
  const reason = String(input.reason || "").trim();
  if (reason.length < 5 || reason.length > 500) {
    throw new TenantAttributionError("修改原因必填（5-500 字符）", 422, "ATTRIBUTION_REASON_REQUIRED");
  }
  const expectedRevision = Number(input.expectedRevision);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new TenantAttributionError("乐观锁版本号无效", 422, "ATTRIBUTION_REVISION_INVALID");
  }
  const operatorUserId = Number(input.operatorUserId);
  if (!Number.isSafeInteger(operatorUserId) || operatorUserId <= 0) {
    throw new TenantAttributionError("操作者无效", 422, "ATTRIBUTION_OPERATOR_INVALID");
  }

  return await db.transaction(async (trx) => {
    const row = await (trx as any)(USER_COMMERCIAL_PROFILE_TABLE).where({ userId }).forUpdate().first();
    if (!row) {
      throw new TenantAttributionError("用户商业档案不存在", 404, "ATTRIBUTION_PROFILE_MISSING");
    }
    const current = attributionFromRow(row);
    if (current.ownerTenantRevision !== expectedRevision) {
      throw new TenantAttributionError(
        "所属租户已被其他管理员修改，请刷新后重试",
        409,
        "ATTRIBUTION_REVISION_CONFLICT",
      );
    }
    if (current.ownerTenantId === toTenantId) {
      throw new TenantAttributionError("目标所属租户与当前一致", 409, "ATTRIBUTION_UNCHANGED");
    }
    const newRevision = current.ownerTenantRevision + 1;
    const timestamp = Date.now();
    const affected = await (trx as any)(USER_COMMERCIAL_PROFILE_TABLE)
      .where({ userId, ownerTenantRevision: current.ownerTenantRevision })
      .update({
        ownerTenantId: toTenantId,
        ownerTenantRevision: newRevision,
        ownerTenantChangedAt: timestamp,
        ownerTenantChangedByUserId: operatorUserId,
        ownerTenantChangeReason: reason,
        updatedAt: timestamp,
      });
    if (Number(affected || 0) !== 1) {
      throw new TenantAttributionError("所属租户已被其他管理员修改，请刷新后重试", 409, "ATTRIBUTION_REVISION_CONFLICT");
    }
    await (trx as any)(USER_TENANT_ATTRIBUTION_HISTORY_TABLE).insert({
      id: uuid(),
      userId,
      fromTenantId: current.ownerTenantId,
      toTenantId,
      revision: newRevision,
      reason,
      operatorUserId,
      metadata: "{}",
      createdAt: timestamp,
    });
    if (input.audit) {
      await input.audit({
        userId,
        fromTenantId: current.ownerTenantId,
        toTenantId,
        revision: newRevision,
        reason,
      }, trx);
    }
    return {
      userId,
      previousTenantId: current.ownerTenantId,
      ownerTenantId: toTenantId,
      ownerTenantRevision: newRevision,
    };
  });
}

export async function listUserAttributionHistory(
  database: AttributionDb,
  userId: number,
): Promise<Array<{
  id: string;
  userId: number;
  fromTenantId: string;
  toTenantId: string;
  revision: number;
  reason: string;
  operatorUserId: number | null;
  createdAt: number;
}>> {
  const rows = await (database as any)(USER_TENANT_ATTRIBUTION_HISTORY_TABLE)
    .where({ userId: Number(userId) })
    .orderBy("createdAt", "asc");
  return rows.map((row: any) => ({
    id: String(row.id),
    userId: Number(row.userId),
    fromTenantId: String(row.fromTenantId),
    toTenantId: String(row.toTenantId),
    revision: Number(row.revision),
    reason: String(row.reason || ""),
    operatorUserId: row.operatorUserId == null ? null : Number(row.operatorUserId),
    createdAt: Number(row.createdAt),
  }));
}

/**
 * 旧用户归属回填：
 * 已有商业档案但缺 registeredTenantId 的用户，统一补
 * registeredTenantId=FANJIN / registrationSource=legacy_default / hostname=NULL。
 * 返回回填统计用于迁移报告。幂等：已回填用户不会重复处理。
 */
export async function backfillLegacyUserAttribution(
  database: AttributionDb = db,
): Promise<{ scanned: number; backfilled: number; alreadyPresent: number }> {
  const pendingRows = await (database as any)(USER_COMMERCIAL_PROFILE_TABLE)
    .whereNull("registeredTenantId")
    .select("userId");
  let backfilled = 0;
  for (const row of pendingRows) {
    const userId = Number(row.userId);
    const timestamp = Date.now();
    const affected = await (database as any)(USER_COMMERCIAL_PROFILE_TABLE)
      .where({ userId })
      .whereNull("registeredTenantId")
      .update({
        registeredTenantId: DEFAULT_COMMERCIAL_TENANT_ID,
        registrationHostname: null,
        registrationSource: "legacy_default",
        ownerTenantId: (database as any).raw(
          `COALESCE(NULLIF("ownerTenantId", ''), '${DEFAULT_COMMERCIAL_TENANT_ID}')`,
        ),
        updatedAt: timestamp,
      });
    backfilled += Number(affected || 0);
  }
  const total = await (database as any)(USER_COMMERCIAL_PROFILE_TABLE).count("* as total").first();
  const totalUsers = Number(total?.total || 0);
  return {
    scanned: totalUsers,
    backfilled,
    alreadyPresent: Math.max(0, totalUsers - backfilled),
  };
}
