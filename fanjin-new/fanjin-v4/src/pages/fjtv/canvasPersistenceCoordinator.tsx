import type { Dispatch, SetStateAction, RefObject, ReactNode, JSX } from "react";
import type { NavigateFunction, Location as RouterLocation } from "react-router-dom";
import { LAST_ACTIVE_CANVAS_KEY } from "./canvasPageConstants";
import { repairLegacyNodes } from "./canvasNodeDefaults";
import { createCanvasPersistenceWorker } from "./canvasPersistenceController";
import { hasRenderableNodeResultValue, patchLooksActivelyGenerating } from "./canvasTaskState";
import type { ViewportState, NodeData, EdgeData, GroupData, CanvasMetaState, CanvasConflictState, CanvasHistorySnapshot, CanvasPersistRequest } from "./canvasDataTypes";
import { canvasInterruptedSubmissionPatch } from "./canvasGenerationRecovery";
import { preserveNewerArtifactState } from "./canvasTextArtifacts";
import { buildUploadIsolatedPersistenceNodes, type LatestWinsAsyncQueue } from "./canvasUploadRuntime";
import { getNodeImageDisplayUrl, sanitizeLegacyDemoNode, shouldKeepLocalImageResult } from "./canvasAssetPresentation";
import { preserveActiveGenerationState } from "./canvasGenerationProgress";

export interface CanvasPersistenceControllerDependencies {
  localAssetRemoteUrlRef: RefObject<Record<string, string>>;
  canvasStablePersistableNodesRef: RefObject<Map<string, NodeData>>;
  canvasContextEpochRef: RefObject<number>;
  ensureApiKeyReady: () => boolean;
  canvasConflictRef: RefObject<boolean>;
  canvasMeta: CanvasMetaState;
  currentProjectId: string | null;
  routeProjectContextId: string | number | null | undefined;
  studioChrome: boolean;
  selectedProjectId: number | null;
  setStatus: Dispatch<SetStateAction<string>>;
  canvasServerRevisionRef: RefObject<number | null>;
  routeCanvasId: string | undefined;
  location: RouterLocation<any>;
  navigate: NavigateFunction;
  viewportRef: RefObject<ViewportState>;
  setCanvasConflict: Dispatch<SetStateAction<CanvasConflictState | null>>;
  setCanvasSaveState: Dispatch<SetStateAction<"error" | "dirty" | "saving" | "saved">>;
  localResultPendingPersistenceRef: RefObject<Record<string, string>>;
  setCanvasMeta: Dispatch<SetStateAction<CanvasMetaState>>;
  nodesRef: RefObject<NodeData[]>;
  latestCanvasSaveInputRef: RefObject<{ edges: EdgeData[]; groups: GroupData[]; name: string; }>;
  canvasSaveQueueRef: RefObject<LatestWinsAsyncQueue<CanvasPersistRequest, string | null> | null>;
  generationSessionRef: RefObject<Record<string, string>>;
  localGeometryEditUntilRef: RefObject<Record<string, number>>;
  locallyDeletedNodeIdsRef: RefObject<Set<string>>;
  setNodes: Dispatch<SetStateAction<NodeData[]>>;
  setEdges: Dispatch<SetStateAction<EdgeData[]>>;
  nodes: NodeData[];
  edges: EdgeData[];
  groups: GroupData[];
  viewport: ViewportState;
  canvasHistoryController: () => { buildHistorySnapshot: (nextNodes?: NodeData[], nextEdges?: EdgeData[], nextGroups?: GroupData[], nextViewport?: ViewportState) => CanvasHistorySnapshot; recordCanvasHistoryMutation: (snapshot: CanvasHistorySnapshot, previousSnapshot?: CanvasHistorySnapshot) => void; applyHistorySnapshot: (snapshot: CanvasHistorySnapshot) => void; undoCanvas: () => void; redoCanvas: () => void; };
}

export function createCanvasPersistenceController(deps: CanvasPersistenceControllerDependencies) {
  const { localAssetRemoteUrlRef, canvasStablePersistableNodesRef, canvasContextEpochRef, ensureApiKeyReady, canvasConflictRef, canvasMeta, currentProjectId, routeProjectContextId, studioChrome, selectedProjectId, setStatus, canvasServerRevisionRef, routeCanvasId, location, navigate, viewportRef, setCanvasConflict, setCanvasSaveState, localResultPendingPersistenceRef, setCanvasMeta, nodesRef, latestCanvasSaveInputRef, canvasSaveQueueRef, generationSessionRef, localGeometryEditUntilRef, locallyDeletedNodeIdsRef, setNodes, setEdges, nodes, edges, groups, viewport, canvasHistoryController } = deps;
function isEphemeralLocalUrl(value: string | undefined | null) {
    return /^blob:/i.test(String(value || ""));
  }

function sanitizeNodeForPersistence(node: NodeData): NodeData {
    const next = sanitizeLegacyDemoNode(node) as NodeData;
    const mappedPreviewUrl = next.localPreviewUrl ? localAssetRemoteUrlRef.current[next.localPreviewUrl] : "";
    const mappedVideoUrl = next.localVideoUrl ? localAssetRemoteUrlRef.current[next.localVideoUrl] : "";
    const mappedAudioUrl = next.localAudioUrl ? localAssetRemoteUrlRef.current[next.localAudioUrl] : "";

    if (mappedPreviewUrl && !next.imageUrl) next.imageUrl = mappedPreviewUrl;
    if (mappedPreviewUrl && !next.primaryImageUrl) next.primaryImageUrl = mappedPreviewUrl;
    if (mappedVideoUrl && !next.videoUrl) next.videoUrl = mappedVideoUrl;
    if (mappedAudioUrl && !next.audioUrl) next.audioUrl = mappedAudioUrl;

    if (isEphemeralLocalUrl(next.localPreviewUrl)) delete next.localPreviewUrl;
    if (isEphemeralLocalUrl(next.localVideoUrl)) delete next.localVideoUrl;
    if (isEphemeralLocalUrl(next.localAudioUrl)) delete next.localAudioUrl;
    if (isEphemeralLocalUrl(next.videoPosterUrl)) delete next.videoPosterUrl;
    delete next.uploadError;

    if ((next.type === "image" && next.imageUrl) || (next.type === "video" && next.videoUrl) || (next.type === "audio" && next.audioUrl)) {
      next.uploadState = "idle";
      delete next.uploadProgress;
    }
    // Render-only progress must never enter the autosave fingerprint, or every
    // 1s tick flips 「待保存」and re-arms the save timer.
    next.generationProgress = 0;
    delete next.statusChipText;
    delete next.statusChipTone;
    return next;
  }

function sanitizeNodesForPersistence(nextNodes: NodeData[]) {
    return buildUploadIsolatedPersistenceNodes(
      nextNodes,
      canvasStablePersistableNodesRef.current,
      sanitizeNodeForPersistence,
    );
  }

function canvasCoverUrl(nextNodes: NodeData[]) {
    return nextNodes.find((node) => node.imageUrl || node.primaryImageUrl)?.imageUrl || nextNodes.find((node) => node.imageUrl || node.primaryImageUrl)?.primaryImageUrl || "";
  }

async function persistCanvasOnce(
    nextNodes: NodeData[],
    nextEdges: EdgeData[],
    nextName: string,
    nextGroups: GroupData[],
    contextEpoch: number,
  ) {
    return await createCanvasPersistenceWorker({
      canvasContextEpochRef, ensureApiKeyReady, canvasConflictRef, canvasMeta, currentProjectId, routeProjectContextId, studioChrome, selectedProjectId, setStatus, canvasServerRevisionRef, routeCanvasId, location, navigate, LAST_ACTIVE_CANVAS_KEY, sanitizeNodesForPersistence, viewportRef, canvasCoverUrl, setCanvasConflict, setCanvasSaveState, localResultPendingPersistenceRef, setCanvasMeta
    })(nextNodes, nextEdges, nextName, nextGroups, contextEpoch);
  }

function persistCanvas(
    nextNodes = nodesRef.current,
    nextEdges = latestCanvasSaveInputRef.current.edges,
    nextName = latestCanvasSaveInputRef.current.name,
    nextGroups = latestCanvasSaveInputRef.current.groups,
  ) {
    const contextEpoch = canvasContextEpochRef.current;
    return canvasSaveQueueRef.current!.enqueue({
      nodes: nextNodes,
      edges: nextEdges,
      name: nextName,
      groups: nextGroups,
      contextEpoch,
    });
  }

function pickExternalNodePatch(remoteNode: NodeData) {
    const keys = [
      "isGenerating",
      "generationState",
      "taskStatus",
      "taskId",
      "taskKind",
      "textGenerationAttemptId",
      "textArtifacts", "textArtifactTab", "textArtifactInstruction", "textArtifactBindings", "textArtifactSourceModes",
      "artifactImageTarget", "textRequestAttempt", "artifactRevision", "textContentVersion",
      "imageGenerationAttemptId",
      "imageRequestAttempt", "imagePendingMessage", "imagePendingCode",
      "videoGenerationAttemptId", "videoRequestAttempt",
      "videoRenderMode", "videoDraftTaskId", "videoDraftExpiresAt", "videoDraftParentNodeId",
      "videoEnhanceAttemptId",
      "generationProgress",
      "preparationStage",
      "statusMessage",
      "lastError",
      "assets",
      "imageUrl",
      "primaryImageUrl",
      "imageResultVersion",
      "generatedImages",
      "imageChoicesCollapsed",
      "videoUrl",
      "videoPosterUrl",
      "videoRewriteSourceVideoUrl",
      "videoRewriteSourceAssetVersionId",
      "videoRewriteSourceReferenceAssetUri",
      "videoRewriteOutputVideoUrl",
      "videoRewriteOutputAssetVersionId",
      "videoRewriteOutputReferenceAssetUri",
      "videoRewriteInstruction",
      "videoRewriteStartMs",
      "videoRewriteEndMs",
      "videoRewriteViewing",
      "videoRewritePending",
      "audioUrl",
      "outputText",
      "textBackgroundColor",
      "textHeading",
      "textFontSize",
      "textBold",
      "textItalic",
      "textListStyle",
      "textDivider",
      "textExpanded",
      "uploadState",
      "uploadProgress",
      "fileName",
      "ratio",
      "mediaNaturalWidth",
      "mediaNaturalHeight",
      "width",
      "height",
      "videoStoryAnalysis", "videoWorkflow", "videoRedrawDraft", "videoRedrawSourceNodeId",
      "videoStoryAnalyzing",
      "videoStoryTaskId",
      "videoStoryTaskState",
      "videoStoryFailureReason",
      "videoStoryAttemptId",
      "videoStoryStoryboardGroupId",
      "scriptWorkflow",
      "updatedAt",
    ] as const;
    const patch: Partial<NodeData> = {};
    keys.forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(remoteNode as any, key)) {
        (patch as any)[key] = (remoteNode as any)[key];
      }
    });
    return patch;
  }

function externalValuesDiffer(localNode: NodeData, patch: Partial<NodeData>) {
    return Object.keys(patch).some((key) => JSON.stringify((localNode as any)[key] ?? null) !== JSON.stringify((patch as any)[key] ?? null));
  }

function hasLockedMediaAspect(node: Partial<NodeData>) {
    return Boolean(
      (node.type === "image" && (node.imageUrl || node.primaryImageUrl || node.localPreviewUrl)) ||
      (node.type === "video" && (node.videoUrl || node.localVideoUrl))
    );
  }

function normalizeExternalNodePatch(localNode: NodeData, patch: Partial<NodeData>) {
    const normalized: Partial<NodeData> = preserveNewerArtifactState(localNode, patch);
    const sameInterruptedAttempt = localNode.type === "image"
      ? localNode.imageGenerationAttemptId && localNode.imageGenerationAttemptId === normalized.imageGenerationAttemptId
      : localNode.videoGenerationAttemptId && localNode.videoGenerationAttemptId === normalized.videoGenerationAttemptId;
    if (localNode.taskStatus === "pending_reconcile" && !generationSessionRef.current[localNode.id] && sameInterruptedAttempt) {
      Object.assign(normalized, canvasInterruptedSubmissionPatch({ ...localNode, ...normalized }));
    }
    const localGeometryProtected = (localGeometryEditUntilRef.current[localNode.id] || 0) > Date.now();
    const localResultPendingPersistence = localResultPendingPersistenceRef.current[localNode.id];
    const remoteHasResult = hasRenderableNodeResultValue(normalized);
    const localHasResult = hasRenderableNodeResultValue(localNode);
    const remoteActive = patchLooksActivelyGenerating(normalized);
    const localIdle = !patchLooksActivelyGenerating(localNode);
    const remoteUploading = normalized.uploadState === "preparing" || normalized.uploadState === "uploading";
    const remoteImageClearsLocal = Object.prototype.hasOwnProperty.call(normalized, "imageUrl") && !normalized.imageUrl && Boolean(localNode.imageUrl);
    const remoteVideoClearsLocal = Object.prototype.hasOwnProperty.call(normalized, "videoUrl") && !normalized.videoUrl && Boolean(localNode.videoUrl);
    const remoteAudioClearsLocal = Object.prototype.hasOwnProperty.call(normalized, "audioUrl") && !normalized.audioUrl && Boolean(localNode.audioUrl);

    // CLI/remote polling can briefly persist an older "processing" snapshot after
    // the front-end has already rendered the completed media. Do not let that stale
    // snapshot put the node back into the breathing/progress state.
    if ((remoteHasResult || (localHasResult && localIdle)) && remoteActive) {
      normalized.isGenerating = false;
      normalized.generationState = "idle";
      normalized.taskStatus = remoteHasResult ? "success" : normalized.taskStatus;
      normalized.taskId = undefined;
      normalized.generationProgress = 0;
    }

    // Upload completion is written locally before the periodic canvas snapshot may
    // catch up. Ignore older remote "uploading" or empty media fields so a completed
    // upload cannot jump back to 9%/58% and keep breathing forever.
    if (localHasResult && (remoteUploading || remoteImageClearsLocal || remoteVideoClearsLocal || remoteAudioClearsLocal)) {
      delete normalized.uploadState;
      delete normalized.uploadProgress;
      delete normalized.localPreviewUrl;
      delete normalized.localVideoUrl;
      if (remoteImageClearsLocal) delete normalized.imageUrl;
      if (remoteVideoClearsLocal) delete normalized.videoUrl;
      if (remoteAudioClearsLocal) delete normalized.audioUrl;
    }

    // Do not let periodic sync replace a local result until the exact result
    // has been included in a successfully saved canvas revision.
    if (shouldKeepLocalImageResult(localNode, normalized as NodeData)) {
      delete normalized.imageUrl;
      delete normalized.primaryImageUrl;
      delete normalized.imageResultVersion;
      delete normalized.generatedImages;
      delete normalized.imageChoicesCollapsed;
      delete normalized.assetVersionId;
      delete normalized.referenceAssetUri;
    } else if (localResultPendingPersistence && localHasResult && remoteHasResult) {
      const localImageUrl = getNodeImageDisplayUrl(localNode);
      const remoteImageUrl = getNodeImageDisplayUrl(normalized as NodeData);
      if (localImageUrl === localResultPendingPersistence && remoteImageUrl && localImageUrl !== remoteImageUrl) {
        delete normalized.imageUrl;
        delete normalized.primaryImageUrl;
        delete normalized.generatedImages;
        delete normalized.imageChoicesCollapsed;
        delete normalized.assetVersionId;
        delete normalized.referenceAssetUri;
      }
    }

    if (remoteHasResult && !remoteActive) {
      normalized.isGenerating = false;
      normalized.generationState = "idle";
      normalized.taskStatus = normalized.taskStatus === "failed" ? "failed" : "success";
      normalized.taskId = undefined;
      normalized.generationProgress = 0;
      normalized.uploadState = "idle";
      delete normalized.uploadProgress;
    }

    if (localGeometryProtected) {
      delete normalized.ratio;
      delete normalized.mediaNaturalWidth;
      delete normalized.mediaNaturalHeight;
      delete normalized.width;
      delete normalized.height;
    } else if (localGeometryEditUntilRef.current[localNode.id]) {
      delete localGeometryEditUntilRef.current[localNode.id];
    }

    if (generationSessionRef.current[localNode.id]) {
      return preserveActiveGenerationState(normalized);
    } else if (remoteActive && !localIdle && normalized.taskId === localNode.taskId) {
      normalized.generationProgress = Math.max(localNode.generationProgress || 0, normalized.generationProgress || 0);
    }

    return normalized;
  }

function mergeExternalCanvasSnapshot(remoteNodesRaw: any[], remoteEdgesRaw: any[]) {
    const repairedRemoteNodes = repairLegacyNodes(Array.isArray(remoteNodesRaw) ? remoteNodesRaw : []);
    const remoteNodeIds = new Set(repairedRemoteNodes.map((node) => node.id));
    locallyDeletedNodeIdsRef.current.forEach((nodeId) => {
      if (!remoteNodeIds.has(nodeId)) locallyDeletedNodeIdsRef.current.delete(nodeId);
    });
    const deletedNodeIds = locallyDeletedNodeIdsRef.current;
    const remoteNodes = repairedRemoteNodes.filter((node) => !deletedNodeIds.has(node.id));
    const remoteById = new Map(remoteNodes.map((node) => [node.id, node]));

    setNodes((prev) => {
      let changed = false;
      const seen = new Set<string>();
      const next = prev.map((localNode) => {
        const remoteNode = remoteById.get(localNode.id);
        if (!remoteNode) return localNode;
        seen.add(localNode.id);
        const patch = normalizeExternalNodePatch(localNode, pickExternalNodePatch(remoteNode));
        if (!externalValuesDiffer(localNode, patch)) return localNode;
        changed = true;
        return { ...localNode, ...patch };
      });
      remoteNodes.forEach((remoteNode) => {
        if (!seen.has(remoteNode.id)) {
          changed = true;
          next.push(remoteNode);
        }
      });
      if (changed) nodesRef.current = next;
      return changed ? next : prev;
    });

    const remoteEdges = (Array.isArray(remoteEdgesRaw) ? remoteEdgesRaw : []).filter(
      (edge: any) => !deletedNodeIds.has(String(edge.fromNodeId || edge.source || "")) && !deletedNodeIds.has(String(edge.toNodeId || edge.target || "")),
    );
    if (remoteEdges.length) {
      setEdges((prev) => {
        const keyFor = (edge: any) => String(edge.id || `${edge.fromNodeId || edge.source}->${edge.toNodeId || edge.target}`);
        const known = new Set(prev.map(keyFor));
        const additions = remoteEdges.filter((edge) => !known.has(keyFor(edge)));
        return additions.length ? [...prev, ...additions] : prev;
      });
    }
  }

function buildHistorySnapshot(nextNodes = nodes, nextEdges = edges, nextGroups = groups, nextViewport = viewport): CanvasHistorySnapshot {
    return canvasHistoryController().buildHistorySnapshot(nextNodes, nextEdges, nextGroups, nextViewport);
  }

function recordCanvasHistoryMutation(snapshot: CanvasHistorySnapshot, previousSnapshot?: CanvasHistorySnapshot) {
    canvasHistoryController().recordCanvasHistoryMutation(snapshot, previousSnapshot);
  }

function applyHistorySnapshot(snapshot: CanvasHistorySnapshot) {
    canvasHistoryController().applyHistorySnapshot(snapshot);
  }

function undoCanvas() {
    canvasHistoryController().undoCanvas();
  }

function redoCanvas() {
    canvasHistoryController().redoCanvas();
  }
  return { isEphemeralLocalUrl, sanitizeNodeForPersistence, sanitizeNodesForPersistence, canvasCoverUrl, persistCanvasOnce, persistCanvas, pickExternalNodePatch, externalValuesDiffer, hasLockedMediaAspect, normalizeExternalNodePatch, mergeExternalCanvasSnapshot, buildHistorySnapshot, recordCanvasHistoryMutation, applyHistorySnapshot, undoCanvas, redoCanvas };
}
