import crypto from "node:crypto";
import type { Knex } from "knex";
import { v4 as uuid } from "uuid";

import { db } from "@/utils/db";
import { normalizeCommercialHost } from "@/lib/commercialTenant";
import {
  TENANT_DOMAIN_TABLE,
  tenantDirectoryById,
  resetTenantRuntimeSnapshotCache,
} from "@/lib/tenantDirectory";
import { listIngressCapacity } from "@/lib/tenantCapacity";

export const DOMAIN_VERIFICATION_TABLE = "o_domain_verification";
export const TENANT_DOMAIN_OPERATION_TABLE = "o_tenant_domain_operation";
export { TENANT_DOMAIN_TABLE };

export type TenantDomainLifecycleState =
  | "draft"
  | "ownership_pending"
  | "verified"
  | "certificate_pending"
  | "ready"
  | "activating"
  | "active"
  | "expiring"
  | "suspending"
  | "suspended"
  | "failed"
  | "archived";

export type TenantDomainPurpose = "web_api" | "auth" | "callback" | "media";

export type DomainIcpState = "not_required" | "pending" | "verified" | "rejected" | "unknown";

export type TenantDomainRecord = {
  id: string;
  tenantId: string;
  hostname: string;
  displayHostname: string | null;
  purpose: TenantDomainPurpose;
  isPrimary: boolean;
  lifecycleState: TenantDomainLifecycleState;
  ownershipState: "pending" | "verified" | "expired" | "failed";
  icpState: DomainIcpState;
  certificateId: string | null;
  ingressBindingId: string | null;
  desiredRevision: number;
  observedRevision: number;
  lastVerifiedAt: number | null;
  nextVerifyAt: number | null;
  activatedAt: number | null;
  suspendedAt: number | null;
  failureCode: string | null;
  failureMessage: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
};

export class TenantDomainError extends Error {
  status: number;
  code: string;

  constructor(message: string, status = 400, code = "TENANT_DOMAIN_ERROR") {
    super(message);
    this.name = "TenantDomainError";
    this.status = status;
    this.code = code;
  }
}

type DomainDb = Knex | Knex.Transaction;

const RESERVED_HOSTNAME_PREFIX = "_fanjin-verification";
const VERIFICATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// 域名规范化与准入
// ---------------------------------------------------------------------------

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "instance-data",
]);

/**
 * 域名规范化（设计文档 §9.1）：
 * - 仅接收域名：拒绝协议、路径、查询、端口、IP
 * - 小写、去尾点；国际化域名转 ASCII（Punycode）
 * - 拒绝保留/私有/平台内部域名
 */
export function normalizeTenantHostname(value: unknown): { hostname: string; displayHostname: string | null } {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) throw new TenantDomainError("域名不能为空", 422, "DOMAIN_HOSTNAME_INVALID");
  if (/^https?:\/\//.test(raw) || raw.includes("/") || raw.includes("?") || raw.includes("#")) {
    throw new TenantDomainError("仅接收域名，不接收 URL", 422, "DOMAIN_HOSTNAME_INVALID");
  }
  let hostname = raw.replace(/\.$/, "");
  let displayHostname: string | null = null;
  if (/[^\x21-\x7e]/.test(hostname)) {
    // 国际化域名：使用 URL 解析为 Punycode ASCII。
    try {
      const parsed = new URL(`http://${hostname}`);
      hostname = parsed.hostname;
      displayHostname = raw;
    } catch {
      throw new TenantDomainError("国际化域名无效", 422, "DOMAIN_HOSTNAME_INVALID");
    }
  }
  if (hostname.includes(":")) {
    throw new TenantDomainError("域名不能包含端口", 422, "DOMAIN_HOSTNAME_INVALID");
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":")) {
    throw new TenantDomainError("不接收 IP 地址", 422, "DOMAIN_HOSTNAME_INVALID");
  }
  if (hostname.endsWith(".local") || hostname.endsWith(".internal") || hostname.endsWith(".localhost")) {
    throw new TenantDomainError("私有网络域名不允许登记", 422, "DOMAIN_HOSTNAME_RESERVED");
  }
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new TenantDomainError("保留域名不允许登记", 422, "DOMAIN_HOSTNAME_RESERVED");
  }
  const labels = hostname.split(".");
  if (labels.length < 2) {
    throw new TenantDomainError("域名必须包含至少两级标签", 422, "DOMAIN_HOSTNAME_INVALID");
  }
  if (hostname.length > 253) {
    throw new TenantDomainError("域名总长度不能超过 253 字符", 422, "DOMAIN_HOSTNAME_INVALID");
  }
  for (const label of labels) {
    if (!label || label.length > 63) {
      throw new TenantDomainError("域名标签长度必须在 1-63 字符之间", 422, "DOMAIN_HOSTNAME_INVALID");
    }
    if (!/^[a-z0-9-]+$/.test(label) && !label.startsWith("xn--")) {
      throw new TenantDomainError("域名标签仅允许小写字母、数字与连字符", 422, "DOMAIN_HOSTNAME_INVALID");
    }
    if (label.startsWith("-") || label.endsWith("-")) {
      throw new TenantDomainError("域名标签不能以连字符开头或结尾", 422, "DOMAIN_HOSTNAME_INVALID");
    }
  }
  if (hostname.startsWith("*.")) {
    throw new TenantDomainError("首期不开放泛域名登记，需平台 Root 审批", 422, "DOMAIN_WILDCARD_FORBIDDEN");
  }
  return { hostname, displayHostname };
}

// ---------------------------------------------------------------------------
// 域名 CRUD
// ---------------------------------------------------------------------------

export function rowToDomain(row: any): TenantDomainRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenantId),
    hostname: String(row.hostname),
    displayHostname: row.displayHostname ? String(row.displayHostname) : null,
    purpose: String(row.purpose || "web_api") as TenantDomainPurpose,
    isPrimary: Boolean(row.isPrimary),
    lifecycleState: String(row.lifecycleState || "draft") as TenantDomainLifecycleState,
    ownershipState: String(row.ownershipState || "pending") as TenantDomainRecord["ownershipState"],
    icpState: String(row.icpState || "unknown") as DomainIcpState,
    certificateId: row.certificateId ? String(row.certificateId) : null,
    ingressBindingId: row.ingressBindingId ? String(row.ingressBindingId) : null,
    desiredRevision: Number(row.desiredRevision || 1),
    observedRevision: Number(row.observedRevision || 0),
    lastVerifiedAt: row.lastVerifiedAt == null ? null : Number(row.lastVerifiedAt),
    nextVerifyAt: row.nextVerifyAt == null ? null : Number(row.nextVerifyAt),
    activatedAt: row.activatedAt == null ? null : Number(row.activatedAt),
    suspendedAt: row.suspendedAt == null ? null : Number(row.suspendedAt),
    failureCode: row.failureCode ? String(row.failureCode) : null,
    failureMessage: row.failureMessage ? String(row.failureMessage) : null,
    createdAt: Number(row.createdAt || 0),
    updatedAt: Number(row.updatedAt || 0),
    deletedAt: row.deletedAt == null ? null : Number(row.deletedAt),
  };
}

export async function createTenantDomain(input: {
  tenantId: string;
  hostname: string;
  purpose?: TenantDomainPurpose;
  isPrimary?: boolean;
  icpState?: DomainIcpState;
  operatorUserId?: number | null;
}): Promise<TenantDomainRecord> {
  const { hostname, displayHostname } = normalizeTenantHostname(input.hostname);
  const purpose = input.purpose || "web_api";
  const record = await db.transaction(async (trx) => insertDomain(trx, {
    tenantId: input.tenantId,
    hostname,
    displayHostname,
    purpose,
    isPrimary: Boolean(input.isPrimary),
    icpState: input.icpState || "unknown",
    operatorUserId: input.operatorUserId ?? null,
  }));
  // R8：域名创建提交后失效运行时快照缓存。
  resetTenantRuntimeSnapshotCache();
  return record;
}

async function insertDomain(
  trx: Knex.Transaction,
  input: {
    tenantId: string;
    hostname: string;
    displayHostname: string | null;
    purpose: TenantDomainPurpose;
    isPrimary: boolean;
    icpState: DomainIcpState;
    operatorUserId: number | null;
  },
): Promise<TenantDomainRecord> {
  const tenant = await tenantDirectoryById(trx, input.tenantId);
  if (tenant.status === "archived") {
    throw new TenantDomainError("已归档租户不允许新增域名", 409, "TENANT_ARCHIVED");
  }
  const conflict = await trx(TENANT_DOMAIN_TABLE)
    .where({ hostname: input.hostname })
    .whereNull("deletedAt")
    .first();
  if (conflict) {
    throw new TenantDomainError(
      "域名已登记给其他商业租户",
      409,
      "DOMAIN_HOSTNAME_CONFLICT",
    );
  }
  // 同租户同用途只允许一个主域名。
  if (input.isPrimary) {
    const existingPrimary = await trx(TENANT_DOMAIN_TABLE)
      .where({ tenantId: tenant.id, purpose: input.purpose, isPrimary: true })
      .whereNull("deletedAt")
      .first();
    if (existingPrimary) {
      throw new TenantDomainError("该用途已存在主域名", 409, "DOMAIN_PRIMARY_CONFLICT");
    }
  }
  const timestamp = Date.now();
  const record = {
    id: uuid(),
    tenantId: tenant.id,
    hostname: input.hostname,
    displayHostname: input.displayHostname,
    purpose: input.purpose,
    isPrimary: input.isPrimary,
    lifecycleState: "ownership_pending",
    ownershipState: "pending",
    icpState: input.icpState,
    certificateId: null,
    ingressBindingId: null,
    desiredRevision: 1,
    observedRevision: 0,
    lastVerifiedAt: null,
    nextVerifyAt: null,
    activatedAt: null,
    suspendedAt: null,
    failureCode: null,
    failureMessage: null,
    metadata: "{}",
    createdByUserId: input.operatorUserId,
    updatedByUserId: input.operatorUserId,
    createdAt: timestamp,
    updatedAt: timestamp,
    deletedAt: null,
  };
  await trx(TENANT_DOMAIN_TABLE).insert(record);
  return rowToDomain(record);
}

export async function listTenantDomains(
  database: DomainDb = db,
  filters: { tenantId?: string; lifecycleState?: string } = {},
): Promise<TenantDomainRecord[]> {
  const query = (database as any)(TENANT_DOMAIN_TABLE).whereNull("deletedAt");
  if (filters.tenantId) query.where({ tenantId: filters.tenantId });
  if (filters.lifecycleState) query.where({ lifecycleState: filters.lifecycleState });
  const rows = await query.orderBy("createdAt", "asc");
  return rows.map(rowToDomain);
}

export async function tenantDomainById(database: DomainDb, domainId: string): Promise<TenantDomainRecord> {
  const row = await (database as any)(TENANT_DOMAIN_TABLE)
    .where({ id: String(domainId || "") })
    .whereNull("deletedAt")
    .first();
  if (!row) throw new TenantDomainError("域名不存在", 404, "DOMAIN_NOT_FOUND");
  return rowToDomain(row);
}

export async function softDeleteTenantDomain(input: {
  domainId: string;
  operatorUserId?: number | null;
}): Promise<TenantDomainRecord> {
  const record = await db.transaction(async (trx) => {
    const row = await trx(TENANT_DOMAIN_TABLE)
      .where({ id: input.domainId })
      .whereNull("deletedAt")
      .forUpdate()
      .first();
    if (!row) throw new TenantDomainError("域名不存在", 404, "DOMAIN_NOT_FOUND");
    const domain = rowToDomain(row);
    if (["active", "activating", "suspending"].includes(domain.lifecycleState)) {
      throw new TenantDomainError(
        "域名仍在迁移或在线，请先暂停或中止后再删除",
        409,
        "DOMAIN_ACTIVE_FORBIDDEN",
      );
    }
    const timestamp = Date.now();
    await trx(TENANT_DOMAIN_TABLE)
      .where({ id: domain.id })
      .update({ deletedAt: timestamp, updatedAt: timestamp, updatedByUserId: input.operatorUserId ?? null });
    return { ...domain, deletedAt: timestamp };
  });
  // R8：域名归档（软删除）提交后失效运行时快照缓存。
  resetTenantRuntimeSnapshotCache();
  return record;
}

// ---------------------------------------------------------------------------
// DNS TXT 所有权验证
// ---------------------------------------------------------------------------

export type DnsTxtLookupResult = {
  ok: boolean;
  answers: string[];
  error?: string;
};

export type DnsTxtResolver = (recordName: string) => Promise<DnsTxtLookupResult>;

/**
 * 默认解析器：Node dns.resolveTxt。
 * 通过依赖注入支持测试与多视角解析。
 */
export function createNodeDnsTxtResolver(): DnsTxtResolver {
  return async (recordName: string) => {
    const dns = await import("node:dns/promises");
    try {
      const records = await dns.resolveTxt(recordName);
      const answers = records.map((chunks) => chunks.join(""));
      return { ok: true, answers };
    } catch (error) {
      const code = String((error as any)?.code || "");
      return { ok: false, answers: [], error: code || String((error as Error)?.message || "dns_failed") };
    }
  };
}

function verificationRecordName(hostname: string): string {
  return `${RESERVED_HOSTNAME_PREFIX}.${hostname}`;
}

function tokenForDomain(domain: TenantDomainRecord): string {
  return `fanjin-verify=v1;domain=${domain.hostname};token=${crypto.randomBytes(24).toString("base64url")}`;
}

function tokenHashOf(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function tokenHint(token: string): string {
  return `${token.slice(0, 24)}…`;
}

/**
 * 发起域名所有权验证：生成一次性 TXT 记录令牌。
 * 明文令牌只在响应中显示一次；数据库只保存哈希。
 */
export async function startDomainVerification(input: {
  domainId: string;
  operatorUserId?: number | null;
  database?: DomainDb;
}): Promise<{
  domain: TenantDomainRecord;
  recordName: string;
  recordType: "TXT";
  token: string;
  valueHint: string;
  expiresAt: number;
}> {
  const run = async (client: DomainDb) => {
    const row = await (client as any)(TENANT_DOMAIN_TABLE)
      .where({ id: input.domainId })
      .whereNull("deletedAt")
      .forUpdate()
      .first();
    if (!row) throw new TenantDomainError("域名不存在", 404, "DOMAIN_NOT_FOUND");
    const domain = rowToDomain(row);
    if (["archived", "suspended"].includes(domain.lifecycleState)) {
      throw new TenantDomainError("域名当前状态不允许验证", 409, "DOMAIN_STATE_INVALID");
    }
    const token = tokenForDomain(domain);
    const timestamp = Date.now();
    const expiresAt = timestamp + VERIFICATION_TTL_MS;
    const verificationId = uuid();
    await (client as any)(DOMAIN_VERIFICATION_TABLE).insert({
      id: verificationId,
      domainId: domain.id,
      method: "dns_txt",
      recordName: verificationRecordName(domain.hostname),
      recordType: "TXT",
      tokenHash: tokenHashOf(token),
      valueHint: tokenHint(token),
      state: "pending",
      expiresAt,
      attemptCount: 0,
      lastAttemptAt: null,
      verifiedDnsAnswers: "[]",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await (client as any)(TENANT_DOMAIN_TABLE)
      .where({ id: domain.id })
      .update({
        lifecycleState: domain.lifecycleState === "verified" ? "verified" : "ownership_pending",
        ownershipState: "pending",
        updatedAt: timestamp,
        updatedByUserId: input.operatorUserId ?? null,
      });
    return {
      domain: { ...domain, lifecycleState: "ownership_pending" as TenantDomainLifecycleState, ownershipState: "pending" as const },
      recordName: verificationRecordName(domain.hostname),
      recordType: "TXT" as const,
      token,
      valueHint: tokenHint(token),
      expiresAt,
    };
  };
  if (input.database) return await run(input.database);
  return await db.transaction(async (trx) => run(trx));
}

export type VerificationCheckOutcome = {
  domain: TenantDomainRecord;
  state: "verified" | "pending" | "expired" | "failed";
  answers: string[];
  reason: string | null;
};

/**
 * 检查域名所有权验证：
 * - 使用注入的解析器查询 TXT 记录（生产用 Node DNS；测试可注入 fixture）
 * - 命中未过期验证令牌哈希后标记 verified
 * - 记录尝试次数与 DNS 应答证据（受限保存）
 */
export async function checkDomainVerification(input: {
  domainId: string;
  resolver?: DnsTxtResolver;
  operatorUserId?: number | null;
  database?: DomainDb;
}): Promise<VerificationCheckOutcome> {
  const resolver = input.resolver || createNodeDnsTxtResolver();
  const run = async (client: DomainDb): Promise<VerificationCheckOutcome> => {
    const domainRow = await (client as any)(TENANT_DOMAIN_TABLE)
      .where({ id: input.domainId })
      .whereNull("deletedAt")
      .first();
    if (!domainRow) throw new TenantDomainError("域名不存在", 404, "DOMAIN_NOT_FOUND");
    const domain = rowToDomain(domainRow);
    const verification = await (client as any)(DOMAIN_VERIFICATION_TABLE)
      .where({ domainId: domain.id, state: "pending" })
      .orderBy("createdAt", "desc")
      .first();
    if (!verification) {
      throw new TenantDomainError("没有待验证的验证记录，请先生成验证", 409, "DOMAIN_VERIFICATION_MISSING");
    }
    const timestamp = Date.now();
    await (client as any)(DOMAIN_VERIFICATION_TABLE)
      .where({ id: verification.id })
      .update({
        attemptCount: Number(verification.attemptCount || 0) + 1,
        lastAttemptAt: timestamp,
        updatedAt: timestamp,
      });
    if (Number(verification.expiresAt) < timestamp) {
      await (client as any)(DOMAIN_VERIFICATION_TABLE)
        .where({ id: verification.id })
        .update({ state: "expired", updatedAt: timestamp });
      return {
        domain,
        state: "expired",
        answers: [],
        reason: "验证令牌已过期，请重新生成",
      };
    }
    const lookup = await resolver(String(verification.recordName));
    const matched = lookup.answers.some((answer) => tokenHashOf(answer) === String(verification.tokenHash));
    if (!lookup.ok || !matched) {
      await (client as any)(DOMAIN_VERIFICATION_TABLE)
        .where({ id: verification.id })
        .update({
          state: lookup.ok ? "pending" : "failed",
          verifiedDnsAnswers: JSON.stringify((lookup.answers || []).slice(0, 5)),
          updatedAt: timestamp,
        });
      return {
        domain,
        state: lookup.ok ? "pending" : "failed",
        answers: lookup.answers,
        reason: lookup.ok ? "TXT 记录尚未生效或不匹配" : `DNS 查询失败：${lookup.error || "unknown"}`,
      };
    }
    await (client as any)(DOMAIN_VERIFICATION_TABLE)
      .where({ id: verification.id })
      .update({
        state: "verified",
        verifiedDnsAnswers: JSON.stringify(lookup.answers.slice(0, 5)),
        updatedAt: timestamp,
      });
    const updatedDomain = await (client as any)(TENANT_DOMAIN_TABLE)
      .where({ id: domain.id })
      .update({
        lifecycleState: "verified",
        ownershipState: "verified",
        lastVerifiedAt: timestamp,
        nextVerifyAt: timestamp + 30 * 24 * 60 * 60 * 1000,
        failureCode: null,
        failureMessage: null,
        updatedAt: timestamp,
        updatedByUserId: input.operatorUserId ?? null,
      });
    if (Number(updatedDomain || 0) !== 1) {
      throw new TenantDomainError("域名状态已变化，请重试", 409, "DOMAIN_STATE_CONFLICT");
    }
    const refreshed = await (client as any)(TENANT_DOMAIN_TABLE).where({ id: domain.id }).first();
    return {
      domain: rowToDomain(refreshed),
      state: "verified",
      answers: lookup.answers,
      reason: null,
    };
  };
  if (input.database) return await run(input.database);
  return await db.transaction(async (trx) => run(trx));
}

// ---------------------------------------------------------------------------
// 预检（发布/恢复共用）
// ---------------------------------------------------------------------------

export type DomainPreflightCheck = {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
};

export type DomainPreflightResult = {
  domain: TenantDomainRecord;
  passed: boolean;
  blockers: string[];
  checks: DomainPreflightCheck[];
};

/**
 * 域名发布预检（设计文档 §12.3 第 5 步）：
 * - 所有权验证仍有效
 * - ICP 门禁满足（大陆公开入口要求 verified / not_required）
 * - 证书有效并覆盖域名（若已配置）
 * - Host 规则不冲突（active 域名全局唯一）
 * - 后端 /api/ready 与运行时快照可构建（本地检查）
 */
export async function preflightTenantDomain(input: {
  domainId: string;
  database?: DomainDb;
}): Promise<DomainPreflightResult> {
  const database = input.database ?? db;
  const domain = await tenantDomainById(database, input.domainId);
  const checks: DomainPreflightCheck[] = [];
  const blockers: string[] = [];
  const now = Date.now();

  const ownershipValid = domain.ownershipState === "verified"
    && domain.lastVerifiedAt != null
    && (domain.nextVerifyAt == null || domain.nextVerifyAt > now - 30 * 24 * 60 * 60 * 1000);
  checks.push({
    id: "ownership",
    label: "DNS 所有权验证有效",
    passed: ownershipValid,
    detail: ownershipValid ? "已通过 TXT 验证" : "缺少有效的所有权验证",
  });
  if (!ownershipValid) blockers.push("ownership");

  const icpOk = domain.icpState === "verified" || domain.icpState === "not_required";
  checks.push({
    id: "icp",
    label: "中国大陆 ICP 门禁",
    passed: icpOk,
    detail: icpOk ? `备案状态：${domain.icpState}` : `备案状态为 ${domain.icpState}，未满足公开访问门禁`,
  });
  if (!icpOk) blockers.push("icp");

  if (domain.certificateId) {
    const cert = await (database as any)("o_tenant_certificate").where({ id: domain.certificateId }).first();
    const certOk = Boolean(cert)
      && String(cert.status) === "active"
      && Number(cert.notAfter || 0) > now + 30 * 24 * 60 * 60 * 1000;
    const covers = Boolean(cert) && domainCoversHostname(cert, domain.hostname);
    checks.push({
      id: "certificate",
      label: "证书有效并覆盖域名",
      passed: certOk && covers,
      detail: !cert ? "证书不存在" : !covers ? "证书 SAN 未覆盖该域名" : certOk ? "证书有效" : "证书已过期或即将过期",
    });
    if (!certOk || !covers) blockers.push("certificate");
  } else {
    checks.push({
      id: "certificate",
      label: "证书有效并覆盖域名",
      passed: false,
      detail: "尚未绑定证书",
    });
    blockers.push("certificate");
  }

  const conflict = await (database as any)(TENANT_DOMAIN_TABLE)
    .where({ hostname: domain.hostname })
    .whereNull("deletedAt")
    .whereNot({ id: domain.id })
    .first();
  const noConflict = !conflict;
  checks.push({
    id: "hostname_conflict",
    label: "Host 规则无冲突",
    passed: noConflict,
    detail: noConflict ? "无冲突" : "域名被其他记录占用",
  });
  if (!noConflict) blockers.push("hostname_conflict");

  // MT-P1-08：SNI 容量水位检查（90% 阻断普通激活）。
  const capacity = await listIngressCapacity(database);
  const blocking = capacity.filter((status) => status.watermark === "blocked");
  const capacityOk = blocking.length === 0;
  checks.push({
    id: "ingress_capacity",
    label: "入口 SNI 容量充足",
    passed: capacityOk,
    detail: capacityOk
      ? capacity.map((status) => `${status.name} ${status.sniUsed}/${status.sniQuota}`).join("；")
      : blocking.map((status) => `${status.name} 已达 ${Math.round(status.utilization * 100)}%`).join("；"),
  });
  if (!capacityOk) blockers.push("ingress_capacity");

  return {
    domain,
    passed: blockers.length === 0,
    blockers,
    checks,
  };
}

function domainCoversHostname(cert: any, hostname: string): boolean {
  try {
    const sans: string[] = JSON.parse(String(cert.sans || "[]"));
    const names = [String(cert.commonName || ""), ...sans].filter(Boolean);
    return names.some((name) => {
      if (name === hostname) return true;
      if (name.startsWith("*.")) {
        const suffix = name.slice(1);
        return hostname.endsWith(suffix) && hostname.length > suffix.length;
      }
      return false;
    });
  } catch {
    return false;
  }
}

export async function updateDomainIcpState(input: {
  domainId: string;
  icpState: DomainIcpState;
  operatorUserId?: number | null;
}): Promise<TenantDomainRecord> {
  const allowed: DomainIcpState[] = ["not_required", "pending", "verified", "rejected", "unknown"];
  if (!allowed.includes(input.icpState)) {
    throw new TenantDomainError("备案状态无效", 422, "DOMAIN_ICP_STATE_INVALID");
  }
  return await db.transaction(async (trx) => {
    const row = await trx(TENANT_DOMAIN_TABLE)
      .where({ id: input.domainId })
      .whereNull("deletedAt")
      .forUpdate()
      .first();
    if (!row) throw new TenantDomainError("域名不存在", 404, "DOMAIN_NOT_FOUND");
    const domain = rowToDomain(row);
    const timestamp = Date.now();
    await trx(TENANT_DOMAIN_TABLE)
      .where({ id: domain.id })
      .update({ icpState: input.icpState, updatedAt: timestamp, updatedByUserId: input.operatorUserId ?? null });
    const refreshed = await trx(TENANT_DOMAIN_TABLE).where({ id: domain.id }).first();
    return rowToDomain(refreshed);
  });
}

export type DomainOperationType =
  | "verify"
  | "issue"
  | "import"
  | "bind"
  | "activate"
  | "rotate"
  | "suspend"
  | "delete"
  | "reconcile";

export type TenantDomainOperationRecord = {
  id: string;
  idempotencyKey: string;
  tenantId: string;
  domainId: string | null;
  operationType: DomainOperationType;
  requestedRevision: number;
  state: "queued" | "running" | "succeeded" | "failed" | "compensating" | "cancelled";
  currentStep: string | null;
  attemptCount: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: number;
  finishedAt: number | null;
};

export async function listDomainOperations(
  database: DomainDb = db,
  filters: { domainId?: string; tenantId?: string } = {},
): Promise<TenantDomainOperationRecord[]> {
  const query = (database as any)(TENANT_DOMAIN_OPERATION_TABLE);
  if (filters.domainId) query.where({ domainId: filters.domainId });
  if (filters.tenantId) query.where({ tenantId: filters.tenantId });
  const rows = await query.orderBy("createdAt", "desc").limit(100);
  return rows.map((row: any) => ({
    id: String(row.id),
    idempotencyKey: String(row.idempotencyKey),
    tenantId: String(row.tenantId),
    domainId: row.domainId ? String(row.domainId) : null,
    operationType: String(row.operationType) as DomainOperationType,
    requestedRevision: Number(row.requestedRevision || 0),
    state: String(row.state) as TenantDomainOperationRecord["state"],
    currentStep: row.currentStep ? String(row.currentStep) : null,
    attemptCount: Number(row.attemptCount || 0),
    errorCode: row.errorCode ? String(row.errorCode) : null,
    errorMessage: row.errorMessage ? String(row.errorMessage) : null,
    createdAt: Number(row.createdAt || 0),
    finishedAt: row.finishedAt == null ? null : Number(row.finishedAt),
  }));
}
