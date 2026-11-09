import express from "express";
import { z } from "zod";
import { getAccountProfile } from "@/lib/accountProfile";
import { success, error } from "@/lib/responseFormat";
import { writeAuditLog } from "@/lib/audit";
import { AuthError, updatePasswordWithHistory, verifyPassword } from "@/lib/auth";
import { getAccountSecurityPolicy, validatePasswordAgainstPolicy } from "@/lib/accountSecurity";
import { issueEmailVerification, sendEmailVerificationMail } from "@/lib/emailVerification";
import { isMailConfigured } from "@/lib/mailer/smtpMailer";
import { db } from "@/utils/db";
import { consumeStepUpProof, StepUpError } from "@/lib/stepUpAuth";
import { ensureAuthHandoffSeed } from "@/lib/authHandoff";

const router = express.Router();

const bodySchema = z.object({
  displayName: z.string().trim().min(2).max(64).optional(),
  email: z.string().trim().email().optional().nullable(),
  currentPassword: z.string().max(128).optional().or(z.literal("")),
  password: z.string().min(8).max(128).optional().or(z.literal("")),
}).strict();

function currentUserId(req: express.Request): number {
  return Number(((req as any).auth?.user || (req as any).user || {}).id || 0);
}

function stepUpProof(req: express.Request): string {
  const value = req.headers["x-fanjin-step-up"];
  return String(Array.isArray(value) ? value[0] || "" : value || "").trim();
}

async function sendProfile(req: express.Request, res: express.Response) {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).send(error("未登录"));
  const profile = await getAccountProfile({
    userId,
    workspaceId: (req as any).auth?.workspaceId,
  });
  if (!profile) return res.status(404).send(error("账号不存在"));
  return res.status(200).send(success(profile));
}

router.get("/", sendProfile);

router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });

  const userId = currentUserId(req);
  if (!userId) return res.status(401).send(error("未登录"));
  const sensitiveFieldsChanged = parsed.data.email !== undefined || Boolean(parsed.data.password);
  const requestedEmail = parsed.data.email === undefined
    ? undefined
    : String(parsed.data.email || "").trim().toLowerCase() || null;
  const handoffSeed = requestedEmail ? ensureAuthHandoffSeed(req, res) : null;
  // Resolve mail readiness before opening the identity transaction. The
  // default SMTP resolver reads platform settings through the shared DB and
  // must not wait for a second SQLite connection while this request holds one.
  const mailReady = requestedEmail ? await isMailConfigured() : true;

  let stepUpVerified = false;
  let verificationMail: {
    email: string;
    verifyUrl: string;
    code: string;
    userId: number;
  } | null = null;
  try {
    verificationMail = await (db as any).transaction(async (trx: any) => {
      // Global auth lock order: user -> security -> session/proof -> token
      // families. Sensitive profile changes always require step-up.
      const currentUser = await trx("o_user").where({ id: userId }).forUpdate().first();
      if (!currentUser || String(currentUser.status || "") !== "active") {
        throw new AuthError("账号不可用", 403, { code: "ACCOUNT_UNAVAILABLE" });
      }
      const transactionSecurityRow = await trx("o_account_security")
        .where({ userId })
        .forUpdate()
        .first();
      if (sensitiveFieldsChanged) {
        await consumeStepUpProof(trx, {
          proof: stepUpProof(req),
          userId,
          sessionId: String((req as any).auth?.session?.id || ""),
          scope: "account.profile.sensitive",
        });
        stepUpVerified = true;
      }

      const transactionSecurity = await getAccountSecurityPolicy(trx, userId);
      if (parsed.data.password) {
        const passwordOk = await verifyPassword(
          parsed.data.currentPassword || "",
          String(currentUser.password || ""),
        );
        if (!passwordOk) {
          throw new AuthError("旧密码不正确", 400, { code: "CURRENT_PASSWORD_INVALID" });
        }
        const passwordError = validatePasswordAgainstPolicy(
          parsed.data.password,
          transactionSecurity.passwordPolicy,
        );
        if (passwordError) throw new AuthError(passwordError);
      }

      const normalizedEmail = requestedEmail;
      const currentEmail = String(currentUser.email || "").trim().toLowerCase() || null;
      const emailChanged = normalizedEmail !== undefined && normalizedEmail !== currentEmail;
      if (emailChanged && normalizedEmail && !mailReady) {
        throw new AuthError("邮件服务未配置，请联系管理员", 503, {
          code: "MAIL_NOT_CONFIGURED",
        });
      }
      if (emailChanged && normalizedEmail) {
        const emailOwner = await trx("o_user")
          .whereNot({ id: userId })
          .whereRaw("lower(email) = ?", [normalizedEmail])
          .select("id")
          .first();
        if (emailOwner) {
          throw new AuthError("邮箱已被其他账号使用", 409, {
            code: "EMAIL_IN_USE",
          });
        }
      }

      const timestamp = Math.max(Date.now(), Number(currentUser.updatedAt || 0) + 1);
      const patch: Record<string, unknown> = { updatedAt: timestamp };
      if (parsed.data.displayName !== undefined) {
        patch.displayName = parsed.data.displayName;
      }
      if (emailChanged) {
        patch.email = normalizedEmail;
        patch.emailVerifiedAt = null;
        await trx("o_auth_token")
          .where({ userId, type: "verify_email" })
          .whereNull("usedAt")
          .update({ usedAt: timestamp });
      }
      const updated = await trx("o_user")
        .where({ id: userId, status: "active", updatedAt: currentUser.updatedAt })
        .update(patch);
      if (Number(updated || 0) !== 1) {
        throw new AuthError("账号资料已被其他请求修改，请重试", 409, {
          code: "ACCOUNT_PROFILE_CONFLICT",
        });
      }

      if (parsed.data.password) {
        await updatePasswordWithHistory(trx, {
          userId,
          password: parsed.data.password!,
          policy: transactionSecurity.passwordPolicy,
        });
        const currentSessionId = String((req as any).auth?.session?.id || "");
        const sessions = trx("o_user_session")
          .where({ userId })
          .whereNull("revokedAt");
        if (currentSessionId) sessions.whereNot("id", currentSessionId);
        await sessions.update({ revokedAt: timestamp, updatedAt: timestamp });
      }

      if (emailChanged && normalizedEmail) {
        const issued = await issueEmailVerification(trx, {
          id: userId,
          email: normalizedEmail,
          name: parsed.data.displayName || currentUser.name,
          handoffSeed,
        });
        verificationMail = {
          email: normalizedEmail,
          verifyUrl: issued.verifyUrl,
          code: issued.code,
          userId,
        };
      }

      await writeAuditLog(req, {
        action: "account.profile.update",
        resourceType: "account",
        resourceId: userId,
        required: true,
        metadata: {
          changedFields: [
            ...(parsed.data.displayName !== undefined ? ["displayName"] : []),
            ...(emailChanged ? ["email", "emailVerifiedAt"] : []),
          ],
          passwordChanged: Boolean(parsed.data.password),
          stepUpVerified,
          emailVerificationRequired: Boolean(emailChanged && normalizedEmail),
        },
      }, trx);
      return verificationMail;
    });
  } catch (err) {
    if (err instanceof StepUpError) return res.status(err.status).send(error(err.message, { code: err.code }));
    if (err instanceof AuthError) return res.status(err.status).send(error(err.message, { code: err.code }));
    if (String((err as Error)?.message || "").startsWith("AUDIT_REQUIRED_WRITE_FAILED:")) {
      return res.status(503).send(error("审计写入失败，账号未更新", {
        code: "FJADMIN_AUDIT_UNAVAILABLE",
      }));
    }
    throw err;
  }

  if (verificationMail) {
    const delivery = verificationMail;
    try {
      await sendEmailVerificationMail({
        email: delivery.email,
        verifyUrl: delivery.verifyUrl,
        code: delivery.code,
      });
    } catch {
      // The email change remains safely unverified. Permanently invalidate the
      // undelivered token so a later resend creates a fresh exact-one family.
      await (db as any).transaction(async (trx: any) => {
        await trx("o_user").where({ id: delivery.userId }).forUpdate().first();
        await trx("o_auth_token")
          .where({
            userId: delivery.userId,
            type: "verify_email",
          })
          .whereNull("usedAt")
          .update({ usedAt: Date.now() });
      });
      return res.status(502).send(error("验证邮件发送失败，请稍后重试", {
        code: "MAIL_DELIVERY_FAILED",
      }));
    }
  }

  return sendProfile(req, res);
});

export default router;
