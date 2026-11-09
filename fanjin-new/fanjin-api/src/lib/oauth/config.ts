import {
  getBooleanPlatformSetting,
  getPlatformSecretValue,
  getPlatformSettingValue,
} from "@/lib/platformSettings";
import { resolvePasswordResetPublicBaseUrl } from "@/lib/passwordResetConfig";
import {
  isOAuthProviderId,
  providerLabel,
  type OAuthProviderConfig,
  type OAuthProviderId,
  type OAuthProviderPublic,
  OAUTH_PROVIDERS,
} from "@/lib/oauth/types";

const PROVIDER_KEYS: Record<
  OAuthProviderId,
  { enabled: string; clientId: string; clientSecret: string }
> = {
  douyin: {
    enabled: "platform.auth.douyinLoginEnabled",
    clientId: "platform.auth.douyinClientKey",
    clientSecret: "platform.auth.douyinClientSecret",
  },
  wechat: {
    enabled: "platform.auth.wechatLoginEnabled",
    clientId: "platform.auth.wechatAppId",
    clientSecret: "platform.auth.wechatAppSecret",
  },
  google: {
    enabled: "platform.auth.googleLoginEnabled",
    clientId: "platform.auth.googleClientId",
    clientSecret: "platform.auth.googleClientSecret",
  },
  github: {
    enabled: "platform.auth.githubLoginEnabled",
    clientId: "platform.auth.githubClientId",
    clientSecret: "platform.auth.githubClientSecret",
  },
};

export function oauthCallbackPath(provider: OAuthProviderId): string {
  return `/api/auth/oauth/${provider}/callback`;
}

export function resolveOAuthPublicBaseUrl(reqOrigin?: string | null): string | null {
  const configured = resolvePasswordResetPublicBaseUrl();
  if (configured) return configured;
  const origin = String(reqOrigin || "").trim().replace(/\/+$/, "");
  if (!origin) return null;
  try {
    const url = new URL(origin);
    if (!/^https?:$/.test(url.protocol)) return null;
    return origin;
  } catch {
    return null;
  }
}

export async function loadOAuthProviderConfig(provider: OAuthProviderId): Promise<OAuthProviderConfig> {
  const keys = PROVIDER_KEYS[provider];
  const enabled = await getBooleanPlatformSetting(keys.enabled, false);
  const clientId = String((await getPlatformSettingValue(keys.clientId)) || "").trim();
  const clientSecret = String((await getPlatformSecretValue(keys.clientSecret)) || "").trim();
  return {
    id: provider,
    label: providerLabel(provider),
    enabled: enabled && Boolean(clientId) && Boolean(clientSecret),
    clientId,
    clientSecret,
    callbackPath: oauthCallbackPath(provider),
  };
}

export async function listEnabledOAuthProviders(): Promise<OAuthProviderPublic[]> {
  const providers: OAuthProviderPublic[] = [];
  for (const id of OAUTH_PROVIDERS) {
    const config = await loadOAuthProviderConfig(id);
    if (!config.enabled) continue;
    providers.push({
      id: config.id,
      label: config.label,
      enabled: true,
      callbackPath: config.callbackPath,
    });
  }
  return providers;
}

export async function requireEnabledOAuthProvider(providerRaw: string): Promise<OAuthProviderConfig> {
  if (!isOAuthProviderId(providerRaw)) {
    throw new Error("UNSUPPORTED_OAUTH_PROVIDER");
  }
  const config = await loadOAuthProviderConfig(providerRaw);
  if (!config.enabled) {
    throw new Error("OAUTH_PROVIDER_DISABLED");
  }
  return config;
}

export function buildOAuthCallbackUrl(publicBaseUrl: string, provider: OAuthProviderId): string {
  return `${publicBaseUrl.replace(/\/+$/, "")}${oauthCallbackPath(provider)}`;
}

export const DEFAULT_POST_LOGIN_REDIRECT = "/workbench/create";

export function sanitizeFrontendRedirect(value: unknown, fallback = DEFAULT_POST_LOGIN_REDIRECT): string {
  const raw = String(value || "").trim();
  if (!raw) return fallback;
  if (!raw.startsWith("/") || raw.startsWith("//")) return fallback;
  const [pathname, search = ""] = raw.split("?", 2);
  if (pathname === "/auth/register" && new URLSearchParams(search).get("invite")?.trim()) return raw;
  if (raw === "/login" || raw.startsWith("/auth/")) return fallback;
  return raw;
}
