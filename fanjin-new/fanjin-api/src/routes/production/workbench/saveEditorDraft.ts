import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { requireProjectPermission } from "@/middleware/projectAccess";
import { DurableCommandIdempotencyError } from "@/lib/durableCommandIdempotency";
import { executeDurableProjectMutation } from "@/lib/durableProjectMutation";
import { isPostgresClient } from "@/lib/dbDialect";
import {
  editorTimelineV2Schema,
  isEditorTimelineV2Candidate,
} from "@/lib/editorTimelineV2";
import {
  appendEditorTimelineRevision,
  parseEditorTimelineDraftLedger,
  serializeBoundedEditorTimelineLedger,
} from "@/lib/editorTimelineDraftLedger";

const router = express.Router();
const DRAFT_KEY = "workbenchEditorDraft";
const MAX_DRAFT_BYTES = 2 * 1024 * 1024;

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    episodesId: z.number(),
    data: z.any(),
  }),
  requireProjectPermission("project:write"),
  async (req, res) => {
    const { projectId, episodesId, data }: { projectId: number; episodesId: number; data: unknown } = req.body;
    let canonicalData = data;
    if (isEditorTimelineV2Candidate(data)) {
      const parsed = editorTimelineV2Schema.safeParse(data);
      if (!parsed.success) {
        return res.status(422).send({
          code: "editor_timeline_invalid",
          message: "剪辑时间线格式无效，请修正片段参数后重试",
        });
      }
      canonicalData = parsed.data;
    }
    const canonicalSerialized = JSON.stringify(canonicalData ?? {});
    if (Buffer.byteLength(canonicalSerialized, "utf8") > MAX_DRAFT_BYTES) {
      return res.status(413).send({ message: "剪辑草稿过大，请减少轨道素材后再保存" });
    }
    try {
      const result = await executeDurableProjectMutation({
        req,
        scope: `workbench-editor-draft:save:${episodesId}`,
        request: { projectId, episodesId, data: canonicalData },
        mutate: async (transaction) => {
          let rowQuery = transaction("o_agentWorkData")
            .where("projectId", String(projectId))
            .andWhere("episodesId", String(episodesId))
            .where("key", DRAFT_KEY)
            .select("id", "data", "updateTime");
          if (isPostgresClient(transaction)) rowQuery = rowQuery.forUpdate();
          const row = await rowQuery.first();
          const now = Date.now();
          const incomingSavedAt = Number(
            canonicalData && typeof canonicalData === "object" && !Array.isArray(canonicalData)
              ? (canonicalData as Record<string, unknown>).savedAt
              : 0,
          );
          let storedSavedAt = 0;
          let storedValue: unknown = null;
          if (row?.data) {
            try {
              storedValue = JSON.parse(String(row.data));
              const storedLedger = parseEditorTimelineDraftLedger(storedValue);
              storedSavedAt = Number(
                storedLedger?.current.savedAt
                || (
                  storedValue
                  && typeof storedValue === "object"
                  && !Array.isArray(storedValue)
                    ? (storedValue as Record<string, unknown>).savedAt
                    : 0
                )
                || 0,
              );
            } catch {
              storedSavedAt = 0;
            }
          }

          // A detached pagehide flush can race an older autosave request.
          // Keep the newest client snapshot instead of allowing a late,
          // already-obsolete request to overwrite it.
          if (
            row?.id
            && Number.isFinite(storedSavedAt)
            && Number.isFinite(incomingSavedAt)
            && storedSavedAt > incomingSavedAt
          ) {
            return {
              updatedAt: Number(row.updateTime || now),
              accepted: false,
              reason: "stale_snapshot",
            };
          }

          let serialized = canonicalSerialized;
          let version: { id: string; digest: string; createdAt: number } | null = null;
          if (isEditorTimelineV2Candidate(canonicalData)) {
            const parsedDraft = editorTimelineV2Schema.parse(canonicalData);
            const ledger = appendEditorTimelineRevision({
              ledger: parseEditorTimelineDraftLedger(storedValue),
              draft: parsedDraft,
            });
            const bounded = serializeBoundedEditorTimelineLedger({
              ledger,
              maxBytes: MAX_DRAFT_BYTES,
            });
            serialized = bounded.serialized;
            const currentVersion = bounded.ledger.revisions.find(
              (revision) => revision.id === bounded.ledger.currentVersionId,
            );
            version = currentVersion ? {
              id: currentVersion.id,
              digest: currentVersion.digest,
              createdAt: currentVersion.createdAt,
            } : null;
          }

          if (row?.id) {
            await transaction("o_agentWorkData").where("id", row.id).update({
              data: serialized,
              updateTime: now,
            });
          } else {
            await transaction("o_agentWorkData").insert({
              projectId,
              episodesId,
              key: DRAFT_KEY,
              data: serialized,
              createTime: now,
              updateTime: now,
            });
          }
          return { updatedAt: now, accepted: true, version };
        },
      });
      return res
        .status(result.responseStatus)
        .send(success(result.data));
    } catch (error) {
      if (error instanceof DurableCommandIdempotencyError) {
        return res.status(error.status).send({
          message: error.message,
          code: error.code,
        });
      }
      throw error;
    }
  },
);
