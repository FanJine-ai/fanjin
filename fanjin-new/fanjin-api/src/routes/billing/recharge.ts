import express from "express";
import { z } from "zod";
import { BillingError, billingCurrency } from "@/lib/billing";
import { creditAccountWallet } from "@/lib/accountWallet";
import { success } from "@/lib/responseFormat";
import { requirePlatformAdmin } from "@/middleware/permissions";
import { db } from "@/utils/db";

const router = express.Router();
router.use(requirePlatformAdmin);

const bodySchema = z.object({
  workspaceId: z.string().optional().nullable(),
  amountMicros: z.number().int().positive(),
  currency: z.string().trim().toUpperCase().refine((value) => value === billingCurrency, {
    message: `仅支持 ${billingCurrency} 币种`,
  }).optional(),
  description: z.string().optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  idempotencyKey: z.string().trim().min(1).max(200),
});

function workspaceIdOf(req: express.Request, workspaceId?: string | null): string {
  return workspaceId || (req as any).auth?.workspaceId || "default";
}

function operatorUserIdOf(req: express.Request): number | null {
  const value = (req as any).auth?.user?.id ?? (req as any).user?.id;
  return value == null ? null : Number(value);
}

function sendBillingError(res: express.Response, err: unknown) {
  if (err instanceof BillingError) return res.status(err.status).send({ message: err.message });
  const message = err instanceof Error ? err.message : "账号钱包入账失败";
  if (/不足/.test(message)) return res.status(402).send({ message });
  return res.status(400).send({ message });
}

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
    const workspaceId = workspaceIdOf(req, parsed.data.workspaceId);
    const userId = await workspaceOwnerUserId(workspaceId);
    res.status(200).send(
      success(
        await creditAccountWallet({
          userId,
          workspaceId,
          amountMicros: parsed.data.amountMicros,
          currency: parsed.data.currency || billingCurrency,
          type: "manual_credit",
          description: parsed.data.description || "管理员充值到账号 GU 钱包",
          metadata: {
            ...(parsed.data.metadata || {}),
            source: "billing_recharge_api",
            workspaceId,
          },
          idempotencyKey: parsed.data.idempotencyKey,
          operatorUserId: operatorUserIdOf(req),
        }),
      ),
    );
  } catch (err) {
    return sendBillingError(res, err);
  }
});
