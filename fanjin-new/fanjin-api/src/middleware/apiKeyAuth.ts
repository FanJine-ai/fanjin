import { modelAllowlistIncludes } from "@/lib/minimaxH3PublicIdentity";
import crypto from "crypto";
import { isIP } from "node:net";
import { NextFunction, Request, Response } from "express";
import { Knex } from "knex";
import { decideApiKeyQuotaCompletion, type ApiKeyQuotaCompletionDecision } from "@/lib/apiKeyQuotaPolicy";
import { consumeDistributedFixedWindow } from "@/lib/distributedRateLimit";
import {
  getEffectiveWorkspacePermissions,
  requireActiveWorkspacePermission,
} from "@/middleware/permissions";
import { getConsistentWorkspaceRole } from "@/lib/workspaceOwnership";
import {
  hasRelayApiKeyPermission,
  parseStoredRelayApiKeyPermissions,
  type RelayApiKeyPermission,
} from "@/lib/relayApiKeyPermissions";
import { db } from "@/utils/db";
import { isRecoveryOnlyMode } from "@/lib/recoveryOnlyMode";

export interface RelayApiKeyContext {
  id: string;
  name: string;
  keyPrefix: string;
  ownerUserId: number;
  scope: "platform" | "workspace";
  workspaceId: string | null;
  permissions: RelayApiKeyPermission[];
  modelAllowlist: string[];
  ipAllowlist: string[];
}

export class ApiKeyUsageError extends Error {
  status: number;
  code: string;

  constructor(message: string, status = 429, code = "api_key_usage_limited") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class ApiKeyAuthenticationError extends Error {
  readonly code = "invalid_api_key";

  constructor(message: string, readonly status = 401) {
    super(message);
    this.name = "ApiKeyAuthenticationError";
  }
}

interface PreauthenticatedApiKey {
  keyHash: string;
  row: any;
  context: RelayApiKeyContext;
}

const preauthenticatedApiKeys = new WeakMap<Request, PreauthenticatedApiKey>();

export function generateApiKey(): { plainKey: string; keyPrefix: string; keyHash: string } {
  const keyPrefix = `fanjin_${crypto.randomBytes(4).toString("hex")}`;
  const secret = crypto.randomBytes(24).toString("base64url");
  const plainKey = `${keyPrefix}_${secret}`;
  return {
    plainKey,
    keyPrefix,
    keyHash: hashApiKey(plainKey),
  };
}

export function hashApiKey(plainKey: string): string {
  return crypto.createHash("sha256").update(plainKey).digest("hex");
}

export function maskApiKey(keyPrefix: string): string {
  return `${keyPrefix}_****`;
}

export interface ApiKeyCredentialResult {
  plainKey: string | null;
  sources: string[];
  error: string | null;
}

type CredentialCandidate = { source: string; value: string };

function readSingleCredentialValue(
  raw: unknown,
  source: string,
  options: { rejectComma?: boolean } = {},
): { value: string | null; error: string | null } {
  if (raw === undefined || raw === null) return { value: null, error: null };
  if (Array.isArray(raw)) {
    if (raw.length !== 1) return { value: null, error: `${source} 只能提供一个值` };
    return readSingleCredentialValue(raw[0], source, options);
  }
  if (typeof raw !== "string") return { value: null, error: `${source} 格式无效` };
  const value = raw.trim();
  if (!value) return { value: null, error: null };
  if (options.rejectComma && value.includes(",")) {
    return { value: null, error: `${source} 只能提供一个值` };
  }
  return { value, error: null };
}

/**
 * Read all API-key credential forms accepted by OpenAI/Gemini clients.
 * Repeating the same key across sources is allowed for SDK compatibility;
 * distinct values, repeated values in one source, or malformed values fail
 * closed instead of relying on source precedence.
 */
export function readApiKeyCredential(req: Request): ApiKeyCredentialResult {
  const candidates: CredentialCandidate[] = [];
  const directSources: Array<{ source: string; raw: unknown }> = [
    { source: "X-Api-Key", raw: req.headers["x-api-key"] },
    { source: "X-Goog-Api-Key", raw: req.headers["x-goog-api-key"] },
    { source: "query key", raw: req.query?.key },
  ];

  for (const candidate of directSources) {
    const result = readSingleCredentialValue(candidate.raw, candidate.source, { rejectComma: true });
    if (result.error) return { plainKey: null, sources: [], error: result.error };
    if (result.value) candidates.push({ source: candidate.source, value: result.value });
  }

  const authorization = readSingleCredentialValue(req.headers.authorization, "Authorization", { rejectComma: true });
  if (authorization.error) return { plainKey: null, sources: [], error: authorization.error };
  if (authorization.value) {
    const match = authorization.value.match(/^Bearer\s+(.+)$/i);
    const bearerKey = match?.[1]?.trim() || "";
    // Preserve the distinction between login-session Bearer tokens and relay
    // API keys. Only Fanjin-format Bearer values participate in this resolver.
    if (bearerKey.startsWith("fanjin_")) {
      candidates.push({ source: "Authorization", value: bearerKey });
    }
  }

  if (!candidates.length) return { plainKey: null, sources: [], error: null };
  const distinctValues = new Set(candidates.map((candidate) => candidate.value));
  if (distinctValues.size !== 1) {
    return {
      plainKey: null,
      sources: candidates.map((candidate) => candidate.source),
      error: "多个 API Key 凭据不一致",
    };
  }
  return {
    plainKey: candidates[0].value,
    sources: candidates.map((candidate) => candidate.source),
    error: null,
  };
}

function parseStringList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : [];
  } catch {
    return [];
  }
}

function normalizeIp(value: unknown): string {
  const text = String(value || "").split(",")[0].trim();
  if (!text) return "";
  if (text === "::1") return "127.0.0.1";
  return text.replace(/^::ffff:/i, "");
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    const value = Number(part);
    if (!Number.isInteger(value) || value < 0 || value > 255) return null;
    result = (result << 8) + value;
  }
  return result >>> 0;
}

function matchesIpRule(ip: string, rule: string): boolean {
  const normalizedIp = normalizeIp(ip);
  const normalizedRule = normalizeIp(rule);
  if (!normalizedIp || !normalizedRule) return false;
  if (!normalizedRule.includes("/")) return normalizedIp === normalizedRule;

  const [network, prefixText] = normalizedRule.split("/");
  const prefix = Number(prefixText);
  const ipInt = ipv4ToInt(normalizedIp);
  const networkInt = ipv4ToInt(network);
  if (ipInt === null || networkInt === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipInt & mask) === (networkInt & mask);
}

function readClientIp(req: Request): string {
  // 不要直接信任客户端可伪造的 X-Forwarded-For。
  // req.ip 由 Express 根据 app.set("trust proxy", ...) 解析得到：
  // - 未配置可信代理时，req.ip 为真实 socket 来源，忽略伪造头；
  // - 正确配置可信代理时，req.ip 为代理链中第一个可信的客户端 IP。
  return normalizeIp(req.ip || req.socket.remoteAddress || "");
}

function readRequestedModel(req: Request): string | null {
  const bodyModel = (req.body as any)?.model;
  if (typeof bodyModel === "string" && bodyModel.trim()) return bodyModel.trim();
  const paramModel = (req.params as any)?.model;
  if (typeof paramModel === "string" && paramModel.trim()) return paramModel.trim();
  const queryModel = req.query?.["filter.model"] ?? req.query?.model;
  if (Array.isArray(queryModel)) return typeof queryModel[0] === "string" ? queryModel[0].trim() : null;
  return typeof queryModel === "string" && queryModel.trim() ? queryModel.trim() : null;
}

function readExplicitWorkspaceIds(req: Request): string[] {
  const rawValues: unknown[] = [
    (req.body as any)?.workspaceId,
    req.query?.workspaceId,
    (req.params as any)?.workspaceId,
  ];
  return rawValues
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .filter((value): value is string | number => (
      typeof value === "string" || typeof value === "number"
    ))
    .map((value) => String(value).trim())
    .filter(Boolean);
}

async function resolvePreauthenticatedApiKey(req: Request): Promise<PreauthenticatedApiKey | null> {
  const credential = readApiKeyCredential(req);
  if (credential.error) throw new ApiKeyAuthenticationError(credential.error);
  if (!credential.plainKey) return null;

  const keyHash = hashApiKey(credential.plainKey);
  const cached = preauthenticatedApiKeys.get(req);
  if (cached?.keyHash === keyHash) return cached;

  const row = await db("o_api_key")
    .where({ keyHash })
    .where((builder) => {
      builder.whereNull("revokedAt").orWhere("revokedAt", 0);
    })
    .first();
  if (!row || row.disabled) throw new ApiKeyAuthenticationError("无效的 API Key");

  let owner: any | null = null;
  if (row.ownerUserId) {
    owner = await db("o_user")
      .where({ id: Number(row.ownerUserId) })
      .select(
        "id",
        "status",
        "role",
        "currentWorkspaceId",
        "defaultWorkspaceId",
      )
      .first();
    if (!owner || owner.status !== "active") {
      throw new ApiKeyAuthenticationError("API Key 所属账号不可用");
    }
  }
  let effectiveWorkspaceId: string | null = null;
  if (row.scope === "workspace") {
    const workspaceId = String(row.workspaceId || "").trim();
    if (!workspaceId || !owner) {
      throw new ApiKeyAuthenticationError("工作区 API Key 身份不完整");
    }
    const workspace = await db("o_workspace")
      .where({ id: workspaceId, status: "active" })
      .select("id", "ownerUserId")
      .first();
    if (!workspace) throw new ApiKeyAuthenticationError("API Key 所属工作区不可用");
    // A workspace key is always funded by a workspace principal. A global
    // platform role must not bypass a revoked membership, a phantom owner, or
    // a delegated-permission fail-closed decision.
    const member = await db("o_workspace_member")
      .where({
        workspaceId,
        userId: Number(owner.id),
        status: "active",
      })
      .first();
    const workspaceRole = member
      ? getConsistentWorkspaceRole({
          userId: member.userId,
          memberRole: member.role,
          ownerUserId: workspace.ownerUserId,
        })
      : null;
    if (
      !member
      || !workspaceRole
      || !getEffectiveWorkspacePermissions({
        role: workspaceRole,
        permissions: member.permissions,
        permissionsConfigured:
          member.permissions !== null && member.permissions !== undefined,
      }).includes("api_key:write")
    ) {
      throw new ApiKeyAuthenticationError("API Key 所属成员无权使用工作区密钥");
    }
    effectiveWorkspaceId = workspaceId;
  } else if (row.scope === "platform") {
    if (
      !owner
      || !["root", "admin", "super_admin"].includes(
        String(owner.role || "").toLowerCase(),
      )
    ) {
      throw new ApiKeyAuthenticationError("平台 API Key 所属账号权限已失效");
    }
    // Platform authority does not confer a tenant billing identity. Bind each
    // platform key to its owner's server-side default/current workspace and
    // require an active generation-capable membership there. Client input can
    // never choose which tenant pays for a platform-key request.
    const fundingWorkspaceId = String(
      owner.defaultWorkspaceId || owner.currentWorkspaceId || "",
    ).trim();
    if (!fundingWorkspaceId) {
      throw new ApiKeyAuthenticationError("平台 API Key 缺少有效资金工作区", 403);
    }
    const fundingWorkspace = await db("o_workspace")
      .where({ id: fundingWorkspaceId, status: "active" })
      .select("id", "ownerUserId")
      .first();
    const fundingMember = fundingWorkspace
      ? await db("o_workspace_member")
          .where({
            workspaceId: fundingWorkspaceId,
            userId: Number(owner.id),
            status: "active",
          })
          .first()
      : null;
    const fundingRole = fundingMember && fundingWorkspace
      ? getConsistentWorkspaceRole({
          userId: fundingMember.userId,
          memberRole: fundingMember.role,
          ownerUserId: fundingWorkspace.ownerUserId,
        })
      : null;
    const fundingPermissions = fundingRole
      ? getEffectiveWorkspacePermissions({
          role: fundingRole,
          permissions: fundingMember.permissions,
          permissionsConfigured:
            fundingMember.permissions !== null
            && fundingMember.permissions !== undefined,
        })
      : [];
    if (
      !fundingWorkspace
      || !fundingMember
      || !fundingRole
      || !fundingPermissions.includes("generation:create")
    ) {
      throw new ApiKeyAuthenticationError(
        "平台 API Key 资金工作区权限已失效",
        403,
      );
    }
    effectiveWorkspaceId = fundingWorkspaceId;
  } else {
    throw new ApiKeyAuthenticationError("API Key 作用域无效");
  }

  const explicitWorkspaceIds = readExplicitWorkspaceIds(req);
  if (
    effectiveWorkspaceId
    && explicitWorkspaceIds.some(
      (workspaceId) => workspaceId !== effectiveWorkspaceId,
    )
  ) {
    throw new ApiKeyAuthenticationError(
      "API Key 请求工作区与服务端资金工作区不一致",
      403,
    );
  }

  const expiresAt = Number(row.expiresAt || 0);
  if (expiresAt > 0 && expiresAt < Date.now()) {
    throw new ApiKeyAuthenticationError("API Key 已过期");
  }

  const permissions = parseStoredRelayApiKeyPermissions(row.permissions);
  if (!permissions) {
    throw new ApiKeyAuthenticationError("API Key 权限配置无效");
  }
  const modelAllowlist = parseStringList(row.modelAllowlist);
  const ipAllowlist = parseStringList(row.ipAllowlist);
  const clientIp = readClientIp(req);
  if (ipAllowlist.length > 0 && (!isIP(clientIp) || !ipAllowlist.some((rule) => matchesIpRule(clientIp, rule)))) {
    throw new ApiKeyAuthenticationError("当前 IP 不在 API Key 白名单内", 403);
  }

  const context = {
    id: row.id,
    name: row.name,
    keyPrefix: row.keyPrefix,
    ownerUserId: Number(owner?.id || 0),
    scope: row.scope,
    workspaceId: effectiveWorkspaceId,
    permissions,
    modelAllowlist,
    ipAllowlist,
  } satisfies RelayApiKeyContext;
  const resolved = { keyHash, row, context };
  preauthenticatedApiKeys.set(req, resolved);
  // Core identity is now valid. Route-specific middleware still enforces
  // permission, model allowlist, per-key rate and quota before dispatch.
  (req as any).apiKey = context;
  return resolved;
}

/**
 * Validate API-key identity before platform-wide business rate limits run.
 * This prevents syntactically valid but nonexistent credentials from
 * consuming the shared global/model buckets.
 */
export async function preAuthenticateApiKey(req: Request): Promise<RelayApiKeyContext | null> {
  return (await resolvePreauthenticatedApiKey(req))?.context ?? null;
}

async function assertRateLimit(row: any): Promise<void> {
  const limit = Number(row.rateLimitPerMinute || 0);
  if (!limit) return;
  const result = await consumeDistributedFixedWindow({
    namespace: "api-key-rate",
    // Preserve the exact PostgreSQL bucket used by 0.0.3 and older nodes.
    // During a rolling deployment both versions can therefore increment the
    // same row until the synchronized Redis cutover. The Redis namespace and
    // hashed key already provide sufficient separation after cutover.
    bucket: String(row.id),
    limit,
    durationMs: 60_000,
  });
  if (result.exceeded) {
    throw new ApiKeyUsageError("API Key 请求频率超限", 429, "rate_limit_exceeded");
  }
}

function assertQuotaAvailable(row: any): void {
  const limit = Number(row.quotaLimit || 0);
  if (!limit) return;

  const used = Number(row.quotaUsed || 0);
  const reserved = Number(row.quotaReserved || 0);
  if (used + reserved >= limit) {
    throw new ApiKeyUsageError("API Key 配额已用完", 429, "quota_exceeded");
  }
}

export async function reserveApiKeyQuota(apiKeyId?: string | null, taskId?: string | null, units = 1): Promise<number> {
  if (!apiKeyId || !taskId || units <= 0) return 0;
  const safeUnits = Math.max(1, Math.floor(Number(units) || 1));

  return await db.transaction(async (trx: Knex.Transaction) => {
    const task = await trx("o_relay_task").where({ id: taskId }).first();
    if (!task) return 0;
    const alreadyReserved = Number(task.apiQuotaReserved || 0);
    if (alreadyReserved > 0) return alreadyReserved;

    const updated = await trx("o_api_key")
      .where({ id: apiKeyId })
      .where({ disabled: 0 })
      .where((builder) => {
        builder.whereNull("revokedAt").orWhere("revokedAt", 0);
      })
      .where((builder) => {
        builder
          .whereNull("quotaLimit")
          .orWhere("quotaLimit", "<=", 0)
          .orWhereRaw(
            "COALESCE(??, 0) + COALESCE(??, 0) + ? <= ??",
            ["quotaUsed", "quotaReserved", safeUnits, "quotaLimit"],
          );
      })
      .update({
        quotaReserved: trx.raw("COALESCE(??, 0) + ?", ["quotaReserved", safeUnits]),
        updateTime: Date.now(),
      });

    if (!updated) {
      throw new ApiKeyUsageError("API Key 配额不足", 429, "quota_exceeded");
    }

    await trx("o_relay_task").where({ id: taskId }).update({
      apiQuotaReserved: safeUnits,
      updateTime: Date.now(),
    });
    return safeUnits;
  });
}

export async function completeApiKeyQuota(
  apiKeyId?: string | null,
  taskId?: string | null,
  succeeded = false,
): Promise<void> {
  if (!apiKeyId || !taskId) return;

  await db.transaction(async (trx: Knex.Transaction) => {
    const task = await trx("o_relay_task").where({ id: taskId }).first();
    const reservedUnits = Number(task?.apiQuotaReserved || 0);
    if (!task || reservedUnits <= 0) return;

    await trx("o_api_key")
      .where({ id: apiKeyId })
      .update({
        quotaReserved: trx.raw(
          "CASE WHEN COALESCE(??, 0) - ? < 0 THEN 0 ELSE COALESCE(??, 0) - ? END",
          ["quotaReserved", reservedUnits, "quotaReserved", reservedUnits],
        ),
        quotaUsed: succeeded
          ? trx.raw("COALESCE(??, 0) + ?", ["quotaUsed", reservedUnits])
          : trx.raw("COALESCE(??, 0)", ["quotaUsed"]),
        updateTime: Date.now(),
      });

    await trx("o_relay_task").where({ id: taskId }).update({
      apiQuotaReserved: 0,
      updateTime: Date.now(),
    });
  });
}

export async function consumeApiKeyQuota(apiKeyId?: string | null, units = 1): Promise<void> {
  if (!apiKeyId || units <= 0) return;

  const row = await db("o_api_key").where({ id: apiKeyId }).first();
  if (!row || row.disabled || row.revokedAt) throw new ApiKeyUsageError("API Key 不可用", 401, "invalid_api_key");

  const updated = await db("o_api_key")
    .where({ id: apiKeyId })
    .where({ disabled: 0 })
    .where((builder) => {
      builder.whereNull("revokedAt").orWhere("revokedAt", 0);
    })
    .where((builder) => {
      builder
        .whereNull("quotaLimit")
        .orWhere("quotaLimit", "<=", 0)
        .orWhereRaw(
          "COALESCE(??, 0) + COALESCE(??, 0) + ? <= ??",
          ["quotaUsed", "quotaReserved", units, "quotaLimit"],
        );
    })
    .update({
      quotaUsed: db.raw("COALESCE(??, 0) + ?", ["quotaUsed", units]),
      updateTime: Date.now(),
    });

  if (!updated) {
    throw new ApiKeyUsageError("API Key 配额已用完", 429, "quota_exceeded");
  }
}

export async function reserveApiKeyRequestQuota(
  apiKeyId?: string | null,
  units = 1,
  requestId?: string | null,
): Promise<number> {
  if (!apiKeyId || units <= 0) return 0;
  const safeUnits = Math.max(1, Math.floor(Number(units) || 1));
  const normalizedRequestId = String(requestId || "").trim() || null;

  return await db.transaction(async (trx: Knex.Transaction) => {
    const key = await trx("o_api_key").where({ id: apiKeyId }).first();
    // GU-based keys are reserved with the exact pricing cost inside the
    // billing transaction. Reserving one request here would mix units and
    // double count the same call.
    if (String(key?.quotaUnit || "") === "gu_micros") return 0;
    if (normalizedRequestId) {
      const existing = await trx("o_api_key_quota_reservation")
        .where({ apiKeyId, requestId: normalizedRequestId })
        .first();
      if (existing) throw new ApiKeyUsageError("相同 requestId 的 API Key 配额请求已存在", 409, "idempotency_conflict");
    }

    const timestamp = Date.now();
    const updated = await trx("o_api_key")
      .where({ id: apiKeyId })
      .where({ disabled: 0 })
      .where((builder) => {
        builder.whereNull("revokedAt").orWhere("revokedAt", 0);
      })
      .where((builder) => {
        builder
          .whereNull("quotaLimit")
          .orWhere("quotaLimit", "<=", 0)
          .orWhereRaw(
            "COALESCE(??, 0) + COALESCE(??, 0) + ? <= ??",
            ["quotaUsed", "quotaReserved", safeUnits, "quotaLimit"],
          );
      })
      .update({
        quotaReserved: trx.raw("COALESCE(??, 0) + ?", ["quotaReserved", safeUnits]),
        updateTime: timestamp,
      });

    if (!updated) throw new ApiKeyUsageError("API Key 配额不足", 429, "quota_exceeded");
    if (normalizedRequestId) {
      const ttlMs = Math.max(60_000, Number(process.env.FANJIN_API_KEY_QUOTA_RESERVATION_TTL_MS || 6 * 60 * 60_000));
      await trx("o_api_key_quota_reservation").insert({
        id: crypto.randomUUID(),
        apiKeyId,
        requestId: normalizedRequestId,
        units: safeUnits,
        status: "reserved",
        responseStatus: null,
        expiresAt: timestamp + ttlMs,
        createTime: timestamp,
        updateTime: timestamp,
      });
    }
    return safeUnits;
  });
}

function parseBillingMetadata(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

async function resolveApiKeyQuotaCompletionDecision(
  trx: Knex.Transaction,
  input: {
    apiKeyId: string;
    requestId: string;
    httpSucceeded: boolean;
    allowReleaseWithoutBillingEvidence: boolean;
  },
): Promise<ApiKeyQuotaCompletionDecision> {
  const freeze = await trx("o_billing_ledger")
    .where({ apiKeyId: input.apiKeyId, requestId: input.requestId, type: "freeze" })
    .orderBy("createdAt", "desc")
    .first();
  const usage = freeze?.relatedUsageId
    ? await trx("o_usage_record").where({ id: freeze.relatedUsageId }).first()
    : null;
  const metadata = parseBillingMetadata(freeze?.metadata);
  const decision = decideApiKeyQuotaCompletion({
    httpSucceeded: input.httpSucceeded,
    hasFreeze: Boolean(freeze),
    billingLifecycleState: String(metadata.billingLifecycleState || ""),
    usageStatus: usage?.status == null ? null : String(usage.status),
  });
  if (!input.allowReleaseWithoutBillingEvidence && decision === "released" && !freeze) {
    return "deferred";
  }
  return decision;
}

export async function completeApiKeyRequestQuota(
  apiKeyId?: string | null,
  reservedUnits = 0,
  succeeded = false,
  requestId?: string | null,
  responseStatus?: number | null,
  allowReleaseWithoutBillingEvidence = true,
): Promise<ApiKeyQuotaCompletionDecision | "skipped"> {
  if (!apiKeyId || reservedUnits <= 0) return "skipped";
  const normalizedRequestId = String(requestId || "").trim() || null;

  return await db.transaction(async (trx: Knex.Transaction) => {
    let safeUnits = Math.max(1, Math.floor(Number(reservedUnits) || 1));
    let reservation: any = null;
    if (normalizedRequestId) {
      reservation = await trx("o_api_key_quota_reservation")
        .where({ apiKeyId, requestId: normalizedRequestId })
        .first();
      if (!reservation || reservation.status !== "reserved") return "skipped" as const;
      safeUnits = Math.max(1, Math.floor(Number(reservation.units) || 1));
    }

    const timestamp = Date.now();
    const decision = normalizedRequestId
      ? await resolveApiKeyQuotaCompletionDecision(trx, {
          apiKeyId,
          requestId: normalizedRequestId,
          httpSucceeded: succeeded,
          allowReleaseWithoutBillingEvidence,
        })
      : succeeded ? "consumed" as const : "released" as const;

    if (reservation && decision === "deferred") {
      await trx("o_api_key_quota_reservation")
        .where({ id: reservation.id, status: "reserved" })
        .update({ responseStatus: responseStatus ?? null, updateTime: timestamp });
      return decision;
    }

    if (reservation) {
      // Claim the terminal transition first. A concurrent finish/close/worker
      // can then observe a zero-row CAS and must not adjust counters twice.
      const reservationUpdated = await trx("o_api_key_quota_reservation")
        .where({ id: reservation.id, status: "reserved" })
        .update({
          status: decision,
          responseStatus: responseStatus ?? null,
          updateTime: timestamp,
        });
      if (Number(reservationUpdated || 0) !== 1) return "skipped" as const;
    }

    const keyUpdated = await trx("o_api_key")
      .where({ id: apiKeyId })
      .whereRaw("COALESCE(??, 0) >= ?", ["quotaReserved", safeUnits])
      .update({
        quotaReserved: trx.raw("COALESCE(??, 0) - ?", ["quotaReserved", safeUnits]),
        quotaUsed: decision === "consumed"
          ? trx.raw("COALESCE(??, 0) + ?", ["quotaUsed", safeUnits])
          : trx.raw("COALESCE(??, 0)", ["quotaUsed"]),
        updateTime: timestamp,
      });
    if (Number(keyUpdated || 0) !== 1) {
      throw new ApiKeyUsageError("API Key 配额预占账实不一致", 409, "quota_state_conflict");
    }
    return decision;
  });
}

function attachApiKeyRequestQuotaCompletion(
  res: Response,
  apiKeyId: string,
  reservedUnits: number,
  requestId: string,
) {
  if (reservedUnits <= 0) return;
  let completionStarted = false;
  const complete = (succeeded: boolean) => {
    if (completionStarted) return;
    completionStarted = true;
    void completeApiKeyRequestQuota(apiKeyId, reservedUnits, succeeded, requestId, res.statusCode).catch((err: any) => {
      console.warn("[api-key-quota] complete failed", err?.message || err);
    });
  };

  res.on("finish", () => {
    complete(res.statusCode >= 200 && res.statusCode < 400);
  });
  res.on("close", () => {
    if (completionStarted || res.writableEnded) return;
    completionStarted = true;
    // A premature client disconnect can race the handler that persists
    // dispatch_started/pending_reconcile. Consume durable dispatch evidence,
    // but never release merely because that evidence is not visible yet.
    void completeApiKeyRequestQuota(apiKeyId, reservedUnits, false, requestId, 499, false)
      .catch((err: any) => {
        console.warn("[api-key-quota] disconnect completion failed", err?.message || err);
      });
  });
}

export function apiKeyAuth(options: {
  optional?: boolean;
  permission?: string;
  reserveRequestQuota?: boolean;
  /** Existing tasks remain readable/cancellable when new-call quota is spent. */
  checkQuota?: boolean;
  sessionPermission?: string | false;
} = {}) {
  return async (req: Request, res: Response, next: NextFunction) => {
    let resolved: PreauthenticatedApiKey | null;
    try {
      resolved = await resolvePreauthenticatedApiKey(req);
    } catch (err: any) {
      if (err instanceof ApiKeyAuthenticationError) {
        return res.status(err.status).send({ message: err.message, code: err.code });
      }
      console.error("[api-key-auth] identity validation unavailable", err?.message || err);
      return res.status(503).send({ message: "API Key 认证服务暂不可用", code: "api_key_auth_unavailable" });
    }
    if (!resolved) {
      if (options.optional) {
        const sessionPermission = options.sessionPermission === false
          ? null
          : options.sessionPermission
            || (options.permission?.startsWith("relay:")
              ? "generation:create"
              : null);
        if (sessionPermission) {
          return await requireActiveWorkspacePermission(sessionPermission)(
            req,
            res,
            next,
          );
        }
        return next();
      }
      return res.status(401).send({ message: "未提供 API Key" });
    }
    if (isRecoveryOnlyMode()) {
      return res.status(503).send({
        code: "RECOVERY_ONLY_API_KEY_BLOCKED",
        message: "恢复候选环境不接受 API Key 请求",
      });
    }
    const { row, context } = resolved;
    const { permissions, modelAllowlist } = context;
    if (
      options.permission
      && !hasRelayApiKeyPermission(permissions, options.permission)
    ) {
      return res.status(403).send({ message: "API Key 权限不足" });
    }

    const requestedModel = readRequestedModel(req);
    if (requestedModel && modelAllowlist.length > 0 && !modelAllowlistIncludes(modelAllowlist, requestedModel)) {
      return res.status(403).send({ message: "API Key 不允许调用该模型" });
    }

    try {
      if (options.checkQuota !== false || options.reserveRequestQuota) assertQuotaAvailable(row);
      await assertRateLimit(row);
      if (options.reserveRequestQuota) {
        const requestId = String(
          (req as any).requestId || res.getHeader("X-Request-Id") || req.header("x-request-id") || crypto.randomUUID(),
        );
        const reservedUnits = await reserveApiKeyRequestQuota(row.id, 1, requestId);
        attachApiKeyRequestQuotaCompletion(res, row.id, reservedUnits, requestId);
      }
    } catch (err: any) {
      const status = err.status || 429;
      const code = String(err.code || (status === 429 ? "rate_limit_exceeded" : "api_key_usage_limited"));
      const message = err.message || "API Key 请求受限";
      return res.status(status).send({ code, message, error: { type: code, code, message } });
    }

    await db("o_api_key").where({ id: row.id }).update({ lastUsedAt: Date.now(), updateTime: Date.now() });
    (req as any).apiKey = context;
    next();
  };
}
