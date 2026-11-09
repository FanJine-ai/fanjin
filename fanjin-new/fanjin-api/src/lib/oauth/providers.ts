import type { OAuthProviderConfig, OAuthProfile, OAuthProviderId } from "@/lib/oauth/types";
import { buildOAuthCallbackUrl } from "@/lib/oauth/config";

export const OAUTH_PROVIDER_FETCH_TIMEOUT_MS = 8_000;
export const OAUTH_PROVIDER_RESPONSE_MAX_BYTES = 256 * 1024;

const OAUTH_CODE_MAX_LENGTH = 4_096;
const OAUTH_ACCESS_TOKEN_MAX_LENGTH = 16_384;
const OAUTH_OPEN_ID_MAX_LENGTH = 255;
const OAUTH_UNION_ID_MAX_LENGTH = 255;
const OAUTH_DISPLAY_NAME_MAX_LENGTH = 200;
const OAUTH_AVATAR_URL_MAX_LENGTH = 2_048;
const OAUTH_EMAIL_MAX_LENGTH = 254;

type OAuthFetchErrorCode =
  | "OAUTH_TOKEN_EXCHANGE_FAILED"
  | "OAUTH_PROFILE_INVALID";

const providerFetchTimeouts = new WeakMap<
  Response,
  ReturnType<typeof setTimeout>
>();

async function readBoundedText(
  response: Response,
  errorCode: OAuthFetchErrorCode,
): Promise<string> {
  try {
    const declaredLength = Number(response.headers.get("content-length"));
    if (
      Number.isFinite(declaredLength)
      && declaredLength > OAUTH_PROVIDER_RESPONSE_MAX_BYTES
    ) {
      throw new Error(errorCode);
    }

    if (!response.body) {
      const text = await response.text();
      if (new TextEncoder().encode(text).byteLength > OAUTH_PROVIDER_RESPONSE_MAX_BYTES) {
        throw new Error(errorCode);
      }
      return text;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let totalBytes = 0;
    let text = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > OAUTH_PROVIDER_RESPONSE_MAX_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new Error(errorCode);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch {
    throw new Error(errorCode);
  } finally {
    const timeout = providerFetchTimeouts.get(response);
    if (timeout) clearTimeout(timeout);
    providerFetchTimeouts.delete(response);
  }
}

async function readJson(
  response: Response,
  errorCode: OAuthFetchErrorCode,
): Promise<any> {
  const text = await readBoundedText(response, errorCode);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(errorCode);
  }
}

async function fetchOAuthProvider(
  url: string,
  init: RequestInit,
  errorCode: OAuthFetchErrorCode,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    OAUTH_PROVIDER_FETCH_TIMEOUT_MS,
  );
  try {
    const response = await fetch(url, {
      ...init,
      redirect: "error",
      signal: controller.signal,
    });
    providerFetchTimeouts.set(response, timeout);
    return response;
  } catch {
    clearTimeout(timeout);
    throw new Error(errorCode);
  }
}

function scalarString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function requireString(
  value: unknown,
  code: OAuthFetchErrorCode | "OAUTH_CODE_MISSING",
  maxLength: number,
): string {
  const text = scalarString(value);
  if (!text) throw new Error(code);
  if (text.length > maxLength) throw new Error(code);
  return text;
}

function optionalString(
  value: unknown,
  errorCode: OAuthFetchErrorCode,
  maxLength: number,
): string | null {
  if (value === undefined || value === null || value === "") return null;
  const text = scalarString(value);
  if (!text || text.length > maxLength) throw new Error(errorCode);
  return text;
}

function optionalAvatarUrl(
  value: unknown,
  errorCode: OAuthFetchErrorCode,
): string | null {
  const text = optionalString(value, errorCode, OAUTH_AVATAR_URL_MAX_LENGTH);
  if (!text) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error(errorCode);
    }
    return text;
  } catch {
    throw new Error(errorCode);
  }
}

function normalizeVerifiedEmail(
  value: unknown,
  verified: unknown,
): string | null {
  if (verified !== true || typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (!email || email.length > OAUTH_EMAIL_MAX_LENGTH) return null;
  const atIndex = email.indexOf("@");
  if (
    atIndex < 1
    || atIndex !== email.lastIndexOf("@")
    || atIndex > 64
  ) {
    return null;
  }
  const local = email.slice(0, atIndex);
  const domainLabels = email.slice(atIndex + 1).split(".");
  if (
    local.startsWith(".")
    || local.endsWith(".")
    || local.includes("..")
    || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)
    || domainLabels.length < 2
    || domainLabels.some((label) => (
      !label
      || label.length > 63
      || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
    ))
  ) {
    return null;
  }
  return email;
}

export function buildAuthorizeUrl(input: {
  config: OAuthProviderConfig;
  publicBaseUrl: string;
  state: string;
  codeChallenge?: string | null;
}): string {
  const redirectUri = buildOAuthCallbackUrl(input.publicBaseUrl, input.config.id);
  const state = input.state;
  switch (input.config.id) {
    case "douyin": {
      const url = new URL("https://open.douyin.com/platform/oauth/connect/");
      url.searchParams.set("client_key", input.config.clientId);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", "user_info");
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("state", state);
      return url.toString();
    }
    case "wechat": {
      const url = new URL("https://open.weixin.qq.com/connect/qrconnect");
      url.searchParams.set("appid", input.config.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", "snsapi_login");
      url.searchParams.set("state", state);
      return `${url.toString()}#wechat_redirect`;
    }
    case "google": {
      const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      url.searchParams.set("client_id", input.config.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", "openid email profile");
      url.searchParams.set("state", state);
      url.searchParams.set("access_type", "online");
      url.searchParams.set("prompt", "select_account");
      if (input.codeChallenge) {
        url.searchParams.set("code_challenge", input.codeChallenge);
        url.searchParams.set("code_challenge_method", "S256");
      }
      return url.toString();
    }
    case "github": {
      const url = new URL("https://github.com/login/oauth/authorize");
      url.searchParams.set("client_id", input.config.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("scope", "read:user user:email");
      url.searchParams.set("state", state);
      if (input.codeChallenge) {
        url.searchParams.set("code_challenge", input.codeChallenge);
        url.searchParams.set("code_challenge_method", "S256");
      }
      return url.toString();
    }
    default:
      throw new Error("UNSUPPORTED_OAUTH_PROVIDER");
  }
}

async function exchangeDouyin(
  config: OAuthProviderConfig,
  code: string,
): Promise<OAuthProfile> {
  const tokenUrl = new URL("https://open.douyin.com/oauth/access_token/");
  tokenUrl.searchParams.set("client_key", config.clientId);
  tokenUrl.searchParams.set("client_secret", config.clientSecret);
  tokenUrl.searchParams.set("code", code);
  tokenUrl.searchParams.set("grant_type", "authorization_code");
  const tokenRes = await fetchOAuthProvider(
    tokenUrl.toString(),
    { method: "GET" },
    "OAUTH_TOKEN_EXCHANGE_FAILED",
  );
  const tokenJson = await readJson(tokenRes, "OAUTH_TOKEN_EXCHANGE_FAILED");
  const tokenData = tokenJson?.data || tokenJson;
  if (!tokenRes.ok || Number(tokenData?.error_code || tokenJson?.error_code || 0) !== 0) {
    throw new Error("OAUTH_TOKEN_EXCHANGE_FAILED");
  }
  const accessToken = requireString(
    tokenData.access_token,
    "OAUTH_TOKEN_EXCHANGE_FAILED",
    OAUTH_ACCESS_TOKEN_MAX_LENGTH,
  );
  const openId = requireString(
    tokenData.open_id,
    "OAUTH_PROFILE_INVALID",
    OAUTH_OPEN_ID_MAX_LENGTH,
  );

  const userUrl = new URL("https://open.douyin.com/oauth/userinfo/");
  userUrl.searchParams.set("access_token", accessToken);
  userUrl.searchParams.set("open_id", openId);
  const userRes = await fetchOAuthProvider(
    userUrl.toString(),
    { method: "GET" },
    "OAUTH_PROFILE_INVALID",
  );
  const userJson = await readJson(userRes, "OAUTH_PROFILE_INVALID");
  const userData = userJson?.data || userJson;
  if (
    !userRes.ok
    || Number(userData?.error_code || userJson?.error_code || 0) !== 0
  ) {
    throw new Error("OAUTH_PROFILE_INVALID");
  }
  return {
    openId,
    unionId: optionalString(
      userData?.union_id,
      "OAUTH_PROFILE_INVALID",
      OAUTH_UNION_ID_MAX_LENGTH,
    ),
    displayName: optionalString(
      userData?.nickname,
      "OAUTH_PROFILE_INVALID",
      OAUTH_DISPLAY_NAME_MAX_LENGTH,
    ),
    avatarUrl: optionalAvatarUrl(userData?.avatar, "OAUTH_PROFILE_INVALID"),
    raw: null,
  };
}

async function exchangeWechat(config: OAuthProviderConfig, code: string): Promise<OAuthProfile> {
  const tokenUrl = new URL("https://api.weixin.qq.com/sns/oauth2/access_token");
  tokenUrl.searchParams.set("appid", config.clientId);
  tokenUrl.searchParams.set("secret", config.clientSecret);
  tokenUrl.searchParams.set("code", code);
  tokenUrl.searchParams.set("grant_type", "authorization_code");
  const tokenRes = await fetchOAuthProvider(
    tokenUrl.toString(),
    { method: "GET" },
    "OAUTH_TOKEN_EXCHANGE_FAILED",
  );
  const tokenJson = await readJson(tokenRes, "OAUTH_TOKEN_EXCHANGE_FAILED");
  if (!tokenRes.ok || tokenJson?.errcode) throw new Error("OAUTH_TOKEN_EXCHANGE_FAILED");
  const accessToken = requireString(
    tokenJson.access_token,
    "OAUTH_TOKEN_EXCHANGE_FAILED",
    OAUTH_ACCESS_TOKEN_MAX_LENGTH,
  );
  const openId = requireString(
    tokenJson.openid,
    "OAUTH_PROFILE_INVALID",
    OAUTH_OPEN_ID_MAX_LENGTH,
  );

  const userUrl = new URL("https://api.weixin.qq.com/sns/userinfo");
  userUrl.searchParams.set("access_token", accessToken);
  userUrl.searchParams.set("openid", openId);
  userUrl.searchParams.set("lang", "zh_CN");
  const userRes = await fetchOAuthProvider(
    userUrl.toString(),
    { method: "GET" },
    "OAUTH_PROFILE_INVALID",
  );
  const userJson = await readJson(userRes, "OAUTH_PROFILE_INVALID");
  if (!userRes.ok || userJson?.errcode) throw new Error("OAUTH_PROFILE_INVALID");
  return {
    openId,
    unionId: optionalString(
      userJson.unionid ?? tokenJson.unionid,
      "OAUTH_PROFILE_INVALID",
      OAUTH_UNION_ID_MAX_LENGTH,
    ),
    displayName: optionalString(
      userJson.nickname,
      "OAUTH_PROFILE_INVALID",
      OAUTH_DISPLAY_NAME_MAX_LENGTH,
    ),
    avatarUrl: optionalAvatarUrl(userJson.headimgurl, "OAUTH_PROFILE_INVALID"),
    raw: null,
  };
}

async function exchangeGoogle(
  config: OAuthProviderConfig,
  code: string,
  publicBaseUrl: string,
  codeVerifier?: string | null,
): Promise<OAuthProfile> {
  const redirectUri = buildOAuthCallbackUrl(publicBaseUrl, "google");
  const body = new URLSearchParams({
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
    ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
  });
  const tokenRes = await fetchOAuthProvider(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    },
    "OAUTH_TOKEN_EXCHANGE_FAILED",
  );
  const tokenJson = await readJson(tokenRes, "OAUTH_TOKEN_EXCHANGE_FAILED");
  if (!tokenRes.ok || !tokenJson.access_token) throw new Error("OAUTH_TOKEN_EXCHANGE_FAILED");
  const accessToken = requireString(
    tokenJson.access_token,
    "OAUTH_TOKEN_EXCHANGE_FAILED",
    OAUTH_ACCESS_TOKEN_MAX_LENGTH,
  );
  const userRes = await fetchOAuthProvider(
    "https://openidconnect.googleapis.com/v1/userinfo",
    { headers: { Authorization: `Bearer ${accessToken}` } },
    "OAUTH_PROFILE_INVALID",
  );
  const userJson = await readJson(userRes, "OAUTH_PROFILE_INVALID");
  if (!userRes.ok) throw new Error("OAUTH_PROFILE_INVALID");
  const email = normalizeVerifiedEmail(
    userJson.email,
    userJson.email_verified,
  );
  return {
    openId: requireString(
      userJson.sub,
      "OAUTH_PROFILE_INVALID",
      OAUTH_OPEN_ID_MAX_LENGTH,
    ),
    displayName: optionalString(
      userJson.name ?? userJson.given_name,
      "OAUTH_PROFILE_INVALID",
      OAUTH_DISPLAY_NAME_MAX_LENGTH,
    ),
    avatarUrl: optionalAvatarUrl(userJson.picture, "OAUTH_PROFILE_INVALID"),
    email,
    emailVerified: Boolean(email),
    raw: null,
  };
}

async function exchangeGithub(
  config: OAuthProviderConfig,
  code: string,
  publicBaseUrl: string,
  codeVerifier?: string | null,
): Promise<OAuthProfile> {
  const redirectUri = buildOAuthCallbackUrl(publicBaseUrl, "github");
  const tokenRes = await fetchOAuthProvider(
    "https://github.com/login/oauth/access_token",
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: redirectUri,
        ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
      }),
    },
    "OAUTH_TOKEN_EXCHANGE_FAILED",
  );
  const tokenJson = await readJson(tokenRes, "OAUTH_TOKEN_EXCHANGE_FAILED");
  if (!tokenRes.ok || !tokenJson.access_token) throw new Error("OAUTH_TOKEN_EXCHANGE_FAILED");
  const accessToken = requireString(
    tokenJson.access_token,
    "OAUTH_TOKEN_EXCHANGE_FAILED",
    OAUTH_ACCESS_TOKEN_MAX_LENGTH,
  );
  const userRes = await fetchOAuthProvider(
    "https://api.github.com/user",
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "fanjin-oauth",
      },
    },
    "OAUTH_PROFILE_INVALID",
  );
  const userJson = await readJson(userRes, "OAUTH_PROFILE_INVALID");
  if (!userRes.ok) throw new Error("OAUTH_PROFILE_INVALID");

  // GitHub's /user email field does not carry a verification assertion.
  // Treat only /user/emails rows with verified === true as recovery-capable
  // addresses; a public/unverified email claim is deliberately discarded.
  let email: string | null = null;
  let emailVerified = false;
  let emailsRes: Response | null = null;
  try {
    emailsRes = await fetchOAuthProvider(
      "https://api.github.com/user/emails",
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${accessToken}`,
          "User-Agent": "fanjin-oauth",
        },
      },
      "OAUTH_PROFILE_INVALID",
    );
  } catch {
    emailsRes = null;
  }
  if (emailsRes) {
    const emails = await readJson(emailsRes, "OAUTH_PROFILE_INVALID");
    if (emailsRes.ok && Array.isArray(emails)) {
      const verified = emails.filter((item) => item?.verified === true);
      const selected = verified.find((item) => item?.primary === true)
        || verified[0];
      if (selected?.email) {
        if (
          typeof selected.email !== "string"
          || selected.email.trim().length > OAUTH_EMAIL_MAX_LENGTH
        ) {
          throw new Error("OAUTH_PROFILE_INVALID");
        }
        email = normalizeVerifiedEmail(selected.email, selected.verified);
        emailVerified = Boolean(email);
      }
    }
  }

  return {
    openId: requireString(
      userJson.id,
      "OAUTH_PROFILE_INVALID",
      OAUTH_OPEN_ID_MAX_LENGTH,
    ),
    displayName: optionalString(
      userJson.name ?? userJson.login,
      "OAUTH_PROFILE_INVALID",
      OAUTH_DISPLAY_NAME_MAX_LENGTH,
    ),
    avatarUrl: optionalAvatarUrl(userJson.avatar_url, "OAUTH_PROFILE_INVALID"),
    email,
    emailVerified,
    raw: null,
  };
}

export async function exchangeOAuthCode(input: {
  config: OAuthProviderConfig;
  code: string;
  publicBaseUrl: string;
  codeVerifier?: string | null;
}): Promise<OAuthProfile> {
  const code = requireString(
    input.code,
    "OAUTH_CODE_MISSING",
    OAUTH_CODE_MAX_LENGTH,
  );
  if (
    input.codeVerifier
    && scalarString(input.codeVerifier).length > 256
  ) {
    throw new Error("OAUTH_TOKEN_EXCHANGE_FAILED");
  }
  switch (input.config.id as OAuthProviderId) {
    case "douyin":
      return exchangeDouyin(input.config, code);
    case "wechat":
      return exchangeWechat(input.config, code);
    case "google":
      return exchangeGoogle(input.config, code, input.publicBaseUrl, input.codeVerifier);
    case "github":
      return exchangeGithub(input.config, code, input.publicBaseUrl, input.codeVerifier);
    default:
      throw new Error("UNSUPPORTED_OAUTH_PROVIDER");
  }
}
