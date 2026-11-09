import crypto from "node:crypto";
import type { Knex } from "knex";
import { v4 as uuid } from "uuid";
import { getAccountSecurityPolicy } from "@/lib/accountSecurity";
import {
  AuthError,
  createSession,
  hashAuthToken,
  type RequestAuthInfo,
} from "@/lib/auth";
import {
  assertOAuthAccountPolicy,
  clearOAuthLoginFailureFamily,
  oauthMfaGeneration,
  prepareOAuthLoginFailureContext,
  recordOAuthLoginFailureFamily,
  verifyOAuthMfaCredential,
  type OAuthLoginFailureContext,
} from "@/lib/oauth/security";
import {
  OAUTH_EXCHANGE_TTL_MS,
  type OAuthBrowserBinding,
} from "@/lib/oauth/state";
import {
  isOAuthProviderId,
  type OAuthProviderId,
} from "@/lib/oauth/types";
import { USER_OAUTH_IDENTITY_TABLE } from "@/lib/migrations/userOauthIdentity";

const OAUTH_SESSION_EXCHANGE_TYPE = "oauth_session_exchange";
const OAUTH_MFA_CHALLENGE_TYPE = "oauth_mfa_login_challenge";
export const OAUTH_MFA_CHALLENGE_TTL_MS = 5 * 60 * 1000;

function parseMetadata(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw !== "string" || !raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function secureHashEquals(rawValue: string, expectedHash: unknown): boolean {
  const actual = Buffer.from(hashAuthToken(rawValue), "hex");
  const expected = Buffer.from(String(expectedHash || ""), "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function primaryFactorHash(identity: {
  id?: unknown;
  provider?: unknown;
  openId?: unknown;
}): string {
  return hashAuthToken([
    "oauth-primary-factor:v1",
    String(identity.provider || ""),
    String(identity.id || ""),
    String(identity.openId || ""),
  ].join("\0"));
}

function authErrorForExchangeCode(code: string): AuthError {
  const messages: Record<string, { message: string; status: number }> = {
    OAUTH_EXCHANGE_INVALID: { message: "登录交换码无效", status: 400 },
    OAUTH_EXCHANGE_EXPIRED: { message: "登录交换码已过期，请重试", status: 400 },
    OAUTH_BROWSER_BINDING_INVALID: { message: "登录浏览器校验失败，请重试", status: 400 },
    OAUTH_PRIMARY_FACTOR_CHANGED: { message: "第三方登录身份已变化，请重试", status: 401 },
    ACCOUNT_UNAVAILABLE: { message: "账号不可用", status: 403 },
  };
  const details = messages[code] || messages.OAUTH_EXCHANGE_INVALID;
  return new AuthError(details.message, details.status, { code });
}

export async function issueOAuthSessionExchange(
  knex: Knex,
  input: {
    userId: number;
    provider: OAuthProviderId;
    openId: string;
    browserBinding: OAuthBrowserBinding;
  },
): Promise<string> {
  const userId = Number(input.userId || 0);
  const provider = String(input.provider || "");
  const openId = String(input.openId || "").trim();
  const browserNonce = String(input.browserBinding?.nonce || "").trim();
  if (!Number.isSafeInteger(userId) || userId < 1) {
    throw new AuthError("账号不可用", 403, { code: "ACCOUNT_UNAVAILABLE" });
  }
  if (!isOAuthProviderId(provider) || !openId) {
    throw new AuthError("第三方账号信息不完整", 400, {
      code: "OAUTH_PROFILE_INVALID",
    });
  }
  if (!browserNonce) throw new Error("OAUTH_BROWSER_BINDING_INVALID");

  const rawExchange = crypto.randomBytes(32).toString("base64url");
  await knex.transaction(async (trx) => {
    // The exchange can only be minted for the exact live identity that just
    // supplied the OAuth primary factor. The user row remains the authority
    // lock; bind/disable cannot move or revive this identity underneath it.
    const user = await trx<any>("o_user")
      .where({ id: userId })
      .forUpdate()
      .first();
    if (!user || String(user.status || "") !== "active") {
      throw new AuthError("账号不可用", 403, {
        code: "ACCOUNT_UNAVAILABLE",
      });
    }
    const identity = await trx<any>(USER_OAUTH_IDENTITY_TABLE)
      .where({ userId, provider, openId })
      .forUpdate()
      .first();
    if (!identity) {
      throw new AuthError("第三方登录身份已变化，请重试", 409, {
        code: "OAUTH_IDENTITY_CHANGED",
      });
    }

    const timestamp = Date.now();
    await trx<any>("o_auth_token").insert({
      id: uuid(),
      userId,
      workspaceId: null,
      tokenHash: hashAuthToken(rawExchange),
      type: OAUTH_SESSION_EXCHANGE_TYPE,
      metadata: JSON.stringify({
        browserNonceHash: hashAuthToken(browserNonce),
        provider,
        identityId: String(identity.id),
        identityGeneration: Number(identity.updatedAt || 0),
        primaryFactorHash: primaryFactorHash(identity),
        authGeneration: Number(user.updatedAt || 0),
      }),
      expiresAt: timestamp + OAUTH_EXCHANGE_TTL_MS,
      usedAt: null,
      createdAt: timestamp,
    });
  });
  return rawExchange;
}

export async function consumeOAuthSessionExchange(
  knex: Knex,
  input: {
    rawExchange: string;
    browserBinding: OAuthBrowserBinding | null;
    authInfo?: RequestAuthInfo;
  },
): Promise<Record<string, unknown>> {
  const rawExchange = String(input.rawExchange || "").trim();
  if (!rawExchange) {
    throw authErrorForExchangeCode("OAUTH_EXCHANGE_INVALID");
  }
  const tokenHash = hashAuthToken(rawExchange);
  const snapshot = await knex<any>("o_auth_token")
    .where({
      tokenHash,
      type: OAUTH_SESSION_EXCHANGE_TYPE,
    })
    .select("id", "userId")
    .first();
  const snapshotUserId = Number(snapshot?.userId || 0);
  if (
    !snapshot
    || !Number.isSafeInteger(snapshotUserId)
    || snapshotUserId < 1
  ) {
    throw authErrorForExchangeCode("OAUTH_EXCHANGE_INVALID");
  }

  const authInfo = input.authInfo || {};
  const result = await knex.transaction(async (trx) => {
    // Global OAuth challenge order: user -> account security -> token family
    // -> provider identity. The opaque token is only a locator before these
    // live rows are locked and revalidated.
    const user = await trx<any>("o_user")
      .where({ id: snapshotUserId })
      .forUpdate()
      .first();
    const securityRow = await trx<any>("o_account_security")
      .where({ userId: snapshotUserId })
      .forUpdate()
      .first();
    const row = await trx<any>("o_auth_token")
      .where({
        id: String(snapshot.id),
        tokenHash,
        type: OAUTH_SESSION_EXCHANGE_TYPE,
      })
      .forUpdate()
      .first();
    if (!row || row.usedAt != null || Number(row.userId || 0) !== snapshotUserId) {
      return { errorCode: "OAUTH_EXCHANGE_INVALID" } as const;
    }

    const timestamp = Date.now();
    const metadata = parseMetadata(row.metadata);
    const browserNonce = String(input.browserBinding?.nonce || "").trim();
    const invalidBinding = (
      !browserNonce
      || !secureHashEquals(browserNonce, metadata.browserNonceHash)
    );
    const expired = Number(row.expiresAt || 0) <= timestamp;
    const unavailable = !user || String(user.status || "") !== "active";
    const claimed = await trx<any>("o_auth_token")
      .where({ id: row.id })
      .whereNull("usedAt")
      .update({ usedAt: timestamp });
    if (Number(claimed || 0) !== 1) {
      return { errorCode: "OAUTH_EXCHANGE_INVALID" } as const;
    }
    if (expired) return { errorCode: "OAUTH_EXCHANGE_EXPIRED" } as const;
    if (invalidBinding) {
      return { errorCode: "OAUTH_BROWSER_BINDING_INVALID" } as const;
    }
    if (unavailable) return { errorCode: "ACCOUNT_UNAVAILABLE" } as const;

    const authGeneration = Number(metadata.authGeneration);
    const provider = String(metadata.provider || "");
    const identityId = String(metadata.identityId || "");
    const identityGeneration = Number(metadata.identityGeneration);
    const expectedPrimaryFactorHash = String(metadata.primaryFactorHash || "");
    if (
      !Number.isFinite(authGeneration)
      || authGeneration !== Number(user.updatedAt || 0)
      || !isOAuthProviderId(provider)
      || !identityId
      || !Number.isFinite(identityGeneration)
      || !expectedPrimaryFactorHash
    ) {
      return { errorCode: "OAUTH_PRIMARY_FACTOR_CHANGED" } as const;
    }

    const identity = await trx<any>(USER_OAUTH_IDENTITY_TABLE)
      .where({
        id: identityId,
        userId: snapshotUserId,
        provider,
      })
      .forUpdate()
      .first();
    if (
      !identity
      || Number(identity.updatedAt || 0) !== identityGeneration
      || primaryFactorHash(identity) !== expectedPrimaryFactorHash
    ) {
      return { errorCode: "OAUTH_PRIMARY_FACTOR_CHANGED" } as const;
    }

    const policy = await getAccountSecurityPolicy(trx, snapshotUserId);
    let failureContext: OAuthLoginFailureContext;
    try {
      assertOAuthAccountPolicy(user, policy, authInfo);
      failureContext = await prepareOAuthLoginFailureContext(trx, {
        userId: snapshotUserId,
        identifier: `oauth:${provider}:${identityId}`,
        ip: authInfo.ip,
        attemptedAt: timestamp,
        policy,
      });
    } catch (error) {
      if (error instanceof AuthError) return { authError: error } as const;
      throw error;
    }

    if (securityRow?.mfaEnabled) {
      const challengeFamily = await trx<any>("o_auth_token")
        .where({
          userId: snapshotUserId,
          type: OAUTH_MFA_CHALLENGE_TYPE,
        })
        .orderBy("createdAt", "asc")
        .orderBy("id", "asc")
        .forUpdate()
        .select("*");
      void challengeFamily;
      await trx<any>("o_auth_token")
        .where({
          userId: snapshotUserId,
          type: OAUTH_MFA_CHALLENGE_TYPE,
        })
        .whereNull("usedAt")
        .update({ usedAt: timestamp });
      const challenge = crypto.randomBytes(32).toString("base64url");
      const expiresAt = timestamp + OAUTH_MFA_CHALLENGE_TTL_MS;
      await trx<any>("o_auth_token").insert({
        id: uuid(),
        userId: snapshotUserId,
        workspaceId: user.currentWorkspaceId ?? null,
        tokenHash: hashAuthToken(challenge),
        type: OAUTH_MFA_CHALLENGE_TYPE,
        metadata: JSON.stringify({
          browserNonceHash: hashAuthToken(browserNonce),
          ip: authInfo.ip ?? null,
          provider,
          identityId,
          identityGeneration,
          primaryFactorHash: expectedPrimaryFactorHash,
          authGeneration,
          mfaGeneration: oauthMfaGeneration(securityRow),
        }),
        expiresAt,
        usedAt: null,
        createdAt: timestamp,
      });
      return {
        mfa: {
          challenge,
          expiresAt,
        },
      } as const;
    }

    await clearOAuthLoginFailureFamily(trx, failureContext);
    return {
      session: await createSession(trx, user, authInfo),
    } as const;
  });

  if ("session" in result && result.session) return result.session;
  if ("mfa" in result && result.mfa) {
    throw new AuthError("请输入 MFA 验证码或恢复码完成登录", 401, {
      code: "MFA_REQUIRED",
      data: result.mfa,
    });
  }
  if ("authError" in result && result.authError) throw result.authError;
  throw authErrorForExchangeCode(result.errorCode);
}

export async function completeOAuthMfaSessionExchange(
  knex: Knex,
  input: {
    challenge: string;
    credential: string;
    browserBinding: OAuthBrowserBinding | null;
    authInfo?: RequestAuthInfo;
  },
): Promise<Record<string, unknown>> {
  const challenge = String(input.challenge || "").trim();
  if (!challenge) {
    throw new AuthError("MFA challenge 无效或已使用", 401, {
      code: "MFA_CHALLENGE_INVALID",
    });
  }
  const tokenHash = hashAuthToken(challenge);
  const snapshot = await knex<any>("o_auth_token")
    .where({
      tokenHash,
      type: OAUTH_MFA_CHALLENGE_TYPE,
    })
    .select("id", "userId")
    .first();
  const userId = Number(snapshot?.userId || 0);
  if (!snapshot || !Number.isSafeInteger(userId) || userId < 1) {
    throw new AuthError("MFA challenge 无效或已使用", 401, {
      code: "MFA_CHALLENGE_INVALID",
    });
  }

  const authInfo = input.authInfo || {};
  const outcome = await knex.transaction(async (trx) => {
    const user = await trx<any>("o_user")
      .where({ id: userId })
      .forUpdate()
      .first();
    const securityRow = await trx<any>("o_account_security")
      .where({ userId })
      .forUpdate()
      .first();
    const family = await trx<any>("o_auth_token")
      .where({ userId, type: OAUTH_MFA_CHALLENGE_TYPE })
      .orderBy("createdAt", "asc")
      .orderBy("id", "asc")
      .forUpdate()
      .select("*");
    const current = family.find((row: any) => (
      String(row.id) === String(snapshot.id)
      && String(row.tokenHash) === tokenHash
      && row.usedAt == null
    ));
    if (!current) {
      return {
        authError: new AuthError("MFA challenge 无效或已使用", 401, {
          code: "MFA_CHALLENGE_INVALID",
        }),
      } as const;
    }

    const timestamp = Date.now();
    const consumeFamily = async () => {
      await trx<any>("o_auth_token")
        .where({ userId, type: OAUTH_MFA_CHALLENGE_TYPE })
        .whereNull("usedAt")
        .update({ usedAt: timestamp });
    };
    const metadata = parseMetadata(current.metadata);
    if (Number(current.expiresAt || 0) <= timestamp) {
      await consumeFamily();
      return {
        authError: new AuthError("MFA challenge 已过期", 401, {
          code: "MFA_CHALLENGE_EXPIRED",
        }),
      } as const;
    }
    if (!user || String(user.status || "") !== "active") {
      await consumeFamily();
      return {
        authError: new AuthError("账号不可用", 403, {
          code: "ACCOUNT_UNAVAILABLE",
        }),
      } as const;
    }

    const browserNonce = String(input.browserBinding?.nonce || "").trim();
    const expectedIp = String(metadata.ip || "");
    if (
      !browserNonce
      || !secureHashEquals(browserNonce, metadata.browserNonceHash)
      || (expectedIp && expectedIp !== String(authInfo.ip || ""))
    ) {
      await consumeFamily();
      return {
        authError: new AuthError("MFA challenge 请求上下文不匹配", 401, {
          code: "MFA_CHALLENGE_CONTEXT_MISMATCH",
        }),
      } as const;
    }

    const authGeneration = Number(metadata.authGeneration);
    const expectedMfaGeneration = String(metadata.mfaGeneration || "");
    const provider = String(metadata.provider || "");
    const identityId = String(metadata.identityId || "");
    const identityGeneration = Number(metadata.identityGeneration);
    const expectedPrimaryFactorHash = String(metadata.primaryFactorHash || "");
    if (
      !Number.isFinite(authGeneration)
      || authGeneration !== Number(user.updatedAt || 0)
      || !securityRow?.mfaEnabled
      || expectedMfaGeneration !== oauthMfaGeneration(securityRow)
      || !isOAuthProviderId(provider)
      || !identityId
      || !Number.isFinite(identityGeneration)
      || !expectedPrimaryFactorHash
    ) {
      await consumeFamily();
      return {
        authError: new AuthError("登录凭据状态已变化，请重试", 401, {
          code: "MFA_CHALLENGE_INVALID",
        }),
      } as const;
    }

    const identity = await trx<any>(USER_OAUTH_IDENTITY_TABLE)
      .where({ id: identityId, userId, provider })
      .forUpdate()
      .first();
    if (
      !identity
      || Number(identity.updatedAt || 0) !== identityGeneration
      || primaryFactorHash(identity) !== expectedPrimaryFactorHash
    ) {
      await consumeFamily();
      return {
        authError: new AuthError("第三方登录身份已变化，请重试", 401, {
          code: "OAUTH_PRIMARY_FACTOR_CHANGED",
        }),
      } as const;
    }

    const policy = await getAccountSecurityPolicy(trx, userId);
    let failureContext: OAuthLoginFailureContext;
    try {
      assertOAuthAccountPolicy(user, policy, authInfo);
      failureContext = await prepareOAuthLoginFailureContext(trx, {
        userId,
        identifier: `oauth:${provider}:${identityId}`,
        ip: authInfo.ip,
        attemptedAt: timestamp,
        policy,
      });
    } catch (error) {
      await consumeFamily();
      if (error instanceof AuthError) return { authError: error } as const;
      throw error;
    }

    let verified = false;
    try {
      verified = await verifyOAuthMfaCredential(trx, {
        userId,
        credential: input.credential,
        replayDomain: "oauth-login-session",
      });
    } catch (error) {
      await consumeFamily();
      if (error instanceof AuthError) return { authError: error } as const;
      throw error;
    }
    await consumeFamily();
    if (!verified) {
      try {
        await recordOAuthLoginFailureFamily(trx, failureContext, policy);
      } catch (error) {
        if (error instanceof AuthError) return { authError: error } as const;
        throw error;
      }
      return {
        authError: new AuthError("MFA 验证码或恢复码错误", 401, {
          code: "MFA_CODE_INVALID",
        }),
      } as const;
    }

    await clearOAuthLoginFailureFamily(trx, failureContext);
    return {
      session: await createSession(trx, user, authInfo),
    } as const;
  });

  if ("session" in outcome && outcome.session) return outcome.session;
  throw outcome.authError;
}
