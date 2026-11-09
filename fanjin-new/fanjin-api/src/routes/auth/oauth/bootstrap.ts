import express from "express";
import { z } from "zod";
import {
  completeOAuthPasswordBootstrap,
} from "@/lib/oauth/bootstrap";
import {
  requireEnabledOAuthProvider,
  resolveOAuthPublicBaseUrl,
} from "@/lib/oauth/config";
import { oauthPublicError, toOAuthPublicError } from "@/lib/oauth/errors";
import { buildAuthorizeUrl } from "@/lib/oauth/providers";
import {
  clearOAuthBrowserBindingCookie,
  createOAuthBrowserBinding,
  issueOAuthLoginState,
  oauthCodeChallenge,
  readOAuthBrowserBinding,
  setOAuthBrowserBindingCookie,
} from "@/lib/oauth/state";
import { isOAuthProviderId } from "@/lib/oauth/types";
import { USER_OAUTH_IDENTITY_TABLE } from "@/lib/migrations/userOauthIdentity";
import { error, success } from "@/lib/responseFormat";
import { db } from "@/utils/db";

const router = express.Router();

const startSchema = z.object({
  provider: z.string().trim().min(1).max(32),
}).strict();

const completeSchema = z.object({
  proof: z.string().trim().min(20).max(256),
  password: z.string().min(8).max(128),
}).strict();

function secureCookieForRequest(req: express.Request): boolean {
  const forwardedProtocol = String(req.get("x-forwarded-proto") || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  return Boolean(req.secure || forwardedProtocol === "https");
}

router.post("/start", async (req, res) => {
  res.set("Cache-Control", "no-store");
  res.set("Referrer-Policy", "no-referrer");
  try {
    const parsed = startSchema.safeParse(req.body || {});
    if (!parsed.success || !isOAuthProviderId(parsed.data.provider)) {
      const publicError = oauthPublicError("UNSUPPORTED_OAUTH_PROVIDER");
      return res.status(publicError.status).send(error(
        publicError.message,
        { code: publicError.code },
      ));
    }
    const userId = Number((req as any).auth?.user?.id || 0);
    const sessionId = String((req as any).auth?.session?.id || "");
    if (!userId || !sessionId) {
      const publicError = oauthPublicError("OAUTH_BOOTSTRAP_CONTEXT_MISMATCH");
      return res.status(publicError.status).send(error(
        publicError.message,
        { code: publicError.code },
      ));
    }
    const config = await requireEnabledOAuthProvider(parsed.data.provider);
    const publicBaseUrl = resolveOAuthPublicBaseUrl(
      `${req.protocol}://${req.get("host") || ""}`,
    );
    if (!publicBaseUrl) {
      const publicError = oauthPublicError("PUBLIC_BASE_URL_MISSING");
      return res.status(publicError.status).send(error(
        publicError.message,
        { code: publicError.code },
      ));
    }
    const browserBinding = createOAuthBrowserBinding(
      config.id === "google" || config.id === "github",
    );
    const state = await (db as any).transaction(async (trx: any) => {
      const user = await trx("o_user")
        .where({ id: userId })
        .forUpdate()
        .first();
      const session = await trx("o_user_session")
        .where({ id: sessionId, userId })
        .whereNull("revokedAt")
        .forUpdate()
        .first();
      const identity = await trx(USER_OAUTH_IDENTITY_TABLE)
        .where({ userId, provider: config.id })
        .forUpdate()
        .first();
      if (
        !user
        || String(user.status || "") !== "active"
        || !session
        || !identity
      ) {
        throw Object.assign(new Error("OAUTH_BOOTSTRAP_CONTEXT_MISMATCH"), {
          status: 403,
          code: "OAUTH_BOOTSTRAP_CONTEXT_MISMATCH",
        });
      }
      if (user.password) {
        throw Object.assign(new Error("OAUTH_BOOTSTRAP_NOT_AVAILABLE"), {
          status: 409,
          code: "OAUTH_BOOTSTRAP_NOT_AVAILABLE",
        });
      }
      return await issueOAuthLoginState(trx, {
        provider: config.id,
        redirect: "/settings/profile/basic",
        mode: "bootstrap",
        browserBinding,
        bootstrap: {
          scope: "account.password.bootstrap",
          userId,
          sessionId,
          authGeneration: Number(user.updatedAt || 0),
          identityId: String(identity.id),
          identityGeneration: Number(identity.updatedAt || 0),
          openId: String(identity.openId || ""),
        },
      });
    });
    setOAuthBrowserBindingCookie(res, browserBinding, {
      secure: publicBaseUrl.startsWith("https://"),
    });
    const authorizeUrl = buildAuthorizeUrl({
      config,
      publicBaseUrl,
      state,
      codeChallenge: browserBinding.codeVerifier
        ? oauthCodeChallenge(browserBinding.codeVerifier)
        : null,
    });
    return res.status(200).send(success({ authorizeUrl }, "请重新验证第三方账号"));
  } catch (reason) {
    const publicError = toOAuthPublicError(reason, {
      code: "OAUTH_BOOTSTRAP_FAILED",
    });
    return res.status(publicError.status).send(error(
      publicError.message,
      { code: publicError.code, ...publicError.data },
    ));
  }
});

router.post("/complete", async (req, res) => {
  res.set("Cache-Control", "no-store");
  res.set("Referrer-Policy", "no-referrer");
  const secureCookie = secureCookieForRequest(req);
  try {
    const parsed = completeSchema.safeParse(req.body || {});
    if (!parsed.success) {
      const publicError = oauthPublicError("OAUTH_REQUEST_INVALID");
      return res.status(publicError.status).send(error(
        publicError.message,
        { code: publicError.code },
      ));
    }
    const userId = Number((req as any).auth?.user?.id || 0);
    const sessionId = String((req as any).auth?.session?.id || "");
    if (!userId || !sessionId) {
      const publicError = oauthPublicError("OAUTH_BOOTSTRAP_CONTEXT_MISMATCH");
      return res.status(publicError.status).send(error(
        publicError.message,
        { code: publicError.code },
      ));
    }
    const result = await completeOAuthPasswordBootstrap(db as any, {
      proof: parsed.data.proof,
      password: parsed.data.password,
      userId,
      sessionId,
      browserBinding: readOAuthBrowserBinding(req.headers.cookie),
      auditContext: req,
    });
    clearOAuthBrowserBindingCookie(res, secureCookie);
    return res.status(200).send(success(result, "登录密码已设置"));
  } catch (reason) {
    const publicError = toOAuthPublicError(reason, {
      code: "OAUTH_BOOTSTRAP_FAILED",
    });
    return res.status(publicError.status).send(error(
      publicError.message,
      { code: publicError.code, ...publicError.data },
    ));
  }
});

export default router;
