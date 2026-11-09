import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { insertAndReturnId } from "@/lib/dbDialect";
import {
  DurableCommandIdempotencyError,
} from "@/lib/durableCommandIdempotency";
import { executeDurableProjectMutation } from "@/lib/durableProjectMutation";
import {
  assertNovelChapterText,
  MAX_NOVEL_IMPORT_CHARACTERS,
  NovelImportError,
} from "@/lib/novelImport";
const router = express.Router();

const novelChapterTextSchema = z.string().trim().min(1).max(MAX_NOVEL_IMPORT_CHARACTERS).superRefine((value, ctx) => {
  try {
    assertNovelChapterText(value);
  } catch (error) {
    if (error instanceof NovelImportError) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: error.message });
      return;
    }
    throw error;
  }
});

// 新增原文数据
export default router.post(
  "/",
  validateFields({
    projectId: z.number().int().positive(),
    data: z.array(
      z.object({
        index: z.number().int().positive(),
        reel: z.string().trim().min(1),
        chapter: z.string().trim().min(1),
        chapterData: novelChapterTextSchema,
      }).strict(),
    ).min(1),
  }),
  async (req, res) => {
    const { projectId, data } = req.body;
    try {
      const result = await executeDurableProjectMutation({
        req,
        scope: "novel:add",
        request: { projectId, data },
        mutate: async (transaction) => {
          const getLastChapterIndex = await transaction("o_novel")
            .where("projectId", projectId)
            .select("chapterIndex")
            .orderBy("chapterIndex", "desc")
            .first();
          let lastChapterIndex = Number(getLastChapterIndex?.chapterIndex || 0);
          const ids: number[] = [];
          for (const item of data) {
            const id = await insertAndReturnId(transaction, "o_novel", {
              projectId,
              chapterIndex: ++lastChapterIndex,
              reel: item.reel,
              chapter: item.chapter,
              chapterData: item.chapterData,
              createTime: Date.now(),
              eventState: -2,
              errorReason: null,
            });
            ids.push(id);
          }
          return {
            message: "新增原文成功",
            ids,
            eventState: "pending",
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
