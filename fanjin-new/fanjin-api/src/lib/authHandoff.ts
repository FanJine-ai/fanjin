import crypto from "node:crypto";
import type { Request, Response } from "express";
import type { Knex } from "knex";
import { v4 as uuid } from "uuid";
import { AuthError } from "@/lib/authErrors";
import { isProductionRuntime } from "@/lib/legacyAsyncRelaySafety";

export type AuthHandoffFlow = "password_reset" | "verify_email";

export const AUTH_HANDOFF_VERSION = 2;
export const AUTH_HANDOFF_SEED_COOKIE = "__Host-fj_handoff_seed";
export const AUTH_HANDOFF_CLAIM_COOKIE = "__Host-fj_handoff_claim";
export const AUTH_HANDOFF_CLAIM_TTL_MS = 10 * 60 * 1000;
const AUTH_HANDOFF_MAX_CODE_ATTEMPTS = 5;
const AUTH_HANDOFF_LOCATOR_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AUTH_HANDOFF_SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
const AUTH_HANDOFF_CODE_RE = /^[A-F0-9]{16}$/;

const SOURCE_TYPE: Readonly<Record<AuthHandoffFlow, string>> = {
  password_reset: "password_reset",
  verify_email: "verify_email",
};
const CLAIM_TYPE: Readonly<Record<AuthHandoffFlow, string>> = {
  password_reset: "password_reset_browser_claim",
  verify_email: "verify_email_browser_claim",
};

export interface AuthHandoffIssue {
  locator: string;
  code: string;
  codeMac: string;
  url: string;
}

function now(): number {
  return Date.now();
}

export function inspectAuthHandoffConfiguration(
  environment: Record<string, string | undefined> = process.env,
): { required: boolean; ready: boolean } {
  const required = isProductionRuntime(environment.NODE_ENV);
  const configured = String(environment.FANJIN_AUTH_HANDOFF_PEPPER || "").trim().length >= 32;
  return { required, ready: !required || configured };
}

function pepper(): string {
  const configured = String(process.env.FANJIN_AUTH_HANDOFF_PEPPER || "").trim();
  if (configured.length >= 32) return configured;
  if (inspectAuthHandoffConfiguration().required) {
    throw new AuthError("安全邮件交接尚未配置", 503, {
      code: "AUTH_HANDOFF_NOT_CONFIGURED",
    });
  }
  // Deterministic only for local/test fixtures. Production always fails closed.
  return "fanjin-local-auth-handoff-pepper-v2-only";
}

function digest(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function mac(value: string): string {
  return crypto.createHmac("sha256", pepper()).update(value).digest("hex");
}

function equalHex(left: unknown, right: unknown): boolean {
  const a = String(left || "");
  const b = String(right || "");
  if (!/^[a-f0-9]{64}$/i.test(a) || !/^[a-f0-9]{64}$/i.test(b)) return false;
  return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

function normalizeCode(value: unknown): string {
  return String(value || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

function displayCode(value: string): string {
  return value.match(/.{1,4}/g)?.join("-") || value;
}

function parseMetadata(raw: unknown): Record<string, any> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, any>;
  if (typeof raw !== "string" || !raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function cookieValue(req: Request, name: string): string {
  const raw = String(req.headers.cookie || "");
  for (const part of raw.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      return "";
    }
  }
  return "";
}

function cookieOptions(maxAge: number) {
  return {
    secure: true,
    httpOnly: true,
    sameSite: "strict" as const,
    path: "/",
    maxAge,
  };
}

export function ensureAuthHandoffSeed(req: Request, res: Response): string {
  const current = cookieValue(req, AUTH_HANDOFF_SEED_COOKIE);
  const seed = AUTH_HANDOFF_SECRET_RE.test(current)
    ? current
    : crypto.randomBytes(32).toString("base64url");
  res.cookie(AUTH_HANDOFF_SEED_COOKIE, seed, cookieOptions(24 * 60 * 60 * 1000));
  return seed;
}

export function readAuthHandoffSeed(req: Request): string {
  return cookieValue(req, AUTH_HANDOFF_SEED_COOKIE);
}

export function readAuthHandoffClaim(req: Request): string {
  return cookieValue(req, AUTH_HANDOFF_CLAIM_COOKIE);
}

export function setAuthHandoffClaim(res: Response, claim: string): void {
  res.cookie(AUTH_HANDOFF_CLAIM_COOKIE, claim, cookieOptions(AUTH_HANDOFF_CLAIM_TTL_MS));
}

export function clearAuthHandoffClaim(res: Response): void {
  res.clearCookie(AUTH_HANDOFF_CLAIM_COOKIE, {
    secure: true,
    httpOnly: true,
    sameSite: "strict",
    path: "/",
  });
}

export function setAuthHandoffResponseHeaders(res: Response): void {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
}

export function authHandoffSeedHash(seed: string): string | null {
  return AUTH_HANDOFF_SECRET_RE.test(seed) ? digest(`handoff-seed:v2:${seed}`) : null;
}

export function createAuthHandoffIssue(input: {
  flow: AuthHandoffFlow;
  publicBaseUrl: string;
  seed?: string | null;
}): AuthHandoffIssue {
  // Resolve the production pepper before issuing any database state.
  void pepper();
  const locator = uuid();
  const normalizedCode = crypto.randomBytes(8).toString("hex").toUpperCase();
  const code = displayCode(normalizedCode);
  const codeMac = mac(`handoff-code:v2:${input.flow}:${locator}:${normalizedCode}`);
  const base = String(input.publicBaseUrl || "").replace(/\/+$/, "");
  const route = input.flow === "password_reset" ? "reset-password" : "verify-email";
  return {
    locator,
    code,
    codeMac,
    // Locator is deliberately non-authorizing. No secret is present in query,
    // fragment, Referer, browser history, or edge logs.
    url: `${base}/index.html?handoff=${encodeURIComponent(locator)}#/auth/${route}`,
  };
}

function invalidHandoff(code = "AUTH_HANDOFF_INVALID"): AuthError {
  return new AuthError("邮件链接无效、已使用或已过期", 400, { code });
}

async function lockFamily(
  trx: Knex.Transaction,
  userId: number,
  types: readonly string[],
): Promise<any[]> {
  return await trx<any>("o_auth_token")
    .where({ userId })
    .whereIn("type", [...types])
    .orderBy("createdAt", "asc")
    .orderBy("id", "asc")
    .forUpdate()
    .select("*");
}

export async function claimAuthHandoff(
  database: Knex,
  input: {
    flow: AuthHandoffFlow;
    locator: string;
    code?: string | null;
    seed?: string | null;
  },
): Promise<{ claim: string; flow: AuthHandoffFlow }> {
  const locator = String(input.locator || "").trim();
  if (!AUTH_HANDOFF_LOCATOR_RE.test(locator)) throw invalidHandoff();
  const sourceType = SOURCE_TYPE[input.flow];
  const claimType = CLAIM_TYPE[input.flow];
  const candidate = await database<any>("o_auth_token")
    .where({ id: locator, type: sourceType })
    .select("id", "userId")
    .first();
  if (!candidate || !Number(candidate.userId)) throw invalidHandoff();

  const outcome = await database.transaction(async (trx) => {
    const user = await trx<any>("o_user")
      .where({ id: Number(candidate.userId) })
      .forUpdate()
      .first();
    if (!user || String(user.status || "") !== "active") throw invalidHandoff();

    const family = await lockFamily(trx, Number(user.id), [sourceType, claimType]);
    const row = family.find((item: any) => (
      String(item.id) === locator && String(item.type) === sourceType
    ));
    const timestamp = now();
    if (!row || row.usedAt !== null && row.usedAt !== undefined || Number(row.expiresAt || 0) <= timestamp) {
      throw invalidHandoff();
    }
    const metadata = parseMetadata(row.metadata);
    if (Number(metadata.handoffVersion) !== AUTH_HANDOFF_VERSION) {
      throw new AuthError("旧版邮件链接已停用，请重新申请", 410, {
        code: "AUTH_LINK_LEGACY_GONE",
      });
    }

    const seedHash = authHandoffSeedHash(String(input.seed || ""));
    const seedMatches = Boolean(
      seedHash
      && typeof metadata.seedHash === "string"
      && equalHex(seedHash, metadata.seedHash),
    );
    const suppliedCode = normalizeCode(input.code).slice(0, 65);
    const normalizedCode = AUTH_HANDOFF_CODE_RE.test(suppliedCode) ? suppliedCode : "";
    const codeWasSupplied = String(input.code || "").trim().length > 0;
    const suppliedCodeMac = normalizedCode
      ? mac(`handoff-code:v2:${input.flow}:${locator}:${normalizedCode}`)
      : "";
    const codeMatches = Boolean(normalizedCode && equalHex(suppliedCodeMac, row.tokenHash));
    if (!seedMatches && !codeMatches) {
      if (!codeWasSupplied) {
        throw new AuthError("请在原浏览器继续，或输入邮件中的安全码", 400, {
          code: "AUTH_HANDOFF_PROOF_REQUIRED",
        });
      }
      const failedAttempts = Number(metadata.failedAttempts || 0) + 1;
      metadata.failedAttempts = failedAttempts;
      await trx<any>("o_auth_token").where({ id: row.id }).update({
        metadata: JSON.stringify(metadata),
        ...(failedAttempts >= AUTH_HANDOFF_MAX_CODE_ATTEMPTS ? { usedAt: timestamp } : {}),
      });
      // Return instead of throwing so the failed-attempt counter/burn commits.
      return { error: invalidHandoff("AUTH_HANDOFF_CODE_INVALID") };
    }

    await trx<any>("o_auth_token")
      .where({ userId: Number(user.id), type: sourceType })
      .whereNull("usedAt")
      .update({ usedAt: timestamp });

    const claim = crypto.randomBytes(32).toString("base64url");
    await trx<any>("o_auth_token").insert({
      id: uuid(),
      userId: Number(user.id),
      workspaceId: row.workspaceId ?? null,
      tokenHash: digest(`handoff-claim:v2:${claim}`),
      type: claimType,
      metadata: JSON.stringify({
        ...metadata,
        handoffVersion: AUTH_HANDOFF_VERSION,
        flow: input.flow,
        sourceTokenId: locator,
        failedAttempts: 0,
      }),
      expiresAt: timestamp + AUTH_HANDOFF_CLAIM_TTL_MS,
      usedAt: null,
      createdAt: timestamp,
    });
    return { value: { claim, flow: input.flow } };
  });
  if ("error" in outcome && outcome.error) throw outcome.error;
  if (!("value" in outcome) || !outcome.value) throw invalidHandoff();
  return outcome.value;
}

/**
 * Legacy raw credentials are never honored. If a caller presents one, burn
 * its exact family before returning 410 so a mixed-version node cannot revive
 * it later.
 */
export async function burnLegacyAuthHandoff(
  database: Knex,
  flow: AuthHandoffFlow,
  rawCredential: string,
): Promise<void> {
  const raw = String(rawCredential || "").trim();
  if (!raw) return;
  const tokenHash = digest(raw);
  const candidate = await database<any>("o_auth_token")
    .where({ tokenHash, type: SOURCE_TYPE[flow] })
    .select("id", "userId")
    .first();
  if (!candidate || !Number(candidate.userId)) return;
  await database.transaction(async (trx) => {
    const user = await trx<any>("o_user")
      .where({ id: Number(candidate.userId) })
      .forUpdate()
      .first();
    if (!user) return;
    const family = await lockFamily(trx, Number(user.id), [SOURCE_TYPE[flow]]);
    const row = family.find((item: any) => String(item.id) === String(candidate.id));
    if (!row) return;
    const metadata = parseMetadata(row.metadata);
    if (Number(metadata.handoffVersion) === AUTH_HANDOFF_VERSION) return;
    await trx<any>("o_auth_token")
      .where({ userId: Number(user.id), type: SOURCE_TYPE[flow] })
      .whereNull("usedAt")
      .update({ usedAt: now() });
  });
}

export async function consumeAuthHandoffClaim<T>(
  database: Knex,
  input: {
    flow: AuthHandoffFlow;
    claim: string;
    consume(
      trx: Knex.Transaction,
      user: any,
      metadata: Record<string, any>,
      timestamp: number,
    ): Promise<T>;
  },
): Promise<T> {
  const claim = String(input.claim || "").trim();
  if (!AUTH_HANDOFF_SECRET_RE.test(claim)) throw invalidHandoff();
  const claimType = CLAIM_TYPE[input.flow];
  const tokenHash = digest(`handoff-claim:v2:${claim}`);
  const candidate = await database<any>("o_auth_token")
    .where({ tokenHash, type: claimType })
    .select("id", "userId")
    .first();
  if (!candidate || !Number(candidate.userId)) throw invalidHandoff();

  return await database.transaction(async (trx) => {
    const user = await trx<any>("o_user")
      .where({ id: Number(candidate.userId) })
      .forUpdate()
      .first();
    if (!user || String(user.status || "") !== "active") throw invalidHandoff();
    const family = await lockFamily(trx, Number(user.id), [
      SOURCE_TYPE[input.flow],
      claimType,
    ]);
    const row = family.find((item: any) => (
      String(item.id) === String(candidate.id)
      && String(item.tokenHash) === tokenHash
      && String(item.type) === claimType
    ));
    const timestamp = now();
    if (!row || row.usedAt !== null && row.usedAt !== undefined || Number(row.expiresAt || 0) <= timestamp) {
      throw invalidHandoff();
    }
    const metadata = parseMetadata(row.metadata);
    if (
      Number(metadata.handoffVersion) !== AUTH_HANDOFF_VERSION
      || metadata.flow !== input.flow
    ) {
      throw invalidHandoff();
    }
    await trx<any>("o_auth_token").where({ id: row.id }).whereNull("usedAt").update({
      usedAt: timestamp,
    });
    return await input.consume(trx, user, metadata, timestamp);
  });
}
