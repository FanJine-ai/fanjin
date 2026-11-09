import type { RelayProvider } from "@/lib/sharedTypes";
import { AUTODL_H3_CINEMA_MODEL, autoDLH3SupportsResolution, activeAutoDLH3Workflow, isAutoDLH3LocalLightWorkflow, isAutoDLH3Model } from "@/lib/autodlH3Manifest";

export const ASYNC_VIDEO_RELAY_PROVIDERS = ["volcano", "minimax", "autodl"] as const;
export type AsyncVideoRelayProvider = (typeof ASYNC_VIDEO_RELAY_PROVIDERS)[number];

const MINIMAX_H3_MODELS = new Set(["MiniMax-H3", "MiniMax-H3-Max"]);
const MINIMAX_H3_RESOLUTIONS: Readonly<Record<string, string>> = Object.freeze({
  "480p": "480P",
  "768p": "768P",
  "2k": "2K",
});
const MINIMAX_RATIOS = new Set([
  "adaptive",
  "21:9",
  "16:9",
  "4:3",
  "1:1",
  "3:4",
  "9:16",
]);

export class VideoRelayProviderAdapterError extends Error {
  readonly status = 400;
  readonly statusCode = 400;
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "VideoRelayProviderAdapterError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new VideoRelayProviderAdapterError(code, message);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function cleanBaseUrl(value: string): string {
  return String(value || "").trim().replace(/\/+$/, "");
}

function minimaxApiRoot(baseUrl: string): string {
  const root = cleanBaseUrl(baseUrl);
  if (/\/v2$/iu.test(root)) return root;
  return `${root}/v2`;
}

export function isAsyncVideoRelayProvider(
  provider: unknown,
): provider is AsyncVideoRelayProvider {
  return (ASYNC_VIDEO_RELAY_PROVIDERS as readonly unknown[]).includes(provider);
}

export function videoRelayProviderSubmitUrl(
  provider: AsyncVideoRelayProvider,
  baseUrl: string,
  model?: unknown,
): string {
  const root = cleanBaseUrl(baseUrl);
  if (provider === "autodl") return `${autoDLApiRoot(root)}/${activeAutoDLH3Workflow(model)}`;
  if (provider === "minimax") return `${minimaxApiRoot(root)}/video_generation`;
  const versionedRoot = /\/api\/v3$/iu.test(root) ? root : `${root}/api/v3`;
  return `${versionedRoot}/contents/generations/tasks`;
}

export function videoRelayProviderPollUrl(
  provider: AsyncVideoRelayProvider,
  baseUrl: string,
  providerTaskId: string,
): string {
  const taskId = encodeURIComponent(providerTaskId);
  if (provider === "autodl") return `${autoDLApiRoot(baseUrl)}/result/${taskId}`;
  if (provider === "minimax") {
    return `${minimaxApiRoot(baseUrl)}/query/video_generation/${taskId}`;
  }
  return `${videoRelayProviderSubmitUrl(provider, baseUrl)}/${taskId}`;
}

export function videoRelayProviderCancelUrl(
  provider: AsyncVideoRelayProvider,
  baseUrl: string,
  providerTaskId: string,
): string | null {
  // MiniMax H3's public V2 contract exposes create/query but no cancel API.
  if (provider === "minimax" || provider === "autodl") return null;
  return videoRelayProviderPollUrl(provider, baseUrl, providerTaskId);
}

function minimaxContent(input: unknown, model: string): Record<string, unknown>[] {
  if (!Array.isArray(input)) {
    fail("minimax_h3_content_invalid", "MiniMax H3 content 必须为数组");
  }
  const content = input.map((item) => record(item));
  if (content.some((item) => !item)) {
    fail("minimax_h3_content_invalid", "MiniMax H3 content 项格式无效");
  }
  const items = content as Record<string, unknown>[];
  const textItems = items.filter((item) => item.type === "text");
  if (
    textItems.length !== 1
    || typeof textItems[0].text !== "string"
    || !textItems[0].text.trim()
  ) {
    fail("minimax_h3_prompt_invalid", "MiniMax H3 请求必须且只能包含一个非空提示词");
  }

  const mediaItems = items.filter((item) => item.type !== "text");
  const firstFrames = mediaItems.filter((item) => item.type === "image_url" && item.role === "first_frame");
  const lastFrames = mediaItems.filter((item) => item.type === "image_url" && item.role === "last_frame");
  const referenceImages = mediaItems.filter((item) => item.type === "image_url" && item.role === "reference_image");
  const referenceVideos = mediaItems.filter((item) => item.type === "video_url" && item.role === "reference_video");
  const referenceAudio = mediaItems.filter((item) => item.type === "audio_url" && item.role === "reference_audio");
  if (
    firstFrames.length > 1
    || lastFrames.length > 1
    || referenceImages.length > 9
    || referenceVideos.length > 3
    || referenceAudio.length > 3
    || firstFrames.length + lastFrames.length + referenceImages.length
      + referenceVideos.length + referenceAudio.length !== mediaItems.length
  ) {
    fail("minimax_h3_reference_limit_invalid", "MiniMax H3 参考素材类型或数量超过官方上限");
  }
  const frameMode = firstFrames.length + lastFrames.length > 0;
  const referenceMode = referenceImages.length + referenceVideos.length + referenceAudio.length > 0;
  if (frameMode && referenceMode) {
    fail("minimax_h3_reference_mode_conflict", "MiniMax H3 首尾帧与多参考模式不能混用");
  }
  if (model === "MiniMax-H3-Max" && referenceMode) {
    fail("minimax_h3_max_reference_unsupported", "MiniMax H3 Max 不支持多参考图片、视频或音频");
  }
  return items;
}

function projectMiniMaxH3Payload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const model = typeof payload.model === "string" ? payload.model.trim() : "";
  if (!MINIMAX_H3_MODELS.has(model)) {
    fail("minimax_h3_model_invalid", "MiniMax H3 模型标识无效");
  }
  const content = minimaxContent(payload.content, model);
  const rawResolution = String(payload.resolution || "").trim().toLowerCase();
  const resolution = MINIMAX_H3_RESOLUTIONS[rawResolution];
  const allowedResolutions = model === "MiniMax-H3"
    ? new Set(["768P", "2K"])
    : new Set(["480P", "768P"]);
  if (!resolution || !allowedResolutions.has(resolution)) {
    fail("minimax_h3_resolution_invalid", "所选分辨率不受当前 MiniMax H3 模型支持");
  }
  const duration = Number(payload.duration);
  const minimumDuration = model === "MiniMax-H3" ? 4 : 5;
  if (!Number.isSafeInteger(duration) || duration < minimumDuration || duration > 15) {
    fail("minimax_h3_duration_invalid", `当前 MiniMax H3 模型仅支持 ${minimumDuration}-15 秒`);
  }
  const hasFrame = content.some((item) => item.role === "first_frame" || item.role === "last_frame");
  const ratio = hasFrame ? "adaptive" : String(payload.ratio || "").trim();
  if (!MINIMAX_RATIOS.has(ratio) || (!hasFrame && content.length === 1 && ratio === "adaptive")) {
    fail("minimax_h3_ratio_invalid", "MiniMax H3 画幅比例不符合当前生成模式");
  }
  return { model, content, resolution, duration, ratio };
}

export function projectVideoRelayProviderRequest(
  provider: AsyncVideoRelayProvider,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (provider === "autodl") return projectAutoDLH3Payload(payload);
  return provider === "minimax" ? projectMiniMaxH3Payload(payload) : payload;
}

function autoDLApiRoot(baseUrl: string): string {
  const root = cleanBaseUrl(baseUrl);
  let url: URL;
  try { url = new URL(root); } catch { fail("autodl_base_url_invalid", "AutoDL 通道地址无效"); }
  const mock = process.env.NODE_ENV === "test" && url.hostname === "127.0.0.1" && url.protocol === "http:";
  if ((!mock && url.origin !== "https://autodl.art") || url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    fail("autodl_base_url_invalid", "AutoDL 凭据仅能用于已验证的 AutoDL 接口地址");
  }
  return `${root}/api/v1/comfyui/comfyui_workflow`;
}

export function videoRelayProviderAuthorization(provider: AsyncVideoRelayProvider, apiKey: string): string {
  return provider === "autodl" ? apiKey : `Bearer ${apiKey}`;
}

function projectAutoDLH3Payload(payload: Record<string, unknown>): Record<string, unknown> {
  if (!isAutoDLH3Model(payload.model)) fail("autodl_h3_model_invalid", "AutoDL H3 模型标识无效");
  const duration = payload.duration ?? 5;
  if (typeof duration !== "number" || !Number.isSafeInteger(duration) || duration < 1 || duration > 15) {
    fail("autodl_h3_duration_invalid", "当前 H3 模型支持 1–15 秒整数时长");
  }
  const resolution = String(payload.resolution).toLowerCase();
  if (!autoDLH3SupportsResolution(payload.model, resolution)) {
    fail("autodl_h3_resolution_invalid", "当前 H3 模型不支持所选分辨率");
  }
  const orientation = payload.ratio === "16:9" ? "横" : payload.ratio === "9:16" ? "竖" : null;
  if (!orientation) fail("autodl_h3_ratio_invalid", "当前 H3 通道支持 16:9 或 9:16");
  if (!Array.isArray(payload.content)) fail("autodl_h3_content_invalid", "H3 参考素材格式无效");
  const items = payload.content.map(record);
  if (items.some(item => !item)) fail("autodl_h3_content_invalid", "H3 参考素材格式无效");
  const texts = items.filter(item => item?.type === "text");
  const prompt = texts[0]?.text;
  const lightWorkflow = payload.model !== AUTODL_H3_CINEMA_MODEL && isAutoDLH3LocalLightWorkflow();
  const maxPromptLength = lightWorkflow ? 10000 : 20000;
  if (texts.length !== 1 || typeof prompt !== "string" || !prompt.trim() || Array.from(prompt).length > maxPromptLength) {
    fail("autodl_h3_prompt_invalid", `H3 提示词需为 1–${maxPromptLength} 个字符`);
  }
  const output: Record<string, unknown> = { prompt, duration, resolution: `${resolution}${orientation}` };
  let images = 0;
  let audios = 0;
  for (const item of items) {
    if (!item || item.type === "text") continue;
    const image = item.type === "image_url" && item.role === "reference_image";
    const audio = item.type === "audio_url" && item.role === "reference_audio";
    if (!image && !audio) fail("autodl_h3_reference_unsupported", "当前 H3 通道不支持该参考素材类型");
    if (lightWorkflow && audio) {
      fail("autodl_h3_light_audio_unsupported", "当前测试工作流只支持参考图片，不支持参考音频");
    }
    const url = record(item[image ? "image_url" : "audio_url"])?.url;
    if (typeof url === "string" && /^data:/iu.test(url)) {
      fail("autodl_h3_reference_url_invalid", "当前 H3 通道需要公网可访问的参考素材网址，不支持本地 Base64 图片。请为本地项目配置公网媒体地址或远程对象存储后再生成；本次未提交生成。");
    }
    if (typeof url !== "string" || !/^https?:\/\//iu.test(url)) {
      fail("autodl_h3_reference_url_invalid", "参考素材需要可访问的图片或音频地址");
    }
    const index = image ? images++ : audios++;
    if (images > 9 || audios > 3) fail("autodl_h3_reference_limit_invalid", "H3 最多支持 9 张图片和 3 段音频");
    output[`${image ? "ref_image" : "ref_audio"}_${index}`] = url;
  }
  if (images === 0) {
    fail("autodl_h3_image_required", "当前 H3 工作流至少需要一张参考图片");
  }
  if (payload.seed != null) {
    if (typeof payload.seed !== "number" || !Number.isSafeInteger(payload.seed)) fail("autodl_h3_seed_invalid", "H3 随机种子必须为整数");
    output.seed = payload.seed;
  }
  return output;
}

export function videoRelayProviderStatus(
  provider: AsyncVideoRelayProvider,
  payload: Record<string, unknown>,
): unknown {
  if (provider === "autodl") return payload.code === "Success" ? record(payload.data)?.status : null;
  if (provider === "minimax") return record(payload.task)?.status;
  return payload.status ?? record(payload.data)?.status;
}

export function videoRelayProviderTaskId(
  provider: AsyncVideoRelayProvider,
  payload: Record<string, unknown>,
): unknown {
  if (provider === "autodl") return payload.code === "Success" ? record(payload.data)?.task_id : null;
  if (provider === "minimax") return payload.task_id ?? record(payload.task)?.id;
  return payload.id ?? payload.task_id ?? record(payload.data)?.id ?? record(payload.data)?.task_id;
}

export function videoRelayProviderVideoUrl(
  provider: RelayProvider,
  payload: Record<string, unknown>,
): string | null {
  if (provider === "autodl") {
    const results = record(payload.data)?.results;
    if (payload.code !== "Success" || !Array.isArray(results)) return null;
    const video = results.map(record).find(item => item?.type === "video" && item.output_type === "output");
    return typeof video?.url === "string" && video.url.trim() ? video.url.trim() : null;
  }
  if (provider !== "minimax") return null;
  const url = record(record(payload.task)?.content)?.url;
  return typeof url === "string" && url.trim() ? url.trim() : null;
}
