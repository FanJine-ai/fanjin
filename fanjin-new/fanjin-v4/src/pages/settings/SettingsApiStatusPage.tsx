import { useEffect, useState } from "react";
import { Database, RefreshCcw } from "lucide-react";
import { apiGet } from "../../api/http";
import { useAuthStore } from "../../stores/authStore";
import { Button, ConsolePage, DescriptionList, MetricStrip, Section } from "../../ui/console";

export default function SettingsApiStatusPage() {
  const [health, setHealth] = useState<"idle" | "checking" | "ok" | "error">("idle");
  const [message, setMessage] = useState("等待检查");
  const { currentWorkspace, user } = useAuthStore();

  async function check() {
    setHealth("checking");
    try {
      await apiGet("/auth/me");
      setHealth("ok");
      setMessage("服务可达");
    } catch (err: any) {
      setHealth("error");
      setMessage(err?.message || "当前环境未返回健康状态");
    }
  }

  useEffect(() => {
    void check();
  }, []);

  return (
    <ConsolePage
      eyebrow="设置"
      title="API 状态"
      description="检查前端连接、认证状态和当前工作区上下文。"
      primaryAction={(
        <Button icon={<RefreshCcw aria-hidden="true" size={17} />} onClick={() => void check()} data-testid="api-status-refresh">重新检查</Button>
      )}
    >
      <MetricStrip metrics={[
        { id: "service", label: "服务状态", value: <span data-testid="api-status-service">{health === "checking" ? "检查中" : message}</span>, tone: health === "ok" ? "positive" : health === "error" ? "warning" : "info" },
        { id: "auth", label: "认证上下文", value: user ? "已登录" : "未登录", hint: user?.name || "本地会话" },
        { id: "workspace", label: "当前工作区", value: currentWorkspace?.name || "-", hint: currentWorkspace?.id ? `ID ${currentWorkspace.id}` : "未选择" },
      ]} />
      <Section title="连接详情" icon={Database}>
        <div data-testid="api-status-details">
          <DescriptionList items={[
            { label: "Base URL", value: `${window.location.origin}/api` },
            { label: "检查结果", value: message },
            { label: "浏览器路由", value: window.location.hash || "-" },
          ]} />
        </div>
      </Section>
    </ConsolePage>
  );
}
