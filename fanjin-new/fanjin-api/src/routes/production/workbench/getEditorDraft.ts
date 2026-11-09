import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { requireProjectPermission } from "@/middleware/projectAccess";
import { parseEditorTimelineDraftLedger } from "@/lib/editorTimelineDraftLedger";

const router = express.Router();
const DRAFT_KEY = "workbenchEditorDraft";

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    episodesId: z.number(),
  }),
  requireProjectPermission("project:read"),
  async (req, res) => {
    const { projectId, episodesId }: { projectId: number; episodesId: number } = req.body;
    const row = await u
      .db("o_agentWorkData")
      .where("projectId", String(projectId))
      .andWhere("episodesId", String(episodesId))
      .where("key", DRAFT_KEY)
      .select("data", "updateTime")
      .first();

    if (!row?.data) return res.status(200).send(success({ data: null, updatedAt: null }));

    try {
      const stored = JSON.parse(row.data);
      const ledger = parseEditorTimelineDraftLedger(stored);
      return res.status(200).send(success({
        data: ledger?.current || stored,
        updatedAt: row.updateTime || null,
        currentVersionId: ledger?.currentVersionId || null,
      }));
    } catch {
      return res.status(200).send(success({ data: null, updatedAt: row.updateTime || null, corrupted: true }));
    }
  },
);
