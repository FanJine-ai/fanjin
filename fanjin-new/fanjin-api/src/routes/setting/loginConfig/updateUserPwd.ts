import express from "express";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { updatePasswordWithHistory } from "@/lib/auth";
import { getAccountSecurityPolicy, validatePasswordAgainstPolicy } from "@/lib/accountSecurity";
import { db } from "@/utils/db";
import { consumeStepUpProof, StepUpError } from "@/lib/stepUpAuth";
import { writeAuditLog } from "@/lib/audit";
const router = express.Router();

function stepUpProof(req: express.Request): string {
  const value = req.headers["x-fanjin-step-up"];
  return String(Array.isArray(value) ? value[0] || "" : value || "").trim();
}

const bodySchema = z.object({
  id: z.number().int().positive().optional().nullable(),
  name: z.string().trim().min(2).max(64),
  password: z.string().min(8).max(128).optional().or(z.literal("")),
}).strict();

function isUniqueViolation(err: unknown) {
  const code = String((err as { code?: unknown })?.code || "");
  return code === "23505"
    || code === "SQLITE_CONSTRAINT"
    || code === "SQLITE_CONSTRAINT_UNIQUE"
    || code.startsWith("SQLITE_CONSTRAINT_");
}

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });

  const authUser = (req as any).auth?.user || (req as any).user;
  const currentUserId = Number(authUser?.id || 0);
  if (!currentUserId) return res.status(401).send({ message: "未登录" });
  if (parsed.data.id != null && Number(parsed.data.id) !== currentUserId) {
    return res.status(403).send(error(
      "个人设置入口只允许修改当前账号；跨用户变更需要独立的受审计管理流程",
      { code: "CROSS_USER_PASSWORD_RESET_NOT_AVAILABLE" },
    ));
  }

  try {
    await (db as any).transaction(async (trx: any) => {
      const currentUser = await trx("o_user")
        .where({ id: currentUserId })
        .forUpdate()
        .first();
      if (!currentUser || currentUser.status !== "active") {
        throw new Error("ACCOUNT_UNAVAILABLE");
      }
      const timestamp = Math.max(Date.now(), Number(currentUser.updatedAt || 0) + 1);
      const security = parsed.data.password
        ? await getAccountSecurityPolicy(trx, currentUserId)
        : null;
      // `name` is the login principal, so the legacy endpoint is sensitive
      // even when it does not also change the password.
      await consumeStepUpProof(trx, {
        proof: stepUpProof(req),
        userId: currentUserId,
        sessionId: String((req as any).auth?.session?.id || ""),
        scope: "account.profile.sensitive",
      });
      if (parsed.data.password) {
        const passwordError = validatePasswordAgainstPolicy(parsed.data.password, security!.passwordPolicy);
        if (passwordError) throw new Error(`PASSWORD_POLICY:${passwordError}`);
      }
      const profileUpdated = await trx("o_user")
        .where({
          id: currentUserId,
          status: "active",
          updatedAt: currentUser.updatedAt,
        })
        .update({
          name: parsed.data.name,
          displayName: parsed.data.name,
          updatedAt: timestamp,
        });
      if (Number(profileUpdated || 0) !== 1) {
        throw new Error("ACCOUNT_PROFILE_CONFLICT");
      }
      if (parsed.data.password) {
        await updatePasswordWithHistory(trx, {
          userId: currentUserId,
          password: parsed.data.password!,
          policy: security!.passwordPolicy,
          timestamp: timestamp + 1,
        });
        await trx("o_user_session")
          .where({ userId: currentUserId })
          .whereNull("revokedAt")
          .update({ revokedAt: timestamp + 1, updatedAt: timestamp + 1 });
      }
      await writeAuditLog(req, {
        action: "account.profile.legacy_update",
        resourceType: "account",
        resourceId: currentUserId,
        required: true,
        metadata: {
          before: {
            name: currentUser.name,
            displayName: currentUser.displayName,
          },
          after: {
            name: parsed.data.name,
            displayName: parsed.data.name,
          },
          passwordChanged: Boolean(parsed.data.password),
        },
      }, trx);
    });
  } catch (err) {
    if (err instanceof StepUpError) return res.status(err.status).send(error(err.message, { code: err.code }));
    const message = String((err as Error)?.message || "");
    if (message === "ACCOUNT_UNAVAILABLE") {
      return res.status(403).send(error("账号不可用", { code: "ACCOUNT_UNAVAILABLE" }));
    }
    if (message === "ACCOUNT_PROFILE_CONFLICT") {
      return res.status(409).send(error("账号资料已被其他请求修改，请重试", {
        code: "ACCOUNT_PROFILE_CONFLICT",
      }));
    }
    if (message.startsWith("PASSWORD_POLICY:")) {
      return res.status(400).send(error(message.slice("PASSWORD_POLICY:".length)));
    }
    if (message.startsWith("AUDIT_REQUIRED_WRITE_FAILED:")) {
      return res.status(503).send(error("审计写入失败，账号未更新", {
        code: "FJADMIN_AUDIT_UNAVAILABLE",
      }));
    }
    if (isUniqueViolation(err)) {
      return res.status(409).send(error("用户名已存在", { code: "ACCOUNT_NAME_CONFLICT" }));
    }
    throw err;
  }
  res.status(200).send(success("保存设置成功"));
});
