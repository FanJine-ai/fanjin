import { guMicrosPerGu } from "@/lib/billingUnits";
import express from "express";
import { z } from "zod";
import { billingLedgerStatuses, billingLedgerTypes, listBillingLedger, type BillingLedger } from "@/lib/billing";
import { secureCsvCell } from "@/lib/requestLogCsv";
import { requireWorkspacePermission } from "@/middleware/permissions";

const router = express.Router();
router.use(requireWorkspacePermission("billing:read"));

const bodySchema = z.object({
  workspaceId: z.string().optional().nullable(),
  type: z.enum(billingLedgerTypes).optional().nullable(),
  status: z.enum(billingLedgerStatuses).optional().nullable(),
  taskId: z.string().optional().nullable(),
  maxRows: z.number().int().positive().max(20_000).optional(),
});

function workspaceIdOf(req: express.Request, workspaceId?: string | null): string {
  return workspaceId || (req as any).auth?.workspaceId || "default";
}

function gu(value?: number) {
  return (Number(value || 0) / guMicrosPerGu).toFixed(6);
}

function formatTime(value?: number) {
  if (!value) return "";
  const date = new Date(Number(value));
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function toCsv(rows: BillingLedger[]) {
  const header = [
    "时间",
    "类型",
    "状态",
    "方向",
    "币种",
    "金额(GU)",
    "金额(micros)",
    "余额前(GU)",
    "余额后(GU)",
    "冻结前(GU)",
    "冻结后(GU)",
    "授信额度(GU)",
    "说明",
    "任务ID",
    "API Key ID",
    "请求ID",
    "操作人ID",
    "流水ID",
  ];
  const body = rows.map((row) =>
    [
      formatTime(row.createTime),
      row.type,
      row.status,
      ["recharge", "release", "refund"].includes(row.type) ? "credit" : row.type === "freeze" || row.type === "deduct" ? "debit" : "neutral",
      row.currency,
      gu(row.amountMicros),
      row.amountMicros,
      gu(row.balanceBeforeMicros),
      gu(row.balanceAfterMicros),
      gu(row.frozenBeforeMicros),
      gu(row.frozenAfterMicros),
      gu(row.creditLimitMicros),
      row.description || "",
      row.taskId || "",
      row.apiKeyId || "",
      row.requestId || "",
      row.operatorUserId || "",
      row.id,
    ].map(secureCsvCell).join(","),
  );
  return `\uFEFF${[header.map(secureCsvCell).join(","), ...body].join("\n")}\n`;
}

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });

  const workspaceId = workspaceIdOf(req, parsed.data.workspaceId);
  const maxRows = Math.max(1, Math.min(Number(parsed.data.maxRows || 5000), 20_000));
  const pageSize = 500;
  const items: BillingLedger[] = [];

  for (let pageNum = 1; items.length < maxRows; pageNum += 1) {
    const page = await listBillingLedger({
      workspaceId,
      type: parsed.data.type,
      status: parsed.data.status,
      taskId: parsed.data.taskId,
      pageNum,
      pageSize,
    });
    items.push(...page.items);
    if (!page.items.length || items.length >= page.total) break;
  }

  const today = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="fanjin-billing-ledger-${today}.csv"`);
  return res.status(200).send(toCsv(items.slice(0, maxRows)));
});
