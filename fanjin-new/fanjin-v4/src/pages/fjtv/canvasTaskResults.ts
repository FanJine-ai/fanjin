export interface GeneratedImageChoice {
  id: string;
  url: string;
  assetId?: number;
  assetVersionId?: number;
}

export function extractGeneratedTextFromResult(value: any): string {
  const candidates = [
    value?.text,
    value?.result?.text,
    value?.data?.text,
    value?.message,
    value?.raw?.text,
    value?.raw?.output?.text,
    value?.raw?.choices?.[0]?.message?.content,
    value?.raw?.output?.choices?.[0]?.message?.content,
    value?.choices?.[0]?.message?.content,
  ];
  for (const candidate of candidates) {
    const text = String(candidate || "").trim();
    if (text) return text;
  }
  return "";
}

function stripMarkdownCodeFence(value: string) {
  const text = String(value || "").trim();
  const match = text.match(/^```(?:json|javascript|js)?\s*([\s\S]*?)\s*```$/i);
  return (match?.[1] || text).trim();
}

function unwrapGeneratedTextPayload(value: string) {
  const text = stripMarkdownCodeFence(value);
  if (!text) return "";
  try {
    const parsed = JSON.parse(text);
    const unwrapped = parsed?.action_input
      || parsed?.output
      || parsed?.text
      || parsed?.content
      || parsed?.message
      || parsed?.prompt
      || "";
    if (typeof unwrapped === "string" && unwrapped.trim()) return unwrapped.trim();
  } catch {
    // Normal prose is already the desired output.
  }
  return text;
}

export function pickTextResult(task: any) {
  const raw = extractGeneratedTextFromResult(task)
    || task?.result?.data?.text
    || task?.result?.text
    || task?.text
    || task?.content
    || "";
  return unwrapGeneratedTextPayload(String(raw || ""));
}

function pickUrlFromAny(input: any): string {
  if (!input) return "";
  if (typeof input === "string") {
    const value = input.trim();
    return value && (
      /^(https?:\/\/|blob:|data:)/i.test(value)
      || (value.startsWith("/") && !value.startsWith("//"))
    ) ? value : "";
  }
  if (Array.isArray(input)) {
    for (const item of input) {
      const found = pickUrlFromAny(item);
      if (found) return found;
    }
    return "";
  }
  if (typeof input === "object") {
    for (const key of ["url", "imageUrl", "image_url", "videoUrl", "video_url", "src", "href", "oss_url", "file_url", "output_url"]) {
      const found = pickUrlFromAny((input as Record<string, unknown>)[key]);
      if (found) return found;
    }
  }
  return "";
}

export function isRemoteGenerationUrl(value: string | undefined | null): value is string {
  return Boolean(value) && /^(https?:\/\/|asset:\/\/)/i.test(String(value).trim());
}

export function normalizeReferenceUrlForRequest(value: string | undefined | null) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^(https?:\/\/|asset:\/\/)/i.test(raw)) return raw;
  if (raw.startsWith("/") && !raw.startsWith("//") && typeof window !== "undefined" && window.location?.origin) {
    return new URL(raw, window.location.origin).toString();
  }
  return "";
}

export function getBoundVideoSourceAssetId(
  binding: { mediaAssetId?: string; mediaAssetUrl?: string },
  resolvedVideoUrl: string,
) {
  const mediaAssetId = String(binding.mediaAssetId || "").trim();
  if (!mediaAssetId) return undefined;
  const boundUrl = normalizeReferenceUrlForRequest(binding.mediaAssetUrl);
  const currentUrl = normalizeReferenceUrlForRequest(resolvedVideoUrl);
  return boundUrl && currentUrl && boundUrl === currentUrl ? mediaAssetId : undefined;
}

function normalizeVideoResolution(value: string | undefined) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized.includes("4k") || normalized.includes("2160")) return "4K";
  if (normalized.includes("2k") || normalized.includes("1440")) return "2K";
  if (normalized.includes("1080")) return "1080P";
  return "720P";
}

export function resolveCanvasVideoSourceResolution(input: { mediaNaturalHeight?: number; resolution?: string }) {
  const height = Number(input.mediaNaturalHeight || 0);
  if (Number.isFinite(height) && height >= 2160) return "4K";
  if (Number.isFinite(height) && height >= 1440) return "2K";
  if (Number.isFinite(height) && height >= 1080) return "1080P";
  if (Number.isFinite(height) && height >= 720) return "720P";
  return normalizeVideoResolution(input.resolution);
}

export function getExplicitTaskResultMediaAssetId(taskData: any) {
  for (const candidate of [taskData?.resultAssetId, taskData?.task?.resultAssetId, taskData?.result?.resultAssetId]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

export function pickImageResult(task: any) {
  const data = task?.result?.data || task?.data || {};
  const topLevelAssets = Array.isArray(task?.assets) ? task.assets : [];
  const resultAssets = Array.isArray(task?.result?.assets) ? task.result.assets : [];
  // Task-level assets may include input references. The completed result is
  // authoritative when both envelopes are present.
  const imageAsset = [...resultAssets, ...topLevelAssets]
    .find((item: any) => item && (
      item.type === "image"
      || item.type === "img"
      || item.assetType === "image"
    ));
  const candidates = [
    imageAsset?.url, imageAsset?.imageUrl, task?.assets, task?.content, task?.output,
    task?.result?.content, task?.result?.output, data?.images, task?.images, data?.image,
    task?.image, data?.output, data?.outputs, data?.result, task?.raw?.data,
    task?.raw?.images, task?.imageUrl, task?.image_url, task?.url,
    task?.result?.raw?.data, task?.result?.raw?.images,
  ];
  for (const candidate of candidates) {
    const found = pickUrlFromAny(candidate);
    if (found) return found;
  }
  return "";
}

function normalizeGeneratedImageChoices(input: any): GeneratedImageChoice[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const items: GeneratedImageChoice[] = [];
  input.forEach((item, index) => {
    const url = String(item?.url || item?.imageUrl || item?.image_url || item?.sourceUrl || item?.src || "").trim();
    if (!url || seen.has(url)) return;
    seen.add(url);
    items.push({
      id: String(item?.id || item?.assetId || `generated_${index}`),
      url,
      assetId: Number.isSafeInteger(Number(item?.assetId)) && Number(item.assetId) > 0
        ? Number(item.assetId)
        : undefined,
      assetVersionId: Number.isSafeInteger(Number(item?.assetVersionId)) && Number(item.assetVersionId) > 0
        ? Number(item.assetVersionId)
        : undefined,
    });
  });
  return items;
}

export function pickGeneratedImageChoices(task: any): GeneratedImageChoice[] {
  const candidates = [
    task?.result?.generatedImages,
    task?.generatedImages,
    task?.result?.images,
    task?.images,
    task?.result?.raw?.data,
    task?.raw?.data,
    Array.isArray(task?.result?.assets)
      ? task.result.assets.filter((item: any) => (
        item?.type === "image"
        || item?.type === "img"
        || item?.assetType === "image"
      ))
      : [],
    Array.isArray(task?.assets)
      ? task.assets.filter((item: any) => (
        item?.type === "image"
        || item?.type === "img"
        || item?.assetType === "image"
      ))
      : [],
  ];
  for (const candidate of candidates) {
    const normalized = normalizeGeneratedImageChoices(candidate);
    if (normalized.length > 0) return normalized;
  }
  return [];
}

export function pickVideoResult(task: any) {
  const data = task?.result?.data || task?.data || {};
  const topLevelAssets = Array.isArray(task?.assets) ? task.assets : [];
  const resultAssets = Array.isArray(task?.result?.assets) ? task.result.assets : [];
  const videoAsset = [...topLevelAssets, ...resultAssets].find((item: any) => item && item.type === "video");
  const candidates = [
    task?.resultUrl, task?.task?.resultUrl, task?.result?.resultUrl, videoAsset?.url,
    videoAsset?.videoUrl, task?.assets, task?.content, task?.output, task?.result?.content,
    task?.result?.output, data?.videos, task?.videos, data?.video, task?.video,
    data?.output, data?.outputs, data?.result, task?.raw?.data, task?.raw?.videos,
    task?.videoUrl, task?.video_url, task?.url, task?.result?.raw?.data, task?.result?.raw?.videos,
  ];
  for (const candidate of candidates) {
    const found = pickUrlFromAny(candidate);
    if (found) return found;
  }
  return "";
}
