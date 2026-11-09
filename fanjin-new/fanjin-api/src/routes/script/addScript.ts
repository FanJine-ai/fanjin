import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { insertAndReturnId } from "@/lib/dbDialect";
import { DurableCommandIdempotencyError } from "@/lib/durableCommandIdempotency";
import { executeDurableProjectMutation } from "@/lib/durableProjectMutation";
import { createStoryboardDraftsForScript } from "@/lib/scriptStoryboardDraft";
const router = express.Router();

// 新增剧本
export default router.post(
  "/",
  validateFields({
    name: z.string().trim().min(1),
    content: z.string().trim().min(1),
    projectId: z.number().int().positive(),
    assets: z.array(z.number().int().positive())
      .refine((ids) => new Set(ids).size === ids.length, "素材 ID 不能重复"),
    autoCreateStoryboardDrafts: z.boolean().optional().default(false),
  }),
  async (req, res) => {
    const { name, content, projectId, assets, autoCreateStoryboardDrafts } = req.body;
    try {
      const result = await executeDurableProjectMutation({
        req,
        scope: "script:add",
        request: { name, content, projectId, assets, autoCreateStoryboardDrafts },
        mutate: async (transaction) => {
          const scriptId = await insertAndReturnId(transaction, "o_script", {
            name,
            content,
            projectId,
            createTime: Date.now(),
          });
          if (assets.length) {
            const assetsData = await transaction("o_assets")
              .where({ projectId })
              .whereIn("id", assets)
              .select("id");
            if (assetsData.length !== assets.length) {
              const invalid = new Error("一个或多个关联素材不存在或不属于当前项目") as Error & {
                status?: number;
              };
              invalid.status = 409;
              throw invalid;
            }
            await transaction("o_scriptAssets").insert(
              assetsData.map((item) => ({
                scriptId,
                assetId: item.id,
              })),
            );
          }
          if (autoCreateStoryboardDrafts) {
            await createStoryboardDraftsForScript(transaction, {
              projectId,
              scriptId,
              scriptName: name,
              content,
            });
          }
          return { message: "添加剧本成功", id: scriptId };
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
