import { useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { claimAuthHandoff } from "../../api/auth";
import { apiPost, ApiError } from "../../api/http";
import {
  readAuthHandoffLocator,
  scrubAuthHandoffLocator,
} from "./authLinkToken";
import AuthShell from "./AuthShell";
import { useToast } from "../../ui/console/feedback";
import {
  DEFAULT_PASSWORD_REQUIREMENTS,
  defaultPasswordPolicyError,
} from "./defaultPasswordPolicy";

export default function ResetPasswordPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [searchParams] = useSearchParams();
  const locator = useMemo(() => readAuthHandoffLocator(searchParams), [searchParams]);
  const [code, setCode] = useState("");
  const [codeRequired, setCodeRequired] = useState(false);
  const [claimed, setClaimed] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(locator ? "" : "邮件链接缺少有效定位信息");
  const passwordError = useMemo(
    () => (password ? defaultPasswordPolicyError(password) : null),
    [password],
  );

  async function claim() {
    if (!locator) return;
    setSubmitting(true);
    setError("");
    try {
      await claimAuthHandoff({
        flow: "password_reset",
        locator,
        ...(code.trim() ? { code: code.trim() } : {}),
      });
      scrubAuthHandoffLocator();
      setClaimed(true);
      setCode("");
    } catch (err: unknown) {
      const apiError = err instanceof ApiError ? err : null;
      if (apiError?.code === "AUTH_HANDOFF_PROOF_REQUIRED") {
        setCodeRequired(true);
        setError("请填写邮件正文中的安全码");
      } else {
        setError(apiError?.message || (err instanceof Error ? err.message : "链接确认失败"));
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!claimed) return;
    const policyError = defaultPasswordPolicyError(password);
    if (policyError) { setError(policyError); return; }
    if (password !== confirmPassword) { setError("两次密码不一致"); return; }
    setSubmitting(true);
    setError("");
    try {
      await apiPost("/auth/reset-password", { password });
      toast({ title: "密码已重置，请重新登录", tone: "success" });
      navigate("/auth/login", { replace: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "重置密码失败";
      setError(message);
      toast({ title: "重置密码失败", message, tone: "danger" });
    } finally {
      setSubmitting(false);
    }
  }

  const inputStyle: React.CSSProperties = {
    width: "100%", minHeight: 48, padding: "0 14px",
    border: "1px solid var(--auth-border)", borderRadius: 14,
    color: "var(--auth-text)", background: "var(--auth-field)",
    fontSize: 14, outline: "none", boxSizing: "border-box",
  };

  return (
    <AuthShell
      title="重置密码"
      subtitle={claimed ? "设置新密码后即可重新登录。" : "先确认这封邮件属于你。"}
    >
      {!claimed ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {codeRequired ? (
            <>
              <label
                htmlFor="reset-security-code"
                style={{ color: "var(--auth-text)", fontSize: 13, fontWeight: 700 }}
              >
                邮件安全码
              </label>
              <input
                id="reset-security-code"
                type="text"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                autoComplete="one-time-code"
                inputMode="text"
                placeholder="XXXX-XXXX-XXXX-XXXX"
                style={inputStyle}
              />
            </>
          ) : null}
          <button type="button" disabled={submitting || !locator} onClick={() => void claim()}>
            {submitting ? "确认中…" : codeRequired ? "提交安全码" : "继续重置密码"}
          </button>
        </div>
      ) : (
        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <label htmlFor="reset-new-password">新密码</label>
          <input
            id="reset-new-password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            minLength={10}
            maxLength={128}
            autoComplete="new-password"
            aria-describedby="reset-password-requirements"
            aria-invalid={password.length > 0 && Boolean(passwordError)}
            style={inputStyle}
          />
          <div id="reset-password-requirements" data-testid="reset-password-requirements" aria-live="polite" style={{ display: "flex", flexWrap: "wrap", gap: "4px 10px", color: "var(--auth-muted)", fontSize: 11 }}>
            {DEFAULT_PASSWORD_REQUIREMENTS.map((requirement) => {
              const valid = requirement.test(password);
              return <span key={requirement.id} data-password-requirement={requirement.id} data-valid={valid ? "true" : "false"} style={{ color: valid ? "var(--auth-success)" : password ? "var(--auth-danger)" : "var(--auth-muted)" }}>{valid ? "✓" : "○"} {requirement.label}</span>;
            })}
          </div>
          <label htmlFor="reset-confirm-password">确认密码</label>
          <input id="reset-confirm-password" type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" style={inputStyle} />
          <button type="submit" disabled={submitting}>{submitting ? "提交中…" : "更新密码"}</button>
        </form>
      )}
      {error ? <div role="alert" style={{ color: "var(--auth-danger)", fontSize: 13, marginTop: 12 }}>{error}</div> : null}
      <div style={{ marginTop: 18, textAlign: "center" }}>
        <Link to="/auth/login">返回登录</Link>
      </div>
    </AuthShell>
  );
}
