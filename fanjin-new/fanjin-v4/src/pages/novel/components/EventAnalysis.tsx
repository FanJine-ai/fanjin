import React, { useEffect, useRef, useState } from "react";
import { apiPost } from "../../../api/http";

interface EventAnalysisProps {
  open: boolean;
  onClose: () => void;
  selectedIds: (number | string)[];
  projectId?: number | string;
}

type EventAnalysisResult = {
  id: number;
  event?: unknown;
  eventState?: number;
  errorReason?: string | null;
};

type EventAnalysisTask = {
  taskId: number;
  projectId: number;
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "pending_reconcile";
  phase: string;
  cancelAllowed: boolean;
  retryAllowed: boolean;
  model: string;
  completedIds: number[];
  failedIds: number[];
  currentNovelId: number | null;
  reason: string | null;
};

type StoredEventAnalysisAttempt = {
  taskId?: number;
  novelIds: number[];
  idempotencyKey: string;
  model?: string;
};

function eventText(value: unknown) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function normalizeNovelIds(values: (number | string)[]) {
  return values
    .map(Number)
    .filter((id) => Number.isSafeInteger(id) && id > 0);
}

function attemptStorageKey(projectId: number, novelIds: number[]) {
  const selection = [...novelIds].sort((left, right) => left - right).join(",");
  return `fanjin:novel-event-analysis:${projectId}:${selection}`;
}

function readStoredAttempt(key: string): StoredEventAnalysisAttempt | null {
  if (!key) return null;
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "null");
    const novelIds = Array.isArray(parsed?.novelIds)
      ? normalizeNovelIds(parsed.novelIds)
      : [];
    const idempotencyKey = String(parsed?.idempotencyKey || "").trim();
    const taskId = Number(parsed?.taskId || 0);
    const model = String(parsed?.model || "").trim();
    if (!novelIds.length || new Set(novelIds).size !== novelIds.length || !idempotencyKey) {
      return null;
    }
    return {
      novelIds,
      idempotencyKey,
      ...(Number.isSafeInteger(taskId) && taskId > 0 ? { taskId } : {}),
      ...(model ? { model } : {}),
    };
  } catch {
    return null;
  }
}

function writeStoredAttempt(key: string, attempt: StoredEventAnalysisAttempt) {
  localStorage.setItem(key, JSON.stringify(attempt));
}

function removeStoredAttempt(key: string, idempotencyKey: string) {
  const stored = readStoredAttempt(key);
  if (stored?.idempotencyKey === idempotencyKey) localStorage.removeItem(key);
}

function newIdempotencyKey(projectId: number) {
  const uuid = typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `novel-event:${projectId}:${uuid}`;
}

export default function EventAnalysis({ open, onClose, selectedIds, projectId }: EventAnalysisProps) {
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<EventAnalysisResult[]>([]);
  const [task, setTask] = useState<EventAnalysisTask | null>(null);
  const [error, setError] = useState("");
  const operationEpochRef = useRef(0);
  const numericProjectId = Number(projectId);
  const normalizedSelectedIds = normalizeNovelIds(selectedIds);
  const selectedIdsSignature = [...normalizedSelectedIds]
    .sort((left, right) => left - right)
    .join(",");

  useEffect(() => () => {
    operationEpochRef.current += 1;
  }, []);

  async function fetchResults(novelIds: number[], epoch: number) {
    const response: any = await apiPost("/novel/getNovelEventState", { ids: novelIds } as any);
    if (operationEpochRef.current !== epoch) return;
    const rows = Array.isArray(response) ? response : [];
    setResults(rows.map((item: any) => ({
      id: Number(item.id),
      event: item.event,
      eventState: Number(item.eventState || 0),
      errorReason: item.errorReason ? String(item.errorReason) : null,
    })));
  }

  async function resumeSubmission(
    project: number,
    novelIds: number[],
    idempotencyKey: string,
    model?: string,
  ) {
    return await apiPost(
      "/novel/event/generateEvents",
      {
        projectId: project,
        novelIds,
        ...(model ? { model } : {}),
      } as any,
      undefined,
      { headers: { "Idempotency-Key": idempotencyKey } },
    ) as any;
  }

  async function pollTask(
    taskId: number,
    novelIds: number[],
    idempotencyKey: string,
    model: string,
    epoch: number,
    storageKey: string,
  ) {
    for (let attempt = 0; attempt < 240; attempt += 1) {
      if (operationEpochRef.current !== epoch) return;
      const response: any = await apiPost("/novel/event/generateEvents/status", {
        projectId: numericProjectId,
        taskIds: [taskId],
      } as any);
      const current = Array.isArray(response) ? response[0] : null;
      if (!current) throw new Error("事件分析任务不存在或已不可用");
      setTask(current);
      if (["succeeded", "failed", "cancelled", "pending_reconcile"].includes(current.state)) {
        await fetchResults(novelIds, epoch);
        if (current.state !== "pending_reconcile") {
          removeStoredAttempt(storageKey, idempotencyKey);
        }
        return;
      }
      if (attempt > 0 && attempt % 120 === 0) {
        await resumeSubmission(numericProjectId, novelIds, idempotencyKey, model);
      }
      await new Promise((resolve) => window.setTimeout(resolve, 1_500));
    }
    throw new Error("事件分析仍在后台运行，请稍后重新打开本窗口检查任务状态");
  }

  async function runAnalysis() {
    const novelIds = normalizedSelectedIds;
    if (
      !Number.isSafeInteger(numericProjectId)
      || numericProjectId <= 0
      || !novelIds.length
      || new Set(novelIds).size !== novelIds.length
    ) {
      setError("缺少有效项目或章节，已阻止提交");
      return;
    }
    const epoch = operationEpochRef.current + 1;
    operationEpochRef.current = epoch;
    setLoading(true);
    setResults([]);
    setTask(null);
    setError("");
    const storageKey = attemptStorageKey(numericProjectId, novelIds);
    const stored = readStoredAttempt(storageKey);
    const idempotencyKey = stored?.idempotencyKey || newIdempotencyKey(numericProjectId);
    const submittedNovelIds = stored?.novelIds || novelIds;
    writeStoredAttempt(storageKey, {
      novelIds: submittedNovelIds,
      idempotencyKey,
      ...(stored?.taskId ? { taskId: stored.taskId } : {}),
      ...(stored?.model ? { model: stored.model } : {}),
    });
    try {
      const response: any = await resumeSubmission(
        numericProjectId,
        submittedNovelIds,
        idempotencyKey,
        stored?.model,
      );
      const submitted = response?.task as EventAnalysisTask | undefined;
      if (!submitted?.taskId) throw new Error("事件分析任务未返回持久任务标识");
      writeStoredAttempt(storageKey, {
        taskId: submitted.taskId,
        novelIds: submittedNovelIds,
        idempotencyKey,
        model: submitted.model,
      });
      setTask(submitted);
      await pollTask(
        submitted.taskId,
        submittedNovelIds,
        idempotencyKey,
        submitted.model,
        epoch,
        storageKey,
      );
    } catch (requestError) {
      if (operationEpochRef.current !== epoch) return;
      setError(requestError instanceof Error ? requestError.message : "分析失败");
    } finally {
      if (operationEpochRef.current === epoch) setLoading(false);
    }
  }

  async function cancelTask() {
    if (!task?.cancelAllowed) return;
    const epoch = operationEpochRef.current + 1;
    operationEpochRef.current = epoch;
    setLoading(true);
    setError("");
    try {
      const response: any = await apiPost("/novel/event/generateEvents/cancel", {
        projectId: numericProjectId,
        taskId: task.taskId,
      } as any);
      const nextTask = response?.task || task;
      setTask(nextTask);
      if (nextTask.state === "cancelled") {
        const storageKey = attemptStorageKey(numericProjectId, normalizedSelectedIds);
        const stored = readStoredAttempt(storageKey);
        if (stored) removeStoredAttempt(storageKey, stored.idempotencyKey);
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "取消失败");
    } finally {
      if (operationEpochRef.current === epoch) setLoading(false);
    }
  }

  useEffect(() => {
    const epoch = operationEpochRef.current + 1;
    operationEpochRef.current = epoch;
    if (!open) return;
    setLoading(false);
    setTask(null);
    setResults([]);
    setError("");
    if (
      !Number.isSafeInteger(numericProjectId)
      || numericProjectId <= 0
      || !normalizedSelectedIds.length
      || new Set(normalizedSelectedIds).size !== normalizedSelectedIds.length
    ) return;
    const storageKey = attemptStorageKey(numericProjectId, normalizedSelectedIds);
    const stored = readStoredAttempt(storageKey);
    const idempotencyKey = String(stored?.idempotencyKey || "").trim();
    const novelIds = stored?.novelIds || [];
    if (
      !stored
      || !novelIds.length
      || !idempotencyKey
    ) return;
    setLoading(true);
    setError("");
    void resumeSubmission(
      numericProjectId,
      novelIds,
      idempotencyKey,
      stored.model,
    )
      .then((response: any) => {
        const resumed = response?.task as EventAnalysisTask | undefined;
        if (!resumed?.taskId || !resumed.model) {
          throw new Error("事件分析任务恢复响应缺少持久任务标识");
        }
        writeStoredAttempt(storageKey, {
          taskId: resumed.taskId,
          novelIds,
          idempotencyKey,
          model: resumed.model,
        });
        setTask(resumed);
        return pollTask(
          resumed.taskId,
          novelIds,
          idempotencyKey,
          resumed.model,
          epoch,
          storageKey,
        );
      })
      .catch((requestError) => {
        if (operationEpochRef.current === epoch) {
          setError(requestError instanceof Error ? requestError.message : "任务恢复失败");
        }
      })
      .finally(() => {
        if (operationEpochRef.current === epoch) setLoading(false);
      });
  }, [open, numericProjectId, selectedIdsSignature]);

  if (!open) return null;

  return (
    <div className="writingModalBackdrop" style={{ position: "fixed", inset: 0, zIndex: 10000, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center" }} onClick={onClose}>
      <div className="writingModalPanel" role="dialog" aria-modal="true" aria-label="事件分析" style={{ width: 640, maxHeight: "80vh", background: "#fff", borderRadius: 12, padding: 24, overflow: "auto" }} onClick={(event) => event.stopPropagation()}>
        <h3 style={{ margin: "0 0 16px", color: "#18181b" }}>事件分析 ({selectedIds.length} 条)</h3>
        {error ? <div role="alert" style={{ marginBottom: 12, padding: 10, border: "1px solid #fecaca", borderRadius: 8, background: "#fef2f2", color: "#b91c1c", fontSize: 13 }}>{error}</div> : null}
        {task ? (
          <div style={{ marginBottom: 12, padding: 10, border: "1px solid #dbeafe", borderRadius: 8, background: "#eff6ff", color: "#1e3a8a", fontSize: 13 }}>
            任务 #{task.taskId} · {task.state === "succeeded" ? "已完成" : task.state === "failed" ? "失败，可重试未成功章节" : task.state === "cancelled" ? "已取消，未派发上游" : task.state === "pending_reconcile" ? "上游结果与账务待核对，禁止自动重试" : `处理中（${task.completedIds.length}/${selectedIds.length}）`}
            {task.reason ? <div style={{ marginTop: 4 }}>{task.reason}</div> : null}
          </div>
        ) : null}
        {!task && !results.length && !loading ? (
          <div style={{ textAlign: "center", padding: 24 }}>
            <button onClick={() => void runAnalysis()} disabled={!projectId || !selectedIds.length} style={{ padding: "10px 24px", borderRadius: 8, border: "none", background: "#5d94bd", color: "#fff", cursor: projectId && selectedIds.length ? "pointer" : "not-allowed", fontWeight: 600, opacity: projectId && selectedIds.length ? 1 : 0.55 }}>开始分析</button>
          </div>
        ) : null}
        {loading && <div role="status" style={{ textAlign: "center", padding: 24, color: "#71717a" }}>真实文本模型分析中，可关闭窗口，重新打开后会恢复任务状态…</div>}
        {results.map((result, index) => (
          <div key={result.id || index} style={{ padding: 12, borderRadius: 8, border: `1px solid ${result.eventState === -1 ? "#fecaca" : "#e4e4e7"}`, marginBottom: 8 }}>
            <div style={{ fontWeight: 600, color: "#18181b", marginBottom: 4 }}>章节 {result.id}</div>
            <div style={{ fontSize: 13, color: result.eventState === -1 ? "#b91c1c" : "#71717a", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
              {result.eventState === -1 ? result.errorReason || "分析失败" : eventText(result.event) || "未返回事件内容"}
            </div>
          </div>
        ))}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          {task?.cancelAllowed ? <button onClick={() => void cancelTask()} style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid #e4e4e7", background: "#fff" }}>派发前取消</button> : null}
          {task?.retryAllowed ? <button onClick={() => void runAnalysis()} disabled={loading} style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: "#5d94bd", color: "#fff" }}>重试未成功章节</button> : null}
          {task && ["succeeded", "cancelled"].includes(task.state) ? <button onClick={() => void runAnalysis()} disabled={loading} style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: "#5d94bd", color: "#fff" }}>重新分析</button> : null}
          <button onClick={onClose} style={{ padding: "8px 20px", borderRadius: 8, border: "1px solid #e4e4e7", background: "#fff", cursor: "pointer" }}>关闭</button>
        </div>
      </div>
    </div>
  );
}
