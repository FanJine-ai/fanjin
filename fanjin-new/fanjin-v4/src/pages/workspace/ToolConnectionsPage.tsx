import { Link } from "react-router-dom";
import { KeyRound } from "lucide-react";
import { useAuthStore } from "../../stores/authStore";
import { readApiSettings } from "../../api/http";
import { Alert, Badge, ConsolePage } from "../../ui/console";
import ApiKeyManagement from "../../components/setting/components/apiKeyManagement";
import ToolConnectionSetup from "../../components/setting/components/ToolConnectionSetup";

export default function ToolConnectionsPage() {
  const workspace = useAuthStore(state => state.currentWorkspace);
  return <ConsolePage eyebrow="工作区 · 工具连接" title="MCP / CLI 连接" description="让 AI 助手和终端接入繁境，使用同一工作区的项目、素材和创作能力。">
    <div className="toolConnections">
      <section className="toolConnectionIntro" aria-label="连接说明">
        <div>
          <Badge tone="info">{workspace?.name || "尚未选择工作区"}</Badge>
          <h2>一把繁境密钥，连接两种创作方式</h2>
          <p>MCP 连接 AI 助手，CLI 连接终端。使用工作区 API Key 即可，模型和存储的 AK / SK 由繁境服务端管理。</p>
          <Link className="toolConnectionsLink" to="/developer/api/keys"><KeyRound size={16} aria-hidden="true" />管理 API 中转密钥</Link>
        </div>
        <ol>
          <li><strong>创建专用密钥</strong><span>默认只读，可选择完整创作权限。</span></li>
          <li><strong>复制配置并检测连接</strong><span>完整密钥仅在创建或轮换后显示一次。</span></li>
          <li><strong>开始使用</strong><span>付费生成前，由你确认本次最高 GU 费用。</span></li>
        </ol>
      </section>
      {!workspace?.id && <Alert tone="warning">请先从工作区菜单选择一个工作区，再创建连接密钥。</Alert>}
      <ApiKeyManagement connections />
      <details className="toolTemplateDetails">
        <summary>已有密钥？查看连接配置与安装说明</summary>
        <ToolConnectionSetup baseUrl={readApiSettings().baseUrl} workspaceId={String(workspace?.id || "")} onCopy={async text => {
          try { await navigator.clipboard.writeText(text); return true; }
          catch { return false; }
        }} />
      </details>
    </div>
  </ConsolePage>;
}
