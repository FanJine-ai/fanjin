import express from "express";
import { z } from "zod";
import { listReleaseDeployments } from "@/lib/releaseDeployments";
import { success } from "@/lib/responseFormat";
import { requireReleasePublisher } from "@/middleware/permissions";

const router = express.Router();
router.use(requireReleasePublisher);

const bodySchema = z.object({
  releaseId: z.string().uuid().optional().nullable(),
  scope: z.string().trim().min(1).max(64).optional().nullable(),
  status: z.enum([
    "queued",
    "running",
    "cancelling",
    "rolling_back",
    "succeeded",
    "failed",
    "cancelled",
    "rolled_back",
    "degraded_manual",
  ]).optional().nullable(),
  pageNum: z.number().int().positive().optional(),
  pageSize: z.number().int().positive().max(100).optional(),
}).strict();

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  return res.status(200).send(success(await listReleaseDeployments(parsed.data)));
});
