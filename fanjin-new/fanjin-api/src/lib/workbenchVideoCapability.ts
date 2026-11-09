import type { GenerationReference } from "@/lib/generationReferenceResolver";
import { isSeedance25ModelId } from "./seedance25ModelIds";

type ReferenceRole = GenerationReference["role"];
type ReferenceKind = "image" | "video" | "audio";

type VideoCapabilityInput = {
  id?: unknown;
  model?: unknown;
  modes?: unknown;
  inputSlots?: unknown;
};

type PreparedVideoTrackInput = {
  references?: GenerationReference[];
  referenceContent: Record<string, unknown>[];
  mode?: unknown;
};

type NormalizedReference = {
  assetVersionId: string;
  role: ReferenceRole;
  kind: ReferenceKind;
  trim: boolean;
};

type NormalizedSlot = {
  id: string;
  label: string;
  accepts: Set<ReferenceKind>;
  roles: Set<ReferenceRole>;
  min: number;
  max: number;
  modes: Set<string>;
  allowDuplicateAsset: boolean;
  supportsTrim: boolean;
};

export type WorkbenchVideoInputValidation =
  | { ok: true; modes: string[] }
  | { ok: false; message: string };

export const MAX_WORKBENCH_VIDEO_REFERENCES_PER_TRACK = 15;
/** Surface envelope ceiling; formal contracts must enforce their own typed limits. */
export const MAX_FORMAL_VIDEO_REFERENCES_PER_REQUEST = 50;

const EXTENDED_REFERENCE_ENVELOPE_MODELS = new Set([
  "fanjin-seedance-2-5-value-720p",
]);

function workbenchVideoReferenceEnvelope(capability: VideoCapabilityInput): number {
  const model = String(capability.model || capability.id || "").trim();
  return isSeedance25ModelId(model) || EXTENDED_REFERENCE_ENVELOPE_MODELS.has(model)
    ? MAX_FORMAL_VIDEO_REFERENCES_PER_REQUEST
    : MAX_WORKBENCH_VIDEO_REFERENCES_PER_TRACK;
}

const REFERENCE_ROLES = new Set<ReferenceRole>([
  "subject",
  "style",
  "storyboard",
  "first_frame",
  "last_frame",
]);

const SUPPORTED_MODES = new Set([
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

const GENERIC_REFERENCE_ROLES: ReferenceRole[] = ["subject", "style", "storyboard"];

function token(value: unknown): string {
  return typeof value === "string"
    ? value.trim().toLowerCase().replace(/[\s-]+/g, "_")
    : "";
}

function normalizeMode(value: unknown): string {
  const normalized = token(value);
  if (normalized === "text2video" || normalized === "t2v") return "text_to_video";
  if (normalized === "image2video" || normalized === "i2v") return "image_to_video";
  if (normalized === "firstlastframe") return "first_last_frame";
  return SUPPORTED_MODES.has(normalized) ? normalized : "";
}

function normalizeRole(value: unknown): ReferenceRole[] {
  const normalized = token(value);
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
    return [...GENERIC_REFERENCE_ROLES];
  }
  return [];
}

function normalizeAccept(value: unknown): ReferenceKind | "" {
  const normalized = token(value);
  if (["image", "images", "image_url"].includes(normalized) || normalized.startsWith("image/")) return "image";
  if (["video", "videos", "video_url"].includes(normalized) || normalized.startsWith("video/")) return "video";
  if (
    ["file", "files", "document", "audio", "audio_url"].includes(normalized)
    || normalized.startsWith("audio/")
    || normalized.startsWith("application/")
  ) return "audio";
  return "";
}

function finiteInteger(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
  const normalized = Number(value);
  return Number.isSafeInteger(normalized) ? normalized : null;
}

function parseDeclaredModes(value: unknown): { modes: string[]; error?: string } {
  if (!Array.isArray(value) || value.length === 0) {
    return { modes: [], error: "视频模型缺少可识别的 mode 声明" };
  }
  const modes: string[] = [];
  for (const raw of value) {
    const mode = normalizeMode(raw);
    if (!mode) return { modes: [], error: "视频模型包含无法识别的 mode 声明" };
    if (!modes.includes(mode)) modes.push(mode);
  }
  return { modes };
}

function rawStringList(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return value.split(",");
  return null;
}

function parseSlotRoles(slot: Record<string, unknown>): Set<ReferenceRole> | null {
  const explicit = rawStringList(slot.roles ?? slot.referenceRoles ?? slot.acceptedRoles);
  const rawRoles = explicit ?? [slot.role ?? slot.id];
  const roles = new Set<ReferenceRole>();
  for (const raw of rawRoles) {
    const normalized = normalizeRole(raw);
    if (!normalized.length) return null;
    normalized.forEach((role) => roles.add(role));
  }
  return roles.size ? roles : null;
}

function parseSlotAccepts(slot: Record<string, unknown>): Set<ReferenceKind> | null {
  const explicit = rawStringList(slot.accepts ?? slot.accept);
  if (explicit) {
    const accepts = new Set<ReferenceKind>();
    for (const raw of explicit) {
      const normalized = normalizeAccept(raw);
      if (!normalized) return null;
      accepts.add(normalized);
    }
    return accepts.size ? accepts : null;
  }

  const hint = [slot.mediaType, slot.type, slot.role, slot.id].map(token).filter(Boolean).join("_");
  if (/image|frame/.test(hint)) return new Set<ReferenceKind>(["image"]);
  if (/video/.test(hint)) return new Set<ReferenceKind>(["video"]);
  if (/audio|file/.test(hint)) return new Set<ReferenceKind>(["audio"]);
  return null;
}

function parseSlotModes(value: unknown): Set<string> | null {
  if (value === undefined || value === null) return new Set();
  if (!Array.isArray(value)) return null;
  const modes = new Set<string>();
  for (const raw of value) {
    const mode = normalizeMode(raw);
    if (!mode) return null;
    modes.add(mode);
  }
  return modes;
}

function parseSlots(value: unknown): { slots: NormalizedSlot[]; error?: string } {
  if (value === undefined || value === null) return { slots: [] };
  if (!Array.isArray(value)) return { slots: [], error: "视频模型 inputSlots 声明格式无效" };

  const slots: NormalizedSlot[] = [];
  const slotIds = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const raw = value[index];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { slots: [], error: `视频模型第 ${index + 1} 个输入槽声明无效` };
    }
    const slot = raw as Record<string, unknown>;
    const id = typeof slot.id === "string" && slot.id.trim()
      ? slot.id.trim()
      : typeof slot.role === "string" && slot.role.trim()
        ? slot.role.trim()
        : "";
    const roles = parseSlotRoles(slot);
    const accepts = parseSlotAccepts(slot);
    const modes = parseSlotModes(slot.modes);
    const required = slot.required === undefined ? false : slot.required;
    if (typeof required !== "boolean") {
      return { slots: [], error: `视频模型输入槽 ${id || index + 1} 的 required 声明无效` };
    }
    const min = slot.min === undefined ? (required ? 1 : 0) : finiteInteger(slot.min);
    const max = slot.max === undefined
      ? Math.max(typeof min === "number" ? min : 0, 1)
      : finiteInteger(slot.max);
    const allowDuplicateAsset = slot.allowDuplicateAsset === undefined
      ? false
      : slot.allowDuplicateAsset;
    const supportsTrim = slot.supportsTrim === undefined ? false : slot.supportsTrim;
    if (
      !id
      || slotIds.has(id)
      || !roles
      || !accepts
      || !modes
      || min === null
      || max === null
      || min < 0
      || max < 1
      || max < min
      || (required && min < 1)
      || typeof allowDuplicateAsset !== "boolean"
      || typeof supportsTrim !== "boolean"
      || (supportsTrim && !accepts.has("audio") && !accepts.has("video"))
    ) {
      return { slots: [], error: `视频模型输入槽 ${id || index + 1} 的 role/accepts/min/max/modes 声明不完整` };
    }
    slotIds.add(id);
    slots.push({
      id,
      label: typeof slot.label === "string" && slot.label.trim() ? slot.label.trim() : id,
      accepts,
      roles,
      min,
      max,
      modes,
      allowDuplicateAsset,
      supportsTrim,
    });
  }
  return { slots };
}

export function resolveWorkbenchVideoReferenceLimit(
  capability: VideoCapabilityInput,
  requestedMode?: unknown,
): number {
  const declared = parseDeclaredModes(capability.modes);
  const parsedSlots = parseSlots(capability.inputSlots);
  if (declared.error || parsedSlots.error || parsedSlots.slots.length === 0) return 0;

  const normalizedRequestedMode = requestedMode === undefined || requestedMode === null || String(requestedMode).trim() === ""
    ? ""
    : normalizeMode(requestedMode);
  if (requestedMode !== undefined && requestedMode !== null && String(requestedMode).trim() && !normalizedRequestedMode) {
    return 0;
  }
  const candidateModes = normalizedRequestedMode
    ? declared.modes.filter((mode) => mode === normalizedRequestedMode)
    : declared.modes;
  const maximum = candidateModes.reduce((largest, mode) => {
    const total = parsedSlots.slots
      .filter((slot) => slot.modes.size === 0 || slot.modes.has(mode))
      .reduce((sum, slot) => sum + slot.max, 0);
    return Math.max(largest, total);
  }, 0);
  return Math.min(workbenchVideoReferenceEnvelope(capability), maximum);
}

function normalizeReferences(track: PreparedVideoTrackInput): { references: NormalizedReference[]; error?: string } {
  const declared = Array.isArray(track.references) ? track.references : [];
  const resolved = Array.isArray(track.referenceContent) ? track.referenceContent : [];
  if (declared.length !== resolved.length) {
    return { references: [], error: "参考素材解析结果与请求不一致" };
  }

  const references: NormalizedReference[] = [];
  for (let index = 0; index < declared.length; index += 1) {
    const role = declared[index]?.role;
    const content = resolved[index];
    if (!REFERENCE_ROLES.has(role) || !content || content.reference_role !== role) {
      return { references: [], error: "参考素材角色映射无效" };
    }
    const kind = content.type === "image_url"
      ? "image"
      : content.type === "video_url"
        ? "video"
        : content.type === "audio_url"
          ? "audio"
          : "";
    if (!kind) return { references: [], error: "参考素材媒体类型无法映射到视频输入槽" };
    if (declared[index]?.mediaType !== undefined && declared[index]?.mediaType !== kind) {
      return { references: [], error: "参考素材声明类型与解析类型不一致" };
    }
    references.push({
      assetVersionId: String(declared[index]?.assetVersionId || ""),
      role,
      kind,
      trim: declared[index]?.trim !== undefined,
    });
  }
  return { references };
}

function candidateModes(references: NormalizedReference[]): string[] {
  if (!references.length) return ["text_to_video", "standard"];

  const hasImage = references.some((reference) => reference.kind === "image");
  const hasVideo = references.some((reference) => reference.kind === "video");
  const hasAudio = references.some((reference) => reference.kind === "audio");
  const hasGenericRole = references.some((reference) => GENERIC_REFERENCE_ROLES.includes(reference.role));
  const hasFirstFrame = references.some((reference) => reference.role === "first_frame");
  const hasLastFrame = references.some((reference) => reference.role === "last_frame");

  if (hasVideo || hasAudio) {
    return hasImage
      ? ["omni_reference", "reference_to_video", "video_edit"]
      : ["video_extension", "video_edit", "reference_to_video", "omni_reference"];
  }
  if (hasGenericRole) {
    return ["image_reference", "reference_to_video", "omni_reference", "image_to_video"];
  }
  if (hasFirstFrame && hasLastFrame) {
    return ["first_last_frame", "image_to_video", "reference_to_video", "omni_reference"];
  }
  return ["image_to_video", "first_last_frame", "reference_to_video", "omni_reference"];
}

function validateSlotsForMode(
  mode: string,
  slots: NormalizedSlot[],
  references: NormalizedReference[],
): string | null {
  const activeSlots = slots.filter((slot) => slot.modes.size === 0 || slot.modes.has(mode));
  if (references.length > 0 && activeSlots.length === 0) {
    return `视频模式 ${mode} 未声明可用输入槽`;
  }

  const counts = new Map(activeSlots.map((slot) => [slot.id, 0]));
  const seenBySlot = new Map(activeSlots.map((slot) => [slot.id, new Set<string>()]));
  for (const reference of references) {
    const compatible = activeSlots
      .filter((slot) => (
        slot.roles.has(reference.role)
        && slot.accepts.has(reference.kind)
        && (!reference.trim || slot.supportsTrim)
      ))
      .sort((left, right) => {
        const leftNeedsMinimum = Number(counts.get(left.id) || 0) < left.min ? 0 : 1;
        const rightNeedsMinimum = Number(counts.get(right.id) || 0) < right.min ? 0 : 1;
        return leftNeedsMinimum - rightNeedsMinimum
          || left.roles.size - right.roles.size
          || left.accepts.size - right.accepts.size
          || left.max - right.max;
      });
    const target = compatible.find((slot) => (
      Number(counts.get(slot.id) || 0) < slot.max
      && (slot.allowDuplicateAsset || !seenBySlot.get(slot.id)?.has(reference.assetVersionId))
    ));
    if (!target) {
      const roleSlots = activeSlots.filter((slot) => slot.roles.has(reference.role));
      if (!roleSlots.length) return `参考素材角色 ${reference.role} 不受视频模式 ${mode} 支持`;
      if (!roleSlots.some((slot) => slot.accepts.has(reference.kind))) {
        return `参考素材角色 ${reference.role} 不接受 ${reference.kind} 类型`;
      }
      if (reference.trim && !roleSlots.some((slot) => (
        slot.accepts.has(reference.kind) && slot.supportsTrim
      ))) {
        const label = reference.kind === "audio" ? "音频" : reference.kind === "video" ? "视频" : "图片";
        return `当前模型不支持裁剪参考${label}，请使用完整素材，或将所需片段另存为新素材后上传`;
      }
      if (compatible.some((slot) => (
        !slot.allowDuplicateAsset
        && seenBySlot.get(slot.id)?.has(reference.assetVersionId)
      ))) {
        return `参考素材 ${reference.assetVersionId} 不允许在同一输入槽重复使用`;
      }
      return `参考素材角色 ${reference.role} 超过输入槽数量上限`;
    }
    counts.set(target.id, Number(counts.get(target.id) || 0) + 1);
    seenBySlot.get(target.id)?.add(reference.assetVersionId);
  }

  for (const slot of activeSlots) {
    const count = Number(counts.get(slot.id) || 0);
    if (count < slot.min) return `${slot.label} 至少需要 ${slot.min} 个参考素材`;
  }
  return null;
}

export type WorkbenchVideoCapabilityProjection = {
  modes: string[];
  inputSlots: Array<{
    id: string;
    label: string;
    mediaTypes: ReferenceKind[];
    roles: ReferenceRole[];
    modes: string[];
    min: number;
    max: number;
    allowDuplicateAsset: boolean;
    supportsTrim: boolean;
  }>;
  totalInputLimit: number;
  mediaTypeLimits: Record<ReferenceKind, number>;
};

/** Strict, serializable view of the legacy capability grammar. */
export function projectWorkbenchVideoCapability(
  capability: VideoCapabilityInput,
): WorkbenchVideoCapabilityProjection | null {
  const declared = parseDeclaredModes(capability.modes);
  const parsed = parseSlots(capability.inputSlots);
  if (declared.error || parsed.error || parsed.slots.length === 0) return null;
  const declaredModes = new Set(declared.modes);
  if (parsed.slots.some((slot) => Array.from(slot.modes).some((mode) => !declaredModes.has(mode)))) {
    return null;
  }
  const inputSlots = parsed.slots.map((slot) => ({
    id: slot.id,
    label: slot.label,
    mediaTypes: Array.from(slot.accepts).sort(),
    roles: Array.from(slot.roles),
    modes: slot.modes.size ? Array.from(slot.modes) : [...declared.modes],
    min: slot.min,
    max: slot.max,
    allowDuplicateAsset: slot.allowDuplicateAsset,
    supportsTrim: slot.supportsTrim,
  }));
  const totalInputLimit = Math.min(
    workbenchVideoReferenceEnvelope(capability),
    Math.max(...declared.modes.map((mode) => inputSlots
      .filter((slot) => slot.modes.includes(mode))
      .reduce((sum, slot) => sum + slot.max, 0))),
  );
  const mediaTypeLimits = Object.fromEntries(
    (["image", "video", "audio"] as const).map((mediaType) => [
      mediaType,
      Math.min(
        totalInputLimit,
        inputSlots
          .filter((slot) => slot.mediaTypes.includes(mediaType))
          .reduce((sum, slot) => sum + slot.max, 0),
      ),
    ]),
  ) as Record<ReferenceKind, number>;
  return { modes: declared.modes, inputSlots, totalInputLimit, mediaTypeLimits };
}

export function validateWorkbenchVideoInputs(
  capability: VideoCapabilityInput,
  tracks: PreparedVideoTrackInput[],
): WorkbenchVideoInputValidation {
  const declared = parseDeclaredModes(capability.modes);
  if (declared.error) return { ok: false, message: declared.error };
  const parsedSlots = parseSlots(capability.inputSlots);
  if (parsedSlots.error) return { ok: false, message: parsedSlots.error };
  const declaredModeSet = new Set(declared.modes);
  if (parsedSlots.slots.some((slot) => Array.from(slot.modes).some((mode) => !declaredModeSet.has(mode)))) {
    return { ok: false, message: "视频模型输入槽引用了未声明的 mode" };
  }

  const selectedModes: string[] = [];
  for (const track of tracks) {
    const normalized = normalizeReferences(track);
    if (normalized.error) return { ok: false, message: normalized.error };
    const hasRequestedMode = track.mode !== undefined && track.mode !== null && String(track.mode).trim() !== "";
    const requestedMode = hasRequestedMode ? normalizeMode(track.mode) : "";
    if (hasRequestedMode && !requestedMode) {
      return { ok: false, message: "请求的视频生成 mode 无法识别" };
    }
    const candidates = candidateModes(normalized.references)
      .filter((mode) => declared.modes.includes(mode))
      .filter((mode) => !requestedMode || mode === requestedMode);
    if (!candidates.length) {
      return {
        ok: false,
        message: normalized.references.length
          ? "当前参考素材组合不受所选视频模型的生成模式支持"
          : "所选视频模型不支持文生视频模式",
      };
    }

    let firstError = "当前参考素材不符合视频模型输入槽要求";
    let selected = "";
    for (const mode of candidates) {
      const error = validateSlotsForMode(mode, parsedSlots.slots, normalized.references);
      if (!error) {
        selected = mode;
        break;
      }
      firstError = error;
    }
    if (!selected) return { ok: false, message: firstError };
    selectedModes.push(selected);
  }
  return { ok: true, modes: selectedModes };
}
