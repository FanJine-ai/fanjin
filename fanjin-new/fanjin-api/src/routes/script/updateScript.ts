import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { DurableCommandIdempotencyError } from "@/lib/durableCommandIdempotency";
import { executeDurableProjectMutation } from "@/lib/durableProjectMutation";
const router = express.Router();

// 编辑剧本
export default router.post(
  "/",
  validateFields({
    id: z.number().int().positive(),
    name: z.string().trim().min(1),
    content: z.string().trim().min(1),
    assets: z.array(z.number().int().positive())
      .refine((ids) => new Set(ids).size === ids.length, "素材 ID 不能重复")
      .optional(),
  }),
  async (req, res) => {
    const { id, name, content, assets } = req.body;
    const projectId = Number((req as any).project?.id || 0);
    try {
      const result = await executeDurableProjectMutation({
        req,
        scope: "script:update",
        request: { id, name, content, assets },
        mutate: async (transaction) => {
          const updated = await transaction("o_script")
            .where({ id, projectId })
            .update({ name, content });
          if (Number(updated) !== 1) {
            const missing = new Error("剧本不存在") as Error & { status?: number };
            missing.status = 404;
            throw missing;
          }
          if (assets !== undefined) {
            const assetsData = assets.length
              ? await transaction("o_assets")
                .where({ projectId })
                .whereIn("id", assets)
                .select("id")
              : [];
            if (assetsData.length !== assets.length) {
              const invalid = new Error("一个或多个关联素材不存在或不属于当前项目") as Error & {
                status?: number;
              };
              invalid.status = 409;
              throw invalid;
            }
            await transaction("o_scriptAssets").where({ scriptId: id }).delete();
            if (assetsData.length) {
              await transaction("o_scriptAssets").insert(
                assetsData.map((item) => ({
                  scriptId: id,
                  assetId: item.id,
                })),
              );
            }
          }
          return { message: "编辑剧本成功", id };
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
