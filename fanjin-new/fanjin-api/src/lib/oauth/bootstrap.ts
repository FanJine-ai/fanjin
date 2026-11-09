import crypto from "node:crypto";
import type { Knex } from "knex";
import { v4 as uuid } from "uuid";
import {
  AuthError,
  hashAuthToken,
  updatePasswordWithHistory,
} from "@/lib/auth";
import {
  getAccountSecurityPolicy,
  type SessionPolicy,
  validatePasswordAgainstPolicy,
} from "@/lib/accountSecurity";
import { writeAuditLog } from "@/lib/audit";
import { USER_OAUTH_IDENTITY_TABLE } from "@/lib/migrations/userOauthIdentity";
import type {
  OAuthBootstrapStateBinding,
  OAuthBrowserBinding,
} from "@/lib/oauth/state";
import type { OAuthProviderId } from "@/lib/oauth/types";

const OAUTH_BOOTSTRAP_PROOF_TYPE = "oauth_primary_bootstrap_proof";
const OAUTH_BOOTSTRAP_SCOPE = "account.password.bootstrap";
export const OAUTH_BOOTSTRAP_PROOF_TTL_MS = 5 * 60 * 1000;

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
  return actual.length === expected.length
    && crypto.timingSafeEqual(actual, expected);
}

function identityFactorHash(input: {
  id: unknown;
  provider: unknown;
  openId: unknown;
}): string {
  return hashAuthToken([
    "oauth-bootstrap-primary:v1",
    String(input.id || ""),
    String(input.provider || ""),
    String(input.openId || ""),
  ].join("\0"));
}

function isLiveBootstrapSession(
  session: any,
  policy: SessionPolicy,
  timestamp: number,
): boolean {
  if (!session || session.revokedAt != null) return false;
  const createdAt = Number(session.createdAt || 0);
  const lastSeenAt = Number(session.lastSeenAt || createdAt);
  const configuredAbsoluteExpiry = createdAt
    + policy.absoluteHours * 60 * 60 * 1000;
  const storedExpiry = Number(session.expiresAt || configuredAbsoluteExpiry);
  const absoluteExpiry = Math.min(storedExpiry, configuredAbsoluteExpiry);
  const idleExpiry = lastSeenAt + policy.idleMinutes * 60 * 1000;
  return Boolean(
    createdAt > 0
    && absoluteExpiry > timestamp
    && idleExpiry > timestamp
  );
}

async function lockProofFamily(
  trx: Knex.Transaction,
  userId: number,
): Promise<any[]> {
  return await trx<any>("o_auth_token")
    .where({ userId, type: OAUTH_BOOTSTRAP_PROOF_TYPE })
    .orderBy("createdAt", "asc")
    .orderBy("id", "asc")
    .forUpdate()
    .select("*");
}

async function consumeUnusedProofFamily(
  trx: Knex.Transaction,
  userId: number,
  timestamp: number,
): Promise<void> {
  await trx<any>("o_auth_token")
    .where({ userId, type: OAUTH_BOOTSTRAP_PROOF_TYPE })
    .whereNull("usedAt")
    .update({ usedAt: timestamp });
}

export async function issueOAuthPrimaryBootstrapProof(
  knex: Knex,
  input: {
    state: OAuthBootstrapStateBinding;
    provider: OAuthProviderId;
    profileOpenId: string;
    browserBinding: OAuthBrowserBinding | null;
  },
): Promise<{ proof: string; expiresAt: number; provider: OAuthProviderId }> {
  const browserNonce = String(input.browserBinding?.nonce || "").trim();
  const profileOpenId = String(input.profileOpenId || "").trim();
  if (!browserNonce) {
    throw new AuthError("登录浏览器校验失败，请重试", 400, {
      code: "OAUTH_BROWSER_BINDING_INVALID",
    });
  }
  if (
    input.state.scope !== OAUTH_BOOTSTRAP_SCOPE
    || input.state.userId < 1
    || !input.state.sessionId
    || !input.state.identityId
    || !profileOpenId
    || profileOpenId !== input.state.openId
  ) {
    throw new AuthError("第三方安全验证与当前账号不匹配", 403, {
      code: "OAUTH_BOOTSTRAP_CONTEXT_MISMATCH",
    });
  }

  const proof = crypto.randomBytes(32).toString("base64url");
  const result = await knex.transaction(async (trx) => {
    const user = await trx<any>("o_user")
      .where({ id: input.state.userId })
      .forUpdate()
      .first();
    const session = await trx<any>("o_user_session")
      .where({
        id: input.state.sessionId,
        userId: input.state.userId,
      })
      .whereNull("revokedAt")
      .forUpdate()
      .first();
    const security = await getAccountSecurityPolicy(trx, input.state.userId);
    const timestamp = Date.now();
    if (
      !user
      || String(user.status || "") !== "active"
      || !isLiveBootstrapSession(
        session,
        security.sessionPolicy,
        timestamp,
      )
      || Number(input.state.authGeneration)
        !== Number(user.updatedAt || 0)
    ) {
      throw new AuthError("当前登录会话无效", 401, {
        code: "OAUTH_BOOTSTRAP_CONTEXT_MISMATCH",
      });
    }
    if (user.password) {
      throw new AuthError("当前账号已设置密码", 409, {
        code: "OAUTH_BOOTSTRAP_NOT_AVAILABLE",
      });
    }
    const identity = await trx<any>(USER_OAUTH_IDENTITY_TABLE)
      .where({
        id: input.state.identityId,
        userId: input.state.userId,
        provider: input.provider,
        openId: profileOpenId,
      })
      .forUpdate()
      .first();
    if (
      !identity
      || Number(identity.updatedAt || 0)
        !== Number(input.state.identityGeneration || 0)
    ) {
      throw new AuthError("第三方登录身份已变化，请重试", 409, {
        code: "OAUTH_IDENTITY_CHANGED",
      });
    }

    await lockProofFamily(trx, input.state.userId);
    const expiresAt = timestamp + OAUTH_BOOTSTRAP_PROOF_TTL_MS;
    await consumeUnusedProofFamily(trx, input.state.userId, timestamp);
    await trx<any>("o_auth_token").insert({
      id: uuid(),
      userId: input.state.userId,
      workspaceId: session.workspaceId ?? null,
      tokenHash: hashAuthToken(proof),
      type: OAUTH_BOOTSTRAP_PROOF_TYPE,
      metadata: JSON.stringify({
        scope: OAUTH_BOOTSTRAP_SCOPE,
        sessionId: input.state.sessionId,
        provider: input.provider,
        identityId: identity.id,
        identityGeneration: Number(identity.updatedAt || 0),
        primaryFactorHash: identityFactorHash(identity),
        authGeneration: Number(user.updatedAt || 0),
        browserNonceHash: hashAuthToken(browserNonce),
      }),
      expiresAt,
      usedAt: null,
      createdAt: timestamp,
    });
    return { expiresAt };
  });
  return {
    proof,
    expiresAt: result.expiresAt,
    provider: input.provider,
  };
}

export async function completeOAuthPasswordBootstrap(
  knex: Knex,
  input: {
    proof: string;
    password: string;
    userId: number;
    sessionId: string;
    browserBinding: OAuthBrowserBinding | null;
    auditContext?: Parameters<typeof writeAuditLog>[0];
  },
): Promise<{ passwordSet: true }> {
  const proof = String(input.proof || "").trim();
  const browserNonce = String(input.browserBinding?.nonce || "").trim();
  if (!proof) {
    throw new AuthError("第三方安全验证无效或已使用", 401, {
      code: "OAUTH_BOOTSTRAP_INVALID",
    });
  }

  const candidate = await knex<any>("o_auth_token")
    .where({
      userId: input.userId,
      tokenHash: hashAuthToken(proof),
      type: OAUTH_BOOTSTRAP_PROOF_TYPE,
    })
    .whereNull("usedAt")
    .first();
  if (!candidate) {
    throw new AuthError("第三方安全验证无效或已使用", 401, {
      code: "OAUTH_BOOTSTRAP_INVALID",
    });
  }

  const outcome = await knex.transaction(async (trx) => {
    const user = await trx<any>("o_user")
      .where({ id: input.userId })
      .forUpdate()
      .first();
    const session = await trx<any>("o_user_session")
      .where({ id: input.sessionId, userId: input.userId })
      .whereNull("revokedAt")
      .forUpdate()
      .first();
    await trx<any>("o_account_security")
      .where({ userId: input.userId })
      .forUpdate()
      .first();
    const security = await getAccountSecurityPolicy(trx, input.userId);
    const family = await lockProofFamily(trx, input.userId);
    const current = family.find((row: any) => (
      String(row.id) === String(candidate.id)
      && String(row.tokenHash) === hashAuthToken(proof)
      && row.usedAt === null
    ));
    if (!current) {
      return {
        authError: new AuthError(
          "第三方安全验证无效或已使用",
          401,
          { code: "OAUTH_BOOTSTRAP_INVALID" },
        ),
      } as const;
    }
    const timestamp = Date.now();
    const burn = async () => {
      await consumeUnusedProofFamily(trx, input.userId, timestamp);
    };
    if (Number(current.expiresAt || 0) <= timestamp) {
      await burn();
      return {
        authError: new AuthError(
          "第三方安全验证已过期，请重试",
          401,
          { code: "OAUTH_BOOTSTRAP_EXPIRED" },
        ),
      } as const;
    }
    const metadata = parseMetadata(current.metadata);
    const identity = await trx<any>(USER_OAUTH_IDENTITY_TABLE)
      .where({
        id: String(metadata.identityId || ""),
        userId: input.userId,
        provider: String(metadata.provider || ""),
      })
      .forUpdate()
      .first();
    const contextMatches = Boolean(
      user
      && String(user.status || "") === "active"
      && session
      && String(metadata.scope || "") === OAUTH_BOOTSTRAP_SCOPE
      && String(metadata.sessionId || "") === input.sessionId
      && String(current.workspaceId || "") === String(session.workspaceId || "")
      && isLiveBootstrapSession(
        session,
        security.sessionPolicy,
        timestamp,
      )
      && browserNonce
      && secureHashEquals(browserNonce, metadata.browserNonceHash)
      && Number(metadata.authGeneration) === Number(user.updatedAt || 0)
      && identity
      && Number(identity.updatedAt || 0)
        === Number(metadata.identityGeneration || 0)
      && String(metadata.primaryFactorHash || "")
        === identityFactorHash(identity)
    );
    if (!contextMatches) {
      await burn();
      return {
        authError: new AuthError(
          "第三方安全验证与当前会话不匹配",
          403,
          { code: "OAUTH_BOOTSTRAP_CONTEXT_MISMATCH" },
        ),
      } as const;
    }
    if (user.password) {
      await burn();
      return {
        authError: new AuthError(
          "当前账号已设置密码",
          409,
          { code: "OAUTH_BOOTSTRAP_NOT_AVAILABLE" },
        ),
      } as const;
    }

    const passwordError = validatePasswordAgainstPolicy(
      input.password,
      security.passwordPolicy,
    );
    if (passwordError) {
      return {
        authError: new AuthError(passwordError, 400, {
          code: "OAUTH_BOOTSTRAP_PASSWORD_INVALID",
        }),
      } as const;
    }
    await burn();
    await updatePasswordWithHistory(trx, {
      userId: input.userId,
      password: input.password,
      policy: security.passwordPolicy,
      timestamp,
    });
    // Preserve only the exact live session that was bound into the fresh
    // OAuth proof; every other session loses authority on first-password set.
    await trx<any>("o_user_session")
      .where({ userId: input.userId })
      .whereNot({ id: input.sessionId })
      .whereNull("revokedAt")
      .update({ revokedAt: timestamp, updatedAt: timestamp });
    await writeAuditLog(input.auditContext, {
      workspaceId: session.workspaceId ?? null,
      action: "auth.oauth.password_bootstrap",
      resourceType: "account",
      resourceId: input.userId,
      metadata: {
        provider: String(metadata.provider || ""),
        identityId: String(identity.id),
        sessionId: input.sessionId,
        recoveryEmailChanged: false,
      },
      required: true,
    }, trx);
    return { completed: true } as const;
  });

  if ("authError" in outcome && outcome.authError) {
    throw outcome.authError;
  }
  return { passwordSet: true };
}
