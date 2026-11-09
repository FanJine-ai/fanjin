#!/usr/bin/env node
// Only a fresh, disposable database is used. No provider is configured.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const api = path.join(root, "fanjin-new/fanjin-api");
const data = fs.mkdtempSync(path.join(os.tmpdir(), "fanjin-selfhost-smoke-"));
const port = Number(process.env.FANJIN_PUBLIC_SMOKE_PORT || 19692);
const password = crypto.randomBytes(24).toString("base64url");
const logDir = path.join(root, ".local-dev/open-source-20261102");
fs.mkdirSync(logDir, { recursive: true });
const log = fs.openSync(path.join(logDir, "platform-smoke-private.log"), "w", 0o600);
const child = spawn(process.execPath, ["build-public/app.cjs"], {
  cwd: api, stdio: ["ignore", log, log],
  env: {
    PATH: process.env.PATH || "", NODE_ENV: "development", FANJIN_PROCESS_ROLE: "all",
    FANJIN_DISABLE_LOCAL_ENV: "1", FANJIN_DISABLE_LOCAL_KEYCHAIN_SECRETS: "1",
    FANJIN_DATA_DIR: data, FANJIN_DATABASE_CLIENT: "sqlite",
    FANJIN_ROOT_PASSWORD: password, FANJIN_APP_PORT: String(port), FANJIN_BIND_HOST: "127.0.0.1",
    FANJIN_WEB_DIR: path.join(root, "fanjin-new/fanjin-v4/dist"),
    FANJIN_AUTO_MIGRATE: "1", FANJIN_DISABLE_BACKUP_SCHEDULER: "1",
    FANJIN_COMMUNITY_UPDATE_SECRET: crypto.randomBytes(32).toString("hex"),
  },
});
try {
  let ready = false;
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error("isolated product process exited; inspect private local smoke log");
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
      if (r.status === 200) { ready = true; break; }
    } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  if (!ready) throw new Error("isolated product health timeout; inspect private local smoke log");
  const page = await fetch(`http://127.0.0.1:${port}/`);
  const login = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "root", password }),
  });
  if (page.status !== 200 || login.status !== 200) throw new Error(`isolated product smoke failed: page ${page.status}, login ${login.status}`);
  const profile = (await login.json()).data;
  const request = async (url, body, token = profile.token, method = "POST", extraHeaders = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { authorization: token, "content-type": "application/json", ...extraHeaders }, ...(method === "GET" ? {} : { body: JSON.stringify(body) }) });
    const json = await r.json();
    if (r.status >= 400) throw new Error(`local smoke request ${url} returned ${r.status}`);
    return json.data;
  };
  const vendors = await request("/api/setting/vendorConfig/getVendorList", {});
  const official = vendors?.find(item => item.id === "fanjin-official");
  if (!official || official.enable !== 0 || official.models?.length !== 0
    || official.inputValues?.siteBaseUrl !== "https://fanjin.top"
    || official.inputValues?.apiKey) throw new Error("official relay preset must be available, configurable and disabled without credentials");
  // Exercise the full policy/audit chain, not only the isolated route handler.
  const managed = await request("/api/admin/releases/community-update", undefined, profile.token, "GET");
  if (managed?.managed !== true) throw new Error("managed updater entry was not available through the real admin middleware");
  const unconfirmedUpdate = await fetch(`http://127.0.0.1:${port}/api/admin/releases/community-update`, {
    method: "POST", headers: { authorization: profile.token, "content-type": "application/json" }, body: "{}",
  });
  if (unconfirmedUpdate.status !== 401 || (await unconfirmedUpdate.json()).data?.code !== "STEP_UP_REQUIRED") {
    throw new Error("updater capability must require administrator step-up");
  }
  const created = await request("/api/canvas/create", { name: "Synthetic smoke canvas" });
  created.projectId = Number(created.projectId);
  created.canvasId = Number(created.canvasId);
  const canvas = await request(`/api/canvas/load?canvasId=${created.canvasId}`, undefined, profile.token, "GET");
  const saved = await request("/api/canvas/save", { ...created, expectedRevision: canvas.revision, nodes: [{ id: "smoke-text", type: "text", x: 0, y: 0, text: "Synthetic smoke fixture" }], edges: [], groups: [] });
  if (!saved.revision) throw new Error("canvas save did not return a revision");
  const reloaded = await request(`/api/canvas/load?canvasId=${created.canvasId}`, undefined, profile.token, "GET");
  if (!JSON.stringify(reloaded).includes("Synthetic smoke fixture")) throw new Error("canvas content was not persisted");
  const stepUp = await request("/api/account/security/step-up", { scope: "api_key.create", password });
  const key = await request("/api/apiKeys/create", { name: "Synthetic smoke key", scope: "workspace", workspaceId: "default", permissions: ["mcp:connect", "project:read", "project:write", "asset:read", "asset:write", "asset:download", "generation:read"] }, profile.token, "POST", { "X-Fanjin-Step-Up": stepUp.proof });
  const tool = async (name, input) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/tools/v1/${name}`, { method: "POST", headers: { "x-api-key": key.apiKey, "content-type": "application/json" }, body: JSON.stringify(input) });
    const b = await r.json(); if (!b.ok) throw new Error(`local tool ${name} failed: ${b.error?.code || r.status}: ${b.error?.message || ""}`); return b.data;
  };
  await tool("fanjin_context_get", {});
  const bytes = Buffer.from("Synthetic document fixture. No personal or production data.\n");
  // The resumable tools upload requires S3/TOS. The local profile uses the
  // existing authenticated reference endpoint and verifies the stored bytes.
  const asset = await request("/api/assets/uploadReference", { projectId: created.projectId, name: "Synthetic document", type: "document", base64Data: `data:text/plain;base64,${bytes.toString("base64")}` });
  if (!asset.assetId) throw new Error("asset registration did not return assetId");
  const version = { projectId: created.projectId, assetId: Number(asset.assetId), assetVersionId: Number(asset.assetVersionId) };
  const stored = await tool("fanjin_asset_get", version);
  if (stored.asset.status !== "active") throw new Error("stored asset is not active");
  const download = await tool("fanjin_asset_download", version);
  if (!download.downloadPath?.startsWith("/api/tools/v1/assets/")) throw new Error("unexpected asset download path");
  const downloaded = await fetch(`http://127.0.0.1:${port}${download.downloadPath}`, { headers: { "x-api-key": key.apiKey } });
  if (downloaded.status !== 200 || !Buffer.from(await downloaded.arrayBuffer()).equals(bytes)) throw new Error("asset download bytes differ");
  const mcp = await fetch(`http://127.0.0.1:${port}/api/mcp`, { method: "POST", headers: { "x-api-key": key.apiKey, "content-type": "application/json", accept: "application/json, text/event-stream", "Mcp-Method": "initialize" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "public-smoke", version: "1" } } }) });
  if (mcp.status !== 200) throw new Error(`MCP initialization failed: ${mcp.status}`);
  const mcpBody = await mcp.text();
  if (!mcpBody.includes("fanjin-platform") || !mcpBody.includes("protocolVersion")) throw new Error("invalid MCP initialization result");
  const mcpAsset = await fetch(`http://127.0.0.1:${port}/api/mcp`, { method: "POST", headers: { "x-api-key": key.apiKey, "content-type": "application/json", accept: "application/json, text/event-stream", "Mcp-Method": "tools/call", "Mcp-Protocol-Version": "2025-03-26" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "fanjin_asset_get", arguments: version } }) });
  const mcpText = await mcpAsset.text();
  const mcpResult = JSON.parse(mcpText.startsWith("data:") || mcpText.startsWith("event:") ? mcpText.split("\n").find(line => line.startsWith("data: ")).slice(6) : mcpText);
  const result = mcpResult.result?.structuredContent;
  if (mcpAsset.status !== 200 || !result?.ok || Number(result.data?.asset?.assetId) !== version.assetId) throw new Error("MCP could not read the same uploaded asset");
  const require = createRequire(path.join(api, "package.json"));
  const Database = require("better-sqlite3"); const db = new Database(path.join(data, "db2.sqlite"), { readonly: true });
  const heartbeat = db.prepare("SELECT COUNT(*) AS n FROM o_worker_heartbeat WHERE heartbeatAt > ?").get(Date.now() - 60000).n; db.close();
  if (!heartbeat) throw new Error("Worker heartbeat missing");
  process.stdout.write(JSON.stringify({ ok: true, environment: "development bootstrap, not production release", database: "fresh disposable SQLite", processRole: "all (API + Worker)", health: 200, web: 200, login: 200, canvas: "create/load/save/reload", assets: "local upload/read/authenticated download with byte equality", mcp: "authenticated initialization and tools/call for the same uploaded asset", worker: "fresh persisted heartbeat", providersConfigured: 0, generationRequests: 0 }) + "\n");
} finally {
  child.kill("SIGTERM");
  await Promise.race([new Promise(r => child.once("exit", r)), new Promise(r => setTimeout(r, 5000))]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  fs.closeSync(log);
  fs.rmSync(data, { recursive: true, force: true });
}
