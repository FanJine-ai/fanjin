import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { resendVerification } from "../../api/auth";
import { ApiError } from "../../api/http";
import { useAuthStore } from "../../stores/authStore";
import LoginDialogFrame from "./LoginDialogFrame";
import { Eye, EyeOff } from "lucide-react";
import SocialAuthButtons from "../auth/SocialAuthButtons";
import { useToast } from "../../ui/console/feedback";
import { resolvePostLoginRedirect } from "../auth/postLoginRedirect";
import { useTenantRuntime } from "../../lib/tenant-runtime";

function looksLikeEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export default function LoginPage({
  open = true,
  onClose,
  redirectTo,
}: { open?: boolean; onClose?: () => void; redirectTo?: string } = {}) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [searchParams] = useSearchParams();
  const authStore = useAuthStore();
  const tenant = useTenantRuntime();
  const identityOrigin = String(tenant.identityOrigin || "").replace(
    /\/+$/,
    "",
  );
  const shouldForwardToIdentity = Boolean(
    tenant.id !== "FANJIN" &&
      identityOrigin &&
      identityOrigin !== window.location.origin,
  );

  const [showPassword, setShowPassword] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const closeLogin =
    onClose || (() => navigate("/workbench/create", { replace: true }));
  const redirect = resolvePostLoginRedirect(
    redirectTo ?? searchParams.get("redirect"),
  );
  const [username, setUsername] = useState(
    () => searchParams.get("email") || "",
  );
  const [password, setPassword] = useState("");
  const [mfaChallenge, setMfaChallenge] = useState("");
  const [mfaCredential, setMfaCredential] = useState("");
  const [errorMessage, setErrorMessage] = useState(() =>
    searchParams.get("reason") === "session-expired"
      ? "登录已失效，请重新登录"
      : "",
  );
  const [loginLoading, setLoginLoading] = useState(false);
  const [needsVerification, setNeedsVerification] = useState(false);
  const [resending, setResending] = useState(false);
  const mfaInputRef = useRef<HTMLInputElement>(null);
  const isMfaStage = Boolean(mfaChallenge);

  useEffect(() => {
    if (!open || !shouldForwardToIdentity) return;
    const redirectPath = redirect;
    const query = new URLSearchParams({
      targetOrigin: window.location.origin,
      targetTenantId: tenant.id,
      redirectPath,
    });
    window.location.replace(
      `${identityOrigin}/#/auth/tenant-transfer?${query.toString()}`,
    );
  }, [identityOrigin, open, redirect, shouldForwardToIdentity, tenant.id]);

  useEffect(() => {
    if (!isMfaStage) return;
    window.requestAnimationFrame(() =>
      mfaInputRef.current?.focus({ preventScroll: true }),
    );
  }, [isMfaStage]);

  const resendEmail = useMemo(() => {
    const candidate = username.trim();
    return looksLikeEmail(candidate) ? candidate.toLowerCase() : "";
  }, [username]);

  function readMfaChallenge(error: ApiError | null) {
    const details = error?.details;
    if (!details || typeof details !== "object" || Array.isArray(details))
      return "";
    return String((details as { challenge?: unknown }).challenge || "").trim();
  }

  function resetMfaStage(options: { clearPassword?: boolean } = {}) {
    setMfaChallenge("");
    setMfaCredential("");
    if (options.clearPassword) setPassword("");
  }

  async function finishLogin(action: () => Promise<void>) {
    await action();
    const latestAuth = useAuthStore.getState();
    if (!latestAuth.token) throw new Error("登录响应缺少 token");
    localStorage.setItem("userId", String(latestAuth.user?.id || ""));
    setPassword("");
    setMfaCredential("");
    navigate(redirect, { replace: true });
  }

  async function renewMfaChallenge(reason: string) {
    try {
      await authStore.login(username, password);
    } catch (error) {
      const apiError = error instanceof ApiError ? error : null;
      const challenge = readMfaChallenge(apiError);
      if (apiError?.code === "MFA_REQUIRED" && challenge) {
        setMfaChallenge(challenge);
        setMfaCredential("");
        setErrorMessage(
          `${reason}，请输入验证器当前显示的新验证码，或使用一枚未使用的恢复码。`,
        );
        return;
      }
      resetMfaStage({ clearPassword: true });
      setErrorMessage(
        apiError?.message ||
          (error as Error)?.message ||
          "请重新输入密码后继续登录",
      );
      return;
    }
    // 账号的 MFA 若在两次请求之间被关闭，密码登录可能直接成功。
    await finishLogin(async () => undefined);
  }

  async function handleLogin(e: FormEvent) {
    e.preventDefault();
    if (!agreed) {
      setErrorMessage("请先阅读并同意用户协议和隐私政策");
      return;
    }
    if (!username.trim() || (!isMfaStage && !password.trim())) {
      setErrorMessage("请输入用户名和密码");
      return;
    }
    if (isMfaStage && !mfaCredential.trim()) {
      setErrorMessage("请输入 MFA 验证码或恢复码");
      mfaInputRef.current?.focus();
      return;
    }
    setErrorMessage("");
    setNeedsVerification(false);
    setLoginLoading(true);
    try {
      if (isMfaStage) {
        await finishLogin(() =>
          authStore.loginWithMfa(mfaChallenge, mfaCredential.trim()),
        );
      } else {
        await finishLogin(() => authStore.login(username, password));
      }
    } catch (err: any) {
      const apiErr = err instanceof ApiError ? err : null;
      const code = apiErr?.code || "";
      const message = apiErr?.message || err?.message || "登录失败";
      const challenge = readMfaChallenge(apiErr);
      if (code === "MFA_REQUIRED" && challenge) {
        setMfaChallenge(challenge);
        setMfaCredential("");
        setErrorMessage("");
      } else if (code === "MFA_REQUIRED") {
        resetMfaStage({ clearPassword: true });
        setErrorMessage("登录服务未返回 MFA challenge，请重新输入密码后重试。");
      } else if (
        isMfaStage &&
        [
          "MFA_CODE_INVALID",
          "MFA_CHALLENGE_INVALID",
          "MFA_CHALLENGE_EXPIRED",
          "MFA_CHALLENGE_CONTEXT_MISMATCH",
        ].includes(code)
      ) {
        await renewMfaChallenge(message);
      } else if (code === "EMAIL_NOT_VERIFIED" || /邮箱验证/.test(message)) {
        setNeedsVerification(true);
        setErrorMessage("请先完成邮箱验证后再登录。");
      } else {
        setErrorMessage(message);
      }
    } finally {
      setLoginLoading(false);
    }
  }

  async function handleResendVerification() {
    if (!resendEmail) {
      setErrorMessage("请先输入注册时使用的邮箱，再重发验证邮件。");
      return;
    }
    setResending(true);
    try {
      await resendVerification({ email: resendEmail });
      toast({
        title: "验证邮件已发送",
        message: "若该邮箱已注册且未验证，请查收收件箱。",
        tone: "success",
      });
    } catch (err: any) {
      const message = err?.message || "重发失败";
      setErrorMessage(message);
      toast({ title: "重发失败", message, tone: "danger" });
    } finally {
      setResending(false);
    }
  }

  return (
    <>
      <LoginDialogFrame
        open={open}
        onClose={closeLogin}
        busy={loginLoading}
      >
        {shouldForwardToIdentity ? (
          <>
            <h1 id="login-title">正在同步账号</h1>
            <p className="loginSubtitle">即将通过统一身份入口安全登录…</p>
          </>
        ) : (
          <>
            <h1 id="login-title">
              {isMfaStage ? "验证你的身份" : "欢迎来到繁境"}
            </h1>
            <p className="loginSubtitle">
              {isMfaStage ? "完成安全验证，继续你的创作" : "登录，继续你的创作"}
            </p>
            <form className="loginForm" data-login-stage={isMfaStage ? "mfa" : "password"} onSubmit={handleLogin}>
              {isMfaStage ? (
                <>
                  <p className="loginMfaHint">
                    正在验证账号 <strong>{username.trim()}</strong>
                  </p>
                  <label htmlFor="login-mfa-credential">
                    MFA 验证码或恢复码
                  </label>
                  <input
                    ref={mfaInputRef}
                    id="login-mfa-credential"
                    type="text"
                    value={mfaCredential}
                    onChange={(event) => {
                      setMfaCredential(event.target.value.slice(0, 128));
                      setErrorMessage("");
                    }}
                    placeholder="6 位动态验证码或恢复码"
                    autoComplete="one-time-code"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                  <p className="loginHint">
                    验证码每 30 秒更新；也可以输入一枚尚未使用的恢复码。
                  </p>
                </>
              ) : (
                <>
                  <label htmlFor="login-username">用户名 / 邮箱</label>
                  <input
                    id="login-username"
                    type="text"
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    placeholder="请输入用户名或邮箱"
                    autoComplete="username"
                  />
                  <label htmlFor="login-password">密码</label>
                  <div className="loginPassword">
                    <input
                      id="login-password"
                      type={showPassword ? "text" : "password"}
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      placeholder="请输入密码"
                      autoComplete="current-password"
                    />
                    <button
                      type="button"
                      aria-label={showPassword ? "隐藏密码" : "显示密码"}
                      onClick={() => setShowPassword(!showPassword)}
                    >
                      {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                    </button>
                  </div>
                  <Link
                    className="loginForgot"
                    to={`/auth/forgot-password?redirect=${encodeURIComponent(redirect)}`}
                  >
                    忘记密码？
                  </Link>
                </>
              )}
              {errorMessage && (
                <div className="loginError" role="alert">
                  {errorMessage}
                </div>
              )}
              {needsVerification && (
                <div className="loginVerification">
                  <strong>邮箱尚未验证</strong>
                  <p>请打开注册邮箱中的验证链接。若未收到，可重新发送。</p>
                  <button
                    type="button"
                    disabled={resending || !resendEmail}
                    onClick={handleResendVerification}
                  >
                    {resending
                      ? "发送中..."
                      : resendEmail
                        ? `重发验证邮件到 ${resendEmail}`
                        : "请输入邮箱后再重发"}
                  </button>
                </div>
              )}
              <button
                className="loginSubmit"
                type="submit"
                aria-label={isMfaStage ? "验证并登录" : "登录"}
                disabled={loginLoading}
              >
                {loginLoading
                  ? isMfaStage
                    ? "验证中..."
                    : "登录中..."
                  : isMfaStage
                    ? "验证并登录"
                    : "登录并继续"}
              </button>
              {isMfaStage && (
                <button
                  className="loginBack"
                  type="button"
                  disabled={loginLoading}
                  onClick={() => {
                    resetMfaStage({ clearPassword: true });
                    setErrorMessage("");
                  }}
                >
                  返回密码登录
                </button>
              )}
            </form>
            {!isMfaStage && (
              <>
                <p className="loginRegister">
                  还没有账号？{" "}
                  <Link
                    to={`/auth/register?redirect=${encodeURIComponent(redirect)}`}
                  >
                    立即注册
                  </Link>
                </p>
                <SocialAuthButtons
                  mode="login"
                  variant="dialog"
                  redirectTo={redirect}
                  beforeAuth={() => {
                    if (agreed) return true;
                    setErrorMessage("请先阅读并同意用户协议和隐私政策");
                    return false;
                  }}
                />
              </>
            )}
            <label className="loginConsent">
              <input
                type="checkbox"
                checked={agreed}
                onChange={(event) => {
                  setAgreed(event.target.checked);
                  setErrorMessage("");
                }}
              />
              <span>
                已阅读并同意{" "}
                <Link
                  to="/legal/terms"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  用户协议
                </Link>{" "}
                和{" "}
                <Link
                  to="/legal/privacy"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  隐私政策
                </Link>
              </span>
            </label>
          </>
        )}
      </LoginDialogFrame>
    </>
  );
}
