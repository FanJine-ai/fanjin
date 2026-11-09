const MAX_RELATED_OBJECTS_SOURCE_LENGTH = 64 * 1024;
const MAX_RELATED_OBJECTS_DEPTH = 5;
const MAX_RELATED_OBJECTS_NODES = 128;
const MAX_DISPLAY_COUNT = 99;

const RELATED_OBJECT_LABEL_ORDER = [
  "项目",
  "剧本",
  "分镜",
  "素材版本",
  "素材",
  "任务",
  "结果",
  "模型服务",
  "工作区",
  "生成参数",
  "上下文",
  "关联信息",
] as const;

type RelatedObjectLabel = (typeof RELATED_OBJECT_LABEL_ORDER)[number];

function relatedObjectLabel(key: string): RelatedObjectLabel | null {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!normalized) return null;
  if (normalized.includes("assetversion")) return "素材版本";
  if (normalized.includes("project")) return "项目";
  if (
    normalized.includes("storyboard")
    || normalized.includes("track")
    || normalized.includes("clip")
  ) return "分镜";
  if (
    normalized.includes("script")
    || normalized.includes("novel")
    || normalized.includes("chapter")
  ) return "剧本";
  if (
    normalized.includes("asset")
    || normalized.includes("image")
    || normalized.includes("video")
    || normalized.includes("audio")
    || normalized.includes("media")
    || normalized.includes("reference")
  ) return "素材";
  if (
    normalized.includes("request")
    || normalized.includes("task")
    || normalized.includes("command")
    || normalized.includes("job")
    || normalized.includes("run")
  ) return "任务";
  if (
    normalized.includes("result")
    || normalized.includes("output")
    || normalized.includes("storage")
    || normalized.includes("file")
    || normalized.includes("url")
  ) return "结果";
  if (
    normalized.includes("channel")
    || normalized.includes("apikey")
    || normalized.includes("provider")
    || normalized.includes("endpoint")
    || normalized.includes("model")
    || normalized.includes("route")
  ) return "模型服务";
  if (normalized.includes("workspace")) return "工作区";
  if (
    normalized.includes("prompt")
    || normalized.includes("quality")
    || normalized.includes("size")
    || normalized.includes("ratio")
    || normalized.includes("resolution")
    || normalized.includes("duration")
  ) return "生成参数";
  if (
    normalized.includes("version")
    || normalized.includes("snapshot")
    || normalized.includes("hash")
    || normalized.includes("type")
    || normalized.includes("flow")
    || normalized.includes("state")
    || normalized.includes("status")
  ) return "上下文";
  return null;
}

function relatedValueCount(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "string") return value.trim() ? 1 : 0;
  if (Array.isArray(value)) {
    return value.reduce((count, item) => count + (relatedValueCount(item) > 0 ? 1 : 0), 0);
  }
  return 1;
}

function displayCount(count: number) {
  return count > MAX_DISPLAY_COUNT ? `${MAX_DISPLAY_COUNT}+` : String(count);
}

/**
 * Turns opaque task metadata into a bounded, non-sensitive summary. Neither
 * source keys nor source values are returned, so IDs and provider metadata
 * cannot leak through the task list or detail view.
 */
export function summarizeRelatedObjects(value?: string | null): string {
  if (typeof value !== "string" || !value.trim()) return "-";
  if (value.length > MAX_RELATED_OBJECTS_SOURCE_LENGTH) return "关联信息 1 项";

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return "关联信息 1 项";
  }
  if (parsed === null || parsed === undefined) return "-";

  const counts = new Map<RelatedObjectLabel, number>();
  const budget = { remaining: MAX_RELATED_OBJECTS_NODES, exhausted: false };
  const add = (label: RelatedObjectLabel, count: number) => {
    if (count <= 0) return;
    counts.set(label, (counts.get(label) || 0) + count);
  };
  const visit = (current: unknown, key: string | null, depth: number) => {
    if (current === null || current === undefined) return;
    if (budget.remaining <= 0) {
      if (!budget.exhausted) {
        add("关联信息", 1);
        budget.exhausted = true;
      }
      return;
    }
    budget.remaining -= 1;

    const label = key ? relatedObjectLabel(key) : null;
    if (label) {
      add(label, relatedValueCount(current));
      return;
    }
    if (depth >= MAX_RELATED_OBJECTS_DEPTH) {
      add("关联信息", relatedValueCount(current));
      return;
    }
    if (Array.isArray(current)) {
      current.forEach((item) => visit(item, null, depth + 1));
      return;
    }
    if (typeof current === "object") {
      Object.entries(current as Record<string, unknown>)
        .forEach(([childKey, childValue]) => visit(childValue, childKey, depth + 1));
      return;
    }
    add("关联信息", relatedValueCount(current));
  };

  visit(parsed, null, 0);
  const parts = RELATED_OBJECT_LABEL_ORDER.flatMap((label) => {
    const count = counts.get(label) || 0;
    return count > 0 ? [`${label} ${displayCount(count)} 项`] : [];
  });
  return parts.length > 0 ? parts.join(" · ") : "-";
}
