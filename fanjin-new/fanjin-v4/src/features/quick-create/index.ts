/**
 * Quick Create 模块统一导出
 *
 * 这个文件导出快速创作功能的所有公共接口。
 */

// API
export {
  generateDirectorPlan,
  materializeDirectorPlan,
  generateQuickCreateVideos,
  listQuickCreateTasks,
  generateQuickCreateImages,
  generateQuickCreateImageBatch,
} from "./api";

// 类型
export type {
  QuickCreateRatio,
  CreativeTaskStatus,
  QuickCreateDirectorPayload,
  QuickCreateShot,
  QuickCreateDirectorPlan,
  QuickCreateMaterializePayload,
  QuickCreateMaterializedProject,
  QuickCreateVideoPayload,
  QuickCreateVideoTask,
  QuickCreateImagePayload,
  QuickCreateImageAsset,
  QuickCreateImageResult,
  QuickCreateSessionMode,
  QuickCreateSessionParameters,
  QuickCreateSessionSnapshot,
} from "./types";

// 能力配置
export { QUICK_CREATE_CAPABILITIES } from "./capabilities";
export type { QuickCreateCapabilitySnapshot } from "./capabilities";

// 契约
export {
  CREATION_MODES,
  OUTPUT_TYPES,
  REFERENCE_ROLES,
  type CreationMode,
  type OutputType,
  type ReferenceRole,
} from "./contracts";

// 提交 ID
export { createSubmissionId, buildIdempotencyKey } from "./submissionId";

// Session 模块
export {
  useSessionStore,
  useSessionSync,
  type CreationSessionDto,
  type CreationSessionMode,
  type CreationSessionPatch,
  type CreationSessionUpdatePayload,
  type EnsureCreationSessionPayload,
} from "./session";

// 附件模块
export {
  useUploadQueueStore,
  uploadReferenceAttachment,
  validateUploadFile,
  inferMimeCategory,
  fileToBase64DataUrl,
  MAX_REFERENCE_ATTACHMENT_BYTES,
  type AttachmentQueueItem,
  type AttachmentUploadResult,
  type AttachmentUploadState,
  type UploadedReferenceAsset,
  type ReferenceAttachmentMimeCategory,
} from "./attachments";

// 任务轮询
export {
  createTaskPoller,
  classifyPollError,
  getPollDelay,
  type TaskPoller,
  type PollerState,
} from "./tasks/taskPoller";

// 模型目录
export {
  fetchQuickCreateModels,
  isImageModelAvailable,
  isVideoModelAvailable,
  resolveQuickCreateVideoMode,
  resolveQuickCreateVideoReferences,
  type QuickCreateImageModelOption,
  type QuickCreateVideoAttachmentKind,
  type QuickCreateVideoInputSlot,
  type QuickCreateVideoModelOption,
} from "./modelCatalog";

// 状态工具
export { normalizeCreativeTaskStatus } from "./status";
