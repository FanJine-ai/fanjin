import express from "express";
import { z } from "zod";
import {
  DIRECTOR_SCENE_V1_DRAFT_KEY,
  DIRECTOR_SCENE_V1_EPISODE_ID,
  DIRECTOR_SCENE_V1_MAX_BYTES,
  DirectorSceneBindingError,
  DirectorSceneStorageError,
  directorSceneDigest,
  directorSceneV1Schema,
  validateDirectorSceneBindings,
} from "@/lib/directorSceneV1";
import { DurableCommandIdempotencyError } from "@/lib/durableCommandIdempotency";
import { executeDurableProjectMutation } from "@/lib/durableProjectMutation";
import { isPostgresClient } from "@/lib/dbDialect";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { requireProjectPermission } from "@/middleware/projectAccess";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number().int().positive(),
    data: z.unknown(),
  }),
  requireProjectPermission("project:write"),
  async (req, res) => {
    const projectId = Number(req.body.projectId);
    const parsed = directorSceneV1Schema.safeParse(req.body.data);
    if (!parsed.success) {
      return res.status(422).send({
        code: "director_scene_invalid",
        message: "3D 预演场景格式无效，请修正场景、机位或分镜绑定后重试",
      });
    }
    const scene = parsed.data;
    const serialized = JSON.stringify(scene);
    if (Buffer.byteLength(serialized, "utf8") > DIRECTOR_SCENE_V1_MAX_BYTES) {
      return res.status(413).send({
        code: "director_scene_too_large",
        message: "3D 预演场景过大，请减少角色、物体或走位关键帧",
      });
    }
    try {
      const result = await executeDurableProjectMutation({
        req,
        scope: "director-scene:save",
        request: { projectId, data: scene },
        mutate: async (transaction) => {
          await validateDirectorSceneBindings(transaction, projectId, scene);
          let rowQuery = transaction("o_agentWorkData")
            .where({
              projectId,
              episodesId: DIRECTOR_SCENE_V1_EPISODE_ID,
              key: DIRECTOR_SCENE_V1_DRAFT_KEY,
            })
            .select("id", "data", "updateTime");
          if (isPostgresClient(transaction)) rowQuery = rowQuery.forUpdate();
          const row = await rowQuery.first();
          let storedSavedAt = 0;
          if (row?.data) {
            try {
              const stored = directorSceneV1Schema.safeParse(JSON.parse(String(row.data)));
              if (!stored.success) {
                throw new DirectorSceneStorageError(
                  409,
                  "director_scene_corrupted",
                  "云端 3D 预演数据损坏，已阻止覆盖，请先保留证据并联系维护人员",
                );
              }
              storedSavedAt = stored.data.savedAt;
            } catch (error) {
              if (error instanceof DirectorSceneStorageError) throw error;
              throw new DirectorSceneStorageError(
                409,
                "director_scene_corrupted",
                "云端 3D 预演数据损坏，已阻止覆盖，请先保留证据并联系维护人员",
              );
            }
          }
          if (row?.id && storedSavedAt > scene.savedAt) {
            return {
              accepted: false,
              reason: "stale_snapshot",
              updatedAt: Number(row.updateTime || Date.now()),
              digest: null,
            };
          }
          const now = Date.now();
          if (row?.id) {
            await transaction("o_agentWorkData").where({ id: row.id }).update({
              data: serialized,
              updateTime: now,
            });
          } else {
            await transaction("o_agentWorkData").insert({
              projectId,
              episodesId: DIRECTOR_SCENE_V1_EPISODE_ID,
              key: DIRECTOR_SCENE_V1_DRAFT_KEY,
              data: serialized,
              createTime: now,
              updateTime: now,
            });
          }
          return {
            accepted: true,
            updatedAt: now,
            digest: directorSceneDigest(scene),
            boundStoryboardIds: scene.shotBindings.map((binding) => binding.storyboardId),
          };
        },
      });
      return res.status(result.responseStatus).send(success(result.data));
    } catch (error) {
      if (error instanceof DirectorSceneBindingError) {
        return res.status(error.status).send({
          code: error.code,
          message: error.message,
        });
      }
      if (error instanceof DirectorSceneStorageError) {
        return res.status(error.status).send({
          code: error.code,
          message: error.message,
        });
      }
      if (error instanceof DurableCommandIdempotencyError) {
        return res.status(error.status).send({
          code: error.code,
          message: error.message,
        });
      }
      throw error;
    }
  },
);
