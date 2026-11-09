import express from "express";
import { db } from "@/utils/db";
import { AuthError, loginWithMfaChallenge, loginWithPassword } from "@/lib/auth";
import { getBooleanPlatformSetting } from "@/lib/platformSettings";
import { error, success } from "@/lib/responseFormat";

const router = express.Router();

router.post("/", async (req, res) => {
  try {
    const passwordLoginEnabled = await getBooleanPlatformSetting("platform.auth.passwordLoginEnabled", true);
    if (!passwordLoginEnabled) {
      return res.status(403).send(error("当前已关闭账号密码登录，请使用企业指定登录方式。"));
    }

    const username = req.body.username || req.body.name || req.body.email;
    const result = (await loginWithPassword(db as any, username || "", req.body.password || "", {
      userAgent: Array.isArray(req.headers["user-agent"])
        ? req.headers["user-agent"].join(",")
        : req.headers["user-agent"],
      ip: req.ip,
    })) as any;
    const { rawToken, ...data } = result;
    return res.status(200).send(success(data, "登录成功"));
  } catch (err: any) {
    const status = err instanceof AuthError ? err.status : 400;
    if (err instanceof AuthError && err.retryAfterSeconds) res.setHeader("Retry-After", String(err.retryAfterSeconds));
    return res.status(status).send(error(
      err?.message || "登录失败",
      err instanceof AuthError ? { code: err.code, ...(err.data || {}) } : null,
    ));
  }
});

router.post("/mfa", async (req, res) => {
  try {
    const result = (await loginWithMfaChallenge(
      db as any,
      String(req.body?.challenge || ""),
      String(req.body?.code || req.body?.recoveryCode || ""),
      {
        userAgent: Array.isArray(req.headers["user-agent"])
          ? req.headers["user-agent"].join(",")
          : req.headers["user-agent"],
        ip: req.ip,
      },
    )) as any;
    const { rawToken, ...data } = result;
    return res.status(200).send(success(data, "MFA 登录成功"));
  } catch (err: any) {
    const status = err instanceof AuthError ? err.status : 400;
    if (err instanceof AuthError && err.retryAfterSeconds) res.setHeader("Retry-After", String(err.retryAfterSeconds));
    return res.status(status).send(error(
      err?.message || "MFA 登录失败",
      err instanceof AuthError ? { code: err.code, ...(err.data || {}) } : null,
    ));
  }
});

export default router;
