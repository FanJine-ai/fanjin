import type { Knex } from "knex";

import { db } from "@/utils/db";
import { TENANT_DOMAIN_TABLE } from "@/lib/tenantDirectory";

export const INGRESS_CLUSTER_TABLE = "o_ingress_cluster";
export const TENANT_INGRESS_BINDING_TABLE = "o_tenant_ingress_binding";

export class TenantCapacityError extends Error {
  status: number;
  code: string;

  constructor(message: string, status = 400, code = "TENANT_CAPACITY_ERROR") {
    super(message);
    this.name = "TenantCapacityError";
    this.status = status;
    this.code = code;
  }
}

type CapacityDb = Knex | Knex.Transaction;

// ---------------------------------------------------------------------------
// MT-P1-08：SNI/证书容量治理（水位 70/80/90%，90% 阻断普通激活）
// ---------------------------------------------------------------------------

export type IngressCapacityStatus = {
  clusterId: string;
  name: string;
  region: string;
  sniQuota: number;
  sniUsed: number;
  utilization: number;
  watermark: "normal" | "warning" | "prepare_shard" | "blocked";
  detail: string;
};

const WARN_RATIO = 0.7;
const SHARD_RATIO = 0.8;
const BLOCK_RATIO = 0.9;

export async function listIngressCapacity(database: CapacityDb = db): Promise<IngressCapacityStatus[]> {
  const clusters = await (database as any)(INGRESS_CLUSTER_TABLE).orderBy("id", "asc");
  const boundDomains = await (database as any)(TENANT_DOMAIN_TABLE)
    .whereNull("deletedAt")
    .whereIn("lifecycleState", ["active", "activating", "ready"])
    .count("* as total")
    .first();
  // 0.1.4 第一阶段所有域名共用默认入口集群；集群表为空时按默认配额 20 计算。
  const totalBound = Number(boundDomains?.total || 0);
  const rows: IngressCapacityStatus[] = clusters.map((cluster: any) => {
    const quota = Number(cluster.sniQuota || 20);
    const used = quota > 0 && clusters.length === 1 ? totalBound : Number(cluster.sniUsed || 0);
    return buildCapacityStatus({
      clusterId: String(cluster.id),
      name: String(cluster.name || cluster.id),
      region: String(cluster.region || "cn-beijing"),
      sniQuota: quota,
      sniUsed: used,
    });
  });
  if (!rows.length) {
    rows.push(buildCapacityStatus({
      clusterId: "default",
      name: "默认入口集群",
      region: "cn-beijing",
      sniQuota: 20,
      sniUsed: totalBound,
    }));
  }
  return rows;
}

function buildCapacityStatus(input: {
  clusterId: string;
  name: string;
  region: string;
  sniQuota: number;
  sniUsed: number;
}): IngressCapacityStatus {
  const utilization = input.sniQuota > 0 ? input.sniUsed / input.sniQuota : 1;
  let watermark: IngressCapacityStatus["watermark"] = "normal";
  let detail = "容量正常";
  if (utilization >= BLOCK_RATIO) {
    watermark = "blocked";
    detail = `已达到 ${Math.round(utilization * 100)}%，阻断普通管理员继续激活域名`;
  } else if (utilization >= SHARD_RATIO) {
    watermark = "prepare_shard";
    detail = `已达到 ${Math.round(utilization * 100)}%，需准备新入口分片`;
  } else if (utilization >= WARN_RATIO) {
    watermark = "warning";
    detail = `已达到 ${Math.round(utilization * 100)}%，接近配额`;
  }
  return {
    clusterId: input.clusterId,
    name: input.name,
    region: input.region,
    sniQuota: input.sniQuota,
    sniUsed: input.sniUsed,
    utilization: Math.round(utilization * 1000) / 1000,
    watermark,
    detail,
  };
}

/**
 * 容量守卫：发布预检调用。达到 90% 水位时阻止普通管理员激活新域名；
 * 返回 null 表示通过。
 */
export async function assertIngressCapacityForActivation(
  database: CapacityDb = db,
  options: { allowRootOverride?: boolean } = {},
): Promise<IngressCapacityStatus | null> {
  const statuses = await listIngressCapacity(database);
  const blocking = statuses.filter((status) => status.watermark === "blocked");
  if (!blocking.length) return null;
  if (options.allowRootOverride) return blocking[0];
  throw new TenantCapacityError(
    `入口 SNI 配额已达阻断水位：${blocking.map((status) => `${status.name}（${status.sniUsed}/${status.sniQuota}）`).join(", ")}`,
    409,
    "INGRESS_CAPACITY_BLOCKED",
  );
}

/**
 * 资源标签治理：更新入口集群的用量缓存与标签。
 */
export async function refreshIngressClusterUsage(database: CapacityDb = db): Promise<{
  clusters: Array<{ id: string; sniUsed: number }>;
}> {
  const boundDomains = await (database as any)(TENANT_DOMAIN_TABLE)
    .whereNull("deletedAt")
    .whereIn("lifecycleState", ["active", "activating", "ready"])
    .count("* as total")
    .first();
  const totalBound = Number(boundDomains?.total || 0);
  const clusters = await (database as any)(INGRESS_CLUSTER_TABLE);
  const updated: Array<{ id: string; sniUsed: number }> = [];
  const timestamp = Date.now();
  if (!clusters.length) {
    // 单集群默认形态：保证用量可通过集群表读取。
    await (database as any)(INGRESS_CLUSTER_TABLE).insert({
      id: "default",
      name: "默认入口集群",
      environment: "production",
      provider: "volcengine_alb",
      region: "cn-beijing",
      loadBalancerId: null,
      httpListenerId: null,
      httpsListenerId: null,
      defaultServerGroupId: null,
      edition: null,
      networkType: null,
      sniQuota: 20,
      sniUsed: totalBound,
      status: "ready",
      credentialRef: null,
      metadata: "{}",
      createdAt: timestamp,
      updatedAt: timestamp,
    }).catch(async (error: unknown) => {
      const exists = await (database as any)(INGRESS_CLUSTER_TABLE).where({ id: "default" }).first();
      if (!exists) throw error;
      await (database as any)(INGRESS_CLUSTER_TABLE)
        .where({ id: "default" })
        .update({ sniUsed: totalBound, updatedAt: timestamp });
    });
    updated.push({ id: "default", sniUsed: totalBound });
    return { clusters: updated };
  }
  for (const cluster of clusters) {
    // 单集群阶段：所有绑定域名归入唯一集群；多集群后按绑定表精确分摊。
    const sniUsed = clusters.length === 1 ? totalBound : Number(cluster.sniUsed || 0);
    await (database as any)(INGRESS_CLUSTER_TABLE)
      .where({ id: cluster.id })
      .update({ sniUsed, updatedAt: timestamp });
    updated.push({ id: String(cluster.id), sniUsed });
  }
  return { clusters: updated };
}

// ---------------------------------------------------------------------------
// MT-P1-09：运维对账与漂移修复（期望 vs 观测）
// ---------------------------------------------------------------------------

export type DomainDriftRow = {
  domainId: string;
  hostname: string;
  tenantId: string;
  lifecycleState: string;
  desiredRevision: number;
  observedRevision: number;
  drifted: boolean;
  driftMs: number | null;
};

export type DriftReconcileReport = {
  scanned: number;
  drifted: number;
  rows: DomainDriftRow[];
  generatedAt: number;
};

/**
 * 漂移检测：desiredRevision != observedRevision 的域名。
 * driftMs 为自最近一次更新以来的漂移持续时长。
 */
export async function domainDriftReport(database: CapacityDb = db): Promise<DriftReconcileReport> {
  const rows = await (database as any)(TENANT_DOMAIN_TABLE)
    .whereNull("deletedAt")
    .orderBy("updatedAt", "desc");
  const now = Date.now();
  const driftRows: DomainDriftRow[] = rows.map((row: any) => ({
    domainId: String(row.id),
    hostname: String(row.hostname),
    tenantId: String(row.tenantId),
    lifecycleState: String(row.lifecycleState),
    desiredRevision: Number(row.desiredRevision || 1),
    observedRevision: Number(row.observedRevision || 0),
    drifted: Number(row.desiredRevision || 1) !== Number(row.observedRevision || 0),
    driftMs: Number(row.desiredRevision || 1) !== Number(row.observedRevision || 0)
      ? now - Number(row.updatedAt || now)
      : null,
  }));
  return {
    scanned: driftRows.length,
    drifted: driftRows.filter((row) => row.drifted).length,
    rows: driftRows,
    generatedAt: now,
  };
}

/**
 * 受控 reconcile：把指定域名的观测版本同步到期望版本。
 * 云端真实同步在 ALB 编排器授权后接入；当前阶段完成数据库侧收敛与审计记录，
 * 云端步骤以 pendingCloudSteps 返回。
 */
export async function reconcileDomainDrift(input: {
  domainId: string;
  operatorUserId?: number | null;
}): Promise<{
  domainId: string;
  reconciled: boolean;
  previousObservedRevision: number;
  observedRevision: number;
  pendingCloudSteps: string[];
}> {
  return await db.transaction(async (trx) => {
    const row = await trx(TENANT_DOMAIN_TABLE)
      .where({ id: input.domainId })
      .whereNull("deletedAt")
      .forUpdate()
      .first();
    if (!row) throw new TenantCapacityError("域名不存在", 404, "DOMAIN_NOT_FOUND");
    const desired = Number(row.desiredRevision || 1);
    const observed = Number(row.observedRevision || 0);
    if (desired === observed) {
      return {
        domainId: String(row.id),
        reconciled: false,
        previousObservedRevision: observed,
        observedRevision: observed,
        pendingCloudSteps: [],
      };
    }
    const timestamp = Date.now();
    await trx(TENANT_DOMAIN_TABLE)
      .where({ id: row.id, observedRevision: observed })
      .update({ observedRevision: desired, updatedAt: timestamp, updatedByUserId: input.operatorUserId ?? null });
    await trx("o_tenant_domain_operation").insert({
      id: (await import("uuid")).v4(),
      idempotencyKey: `reconcile:${row.id}:${desired}:${timestamp}`,
      tenantId: String(row.tenantId),
      domainId: String(row.id),
      operationType: "reconcile",
      requestedRevision: desired,
      state: "succeeded",
      currentStep: null,
      attemptCount: 1,
      nextAttemptAt: null,
      requestedByUserId: input.operatorUserId ?? null,
      approvedByUserId: null,
      result: JSON.stringify({ previousObservedRevision: observed }),
      errorCode: null,
      errorMessage: null,
      createdAt: timestamp,
      startedAt: timestamp,
      finishedAt: timestamp,
      updatedAt: timestamp,
    });
    const cloudEnabled = String(process.env.FANJIN_TENANT_INGRESS_CLOUD_ENABLED || "") === "1";
    return {
      domainId: String(row.id),
      reconciled: true,
      previousObservedRevision: observed,
      observedRevision: desired,
      pendingCloudSteps: cloudEnabled ? [] : ["sync_alb_domain_extension", "sync_alb_host_rule", "public_probe"],
    };
  });
}

// ---------------------------------------------------------------------------
// MT-P1-06：证书到期告警扫描（45/30/14/7/3/1 天窗口）
// ---------------------------------------------------------------------------

export type CertificateAlertRow = {
  certificateId: string;
  tenantId: string;
  commonName: string | null;
  daysRemaining: number;
  severity: "high" | "critical";
  alertContacts: string[];
};

const ALERT_WINDOWS = [45, 30, 14, 7, 3, 1];

export async function certificateExpiryAlertScan(database: CapacityDb = db): Promise<{
  alerts: CertificateAlertRow[];
  scanned: number;
}> {
  const now = Date.now();
  const maxWindow = Math.max(...ALERT_WINDOWS) * 24 * 60 * 60 * 1000;
  const rows = await (database as any)("o_tenant_certificate")
    .whereIn("status", ["active", "expiring", "issued"])
    .whereNotNull("notAfter")
    .where("notAfter", ">", now)
    .where("notAfter", "<=", now + maxWindow);
  const tenantRows = await (database as any)("o_commercial_tenant").whereNull("deletedAt");
  const contactsByTenant = new Map<string, string[]>();
  for (const tenantRow of tenantRows) {
    let brand: any = null;
    try {
      brand = (JSON.parse(String(tenantRow.legalProfile || "{}")) || {}).brand;
    } catch {
      brand = null;
    }
    const contacts = Array.isArray(brand?.alertContacts)
      ? brand.alertContacts.map((item: unknown) => String(item).trim()).filter(Boolean)
      : [];
    contactsByTenant.set(String(tenantRow.id), contacts);
  }
  const alerts: CertificateAlertRow[] = rows.map((row: any) => {
    const daysRemaining = Math.max(0, Math.floor((Number(row.notAfter) - now) / (24 * 60 * 60 * 1000)));
    return {
      certificateId: String(row.id),
      tenantId: String(row.tenantId),
      commonName: row.commonName ? String(row.commonName) : null,
      daysRemaining,
      severity: daysRemaining <= 14 ? "critical" : "high",
      alertContacts: contactsByTenant.get(String(row.tenantId)) || [],
    };
  });
  // 进入 45 天到期窗口的证书全部产生告警；severity 区分 <=14 天高风险。
  return { alerts, scanned: rows.length };
}

// ---------------------------------------------------------------------------
// MT-P1-05/07：认证回调与媒体 CORS 配置校验
// ---------------------------------------------------------------------------

export type CallbackValidationResult = {
  ok: boolean
  issues: Array<{ url: string; issue: string }>;
};

/**
 * 校验回调 URL 是否属于该租户的已激活域名（auth/callback 用途或任意 active 域名）。
 * 防止把回调注册到未验证/他租户域名。
 */
export async function validateTenantCallbackUrls(input: {
  tenantId: string;
  urls: string[];
  database?: CapacityDb;
}): Promise<CallbackValidationResult> {
  const database = input.database ?? db;
  const domains = await (database as any)(TENANT_DOMAIN_TABLE)
    .where({ tenantId: input.tenantId, lifecycleState: "active" })
    .whereNull("deletedAt")
    .select("hostname", "purpose");
  const allowedHosts = new Set<string>();
  const authHosts = new Set<string>();
  for (const domain of domains) {
    allowedHosts.add(String(domain.hostname));
    if (String(domain.purpose) === "auth" || String(domain.purpose) === "callback") {
      authHosts.add(String(domain.hostname));
    }
  }
  const issues: Array<{ url: string; issue: string }> = [];
  for (const raw of input.urls) {
    let url: URL;
    try {
      url = new URL(String(raw));
    } catch {
      issues.push({ url: String(raw), issue: "URL 无法解析" });
      continue;
    }
    if (url.protocol !== "https:") {
      issues.push({ url: String(raw), issue: "回调 URL 必须使用 HTTPS" });
      continue;
    }
    if (!allowedHosts.has(url.hostname)) {
      issues.push({ url: String(raw), issue: "回调主机不属于该租户的已激活域名" });
    }
  }
  return { ok: issues.length === 0, issues };
}

/**
 * 生成媒体用途的 CORS 允许源清单（active 租户 × media 用途域名）。
 * 网关/对象存储按此清单精确放行，禁止 * + credentials。
 */
export async function mediaCorsAllowedOrigins(database: CapacityDb = db): Promise<{
  origins: string[];
  tenants: Array<{ tenantId: string; origins: string[] }>;
}> {
  const rows = await (database as any)({
    d: TENANT_DOMAIN_TABLE,
  })
    .join("o_commercial_tenant as t", "t.id", "d.tenantId")
    .whereNull("d.deletedAt")
    .whereNull("t.deletedAt")
    .where({ "d.lifecycleState": "active", "t.status": "active" })
    .where("d.purpose", "media")
    .select("d.tenantId", "d.hostname");
  const byTenant = new Map<string, string[]>();
  const origins: string[] = [];
  for (const row of rows) {
    const tenantId = String(row.tenantId);
    const origin = `https://${String(row.hostname)}`;
    if (!byTenant.has(tenantId)) byTenant.set(tenantId, []);
    byTenant.get(tenantId)!.push(origin);
    origins.push(origin);
  }
  return {
    origins,
    tenants: [...byTenant.entries()].map(([tenantId, tenantOrigins]) => ({ tenantId, origins: tenantOrigins })),
  };
}

// ---------------------------------------------------------------------------
// MT-P1-06：邮件域名 SPF/DKIM/DMARC 配置指引
// ---------------------------------------------------------------------------

export type MailDnsGuidance = {
  hostname: string;
  tenantId: string | null;
  records: Array<{
    type: "TXT" | "CNAME";
    name: string;
    value: string;
    purpose: "SPF" | "DKIM" | "DMARC";
    note: string;
  }>;
  warning: string | null;
};

/**
 * 为租户发件域名生成 SPF/DKIM/DMARC DNS 记录指引。
 * - 域名必须已登记（任意租户或待验证状态也允许生成指引，便于部署前准备）
 * - DKIM 选择器固定 fanjin2026，CNAME 指向平台托管 DKIM 域
 * - DMARC 默认 p=none 监视策略，聚合报告发给租户告警联系人（若配置）
 */
export async function mailDnsGuidance(input: {
  hostname: string;
  database?: CapacityDb;
}): Promise<MailDnsGuidance> {
  const database = input.database ?? db;
  const hostname = String(input.hostname || "").trim().toLowerCase().replace(/\.$/, "");
  if (!hostname || !/^[a-z0-9.-]+$/.test(hostname) || !hostname.includes(".")) {
    throw new TenantCapacityError("发件域名格式无效", 422, "MAIL_HOSTNAME_INVALID");
  }
  const domainRow = await (database as any)(TENANT_DOMAIN_TABLE)
    .where({ hostname })
    .whereNull("deletedAt")
    .first();
  const tenantId = domainRow ? String(domainRow.tenantId) : null;

  let alertContacts: string[] = [];
  if (tenantId) {
    const tenantRow = await (database as any)("o_commercial_tenant")
      .where({ id: tenantId })
      .whereNull("deletedAt")
      .first();
    if (tenantRow) {
      try {
        const brand = (JSON.parse(String(tenantRow.legalProfile || "{}")) || {}).brand;
        if (Array.isArray(brand?.alertContacts)) {
          alertContacts = brand.alertContacts.map((item: unknown) => String(item).trim()).filter(Boolean);
        }
      } catch {
        alertContacts = [];
      }
    }
  }

  const mailFromDomain = `mail.${hostname}`;
  const records: MailDnsGuidance["records"] = [
    {
      type: "TXT",
      name: hostname,
      value: "v=spf1 include:spm.fanjin-mail.top -all",
      purpose: "SPF",
      note: "授权平台邮件发送源；严格 -all 拒绝其他来源伪造",
    },
    {
      type: "CNAME",
      name: `fanjin2026._domainkey.${hostname}`,
      value: "fanjin2026._domainkey.dkim.fanjin-mail.top",
      purpose: "DKIM",
      note: "DKIM 签名公钥由平台托管轮换，CNAME 委托后无需手工更新",
    },
    {
      type: "TXT",
      name: `_dmarc.${hostname}`,
      value: alertContacts.length
        ? `v=DMARC1; p=none; rua=mailto:${alertContacts[0]}`
        : "v=DMARC1; p=none",
      purpose: "DMARC",
      note: alertContacts.length
        ? `监视策略，聚合报告发送至租户告警联系人 ${alertContacts[0]}`
        : "监视策略；配置租户告警联系人后建议追加 rua=mailto: 接收聚合报告",
    },
  ];

  return {
    hostname,
    tenantId,
    records,
    warning: domainRow ? null : "该域名尚未在租户域名管理中登记，指引仅供部署前准备",
  };
}
