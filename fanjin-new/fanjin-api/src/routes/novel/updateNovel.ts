import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { DurableCommandIdempotencyError } from "@/lib/durableCommandIdempotency";
import { executeDurableProjectMutation } from "@/lib/durableProjectMutation";
import { assertNovelChapterText, MAX_NOVEL_IMPORT_CHARACTERS } from "@/lib/novelImport";
const router = express.Router();

// 更新原文数据
export default router.post(
  "/",
  validateFields({
    id: z.number().int().positive(),
    index: z.union([
      z.number().int().positive(),
      z.string().trim().regex(/^[1-9]\d*$/),
    ]),
    reel: z.string().trim().min(1),
    chapter: z.string().trim().min(1),
    chapterData: z.string().trim().min(1).max(MAX_NOVEL_IMPORT_CHARACTERS).superRefine((value, ctx) => {
      try {
        assertNovelChapterText(value);
      } catch (error) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: error instanceof Error ? error.message : "小说正文无效" });
      }
    }),
    event: z.string().optional(),
  }),
  async (req, res) => {
    const { id, index, reel, chapter, chapterData, event } = req.body;
    const projectId = Number((req as any).project?.id || 0);
    try {
      const result = await executeDurableProjectMutation({
        req,
        scope: "novel:update",
        request: { id, index, reel, chapter, chapterData, event: event ?? null },
        mutate: async (transaction) => {
          const current = await transaction("o_novel")
            .where({ id, projectId })
            .first();
          if (!current) {
            const missing = new Error("小说章节不存在") as Error & { status?: number };
            missing.status = 404;
            throw missing;
          }
          const contentChanged = String(current.chapterData || "") !== chapterData;
          const nextEvent = contentChanged
            ? null
            : (event?.trim() || current.event || null);
          const count = await transaction("o_novel")
            .where({ id, projectId })
            .update({
              chapterIndex: index,
              reel,
              chapter,
              chapterData,
              event: nextEvent,
              eventState: contentChanged
                ? -2
                : (nextEvent ? 1 : Number(current.eventState ?? -2)),
              errorReason: contentChanged ? null : current.errorReason,
            });
          if (Number(count) !== 1) {
            const missing = new Error("小说章节不存在") as Error & { status?: number };
            missing.status = 404;
            throw missing;
          }
          return {
            message: "更新原文成功",
            eventInvalidated: contentChanged,
          };
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
