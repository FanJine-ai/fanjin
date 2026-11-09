import express from "express";
import { db } from "@/utils/db";
import { AuthError, createPasswordResetToken } from "@/lib/auth";
import {
  ensureAuthHandoffSeed,
  setAuthHandoffResponseHeaders,
} from "@/lib/authHandoff";
import { error, success } from "@/lib/responseFormat";

const router = express.Router();

export default router.post("/", async (req, res) => {
  setAuthHandoffResponseHeaders(res);
  const handoffSeed = ensureAuthHandoffSeed(req, res);
  const genericSuccess = () => res.status(200).send(
    success(
      {
        issued: true,
        expiresAt: Date.now() + 30 * 60 * 1000,
        delivery: "email",
      },
      "如果账号存在，重置方式已发送到该邮箱",
    ),
  );
  try {
    const result = await createPasswordResetToken(
      db as any,
      req.body.email || req.body.username || "",
      {
        userAgent: Array.isArray(req.headers["user-agent"])
          ? req.headers["user-agent"].join(",")
          : req.headers["user-agent"],
        ip: req.ip,
        handoffSeed,
      },
    );
    return res.status(200).send(success(result, "如果账号存在，重置方式已发送到该邮箱"));
  } catch (err: any) {
    // Delivery failure is account-dependent. Returning a different status
    // would let callers distinguish a real mailbox from an unknown account.
    // The issued source has already been burned by createPasswordResetToken.
    if (err instanceof AuthError && err.code === "MAIL_DELIVERY_FAILED") {
      console.warn("[auth] password reset delivery unavailable");
      return genericSuccess();
    }
    const status = err instanceof AuthError ? err.status : (Number(err?.status) || 500);
    if ((err instanceof AuthError && err.retryAfterSeconds) || err?.retryAfterSeconds) {
      res.setHeader("Retry-After", String(err.retryAfterSeconds));
    }
    const code = err instanceof AuthError ? err.code : err?.code;
    return res.status(status).send(
      error(err?.message || "找回密码失败", code ? { code } : null),
    );
  }
});
