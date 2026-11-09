import { publicModelId, publicH3Text, publicModelFields } from "@/lib/minimaxH3PublicIdentity";
import express from "express";
import { z } from "zod";
import {
  listRequestLogs,
  requestLogCapabilities,
  summarizeRequestLogs,
} from "@/lib/requestLogAdmin";
import { success } from "@/lib/responseFormat";
import { isPlatformAdmin, requireWorkspacePermission } from "@/middleware/permissions";

const router = express.Router();
router.use(requireWorkspacePermission("api_key:read"));

export const bodySchema = z.object({
  workspaceId: z.string().optional().nullable(),
  apiKeyPrefix: z.string().optional().nullable(),
  requestId: z.string().optional().nullable(),
  relayTaskId: z.string().optional().nullable(),
  path: z.string().optional().nullable(),
  statusCode: z.number().int().optional().nullable(),
  startTime: z.number().int().optional().nullable(),
  endTime: z.number().int().optional().nullable(),
  capability: z.enum(requestLogCapabilities).optional().nullable(),
  pageNum: z.number().int().optional(),
  pageSize: z.number().int().optional(),
  days: z.number().int().positive().max(90).optional(),
});

function scopedWorkspaceId(req: express.Request, requested?: string | null): string {
  if (isPlatformAdmin(req) && requested) return requested;
  return String((req as any).auth?.workspaceId || requested || "default");
}

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });

  const workspaceId = scopedWorkspaceId(req, parsed.data.workspaceId);
  const filters = {
    ...parsed.data,
    workspaceId,
  };
  const [list, stats] = await Promise.all([
    listRequestLogs(filters),
    summarizeRequestLogs({ ...filters, days: parsed.data.days || 30 }),
  ]);

  return res.status(200).send(success({ ...list, items: list.items.map(item => ({ ...item, metadata: publicModelFields(item.metadata), model: publicModelId(item.model), errorCode: item.errorCode ? publicH3Text(item.errorCode) : item.errorCode })), stats }));
});
