import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Knex } from "knex";
import isPathInside from "is-path-inside";
import { v5 as uuidv5 } from "uuid";
import u from "@/utils";
import { insertAndReturnId } from "@/lib/dbDialect";
import { resolveObjectStorageConfiguration } from "@/lib/objectStorageConfig";
import { AGENT_GENERATION_REVIEW_TABLE } from "@/lib/migrations/agentGenerationReview";
import {
  downloadPublicRemoteVideoToFile,
  SafeRemoteVideoDownloadError,
} from "@/lib/safeRemoteVideoDownload";

/**
 * 成片拼接服务（AGENTKIT-ADOPTION-CHECKLIST P2）。
 *
 * 选型决策(P2 2.1):ffmpeg 二进制经 child_process 调用(fanjin-api 容器内置,
 * 本机 /opt/homebrew/bin/ffmpeg 已验证可用);不引入 fluent-ffmpeg 等封装,
 * 与 videoMetadataProbe.ts 的 ffprobe 调用模式保持一致。
 *
 * 安全边界:
 * - 输入必须是当前项目内 type=clip 的视频资产版本(o_image/o_assets 联查);
 * - filePath 只接受 OSS 对象键或受控镜像 URL;HTTP(S) 段 URL 做主机/IP
 *   校验并流式落盘(大小上限),本地 OSS 路径做 is-path-inside 防逃逸;
 * - 拼接产物写入 OSS `/{projectId}/agent/` 前缀,资产落库与调用方事务同链路;
 * - ffmpeg 进程有超时,输出文件大小受上限保护。
 */

export const VIDEO_MERGE_MIN_SEGMENTS = 2;
export const VIDEO_MERGE_MAX_SEGMENTS = 20;
const VIDEO_MERGE_MAX_OUTPUT_BYTES = 2 * 1024 * 1024 * 1024; // 2GB
const VIDEO_MERGE_DEFAULT_MAX_SEGMENT_BYTES = 512 * 1024 * 1024; // 512MiB
const VIDEO_MERGE_HARD_MAX_SEGMENT_BYTES = 2 * 1024 * 1024 * 1024; // 2GiB
const VIDEO_MERGE_DEFAULT_MAX_INPUT_BYTES = 2 * 1024 * 1024 * 1024; // 2GiB
const VIDEO_MERGE_HARD_MAX_INPUT_BYTES = 4 * 1024 * 1024 * 1024; // 4GiB

export type VideoMergeErrorCode =
  | "video_merge_segments_invalid"
  | "video_merge_segment_not_found"
  | "video_merge_segment_unreadable"
  | "video_merge_ffmpeg_missing"
  | "video_merge_ffmpeg_failed"
  | "video_merge_timeout"
  | "video_merge_output_too_large"
  | "video_merge_quality_gate_blocked"
  | "video_merge_idempotency_conflict";

const VIDEO_MERGE_MESSAGES: Readonly<Record<VideoMergeErrorCode, string>> = Object.freeze({
  video_merge_segments_invalid: "拼接段列表必须是 2-20 个非重复的资产版本 ID",
  video_merge_segment_not_found: "拼接段不存在或不属于当前项目",
  video_merge_segment_unreadable: "拼接段文件不可读",
  video_merge_ffmpeg_missing: "服务器未安装 ffmpeg",
  video_merge_ffmpeg_failed: "视频拼接失败,请确认各段编码参数一致",
  video_merge_timeout: "视频拼接超时",
  video_merge_output_too_large: "拼接产物超过大小上限",
  video_merge_quality_gate_blocked: "拼接段存在需人工复核的质量告警,禁止拼接交付",
  video_merge_idempotency_conflict: "拼接任务已有不一致的持久化结果",
});

export class VideoMergeError extends Error {
  readonly code: VideoMergeErrorCode;
  readonly status: number;

  constructor(code: VideoMergeErrorCode, status = 422, detail?: string) {
    super(detail ? `${VIDEO_MERGE_MESSAGES[code]}: ${detail}` : VIDEO_MERGE_MESSAGES[code]);
    this.name = "VideoMergeError";
    this.code = code;
    this.status = status;
  }
}

export interface VideoMergeSegment {
  assetVersionId: number;
  /** OSS 对象键或受控镜像 URL。 */
  filePath: string;
}

/**
 * 加载并校验拼接段:必须全部是当前项目内 type=clip 的资产版本,
 * 顺序与输入 assetVersionIds 严格一致。
 */
export async function loadMergeableVideoSegments(input: {
  database: Knex | Knex.Transaction;
  projectId: number;
  assetVersionIds: readonly number[];
}): Promise<VideoMergeSegment[]> {
  const ids = [...input.assetVersionIds];
  if (ids.length < VIDEO_MERGE_MIN_SEGMENTS || ids.length > VIDEO_MERGE_MAX_SEGMENTS) {
    throw new VideoMergeError("video_merge_segments_invalid", 400);
  }
  if (new Set(ids).size !== ids.length || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new VideoMergeError("video_merge_segments_invalid", 400);
  }
  const rows = await input.database("o_image as asset_version")
    .innerJoin("o_assets as asset", "asset.id", "asset_version.assetsId")
    .where({ "asset.projectId": input.projectId })
    .whereIn("asset_version.id", ids)
    .select({
      id: "asset_version.id",
      filePath: "asset_version.filePath",
      type: "asset_version.type",
    });
  const found = new Map(rows.map((row: { id: unknown; filePath: unknown; type: unknown }) => [
    Number(row.id),
    { filePath: String(row.filePath || ""), type: String(row.type || "") },
  ]));
  const segments: VideoMergeSegment[] = [];
  for (const id of ids) {
    const row = found.get(id);
    if (!row || !row.filePath || row.type !== "clip") {
      throw new VideoMergeError("video_merge_segment_not_found", 404);
    }
    segments.push({ assetVersionId: id, filePath: row.filePath });
  }
  return segments;
}

/** 构造 ffmpeg concat demuxer 列表文件内容(纯函数,便于单测)。 */
export function buildFfmpegConcatList(inputPaths: readonly string[]): string {
  return `${inputPaths
    .map((inputPath) => `file '${inputPath.replace(/'/g, "'\\''")}'`)
    .join("\n")}\n`;
}

function ffmpegTimeoutMs(): number {
  const configured = Number(process.env.FANJIN_FFMPEG_TIMEOUT_MS || 300_000);
  if (!Number.isSafeInteger(configured) || configured <= 0) return 300_000;
  return Math.min(600_000, configured);
}

export type FfmpegRunner = (args: string[], options: { timeoutMs: number }) => Promise<void>;

/** 默认 ffmpeg 执行器:execFile + 超时,错误分类映射到 VideoMergeError。 */
export const defaultFfmpegRunner: FfmpegRunner = (args, options) => new Promise<void>((resolve, reject) => {
  const ffmpegPath = String(process.env.FANJIN_FFMPEG_PATH || "ffmpeg").trim() || "ffmpeg";
  execFile(
    ffmpegPath,
    args,
    // P2 修复:maxBuffer 放大到 16MB 并为溢出单独分类;配合 -loglevel error,
    // 正常情况下不会再触发,溢出时也能给出可诊断的错误而不是通用失败。
    { timeout: options.timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
    (error) => {
      if (!error) return resolve();
      const code = String((error as NodeJS.ErrnoException).code || "");
      if (code === "ENOENT") {
        reject(new VideoMergeError("video_merge_ffmpeg_missing", 500));
        return;
      }
      if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
        reject(new VideoMergeError("video_merge_ffmpeg_failed", 500, "ffmpeg 输出日志超过缓冲上限"));
        return;
      }
      if ((error as { killed?: boolean }).killed || code === "ETIMEDOUT") {
        reject(new VideoMergeError("video_merge_timeout", 504));
        return;
      }
      reject(new VideoMergeError("video_merge_ffmpeg_failed", 500));
    },
  );
});

interface ResolvedSegmentFile {
  localPath: string;
  /** 仅当服务自建临时目录(下载/远端取回)时非空;本地 OSS 文件严禁清理。 */
  tempDir: string | null;
}

interface VideoMergeInputBudget {
  readonly maximumSegmentBytes: number;
  readonly maximumInputBytes: number;
  consumedBytes: number;
}

function boundedByteLimit(
  environmentName: string,
  fallback: number,
  hardMaximum: number,
): number {
  const configured = Number(process.env[environmentName] || fallback);
  if (!Number.isSafeInteger(configured) || configured <= 0) return fallback;
  return Math.min(configured, hardMaximum);
}

function createInputBudget(): VideoMergeInputBudget {
  return {
    maximumSegmentBytes: boundedByteLimit(
      "FANJIN_VIDEO_MERGE_MAX_SEGMENT_BYTES",
      VIDEO_MERGE_DEFAULT_MAX_SEGMENT_BYTES,
      VIDEO_MERGE_HARD_MAX_SEGMENT_BYTES,
    ),
    maximumInputBytes: boundedByteLimit(
      "FANJIN_VIDEO_MERGE_MAX_INPUT_BYTES",
      VIDEO_MERGE_DEFAULT_MAX_INPUT_BYTES,
      VIDEO_MERGE_HARD_MAX_INPUT_BYTES,
    ),
    consumedBytes: 0,
  };
}

function consumeInputBytes(budget: VideoMergeInputBudget, bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new VideoMergeError("video_merge_segment_unreadable", 422, "段文件为空或大小无效");
  }
  if (bytes > budget.maximumSegmentBytes) {
    throw new VideoMergeError("video_merge_segment_unreadable", 413, "段文件超过单段大小上限");
  }
  if (budget.consumedBytes + bytes > budget.maximumInputBytes) {
    throw new VideoMergeError("video_merge_segment_unreadable", 413, "拼接段总大小超过上限");
  }
  budget.consumedBytes += bytes;
}

function mediaDownloadTimeoutMs(): number {
  const configured = Number(process.env.FANJIN_RELAY_MEDIA_DOWNLOAD_TIMEOUT_MS || 600_000);
  if (!Number.isSafeInteger(configured) || configured <= 0) return 600_000;
  return Math.min(configured, 900_000);
}

function mapSafeDownloadError(error: SafeRemoteVideoDownloadError): VideoMergeError {
  if (error.code === "REMOTE_VIDEO_TOO_LARGE") {
    return new VideoMergeError("video_merge_segment_unreadable", 413, "段文件超过大小上限");
  }
  if (error.code === "REMOTE_VIDEO_DOWNLOAD_TIMEOUT") {
    return new VideoMergeError("video_merge_segment_unreadable", 504, "段文件下载超时");
  }
  if (
    error.code.includes("URL_")
    || error.code.includes("PROTOCOL_")
    || error.code.includes("CREDENTIALS_")
    || error.code.includes("FRAGMENT_")
    || error.code.includes("HOST_FORBIDDEN")
    || error.code.includes("ADDRESS_FORBIDDEN")
    || error.code.includes("DNS_UNSAFE")
    || error.code.includes("REDIRECT_DOWNGRADE")
    || error.code.includes("REDIRECT_LOOP")
  ) {
    return new VideoMergeError("video_merge_segment_unreadable", 422, "段 URL 未通过安全校验");
  }
  return new VideoMergeError("video_merge_segment_unreadable", 502, "段文件下载失败");
}

/**
 * 通过共用的安全媒体传输将 URL 段流式落盘。共用层逐跳校验
 * redirect/DNS，并将 socket 固定到已验证 IP，因此不存在 DNS 重绑
 * 的校验/连接时序窗口。
 */
async function downloadSegmentToTemp(
  rawUrl: string,
  budget: VideoMergeInputBudget,
): Promise<{ localPath: string; tempDir: string }> {
  const remainingBytes = budget.maximumInputBytes - budget.consumedBytes;
  const maximumBytes = Math.min(budget.maximumSegmentBytes, remainingBytes);
  if (maximumBytes <= 0) {
    throw new VideoMergeError("video_merge_segment_unreadable", 413, "拼接段总大小超过上限");
  }
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fanjin-merge-"));
  const tempPath = path.join(tempDir, `segment-${randomUUID()}.mp4`);
  try {
    const result = await downloadPublicRemoteVideoToFile({
      url: rawUrl,
      destinationPath: tempPath,
      maximumBytes,
      maximumRedirects: 3,
      timeoutMs: mediaDownloadTimeoutMs(),
    });
    consumeInputBytes(budget, result.sizeBytes);
    return { localPath: tempPath, tempDir };
  } catch (error) {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    if (error instanceof VideoMergeError) throw error;
    if (error instanceof SafeRemoteVideoDownloadError) throw mapSafeDownloadError(error);
    throw new VideoMergeError("video_merge_segment_unreadable", 502, "段文件下载失败");
  }
}

async function resolveSegmentLocalPath(
  filePath: string,
  budget: VideoMergeInputBudget,
): Promise<ResolvedSegmentFile> {
  if (/^https?:\/\//i.test(filePath)) {
    return downloadSegmentToTemp(filePath, budget);
  }
  // OSS 对象键:本地存储直接取绝对路径(不进入清理范围);远端存储先落临时文件。
  const configuration = resolveObjectStorageConfiguration();
  if (configuration.provider === "local") {
    const ossRoot = path.resolve(u.getPath("oss"));
    const absolute = path.resolve(ossRoot, filePath.replace(/^\/+/, ""));
    // 先做词法边界校验，再用 realpath 拒绝 OSS 根内指向外部的符号链接。
    if (!isPathInside(absolute, ossRoot)) {
      throw new VideoMergeError("video_merge_segment_unreadable", 403, "段路径越界");
    }
    try {
      const [canonicalRoot, canonicalFile] = await Promise.all([
        fs.realpath(ossRoot),
        fs.realpath(absolute),
      ]);
      if (!isPathInside(canonicalFile, canonicalRoot)) {
        throw new VideoMergeError("video_merge_segment_unreadable", 403, "段路径越界");
      }
      const stat = await fs.stat(canonicalFile);
      if (!stat.isFile()) {
        throw new VideoMergeError("video_merge_segment_unreadable", 404, filePath);
      }
      consumeInputBytes(budget, stat.size);
      return { localPath: canonicalFile, tempDir: null };
    } catch (error) {
      if (error instanceof VideoMergeError) throw error;
      throw new VideoMergeError("video_merge_segment_unreadable", 404, filePath);
    }
  }
  // 远端对象存储不再经 getFile 整段 Buffer 载入内存：生成短期
  // 签名 URL 后也经过同一 DNS-pinned 有界流式下载器。
  try {
    const privateUrl = await u.oss.getPrivateFileUrl(filePath, { expiresInSeconds: 300 });
    return await downloadSegmentToTemp(privateUrl, budget);
  } catch (error) {
    if (error instanceof VideoMergeError) throw error;
    throw new VideoMergeError("video_merge_segment_unreadable", 502, "远端对象无法读取");
  }
}

/**
 * 执行拼接:concat demuxer 先尝试流复制(-c copy,同编码参数时秒级完成),
 * 失败后回退一次重编码(libx264/aac)以兼容音频缺失或参数不一致的段。
 */
export async function runFfmpegConcat(input: {
  inputPaths: readonly string[];
  outputPath: string;
  runFfmpeg?: FfmpegRunner;
  timeoutMs?: number;
}): Promise<void> {
  const run = input.runFfmpeg ?? defaultFfmpegRunner;
  const timeoutMs = input.timeoutMs ?? ffmpegTimeoutMs();
  const listPath = `${input.outputPath}.concat.txt`;
  await fs.writeFile(listPath, buildFfmpegConcatList(input.inputPaths), "utf8");
  const rethrowNormalized = (error: unknown): never => {
    if (error instanceof VideoMergeError) throw error;
    throw new VideoMergeError("video_merge_ffmpeg_failed", 500);
  };
  try {
    try {
      // -loglevel error:重编码/混合参数场景下 stderr 逐帧输出会轻易超过
      // maxBuffer,导致 Node 杀掉进程;只保留错误输出即可。
      await run([
        "-loglevel", "error",
        "-f", "concat", "-safe", "0", "-i", listPath,
        "-c", "copy",
        // 进程内硬限制，避免异常/恶意媒体在超时前写满临时盘。
        "-fs", String(VIDEO_MERGE_MAX_OUTPUT_BYTES),
        "-y", input.outputPath,
      ], { timeoutMs });
    } catch (error) {
      if (error instanceof VideoMergeError && error.code === "video_merge_ffmpeg_missing") throw error;
      // 回退:重编码兼容混合编码参数/音频缺失
      await fs.rm(input.outputPath, { force: true });
      try {
        await run([
          "-loglevel", "error",
          "-f", "concat", "-safe", "0", "-i", listPath,
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
          "-c:a", "aac",
          "-fs", String(VIDEO_MERGE_MAX_OUTPUT_BYTES),
          "-y", input.outputPath,
        ], { timeoutMs });
      } catch (encodeError) {
        if (encodeError instanceof VideoMergeError && encodeError.code === "video_merge_ffmpeg_missing") throw encodeError;
        rethrowNormalized(encodeError);
      }
    }
    const stat = await fs.stat(input.outputPath).catch(() => null);
    if (!stat || stat.size === 0) throw new VideoMergeError("video_merge_ffmpeg_failed", 500, "产物为空");
    // ffmpeg 在 -fs 边界停止时通常仍以成功码退出；触顶产物很可能被截断，
    // 因此等于上限也必须 fail closed，并立即清除不可交付文件。
    if (stat.size >= VIDEO_MERGE_MAX_OUTPUT_BYTES) {
      await fs.rm(input.outputPath, { force: true }).catch(() => {});
      throw new VideoMergeError("video_merge_output_too_large", 413);
    }
  } finally {
    await fs.rm(listPath, { force: true }).catch(() => {});
  }
}

/**
 * 强制质量门（REVAMP-PLAN 2.3 二期 / 架构"自动阻断交付"）：拼接段中任一
 * 资产版本来源于带未处理 attention 结论的生成提交时，拒绝拼接交付。
 *
 * 链路：attention 评审记录(subjectJson.task.taskId / assets[].assetVersionId)
 * → o_media_asset(metadata.assetVersionId, taskId) → 拼接段。人工处理路径：
 * 复核后由平台侧处置（评审记录 append-only，处置走后续人工流程），本期
 * 只做交付阻断。
 */
export async function assertMergeSegmentsPassQualityGate(input: {
  database: Knex | Knex.Transaction;
  workspaceId: string;
  projectId: number;
  segments: readonly VideoMergeSegment[];
}): Promise<void> {
  const attentionReviews = await input.database(AGENT_GENERATION_REVIEW_TABLE)
    .where({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      verdict: "attention",
    })
    .where("needsHumanAttention", 1)
    .select("id", "subjectJson");
  if (!attentionReviews.length) return;

  const blockedTaskIds = new Set<string>();
  const blockedAssetVersionIds = new Set<number>();
  for (const review of attentionReviews as Array<{ id: string; subjectJson: unknown }>) {
    let subject: Record<string, unknown> | null = null;
    try {
      const parsed = typeof review.subjectJson === "string"
        ? JSON.parse(review.subjectJson)
        : review.subjectJson;
      subject = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      subject = null;
    }
    if (!subject) continue;
    const task = subject.task && typeof subject.task === "object" && !Array.isArray(subject.task)
      ? subject.task as Record<string, unknown>
      : null;
    const taskId = task && typeof task.taskId === "string" ? task.taskId : null;
    if (taskId) blockedTaskIds.add(taskId);
    const assets = Array.isArray(subject.assets) ? subject.assets : [];
    for (const asset of assets) {
      if (asset && typeof asset === "object" && !Array.isArray(asset)) {
        const assetVersionId = Number((asset as Record<string, unknown>).assetVersionId);
        if (Number.isSafeInteger(assetVersionId) && assetVersionId > 0) {
          blockedAssetVersionIds.add(assetVersionId);
        }
      }
    }
  }
  if (blockedTaskIds.size === 0 && blockedAssetVersionIds.size === 0) return;

  // 直接命中：attention 评审产出的资产版本本身被用作拼接段。
  for (const segment of input.segments) {
    if (blockedAssetVersionIds.has(segment.assetVersionId)) {
      throw new VideoMergeError(
        "video_merge_quality_gate_blocked",
        422,
        `资产版本 #${segment.assetVersionId} 的生成结论为需人工复核`,
      );
    }
  }

  // 间接命中：拼接段的 media asset 关联的 relay 任务存在 attention 评审。
  const segmentIds = input.segments.map((segment) => segment.assetVersionId);
  const mediaAssets = await input.database("o_media_asset")
    .where({ workspaceId: input.workspaceId })
    .where(function collectAssetVersions(this: Knex.QueryBuilder) {
      for (const assetVersionId of segmentIds) {
        // metadata JSON 的 assetVersionId 值以 "," 或 "}" 结束,避免数字前缀误配。
        this.orWhere("metadata", "like", `%"assetVersionId":${assetVersionId},%`)
          .orWhere("metadata", "like", `%"assetVersionId":${assetVersionId}}%`);
      }
    })
    .select("id", "taskId", "metadata");
  const segmentTaskIds = new Set<string>();
  for (const row of mediaAssets as Array<{ id: string; taskId: string | null; metadata: unknown }>) {
    let metadata: Record<string, unknown> = {};
    try {
      const parsed = typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata;
      metadata = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      metadata = {};
    }
    const assetVersionId = Number(metadata.assetVersionId);
    if (segmentIds.includes(assetVersionId) && row.taskId) {
      segmentTaskIds.add(String(row.taskId));
    }
  }
  for (const taskId of segmentTaskIds) {
    if (blockedTaskIds.has(taskId)) {
      throw new VideoMergeError("video_merge_quality_gate_blocked", 422, "拼接段对应的生成任务存在需人工复核的结论");
    }
  }
}

export interface VideoMergeAssetResult {
  mediaAssetId: string;
  assetId: number;
  assetVersionId: number;
  filePath: string;
  url: string;
  segmentAssetVersionIds: number[];
}

function mergeTaskId(stepId: string): string {
  return `agent-merge:${stepId}`;
}

function stableMergeMediaAssetId(stepId: string): string {
  return uuidv5(mergeTaskId(stepId), uuidv5.URL);
}

function parseMetadataRecord(value: unknown): Record<string, unknown> | null {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
}

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function sameIntegerSequence(left: readonly number[], right: unknown): boolean {
  return Array.isArray(right)
    && right.length === left.length
    && right.every((value, index) => positiveInteger(value) === left[index]);
}

async function findPersistedMergeResult(input: {
  database: Knex | Knex.Transaction;
  workspaceId: string;
  projectId: number;
  runId: string;
  stepId: string;
  assetVersionIds: readonly number[];
}): Promise<VideoMergeAssetResult | null> {
  const rows = await input.database("o_media_asset")
    .where({ taskId: mergeTaskId(input.stepId) })
    .select("id", "taskId", "workspaceId", "source", "url", "localPath", "metadata");
  if (rows.length === 0) return null;
  if (rows.length !== 1) {
    throw new VideoMergeError("video_merge_idempotency_conflict", 409);
  }
  const media = rows[0];
  const metadata = parseMetadataRecord(media.metadata);
  const assetId = positiveInteger(metadata?.assetId);
  const assetVersionId = positiveInteger(metadata?.assetVersionId);
  const filePath = String(media.localPath || "").trim();
  const url = String(media.url || "").trim();
  if (
    String(media.id || "") !== stableMergeMediaAssetId(input.stepId)
    || String(media.workspaceId || "") !== input.workspaceId
    || String(media.source || "") !== "agent-merge"
    || metadata?.runId !== input.runId
    || metadata?.stepId !== input.stepId
    || positiveInteger(metadata?.projectId) !== input.projectId
    || !sameIntegerSequence(input.assetVersionIds, metadata?.mergedFromAssetVersionIds)
    || !assetId
    || !assetVersionId
    || !filePath
    || !url
  ) {
    throw new VideoMergeError("video_merge_idempotency_conflict", 409);
  }
  const [asset, version] = await Promise.all([
    input.database("o_assets").where({ id: assetId, projectId: input.projectId, type: "clip" }).first(),
    input.database("o_image").where({ id: assetVersionId, assetsId: assetId, type: "clip", filePath }).first(),
  ]);
  if (!asset || !version || positiveInteger(asset.imageId) !== assetVersionId) {
    throw new VideoMergeError("video_merge_idempotency_conflict", 409);
  }
  return {
    mediaAssetId: String(media.id),
    assetId,
    assetVersionId,
    filePath,
    url,
    segmentAssetVersionIds: [...input.assetVersionIds],
  };
}

/**
 * 端到端拼接:校验段 → 解析本地路径 → ffmpeg 拼接 → 写 OSS →
 * 用短事务落 o_media_asset + o_assets/o_image(产出新 assetVersionId)。
 * 文件副作用先于落库；落库失败或并发重放时尽力清理未引用对象。
 */
export async function mergeVideoAssetVersions(input: {
  database: Knex | Knex.Transaction;
  workspaceId: string;
  projectId: number;
  actorUserId: number;
  runId: string;
  stepId: string;
  assetVersionIds: readonly number[];
  now: number;
  runFfmpeg?: FfmpegRunner;
  /**
   * Detached Gateway owner/authorization fence. When provided, this must be
   * the first operation in the short domain-write transaction so ownership or
   * permission changes cannot race the following publication writes.
   */
  assertDetachedExecutionFence?: (trx: Knex.Transaction) => Promise<void>;
  /** Written atomically with the domain rows; enables bookkeeping-only replay. */
  recordDetachedDomainCommit?: (
    trx: Knex.Transaction,
    result: VideoMergeAssetResult,
  ) => Promise<void>;
}): Promise<VideoMergeAssetResult> {
  const persisted = await findPersistedMergeResult(input);
  if (persisted) return persisted;
  const segments = await loadMergeableVideoSegments({
    database: input.database,
    projectId: input.projectId,
    assetVersionIds: input.assetVersionIds,
  });
  const localPaths: string[] = [];
  const inputBudget = createInputBudget();
  // 只清理服务自建的临时目录;本地 OSS 段文件属于持久存储,严禁删除。
  const tempDirs: string[] = [];
  try {
    for (const segment of segments) {
      const resolved = await resolveSegmentLocalPath(segment.filePath, inputBudget);
      localPaths.push(resolved.localPath);
      if (resolved.tempDir) tempDirs.push(resolved.tempDir);
    }
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "fanjin-merge-out-"));
    tempDirs.push(outputDir);
    const outputPath = path.join(outputDir, `merged-${randomUUID()}.mp4`);
    await runFfmpegConcat({
      inputPaths: localPaths,
      outputPath,
      runFfmpeg: input.runFfmpeg,
    });
    const filePath = `/${input.projectId}/agent/${randomUUID()}.mp4`;
    await u.oss.writeNewFileFromPath(filePath, outputPath);
    const url = await u.oss.getFileUrl(filePath);
    const segmentIds = segments.map((segment) => segment.assetVersionId);
    const baseMetadata = {
      mergedFromAssetVersionIds: segmentIds,
      segmentCount: segmentIds.length,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      runId: input.runId,
      stepId: input.stepId,
      engine: "ffmpeg-concat",
    };
    const mediaAssetId = stableMergeMediaAssetId(input.stepId);
    try {
      const committed = await input.database.transaction(async (trx) => {
        await input.assertDetachedExecutionFence?.(trx);
        const existing = await findPersistedMergeResult({ ...input, database: trx });
        if (existing) return existing;
        // Authorization was resolved before the detached handler. Revalidate
        // immutable segment identities and the quality gate in this short
        // commit transaction before publishing any domain rows.
        const currentSegments = await loadMergeableVideoSegments({
          database: trx,
          projectId: input.projectId,
          assetVersionIds: input.assetVersionIds,
        });
        if (currentSegments.some((segment, index) => (
          segment.assetVersionId !== segments[index]?.assetVersionId
          || segment.filePath !== segments[index]?.filePath
        ))) {
          throw new VideoMergeError("video_merge_idempotency_conflict", 409);
        }
        await assertMergeSegmentsPassQualityGate({
          database: trx,
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          segments: currentSegments,
        });
        await trx("o_media_asset").insert({
          id: mediaAssetId,
          taskId: mergeTaskId(input.stepId),
          workspaceId: input.workspaceId,
          assetType: "video",
          source: "agent-merge",
          url,
          localPath: filePath,
          mimeType: "video/mp4",
          width: null,
          height: null,
          durationMs: null,
          metadata: JSON.stringify(baseMetadata),
          createTime: input.now,
        });
        const assetId = await insertAndReturnId(trx, "o_assets", {
          type: "clip",
          projectId: input.projectId,
          name: `拼接成片(${segmentIds.length} 段)`.slice(0, 80),
          prompt: null,
          startTime: input.now,
        });
        const assetVersionId = await insertAndReturnId(trx, "o_image", {
          filePath,
          type: "clip",
          assetsId: assetId,
          model: "ffmpeg-merge",
          resolution: null,
          state: "已完成",
        });
        await trx("o_assets").where({ id: assetId }).update({ imageId: assetVersionId });
        await trx("o_media_asset").where({ id: mediaAssetId }).update({
          metadata: JSON.stringify({ ...baseMetadata, assetId, assetVersionId }),
        });
        const result = {
          mediaAssetId,
          assetId,
          assetVersionId,
          filePath,
          url,
          segmentAssetVersionIds: segmentIds,
        };
        await input.recordDetachedDomainCommit?.(trx, result);
        return result;
      });
      if (committed.filePath !== filePath) {
        await u.oss.deleteFile(filePath).catch(() => {});
      }
      return committed;
    } catch (error) {
      // A PostgreSQL COMMIT can be durable even when its acknowledgement is
      // lost. Reconcile before deleting the uploaded object: an object named by
      // the committed row must remain; when readback itself is unavailable the
      // outcome is unknown, so retain the object for a later idempotent replay
      // or orphan-compensation job rather than creating a broken DB reference.
      let existing: VideoMergeAssetResult | null;
      try {
        existing = await findPersistedMergeResult(input);
      } catch {
        throw error;
      }
      if (existing) {
        if (existing.filePath !== filePath) {
          await u.oss.deleteFile(filePath).catch(() => {});
        }
        return existing;
      }
      // A successful authoritative readback with no row proves the transaction
      // did not publish this object, so it is safe to remove immediately.
      await u.oss.deleteFile(filePath).catch(() => {});
      throw error;
    }
  } finally {
    await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => {})));
  }
}
