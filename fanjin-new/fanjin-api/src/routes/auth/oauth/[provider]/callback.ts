import express from "express";
import {
  requireEnabledOAuthProvider,
  DEFAULT_POST_LOGIN_REDIRECT,
  resolveOAuthPublicBaseUrl,
  sanitizeFrontendRedirect,
} from "@/lib/oauth/config";
import {
  issueOAuthPrimaryBootstrapProof,
  OAUTH_BOOTSTRAP_PROOF_TTL_MS,
} from "@/lib/oauth/bootstrap";
import { issueOAuthSessionExchange } from "@/lib/oauth/exchange";
import { exchangeOAuthCode } from "@/lib/oauth/providers";
import { resolveOAuthUserForLogin } from "@/lib/oauth/service";
import {
  clearOAuthBrowserBindingCookie,
  consumeOAuthLoginState,
  OAUTH_EXCHANGE_TTL_MS,
  readOAuthBrowserBinding,
  setOAuthBrowserBindingCookie,
} from "@/lib/oauth/state";
import { isOAuthProviderId } from "@/lib/oauth/types";
import { getRegistrationMode } from "@/lib/registrationPolicy";
import { db } from "@/utils/db";
import {
  oauthPublicError,
  type OAuthPublicErrorCode,
  toOAuthPublicError,
} from "@/lib/oauth/errors";

const router = express.Router({ mergeParams: true });

function frontendCallbackUrl(input: {
  publicBaseUrl: string;
  redirect: string;
  exchange?: string;
  bootstrapProof?: string;
  bootstrapProvider?: string;
  errorCode?: string;
  errorMessage?: string;
}): string {
  const base = input.publicBaseUrl.replace(/\/+$/, "");
  const params = new URLSearchParams();
  if (input.exchange) params.set("exchange", input.exchange);
  if (input.bootstrapProof) params.set("bootstrapProof", input.bootstrapProof);
  if (input.bootstrapProvider) params.set("provider", input.bootstrapProvider);
  params.set("redirect", input.redirect);
  if (input.errorCode) params.set("error", input.errorCode);
  if (input.errorMessage) params.set("message", input.errorMessage);
  // The fragment is not sent in HTTP requests or Referer headers. It carries
  // only a short-lived, one-time, browser-cookie-bound exchange code—never a
  // long-lived session bearer.
  return `${base}/index.html#/auth/oauth/callback?${params.toString()}`;
}

export default router.get("/", async (req, res) => {
  const providerRaw = String((req.params as any).provider || "");
  const publicBaseUrl = resolveOAuthPublicBaseUrl(`${req.protocol}://${req.get("host") || ""}`) || "";
  const secureCookie = publicBaseUrl.startsWith("https://");
  const browserBinding = readOAuthBrowserBinding(req.headers.cookie);
  let failureRedirect = DEFAULT_POST_LOGIN_REDIRECT;
  res.set("Cache-Control", "no-store");
  res.set("Referrer-Policy", "no-referrer");
  const fail = (
    code: OAuthPublicErrorCode,
    redirect = DEFAULT_POST_LOGIN_REDIRECT,
  ) => {
    const publicError = oauthPublicError(code);
    clearOAuthBrowserBindingCookie(res, secureCookie);
    if (!publicBaseUrl) {
      return res.status(publicError.status).send(
        `${publicError.message} (${publicError.code})`,
      );
    }
    return res.redirect(302, frontendCallbackUrl({
      publicBaseUrl,
      redirect: sanitizeFrontendRedirect(redirect),
      errorCode: publicError.code,
      errorMessage: publicError.message,
    }));
  };

  try {
    if (!isOAuthProviderId(providerRaw)) {
      return fail("UNSUPPORTED_OAUTH_PROVIDER");
    }
    const config = await requireEnabledOAuthProvider(providerRaw);
    const state = String(req.query.state || "").trim();
    const code = String(req.query.code || "").trim();
    if (!state || (!code && !req.query.error)) {
      return fail("OAUTH_CALLBACK_INVALID");
    }

    const loginState = await consumeOAuthLoginState(
      db as any,
      state,
      config.id,
      browserBinding,
    );
    const redirect = sanitizeFrontendRedirect(loginState.redirect);
    failureRedirect = redirect;
    if (req.query.error) {
      return fail(
        "OAUTH_DENIED",
        redirect,
      );
    }
    if (!publicBaseUrl) return fail("PUBLIC_BASE_URL_MISSING", redirect);

    const profile = await exchangeOAuthCode({
      config,
      code,
      publicBaseUrl,
      codeVerifier: browserBinding?.codeVerifier || null,
    });
    if (loginState.mode === "bootstrap") {
      if (!loginState.bootstrap) {
        throw Object.assign(new Error("OAUTH_BOOTSTRAP_CONTEXT_MISMATCH"), {
          code: "OAUTH_BOOTSTRAP_CONTEXT_MISMATCH",
          status: 403,
        });
      }
      const bootstrap = await issueOAuthPrimaryBootstrapProof(db as any, {
        state: loginState.bootstrap,
        provider: config.id,
        profileOpenId: profile.openId,
        browserBinding,
      });
      setOAuthBrowserBindingCookie(res, browserBinding!, {
        secure: secureCookie,
        maxAgeMs: OAUTH_BOOTSTRAP_PROOF_TTL_MS,
      });
      return res.redirect(302, frontendCallbackUrl({
        publicBaseUrl,
        redirect: "/settings/profile/basic",
        bootstrapProof: bootstrap.proof,
        bootstrapProvider: bootstrap.provider,
      }));
    }
    const user = await resolveOAuthUserForLogin(db as any, {
      provider: config.id,
      profile,
      allowRegistration: (await getRegistrationMode()) === "self_service",
    });
    const exchange = await issueOAuthSessionExchange(db as any, {
      userId: Number(user.id),
      provider: config.id,
      openId: profile.openId,
      browserBinding: browserBinding!,
    });
    setOAuthBrowserBindingCookie(res, browserBinding!, {
      secure: secureCookie,
      maxAgeMs: OAUTH_EXCHANGE_TTL_MS,
    });

    return res.redirect(302, frontendCallbackUrl({
      publicBaseUrl,
      redirect,
      exchange,
    }));
  } catch (err: any) {
    const publicError = toOAuthPublicError(err, {
      code: "OAUTH_CALLBACK_FAILED",
    });
    return fail(
      publicError.code,
      failureRedirect,
    );
  }
});
