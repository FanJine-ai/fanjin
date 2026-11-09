import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiPost } from "../../api/http";
import { listProjectAssetCatalog } from "../../api/assets";
import type { ProjectAssetCatalogItem } from "../../features/assets/assetCatalog";
import {
  clearStoredSubmissionAttempt,
  prepareStoredSubmissionAttempt,
  shouldRetainStoredSubmissionAttempt,
} from "../../features/quick-create/itemAttemptStorage";
import type { StableSubmissionAttempt } from "../../features/quick-create/submissionAttempt";
import {
  buildExplainableAutoEdit,
  createEditRevisionBundle,
  reconcileAutoEditSourceSelections,
  updateManualEditRevision,
  type AutoEditPreferences,
  type AutoEditBeatMarker,
  type AutoEditSubtitleCue,
  type AutoEditSourcePurpose,
  type AutoEditSourceSelection,
  type AutoEditTimelineItem,
  type EditRevisionBundle,
} from "../../features/quick-create/quickModeWorkflow";
import { useProjectStore } from "../../stores/projectStore";
import { getClipReadinessSummary } from "./clipReadiness";

type ScriptItem = { id: number; name: string };
type ClipVideo = {
  key: string;
  title: string;
  sceneName: string;
  sceneIndex: number;
  trackId: number;
  trackIndex: number;
  videoId: number;
  src: string;
  duration: number;
  trimStart: number;
  trimEnd: number;
  speed?: number;
  volume: number;
  selectionSource: "selected" | "fallback";
};
type Readiness = { trackCount: number; selectedFinalCount: number; fallbackCount: number; missingCount: number; totalDuration: number };
type FinalVideo = {
  id: string;
  taskId: string;
  url: string;
  width: number;
  height: number;
  durationMs: number;
  createdAt: number;
  assetId?: number | null;
  assetVersionId?: number | null;
};
type ClipWorkbenchDraft = {
  version: "editor-timeline.v2";
  timeline: Array<{
    videoId: number;
    trimStartSeconds: number;
    trimEndSeconds: number;
    speed: number;
    volume: number;
  }>;
  soundtrack: {
    assetVersionId: number | null;
    volume: number;
  };
  savedAt: number;
  revisions?: EditRevisionBundle;
  autoEditPlan?: ClipAutoEditPlan;
  autoEditPreferences?: AutoEditPreferences;
  /** Read-only migration hint; new cloud drafts never persist this field. */
  legacyAppendMissingClips?: boolean;
};
type ClipAutoEditPlan = {
  preferences: AutoEditPreferences;
  explanations: string[];
  subtitleCues: AutoEditSubtitleCue[];
  beatMarkers: AutoEditBeatMarker[];
};
type DraftResponse = {
  data: unknown;
  updatedAt?: number | null;
  corrupted?: boolean;
  currentVersionId?: string | null;
};
type DraftSaveResponse = {
  updatedAt?: number | null;
  accepted?: boolean;
  reason?: string;
  version?: { id: string; digest: string; createdAt: number } | null;
};
type DraftSnapshot = {
  projectId: number;
  draft: ClipWorkbenchDraft;
  signature: string;
};
type DraftSaveMode = "auto" | "manual" | "detached";
type ClipDraftVersion = {
  id: string;
  digest: string;
  createdAt: number;
  restoredFromVersionId: string | null;
  draft: ClipWorkbenchDraft;
};
type ClipDraftVersionsResponse = {
  currentVersionId: string | null;
  updatedAt: number | null;
  versions: ClipDraftVersion[];
};
type EditorStateSnapshot = {
  clips: ClipVideo[];
  audioAssetVersionId: number | null;
  soundtrackVolume: number;
};

const CLIP_WORKBENCH_DRAFT_EPISODE_ID = -8;
const EMPTY_READINESS: Readiness = {
  trackCount: 0,
  selectedFinalCount: 0,
  fallbackCount: 0,
  missingCount: 0,
  totalDuration: 0,
};

export function isCompletedVideo(video: any) {
  const state = video?.state === "生成成功" ? "已完成" : video?.state;
  return state === "已完成" && Boolean(video?.src);
}

export function normalizeClipScripts(value: unknown): ScriptItem[] {
  if (!Array.isArray(value)) throw new Error("剧本列表响应格式无效，已阻止展示空数据");
  return value.map((entry) => {
    const source = entry && typeof entry === "object" && !Array.isArray(entry)
      ? entry as Record<string, unknown>
      : null;
    const id = Number(source?.id);
    const name = typeof source?.name === "string" ? source.name.trim() : "";
    if (!source || !Number.isSafeInteger(id) || id <= 0 || !name) {
      throw new Error("剧本列表包含无效记录，已阻止展示不完整数据");
    }
    return { id, name };
  });
}

export function normalizeClipTrackList(value: unknown, scriptName: string): any[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`剧本「${scriptName}」的制作数据响应格式无效`);
  }
  const trackList = (value as Record<string, unknown>).trackList;
  if (!Array.isArray(trackList)) {
    throw new Error(`剧本「${scriptName}」的制作数据缺少 trackList`);
  }
  return trackList;
}

export function buildFinalRenderIdempotencyKey(
  projectId: number,
  clips: Array<Pick<ClipVideo, "videoId"> & Partial<Pick<ClipVideo, "trimStart" | "trimEnd" | "speed" | "volume">>>,
  audioAssetVersionId: number | null = null,
  soundtrackVolume = 1,
  attemptId = "",
  subtitleCues: Array<Pick<AutoEditSubtitleCue, "startSeconds" | "endSeconds" | "text">> = [],
) {
  if (!Number.isSafeInteger(projectId) || projectId <= 0 || !clips.length) {
    throw new Error("成片合成缺少有效项目或镜头");
  }
  const videoIds = clips.map((clip) => Number(clip.videoId));
  if (videoIds.some((videoId) => !Number.isSafeInteger(videoId) || videoId <= 0)) {
    throw new Error("成片合成包含无效镜头");
  }
  const canonical = JSON.stringify({
    projectId,
    timeline: clips.map((clip) => ({
      videoId: clip.videoId,
      trimStart: Number(clip.trimStart ?? 0).toFixed(3),
      trimEnd: Number(clip.trimEnd ?? 0).toFixed(3),
      speed: Number(clip.speed ?? 1).toFixed(3),
      volume: Number(clip.volume ?? 1).toFixed(3),
    })),
    audioAssetVersionId,
    soundtrackVolume: Number(soundtrackVolume).toFixed(3),
    subtitleCues: normalizeFinalRenderSubtitleCues(subtitleCues, clips.reduce(
      (sum, clip) => sum + Math.max(0, Number(clip.trimEnd ?? 0) - Number(clip.trimStart ?? 0)) / clamp(Number(clip.speed ?? 1), 0.25, 4),
      0,
    )).map((cue) => ({
      startSeconds: cue.startSeconds.toFixed(3),
      endSeconds: cue.endSeconds.toFixed(3),
      text: cue.text,
    })),
    attemptId: String(attemptId).trim(),
  });
  let hashA = 0x811c9dc5;
  let hashB = 0x9e3779b9;
  for (let index = 0; index < canonical.length; index += 1) {
    const code = canonical.charCodeAt(index);
    hashA = Math.imul(hashA ^ code, 0x01000193);
    hashB = Math.imul(hashB ^ code, 0x85ebca6b);
  }
  return `clip-final-v3-${projectId}-${(hashA >>> 0).toString(16).padStart(8, "0")}${(hashB >>> 0).toString(16).padStart(8, "0")}`;
}

function normalizeFinalRenderSubtitleCues(
  cues: Array<Pick<AutoEditSubtitleCue, "startSeconds" | "endSeconds" | "text">>,
  durationSeconds: number,
) {
  const safeDuration = Number.isFinite(durationSeconds) ? Math.max(0, durationSeconds) : 0;
  return cues.slice(0, 300).flatMap((cue) => {
    const startSeconds = Number(cue.startSeconds);
    const endSeconds = Math.min(Number(cue.endSeconds), safeDuration);
    const text = String(cue.text || "").trim().slice(0, 500);
    if (
      !text
      || !Number.isFinite(startSeconds)
      || !Number.isFinite(endSeconds)
      || startSeconds < 0
      || endSeconds <= startSeconds
      || startSeconds >= safeDuration
    ) return [];
    return [{ startSeconds, endSeconds, text }];
  });
}

export function boundSubtitleCuesToTimeline<T extends Pick<AutoEditSubtitleCue, "startSeconds" | "endSeconds">>(
  cues: T[],
  durationSeconds: number,
): T[] {
  const safeDuration = Number.isFinite(durationSeconds) ? Math.max(0, durationSeconds) : 0;
  return cues.flatMap((cue) => {
    const startSeconds = Number(cue.startSeconds);
    const endSeconds = Math.min(Number(cue.endSeconds), safeDuration);
    if (
      !Number.isFinite(startSeconds)
      || !Number.isFinite(endSeconds)
      || startSeconds < 0
      || startSeconds >= safeDuration
      || endSeconds <= startSeconds
    ) return [];
    return [{ ...cue, startSeconds, endSeconds }];
  });
}

export function buildFinalRenderPayload(
  projectId: number,
  clips: Array<Pick<ClipVideo, "videoId"> & Partial<Pick<ClipVideo, "trimStart" | "trimEnd" | "speed" | "volume">>>,
  audioAssetVersionId: number | null,
  soundtrackVolume: number,
  subtitleCues: Array<Pick<AutoEditSubtitleCue, "startSeconds" | "endSeconds" | "text">> = [],
) {
  const timeline = clips.map((clip) => ({
    videoId: clip.videoId,
    trimStartSeconds: Number(clip.trimStart ?? 0),
    trimEndSeconds: Number(clip.trimEnd ?? 0),
    speed: clamp(Number(clip.speed ?? 1), 0.25, 4),
    volume: Number(clip.volume ?? 1),
  }));
  const durationSeconds = timeline.reduce(
    (sum, clip) => sum + Math.max(0, clip.trimEndSeconds - clip.trimStartSeconds) / clip.speed,
    0,
  );
  return {
    projectId,
    timeline,
    audioAssetVersionId,
    soundtrackVolume,
    subtitleCues: normalizeFinalRenderSubtitleCues(subtitleCues, durationSeconds),
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function normalizeDraftTimeline(value: unknown): AutoEditTimelineItem[] | null {
  if (!Array.isArray(value)) return null;
  const timeline = value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const item = entry as Record<string, unknown>;
    const videoId = Number(item.videoId);
    const trimStart = Number(item.trimStart);
    const trimEnd = Number(item.trimEnd);
    const volume = Number(item.volume);
    if (
      !Number.isSafeInteger(videoId)
      || videoId <= 0
      || !Number.isFinite(trimStart)
      || !Number.isFinite(trimEnd)
      || trimStart < 0
      || trimEnd <= trimStart
      || !Number.isFinite(volume)
    ) return [];
    return [{ videoId, trimStart, trimEnd, volume: clamp(volume, 0, 2) }];
  });
  return timeline.length === value.length ? timeline : null;
}

function normalizeRevisionBundle(value: unknown): EditRevisionBundle | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const normalizeRevision = (revision: unknown) => {
    if (!revision || typeof revision !== "object" || Array.isArray(revision)) return null;
    const record = revision as Record<string, unknown>;
    const timeline = normalizeDraftTimeline(record.timeline);
    const savedAt = Number(record.savedAt);
    return timeline && Number.isFinite(savedAt) && savedAt >= 0 ? { timeline, savedAt } : null;
  };
  const sourceRevision = normalizeRevision(source.source);
  const automatic = normalizeRevision(source.automatic);
  const manual = normalizeRevision(source.manual);
  return sourceRevision && automatic && manual
    ? { source: sourceRevision, automatic, manual }
    : null;
}

function normalizeAutoEditPlan(value: unknown): ClipAutoEditPlan | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const preferences = source.preferences && typeof source.preferences === "object" && !Array.isArray(source.preferences)
    ? source.preferences as Record<string, unknown>
    : null;
  if (!preferences) return null;
  const targetDuration = Number(preferences.targetDuration);
  const pace = preferences.pace;
  const originalAudio = preferences.originalAudio;
  if (
    !Number.isFinite(targetDuration)
    || targetDuration < 1
    || (pace !== "slow" && pace !== "balanced" && pace !== "fast")
    || (originalAudio !== "keep" && originalAudio !== "duck" && originalAudio !== "mute")
    || typeof preferences.subtitles !== "boolean"
  ) return null;
  const soundtrackAssetVersionId = Number(preferences.soundtrackAssetVersionId);
  const normalizedPreferences: AutoEditPreferences = {
    targetDuration,
    pace,
    originalAudio,
    subtitles: preferences.subtitles,
    soundtrackAssetVersionId: Number.isSafeInteger(soundtrackAssetVersionId) && soundtrackAssetVersionId > 0
      ? soundtrackAssetVersionId
      : null,
    ...(Array.isArray(preferences.sourceSelections) ? {
      sourceSelections: preferences.sourceSelections.flatMap((entry) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
          const selection = entry as Record<string, unknown>;
          const videoId = Number(selection.videoId);
          const order = Number(selection.order);
          if (
            !Number.isSafeInteger(videoId) || videoId <= 0
            || typeof selection.included !== "boolean"
            || !Number.isSafeInteger(order) || order < 0
            || (selection.purpose !== "hook" && selection.purpose !== "story" && selection.purpose !== "proof" && selection.purpose !== "cta")
          ) return [];
          return [{
            videoId,
            included: selection.included,
            purpose: selection.purpose as AutoEditSourcePurpose,
            order,
          }];
        }),
    } : {}),
  };
  if (!Array.isArray(source.explanations) || !source.explanations.every((item) => typeof item === "string")) return null;
  if (!Array.isArray(source.subtitleCues) || !Array.isArray(source.beatMarkers)) return null;
  const subtitleCues = source.subtitleCues.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const cue = entry as Record<string, unknown>;
    const videoId = Number(cue.videoId);
    const startSeconds = Number(cue.startSeconds);
    const endSeconds = Number(cue.endSeconds);
    if (
      typeof cue.id !== "string" || !cue.id.trim()
      || !Number.isSafeInteger(videoId) || videoId <= 0
      || !Number.isFinite(startSeconds) || startSeconds < 0
      || !Number.isFinite(endSeconds) || endSeconds <= startSeconds
      || typeof cue.text !== "string"
    ) return [];
    return [{ id: cue.id, videoId, startSeconds, endSeconds, text: cue.text.slice(0, 500) }];
  });
  const beatMarkers = source.beatMarkers.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const marker = entry as Record<string, unknown>;
    const timeSeconds = Number(marker.timeSeconds);
    if (
      typeof marker.id !== "string" || !marker.id.trim()
      || !Number.isFinite(timeSeconds) || timeSeconds < 0
      || (marker.kind !== "cut" && marker.kind !== "beat")
    ) return [];
    return [{ id: marker.id, timeSeconds, kind: marker.kind as AutoEditBeatMarker["kind"] }];
  });
  if (subtitleCues.length !== source.subtitleCues.length || beatMarkers.length !== source.beatMarkers.length) return null;
  return {
    preferences: normalizedPreferences,
    explanations: source.explanations.slice(0, 20) as string[],
    subtitleCues,
    beatMarkers,
  };
}

function normalizeAutoEditPreferences(value: unknown): AutoEditPreferences | null {
  const normalized = normalizeAutoEditPlan({
    preferences: value,
    explanations: [],
    subtitleCues: [],
    beatMarkers: [],
  });
  return normalized?.preferences ?? null;
}

export function normalizeClipDraft(value: unknown): ClipWorkbenchDraft | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const canonical = source.version === "editor-timeline.v2";
  const legacyVersion = Number(source.version);
  if (!canonical && legacyVersion !== 1 && legacyVersion !== 2 && legacyVersion !== 3) return null;
  if (!Array.isArray(source.timeline)) return null;
  const timeline = source.timeline.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const item = entry as Record<string, unknown>;
    const videoId = Number(item.videoId);
    const trimStartSeconds = Number(canonical ? item.trimStartSeconds : item.trimStart);
    const trimEndSeconds = Number(canonical ? item.trimEndSeconds : item.trimEnd);
    const speed = Number(canonical ? item.speed : 1);
    const volume = Number(item.volume);
    if (
      !Number.isSafeInteger(videoId)
      || videoId <= 0
      || !Number.isFinite(trimStartSeconds)
      || !Number.isFinite(trimEndSeconds)
      || trimStartSeconds < 0
      || trimEndSeconds <= trimStartSeconds
      || !Number.isFinite(speed)
      || speed < 0.25
      || speed > 4
      || !Number.isFinite(volume)
    ) return [];
    return [{
      videoId,
      trimStartSeconds,
      trimEndSeconds,
      speed,
      volume: clamp(volume, 0, 2),
    }];
  });
  if (timeline.length !== source.timeline.length) return null;
  const revisions = source.revisions === undefined ? null : normalizeRevisionBundle(source.revisions);
  if ((!canonical && legacyVersion === 3 && !revisions) || (source.revisions !== undefined && !revisions)) return null;
  const autoEditPlan = source.autoEditPlan === undefined ? null : normalizeAutoEditPlan(source.autoEditPlan);
  if (source.autoEditPlan !== undefined && !autoEditPlan) return null;
  const autoEditPreferences = source.autoEditPreferences === undefined
    ? null
    : normalizeAutoEditPreferences(source.autoEditPreferences);
  if (source.autoEditPreferences !== undefined && !autoEditPreferences) return null;
  const soundtrack = canonical && source.soundtrack && typeof source.soundtrack === "object" && !Array.isArray(source.soundtrack)
    ? source.soundtrack as Record<string, unknown>
    : null;
  const audioAssetVersionId = Number(canonical ? soundtrack?.assetVersionId : source.audioAssetVersionId);
  const soundtrackVolume = Number(canonical ? soundtrack?.volume : source.soundtrackVolume);
  return {
    version: "editor-timeline.v2",
    timeline,
    soundtrack: {
      assetVersionId: Number.isSafeInteger(audioAssetVersionId) && audioAssetVersionId > 0
        ? audioAssetVersionId
        : null,
      volume: Number.isFinite(soundtrackVolume)
        ? clamp(soundtrackVolume, 0, 2)
        : 1,
    },
    savedAt: Math.max(0, Number(source.savedAt) || 0),
    ...(revisions ? { revisions } : {}),
    ...(autoEditPlan ? { autoEditPlan } : {}),
    ...(autoEditPreferences ? { autoEditPreferences } : {}),
    ...(!canonical && legacyVersion === 1 ? { legacyAppendMissingClips: true } : {}),
  };
}

export function applyClipWorkbenchDraft(
  clips: ClipVideo[],
  draftValue: unknown,
): ClipVideo[] {
  const draft = normalizeClipDraft(draftValue);
  if (!draft) return clips;
  const byVideoId = new Map(clips.map((clip) => [clip.videoId, clip]));
  const ordered: ClipVideo[] = [];
  const used = new Set<number>();
  for (const edit of draft.timeline) {
    const clip = byVideoId.get(edit.videoId);
    if (!clip || used.has(edit.videoId)) continue;
    used.add(edit.videoId);
    const trimStart = clamp(edit.trimStartSeconds, 0, Math.max(0, clip.duration - 0.1));
    const trimEnd = clamp(edit.trimEndSeconds, trimStart + 0.1, clip.duration);
    ordered.push({
      ...clip,
      trimStart,
      trimEnd,
      speed: clamp(edit.speed, 0.25, 4),
      volume: clamp(edit.volume, 0, 2),
    });
  }
  if (draft.legacyAppendMissingClips) {
    for (const clip of clips) {
      if (!used.has(clip.videoId)) ordered.push(clip);
    }
  }
  return ordered;
}

export function buildClipWorkbenchDraft(
  clips: ClipVideo[],
  audioAssetVersionId: number | null,
  soundtrackVolume: number,
  savedAt = Date.now(),
  revisions?: EditRevisionBundle | null,
  updateManualRevision = true,
  autoEditPlan?: ClipAutoEditPlan | null,
  autoEditPreferences?: AutoEditPreferences | null,
): ClipWorkbenchDraft {
  const timeline = clips.map((clip) => ({
    videoId: clip.videoId,
    trimStartSeconds: Number(clip.trimStart.toFixed(3)),
    trimEndSeconds: Number(clip.trimEnd.toFixed(3)),
    speed: Number(clamp(clip.speed ?? 1, 0.25, 4).toFixed(3)),
    volume: Number(clamp(clip.volume, 0, 2).toFixed(3)),
  }));
  const revisionTimeline: AutoEditTimelineItem[] = clips.map((clip) => ({
    videoId: clip.videoId,
    trimStart: Number(clip.trimStart.toFixed(3)),
    trimEnd: Number(clip.trimEnd.toFixed(3)),
    volume: Number(clamp(clip.volume, 0, 2).toFixed(3)),
  }));
  const nextRevisions = revisions && updateManualRevision
    ? updateManualEditRevision(revisions, revisionTimeline, savedAt)
    : revisions ?? null;
  return {
    version: "editor-timeline.v2",
    timeline,
    soundtrack: {
      assetVersionId:
        Number.isSafeInteger(audioAssetVersionId) && Number(audioAssetVersionId) > 0
          ? Number(audioAssetVersionId)
          : null,
      volume: Number(clamp(soundtrackVolume, 0, 2).toFixed(3)),
    },
    savedAt,
    ...(nextRevisions ? { revisions: nextRevisions } : {}),
    ...(autoEditPlan ? { autoEditPlan } : {}),
    ...(autoEditPreferences ? { autoEditPreferences } : {}),
  };
}

export function shouldRestoreFinalVideo(input: {
  finalCreatedAt: unknown;
  draftSavedAt: unknown;
  draftTransportUpdatedAt: unknown;
}) {
  const finalCreatedAt = Math.max(0, Number(input.finalCreatedAt) || 0);
  if (!finalCreatedAt) return false;

  // `updateTime` is the transport write time. A keepalive/pagehide replay can
  // legitimately refresh it after a render without changing the draft
  // content. Prefer the semantic timestamp embedded when the timeline itself
  // changed; retain updateTime only as a compatibility fallback for legacy
  // drafts that did not carry savedAt.
  const semanticDraftUpdatedAt = Math.max(
    0,
    Number(input.draftSavedAt) || 0,
  );
  const legacyDraftUpdatedAt = Math.max(
    0,
    Number(input.draftTransportUpdatedAt) || 0,
  );
  const draftContentUpdatedAt =
    semanticDraftUpdatedAt || legacyDraftUpdatedAt;
  return draftContentUpdatedAt <= finalCreatedAt;
}

function clipDraftSignature(draft: ClipWorkbenchDraft) {
  return JSON.stringify({
    version: draft.version,
    timeline: draft.timeline,
    soundtrack: draft.soundtrack,
    revisions: draft.revisions,
    autoEditPlan: draft.autoEditPlan,
    autoEditPreferences: draft.autoEditPreferences,
  });
}

export function compareClipWorkbenchDrafts(
  currentValue: unknown,
  targetValue: unknown,
) {
  const current = normalizeClipDraft(currentValue);
  const target = normalizeClipDraft(targetValue);
  if (!current || !target) return null;
  const currentById = new Map(current.timeline.map((clip) => [clip.videoId, clip]));
  const targetById = new Map(target.timeline.map((clip) => [clip.videoId, clip]));
  const changedClipIds = new Set<number>();
  for (const [videoId, clip] of currentById) {
    const other = targetById.get(videoId);
    if (!other || JSON.stringify(clip) !== JSON.stringify(other)) changedClipIds.add(videoId);
  }
  for (const videoId of targetById.keys()) {
    if (!currentById.has(videoId)) changedClipIds.add(videoId);
  }
  return {
    changedClipCount: changedClipIds.size,
    orderChanged: current.timeline.map((clip) => clip.videoId).join(",")
      !== target.timeline.map((clip) => clip.videoId).join(","),
    soundtrackChanged: JSON.stringify(current.soundtrack) !== JSON.stringify(target.soundtrack),
    currentDurationSeconds: current.timeline.reduce(
      (sum, clip) => sum + (clip.trimEndSeconds - clip.trimStartSeconds) / clip.speed,
      0,
    ),
    targetDurationSeconds: target.timeline.reduce(
      (sum, clip) => sum + (clip.trimEndSeconds - clip.trimStartSeconds) / clip.speed,
      0,
    ),
  };
}

function formatDuration(value: number) {
  const seconds = Math.max(0, Math.round(value));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

export default function ClipWorkbench() {
  const currentProject = useProjectStore((s) => s.currentProject);
  const [clips, setClips] = useState<ClipVideo[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [playingIndex, setPlayingIndex] = useState<number | null>(null);
  const playerRef = useRef<HTMLVideoElement | null>(null);
  const [readiness, setReadiness] = useState<Readiness>(EMPTY_READINESS);
  const [audioAssets, setAudioAssets] = useState<ProjectAssetCatalogItem[]>([]);
  const [audioAssetVersionId, setAudioAssetVersionId] = useState<number | null>(null);
  const [soundtrackVolume, setSoundtrackVolume] = useState(1);
  const [draftHydratedProjectId, setDraftHydratedProjectId] = useState<number | null>(null);
  const [draftStatus, setDraftStatus] = useState("");
  const [draftDirty, setDraftDirty] = useState(false);
  const [draftSaving, setDraftSaving] = useState(false);
  const [draftVersions, setDraftVersions] = useState<ClipDraftVersion[]>([]);
  const [currentDraftVersionId, setCurrentDraftVersionId] = useState<string | null>(null);
  const [versionAction, setVersionAction] = useState<"loading" | "restoring" | "">("");
  const [selectedCompareVersionId, setSelectedCompareVersionId] = useState("");
  const [historyRevision, setHistoryRevision] = useState(0);
  const [finalVideo, setFinalVideo] = useState<FinalVideo | null>(null);
  const [renderingFinal, setRenderingFinal] = useState(false);
  const [renderError, setRenderError] = useState("");
  const [lastRemovedClip, setLastRemovedClip] = useState<{ clip: ClipVideo; index: number } | null>(null);
  const [autoEditPreferences, setAutoEditPreferences] = useState<AutoEditPreferences>({
    targetDuration: 30,
    pace: "balanced",
    originalAudio: "duck",
    subtitles: true,
    soundtrackAssetVersionId: null,
    sourceSelections: [],
  });
  const [autoEditExplanations, setAutoEditExplanations] = useState<string[]>([]);
  const [revisionBundle, setRevisionBundle] = useState<EditRevisionBundle | null>(null);
  const [autoEditPlan, setAutoEditPlan] = useState<ClipAutoEditPlan | null>(null);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const loadEpochRef = useRef(0);
  const loadControllerRef = useRef<AbortController | null>(null);
  const renderControllerRef = useRef<AbortController | null>(null);
  const activeProjectIdRef = useRef<number | null>(null);
  const draftSignatureRef = useRef("");
  const latestDraftSnapshotRef = useRef<DraftSnapshot | null>(null);
  const draftDirtyRef = useRef(false);
  const draftSavePromisesRef = useRef(new Map<string, Promise<void>>());
  const draftSaveAttemptRef = useRef<StableSubmissionAttempt | null>(null);
  const mountedRef = useRef(true);
  const renderAttemptRef = useRef<StableSubmissionAttempt | null>(null);
  const undoStackRef = useRef<EditorStateSnapshot[]>([]);
  const redoStackRef = useRef<EditorStateSnapshot[]>([]);
  const draggedClipIndexRef = useRef<number | null>(null);
  const allowEmptyTimelineRef = useRef(false);
  const sourceClipsRef = useRef<ClipVideo[]>([]);
  const suppressManualRevisionRef = useRef(false);

  const loadDraftVersions = useCallback(async (
    projectId: number,
    signal?: AbortSignal,
  ) => {
    setVersionAction("loading");
    try {
      const response = await apiPost<ClipDraftVersionsResponse>(
        "/production/workbench/listEditorDraftVersions",
        { projectId, episodesId: CLIP_WORKBENCH_DRAFT_EPISODE_ID },
        undefined,
        { signal },
      );
      if (signal?.aborted || activeProjectIdRef.current !== projectId) return;
      setDraftVersions(response.versions);
      setCurrentDraftVersionId(response.currentVersionId);
      setSelectedCompareVersionId((current) => (
        response.versions.some((version) => version.id === current)
          ? current
          : response.versions.find((version) => version.id !== response.currentVersionId)?.id || ""
      ));
    } catch (error) {
      if (signal?.aborted || activeProjectIdRef.current !== projectId) return;
      setDraftStatus(`版本历史读取失败：${error instanceof Error ? error.message : "请求失败"}`);
    } finally {
      if (!signal?.aborted && activeProjectIdRef.current === projectId) setVersionAction("");
    }
  }, []);

  const persistClipDraft = useCallback((
    snapshot: DraftSnapshot,
    mode: DraftSaveMode,
  ): Promise<void> => {
    const saveKey = `${snapshot.projectId}:${snapshot.signature}`;
    const running = draftSavePromisesRef.current.get(saveKey);
    if (running) return running;

    const payload = {
      projectId: snapshot.projectId,
      episodesId: CLIP_WORKBENCH_DRAFT_EPISODE_ID,
      data: snapshot.draft,
    };
    const preparedAttempt = prepareStoredSubmissionAttempt({
      current: draftSaveAttemptRef.current,
      flow: "clip-editor-draft",
      operationKey: `${snapshot.projectId}:${CLIP_WORKBENCH_DRAFT_EPISODE_ID}`,
      prefix: `clip-editor-draft:${snapshot.projectId}`,
      payload,
    });
    draftSaveAttemptRef.current = preparedAttempt.attempt;
    if (mode !== "detached" && mountedRef.current) {
      setDraftSaving(true);
      setDraftStatus(mode === "manual" ? "正在保存云端草稿…" : "正在自动保存云端草稿…");
    }

    let request: Promise<void>;
    request = apiPost<DraftSaveResponse>(
      "/production/workbench/saveEditorDraft",
      payload,
      undefined,
      {
        headers: {
          "Idempotency-Key": preparedAttempt.attempt.idempotencyKey,
        },
        // Drafts are intentionally small numeric timelines. Keeping the
        // request alive lets an already-started autosave survive SPA
        // navigation/pagehide without resorting to an unauthenticated beacon.
        keepalive: true,
      },
    ).then((response) => {
      clearStoredSubmissionAttempt(preparedAttempt.storageKey);
      if (draftSaveAttemptRef.current === preparedAttempt.attempt) {
        draftSaveAttemptRef.current = null;
      }
      const current = latestDraftSnapshotRef.current;
      if (
        current?.projectId !== snapshot.projectId
        || current.signature !== snapshot.signature
      ) return;
      draftSignatureRef.current = snapshot.signature;
      draftDirtyRef.current = false;
      if (!mountedRef.current) return;
      setDraftDirty(false);
      const savedAt = Number(response.updatedAt) || Date.now();
      setDraftStatus(
        response.accepted === false && response.reason === "stale_snapshot"
          ? "云端已有更新的剪辑草稿"
          : `云端草稿已保存 ${new Date(savedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
      );
      void loadDraftVersions(snapshot.projectId);
    }).catch((error) => {
      if (!shouldRetainStoredSubmissionAttempt(error)) {
        clearStoredSubmissionAttempt(preparedAttempt.storageKey);
        if (draftSaveAttemptRef.current === preparedAttempt.attempt) {
          draftSaveAttemptRef.current = null;
        }
      }
      const current = latestDraftSnapshotRef.current;
      if (
        mode === "detached"
        || !mountedRef.current
        || current?.projectId !== snapshot.projectId
        || current.signature !== snapshot.signature
      ) return;
      draftDirtyRef.current = true;
      setDraftDirty(true);
      setDraftStatus(`草稿保存失败：${error instanceof Error ? error.message : "请求失败"}`);
    }).finally(() => {
      if (draftSavePromisesRef.current.get(saveKey) === request) {
        draftSavePromisesRef.current.delete(saveKey);
      }
      if (
        mode !== "detached"
        && mountedRef.current
        && latestDraftSnapshotRef.current?.signature === snapshot.signature
      ) {
        setDraftSaving(false);
      }
    });
    draftSavePromisesRef.current.set(saveKey, request);
    return request;
  }, [loadDraftVersions]);

  const timelineDuration = useMemo(
    () => clips.reduce(
      (total, clip) => total + Math.max(0, clip.trimEnd - clip.trimStart) / clamp(clip.speed ?? 1, 0.25, 4),
      0,
    ),
    [clips],
  );
  const visibleSubtitleCues = useMemo(
    () => boundSubtitleCuesToTimeline(autoEditPlan?.subtitleCues ?? [], timelineDuration),
    [autoEditPlan?.subtitleCues, timelineDuration],
  );

  const clipSummaryLine = useMemo(() => {
    return getClipReadinessSummary({
      loading,
      clipCount: clips.length,
      projectId: currentProject?.id,
      trackCount: readiness.trackCount,
      missingCount: readiness.missingCount,
    });
  }, [loading, clips.length, currentProject?.id, readiness]);

  const selectedCompareVersion = useMemo(
    () => draftVersions.find((version) => version.id === selectedCompareVersionId) || null,
    [draftVersions, selectedCompareVersionId],
  );
  const selectedVersionComparison = useMemo(() => compareClipWorkbenchDrafts(
    latestDraftSnapshotRef.current?.draft,
    selectedCompareVersion?.draft,
  ), [clips, audioAssetVersionId, soundtrackVolume, selectedCompareVersion]);

  const loadClips = useCallback(async () => {
    const projectId = Number(currentProject?.id);
    const previousDraft = latestDraftSnapshotRef.current;
    if (previousDraft && draftDirtyRef.current) {
      await persistClipDraft(
        previousDraft,
        previousDraft.projectId === projectId ? "manual" : "detached",
      );
      // A manual refresh must never replace an unsaved local timeline with an
      // older server snapshot when the save failed.
      if (
        previousDraft.projectId === projectId
        && draftDirtyRef.current
      ) return;
    }
    loadControllerRef.current?.abort();
    renderControllerRef.current?.abort();
    setRenderingFinal(false);
    renderAttemptRef.current = null;
    const epoch = ++loadEpochRef.current;
    if (!Number.isSafeInteger(projectId) || projectId <= 0) {
      activeProjectIdRef.current = null;
      setClips([]);
      setReadiness(EMPTY_READINESS);
      setAudioAssets([]);
      setAudioAssetVersionId(null);
      setSoundtrackVolume(1);
      setDraftHydratedProjectId(null);
      setDraftStatus("");
      setDraftDirty(false);
      setDraftSaving(false);
      setDraftVersions([]);
      setCurrentDraftVersionId(null);
      setSelectedCompareVersionId("");
      setFinalVideo(null);
      setLastRemovedClip(null);
      setAutoEditExplanations([]);
      setRevisionBundle(null);
      setAutoEditPlan(null);
      sourceClipsRef.current = [];
      allowEmptyTimelineRef.current = false;
      latestDraftSnapshotRef.current = null;
      draftDirtyRef.current = false;
      draftSignatureRef.current = "";
      return;
    }
    activeProjectIdRef.current = projectId;
    const controller = new AbortController();
    loadControllerRef.current = controller;
    const isCurrent = () => (
      !controller.signal.aborted
      && loadEpochRef.current === epoch
      && activeProjectIdRef.current === projectId
    );
    setLoading(true);
    setLoadError("");
    setDraftHydratedProjectId(null);
    setDraftStatus("正在读取云端草稿…");
    try {
      const response = await apiPost<unknown>(
        "/script/getScrptApi",
        { projectId, name: "" },
        undefined,
        { signal: controller.signal },
      );
      const scripts = normalizeClipScripts(response);
      const nextClips: ClipVideo[] = [];
      const observedTrackKeys = new Set<string>();
      const nextReadiness: Readiness = { trackCount: 0, selectedFinalCount: 0, fallbackCount: 0, missingCount: 0, totalDuration: 0 };
      await Promise.all(
        scripts.map(async (script, sceneIndex) => {
          const result = await apiPost<unknown>(
            "/production/workbench/getGenerateData",
            { projectId, scriptId: script.id },
            undefined,
            { signal: controller.signal },
          );
          const trackList = normalizeClipTrackList(result, script.name);
          trackList.forEach((track: any, trackIndex: number) => {
            const trackKey = `${script.id}:${String(track.id)}`;
            if (observedTrackKeys.has(trackKey)) return;
            observedTrackKeys.add(trackKey);
            nextReadiness.trackCount += 1;
            const videos = Array.isArray(track.videoList) ? track.videoList : [];
            const selected = videos.find((video: any) => Number(video.id) === Number(track.selectVideoId) && isCompletedVideo(video));
            const fallback = videos.find(isCompletedVideo);
            const video = selected || fallback;
            if (selected) nextReadiness.selectedFinalCount += 1;
            else if (fallback) nextReadiness.fallbackCount += 1;
            else nextReadiness.missingCount += 1;
            if (!video?.src) return;
            const duration = Math.max(1, Number(video.duration || track.duration) || 5);
            nextReadiness.totalDuration += duration;
            nextClips.push({
              key: `${script.id}-${track.id}-${video.id}`,
              title: `${script.name} / 分镜 ${trackIndex + 1}`,
              sceneName: `第${sceneIndex + 1}场 ${script.name}`,
              sceneIndex,
              trackId: Number(track.id),
              trackIndex,
              videoId: Number(video.id),
              src: video.src,
              duration,
              trimStart: 0,
              trimEnd: duration,
              speed: 1,
              volume: 1,
              selectionSource: selected ? "selected" : "fallback",
            });
          });
        }),
      );
      nextClips.sort((a, b) => a.sceneIndex - b.sceneIndex || a.trackIndex - b.trackIndex || a.videoId - b.videoId);
      const [latestFinal, catalog, draftResponse] = await Promise.all([
        apiPost<{ asset: FinalVideo | null }>(
          "/production/workbench/getFinalVideo",
          { projectId },
          undefined,
          { signal: controller.signal },
        ),
        listProjectAssetCatalog(
          { projectId, types: ["audio"] },
          { signal: controller.signal },
        ),
        apiPost<DraftResponse>(
          "/production/workbench/getEditorDraft",
          { projectId, episodesId: CLIP_WORKBENCH_DRAFT_EPISODE_ID },
          undefined,
          { signal: controller.signal },
        ),
      ]);
      if (!isCurrent()) return;

      const selectableAudio = catalog.items.filter(
        (item) => item.mediaKind === "audio" && Boolean(item.assetVersionId),
      );
      const draft = draftResponse.corrupted ? null : normalizeClipDraft(draftResponse.data);
      const validAudioVersions = new Set(
        selectableAudio.flatMap((item) => item.assetVersionId ? [item.assetVersionId] : []),
      );
      const selectedAudioVersion = draft?.soundtrack.assetVersionId && validAudioVersions.has(draft.soundtrack.assetVersionId)
        ? draft.soundtrack.assetVersionId
        : null;
      const selectedSoundtrackVolume = draft?.soundtrack.volume ?? 1;
      const restoredClips = applyClipWorkbenchDraft(nextClips, draft);
      allowEmptyTimelineRef.current = Boolean(draft && draft.timeline.length === 0);
      sourceClipsRef.current = nextClips.map((clip) => ({ ...clip }));
      const restoredRevisions = draft?.revisions ?? null;
      const restoredAutoEditPlan = draft?.autoEditPlan ?? null;
      const restoredAutoEditPreferences = draft?.autoEditPreferences ?? restoredAutoEditPlan?.preferences ?? null;
      const initialDraft = buildClipWorkbenchDraft(
        restoredClips,
        selectedAudioVersion,
        selectedSoundtrackVolume,
        draft?.savedAt || Date.now(),
        restoredRevisions,
        false,
        restoredAutoEditPlan,
        restoredAutoEditPreferences,
      );
      const initialSignature = clipDraftSignature(initialDraft);
      draftSignatureRef.current = initialSignature;
      latestDraftSnapshotRef.current = {
        projectId,
        draft: initialDraft,
        signature: initialSignature,
      };
      draftDirtyRef.current = false;
      setClips(restoredClips);
      setLastRemovedClip(null);
      setRevisionBundle(restoredRevisions);
      setAutoEditPlan(restoredAutoEditPlan);
      setAutoEditExplanations(restoredAutoEditPlan?.explanations
        ?? (restoredRevisions ? ["已恢复原始素材、自动方案与人工修改三个云端版本。"] : []));
      setAutoEditPreferences((current) => {
        const base = restoredAutoEditPreferences ?? {
          ...current,
          targetDuration: Math.max(5, Math.round(restoredClips.reduce(
            (total, clip) => total + (clip.trimEnd - clip.trimStart) / clamp(clip.speed ?? 1, 0.25, 4),
            0,
          )) || 30),
          soundtrackAssetVersionId: selectedAudioVersion,
        };
        return {
          ...base,
          sourceSelections: reconcileAutoEditSourceSelections(nextClips, base.sourceSelections),
        };
      });
      setReadiness(nextReadiness);
      setAudioAssets(selectableAudio);
      setAudioAssetVersionId(selectedAudioVersion);
      setSoundtrackVolume(selectedSoundtrackVolume);
      setDraftHydratedProjectId(projectId);
      setDraftDirty(false);
      setDraftSaving(false);
      setDraftStatus(
        draftResponse.corrupted
          ? "云端草稿损坏，已载入原始镜头；修改后会保存新草稿"
          : draft
            ? "已恢复云端剪辑草稿"
            : "尚无草稿，修改后自动保存",
      );
      setCurrentDraftVersionId(draftResponse.currentVersionId || null);
      undoStackRef.current = [];
      redoStackRef.current = [];
      setHistoryRevision((current) => current + 1);
      void loadDraftVersions(projectId, controller.signal);
      const finalCreatedAt = Number(latestFinal.asset?.createdAt) || 0;
      setFinalVideo(
        latestFinal.asset && shouldRestoreFinalVideo({
          finalCreatedAt,
          draftSavedAt: draft?.savedAt,
          draftTransportUpdatedAt: draftResponse.updatedAt,
        })
          ? latestFinal.asset
          : null,
      );
      setPlayingIndex(null);
      setRefreshRevision((current) => current + 1);
    } catch (error) {
      if (controller.signal.aborted || !isCurrent()) return;
      setClips([]);
      setFinalVideo(null);
      setReadiness(EMPTY_READINESS);
      setAudioAssets([]);
      setAutoEditExplanations([]);
      setRevisionBundle(null);
      setAutoEditPlan(null);
      sourceClipsRef.current = [];
      setDraftHydratedProjectId(null);
      setDraftStatus("");
      setDraftDirty(false);
      setDraftSaving(false);
      setDraftVersions([]);
      setCurrentDraftVersionId(null);
      setSelectedCompareVersionId("");
      setLoadError(error instanceof Error ? error.message : "剪辑素材读取失败");
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [currentProject?.id, loadDraftVersions, persistClipDraft]);

  useEffect(() => {
    void loadClips();
    return () => {
      loadControllerRef.current?.abort();
      renderControllerRef.current?.abort();
    };
  }, [loadClips]);

  useEffect(() => {
    if (!revisionBundle) return;
    if (suppressManualRevisionRef.current) {
      suppressManualRevisionRef.current = false;
      return;
    }
    const timeline = clips.map((clip) => ({
      videoId: clip.videoId,
      trimStart: clip.trimStart,
      trimEnd: clip.trimEnd,
      volume: clip.volume,
    }));
    const updated = updateManualEditRevision(revisionBundle, timeline);
    if (updated.manual.savedAt !== revisionBundle.manual.savedAt) {
      setRevisionBundle(updated);
    }
  }, [clips, revisionBundle]);

  useEffect(() => {
    const projectId = Number(currentProject?.id);
    if (
      !Number.isSafeInteger(projectId)
      || projectId <= 0
      || projectId !== draftHydratedProjectId
      || activeProjectIdRef.current !== projectId
      || loading
      || (!clips.length && !allowEmptyTimelineRef.current)
    ) return;

    const draft = buildClipWorkbenchDraft(
      clips,
      audioAssetVersionId,
      soundtrackVolume,
      Date.now(),
      revisionBundle,
      false,
      autoEditPlan,
      autoEditPreferences,
    );
    const signature = clipDraftSignature(draft);
    const previous = latestDraftSnapshotRef.current;
    const stableDraft = previous?.projectId === projectId && previous.signature === signature
      ? previous.draft
      : draft;
    const snapshot = { projectId, draft: stableDraft, signature };
    latestDraftSnapshotRef.current = snapshot;
    if (signature === draftSignatureRef.current) {
      draftDirtyRef.current = false;
      setDraftDirty(false);
      return;
    }
    draftDirtyRef.current = true;
    setDraftDirty(true);
    setDraftStatus("有未保存更改，将自动保存…");
    const timer = window.setTimeout(() => {
      void persistClipDraft(snapshot, "auto");
    }, 800);
    return () => {
      window.clearTimeout(timer);
    };
  }, [
    audioAssetVersionId,
    autoEditPlan,
    autoEditPreferences,
    clips,
    currentProject?.id,
    draftHydratedProjectId,
    loading,
    persistClipDraft,
    revisionBundle,
    soundtrackVolume,
  ]);

  useEffect(() => {
    mountedRef.current = true;
    const flushDetached = () => {
      const snapshot = latestDraftSnapshotRef.current;
      if (!snapshot || !draftDirtyRef.current) return;
      void persistClipDraft(snapshot, "detached");
    };
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!draftDirtyRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    window.addEventListener("pagehide", flushDetached);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      window.removeEventListener("pagehide", flushDetached);
      flushDetached();
      mountedRef.current = false;
    };
  }, [persistClipDraft]);

  function saveLatestDraft() {
    const snapshot = latestDraftSnapshotRef.current;
    if (!snapshot || !draftDirtyRef.current || draftSaving) return;
    void persistClipDraft(snapshot, "manual");
  }

  useEffect(() => {
    if (playingIndex === null) return;
    const video = playerRef.current;
    if (!video) return;
    void video.play().catch(() => undefined);
  }, [playingIndex]);

  function invalidateRenderedOutput() {
    setFinalVideo(null);
    setRenderError("");
    renderAttemptRef.current = null;
  }

  function snapshotEditorState(): EditorStateSnapshot {
    return {
      clips: clips.map((clip) => ({ ...clip })),
      audioAssetVersionId,
      soundtrackVolume,
    };
  }

  function pushUndoSnapshot() {
    undoStackRef.current = [...undoStackRef.current, snapshotEditorState()].slice(-50);
    redoStackRef.current = [];
    setHistoryRevision((current) => current + 1);
  }

  function applyEditorState(snapshot: EditorStateSnapshot) {
    setClips(snapshot.clips.map((clip) => ({ ...clip })));
    setAudioAssetVersionId(snapshot.audioAssetVersionId);
    setSoundtrackVolume(snapshot.soundtrackVolume);
    setPlayingIndex(null);
    invalidateRenderedOutput();
  }

  function undoEditorChange() {
    const previous = undoStackRef.current.at(-1);
    if (!previous) return;
    undoStackRef.current = undoStackRef.current.slice(0, -1);
    redoStackRef.current = [...redoStackRef.current, snapshotEditorState()].slice(-50);
    applyEditorState(previous);
    setHistoryRevision((current) => current + 1);
  }

  function redoEditorChange() {
    const next = redoStackRef.current.at(-1);
    if (!next) return;
    redoStackRef.current = redoStackRef.current.slice(0, -1);
    undoStackRef.current = [...undoStackRef.current, snapshotEditorState()].slice(-50);
    applyEditorState(next);
    setHistoryRevision((current) => current + 1);
  }

  function applyRevisionTimeline(timeline: AutoEditTimelineItem[]) {
    const source = sourceClipsRef.current;
    if (!source.length) return;
    const next = applyClipWorkbenchDraft(source, {
      version: "editor-timeline.v2",
      timeline: timeline.map((clip) => ({
        videoId: clip.videoId,
        trimStartSeconds: clip.trimStart,
        trimEndSeconds: clip.trimEnd,
        speed: source.find((item) => item.videoId === clip.videoId)?.speed ?? 1,
        volume: clip.volume,
      })),
      soundtrack: { assetVersionId: audioAssetVersionId, volume: soundtrackVolume },
      savedAt: Date.now(),
    });
    allowEmptyTimelineRef.current = next.length === 0;
    suppressManualRevisionRef.current = true;
    setClips(next);
    setPlayingIndex(null);
    setLastRemovedClip(null);
    invalidateRenderedOutput();
  }

  function generateAutomaticFirstCut() {
    const source = sourceClipsRef.current;
    if (!source.length) return;
    const preferences: AutoEditPreferences = {
      ...autoEditPreferences,
      soundtrackAssetVersionId: audioAssetVersionId,
    };
    const result = buildExplainableAutoEdit(source, preferences);
    const sourceTimeline = source.map((clip) => ({
      videoId: clip.videoId,
      trimStart: clip.trimStart,
      trimEnd: clip.trimEnd,
      volume: clip.volume,
    }));
    const currentManualTimeline = clips.map((clip) => ({
      videoId: clip.videoId,
      trimStart: clip.trimStart,
      trimEnd: clip.trimEnd,
      volume: clip.volume,
    }));
    setRevisionBundle(createEditRevisionBundle(sourceTimeline, result.timeline, Date.now(), currentManualTimeline));
    setAutoEditExplanations(result.explanations);
    setAutoEditPlan({
      preferences,
      explanations: result.explanations,
      subtitleCues: result.subtitleCues,
      beatMarkers: result.beatMarkers,
    });
    applyRevisionTimeline(result.timeline);
  }

  const autoEditSourceSelections = reconcileAutoEditSourceSelections(
    sourceClipsRef.current,
    autoEditPreferences.sourceSelections,
  );

  function updateAutoEditSourceSelection(videoId: number, patch: Partial<Pick<AutoEditSourceSelection, "included" | "purpose">>) {
    setAutoEditPreferences((current) => ({
      ...current,
      sourceSelections: reconcileAutoEditSourceSelections(sourceClipsRef.current, current.sourceSelections)
        .map((selection) => selection.videoId === videoId ? { ...selection, ...patch } : selection),
    }));
  }

  function moveAutoEditSourceSelection(index: number, direction: -1 | 1) {
    setAutoEditPreferences((current) => {
      const selections = reconcileAutoEditSourceSelections(sourceClipsRef.current, current.sourceSelections);
      const target = index + direction;
      if (target < 0 || target >= selections.length) return current;
      [selections[index], selections[target]] = [selections[target], selections[index]];
      return { ...current, sourceSelections: selections.map((selection, order) => ({ ...selection, order })) };
    });
  }

  function updateSubtitleCueText(cueId: string, text: string) {
    setAutoEditPlan((current) => current ? {
      ...current,
      subtitleCues: current.subtitleCues.map((cue) => cue.id === cueId ? { ...cue, text } : cue),
    } : current);
    invalidateRenderedOutput();
  }

  function moveClip(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= clips.length) return;
    pushUndoSnapshot();
    setClips((current) => {
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
    setPlayingIndex(null);
    invalidateRenderedOutput();
  }

  function removeClip(index: number) {
    setClips((current) => {
      const clip = current[index];
      if (!clip) return current;
      const next = current.filter((_, itemIndex) => itemIndex !== index);
      allowEmptyTimelineRef.current = next.length === 0;
      setLastRemovedClip({ clip, index });
      return next;
    });
    setPlayingIndex(null);
    invalidateRenderedOutput();
  }

  function undoRemoveClip() {
    const removed = lastRemovedClip;
    if (!removed) return;
    setClips((current) => {
      if (current.some((clip) => clip.videoId === removed.clip.videoId)) return current;
      const next = [...current];
      next.splice(Math.min(removed.index, next.length), 0, removed.clip);
      allowEmptyTimelineRef.current = false;
      return next;
    });
    setLastRemovedClip(null);
    invalidateRenderedOutput();
  }

  function updateClipEdit(
    videoId: number,
    field: "trimStart" | "trimEnd" | "speed" | "volume",
    rawValue: number,
  ) {
    if (!Number.isFinite(rawValue)) return;
    pushUndoSnapshot();
    setClips((current) => current.map((clip) => {
      if (clip.videoId !== videoId) return clip;
      if (field === "volume") return { ...clip, volume: clamp(rawValue, 0, 2) };
      if (field === "speed") return { ...clip, speed: clamp(rawValue, 0.25, 4) };
      if (field === "trimStart") {
        return {
          ...clip,
          trimStart: clamp(rawValue, 0, Math.max(0, clip.trimEnd - 0.1)),
        };
      }
      return {
        ...clip,
        trimEnd: clamp(rawValue, Math.min(clip.duration, clip.trimStart + 0.1), clip.duration),
      };
    }));
    invalidateRenderedOutput();
  }

  function selectSoundtrack(rawValue: string) {
    const next = Number(rawValue);
    const valid = audioAssets.some((asset) => asset.assetVersionId === next);
    const selected = valid ? next : null;
    if (selected === audioAssetVersionId) return;
    pushUndoSnapshot();
    setAudioAssetVersionId(selected);
    invalidateRenderedOutput();
  }

  function updateSoundtrackVolume(rawValue: number) {
    if (!Number.isFinite(rawValue)) return;
    const next = clamp(rawValue, 0, 2);
    if (next === soundtrackVolume) return;
    pushUndoSnapshot();
    setSoundtrackVolume(next);
    invalidateRenderedOutput();
  }

  function dropClipAt(targetIndex: number) {
    const sourceIndex = draggedClipIndexRef.current;
    draggedClipIndexRef.current = null;
    if (sourceIndex === null || sourceIndex === targetIndex) return;
    pushUndoSnapshot();
    setClips((current) => {
      if (sourceIndex < 0 || sourceIndex >= current.length || targetIndex < 0 || targetIndex >= current.length) return current;
      const nextClips = [...current];
      const [moved] = nextClips.splice(sourceIndex, 1);
      nextClips.splice(targetIndex, 0, moved);
      return nextClips;
    });
    setPlayingIndex(null);
    invalidateRenderedOutput();
  }

  function startSequence(index = 0) {
    if (!clips.length) return;
    setPlayingIndex(Math.min(Math.max(index, 0), clips.length - 1));
  }

  function advanceSequence() {
    setPlayingIndex((current) => {
      if (current === null || current + 1 >= clips.length) return null;
      return current + 1;
    });
  }

  function downloadSelectedClip(clip: ClipVideo) {
    const anchor = document.createElement("a");
    anchor.href = clip.src;
    anchor.download = `${clip.sceneIndex + 1}-${clip.trackIndex + 1}-${clip.videoId}.mp4`;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.click();
  }

  async function renderFinalVideo() {
    const projectId = Number(currentProject?.id);
    if (
      !Number.isSafeInteger(projectId)
      || projectId <= 0
      || renderingFinal
      || activeProjectIdRef.current !== projectId
      || clips.length === 0
      || clips.some((clip) => clip.selectionSource !== "selected")
    ) return;
    const renderSubtitleCues = autoEditPlan?.preferences.subtitles
      ? autoEditPlan.subtitleCues
      : [];
    const payload = buildFinalRenderPayload(
      projectId,
      clips,
      audioAssetVersionId,
      soundtrackVolume,
      renderSubtitleCues,
    );
    const signature = buildFinalRenderIdempotencyKey(
      projectId,
      clips,
      audioAssetVersionId,
      soundtrackVolume,
      "",
      renderSubtitleCues,
    );
    const preparedAttempt = prepareStoredSubmissionAttempt({
      current: renderAttemptRef.current,
      flow: "clip-final-render",
      operationKey: `${projectId}:${signature}`,
      prefix: `clip-final-v3-${projectId}`,
      payload,
    });
    const { attempt, storageKey } = preparedAttempt;
    renderAttemptRef.current = attempt;
    renderControllerRef.current?.abort();
    const controller = new AbortController();
    renderControllerRef.current = controller;
    setRenderingFinal(true);
    setRenderError("");
    try {
      const response = await apiPost<{ asset: FinalVideo }>("/production/workbench/renderFinalVideo", payload, undefined, {
        signal: controller.signal,
        headers: {
          "Idempotency-Key": attempt.idempotencyKey,
        },
      });
      if (controller.signal.aborted || activeProjectIdRef.current !== projectId) return;
      setFinalVideo(response.asset);
      clearStoredSubmissionAttempt(storageKey);
      renderAttemptRef.current = null;
    } catch (error) {
      if (controller.signal.aborted || activeProjectIdRef.current !== projectId) return;
      setRenderError(error instanceof Error ? error.message : "成片合成失败");
      if (!shouldRetainStoredSubmissionAttempt(error)) {
        clearStoredSubmissionAttempt(storageKey);
        renderAttemptRef.current = null;
      }
    } finally {
      if (!controller.signal.aborted && activeProjectIdRef.current === projectId) {
        setRenderingFinal(false);
      }
    }
  }

  async function restoreDraftVersion(version: ClipDraftVersion) {
    const projectId = Number(currentProject?.id);
    if (
      !Number.isSafeInteger(projectId)
      || projectId <= 0
      || versionAction
      || version.id === currentDraftVersionId
    ) return;
    const snapshot = latestDraftSnapshotRef.current;
    if (!snapshot) return;
    if (draftDirtyRef.current) {
      await persistClipDraft(snapshot, "manual");
      if (draftDirtyRef.current) return;
    }
    if (!window.confirm(`恢复到 ${new Date(version.createdAt).toLocaleString()} 的版本？当前版本会完整保留在历史中。`)) return;
    setVersionAction("restoring");
    setDraftStatus("正在恢复历史版本…");
    try {
      await apiPost(
        "/production/workbench/restoreEditorDraftVersion",
        {
          projectId,
          episodesId: CLIP_WORKBENCH_DRAFT_EPISODE_ID,
          versionId: version.id,
          expectedCurrentSavedAt: latestDraftSnapshotRef.current?.draft.savedAt || 0,
        },
        undefined,
        {
          headers: {
            "Idempotency-Key": `clip-editor-restore:${projectId}:${version.id}:${latestDraftSnapshotRef.current?.draft.savedAt || 0}`,
          },
        },
      );
      draftDirtyRef.current = false;
      setDraftDirty(false);
      setDraftStatus("历史版本已恢复，原版本仍保留");
      await loadClips();
    } catch (error) {
      setDraftStatus(`版本恢复失败：${error instanceof Error ? error.message : "请求失败"}`);
    } finally {
      setVersionAction("");
    }
  }

  function downloadFinalVideo() {
    if (!finalVideo?.url) return;
    const anchor = document.createElement("a");
    anchor.href = finalVideo.url;
    anchor.download = `fanjin-project-${currentProject?.id || "final"}.mp4`;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.click();
  }

  const renderBlockReason = clips.length === 0
    ? "剪辑台至少需要保留一个镜头"
    : clips.some((clip) => clip.selectionSource !== "selected")
      ? "请先为每个保留的镜头选择成片，或将其移出剪辑"
      : "";

  return (
    <div
      data-testid="quick-clip-page"
      data-project-correlation-digest={currentProject?.correlationDigest || undefined}
      data-clip-count={clips.length}
      data-unique-clip-count={new Set(clips.map((clip) => clip.key)).size}
      data-track-count={readiness.trackCount}
      data-selected-final-count={readiness.selectedFinalCount}
      data-fallback-count={readiness.fallbackCount}
      data-missing-count={readiness.missingCount}
      data-source-duration-seconds={readiness.totalDuration.toFixed(3)}
      data-timeline-duration-seconds={timelineDuration.toFixed(3)}
      data-refresh-revision={refreshRevision}
      data-load-state={loading ? "loading" : loadError ? "error" : clips.length ? "ready" : "empty"}
      style={{ height: "100%", minHeight: 0, display: "flex", flexDirection: "column", gap: 10, color: "#18181b" }}
    >
      <div style={{ flex: "0 0 auto", height: 44, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "0 2px" }}>
        <div style={{ minWidth: 0, display: "grid", gap: 3 }}>
          <strong style={{ color: "#18181b", fontSize: 16, fontWeight: 780 }}>剪辑台</strong>
          <span style={{ overflow: "hidden", color: "#71717a", fontSize: 12, textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{clipSummaryLine}</span>
        </div>
        <button data-testid="quick-clip-refresh" data-refresh-revision={refreshRevision} onClick={loadClips} style={{ padding: "6px 16px", border: "1px solid #e4e4e7", borderRadius: 8, background: "#fff", cursor: "pointer", fontSize: 13, color: "#18181b" }} disabled={loading}>
          {loading ? "加载中…" : "刷新素材"}
        </button>
      </div>

      {currentProject?.id ? (
        <div style={{ flex: "0 0 auto", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", padding: "10px 12px", border: "1px solid #e4e4e7", borderRadius: 10, background: "#fff" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            {(["已选成片", "可用回退", "缺失镜头", "总时长"] as const).map((label) => (
              <span key={label} style={{ height: 24, padding: "0 9px", border: "1px solid rgba(229,231,235,0.9)", borderRadius: 7, color: "#71717a", fontSize: 12, lineHeight: "23px", background: "rgba(248,249,252,0.84)" }}>
                {label === "已选成片" ? `已选成片 ${readiness.selectedFinalCount}` : label === "可用回退" ? `可用回退 ${readiness.fallbackCount}` : label === "缺失镜头" ? `缺失镜头 ${readiness.missingCount}` : `剪辑时长 ${formatDuration(timelineDuration)}`}
              </span>
            ))}
            {draftStatus ? (
              <span data-testid="quick-clip-draft-status" style={{ color: draftStatus.startsWith("草稿保存失败") ? "#9f231b" : "#71717a", fontSize: 12 }}>
                {draftStatus}
                {draftStatus.startsWith("草稿保存失败") ? (
                  <button
                    type="button"
                    onClick={saveLatestDraft}
                    disabled={draftSaving}
                    style={{ marginLeft: 6, padding: "2px 7px", border: "1px solid #efb4ae", borderRadius: 6, background: "#fff", color: "#9f231b", cursor: "pointer", fontSize: 11 }}
                  >
                    {draftSaving ? "保存中…" : "重试保存"}
                  </button>
                ) : null}
              </span>
            ) : null}
            {lastRemovedClip ? (
              <span style={{ color: "#7c3f12", fontSize: 12 }}>
                已移出“{lastRemovedClip.clip.title}”
                <button type="button" onClick={undoRemoveClip} style={{ marginLeft: 6, padding: "2px 7px", border: "1px solid #f0c38a", borderRadius: 6, background: "#fffaf3", color: "#7c3f12", cursor: "pointer", fontSize: 11 }}>撤销移出</button>
              </span>
            ) : null}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              data-testid="clip-undo"
              data-history-revision={historyRevision}
              type="button"
              onClick={undoEditorChange}
              disabled={!undoStackRef.current.length}
              style={{ padding: "7px 10px", border: "1px solid #d8dde5", borderRadius: 8, background: "#fff", color: "#18181b", cursor: undoStackRef.current.length ? "pointer" : "default", fontSize: 12, opacity: undoStackRef.current.length ? 1 : 0.5 }}
            >
              撤销
            </button>
            <button
              data-testid="clip-redo"
              type="button"
              onClick={redoEditorChange}
              disabled={!redoStackRef.current.length}
              style={{ padding: "7px 10px", border: "1px solid #d8dde5", borderRadius: 8, background: "#fff", color: "#18181b", cursor: redoStackRef.current.length ? "pointer" : "default", fontSize: 12, opacity: redoStackRef.current.length ? 1 : 0.5 }}
            >
              重做
            </button>
            <button
              data-testid="clip-save-draft"
              type="button"
              onClick={saveLatestDraft}
              disabled={!draftDirty || draftSaving}
              title={draftDirty ? "立即把当前剪辑保存到云端" : "当前剪辑草稿已保存"}
              style={{ padding: "7px 14px", border: "1px solid #d8dde5", borderRadius: 8, background: "#fff", color: "#18181b", cursor: draftDirty && !draftSaving ? "pointer" : "default", fontSize: 12, opacity: !draftDirty && !draftSaving ? 0.65 : 1 }}
            >
              {draftSaving ? "正在保存草稿…" : draftDirty ? "立即保存草稿" : "草稿已保存"}
            </button>
            {finalVideo?.url ? (
              <button type="button" onClick={downloadFinalVideo} style={{ padding: "7px 14px", border: "1px solid #d8dde5", borderRadius: 8, background: "#fff", color: "#18181b", cursor: "pointer", fontSize: 12 }}>下载成片 MP4</button>
            ) : null}
            <button
              data-testid="quick-clip-render-final"
              type="button"
              onClick={renderFinalVideo}
              disabled={renderingFinal || Boolean(renderBlockReason)}
              title={renderBlockReason}
              style={{ padding: "7px 14px", border: 0, borderRadius: 8, background: "#5d94bd", color: "#fff", cursor: "pointer", fontSize: 12, opacity: renderingFinal || renderBlockReason ? 0.45 : 1 }}
            >
              {renderingFinal ? "正在合成 MP4…" : finalVideo ? "重新合成成片" : "合成成片 MP4"}
            </button>
          </div>
        </div>
      ) : null}

      {currentProject?.id && draftVersions.length ? (
        <div data-testid="clip-version-history" style={{ flex: "0 0 auto", display: "grid", gridTemplateColumns: "minmax(220px, 320px) minmax(260px, 1fr) auto", alignItems: "center", gap: 12, padding: "10px 12px", border: "1px solid #dfe7ef", borderRadius: 10, background: "#f7fafc" }}>
          <label style={{ display: "grid", gap: 4, color: "#52525b", fontSize: 11 }}>
            对比历史版本（保留最近 {draftVersions.length} 个）
            <select
              data-testid="clip-version-select"
              value={selectedCompareVersionId}
              onChange={(event) => setSelectedCompareVersionId(event.target.value)}
              style={{ height: 32, border: "1px solid #ccd8e3", borderRadius: 7, background: "#fff", padding: "0 8px", color: "#18181b" }}
            >
              <option value="">选择历史版本</option>
              {draftVersions.map((version) => (
                <option key={version.id} value={version.id}>
                  {version.id === currentDraftVersionId ? "当前 · " : ""}{new Date(version.createdAt).toLocaleString()}{version.restoredFromVersionId ? " · 恢复版本" : ""}
                </option>
              ))}
            </select>
          </label>
          <div style={{ minWidth: 0, color: "#526170", fontSize: 12 }}>
            {versionAction === "loading" ? "正在读取云端版本…" : selectedVersionComparison ? (
              <span data-testid="clip-version-diff">
                片段参数变化 {selectedVersionComparison.changedClipCount} 项
                {selectedVersionComparison.orderChanged ? " · 顺序有变化" : " · 顺序相同"}
                {selectedVersionComparison.soundtrackChanged ? " · 配乐有变化" : " · 配乐相同"}
                {` · ${formatDuration(selectedVersionComparison.targetDurationSeconds)} → ${formatDuration(selectedVersionComparison.currentDurationSeconds)}`}
              </span>
            ) : "选择版本后可比较片段、顺序、配乐与时长。"}
          </div>
          <button
            data-testid="clip-version-restore"
            type="button"
            disabled={!selectedCompareVersion || selectedCompareVersion.id === currentDraftVersionId || Boolean(versionAction)}
            onClick={() => selectedCompareVersion && void restoreDraftVersion(selectedCompareVersion)}
            style={{ padding: "7px 14px", border: "1px solid #b7c9d8", borderRadius: 8, background: "#fff", color: "#29465d", cursor: selectedCompareVersion && selectedCompareVersion.id !== currentDraftVersionId && !versionAction ? "pointer" : "default", fontSize: 12, opacity: !selectedCompareVersion || selectedCompareVersion.id === currentDraftVersionId || versionAction ? 0.5 : 1 }}
          >
            {versionAction === "restoring" ? "正在恢复…" : "恢复为新版本"}
          </button>
        </div>
      ) : null}

      {currentProject?.id && clips.length ? (
        <section className="quickClipAutoPanel" data-testid="quick-clip-auto-panel" aria-label="自动初剪">
          <div className="quickClipAutoHeading">
            <span>
              <strong>自动初剪</strong>
              <small>按目标时长生成可解释方案；原始、自动和人工版本分别保留。</small>
            </span>
            <button
              data-testid="quick-clip-auto-generate"
              type="button"
              onClick={generateAutomaticFirstCut}
              disabled={!autoEditSourceSelections.some((selection) => selection.included)}
            >生成自动初剪</button>
          </div>
          <div className="quickClipAutoSources" aria-label="自动初剪素材选择">
            <header>
              <strong>素材选用与用途</strong>
              <small>勾选参与初剪的素材，并调整用途和自动编排顺序。</small>
            </header>
            <div>
              {autoEditSourceSelections.map((selection, index) => {
                const sourceClip = sourceClipsRef.current.find((clip) => clip.videoId === selection.videoId);
                return (
                  <div className="quickClipAutoSourceRow" key={selection.videoId}>
                    <label>
                      <input
                        type="checkbox"
                        aria-label={`选用素材 ${sourceClip?.title || selection.videoId}`}
                        checked={selection.included}
                        onChange={(event) => updateAutoEditSourceSelection(selection.videoId, { included: event.target.checked })}
                      />
                      <span>{sourceClip?.title || `素材 ${selection.videoId}`}</span>
                    </label>
                    <select
                      aria-label={`素材用途 ${sourceClip?.title || selection.videoId}`}
                      value={selection.purpose}
                      onChange={(event) => updateAutoEditSourceSelection(selection.videoId, { purpose: event.target.value as AutoEditSourcePurpose })}
                    >
                      <option value="hook">开场钩子</option>
                      <option value="story">叙事推进</option>
                      <option value="proof">卖点证据</option>
                      <option value="cta">行动收尾</option>
                    </select>
                    <span className="quickClipAutoSourceOrder">
                      <button type="button" aria-label={`素材 ${index + 1} 上移`} disabled={index === 0} onClick={() => moveAutoEditSourceSelection(index, -1)}>上移</button>
                      <button type="button" aria-label={`素材 ${index + 1} 下移`} disabled={index === autoEditSourceSelections.length - 1} onClick={() => moveAutoEditSourceSelection(index, 1)}>下移</button>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="quickClipAutoControls">
            <label>
              <span>目标时长</span>
              <input
                aria-label="自动初剪目标时长"
                type="number"
                min={5}
                max={300}
                value={autoEditPreferences.targetDuration}
                onChange={(event) => setAutoEditPreferences((current) => ({ ...current, targetDuration: Math.min(300, Math.max(5, Number(event.target.value) || 5)) }))}
              />
            </label>
            <label>
              <span>节奏</span>
              <select aria-label="自动初剪节奏" value={autoEditPreferences.pace} onChange={(event) => setAutoEditPreferences((current) => ({ ...current, pace: event.target.value as AutoEditPreferences["pace"] }))}>
                <option value="slow">舒缓</option>
                <option value="balanced">均衡</option>
                <option value="fast">快速</option>
              </select>
            </label>
            <label>
              <span>原声</span>
              <select aria-label="自动初剪原声" value={autoEditPreferences.originalAudio} onChange={(event) => setAutoEditPreferences((current) => ({ ...current, originalAudio: event.target.value as AutoEditPreferences["originalAudio"] }))}>
                <option value="keep">完整保留</option>
                <option value="duck">配乐下压低</option>
                <option value="mute">静音</option>
              </select>
            </label>
            <label className="quickClipSubtitleToggle">
              <input type="checkbox" checked={autoEditPreferences.subtitles} onChange={(event) => setAutoEditPreferences((current) => ({ ...current, subtitles: event.target.checked }))} />
              <span>生成字幕轨道</span>
            </label>
          </div>
          {revisionBundle ? (
            <div className="quickClipVersions" aria-label="剪辑版本">
              <span>原始素材 · {revisionBundle.source.timeline.length} 镜头</span>
              <span>自动方案 · {revisionBundle.automatic.timeline.length} 镜头</span>
              <span>人工版本 · {revisionBundle.manual.timeline.length} 镜头</span>
              <button type="button" onClick={() => applyRevisionTimeline(revisionBundle.source.timeline)}>恢复原始</button>
              <button type="button" onClick={() => applyRevisionTimeline(revisionBundle.automatic.timeline)}>恢复自动方案</button>
              <button type="button" onClick={() => applyRevisionTimeline(revisionBundle.manual.timeline)}>恢复人工版本</button>
            </div>
          ) : null}
          {autoEditExplanations.length ? (
            <ul className="quickClipAutoExplanation" data-testid="quick-clip-auto-explanation">
              {autoEditExplanations.map((item) => <li key={item}>{item}</li>)}
            </ul>
          ) : null}
          {autoEditPlan ? (
            <div className="quickClipStructuredTracks" data-testid="quick-clip-structured-tracks">
              <section aria-label="字幕轨道">
                <header>
                  <strong>字幕轨道</strong>
                  <small>{visibleSubtitleCues.length ? `${visibleSubtitleCues.length} 条，可逐条修改` : "当前方案未生成字幕"}</small>
                </header>
                {visibleSubtitleCues.length ? (
                  <div className="quickClipSubtitleCues">
                    {visibleSubtitleCues.map((cue) => (
                      <label key={cue.id}>
                        <span>{cue.startSeconds.toFixed(1)}–{cue.endSeconds.toFixed(1)}s</span>
                        <input
                          aria-label={`${cue.startSeconds.toFixed(1)} 秒字幕`}
                          value={cue.text}
                          maxLength={500}
                          onChange={(event) => updateSubtitleCueText(cue.id, event.target.value)}
                        />
                      </label>
                    ))}
                  </div>
                ) : <small className="quickClipTrackEmpty">勾选“生成字幕轨道”后重新生成自动初剪。</small>}
              </section>
              <section aria-label="节奏点轨道">
                <header>
                  <strong>节奏点</strong>
                  <small>{autoEditPlan.beatMarkers.length} 个剪切 / 节拍标记</small>
                </header>
                <div className="quickClipBeatRail" aria-label="节奏点时间轴">
                  {autoEditPlan.beatMarkers.map((marker) => (
                    <span
                      key={marker.id}
                      className={marker.kind}
                      style={{ left: `${Math.min(100, Math.max(0, marker.timeSeconds / Math.max(0.1, autoEditPlan.preferences.targetDuration) * 100))}%` }}
                      title={`${marker.kind === "cut" ? "剪切点" : "节拍"} ${marker.timeSeconds.toFixed(1)} 秒`}
                    />
                  ))}
                </div>
              </section>
            </div>
          ) : null}
        </section>
      ) : null}

      {renderBlockReason ? (
        <div role="status" style={{ padding: "9px 12px", border: "1px solid #fde68a", borderRadius: 8, color: "#92400e", background: "#fffbeb", fontSize: 12 }}>
          {renderBlockReason}
        </div>
      ) : null}

      {renderError ? <div role="alert" style={{ padding: "9px 12px", border: "1px solid #efb4ae", borderRadius: 8, color: "#9f231b", background: "#fff7f6", fontSize: 12 }}>{renderError}</div> : null}

      {finalVideo?.url ? (
        <div data-testid="quick-clip-final-result" style={{ flex: "0 0 auto", display: "grid", gridTemplateColumns: "minmax(260px, 420px) 1fr", gap: 14, padding: 12, border: "1px solid #cfe5d5", borderRadius: 10, background: "#f7fff9" }}>
          <video src={finalVideo.url} controls playsInline preload="metadata" style={{ width: "100%", maxHeight: 236, borderRadius: 8, background: "#000" }} />
          <div style={{ display: "grid", alignContent: "center", gap: 7, color: "#35523d", fontSize: 12 }}>
            <strong style={{ color: "#163d24", fontSize: 14 }}>真实成片已生成</strong>
            <span>{finalVideo.width}×{finalVideo.height} · {formatDuration(finalVideo.durationMs / 1000)}</span>
            <span>已写入项目受控存储，可直接播放和下载 MP4。</span>
          </div>
        </div>
      ) : null}

      {loadError ? (
        <div style={{ flex: 1, minHeight: 520, display: "grid", placeItems: "center", border: "1px solid #efb4ae", borderRadius: 12, background: "#fff7f6", color: "#9f231b", fontSize: 14, gap: 12 }}>
          <strong>剪辑素材加载失败</strong>
          <span>{loadError}</span>
          <button onClick={loadClips} style={{ padding: "8px 20px", background: "#5d94bd", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer", fontSize: 13 }} disabled={loading}>重试</button>
        </div>
      ) : loading && !clips.length ? (
        <div style={{ flex: 1, minHeight: 520, display: "grid", placeItems: "center", border: "1px solid #e4e4e7", borderRadius: 12, background: "#fff", color: "#71717a", fontSize: 14 }}>
          正在加载可剪辑视频…
        </div>
      ) : !clips.length ? (
        <div style={{ flex: 1, minHeight: 520, display: "grid", placeItems: "center", border: "1px solid #e4e4e7", borderRadius: 12, background: "#fff", color: "#71717a", fontSize: 14, gap: 12 }}>
          <div>暂无可剪辑视频</div>
          <div style={{ fontSize: 12, color: "#a1a1aa" }}>请先在视频生成页生成视频，并将需要使用的视频设为成片</div>
          <button onClick={loadClips} style={{ padding: "8px 20px", background: "#5d94bd", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer", fontSize: 13 }} disabled={loading}>
            刷新素材
          </button>
        </div>
      ) : (
        <div style={{ flex: 1, minHeight: 0, overflow: "hidden", border: "1px solid #e4e4e7", borderRadius: 12, background: "#fff", display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "10px 16px", borderBottom: "1px solid #e4e4e7" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0, flexWrap: "wrap" }}>
              <label style={{ display: "flex", alignItems: "center", gap: 6, color: "#52525b", fontSize: 12 }}>
                项目配乐
                <select
                  value={audioAssetVersionId ?? ""}
                  onChange={(event) => selectSoundtrack(event.target.value)}
                  style={{ minWidth: 180, maxWidth: 280, height: 30, border: "1px solid #d8dde5", borderRadius: 7, background: "#fff", color: "#18181b", padding: "0 8px" }}
                >
                  <option value="">不添加配乐</option>
                  {audioAssets.map((asset) => (
                    <option key={asset.assetId} value={asset.assetVersionId ?? ""}>{asset.name}</option>
                  ))}
                </select>
              </label>
              {audioAssetVersionId ? (
                <label style={{ display: "flex", alignItems: "center", gap: 6, color: "#52525b", fontSize: 12 }}>
                  配乐音量
                  <input
                    type="range"
                    min={0}
                    max={2}
                    step={0.05}
                    value={soundtrackVolume}
                    onChange={(event) => updateSoundtrackVolume(Number(event.target.value))}
                  />
                  <span style={{ width: 34 }}>{soundtrackVolume.toFixed(2)}</span>
                </label>
              ) : null}
              {!audioAssets.length ? <span style={{ color: "#a1a1aa", fontSize: 11 }}>项目暂无可用音频资产</span> : null}
            </div>
            <button type="button" onClick={() => startSequence()} style={{ padding: "7px 16px", border: 0, borderRadius: 8, background: "#5d94bd", color: "#fff", cursor: "pointer", fontSize: 13 }}>连续预览</button>
          </div>
          {playingIndex !== null && clips[playingIndex] ? (
            <div style={{ display: "grid", gap: 8, padding: 16, borderBottom: "1px solid #e4e4e7", background: "#0b0d10" }}>
              <video
                ref={playerRef}
                key={clips[playingIndex].key}
                src={clips[playingIndex].src}
                controls
                autoPlay
                playsInline
                onLoadedMetadata={(event) => {
                  event.currentTarget.currentTime = clips[playingIndex].trimStart;
                  event.currentTarget.volume = Math.min(1, clips[playingIndex].volume);
                  event.currentTarget.playbackRate = clamp(clips[playingIndex].speed ?? 1, 0.25, 4);
                }}
                onTimeUpdate={(event) => {
                  if (event.currentTarget.currentTime >= clips[playingIndex].trimEnd - 0.03) {
                    advanceSequence();
                  }
                }}
                onEnded={advanceSequence}
                style={{ width: "100%", maxHeight: 480, objectFit: "contain", background: "#000" }}
              />
              <span style={{ color: "#fff", fontSize: 12 }}>
                {playingIndex + 1}/{clips.length} · {clips[playingIndex].title} · {clips[playingIndex].trimStart.toFixed(1)}s–{clips[playingIndex].trimEnd.toFixed(1)}s
              </span>
            </div>
          ) : null}
          <div style={{ flex: 1, overflow: "auto", padding: 12 }}>
            <div style={{ minWidth: 900, display: "grid", gap: 8 }}>
              {clips.map((clip, index) => (
                <div
                  data-testid="quick-clip-row"
                  data-selection-source={clip.selectionSource}
                  key={clip.key}
                  draggable
                  onDragStart={() => {
                    draggedClipIndexRef.current = index;
                  }}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={() => dropClipAt(index)}
                  title="拖拽可调整镜头顺序"
                  style={{
                    display: "grid",
                    gridTemplateColumns: "42px 142px minmax(190px, 1fr) 108px 108px 145px 175px 202px",
                    alignItems: "center",
                    gap: 10,
                    padding: 9,
                    border: "1px solid #e4e4e7",
                    borderRadius: 9,
                    background: "#fafafa",
                  }}
                >
                  <strong style={{ color: "#71717a", textAlign: "center", fontSize: 12 }}>{index + 1}</strong>
                  <video src={clip.src} style={{ width: 142, aspectRatio: "16/9", objectFit: "cover", borderRadius: 6, background: "#18181b" }} preload="metadata" muted />
                  <div style={{ minWidth: 0, display: "grid", gap: 4 }}>
                    <strong style={{ overflow: "hidden", color: "#18181b", fontSize: 12, textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{clip.title}</strong>
                    <span style={{ overflow: "hidden", color: "#71717a", fontSize: 11, textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{clip.sceneName}</span>
                    <span style={{ color: "#71717a", fontSize: 11 }}>源 {clip.duration.toFixed(1)}s · 成片 {((clip.trimEnd - clip.trimStart) / clamp(clip.speed ?? 1, 0.25, 4)).toFixed(1)}s</span>
                  </div>
                  <label style={{ display: "grid", gap: 3, color: "#71717a", fontSize: 10 }}>
                    入点（秒）
                    <input
                      aria-label={`${clip.title} 入点`}
                      type="number"
                      min={0}
                      max={Math.max(0, clip.trimEnd - 0.1)}
                      step={0.1}
                      value={clip.trimStart}
                      onChange={(event) => updateClipEdit(clip.videoId, "trimStart", Number(event.target.value))}
                      style={{ width: "100%", height: 29, boxSizing: "border-box", border: "1px solid #d8dde5", borderRadius: 6, padding: "0 7px" }}
                    />
                  </label>
                  <label style={{ display: "grid", gap: 3, color: "#71717a", fontSize: 10 }}>
                    出点（秒）
                    <input
                      aria-label={`${clip.title} 出点`}
                      type="number"
                      min={Math.min(clip.duration, clip.trimStart + 0.1)}
                      max={clip.duration}
                      step={0.1}
                      value={clip.trimEnd}
                      onChange={(event) => updateClipEdit(clip.videoId, "trimEnd", Number(event.target.value))}
                      style={{ width: "100%", height: 29, boxSizing: "border-box", border: "1px solid #d8dde5", borderRadius: 6, padding: "0 7px" }}
                    />
                  </label>
                  <label style={{ display: "grid", gridTemplateColumns: "1fr 38px", alignItems: "center", gap: 5, color: "#71717a", fontSize: 10 }}>
                    <span style={{ gridColumn: "1 / -1" }}>变速</span>
                    <input
                      aria-label={`${clip.title} 变速`}
                      type="range"
                      min={0.25}
                      max={4}
                      step={0.25}
                      value={clip.speed ?? 1}
                      onChange={(event) => updateClipEdit(clip.videoId, "speed", Number(event.target.value))}
                    />
                    <span>{(clip.speed ?? 1).toFixed(2)}×</span>
                  </label>
                  <label style={{ display: "grid", gridTemplateColumns: "1fr 38px", alignItems: "center", gap: 5, color: "#71717a", fontSize: 10 }}>
                    <span style={{ gridColumn: "1 / -1" }}>原声音量</span>
                    <input
                      data-testid="quick-clip-volume"
                      aria-label={`${clip.title} 原声音量`}
                      type="range"
                      min={0}
                      max={2}
                      step={0.05}
                      value={clip.volume}
                      onChange={(event) => updateClipEdit(clip.videoId, "volume", Number(event.target.value))}
                    />
                    <span>{clip.volume.toFixed(2)}</span>
                  </label>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 5 }}>
                    <button type="button" onClick={() => moveClip(index, -1)} disabled={index === 0} style={{ padding: "4px 6px", border: "1px solid #d8dde5", borderRadius: 6, background: "#fff", cursor: index === 0 ? "not-allowed" : "pointer", fontSize: 11, opacity: index === 0 ? 0.45 : 1 }}>上移</button>
                    <button type="button" onClick={() => moveClip(index, 1)} disabled={index === clips.length - 1} style={{ padding: "4px 6px", border: "1px solid #d8dde5", borderRadius: 6, background: "#fff", cursor: index === clips.length - 1 ? "not-allowed" : "pointer", fontSize: 11, opacity: index === clips.length - 1 ? 0.45 : 1 }}>下移</button>
                    <button type="button" onClick={() => startSequence(index)} style={{ padding: "4px 6px", border: "1px solid #d8dde5", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 11 }}>预览</button>
                    <button type="button" onClick={() => downloadSelectedClip(clip)} style={{ padding: "4px 6px", border: "1px solid #d8dde5", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 11 }}>下载</button>
                    <button type="button" aria-label={`移出剪辑 ${clip.title}`} onClick={() => removeClip(index)} style={{ gridColumn: "1 / -1", padding: "4px 6px", border: "1px solid #efb4ae", borderRadius: 6, background: "#fff7f6", color: "#9f231b", cursor: "pointer", fontSize: 11 }}>移出剪辑</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
