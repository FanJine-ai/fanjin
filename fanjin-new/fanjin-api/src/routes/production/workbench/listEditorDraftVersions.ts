import express from "express";
import { z } from "zod";

import { parseEditorTimelineDraftLedger } from "@/lib/editorTimelineDraftLedger";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { requireProjectPermission } from "@/middleware/projectAccess";
import u from "@/utils";

const router = express.Router();
const DRAFT_KEY = "workbenchEditorDraft";

export default router.post(
  "/",
  validateFields({
    projectId: z.number().int().positive(),
    episodesId: z.number().int(),
  }),
  requireProjectPermission("project:read"),
  async (req, res) => {
    const projectId = Number(req.body.projectId);
    const episodesId = Number(req.body.episodesId);
    const row = await u.db("o_agentWorkData")
      .where({ projectId, episodesId, key: DRAFT_KEY })
      .select("data", "updateTime")
      .first();
    if (!row?.data) {
      return res.status(200).send(success({
        currentVersionId: null,
        updatedAt: null,
        versions: [],
      }));
    }
    try {
      const ledger = parseEditorTimelineDraftLedger(JSON.parse(String(row.data)));
      if (!ledger) {
        return res.status(200).send(success({
          currentVersionId: null,
          updatedAt: Number(row.updateTime) || null,
          versions: [],
          legacy: true,
        }));
      }
      return res.status(200).send(success({
        currentVersionId: ledger.currentVersionId,
        updatedAt: Number(row.updateTime) || null,
        versions: [...ledger.revisions].reverse().map((revision) => ({
          id: revision.id,
          digest: revision.digest,
          createdAt: revision.createdAt,
          restoredFromVersionId: revision.restoredFromVersionId,
          draft: revision.draft,
        })),
      }));
    } catch {
      return res.status(409).send({
        code: "editor_timeline_history_corrupted",
        message: "剪辑版本历史损坏，已阻止比较或恢复",
      });
    }
  },
);
