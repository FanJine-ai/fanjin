import express from "express";
import { z } from "zod";
import { writeAuditLog } from "@/lib/audit";
import { assertLegacyReleaseDeploymentWritesEnabled } from "@/lib/legacyReleaseDeploymentWrites";
import { ReleaseDeploymentError, startReleaseDeployment } from "@/lib/releaseDeployments";
import { success } from "@/lib/responseFormat";
import { requireReleasePublisher } from "@/middleware/permissions";

const router = express.Router();
router.use(requireReleasePublisher);

const bodySchema = z.object({
  releaseId: z.string().uuid(),
  releaseRevision: z.number().int().positive(),
  artifactId: z.string().uuid(),
  targetKeys: z.array(z.string().trim().min(1).max(128)).min(1).max(100).optional(),
  idempotencyKey: z.string().trim().min(8).max(128),
  previewDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

function operatorUserId(req: express.Request): number | null {
  const value = (req as any).auth?.user?.id ?? (req as any).user?.id;
  return value == null ? null : Number(value);
}

export default router.post("/", async (req, res) => {
  try {
    assertLegacyReleaseDeploymentWritesEnabled();
    const parsed = bodySchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).send({ message: parsed.error.issues[0]?.message || "参数错误", errors: parsed.error.issues });
    const result = await startReleaseDeployment({ ...parsed.data, operatorUserId: operatorUserId(req) });
    const item = result.deployment;
    await writeAuditLog(req, {
      action: "admin.release_deployment.start",
      resourceType: "release_deployment",
      resourceId: item.id,
      metadata: {
        releaseId: item.releaseId,
        artifactId: item.artifactId,
        scope: item.scope,
        status: item.status,
        revision: item.revision,
      },
    });
    return res.status(200).send(success({ ...item, idempotentReplay: result.idempotent }));
  } catch (error) {
    if (error instanceof ReleaseDeploymentError) return res.status(error.status).send({ message: error.message, code: error.code });
    throw error;
  }
});
