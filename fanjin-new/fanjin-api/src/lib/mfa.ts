import crypto from "node:crypto";
import type { Knex } from "knex";
import { v4 as uuid } from "uuid";
import { verifyPassword } from "@/lib/passwordHash";
import { isSealedSecret, openSecret, sealSecret } from "@/lib/secretEnvelope";

type MfaDb = Knex | Knex.Transaction;

const MFA_RECOVERY_TABLE = "o_account_mfa_recovery_code";
const MFA_CHALLENGE_TYPE = "mfa_login_challenge";
const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 6;
const MFA_SETUP_TTL_MS = 10 * 60 * 1000;
const MFA_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MFA_TOTP_REPLAY_TTL_MS = 3 * 60 * 1000;
const RECOVERY_CODE_COUNT = 8;
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export class MfaError extends Error {
  status: number;
  code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "MfaError";
    this.status = status;
    this.code = code;
  }
}

function base32Encode(input: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(input: string): Buffer {
  const normalized = input.toUpperCase().replace(/=+$/g, "").replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of normalized) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index < 0) throw new MfaError("TOTP secret 格式无效", 503, "MFA_CONFIGURATION_INVALID");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  if (!bytes.length) throw new MfaError("TOTP secret 格式无效", 503, "MFA_CONFIGURATION_INVALID");
  return Buffer.from(bytes);
}

function totpAtCounter(secret: string, counter: number): string {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac("sha1", base32Decode(secret)).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function generateTotpCode(secret: string, timestamp = Date.now()): string {
  return totpAtCounter(secret, Math.floor(timestamp / 1000 / TOTP_PERIOD_SECONDS));
}

export function verifyTotpCode(secret: string, code: string, timestamp = Date.now()): boolean {
  const normalized = String(code || "").trim();
  if (!/^\d{6}$/.test(normalized)) return false;
  const counter = Math.floor(timestamp / 1000 / TOTP_PERIOD_SECONDS);
  return [-1, 0, 1].some((offset) => safeEqual(totpAtCounter(secret, counter + offset), normalized));
}

function secretPurpose(userId: number, state: "pending" | "active"): string {
  return `account-mfa-${state}:${userId}`;
}

function sealStoredSecret(secret: string, userId: number, state: "pending" | "active"): string {
  try {
    return sealSecret(secret, secretPurpose(userId, state));
  } catch {
    throw new MfaError("MFA secret 加密存储不可用，已拒绝操作", 503, "MFA_SECRET_STORAGE_UNAVAILABLE");
  }
}

function openStoredSecret(value: unknown, userId: number, state: "pending" | "active"): string {
  if (!isSealedSecret(value)) {
    throw new MfaError(
      "此账号的 MFA 配置不完整或尚未完成安全迁移，已拒绝验证",
      403,
      "MFA_MIGRATION_REQUIRED",
    );
  }
  try {
    return openSecret(String(value), secretPurpose(userId, state));
  } catch {
    throw new MfaError("此账号的 MFA 配置无法解密，已拒绝验证", 503, "MFA_CONFIGURATION_INVALID");
  }
}

function normalizeRecoveryCode(code: string): string {
  return String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function recoveryCodeHash(userId: number, code: string): string {
  return crypto.createHash("sha256").update(`mfa-recovery:v1:${userId}:${normalizeRecoveryCode(code)}`).digest("hex");
}

function generateRecoveryCode(): string {
  return crypto.randomBytes(10).toString("hex").toUpperCase().match(/.{1,5}/g)!.join("-");
}

function challengeHash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function nextMonotonicTimestamp(values: unknown[], timestamp = Date.now()): number {
  let next = timestamp;
  for (const value of values) {
    const previous = Number(value || 0);
    if (Number.isFinite(previous)) next = Math.max(next, previous + 1);
  }
  return next;
}

async function lockActiveUser(trx: Knex.Transaction, userId: number): Promise<any> {
  const user = await trx<any>("o_user")
    .where({ id: userId })
    .forUpdate()
    .first();
  if (!user || String(user.status || "") !== "active") {
    throw new MfaError("账号不可用", 403, "ACCOUNT_UNAVAILABLE");
  }
  return user;
}

async function lockSecurityRow(trx: Knex.Transaction, userId: number): Promise<any | null> {
  return await trx<any>("o_account_security")
    .where({ userId })
    .forUpdate()
    .first();
}

async function lockMfaChallengeFamily(trx: Knex.Transaction, userId: number): Promise<any[]> {
  return await trx<any>("o_auth_token")
    .where({ userId, type: MFA_CHALLENGE_TYPE })
    .orderBy("createdAt", "asc")
    .orderBy("id", "asc")
    .forUpdate()
    .select("*");
}

async function markUnusedMfaChallengeFamilyUsed(
  trx: Knex.Transaction,
  userId: number,
  timestamp: number,
): Promise<void> {
  await trx<any>("o_auth_token")
    .where({ userId, type: MFA_CHALLENGE_TYPE })
    .whereNull("usedAt")
    .update({ usedAt: timestamp });
}

function mfaGeneration(row: any): string {
  return `${row?.mfaEnabled ? "enabled" : "disabled"}:${Number(row?.updatedAt || 0)}`;
}

async function revokeFactorBoundTokens(
  trx: Knex.Transaction,
  userId: number,
  timestamp: number,
): Promise<void> {
  await trx<any>("o_auth_token")
    .where({ userId })
    .whereIn("type", [
      MFA_CHALLENGE_TYPE,
      "step_up_proof",
      "session_step_up_assurance",
    ])
    .whereNull("usedAt")
    .update({ usedAt: timestamp });
}

async function securityRow(client: MfaDb, userId: number): Promise<any | null> {
  return await (client as any)("o_account_security").where({ userId }).first();
}

export async function readActiveMfaSecret(client: MfaDb, userId: number): Promise<string> {
  const row = await securityRow(client, userId);
  if (!row?.mfaEnabled) throw new MfaError("此账号未启用 MFA", 409, "MFA_NOT_ENABLED");
  return openStoredSecret(row.mfaSecret, userId, "active");
}

export async function beginMfaSetup(
  knex: Knex,
  input: { userId: number; accountLabel: string; issuer?: string },
): Promise<{ secret: string; otpauthUri: string; expiresAt: number }> {
  const secret = base32Encode(crypto.randomBytes(20));
  const pendingSecret = sealStoredSecret(secret, input.userId, "pending");
  const issued = await knex.transaction(async (trx) => {
    await lockActiveUser(trx, input.userId);
    const existing = await lockSecurityRow(trx, input.userId);
    if (existing?.mfaEnabled) {
      throw new MfaError("MFA 已启用，请先完成验证后再禁用或重置", 409, "MFA_ALREADY_ENABLED");
    }
    const issuedAt = Date.now();
    const generationAt = nextMonotonicTimestamp([existing?.updatedAt], issuedAt);
    // Keep credential lifetime on wall-clock time; updatedAt is a monotonic
    // generation and may legitimately be ahead after clock correction.
    const expiresAt = issuedAt + MFA_SETUP_TTL_MS;
    if (existing) {
      const updated = await trx<any>("o_account_security")
        .where({ id: existing.id, userId: input.userId, updatedAt: existing.updatedAt })
        .update({
          mfaPendingSecret: pendingSecret,
          mfaPendingCreatedAt: issuedAt,
          updatedAt: generationAt,
        });
      if (Number(updated || 0) !== 1) {
        throw new MfaError("MFA setup 状态已变化，请重试", 409, "MFA_SETUP_CONFLICT");
      }
    } else {
      await trx<any>("o_account_security").insert({
        id: String(input.userId),
        userId: input.userId,
        phone: null,
        mfaEnabled: 0,
        mfaSecret: null,
        mfaPendingSecret: pendingSecret,
        mfaPendingCreatedAt: issuedAt,
        mfaConfiguredAt: null,
        loginProtectionEnabled: 0,
        sensitiveOperationProtectionEnabled: 0,
        loginIpAllowlist: "",
        passwordPolicy: "{}",
        sessionPolicy: "{}",
        createdAt: issuedAt,
        updatedAt: generationAt,
      });
    }
    await revokeFactorBoundTokens(trx, input.userId, issuedAt);
    return { expiresAt };
  });

  const issuer = String(input.issuer || "Fanjin").trim() || "Fanjin";
  const accountLabel = String(input.accountLabel || input.userId).trim() || String(input.userId);
  const otpauthUri = `otpauth://totp/${encodeURIComponent(`${issuer}:${accountLabel}`)}?secret=${secret}`
    + `&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD_SECONDS}`;
  return { secret, otpauthUri, expiresAt: issued.expiresAt };
}

export async function completeMfaSetup(
  knex: Knex,
  input: { userId: number; code: string; currentSessionId?: string | null },
): Promise<{ enabled: true; recoveryCodes: string[]; configuredAt: number }> {
  return await knex.transaction(async (trx) => {
    await lockActiveUser(trx, input.userId);
    const row = await lockSecurityRow(trx, input.userId);
    if (!row) throw new MfaError("请先发起 MFA setup", 409, "MFA_SETUP_REQUIRED");
    if (row.mfaEnabled) throw new MfaError("MFA 已启用", 409, "MFA_ALREADY_ENABLED");
    const timestamp = Date.now();
    const pendingCreatedAt = Number(row.mfaPendingCreatedAt || 0);
    if (!pendingCreatedAt || pendingCreatedAt + MFA_SETUP_TTL_MS <= timestamp) {
      throw new MfaError("MFA setup 已过期，请重新发起", 410, "MFA_SETUP_EXPIRED");
    }
    const secret = openStoredSecret(row.mfaPendingSecret, input.userId, "pending");
    if (!verifyTotpCode(secret, input.code, timestamp)) {
      throw new MfaError("TOTP 验证码错误", 400, "MFA_CODE_INVALID");
    }

    const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
    const configuredAt = nextMonotonicTimestamp(
      [row.updatedAt, row.mfaPendingCreatedAt, row.mfaConfiguredAt],
      timestamp,
    );
    const updated = await trx<any>("o_account_security")
      .where({
        id: row.id,
        userId: input.userId,
        mfaEnabled: 0,
        mfaPendingSecret: row.mfaPendingSecret,
        updatedAt: row.updatedAt,
      })
      .update({
        mfaEnabled: 1,
        mfaSecret: sealStoredSecret(secret, input.userId, "active"),
        mfaPendingSecret: null,
        mfaPendingCreatedAt: null,
        mfaConfiguredAt: configuredAt,
        updatedAt: configuredAt,
      });
    if (Number(updated || 0) !== 1) throw new MfaError("MFA setup 状态已变化，请重试", 409, "MFA_SETUP_CONFLICT");
    await trx<any>(MFA_RECOVERY_TABLE).where({ userId: input.userId }).delete();
    await trx<any>(MFA_RECOVERY_TABLE).insert(recoveryCodes.map((code) => ({
      id: uuid(),
      userId: input.userId,
      codeHash: recoveryCodeHash(input.userId, code),
      usedAt: null,
      createdAt: configuredAt,
    })));
    await revokeFactorBoundTokens(trx, input.userId, configuredAt);
    const sessions = trx<any>("o_user_session").where({ userId: input.userId }).whereNull("revokedAt");
    if (input.currentSessionId) sessions.whereNot({ id: input.currentSessionId });
    await sessions.update({ revokedAt: configuredAt, updatedAt: configuredAt });
    return { enabled: true as const, recoveryCodes, configuredAt };
  });
}

export async function verifyMfaCredential(
  client: MfaDb,
  input: { userId: number; credential: string; totpReplayDomain?: string },
): Promise<{ valid: boolean; method: "totp" | "recovery" | null }> {
  const row = await securityRow(client, input.userId);
  if (!row?.mfaEnabled) throw new MfaError("此账号未启用 MFA", 409, "MFA_NOT_ENABLED");
  const secret = openStoredSecret(row.mfaSecret, input.userId, "active");
  const credential = String(input.credential || "").trim();
  if (/^\d{6}$/.test(credential)) {
    if (!verifyTotpCode(secret, credential)) return { valid: false, method: "totp" };
    const replayDomain = String(input.totpReplayDomain || "").trim();
    if (replayDomain) {
      const timestamp = Date.now();
      const type = `mfa_totp_use:${replayDomain}`;
      const tokenHash = challengeHash(
        `mfa-totp-use:v1:${input.userId}:${mfaGeneration(row)}:${secret}:${credential}`,
      );
      await (client as any)("o_auth_token")
        .where({ userId: input.userId, type })
        .where("expiresAt", "<=", timestamp)
        .delete();
      const existing = await (client as any)("o_auth_token")
        .where({ userId: input.userId, type, tokenHash })
        .first();
      if (existing) return { valid: false, method: "totp" };
      try {
        await (client as any)("o_auth_token").insert({
          id: uuid(),
          userId: input.userId,
          workspaceId: null,
          tokenHash,
          type,
          metadata: JSON.stringify({ mfaGeneration: mfaGeneration(row) }),
          expiresAt: timestamp + MFA_TOTP_REPLAY_TTL_MS,
          usedAt: timestamp,
          createdAt: timestamp,
        });
      } catch (error) {
        const code = String((error as { code?: unknown })?.code || "");
        if (code === "23505" || code.startsWith("SQLITE_CONSTRAINT")) {
          return { valid: false, method: "totp" };
        }
        throw error;
      }
    }
    return { valid: true, method: "totp" };
  }
  const normalized = normalizeRecoveryCode(credential);
  if (!normalized) return { valid: false, method: null };
  const usedAt = Date.now();
  const updated = await (client as any)(MFA_RECOVERY_TABLE)
    .where({ userId: input.userId, codeHash: recoveryCodeHash(input.userId, normalized) })
    .whereNull("usedAt")
    .update({ usedAt });
  return { valid: Number(updated || 0) === 1, method: "recovery" };
}

export async function disableMfa(
  knex: Knex,
  input: {
    userId: number;
    credential: string;
    currentPassword: string;
    currentSessionId?: string | null;
  },
): Promise<{ disabled: true }> {
  const result = await knex.transaction(async (trx) => {
    const user = await lockActiveUser(trx, input.userId);
    if (!(await verifyPassword(input.currentPassword, String(user.password || "")))) {
      throw new MfaError("当前密码错误", 403, "CURRENT_PASSWORD_INVALID");
    }
    const security = await lockSecurityRow(trx, input.userId);
    if (!security?.mfaEnabled) {
      throw new MfaError("此账号未启用 MFA", 409, "MFA_NOT_ENABLED");
    }
    const verified = await verifyMfaCredential(trx, input);
    if (!verified.valid) return false;
    const timestamp = nextMonotonicTimestamp(
      [security.updatedAt, security.mfaConfiguredAt],
    );
    const updated = await trx<any>("o_account_security").where({
      id: security.id,
      userId: input.userId,
      mfaEnabled: 1,
      updatedAt: security.updatedAt,
    }).update({
      mfaEnabled: 0,
      mfaSecret: null,
      mfaPendingSecret: null,
      mfaPendingCreatedAt: null,
      mfaConfiguredAt: null,
      updatedAt: timestamp,
    });
    if (Number(updated || 0) !== 1) throw new MfaError("MFA 状态已变化，请重试", 409, "MFA_STATE_CONFLICT");
    await trx<any>(MFA_RECOVERY_TABLE).where({ userId: input.userId }).delete();
    await revokeFactorBoundTokens(trx, input.userId, timestamp);
    const sessions = trx<any>("o_user_session").where({ userId: input.userId }).whereNull("revokedAt");
    if (input.currentSessionId) sessions.whereNot({ id: input.currentSessionId });
    await sessions.update({ revokedAt: timestamp, updatedAt: timestamp });
    return true;
  });
  if (!result) throw new MfaError("TOTP 验证码或恢复码错误", 400, "MFA_CODE_INVALID");
  return { disabled: true };
}

export async function issueMfaLoginChallenge(
  knex: Knex,
  input: {
    userId: number;
    workspaceId?: string | null;
    userAgent?: string;
    ip?: string;
    passwordVersion: string;
    mustChangePassword?: boolean;
  },
): Promise<{ challenge: string; expiresAt: number }> {
  const challenge = crypto.randomBytes(32).toString("base64url");
  const issued = await knex.transaction(async (trx) => {
    const user = await lockActiveUser(trx, input.userId);
    if (
      !input.passwordVersion
      || input.passwordVersion !== challengeHash(String(user.password || ""))
    ) {
      throw new MfaError("密码状态已变化，请重新登录", 401, "MFA_CHALLENGE_INVALID");
    }
    const security = await lockSecurityRow(trx, input.userId);
    if (!security?.mfaEnabled) {
      throw new MfaError("此账号未启用 MFA", 409, "MFA_NOT_ENABLED");
    }
    // Fail closed if the active secret cannot be opened before issuing.
    openStoredSecret(security.mfaSecret, input.userId, "active");
    await lockMfaChallengeFamily(trx, input.userId);
    const timestamp = Date.now();
    const expiresAt = timestamp + MFA_CHALLENGE_TTL_MS;
    await markUnusedMfaChallengeFamilyUsed(trx, input.userId, timestamp);
    await trx<any>("o_auth_token").insert({
      id: uuid(),
      userId: input.userId,
      workspaceId: input.workspaceId ?? null,
      tokenHash: challengeHash(challenge),
      type: MFA_CHALLENGE_TYPE,
      metadata: JSON.stringify({
        userAgent: input.userAgent ?? null,
        ip: input.ip ?? null,
        passwordVersion: input.passwordVersion,
        authGeneration: Number(user.updatedAt || 0),
        mfaGeneration: mfaGeneration(security),
        mustChangePassword: Boolean(input.mustChangePassword),
      }),
      expiresAt,
      usedAt: null,
      createdAt: timestamp,
    });
    return { expiresAt };
  });
  return { challenge, expiresAt: issued.expiresAt };
}

export async function readMfaLoginChallenge(client: MfaDb, challenge: string): Promise<any | null> {
  const token = String(challenge || "").trim();
  if (!token) return null;
  return await (client as any)("o_auth_token")
    .where({ tokenHash: challengeHash(token), type: MFA_CHALLENGE_TYPE })
    .whereNull("usedAt")
    .first();
}

export async function consumeMfaLoginChallenge(client: MfaDb, id: string, timestamp = Date.now()): Promise<boolean> {
  const updated = await (client as any)("o_auth_token").where({ id }).whereNull("usedAt").update({ usedAt: timestamp });
  return Number(updated || 0) === 1;
}
