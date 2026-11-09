import express from "express";
import { z } from "zod";
import { BillingError, getWorkspaceBillingSummary, setWorkspaceCreditLimit } from "@/lib/billing";
import { success } from "@/lib/responseFormat";
import { isPlatformAdmin, requireWorkspaceRole } from "@/middleware/permissions";

const router = express.Router();
router.use(requireWorkspaceRole({ requireManage: true }));

const bodySchema = z.object({
  workspaceId: z.string().optional().nullable(),
  creditLimitMicros: z.number().int().nonnegative().optional(),
  currency: z.string().optional(),
  description: z.string().optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  idempotencyKey: z.string().optional().nullable(),
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
  throw err;
}

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });

  try {
    const workspaceId = workspaceIdOf(req, parsed.data.workspaceId);
    if (parsed.data.creditLimitMicros !== undefined) {
      if (!isPlatformAdmin(req)) return res.status(403).send({ message: "需要平台管理员权限" });
      await setWorkspaceCreditLimit({
        workspaceId,
        creditLimitMicros: parsed.data.creditLimitMicros,
        currency: parsed.data.currency,
        description: parsed.data.description,
        metadata: parsed.data.metadata,
        idempotencyKey: parsed.data.idempotencyKey,
        operatorUserId: operatorUserIdOf(req),
      });
    }

    res.status(200).send(success(await getWorkspaceBillingSummary(workspaceId)));
  } catch (err) {
    return sendBillingError(res, err);
  }
});
