import express from "express";
import { z } from "zod";
import {
  adminPortraitComplianceStates,
  adminPortraitFaceScanStates,
  adminPortraitModerationStates,
  adminPortraitManualReviewStates,
  adminPortraitImageXReviewStates,
  adminPortraitProviderSyncStates,
  adminPortraitSubjectKinds,
  listAdminPortraitAssets,
} from "@/lib/adminPortraitAssets";
import { success } from "@/lib/responseFormat";
import { requirePlatformAdmin } from "@/middleware/permissions";
import { db } from "@/utils/db";

const router = express.Router();
router.use(requirePlatformAdmin);

const bodySchema = z.object({
  keyword: z.string().trim().max(120).optional(),
  workspaceId: z.string().trim().min(1).max(128).optional(),
  projectId: z.number().int().positive().optional(),
  subjectKind: z.enum(adminPortraitSubjectKinds).optional(),
  faceScanState: z.enum(adminPortraitFaceScanStates).optional(),
  moderationState: z.enum(adminPortraitModerationStates).optional(),
  complianceState: z.enum(adminPortraitComplianceStates).optional(),
  providerSyncState: z.enum(adminPortraitProviderSyncStates).optional(),
  manualReviewState: z.enum(adminPortraitManualReviewStates).optional(),
  imageXReviewState: z.enum(adminPortraitImageXReviewStates).optional(),
  providerChannelId: z.string().trim().min(1).max(128).optional(),
  pageNum: z.number().int().min(1).max(100_000).default(1),
  pageSize: z.number().int().min(1).max(100).default(20),
}).strict();

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).send({
      message: "参数错误",
      errors: parsed.error.issues,
    });
  }
  return res.status(200).send(success(await listAdminPortraitAssets({
    database: db,
    filters: parsed.data,
  })));
});
