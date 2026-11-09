export type CanvasGenerationMediaType = "image" | "video";

export const CANVAS_CAMERA_SEMANTIC_PREFIX = "镜头语义：";

export function buildCanvasCameraControlPatch<T extends object>(
  cameraSettings: T,
  cameraControl: string,
) {
  return {
    cameraSettings: { ...cameraSettings },
    cameraControl: String(cameraControl || "").trim(),
  };
}

function normalizedPromptLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function appendCanvasCameraSemantics(prompt: string, cameraControl?: string): string {
  const basePrompt = String(prompt || "").trim();
  const normalizedCameraControl = String(cameraControl || "").trim();
  if (!normalizedCameraControl) return basePrompt;

  const cameraSemantic = `${CANVAS_CAMERA_SEMANTIC_PREFIX}${normalizedCameraControl}`;
  if (normalizedPromptLines(basePrompt).includes(cameraSemantic)) return basePrompt;
  return [basePrompt, cameraSemantic].filter(Boolean).join("\n");
}

export function buildCanvasGenerationPrompt(input: {
  mediaType: CanvasGenerationMediaType;
  prompt: string;
  upstreamTextPrompts: string[];
  storyboardPrompts?: string[];
  cameraControl?: string;
  /**
   * A text node wired into an image node is the current generation input.
   * Keep this opt-in so other canvas flows retain their existing prompt rules.
   */
  preferUpstreamText?: boolean;
}): string {
  const directPrompt = String(input.prompt || "").trim();
  const inheritedPrompt = input.upstreamTextPrompts
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join("\n");
  const basePrompt = input.preferUpstreamText && inheritedPrompt
    ? inheritedPrompt
    : directPrompt || inheritedPrompt;

  const storyboardPrompts = input.mediaType === "video" ? input.storyboardPrompts?.filter((prompt) => prompt.trim()) || [] : [];
  const videoPrompt = storyboardPrompts.length ? [
    "以接入的分镜图片为视觉依据生成视频，保持人物、场景和道具外观一致。按照以下分镜描述表现动作、运镜、节奏及对白（如有），不要生成静态拼图或文字说明。",
    ...storyboardPrompts,
    basePrompt ? `补充视频要求：${basePrompt}` : "",
  ].filter(Boolean).join("\n\n") : basePrompt;
  return appendCanvasCameraSemantics(videoPrompt, input.cameraControl);
}
