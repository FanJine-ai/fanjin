import { NextFunction, Request, Response } from "express";
import { redactSensitive } from "@/lib/requestLog";

const GENERIC_SERVER_ERROR = "服务器内部错误";

function shouldHideServerErrorDetails(): boolean {
  return process.env.NODE_ENV === "prod" && process.env.FANJIN_EXPOSE_ERROR_DETAILS !== "1";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && !Buffer.isBuffer(value);
}

function parseResponseBody(body: unknown): unknown {
  if (Buffer.isBuffer(body)) return null;
  if (isPlainObject(body) || Array.isArray(body)) return body;
  if (typeof body !== "string") return null;
  const trimmed = body.trim();
  if (!/^[{[]/.test(trimmed) || trimmed.length > 65536) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function requestIdFrom(res: Response): string | undefined {
  const value = res.getHeader("X-Request-Id");
  return typeof value === "string" && value ? value : undefined;
}

function isApiRequest(req: Request): boolean {
  const path = String(req.originalUrl || req.url || req.path || "").split("?")[0];
  return (
    path === "/api" ||
    path.startsWith("/api/") ||
    path === "/v1" ||
    path.startsWith("/v1/") ||
    path === "/v1beta" ||
    path.startsWith("/v1beta/")
  );
}

function hiddenServerErrorBody(body: unknown, requestId?: string): Record<string, unknown> {
  const parsed = parseResponseBody(body);
  const output: Record<string, unknown> = {
    code: "internal_error",
    message: GENERIC_SERVER_ERROR,
  };
  if (requestId) output.requestId = requestId;
  if (isPlainObject(parsed) && "data" in parsed) output.data = null;
  return output;
}

function sanitizeApiResponse(req: Request, res: Response, body: unknown): unknown {
  // Only hide unexpected internal failures (HTTP 500). Controlled API outcomes such as
  // 502/503 mail-delivery/config errors already return safe Chinese messages + codes.
  if (!isApiRequest(req) || res.statusCode !== 500) return body;
  if (shouldHideServerErrorDetails()) return hiddenServerErrorBody(body, requestIdFrom(res));
  return redactSensitive(body);
}

function shouldSerializeAsJson(value: unknown): boolean {
  return isPlainObject(value) || Array.isArray(value);
}

export function errorRedactionMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    const originalSend = res.send.bind(res);
    (res as any).send = (body?: unknown) => {
      const sanitized = sanitizeApiResponse(req, res, body);
      if (sanitized !== body && shouldSerializeAsJson(sanitized)) {
        res.type("application/json");
        return originalSend(JSON.stringify(sanitized));
      }
      return originalSend(sanitized);
    };
    return next();
  };
}
