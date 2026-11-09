export const LEGACY_DEMO_MEDIA_PATTERN = /(?:^|\/)demo-assets\/|(?:^|\/)preset-[^/?#]+\.(?:png|jpe?g|webp|gif)(?:[?#]|$)/i;

type CanvasMediaNode = {
  type?: string;
  generatedImages?: unknown[];
  localPreviewUrl?: string;
  imageUrl?: string;
  primaryImageUrl?: string;
  imageResultVersion?: number;
  videoUrl?: string;
  localVideoUrl?: string;
  audioUrl?: string;
  localAudioUrl?: string;
  outputText?: string;
  prompt?: string;
  mediaNaturalWidth?: number;
  mediaNaturalHeight?: number;
  width?: number;
  height?: number;
};

export function getGeneratedImageChoiceUrl(choice: unknown) {
  if (!choice) return "";
  if (typeof choice === "string") return choice;
  if (typeof choice !== "object") return "";
  const record = choice as Record<string, unknown>;
  return String(record.url || record.imageUrl || record.src || "");
}

export function getNodeImageDisplayUrl(node: CanvasMediaNode | null | undefined) {
  if (!node) return "";
  const generatedUrl = Array.isArray(node.generatedImages)
    ? node.generatedImages.map(getGeneratedImageChoiceUrl).find(Boolean)
    : "";
  return String(node.localPreviewUrl || node.imageUrl || node.primaryImageUrl || generatedUrl || "");
}

/** Keep delayed canvas snapshots from replacing a newer generated image. */
export function nextCanvasImageResultVersion(previous?: number, now = Date.now()) {
  const prior = Number.isSafeInteger(previous) && Number(previous) > 0 ? Number(previous) : 0;
  return Math.max(prior + 1, Math.floor(now));
}

export function shouldKeepLocalImageResult(
  local: CanvasMediaNode | null | undefined,
  incoming: CanvasMediaNode | null | undefined,
) {
  const localUrl = getNodeImageDisplayUrl(local);
  const incomingUrl = getNodeImageDisplayUrl(incoming);
  if (!localUrl || !incomingUrl || localUrl === incomingUrl) return false;
  const localVersion = Number(local?.imageResultVersion) || 0;
  const incomingVersion = Number(incoming?.imageResultVersion) || 0;
  return localVersion > incomingVersion;
}

export function getCanvasImagePreviewUrl(url: string | undefined | null, maxSide = 960) {
  const raw = String(url || "").trim();
  if (!raw || !(raw.startsWith("http://") || raw.startsWith("https://"))) return raw;
  if (/imageMogr2\/thumbnail\//i.test(raw) || /.(gif|svg)(?:$|[?#])/i.test(raw)) return raw;
  if (!/(myqcloud.com|.cos.|cos.|cloud.tencent)/i.test(raw)) return raw;
  const transform = `imageMogr2/thumbnail/${maxSide}x/format/webp/quality/85`;
  if (!raw.includes("?")) return `${raw}?${transform}`;
  if (/[?&](q-signature|x-cos-signature|sign)=/i.test(raw)) return raw;
  return `${raw}&${transform}`;
}

export function getNodeImagePreviewUrl(node: CanvasMediaNode | null | undefined, maxSide = 960) {
  return getCanvasImagePreviewUrl(getNodeImageDisplayUrl(node), maxSide);
}

export function stripLegacyDemoMedia(value: unknown): unknown {
  if (typeof value === "string") return LEGACY_DEMO_MEDIA_PATTERN.test(value) ? "" : value;
  if (Array.isArray(value)) return value.map(stripLegacyDemoMedia);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, child]) => [key, stripLegacyDemoMedia(child)]),
  );
}

function containsLegacyDemoMedia(value: unknown): boolean {
  if (typeof value === "string") return LEGACY_DEMO_MEDIA_PATTERN.test(value);
  if (Array.isArray(value)) return value.some(containsLegacyDemoMedia);
  if (!value || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).some(containsLegacyDemoMedia);
}

export function sanitizeLegacyDemoNode(rawNode: any) {
  const removedDemoMedia = containsLegacyDemoMedia(rawNode);
  const safeNode = stripLegacyDemoMedia(rawNode) as any;
  if (Array.isArray(safeNode?.generatedImages)) {
    const generatedImages = safeNode.generatedImages
      .filter((choice: unknown) => Boolean(getGeneratedImageChoiceUrl(choice).trim()));
    if (generatedImages.length > 0) safeNode.generatedImages = generatedImages;
    else delete safeNode.generatedImages;
    if (generatedImages.length <= 1) delete safeNode.imageChoicesCollapsed;
  }
  const hasRealResult = Boolean(
    getNodeImageDisplayUrl(safeNode)
    || safeNode?.videoUrl
    || safeNode?.localVideoUrl
    || safeNode?.audioUrl
    || safeNode?.localAudioUrl
    || safeNode?.outputText,
  );
  if (removedDemoMedia && !hasRealResult) {
    safeNode.isGenerating = false;
    safeNode.generationState = "idle";
    safeNode.taskStatus = "idle";
    safeNode.generationProgress = 0;
    delete safeNode.taskId;
    delete safeNode.statusChipText;
    delete safeNode.statusChipTone;
  }
  return safeNode;
}

export function nodeHasMedia(node: CanvasMediaNode) {
  if (node.type === "image") return Boolean(getNodeImageDisplayUrl(node));
  if (node.type === "video") return Boolean(node.videoUrl || node.localVideoUrl);
  if (node.type === "audio") return Boolean(node.audioUrl || node.localAudioUrl);
  return false;
}

export function getNodeTextContent(node: CanvasMediaNode) {
  return String(node.outputText || node.prompt || "").trim();
}

export function cloneHistorySnapshot<
  T extends { nodes: unknown; edges: unknown; groups: unknown; viewport: object },
>(snapshot: T): T {
  return {
    nodes: JSON.parse(JSON.stringify(snapshot.nodes)),
    edges: JSON.parse(JSON.stringify(snapshot.edges)),
    groups: JSON.parse(JSON.stringify(snapshot.groups)),
    viewport: { ...snapshot.viewport },
  } as T;
}

export function nodeDimensionText(node: CanvasMediaNode) {
  const width = Math.max(1, Math.round(node.mediaNaturalWidth ?? Number(node.width)));
  const height = Math.max(1, Math.round(node.mediaNaturalHeight ?? Number(node.height)));
  return `${width} × ${height}`;
}

export function clampVideoCropDraft<T extends { x: number; y: number; width: number; height: number }>(draft: T): T {
  const width = Math.max(0.08, Math.min(1, draft.width));
  const height = Math.max(0.08, Math.min(1, draft.height));
  const x = Math.max(0, Math.min(1 - width, draft.x));
  const y = Math.max(0, Math.min(1 - height, draft.y));
  return { ...draft, x, y, width, height };
}

export function formatVideoClock(seconds: number) {
  const safe = Math.max(0, seconds);
  const mins = Math.floor(safe / 60);
  const secs = Math.floor(safe % 60);
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

export const AUDIO_WAVEFORM_BARS = [12, 18, 24, 30, 34, 28, 22, 17, 14, 20, 27, 32, 26, 18, 13, 10];

export function getAudioWaveformFillCount(current: number, duration: number) {
  if (!duration || duration <= 0) return 0;
  return Math.max(
    0,
    Math.min(AUDIO_WAVEFORM_BARS.length, Math.round((current / duration) * AUDIO_WAVEFORM_BARS.length)),
  );
}

export function inferExtByType(mime: string | null, url: string, mediaType: "image" | "video") {
  const byMime = (mime || "").toLowerCase();
  if (byMime.includes("png")) return "png";
  if (byMime.includes("webp")) return "webp";
  if (byMime.includes("gif")) return "gif";
  if (byMime.includes("jpeg") || byMime.includes("jpg")) return "jpg";
  if (byMime.includes("mp4")) return "mp4";
  if (byMime.includes("webm")) return "webm";
  if (byMime.includes("mov") || byMime.includes("quicktime")) return "mov";
  const clean = url.split("?")[0].toLowerCase();
  const suffix = clean.includes(".") ? clean.split(".").pop() || "" : "";
  if (suffix) return suffix;
  return mediaType === "video" ? "mp4" : "jpg";
}

export function triggerBrowserDownload(href: string, filename: string) {
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.target = "_blank";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}
