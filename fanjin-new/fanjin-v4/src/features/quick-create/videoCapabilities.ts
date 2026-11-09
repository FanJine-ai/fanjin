import type { GenerationReference, ReferenceRole } from "./contracts";
import { BYTEPLUS_SEEDANCE_25_MODEL_ID, hasDeclaredVideoOutputFormats, normalizeDefaultVideoOutputFormat, normalizeVideoOutputFormats, requiredVideoDuration, requiredVideoRatio, type VideoOutputFormat } from "./videoOutputContract";

export type VideoAttachmentKind = "image" | "video" | "file";
export type ImageQuality = "1K" | "2K" | "4K";
export type NormalizedCapabilityStatus = "verified" | "configured" | "legacy" | "unverified";

export type ImageModelOption = {
  id: string;
  label: string;
  description?: string;
  capabilityStatus?: string | null;
  canSubmit?: boolean;
  qualities?: string[];
  resolutions?: string[];
  defaultQuality?: string;
  defaultResolution?: string;
  aspectRatios?: string[];
  defaultAspectRatio?: string;
  unavailableReason?: string;
};

export type VideoDurationCapability = {
  auto?: boolean;
  min?: number;
  max?: number;
  step?: number;
  default?: number;
  allowed?: number[];
};

export type VideoModeContract = string | {
  id?: string;
  value?: string;
  mode?: string;
  label?: string;
};

export type VideoInputSlotContract = {
  id?: string;
  role?: string;
  label?: string;
  type?: string;
  mediaType?: string;
  accepts?: string[];
  accept?: string[] | string;
  roles?: string[];
  referenceRoles?: string[];
  acceptedRoles?: string[];
  min?: number;
  max?: number;
  required?: boolean;
  modes?: string[];
};

/**
 * Compatible with both the legacy modelOptions response and the capability-rich
 * response. Status-less entries are fail-closed here; only
 * adaptModelOptionsResponse may explicitly mark a recognized old response as
 * legacy before normalization.
 */
export type VideoModelOption = {
  id: string;
  label: string;
  description?: string;
  capabilityStatus?: string;
  canSubmit?: boolean;
  modes?: VideoModeContract[];
  duration?: VideoDurationCapability;
  aspectRatios?: string[];
  defaultAspectRatio?: string;
  resolutions?: string[];
  defaultResolution?: string;
  outputFormats?: VideoOutputFormat[];
  defaultOutputFormat?: VideoOutputFormat;
  videoGeneration?: { outputFormats?: VideoOutputFormat[]; defaultOutputFormat?: VideoOutputFormat };
  supportsGenerateAudio?: boolean;
  inputSlots?: VideoInputSlotContract[];
};

export type ModelOptions = {
  llmModels: Array<{ id: string; label: string; description: string }>;
  videoModels: VideoModelOption[];
  imageModels?: ImageModelOption[];
  catalogVersion?: string | number;
  models?: unknown[];
};

export type NormalizedImageCapability = {
  id: string;
  label: string;
  description?: string;
  capabilityStatus: NormalizedCapabilityStatus;
  canSubmit: boolean;
  qualities: ImageQuality[];
  defaultQuality: ImageQuality;
  aspectRatios: string[];
  defaultAspectRatio: string;
  unavailableReason?: string;
};

export type ImageSettings = {
  model: string;
  quality: ImageQuality;
};

export type NormalizedVideoMode = {
  id: string;
  label: string;
};

export type NormalizedVideoInputSlot = {
  id: string;
  label: string;
  accepts: VideoAttachmentKind[];
  roles: ReferenceRole[];
  min: number;
  max: number;
  modes: string[];
};

export type NormalizedVideoCapability = {
  id: string;
  label: string;
  description?: string;
  capabilityStatus: NormalizedCapabilityStatus;
  canSubmit: boolean;
  modes: NormalizedVideoMode[];
  duration: Required<Omit<VideoDurationCapability, "allowed">> & { allowed: number[] };
  aspectRatios: string[];
  defaultAspectRatio: string;
  resolutions: string[];
  defaultResolution: string;
  outputFormats: VideoOutputFormat[];
  defaultOutputFormat: VideoOutputFormat;
  outputFormatsDeclared: boolean;
  supportsGenerateAudio: boolean;
  inputSlots: NormalizedVideoInputSlot[];
};

export type VideoSettings = {
  model: string;
  resolution: string;
  audio: boolean;
  duration: number;
  mode: string;
  outputFormat?: VideoOutputFormat;
};

export type VideoAttachmentLike = {
  id: string;
  kind: VideoAttachmentKind;
};

export type VideoInputAllocation<T extends VideoAttachmentLike = VideoAttachmentLike> = {
  counts: Record<string, number>;
  assignments: Array<{
    attachment: T;
    slotId: string;
    role: ReferenceRole;
  }>;
  unassigned: T[];
};

// Missing catalog metadata may only fall back to the two legacy public tiers.
// 2K/4K are exposed only when the server explicitly advertises them. Provider-
// native 480p/768p are accepted only for the exact MiniMax H3 models whose
// verified capability contracts declare those tiers.
const SAFE_VIDEO_RESOLUTION_FALLBACK = ["720p", "1080p"];
const PUBLIC_VIDEO_RESOLUTIONS = new Set(
  SAFE_VIDEO_RESOLUTION_FALLBACK.concat(["2k", "4k"]),
);
const MINIMAX_H3_NATIVE_VIDEO_RESOLUTIONS: Record<string, ReadonlySet<string>> = {
  "minimax-h3-fanjin-cinema": new Set(["480p", "768p", "960p"]),
  "minimax-h3-fanjin": new Set(["768p"]),
  "minimax-h3": new Set(["768p"]),
  "minimax-h3-max": new Set(["480p", "768p"]),
};
const BYTEPLUS_NATIVE_VIDEO_RESOLUTIONS: Record<string, ReadonlySet<string>> = {
  [BYTEPLUS_SEEDANCE_25_MODEL_ID]: new Set(["480p"]),
};
const LEGACY_ASPECT_RATIOS = ["16:9", "9:16", "1:1", "4:3"];
const LEGACY_IMAGE_QUALITIES: ImageQuality[] = ["1K", "2K", "4K"];
const LEGACY_IMAGE_ASPECT_RATIOS = ["16:9", "9:16", "1:1", "4:3"];
const VERIFIED_STATUS_VALUES = new Set(["verified", "supported", "ready", "active", "production"]);
const SUBMITTABLE_CAPABILITY_STATUSES = new Set<NormalizedCapabilityStatus>([
  "verified",
  "configured",
  "legacy",
]);

const MODE_LABELS: Record<string, string> = {
  text_to_video: "文生视频",
  image_to_video: "图生视频",
  first_last_frame: "首尾帧",
  omni_reference: "全能参考",
  image_reference: "图片参考",
  video_extension: "视频续写",
  video_edit: "视频编辑",
};

function finiteNumber(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function uniqueStrings(value: unknown, fallback: string[]) {
  if (!Array.isArray(value)) return [...fallback];
  const normalized = value.map((item) => String(item || "").trim()).filter(Boolean);
  return normalized.length ? Array.from(new Set(normalized)) : [...fallback];
}

function hasOwn(value: object, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizePublicVideoResolution(value: unknown, modelId?: unknown): string | null {
  const normalized = String(value || "").trim().toLowerCase().replace(/\s+/g, "");
  const canonical = normalized === "720" ? "720p"
    : normalized === "960" ? "960p"
    : normalized === "768" ? "768p"
    : normalized === "1080" ? "1080p"
      : normalized;
  if (PUBLIC_VIDEO_RESOLUTIONS.has(canonical)) return canonical;
  const modelResolutions = MINIMAX_H3_NATIVE_VIDEO_RESOLUTIONS[
    String(modelId || "").trim().toLowerCase()
  ];
  return modelResolutions?.has(canonical) || BYTEPLUS_NATIVE_VIDEO_RESOLUTIONS[String(modelId || "").trim().toLowerCase()]?.has(canonical)
    ? canonical : null;
}

function declaredPublicVideoResolutions(value: unknown, modelId?: unknown): {
  resolutions: string[];
  complete: boolean;
} {
  if (!Array.isArray(value) || value.length === 0) {
    return { resolutions: [], complete: false };
  }
  const normalized = value.map((item) => normalizePublicVideoResolution(item, modelId));
  const resolutions = Array.from(new Set(
    normalized.filter((item): item is string => Boolean(item)),
  ));
  return {
    resolutions,
    complete: resolutions.length > 0 && normalized.every(Boolean),
  };
}

function hasCompleteStringList(value: unknown, normalized: string[]) {
  return Array.isArray(value)
    && value.length > 0
    && normalized.length > 0
    && value.every((item) => typeof item === "string" && Boolean(item.trim()));
}

function normalizeCapabilityStatus(value: unknown): NormalizedCapabilityStatus {
  if (value === undefined) return "unverified";
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return "unverified";
  if (normalized === "legacy") return "legacy";
  if (normalized === "configured") return "configured";
  return VERIFIED_STATUS_VALUES.has(normalized) ? "verified" : "unverified";
}

/**
 * Only the pre-catalog response shape may opt status-less video entries into
 * legacy compatibility. Once a response exposes any catalog marker, every
 * model must carry an explicit, recognized status and normalizers fail closed.
 */
export function adaptModelOptionsResponse(response: Partial<ModelOptions> | null | undefined): ModelOptions {
  const source = response && typeof response === "object" ? response : {};
  const hasOwn = (key: string) => Object.prototype.hasOwnProperty.call(source, key);
  const isLegacyResponse = !hasOwn("catalogVersion") && !hasOwn("models") && !hasOwn("imageModels");
  const videoModels = Array.isArray(source.videoModels) ? source.videoModels : [];
  return {
    llmModels: Array.isArray(source.llmModels) ? source.llmModels : [],
    imageModels: Array.isArray(source.imageModels) ? source.imageModels : [],
    videoModels: videoModels.map((model) => (
      isLegacyResponse && model?.capabilityStatus === undefined
        ? { ...model, capabilityStatus: "legacy" }
        : model
    )),
    ...(source.catalogVersion !== undefined ? { catalogVersion: source.catalogVersion } : {}),
    ...(Array.isArray(source.models) ? { models: source.models } : {}),
  };
}

function videoModeId(item: unknown) {
  const source = item && typeof item === "object" ? item as Record<string, unknown> : null;
  return String(source
    ? source.id || source.value || source.mode || ""
    : item || "").trim();
}

function normalizeModes(value: unknown): NormalizedVideoMode[] {
  if (!Array.isArray(value) || !value.length) return [];
  const byId = new Map<string, NormalizedVideoMode>();
  value.forEach((item) => {
    const source = item && typeof item === "object" ? item as Record<string, unknown> : null;
    const id = videoModeId(item);
    if (!id || byId.has(id)) return;
    byId.set(id, {
      id,
      label: String(source?.label || MODE_LABELS[id] || id),
    });
  });
  return Array.from(byId.values());
}

function modeContractComplete(value: unknown, modes: NormalizedVideoMode[]) {
  if (!Array.isArray(value) || value.length === 0) return false;
  const ids = value.map(videoModeId);
  return ids.every(Boolean) && new Set(ids).size === modes.length;
}

function normalizeAcceptKind(value: string): VideoAttachmentKind | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "image" || normalized.startsWith("image/")) return "image";
  if (normalized === "video" || normalized.startsWith("video/")) return "video";
  if (normalized === "file" || normalized === "document" || normalized === "application/*") return "file";
  return null;
}

const REFERENCE_ROLES = new Set<ReferenceRole>([
  "subject",
  "style",
  "storyboard",
  "first_frame",
  "last_frame",
]);

function normalizeReferenceRoles(value: unknown): ReferenceRole[] {
  const normalized = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (REFERENCE_ROLES.has(normalized as ReferenceRole)) return [normalized as ReferenceRole];
  if (["firstframe", "start_frame", "startframe", "first_frame_image"].includes(normalized)) {
    return ["first_frame"];
  }
  if (["lastframe", "end_frame", "endframe", "tail_frame", "last_frame_image"].includes(normalized)) {
    return ["last_frame"];
  }
  if (["character", "character_reference", "subject_reference"].includes(normalized)) return ["subject"];
  if (normalized === "style_reference") return ["style"];
  if (normalized === "storyboard_reference") return ["storyboard"];
  if ([
    "reference",
    "references",
    "reference_media",
    "media_reference",
    "reference_image",
    "image_reference",
    "reference_video",
    "video_reference",
  ].includes(normalized)) {
    return ["subject", "style", "storyboard"];
  }
  return [];
}

function inferSlotAccepts(slot: VideoInputSlotContract): VideoAttachmentKind[] {
  const rawAccepts = Array.isArray(slot.accepts)
    ? slot.accepts
    : Array.isArray(slot.accept)
      ? slot.accept
      : typeof slot.accept === "string"
        ? slot.accept.split(",")
        : [];
  const explicit = rawAccepts.map(normalizeAcceptKind).filter((item): item is VideoAttachmentKind => Boolean(item));
  if (explicit.length) return Array.from(new Set(explicit));

  const hint = `${slot.mediaType || ""} ${slot.type || ""} ${slot.role || ""} ${slot.id || ""}`.toLowerCase();
  if (/image|frame|图片|首帧|尾帧/.test(hint)) return ["image"];
  if (/video|视频/.test(hint)) return ["video"];
  if (/audio|音频/.test(hint)) return ["file"];
  return ["image", "video", "file"];
}

function normalizeInputSlots(value: unknown): NormalizedVideoInputSlot[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw, index) => {
    if (!raw || typeof raw !== "object") return [];
    const slot = raw as VideoInputSlotContract;
    const id = String(slot.id || slot.role || `reference-${index + 1}`).trim();
    if (!id) return [];
    const rawRoles = Array.isArray(slot.roles)
      ? slot.roles
      : Array.isArray(slot.referenceRoles)
        ? slot.referenceRoles
        : Array.isArray(slot.acceptedRoles)
          ? slot.acceptedRoles
          : [slot.role || slot.id];
    const roles = Array.from(new Set(rawRoles.flatMap(normalizeReferenceRoles)));
    if (!roles.length) return [];
    const minimum = Math.max(0, Math.floor(finiteNumber(slot.min, slot.required ? 1 : 0)));
    const maximum = Math.max(minimum || 1, Math.floor(finiteNumber(slot.max, Math.max(minimum, 1))));
    return [{
      id,
      label: String(slot.label || MODE_LABELS[id] || slot.role || `参考素材 ${index + 1}`),
      accepts: inferSlotAccepts(slot),
      roles,
      min: minimum,
      max: maximum,
      modes: uniqueStrings(slot.modes, []),
    }];
  });
}

function normalizeDuration(value: VideoDurationCapability | undefined) {
  const allowed = Array.isArray(value?.allowed)
    ? Array.from(new Set(value.allowed.map(Number).filter((item) => Number.isFinite(item) && item > 0))).sort((a, b) => a - b)
    : [];
  const minimum = Math.max(1, finiteNumber(value?.min, allowed[0] || 1));
  const maximum = Math.max(minimum, finiteNumber(value?.max, allowed.at(-1) || 15));
  const step = Math.max(0.1, finiteNumber(value?.step, 1));
  const configuredDefault = finiteNumber(value?.default, allowed[0] || 5);
  const defaultValue = value?.auto === true && configuredDefault === -1 ? -1 : allowed.length
    ? allowed.includes(configuredDefault) ? configuredDefault : allowed[0]
    : Math.min(maximum, Math.max(minimum, configuredDefault));
  return { min: minimum, max: maximum, step, default: defaultValue, allowed, auto: value?.auto === true };
}

function durationContractComplete(value: VideoDurationCapability | undefined) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const minimum = Number(value.min);
  const maximum = Number(value.max);
  const step = Number(value.step);
  const defaultValue = Number(value.default);
  if (
    !Number.isFinite(minimum)
    || !Number.isFinite(maximum)
    || !Number.isFinite(step)
    || !Number.isFinite(defaultValue)
    || minimum <= 0
    || maximum < minimum
    || step <= 0
    || (defaultValue < minimum && !(defaultValue === -1 && value.auto === true))
    || defaultValue > maximum
  ) return false;
  if (hasOwn(value, "allowed")) {
    if (!Array.isArray(value.allowed) || value.allowed.length === 0) return false;
    const allowed = value.allowed.map(Number);
    if (
      allowed.some((item) => !Number.isFinite(item) || item <= 0 || item < minimum || item > maximum)
      || (defaultValue !== -1 && !allowed.includes(defaultValue))
    ) return false;
  } else {
    if (defaultValue !== -1) {
      const steps = (defaultValue - minimum) / step;
      if (Math.abs(steps - Math.round(steps)) > 1e-9) return false;
    }
  }
  return true;
}

function normalizeImageQualities(model: ImageModelOption): ImageQuality[] {
  const configured = uniqueStrings(model.qualities, []);
  const values = configured.length ? configured : uniqueStrings(model.resolutions, []);
  return Array.from(new Set(values
    .map((value) => value.toUpperCase())
    .filter((value): value is ImageQuality => value === "1K" || value === "2K" || value === "4K")));
}

function normalizeAspectRatios(value: unknown) {
  return uniqueStrings(value, []).filter((ratio) => /^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(ratio));
}

export function normalizeImageModelOption(model: ImageModelOption): NormalizedImageCapability {
  const declaredStatus = normalizeCapabilityStatus(model.capabilityStatus);
  const configuredQualities = normalizeImageQualities(model);
  const configuredAspectRatios = normalizeAspectRatios(model.aspectRatios);
  const rawQualities = Array.isArray(model.qualities)
    ? model.qualities
    : Array.isArray(model.resolutions)
      ? model.resolutions
      : null;
  const rawAspectRatios = Array.isArray(model.aspectRatios) ? model.aspectRatios : null;
  const configuredDefaultQuality = String(
    model.defaultQuality || model.defaultResolution || "",
  ).toUpperCase() as ImageQuality;
  const configuredDefaultAspectRatio = String(model.defaultAspectRatio || "");
  const contractComplete = Boolean(
    rawQualities
    && rawQualities.length > 0
    && rawQualities.every((value) => (
      typeof value === "string"
      && ["1K", "2K", "4K"].includes(value.trim().toUpperCase())
    ))
    && configuredQualities.length > 0
    && configuredQualities.includes(configuredDefaultQuality)
    && rawAspectRatios
    && hasCompleteStringList(rawAspectRatios, configuredAspectRatios)
    && configuredAspectRatios.length === new Set(rawAspectRatios).size
    && configuredAspectRatios.includes(configuredDefaultAspectRatio)
  );
  const capabilityStatus: NormalizedCapabilityStatus = contractComplete
    ? declaredStatus
    : "unverified";
  const qualities = configuredQualities.length ? configuredQualities : [...LEGACY_IMAGE_QUALITIES];
  const defaultQuality = qualities.includes(configuredDefaultQuality)
    ? configuredDefaultQuality
    : qualities.includes("2K")
      ? "2K"
      : qualities[0];
  const aspectRatios = configuredAspectRatios.length
    ? configuredAspectRatios
    : [...LEGACY_IMAGE_ASPECT_RATIOS];
  const defaultAspectRatio = aspectRatios.includes(configuredDefaultAspectRatio)
    ? configuredDefaultAspectRatio
    : aspectRatios[0];
  return {
    id: String(model.id || "").trim(),
    label: String(model.label || model.id || "未命名图片模型"),
    description: model.description,
    capabilityStatus,
    canSubmit: model.canSubmit === true
      && contractComplete
      && SUBMITTABLE_CAPABILITY_STATUSES.has(declaredStatus),
    qualities,
    defaultQuality,
    aspectRatios,
    defaultAspectRatio,
    unavailableReason: model.unavailableReason,
  };
}

export function normalizeImageModelOptions(models: ImageModelOption[] | undefined | null) {
  if (!Array.isArray(models)) return [];
  return models.filter((model) => Boolean(model?.id)).map(normalizeImageModelOption);
}

export function reconcileImageSettings(
  current: ImageSettings,
  capability: NormalizedImageCapability,
  options: { resetModelDefaults?: boolean } = {},
): ImageSettings {
  const reset = options.resetModelDefaults === true || current.model !== capability.id;
  return {
    model: capability.id,
    quality: !reset && capability.qualities.includes(current.quality)
      ? current.quality
      : capability.defaultQuality,
  };
}

export function reconcileImageAspectRatio(current: string, capability: NormalizedImageCapability) {
  return capability.aspectRatios.includes(current) ? current : capability.defaultAspectRatio;
}

export function validateImageConfiguration(input: {
  capability: NormalizedImageCapability;
  settings: ImageSettings;
  aspectRatio: string;
}) {
  const { capability, settings, aspectRatio } = input;
  const errors: string[] = [];
  if (!capability.canSubmit) {
    errors.push(capability.unavailableReason || "该图片模型的能力配置缺失或尚未验证，暂不能提交生成");
  }
  if (settings.model !== capability.id) errors.push("当前图片模型不在可用目录中");
  if (!capability.qualities.includes(settings.quality)) errors.push("当前图片清晰度不受该模型支持");
  if (!capability.aspectRatios.includes(aspectRatio)) errors.push("当前画面比例不受该图片模型支持");
  return errors;
}

export function normalizeVideoModelOption(model: VideoModelOption): NormalizedVideoCapability {
  const declaredStatus = normalizeCapabilityStatus(model.capabilityStatus);
  const declaredResolutions = declaredPublicVideoResolutions(model.resolutions, model.id);
  const resolutions = declaredResolutions.resolutions.length
    ? declaredResolutions.resolutions
    : [...SAFE_VIDEO_RESOLUTION_FALLBACK];
  const configuredDefaultResolution = normalizePublicVideoResolution(model.defaultResolution, model.id);
  const defaultResolution = configuredDefaultResolution
    && resolutions.includes(configuredDefaultResolution)
    ? configuredDefaultResolution
    : resolutions[0];
  const configuredAspectRatios = uniqueStrings(model.aspectRatios, []).filter((ratio) =>
    normalizeAspectRatios([ratio]).length > 0 || model.id === BYTEPLUS_SEEDANCE_25_MODEL_ID && ratio === "adaptive");
  const rawAspectRatios = Array.isArray(model.aspectRatios) ? model.aspectRatios : null;
  const safeAspectRatios = configuredAspectRatios.length
    ? configuredAspectRatios
    : [...LEGACY_ASPECT_RATIOS];
  const configuredDefaultAspectRatio = String(model.defaultAspectRatio || "");
  const defaultAspectRatio = safeAspectRatios.includes(configuredDefaultAspectRatio)
    ? configuredDefaultAspectRatio
    : safeAspectRatios[0];
  const modes = normalizeModes(model.modes);
  const inputSlots = normalizeInputSlots(model.inputSlots);
  const outputFormats = normalizeVideoOutputFormats(model.videoGeneration?.outputFormats ?? model.outputFormats);
  const defaultOutputFormat = normalizeDefaultVideoOutputFormat(model.videoGeneration?.defaultOutputFormat ?? model.defaultOutputFormat, outputFormats);
  const contractComplete = Boolean(
    String(model.id || "").trim()
    && declaredResolutions.complete
    && configuredDefaultResolution
    && declaredResolutions.resolutions.includes(configuredDefaultResolution)
    && rawAspectRatios
    && hasCompleteStringList(rawAspectRatios, configuredAspectRatios)
    && configuredAspectRatios.length === new Set(rawAspectRatios).size
    && configuredAspectRatios.includes(configuredDefaultAspectRatio)
    && durationContractComplete(model.duration)
    && modeContractComplete(model.modes, modes)
    && Array.isArray(model.inputSlots)
    && inputSlots.length === model.inputSlots.length
    && typeof model.supportsGenerateAudio === "boolean"
  );
  const capabilityStatus: NormalizedCapabilityStatus = contractComplete
    ? declaredStatus
    : "unverified";
  return {
    id: String(model.id || "").trim(),
    label: String(model.label || model.id || "未命名视频模型"),
    description: model.description,
    capabilityStatus,
    canSubmit: model.canSubmit === true
      && contractComplete
      && SUBMITTABLE_CAPABILITY_STATUSES.has(declaredStatus),
    modes,
    duration: normalizeDuration(model.duration),
    aspectRatios: safeAspectRatios,
    defaultAspectRatio,
    resolutions,
    defaultResolution,
    outputFormats,
    defaultOutputFormat,
    outputFormatsDeclared: hasDeclaredVideoOutputFormats(model.videoGeneration?.outputFormats ?? model.outputFormats),
    supportsGenerateAudio: model.supportsGenerateAudio === true,
    inputSlots,
  };
}

export function normalizeVideoModelOptions(models: VideoModelOption[]) {
  return models.filter((model) => Boolean(model?.id)).map(normalizeVideoModelOption);
}

export function normalizeVideoDuration(value: number, capability: NormalizedVideoCapability) {
  if (value === -1 && capability.duration.auto) return -1;
  const { allowed, min, max, step, default: defaultValue } = capability.duration;
  if (allowed.length) return allowed.includes(value) ? value : defaultValue;
  if (!Number.isFinite(value)) return defaultValue;
  const clamped = Math.min(max, Math.max(min, value));
  const stepped = min + Math.round((clamped - min) / step) * step;
  return Number(Math.min(max, Math.max(min, stepped)).toFixed(3));
}

export function reconcileVideoSettings(
  current: VideoSettings,
  capability: NormalizedVideoCapability,
  options: { resetModelDefaults?: boolean } = {},
): VideoSettings {
  const reset = options.resetModelDefaults === true || current.model !== capability.id;
  const mode = !reset && capability.modes.some((item) => item.id === current.mode)
    ? current.mode
    : capability.modes[0].id;
  const resolution = !reset && capability.resolutions.includes(current.resolution)
    ? current.resolution
    : capability.defaultResolution;
  const duration = requiredVideoDuration(capability.id, mode) ?? (reset
    ? capability.duration.default
    : normalizeVideoDuration(current.duration, capability));
  return {
    model: capability.id,
    mode,
    resolution,
    duration,
    audio: capability.supportsGenerateAudio ? (!reset && current.audio) : false,
    outputFormat: !reset && current.outputFormat && capability.outputFormats.includes(current.outputFormat)
      ? current.outputFormat : capability.defaultOutputFormat,
  };
}

export function reconcileVideoAspectRatio(current: string, capability: NormalizedVideoCapability) {
  return capability.aspectRatios.includes(current) ? current : capability.defaultAspectRatio;
}

export function activeVideoInputSlots(capability: NormalizedVideoCapability, mode: string) {
  return capability.inputSlots.filter((slot) => !slot.modes.length || slot.modes.includes(mode));
}

function preferredReferenceRole(slot: NormalizedVideoInputSlot): ReferenceRole {
  if (slot.roles.includes("first_frame")) return "first_frame";
  if (slot.roles.includes("last_frame")) return "last_frame";
  if (slot.roles.includes("subject")) return "subject";
  return slot.roles[0];
}

export function allocateVideoAttachments<T extends VideoAttachmentLike>(
  capability: NormalizedVideoCapability,
  mode: string,
  attachments: T[],
): VideoInputAllocation<T> {
  const slots = activeVideoInputSlots(capability, mode);
  const counts = Object.fromEntries(slots.map((slot) => [slot.id, 0]));
  const assignments: VideoInputAllocation<T>["assignments"] = [];
  const unassigned: T[] = [];

  attachments.forEach((attachment) => {
    const slot = slots
      .filter((candidate) => (
        candidate.accepts.includes(attachment.kind) && counts[candidate.id] < candidate.max
      ))
      .sort((left, right) => {
        const leftNeedsMinimum = counts[left.id] < left.min ? 0 : 1;
        const rightNeedsMinimum = counts[right.id] < right.min ? 0 : 1;
        return leftNeedsMinimum - rightNeedsMinimum
          || left.roles.length - right.roles.length
          || left.accepts.length - right.accepts.length
          || left.max - right.max;
      })[0];
    if (!slot) {
      unassigned.push(attachment);
      return;
    }
    counts[slot.id] += 1;
    assignments.push({
      attachment,
      slotId: slot.id,
      role: preferredReferenceRole(slot),
    });
  });
  return { counts, assignments, unassigned };
}

export function resolveVideoGenerationReferences(
  capability: NormalizedVideoCapability,
  mode: string,
  attachments: Array<VideoAttachmentLike & { assetVersionId?: string }>,
): { ok: true; references: GenerationReference[] } | { ok: false; message: string } {
  const allocation = allocateVideoAttachments(capability, mode, attachments);
  if (allocation.unassigned.length) {
    return { ok: false, message: "有参考素材不符合当前视频模式的输入槽要求" };
  }
  const missing = allocation.assignments.find(({ attachment }) => !String(attachment.assetVersionId || "").trim());
  if (missing) return { ok: false, message: `参考素材尚未上传：${missing.attachment.id}` };
  const slots = activeVideoInputSlots(capability, mode);
  for (const slot of slots) {
    if ((allocation.counts[slot.id] || 0) < slot.min) {
      return { ok: false, message: `${slot.label}至少需要 ${slot.min} 个素材` };
    }
  }
  return {
    ok: true,
    references: allocation.assignments.map(({ attachment, role }) => ({
      assetVersionId: String(attachment.assetVersionId).trim(),
      role,
    })),
  };
}

export function validateVideoPreferenceConfiguration(input: {
  capability: NormalizedVideoCapability;
  settings: VideoSettings;
  aspectRatio: string;
}) {
  const { capability, settings, aspectRatio } = input;
  const errors: string[] = [];
  if (!capability.canSubmit) errors.push("该模型的能力配置尚未验证，暂不能提交生成");
  if (!capability.modes.some((mode) => mode.id === settings.mode)) errors.push("当前生成模式不受该模型支持");
  if (!capability.resolutions.includes(settings.resolution)) errors.push("当前清晰度不受该模型支持");
  if (!capability.aspectRatios.includes(aspectRatio)) errors.push("当前画面比例不受该模型支持");
  if (requiredVideoRatio(capability.id, settings.mode) && aspectRatio !== "adaptive") errors.push("当前模式须跟随参考素材比例");
  if (normalizeVideoDuration(settings.duration, capability) !== settings.duration) errors.push("当前视频时长不受该模型支持");
  if (requiredVideoDuration(capability.id, settings.mode) === -1 && settings.duration !== -1) errors.push("视频编辑时长须跟随原片");
  if (settings.outputFormat && !capability.outputFormats.includes(settings.outputFormat)) errors.push("当前输出格式不受该模型支持");
  if (settings.audio && !capability.supportsGenerateAudio) errors.push("该模型不支持生成音频");
  return errors;
}

export function validateVideoConfiguration(input: {
  capability: NormalizedVideoCapability;
  settings: VideoSettings;
  aspectRatio: string;
  attachments: VideoAttachmentLike[];
}) {
  const { capability, settings, attachments } = input;
  const errors = validateVideoPreferenceConfiguration(input);

  const slots = activeVideoInputSlots(capability, settings.mode);
  const allocation = allocateVideoAttachments(capability, settings.mode, attachments);
  slots.forEach((slot) => {
    const count = allocation.counts[slot.id] || 0;
    if (count < slot.min) errors.push(`${slot.label}至少需要 ${slot.min} 个素材（当前 ${count} 个）`);
  });
  if (allocation.unassigned.length && slots.length) {
    errors.push(`有 ${allocation.unassigned.length} 个参考素材不符合当前模式的槽位要求`);
  } else if (attachments.length && !slots.length && capability.capabilityStatus !== "legacy") {
    errors.push("当前生成模式不接受参考素材");
  }
  return errors;
}
