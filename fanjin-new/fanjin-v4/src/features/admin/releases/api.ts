import { apiGet, apiPost } from "../../../api/http";
import {
  apiPostWithStepUp,
  stepUpRequestOptions,
  withStepUpProofs,
} from "../../../api/stepUp";
import type {
  PlatformReleaseChannel,
  PlatformReleaseDraft,
  PlatformReleasePage,
  PlatformReleaseRecord,
  PlatformReleaseStatus,
  PreviewReleaseDeploymentInput,
  ReconcileReleaseDeploymentInput,
  RegisterReleaseArtifactInput,
  ReleaseArtifactRecord,
  ReleaseArtifactUploadTarget,
  ReleaseArtifactUploadReceipt,
  ReleaseArtifactVerificationJob,
  ReleaseDeploymentDetail,
  ReleaseDeploymentEventPage,
  ReleaseDeploymentPage,
  ReleaseDeploymentPreview,
  ReleaseDeploymentReconciliationRecord,
  ReleaseDeploymentStatus,
  StartReleaseDeploymentInput,
} from "./types";
import {
  clearReleaseArtifactMultipartCheckpoint,
  uploadReleaseArtifactMultipart,
} from "./releaseArtifactMultipart";

// Deployment authority is deliberately separate from release-note maintenance.
const deploymentStepUpScope = "admin.deployment" as const;

export type ReleasePipelineProofs = {
  upload: string;
  register: string;
  verify: string;
  start: string;
};

export async function acquireReleasePipelineProofs(): Promise<ReleasePipelineProofs> {
  const proofs = await withStepUpProofs(
    [
      deploymentStepUpScope,
      deploymentStepUpScope,
      deploymentStepUpScope,
      deploymentStepUpScope,
    ],
    async (proof) => proof,
    "授权本次制品上传、登记、校验与滚动发布",
  );
  const [upload, register, verify, start] = proofs;
  if (!upload || !register || !verify || !start) {
    throw new Error("服务端未返回完整的发布授权批次");
  }
  return { upload, register, verify, start };
}

export function listPlatformReleases(input: {
  query?: string | null;
  channel?: PlatformReleaseChannel | null;
  status?: PlatformReleaseStatus | null;
  pageNum: number;
  pageSize: number;
}) {
  return apiPost<PlatformReleasePage>("/admin/releases/list", input);
}

export function savePlatformRelease(draft: PlatformReleaseDraft, current?: PlatformReleaseRecord | null) {
  const path = current ? "/admin/releases/update" : "/admin/releases/create";
  const payload = current
    ? { id: current.id, revision: current.revision, ...draft }
    : { ...draft };
  return apiPostWithStepUp<PlatformReleaseRecord>(
    path,
    payload,
    "admin.release",
    current ? "编辑版本发布草稿" : "创建版本发布草稿",
  );
}

export function archivePlatformRelease(item: PlatformReleaseRecord) {
  return apiPostWithStepUp<PlatformReleaseRecord>(
    "/admin/releases/archive",
    { id: item.id, revision: item.revision },
    "admin.release",
    `归档版本 ${item.version}`,
  );
}

function unwrapArtifact(
  response: ReleaseArtifactRecord | { artifact: ReleaseArtifactRecord; idempotent?: boolean },
): ReleaseArtifactRecord {
  if ("artifact" in response) {
    return { ...response.artifact, idempotentReplay: response.idempotent ?? response.artifact.idempotentReplay };
  }
  return response;
}

function unwrapDeployment(
  response: ReleaseDeploymentDetail | { deployment: ReleaseDeploymentDetail; idempotent?: boolean },
): ReleaseDeploymentDetail {
  if ("deployment" in response) {
    return { ...response.deployment, idempotentReplay: response.idempotent ?? response.deployment.idempotentReplay };
  }
  return response;
}

export async function registerReleaseArtifact(input: RegisterReleaseArtifactInput, proof?: string) {
  const response = proof
    ? await apiPost<
      ReleaseArtifactRecord | { artifact: ReleaseArtifactRecord; idempotent?: boolean }
    >(
      "/admin/releases/artifacts/register",
      { ...input },
      undefined,
      stepUpRequestOptions(proof),
    )
    : await apiPostWithStepUp<
    ReleaseArtifactRecord | { artifact: ReleaseArtifactRecord; idempotent?: boolean }
    >(
      "/admin/releases/artifacts/register",
      { ...input },
      deploymentStepUpScope,
      "登记生产发布制品",
    );
  return unwrapArtifact(response);
}

export function createReleaseArtifactUploadTarget(input: {
  releaseId: string;
  fileName: string;
  byteSize: number;
  idempotencyKey: string;
}) {
  return apiPostWithStepUp<ReleaseArtifactUploadTarget>(
    "/admin/releases/artifacts/upload-url",
    { ...input, contentType: "application/gzip" },
    deploymentStepUpScope,
    "创建生产发布制品上传地址",
  );
}

export async function putReleaseArtifact(target: ReleaseArtifactUploadTarget, archive: File) {
  const controller = new AbortController();
  const remaining = Math.max(1_000, target.expiresAt - Date.now());
  const timeout = window.setTimeout(
    () => controller.abort(new DOMException("发布制品上传超时", "TimeoutError")),
    Math.min(remaining, 15 * 60 * 1_000),
  );
  try {
    const response = await fetch(target.url, {
      method: target.method,
      body: archive,
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: target.requiredHeaders,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`制品上传失败，TOS 返回 ${response.status}。`);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("制品上传已超时或上传地址已过期，请安全重试。");
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function uploadAndRegisterReleaseArtifact(input: {
  releaseId: string;
  archive: File;
  sha256: string;
  manifest: RegisterReleaseArtifactInput["manifest"];
  uploadIdempotencyKey: string;
  idempotencyKey: string;
  signal?: AbortSignal;
  onProgress?: (input: {
    uploadedBytes: number;
    totalBytes: number;
    completedParts: number;
    totalParts: number;
  }) => void;
  onUploaded?: (target: ReleaseArtifactUploadReceipt) => void;
}, proofs?: Pick<ReleasePipelineProofs, "upload" | "register">) {
  let target: ReleaseArtifactUploadReceipt | null = null;
  let artifact: ReleaseArtifactRecord | null = null;
  const consume = async (proof: string, index: number) => {
    if (index === 0) {
      target = await uploadReleaseArtifactMultipart({
        releaseId: input.releaseId,
        archive: input.archive,
        sha256: input.sha256,
        idempotencyKey: input.uploadIdempotencyKey,
        initProof: proof,
        signal: input.signal,
        onProgress: input.onProgress,
      });
      input.onUploaded?.(target);
      return;
    }
    if (!target) throw new Error("制品上传地址尚未生成。");
    const response = await apiPost<
      ReleaseArtifactRecord | { artifact: ReleaseArtifactRecord; idempotent?: boolean }
    >(
      "/admin/releases/artifacts/register",
      {
        releaseId: input.releaseId,
        reservationId: target.reservationId,
        sha256: input.sha256,
        manifest: input.manifest,
        idempotencyKey: input.idempotencyKey,
      },
      undefined,
      stepUpRequestOptions(proof),
    );
    artifact = unwrapArtifact(response);
    clearReleaseArtifactMultipartCheckpoint(input.releaseId);
  };
  if (proofs) {
    await consume(proofs.upload, 0);
    await consume(proofs.register, 1);
  } else {
    await withStepUpProofs(
      [deploymentStepUpScope, deploymentStepUpScope],
      consume,
      "上传并登记生产发布制品",
    );
  }
  if (!artifact) throw new Error("制品已上传，但服务端未返回登记结果。请使用相同上传预约重试登记。");
  return artifact as ReleaseArtifactRecord;
}

export async function markReleaseArtifactReady(item: ReleaseArtifactRecord, proof?: string) {
  const response = proof
    ? await apiPost<
      ReleaseArtifactRecord
        | { artifact: ReleaseArtifactRecord }
        | ReleaseArtifactVerificationJob
    >(
      "/admin/releases/artifacts/ready",
      { id: item.id, revision: item.revision },
      undefined,
      stepUpRequestOptions(proof),
    )
    : await apiPostWithStepUp<
    ReleaseArtifactRecord
      | { artifact: ReleaseArtifactRecord }
      | ReleaseArtifactVerificationJob
    >(
      "/admin/releases/artifacts/ready",
      { id: item.id, revision: item.revision },
      deploymentStepUpScope,
      "确认发布制品校验结果",
    );
  if (!("jobId" in response)) return unwrapArtifact(response);
  const maxPolls = 900;
  for (let attempt = 0; attempt < maxPolls; attempt += 1) {
    const job = await apiGet<ReleaseArtifactVerificationJob>(
      `/admin/releases/artifacts/ready/status/${encodeURIComponent(response.jobId)}`
        + `?artifactId=${encodeURIComponent(response.artifactId)}&revision=${response.revision}`,
    );
    if (job.status === "ready" && job.artifact) return job.artifact;
    if (job.status === "failed") {
      throw new Error(job.message || job.errorCode || "制品校验失败");
    }
    await new Promise((resolve) => window.setTimeout(resolve, job.pollAfterMs || 2_000));
  }
  throw new Error("制品校验仍在后台运行，请稍后刷新发布页查看结果。");
}

export function previewReleaseDeployment(input: PreviewReleaseDeploymentInput) {
  return apiPost<ReleaseDeploymentPreview>("/admin/releases/deployments/preview", { ...input });
}

export async function startReleaseDeployment(input: StartReleaseDeploymentInput, proof?: string) {
  const response = proof
    ? await apiPost<
      ReleaseDeploymentDetail | { deployment: ReleaseDeploymentDetail; idempotent?: boolean }
    >(
      "/admin/releases/deployments/start",
      { ...input },
      undefined,
      stepUpRequestOptions(proof),
    )
    : await apiPostWithStepUp<
    ReleaseDeploymentDetail | { deployment: ReleaseDeploymentDetail; idempotent?: boolean }
    >(
      "/admin/releases/deployments/start",
      { ...input },
      deploymentStepUpScope,
      "启动生产环境滚动发布",
    );
  return unwrapDeployment(response);
}

export function getReleaseDeployment(id: string) {
  return apiPost<ReleaseDeploymentDetail>("/admin/releases/deployments/get", { id });
}

export function listReleaseDeployments(input: {
  releaseId?: string | null;
  scope?: string | null;
  status?: ReleaseDeploymentStatus | null;
  pageNum?: number;
  pageSize?: number;
}) {
  return apiPost<ReleaseDeploymentPage>("/admin/releases/deployments/list", input);
}

export function listReleaseDeploymentEvents(input: {
  deploymentId: string;
  afterSeq?: number;
  limit?: number;
}) {
  return apiPost<ReleaseDeploymentEventPage>("/admin/releases/deployments/events", input);
}

export async function cancelReleaseDeployment(item: ReleaseDeploymentDetail, reason: string) {
  const response = await apiPostWithStepUp<
    ReleaseDeploymentDetail | { deployment: ReleaseDeploymentDetail }
  >(
    "/admin/releases/deployments/cancel",
    { id: item.id, revision: item.revision, reason },
    deploymentStepUpScope,
    "停止生产环境滚动发布并执行安全回切",
  );
  return unwrapDeployment(response);
}

export function reconcileReleaseDeployment(input: ReconcileReleaseDeploymentInput) {
  return apiPostWithStepUp<ReleaseDeploymentReconciliationRecord>(
    "/admin/releases/deployments/reconcile",
    { ...input },
    deploymentStepUpScope,
    "人工收敛生产集群并核验发布锁",
  );
}
