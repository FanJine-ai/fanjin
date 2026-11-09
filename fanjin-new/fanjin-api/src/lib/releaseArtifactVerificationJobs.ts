import { getReleaseArtifact, markReleaseArtifactReady } from "@/lib/releaseDeployments";
import { writeAuditLog } from "@/lib/audit";
import { redisCache } from "@/lib/redisCache";

const JOB_NAMESPACE = "release-artifact-ready";
const JOB_TTL_MS = 2 * 60 * 60 * 1000;

export type ReleaseArtifactVerificationJobStatus = "queued" | "running" | "ready" | "failed";

export interface ReleaseArtifactVerificationJob {
  jobId: string;
  artifactId: string;
  revision: number;
  status: ReleaseArtifactVerificationJobStatus;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  artifact?: Awaited<ReturnType<typeof getReleaseArtifact>>;
  errorCode?: string;
  message?: string;
}

export class ReleaseArtifactVerificationJobError extends Error {
  readonly status = 503;
  readonly code = "RELEASE_ARTIFACT_VERIFICATION_QUEUE_UNAVAILABLE";
}

function jobKey(artifactId: string, revision: number): string {
  return `${artifactId}:${revision}`;
}

function isJob(value: unknown): value is ReleaseArtifactVerificationJob {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<ReleaseArtifactVerificationJob>;
  return typeof item.jobId === "string"
    && typeof item.artifactId === "string"
    && Number.isSafeInteger(item.revision)
    && ["queued", "running", "ready", "failed"].includes(String(item.status))
    && Number.isSafeInteger(item.createdAt);
}

async function saveJob(job: ReleaseArtifactVerificationJob): Promise<boolean> {
  return redisCache.setJson(JOB_NAMESPACE, jobKey(job.artifactId, job.revision), job, JOB_TTL_MS);
}

export async function getReleaseArtifactVerificationJob(
  artifactId: string,
  revision: number,
): Promise<ReleaseArtifactVerificationJob | null> {
  const cached = await redisCache.getJson<ReleaseArtifactVerificationJob>(
    JOB_NAMESPACE,
    jobKey(artifactId, revision),
    isJob,
  );
  if (cached.hit && cached.value) {
    if (cached.value.status !== "ready") return cached.value;
    const artifact = await getReleaseArtifact(artifactId).catch(() => null);
    return artifact?.status === "ready"
      ? { ...cached.value, artifact }
      : cached.value;
  }

  // Redis is a status index only. The artifact row remains authoritative after
  // a process restart or a cache eviction.
  const artifact = await getReleaseArtifact(artifactId).catch(() => null);
  if (!artifact || artifact.revision < revision) return null;
  if (artifact.status === "ready") {
    return {
      jobId: `artifact-ready:${artifact.id}:${revision}`,
      artifactId: artifact.id,
      revision,
      status: "ready",
      createdAt: artifact.verifiedAt ?? Date.now(),
      startedAt: null,
      completedAt: artifact.verifiedAt,
      artifact,
    };
  }
  if (artifact.status === "rejected") {
    return {
      jobId: `artifact-ready:${artifact.id}:${revision}`,
      artifactId: artifact.id,
      revision,
      status: "failed",
      createdAt: artifact.updatedAt,
      startedAt: null,
      completedAt: artifact.updatedAt,
      errorCode: "RELEASE_ARTIFACT_REJECTED",
      message: artifact.rejectionReason || "制品校验被拒绝",
    };
  }
  return null;
}

async function runVerificationJob(
  initial: ReleaseArtifactVerificationJob,
  operatorUserId: number | null,
): Promise<void> {
  const running: ReleaseArtifactVerificationJob = {
    ...initial,
    status: "running",
    startedAt: Date.now(),
  };
  await saveJob(running);
  try {
    const artifact = await markReleaseArtifactReady({
      artifactId: running.artifactId,
      revision: running.revision,
    });
    await saveJob({
      ...running,
      status: "ready",
      completedAt: Date.now(),
    });
    try {
      await writeAuditLog({
        actor: {
          actorUserId: operatorUserId,
          actorKind: operatorUserId ? "user" : "system",
        },
        stepUpScope: "admin.deployment",
      }, {
        action: "admin.release_artifact.ready_async",
        resourceType: "release_artifact",
        resourceId: artifact.id,
        required: true,
        metadata: {
          releaseId: artifact.releaseId,
          sha256: artifact.sha256,
          status: artifact.status,
          revision: artifact.revision,
          jobId: running.jobId,
        },
      });
    } catch {
      // The artifact row is authoritative and already ready. Do not report a
      // verification failure because the asynchronous audit sink failed after
      // the state transition; the global audit health gate remains responsible
      // for surfacing that independent outage.
    }
  } catch (error) {
    const safeError = error as { code?: unknown; message?: unknown };
    await saveJob({
      ...running,
      status: "failed",
      completedAt: Date.now(),
      errorCode: typeof safeError.code === "string"
        ? safeError.code
        : "RELEASE_ARTIFACT_VERIFICATION_FAILED",
      message: typeof safeError.message === "string"
        ? safeError.message
        : "制品校验失败",
    });
  }
}

export async function enqueueReleaseArtifactVerification(input: {
  artifactId: string;
  revision: number;
  operatorUserId: number | null;
}): Promise<ReleaseArtifactVerificationJob> {
  const existing = await getReleaseArtifactVerificationJob(input.artifactId, input.revision);
  if (existing && (existing.status === "queued" || existing.status === "running" || existing.status === "ready")) {
    return existing;
  }

  const now = Date.now();
  const job: ReleaseArtifactVerificationJob = {
    jobId: `artifact-ready:${input.artifactId}:${input.revision}:${now}`,
    artifactId: input.artifactId,
    revision: input.revision,
    status: "queued",
    createdAt: now,
    startedAt: null,
    completedAt: null,
  };
  if (!(await saveJob(job))) {
    throw new ReleaseArtifactVerificationJobError("Redis 状态队列暂不可用");
  }
  // The artifact row remains the source of truth; this background task only
  // removes the long object-storage download from the request timeout path.
  void runVerificationJob(job, input.operatorUserId);
  return job;
}
