// 管理员兑换码管理端点
import express from "express";
import { z } from "zod";
import requirePlatformAdmin from "@/middleware/auth";
import { writeAuditLog } from "@/lib/audit";
import { error } from "@/lib/responseFormat";
import { generateRedemptionCodes, listRedemptionCodes, disableRedemptionCode } from "@/lib/redemptionCode";

const router = express.Router();
const generateBodySchema = z.object({
  count: z.number().int().min(1).max(1000),
  amountMicros: z.number().int().positive(),
  expiresAt: z.number().int().positive().optional().nullable(),
  batchNote: z.string().trim().optional().nullable(),
}).strict();

// 批量生成兑换码
router.post("/generate", requirePlatformAdmin, async (req, res) => {
  const auth = (req as any).auth;
  const parsed = generateBodySchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  const data = parsed.data;
  const generated = await generateRedemptionCodes({
    count: data.count,
    amountMicros: data.amountMicros,
    expiresAt: data.expiresAt ?? null,
    batchNote: data.batchNote || undefined,
    operatorUserId: auth.user.id,
  });
  await writeAuditLog(req, {
    action: "admin.redemption.generate",
    resourceType: "redemption_batch",
    resourceId: generated.batchId,
    metadata: {
      count: generated.codes.length,
      amountMicros: data.amountMicros,
      expiresAt: data.expiresAt ?? null,
      batchNote: data.batchNote || null,
    },
  });
  res.json({ ok: true, batchId: generated.batchId, codes: generated.codes, count: generated.codes.length });
});

// 列表
router.get("/list", requirePlatformAdmin, async (req, res) => {
  const { page, pageSize, status, batchId } = req.query;
  const result = await listRedemptionCodes({
    page: Number(page) || 1,
    pageSize: Number(pageSize) || 20,
    status: status as string | undefined,
    batchId: batchId as string | undefined,
  });
  res.json(result);
});

// 禁用
router.post("/:id/disable", requirePlatformAdmin, async (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!id) return res.status(400).send(error("兑换码 ID 不能为空", { code: "REDEMPTION_ID_REQUIRED" }));
  const result = await disableRedemptionCode(id);
  if (!result.ok && result.reason === "not_found") {
    return res.status(404).send(error("兑换码不存在", { code: "REDEMPTION_NOT_FOUND" }));
  }
  if (!result.ok) {
    return res.status(409).send(error("兑换码已不处于可禁用状态", {
      code: "REDEMPTION_NOT_UNUSED",
      status: result.status,
    }));
  }
  await writeAuditLog(req, {
    action: "admin.redemption.disable",
    resourceType: "redemption_code",
    resourceId: id,
    metadata: { status: "disabled" },
  });
  res.json({ ok: true });
});

export default router;
