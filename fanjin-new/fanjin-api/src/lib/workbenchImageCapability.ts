import { GENERATION_REFERENCE_ROLES, type GenerationReference } from "@/lib/generationReferenceResolver";
type ImageReferenceRole = GenerationReference["role"];
type ImageSlotMediaKind = "image" | "video" | "file";

type NormalizedImageInputSlot = {
  id: string;
  label: string;
  accepts: Set<ImageSlotMediaKind>;
  roles: Set<ImageReferenceRole>;
  min: number;
  max: number;
};

type ImageReferenceInputValidation =
  | { ok: true; imageUrls: string[] }
  | { ok: false; message: string };

const IMAGE_REFERENCE_ROLES = new Set<ImageReferenceRole>(GENERATION_REFERENCE_ROLES);
const GENERIC_IMAGE_REFERENCE_ROLES: ImageReferenceRole[] = ["subject", "style", "storyboard"];

function slotToken(value: unknown): string {
  return typeof value === "string"
    ? value.trim().toLowerCase().replace(/[\s-]+/g, "_")
    : "";
}

function slotList(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return value.split(",");
  return null;
}

function normalizeImageSlotRoles(value: unknown): ImageReferenceRole[] {
  const normalized = slotToken(value);
  if (IMAGE_REFERENCE_ROLES.has(normalized as ImageReferenceRole)) {
    return [normalized as ImageReferenceRole];
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
    "reference_image",
    "image_reference",
    "reference_images",
    "image_references",
  ].includes(normalized)) {
    return [...GENERIC_IMAGE_REFERENCE_ROLES];
  }
  return [];
}

function normalizeImageSlotAccept(value: unknown): ImageSlotMediaKind | "" {
  const normalized = slotToken(value);
  if (["image", "images", "image_url"].includes(normalized) || normalized.startsWith("image/")) return "image";
  if (["video", "videos", "video_url"].includes(normalized) || normalized.startsWith("video/")) return "video";
  if (
    ["file", "files", "document", "audio", "audio_url"].includes(normalized)
    || normalized.startsWith("audio/")
    || normalized.startsWith("application/")
  ) return "file";
  return "";
}

function imageSlotInteger(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
  const normalized = Number(value);
  return Number.isSafeInteger(normalized) ? normalized : null;
}

function parseImageInputSlots(value: unknown): { slots: NormalizedImageInputSlot[]; error?: string } {
  if (!Array.isArray(value) || value.length === 0) {
    return { slots: [], error: "当前图片模型目录未声明参考图 inputSlot" };
  }

  const slots: NormalizedImageInputSlot[] = [];
  const slotIds = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const raw = value[index];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { slots: [], error: `图片模型第 ${index + 1} 个 inputSlot 声明无效` };
    }
    const slot = raw as Record<string, unknown>;
    const id = typeof slot.id === "string" && slot.id.trim()
      ? slot.id.trim()
      : typeof slot.role === "string" && slot.role.trim()
        ? slot.role.trim()
        : "";
    const rawRoles = slotList(slot.roles ?? slot.referenceRoles ?? slot.acceptedRoles)
      ?? [slot.role ?? slot.id];
    const roles = new Set<ImageReferenceRole>();
    for (const rawRole of rawRoles) {
      const normalizedRoles = normalizeImageSlotRoles(rawRole);
      if (!normalizedRoles.length) {
        return { slots: [], error: `图片模型 inputSlot ${id || index + 1} 的 role 声明无效` };
      }
      normalizedRoles.forEach((role) => roles.add(role));
    }

    const rawAccepts = slotList(slot.accepts ?? slot.accept);
    if (!rawAccepts?.length) {
      return { slots: [], error: `图片模型 inputSlot ${id || index + 1} 缺少 accepts 声明` };
    }
    const accepts = new Set<ImageSlotMediaKind>();
    for (const rawAccept of rawAccepts) {
      const normalizedAccept = normalizeImageSlotAccept(rawAccept);
      if (!normalizedAccept) {
        return { slots: [], error: `图片模型 inputSlot ${id || index + 1} 的 accepts 声明无效` };
      }
      accepts.add(normalizedAccept);
    }

    const required = slot.required === undefined ? false : slot.required;
    if (typeof required !== "boolean") {
      return { slots: [], error: `图片模型 inputSlot ${id || index + 1} 的 required 声明无效` };
    }
    const min = slot.min === undefined ? (required ? 1 : 0) : imageSlotInteger(slot.min);
    const max = slot.max === undefined
      ? Math.max(typeof min === "number" ? min : 0, 1)
      : imageSlotInteger(slot.max);
    if (
      !id
      || slotIds.has(id)
      || roles.size === 0
      || accepts.size === 0
      || min === null
      || max === null
      || min < 0
      || max < 1
      || max < min
      || (required && min < 1)
    ) {
      return { slots: [], error: `图片模型 inputSlot ${id || index + 1} 的 role/accepts/min/max 声明不完整` };
    }
    slotIds.add(id);
    slots.push({
      id,
      label: typeof slot.label === "string" && slot.label.trim() ? slot.label.trim() : id,
      accepts,
      roles,
      min,
      max,
    });
  }
  return { slots };
}

export function validateImageReferenceInputs(
  inputSlots: unknown,
  references: GenerationReference[],
  referenceContent: Record<string, unknown>[],
): ImageReferenceInputValidation {
  const parsed = parseImageInputSlots(inputSlots);
  if (parsed.error) return { ok: false, message: parsed.error };
  if (references.length !== referenceContent.length) {
    return { ok: false, message: "图片参考素材解析结果与请求不一致" };
  }

  const normalized: Array<{ role: ImageReferenceRole; url: string }> = [];
  for (let index = 0; index < references.length; index += 1) {
    const reference = references[index];
    const content = referenceContent[index];
    if (!content || content.reference_role !== reference.role) {
      return { ok: false, message: "图片参考素材角色映射无效" };
    }
    if (content.type !== "image_url") {
      return { ok: false, message: "图片生成不支持视频参考素材" };
    }
    const imageUrl = content.image_url;
    const url = imageUrl && typeof imageUrl === "object" && !Array.isArray(imageUrl)
      ? (imageUrl as Record<string, unknown>).url
      : null;
    if (typeof url !== "string" || !url.trim()) {
      return { ok: false, message: "图片参考素材缺少可用的 image_url.url" };
    }
    normalized.push({ role: reference.role, url: url.trim() });
  }

  const counts = new Map(parsed.slots.map((slot) => [slot.id, 0]));
  for (const reference of normalized) {
    const compatible = parsed.slots
      .filter((slot) => slot.roles.has(reference.role) && slot.accepts.has("image"))
      .sort((left, right) => {
        const leftNeedsMinimum = Number(counts.get(left.id) || 0) < left.min ? 0 : 1;
        const rightNeedsMinimum = Number(counts.get(right.id) || 0) < right.min ? 0 : 1;
        return leftNeedsMinimum - rightNeedsMinimum
          || left.roles.size - right.roles.size
          || left.max - right.max;
      });
    const target = compatible.find((slot) => Number(counts.get(slot.id) || 0) < slot.max);
    if (!target) {
      const roleSlots = parsed.slots.filter((slot) => slot.roles.has(reference.role));
      if (!roleSlots.length) {
        return { ok: false, message: `图片参考素材角色 ${reference.role} 未声明对应 inputSlot` };
      }
      if (!roleSlots.some((slot) => slot.accepts.has("image"))) {
        return { ok: false, message: `图片参考素材角色 ${reference.role} 的 inputSlot 不接受 image 类型` };
      }
      return { ok: false, message: `图片参考素材角色 ${reference.role} 超过 inputSlot 数量上限` };
    }
    counts.set(target.id, Number(counts.get(target.id) || 0) + 1);
  }

  for (const slot of parsed.slots) {
    const count = Number(counts.get(slot.id) || 0);
    if (count < slot.min) {
      return { ok: false, message: `${slot.label} 至少需要 ${slot.min} 个图片参考素材` };
    }
  }
  return { ok: true, imageUrls: normalized.map((reference) => reference.url) };
}
