export const OAUTH_PROVIDERS = ["douyin", "wechat", "google", "github"] as const;

export type OAuthProviderId = (typeof OAUTH_PROVIDERS)[number];

export interface OAuthProviderPublic {
  id: OAuthProviderId;
  label: string;
  enabled: boolean;
  callbackPath: string;
}

export interface OAuthProviderConfig {
  id: OAuthProviderId;
  label: string;
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  callbackPath: string;
}

export interface OAuthProfile {
  openId: string;
  unionId?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
  email?: string | null;
  emailVerified?: boolean;
  raw?: unknown;
}

export interface OAuthIdentityRow {
  id: string;
  userId: number;
  provider: OAuthProviderId;
  openId: string;
  unionId?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
  rawProfile?: string | null;
  createdAt: number;
  updatedAt: number;
}

export function isOAuthProviderId(value: unknown): value is OAuthProviderId {
  return typeof value === "string" && (OAUTH_PROVIDERS as readonly string[]).includes(value);
}

export function providerLabel(id: OAuthProviderId): string {
  switch (id) {
    case "douyin":
      return "抖音";
    case "wechat":
      return "微信";
    case "google":
      return "Google";
    case "github":
      return "GitHub";
    default:
      return id;
  }
}

export function providerUsernamePrefix(id: OAuthProviderId): string {
  switch (id) {
    case "douyin":
      return "dy_";
    case "wechat":
      return "wx_";
    case "google":
      return "gg_";
    case "github":
      return "gh_";
    default:
      return "oa_";
  }
}
