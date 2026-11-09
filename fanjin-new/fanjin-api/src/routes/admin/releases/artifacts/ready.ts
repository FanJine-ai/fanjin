import express from "express";
import { z } from "zod";
import { serializeAdminReleaseArtifact } from "@/lib/adminReleaseArtifactDto";
import { writeAuditLog } from "@/lib/audit";
import { markReleaseArtifactReady, ReleaseDeploymentError } from "@/lib/releaseDeployments";
import {
  enqueueReleaseArtifactVerification,
  getReleaseArtifactVerificationJob,
  ReleaseArtifactVerificationJobError,
} from "@/lib/releaseArtifactVerificationJobs";
import { success } from "@/lib/responseFormat";
import { requireReleasePublisher } from "@/middleware/permissions";

const router = express.Router();
router.use(requireReleasePublisher);

const bodySchema = z.object({
  id: z.string().uuid(),
  revision: z.number().int().positive(),
}).strict();

function operatorUserId(req: express.Request): number | null {
  const value = (req as any).auth?.user?.id ?? (req as any).user?.id;
  return value == null ? null : Number(value);
}

function asyncReadyEnabled(): boolean {
  const value = String(process.env.FANJIN_RELEASE_ARTIFACT_READY_ASYNC || "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  try {
    if (asyncReadyEnabled()) {
      const job = await enqueueReleaseArtifactVerification({
        artifactId: parsed.data.id,
        revision: parsed.data.revision,
        operatorUserId: operatorUserId(req),
      });
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("Pragma", "no-cache");
      return res.status(202).send(success({
        jobId: job.jobId,
        artifactId: job.artifactId,
        revision: job.revision,
        status: job.status,
        pollAfterMs: 2_000,
      }));
    }
    const item = await markReleaseArtifactReady({ artifactId: parsed.data.id, revision: parsed.data.revision });
    await writeAuditLog(req, {
      action: "admin.release_artifact.ready",
      resourceType: "release_artifact",
      resourceId: item.id,
      metadata: { releaseId: item.releaseId, sha256: item.sha256, status: item.status, revision: item.revision },
    });
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Pragma", "no-cache");
    return res.status(200).send(success(serializeAdminReleaseArtifact(item)));
  } catch (error) {
    if (error instanceof ReleaseArtifactVerificationJobError) {
      return res.status(error.status).send({ message: error.message, code: error.code });
    }
    if (error instanceof ReleaseDeploymentError) return res.status(error.status).send({ message: error.message, code: error.code });
    throw error;
  }
});

router.get("/status/:jobId", async (req, res) => {
  const jobId = String(req.params.jobId || "").trim();
  const artifactId = String(req.query.artifactId || "").trim();
  const revision = Number(req.query.revision);
  if (!jobId || !/^[0-9a-f-]{36}$/.test(artifactId) || !Number.isSafeInteger(revision) || revision < 1) {
    return res.status(400).send({ message: "参数错误", code: "RELEASE_ARTIFACT_VERIFICATION_JOB_INPUT_INVALID" });
  }
  const job = await getReleaseArtifactVerificationJob(artifactId, revision);
  if (!job || (
    job.jobId !== jobId
    && job.status !== "ready"
    && job.status !== "failed"
  )) {
    return res.status(404).send({ message: "制品校验任务不存在", code: "RELEASE_ARTIFACT_VERIFICATION_JOB_NOT_FOUND" });
  }
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Pragma", "no-cache");
  return res.status(200).send(success({
    ...job,
    ...(job.artifact ? { artifact: serializeAdminReleaseArtifact(job.artifact) } : {}),
  }));
});
