import { apiPost } from "../../../api/http";
import { stepUpRequestOptions } from "../../../api/stepUp";
import type {
  ReleaseArtifactMultipartPartTarget,
  ReleaseArtifactMultipartSession,
  ReleaseArtifactUploadReceipt,
} from "./types";

const CHECKPOINT_VERSION = 1 as const;
const CHECKPOINT_PREFIX = "fanjin:release-artifact-multipart:v1:";
const MAX_PARALLEL_PARTS = 3;
const MAX_PART_ATTEMPTS = 3;

export interface ReleaseArtifactMultipartCheckpoint {
  version: typeof CHECKPOINT_VERSION;
  releaseId: string;
  fileName: string;
  byteSize: number;
  lastModified: number;
  sha256: string;
  idempotencyKey: string;
  sessionId: string;
  reservationId: string;
  resumeGrant: string;
  partSize: number;
  partCount: number;
  expiresAt: number;
  status: "active" | "completed";
  updatedAt: number;
}

function checkpointKey(releaseId: string): string {
  return `${CHECKPOINT_PREFIX}${releaseId}`;
}

function safeCheckpoint(value: unknown): ReleaseArtifactMultipartCheckpoint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Partial<ReleaseArtifactMultipartCheckpoint>;
  if (
    item.version !== CHECKPOINT_VERSION
    || typeof item.releaseId !== "string"
    || typeof item.fileName !== "string"
    || !Number.isSafeInteger(item.byteSize)
    || Number(item.byteSize) < 1
    || !Number.isSafeInteger(item.lastModified)
    || !/^[a-f0-9]{64}$/u.test(String(item.sha256 || ""))
    || typeof item.idempotencyKey !== "string"
    || typeof item.sessionId !== "string"
    || typeof item.reservationId !== "string"
    || typeof item.resumeGrant !== "string"
    || item.resumeGrant.length < 8
    || !Number.isSafeInteger(item.partSize)
    || Number(item.partSize) < 1
    || !Number.isSafeInteger(item.partCount)
    || Number(item.partCount) < 1
    || !Number.isSafeInteger(item.expiresAt)
    || (item.status !== "active" && item.status !== "completed")
    || !Number.isSafeInteger(item.updatedAt)
  ) {
    return null;
  }
  return item as ReleaseArtifactMultipartCheckpoint;
}

export function loadReleaseArtifactMultipartCheckpoint(
  releaseId: string,
): ReleaseArtifactMultipartCheckpoint | null {
  try {
    const raw = window.localStorage.getItem(checkpointKey(releaseId));
    if (!raw) return null;
    const checkpoint = safeCheckpoint(JSON.parse(raw));
    if (!checkpoint || checkpoint.releaseId !== releaseId) {
      window.localStorage.removeItem(checkpointKey(releaseId));
      return null;
    }
    return checkpoint;
  } catch {
    return null;
  }
}

export function saveReleaseArtifactMultipartCheckpoint(
  checkpoint: ReleaseArtifactMultipartCheckpoint,
): void {
  try {
    window.localStorage.setItem(
      checkpointKey(checkpoint.releaseId),
      JSON.stringify(checkpoint),
    );
  } catch {
    // Upload remains safe in-memory; a storage-denied browser simply cannot
    // recover after a full reload.
  }
}

export function clearReleaseArtifactMultipartCheckpoint(releaseId: string): void {
  try {
    window.localStorage.removeItem(checkpointKey(releaseId));
  } catch {
    // Nothing else to clear.
  }
}

export function releaseArtifactMultipartCheckpointMatchesFile(
  checkpoint: ReleaseArtifactMultipartCheckpoint,
  file: File,
  sha256?: string,
): boolean {
  return checkpoint.fileName === file.name
    && checkpoint.byteSize === file.size
    && checkpoint.lastModified === file.lastModified
    && (sha256 === undefined || checkpoint.sha256 === sha256.toLowerCase());
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

export function putReleaseArtifactPart(
  target: ReleaseArtifactMultipartPartTarget,
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
    options.signal?.addEventListener("abort", abort, { once: true });
    const finish = () => options.signal?.removeEventListener("abort", abort);
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
      finish();
      if (xhr.status >= 200 && xhr.status < 300) {
        options.onProgress?.(part.size);
        resolve();
      } else {
        reject(new Error(`制品分片上传失败，TOS 返回 ${xhr.status}。`));
      }
    };
    xhr.onerror = () => {
      finish();
      reject(new Error("制品分片上传网络中断，可安全续传。"));
    };
    xhr.ontimeout = () => {
      finish();
      reject(new Error("制品分片上传超时，可安全续传。"));
    };
    xhr.onabort = () => {
      finish();
      reject(options.signal?.reason ?? new DOMException("已取消", "AbortError"));
    };
    xhr.send(part);
  });
}

function delegatedBody(
  checkpoint: ReleaseArtifactMultipartCheckpoint,
): { sessionId: string; resumeGrant: string } {
  return {
    sessionId: checkpoint.sessionId,
    resumeGrant: checkpoint.resumeGrant,
  };
}

export async function uploadReleaseArtifactMultipart(input: {
  releaseId: string;
  archive: File;
  sha256: string;
  idempotencyKey: string;
  initProof: string;
  signal?: AbortSignal;
  onProgress?: (input: {
    uploadedBytes: number;
    totalBytes: number;
    completedParts: number;
    totalParts: number;
  }) => void;
}): Promise<ReleaseArtifactUploadReceipt> {
  input.signal?.throwIfAborted();
  const digest = input.sha256.trim().toLowerCase();
  let prior = loadReleaseArtifactMultipartCheckpoint(input.releaseId);
  if (
    prior
    && !releaseArtifactMultipartCheckpointMatchesFile(
      prior,
      input.archive,
      digest,
    )
  ) {
    clearReleaseArtifactMultipartCheckpoint(input.releaseId);
    prior = null;
  }
  const idempotencyKey = prior?.idempotencyKey || input.idempotencyKey;
  const initialized = await apiPost<ReleaseArtifactMultipartSession>(
    "/admin/releases/artifacts/upload-url",
    {
      action: "multipart_init",
      releaseId: input.releaseId,
      fileName: input.archive.name,
      byteSize: input.archive.size,
      contentType: "application/gzip",
      sha256: digest,
      idempotencyKey,
    },
    undefined,
    stepUpRequestOptions(input.initProof),
  );
  if (!initialized.resumeGrant) {
    throw new Error("服务端未返回断点续传授权。");
  }
  const checkpoint: ReleaseArtifactMultipartCheckpoint = {
    version: CHECKPOINT_VERSION,
    releaseId: input.releaseId,
    fileName: input.archive.name,
    byteSize: input.archive.size,
    lastModified: input.archive.lastModified,
    sha256: digest,
    idempotencyKey,
    sessionId: initialized.sessionId,
    reservationId: initialized.reservationId,
    resumeGrant: initialized.resumeGrant,
    partSize: initialized.partSize,
    partCount: initialized.partCount,
    expiresAt: initialized.expiresAt,
    status: initialized.status === "completed" ? "completed" : "active",
    updatedAt: Date.now(),
  };
  saveReleaseArtifactMultipartCheckpoint(checkpoint);
  if (checkpoint.status === "completed") {
    return {
      reservationId: checkpoint.reservationId,
      sessionId: checkpoint.sessionId,
    };
  }

  const uploadedParts = new Set(
    initialized.uploadedParts.map((part) => part.partNumber),
  );
  let confirmedBytes = initialized.uploadedParts.reduce(
    (total, part) => total + part.byteSize,
    0,
  );
  const inFlight = new Map<number, number>();
  const report = () => input.onProgress?.({
    uploadedBytes: Math.min(
      input.archive.size,
      confirmedBytes + [...inFlight.values()].reduce((sum, value) => sum + value, 0),
    ),
    totalBytes: input.archive.size,
    completedParts: uploadedParts.size,
    totalParts: checkpoint.partCount,
  });
  report();
  const missing = Array.from(
    { length: checkpoint.partCount },
    (_, index) => index + 1,
  ).filter((partNumber) => !uploadedParts.has(partNumber));
  let cursor = 0;
  const uploadPart = async (partNumber: number): Promise<void> => {
    const start = (partNumber - 1) * checkpoint.partSize;
    const end = Math.min(input.archive.size, start + checkpoint.partSize);
    const part = input.archive.slice(start, end);
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_PART_ATTEMPTS; attempt += 1) {
      input.signal?.throwIfAborted();
      try {
        const target = await apiPost<ReleaseArtifactMultipartPartTarget>(
          "/admin/releases/artifacts/upload-url",
          {
            action: "multipart_part",
            ...delegatedBody(checkpoint),
            partNumber,
          },
        );
        await putReleaseArtifactPart(target, part, {
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
      : new Error(`第 ${partNumber} 个制品分片上传失败。`);
  };
  const worker = async () => {
    while (cursor < missing.length) {
      const index = cursor;
      cursor += 1;
      await uploadPart(missing[index]);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(MAX_PARALLEL_PARTS, missing.length) },
      () => worker(),
    ),
  );
  input.signal?.throwIfAborted();
  const status = await apiPost<ReleaseArtifactMultipartSession>(
    "/admin/releases/artifacts/upload-url",
    { action: "multipart_status", ...delegatedBody(checkpoint) },
  );
  if (
    status.uploadedParts.length !== checkpoint.partCount
    || status.uploadedByteSize !== input.archive.size
  ) {
    throw new Error("远端分片未完整，检查点已保留，可安全续传。");
  }
  const completed = await apiPost<ReleaseArtifactMultipartSession>(
    "/admin/releases/artifacts/upload-url",
    { action: "multipart_complete", ...delegatedBody(checkpoint) },
  );
  checkpoint.status = "completed";
  checkpoint.updatedAt = Date.now();
  checkpoint.expiresAt = completed.expiresAt;
  saveReleaseArtifactMultipartCheckpoint(checkpoint);
  input.onProgress?.({
    uploadedBytes: input.archive.size,
    totalBytes: input.archive.size,
    completedParts: checkpoint.partCount,
    totalParts: checkpoint.partCount,
  });
  return {
    reservationId: checkpoint.reservationId,
    sessionId: checkpoint.sessionId,
  };
}

export async function abortReleaseArtifactMultipart(
  checkpoint: ReleaseArtifactMultipartCheckpoint,
): Promise<void> {
  await apiPost<ReleaseArtifactMultipartSession>(
    "/admin/releases/artifacts/upload-url",
    { action: "multipart_abort", ...delegatedBody(checkpoint) },
  );
  clearReleaseArtifactMultipartCheckpoint(checkpoint.releaseId);
}
