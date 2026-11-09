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

const USAGE_TAG_PREFIX = "fanjin:usage:";
const EXPLICIT_UNCATEGORIZED_TAG = `${USAGE_TAG_PREFIX}uncategorized`;
const GROUP_TAG_PREFIX = "fanjin:group:";

export function normalizeAssetTags(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0)
      .map((tag) => tag.trim());
  }
  if (typeof value !== "string") return [];
  try {
    return normalizeAssetTags(JSON.parse(value));
  } catch {
    return [];
  }
}

export function defaultUsageFromAssetType(value: unknown): AssetUsage | null {
  if (value === "role" || value === "scene" || value === "tool" || value === "audio") {
    return value;
  }
  return null;
}

export function usageFromTags(value: unknown, assetType?: unknown): AssetUsage | null {
  const tag = normalizeAssetTags(value).find((item) => item.startsWith(USAGE_TAG_PREFIX));
  const usage = tag?.slice(USAGE_TAG_PREFIX.length);
  if (usage === "uncategorized") return null;
  return ASSET_USAGE_VALUES.includes(usage as AssetUsage)
    ? usage as AssetUsage
    : defaultUsageFromAssetType(assetType);
}

export function hasExplicitUsageTag(value: unknown): boolean {
  return normalizeAssetTags(value).some((item) => item.startsWith(USAGE_TAG_PREFIX));
}

export function groupFromTags(value: unknown): { id: string; name: string; usage: AssetUsage } | null {
  const tag = normalizeAssetTags(value).find((item) => item.startsWith(GROUP_TAG_PREFIX));
  if (!tag) return null;
  const [, , id, usage, encodedName] = tag.split(":", 5);
  if (!id || !encodedName || !ASSET_USAGE_VALUES.includes(usage as AssetUsage)) return null;
  try {
    return { id, usage: usage as AssetUsage, name: decodeURIComponent(encodedName) || "未命名分组" };
  } catch {
    return null;
  }
}

export function setUsageTag(value: unknown, usage: AssetUsage | null): string[] {
  const tags = normalizeAssetTags(value).filter((tag) => !tag.startsWith(USAGE_TAG_PREFIX));
  return usage ? [...tags, `${USAGE_TAG_PREFIX}${usage}`] : [...tags, EXPLICIT_UNCATEGORIZED_TAG];
}

export function setGroupTag(value: unknown, group: { id: string; name: string; usage: AssetUsage } | null): string[] {
  const tags = normalizeAssetTags(value).filter((tag) => !tag.startsWith(GROUP_TAG_PREFIX));
  return group
    ? [...tags, `${GROUP_TAG_PREFIX}${group.id}:${group.usage}:${encodeURIComponent(group.name)}`]
    : tags;
}

export function visibleAssetTags(value: unknown): string[] {
  return normalizeAssetTags(value).filter((tag) => !tag.startsWith("fanjin:"));
}
