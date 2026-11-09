import express from "express";
import { z } from "zod";
import { BillingError } from "@/lib/billing";
import {
  listBillingReconciliationJobs,
  manuallyResolveBillingReconciliationJob,
  processBillingReconciliationBatch,
} from "@/lib/billingReconciliation";
import { success } from "@/lib/responseFormat";
import { requirePlatformAdmin } from "@/middleware/permissions";

const router = express.Router();
router.use(requirePlatformAdmin);

const listSchema = z.object({
  workspaceId: z.string().trim().optional().nullable(),
  status: z.enum(["pending", "leased", "manual_required", "resolved"]).optional().nullable(),
  limit: z.number().int().positive().max(500).optional().default(100),
});

const resolveSchema = z.object({
  jobId: z.string().trim().min(1),
  action: z.enum(["settle", "release", "platform_absorb_release"]),
  actualCostMicros: z.number().int().min(0).optional(),
  units: z.number().int().min(0).optional(),
  unit: z.string().trim().min(1).max(32).optional(),
  resolutionNote: z.string().trim().min(4).max(1000),
  scriptAssetCommandId: z.string().uuid().optional(),
});

function operatorUserId(req: express.Request): number | null {
  const value = (req as any).auth?.user?.id ?? (req as any).user?.id;
  return value == null ? null : Number(value);
}

function sendError(res: express.Response, error: any) {
  const status = error instanceof BillingError ? error.status : 500;
  return res.status(status).send({ message: error?.message || "核账操作失败" });
}

router.post("/list", async (req, res) => {
  const parsed = listSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).send({ message: parsed.error.issues[0]?.message || "参数错误" });
  try {
    const items = await listBillingReconciliationJobs(parsed.data);
    return res.send(success({ items, total: items.length }));
  } catch (error) {
    return sendError(res, error);
  }
});

router.post("/run", async (_req, res) => {
  try {
    const result = await processBillingReconciliationBatch({ limit: 100 });
    return res.send(success(result));
  } catch (error) {
    return sendError(res, error);
  }
});

router.post("/resolve", async (req, res) => {
  const parsed = resolveSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).send({ message: parsed.error.issues[0]?.message || "参数错误" });
  if (parsed.data.action === "settle" && (
    parsed.data.actualCostMicros === undefined || parsed.data.units === undefined || !parsed.data.unit
  )) {
    return res.status(400).send({ message: "settle 必须提供 actualCostMicros、units 和 unit" });
  }
  try {
    const result = await manuallyResolveBillingReconciliationJob({
      ...parsed.data,
      operatorUserId: operatorUserId(req),
    });
    return res.send(success(result));
  } catch (error) {
    return sendError(res, error);
  }
});

export default router;
