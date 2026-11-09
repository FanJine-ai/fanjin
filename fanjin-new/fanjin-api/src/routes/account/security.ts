import express from "express";
import { z } from "zod";
import { getAccountProfile } from "@/lib/accountProfile";
import { success, error } from "@/lib/responseFormat";
import { writeAuditLog } from "@/lib/audit";
import { parseLoginIpAllowlist } from "@/lib/accountSecurity";
import { beginMfaSetup, completeMfaSetup, disableMfa, MfaError } from "@/lib/mfa";
import { db } from "@/utils/db";
import {
  consumeStepUpProof,
  issueSessionStepUpProofBatch,
  issueStepUpProof,
  issueStepUpProofBatch,
  StepUpError,
  stepUpScopes,
} from "@/lib/stepUpAuth";

const router = express.Router();

const passwordPolicySchema = z.object({
  minLength: z.number().int().min(8).max(64).optional(),
  requireUppercase: z.boolean().optional(),
  requireLowercase: z.boolean().optional(),
  requireNumber: z.boolean().optional(),
  requireSymbol: z.boolean().optional(),
  expireDays: z.number().int().min(0).max(365).optional(),
  rejectHistoryCount: z.number().int().min(0).max(24).optional(),
  maxRetriesPerHour: z.number().int().min(1).max(100).optional(),
  lockMinutes: z.number().int().min(1).max(1440).optional(),
});

const sessionPolicySchema = z.object({
  idleMinutes: z.number().int().min(5).max(10080).optional(),
  absoluteHours: z.number().int().min(1).max(720).optional(),
});

const bodySchema = z.object({
  phone: z.string().trim().max(32).optional().nullable(),
  mfaEnabled: z.boolean().optional(),
  loginProtectionEnabled: z.boolean().optional(),
  sensitiveOperationProtectionEnabled: z.boolean().optional(),
  loginIpAllowlist: z.string().max(5000).optional(),
  passwordPolicy: passwordPolicySchema.optional(),
  sessionPolicy: sessionPolicySchema.optional(),
});

const mfaCodeSchema = z.object({
  code: z.string().trim().min(1).max(128),
});

const mfaDisableSchema = z.object({
  password: z.string().min(1).max(128),
  code: z.string().trim().min(1).max(128),
});

const stepUpSchema = z.object({
  password: z.string().min(1).max(128),
  code: z.string().trim().min(1).max(128).optional().nullable(),
  scope: z.enum(stepUpScopes),
});

const stepUpBatchSchema = z.object({
  password: z.string().min(1).max(128),
  code: z.string().trim().min(1).max(128).optional().nullable(),
  scopes: z.array(z.enum(stepUpScopes)).min(2).max(8),
});

const sessionStepUpSchema = z.object({
  scopes: z.array(z.enum(stepUpScopes)).min(1).max(8),
});

function currentUserId(req: express.Request): number {
  return Number(((req as any).auth?.user || (req as any).user || {}).id || 0);
}

function currentSessionId(req: express.Request): string {
  return String((req as any).auth?.session?.id || "");
}

function stepUpProof(req: express.Request): string {
  const value = req.headers["x-fanjin-step-up"];
  return String(Array.isArray(value) ? value[0] || "" : value || "").trim();
}

function sendMfaError(res: express.Response, err: unknown) {
  if (err instanceof MfaError) return res.status(err.status).send(error(err.message, { code: err.code }));
  throw err;
}

function sendStepUpError(res: express.Response, err: unknown) {
  if (err instanceof StepUpError) return res.status(err.status).send(error(err.message, { code: err.code }));
  throw err;
}

router.post("/step-up", async (req, res) => {
  const parsed = stepUpSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  const userId = currentUserId(req);
  const sessionId = currentSessionId(req);
  if (!userId || !sessionId) return res.status(401).send(error("未登录"));
  try {
    const result = await issueStepUpProof(db, {
      userId,
      sessionId,
      scope: parsed.data.scope,
      password: parsed.data.password,
      mfaCredential: parsed.data.code,
    });
    await writeAuditLog(req, {
      action: "account.step_up.verify",
      resourceType: "auth_session",
      resourceId: sessionId,
      metadata: { scope: result.scope, method: result.method, expiresAt: result.expiresAt },
    });
    return res.status(200).send(success(result, "敏感操作验证成功"));
  } catch (err) {
    return sendStepUpError(res, err);
  }
});

router.post("/step-up/batch", async (req, res) => {
  const parsed = stepUpBatchSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  const userId = currentUserId(req);
  const sessionId = currentSessionId(req);
  if (!userId || !sessionId) return res.status(401).send(error("未登录"));
  try {
    const proofs = await issueStepUpProofBatch(db, {
      userId,
      sessionId,
      scopes: parsed.data.scopes,
      password: parsed.data.password,
      mfaCredential: parsed.data.code,
    });
    await writeAuditLog(req, {
      action: "account.step_up.batch_verify",
      resourceType: "auth_session",
      resourceId: sessionId,
      metadata: {
        scopes: proofs.map((item) => item.scope),
        count: proofs.length,
        method: proofs[0]?.method,
        expiresAt: proofs[0]?.expiresAt,
      },
    });
    return res.status(200).send(success({ proofs }, "敏感操作批次验证成功"));
  } catch (err) {
    return sendStepUpError(res, err);
  }
});

router.post("/step-up/session", async (req, res) => {
  const parsed = sessionStepUpSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  const userId = currentUserId(req);
  const sessionId = currentSessionId(req);
  if (!userId || !sessionId) return res.status(401).send(error("未登录"));
  try {
    const proofs = await issueSessionStepUpProofBatch(db, {
      userId,
      sessionId,
      scopes: parsed.data.scopes,
    });
    await writeAuditLog(req, {
      action: "account.step_up.session_reuse",
      resourceType: "auth_session",
      resourceId: sessionId,
      metadata: {
        scopes: proofs.map((item) => item.scope),
        count: proofs.length,
        method: proofs[0]?.method,
        expiresAt: proofs[0]?.expiresAt,
      },
    });
    return res.status(200).send(success({ proofs }, "已复用本次登录的身份验证"));
  } catch (err) {
    return sendStepUpError(res, err);
  }
});

router.post("/mfa/setup", async (req, res) => {
  const userId = currentUserId(req);
  const sessionId = currentSessionId(req);
  if (!userId || !sessionId) return res.status(401).send(error("未登录"));
  try {
    const setup = await db.transaction(async (trx) => {
      await consumeStepUpProof(trx, {
        proof: stepUpProof(req),
        userId,
        sessionId,
        scope: "account.security.update",
      });
      const user = await trx("o_user").where({ id: userId }).first();
      if (!user) throw new StepUpError("账号不存在", 401, "STEP_UP_SESSION_INVALID");
      const value = await beginMfaSetup(trx as any, {
        userId,
        accountLabel: String(user.email || user.name || userId),
      });
      await writeAuditLog(req, {
        action: "account.mfa.setup.start",
        resourceType: "account_security",
        resourceId: userId,
        required: true,
        metadata: { expiresAt: value.expiresAt },
      }, trx);
      return value;
    });
    return res.status(200).send(success(setup, "请使用身份验证器扫码并输入验证码完成启用"));
  } catch (err) {
    if (err instanceof StepUpError) return sendStepUpError(res, err);
    if (String((err as Error)?.message || "").startsWith("AUDIT_REQUIRED_WRITE_FAILED:")) {
      return res.status(503).send(error("审计写入失败，MFA setup 未创建", {
        code: "FJADMIN_AUDIT_UNAVAILABLE",
      }));
    }
    return sendMfaError(res, err);
  }
});

router.post("/mfa/verify", async (req, res) => {
  const parsed = mfaCodeSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  const userId = currentUserId(req);
  if (!userId) return res.status(401).send(error("未登录"));
  try {
    const enabled = await db.transaction(async (trx) => {
      const value = await completeMfaSetup(trx as any, {
        userId,
        code: parsed.data.code,
        currentSessionId: String((req as any).auth?.session?.id || "") || null,
      });
      await writeAuditLog(req, {
        action: "account.mfa.enable",
        resourceType: "account_security",
        resourceId: userId,
        required: true,
        metadata: { recoveryCodeCount: value.recoveryCodes.length },
      }, trx);
      return value;
    });
    return res.status(200).send(success(enabled, "MFA 已启用，请立即保存恢复码"));
  } catch (err) {
    if (String((err as Error)?.message || "").startsWith("AUDIT_REQUIRED_WRITE_FAILED:")) {
      return res.status(503).send(error("审计写入失败，MFA 未启用", {
        code: "FJADMIN_AUDIT_UNAVAILABLE",
      }));
    }
    return sendMfaError(res, err);
  }
});

router.post("/mfa/disable", async (req, res) => {
  const parsed = mfaDisableSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  const userId = currentUserId(req);
  if (!userId) return res.status(401).send(error("未登录"));
  try {
    const disabled = await db.transaction(async (trx) => {
      const value = await disableMfa(trx as any, {
        userId,
        credential: parsed.data.code,
        currentPassword: parsed.data.password,
        currentSessionId: String((req as any).auth?.session?.id || "") || null,
      });
      await writeAuditLog(req, {
        action: "account.mfa.disable",
        resourceType: "account_security",
        resourceId: userId,
        required: true,
        metadata: {},
      }, trx);
      return value;
    });
    return res.status(200).send(success(disabled, "MFA 已禁用"));
  } catch (err) {
    if (String((err as Error)?.message || "").startsWith("AUDIT_REQUIRED_WRITE_FAILED:")) {
      return res.status(503).send(error("审计写入失败，MFA 未禁用", {
        code: "FJADMIN_AUDIT_UNAVAILABLE",
      }));
    }
    return sendMfaError(res, err);
  }
});

router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });

  const userId = currentUserId(req);
  if (!userId) return res.status(401).send(error("未登录"));

  const database = db as any;
  const existing = await database("o_account_security").where("userId", userId).first();

  if (parsed.data.mfaEnabled === true) {
    return res.status(409).send(error("请通过 MFA setup 和验证码确认流程启用", { code: "MFA_SETUP_REQUIRED" }));
  }
  if (parsed.data.mfaEnabled === false && existing?.mfaEnabled) {
    return res.status(409).send(error(
      "禁用 MFA 必须提供当前密码和 TOTP 验证码或恢复码",
      { code: "MFA_DISABLE_VERIFICATION_REQUIRED" },
    ));
  }
  if (parsed.data.loginIpAllowlist !== undefined) {
    try {
      parseLoginIpAllowlist(parsed.data.loginIpAllowlist);
    } catch (err: any) {
      return res.status(400).send(error(err?.message || "登录 IP 白名单格式错误"));
    }
  }

  const id = String(userId);
  const data = parsed.data;
  const patch: Record<string, unknown> = {
  };
  if (data.phone !== undefined) patch.phone = data.phone || null;
  if (data.loginProtectionEnabled !== undefined) patch.loginProtectionEnabled = data.loginProtectionEnabled ? 1 : 0;
  if (data.sensitiveOperationProtectionEnabled !== undefined) {
    patch.sensitiveOperationProtectionEnabled = data.sensitiveOperationProtectionEnabled ? 1 : 0;
  }
  if (data.loginIpAllowlist !== undefined) patch.loginIpAllowlist = data.loginIpAllowlist.trim();
  if (data.passwordPolicy !== undefined) patch.passwordPolicy = JSON.stringify(data.passwordPolicy);
  if (data.sessionPolicy !== undefined) patch.sessionPolicy = JSON.stringify(data.sessionPolicy);
  if (!Object.keys(patch).length) {
    return res.status(400).send(error("未提供可更新的安全设置"));
  }

  let stepUpVerified = false;
  try {
    await db.transaction(async (trx) => {
      const user = await trx("o_user").where({ id: userId }).forUpdate().first();
      if (!user || String(user.status || "") !== "active") {
        throw new StepUpError("账号不可用", 401, "STEP_UP_SESSION_INVALID");
      }
      const currentSecurity = await trx("o_account_security").where({ userId }).forUpdate().first();
      const timestamp = Math.max(
        Date.now(),
        Number(currentSecurity?.updatedAt || 0) + 1,
      );
      const transactionPatch = { ...patch, updatedAt: timestamp };
      // Security controls cannot decide whether their own mutation needs
      // re-authentication. Every change requires a single-use, session-bound
      // proof, including the first enable and any later disable.
      await consumeStepUpProof(trx, {
        proof: stepUpProof(req),
        userId,
        sessionId: currentSessionId(req),
        scope: "account.security.update",
      });
      stepUpVerified = true;
      if (currentSecurity) {
        await trx("o_account_security")
          .where({ id: currentSecurity.id, userId, updatedAt: currentSecurity.updatedAt })
          .update(transactionPatch);
      } else {
        await trx("o_account_security").insert({
          id,
          userId,
          phone: null,
          mfaEnabled: 0,
          loginProtectionEnabled: 0,
          sensitiveOperationProtectionEnabled: 0,
          loginIpAllowlist: "",
          passwordPolicy: "{}",
          sessionPolicy: "{}",
          createdAt: timestamp,
          ...transactionPatch,
        });
      }
      await writeAuditLog(req, {
        action: "account.security.update",
        resourceType: "account_security",
        resourceId: userId,
        required: true,
        metadata: {
          changedFields: Object.keys(patch),
          stepUpVerified,
        },
      }, trx);
    });
  } catch (err) {
    if (err instanceof StepUpError) return sendStepUpError(res, err);
    if (String((err as Error)?.message || "").startsWith("AUDIT_REQUIRED_WRITE_FAILED:")) {
      return res.status(503).send(error("审计写入失败，安全设置未更新", {
        code: "FJADMIN_AUDIT_UNAVAILABLE",
      }));
    }
    throw err;
  }

  const profile = await getAccountProfile({
    userId,
    workspaceId: (req as any).auth?.workspaceId,
  });
  return res.status(200).send(success(profile?.security || null, "安全设置已更新"));
});

export default router;
