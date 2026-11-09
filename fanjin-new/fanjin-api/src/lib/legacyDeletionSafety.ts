import type { RequestHandler } from "express";

export const LEGACY_DELETION_WORKFLOW_UNAVAILABLE_CODE =
  "LEGACY_DELETION_WORKFLOW_UNAVAILABLE";
export const LEGACY_DELETION_WORKFLOW_UNAVAILABLE_MESSAGE =
  "删除暂不可用：该入口正在迁移到持久化删除工作流";

/**
 * Legacy destructive routes must remain callable while their durable workflow
 * is being implemented, but they must not mutate rows or object storage.
 *
 * This response is intentionally independent of the requested resource so the
 * route handler cannot disclose whether a supplied identifier exists.
 */
export const legacyDeletionWorkflowUnavailable: RequestHandler = (
  _req,
  res,
) =>
  res.status(503).send({
    code: LEGACY_DELETION_WORKFLOW_UNAVAILABLE_CODE,
    message: LEGACY_DELETION_WORKFLOW_UNAVAILABLE_MESSAGE,
  });
