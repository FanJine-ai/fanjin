import crypto from "node:crypto";
import type { Response } from "express";
import type { Knex } from "knex";
import { v4 as uuid } from "uuid";
import { hashAuthToken } from "@/lib/auth";
import { DEFAULT_POST_LOGIN_REDIRECT } from "@/lib/oauth/config";
import type { OAuthProviderId } from "@/lib/oauth/types";

const OAUTH_STATE_TYPE = "oauth_login_state";
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
export const OAUTH_BROWSER_COOKIE = "fanjin_oauth_browser";
export const OAUTH_EXCHANGE_TTL_MS = 60 * 1000;

export interface OAuthLoginState {
  id: string;
  provider: OAuthProviderId;
  redirect: string;
  returnTo?: string | null;
  mode?: string | null;
  bootstrap?: OAuthBootstrapStateBinding | null;
}

export interface OAuthBrowserBinding {
  nonce: string;
  codeVerifier?: string | null;
}

export interface OAuthBootstrapStateBinding {
  scope: "account.password.bootstrap";
  userId: number;
  sessionId: string;
  authGeneration: number;
  identityId: string;
  identityGeneration: number;
  openId: string;
}

function now(): number {
  return Date.now();
}

function parseMetadata(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== "string" || !raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function secureHashEquals(rawValue: string, expectedHash: unknown): boolean {
  const actual = Buffer.from(hashAuthToken(rawValue), "hex");
  const expected = Buffer.from(String(expectedHash || ""), "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function encodeBrowserBinding(binding: OAuthBrowserBinding): string {
  return Buffer.from(JSON.stringify({
    n: String(binding.nonce || ""),
    v: String(binding.codeVerifier || ""),
  })).toString("base64url");
}

export function createOAuthBrowserBinding(usePkce: boolean): OAuthBrowserBinding {
  return {
    nonce: crypto.randomBytes(32).toString("base64url"),
    codeVerifier: usePkce
      ? crypto.randomBytes(48).toString("base64url")
      : null,
  };
}

export function oauthCodeChallenge(codeVerifier: string): string {
  return crypto
    .createHash("sha256")
    .update(String(codeVerifier || ""))
    .digest("base64url");
}

export function readOAuthBrowserBinding(cookieHeader: unknown): OAuthBrowserBinding | null {
  const cookies = String(cookieHeader || "")
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const prefix = `${OAUTH_BROWSER_COOKIE}=`;
  const encoded = cookies.find((entry) => entry.startsWith(prefix))?.slice(prefix.length);
  if (!encoded) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(decodeURIComponent(encoded), "base64url").toString("utf8"),
    );
    const nonce = String(parsed?.n || "").trim();
    const codeVerifier = String(parsed?.v || "").trim() || null;
    if (!nonce) return null;
    return { nonce, codeVerifier };
  } catch {
    return null;
  }
}

export function setOAuthBrowserBindingCookie(
  res: Response,
  binding: OAuthBrowserBinding,
  input: { secure: boolean; maxAgeMs?: number } ,
): void {
  res.cookie(OAUTH_BROWSER_COOKIE, encodeBrowserBinding(binding), {
    httpOnly: true,
    sameSite: "lax",
    secure: input.secure,
    path: "/api/auth/oauth",
    maxAge: input.maxAgeMs ?? OAUTH_STATE_TTL_MS,
  });
}

export function clearOAuthBrowserBindingCookie(
  res: Response,
  secure: boolean,
): void {
  res.clearCookie(OAUTH_BROWSER_COOKIE, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/api/auth/oauth",
  });
}

export async function issueOAuthLoginState(
  knex: Knex,
  input: {
    provider: OAuthProviderId;
    redirect: string;
    returnTo?: string | null;
    mode?: string | null;
    browserBinding: OAuthBrowserBinding;
    bootstrap?: OAuthBootstrapStateBinding | null;
  },
): Promise<string> {
  const browserNonce = String(input.browserBinding?.nonce || "").trim();
  if (!browserNonce) throw new Error("OAUTH_BROWSER_BINDING_INVALID");
  const codeVerifier = String(input.browserBinding?.codeVerifier || "").trim();
  const rawState = crypto.randomBytes(24).toString("base64url");
  const timestamp = now();
  await knex<any>("o_auth_token").insert({
    id: uuid(),
    userId: input.bootstrap?.userId ?? null,
    workspaceId: null,
    tokenHash: hashAuthToken(rawState),
    type: OAUTH_STATE_TYPE,
    metadata: JSON.stringify({
      provider: input.provider,
      redirect: input.redirect,
      returnTo: input.returnTo || null,
      mode: input.mode || null,
      browserNonceHash: hashAuthToken(browserNonce),
      codeVerifierHash: codeVerifier ? hashAuthToken(codeVerifier) : null,
      bootstrap: input.bootstrap || null,
    }),
    expiresAt: timestamp + OAUTH_STATE_TTL_MS,
    usedAt: null,
    createdAt: timestamp,
  });
  return rawState;
}

export async function consumeOAuthLoginState(
  knex: Knex,
  rawState: string,
  expectedProvider: OAuthProviderId,
  browserBinding: OAuthBrowserBinding | null,
): Promise<OAuthLoginState> {
  const state = String(rawState || "").trim();
  if (!state) throw new Error("OAUTH_STATE_INVALID");
  const timestamp = now();
  const tokenHash = hashAuthToken(state);

  const row = await knex<any>("o_auth_token")
    .where({ tokenHash, type: OAUTH_STATE_TYPE })
    .whereNull("usedAt")
    .first();
  if (!row) throw new Error("OAUTH_STATE_INVALID");

  // Claim before validating metadata. The conditional write gives exact
  // one-time semantics across processes and deliberately burns expired,
  // cross-provider, or browser-mismatched states without a later rollback.
  const claimed = await knex<any>("o_auth_token")
    .where({ id: row.id })
    .whereNull("usedAt")
    .update({ usedAt: timestamp });
  if (Number(claimed || 0) !== 1) throw new Error("OAUTH_STATE_INVALID");

  if (Number(row.expiresAt || 0) <= timestamp) {
    throw new Error("OAUTH_STATE_EXPIRED");
  }
  const metadata = parseMetadata(row.metadata);
  const provider = String(metadata.provider || "");
  if (provider !== expectedProvider) {
    throw new Error("OAUTH_STATE_PROVIDER_MISMATCH");
  }
  const browserNonce = String(browserBinding?.nonce || "").trim();
  const codeVerifier = String(browserBinding?.codeVerifier || "").trim();
  if (
    !browserNonce
    || !secureHashEquals(browserNonce, metadata.browserNonceHash)
    || (
      metadata.codeVerifierHash != null
      && (
        !codeVerifier
        || !secureHashEquals(codeVerifier, metadata.codeVerifierHash)
      )
    )
  ) {
    throw new Error("OAUTH_BROWSER_BINDING_INVALID");
  }
  return {
    id: String(row.id),
    provider: expectedProvider,
    redirect: String(metadata.redirect || DEFAULT_POST_LOGIN_REDIRECT),
    returnTo: metadata.returnTo == null ? null : String(metadata.returnTo),
    mode: metadata.mode == null ? null : String(metadata.mode),
    bootstrap: metadata.bootstrap
      && typeof metadata.bootstrap === "object"
      && !Array.isArray(metadata.bootstrap)
      ? metadata.bootstrap as OAuthBootstrapStateBinding
      : null,
  };
}
