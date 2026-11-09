import { Link } from "react-router-dom";
import ApiKeyManagement from "../../components/setting/components/apiKeyManagement";
import { ConsolePage } from "../../ui/console";
import { DeveloperMetricGrid } from "./DeveloperShared";

export default function ApiKeysPage() {
  return (
    <ConsolePage
      eyebrow="Developer API"
      title="API 中转密钥"
      description="为文本、图像、视频等 API 调用配置对应的 relay 权限与额度；混合密钥也会在此显示。"
    >
      <div className="mb-6">
        <DeveloperMetricGrid />
      </div>
      <Link className="toolConnectionsLink" to="/workspace/connections">连接 AI 助手或终端？前往 MCP / CLI 连接 →</Link>
      <ApiKeyManagement />
    </ConsolePage>
  );
}
