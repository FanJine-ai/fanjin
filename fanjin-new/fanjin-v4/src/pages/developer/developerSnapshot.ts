import { GU_MICROS_PER_GU } from "@/utils/billingUnits";
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiPost } from "../../api/http";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { extractItems, unwrapPayload } from "../console/ConsoleAdminShared";
import {
  type CatalogItem,
  type CatalogSummary,
  useDeveloperCatalog,
} from "./useDeveloperCatalog";

type LoadState<T> = {
  loading: boolean;
  error: string;
  data: T;
};

export type DeveloperTaskRecord = {
  id?: string | number;
  taskId?: string | number;
  requestId?: string | null;
  providerTaskId?: string | null;
  model?: string | null;
  modelName?: string | null;
  state?: string | null;
  status?: string | null;
  stage?: string | null;
  stage_label?: string | null;
  progress?: number | null;
  progress_percent?: number | null;
  created_at?: number | null;
  startTime?: number | string | null;
  createdAt?: number | string | null;
  createTime?: number | string | null;
};

export type DeveloperRequestLogRecord = {
  id?: string | number;
  requestId?: string | null;
  createdAt?: number | string | null;
  method?: string | null;
  path?: string | null;
  statusCode?: string | number | null;
  model?: string | null;
  apiKeyPrefix?: string | null;
  capability?: string | null;
  metadata?: unknown;
};

export type DeveloperRequestLogStats = {
  total?: number;
  status2xx?: number;
  avgDurationMs?: number;
};

export type DeveloperPage<T> = {
  items: T[];
  total: number;
  pageNum: number;
  pageSize: number;
};

export type DeveloperRequestLogPage = DeveloperPage<DeveloperRequestLogRecord> & {
  stats: DeveloperRequestLogStats;
};

const emptyTaskPage: DeveloperPage<DeveloperTaskRecord> = { items: [], total: 0, pageNum: 1, pageSize: 20 };
const emptyRequestLogPage: DeveloperRequestLogPage = { items: [], total: 0, pageNum: 1, pageSize: 20, stats: {} };
export const developerRequestLogCapabilities = [
  "text",
  "image",
  "video",
  "embedding",
  "audio",
  "rerank",
  "other",
] as const;

export type DeveloperRequestLogCapability = (typeof developerRequestLogCapabilities)[number];
export type DeveloperRequestLogCapabilityFilter = "" | DeveloperRequestLogCapability;

export function developerRequestLogCapability(value: string | null): DeveloperRequestLogCapabilityFilter {
  return developerRequestLogCapabilities.includes(value as DeveloperRequestLogCapability)
    ? value as DeveloperRequestLogCapability
    : "";
}

const requestLogExtraPayloads: Record<
  DeveloperRequestLogCapabilityFilter,
  Record<string, unknown>
> = {
  "": { days: 7 },
  text: { days: 7, capability: "text" },
  image: { days: 7, capability: "image" },
  video: { days: 7, capability: "video" },
  embedding: { days: 7, capability: "embedding" },
  audio: { days: 7, capability: "audio" },
  rerank: { days: 7, capability: "rerank" },
  other: { days: 7, capability: "other" },
};

export function positiveDeveloperPage(value: string | null) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

export function developerPageSize(value: string | null) {
  const parsed = Number(value);
  return [20, 50, 100].includes(parsed) ? parsed : 20;
}

function developerPageErrorMessage(error: unknown) {
  let status: unknown;
  try {
    const descriptor = error
      && (typeof error === "object" || typeof error === "function")
      ? Object.getOwnPropertyDescriptor(error, "status")
      : undefined;
    status = descriptor && "value" in descriptor
      ? descriptor.value
      : undefined;
  } catch {
    status = undefined;
  }
  if (status === 401) return "登录状态已失效，当前工作区数据读取失败（401）。";
  if (status === 403) return "无权读取当前工作区数据（403）。";
  if (status === 503) return "当前工作区数据服务暂不可用（503）。";
  return "当前工作区数据读取失败，请稍后重试。";
}

function useDeveloperPage<T extends DeveloperPage<unknown>>(
  path: string,
  pageNum: number,
  pageSize: number,
  emptyData: T,
  extraPayload?: Record<string, unknown>,
) {
  const currentWorkspaceId = useWorkspaceStore((state) => state.currentWorkspaceId);
  const requestedWorkspaceId = currentWorkspaceId == null
    ? ""
    : String(currentWorkspaceId).trim();
  const [retryKey, setRetryKey] = useState(0);
  const [state, setState] = useState<LoadState<T> & {
    settledPageNum: number | null;
    settledPageSize: number | null;
    workspaceId: string;
  }>({
    loading: true,
    error: "",
    data: emptyData,
    settledPageNum: null,
    settledPageSize: null,
    workspaceId: requestedWorkspaceId,
  });

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setState({
      loading: true,
      error: "",
      data: emptyData,
      settledPageNum: null,
      settledPageSize: null,
      workspaceId: requestedWorkspaceId,
    });
    const payload: Record<string, unknown> = { ...extraPayload, pageNum, pageSize };
    if (requestedWorkspaceId) payload.workspaceId = requestedWorkspaceId;

    void apiPost<T>(path, payload, undefined, { signal: controller.signal })
      .then((data) => {
        if (!active) return;
        setState({
          loading: false,
          error: "",
          data,
          settledPageNum: pageNum,
          settledPageSize: pageSize,
          workspaceId: requestedWorkspaceId,
        });
      })
      .catch((error: unknown) => {
        if (!active || controller.signal.aborted) return;
        setState({
          loading: false,
          error: developerPageErrorMessage(error),
          data: emptyData,
          settledPageNum: pageNum,
          settledPageSize: pageSize,
          workspaceId: requestedWorkspaceId,
        });
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [emptyData, extraPayload, pageNum, pageSize, path, requestedWorkspaceId, retryKey]);

  const visibleState = state.workspaceId === requestedWorkspaceId
    ? state
    : {
        loading: true,
        error: "",
        data: emptyData,
        settledPageNum: null,
        settledPageSize: null,
        workspaceId: requestedWorkspaceId,
      };
  const responsePageNum = Number(visibleState.data.pageNum);
  const currentRequestSettled = visibleState.settledPageNum === pageNum
    && visibleState.settledPageSize === pageSize;
  const loading = visibleState.loading || !currentRequestSettled;
  const effectivePageNum = !loading
    && !visibleState.error
    && Number.isInteger(responsePageNum)
    && responsePageNum > 0
    ? responsePageNum
    : pageNum;

  return {
    loading,
    error: visibleState.error,
    data: visibleState.data,
    effectivePageNum,
    retry: () => setRetryKey((current) => current + 1),
  };
}

export function useDeveloperTasksPage(
  pageNum: number,
  pageSize: number,
  filters?: Record<string, unknown>,
) {
  return useDeveloperPage("/developer/tasks", pageNum, pageSize, emptyTaskPage, filters);
}

export function useDeveloperRequestLogsPage(
  pageNum: number,
  pageSize: number,
  capability: DeveloperRequestLogCapabilityFilter = "",
) {
  return useDeveloperPage(
    "/developer/requestLogs",
    pageNum,
    pageSize,
    emptyRequestLogPage,
    requestLogExtraPayloads[capability],
  );
}

export type SnapshotAvailability = {
  overview: boolean;
  tasks: boolean;
  models: boolean;
};

export type SnapshotModelSummary = CatalogSummary;

export type WorkspaceSnapshot = {
  overview: any;
  apiKeyCount: number;
  tasks: any[];
  models: CatalogItem[];
  modelSummary: SnapshotModelSummary;
  availability: SnapshotAvailability;
};

export const emptySnapshot: WorkspaceSnapshot = {
  overview: null,
  apiKeyCount: 0,
  tasks: [],
  models: [],
  modelSummary: { total: 0, active: 0, unavailable: 0 },
  availability: { overview: false, tasks: false, models: false },
};

export function useWorkspaceSnapshot() {
  const currentWorkspaceId = useWorkspaceStore((store) => store.currentWorkspaceId);
  const requestedWorkspaceId = currentWorkspaceId == null
    ? ""
    : String(currentWorkspaceId).trim();
  const catalogState = useDeveloperCatalog();
  const [retryKey, setRetryKey] = useState(0);
  const [state, setState] = useState<LoadState<WorkspaceSnapshot> & {
    workspaceId: string;
  }>({
    loading: true,
    error: "",
    data: emptySnapshot,
    workspaceId: requestedWorkspaceId,
  });

  useEffect(() => {
    const controller = new AbortController();
    let alive = true;

    async function load() {
      setState({
        loading: true,
        error: "",
        data: emptySnapshot,
        workspaceId: requestedWorkspaceId,
      });
      const workspacePayload = requestedWorkspaceId
        ? { workspaceId: requestedWorkspaceId }
        : {};
      const [overview, tasks] = await Promise.allSettled([
        apiPost<any>("/developer/overview", workspacePayload, undefined, { signal: controller.signal }),
        apiPost<any>("/developer/tasks", { ...workspacePayload, pageNum: 1, pageSize: 100 }, undefined, { signal: controller.signal }),
      ]);
      if (!alive || controller.signal.aborted) return;
      const errors = [
        overview.status === "rejected" ? "开发者概览读取失败" : "",
        tasks.status === "rejected" ? "开发者任务读取失败" : "",
      ].filter(Boolean);
      const overviewPayload = overview.status === "fulfilled" ? unwrapPayload(overview.value) : null;
      setState({
        loading: false,
        error: errors.join("；"),
        workspaceId: requestedWorkspaceId,
        data: {
          overview: overviewPayload,
          apiKeyCount: Number(overviewPayload?.summary?.activeKeys || 0),
          tasks: tasks.status === "fulfilled" ? extractItems(unwrapPayload(tasks.value)) : [],
          models: [],
          modelSummary: { total: 0, active: 0, unavailable: 0 },
          availability: {
            overview: overview.status === "fulfilled",
            tasks: tasks.status === "fulfilled",
            models: false,
          },
        },
      });
    }
    void load();
    return () => {
      alive = false;
      controller.abort();
    };
  }, [requestedWorkspaceId, retryKey]);

  const visibleState = state.workspaceId === requestedWorkspaceId
    ? state
    : {
        loading: true,
        error: "",
        data: emptySnapshot,
        workspaceId: requestedWorkspaceId,
      };
  const retry = useCallback(() => {
    setRetryKey((key) => key + 1);
    catalogState.retry();
  }, [catalogState.retry]);
  return useMemo(() => {
    const errors = [visibleState.error, catalogState.error].filter(Boolean);
    return {
      loading: visibleState.loading || catalogState.loading,
      error: errors.join("；"),
      retry,
      data: {
        ...visibleState.data,
        models: catalogState.catalog.items,
        modelSummary: catalogState.catalog.summary,
        availability: {
          ...visibleState.data.availability,
          models: !catalogState.loading && !catalogState.error,
        },
      },
    };
  }, [catalogState, retry, visibleState]);
}

export function formatGu(value?: number | string | null) {
  if (value == null || value === "") return "-";
  const micros = Number(value);
  if (!Number.isFinite(micros)) return "-";
  return `${(micros / GU_MICROS_PER_GU).toLocaleString("zh-CN", { maximumFractionDigits: 4 })} GU`;
}

export function formatDate(value?: number | string | null) {
  if (!value) return "-";
  const date = new Date(typeof value === "number" && value < 10_000_000_000 ? value * 1000 : value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

export function statusTone(status: string) {
  const normalized = String(status || "").trim().toLowerCase();
  if (["active", "enabled", "online", "success", "approved", "succeeded"].includes(normalized)) return "success" as const;
  if (["pending", "queued", "running", "enhancing", "beta", "unavailable"].includes(normalized)) return "warning" as const;
  if (["failed", "disabled", "rejected"].includes(normalized)) return "danger" as const;
  return "neutral" as const;
}

export function statusLabel(status: string) {
  const normalized = String(status || "").trim().toLowerCase();
  return ({
    active: "正常",
    enabled: "启用",
    online: "在线",
    success: "成功",
    approved: "已通过",
    pending: "待处理",
    queued: "排队中",
    running: "执行中",
    enhancing: "处理中",
    mocked: "测试模拟（非真实结果）",
    succeeded: "已完成",
    unavailable: "暂不可用",
    cancelled: "已取消",
    beta: "Beta",
    failed: "失败",
    disabled: "停用",
    rejected: "未通过",
  } as Record<string, string>)[normalized] || status;
}
