import express from "express";
import { z } from "zod";
import { formatPublicRelayTask, listRelayTasks, relayEndpointTypes } from "@/lib/relay";
import { success } from "@/lib/responseFormat";
import { isPlatformAdmin, requireWorkspacePermission } from "@/middleware/permissions";

const router = express.Router();
router.use(requireWorkspacePermission("api_key:read"));

const statuses = ["queued", "running", "enhancing", "mocked", "succeeded", "failed", "cancelled"] as const;

export const bodySchema = z.object({
  workspaceId: z.string().optional().nullable(),
  endpointType: z.enum(relayEndpointTypes).optional().nullable(),
  status: z.enum(statuses).optional().nullable(),
  model: z.string().optional().nullable(),
  taskId: z.string().optional().nullable(),
  pageNum: z.number().int().optional(),
  pageSize: z.number().int().optional(),
});

function scopedWorkspaceId(req: express.Request, requested?: string | null): string {
  if (isPlatformAdmin(req) && requested) return requested;
  return String((req as any).auth?.workspaceId || requested || "default");
}

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });

  const workspaceId = scopedWorkspaceId(req, parsed.data.workspaceId);
  const result = await listRelayTasks({
    endpointType: parsed.data.endpointType || undefined,
    status: parsed.data.status || undefined,
    model: parsed.data.model || undefined,
    taskIds: parsed.data.taskId ? [parsed.data.taskId] : undefined,
    workspaceId,
    pageNum: parsed.data.pageNum,
    pageSize: parsed.data.pageSize,
  });

  const items = await Promise.all(
    result.items.map((task) => formatPublicRelayTask(task)),
  );
  return res.status(200).send(success({ ...result, items }));
});
