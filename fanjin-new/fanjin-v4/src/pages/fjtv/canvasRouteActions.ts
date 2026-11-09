import type * as React from "react";
import type * as Router from "react-router-dom";
import { type NodeData, type EdgeData, type GroupData, type CanvasMetaState, type ArrangeSnapshot, type CanvasHistorySnapshot, type CanvasPersistRequest } from "./canvasDataTypes";
import { buildProjectModeHref, readProjectModeRouteContext } from "@/routes/projectModeRoutes";
import { assertCanvasOperationEpoch, type LatestWinsAsyncQueue } from "./canvasUploadRuntime";

export interface CanvasRouteActionsDependencies {
  canvasContextEpochRef: React.RefObject<number>;
  saveRevisionRef: React.RefObject<number>;
  hydratedRef: React.RefObject<boolean>;
  suppressNextAutoSaveRef: React.RefObject<boolean>;
  generationSessionRef: React.RefObject<Record<string, string>>;
  resumedFailedQueriesRef: React.RefObject<Set<string>>;
  setSubmittingNodeIds: React.Dispatch<React.SetStateAction<string[]>>;
  setSubmitButtonPendingKeys: React.Dispatch<React.SetStateAction<string[]>>;
  canvasStablePersistableNodesRef: React.RefObject<Map<string, NodeData>>;
  localResultPendingPersistenceRef: React.RefObject<Record<string, string>>;
  abortCanvasNodeUploads: (reason?: string) => void;
  saveTimerRef: React.RefObject<number | null>;
  canvasSaveQueueRef: React.RefObject<LatestWinsAsyncQueue<CanvasPersistRequest, string | null> | null>;
  currentProjectId: string | null;
  studioChrome: boolean;
  navigate: Router.NavigateFunction;
  location: Router.Location<any>;
  clearCanvasNodeTimers: () => void;
  setNodes: React.Dispatch<React.SetStateAction<NodeData[]>>;
  setEdges: React.Dispatch<React.SetStateAction<EdgeData[]>>;
  setGroups: React.Dispatch<React.SetStateAction<GroupData[]>>;
  setArrangeSnapshot: React.Dispatch<React.SetStateAction<ArrangeSnapshot | null>>;
  setArrangeConfirmOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setSelectedNodeIds: React.Dispatch<React.SetStateAction<string[]>>;
  setSelectedEdgeIds: React.Dispatch<React.SetStateAction<string[]>>;
  setActiveNodeId: React.Dispatch<React.SetStateAction<string | null>>;
  setActiveGroupId: React.Dispatch<React.SetStateAction<string | null>>;
  setUploading: React.Dispatch<React.SetStateAction<boolean>>;
  setExpanded: React.Dispatch<React.SetStateAction<boolean>>;
  setMediaViewerNodeId: React.Dispatch<React.SetStateAction<string | null>>;
  setOpenNodeMenuId: React.Dispatch<React.SetStateAction<string | null>>;
  setSidebarRenamingNodeId: React.Dispatch<React.SetStateAction<string | null>>;
  setSidebarRenameDraft: React.Dispatch<React.SetStateAction<string>>;
  historyReadyRef: React.RefObject<boolean>;
  historyCurrentRef: React.RefObject<CanvasHistorySnapshot | null>;
  undoStackRef: React.RefObject<CanvasHistorySnapshot[]>;
  contentAutoFitCanvasKeyRef: React.RefObject<string | null>;
  redoStackRef: React.RefObject<CanvasHistorySnapshot[]>;
  searchParams: URLSearchParams;
  setProjectMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setCanvasSwitcherOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setProjectBrowserFolderId: React.Dispatch<React.SetStateAction<string | null>>;
  setProjectBrowserReturnCanvasId: React.Dispatch<React.SetStateAction<string | null>>;
  canvasMeta: CanvasMetaState;
  routeCanvasId: string | undefined;
  setProjectBrowserOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setProjectActionMenuId: React.Dispatch<React.SetStateAction<string | null>>;
  setFolderActionMenuId: React.Dispatch<React.SetStateAction<string | null>>;
  setProjectBrowserRenamingId: React.Dispatch<React.SetStateAction<string | null>>;
  setProjectBrowserRenameDraft: React.Dispatch<React.SetStateAction<string>>;
  projectBrowserReturnCanvasId: string | null;
}

export function createCanvasRouteActions({
  canvasContextEpochRef,
  saveRevisionRef,
  hydratedRef,
  suppressNextAutoSaveRef,
  generationSessionRef,
  resumedFailedQueriesRef,
  setSubmittingNodeIds,
  setSubmitButtonPendingKeys,
  canvasStablePersistableNodesRef,
  localResultPendingPersistenceRef,
  abortCanvasNodeUploads,
  saveTimerRef,
  canvasSaveQueueRef,
  currentProjectId,
  studioChrome,
  navigate,
  location,
  clearCanvasNodeTimers,
  setNodes,
  setEdges,
  setGroups,
  setArrangeSnapshot,
  setArrangeConfirmOpen,
  setSelectedNodeIds,
  setSelectedEdgeIds,
  setActiveNodeId,
  setActiveGroupId,
  setUploading,
  setExpanded,
  setMediaViewerNodeId,
  setOpenNodeMenuId,
  setSidebarRenamingNodeId,
  setSidebarRenameDraft,
  historyReadyRef,
  historyCurrentRef,
  undoStackRef,
  contentAutoFitCanvasKeyRef,
  redoStackRef,
  searchParams,
  setProjectMenuOpen,
  setCanvasSwitcherOpen,
  setProjectBrowserFolderId,
  setProjectBrowserReturnCanvasId,
  canvasMeta,
  routeCanvasId,
  setProjectBrowserOpen,
  setProjectActionMenuId,
  setFolderActionMenuId,
  setProjectBrowserRenamingId,
  setProjectBrowserRenameDraft,
  projectBrowserReturnCanvasId,
}: CanvasRouteActionsDependencies) {
function assertCanvasOperationActive(expectedEpoch: number, signal?: AbortSignal) {
    if (signal?.aborted) {
      if (signal.reason instanceof Error) throw signal.reason;
      const error = new Error("画布操作已取消");
      error.name = "AbortError";
      throw error;
    }
    assertCanvasOperationEpoch(expectedEpoch, canvasContextEpochRef.current);
  }

function invalidateCanvasPersistenceContext() {
    canvasContextEpochRef.current += 1;
    saveRevisionRef.current += 1;
    hydratedRef.current = false;
    suppressNextAutoSaveRef.current = false;
    generationSessionRef.current = {};
    resumedFailedQueriesRef.current.clear();
    setSubmittingNodeIds([]);
    setSubmitButtonPendingKeys([]);
    canvasStablePersistableNodesRef.current.clear();
    localResultPendingPersistenceRef.current = {};
    abortCanvasNodeUploads("画布已切换，上传已取消");
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    // Detach the next canvas from pending work owned by the previous route.
    // Already-running writes may finish only against their captured old
    // canvas; queued writes fail their epoch check before touching the API.
    canvasSaveQueueRef.current?.reset();
  }

function navigateToCanvas(canvasId: string, projectId: string | null = currentProjectId) {
    invalidateCanvasPersistenceContext();
    if (!studioChrome) {
      navigate(`/canvas/${canvasId}`);
      return;
    }
    const routeContext = readProjectModeRouteContext(location);
    navigate(buildProjectModeHref("canvas", {
      projectId: projectId ?? routeContext.projectId,
      sessionId: routeContext.sessionId,
      threadId: routeContext.threadId,
      canvasId,
    }, location.search));
  }

function resetCanvasRuntimeState() {
    abortCanvasNodeUploads("画布状态已重置，上传已取消");
    generationSessionRef.current = {};
    resumedFailedQueriesRef.current.clear();
    setSubmittingNodeIds([]);
    setSubmitButtonPendingKeys([]);
    canvasStablePersistableNodesRef.current.clear();
    localResultPendingPersistenceRef.current = {};
    clearCanvasNodeTimers();
    setNodes([]);
    setEdges([]);
    setGroups([]);
    setArrangeSnapshot(null);
    setArrangeConfirmOpen(false);
    setSelectedNodeIds([]);
    setSelectedEdgeIds([]);
    setActiveNodeId(null);
    setActiveGroupId(null);
    setUploading(false);
    setExpanded(false);
    setMediaViewerNodeId(null);
    setOpenNodeMenuId(null);
    setSidebarRenamingNodeId(null);
    setSidebarRenameDraft("");
    historyReadyRef.current = false;
    historyCurrentRef.current = null;
    undoStackRef.current = [];
    contentAutoFitCanvasKeyRef.current = null;
    redoStackRef.current = [];
  }

function clearEntryQueryFlags(flagNames: string[]) {
    if (!flagNames.some((flag) => searchParams.has(flag))) return;
    const next = new URLSearchParams(searchParams);
    flagNames.forEach((flag) => next.delete(flag));
    const nextSearch = next.toString();
    navigate(`${location.pathname}${nextSearch ? `?${nextSearch}` : ""}`, { replace: true });
  }

function openProjectBrowser(preserveCanvas = true) {
    setProjectMenuOpen(false);
    setCanvasSwitcherOpen(false);
    setProjectBrowserFolderId(null);
    if (preserveCanvas) {
      setProjectBrowserReturnCanvasId(canvasMeta.canvasId || routeCanvasId || null);
    }
    if (studioChrome) {
      setProjectBrowserOpen(true);
      return;
    }
    navigate("/infinite-canvas-v2?browser=projects");
  }

function closeProjectBrowser() {
    setProjectBrowserOpen(false);
    setProjectBrowserFolderId(null);
    setProjectActionMenuId(null);
    setFolderActionMenuId(null);
    setProjectBrowserRenamingId(null);
    setProjectBrowserRenameDraft("");
    if (studioChrome) return;
    const targetCanvasId = projectBrowserReturnCanvasId || canvasMeta.canvasId || routeCanvasId || null;
    if (targetCanvasId) {
      navigateToCanvas(targetCanvasId);
      return;
    }
    navigate("/workbench/canvas/editor");
  }
  return { assertCanvasOperationActive, invalidateCanvasPersistenceContext, navigateToCanvas, resetCanvasRuntimeState, clearEntryQueryFlags, openProjectBrowser, closeProjectBrowser };
}
