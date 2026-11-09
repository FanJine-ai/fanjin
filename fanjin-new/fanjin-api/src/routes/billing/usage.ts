import { publicModelId, isFanjinH3Model } from "@/lib/minimaxH3PublicIdentity";
import express from "express";
import { z } from "zod";
import { listUsageLedger } from "@/lib/billing";
import { success } from "@/lib/responseFormat";
import { requireWorkspacePermission } from "@/middleware/permissions";

const router = express.Router();
router.use(requireWorkspacePermission("billing:read"));

const bodySchema = z.object({
  workspaceId: z.string().optional().nullable(),
  apiKeyId: z.string().optional().nullable(),
  taskId: z.string().optional().nullable(),
  endpointType: z.string().optional().nullable(),
  status: z.string().optional().nullable(),
  pageNum: z.number().int().positive().optional(),
  pageSize: z.number().int().positive().optional(),
});

function workspaceIdOf(req: express.Request, workspaceId?: string | null): string | null {
  return workspaceId || (req as any).auth?.workspaceId || null;
}

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });

  const result = await listUsageLedger({
    ...parsed.data,
    workspaceId: workspaceIdOf(req, parsed.data.workspaceId),
  });
  res.status(200).send(success({
    ...result,
    items: result.items.map(item => ({
      ...item,
      model: publicModelId(item.model),
      ...(isFanjinH3Model(item.model) ? { provider: "Fanjin", channelId: null } : {}),
    })),
  }));
});
