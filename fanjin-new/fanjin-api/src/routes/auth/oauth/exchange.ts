import express from "express";
import { z } from "zod";
import { AuthError } from "@/lib/auth";
import {
  completeOAuthMfaSessionExchange,
  consumeOAuthSessionExchange,
  OAUTH_MFA_CHALLENGE_TTL_MS,
} from "@/lib/oauth/exchange";
import {
  clearOAuthBrowserBindingCookie,
  readOAuthBrowserBinding,
  setOAuthBrowserBindingCookie,
} from "@/lib/oauth/state";
import { error, success } from "@/lib/responseFormat";
import { db } from "@/utils/db";
import { oauthPublicError, toOAuthPublicError } from "@/lib/oauth/errors";

const router = express.Router();

const bodySchema = z.object({
  exchange: z.string().trim().min(20).max(256),
}).strict();

const mfaBodySchema = z.object({
  challenge: z.string().trim().min(20).max(256),
  code: z.string().trim().min(1).max(128),
}).strict();

function requestSecurityContext(req: express.Request) {
  return {
    userAgent: Array.isArray(req.headers["user-agent"])
      ? req.headers["user-agent"].join(",")
      : req.headers["user-agent"],
    ip: req.ip,
  };
}

function secureCookieForRequest(req: express.Request): boolean {
  const forwardedProtocol = String(req.get("x-forwarded-proto") || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  return Boolean(req.secure || forwardedProtocol === "https");
}

router.post("/", async (req, res) => {
  const secureCookie = secureCookieForRequest(req);
  const browserBinding = readOAuthBrowserBinding(req.headers.cookie);
  res.set("Cache-Control", "no-store");
  res.set("Referrer-Policy", "no-referrer");

  try {
    const parsedMfa = mfaBodySchema.safeParse(req.body || {});
    if (parsedMfa.success) {
      const session = await completeOAuthMfaSessionExchange(db as any, {
        challenge: parsedMfa.data.challenge,
        credential: parsedMfa.data.code,
        browserBinding,
        authInfo: requestSecurityContext(req),
      }) as any;
      clearOAuthBrowserBindingCookie(res, secureCookie);
      const { rawToken: _rawToken, ...publicSession } = session;
      return res.status(200).send(success(publicSession, "登录成功"));
    }

    const parsed = bodySchema.safeParse(req.body || {});
    if (!parsed.success) {
      clearOAuthBrowserBindingCookie(res, secureCookie);
      const publicError = oauthPublicError("OAUTH_EXCHANGE_INVALID");
      return res.status(publicError.status).send(error(
        publicError.message,
        { code: publicError.code },
      ));
    }
    const session = await consumeOAuthSessionExchange(db as any, {
      rawExchange: parsed.data.exchange,
      browserBinding,
      authInfo: requestSecurityContext(req),
    }) as any;
    clearOAuthBrowserBindingCookie(res, secureCookie);
    const { rawToken: _rawToken, ...publicSession } = session;
    return res.status(200).send(success(publicSession, "登录成功"));
  } catch (err: any) {
    const publicError = toOAuthPublicError(err, {
      code: "OAUTH_EXCHANGE_FAILED",
    });
    if (
      publicError.code === "MFA_REQUIRED"
      && browserBinding
    ) {
      setOAuthBrowserBindingCookie(res, browserBinding, {
        secure: secureCookie,
        maxAgeMs: OAUTH_MFA_CHALLENGE_TTL_MS,
      });
    } else {
      clearOAuthBrowserBindingCookie(res, secureCookie);
    }
    return res.status(publicError.status).send(error(
      publicError.message,
      {
        code: publicError.code,
        ...publicError.data,
      },
    ));
  }
});

export default router;
