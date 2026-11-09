import { Link } from "react-router-dom";
import { useV4Theme } from "../../ui/useV4Theme";
import "../frontstage/FrontstagePage.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Edit3,
  Image as ImageIcon,
  Loader2,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { apiPost } from "../../api/http";
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
  fetchQuickCreateModels,
  type QuickCreateImageModelOption,
} from "../../features/quick-create/modelCatalog";
import {
  resolveStableSubmissionAttempt,
  type StableSubmissionAttempt,
} from "../../features/quick-create/submissionAttempt";
import type { QuickCreateImageQuality } from "../../features/quick-create/types";
import {
  cancelProjectImageTask,
  CORNER_IMAGE_TASK_API,
  fetchProjectImageTasks,
  isProjectImageTaskActive,
  latestProjectImageTasksByResource,
  projectImageTaskLabel,
  shouldRetainProjectImageAttempt,
  type ProjectImageTask,
} from "../../features/quick-create/projectImageTasks";
import {
  createTaskPoller,
  type TaskPoller,
} from "../../features/quick-create/tasks/taskPoller";
import { useProjectStore } from "../../stores/projectStore";
import { ConfirmDialog } from "../../ui/console";
import { useToast } from "../../ui/console/feedback";

type EditableAssetType = "role" | "scene" | "tool";
type AssetType = EditableAssetType | "image" | "clip";
export type CornerAssetStatusFilter =
  | "all"
  | "not_generated"
  | "queued"
  | "running"
  | "pending_reconcile"
  | "succeeded"
  | "failed"
  | "cancelled";

interface HistoryImage {
  filePath: string;
  id: number;
}

export interface CornerAssetItem {
  id: number;
  imageId: number | null;
  type: AssetType;
  name: string;
  prompt: string;
  filePath: string | null;
  state: string;
  model: string;
  resolution: string;
  describe: string;
  promptState: string;
  historyImages: HistoryImage[];
  errorReason: string;
  promptErrorReason: string;
}

type AssetForm = {
  name: string;
  type: EditableAssetType;
  describe: string;
  prompt: string;
};

const EMPTY_FORM: AssetForm = {
  name: "",
  type: "role",
  describe: "",
  prompt: "",
};

const editableAssetOptions: Array<{ label: string; value: EditableAssetType }> = [
  { label: "角色", value: "role" },
  { label: "场景", value: "scene" },
  { label: "道具", value: "tool" },
];

const filterOptions: Array<{ label: string; value: AssetType }> = [
  ...editableAssetOptions,
  { label: "生成图片", value: "image" },
  { label: "生成视频", value: "clip" },
];

function isEditableAssetType(type: AssetType): type is EditableAssetType {
  return type === "role" || type === "scene" || type === "tool";
}

const statusFilterOptions: Array<{
  label: string;
  value: CornerAssetStatusFilter;
}> = [
  { label: "全部状态", value: "all" },
  { label: "未生成", value: "not_generated" },
  { label: "排队中", value: "queued" },
  { label: "生成中", value: "running" },
  { label: "待核对", value: "pending_reconcile" },
  { label: "已完成", value: "succeeded" },
  { label: "失败", value: "failed" },
  { label: "已取消", value: "cancelled" },
];

function typeLabel(type: AssetType) {
  return filterOptions.find((item) => item.value === type)?.label || "未知";
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function normalizeCornerAssets(value: unknown): CornerAssetItem[] {
  if (!Array.isArray(value)) throw new Error("角色场景响应格式无效，已阻止展示空数据");
  return value.map((entry) => {
    const source = record(entry);
    const id = Number(source?.id);
    const type = String(source?.type || "") as AssetType;
    const name = typeof source?.name === "string" ? source.name.trim() : "";
    if (
      !source
      || !Number.isSafeInteger(id)
      || id <= 0
      || !filterOptions.some((item) => item.value === type)
      || !name
    ) {
      throw new Error("角色场景响应包含无效资产记录");
    }
    const historyImages = Array.isArray(source.historyImages)
      ? source.historyImages.flatMap((image) => {
          const row = record(image);
          const imageId = Number(row?.id);
          const filePath = typeof row?.filePath === "string" ? row.filePath : "";
          return Number.isSafeInteger(imageId) && imageId > 0 && filePath
            ? [{ id: imageId, filePath }]
            : [];
        })
      : [];
    return {
      id,
      imageId: Number.isSafeInteger(Number(source.imageId)) && Number(source.imageId) > 0
        ? Number(source.imageId)
        : null,
      type,
      name,
      prompt: typeof source.prompt === "string" ? source.prompt : "",
      filePath: typeof source.filePath === "string" && source.filePath ? source.filePath : null,
      state: typeof source.state === "string" ? source.state : "",
      model: typeof source.model === "string" ? source.model : "",
      resolution: typeof source.resolution === "string" ? source.resolution : "",
      describe: typeof source.describe === "string" ? source.describe : "",
      promptState: typeof source.promptState === "string" ? source.promptState : "",
      historyImages,
      errorReason: typeof source.errorReason === "string" ? source.errorReason : "",
      promptErrorReason: typeof source.promptErrorReason === "string" ? source.promptErrorReason : "",
    };
  });
}

export type CornerImageGenerationResult = {
  assetId: number;
  assetVersionId: number;
  url: string;
  imageTaskId: number;
};

export function normalizeCornerImageGenerationResult(
  value: unknown,
  expectedAssetId: number,
): CornerImageGenerationResult {
  const source = record(value);
  const assets = Array.isArray(source?.assets) ? source.assets : [];
  const result = record(assets[0]);
  const assetId = Number(result?.assetId);
  const assetVersionId = Number(result?.assetVersionId);
  const url = typeof result?.url === "string" ? result.url.trim() : "";
  const imageTaskId = Number(source?.imageTaskId);
  if (
    Number(source?.count) !== 1
    || assets.length !== 1
    || assetId !== expectedAssetId
    || !Number.isSafeInteger(assetVersionId)
    || assetVersionId <= 0
    || !url
    || !Number.isSafeInteger(imageTaskId)
    || imageTaskId <= 0
  ) {
    throw new Error("图片生成结果没有写入目标资产版本");
  }
  return { assetId, assetVersionId, url, imageTaskId };
}

export function resolveCornerImageAttempt(
  current: StableSubmissionAttempt | null,
  projectId: number,
  assetId: number,
  payload: unknown,
  randomId?: () => string,
): StableSubmissionAttempt {
  return resolveStableSubmissionAttempt(
    current,
    `corner-image:${projectId}:${assetId}`,
    payload,
    randomId,
  );
}

function isCornerImageRunning(item: CornerAssetItem): boolean {
  return ["生成中", "running", "排队中", "queued", "pending"]
    .includes(String(item.state || "").trim());
}

export function cornerAssetStatus(
  item: CornerAssetItem,
  task: Pick<ProjectImageTask, "state"> | null,
  submitting = false,
  locallyQueued = false,
): Exclude<CornerAssetStatusFilter, "all"> {
  if (submitting) return "running";
  if (locallyQueued) return "queued";
  if (task) return task.state;
  const state = String(item.state || "").trim().toLowerCase();
  if (["queued", "排队中", "pending"].includes(state)) return "queued";
  if (["running", "生成中", "提交中"].includes(state)) return "running";
  if (["pending_reconcile", "待核对", "待核账"].includes(state)) {
    return "pending_reconcile";
  }
  if (["failed", "生成失败", "失败"].includes(state)) return "failed";
  if (["cancelled", "canceled", "已取消"].includes(state)) return "cancelled";
  if (
    ["succeeded", "success", "completed", "生成完成", "已完成", "成功"]
      .includes(state)
    || Boolean(item.filePath || item.imageId)
  ) {
    return "succeeded";
  }
  return "not_generated";
}

async function fetchCornerAssets(
  projectId: number,
  filters: AssetType[],
  signal?: AbortSignal,
): Promise<CornerAssetItem[]> {
  const response = await apiPost<unknown>(
    "/cornerScape/getAllAssets",
    { projectId, type: filters },
    undefined,
    { signal },
  );
  return normalizeCornerAssets(response);
}

type CornerRuntime = {
  assets: CornerAssetItem[];
  imageTasks: ProjectImageTask[];
};

async function fetchCornerRuntime(
  projectId: number,
  filters: AssetType[],
  signal?: AbortSignal,
): Promise<CornerRuntime> {
  const [assets, imageTasks] = await Promise.all([
    fetchCornerAssets(projectId, filters, signal),
    fetchProjectImageTasks(CORNER_IMAGE_TASK_API, projectId, signal),
  ]);
  return {
    assets,
    imageTasks: imageTasks.filter((task) => task.flow === "asset"),
  };
}

export default function CornerScapePage() {
  const theme = useV4Theme();
  const { toast } = useToast();
  const project = useProjectStore((state) => state.currentProject);
  const currentProjectId = useProjectStore((state) => state.currentProjectId);
  const projectIdValue = project?.id ?? currentProjectId;
  const projectId = projectIdValue ? Number(projectIdValue) : null;
  const mountedRef = useRef(true);
  const requestRef = useRef<AbortController | null>(null);
  const contextEpochRef = useRef(0);
  const projectIdRef = useRef<number | null>(null);
  const pollingRef = useRef<TaskPoller | null>(null);
  const generationAttemptsRef = useRef<Map<string, StoredSubmissionAttempt>>(new Map());
  const generationInFlightRef = useRef<Set<number>>(new Set());
  const promptAttemptsRef = useRef<Map<string, StoredSubmissionAttempt>>(new Map());
  const promptInFlightRef = useRef<Set<number>>(new Set());
  const createAttemptRef = useRef<StableSubmissionAttempt | null>(null);
  const createInFlightRef = useRef(false);

  const [items, setItems] = useState<CornerAssetItem[]>([]);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [assetObservationDigests, setAssetObservationDigests] = useState<Record<number, string>>({});
  const [filters, setFilters] = useState<AssetType[]>([]);
  const [statusFilter, setStatusFilter] = useState<CornerAssetStatusFilter>("all");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [models, setModels] = useState<QuickCreateImageModelOption[]>([]);
  const [modelId, setModelId] = useState("");
  const [quality, setQuality] = useState<QuickCreateImageQuality>("2K");
  const [modelError, setModelError] = useState("");
  const [syncError, setSyncError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [editItem, setEditItem] = useState<CornerAssetItem | null>(null);
  const [form, setForm] = useState<AssetForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [polishing, setPolishing] = useState(false);
  const [generatingIds, setGeneratingIds] = useState<number[]>([]);
  const [queuedGenerationIds, setQueuedGenerationIds] = useState<number[]>([]);
  const [imageTasksByAsset, setImageTasksByAsset] = useState<
    Map<number, ProjectImageTask>
  >(() => new Map());
  const [previewItem, setPreviewItem] = useState<CornerAssetItem | null>(null);
  const [deleteItem, setDeleteItem] = useState<CornerAssetItem | null>(null);
  const [deleteError, setDeleteError] = useState("");

  const selectedModel = useMemo(
    () => models.find((model) => model.id === modelId) || null,
    [modelId, models],
  );
  const ratio = String(project?.videoRatio || "16:9");
  const ratioSupported = Boolean(
    selectedModel && selectedModel.aspectRatios.includes(ratio as never),
  );
  const visibleItems = useMemo(() => (
    statusFilter === "all"
      ? items
      : items.filter((item) => cornerAssetStatus(
          item,
          imageTasksByAsset.get(item.id) || null,
          generatingIds.includes(item.id),
          queuedGenerationIds.includes(item.id),
        ) === statusFilter)
  ), [generatingIds, imageTasksByAsset, items, queuedGenerationIds, statusFilter]);
  const visibleItemIds = useMemo(
    () => visibleItems.filter((item) => isEditableAssetType(item.type)).map((item) => item.id),
    [visibleItems],
  );
  const allVisibleSelected = visibleItemIds.length > 0
    && visibleItemIds.every((id) => selectedIds.includes(id));
  const filterKey = useMemo(() => [...filters].sort().join(","), [filters]);

  useEffect(() => {
    let active = true;
    const projectDigest = String(project?.correlationDigest || "").trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(projectDigest) || !globalThis.crypto?.subtle) {
      setAssetObservationDigests({});
      return () => { active = false; };
    }
    void Promise.all(items.map(async (item) => {
      const bytes = new TextEncoder().encode(
        `fanjin-corner-asset-observation/v1\0${projectDigest}\0${item.id}`,
      );
      const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
      return [item.id, Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("")] as const;
    })).then((entries) => {
      if (active) setAssetObservationDigests(Object.fromEntries(entries));
    });
    return () => { active = false; };
  }, [items, project?.correlationDigest]);

  useEffect(() => {
    const visible = new Set(visibleItemIds);
    setSelectedIds((current) => {
      const next = current.filter((id) => visible.has(id));
      return next.length === current.length ? current : next;
    });
  }, [visibleItemIds]);

  const isCurrentContext = useCallback((expectedProjectId: number, expectedEpoch: number) => (
    mountedRef.current
    && projectIdRef.current === expectedProjectId
    && contextEpochRef.current === expectedEpoch
  ), []);

  const applyAssets = useCallback((next: CornerAssetItem[]) => {
    setItems(next);
    setSelectedIds((current) => current.filter((id) => next.some((item) => item.id === id)));
  }, []);

  const applyImageTasks = useCallback((
    expectedProjectId: number,
    tasks: ProjectImageTask[],
    nextAssets: CornerAssetItem[],
  ) => {
    const latest = latestProjectImageTasksByResource(tasks, "asset");
    setImageTasksByAsset(latest);
    nextAssets.forEach((item) => {
      const operationKey = `${expectedProjectId}:${item.id}`;
      const storageKey = submissionAttemptStorageKey("corner-image", operationKey);
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
  }, []);

  const startAssetPolling = useCallback((
    expectedProjectId: number,
    expectedFilters: AssetType[],
    expectedEpoch: number,
  ) => {
    if (!isCurrentContext(expectedProjectId, expectedEpoch)) return;
    pollingRef.current?.stop();
    const poller = createTaskPoller<CornerRuntime, number>({
      fetchTasks: () => fetchCornerRuntime(expectedProjectId, expectedFilters),
      shouldContinue: (next) => (
        next.assets.some(isCornerImageRunning)
        || next.imageTasks.some(isProjectImageTaskActive)
        || generationInFlightRef.current.size > 0
      ),
      onData: (next) => {
        if (!isCurrentContext(expectedProjectId, expectedEpoch)) return;
        applyAssets(next.assets);
        applyImageTasks(expectedProjectId, next.imageTasks, next.assets);
        setLoadError("");
        setSyncError("");
        if (
          !next.assets.some(isCornerImageRunning)
          && !next.imageTasks.some(isProjectImageTaskActive)
          && generationInFlightRef.current.size === 0
        ) {
          pollingRef.current?.stop();
          pollingRef.current = null;
        }
      },
      onState: () => undefined,
      onError: (error, kind) => {
        if (!isCurrentContext(expectedProjectId, expectedEpoch)) return;
        const message = error instanceof Error ? error.message : "资产图片状态同步失败";
        setSyncError(
          kind === "retry" || kind === "rate_limit"
            ? `资产状态同步暂时失败，正在自动重连：${message}`
            : message,
        );
      },
      schedule: (callback, delay) => window.setTimeout(callback, delay),
      cancelSchedule: (handle) => window.clearTimeout(handle),
      isVisible: () => typeof document === "undefined" || document.visibilityState !== "hidden",
    });
    pollingRef.current = poller;
    void poller.refresh();
  }, [applyAssets, applyImageTasks, isCurrentContext]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestRef.current?.abort();
      pollingRef.current?.stop();
    };
  }, []);

  useEffect(() => {
    let alive = true;
    setModelError("");
    void fetchQuickCreateModels()
      .then(({ imageModels }) => {
        if (!alive) return;
        setModels(imageModels);
        if (!imageModels.length) {
          setModelId("");
          setModelError("当前工作区没有可提交的图片模型");
          return;
        }
        const preferred = imageModels.find((model) => model.id === project?.imageModel)
          || imageModels[0];
        setModelId(preferred.id);
        setQuality(preferred.defaultQuality);
      })
      .catch((error) => {
        if (!alive) return;
        setModels([]);
        setModelId("");
        setModelError(error instanceof Error ? error.message : "图片模型目录读取失败");
      });
    return () => {
      alive = false;
    };
  }, [project?.id, project?.imageModel]);

  const loadAssets = useCallback(async () => {
    if (!projectId) {
      setItems([]);
      return;
    }
    if (projectIdRef.current !== projectId) return;
    const expectedEpoch = contextEpochRef.current;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setLoadError("");
    try {
      const next = await fetchCornerRuntime(projectId, filters, controller.signal);
      if (!isCurrentContext(projectId, expectedEpoch) || controller.signal.aborted) return;
      applyAssets(next.assets);
      applyImageTasks(projectId, next.imageTasks, next.assets);
      if (
        next.assets.some(isCornerImageRunning)
        || next.imageTasks.some(isProjectImageTaskActive)
      ) {
        startAssetPolling(projectId, [...filters], expectedEpoch);
      } else {
        pollingRef.current?.stop();
        pollingRef.current = null;
        setSyncError("");
      }
    } catch (error) {
      if (!isCurrentContext(projectId, expectedEpoch) || controller.signal.aborted) return;
      setLoadError(error instanceof Error ? error.message : "角色场景加载失败");
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
      if (isCurrentContext(projectId, expectedEpoch) && !controller.signal.aborted) {
        setLoading(false);
      }
    }
  }, [applyAssets, applyImageTasks, filters, isCurrentContext, projectId, startAssetPolling]);

  useEffect(() => {
    const projectChanged = projectIdRef.current !== projectId;
    contextEpochRef.current += 1;
    projectIdRef.current = projectId;
    requestRef.current?.abort();
    pollingRef.current?.stop();
    pollingRef.current = null;
    if (projectChanged) {
      generationAttemptsRef.current.clear();
      promptAttemptsRef.current.clear();
      createAttemptRef.current = null;
    }
    generationInFlightRef.current.clear();
    promptInFlightRef.current.clear();
    createInFlightRef.current = false;
    setItems([]);
    setImageTasksByAsset(new Map());
    setSelectedIds([]);
    setGeneratingIds([]);
    setQueuedGenerationIds([]);
    setLoading(false);
    setSaving(false);
    setPolishing(false);
    setLoadError("");
    setSyncError("");
    setEditItem(null);
    setDeleteItem(null);
    setDeleteError("");
    return () => {
      contextEpochRef.current += 1;
      requestRef.current?.abort();
      pollingRef.current?.stop();
      pollingRef.current = null;
    };
  }, [filterKey, projectId]);

  async function confirmDeleteAsset() {
    const target = deleteItem;
    const expectedProjectId = projectId;
    if (!target || !expectedProjectId || projectIdRef.current !== expectedProjectId) return false;
    setDeleteError("");
    await apiPost("/assets/delAssets", { id: target.id });
    if (projectIdRef.current !== expectedProjectId) return false;
    setItems((current) => current.filter((item) => item.id !== target.id));
    setSelectedIds((current) => current.filter((id) => id !== target.id));
    setEditItem((current) => current?.id === target.id ? null : current);
    setDeleteItem(null);
    return true;
  }

  useEffect(() => {
    void loadAssets();
  }, [loadAssets]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      void pollingRef.current?.setVisible(document.visibilityState !== "hidden");
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);

  function openCreate() {
    setForm(EMPTY_FORM);
    setCreateOpen(true);
  }

  function openEdit(item: CornerAssetItem) {
    if (!isEditableAssetType(item.type)) return;
    setEditItem(item);
    setForm({
      name: item.name,
      type: item.type,
      describe: item.describe,
      prompt: item.prompt,
    });
  }

  async function createAsset() {
    if (
      !projectId
      || !form.name.trim()
      || !form.describe.trim()
      || saving
      || createInFlightRef.current
    ) return;
    const payload = {
      projectId: Number(projectId),
      name: form.name.trim(),
      describe: form.describe.trim(),
      type: form.type,
      prompt: form.prompt.trim(),
      remark: "quick-project",
    };
    const { attempt, storageKey } = prepareStoredSubmissionAttempt({
      current: createAttemptRef.current,
      flow: "corner-asset-create",
      operationKey: String(projectId),
      prefix: `corner-asset-create:${projectId}`,
      payload,
    });
    createAttemptRef.current = attempt;
    createInFlightRef.current = true;
    setSaving(true);
    try {
      const response = await apiPost<{ id?: number }>(
        "/assets/addAssets",
        payload,
        undefined,
        { headers: { "Idempotency-Key": attempt.idempotencyKey } },
      );
      if (!Number.isSafeInteger(Number(response.id)) || Number(response.id) <= 0) {
        throw new Error("资产创建响应缺少有效 ID");
      }
      clearStoredSubmissionAttempt(storageKey);
      if (createAttemptRef.current?.idempotencyKey === attempt.idempotencyKey) {
        createAttemptRef.current = null;
      }
      setCreateOpen(false);
      await loadAssets();
      toast({ title: `${typeLabel(form.type)}已创建`, tone: "success" });
    } catch (error) {
      if (
        !shouldRetainStoredSubmissionAttempt(error)
        && createAttemptRef.current?.idempotencyKey === attempt.idempotencyKey
      ) {
        clearStoredSubmissionAttempt(storageKey);
        createAttemptRef.current = null;
      }
      toast({ title: "创建失败", message: error instanceof Error ? error.message : undefined, tone: "danger" });
    } finally {
      createInFlightRef.current = false;
      setSaving(false);
    }
  }

  async function saveAsset() {
    if (!projectId || !editItem || !form.name.trim() || !form.describe.trim()) return;
    setSaving(true);
    try {
      await apiPost("/assets/updateAssets", {
        id: editItem.id,
        type: form.type,
        projectId: Number(projectId),
        name: form.name.trim(),
        describe: form.describe.trim(),
        prompt: form.prompt.trim(),
        remark: "quick-project",
      });
      setEditItem(null);
      await loadAssets();
      toast({ title: "资产已保存", tone: "success" });
    } catch (error) {
      toast({ title: "保存失败", message: error instanceof Error ? error.message : undefined, tone: "danger" });
    } finally {
      setSaving(false);
    }
  }

  async function polishPrompt() {
    if (!projectId || !editItem || !form.name.trim() || !form.describe.trim()) return;
    const assetId = editItem.id;
    if (promptInFlightRef.current.has(assetId)) return;
    const payload = {
      projectId: Number(projectId),
      assetsId: assetId,
      type: form.type,
      name: form.name.trim(),
      describe: form.describe.trim(),
    };
    const operationKey = `${projectId}:${assetId}`;
    const { attempt, storageKey } = prepareStoredSubmissionAttempt({
      current: promptAttemptsRef.current.get(operationKey) || null,
      flow: "corner-prompt",
      operationKey,
      prefix: `corner-prompt:${projectId}:${assetId}`,
      payload,
    });
    promptAttemptsRef.current.set(operationKey, attempt);
    promptInFlightRef.current.add(assetId);
    setPolishing(true);
    try {
      const response = await apiPost<{ assetsId?: number; prompt?: string }>(
        "/assetsGenerate/polishAssetsPrompt",
        payload,
        undefined,
        { headers: { "Idempotency-Key": attempt.idempotencyKey } },
      );
      if (Number(response.assetsId) !== assetId || !String(response.prompt || "").trim()) {
        throw new Error("提示词生成响应不完整");
      }
      setForm((current) => ({ ...current, prompt: String(response.prompt) }));
      if (
        promptAttemptsRef.current.get(operationKey)?.idempotencyKey
        === attempt.idempotencyKey
      ) {
        promptAttemptsRef.current.delete(operationKey);
      }
      clearStoredSubmissionAttempt(storageKey);
      toast({ title: "提示词已由真实模型生成", tone: "success" });
    } catch (error) {
      if (
        !shouldRetainStoredSubmissionAttempt(error)
        && promptAttemptsRef.current.get(operationKey)?.idempotencyKey
          === attempt.idempotencyKey
      ) {
        promptAttemptsRef.current.delete(operationKey);
        clearStoredSubmissionAttempt(storageKey);
      }
      toast({ title: "提示词生成失败", message: error instanceof Error ? error.message : undefined, tone: "danger" });
    } finally {
      promptInFlightRef.current.delete(assetId);
      setPolishing(false);
    }
  }

  async function generateAssetImage(
    item: CornerAssetItem,
    expectedProjectId: number,
    expectedEpoch: number,
    prompt = item.prompt.trim() || item.describe.trim(),
  ): Promise<number> {
    if (generationInFlightRef.current.has(item.id)) throw new Error("该资产正在提交图片任务，请等待结果");
    const currentTask = imageTasksByAsset.get(item.id);
    if (currentTask && isProjectImageTaskActive(currentTask)) {
      throw new Error(
        currentTask.state === "pending_reconcile"
          ? "该资产仍有待核对的上游请求，不能启动新的生成"
          : "该资产已有图片任务正在执行",
      );
    }
    if (!selectedModel || !ratioSupported || !prompt.trim()) {
      throw new Error(!prompt.trim() ? "资产缺少图片提示词" : "图片模型或项目画幅当前不可用");
    }
    const payload = {
      projectId: expectedProjectId,
      targetAssetId: item.id,
      model: selectedModel.id,
      prompt: prompt.trim(),
      ratio,
      quality,
      count: 1,
      subjects: [],
      skills: [],
      references: [],
      referenceImages: [],
    };
    const operationKey = `${expectedProjectId}:${item.id}`;
    const storageKey = submissionAttemptStorageKey("corner-image", operationKey);
    const attempt = resolveCornerImageAttempt(
      generationAttemptsRef.current.get(operationKey)
        || readStoredSubmissionAttempt(storageKey),
      expectedProjectId,
      item.id,
      { ...payload, previousImageId: item.imageId },
    );
    generationAttemptsRef.current.set(operationKey, attempt);
    writeStoredSubmissionAttempt(storageKey, attempt);
    if (isCurrentContext(expectedProjectId, expectedEpoch)) {
      setGeneratingIds((current) => [...new Set([...current, item.id])]);
    }
    generationInFlightRef.current.add(item.id);
    try {
      const request = apiPost<unknown>(
        "/workbench/create/images",
        payload,
        undefined,
        { headers: { "Idempotency-Key": attempt.idempotencyKey } },
      );
      if (isCurrentContext(expectedProjectId, expectedEpoch)) {
        startAssetPolling(expectedProjectId, [...filters], expectedEpoch);
      }
      const response = await request;
      const result = normalizeCornerImageGenerationResult(response, item.id);
      const trackedAttempt = { ...attempt, taskId: result.imageTaskId };
      generationAttemptsRef.current.set(operationKey, trackedAttempt);
      writeStoredSubmissionAttempt(storageKey, trackedAttempt);
      if (
        generationAttemptsRef.current.get(operationKey)?.idempotencyKey
        === attempt.idempotencyKey
      ) {
        generationAttemptsRef.current.delete(operationKey);
      }
      clearStoredSubmissionAttempt(storageKey);
      return item.id;
    } catch (error) {
      if (
        !shouldRetainProjectImageAttempt(error)
        && generationAttemptsRef.current.get(operationKey) === attempt
      ) {
        generationAttemptsRef.current.delete(operationKey);
        clearStoredSubmissionAttempt(storageKey);
      } else if (isCurrentContext(expectedProjectId, expectedEpoch)) {
        startAssetPolling(expectedProjectId, [...filters], expectedEpoch);
      }
      throw error;
    } finally {
      generationInFlightRef.current.delete(item.id);
      if (isCurrentContext(expectedProjectId, expectedEpoch)) {
        setGeneratingIds((current) => current.filter((id) => id !== item.id));
      }
    }
  }

  async function generateEditedAsset() {
    if (!editItem || !projectId) return;
    const expectedEpoch = contextEpochRef.current;
    const item = editItem;
    try {
      await generateAssetImage(item, projectId, expectedEpoch, form.prompt.trim() || form.describe.trim());
      if (!isCurrentContext(projectId, expectedEpoch)) return;
      setEditItem(null);
      await loadAssets();
      if (!isCurrentContext(projectId, expectedEpoch)) return;
      toast({ title: `${item.name} 图片任务已提交`, tone: "success" });
    } catch (error) {
      if (!isCurrentContext(projectId, expectedEpoch)) return;
      toast({ title: "图片生成失败", message: error instanceof Error ? error.message : undefined, tone: "danger" });
    }
  }

  async function generateSelectedAssets() {
    if (!projectId) return;
    const expectedEpoch = contextEpochRef.current;
    const selected = visibleItems.filter((item) => {
      const task = imageTasksByAsset.get(item.id);
      return selectedIds.includes(item.id)
        && !(task && isProjectImageTaskActive(task));
    });
    if (!selected.length) return;
    setQueuedGenerationIds(selected.map((item) => item.id));
    const settled = await settleItemBatch(selected, async (item) => {
      if (isCurrentContext(projectId, expectedEpoch)) {
        setQueuedGenerationIds((current) => current.filter((id) => id !== item.id));
      }
      return generateAssetImage(item, projectId, expectedEpoch);
    }, 1);
    if (!isCurrentContext(projectId, expectedEpoch)) return;
    setQueuedGenerationIds([]);
    const { succeededIds, failures } = summarizeItemBatch(
      selected,
      settled,
      (item) => item.name,
    );
    setSelectedIds((current) => retainUnsuccessfulSelection(current, succeededIds));
    await loadAssets();
    if (!isCurrentContext(projectId, expectedEpoch)) return;
    if (failures.length) {
      toast({
        title: `${succeededIds.length} 个成功，${failures.length} 个待重试`,
        message: `失败项已保留选择；未确认请求会安全复用原幂等键。${failures.join("；")}`,
        tone: "danger",
      });
    } else {
      toast({ title: `${succeededIds.length} 个资产图片任务已提交`, tone: "success" });
    }
  }

  async function cancelAssetImage(item: CornerAssetItem) {
    if (!projectId) return;
    const task = imageTasksByAsset.get(item.id);
    if (!task || !isProjectImageTaskActive(task)) return;
    const expectedEpoch = contextEpochRef.current;
    pollingRef.current?.stop();
    pollingRef.current = null;
    try {
      const result = await cancelProjectImageTask(
        CORNER_IMAGE_TASK_API,
        projectId,
        task.taskId,
      );
      if (!isCurrentContext(projectId, expectedEpoch)) return;
      setImageTasksByAsset((current) => {
        const next = new Map(current);
        next.set(item.id, result.task);
        return next;
      });
      if (result.cancelled) {
        const operationKey = `${projectId}:${item.id}`;
        generationAttemptsRef.current.delete(operationKey);
        clearStoredSubmissionAttempt(
          submissionAttemptStorageKey("corner-image", operationKey),
        );
        toast({
          title: `${item.name} 图片任务已取消`,
          message: "任务尚未派发上游，不会产生本次生成调用。",
          tone: "success",
        });
      } else if (result.task.state === "pending_reconcile") {
        toast({
          title: `${item.name} 已进入待核对`,
          message: "请求已经派发上游，无法安全撤回；系统不会伪报取消成功或自动重发。",
          tone: "warning",
        });
      } else {
        toast({
          title: `${item.name} 已越过可取消阶段`,
          message: "上游结果正在保存，当前任务没有被取消。",
          tone: "warning",
        });
      }
      await loadAssets();
    } catch (error) {
      if (!isCurrentContext(projectId, expectedEpoch)) return;
      toast({
        title: "取消图片任务失败",
        message: error instanceof Error ? error.message : undefined,
        tone: "danger",
      });
      startAssetPolling(projectId, [...filters], expectedEpoch);
    }
  }

  async function selectHistory(item: CornerAssetItem, image: HistoryImage) {
    if (!projectId) return;
    try {
      await apiPost("/assets/saveAssets", {
        id: item.id,
        projectId: Number(projectId),
        type: item.type,
        prompt: item.prompt,
        imageId: image.id,
      });
      await loadAssets();
      toast({ title: "资产版本已切换", tone: "success" });
    } catch (error) {
      toast({ title: "切换版本失败", message: error instanceof Error ? error.message : undefined, tone: "danger" });
    }
  }

  if (!projectId) return <section className="frontPagePalette frontTaskPage" data-theme={theme.mode}><h1 style={{ fontSize: 24 }}>角色、场景与道具</h1><div className="frontPageEmpty"><div style={{ textAlign: "center", padding: 24 }}><h2 style={{ fontSize: 18 }}>选择项目后开始整理资产</h2><p style={{ margin: "12px 0 20px" }}>角色、场景和道具将保存在当前项目中。</p><Link to="/workbench/quick-create" style={{ padding: "10px 18px", border: 0, borderRadius: 12, background: "var(--front-accent)", color: "white" }}>选择项目</Link></div></div></section>;

  const activeImageTaskCount = [...imageTasksByAsset.values()]
    .filter(isProjectImageTaskActive).length;
  const submissionInProgress = generatingIds.length > 0 || queuedGenerationIds.length > 0;
  const anyGenerating = submissionInProgress || activeImageTaskCount > 0;
  const selectedRunnableCount = visibleItems.filter((item) => {
    const task = imageTasksByAsset.get(item.id);
    if (!isEditableAssetType(item.type) || !selectedIds.includes(item.id)) return false;
    return !(task && isProjectImageTaskActive(task));
  }).length;

  return (
    <div
      className="frontPagePalette" data-theme={theme.mode} data-testid="corner-page"
      data-visible-count={visibleItems.length}
      data-selected-visible-count={visibleItems.filter((item) => selectedIds.includes(item.id)).length}
      data-selected-total-count={selectedIds.length}
      data-status-filter={statusFilter}
      style={{ padding: 24, maxWidth: 1180, margin: "0 auto", color: "var(--front-text)" }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, marginBottom: 16 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22 }}>角色、场景与道具</h1>
          <div style={{ marginTop: 5, color: "var(--front-muted)", fontSize: 13 }}>所有图片通过当前工作区真实模型路由生成，并保存为项目资产版本。</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" onClick={() => void loadAssets()} disabled={loading} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 14px", border: "1px solid var(--front-line)", borderRadius: 8, background: "var(--front-surface)", cursor: "pointer" }}>
            <RefreshCw size={16} /> 刷新
          </button>
          <button data-testid="quick-corner-add-asset" type="button" onClick={openCreate} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 14px", border: 0, borderRadius: 8, background: "var(--front-accent)", color: "#fff", cursor: "pointer" }}>
            <Plus size={16} /> 新增资产
          </button>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, padding: 12, border: "1px solid var(--front-line)", borderRadius: 10, background: "var(--front-surface)", flexWrap: "wrap" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
          图片模型
          <select value={modelId} onChange={(event) => {
            const next = models.find((model) => model.id === event.target.value);
            setModelId(event.target.value);
            if (next) setQuality(next.defaultQuality);
          }} style={{ padding: "7px 10px", border: "1px solid #d8dde5", borderRadius: 7 }}>
            <option value="">选择可用模型</option>
            {models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
          </select>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
          清晰度
          <select value={quality} onChange={(event) => setQuality(event.target.value as QuickCreateImageQuality)} disabled={!selectedModel} style={{ padding: "7px 10px", border: "1px solid #d8dde5", borderRadius: 7 }}>
            {(selectedModel?.qualities || []).map((value) => <option key={value}>{value}</option>)}
          </select>
        </label>
        <span style={{ color: ratioSupported ? "#16833a" : "#9f231b", fontSize: 12 }}>
          项目画幅 {ratio}{selectedModel ? ratioSupported ? " · 支持" : " · 当前模型不支持" : ""}
        </span>
        <button type="button" onClick={() => void generateSelectedAssets()} disabled={!selectedRunnableCount || submissionInProgress || !selectedModel || !ratioSupported} style={{ marginLeft: "auto", padding: "8px 14px", border: 0, borderRadius: 8, background: "var(--front-accent)", color: "#fff", opacity: selectedRunnableCount && !submissionInProgress && selectedModel && ratioSupported ? 1 : 0.45 }}>
          {submissionInProgress ? "真实生成中…" : `生成所选图片${selectedRunnableCount ? `（${selectedRunnableCount}）` : ""}`}
        </button>
      </div>
      {modelError ? <div role="alert" style={{ marginBottom: 12, color: "#9f231b", fontSize: 12 }}>{modelError}</div> : null}
      {syncError ? <div role="alert" style={{ marginBottom: 12, color: "#9f231b", fontSize: 12 }}>{syncError}</div> : null}
      {(anyGenerating || items.some(isCornerImageRunning)) ? (
        <div role="status" style={{ marginBottom: 12, padding: "8px 10px", border: "1px solid #c7dff2", borderRadius: 8, color: "#315d7c", background: "#f4f9fd", fontSize: 12 }}>
          图片任务已持久化；刷新后会恢复同一任务和提交凭据。派发前可以取消，派发后只会标记为“待核对”，不会伪报取消成功。
        </div>
      ) : null}

      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        {filterOptions.map((option) => (
          <label key={option.value} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 10px", border: "1px solid var(--front-line)", borderRadius: 8, background: filters.includes(option.value) ? "#d7e9ff" : "#fff", cursor: "pointer", fontSize: 13 }}>
            <input type="checkbox" checked={filters.includes(option.value)} onChange={(event) => setFilters((current) => event.target.checked ? [...current, option.value] : current.filter((item) => item !== option.value))} />
            {option.label}
          </label>
        ))}
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, marginLeft: "auto", fontSize: 13 }}>
          状态
          <select
            aria-label="按资产状态筛选"
            data-testid="quick-corner-status-filter"
            value={statusFilter}
            onChange={(event) => {
              setStatusFilter(event.target.value as CornerAssetStatusFilter);
              setSelectedIds([]);
            }}
            style={{ padding: "6px 10px", border: "1px solid var(--front-line)", borderRadius: 8, background: "var(--front-surface)" }}
          >
            {statusFilterOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
      </div>

      <div style={{ border: "1px solid var(--front-line)", borderRadius: 10, overflow: "hidden", background: "var(--front-surface)" }}>
        {loadError ? (
          <div style={{ display: "grid", justifyItems: "center", gap: 10, padding: 36, color: "#9f231b" }}>
            <strong>角色场景加载失败</strong><span>{loadError}</span>
            <button type="button" onClick={() => void loadAssets()}>重试</button>
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead><tr style={{ background: "var(--front-soft)" }}>
              <th style={{ width: 44 }}><input aria-label="全选当前筛选资产" type="checkbox" checked={allVisibleSelected} onChange={() => setSelectedIds(allVisibleSelected ? [] : visibleItemIds)} /></th>
              <th style={{ padding: 10, textAlign: "left" }}>预览</th>
              <th style={{ padding: 10, textAlign: "left" }}>名称</th>
              <th style={{ padding: 10, textAlign: "left" }}>类型</th>
              <th style={{ padding: 10, textAlign: "left" }}>描述 / 提示词</th>
              <th style={{ padding: 10, textAlign: "center" }}>状态</th>
              <th style={{ padding: 10, textAlign: "center" }}>操作</th>
            </tr></thead>
            <tbody>
              {loading ? <tr><td colSpan={7} style={{ padding: 36, textAlign: "center" }}><Loader2 className="jimengSpin" size={20} /> 加载中…</td></tr> : null}
              {!loading && !visibleItems.length ? <tr><td colSpan={7} style={{ padding: 36, textAlign: "center", color: "var(--front-muted)" }}>{items.length ? "当前筛选条件下没有资产。" : "暂无角色、场景或道具；可先新增资产。"}</td></tr> : null}
              {!loading && visibleItems.map((item) => {
                const editable = isEditableAssetType(item.type);
                const task = imageTasksByAsset.get(item.id);
                const taskActive = Boolean(task && isProjectImageTaskActive(task));
                const taskLabel = task ? projectImageTaskLabel(task) : "";
                const locallyQueued = queuedGenerationIds.includes(item.id);
                const submitting = generatingIds.includes(item.id);
                const taskReason = submitting || locallyQueued ? "" : task?.reason || item.errorReason;
                return (
                <tr
                  key={item.id}
                  data-testid="quick-corner-asset-row"
                  data-selected={selectedIds.includes(item.id) ? "true" : "false"}
                  data-project-asset-type={item.type}
                  data-reconcile-status={cornerAssetStatus(
                    item,
                    task ?? null,
                    submitting,
                    locallyQueued,
                  )}
                  data-asset-correlation-digest={assetObservationDigests[item.id]}
                  style={{ borderTop: "1px solid var(--front-line)", background: selectedIds.includes(item.id) ? "#f0f7ff" : "#fff" }}
                >
                  <td style={{ textAlign: "center" }}>{editable ? <input aria-label={`选择 ${item.name}`} type="checkbox" checked={selectedIds.includes(item.id)} onChange={() => setSelectedIds((current) => current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id])} /> : null}</td>
                  <td style={{ width: 100, padding: 10 }}>
                    <button type="button" disabled={!item.filePath} onClick={() => item.filePath && setPreviewItem(item)} style={{ width: 72, height: 48, padding: 0, border: "1px solid var(--front-line)", borderRadius: 7, overflow: "hidden", background: "#eef0f4" }}>
                      {item.filePath ? item.type === "clip" ? <video src={item.filePath} muted preload="metadata" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <img src={item.filePath} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <ImageIcon size={18} />}
                    </button>
                  </td>
                  <td style={{ padding: 10, fontWeight: 650 }}>{item.name}</td>
                  <td style={{ padding: 10, color: "var(--front-muted)" }}>{typeLabel(item.type)}</td>
                  <td style={{ maxWidth: 390, padding: 10 }}>
                    <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.describe || "未填写描述"}</div>
                    <small style={{ display: "block", overflow: "hidden", color: "var(--front-muted)", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.prompt || "未生成提示词"}</small>
                  </td>
                  <td
                    title={taskReason || undefined}
                    style={{ padding: 10, textAlign: "center", color: !submitting && !locallyQueued && task?.state === "pending_reconcile" ? "#9a650f" : !submitting && !locallyQueued && (item.state === "生成失败" || task?.state === "failed") ? "#9f231b" : "var(--front-muted)" }}
                  >
                    <div>{submitting ? "生成中" : locallyQueued ? "排队中" : taskLabel || item.state || "未生成"}</div>
                    {taskReason ? <small style={{ display: "block", marginTop: 3, color: task?.state === "pending_reconcile" ? "#9a650f" : "#9f231b" }}>{taskReason}</small> : null}
                  </td>
                  <td style={{ padding: 10, textAlign: "center" }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                      {editable ? <button type="button" onClick={() => openEdit(item)} style={{ display: "inline-flex", alignItems: "center", gap: 4, border: 0, background: "transparent", color: "var(--front-accent)", cursor: "pointer" }}><Edit3 size={14} /> 编辑 / 生成</button> : null}
                      <button
                        type="button"
                        aria-label={`删除资产 ${item.name}`}
                        disabled={taskActive || submitting || locallyQueued}
                        title={taskActive || submitting || locallyQueued ? "图片任务进行中，暂不能删除" : "删除资产"}
                        onClick={() => {
                          setDeleteError("");
                          setDeleteItem(item);
                        }}
                        style={{ display: "inline-flex", alignItems: "center", gap: 4, border: 0, background: "transparent", color: "#b23a32", cursor: taskActive || submitting || locallyQueued ? "not-allowed" : "pointer", opacity: taskActive || submitting || locallyQueued ? 0.45 : 1 }}
                      >
                        <Trash2 size={14} /> 删除
                      </button>
                      {taskActive ? (
                        <button
                          type="button"
                          aria-label={`取消 ${item.name} 图片任务`}
                          title={
                            task?.state === "pending_reconcile"
                              ? "已派发上游，正在待核对，不能伪取消"
                              : task?.phase === "provider_succeeded"
                                ? "上游已完成，正在保存结果"
                                : task?.cancelAllowed
                                  ? "在派发上游前取消"
                                  : "请求停止；若已派发将转为待核对"
                          }
                          disabled={
                            task?.state === "pending_reconcile"
                            || task?.phase === "provider_succeeded"
                          }
                          onClick={() => void cancelAssetImage(item)}
                          style={{ border: "1px solid #efcf93", borderRadius: 6, background: "#fffaf0", color: "#9a650f", cursor: "pointer" }}
                        >
                          {task?.state === "pending_reconcile" ? "待核对" : "取消任务"}
                        </button>
                      ) : null}
                    </span>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {(createOpen || editItem) ? (
        <div onClick={() => { setCreateOpen(false); setEditItem(null); }} style={{ position: "fixed", inset: 0, zIndex: 10000, display: "flex", justifyContent: "flex-end", background: "rgba(0,0,0,0.42)" }}>
          <aside
            role="dialog"
            aria-modal="true"
            aria-label={editItem ? "编辑角色场景资产" : "新增角色场景资产"}
            data-testid="quick-corner-asset-dialog"
            onClick={(event) => event.stopPropagation()}
            style={{ width: 480, maxWidth: "100%", height: "100%", padding: 22, overflow: "auto", background: "var(--front-surface)" }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 18 }}>
              <strong>{editItem ? `编辑 ${editItem.name}` : "新增角色、场景或道具"}</strong>
              <button aria-label="关闭" type="button" onClick={() => { setCreateOpen(false); setEditItem(null); }} style={{ border: 0, background: "transparent" }}><X size={18} /></button>
            </div>
            <div style={{ display: "grid", gap: 13 }}>
              <label style={{ display: "grid", gap: 5, fontSize: 13 }}>类型<select value={form.type} onChange={(event) => setForm((current) => ({ ...current, type: event.target.value as EditableAssetType }))} style={{ padding: 9 }} >{editableAssetOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
              <label style={{ display: "grid", gap: 5, fontSize: 13 }}>名称<input data-testid="quick-corner-asset-name" value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} style={{ padding: 9 }} /></label>
              <label style={{ display: "grid", gap: 5, fontSize: 13 }}>设定描述<textarea data-testid="quick-corner-asset-description" rows={4} value={form.describe} onChange={(event) => setForm((current) => ({ ...current, describe: event.target.value }))} style={{ padding: 9, resize: "vertical" }} /></label>
              <label style={{ display: "grid", gap: 5, fontSize: 13 }}>图片提示词（留空时使用设定描述）<textarea data-testid="quick-corner-asset-prompt" rows={7} value={form.prompt} onChange={(event) => setForm((current) => ({ ...current, prompt: event.target.value }))} style={{ padding: 9, resize: "vertical" }} /></label>
              {editItem ? (
                <>
                  <button type="button" onClick={() => void polishPrompt()} disabled={polishing || !form.name.trim() || !form.describe.trim()} style={{ display: "inline-flex", justifyContent: "center", alignItems: "center", gap: 6, padding: 9 }}><Sparkles size={15} />{polishing ? "真实模型生成中…" : "用真实文本模型生成提示词"}</button>
                  {editItem.historyImages.length ? <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>{editItem.historyImages.map((image) => <button key={image.id} type="button" onClick={() => void selectHistory(editItem, image)} style={{ padding: 0, border: image.id === editItem.imageId ? "2px solid var(--front-accent)" : "1px solid var(--front-line)", borderRadius: 7, overflow: "hidden" }}><img src={image.filePath} alt="" style={{ display: "block", width: "100%", aspectRatio: "16/9", objectFit: "cover" }} /></button>)}</div> : null}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    <button type="button" onClick={() => void saveAsset()} disabled={saving}>保存文字设定</button>
                    <button
                      data-testid="quick-corner-generate-image"
                      type="button"
                      onClick={() => void generateEditedAsset()}
                      disabled={
                        generatingIds.includes(editItem.id)
                        || Boolean(
                          imageTasksByAsset.get(editItem.id)
                          && isProjectImageTaskActive(imageTasksByAsset.get(editItem.id)!),
                        )
                        || !(form.prompt.trim() || form.describe.trim())
                        || !selectedModel
                        || !ratioSupported
                      }
                      style={{ border: 0, background: "var(--front-accent)", color: "#fff" }}
                    >
                      {generatingIds.includes(editItem.id)
                        || Boolean(
                          imageTasksByAsset.get(editItem.id)
                          && isProjectImageTaskActive(imageTasksByAsset.get(editItem.id)!),
                        )
                        ? "生成中…"
                        : "生成真实图片"}
                    </button>
                  </div>
                  <button
                    type="button"
                    aria-label={`在编辑器中删除资产 ${editItem.name}`}
                    disabled={Boolean(
                      generatingIds.includes(editItem.id)
                      || (imageTasksByAsset.get(editItem.id) && isProjectImageTaskActive(imageTasksByAsset.get(editItem.id)!)),
                    )}
                    onClick={() => {
                      setDeleteError("");
                      setDeleteItem(editItem);
                    }}
                    style={{ display: "inline-flex", justifyContent: "center", alignItems: "center", gap: 6, padding: 9, border: "1px solid #efb4ae", borderRadius: 7, background: "#fff7f6", color: "#9f231b" }}
                  >
                    <Trash2 size={15} /> 删除资产
                  </button>
                </>
              ) : <button data-testid="quick-corner-create-asset" type="button" onClick={() => void createAsset()} disabled={saving || !form.name.trim() || !form.describe.trim()} style={{ padding: 10, border: 0, background: "var(--front-accent)", color: "#fff" }}>{saving ? "创建中…" : "创建资产"}</button>}
            </div>
          </aside>
        </div>
      ) : null}

      {previewItem?.filePath ? (
        <div role="dialog" aria-modal="true" aria-label={previewItem.type === "clip" ? "资产视频预览" : "资产图片预览"} onClick={() => setPreviewItem(null)} style={{ position: "fixed", inset: 0, zIndex: 10001, display: "grid", placeItems: "center", padding: 32, background: "rgba(0,0,0,0.8)" }}>
          {previewItem.type === "clip" ? <video src={previewItem.filePath} controls autoPlay onClick={(event) => event.stopPropagation()} style={{ maxWidth: "92vw", maxHeight: "88vh" }} /> : <img src={previewItem.filePath} alt="资产预览" onClick={(event) => event.stopPropagation()} style={{ maxWidth: "92vw", maxHeight: "88vh", objectFit: "contain" }} />}
        </div>
      ) : null}

      <ConfirmDialog
        open={Boolean(deleteItem)}
        title="删除资产"
        description={(
          <>
            <span>确定删除“{deleteItem?.name || ""}”吗？已生成图片及被其他内容引用的资产可能需要后台进一步核对。</span>
            {deleteError ? <span role="alert" style={{ display: "block", marginTop: 8, color: "#b91c1c" }}>删除失败：{deleteError}</span> : null}
          </>
        )}
        confirmLabel="确认删除"
        tone="danger"
        onConfirm={confirmDeleteAsset}
        onConfirmError={(error) => setDeleteError(error instanceof Error ? error.message : "资产删除失败")}
        onCancel={() => {
          setDeleteItem(null);
          setDeleteError("");
        }}
      />
    </div>
  );
}
