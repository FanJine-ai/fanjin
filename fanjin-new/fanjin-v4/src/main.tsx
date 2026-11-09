import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { applyFontSizePreference } from "./components/setting/preferencesStorage";
import { loadTenantRuntime } from "./lib/tenant-runtime";
import { isIsolatedSessionProofPage } from "./utils/isolatedSessionProofMode";
import "./utils/global";
import "./styles.css";

function normalizeHashRouterUrl() {
  const { pathname, search, hash } = window.location;

  if (hash.startsWith("#/") && (pathname === "/login" || pathname === "/auth/login")) {
    window.history.replaceState(null, "", `/${hash}`);
    return;
  }

  if (hash) return;
  const directCanvasPath =
    pathname === "/infinite-canvas-v2" ||
    pathname === "/canvas" ||
    pathname.startsWith("/canvas/") ||
    pathname === "/workbench/canvas" ||
    pathname === "/workbench/canvas/editor" ||
    pathname.startsWith("/workbench/canvas/editor/");
  const directEntryPath = pathname === "/login" || pathname === "/workbench" || pathname.startsWith("/auth/") || pathname === "/workbench/create";
  if (directCanvasPath || directEntryPath) {
    window.history.replaceState(null, "", `/#${pathname}${search}`);
  }
}

normalizeHashRouterUrl();
applyFontSizePreference();

async function bootstrap() {
  await loadTenantRuntime();
  // Hash-router creation must happen after direct entry URLs are normalized.
  const { default: App } = await import("./App");
  const app = <App />;
  const rootContent = isIsolatedSessionProofPage(window.location, import.meta.env.DEV)
    ? app
    : (
      <StrictMode>
        {app}
      </StrictMode>
    );
  createRoot(document.getElementById("root")!).render(rootContent);
}

void bootstrap();
