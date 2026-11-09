import { videoDurationLabel } from "../../features/quick-create/AutoVideoDurationButton";
import { requiredVideoDuration, requiredVideoRatio, videoOutputFormatRequestField, type VideoOutputFormat } from "../../features/quick-create/videoOutputContract";
import { confirmPricingRetry } from "../../features/quick-create/confirmPricingRetry";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ArrowUp, AtSign, Bot, Check, ChevronDown, ChevronRight, Circle, FileText, FolderOpen, Image, LibraryBig, Loader2, MessageSquare, Mic, Plus, RefreshCw, RotateCcw, Search, Settings, Square, Video, WandSparkles, Wrench, X } from "lucide-react";
import { ApiError, apiGet, apiPost } from "../../api/http";
import type { Asset } from "../../api/types";
import VideoAudioSwitch from "../../features/quick-create/VideoAudioSwitch";
import VideoDurationControl from "../../features/quick-create/VideoDurationControl";
import { AgentGenerationResults } from "../../features/agent-runtime/AgentGenerationResults";
import fanjinLogo from "../../assets/fanjin-logo-fj.svg";
import {
  cancelQuickCreateTask,
  generateDirectorPlan,
  generateQuickCreateImages,
  generateQuickCreateVideos,
  listQuickCreateTasks,
  materializeDirectorPlan,
} from "../../features/quick-create/api";
import {
  isQuickCreateGenerationModeEnabled,
  normalizeQuickCreateGenerationMode,
} from "../../features/quick-create/capabilities";
import {
  activeVideoInputSlots,
  adaptModelOptionsResponse,
  allocateVideoAttachments,
  normalizeImageModelOptions,
  normalizeVideoModelOptions,
  reconcileImageAspectRatio,
  reconcileImageSettings,
  reconcileVideoAspectRatio,
  reconcileVideoSettings,
  resolveVideoGenerationReferences,
  validateImageConfiguration,
  validateVideoConfiguration,
  validateVideoPreferenceConfiguration,
  type ImageQuality,
  type NormalizedImageCapability,
  type ModelOptions,
  type NormalizedVideoCapability,
  type VideoModelOption,
  type VideoSettings,
} from "../../features/quick-create/videoCapabilities";
import type { StableSubmissionAttempt } from "../../features/quick-create/submissionAttempt";
import {
  clearStoredSubmissionAttempt,
  hasPendingReconcileSubmission,
  prepareStoredSubmissionAttempt,
  shouldRetainStoredSubmissionAttempt,
} from "../../features/quick-create/itemAttemptStorage";
import {
  createTaskPoller,
  type PollErrorKind,
  type TaskPoller,
} from "../../features/quick-create/tasks/taskPoller";
import {
  cancelAgentRun,
  ensureAgentThread,
  getAgentRun,
  getAgentThread,
  listAgentChatModels,
  listAgentSkills,
  listAllAgentRunSteps,
  listAllAgentThreads,
  listAllAgentMessages,
  sendAgentTextMessage,
  streamAgentEvents,
} from "../../features/agent-runtime/api";
import { agentSkillBillingLabel } from "../../features/agent-runtime/skillBilling";
import {
  listAllAgentRunApprovals,
} from "../../features/agent-runtime/approvalApi";
import AgentApprovalCard, {
  type AgentApprovalGenerationCapability,
} from "../../features/agent-runtime/AgentApprovalCard";
import AgentMarkdownContent from "../../features/agent-runtime/AgentMarkdown";
import type { AgentRuntimeApproval } from "../../features/agent-runtime/approvalTypes";
import { resolveAgentMessageAttachments } from "../../features/agent-runtime/attachments";
import {
  agentRunStateLabel,
  applyAgentMessageDeltaContent,
  createAgentMessageDeltaBuffer,
  mergeAgentRunStateIntoMessages,
} from "../../features/agent-runtime/messageDelta";
import {
  AGENT_RUN_RECOVERY_LABEL,
  agentConfirmedRetryClientMessageId,
  agentSafeRetryClientMessageId,
  agentSafeRetryContextFromSnapshot,
  isAgentRunConfirmableRetry,
  isAgentRunSafeRetryable,
  markAgentRunTransportDisconnected,
} from "../../features/agent-runtime/runRecoveryPolicy";
import {
  agentRuntimeStepDetail,
  agentRuntimeStepFromEvent,
  agentRuntimeStepLabel,
  agentRuntimeStepUiStatus,
  mergeAgentRuntimeSteps,
} from "../../features/agent-runtime/steps";
import type {
  AgentChatModel,
  AgentMessageAttachmentInput,
  AgentMessageContextSnapshot,
  AgentMessageContextSnapshotInput,
  AgentMessageContextUsage,
  AgentMessageGenerationPreferences,
  AgentMessageSkillRefInput,
  AgentRuntimeMessage,
  AgentRuntimeRun,
  AgentRuntimeStep,
  AgentRuntimeThread,
  AgentSurfaceAvailability,
} from "../../features/agent-runtime/types";
import { readAgentThreadId } from "../../features/agent-runtime/url";
import { formatAgentRuntimeFailure } from "../../features/agent-runtime/errorPresentation";
import { ProjectAssetPickerStatus } from "../../features/assets/ProjectAssetPickerStatus";
import PortraitAdmissionPanel from "../../features/portrait-admission/PortraitAdmissionPanel";
import { PortraitAdmissionIndicator, usePortraitAdmissionIndicators } from "../../features/portrait-admission/PortraitAdmissionIndicator";
import { shouldPollTask } from "../../features/quick-create/status";
import { resolveQuickCreateImageModel } from "../../features/quick-create/modelAliases";
import {
  uploadReferenceAttachment,
  type UploadedReferenceAsset,
} from "../../features/quick-create/attachments/api";
import ReferencePreviewImage from "../../features/quick-create/attachments/ReferencePreviewImage";
import {
  ReferencePreviewAudio,
  ReferencePreviewVideo,
} from "../../features/quick-create/attachments/AuthenticatedReferenceMedia";
import { MAX_QUICK_CREATE_IMAGE_REFERENCES } from "../../features/quick-create/referenceLimits";
import { useSessionStore } from "../../features/quick-create/session/sessionStore";
import type {
  QuickCreateDirectorPlan,
  QuickCreateImageAsset,
  QuickCreateMaterializedProject,
  QuickCreateRatio,
  QuickCreateSessionParameters,
  QuickCreateVideoTask,
} from "../../features/quick-create/types";
import { useAssetStore } from "../../stores/assetStore";
import { useAuthStore } from "../../stores/authStore";
import { buildProjectModeHref } from "../../routes/projectModeRoutes";
import { normalizeProjectId, useProjectStore } from "../../stores/projectStore";
import { useV4Theme } from "../../ui/useV4Theme";
import {
  ContextPanel,
  type StudioContextReference,
} from "../../components/project-studio";
import FrontstageNav from "../frontstage/FrontstageNav";
import {
  EMPTY_AGENT_CAPABILITIES,
  agentAttachmentUseText,
  agentChatModelPriceLabel,
  agentConversationBelongsToProject,
  agentReferenceDisplayKind,
  agentSurfaceCacheKey,
  buildGenerateSurfaceSearch,
  generateAttachmentAccept,
  generateAttachmentKind,
  generateAttachmentType,
  generationModesForRuntime,
  generationModesForSurface,
  isAgentSessionReferenceAllowed,
  isGenerateAttachmentAllowed,
  isGenerationModeAvailableOnSurface,
  modeFromSearch,
  readCachedAgentSurface,
  resolveAgentSurfaceExecutionState,
  reusableImageQuality,
  reusableVideoDuration,
  reusableVideoResolution,
  writeCachedAgentSurface,
  type GenerateAttachmentKind,
  type GenerateMode,
} from "./generateCatalog";
import {
  AGENT_SKILL_SELECTION_LIMIT,
  buildAgentContextSnapshotInput,
  contextStyleName,
  isAgentMessageContextUsage,
  isConfirmedAgentContextSnapshot,
  matchQuickSessionCanonicalSkills,
  mergeAgentTurnSkills,
  restoreAgentContextScopes,
  restoreLatestAgentContext,
  restoreQuickSessionContext,
  restoreUtilityGenerationSession,
  retainUnsubmittedAttachments,
  runtimeUsedSkillsForRun,
  type AgentSkill,
  type RestorableAgentContextMessage,
  type RestoredAgentContext,
} from "./generateContextRecovery";
import {
  isPlanPresentPlan,
  latestPlanFromRuntimeSteps,
  type PlanPresentPlan,
} from "./generatePlanMapping";
import { confirmAgentMessage } from "./agentMessageOrder";
import {
  capabilityStatusText,
  formatAttachmentSize,
  formatConversationTime,
  formatMessageTime,
  resolveGenerateSubjectReference,
  scrollElementIntoView,
  taskStatusText,
  toGenerateSubject,
  videoAttachmentKindText,
  type GenerateSubject,
} from "./generatePresentation";
import {
  agentProjectRecoveryKey,
  clearPendingAgentSubmission,
  generateConversationStorageKey,
  generateStorageScope,
  isDefinitiveAgentClientError,
  isRetryableAgentStreamError,
  isTerminalAgentRun,
  pendingAgentSubmissionKey,
  readPendingAgentSubmission,
  writePendingAgentSubmission,
  type PendingAgentSubmission,
} from "./generateSubmissionRecovery";
import "../create/QuickCreateView.css";
import "./GeneratePage.css";

export {
  AGENT_SKILL_SELECTION_LIMIT,
  agentAttachmentUseText,
  agentChatModelPriceLabel,
  agentReferenceDisplayKind,
  buildAgentContextSnapshotInput,
  buildGenerateSurfaceSearch,
  generateAttachmentAccept,
  generationModesForRuntime,
  generationModesForSurface,
  isAgentSessionReferenceAllowed,
  isConfirmedAgentContextSnapshot,
  isGenerateAttachmentAllowed,
  isGenerationModeAvailableOnSurface,
  isPlanPresentPlan,
  latestPlanFromRuntimeSteps,
  matchQuickSessionCanonicalSkills,
  mergeAgentTurnSkills,
  modeFromSearch,
  resolveAgentSurfaceExecutionState,
  restoreAgentContextScopes,
  restoreLatestAgentContext,
  restoreQuickSessionContext,
  restoreUtilityGenerationSession,
  retainUnsubmittedAttachments,
  reusableImageQuality,
  runtimeUsedSkillsForRun,
};
export type {
  AgentSkill,
  PlanPresentPlan,
  RestorableAgentContextMessage,
  RestoredAgentContext,
};

type PanelName = "mode" | "models" | "auto" | "subjects";
type ModelTab = "对话" | "图片" | "视频";
type GenerationPreferenceTab = "图片" | "视频";
export function resolveAgentApprovalGenerationCapability(
  approval: AgentRuntimeApproval,
  imageCapabilities: readonly NormalizedImageCapability[],
  videoCapabilities: readonly NormalizedVideoCapability[],
): AgentApprovalGenerationCapability | null {
  const model = typeof approval.argumentsSummary?.model === "string"
    ? approval.argumentsSummary.model
    : "";
  if (!model) return null;
  if (approval.toolId === "generation.image.submit") {
    const capability = imageCapabilities.find((candidate) => candidate.id === model);
    return capability ? {
      generationType: "image",
      model: capability.id,
      aspectRatios: capability.aspectRatios,
      qualities: capability.qualities,
    } : null;
  }
  if (approval.toolId === "generation.video.submit") {
    const capability = videoCapabilities.find((candidate) => candidate.id === model);
    return capability ? {
      generationType: "video",
      model: capability.id,
      aspectRatios: capability.aspectRatios,
      resolutions: capability.resolutions,
    } : null;
  }
  return null;
}

type GenerateAttachment = {
  id: string;
  name: string;
  size: number;
  type: string;
  previewUrl: string;
  kind: GenerateAttachmentKind;
  /** 本地待上传原文件，经资产上传通道换成 assetVersionId 后移除。 */
  file?: File;
  assetId?: number;
  assetVersionId?: string;
  filePath?: string;
};
type ImageGenerationJob = {
  id: string;
  prompt: string;
  model: string;
  ratio: QuickCreateRatio;
  quality: ImageQuality;
  count: number;
  status: "running" | "succeeded" | "failed";
  statusText: string;
  error?: string;
};
type AgentMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  clientMessageId?: string | null;
  runId?: string | null;
  content: string;
  createdAt: number;
  status?: "running" | "completed" | "failed" | "cancelled";
  steps?: AgentRuntimeStep[];
  stepsError?: string;
  approvals?: AgentRuntimeApproval[];
  approvalsError?: string;
  /** Generic R0 plan.present output; it is not a billable director/video plan. */
  presentedPlan?: PlanPresentPlan;
  contextLabels?: string[];
  contextSnapshot?: AgentMessageContextSnapshot | null;
  contextUsage?: AgentMessageContextUsage | null;
  /** run.status 事件推导的运行态提示(如「等待审批」),仅运行中展示。 */
  runStateLabel?: string | null;
  /** True only when this message came back from the Agent Runtime API. */
  serverVerified?: boolean;
};
type AgentRetryUiState = {
  phase: "checking" | "confirm" | "blocked" | "retrying" | "submitted" | "error";
  message: string;
};
type AgentConversation = {
  id: string;
  title: string;
  projectId: string | null;
  projectName: string;
  prompt: string;
  mode: GenerateMode;
  llmModel: string;
  ratio: QuickCreateRatio | "";
  videoModel: string;
  resolution: string;
  outputFormat?: VideoOutputFormat;
  videoMode?: string;
  videoDuration?: number;
  videoAudio?: boolean;
  updatedAt: number;
  messages?: AgentMessage[];
  lastPlan?: QuickCreateDirectorPlan | null;
  runtimeThreadId?: string;
  runtimeEventSeq?: number;
  runtimeActiveRunId?: string | null;
  runtimeSource?: "server";
};
type OpenConversationOptions = {
  fromUrl?: boolean;
};
type SubmitAgentTurnOptions = {
  retryOfRunId?: string;
  clientMessageId?: string;
  attachments?: AgentMessageAttachmentInput[];
  skillRefs?: AgentMessageSkillRefInput[];
  contextSnapshot?: AgentMessageContextSnapshotInput;
};

const ratioOptions: QuickCreateRatio[] = ["16:9", "9:16", "1:1", "4:3"];
// 服务端模型目录尚未声明批量 count 能力；仅暴露可证实的单张生成。
const imageCountOptions = [1] as const;
const emptyModelOptions: ModelOptions = {
  llmModels: [],
  imageModels: [],
  videoModels: [],
};
const AGENT_CONTEXT_MARKER = "\n\n[创作上下文]\n";
const defaultVideoOptions = {
  model: "",
  mode: "",
  resolution: "",
  outputFormat: "mp4" as VideoOutputFormat,
  audio: false,
  duration: 0,
};

type LibraryReuseLocationState = {
  brief?: string;
  skillRefs?: Array<{ key: string; version: string }>;
  libraryReuse?: {
    assetType?: "image" | "video";
    model?: string;
    metadata?: Record<string, unknown>;
    sourceTaskId?: string;
  };
};

function readStoredList<T>(key: string): T[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(key) || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function agentRuntimeMessageText(message: AgentRuntimeMessage) {
  return message.content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => String(part.text).trim())
    .filter(Boolean)
    .join("\n\n");
}

function agentRuntimeUserMessageText(message: AgentRuntimeMessage) {
  return message.content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => String(part.text).trim())
    .filter((text) => Boolean(text) && !/^\[附件:[^\r\n]{1,200}\]$/.test(text))
    .join("\n\n");
}

const RESTORABLE_AGENT_CONTEXT_PREFIXES = {
  assets: "资产要求：",
  skills: "使用技能：",
  references: "参考附件：",
  styles: "项目风格：",
} as const;

function isRestorableAgentContextLabel(label: string) {
  const normalized = label.trim();
  return Object.values(RESTORABLE_AGENT_CONTEXT_PREFIXES).some((prefix) => normalized.startsWith(prefix));
}

function uniqueContextItemsByName<T extends { name: string }>(items: readonly T[]): T[] {
  const names = new Set<string>();
  return items.filter((item) => {
    const name = item.name.trim().toLocaleLowerCase("zh-CN");
    if (!name || names.has(name)) return false;
    names.add(name);
    return true;
  });
}

function uniqueContextItemsByKey<T>(items: readonly T[], keyOf: (item: T) => string): T[] {
  const keys = new Set<string>();
  return items.filter((item) => {
    const key = keyOf(item);
    if (!key || keys.has(key)) return false;
    keys.add(key);
    return true;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function splitAgentMessageContext(text: string) {
  const markerIndex = text.lastIndexOf(AGENT_CONTEXT_MARKER);
  if (markerIndex < 0) return { content: text, contextLabels: undefined };
  const contextLabels = text
    .slice(markerIndex + AGENT_CONTEXT_MARKER.length)
    .split("\n")
    .map((line) => line.trim())
    .filter(isRestorableAgentContextLabel);
  return {
    content: text.slice(0, markerIndex).trim(),
    contextLabels: contextLabels.length ? contextLabels : undefined,
  };
}

type AgentRuntimeStepSnapshots = {
  stepsByRun: Map<string, AgentRuntimeStep[]>;
  errorsByRun: Map<string, string>;
};

type AgentRuntimeApprovalSnapshots = {
  approvalsByRun: Map<string, AgentRuntimeApproval[]>;
  errorsByRun: Map<string, string>;
};

const EMPTY_AGENT_RUNTIME_STEP_SNAPSHOTS: AgentRuntimeStepSnapshots = {
  stepsByRun: new Map(),
  errorsByRun: new Map(),
};

const EMPTY_AGENT_RUNTIME_APPROVAL_SNAPSHOTS: AgentRuntimeApprovalSnapshots = {
  approvalsByRun: new Map(),
  errorsByRun: new Map(),
};

function runtimeStepsFailureMessage() {
  return "运行步骤暂不可用，消息内容已安全恢复。";
}

function runtimeApprovalsFailureMessage() {
  return "审批状态暂不可用。为安全起见，请稍后重新打开对话确认。";
}

async function loadAgentRuntimeStepSnapshots(
  messages: AgentRuntimeMessage[],
  extraRunIds: Array<string | null | undefined> = [],
  signal?: AbortSignal,
): Promise<AgentRuntimeStepSnapshots> {
  const runIds = Array.from(new Set([
    ...messages.map((message) => message.runId),
    ...extraRunIds,
  ].filter((runId): runId is string => typeof runId === "string" && Boolean(runId))));
  const stepsByRun = new Map<string, AgentRuntimeStep[]>();
  const errorsByRun = new Map<string, string>();
  await Promise.all(runIds.map(async (runId) => {
    try {
      const steps = await listAllAgentRunSteps(runId, signal);
      stepsByRun.set(runId, mergeAgentRuntimeSteps([], steps));
    } catch (error) {
      if (signal?.aborted || (error as { name?: string })?.name === "AbortError") throw error;
      errorsByRun.set(runId, runtimeStepsFailureMessage());
    }
  }));
  return { stepsByRun, errorsByRun };
}

async function loadAgentRuntimeApprovalSnapshots(
  messages: AgentRuntimeMessage[],
  extraRunIds: Array<string | null | undefined> = [],
  signal?: AbortSignal,
): Promise<AgentRuntimeApprovalSnapshots> {
  const runIds = Array.from(new Set([
    ...messages.map((message) => message.runId),
    ...extraRunIds,
  ].filter((runId): runId is string => typeof runId === "string" && Boolean(runId))));
  const approvalsByRun = new Map<string, AgentRuntimeApproval[]>();
  const errorsByRun = new Map<string, string>();
  await Promise.all(runIds.map(async (runId) => {
    try {
      approvalsByRun.set(runId, await listAllAgentRunApprovals(runId, signal));
    } catch (error) {
      if (signal?.aborted || (error as { name?: string })?.name === "AbortError") throw error;
      errorsByRun.set(runId, runtimeApprovalsFailureMessage());
    }
  }));
  return { approvalsByRun, errorsByRun };
}

export function toAgentUiMessage(
  message: AgentRuntimeMessage,
  stepSnapshots: AgentRuntimeStepSnapshots = EMPTY_AGENT_RUNTIME_STEP_SNAPSHOTS,
  approvalSnapshots: AgentRuntimeApprovalSnapshots = EMPTY_AGENT_RUNTIME_APPROVAL_SNAPSHOTS,
): AgentMessage | null {
  if (message.role !== "user" && message.role !== "assistant" && message.role !== "system") return null;
  // 系统通知(如视频生成完成):非模型产出,按通知样式展示,不带步骤/审批。
  if (message.role === "system") {
    return {
      id: message.id,
      role: "system",
      runId: message.runId,
      content: agentRuntimeMessageText(message),
      createdAt: message.createdAt,
      serverVerified: true,
    };
  }
  if (message.role === "user") {
    const parsed = splitAgentMessageContext(agentRuntimeUserMessageText(message));
    return {
      id: message.id,
      role: "user",
      clientMessageId: message.clientMessageId,
      runId: message.runId,
      content: parsed.content,
      contextLabels: parsed.contextLabels,
      contextSnapshot: isConfirmedAgentContextSnapshot(message.contextSnapshot)
        ? message.contextSnapshot
        : null,
      createdAt: message.createdAt,
      serverVerified: true,
    };
  }
  const status = message.status === "completed"
    ? "completed"
    : message.status === "stopped"
      ? "cancelled"
      : message.status === "error"
        ? "failed"
        : "running";
  const fallbackContent = status === "failed"
    ? `这轮没有完成：${message.error?.message || "Agent 运行失败"}`
    : status === "cancelled"
      ? "这一轮已停止。"
      : "";
  const runSteps = message.runId ? stepSnapshots.stepsByRun.get(message.runId) : undefined;
  const presentedPlan = latestPlanFromRuntimeSteps(runSteps);
  return {
    id: message.id,
    role: "assistant",
    runId: message.runId,
    contextUsage: isAgentMessageContextUsage(message.contextUsage)
      ? message.contextUsage
      : null,
    content: agentRuntimeMessageText(message) || fallbackContent,
    createdAt: message.createdAt,
    status,
    steps: runSteps?.length ? runSteps : undefined,
    stepsError: message.runId ? stepSnapshots.errorsByRun.get(message.runId) : undefined,
    presentedPlan: presentedPlan || undefined,
    approvals: message.runId && approvalSnapshots.approvalsByRun.get(message.runId)?.length
      ? approvalSnapshots.approvalsByRun.get(message.runId)
      : undefined,
    approvalsError: message.runId ? approvalSnapshots.errorsByRun.get(message.runId) : undefined,
    serverVerified: true,
  };
}

function toAgentUiMessages(
  messages: AgentRuntimeMessage[],
  stepSnapshots: AgentRuntimeStepSnapshots = EMPTY_AGENT_RUNTIME_STEP_SNAPSHOTS,
  approvalSnapshots: AgentRuntimeApprovalSnapshots = EMPTY_AGENT_RUNTIME_APPROVAL_SNAPSHOTS,
) {
  return messages
    .map((message) => toAgentUiMessage(message, stepSnapshots, approvalSnapshots))
    .filter((message): message is AgentMessage => Boolean(message));
}

function mergeRunApprovalsIntoMessages(
  messages: AgentMessage[],
  runId: string,
  incoming: AgentRuntimeApproval[],
  approvalsError?: string | null,
  replace = false,
) {
  return messages.map((message) => {
    if (message.role !== "assistant" || message.runId !== runId) return message;
    const byId = new Map<string, AgentRuntimeApproval>();
    if (!replace) message.approvals?.forEach((approval) => byId.set(approval.id, approval));
    incoming.forEach((approval) => byId.set(approval.id, approval));
    const approvals = Array.from(byId.values()).sort((left, right) => (
      left.createdAt - right.createdAt || left.id.localeCompare(right.id)
    ));
    return {
      ...message,
      approvals: approvals.length ? approvals : undefined,
      approvalsError: approvalsError === undefined ? message.approvalsError : approvalsError || undefined,
    };
  });
}

function mergeRunStepsIntoMessages(
  messages: AgentMessage[],
  runId: string,
  incoming: AgentRuntimeStep[],
  stepsError?: string | null,
) {
  return messages.map((message) => {
    if (message.role !== "assistant" || message.runId !== runId) return message;
    const merged = mergeAgentRuntimeSteps(message.steps || [], incoming);
    const presentedPlan = latestPlanFromRuntimeSteps(merged);
    return {
      ...message,
      steps: merged.length ? merged : undefined,
      presentedPlan: presentedPlan || message.presentedPlan,
      stepsError: stepsError === undefined ? message.stepsError : stepsError || undefined,
    };
  });
}

function runtimeConversationFromThread(
  thread: AgentRuntimeThread,
  projectName: string,
  existing?: AgentConversation,
): AgentConversation {
  return {
    ...existing,
    id: thread.id,
    title: thread.title || existing?.title || "Agent 对话",
    projectId: String(thread.projectId),
    projectName: projectName || existing?.projectName || "未命名项目",
    prompt: existing?.prompt || "",
    mode: "Agent 模式",
    llmModel: existing?.llmModel || "",
    ratio: existing?.ratio || "",
    videoModel: existing?.videoModel || defaultVideoOptions.model,
    resolution: existing?.resolution || defaultVideoOptions.resolution,
    updatedAt: thread.lastMessageAt || thread.updatedAt,
    messages: existing?.messages,
    lastPlan: null,
    runtimeThreadId: thread.id,
    runtimeEventSeq: thread.eventSeq,
    runtimeActiveRunId: thread.activeRootRunId,
    runtimeSource: "server",
  };
}

function shouldRemoveThreadFromUrl(error: unknown) {
  if (!(error instanceof ApiError)) return false;
  return error.code === "thread_project_mismatch" || error.status === 403 || error.status === 404;
}

function threadRestoreFailureMessage(error: unknown) {
  if (error instanceof ApiError && error.code === "thread_project_mismatch") {
    return "该 Agent 对话不属于当前项目，已从地址栏移除";
  }
  if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
    return "无法访问该 Agent 对话，已从地址栏移除";
  }
  return error instanceof Error ? error.message : "Agent 对话恢复失败";
}

export type GeneratePageProps = {
  /** Keep the production Agent runtime while the shared studio owns page chrome. */
  embedded?: boolean;
};

export default function GeneratePage({ embedded = false }: GeneratePageProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const logout = useAuthStore((state) => state.logout);
  const authUserId = useAuthStore((state) => state.user?.id ?? null);
  const authWorkspaceId = useAuthStore((state) => state.currentWorkspace?.id ?? null);
  const agentStorageScope = generateStorageScope(authUserId, authWorkspaceId);
  const agentSurfaceStorageKey = agentSurfaceCacheKey(agentStorageScope);
  const initialAgentSurfaceAvailability = useMemo(
    () => readCachedAgentSurface(agentSurfaceStorageKey),
    [agentSurfaceStorageKey],
  );
  const initialAgentSurfaceExecution = useMemo(
    () => resolveAgentSurfaceExecutionState(initialAgentSurfaceAvailability),
    [initialAgentSurfaceAvailability],
  );
  const localConversationStorageKey = generateConversationStorageKey(agentStorageScope);
  const locationState = location.state as LibraryReuseLocationState | null;
  const projects = useProjectStore((state) => state.projects);
  const currentProject = useProjectStore((state) => state.currentProject);
  const currentProjectId = useProjectStore((state) => state.currentProjectId);
  const creationSession = useSessionStore((state) => state.session);
  const sessionContextStyleName = creationSession && currentProjectId !== null
    && String(creationSession.projectId) === String(currentProjectId)
    ? contextStyleName(creationSession.parameters.style)
    : null;
  const resolvedContextStyleName = sessionContextStyleName || contextStyleName(currentProject?.artStyle);
  const pendingSubmissionStorageKey = pendingAgentSubmissionKey(agentStorageScope, currentProjectId);
  const fetchProjects = useProjectStore((state) => state.fetchProjects);
  const selectProject = useProjectStore((state) => state.selectProject);
  const refreshAndSelectProject = useProjectStore((state) => state.refreshAndSelectProject);
  const projectAssets = useAssetStore((state) => state.assets);
  const fetchAssets = useAssetStore((state) => state.fetchAssets);
  const assetsLoading = useAssetStore((state) => state.loading);
  const assetsError = useAssetStore((state) => state.error);
  const theme = useV4Theme();
  const dark = theme.mode === "dark";
  const [prompt, setPrompt] = useState(locationState?.brief || "");
  const [activeMode, setActiveMode] = useState<GenerateMode>(() => (
    embedded ? "Agent 模式" : modeFromSearch(location.search)
  ));
  const [activePanel, setActivePanel] = useState<PanelName | null>(null);
  const [modelTab, setModelTab] = useState<ModelTab>("对话");
  const [agentPreferenceTab, setAgentPreferenceTab] = useState<GenerationPreferenceTab>("视频");
  const [selectedRatio, setSelectedRatio] = useState<QuickCreateRatio | "">("");
  const [customRatio, setCustomRatio] = useState({ width: "21", height: "9" });
  const [customRatioOpen, setCustomRatioOpen] = useState(false);
  const [imageModel, setImageModel] = useState("");
  const [imageQuality, setImageQuality] = useState<ImageQuality>("2K");
  const [imageCount, setImageCount] = useState<(typeof imageCountOptions)[number]>(1);
  const [videoSettings, setVideoSettings] = useState<VideoSettings>(defaultVideoOptions);
  const [directorShotCount, setDirectorShotCount] = useState("");
  const [attachments, setAttachments] = useState<GenerateAttachment[]>([]);
  const [referenceUploadPending, setReferenceUploadPending] = useState(false);
  const [portraitAdmissionBlocking, setPortraitAdmissionBlocking] = useState(false);
  const { approvedAssetVersionIds, onApprovalChange } = usePortraitAdmissionIndicators(currentProjectId);
  const [selectedSubjects, setSelectedSubjects] = useState<GenerateSubject[]>([]);
  const [plan, setPlan] = useState<QuickCreateDirectorPlan | null>(null);
  const [materialized, setMaterialized] = useState<QuickCreateMaterializedProject | null>(null);
  const [tasks, setTasks] = useState<QuickCreateVideoTask[]>([]);
  const hasPendingVideoReconcile = hasPendingReconcileSubmission(tasks);
  const [cancellingVideoTaskId, setCancellingVideoTaskId] = useState("");
  const [imageAssets, setImageAssets] = useState<QuickCreateImageAsset[]>([]);
  const [imageJob, setImageJob] = useState<ImageGenerationJob | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSubmittingVideo, setIsSubmittingVideo] = useState(false);
  const [notice, setNotice] = useState("");
  const [taskPollErrorText, setTaskPollErrorText] = useState("");
  const [modelOptions, setModelOptions] = useState<ModelOptions>(emptyModelOptions);
  const [selectedLlmModel, setSelectedLlmModel] = useState("");
  const [modelOptionsLoading, setModelOptionsLoading] = useState(true);
  const [modelOptionsError, setModelOptionsError] = useState("");
  const [agentChatModels, setAgentChatModels] = useState<AgentChatModel[]>(
    initialAgentSurfaceExecution.models,
  );
  const [selectedAgentChatModel, setSelectedAgentChatModel] = useState(
    initialAgentSurfaceExecution.models.find((model) => model.default)?.id
      ?? initialAgentSurfaceExecution.models[0]?.id
      ?? "",
  );
  const [agentChatModelsLoading, setAgentChatModelsLoading] = useState(
    initialAgentSurfaceAvailability === null,
  );
  const [agentChatModelsError, setAgentChatModelsError] = useState(
    initialAgentSurfaceExecution.conversationAvailable
      ? ""
      : initialAgentSurfaceAvailability?.message || "",
  );
  const [agentSurfaceAvailable, setAgentSurfaceAvailable] = useState(
    initialAgentSurfaceExecution.conversationAvailable,
  );
  const [agentCapabilities, setAgentCapabilities] = useState(
    initialAgentSurfaceExecution.capabilities,
  );
  const [agentSurfaceMessage, setAgentSurfaceMessage] = useState(
    initialAgentSurfaceExecution.complete
      ? ""
      : initialAgentSurfaceAvailability?.message || "",
  );
  const [agentCatalogRefreshKey, setAgentCatalogRefreshKey] = useState(0);
  const [officialSkills, setOfficialSkills] = useState<AgentSkill[]>([]);
  const [officialSkillsLoading, setOfficialSkillsLoading] = useState(true);
  const [officialSkillsError, setOfficialSkillsError] = useState("");
  const [selectedSkills, setSelectedSkills] = useState<AgentSkill[]>([]);
  const [skillLibraryOpen, setSkillLibraryOpen] = useState(false);
  const [skillQuery, setSkillQuery] = useState("");
  const [conversations, setConversations] = useState<AgentConversation[]>(() => (
    localConversationStorageKey
      ? readStoredList<AgentConversation>(localConversationStorageKey).filter((conversation) => conversation.runtimeSource !== "server")
      : []
  ));
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [agentMessages, setAgentMessages] = useState<AgentMessage[]>([]);
  const [agentRetryStates, setAgentRetryStates] = useState<Record<string, AgentRetryUiState>>({});
  const latestCompletedPlanMessageId = useMemo(() => {
    for (let index = agentMessages.length - 1; index >= 0; index -= 1) {
      const message = agentMessages[index];
      if (
        message.role === "assistant"
        && message.presentedPlan
        && (message.status || "completed") === "completed"
      ) {
        return message.id;
      }
    }
    return null;
  }, [agentMessages]);
  const [runtimeHistoryLoading, setRuntimeHistoryLoading] = useState(false);
  const taskPollerRef = useRef<TaskPoller | null>(null);
  const taskPollerProjectIdRef = useRef<number | null>(null);
  const materializedProjectIdRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const attachmentsRef = useRef<GenerateAttachment[]>([]);
  const directorSubmissionAttemptRef = useRef<StableSubmissionAttempt | null>(null);
  const materializeSubmissionAttemptRef = useRef<StableSubmissionAttempt | null>(null);
  const imageSubmissionAttemptRef = useRef<StableSubmissionAttempt | null>(null);
  const videoSubmissionAttemptRef = useRef<StableSubmissionAttempt | null>(null);
  const agentMessagesRef = useRef<AgentMessage[]>([]);
  const activeAgentRun = useRef<AbortController | null>(null);
  const activeAgentRunMeta = useRef<{
    conversationId: string;
    threadId: string | null;
    runId: string | null;
    clientMessageId: string | null;
    brief: string;
    messageId: string;
  } | null>(null);
  const safeRetrySourceRunRef = useRef<string | null>(null);
  const agentConversationRequest = useRef(0);
  const conversationStorageScopeRef = useRef(localConversationStorageKey);
  const skipConversationPersist = useRef(false);
  const recoveredSubmissionRef = useRef<string | null>(null);
  const urlThreadRecoveryRef = useRef<string | null>(null);
  const activeConversationIdRef = useRef<string | null>(null);
  const conversationsRef = useRef<AgentConversation[]>(conversations);
  const conversationProjectScopeRef = useRef<number | null>(currentProjectId);
  const automaticThreadRecoveryStartedRef = useRef<string | null>(null);
  const automaticThreadRecoverySuppressedRef = useRef<string | null>(null);
  const hydratedUtilitySessionKeyRef = useRef<string | null>(null);
  const carryingUtilityDraftProjectIdRef = useRef<number | null>(null);
  const pendingLibraryReuseRef = useRef(locationState?.libraryReuse || null);
  const agentTranscriptEndRef = useRef<HTMLDivElement | null>(null);

  const requestedThreadId = useMemo(() => readAgentThreadId(location.search), [location.search]);

  const targetType = useMemo(() => {
    if (activeMode === "图片生成") return "图片生成";
    if (activeMode === "视频生成") return "视频生成";
    return activeMode === "Agent 模式" ? "广告视频" : activeMode;
  }, [activeMode]);

  const selectedLlmOption = useMemo(
    () => modelOptions.llmModels.find((item) => item.id === selectedLlmModel) || null,
    [modelOptions.llmModels, selectedLlmModel],
  );

  const selectedAgentChatOption = useMemo(
    () => agentChatModels.find((item) => item.id === selectedAgentChatModel) || agentChatModels[0],
    [agentChatModels, selectedAgentChatModel],
  );

  const defaultAgentChatOption = useMemo(
    () => agentChatModels.find((item) => item.default) || agentChatModels[0],
    [agentChatModels],
  );

  const imageCapabilities = useMemo(
    () => normalizeImageModelOptions(modelOptions.imageModels).filter((item) => item.canSubmit),
    [modelOptions.imageModels],
  );

  const selectedImageCapability = useMemo(
    () => imageCapabilities.find((item) => item.id === imageModel) || null,
    [imageCapabilities, imageModel],
  );

  const videoCapabilities = useMemo(
    () => normalizeVideoModelOptions(modelOptions.videoModels).filter((item) => item.canSubmit),
    [modelOptions.videoModels],
  );

  const runtimeGenerationModes = useMemo(
    () => generationModesForRuntime(embedded, {
      agent: agentSurfaceAvailable,
      image: imageCapabilities.length > 0,
      video: videoCapabilities.length > 0,
      llm: modelOptions.llmModels.length > 0,
    }),
    [
      agentSurfaceAvailable,
      embedded,
      imageCapabilities.length,
      modelOptions.llmModels.length,
      videoCapabilities.length,
    ],
  );
  const activeRuntimeModeAvailable = activeMode === "Agent 模式"
    ? agentSurfaceAvailable
    : runtimeGenerationModes.includes(activeMode);

  const selectedVideoCapability = useMemo(
    () => videoCapabilities.find((item) => item.id === videoSettings.model) || null,
    [videoCapabilities, videoSettings.model],
  );

  const activePreferenceTab: GenerationPreferenceTab = activeMode === "图片生成"
    ? "图片"
    : activeMode === "视频生成"
      ? "视频"
      : agentPreferenceTab;
  const activeAgentGenerationPreferenceAvailable = activePreferenceTab === "图片"
    ? agentCapabilities.imageGeneration
    : agentCapabilities.videoGeneration;

  const visibleRatioOptions = useMemo(
    () => {
      if (activePreferenceTab === "图片") {
        return selectedImageCapability?.aspectRatios as QuickCreateRatio[] || [];
      }
      if (activePreferenceTab === "视频") {
        const ratios = selectedVideoCapability?.aspectRatios as QuickCreateRatio[] || [];
        const required = selectedVideoCapability ? requiredVideoRatio(selectedVideoCapability.id, videoSettings.mode) : null;
        return required ? ratios.filter((ratio) => ratio === required) : ratios;
      }
      return ratioOptions;
    },
    [activePreferenceTab, selectedImageCapability, selectedVideoCapability, videoSettings.mode],
  );
  useEffect(() => {
    if (activePreferenceTab !== "视频" || !selectedVideoCapability) return;
    const requiredRatio = requiredVideoRatio(selectedVideoCapability.id, videoSettings.mode);
    if (requiredRatio && selectedVideoCapability.aspectRatios.includes(requiredRatio) && selectedRatio !== requiredRatio) {
      setSelectedRatio(requiredRatio);
    }
    if (requiredVideoDuration(selectedVideoCapability.id, videoSettings.mode) === -1 && videoSettings.duration !== -1) {
      setVideoSettings((current) => ({ ...current, duration: -1 }));
    }
  }, [activePreferenceTab, selectedRatio, selectedVideoCapability, videoSettings.duration, videoSettings.mode]);

  const imageConfigurationErrors = useMemo(
    () => selectedImageCapability
      ? validateImageConfiguration({
          capability: selectedImageCapability,
          settings: { model: imageModel, quality: imageQuality },
          aspectRatio: selectedRatio,
        })
      : ["未配置可用的图片模型，暂不能提交生成"],
    [imageModel, imageQuality, selectedImageCapability, selectedRatio],
  );

  const videoInputSlots = useMemo(
    () => selectedVideoCapability ? activeVideoInputSlots(selectedVideoCapability, videoSettings.mode) : [],
    [selectedVideoCapability, videoSettings.mode],
  );

  const selectedSubjectReferences = useMemo(
    () => activeMode === "Agent 模式"
      ? selectedSubjects.flatMap((subject): GenerateAttachment[] => {
          const reference = resolveGenerateSubjectReference(subject, projectAssets);
          if (!reference) return [];
          return [{
            id: `project-asset-reference-${reference.assetVersionId}`,
            name: reference.name,
            size: 0,
            type: reference.mediaType === "image" ? "image/*" : "video/*",
            previewUrl: reference.image || "",
            kind: reference.mediaType,
            assetId: reference.numericId,
            assetVersionId: String(reference.assetVersionId),
          }];
        })
      : [],
    [activeMode, projectAssets, selectedSubjects],
  );

  const videoReferenceAttachments = useMemo(
    () => {
      const references = attachments.filter((attachment) => (
        attachment.kind !== "file" || attachment.type.startsWith("audio/")
      ));
      const versions = new Set(references.map((attachment) => attachment.assetVersionId).filter(Boolean));
      selectedSubjectReferences.forEach((reference) => {
        if (!reference.assetVersionId || versions.has(reference.assetVersionId)) return;
        references.push(reference);
        versions.add(reference.assetVersionId);
      });
      return references;
    },
    [attachments, selectedSubjectReferences],
  );
  const attachmentAccept = useMemo(
    () => generateAttachmentAccept(activeMode, videoInputSlots),
    [activeMode, videoInputSlots],
  );

  const videoInputAllocation = useMemo(
    () => selectedVideoCapability
      ? allocateVideoAttachments(selectedVideoCapability, videoSettings.mode, videoReferenceAttachments)
      : { counts: {} as Record<string, number>, assignments: [], unassigned: videoReferenceAttachments },
    [selectedVideoCapability, videoReferenceAttachments, videoSettings.mode],
  );

  const videoConfigurationErrors = useMemo(
    () => selectedVideoCapability
      ? validateVideoConfiguration({
          capability: selectedVideoCapability,
          settings: videoSettings,
          aspectRatio: selectedRatio,
          attachments: videoReferenceAttachments,
        })
      : ["没有可用的视频模型"],
    [selectedRatio, selectedVideoCapability, videoReferenceAttachments, videoSettings],
  );
  const videoPreferenceConfigurationErrors = useMemo(
    () => selectedVideoCapability
      ? validateVideoPreferenceConfiguration({
          capability: selectedVideoCapability,
          settings: videoSettings,
          aspectRatio: selectedRatio,
        })
      : ["没有可用的视频模型"],
    [selectedRatio, selectedVideoCapability, videoSettings],
  );
  const visibleVideoConfigurationErrors = activeMode === "Agent 模式"
    ? videoPreferenceConfigurationErrors
    : videoConfigurationErrors;
  const directorShotCountValue = Number(directorShotCount);
  const videoPromptConfigurationErrors = useMemo(() => (
    activeMode === "视频生成"
      && (!Number.isSafeInteger(directorShotCountValue) || directorShotCountValue <= 0 || directorShotCountValue > 20)
      ? [...videoConfigurationErrors, "请明确填写 1–20 之间的分镜数量"]
      : videoConfigurationErrors
  ), [activeMode, directorShotCountValue, videoConfigurationErrors]);

  useEffect(() => {
    if (activeMode !== "Agent 模式") {
      if (selectedSubjects.length) setSelectedSubjects([]);
      if (activePanel === "subjects") setActivePanel(null);
    }
    const incompatible = attachments.filter(
      (attachment) => !isGenerateAttachmentAllowed(activeMode, attachment, videoInputSlots),
    );
    if (!incompatible.length) return;
    incompatible.forEach((attachment) => {
      if (attachment.file && attachment.previewUrl.startsWith("blob:")) {
        window.URL.revokeObjectURL(attachment.previewUrl);
      }
    });
    const incompatibleIds = new Set(incompatible.map((attachment) => attachment.id));
    setAttachments((current) => current.filter((attachment) => !incompatibleIds.has(attachment.id)));
  }, [
    activeMode,
    activePanel,
    attachments,
    selectedSubjects.length,
    videoInputSlots,
  ]);

  const conversationGroups = useMemo(() => {
    const projectNames = new Map(projects.map((project) => [String(project.id), project.name]));
    const groups = new Map<string, { projectId: string | null; projectName: string; items: AgentConversation[] }>();
    [...conversations]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .forEach((conversation) => {
        const key = conversation.projectId || "unassigned";
        const current = groups.get(key) || {
          projectId: conversation.projectId,
          projectName: conversation.projectId ? projectNames.get(conversation.projectId) || conversation.projectName || "未命名项目" : "未关联项目",
          items: [],
        };
        current.items.push(conversation);
        groups.set(key, current);
      });
    return Array.from(groups.values());
  }, [conversations, projects]);

  const activeConversation = useMemo(() => {
    const candidate = conversations.find((conversation) => conversation.id === activeConversationId);
    return agentConversationBelongsToProject(candidate, currentProjectId) ? candidate! : null;
  }, [activeConversationId, conversations, currentProjectId]);
  const agentRecoveryRunId = activeMode === "Agent 模式" && !isGenerating
    ? activeAgentRunMeta.current?.runId || activeConversation?.runtimeActiveRunId || null
    : null;
  const agentRunRecoveryPending = Boolean(agentRecoveryRunId);

  const legacyAgentConversation = Boolean(
    activeConversation?.mode === "Agent 模式" && !activeConversation.runtimeThreadId,
  );

  const visibleSkills = useMemo(() => {
    const query = skillQuery.trim().toLowerCase();
    return officialSkills.filter((skill) => !query || `${skill.name}${skill.description}${skill.category ?? ""}${skill.provider ?? ""}${skill.author ?? ""}`.toLowerCase().includes(query));
  }, [officialSkills, skillQuery]);

  const subjectOptions = useMemo(() => {
    return projectAssets
      .filter((asset) => Boolean(asset.src || asset.sonAssets?.some((item) => item.src)) || asset.type === "role" || asset.type === "scene" || asset.type === "tool")
      .map(toGenerateSubject);
  }, [projectAssets]);

  useEffect(() => {
    void fetchProjects();
  }, [fetchProjects]);

  useEffect(() => {
    let alive = true;
    async function loadWorkspaceOptions() {
      try {
        const models = await apiGet<ModelOptions>("/workbench/create/modelOptions");
        if (!alive) return;
        const adaptedModels = adaptModelOptionsResponse(models);
        const normalizedModels: ModelOptions = {
          llmModels: adaptedModels.llmModels,
          imageModels: adaptedModels.imageModels || [],
          videoModels: adaptedModels.videoModels,
          ...(adaptedModels.catalogVersion !== undefined ? { catalogVersion: adaptedModels.catalogVersion } : {}),
          ...(adaptedModels.models ? { models: adaptedModels.models } : {}),
        };
        setModelOptions(normalizedModels);
        setModelOptionsError("");
        setSelectedLlmModel((current) => normalizedModels.llmModels.some((item) => item.id === current) ? current : normalizedModels.llmModels[0]?.id || "");
      } catch (error) {
        if (!alive) return;
        setModelOptions(emptyModelOptions);
        setSelectedLlmModel("");
        setModelOptionsError(error instanceof Error ? error.message : "模型配置读取失败");
      } finally {
        if (alive) setModelOptionsLoading(false);
      }
      try {
        const result = await listAgentSkills();
        if (!alive) return;
        const canonicalSkills = (Array.isArray(result?.skills) ? result.skills : [])
          .filter((skill) => skill.key?.trim() && skill.version?.trim() && skill.displayName?.trim())
          .map((skill): AgentSkill => ({
            id: `${skill.key}@${skill.version}`,
            key: skill.key,
            version: skill.version,
            name: skill.displayName,
            description: `${skill.description || skill.summary || (skill.roles?.length
              ? `Agent Runtime · ${skill.roles.join(" / ")}`
              : "Agent Runtime 官方技能")} · ${agentSkillBillingLabel(skill.billingPolicy)}`,
            category: skill.category || "创作技能",
            provider: skill.source === "jimeng" ? "jimeng" : "fanjin",
            author: skill.sourceAuthor || null,
            source: "official",
          }));
        setOfficialSkills(canonicalSkills);
        setOfficialSkillsError("");
        const allowed = new Set(canonicalSkills.map((skill) => skill.id));
        const copiedSkillIds = new Set((locationState?.skillRefs || []).map((ref) => `${ref.key}@${ref.version}`));
        setSelectedSkills((current) => copiedSkillIds.size
          ? canonicalSkills.filter((skill) => copiedSkillIds.has(skill.id)).slice(0, AGENT_SKILL_SELECTION_LIMIT)
          : current.filter((skill) => allowed.has(skill.id)));
      } catch (error) {
        if (!alive) return;
        setOfficialSkills([]);
        setSelectedSkills([]);
        setOfficialSkillsError(error instanceof Error ? error.message : "技能目录读取失败");
      } finally {
        if (alive) setOfficialSkillsLoading(false);
      }
    }
    void loadWorkspaceOptions();
    return () => {
      alive = false;
    };
  }, []);

  // 管理员配置决定服务是否开放；Worker/依赖健康探测只提供运行提示。
  // 请求刷新失败时沿用同一用户/工作区最近一次服务端确认的目录，最终提交
  // 仍由服务端权限、路由与计费校验，避免瞬时网络错误把四项服务全部关闭。
  useEffect(() => {
    const controller = new AbortController();
    let alive = true;
    const applyAvailability = (result: AgentSurfaceAvailability, cacheFallback = false) => {
      const state = resolveAgentSurfaceExecutionState(result);
      setAgentSurfaceAvailable(state.conversationAvailable);
      setAgentCapabilities(state.capabilities);
      setAgentSurfaceMessage(cacheFallback
        ? "实时状态刷新失败，已沿用最近一次管理员配置；提交时仍由服务端执行最终校验"
        : state.complete ? "" : result.message || "部分 Agent 能力暂不可用");
      setAgentChatModels(state.models);
      setAgentChatModelsError(
        state.conversationAvailable
          ? ""
          : result.message || "Agent 真实执行链路尚未就绪",
      );
      setSelectedAgentChatModel((current) => (
        state.models.some((model) => model.id === current)
          ? current
          : (state.models.find((model) => model.default)?.id ?? state.models[0]?.id ?? "")
      ));
      return state;
    };

    const cached = readCachedAgentSurface(agentSurfaceStorageKey);
    if (cached) {
      applyAvailability(cached);
      // A previously confirmed catalog keeps the surface stable while the
      // network refresh runs in the background. Replacing the whole Agent
      // dock with a loading screen on every mount caused visible flicker and
      // was amplified by React StrictMode's development remount.
      setAgentChatModelsLoading(false);
    } else {
      setAgentSurfaceAvailable(false);
      setAgentCapabilities(EMPTY_AGENT_CAPABILITIES);
      setAgentSurfaceMessage("");
      setAgentChatModels([]);
      setSelectedAgentChatModel("");
      setAgentChatModelsLoading(true);
    }
    listAgentChatModels(controller.signal)
      .then((result) => {
        if (!alive) return;
        applyAvailability(result);
        writeCachedAgentSurface(agentSurfaceStorageKey, result);
      })
      .catch((error) => {
        if (!alive) return;
        const fallback = readCachedAgentSurface(agentSurfaceStorageKey);
        if (fallback) {
          applyAvailability(fallback, true);
          return;
        }
        setAgentSurfaceAvailable(false);
        setAgentCapabilities(EMPTY_AGENT_CAPABILITIES);
        setAgentSurfaceMessage("");
        setAgentChatModels([]);
        setSelectedAgentChatModel("");
        setAgentChatModelsError(error instanceof Error ? error.message : "Agent 对话模型目录读取失败");
      })
      .finally(() => {
        if (alive) setAgentChatModelsLoading(false);
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [agentCatalogRefreshKey, agentSurfaceStorageKey]);

  useEffect(() => {
    if (activeMode !== "Agent 模式" || agentChatModelsLoading) return;
    if (agentPreferenceTab === "图片" && !agentCapabilities.imageGeneration && agentCapabilities.videoGeneration) {
      setAgentPreferenceTab("视频");
    } else if (agentPreferenceTab === "视频" && !agentCapabilities.videoGeneration && agentCapabilities.imageGeneration) {
      setAgentPreferenceTab("图片");
    }
  }, [
    activeMode,
    agentCapabilities.imageGeneration,
    agentCapabilities.videoGeneration,
    agentChatModelsLoading,
    agentPreferenceTab,
  ]);

  useEffect(() => {
    if (
      agentChatModelsLoading
      || modelOptionsLoading
      || activeRuntimeModeAvailable
      || activeMode === "Agent 模式"
    ) return;
    if (embedded) {
      setActivePanel(null);
      return;
    }
    const fallbackMode = runtimeGenerationModes[0] || null;
    if (fallbackMode) {
      switchMode(fallbackMode);
      showNotice(`${activeMode}当前没有完整真实能力，已切换到${fallbackMode}`);
      return;
    }
    setActivePanel(null);
    showNotice(modelOptionsError || agentChatModelsError || "当前工作区没有可执行的创作模式");
  }, [
    activeMode,
    activeRuntimeModeAvailable,
    agentChatModelsError,
    agentChatModelsLoading,
    embedded,
    modelOptionsError,
    modelOptionsLoading,
    runtimeGenerationModes,
  ]);

  useEffect(() => {
    const nextCapability = selectedImageCapability || imageCapabilities[0];
    if (!nextCapability) {
      setImageModel("");
      return;
    }
    const next = reconcileImageSettings(
      { model: imageModel, quality: imageQuality },
      nextCapability,
    );
    if (next.model !== imageModel) setImageModel(next.model);
    if (next.quality !== imageQuality) setImageQuality(next.quality);
    if (activePreferenceTab === "图片") {
      setSelectedRatio((current) => reconcileImageAspectRatio(current, nextCapability) as QuickCreateRatio);
    }
  }, [activePreferenceTab, imageCapabilities, imageModel, imageQuality, selectedImageCapability]);

  useEffect(() => {
    const nextCapability = selectedVideoCapability || videoCapabilities[0];
    if (!nextCapability) {
      setVideoSettings((current) => current.model || current.mode || current.resolution || current.duration || current.audio
        ? defaultVideoOptions
        : current);
      return;
    }
    setVideoSettings((current) => {
      const next = reconcileVideoSettings(current, nextCapability);
      return current.model === next.model
        && current.mode === next.mode
        && current.resolution === next.resolution
        && current.duration === next.duration
        && current.audio === next.audio
        ? current
        : next;
    });
    if (activePreferenceTab === "视频") {
      setSelectedRatio((current) => reconcileVideoAspectRatio(current, nextCapability) as QuickCreateRatio);
    }
  }, [activePreferenceTab, selectedVideoCapability, videoCapabilities]);

  useEffect(() => {
    if (modelOptionsLoading) return;
    const reuse = pendingLibraryReuseRef.current;
    if (!reuse) return;
    pendingLibraryReuseRef.current = null;

    if (reuse.assetType === "image") {
      const capability = imageCapabilities.find((item) => item.id === reuse.model)
        || (!reuse.model ? imageCapabilities[0] : null);
      if (!capability) {
        showNotice("原图片模型当前不可提交；已保留 Prompt，请重新选择可用模型");
        return;
      }
      const quality = reusableImageQuality(reuse.metadata);
      setImageModel(capability.id);
      setImageQuality(quality && capability.qualities.includes(quality) ? quality : capability.defaultQuality);
      setSelectedRatio((current) => reconcileImageAspectRatio(current, capability) as QuickCreateRatio);
      showNotice(reuse.model
        ? "已带入原 Prompt、模型和仍受支持的参数"
        : "已带入原 Prompt 和仍受支持的参数");
      return;
    }

    if (reuse.assetType === "video") {
      const capability = videoCapabilities.find((item) => item.id === reuse.model)
        || (!reuse.model ? videoCapabilities[0] : null);
      if (!capability) {
        showNotice("原视频模型当前不可提交；已保留 Prompt，请重新选择可用模型");
        return;
      }
      const requestedResolution = reusableVideoResolution(reuse.metadata);
      const requestedDuration = reusableVideoDuration(reuse.metadata);
      const next = reconcileVideoSettings({
        model: capability.id,
        mode: capability.modes[0]?.id || "",
        resolution: capability.resolutions.includes(requestedResolution)
          ? requestedResolution
          : capability.defaultResolution,
        duration: capability.duration.allowed.includes(requestedDuration)
          ? requestedDuration
          : capability.duration.default,
        audio: false,
      }, capability);
      setVideoSettings(next);
      setSelectedRatio((current) => reconcileVideoAspectRatio(current, capability) as QuickCreateRatio);
      showNotice(reuse.model
        ? "已带入原 Prompt、模型和仍受支持的参数"
        : "已带入原 Prompt 和仍受支持的参数");
    }
  }, [imageCapabilities, modelOptionsLoading, videoCapabilities]);

  useEffect(() => {
    if (modelOptionsLoading) return;
    setSelectedLlmModel((current) => (
      modelOptions.llmModels.some((model) => model.id === current)
        ? current
        : modelOptions.llmModels[0]?.id || ""
    ));
  }, [modelOptions.llmModels, modelOptionsLoading]);

  useEffect(() => {
    if (conversationStorageScopeRef.current === localConversationStorageKey) return;
    conversationStorageScopeRef.current = localConversationStorageKey;
    skipConversationPersist.current = true;
    recoveredSubmissionRef.current = null;
    urlThreadRecoveryRef.current = null;
    activeConversationIdRef.current = null;
    automaticThreadRecoveryStartedRef.current = null;
    automaticThreadRecoverySuppressedRef.current = null;
    agentConversationRequest.current += 1;
    activeAgentRun.current?.abort();
    activeAgentRun.current = null;
    activeAgentRunMeta.current = null;
    setIsGenerating(false);
    setActiveConversationId(null);
    setAgentMessages([]);
    agentMessagesRef.current = [];
    setConversations(
      localConversationStorageKey
        ? readStoredList<AgentConversation>(localConversationStorageKey).filter((conversation) => conversation.runtimeSource !== "server")
        : [],
    );
  }, [localConversationStorageKey]);

  useEffect(() => {
    if (skipConversationPersist.current) {
      skipConversationPersist.current = false;
      return;
    }
    if (!localConversationStorageKey) return;
    const localOnlyConversations = conversations.filter((conversation) => conversation.runtimeSource !== "server");
    window.localStorage.setItem(localConversationStorageKey, JSON.stringify(localOnlyConversations));
  }, [conversations, localConversationStorageKey]);

  useEffect(() => {
    mountedRef.current = true;
    const handleVisibilityChange = () => {
      void taskPollerRef.current?.setVisible(document.visibilityState === "visible");
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      mountedRef.current = false;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      stopTaskPolling();
      activeAgentRun.current?.abort();
      activeAgentRunMeta.current = null;
      attachmentsRef.current.forEach((attachment) => window.URL.revokeObjectURL(attachment.previewUrl));
    };
  }, []);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  useEffect(() => {
    if (conversationProjectScopeRef.current === currentProjectId) return;
    conversationProjectScopeRef.current = currentProjectId;

    const intendedConversation = conversationsRef.current.find(
      (conversation) => conversation.id === activeConversationIdRef.current,
    );
    if (agentConversationBelongsToProject(intendedConversation, currentProjectId)) return;

    // Never render another project's Thread, approvals or messages after a
    // project change. Abort only the local watcher: the server Run remains
    // recoverable from its owning project when the user returns to it.
    activeAgentRun.current?.abort();
    activeAgentRun.current = null;
    activeAgentRunMeta.current = null;
    agentConversationRequest.current += 1;
    activeConversationIdRef.current = null;
    urlThreadRecoveryRef.current = null;
    automaticThreadRecoveryStartedRef.current = null;
    automaticThreadRecoverySuppressedRef.current = null;
    recoveredSubmissionRef.current = null;
    stopTaskPolling();
    materializedProjectIdRef.current = null;
    directorSubmissionAttemptRef.current = null;
    materializeSubmissionAttemptRef.current = null;
    imageSubmissionAttemptRef.current = null;
    videoSubmissionAttemptRef.current = null;
    hydratedUtilitySessionKeyRef.current = null;
    carryingUtilityDraftProjectIdRef.current = null;
    setIsGenerating(false);
    setIsSubmittingVideo(false);
    setPrompt(typeof locationState?.brief === "string" ? locationState.brief.trim() : "");
    setActiveConversationId(null);
    setAgentMessages([]);
    agentMessagesRef.current = [];
    setAttachments((current) => {
      current.forEach((attachment) => {
        if (attachment.previewUrl.startsWith("blob:")) window.URL.revokeObjectURL(attachment.previewUrl);
      });
      return [];
    });
    attachmentsRef.current = [];
    setReferenceUploadPending(false);
    setPortraitAdmissionBlocking(false);
    setSelectedSubjects([]);
    setSelectedSkills([]);
    setSkillLibraryOpen(false);
    setPlan(null);
    setMaterialized(null);
    setTasks([]);
    setImageAssets([]);
    setImageJob(null);
    setTaskPollErrorText("");
  }, [currentProjectId, locationState?.brief]);

  useEffect(() => {
    activeConversationIdRef.current = activeConversationId;
  }, [activeConversationId]);

  useEffect(() => {
    agentMessagesRef.current = agentMessages;
    if (activeMode !== "Agent 模式") return;
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    scrollElementIntoView(
      agentTranscriptEndRef.current,
      { behavior: reducedMotion ? "auto" : "smooth", block: "end" },
    );
  }, [activeMode, agentMessages]);

  useEffect(() => {
    if (currentProjectId) {
      void fetchAssets({ limit: 80 });
    }
  }, [currentProjectId, fetchAssets]);

  useEffect(() => {
    if (
      embedded
      || activeMode === "Agent 模式"
      || !creationSession
      || currentProjectId === null
      || String(creationSession.projectId) !== String(currentProjectId)
    ) return;
    const sessionKey = `${currentProjectId}:${creationSession.id}`;
    if (hydratedUtilitySessionKeyRef.current === sessionKey) return;

    const restored = restoreUtilityGenerationSession(creationSession.parameters);
    if (
      carryingUtilityDraftProjectIdRef.current === currentProjectId
      && !restored.materialized
    ) return;

    hydratedUtilitySessionKeyRef.current = sessionKey;
    carryingUtilityDraftProjectIdRef.current = null;
    stopTaskPolling();
    setPrompt(creationSession.goal || "");
    setPlan(restored.plan);
    materializedProjectIdRef.current = restored.materialized?.project.id ?? null;
    setMaterialized(restored.materialized);
    setImageAssets(restored.imageAssets);
    setImageJob(restored.imageAssets.length
      ? {
          id: `restored:${sessionKey}`,
          prompt: creationSession.goal || "",
          model: typeof creationSession.parameters.imageModel === "string"
            ? creationSession.parameters.imageModel
            : "已保存模型",
          ratio: typeof creationSession.parameters.ratio === "string"
            ? creationSession.parameters.ratio as QuickCreateRatio
            : "16:9",
          quality: creationSession.parameters.imageQuality === "1K"
            || creationSession.parameters.imageQuality === "2K"
            || creationSession.parameters.imageQuality === "4K"
            ? creationSession.parameters.imageQuality
            : "2K",
          count: restored.imageAssets.length,
          status: "succeeded",
          statusText: "已从项目创作记录恢复",
        }
      : null);

    if (!restored.materialized) {
      setTasks([]);
      return;
    }
  }, [
    activeMode,
    creationSession?.id,
    creationSession?.version,
    currentProjectId,
    embedded,
  ]);

  useEffect(() => {
    const projectId = materialized?.project.id;
    const pollingEnabled = (
      !embedded
      && activeMode !== "Agent 模式"
      && projectId !== undefined
      && Number(currentProjectId) === projectId
    );
    if (!pollingEnabled) {
      stopTaskPolling();
      setTaskPollErrorText("");
      return;
    }
    materializedProjectIdRef.current = projectId;
    const poller = startTaskPolling(projectId);
    void poller?.refresh();
    return () => {
      if (taskPollerProjectIdRef.current === projectId) stopTaskPolling();
    };
  }, [activeMode, currentProjectId, embedded, materialized?.project.id]);

  useEffect(() => {
    if (
      activeMode !== "Agent 模式"
      || agentChatModelsLoading
      || !currentProjectId
    ) {
      setRuntimeHistoryLoading(false);
      return;
    }
    const controller = new AbortController();
    const projectId = currentProjectId;
    setRuntimeHistoryLoading(true);
    void listAllAgentThreads(projectId, controller.signal)
      .then((threads) => {
        if (controller.signal.aborted) return;
        const projectName = currentProject?.name || "未命名项目";
        setConversations((current) => {
          const serverConversations = threads.map((thread) => runtimeConversationFromThread(
            thread,
            projectName,
            current.find((conversation) => conversation.runtimeThreadId === thread.id),
          ));
          const serverIds = new Set(serverConversations.map((conversation) => conversation.runtimeThreadId));
          // This page may have been requested before a new Thread was created.
          // Preserve entries missing from that older response; their messages
          // are always refreshed from the server when opened.
          const withoutReplaced = current.filter((conversation) => !serverIds.has(conversation.runtimeThreadId));
          return [...serverConversations, ...withoutReplaced];
        });
        const recoveryKey = agentProjectRecoveryKey(agentStorageScope, projectId);
        if (
          !recoveryKey
          || requestedThreadId
          || activeConversationIdRef.current
          || automaticThreadRecoveryStartedRef.current === recoveryKey
          || automaticThreadRecoverySuppressedRef.current === recoveryKey
        ) return;
        const orderedThreads = [...threads].sort((left, right) => (
          (right.lastMessageAt || right.updatedAt) - (left.lastMessageAt || left.updatedAt)
        ));
        const recoveryThread = orderedThreads.find((thread) => Boolean(thread.activeRootRunId)) || orderedThreads[0];
        if (!recoveryThread) return;
        automaticThreadRecoveryStartedRef.current = recoveryKey;
        void openConversation(runtimeConversationFromThread(recoveryThread, projectName));
      })
      .catch((error) => {
        if (controller.signal.aborted || (error as { name?: string })?.name === "AbortError") return;
        handleAgentRuntimeFailure(error, "Agent 历史读取失败");
      })
      .finally(() => {
        if (!controller.signal.aborted) setRuntimeHistoryLoading(false);
      });
    return () => controller.abort();
  }, [
    activeMode,
    agentChatModelsLoading,
    agentStorageScope,
    currentProject?.name,
    currentProjectId,
    requestedThreadId,
  ]);

  useEffect(() => {
    if (
      activeMode !== "Agent 模式"
      || agentChatModelsLoading
      || !pendingSubmissionStorageKey
      || isGenerating
    ) return;
    const pendingSubmission = readPendingAgentSubmission(pendingSubmissionStorageKey);
    if (!pendingSubmission) {
      recoveredSubmissionRef.current = null;
      return;
    }
    if (pendingSubmission.projectId !== currentProjectId) {
      clearPendingAgentSubmission(pendingSubmissionStorageKey);
      recoveredSubmissionRef.current = null;
      return;
    }
    if (recoveredSubmissionRef.current === pendingSubmission.clientMessageId) return;
    recoveredSubmissionRef.current = pendingSubmission.clientMessageId;
    setPrompt("");
    void recoverPendingAgentSubmissionReadOnly(
      pendingSubmission,
      pendingSubmissionStorageKey,
    );
  }, [
    activeMode,
    agentChatModelsLoading,
    currentProjectId,
    isGenerating,
    pendingSubmissionStorageKey,
  ]);

  async function recoverPendingAgentSubmissionReadOnly(
    pendingSubmission: PendingAgentSubmission,
    storageKey: string,
  ) {
    // The thread is persisted into the pending record before the message POST.
    // If it is missing, there is no safe GET key and the UI must not guess by
    // issuing another mutation.
    if (!pendingSubmission.threadId) {
      showNotice("消息结果待确认：缺少原 Thread，只允许人工查询，不会重复发送");
      return;
    }
    try {
      let accepted = false;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const messages = await listAllAgentMessages(pendingSubmission.threadId);
        accepted = messages.some((message) => (
          message.clientMessageId === pendingSubmission.clientMessageId
        ));
        if (accepted) break;
        await new Promise<void>((resolve) => window.setTimeout(resolve, 500));
      }
      if (!accepted) {
        showNotice("消息结果仍待确认：已仅用 GET 查询，未重复发送");
        return;
      }
      const thread = await getAgentThread(pendingSubmission.threadId);
      clearPendingAgentSubmission(storageKey, pendingSubmission.clientMessageId);
      await openConversation(
        runtimeConversationFromThread(thread, currentProject?.name || "未命名项目"),
      );
    } catch (error) {
      if ((error as { name?: string })?.name === "AbortError") return;
      handleAgentRuntimeFailure(error, "消息结果 GET 恢复失败");
    }
  }

  useEffect(() => {
    const searchParams = new URLSearchParams(location.search);
    const requestedMode = normalizeQuickCreateGenerationMode(
      searchParams.get("mode") || searchParams.get("ai_feature_name"),
    );
    if (!embedded && requestedMode && !isQuickCreateGenerationModeEnabled(requestedMode)) {
      showNotice(`${requestedMode}暂未开放`);
    }
    if (embedded) {
      setActivePanel((current) => current === "mode" ? null : current);
    }
    const nextMode = embedded ? "Agent 模式" : modeFromSearch(location.search);
    setActiveMode(nextMode);
  }, [embedded, location.search]);

  function showNotice(text: string) {
    setNotice(text);
    window.setTimeout(() => setNotice((current) => (current === text ? "" : current)), 2400);
  }

  function updateGenerateLocation(mode: GenerateMode, threadId?: string | null) {
    const nextSearch = buildGenerateSurfaceSearch(location.search, mode, threadId, embedded);
    if (nextSearch === location.search) return;
    navigate(`${location.pathname}${nextSearch}`, { replace: true });
  }

  function clearThreadUrlAfterFailure(error: unknown) {
    if (!shouldRemoveThreadFromUrl(error)) return false;
    automaticThreadRecoverySuppressedRef.current = agentProjectRecoveryKey(agentStorageScope, currentProjectId);
    updateGenerateLocation("Agent 模式", null);
    setActiveConversationId(null);
    setAgentMessages([]);
    agentMessagesRef.current = [];
    showNotice(threadRestoreFailureMessage(error));
    return true;
  }

  useEffect(() => {
    if (
      activeMode !== "Agent 模式"
      || agentChatModelsLoading
      || !requestedThreadId
    ) {
      urlThreadRecoveryRef.current = null;
      return;
    }
    if (activeConversationId === requestedThreadId) {
      urlThreadRecoveryRef.current = requestedThreadId;
      return;
    }

    const recoveryKey = `${agentStorageScope || "anonymous"}:${currentProjectId ?? "none"}:${requestedThreadId}`;
    if (urlThreadRecoveryRef.current === recoveryKey) return;
    urlThreadRecoveryRef.current = recoveryKey;
    const controller = new AbortController();

    void (async () => {
      try {
        const thread = await getAgentThread(requestedThreadId, controller.signal);
        if (controller.signal.aborted) return;
        if (currentProjectId !== null && String(thread.projectId) !== String(currentProjectId)) {
          throw new ApiError("Agent 对话不属于当前项目", {
            status: 409,
            code: "thread_project_mismatch",
          });
        }
        const projectState = useProjectStore.getState();
        const projectName = projectState.projects.find((item) => String(item.id) === String(thread.projectId))?.name
          || projectState.currentProject?.name
          || "未命名项目";
        const conversation = runtimeConversationFromThread(thread, projectName);
        setConversations((current) => [
          conversation,
          ...current.filter((item) => item.id !== conversation.id),
        ]);
        if (controller.signal.aborted) return;
        await openConversation(conversation, { fromUrl: true });
      } catch (error) {
        if (controller.signal.aborted || (error as { name?: string })?.name === "AbortError") return;
        urlThreadRecoveryRef.current = null;
        if (clearThreadUrlAfterFailure(error)) return;
        handleAgentRuntimeFailure(error, "Agent 对话恢复失败");
      }
    })();

    return () => {
      controller.abort();
      if (urlThreadRecoveryRef.current === recoveryKey) {
        urlThreadRecoveryRef.current = null;
      }
    };
  }, [
    activeMode,
    agentChatModelsLoading,
    agentStorageScope,
    currentProjectId,
    requestedThreadId,
  ]);

  function redirectExpiredSession() {
    activeAgentRun.current?.abort();
    activeAgentRun.current = null;
    activeAgentRunMeta.current = null;
    logout();
    const redirect = `${location.pathname}${location.search}`;
    navigate(`/auth/login?redirect=${encodeURIComponent(redirect)}&reason=session-expired`, { replace: true });
  }

  function handleAgentRuntimeFailure(error: unknown, fallback: string) {
    if (error instanceof ApiError && error.status === 401) {
      showNotice("登录已失效，请重新登录");
      redirectExpiredSession();
      return true;
    }
    showNotice(formatAgentRuntimeFailure(error, fallback));
    return false;
  }

  function clearSelectedAgentContext() {
    setAttachments((current) => {
      current.forEach((attachment) => window.URL.revokeObjectURL(attachment.previewUrl));
      return [];
    });
    setSelectedSubjects([]);
    setSelectedSkills([]);
  }

  function startNewConversation() {
    const activeRun = activeAgentRunMeta.current;
    if (activeRun && !activeRun.runId) {
      showNotice("消息正在提交，请稍候再新建对话");
      return;
    }
    if (agentRunRecoveryPending) {
      showNotice("原运行状态尚未确认，请先恢复原运行，再决定停止或新建对话");
      return;
    }
    if (!activeRun) clearPendingAgentSubmission(pendingSubmissionStorageKey);
    if (activeMode === "Agent 模式") {
      automaticThreadRecoverySuppressedRef.current = agentProjectRecoveryKey(agentStorageScope, currentProjectId);
    }
    if (activeRun?.runId) {
      void cancelAgentRun(activeRun.runId).catch((error) => handleAgentRuntimeFailure(error, "停止 Agent 失败"));
    }
    activeAgentRun.current?.abort();
    activeAgentRun.current = null;
    activeAgentRunMeta.current = null;
    agentConversationRequest.current += 1;
    setIsGenerating(false);
    setPrompt("");
    clearSelectedAgentContext();
    setActiveConversationId(null);
    setAgentMessages([]);
    agentMessagesRef.current = [];
    setSkillLibraryOpen(false);
    resetGeneratedState();
    updateGenerateLocation(activeMode, null);
  }

  async function openConversation(conversation: AgentConversation, options: OpenConversationOptions = {}) {
    if (activeAgentRunMeta.current && !activeAgentRunMeta.current.runId) {
      showNotice("消息正在提交，请稍候再切换对话");
      return;
    }
    if (!isGenerationModeAvailableOnSurface(conversation.mode, embedded)) {
      showNotice(embedded ? "当前工作态仅支持 Agent 模式" : `${conversation.mode}暂未开放`);
      return;
    }
    if (!activeAgentRunMeta.current) clearPendingAgentSubmission(pendingSubmissionStorageKey);
    const requestId = agentConversationRequest.current + 1;
    agentConversationRequest.current = requestId;
    activeAgentRun.current?.abort();
    activeAgentRun.current = null;
    activeAgentRunMeta.current = null;
    setIsGenerating(false);
    clearSelectedAgentContext();
    activeConversationIdRef.current = conversation.id;
    setActiveConversationId(conversation.id);
    setPrompt(conversation.mode === "Agent 模式" ? "" : conversation.prompt);
    const conversationProjectId = normalizeProjectId(conversation.projectId);
    const switchingProject = conversationProjectId !== null
      && conversationProjectId !== currentProjectId;
    if (switchingProject) {
      selectProject(conversationProjectId);
      const targetMode = embedded
        ? "canvas"
        : conversation.mode === "Agent 模式" ? "agent" : "quick";
      navigate(buildProjectModeHref(targetMode, {
        projectId: conversationProjectId,
        sessionId: null,
        threadId: conversation.mode === "Agent 模式"
          ? conversation.runtimeThreadId || null
          : null,
        canvasId: null,
      }, location.search));
      setActiveMode(conversation.mode);
      setActivePanel(null);
    } else {
      switchMode(conversation.mode, conversation.runtimeThreadId || null);
    }
    // Runtime Thread summaries do not carry generation preferences. Do not
    // erase the current catalog defaults when restoring a server conversation.
    if (conversation.ratio) setSelectedRatio(conversation.ratio);
    if (conversation.llmModel) setSelectedLlmModel(conversation.llmModel);
    setVideoSettings((current) => ({
      ...current,
      model: conversation.videoModel || current.model,
      resolution: conversation.resolution || current.resolution,
      mode: conversation.videoMode || current.mode,
      duration: conversation.videoDuration || current.duration,
      audio: conversation.videoAudio ?? current.audio,
      outputFormat: conversation.outputFormat ?? current.outputFormat,
    }));
    if (conversation.projectId && !switchingProject) selectProject(conversation.projectId);
    resetGeneratedState();
    const restoredMessages = conversation.messages?.length
      ? conversation.messages
      : conversation.mode === "Agent 模式" && conversation.prompt
        ? [{ id: `legacy-${conversation.id}`, role: "user" as const, content: conversation.prompt, createdAt: conversation.updatedAt }]
        : [];
    setAgentMessages(restoredMessages);
    agentMessagesRef.current = restoredMessages;
    setPlan(conversation.mode === "Agent 模式" ? null : conversation.lastPlan || null);

    if (!conversation.runtimeThreadId) return;
    try {
      const thread = await getAgentThread(conversation.runtimeThreadId);
      if (conversation.projectId && String(thread.projectId) !== String(conversation.projectId)) {
        throw new ApiError("Agent 对话不属于当前项目", {
          status: 409,
          code: "thread_project_mismatch",
        });
      }
      const snapshotRunId = thread.activeRootRunId || conversation.runtimeActiveRunId;
      const [initialMessages, activeRun] = await Promise.all([
        listAllAgentMessages(conversation.runtimeThreadId),
        snapshotRunId ? getAgentRun(snapshotRunId) : Promise.resolve(null),
      ]);
      const serverMessages = activeRun && isTerminalAgentRun(activeRun)
        ? await listAllAgentMessages(conversation.runtimeThreadId)
        : initialMessages;
      const [stepSnapshots, approvalSnapshots] = await Promise.all([
        loadAgentRuntimeStepSnapshots(serverMessages, [snapshotRunId, activeRun?.id]),
        loadAgentRuntimeApprovalSnapshots(serverMessages, [snapshotRunId, activeRun?.id]),
      ]);
      if (agentConversationRequest.current !== requestId) return;
      const restoredRuntimeMessages = toAgentUiMessages(serverMessages, stepSnapshots, approvalSnapshots);
      agentMessagesRef.current = restoredRuntimeMessages;
      setAgentMessages(restoredRuntimeMessages);
      setPlan(null);
      setConversations((current) => current.map((item) => item.id === conversation.id
        ? {
            ...runtimeConversationFromThread(thread, item.projectName, item),
            messages: restoredRuntimeMessages,
            lastPlan: null,
          }
        : item));
      if (activeRun && !isTerminalAgentRun(activeRun)) {
        const runningAssistant = [...restoredRuntimeMessages].reverse().find((message) => (
          message.role === "assistant" && message.status === "running"
        ));
        const triggeringUser = restoredRuntimeMessages.find((message) => (
          message.role === "user" && message.id === activeRun.triggerMessageId
        ));
        const controller = new AbortController();
        activeAgentRun.current = controller;
        activeAgentRunMeta.current = {
          conversationId: conversation.id,
          threadId: conversation.runtimeThreadId,
          runId: activeRun.id,
          clientMessageId: triggeringUser?.clientMessageId || null,
          brief: conversation.prompt,
          messageId: runningAssistant?.id || activeRun.id,
        };
        setIsGenerating(true);
        void watchAgentRun({
          controller,
          conversationId: conversation.id,
          threadId: conversation.runtimeThreadId,
          runId: activeRun.id,
          brief: conversation.prompt,
          after: thread.eventSeq,
        });
      }
    } catch (error) {
      if ((error as { name?: string })?.name === "AbortError") return;
      if (agentConversationRequest.current !== requestId) return;
      if (options.fromUrl && clearThreadUrlAfterFailure(error)) return;
      handleAgentRuntimeFailure(error, "Agent 对话读取失败");
    }
  }

  function rememberConversation(
    title: string,
    brief: string,
    conversationId?: string,
    options?: { messages?: AgentMessage[]; lastPlan?: QuickCreateDirectorPlan | null },
  ) {
    const id = conversationId || activeConversationId || window.crypto.randomUUID();
    const projectId = currentProjectId === null ? null : String(currentProjectId);
    setConversations((current) => {
      const existing = current.find((item) => item.id === id);
      const nextConversation: AgentConversation = {
        ...existing,
        id,
        title: title.trim() || existing?.title || brief.slice(0, 22) || "未命名对话",
        projectId,
        projectName: currentProject?.name || existing?.projectName || "未关联项目",
        prompt: brief,
        mode: activeMode,
        llmModel: selectedLlmOption?.id || "",
        ratio: selectedRatio,
        videoModel: selectedVideoCapability?.id || "",
        resolution: videoSettings.resolution,
        outputFormat: videoSettings.outputFormat,
        videoMode: videoSettings.mode,
        videoDuration: videoSettings.duration,
        videoAudio: videoSettings.audio,
        updatedAt: Date.now(),
        messages: options?.messages ?? existing?.messages,
        lastPlan: options && "lastPlan" in options ? options.lastPlan : existing?.lastPlan,
      };
      return [nextConversation, ...current.filter((item) => item.id !== id)].slice(0, 80);
    });
    setActiveConversationId(id);
    return id;
  }

  function commitAgentMessages(
    nextMessages: AgentMessage[],
    brief: string,
    conversationId: string,
    title?: string,
    latestPlan?: QuickCreateDirectorPlan | null,
  ) {
    agentMessagesRef.current = nextMessages;
    setAgentMessages(nextMessages);
    rememberConversation(title || brief.slice(0, 22), brief, conversationId, {
      messages: nextMessages,
      lastPlan: latestPlan === undefined ? null : latestPlan,
    });
  }

  function cacheRuntimeMessages(conversationId: string, nextMessages: AgentMessage[]) {
    agentMessagesRef.current = nextMessages;
    setAgentMessages(nextMessages);
    setConversations((current) => current.map((conversation) => conversation.id === conversationId
      ? { ...conversation, messages: nextMessages, lastPlan: null, updatedAt: Date.now() }
      : conversation));
  }

  function cacheRuntimeRunSteps(
    conversationId: string,
    runId: string,
    incoming: AgentRuntimeStep[],
    stepsError?: string | null,
  ) {
    const nextMessages = mergeRunStepsIntoMessages(
      agentMessagesRef.current,
      runId,
      incoming,
      stepsError,
    );
    cacheRuntimeMessages(conversationId, nextMessages);
  }

  function cacheRuntimeRunApprovals(
    conversationId: string,
    runId: string,
    incoming: AgentRuntimeApproval[],
    approvalsError?: string | null,
    replace = false,
  ) {
    const nextMessages = mergeRunApprovalsIntoMessages(
      agentMessagesRef.current,
      runId,
      incoming,
      approvalsError,
      replace,
    );
    cacheRuntimeMessages(conversationId, nextMessages);
  }

  async function refreshRuntimeRunSteps(
    conversationId: string,
    runId: string,
    signal?: AbortSignal,
  ) {
    try {
      const steps = await listAllAgentRunSteps(runId, signal);
      if (signal?.aborted) return;
      cacheRuntimeRunSteps(conversationId, runId, steps, null);
    } catch (error) {
      if (signal?.aborted || (error as { name?: string })?.name === "AbortError") return;
      cacheRuntimeRunSteps(conversationId, runId, [], runtimeStepsFailureMessage());
    }
  }

  async function refreshRuntimeRunApprovals(
    conversationId: string,
    runId: string,
    signal?: AbortSignal,
  ) {
    try {
      const approvals = await listAllAgentRunApprovals(runId, signal);
      if (signal?.aborted) return false;
      cacheRuntimeRunApprovals(conversationId, runId, approvals, null, true);
      return true;
    } catch (error) {
      if (signal?.aborted || (error as { name?: string })?.name === "AbortError") return false;
      cacheRuntimeRunApprovals(conversationId, runId, [], runtimeApprovalsFailureMessage());
      return false;
    }
  }

  function handleApprovalUpdated(approval: AgentRuntimeApproval) {
    const conversationId = activeConversationIdRef.current;
    if (!conversationId) return;
    cacheRuntimeRunApprovals(conversationId, approval.runId, [approval], null);
  }

  /**
   * 全量刷新 Thread 消息(含 system 通知),用于异步任务终态等
   * 不属于当前 Run 的线程级更新;失败静默(已有消息保持不变)。
   */
  async function refreshRuntimeMessages(
    conversationId: string,
    threadId: string,
    signal?: AbortSignal,
  ) {
    try {
      const serverMessages = await listAllAgentMessages(threadId, signal);
      if (signal?.aborted) return;
      const runIds = [...new Set(serverMessages.map((message) => message.runId).filter(Boolean))] as string[];
      const [stepSnapshots, approvalSnapshots] = await Promise.all([
        loadAgentRuntimeStepSnapshots(serverMessages, runIds, signal),
        loadAgentRuntimeApprovalSnapshots(serverMessages, runIds, signal),
      ]);
      if (signal?.aborted) return;
      cacheRuntimeMessages(conversationId, toAgentUiMessages(serverMessages, stepSnapshots, approvalSnapshots));
    } catch {
      // 静默:下一次消息事件或会话重开时会再次同步。
    }
  }

  function refreshVisibleApproval(runId: string) {
    const conversationId = activeConversationIdRef.current;
    if (!conversationId) return Promise.resolve(false);
    return refreshRuntimeRunApprovals(conversationId, runId);
  }

  function toggleSkill(skill: AgentSkill) {
    setSelectedSkills((current) => {
      if (current.some((item) => item.id === skill.id)) {
        return current.filter((item) => item.id !== skill.id);
      }
      if (current.length >= AGENT_SKILL_SELECTION_LIMIT) {
        showNotice(`每轮最多选择 ${AGENT_SKILL_SELECTION_LIMIT} 个官方技能`);
        return current;
      }
      return [...current, skill];
    });
  }

  function applyCustomRatio() {
    const width = Math.max(1, Math.min(100, Number(customRatio.width) || 0));
    const height = Math.max(1, Math.min(100, Number(customRatio.height) || 0));
    if (!width || !height) {
      showNotice("请输入有效的宽高比例");
      return;
    }
    setSelectedRatio(`${Math.round(width)}:${Math.round(height)}`);
    setCustomRatioOpen(false);
  }

  function selectImageModel(modelId: string) {
    const capability = imageCapabilities.find((item) => item.id === modelId);
    if (!capability) return;
    const next = reconcileImageSettings(
      { model: imageModel, quality: imageQuality },
      capability,
      { resetModelDefaults: true },
    );
    setImageModel(next.model);
    setImageQuality(next.quality);
    if (activePreferenceTab === "图片") {
      setSelectedRatio((current) => reconcileImageAspectRatio(current, capability) as QuickCreateRatio);
    }
  }

  function selectVideoModel(option: VideoModelOption) {
    const capability = videoCapabilities.find((item) => item.id === option.id);
    if (!capability) return;
    setVideoSettings((current) => reconcileVideoSettings(current, capability, { resetModelDefaults: true }));
    if (activePreferenceTab === "视频") {
      setSelectedRatio((current) => reconcileVideoAspectRatio(current, capability) as QuickCreateRatio);
    }
  }

  function stopTaskPolling() {
    const poller = taskPollerRef.current;
    taskPollerRef.current = null;
    taskPollerProjectIdRef.current = null;
    poller?.stop();
  }

  function isTaskPollingContextCurrent(projectId: number) {
    return mountedRef.current
      && taskPollerProjectIdRef.current === projectId
      && materializedProjectIdRef.current === projectId
      && Number(useProjectStore.getState().currentProjectId) === projectId;
  }

  function taskPollErrorMessage(error: unknown, kind: PollErrorKind) {
    if (kind === "session") return "登录状态已失效，请重新登录后刷新视频任务";
    if (kind === "stop") return "任务不存在或无权访问，已停止自动刷新";
    if (kind === "rate_limit") return "任务状态查询过于频繁，正在稍后重试";
    const detail = error instanceof Error ? error.message.trim() : "";
    return `视频任务状态暂时无法更新，正在自动重试${detail ? `：${detail}` : ""}`;
  }

  function createProjectTaskPoller(projectId: number) {
    return createTaskPoller<QuickCreateVideoTask[], number>({
      fetchTasks: () => listQuickCreateTasks(projectId),
      shouldContinue: (nextTasks) => nextTasks.some((task) => shouldPollTask(task.status)),
      onData: (nextTasks) => {
        if (!isTaskPollingContextCurrent(projectId)) return;
        setTasks(nextTasks);
        setTaskPollErrorText("");
      },
      onState: () => undefined,
      onError: (error, kind) => {
        if (!isTaskPollingContextCurrent(projectId)) return;
        setTaskPollErrorText(taskPollErrorMessage(error, kind));
      },
      onCallbackError: () => {
        if (!isTaskPollingContextCurrent(projectId)) return;
        setTaskPollErrorText("视频任务状态更新出现异常，可点击立即重试");
      },
      schedule: (callback, delay) => window.setTimeout(callback, delay),
      cancelSchedule: (handle) => window.clearTimeout(handle),
      isVisible: () => document.visibilityState === "visible",
    });
  }

  function startTaskPolling(projectId: number) {
    if (
      taskPollerRef.current
      && taskPollerProjectIdRef.current === projectId
    ) return taskPollerRef.current;
    stopTaskPolling();
    taskPollerProjectIdRef.current = projectId;
    const poller = createProjectTaskPoller(projectId);
    taskPollerRef.current = poller;
    return poller;
  }

  async function refreshTasks(projectId = materializedProjectIdRef.current ?? undefined) {
    if (!projectId || materializedProjectIdRef.current !== projectId) return;
    if (Number(useProjectStore.getState().currentProjectId) !== projectId) return;
    const poller = startTaskPolling(projectId);
    await poller.refresh();
  }

  async function handleCancelVideoTask(task: QuickCreateVideoTask) {
    if (!task.relayTaskId || cancellingVideoTaskId) return;
    setCancellingVideoTaskId(task.relayTaskId);
    try {
      await cancelQuickCreateTask(task.relayTaskId);
      showNotice("取消请求已提交，正在核对任务与 GU 状态");
      stopTaskPolling();
      await refreshTasks(task.projectId || materialized?.project.id);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "取消任务失败");
    } finally {
      setCancellingVideoTaskId("");
    }
  }

  function resetGeneratedState() {
    stopTaskPolling();
    materializedProjectIdRef.current = null;
    directorSubmissionAttemptRef.current = null;
    materializeSubmissionAttemptRef.current = null;
    imageSubmissionAttemptRef.current = null;
    videoSubmissionAttemptRef.current = null;
    setTaskPollErrorText("");
    setPlan(null);
    setMaterialized(null);
    setTasks([]);
    setImageAssets([]);
    setImageJob(null);
  }

  function buildContextLines() {
    const imageContext = `图片模型：${selectedImageCapability?.label || imageModel || "未配置"}；清晰度：${imageQuality}；数量：${imageCount}`;
    const videoContext = `视频模型：${selectedVideoCapability?.label || videoSettings.model}；模式：${selectedVideoCapability?.modes.find((mode) => mode.id === videoSettings.mode)?.label || videoSettings.mode}；清晰度：${videoSettings.resolution}；单镜头时长：${videoDurationLabel(videoSettings.duration)}；生成音频：${videoSettings.audio ? "开启" : "关闭"}`;
    return [
      `创作入口：${activeMode}`,
      activeMode !== "图片生成" ? `语言模型：${selectedLlmOption?.label || selectedLlmModel}` : "",
      `当前生成偏好：${activePreferenceTab}；比例：${selectedRatio}`,
      activeMode === "Agent 模式" || activeMode === "图片生成" ? imageContext : "",
      activeMode === "Agent 模式" || activeMode !== "图片生成" ? videoContext : "",
      activeMode === "Agent 模式" && pendingContextAssets.length
        ? `资产要求：${pendingContextAssets.map((asset) => `${asset.name}（${asset.kind || "项目资产"}${asset.assetId ? `，assetId：${asset.assetId}` : ""}）`).join("；")}`
        : "",
      activeMode === "Agent 模式" && pendingContextSkills.length
        ? `使用技能：${pendingContextSkills.map((skill) => skill.name).join("；")}`
        : "",
      pendingContextReferences.length
        ? `参考附件：${pendingContextReferences.map((reference) => `${reference.name}（${reference.kind || "文件"}${reference.assetVersionId ? `，assetVersionId：${reference.assetVersionId}` : ""}）`).join("、")}`
        : "",
      pendingContextStyles.length ? `项目风格：${pendingContextStyles.map((style) => style.name).join("；")}` : "",
    ].filter(Boolean);
  }

  function switchMode(mode: GenerateMode, threadId?: string | null) {
    if (!isGenerationModeAvailableOnSurface(mode, embedded)) {
      if (!embedded) showNotice(`${mode}暂未开放`);
      setActivePanel(null);
      return;
    }
    const catalogLoading = mode === "Agent 模式"
      ? agentChatModelsLoading
      : modelOptionsLoading;
    if (catalogLoading && mode !== "Agent 模式") {
      showNotice("模型目录仍在加载，请稍后再切换");
      setActivePanel(null);
      return;
    }
    if (mode !== "Agent 模式" && !runtimeGenerationModes.includes(mode)) {
      showNotice(modelOptionsError || `${mode}没有完整的真实可提交模型`);
      setActivePanel(null);
      return;
    }
    if (mode !== "Agent 模式" && agentRunRecoveryPending) {
      showNotice("原 Agent Run 状态尚未确认，请先恢复原运行");
      return;
    }
    if (activeMode === "Agent 模式" && mode !== "Agent 模式" && isGenerating) {
      if (activeAgentRunMeta.current && !activeAgentRunMeta.current.runId) {
        showNotice("消息正在提交，请稍候再切换模式");
        return;
      }
      void stopAgentRun();
    }
    setActiveMode(mode);
    setActivePanel(null);
    if (mode !== "Agent 模式") {
      setSkillLibraryOpen(false);
      setSelectedSubjects([]);
    }
    if (mode === "Agent 模式") setModelTab("对话");
    if (mode === "图片生成") {
      setModelTab("图片");
      setAgentPreferenceTab("图片");
    }
    if (mode === "视频生成") {
      setModelTab("视频");
      setAgentPreferenceTab("视频");
    }
    resetGeneratedState();
    if (mode === "图片生成") {
      setSelectedRatio((current) => selectedImageCapability
        ? reconcileImageAspectRatio(current, selectedImageCapability) as QuickCreateRatio
        : "");
    } else if (mode === "视频生成" && selectedVideoCapability) {
      setSelectedRatio((current) => reconcileVideoAspectRatio(current, selectedVideoCapability) as QuickCreateRatio);
    }
    const nextThreadId = mode === "Agent 模式"
      ? threadId === undefined
        ? activeConversation?.runtimeThreadId || null
        : threadId
      : null;
    updateGenerateLocation(mode, nextThreadId);
  }

  function buildPlanBrief(brief: string) {
    return `${buildContextLines().join("\n")}\n\n${brief}`;
  }

  function buildImagePrompt(brief: string) {
    const context = buildContextLines();
    return [brief, context.length ? `创作上下文：\n${context.join("\n")}` : ""].filter(Boolean).join("\n\n");
  }

  function handleFilesSelected(files: FileList | null) {
    if (!files?.length || referenceUploadPending) return;
    const candidates = Array.from(files).map((file) => {
      const type = generateAttachmentType(file);
      return {
        file,
        type,
        kind: generateAttachmentKind(type),
      };
    });
    const accepted = candidates.filter((candidate) => (
      isGenerateAttachmentAllowed(activeMode, candidate, videoInputSlots)
    ));
    const rejected = candidates.filter((candidate) => (
      !isGenerateAttachmentAllowed(activeMode, candidate, videoInputSlots)
    ));
    const nextAttachments = accepted.map(({ file, type, kind }) => ({
      id: `${file.name}-${file.lastModified}-${window.crypto.randomUUID()}`,
      name: file.name,
      size: file.size,
      type,
      previewUrl: window.URL.createObjectURL(file),
      kind,
      file,
    })) satisfies GenerateAttachment[];
    const sourceAttachments = [...attachmentsRef.current, ...nextAttachments];
    attachmentsRef.current = sourceAttachments;
    setAttachments(sourceAttachments);
    if (rejected.length) {
      showNotice(
        activeMode === "Agent 模式"
          ? `不支持的附件已忽略：${rejected.map(({ file }) => file.name).join("、")}`
          : `仅保留当前模式会真实提交的参考：${rejected.map(({ file }) => file.name).join("、")}`,
      );
    } else if (nextAttachments.length) {
      const includesAgentVideo = activeMode === "Agent 模式"
        && nextAttachments.some((attachment) => attachment.kind === "video");
      showNotice(
        includesAgentVideo
          ? `已添加 ${nextAttachments.length} 个本地参考；视频只作为生成工具参考，不解析画面或声音`
          : `已添加 ${nextAttachments.length} 个本地参考，将随下一条消息提交`,
      );
    }

    const projectId = Number(currentProjectId);
    const hasPortraitMedia = nextAttachments.some((attachment) => (
      attachment.kind === "image" || attachment.kind === "video"
    ));
    if (hasPortraitMedia && Number.isSafeInteger(projectId) && projectId > 0) {
      // Upload immediately so server-owned portrait admission can complete
      // before a generation request is submitted from this shared surface.
      setReferenceUploadPending(true);
      setPortraitAdmissionBlocking(true);
      void ensureAttachmentsUploadedForProject(projectId, sourceAttachments)
        .catch((error) => {
          setPortraitAdmissionBlocking(false);
          showNotice(error instanceof Error ? error.message : "参考素材上传失败");
        })
        .finally(() => setReferenceUploadPending(false));
    }
  }

  function utilitySessionParameters(
    overrides: Partial<QuickCreateSessionParameters> = {},
  ): Partial<QuickCreateSessionParameters> {
    return {
      generationMode: activeMode,
      ratio: selectedRatio || undefined,
      llmModel: selectedLlmOption?.id || undefined,
      imageModel: selectedImageCapability?.id || undefined,
      imageQuality,
      imageCount,
      videoModel: selectedVideoCapability?.id || undefined,
      videoResolution: videoSettings.resolution || undefined,
      videoOutputFormat: videoSettings.outputFormat,
      videoAudio: videoSettings.audio,
      videoMode: videoSettings.mode || undefined,
      videoDuration: videoSettings.duration,
      directorPlan: plan,
      materializedProject: materialized,
      generatedImageAssets: imageAssets,
      ...overrides,
    };
  }

  async function persistUtilityGenerationState(
    projectId: number,
    overrides: Partial<QuickCreateSessionParameters> = {},
  ) {
    const sessionState = useSessionStore.getState();
    if (sessionState.boundProjectId !== projectId || !sessionState.session) {
      await sessionState.ensureSession(projectId, "quick_create");
    }
    await useSessionStore.getState().saveSession({
      goal: prompt.trim(),
      parameters: utilitySessionParameters(overrides),
    });
  }

  async function ensureAttachmentsUploadedForProject(
    projectId: number,
    sourceAttachments: GenerateAttachment[],
    generationState: Partial<QuickCreateSessionParameters> = {},
  ): Promise<GenerateAttachment[]> {
    const sessionStateBefore = useSessionStore.getState();
    const sourceProjectId = sessionStateBefore.boundProjectId;
    const staleControlledAttachments = sourceAttachments.filter((attachment) => (
      attachment.assetVersionId
      && !attachment.file
      && sourceProjectId !== projectId
    ));
    if (staleControlledAttachments.length) {
      throw new Error(
        `以下参考属于其他项目，不能跨项目复用：${staleControlledAttachments.map((item) => item.name).join("、")}。请重新添加原文件。`,
      );
    }

    const uploads = new Map<string, UploadedReferenceAsset>();
    for (const attachment of sourceAttachments) {
      if (attachment.assetVersionId && sourceProjectId === projectId) continue;
      if (!attachment.file) {
        throw new Error(`参考素材缺少可上传原文件：${attachment.name}`);
      }
      uploads.set(attachment.id, await uploadReferenceAttachment(projectId, attachment.file));
    }

    const nextAttachments = sourceAttachments.map((attachment) => {
      const uploaded = uploads.get(attachment.id);
      if (!uploaded) return attachment;
      if (attachment.previewUrl.startsWith("blob:")) {
        window.URL.revokeObjectURL(attachment.previewUrl);
      }
      return {
        ...attachment,
        name: uploaded.name || attachment.name,
        size: uploaded.size || attachment.size,
        type: uploaded.mimeType || attachment.type,
        previewUrl: uploaded.previewUrl,
        kind: uploaded.type === "image"
          ? "image" as const
          : uploaded.type === "video"
            ? "video" as const
            : "file" as const,
        assetId: uploaded.assetId,
        assetVersionId: String(uploaded.assetVersionId),
        filePath: uploaded.filePath,
        file: undefined,
      };
    });
    attachmentsRef.current = nextAttachments;
    setAttachments(nextAttachments);

    const sessionState = useSessionStore.getState();
    if (sessionState.boundProjectId !== projectId || !sessionState.session) {
      await sessionState.ensureSession(projectId, "quick_create");
    }
    const uploadedAttachments: NonNullable<QuickCreateSessionParameters["uploadedAttachments"]> = [];
    nextAttachments.forEach((attachment) => {
      const assetVersionId = Number(attachment.assetVersionId);
      if (
        !Number.isSafeInteger(assetVersionId)
        || assetVersionId <= 0
        || !Number.isSafeInteger(attachment.assetId)
        || Number(attachment.assetId) <= 0
        || !attachment.filePath
      ) return;
      uploadedAttachments.push({
        clientId: attachment.id,
        name: attachment.name,
        size: attachment.size,
        mimeType: attachment.type,
        assetId: Number(attachment.assetId),
        assetVersionId,
        filePath: attachment.filePath,
        previewUrl: attachment.previewUrl,
        type: attachment.kind === "file"
          ? attachment.type.startsWith("audio/") ? "audio" : "document"
          : attachment.kind,
      });
    });
    await useSessionStore.getState().saveSession({
      goal: prompt.trim(),
      parameters: utilitySessionParameters({
        ...generationState,
        uploadedAttachments,
      }),
      selectedAssetVersionIds: nextAttachments
        .map((attachment) => String(attachment.assetVersionId || "").trim())
        .filter(Boolean),
    });
    return nextAttachments;
  }

  function removeAttachment(id: string) {
    const target = attachmentsRef.current.find((attachment) => attachment.id === id);
    setAttachments((current) => {
      const currentTarget = current.find((attachment) => attachment.id === id);
      if (currentTarget?.previewUrl.startsWith("blob:")) {
        window.URL.revokeObjectURL(currentTarget.previewUrl);
      }
      return current.filter((attachment) => attachment.id !== id);
    });
    if (!target?.assetVersionId) return;
    const sessionState = useSessionStore.getState();
    if (!sessionState.session || sessionState.boundProjectId !== currentProjectId) return;
    const version = target.assetVersionId;
    const uploadedAttachments = Array.isArray(sessionState.session.parameters.uploadedAttachments)
      ? sessionState.session.parameters.uploadedAttachments
        .filter(isRecord)
        .filter((attachment) => String(attachment.assetVersionId || "") !== version)
      : [];
    void sessionState.saveSession({
      parameters: { uploadedAttachments },
      selectedAssetVersionIds: sessionState.session.selectedAssetVersionIds.filter(
        (assetVersionId) => assetVersionId !== version,
      ),
    }).catch((error) => {
      showNotice(error instanceof Error ? error.message : "移除参考附件失败");
    });
  }

  function applySubject(subject: GenerateSubject) {
    setSelectedSubjects((current) => {
      if (current.some((item) => item.id === subject.id)) return current;
      return [...current, subject];
    });
    setPrompt((current) => {
      if (current.includes(`@${subject.name}`)) return current;
      return `${current}${current ? " " : ""}@${subject.name}`;
    });
    setActivePanel(null);
    showNotice(`已 @ 资产：${subject.name}`);
  }

  function startVoiceInput() {
    const SpeechRecognition =
      (window as typeof window & { SpeechRecognition?: any; webkitSpeechRecognition?: any }).SpeechRecognition ||
      (window as typeof window & { SpeechRecognition?: any; webkitSpeechRecognition?: any }).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      showNotice("当前浏览器不支持语音输入");
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.lang = "zh-CN";
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.onstart = () => showNotice("正在聆听...");
    recognition.onerror = (event: { error?: string }) => {
      showNotice(event.error === "not-allowed" ? "浏览器未授权麦克风" : "语音输入失败");
    };
    recognition.onresult = (event: { results?: ArrayLike<ArrayLike<{ transcript?: string }>> }) => {
      const transcript = event.results?.[0]?.[0]?.transcript?.trim();
      if (!transcript) return;
      setPrompt((current) => [current.trim(), transcript].filter(Boolean).join("\n"));
      resetGeneratedState();
      showNotice("已写入语音内容");
    };
    recognition.start();
  }

  async function watchAgentRun(input: {
    controller: AbortController;
    conversationId: string;
    threadId: string;
    runId: string;
    brief: string;
    after?: number;
  }) {
    const initialCursor = Math.max(0, input.after ?? 0);
    let snapshotFloor = initialCursor;
    let cursor = initialCursor;
    let terminal = false;
    let snapshotRecoveries = 0;
    let streamReconnectAttempts = 0;
    let transportRecoveryPending = false;
    const seenEventIds = new Set<string>();
    const seenEventSequences = new Set<number>();
    const terminalTypes = new Set(["run.succeeded", "run.failed", "run.cancelled"]);
    const messageDeltaBuffer = createAgentMessageDeltaBuffer();
    try {
      while (!terminal && !input.controller.signal.aborted) {
        try {
          const stream = await streamAgentEvents(input.threadId, {
            after: cursor,
            signal: input.controller.signal,
            onMessageDelta: (delta) => {
              if (input.controller.signal.aborted) return;
              if (delta.runId && delta.runId !== input.runId) return;
              const accumulated = delta.snapshot
                ? messageDeltaBuffer.replace(delta.messageId, delta.delta)
                : messageDeltaBuffer.append(delta.messageId, delta.delta);
              const nextMessages = applyAgentMessageDeltaContent(agentMessagesRef.current, {
                runId: input.runId,
                messageId: delta.messageId,
                content: accumulated,
              });
              if (nextMessages !== agentMessagesRef.current) {
                cacheRuntimeMessages(input.conversationId, nextMessages);
              }
            },
            onEvent: (event) => {
              const eventId = typeof event.id === "string" ? event.id : null;
              const eventSequence = typeof event.seq === "number" && Number.isSafeInteger(event.seq)
                ? event.seq
                : null;
              if (eventSequence !== null && eventSequence <= snapshotFloor) return;
              if (eventId && seenEventIds.has(eventId)) return;
              if (eventSequence !== null && seenEventSequences.has(eventSequence)) return;
              if (eventId) seenEventIds.add(eventId);
              if (eventSequence !== null) {
                seenEventSequences.add(eventSequence);
                cursor = Math.max(cursor, eventSequence);
              }
              // 系统通知(如视频生成完成)不属于当前 Run,但落在同一 Thread:
              // 到达即刷新消息列表,保证异步任务结果实时可见。
              if (event.type === "message.created" && event.payload?.role === "system") {
                void refreshRuntimeMessages(input.conversationId, input.threadId, input.controller.signal);
              }
              const eventRunId = event.runId || (typeof event.payload?.runId === "string" ? event.payload.runId : null);
              if (eventRunId !== input.runId) return;
              if (event.type.startsWith("step.")) {
                const currentSteps = agentMessagesRef.current.find((message) => (
                  message.role === "assistant" && message.runId === input.runId
                ))?.steps || [];
                const step = agentRuntimeStepFromEvent(event, input.runId, currentSteps);
                if (step) {
                  cacheRuntimeRunSteps(input.conversationId, input.runId, [step], null);
                } else {
                  void refreshRuntimeRunSteps(input.conversationId, input.runId, input.controller.signal);
                }
              }
              if (event.type === "run.status") {
                const status = typeof event.payload?.status === "string" ? event.payload.status : null;
                const nextMessages = mergeAgentRunStateIntoMessages(
                  agentMessagesRef.current,
                  input.runId,
                  agentRunStateLabel(status),
                );
                if (nextMessages !== agentMessagesRef.current) {
                  cacheRuntimeMessages(input.conversationId, nextMessages);
                }
              }
              if (event.type.startsWith("approval.")) {
                void refreshRuntimeRunApprovals(input.conversationId, input.runId, input.controller.signal);
              }
              if (terminalTypes.has(event.type)) {
                terminal = true;
                return false;
              }
            },
          });
          cursor = Math.max(cursor, stream.lastSequence);
          streamReconnectAttempts = 0;
          if (!terminal && !input.controller.signal.aborted) {
            await new Promise((resolve) => window.setTimeout(resolve, 250));
          }
        } catch (error) {
          if (error instanceof ApiError && error.status === 410 && snapshotRecoveries < 2) {
            snapshotRecoveries += 1;
            const [thread, run, messages] = await Promise.all([
              getAgentThread(input.threadId, input.controller.signal),
              getAgentRun(input.runId, input.controller.signal),
              listAllAgentMessages(input.threadId, input.controller.signal),
            ]);
            const [stepSnapshots, approvalSnapshots] = await Promise.all([
              loadAgentRuntimeStepSnapshots(messages, [input.runId], input.controller.signal),
              loadAgentRuntimeApprovalSnapshots(messages, [input.runId], input.controller.signal),
            ]);
            if (input.controller.signal.aborted || activeAgentRun.current !== input.controller) return;
            const snapshotMessages = toAgentUiMessages(messages, stepSnapshots, approvalSnapshots);
            cacheRuntimeMessages(input.conversationId, snapshotMessages);
            cursor = thread.eventSeq;
            snapshotFloor = thread.eventSeq;
            terminal = isTerminalAgentRun(run);
            setConversations((current) => current.map((conversation) => conversation.id === input.conversationId
              ? {
                  ...conversation,
                  runtimeEventSeq: thread.eventSeq,
                  runtimeActiveRunId: terminal ? null : thread.activeRootRunId || run.id,
                  updatedAt: thread.updatedAt,
                }
              : conversation));
            continue;
          }
          if (isRetryableAgentStreamError(error) && streamReconnectAttempts < 5) {
            streamReconnectAttempts += 1;
            const reconnectDelay = Math.min(1_000, 150 * (2 ** (streamReconnectAttempts - 1)));
            await new Promise((resolve) => window.setTimeout(resolve, reconnectDelay));
            continue;
          }
          throw error;
        }
      }
      if (!terminal || input.controller.signal.aborted || activeAgentRun.current !== input.controller) return;
      const serverMessages = await listAllAgentMessages(input.threadId, input.controller.signal);
      const [stepSnapshots, approvalSnapshots] = await Promise.all([
        loadAgentRuntimeStepSnapshots(serverMessages, [input.runId], input.controller.signal),
        loadAgentRuntimeApprovalSnapshots(serverMessages, [input.runId], input.controller.signal),
      ]);
      if (input.controller.signal.aborted || activeAgentRun.current !== input.controller) return;
      const completedMessages = toAgentUiMessages(serverMessages, stepSnapshots, approvalSnapshots);
      cacheRuntimeMessages(input.conversationId, completedMessages);
      setConversations((current) => current.map((conversation) => conversation.id === input.conversationId
        ? { ...conversation, runtimeActiveRunId: null, runtimeEventSeq: cursor, prompt: input.brief }
        : conversation));
    } catch (error) {
      if (input.controller.signal.aborted || (error as { name?: string })?.name === "AbortError") return;
      if (handleAgentRuntimeFailure(error, "Agent 连接中断")) return;
      transportRecoveryPending = true;
      const currentMeta = activeAgentRunMeta.current;
      const recoveryState = markAgentRunTransportDisconnected({
        threadId: input.threadId,
        runId: input.runId,
        clientMessageId: currentMeta?.clientMessageId || null,
      });
      activeAgentRunMeta.current = {
        conversationId: input.conversationId,
        threadId: recoveryState.threadId,
        runId: recoveryState.runId,
        clientMessageId: recoveryState.clientMessageId,
        brief: input.brief,
        messageId: currentMeta?.messageId || input.runId,
      };
      const recoveringMessages = agentMessagesRef.current.map((message) => (
        message.role === "assistant"
          && message.status === "running"
          && (!message.runId || message.runId === input.runId)
          ? {
              ...message,
              runId: input.runId,
              runStateLabel: AGENT_RUN_RECOVERY_LABEL,
              stepsError: "事件连接已中断；服务器仍可能继续处理，只能恢复这一条原运行。",
            }
          : message
      ));
      cacheRuntimeMessages(input.conversationId, recoveringMessages);
      setConversations((current) => current.map((conversation) => conversation.id === input.conversationId
        ? {
            ...conversation,
            runtimeThreadId: input.threadId,
            runtimeActiveRunId: input.runId,
            runtimeEventSeq: cursor,
          }
        : conversation));
    } finally {
      if (activeAgentRun.current === input.controller) {
        activeAgentRun.current = null;
        if (!transportRecoveryPending) activeAgentRunMeta.current = null;
        setIsGenerating(false);
      }
    }
  }

  async function submitAgentTurn(rawBrief: string, options: SubmitAgentTurnOptions = {}) {
    const brief = rawBrief.trim();
    if (!brief) {
      showNotice("先输入想和 Agent 讨论的内容");
      return;
    }
    if (agentChatModelsLoading) {
      showNotice("Agent 对话模型目录仍在加载，请稍后再试");
      return;
    }
    if (!selectedAgentChatModel) {
      showNotice(agentChatModelsError ? `Agent 对话模型目录读取失败：${agentChatModelsError}` : "未配置可用的 Agent 对话模型");
      setActivePanel("models");
      return;
    }
    if (isGenerating || activeAgentRun.current || (activeAgentRunMeta.current && !activeAgentRunMeta.current.runId)) {
      showNotice("本轮仍在运行，请等待完成或先停止本轮；当前草稿已保留");
      return;
    }
    const unresolvedRunId = activeAgentRunMeta.current?.runId || activeConversation?.runtimeActiveRunId;
    if (unresolvedRunId) {
      showNotice(`上一轮状态尚未确认（${unresolvedRunId.slice(0, 8)}），请先恢复原运行`);
      return;
    }
    if (legacyAgentConversation) {
      showNotice("旧版本地对话仅供查看，请新建对话后继续");
      return;
    }
    if (!pendingSubmissionStorageKey) {
      showNotice("登录上下文尚未就绪，请重新进入 Agent 页面");
      return;
    }
    const agentMessageText = brief;
    let generationPreferences: AgentMessageGenerationPreferences | undefined;
    if (options.contextSnapshot === undefined) {
      if (
        activeAgentGenerationPreferenceAvailable
        && !modelOptionsLoading
        && activePreferenceTab === "图片"
        && selectedRatio
        && selectedImageCapability
        && imageConfigurationErrors.length === 0
      ) {
        generationPreferences = {
          generationType: "image",
          model: selectedImageCapability.id,
          ratio: selectedRatio,
          quality: imageQuality,
          count: imageCount,
        };
      } else if (
        activeAgentGenerationPreferenceAvailable
        && !modelOptionsLoading
        && selectedRatio
        && selectedVideoCapability
        && videoPreferenceConfigurationErrors.length === 0
      ) {
        generationPreferences = {
          generationType: "video",
          model: selectedVideoCapability.id,
          ratio: selectedRatio,
          resolution: videoSettings.resolution,
          mode: videoSettings.mode,
          duration: videoSettings.duration,
          generateAudio: videoSettings.audio,
          ...videoOutputFormatRequestField(selectedVideoCapability.outputFormatsDeclared, videoSettings.outputFormat),
        };
      }
    }
    const requestContextSnapshot = options.contextSnapshot ?? buildAgentContextSnapshotInput(
      pendingContextAssets,
      resolvedContextStyleName,
      generationPreferences,
    );
    const agentSessionParameters: Record<string, unknown> = {
      agentChatModel: selectedAgentChatModel,
    };
    if (agentCapabilities.imageGeneration && !modelOptionsLoading && selectedRatio && activePreferenceTab === "图片" && imageConfigurationErrors.length === 0) {
      Object.assign(agentSessionParameters, {
        outputType: "image",
        ratio: selectedRatio,
        imageModel,
        imageQuality,
      });
    }
    if (agentCapabilities.videoGeneration && !modelOptionsLoading && selectedRatio && activePreferenceTab === "视频" && videoPreferenceConfigurationErrors.length === 0) {
      Object.assign(agentSessionParameters, {
        outputType: "video",
        ratio: selectedRatio,
        videoModel: selectedVideoCapability?.id,
        resolution: videoSettings.resolution,
        ...videoOutputFormatRequestField(selectedVideoCapability?.outputFormatsDeclared === true, videoSettings.outputFormat),
        videoMode: videoSettings.mode,
        videoDuration: videoSettings.duration,
        videoAudio: videoSettings.audio,
      });
    }

    const existingThreadId = activeConversation?.runtimeThreadId && currentProjectId !== null
      && String(activeConversation.projectId) === String(currentProjectId)
      ? activeConversation.runtimeThreadId
      : null;
    if (options.retryOfRunId && !existingThreadId) {
      showNotice("安全重试必须在原 Agent Thread 中执行");
      return;
    }
    const pendingCandidate = options.clientMessageId
      ? null
      : readPendingAgentSubmission(pendingSubmissionStorageKey);
    const storedSubmission = pendingCandidate?.projectId === currentProjectId ? pendingCandidate : null;
    if (pendingCandidate && !storedSubmission) clearPendingAgentSubmission(pendingSubmissionStorageKey);
    if (storedSubmission && storedSubmission.brief.trim() !== brief) {
      showNotice("上一条消息的响应尚未确认，正在优先恢复");
      return;
    }
    let pendingSubmission: PendingAgentSubmission = options.clientMessageId ? {
      projectId: currentProjectId,
      brief,
      idempotencyKey: `web-agent-safe-retry:${options.retryOfRunId || options.clientMessageId}`,
      clientMessageId: options.clientMessageId,
      threadId: existingThreadId,
      createdAt: Date.now(),
    } : storedSubmission || {
      projectId: currentProjectId,
      brief,
      idempotencyKey: `web-agent-thread:${window.crypto.randomUUID()}`,
      clientMessageId: window.crypto.randomUUID(),
      threadId: existingThreadId,
      createdAt: Date.now(),
    };
    let submissionStorageKey = pendingSubmissionStorageKey;
    writePendingAgentSubmission(submissionStorageKey, pendingSubmission);
    const clientMessageId = pendingSubmission.clientMessageId;
    const assistantMessageId = `pending-${clientMessageId}`;
    let conversationId = pendingSubmission.threadId || `pending-${pendingSubmission.idempotencyKey}`;
    let threadId = pendingSubmission.threadId;
    let threadEventSeq = existingThreadId === threadId ? activeConversation?.runtimeEventSeq || 0 : 0;
    let baseMessages = existingThreadId === threadId ? agentMessagesRef.current : [];
    let ensuredProjectLocation: { projectId: number; sessionId: string; threadId: string } | null = null;
    setPrompt("");
    setActivePanel(null);
    setIsGenerating(true);
    const controller = new AbortController();
    activeAgentRun.current = controller;
    activeAgentRunMeta.current = {
      conversationId,
      threadId,
      runId: null,
      clientMessageId,
      brief,
      messageId: assistantMessageId,
    };

    try {
      if (threadId && existingThreadId !== threadId) {
        const [thread, serverMessages] = await Promise.all([
          getAgentThread(threadId, controller.signal),
          listAllAgentMessages(threadId, controller.signal),
        ]);
        const [stepSnapshots, approvalSnapshots] = await Promise.all([
          loadAgentRuntimeStepSnapshots(serverMessages, [], controller.signal),
          loadAgentRuntimeApprovalSnapshots(serverMessages, [], controller.signal),
        ]);
        if (controller.signal.aborted || activeAgentRun.current !== controller) return;
        conversationId = thread.id;
        threadEventSeq = thread.eventSeq;
        baseMessages = toAgentUiMessages(serverMessages, stepSnapshots, approvalSnapshots);
        const runtimeConversation = {
          ...runtimeConversationFromThread(thread, currentProject?.name || "未命名项目"),
          messages: baseMessages,
        };
        setConversations((current) => [
          runtimeConversation,
          ...current.filter((conversation) => conversation.id !== thread.id),
        ]);
        setActiveConversationId(thread.id);
        updateGenerateLocation("Agent 模式", thread.id);
        agentMessagesRef.current = baseMessages;
        setAgentMessages(baseMessages);
      }
      if (!threadId) {
        const ensured = await ensureAgentThread({
          projectId: currentProjectId,
          projectName: brief.slice(0, 60),
          title: brief.slice(0, 60),
          goal: brief,
          parameters: agentSessionParameters,
          idempotencyKey: pendingSubmission.idempotencyKey,
          signal: controller.signal,
        });
        const thread = ensured.thread;
        const nextStorageKey = pendingAgentSubmissionKey(agentStorageScope, ensured.project.id);
        if (!nextStorageKey) throw new Error("登录上下文已失效，无法保存 Agent 提交状态");
        pendingSubmission = { ...pendingSubmission, projectId: ensured.project.id, threadId: thread.id };
        if (submissionStorageKey !== nextStorageKey) clearPendingAgentSubmission(submissionStorageKey);
        submissionStorageKey = nextStorageKey;
        writePendingAgentSubmission(submissionStorageKey, pendingSubmission);
        if (controller.signal.aborted || activeAgentRun.current !== controller) return;
        // Selecting the new project can remount the studio and abort this
        // controller. Persist the first message before changing route scope.
        ensuredProjectLocation = {
          projectId: ensured.project.id,
          sessionId: ensured.session.id,
          threadId: thread.id,
        };
        threadId = thread.id;
        conversationId = thread.id;
        threadEventSeq = thread.eventSeq;
        baseMessages = [];
        const runtimeConversation = runtimeConversationFromThread(thread, ensured.project.name || "未命名项目");
        setConversations((current) => [
          runtimeConversation,
          ...current.filter((conversation) => conversation.id !== thread.id),
        ]);
        setActiveConversationId(thread.id);
      }
      activeAgentRunMeta.current = {
        conversationId,
        threadId,
        runId: null,
        clientMessageId,
        brief,
        messageId: assistantMessageId,
      };
      const createdAt = Date.now();
      const userMessage: AgentMessage = {
        id: clientMessageId,
        role: "user",
        clientMessageId,
        content: brief,
        contextSnapshot: null,
        createdAt,
        serverVerified: false,
      };
      const pendingMessage: AgentMessage = {
        id: assistantMessageId,
        role: "assistant",
        runId: null,
        content: "",
        createdAt: createdAt + 1,
        status: "running",
      };
      const messagesWithoutThisAttempt = baseMessages.filter((message) => (
        message.id !== clientMessageId && message.id !== assistantMessageId
      ));
      cacheRuntimeMessages(conversationId, [...messagesWithoutThisAttempt, userMessage, pendingMessage]);

      // 附件接线(REVAMP-PLAN 4.4):本地文件先经资产上传通道换 assetRef,
      // 超上限/上传失败的附件跳过并提示,不阻塞消息本身。
      const resolvedAttachments = options.attachments !== undefined
        ? {
            attachments: options.attachments,
            skipped: [] as string[],
            submittedLocalIds: [] as string[],
          }
        : await resolveAgentMessageAttachments(attachments, {
            projectId: pendingSubmission.projectId,
            persistedReferences: [
              ...quickSessionContext.references
                .filter(isAgentSessionReferenceAllowed)
                .map((reference) => ({
                  id: String(reference.id),
                  assetVersionId: String(reference.assetVersionId),
                  name: reference.name,
                  kind: reference.kind,
                  previewUrl: reference.thumbnailUrl,
                })),
              ...selectedSubjectReferences.map((reference) => ({
                id: reference.id,
                assetVersionId: String(reference.assetVersionId),
                name: reference.name,
                kind: reference.kind,
                previewUrl: reference.previewUrl,
              })),
            ],
            signal: controller.signal,
          });
      if (controller.signal.aborted || activeAgentRun.current !== controller) return;
      if (resolvedAttachments.skipped.length) {
        showNotice(`以下附件未能随消息发送：${resolvedAttachments.skipped.join("、")}`);
      }
      const submission = await sendAgentTextMessage({
        threadId,
        clientMessageId,
        retryOfRunId: options.retryOfRunId,
        text: agentMessageText,
        model: selectedAgentChatModel,
        attachments: resolvedAttachments.attachments,
        skillRefs: options.skillRefs
          ?? agentTurnSkills.map((skill) => ({ key: skill.key, version: skill.version })),
        contextSnapshot: requestContextSnapshot,
        signal: controller.signal,
      });
      clearPendingAgentSubmission(submissionStorageKey, clientMessageId);
      // Replace the optimistic local user row immediately with the server DTO.
      // This is the only point at which context becomes "已确认"; waiting for
      // the terminal history refresh made a running turn look unverified and
      // lost the snapshot after a page refresh/reconnect.
      const confirmedUserMessage = toAgentUiMessage(submission.message);
      if (confirmedUserMessage?.role === "user") {
        cacheRuntimeMessages(conversationId, confirmAgentMessage(
          agentMessagesRef.current, confirmedUserMessage, clientMessageId,
          assistantMessageId, submission.run.id,
        ));
      }
      // Only accepted local files leave the Composer. Skipped/failed files stay
      // visible so the user can retry without selecting them again.
      setAttachments((current) => {
        const submitted = new Set(resolvedAttachments.submittedLocalIds);
        current.forEach((attachment) => {
          if (submitted.has(attachment.id)) window.URL.revokeObjectURL(attachment.previewUrl);
        });
        return retainUnsubmittedAttachments(current, resolvedAttachments.submittedLocalIds);
      });
      if (controller.signal.aborted || activeAgentRun.current !== controller) return;
      if (ensuredProjectLocation) {
        await fetchProjects();
        if (controller.signal.aborted || activeAgentRun.current !== controller) return;
        activeConversationIdRef.current = threadId;
        conversationProjectScopeRef.current = ensuredProjectLocation.projectId;
        navigate(buildProjectModeHref("agent", ensuredProjectLocation, location.search), { replace: true });
      }
      if (isTerminalAgentRun(submission.run)) {
        const [thread, serverMessages] = await Promise.all([
          getAgentThread(threadId, controller.signal),
          listAllAgentMessages(threadId, controller.signal),
        ]);
        const [stepSnapshots, approvalSnapshots] = await Promise.all([
          loadAgentRuntimeStepSnapshots(serverMessages, [submission.run.id], controller.signal),
          loadAgentRuntimeApprovalSnapshots(serverMessages, [submission.run.id], controller.signal),
        ]);
        if (controller.signal.aborted || activeAgentRun.current !== controller) return;
        const terminalMessages = toAgentUiMessages(serverMessages, stepSnapshots, approvalSnapshots);
        cacheRuntimeMessages(conversationId, terminalMessages);
        setConversations((current) => current.map((conversation) => conversation.id === conversationId
          ? {
              ...runtimeConversationFromThread(thread, conversation.projectName, conversation),
              messages: terminalMessages,
              runtimeActiveRunId: null,
              prompt: brief,
            }
          : conversation));
        return;
      }
      activeAgentRunMeta.current = {
        conversationId,
        threadId,
        runId: submission.run.id,
        clientMessageId,
        brief,
        messageId: assistantMessageId,
      };
      setConversations((current) => current.map((conversation) => conversation.id === conversationId
        ? { ...conversation, runtimeActiveRunId: submission.run.id, prompt: brief, updatedAt: Date.now() }
        : conversation));
      const verifiedUserMessage = toAgentUiMessage(submission.message);
      const submittedMessages = agentMessagesRef.current.map((message) => {
        if (message.id === clientMessageId) {
          return verifiedUserMessage || {
            ...message,
            serverVerified: true,
          };
        }
        if (message.id !== assistantMessageId) return message;
        return {
          ...message,
          runId: submission.run.id,
          steps: undefined,
          stepsError: undefined,
        };
      });
      cacheRuntimeMessages(conversationId, submittedMessages);
      void refreshRuntimeRunSteps(conversationId, submission.run.id, controller.signal);
      void refreshRuntimeRunApprovals(conversationId, submission.run.id, controller.signal);
      await watchAgentRun({
        controller,
        conversationId,
        threadId,
        runId: submission.run.id,
        brief,
        after: threadEventSeq,
      });
    } catch (error) {
      if (controller.signal.aborted || (error as { name?: string })?.name === "AbortError") return;
      const definitiveFailure = error instanceof ApiError && isDefinitiveAgentClientError(error);
      if (definitiveFailure) {
        clearPendingAgentSubmission(submissionStorageKey, clientMessageId);
      }
      if (handleAgentRuntimeFailure(error, "Agent 消息发送失败")) return;
      if (ensuredProjectLocation && !definitiveFailure) {
        // The project/thread already exists and the pending message is stored
        // under its project ID. Enter that scope even when the POST response
        // is lost, so recovery can find it and query the original Run by GET.
        // Staying on the unscoped page would strand the persisted submission.
        try {
          await fetchProjects();
          if (controller.signal.aborted || activeAgentRun.current !== controller) return;
          activeConversationIdRef.current = threadId;
          conversationProjectScopeRef.current = ensuredProjectLocation.projectId;
          navigate(buildProjectModeHref("agent", ensuredProjectLocation, location.search), { replace: true });
        } catch (recoveryError) {
          handleAgentRuntimeFailure(recoveryError, "原消息结果待确认，请重新进入项目恢复");
        }
        return;
      }
      if (options.retryOfRunId && error instanceof ApiError && isDefinitiveAgentClientError(error)) {
        cacheRuntimeMessages(conversationId, baseMessages);
        return;
      }
      const message = formatAgentRuntimeFailure(error, "Agent 消息发送失败");
      const failedMessages = agentMessagesRef.current.map((item) => item.id === assistantMessageId
        ? {
            ...item,
            content: `这轮没有完成：${message}`,
            status: "failed" as const,
            steps: undefined,
          }
        : item);
      if (threadId) cacheRuntimeMessages(conversationId, failedMessages);
      else setPrompt(brief);
    } finally {
      if (activeAgentRun.current === controller) {
        activeAgentRun.current = null;
        activeAgentRunMeta.current = null;
        setIsGenerating(false);
      }
    }
  }

  async function stopAgentRun() {
    const controller = activeAgentRun.current;
    const runMeta = activeAgentRunMeta.current;
    if (!controller || !runMeta) return;
    if (!runMeta.runId) {
      showNotice("消息正在提交，Run 创建后即可停止");
      return;
    }
    try {
      await cancelAgentRun(runMeta.runId);
    } catch (error) {
      if (handleAgentRuntimeFailure(error, "停止 Agent 失败")) return;
    }
  }

  function recoverOriginalAgentRun() {
    if (isGenerating) return;
    const runId = activeAgentRunMeta.current?.runId || activeConversation?.runtimeActiveRunId;
    if (!runId || !activeConversation?.runtimeThreadId) {
      showNotice("没有需要恢复的 Agent Run");
      return;
    }
    void openConversation({
      ...activeConversation,
      runtimeActiveRunId: runId,
    });
  }

  async function retryAgentMessage(messageId: string) {
    const setRetryState = (state: AgentRetryUiState) => {
      setAgentRetryStates((current) => ({ ...current, [messageId]: state }));
    };
    if (isGenerating) {
      setRetryState({ phase: "error", message: "请等待当前回复完成后再重新尝试。" });
      return;
    }
    if (safeRetrySourceRunRef.current) {
      setRetryState({ phase: "error", message: "另一条失败消息正在检查，请稍候。" });
      return;
    }
    const messages = agentMessagesRef.current;
    const assistantIndex = messages.findIndex((message) => message.id === messageId);
    if (assistantIndex < 0) {
      setRetryState({ phase: "error", message: "没有找到这条失败消息，请刷新后再试。" });
      return;
    }
    const assistantMessage = messages[assistantIndex];
    const sourceRunId = assistantMessage.runId;
    if (!sourceRunId || !activeConversation?.runtimeThreadId) {
      setRetryState({ phase: "blocked", message: "缺少原任务记录，无法直接重新尝试。请将原问题放回输入框后重新发送。" });
      return;
    }
    let userIndex = assistantIndex - 1;
    while (userIndex >= 0 && messages[userIndex].role !== "user") userIndex -= 1;
    const userMessage = messages[userIndex];
    if (!userMessage) {
      setRetryState({ phase: "blocked", message: "没有找到对应的用户消息，无法重新尝试。" });
      return;
    }
    setRetryState({ phase: "checking", message: "正在检查原任务状态…" });
    safeRetrySourceRunRef.current = sourceRunId;
    try {
      const sourceRun = await getAgentRun(sourceRunId);
      if (
        sourceRun.id !== sourceRunId
        || sourceRun.threadId !== activeConversation.runtimeThreadId
      ) {
        setRetryState({ phase: "blocked", message: "原任务不属于当前对话，已阻止重新执行。" });
        return;
      }
      if (!isAgentRunSafeRetryable(sourceRun)) {
        const steps = await listAllAgentRunSteps(sourceRunId);
        if (isAgentRunConfirmableRetry(sourceRun, steps)) {
          const retryMessage = sourceRun.error?.code === "model_outcome_uncertain"
            ? "这次模型回复没有成功保存，且没有执行任何工具操作。再次生成会重新请求模型，可能产生费用。"
            : "原任务已请求模型，但工具没有执行成功。再次生成会重新请求模型，可能产生费用。";
          setRetryState({
            phase: "confirm",
            message: retryMessage,
          });
          return;
        }
        const message = sourceRun.sideEffectsCommitted
          ? "原任务可能已经执行过外部操作，不能直接重放。你可以修改原问题后重新发送。"
          : "原任务还没有明确失败或取消，请先恢复原任务。";
        setRetryState({ phase: "blocked", message });
        showNotice(message);
        return;
      }
      setRetryState({ phase: "retrying", message: "检查通过，正在重新生成回复…" });
      const retryContext = agentSafeRetryContextFromSnapshot(userMessage.contextSnapshot);
      await submitAgentTurn(userMessage.content, {
        retryOfRunId: sourceRunId,
        clientMessageId: agentSafeRetryClientMessageId(sourceRunId),
        ...retryContext,
      });
      setRetryState({ phase: "submitted", message: "已提交重新尝试，请查看下方新一轮结果。" });
    } catch (error) {
      if ((error as { name?: string })?.name === "AbortError") return;
      setRetryState({ phase: "error", message: "检查失败，请稍后再试。" });
      handleAgentRuntimeFailure(error, "安全重试校验失败");
    } finally {
      if (safeRetrySourceRunRef.current === sourceRunId) {
        safeRetrySourceRunRef.current = null;
      }
    }
  }

  async function confirmAgentMessageRetry(messageId: string) {
    if (agentRetryStates[messageId]?.phase !== "confirm") return;
    if (isGenerating || safeRetrySourceRunRef.current) {
      setAgentRetryStates((current) => ({
        ...current,
        [messageId]: { phase: "error", message: "请等待当前任务完成后再重新尝试。" },
      }));
      return;
    }
    const messages = agentMessagesRef.current;
    const assistantIndex = messages.findIndex((message) => message.id === messageId);
    const sourceRunId = messages[assistantIndex]?.runId;
    const conversationId = activeConversationIdRef.current;
    const runtimeThreadId = activeConversation?.runtimeThreadId;
    let userIndex = assistantIndex - 1;
    while (userIndex >= 0 && messages[userIndex].role !== "user") userIndex -= 1;
    const userMessage = messages[userIndex];
    if (assistantIndex < 0 || !userMessage || !sourceRunId || !runtimeThreadId) {
      setAgentRetryStates((current) => ({
        ...current,
        [messageId]: { phase: "error", message: "没有找到原问题，请刷新后再试。" },
      }));
      return;
    }
    setAgentRetryStates((current) => ({
      ...current,
      [messageId]: { phase: "retrying", message: "正在重新请求模型并生成回复…" },
    }));
    safeRetrySourceRunRef.current = sourceRunId;
    try {
      const [sourceRun, steps] = await Promise.all([
        getAgentRun(sourceRunId),
        listAllAgentRunSteps(sourceRunId),
      ]);
      if (activeConversationIdRef.current !== conversationId) return;
      if (sourceRun.id !== sourceRunId || sourceRun.threadId !== runtimeThreadId
        || !isAgentRunConfirmableRetry(sourceRun, steps)) {
        setAgentRetryStates((current) => ({
          ...current,
          [messageId]: { phase: "blocked", message: "原任务状态已变化或包含工具操作，请先查看原结果。" },
        }));
        return;
      }
      const retryContext = agentSafeRetryContextFromSnapshot(userMessage.contextSnapshot);
      await submitAgentTurn(userMessage.content, {
        ...retryContext,
        clientMessageId: agentConfirmedRetryClientMessageId(sourceRunId),
      });
      setAgentRetryStates((current) => ({
        ...current,
        [messageId]: { phase: "submitted", message: "已提交再次生成，请查看下方新一轮结果。" },
      }));
    } catch (error) {
      setAgentRetryStates((current) => ({
        ...current,
        [messageId]: { phase: "error", message: "重新尝试失败，请稍后重试。" },
      }));
      handleAgentRuntimeFailure(error, "再次生成失败");
    } finally {
      if (safeRetrySourceRunRef.current === sourceRunId) safeRetrySourceRunRef.current = null;
    }
  }

  function restoreAgentMessageDraft(messageId: string) {
    const messages = agentMessagesRef.current;
    const assistantIndex = messages.findIndex((message) => message.id === messageId);
    let userIndex = assistantIndex - 1;
    while (userIndex >= 0 && messages[userIndex].role !== "user") userIndex -= 1;
    const userMessage = messages[userIndex];
    if (!userMessage) return;
    setPrompt(userMessage.content);
    setAgentRetryStates((current) => {
      const next = { ...current };
      delete next[messageId];
      return next;
    });
    showNotice("原问题已放回输入框，可以修改后重新发送");
  }

  function renderAgentRetryControls(message: AgentMessage) {
    if (legacyAgentConversation || (message.status !== "failed" && message.status !== "cancelled")) return null;
    const retryState = agentRetryStates[message.id];
    if (retryState?.phase === "confirm") {
      return (
        <div className="generateAgentRetryPanel warning" role="status">
          <p>{retryState.message}</p>
          <div>
            <button type="button" onClick={() => void confirmAgentMessageRetry(message.id)}>
              <RotateCcw size={15} />确认再次生成
            </button>
            <button type="button" onClick={() => setAgentRetryStates((current) => {
              const next = { ...current };
              delete next[message.id];
              return next;
            })}>取消</button>
          </div>
        </div>
      );
    }
    if (retryState?.phase === "blocked") {
      return (
        <div className="generateAgentRetryPanel blocked" role="alert">
          <p>{retryState.message}</p>
          <button type="button" onClick={() => restoreAgentMessageDraft(message.id)}>修改原问题</button>
        </div>
      );
    }
    if (retryState?.phase === "submitted") {
      return <p className="generateAgentRetryStatus" role="status"><Check size={15} />{retryState.message}</p>;
    }
    const busy = retryState?.phase === "checking" || retryState?.phase === "retrying";
    return (
      <div className="generateAgentRetryActions">
        <button
          className="generateAgentRetry"
          type="button"
          disabled={busy}
          onClick={() => void retryAgentMessage(message.id)}
        >
          {busy ? <Loader2 className="jimengSpin" size={15} /> : <RotateCcw size={15} />}
          {retryState?.phase === "checking"
            ? "正在检查…"
            : retryState?.phase === "retrying"
              ? "正在重新生成…"
              : "重新尝试"}
        </button>
        {retryState?.message ? <p className="generateAgentRetryHint" role="status">{retryState.message}</p> : null}
      </div>
    );
  }

  async function submitPrompt() {
    if (referenceUploadPending) {
      showNotice("参考素材仍在上传，请等待服务端检查开始后再发送");
      return;
    }
    if (portraitAdmissionBlocking) {
      showNotice("请先完成参考素材的人物来源确认与服务端检查");
      return;
    }
    if (!isGenerationModeAvailableOnSurface(activeMode, embedded)) {
      showNotice(embedded ? "当前工作态仅支持 Agent 模式" : `${activeMode}暂未开放`);
      return;
    }
    if (
      (activeMode === "Agent 模式" && agentChatModelsLoading)
      || (activeMode !== "Agent 模式" && modelOptionsLoading)
    ) {
      showNotice("正在确认当前模式的真实执行能力，请稍后再试");
      return;
    }
    if (!activeRuntimeModeAvailable) {
      showNotice(
        activeMode === "Agent 模式"
          ? agentChatModelsError || "Agent 真实执行链路尚未就绪"
          : modelOptionsError || `${activeMode}没有完整的真实可提交模型`,
      );
      return;
    }
    const brief = prompt.trim();
    if (!brief) {
      showNotice("先输入创作想法");
      return;
    }
    if (activeMode === "Agent 模式") {
      if (agentChatModelsLoading) {
        showNotice("Agent 对话模型目录仍在加载，请稍后再试");
        return;
      }
      if (!agentSurfaceAvailable) {
        showNotice(agentChatModelsError || "Agent 真实执行链路尚未就绪");
        return;
      }
      if (!selectedAgentChatModel) {
        showNotice(agentChatModelsError ? `Agent 对话模型目录读取失败：${agentChatModelsError}` : "未配置可用的 Agent 对话模型");
        setActivePanel("models");
        return;
      }
      await submitAgentTurn(brief);
      return;
    }
    if (modelOptionsLoading) {
      showNotice("模型目录仍在加载，请稍后再试");
      return;
    }
    if (activeMode === "图片生成" && imageConfigurationErrors.length) {
      showNotice(imageConfigurationErrors[0]);
      setActivePanel("auto");
      return;
    }
    if (activeMode === "视频生成" && videoPromptConfigurationErrors.length) {
      showNotice(videoPromptConfigurationErrors[0]);
      setActivePanel("auto");
      return;
    }
    if (activeMode === "视频生成" && !selectedLlmOption) {
      showNotice(modelOptionsError ? `模型目录读取失败：${modelOptionsError}` : "未配置可用的对话模型");
      setActivePanel("models");
      return;
    }
    const submissionRatio = selectedRatio;
    if (!submissionRatio) {
      showNotice("服务端未提供可用画面比例，已阻止提交");
      setActivePanel("auto");
      return;
    }
    const conversationId = activeConversationId || window.crypto.randomUUID();
    rememberConversation(brief.slice(0, 22), brief, conversationId);
    setIsGenerating(true);
    setActivePanel(null);
    resetGeneratedState();
    let activeUtilityAttempt: {
      kind: "image" | "director";
      storageKey: string;
      attempt: StableSubmissionAttempt;
    } | null = null;
    try {
      if (activeMode === "图片生成") {
        if (!selectedImageCapability) {
          throw new Error("所选图片模型已从真实目录移除");
        }
        if (!currentProjectId || !Number.isSafeInteger(currentProjectId)) {
          throw new Error("请先选择一个项目，生成图片将保存为项目资产并支持刷新恢复");
        }
        const imageAttachments = attachments.filter((attachment) => attachment.kind === "image");
        if (imageAttachments.length > MAX_QUICK_CREATE_IMAGE_REFERENCES) {
          throw new Error(
            `图片参考超过引用上限：当前 ${imageAttachments.length} 个，最多 ${MAX_QUICK_CREATE_IMAGE_REFERENCES} 个`,
          );
        }
        const localImageAttachments = imageAttachments.filter(
          (attachment) => attachment.file && !attachment.assetVersionId,
        );
        const uploadedPairs: Array<{
          attachment: GenerateAttachment;
          uploaded: UploadedReferenceAsset;
        }> = [];
        for (const attachment of localImageAttachments) {
          const uploaded = await uploadReferenceAttachment(currentProjectId!, attachment.file!);
          uploadedPairs.push({ attachment, uploaded });
        }

        type PersistedUpload = NonNullable<QuickCreateSessionParameters["uploadedAttachments"]>[number];
        const existingUploads = Array.isArray(creationSession?.parameters.uploadedAttachments)
          ? creationSession.parameters.uploadedAttachments.filter(isRecord) as PersistedUpload[]
          : [];
        const persistedUploadsByVersion = new Map<string, PersistedUpload>();
        existingUploads.forEach((attachment) => {
          const version = String(attachment.assetVersionId || "").trim();
          if (version) persistedUploadsByVersion.set(version, attachment);
        });
        uploadedPairs.forEach(({ attachment, uploaded }) => {
          persistedUploadsByVersion.set(String(uploaded.assetVersionId), {
            clientId: attachment.id,
            name: uploaded.name || attachment.name,
            size: uploaded.size || attachment.size,
            mimeType: uploaded.mimeType || attachment.type,
            assetId: uploaded.assetId,
            assetVersionId: uploaded.assetVersionId,
            filePath: uploaded.filePath,
            previewUrl: uploaded.previewUrl,
            type: uploaded.type,
          });
        });
        const persistedUploads = Array.from(persistedUploadsByVersion.values());
        if (uploadedPairs.length) {
          const sessionState = useSessionStore.getState();
          if (
            sessionState.boundProjectId !== currentProjectId
            || !sessionState.session
          ) {
            await sessionState.ensureSession(currentProjectId!, "quick_create");
          }
          const selectedAssetVersionIds = Array.from(new Set([
            ...(useSessionStore.getState().session?.selectedAssetVersionIds || []),
            ...persistedUploads.map((attachment) => String(attachment.assetVersionId)),
          ]));
          await useSessionStore.getState().saveSession({
            goal: brief,
            parameters: { uploadedAttachments: persistedUploads },
            selectedAssetVersionIds,
          });
          const uploadsByAttachmentId = new Map(
            uploadedPairs.map(({ attachment, uploaded }) => [attachment.id, uploaded]),
          );
          setAttachments((current) => current.map((attachment) => {
            const uploaded = uploadsByAttachmentId.get(attachment.id);
            if (!uploaded) return attachment;
            window.URL.revokeObjectURL(attachment.previewUrl);
            return {
              ...attachment,
              name: uploaded.name || attachment.name,
              size: uploaded.size || attachment.size,
              type: uploaded.mimeType || attachment.type,
              previewUrl: uploaded.previewUrl,
              kind: uploaded.type === "image" ? "image" : attachment.kind,
              assetId: uploaded.assetId,
              assetVersionId: String(uploaded.assetVersionId),
              filePath: uploaded.filePath,
              file: undefined,
            };
          }));
        }

        const generationReferences = new Map<string, { assetVersionId: string; role: "subject" }>();
        quickSessionContext.references.forEach((reference) => {
          const version = String(reference.assetVersionId || "").trim();
          if (version && String(reference.kind || "").includes("图片")) {
            generationReferences.set(version, { assetVersionId: version, role: "subject" });
          }
        });
        imageAttachments.forEach((attachment) => {
          const version = String(attachment.assetVersionId || "").trim();
          if (version) generationReferences.set(version, { assetVersionId: version, role: "subject" });
        });
        uploadedPairs.forEach(({ uploaded }) => {
          const version = String(uploaded.assetVersionId);
          generationReferences.set(version, { assetVersionId: version, role: "subject" });
        });
        const references = Array.from(generationReferences.values());
        if (references.length > MAX_QUICK_CREATE_IMAGE_REFERENCES) {
          throw new Error(
            `图片参考超过引用上限：当前 ${references.length} 个，最多 ${MAX_QUICK_CREATE_IMAGE_REFERENCES} 个`,
          );
        }

        const nextJob: ImageGenerationJob = {
          id: window.crypto.randomUUID(),
          prompt: brief,
          model: selectedImageCapability?.label || imageModel,
          ratio: submissionRatio,
          quality: imageQuality,
          count: imageCount,
          status: "running",
          statusText: "智能创意中...",
        };
        setImageJob(nextJob);
        const imagePayload = {
          projectId: currentProjectId,
          ...(references.length ? { references } : {}),
          prompt: buildImagePrompt(brief),
          model: resolveQuickCreateImageModel(selectedImageCapability.id),
          ratio: submissionRatio,
          quality: imageQuality,
          count: imageCount,
          style: "高级、清晰、商业化、真实光影",
        };
        const preparedAttempt = prepareStoredSubmissionAttempt({
          current: imageSubmissionAttemptRef.current,
          flow: "generate-image",
          operationKey: String(currentProjectId),
          prefix: "generate-image",
          payload: imagePayload,
        });
        const imageAttempt = preparedAttempt.attempt;
        activeUtilityAttempt = { kind: "image", ...preparedAttempt };
        imageSubmissionAttemptRef.current = imageAttempt;
        const result = await confirmPricingRetry(
          () => generateQuickCreateImages(imagePayload, imageAttempt.idempotencyKey),
          () => generateQuickCreateImages(imagePayload, imageAttempt.idempotencyKey, { confirmPricing: true }),
        );
        clearStoredSubmissionAttempt(preparedAttempt.storageKey);
        imageSubmissionAttemptRef.current = null;
        const generatedAssets = result.assets || [];
        setImageAssets(generatedAssets);
        const recoveryWarning = await persistUtilityGenerationState(currentProjectId, {
            generatedImageAssets: generatedAssets,
            directorPlan: null,
            materializedProject: null,
          })
          .then(() => "")
          .catch((error) => error instanceof Error ? error.message : "创作记录保存失败");
        setImageJob((current) =>
          current?.id === nextJob.id
            ? {
                ...current,
                count: result.count || current.count,
                status: "succeeded",
                statusText: "已完成",
              }
            : current,
        );
        rememberConversation(brief.slice(0, 22), brief, conversationId);
        showNotice(
          recoveryWarning
            ? `已生成 ${result.count} 张图片，但刷新恢复记录保存失败：${recoveryWarning}`
            : `已生成 ${result.count} 张图片并保存到项目资产`,
        );
        return;
      }

      if (!currentProjectId || !Number.isSafeInteger(currentProjectId)) {
        throw new Error("请先选择一个项目，视频方案和后续任务需要项目上下文才能恢复");
      }
      if (!selectedLlmOption) {
        throw new Error("所选对话模型已从真实目录移除");
      }
      const directorPayload = {
        brief: buildPlanBrief(brief),
        style: "高级、清晰、商业化、真实光影",
        targetType,
        ratio: submissionRatio,
        llmModel: selectedLlmOption.id,
        duration: (videoSettings.duration === -1 ? (selectedVideoCapability?.duration.max ?? 15) : videoSettings.duration) * directorShotCountValue,
        shotCount: directorShotCountValue,
      };
      const preparedAttempt = prepareStoredSubmissionAttempt({
        current: directorSubmissionAttemptRef.current,
        flow: "generate-director",
        operationKey: String(currentProjectId),
        prefix: "generate-director",
        payload: directorPayload,
      });
      const directorAttempt = preparedAttempt.attempt;
      activeUtilityAttempt = { kind: "director", ...preparedAttempt };
      directorSubmissionAttemptRef.current = directorAttempt;
      const nextPlan = await generateDirectorPlan(
        directorPayload,
        undefined,
        directorAttempt.idempotencyKey,
      );
      clearStoredSubmissionAttempt(preparedAttempt.storageKey);
      directorSubmissionAttemptRef.current = null;
      setPlan(nextPlan);
      const recoveryWarning = await persistUtilityGenerationState(currentProjectId, {
          directorPlan: nextPlan,
          materializedProject: null,
          generatedImageAssets: [],
        })
        .then(() => "")
        .catch((error) => error instanceof Error ? error.message : "创作记录保存失败");
      rememberConversation(nextPlan.title || brief.slice(0, 22), brief, conversationId);
      showNotice(
        recoveryWarning
          ? `方案已生成，但刷新恢复记录保存失败：${recoveryWarning}`
          : "方案已生成并保存到项目创作记录",
      );
    } catch (error) {
      if (activeUtilityAttempt && !shouldRetainStoredSubmissionAttempt(error)) {
        clearStoredSubmissionAttempt(activeUtilityAttempt.storageKey);
        const targetRef = activeUtilityAttempt.kind === "image"
          ? imageSubmissionAttemptRef
          : directorSubmissionAttemptRef;
        if (
          targetRef.current?.idempotencyKey
          === activeUtilityAttempt.attempt.idempotencyKey
        ) {
          targetRef.current = null;
        }
      }
      const message = error instanceof Error ? error.message : "生成失败";
      if (activeMode === "图片生成") {
        setImageJob((current) => current ? { ...current, status: "failed", statusText: message, error: message } : current);
      }
      showNotice(message);
    } finally {
      setIsGenerating(false);
    }
  }

  async function ensureMaterialized(planOverride?: QuickCreateDirectorPlan): Promise<QuickCreateMaterializedProject> {
    const targetPlan = planOverride || plan;
    if (materialized && targetPlan === plan) return materialized;
    if (!targetPlan) throw new Error("请先生成方案");
    if (!selectedVideoCapability) throw new Error("所选视频模型已从真实目录移除");
    const materializePayload = {
      brief: buildPlanBrief(prompt.trim() || targetPlan.simpleScript || targetPlan.title),
      targetType,
      plan: targetPlan,
      imageModel: selectedImageCapability
        ? resolveQuickCreateImageModel(selectedImageCapability.id) || undefined
        : undefined,
      videoModel: selectedVideoCapability.id,
      imageQuality,
      generationMode: activeMode === "视频生成" ? ("video" as const) : ("closed_loop" as const),
    };
    const preparedAttempt = prepareStoredSubmissionAttempt({
      current: materializeSubmissionAttemptRef.current,
      flow: "generate-materialize",
      operationKey: String(currentProjectId ?? "new"),
      prefix: "generate-materialize",
      payload: materializePayload,
    });
    const materializeAttempt = preparedAttempt.attempt;
    materializeSubmissionAttemptRef.current = materializeAttempt;
    let created: QuickCreateMaterializedProject;
    try {
      created = await materializeDirectorPlan(
        materializePayload,
        materializeAttempt.idempotencyKey,
      );
      clearStoredSubmissionAttempt(preparedAttempt.storageKey);
      materializeSubmissionAttemptRef.current = null;
    } catch (error) {
      if (!shouldRetainStoredSubmissionAttempt(error)) {
        clearStoredSubmissionAttempt(preparedAttempt.storageKey);
        materializeSubmissionAttemptRef.current = null;
      }
      throw error;
    }
    materializedProjectIdRef.current = created.project.id;
    setMaterialized(created);
    return created;
  }

  async function submitVideoTasks(planOverride?: QuickCreateDirectorPlan) {
    const targetPlan = planOverride || plan;
    if (!targetPlan) {
      showNotice("请先生成方案");
      return;
    }
    // plan.present 映射方案的 shots[].prompt 为空(是制作步骤而非分镜画面
    // 提示词),直接提交会把步骤文本当画面 prompt 产出语义错位的计费任务。
    if (targetPlan.shots.length > 0 && targetPlan.shots.every((shot) => !shot.prompt?.trim())) {
      showNotice("方案步骤还不是分镜画面提示词,请先让 Agent 细化分镜再生成视频");
      return;
    }
    if (videoConfigurationErrors.length) {
      showNotice(videoConfigurationErrors[0]);
      if (activeMode !== "Agent 模式") setActivePanel("auto");
      return;
    }
    setIsSubmittingVideo(true);
    let activeVideoAttempt: {
      storageKey: string;
      attempt: StableSubmissionAttempt;
    } | null = null;
    try {
      const project = await ensureMaterialized(targetPlan);
      if (currentProjectId !== project.project.id) {
        carryingUtilityDraftProjectIdRef.current = project.project.id;
        await refreshAndSelectProject(project.project.id);
      }
      const uploadedAttachments = await ensureAttachmentsUploadedForProject(
        project.project.id,
        attachmentsRef.current,
        {
          directorPlan: targetPlan,
          materializedProject: project,
          generatedImageAssets: [],
        },
      );
      carryingUtilityDraftProjectIdRef.current = null;
      if (!selectedVideoCapability) throw new Error("所选视频模型已从真实目录移除");
      const resolvedReferences = resolveVideoGenerationReferences(
        selectedVideoCapability,
        videoSettings.mode,
        uploadedAttachments
          .filter((attachment) => (
            attachment.kind !== "file" || attachment.type.startsWith("audio/")
          ))
          .map((attachment) => ({
            id: attachment.id,
            kind: attachment.kind,
            assetVersionId: attachment.assetVersionId,
          })),
      );
      if (!resolvedReferences.ok) throw new Error(resolvedReferences.message);
      const submissionPayload = {
        projectId: project.project.id,
        scriptId: project.script.id,
        model: selectedVideoCapability.id,
        resolution: videoSettings.resolution,
        ...videoOutputFormatRequestField(selectedVideoCapability.outputFormatsDeclared, videoSettings.outputFormat),
        audio: videoSettings.audio,
        trackData: project.shots
          .filter((shot) => shot.trackId)
          .map((shot) => ({
            trackId: Number(shot.trackId),
            prompt: shot.prompt,
            duration: videoSettings.duration,
            mode: videoSettings.mode,
            references: resolvedReferences.references,
          })),
      };
      const preparedAttempt = prepareStoredSubmissionAttempt({
        current: videoSubmissionAttemptRef.current,
        flow: "generate-video",
        operationKey: String(project.project.id),
        prefix: "generate-video",
        payload: submissionPayload,
      });
      const attempt = preparedAttempt.attempt;
      activeVideoAttempt = preparedAttempt;
      videoSubmissionAttemptRef.current = attempt;
      const submittedTasks = await confirmPricingRetry(
        () => generateQuickCreateVideos(submissionPayload, attempt.idempotencyKey),
        () => generateQuickCreateVideos(submissionPayload, attempt.idempotencyKey, { confirmPricing: true }),
      );
      const pendingReconcile = hasPendingReconcileSubmission(submittedTasks);
      setTasks(submittedTasks);
      if (!pendingReconcile) {
        clearStoredSubmissionAttempt(preparedAttempt.storageKey);
        videoSubmissionAttemptRef.current = null;
      }
      stopTaskPolling();
      await refreshTasks(project.project.id);
      const rejectedTasks = submittedTasks.filter((task) => (
        task.status !== "pending_reconcile" && (task.status === "failed"
        || task.status === "cancelled"
        || Boolean(task.errorReason))
      ));
      showNotice(
        pendingReconcile
          ? "任务与 GU 正在待核，已保留安全重试标识；请刷新任务状态，请勿重复提交"
          : rejectedTasks.length
          ? rejectedTasks.map((task) => (
              `镜头 ${task.trackId}：${task.errorReason || "未成功进入上游队列"}`
            )).join("；")
          : "视频任务已提交",
      );
    } catch (error) {
      carryingUtilityDraftProjectIdRef.current = null;
      if (activeVideoAttempt && !shouldRetainStoredSubmissionAttempt(error)) {
        clearStoredSubmissionAttempt(activeVideoAttempt.storageKey);
        if (
          videoSubmissionAttemptRef.current?.idempotencyKey
          === activeVideoAttempt.attempt.idempotencyKey
        ) {
          videoSubmissionAttemptRef.current = null;
        }
      }
      showNotice(error instanceof Error ? error.message : "提交失败");
    } finally {
      setIsSubmittingVideo(false);
    }
  }

  const restoredAgentContextScopes = useMemo(
    () => restoreAgentContextScopes(agentMessages),
    [agentMessages],
  );
  const quickSessionContext = useMemo(() => {
    if (
      !creationSession
      || currentProjectId === null
      || String(creationSession.projectId) !== String(currentProjectId)
    ) return { assets: [], skills: [], styles: [], references: [], canonicalSkills: [] };
    return restoreQuickSessionContext({
      parameters: creationSession.parameters,
      selectedAssetVersionIds: creationSession.selectedAssetVersionIds,
      projectAssets,
      officialSkills,
    });
  }, [creationSession, currentProjectId, officialSkills, projectAssets]);
  useEffect(() => {
    if (!quickSessionContext.references.length) return;
    const rawUploads = Array.isArray(creationSession?.parameters.uploadedAttachments)
      ? creationSession.parameters.uploadedAttachments.filter(isRecord)
      : [];
    const rawByVersion = new Map(rawUploads.map((attachment) => [
      String(attachment.assetVersionId || ""),
      attachment,
    ]));
    setAttachments((current) => {
      let changed = false;
      const next = [...current];
      quickSessionContext.references.forEach((reference) => {
        if (activeMode === "Agent 模式" && !isAgentSessionReferenceAllowed(reference)) return;
        const version = String(reference.assetVersionId || "").trim();
        if (!version) return;
        const raw = rawByVersion.get(version);
        const clientId = typeof raw?.clientId === "string" ? raw.clientId : "";
        const matchIndex = next.findIndex((attachment) => (
          attachment.assetVersionId === version
          || (clientId && attachment.id === clientId)
          || (attachment.file && attachment.name === reference.name)
        ));
        const restored: GenerateAttachment = {
          id: clientId || `session-reference-${version}`,
          name: reference.name,
          size: Number.isFinite(Number(raw?.size)) ? Number(raw?.size) : 0,
          type: typeof raw?.mimeType === "string" ? raw.mimeType : "application/octet-stream",
          previewUrl: reference.thumbnailUrl || "",
          kind: String(reference.kind || "").includes("图片")
            ? "image"
            : String(reference.kind || "").includes("视频")
              ? "video"
              : "file",
          assetId: reference.assetId,
          assetVersionId: version,
          filePath: typeof raw?.filePath === "string" ? raw.filePath : undefined,
        };
        if (matchIndex >= 0) {
          const matched = next[matchIndex];
          if (matched.assetVersionId === version && !matched.file) return;
          if (matched.file && matched.previewUrl.startsWith("blob:")) {
            window.URL.revokeObjectURL(matched.previewUrl);
          }
          next[matchIndex] = { ...matched, ...restored, id: matched.id };
          changed = true;
          return;
        }
        next.push(restored);
        changed = true;
      });
      return changed ? next : current;
    });
  }, [activeMode, creationSession?.parameters.uploadedAttachments, quickSessionContext.references]);
  const selectedContextAssets = uniqueContextItemsByKey(selectedSubjects
    .filter((subject) => Number.isSafeInteger(subject.numericId) && Number(subject.numericId) > 0)
    .map((subject) => ({
      id: subject.id,
      assetId: subject.numericId,
      name: subject.name,
      thumbnailUrl: subject.image,
      kind: subject.type,
    })), (asset) => String(asset.assetId));
  const pendingContextAssets = activeMode === "Agent 模式"
    ? uniqueContextItemsByKey([
        ...selectedContextAssets,
        ...quickSessionContext.assets,
      ], (asset) => String(asset.assetId))
    : [];
  const agentTurnSkills = mergeAgentTurnSkills(selectedSkills, quickSessionContext.canonicalSkills);
  const pendingContextSkills = agentTurnSkills.map((skill) => ({
    id: skill.id,
    name: skill.name,
    source: quickSessionContext.canonicalSkills.some((sessionSkill) => sessionSkill.id === skill.id)
      ? "快速模式草稿"
      : "官方",
  }));
  const localContextReferences: StudioContextReference[] = attachments
    .filter((attachment) => (
      isGenerateAttachmentAllowed(activeMode, attachment, videoInputSlots)
    ))
    .map((attachment) => ({
      id: `local-reference-${attachment.id}`,
      assetId: attachment.assetId,
      assetVersionId: attachment.assetVersionId,
      name: attachment.name,
      thumbnailUrl: attachment.kind === "image" ? attachment.previewUrl : undefined,
      kind: activeMode === "Agent 模式"
        ? agentReferenceDisplayKind(
            attachment.type.startsWith("audio/")
              ? "audio"
              : videoAttachmentKindText(attachment.kind),
          )
        : attachment.type.startsWith("audio/")
          ? "音频"
          : videoAttachmentKindText(attachment.kind),
    }));
  const pendingContextReferences = uniqueContextItemsByKey([
    ...(activeMode === "Agent 模式"
      ? quickSessionContext.references
          .filter(isAgentSessionReferenceAllowed)
          .map((reference) => ({
            ...reference,
            kind: agentReferenceDisplayKind(reference.kind),
          }))
      : []),
    ...localContextReferences,
  ], (reference) => reference.assetVersionId
    ? `asset-version:${reference.assetVersionId}`
    : `local:${String(reference.id)}`);
  const selectedContextStyles = resolvedContextStyleName
    ? [{
        id: sessionContextStyleName
          ? `session-${creationSession?.id || "current"}-style`
          : `project-${currentProjectId || "current"}-style`,
        name: resolvedContextStyleName,
        source: sessionContextStyleName ? "本轮" : "项目",
      }]
    : [];
  const pendingContextStyles = uniqueContextItemsByName([
    ...selectedContextStyles,
    ...quickSessionContext.styles,
  ]);
  const agentSurfaceBlocked = activeMode === "Agent 模式" && !agentSurfaceAvailable;
  const agentSurfaceDegraded = activeMode === "Agent 模式"
    && agentSurfaceAvailable
    && (
      !agentCapabilities.imageGeneration
      || !agentCapabilities.videoGeneration
      || Boolean(agentSurfaceMessage)
    );
  const agentCapabilityStatuses = [
    { id: "chat", label: "对话", available: agentCapabilities.chat },
    { id: "tools", label: "工具", available: agentCapabilities.tools },
    { id: "image", label: "图片生成", available: agentCapabilities.imageGeneration },
    { id: "video", label: "视频生成", available: agentCapabilities.videoGeneration },
  ];
  const degradedCapabilityLabels = agentCapabilityStatuses
    .filter((item) => !item.available)
    .map((item) => item.label);
  const agentSurfaceStatusText = agentChatModelsLoading
    ? "正在确认 Agent 的 Worker、模型路由、生成能力与计费链路"
    : agentChatModelsError || "Agent 真实执行链路尚未就绪";
  const agentCapabilityNoticeText = agentSurfaceDegraded
    ? degradedCapabilityLabels.length
      ? `${agentSurfaceMessage || "部分生成能力暂不可用"}。对话仍可使用，${degradedCapabilityLabels.join("、")}已暂停。`
      : `${agentSurfaceMessage || "实时健康状态暂不可用"}。服务入口保持开放，提交时由服务端执行最终校验。`
    : agentSurfaceStatusText;

  return (
    <main
      className={`generatePage ${embedded ? "generatePageEmbedded" : ""} ${dark ? "themeDark" : "themeLight"}`}
      data-testid={activeMode === "Agent 模式" ? "agent-multiturn-ui-surface" : undefined}
    >
      <section className="generateShell">
        {!embedded ? <FrontstageNav active="generate" dark={dark} onToggleDark={theme.toggle} onNotice={showNotice} /> : null}

        <aside className={`generateConversationRail ${embedded ? "generateEmbeddedUtilityRail" : ""} ${activeMode === "Agent 模式" && skillLibraryOpen ? "skillOpen" : ""}`}>
          <>
            {activeMode === "Agent 模式" ? (
              <>
                <button
                  className={skillLibraryOpen ? "generateSkillLibraryButton active" : "generateSkillLibraryButton"}
                  type="button"
                  data-testid="agent-skill-library-button"
                  disabled={agentSurfaceBlocked}
                  onClick={() => setSkillLibraryOpen((current) => !current)}
                >
                  <LibraryBig size={18} />
                  <span>技能库</span>
                  {selectedSkills.length ? <em>{selectedSkills.length}</em> : <ChevronRight size={15} />}
                </button>

                {skillLibraryOpen ? (
                  <section className="generateSkillLibraryPanel" onClick={(event) => event.stopPropagation()}>
                    <header>
                      <div>
                        <strong>技能库</strong>
                        <small>仅展示 Agent Runtime 已注册、可随消息真实提交的技能</small>
                      </div>
                      <button type="button" aria-label="关闭技能库" onClick={() => setSkillLibraryOpen(false)}><X size={17} /></button>
                    </header>
                    <label className="generateSkillSearch">
                      <Search size={15} />
                      <input value={skillQuery} onChange={(event) => setSkillQuery(event.target.value)} placeholder="搜索技能" />
                    </label>
                    <div className="generateSkillList">
                      {visibleSkills.length ? visibleSkills.map((skill) => {
                        const selected = selectedSkills.some((item) => item.id === skill.id);
                        return (
                          <button
                            key={skill.id}
                            className={selected ? "selected" : ""}
                            type="button"
                            data-testid="agent-skill-option"
                            data-skill-source={skill.source}
                            data-selected={selected ? "true" : "false"}
                            onClick={() => toggleSkill(skill)}
                          >
                            <span><Wrench size={16} /></span>
                            <span>
                              <strong>{skill.name}</strong>
                              <small>{`${skill.category || "创作技能"} · ${skill.provider === "jimeng" ? "即梦迁移" : "Fanjin"} · `}{skill.description}</small>
                            </span>
                            {selected ? <Check size={16} /> : null}
                          </button>
                        );
                      }) : (
                        <p>
                          {officialSkillsLoading
                            ? "技能目录加载中"
                            : officialSkillsError
                              ? `技能目录读取失败：${officialSkillsError}`
                              : "暂无匹配技能"}
                        </p>
                      )}
                    </div>
                  </section>
                ) : null}
              </>
            ) : null}
          </>

          {!embedded ? (
            <button
              className="generateNewChat"
              type="button"
              data-testid={activeMode === "Agent 模式" ? "agent-new-conversation" : undefined}
              onClick={startNewConversation}
            >
              <Plus size={18} />
              新对话
            </button>
          ) : null}

          <div className="generateRailSectionTitle">
            <span>历史对话</span>
            <small>{runtimeHistoryLoading ? "同步中" : conversations.length}</small>
          </div>
          <div className="generateConversationList">
            {conversationGroups.length ? conversationGroups.map((group) => (
              <section key={group.projectId || "unassigned"} className="generateConversationGroup">
                <div className="generateConversationGroupTitle">
                  <FolderOpen size={15} />
                  <strong>{group.projectName}</strong>
                </div>
                {group.items.map((conversation) => (
                  <button key={conversation.id} className={activeConversationId === conversation.id ? "active" : ""} type="button" onClick={() => void openConversation(conversation)}>
                    <MessageSquare size={15} />
                    <span>
                      <strong>{conversation.title}</strong>
                      <small>{conversation.mode} · {formatConversationTime(conversation.updatedAt)}</small>
                    </span>
                  </button>
                ))}
              </section>
            )) : <div className="generateConversationEmpty">生成内容后，对话会按项目保存在这里</div>}
          </div>
        </aside>

        <div className="generateMain" onClick={() => setActivePanel(null)}>
          <section className={`generateCenter ${activeMode === "Agent 模式" ? "generateAgentMode" : ""}`}>
            {activeMode === "Agent 模式" ? (
              <>
                <header className="generateAgentHeader">
                  {embedded ? (
                    <div
                      id="project-studio-project-header-slot"
                      className="generateProjectHeaderSlot"
                      data-project-theme={dark ? "dark" : "light"}
                      aria-label="当前项目"
                    />
                  ) : (
                    <div>
                      <span className="generateAgentHeaderIcon"><Bot size={18} /></span>
                      <span>
                        <strong>{activeConversation?.title || "新对话"}</strong>
                        <small>{`${currentProject?.name || "未关联项目"} · ${agentChatModelsLoading ? "模型加载中" : selectedAgentChatOption?.displayName || "模型未配置"}`}</small>
                      </span>
                    </div>
                  )}
                  <div className="generateAgentHeaderActions">
                    <span className={`generateAgentRunState ${isGenerating ? "running" : ""}`} role="status" aria-live="polite">
                      {isGenerating ? <Loader2 className="jimengSpin" size={14} /> : <Circle size={12} />}
                      {isGenerating
                        ? "Agent 运行中"
                        : agentSurfaceBlocked
                          ? agentChatModelsLoading ? "能力检查中" : "当前不可用"
                          : agentSurfaceDegraded ? "部分能力受限"
                          : legacyAgentConversation ? "历史只读" : "等待输入"}
                    </span>
                    {embedded ? (
                      <button
                        type="button"
                        data-testid="agent-new-conversation"
                        onClick={startNewConversation}
                      >
                        <Plus size={16} />
                        <span>新对话</span>
                      </button>
                    ) : (
                      <button type="button" onClick={startNewConversation}>
                        <Plus size={16} />
                        <span>新对话</span>
                      </button>
                    )}
                  </div>
                </header>

                <section className="generateAgentTranscript" aria-label="Agent 对话记录">
                  {!agentChatModelsLoading && agentSurfaceDegraded ? (
                    <section className="generateAgentCapabilityNotice degraded" role="status" aria-live="polite">
                      <div>
                        <strong>部分能力受限</strong>
                        <span>{agentCapabilityNoticeText}</span>
                      </div>
                      <div className="generateAgentCapabilityStates" aria-label="Agent 能力状态">
                        {agentCapabilityStatuses.map((item) => (
                          <span key={item.id} data-available={item.available ? "true" : "false"}>
                            {item.available ? <Check size={13} /> : <X size={13} />}
                            {item.label}
                          </span>
                        ))}
                      </div>
                      <button type="button" onClick={() => setAgentCatalogRefreshKey((current) => current + 1)}>
                        <RefreshCw size={14} />重新检查
                      </button>
                    </section>
                  ) : null}
                  {agentSurfaceBlocked ? (
                    <div className="generateAgentEmpty" role="status" aria-live="polite">
                      {agentChatModelsLoading ? <Loader2 className="jimengSpin" size={28} /> : <Bot size={28} />}
                      <h1>{agentChatModelsLoading ? "正在确认真实执行能力" : "Agent 当前不可提交"}</h1>
                      <p>{agentSurfaceStatusText}</p>
                      {!agentChatModelsLoading ? (
                        <div>
                          <div className="generateAgentCapabilityStates" aria-label="Agent 能力状态">
                            {agentCapabilityStatuses.map((item) => (
                              <span key={item.id} data-available={item.available ? "true" : "false"}>
                                {item.available ? <Check size={13} /> : <X size={13} />}
                                {item.label}
                              </span>
                            ))}
                          </div>
                          <button type="button" onClick={() => setAgentCatalogRefreshKey((current) => current + 1)}>
                            <RefreshCw size={14} />重新检查
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ) : agentMessages.length ? agentMessages.map((message) => message.role === "system" ? (
                    <article className="generateAgentMessage systemNotice" key={message.id}>
                      <p>{message.content}</p>
                      <time dateTime={new Date(message.createdAt).toISOString()}>{formatMessageTime(message.createdAt)}</time>
                    </article>
                  ) : message.role === "user" ? (
                    <article
                      className="generateAgentMessage user"
                      data-testid="agent-message"
                      data-message-role="user"
                      key={message.id}
                    >
                      <div className="generateAgentUserBubble">
                        <p>{message.content}</p>
                        {message.serverVerified && message.contextLabels?.length ? (
                          <div className="generateAgentMessageContext">
                            {message.contextLabels.map((label) => <span key={label}>{label}</span>)}
                          </div>
                        ) : null}
                      </div>
                      <time dateTime={new Date(message.createdAt).toISOString()}>{formatMessageTime(message.createdAt)}</time>
                    </article>
                  ) : (
                    <article
                      className={`generateAgentMessage assistant ${message.status || "completed"}`}
                      data-testid="agent-message"
                      data-message-role="assistant"
                      data-message-status={message.status || "completed"}
                      key={message.id}
                    >
                      <span className="generateAgentAvatar"><Bot size={17} /></span>
                      <div className="generateAgentResponse">
                        <header>
                          <strong>Fanjin Agent</strong>
                          <time dateTime={new Date(message.createdAt).toISOString()}>{formatMessageTime(message.createdAt)}</time>
                        </header>
                        {message.steps?.length || runtimeUsedSkillsForRun(agentMessages, message.runId).length ? (
                          <div className="generateAgentSteps" aria-label="本轮运行步骤">
                            {runtimeUsedSkillsForRun(agentMessages, message.runId).length ? (
                              <div
                                className="generateAgentStep completed"
                                data-testid="agent-runtime-skill-injection"
                                data-skill-count={runtimeUsedSkillsForRun(agentMessages, message.runId).length}
                              >
                                <span aria-hidden="true"><Check size={14} /></span>
                                <strong>已注入官方技能</strong>
                                <small>
                                  {runtimeUsedSkillsForRun(agentMessages, message.runId)
                                    .map((skill) => `${skill.displayName} · v${skill.version}`)
                                    .join("、")}
                                </small>
                              </div>
                            ) : null}
                            {(message.steps || []).map((step) => {
                              const stepStatus = agentRuntimeStepUiStatus(step.status);
                              return (
                                <div
                                  className={`generateAgentStep ${stepStatus}`}
                                  data-testid="agent-runtime-step"
                                  data-step-id={step.id}
                                  data-step-seq={step.seq}
                                  data-step-kind={step.kind}
                                  data-tool-name={step.toolName || undefined}
                                  key={step.id}
                                >
                                  <span aria-hidden="true">
                                    {stepStatus === "running"
                                      ? <Loader2 className="jimengSpin" size={14} />
                                      : stepStatus === "completed"
                                        ? <Check size={14} />
                                        : stepStatus === "queued" || stepStatus === "waiting" || stepStatus === "uncertain"
                                          ? <Circle size={12} />
                                          : <X size={14} />}
                                  </span>
                                  <strong>{agentRuntimeStepLabel(step)}</strong>
                                  <small>{agentRuntimeStepDetail(step)}</small>
                                </div>
                              );
                            })}
                          </div>
                        ) : null}
                        {message.stepsError ? (
                          <p className="generateAgentStepsError" role="alert">{message.stepsError}</p>
                        ) : null}
                        {message.approvals?.length ? (
                          <div className="agentApprovalList" aria-label="本轮工具审批">
                            {message.approvals.map((approval) => (
                              <AgentApprovalCard
                                approval={approval}
                                generationCapability={resolveAgentApprovalGenerationCapability(
                                  approval,
                                  imageCapabilities,
                                  videoCapabilities,
                                )}
                                key={approval.id}
                                onUpdated={handleApprovalUpdated}
                                onRefresh={() => refreshVisibleApproval(approval.runId)}
                                onRequestError={(error) => {
                                  handleAgentRuntimeFailure(error, "审批决定提交失败");
                                }}
                              />
                            ))}
                          </div>
                        ) : null}
                        {message.approvalsError ? (
                          <p className="agentApprovalLoadError" aria-live="polite">{message.approvalsError}</p>
                        ) : null}
                        {message.runStateLabel ? (
                          <div className="generateAgentSteps" aria-label="运行状态">
                            <div className="generateAgentStep waiting">
                              <span aria-hidden="true"><Loader2 className="jimengSpin" size={14} /></span>
                              <strong>{message.runStateLabel}</strong>
                              <small>确认上方审批卡后 Agent 会继续</small>
                            </div>
                          </div>
                        ) : null}
                        {message.content ? <AgentMarkdownContent className="generateAgentResponseText" content={message.content} /> : null}
                        <AgentGenerationResults steps={message.steps || []} />
                        {message.presentedPlan ? (
                          <section className="generateAgentPlan">
                            <header>
                              <span>创作方案</span>
                              <small>{message.presentedPlan.estimatedTotal || `${message.presentedPlan.steps.length} 个步骤`}</small>
                            </header>
                            <h2>{message.presentedPlan.title}</h2>
                            {message.presentedPlan.summary ? <p>{message.presentedPlan.summary}</p> : null}
                            <ol>
                              {message.presentedPlan.steps.map((step, index) => (
                                <li key={`${message.id}-${step.title}-${index}`}>
                                  <span>{String(index + 1).padStart(2, "0")}</span>
                                  <div>
                                    <strong>{step.title}</strong>
                                    {step.detail ? <p>{step.detail}</p> : null}
                                  </div>
                                </li>
                              ))}
                            </ol>
                            {!legacyAgentConversation && message.id === latestCompletedPlanMessageId ? (
                              <div className="generateAgentPlanActions">
                                <button
                                  type="button"
                                  onClick={() => setPrompt(`请继续将「${message.presentedPlan?.title}」细化为可执行分镜脚本，保留现有创意方向，补全每个镜头的时长、画面、旁白、字幕和转场。本轮只完善方案，不提交生成。`)}
                                >
                                  细化分镜
                                </button>
                              </div>
                            ) : null}
                          </section>
                        ) : null}
                        {!legacyAgentConversation
                          && message.status === "running"
                          && message.runStateLabel === AGENT_RUN_RECOVERY_LABEL ? (
                            <button className="generateAgentRetry" type="button" onClick={recoverOriginalAgentRun}>
                              <RotateCcw size={15} />恢复原运行
                            </button>
                          ) : null}
                        {renderAgentRetryControls(message)}
                      </div>
                    </article>
                  )) : (
                    <div className="generateAgentEmpty">
                      <img className="generateAgentEmptyLogo" src={fanjinLogo} alt="" aria-hidden="true" />
                      <h1>从一个创作目标开始</h1>
                      <p>消息会进入服务器 Agent Runtime；图片与文档会读取内容，视频只会作为生成工具参考，不解析画面、声音或时序。</p>
                      <div>
                        {["帮我策划一支 15 秒产品广告", "把这个想法拆成三个镜头", "先和我一起明确风格与受众"].map((suggestion) => (
                          <button key={suggestion} type="button" onClick={() => setPrompt(suggestion)}>{suggestion}</button>
                        ))}
                      </div>
                    </div>
                  )}
                  <div ref={agentTranscriptEndRef} />
                </section>
              </>
            ) : <h1>你好，想创作什么？</h1>}
            {embedded && activeMode === "Agent 模式" ? (
              <ContextPanel
                className="generateEmbeddedContextPanel"
                usedAssets={restoredAgentContextScopes.used.assets}
                usedSkills={restoredAgentContextScopes.used.skills}
                usedStyles={restoredAgentContextScopes.used.styles}
                usedReferences={restoredAgentContextScopes.used.references}
                assets={restoredAgentContextScopes.confirmed.assets}
                skills={restoredAgentContextScopes.confirmed.skills}
                styles={restoredAgentContextScopes.confirmed.styles}
                references={restoredAgentContextScopes.confirmed.references}
                pendingAssets={pendingContextAssets}
                pendingSkills={pendingContextSkills}
                pendingStyles={pendingContextStyles}
                pendingReferences={pendingContextReferences}
                defaultExpanded
              />
            ) : null}
            <div
              className={`generateComposer ${activeMode === "Agent 模式" ? "generateAgentComposer" : ""}`}
              data-testid={activeMode === "Agent 模式" ? "agent-composer" : undefined}
              onClick={(event) => event.stopPropagation()}
            >
              <button
                className="generateUpload"
                type="button"
                data-testid="agent-attachment-upload-button"
                aria-label={activeMode === "Agent 模式"
                  ? "上传图片、视频或文档参考；视频仅用于生成参考，不解析内容"
                  : "上传当前模式支持的生成参考"}
                title={activeMode === "Agent 模式"
                  ? "图片/文档会读取内容；视频仅用于生成参考，不解析内容"
                  : "上传当前模式支持的生成参考"}
                disabled={agentSurfaceBlocked || referenceUploadPending || !attachmentAccept}
                onClick={() => fileInputRef.current?.click()}
              >
                <Plus size={22} />
              </button>
              <input
                ref={fileInputRef}
                className="jimengHiddenInput"
                type="file"
                data-testid="agent-attachment-input"
                multiple
                accept={attachmentAccept}
                onChange={(event) => {
                  handleFilesSelected(event.target.files);
                  event.currentTarget.value = "";
                }}
              />
              <textarea
                aria-label={activeMode === "Agent 模式" ? "发送消息给 Fanjin Agent" : "输入创作内容"}
                data-testid={activeMode === "Agent 模式" ? "agent-message-input" : undefined}
                value={prompt}
                disabled={activeMode === "Agent 模式" && (
                  legacyAgentConversation
                  || agentSurfaceBlocked
                  || agentRunRecoveryPending
                )}
                onChange={(event) => {
                  const value = event.target.value;
                  setPrompt(value);
                  if (activeMode !== "Agent 模式") {
                    setSkillLibraryOpen(false);
                    if (activePanel === "subjects") setActivePanel(null);
                    return;
                  }
                  const lastToken = value.split(/\s/).at(-1) || "";
                  if (lastToken.startsWith("/")) {
                    setActivePanel(null);
                    setSkillLibraryOpen(true);
                  } else if (lastToken.startsWith("@")) {
                    setSkillLibraryOpen(false);
                    setActivePanel("subjects");
                  }
                }}
                onKeyDown={(event) => {
                  if (activeMode === "Agent 模式" && event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void submitPrompt();
                    return;
                  }
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                    event.preventDefault();
                    void submitPrompt();
                  }
                }}
                placeholder={activeMode === "Agent 模式"
                  ? agentSurfaceBlocked
                    ? agentSurfaceStatusText
                    : agentRunRecoveryPending
                      ? "原运行状态尚未确认，请先恢复原运行"
                    : legacyAgentConversation
                    ? "旧版本地对话仅供查看，请新建对话后继续"
                    : currentProjectId
                      ? "继续描述、修改或追问；支持上传参考、“/” 使用技能、@ 添加资产…"
                      : "描述你的目标，或上传参考并添加技能与资产…"
                  : "输入想法、脚本或上传会真实提交的参考素材"}
              />
              {attachments.length || (activeMode === "Agent 模式" && (selectedSubjects.length || selectedSkills.length)) ? (
                <div className="generateContextChips" aria-label="对话上下文">
                  {attachments.map((attachment) => (
                    <span
                      className="jimengContextChip mediaChip"
                      data-testid="agent-attachment-chip"
                      data-attachment-kind={attachment.kind}
                      key={attachment.id}
                    >
                      {attachment.kind === "image" ? (
                        <ReferencePreviewImage src={attachment.previewUrl} alt="" />
                      ) : attachment.kind === "video" ? (
                        <ReferencePreviewVideo src={attachment.previewUrl} aria-label={`预览 ${attachment.name}`} muted />
                      ) : attachment.type.startsWith("audio/") ? (
                        <ReferencePreviewAudio src={attachment.previewUrl} aria-label={`播放 ${attachment.name}`} controls />
                      ) : <FileText size={16} />}
                      <strong>{attachment.name}</strong>
                      <PortraitAdmissionIndicator name={attachment.name} approved={approvedAssetVersionIds.includes(Number(attachment.assetVersionId))} />
                      <small>
                        {activeMode === "Agent 模式"
                          ? agentAttachmentUseText(attachment)
                          : attachment.assetVersionId ? "已上传" : "随消息发送"}
                        {attachment.size ? ` · ${formatAttachmentSize(attachment.size)}` : ""}
                      </small>
                      <button type="button" aria-label={`移除 ${attachment.name}`} onClick={() => removeAttachment(attachment.id)}>
                        <X size={13} />
                      </button>
                    </span>
                  ))}
                  {activeMode === "Agent 模式" ? selectedSubjects.map((subject) => (
                    <span
                      className="jimengContextChip"
                      data-testid="agent-selected-project-asset"
                      key={subject.id}
                    >
                      <AtSign size={14} />
                      <strong>{subject.name}</strong>
                      <PortraitAdmissionIndicator name={subject.name} approved={approvedAssetVersionIds.includes(Number(subject.assetVersionId))} />
                      <small>{subject.type}</small>
                      <button type="button" aria-label={`移除 ${subject.name}`} onClick={() => setSelectedSubjects((current) => current.filter((item) => item.id !== subject.id))}>
                        <X size={13} />
                      </button>
                    </span>
                  )) : null}
                  {activeMode === "Agent 模式" ? selectedSkills.map((skill) => (
                    <span
                      className="jimengContextChip"
                      data-testid="agent-selected-skill"
                      data-skill-source={skill.source}
                      key={skill.id}
                    >
                      <Wrench size={14} />
                      <strong>{skill.name}</strong>
                      <small>{skill.source === "official" ? "官方" : "自定义"}</small>
                      <button type="button" aria-label={`移除 ${skill.name}`} onClick={() => setSelectedSkills((current) => current.filter((item) => item.id !== skill.id))}>
                        <X size={13} />
                      </button>
                    </span>
                  )) : null}
                </div>
              ) : null}
              <PortraitAdmissionPanel
                variant="references"
                model={videoSettings.model}
                onApprovalChange={onApprovalChange}
                projectId={Number.isSafeInteger(Number(currentProjectId)) && Number(currentProjectId) > 0
                  ? Number(currentProjectId)
                  : null}
                assets={[...attachments.flatMap((attachment) => {
                  const assetVersionId = Number(attachment.assetVersionId);
                  if (!Number.isSafeInteger(assetVersionId) || assetVersionId <= 0 || (attachment.kind !== "image" && attachment.kind !== "video")) return [];
                  return [{
                    assetVersionId,
                    name: attachment.name,
                    previewUrl: attachment.previewUrl,
                    mediaType: attachment.kind,
                  }];
                }), ...(activeMode === "Agent 模式" ? selectedSubjects.flatMap((subject) => (
                  subject.assetVersionId && subject.mediaType
                    ? [{
                        assetVersionId: subject.assetVersionId,
                        name: subject.name,
                        previewUrl: subject.image,
                        mediaType: subject.mediaType,
                      }]
                    : []
                )) : [])]}
                onBlockingChange={setPortraitAdmissionBlocking}
              />
              <div className="generateControls">
                <div>
                  {embedded ? (
                    <button type="button" disabled aria-label="当前创作类型：Agent 模式">
                      <WandSparkles size={16} />
                      Agent 模式
                    </button>
                  ) : (
                    <button className={activePanel === "mode" ? "active" : ""} type="button" aria-haspopup="menu" aria-expanded={activePanel === "mode"} onClick={() => setActivePanel((current) => current === "mode" ? null : "mode")}>
                      <WandSparkles size={16} />
                      {activeMode}
                      <ChevronRight size={15} />
                    </button>
                  )}
                  <button
                    className={activePanel === "models" ? "active" : ""}
                    type="button"
                    data-testid="agent-model-picker"
                    disabled={agentSurfaceBlocked}
                    onClick={() => {
                      if (activePanel === "models") {
                        setActivePanel(null);
                        return;
                      }
                      setModelTab(activeMode === "图片生成" ? "图片" : activeMode === "视频生成" ? "视频" : "对话");
                      setActivePanel("models");
                    }}
                  >
                    <Bot size={16} />
                    模型 · {activeMode === "Agent 模式"
                      ? agentChatModelsLoading
                        ? "加载中"
                        : selectedAgentChatOption
                          ? `${selectedAgentChatOption.displayName}${selectedAgentChatOption.default ? "（默认）" : ""}`
                          : "未配置"
                      : modelOptionsLoading
                        ? "加载中"
                        : activeMode === "图片生成"
                          ? selectedImageCapability?.label || "未配置"
                          : activeMode === "视频生成"
                            ? selectedVideoCapability?.label || "未配置"
                            : selectedLlmOption?.label || "未配置"}
                    <ChevronDown size={14} />
                  </button>
                  <button
                    className={activePanel === "auto" ? "active" : ""}
                    type="button"
                    data-testid="generation-preference-picker"
                    disabled={agentSurfaceBlocked || (activeMode === "Agent 模式" && !agentCapabilities.imageGeneration && !agentCapabilities.videoGeneration)}
                    title={activeMode === "Agent 模式" && !agentCapabilities.imageGeneration && !agentCapabilities.videoGeneration
                      ? "图片与视频生成暂不可用，对话仍可发送"
                      : "设置生成偏好"}
                    onClick={() => setActivePanel((current) => current === "auto" ? null : "auto")}
                  >
                    <Settings size={16} />
                    {activePreferenceTab === "图片"
                      ? `${selectedRatio || "比例未配置"} · ${imageQuality}`
                      : `${selectedRatio || "比例未配置"} · ${videoSettings.duration === -1 ? "自动" : videoSettings.duration > 0 ? `${videoSettings.duration}s` : "时长未配置"} · ${videoSettings.resolution || "清晰度未配置"}`}
                  </button>
                  {activeMode === "Agent 模式" ? (
                    <button
                      className={skillLibraryOpen ? "active" : ""}
                      type="button"
                      data-testid="agent-skill-picker"
                      disabled={agentSurfaceBlocked}
                      onClick={() => {
                      setActivePanel(null);
                      setSkillLibraryOpen((current) => !current);
                      }}
                    >
                      <Wrench size={16} />
                      {selectedSkills.length ? `技能 ${selectedSkills.length}` : "使用技能"}
                    </button>
                  ) : null}
                  {activeMode === "Agent 模式" ? (
                    <button
                      className={activePanel === "subjects" ? "active" : ""}
                      type="button"
                      data-testid="agent-project-asset-picker"
                      disabled={agentSurfaceBlocked}
                      aria-label="@ 资产"
                      title="@ 资产"
                      onClick={() => setActivePanel((current) => current === "subjects" ? null : "subjects")}
                    >
                      <AtSign size={16} />
                      <span>@ 资产</span>
                    </button>
                  ) : null}
                </div>
                <div>
                  <button type="button" title="语音输入" disabled={agentSurfaceBlocked} onClick={startVoiceInput}>
                    <Mic size={17} />
                  </button>
                  <button
                    className={`generateSend ${activeMode === "Agent 模式" && isGenerating ? "stop" : ""}`}
                    type="button"
                    data-testid="agent-send-button"
                    title={activeMode === "Agent 模式" && isGenerating
                      ? "停止本轮"
                      : agentRunRecoveryPending
                        ? "恢复原运行"
                      : !activeRuntimeModeAvailable
                        ? activeMode === "Agent 模式"
                          ? agentSurfaceStatusText
                          : modelOptionsError || "当前模式没有完整真实能力"
                      : activeMode === "图片生成" && imageConfigurationErrors.length
                        ? imageConfigurationErrors[0]
                        : activeMode === "视频生成" && videoPromptConfigurationErrors.length
                          ? videoPromptConfigurationErrors[0]
                          : activeMode === "视频生成" && !selectedLlmOption
                            ? "视频生成需要可用的对话模型先生成导演方案"
                          : "发送"}
                    aria-label={activeMode === "Agent 模式" && isGenerating
                      ? "停止本轮"
                      : agentRunRecoveryPending
                        ? "恢复原运行"
                        : "发送消息"}
                    disabled={referenceUploadPending
                      || portraitAdmissionBlocking
                      || (activeMode !== "Agent 模式" && isGenerating)
                      || !activeRuntimeModeAvailable
                      || (activeMode === "Agent 模式" && (legacyAgentConversation || agentSurfaceBlocked))
                      || (activeMode === "图片生成" && imageConfigurationErrors.length > 0)
                      || (activeMode === "视频生成" && (
                        videoPromptConfigurationErrors.length > 0
                        || !selectedLlmOption
                      ))}
                    onClick={activeMode === "Agent 模式" && isGenerating
                      ? stopAgentRun
                      : agentRunRecoveryPending
                        ? recoverOriginalAgentRun
                        : submitPrompt}
                  >
                    {activeMode === "Agent 模式" && isGenerating
                      ? <Square size={15} fill="currentColor" />
                      : agentRunRecoveryPending
                        ? <RotateCcw size={18} />
                        : isGenerating
                          ? <Loader2 className="jimengSpin" size={18} />
                          : <ArrowUp size={20} />}
                  </button>
                </div>
              </div>
              {activeMode === "Agent 模式" ? (
                <small className="generateAgentComposerHint">
                  {legacyAgentConversation
                    ? "旧版本地对话只读 · 新建对话后可继续"
                    : agentSurfaceBlocked
                      ? agentSurfaceStatusText
                    : isGenerating
                      ? "本轮运行中 · 草稿会保留 · 停止或完成后可继续发送"
                    : agentRunRecoveryPending
                      ? `原运行 ${agentRecoveryRunId?.slice(0, 8)} 状态待恢复 · 不会创建新 Run`
                    : agentSurfaceDegraded
                      ? `${degradedCapabilityLabels.join("、")}暂不可用 · 对话仍可发送`
                    : currentProjectId
                      ? "多轮 Agent · 已携带本轮模型与引用 · Enter 发送"
                      : "发送首条消息后自动创建项目与创作会话"}
                </small>
              ) : null}

              {!embedded && activePanel === "mode" ? (
                <div className="generatePopover mode" role="menu" aria-label="创作类型">
                  <span>创作类型</span>
                  {runtimeGenerationModes.map((mode) => (
                    <button
                      key={mode}
                      className={activeMode === mode ? "selected" : ""}
                      type="button"
                      role="menuitemradio"
                      aria-checked={activeMode === mode}
                      onClick={() => {
                        switchMode(mode);
                      }}
                    >
                      {mode}
                    </button>
                  ))}
                  {!runtimeGenerationModes.length ? (
                    <small className="generateModelEmpty">
                      {modelOptionsLoading || agentChatModelsLoading
                        ? "正在确认真实执行能力"
                        : modelOptionsError || agentChatModelsError || "当前没有可执行模式"}
                    </small>
                  ) : null}
                </div>
              ) : null}
              {activePanel === "models" ? (
                <div className="generatePopover models">
                  <header className="generateModelHeader">
                    <span>
                      <strong>模型设置</strong>
                      <small>{modelTab === "对话" && activeMode === "Agent 模式"
                        ? `当前默认：${defaultAgentChatOption?.displayName || (agentChatModelsLoading ? "加载中" : "未配置")}`
                        : "分别设置对话、图片与视频模型"}</small>
                    </span>
                    <b>3 类模型</b>
                  </header>
                  <div className="generateModelTabs" role="tablist" aria-label="模型类型">
                    {(["对话", "图片", "视频"] as const).map((tab) => (
                      <button
                        key={tab}
                        type="button"
                        role="tab"
                        aria-selected={modelTab === tab}
                        className={modelTab === tab ? "selected" : ""}
                        onClick={() => setModelTab(tab)}
                      >
                        {tab === "对话" ? <Bot size={15} /> : tab === "图片" ? <Image size={15} /> : <Video size={15} />}
                        {tab}
                      </button>
                    ))}
                  </div>
                  <div className="generateModelList" role={modelTab === "对话" && activeMode === "Agent 模式" ? "radiogroup" : undefined} aria-label={modelTab === "对话" && activeMode === "Agent 模式" ? "Agent 对话模型" : undefined}>
                    {modelTab === "对话" && activeMode === "Agent 模式" ? agentChatModels.map((model) => (
                      <button
                        key={model.id}
                        className={selectedAgentChatModel === model.id ? "selected" : ""}
                        type="button"
                        data-testid="agent-chat-model-option"
                        data-model-id={model.id}
                        data-selected={selectedAgentChatModel === model.id ? "true" : "false"}
                        onClick={() => setSelectedAgentChatModel(model.id)}
                      >
                        <span className="generateModelIcon"><Bot size={17} /></span>
                        <span>
                          <span className="generateModelTitle">
                            <strong>{model.displayName}</strong>
                            {model.default ? <em>默认</em> : null}
                          </span>
                          <small>{model.modelId && model.modelId !== model.displayName ? `${model.modelId} · ` : ""}{agentChatModelPriceLabel(model)}{model.description ? ` · ${model.description}` : ""}</small>
                        </span>
                        {selectedAgentChatModel === model.id ? <Check size={15} /> : null}
                      </button>
                    )) : null}
                    {modelTab === "对话" && activeMode === "Agent 模式" && !agentChatModels.length ? (
                      <div className="generateModelEmpty">
                        <span>{agentChatModelsLoading
                          ? "Agent 对话模型目录加载中"
                          : agentChatModelsError ? `Agent 对话模型目录读取失败：${agentChatModelsError}` : "未配置可用的 Agent 对话模型"}</span>
                        {!agentChatModelsLoading && agentChatModelsError ? (
                          <button type="button" onClick={() => setAgentCatalogRefreshKey((current) => current + 1)}>
                            <RotateCcw size={13} />
                            重试
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                    {modelTab === "对话" && activeMode !== "Agent 模式" ? modelOptions.llmModels.map((model) => (
                      <button key={model.id} className={selectedLlmModel === model.id ? "selected" : ""} type="button" onClick={() => setSelectedLlmModel(model.id)}>
                        <span className="generateModelIcon"><Bot size={17} /></span>
                        <span>
                          <strong>{model.label}</strong>
                          <small>{model.description}</small>
                        </span>
                        {selectedLlmModel === model.id ? <Check size={15} /> : null}
                      </button>
                    )) : null}
                    {modelTab === "对话" && activeMode !== "Agent 模式" && !modelOptions.llmModels.length ? (
                      <small className="generateModelEmpty">{modelOptionsLoading ? "模型目录加载中" : "未配置可用的对话模型"}</small>
                    ) : null}
                    {modelTab === "图片" ? imageCapabilities.map((capability) => (
                      <button key={capability.id} className={imageModel === capability.id ? "selected" : ""} type="button" data-testid="image-model-option" data-model-id={capability.id} data-selected={imageModel === capability.id ? "true" : "false"} onClick={() => selectImageModel(capability.id)}>
                        <span className="generateModelIcon"><Image size={17} /></span>
                        <span>
                          <strong>{capability.label}</strong>
                          <small>{capabilityStatusText(capability.capabilityStatus)} · {capability.description || "图片生成模型"}</small>
                        </span>
                        {imageModel === capability.id ? <Check size={15} /> : null}
                      </button>
                    )) : null}
                    {modelTab === "图片" && !imageCapabilities.length ? (
                      <small className="generateModelEmpty">{modelOptionsLoading ? "模型目录加载中" : "未配置可用的图片模型"}</small>
                    ) : null}
                    {modelTab === "视频" ? modelOptions.videoModels
                      .filter((model) => videoCapabilities.some((capability) => capability.id === model.id))
                      .map((model) => {
                      const capability = videoCapabilities.find((item) => item.id === model.id);
                      return (
                        <button key={model.id} className={videoSettings.model === model.id ? "selected" : ""} type="button" onClick={() => selectVideoModel(model)}>
                          <span className="generateModelIcon"><Video size={17} /></span>
                          <span>
                            <strong>{model.label}</strong>
                            <small>{capability ? `${capabilityStatusText(capability.capabilityStatus)} · ` : ""}{model.description || "视频生成模型"}</small>
                          </span>
                          {videoSettings.model === model.id ? <Check size={15} /> : null}
                        </button>
                      );
                    }) : null}
                    {modelTab === "视频" && !videoCapabilities.length ? (
                      <small className="generateModelEmpty">{modelOptionsLoading ? "模型目录加载中" : "未配置可用的视频模型"}</small>
                    ) : null}
                  </div>
                  {modelOptionsError ? <small className="generateModelError">模型目录读取失败：{modelOptionsError}；生成提交已禁用</small> : null}
                </div>
              ) : null}
              {activePanel === "auto" ? (
                <div className="generatePopover auto">
                  <span>生成偏好</span>
                  {activeMode === "Agent 模式" ? (
                    <div className="generatePreferenceTabs" role="tablist" aria-label="偏好类型">
                      {(["图片", "视频"] as const).map((tab) => (
                        <button
                          key={tab}
                          type="button"
                          role="tab"
                          aria-selected={agentPreferenceTab === tab}
                          className={agentPreferenceTab === tab ? "selected" : ""}
                          disabled={tab === "图片"
                            ? !agentCapabilities.imageGeneration
                            : !agentCapabilities.videoGeneration}
                          onClick={() => setAgentPreferenceTab(tab)}
                        >
                          {tab === "图片" ? <Image size={15} /> : <Video size={15} />}
                          {tab}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  <div className="generateRatios">
                    {visibleRatioOptions.map((ratio) => (
                      <button key={ratio} className={selectedRatio === ratio ? "selected" : ""} type="button" onClick={() => setSelectedRatio(ratio)}>
                        {ratio}
                      </button>
                    ))}
                    {activeMode !== "Agent 模式" && activeMode !== "图片生成" && activeMode !== "视频生成" ? (
                      <button className={customRatioOpen || !selectedRatio || !ratioOptions.includes(selectedRatio) ? "selected" : ""} type="button" onClick={() => setCustomRatioOpen((current) => !current)}>
                        自定义
                      </button>
                    ) : null}
                  </div>
                  {customRatioOpen && activeMode !== "Agent 模式" && activeMode !== "图片生成" && activeMode !== "视频生成" ? (
                    <div className="generateCustomRatio">
                      <label><span>宽</span><input inputMode="numeric" value={customRatio.width} onChange={(event) => setCustomRatio((current) => ({ ...current, width: event.target.value.replace(/\D/g, "").slice(0, 3) }))} /></label>
                      <b>:</b>
                      <label><span>高</span><input inputMode="numeric" value={customRatio.height} onChange={(event) => setCustomRatio((current) => ({ ...current, height: event.target.value.replace(/\D/g, "").slice(0, 3) }))} /></label>
                      <button type="button" onClick={applyCustomRatio}>应用</button>
                    </div>
                  ) : null}
                  {activePreferenceTab === "图片" ? (
                    <div className="generateOptionRows">
                      <label>清晰度</label>
                      <div className="generateOptionGrid">
                        {(selectedImageCapability?.qualities || []).map((quality) => <button key={quality} className={imageQuality === quality ? "selected" : ""} type="button" data-testid="image-quality-option" data-quality={quality} data-selected={imageQuality === quality ? "true" : "false"} onClick={() => setImageQuality(quality)}>{quality}</button>)}
                      </div>
                      <label>数量</label>
                      <div className="generateOptionGrid">
                        {imageCountOptions.map((count) => <button key={count} className={imageCount === count ? "selected" : ""} type="button" onClick={() => setImageCount(count)}>{count} 张</button>)}
                      </div>
                      {modelOptionsError ? <div className="generateCapabilityError">模型目录读取失败：{modelOptionsError}</div> : null}
                      {imageConfigurationErrors.length ? <div className="generateCapabilityError">{imageConfigurationErrors[0]}</div> : null}
                    </div>
                  ) : (
                    <div className="generateOptionRows">
                      <label>生成模式</label>
                      <div className="generateOptionGrid generateModeGrid">
                        {(selectedVideoCapability?.modes || []).map((mode) => (
                          <button key={mode.id} className={videoSettings.mode === mode.id ? "selected" : ""} type="button" onClick={() => setVideoSettings((current) => ({ ...current, mode: mode.id,
                            duration: requiredVideoDuration(selectedVideoCapability?.id || "", mode.id) ?? current.duration }))}>
                            {mode.label}
                          </button>
                        ))}
                      </div>
                      <label>清晰度</label>
                      <div className="generateOptionGrid">
                        {(selectedVideoCapability?.resolutions || []).map((resolution) => (
                          <button key={resolution} className={videoSettings.resolution === resolution ? "selected" : ""} type="button" onClick={() => setVideoSettings((current) => ({ ...current, resolution }))}>
                            {resolution}
                          </button>
                        ))}
                      </div>
                      {(selectedVideoCapability?.outputFormats.length || 0) > 1 ? <>
                        <label>输出格式</label>
                        <div className="generateOptionGrid" role="group" aria-label="视频输出格式">
                          {selectedVideoCapability!.outputFormats.map((format) => <button key={format} type="button"
                            className={videoSettings.outputFormat === format ? "selected" : ""}
                            aria-pressed={videoSettings.outputFormat === format}
                            onClick={() => setVideoSettings((current) => ({ ...current, outputFormat: format }))}>
                            {format.toUpperCase()}
                          </button>)}
                        </div>
                      </> : null}
                      <label>单镜头时长</label>
                      {requiredVideoDuration(selectedVideoCapability?.id || "", videoSettings.mode) === -1
                        ? <small>时长跟随原片</small>
                        : selectedVideoCapability ? <VideoDurationControl
                        label="单镜头时长"
                        duration={selectedVideoCapability.duration}
                        value={videoSettings.duration}
                        onChange={(duration) => setVideoSettings((current) => ({ ...current, duration }))}
                      /> : null}
                      {activeMode === "视频生成" ? (
                        <>
                          <label htmlFor="generate-director-shot-count">分镜数量</label>
                          <div className="generateDurationControl">
                            <input
                              id="generate-director-shot-count"
                              aria-label="分镜数量"
                              type="number"
                              min={1}
                              max={20}
                              step={1}
                              value={directorShotCount}
                              placeholder="请填写"
                              onChange={(event) => setDirectorShotCount(event.target.value.replace(/\D/g, "").slice(0, 2))}
                            />
                            <small>将按所选单镜头时长计算方案总时长</small>
                          </div>
                        </>
                      ) : null}
                      <VideoAudioSwitch
                        checked={videoSettings.audio}
                        supported={Boolean(selectedVideoCapability?.supportsGenerateAudio)}
                        onChange={(audio) => setVideoSettings((current) => ({ ...current, audio }))}
                      />
                      {activeMode !== "Agent 模式" && videoInputSlots.length ? (
                        <>
                          <label>参考素材槽位</label>
                          <div className="generateInputSlots">
                            {videoInputSlots.map((slot) => {
                              const count = videoInputAllocation.counts[slot.id] || 0;
                              const missing = count < slot.min;
                              return (
                                <div key={slot.id} className={missing ? "missing" : "ready"}>
                                  <span>
                                    <strong>{slot.label}</strong>
                                    <small>{slot.accepts.map(videoAttachmentKindText).join(" / ")}</small>
                                  </span>
                                  <b>{count} / {slot.min}{slot.max !== slot.min ? `–${slot.max}` : ""}</b>
                                </div>
                              );
                            })}
                          </div>
                          <small className="generateSlotHint">参考素材会按上传顺序匹配槽位。</small>
                        </>
                      ) : null}
                      {visibleVideoConfigurationErrors.length ? <div className="generateCapabilityError">{visibleVideoConfigurationErrors[0]}</div> : null}
                    </div>
                  )}
                </div>
              ) : null}
              {activeMode === "Agent 模式" && activePanel === "subjects" ? (
                <div className="generatePopover subjects">
                  <span>可能 @ 的资产</span>
                  <ProjectAssetPickerStatus
                    as="small"
                    projectId={currentProjectId}
                    loading={assetsLoading}
                    errorMessage={assetsError?.message}
                    assetCount={subjectOptions.length}
                  />
                  {subjectOptions.map((subject) => (
                    <button
                      key={subject.id}
                      className={selectedSubjects.some((item) => item.id === subject.id) ? "selected" : ""}
                      type="button"
                      data-testid="agent-project-asset-option"
                      data-selected={selectedSubjects.some((item) => item.id === subject.id) ? "true" : "false"}
                      onClick={() => applySubject(subject)}
                    >
                      {subject.image ? (
                        <img src={subject.image} alt="" />
                      ) : (
                        <span className="generateSubjectMediaPlaceholder" aria-label="无预览图"><FolderOpen size={16} /></span>
                      )}
                      <span>
                        <strong>{subject.name}</strong>
                        <small>{subject.type}</small>
                      </span>
                    </button>
                  ))}
                  <button type="button" onClick={() => navigate("/workbench/corner-scape")}>创建资产</button>
                </div>
              ) : null}
            </div>

            {taskPollErrorText ? (
              <div
                role="status"
                data-testid="generate-task-poll-recovery"
                style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "10px 12px", border: "1px solid #fde68a", borderRadius: 10, background: "#fffbeb", color: "#92400e", fontSize: 13 }}
              >
                <span>{taskPollErrorText}</span>
                <button type="button" onClick={() => void refreshTasks()} style={{ flex: "0 0 auto", border: 0, background: "transparent", color: "#92400e", cursor: "pointer", fontWeight: 700 }}>
                  立即重试
                </button>
              </div>
            ) : null}

            {activeMode !== "Agent 模式" ? imageJob ? (
              <section className="generateResult generateImageRun">
                <div>
                  <span>今天</span>
                  <h2>{imageJob.prompt}</h2>
                  <p>{imageJob.model}{imageJob.ratio}{imageJob.quality}</p>
                </div>
                {imageJob.status === "running" ? (
                  <div className="generateProgressCard">
                    <Loader2 className="jimengSpin" size={18} />
                    <strong>{imageJob.statusText}</strong>
                    <small>0 / {imageJob.count} 生成中...</small>
                  </div>
                ) : null}
                {imageJob.status === "failed" ? (
                  <div className="generateProgressCard failed">
                    <strong>生成失败</strong>
                    <small>{imageJob.error || imageJob.statusText}</small>
                  </div>
                ) : null}
                {imageAssets.length ? (
                  <>
                    <div className="generateDoneMeta">
                      <strong>图片已生成</strong>
                      <small>结果已写入生成作品库，可在资产页的生成历史继续查看。</small>
                    </div>
                    <div className="generateImageGrid">
                      {imageAssets.map((asset) => (
                        <article key={asset.id}>
                          <img src={asset.url} alt={asset.prompt || imageJob.prompt} />
                          <strong>{asset.model || imageJob.model}</strong>
                          <p>{asset.prompt || imageJob.prompt}</p>
                        </article>
                      ))}
                    </div>
                  </>
                ) : null}
              </section>
            ) : plan ? (
              <section className="generateResult">
                <div>
                  <span>AGENT RESULT</span>
                  <h2>{plan.title}</h2>
                  <p>{plan.simpleScript}</p>
                  <div className="generateResultActions">
                    <button type="button" onClick={() => void submitVideoTasks()} disabled={isSubmittingVideo || hasPendingVideoReconcile}>
                      {isSubmittingVideo ? <Loader2 className="jimengSpin" size={16} /> : null}
                      {hasPendingVideoReconcile ? "待核中，请勿重复提交" : tasks.length ? "再次生成视频" : "生成视频"}
                    </button>
                    {materialized ? (
                      <button type="button" onClick={() => navigate("/workbench/project")}>
                        打开项目
                      </button>
                    ) : null}
                  </div>
                </div>
                <div className="generateShotGrid">
                  {plan.shots.map((shot, index) => (
                    <article key={`${shot.title}-${index}`}>
                      <div className="generateShotTextPreview" aria-label="分镜文本预览">
                        <FileText size={24} />
                        <small>分镜 {String(index + 1).padStart(2, "0")}</small>
                      </div>
                      <span>{String(index + 1).padStart(2, "0")}</span>
                      <strong>{shot.title || `镜头 ${index + 1}`}</strong>
                      <p>{shot.visual || shot.script || shot.prompt}</p>
                    </article>
                  ))}
                </div>
                {tasks.length ? (
                  <div className="generateTaskList">
                    {tasks.map((task) => (
                      <article key={`${task.trackId}-${task.videoId}`}>
                        <span>{taskStatusText(task.status)}</span>
                        <strong>{task.prompt || `镜头 ${task.trackId}`}</strong>
                        <div className="generateTaskActions">
                          {task.url ? <a href={task.url} target="_blank" rel="noreferrer">查看视频</a> : null}
                          {task.relayTaskId && task.status !== "pending_reconcile" && shouldPollTask(task.status) ? (
                            <button
                              type="button"
                              disabled={Boolean(cancellingVideoTaskId)}
                              onClick={() => void handleCancelVideoTask(task)}
                            >
                              {cancellingVideoTaskId === task.relayTaskId ? "取消中…" : "取消任务"}
                            </button>
                          ) : null}
                        </div>
                        {task.errorReason ? <small>{task.errorReason}</small> : null}
                      </article>
                    ))}
                  </div>
                ) : null}
              </section>
            ) : null : null}
          </section>
        </div>
      </section>
      {notice ? (
        <div className="jimengToast" role="status" aria-live="polite">
          <span>{notice}</span>
          <button type="button" aria-label="关闭提示" onClick={() => setNotice("")}><X size={15} /></button>
        </div>
      ) : null}
    </main>
  );
}
