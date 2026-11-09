import express from "express";
import { db } from "@/utils/db";
import { AuthError } from "@/lib/auth";
import {
  claimAuthHandoff,
  readAuthHandoffSeed,
  setAuthHandoffClaim,
  setAuthHandoffResponseHeaders,
  type AuthHandoffFlow,
} from "@/lib/authHandoff";
import { error, success } from "@/lib/responseFormat";

const router = express.Router();

router.get("/", (_req, res) => {
  setAuthHandoffResponseHeaders(res);
  return res.status(404).end();
});

function flow(value: unknown): AuthHandoffFlow | null {
  return value === "password_reset" || value === "verify_email" ? value : null;
}

router.post("/", async (req, res) => {
  setAuthHandoffResponseHeaders(res);
  try {
    const requestedFlow = flow(req.body?.flow);
    if (!requestedFlow) {
      return res.status(400).send(error("邮件链接无效", {
        code: "AUTH_HANDOFF_INVALID",
      }));
    }
    const claimed = await claimAuthHandoff(db as any, {
      flow: requestedFlow,
      locator: String(req.body?.locator || ""),
      code: typeof req.body?.code === "string" ? req.body.code : null,
      seed: readAuthHandoffSeed(req),
    });
    setAuthHandoffClaim(res, claimed.claim);
    return res.status(200).send(success({ claimed: true, flow: claimed.flow }));
  } catch (err: any) {
    const status = err instanceof AuthError ? err.status : 400;
    const code = err instanceof AuthError ? err.code : "AUTH_HANDOFF_INVALID";
    return res.status(status).send(error(err?.message || "邮件链接无效", { code }));
  }
});

export default router;
