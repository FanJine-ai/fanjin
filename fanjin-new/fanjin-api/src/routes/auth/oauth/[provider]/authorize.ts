import express from "express";
import {
  requireEnabledOAuthProvider,
  resolveOAuthPublicBaseUrl,
  sanitizeFrontendRedirect,
} from "@/lib/oauth/config";
import { buildAuthorizeUrl } from "@/lib/oauth/providers";
import {
  createOAuthBrowserBinding,
  issueOAuthLoginState,
  oauthCodeChallenge,
  setOAuthBrowserBindingCookie,
} from "@/lib/oauth/state";
import { isOAuthProviderId } from "@/lib/oauth/types";
import { db } from "@/utils/db";
import { error } from "@/lib/responseFormat";
import { oauthPublicError, toOAuthPublicError } from "@/lib/oauth/errors";

const router = express.Router({ mergeParams: true });

export default router.get("/", async (req, res) => {
  try {
    const providerRaw = String((req.params as any).provider || "");
    if (!isOAuthProviderId(providerRaw)) {
      const publicError = oauthPublicError("UNSUPPORTED_OAUTH_PROVIDER");
      return res.status(publicError.status).send(error(
        publicError.message,
        { code: publicError.code },
      ));
    }
    const config = await requireEnabledOAuthProvider(providerRaw);
    const publicBaseUrl = resolveOAuthPublicBaseUrl(`${req.protocol}://${req.get("host") || ""}`);
    if (!publicBaseUrl) {
      const publicError = oauthPublicError("PUBLIC_BASE_URL_MISSING");
      return res.status(publicError.status).send(error(
        publicError.message,
        { code: publicError.code },
      ));
    }
    const redirect = sanitizeFrontendRedirect(req.query.redirect);
    const returnTo = typeof req.query.returnTo === "string" ? req.query.returnTo : null;
    const mode = typeof req.query.mode === "string" ? req.query.mode : null;
    if (mode === "bind" || mode === "bootstrap") {
      // A bearer session alone is not a recent primary-factor proof. Until a
      // dedicated step-up-bound provider-link flow is wired, fail closed
      // instead of letting a passwordless OAuth session add authority.
      const publicError = oauthPublicError("OAUTH_BIND_STEP_UP_REQUIRED");
      return res.status(publicError.status).send(error(
        publicError.message,
        { code: publicError.code },
      ));
    }
    if (mode && mode !== "login" && mode !== "register") {
      const publicError = oauthPublicError("OAUTH_MODE_INVALID");
      return res.status(publicError.status).send(error(
        publicError.message,
        { code: publicError.code },
      ));
    }
    const browserBinding = createOAuthBrowserBinding(
      config.id === "google" || config.id === "github",
    );
    const state = await issueOAuthLoginState(db as any, {
      provider: config.id,
      redirect,
      returnTo,
      mode,
      browserBinding,
    });
    setOAuthBrowserBindingCookie(res, browserBinding, {
      secure: publicBaseUrl.startsWith("https://"),
    });
    res.set("Cache-Control", "no-store");
    const authorizeUrl = buildAuthorizeUrl({
      config,
      publicBaseUrl,
      state,
      codeChallenge: browserBinding.codeVerifier
        ? oauthCodeChallenge(browserBinding.codeVerifier)
        : null,
    });
    return res.redirect(302, authorizeUrl);
  } catch (err: any) {
    const publicError = toOAuthPublicError(err, {
      code: "OAUTH_AUTHORIZE_FAILED",
    });
    return res.status(publicError.status).send(error(
      publicError.message,
      { code: publicError.code, ...publicError.data },
    ));
  }
});
