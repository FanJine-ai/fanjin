import { useEffect, useState } from "react";
import { apiGet } from "@/api/http";
import { useAuthStore } from "@/stores/authStore";
import "./LocalMcpStatus.css";

type Presence = { connected: boolean; connectionCount: number; validForMs: number };
type State = { scope: string; status: "checking" | "connected" | "disconnected" | "unknown"; count: number };

export default function LocalMcpStatus() {
  const userId = useAuthStore(state => state.user?.id);
  const workspaceId = useAuthStore(state => state.currentWorkspace?.id);
  const token = useAuthStore(state => state.token);
  const scope = JSON.stringify([userId, workspaceId, token]);
  const [state, setState] = useState<State>({ scope: "", status: "checking", count: 0 });
  useEffect(() => {
    if (!userId || !workspaceId || !token) return;
    let disposed = false, pending = false;
    let controller: AbortController | undefined;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const update = (status: State["status"], count = 0) => { if (!disposed) setState({ scope, status, count }); };
    const offline = () => { controller?.abort(); clearTimeout(expiry); update("unknown"); };
    async function refresh() {
      if (pending || disposed || document.visibilityState === "hidden") return;
      if (!navigator.onLine) { offline(); return; }
      pending = true;
      controller = new AbortController();
      const requestController = controller;
      const deadline = setTimeout(() => requestController.abort(), 4_000);
      const requestedAt = Date.now();
      try {
        const result = await apiGet<Presence>("/workspace/mcpStatus", undefined, { signal: requestController.signal });
        if (disposed || requestController.signal.aborted) return;
        clearTimeout(expiry);
        const remaining = Math.min(45_000, Number(result.validForMs)) - (Date.now() - requestedAt);
        if (result.connected === true && Number.isSafeInteger(result.connectionCount) && result.connectionCount > 0 && remaining > 0) {
          update("connected", result.connectionCount);
          expiry = setTimeout(() => update("disconnected"), remaining);
        } else update("disconnected");
      } catch { if (!disposed) { clearTimeout(expiry); update("unknown"); } }
      finally { clearTimeout(deadline); pending = false; }
    }
    update("checking");
    void refresh();
    const timer = setInterval(() => void refresh(), 5_000);
    const resume = () => { void refresh(); };
    window.addEventListener("offline", offline);
    window.addEventListener("online", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      disposed = true; controller?.abort(); clearInterval(timer); clearTimeout(expiry);
      window.removeEventListener("offline", offline); window.removeEventListener("online", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [scope, userId, workspaceId, token]);
  if (!userId || !workspaceId || !token) return null;
  const current = state.scope === scope ? state : { status: "checking", count: 0 };
  const label = current.status === "connected" ? "本地 MCP 已连接"
    : current.status === "disconnected" ? "本地 MCP 未连接"
    : current.status === "unknown" ? "本地 MCP 状态未知" : "正在检查本地 MCP";
  return <span className={`localMcpStatus localMcpStatus--${current.status}`} role="status" aria-live="polite"
    title={current.status === "connected" ? `当前账号在此工作区有 ${current.count} 个本地 MCP 连接` : "显示当前账号在此工作区的本地 MCP 连接状态"}>
    <span className="localMcpStatusDot" aria-hidden="true" /><span>{label}</span>
  </span>;
}
