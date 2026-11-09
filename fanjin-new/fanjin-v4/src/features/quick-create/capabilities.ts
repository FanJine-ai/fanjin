export type QuickCreateCapabilitySnapshot = {
  director: boolean;
  image: boolean;
  video: boolean;
  music: boolean;
  voice: boolean;
  avatar: boolean;
  motion: boolean;
  creationSession: boolean;
  assetVersionReferences: boolean;
};

export const QUICK_CREATE_CAPABILITIES: QuickCreateCapabilitySnapshot = {
  director: true,
  image: true,
  video: true,
  music: false,
  voice: false,
  avatar: false,
  motion: false,
  creationSession: true,
  assetVersionReferences: false,
};

export const QUICK_CREATE_GENERATION_MODES = [
  { id: "agent", label: "Agent 模式", capability: "director" },
  { id: "image", label: "图片生成", capability: "image" },
  { id: "video", label: "视频生成", capability: "video" },
  { id: "music", label: "音乐生成", capability: "music" },
  { id: "voice", label: "配音生成", capability: "voice" },
  { id: "avatar", label: "数字人", capability: "avatar" },
  { id: "motion", label: "动作模仿", capability: "motion" },
] as const satisfies readonly {
  id: string;
  label: string;
  capability: keyof Pick<
    QuickCreateCapabilitySnapshot,
    "director" | "image" | "video" | "music" | "voice" | "avatar" | "motion"
  >;
}[];

export type QuickCreateGenerationMode = (typeof QUICK_CREATE_GENERATION_MODES)[number]["label"];
export type QuickCreateGenerationModeId = (typeof QUICK_CREATE_GENERATION_MODES)[number]["id"];

export function normalizeQuickCreateGenerationMode(
  value: string | null | undefined,
): QuickCreateGenerationMode | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  const normalizedId = normalized.toLowerCase();
  return QUICK_CREATE_GENERATION_MODES.find((mode) => (
    mode.id === normalizedId || mode.label === normalized
  ))?.label ?? null;
}

export function quickCreateGenerationModeId(
  mode: QuickCreateGenerationMode,
): QuickCreateGenerationModeId {
  return QUICK_CREATE_GENERATION_MODES.find((candidate) => candidate.label === mode)?.id ?? "agent";
}

export function isQuickCreateGenerationModeEnabled(
  mode: QuickCreateGenerationMode,
): boolean {
  const config = QUICK_CREATE_GENERATION_MODES.find((candidate) => candidate.label === mode);
  return config ? QUICK_CREATE_CAPABILITIES[config.capability] : false;
}

export function enabledQuickCreateGenerationModes(): QuickCreateGenerationMode[] {
  return QUICK_CREATE_GENERATION_MODES
    .filter((mode) => QUICK_CREATE_CAPABILITIES[mode.capability])
    .map((mode) => mode.label);
}
