import type { Request, RequestHandler } from "express";
import type { Knex } from "knex";
import { v4 as uuid } from "uuid";

import { db } from "@/utils/db";

export const DEFAULT_COMMERCIAL_TENANT_ID = "FANJIN";
export const QILING_COMMERCIAL_TENANT_ID = "QILING";
export const COMMERCIAL_CREDIT_LOT_TABLE = "o_commercial_credit_lot";
export const TENANT_SETTLEMENT_ACCOUNT_TABLE = "o_tenant_settlement_account";
export const TENANT_SETTLEMENT_LEDGER_TABLE = "o_tenant_settlement_ledger";
export const COMMERCIAL_TENANT_LEGAL_SETTING_PREFIX = "commercialTenant.legal.";

// 0.1.4 数据库租户目录（o_commercial_tenant / o_tenant_domain 归
// tenantDirectory.ts 管理；此处仅作运行时权威查询的私有表名）。
const TENANT_DIRECTORY_TABLE = "o_commercial_tenant";
const TENANT_DIRECTORY_DOMAIN_TABLE = "o_tenant_domain";

export type TenantDirectoryMode = "env" | "db";

export type SettlementV2Mode = "off" | "shadow" | "active";

const RATE_SCALE = 1_000_000;
// Conversion between stored ledger atoms and CNY micros, independent of GU display.
const LEDGER_ATOMS_PER_CNY_MICRO = 1_000;

/**
 * 0.1.4 结算演进模式（单一事实源）：
 * - off: 完全沿用 0.1.3 充值时批发结算（默认，保证兼容）
 * - shadow: 并行记录消费分摊（savepoint 隔离、幂等），不改变正式结算
 * - active: 停止充值时最终消费结算；capture 原子形成消费应计
 */
export function settlementV2Mode(env: NodeJS.ProcessEnv = process.env): SettlementV2Mode {
  const value = String(env.FANJIN_SETTLEMENT_V2_MODE || "").trim().toLowerCase();
  if (value === "shadow" || value === "active") return value;
  return "off";
}

export type CommercialTenant = {
  id: string;
  name: string;
  operatorName: string;
  hosts: string[];
  icpNumber: string | null;
  valueAddedTelecomLicense: string | null;
  publicSecurityRegistration: string | null;
  customerServiceEmail: string | null;
  rechargeEnabled: boolean;
  settlementRequired: boolean;
  wholesaleRatePpm: number;
};

export type CommercialCreditLotAllocation = {
  creditLotId?: string | null;
  sellerTenantId?: string | null;
  amountMicros: number;
};

type TenantConfigInput = Partial<CommercialTenant> & { id: string };
type TenantDb = Knex | Knex.Transaction;

export class CommercialTenantError extends Error {
  status: number;
  code: string;

  constructor(message: string, status = 400, code = "COMMERCIAL_TENANT_ERROR") {
    super(message);
    this.name = "CommercialTenantError";
    this.status = status;
    this.code = code;
  }
}

function cleanTenantId(value: unknown): string {
  const id = String(value || "").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_-]{1,63}$/.test(id)) {
    throw new CommercialTenantError("商业租户 ID 格式无效", 500, "TENANT_CONFIG_INVALID");
  }
  return id;
}

export function normalizeCommercialHost(value: unknown): string {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    return end >= 0 ? raw.slice(1, end) : raw;
  }
  return raw.replace(/:\d+$/, "").replace(/\.$/, "");
}

function normalizeHosts(value: unknown): string[] {
  const values = Array.isArray(value) ? value : String(value || "").split(",");
  return Array.from(new Set(values.map(normalizeCommercialHost).filter(Boolean)));
}

function integerInRange(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function tenantFromInput(input: TenantConfigInput): CommercialTenant {
  const id = cleanTenantId(input.id);
  const isPlatform = id === DEFAULT_COMMERCIAL_TENANT_ID;
  return {
    id,
    name: String(input.name || (isPlatform ? "繁境" : id)).trim(),
    operatorName: String(input.operatorName || input.name || (isPlatform ? "繁境" : id)).trim(),
    hosts: normalizeHosts(input.hosts),
    icpNumber: String(input.icpNumber || "").trim() || null,
    valueAddedTelecomLicense: String(input.valueAddedTelecomLicense || "").trim() || null,
    publicSecurityRegistration: String(input.publicSecurityRegistration || "").trim() || null,
    customerServiceEmail: String(input.customerServiceEmail || "").trim() || null,
    rechargeEnabled: input.rechargeEnabled !== false,
    settlementRequired: input.settlementRequired ?? !isPlatform,
    wholesaleRatePpm: integerInRange(input.wholesaleRatePpm, RATE_SCALE, 0, RATE_SCALE),
  };
}

/**
 * 0.1.4 导出环境变量租户清单，供数据库目录导入与运行时快照回退使用。
 */
export function configuredTenantsForImport(): CommercialTenant[] {
  return configuredTenants();
}

function configuredTenants(): CommercialTenant[] {
  const builtIns: TenantConfigInput[] = [
    {
      id: DEFAULT_COMMERCIAL_TENANT_ID,
      name: "繁境",
      operatorName: process.env.FANJIN_OPERATOR_NAME || "繁境（北京）科技有限公司",
      hosts: normalizeHosts(process.env.FANJIN_TENANT_HOSTS),
      icpNumber: process.env.FANJIN_ICP_NUMBER || "京ICP备2026038668号",
      valueAddedTelecomLicense: process.env.FANJIN_VALUE_ADDED_TELECOM_LICENSE || null,
      publicSecurityRegistration: process.env.FANJIN_PUBLIC_SECURITY_REGISTRATION || null,
      customerServiceEmail: process.env.FANJIN_CUSTOMER_SERVICE_EMAIL || "auth@fanjin.top",
      rechargeEnabled: true,
      settlementRequired: false,
      wholesaleRatePpm: RATE_SCALE,
    },
  ];
  const qilingHosts = normalizeHosts(process.env.QILING_TENANT_HOSTS);
  if (qilingHosts.length) {
    builtIns.push({
      id: QILING_COMMERCIAL_TENANT_ID,
      name: "器灵",
      operatorName: process.env.QILING_OPERATOR_NAME || "器灵",
      hosts: qilingHosts,
      icpNumber: process.env.QILING_ICP_NUMBER || null,
      valueAddedTelecomLicense: process.env.QILING_VALUE_ADDED_TELECOM_LICENSE || null,
      publicSecurityRegistration: process.env.QILING_PUBLIC_SECURITY_REGISTRATION || null,
      customerServiceEmail: process.env.QILING_CUSTOMER_SERVICE_EMAIL || null,
      rechargeEnabled: process.env.QILING_RECHARGE_ENABLED === "1",
      settlementRequired: true,
      wholesaleRatePpm: integerInRange(process.env.QILING_WHOLESALE_RATE_PPM, RATE_SCALE, 0, RATE_SCALE),
    });
  }

  const raw = String(process.env.FANJIN_COMMERCIAL_TENANTS_JSON || "").trim();
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new CommercialTenantError(
        "FANJIN_COMMERCIAL_TENANTS_JSON 不是有效 JSON",
        500,
        "TENANT_CONFIG_INVALID",
      );
    }
    if (!Array.isArray(parsed)) {
      throw new CommercialTenantError(
        "FANJIN_COMMERCIAL_TENANTS_JSON 必须是数组",
        500,
        "TENANT_CONFIG_INVALID",
      );
    }
    builtIns.push(...(parsed as TenantConfigInput[]));
  }

  const byId = new Map<string, TenantConfigInput>();
  for (const input of builtIns) {
    const id = cleanTenantId(input.id);
    const previous = byId.get(id);
    byId.set(id, previous
      ? { ...previous, ...input, id, hosts: input.hosts === undefined ? previous.hosts : input.hosts }
      : { ...input, id });
  }
  return Array.from(byId.values()).map(tenantFromInput);
}

export function listCommercialTenants(): CommercialTenant[] {
  const tenants = configuredTenants();
  const hostOwners = new Map<string, string>();
  for (const tenant of tenants) {
    for (const host of tenant.hosts) {
      const owner = hostOwners.get(host);
      if (owner && owner !== tenant.id) {
        throw new CommercialTenantError(`域名 ${host} 被多个商业租户重复配置`, 500, "TENANT_HOST_CONFLICT");
      }
      hostOwners.set(host, tenant.id);
    }
  }
  return tenants;
}

export function commercialTenantById(id: unknown): CommercialTenant {
  const normalized = cleanTenantId(id);
  const tenant = listCommercialTenants().find((item) => item.id === normalized);
  if (!tenant) throw new CommercialTenantError("商业租户不存在", 404, "TENANT_NOT_FOUND");
  return tenant;
}

export function resolveCommercialTenant(host: unknown): CommercialTenant {
  const normalizedHost = normalizeCommercialHost(host);
  const tenants = listCommercialTenants();
  const matched = tenants.find((tenant) => tenant.hosts.includes(normalizedHost));
  if (matched) return matched;

  const local = normalizedHost === "localhost" || normalizedHost === "127.0.0.1" || normalizedHost === "::1";
  if (!local && process.env.FANJIN_TENANT_STRICT_HOSTS === "1") {
    throw new CommercialTenantError("当前访问域名未登记", 421, "TENANT_HOST_UNKNOWN");
  }
  const fallbackId = process.env.FANJIN_DEFAULT_COMMERCIAL_TENANT_ID || DEFAULT_COMMERCIAL_TENANT_ID;
  return commercialTenantById(fallbackId);
}

// ---------------------------------------------------------------------------
// 0.1.4 统一运行时租户权威查询（R2）
//
// mode=env：沿用同步环境变量解析（0.1.3 行为完全兼容）。
// mode=db：o_commercial_tenant 是唯一权威来源；环境变量仅在
//   - 显式紧急回退开关 FANJIN_TENANT_DIRECTORY_EMERGENCY_ENV_FALLBACK=1，或
//   - 数据库目录整体为空（首次部署 bootstrap，与运行时快照回退语义一致）
// 时作为回退。DB-only 租户绝不因环境变量缺失而报 TENANT_NOT_FOUND。
// ---------------------------------------------------------------------------

export function tenantDirectoryMode(env: NodeJS.ProcessEnv = process.env): TenantDirectoryMode {
  return String(env.FANJIN_TENANT_DIRECTORY_MODE || "").trim().toLowerCase() === "db" ? "db" : "env";
}

export function tenantDirectoryEmergencyEnvFallbackEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return String(env.FANJIN_TENANT_DIRECTORY_EMERGENCY_ENV_FALLBACK || "").trim() === "1";
}

function runtimeTenantFromDirectoryRow(row: any, hosts: string[]): CommercialTenant {
  const isPlatform = String(row.id) === DEFAULT_COMMERCIAL_TENANT_ID;
  return {
    id: String(row.id),
    name: String(row.name || row.id),
    operatorName: String(row.operatorName || row.name || row.id),
    hosts,
    icpNumber: null,
    valueAddedTelecomLicense: null,
    publicSecurityRegistration: null,
    customerServiceEmail: null,
    rechargeEnabled: Boolean(row.rechargeEnabled),
    settlementRequired: row.settlementRequired == null ? !isPlatform : Boolean(row.settlementRequired),
    wholesaleRatePpm: integerInRange(row.wholesaleRatePpm, RATE_SCALE, 0, RATE_SCALE),
  };
}

async function activeHostsForTenants(
  database: TenantDb,
  tenantIds: readonly string[],
): Promise<Map<string, string[]>> {
  const hostsByTenant = new Map<string, string[]>();
  if (!tenantIds.length) return hostsByTenant;
  const domainRows = await (database as any)(TENANT_DIRECTORY_DOMAIN_TABLE)
    .whereNull("deletedAt")
    .where({ lifecycleState: "active" })
    .whereIn("tenantId", [...tenantIds])
    .select("tenantId", "hostname");
  for (const row of domainRows) {
    const host = normalizeCommercialHost(row.hostname);
    if (!host) continue;
    const tenantId = String(row.tenantId);
    hostsByTenant.set(tenantId, [...(hostsByTenant.get(tenantId) || []), host]);
  }
  return hostsByTenant;
}

async function directoryIsEmpty(database: TenantDb): Promise<boolean> {
  const row = await (database as any)(TENANT_DIRECTORY_TABLE)
    .whereNull("deletedAt")
    .count("* as total")
    .first();
  return Number(row?.total || 0) === 0;
}

/** 目录缺失租户时的环境变量回退（紧急开关或空目录 bootstrap）。 */
async function envFallbackTenantById(
  database: TenantDb,
  tenantId: string,
  env: NodeJS.ProcessEnv,
): Promise<CommercialTenant | null> {
  if (!tenantDirectoryEmergencyEnvFallbackEnabled(env)
    && !(await directoryIsEmpty(database))) {
    return null;
  }
  try {
    return commercialTenantById(tenantId);
  } catch {
    return null;
  }
}

/**
 * 按 ID 解析运行时商业租户（模式感知的统一权威查询）。
 * db 模式下归档租户 fail closed（409），已删除租户视为不存在。
 */
export async function runtimeCommercialTenantById(
  database: TenantDb = db,
  tenantId: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CommercialTenant> {
  const normalized = cleanTenantId(tenantId);
  if (tenantDirectoryMode(env) !== "db") {
    return commercialTenantById(normalized);
  }
  const row = await (database as any)(TENANT_DIRECTORY_TABLE)
    .where({ id: normalized })
    .whereNull("deletedAt")
    .first();
  if (row) {
    if (String(row.status) === "archived") {
      throw new CommercialTenantError("商业租户已归档，禁止继续交易", 409, "TENANT_ARCHIVED");
    }
    const hostsByTenant = await activeHostsForTenants(database, [normalized]);
    return runtimeTenantFromDirectoryRow(row, hostsByTenant.get(normalized) || []);
  }
  const fallback = await envFallbackTenantById(database, normalized, env);
  if (fallback) return fallback;
  throw new CommercialTenantError("商业租户不存在", 404, "TENANT_NOT_FOUND");
}

/**
 * 按 Host 解析运行时商业租户（db 模式直接读取数据库，不经过进程缓存；
 * 请求级 Host 中间件仍使用 tenantDirectory 的版本化快照）。
 * 未知 Host 遵循严格模式语义：非本地且 FANJIN_TENANT_STRICT_HOSTS=1 时
 * 421 fail closed，绝不静默回退。
 */
export async function runtimeCommercialTenantByHost(
  database: TenantDb = db,
  host: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CommercialTenant> {
  const normalizedHost = normalizeCommercialHost(host);
  if (tenantDirectoryMode(env) !== "db") {
    return resolveCommercialTenant(normalizedHost);
  }
  const domainRow = await (database as any)(TENANT_DIRECTORY_DOMAIN_TABLE)
    .whereNull("deletedAt")
    .where({ lifecycleState: "active", hostname: normalizedHost })
    .first();
  if (domainRow) {
    return await runtimeCommercialTenantById(database, String(domainRow.tenantId), env);
  }
  const local = normalizedHost === "localhost" || normalizedHost === "127.0.0.1" || normalizedHost === "::1";
  if (!local && env.FANJIN_TENANT_STRICT_HOSTS === "1") {
    throw new CommercialTenantError("当前访问域名未登记", 421, "TENANT_HOST_UNKNOWN");
  }
  const fallbackId = env.FANJIN_DEFAULT_COMMERCIAL_TENANT_ID || DEFAULT_COMMERCIAL_TENANT_ID;
  const fallback = await runtimeCommercialTenantById(database, fallbackId, env).catch(() => null);
  if (fallback) return fallback;
  // 本地开发且目录无默认租户时，允许空目录 bootstrap 回退环境变量。
  const envFallback = await envFallbackTenantById(database, fallbackId, env);
  if (envFallback) return envFallback;
  throw new CommercialTenantError("当前访问域名未登记", 421, "TENANT_HOST_UNKNOWN");
}

/**
 * 列出运行时可配置商业租户（模式感知）。
 * env 模式返回环境变量清单；db 模式返回未删除目录行（activeOnly 时仅
 * active）。DB-only 租户与导入租户同时可见。
 */
export async function listRuntimeCommercialTenants(
  database: TenantDb = db,
  options: { activeOnly?: boolean } = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<CommercialTenant[]> {
  if (tenantDirectoryMode(env) !== "db") {
    return listCommercialTenants();
  }
  const query = (database as any)(TENANT_DIRECTORY_TABLE).whereNull("deletedAt");
  if (options.activeOnly) query.where({ status: "active" });
  const rows = await query.orderBy("id", "asc");
  if (!rows.length) {
    return tenantDirectoryEmergencyEnvFallbackEnabled(env)
      ? listCommercialTenants()
      : [];
  }
  const hostsByTenant = await activeHostsForTenants(
    database,
    rows.map((row: any) => String(row.id)),
  );
  return rows.map((row: any) => (
    runtimeTenantFromDirectoryRow(row, hostsByTenant.get(String(row.id)) || [])
  ));
}

export function requestCommercialTenant(req: Request): CommercialTenant {
  return (req as any).commercialTenant || resolveCommercialTenant(req.hostname || req.headers.host);
}

export const commercialTenantContextMiddleware: RequestHandler = (req, res, next) => {
  try {
    const tenant = resolveCommercialTenant(req.hostname || req.headers.host);
    (req as any).commercialTenant = tenant;
    res.setHeader("X-Fanjin-Commercial-Tenant", tenant.id);
    next();
  } catch (error) {
    if (error instanceof CommercialTenantError) {
      return res.status(error.status).send({ message: error.message, code: error.code });
    }
    next(error);
  }
};

function assertPositiveSafeInteger(value: unknown, field: string): number {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new CommercialTenantError(`${field} 必须是正整数 micros`, 400, "TENANT_AMOUNT_INVALID");
  }
  return amount;
}

function parseMetadata(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function stringifyMetadata(value: unknown): string {
  return JSON.stringify(parseMetadata(value));
}

async function ensureSettlementAccount(client: TenantDb, tenantId: string) {
  const normalized = cleanTenantId(tenantId);
  let row = await (client as any)(TENANT_SETTLEMENT_ACCOUNT_TABLE).where({ tenantId: normalized }).first();
  if (row) return row;
  const timestamp = Date.now();
  try {
    await (client as any)(TENANT_SETTLEMENT_ACCOUNT_TABLE).insert({
      tenantId: normalized,
      balanceMicros: 0,
      currency: "CNY",
      status: "active",
      metadata: "{}",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  } catch (error) {
    row = await (client as any)(TENANT_SETTLEMENT_ACCOUNT_TABLE).where({ tenantId: normalized }).first();
    if (!row) throw error;
  }
  return row || await (client as any)(TENANT_SETTLEMENT_ACCOUNT_TABLE).where({ tenantId: normalized }).first();
}

async function findSettlementLedger(client: TenantDb, tenantId: string, idempotencyKey: string) {
  return await (client as any)(TENANT_SETTLEMENT_LEDGER_TABLE)
    .where({ tenantId, idempotencyKey })
    .first();
}

export async function creditTenantSettlementInTransaction(client: TenantDb, input: {
  tenantId: string;
  amountMicros: number;
  idempotencyKey: string;
  description?: string | null;
  metadata?: Record<string, unknown>;
  operatorUserId?: number | null;
}) {
  const tenant = await runtimeCommercialTenantById(client, input.tenantId);
  const amountMicros = assertPositiveSafeInteger(input.amountMicros, "结算入金金额");
  const idempotencyKey = String(input.idempotencyKey || "").trim();
  if (!idempotencyKey) throw new CommercialTenantError("结算入金缺少幂等键", 400, "TENANT_IDEMPOTENCY_REQUIRED");
  const existing = await findSettlementLedger(client, tenant.id, idempotencyKey);
  if (existing) {
    if (String(existing.type) !== "deposit" || Number(existing.amountMicros) !== amountMicros) {
      throw new CommercialTenantError("结算入金幂等键已用于不同请求", 409, "TENANT_IDEMPOTENCY_CONFLICT");
    }
    return { account: await ensureSettlementAccount(client, tenant.id), ledger: existing, idempotent: true };
  }

  const account = await ensureSettlementAccount(client, tenant.id);
  if (String(account.status) !== "active") {
    throw new CommercialTenantError("租户结算账户不可用", 409, "TENANT_SETTLEMENT_DISABLED");
  }
  const before = Number(account.balanceMicros || 0);
  const after = before + amountMicros;
  if (!Number.isSafeInteger(after)) throw new CommercialTenantError("租户结算余额超出安全范围", 409);
  const updated = await (client as any)(TENANT_SETTLEMENT_ACCOUNT_TABLE)
    .where({ tenantId: tenant.id, balanceMicros: before })
    .update({ balanceMicros: after, updatedAt: Date.now() });
  if (Number(updated || 0) !== 1) throw new CommercialTenantError("租户结算余额已变化，请重试", 409);
  const timestamp = Date.now();
  const ledger = {
    id: uuid(),
    tenantId: tenant.id,
    type: "deposit",
    direction: "credit",
    amountMicros,
    currency: "CNY",
    balanceBeforeMicros: before,
    balanceAfterMicros: after,
    creditLotId: null,
    sourceType: "manual_deposit",
    sourceId: null,
    idempotencyKey,
    description: String(input.description || "管理员增加租户结算金").trim(),
    metadata: stringifyMetadata(input.metadata),
    operatorUserId: input.operatorUserId ?? null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await (client as any)(TENANT_SETTLEMENT_LEDGER_TABLE).insert(ledger);
  return {
    account: { ...account, balanceMicros: after, updatedAt: timestamp },
    ledger,
    idempotent: false,
  };
}

export async function creditTenantSettlement(input: Parameters<typeof creditTenantSettlementInTransaction>[1]) {
  return await db.transaction((trx) => creditTenantSettlementInTransaction(trx, input));
}

async function debitTenantSettlementForLot(client: TenantDb, input: {
  tenant: CommercialTenant;
  creditLotId: string;
  amountMicros: number;
  sourceType: string;
  sourceId?: string | null;
  idempotencyKey: string;
  operatorUserId?: number | null;
}) {
  if (!input.tenant.settlementRequired || input.amountMicros === 0) return null;
  const existing = await findSettlementLedger(client, input.tenant.id, input.idempotencyKey);
  if (existing) return existing;
  const account = await ensureSettlementAccount(client, input.tenant.id);
  const before = Number(account.balanceMicros || 0);
  if (String(account.status) !== "active") {
    throw new CommercialTenantError("租户结算账户不可用，新充值已关闭", 409, "TENANT_SETTLEMENT_DISABLED");
  }
  if (before < input.amountMicros) {
    throw new CommercialTenantError(
      `租户结算金不足：需要 ${(input.amountMicros / 1_000_000).toFixed(2)} CNY`,
      402,
      "TENANT_SETTLEMENT_INSUFFICIENT",
    );
  }
  const after = before - input.amountMicros;
  const updated = await (client as any)(TENANT_SETTLEMENT_ACCOUNT_TABLE)
    .where({ tenantId: input.tenant.id, balanceMicros: before })
    .update({ balanceMicros: after, updatedAt: Date.now() });
  if (Number(updated || 0) !== 1) throw new CommercialTenantError("租户结算余额已变化，请重试", 409);
  const timestamp = Date.now();
  const ledger = {
    id: uuid(),
    tenantId: input.tenant.id,
    type: "recharge_wholesale",
    direction: "debit",
    amountMicros: input.amountMicros,
    currency: "CNY",
    balanceBeforeMicros: before,
    balanceAfterMicros: after,
    creditLotId: input.creditLotId,
    sourceType: input.sourceType,
    sourceId: input.sourceId ?? null,
    idempotencyKey: input.idempotencyKey,
    description: "用户充值确认，按批发价扣减租户结算金",
    metadata: "{}",
    operatorUserId: input.operatorUserId ?? null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await (client as any)(TENANT_SETTLEMENT_LEDGER_TABLE).insert(ledger);
  return ledger;
}

export async function createCommercialCreditLotInTransaction(client: TenantDb, input: {
  userId: number;
  sellerTenantId: string;
  amountMicros: number;
  retailAmountMicros?: number | null;
  accountWalletLedgerId: string;
  sourceType: string;
  sourceId?: string | null;
  idempotencyKey: string;
  collectorTenantId?: string | null;
  metadata?: Record<string, unknown>;
  operatorUserId?: number | null;
}) {
  const tenant = await runtimeCommercialTenantById(client, input.sellerTenantId);
  if (!tenant.rechargeEnabled) {
    throw new CommercialTenantError("当前租户充值未启用", 409, "TENANT_RECHARGE_DISABLED");
  }
  // 0.1.4 真实收款租户：以调用方按支付通道解析的 collectorTenantId 为准，
  // 未提供时回退 sellerTenantId（兼容旧调用方）。
  const collectorTenantId = (() => {
    const declared = String(input.collectorTenantId || "").trim().toUpperCase();
    if (!declared) return tenant.id;
    if (!/^[A-Z][A-Z0-9_-]{1,63}$/.test(declared)) {
      throw new CommercialTenantError("收款租户 ID 无效", 422, "TENANT_CONFIG_INVALID");
    }
    return declared;
  })();
  const amountMicros = assertPositiveSafeInteger(input.amountMicros, "GU 批次金额");
  const retailAmountMicros = input.retailAmountMicros == null
    ? Math.round(amountMicros / LEDGER_ATOMS_PER_CNY_MICRO)
    : assertPositiveSafeInteger(input.retailAmountMicros, "用户实付金额");
  const wholesaleAmountMicros = Math.round(retailAmountMicros * tenant.wholesaleRatePpm / RATE_SCALE);
  if (!Number.isSafeInteger(wholesaleAmountMicros) || wholesaleAmountMicros < 0) {
    throw new CommercialTenantError("批发结算金额超出安全范围", 409);
  }
  const idempotencyKey = String(input.idempotencyKey || "").trim();
  if (!idempotencyKey) throw new CommercialTenantError("GU 批次缺少幂等键", 400, "TENANT_IDEMPOTENCY_REQUIRED");
  const existing = await (client as any)(COMMERCIAL_CREDIT_LOT_TABLE).where({ idempotencyKey }).first();
  if (existing) {
    if (
      Number(existing.userId) !== Number(input.userId)
      || String(existing.sellerTenantId) !== tenant.id
      || Number(existing.amountMicros) !== amountMicros
    ) {
      throw new CommercialTenantError("GU 批次幂等键已用于不同请求", 409, "TENANT_IDEMPOTENCY_CONFLICT");
    }
    return { lot: existing, settlementLedger: null, idempotent: true };
  }

  const timestamp = Date.now();
  const lot = {
    id: uuid(),
    userId: Number(input.userId),
    sellerTenantId: tenant.id,
    collectorTenantId,
    accountWalletLedgerId: String(input.accountWalletLedgerId),
    sourceType: String(input.sourceType || "recharge"),
    sourceId: input.sourceId ?? null,
    amountMicros,
    remainingMicros: amountMicros,
    reservedMicros: 0,
    currency: "GU",
    retailAmountMicros,
    wholesaleAmountMicros,
    wholesaleRatePpm: tenant.wholesaleRatePpm,
    status: "active",
    idempotencyKey,
    metadata: stringifyMetadata(input.metadata),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  // R6 settlement V2 模式语义：
  // - legacy/off 与 shadow：保持 0.1.3 充值时批发结算扣减（影子账不影响正式结算）。
  // - active：充值只记现金与负债，停止充值时最终消费结算；
  //   消费应计由 capture 原子形成（见 consumptionAllocation.ts）。
  const settlementMode = settlementV2Mode();
  const settlementLedger = settlementMode === "active"
    ? null
    : await debitTenantSettlementForLot(client, {
      tenant,
      creditLotId: lot.id,
      amountMicros: wholesaleAmountMicros,
      sourceType: lot.sourceType,
      sourceId: lot.sourceId,
      idempotencyKey: `wholesale:${idempotencyKey}`,
      operatorUserId: input.operatorUserId,
    });
  await (client as any)(COMMERCIAL_CREDIT_LOT_TABLE).insert(lot);
  return { lot, settlementLedger, idempotent: false };
}

async function activeCreditLots(client: TenantDb, userId: number) {
  return await (client as any)(COMMERCIAL_CREDIT_LOT_TABLE)
    .where({ userId, status: "active" })
    .andWhere("remainingMicros", ">", 0)
    .orderBy("createdAt", "asc")
    .orderBy("id", "asc");
}

export async function reserveCommercialCreditLots(
  client: TenantDb,
  input: { userId: number; amountMicros: number; cashAvailableMicros: number },
): Promise<CommercialCreditLotAllocation[]> {
  const amountMicros = assertPositiveSafeInteger(input.amountMicros, "现金 GU 冻结金额");
  const lots = await activeCreditLots(client, Number(input.userId));
  const trackedAvailable = lots.reduce(
    (sum: number, row: any) => sum + Math.max(0, Number(row.remainingMicros || 0) - Number(row.reservedMicros || 0)),
    0,
  );
  let remaining = amountMicros;
  const allocations: CommercialCreditLotAllocation[] = [];
  const legacyAvailable = Math.max(0, Number(input.cashAvailableMicros || 0) - trackedAvailable);
  const legacyReserved = Math.min(remaining, legacyAvailable);
  if (legacyReserved > 0) {
    allocations.push({ sellerTenantId: DEFAULT_COMMERCIAL_TENANT_ID, creditLotId: null, amountMicros: legacyReserved });
    remaining -= legacyReserved;
  }
  for (const row of lots) {
    if (remaining <= 0) break;
    const available = Math.max(0, Number(row.remainingMicros || 0) - Number(row.reservedMicros || 0));
    const used = Math.min(remaining, available);
    if (used <= 0) continue;
    const affected = await (client as any)(COMMERCIAL_CREDIT_LOT_TABLE)
      .where({ id: row.id, remainingMicros: row.remainingMicros, reservedMicros: row.reservedMicros, status: "active" })
      .update({ reservedMicros: Number(row.reservedMicros || 0) + used, updatedAt: Date.now() });
    if (Number(affected || 0) !== 1) throw new CommercialTenantError("GU 销售批次已变化，请重试", 409);
    allocations.push({ creditLotId: String(row.id), sellerTenantId: String(row.sellerTenantId), amountMicros: used });
    remaining -= used;
  }
  if (remaining > 0) {
    throw new CommercialTenantError("现金 GU 批次可用余额不足", 409, "CREDIT_LOT_BALANCE_MISMATCH");
  }
  return allocations;
}

export async function captureCommercialCreditLots(
  client: TenantDb,
  userId: number,
  allocations: CommercialCreditLotAllocation[],
) {
  for (const allocation of allocations) {
    if (!allocation.creditLotId) continue;
    const row = await (client as any)(COMMERCIAL_CREDIT_LOT_TABLE)
      .where({ id: allocation.creditLotId, userId: Number(userId) })
      .first();
    if (!row) throw new CommercialTenantError("GU 销售批次不存在", 409);
    const amount = assertPositiveSafeInteger(allocation.amountMicros, "GU 批次扣费金额");
    const remaining = Number(row.remainingMicros || 0);
    const reserved = Number(row.reservedMicros || 0);
    if (remaining < amount || reserved < amount) throw new CommercialTenantError("GU 销售批次冻结余额不足", 409);
    const affected = await (client as any)(COMMERCIAL_CREDIT_LOT_TABLE)
      .where({ id: row.id, remainingMicros: remaining, reservedMicros: reserved })
      .update({
        remainingMicros: remaining - amount,
        reservedMicros: reserved - amount,
        status: remaining - amount === 0 ? "exhausted" : "active",
        updatedAt: Date.now(),
      });
    if (Number(affected || 0) !== 1) throw new CommercialTenantError("GU 销售批次已变化，请重试", 409);
  }
}

export async function releaseCommercialCreditLots(
  client: TenantDb,
  userId: number,
  allocations: CommercialCreditLotAllocation[],
) {
  for (const allocation of allocations) {
    if (!allocation.creditLotId) continue;
    const row = await (client as any)(COMMERCIAL_CREDIT_LOT_TABLE)
      .where({ id: allocation.creditLotId, userId: Number(userId) })
      .first();
    if (!row) throw new CommercialTenantError("GU 销售批次不存在", 409);
    const amount = assertPositiveSafeInteger(allocation.amountMicros, "GU 批次释放金额");
    const reserved = Number(row.reservedMicros || 0);
    if (reserved < amount) throw new CommercialTenantError("GU 销售批次冻结余额不足", 409);
    const affected = await (client as any)(COMMERCIAL_CREDIT_LOT_TABLE)
      .where({ id: row.id, reservedMicros: reserved })
      .update({ reservedMicros: reserved - amount, updatedAt: Date.now() });
    if (Number(affected || 0) !== 1) throw new CommercialTenantError("GU 销售批次已变化，请重试", 409);
  }
}

export async function restoreCommercialCreditLots(
  client: TenantDb,
  userId: number,
  allocations: CommercialCreditLotAllocation[],
) {
  for (const allocation of allocations) {
    if (!allocation.creditLotId) continue;
    const row = await (client as any)(COMMERCIAL_CREDIT_LOT_TABLE)
      .where({ id: allocation.creditLotId, userId: Number(userId) })
      .first();
    if (!row) throw new CommercialTenantError("GU 销售批次不存在", 409);
    const amount = assertPositiveSafeInteger(allocation.amountMicros, "GU 批次退款恢复金额");
    const remaining = Number(row.remainingMicros || 0);
    const after = remaining + amount;
    if (!Number.isSafeInteger(after) || after > Number(row.amountMicros || 0)) {
      throw new CommercialTenantError("GU 销售批次退款恢复金额无效", 409);
    }
    const affected = await (client as any)(COMMERCIAL_CREDIT_LOT_TABLE)
      .where({ id: row.id, remainingMicros: remaining })
      .update({ remainingMicros: after, status: "active", updatedAt: Date.now() });
    if (Number(affected || 0) !== 1) throw new CommercialTenantError("GU 销售批次已变化，请重试", 409);
  }
}

export type CommercialTenantLegalProfile = {
  tenantId: string;
  icpNumber: string | null;
  valueAddedTelecomLicense: string | null;
  publicSecurityRegistration: string | null;
  revision: number;
  updatedAt: number | null;
  updatedBy: number | null;
  configurationSource: "database" | "deployment";
};

function legalSettingKey(tenantId: string): string {
  return `${COMMERCIAL_TENANT_LEGAL_SETTING_PREFIX}${cleanTenantId(tenantId)}`;
}

function normalizeLegalValue(value: unknown, field: string): string | null {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;
  if (normalized.length > 500) {
    throw new CommercialTenantError(`${field}不能超过 500 个字符`, 422, "TENANT_LEGAL_PROFILE_INVALID");
  }
  if (/^(?:x+|待配置|未配置)$/i.test(normalized)) {
    throw new CommercialTenantError(`${field}不能保存占位值`, 422, "TENANT_LEGAL_PROFILE_PLACEHOLDER");
  }
  return normalized;
}

function deploymentLegalProfile(tenant: CommercialTenant): CommercialTenantLegalProfile {
  return {
    tenantId: tenant.id,
    icpNumber: tenant.icpNumber,
    valueAddedTelecomLicense: tenant.valueAddedTelecomLicense,
    publicSecurityRegistration: tenant.publicSecurityRegistration,
    revision: 0,
    updatedAt: null,
    updatedBy: null,
    configurationSource: "deployment",
  };
}

function parseStoredLegalProfile(
  tenant: CommercialTenant,
  rawValue: unknown,
): CommercialTenantLegalProfile {
  let parsed: any;
  try {
    parsed = JSON.parse(String(rawValue || ""));
  } catch {
    throw new CommercialTenantError(
      `商业租户 ${tenant.id} 的合规资料已损坏`,
      500,
      "TENANT_LEGAL_PROFILE_CORRUPT",
    );
  }
  const revision = Number(parsed?.revision);
  if (
    parsed?.schema !== "fanjin.commercial-tenant-legal-profile/v1"
    || cleanTenantId(parsed?.tenantId) !== tenant.id
    || !Number.isSafeInteger(revision)
    || revision < 1
  ) {
    throw new CommercialTenantError(
      `商业租户 ${tenant.id} 的合规资料格式无效`,
      500,
      "TENANT_LEGAL_PROFILE_CORRUPT",
    );
  }
  return {
    tenantId: tenant.id,
    icpNumber: normalizeLegalValue(parsed.icpNumber, "ICP备案"),
    valueAddedTelecomLicense: normalizeLegalValue(
      parsed.valueAddedTelecomLicense,
      "增值电信业务经营许可证",
    ),
    publicSecurityRegistration: normalizeLegalValue(
      parsed.publicSecurityRegistration,
      "公安联网备案",
    ),
    revision,
    updatedAt: Number.isSafeInteger(Number(parsed.updatedAt)) ? Number(parsed.updatedAt) : null,
    updatedBy: Number.isSafeInteger(Number(parsed.updatedBy)) ? Number(parsed.updatedBy) : null,
    configurationSource: "database",
  };
}

export async function readCommercialTenantLegalProfile(
  tenantOrId: CommercialTenant | string,
  database: TenantDb = db,
): Promise<CommercialTenantLegalProfile> {
  const tenant = typeof tenantOrId === "string"
    ? await runtimeCommercialTenantById(database, tenantOrId)
    : tenantOrId;
  const row = await (database as any)("o_setting")
    .where({ key: legalSettingKey(tenant.id) })
    .select("value")
    .first();
  return row ? parseStoredLegalProfile(tenant, row.value) : deploymentLegalProfile(tenant);
}

export async function updateCommercialTenantLegalProfile(input: {
  tenantId: string;
  expectedRevision: number;
  icpNumber?: unknown;
  valueAddedTelecomLicense?: unknown;
  publicSecurityRegistration?: unknown;
  operatorUserId?: number | null;
  audit?: (profile: CommercialTenantLegalProfile, trx: Knex.Transaction) => Promise<void>;
}): Promise<CommercialTenantLegalProfile> {
  const tenant = await runtimeCommercialTenantById(db, input.tenantId);
  const expectedRevision = Number(input.expectedRevision);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new CommercialTenantError("合规资料版本号无效", 422, "TENANT_LEGAL_PROFILE_INVALID");
  }
  return await db.transaction(async (trx) => {
    const key = legalSettingKey(tenant.id);
    const row = await trx("o_setting").where({ key }).select("value").forUpdate().first();
    const current = row
      ? parseStoredLegalProfile(tenant, row.value)
      : deploymentLegalProfile(tenant);
    if (current.revision !== expectedRevision) {
      throw new CommercialTenantError(
        "合规资料已被其他管理员更新，请刷新后重试",
        409,
        "TENANT_LEGAL_PROFILE_REVISION_CONFLICT",
      );
    }
    const has = (field: string) => Object.prototype.hasOwnProperty.call(input, field);
    const timestamp = Date.now();
    const profile: CommercialTenantLegalProfile = {
      tenantId: tenant.id,
      icpNumber: has("icpNumber")
        ? normalizeLegalValue(input.icpNumber, "ICP备案")
        : current.icpNumber,
      valueAddedTelecomLicense: has("valueAddedTelecomLicense")
        ? normalizeLegalValue(input.valueAddedTelecomLicense, "增值电信业务经营许可证")
        : current.valueAddedTelecomLicense,
      publicSecurityRegistration: has("publicSecurityRegistration")
        ? normalizeLegalValue(input.publicSecurityRegistration, "公安联网备案")
        : current.publicSecurityRegistration,
      revision: current.revision + 1,
      updatedAt: timestamp,
      updatedBy: input.operatorUserId ?? null,
      configurationSource: "database",
    };
    const stored = JSON.stringify({
      schema: "fanjin.commercial-tenant-legal-profile/v1",
      tenantId: profile.tenantId,
      icpNumber: profile.icpNumber,
      valueAddedTelecomLicense: profile.valueAddedTelecomLicense,
      publicSecurityRegistration: profile.publicSecurityRegistration,
      revision: profile.revision,
      updatedAt: profile.updatedAt,
      updatedBy: profile.updatedBy,
    });
    if (row) await trx("o_setting").where({ key }).update({ value: stored });
    else await trx("o_setting").insert({ key, value: stored });
    if (input.audit) await input.audit(profile, trx);
    return profile;
  });
}

export function publicCommercialTenantRuntime(
  tenant: CommercialTenant,
  legalProfile: CommercialTenantLegalProfile = deploymentLegalProfile(tenant),
) {
  const identityOrigin = String(process.env.FANJIN_IDENTITY_ORIGIN || "").trim().replace(/\/+$/, "") || null;
  return {
    id: tenant.id,
    name: tenant.name,
    operatorName: tenant.operatorName,
    icpNumber: legalProfile.icpNumber,
    valueAddedTelecomLicense: legalProfile.valueAddedTelecomLicense,
    publicSecurityRegistration: legalProfile.publicSecurityRegistration,
    customerServiceEmail: tenant.customerServiceEmail,
    rechargeEnabled: tenant.rechargeEnabled,
    identityOrigin,
    currency: "GU",
  };
}
