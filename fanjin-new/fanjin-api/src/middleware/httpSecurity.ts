import cors from "cors";
import type { NextFunction, Request, Response } from "express";
import { isProductionRuntime } from "@/lib/legacyAsyncRelaySafety";

type CorsEnvironment = {
  NODE_ENV?: string;
  FANJIN_CORS_ORIGINS?: string;
  CORS_ORIGINS?: string;
  FANJIN_ALLOW_LOCAL_CORS?: string;
};

function configuredCorsOrigins(env: CorsEnvironment): Set<string> {
  const raw = env.FANJIN_CORS_ORIGINS || env.CORS_ORIGINS || "";
  return new Set(
    raw
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function isLocalOrigin(origin: string): boolean {
  return /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(origin);
}

function allowsLocalCorsOrigin(env: CorsEnvironment): boolean {
  return !isProductionRuntime(env.NODE_ENV) || env.FANJIN_ALLOW_LOCAL_CORS === "1";
}

/**
 * CORS is intentionally request-aware so an ordinary same-origin browser
 * request remains valid without turning the request Host into a global
 * allowlist entry. Remote and LAN development origins must be configured in
 * FANJIN_CORS_ORIGINS.
 */
export function buildCorsOptions(req?: Request, env: CorsEnvironment = process.env): cors.CorsOptions {
  return {
    origin(origin, callback) {
      if (!origin) return callback(null, true);

      const allowedOrigins = configuredCorsOrigins(env);
      if (allowedOrigins.has(origin)) return callback(null, true);

      if (req) {
        const sameOrigin = `${req.protocol}://${req.get("host")}`;
        if (origin === sameOrigin) return callback(null, true);
      }

      if (allowsLocalCorsOrigin(env) && isLocalOrigin(origin)) return callback(null, true);
      return callback(null, false);
    },
    credentials: true,
  };
}

/**
 * Conservative headers that are compatible with the web app.
 * A CSP is deliberately not guessed here because the product loads external
 * provider media. HSTS is emitted only when production is observably HTTPS;
 * behind a proxy that requires an explicit, trusted proxy configuration.
 */
export function securityHeadersMiddleware(req: Request, res: Response, next: NextFunction): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  if (isProductionRuntime() && req.secure) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000");
  }
  next();
}
