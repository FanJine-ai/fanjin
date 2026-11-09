import express from "express";
import { db } from "@/utils/db";
import { AuthError, completePasswordResetHandoff } from "@/lib/auth";
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
      await burnLegacyAuthHandoff(db as any, "password_reset", String(req.body.token));
      return res.status(410).send(error("旧版邮件链接已停用，请重新申请", {
        code: "AUTH_LINK_LEGACY_GONE",
      }));
    }
    const result = await completePasswordResetHandoff(
      db as any,
      readAuthHandoffClaim(req),
      req.body.password || "",
    );
    clearAuthHandoffClaim(res);
    return res.status(200).send(success(result, "密码已重置"));
  } catch (err: any) {
    const status = err instanceof AuthError ? err.status : 500;
    return res.status(status).send(error(
      err?.message || "重置密码失败",
      err instanceof AuthError ? { code: err.code } : null,
    ));
  }
});

export default router;
