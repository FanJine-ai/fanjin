import express from "express";
import { db } from "@/utils/db";
import { AuthError } from "@/lib/auth";
import { resendEmailVerification } from "@/lib/emailVerification";
import { isMailConfigured } from "@/lib/mailer/smtpMailer";
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
    if (!(await isMailConfigured())) {
      return res.status(503).send(error("邮件服务未配置，请联系管理员", { code: "MAIL_NOT_CONFIGURED" }));
    }
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!email) {
      return res.status(400).send(error("请输入邮箱", { code: "EMAIL_REQUIRED" }));
    }
    try {
      await resendEmailVerification(db as any, email, { ip: req.ip, handoffSeed });
    } catch (err: any) {
      if (err instanceof AuthError && err.code === "MAIL_DELIVERY_FAILED") {
        // A delivery-specific failure only occurs for an existing unverified
        // account. Keep the public response indistinguishable and rely on
        // aggregate operational alerts; the undelivered source is burned.
        console.warn("[auth] verification delivery unavailable");
        return res.status(200).send(
          success({}, "若该邮箱已注册且未验证，我们将发送验证邮件"),
        );
      }
      if (err instanceof AuthError && err.code === "MAIL_NOT_CONFIGURED") {
        return res.status(503).send(error(err.message, { code: err.code }));
      }
      // Fuzzy success for other cases handled by resendEmailVerification returning quietly
      if (err instanceof AuthError && err.code && !["MAIL_DELIVERY_FAILED", "MAIL_NOT_CONFIGURED"].includes(err.code)) {
        // EMAIL_REQUIRED already handled above; rethrow unexpected AuthErrors
        if (err.code === "EMAIL_REQUIRED") {
          return res.status(400).send(error(err.message, { code: err.code }));
        }
      }
    }
    return res.status(200).send(success({}, "若该邮箱已注册且未验证，我们将发送验证邮件"));
  } catch (err: any) {
    return res.status(500).send(error(err?.message || "发送失败"));
  }
});
