import type { ReferenceUploadProgress } from "./uploadQueue.types";
import { apiPost } from "../../../api/http";
import { createBrowserUuid } from "../../../lib/browserUuid";
import type {
  ReferenceAttachmentMimeCategory,
  UploadedReferenceAsset,
} from "./api";
import { sha256File } from "./fileSha256";

const CHECKPOINT_VERSION = 1 as const;
const CHECKPOINT_PREFIX = "fanjin:reference-multipart:v1:";
const MAX_PARALLEL_PARTS = 3;
const MAX_PART_ATTEMPTS = 3;

type MediaType = Exclude<ReferenceAttachmentMimeCategory, "document">;
type UploadStatus =
  | "active"
  | "completing"
  | "verifying"
  | "completed"
  | "aborting"
  | "aborted"
  | "failed";

type MultipartStatus = {
  protocolVersion: "reference-multipart-upload/v1";
  sessionId: string;
  workspaceId: string;
  projectId: number;
  fileName: string;
  mediaType: MediaType;
  mimeType: string;
  byteSize: number;
  sha256: string;
  partSize: number;
  partCount: number;
  expiresAt: number;
  status: UploadStatus;
  uploadedParts: Array<{ partNumber: number; byteSize: number; etag: string }>;
  uploadedByteSize: number;
  asset: UploadedReferenceAsset | null;
};

type MultipartInitialization = MultipartStatus & {
  resumeGrant: string;
  idempotent: boolean;
};

type MultipartPartTarget = {
  sessionId: string;
  partNumber: number;
  byteOffset: number;
  byteSize: number;
  url: string;
  method: "PUT";
  expiresAt: number;
  requiredHeaders: Record<string, never>;
};

export interface ReferenceMultipartCheckpoint {
  version: typeof CHECKPOINT_VERSION;
  projectId: number;
  fileName: string;
  byteSize: number;
  lastModified: number;
  mimeType: string;
  mediaType: MediaType;
  sha256: string;
  idempotencyKey: string;
  sessionId: string;
  partSize: number;
  partCount: number;
  expiresAt: number;
  updatedAt: number;
}

function checkpointKey(projectId: number, sha256: string): string {
  return `${CHECKPOINT_PREFIX}${projectId}:${sha256}`;
}

function safeCheckpoint(value: unknown): ReferenceMultipartCheckpoint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Partial<ReferenceMultipartCheckpoint>;
  if (
    item.version !== CHECKPOINT_VERSION
    || !Number.isSafeInteger(item.projectId)
    || Number(item.projectId) < 1
    || typeof item.fileName !== "string"
    || !Number.isSafeInteger(item.byteSize)
    || Number(item.byteSize) < 1
    || !Number.isSafeInteger(item.lastModified)
    || typeof item.mimeType !== "string"
    || !["image", "video", "audio"].includes(String(item.mediaType))
    || !/^[a-f0-9]{64}$/u.test(String(item.sha256 || ""))
    || typeof item.idempotencyKey !== "string"
    || typeof item.sessionId !== "string"
    || !Number.isSafeInteger(item.partSize)
    || Number(item.partSize) < 1
    || !Number.isSafeInteger(item.partCount)
    || Number(item.partCount) < 1
    || !Number.isSafeInteger(item.expiresAt)
    || !Number.isSafeInteger(item.updatedAt)
  ) return null;
  return item as ReferenceMultipartCheckpoint;
}

export function loadReferenceMultipartCheckpoint(
  projectId: number,
  sha256: string,
): ReferenceMultipartCheckpoint | null {
  try {
    const key = checkpointKey(projectId, sha256);
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const checkpoint = safeCheckpoint(JSON.parse(raw));
    if (
      !checkpoint
      || checkpoint.projectId !== projectId
      || checkpoint.sha256 !== sha256
      || checkpoint.expiresAt <= Date.now()
    ) {
      window.localStorage.removeItem(key);
      return null;
    }
    return checkpoint;
  } catch {
    return null;
  }
}

export function saveReferenceMultipartCheckpoint(
  checkpoint: ReferenceMultipartCheckpoint,
): void {
  try {
    // Persist only inert identity/range metadata. Bearer credentials, narrow
    // resume grants and presigned URLs must remain memory-only.
    const persisted: ReferenceMultipartCheckpoint = {
      version: CHECKPOINT_VERSION,
      projectId: checkpoint.projectId,
      fileName: checkpoint.fileName,
      byteSize: checkpoint.byteSize,
      lastModified: checkpoint.lastModified,
      mimeType: checkpoint.mimeType,
      mediaType: checkpoint.mediaType,
      sha256: checkpoint.sha256,
      idempotencyKey: checkpoint.idempotencyKey,
      sessionId: checkpoint.sessionId,
      partSize: checkpoint.partSize,
      partCount: checkpoint.partCount,
      expiresAt: checkpoint.expiresAt,
      updatedAt: checkpoint.updatedAt,
    };
    window.localStorage.setItem(
      checkpointKey(checkpoint.projectId, checkpoint.sha256),
      JSON.stringify(persisted),
    );
  } catch {
    // The upload still works in-memory. Storage-denied browsers must re-init.
  }
}

export function clearReferenceMultipartCheckpoint(
  projectId: number,
  sha256: string,
): void {
  try {
    window.localStorage.removeItem(checkpointKey(projectId, sha256));
  } catch {
    // Nothing else to clear.
  }
}

export function referenceMultipartCheckpointMatchesFile(
  checkpoint: ReferenceMultipartCheckpoint,
  file: File,
  sha256: string,
): boolean {
  return checkpoint.fileName === file.name
    && checkpoint.byteSize === file.size
    && checkpoint.lastModified === file.lastModified
    && checkpoint.mimeType === file.type.toLowerCase().trim()
    && checkpoint.sha256 === sha256;
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("已取消", "AbortError"));
      return;
    }
    const timer = window.setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      window.clearTimeout(timer);
      reject(signal.reason ?? new DOMException("已取消", "AbortError"));
    }, { once: true });
  });
}

export function putReferenceMultipartPart(
  target: MultipartPartTarget,
  part: Blob,
  options: {
    signal?: AbortSignal;
    onProgress?: (uploadedBytes: number) => void;
  } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(options.signal.reason ?? new DOMException("已取消", "AbortError"));
      return;
    }
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const cleanup = () => options.signal?.removeEventListener("abort", abort);
    options.signal?.addEventListener("abort", abort, { once: true });
    xhr.open(target.method, target.url, true);
    xhr.withCredentials = false;
    xhr.timeout = Math.max(
      1_000,
      Math.min(target.expiresAt - Date.now(), 10 * 60 * 1_000),
    );
    xhr.upload.onprogress = (event) => {
      options.onProgress?.(Math.min(part.size, event.loaded));
    };
    xhr.onload = () => {
      cleanup();
      if (xhr.status >= 200 && xhr.status < 300) {
        options.onProgress?.(part.size);
        resolve();
      } else {
        reject(new Error(`参考素材分片上传失败，对象存储返回 ${xhr.status}`));
      }
    };
    xhr.onerror = () => {
      cleanup();
      reject(new Error("参考素材分片上传网络中断，可安全续传"));
    };
    xhr.ontimeout = () => {
      cleanup();
      reject(new Error("参考素材分片上传超时，可安全续传"));
    };
    xhr.onabort = () => {
      cleanup();
      reject(options.signal?.reason ?? new DOMException("已取消", "AbortError"));
    };
    xhr.send(part);
  });
}

function authorizationBody(
  checkpoint: ReferenceMultipartCheckpoint,
  resumeGrant: string,
) {
  return {
    projectId: checkpoint.projectId,
    resumeGrant,
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export async function abortReferenceMultipartUpload(
  checkpoint: ReferenceMultipartCheckpoint,
  resumeGrant: string,
): Promise<void> {
  await apiPost<MultipartStatus>(
    `/assets/uploadReference/multipart/${encodeURIComponent(checkpoint.sessionId)}/abort`,
    authorizationBody(checkpoint, resumeGrant),
  );
  clearReferenceMultipartCheckpoint(checkpoint.projectId, checkpoint.sha256);
}

export async function uploadReferenceMultipart(input: {
  projectId: number;
  file: File;
  mediaType: MediaType;
  mimeType: string;
  signal?: AbortSignal;
  onProgress?: (progress: number, transfer?: ReferenceUploadProgress) => void;
}): Promise<UploadedReferenceAsset> {
  input.signal?.throwIfAborted();
  input.onProgress?.(1, { phase: "preparing", uploadedBytes: 0 });
  const digest = await sha256File(input.file, {
    signal: input.signal,
    onProgress: (hashedBytes, totalBytes) => {
      input.onProgress?.(Math.min(10, Math.round((hashedBytes / totalBytes) * 10)), { phase: "preparing", uploadedBytes: 0 });
    },
  });
  input.signal?.throwIfAborted();

  let prior = loadReferenceMultipartCheckpoint(input.projectId, digest);
  if (prior && !referenceMultipartCheckpointMatchesFile(prior, input.file, digest)) {
    clearReferenceMultipartCheckpoint(input.projectId, digest);
    prior = null;
  }
  const idempotencyKey = prior?.idempotencyKey
    || `reference-${createBrowserUuid()}`;
  const initialized = await apiPost<MultipartInitialization>(
    "/assets/uploadReference/multipart/init",
    {
      projectId: input.projectId,
      idempotencyKey,
      fileName: input.file.name,
      mediaType: input.mediaType,
      mimeType: input.mimeType,
      byteSize: input.file.size,
      sha256: digest,
    },
    undefined,
    { signal: input.signal },
  );
  if (!initialized.resumeGrant || initialized.resumeGrant.length < 32) {
    throw new Error("服务端未返回有效的上传恢复授权");
  }
  const checkpoint: ReferenceMultipartCheckpoint = {
    version: CHECKPOINT_VERSION,
    projectId: input.projectId,
    fileName: input.file.name,
    byteSize: input.file.size,
    lastModified: input.file.lastModified,
    mimeType: input.mimeType,
    mediaType: input.mediaType,
    sha256: digest,
    idempotencyKey,
    sessionId: initialized.sessionId,
    partSize: initialized.partSize,
    partCount: initialized.partCount,
    expiresAt: initialized.expiresAt,
    updatedAt: Date.now(),
  };
  saveReferenceMultipartCheckpoint(checkpoint);
  if (initialized.status === "completed" && initialized.asset) {
    clearReferenceMultipartCheckpoint(input.projectId, digest);
    input.onProgress?.(100);
    return initialized.asset;
  }
  if (["completing", "verifying"].includes(initialized.status)) {
    input.onProgress?.(96, { phase: "saving", uploadedBytes: input.file.size });
    const recovered = await apiPost<MultipartStatus>(
      `/assets/uploadReference/multipart/${encodeURIComponent(checkpoint.sessionId)}/complete`,
      authorizationBody(checkpoint, initialized.resumeGrant),
      undefined,
      { signal: input.signal },
    );
    if (recovered.status !== "completed" || !recovered.asset) {
      throw new Error("服务端恢复上传后未返回参考素材");
    }
    clearReferenceMultipartCheckpoint(input.projectId, digest);
    input.onProgress?.(100);
    return recovered.asset;
  }
  if (initialized.status !== "active") {
    throw new Error(`上传会话状态不可恢复：${initialized.status}`);
  }

  const uploadedParts = new Set(
    initialized.uploadedParts.map((part) => part.partNumber),
  );
  let confirmedBytes = initialized.uploadedParts.reduce(
    (total, part) => total + part.byteSize,
    0,
  );
  const inFlight = new Map<number, number>();
  const report = () => {
    const uploadedBytes = Math.min(
      input.file.size,
      confirmedBytes + [...inFlight.values()].reduce((sum, value) => sum + value, 0),
    );
    input.onProgress?.(10 + Math.round((uploadedBytes / input.file.size) * 85), { phase: "transferring", uploadedBytes });
  };
  report();
  const missing = Array.from(
    { length: checkpoint.partCount },
    (_, index) => index + 1,
  ).filter((partNumber) => !uploadedParts.has(partNumber));
  let cursor = 0;

  const uploadPart = async (partNumber: number): Promise<void> => {
    const start = (partNumber - 1) * checkpoint.partSize;
    const end = Math.min(input.file.size, start + checkpoint.partSize);
    const part = input.file.slice(start, end);
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_PART_ATTEMPTS; attempt += 1) {
      input.signal?.throwIfAborted();
      try {
        const target = await apiPost<MultipartPartTarget>(
          `/assets/uploadReference/multipart/${encodeURIComponent(checkpoint.sessionId)}/part`,
          {
            ...authorizationBody(checkpoint, initialized.resumeGrant),
            partNumber,
          },
          undefined,
          { signal: input.signal },
        );
        if (target.byteSize !== part.size || target.partNumber !== partNumber) {
          throw new Error("服务端返回的分片范围不一致");
        }
        await putReferenceMultipartPart(target, part, {
          signal: input.signal,
          onProgress: (uploadedBytes) => {
            inFlight.set(partNumber, uploadedBytes);
            report();
          },
        });
        inFlight.delete(partNumber);
        uploadedParts.add(partNumber);
        confirmedBytes += part.size;
        report();
        return;
      } catch (error) {
        inFlight.delete(partNumber);
        lastError = error;
        if (input.signal?.aborted || attempt === MAX_PART_ATTEMPTS) break;
        await pause(250 * attempt, input.signal);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(`第 ${partNumber} 个参考素材分片上传失败`);
  };

  const worker = async () => {
    while (cursor < missing.length) {
      const index = cursor;
      cursor += 1;
      await uploadPart(missing[index]);
    }
  };

  try {
    await Promise.all(Array.from(
      { length: Math.min(MAX_PARALLEL_PARTS, missing.length) },
      () => worker(),
    ));
    input.signal?.throwIfAborted();
    const status = await apiPost<MultipartStatus>(
      `/assets/uploadReference/multipart/${encodeURIComponent(checkpoint.sessionId)}/status`,
      authorizationBody(checkpoint, initialized.resumeGrant),
      undefined,
      { signal: input.signal },
    );
    if (
      status.uploadedParts.length !== checkpoint.partCount
      || status.uploadedByteSize !== input.file.size
    ) {
      throw new Error("远端分片未完整，检查点已保留，可继续上传");
    }
    input.onProgress?.(96, { phase: "saving", uploadedBytes: input.file.size });
    const completed = await apiPost<MultipartStatus>(
      `/assets/uploadReference/multipart/${encodeURIComponent(checkpoint.sessionId)}/complete`,
      authorizationBody(checkpoint, initialized.resumeGrant),
      undefined,
      { signal: input.signal },
    );
    if (completed.status !== "completed" || !completed.asset) {
      throw new Error("服务端完成上传后未返回参考素材");
    }
    clearReferenceMultipartCheckpoint(input.projectId, digest);
    input.onProgress?.(100);
    return completed.asset;
  } catch (error) {
    if (input.signal?.aborted || isAbortError(error)) {
      await abortReferenceMultipartUpload(
        checkpoint,
        initialized.resumeGrant,
      ).catch(() => undefined);
      clearReferenceMultipartCheckpoint(input.projectId, digest);
    }
    throw error;
  }
}
