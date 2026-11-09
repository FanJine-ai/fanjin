import { confirmPricingRetry } from "../../features/quick-create/confirmPricingRetry";
import { loadSourceReferenceFiles, sourceVideoSetup } from "../../features/showcase/sourceImport";
import { buildSourcePrompt, showcaseCases, type InspirationCase } from "../../features/showcase/catalog";
import { videoDurationLabel } from "../../features/quick-create/AutoVideoDurationButton";
import "./GuestWorkbench.css";
import InspirationShowcase from "../../features/showcase/InspirationShowcase";
import { appendCreativeBrief } from "../../features/showcase/catalog";
import { clearGuestDraft, readGuestDraft, type GuestDraft } from "../../features/auth/guestDraft";
import VideoAudioSwitch from "../../features/quick-create/VideoAudioSwitch";
import VideoDurationControl from "../../features/quick-create/VideoDurationControl";
import { normalizeDefaultVideoOutputFormat, normalizeVideoOutputFormats, requiredVideoDuration, requiredVideoRatio, videoOutputFormatRequestField, type VideoOutputFormat } from "../../features/quick-create/videoOutputContract";
import ReferenceRequirementsHint from "../../features/quick-create/ReferenceRequirementsHint";
import { referenceRequirementError } from "../../features/quick-create/referenceRequirements";
import { PORTRAIT_PREPARATION_PENDING, submitAfterPortraitPreparation } from "../../features/quick-create/portraitPreparation";
import { generationPreparationMessage } from "../../features/quick-create/generationPreparation";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowRight,
  ArrowUp,
  AtSign,
  Bot,
  Building2,
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  FileText,
  FolderOpen,
  Image,
  Images,
  Loader2,
  Mic,
  Music,
  Play,
  Plus,
  RefreshCw,
  Settings,
  Share2,
  SlidersHorizontal,
  Video,
  Volume2,
  WandSparkles,
  Wrench,
  X,
} from "lucide-react";
import {
  cancelQuickCreateTask,
  generateQuickCreateImageBatch,
  generateQuickCreateVideos,
  getInspirationWorkspaceState,
  listQuickCreateTasks,
  materializeDirectorPlan,
  type InspirationWorkspaceState,
  type QuickCreatePricingSubmissionOptions,
} from "../../features/quick-create/api";
import {
  QUICK_CREATE_CAPABILITIES,
  type QuickCreateCapabilitySnapshot,
} from "../../features/quick-create/capabilities";
import {
  useUploadQueueStore,
} from "../../features/quick-create/attachments/uploadQueue";
import { useSessionSync } from "../../features/quick-create/session/useSessionSync";
import {
  clearQuickCreateDraftOutbox,
  quickCreateDraftFingerprint,
  readQuickCreateDraftOutbox,
  writeQuickCreateDraftOutbox,
  type QuickCreateDraftPayload,
} from "../../features/quick-create/session/sessionDraftOutbox";
import { shouldPollTask } from "../../features/quick-create/status";
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
  type PollerState,
  type TaskPoller,
} from "../../features/quick-create/tasks/taskPoller";
import {
  bindStructuredTimelineAttachments,
  buildStructuredThirtySecondTimeline,
  normalizeStructuredThirtySecondTimeline,
  type StructuredThirtySecondTimeline,
  type TimelineAttachment,
} from "../../features/quick-create/structuredTimeline";
import { resolveQuickCreateImageModel } from "../../features/quick-create/modelAliases";
import {
  MAX_QUICK_CREATE_IMAGE_REFERENCES,
  resolveQuickCreateAttachmentLimit,
} from "../../features/quick-create/referenceLimits";
import {
  fetchQuickCreateModels,
  isImageModelAvailable,
  isVideoModelAvailable,
  normalizeVideoDuration,
  quickCreateVideoModeOptions,
  quickCreateVideoModePresentation,
  resolveQuickCreateVideoReferences,
  type QuickCreateVideoAttachmentKind,
  type QuickCreateImageModelOption,
  type QuickCreateLlmModelOption,
  type QuickCreateVideoModelOption,
  type QuickCreateVideoReferenceRole,
} from "../../features/quick-create/modelCatalog";
import type { AttachmentQueueItem } from "../../features/quick-create/attachments/uploadQueue.types";
import ReferencePreviewImage from "../../features/quick-create/attachments/ReferencePreviewImage";
import {
  ReferencePreviewAudio,
  ReferencePreviewVideo,
} from "../../features/quick-create/attachments/AuthenticatedReferenceMedia";
import type {
  QuickCreateDirectorPayload,
  QuickCreateDirectorPlan,
  QuickCreateImageQuality,
  QuickCreateImageAsset,
  QuickCreateMaterializedProject,
  QuickCreateRatio,
  QuickCreateSessionParameters,
  QuickCreateVideoTask,
} from "../../features/quick-create/types";
import doubaoLogo from "../../assets/public-placeholder.svg";
import futureCityPreview from "../../assets/public-placeholder.svg";
import jimengLogo from "../../assets/public-placeholder.svg";
import workbenchReference from "../../assets/public-placeholder.svg";
import { normalizeProjectId, useProjectStore } from "../../stores/projectStore";
import { useAuthStore } from "../../stores/authStore";
import { useAssetStore } from "../../stores/assetStore";
import {
  addAssetToProject,
  listAssetLibrary,
  listAssetRecommendations,
  type AssetLibraryItem,
  type AssetLibraryView,
  type AssetRecommendation,
} from "../../api/assets";
import { startQuickCreateAgent } from "./quickCreateAgent";
import { generateStorageScope } from "../generate/generateSubmissionRecovery";
import { listAgentSkills } from "../../features/agent-runtime/api";
import { agentSkillBillingLabel } from "../../features/agent-runtime/skillBilling";
import { buildProjectModeHref } from "../../routes/projectModeRoutes";
import { apiPost } from "../../api/http";
import PortraitAdmissionPanel from "../../features/portrait-admission/PortraitAdmissionPanel";
import { PortraitAdmissionIndicator, usePortraitAdmissionIndicators } from "../../features/portrait-admission/PortraitAdmissionIndicator";
import { useV4Theme } from "../../ui/useV4Theme";
import FrontstageNav from "../frontstage/FrontstageNav";
import {
  QUICK_CREATE_IMAGE_DEFAULT_COUNT,
  isQuickCreateAttachmentAllowed,
  quickCreateAttachmentAccept,
  quickCreateAttachmentRestrictionText,
  reconcileQuickCreateImageCatalogSelection,
  reconcileQuickCreateVideoCatalogSelection,
} from "./quickCreateCatalog";
import {
  buildRoutedImageGenerationSearch,
  isCreationSessionConflict,
  isDirectorPlan,
  isImageQuality,
  isMaterializedProject,
  isQuickCreateRatio,
  nullableSessionObjectParameter,
  quickCreateSessionKey,
  recoveredImageAssetsFromLibrary,
  restoredImageAssets,
  routedImageAssetIdentities as parseRoutedImageAssetIdentities,
  sessionDraftPayload,
} from "./quickCreateRecovery";
import {
  attachmentStateText,
  formatAttachmentSize,
  generationReferences,
  getTaskStatusText,
  normalizeQuickCreateError as normalizeError,
  toQuickCreateSubject,
  type QuickCreateSubject,
} from "./quickCreatePresentation";
import {
  buildQuickCreateVideoTrackData,
  quickCreateAttachmentKind,
} from "./quickCreateSubmission";
import {
  QuickCreateProjectRequestEpoch,
  type QuickCreateProjectRequestScope,
} from "./quickCreateRequestEpoch";
import VideoReferenceComposer, {
  type VideoReferenceAssignment,
  type VideoReferenceCapacity,
  type VideoReferencePickerRequest,
} from "./VideoReferenceComposer";
import AttachmentUploadProgress from "./AttachmentUploadProgress";
import {appendReferenceMentions, remapReferenceMentions} from "./referenceMentions";
import GenerationSessionView, {
  deriveVideoGenerationScreen,
  reconcileVideoGenerationScreen,
  resolveVideoGenerationProjectId,
  scopeVideoTasks,
  videoTaskIdentity,
  type InspirationGenerationScreen,
} from "./GenerationSessionView";
import "./QuickCreateView.css";

export {
  QUICK_CREATE_IMAGE_DEFAULT_COUNT,
  isQuickCreateAttachmentAllowed,
  quickCreateAttachmentAccept,
  quickCreateAttachmentRestrictionText,
  reconcileQuickCreateImageCatalogSelection,
  reconcileQuickCreateVideoCatalogSelection,
  QuickCreateProjectRequestEpoch,
};
export type { QuickCreateProjectRequestScope };

type PanelName = "mode" | "models" | "auto" | "skills" | "subjects" | "videoMode" | "generationSpecs" | "videoDuration";
type PreferenceTab = "图片" | "视频";
type ModelTab = "对话" | "图片" | "视频";
type QuickCreateSkill = {
  id: string;
  key: string;
  version: string;
  name: string;
  description: string;
  category: string;
  useCases: string[];
  input: string;
  output: string;
  limits: string[];
  example: string;
  publisher: string;
};

const GENERATION_SESSION_PREVIEW_ASSETS: QuickCreateImageAsset[] = [
  "oriental-future-city-01.png",
  "oriental-future-city-02.png",
  "oriental-future-city-03.png",
  "oriental-future-city-04.png",
].map((name, index) => ({
  id: `generation-session-preview-${index + 1}`,
  taskId: "generation-session-preview",
  url: `/assets/generation-session/${name}`,
  assetType: "image",
  model: "Seedream 5.0 Pro",
  prompt: "电影感的东方未来城市，雨后清晨",
  createdAt: Date.now(),
}));

function currentQuickCreateSearch() {
  if (typeof window === "undefined") return "";
  const hashSearchIndex = window.location.hash.indexOf("?");
  return hashSearchIndex >= 0
    ? window.location.hash.slice(hashSearchIndex + 1)
    : window.location.search.replace(/^\?/, "");
}

function currentQuickCreatePathname() {
  if (typeof window === "undefined") return "";
  const hashPath = window.location.hash
    .replace(/^#/, "")
    .split("?", 1)[0]
    ?.trim();
  return hashPath || window.location.pathname;
}

type ModelPlazaInitialSelection = {
  model: string;
  modelType: "llm" | "image" | "video";
  acceptedUnitMaximumCostMicros?: number;
};

export function readModelPlazaInitialSelection(search: string): ModelPlazaInitialSelection | null {
  const params = new URLSearchParams(search);
  if (params.get("source") !== "model-plaza") return null;
  const model = params.get("model")?.trim() || "";
  const modelType = params.get("modelType")?.trim() || "";
  if (!model || model.length > 200 || !["llm", "image", "video"].includes(modelType)) return null;
  const acceptedMaximum = Number(params.get("acceptedUnitMaximumCostMicros"));
  const acceptedUnitMaximumCostMicros = (
    modelType === "image" || modelType === "video"
  ) && Number.isSafeInteger(acceptedMaximum) && acceptedMaximum > 0
    ? acceptedMaximum
    : undefined;
  return {
    model,
    modelType: modelType as ModelPlazaInitialSelection["modelType"],
    ...(acceptedUnitMaximumCostMicros === undefined
      ? {}
      : { acceptedUnitMaximumCostMicros }),
  };
}

function modelPlazaPricingOptions(
  selection: ModelPlazaInitialSelection | null,
  modelType: "image" | "video",
  modelId: string,
): QuickCreatePricingSubmissionOptions | undefined {
  if (
    selection?.modelType !== modelType
    || selection.model !== modelId
    || selection.acceptedUnitMaximumCostMicros === undefined
  ) return undefined;
  return { acceptedUnitMaximumCostMicros: selection.acceptedUnitMaximumCostMicros };
}

type PendingQuickCreateSessionSave = {
  scope: string | null;
  projectId: number;
  sessionId: string;
  baseVersion: number;
  baseFingerprint: string;
  sessionKey: string;
  fingerprint: string;
  payload: QuickCreateDraftPayload;
};

export type QuickCreateRuntimeAvailability = {
  llm: boolean;
  image: boolean;
  video: boolean;
};

export function isQuickCreateEntryRuntimeAvailable(
  entry: string,
  availability: QuickCreateRuntimeAvailability,
) {
  if (entry === "图片生成") return availability.image;
  if (entry === "视频生成") return availability.video;
  if (entry === "Agent 模式") {
    return availability.llm;
  }
  return true;
}

const modeCards = [
  { title: "快速模式", description: "六阶段快速创作", image: workbenchReference, badge: "Beta", hidden: true },
  { title: "画布模式", description: "自由创作", image: futureCityPreview },
  { title: "图片生成", description: "智能美学提升", image: jimengLogo, badge: "New" },
  { title: "视频生成", description: "火山视频模型", image: doubaoLogo, badge: "New" },
];

const creationTypes = [
  { label: "Agent 模式", icon: WandSparkles },
  { label: "图片生成", icon: Image },
  { label: "视频生成", icon: Video },
  { label: "音乐生成", icon: Music },
  { label: "配音生成", icon: Volume2 },
  { label: "数字人", icon: Play },
  { label: "动作模仿", icon: Settings },
] as const;

type CreationTypeLabel = (typeof creationTypes)[number]["label"];
type CreationTypeCapabilityKey = keyof Pick<
  QuickCreateCapabilitySnapshot,
  "director" | "image" | "video" | "music" | "voice" | "avatar" | "motion"
>;

const creationTypeCapabilityKeys = {
  "Agent 模式": "director",
  图片生成: "image",
  视频生成: "video",
  音乐生成: "music",
  配音生成: "voice",
  数字人: "avatar",
  动作模仿: "motion",
} as const satisfies Record<CreationTypeLabel, CreationTypeCapabilityKey>;

const visibleCreationTypes = creationTypes.filter(
  (item) => QUICK_CREATE_CAPABILITIES[creationTypeCapabilityKeys[item.label]],
);

const ratioItems: Array<{ label: QuickCreateRatio; shape: string }> = [
  { label: "adaptive", shape: "square" },
  { label: "21:9", shape: "wide" },
  { label: "16:9", shape: "wide" },
  { label: "3:2", shape: "landscape" },
  { label: "4:3", shape: "landscape" },
  { label: "1:1", shape: "square" },
  { label: "3:4", shape: "portrait" },
  { label: "2:3", shape: "portrait" },
  { label: "9:16", shape: "phone" },
];

const generateModeParams: Record<string, string> = {
  音乐生成: "music",
  配音生成: "voice",
  数字人: "avatar",
  动作模仿: "motion",
};

function videoModelCapabilitySummary(model: QuickCreateVideoModelOption) {
  const modes = quickCreateVideoModeOptions(model).map((mode) => mode.label).join("、");
  const resolutions = model.resolutions.join("/");
  const duration = model.duration.min === model.duration.max
    ? `${model.duration.min} 秒`
    : `${model.duration.min}-${model.duration.max} 秒`;
  const referenceLimits = (["image", "video", "file"] as const).map((kind) => ({
    kind,
    max: Math.min(
      model.totalInputLimit,
      model.inputSlots
        .filter((slot) => slot.accepts.includes(kind))
        .reduce((total, slot) => total + slot.max, 0),
    ),
  })).filter((item) => item.max > 0);
  const referenceText = referenceLimits.length
    ? ` · 最多 ${model.totalInputLimit} 个参考（${referenceLimits.map((item) => `${item.kind === "image" ? "图片" : item.kind === "video" ? "视频" : "音频"} ${item.max}`).join(" / ")}）`
    : "";
  return `${modes || "未声明模式"} · ${resolutions} · ${duration} · ${model.supportsGenerateAudio ? "支持同步音频" : "不支持同步音频"}${referenceText}`;
}

function videoModePlaceholder(mode: string) {
  if (mode === "first_last_frame") return "描述首帧到尾帧之间的运动、镜头与画面变化";
  if (mode === "image_to_video") return "描述首帧之后的动作、运镜与氛围";
  if (mode === "image_reference" || mode === "reference_to_video") return "请添加智能多帧镜头，并描述镜头之间的运动";
  if (mode === "omni_reference") return "添加图片、视频或音频参考，并描述创作目标";
  if (mode === "video_edit") return "上传原视频，描述需要修改的内容";
  if (mode === "video_extension") return "上传待续写视频，描述接下来的画面";
  return "输入文字，描述想创作的画面内容、运动方式等";
}

function referenceKind(value: Pick<AttachmentQueueItem, "mimeType"> | Pick<File, "type">): QuickCreateVideoAttachmentKind {
  const mimeType = "mimeType" in value ? value.mimeType : value.type;
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  return "file";
}

function assignVideoReferencesForMode(input: {
  model: QuickCreateVideoModelOption;
  mode: string;
  attachments: AttachmentQueueItem[];
  previous?: Record<string, VideoReferenceAssignment>;
}): { ok: true; assignments: Record<string, VideoReferenceAssignment> } | { ok: false; message: string } {
  const slots = input.model.inputSlots.filter((slot) => !slot.modes.length || slot.modes.includes(input.mode));
  if (input.attachments.length > input.model.totalInputLimit) {
    return { ok: false, message: `当前模型最多接收 ${input.model.totalInputLimit} 个参考素材` };
  }
  if (input.attachments.length && !slots.length) {
    return { ok: false, message: "当前生成模式不接收参考素材" };
  }
  const counts = new Map(slots.map((slot) => [slot.id, 0]));
  const ordered = [...input.attachments].sort((left, right) => (
    (input.previous?.[left.clientId]?.order ?? input.attachments.indexOf(left))
    - (input.previous?.[right.clientId]?.order ?? input.attachments.indexOf(right))
  ));
  const assignments: Record<string, VideoReferenceAssignment> = {};
  for (let index = 0; index < ordered.length; index += 1) {
    const attachment = ordered[index];
    const kind = referenceKind(attachment);
    const forcedRole: QuickCreateVideoReferenceRole | undefined = input.mode === "first_last_frame"
      ? index === 0 ? "first_frame" : index === 1 ? "last_frame" : undefined
      : input.mode === "image_to_video"
        ? "first_frame"
        : input.previous?.[attachment.clientId]?.preferredRole;
    const previousSlotId = input.previous?.[attachment.clientId]?.slotId;
    const compatible = slots.filter((slot) => (
      slot.accepts.includes(kind)
      && (!forcedRole || slot.roles.includes(forcedRole))
      && Number(counts.get(slot.id) || 0) < slot.max
    ));
    const slot = compatible.find((candidate) => candidate.id === previousSlotId)
      || compatible[0];
    if (!slot) {
      return { ok: false, message: `「${attachment.name}」不符合当前模型的 ${quickCreateVideoModePresentation(input.mode).label} 输入要求` };
    }
    counts.set(slot.id, Number(counts.get(slot.id) || 0) + 1);
    const preferredRole = forcedRole && slot.roles.includes(forcedRole)
      ? forcedRole
      : input.previous?.[attachment.clientId]?.preferredRole;
    assignments[attachment.clientId] = {
      ...(preferredRole && slot.roles.includes(preferredRole) ? { preferredRole } : {}),
      slotId: slot.id,
      order: index,
    };
  }
  return { ok: true, assignments };
}

export default function QuickCreateView() {
  const navigate = useNavigate();
  const user = useAuthStore((state) => state.user);
  const currentWorkspace = useAuthStore((state) => state.currentWorkspace);
  const currentProjectId = useProjectStore((state) => state.currentProjectId);
  const clearProject = useProjectStore((state) => state.clearProject);
  const refreshAndSelectProject = useProjectStore((state) => state.refreshAndSelectProject);
  const projectAssets = useAssetStore((state) => state.assets);
  const projectAssetsLoading = useAssetStore((state) => state.loading);
  const projectAssetsError = useAssetStore((state) => state.error);
  const fetchProjectAssets = useAssetStore((state) => state.fetchAssets);
  const libraryAssets = useAssetStore((state) => state.libraryAssets);
  const libraryAssetsLoading = useAssetStore((state) => state.libraryLoading);
  const libraryAssetsError = useAssetStore((state) => state.libraryError);
  const fetchLibraryAssets = useAssetStore((state) => state.fetchLibraryAssets);
  const removeLibraryAssetFromProject = useAssetStore((state) => state.removeLibraryAssetFromProject);
  const shareLibraryAssetWithWorkspace = useAssetStore((state) => state.shareLibraryAssetWithWorkspace);
  const transferLibraryAssetToWorkspace = useAssetStore((state) => state.transferLibraryAssetToWorkspace);
  const theme = useV4Theme();
  const dark = theme.mode === "dark";

  // Session 持久化
  const standaloneInspirationRoute = currentQuickCreatePathname() === "/workbench/create";
  // 灵感页属于用户级创作入口。即使用户刚从快速模式或画布返回，持久化
  // Store 里仍保留上一个项目，也不能把本次素材静默写进那个项目。
  const numericProjectId = standaloneInspirationRoute
    ? null
    : normalizeProjectId(currentProjectId);
  useLayoutEffect(() => {
    if (standaloneInspirationRoute && normalizeProjectId(currentProjectId)) {
      clearProject();
    }
  }, [clearProject, currentProjectId, standaloneInspirationRoute]);
  const workspaceRole = String(
    (currentWorkspace as { memberRole?: string; role?: string } | null)?.memberRole
      || (currentWorkspace as { memberRole?: string; role?: string } | null)?.role
      || "member",
  );
  const canReceiveWorkspaceAsset = ["owner", "admin", "workspace_owner", "workspace_admin"]
    .includes(workspaceRole);
  const sessionDraftScope = user && currentWorkspace
    ? `${String(user.id || user.email)}:${String(currentWorkspace.id)}`
    : null;
  const [inspirationWorkspaceBootstrap, setInspirationWorkspaceBootstrap] = useState<{
    scope: string;
    loading: boolean;
    data: InspirationWorkspaceState;
  } | null>(null);
  const scopedInspirationWorkspace = inspirationWorkspaceBootstrap?.scope === sessionDraftScope
    ? inspirationWorkspaceBootstrap
    : null;
  const inspirationWorkspaceLoading = Boolean(
    !numericProjectId
    && sessionDraftScope
    && (!scopedInspirationWorkspace || scopedInspirationWorkspace.loading),
  );
  const inspirationWorkspaceProjectId = numericProjectId
    ? null
    : normalizeProjectId(scopedInspirationWorkspace?.data.projectId);
  const sessionProjectId = numericProjectId ?? inspirationWorkspaceProjectId;
  const sessionProjectIdRef = useRef<number | null>(sessionProjectId);
  sessionProjectIdRef.current = sessionProjectId;
  const {
    session,
    saveSession,
    sessionError,
    sessionLoading,
    clearSessionError,
  } = useSessionSync(sessionProjectId);
  const hydratedSessionKeyRef = useRef<string | null>(null);
  const [hydratedSessionKey, setHydratedSessionKey] = useState<string | null>(null);
  const persistedSessionPayloadRef = useRef<{ sessionKey: string; fingerprint: string } | null>(null);
  const sessionEditRequestedKeyRef = useRef<string | null>(null);
  const pendingSessionSaveRef = useRef<PendingQuickCreateSessionSave | null>(null);
  const inFlightSessionSaveRef = useRef<PendingQuickCreateSessionSave | null>(null);
  const [inFlightSessionSaveKey, setInFlightSessionSaveKey] = useState<string | null>(null);
  const sessionPayloadSnapshotRef = useRef<{
    fingerprint: string;
    payload: QuickCreateDraftPayload;
  } | null>(null);
  const flushPendingSessionSaveRef = useRef<(keepalive?: boolean) => Promise<void>>(async () => undefined);
  const carryDraftToProjectRef = useRef<number | null>(null);
  const projectRequestEpochRef = useRef(new QuickCreateProjectRequestEpoch());
  const handledModelPlazaSelectionRef = useRef("");

  const expectedSessionKey = session && sessionProjectId && session.projectId === sessionProjectId
    ? quickCreateSessionKey(sessionDraftScope, sessionProjectId, session.id)
    : null;
  const sessionHydrated = !inspirationWorkspaceLoading && (
    !sessionProjectId || Boolean(
      !sessionLoading
      && expectedSessionKey
      && hydratedSessionKey === expectedSessionKey
      && hydratedSessionKeyRef.current === expectedSessionKey
    )
  );

  const attachments = useUploadQueueStore((state) => state.items);
  const hasActiveUploads = useUploadQueueStore((state) => state.hasActiveUploads);
  const addAttachmentFiles = useUploadQueueStore((state) => state.addFiles);
  const startAttachmentUpload = useUploadQueueStore((state) => state.startUpload);
  const retryFailedAttachments = useUploadQueueStore((state) => state.retryFailed);
  const hydrateUploadedAttachments = useUploadQueueStore((state) => state.hydrateUploaded);
  const rebindLocalAttachments = useUploadQueueStore((state) => state.rebindLocalFiles);
  const clearAttachments = useUploadQueueStore((state) => state.clear);
  const attachmentProjectId = useUploadQueueStore((state) => state.boundProjectId);
  const removeAttachment = useUploadQueueStore((state) => state.remove);
  const pendingReferenceMentions = useRef(new Set<string>());
  const sourceImportBusyRef = useRef(false);
  const [sourceImportBusy, setSourceImportBusy] = useState(false);

  const [activeEntry, setActiveEntry] = useState("Agent 模式");
  const [activePanel, setActivePanel] = useState<PanelName | null>(null);
  const [modelTab, setModelTab] = useState<ModelTab>("对话");
  const [autoEnabled, setAutoEnabled] = useState(true);
  const [preferenceTab, setPreferenceTab] = useState<PreferenceTab>("图片");
  const [form, setForm] = useState<QuickCreateDirectorPayload>({
    brief: "",
    style: "高级、清晰、商业化、真实光影",
    targetType: "广告视频",
    ratio: "16:9",
    duration: 15,
    shotCount: 3,
  });
  const [pendingGuestDraft, setPendingGuestDraft] = useState<GuestDraft | null>(() => {
    const draft = readGuestDraft();
    return standaloneInspirationRoute && (draft?.brief.trim() || draft?.sourceCaseId) && draft.owner === String(user?.id) ? draft : null;
  });
  const [selectedRatio, setSelectedRatio] = useState<QuickCreateRatio>(form.ratio);
  const [llmModels, setLlmModels] = useState<QuickCreateLlmModelOption[]>([]);
  const [llmModel, setLlmModel] = useState("");
  const [imageModels, setImageModels] = useState<QuickCreateImageModelOption[]>([]);
  const [imageModel, setImageModel] = useState("");
  const [imageQuality, setImageQuality] = useState<QuickCreateImageQuality>("2K");
  const [imageCount, setImageCount] = useState(1);
  const [videoModels, setVideoModels] = useState<QuickCreateVideoModelOption[]>([]);
  const [modelCatalogLoading, setModelCatalogLoading] = useState(true);
  const [modelCatalogError, setModelCatalogError] = useState("");
  const [modelCatalogReloadKey, setModelCatalogReloadKey] = useState(0);
  const [skillCatalog, setSkillCatalog] = useState<QuickCreateSkill[]>([]);
  const [skillCatalogLoading, setSkillCatalogLoading] = useState(true);
  const [skillCatalogError, setSkillCatalogError] = useState("");
  const [skillCatalogReloadKey, setSkillCatalogReloadKey] = useState(0);
  const [skillQuery, setSkillQuery] = useState("");
  const [expandedSkillId, setExpandedSkillId] = useState("");
  const [subjectQuery, setSubjectQuery] = useState("");
  const [assetLibraryView, setAssetLibraryView] = useState<AssetLibraryView>(
    () => numericProjectId ? "project_refs" : "mine",
  );
  const [assetLibraryMutationId, setAssetLibraryMutationId] = useState<number | null>(null);
  const [assetRecommendations, setAssetRecommendations] = useState<AssetRecommendation[]>([]);
  const [assetRecommendationsLoading, setAssetRecommendationsLoading] = useState(false);
  const [assetRecommendationsError, setAssetRecommendationsError] = useState("");
  const { approvedAssetVersionIds, onApprovalChange } = usePortraitAdmissionIndicators(sessionProjectId);
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);
  const [selectedSubjectIds, setSelectedSubjectIds] = useState<string[]>([]);
  const [videoOptions, setVideoOptions] = useState({
    model: "",
    resolution: "",
    duration: 5,
    audio: false,
    mode: "",
    outputFormat: "mp4" as VideoOutputFormat,
  });
  const [videoReferenceAssignments, setVideoReferenceAssignments] = useState<Record<string, VideoReferenceAssignment>>({});
  const [plan, setPlan] = useState<QuickCreateDirectorPlan | null>(null);
  const [structuredTimeline, setStructuredTimeline] = useState<StructuredThirtySecondTimeline | null>(null);
  const [materialized, setMaterialized] = useState<QuickCreateMaterializedProject | null>(null);
  const [tasks, setTasks] = useState<QuickCreateVideoTask[]>([]);
  const [cancellingTaskId, setCancellingTaskId] = useState("");
  const [imageAssets, setImageAssets] = useState<QuickCreateImageAsset[]>([]);
  const [planning, setPlanning] = useState(false);
  const [materializing, setMaterializing] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [errorText, setErrorText] = useState("");
  const [sessionConflict, setSessionConflict] = useState<PendingQuickCreateSessionSave | null>(null);
  const [sessionConflictRetrying, setSessionConflictRetrying] = useState(false);
  const [sessionHydrationRevision, setSessionHydrationRevision] = useState(0);
  const [sessionEditRevision, setSessionEditRevision] = useState(0);
  const [notice, setNotice] = useState("");
  const [pollerState, setPollerState] = useState<PollerState>("idle");
  const [pollErrorText, setPollErrorText] = useState("");
  const generationSubmittingRef = useRef(false);
  const [generationScreen, setGenerationScreen] = useState<InspirationGenerationScreen | null>(null);
  const [routedImageRecovery, setRoutedImageRecovery] = useState<{
    key: string;
    phase: "idle" | "loading" | "success" | "failed";
    error: string;
    assets: QuickCreateImageAsset[];
  }>({ key: "", phase: "idle", error: "", assets: [] });
  const [continuingGenerationMode, setContinuingGenerationMode] = useState<"quick" | "canvas" | null>(null);
  const pollerRef = useRef<TaskPoller | null>(null);
  const pollerProjectIdRef = useRef<number | null>(null);
  const pollerDetachedRef = useRef(false);
  const materializedProjectRef = useRef<QuickCreateMaterializedProject | null>(null);
  const standaloneVideoRetryContextRef = useRef<{
    fingerprint: string;
    project: QuickCreateMaterializedProject;
  } | null>(null);
  const agentSubmissionAttemptRef = useRef<StableSubmissionAttempt | null>(null);
  const agentStartingRef = useRef(false);
  const materializeSubmissionAttemptRef = useRef<StableSubmissionAttempt | null>(null);
  const imageSubmissionAttemptRef = useRef<StableSubmissionAttempt | null>(null);
  const videoSubmissionAttemptRef = useRef<StableSubmissionAttempt | null>(null);
  const mountedRef = useRef(true);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const briefInputRef = useRef<HTMLTextAreaElement | null>(null);
  const videoReferencePickerRef = useRef<VideoReferencePickerRequest | null>(null);
  const hasComposerContent = Boolean(
    form.brief.length || attachments.length || selectedSkillIds.length
    || selectedSubjectIds.length || pendingGuestDraft,
  );

  const selectedVideoModel = useMemo(
    () => videoModels.find((model) => model.id === videoOptions.model) || null,
    [videoModels, videoOptions.model],
  );
  const selectedVideoOutputFormats = normalizeVideoOutputFormats(selectedVideoModel?.outputFormats);

  const videoModeOptions = useMemo(
    () => quickCreateVideoModeOptions(selectedVideoModel),
    [selectedVideoModel],
  );

  const selectedVideoModePresentation = useMemo(
    () => quickCreateVideoModePresentation(videoOptions.mode),
    [videoOptions.mode],
  );

  const selectedVideoModeSlots = useMemo(() => (
    selectedVideoModel?.inputSlots.filter((slot) => (
      !slot.modes.length || slot.modes.includes(videoOptions.mode)
    )) || []
  ), [selectedVideoModel, videoOptions.mode]);

  const selectedVideoModeInputLimit = useMemo(() => {
    if (!videoOptions.mode || videoOptions.mode === "text_to_video" || videoOptions.mode === "standard") return 0;
    const slotLimit = selectedVideoModeSlots.reduce((total, slot) => total + slot.max, 0);
    const catalogLimit = selectedVideoModel?.totalInputLimit || slotLimit;
    return Math.max(1, Math.min(slotLimit || catalogLimit || 1, catalogLimit || slotLimit || 1));
  }, [selectedVideoModeSlots, selectedVideoModel, videoOptions.mode]);

  const orderedVideoAttachments = useMemo(() => (
    [...attachments].sort((left, right) => (
      (videoReferenceAssignments[left.clientId]?.order ?? attachments.indexOf(left))
      - (videoReferenceAssignments[right.clientId]?.order ?? attachments.indexOf(right))
    ))
  ), [attachments, videoReferenceAssignments]);

  const selectedVideoReferenceCapacity = useMemo<VideoReferenceCapacity | undefined>(() => {
    if (!selectedVideoModel || videoOptions.mode !== "omni_reference") return undefined;
    const used = { image: 0, video: 0, file: 0 };
    orderedVideoAttachments.forEach((attachment) => {
      used[referenceKind(attachment)] += 1;
    });
    const maximum = (kind: QuickCreateVideoAttachmentKind) => Math.min(
      selectedVideoModeInputLimit,
      selectedVideoModeSlots
        .filter((slot) => slot.accepts.includes(kind))
        .reduce((total, slot) => total + slot.max, 0),
    );
    return {
      total: { used: orderedVideoAttachments.length, max: selectedVideoModeInputLimit },
      image: { used: used.image, max: maximum("image") },
      video: { used: used.video, max: maximum("video") },
      file: { used: used.file, max: maximum("file") },
    };
  }, [orderedVideoAttachments, selectedVideoModeInputLimit, selectedVideoModeSlots, selectedVideoModel, videoOptions.mode]);

  const hasPendingVideoReconcile = useMemo(
    () => hasPendingReconcileSubmission(tasks),
    [tasks],
  );

  const selectedLlmModel = useMemo(
    () => llmModels.find((model) => model.id === llmModel) || null,
    [llmModel, llmModels],
  );

  const selectedImageModel = useMemo(
    () => imageModels.find((model) => model.id === imageModel) || null,
    [imageModel, imageModels],
  );

  const generationRouteSearch = currentQuickCreateSearch();
  const generationRouteParams = useMemo(
    () => new URLSearchParams(generationRouteSearch),
    [generationRouteSearch],
  );
  const modelPlazaInitialSelection = useMemo(
    () => readModelPlazaInitialSelection(generationRouteSearch),
    [generationRouteSearch],
  );
  const previewGenerationSession = import.meta.env.DEV
    && generationRouteParams.get("preview") === "generation-session";
  const routedGenerationKind = generationRouteParams.get("generation");
  const routedImageIdentities = useMemo(
    () => parseRoutedImageAssetIdentities(generationRouteParams),
    [generationRouteParams],
  );
  const routedImageIdentityKey = routedImageIdentities
    .map(({ assetId, assetVersionId }) => `${assetId}:${assetVersionId}`)
    .join(",");
  const routedImageRecoveryKey = `${sessionDraftScope || "unscoped"}|${routedImageIdentityKey}`;
  const routedImageModel = generationRouteParams.get("model")?.trim() || "";
  const routedImageRatio = isQuickCreateRatio(generationRouteParams.get("ratio"))
    ? generationRouteParams.get("ratio") as QuickCreateRatio
    : null;
  const routedImageQuality = isImageQuality(generationRouteParams.get("quality"))
    ? generationRouteParams.get("quality") as QuickCreateImageQuality
    : null;
  const routedVideoTaskIds = useMemo(
    () => generationRouteParams.getAll("task").filter(Boolean),
    [generationRouteParams],
  );
  const routedVideoProjectId = resolveVideoGenerationProjectId(
    generationRouteParams.get("generationProject"),
    routedVideoTaskIds,
  );
  const recoveringRoutedVideo = routedGenerationKind === "video" && Boolean(routedVideoProjectId);
  const generationVideoTaskIds = generationScreen?.kind === "video"
    ? generationScreen.taskIds
    : routedVideoTaskIds;
  const displayedVideoTasks = useMemo(
    () => scopeVideoTasks(tasks, generationVideoTaskIds),
    [generationVideoTaskIds, tasks],
  );
  const displayedImageAssets = previewGenerationSession
    ? GENERATION_SESSION_PREVIEW_ASSETS
    : routedGenerationKind === "image"
      && routedImageRecovery.key === routedImageRecoveryKey
      && routedImageRecovery.phase === "success"
      ? routedImageRecovery.assets
      : routedGenerationKind === "image"
        ? []
        : imageAssets;
  const recoveredGenerationScreen = useMemo<InspirationGenerationScreen | null>(() => {
    if (previewGenerationSession) {
      return { kind: "image", phase: "result", statusText: "已生成 4 张图片" };
    }
    if (routedGenerationKind === "image") {
      if (displayedImageAssets.length) {
        return { kind: "image", phase: "result", statusText: `已恢复 ${displayedImageAssets.length} 张图片` };
      }
      if (routedImageRecovery.key === routedImageRecoveryKey && routedImageRecovery.phase === "failed") {
        return {
          kind: "image",
          phase: "failed",
          statusText: "图片结果恢复失败",
          error: routedImageRecovery.error,
        };
      }
      if (routedImageIdentities.length) {
        return { kind: "image", phase: "waiting", statusText: "正在恢复已生成图片" };
      }
      return {
        kind: "image",
        phase: "failed",
        statusText: "图片结果链接不完整",
        error: "此链接没有可恢复的资产身份，请从资产库重新打开结果。",
      };
    }
    if (routedGenerationKind !== "video") return null;
    const next = deriveVideoGenerationScreen(displayedVideoTasks);
    return next ? { ...next, taskIds: routedVideoTaskIds } : null;
  }, [
    displayedImageAssets,
    displayedVideoTasks,
    previewGenerationSession,
    routedGenerationKind,
    routedImageIdentities,
    routedImageRecoveryKey,
    routedImageRecovery,
    routedVideoTaskIds,
  ]);
  const activeGenerationScreen = routedGenerationKind === "image"
    ? recoveredGenerationScreen
    : generationScreen || recoveredGenerationScreen;

  useEffect(() => {
    if (previewGenerationSession || routedGenerationKind !== "image") return;
    setGenerationScreen(null);
    if (!routedImageIdentities.length) {
      setRoutedImageRecovery({
        key: routedImageRecoveryKey,
        phase: "failed",
        error: "此链接没有可恢复的资产身份，请从资产库重新打开结果。",
        assets: [],
      });
      return;
    }
    if (!sessionDraftScope) {
      setRoutedImageRecovery({
        key: routedImageRecoveryKey,
        phase: "loading",
        error: "",
        assets: [],
      });
      return;
    }

    let active = true;
    const controller = new AbortController();
    setRoutedImageRecovery({
      key: routedImageRecoveryKey,
      phase: "loading",
      error: "",
      assets: [],
    });
    void listAssetLibrary({
      view: "all",
      assetVersions: routedImageIdentities,
      type: "image",
      limit: routedImageIdentities.length,
    }, { signal: controller.signal }).then((result) => {
      if (!active || controller.signal.aborted) return;
      const recovered = recoveredImageAssetsFromLibrary(
        result.items,
        routedImageIdentities,
        routedImageModel,
      );
      setRoutedImageRecovery({
        key: routedImageRecoveryKey,
        phase: "success",
        error: "",
        assets: recovered,
      });
    }).catch((error) => {
      if (!active || controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
      setRoutedImageRecovery({
        key: routedImageRecoveryKey,
        phase: "failed",
        error: normalizeError(error) || "无法从资产库恢复图片结果，请稍后重试。",
        assets: [],
      });
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [
    previewGenerationSession,
    routedGenerationKind,
    routedImageIdentities,
    routedImageRecoveryKey,
    routedImageModel,
    sessionDraftScope,
  ]);

  useEffect(() => {
    if (numericProjectId || !sessionDraftScope) return;
    const scope = sessionDraftScope;
    let active = true;
    setInspirationWorkspaceBootstrap((current) => ({
      scope,
      loading: true,
      data: current?.scope === scope
        ? current.data
        : { projectId: null, references: [] },
    }));
    void getInspirationWorkspaceState()
      .then((data) => {
        if (!active) return;
        setInspirationWorkspaceBootstrap({ scope, loading: false, data });
      })
      .catch((error) => {
        console.error("Inspiration workspace recovery failed", error);
        if (!active) return;
        setInspirationWorkspaceBootstrap((current) => ({
          scope,
          loading: false,
          data: current?.scope === scope
            ? current.data
            : { projectId: null, references: [] },
        }));
      });
    return () => {
      active = false;
    };
  }, [numericProjectId, sessionDraftScope]);

  useEffect(() => {
    if (
      routedGenerationKind !== "video"
      || !displayedVideoTasks.length
      || !generationVideoTaskIds?.length
    ) return;
    setGenerationScreen((current) => reconcileVideoGenerationScreen(
      current,
      routedGenerationKind,
      displayedVideoTasks,
    ));
  }, [displayedVideoTasks, generationVideoTaskIds, routedGenerationKind]);

  useEffect(() => {
    if (
      routedGenerationKind !== "video"
      || !routedVideoTaskIds.length
      || !routedVideoProjectId
    ) return;

    const poller = startTaskPoller(routedVideoProjectId, true);
    void poller.refresh().catch((error) => {
      console.error("Inspiration generation route recovery failed", error);
    });
    return () => {
      if (
        pollerRef.current === poller
        && pollerProjectIdRef.current === routedVideoProjectId
        && pollerDetachedRef.current
      ) {
        stopTaskPoller();
      }
    };
  }, [routedGenerationKind, routedVideoProjectId, routedVideoTaskIds]);

  const selectedSkills = useMemo(
    () => skillCatalog.filter((skill) => selectedSkillIds.includes(skill.id)),
    [selectedSkillIds, skillCatalog],
  );

  const subjectOptions = useMemo(
    () => (numericProjectId ? projectAssets : libraryAssets)
      .filter((asset) => Number.isSafeInteger(Number(asset.id)) && Number(asset.id) > 0)
      .map(toQuickCreateSubject),
    [libraryAssets, numericProjectId, projectAssets],
  );

  const selectedSubjects = useMemo(
    () => subjectOptions.filter((subject) => selectedSubjectIds.includes(subject.id)),
    [selectedSubjectIds, subjectOptions],
  );

  useEffect(() => {
    if (
      activeEntry !== "视频生成"
      || !sessionHydrated
      || !sessionProjectId
      || attachmentProjectId !== sessionProjectId
      || !selectedVideoModel
    ) return;
    const references = selectedSubjects.flatMap((subject) => (
      subject.assetVersionId && subject.mediaType && subject.image
        ? [{
            assetId: subject.numericId,
            assetVersionId: subject.assetVersionId,
            filePath: subject.image,
            previewUrl: subject.image,
            type: subject.mediaType,
            mimeType: subject.mediaType === "video" ? "video/mp4" : "image/jpeg",
            size: 0,
            name: subject.name,
          }]
        : []
    ));
    if (!references.length) return;
    hydrateUploadedAttachments(sessionProjectId, references);
    const resolved = assignVideoReferencesForMode({
      model: selectedVideoModel,
      mode: videoOptions.mode,
      attachments: useUploadQueueStore.getState().items,
      previous: videoReferenceAssignments,
    });
    if (resolved.ok) setVideoReferenceAssignments(resolved.assignments);
  // Selected assets are restored independently from the upload queue after refresh.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeEntry,
    attachmentProjectId,
    selectedSubjects,
    selectedVideoModel,
    sessionHydrated,
    sessionProjectId,
    videoOptions.mode,
  ]);

  const visibleSkills = useMemo(() => {
    const query = skillQuery.trim().toLocaleLowerCase("zh-CN");
    if (!query) return skillCatalog;
    return skillCatalog.filter((skill) => (
      `${skill.name} ${skill.description} ${skill.category} ${skill.useCases.join(" ")} ${skill.key}`.toLocaleLowerCase("zh-CN").includes(query)
    ));
  }, [skillCatalog, skillQuery]);

  const visibleSubjects = useMemo(() => {
    const query = subjectQuery.trim().toLocaleLowerCase("zh-CN");
    if (!query) return subjectOptions;
    return subjectOptions.filter((subject) => (
      `${subject.name} ${subject.type} ${subject.description}`.toLocaleLowerCase("zh-CN").includes(query)
    ));
  }, [subjectOptions, subjectQuery]);

  const visibleLibrarySubjects = useMemo(() => {
    const query = subjectQuery.trim().toLocaleLowerCase("zh-CN");
    return libraryAssets
      .filter((asset) => !query || `${asset.name} ${asset.type} ${asset.describe || ""} ${asset.prompt || ""}`
        .toLocaleLowerCase("zh-CN").includes(query));
  }, [libraryAssets, subjectQuery]);

  const attachmentRetryProjectId = attachmentProjectId
    ?? materialized?.project.id
    ?? sessionProjectId;

  const runtimeAvailability = useMemo<QuickCreateRuntimeAvailability>(() => ({
    llm: llmModels.length > 0,
    image: imageModels.some(isImageModelAvailable),
    video: videoModels.some(isVideoModelAvailable),
  }), [imageModels, llmModels.length, videoModels]);

  const runtimeCreationTypes = useMemo(
    () => visibleCreationTypes.filter((item) => {
      if (modelCatalogLoading) return false;
      return isQuickCreateEntryRuntimeAvailable(item.label, runtimeAvailability);
    }),
    [modelCatalogLoading, runtimeAvailability],
  );

  const runtimeModeCards = useMemo(
    () => modeCards.filter((card) => {
      if (card.hidden) return false;
      if (modelCatalogLoading) return card.title === "画布模式";
      if (card.title === "快速模式") {
        return runtimeAvailability.llm && runtimeAvailability.image && runtimeAvailability.video;
      }
      if (card.title === "图片生成" || card.title === "视频生成") {
        return isQuickCreateEntryRuntimeAvailable(card.title, runtimeAvailability);
      }
      return true;
    }),
    [modelCatalogLoading, runtimeAvailability],
  );
  const activeEntryAvailable = !modelCatalogLoading
    && runtimeCreationTypes.some((item) => item.label === activeEntry);

  const visibleRatioItems = useMemo(() => {
    const ratios = preferenceTab === "视频"
      ? selectedVideoModel?.aspectRatios
      : selectedImageModel?.aspectRatios;
    const required = preferenceTab === "视频" && selectedVideoModel
      ? requiredVideoRatio(selectedVideoModel.id, videoOptions.mode) : null;
    return ratios?.length
      ? ratioItems.filter((item) => ratios.includes(item.label) && (!required || item.label === required))
      : [];
  }, [preferenceTab, selectedImageModel, selectedVideoModel, videoOptions.mode]);

  const videoTimelineDuration = videoOptions.duration === -1 ? (selectedVideoModel?.duration.max ?? 15) : videoOptions.duration;

  useEffect(() => {
    let active = true;
    setModelCatalogLoading(true);
    void fetchQuickCreateModels()
      .then(({ llmModels: nextLlmModels, imageModels: nextImageModels, videoModels: nextVideoModels }) => {
        if (!active) return;
        setLlmModels(nextLlmModels);
        setImageModels(nextImageModels);
        setVideoModels(nextVideoModels);
        setModelCatalogError("");
        setLlmModel((current) => (
          nextLlmModels.some((model) => model.id === current) ? current : nextLlmModels[0]?.id || ""
        ));
        const nextImageSelection = reconcileQuickCreateImageCatalogSelection(nextImageModels, {
          model: imageModel,
          quality: imageQuality,
        });
        setImageModel(nextImageSelection.model);
        setImageQuality(nextImageSelection.quality);
        setVideoOptions((current) => (
          reconcileQuickCreateVideoCatalogSelection(nextVideoModels, current)
        ));
      })
      .catch((error) => {
        if (!active) return;
        setModelCatalogError(normalizeError(error));
      })
      .finally(() => {
        if (active) setModelCatalogLoading(false);
      });
    return () => {
      active = false;
    };
  }, [modelCatalogReloadKey]);

  useEffect(() => {
    let active = true;
    setSkillCatalogLoading(true);
    void listAgentSkills()
      .then((result) => {
        if (!active) return;
        const nextSkills = (Array.isArray(result?.skills) ? result.skills : [])
          .filter((skill) => skill.key?.trim() && skill.version?.trim() && skill.displayName?.trim())
          .map((skill): QuickCreateSkill => ({
            id: `${skill.key}@${skill.version}`,
            key: skill.key,
            version: skill.version,
            name: skill.displayName,
            description: `${skill.description || skill.summary || (skill.roles?.length
              ? `Agent Runtime · ${skill.roles.join(" / ")}`
              : "Agent Runtime 官方技能")} · ${agentSkillBillingLabel(skill.billingPolicy)}`,
            category: skill.category || "官方技能",
            useCases: [...(skill.useCases || [])],
            input: skill.input || "当前创作说明与已选项目资产。",
            output: skill.output || "由 Agent Runtime 根据当前任务返回结果。",
            limits: [...(skill.limits || ["运行仍受当前权限、模型与工具可用性门禁约束"])],
            example: skill.example || "在当前创作中选择并运行此技能。",
            publisher: skill.source === "jimeng" ? "即梦迁移" : skill.publisher || "Fanjin 官方",
          }));
        setSkillCatalog(nextSkills);
        setSkillCatalogError("");
        const allowed = new Set(nextSkills.map((skill) => skill.id));
        setSelectedSkillIds((current) => current.filter((id) => allowed.has(id)));
      })
      .catch((error) => {
        if (!active) return;
        setSkillCatalog([]);
        setSelectedSkillIds([]);
        setSkillCatalogError(normalizeError(error));
      })
      .finally(() => {
        if (active) setSkillCatalogLoading(false);
      });
    return () => {
      active = false;
    };
  }, [skillCatalogReloadKey]);

  useEffect(() => {
    if (!numericProjectId) return;
    void fetchProjectAssets({ limit: 80 });
  }, [fetchProjectAssets, numericProjectId]);

  useEffect(() => {
    if (activePanel !== "subjects") return;
    if (!numericProjectId && assetLibraryView === "project_refs") {
      setAssetLibraryView("mine");
      return;
    }
    void fetchLibraryAssets({ view: assetLibraryView, limit: 100 });
  }, [activePanel, assetLibraryView, fetchLibraryAssets, numericProjectId]);

  useEffect(() => {
    if (!numericProjectId || projectAssetsLoading) return;
    const allowed = new Set(subjectOptions.map((subject) => subject.id));
    setSelectedSubjectIds((current) => current.filter((id) => allowed.has(id)));
  }, [numericProjectId, projectAssetsLoading, subjectOptions]);

  // Session drafts may contain model ids or parameter values that are no
  // longer authorized by the current workspace catalog. Reconcile every
  // restored value back to an exact, server-returned model before it can
  // drive a paid submission.
  useEffect(() => {
    if (modelCatalogLoading) return;
    setLlmModel((current) => (
      llmModels.some((model) => model.id === current)
        ? current
        : llmModels[0]?.id || ""
    ));
    const nextImageSelection = reconcileQuickCreateImageCatalogSelection(imageModels, {
      model: imageModel,
      quality: imageQuality,
    });
    if (nextImageSelection.model !== imageModel) setImageModel(nextImageSelection.model);
    if (nextImageSelection.quality !== imageQuality) setImageQuality(nextImageSelection.quality);
    setVideoOptions((current) => {
      const next = reconcileQuickCreateVideoCatalogSelection(videoModels, current);
      return current.model === next.model
        && current.resolution === next.resolution
        && current.duration === next.duration
        && current.audio === next.audio
        && current.mode === next.mode
        && current.outputFormat === next.outputFormat
        ? current
        : next;
    });
  }, [
    imageModel,
    imageModels,
    imageQuality,
    llmModels,
    modelCatalogLoading,
    videoOptions.audio,
    videoOptions.duration,
    videoOptions.model,
    videoOptions.mode,
    videoOptions.resolution,
    videoOptions.outputFormat,
    videoModels,
  ]);

  useEffect(() => {
    const maxOutputs = selectedImageModel?.maxOutputs ?? 1;
    setImageCount((current) => Math.max(1, Math.min(current, maxOutputs)));
  }, [selectedImageModel]);

  useEffect(() => {
    if (modelCatalogLoading || activeEntryAvailable) return;
    const fallback = runtimeCreationTypes[0]?.label;
    if (!fallback) {
      setActivePanel(null);
      setErrorText(modelCatalogError
        ? `模型目录读取失败：${modelCatalogError}`
        : "当前工作区没有可用的对话、图片或视频模型");
      return;
    }
    setActiveEntry(fallback);
    setActivePanel(null);
    setModelTab(fallback === "图片生成" ? "图片" : fallback === "视频生成" ? "视频" : "对话");
    setPreferenceTab(fallback === "图片生成" ? "图片" : "视频");
    setForm((current) => ({
      ...current,
      targetType: fallback === "图片生成"
        ? "图片生成"
        : fallback === "视频生成"
          ? "视频生成"
          : "广告视频",
    }));
    setErrorText(`原创作类型当前不可执行，已切换到${fallback}`);
  }, [
    activeEntryAvailable,
    modelCatalogError,
    modelCatalogLoading,
    runtimeCreationTypes,
  ]);

  useEffect(() => {
    if (hasActiveUploads) return;
    attachments
      .filter((attachment) => !isQuickCreateAttachmentAllowed(activeEntry, attachment))
      .forEach((attachment) => removeAttachment(attachment.clientId));
  }, [activeEntry, attachments, hasActiveUploads, removeAttachment]);

  useEffect(() => {
    const activeIds = new Set(attachments.map((attachment) => attachment.clientId));
    setVideoReferenceAssignments((current) => {
      const next = Object.fromEntries(
        Object.entries(current).filter(([clientId]) => activeIds.has(clientId)),
      );
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
  }, [attachments]);

  useEffect(() => {
    const model = preferenceTab === "视频" ? selectedVideoModel : selectedImageModel;
    if (!model) return;
    const required = preferenceTab === "视频" && selectedVideoModel
      ? requiredVideoRatio(selectedVideoModel.id, videoOptions.mode) : null;
    const next = required && model.aspectRatios.includes(required) ? required : model.defaultAspectRatio;
    if (selectedRatio === next || (!required && model.aspectRatios.includes(selectedRatio))) return;
    setSelectedRatio(next);
    setForm((current) => ({ ...current, ratio: next }));
  }, [preferenceTab, selectedImageModel, selectedRatio, selectedVideoModel, videoOptions.mode]);

  useLayoutEffect(() => {
    mountedRef.current = true;
    const unsubscribeProject = useProjectStore.subscribe((state, previous) => {
      if (normalizeProjectId(state.currentProjectId) !== normalizeProjectId(previous.currentProjectId)) {
        projectRequestEpochRef.current.projectChanged();
      }
    });
    const handleVisibilityChange = () => {
      void pollerRef.current?.setVisible(document.visibilityState === "visible").catch((error) => {
        console.error("Quick Create task poller visibility callback failed", error);
      });
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      void flushPendingSessionSaveRef.current(true);
      mountedRef.current = false;
      projectRequestEpochRef.current.invalidateRequest();
      hydratedSessionKeyRef.current = null;
      persistedSessionPayloadRef.current = null;
      sessionEditRequestedKeyRef.current = null;
      materializedProjectRef.current = null;
      standaloneVideoRetryContextRef.current = null;
      unsubscribeProject();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      pollerRef.current?.stop();
      pollerRef.current = null;
      pollerProjectIdRef.current = null;
      pollerDetachedRef.current = false;
      // 上传队列不是用户作用域 Store。离开页面（尤其登出/换账号）时
      // 必须清掉本地 File 与 blob URL；已上传项会由项目 Session 恢复。
      useUploadQueueStore.getState().clear();
    };
  }, []);

  const selectedAttachmentProjectRef = useRef<number | null | undefined>(undefined);

  // 外部项目切换必须隔离附件；Materialize 自己创建并切换项目时由提交链路显式迁移本地 File。
  useEffect(() => {
    const previousProjectId = selectedAttachmentProjectRef.current;
    selectedAttachmentProjectRef.current = sessionProjectId;
    const queue = useUploadQueueStore.getState();
    const projectChanged = previousProjectId !== undefined && previousProjectId !== sessionProjectId;

    if (!sessionProjectId) {
      carryDraftToProjectRef.current = null;
      if (projectChanged && !recoveringRoutedVideo) {
        resetGeneratedState();
        setErrorText("");
      }
      if (queue.items.length || queue.boundProjectId !== null) clearAttachments();
      return;
    }

    if (previousProjectId === undefined) {
      if (queue.boundProjectId !== null && queue.boundProjectId !== sessionProjectId) {
        clearAttachments();
      }
      return;
    }
    if (previousProjectId === sessionProjectId) return;
    if (carryDraftToProjectRef.current === sessionProjectId) return;

    carryDraftToProjectRef.current = null;
    if (!recoveringRoutedVideo) {
      resetGeneratedState();
      setErrorText("");
    }
    if (queue.items.length || queue.boundProjectId !== null) clearAttachments();
  }, [clearAttachments, recoveringRoutedVideo, sessionProjectId]);

  async function restoreGuestDraft() {
    if (!pendingGuestDraft || !sessionHydrated) return;
    if (pendingGuestDraft.sourceCaseId) {
      const item = showcaseCases.find(item => item.id === pendingGuestDraft.sourceCaseId);
      if (item?.original) {
        try { await importSourceCase(item, pendingGuestDraft.sourceIdea || "", pendingGuestDraft.brief); }
        catch (error) { setErrorText(normalizeError(error)); return; }
        clearGuestDraft(); setPendingGuestDraft(null); return;
      }
    }
    markSessionEdited();
    setForm((current) => ({ ...current, brief: pendingGuestDraft.brief }));
    if (runtimeCreationTypes.some((item) => item.label === pendingGuestDraft.mode)) setActiveEntry(pendingGuestDraft.mode);
    clearGuestDraft();
    setPendingGuestDraft(null);
  }

  useEffect(() => {
    if (!pendingGuestDraft || pendingGuestDraft.sourceCaseId || !sessionHydrated || modelCatalogLoading || form.brief.trim()) return;
    restoreGuestDraft();
  }, [pendingGuestDraft, sessionHydrated, modelCatalogLoading, form.brief]);

  // ── Session 持久化：只按 project/session 身份恢复一次，版本更新不会反复覆盖 UI ──
  useEffect(() => {
    if (!session || !sessionProjectId || session.projectId !== sessionProjectId) return;
    const sessionKey = quickCreateSessionKey(sessionDraftScope, sessionProjectId, session.id);
    if (hydratedSessionKeyRef.current === sessionKey) return;
    if (pendingSessionSaveRef.current?.sessionKey !== sessionKey) {
      // The previous session's durable outbox is intentionally retained, but
      // its in-memory payload must never be offered to the new session store.
      pendingSessionSaveRef.current = null;
    }

    const carryingMaterializedDraft = carryDraftToProjectRef.current === sessionProjectId;
    const serverPayload = sessionDraftPayload(session);
    const serverFingerprint = quickCreateDraftFingerprint(serverPayload);
    const storedOutbox = carryingMaterializedDraft || !sessionDraftScope
      ? null
      : readQuickCreateDraftOutbox(sessionDraftScope, sessionProjectId, session.id);
    const outboxAlreadyApplied = storedOutbox?.fingerprint === serverFingerprint;
    if (outboxAlreadyApplied && sessionDraftScope) {
      clearQuickCreateDraftOutbox(sessionDraftScope, sessionProjectId, session.id, {
        fingerprint: storedOutbox.fingerprint,
      });
    }
    const recoveredOutbox = outboxAlreadyApplied ? null : storedOutbox;
    const recoveredPayload = recoveredOutbox?.payload ?? null;
    const params = (recoveredPayload?.parameters ?? session.parameters ?? {}) as Partial<QuickCreateSessionParameters> & Record<string, unknown>;
    const restoredGoal = recoveredPayload?.goal ?? session.goal;
    const restoredAssetVersionIds = recoveredPayload?.selectedAssetVersionIds
      ?? session.selectedAssetVersionIds;
    const hasExplicitUploadedAttachments = Array.isArray(params.uploadedAttachments);
    const recoveredUploadedAttachments = hasExplicitUploadedAttachments
      ? params.uploadedAttachments!
      : !numericProjectId && inspirationWorkspaceProjectId === sessionProjectId
        ? scopedInspirationWorkspace?.data.references ?? []
        : [];
    // refreshAndSelectProject 可能先触发渲染；等显式 rebind 完成后再 hydrate，避免误清本地附件。
    if (carryingMaterializedDraft && attachmentProjectId !== sessionProjectId) return;

    if (!carryingMaterializedDraft && !recoveringRoutedVideo) resetGeneratedState();
    hydratedSessionKeyRef.current = sessionKey;
    const recoveredDraftConflictsWithServer = Boolean(
      recoveredOutbox
      && (
        session.version !== recoveredOutbox.baseVersion
        || serverFingerprint !== recoveredOutbox.baseFingerprint
      ),
    );
    persistedSessionPayloadRef.current = recoveredOutbox
      ? {
          sessionKey,
          fingerprint: recoveredDraftConflictsWithServer
            ? recoveredOutbox.fingerprint
            : serverFingerprint,
        }
      : null;
    sessionEditRequestedKeyRef.current = recoveredOutbox && !recoveredDraftConflictsWithServer
      ? sessionKey
      : null;
    if (recoveredOutbox && recoveredDraftConflictsWithServer) {
      setSessionConflict({
        scope: sessionDraftScope,
        projectId: sessionProjectId,
        sessionId: session.id,
        baseVersion: recoveredOutbox.baseVersion,
        baseFingerprint: recoveredOutbox.baseFingerprint,
        sessionKey,
        fingerprint: recoveredOutbox.fingerprint,
        payload: recoveredOutbox.payload,
      });
      setErrorText("检测到刷新前未保存草稿，但远端已被其他标签页更新。请保留本页重试，或载入远端版本。");
    } else {
      setSessionConflict(null);
    }
    const hasPersistedDraft = Boolean(
      restoredGoal
      || Object.keys(params).length
      || restoredAssetVersionIds.length
      || recoveredUploadedAttachments.length
    );
    if (carryingMaterializedDraft) {
      const carriedSnapshot = sessionPayloadSnapshotRef.current;
      if (!carriedSnapshot) return;
      persistedSessionPayloadRef.current = {
        sessionKey,
        fingerprint: serverFingerprint,
      };
      carryDraftToProjectRef.current = null;
      if (hasPersistedDraft && carriedSnapshot.fingerprint !== serverFingerprint) {
        sessionEditRequestedKeyRef.current = null;
        setSessionConflict({
          scope: sessionDraftScope,
          projectId: sessionProjectId,
          sessionId: session.id,
          baseVersion: session.version,
          baseFingerprint: serverFingerprint,
          sessionKey,
          fingerprint: carriedSnapshot.fingerprint,
          payload: carriedSnapshot.payload,
        });
        setErrorText("新草稿项目已有远端内容。请选择保留本页并重试，或载入远端版本；不会静默覆盖任一版本。");
      } else {
        setSessionConflict(null);
        sessionEditRequestedKeyRef.current = carriedSnapshot.fingerprint === serverFingerprint
          ? null
          : sessionKey;
      }
      setHydratedSessionKey(sessionKey);
      return;
    }
    hydrateUploadedAttachments(
      sessionProjectId,
      recoveredUploadedAttachments,
      { replace: true },
    );
    if (!hasExplicitUploadedAttachments && recoveredUploadedAttachments.length) {
      // Persist the fallback once so subsequent removals remain authoritative
      // instead of resurrecting every historical upload after a hard reload.
      persistedSessionPayloadRef.current = { sessionKey, fingerprint: serverFingerprint };
      sessionEditRequestedKeyRef.current = sessionKey;
    }
    const hydratedAssignments = Array.isArray(params.videoReferenceAssignments)
      ? Object.fromEntries(params.videoReferenceAssignments.flatMap((assignment) => {
          const attachment = useUploadQueueStore.getState().items.find(
            (item) => item.asset?.assetVersionId === assignment.assetVersionId,
          );
          return attachment
            ? [[attachment.clientId, {
                ...(assignment.preferredRole ? { preferredRole: assignment.preferredRole } : {}),
                ...(assignment.slotId ? { slotId: assignment.slotId } : {}),
                order: assignment.order,
              } satisfies VideoReferenceAssignment]]
            : [];
        }))
      : {};
    setVideoReferenceAssignments(hydratedAssignments);
    if (!hasPersistedDraft) {
      carryDraftToProjectRef.current = null;
      setActiveEntry("Agent 模式");
      setAutoEnabled(true);
      setPreferenceTab("图片");
      setSelectedSkillIds([]);
      setSelectedSubjectIds([]);
      setSelectedRatio("16:9");
      setImageCount(QUICK_CREATE_IMAGE_DEFAULT_COUNT);
      setVideoReferenceAssignments({});
      setForm({
        brief: "",
        style: "高级、清晰、商业化、真实光影",
        targetType: "广告视频",
        ratio: "16:9",
        duration: 15,
        shotCount: 3,
      });
      setHydratedSessionKey(sessionKey);
      return;
    }
    carryDraftToProjectRef.current = null;

    if (typeof params.activeEntry === "string") {
      setActiveEntry(params.activeEntry === "创意导演" ? "Agent 模式" : params.activeEntry);
    }
    if (typeof params.autoEnabled === "boolean") setAutoEnabled(params.autoEnabled);
    if (params.preferenceTab === "图片" || params.preferenceTab === "视频") setPreferenceTab(params.preferenceTab);

    const restoredRatio = isQuickCreateRatio(params.ratio) ? params.ratio : null;
    setForm((current) => ({
      ...current,
      brief: typeof restoredGoal === "string" ? restoredGoal : current.brief,
      ...(typeof params.style === "string" ? { style: params.style } : {}),
      ...(typeof params.targetType === "string" ? { targetType: params.targetType } : {}),
      ...(restoredRatio ? { ratio: restoredRatio } : {}),
      ...(typeof params.duration === "number" && Number.isFinite(params.duration) ? { duration: params.duration } : {}),
      ...(typeof params.shotCount === "number" && Number.isInteger(params.shotCount) ? { shotCount: params.shotCount } : {}),
    }));

    if (restoredRatio) setSelectedRatio(restoredRatio);
    if (typeof params.llmModel === "string") setLlmModel(params.llmModel);
    if (typeof params.imageModel === "string") setImageModel(params.imageModel);
    if (isImageQuality(params.imageQuality)) setImageQuality(params.imageQuality);
    if (typeof params.imageCount === "number" && Number.isSafeInteger(params.imageCount)) {
      setImageCount(params.imageCount);
    }
    setSelectedSkillIds(Array.isArray(params.selectedSkillIds)
      ? params.selectedSkillIds.filter((id): id is string => typeof id === "string" && Boolean(id.trim()))
      : []);
    setSelectedSubjectIds(Array.isArray(params.selectedSubjectIds)
      ? params.selectedSubjectIds.filter((id): id is string => typeof id === "string" && Boolean(id.trim()))
      : []);
    setVideoOptions((current) => ({
      ...current,
      ...(typeof params.videoModel === "string" ? { model: params.videoModel } : {}),
      ...(typeof params.videoResolution === "string" ? { resolution: params.videoResolution } : {}),
      ...(params.videoOutputFormat === "mp4" || params.videoOutputFormat === "mov" ? { outputFormat: params.videoOutputFormat } : {}),
      ...(typeof params.videoDuration === "number" && Number.isFinite(params.videoDuration)
        ? { duration: params.videoDuration }
        : {}),
      ...(typeof params.videoAudio === "boolean" ? { audio: params.videoAudio } : {}),
      ...(typeof params.videoMode === "string" ? { mode: params.videoMode } : {}),
    }));

    const restoredPlan = isDirectorPlan(params.directorPlan) ? params.directorPlan : null;
    const restoredTimeline = normalizeStructuredThirtySecondTimeline(params.structuredTimeline);
    const restoredMaterialized = isMaterializedProject(params.materializedProject)
      ? params.materializedProject
      : null;
    setPlan(restoredPlan);
    setStructuredTimeline(restoredTimeline);
    if (!recoveringRoutedVideo) {
      stopTaskPoller();
      setTasks([]);
    }
    materializedProjectRef.current = restoredMaterialized;
    setMaterialized(restoredMaterialized);
    setImageAssets(restoredImageAssets(params.generatedImageAssets));
    if (restoredMaterialized && !recoveringRoutedVideo) {
      const poller = startTaskPoller(restoredMaterialized.project.id);
      void poller.refresh().catch((error) => {
        console.error("Quick Create restored task poll failed", error);
      });
    }
    setHydratedSessionKey(sessionKey);
  }, [
    attachmentProjectId,
    hydrateUploadedAttachments,
    inspirationWorkspaceProjectId,
    numericProjectId,
    scopedInspirationWorkspace?.data.references,
    session?.id,
    sessionDraftScope,
    sessionHydrationRevision,
    sessionProjectId,
    routedGenerationKind,
    routedVideoProjectId,
  ]);

  useEffect(() => {
    if (!modelPlazaInitialSelection || modelCatalogLoading || !sessionHydrated) return;
    const selectionKey = `${modelPlazaInitialSelection.modelType}:${modelPlazaInitialSelection.model}:${modelCatalogReloadKey}`;
    if (handledModelPlazaSelectionRef.current === selectionKey) return;
    handledModelPlazaSelectionRef.current = selectionKey;

    if (modelPlazaInitialSelection.modelType === "llm") {
      const model = llmModels.find((item) => item.id === modelPlazaInitialSelection.model);
      if (!model) {
        setErrorText("模型广场所选文本模型不在当前工作区的服务端目录中，未自动切换。");
        return;
      }
      setLlmModel(model.id);
      setActiveEntry("Agent 模式");
      setModelTab("对话");
      setActivePanel(null);
      setNotice(`已应用模型广场中的 ${model.label}`);
      return;
    }

    if (modelPlazaInitialSelection.modelType === "image") {
      const model = imageModels.find((item) => (
        item.id === modelPlazaInitialSelection.model && isImageModelAvailable(item)
      ));
      if (!model) {
        setErrorText("模型广场所选图片模型不在当前工作区可提交的服务端目录中，未自动切换。");
        return;
      }
      setImageModel(model.id);
      setImageQuality((quality) => model.qualities.includes(quality) ? quality : model.defaultQuality);
      setImageCount((count) => Math.min(count, model.maxOutputs));
      setActiveEntry("图片生成");
      setModelTab("图片");
      setPreferenceTab("图片");
      setActivePanel(null);
      setForm((current) => ({ ...current, targetType: "图片生成" }));
      setNotice(`已应用模型广场中的 ${model.label}`);
      return;
    }

    const model = videoModels.find((item) => (
      item.id === modelPlazaInitialSelection.model && isVideoModelAvailable(item)
    ));
    if (!model) {
      setErrorText("模型广场所选视频模型不在当前工作区可提交的服务端目录中，未自动切换。");
      return;
    }
    setVideoOptions((current) => reconcileQuickCreateVideoCatalogSelection(
      videoModels,
      { ...current, model: model.id },
    ));
    setActiveEntry("视频生成");
    setModelTab("视频");
    setPreferenceTab("视频");
    setActivePanel(null);
    setForm((current) => ({ ...current, targetType: "视频生成" }));
    setNotice(`已应用模型广场中的 ${model.label}`);
  }, [
    imageModels,
    llmModels,
    modelCatalogLoading,
    modelCatalogReloadKey,
    modelPlazaInitialSelection,
    sessionHydrated,
    videoModels,
  ]);

  const uploadedAttachmentsForSession = useMemo<NonNullable<QuickCreateSessionParameters["uploadedAttachments"]>>(
    () => attachments
      .filter((attachment) => attachment.state === "uploaded" && attachment.asset)
      .map((attachment) => ({
        clientId: attachment.clientId,
        name: attachment.name,
        size: attachment.size,
        mimeType: attachment.mimeType,
        assetId: attachment.asset!.assetId,
        assetVersionId: attachment.asset!.assetVersionId,
        filePath: attachment.asset!.filePath,
        previewUrl: attachment.asset!.previewUrl,
        type: attachment.asset!.type,
      })),
    [attachments],
  );

  const sessionParameters = useMemo<QuickCreateSessionParameters>(() => ({
    activeEntry,
    autoEnabled,
    preferenceTab,
    style: form.style,
    targetType: form.targetType,
    ratio: selectedRatio,
    llmModel,
    imageModel,
    imageQuality,
    imageCount,
    videoModel: videoOptions.model,
    videoMode: videoOptions.mode,
    videoResolution: videoOptions.resolution,
    videoOutputFormat: videoOptions.outputFormat,
    videoDuration: videoOptions.duration,
    videoAudio: videoOptions.audio,
    duration: form.duration,
    shotCount: form.shotCount,
    selectedSkillIds,
    selectedSubjectIds,
    ...nullableSessionObjectParameter("directorPlan", plan, session?.parameters),
    ...nullableSessionObjectParameter("structuredTimeline", structuredTimeline, session?.parameters),
    ...nullableSessionObjectParameter("materializedProject", materialized, session?.parameters),
    generatedImageAssets: imageAssets,
    uploadedAttachments: uploadedAttachmentsForSession,
    videoReferenceAssignments: uploadedAttachmentsForSession.flatMap((attachment) => {
      const assignment = videoReferenceAssignments[attachment.clientId];
      return assignment
        ? [{
            assetVersionId: attachment.assetVersionId,
            ...(assignment.preferredRole ? { preferredRole: assignment.preferredRole } : {}),
            ...(assignment.slotId ? { slotId: assignment.slotId } : {}),
            order: assignment.order,
          }]
        : [];
    }),
  }), [
    activeEntry,
    autoEnabled,
    preferenceTab,
    form.style,
    form.targetType,
    form.duration,
    form.shotCount,
    selectedRatio,
    llmModel,
    imageModel,
    imageQuality,
    imageCount,
    videoOptions.model,
    videoOptions.mode,
    videoOptions.resolution,
    videoOptions.duration,
    videoOptions.audio,
    selectedSkillIds,
    selectedSubjectIds,
    plan,
    structuredTimeline,
    materialized,
    imageAssets,
    uploadedAttachmentsForSession,
    videoReferenceAssignments,
    session?.parameters,
  ]);

  const sessionSavePayload = useMemo(() => ({
    goal: form.brief,
    mode: "quick_create" as const,
    parameters: sessionParameters,
    selectedAssetVersionIds: uploadedAttachmentsForSession.map(
      (attachment) => String(attachment.assetVersionId),
    ),
  }), [form.brief, sessionParameters, uploadedAttachmentsForSession]);
  const sessionPayloadFingerprint = useMemo(
    () => quickCreateDraftFingerprint(sessionSavePayload),
    [sessionSavePayload],
  );
  sessionPayloadSnapshotRef.current = {
    fingerprint: sessionPayloadFingerprint,
    payload: sessionSavePayload,
  };
  const latestSessionPayloadFingerprintRef = useRef(sessionPayloadFingerprint);
  latestSessionPayloadFingerprintRef.current = sessionPayloadFingerprint;
  const currentSessionSaveRef = useRef<PendingQuickCreateSessionSave | null>(null);
  currentSessionSaveRef.current = session && sessionProjectId && session.projectId === sessionProjectId
    ? {
        scope: sessionDraftScope,
        projectId: sessionProjectId,
        sessionId: session.id,
        baseVersion: session.version,
        baseFingerprint: quickCreateDraftFingerprint(sessionDraftPayload(session)),
        sessionKey: quickCreateSessionKey(sessionDraftScope, sessionProjectId, session.id),
        fingerprint: sessionPayloadFingerprint,
        payload: sessionSavePayload,
      }
    : null;

  // Establish the exact hydrated payload baseline before the enabled controls
  // are painted. An empty server draft may hydrate without changing any form
  // value, so a passive effect alone can otherwise mistake the first user edit
  // for the baseline and silently drop it.
  useLayoutEffect(() => {
    const sessionKey = hydratedSessionKey;
    if (
      !sessionKey
      || sessionKey !== expectedSessionKey
      || hydratedSessionKeyRef.current !== sessionKey
      || sessionConflict?.sessionKey === sessionKey
      || sessionEditRequestedKeyRef.current === sessionKey
    ) return;
    persistedSessionPayloadRef.current = {
      sessionKey,
      fingerprint: sessionPayloadFingerprint,
    };
  }, [expectedSessionKey, hydratedSessionKey, sessionConflict?.sessionKey, sessionPayloadFingerprint]);

  const flushPendingSessionSave = useCallback(async (keepalive = false) => {
    const pending = pendingSessionSaveRef.current;
    if (!pending) return;
    const currentSave = currentSessionSaveRef.current;
    if (
      getCurrentSessionProjectId() !== pending.projectId
      || hydratedSessionKeyRef.current !== pending.sessionKey
      || currentSave?.sessionKey !== pending.sessionKey
    ) {
      // A pending payload belongs to the session that produced it. Never pass
      // it to useSessionSync after the store has moved to another project; its
      // scoped outbox remains available if the user returns.
      if (pendingSessionSaveRef.current === pending) pendingSessionSaveRef.current = null;
      if (mountedRef.current) setSessionConflictRetrying(false);
      return;
    }
    // Serialize writes. Apart from preventing response reordering, the exact
    // in-flight key keeps a revert to the previous baseline dirty until the
    // first write advances the remote baseline.
    if (inFlightSessionSaveRef.current) return;
    if (useUploadQueueStore.getState().hasActiveUploads && !keepalive) {
      if (mountedRef.current) setSessionConflictRetrying(false);
      return;
    }
    pendingSessionSaveRef.current = null;
    inFlightSessionSaveRef.current = pending;
    if (mountedRef.current) setInFlightSessionSaveKey(pending.sessionKey);
    try {
      if (keepalive) {
        await saveSession(pending.payload, { keepalive: true });
      } else {
        await saveSession(pending.payload);
      }
      if (pending.scope) {
        clearQuickCreateDraftOutbox(pending.scope, pending.projectId, pending.sessionId, {
          fingerprint: pending.fingerprint,
        });
      }
      const exactSessionContext = getCurrentSessionProjectId() === pending.projectId
        && hydratedSessionKeyRef.current === pending.sessionKey
        && currentSessionSaveRef.current?.sessionKey === pending.sessionKey;
      if (
        exactSessionContext
      ) {
        // Other renders may enqueue a newer payload while this awaited write
        // is in flight; the assertion deliberately widens TypeScript's local
        // narrowing from the pre-await `null` assignment above.
        const queued = pendingSessionSaveRef.current as PendingQuickCreateSessionSave | null;
        if (
          queued?.sessionKey === pending.sessionKey
          && queued.fingerprint === pending.fingerprint
        ) {
          pendingSessionSaveRef.current = null;
        }
        persistedSessionPayloadRef.current = {
          sessionKey: pending.sessionKey,
          fingerprint: pending.fingerprint,
        };
        if (
          latestSessionPayloadFingerprintRef.current === pending.fingerprint
          && !useUploadQueueStore.getState().hasActiveUploads
        ) {
          sessionEditRequestedKeyRef.current = null;
        }
      }
      if (mountedRef.current) {
        setSessionConflict((current) => (
          current?.sessionKey === pending.sessionKey ? null : current
        ));
        setSessionConflictRetrying(false);
        if (exactSessionContext) {
          setErrorText((current) => (
            current.startsWith("草稿保存失败")
            || current.startsWith("草稿同步失败")
            || current.startsWith("检测到刷新前未保存草稿")
            || current.startsWith("新草稿项目已有远端内容")
              ? ""
              : current
          ));
        }
      }
    } catch (error) {
      const conflict = isCreationSessionConflict(error);
      const exactSessionContext = getCurrentSessionProjectId() === pending.projectId
        && hydratedSessionKeyRef.current === pending.sessionKey
        && currentSessionSaveRef.current?.sessionKey === pending.sessionKey;
      if (!conflict && exactSessionContext && !pendingSessionSaveRef.current) {
        pendingSessionSaveRef.current = pending;
      }
      if (
        mountedRef.current
        && exactSessionContext
      ) {
        if (conflict) setSessionConflict(pending);
        setSessionConflictRetrying(false);
        setErrorText(conflict
          ? normalizeError(error)
          : `草稿保存失败：${normalizeError(error)}`);
      }
    } finally {
      if (inFlightSessionSaveRef.current === pending) {
        inFlightSessionSaveRef.current = null;
        if (mountedRef.current) {
          setInFlightSessionSaveKey((current) => (
            current === pending.sessionKey ? null : current
          ));
        }
      }
    }
  }, [saveSession]);
  flushPendingSessionSaveRef.current = flushPendingSessionSave;

  // Hydration 以及模型目录归一化只刷新完整 payload 基线；只有用户真实
  // 修改持久化字段后，才按 goal + parameters + attachments 的完整指纹防抖写入。
  useEffect(() => {
    if (!session || !sessionProjectId || session.projectId !== sessionProjectId) return;
    const sessionKey = quickCreateSessionKey(sessionDraftScope, sessionProjectId, session.id);
    if (hydratedSessionKeyRef.current !== sessionKey) return;
    if (sessionConflict?.sessionKey === sessionKey) {
      const pending: PendingQuickCreateSessionSave = {
        scope: sessionDraftScope,
        projectId: sessionProjectId,
        sessionId: session.id,
        baseVersion: session.version,
        baseFingerprint: quickCreateDraftFingerprint(sessionDraftPayload(session)),
        sessionKey,
        fingerprint: sessionPayloadFingerprint,
        payload: sessionSavePayload,
      };
      pendingSessionSaveRef.current = null;
      if (pending.scope) {
        writeQuickCreateDraftOutbox({
          version: 1,
          scope: pending.scope,
          projectId: pending.projectId,
          sessionId: pending.sessionId,
          baseVersion: pending.baseVersion,
          baseFingerprint: pending.baseFingerprint,
          fingerprint: pending.fingerprint,
          savedAt: Date.now(),
          payload: pending.payload,
        });
      }
      return;
    }
    const editRequested = sessionEditRequestedKeyRef.current === sessionKey;
    const exactSessionSaveInFlight = inFlightSessionSaveKey === sessionKey
      && inFlightSessionSaveRef.current?.sessionKey === sessionKey;
    const persistedPayload = persistedSessionPayloadRef.current;
    if (!persistedPayload || persistedPayload.sessionKey !== sessionKey) {
      persistedSessionPayloadRef.current = {
        sessionKey,
        fingerprint: sessionPayloadFingerprint,
      };
      if (!editRequested) return;
    }
    if (!editRequested) {
      persistedSessionPayloadRef.current = {
        sessionKey,
        fingerprint: sessionPayloadFingerprint,
      };
      return;
    }
    if (persistedSessionPayloadRef.current?.fingerprint === sessionPayloadFingerprint) {
      if (exactSessionSaveInFlight) {
        // The user reverted to the old baseline while a different payload is
        // still being written. Queue the current value as an explicit
        // correction: if the first write succeeds it must be followed by this
        // payload, and if the page exits meanwhile the scoped outbox survives.
        const correction = currentSessionSaveRef.current;
        if (correction?.sessionKey === sessionKey) {
          pendingSessionSaveRef.current = correction;
          if (correction.scope) {
            writeQuickCreateDraftOutbox({
              version: 1,
              scope: correction.scope,
              projectId: correction.projectId,
              sessionId: correction.sessionId,
              baseVersion: correction.baseVersion,
              baseFingerprint: correction.baseFingerprint,
              fingerprint: correction.fingerprint,
              savedAt: Date.now(),
              payload: correction.payload,
            });
          }
        }
        return;
      }
      if (hasActiveUploads) {
        const stalePending = pendingSessionSaveRef.current;
        if (stalePending?.sessionKey === sessionKey) {
          pendingSessionSaveRef.current = null;
          if (stalePending.scope) {
            clearQuickCreateDraftOutbox(
              stalePending.scope,
              stalePending.projectId,
              stalePending.sessionId,
              { fingerprint: stalePending.fingerprint },
            );
          }
        }
        return;
      }
      const stalePending = pendingSessionSaveRef.current;
      if (stalePending?.sessionKey === sessionKey) {
        pendingSessionSaveRef.current = null;
        if (stalePending.scope) {
          clearQuickCreateDraftOutbox(
            stalePending.scope,
            stalePending.projectId,
            stalePending.sessionId,
            { fingerprint: stalePending.fingerprint },
          );
        }
      }
      if (sessionDraftScope) {
        clearQuickCreateDraftOutbox(sessionDraftScope, sessionProjectId, session.id, {
          fingerprint: sessionPayloadFingerprint,
        });
      }
      sessionEditRequestedKeyRef.current = null;
      if (stalePending && mountedRef.current) {
        setErrorText((current) => (
          current.startsWith("草稿保存失败") ? "" : current
        ));
      }
      return;
    }
    const pending: PendingQuickCreateSessionSave = {
      scope: sessionDraftScope,
      projectId: sessionProjectId,
      sessionId: session.id,
      baseVersion: session.version,
      baseFingerprint: quickCreateDraftFingerprint(sessionDraftPayload(session)),
      sessionKey,
      fingerprint: sessionPayloadFingerprint,
      payload: sessionSavePayload,
    };
    pendingSessionSaveRef.current = pending;
    if (pending.scope) {
      writeQuickCreateDraftOutbox({
        version: 1,
        scope: pending.scope,
        projectId: pending.projectId,
        sessionId: pending.sessionId,
        baseVersion: pending.baseVersion,
        baseFingerprint: pending.baseFingerprint,
        fingerprint: pending.fingerprint,
        savedAt: Date.now(),
        payload: pending.payload,
      });
    }
    if (hasActiveUploads) return;
    const timer = window.setTimeout(() => {
      if (
        getCurrentSessionProjectId() !== sessionProjectId
        || hydratedSessionKeyRef.current !== sessionKey
        || useUploadQueueStore.getState().hasActiveUploads
      ) return;
      void flushPendingSessionSave(false);
    }, 800);
    return () => window.clearTimeout(timer);
  }, [
    sessionProjectId,
    hydratedSessionKey,
    hasActiveUploads,
    inFlightSessionSaveKey,
    session?.id,
    sessionConflict?.sessionKey,
    sessionDraftScope,
    sessionEditRevision,
    flushPendingSessionSave,
    sessionPayloadFingerprint,
    sessionSavePayload,
  ]);

  useEffect(() => {
    const flushBeforePageExit = () => {
      void flushPendingSessionSave(true);
    };
    const flushWhenHidden = () => {
      if (document.visibilityState === "hidden") flushBeforePageExit();
    };
    window.addEventListener("pagehide", flushBeforePageExit);
    document.addEventListener("visibilitychange", flushWhenHidden);
    return () => {
      window.removeEventListener("pagehide", flushBeforePageExit);
      document.removeEventListener("visibilitychange", flushWhenHidden);
    };
  }, [flushPendingSessionSave]);

  function markSessionEdited() {
    const sessionKey = hydratedSessionKeyRef.current;
    if (!sessionKey) return;
    sessionEditRequestedKeyRef.current = sessionKey;
    // A ref marks intent, while the revision guarantees the autosave effect
    // observes that intent even when the caller has no other React state
    // update (for example, after a Zustand upload promise resolves).
    setSessionEditRevision((revision) => revision + 1);
  }

  async function persistUploadedAttachmentsImmediately(projectId: number) {
    const expectedAssetVersionIds = useUploadQueueStore.getState()
      .getUploadedAssetVersionIds()
      .map(String);
    if (!expectedAssetVersionIds.length) return;

    markSessionEdited();
    // Zustand 已经持有上传结果，但 React 的 session payload ref 要到下一次
    // commit 才包含 assetVersionId。这里有界等待该快照，并复用同一条串行
    // save 管线；如果前一个参数保存仍在途，下一轮会在其结束后继续。
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, attempt === 0 ? 0 : 50));
      if (!mountedRef.current || getCurrentSessionProjectId() !== projectId) return;
      // Removing references or resetting the composer supersedes this upload save.
      const remainingIds = useUploadQueueStore.getState().getUploadedAssetVersionIds().map(String);
      if (!expectedAssetVersionIds.every((id) => remainingIds.includes(id))) return;
      const current = currentSessionSaveRef.current;
      if (
        !current
        || current.projectId !== projectId
        || hydratedSessionKeyRef.current !== current.sessionKey
        || !expectedAssetVersionIds.every((id) => current.payload.selectedAssetVersionIds.includes(id))
      ) continue;

      sessionEditRequestedKeyRef.current = current.sessionKey;
      pendingSessionSaveRef.current = current;
      if (current.scope) {
        writeQuickCreateDraftOutbox({
          version: 1,
          scope: current.scope,
          projectId: current.projectId,
          sessionId: current.sessionId,
          baseVersion: current.baseVersion,
          baseFingerprint: current.baseFingerprint,
          fingerprint: current.fingerprint,
          savedAt: Date.now(),
          payload: current.payload,
        });
      }
      await flushPendingSessionSaveRef.current(false);
      if (
        persistedSessionPayloadRef.current?.sessionKey === current.sessionKey
        && persistedSessionPayloadRef.current.fingerprint === current.fingerprint
      ) return;
    }
    if (mountedRef.current && getCurrentSessionProjectId() === projectId) {
      throw new Error("参考素材已上传，但草稿尚未确认保存，请重试上传或稍后刷新");
    }
  }

  async function startAttachmentUploadAndMarkSession(projectId: number) {
    const result = await startAttachmentUpload(projectId);
    // Queued files are intentionally absent from the durable payload. Mark
    // the session again after they acquire server asset identities; otherwise
    // the initial "file selected" edit can be cleared before upload finishes
    // and a hard reload loses the newly uploaded reference card.
    if (result.uploaded > 0) markSessionEdited();
    return result;
  }

  // Only this page's newly selected files opt in. Hydrating old uploads never
  // adds mentions. The queue item supplies both its displayed slot and the
  // assetVersionId sent to generation; no lookup by an old asset's name.
  useEffect(() => {
    if (!sessionHydrated || attachmentProjectId !== getCurrentSessionProjectId()) return;
    const ordered = activeEntry === "视频生成" ? orderedVideoAttachments : attachments;
    const completed = ordered.flatMap((item, index) => (
      pendingReferenceMentions.current.has(item.clientId) && item.state === "uploaded" && item.asset
        ? [{clientId: item.clientId, number: index + 1}]
        : []
    ));
    if (!completed.length) return;
    completed.forEach(item => pendingReferenceMentions.current.delete(item.clientId));
    setForm(current => ({...current, brief: appendReferenceMentions(current.brief, completed.map(item => item.number))}));
    markSessionEdited();
  }, [attachments, orderedVideoAttachments, activeEntry, attachmentProjectId, sessionHydrated]);

  function retryConflictedSessionDraft() {
    const current = currentSessionSaveRef.current;
    if (!current) return;
    sessionEditRequestedKeyRef.current = current.sessionKey;
    pendingSessionSaveRef.current = current;
    if (current.scope) {
      writeQuickCreateDraftOutbox({
        version: 1,
        scope: current.scope,
        projectId: current.projectId,
        sessionId: current.sessionId,
        baseVersion: current.baseVersion,
        baseFingerprint: current.baseFingerprint,
        fingerprint: current.fingerprint,
        savedAt: Date.now(),
        payload: current.payload,
      });
    }
    setSessionConflictRetrying(true);
    setErrorText("正在用本页内容重试保存…");
    void flushPendingSessionSave(false);
  }

  function restoreRemoteSessionDraft() {
    const conflict = sessionConflict;
    if (!conflict) return;
    pendingSessionSaveRef.current = null;
    if (conflict.scope) {
      clearQuickCreateDraftOutbox(conflict.scope, conflict.projectId, conflict.sessionId);
    }
    clearSessionError();
    sessionEditRequestedKeyRef.current = null;
    persistedSessionPayloadRef.current = null;
    hydratedSessionKeyRef.current = null;
    setHydratedSessionKey(null);
    setSessionConflict(null);
    setSessionConflictRetrying(false);
    setErrorText("");
    setSessionHydrationRevision((revision) => revision + 1);
  }

  useEffect(() => {
    if (sessionError?.message && mountedRef.current) setErrorText(`草稿同步失败：${sessionError.message}`);
  }, [sessionError?.message]);

  function showNotice(text: string) {
    setNotice(text);
    window.setTimeout(() => setNotice((current) => (current === text ? "" : current)), 2600);
  }

  function retryModelCatalog() {
    setModelCatalogError("");
    setErrorText("");
    setModelCatalogLoading(true);
    setModelCatalogReloadKey((current) => current + 1);
  }

  function retrySkillCatalog() {
    setSkillCatalogError("");
    setSkillCatalogLoading(true);
    setSkillCatalogReloadKey((current) => current + 1);
  }

  function toggleSkill(skill: QuickCreateSkill) {
    markSessionEdited();
    resetGeneratedState();
    setSelectedSkillIds((current) => (
      current.includes(skill.id)
        ? current.filter((id) => id !== skill.id)
        : [...current, skill.id]
    ));
  }

  function toggleSubject(subject: QuickCreateSubject) {
    const selected = selectedSubjectIds.includes(subject.id);
    const subjectClientId = subject.assetVersionId
      ? `attachment-uploaded-${subject.assetVersionId}`
      : "";
    if (
      activeEntry === "视频生成"
      && sessionProjectId
      && subject.assetVersionId
      && subject.mediaType
      && subject.image
    ) {
      if (selected) {
        removeVideoReference(subjectClientId);
      } else {
        hydrateUploadedAttachments(sessionProjectId, [{
          assetId: subject.numericId,
          assetVersionId: subject.assetVersionId,
          filePath: subject.image,
          previewUrl: subject.image,
          type: subject.mediaType,
          mimeType: subject.mediaType === "video" ? "video/mp4" : "image/jpeg",
          size: 0,
          name: subject.name,
        }]);
        if (selectedVideoModel) {
          const resolved = assignVideoReferencesForMode({
            model: selectedVideoModel,
            mode: videoOptions.mode,
            attachments: useUploadQueueStore.getState().items,
            previous: videoReferenceAssignments,
          });
          if (resolved.ok) setVideoReferenceAssignments(resolved.assignments);
          else showNotice(resolved.message);
        }
      }
    }
    markSessionEdited();
    resetGeneratedState();
    setSelectedSubjectIds((current) => (
      selected
        ? current.filter((id) => id !== subject.id)
        : [...current, subject.id]
    ));
    setForm((current) => {
      const mention = `@${subject.name}`;
      if (selected) {
        return {
          ...current,
          brief: current.brief
            .split(mention)
            .join("")
            .replace(/[ \t]{2,}/g, " ")
            .trimEnd(),
        };
      }
      const withoutTrigger = current.brief.replace(/@\s*$/, "").trimEnd();
      return {
        ...current,
        brief: [withoutTrigger, mention].filter(Boolean).join(" "),
      };
    });
    setActivePanel(null);
  }

  async function addLibrarySubject(asset: AssetLibraryItem) {
    if (assetLibraryMutationId !== null) return;
    if (!asset.permissions.use) {
      showNotice("当前账号只有查看权限，不能在当前创作中使用该资产");
      return;
    }
    const subject = toQuickCreateSubject(asset);
    const targetProjectId = getCurrentSessionProjectId();
    if (!targetProjectId) {
      const selected = selectedSubjectIds.includes(subject.id);
      toggleSubject(subject);
      showNotice(selected
        ? `已取消引用「${asset.name}」`
        : `已引用「${asset.name}」，无需选择项目`);
      return;
    }
    if (selectedSubjectIds.includes(subject.id)) {
      toggleSubject(subject);
      showNotice(`已取消引用「${asset.name}」`);
      return;
    }
    setAssetLibraryMutationId(asset.id);
    try {
      await addAssetToProject({
        projectId: targetProjectId,
        assetId: asset.id,
        ...(subject.assetVersionId ? { assetVersionId: `image:${subject.assetVersionId}` } : {}),
        expectedOwnershipRevision: asset.ownership.revision,
        idempotencyKey: `inspiration-project:${targetProjectId}:${asset.id}:${subject.assetVersionId || "latest"}`,
      });
      toggleSubject(toQuickCreateSubject({ ...asset, projectId: targetProjectId }));
      showNotice(`已把「${asset.name}」加入当前项目`);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "资产加入项目失败");
    } finally {
      setAssetLibraryMutationId(null);
    }
  }

  async function removeProjectLibrarySubject(asset: AssetLibraryItem) {
    if (assetLibraryMutationId !== null || !asset.projectReference) return;
    setAssetLibraryMutationId(asset.id);
    try {
      await removeLibraryAssetFromProject(asset);
      const subjectId = String(asset.id);
      setSelectedSubjectIds((current) => current.filter((id) => id !== subjectId));
      showNotice(`已从当前项目移除「${asset.name}」，账号/工作区资产仍保留`);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "资产引用移除失败");
    } finally {
      setAssetLibraryMutationId(null);
    }
  }

  async function shareLibrarySubjectWithWorkspace(asset: AssetLibraryItem) {
    if (assetLibraryMutationId !== null) return;
    setAssetLibraryMutationId(asset.id);
    try {
      await shareLibraryAssetWithWorkspace(asset);
      showNotice(`已把「${asset.name}」分享给当前工作区成员`);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "资产分享失败");
    } finally {
      setAssetLibraryMutationId(null);
    }
  }

  async function transferLibrarySubjectToWorkspace(asset: AssetLibraryItem) {
    if (assetLibraryMutationId !== null) return;
    if (!window.confirm(`将「${asset.name}」转为工作区资产？转移后由工作区管理员管理。`)) return;
    setAssetLibraryMutationId(asset.id);
    try {
      await transferLibraryAssetToWorkspace(asset);
      setAssetLibraryView("workspace");
      showNotice(`「${asset.name}」已转为工作区资产`);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "资产归属转移失败");
    } finally {
      setAssetLibraryMutationId(null);
    }
  }

  function openAgentSkillWorkspace() {
    const params = new URLSearchParams({ mode: "agent" });
    if (numericProjectId) params.set("projectId", String(numericProjectId));
    navigate(`/workbench/generate?${params.toString()}`, {
      state: {
        brief: form.brief,
        fromFrontstage: true,
        skillRefs: selectedSkills.map((skill) => ({ key: skill.key, version: skill.version })),
      },
    });
  }

  function openAssetCreation() {
    const suffix = numericProjectId ? `?projectId=${numericProjectId}` : "";
    navigate(`/workbench/corner-scape${suffix}`, {
      state: { brief: form.brief, fromFrontstage: true },
    });
  }

  async function discoverAssetRecommendations() {
    if (!numericProjectId || assetRecommendationsLoading) return;
    setAssetRecommendationsLoading(true);
    setAssetRecommendationsError("");
    try {
      const result = await listAssetRecommendations({
        projectId: numericProjectId,
        query: subjectQuery.trim() || form.brief.trim(),
        context: form.targetType,
        limit: 8,
      });
      setAssetRecommendations(result.recommendations);
      if (!result.recommendations.length) showNotice("当前授权资产中没有匹配推荐");
    } catch (error) {
      setAssetRecommendations([]);
      setAssetRecommendationsError(normalizeError(error));
    } finally {
      setAssetRecommendationsLoading(false);
    }
  }

  async function adoptAssetRecommendation(recommendation: AssetRecommendation) {
    if (!numericProjectId || assetLibraryMutationId !== null || recommendation.alreadyInProject) return;
    setAssetLibraryMutationId(recommendation.assetId);
    try {
      await addAssetToProject({
        projectId: numericProjectId,
        assetId: recommendation.assetId,
        assetVersionId: recommendation.assetVersionId,
        expectedOwnershipRevision: recommendation.expectedOwnershipRevision,
      });
      await Promise.all([
        fetchProjectAssets({ limit: 80 }),
        fetchLibraryAssets({ view: assetLibraryView, limit: 100 }),
      ]);
      setAssetRecommendations((current) => current.map((item) => item.recommendationId === recommendation.recommendationId
        ? { ...item, alreadyInProject: true }
        : item));
      showNotice(`已按版本 ${recommendation.assetVersionId} 采用「${recommendation.name}」`);
    } catch (error) {
      showNotice(normalizeError(error));
    } finally {
      setAssetLibraryMutationId(null);
    }
  }

  function toggleVideoAudio() {
    if (!selectedVideoModel?.supportsGenerateAudio) {
      showNotice("当前模型不支持生成音频");
      return;
    }
    markSessionEdited();
    setAutoEnabled(false);
    setVideoOptions((current) => ({ ...current, audio: !current.audio }));
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
      markSessionEdited();
      setForm((current) => ({
        ...current,
        brief: [current.brief.trim(), transcript].filter(Boolean).join("\n"),
      }));
      resetGeneratedState();
      showNotice("已写入语音内容");
    };
    recognition.start();
  }

  function stopTaskPoller() {
    const poller = pollerRef.current;
    pollerRef.current = null;
    pollerProjectIdRef.current = null;
    pollerDetachedRef.current = false;
    poller?.stop();
  }

  function getCurrentProjectId() {
    return normalizeProjectId(useProjectStore.getState().currentProjectId);
  }

  function getCurrentSessionProjectId() {
    return sessionProjectIdRef.current;
  }

  function bindInspirationWorkspaceProject(projectId: number) {
    if (!sessionDraftScope || getCurrentProjectId()) return;
    if (sessionProjectIdRef.current !== projectId) {
      carryDraftToProjectRef.current = projectId;
    }
    sessionProjectIdRef.current = projectId;
    setInspirationWorkspaceBootstrap((current) => ({
      scope: sessionDraftScope,
      loading: false,
      data: {
        projectId,
        references: current?.scope === sessionDraftScope
          ? current.data.references
          : [],
      },
    }));
  }

  function beginProjectRequest() {
    return projectRequestEpochRef.current.begin(getCurrentProjectId());
  }

  function isProjectRequestCurrent(scope: QuickCreateProjectRequestScope) {
    return mountedRef.current
      && projectRequestEpochRef.current.isCurrent(scope, getCurrentProjectId());
  }

  function resetGeneratedState() {
    projectRequestEpochRef.current.invalidateRequest();
    materializedProjectRef.current = null;
    stopTaskPoller();
    setPollerState("idle");
    setPollErrorText("");
    setPlanning(false);
    setMaterializing(false);
    setGenerating(false);
    setPlan(null);
    setStructuredTimeline(null);
    setMaterialized(null);
    setTasks([]);
    setImageAssets([]);
  }

  function resetComposer() {
    if (!sessionHydrated || sourceImportBusy || planning || materializing || generating) return;
    markSessionEdited();
    pendingReferenceMentions.current.clear();
    videoReferencePickerRef.current = null;
    clearAttachments();
    setVideoReferenceAssignments({});
    setSelectedSkillIds([]);
    setSelectedSubjectIds([]);
    setSkillQuery("");
    setSubjectQuery("");
    setExpandedSkillId("");
    clearGuestDraft();
    setPendingGuestDraft(null);
    setForm((current) => ({ ...current, brief: "" }));
    setActivePanel(null);
    if (!sessionConflict) setErrorText("");
    resetGeneratedState();
    if (fileInputRef.current) fileInputRef.current.value = "";
    briefInputRef.current?.focus();
    showNotice("已清空本次创作内容");
  }

  function getPollErrorMessage(error: unknown, kind: PollErrorKind) {
    if (kind === "session") return "登录状态已失效，请重新登录后刷新任务状态";
    if (kind === "stop") return "任务不存在或无权访问，已停止自动刷新";
    if (kind === "rate_limit") return "任务查询过于频繁，正在稍后重试";
    const detail = normalizeError(error);
    return `连接中断，正在重试${detail ? `：${detail}` : ""}`;
  }

  function createProjectTaskPoller(projectId: number, detached = false) {
    const isPollTargetCurrent = () => (
      mountedRef.current
      && pollerProjectIdRef.current === projectId
      && pollerDetachedRef.current === detached
      && (detached
        ? materializedProjectRef.current?.project.id === projectId
          || (routedGenerationKind === "video" && routedVideoProjectId === projectId)
        : getCurrentProjectId() === projectId)
    );
    return createTaskPoller<QuickCreateVideoTask[], number>({
      fetchTasks: () => listQuickCreateTasks(projectId),
      shouldContinue: (nextTasks) => nextTasks.some((task) => shouldPollTask(task.status)),
      onData: (nextTasks) => {
        if (!isPollTargetCurrent()) return;
        setTasks(nextTasks);
        setPollErrorText("");
      },
      onState: (state) => {
        if (!isPollTargetCurrent()) return;
        setPollerState(state);
      },
      onError: (error, kind) => {
        if (!isPollTargetCurrent()) return;
        setPollErrorText(getPollErrorMessage(error, kind));
      },
      onCallbackError: (error, source) => {
        console.error(`Quick Create task poller ${source} callback failed`, error);
      },
      schedule: (callback, delay) => window.setTimeout(() => {
        callback();
      }, delay),
      cancelSchedule: (handle) => window.clearTimeout(handle),
      isVisible: () => document.visibilityState === "visible",
    });
  }

  function startTaskPoller(projectId: number, detached = false) {
    if (
      pollerRef.current
      && pollerProjectIdRef.current === projectId
      && pollerDetachedRef.current === detached
    ) return pollerRef.current;
    stopTaskPoller();
    pollerProjectIdRef.current = projectId;
    pollerDetachedRef.current = detached;
    const poller = createProjectTaskPoller(projectId, detached);
    pollerRef.current = poller;
    return poller;
  }

  async function refreshTaskPoller() {
    const routeRecovery = routedGenerationKind === "video" && Boolean(routedVideoProjectId);
    const projectId = routeRecovery
      ? routedVideoProjectId!
      : materializedProjectRef.current?.project.id;
    if (!mountedRef.current || projectId === undefined) return;

    try {
      const poller = pollerProjectIdRef.current === projectId && pollerRef.current
        ? pollerRef.current
        : startTaskPoller(projectId, routeRecovery || pollerDetachedRef.current);
      await poller.refresh();
    } catch (error) {
      console.error("Quick Create task poller refresh failed", error);
    }
  }

  async function handleCancelTask(task: QuickCreateVideoTask) {
    if (!task.relayTaskId || cancellingTaskId) return;
    setCancellingTaskId(task.relayTaskId);
    try {
      await cancelQuickCreateTask(task.relayTaskId);
      showNotice("取消请求已提交，正在核对任务与 GU 状态");
      await refreshTaskPoller();
    } catch (error) {
      showNotice(normalizeError(error) || "取消任务失败");
    } finally {
      setCancellingTaskId("");
    }
  }

  function buildDirectorPayload(brief = form.brief): QuickCreateDirectorPayload {
    const contextLines = [
      activeEntry ? `创作入口：${activeEntry}` : "",
      selectedLlmModel ? `对话模型：${selectedLlmModel.label}` : "",
      autoEnabled ? `生成偏好：自动；内容类型：${preferenceTab}；比例：${selectedRatio}` : `生成偏好：手动；内容类型：${preferenceTab}`,
      preferenceTab === "图片"
        ? `图片模型：${selectedImageModel?.label || imageModel}；清晰度：${imageQuality}；数量：${imageCount} 张`
        : `视频模型：${selectedVideoModel?.label || videoOptions.model}；模式：${selectedVideoModePresentation.label}；分辨率：${videoOptions.resolution}；时长：${videoDurationLabel(videoOptions.duration)}`,
      selectedSkills.length
        ? `使用技能：${selectedSkills.map((skill) => skill.name).join("、")}`
        : "",
      selectedSubjects.length
        ? `引用资产：${selectedSubjects.map((subject) => `${subject.name}（${subject.type}）`).join("、")}`
        : "",
      attachments.length ? `参考附件：${attachments.map((attachment) => `${attachment.name}（${quickCreateAttachmentKind(attachment)}，${attachmentStateText(attachment)}）`).join("、")}` : "",
    ].filter(Boolean);

    const standaloneVideo = activeEntry === "视频生成";
    return {
      ...form,
      ...(numericProjectId ? { projectId: numericProjectId } : {}),
      llmModel: selectedLlmModel?.id || "",
      ratio: selectedRatio,
      duration: standaloneVideo ? videoTimelineDuration : form.duration,
      shotCount: standaloneVideo ? 1 : form.shotCount,
      targetType: activeEntry === "图片生成" ? "图片生成" : activeEntry === "视频生成" ? "视频生成" : form.targetType,
      brief: [brief.trim(), contextLines.length ? `创作上下文：\n${contextLines.join("\n")}` : ""].filter(Boolean).join("\n\n"),
    };
  }

  function closedLoopConfigurationError() {
    if (activeEntry !== "视频生成") {
      if (!selectedImageModel || !isImageModelAvailable(selectedImageModel)) {
        return selectedImageModel?.unavailableReason
          || "当前没有能力、渠道和正式定价均完整的图片模型，已阻止闭环创作";
      }
      if (!selectedImageModel.qualities.includes(imageQuality)) {
        return "当前图片清晰度不在服务端模型目录中，已阻止闭环创作";
      }
      if (!selectedImageModel.aspectRatios.includes(form.ratio)) {
        return "当前图片比例不在服务端模型目录中，已阻止闭环创作";
      }
    }
    if (!selectedVideoModel || !isVideoModelAvailable(selectedVideoModel)) {
      return selectedVideoModel?.unavailableReason
        || "当前没有能力、渠道和正式定价均完整的视频模型，已阻止闭环创作";
    }
    if (!selectedVideoModel.resolutions.includes(videoOptions.resolution)) {
      return "当前视频清晰度不在服务端模型目录中，已阻止闭环创作";
    }
    if (!selectedVideoModel.aspectRatios.includes(form.ratio)) {
      return "当前视频比例不在服务端模型目录中，已阻止闭环创作";
    }
    if (requiredVideoRatio(selectedVideoModel.id, videoOptions.mode) && form.ratio !== "adaptive") {
      return "当前模式须跟随参考素材比例";
    }
    if (normalizeVideoDuration(videoOptions.duration, selectedVideoModel.duration) !== videoOptions.duration) {
      return "当前视频时长不在服务端模型目录中，已阻止闭环创作";
    }
    if (requiredVideoDuration(selectedVideoModel.id, videoOptions.mode) === -1 && videoOptions.duration !== -1) {
      return "视频编辑时长须跟随原片";
    }
    if (!selectedVideoOutputFormats.includes(videoOptions.outputFormat)) {
      return "当前输出格式不在服务端模型目录中";
    }
    if (videoOptions.audio && !selectedVideoModel.supportsGenerateAudio) {
      return "当前视频模型不支持生成音频，已阻止闭环创作";
    }
    if (activeEntry === "视频生成") {
      if (!videoOptions.mode || !selectedVideoModel.modes.includes(videoOptions.mode)) {
        return "当前视频生成模式不在模型官方能力目录中";
      }
      const referenceResolution = resolveQuickCreateVideoReferences(
        selectedVideoModel,
        videoOptions.mode,
        orderedVideoAttachments.map((attachment) => ({
          kind: referenceKind(attachment),
          assetVersionId: attachment.asset
            ? String(attachment.asset.assetVersionId)
            : attachment.clientId,
          ...(videoReferenceAssignments[attachment.clientId]?.preferredRole
            ? { preferredRole: videoReferenceAssignments[attachment.clientId].preferredRole }
            : {}),
          ...(videoReferenceAssignments[attachment.clientId]?.slotId
            ? { slotId: videoReferenceAssignments[attachment.clientId].slotId }
            : {}),
        })),
      );
      if (!referenceResolution.ok) return referenceResolution.message;
    }
    return null;
  }

  function uploadedTimelineAttachments(): TimelineAttachment[] {
    return [...useUploadQueueStore.getState().items]
      .sort((left, right) => (
        (videoReferenceAssignments[left.clientId]?.order ?? Number.MAX_SAFE_INTEGER)
        - (videoReferenceAssignments[right.clientId]?.order ?? Number.MAX_SAFE_INTEGER)
      ))
      .filter((attachment) => (
        attachment.state === "uploaded"
        && attachment.asset
        && attachment.asset.type !== "document"
      ))
      .map((attachment) => ({
        assetVersionId: String(attachment.asset!.assetVersionId),
        mediaType: attachment.asset!.type as TimelineAttachment["mediaType"],
        label: attachment.name,
      }));
  }

  function rebuildStructuredTimeline(sourcePlan?: QuickCreateDirectorPlan | null) {
    const nextPlan = sourcePlan ?? plan;
    if (!nextPlan) return;
    markSessionEdited();
    setStructuredTimeline(buildStructuredThirtySecondTimeline({
      plan: nextPlan,
      attachments: uploadedTimelineAttachments(),
    }));
  }

  function updateTimelineShotPrompt(index: number, value: string) {
    const prompt = value.trim();
    if (!prompt) return;
    markSessionEdited();
    setStructuredTimeline((current) => current ? {
      ...current,
      shots: current.shots.map((shot, shotIndex) => (
        shotIndex === index ? { ...shot, prompt } : shot
      )),
    } : current);
  }

  function toggleTimelineShotAsset(index: number, assetVersionId: string) {
    markSessionEdited();
    setStructuredTimeline((current) => current ? {
      ...current,
      shots: current.shots.map((shot, shotIndex) => {
        if (shotIndex !== index) return shot;
        const selected = shot.assetVersionIds.includes(assetVersionId);
        return {
          ...shot,
          assetVersionIds: selected
            ? shot.assetVersionIds.filter((id) => id !== assetVersionId)
            : [...shot.assetVersionIds, assetVersionId].slice(0, 12),
        };
      }),
    } : current);
  }

  function updateTimelineAudioCue(
    index: number,
    patch: Partial<Pick<StructuredThirtySecondTimeline["audioCues"][number],
      "startSeconds" | "endSeconds" | "sourceStartSeconds" | "volume">>,
  ) {
    markSessionEdited();
    setStructuredTimeline((current) => current ? {
      ...current,
      audioCues: current.audioCues.map((cue, cueIndex) => (
        cueIndex === index ? { ...cue, ...patch } : cue
      )),
    } : current);
  }

  function openGenerationScreen(kind: "image" | "video", statusText: string) {
    setGenerationScreen({ kind, phase: "waiting", submissionPending: true, statusText });
    // Image result URLs are durable only after the API returns asset identities.
    // Until then, keep the waiting screen local so recovery does not treat the
    // intentionally identity-less pending request as a broken result link.
    if (kind === "video") {
      navigate(`/workbench/create?generation=${kind}`, { replace: true });
    }
  }

  function closeGenerationScreen() {
    setGenerationScreen(null);
    setErrorText("");
    navigate("/workbench/create", { replace: true });
  }

  function continueGenerationFromSession(nextPrompt: string) {
    setForm((current) => ({ ...current, brief: nextPrompt }));
    void handleGeneratePlan(nextPrompt);
  }

  async function useGeneratedImageForVideo(asset: QuickCreateImageAsset) {
    if (!Number.isSafeInteger(asset.assetId) || !Number.isSafeInteger(asset.assetVersionId)) {
      showNotice("这张图片还没有完成资产入库，请刷新结果后再试");
      return;
    }
    const nextMode = selectedVideoModel?.modes.includes("image_to_video")
      ? "image_to_video"
      : selectedVideoModel?.modes.includes("omni_reference")
        ? "omni_reference"
        : selectedVideoModel?.modes.includes("image_reference")
          ? "image_reference"
          : selectedVideoModel?.modes.includes("reference_to_video")
            ? "reference_to_video"
            : "";
    if (!nextMode) {
      showNotice("当前视频模型不支持图片参考，请先切换支持首帧或全能参考的模型");
      return;
    }
    const requestScope = beginProjectRequest();
    try {
      const targetProjectId = await ensureInspirationReferenceProject(requestScope, asset.prompt || form.brief);
      if (!isProjectRequestCurrent(requestScope)) return;
      // Put the reference in the same durable draft used by uploads immediately.
      // Portrait checks and refresh recovery must work before Generate is clicked.
      const assetVersionId = Number(asset.assetVersionId);
      hydrateUploadedAttachments(targetProjectId, [{
        assetId: Number(asset.assetId),
        assetVersionId,
        filePath: asset.url,
        previewUrl: asset.url,
        type: "image",
        mimeType: "image/jpeg",
        size: 0,
        name: `生成图片 ${assetVersionId}`,
      }], { replace: true });
      const resolved = assignVideoReferencesForMode({
        model: selectedVideoModel!,
        mode: nextMode,
        attachments: useUploadQueueStore.getState().items,
        previous: {
          [`attachment-uploaded-${assetVersionId}`]: {
            ...(nextMode === "image_to_video" ? { preferredRole: "first_frame" as const } : {}),
            order: 0,
          },
        },
      });
      if (!resolved.ok) throw new Error(resolved.message);
      markSessionEdited();
      setVideoReferenceAssignments(resolved.assignments);
      setActiveEntry("视频生成");
      setPreferenceTab("视频");
      setVideoOptions((current) => ({ ...current, mode: nextMode }));
      setForm((current) => ({ ...current, brief: asset.prompt || current.brief }));
      closeGenerationScreen();
      showNotice(nextMode === "image_to_video" ? "已把这张图片带入视频首帧" : "已把这张图片带入视频参考");
    } catch (error) {
      showNotice(normalizeError(error) || "无法使用这张图片，请重试");
    }
  }

  async function continueGenerationInProject(mode: "quick" | "canvas") {
    if (continuingGenerationMode) return;
    const projectImageModel = selectedImageModel
      || imageModels.find(isImageModelAvailable)
      || null;
    const projectVideoModel = selectedVideoModel
      || videoModels.find(isVideoModelAvailable)
      || null;
    if (!projectImageModel || !projectVideoModel) {
      showNotice(modelCatalogLoading
        ? "模型目录仍在加载，请稍后再进入项目模式"
        : "当前缺少可用的图片或视频模型，暂时无法进入项目模式");
      return;
    }
    const isImageResult = activeGenerationScreen?.kind === "image";
    const resultAssets = isImageResult
      ? displayedImageAssets
      : displayedVideoTasks.filter((task) => task.status === "succeeded");
    const generationAssets = resultAssets.filter((asset): asset is typeof asset & { assetId: number; assetVersionId: number } => (
      Number.isSafeInteger(asset.assetId)
      && Number(asset.assetId) > 0
      && Number.isSafeInteger(asset.assetVersionId)
      && Number(asset.assetVersionId) > 0
    ));
    if (!generationAssets.length) {
      showNotice("生成结果尚未完成资产入库，请刷新结果后再进入项目");
      return;
    }
    const duration = normalizeVideoDuration(
      (!isImageResult && displayedVideoTasks[0]?.duration) || projectVideoModel.duration.default,
      projectVideoModel.duration,
    );
    const prompt = resultAssets[0]?.prompt?.trim() || "来自灵感页的创作";
    // The composer may already contain the next idea. A result handoff always
    // starts from the saved result, never an unrelated draft plan.
    const visiblePlan: QuickCreateDirectorPlan = {
      title: prompt.slice(0, 36) || "灵感创作",
      simpleScript: prompt,
      stylePrompt: "",
      ratio: selectedRatio,
      duration,
      shots: [{
        title: "灵感镜头",
        script: prompt,
        visual: prompt,
        prompt,
        duration,
        track: "镜头 1",
      }],
    };
    const payload = {
      brief: prompt,
      targetType: mode === "canvas" ? "画布创作" : "快速创作",
      plan: visiblePlan,
      imageModel: resolveQuickCreateImageModel(projectImageModel.id) || undefined,
      videoModel: projectVideoModel.id,
      imageQuality,
      purpose: "project" as const,
    };
    const preparedAttempt = prepareStoredSubmissionAttempt({
      current: materializeSubmissionAttemptRef.current,
      flow: `generation-to-${mode}`,
      operationKey: generationAssets.map((asset) => `${asset.assetId}:${asset.assetVersionId}`).join(","),
      prefix: "generation-project",
      payload,
    });
    materializeSubmissionAttemptRef.current = preparedAttempt.attempt;
    setContinuingGenerationMode(mode);
    try {
      const project = await materializeDirectorPlan(payload, preparedAttempt.attempt.idempotencyKey);
      await Promise.all(generationAssets.map((asset) => addAssetToProject({
        projectId: project.project.id,
        assetId: asset.assetId,
        assetVersionId: `image:${asset.assetVersionId}`,
        idempotencyKey: `generation-project:${project.project.id}:${asset.assetId}:${asset.assetVersionId}`,
      })));
      let canvasId: string | null = null;
      if (mode === "canvas") {
        const canvas = await apiPost<{ canvasId: string; revision: number }, { name: string }>(
          `/projects/${project.project.id}/canvases`,
          { name: "灵感画布" },
        );
        canvasId = String(canvas.canvasId || "").trim() || null;
      }
      clearStoredSubmissionAttempt(preparedAttempt.storageKey);
      materializeSubmissionAttemptRef.current = null;
      await refreshAndSelectProject(project.project.id);
      navigate(buildProjectModeHref(mode, {
        projectId: project.project.id,
        ...(canvasId ? { canvasId } : {}),
      }));
    } catch (error) {
      showNotice(normalizeError(error) || "创建项目失败，请重试");
    } finally {
      setContinuingGenerationMode(null);
    }
  }

  async function ensureInspirationReferenceProject(
    requestScope: QuickCreateProjectRequestScope,
    prompt: string,
  ): Promise<number> {
    const existingProjectId = getCurrentSessionProjectId();
    if (existingProjectId) {
      if (useUploadQueueStore.getState().boundProjectId !== existingProjectId) {
        rebindLocalAttachments(existingProjectId);
      }
      await ensureSelectedSubjectProjectReferences(existingProjectId);
      return existingProjectId;
    }
    if (!selectedImageModel || !selectedVideoModel) {
      throw new Error("参考素材暂存需要完整的图片与视频模型目录");
    }
    if (!selectedVideoModel.aspectRatios.includes(selectedRatio)) {
      throw new Error("当前图片比例无法建立参考素材暂存空间，请换一个图片与视频模型都支持的比例");
    }
    const duration = normalizeVideoDuration(selectedVideoModel.duration.default, selectedVideoModel.duration);
    const referencePlan: QuickCreateDirectorPlan = {
      title: `灵感参考素材 · ${new Date().toLocaleDateString("zh-CN")}`,
      simpleScript: prompt,
      stylePrompt: form.style || "",
      ratio: selectedRatio,
      duration,
      shots: [{
        title: "灵感参考",
        script: prompt,
        visual: prompt,
        prompt,
        duration,
        track: "灵感参考",
      }],
    };
    const materializePayload = {
      brief: prompt,
      targetType: "灵感参考素材",
      plan: referencePlan,
      imageModel: resolveQuickCreateImageModel(selectedImageModel.id) || undefined,
      videoModel: selectedVideoModel.id,
      imageQuality,
      purpose: "inspiration" as const,
    };
    const preparedAttempt = prepareStoredSubmissionAttempt({
      current: materializeSubmissionAttemptRef.current,
      flow: "quick-create-materialize",
      operationKey: "inspiration-reference",
      prefix: "quick-create-materialize",
      payload: materializePayload,
    });
    materializeSubmissionAttemptRef.current = preparedAttempt.attempt;
    const project = await materializeDirectorPlan(materializePayload, preparedAttempt.attempt.idempotencyKey);
    clearStoredSubmissionAttempt(preparedAttempt.storageKey);
    materializeSubmissionAttemptRef.current = null;
    if (!isProjectRequestCurrent(requestScope)) throw new Error("创作上下文已变化，请重新提交");
    bindInspirationWorkspaceProject(project.project.id);
    if (useUploadQueueStore.getState().boundProjectId !== project.project.id) {
      rebindLocalAttachments(project.project.id);
    }
    await ensureSelectedSubjectProjectReferences(project.project.id);
    return project.project.id;
  }

  async function ensureSelectedSubjectProjectReferences(projectId: number) {
    await Promise.all(selectedSubjects.flatMap((subject) => (
      subject.assetVersionId
        ? [addAssetToProject({
            projectId,
            assetId: subject.numericId,
            assetVersionId: `image:${subject.assetVersionId}`,
            idempotencyKey: `inspiration-project:${projectId}:${subject.numericId}:${subject.assetVersionId}`,
          })]
        : []
    )));
  }

  async function runStandaloneVideoGeneration(
    nextPlan: QuickCreateDirectorPlan,
    directorPayload: QuickCreateDirectorPayload,
    requestScope: QuickCreateProjectRequestScope,
    confirmPricing = false,
  ) {
    if (!selectedVideoModel) {
      throw new Error("视频模型目录不完整，无法建立视频生成任务");
    }
    const timelinePlan: QuickCreateDirectorPlan = {
      ...nextPlan,
      ratio: selectedRatio,
      duration: videoTimelineDuration,
      shots: nextPlan.shots.slice(0, 1).map((shot) => ({
        ...shot,
        duration: videoTimelineDuration,
      })),
    };
    if (!timelinePlan.shots.length) throw new Error("视频生成方案缺少可提交镜头");

    setGenerationScreen({ kind: "video", phase: "waiting", submissionPending: true, statusText: "正在准备生成请求" });
    setMaterializing(true);
    const materializePayload = {
      brief: directorPayload.brief,
      targetType: "灵感视频生成",
      plan: timelinePlan,
      imageModel: selectedImageModel
        ? resolveQuickCreateImageModel(selectedImageModel.id) || undefined
        : undefined,
      videoModel: selectedVideoModel.id,
      imageQuality,
      purpose: "inspiration" as const,
    };
    const materializeFingerprint = JSON.stringify(materializePayload);
    const retryContext = standaloneVideoRetryContextRef.current;
    let project = videoSubmissionAttemptRef.current
      && retryContext?.fingerprint === materializeFingerprint
      ? retryContext.project
      : null;
    if (!project) {
      const preparedMaterializeAttempt = prepareStoredSubmissionAttempt({
        current: materializeSubmissionAttemptRef.current,
        flow: "quick-create-materialize",
        operationKey: "inspiration-video",
        prefix: "quick-create-materialize",
        payload: materializePayload,
      });
      materializeSubmissionAttemptRef.current = preparedMaterializeAttempt.attempt;
      project = await materializeDirectorPlan(
        materializePayload,
        preparedMaterializeAttempt.attempt.idempotencyKey,
      );
      clearStoredSubmissionAttempt(preparedMaterializeAttempt.storageKey);
      materializeSubmissionAttemptRef.current = null;
    }
    if (!isProjectRequestCurrent(requestScope)) return;

    const targetProjectId = project.project.id;
    if (!isProjectRequestCurrent(requestScope)) return;

    bindInspirationWorkspaceProject(targetProjectId);
    if (useUploadQueueStore.getState().boundProjectId !== targetProjectId) {
      rebindLocalAttachments(targetProjectId);
    }
    await ensureSelectedSubjectProjectReferences(targetProjectId);
    const selectedSubjectReferences = selectedSubjects
      .filter((subject) => subject.assetVersionId && subject.mediaType && subject.image)
      .map((subject) => ({
        assetId: subject.numericId,
        assetVersionId: subject.assetVersionId!,
        filePath: subject.image!,
        previewUrl: subject.image!,
        type: subject.mediaType!,
        mimeType: subject.mediaType === "video" ? "video/mp4" : "image/jpeg",
        size: 0,
        name: subject.name,
      }));
    if (selectedSubjectReferences.length) {
      hydrateUploadedAttachments(targetProjectId, selectedSubjectReferences);
    }
    const preparedReferenceAttachments = useUploadQueueStore.getState().items;
    const resolvedSubjectReferences = assignVideoReferencesForMode({
      model: selectedVideoModel,
      mode: videoOptions.mode,
      attachments: preparedReferenceAttachments,
      previous: videoReferenceAssignments,
    });
    if (!resolvedSubjectReferences.ok) throw new Error(resolvedSubjectReferences.message);
    const submissionReferenceAssignments = resolvedSubjectReferences.assignments;
    setVideoReferenceAssignments(submissionReferenceAssignments);
    materializedProjectRef.current = project;
    standaloneVideoRetryContextRef.current = {
      fingerprint: materializeFingerprint,
      project,
    };
    setMaterializing(false);
    setGenerationScreen({ kind: "video", phase: "waiting", submissionPending: true, statusText: "正在上传参考素材" });
    await startAttachmentUploadAndMarkSession(targetProjectId);
    if (!isProjectRequestCurrent(requestScope)) return;
    const currentAttachments = useUploadQueueStore.getState().items;
    const failedUploads = currentAttachments.filter((item) => item.state === "failed");
    if (failedUploads.length) {
      throw new Error(failedUploads.map((item) => `${item.name}：${item.error || "上传失败"}`).join("；"));
    }
    const usableAttachments = currentAttachments.filter((item) => (
      item.mimeType.startsWith("image/")
      || item.mimeType.startsWith("video/")
      || item.mimeType.startsWith("audio/")
    ));
    const pendingUploads = usableAttachments.filter((item) => item.state !== "uploaded" || !item.asset);
    if (pendingUploads.length) {
      throw new Error(`${pendingUploads.length} 个参考附件尚未上传：${pendingUploads.map((item) => item.name).join("、")}`);
    }

    const submissionTimeline = buildStructuredThirtySecondTimeline({
      plan: timelinePlan,
      attachments: uploadedTimelineAttachments(),
    });
    const trackData = buildQuickCreateVideoTrackData({
      timeline: submissionTimeline,
      projectShots: project.shots,
      attachments: usableAttachments,
      model: selectedVideoModel,
      preferredMode: videoOptions.mode,
      referenceAssignments: submissionReferenceAssignments,
      durationOverride: videoOptions.duration,
      audioReferenceMode: "full",
    });
    if (!isProjectRequestCurrent(requestScope)) return;

    const submissionPayload = {
      projectId: targetProjectId,
      scriptId: project.script.id,
      model: selectedVideoModel.id,
      resolution: videoOptions.resolution,
      ...videoOutputFormatRequestField(selectedVideoModel.outputFormatsDeclared === true, videoOptions.outputFormat),
      audio: videoOptions.audio,
      trackData,
    };
    const preparedVideoAttempt = prepareStoredSubmissionAttempt({
      current: videoSubmissionAttemptRef.current,
      flow: "quick-create-video",
      operationKey: String(targetProjectId),
      prefix: "quick-create-video",
      payload: submissionPayload,
    });
    videoSubmissionAttemptRef.current = preparedVideoAttempt.attempt;
    setGenerating(true);
    setGenerationScreen({ kind: "video", phase: "waiting", submissionPending: true, statusText: "正在提交视频生成任务" });
    const initialPricing = modelPlazaPricingOptions(
      modelPlazaInitialSelection,
      "video",
      selectedVideoModel.id,
    );
    const submittedTasks = await submitAfterPortraitPreparation({
      isCurrent: () => isProjectRequestCurrent(requestScope),
      onProgress: (statusText) => setGenerationScreen({ kind: "video", phase: "waiting", submissionPending: true, statusText }),
      submit: () => confirmPricing || initialPricing
      ? generateQuickCreateVideos(
          submissionPayload,
          preparedVideoAttempt.attempt.idempotencyKey,
          confirmPricing ? { confirmPricing: true } : initialPricing,
        )
      : generateQuickCreateVideos(
          submissionPayload,
          preparedVideoAttempt.attempt.idempotencyKey,
        ),
    });
    if (!hasPendingReconcileSubmission(submittedTasks)) {
      clearStoredSubmissionAttempt(preparedVideoAttempt.storageKey);
      videoSubmissionAttemptRef.current = null;
      standaloneVideoRetryContextRef.current = null;
    }
    if (!isProjectRequestCurrent(requestScope)) return;
    const taskIds = submittedTasks.map(videoTaskIdentity).filter(Boolean);
    setPlan(timelinePlan);
    setTasks(submittedTasks);
    setGenerating(false);
    setGenerationScreen({
      kind: "video",
      phase: "waiting",
      statusText: submittedTasks.map(generationPreparationMessage).find(Boolean) || "任务已进入生成队列",
      taskIds,
    });
    const generationParams = new URLSearchParams({ generation: "video" });
    generationParams.set("generationProject", String(targetProjectId));
    taskIds.forEach((taskId) => generationParams.append("task", taskId));
    navigate(`/workbench/create?${generationParams.toString()}`, { replace: true });
    const poller = startTaskPoller(targetProjectId, true);
    await poller.refresh();
  }

  async function handleStartAgent(brief: string) {
    if (agentStartingRef.current) return;
    const scope = generateStorageScope(user?.id, currentWorkspace?.id);
    if (!brief.trim()) { setErrorText("先输入想和 Agent 讨论的内容"); return; }
    if (!scope || !selectedLlmModel) { setErrorText("请等待登录和对话模型加载完成"); return; }
    const queue = useUploadQueueStore.getState().items;
    const unsupported = queue.filter((item) => !isQuickCreateAttachmentAllowed("Agent 模式", item));
    if (unsupported.length) {
      setErrorText(`${quickCreateAttachmentRestrictionText("Agent 模式")}，请先移除：${unsupported.map((item) => item.name).join("、")}`);
      return;
    }
    const invalid = queue.filter((item) => item.state !== "uploaded" || !item.asset);
    if (invalid.length) {
      setErrorText(`请先完成参考素材上传：${invalid.map((item) => item.name).join("、")}`);
      return;
    }
    const requestScope = beginProjectRequest();
    const isAgentRequestCurrent = () => {
      const auth = useAuthStore.getState();
      return isProjectRequestCurrent(requestScope)
        && generateStorageScope(auth.user?.id, auth.currentWorkspace?.id) === scope;
    };
    const payload = {
      projectId: numericProjectId,
      brief: brief.trim(),
      model: selectedLlmModel.id,
      style: form.style || "",
      references: queue.map((item) => ({
        assetId: Number(item.asset!.assetId),
        assetVersionId: Number(item.asset!.assetVersionId),
        name: item.name,
        kind: item.mimeType.startsWith("image/") ? "image"
          : item.mimeType.startsWith("audio/") ? "audio" : "video",
      })),
      assets: selectedSubjects.map((subject) => ({
        assetId: subject.numericId,
        assetVersionId: subject.assetVersionId,
      })),
      skillRefs: selectedSkills.map((skill) => ({ key: skill.key, version: skill.version })),
      ...(preferenceTab === "图片" && selectedImageModel
        && isImageModelAvailable(selectedImageModel)
        && selectedImageModel.qualities.includes(imageQuality)
        && selectedImageModel.aspectRatios.includes(selectedRatio)
        ? { generationPreferences: {
          generationType: "image" as const, model: selectedImageModel.id,
          ratio: selectedRatio, quality: imageQuality, count: imageCount,
        } }
        : preferenceTab === "视频" && selectedVideoModel
          && isVideoModelAvailable(selectedVideoModel)
          && selectedVideoModel.resolutions.includes(videoOptions.resolution)
          && selectedVideoModel.aspectRatios.includes(selectedRatio)
          && selectedVideoModel.modes.includes(videoOptions.mode)
          ? { generationPreferences: {
            generationType: "video" as const, model: selectedVideoModel.id,
            ratio: selectedRatio, resolution: videoOptions.resolution,
            mode: videoOptions.mode, duration: videoOptions.duration,
            generateAudio: videoOptions.audio,
          } }
          : {}),
    };
    const prepared = prepareStoredSubmissionAttempt({
      current: agentSubmissionAttemptRef.current,
      flow: "quick-create-agent",
      operationKey: `${scope}:${numericProjectId ?? "new"}`,
      prefix: "quick-agent",
      payload: { scope, ...payload },
    });
    agentSubmissionAttemptRef.current = prepared.attempt;
    agentStartingRef.current = true;
    setPlanning(true);
    setErrorText("");
    try {
      const result = await startQuickCreateAgent({
        ...payload,
        scope,
        idempotencyKey: prepared.attempt.idempotencyKey,
        assertCurrent: () => {
          if (!isAgentRequestCurrent()) throw new Error("创作上下文已变化，请重新提交");
        },
      });
      if (!isAgentRequestCurrent()) return;
      clearStoredSubmissionAttempt(prepared.storageKey);
      agentSubmissionAttemptRef.current = null;
      // The server owns the first turn; the Agent page restores its exact thread.
      navigate(result.href);
    } catch (error) {
      if (isAgentRequestCurrent()) setErrorText(normalizeError(error));
    } finally {
      agentStartingRef.current = false;
      if (isProjectRequestCurrent(requestScope)) setPlanning(false);
    }
  }

  async function handleGeneratePlan(brief = form.brief, confirmPricing = false) {
    if (generationSubmittingRef.current || planning || hasActiveUploads) return;
    if (activeEntry === "Agent 模式") {
      await handleStartAgent(brief);
      return;
    }
    if (sourceImportBusyRef.current) { showNotice("案例素材正在带入，请稍候"); return; }
    const unsupportedAttachments = useUploadQueueStore.getState().items.filter(
      (attachment) => !isQuickCreateAttachmentAllowed(activeEntry, attachment),
    );
    if (unsupportedAttachments.length) {
      setErrorText(
        `${quickCreateAttachmentRestrictionText(activeEntry)}，请先移除：${unsupportedAttachments
          .map((attachment) => attachment.name)
          .join("、")}`,
      );
      return;
    }
    if (!brief.trim()) {
      setErrorText("请输入创意 brief");
      return;
    }
    if (modelCatalogLoading) {
      setErrorText("模型目录仍在加载，请稍后再试");
      return;
    }
    if (activeEntry !== "图片生成" && activeEntry !== "视频生成" && !selectedLlmModel) {
      setErrorText(modelCatalogError ? `模型目录读取失败：${modelCatalogError}` : "未配置可用的对话模型");
      setActivePanel("models");
      return;
    }
    if (activeEntry !== "图片生成") {
      const configurationError = closedLoopConfigurationError();
      if (configurationError) {
        setErrorText(configurationError);
        setActivePanel("models");
        return;
      }
    }
    generationSubmittingRef.current = true;
    markSessionEdited();
    resetGeneratedState();
    const requestScope = beginProjectRequest();
    let activeAttempt: {
      kind: "image";
      storageKey: string;
      attempt: StableSubmissionAttempt;
    } | null = null;
    setPlanning(true);
    setErrorText("");
    if (activeEntry === "图片生成") openGenerationScreen("image", "正在准备图片生成任务");
    if (activeEntry === "视频生成") openGenerationScreen("video", "正在准备生成请求");
    try {
      const payload = buildDirectorPayload(brief);
      if (activeEntry === "图片生成") {
        if (!selectedImageModel || !isImageModelAvailable(selectedImageModel)) {
          setErrorText(
            selectedImageModel?.unavailableReason ||
              `模型「${selectedImageModel?.label || imageModel}」尚未完成能力验证，暂不能提交付费任务`,
          );
          return;
        }
        if (!selectedImageModel.qualities.includes(imageQuality)) {
          setErrorText("当前图片清晰度不在服务端模型目录中，已阻止提交");
          return;
        }
        if (!selectedImageModel.aspectRatios.includes(form.ratio)) {
          setErrorText("当前图片比例不在服务端模型目录中，已阻止提交");
          return;
        }
        if (!Number.isSafeInteger(imageCount) || imageCount < 1 || imageCount > selectedImageModel.maxOutputs) {
          setErrorText(`当前图片模型每次最多生成 ${selectedImageModel.maxOutputs} 张`);
          return;
        }
        const pendingImageReferences = useUploadQueueStore.getState().items.filter(
          (attachment) => attachment.mimeType.startsWith("image/"),
        );
        const imageProjectId = pendingImageReferences.length
          ? await ensureInspirationReferenceProject(requestScope, payload.brief)
          : undefined;
        if (pendingImageReferences.length) {
          setGenerationScreen({ kind: "image", phase: "waiting", submissionPending: true, statusText: "正在上传参考图片" });
          await startAttachmentUploadAndMarkSession(imageProjectId!);
          if (!isProjectRequestCurrent(requestScope)) return;
        }
        const imageAttachments = useUploadQueueStore.getState().items.filter(
          (attachment) => attachment.mimeType.startsWith("image/"),
        );
        const failedUploads = imageAttachments.filter((attachment) => attachment.state === "failed");
        if (failedUploads.length) {
          throw new Error(failedUploads.map((item) => `${item.name}：${item.error || "上传失败"}`).join("；"));
        }
        const pendingUploads = imageAttachments.filter(
          (attachment) => attachment.state !== "uploaded" || !attachment.asset,
        );
        if (pendingUploads.length) {
          throw new Error(
            `${pendingUploads.length} 个图片参考尚未上传：${pendingUploads.map((item) => item.name).join("、")}`,
          );
        }
        const uploadedImageReferences = generationReferences(imageAttachments);
        if (uploadedImageReferences.length > MAX_QUICK_CREATE_IMAGE_REFERENCES) {
          throw new Error(
            `图片参考超过引用上限：当前 ${uploadedImageReferences.length} 个，最多 ${MAX_QUICK_CREATE_IMAGE_REFERENCES} 个`,
          );
        }
        const imagePayload = {
          prompt: payload.brief,
          model: resolveQuickCreateImageModel(selectedImageModel.id),
          ratio: payload.ratio,
          quality: imageQuality,
          count: imageCount,
          style: payload.style,
          ...(imageProjectId ? { projectId: imageProjectId } : {}),
          ...(selectedSubjects.length ? {
            subjects: selectedSubjects.map((subject) => ({
              id: subject.numericId,
              name: subject.name,
              type: subject.type,
            })),
          } : {}),
          ...(selectedSkills.length ? {
            skills: selectedSkills.map((skill) => ({ id: skill.id, name: skill.name })),
          } : {}),
          ...(uploadedImageReferences.length ? { references: uploadedImageReferences } : {}),
        };
        const preparedAttempt = prepareStoredSubmissionAttempt({
          current: imageSubmissionAttemptRef.current,
          flow: "quick-create-image",
          operationKey: imageProjectId ? String(imageProjectId) : "workspace",
          prefix: "quick-create-image",
          payload: imagePayload,
        });
        const imageAttempt = preparedAttempt.attempt;
        activeAttempt = { kind: "image", ...preparedAttempt };
        imageSubmissionAttemptRef.current = imageAttempt;
        const initialPricing = modelPlazaPricingOptions(
          modelPlazaInitialSelection,
          "image",
          selectedImageModel.id,
        );
        const result = confirmPricing || initialPricing
          ? await generateQuickCreateImageBatch(
              imagePayload,
              imageAttempt.idempotencyKey,
              confirmPricing ? { confirmPricing: true } : initialPricing,
            )
          : await generateQuickCreateImageBatch(imagePayload, imageAttempt.idempotencyKey);
        clearStoredSubmissionAttempt(preparedAttempt.storageKey);
        imageSubmissionAttemptRef.current = null;
        if (!isProjectRequestCurrent(requestScope)) return;
        const generatedAssets = result.assets || [];
        const resultSearch = buildRoutedImageGenerationSearch({
          assets: generatedAssets,
          model: result.model || selectedImageModel.id,
          ratio: payload.ratio,
          quality: imageQuality,
          count: result.count,
        });
        setImageAssets(generatedAssets);
        setGenerationScreen({
          kind: "image",
          phase: "result",
          statusText: `已生成 ${result.count} 张图片`,
        });
        navigate(`/workbench/create?${resultSearch}`, { replace: true });
        showNotice(`已生成 ${result.count} 张图片`);
        return;
      }

      if (activeEntry === "视频生成") {
        const standaloneBrief = brief.trim();
        const standalonePlan: QuickCreateDirectorPlan = {
          title: standaloneBrief.slice(0, 36) || "灵感视频",
          simpleScript: standaloneBrief,
          stylePrompt: payload.style?.trim() || "电影感",
          ratio: selectedRatio,
          duration: videoTimelineDuration,
          shots: [{
            title: "灵感视频",
            script: standaloneBrief,
            visual: standaloneBrief,
            prompt: standaloneBrief,
            duration: videoTimelineDuration,
            track: "镜头 1",
          }],
        };
        await runStandaloneVideoGeneration(standalonePlan, payload, requestScope, confirmPricing);
        return;
      }
    } catch (error) {
      if (activeAttempt && !shouldRetainStoredSubmissionAttempt(error)) {
        clearStoredSubmissionAttempt(activeAttempt.storageKey);
        const targetRef = imageSubmissionAttemptRef;
        if (targetRef.current?.idempotencyKey === activeAttempt.attempt.idempotencyKey) {
          targetRef.current = null;
        }
      }
      if (isProjectRequestCurrent(requestScope)) {
        const message = normalizeError(error);
        setMaterializing(false);
        setGenerating(false);
        setErrorText(message);
        if (activeEntry === "图片生成" || activeEntry === "视频生成") {
          setGenerationScreen({
            kind: activeEntry === "图片生成" ? "image" : "video",
            phase: "failed",
            statusText: activeEntry === "图片生成" ? "图片生成未完成" : "视频生成未完成",
            error: message,
            errorCode: error && typeof error === "object" && "code" in error ? String(error.code) : undefined,
          });
        }
      }
    } finally {
      generationSubmittingRef.current = false;
      if (isProjectRequestCurrent(requestScope)) setPlanning(false);
    }
  }

  async function handleMaterialize() {
    if (!plan) return;
    if (hasActiveUploads) {
      setErrorText("附件仍在上传中，请等待上传完成后再创建草稿项目");
      return;
    }
    const unsupportedAttachments = useUploadQueueStore.getState().items.filter(
      (attachment) => !isQuickCreateAttachmentAllowed(activeEntry, attachment),
    );
    if (unsupportedAttachments.length) {
      setErrorText(
        `${quickCreateAttachmentRestrictionText(activeEntry)}，请先移除：${unsupportedAttachments
          .map((attachment) => attachment.name)
          .join("、")}`,
      );
      return;
    }
    const configurationError = closedLoopConfigurationError();
    if (configurationError || !selectedImageModel || !selectedVideoModel) {
      setErrorText(configurationError || "闭环创作模型已从服务端目录移除");
      return;
    }
    markSessionEdited();
    const requestScope = beginProjectRequest();
    let targetProjectId: number | null = null;
    let internalSwitchAdopted = false;
    let activeAttempt: {
      storageKey: string;
      attempt: StableSubmissionAttempt;
    } | null = null;
    setMaterializing(true);
    setErrorText("");
    try {
      const standaloneVideo = activeEntry === "视频生成";
      let materializationTimeline: StructuredThirtySecondTimeline | null = null;
      const timelinePlan: QuickCreateDirectorPlan = standaloneVideo
        ? {
            ...plan,
            ratio: selectedRatio,
            duration: videoTimelineDuration,
            shots: plan.shots.slice(0, 1).map((shot) => ({
              ...shot,
              duration: videoTimelineDuration,
            })),
          }
        : (() => {
            const resolvedTimeline = structuredTimeline
              ?? buildStructuredThirtySecondTimeline({ plan, attachments: uploadedTimelineAttachments() });
            materializationTimeline = resolvedTimeline;
            if (resolvedTimeline.shots.length !== plan.shots.length) {
              throw new Error("30 秒时间线与导演计划镜头数不一致，请重新生成时间线");
            }
            return {
              ...plan,
              duration: resolvedTimeline.durationSeconds,
              shots: plan.shots.map((shot, index) => {
                const timelineShot = resolvedTimeline.shots[index];
                if (!timelineShot) return shot;
                return {
                  ...shot,
                  title: timelineShot.title,
                  prompt: timelineShot.prompt,
                  duration: Number((timelineShot.endSeconds - timelineShot.startSeconds).toFixed(3)),
                };
              }),
            };
          })();
      if (!timelinePlan.shots.length) throw new Error("视频生成方案缺少可提交镜头");
      const materializePayload = {
        ...(requestScope.projectId
          ? { sourceProjectId: requestScope.projectId }
          : {}),
        brief: buildDirectorPayload().brief,
        targetType: form.targetType,
        plan: timelinePlan,
        imageModel: resolveQuickCreateImageModel(selectedImageModel.id) || undefined,
        videoModel: selectedVideoModel.id,
        imageQuality,
        generationMode: standaloneVideo ? ("video" as const) : ("closed_loop" as const),
      };
      const preparedAttempt = prepareStoredSubmissionAttempt({
        current: materializeSubmissionAttemptRef.current,
        flow: "quick-create-materialize",
        operationKey: String(requestScope.projectId ?? "new"),
        prefix: "quick-create-materialize",
        payload: materializePayload,
      });
      const materializeAttempt = preparedAttempt.attempt;
      activeAttempt = preparedAttempt;
      materializeSubmissionAttemptRef.current = materializeAttempt;
      const project = await materializeDirectorPlan(
        materializePayload,
        materializeAttempt.idempotencyKey,
      );
      clearStoredSubmissionAttempt(preparedAttempt.storageKey);
      materializeSubmissionAttemptRef.current = null;
      if (!isProjectRequestCurrent(requestScope)) return;

      targetProjectId = project.project.id;
      await refreshAndSelectProject(targetProjectId, {
        expectedCurrentProjectId: requestScope.projectId,
        shouldCommit: () => isProjectRequestCurrent(requestScope),
        onBeforeCommit: () => {
          carryDraftToProjectRef.current = targetProjectId;
        },
        onAfterCommit: () => {
          internalSwitchAdopted = projectRequestEpochRef.current.adoptInternalProjectSwitch(
            requestScope,
            targetProjectId!,
            getCurrentProjectId(),
          );
          if (!internalSwitchAdopted && carryDraftToProjectRef.current === targetProjectId) {
            carryDraftToProjectRef.current = null;
          }
        },
      });
      if (!internalSwitchAdopted || !isProjectRequestCurrent(requestScope)) return;

      try {
        // 只迁移仍持有 File 的本地项；旧项目的 assetVersionId 不能跨项目复用。
        rebindLocalAttachments(targetProjectId);
      } catch (error) {
        carryDraftToProjectRef.current = null;
        clearAttachments();
        throw error;
      }
      if (!isProjectRequestCurrent(requestScope)) return;

      stopTaskPoller();
      setPollerState("idle");
      setPollErrorText("");
      materializedProjectRef.current = project;
      setMaterialized(project);
      setGenerating(false);
      setTasks([]);

      await startAttachmentUploadAndMarkSession(targetProjectId);
      if (!isProjectRequestCurrent(requestScope)) return;
      const currentAttachments = useUploadQueueStore.getState().items;
      const failedUploads = currentAttachments.filter((item) => item.state === "failed");
      if (failedUploads.length) {
        throw new Error(failedUploads.map((item) => `${item.name}：${item.error || "上传失败"}`).join("；"));
      }
      setStructuredTimeline(materializationTimeline
        ? bindStructuredTimelineAttachments({
            timeline: materializationTimeline,
            attachments: uploadedTimelineAttachments(),
          })
        : null);
      startTaskPoller(targetProjectId);
      showNotice(
        currentAttachments.length
          ? `草稿项目已创建，${currentAttachments.length} 个参考已上传`
          : `草稿项目已创建：${project.project.name}`,
      );
    } catch (error) {
      if (activeAttempt && !shouldRetainStoredSubmissionAttempt(error)) {
        clearStoredSubmissionAttempt(activeAttempt.storageKey);
      }
      if (
        activeAttempt
        && !shouldRetainStoredSubmissionAttempt(error)
        && materializeSubmissionAttemptRef.current?.idempotencyKey
          === activeAttempt.attempt.idempotencyKey
      ) {
        materializeSubmissionAttemptRef.current = null;
      }
      if (carryDraftToProjectRef.current !== getCurrentProjectId()) {
        carryDraftToProjectRef.current = null;
      }
      if (isProjectRequestCurrent(requestScope)) setErrorText(normalizeError(error));
    } finally {
      if (isProjectRequestCurrent(requestScope)) setMaterializing(false);
    }
  }

  async function handleGenerateVideos() {
    const project = materializedProjectRef.current;
    if (!project || generating) return;
    if (getCurrentProjectId() !== project.project.id) {
      resetGeneratedState();
      return;
    }
    const unsupportedAttachments = useUploadQueueStore.getState().items.filter(
      (attachment) => !isQuickCreateAttachmentAllowed("视频生成", attachment),
    );
    if (unsupportedAttachments.length) {
      setErrorText(
        `${quickCreateAttachmentRestrictionText("视频生成")}，请先移除：${unsupportedAttachments
          .map((attachment) => attachment.name)
          .join("、")}`,
      );
      return;
    }
    if (!selectedVideoModel || !isVideoModelAvailable(selectedVideoModel)) {
      setErrorText(
        selectedVideoModel?.unavailableReason ||
          `模型「${selectedVideoModel?.label || videoOptions.model}」尚未完成能力验证，暂不能提交付费任务`,
      );
      return;
    }
    if (!selectedVideoModel.resolutions.includes(videoOptions.resolution)) {
      setErrorText("当前视频清晰度不在服务端模型目录中，已阻止提交");
      return;
    }
    if (!selectedVideoModel.aspectRatios.includes(form.ratio)) {
      setErrorText("当前视频比例不在服务端模型目录中，已阻止提交");
      return;
    }
    if (requiredVideoRatio(selectedVideoModel.id, videoOptions.mode) && form.ratio !== "adaptive") {
      setErrorText("当前模式须跟随参考素材比例");
      return;
    }
    if (normalizeVideoDuration(videoOptions.duration, selectedVideoModel.duration) !== videoOptions.duration) {
      setErrorText("当前视频时长不在服务端模型目录中，已阻止提交");
      return;
    }
    if (requiredVideoDuration(selectedVideoModel.id, videoOptions.mode) === -1 && videoOptions.duration !== -1) {
      setErrorText("视频编辑时长须跟随原片");
      return;
    }
    if (!selectedVideoOutputFormats.includes(videoOptions.outputFormat)) {
      setErrorText("当前输出格式不在服务端模型目录中");
      return;
    }
    if (videoOptions.audio && !selectedVideoModel.supportsGenerateAudio) {
      setErrorText("当前视频模型不支持生成音频，已阻止提交");
      return;
    }
    const requestScope = beginProjectRequest();
    let activeAttempt: {
      storageKey: string;
      attempt: StableSubmissionAttempt;
    } | null = null;
    const isVideoRequestCurrent = () => (
      isProjectRequestCurrent(requestScope)
      && materializedProjectRef.current === project
    );
    setGenerating(true);
    setErrorText("");
    try {
      await startAttachmentUploadAndMarkSession(project.project.id);
      if (!isVideoRequestCurrent()) return;
      const currentAttachments = useUploadQueueStore.getState().items;
      const failedUploads = currentAttachments.filter((item) => item.state === "failed");
      if (failedUploads.length) {
        throw new Error(failedUploads.map((item) => `${item.name}：${item.error || "上传失败"}`).join("；"));
      }
      const usableAttachments = currentAttachments.filter(
        (item) => item.mimeType.startsWith("image/")
          || item.mimeType.startsWith("video/")
          || item.mimeType.startsWith("audio/"),
      );
      const pendingUploads = usableAttachments.filter(
        (item) => item.state !== "uploaded" || !item.asset,
      );
      if (pendingUploads.length) {
        throw new Error(
          `${pendingUploads.length} 个参考附件尚未上传：${pendingUploads.map((item) => item.name).join("、")}`,
        );
      }
      if (!plan) throw new Error("导演计划已丢失，请重新生成并创建草稿项目");
      const standaloneVideo = activeEntry === "视频生成";
      const submissionTimeline = structuredTimeline
        ?? buildStructuredThirtySecondTimeline({ plan, attachments: uploadedTimelineAttachments() });
      if (submissionTimeline.shots.length !== project.shots.length) {
        throw new Error(standaloneVideo
          ? "视频方案与草稿项目镜头不一致，请重新创建草稿项目"
          : "30 秒时间线与草稿项目镜头不一致，请重新创建草稿项目");
      }
      const trackData = buildQuickCreateVideoTrackData({
        timeline: submissionTimeline,
        projectShots: project.shots,
        attachments: usableAttachments,
        model: selectedVideoModel,
        ...(standaloneVideo ? {
          audioReferenceMode: "full" as const,
          preferredMode: videoOptions.mode,
          referenceAssignments: videoReferenceAssignments,
        } : {}),
        ...((standaloneVideo || videoOptions.duration === -1) ? { durationOverride: videoOptions.duration } : {}),
      });
      const submissionPayload = {
        projectId: project.project.id,
        scriptId: project.script.id,
        model: selectedVideoModel.id,
        resolution: videoOptions.resolution,
        ...videoOutputFormatRequestField(selectedVideoModel.outputFormatsDeclared === true, videoOptions.outputFormat),
        audio: videoOptions.audio,
        ...(standaloneVideo ? {} : { structuredTimeline: submissionTimeline }),
        trackData,
      };
      const preparedAttempt = prepareStoredSubmissionAttempt({
        current: videoSubmissionAttemptRef.current,
        flow: "quick-create-video",
        operationKey: String(project.project.id),
        prefix: "quick-create-video",
        payload: submissionPayload,
      });
      const attempt = preparedAttempt.attempt;
      activeAttempt = preparedAttempt;
      videoSubmissionAttemptRef.current = attempt;
      const initialPricing = modelPlazaPricingOptions(
        modelPlazaInitialSelection,
        "video",
        selectedVideoModel.id,
      );
      const submittedTasks = await confirmPricingRetry(
        () => initialPricing
          ? generateQuickCreateVideos(submissionPayload, attempt.idempotencyKey, initialPricing)
          : generateQuickCreateVideos(submissionPayload, attempt.idempotencyKey),
        () => generateQuickCreateVideos(submissionPayload, attempt.idempotencyKey, { confirmPricing: true }),
      );
      const pendingReconcile = hasPendingReconcileSubmission(submittedTasks);
      if (!pendingReconcile) {
        clearStoredSubmissionAttempt(preparedAttempt.storageKey);
        videoSubmissionAttemptRef.current = null;
      }
      if (!isVideoRequestCurrent()) return;
      setTasks(submittedTasks);

      const poller = startTaskPoller(project.project.id);
      await poller.refresh();
      if (!isVideoRequestCurrent()) return;
      const rejectedTasks = submittedTasks.filter((task) => (
        task.status !== "pending_reconcile" && (task.status === "failed"
        || task.status === "cancelled"
        || Boolean(task.errorReason))
      ));
      if (pendingReconcile) {
        setErrorText("任务与 GU 正在待核，请勿重复提交；请使用“刷新任务状态”安全恢复。");
        showNotice("任务待核，已保留本次安全重试标识");
      } else if (rejectedTasks.length) {
        setErrorText(
          rejectedTasks.map((task) => (
            `镜头 ${task.trackId}：${task.errorReason || "未成功进入上游队列"}`
          )).join("；"),
        );
      } else {
        showNotice("镜头视频任务已提交");
      }
    } catch (error) {
      if (activeAttempt && !shouldRetainStoredSubmissionAttempt(error)) {
        clearStoredSubmissionAttempt(activeAttempt.storageKey);
        if (
          videoSubmissionAttemptRef.current?.idempotencyKey
          === activeAttempt.attempt.idempotencyKey
        ) {
          videoSubmissionAttemptRef.current = null;
        }
      }
      if (isVideoRequestCurrent()) setErrorText(normalizeError(error));
    } finally {
      if (isVideoRequestCurrent()) setGenerating(false);
    }
  }

  function togglePanel(panel: PanelName) {
    setActivePanel((current) => (current === panel ? null : panel));
  }

  function openModelPanel() {
    if (activePanel === "models") {
      setActivePanel(null);
      return;
    }
    setModelTab(activeEntry === "图片生成" ? "图片" : activeEntry === "视频生成" ? "视频" : "对话");
    setActivePanel("models");
  }

  function projectModeHref(mode: "agent" | "canvas", generateMode = "agent") {
    const href = buildProjectModeHref(mode, {
      projectId: numericProjectId,
      sessionId: session?.id,
      canvasId: session?.canvasId,
    });
    if (mode !== "agent" || generateMode === "agent") return href;
    const [pathname, search = ""] = href.split("?");
    const params = new URLSearchParams(search);
    params.set("mode", generateMode);
    return `${pathname}?${params.toString()}`;
  }

  function openKanbanMode() {
    navigate(projectModeHref("canvas"), {
      state: { brief: form.brief, fromFrontstage: true },
    });
  }

  function openQuickMode() {
    navigate(buildProjectModeHref("quick", {
      projectId: numericProjectId,
      sessionId: session?.id,
      canvasId: session?.canvasId,
    }), {
      state: { fromFrontstage: true },
    });
  }

  function selectMode(mode: string) {
    if (mode === "快速模式") {
      if (
        modelCatalogLoading
        || !(runtimeAvailability.llm && runtimeAvailability.image && runtimeAvailability.video)
      ) {
        setErrorText(modelCatalogLoading
          ? "模型目录仍在加载，请稍后再进入快速模式"
          : "快速模式需要对话、图片和视频模型全部具备真实可提交能力");
        return;
      }
      openQuickMode();
      return;
    }
    if (mode === "画布模式") {
      openKanbanMode();
      return;
    }
    const generateMode = generateModeParams[mode];
    if (generateMode) {
      navigate(projectModeHref("agent", generateMode), { state: { brief: form.brief } });
      return;
    }
    if (modelCatalogLoading) {
      setErrorText("模型目录仍在加载，请稍后再切换创作类型");
      return;
    }
    if (!isQuickCreateEntryRuntimeAvailable(mode, runtimeAvailability)) {
      setErrorText(
        modelCatalogError
          ? `模型目录读取失败：${modelCatalogError}`
          : mode === "图片生成"
            ? "图片生成需要服务端目录中存在真实可提交的图片模型"
            : `${mode}需要对话、图片和视频模型全部具备真实可提交能力`,
      );
      setActivePanel(null);
      return;
    }
    if (hasActiveUploads) {
      setErrorText("附件仍在上传中，请等待完成后再切换创作类型");
      return;
    }
    const incompatibleAttachments = attachments.filter(
      (attachment) => !isQuickCreateAttachmentAllowed(mode, attachment),
    );
    if (incompatibleAttachments.length) {
      setErrorText(
        `${quickCreateAttachmentRestrictionText(mode)}，请先移除：${incompatibleAttachments
          .map((attachment) => attachment.name)
          .join("、")}`,
      );
      return;
    }
    const nextAttachmentLimit = resolveQuickCreateAttachmentLimit(mode);
    if (attachments.length > nextAttachmentLimit) {
      setErrorText(
        `图片生成最多使用 ${nextAttachmentLimit} 个图片参考，请先移除多余附件后再切换`,
      );
      return;
    }
    markSessionEdited();
    setActiveEntry(mode);
    setActivePanel(null);
    resetGeneratedState();
    if (mode === "图片生成") {
      setPreferenceTab("图片");
      setModelTab("图片");
    }
    if (mode === "Agent 模式") setModelTab("对话");
    if (mode === "Agent 模式" || mode === "视频生成") setPreferenceTab("视频");
    if (mode === "视频生成") setModelTab("视频");
    setForm((current) => ({
      ...current,
      targetType: mode === "图片生成" ? "图片生成" : mode === "视频生成" ? "视频生成" : "广告视频",
    }));
  }

  function selectVideoMode(mode: string) {
    if (!selectedVideoModel || !selectedVideoModel.modes.includes(mode)) {
      setErrorText("当前模型不支持所选视频生成模式");
      return;
    }
    const resolved = assignVideoReferencesForMode({
      model: selectedVideoModel,
      mode,
      attachments: orderedVideoAttachments,
      previous: videoReferenceAssignments,
    });
    if (!resolved.ok) {
      setErrorText(resolved.message);
      return;
    }
    if (mode !== videoOptions.mode) markSessionEdited();
    setVideoOptions((current) => ({ ...current, mode,
      duration: requiredVideoDuration(selectedVideoModel.id, mode) ?? current.duration }));
    const requiredRatio = requiredVideoRatio(selectedVideoModel.id, mode);
    if (requiredRatio && selectedRatio !== requiredRatio && selectedVideoModel.aspectRatios.includes(requiredRatio)) {
      setSelectedRatio(requiredRatio);
      setForm((current) => ({ ...current, ratio: requiredRatio }));
    }
    setVideoReferenceAssignments(resolved.assignments);
    setErrorText("");
    setActivePanel(null);
    resetGeneratedState();
  }

  function selectVideoModel(model: QuickCreateVideoModelOption) {
    if (!isVideoModelAvailable(model)) {
      setErrorText(model.unavailableReason || "当前视频模型暂不可执行");
      return;
    }
    const candidateModes = attachments.length
      ? Array.from(new Set([
          videoOptions.mode,
          ...model.modes,
        ])).filter(Boolean)
      : [
          model.modes.includes("text_to_video") ? "text_to_video" : "",
          model.modes[0] || "",
        ].filter(Boolean);
    let selectedMode = "";
    let selectedAssignments: Record<string, VideoReferenceAssignment> = {};
    for (const mode of candidateModes) {
      if (!model.modes.includes(mode)) continue;
      const resolved = assignVideoReferencesForMode({
        model,
        mode,
        attachments: orderedVideoAttachments,
        previous: videoReferenceAssignments,
      });
      if (!resolved.ok) continue;
      selectedMode = mode;
      selectedAssignments = resolved.assignments;
      break;
    }
    if (!selectedMode) {
      setErrorText("已添加的参考素材与该模型所有生成模式均不兼容，请先移除或替换参考素材");
      return;
    }
    if (model.id !== videoOptions.model) markSessionEdited();
    setVideoOptions((current) => ({
      model: model.id,
      resolution: model.resolutions.includes(current.resolution)
        ? current.resolution
        : model.defaultResolution,
      duration: requiredVideoDuration(model.id, selectedMode) ?? normalizeVideoDuration(
        current.model !== model.id && model.duration.auto && model.duration.default === -1
          ? -1 : current.duration,
        model.duration,
      ),
      audio: model.supportsGenerateAudio ? current.audio : false,
      mode: selectedMode,
      outputFormat: normalizeDefaultVideoOutputFormat(current.outputFormat || model.defaultOutputFormat,
        normalizeVideoOutputFormats(model.outputFormats)),
    }));
    setVideoReferenceAssignments(selectedAssignments);
    const requiredRatio = requiredVideoRatio(model.id, selectedMode);
    if (!model.aspectRatios.includes(selectedRatio) || requiredRatio && selectedRatio !== requiredRatio) {
      const nextRatio = requiredRatio && model.aspectRatios.includes(requiredRatio) ? requiredRatio : model.defaultAspectRatio;
      setSelectedRatio(nextRatio);
      setForm((current) => ({ ...current, ratio: nextRatio }));
    }
    setErrorText("");
    setActivePanel(null);
    resetGeneratedState();
  }

  function openVideoReferencePicker(request: VideoReferencePickerRequest) {
    if (!fileInputRef.current) return;
    videoReferencePickerRef.current = request;
    fileInputRef.current.accept = request.kind === "image"
      ? "image/*"
      : request.kind === "video"
        ? "video/*"
        : "image/*,video/*,audio/*";
    fileInputRef.current.multiple = Boolean(request.multiple);
    fileInputRef.current.click();
  }

  function removeVideoReference(clientId: string) {
    markSessionEdited();
    pendingReferenceMentions.current.delete(clientId);
    const ordered = activeEntry === "视频生成" ? orderedVideoAttachments : attachments;
    setForm(current => ({...current, brief: remapReferenceMentions(current.brief, ordered, ordered.filter(item => item.clientId !== clientId))}));
    removeAttachment(clientId);
    setVideoReferenceAssignments((current) => {
      const next = { ...current };
      delete next[clientId];
      return next;
    });
    resetGeneratedState();
  }

  function moveVideoReference(clientId: string, direction: -1 | 1) {
    const currentIndex = orderedVideoAttachments.findIndex((item) => item.clientId === clientId);
    const targetIndex = currentIndex + direction;
    if (currentIndex < 0 || targetIndex < 0 || targetIndex >= orderedVideoAttachments.length) return;
    const reordered = [...orderedVideoAttachments];
    [reordered[currentIndex], reordered[targetIndex]] = [reordered[targetIndex], reordered[currentIndex]];
    const resolved = selectedVideoModel ? assignVideoReferencesForMode({
      model: selectedVideoModel,
      mode: videoOptions.mode,
      attachments: reordered,
      previous: Object.fromEntries(reordered.map((item, order) => [
        item.clientId,
        { ...videoReferenceAssignments[item.clientId], order },
      ])),
    }) : null;
    if (!resolved?.ok) return;
    markSessionEdited();
    setForm(current => ({...current, brief: remapReferenceMentions(current.brief, orderedVideoAttachments, reordered)}));
    setVideoReferenceAssignments(resolved.assignments);
    resetGeneratedState();
  }

  async function importSourceCase(item: InspirationCase, idea: string, restoredBrief?: string) {
    if (!item.original || sourceImportBusyRef.current || hasActiveUploads || !sessionHydrated) throw new Error("创作区正在准备，请稍后重试");
    const setup = sourceVideoSetup(item.original, videoModels);
    const before = activeEntry === "视频生成" ? orderedVideoAttachments : attachments;
    if (before.length + item.original.references.length > setup.model.totalInputLimit) throw new Error(`当前已有 ${before.length} 份参考，加入完整案例将超出模型上限。请先整理现有参考，再带入；已有内容已保留。`);
    const requestScope = beginProjectRequest();
    const beforeIds = before.map(ref => ref.clientId);
    sourceImportBusyRef.current = true; setSourceImportBusy(true);
    try {
      const files = await loadSourceReferenceFiles(item.original);
      if (!isProjectRequestCurrent(requestScope)) throw new Error("创作工作区已切换，请重新带入");
      const current = useUploadQueueStore.getState().items;
      if (current.length !== before.length || current.some(ref => !beforeIds.includes(ref.clientId))) throw new Error("参考素材已变化，请重新带入");
      const validation = referenceRequirementError(setup.model.id, setup.mode, files.map(file => ({kind: referenceKind(file), name: file.name, mimeType: file.type, size: file.size})), {checkCombination: false});
      if (validation) throw new Error(validation);
      const incoming = buildSourcePrompt(item, idea, before.length);
      const combinedBrief = appendCreativeBrief(restoredBrief ?? form.brief, incoming);
      if (combinedBrief.length > 20_000) throw new Error("加入完整原始提示词后超过 20,000 字符，请先整理当前想法再带入；已有内容与案例均已保留。");
      // Project materialization uses the existing local draft flow and never starts generation.
      const projectId = await ensureInspirationReferenceProject(requestScope, incoming);
      if (!isProjectRequestCurrent(requestScope)) throw new Error("创作工作区已切换，请重新带入");
      const {added, errors} = addAttachmentFiles(files);
      const addedItems = useUploadQueueStore.getState().items.filter(ref => !beforeIds.includes(ref.clientId));
      const ordered = [...before, ...addedItems];
      const resolved = assignVideoReferencesForMode({model: setup.model, mode: setup.mode, attachments: ordered,
        previous: Object.fromEntries(ordered.map((ref, order) => [ref.clientId, {order}]))});
      if (errors.length || added !== files.length || !resolved.ok) {
        addedItems.forEach(ref => removeAttachment(ref.clientId));
        throw new Error(errors.join("；") || (!resolved.ok ? resolved.message : "素材未完整加入，请重试"));
      }
      // Keep the same slot order used to translate <<<image_1_2>>> into @参考2.
      setVideoReferenceAssignments(resolved.assignments);
      setActiveEntry("视频生成"); setPreferenceTab("视频"); setAutoEnabled(false);
      setSelectedRatio(setup.ratio);
      setVideoOptions({model: setup.model.id, mode: setup.mode, resolution: setup.resolution, duration: setup.duration, audio: setup.audio,
        outputFormat: normalizeDefaultVideoOutputFormat(setup.model.defaultOutputFormat, normalizeVideoOutputFormats(setup.model.outputFormats))});
      setForm(current => ({...current, brief: combinedBrief, ratio: setup.ratio, duration: setup.duration, targetType: "视频生成"}));
      markSessionEdited(); resetGeneratedState(); setActivePanel(null);
      let uploaded;
      try {
        uploaded = await startAttachmentUploadAndMarkSession(projectId);
        if (!isProjectRequestCurrent(requestScope)) return;
        if (uploaded.uploaded > 0) await persistUploadedAttachmentsImmediately(projectId);
      } catch (error) {
        if (isProjectRequestCurrent(requestScope)) setErrorText(`案例已加入草稿，保存尚未完成：${normalizeError(error)}。请在参考栏重试，不必再次带入。`);
        return;
      }
      // A failed upload stays in the normal queue for retry; never re-add a partial batch.
      if (uploaded.failed) setErrorText(`${uploaded.failed} 份案例素材上传失败，请在参考栏重试，全部上传完成后再生成。`);
      else setErrorText("");
      showNotice(item.original.options.durationMode === "auto"
        ? `已带入 ${added} 份原始素材。原站为自动时长，当前按参数值 ${setup.duration} 秒载入，可继续调整。`
        : `已带入原始提示词、${added} 份参考素材和生成参数`);
      requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-testid="quick-director-brief"]')?.scrollIntoView({block:"center",behavior:"smooth"}));
    } finally { sourceImportBusyRef.current = false; if (mountedRef.current) setSourceImportBusy(false); }
  }

  function handleFilesSelected(files: FileList | null) {
    if (!files?.length) {
      videoReferencePickerRef.current = null;
      return;
    }
    const pickerRequest = activeEntry === "视频生成" ? videoReferencePickerRef.current : null;
    videoReferencePickerRef.current = null;
    const attachmentLimit = resolveQuickCreateAttachmentLimit(
      activeEntry,
      activeEntry === "视频生成" ? selectedVideoModel?.totalInputLimit : undefined,
    );
    const replacedAttachment = pickerRequest?.replaceClientId
      ? attachments.find((attachment) => attachment.clientId === pickerRequest.replaceClientId) || null
      : null;
    const modeLimit = activeEntry === "视频生成"
      ? Math.min(attachmentLimit, selectedVideoModeInputLimit || attachmentLimit)
      : attachmentLimit;
    const remaining = Math.max(0, modeLimit - attachments.length + (replacedAttachment ? 1 : 0));
    const selected = Array.from(files);
    const matchesPicker = (file: File) => !pickerRequest
      || pickerRequest.kind === "mixed"
      || referenceKind(file) === pickerRequest.kind;
    const compatible = selected.filter((file) => isQuickCreateAttachmentAllowed(activeEntry, file) && matchesPicker(file));
    const rejected = selected.filter((file) => !isQuickCreateAttachmentAllowed(activeEntry, file) || !matchesPicker(file));
    const overflowByKind: Record<QuickCreateVideoAttachmentKind, number> = {
      image: 0,
      video: 0,
      file: 0,
    };
    const requirementErrors: string[] = [];
    const accepted = activeEntry === "视频生成" && selectedVideoModel
      ? compatible.reduce<File[]>((result, file) => {
        const kind = referenceKind(file);
        const requirementError = referenceRequirementError(selectedVideoModel.id, videoOptions.mode, [{ kind, name: file.name, mimeType: file.type, size: file.size }], { checkCombination: false });
        if (requirementError) {
          requirementErrors.push(requirementError);
          return result;
        }
        const currentAttachments = attachments.filter((attachment) => (
          attachment.clientId !== replacedAttachment?.clientId
        ));
        const alreadyUsed = currentAttachments.filter((attachment) => referenceKind(attachment) === kind).length;
        const acceptedOfKind = result.filter((candidate) => referenceKind(candidate) === kind).length;
        const kindLimit = Math.min(
          modeLimit,
          selectedVideoModeSlots
            .filter((slot) => (
              slot.accepts.includes(kind)
              && (!pickerRequest?.preferredRole || slot.roles.includes(pickerRequest.preferredRole))
            ))
            .reduce((total, slot) => total + slot.max, 0),
        );
        if (result.length >= remaining || alreadyUsed + acceptedOfKind >= kindLimit) {
          overflowByKind[kind] += 1;
          return result;
        }
        result.push(file);
        return result;
      }, [])
      : compatible.slice(0, remaining);
    const beforeIds = new Set(useUploadQueueStore.getState().items.map((item) => item.clientId));
    const { added, errors } = addAttachmentFiles(accepted);
    errors.push(...requirementErrors);
    if (rejected.length) {
      errors.push(
        `${quickCreateAttachmentRestrictionText(activeEntry)}：${rejected
          .map((file) => file.name)
          .join("、")}`,
      );
    }
    if (activeEntry === "视频生成") {
      const kindLabel: Record<QuickCreateVideoAttachmentKind, string> = {
        image: "参考图片",
        video: "参考视频",
        file: "参考音频",
      };
      (Object.entries(overflowByKind) as Array<[QuickCreateVideoAttachmentKind, number]>).forEach(([kind, count]) => {
        if (!count) return;
        const limit = Math.min(
          modeLimit,
          selectedVideoModeSlots
            .filter((slot) => slot.accepts.includes(kind))
            .reduce((total, slot) => total + slot.max, 0),
        );
        errors.push(`${kindLabel[kind]}最多 ${limit} 个（本次忽略 ${count} 个）`);
      });
    } else if (compatible.length > accepted.length) {
      errors.push(`当前模式最多添加 ${modeLimit} 个参考素材`);
    }
    if (errors.length) setErrorText(errors.join("；"));
    if (!added) return;
    const newAttachments = useUploadQueueStore.getState().items.filter((item) => !beforeIds.has(item.clientId));
    const candidateAttachments = useUploadQueueStore.getState().items.filter((item) => (
      item.clientId !== replacedAttachment?.clientId
    ));
    if (activeEntry === "视频生成" && selectedVideoModel) {
      const replacedAssignment = replacedAttachment
        ? videoReferenceAssignments[replacedAttachment.clientId]
        : undefined;
      const seededAssignments = {
        ...videoReferenceAssignments,
        ...Object.fromEntries(newAttachments.map((item, index) => [item.clientId, {
          ...(replacedAssignment || {}),
          ...(pickerRequest?.preferredRole ? { preferredRole: pickerRequest.preferredRole } : {}),
          order: replacedAssignment?.order ?? orderedVideoAttachments.length + index,
        }])),
      };
      const resolved = assignVideoReferencesForMode({
        model: selectedVideoModel,
        mode: videoOptions.mode,
        attachments: candidateAttachments,
        previous: seededAssignments,
      });
      if (!resolved.ok) {
        newAttachments.forEach((item) => removeAttachment(item.clientId));
        setErrorText(resolved.message);
        return;
      }
      if (replacedAttachment) removeAttachment(replacedAttachment.clientId);
      setVideoReferenceAssignments(resolved.assignments);
    }
    newAttachments.forEach(item => pendingReferenceMentions.current.add(item.clientId));
    markSessionEdited();
    showNotice(`已加入 ${added} 个参考，正在保存到灵感工作区`);

    const targetProject = materializedProjectRef.current;
    const targetProjectId = targetProject?.project.id;
    const isTargetProjectCurrent = () => (
      mountedRef.current
      && getCurrentSessionProjectId() === targetProjectId
      && materializedProjectRef.current === targetProject
    );
    if (targetProjectId) {
      void startAttachmentUploadAndMarkSession(targetProjectId).then(async (result) => {
        if (result.uploaded > 0) await persistUploadedAttachmentsImmediately(targetProjectId);
        const failed = useUploadQueueStore.getState().items.filter((item) => item.state === "failed");
        if (failed.length && isTargetProjectCurrent()) {
          setErrorText(failed.map((item) => `${item.name}：${item.error || "上传失败"}`).join("；"));
        }
      }).catch((error) => {
        if (isTargetProjectCurrent()) setErrorText(normalizeError(error));
      });
      return;
    }

    const requestScope = beginProjectRequest();
    void ensureInspirationReferenceProject(
      requestScope,
      form.brief.trim() || "灵感参考素材",
    ).then(async (projectId) => {
      if (!isProjectRequestCurrent(requestScope)) return;
      const result = await startAttachmentUploadAndMarkSession(projectId);
      if (!isProjectRequestCurrent(requestScope)) return;
      if (result.uploaded > 0) await persistUploadedAttachmentsImmediately(projectId);
      if (!isProjectRequestCurrent(requestScope)) return;
      const failed = useUploadQueueStore.getState().items.filter((item) => item.state === "failed");
      if (failed.length) {
        setErrorText(failed.map((item) => `${item.name}：${item.error || "上传失败"}`).join("；"));
        return;
      }
      if (result.uploaded > 0) showNotice(`${result.uploaded} 个参考已保存到灵感工作区`);
    }).catch((error) => {
      if (isProjectRequestCurrent(requestScope)) setErrorText(normalizeError(error));
    });
  }

  return (
    <main data-testid="quick-director-page" data-feedback-page-title={activeEntry} className={`jimengWorkbench jimengCreateWorkbench ${dark ? "themeDark" : "themeLight"}`} onClick={() => setActivePanel(null)}>
      <section className="jimengShell">
        <FrontstageNav active="inspiration" dark={dark} onToggleDark={theme.toggle} onNotice={showNotice} />

        <div className="jimengMainPane">
          {activeGenerationScreen ? (
            <GenerationSessionView
              screen={activeGenerationScreen}
              prompt={previewGenerationSession
                ? "电影感的东方未来城市，雨后清晨，16:9"
                : activeGenerationScreen.kind === "image"
                  ? displayedImageAssets[0]?.prompt || form.brief
                  : displayedVideoTasks[0]?.prompt || form.brief}
              imageAssets={displayedImageAssets}
              videoTasks={displayedVideoTasks}
              modelLabel={activeGenerationScreen.kind === "image"
                ? imageModels.find((model) => model.id === routedImageModel)?.label
                  || displayedImageAssets[0]?.model
                  || selectedImageModel?.label
                  || "图片生成"
                : selectedVideoModel?.label || "视频生成"}
              ratio={activeGenerationScreen.kind === "image"
                ? routedImageRatio || selectedRatio
                : selectedRatio}
              resolution={activeGenerationScreen.kind === "image"
                ? routedImageQuality || imageQuality
                : videoOptions.resolution}
              requestedCount={previewGenerationSession
                ? 4
                : activeGenerationScreen.kind === "image"
                  ? displayedImageAssets.length
                  : imageCount}
              onBack={closeGenerationScreen}
              onNewGeneration={closeGenerationScreen}
              onOpenAssets={() => navigate("/workbench/assets")}
              onAddToProject={() => void continueGenerationInProject("quick")}
              onOpenInCanvas={() => void continueGenerationInProject("canvas")}
              continuingMode={continuingGenerationMode}
              onUseImageForVideo={useGeneratedImageForVideo}
              onContinue={continueGenerationFromSession}
              onRetry={() => void handleGeneratePlan()}
              onConfirmPricing={() => void handleGeneratePlan(form.brief, true)}
              onRefresh={() => {
                if (activeGenerationScreen.errorCode === PORTRAIT_PREPARATION_PENDING
                  && videoSubmissionAttemptRef.current && standaloneVideoRetryContextRef.current) {
                  void handleGeneratePlan();
                } else {
                  void refreshTaskPoller();
                }
              }}
              onNotice={showNotice}
            />
          ) : (
            <>
          <section className="jimengHero">
            <p>AI VIDEO CREATION COMMAND CENTER</p>
            <h1>
              让想象抵达画面，从{" "}
              <button
                className="jimengTitleMode"
                type="button"
                disabled={!sessionHydrated}
                onClick={(event) => {
                  event.stopPropagation();
                  togglePanel("mode");
                }}
              >
                {activeEntry}
                <ChevronRight className="jimengTitleChevron" size={22} />
              </button>{" "}
              开始
            </h1>
          </section>

          <fieldset
            className="jimengCreatorStage"
            disabled={!sessionHydrated || sourceImportBusy}
            aria-busy={!sessionHydrated || sourceImportBusy}
          >
            <section className="jimengComposerPanel" onClick={(event) => event.stopPropagation()}>
              {hasComposerContent && sessionHydrated ? (
                <button
                  className="jimengComposerReset"
                  type="button"
                  aria-label="重置创作内容"
                  title="清空提示词、参考素材和已选技能"
                  disabled={planning || materializing || generating}
                  onClick={resetComposer}
                >
                  <X size={18} aria-hidden="true" />
                </button>
              ) : null}
              {pendingGuestDraft && sessionHydrated && (form.brief.trim() || pendingGuestDraft.sourceCaseId) ? (
                <div className="guestDraftRecovery" role="status">
                  <span>{pendingGuestDraft.sourceCaseId ? "已保留登录前选择的同款素材，点击后带入当前创作区。" : "已保留登录前的创作想法。当前工作区也有草稿，请选择要继续的内容。"}</span>
                  <button type="button" disabled={sourceImportBusy} onClick={() => void restoreGuestDraft()}>{pendingGuestDraft.sourceCaseId ? "带入登录前选好的同款素材" : "使用登录前的想法"}</button>
                  <button type="button" onClick={() => { clearGuestDraft(); setPendingGuestDraft(null); }}>保留当前草稿</button>
                </div>
              ) : null}
              {!sessionHydrated ? (
                <span className="jimengSessionHydrationStatus" role="status">
                  正在恢复项目草稿…
                </span>
              ) : null}
              <div className={`jimengComposerTop ${activeEntry === "视频生成" ? "videoComposerTop" : ""} ${activeEntry === "视频生成" && (videoOptions.mode === "text_to_video" || videoOptions.mode === "standard") ? "textOnly" : ""}`}>
                {activeEntry === "视频生成" ? (
                  <VideoReferenceComposer
                    approvedAssetVersionIds={approvedAssetVersionIds}
                    mode={videoOptions.mode}
                    attachments={orderedVideoAttachments}
                    assignments={videoReferenceAssignments}
                    maxItems={selectedVideoModeInputLimit}
                    capacity={selectedVideoReferenceCapacity}
                    onAdd={openVideoReferencePicker}
                    onRemove={removeVideoReference}
                    onMove={moveVideoReference}
                  />
                ) : (
                  <button
                    className="jimengUploadTile"
                    type="button"
                    aria-label="上传参考"
                    onClick={() => {
                      videoReferencePickerRef.current = null;
                      fileInputRef.current?.click();
                    }}
                  >
                    <Plus size={24} />
                    <span className="jimengUploadLabel" aria-hidden="true">
                      上传
                      <br />
                      参考
                    </span>
                  </button>
                )}
                <input
                  ref={fileInputRef}
                  className="jimengHiddenInput"
                  type="file"
                  multiple
                  accept={quickCreateAttachmentAccept(activeEntry)}
                  onChange={(event) => {
                    handleFilesSelected(event.target.files);
                    event.currentTarget.value = "";
                  }}
                />
                <textarea
                  ref={briefInputRef}
                  data-testid="quick-director-brief"
                  value={form.brief}
                  onChange={(event) => {
                    const nextBrief = event.target.value;
                    if (nextBrief !== form.brief) markSessionEdited();
                    setForm((current) => ({ ...current, brief: nextBrief }));
                    if (/@\s*$/.test(nextBrief)) {
                      setSubjectQuery("");
                      setActivePanel("subjects");
                    }
                    resetGeneratedState();
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
                    event.preventDefault();
                    if (!planning && !hasActiveUploads && activeEntryAvailable) void handleGeneratePlan();
                  }}
                  placeholder={activeEntry === "视频生成"
                    ? videoModePlaceholder(videoOptions.mode)
                    : activeEntry === "Agent 模式"
                      ? "告诉 Agent 你的创作目标，发送后继续对话与创作"
                      : "输入想法、剧本或上传真实参考素材"}
                />
              </div>
              {activeEntry === "视频生成" && selectedVideoModel ? <ReferenceRequirementsHint modelId={selectedVideoModel.id} mode={videoOptions.mode} totalLimit={selectedVideoModeInputLimit} limits={{
                image: Math.min(selectedVideoModeInputLimit, selectedVideoModeSlots.filter((slot) => slot.accepts.includes("image")).reduce((sum, slot) => sum + slot.max, 0)),
                video: Math.min(selectedVideoModeInputLimit, selectedVideoModeSlots.filter((slot) => slot.accepts.includes("video")).reduce((sum, slot) => sum + slot.max, 0)),
                file: Math.min(selectedVideoModeInputLimit, selectedVideoModeSlots.filter((slot) => slot.accepts.includes("file")).reduce((sum, slot) => sum + slot.max, 0)),
              }} /> : null}

              {activeEntry === "视频生成" && attachmentRetryProjectId && attachments.some(item => item.state === "failed") ? (
                <button type="button" className="jimengControlBtn" disabled={hasActiveUploads}
                  onClick={async () => {
                    const projectId = attachmentRetryProjectId;
                    try {
                      const result = await retryFailedAttachments(projectId);
                      if (getCurrentSessionProjectId() !== projectId) return;
                      if (result.uploaded > 0) await persistUploadedAttachmentsImmediately(projectId);
                      setErrorText(result.failed ? "仍有素材上传失败，请重试。全部上传完成后再生成。" : "");
                    } catch (error) { setErrorText(normalizeError(error)); }
                  }}><RefreshCw size={14} />重试失败素材</button>
              ) : null}

              {(activeEntry !== "视频生成" && attachments.length) || selectedSkills.length || selectedSubjects.length ? (
                <div className="jimengContextChips" role="region" aria-label="创作上下文">
                  {activeEntry !== "视频生成" ? attachments.map((attachment, index) => (
                    <span
                      className={`jimengContextChip mediaChip ${attachment.state}`}
                      key={attachment.clientId}
                      title={attachment.state === "failed" ? attachment.error : undefined}
                    >
                      {quickCreateAttachmentKind(attachment) === "image" ? (
                        <ReferencePreviewImage src={attachment.previewUrl} alt="" />
                      ) : quickCreateAttachmentKind(attachment) === "video" ? (
                        <ReferencePreviewVideo src={attachment.previewUrl} aria-label={`预览 ${attachment.name}`} muted />
                      ) : attachment.mimeType.startsWith("audio/") ? (
                        <ReferencePreviewAudio src={attachment.previewUrl} aria-label={`播放 ${attachment.name}`} controls />
                      ) : <FileText size={16} />}
                      <strong>{`@参考${index + 1}`} · {attachment.name}</strong>
                      <PortraitAdmissionIndicator name={attachment.name} approved={approvedAssetVersionIds.includes(Number(attachment.asset?.assetVersionId))} />
                      <small>{formatAttachmentSize(attachment.size)} · {attachmentStateText(attachment)}</small>
                      <AttachmentUploadProgress attachment={attachment} />
                      {attachment.state === "failed" && attachmentRetryProjectId ? (
                        <button
                          type="button"
                          aria-label={`重试 ${attachment.name}`}
                          onClick={() => {
                            markSessionEdited();
                            void retryFailedAttachments(attachmentRetryProjectId)
                              .then((result) => {
                                if (result.uploaded > 0) markSessionEdited();
                                if (result.failed) setErrorText("仍有附件上传失败，请检查单项错误后重试");
                              })
                              .catch((error) => setErrorText(normalizeError(error)));
                          }}
                        >
                          <Loader2 size={12} />
                        </button>
                      ) : null}
                      <button
                        type="button"
                        aria-label={`移除 ${attachment.name}`}
                        disabled={attachment.state === "uploading"}
                        onClick={() => {
                          markSessionEdited();
                          removeVideoReference(attachment.clientId);
                        }}
                      >
                        <X size={13} />
                      </button>
                    </span>
                  )) : null}
                  {selectedSubjects.map((subject) => (
                    <span className="jimengContextChip" key={subject.id} data-testid="quick-subject-chip">
                      {subject.image ? <ReferencePreviewImage src={subject.image} alt="" /> : <FolderOpen size={15} />}
                      <strong>@{subject.name}</strong>
                      <PortraitAdmissionIndicator name={subject.name} approved={approvedAssetVersionIds.includes(Number(subject.assetVersionId))} />
                      <small>{subject.type}</small>
                      <button type="button" aria-label={`移除资产 ${subject.name}`} onClick={() => toggleSubject(subject)}>
                        <X size={13} />
                      </button>
                    </span>
                  ))}
                  {selectedSkills.map((skill) => (
                    <span className="jimengContextChip" key={skill.id} data-testid="quick-skill-chip">
                      <Wrench size={15} />
                      <strong>{skill.name}</strong>
                      <small>技能</small>
                      <button type="button" aria-label={`移除技能 ${skill.name}`} onClick={() => toggleSkill(skill)}>
                        <X size={13} />
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}

              <PortraitAdmissionPanel
                variant="references"
                model={selectedVideoModel?.id}
                onApprovalChange={onApprovalChange}
                projectId={sessionProjectId}
                assets={[...attachments.flatMap((attachment) => {
                  if (attachmentProjectId !== sessionProjectId) return [];
                  const asset = attachment.asset;
                  if (attachment.state !== "uploaded" || !asset || (asset.type !== "image" && asset.type !== "video")) return [];
                  return [{
                    assetVersionId: asset.assetVersionId,
                    name: attachment.name,
                    previewUrl: attachment.previewUrl,
                    mediaType: asset.type,
                  }];
                }), ...selectedSubjects.flatMap((subject) => (
                  subject.assetVersionId && subject.mediaType
                    ? [{
                        assetVersionId: subject.assetVersionId,
                        name: subject.name,
                        previewUrl: subject.image,
                        mediaType: subject.mediaType,
                      }]
                    : []
                ))]}
              />

              <div className="jimengComposerControls">
                <div className="jimengCommandGroup">
                  <button className={`jimengCommandButton ${activePanel === "mode" ? "active" : ""}`} type="button" onClick={(event) => {
                    event.stopPropagation();
                    togglePanel("mode");
                  }}>
                    <WandSparkles size={16} />
                    {activeEntry}
                    <ChevronRight className="jimengButtonChevron" size={15} />
                  </button>
                  <button className={`jimengCommandButton ${activePanel === "models" ? "active" : ""}`} type="button" onClick={(event) => {
                    event.stopPropagation();
                    openModelPanel();
                  }}>
                    <Bot size={16} />
                    模型 · {modelCatalogLoading
                      ? "加载中"
                      : activeEntry === "图片生成"
                        ? selectedImageModel?.label || "未配置"
                        : activeEntry === "视频生成"
                          ? selectedVideoModel?.label || "未配置"
                          : selectedLlmModel?.label || "未配置"}
                    <ChevronDown size={14} />
                  </button>
                  {activeEntry === "视频生成" ? (
                    <>
                      <button className={`jimengCommandButton ${activePanel === "videoMode" ? "active" : ""}`} type="button" onClick={(event) => {
                        event.stopPropagation();
                        togglePanel("videoMode");
                      }}>
                        <Images size={16} />
                        {selectedVideoModePresentation.label}
                        <ChevronDown size={14} />
                      </button>
                      <button className={`jimengCommandButton ${activePanel === "generationSpecs" ? "active" : ""}`} type="button" onClick={(event) => {
                        event.stopPropagation();
                        togglePanel("generationSpecs");
                      }}>
                        <SlidersHorizontal size={16} />
                        {selectedRatio} · {videoOptions.resolution}{videoOptions.audio ? " · 含音频" : ""}
                      </button>
                      <button className={`jimengCommandButton ${activePanel === "videoDuration" ? "active" : ""}`} type="button" onClick={(event) => {
                        event.stopPropagation();
                        togglePanel("videoDuration");
                      }}>
                        <Clock3 size={16} />
                        {videoDurationLabel(videoOptions.duration)}
                      </button>
                    </>
                  ) : activeEntry === "图片生成" ? (
                    <button className={`jimengCommandButton ${activePanel === "generationSpecs" ? "active" : ""}`} type="button" onClick={(event) => {
                      event.stopPropagation();
                      togglePanel("generationSpecs");
                    }}>
                      <SlidersHorizontal size={16} />
                      {selectedRatio} · {imageQuality} · {imageCount}张
                    </button>
                  ) : (
                    <button className={`jimengCommandButton ${activePanel === "auto" ? "active" : ""}`} type="button" onClick={(event) => {
                      event.stopPropagation();
                      togglePanel("auto");
                    }}>
                      <Settings size={16} />
                      {autoEnabled ? "自动" : "自定义"}
                    </button>
                  )}
                  <button className={`jimengCommandButton ${activePanel === "skills" ? "active" : ""}`} type="button" onClick={(event) => {
                    event.stopPropagation();
                    togglePanel("skills");
                  }}>
                    <Wrench size={16} />
                    {selectedSkills.length ? `技能 ${selectedSkills.length}` : "使用技能"}
                  </button>
                  <button className={`jimengCommandButton ${activePanel === "subjects" ? "active" : ""}`} type="button" onClick={(event) => {
                    event.stopPropagation();
                    setSubjectQuery("");
                    togglePanel("subjects");
                  }}>
                    <AtSign size={16} />
                    {selectedSubjects.length ? `资产 ${selectedSubjects.length}` : "资产库"}
                  </button>
                </div>
                <div className="jimengSendGroup">
                  <button className="jimengIconButton composerIcon" type="button" title="语音输入" onClick={startVoiceInput}>
                    <Mic size={18} />
                  </button>
                  <button
                    data-testid="quick-director-generate"
                    className="jimengSendButton"
                    type="button"
                    title={!sessionHydrated
                      ? "正在恢复项目草稿"
                      : !activeEntryAvailable
                        ? modelCatalogError || "当前创作类型没有可执行模型"
                        : activeEntry === "Agent 模式" ? "发送并进入 Agent 模式" : "开始创作"}
                    disabled={planning || hasActiveUploads || sourceImportBusy || !activeEntryAvailable}
                    onClick={() => void handleGeneratePlan()}
                  >
                    {planning ? <Loader2 className="jimengSpin" size={18} /> : <ArrowUp size={20} />}
                  </button>
                </div>
              </div>

              {errorText ? (
                <div
                  className={`jimengErrorBox ${sessionConflict ? "draftConflict" : ""}`}
                  role="alert"
                  aria-live="assertive"
                >
                  <span>{errorText}</span>
                  {sessionConflict ? (
                    <span className="jimengDraftConflictActions">
                      <button
                        type="button"
                        disabled={sessionConflictRetrying}
                        onClick={retryConflictedSessionDraft}
                      >
                        {sessionConflictRetrying ? "正在保存" : "保留本页并重试"}
                      </button>
                      <button
                        type="button"
                        disabled={sessionConflictRetrying}
                        onClick={restoreRemoteSessionDraft}
                      >
                        载入远端版本
                      </button>
                    </span>
                  ) : null}
                </div>
              ) : null}

              {activePanel === "mode" ? (
                <div className="jimengFloatingPanel modePanel" onClick={(event) => event.stopPropagation()}>
                  <p className="jimengPanelLabel">创作类型</p>
                  {runtimeCreationTypes.map((item) => {
                    const Icon = item.icon;
                    return (
                      <button key={item.label} className={activeEntry === item.label ? "selected" : ""} type="button" onClick={() => selectMode(item.label)}>
                        <Icon size={20} />
                        <span>{item.label}</span>
                        {activeEntry === item.label ? <Check size={19} /> : null}
                      </button>
                    );
                  })}
                  {!runtimeCreationTypes.length ? (
                    <p className="jimengPanelLabel">
                      {modelCatalogLoading
                        ? "正在确认真实执行能力"
                        : modelCatalogError || "当前没有可执行的创作类型"}
                    </p>
                  ) : null}
                </div>
              ) : null}

              {activePanel === "models" ? (
                <div className="jimengFloatingPanel modelPanel" onClick={(event) => event.stopPropagation()}>
                  <header className="jimengModelPanelHeader">
                    <span>
                      <strong>{activeEntry === "视频生成" ? "选择视频模型" : activeEntry === "图片生成" ? "选择图片模型" : "模型设置"}</strong>
                      <small>{activeEntry === "视频生成" ? "能力、参数和参考槽位随模型同步" : activeEntry === "图片生成" ? "清晰度与生成数量随模型同步" : "分别设置对话、图片与视频模型"}</small>
                    </span>
                    <span className="jimengModelCount">{activeEntry === "视频生成" ? `${videoModels.length} 个` : activeEntry === "图片生成" ? `${imageModels.length} 个` : "3 类模型"}</span>
                  </header>
                  {activeEntry === "Agent 模式" ? <div className="jimengSegmentedControl jimengModelTabs" role="tablist" aria-label="模型类型">
                    {(["对话", "图片", "视频"] as const).map((tab) => (
                      <button
                        key={tab}
                        type="button"
                        role="tab"
                        aria-selected={modelTab === tab}
                        className={modelTab === tab ? "active" : ""}
                        onClick={() => setModelTab(tab)}
                      >
                        {tab === "对话" ? <Bot size={15} /> : tab === "图片" ? <Image size={15} /> : <Video size={15} />}
                        {tab}
                      </button>
                    ))}
                  </div> : null}
                  <div className="jimengModelList">
                    {modelTab === "对话" ? llmModels.map((model) => (
                      <button
                        key={model.id}
                        className={llmModel === model.id ? "selected" : ""}
                        type="button"
                        onClick={() => {
                          if (model.id !== llmModel) markSessionEdited();
                          setLlmModel(model.id);
                        }}
                      >
                        <span className="jimengModelIcon"><Bot size={18} /></span>
                        <span>
                          <strong>{model.label}</strong>
                          <small>{model.description}</small>
                        </span>
                        {llmModel === model.id ? <Check size={17} /> : null}
                      </button>
                    )) : null}
                    {modelTab === "图片" ? imageModels.map((model) => (
                      <button
                        key={model.id}
                        className={imageModel === model.id ? "selected" : ""}
                        type="button"
                        disabled={!isImageModelAvailable(model)}
                        onClick={() => {
                          if (model.id !== imageModel) markSessionEdited();
                          setImageModel(model.id);
                          setImageQuality((quality) => model.qualities.includes(quality) ? quality : model.defaultQuality);
                          setImageCount((count) => Math.min(count, model.maxOutputs));
                          setActivePanel(null);
                        }}
                      >
                        <span className="jimengModelIcon"><Image size={18} /></span>
                        <span>
                          <strong>{model.label}</strong>
                          <small>{isImageModelAvailable(model) ? `${model.qualities.join("/")} · ${model.aspectRatios.length} 种比例 · 每次最多 ${model.maxOutputs} 张` : model.unavailableReason || "能力待验证"}</small>
                        </span>
                        {imageModel === model.id ? <Check size={17} /> : null}
                      </button>
                    )) : null}
                    {modelTab === "视频" ? videoModels.map((model) => (
                      <button
                        key={model.id}
                        className={videoOptions.model === model.id ? "selected" : ""}
                        type="button"
                        disabled={!isVideoModelAvailable(model)}
                        onClick={() => selectVideoModel(model)}
                      >
                        <span className="jimengModelIcon"><Video size={18} /></span>
                        <span>
                          <strong>{model.label}</strong>
                          <small>{isVideoModelAvailable(model) ? videoModelCapabilitySummary(model) : model.unavailableReason || "能力待验证"}</small>
                        </span>
                        {videoOptions.model === model.id ? <Check size={17} /> : null}
                      </button>
                    )) : null}
                    {modelTab === "对话" && !llmModels.length ? <p className="jimengModelError">{modelCatalogLoading ? "模型目录加载中" : "未配置可用的对话模型"}</p> : null}
                    {modelTab === "图片" && !imageModels.length ? <p className="jimengModelError">{modelCatalogLoading ? "模型目录加载中" : "未配置可用的图片模型"}</p> : null}
                    {modelTab === "视频" && !videoModels.length ? <p className="jimengModelError">{modelCatalogLoading ? "模型目录加载中" : "未配置可用的视频模型"}</p> : null}
                  </div>
                  {modelCatalogError ? (
                    <div className="jimengCatalogErrorActions">
                      <p className="jimengModelError">模型目录暂不可用：{modelCatalogError}</p>
                      <button type="button" onClick={retryModelCatalog}>重新加载模型目录</button>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {activePanel === "videoMode" && activeEntry === "视频生成" ? (
                <div className="jimengFloatingPanel videoModePanel" onClick={(event) => event.stopPropagation()}>
                  <p className="jimengPanelLabel">当前模型支持的生成模式</p>
                  {videoModeOptions.map((mode) => (
                    <button
                      key={mode.id}
                      className={videoOptions.mode === mode.id ? "selected" : ""}
                      type="button"
                      data-testid={`quick-video-mode-${mode.id}`}
                      onClick={() => selectVideoMode(mode.id)}
                    >
                      <span className="jimengModelIcon"><Images size={17} /></span>
                      <span>
                        <strong>{mode.label}{mode.badge ? <em className="jimengModeBadge">{mode.badge}</em> : null}</strong>
                        <small>{mode.description}</small>
                      </span>
                      {videoOptions.mode === mode.id ? <Check size={17} /> : null}
                    </button>
                  ))}
                  {!videoModeOptions.length ? <p className="jimengModelError">当前模型未声明可用生成模式</p> : null}
                </div>
              ) : null}

              {activePanel === "generationSpecs" && (activeEntry === "图片生成" || activeEntry === "视频生成") ? (
                <div className="jimengFloatingPanel generationSpecsPanel" onClick={(event) => event.stopPropagation()}>
                  <p className="jimengPanelLabel">选择比例</p>
                  <div className="jimengRatioGrid compact" role="group" aria-label="生成尺寸比例">
                    {visibleRatioItems.map((ratio) => (
                      <button
                        key={ratio.label}
                        className={selectedRatio === ratio.label ? "selected" : ""}
                        type="button"
                        onClick={() => {
                          if (ratio.label !== selectedRatio) markSessionEdited();
                          setSelectedRatio(ratio.label);
                          setForm((current) => ({ ...current, ratio: ratio.label }));
                          resetGeneratedState();
                        }}
                      >
                        <span className={`jimengRatioIcon ${ratio.shape}`} />
                        {ratio.label}
                      </button>
                    ))}
                  </div>
                  {activeEntry === "图片生成" ? (
                    <>
                      <p className="jimengPanelLabel">选择分辨率</p>
                      <div className="jimengOptionGrid compact">
                        {(selectedImageModel?.qualities || []).map((quality) => (
                          <button key={quality} className={imageQuality === quality ? "selected" : ""} type="button" onClick={() => {
                            if (quality !== imageQuality) markSessionEdited();
                            setImageQuality(quality);
                            resetGeneratedState();
                          }}>{quality}</button>
                        ))}
                      </div>
                      <p className="jimengPanelLabel">选择生成数量</p>
                      <div className="jimengOptionGrid countGrid" role="group" aria-label="图片生成数量">
                        {Array.from({ length: selectedImageModel?.maxOutputs || 1 }, (_, index) => index + 1).map((count) => (
                          <button key={count} className={imageCount === count ? "selected" : ""} type="button" onClick={() => {
                            if (count !== imageCount) markSessionEdited();
                            setImageCount(count);
                            resetGeneratedState();
                          }}>{count}</button>
                        ))}
                      </div>
                    </>
                  ) : (
                    <>
                      <p className="jimengPanelLabel">选择分辨率</p>
                      <div className="jimengOptionGrid compact" role="group" aria-label="视频分辨率">
                        {(selectedVideoModel?.resolutions || []).map((resolution) => {
                          return (
                            <button
                              key={resolution}
                              className={videoOptions.resolution === resolution ? "selected" : ""}
                              type="button"
                              aria-pressed={videoOptions.resolution === resolution}
                              onClick={() => {
                                if (resolution !== videoOptions.resolution) markSessionEdited();
                                setVideoOptions((current) => ({ ...current, resolution }));
                                resetGeneratedState();
                              }}
                            >
                              <strong>{resolution}</strong>
                            </button>
                          );
                        })}
                      </div>
                      {(selectedVideoModel?.resolutions?.length || 0) === 1 ? (
                        <p className="jimengResolutionNotice" role="note">
                          当前模型仅开放 {videoOptions.resolution} 输出
                        </p>
                      ) : null}
                      {selectedVideoOutputFormats.length > 1 ? <>
                        <p className="jimengPanelLabel">输出格式</p>
                        <div className="jimengOptionGrid compact" role="group" aria-label="视频输出格式">
                          {selectedVideoOutputFormats.map((format) => <button key={format} type="button"
                            className={videoOptions.outputFormat === format ? "selected" : ""}
                            aria-pressed={videoOptions.outputFormat === format}
                            onClick={() => { markSessionEdited(); setVideoOptions((current) => ({ ...current, outputFormat: format })); resetGeneratedState(); }}>
                            {format.toUpperCase()}
                          </button>)}
                        </div>
                      </> : null}
                      <VideoAudioSwitch
                        checked={videoOptions.audio}
                        supported={Boolean(selectedVideoModel?.supportsGenerateAudio)}
                        onChange={toggleVideoAudio}
                      />
                    </>
                  )}
                </div>
              ) : null}

              {activePanel === "videoDuration" && activeEntry === "视频生成" ? (
                <div className="jimengFloatingPanel videoDurationPanel" onClick={(event) => event.stopPropagation()}>
                  <p className="jimengPanelLabel">选择视频生成时长</p>
                  {requiredVideoDuration(selectedVideoModel?.id || "", videoOptions.mode) === -1
                    ? <p className="jimengPanelLabel">时长跟随原片</p>
                    : selectedVideoModel ? <VideoDurationControl
                    duration={selectedVideoModel.duration}
                    value={videoOptions.duration}
                    onChange={(duration) => {
                      markSessionEdited();
                      setVideoOptions((current) => ({ ...current, duration }));
                      resetGeneratedState();
                    }}
                  /> : null}
                </div>
              ) : null}

              {activePanel === "auto" ? (
                <div className="jimengFloatingPanel autoPanel" onClick={(event) => event.stopPropagation()}>
                  <header>
                    <span className="jimengPreferenceTitle">
                      <h2>生成偏好</h2>
                      <small>选项随当前模型能力自动更新</small>
                    </span>
                    <label className={`jimengToggleSwitch ${autoEnabled ? "on" : ""}`}>
                      <input aria-label="自动生成偏好" type="checkbox" checked={autoEnabled} onChange={(event) => {
                        if (event.target.checked !== autoEnabled) markSessionEdited();
                        setAutoEnabled(event.target.checked);
                      }} />
                      <span />
                    </label>
                  </header>
                  <div className="jimengSegmentedControl">
                    {(["图片", "视频"] as const).map((tab) => (
                      <button key={tab} type="button" className={preferenceTab === tab ? "active" : ""} onClick={() => {
                        if (tab !== preferenceTab) markSessionEdited();
                        setPreferenceTab(tab);
                      }}>
                        {tab}
                      </button>
                    ))}
                  </div>
                  <p className="jimengPanelLabel">尺寸比例</p>
                  <div className="jimengRatioGrid" role="group" aria-label={`${preferenceTab}尺寸比例`}>
                    {visibleRatioItems.map((ratio) => (
                      <button
                        key={ratio.label}
                        className={selectedRatio === ratio.label ? "selected" : ""}
                        type="button"
                        aria-pressed={selectedRatio === ratio.label}
                        onClick={() => {
                          if (ratio.label !== selectedRatio) markSessionEdited();
                          setAutoEnabled(false);
                          setSelectedRatio(ratio.label);
                          setForm((current) => ({ ...current, ratio: ratio.label }));
                        }}
                      >
                        <span className={`jimengRatioIcon ${ratio.shape}`} />
                        {ratio.label}
                      </button>
                    ))}
                  </div>
                  {preferenceTab === "图片" ? (
                    <section className="jimengPreferenceSection" aria-label="图片生成参数">
                      <div className="jimengPreferenceSectionHeader">
                        <strong>图片分辨率</strong>
                        <small>{selectedImageModel?.label || "未配置图片模型"}</small>
                      </div>
                      <div className="jimengOptionGrid" role="group" aria-label="图片分辨率">
                        {(selectedImageModel?.qualities || []).map((quality) => (
                          <button
                            key={quality}
                            className={imageQuality === quality ? "selected" : ""}
                            type="button"
                            aria-pressed={imageQuality === quality}
                            onClick={() => {
                              if (quality !== imageQuality) markSessionEdited();
                              setAutoEnabled(false);
                              setImageQuality(quality);
                            }}
                          >
                            {quality}
                          </button>
                        ))}
                      </div>
                    </section>
                  ) : (
                    <section className="jimengPreferenceSection" aria-label="视频生成参数">
                      <div className="jimengPreferenceSectionHeader">
                        <strong>视频分辨率</strong>
                        <small>
                          {selectedVideoModel?.label || "未配置视频模型"}
                        </small>
                      </div>
                      <div className="jimengOptionGrid" role="group" aria-label="视频分辨率">
                        {(selectedVideoModel?.resolutions || []).map((resolution) => {
                          return (
                            <button
                              key={resolution}
                              className={videoOptions.resolution === resolution ? "selected" : ""}
                              type="button"
                              aria-pressed={videoOptions.resolution === resolution}
                              onClick={() => {
                                if (resolution !== videoOptions.resolution) markSessionEdited();
                                setAutoEnabled(false);
                                setVideoOptions((current) => ({ ...current, resolution }));
                              }}
                            >
                              <strong>{resolution}</strong>
                            </button>
                          );
                        })}
                      </div>
                      {selectedVideoOutputFormats.length > 1 ? <>
                        <div className="jimengPreferenceSectionHeader"><strong>输出格式</strong></div>
                        <div className="jimengOptionGrid" role="group" aria-label="偏好视频输出格式">
                          {selectedVideoOutputFormats.map((format) => <button key={format} type="button"
                            className={videoOptions.outputFormat === format ? "selected" : ""}
                            aria-pressed={videoOptions.outputFormat === format}
                            onClick={() => { markSessionEdited(); setAutoEnabled(false); setVideoOptions((current) => ({ ...current, outputFormat: format })); }}>
                            {format.toUpperCase()}
                          </button>)}
                        </div>
                      </> : null}
                      <div className="jimengPreferenceSectionHeader durationHeader">
                        <strong>生成时长</strong>
                        <small>单镜头 {videoDurationLabel(videoOptions.duration)}</small>
                      </div>
                      {requiredVideoDuration(selectedVideoModel?.id || "", videoOptions.mode) === -1
                        ? <p className="jimengPanelLabel">时长跟随原片</p>
                        : selectedVideoModel ? <VideoDurationControl
                        duration={selectedVideoModel.duration}
                        value={videoOptions.duration}
                        onChange={(duration) => {
                          markSessionEdited();
                          setAutoEnabled(false);
                          setVideoOptions((current) => ({ ...current, duration }));
                        }}
                      /> : null}
                      <VideoAudioSwitch
                        checked={videoOptions.audio}
                        supported={Boolean(selectedVideoModel?.supportsGenerateAudio)}
                        onChange={toggleVideoAudio}
                      />
                    </section>
                  )}
                  {preferenceTab === "视频" && selectedVideoModel && !isVideoModelAvailable(selectedVideoModel) ? (
                    <p className="jimengPanelLabel">
                      {selectedVideoModel.unavailableReason || "该模型已进入目录，但能力尚未验证，暂不提交付费任务。"}
                    </p>
                  ) : null}
                  {preferenceTab === "图片" && selectedImageModel && !isImageModelAvailable(selectedImageModel) ? (
                    <p className="jimengPanelLabel">
                      {selectedImageModel.unavailableReason || "该模型已进入目录，但能力尚未验证，暂不提交付费任务。"}
                    </p>
                  ) : null}
                  {modelCatalogError ? (
                    <div className="jimengCatalogErrorActions">
                      <p className="jimengPanelLabel">模型目录暂不可用，生成提交已禁用：{modelCatalogError}</p>
                      <button type="button" onClick={retryModelCatalog}>重新加载模型目录</button>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {activePanel === "skills" ? (
                <div className="jimengFloatingPanel contextPickerPanel skillPanel" aria-label="技能目录" onClick={(event) => event.stopPropagation()}>
                  <header className="jimengModelPanelHeader">
                    <span>
                      <strong>使用技能</strong>
                      <small>只展示 Agent Runtime 真实注册技能</small>
                    </span>
                    <span className="jimengModelCount">{selectedSkills.length} 已选</span>
                  </header>
                  <label className="jimengContextSearch">
                    <Wrench size={15} />
                    <input value={skillQuery} onChange={(event) => setSkillQuery(event.target.value)} placeholder="搜索技能" />
                  </label>
                  <div className="jimengModelList">
                    {visibleSkills.map((skill) => {
                      const selected = selectedSkillIds.includes(skill.id);
                      return (
                        <div key={skill.id} className={`quickSkillCatalogItem${selected ? " selected" : ""}`}>
                          <button type="button" data-testid="quick-skill-option" data-selected={selected ? "true" : "false"} onClick={() => toggleSkill(skill)}>
                            <span className="jimengModelIcon"><Wrench size={17} /></span>
                            <span><strong>{skill.name}</strong><small>{skill.description}</small></span>
                            {selected ? <Check size={16} /> : <Plus size={16} />}
                          </button>
                          <div className="quickSkillCatalogActions">
                            <span>{skill.publisher} · {skill.category} · v{skill.version}</span>
                            <button type="button" aria-expanded={expandedSkillId === skill.id} onClick={() => setExpandedSkillId((current) => current === skill.id ? "" : skill.id)}>
                              {expandedSkillId === skill.id ? "收起详情" : "查看详情"}
                            </button>
                            <button type="button" onClick={() => {
                              if (!selected) toggleSkill(skill);
                              showNotice(`已复制「${skill.name}」规范引用到当前创作`);
                            }}>复制到当前创作</button>
                          </div>
                          {expandedSkillId === skill.id ? (
                            <dl className="quickSkillCatalogDetail">
                              <div><dt>适用</dt><dd>{skill.useCases.join("、")}</dd></div>
                              <div><dt>输入</dt><dd>{skill.input}</dd></div>
                              <div><dt>输出</dt><dd>{skill.output}</dd></div>
                              <div><dt>示例</dt><dd>{skill.example}</dd></div>
                              <div><dt>限制</dt><dd>{skill.limits.join("；")}</dd></div>
                            </dl>
                          ) : null}
                        </div>
                      );
                    })}
                    {!visibleSkills.length ? (
                      <p className="jimengModelError">
                        {skillCatalogLoading
                          ? "技能目录加载中"
                          : skillCatalogError
                            ? `技能目录读取失败：${skillCatalogError}`
                            : "暂无匹配技能"}
                      </p>
                    ) : null}
                  </div>
                  {skillCatalogError ? <button className="jimengPanelAction" type="button" onClick={retrySkillCatalog}>重新加载技能</button> : null}
                  <div className="jimengContextPanelActions">
                    <button type="button" onClick={openAgentSkillWorkspace}>在 Agent 中使用技能</button>
                  </div>
                </div>
              ) : null}

              {activePanel === "subjects" ? (
                <div className="jimengFloatingPanel contextPickerPanel subjectPanel" aria-label="账号与工作区资产目录" onClick={(event) => event.stopPropagation()}>
                  <header className="jimengModelPanelHeader">
                    <span>
                      <strong>@ 资产库</strong>
                      <small>账号资产可跨项目复用，工作区资产由成员共享</small>
                    </span>
                    <span className="jimengModelCount">{selectedSubjects.length} 已选</span>
                  </header>
                  {attachments.some(item => item.state === "uploaded" && item.asset) ? (
                    <section className="jimengCurrentReferenceMentions" aria-label="本次创作参考">
                      <strong>本次创作参考</strong>
                      {(activeEntry === "视频生成" ? orderedVideoAttachments : attachments).map((item, index) => (
                        item.state === "uploaded" && item.asset ? (
                          <button key={item.clientId} type="button" data-reference-asset-version={item.asset.assetVersionId}
                            onClick={() => {
                              markSessionEdited();
                              setForm(current => ({...current, brief: appendReferenceMentions(current.brief, [index + 1])}));
                              setActivePanel(null);
                            }}>
                            <span>{`@参考${index + 1}`}</span><small>{item.name}</small>
                          </button>
                        ) : null
                      ))}
                    </section>
                  ) : null}
                  <div className="jimengContextPanelActions" aria-label="资产范围">
                    {([
                      ...(numericProjectId ? [["project_refs", "当前项目"]] : []),
                      ["mine", "我的资产"],
                      ["workspace", "工作区"],
                      ["shared_with_me", "分享给我"],
                    ] as Array<[AssetLibraryView, string]>).map(([view, label]) => (
                      <button
                        key={view}
                        type="button"
                        className={assetLibraryView === view ? "selected" : ""}
                        aria-pressed={assetLibraryView === view}
                        onClick={() => setAssetLibraryView(view)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <label className="jimengContextSearch">
                    <AtSign size={15} />
                    <input value={subjectQuery} onChange={(event) => setSubjectQuery(event.target.value)} placeholder="搜索资产库" autoFocus />
                  </label>
                  <div className="quickAssetRecommendationBar">
                    <button type="button" disabled={!numericProjectId || assetRecommendationsLoading} onClick={() => void discoverAssetRecommendations()}>
                      <WandSparkles size={14} />
                      {assetRecommendationsLoading ? "正在检索…" : "推荐授权资产"}
                    </button>
                    <small>先做权限过滤，再按名称、类型和描述做零费用匹配</small>
                  </div>
                  {assetRecommendationsError ? <p className="jimengModelError">推荐读取失败：{assetRecommendationsError}</p> : null}
                  {assetRecommendations.length ? (
                    <div className="quickAssetRecommendations" aria-label="资产推荐">
                      {assetRecommendations.map((recommendation) => (
                        <article key={recommendation.recommendationId}>
                          <span>
                            <strong>{recommendation.name}</strong>
                            <small>{recommendation.reasons.join("；")}</small>
                            <em>{recommendation.source === "account" ? "账号资产" : recommendation.source === "workspace" ? "工作区资产" : "已授权分享"} · {recommendation.assetVersionId} · 零费用检索</em>
                          </span>
                          <button
                            type="button"
                            disabled={recommendation.alreadyInProject || assetLibraryMutationId !== null}
                            onClick={() => void adoptAssetRecommendation(recommendation)}
                          >
                            {recommendation.alreadyInProject ? "已在项目" : "采用此版本"}
                          </button>
                        </article>
                      ))}
                    </div>
                  ) : null}
                  <div className="jimengModelList">
                    {assetLibraryView === "project_refs" ? visibleSubjects.map((subject) => {
                      const selected = selectedSubjectIds.includes(subject.id);
                      const libraryAsset = libraryAssets.find((asset) => Number(asset.id) === Number(subject.id));
                      return (
                        <article key={subject.id} className="jimengAssetLibraryRow">
                          <button className={`jimengAssetLibraryPrimary ${selected ? "selected" : ""}`} type="button" data-testid="quick-project-asset-option" data-selected={selected ? "true" : "false"} onClick={() => toggleSubject(subject)}>
                            <span className="jimengModelIcon">
                              {subject.image ? <ReferencePreviewImage src={subject.image} alt="" /> : <FolderOpen size={17} />}
                            </span>
                            <span><strong>{subject.name}</strong><small>{subject.type} · {subject.description}</small></span>
                            {selected ? <Check size={16} /> : null}
                          </button>
                          {libraryAsset?.projectReference ? (
                            <button
                              className="jimengAssetLibraryManage"
                              type="button"
                              disabled={assetLibraryMutationId !== null}
                              aria-label={`从当前项目移除${subject.name}`}
                              title="仅移除项目引用，资产本体保留"
                              onClick={() => void removeProjectLibrarySubject(libraryAsset)}
                            >
                              <X size={14} />
                            </button>
                          ) : null}
                        </article>
                      );
                    }) : visibleLibrarySubjects.map((asset) => (
                      <article key={asset.id} className="jimengAssetLibraryRow">
                        <button
                          className={`jimengAssetLibraryPrimary ${selectedSubjectIds.includes(toQuickCreateSubject(asset).id) ? "selected" : ""}`}
                          type="button"
                          disabled={!asset.permissions.use || assetLibraryMutationId !== null}
                          data-testid="quick-library-asset-option"
                          data-selected={selectedSubjectIds.includes(toQuickCreateSubject(asset).id) ? "true" : "false"}
                          onClick={() => void addLibrarySubject(asset)}
                        >
                          <span className="jimengModelIcon">
                            {asset.src ? <ReferencePreviewImage src={asset.src} alt="" /> : <FolderOpen size={17} />}
                          </span>
                          <span>
                            <strong>{asset.name}</strong>
                            <small>
                              {asset.ownership.ownerType === "user" ? "账号资产" : "工作区资产"}
                              {asset.permissions.use
                                ? numericProjectId ? " · 可加入项目" : " · 可直接引用"
                                : " · 仅查看"}
                            </small>
                          </span>
                          {assetLibraryMutationId === asset.id
                            ? <span>处理中…</span>
                            : selectedSubjectIds.includes(toQuickCreateSubject(asset).id)
                              ? <Check size={16} />
                              : null}
                        </button>
                        {asset.authority === "owner" && asset.ownership.ownerType === "user" ? (
                          <span className="jimengAssetLibraryActions">
                            <button
                              type="button"
                              disabled={assetLibraryMutationId !== null}
                              aria-label={`分享${asset.name}到工作区`}
                              title="分享给当前工作区成员，账号所有权保持不变"
                              onClick={() => void shareLibrarySubjectWithWorkspace(asset)}
                            >
                              <Share2 size={14} />
                            </button>
                            {canReceiveWorkspaceAsset ? (
                              <button
                                type="button"
                                disabled={assetLibraryMutationId !== null}
                                aria-label={`将${asset.name}转为工作区资产`}
                                title="显式转移为工作区资产"
                                onClick={() => void transferLibrarySubjectToWorkspace(asset)}
                              >
                                <Building2 size={14} />
                              </button>
                            ) : null}
                          </span>
                        ) : null}
                      </article>
                    ))}
                    {(assetLibraryView === "project_refs" ? !visibleSubjects.length : !visibleLibrarySubjects.length) ? (
                      <p className="jimengModelError">
                        {assetLibraryView === "project_refs"
                            ? projectAssetsLoading
                              ? "项目资产加载中"
                              : projectAssetsError?.message
                                ? `项目资产读取失败：${projectAssetsError.message}`
                                : "当前项目暂无可选资产"
                            : libraryAssetsLoading
                              ? "资产库加载中"
                              : libraryAssetsError?.message
                                ? `资产库读取失败：${libraryAssetsError.message}`
                                : "当前范围暂无可选资产"}
                      </p>
                    ) : null}
                  </div>
                  {(projectAssetsError || libraryAssetsError) ? <button className="jimengPanelAction" type="button" onClick={() => assetLibraryView === "project_refs" ? void fetchProjectAssets({ limit: 80 }) : void fetchLibraryAssets({ view: assetLibraryView, limit: 100 })}>重新加载资产</button> : null}
                  <div className="jimengContextPanelActions">
                    <button type="button" onClick={openAssetCreation}>创建资产</button>
                  </div>
                </div>
              ) : null}

            </section>

            <section className="jimengModeStrip" aria-label="创作入口">
              {runtimeModeCards.map((card) => (
                <button
                  className={activeEntry === card.title ? "active" : ""}
                  key={card.title}
                  type="button"
                  onClick={() => {
                    if (card.title === "画布模式") {
                      openKanbanMode();
                      return;
                    }
                    selectMode(card.title);
                  }}
                >
                  <img className="jimengModeThumb" src={card.image} alt="" />
                  <span>
                    <strong>{card.title}</strong>
                    <small>{card.description}</small>
                  </span>
                  {card.badge ? <em>{card.badge}</em> : null}
                </button>
              ))}
            </section>

            {imageAssets.length || plan || materialized || tasks.length ? (
              <section data-testid="quick-director-plan" className="jimengResultPanel" aria-label="真实生成结果">
                {imageAssets.length ? (
                  <>
                    <div className="jimengResultHeader">
                      <span>真实生成</span>
                      <h2>图片已生成</h2>
                      <p>结果已写入生成作品库，可在资产页的生成历史继续查看。</p>
                    </div>
                    <div className="jimengImageResultGrid">
                      {imageAssets.map((asset) => (
                        <article key={asset.id}>
                          <a href={asset.url} target="_blank" rel="noreferrer">
                            <img src={asset.url} alt={asset.prompt || form.brief || "生成图片"} />
                          </a>
                          <strong>{asset.model || "图片生成"}</strong>
                          <p>{asset.prompt || form.brief}</p>
                        </article>
                      ))}
                    </div>
                  </>
                ) : null}
                {plan ? (
                  <>
                    <div className="jimengResultHeader">
                      <span>真实链路</span>
                      <h2>{plan.title || "导演计划"}</h2>
                      <p>{plan.simpleScript || "导演计划生成后，会在这里继续创建草稿项目与镜头视频任务。"}</p>
                    </div>
                    {structuredTimeline ? (
                      <section
                        className="jimengStructuredTimeline"
                        data-testid="quick-structured-timeline"
                        aria-label="30 秒结构化时间线"
                      >
                        <header>
                          <span>
                            <strong>30 秒结构化时间线</strong>
                            <small>镜头连续排列；提示词、素材与音频卡点会随草稿保存并参与提交。</small>
                          </span>
                          <button type="button" onClick={() => rebuildStructuredTimeline()}>
                            重新按计划编排
                          </button>
                        </header>
                        <div className="jimengTimelineRuler" aria-hidden="true">
                          <span>00:00</span><span>00:15</span><span>00:30</span>
                        </div>
                        <div className="jimengTimelineShots">
                          {structuredTimeline.shots.map((shot, index) => (
                            <article key={shot.id} data-testid="quick-director-plan-shot">
                              <div className="jimengTimelineShotHeader">
                                <span>{String(index + 1).padStart(2, "0")}</span>
                                <strong>{shot.title}</strong>
                                <time>{shot.startSeconds.toFixed(2)}s – {shot.endSeconds.toFixed(2)}s</time>
                              </div>
                              <label>
                                <span>视频提示词</span>
                                <textarea
                                  key={`${shot.id}:${shot.prompt}`}
                                  defaultValue={shot.prompt}
                                  maxLength={2_000}
                                  rows={2}
                                  onBlur={(event) => {
                                    if (!event.currentTarget.value.trim()) {
                                      event.currentTarget.value = shot.prompt;
                                      return;
                                    }
                                    updateTimelineShotPrompt(index, event.currentTarget.value);
                                  }}
                                />
                              </label>
                              {uploadedAttachmentsForSession.some((attachment) => attachment.type !== "audio" && attachment.type !== "document") ? (
                                <div className="jimengTimelineAssetPicker" aria-label={`镜头 ${index + 1} 的参考素材`}>
                                  <span>镜头素材</span>
                                  <div>
                                    {uploadedAttachmentsForSession
                                      .filter((attachment) => attachment.type !== "audio" && attachment.type !== "document")
                                      .map((attachment) => {
                                        const assetVersionId = String(attachment.assetVersionId);
                                        const selected = shot.assetVersionIds.includes(assetVersionId);
                                        return (
                                          <button
                                            key={assetVersionId}
                                            type="button"
                                            aria-pressed={selected}
                                            onClick={() => toggleTimelineShotAsset(index, assetVersionId)}
                                          >
                                            {selected ? <Check size={13} /> : <Plus size={13} />}
                                            {attachment.name}
                                          </button>
                                        );
                                      })}
                                  </div>
                                </div>
                              ) : (
                                <small className="jimengTimelineEmptyHint">当前镜头未绑定图片或视频参考，可继续使用文字生成。</small>
                              )}
                            </article>
                          ))}
                        </div>
                        <div className="jimengTimelineAudio" data-testid="quick-timeline-audio-cues">
                          <div className="jimengTimelineAudioHeading">
                            <Music size={16} />
                            <span><strong>音频卡点</strong><small>提交时按镜头交集裁剪受控音频引用。</small></span>
                          </div>
                          {structuredTimeline.audioCues.map((cue, index) => (
                            <article key={cue.id}>
                              <strong>{cue.label}</strong>
                              <label>
                                <span>开始 {cue.startSeconds.toFixed(2)}s</span>
                                <input
                                  aria-label={`${cue.label}开始时间`}
                                  type="range"
                                  min={0}
                                  max={Math.max(0, cue.endSeconds - 0.05)}
                                  step={0.05}
                                  value={cue.startSeconds}
                                  onChange={(event) => updateTimelineAudioCue(index, {
                                    startSeconds: Math.min(Number(event.target.value), cue.endSeconds - 0.05),
                                  })}
                                />
                              </label>
                              <label>
                                <span>结束 {cue.endSeconds.toFixed(2)}s</span>
                                <input
                                  aria-label={`${cue.label}结束时间`}
                                  type="range"
                                  min={Math.min(30, cue.startSeconds + 0.05)}
                                  max={30}
                                  step={0.05}
                                  value={cue.endSeconds}
                                  onChange={(event) => updateTimelineAudioCue(index, {
                                    endSeconds: Math.max(Number(event.target.value), cue.startSeconds + 0.05),
                                  })}
                                />
                              </label>
                              <label>
                                <span>音量 {cue.volume.toFixed(2)}</span>
                                <input
                                  aria-label={`${cue.label}音量`}
                                  type="range"
                                  min={0}
                                  max={2}
                                  step={0.05}
                                  value={cue.volume}
                                  onChange={(event) => updateTimelineAudioCue(index, {
                                    volume: Number(event.target.value),
                                  })}
                                />
                              </label>
                            </article>
                          ))}
                          {!structuredTimeline.audioCues.length ? (
                            <small className="jimengTimelineEmptyHint">上传音频并重新编排后，可设置进入和结束卡点。</small>
                          ) : null}
                        </div>
                      </section>
                    ) : null}
                    <div className="jimengResultActions">
                      <button data-testid="quick-director-materialize" className="jimengPrimaryButton" type="button" disabled={!plan || materializing} onClick={handleMaterialize}>
                        {materializing ? <Loader2 className="jimengSpin" size={16} /> : <FolderOpen size={16} />}
                        {materialized ? "重新创建草稿" : "创建草稿项目"}
                      </button>
                      <button className="jimengSecondaryButton" type="button" disabled={!materialized || generating || hasPendingVideoReconcile} onClick={handleGenerateVideos}>
                        {generating ? <Loader2 className="jimengSpin" size={16} /> : <Video size={16} />}
                        {hasPendingVideoReconcile ? "待核中，请勿重复提交" : "生成镜头视频"}
                      </button>
                      {materialized ? <span data-testid="quick-director-materialized" className="jimengMaterializedHint">项目 #{materialized.project.id} · {materialized.shots.length} 个镜头</span> : null}
                    </div>
                    {materialized ? (
                      <div className="jimengResultActions" aria-live="polite">
                        <button className="jimengSecondaryButton" type="button" onClick={() => void refreshTaskPoller()}>
                          {pollerState === "polling" ? <Loader2 className="jimengSpin" size={16} /> : null}
                          刷新任务状态
                        </button>
                        {pollErrorText ? <span className="jimengMaterializedHint">{pollErrorText}</span> : null}
                        {!pollErrorText && pollerState === "polling" ? <span className="jimengMaterializedHint">正在刷新任务状态</span> : null}
                        {!pollErrorText && pollerState === "reconnecting" ? <span className="jimengMaterializedHint">连接中断，正在重试</span> : null}
                      </div>
                    ) : null}
                    {tasks.length ? (
                      <div className="jimengTaskList">
                        {tasks.map((task) => (
                          <article key={`${task.videoId}-${task.trackId}`}>
                            <span className={`jimengTaskStatus ${task.status}`}>{generationPreparationMessage(task) || getTaskStatusText(task.status)}</span>
                            <strong>镜头 #{task.trackId}</strong>
                            <small>{task.errorReason || task.prompt || "视频任务已提交"}</small>
                            {task.url ? <a href={task.url} target="_blank" rel="noreferrer">查看视频</a> : null}
                            {task.relayTaskId && task.status !== "pending_reconcile" && shouldPollTask(task.status) ? (
                              <button
                                className="jimengTaskCancelButton"
                                type="button"
                                disabled={Boolean(cancellingTaskId)}
                                onClick={() => void handleCancelTask(task)}
                              >
                                {cancellingTaskId === task.relayTaskId ? "取消中…" : "取消任务"}
                              </button>
                            ) : null}
                          </article>
                        ))}
                      </div>
                    ) : null}
                  </>
                ) : null}
              </section>
            ) : null}
          </fieldset>
          {standaloneInspirationRoute ? <InspirationShowcase
            dark={dark}
            hasDraft={Boolean(form.brief.trim())}
            useDisabled={!sessionHydrated || planning || materializing || generating || hasActiveUploads || sourceImportBusy}
                onUseSource={importSourceCase}
            onUseBrief={(brief) => {
              markSessionEdited();
              setForm(current => ({ ...current, brief: appendCreativeBrief(current.brief, brief) }));
              setActiveEntry("Agent 模式");
              setActivePanel(null);
              resetGeneratedState();
              showNotice("创作指引已带入，补充素材与需求后再发送给 Agent");
              const composer = document.querySelector<HTMLTextAreaElement>('[data-testid="quick-director-brief"]');
              composer?.focus({ preventScroll: true });
              composer?.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
            }}
          /> : null}
            </>
          )}

        </div>
      </section>
      {notice ? <div className="jimengToast">{notice}</div> : null}
    </main>
  );
}
