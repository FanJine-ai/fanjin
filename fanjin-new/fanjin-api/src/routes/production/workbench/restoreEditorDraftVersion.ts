import express from "express";
import { z } from "zod";

import { DurableCommandIdempotencyError } from "@/lib/durableCommandIdempotency";
import { executeDurableProjectMutation } from "@/lib/durableProjectMutation";
import {
  parseEditorTimelineDraftLedger,
  restoreEditorTimelineRevision,
  serializeBoundedEditorTimelineLedger,
} from "@/lib/editorTimelineDraftLedger";
import { isPostgresClient } from "@/lib/dbDialect";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { requireProjectPermission } from "@/middleware/projectAccess";

const router = express.Router();
const DRAFT_KEY = "workbenchEditorDraft";
const MAX_DRAFT_BYTES = 2 * 1024 * 1024;

class EditorTimelineRestoreError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "EditorTimelineRestoreError";
  }
}

export default router.post(
  "/",
  validateFields({
    projectId: z.number().int().positive(),
    episodesId: z.number().int(),
    versionId: z.string().min(1).max(80),
    expectedCurrentSavedAt: z.number().int().nonnegative(),
  }),
  requireProjectPermission("project:write"),
  async (req, res) => {
    const projectId = Number(req.body.projectId);
    const episodesId = Number(req.body.episodesId);
    const versionId = String(req.body.versionId);
    const expectedCurrentSavedAt = Number(req.body.expectedCurrentSavedAt);
    try {
      const result = await executeDurableProjectMutation({
        req,
        scope: `workbench-editor-draft:restore:${episodesId}`,
        request: { projectId, episodesId, versionId, expectedCurrentSavedAt },
        mutate: async (transaction) => {
          let rowQuery = transaction("o_agentWorkData")
            .where({ projectId, episodesId, key: DRAFT_KEY })
            .select("id", "data", "updateTime");
          if (isPostgresClient(transaction)) rowQuery = rowQuery.forUpdate();
          const row = await rowQuery.first();
          if (!row?.id || !row.data) {
            throw new EditorTimelineRestoreError(
              404,
              "editor_timeline_history_not_found",
              "当前项目还没有可恢复的剪辑版本",
            );
          }
          let ledger;
          try {
            ledger = parseEditorTimelineDraftLedger(JSON.parse(String(row.data)));
          } catch {
            ledger = null;
          }
          if (!ledger) {
            throw new EditorTimelineRestoreError(
              409,
              "editor_timeline_history_corrupted",
              "剪辑版本历史损坏，已阻止覆盖当前草稿",
            );
          }
          if (ledger.current.savedAt !== expectedCurrentSavedAt) {
            throw new EditorTimelineRestoreError(
              409,
              "editor_timeline_version_conflict",
              "剪辑草稿已有更新，请刷新版本列表后再恢复",
            );
          }
          const now = Date.now();
          const restored = restoreEditorTimelineRevision({
            ledger,
            versionId,
            savedAt: now,
          });
          if (!restored) {
            throw new EditorTimelineRestoreError(
              404,
              "editor_timeline_version_not_found",
              "目标剪辑版本不存在或已超出保留窗口",
            );
          }
          const bounded = serializeBoundedEditorTimelineLedger({
            ledger: restored,
            maxBytes: MAX_DRAFT_BYTES,
          });
          await transaction("o_agentWorkData").where({ id: row.id }).update({
            data: bounded.serialized,
            updateTime: now,
          });
          const currentVersion = bounded.ledger.revisions.find(
            (revision) => revision.id === bounded.ledger.currentVersionId,
          );
          return {
            accepted: true,
            updatedAt: now,
            data: bounded.ledger.current,
            version: currentVersion ? {
              id: currentVersion.id,
              digest: currentVersion.digest,
              createdAt: currentVersion.createdAt,
              restoredFromVersionId: currentVersion.restoredFromVersionId,
            } : null,
          };
        },
      });
      return res.status(result.responseStatus).send(success(result.data));
    } catch (error) {
      if (error instanceof EditorTimelineRestoreError) {
        return res.status(error.status).send({ code: error.code, message: error.message });
      }
      if (error instanceof DurableCommandIdempotencyError) {
        return res.status(error.status).send({ code: error.code, message: error.message });
      }
      throw error;
    }
  },
);
