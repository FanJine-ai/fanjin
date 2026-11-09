export type CreationMode = "quick" | "agent" | "canvas";
export type OutputType = "image" | "video";
export type ReferenceRole = "subject" | "style" | "storyboard" | "first_frame" | "last_frame";
export type QuickCreateImageQuality = "1K" | "2K" | "4K";

export const CREATION_MODES: readonly CreationMode[] = ["quick", "agent", "canvas"] as const;
export const OUTPUT_TYPES: readonly OutputType[] = ["image", "video"] as const;
export const REFERENCE_ROLES: readonly ReferenceRole[] = [
  "subject",
  "style",
  "storyboard",
  "first_frame",
  "last_frame",
] as const;

export type GenerationReference = {
  assetVersionId: string;
  role: ReferenceRole;
  mediaType?: "image" | "video" | "audio";
  order?: number;
  trim?: { startMs: number; endMs: number };
};

export type QuickCreateParameters = {
  ratio: string;
  imageModel?: string;
  imageQuality?: QuickCreateImageQuality;
  videoModel?: string;
  resolution?: string;
  audio?: boolean;
  duration: number;
  shotCount: number;
};

export type QuickCreateSessionSnapshot = {
  id: string;
  workspaceId: string;
  projectId: string;
  mode: CreationMode;
  goal: string;
  outputType: OutputType;
  references: GenerationReference[];
  skillIds: string[];
  parameters: QuickCreateParameters;
  directorPlanId?: string;
  selectedAssetVersionIds: string[];
  activeTaskIds: string[];
  updatedAt: string;
};
