import { generationPreparationMessage } from "../../features/quick-create/generationPreparation";
import { useV4Theme } from "../../ui/useV4Theme";
import "../frontstage/FrontstagePage.css";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiDelete, apiPost } from "../../api/http";
import {
  clearStoredSubmissionAttempt,
  prepareStoredSubmissionAttempt,
  shouldRetainStoredSubmissionAttempt,
  writeStoredSubmissionAttempt,
} from "../../features/quick-create/itemAttemptStorage";
import {
  resolveStableSubmissionAttempt,
  type StableSubmissionAttempt,
} from "../../features/quick-create/submissionAttempt";
import {
  linkCommerceVariantBatchTasks,
  commercePendingSubmissionForOperation,
  normalizeCommerceVariantBatch,
  reconcileCommerceVariantBatchTasks,
  type CommerceTaskEvidence,
} from "../../features/quick-create/quickModeWorkflow";
import { useSessionStore } from "../../features/quick-create/session/sessionStore";
import { useProjectStore } from "../../stores/projectStore";
import { ConfirmDialog } from "../../ui/console";

type ScriptItem = { id: number; name: string; content: string };
export type ProductionTaskState =
  | "未生成"
  | "排队中"
  | "生成中"
  | "增强中"
  | "已完成"
  | "生成失败"
  | "已取消"
  | "状态未知";

export type ProductionVideo = {
  id: number;
  src: string;
  state: ProductionTaskState;
  errorReason?: string | null;
  relayTaskId?: string | null;
  relayStatus?: string;
  preparationStage?: "portrait_registration" | null;
  statusMessage?: string | null;
};
export type ProductionTrackMedia = {
  id?: number;
  src?: string;
  fileType?: "image" | "video" | "audio";
  sources?: "assets" | "storyboard";
};
export type ProductionTrack = {
  id: number; scriptId: number; scriptName: string; prompt: string; state: string;
  selectVideoId?: number | null; medias: ProductionTrackMedia[]; videoList: ProductionVideo[]; duration: number | null;
};
export type ProductionGroup = { script: ScriptItem; tracks: ProductionTrack[] };
type ViewMode = "list" | "board" | "timeline";
type ProductionVideoDeleteIntent = {
  projectId: number;
  trackId: number;
  videoId: number;
  src: string;
  intentToken: string;
  idempotencyKey: string;
};
type ProductionVideoDeleteError = {
  intentToken: string;
  message: string;
};

type ProductionDurationCapability = {
  min: number;
  max: number;
  step: number;
  default: number;
  allowed: number[];
};

export type ProductionVideoModel = {
  id: string;
  label: string;
  canSubmit: boolean;
  unavailableReason?: string;
  modes: string[];
  resolutions: string[];
  defaultResolution: string;
  duration: ProductionDurationCapability;
  supportsGenerateAudio: boolean;
};

type ProductionModelSetting = {
  model: string;
  mode: string;
  resolution: string;
  audio: boolean | null;
};

function productionModelSettingStorageKey(projectId: number) {
  return `fanjin-v4:production-model-setting:${projectId}`;
}

function normalizeStoredProductionModelSetting(
  value: unknown,
  models: ProductionVideoModel[],
): ProductionModelSetting | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const model = models.find((item) => item.id === source.model);
  if (!model || !model.canSubmit) return null;
  const mode = typeof source.mode === "string" ? source.mode : "";
  const resolution = typeof source.resolution === "string" ? source.resolution : "";
  const audio = typeof source.audio === "boolean" ? source.audio : null;
  if (!model.modes.includes(mode) || !model.resolutions.includes(resolution)) return null;
  if (model.supportsGenerateAudio ? audio === null : audio !== false) return null;
  return { model: model.id, mode, resolution, audio };
}

function readProductionModelSetting(projectId: number, models: ProductionVideoModel[]) {
  try {
    const raw = window.localStorage.getItem(productionModelSettingStorageKey(projectId));
    return raw ? normalizeStoredProductionModelSetting(JSON.parse(raw), models) : null;
  } catch {
    return null;
  }
}

function writeProductionModelSetting(projectId: number, setting: ProductionModelSetting) {
  try {
    window.localStorage.setItem(productionModelSettingStorageKey(projectId), JSON.stringify(setting));
  } catch {
    // Storage can be unavailable in private/restricted contexts. The current
    // in-memory selection remains usable for this visit.
  }
}

type ProductionUploadReference = {
  id: number;
  sources: "assets" | "storyboard";
  role: "subject" | "storyboard" | "first_frame" | "last_frame";
};

const PRODUCTION_SUBMITTABLE_CAPABILITY_STATUSES = new Set(["verified", "configured", "legacy"]);
const PRODUCTION_PUBLIC_VIDEO_RESOLUTIONS = new Set(["720p", "1080p", "2k", "4k"]);
const PRODUCTION_MINIMAX_H3_NATIVE_VIDEO_RESOLUTIONS: Record<string, ReadonlySet<string>> = {
  "minimax-h3-fanjin-cinema": new Set(["480p", "768p", "960p"]),
  "minimax-h3-fanjin": new Set(["768p"]),
  "minimax-h3": new Set(["768p"]),
  "minimax-h3-max": new Set(["480p", "768p"]),
};
const PRODUCTION_VIDEO_MODE_LABELS: Record<string, string> = {
  text_to_video: "文生视频",
  image_to_video: "图生视频",
  first_last_frame: "首尾帧",
  omni_reference: "全能参考",
  image_reference: "图片参考",
  reference_to_video: "参考素材生视频",
  video_extension: "视频续写",
  video_edit: "视频编辑",
};

function defaultProductionVideoMode(model: ProductionVideoModel): string {
  if (model.modes.includes("text_to_video")) return "text_to_video";
  return model.modes.length === 1 ? model.modes[0] : "";
}

function productionVideoModeLabel(mode: string): string {
  return PRODUCTION_VIDEO_MODE_LABELS[mode] || mode;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)));
}

function normalizeProductionResolution(value: unknown, modelId?: unknown): string | null {
  const normalized = String(value || "").trim().toLowerCase().replace(/\s+/g, "");
  const canonical = normalized === "720" ? "720p"
    : normalized === "960" ? "960p"
    : normalized === "768" ? "768p"
    : normalized === "1080" ? "1080p"
      : normalized;
  if (PRODUCTION_PUBLIC_VIDEO_RESOLUTIONS.has(canonical)) return canonical;
  const modelResolutions = PRODUCTION_MINIMAX_H3_NATIVE_VIDEO_RESOLUTIONS[
    String(modelId || "").trim().toLowerCase()
  ];
  return modelResolutions?.has(canonical) ? canonical : null;
}

function normalizeProductionResolutions(value: unknown, modelId?: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(
    value
      .map((item) => normalizeProductionResolution(item, modelId))
      .filter((item): item is string => Boolean(item)),
  ));
}

function normalizeProductionDuration(value: unknown): ProductionDurationCapability | null {
  const source = record(value);
  if (!source) return null;
  const min = Number(source.min);
  const max = Number(source.max);
  const step = Number(source.step);
  const defaultValue = Number(source.default);
  const hasAllowed = Object.prototype.hasOwnProperty.call(source, "allowed");
  const rawAllowed = Array.isArray(source.allowed) ? source.allowed : [];
  const allowed = Array.isArray(source.allowed)
    ? Array.from(new Set(source.allowed.map(Number).filter((item) => Number.isFinite(item) && item > 0))).sort((left, right) => left - right)
    : [];
  if (
    !Number.isFinite(min)
    || !Number.isFinite(max)
    || !Number.isFinite(step)
    || !Number.isFinite(defaultValue)
    || min <= 0
    || max < min
    || step <= 0
    || defaultValue < min
    || defaultValue > max
    || (hasAllowed && (!Array.isArray(source.allowed) || rawAllowed.length === 0 || allowed.length !== rawAllowed.length))
    || (allowed.length > 0 && (!allowed.includes(defaultValue) || allowed.some((item) => item < min || item > max)))
  ) return null;
  if (!allowed.length) {
    const steps = (defaultValue - min) / step;
    if (Math.abs(steps - Math.round(steps)) > 1e-9) return null;
  }
  return { min, max, step, default: defaultValue, allowed };
}

/**
 * Complete catalog entries remain visible even while disabled. The canSubmit
 * bit is retained separately and every paid path re-checks it fail-closed.
 */
export function normalizeProductionVideoModels(value: unknown): ProductionVideoModel[] {
  const source = record(value);
  if (!source || !Array.isArray(source.videoModels)) return [];
  const models = source.videoModels.flatMap((item) => {
    const model = record(item);
    if (!model) return [];
    const capabilityStatus = typeof model.capabilityStatus === "string"
      ? model.capabilityStatus.trim().toLowerCase()
      : "";
    const id = typeof model.id === "string" ? model.id.trim() : "";
    const label = typeof model.label === "string" ? model.label.trim() : "";
    const modes = uniqueStrings(model.modes);
    const resolutions = normalizeProductionResolutions(model.resolutions, id);
    const defaultResolution = normalizeProductionResolution(model.defaultResolution, id) || "";
    const aspectRatios = uniqueStrings(model.aspectRatios)
      .filter((ratio) => /^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(ratio));
    const defaultAspectRatio = typeof model.defaultAspectRatio === "string"
      ? model.defaultAspectRatio.trim()
      : "";
    const duration = normalizeProductionDuration(model.duration);
    if (
      !id
      || !label
      || !capabilityStatus
      || !Array.isArray(model.modes)
      || modes.length !== model.modes.length
      || !modes.length
      || !Array.isArray(model.resolutions)
      || resolutions.length !== model.resolutions.length
      || !resolutions.length
      || !defaultResolution
      || !resolutions.includes(defaultResolution)
      || !Array.isArray(model.aspectRatios)
      || aspectRatios.length !== model.aspectRatios.length
      || !aspectRatios.length
      || !defaultAspectRatio
      || !aspectRatios.includes(defaultAspectRatio)
      || !duration
      || typeof model.supportsGenerateAudio !== "boolean"
      || !Array.isArray(model.inputSlots)
    ) return [];
    const canSubmit = model.canSubmit === true
      && PRODUCTION_SUBMITTABLE_CAPABILITY_STATUSES.has(capabilityStatus);
    const unavailableReason = [model.unavailableReason, model.reason]
      .find((value): value is string => typeof value === "string" && Boolean(value.trim()))
      ?.trim();
    return [{
      id,
      label,
      canSubmit,
      ...(unavailableReason ? { unavailableReason } : {}),
      modes,
      resolutions,
      defaultResolution,
      duration,
      supportsGenerateAudio: model.supportsGenerateAudio,
    }];
  });
  return Array.from(new Map(models.map((model) => [model.id, model])).values());
}

function durationSupported(duration: number, capability: ProductionDurationCapability) {
  if (capability.allowed.length) return capability.allowed.includes(duration);
  if (duration < capability.min || duration > capability.max) return false;
  const steps = (duration - capability.min) / capability.step;
  return Math.abs(steps - Math.round(steps)) < 1e-9;
}

function controlledTrackMedia(track: ProductionTrack) {
  return track.medias.filter((media): media is ProductionTrackMedia & {
    id: number;
    src: string;
    fileType: "image" | "video" | "audio";
    sources: "assets" | "storyboard";
  } => (
    Number.isSafeInteger(Number(media.id))
    && Number(media.id) > 0
    && typeof media.src === "string"
    && Boolean(media.src.trim())
    && ["image", "video", "audio"].includes(String(media.fileType))
    && ["assets", "storyboard"].includes(String(media.sources))
  ));
}

function genericReference(media: ReturnType<typeof controlledTrackMedia>[number]): ProductionUploadReference {
  return {
    id: Number(media.id),
    sources: media.sources,
    role: media.sources === "storyboard" ? "storyboard" : "subject",
  };
}

export function buildProductionTrackReferences(
  track: ProductionTrack,
  mode: string,
): { references: ProductionUploadReference[]; error: string | null } {
  const media = controlledTrackMedia(track);
  const images = media.filter((item) => item.fileType === "image");
  const videos = media.filter((item) => item.fileType === "video");
  const audio = media.filter((item) => item.fileType === "audio");
  const label = `分镜「${track.scriptName} / ${track.id}」`;
  if (mode === "text_to_video") return { references: [], error: null };
  if (mode === "image_to_video") {
    const image = images[0];
    return image
      ? {
          references: [{
            id: image.id,
            sources: image.sources,
            role: "first_frame",
          }],
          error: null,
        }
      : { references: [], error: `${label}缺少可用的受控图片参考` };
  }
  if (mode === "first_last_frame") {
    if (images.length < 2) return { references: [], error: `${label}至少需要首帧和尾帧两张受控图片` };
    return {
      references: [
        { id: images[0].id, sources: images[0].sources, role: "first_frame" },
        { id: images[1].id, sources: images[1].sources, role: "last_frame" },
      ],
      error: null,
    };
  }
  if (mode === "image_reference") {
    return images.length
      ? { references: images.slice(0, 9).map(genericReference), error: null }
      : { references: [], error: `${label}缺少可用的受控图片参考` };
  }
  if (mode === "video_extension" || mode === "video_edit") {
    const video = videos[0];
    return video
      ? { references: [genericReference(video)], error: null }
      : { references: [], error: `${label}缺少可用的受控视频参考` };
  }
  if (mode === "reference_to_video" || mode === "omni_reference") {
    const references = [
      ...images.slice(0, 9),
      ...videos.slice(0, 3),
      ...audio.slice(0, 3),
    ].map(genericReference);
    return references.length
      ? { references, error: null }
      : { references: [], error: `${label}缺少可用的受控参考素材` };
  }
  return { references: [], error: `视频模式「${mode || "未选择"}」当前无法映射真实参考素材` };
}

export function validateProductionSubmission(
  models: ProductionVideoModel[],
  setting: ProductionModelSetting,
  tracks: ProductionTrack[],
): string | null {
  const model = models.find((item) => item.id === setting.model);
  if (!model) return "请选择服务端模型目录中的可用视频模型";
  if (!model.canSubmit) return model.unavailableReason || "所选模型当前仅可查看，服务端尚未授权提交";
  if (!setting.mode || !model.modes.includes(setting.mode)) return "请选择该模型真实支持的生成模式";
  if (!setting.resolution || !model.resolutions.includes(setting.resolution)) return "请选择该模型真实支持的清晰度";
  if (setting.audio === null) return "请明确选择是否生成音频";
  if (setting.audio && !model.supportsGenerateAudio) return "所选模型不支持生成音频";
  const invalidTrack = tracks.find((track) => (
    !Number.isFinite(track.duration) || !durationSupported(Number(track.duration), model.duration)
  ));
  if (invalidTrack) return `分镜「${invalidTrack.scriptName} / ${invalidTrack.id}」缺少该模型支持的真实时长`;
  const emptyPrompt = tracks.find((track) => !track.prompt.trim());
  if (emptyPrompt) return `分镜「${emptyPrompt.scriptName} / ${emptyPrompt.id}」缺少视频提示词`;
  for (const track of tracks) {
    const prepared = buildProductionTrackReferences(track, setting.mode);
    if (prepared.error) return prepared.error;
  }
  return null;
}

const PRODUCTION_ACTIVE_STATES = new Set<ProductionTaskState>(["排队中", "生成中", "增强中"]);
const PRODUCTION_DELETABLE_STATES = new Set<ProductionTaskState>(["已完成", "生成失败", "已取消"]);
const PRODUCTION_RETRYABLE_STATES = new Set<ProductionTaskState>(["未生成", "生成失败", "已取消"]);
export const PRODUCTION_POLL_INTERVAL_MS = 5_000;

function normalizeOneProductionTaskState(value?: string | null): ProductionTaskState {
  const normalized = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!normalized) return "状态未知";
  if (["未生成", "待生成", "not_started", "idle"].includes(normalized)) return "未生成";
  if (["排队中", "等待中", "queued", "pending", "accepted", "submitted"].includes(normalized)) return "排队中";
  if (["生成中", "处理中", "running", "processing", "in_progress", "generating"].includes(normalized)) return "生成中";
  if (["增强中", "超分中", "清晰度增强中", "enhancing", "upscaling", "quality_enhancing"].includes(normalized)) return "增强中";
  if (["已完成", "生成成功", "succeeded", "success", "completed", "complete", "done"].includes(normalized)) return "已完成";
  if (["生成失败", "失败", "failed", "failure", "error", "errored"].includes(normalized)) return "生成失败";
  if (["已取消", "取消", "cancelled", "canceled"].includes(normalized)) return "已取消";
  return "状态未知";
}

/** Relay state is authoritative when present; the legacy video state remains a fallback. */
export function normalizeProductionTaskState(
  state?: string | null,
  relayState?: string | null,
): ProductionTaskState {
  const relay = normalizeOneProductionTaskState(relayState);
  return relay !== "状态未知" ? relay : normalizeOneProductionTaskState(state);
}

export function isActiveProductionTaskState(state?: string | null) {
  return PRODUCTION_ACTIVE_STATES.has(normalizeProductionTaskState(state));
}

export function productionVideoState(video: Pick<ProductionVideo, "state" | "relayStatus">) {
  return normalizeProductionTaskState(video.state, video.relayStatus);
}

export function isCancellableProductionVideo(
  video: Pick<ProductionVideo, "state" | "relayStatus" | "relayTaskId">,
) {
  return Boolean(video.relayTaskId && PRODUCTION_ACTIVE_STATES.has(productionVideoState(video)));
}

export function isDeletableProductionVideo(
  track: Pick<ProductionTrack, "videoList">,
  video: Pick<ProductionVideo, "state" | "relayStatus">,
) {
  return PRODUCTION_DELETABLE_STATES.has(productionVideoState(video))
    && !track.videoList.some((candidate) => (
      PRODUCTION_ACTIVE_STATES.has(productionVideoState(candidate))
    ));
}

export function productionTrackHasActiveTask(
  track: Pick<ProductionTrack, "state" | "videoList">,
) {
  if (track.videoList.length) {
    return track.videoList.some((video) => PRODUCTION_ACTIVE_STATES.has(productionVideoState(video)));
  }
  return PRODUCTION_ACTIVE_STATES.has(normalizeProductionTaskState(track.state));
}

export function isDefaultGeneratableProductionTrack(
  track: Pick<ProductionTrack, "state" | "videoList">,
) {
  if (productionTrackHasActiveTask(track)) return false;
  if (track.videoList.some((video) => productionVideoState(video) === "已完成")) return false;
  if (!track.videoList.length) {
    return PRODUCTION_RETRYABLE_STATES.has(normalizeProductionTaskState(track.state));
  }
  return track.videoList.every((video) => PRODUCTION_RETRYABLE_STATES.has(productionVideoState(video)));
}

export function selectProductionTracksForSubmission(
  tracks: ProductionTrack[],
  selectedIds: number[],
) {
  if (selectedIds.length) {
    const selected = new Set(selectedIds);
    return tracks.filter((track) => selected.has(track.id) && !productionTrackHasActiveTask(track));
  }
  return tracks.filter(isDefaultGeneratableProductionTrack);
}

export function shouldPollProductionGroups(groups: ProductionGroup[]) {
  return groups.some((group) => group.tracks.some(productionTrackHasActiveTask));
}

type ProductionRefreshResult = {
  status: "success" | "failed" | "aborted";
  hasActiveTasks: boolean;
};

function isAbortError(error: unknown) {
  return Boolean(error && typeof error === "object" && "name" in error && error.name === "AbortError");
}

function productionSubmissionAttemptKey(projectId: number, scriptId: number, trackId: number) {
  return `${projectId}:${scriptId}:${trackId}`;
}

function parseTrackSubmissionResponse(
  response: unknown,
  trackId: number,
): { video: ProductionVideo | null; error: string | null; definitiveFailure: boolean } {
  if (!Array.isArray(response) || response.length !== 1) {
    return {
      video: null,
      error: "视频任务响应数量不完整，无法确认是否已提交",
      definitiveFailure: false,
    };
  }
  const task = record(response[0]);
  if (!task || Number(task.trackId) !== trackId) {
    return {
      video: null,
      error: "视频任务响应缺少对应的分镜",
      definitiveFailure: false,
    };
  }
  const explicitErrorReason = typeof task.errorReason === "string"
    ? task.errorReason.trim()
    : "";
  if (explicitErrorReason) {
    return {
      video: null,
      error: explicitErrorReason,
      definitiveFailure: true,
    };
  }
  if (!Number.isSafeInteger(Number(task.videoId)) || Number(task.videoId) <= 0) {
    return {
      video: null,
      error: "视频任务响应缺少视频 ID",
      definitiveFailure: false,
    };
  }
  if (
    typeof task.relayTaskId !== "string"
    || !task.relayTaskId.trim()
  ) {
    return {
      video: null,
      error: "视频任务未成功进入上游队列",
      definitiveFailure: false,
    };
  }
  const relay = record(task.relay);
  const relayStatus = typeof task.relayStatus === "string"
    ? task.relayStatus
    : typeof relay?.status === "string"
      ? relay.status
      : "queued";
  const normalizedState = normalizeProductionTaskState(
    typeof task.state === "string" ? task.state : null,
    relayStatus,
  );
  return {
    video: {
      id: Number(task.videoId),
      src: typeof task.src === "string" ? task.src : "",
      state: normalizedState === "状态未知" ? "排队中" : normalizedState,
      errorReason: "",
      relayTaskId: task.relayTaskId.trim(),
      relayStatus,
      preparationStage: task.preparationStage === "portrait_registration" ? "portrait_registration" : null,
      statusMessage: typeof task.statusMessage === "string" ? task.statusMessage : null,
    },
    error: null,
    definitiveFailure: false,
  };
}

function formatSceneNumber(v: number) {
  const n = ["零","一","二","三","四","五","六","七","八","九","十"];
  if (v <= 10) return n[v];
  if (v < 20) return `十${n[v - 10]}`;
  return `${n[Math.floor(v/10)] || Math.floor(v/10)}十${v%10 ? n[v%10] : ""}`;
}

export function productionGroupsToCommerceTaskEvidence(groups: ProductionGroup[], projectId?: number): CommerceTaskEvidence[] {
  return groups.flatMap((group) => group.tracks.flatMap((track) => track.videoList.map((video) => {
    const state = productionVideoState(video);
    const status = state === "已完成" ? "succeeded"
      : state === "生成失败" ? "failed"
        : state === "已取消" ? "cancelled"
          : "running";
    return {
      videoId: video.id,
      ...(video.relayTaskId ? { relayTaskId: video.relayTaskId } : {}),
      status,
      ...(video.src ? { url: video.src } : {}),
      ...(video.errorReason ? { errorReason: video.errorReason } : {}),
      ...(projectId ? { operationKey: productionSubmissionAttemptKey(projectId, track.scriptId, track.id) } : {}),
    };
  })));
}

async function syncCommerceVariantBatch(
  projectId: number,
  tasks: CommerceTaskEvidence[],
  linkActiveItem: boolean,
) {
  if (!tasks.length) return;
  const state = useSessionStore.getState();
  if (state.boundProjectId !== projectId) return;
  const batch = normalizeCommerceVariantBatch(state.session?.parameters?.commerceVariantBatch);
  if (!batch) return;
  const next = linkActiveItem && batch.activeItemId
    ? linkCommerceVariantBatchTasks(batch, batch.activeItemId, tasks)
    : reconcileCommerceVariantBatchTasks(batch, tasks);
  if (next === batch) return;
  await state.saveSession({ parameters: { commerceVariantBatch: next } });
}

interface Props {
  showPreviousFlowAction?: boolean;
  showClipWorkbenchAction?: boolean;
  onPreviousFlow?: () => void;
  onOpenClipWorkbench?: () => void;
}

export default function ProductionWorkbench({ showPreviousFlowAction, showClipWorkbenchAction, onPreviousFlow, onOpenClipWorkbench }: Props) {
  const theme = useV4Theme();
  const currentProject = useProjectStore((s) => s.currentProject);
  const currentProjectId = Number.isSafeInteger(Number(currentProject?.id)) && Number(currentProject?.id) > 0
    ? Number(currentProject?.id)
    : null;
  const [activeView, setActiveView] = useState<ViewMode>("list");
  const [scripts, setScripts] = useState<ScriptItem[]>([]);
  const [groups, setGroups] = useState<ProductionGroup[]>([]);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [batchGenerating, setBatchGenerating] = useState(false);
  const [generationError, setGenerationError] = useState("");
  const [selectingVideoId, setSelectingVideoId] = useState<number | null>(null);
  const [cancellingRelayTaskId, setCancellingRelayTaskId] = useState("");
  const [playingSrc, setPlayingSrc] = useState("");
  const [videoModels, setVideoModels] = useState<ProductionVideoModel[]>([]);
  const [modelCatalogLoading, setModelCatalogLoading] = useState(true);
  const [modelCatalogError, setModelCatalogError] = useState("");
  const [modelSetting, setModelSetting] = useState<ProductionModelSetting>({ model: "", mode: "", resolution: "", audio: null });
  const [deleteIntent, setDeleteIntent] = useState<ProductionVideoDeleteIntent | null>(null);
  const [deleteError, setDeleteError] = useState<ProductionVideoDeleteError | null>(null);
  const videoSubmissionAttemptsRef = useRef(new Map<string, StableSubmissionAttempt>());
  const activeProjectIdRef = useRef<number | null>(currentProjectId);
  const refreshEpochRef = useRef(0);
  const refreshControllerRef = useRef<AbortController | null>(null);
  const hasActiveTasksRef = useRef(false);
  const submissionEpochRef = useRef(0);
  const submittingProjectRef = useRef<number | null>(null);
  const deleteIntentRef = useRef<ProductionVideoDeleteIntent | null>(null);
  activeProjectIdRef.current = currentProjectId;

  const allTracks = useMemo(() => groups.flatMap((g) => g.tracks), [groups]);
  const completedCount = useMemo(() => allTracks.filter((t) => t.videoList.some((v) => productionVideoState(v) === "已完成")).length, [allTracks]);
  const hasActiveTasks = useMemo(() => shouldPollProductionGroups(groups), [groups]);
  hasActiveTasksRef.current = hasActiveTasks;
  const selectedModel = useMemo(
    () => videoModels.find((model) => model.id === modelSetting.model) || null,
    [modelSetting.model, videoModels],
  );

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    setVideoModels([]);
    setModelCatalogLoading(true);
    setModelCatalogError("");
    setModelSetting({ model: "", mode: "", resolution: "", audio: null });
    void apiPost<unknown>("/workbench/create/modelOptions", {}, undefined, { signal: controller.signal })
      .then((response) => {
        if (!alive) return;
        const models = normalizeProductionVideoModels(response);
        setVideoModels(models);
        const submittableModels = models.filter((model) => model.canSubmit);
        if (!submittableModels.length) {
          setModelCatalogError("服务端未返回能力完整且可提交的视频模型");
        }
        const storedSetting = currentProjectId
          ? readProductionModelSetting(currentProjectId, models)
          : null;
        if (storedSetting) {
          setModelSetting(storedSetting);
          return;
        }
        const configuredModelId = typeof currentProject?.videoModel === "string"
          ? currentProject.videoModel.trim()
          : "";
        if (!configuredModelId) return;
        const configuredModel = submittableModels.find((model) => model.id === configuredModelId);
        if (!configuredModel) {
          setModelCatalogError("项目配置的视频模型不在当前工作区可提交目录中，请重新选择");
          return;
        }
        setModelSetting({
          model: configuredModel.id,
          mode: defaultProductionVideoMode(configuredModel),
          resolution: configuredModel.defaultResolution,
          audio: configuredModel.supportsGenerateAudio ? null : false,
        });
      })
      .catch((error) => {
        if (!alive || isAbortError(error)) return;
        setVideoModels([]);
        setModelCatalogError(error instanceof Error ? error.message : "视频模型目录读取失败");
      })
      .finally(() => {
        if (alive) setModelCatalogLoading(false);
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [currentProject?.id, currentProject?.videoModel]);

  useEffect(() => {
    if (!currentProjectId) return;
    const normalized = normalizeStoredProductionModelSetting(modelSetting, videoModels);
    if (!normalized) return;
    writeProductionModelSetting(currentProjectId, normalized);
  }, [currentProjectId, modelSetting, videoModels]);

  const refresh = useCallback(async (
    options: { background?: boolean } = {},
  ): Promise<ProductionRefreshResult> => {
    const projectId = currentProjectId;
    if (!projectId) return { status: "aborted", hasActiveTasks: false };
    refreshControllerRef.current?.abort();
    const controller = new AbortController();
    refreshControllerRef.current = controller;
    const epoch = ++refreshEpochRef.current;
    const isCurrent = () => (
      !controller.signal.aborted
      && refreshEpochRef.current === epoch
      && activeProjectIdRef.current === projectId
    );
    if (!options.background) {
      setLoading(true);
      setLoadError("");
    }
    try {
      const scriptResponse = await apiPost<unknown>(
        "/script/getScrptApi",
        { projectId, name: "" },
        undefined,
        { signal: controller.signal },
      );
      if (!Array.isArray(scriptResponse)) throw new Error("剧本列表响应格式无效，已阻止展示空数据");
      const sc: ScriptItem[] = scriptResponse.map((item) => {
        const script = record(item);
        const id = Number(script?.id);
        if (!script || !Number.isSafeInteger(id) || id <= 0 || typeof script.name !== "string" || typeof script.content !== "string") {
          throw new Error("剧本列表缺少有效 ID、名称或内容，已阻止展示不完整数据");
        }
        return { id, name: script.name, content: script.content };
      });
      const grs = await Promise.all(sc.map(async (script) => {
        const response = await apiPost<unknown>(
          "/production/workbench/getGenerateData",
          { projectId, scriptId: script.id },
          undefined,
          { signal: controller.signal },
        );
        if (typeof response === "string" && response.trim()) throw new Error(response.trim());
        const result = record(response);
        if (!result || !Array.isArray(result.trackList)) {
          throw new Error(`剧本「${script.name}」的制作数据响应缺少 trackList，已阻止展示空数据`);
        }
        const trackList = result.trackList;
        const tracks: ProductionTrack[] = trackList.map((item) => {
          const track = record(item);
          const id = Number(track?.id);
          if (!track || !Number.isSafeInteger(id) || id <= 0 || !Array.isArray(track.medias) || !Array.isArray(track.videoList)) {
            throw new Error(`剧本「${script.name}」包含字段不完整的分镜，已阻止展示`);
          }
          return {
            id,
            scriptId: script.id,
            scriptName: script.name,
            prompt: typeof track.prompt === "string" ? track.prompt : "",
            state: normalizeProductionTaskState(typeof track.state === "string" ? track.state : null),
            selectVideoId: Number.isSafeInteger(Number(track.selectVideoId)) && Number(track.selectVideoId) > 0 ? Number(track.selectVideoId) : null,
            medias: track.medias.map((value) => {
              const media = record(value);
              return {
                id: Number.isSafeInteger(Number(media?.id)) && Number(media?.id) > 0 ? Number(media?.id) : undefined,
                src: typeof media?.src === "string" ? media.src : "",
                fileType: ["image", "video", "audio"].includes(String(media?.fileType))
                  ? media?.fileType as "image" | "video" | "audio"
                  : undefined,
                sources: ["assets", "storyboard"].includes(String(media?.sources))
                  ? media?.sources as "assets" | "storyboard"
                  : undefined,
              };
            }),
            videoList: track.videoList.map((value) => {
              const video = record(value);
              const relay = record(video?.relay);
              const videoId = Number(video?.id);
              if (!video || !Number.isSafeInteger(videoId) || videoId <= 0) {
                throw new Error(`剧本「${script.name}」包含字段不完整的视频任务，已阻止展示`);
              }
              return {
                id: videoId,
                src: typeof video.src === "string" ? video.src : "",
                state: normalizeProductionTaskState(
                  typeof video.state === "string" ? video.state : null,
                  typeof relay?.status === "string" ? relay.status : null,
                ),
                errorReason: typeof video.errorReason === "string" ? video.errorReason : "",
                relayTaskId: typeof video.relayTaskId === "string"
                  ? video.relayTaskId
                  : typeof relay?.id === "string"
                    ? relay.id
                    : null,
                relayStatus: typeof relay?.status === "string" ? relay.status : "",
                preparationStage: video.preparationStage === "portrait_registration" || relay?.preparationStage === "portrait_registration" ? "portrait_registration" : null,
                statusMessage: typeof video.statusMessage === "string" ? video.statusMessage : typeof relay?.statusMessage === "string" ? relay.statusMessage : null,
              };
            }),
            duration: Number.isFinite(Number(track.duration)) && Number(track.duration) > 0 ? Number(track.duration) : null,
          };
        });
        return { script, tracks };
      }));
      if (!isCurrent()) return { status: "aborted", hasActiveTasks: false };
      const nextTrackIds = new Set(grs.flatMap((group) => group.tracks.map((track) => track.id)));
      setScripts(sc);
      setGroups(grs);
      void syncCommerceVariantBatch(projectId, productionGroupsToCommerceTaskEvidence(grs, projectId), false).catch((error) => {
        if (activeProjectIdRef.current === projectId) {
          setGenerationError(`电商批次状态同步失败：${error instanceof Error ? error.message : "请求失败"}`);
        }
      });
      setSelectedIds((current) => current.filter((id) => nextTrackIds.has(id)));
      setLoadError("");
      return {
        status: "success",
        hasActiveTasks: shouldPollProductionGroups(grs),
      };
    } catch (error) {
      if (!isCurrent() || isAbortError(error)) {
        return { status: "aborted", hasActiveTasks: false };
      }
      if (!options.background) {
        setScripts([]);
        setGroups([]);
        setSelectedIds([]);
        setLoadError(error instanceof Error ? error.message : "制作数据读取失败");
      }
      return { status: "failed", hasActiveTasks: hasActiveTasksRef.current };
    } finally {
      if (refreshControllerRef.current === controller) refreshControllerRef.current = null;
      if (!options.background && activeProjectIdRef.current === projectId) setLoading(false);
    }
  }, [currentProjectId]);

  useEffect(() => {
    refreshControllerRef.current?.abort();
    refreshEpochRef.current += 1;
    setScripts([]);
    setGroups([]);
    setSelectedIds([]);
    setPlayingSrc("");
    setGenerationError("");
    submissionEpochRef.current += 1;
    submittingProjectRef.current = null;
    setBatchGenerating(false);
    setSelectingVideoId(null);
    setCancellingRelayTaskId("");
    deleteIntentRef.current = null;
    setDeleteIntent(null);
    setDeleteError(null);
    setLoading(Boolean(currentProjectId));
    setLoadError("");
    if (!currentProjectId) return undefined;

    let cancelled = false;
    let retryTimer: number | null = null;
    const load = async (background: boolean) => {
      const result = await refresh({ background });
      if (!cancelled && result.status === "failed") {
        retryTimer = window.setTimeout(() => {
          void load(true);
        }, PRODUCTION_POLL_INTERVAL_MS);
      }
    };
    void load(false);
    return () => {
      cancelled = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      refreshControllerRef.current?.abort();
      refreshControllerRef.current = null;
      refreshEpochRef.current += 1;
    };
  }, [currentProjectId, refresh]);

  useEffect(() => {
    if (!currentProjectId || !hasActiveTasks) return undefined;
    let cancelled = false;
    let pollTimer: number | null = null;
    const schedule = () => {
      if (cancelled) return;
      pollTimer = window.setTimeout(() => {
        void poll();
      }, PRODUCTION_POLL_INTERVAL_MS);
    };
    const poll = async () => {
      if (cancelled) return;
      if (document.visibilityState === "hidden") {
        schedule();
        return;
      }
      const result = await refresh({ background: true });
      if (!cancelled && (result.status !== "success" || result.hasActiveTasks)) schedule();
    };
    schedule();
    return () => {
      cancelled = true;
      if (pollTimer !== null) window.clearTimeout(pollTimer);
    };
  }, [currentProjectId, hasActiveTasks, refresh]);

  useEffect(() => {
    if (!currentProjectId) return undefined;
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void refresh({ background: true });
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [currentProjectId, refresh]);

  async function generateTracks(tracks: ProductionTrack[]) {
    const projectId = currentProjectId;
    if (!projectId || !tracks.length || submittingProjectRef.current === projectId) return;
    const validationError = validateProductionSubmission(videoModels, modelSetting, []);
    if (validationError) {
      setGenerationError(validationError);
      return;
    }
    const submissionSetting = { ...modelSetting, audio: modelSetting.audio as boolean };
    const submissionEpoch = ++submissionEpochRef.current;
    const isCurrentSubmission = () => (
      submissionEpochRef.current === submissionEpoch
      && activeProjectIdRef.current === projectId
    );
    submittingProjectRef.current = projectId;
    setBatchGenerating(true);
    setGenerationError("");
    try {
      const submitTrack = async (track: ProductionTrack) => {
        let attemptKey = "";
        let storageKey = "";
        let submissionKey = "";
        let submissionFingerprint = "";
        const knownTaskIds = track.videoList.map((video) => (
          video.relayTaskId || `video-${video.id}`
        ));
        try {
          const trackError = validateProductionSubmission(videoModels, submissionSetting, [track]);
          if (trackError) return {
            track, ok: false as const, error: trackError, video: null, definitiveFailure: true,
            submissionKey: "", submissionFingerprint: "", knownTaskIds,
          };
          const prepared = buildProductionTrackReferences(track, submissionSetting.mode);
          if (prepared.error) throw new Error(prepared.error);
          const submissionPayload = {
            projectId,
            scriptId: track.scriptId,
            model: submissionSetting.model,
            mode: submissionSetting.mode,
            resolution: submissionSetting.resolution,
            audio: submissionSetting.audio,
            trackData: [{
            trackId: track.id,
            prompt: track.prompt,
            duration: track.duration as number,
            uploadData: prepared.references,
            }],
          };
          attemptKey = productionSubmissionAttemptKey(projectId, track.scriptId, track.id);
          const preparedAttempt = prepareStoredSubmissionAttempt({
            current: videoSubmissionAttemptsRef.current.get(attemptKey) || null,
            flow: "production-video",
            operationKey: attemptKey,
            prefix: `production-video-${projectId}-${track.scriptId}-${track.id}`,
            payload: submissionPayload,
          });
          let { attempt } = preparedAttempt;
          submissionKey = attempt.idempotencyKey;
          submissionFingerprint = attempt.fingerprint;
          storageKey = preparedAttempt.storageKey;
          const sessionState = useSessionStore.getState();
          const commerceBatch = sessionState.boundProjectId === projectId
            ? normalizeCommerceVariantBatch(sessionState.session?.parameters?.commerceVariantBatch)
            : null;
          const pendingSubmission = commerceBatch
            ? commercePendingSubmissionForOperation(commerceBatch, attemptKey)
            : null;
          if (pendingSubmission && pendingSubmission.key !== submissionKey) {
            if (pendingSubmission.fingerprint === attempt.fingerprint) {
              attempt = { ...attempt, idempotencyKey: pendingSubmission.key };
              submissionKey = pendingSubmission.key;
              writeStoredSubmissionAttempt(storageKey, attempt);
            } else {
              clearStoredSubmissionAttempt(storageKey);
              videoSubmissionAttemptsRef.current.delete(attemptKey);
              return {
                track,
                ok: false as const,
                error: "该分镜仍有待核对的生成任务；请保持原参数重试，或等待任务状态同步后再修改",
                video: null,
                definitiveFailure: false,
                submissionKey: pendingSubmission.key,
                submissionFingerprint: pendingSubmission.fingerprint,
                knownTaskIds: pendingSubmission.knownTaskIds,
              };
            }
          }
          videoSubmissionAttemptsRef.current.set(attemptKey, attempt);
          const response = await apiPost<unknown>(
            "/production/workbench/batchGenerateVideo",
            submissionPayload,
            undefined,
            { headers: { "Idempotency-Key": attempt.idempotencyKey } },
          );
          const parsed = parseTrackSubmissionResponse(response, track.id);
          if (parsed.error || !parsed.video) {
            if (parsed.definitiveFailure) {
              clearStoredSubmissionAttempt(storageKey);
              videoSubmissionAttemptsRef.current.delete(attemptKey);
            }
            return {
              track,
              ok: false as const,
              error: parsed.error || "视频任务响应无效",
              video: null,
              definitiveFailure: parsed.definitiveFailure,
              submissionKey,
              submissionFingerprint,
              knownTaskIds,
            };
          }
          clearStoredSubmissionAttempt(storageKey);
          videoSubmissionAttemptsRef.current.delete(attemptKey);
          return { track, ok: true as const, error: "", video: parsed.video, submissionKey, submissionFingerprint, knownTaskIds };
        } catch (error) {
          const definitiveFailure = !shouldRetainStoredSubmissionAttempt(error);
          if (storageKey && definitiveFailure) {
            clearStoredSubmissionAttempt(storageKey);
            if (attemptKey) videoSubmissionAttemptsRef.current.delete(attemptKey);
          }
          return {
            track,
            ok: false as const,
            error: error instanceof Error ? error.message : "视频任务提交失败",
            video: null,
            definitiveFailure,
            submissionKey: submissionKey || attemptKey,
            submissionFingerprint,
            knownTaskIds,
          };
        }
      };
      // Admission is serialized; accepted tasks still run in the backend queue.
      // This avoids bursts against the same workspace and preserves per-track recovery keys.
      const results: Awaited<ReturnType<typeof submitTrack>>[] = [];
      for (const track of tracks) {
        if (!isCurrentSubmission()) return;
        results.push(await submitTrack(track));
      }
      if (!isCurrentSubmission()) return;
      const acceptedByTrackId = new Map(results
        .filter((result) => result.ok && result.video)
        .map((result) => [result.track.id, result.video!]));
      if (acceptedByTrackId.size) {
        setGroups((current) => current.map((group) => ({
          ...group,
          tracks: group.tracks.map((track) => {
            const acceptedVideo = acceptedByTrackId.get(track.id);
            if (!acceptedVideo) return track;
            const existingVideo = track.videoList.find((video) => video.id === acceptedVideo.id);
            return {
              ...track,
              state: acceptedVideo.state,
              videoList: existingVideo
                ? track.videoList.map((video) => video.id === acceptedVideo.id ? acceptedVideo : video)
                : [...track.videoList, acceptedVideo],
            };
          }),
        })));
      }
      try {
        await syncCommerceVariantBatch(
          projectId,
          results.flatMap((result) => {
            const operationKey = productionSubmissionAttemptKey(projectId, result.track.scriptId, result.track.id);
            return result.ok && result.video
              ? productionGroupsToCommerceTaskEvidence([{
                  script: { id: result.track.scriptId, name: result.track.scriptName, content: "" },
                  tracks: [{ ...result.track, videoList: [result.video] }],
                }]).map((task) => ({
                  ...task,
                  submissionKey: result.submissionKey,
                  fingerprint: result.submissionFingerprint,
                  operationKey,
                  knownTaskIds: result.knownTaskIds,
                }))
              : [{
                  status: result.definitiveFailure ? "failed" : "pending",
                  submissionKey: result.submissionKey,
                  fingerprint: result.submissionFingerprint,
                  operationKey,
                  knownTaskIds: result.knownTaskIds,
                  errorReason: result.error,
                }];
          }),
          true,
        );
      } catch (error) {
        setGenerationError(`任务已提交，但电商批次关联失败：${error instanceof Error ? error.message : "请求失败"}`);
      }
      await refresh({ background: true });
      if (!isCurrentSubmission()) return;
      const failures = results.filter((result) => !result.ok);
      if (failures.length) {
        const succeededCount = results.length - failures.length;
        setGenerationError(
          `${succeededCount ? `${succeededCount} 条已进入队列，` : ""}${failures.length} 条提交失败：${failures
            .map((result) => `${result.track.scriptName} / ${result.track.id}：${result.error}`)
            .join("；")}`,
        );
      }
    } finally {
      if (isCurrentSubmission()) {
        submittingProjectRef.current = null;
        setBatchGenerating(false);
      }
    }
  }

  async function selectFinalVideo(track: ProductionTrack, video: ProductionVideo) {
    const projectId = currentProjectId;
    if (!projectId || productionVideoState(video) !== "已完成" || !video.src) return;
    setSelectingVideoId(video.id);
    setGenerationError("");
    try {
      await apiPost("/production/workbench/selectVideo", {
        projectId,
        trackId: track.id,
        videoId: video.id,
      }, undefined, {
        headers: {
          "Idempotency-Key":
            `production-select:${projectId}:${track.id}:${video.id}`,
        },
      });
      if (activeProjectIdRef.current === projectId) await refresh({ background: true });
    } catch (error) {
      if (activeProjectIdRef.current === projectId) {
        setGenerationError(error instanceof Error ? error.message : "设置成片失败");
      }
    } finally {
      if (activeProjectIdRef.current === projectId) setSelectingVideoId(null);
    }
  }

  async function cancelProductionVideo(video: ProductionVideo) {
    const projectId = currentProjectId;
    if (!projectId || !isCancellableProductionVideo(video) || !video.relayTaskId || cancellingRelayTaskId) return;
    setCancellingRelayTaskId(video.relayTaskId);
    setGenerationError("");
    try {
      await apiDelete(`/workbench/canvas/tasks/${encodeURIComponent(video.relayTaskId)}`);
      if (activeProjectIdRef.current === projectId) await refresh({ background: true });
    } catch (error) {
      if (activeProjectIdRef.current === projectId) {
        setGenerationError(error instanceof Error ? error.message : "视频任务取消失败");
      }
    } finally {
      if (activeProjectIdRef.current === projectId) setCancellingRelayTaskId("");
    }
  }

  function openDeleteVideo(track: ProductionTrack, video: ProductionVideo) {
    const projectId = currentProjectId;
    if (!projectId || !isDeletableProductionVideo(track, video)) return;
    const payload = { projectId, id: video.id };
    const attempt = resolveStableSubmissionAttempt(
      null,
      `production-video-delete:${projectId}`,
      payload,
    );
    const nextIntent = {
      projectId,
      trackId: track.id,
      videoId: video.id,
      src: video.src,
      intentToken: crypto.randomUUID(),
      idempotencyKey: attempt.idempotencyKey,
    };
    deleteIntentRef.current = nextIntent;
    setDeleteError(null);
    setDeleteIntent(nextIntent);
  }

  function isCurrentDeleteIntent(
    intent: ProductionVideoDeleteIntent | null,
  ): intent is ProductionVideoDeleteIntent {
    return Boolean(
      intent
      && deleteIntentRef.current?.intentToken === intent.intentToken
      && deleteIntentRef.current.projectId === intent.projectId
      && activeProjectIdRef.current === intent.projectId,
    );
  }

  function closeDeleteIntent(intentToken: string) {
    if (deleteIntentRef.current?.intentToken !== intentToken) return;
    deleteIntentRef.current = null;
    setDeleteIntent((current) => current?.intentToken === intentToken ? null : current);
    setDeleteError((current) => current?.intentToken === intentToken ? null : current);
  }

  function reportDeleteError(intent: ProductionVideoDeleteIntent | null, error: unknown) {
    if (!isCurrentDeleteIntent(intent)) return;
    setDeleteError({
      intentToken: intent.intentToken,
      message: error instanceof Error ? error.message : "视频删除失败",
    });
  }

  async function confirmDeleteVideo(intent: ProductionVideoDeleteIntent | null) {
    if (!isCurrentDeleteIntent(intent)) return false;
    await apiPost(
      "/production/workbench/delVideo",
      { projectId: intent.projectId, id: intent.videoId },
      undefined,
      { headers: { "Idempotency-Key": intent.idempotencyKey } },
    );
    if (!isCurrentDeleteIntent(intent)) return false;
    setGroups((current) => activeProjectIdRef.current === intent.projectId
      ? current.map((group) => ({
          ...group,
          tracks: group.tracks.map((track) => track.id === intent.trackId
            ? {
                ...track,
                selectVideoId: track.selectVideoId === intent.videoId ? null : track.selectVideoId,
                videoList: track.videoList.filter((video) => video.id !== intent.videoId),
              }
            : track),
        }))
      : current);
    setPlayingSrc((current) => (
      activeProjectIdRef.current === intent.projectId && current === intent.src ? "" : current
    ));
    void refresh({ background: true });
    return true;
  }

  function toggleSelect(id: number) { setSelectedIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]); }
  function toggleAll(checked: boolean) { setSelectedIds(checked ? allTracks.map((t) => t.id) : []); }

  function getStatusBadge(t: ProductionTrack): { text: string; color: string; bg: string } {
    const states = t.videoList.map(productionVideoState);
    if (states.includes("增强中")) return { text: "增强中", color: "var(--front-accent)", bg: "rgba(93,148,189,0.12)" };
    if (states.includes("生成中")) return { text: "生成中", color: "var(--front-accent)", bg: "rgba(93,148,189,0.12)" };
    if (states.includes("排队中")) return { text: "排队中", color: "var(--front-accent)", bg: "rgba(93,148,189,0.12)" };
    if (states.includes("已完成")) return { text: "已完成", color: "#16833a", bg: "rgba(52,199,89,0.14)" };
    if (states.includes("生成失败")) return { text: "生成失败", color: "#c9352b", bg: "rgba(255,59,48,0.12)" };
    if (states.includes("已取消")) return { text: "已取消", color: "var(--front-muted)", bg: "rgba(120,120,128,0.12)" };
    const trackState = normalizeProductionTaskState(t.state);
    if (trackState === "未生成") return { text: "待生成", color: "var(--front-muted)", bg: "rgba(120,120,128,0.12)" };
    if (PRODUCTION_ACTIVE_STATES.has(trackState)) return { text: trackState, color: "var(--front-accent)", bg: "rgba(93,148,189,0.12)" };
    return { text: trackState, color: trackState === "生成失败" ? "#c9352b" : "var(--front-muted)", bg: trackState === "生成失败" ? "rgba(255,59,48,0.12)" : "rgba(120,120,128,0.12)" };
  }

  const generatable = useMemo(
    () => selectProductionTracksForSubmission(allTracks, selectedIds),
    [allTracks, selectedIds],
  );
  const modelConfigurationError = useMemo(() => (
    modelCatalogLoading
      ? "视频模型目录正在加载"
      : modelCatalogError && !videoModels.length
        ? modelCatalogError
        : validateProductionSubmission(videoModels, modelSetting, [])
  ), [modelCatalogError, modelCatalogLoading, modelSetting, videoModels]);

  function selectModel(modelId: string) {
    const model = videoModels.find((item) => item.id === modelId);
    setGenerationError("");
    if (!model || !model.canSubmit) {
      if (model?.unavailableReason) setModelCatalogError(model.unavailableReason);
      setModelSetting({ model: "", mode: "", resolution: "", audio: null });
      return;
    }
    setModelCatalogError("");
    setModelSetting({
      model: model.id,
      mode: defaultProductionVideoMode(model),
      resolution: model.defaultResolution,
      audio: model.supportsGenerateAudio ? null : false,
    });
  }

  return (
    <div className="frontPagePalette frontProductionPage" data-theme={theme.mode} data-testid="quick-production-page" style={{ width: "100%", height: "100%", minHeight: 0, display: "flex", flexDirection: "column", color: "var(--front-text)" }}>
      {/* Preview */}
      {playingSrc ? (
        <div style={{ width: "100%", background: "#050608", borderRadius: "12px 12px 0 0", overflow: "hidden" }}>
          <video src={playingSrc} controls style={{ width: "100%", maxHeight: 450, objectFit: "contain" }} />
        </div>
      ) : null}

      {/* Header */}
      <div style={{ minWidth: 0, display: "flex", justifyContent: "space-between", gap: 14, padding: "14px 16px", border: "1px solid var(--front-line)", borderRadius: playingSrc ? "0 0 0 0" : "12px 12px 0 0", background: "var(--front-surface)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          {(["list", "board", "timeline"] as ViewMode[]).map((m) => (
            <button key={m} onClick={() => setActiveView(m)} style={{ height: 34, padding: "0 4px", border: 0, borderBottom: activeView === m ? "3px solid var(--front-accent)" : "3px solid transparent", background: "transparent", color: activeView === m ? "var(--front-text)" : "var(--front-muted)", cursor: "pointer", fontSize: 15, fontWeight: 760 }}>
              {m === "list" ? "视频列表" : m === "board" ? "故事板" : "时间线"}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {showPreviousFlowAction && <button onClick={onPreviousFlow} style={{ padding: "6px 14px", border: "1px solid var(--front-line)", borderRadius: 8, background: "var(--front-surface)", cursor: "pointer", fontSize: 13 }}>上一步</button>}
          {showClipWorkbenchAction && <button onClick={onOpenClipWorkbench} style={{ padding: "6px 14px", border: "none", borderRadius: 8, background: "var(--front-accent)", color: "#fff", cursor: "pointer", fontSize: 13 }}>剪辑工作台</button>}
        </div>
      </div>

      {/* Meta */}
      <div style={{ display: "flex", alignItems: "center", gap: 16, padding: "10px 16px", border: "1px solid var(--front-line)", borderTop: 0, background: "rgba(255,255,255,0.82)", color: "var(--front-muted)", fontSize: 12 }}>
        <span>共 {scripts.length} 场</span>
        <span>共 {allTracks.length} 条分镜</span>
        <span>已完成 {completedCount} 条视频</span>
      </div>

      <div aria-label="真实视频生成配置" style={{ display: "flex", flexWrap: "wrap", alignItems: "end", gap: 10, padding: "12px 16px", border: "1px solid var(--front-line)", borderTop: 0, background: "var(--front-surface)" }}>
        <label style={{ display: "grid", gap: 4, minWidth: 190, fontSize: 12, color: "var(--front-muted)" }}>
          <span>视频模型</span>
          <select
            data-testid="quick-production-model"
            aria-label="视频模型"
            value={modelSetting.model}
            disabled={modelCatalogLoading}
            onChange={(event) => selectModel(event.target.value)}
            style={{ height: 34, border: "1px solid #d4d4d8", borderRadius: 7, background: "var(--front-surface)", color: "var(--front-text)", padding: "0 9px" }}
          >
            <option value="">{modelCatalogLoading ? "读取中…" : "请选择真实模型"}</option>
            {videoModels.map((model) => (
              <option key={model.id} value={model.id} disabled={!model.canSubmit}>
                {model.label}{model.canSubmit ? "" : "（暂不可用）"}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: "grid", gap: 4, minWidth: 150, fontSize: 12, color: "var(--front-muted)" }}>
          <span>生成模式</span>
          <select
            data-testid="quick-production-mode"
            aria-label="生成模式"
            value={modelSetting.mode}
            disabled={!selectedModel?.canSubmit}
            onChange={(event) => setModelSetting((current) => ({ ...current, mode: event.target.value }))}
            style={{ height: 34, border: "1px solid #d4d4d8", borderRadius: 7, background: "var(--front-surface)", color: "var(--front-text)", padding: "0 9px" }}
          >
            <option value="">请选择</option>
            {(selectedModel?.modes || []).map((mode) => (
              <option key={mode} value={mode}>{productionVideoModeLabel(mode)}</option>
            ))}
          </select>
        </label>
        <label style={{ display: "grid", gap: 4, minWidth: 130, fontSize: 12, color: "var(--front-muted)" }}>
          <span>清晰度</span>
          <select
            data-testid="quick-production-resolution"
            aria-label="清晰度"
            value={modelSetting.resolution}
            disabled={!selectedModel?.canSubmit}
            onChange={(event) => setModelSetting((current) => ({ ...current, resolution: event.target.value }))}
            style={{ height: 34, border: "1px solid #d4d4d8", borderRadius: 7, background: "var(--front-surface)", color: "var(--front-text)", padding: "0 9px" }}
          >
            <option value="">请选择</option>
            {(selectedModel?.resolutions || []).map((resolution) => <option key={resolution} value={resolution}>{resolution}</option>)}
          </select>
        </label>
        <label style={{ display: "grid", gap: 4, minWidth: 145, fontSize: 12, color: "var(--front-muted)" }}>
          <span>生成音频</span>
          <select
            data-testid="quick-production-audio"
            aria-label="生成音频"
            value={modelSetting.audio === null ? "" : modelSetting.audio ? "yes" : "no"}
            disabled={!selectedModel?.canSubmit || !selectedModel.supportsGenerateAudio}
            onChange={(event) => setModelSetting((current) => ({ ...current, audio: event.target.value === "" ? null : event.target.value === "yes" }))}
            style={{ height: 34, border: "1px solid #d4d4d8", borderRadius: 7, background: "var(--front-surface)", color: "var(--front-text)", padding: "0 9px" }}
          >
            {selectedModel?.supportsGenerateAudio ? <option value="">请选择</option> : null}
            <option value="no">不生成</option>
            {selectedModel?.supportsGenerateAudio ? <option value="yes">生成</option> : null}
          </select>
        </label>
        <span role={modelConfigurationError || modelCatalogError ? "alert" : undefined} style={{ flex: "1 1 220px", alignSelf: "center", color: modelConfigurationError || modelCatalogError ? "var(--front-danger)" : "#16833a", fontSize: 12 }}>
          {modelCatalogError || modelConfigurationError || "配置来自当前工作区服务端模型目录"}
        </span>
      </div>

      {generationError ? (
        <div role="alert" style={{ padding: "10px 16px", border: "1px solid var(--front-danger-line)", borderTop: 0, background: "var(--front-danger-bg)", color: "var(--front-danger)", fontSize: 12 }}>
          {generationError}
        </div>
      ) : null}

      {loadError ? (
        <div role="alert" style={{ flex: 1, display: "grid", placeItems: "center", padding: 60, color: "var(--front-danger)" }}>
          制作数据读取失败：{loadError}
        </div>
      ) : !scripts.length && !loading ? (
        <div style={{ flex: 1, display: "grid", placeItems: "center", padding: 60, color: "var(--front-muted)" }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>暂无剧本场次</div>
            <div style={{ fontSize: 13, color: "var(--front-muted)" }}>请先在脚本中创建或导入剧本</div>
          </div>
        </div>
      ) : activeView === "list" ? (
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", border: "1px solid var(--front-line)", borderTop: 0, borderRadius: "0 0 12px 12px", background: "var(--front-surface)", overflow: "hidden" }}>
          {/* Toolbar */}
          <div style={{ flex: "0 0 auto", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "10px 16px", borderBottom: "1px solid var(--front-line)" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--front-muted)", fontSize: 13, cursor: "pointer" }}>
              <input type="checkbox" checked={allTracks.length > 0 && selectedIds.length === allTracks.length} onChange={(e) => toggleAll(e.target.checked)} />
              全选
            </label>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => setSelectedIds([])} disabled={!selectedIds.length} style={{ padding: "4px 12px", border: "1px solid var(--front-line)", borderRadius: 6, background: "var(--front-surface)", cursor: "pointer", fontSize: 12, opacity: selectedIds.length ? 1 : 0.4 }}>取消选择</button>
              <button data-testid="quick-production-generate-video" onClick={() => generatable.length && generateTracks(generatable)} disabled={!generatable.length || batchGenerating || Boolean(modelConfigurationError)} style={{ padding: "4px 12px", border: "none", borderRadius: 6, background: "var(--front-accent)", color: "#fff", cursor: "pointer", fontSize: 12, opacity: generatable.length && !batchGenerating && !modelConfigurationError ? 1 : 0.4 }}>
                {batchGenerating ? "生成中…" : "生成视频"}
              </button>
            </div>
          </div>

          {/* Table */}
          <div style={{ flex: 1, overflow: "auto" }}>
            {/* Header */}
            <div style={{ display: "grid", gridTemplateColumns: "58px 120px 1fr 50px 90px 180px 100px", alignItems: "center", gap: 12, padding: "10px 16px", color: "var(--front-muted)", fontSize: 12, fontWeight: 720, background: "var(--front-soft)", borderBottom: "1px solid var(--front-line)" }}>
              <span>镜头</span><span>画面</span><span>视频/提示词</span><span>时长</span><span>状态</span><span>生成结果</span><span style={{ textAlign: "center" }}>操作</span>
            </div>
            {groups.map((group, gi) => (
              <React.Fragment key={group.script.id}>
                <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--front-line)", background: "var(--front-soft)", fontSize: 13, color: "var(--front-muted)", fontWeight: 680 }}>
                  第{formatSceneNumber(gi + 1)}场 {group.script.name}
                  <small style={{ marginLeft: 12, fontSize: 12 }}>共 {group.tracks.length} 条分镜</small>
                </div>
                {group.tracks.map((track, ti) => {
                  const badge = getStatusBadge(track);
                  const cover = track.medias.find((m: any) => m.src && m.fileType === "image")?.src;
                  return (
                    <div data-testid="quick-production-row" key={track.id} style={{ display: "grid", gridTemplateColumns: "58px 120px 1fr 50px 90px 180px 100px", alignItems: "center", gap: 12, padding: "14px 16px", borderBottom: "1px solid var(--front-line)", background: "var(--front-surface)" }}>
                      <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <input type="checkbox" checked={selectedIds.includes(track.id)} onChange={() => toggleSelect(track.id)} />
                        <strong style={{ fontSize: 18, fontWeight: 780 }}>{String(ti + 1).padStart(2, "0")}</strong>
                      </span>
                      <span style={{ width: 120, height: 68, borderRadius: 8, overflow: "hidden", background: "var(--front-soft)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                        {cover ? <img src={cover} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <span style={{ color: "var(--front-muted)", fontSize: 12 }}>无</span>}
                      </span>
                      <span style={{ minWidth: 0 }}>
                        <div title={track.prompt || undefined} style={{ fontSize: 14, fontWeight: 760, whiteSpace: "normal", overflowWrap: "anywhere" }}>{track.prompt || `分镜 ${String(ti + 1).padStart(2, "0")}`}</div>
                        <div style={{ fontSize: 12, color: "var(--front-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 3 }}>{track.prompt || "暂无视频提示词"}</div>
                      </span>
                      <span style={{ fontSize: 13 }}>{track.duration !== null ? `${track.duration}s` : "未配置"}</span>
                      <span><em style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", minWidth: 64, height: 24, padding: "0 10px", borderRadius: 7, fontSize: 12, fontStyle: "normal", fontWeight: 760, color: badge.color, background: badge.bg }}>{badge.text}</em></span>
                      <span style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(76px, 1fr))", gap: 6 }}>
                        {track.videoList.map((v) => {
                          const videoState = productionVideoState(v);
                          const videoDeletable = isDeletableProductionVideo(track, v);
                          return (
                            <div data-testid="quick-production-video-result" key={v.id} style={{ width: "100%", minHeight: 48, borderRadius: 6, overflow: "hidden", background: "var(--front-soft)", border: v.id === track.selectVideoId ? "2px solid var(--front-accent)" : "1px solid var(--front-line)" }}>
                              <button
                                type="button"
                                aria-label={`预览视频 ${v.id}`}
                                disabled={!v.src || videoState !== "已完成"}
                                onClick={() => v.src && videoState === "已完成" && setPlayingSrc(v.src)}
                                style={{ width: "100%", padding: 0, border: 0, background: "transparent", cursor: v.src ? "pointer" : "default" }}
                              >
                                {PRODUCTION_ACTIVE_STATES.has(videoState) ? <div style={{ height: 48, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "var(--front-accent)", textAlign: "center", padding: 4 }}>{generationPreparationMessage(v) || videoState}</div> : videoState === "已完成" && v.src ? <video src={v.src} style={{ width: "100%", height: 48, objectFit: "cover" }} preload="metadata" muted /> : <div style={{ height: 48, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: videoState === "生成失败" ? "#c9352b" : "var(--front-muted)" }}>{videoState}</div>}
                              </button>
                              {videoState === "已完成" && v.src ? (
                                <button
                                  data-testid="quick-production-select-video"
                                  type="button"
                                  disabled={v.id === track.selectVideoId || selectingVideoId !== null}
                                  onClick={() => void selectFinalVideo(track, v)}
                                  style={{ width: "100%", padding: "3px 2px", border: 0, borderTop: "1px solid var(--front-line)", color: v.id === track.selectVideoId ? "#16833a" : "var(--front-accent)", background: "var(--front-surface)", cursor: v.id === track.selectVideoId ? "default" : "pointer", fontSize: 10, fontWeight: 700 }}
                                >
                                  {v.id === track.selectVideoId ? "已选成片" : selectingVideoId === v.id ? "设置中…" : "设为成片"}
                                </button>
                              ) : null}
                              {isCancellableProductionVideo(v) ? (
                                <button
                                  type="button"
                                  disabled={Boolean(cancellingRelayTaskId)}
                                  onClick={() => void cancelProductionVideo(v)}
                                  style={{ width: "100%", padding: "3px 2px", border: 0, borderTop: "1px solid var(--front-line)", color: "#9b3333", background: "#fff7f7", cursor: "pointer", fontSize: 10, fontWeight: 700 }}
                                >
                                  {cancellingRelayTaskId === v.relayTaskId ? "取消中…" : "取消任务"}
                                </button>
                              ) : null}
                              <button
                                type="button"
                                aria-label={`删除视频 ${v.id}`}
                                title={videoDeletable ? "删除视频" : "同一轨道仍有视频生成中，暂不可删除"}
                                disabled={!videoDeletable}
                                onClick={() => openDeleteVideo(track, v)}
                                style={{ width: "100%", padding: "3px 2px", border: 0, borderTop: "1px solid var(--front-line)", color: "#9b3333", background: "#fff7f7", cursor: videoDeletable ? "pointer" : "not-allowed", opacity: videoDeletable ? 1 : 0.45, fontSize: 10, fontWeight: 700 }}
                              >删除视频</button>
                            </div>
                          );
                        })}
                        {!track.videoList.length ? <div style={{ minHeight: 48, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "var(--front-muted)" }}>待生成</div> : null}
                      </span>
                      <span style={{ display: "flex", justifyContent: "center" }}>
                        <button onClick={() => generateTracks([track])} disabled={batchGenerating || Boolean(modelConfigurationError) || productionTrackHasActiveTask(track)} style={{ padding: "4px 12px", border: "none", borderRadius: 6, background: "var(--front-accent)", color: "#fff", cursor: "pointer", fontSize: 12 }}>生成视频</button>
                      </span>
                    </div>
                  );
                })}
              </React.Fragment>
            ))}
          </div>
        </div>
      ) : activeView === "board" ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12, padding: 14, border: "1px solid var(--front-line)", borderRadius: "0 0 12px 12px", background: "var(--front-surface)", overflow: "auto" }}>
          {groups.map((group, gi) => (
            <React.Fragment key={group.script.id}>
              <div style={{ gridColumn: "1 / -1", color: "var(--front-muted)", fontSize: 13, fontWeight: 680 }}>第{formatSceneNumber(gi + 1)}场 {group.script.name}</div>
              {group.tracks.map((track, ti) => {
                const badge = getStatusBadge(track);
                const cover = track.medias.find((m: any) => m.src && m.fileType === "image")?.src;
                return (
                  <div key={track.id} style={{ display: "grid", gap: 8, padding: 10, border: "1px solid var(--front-line)", borderRadius: 10 }}>
                    <div style={{ aspectRatio: "16/9", display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 8, overflow: "hidden", background: "var(--front-soft)", color: "var(--front-muted)" }}>
                      {cover ? <img src={cover} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : badge.text}
                    </div>
                    <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{String(ti + 1).padStart(2, "0")} {track.prompt?.slice(0, 12) || `分镜 ${ti + 1}`}</strong>
                    <small style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--front-muted)" }}>{track.prompt || "暂无视频提示词"}</small>
                    <em style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", minWidth: 64, height: 24, padding: "0 10px", borderRadius: 7, fontSize: 12, fontStyle: "normal", fontWeight: 760, color: badge.color, background: badge.bg }}>{badge.text}</em>
                  </div>
                );
              })}
            </React.Fragment>
          ))}
        </div>
      ) : (
        <div style={{ display: "flex", gap: 10, padding: 18, border: "1px solid var(--front-line)", borderRadius: "0 0 12px 12px", background: "var(--front-surface)", overflowX: "auto" }}>
          {groups.map((group, gi) => (
            <React.Fragment key={group.script.id}>
              <div style={{ minWidth: 120, display: "flex", alignItems: "center", color: "var(--front-muted)", fontSize: 13, fontWeight: 680 }}>第{formatSceneNumber(gi + 1)}场 {group.script.name}</div>
              {group.tracks.map((track, ti) => (
                <div key={track.id} style={{ minWidth: 150, display: "grid", gap: 6, padding: 12, border: "1px solid var(--front-line)", borderRadius: 10, background: "var(--front-soft)" }}>
                  <span style={{ color: "var(--front-accent)", fontWeight: 780 }}>{String(ti + 1).padStart(2, "0")}</span>
                  <strong>{track.duration !== null ? `${track.duration}s` : "未配置时长"}</strong>
                  <small style={{ overflow: "hidden", color: "var(--front-muted)", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{getStatusBadge(track).text}</small>
                </div>
              ))}
            </React.Fragment>
          ))}
        </div>
      )}

      <ConfirmDialog
        key={deleteIntent?.intentToken || "production-video-delete-dialog"}
        open={Boolean(deleteIntent)}
        title="删除视频？"
        description={(
          <>
            <span>将视频 {deleteIntent?.videoId || ""} 从当前项目移除，创作库媒体与计费审计保留。若已选为成片或进入剪辑时间线，对应项目引用会一并解除。</span>
            {deleteError && deleteError.intentToken === deleteIntent?.intentToken ? <span role="alert" style={{ display: "block", marginTop: 8, color: "var(--front-danger)" }}>删除失败：{deleteError.message}</span> : null}
          </>
        )}
        confirmLabel="确认删除"
        tone="danger"
        onConfirm={() => confirmDeleteVideo(deleteIntent)}
        onConfirmError={(error) => reportDeleteError(deleteIntent, error)}
        onCancel={() => deleteIntent && closeDeleteIntent(deleteIntent.intentToken)}
      />
    </div>
  );
}
