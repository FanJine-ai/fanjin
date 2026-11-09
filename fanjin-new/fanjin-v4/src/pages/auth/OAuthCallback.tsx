import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import AuthShell from "./AuthShell";
import { ApiError, readApiSettings } from "../../api/http";
import { useAuthStore } from "../../stores/authStore";
import { useToast } from "../../ui/console/feedback";
import { resolvePostLoginRedirect } from "./postLoginRedirect";
import { exchangeTenantTransfer } from "../../api/auth";

interface OAuthExchangeErrorDetails {
  code?: string;
  challenge?: string;
  expiresAt?: number;
}

class OAuthExchangeError extends ApiError {
  details: OAuthExchangeErrorDetails;

  constructor(
    message: string,
    input: {
      status: number;
      details: OAuthExchangeErrorDetails;
    },
  ) {
    super(message, {
      status: input.status,
      code: input.details.code,
    });
    this.details = input.details;
  }
}

async function postOAuthExchange<T>(
  path: string,
  payload: Record<string, unknown>,
): Promise<T> {
  const settings = readApiSettings();
  const response = await fetch(
    `${settings.baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`,
    {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  const body = await response.json().catch(() => ({}));
  const data = body?.data && typeof body.data === "object"
    ? body.data as OAuthExchangeErrorDetails
    : {};
  if (!response.ok) {
    throw new OAuthExchangeError(
      String(body?.message || "第三方登录失败"),
      {
        status: response.status,
        details: data,
      },
    );
  }
  return (body?.data ?? body) as T;
}

const inFlightOAuthExchanges = new Map<
  string,
  Promise<{ token?: string }>
>();

function exchangeOAuthSessionOnce(
  exchange: string,
): Promise<{ token?: string }> {
  const existing = inFlightOAuthExchanges.get(exchange);
  if (existing) return existing;
  const request = postOAuthExchange<{ token?: string }>(
    "/auth/oauth/exchange",
    { exchange },
  ).finally(() => {
    if (inFlightOAuthExchanges.get(exchange) === request) {
      inFlightOAuthExchanges.delete(exchange);
    }
  });
  inFlightOAuthExchanges.set(exchange, request);
  return request;
}

export default function OAuthCallbackPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const authStore = useAuthStore();
  const setAuthToken = authStore.setToken;
  const fetchCurrentSession = authStore.fetchMe;
  const { toast } = useToast();
  const exchange = useMemo(
    () => String(searchParams.get("exchange") || "").trim(),
    [searchParams],
  );
  const tenantCode = useMemo(
    () => String(searchParams.get("tenant_code") || "").trim(),
    [searchParams],
  );
  const bootstrapProof = useMemo(
    () => String(searchParams.get("bootstrapProof") || "").trim(),
    [searchParams],
  );
  const bootstrapProvider = useMemo(() => {
    const value = String(searchParams.get("provider") || "").trim();
    return ["douyin", "wechat", "google", "github"].includes(value)
      ? value
      : "";
  }, [searchParams]);
  const errorCode = searchParams.get("error") || "";
  const errorMessage = searchParams.get("message") || "";
  const redirect = resolvePostLoginRedirect(searchParams.get("redirect"));
  const [message, setMessage] = useState(
    bootstrapProof
      ? "第三方账号验证成功，正在返回安全设置…"
      : exchange
        ? "正在完成第三方登录…"
        : tenantCode
          ? "正在同步统一账号…"
        : "登录回调参数不完整",
  );
  const [mfaChallenge, setMfaChallenge] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [mfaBusy, setMfaBusy] = useState(false);

  async function acceptSession(session: { token?: string }, successMessage = "第三方账号已登录") {
    const bearer = String(session.token || "").trim();
    if (!bearer.startsWith("Bearer ")) {
      throw new Error("登录会话创建失败");
    }
    setAuthToken(bearer);
    await fetchCurrentSession();
    toast({ title: "登录成功", message: successMessage, tone: "success" });
    navigate(redirect, { replace: true });
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (errorCode || errorMessage) {
        const text = errorMessage || "第三方登录失败";
        setMessage(text);
        toast({ title: "第三方登录失败", message: text, tone: "danger" });
        navigate("/auth/login?reason=oauth-failed", { replace: true });
        return;
      }
      if (bootstrapProof) {
        const params = new URLSearchParams({
          oauthBootstrap: bootstrapProof,
          ...(bootstrapProvider ? { provider: bootstrapProvider } : {}),
        });
        navigate(`/settings/profile/basic?${params.toString()}`, {
          replace: true,
        });
        return;
      }
      if (tenantCode) {
        try {
          const session = await exchangeTenantTransfer(tenantCode);
          if (cancelled) return;
          await acceptSession(session, "账号已在当前入口安全同步");
        } catch (err: any) {
          if (cancelled) return;
          const text = err?.message || "统一账号同步失败，请重试";
          setMessage(text);
          toast({ title: "登录失败", message: text, tone: "danger" });
          navigate("/auth/login", { replace: true });
        }
        return;
      }
      if (!exchange) {
        setMessage("缺少登录交换码");
        navigate("/auth/login", { replace: true });
        return;
      }
      try {
        const session = await exchangeOAuthSessionOnce(exchange);
        if (cancelled) return;
        await acceptSession(session);
      } catch (err: any) {
        if (cancelled) return;
        if (
          err instanceof OAuthExchangeError
          && err.code === "MFA_REQUIRED"
          && String(err.details.challenge || "")
        ) {
          setMfaChallenge(String(err.details.challenge));
          setMessage("此账号已启用 MFA，请完成二次验证。");
          return;
        }
        const text = err?.message || "登录态写入失败，请重试";
        setMessage(text);
        toast({ title: "登录失败", message: text, tone: "danger" });
        navigate("/auth/login", { replace: true });
      }
    })();
    return () => {
      cancelled = true;
    };
    // acceptSession intentionally uses the current auth-store actions. Adding
    // the local function itself would retrigger and replay the one-time code.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    exchange,
    tenantCode,
    bootstrapProof,
    bootstrapProvider,
    errorCode,
    errorMessage,
    redirect,
    setAuthToken,
    fetchCurrentSession,
    navigate,
    toast,
  ]);

  async function submitMfa(event: FormEvent) {
    event.preventDefault();
    const credential = mfaCode.trim();
    if (!credential) {
      setMessage("请输入 MFA 验证码或恢复码");
      return;
    }
    setMfaBusy(true);
    setMessage("正在验证 MFA…");
    try {
      const session = await postOAuthExchange<{ token?: string }>(
        "/auth/oauth/exchange",
        {
          challenge: mfaChallenge,
          code: credential,
        },
      );
      await acceptSession(session);
    } catch (err: any) {
      const text = err?.message || "MFA 验证失败，请重新登录";
      setMessage(text);
      toast({ title: "MFA 验证失败", message: text, tone: "danger" });
      navigate("/auth/login?reason=oauth-mfa-failed", { replace: true });
    } finally {
      setMfaBusy(false);
    }
  }

  const inputStyle: React.CSSProperties = {
    width: "100%",
    minHeight: 48,
    padding: "0 14px",
    border: "1px solid var(--auth-border)",
    borderRadius: 14,
    color: "var(--auth-text)",
    background: "var(--auth-field)",
    fontSize: 14,
    outline: "none",
    boxSizing: "border-box",
  };

  return (
    <AuthShell
      title="第三方登录"
      subtitle={mfaChallenge ? "完成二次验证后继续" : "正在完成授权，请稍候…"}
    >
      {mfaChallenge ? (
        <form
          onSubmit={submitMfa}
          style={{ display: "flex", flexDirection: "column", gap: 10 }}
        >
          <label
            htmlFor="oauth-mfa-code"
            style={{ color: "var(--auth-text)", fontSize: 13, fontWeight: 700 }}
          >
            MFA 验证码或恢复码
          </label>
          <input
            id="oauth-mfa-code"
            value={mfaCode}
            onChange={(event) => setMfaCode(event.target.value)}
            placeholder="6 位验证码或恢复码"
            autoComplete="one-time-code"
            style={inputStyle}
          />
          <button
            type="submit"
            disabled={mfaBusy}
            style={{
              minHeight: 48,
              border: 0,
              borderRadius: 14,
              color: "var(--auth-on-accent)",
              fontWeight: 800,
              fontSize: 15,
              background: "var(--auth-accent)",
              cursor: mfaBusy ? "not-allowed" : "pointer",
              opacity: mfaBusy ? 0.7 : 1,
            }}
          >
            {mfaBusy ? "验证中…" : "完成验证并登录"}
          </button>
        </form>
      ) : null}
      <div
        role="status"
        style={{
          marginTop: mfaChallenge ? 12 : 0,
          color: "var(--auth-muted)",
          fontSize: 14,
          lineHeight: 1.7,
        }}
      >
        {message}
      </div>
    </AuthShell>
  );
}
