import express from "express";
import { z } from "zod";

import { db } from "@/utils/db";
import { error, success } from "@/lib/responseFormat";
import { requirePlatformAdmin } from "@/middleware/permissions";
import { writeAuditLog } from "@/lib/audit";
import { confirmProviderCostWithOfficialBill } from "@/lib/consumptionAllocation";
import {
  TenantReconciliationError,
  closeSettlementPeriod,
  exportSettlementPeriod,
  listSettlementPeriods,
  preflightSettlementPeriod,
  reconciliationSummary,
  reopenSettlementPeriod,
} from "@/lib/tenantReconciliation";

const router = express.Router();
router.use(requirePlatformAdmin);

const periodKeySchema = z.string().trim().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "账期格式必须为 YYYY-MM");

const invoiceImportSchema = z.object({
  items: z.array(z.object({
    usageId: z.string().trim().min(1).max(128),
    provider: z.string().trim().min(1).max(64),
    officialCostMicros: z.number().int().min(0),
    invoiceId: z.string().trim().max(128).optional(),
    billingPeriod: z.string().trim().max(16).optional(),
    currency: z.string().trim().max(8).optional(),
  })).min(1).max(500),
}).strict();

const closeSchema = z.object({
  settlementPolicyId: z.string().trim().max(64).optional(),
  settlementPolicyRevision: z.number().int().min(1).optional(),
}).strict();

const reopenSchema = z.object({
  reason: z.string().trim().min(5).max(500),
}).strict();

function reconciliationErrorResponse(res: express.Response, err: unknown) {
  if (err instanceof TenantReconciliationError) {
    return res.status(err.status).send(error(err.message, { code: err.code }));
  }
  const message = String((err as Error)?.message || "");
  if (message.startsWith("AUDIT_REQUIRED_WRITE_FAILED")) {
    return res.status(503).send(error("审计服务不可用，操作已阻止", { code: "FJADMIN_AUDIT_UNAVAILABLE" }));
  }
  throw err;
}

/**
 * GET /api/admin/tenantReconciliation/summary
 * 四口径汇总：注册租户 / 当前所属租户 / 实际收款租户 / 实际消费+官方成本。
 */
router.get("/summary", async (req, res) => {
  const summary = await reconciliationSummary(db as any);
  return res.status(200).send(success(summary));
});

/**
 * GET /api/admin/tenantReconciliation/payment-orders
 * 支付订单明细（可按收款租户筛选）。
 */
router.get("/payment-orders", async (req, res) => {
  const collectorTenantId = String(req.query.collectorTenantId || "").trim();
  const query = (db as any)("o_payment_order")
    .whereIn("status", ["paid", "refunded", "refunding"])
    .orderBy("createdAt", "desc")
    .limit(200);
  if (collectorTenantId) query.where({ collectorTenantId });
  const rows = await query;
  return res.status(200).send(success({
    items: rows.map((row: any) => ({
      orderId: String(row.id),
      outTradeNo: String(row.outTradeNo || ""),
      collectorTenantId: String(row.collectorTenantId || row.sellerTenantId || ""),
      registeredTenantIdSnapshot: row.registeredTenantIdSnapshot || null,
      ownerTenantIdSnapshot: row.ownerTenantIdSnapshot || null,
      amountMicros: Number(row.amountMicros || 0),
      refundedAmountMicros: Number(row.refundedAmountMicros || 0),
      status: String(row.status),
      paidAt: row.paidAt == null ? null : Number(row.paidAt),
      createdAt: Number(row.createdAt || 0),
    })),
  }));
});

/**
 * GET /api/admin/tenantReconciliation/consumption-allocations
 * 实际消费分摊明细（可按口径字段筛选）。
 */
router.get("/consumption-allocations", async (req, res) => {
  const collectorTenantId = String(req.query.collectorTenantId || "").trim();
  const ownerTenantId = String(req.query.ownerTenantId || "").trim();
  const registeredTenantId = String(req.query.registeredTenantId || "").trim();
  const query = (db as any)("o_commercial_consumption_allocation")
    .orderBy("capturedAt", "desc")
    .limit(200);
  if (collectorTenantId) query.where({ collectorTenantId });
  if (ownerTenantId) query.where({ ownerTenantIdSnapshot: ownerTenantId });
  if (registeredTenantId) query.where({ registeredTenantIdSnapshot: registeredTenantId });
  const rows = await query;
  return res.status(200).send(success({ items: rows }));
});

/**
 * GET /api/admin/tenantReconciliation/provider-costs
 * 官方供应商成本账本（估算/确认/差异）。
 */
router.get("/provider-costs", async (req, res) => {
  const state = String(req.query.state || "").trim();
  const provider = String(req.query.provider || "").trim();
  const query = (db as any)("o_provider_cost_ledger").orderBy("createdAt", "desc").limit(200);
  if (state) query.where({ state });
  if (provider) query.where({ provider });
  const rows = await query;
  return res.status(200).send(success({ items: rows }));
});

/**
 * POST /api/admin/tenantReconciliation/provider-invoices/import
 * 导入官方账单：把估算成本确认为正式成本并形成差异调整（不覆盖原记录）。
 */
router.post("/provider-invoices/import", async (req, res) => {
  const parsed = invoiceImportSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  const operatorUserId = Number((req as any).auth?.user?.id || 0) || null;
  try {
    let updated = 0;
    let differenceMicros = 0;
    const results = [];
    for (const item of parsed.data.items) {
      const result = await confirmProviderCostWithOfficialBill(db as any, {
        usageId: item.usageId,
        provider: item.provider,
        officialCostMicros: item.officialCostMicros,
        invoiceId: item.invoiceId ?? null,
        billingPeriod: item.billingPeriod ?? null,
        currency: item.currency,
        operatorUserId,
      });
      updated += result.updated;
      differenceMicros += result.differenceMicros;
      results.push({ usageId: item.usageId, provider: item.provider, updated: result.updated });
    }
    await writeAuditLog(req, {
      action: "admin.tenant_reconciliation.provider_invoice.import",
      resourceType: "provider_cost_ledger",
      resourceId: null,
      required: true,
      metadata: { updated, differenceMicros, itemCount: parsed.data.items.length },
    });
    return res.status(200).send(success({ updated, differenceMicros, results }));
  } catch (err) {
    return reconciliationErrorResponse(res, err);
  }
});

/**
 * GET /api/admin/tenantReconciliation/periods
 * 账期列表。
 */
router.get("/periods", async (req, res) => {
  const periods = await listSettlementPeriods(db as any);
  return res.status(200).send(success({ items: periods }));
});

/**
 * POST /api/admin/tenantReconciliation/periods/:period/preflight
 * 账期预检（阻断项检查）。
 */
router.post("/periods/:period/preflight", async (req, res) => {
  const parsed = periodKeySchema.safeParse(req.params.period);
  if (!parsed.success) return res.status(400).send(error("账期格式必须为 YYYY-MM"));
  try {
    const result = await preflightSettlementPeriod(parsed.data, db as any);
    return res.status(200).send(success(result));
  } catch (err) {
    return reconciliationErrorResponse(res, err);
  }
});

/**
 * POST /api/admin/tenantReconciliation/periods/:period/close
 * 关闭账期（幂等；预检阻断时 409）。
 */
router.post("/periods/:period/close", async (req, res) => {
  const parsedPeriod = periodKeySchema.safeParse(req.params.period);
  const parsedBody = closeSchema.safeParse(req.body ?? {});
  if (!parsedPeriod.success || !parsedBody.success) {
    return res.status(400).send({ message: "参数错误" });
  }
  const operatorUserId = Number((req as any).auth?.user?.id || 0);
  if (!operatorUserId) return res.status(401).send(error("操作者身份缺失"));
  try {
    const result = await closeSettlementPeriod({
      periodKey: parsedPeriod.data,
      operatorUserId,
      settlementPolicyId: parsedBody.data.settlementPolicyId,
      settlementPolicyRevision: parsedBody.data.settlementPolicyRevision,
      audit: async (period, trx) => {
        await writeAuditLog(req, {
          action: "admin.tenant_reconciliation.period.close",
          resourceType: "tenant_settlement_period",
          resourceId: period.id,
          required: true,
          metadata: {
            periodKey: period.periodKey,
            settlementPolicyId: period.settlementPolicyId,
            settlementPolicyRevision: period.settlementPolicyRevision,
          },
        }, trx);
      },
    });
    return res.status(200).send(success(result));
  } catch (err) {
    return reconciliationErrorResponse(res, err);
  }
});

/**
 * POST /api/admin/tenantReconciliation/periods/:period/reopen
 * MT-P1-03 账期重开审批（仅平台 Root + MFA + 必填原因；写不可变重开记录）。
 */
router.post("/periods/:period/reopen", async (req, res) => {
  const parsedPeriod = periodKeySchema.safeParse(req.params.period);
  const parsedBody = reopenSchema.safeParse(req.body ?? {});
  if (!parsedPeriod.success || !parsedBody.success) {
    return res.status(400).send({ message: "参数错误" });
  }
  const actorRole = String((req as any).auth?.user?.role || "").toLowerCase();
  if (actorRole !== "root") {
    return res.status(403).send(error("仅平台 Root 可重开已关账期", { code: "PLATFORM_ROOT_REQUIRED" }));
  }
  const operatorUserId = Number((req as any).auth?.user?.id || 0);
  if (!operatorUserId) return res.status(401).send(error("操作者身份缺失"));
  try {
    const result = await reopenSettlementPeriod({
      periodKey: parsedPeriod.data,
      reason: parsedBody.data.reason,
      operatorUserId,
      audit: async (period, reopenEntry, trx) => {
        await writeAuditLog(req, {
          action: "admin.tenant_reconciliation.period.reopen",
          resourceType: "tenant_settlement_period",
          resourceId: period.id,
          required: true,
          metadata: {
            periodKey: period.periodKey,
            reason: reopenEntry.reason,
            previousClosedAt: reopenEntry.previousClosedAt,
          },
        }, trx);
      },
    });
    return res.status(200).send(success(result));
  } catch (err) {
    return reconciliationErrorResponse(res, err);
  }
});

/**
 * GET /api/admin/tenantReconciliation/periods/:period/export
 * 导出已关账期结算单（不可变快照）。
 */
router.get("/periods/:period/export", async (req, res) => {
  const parsed = periodKeySchema.safeParse(req.params.period);
  if (!parsed.success) return res.status(400).send(error("账期格式必须为 YYYY-MM"));
  try {
    const exported = await exportSettlementPeriod(parsed.data, db as any);
    return res.status(200).send(success(exported));
  } catch (err) {
    return reconciliationErrorResponse(res, err);
  }
});

export default router;
