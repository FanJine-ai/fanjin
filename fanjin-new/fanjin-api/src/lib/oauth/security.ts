import crypto from "node:crypto";
import type { Knex } from "knex";
import {
  checkLoginLimit,
  clearLoginFailures,
  effectiveIpLoginLimit,
  effectiveLoginLimit,
  getAccountSecurityPolicy,
  isLoginIpAllowed,
  loginIdentityHash,
  loginIpIdentityHash,
  recordLoginFailure,
  type AccountSecurityPolicy,
} from "@/lib/accountSecurity";
import {
  AuthError,
  isPasswordExpired,
  type RequestAuthInfo,
} from "@/lib/auth";
import {
  MfaError,
  readActiveMfaSecret,
  verifyMfaCredential,
  verifyTotpCode,
} from "@/lib/mfa";

const MFA_RECOVERY_TABLE = "o_account_mfa_recovery_code";

export interface OAuthLoginFailureContext {
  attemptedAt: number;
  userId: number | null;
  identityHash: string;
  ipIdentityHash: string;
  loginLimit: ReturnType<typeof effectiveLoginLimit>;
  ipLoginLimit: ReturnType<typeof effectiveIpLoginLimit>;
}

function loginLockedError(retryAfterSeconds: number): AuthError {
  return new AuthError("登录尝试过多，请稍后重试", 429, {
    code: "LOGIN_LOCKED",
    retryAfterSeconds,
  });
}

function mapMfaError(error: unknown): never {
  if (error instanceof MfaError) {
    throw new AuthError(error.message, error.status, { code: error.code });
  }
  throw error;
}

export function oauthMfaGeneration(row: any): string {
  return `${row?.mfaEnabled ? "enabled" : "disabled"}:${Number(row?.updatedAt || 0)}`;
}

export async function prepareOAuthLoginFailureContext(
  knex: Knex,
  input: {
    userId?: number | null;
    identifier: string;
    ip?: string;
    attemptedAt?: number;
    policy?: AccountSecurityPolicy;
  },
): Promise<OAuthLoginFailureContext> {
  const attemptedAt = input.attemptedAt ?? Date.now();
  const userId = Number(input.userId || 0) || null;
  const policy = input.policy
    || await getAccountSecurityPolicy(knex, Number(userId || 0));
  const context: OAuthLoginFailureContext = {
    attemptedAt,
    userId,
    identityHash: loginIdentityHash(userId, input.identifier),
    ipIdentityHash: loginIpIdentityHash(input.ip || ""),
    loginLimit: effectiveLoginLimit(policy),
    ipLoginLimit: effectiveIpLoginLimit(),
  };
  await assertOAuthLoginLimits(knex, context, policy);
  return context;
}

export async function assertOAuthLoginLimits(
  knex: Knex,
  context: OAuthLoginFailureContext,
  policy?: AccountSecurityPolicy,
): Promise<void> {
  const loginLimit = policy
    ? effectiveLoginLimit(policy)
    : context.loginLimit;
  const account = await checkLoginLimit(
    knex,
    context.identityHash,
    loginLimit,
    context.attemptedAt,
  );
  const ip = await checkLoginLimit(
    knex,
    context.ipIdentityHash,
    context.ipLoginLimit,
    context.attemptedAt,
  );
  const block = account.blocked ? account : ip;
  if (block.blocked) throw loginLockedError(block.retryAfterSeconds);
}

export async function recordOAuthLoginFailureFamily(
  knex: Knex,
  context: OAuthLoginFailureContext,
  policy?: AccountSecurityPolicy,
): Promise<void> {
  const loginLimit = policy
    ? effectiveLoginLimit(policy)
    : context.loginLimit;
  const account = await recordLoginFailure(knex, {
    identityHash: context.identityHash,
    userId: context.userId,
    limit: loginLimit,
    timestamp: context.attemptedAt,
  });
  const ip = await recordLoginFailure(knex, {
    identityHash: context.ipIdentityHash,
    userId: null,
    limit: context.ipLoginLimit,
    timestamp: context.attemptedAt,
  });
  const block = account.blocked ? account : ip;
  if (block.blocked) throw loginLockedError(block.retryAfterSeconds);
}

export async function clearOAuthLoginFailureFamily(
  knex: Knex,
  context: OAuthLoginFailureContext,
): Promise<void> {
  // A successful account authentication clears only that account's bucket.
  // The IP bucket is cross-account abuse evidence and must age out naturally;
  // clearing it here would let one valid account reset attacks on all others.
  await clearLoginFailures(
    knex,
    context.identityHash,
    context.attemptedAt,
  );
}

export function assertOAuthAccountPolicy(
  user: any,
  policy: AccountSecurityPolicy,
  authInfo: RequestAuthInfo,
  input: {
    requireVerifiedEmail?: boolean;
    checkPasswordExpiry?: boolean;
    timestamp?: number;
  } = {},
): void {
  if (input.requireVerifiedEmail && user?.email && !user?.emailVerifiedAt) {
    throw new AuthError("请先完成邮箱验证", 403, {
      code: "EMAIL_NOT_VERIFIED",
      data: { canResendVerification: true },
    });
  }
  if (
    input.checkPasswordExpiry
    && isPasswordExpired(
      user,
      policy.passwordPolicy,
      input.timestamp ?? Date.now(),
    )
  ) {
    throw new AuthError(
      "密码已过期，请通过密码重置流程设置新密码",
      403,
      { code: "PASSWORD_EXPIRED" },
    );
  }
  if (!policy.loginIpAllowlist) return;

  let ipAllowed = false;
  try {
    ipAllowed = isLoginIpAllowed(
      authInfo.ip || "",
      policy.loginIpAllowlist,
    );
  } catch {
    throw new AuthError(
      "账号登录安全策略配置无效，请联系管理员",
      503,
      { code: "LOGIN_POLICY_INVALID" },
    );
  }
  if (!ipAllowed) {
    throw new AuthError(
      "当前网络不允许登录此账号",
      403,
      { code: "LOGIN_IP_NOT_ALLOWED" },
    );
  }
}

function normalizedRecoveryCode(value: string): string {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function recoveryCodeHash(userId: number, code: string): string {
  return crypto
    .createHash("sha256")
    .update(`mfa-recovery:v1:${userId}:${normalizedRecoveryCode(code)}`)
    .digest("hex");
}

/**
 * Side-effect-free MFA check used before OAuth bind takes broad reference
 * table locks. The credential is verified again and consumed atomically in
 * the final transaction; this first pass only keeps bad codes away from the
 * expensive merge lock set.
 */
export async function preverifyOAuthMfaCredential(
  knex: Knex,
  input: { userId: number; credential: string },
): Promise<boolean> {
  const credential = String(input.credential || "").trim();
  try {
    if (/^\d{6}$/.test(credential)) {
      const secret = await readActiveMfaSecret(knex, input.userId);
      return verifyTotpCode(secret, credential);
    }
    const recoveryCode = normalizedRecoveryCode(credential);
    if (!recoveryCode) return false;
    const row = await knex<any>(MFA_RECOVERY_TABLE)
      .where({
        userId: input.userId,
        codeHash: recoveryCodeHash(input.userId, recoveryCode),
      })
      .whereNull("usedAt")
      .first();
    return Boolean(row);
  } catch (error) {
    return mapMfaError(error);
  }
}

export async function verifyOAuthMfaCredential(
  knex: Knex,
  input: {
    userId: number;
    credential: string;
    replayDomain: string;
  },
): Promise<boolean> {
  try {
    const result = await verifyMfaCredential(knex, {
      userId: input.userId,
      credential: input.credential,
      totpReplayDomain: input.replayDomain,
    });
    return result.valid;
  } catch (error) {
    return mapMfaError(error);
  }
}
