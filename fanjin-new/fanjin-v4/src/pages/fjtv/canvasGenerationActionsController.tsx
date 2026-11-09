import { isSubmitButtonPendingKeyForNode } from "./canvasSubmitPendingKeys";
import type { Dispatch, SetStateAction, RefObject, ReactNode, JSX } from "react";
import { createNode } from "./canvasNodeDefaults";
import { VIDEO_REFERENCE_REQUIREMENT_TEXT, getNodeModelType, isLk888LimitedVideoModel, resolveCanvasImageQuality, normalizeVideoResolutionForModel, summarizeVideoReferenceNodes, getDefaultVideoPromptTab, isVideoPromptTabEnabled, getVideoModeForTab, getVideoTabForMode, getImageRequestRatio } from "./canvasModelDefinitions";
import { createCanvasGenerationSubmission } from "./canvasGenerationSubmission";
import { createCanvasTextGeneration } from "./canvasTextGeneration";
import { createCanvasGenerationResults } from "./canvasGenerationResults";
import { createCanvasTaskPoller } from "./canvasTaskPoller";
import { taskRequiresBillingReconciliation } from "./canvasTaskState";
import type { CanvasModelType, NodeData, EdgeData, GroupData, VideoGenerationMode, CanvasUploadRetry, CanvasNodeUploadResult } from "./canvasDataTypes";
import type { NodeType, RatioKey } from "./canvasMediaTypes";
import { type CanvasPricingConfirmation } from "./CanvasPricingConfirmationDialog";
import { type CanvasArtifactKind, type CanvasArtifactCard } from "./canvasTextArtifacts";
import { api, type AiModelOption } from "@/lib/api";
import { type CanvasGenerationDebugSnapshot } from "./canvasGenerationDebug";
import type { KeyedSingleFlight } from "./canvasUploadRuntime";
import { advanceCanvasUploadProgress, isCanvasUploadAbortError } from "./canvasUploadRuntime";

export interface CanvasGenerationActionsControllerDependencies {
  setSubmittingNodeIds: Dispatch<SetStateAction<string[]>>;
  submittingNodeIds: string[];
  submitButtonPendingKeys: string[];
  setSubmitButtonPendingKeys: Dispatch<SetStateAction<string[]>>;
  nodeProgressTimerRef: RefObject<Record<string, number>>;
  setNodes: Dispatch<SetStateAction<NodeData[]>>;
  nodeStatusTimerRef: RefObject<Record<string, number>>;
  setNodePatch: (nodeId: string, patch: Partial<NodeData>) => void;
  nodeUploadAbortRef: RefObject<Record<string, AbortController>>;
  nodesRef: RefObject<NodeData[]>;
  nodeUploadSingleFlightRef: RefObject<KeyedSingleFlight<string, CanvasNodeUploadResult | null>>;
  nodeUploadPromiseRef: RefObject<Partial<Record<string, Promise<string>>>>;
  nodeUploadRetryRef: RefObject<Record<string, CanvasUploadRetry>>;
  setGenerateButtonPendingNodeIds: Dispatch<SetStateAction<string[]>>;
  locallyDeletedNodeIdsRef: RefObject<Set<string>>;
  canvasStablePersistableNodesRef: RefObject<Map<string, NodeData>>;
  setEdges: Dispatch<SetStateAction<EdgeData[]>>;
  setGroups: Dispatch<SetStateAction<GroupData[]>>;
  setSelectedNodeIds: Dispatch<SetStateAction<string[]>>;
  setSelectedEdgeIds: Dispatch<SetStateAction<string[]>>;
  setActiveNodeId: Dispatch<SetStateAction<string | null>>;
  setActiveGroupId: Dispatch<SetStateAction<string | null>>;
  setStatus: Dispatch<SetStateAction<string>>;
  uploadFileIntoNode: (nodeId: string, file: File, type: "image" | "video", options?: CanvasUploadRetry["options"]) => Promise<CanvasNodeUploadResult | null>;
  createGenerationSessionController: () => { beginNodeGenerationSession: (nodeId: string) => string; isNodeGenerationSessionCurrent: (nodeId: string, sessionId: string) => boolean; finishNodeGenerationSession: (nodeId: string, sessionId?: string) => void; cancelNodeGeneration: (nodeId: string) => Promise<boolean>; };
  cancelGenerationOpenerRef: RefObject<HTMLElement | null>;
  setCancelGenerationConfirmNodeId: Dispatch<SetStateAction<string | null>>;
  cancelGenerationConfirmNodeId: string | null;
  cancelGenerationPending: boolean;
  setCancelGenerationPending: Dispatch<SetStateAction<boolean>>;
  isNodeGenerationSessionCurrent: (nodeId: string, sessionId: string) => boolean;
  finishNodeGenerationSession: (nodeId: string, sessionId?: string) => void;
  canvasBalance: { refresh: () => void; loading: boolean; error: string; availableMicros: number; reservedMicros: number; baselineMicros: number; spentMicros: number; percent: number; lastRechargeAt: number | null; };
  loadHistoryItems: () => Promise<void>;
  applyNodeMediaGeometry: (nodeId: string, mediaWidth: number, mediaHeight: number, patch?: Partial<NodeData>) => void;
  createAndUploadVideoPoster: (nodeId: string, videoUrl: string, fileName: string) => Promise<boolean>;
  persistCanvas: (nextNodes?: NodeData[], nextEdges?: EdgeData[], nextName?: string, nextGroups?: GroupData[]) => Promise<string | null>;
  localResultPendingPersistenceRef: RefObject<Record<string, string>>;
  editCanvasArtifact: (nodeId: string, kind: CanvasArtifactKind, cardId: string, patch: Partial<CanvasArtifactCard>) => void;
  edges: EdgeData[];
  beginNodeGenerationSession: (nodeId: string) => string;
  preflightCanvasModel: (modelType: CanvasModelType, requestedModelId?: string, options?: { allowCatalogDefault?: boolean; openPicker?: boolean; }) => AiModelOption | null;
  activeNode: NodeData | null;
  submitDraftFinalNode: (node: NodeData) => Promise<boolean>;
  activeProjectContextId: string | null;
  setGenerateDebug: (snapshot: CanvasGenerationDebugSnapshot | null) => void;
  videoPromptTab: "文生视频" | "全能参考" | "图生视频" | "首尾帧" | "图片参考" | "延长视频" | "修改视频";
  buildReferenceResolutionSnapshot: (node: NodeData | null | undefined) => { nodeId: string; title: string; type: NodeType; referenceAssetUri: string; referenceAssetKind: string; imageUrl: string; videoUrl: string; localPreviewUrl: string; localVideoUrl: string; cachedRemoteUrl: string; localMappedRemoteUrl: string; hasPendingUpload: boolean; } | null;
  resolveNodeRemoteReferenceUrl: (node: NodeData) => Promise<string>;
  getImageNodeGeometry: (node: NodeData | null | undefined) => { width: number; height: number; ratio: RatioKey; nodeWidth: number; nodeHeight: number; } | null;
  inferImageReferenceGeometry: (referenceNodes: NodeData[]) => { width: number; height: number; ratio: RatioKey; nodeWidth: number; nodeHeight: number; } | null;
  inferVideoRatioFromImageReferences: (referenceNodes: NodeData[]) => RatioKey | null;
  shouldInheritVideoRatioFromReference: (mode: VideoGenerationMode, node: NodeData, inferredRatio: RatioKey | null) => boolean;
  parseDurationSeconds: (raw?: string) => number;
  videoNodeDurations: Record<string, number>;
  audioNodeDurations: Record<string, number>;
  executeDraftWithApproval: (node: NodeData, request: Record<string, unknown>, attemptId: string) => Promise<any>;
  requestPricingConfirmation: (confirmation: CanvasPricingConfirmation) => Promise<boolean>;
}

export function createCanvasGenerationActionsController(deps: CanvasGenerationActionsControllerDependencies) {
  const { setSubmittingNodeIds, submittingNodeIds, submitButtonPendingKeys, setSubmitButtonPendingKeys, nodeProgressTimerRef, setNodes, nodeStatusTimerRef, setNodePatch, nodeUploadAbortRef, nodesRef, nodeUploadSingleFlightRef, nodeUploadPromiseRef, nodeUploadRetryRef, setGenerateButtonPendingNodeIds, locallyDeletedNodeIdsRef, canvasStablePersistableNodesRef, setEdges, setGroups, setSelectedNodeIds, setSelectedEdgeIds, setActiveNodeId, setActiveGroupId, setStatus, uploadFileIntoNode, createGenerationSessionController, cancelGenerationOpenerRef, setCancelGenerationConfirmNodeId, cancelGenerationConfirmNodeId, cancelGenerationPending, setCancelGenerationPending, isNodeGenerationSessionCurrent, finishNodeGenerationSession, canvasBalance, loadHistoryItems, applyNodeMediaGeometry, createAndUploadVideoPoster, persistCanvas, localResultPendingPersistenceRef, editCanvasArtifact, edges, beginNodeGenerationSession, preflightCanvasModel, activeNode, submitDraftFinalNode, activeProjectContextId, setGenerateDebug, videoPromptTab, buildReferenceResolutionSnapshot, resolveNodeRemoteReferenceUrl, getImageNodeGeometry, inferImageReferenceGeometry, inferVideoRatioFromImageReferences, shouldInheritVideoRatioFromReference, parseDurationSeconds, videoNodeDurations, audioNodeDurations, executeDraftWithApproval, requestPricingConfirmation } = deps;
function markNodeSubmitting(nodeId: string) {
    setSubmittingNodeIds((prev) => (prev.includes(nodeId) ? prev : [...prev, nodeId]));
  }

function clearNodeSubmitting(nodeId: string) {
    setSubmittingNodeIds((prev) => prev.filter((id) => id !== nodeId));
  }

function nodeHasSubmittingSession(nodeId: string) {
    return submittingNodeIds.includes(nodeId);
  }

function submitButtonIsPending(key: string) {
    return submitButtonPendingKeys.includes(key);
  }

function clearSubmitButtonPendingForNode(nodeId: string) {
    setSubmitButtonPendingKeys((prev) => prev.filter((key) => !isSubmitButtonPendingKeyForNode(key, nodeId)));
  }

async function runWithSubmitButtonPending(key: string, action: () => Promise<void> | void) {
    if (submitButtonPendingKeys.includes(key)) return;
    setSubmitButtonPendingKeys((prev) => (prev.includes(key) ? prev : [...prev, key]));
    try {
      await action();
    } finally {
      setSubmitButtonPendingKeys((prev) => prev.filter((item) => item !== key));
    }
  }

function stopNodeProgressTimer(nodeId: string) {
    const timer = nodeProgressTimerRef.current[nodeId];
    if (typeof timer === "number") {
      window.clearInterval(timer);
      delete nodeProgressTimerRef.current[nodeId];
    }
  }

function beginNodeProgressSimulation(nodeId: string, phase: "upload" | "generation") {
    stopNodeProgressTimer(nodeId);
    if (phase === "generation") return;
    nodeProgressTimerRef.current[nodeId] = window.setInterval(() => {
      setNodes((prev) => advanceCanvasUploadProgress(prev, nodeId));
    }, 800);
  }

function finalizeNodeUploadVisual(nodeId: string, delayMs = 520) {
    window.setTimeout(() => {
      setNodes((prev) =>
        prev.map((node) => {
          if (node.id !== nodeId) return node;
          if (node.uploadState !== "uploading" || Math.round(node.uploadProgress || 0) < 100) return node;
          return {
            ...node,
            uploadState: "idle",
            uploadProgress: undefined,
          };
        }),
      );
    }, delayMs);
  }

function setNodeUploadProgress(nodeId: string, progress: number) {
    setNodes((prev) =>
      prev.map((node) => {
        if (node.id !== nodeId) return node;
        const currentProgress = typeof node.uploadProgress === "number" ? Math.max(1, node.uploadProgress) : 1;
        const incomingProgress = Math.max(1, Math.min(100, Math.round(progress || 1)));
        const nextProgress = Math.max(currentProgress, incomingProgress);
        return {
          ...node,
          uploadState: "uploading",
          uploadProgress: nextProgress,
        };
      }),
    );
  }

function showNodeStatusChip(nodeId: string, text: string, tone: "neutral" | "success" | "error" = "neutral", durationMs = 2200) {
    const existingTimer = nodeStatusTimerRef.current[nodeId];
    if (typeof existingTimer === "number") {
      window.clearTimeout(existingTimer);
      delete nodeStatusTimerRef.current[nodeId];
    }
    setNodePatch(nodeId, { statusChipText: text, statusChipTone: tone });
    nodeStatusTimerRef.current[nodeId] = window.setTimeout(() => {
      setNodePatch(nodeId, { statusChipText: undefined, statusChipTone: undefined });
      delete nodeStatusTimerRef.current[nodeId];
    }, durationMs);
  }

async function cancelNodeTransferOrGeneration(nodeId: string): Promise<boolean> {
    const uploadAbort = nodeUploadAbortRef.current[nodeId];
    const uploadNode = nodesRef.current.find((node) => node.id === nodeId);
    if (uploadAbort || uploadNode?.uploadState === "failed") {
      nodeUploadSingleFlightRef.current.invalidate(nodeId);
      if (uploadAbort && !uploadAbort.signal.aborted) {
        const abortError = new Error("用户取消上传");
        abortError.name = "AbortError";
        uploadAbort.abort(abortError);
      }
      if (uploadNode?.localPreviewUrl) URL.revokeObjectURL(uploadNode.localPreviewUrl);
      if (uploadNode?.localVideoUrl) URL.revokeObjectURL(uploadNode.localVideoUrl);
      delete nodeUploadAbortRef.current[nodeId];
      delete nodeUploadPromiseRef.current[nodeId];
      delete nodeUploadRetryRef.current[nodeId];
      stopNodeProgressTimer(nodeId);
      clearSubmitButtonPendingForNode(nodeId);
      setGenerateButtonPendingNodeIds((prev) => prev.filter((id) => id !== nodeId));
      locallyDeletedNodeIdsRef.current.add(nodeId);
      canvasStablePersistableNodesRef.current.delete(nodeId);
      setNodes((prev) => prev.filter((node) => node.id !== nodeId));
      setEdges((prev) => prev.filter((edge) => edge.fromNodeId !== nodeId && edge.toNodeId !== nodeId));
      setGroups((prev) => prev.flatMap((group) => {
        const nodeIds = group.nodeIds.filter((id) => id !== nodeId);
        return nodeIds.length > 0 ? [{ ...group, nodeIds }] : [];
      }));
      setSelectedNodeIds((prev) => prev.filter((id) => id !== nodeId));
      setSelectedEdgeIds([]);
      setActiveNodeId((prev) => (prev === nodeId ? null : prev));
      setActiveGroupId(null);
      setStatus(uploadNode?.uploadState === "failed" ? "已移除上传失败的素材" : "已取消上传");
      return true;
    }
    return await cancelNodeGeneration(nodeId);
  }

async function retryNodeUpload(nodeId: string) {
    const retry = nodeUploadRetryRef.current[nodeId];
    if (!retry) {
      setStatus("原始上传文件已不可用，请重新选择文件");
      return;
    }
    setStatus("正在重试上传…");
    try {
      await uploadFileIntoNode(nodeId, retry.file, retry.type, retry.options);
    } catch (error) {
      if (isCanvasUploadAbortError(error)) return;
      const message = error instanceof Error ? error.message : "上传失败";
      setNodePatch(nodeId, { uploadState: "failed", uploadProgress: undefined, uploadError: message });
      setStatus(`${message}，可重试或移除素材`);
    }
  }

async function cancelNodeGeneration(nodeId: string): Promise<boolean> {
    return createGenerationSessionController().cancelNodeGeneration(nodeId);
  }

function requestCancelNodeGeneration(nodeId: string) {
    cancelGenerationOpenerRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setCancelGenerationConfirmNodeId(nodeId);
  }

function closeCancelGenerationDialog({ restoreFocus = true } = {}) {
    setCancelGenerationConfirmNodeId(null);
    if (restoreFocus) {
      window.requestAnimationFrame(() => {
        const opener = cancelGenerationOpenerRef.current;
        if (opener?.isConnected) opener.focus({ preventScroll: true });
      });
    }
  }

async function confirmCancelNodeGeneration() {
    const nodeId = cancelGenerationConfirmNodeId;
    if (!nodeId || cancelGenerationPending) return;
    setCancelGenerationPending(true);
    try {
      const cancelled = await cancelNodeTransferOrGeneration(nodeId);
      if (cancelled) closeCancelGenerationDialog();
    } finally {
      setCancelGenerationPending(false);
    }
  }

function ensureApiKeyReady() {
    return true;
  }

function rejectGenerate(nodeId: string | null | undefined, message: string) {
    const text = message.trim() || "已阻止提交";
    setStatus(text);
    if (nodeId) showNodeStatusChip(nodeId, text, "error", 5200);
  }

function nodeUploadIsActive(node: NodeData) {
    return node.uploadState === "preparing"
      || node.uploadState === "uploading"
      || nodeUploadSingleFlightRef.current.isRunning(node.id)
      || Boolean(nodeUploadPromiseRef.current[node.id]);
  }

async function applyTaskResultToNode(node: NodeData, taskData: any, sessionId?: string): Promise<boolean> {
    return createCanvasGenerationResults({
      isNodeGenerationSessionCurrent,
      setNodePatch,
      stopNodeProgressTimer,
      finishNodeGenerationSession,
      canvasBalance,
      showNodeStatusChip,
      setStatus,
      loadHistoryItems,
      applyNodeMediaGeometry,
      createAndUploadVideoPoster,
      persistCanvas,
      nodesRef,
      localResultPendingPersistenceRef,
      editCanvasArtifact,
      edges,
    })(node, taskData, sessionId);
  }

async function pollTaskUntilDone(
    taskId: string,
    node: NodeData,
    sessionId: string,
    startedAt = Date.now(),
    options?: { kind?: "generation" | "video_enhance"; queryFailures?: number },
  ): Promise<boolean> {
    return await createCanvasTaskPoller({
      isNodeGenerationSessionCurrent, setNodePatch, nodesRef, setStatus, stopNodeProgressTimer, beginNodeProgressSimulation, applyTaskResultToNode, showNodeStatusChip, finishNodeGenerationSession, persistCanvas
    })(taskId, node, sessionId, startedAt, options);
  }

async function resolvePendingVideoBillingBeforeSubmit(
    node: NodeData,
    options?: { allowIdempotentRetryWithoutTaskId?: boolean },
  ): Promise<boolean> {
    if (node.taskStatus === "query_failed") {
      if (!node.taskId) { setStatus("任务编号缺失，请联系管理员核对结果，勿重复提交"); return false; }
      const session = beginNodeGenerationSession(node.id);
      await pollTaskUntilDone(node.taskId, node, session, Date.now(), { kind: node.taskKind === "video_enhance" ? "video_enhance" : "generation" });
      return false;
    }
    if (node.taskStatus !== "pending_reconcile") return true;
    if (!node.taskId) {
      if (
        options?.allowIdempotentRetryWithoutTaskId
        && (node.videoGenerationAttemptId || node.videoEnhanceAttemptId)
      ) {
        setStatus("正在使用上一笔请求编号安全确认提交结果");
        return true;
      }
      setStatus("上一笔视频任务仍标记为账务待核，但缺少任务编号；请联系管理员处理");
      showNodeStatusChip(node.id, "账务待核，禁止重复提交", "error", 3200);
      return false;
    }
    try {
      const queryAsEnhance = node.taskKind === "video_enhance"
        || (!node.taskKind && node.videoEnhanceMode === true);
      const query = queryAsEnhance
        ? await api.queryVideoEnhanceTask(node.taskId)
        : await api.queryTask(node.taskId);
      const task = (query as any)?.task || query;
      const status = String(task?.status || "").toLowerCase();
      const deliveryStatus = String(task?.delivery?.deliveryStatus || "").toLowerCase();
      const deliveredUrl = String(
        task?.delivery?.videoUrl
        || task?.videoUrl
        || task?.result?.videoUrl
        || task?.output?.videoUrl
        || "",
      ).trim();
      const stillRunning = ["created", "queued", "running", "enhancing", "processing"].includes(status);
      const confirmedFailed = ["failed", "cancelled", "canceled"].includes(status)
        && !deliveredUrl
        && deliveryStatus !== "ready"
        && deliveryStatus !== "degraded";
      if (stillRunning) {
        setStatus("上一笔视频任务仍在执行，请等待终态后再提交");
        showNodeStatusChip(node.id, "上一笔任务仍在执行", "error", 3200);
        return false;
      }
      if (confirmedFailed) {
        // Confirmed terminal failure without delivery: drop the submit lock so the
        // user can retry. Frozen GU is released by billing when the outcome is
        // definitive; refresh balance so the returned amount shows up.
        setNodePatch(node.id, {
          taskId: undefined,
          taskKind: undefined,
          taskStatus: "failed",
          videoGenerationAttemptId: undefined,
          videoEnhanceAttemptId: undefined,
          isGenerating: false,
          generationState: "idle",
          generationProgress: 0,
        });
        canvasBalance.refresh();
        showNodeStatusChip(node.id, "上一笔已失败，冻结额度退还中，可重新提交", "success", 4200);
        setStatus("上一笔视频任务已确认失败，未产生交付；冻结额度将退还，可直接重新提交");
        return true;
      }
      if (taskRequiresBillingReconciliation(task) || status === "pending_reconcile") {
        setStatus("上一笔视频任务账务待核，确认计费结果后会自动解冻额度；在此之前请勿重复提交");
        showNodeStatusChip(node.id, "账务待核，额度冻结中", "error", 4200);
        return false;
      }
      if (
        status === "success"
        || status === "succeeded"
        || deliveryStatus === "degraded"
      ) {
        const ok = await applyTaskResultToNode(node, task);
        showNodeStatusChip(node.id, ok ? "对账已完成" : "结果不可用", ok ? "neutral" : "error", 3200);
        setStatus(ok ? "上一笔视频任务已完成对账" : "上一笔任务结果不可用");
        return false;
      }
      setNodePatch(node.id, {
        taskId: undefined,
        taskKind: undefined,
        taskStatus: "failed",
        videoGenerationAttemptId: undefined,
        videoEnhanceAttemptId: undefined,
      });
      canvasBalance.refresh();
      showNodeStatusChip(node.id, "对账已结束，可重新提交", "neutral", 3200);
      setStatus("上一笔视频任务未交付且已完成对账，请再次点击提交");
      return false;
    } catch {
      setStatus("暂时无法确认上一笔对账状态，请稍后重试");
      showNodeStatusChip(node.id, "对账状态查询失败", "error", 3200);
      return false;
    }
  }

async function generateCanvasTextNode(node: NodeData, operation?: CanvasArtifactKind, newAttempt = false): Promise<boolean> {
    return createCanvasTextGeneration({
      nodesRef,
      edges,
      setStatus,
      ensureApiKeyReady,
      preflightCanvasModel,
      beginNodeGenerationSession,
      setNodePatch,
      beginNodeProgressSimulation,
      persistCanvas,
      isNodeGenerationSessionCurrent,
      stopNodeProgressTimer,
      finishNodeGenerationSession,
      showNodeStatusChip,
      canvasBalance,
    })(node, operation, newAttempt);
  }

async function generateWithActiveNode(targetOverride?: NodeData): Promise<boolean> {
    return createCanvasGenerationSubmission({
      activeNode,
      nodesRef,
      submitDraftFinalNode,
      generateCanvasTextNode,
      rejectGenerate,
      resolvePendingVideoBillingBeforeSubmit,
      ensureApiKeyReady,
      activeProjectContextId,
      setStatus,
      preflightCanvasModel,
      getNodeModelType,
      resolveCanvasImageQuality,
      edges,
      createNode,
      summarizeVideoReferenceNodes,
      setGenerateDebug,
      nodeUploadPromiseRef,
      getDefaultVideoPromptTab,
      getVideoTabForMode,
      getVideoModeForTab,
      isLk888LimitedVideoModel,
      isVideoPromptTabEnabled,
      videoPromptTab,
      buildReferenceResolutionSnapshot,
      resolveNodeRemoteReferenceUrl,
      getImageNodeGeometry,
      inferImageReferenceGeometry,
      getImageRequestRatio,
      inferVideoRatioFromImageReferences,
      shouldInheritVideoRatioFromReference,
      parseDurationSeconds,
      normalizeVideoResolutionForModel,
      VIDEO_REFERENCE_REQUIREMENT_TEXT,
      videoNodeDurations,
      audioNodeDurations,
      beginNodeGenerationSession,
      setNodePatch,
      persistCanvas,
      isNodeGenerationSessionCurrent,
      executeDraftWithApproval,
      requestPricingConfirmation,
      finishNodeGenerationSession,
      showNodeStatusChip,
      beginNodeProgressSimulation,
      pollTaskUntilDone,
      applyTaskResultToNode,
    })(targetOverride);
  }
  return { markNodeSubmitting, clearNodeSubmitting, nodeHasSubmittingSession, submitButtonIsPending, clearSubmitButtonPendingForNode, runWithSubmitButtonPending, stopNodeProgressTimer, beginNodeProgressSimulation, finalizeNodeUploadVisual, setNodeUploadProgress, showNodeStatusChip, cancelNodeTransferOrGeneration, retryNodeUpload, cancelNodeGeneration, requestCancelNodeGeneration, closeCancelGenerationDialog, confirmCancelNodeGeneration, ensureApiKeyReady, rejectGenerate, nodeUploadIsActive, applyTaskResultToNode, pollTaskUntilDone, resolvePendingVideoBillingBeforeSubmit, generateCanvasTextNode, generateWithActiveNode };
}
