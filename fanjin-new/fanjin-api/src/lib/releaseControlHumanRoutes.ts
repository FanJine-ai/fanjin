import type { NextFunction, Request, RequestHandler, Response } from "express";
import {
  getConfiguredReleaseControlBridgeRuntime,
  proxyReleaseControlHumanRequest,
  ReleaseControlBridgeError,
  type ReleaseControlHumanScope,
} from "@/lib/releaseControlHumanBridge";

function header(req: Request, name: string): string | null {
  const value = req.headers[name];
  return String(Array.isArray(value) ? value[0] ?? "" : value ?? "").trim() || null;
}

function authenticatedIdentity(req: Request): { userId: number; sessionId: string } {
  const userId = Number((req as any).auth?.user?.id ?? (req as any).user?.id ?? 0);
  const sessionId = String((req as any).auth?.session?.id ?? "").trim();
  if (!Number.isSafeInteger(userId) || userId < 1 || !sessionId) {
    throw new ReleaseControlBridgeError(
      "RELEASE_CONTROL_BRIDGE_IDENTITY_INVALID",
      "当前 Fanjin 会话无法用于发布器身份桥",
      401,
    );
  }
  return { userId, sessionId };
}

function sendBridgeError(res: Response, error: ReleaseControlBridgeError): Response {
  return res.status(error.status).send({
    error: { code: error.code, message: error.message },
  });
}

export function createReleaseControlHumanHandler(options: {
  method: "GET" | "POST";
  path(req: Request): string;
  scopes: readonly ReleaseControlHumanScope[];
  requireMfa?: boolean;
  requireIdempotencyKey?: boolean;
  forceEmptyBody?: boolean;
}): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (options.requireMfa && res.locals.adminStepUpScope !== "admin.deployment") {
        throw new ReleaseControlBridgeError(
          "RELEASE_CONTROL_MFA_CONTEXT_REQUIRED",
          "发布授权需要已消费的 admin.deployment MFA proof",
          401,
        );
      }
      const runtime = await getConfiguredReleaseControlBridgeRuntime();
      const identity = authenticatedIdentity(req);
      const operationKey = header(req, "idempotency-key");
      if (options.requireIdempotencyKey && !operationKey) {
        throw new ReleaseControlBridgeError(
          "IDEMPOTENCY_KEY_REQUIRED",
          "快速发布必须提供 Idempotency-Key",
          400,
        );
      }
      const token = runtime.authority.issue({
        ...identity,
        scopes: options.scopes,
        mfaVerified: options.requireMfa === true,
      });
      const result = await proxyReleaseControlHumanRequest(runtime, {
        method: options.method,
        path: options.path(req),
        token,
        ...(options.method === "POST"
          ? { body: options.forceEmptyBody ? {} : req.body ?? {} }
          : {}),
        idempotencyKey: operationKey,
      });
      res.setHeader("cache-control", "no-store");
      if (result.requestId) res.setHeader("x-release-control-request-id", result.requestId);
      return res.status(result.status).send(result.payload);
    } catch (error) {
      if (error instanceof ReleaseControlBridgeError) return sendBridgeError(res, error);
      return next(error);
    }
  };
}

export function releaseControlListLimit(req: Request): number {
  const raw = req.query.limit;
  const value = raw == null || raw === "" ? 50 : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new ReleaseControlBridgeError(
      "INVALID_LIST_LIMIT",
      "limit 必须是 1-100 的整数",
      400,
    );
  }
  return value;
}

export function releaseControlEncodedId(req: Request): string {
  const value = String(req.params.id ?? "").trim();
  if (!value || value.length > 128 || !/^[A-Za-z0-9-]+$/.test(value)) {
    throw new ReleaseControlBridgeError(
      "RELEASE_CONTROL_RESOURCE_ID_INVALID",
      "发布器资源 ID 无效",
      400,
    );
  }
  return encodeURIComponent(value);
}
