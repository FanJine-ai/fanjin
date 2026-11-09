// Embeddings / TTS / 音频转写中转。
// 这三个端点都是同步调用，按量计费，结构简单。
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import axios from "axios";
import type { RelayChannel } from "@/lib/relay";
import { joinProviderApiPath, withChannelRetry } from "@/lib/channelRouter";
import { BillingError } from "@/lib/billing";
import { sanitizeChildProcessEnvironment } from "@/lib/childProcessEnvironment";
import {
  beginRelayUnitBilling,
  markRelayBillingDispatchStarted,
  markRelayBillingPending,
  releaseRelayBillingSession,
  settleRelayUnitBilling,
  type RelayBillingContext,
  type RelayBillingSession,
} from "@/lib/relayBillingSession";
import { resolveChannelApiKey, resolveChannelBaseUrl } from "@/lib/relayChannelCredential";

const execFileAsync = promisify(execFile);
export const MAX_TRANSCRIPTION_FILE_BYTES = 25 * 1024 * 1024;

export class RelayMediaError extends Error {
  statusCode: number;
  upstreamMayHaveAccepted: boolean;

  constructor(message: string, statusCode: number, upstreamMayHaveAccepted = false) {
    super(message);
    this.name = "RelayMediaError";
    this.statusCode = statusCode;
    this.upstreamMayHaveAccepted = upstreamMayHaveAccepted;
  }
}

const DEFINITIVE_NON_BILLABLE_STATUSES = new Set([
  400, 401, 402, 403, 404, 405, 406, 411, 413, 414, 415, 422, 429,
]);

function upstreamMayHaveAcceptedStatus(status: number): boolean {
  return !Number.isFinite(status) || !DEFINITIVE_NON_BILLABLE_STATUSES.has(status);
}

export function redactUpstreamErrorMessage(raw: unknown, fallback: string): string {
  const source = typeof raw === "string" && raw.trim() ? raw : fallback;
  const redacted = source
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|ak|rk|fanjin)[-_][A-Za-z0-9_-]{8,}\b/gi, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(
      /((?:api[-_ ]?key|access[-_ ]?token|token|secret|authorization|credential)\s*[:=]\s*)[^\s,;]+/gi,
      "$1[REDACTED]",
    )
    .replace(/https?:\/\/[^\s]+/gi, (match) => {
      try {
        const url = new URL(match);
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return url.toString();
      } catch {
        return "[REDACTED_URL]";
      }
    })
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return (redacted || fallback).slice(0, 512);
}

function uncertainMediaUpstreamError(error: unknown, fallback: string): RelayMediaError {
  const value = error as any;
  const status = Number(value?.statusCode ?? value?.status ?? value?.response?.status);
  const responseMessage = value?.response?.data?.error?.message;
  const message = redactUpstreamErrorMessage(
    typeof responseMessage === "string" && responseMessage.trim() ? responseMessage : value?.message,
    fallback,
  );
  return new RelayMediaError(
    String(message),
    Number.isFinite(status) ? status : 502,
    upstreamMayHaveAcceptedStatus(status),
  );
}

// ============ Embeddings /v1/embeddings ============
export interface EmbeddingsRequest {
  model: string;
  input: string | string[];
  encoding_format?: "float" | "base64";
  dimensions?: number;
}

export interface MultimodalEmbeddingImageUrl {
  url: string;
}

export interface MultimodalEmbeddingVideoUrl {
  url: string;
  fps?: number;
  max_video_tokens?: number;
  min_frame_tokens?: number;
  max_frame_tokens?: number;
  min_frames?: number;
}

export type MultimodalEmbeddingInput =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: MultimodalEmbeddingImageUrl }
  | { type: "video_url"; video_url: MultimodalEmbeddingVideoUrl };

export interface MultimodalEmbeddingsRequest {
  model: string;
  input: MultimodalEmbeddingInput[];
  encoding_format?: "float" | "base64" | null;
  dimensions?: 1024 | 2048;
  instructions?: string;
  sparse_embedding?: { type: "enabled" | "disabled" };
  multi_embedding?: {
    type: "enabled" | "disabled";
    compression?: "blosc2" | "zstd";
  };
}

/** Ark vision embedding models expose a 128K context window. */
export const MULTIMODAL_EMBEDDING_RESERVATION_TOKENS = 131_072;

export interface AuthoritativeEmbeddingTokenUsage {
  totalTokens: number;
  textTokens: number;
  mediaTokens: number;
  imageTokens: number;
  videoTokens: number;
}

function optionalUsageInteger(value: unknown): number | null {
  if (value === undefined || value === null) return 0;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

/**
 * Parse the provider-authoritative Embedding usage contract. Multimodal
 * requests must carry a complete prompt token breakdown; falling back to
 * total_tokens would apply one price to text and visual tokens and silently
 * under/over-charge the workspace. Video tokens share the conservative visual
 * bucket until the provider publishes a separate commercial price.
 */
export function readAuthoritativeEmbeddingTokenUsage(
  payload: unknown,
  endpointType: "embedding" | "multimodal_embedding",
): AuthoritativeEmbeddingTokenUsage | null {
  const root = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null;
  const usage = root?.usage && typeof root.usage === "object" && !Array.isArray(root.usage)
    ? root.usage as Record<string, unknown>
    : null;
  if (!usage) return null;
  const totalTokens = usage.total_tokens;
  const promptTokens = usage.prompt_tokens;
  if (
    typeof totalTokens !== "number"
    || !Number.isSafeInteger(totalTokens)
    || totalTokens <= 0
    || typeof promptTokens !== "number"
    || !Number.isSafeInteger(promptTokens)
    || promptTokens <= 0
    || promptTokens !== totalTokens
  ) return null;

  if (endpointType === "embedding") {
    return {
      totalTokens,
      textTokens: promptTokens,
      mediaTokens: 0,
      imageTokens: 0,
      videoTokens: 0,
    };
  }

  const details = usage.prompt_tokens_details
    && typeof usage.prompt_tokens_details === "object"
    && !Array.isArray(usage.prompt_tokens_details)
    ? usage.prompt_tokens_details as Record<string, unknown>
    : null;
  if (!details) return null;
  const textTokens = optionalUsageInteger(details.text_tokens);
  const imageTokens = optionalUsageInteger(details.image_tokens);
  const videoTokens = optionalUsageInteger(details.video_tokens);
  if (textTokens == null || imageTokens == null || videoTokens == null) return null;
  const mediaTokens = imageTokens + videoTokens;
  if (!Number.isSafeInteger(mediaTokens) || textTokens + mediaTokens !== promptTokens) return null;
  return { totalTokens, textTokens, mediaTokens, imageTokens, videoTokens };
}

export async function executeRelayEmbeddings(
  input: EmbeddingsRequest,
  ctx: RelayBillingContext,
): Promise<any> {
  const normalizedInput: EmbeddingsRequest = {
    model: input.model,
    input: input.input,
    ...(input.encoding_format ? { encoding_format: input.encoding_format } : {}),
    ...(input.dimensions !== undefined ? { dimensions: input.dimensions } : {}),
  };
  return executeRelayEmbeddingRequest(normalizedInput, ctx, {
    endpointType: "embedding",
    apiPath: "v1/embeddings",
    source: "relay-embeddings",
    reservedTokens: estimateEmbeddingTokenUpperBound(input.input),
  });
}

export async function executeRelayMultimodalEmbeddings(
  input: MultimodalEmbeddingsRequest,
  ctx: RelayBillingContext,
): Promise<any> {
  const normalizedInput = normalizeMultimodalEmbeddingsRequest(input);
  return executeRelayEmbeddingRequest(normalizedInput, ctx, {
    endpointType: "multimodal_embedding",
    apiPath: "v1/embeddings/multimodal",
    source: "relay-multimodal-embeddings",
    reservedTokens: MULTIMODAL_EMBEDDING_RESERVATION_TOKENS,
  });
}

async function executeRelayEmbeddingRequest<T extends { model: string }>(
  input: T,
  ctx: RelayBillingContext,
  options: {
    endpointType: "embedding" | "multimodal_embedding";
    apiPath: "v1/embeddings" | "v1/embeddings/multimodal";
    source: "relay-embeddings" | "relay-multimodal-embeddings";
    reservedTokens: number;
  },
): Promise<any> {
  const reservedTokens = options.reservedTokens;
  const billingState: { current: RelayBillingSession | null } = { current: null };
  let activeChannel: RelayChannel | null = null;

  try {
    const routed = await withChannelRetry(
      {
        endpointType: options.endpointType,
        model: input.model,
        workspaceId: ctx.workspaceId,
        retryPolicy: "disabled",
      },
      0,
      async (channel: RelayChannel) => {
        activeChannel = channel;
        if (!billingState.current) {
          billingState.current = await beginRelayUnitBilling({
            source: options.source,
            endpointType: options.endpointType,
            model: input.model,
            channel,
            context: ctx,
            requestPayload: input,
            units: reservedTokens,
            unit: "token",
            metadata: {
              estimatedTokenUpperBound: reservedTokens,
              logicalApiPath: options.apiPath,
            },
          });
        } else if (billingState.current.provider !== channel.provider) {
          throw new BillingError("跨供应商 fallback 的价格快照结算尚未开放", 409);
        }
        return await executeEmbeddingsCall(input, channel, billingState.current, options.apiPath);
      },
    );

    const session = billingState.current;
    if (!session) throw new BillingError("Embeddings 计费预扣会话未创建", 500);
    const authoritativeUsage = readAuthoritativeEmbeddingTokenUsage(
      routed.result,
      options.endpointType,
    );
    if (!authoritativeUsage) {
      await markRelayBillingPending(session, routed.channel, {
        units: 0,
        unit: "token",
        costMicros: 0,
        reason: "embeddings_upstream_usage_missing_or_invalid",
        metadata: {
          reportedTotalTokens: routed.result?.usage?.total_tokens ?? null,
          reportedPromptTokens: routed.result?.usage?.prompt_tokens ?? null,
          usageBreakdownRequired: options.endpointType === "multimodal_embedding",
          estimatedTokenUpperBound: reservedTokens,
          logicalApiPath: options.apiPath,
        },
      });
      throw new BillingError(
        options.endpointType === "multimodal_embedding"
          ? "多模态 Embeddings 上游未返回可核验的文本/视觉 Token 拆分，预扣已保留待核账"
          : "Embeddings 上游未返回可结算的 usage，预扣已保留待核账",
        502,
      );
    }
    await settleRelayUnitBilling(session, routed.channel, {
      units: authoritativeUsage.totalTokens,
      unit: "token",
      tokenParams: options.endpointType === "multimodal_embedding"
        ? {
            p: authoritativeUsage.textTokens,
            img: authoritativeUsage.mediaTokens,
            len: authoritativeUsage.totalTokens,
          }
        : undefined,
      metadata: {
        authoritativeUsage: true,
        totalTokens: authoritativeUsage.totalTokens,
        textTokens: authoritativeUsage.textTokens,
        mediaTokens: authoritativeUsage.mediaTokens,
        imageTokens: authoritativeUsage.imageTokens,
        videoTokens: authoritativeUsage.videoTokens,
        estimatedTokenUpperBound: reservedTokens,
        logicalApiPath: options.apiPath,
      },
    });
    return routed.result;
  } catch (error) {
    await finalizeMediaFailure({
      session: billingState.current,
      channel: activeChannel,
      error,
      units: reservedTokens,
      unit: "token",
      pendingReason: "embeddings_upstream_outcome_unknown",
      releaseDescription: "Embeddings",
    });
    throw error;
  }
}

// ============ TTS /v1/audio/speech ============
export interface TTSRequest {
  model: string;
  input: string;
  voice?: string;
  response_format?: "mp3" | "opus" | "aac" | "flac" | "wav";
  speed?: number;
}

export async function executeRelayTTS(
  input: TTSRequest,
  ctx: RelayBillingContext,
): Promise<Buffer> {
  const normalizedInput: TTSRequest = {
    model: input.model,
    input: input.input,
    ...(input.voice ? { voice: input.voice } : {}),
    ...(input.response_format ? { response_format: input.response_format } : {}),
    ...(input.speed !== undefined ? { speed: input.speed } : {}),
  };
  const billingState: { current: RelayBillingSession | null } = { current: null };
  let activeChannel: RelayChannel | null = null;

  try {
    const routed = await withChannelRetry(
      {
        endpointType: "tts",
        model: input.model,
        workspaceId: ctx.workspaceId,
        retryPolicy: "disabled",
      },
      0,
      async (channel: RelayChannel) => {
        activeChannel = channel;
        if (!billingState.current) {
          billingState.current = await beginRelayUnitBilling({
            source: "relay-tts",
            endpointType: "tts",
            model: input.model,
            channel,
            context: ctx,
            requestPayload: normalizedInput,
            units: 1,
            unit: "task",
            metadata: {
              responseFormat: input.response_format || "mp3",
              voice: input.voice || null,
            },
          });
        } else if (billingState.current.provider !== channel.provider) {
          throw new BillingError("跨供应商 fallback 的价格快照结算尚未开放", 409);
        }
        return await executeTTSCall(normalizedInput, channel, billingState.current);
      },
    );

    const session = billingState.current;
    if (!session) throw new BillingError("TTS 计费预扣会话未创建", 500);
    await settleRelayUnitBilling(session, routed.channel, {
      units: 1,
      unit: "task",
      metadata: {
        authoritativeResult: true,
        audioBytes: routed.result.length,
        responseFormat: input.response_format || "mp3",
      },
    });
    return routed.result;
  } catch (error) {
    await finalizeMediaFailure({
      session: billingState.current,
      channel: activeChannel,
      error,
      units: 1,
      unit: "task",
      pendingReason: "tts_upstream_outcome_unknown",
      releaseDescription: "TTS",
    });
    throw error;
  }
}

async function executeEmbeddingsCall<T extends { model: string }>(
  input: T,
  channel: RelayChannel,
  billingSession: RelayBillingSession,
  apiPath: "v1/embeddings" | "v1/embeddings/multimodal",
): Promise<any> {
  const { apiKey, baseUrl } = getChannelCreds(channel);
  const upstreamModel = resolveUpstreamModel(channel, input.model);
  const requestBody = { ...input, model: upstreamModel };

  await markRelayBillingDispatchStarted(billingSession, channel);
  try {
    const response = await axios.post(joinProviderApiPath(baseUrl, apiPath), requestBody, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": billingSession.requestId,
        "X-Request-Id": billingSession.requestId,
      },
      timeout: positiveTimeout(channel.timeoutMs, 60_000),
    });
    return response.data;
  } catch (error) {
    throw uncertainMediaUpstreamError(error, "Embeddings 供应商调用失败");
  }
}

async function executeTTSCall(
  input: TTSRequest,
  channel: RelayChannel,
  billingSession: RelayBillingSession,
): Promise<Buffer> {
  const { apiKey, baseUrl } = getChannelCreds(channel);
  const upstreamModel = resolveUpstreamModel(channel, input.model);
  const requestBody = { ...input, model: upstreamModel };

  let response: any;
  await markRelayBillingDispatchStarted(billingSession, channel);
  try {
    response = await axios.post(joinProviderApiPath(baseUrl, "v1/audio/speech"), requestBody, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": billingSession.requestId,
        "X-Request-Id": billingSession.requestId,
      },
      responseType: "arraybuffer",
      timeout: positiveTimeout(channel.timeoutMs, 120_000),
    });
  } catch (error) {
    throw uncertainMediaUpstreamError(error, "TTS 供应商调用失败");
  }

  const audio = toNonEmptyAudioBuffer(response?.data, response?.headers?.["content-type"]);
  if (!audio) {
    throw new RelayMediaError("TTS 上游返回 2xx，但音频内容为空或无效", 502, true);
  }
  return audio;
}

// ============ 音频转写 /v1/audio/transcriptions ============
export type TranscriptionResponseFormat = "json" | "text" | "srt" | "verbose_json" | "vtt";

export interface TranscriptionRequest {
  model: string;
  language?: string;
  prompt?: string;
  response_format?: TranscriptionResponseFormat;
  temperature?: number;
  timestamp_granularities?: Array<"word" | "segment">;
}

export interface TranscriptionFileInput {
  filepath: string;
  originalFilename: string;
  mimetype: string | null;
  size: number;
  sha256: string;
}

export async function executeRelayTranscription(
  input: TranscriptionRequest,
  file: TranscriptionFileInput,
  ctx: RelayBillingContext,
): Promise<any> {
  const normalizedFile = await validateTranscriptionFile(file);
  const duration = await probeAudioDuration(normalizedFile.filepath);
  const durationSeconds = Math.ceil(duration.durationSeconds);
  if (!Number.isSafeInteger(durationSeconds) || durationSeconds <= 0) {
    throw new RelayMediaError("无法从音频中得到可计费的整数秒时长", 400, false);
  }
  const normalizedInput: TranscriptionRequest = {
    model: input.model,
    ...(input.language ? { language: input.language } : {}),
    ...(input.prompt ? { prompt: input.prompt } : {}),
    response_format: input.response_format || "json",
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.timestamp_granularities?.length
      ? { timestamp_granularities: [...input.timestamp_granularities] }
      : {}),
  };
  const billingPayload = {
    ...normalizedInput,
    file: {
      sha256: normalizedFile.sha256,
      sizeBytes: normalizedFile.size,
      originalFilename: normalizedFile.originalFilename,
      mimetype: normalizedFile.mimetype,
      probedDurationMilliseconds: Math.ceil(duration.durationSeconds * 1000),
      audioCodec: duration.audioCodec,
    },
  };
  const billingState: { current: RelayBillingSession | null } = { current: null };
  let activeChannel: RelayChannel | null = null;

  try {
    const routed = await withChannelRetry(
      {
        endpointType: "transcription",
        model: normalizedInput.model,
        workspaceId: ctx.workspaceId,
        retryPolicy: "disabled",
      },
      0,
      async (channel: RelayChannel) => {
        activeChannel = channel;
        if (!billingState.current) {
          billingState.current = await beginRelayUnitBilling({
            source: "relay-transcription",
            endpointType: "transcription",
            model: normalizedInput.model,
            channel,
            context: ctx,
            requestPayload: billingPayload,
            units: durationSeconds,
            unit: "second",
            metadata: {
              durationSeconds,
              probedDurationMilliseconds: billingPayload.file.probedDurationMilliseconds,
              fileSizeBytes: normalizedFile.size,
              fileSha256: normalizedFile.sha256,
              audioCodec: duration.audioCodec,
            },
          });
        } else if (billingState.current.provider !== channel.provider) {
          throw new BillingError("跨供应商 fallback 的价格快照结算尚未开放", 409);
        }
        return await executeTranscriptionCall(
          normalizedInput,
          normalizedFile,
          channel,
          billingState.current,
        );
      },
    );

    const session = billingState.current;
    if (!session) throw new BillingError("Transcription 计费预扣会话未创建", 500);
    await settleRelayUnitBilling(session, routed.channel, {
      units: durationSeconds,
      unit: "second",
      metadata: {
        authoritativeDuration: true,
        durationSeconds,
        probedDurationMilliseconds: billingPayload.file.probedDurationMilliseconds,
        fileSizeBytes: normalizedFile.size,
        fileSha256: normalizedFile.sha256,
        responseFormat: normalizedInput.response_format,
      },
    });
    return routed.result;
  } catch (error) {
    await finalizeMediaFailure({
      session: billingState.current,
      channel: activeChannel,
      error,
      units: durationSeconds,
      unit: "second",
      pendingReason: "transcription_upstream_outcome_unknown",
      releaseDescription: "Transcription",
    });
    throw error;
  }
}

async function executeTranscriptionCall(
  input: TranscriptionRequest,
  file: TranscriptionFileInput,
  channel: RelayChannel,
  billingSession: RelayBillingSession,
): Promise<any> {
  const { apiKey, baseUrl } = getChannelCreds(channel);
  const upstreamModel = resolveUpstreamModel(channel, input.model);
  const FormData = (await import("form-data")).default;
  const form = new FormData();
  form.append("file", createReadStream(file.filepath), {
    filename: file.originalFilename,
    contentType: file.mimetype || "application/octet-stream",
    knownLength: file.size,
  });
  form.append("model", upstreamModel);
  if (input.language) form.append("language", input.language);
  if (input.prompt) form.append("prompt", input.prompt);
  form.append("response_format", input.response_format || "json");
  if (input.temperature !== undefined) form.append("temperature", String(input.temperature));
  for (const granularity of input.timestamp_granularities || []) {
    form.append("timestamp_granularities[]", granularity);
  }

  let response: any;
  await markRelayBillingDispatchStarted(billingSession, channel);
  try {
    response = await axios.post(joinProviderApiPath(baseUrl, "v1/audio/transcriptions"), form, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Idempotency-Key": billingSession.requestId,
        "X-Request-Id": billingSession.requestId,
        ...form.getHeaders(),
      },
      timeout: positiveTimeout(channel.timeoutMs, 120_000),
      maxBodyLength: MAX_TRANSCRIPTION_FILE_BYTES + 1024 * 1024,
      maxContentLength: 16 * 1024 * 1024,
    });
  } catch (error) {
    throw uncertainMediaUpstreamError(error, "Transcription 供应商调用失败");
  }

  if (!isValidTranscriptionResponse(response?.data, input.response_format || "json")) {
    throw new RelayMediaError("Transcription 上游返回 2xx，但响应内容无效", 502, true);
  }
  return response.data;
}

async function validateTranscriptionFile(file: TranscriptionFileInput): Promise<TranscriptionFileInput> {
  const filepath = String(file.filepath || "").trim();
  const size = Number(file.size);
  const sha256 = String(file.sha256 || "").trim().toLowerCase();
  if (!filepath) throw new RelayMediaError("转写临时文件路径缺失", 400, false);
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_TRANSCRIPTION_FILE_BYTES) {
    throw new RelayMediaError("音频文件必须大于 0 且不超过 25MB", size > MAX_TRANSCRIPTION_FILE_BYTES ? 413 : 400, false);
  }
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new RelayMediaError("音频文件 SHA-256 摘要缺失或无效", 400, false);
  }

  let fileStat;
  try {
    fileStat = await stat(filepath);
  } catch {
    throw new RelayMediaError("音频临时文件不存在或不可读", 400, false);
  }
  if (!fileStat.isFile() || fileStat.size !== size) {
    throw new RelayMediaError("音频临时文件大小与上传元数据不一致", 400, false);
  }

  const originalFilename = sanitizeTranscriptionFilename(file.originalFilename);
  const rawMimetype = String(file.mimetype || "").trim().toLowerCase();
  const mimetype = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(rawMimetype)
    ? rawMimetype.slice(0, 128)
    : null;
  return { filepath, originalFilename, mimetype, size, sha256 };
}

function sanitizeTranscriptionFilename(value: unknown): string {
  const raw = String(value || "audio").replace(/[\r\n"\0]/g, "_");
  const basename = path.win32.basename(path.basename(raw)).trim();
  return (basename || "audio").slice(0, 255);
}

async function probeAudioDuration(filepath: string): Promise<{
  durationSeconds: number;
  audioCodec: string;
}> {
  const ffprobePath = String(process.env.FANJIN_FFPROBE_PATH || "ffprobe").trim() || "ffprobe";
  const timeoutMs = Math.min(60_000, positiveTimeout(process.env.FANJIN_FFPROBE_TIMEOUT_MS, 15_000));
  let stdout: string;
  try {
    const result = await execFileAsync(
      ffprobePath,
      [
        "-v", "error",
        "-probesize", "5000000",
        "-analyzeduration", "10000000",
        "-show_entries", "stream=codec_type,codec_name,duration:format=duration",
        "-of", "json",
        filepath,
      ],
      {
        encoding: "utf8",
        env: sanitizeChildProcessEnvironment(),
        maxBuffer: 64 * 1024,
        timeout: timeoutMs,
        windowsHide: true,
      },
    );
    stdout = String(result.stdout || "");
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      throw new RelayMediaError(
        "服务器未安装 ffprobe，无法安全确认音频时长",
        503,
        false,
      );
    }
    if (error?.killed || error?.code === "ETIMEDOUT") {
      throw new RelayMediaError("ffprobe 检测音频时长超时", 422, false);
    }
    throw new RelayMediaError("上传文件不是可识别的音频，或音频已损坏", 400, false);
  }

  let probe: any;
  try {
    probe = JSON.parse(stdout);
  } catch {
    throw new RelayMediaError("ffprobe 返回了无效结果，无法安全确认音频时长", 503, false);
  }
  const audioStreams = Array.isArray(probe?.streams)
    ? probe.streams.filter((stream: any) => stream?.codec_type === "audio")
    : [];
  if (audioStreams.length === 0) {
    throw new RelayMediaError("上传文件不包含可识别的音频流", 400, false);
  }
  const streamDurations = audioStreams
    .map((stream: any) => Number(stream?.duration))
    .filter((duration: number) => Number.isFinite(duration) && duration > 0);
  const formatDuration = Number(probe?.format?.duration);
  const durationCandidates = Number.isFinite(formatDuration) && formatDuration > 0
    ? [...streamDurations, formatDuration]
    : streamDurations;
  const durationSeconds = durationCandidates.length > 0 ? Math.max(...durationCandidates) : Number.NaN;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new RelayMediaError("音频时长缺失或无效，已拒绝调用上游", 400, false);
  }
  const audioCodec = String(audioStreams[0]?.codec_name || "unknown").trim().slice(0, 64) || "unknown";
  return { durationSeconds, audioCodec };
}

function isValidTranscriptionResponse(value: unknown, format: TranscriptionResponseFormat): boolean {
  if (format === "json" || format === "verbose_json") {
    return Boolean(
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof (value as Record<string, unknown>).text === "string",
    );
  }
  return typeof value === "string" && value.trim().length > 0;
}

// ============ 通用工具 ============
function getChannelCreds(channel: RelayChannel): { apiKey: string; baseUrl: string } {
  const apiKey = resolveChannelApiKey(channel);
  const baseUrl = resolveChannelBaseUrl(channel);
  if (!apiKey) throw new RelayMediaError("供应商通道未配置 apiKey", 500, false);
  if (!baseUrl) throw new RelayMediaError("供应商通道未配置 baseUrl", 500, false);
  return { apiKey, baseUrl };
}

function resolveUpstreamModel(channel: RelayChannel, requestedModel: string): string {
  const mapping = channel.config?.modelMapping as Record<string, string> | undefined;
  if (mapping && mapping[requestedModel]) return mapping[requestedModel];
  return requestedModel;
}

function estimateEmbeddingTokenUpperBound(input: string | string[]): number {
  const values = Array.isArray(input) ? input : [input];
  if (values.length === 0 || values.some((value) => typeof value !== "string" || value.length === 0)) {
    throw new RelayMediaError("input 必须是非空字符串或非空字符串数组", 400, false);
  }

  // BPE token 不会比 UTF-8 字节粒度更细；JSON 序列化开销再加固定余量，
  // 用于覆盖每个数组元素的边界/特殊 token，避免按字符数 / 3 低估导致漏扣。
  const serializedBytes = Buffer.byteLength(JSON.stringify(input), "utf8");
  const estimated = serializedBytes + 256 + values.length * 8;
  if (!Number.isSafeInteger(estimated) || estimated <= 0) {
    throw new RelayMediaError("Embedding 输入过大，无法安全预估 Token", 413, false);
  }
  return estimated;
}

function normalizeMultimodalEmbeddingsRequest(
  input: MultimodalEmbeddingsRequest,
): MultimodalEmbeddingsRequest {
  const normalizedInput = input.input.map((item): MultimodalEmbeddingInput => {
    if (item.type === "text") return { type: "text", text: item.text };
    if (item.type === "image_url") {
      return { type: "image_url", image_url: { url: item.image_url.url } };
    }
    return {
      type: "video_url",
      video_url: {
        url: item.video_url.url,
        ...(item.video_url.fps !== undefined ? { fps: item.video_url.fps } : {}),
        ...(item.video_url.max_video_tokens !== undefined
          ? { max_video_tokens: item.video_url.max_video_tokens }
          : {}),
        ...(item.video_url.min_frame_tokens !== undefined
          ? { min_frame_tokens: item.video_url.min_frame_tokens }
          : {}),
        ...(item.video_url.max_frame_tokens !== undefined
          ? { max_frame_tokens: item.video_url.max_frame_tokens }
          : {}),
        ...(item.video_url.min_frames !== undefined ? { min_frames: item.video_url.min_frames } : {}),
      },
    };
  });
  return {
    model: input.model,
    input: normalizedInput,
    ...(input.encoding_format !== undefined ? { encoding_format: input.encoding_format } : {}),
    ...(input.dimensions !== undefined ? { dimensions: input.dimensions } : {}),
    ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
    ...(input.sparse_embedding ? { sparse_embedding: { type: input.sparse_embedding.type } } : {}),
    ...(input.multi_embedding
      ? {
          multi_embedding: {
            type: input.multi_embedding.type,
            ...(input.multi_embedding.compression
              ? { compression: input.multi_embedding.compression }
              : {}),
          },
        }
      : {}),
  };
}

function positiveTimeout(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function toNonEmptyAudioBuffer(value: unknown, rawContentType: unknown): Buffer | null {
  let audio: Buffer;
  if (Buffer.isBuffer(value)) {
    audio = value;
  } else if (value instanceof ArrayBuffer) {
    audio = Buffer.from(value);
  } else if (ArrayBuffer.isView(value)) {
    audio = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  } else {
    return null;
  }
  if (audio.length === 0) return null;

  const contentType = String(rawContentType || "").split(";", 1)[0].trim().toLowerCase();
  if (
    contentType &&
    !contentType.startsWith("audio/") &&
    contentType !== "application/octet-stream" &&
    contentType !== "binary/octet-stream"
  ) {
    return null;
  }
  return audio;
}

async function finalizeMediaFailure(input: {
  session: RelayBillingSession | null;
  channel: RelayChannel | null;
  error: unknown;
  units: number;
  unit: string;
  pendingReason: string;
  releaseDescription: string;
}): Promise<void> {
  const { session, channel, error } = input;
  if (!session || session.finalized) return;

  if (!session.dispatchStarted) {
    await releaseRelayBillingSession(
      session,
      `${input.releaseDescription} 调用上游前失败，释放预扣`,
      "not_dispatched",
    );
    return;
  }
  if (error instanceof RelayMediaError && !error.upstreamMayHaveAccepted) {
    await releaseRelayBillingSession(
      session,
      `${input.releaseDescription} 上游明确拒绝且未产生成本，释放预扣`,
      "definitive_not_billable",
    );
    return;
  }
  if (!channel) return;

  await markRelayBillingPending(session, channel, {
    units: input.units,
    unit: input.unit,
    costMicros: 0,
    reason: input.pendingReason,
    metadata: {
      upstreamStatus: Number(
        (error as any)?.statusCode ?? (error as any)?.status ?? (error as any)?.response?.status,
      ) || null,
      errorName: (error as any)?.name || null,
    },
  });
}
