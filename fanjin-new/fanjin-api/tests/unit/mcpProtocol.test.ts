import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";

type RunningMcp = {
  server: http.Server;
  url: string;
  close: () => Promise<void>;
};

const runningServers: RunningMcp[] = [];

async function startMcpServer(): Promise<RunningMcp> {
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/mcp") {
      res.writeHead(404).end();
      return;
    }

    void nodeHandler(req, res).catch((error: unknown) => {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
    });
  });

  const handler = createMcpHandler(
    () => new McpServer({ name: "mcp-protocol-test", version: "1.0.0" }),
    { legacy: "stateless" },
  );
  const nodeHandler = toNodeHandler(handler);

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("MCP test server did not bind");
  const running = { server, url: `http://127.0.0.1:${address.port}/mcp`, close: handler.close };
  runningServers.push(running);
  return running;
}

async function postMcp(
  url: string,
  body: Record<string, unknown>,
  protocolVersion?: string,
  accept = "application/json, text/event-stream",
) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept,
      "Mcp-Method": String(body.method || ""),
      "Mcp-Name": "mcp-protocol-test",
      ...(protocolVersion ? { "MCP-Protocol-Version": protocolVersion } : {}),
    },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  const payload = response.headers.get("content-type")?.includes("text/event-stream")
    ? raw.split("\n").find((line) => line.startsWith("data: "))?.slice(6) ?? raw
    : raw;
  return { response, body: JSON.parse(payload) as Record<string, any> };
}

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map(async ({ server, close }) => {
    await close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }));
});

describe("MCP protocol v2 transport", () => {
  it("serves the 2026-07-28 discovery request without a session", async () => {
    const { url } = await startMcpServer();
    const { response, body } = await postMcp(url, {
      jsonrpc: "2.0",
      id: 1,
      method: "server/discover",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": { name: "modern-client", version: "1.0.0" },
        },
      },
    }, "2026-07-28");

    expect(response.status).toBe(200);
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(1);
    expect(body.result).toMatchObject({
      supportedVersions: ["2026-07-28"],
    });
  });

  it("continues to accept the legacy initialize request", async () => {
    const { url } = await startMcpServer();
    const { response, body } = await postMcp(url, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "legacy-client", version: "1.0.0" },
      },
    });

    expect(response.status).toBe(200);
    expect(body.jsonrpc).toBe("2.0");
    expect(body.result).toMatchObject({
      protocolVersion: "2025-11-25",
      serverInfo: { name: "mcp-protocol-test", version: "1.0.0" },
    });
  });
});
