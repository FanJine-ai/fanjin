import type {
  QuickCreateDirectorPayload,
  QuickCreateDirectorPlan,
  QuickCreateRatio,
} from "@/features/quick-create/types";

const DEFAULT_STORY_RATIO: QuickCreateRatio = "16:9";
const DEFAULT_STORY_DURATION_SECONDS = 15;
const DEFAULT_STORY_SHOT_COUNT = 3;

export function resolveCanvasStoryRatio(value: unknown): QuickCreateRatio {
  const normalized = String(value || "").trim();
  return /^\d{1,3}:\d{1,3}$/.test(normalized)
    ? normalized as QuickCreateRatio
    : DEFAULT_STORY_RATIO;
}

export function buildCanvasStoryDirectorPayload(input: {
  prompt: string;
  modelId: string;
  ratio?: unknown;
}): QuickCreateDirectorPayload {
  return {
    brief: input.prompt.trim(),
    targetType: "故事脚本",
    ratio: resolveCanvasStoryRatio(input.ratio),
    llmModel: input.modelId.trim(),
    duration: DEFAULT_STORY_DURATION_SECONDS,
    shotCount: DEFAULT_STORY_SHOT_COUNT,
  };
}

export function formatCanvasDirectorPlan(plan: QuickCreateDirectorPlan): string {
  const lines = [
    plan.title.trim() ? `# ${plan.title.trim()}` : "",
    plan.simpleScript.trim(),
    plan.stylePrompt.trim() ? `风格：${plan.stylePrompt.trim()}` : "",
  ].filter(Boolean);

  plan.shots.forEach((shot, index) => {
    const title = shot.title.trim() || `镜头 ${index + 1}`;
    const details = [
      shot.script.trim() ? `台词/旁白：${shot.script.trim()}` : "",
      shot.visual.trim() ? `画面：${shot.visual.trim()}` : "",
      shot.prompt.trim() ? `生成提示词：${shot.prompt.trim()}` : "",
      Number.isFinite(shot.duration) && shot.duration > 0 ? `时长：${shot.duration} 秒` : "",
    ].filter(Boolean);
    lines.push(`## ${index + 1}. ${title}`, ...details);
  });

  return lines.join("\n\n").trim();
}

export function resolveCanvasTextGenerationAttemptId(existingAttemptId?: string) {
  const existing = String(existingAttemptId || "").trim();
  if (existing) return existing;
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `canvas-text-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function buildCanvasTextIdempotencyKey(input: {
  nodeId: string;
  attemptId: string;
}) {
  return `canvas:text:${input.nodeId}:${input.attemptId}`;
}

export function shouldRetainCanvasTextGenerationAttempt(status?: number | null) {
  return status == null || status === 409 || status >= 500;
}
