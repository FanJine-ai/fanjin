import express from "express";
import { z } from "zod";
import { BillingError, billingCurrency, microsFromYuan } from "@/lib/billing";
import { applyAccountWalletCredit } from "@/lib/accountWallet";
import { success } from "@/lib/responseFormat";
import { requirePlatformAdmin } from "@/middleware/permissions";
import { db } from "@/utils/db";
import {
  CommercialTenantError,
  createCommercialCreditLotInTransaction,
  requestCommercialTenant,
} from "@/lib/commercialTenant";

const router = express.Router();

const bodySchema = z.object({
  workspaceId: z.string().trim().min(1),
  amountMicros: z.number().int().positive().optional(),
  amountYuan: z.number().positive().optional(),
  description: z.string().optional(),
  idempotencyKey: z.string().trim().min(1).max(200),
}).superRefine((value, ctx) => {
  if ((value.amountMicros == null) === (value.amountYuan == null)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "amountMicros 和 amountYuan 必须且只能提供一个",
      path: ["amountMicros"],
    });
  }
});

router.use(requirePlatformAdmin);

async function workspaceOwnerUserId(workspaceId: string): Promise<number> {
  const row = await db("o_workspace").where({ id: workspaceId }).select("ownerUserId").first();
  const userId = Number(row?.ownerUserId || 0);
  if (!userId) throw new BillingError("找不到工作区负责人，无法给账号钱包入账", 400);
  return userId;
}

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });

  try {
    const amountMicros = parsed.data.amountMicros ?? microsFromYuan(parsed.data.amountYuan || 0);
    const operatorUserId = Number(((req as any).auth?.user || (req as any).user)?.id || 0) || null;
    const ownerUserId = await workspaceOwnerUserId(parsed.data.workspaceId);
    const commercialTenant = requestCommercialTenant(req);
    res.status(200).send(
      success(
        await db.transaction(async (trx) => {
          const walletCredit = await applyAccountWalletCredit(trx, {
            userId: ownerUserId,
            workspaceId: parsed.data.workspaceId,
            currency: billingCurrency,
            type: "manual_credit",
            description: parsed.data.description || "管理员充值到账号 GU 钱包",
            metadata: {
              source: "billing_topup_api",
              amountYuan: parsed.data.amountYuan ?? null,
              sellerTenantId: commercialTenant.id,
            },
            idempotencyKey: parsed.data.idempotencyKey,
            operatorUserId,
            amountMicros,
          });
          const commercialLot = await createCommercialCreditLotInTransaction(trx, {
            userId: ownerUserId,
            sellerTenantId: commercialTenant.id,
            amountMicros,
            retailAmountMicros: parsed.data.amountYuan == null ? null : Math.round(parsed.data.amountYuan * 1_000_000),
            accountWalletLedgerId: walletCredit.ledger.id,
            sourceType: "billing_topup_api",
            sourceId: parsed.data.idempotencyKey,
            idempotencyKey: `credit-lot:topup:${parsed.data.idempotencyKey}`,
            collectorTenantId: commercialTenant.id,
            metadata: { workspaceId: parsed.data.workspaceId },
            operatorUserId,
          });
          return { ...walletCredit, commercialCreditLot: commercialLot.lot, sellerTenantId: commercialTenant.id };
        }),
      ),
    );
  } catch (err) {
    if (err instanceof BillingError) return res.status(err.status).send({ message: err.message });
    if (err instanceof CommercialTenantError) return res.status(err.status).send({ message: err.message, code: err.code });
    return res.status(400).send({ message: err instanceof Error ? err.message : "充值失败" });
  }
});
