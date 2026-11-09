import express from "express";
import { z } from "zod";

import { writeAuditLog } from "@/lib/audit";
import { readAdminMachineIdentity } from "@/lib/adminMachineIdentity";
import {
  requestReleaseDeploymentReconciliation,
} from "@/lib/releaseDeploymentReconciliation";
import { ReleaseDeploymentError } from "@/lib/releaseDeployments";
import { success } from "@/lib/responseFormat";
import { requireReleaseReconciler } from "@/middleware/permissions";

const router = express.Router();
router.use(requireReleaseReconciler);

const bodySchema = z.object({
  id: z.string().uuid(),
  revision: z.number().int().positive(),
  intent: z.enum(["previous", "target"]),
  reason: z.string().trim().min(3).max(500),
  idempotencyKey: z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
}).strict();

function operatorUserId(req: express.Request): number {
  return Number((req as any).auth?.user?.id ?? (req as any).user?.id ?? 0);
}

function requestId(req: express.Request): string | null {
  const value = (req as any).requestId ?? req.headers["x-request-id"];
  return value == null ? null : String(value).slice(0, 200);
}

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).send({
      message: parsed.error.issues[0]?.message || "参数错误",
      code: "RELEASE_RECONCILE_REQUEST_INVALID",
      errors: parsed.error.issues,
    });
  }
  try {
    const result = await requestReleaseDeploymentReconciliation({
      ...parsed.data,
      operatorUserId: operatorUserId(req),
      requestId: requestId(req),
    });
    await writeAuditLog(req, {
      action: "admin.release_deployment.reconcile_requested",
      resourceType: "release_deployment",
      resourceId: parsed.data.id,
      metadata: {
        reconciliationId: result.reconciliation.id,
        intent: result.reconciliation.intent,
        reason: result.reconciliation.reason,
        status: result.reconciliation.status,
        deploymentRevision: result.deploymentRevision,
        idempotentReplay: result.idempotent,
        securityGate: readAdminMachineIdentity(req) ? "root+scoped-machine-key" : "root+mfa+admin.deployment-step-up",
      },
    });
    return res.status(200).send(success({
      ...result.reconciliation,
      deploymentRevision: result.deploymentRevision,
      idempotentReplay: result.idempotent,
    }));
  } catch (error) {
    if (error instanceof ReleaseDeploymentError) {
      return res.status(error.status).send({ message: error.message, code: error.code, details: error.details });
    }
    throw error;
  }
});
