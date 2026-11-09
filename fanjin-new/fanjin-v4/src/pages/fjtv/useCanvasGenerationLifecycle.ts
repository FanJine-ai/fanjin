import { useEffect, type DependencyList, type Dispatch, type SetStateAction, type RefObject, type ReactNode, type JSX } from "react";
import type { NodeData, CanvasMetaState } from "./canvasDataTypes";
import { shouldResumeCanvasTask } from "./canvasGenerationRecovery";
import { type CanvasPricingConfirmation } from "./CanvasPricingConfirmationDialog";
import { type CanvasRealCapabilities } from "./canvasCapabilities";
import { type CanvasGenerationDebugSnapshot } from "./canvasGenerationDebug";

interface UseCanvasDebugVisibilityContext {
  canvasGenerationDebugVisible: boolean;
  setGenerateDebugState: Dispatch<SetStateAction<CanvasGenerationDebugSnapshot | null>>;
}

export function useCanvasDebugVisibility(readContext: () => UseCanvasDebugVisibilityContext, dependencies: DependencyList) {
  useEffect(() => {
    const { canvasGenerationDebugVisible, setGenerateDebugState } = readContext();

    if (!canvasGenerationDebugVisible) setGenerateDebugState(null);

  }, dependencies);
}

interface UseCanvasDecisionCleanupContext {
  draftDecisionRef: RefObject<((approved: boolean) => void) | null>;
  pricingDecisionRef: RefObject<((approved: boolean) => void) | null>;
  pricingConfirmationQueueRef: RefObject<{ confirmation: CanvasPricingConfirmation; resolve: (approved: boolean) => void; }[]>;
  pricingConfirmationActiveRef: RefObject<boolean>;
}

export function useCanvasDecisionCleanup(readContext: () => UseCanvasDecisionCleanupContext, dependencies: DependencyList) {
  useEffect(() => {
    const { draftDecisionRef, pricingDecisionRef, pricingConfirmationQueueRef, pricingConfirmationActiveRef } = readContext();
    return () => {
    draftDecisionRef.current?.(false);
    draftDecisionRef.current = null;
    pricingDecisionRef.current?.(false);
    pricingDecisionRef.current = null;
    for (const pending of pricingConfirmationQueueRef.current.splice(0)) pending.resolve(false);
    pricingConfirmationActiveRef.current = false;
  };
  }, dependencies);
}

interface UseCanvasVideoStoryRecoveryContext {
  canvasMeta: CanvasMetaState;
  canvasCapabilities: CanvasRealCapabilities;
  currentProjectId: string | null;
  nodes: NodeData[];
  videoStoryResumeAttemptedRef: RefObject<Set<number>>;
  pollVideoStoryAnalysis: (nodeId: string, projectId: number, taskId: number) => Promise<void>;
  setStatus: Dispatch<SetStateAction<string>>;
}

export function useCanvasVideoStoryRecovery(readContext: () => UseCanvasVideoStoryRecoveryContext, dependencies: DependencyList) {
  useEffect(() => {
    const { canvasMeta, canvasCapabilities, currentProjectId, nodes, videoStoryResumeAttemptedRef, pollVideoStoryAnalysis, setStatus } = readContext();

    if (!canvasMeta.ready || !canvasCapabilities.videoStoryAnalysis) return;
    const projectId = Number(currentProjectId || canvasMeta.projectId || 0);
    if (!Number.isSafeInteger(projectId) || projectId <= 0) return;
    nodes.forEach((node) => {
      const taskId = Number(node.videoStoryTaskId || 0);
      if (
        node.type === "video"
        && Number.isSafeInteger(taskId)
        && taskId > 0
        && ["queued", "running", "persisting"].includes(String(node.videoStoryTaskState || ""))
        && !videoStoryResumeAttemptedRef.current.has(taskId)
      ) {
        videoStoryResumeAttemptedRef.current.add(taskId);
        void pollVideoStoryAnalysis(node.id, projectId, taskId).catch((error) => {
          setStatus(error instanceof Error ? error.message : "逐帧拉片状态查询失败");
        });
      }
    });

  }, dependencies);
}

interface UseCanvasRuntimeCleanupContext {
  generationSessionRef: RefObject<Record<string, string>>;
  abortCanvasNodeUploads: (reason?: string) => void;
  clearCanvasNodeTimers: () => void;
}

export function useCanvasRuntimeCleanup(readContext: () => UseCanvasRuntimeCleanupContext, dependencies: DependencyList) {
  useEffect(() => {
    const { generationSessionRef, abortCanvasNodeUploads, clearCanvasNodeTimers } = readContext();
    return () => {
    generationSessionRef.current = {};
    abortCanvasNodeUploads();
    clearCanvasNodeTimers();
  };
  }, dependencies);
}

interface UseCanvasPendingProgressContext {
  hasPendingGeneration: boolean;
  setPendingProgressTick: Dispatch<SetStateAction<number>>;
}

export function useCanvasPendingProgress(readContext: () => UseCanvasPendingProgressContext, dependencies: DependencyList) {
  useEffect(() => {
    const { hasPendingGeneration, setPendingProgressTick } = readContext();

    if (!hasPendingGeneration) return;
    const timer = window.setInterval(() => setPendingProgressTick((n) => n + 1), 1000);
    return () => window.clearInterval(timer);

  }, dependencies);
}

interface UseCanvasPendingTaskRecoveryContext {
  nodes: NodeData[];
  generationSessionRef: RefObject<Record<string, string>>;
  resumedFailedQueriesRef: RefObject<Set<string>>;
  beginNodeGenerationSession: (nodeId: string) => string;
  pollTaskUntilDone: (taskId: string, node: NodeData, sessionId: string, startedAt?: number, options?: { kind?: "generation" | "video_enhance"; queryFailures?: number; }) => Promise<boolean>;
}

export function useCanvasPendingTaskRecovery(readContext: () => UseCanvasPendingTaskRecoveryContext, dependencies: DependencyList) {
  useEffect(() => {
    const { nodes, generationSessionRef, resumedFailedQueriesRef, beginNodeGenerationSession, pollTaskUntilDone } = readContext();

    nodes.forEach((node) => {
      if (!shouldResumeCanvasTask(node) || !node.taskId) return;
      const failedQuery = node.taskStatus === "query_failed";
      const currentSession = generationSessionRef.current[node.id];
      if (currentSession) return;
      // A new page visit can recover an outage fixed while it was closed. Try
      // once per task; a persistent 404 must not restart on every node render.
      const recoveryKey = `${node.id}:${node.taskId}`;
      if (failedQuery) {
        if (resumedFailedQueriesRef.current.has(recoveryKey)) return;
        resumedFailedQueriesRef.current.add(recoveryKey);
      }
      const sessionId = beginNodeGenerationSession(node.id);
      void pollTaskUntilDone(
        node.taskId,
        node,
        sessionId,
        Date.now(),
        node.taskKind === "video_enhance" || node.videoEnhanceMode
          ? { kind: "video_enhance" }
          : undefined,
      );
    });

  }, dependencies);
}
