import express from "express";
import { z } from "zod";
import {
  DIRECTOR_SCENE_V1_DRAFT_KEY,
  DIRECTOR_SCENE_V1_EPISODE_ID,
  directorSceneDigest,
  directorSceneV1Schema,
} from "@/lib/directorSceneV1";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { requireProjectPermission } from "@/middleware/projectAccess";
import u from "@/utils";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number().int().positive(),
  }),
  requireProjectPermission("project:read"),
  async (req, res) => {
    const projectId = Number(req.body.projectId);
    const row = await u.db("o_agentWorkData")
      .where({
        projectId,
        episodesId: DIRECTOR_SCENE_V1_EPISODE_ID,
        key: DIRECTOR_SCENE_V1_DRAFT_KEY,
      })
      .select("data", "updateTime")
      .first();
    if (!row?.data) {
      return res.status(200).send(success({
        data: null,
        updatedAt: null,
        digest: null,
        corrupted: false,
      }));
    }
    try {
      const parsed = directorSceneV1Schema.safeParse(JSON.parse(String(row.data)));
      if (!parsed.success) {
        return res.status(200).send(success({
          data: null,
          updatedAt: Number(row.updateTime || 0) || null,
          digest: null,
          corrupted: true,
        }));
      }
      return res.status(200).send(success({
        data: parsed.data,
        updatedAt: Number(row.updateTime || 0) || null,
        digest: directorSceneDigest(parsed.data),
        corrupted: false,
      }));
    } catch {
      return res.status(200).send(success({
        data: null,
        updatedAt: Number(row.updateTime || 0) || null,
        digest: null,
        corrupted: true,
      }));
    }
  },
);
