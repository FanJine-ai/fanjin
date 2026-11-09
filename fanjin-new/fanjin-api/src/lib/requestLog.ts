import { Request, Response, NextFunction } from "express";
import { v4 as uuid } from "uuid";
import { db } from "@/utils/db";
import { getBooleanPlatformSetting } from "@/lib/platformSettings";
import { resolveRelayWorkspaceId } from "@/lib/relayUtils";
import { isRecoveryOnlyMode } from "@/lib/recoveryOnlyMode";

const REDACTED = "[REDACTED]";
const SENSITIVE_KEY_RE = /(^key$|^(?:callback[-_]?)?(?:url|uri)$|(^|[-_])(code|state|exchange|proof|challenge|grant)$|^(mfa|totp|recovery|stepup|oauth|bootstrap|resume)[-_]?(code|proof|challenge|grant)$|authorization|cookie|token|password|secret|credential|signature|api[-_]?key|access[-_]?key|refresh[-_]?token|session|private[-_]?key|key[-_]?pem|certificate[-_]?(chain|pem|privatekey)|client[-_]?key)/i;
let requestLogEnabledCache = { value: true, expiresAt: 0 };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function truncate(value: string, max = 512): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/fjadmin_[A-Za-z0-9_-]+/g, "fjadmin_****")
    .replace(/fanjin_[A-Za-z0-9_-]+(?:_[A-Za-z0-9_-]+)?/g, "fanjin_****")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/((?:\bkey\b|authorization|cookie|token|password|secret|credential|signature|api[-_]?key|access[-_]?key|refresh[-_]?token|session)\s*[:=]\s*)([^,\s;&]+)/gi, `$1${REDACTED}`);
}

/** Redact and bound a scalar before it enters a dedicated request-log column. */
export function redactRequestLogScalar(value: unknown, max = 512): string | null {
  if (value === null || value === undefined) return null;
  return truncate(redactSensitiveText(String(value)), max);
}

/** Redact credentials before a URL is emitted to console/access logs. */
export function redactRequestUrl(value: string): string {
  const raw = String(value || "");
  try {
    const parsed = new URL(raw, "http://fanjin.invalid");
    const sensitiveNames = [...new Set(parsed.searchParams.keys())]
      .filter((name) => SENSITIVE_KEY_RE.test(name));
    for (const name of sensitiveNames) parsed.searchParams.set(name, REDACTED);
    return redactRequestLogScalar(`${parsed.pathname}${parsed.search}${parsed.hash}`, 2048) || "";
  } catch {
    return redactRequestLogScalar(raw, 2048) || "";
  }
}

export function redactSensitive(value: unknown, key = "", depth = 0): unknown {
  if (SENSITIVE_KEY_RE.test(key)) return REDACTED;
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    const masked = redactSensitiveText(value);
    return truncate(masked);
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= 4) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redactSensitive(item, key, depth + 1));
  if (isPlainObject(value)) {
    const output: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value).slice(0, 40)) {
      output[childKey] = redactSensitive(childValue, childKey, depth + 1);
    }
    return output;
  }
  return truncate(String(value));
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return JSON.stringify({ serializationError: true });
  }
}

function requestIdFrom(req: Request): string {
  const fromHeader = String(req.header("x-request-id") || "").trim();
  if (/^[A-Za-z0-9_.:-]{1,128}$/.test(fromHeader)) return fromHeader;
  return uuid();
}

function pickFirstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function responseObject(value: unknown): any {
  if (!value) return null;
  if (Buffer.isBuffer(value)) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;
  if (!/^\s*[\[{]/.test(value) || value.length > 65536) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function taskIdFromPath(path: string): string | null {
  const match = path.match(/\/api\/v3\/contents\/generations\/tasks\/([^/?]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function isTaskPath(path: string): boolean {
  return (
    path.startsWith("/api/v3/contents/generations/tasks") ||
    path === "/api/production/workbench/generateVideo" ||
    path === "/api/production/workbench/checkVideoStateList"
  );
}

function isRequestLogPath(path: string): boolean {
  return (
    path === "/api" ||
    path.startsWith("/api/") ||
    path === "/v1" ||
    path.startsWith("/v1/") ||
    path === "/v1beta" ||
    path.startsWith("/v1beta/") ||
    path.startsWith("/mj") ||
    path.startsWith("/suno")
  );
}

function isPaymentCallbackPath(path: string): boolean {
  return path.startsWith("/api/billing/payment/callbacks/");
}

async function isRequestLogEnabled(): Promise<boolean> {
  const now = Date.now();
  if (requestLogEnabledCache.expiresAt > now) return requestLogEnabledCache.value;
  const value = await getBooleanPlatformSetting("platform.operations.logConsumeEnabled", true);
  requestLogEnabledCache = { value, expiresAt: now + 10_000 };
  return value;
}

function extractRelayTaskId(req: Request, requestPath: string, responseBody: unknown): string | null {
  const body = responseObject(responseBody);
  const taskPath = isTaskPath(requestPath);
  return pickFirstString(
    req.body?.relayTaskId,
    req.body?.taskId,
    body?.data?.relayTaskId,
    body?.data?.taskId,
    body?.data?.task?.id,
    taskIdFromPath(requestPath),
    taskPath ? req.params?.taskId : null,
    taskPath ? req.params?.id : null,
    taskPath ? body?.taskId : null,
    taskPath ? body?.id : null,
    taskPath ? body?.data?.id : null,
  );
}

function extractRequestError(responseBody: unknown, statusCode: number) {
  if (statusCode < 400) return null;
  const body = responseObject(responseBody);
  // Preserve existing precedence, then support public API error envelopes.
  const candidates: [string, unknown][] = [
    ["code", body?.code],
    ["errorCode", body?.errorCode],
    ["data.code", body?.data?.code],
    ["data.errorCode", body?.data?.errorCode],
    ["error.code", body?.error?.code],
    ["error.errorCode", body?.error?.errorCode],
    ["data.error.code", body?.data?.error?.code],
    ["data.error.errorCode", body?.data?.error?.errorCode],
  ];
  const category = ({
    401: "authentication",
    403: "authorization",
    404: "not_found",
    409: "conflict",
    421: "misdirected_request",
    422: "validation",
    429: "rate_limit",
  } as Record<number, string>)[statusCode] || (statusCode >= 500 ? "server_error" : "client_error");
  for (const [codePath, value] of candidates) {
    const code = pickFirstString(value);
    if (code !== null) {
      return {
        errorCode: redactRequestLogScalar(code),
        metadata: { category, codeSource: "response", codePath },
      };
    }
  }
  // This describes the HTTP outcome only; it must not invent a business cause.
  return {
    errorCode: `HTTP_${statusCode}`,
    metadata: { category, codeSource: "http_status", codePath: null },
  };
}

function requestModel(req: Request): string | null {
  return pickFirstString(req.body?.model, req.body?.videoModel, req.query?.model, req.query?.videoModel);
}

function requestResolution(req: Request): string | null {
  return pickFirstString(req.body?.targetResolution, req.body?.resolution, req.body?.size, req.query?.targetResolution, req.query?.resolution);
}

export function requestLogMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    if (isRecoveryOnlyMode()) return next();
    if (req.method === "OPTIONS" || !isRequestLogPath(req.path)) return next();

    const startedAt = Date.now();
    const requestId = requestIdFrom(req);
    (req as any).requestId = requestId;
    const requestPath = req.path;
    let responseBody: unknown;
    res.setHeader("X-Request-Id", requestId);

    const originalSend = res.send.bind(res);
    (res as any).send = (body?: any) => {
      responseBody = body;
      return originalSend(body);
    };

    res.on("finish", () => {
      void (async () => {
        if (!(await isRequestLogEnabled())) return;

        const auth = (req as any).auth || {};
        const authUser = auth.user || (req as any).user || {};
        const apiKey = (req as any).apiKey || {};
        const requestError = extractRequestError(responseBody, res.statusCode);
        const metadata = {
          query: redactSensitive(req.query),
          body: isPaymentCallbackPath(requestPath) ? "[PAYMENT_CALLBACK_REDACTED]" : redactSensitive(req.body),
          headers: redactSensitive({
            authorization: req.header("authorization"),
            cookie: req.header("cookie"),
            "x-api-key": req.header("x-api-key"),
            "x-goog-api-key": req.header("x-goog-api-key"),
            "idempotency-key": req.header("idempotency-key"),
            "user-agent": req.header("user-agent"),
          }),
          ...(requestError ? { error: requestError.metadata } : {}),
        };

        db("o_request_log")
          .insert({
            id: uuid(),
            requestId: redactRequestLogScalar(requestId, 128) || uuid(),
            workspaceId: resolveRelayWorkspaceId(req) || auth.workspaceId || apiKey.workspaceId || null,
            actorUserId: Number(authUser.id || 0) || null,
            apiKeyId: apiKey.id || null,
            apiKeyPrefix: apiKey.keyPrefix || null,
            method: req.method,
            path: redactRequestLogScalar(requestPath, 2048) || "/",
            statusCode: res.statusCode,
            durationMs: Math.max(0, Date.now() - startedAt),
            model: redactRequestLogScalar(requestModel(req)),
            targetResolution: redactRequestLogScalar(requestResolution(req)),
            relayTaskId: redactRequestLogScalar(extractRelayTaskId(req, requestPath, responseBody)),
            errorCode: requestError?.errorCode ?? null,
            ip: redactRequestLogScalar(req.ip, 128),
            userAgent: redactRequestLogScalar(req.header("user-agent")),
            metadata: safeJson(metadata),
            createdAt: startedAt,
          })
          .catch((err: any) => {
            console.warn("[request-log] write failed", err?.message || err);
          });
      })().catch((err: any) => {
        console.warn("[request-log] skipped", err?.message || err);
      });
    });

    next();
  };
}
