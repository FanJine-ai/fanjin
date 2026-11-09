import express from "express";
import { z } from "zod";
import { legacyDeletionWorkflowUnavailable } from "@/lib/legacyDeletionSafety";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

// 删除原文
export default router.post(
  "/",
  validateFields({
    id: z.number(),
  }),
  legacyDeletionWorkflowUnavailable,
);
