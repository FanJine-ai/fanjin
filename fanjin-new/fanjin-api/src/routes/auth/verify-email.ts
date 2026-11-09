import express from "express";
import { db } from "@/utils/db";
import { AuthError } from "@/lib/auth";
import { completeEmailVerificationHandoff } from "@/lib/emailVerification";
import {
  clearAuthHandoffClaim,
  burnLegacyAuthHandoff,
  readAuthHandoffClaim,
  setAuthHandoffResponseHeaders,
} from "@/lib/authHandoff";
import { error, success } from "@/lib/responseFormat";

const router = express.Router();

router.get("/", (_req, res) => {
  setAuthHandoffResponseHeaders(res);
  return res.status(404).end();
});

router.post("/", async (req, res) => {
  setAuthHandoffResponseHeaders(res);
  try {
    if (req.body?.token) {
      await burnLegacyAuthHandoff(db as any, "verify_email", String(req.body.token));
      return res.status(410).send(error("旧版邮件链接已停用，请重新申请", {
        code: "AUTH_LINK_LEGACY_GONE",
      }));
    }

    const verified = await completeEmailVerificationHandoff(
      db as any,
      readAuthHandoffClaim(req),
    );
    clearAuthHandoffClaim(res);

    return res.status(200).send(
      success(
        {
          email: verified.email,
          verified: true,
          alreadyVerified: verified.alreadyVerified,
          autoLogin: false,
        },
        verified.alreadyVerified ? "邮箱已验证，请登录" : "邮箱验证成功，请登录",
      ),
    );
  } catch (err: any) {
    const status = err instanceof AuthError ? err.status : 400;
    return res.status(status).send(
      error(
        err?.message || "验证失败",
        err instanceof AuthError ? { code: err.code } : { code: "TOKEN_INVALID" },
      ),
    );
  }
});

export default router;
