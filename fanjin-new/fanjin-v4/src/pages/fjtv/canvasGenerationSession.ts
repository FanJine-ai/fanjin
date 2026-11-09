import type { Dispatch, SetStateAction } from "react";
import { api } from "@/lib/api";
import type { NodeData } from "./canvasDataTypes";
import { createGenerationSessionId } from "./canvasTaskState";
import { getCanvasTaskCancellationOutcome, getCanvasPendingCancellationPatch } from "./canvasTaskResult";

export interface CanvasGenerationSessionDependencies {
  generationSessionRef: { current: Record<string, string> };
  markNodeSubmitting: (nodeId: string) => void;
  clearNodeSubmitting: (nodeId: string) => void;
  setNodePatch: (nodeId: string, patch: Partial<NodeData>) => void;
  nodesRef: { current: NodeData[] };
  stopNodeProgressTimer: (nodeId: string) => void;
  clearSubmitButtonPendingForNode: (nodeId: string) => void;
  setGenerateButtonPendingNodeIds: Dispatch<SetStateAction<string[]>>;
  setStatus: (message: string) => void;
  persistCanvas: () => Promise<string | null>;
  showNodeStatusChip: (nodeId: string, text: string, tone?: "neutral" | "success" | "error", durationMs?: number) => void;
  beginNodeProgressSimulation: (nodeId: string, phase: "upload" | "generation") => void;
}

export function createCanvasGenerationSession({
  generationSessionRef,
  markNodeSubmitting,
  clearNodeSubmitting,
  setNodePatch,
  nodesRef,
  stopNodeProgressTimer,
  clearSubmitButtonPendingForNode,
  setGenerateButtonPendingNodeIds,
  setStatus,
  persistCanvas,
  showNodeStatusChip,
  beginNodeProgressSimulation,
}: CanvasGenerationSessionDependencies) {
  function beginNodeGenerationSession(nodeId: string) {
    const sessionId = createGenerationSessionId(nodeId);
    generationSessionRef.current[nodeId] = sessionId;
    markNodeSubmitting(nodeId);
    setNodePatch(nodeId, { reportedGenerationProgress: undefined, generationProgress: 0 });
    return sessionId;
  }

  function isNodeGenerationSessionCurrent(nodeId: string, sessionId: string) {
    return generationSessionRef.current[nodeId] === sessionId;
  }

  function finishNodeGenerationSession(nodeId: string, sessionId?: string) {
    if (!sessionId || generationSessionRef.current[nodeId] === sessionId) {
      delete generationSessionRef.current[nodeId];
      clearNodeSubmitting(nodeId);
    }
  }

  async function cancelNodeGeneration(nodeId: string): Promise<boolean> {
    const node = nodesRef.current.find((candidate) => candidate.id === nodeId);
    const taskId = String(node?.taskId || "").trim();
    if (!taskId) {
      // The submission response can be lost before a task id reaches the canvas.
      // Stop tracking this local attempt so it cannot leave the node stuck forever.
      finishNodeGenerationSession(nodeId);
      stopNodeProgressTimer(nodeId);
      clearSubmitButtonPendingForNode(nodeId);
      setGenerateButtonPendingNodeIds((previous) => previous.filter((id) => id !== nodeId));
      setNodePatch(nodeId, {
        isGenerating: false,
        generationState: "cancelled",
        taskId: undefined,
        taskKind: undefined,
        taskStatus: "failed",
        generationProgress: 0,
        imageGenerationAttemptId: undefined,
        imageRequestAttempt: undefined,
        imagePendingMessage: undefined,
        imagePendingCode: undefined,
        statusChipText: undefined,
        statusChipTone: undefined,
      });
      setStatus("已停止本地追踪并清除卡住状态；未取得任务编号的上游请求将由后台继续核对");
      void persistCanvas().catch(() => setStatus("已停止本地追踪，但画布保存失败，请保持页面打开后重试"));
      return true;
    }
    try {
      const result = await api.cancelTask(taskId);
      const cancellation = getCanvasTaskCancellationOutcome(result);
      if (cancellation.kind === "rejected") {
        throw new Error("服务端未确认任务已取消");
      }
      finishNodeGenerationSession(nodeId);
      stopNodeProgressTimer(nodeId);
      clearSubmitButtonPendingForNode(nodeId);
      setGenerateButtonPendingNodeIds((prev) => prev.filter((id) => id !== nodeId));
      if (cancellation.kind === "pending_reconcile") {
        setNodePatch(nodeId, getCanvasPendingCancellationPatch({
          taskId,
          taskKind: node?.taskKind || "generation",
        }));
        showNodeStatusChip(nodeId, "取消已提交，账务待核", "neutral", 3200);
        setStatus("取消请求已提交；上游与账务状态仍在核对，请勿重复提交");
        return true;
      }
      setNodePatch(nodeId, {
        isGenerating: false,
        generationState: "cancelled",
        taskId: undefined,
        taskKind: undefined,
        taskStatus: "idle",
        generationProgress: 0,
        statusChipText: undefined,
        statusChipTone: undefined,
      });
      setStatus("上游任务已确认取消");
      return true;
    } catch (error) {
      beginNodeProgressSimulation(nodeId, "generation");
      setStatus(error instanceof Error ? `${error.message}；任务仍在运行` : "取消失败，任务仍在运行");
      showNodeStatusChip(nodeId, "取消失败，任务仍在运行", "error", 3200);
      return false;
    }
  }

  return { beginNodeGenerationSession, isNodeGenerationSessionCurrent, finishNodeGenerationSession, cancelNodeGeneration };
}
