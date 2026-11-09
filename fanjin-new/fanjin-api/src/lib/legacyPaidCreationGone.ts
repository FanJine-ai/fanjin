import type { RequestHandler } from "express";

export const LEGACY_PAID_CREATION_GONE_CODE =
  "legacy_paid_creation_route_gone";

export type LegacyPaidCreationMigration = {
  route: string;
  endpoint: string;
  guidance: string;
  requiredHeader?: "Idempotency-Key";
};

export function createLegacyPaidCreationGoneHandler(
  migration: LegacyPaidCreationMigration,
): RequestHandler {
  return (_req, res) => res.status(410).send({
    code: LEGACY_PAID_CREATION_GONE_CODE,
    message: `旧版内部生成入口 ${migration.route} 已停用。${migration.guidance}`,
    endpoint: migration.endpoint,
    ...(migration.requiredHeader
      ? { requiredHeader: migration.requiredHeader }
      : {}),
  });
}
