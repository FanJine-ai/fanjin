import type { NextFunction, Request, Response } from "express";

export type HttpSurface = "combined" | "studio" | "relay";

export function parseHttpSurface(
  environment: NodeJS.ProcessEnv = process.env,
): HttpSurface {
  const raw = String(environment.FANJIN_HTTP_SURFACE || "combined")
    .trim()
    .toLowerCase();
  if (raw === "combined" || raw === "all") return "combined";
  if (raw === "studio" || raw === "studio-api" || raw === "studio_api") {
    return "studio";
  }
  if (raw === "relay" || raw === "relay-api" || raw === "relay_api") {
    return "relay";
  }
  throw new Error(
    `无效 HTTP 服务面 FANJIN_HTTP_SURFACE=${raw}，可选值：combined/studio/relay`,
  );
}

function normalizedPath(value: unknown): string {
  const path = String(value || "/").split("?", 1)[0].replace(/\/+$/, "");
  return path || "/";
}

export function isCanonicalRelayPath(value: unknown): boolean {
  const path = normalizedPath(value);
  return path === "/v1"
    || path.startsWith("/v1/")
    || path === "/v1beta"
    || path.startsWith("/v1beta/")
    || path === "/api/v3"
    || path.startsWith("/api/v3/");
}

export function isRemovedPublicAliasPath(value: unknown): boolean {
  const path = normalizedPath(value);
  return path === "/api/v1"
    || path.startsWith("/api/v1/")
    || path === "/api/v1beta"
    || path.startsWith("/api/v1beta/")
    || path === "/api/relay"
    || path.startsWith("/api/relay/");
}

export function isSharedOperationalPath(value: unknown): boolean {
  const path = normalizedPath(value);
  return path === "/health"
    || path === "/healthz"
    || path === "/ready"
    || path === "/readiness"
    || path === "/metrics"
    || path === "/api/health"
    || path === "/api/health/stream"
    || path === "/api/ready"
    || path === "/api/metrics";
}

export function httpSurfaceAllowsPath(
  surface: HttpSurface,
  value: unknown,
): boolean {
  if (isRemovedPublicAliasPath(value)) return false;
  if (surface === "combined") return true;
  if (isSharedOperationalPath(value)) return true;
  const relay = isCanonicalRelayPath(value);
  if (surface === "relay") return relay;
  return !relay;
}

/**
 * HTTP upgrades bypass the normal Express response path, so keep a separate
 * fail-closed allowlist for the only two websocket transports we expose.
 */
export function httpSurfaceAllowsUpgrade(
  surface: HttpSurface,
  value: unknown,
): boolean {
  const path = normalizedPath(value);
  if (isRemovedPublicAliasPath(path)) return false;
  if (path === "/v1/realtime") return surface !== "studio";
  if (path === "/socket.io" || path.startsWith("/socket.io/")) {
    return surface !== "relay";
  }
  return false;
}

/**
 * Keep studio session routes and public API-key routes on separate listeners.
 * Nginx chooses the listener by host and path; this in-process fence remains
 * fail-closed if an upstream is accidentally wired to the wrong service.
 */
export function httpSurfaceBoundary(
  surface: HttpSurface = parseHttpSurface(),
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (httpSurfaceAllowsPath(surface, req.path)) {
      next();
      return;
    }
    const requestId = String(
      (req as any).requestId || res.getHeader("X-Request-Id") || "",
    ).trim();
    res.status(404).send({
      error: {
        code: "surface_not_found",
        message: "API 404 Not Found",
        ...(requestId ? { request_id: requestId } : {}),
      },
    });
  };
}
