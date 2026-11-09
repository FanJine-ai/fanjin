import { useEffect, type DependencyList, type Dispatch, type SetStateAction, type RefObject, type ReactNode, type JSX } from "react";
import type { CanvasShortcut, ViewportState, NodeData, EdgeData, GroupData, NodeDragState, GroupDragState, TextResizeState, EdgeHoverState, CanvasMetaState, CanvasHistorySnapshot } from "./canvasDataTypes";
import { shouldRefitCanvasAfterResize } from "./canvasAdaptiveLayout";
import { removeCanvasGraphSelection } from "./canvasGraphPolicy";
import { type CanvasAlignmentGuides as AlignmentGuides, type CanvasRect as Rect } from "./canvasGeometry";

interface UseCanvasConnectionHoldCleanupContext {
  nodeConnectionHoldTimerRef: RefObject<number | null>;
}

export function useCanvasConnectionHoldCleanup(readContext: () => UseCanvasConnectionHoldCleanupContext, dependencies: DependencyList) {
  useEffect(() => {
    const { nodeConnectionHoldTimerRef } = readContext();
    return () => {
    if (nodeConnectionHoldTimerRef.current !== null) {
      window.clearTimeout(nodeConnectionHoldTimerRef.current);
    }
  };
  }, dependencies);
}

interface UseCanvasVisibleResizeContext {
  setCanvasRenderTick: Dispatch<SetStateAction<number>>;
  canvasInteractionTimerRef: RefObject<number | null>;
}

export function useCanvasVisibleResize(readContext: () => UseCanvasVisibleResizeContext, dependencies: DependencyList) {
  useEffect(() => {
    const { setCanvasRenderTick, canvasInteractionTimerRef } = readContext();

    const refreshVisibleCanvas = () => setCanvasRenderTick((tick) => tick + 1);
    refreshVisibleCanvas();
    window.addEventListener("resize", refreshVisibleCanvas);
    return () => {
      window.removeEventListener("resize", refreshVisibleCanvas);
      if (canvasInteractionTimerRef.current !== null) {
        window.clearTimeout(canvasInteractionTimerRef.current);
        canvasInteractionTimerRef.current = null;
      }
    };

  }, dependencies);
}

interface UseCanvasWheelCleanupContext {
  wheelPanFrameRef: RefObject<number | null>;
}

export function useCanvasWheelCleanup(readContext: () => UseCanvasWheelCleanupContext, dependencies: DependencyList) {
  useEffect(() => {
    const { wheelPanFrameRef } = readContext();

    return () => {
      if (wheelPanFrameRef.current !== null) {
        window.cancelAnimationFrame(wheelPanFrameRef.current);
        wheelPanFrameRef.current = null;
      }
    };

  }, dependencies);
}

interface UseCanvasNativeWheelContext {
  rootRef: RefObject<HTMLDivElement | null>;
}

export function useCanvasNativeWheel(readContext: () => UseCanvasNativeWheelContext, dependencies: DependencyList) {
  useEffect(() => {
    const { rootRef } = readContext();

    const handleNativeWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      const root = rootRef.current;
      if (!root) return;
      if (!(event.target instanceof Node) || !root.contains(event.target)) return;
      event.preventDefault();
    };
    window.addEventListener("wheel", handleNativeWheel, { passive: false, capture: true });
    return () => window.removeEventListener("wheel", handleNativeWheel, { capture: true } as EventListenerOptions);

  }, dependencies);
}

interface UseCanvasMouseReleaseContext {
  setMiddlePanning: Dispatch<SetStateAction<{ active: boolean; sx: number; sy: number; px: number; py: number; }>>;
  setDragNode: Dispatch<SetStateAction<NodeDragState>>;
  setGroupDrag: Dispatch<SetStateAction<GroupDragState>>;
  setTextResize: Dispatch<SetStateAction<TextResizeState>>;
  setMiniMapDragging: Dispatch<SetStateAction<boolean>>;
  setAlignmentGuides: Dispatch<SetStateAction<AlignmentGuides | null>>;
}

export function useCanvasMouseRelease(readContext: () => UseCanvasMouseReleaseContext, dependencies: DependencyList) {
  useEffect(() => {
    const { setMiddlePanning, setDragNode, setGroupDrag, setTextResize, setMiniMapDragging, setAlignmentGuides } = readContext();

    const stop = () => {
      setMiddlePanning((prev) => ({ ...prev, active: false }));
      setDragNode({ active: false, nodeId: null, offsetX: 0, offsetY: 0 });
      setGroupDrag({ active: false, groupId: null, startX: 0, startY: 0, originalPositions: {}, startBounds: null });
      setTextResize({ active: false, nodeId: null, startX: 0, startY: 0, startWidth: 0, startHeight: 0 });
      setMiniMapDragging(false);
      setAlignmentGuides(null);
    };
    window.addEventListener("mouseup", stop);
    return () => window.removeEventListener("mouseup", stop);

  }, dependencies);
}

interface UseCanvasEdgeArmingContext {
  edgeHoverState: EdgeHoverState | null;
  EDGE_ARM_DELAY_MS: 1000;
  setEdgeHoverState: Dispatch<SetStateAction<EdgeHoverState | null>>;
}

export function useCanvasEdgeArming(readContext: () => UseCanvasEdgeArmingContext, dependencies: DependencyList) {
  useEffect(() => {
    const { edgeHoverState, EDGE_ARM_DELAY_MS, setEdgeHoverState } = readContext();

    if (!edgeHoverState || edgeHoverState.armed) return;
    const remain = EDGE_ARM_DELAY_MS - (Date.now() - edgeHoverState.enteredAt);
    const timer = window.setTimeout(() => {
      setEdgeHoverState((prev) => (prev ? { ...prev, armed: true } : prev));
    }, Math.max(0, remain));
    return () => window.clearTimeout(timer);

  }, dependencies);
}

interface UseCanvasMiniMapDragContext {
  miniMapDragging: boolean;
  readMiniMapSurfaceBox: () => { left: number; top: number; width: number; height: number; } | null;
  updateViewportFromMiniMap: (clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number; }) => void;
  setMiniMapDragging: Dispatch<SetStateAction<boolean>>;
}

export function useCanvasMiniMapDrag(readContext: () => UseCanvasMiniMapDragContext, dependencies: DependencyList) {
  useEffect(() => {
    const { miniMapDragging, readMiniMapSurfaceBox, updateViewportFromMiniMap, setMiniMapDragging } = readContext();

    if (!miniMapDragging) return;
    const onMove = (event: MouseEvent) => {
      const rect = readMiniMapSurfaceBox();
      if (!rect) return;
      event.preventDefault();
      updateViewportFromMiniMap(event.clientX, event.clientY, rect);
    };
    const onUp = () => setMiniMapDragging(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

  }, dependencies);
}

interface UseCanvasMiniMapMeasureContext {
  miniMapOpen: boolean;
  studioMiniMapVisible: boolean;
  setMiniMapSurfaceSize: Dispatch<SetStateAction<{ width: number; height: number; } | null>>;
  miniMapSurfaceRef: RefObject<HTMLDivElement | null>;
}

export function useCanvasMiniMapMeasure(readContext: () => UseCanvasMiniMapMeasureContext, dependencies: DependencyList) {
  useEffect(() => {
    const { miniMapOpen, studioMiniMapVisible, setMiniMapSurfaceSize, miniMapSurfaceRef } = readContext();

    if (!miniMapOpen && !studioMiniMapVisible) {
      setMiniMapSurfaceSize(null);
      return;
    }
    const surface = miniMapSurfaceRef.current;
    if (!surface) return;
    const measure = () => {
      setMiniMapSurfaceSize((prev) => {
        const next = { width: surface.clientWidth, height: surface.clientHeight };
        return prev && prev.width === next.width && prev.height === next.height ? prev : next;
      });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(surface);
    return () => observer.disconnect();

  }, dependencies);
}

interface UseCanvasInitialFitContext {
  canvasMeta: CanvasMetaState;
  nodes: NodeData[];
  canvasBounds: Rect | null;
  contentAutoFitCanvasKeyRef: RefObject<string | null>;
  studioChrome: boolean;
  doesViewportContainNode: (nextViewport?: ViewportState) => boolean;
  returnToCanvasContent: () => void;
}

export function useCanvasInitialFit(readContext: () => UseCanvasInitialFitContext, dependencies: DependencyList) {
  useEffect(() => {
    const { canvasMeta, nodes, canvasBounds, contentAutoFitCanvasKeyRef, studioChrome, doesViewportContainNode, returnToCanvasContent } = readContext();

    if (!canvasMeta.ready || canvasMeta.loading || nodes.length === 0 || !canvasBounds) return;
    const canvasKey = canvasMeta.canvasId || "draft";
    if (contentAutoFitCanvasKeyRef.current === canvasKey) return;
    contentAutoFitCanvasKeyRef.current = canvasKey;
    const timer = window.setTimeout(() => {
      if (studioChrome || !doesViewportContainNode()) returnToCanvasContent();
    }, 80);
    return () => window.clearTimeout(timer);

  }, dependencies);
}

interface UseCanvasStudioResizeContext {
  studioChrome: boolean;
  rootRef: RefObject<HTMLDivElement | null>;
  studioTopologyFitTimerRef: RefObject<number | null>;
  studioTopologyFitRef: RefObject<() => void>;
}

export function useCanvasStudioResize(readContext: () => UseCanvasStudioResizeContext, dependencies: DependencyList) {
  useEffect(() => {
    const { studioChrome, rootRef, studioTopologyFitTimerRef, studioTopologyFitRef } = readContext();

    if (!studioChrome || typeof ResizeObserver === "undefined") return;
    const root = rootRef.current;
    if (!root) return;

    let referenceSize: { width: number; height: number } | null = null;
    let topologyChangePending = false;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const nextSize = {
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      };
      if (!referenceSize) {
        referenceSize = nextSize;
        return;
      }
      if (shouldRefitCanvasAfterResize(referenceSize, nextSize)) {
        topologyChangePending = true;
      }
      if (!topologyChangePending) return;

      if (studioTopologyFitTimerRef.current !== null) {
        window.clearTimeout(studioTopologyFitTimerRef.current);
      }
      studioTopologyFitTimerRef.current = window.setTimeout(() => {
        studioTopologyFitTimerRef.current = null;
        referenceSize = nextSize;
        topologyChangePending = false;
        studioTopologyFitRef.current();
      }, 180);
    });
    observer.observe(root);
    return () => {
      observer.disconnect();
      if (studioTopologyFitTimerRef.current !== null) {
        window.clearTimeout(studioTopologyFitTimerRef.current);
        studioTopologyFitTimerRef.current = null;
      }
    };

  }, dependencies);
}

interface UseCanvasKeyboardShortcutsContext {
  isEditableKeyboardTarget: (target: EventTarget | null) => boolean;
  modelOpen: boolean;
  videoSettingsOpen: boolean;
  canvasShareOverlay: "menu" | "pointsPopover" | "user" | null;
  groupExecutionDialog: { groupId: string; } | null;
  cancelGenerationConfirmNodeId: string | null;
  projectDeleteConfirmId: string | null;
  cancelGenerationPending: boolean;
  projectDeletePending: boolean;
  closeBottomPanels: () => void;
  setAssetCreateModalOpen: Dispatch<SetStateAction<boolean>>;
  setLayoutDropdownOpen: Dispatch<SetStateAction<boolean>>;
  setColorPaletteOpen: Dispatch<SetStateAction<boolean>>;
  setSelectionLayoutMenuOpen: Dispatch<SetStateAction<boolean>>;
  setProjectMenuOpen: Dispatch<SetStateAction<boolean>>;
  setCanvasSwitcherOpen: Dispatch<SetStateAction<boolean>>;
  closeCanvasShareOverlay: (options?: { restoreFocus?: boolean | undefined; }) => void;
  closeGroupExecutionDialog: (options?: { restoreFocus?: boolean | undefined; }) => void;
  closeCancelGenerationDialog: (options?: { restoreFocus?: boolean | undefined; }) => void;
  closeProjectDeleteDialog: (options?: { restoreFocus?: boolean | undefined; }) => void;
  projectBrowserOpen: boolean;
  closeProjectBrowser: () => void;
  setActiveNodeId: Dispatch<SetStateAction<string | null>>;
  setSelectedNodeIds: Dispatch<SetStateAction<string[]>>;
  setSelectedEdgeIds: Dispatch<SetStateAction<string[]>>;
  modelMenuOpenerRef: RefObject<HTMLButtonElement | null>;
  videoSettingsOpenerRef: RefObject<HTMLButtonElement | null>;
  videoSettingsTriggerRef: RefObject<HTMLButtonElement | null>;
  shortcutPanelOpen: boolean;
  spacePressedRef: RefObject<boolean>;
  matchesCanvasShortcut: (event: KeyboardEvent, shortcut: CanvasShortcut) => boolean;
  CANVAS_SHORTCUTS: { undo: { keys: string[]; primary: true; alt: false; shift: false; }; redo: { keys: string[]; primary: true; alt: false; shift: true; }; group: { keys: string[]; primary: true; alt: true; shift: false; }; ungroup: { keys: string[]; primary: true; alt: true; shift: true; }; mergeStoryboardGroups: { keys: string[]; primary: true; alt: true; shift: false; }; duplicate: { keys: string[]; primary: true; alt: false; shift: true; }; connect: { keys: string[]; primary: true; alt: false; shift: false; }; generate: { keys: string[]; primary: true; alt: false; shift: false; }; createNode: { keys: string[]; primary: false; alt: false; shift: false; }; zoomIn: { keys: string[]; primary: true; alt: false; labelKey: string; }; zoomOut: { keys: string[]; primary: true; alt: false; shift: false; }; fitCanvas: { keys: string[]; primary: true; alt: false; shift: false; }; arrangeCanvas: { keys: string[]; primary: false; alt: true; shift: true; }; deleteSelection: { keys: string[]; }; };
  selectedNodeIds: string[];
  selectedEdgeIds: string[];
  locallyDeletedNodeIdsRef: RefObject<Set<string>>;
  nodes: NodeData[];
  edges: EdgeData[];
  groups: GroupData[];
  recordCanvasHistoryMutation: (snapshot: CanvasHistorySnapshot, previousSnapshot?: CanvasHistorySnapshot) => void;
  buildHistorySnapshot: (nextNodes?: NodeData[], nextEdges?: EdgeData[], nextGroups?: GroupData[], nextViewport?: ViewportState) => CanvasHistorySnapshot;
  viewport: ViewportState;
  setNodes: Dispatch<SetStateAction<NodeData[]>>;
  setEdges: Dispatch<SetStateAction<EdgeData[]>>;
  setGroups: Dispatch<SetStateAction<GroupData[]>>;
  activeNodeId: string | null;
  persistCanvas: (nextNodes?: NodeData[], nextEdges?: EdgeData[], nextName?: string, nextGroups?: GroupData[]) => Promise<string | null>;
  canvasMeta: CanvasMetaState;
  setStatus: Dispatch<SetStateAction<string>>;
  undoCanvas: () => void;
  redoCanvas: () => void;
  ungroupActive: () => void;
  createGroupFromSelection: () => void;
  mergeStoryboardGroupsShortcut: () => void;
  duplicateSelectedNodes: () => Promise<void>;
  connectSelectedNodesShortcut: () => void;
  generateWithActiveNode: (targetOverride?: NodeData) => Promise<boolean>;
  openShortcutCreateMenu: () => void;
  zoomCanvasBy: (factor: number) => void;
  returnToCanvasContent: () => void;
  arrangeCanvasLeftPreview: () => void;
}

export function useCanvasKeyboardShortcuts(readContext: () => UseCanvasKeyboardShortcutsContext, dependencies: DependencyList) {
  useEffect(() => {
    const { isEditableKeyboardTarget, modelOpen, videoSettingsOpen, canvasShareOverlay, groupExecutionDialog, cancelGenerationConfirmNodeId, projectDeleteConfirmId, cancelGenerationPending, projectDeletePending, closeBottomPanels, setAssetCreateModalOpen, setLayoutDropdownOpen, setColorPaletteOpen, setSelectionLayoutMenuOpen, setProjectMenuOpen, setCanvasSwitcherOpen, closeCanvasShareOverlay, closeGroupExecutionDialog, closeCancelGenerationDialog, closeProjectDeleteDialog, projectBrowserOpen, closeProjectBrowser, setActiveNodeId, setSelectedNodeIds, setSelectedEdgeIds, modelMenuOpenerRef, videoSettingsOpenerRef, videoSettingsTriggerRef, shortcutPanelOpen, spacePressedRef, matchesCanvasShortcut, CANVAS_SHORTCUTS, selectedNodeIds, selectedEdgeIds, locallyDeletedNodeIdsRef, nodes, edges, groups, recordCanvasHistoryMutation, buildHistorySnapshot, viewport, setNodes, setEdges, setGroups, activeNodeId, persistCanvas, canvasMeta, setStatus, undoCanvas, redoCanvas, ungroupActive, createGroupFromSelection, mergeStoryboardGroupsShortcut, duplicateSelectedNodes, connectSelectedNodesShortcut, generateWithActiveNode, openShortcutCreateMenu, zoomCanvasBy, returnToCanvasContent, arrangeCanvasLeftPreview } = readContext();

    const onKeyDown = (event: KeyboardEvent) => {
      const targetEditable = isEditableKeyboardTarget(event.target);

      if (event.key === "Escape") {
        const restoreModelMenuFocus = modelOpen;
        const restoreVideoSettingsFocus = videoSettingsOpen;
        const restoreCanvasShareFocus = canvasShareOverlay !== null;
        const restoreGroupExecutionFocus = groupExecutionDialog !== null;
        const restoreCancelGenerationFocus = cancelGenerationConfirmNodeId !== null;
        const restoreProjectDeleteFocus = projectDeleteConfirmId !== null;
        event.preventDefault();
        if ((restoreCancelGenerationFocus && cancelGenerationPending)
          || (restoreProjectDeleteFocus && projectDeletePending)) return;
        closeBottomPanels();
        setAssetCreateModalOpen(false);
        setLayoutDropdownOpen(false);
        setColorPaletteOpen(false);
        setSelectionLayoutMenuOpen(false);
        setProjectMenuOpen(false);
        setCanvasSwitcherOpen(false);
        if (restoreCanvasShareFocus) closeCanvasShareOverlay();
        if (restoreGroupExecutionFocus) closeGroupExecutionDialog();
        if (restoreCancelGenerationFocus) closeCancelGenerationDialog();
        if (restoreProjectDeleteFocus) closeProjectDeleteDialog();
        if (projectBrowserOpen && !restoreProjectDeleteFocus) closeProjectBrowser();
        if (!targetEditable && !restoreModelMenuFocus && !restoreVideoSettingsFocus && !restoreCanvasShareFocus
          && !restoreGroupExecutionFocus && !restoreCancelGenerationFocus && !restoreProjectDeleteFocus) {
          setActiveNodeId(null);
          setSelectedNodeIds([]);
          setSelectedEdgeIds([]);
        }
        if ((restoreModelMenuFocus || restoreVideoSettingsFocus)
          && !restoreCanvasShareFocus
          && !restoreGroupExecutionFocus
          && !restoreCancelGenerationFocus
          && !restoreProjectDeleteFocus) {
          window.requestAnimationFrame(() => {
            if (restoreModelMenuFocus) {
              modelMenuOpenerRef.current?.focus({ preventScroll: true });
              return;
            }
            (videoSettingsOpenerRef.current || videoSettingsTriggerRef.current)?.focus({ preventScroll: true });
          });
        }
        return;
      }

      if (targetEditable || shortcutPanelOpen) return;

      if (event.code === "Space") {
        spacePressedRef.current = true;
        event.preventDefault();
      }

      if (matchesCanvasShortcut(event, CANVAS_SHORTCUTS.deleteSelection) && (selectedNodeIds.length > 0 || selectedEdgeIds.length > 0)) {
        event.preventDefault();
        const removeNodeSet = new Set(selectedNodeIds);
        removeNodeSet.forEach((nodeId) => locallyDeletedNodeIdsRef.current.add(nodeId));
        const {
          nodes: nextNodes,
          edges: nextEdges,
          groups: nextGroups,
        } = removeCanvasGraphSelection({
          nodes,
          edges,
          groups,
          selectedNodeIds,
          selectedEdgeIds,
        });
        recordCanvasHistoryMutation(buildHistorySnapshot(nextNodes, nextEdges, nextGroups, viewport));
        setNodes(nextNodes);
        setEdges(nextEdges);
        setGroups(nextGroups);
        if (activeNodeId && removeNodeSet.has(activeNodeId)) setActiveNodeId(null);
        setSelectedNodeIds([]);
        setSelectedEdgeIds([]);
        void persistCanvas(nextNodes, nextEdges, canvasMeta.name, nextGroups);
        if (removeNodeSet.size) setStatus("已移除画布节点，素材仍保留在资产库，可撤销此次移除");
        return;
      }

      if (matchesCanvasShortcut(event, CANVAS_SHORTCUTS.undo)) {
        event.preventDefault();
        undoCanvas();
        return;
      }
      if (matchesCanvasShortcut(event, CANVAS_SHORTCUTS.redo)) {
        event.preventDefault();
        redoCanvas();
        return;
      }
      if (matchesCanvasShortcut(event, CANVAS_SHORTCUTS.ungroup)) {
        event.preventDefault();
        ungroupActive();
        return;
      }
      if (matchesCanvasShortcut(event, CANVAS_SHORTCUTS.group)) {
        event.preventDefault();
        createGroupFromSelection();
        return;
      }
      if (matchesCanvasShortcut(event, CANVAS_SHORTCUTS.mergeStoryboardGroups)) {
        event.preventDefault();
        mergeStoryboardGroupsShortcut();
        return;
      }
      if (matchesCanvasShortcut(event, CANVAS_SHORTCUTS.duplicate)) {
        event.preventDefault();
        void duplicateSelectedNodes();
        return;
      }
      if (matchesCanvasShortcut(event, CANVAS_SHORTCUTS.connect)) {
        event.preventDefault();
        connectSelectedNodesShortcut();
        return;
      }
      if (matchesCanvasShortcut(event, CANVAS_SHORTCUTS.generate)) {
        event.preventDefault();
        void generateWithActiveNode();
        return;
      }
      if (matchesCanvasShortcut(event, CANVAS_SHORTCUTS.createNode)) {
        event.preventDefault();
        openShortcutCreateMenu();
        return;
      }
      if (matchesCanvasShortcut(event, CANVAS_SHORTCUTS.zoomIn)) {
        event.preventDefault();
        zoomCanvasBy(1.12);
        return;
      }
      if (matchesCanvasShortcut(event, CANVAS_SHORTCUTS.zoomOut)) {
        event.preventDefault();
        zoomCanvasBy(1 / 1.12);
        return;
      }
      if (matchesCanvasShortcut(event, CANVAS_SHORTCUTS.fitCanvas)) {
        event.preventDefault();
        returnToCanvasContent();
        return;
      }
      if (matchesCanvasShortcut(event, CANVAS_SHORTCUTS.arrangeCanvas)) {
        event.preventDefault();
        arrangeCanvasLeftPreview();
      }
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === "Space") {
        spacePressedRef.current = false;
      }
    };

    const onWindowBlur = () => {
      spacePressedRef.current = false;
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onWindowBlur);
    };

  }, dependencies);
}
