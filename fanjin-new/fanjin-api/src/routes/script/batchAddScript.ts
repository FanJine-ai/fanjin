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
    data: z.array(
      z.object({
        scriptName: z.string().trim().min(1),
        scriptData: z.string().trim().min(1),
      }).strict(),
    ).min(1),
    projectId: z.number().int().positive(),
    autoCreateStoryboardDrafts: z.boolean().optional().default(false),
  }),
  async (req, res) => {
    const { data, projectId, autoCreateStoryboardDrafts } = req.body;
    try {
      const result = await executeDurableProjectMutation({
        req,
        scope: "script:batch-add",
        request: { data, projectId, autoCreateStoryboardDrafts },
        mutate: async (transaction) => {
          const ids: number[] = [];
          const createTime = Date.now();
          for (const item of data) {
            const scriptId = await insertAndReturnId(transaction, "o_script", {
              name: item.scriptName,
              content: item.scriptData,
              projectId,
              createTime,
            });
            ids.push(scriptId);
            if (autoCreateStoryboardDrafts) {
              await createStoryboardDraftsForScript(transaction, {
                projectId,
                scriptId,
                scriptName: item.scriptName,
                content: item.scriptData,
              });
            }
          }
          return { message: "添加剧本成功", ids, count: ids.length };
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
