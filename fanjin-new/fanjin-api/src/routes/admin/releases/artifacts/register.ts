import express from "express";
import { z } from "zod";
import { serializeAdminReleaseArtifact } from "@/lib/adminReleaseArtifactDto";
import { writeAuditLog } from "@/lib/audit";
import { registerReleaseArtifact, ReleaseDeploymentError } from "@/lib/releaseDeployments";
import { success } from "@/lib/responseFormat";
import { requireReleasePublisher } from "@/middleware/permissions";

const router = express.Router();
router.use(requireReleasePublisher);

const bodySchema = z.object({
  releaseId: z.string().uuid(),
  reservationId: z.string().uuid(),
  sha256: z.string().trim().regex(/^[a-fA-F0-9]{64}$/, "sha256 必须是 64 位十六进制摘要"),
  manifest: z.record(z.string(), z.unknown()),
  idempotencyKey: z.string().trim().min(8).max(128),
}).strict();

function operatorUserId(req: express.Request): number {
  const value = (req as any).auth?.user?.id ?? (req as any).user?.id;
  return value == null ? 0 : Number(value);
}

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: parsed.error.issues[0]?.message || "参数错误", errors: parsed.error.issues });
  try {
    const result = await registerReleaseArtifact({
      releaseId: parsed.data.releaseId,
      reservationId: parsed.data.reservationId,
      sha256: parsed.data.sha256,
      manifest: parsed.data.manifest,
      idempotencyKey: parsed.data.idempotencyKey,
      operatorUserId: operatorUserId(req),
    });
    const item = result.artifact;
    await writeAuditLog(req, {
      action: "admin.release_artifact.register",
      resourceType: "release_artifact",
      resourceId: item.id,
      metadata: {
        releaseId: item.releaseId,
        sha256: item.sha256,
        status: item.status,
        revision: item.revision,
      },
    });
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Pragma", "no-cache");
    return res.status(200).send(success(serializeAdminReleaseArtifact(item, {
      idempotentReplay: result.idempotent,
    })));
  } catch (error) {
    if (error instanceof ReleaseDeploymentError) return res.status(error.status).send({ message: error.message, code: error.code });
    throw error;
  }
});
