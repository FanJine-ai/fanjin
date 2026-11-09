import { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { claimAuthHandoff, verifyEmail } from "../../api/auth";
import { ApiError } from "../../api/http";
import {
  readAuthHandoffLocator,
  scrubAuthHandoffLocator,
} from "./authLinkToken";
import AuthShell from "./AuthShell";
import { useToast } from "../../ui/console/feedback";

type VerifyState = "ready" | "loading" | "success" | "error";

export default function VerifyEmailPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [searchParams] = useSearchParams();
  const locator = useMemo(() => readAuthHandoffLocator(searchParams), [searchParams]);
  const [code, setCode] = useState("");
  const [codeRequired, setCodeRequired] = useState(false);
  const [claimed, setClaimed] = useState(false);
  const [state, setState] = useState<VerifyState>(locator ? "ready" : "error");
  const [message, setMessage] = useState(
    locator ? "点击按钮后才会验证邮箱。" : "邮件链接缺少有效定位信息。",
  );

  async function verify() {
    if (!claimed && !locator) return;
    let hasClaim = claimed;
    setState("loading");
    setMessage(claimed ? "正在完成邮箱验证…" : "正在确认邮件链接…");
    try {
      if (!hasClaim) {
        await claimAuthHandoff({
          flow: "verify_email",
          locator,
          ...(code.trim() ? { code: code.trim() } : {}),
        });
        hasClaim = true;
        setClaimed(true);
        scrubAuthHandoffLocator();
        setCode("");
      }
      await verifyEmail({});
      setState("success");
      setMessage("邮箱验证成功，请使用密码登录。");
      toast({ title: "邮箱验证成功", message: "请使用密码登录", tone: "success" });
    } catch (err: unknown) {
      const apiError = err instanceof ApiError ? err : null;
      if (!hasClaim && apiError?.code === "AUTH_HANDOFF_PROOF_REQUIRED") {
        setCodeRequired(true);
        setState("ready");
        setMessage("请填写邮件正文中的安全码后继续。");
        return;
      }
      const text = apiError?.message || (err instanceof Error ? err.message : "验证失败");
      setState("error");
      setMessage(text);
      toast({ title: "验证失败", message: text, tone: "danger" });
    }
  }

  return (
    <AuthShell
      title="验证邮箱"
      subtitle="页面加载不会自动消费邮件链接。"
      eyebrow="Verify email"
    >
      <div role={state === "error" ? "alert" : "status"}>{message}</div>
      <div
        data-testid="verification-browser-boundary"
        style={{ marginTop: 10, color: "var(--auth-muted)", fontSize: 12, lineHeight: 1.65 }}
      >
        为保护账号，验证链接不会携带登录令牌。需要换浏览器时，请在目标浏览器重新打开原始验证邮件，按提示输入邮件安全码，验证后再登录。
      </div>
      {codeRequired && !claimed && state !== "success" ? (
        <div style={{ marginTop: 14 }}>
          <label htmlFor="verification-code">邮件安全码</label>
          <input
            id="verification-code"
            type="text"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            autoComplete="one-time-code"
            placeholder="XXXX-XXXX-XXXX-XXXX"
          />
        </div>
      ) : null}
      {state !== "success" ? (
        <button
          type="button"
          disabled={state === "loading" || (!claimed && !locator)}
          onClick={() => void verify()}
          style={{ marginTop: 16 }}
        >
          {state === "loading"
            ? "验证中…"
            : claimed
              ? "重试验证邮箱"
              : codeRequired
                ? "提交安全码并验证"
                : "验证邮箱"}
        </button>
      ) : null}
      {state === "success" ? (
        <button type="button" onClick={() => navigate("/auth/login", { replace: true })}>
          前往登录
        </button>
      ) : null}
      {state === "error" ? (
        <div style={{ marginTop: 16 }}><Link to="/auth/login">返回登录并重发邮件</Link></div>
      ) : null}
    </AuthShell>
  );
}
