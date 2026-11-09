import express from "express";
import type { Knex } from "knex";
import { z } from "zod";
import { isAgentBillingReconcileEnabled } from "@/agent-runtime/featureFlags";
import {
  recordAgentBillingReconciliationFailure,
  recordAgentBillingReconciliationReport,
  scanAgentApprovalBillingReconciliation,
  AGENT_BILLING_RECONCILE_DEFAULT_LIMIT,
} from "@/agent-runtime/agentBillingReconciliation";
import { success } from "@/lib/responseFormat";
import { requirePlatformAdmin } from "@/middleware/permissions";
import { db } from "@/utils/db";

/**
 * R2/R3 审批-扣费对账报告(REVAMP-PLAN 2.4,只读)。
 * 与 /admin/billing/reconciliation(relay 层 freeze→settle 核账)互补:
 * 本端点按审批维度即时重扫,不落库、不修复;灰度
 * FANJIN_AGENT_BILLING_RECONCILE_ENABLED 默认关,关闭时 404。
 */
const router = express.Router();
router.use(requirePlatformAdmin);

const reportSchema = z.object({
  lookbackHours: z.number().positive().max(24 * 30).optional(),
  graceMinutes: z.number().min(0).max(24 * 60).optional(),
  limit: z.number().int().positive().max(1000).optional().default(AGENT_BILLING_RECONCILE_DEFAULT_LIMIT),
});

router.post("/report", async (req, res) => {
  if (!isAgentBillingReconcileEnabled()) {
    return res.status(404).send({ message: "API 404 Not Found" });
  }
  const parsed = reportSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).send({ message: parsed.error.issues[0]?.message || "参数错误" });
  try {
    const report = await scanAgentApprovalBillingReconciliation({
      database: db as unknown as Knex,
      lookbackMs: parsed.data.lookbackHours == null
        ? undefined
        : Math.round(parsed.data.lookbackHours * 60 * 60_000),
      graceMs: parsed.data.graceMinutes == null
        ? undefined
        : Math.round(parsed.data.graceMinutes * 60_000),
      limit: parsed.data.limit,
    });
    recordAgentBillingReconciliationReport(report);
    return res.send(success(report));
  } catch (error) {
    recordAgentBillingReconciliationFailure();
    return res.status(500).send({ message: (error as { message?: unknown })?.message || "对账扫描失败" });
  }
});

export default router;
