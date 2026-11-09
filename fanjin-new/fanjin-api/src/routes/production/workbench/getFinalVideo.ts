import express from "express";
import { z } from "zod";

import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { requireProjectPermission } from "@/middleware/projectAccess";
import { db } from "@/utils/db";

const router = express.Router();

export default router.post(
  "/",
  requireProjectPermission("project:read"),
  validateFields({
    projectId: z.number().int().positive(),
  }),
  async (req, res) => {
    const projectId = Number(req.body.projectId);
    const workspaceId = String((req as any).auth?.workspaceId || "").trim();
    const row = await db("o_media_asset")
      .where({
        workspaceId,
        projectId,
        source: "project-final-render",
        assetType: "video",
      })
      .orderBy("createTime", "desc")
      .first();
    let metadata: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(String(row?.metadata || "{}"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        metadata = parsed as Record<string, unknown>;
      }
    } catch {
      metadata = {};
    }
    const assetId = Number(metadata.assetId || 0);
    const assetVersionId = Number(metadata.assetVersionId || 0);
    const taskId = Number(row?.taskId || 0);
    const [logicalAsset, task] = row
      ? await Promise.all([
          assetId > 0 && assetVersionId > 0
            ? db("o_assets as asset")
              .innerJoin("o_image as version", "version.id", "asset.imageId")
              .where({
                "asset.id": assetId,
                "asset.projectId": projectId,
                "asset.type": "clip",
                "version.id": assetVersionId,
                "version.assetsId": assetId,
                "version.type": "clip",
                "version.state": "已完成",
              })
              .select("asset.id as assetId", "version.id as assetVersionId")
              .first()
            : Promise.resolve(undefined),
          taskId > 0
            ? db("o_tasks")
              .where({
                id: taskId,
                projectId,
                taskClass: "成片合成",
              })
              .select("id", "state", "reason", "startTime")
              .first()
            : Promise.resolve(undefined),
        ])
      : [undefined, undefined];
    return res.status(200).send(success({
      asset: row
        ? {
            id: String(row.id),
            taskId: String(row.taskId),
            assetId: logicalAsset ? Number(logicalAsset.assetId) : null,
            assetVersionId: logicalAsset
              ? Number(logicalAsset.assetVersionId)
              : null,
            url: String(row.url || ""),
            width: Number(row.width || 0),
            height: Number(row.height || 0),
            durationMs: Number(row.durationMs || 0),
            createdAt: Number(row.createTime || 0),
            audioIncluded: Boolean(metadata.audioIncluded),
            task: task
              ? {
                  id: String(task.id),
                  state: String(task.state || ""),
                  reason: task.reason == null ? null : String(task.reason),
                  startedAt: Number(task.startTime || 0),
                }
              : null,
          }
        : null,
    }));
  },
);
