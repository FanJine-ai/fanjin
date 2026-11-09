import { useEffect, useMemo, useRef, useState } from "react";
import { KeyRound, Link2, Save } from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  FormField,
  Input,
  Switch,
  useToast,
} from "../../../ui/console";
import { updatePlatformSettings } from "./api";
import type { PlatformSettingItem, PlatformSettingValue } from "./types";

type OAuthProviderId = "douyin" | "wechat" | "google" | "github";

interface OAuthProviderMeta {
  id: OAuthProviderId;
  name: string;
  enabledKey: string;
  clientIdKey: string;
  clientSecretKey: string;
  clientIdLabel: string;
  clientSecretLabel: string;
  note?: string;
}

const OAUTH_PROVIDERS: OAuthProviderMeta[] = [
  {
    id: "douyin",
    name: "抖音登录",
    enabledKey: "platform.auth.douyinLoginEnabled",
    clientIdKey: "platform.auth.douyinClientKey",
    clientSecretKey: "platform.auth.douyinClientSecret",
    clientIdLabel: "Client Key",
    clientSecretLabel: "Client Secret",
  },
  {
    id: "wechat",
    name: "微信扫码登录",
    enabledKey: "platform.auth.wechatLoginEnabled",
    clientIdKey: "platform.auth.wechatAppId",
    clientSecretKey: "platform.auth.wechatAppSecret",
    clientIdLabel: "AppID",
    clientSecretLabel: "AppSecret",
    note: "微信开放平台「网站应用」的授权回调域需配置为站点域名（只填域名，不带路径与协议）。",
  },
  {
    id: "google",
    name: "Google 登录",
    enabledKey: "platform.auth.googleLoginEnabled",
    clientIdKey: "platform.auth.googleClientId",
    clientSecretKey: "platform.auth.googleClientSecret",
    clientIdLabel: "Client ID",
    clientSecretLabel: "Client Secret",
  },
  {
    id: "github",
    name: "GitHub 登录",
    enabledKey: "platform.auth.githubLoginEnabled",
    clientIdKey: "platform.auth.githubClientId",
    clientSecretKey: "platform.auth.githubClientSecret",
    clientIdLabel: "Client ID",
    clientSecretLabel: "Client Secret",
  },
];

interface ProviderServerState {
  enabled: boolean;
  clientId: string;
  secretConfigured: boolean;
}

interface ProviderDraft {
  enabled: boolean;
  clientId: string;
  secret: string;
}

interface OAuthProviderSettingsProps {
  items: PlatformSettingItem[];
  disabled?: boolean;
  onSaved: () => Promise<unknown> | void;
}

export function OAuthProviderSettings({ items, disabled = false, onSaved }: OAuthProviderSettingsProps) {
  const { toast } = useToast();
  const itemMap = useMemo(() => new Map(items.map((item) => [item.key, item])), [items]);

  const serverState = useMemo(() => {
    const state = {} as Record<OAuthProviderId, ProviderServerState>;
    for (const meta of OAUTH_PROVIDERS) {
      state[meta.id] = {
        enabled: Boolean(itemMap.get(meta.enabledKey)?.value),
        clientId: String(itemMap.get(meta.clientIdKey)?.value ?? ""),
        secretConfigured: Boolean(itemMap.get(meta.clientSecretKey)?.configured),
      };
    }
    return state;
  }, [itemMap]);

  const serverAddressItem = itemMap.get("platform.site.serverAddress");
  const configuredBase = String(serverAddressItem?.value ?? "").trim().replace(/\/+$/, "");
  const publicBase = configuredBase
    || (typeof window !== "undefined" ? window.location.origin : "");
  const baseIsFallback = !configuredBase;

  const emptyDrafts = () => {
    const drafts = {} as Record<OAuthProviderId, ProviderDraft>;
    for (const meta of OAUTH_PROVIDERS) {
      const server = serverState[meta.id];
      drafts[meta.id] = { enabled: server.enabled, clientId: server.clientId, secret: "" };
    }
    return drafts;
  };

  const [drafts, setDrafts] = useState<Record<OAuthProviderId, ProviderDraft>>(emptyDrafts);
  const [savingId, setSavingId] = useState<OAuthProviderId | null>(null);
  const [errors, setErrors] = useState<Partial<Record<OAuthProviderId, string>>>({});
  const savingRef = useRef(false);

  useEffect(() => {
    if (!savingRef.current) setDrafts(emptyDrafts());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverState]);

  const patchDraft = (id: OAuthProviderId, patch: Partial<ProviderDraft>) => {
    setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  };

  const saveProvider = async (meta: OAuthProviderMeta) => {
    if (savingRef.current) return;
    const draft = drafts[meta.id];
    const server = serverState[meta.id];
    const payload: Record<string, PlatformSettingValue> = {};
    if (draft.enabled !== server.enabled) payload[meta.enabledKey] = draft.enabled;
    if (draft.clientId.trim() !== server.clientId) payload[meta.clientIdKey] = draft.clientId.trim();
    // secret 类型键：只有输入了新值才提交，服务端走 seal 加密存储，不回显。
    if (draft.secret.trim()) payload[meta.clientSecretKey] = draft.secret.trim();
    if (Object.keys(payload).length === 0) return;

    savingRef.current = true;
    setSavingId(meta.id);
    setErrors((prev) => ({ ...prev, [meta.id]: "" }));
    try {
      await updatePlatformSettings(payload);
      toast({ title: `${meta.name}设置已保存`, message: "第三方登录配置即时生效。", tone: "success" });
      await onSaved();
    } catch (caught) {
      setErrors((prev) => ({
        ...prev,
        [meta.id]: caught instanceof Error ? caught.message : "设置保存失败",
      }));
    } finally {
      savingRef.current = false;
      setSavingId(null);
    }
  };

  return (
    <section className="settingsOAuth" aria-label="第三方登录">
      <header className="settingsOAuthHeader">
        <div className="settingsOAuthTitle">
          <span className="settingsOAuthTitleIcon"><KeyRound aria-hidden="true" size={15} /></span>
          <div>
            <h3>第三方登录</h3>
            <p>开启并配齐凭证后，登录页才会显示对应入口；Secret 加密存储，保存后不回显。</p>
          </div>
        </div>
        <Badge tone={OAUTH_PROVIDERS.some((meta) => serverState[meta.id].enabled) ? "success" : "neutral"}>
          {OAUTH_PROVIDERS.filter((meta) => serverState[meta.id].enabled).length} / {OAUTH_PROVIDERS.length} 已启用
        </Badge>
      </header>

      {baseIsFallback && (
        <Alert tone="warning" title="服务地址未配置">
          回调 URL 当前按本机地址预览。请先在「站点与合规」配置 platform.site.serverAddress 为生产 HTTPS 域名。
        </Alert>
      )}

      <div className="settingsOAuthGrid">
        {OAUTH_PROVIDERS.map((meta) => {
          const server = serverState[meta.id];
          const draft = drafts[meta.id];
          const dirty = draft.enabled !== server.enabled
            || draft.clientId.trim() !== server.clientId
            || Boolean(draft.secret.trim());
          const callbackUrl = `${publicBase}/api/auth/oauth/${meta.id}/callback`;
          const saving = savingId === meta.id;
          const ready = server.clientId.trim() && server.secretConfigured;
          return (
            <article key={meta.id} className="settingsOAuthCard" data-provider={meta.id}>
              <header className="settingsOAuthCardHeader">
                <strong>{meta.name}</strong>
                <Badge tone={server.enabled && ready ? "success" : server.enabled ? "warning" : "neutral"}>
                  {server.enabled ? (ready ? "已启用" : "待配齐凭证") : "未启用"}
                </Badge>
              </header>

              <Switch
                checked={draft.enabled}
                disabled={disabled || saving}
                onCheckedChange={(checked) => patchDraft(meta.id, { enabled: checked })}
                label={`启用${meta.name}`}
                description="开启且 Client 凭证配齐后，登录页显示该入口。"
              />

              <FormField label={meta.clientIdLabel} help={`${meta.name}开放平台应用标识，明文保存并回显。`}>
                <Input
                  value={draft.clientId}
                  disabled={disabled || saving}
                  placeholder={`请输入${meta.clientIdLabel}`}
                  autoComplete="off"
                  onChange={(event) => patchDraft(meta.id, { clientId: event.currentTarget.value })}
                />
              </FormField>

              <FormField
                label={meta.clientSecretLabel}
                help="已保存值不会回显；只有输入新值并保存时才会替换。"
              >
                <Input
                  type="password"
                  value={draft.secret}
                  disabled={disabled || saving}
                  placeholder={server.secretConfigured ? "已配置，输入新值以替换" : "尚未配置"}
                  autoComplete="new-password"
                  onChange={(event) => patchDraft(meta.id, { secret: event.currentTarget.value })}
                />
              </FormField>
              <div className="settingsOAuthSecretState">
                <Badge
                  icon={<KeyRound size={13} />}
                  tone={server.secretConfigured ? "success" : "neutral"}
                >
                  {server.secretConfigured ? "已配置" : "未配置"}
                </Badge>
              </div>

              <div className="settingsOAuthCallback">
                <span className="settingsOAuthCallbackLabel">
                  <Link2 aria-hidden="true" size={13} />回调 URL（只读）
                </span>
                <code>{callbackUrl}</code>
                {meta.note && <p className="settingsOAuthCallbackNote">{meta.note}</p>}
              </div>

              {errors[meta.id] && <Alert tone="danger" title="设置保存失败">{errors[meta.id]}</Alert>}

              <footer className="settingsOAuthCardFooter">
                <span className="settingsOAuthDirtyState" role="status">
                  {dirty ? "有未保存修改" : "与线上配置一致"}
                </span>
                <Button
                  size="compact"
                  icon={<Save aria-hidden="true" size={14} />}
                  loading={saving}
                  disabled={disabled || !dirty || Boolean(savingId)}
                  onClick={() => void saveProvider(meta)}
                >
                  保存
                </Button>
              </footer>
            </article>
          );
        })}
      </div>
    </section>
  );
}
