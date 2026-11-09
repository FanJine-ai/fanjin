import express from "express";
import { z } from "zod";
import { writeAuditLog } from "@/lib/audit";
import { collectRequestLogs, requestLogsToCsv } from "@/lib/requestLogAdmin";
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
  maxRows: z.number().int().positive().max(20_000).optional(),
});

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });

  const rows = await collectRequestLogs(parsed.data);
  await writeAuditLog(req, {
    workspaceId: parsed.data.workspaceId || null,
    action: "admin.request_log.export",
    resourceType: "request_log",
    metadata: {
      filters: parsed.data,
      rows: rows.length,
    },
  });
  const today = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="fanjin-request-logs-${today}.csv"`);
  return res.status(200).send(requestLogsToCsv(rows));
});
