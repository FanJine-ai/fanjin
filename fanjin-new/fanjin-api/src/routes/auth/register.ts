import express from "express";
import { db } from "@/utils/db";
import { AuthError, registerAccount } from "@/lib/auth";
import { getRegistrationMode } from "@/lib/registrationPolicy";
import { getBooleanPlatformSetting } from "@/lib/platformSettings";
import { normalizeCommercialHost, requestCommercialTenant } from "@/lib/commercialTenant";
import {
  ensureAuthHandoffSeed,
  setAuthHandoffResponseHeaders,
} from "@/lib/authHandoff";
import { error, success } from "@/lib/responseFormat";

const router = express.Router();

export default router.post("/", async (req, res) => {
  setAuthHandoffResponseHeaders(res);
  const handoffSeed = ensureAuthHandoffSeed(req, res);
  try {
    const registrationMode = await getRegistrationMode();
    const passwordRegisterEnabled = await getBooleanPlatformSetting("platform.auth.passwordRegisterEnabled", true);
    if (registrationMode === "closed") {
      return res.status(403).send(error("当前暂未开放自助注册，请联系平台管理员开通企业工作区。"));
    }
    if (registrationMode === "invite") {
      return res.status(403).send(error("当前仅支持企业邀请注册，请使用管理员发出的邀请入口。"));
    }
    if (!passwordRegisterEnabled) {
      return res.status(403).send(error("当前暂未开放账号密码注册，请联系平台管理员开通企业工作区。"));
    }

    // 0.1.4 注册租户归属：以注册请求入口 Host 解析的商业租户为准。
    // 中间件 commercialTenantContextMiddleware 已完成解析（严格模式下未知 Host 421）。
    const registrationTenant = requestCommercialTenant(req);
    const result = await registerAccount(
      db as any,
      {
        username: req.body.username,
        name: req.body.name,
        email: req.body.email,
        password: req.body.password,
        workspaceName: req.body.workspaceName,
        registrationTenant: {
          tenantId: registrationTenant.id,
          hostname: normalizeCommercialHost(req.hostname || req.headers.host),
          source: "public_signup",
        },
      },
      {
        userAgent: Array.isArray(req.headers["user-agent"])
          ? req.headers["user-agent"].join(",")
          : req.headers["user-agent"],
        ip: req.ip,
        handoffSeed,
      },
    );
    const { rawToken: _rawToken, ...data } = result as Record<string, unknown>;
    return res.status(200).send(success(data, "注册成功，请查收验证邮件"));
  } catch (err: any) {
    const status = err instanceof AuthError ? err.status : 500;
    return res.status(status).send(
      error(
        err?.message || "注册失败",
        err instanceof AuthError ? { code: err.code, ...(err.data || {}) } : null,
      ),
    );
  }
});
