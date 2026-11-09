import http from "node:http";
import express, { type Request, type RequestHandler } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createToolsFixture } from "../helpers/fanjinToolsFixture";
import type { McpPresenceStore } from "@/tools/presence";
import { MAX_TOOL_BYTES } from "@/tools/contracts";
import { createToolsHttpRouter, createToolsMcpRouter } from "@/tools/transport";

let fixture: Awaited<ReturnType<typeof createToolsFixture>>;
const servers: http.Server[] = [];
beforeEach(async () => { fixture = await createToolsFixture(); });
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  })));
  await fixture.close();
});

async function start(options: { allowLocal?: boolean; bindIdentity?: boolean; presence?: McpPresenceStore } = {}) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  // Transport tests isolate API key parsing; the shared service still reads live authorization rows.
  const authenticate: RequestHandler = (req, res, next) => {
    if (req.get("x-api-key") !== "test-key") { res.status(401).json({ error: "Unauthorized" }); return; }
    if (options.bindIdentity !== false) (req as Request & { apiKey: { id: string } }).apiKey = { id: "key-a" };
    next();
  };
  const shared = { authenticate, service: async () => fixture.service, allowLocal: options.allowLocal ?? true, origins: ["https://fanjin.top"], presence: options.presence };
  app.use("/api/tools/v1", createToolsHttpRouter(shared));
  app.use("/api/mcp", createToolsMcpRouter(shared));
  const server = http.createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test listener");
  return `http://127.0.0.1:${address.port}`;
}

async function post(url: string, body: unknown, extra: Record<string, string> = {}) {
  const response = await fetch(url, { method: "POST", headers: {
    "Content-Type": "application/json", Accept: "application/json, text/event-stream", "X-API-Key": "test-key", ...extra,
  }, body: JSON.stringify(body) });
  const raw = await response.text();
  const payload = response.headers.get("content-type")?.includes("text/event-stream")
    ? raw.split("\n").find((line) => line.startsWith("data: "))?.slice(6) ?? raw : raw;
  return { response, body: JSON.parse(payload) as Record<string, any> };
}

function rpc(url: string, method: string, params: Record<string, unknown> = {}) {
  return post(`${url}/api/mcp`, { jsonrpc: "2.0", id: 1, method, params }, {
    "MCP-Protocol-Version": "2025-11-25", "Mcp-Method": method, "Mcp-Name": "fanjin-platform",
  });
}

describe("Fanjin tool HTTP and MCP transports", () => {
  it("returns identical business data through REST and a real MCP tool call", async () => {
    const url = await start();
    const httpResult = await post(`${url}/api/tools/v1/fanjin_billing_balance`, {});
    const mcpResult = await rpc(url, "tools/call", { name: "fanjin_billing_balance", arguments: {} });
    expect(httpResult.response.status).toBe(200);
    expect(mcpResult.response.status).toBe(200);
    expect(mcpResult.body.result.isError).toBe(false);
    expect(mcpResult.body.result.structuredContent.data).toEqual(httpResult.body.data);
    expect(JSON.parse(mcpResult.body.result.content[0].text).data).toEqual(httpResult.body.data);
    expect(httpResult.body.data.balance.gu).toBe("12.3456789");
    expect(httpResult.response.headers.get("cache-control")).toBe("no-store");
  });

  it("supports legacy initialization and modern discovery", async () => {
    const url = await start();
    const legacy = await rpc(url, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(legacy.body.result.serverInfo.name).toBe("fanjin-platform");
    const modern = await post(`${url}/api/mcp`, { jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {},
      "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
    } } }, { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "server/discover", "Mcp-Name": "fanjin-platform" });
    expect(modern.response.status).toBe(200);
    expect(modern.body.result.supportedVersions).toContain("2026-07-28");
  });

  it("advertises only permitted read-only tools and validates their inputs", async () => {
    await fixture.db("o_api_key").update({ permissions: '["mcp:connect","project:read"]' });
    const url = await start();
    const listed = await rpc(url, "tools/list");
    expect(listed.body.result.tools.map((tool: any) => tool.name)).toEqual([
      "fanjin_canvas_execution_plan", "fanjin_human_continue",
      "fanjin_context_get", "fanjin_projects_list", "fanjin_project_get", "fanjin_canvas_get",
    ]);
    expect(listed.body.result.tools.every((tool: any) => tool.annotations.readOnlyHint && !tool.annotations.destructiveHint)).toBe(true);
    const invalid = await rpc(url, "tools/call", { name: "fanjin_projects_list", arguments: { workspaceId: "ws-b" } });
    expect(Boolean(invalid.body.error || invalid.body.result?.isError)).toBe(true);
  });

  it("rechecks MCP access and membership on every request", async () => {
    const url = await start();
    expect((await rpc(url, "tools/list")).body.result.tools).toHaveLength(15);
    await fixture.db("o_api_key").update({ permissions: '["project:read"]' });
    expect((await rpc(url, "tools/list")).response.status).toBe(403);
    expect((await post(`${url}/api/tools/v1/fanjin_projects_list`, {})).response.status).toBe(200);
    await fixture.db("o_workspace_member").update({ status: "inactive" });
    expect((await post(`${url}/api/tools/v1/fanjin_projects_list`, {})).response.status).toBe(403);
  });

  it("rechecks revocation rather than trusting a previously accepted identity", async () => {
    const url = await start();
    expect((await rpc(url, "tools/list")).response.status).toBe(200);
    await fixture.db("o_api_key").update({ revokedAt: 100 });
    expect((await rpc(url, "tools/list")).response.status).toBe(401);
    expect((await post(`${url}/api/tools/v1/fanjin_context_get`, {})).response.status).toBe(401);
  });

  it("keeps project binding within the caller's workspace", async () => {
    const url = await start();
    const own = await post(`${url}/api/tools/v1/fanjin_project_get?projectId=1`, {});
    expect(own.body.data.project.id).toBe(1);
    expect((await post(`${url}/api/tools/v1/fanjin_project_get?projectId=3`, {})).response.status).toBe(404);
    expect((await post(`${url}/api/tools/v1/fanjin_project_get?projectId=-1`, {})).response.status).toBe(400);
    const other = await rpc(url, "tools/call", { name: "fanjin_canvas_get", arguments: { projectId: 1, canvasId: 2 } });
    expect(other.body.result.structuredContent.error.code).toBe("CANVAS_NOT_FOUND");
  });

  it.each(["/api/tools/v1/fanjin_context_get", "/api/mcp"])("requires a bound API key for %s", async (path) => {
    const url = await start({ bindIdentity: false });
    expect((await post(`${url}${path}`, {}, { "X-API-Key": "wrong" })).response.status).toBe(401);
    expect((await post(`${url}${path}`, {})).response.status).toBe(401);
  });

  it.each(["?key=test-key", "?apiKey=test-key", "?token=test-key"])("rejects credentials in URL %s", async (query) => {
    const url = await start();
    const result = await post(`${url}/api/mcp${query}`, {});
    expect(result.response.status).toBe(400);
    expect(JSON.stringify(result.body)).not.toContain("test-key");
  });

  it("rejects hostile origins, insecure remote hosts and production loopback", async () => {
    const url = await start();
    const path = `${url}/api/tools/v1/fanjin_context_get`;
    expect((await post(path, {}, { Origin: "https://evil.example" })).response.status).toBe(403);
    const hostileHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const request = http.request(path, { method: "POST", headers: {
        Host: "evil.example", "Content-Type": "application/json", "X-API-Key": "test-key",
      } }, (response) => { response.resume(); response.on("end", () => resolve(response.statusCode)); });
      request.on("error", reject);
      request.end("{}");
    });
    expect(hostileHostStatus).toBe(403);
    expect((await post(path, {}, { Origin: url })).response.status).toBe(200);
    const production = await start({ allowLocal: false });
    expect((await post(`${production}/api/tools/v1/fanjin_context_get`, {})).response.status).toBe(403);
  });

  it("enforces body size, content type and read-only method boundaries", async () => {
    const url = await start();
    const path = `${url}/api/tools/v1/fanjin_context_get`;
    expect((await post(path, {}, { "Content-Type": "text/plain" })).response.status).toBe(415);
    expect((await post(path, { data: "x".repeat(MAX_TOOL_BYTES) })).response.status).toBe(413);
    expect((await post(`${url}/api/tools/v1/fanjin_generate`, {})).response.status).toBe(404);
    for (const route of [path, `${url}/api/mcp`]) {
      for (const method of ["GET", "DELETE"]) {
        const response = await fetch(route, { method, headers: { "X-API-Key": "test-key" } });
        expect(response.status).toBe(405);
        expect(response.headers.get("allow")).toBe("POST");
        await response.body?.cancel();
      }
    }
  });
});

describe("MCP local bridge presence authentication", () => {
  const payload = { connectionId: "11111111-1111-4111-8111-111111111111", action: "heartbeat", transport: "stdio" };
  it("binds heartbeat to the live key identity; initialization alone does not signal presence", async () => {
    const presence = vi.fn().mockResolvedValue({ count: 1, remainingMs: 45000 });
    const url = await start({ presence });
    await rpc(url, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "fanjin-connection-check", version: "1" } });
    expect(presence).not.toHaveBeenCalled();
    expect((await post(`${url}/api/mcp/presence`, payload)).response.status).toBe(200);
    expect(presence).toHaveBeenCalledWith({ workspaceId: "ws-a", userId: 1, keyId: "key-a" }, payload.connectionId, "heartbeat");
    expect((await post(`${url}/api/mcp/presence`, { ...payload, workspaceId: "ws-b" })).response.status).toBe(400);
    expect((await post(`${url}/api/mcp/presence`, { ...payload, action: "disconnect" })).response.status).toBe(200);
    expect(presence).toHaveBeenLastCalledWith({ workspaceId: "ws-a", userId: 1, keyId: "key-a" }, payload.connectionId, "disconnect");
  });
  it("rejects revoked keys and removed MCP permission before touching presence", async () => {
    const presence = vi.fn(); const url = await start({ presence });
    await fixture.db("o_api_key").update({ permissions: '["project:read"]' });
    expect((await post(`${url}/api/mcp/presence`, payload)).response.status).toBe(403);
    await fixture.db("o_api_key").update({ permissions: '["*"]', revokedAt: 100 });
    expect((await post(`${url}/api/mcp/presence`, payload)).response.status).toBe(401);
    expect(presence).not.toHaveBeenCalled();
  });
});
