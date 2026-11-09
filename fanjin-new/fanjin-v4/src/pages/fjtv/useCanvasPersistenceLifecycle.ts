import type { Location, NavigateFunction } from "react-router-dom";
import type { LoadedCanvasIdentity } from "./canvasLoadedIdentity";
import { useEffect, type DependencyList, type Dispatch, type SetStateAction, type RefObject, type ReactNode, type JSX } from "react";
import { positiveCanvasRevision, positiveCanvasProjectId } from "./canvasSnapshotCodec";
import type { ViewportState, NodeData, EdgeData, GroupData, ProjectListItem, SelectionBox, NodeDragState, GroupDragState, TextResizeState, DraftLine, CanvasMetaState, CanvasConflictState, CanvasHistorySnapshot } from "./canvasDataTypes";
import { api } from "@/lib/api";
import { cloneHistorySnapshot } from "./canvasAssetPresentation";

interface UseCanvasNodesRefContext {
  nodesRef: RefObject<NodeData[]>;
  nodes: NodeData[];
}

export function useCanvasNodesRef(readContext: () => UseCanvasNodesRefContext, dependencies: DependencyList) {
  useEffect(() => {
    const { nodesRef, nodes } = readContext();

    nodesRef.current = nodes;

  }, dependencies);
}

interface UseCanvasViewportRefContext {
  viewportRef: RefObject<ViewportState>;
  viewport: ViewportState;
}

export function useCanvasViewportRef(readContext: () => UseCanvasViewportRefContext, dependencies: DependencyList) {
  useEffect(() => {
    const { viewportRef, viewport } = readContext();

    viewportRef.current = viewport;

  }, dependencies);
}

interface UseCanvasHydrationContext {
  canvasServerRevisionRef: RefObject<number | null>;
  canvasConflictRef: RefObject<boolean>;
  setCanvasConflict: Dispatch<SetStateAction<CanvasConflictState | null>>;
  ensureApiKeyReady: () => boolean;
  LAST_ACTIVE_CANVAS_KEY: "infinite_canvas_last_active_canvas_id";
  routeCanvasId: string | undefined;
  searchParams: URLSearchParams;
  forceFreshCanvasEntry: boolean;
  canvasMeta: CanvasMetaState;
  location: Location<any>;
  setCanvasMeta: Dispatch<SetStateAction<CanvasMetaState>>;
  hydratedRef: RefObject<boolean>;
  replaceCanvasFromServer: (result: any, fallbackCanvasId: string, options?: { seedBrief?: boolean; }) => LoadedCanvasIdentity;
  resetCanvasRuntimeState: () => void;
  routeProjectContextId: string | number | null | undefined;
  setCurrentProjectId: Dispatch<SetStateAction<string | null>>;
  currentProject: ProjectListItem | null;
  clearEntryQueryFlags: (flagNames: string[]) => void;
  navigate: NavigateFunction;
  setCanvasSaveState: Dispatch<SetStateAction<"error" | "dirty" | "saving" | "saved">>;
  setStatus: Dispatch<SetStateAction<string>>;
}

export function useCanvasHydration(readContext: () => UseCanvasHydrationContext, dependencies: DependencyList) {
  useEffect(() => {
    const { canvasServerRevisionRef, canvasConflictRef, setCanvasConflict, ensureApiKeyReady, LAST_ACTIVE_CANVAS_KEY, routeCanvasId, searchParams, forceFreshCanvasEntry, canvasMeta, location, setCanvasMeta, hydratedRef, replaceCanvasFromServer, resetCanvasRuntimeState, routeProjectContextId, setCurrentProjectId, currentProject, clearEntryQueryFlags, navigate, setCanvasSaveState, setStatus } = readContext();

    let disposed = false;
    canvasServerRevisionRef.current = null;
    canvasConflictRef.current = false;
    setCanvasConflict(null);

    async function bootstrapCanvas() {
      if (!ensureApiKeyReady()) return;
      const lastCanvasId = window.localStorage.getItem(LAST_ACTIVE_CANVAS_KEY);
      const explicitCanvasId = routeCanvasId ?? searchParams.get("canvasId");
      const targetCanvasId = forceFreshCanvasEntry
        ? explicitCanvasId
        : explicitCanvasId ?? canvasMeta.canvasId ?? (location.pathname === "/infinite-canvas-v2" ? lastCanvasId : null);
      try {
        setCanvasMeta((prev) => ({ ...prev, loading: true }));
        if (forceFreshCanvasEntry) {
          const loaded = targetCanvasId ? await api.loadCanvas(targetCanvasId) : null;
          if (disposed) return;
          hydratedRef.current = true;
          if (targetCanvasId && loaded) {
            replaceCanvasFromServer(loaded, targetCanvasId);
          } else {
            resetCanvasRuntimeState();
            const projectId = positiveCanvasProjectId(routeProjectContextId);
            setCurrentProjectId(projectId);
            setCanvasMeta({
              canvasId: null,
              projectId,
              revision: null,
              name: currentProject?.name || "未命名项目",
              loading: false,
              ready: true,
            });
          }
          clearEntryQueryFlags(["mode", "empty"]);
          return;
        }

        if (targetCanvasId) {
          const result = await api.loadCanvas(targetCanvasId);
          if (disposed) return;
          const identity = replaceCanvasFromServer(result, targetCanvasId, { seedBrief: true });
          if (!routeCanvasId && location.pathname === "/infinite-canvas-v2") {
            navigate(`/canvas/${identity.canvasId}`, { replace: true });
          }
          hydratedRef.current = true;
          return;
        }

        // 没有指定 canvasId 且也没有最近画布时，保持空白引导态。
        hydratedRef.current = true;
        resetCanvasRuntimeState();
        const projectId = positiveCanvasProjectId(routeProjectContextId);
        setCurrentProjectId(projectId);
        canvasServerRevisionRef.current = null;
        setCanvasMeta((prev) => ({
          ...prev,
          canvasId: null,
          projectId,
          revision: null,
          name: currentProject?.name || prev.name || "未命名项目",
          loading: false,
          ready: true,
        }));
      } catch (error) {
        if (disposed) return;
        hydratedRef.current = true;
        canvasServerRevisionRef.current = null;
        setCanvasMeta((prev) => ({
          ...prev,
          canvasId: targetCanvasId || null,
          projectId: positiveCanvasProjectId(routeProjectContextId),
          revision: null,
          loading: false, ready: false,
        }));
        setCanvasSaveState("error");
        const message = error instanceof Error ? error.message : "请从项目列表重新打开";
        setStatus(`画布加载失败：${message}`);
      }
    }

    void bootstrapCanvas();
    return () => {
      disposed = true;
    };

  }, dependencies);
}

interface UseCanvasExternalSyncContext {
  canvasMeta: CanvasMetaState;
  canvasServerRevisionRef: RefObject<number | null>;
  setCanvasSaveState: Dispatch<SetStateAction<"error" | "dirty" | "saving" | "saved">>;
  setStatus: Dispatch<SetStateAction<string>>;
  canvasSaveState: "error" | "dirty" | "saving" | "saved";
  saveTimerRef: RefObject<number | null>;
  canvasConflictRef: RefObject<boolean>;
  setCanvasConflict: Dispatch<SetStateAction<CanvasConflictState | null>>;
  suppressNextAutoSaveRef: RefObject<boolean>;
  replaceCanvasFromServer: (result: any, fallbackCanvasId: string, options?: { seedBrief?: boolean; }) => LoadedCanvasIdentity;
  setCanvasSavedAt: Dispatch<SetStateAction<Date | null>>;
  mergeExternalCanvasSnapshot: (remoteNodesRaw: any[], remoteEdgesRaw: any[]) => void;
}

export function useCanvasExternalSync(readContext: () => UseCanvasExternalSyncContext, dependencies: DependencyList) {
  useEffect(() => {
    const { canvasMeta, canvasServerRevisionRef, setCanvasSaveState, setStatus, canvasSaveState, saveTimerRef, canvasConflictRef, setCanvasConflict, suppressNextAutoSaveRef, replaceCanvasFromServer, setCanvasSavedAt, mergeExternalCanvasSnapshot } = readContext();

    if (!canvasMeta.canvasId || !canvasMeta.ready || canvasMeta.loading) return;
    let disposed = false;
    let inFlight = false;

    async function refreshCanvasFromServer() {
      if (disposed || inFlight || document.hidden) return;
      inFlight = true;
      try {
        const result = await api.loadCanvas(canvasMeta.canvasId!);
        if (disposed) return;
        const remoteRevision = positiveCanvasRevision((result as any)?.revision);
        const localRevision = canvasServerRevisionRef.current;
        if (remoteRevision === null || localRevision === null) {
          setCanvasSaveState("error");
          setStatus("无法验证服务器画布版本，已停止后台同步");
          return;
        }
        if (remoteRevision > localRevision) {
          if (canvasSaveState !== "saved" || saveTimerRef.current !== null) {
            canvasConflictRef.current = true;
            setCanvasConflict({
              message: "画布已在其他标签页或 Agent 中更新",
              expectedRevision: localRevision,
              currentRevision: remoteRevision,
            });
            setCanvasSaveState("error");
            setStatus("检测到并发更新，本地修改尚未覆盖服务器，请加载最新版本");
            return;
          }
          suppressNextAutoSaveRef.current = true;
          replaceCanvasFromServer(result, canvasMeta.canvasId!);
          setCanvasSavedAt(new Date());
          setCanvasSaveState("saved");
          setStatus("已同步其他标签页或 Agent 的最新画布");
          return;
        }
        if (remoteRevision < localRevision) return;
        const remoteNodes = Array.isArray((result as any)?.nodes) ? (result as any).nodes : [];
        const remoteEdges = Array.isArray((result as any)?.connections) ? (result as any).connections : Array.isArray((result as any)?.edges) ? (result as any).edges : [];
        mergeExternalCanvasSnapshot(remoteNodes, remoteEdges);
      } catch (error) {
        // 后台同步失败不打断画布编辑，下一轮继续尝试。
      } finally {
        inFlight = false;
      }
    }

    const intervalId = window.setInterval(refreshCanvasFromServer, 2500);
    return () => {
      disposed = true;
      window.clearInterval(intervalId);
    };

  }, dependencies);
}

interface UseCanvasAutoSaveContext {
  hydratedRef: RefObject<boolean>;
  canvasMeta: CanvasMetaState;
  readOnlyProofMode: boolean;
  suppressNextAutoSaveRef: RefObject<boolean>;
  canvasConflictRef: RefObject<boolean>;
  studioChrome: boolean;
  saveTimerRef: RefObject<number | null>;
  saveRevisionRef: RefObject<number>;
  setCanvasSaveState: Dispatch<SetStateAction<"error" | "dirty" | "saving" | "saved">>;
  canvasAutosaveSnapshotRef: RefObject<{ nodes: NodeData[]; edges: EdgeData[]; groups: GroupData[]; }>;
  persistCanvas: (nextNodes?: NodeData[], nextEdges?: EdgeData[], nextName?: string, nextGroups?: GroupData[]) => Promise<string | null>;
  setCanvasSavedAt: Dispatch<SetStateAction<Date | null>>;
}

export function useCanvasAutoSave(readContext: () => UseCanvasAutoSaveContext, dependencies: DependencyList) {
  useEffect(() => {
    const { hydratedRef, canvasMeta, readOnlyProofMode, suppressNextAutoSaveRef, canvasConflictRef, studioChrome, saveTimerRef, saveRevisionRef, setCanvasSaveState, canvasAutosaveSnapshotRef, persistCanvas, setCanvasSavedAt } = readContext();

    if (!hydratedRef.current || !canvasMeta.ready) return;
    if (readOnlyProofMode) return;
    if (suppressNextAutoSaveRef.current) {
      suppressNextAutoSaveRef.current = false;
      return;
    }
    if (canvasConflictRef.current) return;
    // The studio project browser deliberately has no active canvas. Do not let
    // its blank background materialize an orphan canvas while the user is only
    // choosing the next project.
    if (studioChrome && !canvasMeta.canvasId) return;
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    const saveRevision = saveRevisionRef.current + 1;
    saveRevisionRef.current = saveRevision;
    setCanvasSaveState("dirty");
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      setCanvasSaveState("saving");
      const snapshot = canvasAutosaveSnapshotRef.current;
      void persistCanvas(snapshot.nodes, snapshot.edges, canvasMeta.name, snapshot.groups)
        .then((canvasId) => {
          if (saveRevisionRef.current !== saveRevision) return;
          if (!canvasId) {
            setCanvasSaveState("error");
            return;
          }
          setCanvasSavedAt(new Date());
          setCanvasSaveState("saved");
        })
        .catch(() => {
          if (saveRevisionRef.current === saveRevision) setCanvasSaveState("error");
        });
    }, 450);
    return () => {
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };

  }, dependencies);
}

interface UseCanvasHistoryCaptureContext {
  hydratedRef: RefObject<boolean>;
  canvasMeta: CanvasMetaState;
  middlePanning: { active: boolean; sx: number; sy: number; px: number; py: number; };
  dragNode: NodeDragState;
  groupDrag: GroupDragState;
  textResize: TextResizeState;
  selectionBox: SelectionBox;
  draftLine: DraftLine | null;
  buildHistorySnapshot: (nextNodes?: NodeData[], nextEdges?: EdgeData[], nextGroups?: GroupData[], nextViewport?: ViewportState) => CanvasHistorySnapshot;
  historyReadyRef: RefObject<boolean>;
  historyCurrentRef: RefObject<CanvasHistorySnapshot | null>;
  historyApplyingRef: RefObject<boolean>;
  historyTimerRef: RefObject<number | null>;
  undoStackRef: RefObject<CanvasHistorySnapshot[]>;
  redoStackRef: RefObject<CanvasHistorySnapshot[]>;
}

export function useCanvasHistoryCapture(readContext: () => UseCanvasHistoryCaptureContext, dependencies: DependencyList) {
  useEffect(() => {
    const { hydratedRef, canvasMeta, middlePanning, dragNode, groupDrag, textResize, selectionBox, draftLine, buildHistorySnapshot, historyReadyRef, historyCurrentRef, historyApplyingRef, historyTimerRef, undoStackRef, redoStackRef } = readContext();

    if (!hydratedRef.current || !canvasMeta.ready) return;
    if (middlePanning.active || dragNode.active || groupDrag.active || textResize.active || selectionBox.active || Boolean(draftLine)) return;
    const snapshot = buildHistorySnapshot();
    if (!historyReadyRef.current) {
      historyReadyRef.current = true;
      historyCurrentRef.current = cloneHistorySnapshot(snapshot);
      return;
    }
    if (historyApplyingRef.current) {
      historyApplyingRef.current = false;
      historyCurrentRef.current = cloneHistorySnapshot(snapshot);
      return;
    }
    const previous = historyCurrentRef.current;
    if (!previous) {
      historyCurrentRef.current = cloneHistorySnapshot(snapshot);
      return;
    }
    if (JSON.stringify(previous) === JSON.stringify(snapshot)) return;
    if (historyTimerRef.current) window.clearTimeout(historyTimerRef.current);
    historyTimerRef.current = window.setTimeout(() => {
      const previousSnapshot = historyCurrentRef.current;
      if (!previousSnapshot) return;
      undoStackRef.current.push(cloneHistorySnapshot(previousSnapshot));
      if (undoStackRef.current.length > 80) undoStackRef.current.shift();
      redoStackRef.current = [];
      historyCurrentRef.current = cloneHistorySnapshot(snapshot);
    }, 180);
    return () => {
      if (historyTimerRef.current) window.clearTimeout(historyTimerRef.current);
    };

  }, dependencies);
}
