import { useV4Theme } from "../../ui/useV4Theme";
import "../frontstage/FrontstagePage.css";
import { AlertTriangle, House, RefreshCw } from "lucide-react";
import { isRouteErrorResponse, useRouteError } from "react-router-dom";

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message || "");
  }
  return "";
}

export function isChunkLoadError(error: unknown): boolean {
  return /ChunkLoadError|Loading chunk [^ ]+ failed|Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(errorText(error));
}

export function routeErrorContent(error: unknown): { title: string; message: string; chunkLoadError: boolean } {
  const chunkLoadError = isChunkLoadError(error);
  if (chunkLoadError) {
    return {
      title: "应用已更新",
      message: "页面资源版本已发生变化，刷新后即可继续使用。",
      chunkLoadError,
    };
  }
  if (isRouteErrorResponse(error) && error.status === 404) {
    return {
      title: "页面不存在",
      message: "这个地址可能已被移动或删除，请返回首页继续。",
      chunkLoadError,
    };
  }
  return {
    title: "页面暂时无法打开",
    message: "我们没有丢失你的登录状态。你可以重试，或先返回首页。",
    chunkLoadError,
  };
}

export default function RootRouteError() {
  const theme = useV4Theme();
  const error = useRouteError();
  const content = routeErrorContent(error);

  return (
    <main
      role="alert" className="frontPagePalette" data-theme={theme.mode}
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        boxSizing: "border-box",
        padding: 24,
        color: "var(--front-text)",
        background: "var(--front-soft)",
      }}
    >
      <section
        style={{
          width: "min(100%, 480px)",
          padding: "36px 32px",
          border: "1px solid rgba(120,120,128,0.18)",
          borderRadius: 24,
          background: "var(--front-surface)",
          boxShadow: "0 22px 60px rgba(27,45,66,0.12)",
          textAlign: "center",
        }}
      >
        <span style={{ width: 52, height: 52, margin: "0 auto 18px", display: "grid", placeItems: "center", borderRadius: 16, color: "#5d94bd", background: "rgba(93,148,189,0.12)" }}>
          <AlertTriangle size={25} aria-hidden="true" />
        </span>
        <h1 style={{ margin: 0, fontSize: 24, lineHeight: 1.25 }}>{content.title}</h1>
        <p style={{ margin: "12px auto 24px", color: "var(--front-muted)", fontSize: 14, lineHeight: 1.7 }}>{content.message}</p>
        <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 10 }}>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{ minHeight: 40, display: "inline-flex", alignItems: "center", gap: 7, padding: "0 16px", border: 0, borderRadius: 9, color: "#fff", background: "#5d94bd", cursor: "pointer", font: "inherit", fontSize: 14, fontWeight: 650 }}
          >
            <RefreshCw size={16} aria-hidden="true" />
            {content.chunkLoadError ? "刷新并继续" : "重新加载"}
          </button>
          <a
            href="#/"
            style={{ minHeight: 40, display: "inline-flex", alignItems: "center", gap: 7, boxSizing: "border-box", padding: "0 16px", border: "1px solid #d4d4d8", borderRadius: 9, color: "var(--front-text)", background: "var(--front-surface)", textDecoration: "none", fontSize: 14, fontWeight: 650 }}
          >
            <House size={16} aria-hidden="true" />
            返回首页
          </a>
        </div>
      </section>
    </main>
  );
}
