import type { Asset } from "../../api/types";

export const ASSET_USAGE_VALUES = [
  "role",
  "scene",
  "tool",
  "action",
  "audio",
  "camera",
  "style",
  "composition",
  "other",
] as const;

export type AssetUsage = (typeof ASSET_USAGE_VALUES)[number];

export const ASSET_USAGE_LABELS: Record<AssetUsage, string> = {
  role: "角色 / 人物",
  scene: "场景",
  tool: "道具",
  action: "动作参考",
  audio: "声音",
  camera: "运镜参考",
  style: "风格参考",
  composition: "分镜",
  other: "其他",
};

function normalizedTags(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0).map((tag) => tag.trim())
    : [];
}

export function assetUsageFromTags(tags: unknown, type?: Asset["type"]): AssetUsage | null {
  const raw = normalizedTags(tags).find((tag) => tag.startsWith("fanjin:usage:"))?.slice("fanjin:usage:".length);
  if (raw === "uncategorized") return null;
  if (ASSET_USAGE_VALUES.includes(raw as AssetUsage)) return raw as AssetUsage;
  if (type === "role" || type === "scene" || type === "tool" || type === "audio") return type;
  return null;
}

export function assetGroupFromTags(tags: unknown): { id: string; name: string; usage: AssetUsage } | null {
  const tag = normalizedTags(tags).find((item) => item.startsWith("fanjin:group:"));
  if (!tag) return null;
  const [, , id, usage, encodedName] = tag.split(":", 5);
  if (!id || !encodedName || !ASSET_USAGE_VALUES.includes(usage as AssetUsage)) return null;
  try {
    return { id, usage: usage as AssetUsage, name: decodeURIComponent(encodedName) || "未命名分组" };
  } catch {
    return null;
  }
}
