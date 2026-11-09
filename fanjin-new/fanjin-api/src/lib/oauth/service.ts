import crypto from "crypto";
import { Knex } from "knex";
import { v4 as uuid } from "uuid";
import {
  AuthError,
  createSession,
  type RequestAuthInfo,
  verifyPassword,
} from "@/lib/auth";
import { getAccountSecurityPolicy } from "@/lib/accountSecurity";
import { writeAuditLog } from "@/lib/audit";
import { insertAndReturnId } from "@/lib/dbDialect";
import {
  isOAuthProviderId,
  providerLabel,
  providerUsernamePrefix,
  type OAuthIdentityRow,
  type OAuthProfile,
  type OAuthProviderId,
} from "@/lib/oauth/types";
import {
  assertOAuthAccountPolicy,
  assertOAuthLoginLimits,
  clearOAuthLoginFailureFamily,
  oauthMfaGeneration,
  prepareOAuthLoginFailureContext,
  preverifyOAuthMfaCredential,
  recordOAuthLoginFailureFamily,
  verifyOAuthMfaCredential,
  type OAuthLoginFailureContext,
} from "@/lib/oauth/security";
import { issueOAuthSessionExchange } from "@/lib/oauth/exchange";
import type { OAuthBrowserBinding } from "@/lib/oauth/state";
import { USER_OAUTH_IDENTITY_TABLE } from "@/lib/migrations/userOauthIdentity";
import { consumeStepUpProof } from "@/lib/stepUpAuth";
import { ensureWorkspaceBillingAccountRecord } from "@/lib/workspaceBillingAccount";

const DEFAULT_WORKSPACE_NAME = "Default Workspace";

function now(): number {
  return Date.now();
}

function slugify(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "workspace";
}

async function uniqueWorkspaceSlug(knex: Knex, baseValue: string): Promise<string> {
  const base = slugify(baseValue);
  let candidate = base;
  let suffix = 0;
  while (await knex<any>("o_workspace").where({ slug: candidate }).first()) {
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }
  return candidate;
}

async function uniqueUsername(knex: Knex, provider: OAuthProviderId, openId: string): Promise<string> {
  const seed = crypto.createHash("sha1").update(`${provider}:${openId}`).digest("hex").slice(0, 8);
  let candidate = `${providerUsernamePrefix(provider)}${seed}`;
  let suffix = 0;
  while (await knex<any>("o_user").where({ name: candidate }).first()) {
    suffix += 1;
    candidate = `${providerUsernamePrefix(provider)}${seed}${suffix}`;
  }
  return candidate;
}

function isUniqueViolation(error: unknown): boolean {
  const code = String((error as { code?: unknown })?.code || "");
  return code === "23505"
    || code === "SQLITE_CONSTRAINT"
    || code === "SQLITE_CONSTRAINT_UNIQUE";
}

async function findIdentity(
  knex: Knex,
  provider: OAuthProviderId,
  openId: string,
): Promise<OAuthIdentityRow | null> {
  const row = await knex<any>(USER_OAUTH_IDENTITY_TABLE).where({ provider, openId }).first();
  return row || null;
}

async function listIdentitiesForUser(knex: Knex, userId: number): Promise<OAuthIdentityRow[]> {
  return knex<any>(USER_OAUTH_IDENTITY_TABLE).where({ userId: Number(userId) }).orderBy("createdAt", "asc");
}

async function createOAuthUser(
  knex: Knex,
  provider: OAuthProviderId,
  profile: OAuthProfile,
): Promise<any> {
  const timestamp = now();
  const username = await uniqueUsername(knex, provider, profile.openId);
  const displayName = String(profile.displayName || username).slice(0, 64);
  const email = profile.email ? String(profile.email).trim().toLowerCase() : null;
  const emailOwner = email
    ? await knex<any>("o_user").whereRaw("lower(email) = ?", [email]).first()
    : null;
  // Never auto-link by email, and never turn an unverified provider claim
  // into a password-recovery address. A recovery email becomes authoritative
  // only after its ownership has been verified.
  const emailToStore = email && profile.emailVerified && !emailOwner
    ? email
    : null;
  // OAuth self-service never mints platform authority. Root creation belongs
  // exclusively to the explicit startup bootstrap.
  const role = "owner";
  const workspaceId = uuid();
  const workspaceName = `${displayName}'s Workspace`;
  const workspaceSlug = await uniqueWorkspaceSlug(knex, workspaceName || username);
  // 无密码（§7.1 允许的两种形态之一）：verifyPassword 对空哈希恒拒绝，
  // 空/随机密码都无法冒充登录；同时让解绑保护能正确识别"无密码"账号（§7.3）。
  // 用户之后可通过找回密码流程设置真实密码。

  let userId = 0;
  await knex.transaction(async (trx) => {
    userId = await insertAndReturnId(trx, "o_user", {
      name: username,
      email: emailToStore,
      displayName,
      password: null,
      passwordChangedAt: null,
      role,
      status: "active",
      emailVerifiedAt: emailToStore && profile.emailVerified ? timestamp : null,
      currentWorkspaceId: workspaceId,
      defaultWorkspaceId: workspaceId,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastLoginAt: null,
    });
    if (!userId) throw new AuthError("用户创建失败", 500);
    await trx<any>("o_workspace").insert({
      id: workspaceId,
      name: workspaceName || DEFAULT_WORKSPACE_NAME,
      slug: workspaceSlug,
      ownerUserId: userId,
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await trx<any>("o_workspace_member").insert({
      id: uuid(),
      workspaceId,
      userId,
      role: "owner",
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await ensureWorkspaceBillingAccountRecord(trx, { workspaceId, timestamp });
    await trx<any>(USER_OAUTH_IDENTITY_TABLE).insert({
      id: uuid(),
      userId,
      provider,
      openId: profile.openId,
      unionId: profile.unionId || null,
      displayName: profile.displayName || null,
      avatarUrl: profile.avatarUrl || null,
      // Provider payloads are not an authority source and can contain tokens,
      // internal flags, or future fields. Persist only the explicit allowlist
      // above; the raw profile column remains null.
      rawProfile: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  });
  return knex<any>("o_user").where({ id: userId }).first();
}

async function touchIdentity(knex: Knex, identityId: string, profile: OAuthProfile): Promise<void> {
  await knex<any>(USER_OAUTH_IDENTITY_TABLE).where({ id: identityId }).update({
    unionId: profile.unionId || null,
    displayName: profile.displayName || null,
    avatarUrl: profile.avatarUrl || null,
    rawProfile: null,
    updatedAt: now(),
  });
}

export async function resolveOAuthUserForLogin(
  knex: Knex,
  input: {
    provider: OAuthProviderId;
    profile: OAuthProfile;
    allowRegistration: boolean;
  },
): Promise<any> {
  if (!isOAuthProviderId(input.provider)) throw new AuthError("不支持的登录方式", 400, { code: "UNSUPPORTED_OAUTH_PROVIDER" });
  const openId = String(input.profile.openId || "").trim();
  if (!openId) throw new AuthError("第三方账号信息不完整", 400, { code: "OAUTH_PROFILE_INVALID" });

  const existing = await findIdentity(knex, input.provider, openId);
  if (existing) {
    return await knex.transaction(async (trx) => {
      // All identity authority changes use user-first ordering. Revalidate the
      // exact identity only after its live owner row is locked, so disable,
      // bind/merge, and login cannot revive or authenticate stale authority.
      const user = await trx<any>("o_user")
        .where({ id: Number(existing.userId) })
        .forUpdate()
        .first();
      const lockedIdentity = await trx<any>(USER_OAUTH_IDENTITY_TABLE)
        .where({
          id: existing.id,
          userId: Number(existing.userId),
          provider: input.provider,
          openId,
        })
        .forUpdate()
        .first();
      if (!lockedIdentity) {
        throw new AuthError("登录身份已变化，请重试", 409, {
          code: "OAUTH_IDENTITY_CHANGED",
        });
      }
      if (!user || user.status !== "active") {
        throw new AuthError("账号不可用", 403, { code: "ACCOUNT_UNAVAILABLE" });
      }
      await touchIdentity(trx, lockedIdentity.id, input.profile);
      return user;
    });
  }

  if (!input.allowRegistration) {
    throw new AuthError("当前暂未开放第三方账号自助注册", 403, {
      code: "OAUTH_REGISTRATION_CLOSED",
    });
  }
  try {
    return await createOAuthUser(knex, input.provider, input.profile);
  } catch (error) {
    // Two callbacks for the same provider identity can both observe "missing".
    // The unique provider/openId constraint makes one transaction roll back
    // completely; the loser then authenticates through the locked live row.
    if (isUniqueViolation(error)) {
      const racedIdentity = await findIdentity(knex, input.provider, openId);
      if (racedIdentity) {
        return await resolveOAuthUserForLogin(knex, input);
      }
    }
    throw error;
  }
}

export async function loginOrRegisterWithOAuth(
  knex: Knex,
  input: {
    provider: OAuthProviderId;
    profile: OAuthProfile;
    allowRegistration: boolean;
    authInfo?: RequestAuthInfo;
    browserBinding?: OAuthBrowserBinding;
  },
): Promise<Record<string, unknown>> {
  if (!input.browserBinding?.nonce) {
    throw new AuthError("第三方登录需要浏览器绑定交换流程", 400, {
      code: "OAUTH_BROWSER_BINDING_INVALID",
    });
  }
  const user = await resolveOAuthUserForLogin(knex, input);
  const exchange = await issueOAuthSessionExchange(knex, {
    userId: Number(user.id),
    provider: input.provider,
    openId: input.profile.openId,
    browserBinding: input.browserBinding,
  });
  return { exchange };
}

export async function listUserOAuthIdentities(knex: Knex, userId: number) {
  const rows = await listIdentitiesForUser(knex, userId);
  return rows.map((row) => ({
    provider: row.provider,
    label: providerLabel(row.provider as OAuthProviderId),
    openId: row.openId,
    displayName: row.displayName || null,
    avatarUrl: row.avatarUrl || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

async function userHasPasswordLogin(user: any): Promise<boolean> {
  return Boolean(user?.password);
}

export async function bindOAuthIdentityToExistingAccount(
  knex: Knex,
  input: {
    currentUserId: number;
    provider: OAuthProviderId;
    username: string;
    password: string;
    mfaCredential?: string;
    authInfo?: RequestAuthInfo;
    auditContext?: Parameters<typeof writeAuditLog>[0];
  },
): Promise<Record<string, unknown>> {
  const provider = input.provider;
  if (!isOAuthProviderId(provider)) throw new AuthError("不支持的登录方式", 400, { code: "UNSUPPORTED_OAUTH_PROVIDER" });
  const currentUserId = Number(input.currentUserId || 0);
  if (!Number.isSafeInteger(currentUserId) || currentUserId < 1) {
    throw new AuthError("未登录", 401);
  }
  const identifier = String(input.username || "").trim();
  if (!identifier) throw new AuthError("请输入已有账号用户名或邮箱", 400);
  const authInfo = input.authInfo || {};
  const attemptedAt = now();
  const targetSnapshot = await knex<any>("o_user")
    .where("name", identifier)
    .orWhereRaw("lower(email) = ?", [identifier.toLowerCase()])
    .select(
      "id",
      "name",
      "email",
      "password",
      "status",
      "emailVerifiedAt",
      "passwordChangedAt",
      "createdAt",
      "updatedAt",
      "currentWorkspaceId",
      "defaultWorkspaceId",
    )
    .first();
  const targetUserId = Number(targetSnapshot?.id || 0);
  // v0.0.7 deliberately has no online cross-user account merge. Reject as
  // soon as the read-only principal lookup proves that the requested target
  // is another user—before policy checks can write failure state and before
  // any transaction, row/table lock, audit, session, token, or asset change.
  if (targetSnapshot && targetUserId !== currentUserId) {
    throw new AuthError(
      "在线账号合并已停用，请联系管理员进行离线核验处理",
      409,
      { code: "OAUTH_ACCOUNT_MERGE_OFFLINE_REQUIRED" },
    );
  }
  const rawSecuritySnapshot = targetUserId
    ? await knex<any>("o_account_security")
      .where({ userId: targetUserId })
      .first()
    : null;
  const targetSecuritySnapshot = await getAccountSecurityPolicy(
    knex,
    Number(targetUserId || 0),
  );
  const confirmedSecuritySnapshot = targetUserId
    ? await knex<any>("o_account_security")
      .where({ userId: targetUserId })
      .first()
    : null;
  if (
    oauthMfaGeneration(rawSecuritySnapshot)
    !== oauthMfaGeneration(confirmedSecuritySnapshot)
  ) {
    throw new AuthError(
      "账号安全状态已变化，请重新验证",
      409,
      { code: "AUTH_CREDENTIAL_CHANGED" },
    );
  }
  const securityGeneration = oauthMfaGeneration(confirmedSecuritySnapshot);
  const failureContext = await prepareOAuthLoginFailureContext(knex, {
    userId: targetUserId || null,
    identifier,
    ip: authInfo.ip,
    attemptedAt,
    policy: targetSecuritySnapshot,
  });
  const rejectInvalidCredentials = async (
    policy = targetSecuritySnapshot,
  ): Promise<never> => {
    await recordOAuthLoginFailureFamily(knex, failureContext, policy);
    throw new AuthError("账号或密码错误", 401, {
      code: "INVALID_CREDENTIALS",
    });
  };
  if (
    !Number.isSafeInteger(targetUserId)
    || targetUserId < 1
    || String(targetSnapshot?.status || "") !== "active"
  ) {
    return await rejectInvalidCredentials();
  }

  // Expensive password and MFA checks deliberately happen without authority
  // locks. Their exact hash/factor generations are checked again after the
  // final transaction acquires only this account's rows.
  if (!(await verifyPassword(
    String(input.password || ""),
    targetSnapshot?.password,
  ))) {
    return await rejectInvalidCredentials();
  }
  assertOAuthAccountPolicy(
    targetSnapshot,
    targetSecuritySnapshot,
    authInfo,
    {
      requireVerifiedEmail: true,
      checkPasswordExpiry: true,
      timestamp: attemptedAt,
    },
  );
  await assertOAuthLoginLimits(
    knex,
    failureContext,
    targetSecuritySnapshot,
  );

  const mfaCredential = String(input.mfaCredential || "").trim();
  if (targetSecuritySnapshot.mfaEnabled) {
    if (!mfaCredential) {
      throw new AuthError(
        "目标账号已启用 MFA，请输入验证码或恢复码",
        401,
        { code: "MFA_REQUIRED" },
      );
    }
    if (!(await preverifyOAuthMfaCredential(knex, {
      userId: targetUserId,
      credential: mfaCredential,
    }))) {
      await recordOAuthLoginFailureFamily(
        knex,
        failureContext,
        targetSecuritySnapshot,
      );
      throw new AuthError("MFA 验证码或恢复码错误", 401, {
        code: "MFA_CODE_INVALID",
      });
    }
  }
  const reauthOutcome = await knex.transaction(async (trx) => {
    const user = await trx<any>("o_user")
      .where({ id: currentUserId })
      .forUpdate()
      .first();
    const principalStillMatches = Boolean(
      user
      && (
        String(user.name || "") === identifier
        || String(user.email || "").toLowerCase() === identifier.toLowerCase()
      )
    );
    if (
      !user
      || String(user.status || "") !== "active"
      || !principalStillMatches
      || String(user.password || "") !== String(targetSnapshot.password || "")
      || Number(user.passwordChangedAt || 0)
        !== Number(targetSnapshot.passwordChangedAt || 0)
      || Number(user.emailVerifiedAt || 0)
        !== Number(targetSnapshot.emailVerifiedAt || 0)
    ) {
      return {
        authError: new AuthError(
          "账号凭据状态已变化，请重新验证",
          409,
          { code: "AUTH_CREDENTIAL_CHANGED" },
        ),
      } as const;
    }

    const liveSecurityRow = await trx<any>("o_account_security")
      .where({ userId: currentUserId })
      .forUpdate()
      .first();
    if (oauthMfaGeneration(liveSecurityRow) !== securityGeneration) {
      return {
        authError: new AuthError(
          "账号安全状态已变化，请重新验证",
          409,
          { code: "AUTH_CREDENTIAL_CHANGED" },
        ),
      } as const;
    }
    const liveSecurity = await getAccountSecurityPolicy(trx, currentUserId);
    try {
      assertOAuthAccountPolicy(user, liveSecurity, authInfo, {
        requireVerifiedEmail: true,
        checkPasswordExpiry: true,
        timestamp: attemptedAt,
      });
      await assertOAuthLoginLimits(trx, failureContext, liveSecurity);
    } catch (error) {
      if (error instanceof AuthError) return { authError: error } as const;
      throw error;
    }

    const identity = await trx<any>(USER_OAUTH_IDENTITY_TABLE)
      .where({ userId: currentUserId, provider })
      .forUpdate()
      .first();
    if (!identity) {
      return {
        authError: new AuthError(
          `当前账号未绑定${providerLabel(provider)}`,
          400,
          { code: "OAUTH_IDENTITY_MISSING" },
        ),
      } as const;
    }

    if (liveSecurity.mfaEnabled) {
      let verified = false;
      try {
        verified = await verifyOAuthMfaCredential(trx, {
          userId: currentUserId,
          credential: mfaCredential,
          replayDomain: "oauth-bind",
        });
      } catch (error) {
        if (error instanceof AuthError) return { authError: error } as const;
        throw error;
      }
      if (!verified) {
        try {
          await recordOAuthLoginFailureFamily(
            trx,
            failureContext,
            liveSecurity,
          );
        } catch (error) {
          if (error instanceof AuthError) return { authError: error } as const;
          throw error;
        }
        return {
          authError: new AuthError(
            "MFA 验证码或恢复码错误",
            401,
            { code: "MFA_CODE_INVALID" },
          ),
        } as const;
      }
    }

    const session = await createSession(trx, user, authInfo);
    await writeAuditLog(input.auditContext, {
      workspaceId: user.currentWorkspaceId || user.defaultWorkspaceId || null,
      action: "auth.oauth.reauthenticate",
      resourceType: "oauth_identity",
      resourceId: identity.id,
      metadata: {
        provider,
        userId: currentUserId,
      },
      required: true,
    }, trx);
    await clearOAuthLoginFailureFamily(trx, failureContext);
    return { session } as const;
  });
  if ("authError" in reauthOutcome && reauthOutcome.authError) {
    throw reauthOutcome.authError;
  }
  return reauthOutcome.session;

}

export async function unbindOAuthIdentity(
  knex: Knex,
  input: {
    userId: number;
    sessionId: string;
    proof: string;
    provider: OAuthProviderId;
    auditContext?: Parameters<typeof writeAuditLog>[0];
  },
): Promise<void> {
  if (!isOAuthProviderId(input.provider)) throw new AuthError("不支持的登录方式", 400, { code: "UNSUPPORTED_OAUTH_PROVIDER" });
  const userId = Number(input.userId);
  await knex.transaction(async (trx) => {
    // consumeStepUpProof locks and revalidates the live user, exact session,
    // security generation, and single-use proof in the global user-first
    // order. Its write is committed only with the delete and required audit.
    await consumeStepUpProof(trx, {
      proof: input.proof,
      userId,
      sessionId: input.sessionId,
      scope: "account.oauth.unbind",
    });
    const user = await trx<any>("o_user").where({ id: userId }).first();

    const identities = await trx<any>(USER_OAUTH_IDENTITY_TABLE)
      .where({ userId })
      .orderBy("id", "asc")
      .forUpdate();
    const target = identities.find((row: OAuthIdentityRow) => row.provider === input.provider);
    if (!target) throw new AuthError("未绑定该登录方式", 404, { code: "OAUTH_IDENTITY_MISSING" });

    const hasPassword = await userHasPasswordLogin(user);
    const remaining = identities.filter((row: OAuthIdentityRow) => row.provider !== input.provider);
    if (!hasPassword && remaining.length === 0) {
      throw new AuthError("请先设置密码或绑定其他登录方式后再解绑", 400, { code: "OAUTH_LAST_LOGIN_METHOD" });
    }

    await trx<any>(USER_OAUTH_IDENTITY_TABLE).where({ id: target.id }).del();
    await writeAuditLog(input.auditContext, {
      workspaceId: user.currentWorkspaceId || user.defaultWorkspaceId || null,
      action: "auth.oauth.unbind",
      resourceType: "oauth_identity",
      resourceId: target.id,
      metadata: {
        provider: input.provider,
        sessionId: input.sessionId,
      },
      required: true,
    }, trx);
  });
}
