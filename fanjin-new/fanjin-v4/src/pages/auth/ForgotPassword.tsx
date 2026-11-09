import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { apiPost } from "../../api/http";
import AuthShell from "./AuthShell";
import { resolvePostLoginRedirect } from "./postLoginRedirect";
import { useToast } from "../../ui/console/feedback";

export default function ForgotPasswordPage() {
  const { toast } = useToast();
  const [searchParams] = useSearchParams();
  const redirect = resolvePostLoginRedirect(searchParams.get("redirect"));
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!email.trim()) { setError("请输入邮箱"); return; }
    setSubmitting(true);
    setError("");
    try {
      await apiPost("/auth/forgot-password", { email });
      setSubmitted(true);
      toast({ title: "重置方式已发送", message: "如果账号存在，请检查该邮箱。", tone: "success" });
    } catch (err: any) {
      const message = err?.message || "找回密码失败";
      setError(message);
      toast({ title: "找回密码失败", message, tone: "danger" });
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
    <AuthShell title="找回密码" subtitle="输入企业管理员邮箱，我们会发送重置方式。">
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <label style={{ color: "var(--auth-text)", fontSize: 13, fontWeight: 700 }}>邮箱</label>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="admin@example.com" autoComplete="email" style={inputStyle} />
        {error && <div role="alert" style={{ color: "var(--auth-danger)", fontSize: 13 }}>{error}</div>}
        <button type="submit" disabled={submitting} style={{
          minHeight: 48, marginTop: 8, border: 0, borderRadius: 14,
          color: "var(--auth-on-accent)", fontWeight: 800, fontSize: 15,
          background: "var(--auth-accent)",
          boxShadow: "none",
          cursor: submitting ? "not-allowed" : "pointer", opacity: submitting ? 0.7 : 1,
        }}>
          {submitting ? "发送中..." : "发送重置链接"}
        </button>
      </form>

      {submitted && (
        <div style={{ marginTop: 14, padding: "14px 16px", border: "1px solid var(--auth-border)", borderRadius: 16, color: "var(--auth-muted)", fontSize: 13, lineHeight: 1.7, background: "var(--auth-soft)" }}>
          ✅ 如果账号存在，重置方式已发送到该邮箱。
        </div>
      )}

      <div style={{ marginTop: 18, textAlign: "center", color: "var(--auth-muted)", fontSize: 14 }}>
        想起密码了？{" "}
        <Link to={`/auth/login?redirect=${encodeURIComponent(redirect)}`} style={{ color: "var(--auth-accent)", textDecoration: "none" }}>返回登录</Link>
      </div>
    </AuthShell>
  );
}
