import express from "express";
import { z } from "zod";
import { BillingError, deductWorkspace } from "@/lib/billing";
import { success } from "@/lib/responseFormat";
import { requirePlatformAdmin } from "@/middleware/permissions";

const router = express.Router();
router.use(requirePlatformAdmin);

const bodySchema = z.object({
  workspaceId: z.string().optional().nullable(),
  amountMicros: z.number().int().positive(),
  currency: z.string().optional(),
  reservationId: z.string().optional().nullable(),
  usageRecordId: z.string().optional().nullable(),
  taskId: z.string().optional().nullable(),
  apiKeyId: z.string().optional().nullable(),
  requestId: z.string().optional().nullable(),
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
    res.status(200).send(
      success(
        await deductWorkspace({
          ...parsed.data,
          workspaceId: workspaceIdOf(req, parsed.data.workspaceId),
          operatorUserId: operatorUserIdOf(req),
        }),
      ),
    );
  } catch (err) {
    return sendBillingError(res, err);
  }
});
