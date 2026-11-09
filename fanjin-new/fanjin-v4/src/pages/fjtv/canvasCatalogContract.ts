import { referenceRequirementError, type ReferenceMediaInput } from "../../features/quick-create/referenceRequirements";
import type { AiModelOption } from "@/lib/api";
import { BYTEPLUS_SEEDANCE_25_MODEL_ID, hasDeclaredVideoOutputFormats, normalizeDefaultVideoOutputFormat, normalizeVideoOutputFormats, type VideoOutputFormat } from "../../features/quick-create/videoOutputContract";

export const CANVAS_CATALOG_VIDEO_MODES = [
  "text_to_video",
  "omni_reference",
  "image_to_video",
  "first_last_frame",
  "image_reference",
  "video_extension",
  "video_edit",
] as const;

export type CanvasCatalogVideoMode = (typeof CANVAS_CATALOG_VIDEO_MODES)[number];
export type CanvasCatalogImageQuality = "1K" | "2K" | "4K";
export type CanvasCatalogReferenceKind = "image" | "video" | "file";
export type CanvasCatalogInputLimit = { min: number; max: number };
export type CanvasCatalogVideoDuration = {
  auto?: boolean;
  min: number;
  max: number;
  step: number;
  default: number;
  allowed: number[];
};
export type CanvasCatalogVideoOperation = "generate" | "extend" | "edit";
export type CanvasCatalogVideoEditCapability = {
  supportsTimeRange: true;
  supportsMask: boolean;
  supportsPreserveSourceAudio: boolean;
  durationSeconds: number;
  resolutions: string[];
};
export type CanvasCatalogGenerationReference = {
  assetVersionId: string;
  role: "subject" | "style" | "storyboard" | "first_frame" | "last_frame";
  mediaType: "image" | "video" | "audio";
  order: number;
};

const VIDEO_MODE_SET = new Set<string>(CANVAS_CATALOG_VIDEO_MODES);
const IMAGE_QUALITY_SET = new Set<string>(["1K", "2K", "4K"]);
const CONCRETE_ASPECT_RATIO = /^\d{1,3}:\d{1,3}$/;
const PUBLIC_VIDEO_RESOLUTIONS = new Set(["720P", "1080P", "1K", "2K", "4K"]);
const MINIMAX_H3_NATIVE_VIDEO_RESOLUTIONS: Record<string, ReadonlySet<string>> = {
  "minimax-h3-fanjin-cinema": new Set(["480P", "768P", "960P"]),
  "minimax-h3-fanjin": new Set(["768P"]),
  "minimax-h3": new Set(["768P"]),
  "minimax-h3-max": new Set(["480P", "768P"]),
};
const BYTEPLUS_NATIVE_VIDEO_RESOLUTIONS: Record<string, ReadonlySet<string>> = {
  [BYTEPLUS_SEEDANCE_25_MODEL_ID]: new Set(["480P"]),
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function firstStringList(...values: unknown[]): string[] {
  for (const value of values) {
    if (!Array.isArray(value)) continue;
    const normalized = Array.from(
      new Set(value.map((item) => String(item || "").trim()).filter(Boolean)),
    );
    if (normalized.length) return normalized;
  }
  return [];
}

function capabilityParameters(model: AiModelOption | null | undefined) {
  return record(model?.capabilities?.parameters);
}

function videoGenerationDirectory(model: AiModelOption | null | undefined): Record<string, unknown> | null {
  const directory = record(model?.capabilities?.videoGeneration);
  return directory.version === "workbench-video-generation/v1"
    && directory.dispatchable === true
    ? directory
    : null;
}

export function supportsCanvasCatalogVideoAudio(model: AiModelOption | null | undefined): boolean {
  return videoGenerationDirectory(model)?.supportsGenerateAudio === true;
}

export function normalizeCanvasCatalogVideoAudio(
  model: AiModelOption | null | undefined,
  enabled: boolean | undefined,
): boolean {
  return supportsCanvasCatalogVideoAudio(model) && enabled !== false;
}

export function getCanvasCatalogVideoModes(
  model: AiModelOption | null | undefined,
): CanvasCatalogVideoMode[] {
  const directory = videoGenerationDirectory(model);
  if (!directory || !Array.isArray(directory.operations)) return [];
  return directory.operations.flatMap((raw) => {
    const operation = record(raw);
    return operation.enabled === true ? firstStringList(operation.modes) : [];
  })
    .map((mode) => mode.toLowerCase().replace(/[\s-]+/g, "_"))
    .filter((mode): mode is CanvasCatalogVideoMode => VIDEO_MODE_SET.has(mode));
}

export function isCanvasCatalogVideoModeSupported(
  model: AiModelOption | null | undefined,
  mode: string,
): mode is CanvasCatalogVideoMode {
  return getCanvasCatalogVideoModes(model).includes(mode as CanvasCatalogVideoMode);
}

export function getCanvasCatalogModeInputLimit(
  model: AiModelOption | null | undefined,
  mode: CanvasCatalogVideoMode,
  kind: CanvasCatalogReferenceKind,
): CanvasCatalogInputLimit | null {
  const directory = videoGenerationDirectory(model);
  const rawSlots = directory?.inputSlots;
  if (!Array.isArray(rawSlots)) return null;
  let min = 0;
  let max = 0;
  let matched = false;
  for (const rawSlot of rawSlots) {
    const slot = record(rawSlot);
    const modes = firstStringList(slot.modes)
      .map((item) => item.toLowerCase().replace(/[\s-]+/g, "_"));
    if (modes.length > 0 && !modes.includes(mode)) continue;
    const expectedMediaType = kind === "file" ? "audio" : kind;
    const accepts = firstStringList(slot.mediaTypes)
      .map((item) => item.toLowerCase());
    if (!accepts.includes(expectedMediaType)) continue;
    const slotMin = Number(slot.min);
    const slotMax = Number(slot.max);
    if (
      !Number.isSafeInteger(slotMin)
      || !Number.isSafeInteger(slotMax)
      || slotMin < 0
      || slotMax < slotMin
    ) {
      return null;
    }
    matched = true;
    min += slotMin;
    max += slotMax;
  }
  return matched && max > 0 ? { min, max } : null;
}

export function getCanvasCatalogVideoOperation(
  model: AiModelOption | null | undefined,
  mode: CanvasCatalogVideoMode,
): CanvasCatalogVideoOperation | null {
  const directory = videoGenerationDirectory(model);
  if (!directory || !Array.isArray(directory.operations)) return null;
  for (const raw of directory.operations) {
    const operation = record(raw);
    if (operation.enabled !== true || !firstStringList(operation.modes).includes(mode)) continue;
    return ["generate", "extend", "edit"].includes(String(operation.operation))
      ? operation.operation as CanvasCatalogVideoOperation
      : null;
  }
  return null;
}

function normalizeVideoResolutionValue(value: unknown): string {
  const raw = String(value || "").trim().toUpperCase().replace(/\s+/g, "");
  if (!raw) return "";
  if (raw === "480" || raw === "480P") return "480P";
  if (raw === "960" || raw === "960P") return "960P";
  if (raw === "768" || raw === "768P") return "768P";
  if (raw === "720" || raw === "720P") return "720P";
  if (raw === "1080" || raw === "1080P" || raw === "FHD") return "1080P";
  if (raw === "1K") return "1K";
  if (raw === "2K" || raw === "1440" || raw === "1440P") return "2K";
  if (raw === "4K" || raw === "2160" || raw === "2160P") return "4K";
  return "";
}

/**
 * 480p/768p are provider-native exceptions, not public tiers. They are only
 * admitted for the exact MiniMax H3 model contracts; a generic catalog entry
 * cannot unlock them by copying the same resolution text.
 */
export function normalizeCanvasCatalogVideoResolution(
  modelId: unknown,
  value: unknown,
): string {
  const normalized = normalizeVideoResolutionValue(value);
  if (!normalized) return "";
  if (normalized === "480P" && import.meta.env.DEV
    && import.meta.env.VITE_FANJIN_DEV_ALLOW_NATIVE_480P === "1"
    && typeof window !== "undefined"
    && ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname)) return normalized;
  if (PUBLIC_VIDEO_RESOLUTIONS.has(normalized)) return normalized;
  const native = MINIMAX_H3_NATIVE_VIDEO_RESOLUTIONS[String(modelId || "").trim().toLowerCase()];
  return native?.has(normalized) || BYTEPLUS_NATIVE_VIDEO_RESOLUTIONS[String(modelId || "").trim().toLowerCase()]?.has(normalized)
    ? normalized : "";
}

export function getCanvasCatalogVideoResolutions(
  model: AiModelOption | null | undefined,
): string[] {
  const parameters = capabilityParameters(model);
  const resolution = record(parameters.resolution);
  return Array.from(new Set(
    firstStringList(
      model?.capabilities?.resolutions,
      resolution.options,
      resolution.values,
    )
      .map((value) => normalizeCanvasCatalogVideoResolution(model?.id, value))
      .filter(Boolean),
  ));
}

export function getCanvasCatalogVideoDefaultResolution(
  model: AiModelOption | null | undefined,
): string {
  const parameters = capabilityParameters(model);
  const resolution = record(parameters.resolution);
  return normalizeCanvasCatalogVideoResolution(
    model?.id,
    model?.capabilities?.defaultResolution ?? resolution.default ?? resolution.defaultValue,
  );
}

export function getCanvasCatalogVideoDuration(
  model: AiModelOption | null | undefined,
  mode: CanvasCatalogVideoMode,
): CanvasCatalogVideoDuration | null {
  const directory = videoGenerationDirectory(model);
  if (!directory || !Array.isArray(directory.operations)) return null;
  const rawOperation = directory.operations
    .map(record)
    .find((operation) => {
      if (operation.enabled !== true || !["generate", "extend", "edit"].includes(String(operation.operation))) return false;
      return firstStringList(operation.modes)
        .map((item) => item.toLowerCase().replace(/[\s-]+/g, "_"))
        .includes(mode);
    });
  if (!rawOperation) return null;
  const duration = record(rawOperation.duration);
  const min = Number(duration.min);
  const max = Number(duration.max);
  const step = Number(duration.step);
  const defaultValue = Number(duration.default);
  const rawAllowed = Array.isArray(duration.allowed) ? duration.allowed : [];
  const allowed = rawAllowed
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0);
  if (
    ![min, max, step, defaultValue].every(Number.isFinite)
    || min <= 0
    || max < min
    || step <= 0
    || (defaultValue < min && !(defaultValue === -1 && duration.auto === true))
    || defaultValue > max
    || (rawAllowed.length > 0 && allowed.length !== rawAllowed.length)
    || (allowed.length > 0 && (
      (defaultValue !== -1 && !allowed.includes(defaultValue))
      || allowed.some((value) => value < min || value > max)
    ))
    || (allowed.length === 0 && !supportsCatalogDuration(duration, defaultValue))
  ) return null;
  return {
    min,
    max,
    step,
    default: defaultValue,
    allowed: Array.from(new Set(allowed)).sort((left, right) => left - right),
    auto: duration.auto === true,
  };
}

export function normalizeCanvasCatalogVideoDuration(
  model: AiModelOption | null | undefined,
  mode: CanvasCatalogVideoMode,
  requested: unknown,
): number | null {
  const capability = getCanvasCatalogVideoDuration(model, mode);
  if (!capability) return null;
  return mode === "video_edit" ? -1 : resolveSelectedCanvasVideoDuration(model, mode, requested) ?? capability.default;
}

export function resolveSelectedCanvasVideoDuration(
  model: AiModelOption | null | undefined,
  mode: CanvasCatalogVideoMode,
  requested: unknown,
): number | null {
  const capability = getCanvasCatalogVideoDuration(model, mode);
  if (!capability) return null;
  const value = Number(requested);
  if (!Number.isFinite(value) || mode === "video_edit" && value !== -1) return null;
  const duration = {
    min: capability.min,
    max: capability.max,
    step: capability.step,
    allowed: capability.allowed,
    auto: capability.auto,
  };
  return supportsCatalogDuration(duration, value) ? value : null;
}

function supportsCatalogDuration(duration: Record<string, unknown>, requested: number): boolean {
  if (requested === -1) return duration.auto === true;
  const allowed = Array.isArray(duration.allowed)
    ? duration.allowed.map(Number).filter(Number.isFinite)
    : [];
  if (allowed.length > 0) return allowed.includes(requested);
  const min = Number(duration.min);
  const max = Number(duration.max);
  const step = Number(duration.step);
  if (![min, max, step].every(Number.isFinite) || step <= 0 || requested < min || requested > max) {
    return false;
  }
  const steps = (requested - min) / step;
  return Math.abs(steps - Math.round(steps)) < 1e-9;
}

export function getCanvasCatalogVideoEditCapability(
  model: AiModelOption | null | undefined,
  requestedDurationSeconds: number,
): CanvasCatalogVideoEditCapability | null {
  const directory = videoGenerationDirectory(model);
  if (
    !directory
    || directory.supportsTimeRange !== true
    || !Array.isArray(directory.operations)
  ) return null;
  const editOperation = directory.operations
    .map(record)
    .find((operation) => operation.operation === "edit" && operation.enabled === true);
  if (!editOperation) return null;
  const duration = record(editOperation.duration);
  const allowed = Array.isArray(duration.allowed)
    ? duration.allowed.map(Number).filter((value) => Number.isFinite(value) && value > 0)
    : [];
  const fallback = Number(duration.default) || allowed[0] || Number(duration.min);
  const durationSeconds = supportsCatalogDuration(duration, requestedDurationSeconds)
    ? requestedDurationSeconds
    : fallback;
  const resolutions = firstStringList(editOperation.resolutions)
    .map((resolution) => normalizeCanvasCatalogVideoResolution(model?.id, resolution))
    .filter(Boolean);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || resolutions.length === 0) return null;
  return {
    supportsTimeRange: true,
    supportsMask: directory.supportsMask === true,
    supportsPreserveSourceAudio: directory.supportsPreserveSourceAudio === true,
    durationSeconds,
    resolutions: Array.from(new Set(resolutions)),
  };
}

export function getCanvasCatalogVideoTotalInputLimit(
  model: AiModelOption | null | undefined,
): number {
  const value = Number(videoGenerationDirectory(model)?.totalInputLimit);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export type CanvasCatalogReferenceCounts = {
  image: number;
  video: number;
  file: number;
};

export function validateCanvasCatalogModeReferenceCounts(
  model: AiModelOption | null | undefined,
  mode: CanvasCatalogVideoMode,
  counts: CanvasCatalogReferenceCounts,
): { ok: true } | { ok: false; message: string } {
  if (!isCanvasCatalogVideoModeSupported(model, mode)) {
    return { ok: false, message: "所选模型目录未声明该生成模式" };
  }
  const entries = (["image", "video", "file"] as const).map((kind) => ({
    kind,
    count: counts[kind],
    limit: getCanvasCatalogModeInputLimit(model, mode, kind),
  }));
  if (entries.some(({ count }) => !Number.isSafeInteger(count) || count < 0)) {
    return { ok: false, message: "参考素材数量无效" };
  }
  const total = entries.reduce((sum, entry) => sum + entry.count, 0);
  const totalLimit = getCanvasCatalogVideoTotalInputLimit(model);
  if (total > totalLimit) {
    return { ok: false, message: `参考素材数量超限：当前 ${total} 个，最多支持 ${totalLimit} 个。请移除部分素材。` };
  }
  const labels: Record<CanvasCatalogReferenceKind, string> = {
    image: "图片",
    video: "视频",
    file: "音频",
  };
  for (const { kind, count, limit } of entries) {
    if (!limit) {
      if (count > 0) return { ok: false, message: `当前模式不接受${labels[kind]}参考素材` };
      continue;
    }
    if (count < limit.min || count > limit.max) {
      return {
        ok: false,
        message: count > limit.max ? `参考${labels[kind]}数量超限：当前 ${count} 个，最多支持 ${limit.max} 个。请移除部分素材。` : `参考${labels[kind]}不足：当前 ${count} 个，至少需要 ${limit.min} 个。请添加素材。`,
      };
    }
  }
  return { ok: true };
}

export function resolveCanvasCatalogVideoReferences(
  model: AiModelOption | null | undefined,
  mode: CanvasCatalogVideoMode,
  inputs: Array<ReferenceMediaInput & { assetVersionId: string; kind: CanvasCatalogReferenceKind }>,
): { ok: true; operation: CanvasCatalogVideoOperation; references: CanvasCatalogGenerationReference[] }
  | { ok: false; message: string } {
  if ((mode === "video_extension" || mode === "video_edit") && inputs.filter((input) => input.kind === "video").length !== 1) {
    return { ok: false, message: "延长或修改视频需要连接 1 段原片，请保留一段视频作为来源" };
  }
  if (mode === "video_edit" && inputs.some(input => input.kind === "video" && input.durationSeconds !== undefined
    && (input.durationSeconds < 4 || input.durationSeconds > 30))) {
    return { ok: false, message: "原生视频编辑需要 4–30 秒的完整原片" };
  }
  const requirementError = referenceRequirementError(model?.id || "", mode, inputs);
  if (requirementError) return { ok: false, message: requirementError };
  const directory = videoGenerationDirectory(model);
  const operation = getCanvasCatalogVideoOperation(model, mode);
  if (!directory || !operation || !Array.isArray(directory.inputSlots)) {
    return { ok: false, message: "视频模型目录未声明当前 operation 或输入槽" };
  }
  if (inputs.length > getCanvasCatalogVideoTotalInputLimit(model)) {
    return { ok: false, message: `参考素材数量超限：当前 ${inputs.length} 个，最多支持 ${getCanvasCatalogVideoTotalInputLimit(model)} 个。请移除部分素材。` };
  }
  const slots = directory.inputSlots.map(record).filter((slot) => {
    const modes = firstStringList(slot.modes);
    return modes.length === 0 || modes.includes(mode);
  });
  if (inputs.length > 0 && slots.length === 0) {
    return { ok: false, message: "当前 mode 没有目录声明的输入槽" };
  }
  const counts = new Map(slots.map((slot) => [String(slot.id), 0]));
  const seenBySlot = new Map(slots.map((slot) => [String(slot.id), new Set<string>()]));
  const references: CanvasCatalogGenerationReference[] = [];
  for (const input of inputs) {
    const assetVersionId = String(input.assetVersionId || "").trim();
    if (!assetVersionId) return { ok: false, message: "参考素材尚未完成受控资产上传" };
    const mediaType = input.kind === "file" ? "audio" : input.kind;
    const genericRoles = ["subject", "style", "storyboard"] as const;
    const preferredRoles: readonly CanvasCatalogGenerationReference["role"][] = mediaType !== "image"
      ? ["subject", "style"]
      : mode === "first_last_frame"
        ? [references.length === 0 ? "first_frame" : "last_frame"]
        : mode === "image_to_video"
          ? ["first_frame", ...genericRoles]
          : genericRoles;
    const compatible = slots.filter((slot) => (
      firstStringList(slot.mediaTypes).includes(mediaType)
      && preferredRoles.some((role) => firstStringList(slot.roles).includes(role))
      && Number(counts.get(String(slot.id)) || 0) < Number(slot.max)
      && (
        slot.allowDuplicateAsset === true
        || !seenBySlot.get(String(slot.id))?.has(assetVersionId)
      )
    )).sort((left, right) => (
      Number(counts.get(String(left.id)) || 0) < Number(left.min) ? -1 : 1
    ) - (
      Number(counts.get(String(right.id)) || 0) < Number(right.min) ? -1 : 1
    ));
    const slot = compatible[0];
    if (!slot) {
      const duplicate = slots.some((candidate) => (
        firstStringList(candidate.mediaTypes).includes(mediaType)
        && candidate.allowDuplicateAsset !== true
        && seenBySlot.get(String(candidate.id))?.has(assetVersionId)
      ));
      return duplicate
        ? { ok: false, message: "同一素材已添加，请勿重复引用" }
        : { ok: false, message: `当前模式不支持该${input.kind === "image" ? "图片" : input.kind === "video" ? "视频" : "音频"}参考或数量已满，请调整素材后继续` };
    }
    const roles = firstStringList(slot.roles);
    const role = preferredRoles.find((candidate) => roles.includes(candidate));
    if (!role) return { ok: false, message: "视频输入槽缺少可识别的角色" };
    counts.set(String(slot.id), Number(counts.get(String(slot.id)) || 0) + 1);
    seenBySlot.get(String(slot.id))?.add(assetVersionId);
    references.push({
      assetVersionId,
      role,
      mediaType,
      order: references.length,
    });
  }
  for (const slot of slots) {
    if (Number(counts.get(String(slot.id)) || 0) < Number(slot.min)) {
      return { ok: false, message: `${firstString(slot.label, slot.id)} 参考素材不足` };
    }
  }
  return { ok: true, operation, references };
}

export function getCanvasCatalogAspectRatios(
  model: AiModelOption | null | undefined,
): string[] {
  const parameters = capabilityParameters(model);
  const aspectRatio = record(parameters.aspectRatio ?? parameters.ratio);
  return firstStringList(
    model?.capabilities?.aspectRatios,
    aspectRatio.options,
    aspectRatio.values,
  ).filter((ratio) => CONCRETE_ASPECT_RATIO.test(ratio)
    || (model?.id === BYTEPLUS_SEEDANCE_25_MODEL_ID && ratio === "adaptive"));
}

export function getCanvasCatalogVideoOutputFormats(model: AiModelOption | null | undefined): VideoOutputFormat[] {
  return normalizeVideoOutputFormats(videoGenerationDirectory(model)?.outputFormats);
}

export function hasCanvasCatalogVideoOutputFormats(model: AiModelOption | null | undefined): boolean {
  return hasDeclaredVideoOutputFormats(videoGenerationDirectory(model)?.outputFormats);
}

export function getCanvasCatalogVideoDefaultOutputFormat(model: AiModelOption | null | undefined): VideoOutputFormat {
  const directory = videoGenerationDirectory(model);
  return normalizeDefaultVideoOutputFormat(directory?.defaultOutputFormat, getCanvasCatalogVideoOutputFormats(model));
}

export function resolveSelectedCanvasAspectRatio(
  model: AiModelOption | null | undefined,
  requested: unknown,
): string {
  const normalized = String(requested || "").trim();
  return getCanvasCatalogAspectRatios(model).includes(normalized) ? normalized : "";
}

export function normalizeCanvasAspectRatioForModel(
  model: AiModelOption | null | undefined,
  requested: unknown,
): string {
  const ratios = getCanvasCatalogAspectRatios(model);
  const selected = resolveSelectedCanvasAspectRatio(model, requested);
  if (selected) return selected;
  const parameters = capabilityParameters(model);
  const aspectRatio = record(parameters.aspectRatio ?? parameters.ratio);
  const configuredDefault = firstString(
    model?.capabilities?.defaultAspectRatio,
    aspectRatio.default,
    aspectRatio.defaultValue,
  );
  return ratios.includes(configuredDefault) ? configuredDefault : ratios[0] || "";
}

function normalizeImageQuality(value: unknown): CanvasCatalogImageQuality | "" {
  const normalized = String(value || "").trim().toUpperCase().replace(/\s+/g, "");
  return IMAGE_QUALITY_SET.has(normalized)
    ? normalized as CanvasCatalogImageQuality
    : "";
}

export function getCanvasCatalogImageQualities(
  model: AiModelOption | null | undefined,
): CanvasCatalogImageQuality[] {
  const parameters = capabilityParameters(model);
  const quality = record(parameters.quality);
  return firstStringList(
    model?.capabilities?.qualities,
    quality.options,
    quality.values,
  )
    .map(normalizeImageQuality)
    .filter((value): value is CanvasCatalogImageQuality => Boolean(value));
}

export function resolveSelectedCanvasImageQuality(
  model: AiModelOption | null | undefined,
  requested: unknown,
): CanvasCatalogImageQuality | "" {
  const normalized = normalizeImageQuality(requested);
  return getCanvasCatalogImageQualities(model).includes(normalized as CanvasCatalogImageQuality)
    ? normalized
    : "";
}

export function normalizeCanvasImageQualityForModel(
  model: AiModelOption | null | undefined,
  requested: unknown,
): CanvasCatalogImageQuality | "" {
  const qualities = getCanvasCatalogImageQualities(model);
  const selected = resolveSelectedCanvasImageQuality(model, requested);
  if (selected) return selected;
  const parameters = capabilityParameters(model);
  const quality = record(parameters.quality);
  const configuredDefault = normalizeImageQuality(
    model?.capabilities?.defaultQuality ?? quality.default ?? quality.defaultValue,
  );
  return configuredDefault && qualities.includes(configuredDefault)
    ? configuredDefault
    : qualities[0] || "";
}
