import { useEffect, useRef, useState } from "react";
import { Cable, CheckCircle2, Copy, TerminalSquare } from "lucide-react";
import { Alert, Button } from "../../../ui/console";
import { buildToolConnectionConfig } from "./toolConnectionConfig";
import "./toolConnections.css";

export default function ToolConnectionSetup({ baseUrl, secret, workspaceId, onCopy }: {
  baseUrl: string; secret?: string; workspaceId: string; onCopy: (text: string) => Promise<unknown>;
}) {
  const [format, setFormat] = useState<"cli" | "stdio" | "http">("cli");
  const [copyMessage, setCopyMessage] = useState("");
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  useEffect(() => {
    setResult(null);
    setChecking(false);
    return () => { controllerRef.current?.abort(); controllerRef.current = null; };
  }, [secret, baseUrl, workspaceId]);
  let config: ReturnType<typeof buildToolConnectionConfig>;
  try { config = buildToolConnectionConfig(baseUrl, secret); }
  catch (error) { return <Alert tone="danger">{error instanceof Error ? error.message : "连接地址无效"}</Alert>; }
  const snippet = format === "http" ? `${config.mcpUrl}\nAuthorization: Bearer ${secret || "<YOUR_FANJIN_API_KEY>"}` : config[format];

  async function checkConnection() {
    if (!secret || controllerRef.current) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    const timer = window.setTimeout(() => controller.abort(), 15_000);
    setChecking(true); setResult(null);
    try {
      // Use the new key, never the browser session. A read-only call cannot start a paid task.
      const response = await fetch(`${config.apiBase}/tools/v1/fanjin_context_get`, {
        method: "POST", credentials: "omit", redirect: "error", signal: controller.signal,
        headers: { "Content-Type": "application/json", "X-API-Key": secret }, body: "{}",
      });
      const body = await response.json();
      if (!response.ok || body.ok !== true || String(body.data?.workspaceId) !== workspaceId) {
        throw new Error(response.status === 401 ? "密钥无效或已失效，请重新创建。" : response.status === 403 ? "当前成员或密钥没有连接权限，请检查工作区权限。" : "连接未通过，请确认服务端已启用创作工具，且密钥属于当前工作区。");
      }
      const mcp = await fetch(config.mcpUrl, {
        method: "POST", credentials: "omit", redirect: "error", signal: controller.signal,
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "X-API-Key": secret },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "fanjin-connection-check", version: "1.0.0" } } }),
      });
      const text = await mcp.text();
      const data = JSON.parse(mcp.headers.get("content-type")?.includes("text/event-stream") ? text.split("\n").find(line => line.startsWith("data: "))?.slice(6) || "{}" : text);
      if (!mcp.ok || !data.result?.protocolVersion || data.error) throw new Error("CLI 已连接，MCP 握手未通过；请检查 mcp:connect 权限与服务端版本。");
      if (controllerRef.current === controller) setResult({ ok: true, message: "CLI 鉴权与 MCP 握手均已通过，工作区一致。未发起生成、未扣费。" });
    } catch (error) {
      if (controllerRef.current === controller) setResult({ ok: false, message: controller.signal.aborted ? "连接超时，请检查网络后重试。" : error instanceof Error ? error.message : "连接失败，请重试。" });
    } finally {
      window.clearTimeout(timer);
      if (controllerRef.current === controller) { controllerRef.current = null; setChecking(false); }
    }
  }

  return <section className="toolSetup" aria-label="连接配置">
    <div className="toolSetupHeading"><TerminalSquare size={18} aria-hidden="true" /><h3>连接你的工具</h3></div>
    <p>CLI 和本地 MCP 需要 Node.js 22+。在下载的 fanjin-cli 源码目录执行 <code>npm link</code>，确认 <code>fanjin --help</code> 可用。远程 MCP 无需安装 CLI。</p>
    <div className="toolFormatButtons" role="group" aria-label="连接方式">
      {([['cli', 'CLI'], ['stdio', '本地 MCP'], ['http', '远程 MCP']] as const).map(([value, label]) => <Button key={value} variant={format === value ? "primary" : "secondary"} aria-pressed={format === value} onClick={() => { setFormat(value); setCopyMessage(""); }}>{label}</Button>)}
    </div>
    <p>{format === "cli" ? "在终端设置环境变量，再运行身份检查。" : format === "stdio" ? "将配置加入支持 stdio 的 MCP 客户端；找不到 fanjin 时，将 command 改为它的绝对路径。" : "选择 Streamable HTTP，填写下方服务地址和认证请求头。"}</p>
    <pre className="toolConfigCode" tabIndex={0} aria-label="配置内容"><code>{snippet}</code></pre>
    {!secret && <p>配置中的占位符须替换为创建或轮换时保存的完整密钥；列表中的掩码不能用于连接。</p>}
    <div className="toolSetupActions">
      <Button variant="secondary" icon={<Copy size={16} aria-hidden="true" />} onClick={async () => {
        try { const copied = await onCopy(snippet); setCopyMessage(copied === false ? "复制失败，请手动复制上方内容。" : "已复制配置，请妥善保存。"); }
        catch { setCopyMessage("复制失败，请手动复制上方内容。"); }
      }}>复制{format === "cli" ? " CLI 配置" : format === "stdio" ? " MCP 配置" : "远程连接信息"}</Button>
      {secret && <Button variant="secondary" icon={result?.ok ? <CheckCircle2 size={16} /> : <Cable size={16} />} loading={checking} onClick={() => void checkConnection()}>检测连接（不扣费）</Button>}
    </div>
    {copyMessage && <p role="status">{copyMessage}</p>}
    {result && <Alert tone={result.ok ? "success" : "danger"}>{result.message}</Alert>}
  </section>;
}
