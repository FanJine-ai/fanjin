import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { searchForWorkspaceRoot } from "vite";
import { defineConfig } from "vitest/config";
import { apiProxyPlugin } from "./vite-plugin-api-proxy";
import { resolveFrontendBuildId } from "./src/config/buildIdentity";
import { createApiAndMediaProxy } from "./src/config/viteProxy";

function readProductVersion(): string {
  const explicit = process.env.VITE_APP_VERSION?.trim();
  if (explicit) return explicit;
  const apiPackagePath = fileURLToPath(new URL("../fanjin-api/package.json", import.meta.url));
  const apiPackage = JSON.parse(readFileSync(apiPackagePath, "utf8")) as { version?: unknown };
  return typeof apiPackage.version === "string" && apiPackage.version.trim()
    ? apiPackage.version.trim()
    : "unknown";
}

const productVersion = readProductVersion();

export default defineConfig({
  plugins: [react(), tailwindcss(), apiProxyPlugin()],
  define: {
    "import.meta.env.VITE_APP_VERSION": JSON.stringify(productVersion),
    "import.meta.env.VITE_BUILD_ID": JSON.stringify(
      resolveFrontendBuildId(process.env, productVersion),
    ),
  },
  test: {
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 50289,
    // Local worktrees may share dependencies; serve their real font/asset paths.
    fs: {
      allow: [
        searchForWorkspaceRoot(fileURLToPath(new URL(".", import.meta.url))),
        realpathSync(fileURLToPath(new URL("./node_modules", import.meta.url))),
      ],
    },
    proxy: createApiAndMediaProxy(
      process.env.VITE_API_PROXY_TARGET || "http://127.0.0.1:10589",
    ),
  },
  preview: {
    host: "127.0.0.1",
    proxy: createApiAndMediaProxy(
      process.env.VITE_API_PROXY_TARGET || "http://127.0.0.1:10589",
    ),
  },
});
