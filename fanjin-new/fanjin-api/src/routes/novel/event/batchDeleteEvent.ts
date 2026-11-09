import express from "express";
import { z } from "zod";
import { legacyDeletionWorkflowUnavailable } from "@/lib/legacyDeletionSafety";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    ids: z.array(z.number()),
  }),
  legacyDeletionWorkflowUnavailable,
);
