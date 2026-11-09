import type { GenerationReference } from "./contracts";
import type { ReferenceAttachmentMimeCategory } from "./attachments/api";
import type { StructuredThirtySecondTimeline } from "./structuredTimeline";
import type { CommerceVariantBatch, QuickWorkflowBrief } from "./quickModeWorkflow";

export type QuickCreateRatio = `${number}:${number}` | "adaptive";
export type QuickCreateImageQuality = "1K" | "2K" | "4K";

export type CreativeTaskStatus = "queued" | "running" | "enhancing" | "pending_reconcile" | "succeeded" | "failed" | "cancelled";

export type QuickCreateDirectorPayload = {
  projectId?: number;
  brief: string;
  style?: string;
  targetType?: string;
  ratio: QuickCreateRatio;
  llmModel?: string;
  duration: number;
  shotCount: number;
};

export type QuickCreateShot = {
  title: string;
  script: string;
  visual: string;
  prompt: string;
  duration: number;
  track: string;
  storyboardId?: number;
  trackId?: number;
  scriptId?: number;
  projectId?: number;
  shotSize?: string;
  camera?: string;
  movement?: string;
  action?: string;
  style?: string;
  generationMethod?: "文生视频" | "图生视频" | "视频转绘" | "片段重拍" | string;
  basePrompt?: string;
  characterIds?: string[];
  sceneId?: string;
  assetIds?: string[];
};

export type QuickCreateDirectorResource = {
  id: string;
  name: string;
  description: string;
};

export type QuickCreateDirectorPlan = {
  title: string;
  simpleScript: string;
  stylePrompt: string;
  ratio: QuickCreateRatio;
  duration: number;
  shots: QuickCreateShot[];
  characters?: QuickCreateDirectorResource[];
  scenes?: QuickCreateDirectorResource[];
  assets?: QuickCreateDirectorResource[];
};

export type QuickCreateMaterializePayload = {
  sourceProjectId?: number;
  brief?: string;
  targetType?: string;
  generationMode?: "image" | "video" | "closed_loop";
  plan: QuickCreateDirectorPlan;
  imageModel?: string;
  videoModel?: string;
  imageQuality?: string;
  purpose?: "project" | "inspiration";
};

export type QuickCreateMaterializedProject = {
  project: {
    id: number;
    name: string;
    videoRatio: string;
    mode: string;
  };
  script: {
    id: number;
    name: string;
    content: string;
  };
  shots: QuickCreateShot[];
};

export type QuickCreateVideoPayload = {
  projectId: number;
  scriptId: number;
  model: string;
  resolution: string;
  outputFormat?: "mp4" | "mov";
  audio?: boolean;
  structuredTimeline?: StructuredThirtySecondTimeline;
  trackData: Array<{
    trackId: number;
    prompt: string;
    duration: number;
    mode?: string;
    operation?: "generate" | "extend" | "edit";
    references?: GenerationReference[];
    uploadData?: Array<{ id: number; sources: string }>;
  }>;
};

export type QuickCreateVideoTask = {
  videoId: number;
  trackId: number;
  scriptId?: number;
  projectId?: number;
  relayTaskId?: string;
  requestId?: string;
  status: CreativeTaskStatus;
  preparationStage?: "portrait_registration" | null;
  statusMessage?: string | null;
  state?: string;
  prompt?: string;
  duration?: number;
  url?: string;
  errorReason?: string;
  createdAt?: number;
  history?: QuickCreateVideoTask[];
  hiddenHistoryCount?: number;
  assetId?: number;
  assetVersionId?: number;
};

export type QuickCreateImagePayload = {
  projectId?: number;
  prompt: string;
  model?: string | null;
  ratio?: QuickCreateRatio;
  quality?: QuickCreateImageQuality;
  count?: number;
  style?: string | null;
  subjects?: Array<{ id?: number; name?: string; type?: string }>;
  skills?: Array<{ id?: string; name?: string }>;
  references?: GenerationReference[];
};

export type QuickCreateImageAsset = {
  id: string;
  mediaAssetId?: string;
  assetId?: number | null;
  assetVersionId?: number | null;
  taskId: string;
  url: string;
  assetType: "image" | string;
  model?: string;
  prompt?: string;
  createdAt?: number;
};

export type QuickCreateImageResult = {
  taskId?: string;
  requestId?: string | null;
  status?: "queued" | "running" | "succeeded" | "failed";
  model: string;
  count: number;
  assets: QuickCreateImageAsset[];
  errorReason?: string;
};

// Session 相关类型
export type QuickCreateSessionMode = "quick_create" | "agent" | "canvas";

export type QuickCreateSessionParameters = {
  activeEntry?: string;
  autoEnabled?: boolean;
  preferenceTab?: "图片" | "视频";
  style?: string;
  targetType?: string;
  ratio?: QuickCreateRatio;
  llmModel?: string;
  imageModel?: string;
  imageQuality?: QuickCreateImageQuality;
  videoModel?: string;
  videoResolution?: string;
  videoOutputFormat?: "mp4" | "mov";
  videoAudio?: boolean;
  videoDuration?: number;
  duration?: number;
  shotCount?: number;
  selectedSkillIds?: string[];
  selectedSubjectIds?: string[];
  directorPlan?: QuickCreateDirectorPlan | null;
  structuredTimeline?: StructuredThirtySecondTimeline | null;
  workflowBrief?: QuickWorkflowBrief | null;
  commerceVariantBatch?: CommerceVariantBatch | null;
  materializedProject?: QuickCreateMaterializedProject | null;
  generatedImageAssets?: QuickCreateImageAsset[];
  generationMode?: string;
  imageCount?: number;
  videoMode?: string;
  videoReferenceAssignments?: Array<{
    assetVersionId: number;
    preferredRole?: "subject" | "style" | "storyboard" | "first_frame" | "last_frame";
    slotId?: string;
    order: number;
  }>;
  uploadedAttachments?: Array<{
    clientId: string;
    name: string;
    size: number;
    mimeType: string;
    assetId: number;
    assetVersionId: number;
    filePath: string;
    previewUrl: string;
    type: ReferenceAttachmentMimeCategory;
  }>;
};

export type QuickCreateSessionSnapshot = {
  id: string;
  projectId: number;
  goal: string;
  mode: QuickCreateSessionMode;
  parameters: QuickCreateSessionParameters;
  selectedAssetVersionIds: string[];
  version: number;
  createdAt: number;
  updatedAt: number;
};
