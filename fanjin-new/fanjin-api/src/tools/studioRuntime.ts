import { adminOperationPolicyMiddleware } from "@/middleware/adminOperationPolicy";
import { adminStepUpMiddleware, resolveAdminStepUpScope } from "@/middleware/adminStepUp";
import { humanContinuation } from "./humanContinuation";
import express from "express";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import type { Knex } from "knex";
import { guardProjectScopedRoutes, checkProjectPermission } from "@/middleware/projectAccess";
import { membershipHttpGuard } from "@/middleware/membership";
import { runBillingContext } from "@/lib/billingContext";
import { ToolError, MAX_TOOL_BYTES } from "./contracts";
import { studioOperation, type StudioOperation } from "./studioCatalog";
import type { ToolIdentity } from "./creationService";

export type StudioGateway = (identity: ToolIdentity, operation: StudioOperation, input: Record<string, any>) => Promise<Record<string, unknown>>;

export function resolveStudioRequest(operation: StudioOperation, input: Record<string, any>) {
  const parameters = { ...input };
  const pathKeys = new Set<string>();
  const path = `${operation.mount}${operation.path === "/" ? "" : operation.path}`.replace(/:([A-Za-z0-9_]+)/g, (_, key) => {
    pathKeys.add(key);
    const value = String(parameters[key] ?? "");
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(value)) throw new ToolError("INVALID_PATH_PARAMETER", `${key} 格式不正确`);
    return encodeURIComponent(value);
  });
  for (const key of pathKeys) delete parameters[key];
  const idempotencyKey = parameters.idempotencyKey;
  if (!operation.bodyIdempotency) delete parameters.idempotencyKey;
  const query = new URLSearchParams();
  if (operation.method === "GET" || operation.method === "DELETE") {
    for (const [key, value] of Object.entries(parameters)) {
      if (value === undefined || value === null) continue;
      for (const item of Array.isArray(value) ? value : [value]) {
        if (!["string", "number", "boolean"].includes(typeof item)) throw new ToolError("INVALID_QUERY_PARAMETER", `${key} 必须是简单值`);
        query.append(key, String(item));
      }
    }
  }
  return { url: `${path}${query.size ? `?${query}` : ""}`, body: query.size || ["GET", "DELETE"].includes(operation.method) ? {} : parameters, idempotencyKey };
}

/** Execute a closed, authenticated business request in-process. No network,
 * forged session, credential header, arbitrary route or recursive MCP call. */
export async function invokeStudioRouter(app: express.Express, operation: StudioOperation, identity: ToolIdentity, input: Record<string, any>, timeoutMs = 60_000): Promise<{ status: number; body: any }> {
  const call = resolveStudioRequest(operation, input);
  const req = new IncomingMessage(new Socket()) as express.Request;
  req.method = operation.method; req.url = call.url;
  req.headers = { "content-type": "application/json", ...(call.idempotencyKey ? { "idempotency-key": call.idempotencyKey } : {}) };
  req.body = call.body;
  // A scoped key is never promoted to a privileged human session. Canonical
  // guards still reload live membership and enforce business authorization.
  (req as any).auth = { user: { id: identity.userId, role: "user", workspaceId: identity.workspaceId }, workspaceId: identity.workspaceId, session: null };
  (req as any).user = (req as any).auth.user;
  (req as any).commercialTenant = identity.commercialTenant;
  (req as any).requestId = `mcp-studio-${crypto.randomUUID()}`;
  (req as any).studioOperation = operation.name;
  const res = new ServerResponse(req) as express.Response;
  return new Promise((resolve, reject) => {
    let finished = false, size = 0;
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => finish(new ToolError("OPERATION_TIMEOUT", "操作尚未返回，请先查询当前状态，勿重复提交写入", 504)), timeoutMs);
    const finish = (error?: unknown) => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      if (error) { reject(error); return; }
      const value = Buffer.concat(chunks).toString("utf8");
      try { resolve({ status: res.statusCode, body: value ? JSON.parse(value) : {} }); }
      catch { reject(new ToolError("NON_JSON_OPERATION_RESULT", "此操作未返回结构化结果，请使用对应下载入口", 502)); }
    };
    const collect = (data: any, encoding?: any) => {
      if (data == null || finished) return;
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(String(data), typeof encoding === "string" ? encoding as BufferEncoding : "utf8");
      size += chunk.length;
      if (size > MAX_TOOL_BYTES) { finish(new ToolError("RESULT_TOO_LARGE", "结果过大，请缩小分页或查询范围", 413)); return; }
      chunks.push(chunk);
    };
    // Use real Express response methods/headers; capture only the JSON body.
    res.write = ((data: any, encoding?: any, callback?: any) => { collect(data, encoding); if (typeof encoding === "function") encoding(); else callback?.(); return !finished; }) as any;
    res.end = ((data?: any, encoding?: any, callback?: any) => { collect(data, encoding); finish(); res.emit("finish"); if (typeof encoding === "function") encoding(); else callback?.(); return res; }) as any;
    app(req, res, (error?: unknown) => finish(error || new ToolError("OPERATION_ROUTE_MISSING", "业务接口未注册", 503)));
  });
}

export function createStudioGateway(db: Knex): StudioGateway {
  const apps = new Map<string, Promise<express.Express>>();
  return async (identity, operation, input) => {
    if (studioOperation(operation.name) !== operation) throw new ToolError("OPERATION_NOT_FOUND", "操作不在开放目录中", 404);
    if (input.workspaceId && input.workspaceId !== identity.workspaceId) throw new ToolError("WORKSPACE_MISMATCH", "不能跨越密钥绑定工作区", 403);
    const projectId = input[operation.projectField || "projectId"];
    if (projectId) {
      const access = await checkProjectPermission({ database: db, projectId: Number(projectId), userId: identity.userId, role: "user", authWorkspaceId: identity.workspaceId, permission: operation.memberPermission });
      if (!access.allowed) throw new ToolError("PROJECT_FORBIDDEN", access.message, access.status);
    }
    const request = resolveStudioRequest(operation, input);
    const stepUp = resolveAdminStepUpScope({ method: operation.method, path: request.url.split("?")[0], body: request.body });
    if (stepUp) throw new ToolError("HUMAN_ACTION_REQUIRED", "此操作需要本人验证，请使用接续入口完成", 409,
      humanContinuation(operation.module === "workspace" ? "workspace_members" : "billing_request"));
    let pending = apps.get(operation.mount);
    if (!pending) {
      pending = operation.load().then(({ default: router }) => {
        const app = express();
        app.disable("x-powered-by");
        app.use(guardProjectScopedRoutes, membershipHttpGuard, adminOperationPolicyMiddleware, adminStepUpMiddleware);
        app.use(operation.mount, router);
        app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
          res.status(err?.status && Number.isInteger(err.status) ? err.status : 500).json({ code: "STUDIO_OPERATION_FAILED", message: "操作未完成，请查询对象状态后重试" });
        });
        return app;
      }).catch(error => { apps.delete(operation.mount); throw error; });
      apps.set(operation.mount, pending);
    }
    const app = await pending;
    const result = await runBillingContext({ workspaceId: identity.workspaceId, userId: identity.userId, projectId: Number(projectId) || null, requestId: `mcp-studio-${crypto.randomUUID()}` }, () => invokeStudioRouter(app, operation, identity, input));
    if (result.status >= 400) throw new ToolError(typeof result.body.code === "string" ? result.body.code : "STUDIO_OPERATION_FAILED", result.body.message || "操作未完成", result.status, { errors: result.body.errors, data: result.body.data });
    // Workspace update's browser response is a full login profile; a key is
    // still confined to its original workspace and must not receive that list.
    if (operation.name === "workspace.update") return { operation: operation.name, result: { workspaceId: identity.workspaceId, name: input.name }, status: result.status };
    return { operation: operation.name, result: result.body.data ?? result.body, status: result.status };
  };
}
