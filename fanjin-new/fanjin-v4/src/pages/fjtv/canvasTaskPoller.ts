import { api } from "@/lib/api";
import type { NodeData } from "./canvasDataTypes";
import { canvasTaskQueryFailure, isCanvasImageTaskMissing } from "./canvasTaskPolling";
import { isPreparingGeneration, generationPreparationMessage, generationPreparationPatch } from "../../features/quick-create/generationPreparation";
import { advanceReportedGenerationProgress } from "./canvasGenerationProgress";
import { taskRequiresBillingReconciliation } from "./canvasTaskState";
import { describeCanvasError } from "./canvasFriendlyError";

export interface CanvasTaskPollerDependencies {
  isNodeGenerationSessionCurrent: (nodeId: string, sessionId: string) => boolean;
  setNodePatch: (nodeId: string, patch: Partial<NodeData>) => void;
  nodesRef: { current: NodeData[] };
  setStatus: (message: string) => void;
  stopNodeProgressTimer: (nodeId: string) => void;
  beginNodeProgressSimulation: (nodeId: string, phase: "upload" | "generation") => void;
  applyTaskResultToNode: (node: NodeData, task: any, sessionId?: string) => Promise<boolean>;
  showNodeStatusChip: (nodeId: string, text: string, tone?: "neutral" | "success" | "error", durationMs?: number) => void;
  finishNodeGenerationSession: (nodeId: string, sessionId?: string) => void;
  persistCanvas: () => unknown;
}

export function createCanvasTaskPoller({
  isNodeGenerationSessionCurrent, setNodePatch, nodesRef, setStatus, stopNodeProgressTimer, beginNodeProgressSimulation, applyTaskResultToNode, showNodeStatusChip, finishNodeGenerationSession, persistCanvas
}: CanvasTaskPollerDependencies) {
  async function pollTaskUntilDone(
    taskId: string,
    node: NodeData,
    sessionId: string,
    startedAt = Date.now(),
    options?: { kind?: "generation" | "video_enhance"; queryFailures?: number },
  ): Promise<boolean> {
    if (!isNodeGenerationSessionCurrent(node.id, sessionId)) return false;
    if (Date.now() - startedAt > 20 * 60 * 1000) {
      if (!isNodeGenerationSessionCurrent(node.id, sessionId)) return false;
      setNodePatch(node.id, {
        isGenerating: true,
        generationState: "processing",
        taskId,
        taskStatus: "processing",
        generationProgress: isPreparingGeneration(nodesRef.current.find((item) => item.id === node.id) || {}) ? 0 : 94,
      });
      setStatus(generationPreparationMessage(nodesRef.current.find((item) => item.id === node.id) || {}) || "任务仍在处理中，请稍后查看");
      return await pollTaskUntilDone(taskId, node, sessionId, Date.now(), options);
    }
    await new Promise((resolve) => window.setTimeout(resolve, options?.queryFailures ? canvasTaskQueryFailure(null, options.queryFailures).delayMs : 2000));
    if (!isNodeGenerationSessionCurrent(node.id, sessionId)) return false;
    try {
      const query = options?.kind === "video_enhance"
        ? await api.queryVideoEnhanceTask(taskId)
        : await api.queryTask(taskId);
      if (!isNodeGenerationSessionCurrent(node.id, sessionId)) return false;
      const task = (query as any)?.task || query;
      const status = String(task?.status || "").toLowerCase();
      const preparing = isPreparingGeneration(task);
      const wasPreparing = isPreparingGeneration(nodesRef.current.find((item) => item.id === node.id) || {});
      if (preparing) {
        stopNodeProgressTimer(node.id);
        setNodePatch(node.id, { isGenerating: true, generationState: "processing", taskId,
          taskStatus: "processing", ...generationPreparationPatch(task) });
        setStatus(generationPreparationMessage(task));
      } else if (wasPreparing) {
        setNodePatch(node.id, { ...generationPreparationPatch(task), generationProgress: 0 });
        if (["queued", "running", "processing", "enhancing"].includes(status)) {
          beginNodeProgressSimulation(node.id, "generation");
        }
      }
      // Prefer real upstream percent when the provider reports one.
      const upstreamProgress = Number(
        task?.progress
        ?? task?.progressPercent
        ?? task?.percent
        ?? task?.data?.progress,
      );
      if (!preparing && Number.isFinite(upstreamProgress) && upstreamProgress > 0) {
        const pct = Math.max(1, Math.min(94, Math.round(upstreamProgress <= 1 ? upstreamProgress * 100 : upstreamProgress)));
        setNodePatch(node.id, {
          isGenerating: true,
          generationState: "processing",
          taskId,
          taskStatus: "processing",
          generationProgress: pct,
          reportedGenerationProgress: advanceReportedGenerationProgress(
            nodesRef.current.find((candidate) => candidate.id === node.id)?.reportedGenerationProgress,
            upstreamProgress,
          ),
        });
      }
      const deliveryStatus = String(task?.delivery?.deliveryStatus || "").toLowerCase();
      const billingReconciliationRequired = taskRequiresBillingReconciliation(task);
      const deliveryFailed = ["failed", "error", "cancelled", "canceled"].includes(deliveryStatus);
      const taskFailed = ["failed", "error", "cancelled", "canceled"].includes(status);
      if (deliveryStatus === "degraded") {
        const ok = await applyTaskResultToNode(node, task, sessionId);
        if (!isNodeGenerationSessionCurrent(node.id, sessionId) && !ok) return false;
        if (ok) {
          showNodeStatusChip(
            node.id,
            "已保留原始清晰度视频",
            "neutral",
            3200,
          );
          setStatus(
            "目标清晰度处理失败，已保留可用的原始清晰度视频",
          );
        } else {
          showNodeStatusChip(node.id, "生成失败", "error", 2600);
          setStatus("降级结果缺少可用视频");
        }
        return ok;
      }
      if (deliveryFailed || taskFailed) {
        if (!isNodeGenerationSessionCurrent(node.id, sessionId)) return false;
        const cancelled = status === "cancelled"
          || status === "canceled"
          || deliveryStatus === "cancelled"
          || deliveryStatus === "canceled";
        setNodePatch(node.id, {
          isGenerating: false,
          generationState: "idle",
          taskId: billingReconciliationRequired ? taskId : undefined,
          taskKind: billingReconciliationRequired
            ? (options?.kind === "video_enhance" ? "video_enhance" : "generation")
            : undefined,
          taskStatus: billingReconciliationRequired ? "pending_reconcile" : "failed",
          videoGenerationAttemptId: undefined,
          videoEnhanceAttemptId: billingReconciliationRequired && options?.kind === "video_enhance"
            ? node.videoEnhanceAttemptId
            : undefined,
          videoRewritePending: false,
          generationProgress: 0,
        });
        stopNodeProgressTimer(node.id);
        finishNodeGenerationSession(node.id, sessionId);
        // Persist terminal failure as reliably as successful delivery; otherwise
        // a later server refresh can resurrect the previous waiting state.
        void persistCanvas();
        const taskError = typeof task?.errorMessage === "string"
          ? task.errorMessage
          : typeof task?.error === "string"
            ? task.error
            : task?.error?.message;
        const friendly = describeCanvasError(taskError, "poll");
        showNodeStatusChip(node.id, friendly.title, "error", 5200);
        setStatus(friendly.message);
        return false;
      }
      if (status === "success" || status === "succeeded") {
        const ok = await applyTaskResultToNode(node, task, sessionId);
        if (!isNodeGenerationSessionCurrent(node.id, sessionId) && !ok) return false;
        if (!ok) showNodeStatusChip(node.id, "生成失败", "error", 2600);
        setStatus(ok ? (options?.kind === "video_enhance" ? "高清生成完成" : "生成完成") : "生成失败");
        return ok;
      }
      if (status === "pending_reconcile") {
        // This is an unresolved upstream result, not a user approval step.
        // Keep the original task identity and query it; never submit again.
        stopNodeProgressTimer(node.id);
        setNodePatch(node.id, { isGenerating: true, generationState: "processing",
          taskId, taskStatus: "pending_reconcile" });
        setStatus("暂未取得上游结果，正在同步；费用记录可在账单中查询");
        return await pollTaskUntilDone(taskId, node, sessionId, startedAt, { ...options, queryFailures: 0 });
      }
      if (typeof task?.errorMessage === "string" && task.errorMessage.includes("视频已生成，保存失败")) {
        showNodeStatusChip(node.id, "视频已生成，正在重试保存", "neutral", 4200);
        setStatus(task.errorMessage);
      }
      return await pollTaskUntilDone(taskId, node, sessionId, startedAt, { ...options, queryFailures: 0 });
    } catch (error) {
      if (!isNodeGenerationSessionCurrent(node.id, sessionId)) return false;
      if (node.type === "image" && isCanvasImageTaskMissing(error)) {
        setNodePatch(node.id, {
          isGenerating: false,
          generationState: "idle",
          taskId: undefined,
          taskKind: undefined,
          taskStatus: "failed",
          imageGenerationAttemptId: undefined,
          imageRequestAttempt: undefined,
          imagePendingMessage: undefined,
          imagePendingCode: undefined,
          generationProgress: 0,
        });
        stopNodeProgressTimer(node.id);
        finishNodeGenerationSession(node.id, sessionId);
        showNodeStatusChip(node.id, "旧任务不存在，可重新生成", "error", 5200);
        setStatus("旧图片任务已失效，已恢复为可重新生成状态");
        void persistCanvas();
        return false;
      }
      const failures = (options?.queryFailures || 0) + 1;
      const failure = canvasTaskQueryFailure(error, failures);
      if (failure.stop) {
        setNodePatch(node.id, { isGenerating: false, generationState: "idle", taskId,
          taskKind: options?.kind === "video_enhance" ? "video_enhance" : "generation",
          taskStatus: "query_failed", generationProgress: 0 });
        stopNodeProgressTimer(node.id);
        finishNodeGenerationSession(node.id, sessionId);
        showNodeStatusChip(node.id, "结果查询失败，可在生成历史中重试", "error", 5200);
        setStatus(failure.message);
        void persistCanvas();
        return false;
      }
      showNodeStatusChip(node.id, "结果暂时无法读取，正在重试查询", "neutral", 2600);
      setStatus("任务状态暂未确认，正在重试查询；不会重复提交生成");
      return await pollTaskUntilDone(taskId, node, sessionId, startedAt, { ...options, queryFailures: failures });
    }
  }

  return pollTaskUntilDone;
}
