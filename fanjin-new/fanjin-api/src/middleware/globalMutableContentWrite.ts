import type { NextFunction, Request, Response } from "express";
import { error } from "@/lib/responseFormat";
import type { StepUpScope } from "@/lib/stepUpAuth";
import { isPlatformAdmin } from "@/middleware/permissions";

export const GLOBAL_MUTABLE_CONTENT_WRITE_SCOPE =
  "legacy.content_config.manage" satisfies StepUpScope;
export const GLOBAL_MUTABLE_CONTENT_WRITE_UNAVAILABLE_CODE =
  "GLOBAL_MUTABLE_CONTENT_WRITE_UNAVAILABLE";
export const GLOBAL_MUTABLE_CONTENT_WRITE_UNAVAILABLE_MESSAGE =
  "生产环境不提供全局可变内容写入";

export const GLOBAL_MUTABLE_CONTENT_WRITE_PATHS = new Set([
  "/api/artStyle/addArtStyle",
  "/api/artStyle/editArtStyle",
  "/api/project/addDirectorManual",
  "/api/project/addVisualManual",
  "/api/project/editDirectorlManual",
  "/api/project/editVisualManual",
]);

export function isProductionGlobalContentRuntime(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const nodeEnvironment = String(environment.NODE_ENV || "")
    .trim()
    .toLowerCase();
  return nodeEnvironment === "prod" || nodeEnvironment === "production";
}

export function isGlobalMutableContentWritePath(path: string): boolean {
  const normalized = String(path || "").split("?", 1)[0].replace(/\/+$/, "");
  return GLOBAL_MUTABLE_CONTENT_WRITE_PATHS.has(normalized);
}

/**
 * Defense in depth for legacy global content writers.
 *
 * The application-wide admin step-up middleware consumes the one-time proof
 * before this route middleware runs. Checking its server-side marker here keeps
 * the route safe if it is ever mounted in another Express application.
 */
export function requireGlobalMutableContentWrite(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (isProductionGlobalContentRuntime()) {
    return res.status(503).send(error(
      GLOBAL_MUTABLE_CONTENT_WRITE_UNAVAILABLE_MESSAGE,
      { code: GLOBAL_MUTABLE_CONTENT_WRITE_UNAVAILABLE_CODE },
    ));
  }
  if (!isPlatformAdmin(req)) {
    return res.status(403).send(error(
      "需要平台管理员权限",
      { code: "PLATFORM_ADMIN_REQUIRED" },
    ));
  }
  if (
    (req as any).adminStepUpScope !== GLOBAL_MUTABLE_CONTENT_WRITE_SCOPE
    || res.locals.adminStepUpScope !== GLOBAL_MUTABLE_CONTENT_WRITE_SCOPE
  ) {
    return res.status(401).send(error(
      "敏感操作需要 step-up proof",
      { code: "STEP_UP_REQUIRED" },
    ));
  }
  return next();
}
