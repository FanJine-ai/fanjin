import crypto from "node:crypto";
import net from "node:net";
import type { Knex } from "knex";

export interface PasswordPolicy {
  minLength: number;
  requireUppercase: boolean;
  requireLowercase: boolean;
  requireNumber: boolean;
  requireSymbol: boolean;
  expireDays: number;
  rejectHistoryCount: number;
  maxRetriesPerHour: number;
  lockMinutes: number;
}

export interface SessionPolicy {
  idleMinutes: number;
  absoluteHours: number;
}

export interface AccountSecurityPolicy {
  mfaEnabled: boolean;
  loginProtectionEnabled: boolean;
  sensitiveOperationProtectionEnabled: boolean;
  loginIpAllowlist: string;
  passwordPolicy: PasswordPolicy;
  sessionPolicy: SessionPolicy;
}

export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
  minLength: 10,
  requireUppercase: true,
  requireLowercase: true,
  requireNumber: true,
  requireSymbol: false,
  expireDays: 0,
  rejectHistoryCount: 3,
  maxRetriesPerHour: 5,
  lockMinutes: 60,
};

export const DEFAULT_SESSION_POLICY: SessionPolicy = {
  idleMinutes: 2880,
  absoluteHours: 48,
};

const LOGIN_STATE_TABLE = "o_auth_login_state";
const LOGIN_WINDOW_MS = 60 * 60 * 1000;

function parseJsonRecord(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

export function normalizePasswordPolicy(raw: unknown): PasswordPolicy {
  const policy = parseJsonRecord(raw);
  return {
    minLength: boundedInteger(policy.minLength, DEFAULT_PASSWORD_POLICY.minLength, 8, 64),
    requireUppercase: policy.requireUppercase === undefined ? DEFAULT_PASSWORD_POLICY.requireUppercase : Boolean(policy.requireUppercase),
    requireLowercase: policy.requireLowercase === undefined ? DEFAULT_PASSWORD_POLICY.requireLowercase : Boolean(policy.requireLowercase),
    requireNumber: policy.requireNumber === undefined ? DEFAULT_PASSWORD_POLICY.requireNumber : Boolean(policy.requireNumber),
    requireSymbol: policy.requireSymbol === undefined ? DEFAULT_PASSWORD_POLICY.requireSymbol : Boolean(policy.requireSymbol),
    expireDays: boundedInteger(policy.expireDays, DEFAULT_PASSWORD_POLICY.expireDays, 0, 365),
    rejectHistoryCount: boundedInteger(policy.rejectHistoryCount, DEFAULT_PASSWORD_POLICY.rejectHistoryCount, 0, 24),
    maxRetriesPerHour: boundedInteger(policy.maxRetriesPerHour, DEFAULT_PASSWORD_POLICY.maxRetriesPerHour, 1, 100),
    lockMinutes: boundedInteger(policy.lockMinutes, DEFAULT_PASSWORD_POLICY.lockMinutes, 1, 1440),
  };
}

export function normalizeSessionPolicy(raw: unknown): SessionPolicy {
  const policy = parseJsonRecord(raw);
  return {
    idleMinutes: boundedInteger(policy.idleMinutes, DEFAULT_SESSION_POLICY.idleMinutes, 5, 10080),
    absoluteHours: boundedInteger(policy.absoluteHours, DEFAULT_SESSION_POLICY.absoluteHours, 1, 720),
  };
}

export async function getAccountSecurityPolicy(knex: Knex, userId: number): Promise<AccountSecurityPolicy> {
  const row = userId ? await knex<any>("o_account_security").where("userId", userId).first() : null;
  return {
    mfaEnabled: Boolean(row?.mfaEnabled),
    loginProtectionEnabled: Boolean(row?.loginProtectionEnabled),
    sensitiveOperationProtectionEnabled: Boolean(row?.sensitiveOperationProtectionEnabled),
    loginIpAllowlist: String(row?.loginIpAllowlist || "").trim(),
    passwordPolicy: normalizePasswordPolicy(row?.passwordPolicy),
    sessionPolicy: normalizeSessionPolicy(row?.sessionPolicy),
  };
}

export function validatePasswordAgainstPolicy(password: string, policy: PasswordPolicy = DEFAULT_PASSWORD_POLICY): string | null {
  if (typeof password !== "string" || password.length < policy.minLength) return `密码至少 ${policy.minLength} 位`;
  if (password.length > 128) return "密码不能超过 128 位";
  if (policy.requireUppercase && !/[A-Z]/.test(password)) return "密码必须包含大写字母";
  if (policy.requireLowercase && !/[a-z]/.test(password)) return "密码必须包含小写字母";
  if (policy.requireNumber && !/[0-9]/.test(password)) return "密码必须包含数字";
  if (policy.requireSymbol && !/[^A-Za-z0-9]/.test(password)) return "密码必须包含特殊字符";
  return null;
}

function normalizeIp(ip: string): string {
  const value = String(ip || "").trim().replace(/^\[|\]$/g, "");
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(value)) return value.slice(7);
  return value;
}

export function parseLoginIpAllowlist(raw: string): string[] {
  const entries = String(raw || "")
    .split(/[\s,;]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);

  for (const entry of entries) {
    const [addressValue, prefixValue, ...rest] = entry.split("/");
    const address = normalizeIp(addressValue);
    const family = net.isIP(address);
    if (!family || rest.length) throw new Error(`无效的登录 IP 白名单项：${entry}`);
    if (prefixValue !== undefined) {
      if (!/^\d+$/.test(prefixValue)) throw new Error(`无效的登录 IP 白名单项：${entry}`);
      const prefix = Number(prefixValue);
      const maxPrefix = family === 4 ? 32 : 128;
      if (prefix < 0 || prefix > maxPrefix) throw new Error(`无效的登录 IP 白名单项：${entry}`);
    }
  }
  return entries;
}

export function isLoginIpAllowed(ip: string, rawAllowlist: string): boolean {
  const entries = parseLoginIpAllowlist(rawAllowlist);
  if (!entries.length) return true;

  const normalizedIp = normalizeIp(ip);
  const ipFamily = net.isIP(normalizedIp);
  if (!ipFamily) return false;

  for (const entry of entries) {
    const [addressValue, prefixValue] = entry.split("/");
    const address = normalizeIp(addressValue);
    const family = net.isIP(address);
    if (family !== ipFamily) continue;
    const blockList = new net.BlockList();
    if (prefixValue === undefined) {
      blockList.addAddress(address, family === 4 ? "ipv4" : "ipv6");
      if (blockList.check(normalizedIp, family === 4 ? "ipv4" : "ipv6")) return true;
      continue;
    }

    blockList.addSubnet(address, Number(prefixValue), family === 4 ? "ipv4" : "ipv6");
    if (blockList.check(normalizedIp, family === 4 ? "ipv4" : "ipv6")) return true;
  }
  return false;
}

export function loginIdentityHash(userId: number | null | undefined, identifier: string): string {
  const principal = userId ? `user:${Number(userId)}` : `identifier:${String(identifier || "").trim().toLowerCase()}`;
  return crypto.createHash("sha256").update(principal).digest("hex");
}

export function loginIpIdentityHash(ip: string): string {
  return crypto.createHash("sha256").update(`ip:${normalizeIp(ip) || "unknown"}`).digest("hex");
}

function baselineLoginLimit(): { maxRetries: number; lockMinutes: number } {
  return {
    maxRetries: boundedInteger(process.env.FANJIN_LOGIN_MAX_RETRIES_PER_HOUR, 10, 3, 1000),
    lockMinutes: boundedInteger(process.env.FANJIN_LOGIN_LOCK_MINUTES, 15, 1, 1440),
  };
}

export function effectiveLoginLimit(policy: AccountSecurityPolicy): { maxRetries: number; lockMinutes: number } {
  if (policy.loginProtectionEnabled) {
    return {
      maxRetries: policy.passwordPolicy.maxRetriesPerHour,
      lockMinutes: policy.passwordPolicy.lockMinutes,
    };
  }
  return baselineLoginLimit();
}

export function effectiveIpLoginLimit(): { maxRetries: number; lockMinutes: number } {
  return {
    maxRetries: boundedInteger(process.env.FANJIN_LOGIN_IP_MAX_RETRIES_PER_HOUR, 100, 10, 10000),
    lockMinutes: boundedInteger(process.env.FANJIN_LOGIN_IP_LOCK_MINUTES, 15, 1, 1440),
  };
}

export interface LoginLimitResult {
  blocked: boolean;
  retryAfterSeconds: number;
}

export async function checkLoginLimit(
  knex: Knex,
  identityHash: string,
  limit: { maxRetries: number; lockMinutes: number },
  timestamp = Date.now(),
): Promise<LoginLimitResult> {
  const row = await knex<any>(LOGIN_STATE_TABLE).where({ identityHash }).first();
  if (!row) return { blocked: false, retryAfterSeconds: 0 };

  const lockedUntil = Number(row.lockedUntil || 0);
  if (lockedUntil > timestamp) {
    return { blocked: true, retryAfterSeconds: Math.max(1, Math.ceil((lockedUntil - timestamp) / 1000)) };
  }

  if (lockedUntil > 0 || Number(row.windowStartedAt || 0) + LOGIN_WINDOW_MS <= timestamp) {
    await knex<any>(LOGIN_STATE_TABLE)
      .where({ identityHash })
      .where("updatedAt", "<=", Number(row.updatedAt || timestamp))
      .update({ failedCount: 0, windowStartedAt: timestamp, lockedUntil: null, updatedAt: timestamp });
    return { blocked: false, retryAfterSeconds: 0 };
  }

  if (Number(row.failedCount || 0) >= limit.maxRetries) {
    const nextLockedUntil = timestamp + limit.lockMinutes * 60 * 1000;
    await knex<any>(LOGIN_STATE_TABLE)
      .where({ identityHash })
      .whereNull("lockedUntil")
      .update({ lockedUntil: nextLockedUntil, updatedAt: timestamp });
    return { blocked: true, retryAfterSeconds: limit.lockMinutes * 60 };
  }

  return { blocked: false, retryAfterSeconds: 0 };
}

export async function recordLoginFailure(
  knex: Knex,
  input: {
    identityHash: string;
    userId?: number | null;
    limit: { maxRetries: number; lockMinutes: number };
    timestamp?: number;
  },
): Promise<LoginLimitResult> {
  const timestamp = input.timestamp ?? Date.now();
  const cutoff = timestamp - LOGIN_WINDOW_MS;
  await knex<any>(LOGIN_STATE_TABLE).where("updatedAt", "<", timestamp - 7 * 24 * 60 * 60 * 1000).delete();
  await knex<any>(LOGIN_STATE_TABLE)
    .insert({
      identityHash: input.identityHash,
      userId: input.userId ?? null,
      failedCount: 1,
      windowStartedAt: timestamp,
      lockedUntil: null,
      lastFailedAt: timestamp,
      updatedAt: timestamp,
    })
    .onConflict("identityHash")
    .merge({
      userId: input.userId ?? null,
      failedCount: knex.raw(
        `CASE WHEN ?? < ? THEN 1 ELSE ?? + 1 END`,
        [`${LOGIN_STATE_TABLE}.windowStartedAt`, cutoff, `${LOGIN_STATE_TABLE}.failedCount`],
      ),
      windowStartedAt: knex.raw(
        `CASE WHEN ?? < ? THEN ? ELSE ?? END`,
        [`${LOGIN_STATE_TABLE}.windowStartedAt`, cutoff, timestamp, `${LOGIN_STATE_TABLE}.windowStartedAt`],
      ),
      lockedUntil: knex.raw(
        `CASE WHEN ?? > ? THEN ?? ELSE NULL END`,
        [`${LOGIN_STATE_TABLE}.lockedUntil`, timestamp, `${LOGIN_STATE_TABLE}.lockedUntil`],
      ),
      lastFailedAt: timestamp,
      updatedAt: timestamp,
    });

  const row = await knex<any>(LOGIN_STATE_TABLE).where({ identityHash: input.identityHash }).first();
  if (Number(row?.failedCount || 0) < input.limit.maxRetries) {
    return { blocked: false, retryAfterSeconds: 0 };
  }

  const nextLockedUntil = timestamp + input.limit.lockMinutes * 60 * 1000;
  await knex<any>(LOGIN_STATE_TABLE)
    .where({ identityHash: input.identityHash })
    .where((query) => query.whereNull("lockedUntil").orWhere("lockedUntil", "<=", timestamp))
    .update({ lockedUntil: nextLockedUntil, updatedAt: timestamp });
  const lockedRow = await knex<any>(LOGIN_STATE_TABLE).where({ identityHash: input.identityHash }).first();
  const effectiveLockedUntil = Math.max(timestamp, Number(lockedRow?.lockedUntil || nextLockedUntil));
  return {
    blocked: true,
    retryAfterSeconds: Math.max(1, Math.ceil((effectiveLockedUntil - timestamp) / 1000)),
  };
}

export async function clearLoginFailures(knex: Knex, identityHash: string, attemptedAt: number): Promise<void> {
  await knex<any>(LOGIN_STATE_TABLE).where({ identityHash }).where("updatedAt", "<=", attemptedAt).delete();
}
