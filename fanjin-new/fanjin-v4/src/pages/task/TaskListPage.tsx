import { useV4Theme } from "../../ui/useV4Theme";
import "../frontstage/FrontstagePage.css";
import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { RefreshCw, Search } from "lucide-react";
import { apiDelete, apiPost } from "../../api/http";
import {
  createTaskPoller,
  type PollErrorKind,
  type TaskPoller,
} from "../../features/quick-create/tasks/taskPoller";
import { buildProjectModeHref } from "../../routes/projectModeRoutes";
import { useProjectStore } from "../../stores/projectStore";
import { Dialog } from "../../ui/console";
import {
  creativeTaskStatusLabel,
  creativeTaskStatusTheme,
  canRetryCreativeTask,
  normalizeCreativeTaskStatus,
  shouldPollCreativeTask,
  type CreativeTaskStatus,
} from "../../utils/creativeTaskStatus";
import { summarizeRelatedObjects } from "./taskRelatedObjectsSummary";
import "./TaskListPage.css";

type TaskOriginSurface = "quick-create" | "production" | "canvas" | "agent";

type TaskOrigin = {
  version: 1;
  surface: TaskOriginSurface;
  projectId: number;
  scriptId?: number;
  trackId?: number;
};

type PublicTaskCorrelation = {
  version: 1;
  projectDigest: string | null;
  generationDigest: string;
  taskDigest: string;
};

type PublicTaskObservability = {
  version: 1;
  prompt: string;
  parameters: Record<string, string | number | boolean>;
  requestRef: string;
  correlation: PublicTaskCorrelation;
};

interface TaskItem {
  id: number | string;
  source?: "legacy" | "relay";
  origin?: TaskOrigin | null;
  taskClass: string;
  relatedObjects?: string | null;
  model?: string | null;
  projectName?: string | null;
  projectId?: number | null;
  episode: string;
  state: string;
  startTime: number;
  describe?: string;
  reason?: string;
  observability?: PublicTaskObservability;
}

type TaskListQueryOverrides = Partial<{
  page: number;
  limit: number;
  taskClass: string;
  taskState: string;
  projectId: string;
  keyword: string;
  startDate: string;
  endDate: string;
}>;

type TaskListQuery = Required<TaskListQueryOverrides>;

type TaskListResponse = {
  rows: TaskItem[];
  total: number;
};

const TASK_ORIGIN_SURFACES = new Set<TaskOriginSurface>([
  "quick-create",
  "production",
  "canvas",
  "agent",
]);

function positiveSafeInteger(value: unknown): number | null {
  const normalized = Number(value);
  return Number.isSafeInteger(normalized) && normalized > 0 ? normalized : null;
}

/**
 * Origin is a server-issued navigation contract. Task text, relatedObjects and
 * projectId alone are intentionally insufficient because API and image tasks
 * must never be guessed into a paid production workflow.
 */
export function trustedTaskOrigin(row: Partial<TaskItem>): TaskOrigin | null {
  if (row.source !== "relay") return null;
  const value = row.origin;
  if (!value || typeof value !== "object" || value.version !== 1) return null;
  if (!TASK_ORIGIN_SURFACES.has(value.surface)) return null;
  const projectId = positiveSafeInteger(value.projectId);
  if (!projectId) return null;
  const rowProjectId = row.projectId == null ? null : positiveSafeInteger(row.projectId);
  if (row.projectId != null && rowProjectId !== projectId) return null;
  const scriptId = value.scriptId == null ? undefined : positiveSafeInteger(value.scriptId);
  const trackId = value.trackId == null ? undefined : positiveSafeInteger(value.trackId);
  if (
    (value.scriptId != null && !scriptId)
    || (value.trackId != null && !trackId)
  ) return null;
  return {
    version: 1,
    surface: value.surface,
    projectId,
    ...(scriptId ? { scriptId } : {}),
    ...(trackId ? { trackId } : {}),
  };
}

export function normalizeTaskListResponse(value: unknown): TaskListResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("任务列表响应格式无效");
  }
  const response = value as { data?: unknown; total?: unknown };
  if (!Array.isArray(response.data)) {
    throw new Error("任务列表响应缺少 data 数组");
  }
  if (!Number.isSafeInteger(response.total) || Number(response.total) < 0) {
    throw new Error("任务列表响应缺少有效 total");
  }
  return {
    rows: response.data as TaskItem[],
    total: Number(response.total),
  };
}

const stateOptions = [
  { label: "全部状态", value: "" },
  { label: "进行中", value: "进行中" },
  { label: "已完成", value: "已完成" },
  { label: "生成失败", value: "生成失败" },
  { label: "已取消", value: "已取消" },
];

const columns = [
  { key: "taskClass", title: "任务类型", width: 120 },
  { key: "relatedObjects", title: "关联对象", width: 120 },
  { key: "model", title: "模型", width: 240 },
  { key: "describe", title: "描述" },
  { key: "reason", title: "失败原因" },
  { key: "state", title: "状态", width: 100 },
  { key: "startTime", title: "开始时间", width: 180 },
  { key: "op", title: "操作", width: 150 },
];

function formatTime(value?: number | null) {
  if (!value) return "-";
  const d = new Date(value);
  if (isNaN(d.getTime())) return "-";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function dateBoundary(value: string, boundary: "start" | "end") {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = boundary === "start"
    ? new Date(year, month, day, 0, 0, 0, 0)
    : new Date(year, month, day, 23, 59, 59, 999);
  if (
    date.getFullYear() !== year
    || date.getMonth() !== month
    || date.getDate() !== day
  ) return undefined;
  return date.getTime();
}

const taskResultAssetTypes = new Set(["video", "image", "audio", "file"]);

type TaskResultMediaKind = "video" | "image" | "audio";

type TaskResultAsset = {
  url: string;
  mediaKind: TaskResultMediaKind | null;
  assetDigest?: string;
  contentSha256?: string;
};

export function publicTaskModelLabel(value: unknown): string {
  const normalized = String(value ?? "").trim();
  return normalized === "" || normalized === "平台自动路由"
    ? "平台自动路由"
    : "平台模型路由";
}

function sha256Value(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : undefined;
}

const taskParameterLabels: Record<string, string> = {
  resolution: "分辨率",
  aspectRatio: "画面比例",
  durationSeconds: "时长（秒）",
  quality: "质量",
  fps: "帧率",
  audio: "生成音频",
  watermark: "水印",
  mode: "生成模式",
};

function publicTaskObservability(value: unknown): PublicTaskObservability | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const correlation = row.correlation;
  if (!correlation || typeof correlation !== "object" || Array.isArray(correlation)) return null;
  const correlationRow = correlation as Record<string, unknown>;
  const projectDigest = correlationRow.projectDigest === null
    ? null
    : sha256Value(correlationRow.projectDigest);
  const generationDigest = sha256Value(correlationRow.generationDigest);
  const taskDigest = sha256Value(correlationRow.taskDigest);
  const requestRef = typeof row.requestRef === "string" && /^req_[a-f0-9]{24}$/.test(row.requestRef)
    ? row.requestRef
    : "";
  if (
    row.version !== 1
    || correlationRow.version !== 1
    || projectDigest === undefined
    || !generationDigest
    || !taskDigest
    || !requestRef
  ) return null;
  const parameters = row.parameters && typeof row.parameters === "object" && !Array.isArray(row.parameters)
    ? Object.fromEntries(Object.entries(row.parameters as Record<string, unknown>).filter(([key, item]) => (
        Object.prototype.hasOwnProperty.call(taskParameterLabels, key)
        && (typeof item === "string" || typeof item === "number" || typeof item === "boolean")
      ))) as Record<string, string | number | boolean>
    : {};
  return {
    version: 1,
    prompt: typeof row.prompt === "string" ? row.prompt : "",
    parameters,
    requestRef,
    correlation: {
      version: 1,
      projectDigest,
      generationDigest,
      taskDigest,
    },
  };
}

function canonicalTaskResultUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const raw = value.trim();
  if (raw.startsWith("/oss/")) {
    try {
      const parsed = new URL(raw, "http://fanjin.local");
      return !parsed.search && !parsed.hash && parsed.pathname.startsWith("/oss/")
        ? parsed.pathname
        : null;
    } catch {
      return null;
    }
  }
  try {
    const parsed = new URL(raw);
    return ["http:", "https:"].includes(parsed.protocol)
      && !parsed.username
      && !parsed.password
      && !parsed.search
      && !parsed.hash
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

function taskResultMediaKind(assetType: string, mimeType: unknown): TaskResultMediaKind | null {
  if (assetType === "video" || assetType === "image" || assetType === "audio") {
    return assetType;
  }
  if (assetType !== "file" || typeof mimeType !== "string") return null;
  const normalizedMimeType = mimeType.trim().toLowerCase();
  if (normalizedMimeType.startsWith("video/")) return "video";
  if (normalizedMimeType.startsWith("image/")) return "image";
  if (normalizedMimeType.startsWith("audio/")) return "audio";
  return null;
}

export function taskResultAssets(detail: unknown): TaskResultAsset[] {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return [];
  const assets = (detail as Record<string, unknown>).mediaAssets;
  if (!Array.isArray(assets)) return [];
  const safeAssets = new Map<string, TaskResultAsset>();
  for (const asset of assets) {
    if (!asset || typeof asset !== "object" || Array.isArray(asset)) continue;
    const row = asset as Record<string, unknown>;
    const assetType = String(row.assetType || "").trim().toLowerCase();
    if (!taskResultAssetTypes.has(assetType)) continue;
    const url = canonicalTaskResultUrl(row.url);
    if (!url) continue;
    const candidate = {
      url,
      mediaKind: taskResultMediaKind(assetType, row.mimeType),
      ...(sha256Value(row.contentSha256)
        ? { contentSha256: sha256Value(row.contentSha256) }
        : {}),
      ...(row.correlation && typeof row.correlation === "object" && !Array.isArray(row.correlation)
        && sha256Value((row.correlation as Record<string, unknown>).assetDigest)
        ? { assetDigest: sha256Value((row.correlation as Record<string, unknown>).assetDigest) }
        : {}),
    } satisfies TaskResultAsset;
    const existing = safeAssets.get(url);
    if (!existing || (!existing.mediaKind && candidate.mediaKind)) {
      safeAssets.set(url, candidate);
    }
  }
  return [...safeAssets.values()];
}

export function taskResultUrls(detail: unknown): string[] {
  return taskResultAssets(detail).map((asset) => asset.url);
}

function TaskResultPreviewMedia({ asset }: { asset: TaskResultAsset }) {
  if (asset.mediaKind === "video") {
    return (
      <video
        className="taskResultPreviewMedia taskResultPreviewMediaVideo"
        data-testid="task-result-preview-media"
        aria-label="任务生成结果视频"
        src={asset.url}
        controls
        tabIndex={0}
        playsInline
        preload="metadata"
      />
    );
  }
  if (asset.mediaKind === "image") {
    return (
      <img
        className="taskResultPreviewMedia taskResultPreviewMediaImage"
        data-testid="task-result-preview-media"
        src={asset.url}
        alt="任务生成结果图片"
        decoding="async"
      />
    );
  }
  return (
    <audio
      className="taskResultPreviewMedia taskResultPreviewMediaAudio"
      data-testid="task-result-preview-media"
      aria-label="任务生成结果音频"
      src={asset.url}
      controls
      tabIndex={0}
      preload="metadata"
    />
  );
}

function TaskResultLinks({
  detail,
  observability,
}: {
  detail: any;
  observability: PublicTaskObservability | null;
}) {
  const assets = taskResultAssets(detail);
  const [previewAsset, setPreviewAsset] = useState<TaskResultAsset | null>(null);
  if (!assets.length) return null;
  return (
    <>
      <div data-testid="task-result-links" className="taskResultLinks">
        <strong>结果：</strong>
        <span className="taskResultActions">
          {assets.map((asset, index) => {
            const suffix = index === 0 ? "" : ` ${index + 1}`;
            return (
              <span className="taskResultActionGroup" key={asset.url}>
                {asset.mediaKind ? (
                  <button
                    type="button"
                    className="taskResultAction"
                    aria-label={`预览结果${suffix}`}
                    onClick={() => setPreviewAsset(asset)}
                  >
                    预览
                  </button>
                ) : null}
                <a
                  className="taskResultAction"
                  href={asset.url}
                  download
                  aria-label={`下载结果${suffix}`}
                  data-generation-correlation-digest={observability?.correlation.generationDigest}
                  data-task-correlation-digest={observability?.correlation.taskDigest}
                  data-project-correlation-digest={observability?.correlation.projectDigest || undefined}
                  data-asset-correlation-digest={asset.assetDigest}
                  data-content-sha256={asset.contentSha256}
                >
                  下载
                </a>
              </span>
            );
          })}
        </span>
      </div>
      <Dialog
        open={Boolean(previewAsset)}
        title="任务结果预览"
        description="在当前页面检查生成结果，下载操作仍保留在任务详情中。"
        closeLabel="关闭预览"
        size="xl"
        data-testid="task-result-preview-dialog"
        contentClassName="taskResultPreviewDialogContent"
        onOpenChange={(open) => {
          if (!open) setPreviewAsset(null);
        }}
      >
        {previewAsset ? (
          <div className="taskResultPreviewFrame">
            <TaskResultPreviewMedia asset={previewAsset} />
          </div>
        ) : null}
      </Dialog>
    </>
  );
}

function stateColors(status: CreativeTaskStatus): React.CSSProperties {
  if (status === "succeeded") return { color: "#16a34a", fontWeight: 700 };
  if (status === "failed") return { color: "var(--front-danger)", fontWeight: 700, cursor: "pointer" };
  if (status === "cancelled") return { color: "var(--front-muted)", fontWeight: 700 };
  return { color: "var(--front-accent)", fontWeight: 700 };
}

export function taskListPollErrorMessage(error: unknown, kind: PollErrorKind): string {
  if (kind === "session") return "登录状态已失效，请重新登录后刷新任务列表";
  if (kind === "stop") return "任务列表不存在或无权访问，已停止自动刷新";
  if (kind === "rate_limit") return "任务状态查询过于频繁，正在稍后重试";
  const detail = error instanceof Error ? error.message.trim() : "";
  return `任务状态暂时无法更新，正在自动重试${detail ? `：${detail}` : ""}`;
}

export default function TaskListPage() {
  const theme = useV4Theme();
  const navigate = useNavigate();
  const currentProjectId = useProjectStore((state) => state.currentProjectId);
  const [pagination, setPagination] = useState({ page: 1, limit: 10, total: 0, loading: false });
  const [categoryOptions, setCategoryOptions] = useState<{ label: string; value: string }[]>([]);
  const [projectData, setProjectData] = useState<{ label: string; value: string }[]>([]);
  const [taskClass, setTaskClass] = useState("");
  const [taskState, setTaskState] = useState("");
  const [projectId, setProjectId] = useState(() => {
    const normalized = positiveSafeInteger(currentProjectId);
    return normalized === null ? "" : String(normalized);
  });
  const [keyword, setKeyword] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [taskList, setTaskList] = useState<TaskItem[]>([]);
  const [detailVisible, setDetailVisible] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [taskDetail, setTaskDetail] = useState<any>(null);
  const [pollErrorText, setPollErrorText] = useState("");
  const [filterErrorText, setFilterErrorText] = useState("");
  const [categoryErrorText, setCategoryErrorText] = useState("");
  const [projectErrorText, setProjectErrorText] = useState("");
  const [taskActionId, setTaskActionId] = useState("");
  const [taskActionError, setTaskActionError] = useState("");
  const pollerRef = useRef<TaskPoller | null>(null);
  const pollContextRef = useRef(0);
  const mountedRef = useRef(true);

  function stopPolling() {
    pollContextRef.current += 1;
    const poller = pollerRef.current;
    pollerRef.current = null;
    poller?.stop();
  }

  function resolveQuery(overrides: TaskListQueryOverrides = {}): TaskListQuery {
    return {
      page: overrides.page ?? pagination.page,
      limit: overrides.limit ?? pagination.limit,
      taskClass: overrides.taskClass ?? taskClass,
      taskState: overrides.taskState ?? taskState,
      projectId: overrides.projectId ?? projectId,
      keyword: overrides.keyword ?? keyword,
      startDate: overrides.startDate ?? startDate,
      endDate: overrides.endDate ?? endDate,
    };
  }

  async function fetchTaskList(query: TaskListQuery): Promise<TaskListResponse> {
    const res: any = await apiPost("/task/getTaskApi", {
      page: query.page,
      limit: query.limit,
      taskClass: query.taskClass,
      state: query.taskState,
      projectId: query.projectId ? Number(query.projectId) : undefined,
      keyword: query.keyword.trim() || undefined,
      startTimeFrom: dateBoundary(query.startDate, "start"),
      startTimeTo: dateBoundary(query.endDate, "end"),
    } as any);
    return normalizeTaskListResponse(res);
  }

  function startPolling(query: TaskListQuery) {
    stopPolling();
    const context = pollContextRef.current;
    const isCurrent = () => mountedRef.current && pollContextRef.current === context;
    const poller = createTaskPoller<TaskListResponse, number>({
      fetchTasks: () => fetchTaskList(query),
      shouldContinue: ({ rows }) => rows.some((row) => (
        shouldPollCreativeTask(normalizeCreativeTaskStatus(row.state))
      )),
      onData: ({ rows, total }) => {
        if (!isCurrent()) return;
        setTaskList(rows);
        setPagination((current) => ({
          ...current,
          page: query.page,
          limit: query.limit,
          total,
        }));
        setPollErrorText("");
      },
      onState: () => undefined,
      onError: (error, kind) => {
        if (!isCurrent()) return;
        setPollErrorText(taskListPollErrorMessage(error, kind));
      },
      onCallbackError: () => {
        if (!isCurrent()) return;
        setPollErrorText("任务状态更新出现异常，可点击立即重试");
      },
      schedule: (callback, delay) => window.setTimeout(callback, delay),
      cancelSchedule: (handle) => window.clearTimeout(handle),
      isVisible: () => document.visibilityState === "visible",
    });
    pollerRef.current = poller;
    return poller;
  }

  async function getTaskList(overrides: TaskListQueryOverrides = {}) {
    const query = resolveQuery(overrides);
    const startTimeFrom = dateBoundary(query.startDate, "start");
    const startTimeTo = dateBoundary(query.endDate, "end");
    if (startTimeFrom !== undefined && startTimeTo !== undefined && startTimeFrom > startTimeTo) {
      setFilterErrorText("开始日期不能晚于结束日期");
      return;
    }
    setFilterErrorText("");
    setPollErrorText("");
    setPagination((current) => ({
      ...current,
      page: query.page,
      limit: query.limit,
      loading: true,
    }));
    const poller = startPolling(query);
    try {
      await poller.refresh();
    } finally {
      if (pollerRef.current === poller && mountedRef.current) {
        setPagination((current) => ({ ...current, loading: false }));
      }
    }
  }

  async function getCategories() {
    try {
      const data: unknown = await apiPost("/task/getTaskCategories", {} as any);
      if (!Array.isArray(data)) throw new Error("任务类型响应格式无效");
      const taskClasses = data.map((item) => {
        if (!item || typeof item !== "object" || typeof (item as any).taskClass !== "string") {
          throw new Error("任务类型响应包含无效项目");
        }
        const value = (item as any).taskClass.trim();
        if (!value) throw new Error("任务类型响应包含空名称");
        return value;
      });
      setCategoryOptions([
        { label: "全部类型", value: "" },
        ...Array.from(new Set(taskClasses)).map((value) => ({ label: value, value })),
      ]);
      setCategoryErrorText("");
    } catch (error) {
      const detail = error instanceof Error ? error.message.trim() : "";
      setCategoryErrorText(`任务类型加载失败${detail ? `：${detail}` : ""}`);
    }
  }

  async function getProject() {
    try {
      const data: unknown = await apiPost("/task/getProject", {} as any);
      if (!Array.isArray(data)) throw new Error("项目列表响应格式无效");
      const projects = data.map((item) => {
        if (!item || typeof item !== "object") throw new Error("项目列表响应包含无效项目");
        const id = positiveSafeInteger((item as any).id);
        const name = typeof (item as any).name === "string" ? (item as any).name.trim() : "";
        if (!id || !name) throw new Error("项目列表响应缺少有效 ID 或名称");
        return { label: name, value: String(id) };
      });
      setProjectData([{ label: "全部项目", value: "" }, ...projects]);
      setProjectErrorText("");
    } catch (error) {
      const detail = error instanceof Error ? error.message.trim() : "";
      setProjectErrorText(`项目列表加载失败${detail ? `：${detail}` : ""}`);
    }
  }

  function onFilterChange(overrides: TaskListQueryOverrides = {}) {
    void getTaskList({ ...overrides, page: 1 });
  }

  useEffect(() => {
    mountedRef.current = true;
    void getTaskList({ page: 1 });
    void getCategories();
    void getProject();
    const handleVisibilityChange = () => {
      void pollerRef.current?.setVisible(document.visibilityState === "visible");
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      mountedRef.current = false;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      stopPolling();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function openTaskDetails(row: TaskItem) {
    setDetailVisible(true);
    setDetailLoading(true);
    setDetailError("");
    setTaskDetail(null);
    try {
      const rowProjectId = positiveSafeInteger(row.projectId);
      const data: any = await apiPost("/task/taskDetails", {
        taskId: row.id,
        source: row.source,
        ...(rowProjectId === null ? {} : { projectId: rowProjectId }),
      } as any);
      setTaskDetail({ ...row, ...data, projectName: data?.projectName || row.projectName });
    } catch (error) {
      setDetailError(error instanceof Error ? error.message : "任务详情加载失败");
    } finally {
      setDetailLoading(false);
    }
  }

  function canCancelTask(row: TaskItem) {
    return row.source === "relay"
      && shouldPollCreativeTask(normalizeCreativeTaskStatus(row.state));
  }

  async function cancelTask(row: TaskItem) {
    if (!canCancelTask(row) || taskActionId) return;
    const id = String(row.id);
    setTaskActionId(id);
    setTaskActionError("");
    try {
      await apiDelete(`/workbench/canvas/tasks/${encodeURIComponent(id)}`);
      setTaskList((current) => current.map((item) => (
        String(item.id) === id ? { ...item, state: "已取消" } : item
      )));
      setTaskDetail((current: any) => (
        current && String(current.id) === id ? { ...current, state: "已取消" } : current
      ));
      await getTaskList();
    } catch (error) {
      setTaskActionError(error instanceof Error ? error.message : "任务取消失败");
    } finally {
      setTaskActionId("");
    }
  }

  function jumpToTask(row: Partial<TaskItem>) {
    const origin = trustedTaskOrigin(row);
    if (!origin) return;
    useProjectStore.getState().selectProject(origin.projectId);
    if (origin.surface === "production") {
      navigate("/workbench/production");
      return;
    }
    if (origin.surface === "quick-create") {
      navigate(buildProjectModeHref("quick", { projectId: origin.projectId }));
      return;
    }
    if (origin.surface === "canvas") {
      navigate(buildProjectModeHref("canvas", { projectId: origin.projectId }));
      return;
    }
    navigate(buildProjectModeHref("agent", { projectId: origin.projectId }));
  }

  function openTaskAssets(observability: PublicTaskObservability) {
    const targetProjectId = positiveSafeInteger(taskDetail?.projectId);
    if (targetProjectId) useProjectStore.getState().selectProject(targetProjectId);
    navigate(`/workbench/assets?tab=history&correlation=${encodeURIComponent(observability.correlation.generationDigest)}`);
  }

  const metadataErrorText = [projectErrorText, categoryErrorText].filter(Boolean).join("；");
  const taskDetailOrigin = trustedTaskOrigin(taskDetail || {});
  const taskDetailRetryable = Boolean(taskDetail)
    && canRetryCreativeTask(normalizeCreativeTaskStatus(taskDetail.state));
  const taskDetailRelatedSummary = summarizeRelatedObjects(taskDetail?.relatedObjects);
  const taskDetailObservability = publicTaskObservability(taskDetail?.observability);
  const selectStyle: React.CSSProperties = { padding: "8px 12px", border: "1px solid var(--front-line)", borderRadius: 8, fontSize: 14, color: "var(--front-text)", outline: "none", background: "var(--front-surface)" };

  return (
    <div className="frontPagePalette frontTaskPage" data-theme={theme.mode}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 650 }}>任务列表</h1>
          <span style={{ fontSize: 13, color: "var(--front-muted)" }}>查看生成任务的状态与详情</span>
        </div>
        <button onClick={() => void getTaskList()} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 16px", border: "1px solid var(--front-line)", borderRadius: 8, background: "var(--front-surface)", color: "var(--front-text)", cursor: "pointer", fontSize: 14 }}>
          <RefreshCw size={16} /> 刷新
        </button>
      </div>

      {pollErrorText ? (
        <div
          role="status"
          data-testid="task-poll-recovery"
          style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 16, padding: "10px 12px", border: "1px solid var(--front-warning-line)", borderRadius: 8, background: "var(--front-warning-bg)", color: "var(--front-warning)", fontSize: 13 }}
        >
          <span>{pollErrorText}</span>
          <button type="button" onClick={() => void getTaskList()} style={{ flex: "0 0 auto", border: 0, background: "transparent", color: "var(--front-warning)", cursor: "pointer", fontWeight: 700 }}>
            立即重试
          </button>
        </div>
      ) : null}
      {filterErrorText ? (
        <div role="alert" style={{ marginBottom: 16, padding: "10px 12px", border: "1px solid var(--front-danger-line)", borderRadius: 8, background: "var(--front-danger-bg)", color: "var(--front-danger)", fontSize: 13 }}>
          {filterErrorText}
        </div>
      ) : null}
      {metadataErrorText ? (
        <div
          role="alert"
          data-testid="task-filter-load-error"
          style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 16, padding: "10px 12px", border: "1px solid var(--front-danger-line)", borderRadius: 8, background: "var(--front-danger-bg)", color: "var(--front-danger)", fontSize: 13 }}
        >
          <span>{metadataErrorText}</span>
          <button
            type="button"
            onClick={() => {
              void getProject();
              void getCategories();
            }}
            style={{ flex: "0 0 auto", border: 0, background: "transparent", color: "var(--front-danger)", cursor: "pointer", fontWeight: 700 }}
          >
            重试筛选项
          </button>
        </div>
      ) : null}
      {taskActionError ? (
        <div role="alert" data-testid="task-action-error" style={{ marginBottom: 16, padding: "10px 12px", border: "1px solid var(--front-danger-line)", borderRadius: 8, background: "var(--front-danger-bg)", color: "var(--front-danger)", fontSize: 13 }}>
          {taskActionError}
        </div>
      ) : null}

      <div className="frontTaskFilters">
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--front-muted)" }}>项目
          <select aria-label="项目" data-testid="task-project-filter" value={projectId} onChange={(e) => { const next = e.target.value; setProjectId(next); onFilterChange({ projectId: next }); }} style={selectStyle}>
            {projectData.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--front-muted)" }}>任务类型
          <select aria-label="任务类型" data-testid="task-class-filter" value={taskClass} onChange={(e) => { const next = e.target.value; setTaskClass(next); onFilterChange({ taskClass: next }); }} style={selectStyle}>
            {categoryOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--front-muted)" }}>状态
          <select aria-label="状态" data-testid="task-state-filter" value={taskState} onChange={(e) => { const next = e.target.value; setTaskState(next); onFilterChange({ taskState: next }); }} style={selectStyle}>
            {stateOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--front-muted)" }}>搜索
          <input
            aria-label="搜索任务"
            data-testid="task-keyword-input"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") onFilterChange({ keyword }); }}
            placeholder="任务 ID 或描述"
            style={{ ...selectStyle, minWidth: 220 }}
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--front-muted)" }}>开始日期
          <input
            aria-label="开始日期"
            data-testid="task-start-date-filter"
            type="date"
            value={startDate}
            onChange={(event) => setStartDate(event.target.value)}
            style={selectStyle}
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--front-muted)" }}>结束日期
          <input
            aria-label="结束日期"
            data-testid="task-end-date-filter"
            type="date"
            value={endDate}
            onChange={(event) => setEndDate(event.target.value)}
            style={selectStyle}
          />
        </label>
        <button
          data-testid="task-search-button"
          onClick={() => onFilterChange({ keyword, startDate, endDate })}
          style={{ alignSelf: "flex-end", display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 14px", border: 0, borderRadius: 8, background: "var(--front-accent)", color: "#fff", cursor: "pointer", fontSize: 14 }}
        >
          <Search size={16} /> 搜索
        </button>
      </div>

      <div style={{ border: "1px solid var(--front-line)", borderRadius: 18, overflow: "hidden", background: "var(--front-surface)" }}>
        <div style={{ overflowX: "auto" }}>
          <table data-testid="task-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: "var(--front-soft)" }}>
                {columns.map((c) => (
                  <th key={c.key} style={{ textAlign: "left", padding: "10px 12px", color: "var(--front-muted)", fontWeight: 600, whiteSpace: "nowrap" }}>{c.title}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {!pagination.loading && taskList.map((row) => {
                const status = normalizeCreativeTaskStatus(row.state);
                const origin = trustedTaskOrigin(row);
                const retryable = canRetryCreativeTask(status);
                const relatedSummary = summarizeRelatedObjects(row.relatedObjects);
                return (
	                  <tr key={row.id} data-testid="task-row" data-task-state={row.state} data-task-id={String(row.id)} data-task-class={row.taskClass} style={{ borderBottom: "1px solid var(--front-line)" }}>
                    <td style={{ padding: "10px 12px", color: "var(--front-text)" }}>{row.taskClass}</td>
                    <td
                      data-testid="task-related-summary"
                      title={relatedSummary}
                      style={{ padding: "10px 12px", color: "var(--front-muted)", maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                    >
                      {relatedSummary}
                    </td>
                    <td data-testid="task-model-summary" style={{ padding: "10px 12px", color: "var(--front-muted)", maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{publicTaskModelLabel(row.model)}</td>
                    <td style={{ padding: "10px 12px", color: "var(--front-muted)" }}>{row.describe || "-"}</td>
                    <td style={{ padding: "10px 12px", color: "var(--front-danger)", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.reason || "-"}</td>
                    <td style={{ padding: "10px 12px" }}>
                      <span title={status === "failed" ? row.reason || "无失败原因" : undefined} style={stateColors(status)}>{creativeTaskStatusLabel(status)}</span>
                    </td>
                    <td style={{ padding: "10px 12px", color: "var(--front-muted)", whiteSpace: "nowrap" }}>{formatTime(row.startTime)}</td>
                    <td style={{ padding: "10px 12px" }}>
                      <div style={{ display: "flex", gap: 6 }}>
                        <button data-testid="task-detail-button" onClick={() => openTaskDetails(row)} style={{ border: 0, background: "transparent", color: "var(--front-accent)", cursor: "pointer", fontSize: 13, padding: 0 }}>详情</button>
                        {origin ? (
                          <button
                            type="button"
                            title={retryable ? "任务中心不直接重放付费请求；返回原工作流后由原业务恢复提交凭证" : undefined}
                            onClick={() => jumpToTask(row)}
                            style={{ border: 0, background: "transparent", color: "var(--front-accent)", cursor: "pointer", fontSize: 13, padding: 0 }}
                          >
                            {retryable ? "定位后重试" : "定位"}
                          </button>
                        ) : null}
                        {canCancelTask(row) ? (
                          <button
                            type="button"
                            onClick={() => void cancelTask(row)}
                            disabled={Boolean(taskActionId)}
                            style={{ border: 0, background: "transparent", color: "var(--front-danger)", cursor: taskActionId ? "wait" : "pointer", fontSize: 13, padding: 0 }}
                          >
                            {taskActionId === String(row.id) ? "取消中…" : "取消任务"}
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {pagination.loading ? (
          <div className="frontTaskEmpty" role="status">加载中…</div>
        ) : taskList.length === 0 ? (
          <div className="frontTaskEmpty" data-testid={pollErrorText ? "task-list-load-error" : undefined} style={{ color: pollErrorText ? "var(--front-danger)" : undefined }}>
            {pollErrorText ? "任务列表加载失败，请使用上方“立即重试”" : "暂无任务"}
          </div>
        ) : null}
      </div>

      <div className="frontTaskPagination">
        <span>共 {pagination.total} 条</span>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <select aria-label="每页数量" data-testid="task-page-size" value={pagination.limit} onChange={(e) => { const next = Number(e.target.value); void getTaskList({ limit: next, page: 1 }); }} style={selectStyle}>
            <option value={10}>10 条/页</option>
            <option value={20}>20 条/页</option>
            <option value={50}>50 条/页</option>
          </select>
          <button data-testid="task-prev-page" disabled={pagination.page <= 1} onClick={() => void getTaskList({ page: pagination.page - 1 })} style={{ padding: "6px 12px", border: "1px solid var(--front-line)", borderRadius: 6, background: "var(--front-surface)", cursor: pagination.page <= 1 ? "not-allowed" : "pointer", opacity: pagination.page <= 1 ? 0.5 : 1 }}>上一页</button>
          <span>第 {pagination.page} 页</span>
          <button data-testid="task-next-page" disabled={pagination.page * pagination.limit >= pagination.total} onClick={() => void getTaskList({ page: pagination.page + 1 })} style={{ padding: "6px 12px", border: "1px solid var(--front-line)", borderRadius: 6, background: "var(--front-surface)", cursor: pagination.page * pagination.limit >= pagination.total ? "not-allowed" : "pointer", opacity: pagination.page * pagination.limit >= pagination.total ? 0.5 : 1 }}>下一页</button>
        </div>
      </div>

      <Dialog
        open={detailVisible}
        title="任务详情"
        closeLabel="关闭任务详情"
        size="lg"
        data-testid="task-detail-dialog"
        contentClassName="taskDetailDialogContent"
        onOpenChange={(open) => {
          if (!open) setDetailVisible(false);
        }}
      >
        {detailLoading ? (
                <div style={{ textAlign: "center", color: "var(--front-muted)", padding: 32 }}>正在加载任务详情</div>
              ) : detailError ? (
                <div role="alert" style={{ display: "grid", justifyItems: "center", gap: 10, textAlign: "center", color: "var(--front-danger)", padding: 32 }}>
                  <strong>任务详情加载失败</strong>
                  <span>{detailError}</span>
                </div>
              ) : taskDetail ? (
                <div
                  style={{ display: "grid", gap: 14 }}
                  data-generation-correlation-digest={taskDetailObservability?.correlation.generationDigest}
                  data-task-correlation-digest={taskDetailObservability?.correlation.taskDigest}
                  data-project-correlation-digest={taskDetailObservability?.correlation.projectDigest || undefined}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <strong style={{ color: "var(--front-text)" }}>{taskDetail.taskClass || "任务"}</strong>
                    <span style={{ padding: "2px 10px", borderRadius: 999, fontSize: 12, background: "#d7e9ff", color: "var(--front-accent)" }}>{taskDetail.state || "-"}</span>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1, background: "var(--front-line)", border: "1px solid var(--front-line)", borderRadius: 8, overflow: "hidden" }}>
                    {[
                      ["项目", taskDetail.projectName || "未命名项目"],
                      ["模型", publicTaskModelLabel(taskDetail.model)],
                      ["开始时间", formatTime(taskDetail.startTime)],
                    ].map(([k, v]) => (
                      <React.Fragment key={String(k)}>
                        <div style={{ background: "var(--front-soft)", padding: "8px 12px", fontSize: 12, color: "var(--front-muted)" }}>{k}</div>
                        <div style={{ background: "var(--front-surface)", padding: "8px 12px", fontSize: 13, color: "var(--front-text)" }}>{String(v ?? "-")}</div>
                      </React.Fragment>
                    ))}
                  </div>
	                  <div style={{ padding: "8px 12px", border: "1px solid var(--front-line)", borderRadius: 8, fontSize: 13, color: "var(--front-text)" }}><strong>描述：</strong>{taskDetail.describe || "-"}</div>
	                  {taskDetailObservability ? (
	                    <section data-testid="task-detail-observability" aria-label="任务请求信息" style={{ display: "grid", gap: 8, padding: "10px 12px", border: "1px solid var(--front-line)", borderRadius: 8, background: "var(--front-soft)" }}>
	                      <div style={{ fontSize: 13, color: "var(--front-text)" }}><strong>脱敏 Prompt：</strong>{taskDetailObservability.prompt || "未提供"}</div>
	                      <div style={{ fontSize: 13, color: "var(--front-text)" }}><strong>请求引用：</strong><code data-testid="task-request-ref">{taskDetailObservability.requestRef}</code></div>
	                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
	                        {Object.entries(taskDetailObservability.parameters).length ? Object.entries(taskDetailObservability.parameters).map(([key, value]) => (
	                          <span key={key} data-testid="task-parameter" data-parameter-name={key} style={{ padding: "3px 7px", border: "1px solid var(--front-line)", borderRadius: 6, background: "var(--front-surface)", color: "var(--front-muted)", fontSize: 12 }}>
	                            {taskParameterLabels[key] || key}：{typeof value === "boolean" ? (value ? "是" : "否") : String(value)}
	                          </span>
	                        )) : <span style={{ color: "var(--front-muted)", fontSize: 12 }}>未提供可公开参数</span>}
	                      </div>
	                    </section>
	                  ) : null}
	                  {taskDetail.reason && <div style={{ padding: "8px 12px", border: "1px solid var(--front-danger-line)", borderRadius: 8, fontSize: 13, color: "var(--front-danger)", background: "var(--front-danger-bg)" }}><strong>失败原因：</strong>{taskDetail.reason}</div>}
	                  <TaskResultLinks detail={taskDetail} observability={taskDetailObservability} />
	                  {taskDetailObservability && taskResultAssets(taskDetail).length ? (
	                    <button type="button" data-testid="task-associated-assets" onClick={() => openTaskAssets(taskDetailObservability)} style={{ justifySelf: "start", padding: "7px 12px", border: "1px solid #c7dff2", borderRadius: 8, background: "#f4f9fd", color: "#315d7c", cursor: "pointer", fontSize: 13 }}>
	                      查看关联资产（{taskResultAssets(taskDetail).length}）
	                    </button>
	                  ) : null}
	                  {taskDetailRetryable ? (
		                    <div role="status" style={{ padding: "8px 12px", border: "1px solid var(--front-warning-line)", borderRadius: 8, fontSize: 13, color: "var(--front-warning)", background: "var(--front-warning-bg)" }}>
		                      {taskDetailOrigin
		                        ? "为防止重复扣费，任务中心不会直接重放付费请求。请定位到原工作流，由原业务恢复提交凭证后重试。"
		                        : "该任务缺少可信的原工作流定位信息。为防止误跳转或重复扣费，任务中心不提供重试入口。"}
		                    </div>
		                  ) : null}
	                  <div>
                    <div style={{ fontSize: 12, color: "var(--front-muted)", marginBottom: 4 }}>关联对象</div>
                    <div
                      data-testid="task-detail-related-summary"
                      style={{ padding: 10, background: "var(--front-soft)", borderRadius: 8, fontSize: 13, lineHeight: 1.5, color: "var(--front-text)" }}
                    >
                      {taskDetailRelatedSummary}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    {canCancelTask(taskDetail) ? (
                      <button
                        type="button"
                        onClick={() => void cancelTask(taskDetail)}
                        disabled={Boolean(taskActionId)}
                        style={{ flex: 1, padding: "10px 0", border: "1px solid var(--front-danger-line)", borderRadius: 8, background: "var(--front-surface)", color: "var(--front-danger)", cursor: taskActionId ? "wait" : "pointer" }}
                      >
                        {taskActionId === String(taskDetail.id) ? "取消中…" : "取消任务"}
                      </button>
                    ) : null}
                    {taskDetailOrigin ? (
                      <button onClick={() => jumpToTask(taskDetail)} style={{ flex: 1, padding: "10px 0", border: "1px solid var(--front-line)", borderRadius: 8, background: "var(--front-surface)", color: "var(--front-text)", cursor: "pointer" }}>
                        {taskDetailRetryable ? "定位后重试" : "定位到工作流"}
                      </button>
                    ) : null}
                    <button onClick={() => void getTaskList()} style={{ flex: 1, padding: "10px 0", border: 0, borderRadius: 8, background: "var(--front-accent)", color: "#fff", cursor: "pointer" }}>刷新列表</button>
                  </div>
                </div>
              ) : (
                <div style={{ textAlign: "center", color: "var(--front-muted)", padding: 32 }}>未找到任务详情</div>
	        )}
      </Dialog>
    </div>
  );
}
