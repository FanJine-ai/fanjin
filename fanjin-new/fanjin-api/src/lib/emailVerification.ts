import type { Knex } from "knex";
import { AuthError } from "@/lib/authErrors";
import { isMailConfigured, sendMail } from "@/lib/mailer/smtpMailer";
import { buildEmailVerificationMessage, resolveMailLogoUrl } from "@/lib/mailer/templates";
import { resolvePasswordResetPublicBaseUrl } from "@/lib/passwordResetConfig";
import {
  authHandoffSeedHash,
  consumeAuthHandoffClaim,
  createAuthHandoffIssue,
} from "@/lib/authHandoff";

export const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
export const VERIFY_EMAIL_TOKEN_TYPE = "verify_email";
const VERIFY_EMAIL_CLAIM_TYPE = "verify_email_browser_claim";

function now(): number {
  return Date.now();
}

function normalizeEmail(email: string): string {
  return String(email || "").trim().toLowerCase();
}

function nextMonotonicTimestamp(current: unknown, timestamp = now()): number {
  const previous = Number(current || 0);
  return Math.max(timestamp, Number.isFinite(previous) ? previous + 1 : timestamp);
}

async function lockEmailTokenFamily(trx: Knex.Transaction, userId: number): Promise<any[]> {
  return await trx<any>("o_auth_token")
    .where({ userId })
    .whereIn("type", [VERIFY_EMAIL_TOKEN_TYPE, VERIFY_EMAIL_CLAIM_TYPE])
    .orderBy("createdAt", "asc")
    .orderBy("id", "asc")
    .forUpdate()
    .select("*");
}

async function markUnusedEmailTokenFamilyUsed(
  trx: Knex.Transaction,
  userId: number,
  timestamp: number,
): Promise<void> {
  await trx<any>("o_auth_token")
    .where({ userId })
    .whereIn("type", [VERIFY_EMAIL_TOKEN_TYPE, VERIFY_EMAIL_CLAIM_TYPE])
    .whereNull("usedAt")
    .update({ usedAt: timestamp });
}

export function buildEmailVerifyUrl(locator: string): string {
  const base = resolvePasswordResetPublicBaseUrl();
  if (!base) throw new Error("PUBLIC_BASE_URL_MISSING");
  return `${base}/index.html?handoff=${encodeURIComponent(locator)}#/auth/verify-email`;
}

export async function sendEmailVerificationMail(input: {
  email: string;
  verifyUrl: string;
  code: string;
}): Promise<void> {
  const publicBaseUrl = resolvePasswordResetPublicBaseUrl();
  const msg = buildEmailVerificationMessage({
    to: input.email,
    verifyUrl: input.verifyUrl,
    verificationCode: input.code,
    logoUrl: resolveMailLogoUrl(publicBaseUrl),
    brandName: "繁境 Fanjin",
  });
  await sendMail({
    to: input.email,
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
  });
}

export async function issueEmailVerification(
  knex: Knex,
  user: { id: number; email: string; name?: string; handoffSeed?: string | null },
): Promise<{
  locator: string;
  code: string;
  /** Internal compatibility alias for older test helpers; never put in a URL or response. */
  rawToken: string;
  expiresAt: number;
  verifyUrl: string;
}> {
  const email = normalizeEmail(user.email);
  if (!email) throw new AuthError("邮箱不能为空", 400, { code: "EMAIL_REQUIRED" });

  const publicBaseUrl = resolvePasswordResetPublicBaseUrl();
  if (!publicBaseUrl) throw new Error("PUBLIC_BASE_URL_MISSING");
  const handoff = createAuthHandoffIssue({
    flow: "verify_email",
    publicBaseUrl,
    seed: user.handoffSeed,
  });
  const issued = await knex.transaction(async (trx) => {
    // Global auth lock order: user first, then the user's token family.
    const lockedUser = await trx<any>("o_user")
      .where({ id: Number(user.id) })
      .forUpdate()
      .first();
    if (
      !lockedUser
      || String(lockedUser.status || "") !== "active"
      || Boolean(lockedUser.emailVerifiedAt)
      || normalizeEmail(lockedUser.email) !== email
    ) {
      throw new AuthError("邮箱验证当前不可用", 409, {
        code: "EMAIL_VERIFICATION_NOT_AVAILABLE",
      });
    }

    await lockEmailTokenFamily(trx, Number(lockedUser.id));
    const issuedAt = now();
    const emailVersion = nextMonotonicTimestamp(lockedUser.updatedAt, issuedAt);
    // Expiry is based on fresh wall-clock time under the lock. A corrupt or
    // future generation value must not lengthen the credential lifetime.
    const expiresAt = issuedAt + EMAIL_VERIFICATION_TTL_MS;
    await markUnusedEmailTokenFamilyUsed(trx, Number(lockedUser.id), issuedAt);

    const userGenerationQuery = trx<any>("o_user")
      .where({ id: Number(lockedUser.id), status: "active" });
    if (lockedUser.updatedAt === null || lockedUser.updatedAt === undefined) {
      userGenerationQuery.whereNull("updatedAt");
    } else {
      userGenerationQuery.where("updatedAt", lockedUser.updatedAt);
    }
    const generationUpdated = await userGenerationQuery.update({ updatedAt: emailVersion });
    if (Number(generationUpdated || 0) !== 1) {
      throw new AuthError("邮箱验证状态已变化，请重试", 409, {
        code: "EMAIL_VERIFICATION_CONFLICT",
      });
    }

    await trx<any>("o_auth_token").insert({
      id: handoff.locator,
      userId: Number(lockedUser.id),
      workspaceId: null,
      tokenHash: handoff.codeMac,
      type: VERIFY_EMAIL_TOKEN_TYPE,
      metadata: JSON.stringify({
        email,
        emailVersion,
        handoffVersion: 2,
        seedHash: user.handoffSeed ? authHandoffSeedHash(user.handoffSeed) : null,
        failedAttempts: 0,
      }),
      expiresAt,
      usedAt: null,
      createdAt: issuedAt,
    });
    return { expiresAt };
  });

  return {
    locator: handoff.locator,
    code: handoff.code,
    rawToken: handoff.code,
    expiresAt: issued.expiresAt,
    verifyUrl: handoff.url,
  };
}

export async function verifyEmailWithToken(
  _knex: Knex,
  _rawTokenInput: string,
): Promise<{ email: string; verified: true; userId: number; alreadyVerified: boolean }> {
  throw new AuthError("旧版邮件链接已停用，请重新申请", 410, {
    code: "AUTH_LINK_LEGACY_GONE",
  });
}

export async function completeEmailVerificationHandoff(
  knex: Knex,
  claim: string,
): Promise<{ email: string; verified: true; userId: number; alreadyVerified: boolean }> {
  return await consumeAuthHandoffClaim(knex, {
    flow: "verify_email",
    claim,
    async consume(trx, user, metadata, timestamp) {
      const email = normalizeEmail(String(user.email || ""));
      const metaEmail = normalizeEmail(String(metadata.email || ""));
      const metaVersion = Number(metadata.emailVersion);
      if (
        !email
        || email !== metaEmail
        || !Number.isFinite(metaVersion)
        || metaVersion !== Number(user.updatedAt)
      ) {
        throw new AuthError("验证链接与当前邮箱不匹配", 400, {
          code: "AUTH_HANDOFF_INVALID",
        });
      }
      const userId = Number(user.id);
      const alreadyVerified = Boolean(user.emailVerifiedAt);
      if (!alreadyVerified) {
        const verifiedAt = nextMonotonicTimestamp(user.updatedAt, timestamp);
        const updated = await trx<any>("o_user")
          .where({ id: userId, status: "active", updatedAt: user.updatedAt })
          .update({ emailVerifiedAt: verifiedAt, updatedAt: verifiedAt });
        if (Number(updated || 0) !== 1) {
          throw new AuthError("邮箱验证状态已变化，请重试", 409, {
            code: "EMAIL_VERIFICATION_CONFLICT",
          });
        }
      }
      return { email, verified: true, userId, alreadyVerified };
    },
  });
}

export async function deleteUnverifiedRegistration(knex: Knex, userId: number): Promise<void> {
  const id = Number(userId);
  if (!id) return;

  await knex.transaction(async (trx) => {
    // Keep the global auth lock order (user -> token family) and re-check the
    // authoritative verification state under the lock. A verification that
    // commits first must make this cleanup a no-op; a verification that starts
    // later must wait and observe that the registration no longer exists.
    const user = await trx<any>("o_user")
      .where({ id })
      .forUpdate()
      .first();
    if (!user || user.emailVerifiedAt || String(user.status || "") !== "active") return;

    await trx<any>("o_auth_token").where({ userId: id }).del();
    await trx<any>("o_workspace_member").where({ userId: id }).del();
    const workspaces = await trx<any>("o_workspace").where({ ownerUserId: id });
    for (const ws of workspaces) {
      await trx<any>("o_workspace_member").where({ workspaceId: ws.id }).del();
      await trx<any>("o_billing_account").where({ workspaceId: ws.id }).del();
      await trx<any>("o_workspace").where({ id: ws.id }).del();
    }
    await trx<any>("o_user").where({ id }).del();
  });
}

export async function resendEmailVerification(
  knex: Knex,
  emailInput: string,
  meta: { ip?: string; handoffSeed?: string | null } = {},
): Promise<void> {
  const email = normalizeEmail(emailInput);
  if (!email) throw new AuthError("请输入邮箱", 400, { code: "EMAIL_REQUIRED" });
  if (!(await isMailConfigured())) {
    throw new AuthError("邮件服务未配置，请联系管理员", 503, { code: "MAIL_NOT_CONFIGURED" });
  }

  const user = await knex<any>("o_user").whereRaw("lower(email) = ?", [email]).first();
  // Anti-enumeration: missing or already verified → silent success at route layer
  if (!user || user.emailVerifiedAt || String(user.status || "") !== "active") return;

  let issued: Awaited<ReturnType<typeof issueEmailVerification>>;
  try {
    issued = await issueEmailVerification(knex, {
      id: Number(user.id),
      email,
      name: user.name,
      handoffSeed: meta.handoffSeed,
    });
  } catch (error) {
    // Preserve anti-enumeration and guarantee that a disable/verify race does
    // not reveal or mutate the account.
    if (
      error instanceof AuthError
      && ["EMAIL_VERIFICATION_NOT_AVAILABLE", "EMAIL_VERIFICATION_CONFLICT"].includes(
        String(error.code || ""),
      )
    ) {
      return;
    }
    throw error;
  }
  try {
    await sendEmailVerificationMail({
      email,
      verifyUrl: issued.verifyUrl,
      code: issued.code,
    });
  } catch {
    await knex.transaction(async (trx) => {
      await trx<any>("o_user").where({ id: Number(user.id) }).forUpdate().first();
      await lockEmailTokenFamily(trx, Number(user.id));
      await trx<any>("o_auth_token")
        .where({
          userId: Number(user.id),
          type: VERIFY_EMAIL_TOKEN_TYPE,
          id: issued.locator,
        })
        .whereNull("usedAt")
        .update({ usedAt: now() });
    });
    throw new AuthError("验证邮件发送失败，请稍后重试", 502, { code: "MAIL_DELIVERY_FAILED" });
  }
}
