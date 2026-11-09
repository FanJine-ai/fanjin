import { NextFunction, Request, Response } from "express";
import { hasAuditLogWritten, writeAuditLog } from "@/lib/audit";
import type { AdminOperationPolicy } from "@/lib/adminOperationPolicyCatalog";
import { redactSensitive } from "@/lib/requestLog";
import { error } from "@/lib/responseFormat";

const READ_ACTIONS = new Set(["list", "stats"]);
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function requestPath(req: Request): string {
  return String(req.originalUrl || req.url || req.path || "").split("?")[0];
}

function adminSegments(path: string): string[] {
  return path
    .replace(/^\/api\/admin\/?/, "")
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function toSnakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function actionFromPath(path: string): string {
  const segments = adminSegments(path).map(toSnakeCase).filter(Boolean);
  return `admin.${segments.join(".") || "operation"}`;
}

function resourceTypeFromPath(path: string): string {
  const segments = adminSegments(path).map(toSnakeCase).filter(Boolean);
  if (!segments.length) return "admin_operation";
  if (segments.length >= 3) return `${segments[0]}_${segments[1]}`;
  return segments[0];
}

function resourceIdFrom(req: Request): string | number | null {
  const body = req.body || {};
  const query = req.query || {};
  const keys = ["id", "requestId", "channelId", "routeId", "planId", "taskId", "workspaceId"];
  for (const key of keys) {
    const value = body[key] ?? query[key];
    if (typeof value === "string" || typeof value === "number") return value;
  }
  return null;
}

function requestIdFrom(res: Response): string | undefined {
  const value = res.getHeader("X-Request-Id");
  return typeof value === "string" && value ? value : undefined;
}

function shouldAudit(req: Request, path: string): boolean {
  if (!path.startsWith("/api/admin/")) return false;
  if (!MUTATING_METHODS.has(req.method.toUpperCase())) return false;
  const segments = adminSegments(path);
  const lastSegment = segments[segments.length - 1] || "";
  return !READ_ACTIONS.has(lastSegment);
}

function activePolicy(res: Response): AdminOperationPolicy | null {
  const value = res.locals.fjadminOperationPolicy as
    | AdminOperationPolicy
    | undefined;
  return value?.status === "ACTIVE" ? value : null;
}

function policyAuditInput(
  req: Request,
  res: Response,
  policy: AdminOperationPolicy,
  path: string,
  startedAt: number,
) {
  return {
    workspaceId: (req as any).auth?.workspaceId ?? null,
    action: policy.auditAction,
    resourceType: "admin_operation",
    resourceId: policy.id,
    required: true,
    metadata: {
      policyId: policy.id,
      method: req.method,
      path,
      statusCode: res.statusCode,
      durationMs: Math.max(0, Date.now() - startedAt),
      requestId: requestIdFrom(res),
      stepUpScope: String((req as any).adminStepUpScope || "") || null,
      outcome: res.statusCode >= 400 ? "denied" : "completed",
      query: redactSensitive(req.query),
      body: redactSensitive(req.body),
    },
  } as const;
}

function installRequiredOutcomeBarrier(
  req: Request,
  res: Response,
  policy: AdminOperationPolicy,
  path: string,
  startedAt: number,
) {
  const originalSend = res.send.bind(res);
  let sending = false;

  res.send = ((payload?: any) => {
    if (sending || hasAuditLogWritten(req)) return originalSend(payload);
    sending = true;
    const intendedStatus = res.statusCode;
    void writeAuditLog(
      req,
      policyAuditInput(req, res, policy, path, startedAt),
    ).then(
      () => {
        res.status(intendedStatus);
        originalSend(payload);
      },
      () => {
        res.status(503);
        originalSend(error(
          "安全审计暂不可用，操作结果未确认",
          { code: "FJADMIN_AUDIT_UNAVAILABLE" },
        ));
      },
    );
    return res;
  }) as Response["send"];
}

export function adminOperationAuditMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    const path = requestPath(req);
    const policy = activePolicy(res);
    if (
      policy?.auditMode === "required"
      || (policy?.mutates && policy.auditMode !== "denial_only")
    ) {
      const startedAt = Date.now();
      installRequiredOutcomeBarrier(req, res, policy, path, startedAt);
      return next();
    }
    if (policy?.auditMode === "denial_only") return next();
    if (!shouldAudit(req, path)) return next();

    const startedAt = Date.now();
    res.on("finish", () => {
      if (hasAuditLogWritten(req)) return;
      void writeAuditLog(req, {
        action: actionFromPath(path),
        resourceType: resourceTypeFromPath(path),
        resourceId: resourceIdFrom(req),
        metadata: {
          method: req.method,
          path,
          statusCode: res.statusCode,
          durationMs: Math.max(0, Date.now() - startedAt),
          requestId: requestIdFrom(res),
          stepUpScope: String((req as any).adminStepUpScope || "") || null,
          query: redactSensitive(req.query),
          body: redactSensitive(req.body),
        },
      });
    });

    return next();
  };
}
