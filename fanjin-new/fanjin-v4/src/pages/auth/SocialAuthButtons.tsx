import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { SiGithub, SiGoogle, SiTiktok, SiWechat } from "react-icons/si";
import type { IconType } from "react-icons";
import { apiGet } from "../../api/http";
import { readApiSettings } from "../../api/http";
import { useToast } from "../../ui/console/feedback";
import { DEFAULT_POST_LOGIN_REDIRECT } from "./postLoginRedirect";

type SocialProvider = "wechat" | "douyin" | "google" | "github";
type SocialMode = "login" | "register";

interface SocialAuthButtonsProps {
  mode?: SocialMode;
  variant?: "dialog";
  redirectTo?: string;
  beforeAuth?: () => boolean;
}

interface ProviderInfo {
  id: SocialProvider;
  label: string;
  enabled: boolean;
}

const providerMeta: Record<
  SocialProvider,
  {
    label: string;
    Icon: IconType;
    iconColor: string;
    iconFilter?: string;
  }
> = {
  wechat: {
    label: "微信登录",
    Icon: SiWechat,
    iconColor: "#07C160",
  },
  douyin: {
    label: "抖音登录",
    Icon: SiTiktok,
    iconColor: "var(--auth-text, #f8fafc)",
    iconFilter: "drop-shadow(-1px 0 0 #25F4EE) drop-shadow(1px 0 0 #FE2C55)",
  },
  google: {
    label: "Google 登录",
    Icon: SiGoogle,
    iconColor: "#EA4335",
  },
  github: {
    label: "GitHub 登录",
    Icon: SiGithub,
    iconColor: "var(--auth-text, #f8fafc)",
  },
};

export default function SocialAuthButtons({ mode = "login", variant, redirectTo, beforeAuth }: SocialAuthButtonsProps) {
  const [searchParams] = useSearchParams();
  const { toast } = useToast();
  const [providers, setProviders] = useState<SocialProvider[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await apiGet<{ providers?: ProviderInfo[] }>("/auth/oauth/providers");
        if (cancelled) return;
        const enabled = (data?.providers || [])
          .filter((item) => item?.enabled && item.id in providerMeta)
          .map((item) => item.id as SocialProvider);
        setProviders(enabled);
      } catch {
        if (!cancelled) setProviders([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const resolveOAuthUrl = useCallback(
    (provider: SocialProvider) => {
      const { baseUrl } = readApiSettings();
      const apiOrigin = baseUrl.replace(/\/api\/?$/, "");
      const url = new URL(`/api/auth/oauth/${provider}/authorize`, apiOrigin || window.location.origin);
      const redirect = redirectTo || searchParams.get("redirect") || DEFAULT_POST_LOGIN_REDIRECT;
      url.searchParams.set("mode", mode);
      url.searchParams.set("redirect", redirect);
      url.searchParams.set(
        "returnTo",
        `${window.location.origin}${window.location.pathname}${window.location.search}#${DEFAULT_POST_LOGIN_REDIRECT}`,
      );
      return url.toString();
    },
    [mode, searchParams, redirectTo],
  );

  const handleSocialAuth = (provider: SocialProvider) => {
    if (beforeAuth && !beforeAuth()) return;
    try {
      window.location.assign(resolveOAuthUrl(provider));
    } catch (error) {
      console.error("[social-auth] redirect failed", error);
      toast({ title: "第三方登录暂时不可用", message: "请稍后再试", tone: "danger" });
    }
  };

  if (loading || providers.length === 0) return null;

  return (
    <div className={variant === "dialog" ? "loginSocial" : undefined} style={{ marginTop: 20 }} aria-label="第三方登录">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginBottom: 14,
          color: "var(--auth-muted, rgba(203,213,225,0.48))",
          fontSize: 12,
          lineHeight: 1,
        }}
      >
        <span style={{ flex: 1, height: 1, background: "linear-gradient(90deg, transparent, rgba(226,232,240,0.18))" }} />
        <span>或使用以下方式继续</span>
        <span style={{ flex: 1, height: 1, background: "linear-gradient(90deg, rgba(226,232,240,0.18), transparent)" }} />
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: providers.length === 1 ? "1fr" : "repeat(2, minmax(0, 1fr))",
          gap: 10,
        }}
      >
        {providers.map((id) => {
          const p = providerMeta[id];
          return (
            <button
              key={id}
              type="button"
              aria-label={p.label}
              onClick={() => handleSocialAuth(id)}
              style={{
                minHeight: 46,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 10,
                border: "1px solid var(--auth-line, rgba(226,232,240,0.16))",
                borderRadius: 14,
                color: "var(--auth-text, rgba(248,250,252,0.84))",
                background: "var(--auth-input, rgba(255,255,255,0.06))",
                cursor: "pointer",
                fontSize: 14,
                fontWeight: 800,
              }}
            >
              <span
                data-brand={id}
                style={{
                  width: 26,
                  height: 26,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
                aria-hidden="true"
              >
                <p.Icon
                  size={22}
                  color={p.iconColor}
                  style={{ display: "block", filter: p.iconFilter }}
                />
              </span>
              <span>{p.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
