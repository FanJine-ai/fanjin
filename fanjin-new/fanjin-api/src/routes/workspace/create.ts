import express from "express";
import { z } from "zod";
import { db } from "@/utils/db";
import {
  AuthError,
  createWorkspaceInTransaction,
  getAuthProfile,
} from "@/lib/auth";
import {
  allocateAccountWalletToWorkspaceInTransaction,
  BillingError,
} from "@/lib/billing";
import { error, success } from "@/lib/responseFormat";
import { writeAuditLog } from "@/lib/audit";

const router = express.Router();

const bodySchema = z.object({
  name: z.string().min(1).max(64),
  switchTo: z.boolean().optional(),
  initialAllocationMicros: z.number().int().nonnegative().optional(),
}).strict();

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });

  try {
    const userId = Number((req as any).auth?.user?.id || 0);
    const sessionId = (req as any).auth?.session?.id || (req as any).auth?.user?.sid || null;
    if (!userId) throw new AuthError("未登录", 401);
    const initialAllocationMicros = Number(parsed.data.initialAllocationMicros || 0);
    let workspaceId = "";
    await db.transaction(async (trx) => {
      const created = await createWorkspaceInTransaction(trx, {
        userId,
        name: parsed.data.name,
        switchTo: parsed.data.switchTo,
        sessionId,
      });
      workspaceId = created.workspaceId;
      if (initialAllocationMicros > 0) {
        await allocateAccountWalletToWorkspaceInTransaction(trx, {
          userId,
          workspaceId,
          amountMicros: initialAllocationMicros,
          description: "创建工作区时分配账号 GU 余额",
          idempotencyKey: `workspace-create-allocation-${workspaceId}`,
          metadata: { sourceContext: "workspace_create" },
          operatorUserId: userId,
        });
      }
      await writeAuditLog(req, {
        workspaceId,
        action: "workspace.create",
        resourceType: "workspace",
        resourceId: workspaceId,
        required: true,
        metadata: {
          name: parsed.data.name,
          initialAllocationMicros,
        },
      }, trx);
    });

    const profile = await getAuthProfile(db as any, userId);
    return res.status(200).send(success(profile, "工作区已创建"));
  } catch (err: any) {
    const status = err instanceof AuthError || err instanceof BillingError ? err.status : 500;
    return res.status(status).send(error(err?.message || "创建工作区失败"));
  }
});
