import type { Request, Response } from "express";

export const LEGACY_PRODUCTION_GENERATION_MIGRATION_ENDPOINT =
  "/api/production/workbench/batchGenerateVideo";

export function sendLegacyProductionGenerationGone(
  _req: Request,
  res: Response,
) {
  return res.status(410).send({
    code: "legacy_production_generation_route_gone",
    message:
      "旧版单项视频与提示词生成入口已停用。请先在分镜编辑中保存提示词，再通过安全批量视频入口提交，并携带 Idempotency-Key。",
    endpoint: LEGACY_PRODUCTION_GENERATION_MIGRATION_ENDPOINT,
    requiredHeader: "Idempotency-Key",
  });
}
