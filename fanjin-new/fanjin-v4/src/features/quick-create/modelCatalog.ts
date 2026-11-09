import { referenceRequirementError } from "./referenceRequirements";
import { apiGet } from "../../api/http";
import type { GenerationReference } from "./contracts";
import type { QuickCreateImageQuality, QuickCreateRatio } from "./types";
import { BYTEPLUS_SEEDANCE_25_MODEL_ID, hasDeclaredVideoOutputFormats, normalizeDefaultVideoOutputFormat, normalizeVideoOutputFormats, type VideoOutputFormat } from "./videoOutputContract";

export type ModelCapabilityStatus =
  | "verified"
  | "configured"
  | "legacy"
  | "unverified"
  | "unsupported"
  | "unavailable"
  | "retired"
  | string;

export type VideoDurationCapability = {
  auto?: boolean;
  min: number;
  max: number;
  step: number;
  default: number;
  allowed?: number[];
};

export type QuickCreateVideoAttachmentKind = "image" | "video" | "file";
export type QuickCreateVideoReferenceRole = "subject" | "style" | "storyboard" | "first_frame" | "last_frame";
export type QuickCreateVideoOperation = "generate" | "extend" | "edit";

export type QuickCreateVideoInputSlot = {
  id: string;
  label: string;
  accepts: QuickCreateVideoAttachmentKind[];
  roles: QuickCreateVideoReferenceRole[];
  min: number;
  max: number;
  modes: string[];
  allowDuplicateAsset: boolean;
  supportsTrim: boolean;
};

export type QuickCreateVideoModelOption = {
  id: string;
  label: string;
  capabilityStatus: ModelCapabilityStatus;
  canSubmit: boolean;
  resolutions: string[];
  defaultResolution: string;
  outputFormats: VideoOutputFormat[];
  defaultOutputFormat: VideoOutputFormat;
  outputFormatsDeclared?: boolean;
  aspectRatios: QuickCreateRatio[];
  defaultAspectRatio: QuickCreateRatio;
  duration: VideoDurationCapability;
  supportsGenerateAudio: boolean;
  modes: string[];
  inputSlots: QuickCreateVideoInputSlot[];
  inputSlotsError?: string;
  operationByMode: Record<string, QuickCreateVideoOperation>;
  totalInputLimit: number;
  unavailableReason?: string;
};

export type QuickCreateImageModelOption = {
  id: string;
  label: string;
  capabilityStatus: ModelCapabilityStatus;
  canSubmit: boolean;
  qualities: QuickCreateImageQuality[];
  defaultQuality: QuickCreateImageQuality;
  aspectRatios: QuickCreateRatio[];
  defaultAspectRatio: QuickCreateRatio;
  maxOutputs: number;
  providerMaxOutputs?: number;
  unavailableReason?: string;
};

export type QuickCreateLlmModelOption = {
  id: string;
  label: string;
  description: string;
};

type UnknownRecord = Record<string, unknown>;

type ModelOptionsResponse = {
  llmModels?: unknown[];
  videoModels?: unknown[];
  imageModels?: unknown[];
  models?: unknown[];
};

export function publicModelUnavailableReason(
  value: unknown,
  managedValueOffer = false,
): string | undefined {
  const reason = typeof value === "string" ? value.trim() : "";
  if (!reason) return undefined;
  // The server owns public redaction. For a managed value SKU the client uses
  // fixed product copy and never interprets or bundles supplier/fulfillment
  // implementation vocabulary.
  return managedValueOffer ? "当前模型服务暂不可用，请稍后重试" : reason;
}

function isManagedValueVideoModel(modelId: string): boolean {
  return [
    "fanjin-seedance-2-5-value-720p",
    "fanjin-seedance-2-0-value-720p",
    "fanjin-seedance-2-0-mini-value-720p",
    "fanjin-seedance-2-0-fast-value-720p",
  ].includes(modelId);
}

const QUICK_CREATE_RATIOS = new Set<QuickCreateRatio>([
  "adaptive",
  "21:9",
  "16:9",
  "3:2",
  "4:3",
  "1:1",
  "3:4",
  "2:3",
  "9:16",
]);

const QUICK_CREATE_VIDEO_MODES = new Set([
  "text_to_video",
  "image_to_video",
  "first_last_frame",
  "omni_reference",
  "image_reference",
  "reference_to_video",
  "video_extension",
  "video_edit",
  "standard",
]);

const QUICK_CREATE_REFERENCE_ROLES = new Set<QuickCreateVideoReferenceRole>([
  "subject",
  "style",
  "storyboard",
  "first_frame",
  "last_frame",
]);

const GENERIC_REFERENCE_ROLES: QuickCreateVideoReferenceRole[] = ["subject", "style", "storyboard"];

export type QuickCreateVideoModePresentation = {
  id: string;
  label: string;
  description: string;
  badge?: "Beta";
};

const QUICK_CREATE_VIDEO_MODE_PRESENTATIONS: Record<string, Omit<QuickCreateVideoModePresentation, "id">> = {
  text_to_video: { label: "文生视频", description: "仅使用文字描述生成视频" },
  standard: { label: "标准生成", description: "使用当前模型的标准生成流程" },
  image_to_video: { label: "首帧", description: "使用一张图片作为视频首帧" },
  first_last_frame: { label: "首尾帧", description: "分别指定视频的开始与结束画面" },
  image_reference: { label: "智能多帧", description: "按镜头顺序添加多张参考画面" },
  reference_to_video: { label: "智能多帧", description: "按镜头顺序添加多张参考画面" },
  omni_reference: { label: "全能参考", description: "组合图片、视频与音频参考" },
  video_edit: { label: "智能编辑", description: "基于现有视频进行受控编辑", badge: "Beta" },
  video_extension: { label: "超长视频", description: "在现有视频基础上继续生成", badge: "Beta" },
};

export function quickCreateVideoModePresentation(mode: string): QuickCreateVideoModePresentation {
  const presentation = QUICK_CREATE_VIDEO_MODE_PRESENTATIONS[mode] || {
    label: mode,
    description: "使用模型声明的视频生成模式",
  };
  return { id: mode, ...presentation };
}

export function quickCreateVideoModeOptions(
  model: Pick<QuickCreateVideoModelOption, "modes"> | null | undefined,
): QuickCreateVideoModePresentation[] {
  if (!model) return [];
  const seenLabels = new Set<string>();
  return model.modes.flatMap((mode) => {
    const presentation = quickCreateVideoModePresentation(mode);
    // Some providers expose image_reference and reference_to_video as aliases.
    // Showing both as identical menu rows would make the selected contract
    // ambiguous, so retain the first server-declared alias only.
    if (seenLabels.has(presentation.label)) return [];
    seenLabels.add(presentation.label);
    return [presentation];
  });
}

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function stringValue(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function stringList(...values: unknown[]): string[] {
  for (const value of values) {
    if (!Array.isArray(value)) continue;
    const result = Array.from(
      new Set(value.map((item) => String(item || "").trim()).filter(Boolean)),
    );
    if (result.length) return result;
  }
  return [];
}

function capabilityToken(value: unknown): string {
  return typeof value === "string"
    ? value.trim().toLowerCase().replace(/[\s-]+/g, "_")
    : "";
}

function normalizeVideoMode(value: unknown): string {
  const normalized = capabilityToken(value);
  if (normalized === "text2video" || normalized === "t2v") return "text_to_video";
  if (normalized === "image2video" || normalized === "i2v") return "image_to_video";
  if (normalized === "firstlastframe") return "first_last_frame";
  return QUICK_CREATE_VIDEO_MODES.has(normalized) ? normalized : "";
}

function capabilityList(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return value.split(",");
  return null;
}

function normalizeReferenceRole(value: unknown): QuickCreateVideoReferenceRole[] {
  const normalized = capabilityToken(value);
  if (QUICK_CREATE_REFERENCE_ROLES.has(normalized as QuickCreateVideoReferenceRole)) {
    return [normalized as QuickCreateVideoReferenceRole];
  }
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
    return [...GENERIC_REFERENCE_ROLES];
  }
  return [];
}

function normalizeAttachmentKind(value: unknown): QuickCreateVideoAttachmentKind | "" {
  const normalized = capabilityToken(value);
  if (["image", "images", "image_url"].includes(normalized) || normalized.startsWith("image/")) return "image";
  if (["video", "videos", "video_url"].includes(normalized) || normalized.startsWith("video/")) return "video";
  if (
    ["file", "files", "document", "audio", "audio_url"].includes(normalized)
    || normalized.startsWith("audio/")
    || normalized.startsWith("application/")
  ) return "file";
  return "";
}

function safeInteger(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
  const normalized = Number(value);
  return Number.isSafeInteger(normalized) ? normalized : null;
}

function normalizeVideoInputSlots(value: unknown): {
  inputSlots: QuickCreateVideoInputSlot[];
  error?: string;
} {
  if (value === undefined || value === null) return { inputSlots: [] };
  if (!Array.isArray(value)) return { inputSlots: [], error: "视频模型 inputSlots 声明格式无效" };

  const inputSlots: QuickCreateVideoInputSlot[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const raw = value[index];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { inputSlots: [], error: `视频模型第 ${index + 1} 个输入槽声明无效` };
    }
    const slot = raw as UnknownRecord;
    const id = stringValue(slot.id, slot.role);
    const rawRoles = capabilityList(slot.roles ?? slot.referenceRoles ?? slot.acceptedRoles)
      ?? [slot.role ?? slot.id];
    const roles: QuickCreateVideoReferenceRole[] = [];
    for (const role of rawRoles) {
      const normalized = normalizeReferenceRole(role);
      if (!normalized.length) {
        return { inputSlots: [], error: `视频模型输入槽 ${id || index + 1} 的 role 声明无效` };
      }
      normalized.forEach((item) => {
        if (!roles.includes(item)) roles.push(item);
      });
    }

    const rawAccepts = capabilityList(slot.accepts ?? slot.accept);
    const accepts: QuickCreateVideoAttachmentKind[] = [];
    if (rawAccepts) {
      for (const accept of rawAccepts) {
        const normalized = normalizeAttachmentKind(accept);
        if (!normalized) {
          return { inputSlots: [], error: `视频模型输入槽 ${id || index + 1} 的 accepts 声明无效` };
        }
        if (!accepts.includes(normalized)) accepts.push(normalized);
      }
    } else {
      const hint = [slot.mediaType, slot.type, slot.role, slot.id]
        .map(capabilityToken)
        .filter(Boolean)
        .join("_");
      const inferred = /image|frame/.test(hint)
        ? "image"
        : /video/.test(hint)
          ? "video"
          : /audio|file/.test(hint)
            ? "file"
            : "";
      if (inferred) accepts.push(inferred);
    }

    const required = slot.required === undefined ? false : slot.required;
    if (typeof required !== "boolean") {
      return { inputSlots: [], error: `视频模型输入槽 ${id || index + 1} 的 required 声明无效` };
    }
    const min = slot.min === undefined ? (required ? 1 : 0) : safeInteger(slot.min);
    const max = slot.max === undefined
      ? Math.max(typeof min === "number" ? min : 0, 1)
      : safeInteger(slot.max);
    const rawModes = slot.modes === undefined || slot.modes === null ? [] : slot.modes;
    if (!Array.isArray(rawModes)) {
      return { inputSlots: [], error: `视频模型输入槽 ${id || index + 1} 的 modes 声明无效` };
    }
    const modes: string[] = [];
    for (const mode of rawModes) {
      const normalized = normalizeVideoMode(mode);
      if (!normalized) {
        return { inputSlots: [], error: `视频模型输入槽 ${id || index + 1} 的 modes 声明无效` };
      }
      if (!modes.includes(normalized)) modes.push(normalized);
    }

    if (
      !id
      || ids.has(id)
      || roles.length === 0
      || accepts.length === 0
      || min === null
      || max === null
      || min < 0
      || max < 1
      || max < min
      || (required && min < 1)
    ) {
      return { inputSlots: [], error: `视频模型输入槽 ${id || index + 1} 的 role/accepts/min/max/modes 声明不完整` };
    }
    ids.add(id);
    inputSlots.push({
      id,
      label: stringValue(slot.label, id),
      accepts,
      roles,
      min,
      max,
      modes,
      allowDuplicateAsset: slot.allowDuplicateAsset === true,
      supportsTrim: slot.supportsTrim === true,
    });
  }
  return { inputSlots };
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeRatios(values: string[], fallback: QuickCreateRatio[], allowAdaptive = false): QuickCreateRatio[] {
  const ratios = values.filter((item): item is QuickCreateRatio =>
    QUICK_CREATE_RATIOS.has(item as QuickCreateRatio) && (allowAdaptive || item !== "adaptive"),
  );
  return ratios.length ? ratios : fallback;
}

function normalizeDuration(rawModel: UnknownRecord, capabilities: UnknownRecord): VideoDurationCapability | null {
  const parameters = record(capabilities.parameters);
  const duration = {
    ...record(rawModel.duration),
    ...record(capabilities.duration),
    ...record(parameters.duration),
  };
  const allowed = stringList(duration.allowed, duration.options)
    .map(Number)
    .filter((value) => Number.isFinite(value) && value >= 0);
  const minSource = Number(duration.min ?? (allowed.length ? Math.min(...allowed) : Number.NaN));
  const maxSource = Number(duration.max ?? (allowed.length ? Math.max(...allowed) : Number.NaN));
  const stepSource = Number(duration.step ?? (allowed.length ? 1 : Number.NaN));
  const defaultSource = Number(duration.default ?? duration.defaultValue ?? (allowed.length ? allowed[0] : Number.NaN));
  if (![minSource, maxSource, stepSource, defaultSource].every(Number.isFinite)) return null;
  const min = Math.max(0, minSource);
  const max = Math.max(min, maxSource);
  const step = Math.max(0.1, stepSource);
  const requestedDefault = defaultSource;
  const normalizedDefault = duration.auto === true && requestedDefault === -1
    ? -1
    : Math.min(max, Math.max(min, requestedDefault));
  return {
    min,
    max,
    step,
    default: normalizedDefault === -1 ? -1 : allowed.length
      ? allowed.reduce((best, value) =>
          Math.abs(value - normalizedDefault) < Math.abs(best - normalizedDefault) ? value : best,
        )
      : normalizedDefault,
    auto: duration.auto === true,
    ...(allowed.length ? { allowed } : {}),
  };
}

type NormalizedVideoGenerationDirectory = {
  dispatchable: boolean;
  modes: string[];
  operationByMode: Record<string, QuickCreateVideoOperation>;
  inputSlots: QuickCreateVideoInputSlot[];
  totalInputLimit: number;
  supportsGenerateAudio: boolean;
  outputFormats: VideoOutputFormat[];
  defaultOutputFormat: VideoOutputFormat;
  outputFormatsDeclared: boolean;
};

function normalizeVideoGenerationDirectory(
  value: unknown,
): NormalizedVideoGenerationDirectory | null {
  const directory = record(value);
  if (
    directory.version !== "workbench-video-generation/v1"
    || typeof directory.dispatchable !== "boolean"
    || typeof directory.supportsGenerateAudio !== "boolean"
    || !Number.isSafeInteger(directory.totalInputLimit)
    || Number(directory.totalInputLimit) < 0
    || !Array.isArray(directory.operations)
    || !Array.isArray(directory.inputSlots)
  ) return null;
  const modes: string[] = [];
  const operationByMode: Record<string, QuickCreateVideoOperation> = {};
  for (const raw of directory.operations) {
    const operation = record(raw);
    if (!operation.enabled || !["generate", "extend", "edit"].includes(String(operation.operation))) continue;
    if (!Array.isArray(operation.modes)) return null;
    for (const rawMode of operation.modes) {
      const mode = normalizeVideoMode(rawMode);
      if (!mode) return null;
      if (operationByMode[mode] && operationByMode[mode] !== operation.operation) return null;
      operationByMode[mode] = operation.operation as QuickCreateVideoOperation;
      if (!modes.includes(mode)) modes.push(mode);
    }
  }
  const normalizedSlots = normalizeVideoInputSlots(directory.inputSlots.map((raw) => {
    const slot = record(raw);
    return {
      id: slot.id,
      label: slot.label,
      roles: slot.roles,
      accepts: Array.isArray(slot.mediaTypes)
        ? slot.mediaTypes.map((mediaType) => mediaType === "audio" ? "file" : mediaType)
        : slot.mediaTypes,
      modes: slot.modes,
      min: slot.min,
      max: slot.max,
      allowDuplicateAsset: slot.allowDuplicateAsset,
      supportsTrim: slot.supportsTrim,
    };
  }));
  if (normalizedSlots.error) return null;
  const outputFormats = normalizeVideoOutputFormats(directory.outputFormats);
  return {
    dispatchable: directory.dispatchable,
    modes,
    operationByMode,
    inputSlots: normalizedSlots.inputSlots,
    totalInputLimit: Number(directory.totalInputLimit),
    supportsGenerateAudio: directory.supportsGenerateAudio,
    outputFormats,
    defaultOutputFormat: normalizeDefaultVideoOutputFormat(directory.defaultOutputFormat, outputFormats),
    outputFormatsDeclared: hasDeclaredVideoOutputFormats(directory.outputFormats),
  };
}

export function normalizeVideoModelOption(value: unknown): QuickCreateVideoModelOption | null {
  const rawModel = record(value);
  const capabilities = record(rawModel.capabilities);
  const parameters = record(capabilities.parameters);
  const resolutionParameter = record(parameters.resolution);
  const ratioParameter = record(parameters.aspectRatio || parameters.ratio);
  const id = stringValue(rawModel.id, rawModel.model);
  if (!id) return null;
  const managedValueOffer = isManagedValueVideoModel(id);
  const videoGeneration = normalizeVideoGenerationDirectory(
    rawModel.videoGeneration ?? capabilities.videoGeneration,
  );

  const resolutions = stringList(
    rawModel.resolutions,
    capabilities.resolutions,
    resolutionParameter.options,
    resolutionParameter.values,
  );
  const normalizedResolutions = resolutions.filter((resolution) => (
    videoGeneration && (!managedValueOffer || resolution.toLowerCase() === "720p")
  ));
  const defaultResolution = stringValue(
    rawModel.defaultResolution,
    capabilities.defaultResolution,
    resolutionParameter.default,
    resolutionParameter.defaultValue,
  );
  const rawRatios = stringList(
    rawModel.aspectRatios,
    capabilities.aspectRatios,
    ratioParameter.options,
    ratioParameter.values,
  );
  const aspectRatios = normalizeRatios(rawRatios, [], id === BYTEPLUS_SEEDANCE_25_MODEL_ID);
  const requestedDefaultRatio = stringValue(
    rawModel.defaultAspectRatio,
    capabilities.defaultAspectRatio,
    ratioParameter.default,
    ratioParameter.defaultValue,
  ) as QuickCreateRatio;
  const capabilityStatus = stringValue(
    rawModel.capabilityStatus,
    capabilities.status,
    rawModel.status,
    "unverified",
  );
  const normalizedDuration = normalizeDuration(rawModel, capabilities);
  const directoryComplete = Boolean(
    videoGeneration
    && videoGeneration.dispatchable
    && normalizedDuration
    && normalizedResolutions.length
    && aspectRatios.length
    && videoGeneration.modes.length,
  );

  return {
    id,
    label: stringValue(rawModel.label, rawModel.name, id),
    capabilityStatus,
    canSubmit: rawModel.canSubmit === true && directoryComplete,
    resolutions: normalizedResolutions,
    defaultResolution: normalizedResolutions.includes(defaultResolution)
      ? defaultResolution
      : normalizedResolutions[0],
    outputFormats: videoGeneration?.outputFormats ?? ["mp4"],
    defaultOutputFormat: videoGeneration?.defaultOutputFormat ?? "mp4",
    outputFormatsDeclared: videoGeneration?.outputFormatsDeclared ?? false,
    aspectRatios,
    defaultAspectRatio: aspectRatios.includes(requestedDefaultRatio)
      ? requestedDefaultRatio
      : aspectRatios[0],
    duration: normalizedDuration ?? { min: 0, max: 0, step: 1, default: 0 },
    supportsGenerateAudio: videoGeneration?.supportsGenerateAudio ?? false,
    modes: videoGeneration?.modes ?? [],
    inputSlots: videoGeneration?.inputSlots ?? [],
    inputSlotsError: videoGeneration ? undefined : "视频模型缺少统一 operation/inputSlots 目录",
    operationByMode: videoGeneration?.operationByMode ?? {},
    totalInputLimit: videoGeneration?.totalInputLimit ?? 0,
    unavailableReason: publicModelUnavailableReason(
      stringValue(
        rawModel.unavailableReason,
        rawModel.unsupportedReason,
        capabilities.unavailableReason,
      ),
      managedValueOffer,
    ),
  };
}

function candidateVideoModes(attachmentKinds: QuickCreateVideoAttachmentKind[]): string[] {
  if (!attachmentKinds.length) return ["text_to_video", "standard"];
  const hasImage = attachmentKinds.includes("image");
  const hasVideo = attachmentKinds.includes("video");
  const hasFile = attachmentKinds.includes("file");
  if (hasVideo || hasFile) {
    return hasImage
      ? ["omni_reference", "reference_to_video", "video_edit"]
      : ["video_extension", "video_edit", "reference_to_video", "omni_reference"];
  }
  if (attachmentKinds.length === 1) {
    return ["image_to_video", "image_reference", "reference_to_video", "omni_reference"];
  }
  if (attachmentKinds.length === 2) {
    return ["first_last_frame", "image_reference", "reference_to_video", "omni_reference"];
  }
  return ["image_reference", "reference_to_video", "omni_reference"];
}

function preferredSlotRole(slot: QuickCreateVideoInputSlot): QuickCreateVideoReferenceRole {
  if (slot.roles.includes("first_frame")) return "first_frame";
  if (slot.roles.includes("last_frame")) return "last_frame";
  if (slot.roles.includes("subject")) return "subject";
  return slot.roles[0];
}

function assignQuickCreateSlotsForMode<T extends {
  kind: QuickCreateVideoAttachmentKind;
  assetVersionId?: string;
  preferredRole?: QuickCreateVideoReferenceRole;
  slotId?: string;
}>(
  capability: QuickCreateVideoModelOption,
  mode: string,
  attachments: T[],
): { ok: true; assignments: Array<{ attachment: T; role: QuickCreateVideoReferenceRole; slot: QuickCreateVideoInputSlot }> } | { ok: false; message: string } {
  const slots = capability.inputSlots.filter((slot) => !slot.modes.length || slot.modes.includes(mode));
  if (attachments.length > 0 && slots.length === 0) {
    return { ok: false, message: "当前模式暂不支持添加参考素材，请切换生成模式" };
  }

  const counts = new Map(slots.map((slot) => [slot.id, 0]));
  const seenBySlot = new Map(slots.map((slot) => [slot.id, new Set<string>()]));
  const assignments: Array<{ attachment: T; role: QuickCreateVideoReferenceRole; slot: QuickCreateVideoInputSlot }> = [];
  for (const attachment of attachments) {
    const assetVersionId = typeof attachment.assetVersionId === "string"
      ? attachment.assetVersionId.trim()
      : "";
    const compatible = slots
      .filter((slot) => (
        slot.accepts.includes(attachment.kind)
        && (!attachment.slotId || slot.id === attachment.slotId)
        && (!attachment.preferredRole || slot.roles.includes(attachment.preferredRole))
      ))
      .sort((left, right) => {
        const leftNeedsMinimum = Number(counts.get(left.id) || 0) < left.min ? 0 : 1;
        const rightNeedsMinimum = Number(counts.get(right.id) || 0) < right.min ? 0 : 1;
        return leftNeedsMinimum - rightNeedsMinimum
          || left.roles.length - right.roles.length
          || left.accepts.length - right.accepts.length
          || left.max - right.max;
      });
    const target = compatible.find((slot) => (
      Number(counts.get(slot.id) || 0) < slot.max
      && (
        !assetVersionId
        || slot.allowDuplicateAsset
        || !seenBySlot.get(slot.id)?.has(assetVersionId)
      )
    ));
    if (!target) {
      if (!slots.some((slot) => slot.accepts.includes(attachment.kind))) {
        return { ok: false, message: `当前模式不支持${attachment.kind === "image" ? "图片" : attachment.kind === "video" ? "视频" : "音频"}参考，请切换生成模式或移除该素材` };
      }
      if (assetVersionId && compatible.some((slot) => (
        !slot.allowDuplicateAsset && seenBySlot.get(slot.id)?.has(assetVersionId)
      ))) {
        return { ok: false, message: "同一素材已添加，请勿重复引用" };
      }
      return { ok: false, message: `参考${attachment.kind === "image" ? "图片" : attachment.kind === "video" ? "视频" : "音频"}数量超限：当前 ${attachments.filter((item) => item.kind === attachment.kind).length} 个，当前模式最多支持 ${Math.min(capability.totalInputLimit, compatible.reduce((sum, slot) => sum + slot.max, 0))} 个。请移除部分素材。` };
    }
    counts.set(target.id, Number(counts.get(target.id) || 0) + 1);
    if (assetVersionId) seenBySlot.get(target.id)?.add(assetVersionId);
    assignments.push({
      attachment,
      role: attachment.preferredRole && target.roles.includes(attachment.preferredRole)
        ? attachment.preferredRole
        : preferredSlotRole(target),
      slot: target,
    });
  }

  for (const slot of slots) {
    if (Number(counts.get(slot.id) || 0) < slot.min) {
      return { ok: false, message: `${slot.label} 至少需要 ${slot.min} 个参考素材` };
    }
  }
  return { ok: true, assignments };
}

export function resolveQuickCreateVideoMode(
  capability: QuickCreateVideoModelOption,
  attachmentKinds: QuickCreateVideoAttachmentKind[],
  preferredMode?: string,
): { ok: true; mode: string } | { ok: false; message: string } {
  if (capability.inputSlotsError) return { ok: false, message: capability.inputSlotsError };
  if (!capability.modes.length) return { ok: false, message: "视频模型缺少可识别的 mode 声明" };
  if (attachmentKinds.some((kind) => !["image", "video", "file"].includes(kind))) {
    return { ok: false, message: "参考素材包含无法识别的媒体类型" };
  }
  const declaredModes = new Set(capability.modes);
  if (capability.inputSlots.some((slot) => slot.modes.some((mode) => !declaredModes.has(mode)))) {
    return { ok: false, message: "视频模型输入槽引用了未声明的 mode" };
  }

  if (preferredMode && !declaredModes.has(preferredMode)) {
    return { ok: false, message: "所选视频生成模式不受当前模型支持" };
  }
  const candidates = preferredMode
    ? [preferredMode]
    : candidateVideoModes(attachmentKinds).filter((mode) => declaredModes.has(mode));
  if (!candidates.length) {
    return {
      ok: false,
      message: attachmentKinds.length
        ? "当前参考素材组合不受所选视频模型的生成模式支持"
        : "所选视频模型不支持文生视频模式",
    };
  }
  let firstError = "当前参考素材不符合视频模型输入槽要求";
  for (const mode of candidates) {
    const assignment = assignQuickCreateSlotsForMode(
      capability,
      mode,
      attachmentKinds.map((kind) => ({ kind })),
    );
    if (assignment.ok) return { ok: true, mode };
    firstError = assignment.message;
  }
  return { ok: false, message: firstError };
}

export function resolveQuickCreateVideoReferences(
  capability: QuickCreateVideoModelOption,
  mode: string,
  attachments: Array<{
    kind: QuickCreateVideoAttachmentKind;
    assetVersionId: string;
    preferredRole?: QuickCreateVideoReferenceRole;
    slotId?: string;
    trim?: { startMs: number; endMs: number };
    durationSeconds?: number;
    name?: string;
    mimeType?: string;
    size?: number;
  }>,
): { ok: true; operation: QuickCreateVideoOperation; references: GenerationReference[] } | { ok: false; message: string } {
  const requirementError = referenceRequirementError(capability.id, mode, attachments);
  if (requirementError) return { ok: false, message: requirementError };
  const assignment = assignQuickCreateSlotsForMode(capability, mode, attachments);
  if (!assignment.ok) return assignment;
  if (assignment.assignments.some(({ attachment }) => !attachment.assetVersionId.trim())) {
    return { ok: false, message: "参考素材尚未上传完成，请等待上传完成后再生成" };
  }
  const operation = capability.operationByMode[mode];
  if (!operation) return { ok: false, message: "视频模型目录未声明当前 mode 对应的 operation" };
  const unsupportedTrim = assignment.assignments.find(({ attachment, slot }) => attachment.trim && !slot.supportsTrim);
  if (unsupportedTrim) {
    const { attachment } = unsupportedTrim;
    const label = attachment.kind === "file" ? "音频" : attachment.kind === "video" ? "视频" : "图片";
    return { ok: false, message: `${attachment.name ? `${attachment.name}：` : ""}当前模型不支持裁剪参考${label}，请使用完整素材，或将所需片段另存为新素材后添加` };
  }
  return {
    ok: true,
    operation,
    references: assignment.assignments.map(({ attachment, role }, order) => ({
      assetVersionId: attachment.assetVersionId.trim(),
      role,
      mediaType: attachment.kind === "file" ? "audio" : attachment.kind,
      order,
      ...(attachment.trim ? { trim: { ...attachment.trim } } : {}),
    })),
  };
}

export function normalizeVideoModelOptions(value: unknown): QuickCreateVideoModelOption[] {
  if (!Array.isArray(value)) return [];
  const models = value
    .map(normalizeVideoModelOption)
    .filter((item): item is QuickCreateVideoModelOption => Boolean(item));
  return Array.from(new Map(models.map((model) => [model.id, model])).values());
}

function imageQuality(value: unknown): QuickCreateImageQuality | null {
  const normalized = String(value || "").trim().toUpperCase();
  return normalized === "1K"
    || normalized === "2K"
    || normalized === "4K"
    ? normalized
    : null;
}

export function normalizeImageModelOption(value: unknown): QuickCreateImageModelOption | null {
  const rawModel = record(value);
  const capabilities = record(rawModel.capabilities);
  const parameters = record(capabilities.parameters);
  const qualityParameter = record(parameters.quality || parameters.resolution);
  const ratioParameter = record(parameters.aspectRatio || parameters.ratio);
  const countParameter = record(parameters.count || parameters.outputs || parameters.outputCount);
  const id = stringValue(rawModel.id, rawModel.model);
  if (!id) return null;
  const qualities = stringList(
    rawModel.qualities,
    rawModel.resolutions,
    capabilities.qualities,
    capabilities.resolutions,
    qualityParameter.options,
    qualityParameter.values,
  )
    .map(imageQuality)
    .filter((item): item is QuickCreateImageQuality => Boolean(item));
  const normalizedQualities = Array.from(new Set(qualities));
  const safeQualities = normalizedQualities;
  const requestedDefaultQuality = imageQuality(
    stringValue(
      rawModel.defaultQuality,
      rawModel.defaultResolution,
      capabilities.defaultQuality,
      capabilities.defaultResolution,
      qualityParameter.default,
      qualityParameter.defaultValue,
    ),
  );
  const aspectRatios = normalizeRatios(
    stringList(
      rawModel.aspectRatios,
      capabilities.aspectRatios,
      ratioParameter.options,
      ratioParameter.values,
    ),
    ["16:9", "9:16", "1:1", "4:3", "3:4"],
  );
  const requestedDefaultRatio = stringValue(
    rawModel.defaultAspectRatio,
    capabilities.defaultAspectRatio,
    ratioParameter.default,
    ratioParameter.defaultValue,
  ) as QuickCreateRatio;
  const declaredMaxOutputs = safeInteger(
    rawModel.maxOutputs
      ?? rawModel.maxOutputCount
      ?? capabilities.maxOutputs
      ?? capabilities.maxOutputCount
      ?? countParameter.max
      ?? countParameter.maximum,
  );
  const providerMaxOutputs = Math.max(1, Math.min(8, declaredMaxOutputs ?? 1));
  const declaredStatus = stringValue(
    rawModel.capabilityStatus,
    capabilities.status,
    rawModel.status,
    "unverified",
  );
  const contractComplete = safeQualities.length > 0 && aspectRatios.length > 0;
  return {
    id,
    label: stringValue(rawModel.label, rawModel.name, id),
    capabilityStatus: contractComplete ? declaredStatus : "unavailable",
    canSubmit: booleanValue(
      rawModel.canSubmit,
      isCapabilityStatusAvailable(declaredStatus),
    ) && contractComplete,
    qualities: safeQualities,
    defaultQuality:
      requestedDefaultQuality && safeQualities.includes(requestedDefaultQuality)
        ? requestedDefaultQuality
        : safeQualities.includes("2K")
          ? "2K"
          : safeQualities[0] ?? "2K",
    aspectRatios,
    defaultAspectRatio: aspectRatios.includes(requestedDefaultRatio)
      ? requestedDefaultRatio
      : aspectRatios[0],
    // The user-facing batch is composed from independent provider requests.
    // Keep the provider's single-request limit separately for diagnostics.
    maxOutputs: 8,
    providerMaxOutputs,
    unavailableReason: publicModelUnavailableReason(stringValue(
      rawModel.unavailableReason,
      rawModel.unsupportedReason,
      capabilities.unavailableReason,
    )) || (!contractComplete ? "模型目录未声明可用图片清晰度或比例" : undefined),
  };
}

export function normalizeImageModelOptions(value: unknown): QuickCreateImageModelOption[] {
  if (!Array.isArray(value)) return [];
  const models = value
    .map(normalizeImageModelOption)
    .filter((item): item is QuickCreateImageModelOption => Boolean(item));
  return Array.from(new Map(models.map((model) => [model.id, model])).values());
}

export function normalizeLlmModelOptions(value: unknown): QuickCreateLlmModelOption[] {
  if (!Array.isArray(value)) return [];
  const models = value
    .map((item) => {
      const model = record(item);
      const id = stringValue(model.id, model.value, model.model);
      if (!id) return null;
      return {
        id,
        label: stringValue(model.label, model.name, id),
        description: stringValue(model.description, model.summary, "平台可用的对话大模型"),
      };
    })
    .filter((item): item is QuickCreateLlmModelOption => Boolean(item));
  const byId = new Map<string, QuickCreateLlmModelOption>();
  models.forEach((model) => {
    if (!byId.has(model.id)) byId.set(model.id, model);
  });
  return Array.from(byId.values());
}

function isCapabilityStatusAvailable(statusValue: ModelCapabilityStatus): boolean {
  const status = (statusValue || "").toLowerCase();
  return status === "verified" || status === "configured" || status === "legacy";
}

export function isImageModelAvailable(model: QuickCreateImageModelOption): boolean {
  const status = (model.capabilityStatus || "").toLowerCase();
  return model.canSubmit !== false
    && (status === "verified" || status === "configured" || status === "legacy");
}

export function isVideoModelAvailable(model: QuickCreateVideoModelOption): boolean {
  const status = (model.capabilityStatus || "").toLowerCase();
  return model.canSubmit !== false
    && (status === "verified" || status === "configured" || status === "legacy");
}

export function normalizeVideoDuration(
  value: number,
  capability: VideoDurationCapability,
): number {
  if (value === -1 && capability.auto === true) return -1;
  const requested = Number.isFinite(value) ? value : capability.default;
  if (capability.allowed?.length) {
    return capability.allowed.reduce((best, allowed) =>
      Math.abs(allowed - requested) < Math.abs(best - requested) ? allowed : best,
    );
  }
  const clamped = Math.min(capability.max, Math.max(capability.min, requested));
  const steps = Math.round((clamped - capability.min) / capability.step);
  return Number((capability.min + steps * capability.step).toFixed(3));
}

export async function fetchQuickCreateModels(): Promise<{
  llmModels: QuickCreateLlmModelOption[];
  imageModels: QuickCreateImageModelOption[];
  videoModels: QuickCreateVideoModelOption[];
}> {
  const response = await apiGet<ModelOptionsResponse>(
    "/workbench/create/modelOptions",
  );
  const catalog = Array.isArray(response.models) ? response.models : [];
  const catalogImages = catalog.filter(
    (item) => stringValue(record(item).endpointType, record(item).category) === "image_generation" ||
      stringValue(record(item).category) === "image",
  );
  const catalogVideos = catalog.filter(
    (item) => stringValue(record(item).endpointType, record(item).category) === "video_generation" ||
      stringValue(record(item).category) === "video",
  );
  const imageModels = normalizeImageModelOptions(
    Array.isArray(response.imageModels) && response.imageModels.length
      ? response.imageModels
      : catalogImages,
  ).filter((model) => model.canSubmit === true);
  const videoModels = normalizeVideoModelOptions(
    Array.isArray(response.videoModels) && response.videoModels.length
      ? response.videoModels
      : catalogVideos,
  ).filter((model) => model.canSubmit === true);
  const llmModels = normalizeLlmModelOptions(response.llmModels);
  return {
    llmModels,
    imageModels,
    videoModels,
  };
}

export async function fetchQuickCreateVideoModels(): Promise<QuickCreateVideoModelOption[]> {
  return (await fetchQuickCreateModels()).videoModels;
}
