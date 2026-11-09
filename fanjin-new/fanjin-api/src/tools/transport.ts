import { requestCommercialTenant } from "@/lib/commercialTenant";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import express, { type Request, type RequestHandler } from "express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { assertToolSize, ToolError, toolDefinitions, toolFailure, MAX_TOOL_BYTES } from "./contracts";
import type { ToolConnection, ToolService } from "./service";
import { mcpPresence, type McpPresenceStore } from "./presence";

type TransportOptions = {
  authenticate: RequestHandler;
  service: () => Promise<ToolService>;
  origins?: string[];
  allowLocal?: boolean;
  presence?: McpPresenceStore;
};
const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function transportGuard(options: TransportOptions): RequestHandler {
  return (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      // Origins come from operator configuration, never the request's Host header.
      const origins = options.origins ?? [
        "https://fanjin.top", process.env.FANJIN_PUBLIC_BASE_URL, process.env.FANJIN_APP_PUBLIC_URL,
        ...(process.env.FANJIN_TOOLS_ALLOWED_ORIGINS || "").split(","),
      ].filter((value): value is string => Boolean(value?.trim()));
      const allowed = origins.map((origin) => new URL(origin.trim()).origin);
      const local = options.allowLocal ?? (process.env.NODE_ENV === "test" || process.env.NODE_ENV === "dev" || process.env.NODE_ENV === "development");
      const target = new URL(`${req.protocol}://${req.get("host") || "invalid"}`);
      const isLocal = local && loopback.has(target.hostname);
      if (!isLocal && (target.protocol !== "https:" || !allowed.includes(target.origin))) {
        throw new ToolError("UNTRUSTED_ENDPOINT", "工具接口要求受信任的 HTTPS 地址", 403);
      }
      const origin = req.get("origin");
      if (origin && !allowed.includes(origin) && !(isLocal && origin === target.origin)) {
        throw new ToolError("UNTRUSTED_ORIGIN", "不允许此来源调用工具", 403);
      }
      if (Object.keys(req.query).some((key) => !["projectId", "canvasId"].includes(key))) {
        throw new ToolError("INVALID_QUERY", "密钥只能通过请求头传递，URL 仅支持 projectId / canvasId 参数");
      }
      if (req.method === "POST") {
        if (!req.is("application/json")) throw new ToolError("JSON_REQUIRED", "请使用 application/json", 415);
        if (Number(req.get("content-length") || 0) > MAX_TOOL_BYTES) throw new ToolError("PAYLOAD_TOO_LARGE", "工具请求过大", 413);
        assertToolSize(req.body);
      }
      next();
    } catch (error) {
      const failure = toolFailure(error, randomUUID());
      res.status(failure.status).json(failure.body);
    }
  };
}

function connectionFor(req: Request, transport: ToolConnection["transport"]): ToolConnection {
  const apiKeyId = (req as Request & { apiKey?: { id?: string } }).apiKey?.id;
  if (!apiKeyId) throw new ToolError("KEY_REQUIRED", "请提供有效的工作区 API Key", 401);
  const raw = req.query.projectId;
  const projectId = raw === undefined ? undefined : Number(raw);
  if (raw !== undefined && (typeof raw !== "string" || !/^\d+$/.test(raw) || !Number.isSafeInteger(projectId) || Number(projectId) <= 0)) {
    throw new ToolError("INVALID_PROJECT", "projectId 必须是正整数");
  }
  const rawCanvas = req.query.canvasId;
  const canvasId = rawCanvas === undefined ? undefined : Number(rawCanvas);
  if (rawCanvas !== undefined && (!projectId || typeof rawCanvas !== "string" || !/^\d+$/.test(rawCanvas) || !Number.isSafeInteger(canvasId) || Number(canvasId) <= 0)) throw new ToolError("INVALID_CANVAS", "canvasId 必须与 projectId 一起提供，且为正整数");
  return { commercialTenant: requestCommercialTenant(req), apiKeyId, defaultCanvasId: canvasId, transport, source: transport === "mcp" ? "mcp" : /^fanjin-cli\//i.test(req.get("user-agent") || "") ? "cli" : "api", defaultProjectId: projectId };
}

export function createToolsHttpRouter(options: TransportOptions) {
  const router = express.Router();
  router.use(transportGuard(options), options.authenticate);
  router.put("/uploads/:uploadId/content", async (req, res) => {
    try {
      const input = z.strictObject({ uploadId: z.string().uuid(), projectId: z.coerce.number().int().positive(), contentLength: z.coerce.number().int().positive().max(2 * 1024 ** 3), contentType: z.string().min(1).max(150) }).parse({ uploadId: req.params.uploadId, projectId: req.query.projectId, contentLength: req.get("content-length"), contentType: req.get("content-type") });
      const service = await options.service(), identity = await service.authorize(connectionFor(req, "http"), "fanjin_upload_prepare");
      if (!service.creation) throw new ToolError("TOOL_UNAVAILABLE", "上传未配置", 503);
      const data = await service.creation.writeUpload(identity, input, req);
      res.json({ apiVersion: "fanjin-tools/v1", requestId: randomUUID(), ok: true, data });
    } catch (error) {
      const failure = toolFailure(error instanceof z.ZodError ? new ToolError("INVALID_ARGUMENTS", "上传参数无效") : error, randomUUID());
      if (!res.headersSent) res.status(failure.status).json(failure.body);
    }
  });
  router.get("/assets/:assetId/versions/:assetVersionId/content", async (req, res) => {
    try {
      const input = z.strictObject({ projectId: z.coerce.number().int().positive(), assetId: z.coerce.number().int().positive(), assetVersionId: z.coerce.number().int().positive() }).parse({ ...req.params, projectId: req.query.projectId });
      const service = await options.service(), identity = await service.authorize(connectionFor(req, "http"), "fanjin_asset_download");
      if (!service.creation) throw new ToolError("TOOL_UNAVAILABLE", "下载未配置", 503);
      const result = await service.creation.download(identity, input);
      res.set({ "Content-Type": result.mimeType, "Content-Length": String(result.sizeBytes), "Content-Disposition": `attachment; filename="asset-${input.assetId}"`, "X-Content-Type-Options": "nosniff" });
      await pipeline(result.stream, res);
    } catch (error) {
      const failure = toolFailure(error, randomUUID());
      if (!res.headersSent) res.status(failure.status).json(failure.body); else res.destroy();
    }
  });
  router.post("/:toolName", async (req, res) => {
    try {
      const connection = connectionFor(req, "http");
      const result = await (await options.service()).execute(connection, String(req.params.toolName), req.body);
      res.status(result.status).json(result.body);
    } catch (error) {
      const failure = toolFailure(error, randomUUID());
      res.status(failure.status).json(failure.body);
    }
  });
  router.all("/:toolName", (_req, res) => res.set("Allow", "POST").sendStatus(405));
  return router;
}

export async function createFanjinMcpServer(service: ToolService, connection: ToolConnection) {
  const server = new McpServer({ name: "fanjin-platform", version: "0.3.0" });
  for (const name of await service.discover(connection)) {
    const definition = toolDefinitions[name];
    server.registerTool(name, {
      title: definition.title, description: definition.description, inputSchema: definition.schema,
      annotations: { readOnlyHint: "readOnly" in definition ? definition.readOnly : true, destructiveHint: ["fanjin_studio_execute", "fanjin_canvas_graph_edit"].includes(name), idempotentHint: name !== "fanjin_studio_execute", openWorldHint: name === "fanjin_generation_submit" || name === "fanjin_portrait_asset_register" || ["fanjin_studio_execute", "fanjin_canvas_graph_edit"].includes(name) },
    }, async (input: unknown) => {
      const { body } = await service.execute(connection, name, input);
      return { content: [{ type: "text" as const, text: JSON.stringify(body) }], structuredContent: body, isError: !body.ok };
    });
  }
  return server;
}

export function createToolsMcpRouter(options: TransportOptions) {
  const router = express.Router();
  router.use(transportGuard(options), options.authenticate);
  router.post("/presence", async (req, res) => {
    try {
      const input = z.strictObject({ connectionId: z.string().uuid(), action: z.enum(["heartbeat", "disconnect"]), transport: z.literal("stdio") }).parse(req.body);
      const identity = await (await options.service()).authorize(connectionFor(req, "mcp"), "fanjin_context_get");
      await (options.presence || mcpPresence)({ workspaceId: identity.workspaceId, userId: identity.userId, keyId: identity.keyId }, input.connectionId, input.action);
      res.json({ ok: true, heartbeatIntervalMs: 15_000 });
    } catch (error) {
      const failure = toolFailure(error instanceof z.ZodError ? new ToolError("INVALID_ARGUMENTS", "连接状态参数无效") : error, randomUUID());
      res.status(failure.status).json(failure.body);
    }
  });
  router.post("/", async (req, res) => {
    let handler: ReturnType<typeof createMcpHandler> | undefined;
    try {
      const connection = connectionFor(req, "mcp");
      const service = await options.service();
      await service.discover(connection);
      handler = createMcpHandler(() => createFanjinMcpServer(service, connection), { legacy: "stateless", onerror: () => undefined });
      await toNodeHandler(handler)(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) {
        const failure = toolFailure(error, randomUUID());
        res.status(failure.status).json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: failure.body.error!.message, data: { code: failure.body.error!.code, requestId: failure.body.requestId } } });
      }
    } finally { await handler?.close().catch(() => undefined); }
  });
  router.all("/", (_req, res) => res.set("Allow", "POST").sendStatus(405));
  return router;
}
