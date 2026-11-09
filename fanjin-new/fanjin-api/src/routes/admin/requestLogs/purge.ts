import express from "express";
import { z } from "zod";
import { writeAuditLog } from "@/lib/audit";
import { purgeRequestLogs } from "@/lib/requestLogAdmin";
import { success } from "@/lib/responseFormat";
import { requirePlatformAdmin } from "@/middleware/permissions";

const router = express.Router();
router.use(requirePlatformAdmin);

const bodySchema = z.object({
  olderThanDays: z.number().int().positive().max(3650),
  dryRun: z.boolean().optional(),
  confirm: z.string().optional().nullable(),
});

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  const dryRun = parsed.data.dryRun !== false;
  if (!dryRun && parsed.data.confirm !== "PURGE_REQUEST_LOGS") {
    return res.status(400).send({ message: "清理请求日志需要确认口令 PURGE_REQUEST_LOGS" });
  }

  const result = await purgeRequestLogs({ olderThanDays: parsed.data.olderThanDays, dryRun });
  await writeAuditLog(req, {
    action: dryRun ? "admin.request_log.purge_preview" : "admin.request_log.purge",
    resourceType: "request_log",
    metadata: result,
  });
  return res.status(200).send(success(result));
});
