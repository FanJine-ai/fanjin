import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X, ZoomIn } from "lucide-react";
import { apiPost } from "../../api/http";
import DirectorShotEditor from "../../features/quick-create/DirectorShotEditor";
import { useSessionStore } from "../../features/quick-create/session/sessionStore";
import type { QuickCreateDirectorPlan } from "../../features/quick-create/types";
import { isDirectorPlan } from "../create/quickCreateRecovery";
import {
  retainUnsuccessfulSelection,
  settleItemBatch,
  summarizeItemBatch,
} from "../../features/quick-create/itemBatch";
import {
  clearStoredSubmissionAttempt,
  prepareStoredSubmissionAttempt,
  readStoredSubmissionAttempt,
  shouldRetainStoredSubmissionAttempt,
  submissionAttemptStorageKey,
  type StoredSubmissionAttempt,
  writeStoredSubmissionAttempt,
} from "../../features/quick-create/itemAttemptStorage";
import {
  cancelProjectImageTask,
  fetchProjectImageTasks,
  isProjectImageTaskActive,
  latestProjectImageTasksByResource,
  projectImageTaskLabel,
  shouldRetainProjectImageAttempt,
  STORYBOARD_IMAGE_TASK_API,
  type ProjectImageTask,
} from "../../features/quick-create/projectImageTasks";
import {
  resolveStableSubmissionAttempt,
  type StableSubmissionAttempt,
} from "../../features/quick-create/submissionAttempt";
import {
  createTaskPoller,
  type TaskPoller,
} from "../../features/quick-create/tasks/taskPoller";
import { useProjectStore } from "../../stores/projectStore";
import { ConfirmDialog } from "../../ui/console";

type ScriptItem = { id: number; name: string; content: string };
type StoryboardItem = {
  id?: number; prompt?: string; videoDesc?: string; duration?: number | null; src?: string | null;
  state?: string; shouldGenerateImage?: number; reason?: string; trackId?: number;
  associateAssetsIds?: number[]; scriptId?: number; scriptName?: string;
};
type StoryboardGroup = { script: ScriptItem; storyboard: StoryboardItem[] };
type ViewMode = "list" | "board" | "timeline";
type StoryboardGenerationAcceptance = {
  id: number;
  state: string;
  imageTaskId: number;
};
type StoryboardRuntime = {
  groups: StoryboardGroup[];
  imageTasks: ProjectImageTask[];
};
type StoryboardDeleteIntent = {
  projectId: number;
  ids: number[];
  label: string;
  intentToken: string;
  idempotencyKey: string;
};
type StoryboardDeleteError = {
  intentToken: string;
  message: string;
};

export function normalizeStoryboardScripts(value: unknown): ScriptItem[] {
  if (!Array.isArray(value)) throw new Error("剧本列表响应格式无效，已阻止展示空数据");
  return value.map((entry) => {
    const source = entry && typeof entry === "object" && !Array.isArray(entry)
      ? entry as Record<string, unknown>
      : null;
    const id = Number(source?.id);
    const name = typeof source?.name === "string" ? source.name.trim() : "";
    const content = typeof source?.content === "string" ? source.content : "";
    if (!source || !Number.isSafeInteger(id) || id <= 0 || !name) {
      throw new Error("剧本列表包含无效记录，已阻止展示不完整数据");
    }
    return { id, name, content };
  });
}

export function normalizeStoryboardItems(value: unknown, script: ScriptItem): StoryboardItem[] {
  if (!Array.isArray(value)) {
    throw new Error(`剧本「${script.name}」的分镜响应格式无效`);
  }
  return value.map((entry) => {
    const source = entry && typeof entry === "object" && !Array.isArray(entry)
      ? entry as Record<string, unknown>
      : null;
    const id = Number(source?.id);
    if (!source || !Number.isSafeInteger(id) || id <= 0) {
      throw new Error(`剧本「${script.name}」包含无效分镜记录`);
    }
    const duration = Number(source.duration);
    return {
      id,
      duration: Number.isFinite(duration) && duration > 0 ? duration : null,
      prompt: typeof source.prompt === "string" ? source.prompt : "",
      src: typeof source.filePath === "string"
        ? source.filePath
        : typeof source.src === "string" ? source.src : null,
      state: typeof source.state === "string" ? source.state : "",
      reason: typeof source.reason === "string" ? source.reason : "",
      videoDesc: typeof source.videoDesc === "string" ? source.videoDesc : "",
      shouldGenerateImage: Number(source.shouldGenerateImage ?? 1),
      associateAssetsIds: Array.isArray(source.associateAssetsIds)
        ? source.associateAssetsIds
            .map(Number)
            .filter((assetId) => Number.isSafeInteger(assetId) && assetId > 0)
        : [],
      scriptId: script.id,
      scriptName: script.name,
    };
  });
}

export function normalizeStoryboardGenerationAcceptance(
  value: unknown,
  expectedId: number,
): StoryboardGenerationAcceptance {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error("分镜图片提交响应格式无效，未确认任务是否受理");
  }
  const source = value[0] && typeof value[0] === "object" && !Array.isArray(value[0])
    ? value[0] as Record<string, unknown>
    : null;
  const id = Number(source?.id);
  const state = typeof source?.state === "string" ? source.state.trim() : "";
  const imageTaskId = Number(source?.imageTaskId);
  if (
    !source
    || id !== expectedId
    || !state
    || !Number.isSafeInteger(imageTaskId)
    || imageTaskId <= 0
  ) {
    throw new Error("分镜图片提交响应与目标分镜不一致，未确认任务是否受理");
  }
  return { id, state, imageTaskId };
}

export function resolveStoryboardImageAttempt(
  current: StableSubmissionAttempt | null,
  projectId: number,
  scriptId: number,
  storyboardId: number,
  payload: unknown,
  randomId?: () => string,
): StableSubmissionAttempt {
  return resolveStableSubmissionAttempt(
    current,
    `storyboard-image:${projectId}:${scriptId}:${storyboardId}`,
    payload,
    randomId,
  );
}

function isStoryboardRunning(item: StoryboardItem): boolean {
  return ["生成中", "running", "排队中", "queued", "pending"]
    .includes(String(item.state || "").trim());
}

async function fetchStoryboardGroups(
  projectId: number,
  signal?: AbortSignal,
): Promise<StoryboardGroup[]> {
  const response = await apiPost<unknown>(
    "/script/getScrptApi",
    { projectId, name: "" },
    undefined,
    { signal },
  );
  const scripts = normalizeStoryboardScripts(response);
  return Promise.all(scripts.map(async (script) => {
    const value = await apiPost<unknown>(
      "/production/getStoryboardData",
      { projectId, scriptId: script.id },
      undefined,
      { signal },
    );
    return { script, storyboard: normalizeStoryboardItems(value, script) };
  }));
}

async function fetchStoryboardRuntime(
  projectId: number,
  signal?: AbortSignal,
): Promise<StoryboardRuntime> {
  const [groups, imageTasks] = await Promise.all([
    fetchStoryboardGroups(projectId, signal),
    fetchProjectImageTasks(STORYBOARD_IMAGE_TASK_API, projectId, signal),
  ]);
  return {
    groups,
    imageTasks: imageTasks.filter((task) => task.flow === "storyboard"),
  };
}

function formatSceneNumber(v: number) {
  const n = ["零","一","二","三","四","五","六","七","八","九","十"];
  if (v <= 10) return n[v];
  if (v < 20) return `十${n[v - 10]}`;
  return `${n[Math.floor(v/10)] || Math.floor(v/10)}十${v%10 ? n[v%10] : ""}`;
}

function getStateInfo(
  item: StoryboardItem,
  imageTask?: ProjectImageTask,
): { text: string; color: string; bg: string } {
  if (imageTask?.state === "pending_reconcile") {
    return { text: "待核对", color: "#9a650f", bg: "rgba(245,158,11,0.14)" };
  }
  if (imageTask?.state === "cancelled") {
    return { text: "已取消", color: "#71717a", bg: "rgba(120,120,128,0.12)" };
  }
  if (imageTask?.state === "failed") {
    return { text: "生成失败", color: "#c9352b", bg: "rgba(255,59,48,0.12)" };
  }
  if (imageTask && isProjectImageTaskActive(imageTask)) {
    return {
      text: projectImageTaskLabel(imageTask),
      color: imageTask.state === "queued" ? "#71717a" : "#5d94bd",
      bg: imageTask.state === "queued"
        ? "rgba(120,120,128,0.12)"
        : "rgba(93,148,189,0.12)",
    };
  }
  const state = String(item.state || "").trim();
  if (["已完成", "生成成功", "succeeded"].includes(state)) return { text: "已完成", color: "#16833a", bg: "rgba(52,199,89,0.14)" };
  if (["生成中", "running"].includes(state)) return { text: "生成中", color: "#5d94bd", bg: "rgba(93,148,189,0.12)" };
  if (["排队中", "queued", "pending"].includes(state)) return { text: "排队中", color: "#71717a", bg: "rgba(120,120,128,0.12)" };
  if (["生成失败", "failed", "cancelled"].includes(state)) return { text: "生成失败", color: "#c9352b", bg: "rgba(255,59,48,0.12)" };
  if (item.shouldGenerateImage === 0) return { text: "无需生成", color: "#71717a", bg: "rgba(120,120,128,0.12)" };
  if (!state || state === "未生成") return { text: "未生成", color: "#71717a", bg: "rgba(120,120,128,0.12)" };
  return { text: "状态未知", color: "#71717a", bg: "rgba(120,120,128,0.12)" };
}

function isCompleted(item: StoryboardItem): boolean {
  return ["已完成", "生成成功", "succeeded"].includes(String(item.state || "").trim());
}

function formatDuration(value?: number | null): string {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? `${value}s` : "未设置";
}

function cssAspectRatio(value?: string | null): string | undefined {
  const match = String(value || "").trim().match(/^(\d{1,3}):(\d{1,3})$/);
  return match ? `${match[1]} / ${match[2]}` : undefined;
}

async function storyboardObservationDigest(
  projectDigest: string,
  storyboardId: number,
): Promise<string | null> {
  if (!/^[a-f0-9]{64}$/.test(projectDigest) || !Number.isSafeInteger(storyboardId) || storyboardId <= 0) {
    return null;
  }
  const bytes = new TextEncoder().encode(
    `fanjin-storyboard-observation/v1\0${projectDigest}\0${storyboardId}`,
  );
  const digest = await globalThis.crypto?.subtle?.digest("SHA-256", bytes);
  return digest
    ? Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("")
    : null;
}

type StoryboardForm = {
  prompt: string;
  videoDesc: string;
  duration: number | null;
  shouldGenerateImage: boolean;
};

interface Props {
  showPreviousFlowAction?: boolean;
  showNextFlowAction?: boolean;
  onPreviousFlow?: () => void;
  onNextFlow?: () => void;
}

export default function StoryboardWorkbench({ showPreviousFlowAction, showNextFlowAction, onPreviousFlow, onNextFlow }: Props) {
  const currentProject = useProjectStore((s) => s.currentProject);
  const session = useSessionStore((state) => state.session);
  const saveSession = useSessionStore((state) => state.saveSession);
  const [planningDraft, setPlanningDraft] = useState<QuickCreateDirectorPlan | null>(null);
  const planSaveTimerRef = useRef<number | null>(null);
  const pendingPlanSaveRef = useRef<QuickCreateDirectorPlan | null>(null);
  const [scripts, setScripts] = useState<ScriptItem[]>([]);
  const [groups, setGroups] = useState<StoryboardGroup[]>([]);
  const [activeView, setActiveView] = useState<ViewMode>("list");
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [shotObservationDigests, setShotObservationDigests] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [generatingIds, setGeneratingIds] = useState<number[]>([]);
  const [queuedGenerationIds, setQueuedGenerationIds] = useState<number[]>([]);
  const [previewImage, setPreviewImage] = useState<{ src: string; label: string } | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [form, setForm] = useState<StoryboardForm>({ prompt: "", videoDesc: "", duration: 5, shouldGenerateImage: true });
  const [activeScriptId, setActiveScriptId] = useState<number | undefined>();
  const [pollError, setPollError] = useState("");
  const [taskNotice, setTaskNotice] = useState("");
  const [savingStoryboard, setSavingStoryboard] = useState(false);
  const [imageTasksByStoryboard, setImageTasksByStoryboard] = useState<
    Map<number, ProjectImageTask>
  >(() => new Map());
  const [deleteIntent, setDeleteIntent] = useState<StoryboardDeleteIntent | null>(null);
  const [deleteError, setDeleteError] = useState<StoryboardDeleteError | null>(null);
  const mountedRef = useRef(true);
  const contextEpochRef = useRef(0);
  const projectIdRef = useRef<number | null>(null);
  const loadRequestRef = useRef<AbortController | null>(null);
  const pollingRef = useRef<TaskPoller | null>(null);
  const generationAttemptsRef = useRef<Map<string, StoredSubmissionAttempt>>(new Map());
  const storyboardCreateAttemptRef = useRef<StableSubmissionAttempt | null>(null);
  const storyboardSaveInFlightRef = useRef(false);
  const deleteIntentRef = useRef<StoryboardDeleteIntent | null>(null);

  useEffect(() => {
    const value = session?.parameters?.directorPlan;
    setPlanningDraft(isDirectorPlan(value) ? value : null);
  }, [currentProject?.id, session?.id]);

  useEffect(() => () => {
    if (planSaveTimerRef.current !== null) window.clearTimeout(planSaveTimerRef.current);
    const pending = pendingPlanSaveRef.current;
    pendingPlanSaveRef.current = null;
    if (pending) {
      void useSessionStore.getState().saveSession({ parameters: { directorPlan: pending } });
    }
  }, []);

  function updatePlanningDraft(next: QuickCreateDirectorPlan) {
    setPlanningDraft(next);
    if (planSaveTimerRef.current !== null) window.clearTimeout(planSaveTimerRef.current);
    pendingPlanSaveRef.current = next;
    planSaveTimerRef.current = window.setTimeout(() => {
      planSaveTimerRef.current = null;
      pendingPlanSaveRef.current = null;
      void saveSession({ parameters: { directorPlan: next } }).catch((error) => {
        setActionError(error instanceof Error ? error.message : "分镜策划参数保存失败");
      });
    }, 400);
  }

  const storyboardList = useMemo(() => groups.flatMap((g) => g.storyboard), [groups]);
  const completedCount = useMemo(() => storyboardList.filter(isCompleted).length, [storyboardList]);
  const visibleSelectedCount = useMemo(() => {
    const visibleIds = new Set(storyboardList.flatMap((item) => item.id ? [item.id] : []));
    return selectedIds.filter((id) => visibleIds.has(id)).length;
  }, [selectedIds, storyboardList]);
  const imageGenerating = generatingIds.length > 0 || queuedGenerationIds.length > 0;
  const projectId = currentProject?.id ? Number(currentProject.id) : null;
  projectIdRef.current = projectId;
  const isStoryboardDeleteBlocked = useCallback((item: StoryboardItem): boolean => {
    const itemId = item.id || -1;
    const task = item.id ? imageTasksByStoryboard.get(item.id) : undefined;
    return generatingIds.includes(itemId)
      || queuedGenerationIds.includes(itemId)
      || isStoryboardRunning(item)
      || Boolean(task && isProjectImageTaskActive(task));
  }, [generatingIds, imageTasksByStoryboard, queuedGenerationIds]);
  const selectedDeleteBlocked = useMemo(() => {
    const selected = new Set(selectedIds);
    return storyboardList.some((item) => (
      Boolean(item.id && selected.has(item.id)) && isStoryboardDeleteBlocked(item)
    ));
  }, [isStoryboardDeleteBlocked, selectedIds, storyboardList]);

  useEffect(() => {
    let active = true;
    const projectDigest = String(currentProject?.correlationDigest || "").trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(projectDigest)) {
      setShotObservationDigests({});
      return () => { active = false; };
    }
    void Promise.all(storyboardList.flatMap((item) => item.id ? [[item.id, storyboardObservationDigest(projectDigest, item.id)] as const] : []))
      .then(async (entries) => {
        const resolved = await Promise.all(entries.map(async ([id, digest]) => [id, await digest] as const));
        if (!active) return;
        setShotObservationDigests(Object.fromEntries(
          resolved.filter((entry): entry is readonly [number, string] => Boolean(entry[1])),
        ));
      });
    return () => { active = false; };
  }, [currentProject?.correlationDigest, storyboardList]);

  const isCurrentContext = useCallback((expectedProjectId: number, expectedEpoch: number) => (
    mountedRef.current
    && projectIdRef.current === expectedProjectId
    && contextEpochRef.current === expectedEpoch
  ), []);

  const applyGroups = useCallback((next: StoryboardGroup[]) => {
    setScripts(next.map((group) => group.script));
    setGroups(next);
    setActiveScriptId((current) => (
      current && next.some((group) => group.script.id === current)
        ? current
        : next[0]?.script.id
    ));
    setSelectedIds((current) => current.filter((id) => (
      next.some((group) => group.storyboard.some((item) => item.id === id))
    )));
  }, []);

  const applyImageTasks = useCallback((
    expectedProjectId: number,
    tasks: ProjectImageTask[],
    nextGroups: StoryboardGroup[],
  ) => {
    const latest = latestProjectImageTasksByResource(tasks, "storyboard");
    setImageTasksByStoryboard(latest);
    nextGroups.forEach((group) => {
      group.storyboard.forEach((item) => {
        if (!item.id) return;
        const operationKey = `${expectedProjectId}:${group.script.id}:${item.id}`;
        const storageKey = submissionAttemptStorageKey("storyboard-image", operationKey);
        const task = latest.get(item.id);
        const stored = generationAttemptsRef.current.get(operationKey)
          || readStoredSubmissionAttempt(storageKey);
        if (task && isProjectImageTaskActive(task)) {
          if (stored) {
            const tracked = { ...stored, taskId: task.taskId };
            generationAttemptsRef.current.set(operationKey, tracked);
            writeStoredSubmissionAttempt(storageKey, tracked);
          }
          return;
        }
        if (task && stored?.taskId === task.taskId) {
          generationAttemptsRef.current.delete(operationKey);
          clearStoredSubmissionAttempt(storageKey);
        }
      });
    });
  }, []);

  const startStoryboardPolling = useCallback((expectedProjectId: number, expectedEpoch: number) => {
    if (!isCurrentContext(expectedProjectId, expectedEpoch)) return;
    pollingRef.current?.stop();
    const poller = createTaskPoller<StoryboardRuntime, number>({
      fetchTasks: () => fetchStoryboardRuntime(expectedProjectId),
      shouldContinue: (next) => (
        next.groups.some((group) => group.storyboard.some(isStoryboardRunning))
        || next.imageTasks.some(isProjectImageTaskActive)
      ),
      onData: (next) => {
        if (!isCurrentContext(expectedProjectId, expectedEpoch)) return;
        applyGroups(next.groups);
        applyImageTasks(expectedProjectId, next.imageTasks, next.groups);
        setLoadError("");
        setPollError("");
        if (
          !next.groups.some((group) => group.storyboard.some(isStoryboardRunning))
          && !next.imageTasks.some(isProjectImageTaskActive)
        ) {
          pollingRef.current?.stop();
          pollingRef.current = null;
        }
      },
      onState: () => undefined,
      onError: (error, kind) => {
        if (!isCurrentContext(expectedProjectId, expectedEpoch)) return;
        const message = error instanceof Error ? error.message : "分镜状态同步失败";
        setPollError(
          kind === "retry" || kind === "rate_limit"
            ? `分镜状态同步暂时失败，正在自动重连：${message}`
            : message,
        );
      },
      schedule: (callback, delay) => window.setTimeout(callback, delay),
      cancelSchedule: (handle) => window.clearTimeout(handle),
      isVisible: () => typeof document === "undefined" || document.visibilityState !== "hidden",
    });
    pollingRef.current = poller;
    void poller.refresh();
  }, [applyGroups, applyImageTasks, isCurrentContext]);

  const loadGroups = useCallback(async (options: { background?: boolean } = {}) => {
    if (!projectId || projectIdRef.current !== projectId) return;
    const expectedEpoch = contextEpochRef.current;
    loadRequestRef.current?.abort();
    const controller = new AbortController();
    loadRequestRef.current = controller;
    if (!options.background) {
      setLoading(true);
      setLoadError("");
    }
    try {
      const next = await fetchStoryboardRuntime(projectId, controller.signal);
      if (!isCurrentContext(projectId, expectedEpoch) || controller.signal.aborted) return;
      applyGroups(next.groups);
      applyImageTasks(projectId, next.imageTasks, next.groups);
      setLoadError("");
      if (options.background) setPollError("");
      if (
        next.groups.some((group) => group.storyboard.some(isStoryboardRunning))
        || next.imageTasks.some(isProjectImageTaskActive)
      ) {
        startStoryboardPolling(projectId, expectedEpoch);
      } else {
        pollingRef.current?.stop();
        pollingRef.current = null;
      }
    } catch (error) {
      if (!isCurrentContext(projectId, expectedEpoch) || controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : "分镜数据读取失败";
      if (options.background) {
        setPollError(`分镜列表后台刷新失败：${message}`);
      } else {
        setLoadError(message);
      }
    } finally {
      if (loadRequestRef.current === controller) loadRequestRef.current = null;
      if (!options.background && isCurrentContext(projectId, expectedEpoch) && !controller.signal.aborted) {
        setLoading(false);
      }
    }
  }, [applyGroups, applyImageTasks, isCurrentContext, projectId, startStoryboardPolling]);

  useEffect(() => {
    contextEpochRef.current += 1;
    projectIdRef.current = projectId;
    loadRequestRef.current?.abort();
    pollingRef.current?.stop();
    pollingRef.current = null;
    generationAttemptsRef.current.clear();
    storyboardCreateAttemptRef.current = null;
    storyboardSaveInFlightRef.current = false;
    setScripts([]);
    setGroups([]);
    setImageTasksByStoryboard(new Map());
    setSelectedIds([]);
    setGeneratingIds([]);
    setQueuedGenerationIds([]);
    setLoading(false);
    setLoadError("");
    setActionError("");
    setPollError("");
    setTaskNotice("");
    setSavingStoryboard(false);
    deleteIntentRef.current = null;
    setDeleteIntent(null);
    setDeleteError(null);
    return () => {
      contextEpochRef.current += 1;
      loadRequestRef.current?.abort();
      pollingRef.current?.stop();
      pollingRef.current = null;
    };
  }, [projectId]);

  useEffect(() => {
    if (projectId) void loadGroups();
  }, [loadGroups, projectId]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      void pollingRef.current?.setVisible(document.visibilityState !== "hidden");
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);

  useEffect(() => {
    if (!previewImage) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPreviewImage(null);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [previewImage]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      loadRequestRef.current?.abort();
      pollingRef.current?.stop();
    };
  }, []);

  async function submitStoryboardImage(
    item: StoryboardItem,
    expectedProjectId: number,
    expectedEpoch: number,
  ): Promise<number> {
    if (!item.id || !item.scriptId) throw new Error("分镜缺少有效 ID 或剧本关联");
    const operationKey = `${expectedProjectId}:${item.scriptId}:${item.id}`;
    const storageKey = submissionAttemptStorageKey("storyboard-image", operationKey);
    const latestTask = imageTasksByStoryboard.get(item.id);
    const itemState = String(item.state || "").trim();
    if (
      (latestTask && !isProjectImageTaskActive(latestTask))
      || ["生成失败", "failed", "已取消", "cancelled", "已完成", "生成成功", "succeeded"].includes(itemState)
    ) {
      generationAttemptsRef.current.delete(operationKey);
      clearStoredSubmissionAttempt(storageKey);
    }
    const payload = {
      scriptId: item.scriptId,
      projectId: expectedProjectId,
      storyboardIds: [item.id],
      concurrentCount: 1,
      compulsory: true,
    };
    const attempt = resolveStoryboardImageAttempt(
      generationAttemptsRef.current.get(operationKey)
        || readStoredSubmissionAttempt(storageKey),
      expectedProjectId,
      item.scriptId,
      item.id,
      {
        ...payload,
        prompt: item.prompt || "",
        videoDesc: item.videoDesc || "",
        associateAssetsIds: item.associateAssetsIds || [],
      },
    );
    generationAttemptsRef.current.set(operationKey, attempt);
    writeStoredSubmissionAttempt(storageKey, attempt);
    if (isCurrentContext(expectedProjectId, expectedEpoch)) {
      setGeneratingIds((current) => [...new Set([...current, item.id!])]);
    }
    try {
      const response = await apiPost<unknown>(
        "/production/storyboard/batchGenerateImage",
        payload,
        undefined,
        { headers: { "Idempotency-Key": attempt.idempotencyKey } },
      );
      const accepted = normalizeStoryboardGenerationAcceptance(response, item.id);
      const trackedAttempt = { ...attempt, taskId: accepted.imageTaskId };
      generationAttemptsRef.current.set(operationKey, trackedAttempt);
      writeStoredSubmissionAttempt(storageKey, trackedAttempt);
      if (isCurrentContext(expectedProjectId, expectedEpoch)) {
        setGroups((current) => current.map((group) => ({
          ...group,
          storyboard: group.storyboard.map((row) => (
            row.id === item.id ? { ...row, state: accepted.state, reason: "" } : row
          )),
        })));
      }
      return item.id;
    } catch (error) {
      if (
        !shouldRetainProjectImageAttempt(error)
        && generationAttemptsRef.current.get(operationKey) === attempt
      ) {
        generationAttemptsRef.current.delete(operationKey);
        clearStoredSubmissionAttempt(storageKey);
      } else if (isCurrentContext(expectedProjectId, expectedEpoch)) {
        startStoryboardPolling(expectedProjectId, expectedEpoch);
      }
      throw error;
    } finally {
      if (isCurrentContext(expectedProjectId, expectedEpoch)) {
        setGeneratingIds((current) => current.filter((id) => id !== item.id));
      }
    }
  }

  async function generateImages(ids: number[]) {
    if (!projectId || !ids.length) return;
    const expectedEpoch = contextEpochRef.current;
    const requested = storyboardList.filter((item) => {
      const task = item.id ? imageTasksByStoryboard.get(item.id) : undefined;
      return Boolean(
        item.id
        && ids.includes(item.id)
        && !generatingIds.includes(item.id)
        && !isStoryboardRunning(item)
        && !(task && isProjectImageTaskActive(task)),
      );
    });
    if (!requested.length) return;
    setActionError("");
    setTaskNotice("");
    setQueuedGenerationIds(requested.map((item) => item.id!));
    const settled = await settleItemBatch(requested, async (item) => {
      if (isCurrentContext(projectId, expectedEpoch)) {
        setQueuedGenerationIds((current) => current.filter((id) => id !== item.id));
      }
      return submitStoryboardImage(item, projectId, expectedEpoch);
    }, 1);
    if (!isCurrentContext(projectId, expectedEpoch)) return;
    setQueuedGenerationIds([]);
    const { succeededIds, failures } = summarizeItemBatch(
      requested,
      settled,
      (item) => `分镜 ${item.id}`,
    );
    setSelectedIds((current) => retainUnsuccessfulSelection(current, succeededIds));
    if (failures.length) {
      setActionError(`${succeededIds.length} 条已受理，${failures.length} 条未确认；失败项已保留选择，可直接重试。${failures.join("；")}`);
    }
    if (succeededIds.length) startStoryboardPolling(projectId, expectedEpoch);
  }

  async function cancelStoryboardImage(item: StoryboardItem) {
    if (!projectId || !item.id || !item.scriptId) return;
    const task = imageTasksByStoryboard.get(item.id);
    if (!task || !isProjectImageTaskActive(task)) return;
    const expectedEpoch = contextEpochRef.current;
    setActionError("");
    setTaskNotice("");
    pollingRef.current?.stop();
    pollingRef.current = null;
    try {
      const result = await cancelProjectImageTask(
        STORYBOARD_IMAGE_TASK_API,
        projectId,
        task.taskId,
      );
      if (!isCurrentContext(projectId, expectedEpoch)) return;
      setImageTasksByStoryboard((current) => {
        const next = new Map(current);
        next.set(item.id!, result.task);
        return next;
      });
      if (result.cancelled) {
        const operationKey = `${projectId}:${item.scriptId}:${item.id}`;
        generationAttemptsRef.current.delete(operationKey);
        clearStoredSubmissionAttempt(
          submissionAttemptStorageKey("storyboard-image", operationKey),
        );
        setTaskNotice(`分镜 ${item.id} 已在派发上游前取消。`);
      } else if (result.task.state === "pending_reconcile") {
        setTaskNotice(
          `分镜 ${item.id} 已派发上游，无法安全撤回；任务正在待核对，系统不会伪报取消成功。`,
        );
      } else {
        setTaskNotice(`分镜 ${item.id} 已越过可取消阶段，正在保存结果。`);
      }
      await loadGroups();
    } catch (error) {
      if (!isCurrentContext(projectId, expectedEpoch)) return;
      setActionError(error instanceof Error ? error.message : "分镜图片任务取消失败");
      startStoryboardPolling(projectId, expectedEpoch);
    }
  }

  async function submitStoryboard() {
    if (
      !currentProject?.id
      || !activeScriptId
      || savingStoryboard
      || storyboardSaveInFlightRef.current
    ) return;
    const prompt = form.prompt.trim();
    const videoDesc = form.videoDesc.trim();
    const duration = Number(form.duration);
    if ((!prompt && !videoDesc) || !Number.isFinite(duration) || duration <= 0) return;
    storyboardSaveInFlightRef.current = true;
    setSavingStoryboard(true);
    setActionError("");
    let createStorageKey = "";
    let createAttempt: StableSubmissionAttempt | null = null;
    try {
      if (editId) {
        await apiPost("/production/storyboard/editStoryboardInfo", { id: editId, prompt, videoDesc, duration, shouldGenerateImage: form.shouldGenerateImage ? 1 : 0 });
      } else {
        const payload = {
          prompt: prompt || videoDesc, videoDesc: videoDesc || prompt, duration,
          state: "未生成", shouldGenerateImage: form.shouldGenerateImage ? 1 : 0, src: null,
          track: scripts.find((s) => s.id === activeScriptId)?.name || "", scriptId: activeScriptId, projectId: Number(currentProject.id),
        };
        const prepared = prepareStoredSubmissionAttempt({
          current: storyboardCreateAttemptRef.current,
          flow: "storyboard-create",
          operationKey: `${currentProject.id}:${activeScriptId}`,
          prefix: `storyboard-create:${currentProject.id}:${activeScriptId}`,
          payload,
        });
        createAttempt = prepared.attempt;
        createStorageKey = prepared.storageKey;
        storyboardCreateAttemptRef.current = createAttempt;
        await apiPost(
          "/production/storyboard/addStoryboard",
          payload,
          undefined,
          { headers: { "Idempotency-Key": createAttempt.idempotencyKey } },
        );
        clearStoredSubmissionAttempt(createStorageKey);
        if (
          storyboardCreateAttemptRef.current?.idempotencyKey
          === createAttempt.idempotencyKey
        ) {
          storyboardCreateAttemptRef.current = null;
        }
      }
      setDialogOpen(false);
      await loadGroups();
    } catch (error) {
      if (
        createAttempt
        && !shouldRetainStoredSubmissionAttempt(error)
        && storyboardCreateAttemptRef.current?.idempotencyKey
          === createAttempt.idempotencyKey
      ) {
        clearStoredSubmissionAttempt(createStorageKey);
        storyboardCreateAttemptRef.current = null;
      }
      setActionError(error instanceof Error ? error.message : "分镜保存失败");
    } finally {
      storyboardSaveInFlightRef.current = false;
      setSavingStoryboard(false);
    }
  }

  function openCreate() {
    setEditId(null);
    setForm({ prompt: "", videoDesc: "", duration: 5, shouldGenerateImage: true });
    setDialogOpen(true);
  }
  function openCreateForScript(scriptId: number) {
    setActiveScriptId(scriptId);
    openCreate();
  }
  function openEdit(item: StoryboardItem) {
    setEditId(item.id ?? null);
    setForm({ prompt: item.prompt || "", videoDesc: item.videoDesc || "", duration: item.duration ?? null, shouldGenerateImage: item.shouldGenerateImage !== 0 });
    setDialogOpen(true);
  }
  function toggleSelect(id: number) { setSelectedIds((p) => p.includes(id) ? p.filter((x) => x !== id) : [...p, id]); }
  function toggleAll(checked: boolean) { setSelectedIds(checked ? storyboardList.map((i) => i.id!).filter(Boolean) : []); }

  function openDelete(ids: number[]) {
    if (!projectId) return;
    const requested = new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0));
    const targets = storyboardList.filter((item) => Boolean(item.id && requested.has(item.id)));
    if (!targets.length || targets.some(isStoryboardDeleteBlocked)) return;
    const targetIds = Array.from(new Set(targets.map((item) => item.id!)))
      .sort((left, right) => left - right);
    const payload = { projectId, ids: targetIds };
    const attempt = resolveStableSubmissionAttempt(
      null,
      `storyboard-delete:${projectId}`,
      payload,
    );
    const nextIntent = {
      projectId,
      ids: targetIds,
      label: targetIds.length === 1 ? `分镜 ${targetIds[0]}` : `${targetIds.length} 条分镜`,
      intentToken: crypto.randomUUID(),
      idempotencyKey: attempt.idempotencyKey,
    };
    deleteIntentRef.current = nextIntent;
    setDeleteError(null);
    setDeleteIntent(nextIntent);
  }

  function isCurrentDeleteIntent(
    intent: StoryboardDeleteIntent | null,
  ): intent is StoryboardDeleteIntent {
    return Boolean(
      intent
      && deleteIntentRef.current?.intentToken === intent.intentToken
      && deleteIntentRef.current.projectId === intent.projectId
      && projectIdRef.current === intent.projectId,
    );
  }

  function closeDeleteIntent(intentToken: string) {
    if (deleteIntentRef.current?.intentToken !== intentToken) return;
    deleteIntentRef.current = null;
    setDeleteIntent((current) => current?.intentToken === intentToken ? null : current);
    setDeleteError((current) => current?.intentToken === intentToken ? null : current);
  }

  function reportDeleteError(intent: StoryboardDeleteIntent | null, error: unknown) {
    if (!isCurrentDeleteIntent(intent)) return;
    setDeleteError({
      intentToken: intent.intentToken,
      message: error instanceof Error ? error.message : "分镜删除失败",
    });
  }

  async function confirmDeleteStoryboards(intent: StoryboardDeleteIntent | null) {
    if (!isCurrentDeleteIntent(intent)) return false;
    await apiPost(
      "/production/storyboard/batchDelete",
      { projectId: intent.projectId, ids: intent.ids },
      undefined,
      { headers: { "Idempotency-Key": intent.idempotencyKey } },
    );
    if (!isCurrentDeleteIntent(intent)) return false;
    const deletedIds = new Set(intent.ids);
    setGroups((current) => projectIdRef.current === intent.projectId
      ? current.map((group) => ({
          ...group,
          storyboard: group.storyboard.filter((item) => !item.id || !deletedIds.has(item.id)),
        }))
      : current);
    setSelectedIds((current) => projectIdRef.current === intent.projectId
      ? current.filter((id) => !deletedIds.has(id))
      : current);
    setGeneratingIds((current) => projectIdRef.current === intent.projectId
      ? current.filter((id) => !deletedIds.has(id))
      : current);
    setImageTasksByStoryboard((current) => {
      if (projectIdRef.current !== intent.projectId) return current;
      const next = new Map(current);
      deletedIds.forEach((id) => next.delete(id));
      return next;
    });
    void loadGroups({ background: true });
    return true;
  }

  return (
    <div
      data-testid="quick-storyboard-page"
      data-active-view={activeView}
      data-shot-count={storyboardList.length}
      data-visible-shot-count={storyboardList.length}
      data-selected-shot-count={visibleSelectedCount}
      data-completed-shot-count={completedCount}
      data-project-type={currentProject?.projectType || currentProject?.type || undefined}
      data-project-ratio={currentProject?.videoRatio || undefined}
      data-project-correlation-digest={currentProject?.correlationDigest || undefined}
      style={{ height: "100%", minHeight: 0, display: "flex", flexDirection: "column", color: "#18181b" }}
    >
      {planningDraft ? (
        <details data-testid="quick-storyboard-planning" style={{ marginBottom: 12 }}>
          <summary style={{ cursor: "pointer", fontWeight: 760, padding: "10px 4px" }}>
            快速模式分镜策划（{planningDraft.shots.length} 镜头）
          </summary>
          <DirectorShotEditor value={planningDraft} onChange={updatePlanningDraft} />
        </details>
      ) : null}
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", gap: 14, padding: "14px 16px", border: "1px solid #e4e4e7", borderRadius: "12px 12px 0 0", background: "rgba(255,255,255,0.95)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          {(["list", "board", "timeline"] as ViewMode[]).map((m) => (
            <button key={m} data-testid={`quick-storyboard-view-${m}`} data-active={activeView === m ? "true" : "false"} aria-pressed={activeView === m} onClick={() => setActiveView(m)} style={{ height: 34, padding: "0 4px", border: 0, borderBottom: activeView === m ? "3px solid #5d94bd" : "3px solid transparent", background: "transparent", color: activeView === m ? "#18181b" : "#71717a", cursor: "pointer", fontSize: 15, fontWeight: 760 }}>
              {m === "list" ? "分镜列表" : m === "board" ? "故事板" : "时间线"}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {showPreviousFlowAction && <button onClick={onPreviousFlow} style={{ padding: "6px 14px", border: "1px solid #e4e4e7", borderRadius: 8, background: "#fff", cursor: "pointer", fontSize: 13 }}>上一步</button>}
          {showNextFlowAction && <button onClick={onNextFlow} style={{ padding: "6px 14px", border: "none", borderRadius: 8, background: "#5d94bd", color: "#fff", cursor: "pointer", fontSize: 13 }}>下一步</button>}
        </div>
      </div>

      {/* Meta */}
      <div style={{ display: "flex", alignItems: "center", gap: 16, padding: "10px 16px", border: "1px solid #e4e4e7", borderTop: 0, background: "rgba(255,255,255,0.82)", color: "#71717a", fontSize: 12 }}>
        <span>共 {scripts.length} 场</span>
        <span>共 {storyboardList.length} 条分镜</span>
        <span>已完成 {completedCount} 条</span>
      </div>

      {actionError ? <div role="alert" style={{ padding: "10px 16px", border: "1px solid #efb4ae", borderTop: 0, color: "#9f231b", background: "#fff7f6", fontSize: 12 }}>{actionError}</div> : null}
      {pollError ? <div role="alert" style={{ padding: "8px 16px", border: "1px solid #efcf93", borderTop: 0, color: "#7a5312", background: "#fffaf0", fontSize: 12 }}>{pollError}</div> : null}
      {taskNotice ? <div role="status" style={{ padding: "8px 16px", border: "1px solid #efcf93", borderTop: 0, color: "#7a5312", background: "#fffaf0", fontSize: 12 }}>{taskNotice}</div> : null}
      {(imageGenerating
        || storyboardList.some(isStoryboardRunning)
        || [...imageTasksByStoryboard.values()].some(isProjectImageTaskActive)) ? (
        <div role="status" style={{ padding: "8px 16px", border: "1px solid #c7dff2", borderTop: 0, color: "#315d7c", background: "#f4f9fd", fontSize: 12 }}>
          分镜图片任务已持久化；刷新后会恢复同一任务和提交凭据。派发前可以取消，派发后只会标记为“待核对”，不会伪报取消成功。
        </div>
      ) : null}

      {loadError ? (
        <div style={{ flex: 1, display: "grid", placeItems: "center", padding: 60, color: "#9f231b" }}>
          <div style={{ display: "grid", justifyItems: "center", gap: 12, textAlign: "center" }}>
            <strong>分镜数据加载失败</strong>
            <span>{loadError}</span>
            <button type="button" onClick={() => void loadGroups()} style={{ padding: "8px 18px", border: 0, borderRadius: 8, background: "#5d94bd", color: "#fff", cursor: "pointer" }}>重试</button>
          </div>
        </div>
      ) : !scripts.length && !loading ? (
        <div style={{ flex: 1, display: "grid", placeItems: "center", padding: 60, color: "#71717a" }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>暂无剧本场次</div>
            <div style={{ fontSize: 13, color: "#a1a1aa" }}>请先在脚本中创建或导入剧本</div>
          </div>
        </div>
      ) : activeView === "list" ? (
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", border: "1px solid #e4e4e7", borderTop: 0, borderRadius: "0 0 12px 12px", background: "#fff", overflow: "hidden" }}>
          <div style={{ flex: "0 0 auto", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "10px 16px", borderBottom: "1px solid #e4e4e7" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, color: "#71717a", fontSize: 13, cursor: "pointer" }}>
              <input type="checkbox" checked={storyboardList.length > 0 && selectedIds.length === storyboardList.length} onChange={(e) => toggleAll(e.target.checked)} /> 全选
            </label>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => setSelectedIds([])} disabled={!selectedIds.length} style={{ padding: "4px 12px", border: "1px solid #e4e4e7", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 12, opacity: selectedIds.length ? 1 : 0.4 }}>取消选择</button>
              <button
                type="button"
                aria-label="删除所选分镜"
                onClick={() => openDelete(selectedIds)}
                disabled={!selectedIds.length || selectedDeleteBlocked}
                style={{ padding: "4px 12px", border: "1px solid #efb4ae", borderRadius: 6, background: "#fff7f6", color: "#9f231b", cursor: "pointer", fontSize: 12, opacity: selectedIds.length && !selectedDeleteBlocked ? 1 : 0.4 }}
              >批量删除</button>
              <button data-testid="quick-storyboard-generate-image" onClick={() => void generateImages(selectedIds)} disabled={!selectedIds.length || imageGenerating} style={{ padding: "4px 12px", border: "none", borderRadius: 6, background: "#5d94bd", color: "#fff", cursor: "pointer", fontSize: 12, opacity: selectedIds.length && !imageGenerating ? 1 : 0.4 }}>{imageGenerating ? "提交中…" : "批量生成图片"}</button>
            </div>
          </div>
          <div style={{ flex: 1, overflow: "auto" }}>
            <div style={{ display: "grid", gridTemplateColumns: "100px 140px 1fr 70px 80px 100px 150px", alignItems: "center", gap: 12, padding: "10px 16px", color: "#71717a", fontSize: 12, fontWeight: 720, background: "rgba(249,250,252,0.9)", borderBottom: "1px solid #e4e4e7" }}>
              <span>镜头</span><span>画面</span><span>画面/提示词</span><span>时长</span><span>比例</span><span>状态</span><span style={{ textAlign: "center" }}>操作</span>
            </div>
            {groups.map((group, gi) => (
              <React.Fragment key={group.script.id}>
                <div style={{ padding: "10px 16px", borderBottom: "1px solid #e4e4e7", background: "rgba(249,250,252,0.72)", fontSize: 13, color: "#71717a", fontWeight: 680, display: "flex", alignItems: "center", gap: 12 }}>
                  <span>第{formatSceneNumber(gi + 1)}场 {group.script.name}</span>
                  <button onClick={() => openCreateForScript(group.script.id)} style={{ padding: "3px 10px", border: "1px solid #e4e4e7", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 11 }}>新增本场分镜</button>
                  <small>共 {group.storyboard.length} 条 · 已完成 {group.storyboard.filter(isCompleted).length} 条</small>
                </div>
                {!group.storyboard.length && (
                  <div role="status" style={{ minHeight: 132, display: "flex", alignItems: "center", justifyContent: "center", gap: 18, padding: "22px 24px", borderBottom: "1px solid #e4e4e7", background: "linear-gradient(135deg, rgba(93,148,189,0.07), rgba(255,255,255,0.96))" }}>
                    <div style={{ display: "grid", gap: 5 }}>
                      <strong style={{ color: "#18181b", fontSize: 14 }}>已关联剧本「{group.script.name}」</strong>
                      <span style={{ color: "#71717a", fontSize: 12 }}>本场还没有分镜，创建第一条后即可继续生成画面和视频。</span>
                    </div>
                    <button onClick={() => openCreateForScript(group.script.id)} style={{ flex: "0 0 auto", padding: "8px 14px", border: 0, borderRadius: 8, background: "#5d94bd", color: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 720 }}>创建第一条分镜</button>
                  </div>
                )}
                {group.storyboard.map((item, idx) => {
                  const task = item.id
                    ? imageTasksByStoryboard.get(item.id)
                    : undefined;
                  const taskActive = Boolean(task && isProjectImageTaskActive(task));
                  const st = getStateInfo(item, task);
                  const submitting = generatingIds.includes(item.id || -1);
                  const locallyQueued = queuedGenerationIds.includes(item.id || -1);
                  const reason = submitting || locallyQueued ? "" : task?.reason || item.reason || "";
                  return (
                    <div data-testid="quick-storyboard-row" data-selected={item.id && selectedIds.includes(item.id) ? "true" : "false"} data-shot-correlation-digest={item.id ? shotObservationDigests[item.id] : undefined} key={item.id ?? `${group.script.id}-${idx}`} style={{ display: "grid", gridTemplateColumns: "100px 140px 1fr 70px 80px 100px 150px", alignItems: "center", gap: 12, padding: "14px 16px", borderBottom: "1px solid #e4e4e7", background: "#fff" }}>
                      <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <input type="checkbox" checked={item.id ? selectedIds.includes(item.id) : false} onChange={() => item.id && toggleSelect(item.id)} disabled={!item.id} />
                        <strong style={{ fontSize: 18, fontWeight: 780 }}>{String(idx + 1).padStart(2, "0")}</strong>
                      </span>
                      <span style={{ width: 130, height: 72, borderRadius: 8, overflow: "hidden", background: "#eef0f4", display: "flex", alignItems: "center", justifyContent: "center" }}>
                        {item.src ? (
                          <button
                            type="button"
                            aria-label={`预览分镜 ${item.id}`}
                            title="点击放大预览"
                            onClick={() => setPreviewImage({ src: item.src!, label: item.videoDesc || item.prompt || `分镜 ${item.id}` })}
                            style={{ position: "relative", width: "100%", height: "100%", padding: 0, border: 0, background: "transparent", cursor: "zoom-in" }}
                          >
                            <img data-testid="quick-storyboard-image" src={item.src} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                            <ZoomIn size={16} aria-hidden="true" style={{ position: "absolute", right: 6, bottom: 6, padding: 3, boxSizing: "content-box", borderRadius: 5, color: "#fff", background: "rgba(0,0,0,0.58)" }} />
                          </button>
                        ) : <span style={{ color: "#a1a1aa", fontSize: 12 }}>{item.state === "生成中" ? "生成中…" : "无"}</span>}
                      </span>
                      <span style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 14, fontWeight: 760, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{(item.videoDesc || item.prompt || "").slice(0, 14) || `分镜 ${idx + 1}`}</div>
                        <div style={{ fontSize: 12, color: "#71717a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 3 }}>{item.videoDesc || item.prompt || "暂无画面描述"}</div>
                      </span>
                      <span style={{ fontSize: 13 }}>{formatDuration(item.duration)}</span>
                      <span style={{ fontSize: 12, color: "#71717a" }}>{currentProject?.videoRatio || "未配置"}</span>
                      <span title={reason || undefined}>
                        <em style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", minWidth: 64, height: 24, padding: "0 10px", borderRadius: 7, fontSize: 12, fontStyle: "normal", fontWeight: 760, color: st.color, background: st.bg }}>
                          {submitting ? "生成中" : locallyQueued ? "排队中" : st.text}
                        </em>
                        {reason ? <small style={{ display: "block", marginTop: 3, color: task?.state === "pending_reconcile" ? "#9a650f" : "#c9352b", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{reason}</small> : null}
                      </span>
                      <span style={{ display: "flex", gap: 4, justifyContent: "center" }}>
                        <button
                          aria-label={`${isCompleted(item) ? "重新生成" : "生成"}分镜 ${item.id}`}
                          title={isCompleted(item) ? "重新生成图片" : "生成图片"}
                          onClick={() => item.id && void generateImages([item.id])}
                          disabled={submitting || locallyQueued || isStoryboardRunning(item) || taskActive}
                          style={{ width: 28, height: 28, border: "1px solid #e4e4e7", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 14 }}
                        >▶</button>
                        {taskActive ? (
                          <button
                            aria-label={`取消分镜 ${item.id} 图片任务`}
                            title={
                              task?.state === "pending_reconcile"
                                ? "已派发上游，正在待核对，不能伪取消"
                                : task?.phase === "provider_succeeded"
                                  ? "上游已完成，正在保存结果"
                                  : task?.cancelAllowed
                                    ? "在派发上游前取消"
                                    : "请求停止；若已派发将转为待核对"
                            }
                            onClick={() => void cancelStoryboardImage(item)}
                            disabled={
                              task?.state === "pending_reconcile"
                              || task?.phase === "provider_succeeded"
                            }
                            style={{ width: 28, height: 28, border: "1px solid #efcf93", borderRadius: 6, background: "#fffaf0", color: "#9a650f", cursor: "pointer", fontSize: 13 }}
                          >■</button>
                        ) : null}
                        <button onClick={() => openEdit(item)} disabled={taskActive} style={{ width: 28, height: 28, border: "1px solid #e4e4e7", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 14 }}>✎</button>
                        <button
                          type="button"
                          aria-label={`删除分镜 ${item.id}`}
                          title={isStoryboardDeleteBlocked(item) ? "生成中的分镜不可删除" : "删除分镜"}
                          onClick={() => item.id && openDelete([item.id])}
                          disabled={!item.id || isStoryboardDeleteBlocked(item)}
                          style={{ width: 42, height: 28, border: "1px solid #efb4ae", borderRadius: 6, background: "#fff7f6", color: "#9f231b", cursor: "pointer", fontSize: 11, fontWeight: 700 }}
                        >删除</button>
                      </span>
                    </div>
                  );
                })}
                {group.storyboard.length > 0 && (
                  <button onClick={() => openCreateForScript(group.script.id)} style={{ width: "100%", height: 52, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, border: 0, background: "#fff", color: "#71717a", cursor: "pointer", fontSize: 14, fontWeight: 720, borderBottom: "1px solid #e4e4e7" }}>
                    <span style={{ fontSize: 18 }}>+</span> 新增分镜
                  </button>
                )}
              </React.Fragment>
            ))}
          </div>
        </div>
      ) : activeView === "board" ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12, padding: 14, border: "1px solid #e4e4e7", borderRadius: "0 0 12px 12px", background: "#fff", overflow: "auto" }}>
          {groups.map((group, gi) => (
            <React.Fragment key={group.script.id}>
              <div style={{ gridColumn: "1 / -1", color: "#71717a", fontSize: 13, fontWeight: 680 }}>第{formatSceneNumber(gi + 1)}场 {group.script.name}</div>
              {group.storyboard.map((item, idx) => (
                <div data-testid="quick-storyboard-board-card" data-selected={item.id && selectedIds.includes(item.id) ? "true" : "false"} data-shot-correlation-digest={item.id ? shotObservationDigests[item.id] : undefined} key={item.id ?? idx} onClick={() => item.id && toggleSelect(item.id)} style={{ display: "grid", gap: 8, padding: 10, border: "1px solid #e4e4e7", borderRadius: 10, cursor: "pointer" }}>
                  <div style={{ aspectRatio: cssAspectRatio(currentProject?.videoRatio), display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 8, overflow: "hidden", background: "#eef0f4", color: "#a1a1aa" }}>
                    {item.src ? <img src={item.src} alt="" onClick={(event) => { event.stopPropagation(); setPreviewImage({ src: item.src!, label: item.videoDesc || item.prompt || `分镜 ${item.id}` }); }} style={{ width: "100%", height: "100%", objectFit: "cover", cursor: "zoom-in" }} /> : getStateInfo(
                      item,
                      item.id ? imageTasksByStoryboard.get(item.id) : undefined,
                    ).text}
                  </div>
                  <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{String(idx + 1).padStart(2, "0")} {(item.videoDesc || item.prompt || "").slice(0, 12)}</strong>
                  <small style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#71717a" }}>{item.videoDesc || item.prompt || "暂无画面描述"}</small>
                </div>
              ))}
            </React.Fragment>
          ))}
        </div>
      ) : (
        <div style={{ display: "flex", gap: 10, padding: 18, border: "1px solid #e4e4e7", borderRadius: "0 0 12px 12px", background: "#fff", overflowX: "auto" }}>
          {groups.map((group, gi) => (
            <React.Fragment key={group.script.id}>
              <div style={{ minWidth: 120, display: "flex", alignItems: "center", color: "#71717a", fontSize: 13, fontWeight: 680 }}>第{formatSceneNumber(gi + 1)}场 {group.script.name}</div>
              {group.storyboard.map((item, idx) => (
                <div data-testid="quick-storyboard-timeline-card" data-selected={item.id && selectedIds.includes(item.id) ? "true" : "false"} data-shot-correlation-digest={item.id ? shotObservationDigests[item.id] : undefined} key={item.id ?? idx} onClick={() => item.id && toggleSelect(item.id)} style={{ minWidth: 150, display: "grid", gap: 6, padding: 12, border: "1px solid #e4e4e7", borderRadius: 10, background: "rgba(248,249,252,0.85)", cursor: item.id ? "pointer" : "default" }}>
                  <span style={{ color: "#5d94bd", fontWeight: 780 }}>{String(idx + 1).padStart(2, "0")}</span>
                  <strong>{formatDuration(item.duration)}</strong>
                  <small style={{ overflow: "hidden", color: "#71717a", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{(item.videoDesc || item.prompt || "").slice(0, 12)}</small>
                </div>
              ))}
            </React.Fragment>
          ))}
        </div>
      )}

      {/* Dialog */}
      {previewImage ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="分镜图片预览"
          onClick={() => setPreviewImage(null)}
          style={{ position: "fixed", inset: 0, zIndex: 11000, display: "grid", placeItems: "center", padding: 24, background: "rgba(0,0,0,0.78)" }}
        >
          <button type="button" aria-label="关闭图片预览" title="关闭" onClick={() => setPreviewImage(null)} style={{ position: "fixed", top: 20, right: 20, width: 40, height: 40, display: "grid", placeItems: "center", border: "1px solid rgba(255,255,255,0.35)", borderRadius: 6, color: "#fff", background: "rgba(0,0,0,0.45)", cursor: "pointer" }}><X size={22} /></button>
          <img src={previewImage.src} alt={previewImage.label} onClick={(event) => event.stopPropagation()} style={{ maxWidth: "calc(100vw - 48px)", maxHeight: "calc(100vh - 48px)", objectFit: "contain", borderRadius: 6, boxShadow: "0 18px 60px rgba(0,0,0,0.45)" }} />
        </div>
      ) : null}
      {dialogOpen && (
        <div style={{ position: "fixed", inset: 0, zIndex: 10000, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.3)" }} onClick={() => setDialogOpen(false)}>
          <div style={{ width: 640, maxHeight: "80vh", background: "#fff", borderRadius: 12, padding: 24, overflow: "auto" }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: "0 0 16px", fontSize: 16, fontWeight: 700 }}>{editId ? "编辑分镜" : "新增分镜"}</h3>
            <div style={{ display: "grid", gap: 12 }}>
              <label style={{ display: "grid", gap: 4 }}>
                <span style={{ fontSize: 13, color: "#71717a" }}>画面提示词</span>
                <textarea value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} rows={3} placeholder="描述镜头画面、风格、光线和构图" style={{ padding: 8, border: "1px solid #e4e4e7", borderRadius: 6, fontSize: 14, resize: "vertical", fontFamily: "inherit" }} />
              </label>
              <label style={{ display: "grid", gap: 4 }}>
                <span style={{ fontSize: 13, color: "#71717a" }}>视频描述</span>
                <textarea value={form.videoDesc} onChange={(e) => setForm({ ...form, videoDesc: e.target.value })} rows={2} placeholder="描述人物动作、镜头运动和剧情信息" style={{ padding: 8, border: "1px solid #e4e4e7", borderRadius: 6, fontSize: 14, resize: "vertical", fontFamily: "inherit" }} />
              </label>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <label style={{ display: "grid", gap: 4 }}>
                  <span style={{ fontSize: 13, color: "#71717a" }}>时长（秒）</span>
                  <input type="number" value={form.duration ?? ""} onChange={(e) => setForm({ ...form, duration: e.target.value === "" ? null : Number(e.target.value) })} min={1} max={30} style={{ padding: 8, border: "1px solid #e4e4e7", borderRadius: 6, fontSize: 14 }} />
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 8, paddingTop: 20, fontSize: 13, color: "#71717a", cursor: "pointer" }}>
                  <input type="checkbox" checked={form.shouldGenerateImage} onChange={(e) => setForm({ ...form, shouldGenerateImage: e.target.checked })} />
                  生成图片
                </label>
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
                <button onClick={() => setDialogOpen(false)} disabled={savingStoryboard} style={{ padding: "8px 20px", border: "1px solid #e4e4e7", borderRadius: 8, background: "#fff", cursor: "pointer", fontSize: 13 }}>取消</button>
                <button onClick={submitStoryboard} disabled={savingStoryboard} style={{ padding: "8px 20px", border: "none", borderRadius: 8, background: "#5d94bd", color: "#fff", cursor: "pointer", fontSize: 13 }}>{savingStoryboard ? "保存中…" : "保存"}</button>
              </div>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        key={deleteIntent?.intentToken || "storyboard-delete-dialog"}
        open={Boolean(deleteIntent)}
        title="删除分镜？"
        description={(
          <>
            <span>将{deleteIntent?.label || "所选分镜"}从当前项目移除，创作库媒体与计费审计保留。</span>
            {deleteError && deleteError.intentToken === deleteIntent?.intentToken ? <span role="alert" style={{ display: "block", marginTop: 8, color: "#b91c1c" }}>删除失败：{deleteError.message}</span> : null}
          </>
        )}
        confirmLabel="确认删除"
        tone="danger"
        onConfirm={() => confirmDeleteStoryboards(deleteIntent)}
        onConfirmError={(error) => reportDeleteError(deleteIntent, error)}
        onCancel={() => deleteIntent && closeDeleteIntent(deleteIntent.intentToken)}
      />
    </div>
  );
}
