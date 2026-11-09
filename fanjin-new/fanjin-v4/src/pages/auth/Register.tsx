import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { apiPost } from "../../api/http";
import { resendVerification, type RegisterResult } from "../../api/auth";
import { useAuthStore } from "../../stores/authStore";
import AuthShell from "./AuthShell";
import { resolvePostLoginRedirect } from "./postLoginRedirect";
import SocialAuthButtons from "./SocialAuthButtons";
import { useToast } from "../../ui/console/feedback";
import {
  DEFAULT_PASSWORD_REQUIREMENTS,
  defaultPasswordPolicyError,
} from "./defaultPasswordPolicy";

export {
  DEFAULT_PASSWORD_REQUIREMENTS as DEFAULT_REGISTRATION_PASSWORD_REQUIREMENTS,
  defaultPasswordPolicyError as defaultRegistrationPasswordError,
} from "./defaultPasswordPolicy";

type RegisterMethod = "email" | "phone";

const PHONE_REGISTRATION_AVAILABLE = false;

const registerMethodOptions: Array<{ value: RegisterMethod; label: string }> = [
  { value: "email", label: "邮箱注册" },
  { value: "phone", label: "手机号注册" },
];

export default function RegisterPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [searchParams] = useSearchParams();
  const authStore = useAuthStore();

  const inviteToken = useMemo(() => searchParams.get("invite") || "", [searchParams]);
  const currentUserEmail = useMemo(() => (authStore.user?.email || "").trim().toLowerCase(), [authStore.user?.email]);

  const [registerMethod, setRegisterMethod] = useState<RegisterMethod>("email");
  const [displayName, setDisplayName] = useState("");
  const [enterpriseName, setEnterpriseName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [agreement, setAgreement] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [invitationLoading, setInvitationLoading] = useState(false);
  const [inviteError, setInviteError] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [pendingVerificationEmail, setPendingVerificationEmail] = useState("");
  const [resending, setResending] = useState(false);

  const isLoggedInInviteForCurrentUser = useMemo(() => {
    return Boolean(inviteToken && authStore.token && email && currentUserEmail === email.toLowerCase());
  }, [inviteToken, authStore.token, email, currentUserEmail]);

  const isLoggedInInviteForAnotherUser = useMemo(() => {
    return Boolean(inviteToken && authStore.token && email && currentUserEmail && currentUserEmail !== email.toLowerCase());
  }, [inviteToken, authStore.token, email, currentUserEmail]);

  const postLoginTarget = resolvePostLoginRedirect(searchParams.get("redirect"));
  const invitationPath = useMemo(
    () => `/auth/register?invite=${encodeURIComponent(inviteToken)}`,
    [inviteToken],
  );
  const invitationLoginHref = useMemo(() => {
    const params = new URLSearchParams({ redirect: inviteToken ? invitationPath : postLoginTarget });
    if (email) params.set("email", email);
    return `/auth/login?${params.toString()}`;
  }, [email, invitationPath, inviteToken, postLoginTarget]);

  const needsPassword = useMemo(() => !inviteToken || !isLoggedInInviteForCurrentUser, [inviteToken, isLoggedInInviteForCurrentUser]);
  const passwordError = useMemo(
    () => (needsPassword && password ? defaultPasswordPolicyError(password) : null),
    [needsPassword, password],
  );

  const pageTitle = useMemo(() => {
    if (pendingVerificationEmail) return "请验证邮箱";
    if (inviteToken) return "接受工作区邀请";
    return "创建 Fanjin 账号";
  }, [inviteToken, pendingVerificationEmail]);

  const inviteSubtitle = useMemo(() => {
    if (pendingVerificationEmail) {
      return "验证邮件已发送。完成验证后即可登录使用繁境。";
    }
    if (!inviteToken) {
      if (registerMethod === "phone") {
        return "手机号注册将在短信验证服务接通后开放，你可以先使用邮箱完成注册。";
      }
      return "创建统一账号，注册后可使用个人空间、加入团队或申请企业认证。";
    }
    if (isLoggedInInviteForCurrentUser) return "确认后加入企业工作区，不会修改当前账号密码。";
    if (isLoggedInInviteForAnotherUser) return "请切换到受邀邮箱账号，登录后会自动返回此邀请。";
    return "新成员设置密码后加入企业工作区。已有账号请先登录同邮箱账号再打开邀请链接。";
  }, [inviteToken, isLoggedInInviteForAnotherUser, isLoggedInInviteForCurrentUser, pendingVerificationEmail, registerMethod]);

  const inviteButtonText = useMemo(() => {
    if (!inviteToken) return "创建账号";
    return isLoggedInInviteForCurrentUser ? "加入工作区" : "接受邀请并进入";
  }, [inviteToken, isLoggedInInviteForCurrentUser]);

  const emailLabel = inviteToken ? "成员邮箱" : "邮箱";

  useEffect(() => {
    if (!inviteToken) return;
    setInvitationLoading(true);
    setInviteError("");
    apiPost<{ workspaceName?: string; email?: string }>("/auth/invitations/preview", { token: inviteToken })
      .then((data) => {
        setEnterpriseName(data.workspaceName || "受邀工作区");
        setEmail(data.email || "");
      })
      .catch((err: any) => {
        setInviteError(err?.message || "邀请链接无效或已过期");
      })
      .finally(() => setInvitationLoading(false));
  }, [inviteToken]);

  function handleSwitchInvitationAccount() {
    authStore.logout();
    navigate(invitationLoginHref);
  }

  async function handleResendVerification() {
    if (!pendingVerificationEmail || resending) return;
    setResending(true);
    setErrorMessage("");
    try {
      await resendVerification({ email: pendingVerificationEmail });
      toast({
        title: "验证邮件已重新发送",
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

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setErrorMessage("");
    if (inviteError || isLoggedInInviteForAnotherUser) return;
    if (!inviteToken && registerMethod === "phone" && !PHONE_REGISTRATION_AVAILABLE) {
      setErrorMessage("手机号注册需先接通短信验证服务，请暂时使用邮箱注册");
      return;
    }
    const submitPasswordError = needsPassword ? defaultPasswordPolicyError(password) : null;
    if (submitPasswordError) {
      setErrorMessage(submitPasswordError);
      return;
    }
    if (needsPassword && password !== confirmPassword) {
      setErrorMessage("两次输入的密码不一致");
      return;
    }
    if (!inviteToken && !agreement) {
      setErrorMessage("请先阅读并同意《用户协议》和《隐私政策》");
      return;
    }
    setSubmitting(true);
    try {
      if (inviteToken) {
        const data: any = await apiPost("/auth/invitations/accept", {
          token: inviteToken,
          password: needsPassword ? password : undefined,
          displayName: email,
        });
        authStore.setToken(data.token);
        await authStore.fetchMe();
        toast({ title: "已加入工作区", tone: "success" });
        navigate("/workbench/create");
        return;
      }

      const data = await apiPost<RegisterResult>("/auth/register", {
        username: email,
        email,
        password,
        displayName: displayName || email,
        workspaceName: `${displayName || "我的"}的个人空间`,
      });

      if (data?.requiresVerification || !data?.token) {
        const verifiedEmail = String(data?.email || email).trim().toLowerCase();
        setPendingVerificationEmail(verifiedEmail);
        toast({
          title: "注册成功",
          message: "请查收验证邮件，完成验证后再登录。",
          tone: "success",
        });
        return;
      }

      // 兼容测试/旧路径：注册直接返回 token
      authStore.setToken(data.token);
      await authStore.fetchMe();
      toast({
        title: "账号已创建",
        tone: "success",
      });
      navigate(postLoginTarget);
    } catch (err: any) {
      const message = err?.message || "注册失败";
      setErrorMessage(message);
      toast({ title: "注册失败", message, tone: "danger" });
    } finally {
      setSubmitting(false);
    }
  }

  const inputStyle: React.CSSProperties = {
    width: "100%", minHeight: 44, padding: "0 14px",
    border: "1px solid var(--auth-border)", borderRadius: 12,
    color: "var(--auth-text)", background: "var(--auth-field)",
    fontSize: 14, outline: "none", boxSizing: "border-box",
  };

  if (pendingVerificationEmail) {
    return (
      <AuthShell title={pageTitle} subtitle={inviteSubtitle} eyebrow="Verify email">
        <div style={{
          padding: "16px 18px",
          borderRadius: 16,
          border: "1px solid var(--auth-border)",
          background: "var(--auth-soft)",
          color: "var(--auth-text)",
          fontSize: 14,
          lineHeight: 1.7,
        }}>
          <div style={{ fontWeight: 800, marginBottom: 8, color: "var(--auth-text)" }}>验证邮件已发送</div>
          <div>
            我们已向 <strong style={{ color: "var(--auth-accent)" }}>{pendingVerificationEmail}</strong> 发送验证链接。
            请在 24 小时内打开邮件完成验证，然后再登录。
          </div>
          <div style={{ marginTop: 10, color: "var(--auth-muted)", fontSize: 13 }}>
            没收到？请检查垃圾邮件箱，或点击下方重新发送。
          </div>
        </div>

        {errorMessage && (
          <div role="alert" style={{ color: "var(--auth-danger)", fontSize: 13, marginTop: 12, lineHeight: 1.6 }}>
            {errorMessage}
          </div>
        )}

        <button
          type="button"
          disabled={resending}
          onClick={handleResendVerification}
          style={{
            width: "100%",
            minHeight: 48,
            marginTop: 16,
            border: 0,
            borderRadius: 14,
            color: "var(--auth-on-accent)",
            fontWeight: 800,
            fontSize: 15,
            background: "var(--auth-accent)",
            boxShadow: "none",
            cursor: resending ? "not-allowed" : "pointer",
            opacity: resending ? 0.7 : 1,
          }}
        >
          {resending ? "发送中..." : "重新发送验证邮件"}
        </button>

        <button
          type="button"
          onClick={() => navigate(`/auth/login?email=${encodeURIComponent(pendingVerificationEmail)}&redirect=${encodeURIComponent(postLoginTarget)}`)}
          style={{
            width: "100%",
            minHeight: 44,
            marginTop: 10,
            border: "1px solid var(--auth-border)",
            borderRadius: 14,
            color: "var(--auth-accent)",
            background: "var(--auth-field)",
            cursor: "pointer",
            fontSize: 14,
            fontWeight: 700,
          }}
        >
          已完成验证，去登录
        </button>
      </AuthShell>
    );
  }

  return (
    <AuthShell title={pageTitle} subtitle={inviteSubtitle} eyebrow="Start account">
      {/* Invite error */}
      {inviteError && (
        <div style={{ marginBottom: 18, padding: 16, border: "1px solid var(--auth-danger)", borderRadius: 16, background: "var(--auth-danger-bg)" }}>
          <div style={{ marginBottom: 6, color: "var(--auth-danger)", fontWeight: 800 }}>邀请链接不可用</div>
          <div style={{ marginBottom: 14, color: "var(--auth-danger)", lineHeight: 1.7 }}>{inviteError}</div>
          <button type="button" onClick={() => navigate("/auth/login")} style={{
            width: "100%", minHeight: 42, border: "1px solid var(--auth-border)", borderRadius: 14,
            color: "var(--auth-accent)", background: "transparent", cursor: "pointer", fontSize: 14,
          }}>返回登录</button>
        </div>
      )}

      {isLoggedInInviteForAnotherUser && (
        <div role="alert" style={{ marginBottom: 18, padding: 16, border: "1px solid var(--auth-warning)", borderRadius: 16, background: "var(--auth-warning-bg)" }}>
          <div style={{ marginBottom: 6, color: "var(--auth-warning)", fontWeight: 800 }}>需要切换账号</div>
          <div style={{ marginBottom: 14, color: "var(--auth-warning)", lineHeight: 1.7 }}>
            当前登录账号与受邀邮箱不一致。切换账号后，登录成功会自动返回此邀请。
          </div>
          <button type="button" onClick={handleSwitchInvitationAccount} style={{
            width: "100%", minHeight: 42, border: "1px solid var(--auth-border)", borderRadius: 14,
            color: "var(--auth-warning)", background: "transparent", cursor: "pointer", fontSize: 14,
          }}>切换到受邀账号</button>
        </div>
      )}

      {/* Registration method */}
      {!inviteToken && (
        <div
          role="group"
          aria-label="选择注册方式"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
            gap: 4,
            marginBottom: 14,
            padding: 3,
            border: "1px solid var(--auth-border)",
            borderRadius: 13,
            background: "var(--auth-field)",
          }}
        >
          {registerMethodOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={registerMethod === option.value}
              onClick={() => {
                setRegisterMethod(option.value);
                setErrorMessage("");
              }}
              style={{
                minHeight: 38,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 7,
                padding: "0 10px",
                border: 0,
                borderRadius: 10,
                color: registerMethod === option.value ? "var(--auth-text)" : "var(--auth-muted)",
                background: registerMethod === option.value ? "var(--auth-soft)" : "transparent",
                boxShadow: registerMethod === option.value ? "inset 0 0 0 1px var(--auth-border)" : "none",
                cursor: "pointer",
                fontSize: 13,
                fontWeight: 800,
              }}
            >
              <span>{option.label}</span>
              {option.value === "phone" && !PHONE_REGISTRATION_AVAILABLE ? (
                <small style={{ color: "var(--auth-accent)", fontSize: 10, fontWeight: 800 }}>即将开放</small>
              ) : null}
            </button>
          ))}
        </div>
      )}

      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {/* Invite workspace / Display name */}
        {inviteToken ? (
          <>
            <label style={{ color: "var(--auth-text)", fontSize: 13, fontWeight: 700 }}>邀请工作区</label>
            <input type="text" value={enterpriseName} readOnly style={inputStyle} />
          </>
        ) : (
          <>
            <label style={{ color: "var(--auth-text)", fontSize: 13, fontWeight: 700 }}>昵称</label>
            <input type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="例如：繁境创作者" style={inputStyle} />
          </>
        )}

        {/* Registration identity */}
        {inviteToken || registerMethod === "email" ? (
          <>
            <label htmlFor="register-email" style={{ color: "var(--auth-text)", fontSize: 13, fontWeight: 700, marginTop: 4 }}>{emailLabel}</label>
            <input id="register-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" readOnly={Boolean(inviteToken)} style={{ ...inputStyle, opacity: inviteToken ? 0.6 : 1 }} />
          </>
        ) : (
          <>
            <label htmlFor="register-phone" style={{ color: "var(--auth-text)", fontSize: 13, fontWeight: 700, marginTop: 4 }}>手机号</label>
            <input
              id="register-phone"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value.replace(/[^\d+\s-]/g, ""))}
              placeholder="请输入常用手机号"
              autoComplete="tel"
              inputMode="tel"
              style={inputStyle}
            />
            <div style={{ marginTop: 2, color: "var(--auth-warning)", fontSize: 11, lineHeight: 1.5 }}>
              短信验证服务接通后开放，当前请使用邮箱注册。
            </div>
          </>
        )}

        {/* Password */}
        {needsPassword && (
          <>
            <label htmlFor="register-password" style={{ color: "var(--auth-text)", fontSize: 13, fontWeight: 700, marginTop: 4 }}>密码</label>
            <input
              id="register-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="至少 10 位，含大小写字母和数字"
              minLength={10}
              maxLength={128}
              autoComplete="new-password"
              style={inputStyle}
              aria-describedby="register-password-hint"
              aria-invalid={password.length > 0 && Boolean(passwordError)}
            />
            <div
              id="register-password-hint"
              data-testid="register-password-requirements"
              aria-live="polite"
              style={{ display: "flex", flexWrap: "wrap", gap: "4px 10px", marginTop: 3, fontSize: 11, lineHeight: 1.5 }}
            >
              {DEFAULT_PASSWORD_REQUIREMENTS.map((requirement) => {
                const valid = requirement.test(password);
                return (
                  <span
                    key={requirement.id}
                    data-password-requirement={requirement.id}
                    data-valid={valid ? "true" : "false"}
                    style={{ color: valid ? "var(--auth-success)" : password ? "var(--auth-danger)" : "var(--auth-muted)" }}
                  >
                    {valid ? "✓" : "○"} {requirement.label}
                  </span>
                );
              })}
            </div>
            <label htmlFor="register-confirm-password" style={{ color: "var(--auth-text)", fontSize: 13, fontWeight: 700, marginTop: 4 }}>确认密码</label>
            <input id="register-confirm-password" type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="再次输入密码" autoComplete="new-password" style={inputStyle} />
          </>
        )}

        {/* Agreement */}
        {!inviteToken && (
          <label style={{ display: "flex", alignItems: "center", gap: 9, marginTop: 6, color: "var(--auth-muted)", fontSize: 12, lineHeight: 1.45, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={agreement}
              onChange={(e) => setAgreement(e.target.checked)}
              aria-label="同意用户协议和隐私政策"
              style={{
                width: 17,
                height: 17,
                minWidth: 17,
                minHeight: 17,
                flex: "0 0 17px",
                margin: 0,
                padding: 0,
                borderRadius: 4,
                accentColor: "var(--auth-accent)",
                cursor: "pointer",
              }}
            />
            <span>
              我已阅读并同意
              <Link
                to="/legal/terms"
                target="_blank"
                rel="noreferrer"
                onClick={(event) => event.stopPropagation()}
                style={{ color: "var(--auth-accent)", textDecoration: "none" }}
              >
                《用户协议》
              </Link>
              和
              <Link
                to="/legal/privacy"
                target="_blank"
                rel="noreferrer"
                onClick={(event) => event.stopPropagation()}
                style={{ color: "var(--auth-accent)", textDecoration: "none" }}
              >
                《隐私政策》
              </Link>
            </span>
          </label>
        )}

        {errorMessage && <div role="alert" style={{ color: "var(--auth-danger)", fontSize: 13, marginTop: 4, lineHeight: 1.6 }}>{errorMessage}</div>}

        <button type="submit" disabled={submitting || invitationLoading || Boolean(inviteError) || isLoggedInInviteForAnotherUser || (!inviteToken && registerMethod === "phone" && !PHONE_REGISTRATION_AVAILABLE)} style={{
          minHeight: 46, marginTop: 8, border: 0, borderRadius: 12,
          color: "var(--auth-on-accent)", fontWeight: 800, fontSize: 15,
          background: "var(--auth-accent)",
          boxShadow: "none",
          cursor: submitting || invitationLoading || registerMethod === "phone" ? "not-allowed" : "pointer",
          opacity: submitting || invitationLoading || registerMethod === "phone" ? 0.62 : 1,
        }}>
          {submitting || invitationLoading
            ? "处理中..."
            : !inviteToken && registerMethod === "phone"
              ? "手机号注册即将开放"
              : inviteButtonText}
        </button>
      </form>

      {!inviteToken && <SocialAuthButtons mode="register" />}

      {inviteToken && !authStore.token && !inviteError ? (
        <div style={{ marginTop: 18, textAlign: "center", color: "var(--auth-muted)", fontSize: 14 }}>
          已有该邮箱账号？{" "}
          <Link to={invitationLoginHref} style={{ color: "var(--auth-accent)", textDecoration: "none" }}>
            登录后接受邀请
          </Link>
        </div>
      ) : null}

      {!inviteToken ? (
        <div style={{ marginTop: 18, textAlign: "center", color: "var(--auth-muted)", fontSize: 14 }}>
          已有账号？{" "}
          <Link to="/auth/login" style={{ color: "var(--auth-accent)", textDecoration: "none" }}>返回登录</Link>
        </div>
      ) : null}
    </AuthShell>
  );
}
