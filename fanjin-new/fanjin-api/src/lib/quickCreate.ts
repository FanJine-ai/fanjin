export type QuickCreateRatio = `${number}:${number}`;

export interface QuickCreateDirectorInput {
  brief: string;
  style?: string | null;
  targetType?: string | null;
  ratio: QuickCreateRatio;
  duration: number;
  shotCount: number;
}

export interface QuickCreateShot {
  title: string;
  script: string;
  visual: string;
  prompt: string;
  duration: number;
  track: string;
  characterIds?: string[];
  sceneId?: string;
  assetIds?: string[];
  basePrompt?: string;
}

export interface QuickCreateDirectorResource {
  id: string;
  name: string;
  description: string;
}

export interface QuickCreateDirectorPlan {
  title: string;
  simpleScript: string;
  stylePrompt: string;
  ratio: QuickCreateRatio;
  duration: number;
  shots: QuickCreateShot[];
  characters?: QuickCreateDirectorResource[];
  scenes?: QuickCreateDirectorResource[];
  assets?: QuickCreateDirectorResource[];
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function cleanText(value: unknown): string {
  return String(value || "").trim();
}

function normalizeRatio(value: unknown): QuickCreateRatio {
  const ratio = cleanText(value);
  const match = ratio.match(/^(\d{1,3}):(\d{1,3})$/);
  if (!match) return "16:9";
  const width = clampInt(match[1], 1, 100, 16);
  const height = clampInt(match[2], 1, 100, 9);
  return `${width}:${height}`;
}

function padShotIndex(index: number): string {
  return String(index + 1).padStart(2, "0");
}

function distributeDurations(total: number, count: number): number[] {
  const safeTotal = clampInt(total, 4, 60, 15);
  const safeCount = clampInt(count, 1, 8, 3);
  // 当 count > total 时，每个分镜至少 1 秒，总数可能超过 total
  // 此时限制分镜数为 total，避免时长翻倍
  const effectiveCount = Math.min(safeCount, safeTotal);
  const base = Math.max(1, Math.floor(safeTotal / effectiveCount));
  const durations = Array.from({ length: effectiveCount }, () => base);
  let remaining = safeTotal - durations.reduce((sum, item) => sum + item, 0);
  let index = 0;
  while (remaining > 0) {
    durations[index % effectiveCount] += 1;
    remaining -= 1;
    index += 1;
  }
  while (remaining < 0) {
    const targetIndex = durations.findIndex((item) => item > 1);
    if (targetIndex === -1) break;
    durations[targetIndex] -= 1;
    remaining += 1;
  }
  return durations;
}

export function normalizeDirectorInput(input: QuickCreateDirectorInput): QuickCreateDirectorInput {
  return {
    brief: cleanText(input.brief),
    style: cleanText(input.style),
    targetType: cleanText(input.targetType) || "短视频",
    ratio: normalizeRatio(input.ratio),
    duration: clampInt(input.duration, 4, 60, 15),
    shotCount: clampInt(input.shotCount, 1, 8, 3),
  };
}

export function summarizeBriefTitle(brief: string): string {
  const normalized = cleanText(brief)
    .replace(/\d+\s*秒/g, "")
    .replace(/\d+\s*s/gi, "")
    .replace(/\s+/g, "");
  if (!normalized) return "快速创作";
  return normalized.slice(0, 14);
}

export function buildDirectorPlanPrompt(input: QuickCreateDirectorInput): string {
  const normalized = normalizeDirectorInput(input);
  return [
    "你是 Fanjin 的 AI 导演。请把用户的一句话创意扩写成可直接生成视频的简单剧本和分镜。",
    "只返回 JSON，不要返回 Markdown，不要解释。",
    "JSON 字段必须是：title, simpleScript, stylePrompt, characters, scenes, assets, shots。",
    "characters, scenes, assets 都是对象数组，每项包含 name 和 description。",
    "shots 是数组，每个元素必须包含 title, script, visual, prompt，并用 characters、scene、assets 按名称写出角色、场景和素材引用。",
    `创意 brief：${normalized.brief}`,
    `目标类型：${normalized.targetType || "短视频"}`,
    `视觉风格：${normalized.style || "高级、清晰、商业化"}`,
    `画幅比例：${normalized.ratio}`,
    `总时长：${normalized.duration} 秒`,
    `镜头数：${normalized.shotCount}`,
    "要求：每个 prompt 必须是适合视频生成模型的画面提示词，包含主体、动作、环境、镜头语言和风格。",
  ].join("\n");
}

export function extractJsonObject(text: string): Record<string, unknown> {
  const raw = cleanText(text);
  if (!raw) throw new Error("AI 未返回内容");
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced || raw;
  const direct = candidate.trim();
  if (direct.startsWith("{") && direct.endsWith("}")) return JSON.parse(direct);

  const start = candidate.indexOf("{");
  if (start === -1) throw new Error("AI 返回内容中没有 JSON 对象");

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < candidate.length; i += 1) {
    const char = candidate[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return JSON.parse(candidate.slice(start, i + 1));
    }
  }
  throw new Error("AI 返回的 JSON 对象不完整");
}

function readShots(raw: any): any[] {
  if (Array.isArray(raw?.shots)) return raw.shots;
  if (Array.isArray(raw?.storyboard)) return raw.storyboard;
  if (Array.isArray(raw?.shotList)) return raw.shotList;
  return [];
}

function normalizeDirectorResources(value: unknown, prefix: "character" | "scene" | "asset"): QuickCreateDirectorResource[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).flatMap((entry, index) => {
    const source = entry && typeof entry === "object" && !Array.isArray(entry)
      ? entry as Record<string, unknown>
      : null;
    const name = cleanText(source?.name ?? source?.title ?? entry);
    if (!name) return [];
    const description = cleanText(
      source?.description
      ?? source?.appearance
      ?? source?.location
      ?? source?.purpose
      ?? source?.source,
    );
    return [{ id: `${prefix}-${index + 1}`, name, description }];
  });
}

function resourceReferenceValues(raw: any, keys: string[]): string[] {
  for (const key of keys) {
    const value = raw?.[key];
    if (Array.isArray(value)) {
      return value.map((entry) => cleanText(
        entry && typeof entry === "object" && !Array.isArray(entry)
          ? (entry as Record<string, unknown>).name ?? (entry as Record<string, unknown>).id
          : entry,
      )).filter(Boolean);
    }
    const single = cleanText(
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>).name ?? (value as Record<string, unknown>).id
        : value,
    );
    if (single) return [single];
  }
  return [];
}

function linkedResourceIds(resources: QuickCreateDirectorResource[], references: string[]) {
  const normalized = new Set(references.map((reference) => reference.toLocaleLowerCase()));
  return resources
    .filter((resource) => normalized.has(resource.id.toLocaleLowerCase()) || normalized.has(resource.name.toLocaleLowerCase()))
    .map((resource) => resource.id);
}

function resourcePromptLabel(resource: QuickCreateDirectorResource) {
  return resource.description ? `${resource.name}（${resource.description}）` : resource.name;
}

function normalizeShot(
  raw: any,
  index: number,
  fallbackPrompt: string,
  duration: number,
  resources: {
    characters: QuickCreateDirectorResource[];
    scenes: QuickCreateDirectorResource[];
    assets: QuickCreateDirectorResource[];
  },
): QuickCreateShot {
  const title = cleanText(raw?.title) || `镜头 ${padShotIndex(index)}`;
  const script = cleanText(raw?.script) || cleanText(raw?.content) || fallbackPrompt;
  const visual = cleanText(raw?.visual) || cleanText(raw?.description) || script;
  const basePrompt = cleanText(raw?.prompt) || cleanText(raw?.videoPrompt) || [visual, script].filter(Boolean).join("，");
  const characterIds = linkedResourceIds(resources.characters, resourceReferenceValues(raw, ["characterIds", "characters", "characterNames"]));
  const sceneIds = linkedResourceIds(resources.scenes, resourceReferenceValues(raw, ["sceneId", "scene", "sceneName"]));
  const assetIds = linkedResourceIds(resources.assets, resourceReferenceValues(raw, ["assetIds", "assets", "assetNames", "materials"]));
  const controls = [
    characterIds.length
      ? `角色：${resources.characters.filter((resource) => characterIds.includes(resource.id)).map(resourcePromptLabel).join("、")}`
      : "",
    sceneIds[0]
      ? `场景：${resourcePromptLabel(resources.scenes.find((resource) => resource.id === sceneIds[0])!)}`
      : "",
    assetIds.length
      ? `素材：${resources.assets.filter((resource) => assetIds.includes(resource.id)).map(resourcePromptLabel).join("、")}`
      : "",
  ].filter(Boolean);
  const prompt = [basePrompt, ...controls].filter(Boolean).join("；");
  return {
    title,
    script,
    visual,
    prompt: prompt || fallbackPrompt,
    duration,
    track: cleanText(raw?.track) || `镜头${padShotIndex(index)}`,
    ...(characterIds.length ? { characterIds } : {}),
    ...(sceneIds[0] ? { sceneId: sceneIds[0] } : {}),
    ...(assetIds.length ? { assetIds } : {}),
    ...(controls.length ? { basePrompt: basePrompt || fallbackPrompt } : {}),
  };
}

export function normalizeDirectorPlan(raw: unknown, input: QuickCreateDirectorInput): QuickCreateDirectorPlan {
  const normalizedInput = normalizeDirectorInput(input);
  const data = raw && typeof raw === "object" ? (raw as Record<string, any>) : {};
  const title = cleanText(data.title) || summarizeBriefTitle(normalizedInput.brief);
  const simpleScript = cleanText(data.simpleScript) || cleanText(data.script) || normalizedInput.brief;
  const stylePrompt = cleanText(data.stylePrompt) || cleanText(data.style) || normalizedInput.style || "高级、清晰、商业化";
  const durations = distributeDurations(normalizedInput.duration, normalizedInput.shotCount);
  const rawShots = readShots(data);
  const resources = {
    characters: normalizeDirectorResources(data.characters ?? data.roles, "character"),
    scenes: normalizeDirectorResources(data.scenes ?? data.locations, "scene"),
    assets: normalizeDirectorResources(data.assets ?? data.materials, "asset"),
  };
  const shots = durations.map((duration, index) => {
    const rawShot = rawShots[index] || rawShots[rawShots.length - 1] || {};
    return normalizeShot(rawShot, index, simpleScript, duration, resources);
  });

  return {
    title,
    simpleScript,
    stylePrompt,
    ratio: normalizedInput.ratio,
    duration: durations.reduce((sum, item) => sum + item, 0),
    shots,
    ...(resources.characters.length ? { characters: resources.characters } : {}),
    ...(resources.scenes.length ? { scenes: resources.scenes } : {}),
    ...(resources.assets.length ? { assets: resources.assets } : {}),
  };
}
