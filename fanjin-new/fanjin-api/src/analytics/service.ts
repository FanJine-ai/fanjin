import { internalModelId, publicModelId } from "@/lib/minimaxH3PublicIdentity";
import { createAnalyticsExportService } from "./exportJobs";
import { customerBillingEvidence } from "./billingEvidence";
import { createHash } from "node:crypto";
import type { Knex } from "knex";
import { getEffectiveWorkspacePermissions } from "@/middleware/permissions";
import { getConsistentWorkspaceRole } from "@/lib/workspaceOwnership";
import { GU_UNITS, guAmount, ledgerAmount } from "@/tools/contracts";
import { AnalyticsError, analyticsInputSchema, type AnalyticsInput, type AnalyticsAction } from "./contracts";

export type AnalyticsSubject = {
  userId: number;
  workspaceId?: string;
  keyId?: string;
  keyPermissions?: string[];
};
type Access = AnalyticsSubject & { scope: "account" | "workspace"; financial: boolean; allUsage: boolean; allowedWorkspaceIds: string[] };
const permits = (values: string[], permission: string) => values.some(p => p === "*" || p === permission || p.endsWith(":*") && permission.startsWith(p.slice(0, -1)));
const parse = (raw: unknown): Record<string, any> => { try { const v = typeof raw === "string" ? JSON.parse(raw) : raw; return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch { return {}; } };
const amount = (value: unknown) => guAmount(ledgerAmount(value ?? 0));
const atom = (value: unknown) => ledgerAmount(value ?? 0);
const plain = (value: unknown) => value == null ? null : String(value).slice(0, 200);
const dayMs = 86_400_000;

export function analyticsRange(input: AnalyticsInput, now: number) {
  const china = new Date(now + 8 * 3600_000);
  const monthStart = Date.UTC(china.getUTCFullYear(), china.getUTCMonth(), 1) - 8 * 3600_000;
  const from = input.from ?? monthStart, to = input.to ?? now;
  if (from >= to || to - from > 366 * dayMs || to > now + 60_000) throw new AnalyticsError("INVALID_RANGE", "请选择一年以内的有效时间范围");
  return { from, to };
}

export type AnalyticsAudit = (subject: AnalyticsSubject, input: AnalyticsInput, rows: number, snapshotAt: number) => Promise<void>;
export function createAnalyticsService(db: Knex, now = Date.now, audit?: AnalyticsAudit) {
  async function authorize(subject: AnalyticsSubject, input: AnalyticsInput): Promise<Access> {
    const user = await db("o_user").where({ id: subject.userId, status: "active" }).first();
    if (!user) throw new AnalyticsError("ACCOUNT_UNAVAILABLE", "账号不可用", 401);
    // Tool service revalidates credentials; direct API and web queries also pass
    // through this live membership check instead of trusting a cached role.
    let keyPermissions = subject.keyPermissions;
    if (subject.keyId) {
      const key = await db("o_api_key").where({ id: subject.keyId, ownerUserId: subject.userId, workspaceId: subject.workspaceId, scope: "workspace", disabled: 0 }).first();
      if (!key || Number(key.revokedAt || 0) || Number(key.expiresAt || 0) < 0 || !Number.isFinite(Number(key.expiresAt || 0)) || Number(key.expiresAt || 0) > 0 && Number(key.expiresAt) <= now()) throw new AnalyticsError("KEY_UNAVAILABLE", "密钥已失效", 401);
      try { keyPermissions = JSON.parse(key.permissions || "[]"); } catch { keyPermissions = []; }
      if (!Array.isArray(keyPermissions) || !keyPermissions.every(p => typeof p === "string")) throw new AnalyticsError("PERMISSION_DENIED", "密钥权限无效", 403);
    }
    const keyAllows = (permission: string) => !subject.keyId || permits(keyPermissions || [], permission);
    const memberships = await db("o_workspace_member as m").join("o_workspace as w", "w.id", "m.workspaceId")
      .where({ "m.userId": subject.userId, "m.status": "active", "w.status": "active" })
      .select("m.workspaceId", "m.role", "m.permissions", "w.ownerUserId");
    const active = memberships.filter(m => getConsistentWorkspaceRole({ userId: subject.userId, memberRole: m.role, ownerUserId: m.ownerUserId }));
    if (subject.keyId && !active.some(m => m.workspaceId === subject.workspaceId)) throw new AnalyticsError("MEMBERSHIP_REQUIRED", "工作区成员身份已失效", 403);
    if (input.scope === "account") {
      if (!keyAllows("account:read")) throw new AnalyticsError("PERMISSION_DENIED", "需单独授权账号数据读取", 403);
      if (input.memberId && input.memberId !== subject.userId) throw new AnalyticsError("PERMISSION_DENIED", "账号范围只能查询本人", 403);
      return { ...subject, keyPermissions, scope: "account", financial: true, allUsage: false, allowedWorkspaceIds: active.map(m => String(m.workspaceId)) };
    }
    const workspaceId = input.workspaceId || subject.workspaceId;
    if (!workspaceId || subject.keyId && workspaceId !== subject.workspaceId) throw new AnalyticsError("WORKSPACE_CONTEXT_MISMATCH", "工作区与凭据范围不一致", 403);
    const platform = !subject.keyId && ["root", "admin", "super_admin"].includes(user.role);
    if (!platform && workspaceId !== subject.workspaceId) throw new AnalyticsError("WORKSPACE_CONTEXT_MISMATCH", "请先切换工作区", 403);
    const workspace = await db("o_workspace").where({ id: workspaceId, status: "active" }).first();
    const membership = active.find(m => m.workspaceId === workspaceId);
    if (!workspace || !platform && !membership) throw new AnalyticsError("MEMBERSHIP_REQUIRED", "工作区不可访问", 403);
    const permissions = platform ? ["*"] : getEffectiveWorkspacePermissions(membership!);
    if (!permits(permissions, "workspace:read")) throw new AnalyticsError("PERMISSION_DENIED", "无权读取工作区", 403);
    const financial = permits(permissions, "billing:read") && keyAllows("billing:read");
    const allUsage = !subject.keyId
      ? financial || permits(permissions, "api_key:read")
      : permits(keyPermissions || [], "usage:read:workspace") && (permits(permissions, "api_key:read") || permits(permissions, "billing:read"));
    if (subject.keyId && !keyAllows("usage:read") && !keyAllows("usage:read:workspace") && !financial) throw new AnalyticsError("PERMISSION_DENIED", "密钥未授权用量读取", 403);
    if (!allUsage && (input.memberId && input.memberId !== subject.userId || subject.keyId && input.apiKeyId && input.apiKeyId !== subject.keyId)) throw new AnalyticsError("PERMISSION_DENIED", "不能扩大明细读取范围", 403);
    return { ...subject, keyPermissions, workspaceId, scope: "workspace", financial, allUsage, allowedWorkspaceIds: [workspaceId] };
  }

  const sourceSql = `CASE WHEN ?? IN ('mcp','cli','api') THEN ?? WHEN ?? LIKE '/api/mcp%' THEN 'mcp' WHEN ?? LIKE 'fanjin-cli/%' THEN 'cli' WHEN ?? IS NOT NULL THEN 'api' WHEN COALESCE(??, ??) IS NOT NULL THEN 'web' ELSE 'unknown' END`;
  const sourceArgs = ["operation.origin", "operation.origin", "log.path", "log.userAgent", "u.apiKeyId", "money.actorId", "log.actorUserId"];
  const executionSql = `CASE WHEN "task"."status" IN ('succeeded','completed','success') THEN 'succeeded' WHEN "task"."status" IN ('cancelled','canceled') THEN 'cancelled' WHEN "task"."status" IN ('submitted','running','processing') THEN 'running' WHEN "task"."status" IN ('failed','expired','queued') THEN "task"."status" ELSE 'unknown' END`;
  const failureSql = `CASE
    WHEN "task"."status" IN ('cancelled','canceled') THEN 'cancelled'
    WHEN "task"."status" = 'expired' THEN 'expired'
    WHEN "task"."status" <> 'failed' OR "task"."status" IS NULL THEN NULL
    WHEN LOWER(COALESCE("task"."errorMessage", '')) LIKE '%policy%' OR LOWER(COALESCE("task"."errorMessage", '')) LIKE '%moderation%' OR "task"."errorMessage" LIKE '%审核%' OR "task"."errorMessage" LIKE '%违规%' THEN 'policy'
    WHEN LOWER(COALESCE("task"."errorMessage", '')) LIKE '%invalid%' OR "task"."errorMessage" LIKE '%参数%' OR "task"."errorMessage" LIKE '%素材%' THEN 'invalid_input'
    WHEN LOWER(COALESCE("task"."errorMessage", '')) LIKE '%rate_limit%' OR LOWER(COALESCE("task"."errorMessage", '')) LIKE '%too many%' OR "task"."errorMessage" LIKE '%限流%' THEN 'rate_limit'
    WHEN LOWER(COALESCE("task"."errorMessage", '')) LIKE '%timeout%' OR LOWER(COALESCE("task"."errorMessage", '')) LIKE '%timed out%' OR "task"."errorMessage" LIKE '%超时%' THEN 'timeout'
    WHEN LOWER(COALESCE("task"."errorMessage", '')) LIKE '%upstream%' OR "task"."errorMessage" LIKE '%上游%' THEN 'upstream'
    ELSE 'unknown' END`;
  // Joining one POST log per task prevents task polls/retries multiplying usage.
  function usageBase(a: Access, input: AnalyticsInput, range: { from: number; to: number }) {
    const logIds = db("o_request_log").whereIn("workspaceId", a.allowedWorkspaceIds).where({ method: "POST" }).whereNotNull("relayTaskId")
      .select("workspaceId", "relayTaskId").min({ logId: "id" }).groupBy("workspaceId", "relayTaskId");
    const uniqueTaskUsage = db("o_usage_record").whereIn("workspaceId", a.allowedWorkspaceIds).whereNotNull("taskId")
      .select("workspaceId", "taskId").min({ usageId: "id" }).groupBy("workspaceId", "taskId").havingRaw("COUNT(*) = 1");
    const moneyRows = db("o_billing_ledger as l").whereIn("l.workspaceId", a.allowedWorkspaceIds).whereIn("l.type", ["deduct", "refund"])
      .leftJoin("o_billing_ledger as original", function() { this.on("original.id", "l.relatedLedgerId").andOn("original.workspaceId", "l.workspaceId"); })
      .leftJoin(uniqueTaskUsage.as("uniqueUsage"), function() { this.on("uniqueUsage.taskId", db.raw("COALESCE(??, ??)", ["l.relatedTaskId", "l.taskId"])).andOn("uniqueUsage.workspaceId", "l.workspaceId"); })
      .select("l.workspaceId", "l.type", "l.amountMicros", "l.createdBy", "l.requestId")
      .select(db.raw("COALESCE(??, ??, ??) as ??", ["l.relatedUsageId", "original.relatedUsageId", "uniqueUsage.usageId", "relatedUsageId"]));
    const money = db.from(moneyRows.as("m")).whereNotNull("relatedUsageId").select("workspaceId", "relatedUsageId")
      .sum({ charged: db.raw("CASE WHEN ?? = 'deduct' THEN ?? ELSE NULL END", ["type", "amountMicros"]), refunded: db.raw("CASE WHEN ?? = 'refund' THEN ?? ELSE 0 END", ["type", "amountMicros"]) })
      .min({ actorId: db.raw("CASE WHEN ?? = 'deduct' THEN ?? ELSE NULL END", ["type", "createdBy"]), requestId: "requestId" }).groupBy("workspaceId", "relatedUsageId");
    const origin = String(db.client.config.client).includes("pg") ? db.raw("??::jsonb ->> '_source'", ["requestJson"]) : db.raw("json_extract(??, '$._source')", ["requestJson"]);
    const operations = db("o_external_tool_operation").whereIn("workspaceId", a.allowedWorkspaceIds).where({ kind: "fanjin_generation_submit" }).whereNotNull("relayTaskId")
      .select("workspaceId", "relayTaskId").min({ origin, actorId: "userId" }).groupBy("workspaceId", "relayTaskId");
    const q = db("o_usage_record as u")
      .leftJoin(operations.as("operation"), function() { this.on("operation.relayTaskId", "u.taskId").andOn("operation.workspaceId", "u.workspaceId"); })
      .leftJoin("o_relay_task as task", function() { this.on("task.id", "u.taskId").andOn("task.workspaceId", "u.workspaceId"); })
      .leftJoin(logIds.as("logIds"), function() { this.on("logIds.relayTaskId", "u.taskId").andOn("logIds.workspaceId", "u.workspaceId"); })
      .leftJoin("o_request_log as log", "log.id", "logIds.logId")
      .leftJoin("o_api_key as key", function() { this.on("key.id", "u.apiKeyId").andOn("key.workspaceId", "u.workspaceId"); })
      .leftJoin(money.as("money"), function() { this.on("money.relatedUsageId", "u.id").andOn("money.workspaceId", "u.workspaceId"); })
      .whereIn("u.workspaceId", a.allowedWorkspaceIds).where("u.createTime", ">=", range.from).where("u.createTime", "<", range.to);
    if (a.scope === "account" || !a.allUsage) {
      if (a.keyId && a.scope === "workspace") q.where("u.apiKeyId", a.keyId);
      else q.whereRaw("COALESCE(??, ??, ??, ??) = ?", ["operation.actorId", "money.actorId", "key.ownerUserId", "log.actorUserId", a.userId]);
    }
    if (input.workspaceId) q.where("u.workspaceId", input.workspaceId);
    if (input.projectId) q.where("task.projectId", input.projectId);
    if (input.memberId) q.whereRaw("COALESCE(??, ??, ??, ??) = ?", ["operation.actorId", "money.actorId", "key.ownerUserId", "log.actorUserId", input.memberId]);
    if (input.apiKeyId) q.where("u.apiKeyId", input.apiKeyId);
    if (input.model) q.where("u.model", internalModelId(input.model));
    if (input.source) q.whereRaw(`${sourceSql} = ?`, [...sourceArgs, input.source]);
    if (input.status) q.where("u.status", input.status);
    if (input.executionStatus) {
      const states = input.executionStatus === "unsuccessful" ? ["failed", "cancelled", "expired"] : input.executionStatus === "unfinished" ? ["queued", "running", "unknown"] : [input.executionStatus];
      q.whereRaw(`(${executionSql}) IN (${states.map(() => "?").join(",")})`, states);
    }
    if (input.failureCategory) q.whereRaw(`(${failureSql}) = ?`, [input.failureCategory]);
    if (input.query) q.where(function() { this.where("u.id", input.query!).orWhere("u.taskId", input.query!).orWhere("task.requestId", input.query!).orWhere("log.requestId", input.query!).orWhere("money.requestId", input.query!); });
    return q.select("u.id", "u.workspaceId", "u.taskId", "u.model", "u.endpointType", "u.unit", "u.units", "u.status as billingStatus", "u.createTime as createdAt", "u.apiKeyId", "task.projectId", "key.name as keyName")
      .select(db.raw(`${executionSql} as "executionStatus"`), db.raw(`${failureSql} as "failureCategory"`))
      .select(db.raw('CASE WHEN "task"."submittedAt" >= "task"."createTime" THEN "task"."submittedAt" - "task"."createTime" ELSE NULL END as "queueMs"'))
      .select(db.raw('CASE WHEN "task"."completedAt" >= "task"."submittedAt" THEN "task"."completedAt" - "task"."submittedAt" ELSE NULL END as "executionMs"'))
      .select(db.raw("COALESCE(??, ??, ??, ??) as ??", ["operation.actorId", "money.actorId", "key.ownerUserId", "log.actorUserId", "memberId"]))
      .select(db.raw("COALESCE(??, ??, ??) as ??", ["task.requestId", "log.requestId", "money.requestId", "requestId"]))
      .select(db.raw(`${sourceSql} as ??`, [...sourceArgs, "source"]))
      .select(db.raw("CASE WHEN ?? IS NOT NULL AND ?? IS NOT NULL THEN ?? - ?? ELSE ?? END as ??", ["task.completedAt", "task.submittedAt", "task.completedAt", "task.submittedAt", "log.durationMs", "durationMs"]))
      .select(db.raw("COALESCE(??, CASE WHEN ?? IN ('charged','free','refunded') THEN ?? ELSE 0 END) as ??", ["money.charged", "u.status", "u.costMicros", "chargedMicros"]))
      .select(db.raw("COALESCE(??, 0) as ??", ["money.refunded", "refundedMicros"]));
  }

  function ledgerBase(a: Access, input: AnalyticsInput, range: { from: number; to: number }) {
    if (!a.financial) throw new AnalyticsError("PERMISSION_DENIED", "资金流水需要财务读取权限", 403);
    const account = a.scope === "account";
    if (input.executionStatus || input.failureCategory || input.projectId || input.memberId || input.model || input.source || account && (input.apiKeyId || input.status)) throw new AnalyticsError("UNSUPPORTED_LEDGER_FILTER", "资金流水不支持调用属性筛选，请在调用明细中查询");
    const q = db(account ? "o_account_wallet_ledger" : "o_billing_ledger");
    if (account) q.where({ userId: a.userId }); else q.where({ workspaceId: a.workspaceId });
    if (!account && a.keyId && !a.allUsage) q.where({ apiKeyId: a.keyId });
    q.where("createdAt", ">=", range.from).where("createdAt", "<", range.to);
    if (input.workspaceId) q.where("workspaceId", input.workspaceId);
    if (input.status && !account) q.where("status", input.status);
    if (input.apiKeyId && !account) q.where("apiKeyId", input.apiKeyId);
    if (input.query) q.where(function() { this.where("id", input.query!).orWhere("requestId", input.query!); });
    return q;
  }

  function cursorState(a: Access, input: AnalyticsInput, kind: string) {
    const { cursor, limit, format, ...filters } = input;
    const hash = createHash("sha256").update(JSON.stringify([a.userId, a.keyId ?? null, a.workspaceId ?? null, a.allUsage, a.financial, kind, filters])).digest("hex");
    let snapshot = now(), after: { at: number; id: string } | null = null;
    if (cursor) {
      try {
        const c = JSON.parse(Buffer.from(cursor, "base64url").toString());
        if (c.hash !== hash || !Number.isSafeInteger(c.snapshot) || c.snapshot > now() || now() - c.snapshot > dayMs || !Number.isSafeInteger(c.at) || typeof c.id !== "string" || c.id.length > 128) throw new Error();
        snapshot = c.snapshot; after = { at: c.at, id: c.id };
      } catch { throw new AnalyticsError("INVALID_CURSOR", "分页游标已过期或不属于当前查询"); }
    }
    return { snapshot, after, next: (r: any) => Buffer.from(JSON.stringify({ hash, snapshot, at: Number(r.createdAt), id: r.id })).toString("base64url") };
  }
  function usageView(row: any, financial: boolean) {
    return { id: row.id, workspaceId: row.workspaceId, taskId: row.taskId ?? null, requestId: row.requestId ?? null, projectId: row.projectId == null ? null : Number(row.projectId),
      memberId: row.memberId == null ? null : Number(row.memberId), apiKeyId: row.apiKeyId ?? null, keyName: plain(row.keyName), model: publicModelId(plain(row.model)), endpointType: row.endpointType,
      source: row.source, unit: row.unit, units: Number(row.units || 0), billingStatus: row.billingStatus, executionStatus: row.executionStatus || "unknown",
      failureCategory: row.failureCategory ?? null, queueMs: row.queueMs == null ? null : Number(row.queueMs),
      durationMs: row.durationMs == null ? null : Math.max(0, Number(row.durationMs)), createdAt: Number(row.createdAt),
      ...(financial ? { charged: amount(row.chargedMicros), refunded: amount(row.refundedMicros), net: guAmount(atom(row.chargedMicros) - atom(row.refundedMicros)) } : {}) };
  }
  function ledgerView(row: any) {
    const metadata = parse(row.metadata);
    const type = row.type === "recharge" && metadata.refundWorkspaceLedgerOriginalId && metadata.originalOwnerWalletLedgerId ? "refund" : row.type;
    return { id: row.id, workspaceId: row.workspaceId, type, direction: row.direction, amount: amount(row.amountMicros), currency: row.currency,
      createdAt: Number(row.createdAt), status: row.status || row.type, requestId: row.requestId ?? null, taskId: row.relatedTaskId || row.taskId || null,
      usageId: row.relatedUsageId || null, ...(row.reservedBefore != null ? { reservedBefore: amount(row.reservedBefore) } : {}), ...(row.reservedAfter != null ? { reservedAfter: amount(row.reservedAfter) } : {}), balanceBefore: amount(row.balanceBeforeMicros ?? row.balanceBefore), balanceAfter: amount(row.balanceAfterMicros ?? row.balanceAfter) };
  }
  async function list(a: Access, input: AnalyticsInput, kind: "usage" | "ledger") {
    const cursor = cursorState(a, input, kind), range = analyticsRange(input, cursor.snapshot);
    const base = kind === "usage" ? usageBase(a, input, range) : ledgerBase(a, input, range).select("*");
    const q = db.from(base.as("r")).where("r.createdAt", "<", cursor.snapshot);
    if (cursor.after) q.where(function() { this.where("r.createdAt", "<", cursor.after!.at).orWhere(function() { this.where("r.createdAt", cursor.after!.at).andWhere("r.id", "<", cursor.after!.id); }); });
    const rows = await q.orderBy("r.createdAt", "desc").orderBy("r.id", "desc").limit(input.limit + 1);
    const selected = rows.slice(0, input.limit);
    return { items: selected.map(r => kind === "usage" ? usageView(r, a.financial) : ledgerView(r)), nextCursor: rows.length > input.limit ? cursor.next(selected.at(-1)) : null,
      snapshotAt: cursor.snapshot, range, scope: a.scope, workspaceId: a.scope === "workspace" ? a.workspaceId : null, financialVisible: a.financial, units: GU_UNITS };
  }

  async function balance(a: Access) {
    if (!a.financial) return { scope: a.scope, financialVisible: false, available: null, units: GU_UNITS };
    if (a.scope === "workspace") {
      const account = await db("o_billing_account").where({ workspaceId: a.workspaceId }).first();
      if (!account) return { scope: a.scope, financialVisible: true, available: null, status: "not_initialized", units: GU_UNITS };
      const { readWorkspaceAvailableMicros } = await import("@/lib/billing");
      const available = await readWorkspaceAvailableMicros(a.workspaceId!, db);
      return { scope: a.scope, financialVisible: true, workspaceId: a.workspaceId, status: account.status,
        available: available == null ? null : amount(available), quota: amount(account.balanceMicros), frozen: amount(account.reservedMicros),
        includesRestrictedModelGifts: false, units: GU_UNITS };
    }
    const wallet = await db("o_account_wallet").where({ userId: a.userId }).first();
    const grants = await db("o_account_gift_grant").where({ userId: a.userId, status: "active" }).where("remainingMicros", ">", 0)
      .where(q => q.whereNull("expiresAt").orWhere("expiresAt", ">", now())).orderBy("expiresAt", "asc");
    const positive = (n: bigint) => n > 0n ? n : 0n;
    const cash = positive(atom(wallet?.balanceMicros) - atom(wallet?.cashReservedMicros));
    const gift = grants.reduce((sum, g) => sum + positive(atom(g.remainingMicros) - atom(g.reservedMicros)), 0n);
    const credit = positive(atom(wallet?.creditLimitMicros) - atom(wallet?.creditUsedMicros) - atom(wallet?.creditReservedMicros));
    const frozen = atom(wallet?.cashReservedMicros) + atom(wallet?.giftReservedMicros) + atom(wallet?.creditReservedMicros);
    const expiring = grants.filter(g => g.expiresAt && Number(g.expiresAt) <= now() + 7 * dayMs).reduce((sum, g) => sum + positive(atom(g.remainingMicros) - atom(g.reservedMicros)), 0n);
    return { scope: a.scope, financialVisible: true, status: wallet?.status || "not_initialized", available: wallet?.status === "active" ? guAmount(cash + gift + credit) : null,
      cash: guAmount(cash), gift: guAmount(gift), credit: guAmount(credit), frozen: guAmount(frozen), expiring: guAmount(expiring),
      gifts: grants.slice(0, 100).map(g => ({ id: g.id, name: plain(g.campaignName) || "赠送额度", remaining: guAmount(positive(atom(g.remainingMicros) - atom(g.reservedMicros))), expiresAt: g.expiresAt == null ? null : Number(g.expiresAt),
        model: publicModelId(plain(parse(parse(g.metadata).membership).model)), workspaceId: plain(parse(parse(g.metadata).membership).workspaceId) })), giftCount: grants.length,
      restrictedGiftsIncluded: true, units: GU_UNITS };
  }

  async function summary(a: Access, input: AnalyticsInput) {
    const range = analyticsRange(input, now());
    const base = () => db.from(usageBase(a, input, range).as("r"));
    // Aggregate in the database; a page limit must never become a statistics limit.
    const totals = await base().count({ calls: "id" }).sum({ charged: "chargedMicros", refunded: "refundedMicros" }).first();
    const tasks = await db.from(base().distinct("workspaceId", "taskId", "executionStatus").whereNotNull("taskId").as("t"))
      .select("executionStatus").count({ count: "taskId" }).groupBy("executionStatus");
    const taskBase = () => db.from(base().distinct("workspaceId", "taskId", "executionStatus", "failureCategory", "queueMs", "executionMs").whereNotNull("taskId").as("t"));
    const failures = await taskBase().whereIn("executionStatus", ["failed", "cancelled", "expired"]).select("failureCategory").count({ count: "taskId" }).groupBy("failureCategory").orderBy("count", "desc");
    const timing = async (field: "queueMs" | "executionMs") => {
      const q = () => taskBase().whereNotNull(field);
      const stats = await q().count({ count: "taskId" }).avg({ averageMs: field }).sum({ totalMs: field }).first();
      const count = Number(stats?.count || 0);
      const p95 = count ? await q().select(field).orderBy(field, "asc").offset(Math.ceil(count * .95) - 1).first() : null;
      return { samples: count, averageMs: count ? Number(stats?.averageMs) : null, p95Ms: p95 ? Number(p95[field]) : null, totalMs: count ? Number(stats?.totalMs) : null };
    };
    const [queue, execution] = await Promise.all([timing("queueMs"), timing("executionMs")]);
    const taskCount = tasks.reduce((n, r) => n + Number(r.count), 0);
    const succeeded = tasks.filter(r => ["completed", "succeeded", "success"].includes(String(r.executionStatus))).reduce((n, r) => n + Number(r.count), 0);
    const failed = tasks.filter(r => ["failed", "cancelled", "canceled", "expired"].includes(String(r.executionStatus))).reduce((n, r) => n + Number(r.count), 0);
    const grouped = async (field: string) => {
      const rows = await base().select(field).count({ calls: "id" }).sum({ charged: "chargedMicros", refunded: "refundedMicros" }).groupBy(field).orderBy("calls", "desc").limit(10);
      return rows.map(r => ({ id: r[field] == null ? null : String(r[field]), name: plain(r[field]) || "未归属", calls: Number(r.calls), ...(a.financial ? { net: guAmount(atom(r.charged) - atom(r.refunded)) } : {}) }));
    };
    // Integer epoch buckets work on both PostgreSQL and SQLite, in Asia/Shanghai.
    const bucket = db.raw("FLOOR((?? + ?) / ?) * ? - ?", ["createdAt", 28800000, dayMs, dayMs, 28800000]);
    const trendRows = await base().select({ day: bucket }).count({ calls: "id" }).sum({ charged: "chargedMicros", refunded: "refundedMicros" }).groupBy("day").orderBy("day");
    const unitRows = await base().select("unit").sum({ value: "units" }).groupBy("unit");
    const [models, members, projects, keys] = await Promise.all([grouped("model"), grouped("memberId"), grouped("projectId"), grouped("apiKeyId")]);
    const topModels = models.filter(model => model.id != null).slice(0, 5);
    const modelTrendSeries = [...topModels.map(model => ({ id: `model:${publicModelId(model.id)}`, name: publicModelId(model.name), calls: model.calls })), { id: "other", name: "其他", calls: Number(totals?.calls || 0) - topModels.reduce((sum, model) => sum + model.calls, 0) }];
    const seriesModel = topModels.length
      ? db.raw(`CASE WHEN ?? IN (${topModels.map(() => "?").join(",")}) THEN ?? ELSE NULL END`, ["model", ...topModels.map(model => model.id), "model"])
      : db.raw("NULL");
    const modelDays = await base().select({ day: bucket, seriesModel }).count({ calls: "id" }).groupBy("day", "seriesModel");
    const dayRows = new Map<number, { day: number; values: Record<string, number> }>();
    const firstDay = Math.floor((range.from + 28800000) / dayMs) * dayMs - 28800000;
    for (let day = firstDay; day < range.to; day += dayMs) dayRows.set(day, { day, values: Object.fromEntries(modelTrendSeries.map(model => [model.id, 0])) });
    for (const row of modelDays) { const day = dayRows.get(Number(row.day)); if (day) day.values[row.seriesModel == null ? "other" : `model:${publicModelId(row.seriesModel)}`] += Number(row.calls); }
    const modelTrend = [...dayRows.values()];
    const [users, projectNames, keyNames] = await Promise.all([
      db("o_user").whereIn("id", members.filter(r => r.id).map(r => Number(r.id))).select("id", "displayName", "name"),
      db("o_project").whereIn("workspaceId", a.allowedWorkspaceIds).whereIn("id", projects.filter(r => r.id).map(r => Number(r.id))).select("id", "name"),
      db("o_api_key").whereIn("workspaceId", a.allowedWorkspaceIds).whereIn("id", keys.filter(r => r.id).map(r => r.id!)).select("id", "name"),
    ]);
    for (const r of members) { const user = users.find(u => String(u.id) === r.id); if (r.id) r.name = plain(user?.displayName || user?.name) || `成员 ${r.id}`; }
    for (const r of projects) { const project = projectNames.find(p => String(p.id) === r.id); if (r.id) r.name = plain(project?.name) || `项目 ${r.id}`; }
    for (const r of keys) { const key = keyNames.find(k => k.id === r.id); if (r.id) r.name = plain(key?.name) || "未命名密钥"; }
    let personalSpend: ReturnType<typeof guAmount> | undefined;
    if (a.scope === "account") {
      const rows = await ledgerBase(a, { ...input, model: undefined, source: undefined, projectId: undefined, memberId: undefined, apiKeyId: undefined, query: undefined, status: undefined, executionStatus: undefined, failureCategory: undefined }, range)
        .whereIn("type", ["spend_capture", "refund", "recharge"])
        .select("type").sum({ amount: "amountMicros" }).groupBy("type")
        .where(q => q.whereIn("type", ["spend_capture", "refund"]).orWhere(function() {
          const extract = (key: string) => String(db.client.config.client).includes("pg") ? db.raw("COALESCE(NULLIF(??, ''), '{}')::jsonb ->> ?", ["metadata", key]) : db.raw("json_extract(COALESCE(NULLIF(??, ''), '{}'), ?)", ["metadata", `$.${key}`]);
          this.whereRaw("? IS NOT NULL AND ? IS NOT NULL", [extract("refundWorkspaceLedgerOriginalId"), extract("originalOwnerWalletLedgerId")]);
        }));
      personalSpend = guAmount(rows.reduce((sum, r: any) => sum + (r.type === "spend_capture" ? 1n : -1n) * atom(r.amount), 0n));
    }
    const workspaces = a.scope === "account" ? await db("o_workspace as w").join("o_workspace_member as m", "m.workspaceId", "w.id")
      .whereIn("w.id", a.allowedWorkspaceIds).where({ "m.userId": a.userId, "m.status": "active" }).select("w.id", "w.name", "m.role") : undefined;
    return { scope: a.scope, workspaceId: a.scope === "workspace" ? a.workspaceId : null, range, financialVisible: a.financial, visibility: a.allUsage ? "workspace" : a.keyId && a.scope === "workspace" ? "key" : "self",
      calls: Number(totals?.calls || 0), tasks: taskCount, succeeded, failed, otherTasks: taskCount - succeeded - failed, successRate: succeeded + failed ? succeeded / (succeeded + failed) : null,
      ...(a.financial ? { net: guAmount(atom(totals?.charged) - atom(totals?.refunded)), charged: amount(totals?.charged), refunded: amount(totals?.refunded), personalSpend } : {}),
      trend: trendRows.map(r => ({ day: Number(r.day), calls: Number(r.calls), ...(a.financial ? { net: guAmount(atom(r.charged) - atom(r.refunded)) } : {}) })),
      failureReasons: failures.map(r => ({ category: r.failureCategory || "unknown", count: Number(r.count) })), timing: { queue, execution },
      modelTrendSeries, modelTrend, quantities: unitRows.map(r => ({ unit: r.unit, value: Number(r.value) })), models: models.map(model => ({ ...model, id: publicModelId(model.id), name: publicModelId(model.name) })), members, projects, keys, workspaces, units: GU_UNITS,
      attributionNote: "历史记录无法确定的来源或执行状态标记为未知；消耗按本期调用归集，退款计入对应调用。" };
  }

  async function detail(a: Access, input: AnalyticsInput, kind: "usage" | "ledger") {
    if (!input.id) throw new AnalyticsError("ID_REQUIRED", "请选择一条明细");
    // Detail access uses the same scope and filters as the list, including dates.
    const range = analyticsRange(input, now());
    const base = kind === "usage" ? usageBase(a, input, range) : ledgerBase(a, input, range).select("*");
    const row = await db.from(base.as("r")).where("r.id", input.id).first();
    if (!row) throw new AnalyticsError("NOT_FOUND", "明细不存在或无权查看", 404);
    const item = kind === "usage" ? usageView(row, a.financial) : ledgerView(row);
    const ledgerRows = kind === "usage" && a.financial ? await db("o_billing_ledger").where({ workspaceId: row.workspaceId })
      .where(q => { q.where("relatedUsageId", row.id); if (row.taskId) q.orWhere(n => n.whereNull("relatedUsageId").where(t => t.where("relatedTaskId", row.taskId).orWhere("taskId", row.taskId))); })
      .orderBy("createdAt", "asc").limit(101) : [];
    const lifecycle = ledgerRows.slice(0, 100).map(ledgerView);
    const evidence = a.financial ? customerBillingEvidence(kind === "usage" ? ledgerRows.slice(0, 100) : [row]) : undefined;
    return { item, lifecycle, lifecycleTruncated: ledgerRows.length > 100, ...(evidence ? { billingEvidence: evidence } : {}), units: GU_UNITS };
  }

  async function execute(subject: AnalyticsSubject, action: AnalyticsAction, raw: unknown): Promise<Record<string, any>> {
    const parsed = analyticsInputSchema.safeParse(raw);
    if (!parsed.success) throw new AnalyticsError("INVALID_ARGUMENTS", "查询参数无效");
    const input = parsed.data;
    if (action.startsWith("export-")) return createAnalyticsExportService(db, { execute, exportAccess }, now).execute(subject, action, input);
    const a = await authorize(subject, input);
    if (action === "balance") return balance(a);
    if (action === "summary") return summary(a, input);
    if (action === "usage" || action === "ledger") return list(a, input, action);
    if (action === "usage-detail" || action === "ledger-detail") return detail(a, input, action === "usage-detail" ? "usage" : "ledger");
    if (action === "export") {
      const kind = input.kind || "usage", page = await list(a, input, kind);
      // Each chunk carries a filter-bound cursor. Callers append chunks until null.
      // No hidden row cap and no financial fields are added during export.
      const columns = kind === "usage" ? ["id", "workspaceId", "taskId", "requestId", "model", "source", "unit", "units", "executionStatus", "failureCategory", "queueMs", "durationMs", "billingStatus", "createdAt", ...(a.financial ? ["charged", "refunded", "net"] : [])]
        : ["id", "workspaceId", "type", "direction", "amount", "createdAt", "requestId", "taskId", "usageId"];
      const cell = (value: any) => { let s = value && typeof value === "object" && "gu" in value ? value.gu : String(value ?? ""); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return `"${s.replaceAll('"', '""')}"`; };
      if (audit) await audit(subject, input, page.items.length, page.snapshotAt);
      const content = input.format === "json" ? JSON.stringify(page.items) : [!input.cursor ? columns.join(",") : null, ...page.items.map(item => columns.map(c => cell((item as any)[c])).join(","))].filter(v => v != null).join("\r\n") + "\r\n";
      return { ...page, items: undefined, rowCount: page.items.length, content, format: input.format, complete: !page.nextCursor, filename: `fanjin-${a.scope}-${kind}-${page.snapshotAt}.${input.format}` };
    }
    throw new AnalyticsError("NOT_FOUND", "查询不存在", 404);
  }
  async function exportAccess(subject: AnalyticsSubject, input: AnalyticsInput) {
    const a = await authorize(subject, input), range = analyticsRange(input, now());
    if (input.kind === "ledger") ledgerBase(a, input, range);
    return createHash("sha256").update(JSON.stringify({ userId: a.userId, keyId: a.keyId, workspaceId: a.scope === "workspace" ? a.workspaceId : undefined, scope: a.scope, financial: a.financial, allUsage: a.allUsage, workspaces: [...a.allowedWorkspaceIds].sort() })).digest("hex");
  }
  return { execute, exportAccess };
}
