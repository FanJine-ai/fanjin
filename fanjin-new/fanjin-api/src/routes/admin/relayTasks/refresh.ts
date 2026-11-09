import express from "express";
import { z } from "zod";
import { getRelayTask, refreshRelayTask } from "@/lib/relay";
import { success } from "@/lib/responseFormat";
import { writeAuditLog } from "@/lib/audit";
import { requirePlatformAdmin } from "@/middleware/permissions";
import { adminRelayTaskResponse } from "@/lib/relayResponseRedaction";

const router = express.Router();
router.use(requirePlatformAdmin);

const bodySchema = z.object({
  id: z.string().min(1),
});

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });

  const task = await getRelayTask(parsed.data.id);
  if (!task) return res.status(404).send({ message: "任务不存在" });

  const refreshed = await refreshRelayTask(task);
  await writeAuditLog(req, {
    workspaceId: refreshed.workspaceId,
    action: "relay_task.refresh",
    resourceType: "relay_task",
    resourceId: refreshed.id,
    metadata: {
      previousStatus: task.status,
      nextStatus: refreshed.status,
      provider: refreshed.provider,
      providerTaskId: refreshed.providerTaskId,
    },
  });

  return res.status(200).send(success(adminRelayTaskResponse(refreshed)));
});
