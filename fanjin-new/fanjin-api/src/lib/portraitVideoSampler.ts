import crypto from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Knex } from "knex";

import { sanitizeChildProcessEnvironment } from "@/lib/childProcessEnvironment";
import {
  writeObjectWithDurableIntent,
  type DurableObjectWriter,
} from "@/lib/durableObjectWrite";
import { processClaimedObjectWriteCompensation } from "@/lib/objectWriteCompensation";
import {
  claimObjectWriteCompensationById,
  getObjectWriteIntent,
  isEphemeralPortraitSampleIntent,
  markObjectWriteCompensationPending,
  renewObjectWriteIntentClaim,
} from "@/lib/objectWriteIntent";
import {
  createRemoteObjectStorageAdapter,
  type ObjectStorageAdapter,
  type ObjectStorageWriteReceipt,
} from "@/lib/objectStorage";
import { resolveObjectStorageConfiguration } from "@/lib/objectStorageConfig";
import type { ObjectStorageConfiguration } from "@/lib/objectStorageConfig";
import { inspectObjectStorageCapabilityAttestation } from "@/lib/objectStorageCapabilityAttestation";
import { inspectObjectStorageConfiguration } from "@/lib/objectStorageConfig";
import {
  detectPortraitVideoSampleFrameWithImageX,
  PORTRAIT_IMAGEX_REVIEW_POLICY_VERSION,
  type PortraitImageXReviewClientFactory,
} from "@/lib/portraitImageXReviewRuntime";
import {
  downloadPublicRemoteVideo,
  type SafeRemoteVideoDownloadResult,
} from "@/lib/safeRemoteVideoDownload";
import u from "@/utils";
import { VolcengineImageXReviewError } from "@/lib/volcengineImageXReview";

export const PORTRAIT_VIDEO_SAMPLER_POLICY_VERSION =
  "fanjin-imagex-video-face-sampler/v2" as const;

const VIDEO_MAXIMUM_BYTES = 128 * 1024 * 1024;
const VIDEO_DOWNLOAD_TIMEOUT_MS = 25_000;
const VIDEO_TOTAL_TIMEOUT_MS = 60_000;
const MEDIA_TOOL_TIMEOUT_MS = 10_000;
const FRAME_CLEANUP_TIMEOUT_MS = 10_000;
const FRAME_CLEANUP_LEASE_MS = 30_000;
const FRAME_WRITE_LEASE_MS = 1_000;
const FRAME_ACTIVE_SAMPLE_LEASE_MS = 90_000;
const MAXIMUM_VIDEO_DURATION_MS = 10 * 60_000;
const MAXIMUM_VIDEO_DIMENSION = 8_192;
const MAXIMUM_VIDEO_PIXELS = 33_554_432;
const MAXIMUM_FRAME_BYTES = 8 * 1024 * 1024;
const SAMPLE_FRACTIONS = Object.freeze([0.1, 0.3, 0.5, 0.7, 0.9]);
const MAXIMUM_SAMPLE_FRAMES = 12;

type Environment = Record<string, string | undefined>;

export type PortraitVideoSamplerConfiguration = Readonly<{
  configured: boolean;
  valid: boolean;
  reason: string | null;
}>;

export type PortraitVideoSampleCleanupInspection = Readonly<{
  inspected: boolean;
  ready: boolean;
  outstandingCount: number | null;
  reason: string | null;
}>;

type ProbedVideo = Readonly<{
  durationMs: number;
  height: number;
  width: number;
}>;

type FrameDetection = Readonly<{
  detectorVersion: string;
  evidenceHash: string;
  faceCount: number;
}>;

export type PortraitVideoSamplerDependencies = Readonly<{
  assertStorageAuthority?: () => void;
  clientFactory?: PortraitImageXReviewClientFactory;
  cleanupStorage?: ObjectStorageAdapter;
  deleteFrame?: (receipt: ObjectStorageWriteReceipt) => Promise<void>;
  detectFrame?: (input: {
    frameSha256: string;
    frameUrl: string;
    sampleIndex: number;
    signal: AbortSignal;
    sourceSha256: string;
    workspaceId: string;
  }) => Promise<FrameDetection>;
  durableWriter?: DurableObjectWriter;
  downloadVideo?: (input: {
    maximumBytes: number;
    timeoutMs: number;
    url: string;
  }) => Promise<SafeRemoteVideoDownloadResult>;
  extractFrame?: (input: {
    inputPath: string;
    outputPath: string;
    signal: AbortSignal;
    timestampMs: number;
  }) => Promise<void>;
  detectSceneChanges?: (input: { inputPath: string; signal: AbortSignal }) => Promise<number[]>;
  probeVideo?: (input: {
    inputPath: string;
    signal: AbortSignal;
  }) => Promise<ProbedVideo>;
  randomUUID?: () => string;
  storageConfiguration?: ObjectStorageConfiguration;
  signFrame?: (
    key: string,
    versionId: string,
  ) => Promise<string>;
  writeFrame?: (
    key: string,
    body: Buffer,
    signal: AbortSignal,
  ) => Promise<ObjectStorageWriteReceipt | null>;
}>;

export type PortraitVideoSamplerResult = Readonly<{
  state: "no_face" | "single_face" | "multiple_faces";
  faceCount: number;
  confidence: null;
  detectorName: "volcano-imagex-video-sampler";
  detectorVersion: typeof PORTRAIT_VIDEO_SAMPLER_POLICY_VERSION;
  evidenceHash: string;
  evidence: Readonly<Record<string, unknown>>;
  coverage: "sampled_video";
}>;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(row[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function sha256(value: Buffer | string | unknown): string {
  const body = Buffer.isBuffer(value) || typeof value === "string"
    ? value
    : stableJson(value);
  return crypto.createHash("sha256").update(body).digest("hex");
}

function exactSha256(value: unknown, code: string): string {
  const digest = String(value ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error(code);
  return digest;
}

function safeWorkspaceId(value: unknown): string {
  const workspaceId = String(value ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(workspaceId)) {
    throw new Error("portrait_video_sampler_workspace_invalid");
  }
  return workspaceId;
}

function safeProjectId(value: unknown): number {
  const projectId = Number(value);
  if (!Number.isSafeInteger(projectId) || projectId < 1) {
    throw new Error("portrait_video_sampler_project_invalid");
  }
  return projectId;
}

function executablePath(
  environment: Environment,
  variable: "FANJIN_FFMPEG_PATH" | "FANJIN_FFPROBE_PATH",
  fallback: "ffmpeg" | "ffprobe",
): string | null {
  const configured = String(environment[variable] || "").trim();
  const name = configured || fallback;
  if (/[/\\]/u.test(name) && !path.isAbsolute(name)) return null;
  const candidates = path.isAbsolute(name)
    ? [name]
    : String(environment.PATH || process.env.PATH || "")
        .split(path.delimiter)
        .filter(Boolean)
        .map((directory) => path.join(directory, name));
  for (const candidate of candidates) {
    try {
      const canonical = fs.realpathSync(candidate);
      const stat = fs.statSync(canonical);
      fs.accessSync(canonical, fs.constants.X_OK);
      if (stat.isFile()) return canonical;
    } catch {
      // Continue to the next PATH entry without exposing it in readiness.
    }
  }
  return null;
}

export function inspectPortraitVideoSamplerConfiguration(
  environment: Environment = process.env,
): PortraitVideoSamplerConfiguration {
  const ffmpeg = executablePath(environment, "FANJIN_FFMPEG_PATH", "ffmpeg");
  const ffprobe = executablePath(environment, "FANJIN_FFPROBE_PATH", "ffprobe");
  const mediaToolWorks = (executable: string | null, expected: "ffmpeg" | "ffprobe") => {
    if (!executable) return false;
    const result = spawnSync(executable, ["-version"], {
      encoding: "utf8",
      env: sanitizeChildProcessEnvironment(environment),
      maxBuffer: 8 * 1024,
      timeout: 2_000,
      windowsHide: true,
    });
    return result.status === 0
      && !result.signal
      && result.stderr === ""
      && result.stdout.startsWith(`${expected} version `);
  };
  if (!mediaToolWorks(ffmpeg, "ffmpeg") || !mediaToolWorks(ffprobe, "ffprobe")) {
    return Object.freeze({
      configured: false,
      valid: false,
      reason: "portrait_video_media_tool_unavailable",
    });
  }
  const storage = inspectObjectStorageConfiguration(environment);
  if (
    !storage.supported
    || !["s3", "tos"].includes(storage.effectiveProvider)
  ) {
    return Object.freeze({
      configured: false,
      valid: false,
      reason: "portrait_video_remote_storage_unavailable",
    });
  }
  return Object.freeze({ configured: true, valid: true, reason: null });
}

/** Secret-free readiness gate for durable ephemeral-frame cleanup. */
export async function inspectPortraitVideoSampleCleanupBacklog(
  database: Knex,
): Promise<PortraitVideoSampleCleanupInspection> {
  try {
    const rows = await database<Record<string, unknown>>(
      "o_object_write_intent",
    )
      .where({ purpose: "direct_upload" })
      .andWhere("objectKey", "like", "%/portrait-detector/video-samples/%")
      .select("purpose", "projectId", "objectKey", "status");
    const malformed = rows.some((row) => !isEphemeralPortraitSampleIntent({
      purpose: String(row.purpose || "") as "direct_upload",
      projectId: Number(row.projectId),
      objectKey: String(row.objectKey || ""),
    }));
    const outstandingCount = rows.filter((row) => (
      String(row.status || "") !== "compensated"
    )).length;
    const ready = !malformed && outstandingCount === 0;
    return Object.freeze({
      inspected: true,
      ready,
      outstandingCount,
      reason: ready
        ? null
        : malformed
          ? "portrait_video_sample_cleanup_evidence_invalid"
          : "portrait_video_sample_cleanup_pending",
    });
  } catch {
    return Object.freeze({
      inspected: false,
      ready: false,
      outstandingCount: null,
      reason: "portrait_video_sample_cleanup_inspection_failed",
    });
  }
}

function execFileStrict(input: {
  executable: string;
  args: string[];
  signal: AbortSignal;
  maximumStdoutBytes: number;
}): Promise<string> {
  input.signal.throwIfAborted();
  return new Promise<string>((resolve, reject) => {
    execFile(
      input.executable,
      input.args,
      {
        encoding: "utf8",
        env: sanitizeChildProcessEnvironment(),
        maxBuffer: input.maximumStdoutBytes,
        signal: input.signal,
        timeout: MEDIA_TOOL_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error || stderr.length !== 0) {
          reject(new Error("portrait_video_media_tool_failed"));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function mediaToolPath(name: "ffmpeg" | "ffprobe"): string {
  const variable = name === "ffmpeg" ? "FANJIN_FFMPEG_PATH" : "FANJIN_FFPROBE_PATH";
  const resolved = executablePath(process.env, variable, name);
  if (!resolved) throw new Error("portrait_video_media_tool_unavailable");
  return resolved;
}

async function probeVideo(input: {
  inputPath: string;
  signal: AbortSignal;
}): Promise<ProbedVideo> {
  const stdout = await execFileStrict({
    executable: mediaToolPath("ffprobe"),
    args: [
      "-v", "error",
      "-max_alloc", String(64 * 1024 * 1024),
      "-protocol_whitelist", "file",
      "-probesize", String(8 * 1024 * 1024),
      "-analyzeduration", "5000000",
      "-max_probe_packets", "4096",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height,duration:format=duration",
      "-of", "json",
      input.inputPath,
    ],
    signal: input.signal,
    maximumStdoutBytes: 64 * 1024,
  });
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    throw new Error("portrait_video_probe_invalid");
  }
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const stream = streams[0] && typeof streams[0] === "object"
    ? streams[0] as Record<string, unknown>
    : null;
  const format = parsed.format && typeof parsed.format === "object"
    ? parsed.format as Record<string, unknown>
    : null;
  const width = Number(stream?.width);
  const height = Number(stream?.height);
  const durationMs = Math.round(Number(stream?.duration ?? format?.duration) * 1000);
  if (
    !Number.isSafeInteger(width)
    || !Number.isSafeInteger(height)
    || !Number.isSafeInteger(durationMs)
    || width < 1
    || height < 1
    || durationMs < 1
    || durationMs > MAXIMUM_VIDEO_DURATION_MS
    || width > MAXIMUM_VIDEO_DIMENSION
    || height > MAXIMUM_VIDEO_DIMENSION
    || width * height > MAXIMUM_VIDEO_PIXELS
  ) throw new Error("portrait_video_probe_invalid");
  return Object.freeze({ durationMs, height, width });
}

async function extractFrame(input: {
  inputPath: string;
  outputPath: string;
  signal: AbortSignal;
  timestampMs: number;
}): Promise<void> {
  await execFileStrict({
    executable: mediaToolPath("ffmpeg"),
    args: [
      "-nostdin", "-v", "error", "-xerror", "-n",
      "-max_alloc", String(64 * 1024 * 1024),
      "-protocol_whitelist", "file",
      "-probesize", String(8 * 1024 * 1024),
      "-analyzeduration", "5000000",
      "-ss", (input.timestampMs / 1000).toFixed(3),
      "-i", input.inputPath,
      "-map", "0:v:0", "-an", "-sn", "-dn",
      "-frames:v", "1", "-threads", "1", "-q:v", "3",
      "-fs", String(MAXIMUM_FRAME_BYTES),
      "-f", "image2", input.outputPath,
    ],
    signal: input.signal,
    maximumStdoutBytes: 1,
  });
}

/** Decode locally at reduced size; only timestamps leave the scene detector. */
export async function detectPortraitVideoSceneChanges(input: { inputPath: string; signal: AbortSignal }): Promise<number[]> {
  const stdout = await execFileStrict({
    executable: mediaToolPath("ffmpeg"),
    args: [
      "-nostdin", "-v", "error", "-max_alloc", String(64 * 1024 * 1024),
      "-protocol_whitelist", "file", "-threads", "1", "-i", input.inputPath,
      "-map", "0:v:0", "-an", "-sn", "-dn", "-filter_threads", "1",
      "-vf", "scale=320:-2,select='gt(scene,0.3)',metadata=mode=print:file=-",
      "-frames:v", "64", "-f", "null", "-",
    ],
    signal: input.signal,
    maximumStdoutBytes: 64 * 1024,
  });
  return [...stdout.matchAll(/\bpts_time:(\d+(?:\.\d+)?)/gu)]
    .map(match => Math.round(Number(match[1]) * 1000));
}

export function portraitVideoSampleTimestamps(durationMs: number, sceneTimestamps: readonly number[] = []): number[] {
  if (!Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > MAXIMUM_VIDEO_DURATION_MS) {
    throw new Error("portrait_video_duration_invalid");
  }
  // Seek inside the final frame rather than beyond its presentation timestamp.
  const lastTimestamp = Math.max(0, durationMs - 100);
  const baseline = [...new Set([0, lastTimestamp, ...SAMPLE_FRACTIONS.map((fraction) => (
    Math.min(lastTimestamp, Math.max(0, Math.floor(durationMs * fraction)))
  ))])];
  const scenes = [...new Set(sceneTimestamps)]
    .filter(time => Number.isSafeInteger(time) && time > 0 && time <= lastTimestamp
      && baseline.every(base => Math.abs(base - time) >= 100))
    .sort((a, b) => a - b);
  const available = MAXIMUM_SAMPLE_FRAMES - baseline.length;
  const selected = scenes.length <= available ? scenes : Array.from({ length: available }, (_, index) => (
    scenes[Math.floor((index + 0.5) * scenes.length / available)]
  ));
  return [...new Set([...baseline, ...selected])].sort((a, b) => a - b);
}

function exactReceipt(
  receipt: ObjectStorageWriteReceipt | null,
  key: string,
  body: Buffer,
): ObjectStorageWriteReceipt {
  const bodySha256 = sha256(body);
  if (
    !receipt
    || receipt.key !== key
    || receipt.size !== body.byteLength
    || receipt.sha256 !== bodySha256
    || !receipt.versionId
    || !receipt.etag
  ) throw new Error("portrait_video_sample_write_receipt_invalid");
  return receipt;
}

function exactSignedFrameUrl(raw: string, versionId: string): string {
  if (typeof raw !== "string" || raw.length < 1 || raw.length > 8_192) {
    throw new Error("portrait_video_sample_signed_url_invalid");
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("portrait_video_sample_signed_url_invalid");
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.hash
    || parsed.searchParams.getAll("versionId").length !== 1
    || parsed.searchParams.get("versionId") !== versionId
  ) throw new Error("portrait_video_sample_signed_url_invalid");
  return parsed.toString();
}

function durableIntentId(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const value = String((error as { intentId?: unknown }).intentId || "");
  return /^[0-9a-f-]{36}$/u.test(value) ? value : null;
}

async function waitForCleanupRetry(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (delayMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("portrait_video_sample_cleanup_aborted"));
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

async function reconcilePortraitSampleIntent(input: {
  configuration?: ObjectStorageConfiguration;
  database?: Knex;
  intentId: string;
  signal: AbortSignal;
  storage?: ObjectStorageAdapter;
}): Promise<void> {
  const timeout = AbortSignal.timeout(FRAME_CLEANUP_TIMEOUT_MS);
  const signal = AbortSignal.any([input.signal, timeout]);
  const configuration = input.configuration
    ?? resolveObjectStorageConfiguration();
  if (configuration.provider === "local") {
    throw new Error("portrait_video_remote_storage_unavailable");
  }
  const storage = input.storage
    ?? createRemoteObjectStorageAdapter(configuration);
  const runtime = {
    ...(input.database ? { database: input.database } : {}),
    configuration,
  };
  while (!signal.aborted) {
    const record = await getObjectWriteIntent(input.intentId, runtime);
    if (!record) throw new Error("portrait_video_sample_intent_missing");
    if (record.status === "compensated") return;
    if (record.status === "committed" || record.referenceJson !== null) {
      throw new Error("portrait_video_sample_intent_state_invalid");
    }
    const now = Date.now();
    if (record.nextAttemptAt > now) {
      await waitForCleanupRetry(
        Math.min(record.nextAttemptAt - now, 1_000),
        signal,
      );
      continue;
    }
    const claim = await claimObjectWriteCompensationById({
      id: input.intentId,
      workerId: `portrait-video-cleanup:${process.pid}:${input.intentId}`,
      leaseMs: FRAME_CLEANUP_LEASE_MS,
    }, runtime);
    if (!claim) {
      await waitForCleanupRetry(25, signal);
      continue;
    }
    try {
      await processClaimedObjectWriteCompensation(claim, {
        ...runtime,
        signal,
        storage,
      });
    } catch {
      // The durable row records a bounded retry. Never turn an uncertain
      // delete into success; retry only while this admission's deadline lasts.
    }
  }
  throw new Error("portrait_video_sample_cleanup_unresolved");
}

export async function detectPortraitVideoFacesWithImageX(input: {
  database?: Knex;
  dependencies?: PortraitVideoSamplerDependencies;
  projectId: number;
  signal: AbortSignal;
  sourceSha256: string;
  sourceUrl: string;
  workspaceId: string;
}): Promise<PortraitVideoSamplerResult> {
  const sourceSha256 = exactSha256(
    input.sourceSha256,
    "portrait_video_source_hash_invalid",
  );
  const workspaceId = safeWorkspaceId(input.workspaceId);
  const projectId = safeProjectId(input.projectId);
  const timeoutSignal = AbortSignal.timeout(VIDEO_TOTAL_TIMEOUT_MS);
  const signal = AbortSignal.any([input.signal, timeoutSignal]);
  const dependencies = input.dependencies ?? {};
  const assertStorageAuthority = dependencies.assertStorageAuthority ?? (() => {
    const inspection = inspectObjectStorageCapabilityAttestation();
    if (!inspection.ready) {
      throw new VolcengineImageXReviewError({
        code: "PORTRAIT_VIDEO_STORAGE_AUTHORITY_UNAVAILABLE",
        dispatchState: "not_dispatched",
        message: "视频人像检测所需的存储校验未就绪，请联系管理员配置后重试",
      });
    }
  });
  const downloadVideo = dependencies.downloadVideo ?? downloadPublicRemoteVideo;
  const probe = dependencies.probeVideo ?? probeVideo;
  const extract = dependencies.extractFrame ?? extractFrame;
  const randomUUID = dependencies.randomUUID ?? crypto.randomUUID;
  const injectedStorage = [
    dependencies.writeFrame,
    dependencies.deleteFrame,
  ];
  const injectedStorageCount = injectedStorage.filter(Boolean).length;
  if (injectedStorageCount !== 0 && injectedStorageCount !== 2) {
    throw new Error("portrait_video_sample_storage_override_invalid");
  }
  const writeFrame = dependencies.writeFrame!;
  const signFrame = dependencies.signFrame ?? (async (key, versionId) => (
    u.oss.getPrivateFileUrl(key, { expiresInSeconds: 60, versionId })
  ));
  const deleteFrame = dependencies.deleteFrame!;
  const detectFrame = dependencies.detectFrame ?? (async (frame) => (
    detectPortraitVideoSampleFrameWithImageX({
      ...frame,
      clientFactory: dependencies.clientFactory,
      database: input.database,
    })
  ));

  assertStorageAuthority();
  signal.throwIfAborted();
  const downloaded = await downloadVideo({
    maximumBytes: VIDEO_MAXIMUM_BYTES,
    timeoutMs: VIDEO_DOWNLOAD_TIMEOUT_MS,
    url: input.sourceUrl,
  });
  signal.throwIfAborted();
  if (downloaded.body.byteLength > VIDEO_MAXIMUM_BYTES || sha256(downloaded.body) !== sourceSha256) {
    throw new Error("portrait_video_source_hash_mismatch");
  }

  const temporaryDirectory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "fanjin-portrait-video-"),
  );
  await fs.promises.chmod(temporaryDirectory, 0o700);
  const sourcePath = path.join(temporaryDirectory, "source.video");
  try {
    await fs.promises.writeFile(sourcePath, downloaded.body, {
      flag: "wx",
      mode: 0o600,
    });
    const video = await probe({ inputPath: sourcePath, signal });
    let sceneTimestamps: number[] = [];
    let sceneSampling: "completed" | "unavailable" = "completed";
    try {
      sceneTimestamps = await (dependencies.detectSceneChanges ?? detectPortraitVideoSceneChanges)({ inputPath: sourcePath, signal });
    } catch {
      signal.throwIfAborted();
      // Uniform samples still provide a presence signal, never proof that
      // the entire video contains no people.
      sceneSampling = "unavailable";
    }
    const timestamps = portraitVideoSampleTimestamps(video.durationMs, sceneTimestamps);
    if (timestamps.length < 1 || timestamps.length > MAXIMUM_SAMPLE_FRAMES) {
      throw new Error("portrait_video_sample_plan_invalid");
    }
    const samples: Array<Readonly<{
      evidenceHash: string;
      faceCount: number;
      frameSha256: string;
      sampleIndex: number;
      timestampMs: number;
    }>> = [];
    let maximumFaceCount = 0;
    for (let sampleIndex = 0; sampleIndex < timestamps.length; sampleIndex += 1) {
      signal.throwIfAborted();
      const timestampMs = timestamps[sampleIndex];
      const framePath = path.join(temporaryDirectory, `frame-${sampleIndex}.jpg`);
      await extract({
        inputPath: sourcePath,
        outputPath: framePath,
        signal,
        timestampMs,
      });
      const frameStat = await fs.promises.stat(framePath);
      if (!frameStat.isFile() || frameStat.size < 4 || frameStat.size > MAXIMUM_FRAME_BYTES) {
        throw new Error("portrait_video_sample_frame_invalid");
      }
      const frameBody = await fs.promises.readFile(framePath);
      if (
        frameBody.byteLength !== frameStat.size
        || frameBody[0] !== 0xff
        || frameBody[1] !== 0xd8
        || frameBody.at(-2) !== 0xff
        || frameBody.at(-1) !== 0xd9
      ) throw new Error("portrait_video_sample_frame_invalid");
      const frameSha256 = sha256(frameBody);
      let key = injectedStorageCount === 2
        ? `${projectId}/portrait-detector/video-samples/${sourceSha256}/${randomUUID()}.jpg`
        : "";
      let receipt: ObjectStorageWriteReceipt | null = null;
      let durableIntent: Awaited<ReturnType<typeof writeObjectWithDurableIntent>> | null = null;
      let uncertainIntentId: string | null = null;
      try {
        if (injectedStorageCount === 2) {
          receipt = await writeFrame(key, frameBody, signal);
        } else {
          try {
            durableIntent = await writeObjectWithDurableIntent({
              purpose: "direct_upload",
              workspaceId,
              projectId,
              body: frameBody,
              contentSha256: frameSha256,
              storageKey: (intentId) => (
                `${projectId}/portrait-detector/video-samples/${sourceSha256}/${intentId}.jpg`
              ),
              writerIdPrefix: "portrait-video-sampler",
              leaseMs: FRAME_WRITE_LEASE_MS,
              putTimeoutMs: 15_000,
              settlementGraceMs: 1_000,
            }, {
              ...(input.database ? { database: input.database } : {}),
              ...(dependencies.storageConfiguration
                ? { configuration: dependencies.storageConfiguration }
                : {}),
              ...(dependencies.durableWriter
                ? { writer: dependencies.durableWriter }
                : {}),
              signal,
            });
            await renewObjectWriteIntentClaim(
              durableIntent.claim,
              FRAME_ACTIVE_SAMPLE_LEASE_MS,
              {
                ...(input.database ? { database: input.database } : {}),
                ...(dependencies.storageConfiguration
                  ? { configuration: dependencies.storageConfiguration }
                  : {}),
              },
            );
            receipt = durableIntent.receipt;
            key = durableIntent.storageKey;
          } catch (error) {
            uncertainIntentId = durableIntentId(error);
            if (uncertainIntentId) {
              try {
                await reconcilePortraitSampleIntent({
                  database: input.database,
                  configuration: dependencies.storageConfiguration,
                  intentId: uncertainIntentId,
                  signal: AbortSignal.timeout(FRAME_CLEANUP_TIMEOUT_MS),
                  storage: dependencies.cleanupStorage,
                });
              } catch (cleanupError) {
                throw new AggregateError(
                  [error, cleanupError],
                  "portrait video sample PUT outcome remains unresolved",
                );
              }
            }
            throw error;
          }
        }
        const verifiedReceipt = exactReceipt(
          receipt,
          key,
          frameBody,
        );
        const frameUrl = exactSignedFrameUrl(
          await signFrame(key, verifiedReceipt.versionId!),
          verifiedReceipt.versionId!,
        );
        const detected = await detectFrame({
          frameSha256,
          frameUrl,
          sampleIndex,
          signal,
          sourceSha256,
          workspaceId,
        });
        if (
          !Number.isSafeInteger(detected.faceCount)
          || detected.faceCount < 0
          || detected.faceCount > 100
          || !/^[a-f0-9]{64}$/u.test(detected.evidenceHash)
          || detected.detectorVersion !== PORTRAIT_IMAGEX_REVIEW_POLICY_VERSION
        ) throw new Error("portrait_video_sample_detection_invalid");
        maximumFaceCount = Math.max(maximumFaceCount, detected.faceCount);
        samples.push(Object.freeze({
          evidenceHash: detected.evidenceHash,
          faceCount: detected.faceCount,
          frameSha256,
          sampleIndex,
          timestampMs,
        }));
      } finally {
        let cleanupFailure: unknown = null;
        if (injectedStorageCount === 2 && receipt) {
          try {
            await deleteFrame(receipt);
          } catch (error) {
            cleanupFailure = error;
          }
        } else if (durableIntent) {
          try {
            await markObjectWriteCompensationPending(
              durableIntent.claim,
              Object.assign(
                new Error("PORTRAIT_VIDEO_SAMPLE_EPHEMERAL"),
                { code: "PORTRAIT_VIDEO_SAMPLE_EPHEMERAL" },
              ),
              { ...(input.database ? { database: input.database } : {}) },
            );
            await reconcilePortraitSampleIntent({
              database: input.database,
              configuration: dependencies.storageConfiguration,
              intentId: durableIntent.intentId,
              signal: AbortSignal.timeout(FRAME_CLEANUP_TIMEOUT_MS),
              storage: dependencies.cleanupStorage,
            });
          } catch (error) {
            cleanupFailure = error;
          }
        }
        try {
          await fs.promises.rm(framePath, { force: true });
        } catch (error) {
          cleanupFailure ??= error;
        }
        if (cleanupFailure) throw cleanupFailure;
      }
    }
    const evidence = Object.freeze({
      coverage: "sampled_video",
      durationMs: video.durationMs,
      maximumFaceCount,
      sampleCount: samples.length,
      sceneSampling,
      timestampsMs: timestamps,
      samplesSha256: sha256(samples),
      sourceSha256,
      version: "portrait-imagex-video-sampler-evidence/v1",
    });
    return Object.freeze({
      state: maximumFaceCount === 0
        ? "no_face"
        : maximumFaceCount === 1
          ? "single_face"
          : "multiple_faces",
      faceCount: maximumFaceCount,
      confidence: null,
      detectorName: "volcano-imagex-video-sampler",
      detectorVersion: PORTRAIT_VIDEO_SAMPLER_POLICY_VERSION,
      evidenceHash: sha256(evidence),
      evidence,
      coverage: "sampled_video",
    });
  } finally {
    await fs.promises.rm(temporaryDirectory, { recursive: true, force: true });
  }
}
