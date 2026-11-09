import express from "express";
import { z } from "zod";
import { listRequestLogs } from "@/lib/requestLogAdmin";
import { success } from "@/lib/responseFormat";
import { requirePlatformAdmin } from "@/middleware/permissions";

const router = express.Router();
router.use(requirePlatformAdmin);

const bodySchema = z.object({
  workspaceId: z.string().optional().nullable(),
  actorUserId: z.number().int().optional().nullable(),
  apiKeyPrefix: z.string().optional().nullable(),
  requestId: z.string().optional().nullable(),
  relayTaskId: z.string().optional().nullable(),
  path: z.string().optional().nullable(),
  statusCode: z.number().int().optional().nullable(),
  startTime: z.number().int().optional().nullable(),
  endTime: z.number().int().optional().nullable(),
  pageNum: z.number().int().optional(),
  pageSize: z.number().int().optional(),
});

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  return res.status(200).send(success(await listRequestLogs(parsed.data)));
});
