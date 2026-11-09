import type { Dispatch, SetStateAction, RefObject, ReactNode, JSX } from "react";
import { shouldIgnoreCanvasWheelExternal } from "./canvasWheelGuards";
import type { Side, MenuSource, MaxImageCount, VideoEnhanceVersion, VideoEnhanceResolution, VideoEnhanceFrameRate, VideoSubtitleEraseType, AudioSeparateRole, ImageEnhanceVersion, ImageEraseKind, TextNodeHeading, TextNodeListStyle, EraseRatioLocation, ViewportState, CameraSettings, VideoStoryAnalysis, VideoStoryTaskState, ProductScriptWorkflow, NodeData, ImageGridSplitDragState, EdgeData, GroupData, SelectionBox, NodeDragState, GroupDragState, TextResizeState, DraftLine, EdgeHoverState, PendingConnection, VideoGenerationMode } from "./canvasDataTypes";
import type { NodeType, RatioKey, ImageOutpaintRatioMode, ImageOutpaintResolution } from "./canvasMediaTypes";
import { type VideoOutputFormat } from "../../features/quick-create/videoOutputContract";
import { isCanvasBackgroundTarget } from "./canvasInteraction";
import { type CanvasArtifactKind } from "./canvasTextArtifacts";
import { type PersistedComposeClip } from "./canvasComposeTimeline";
import { alignmentForRect, collectGroupBounds, findGroupByNode, rectFromNode, rectSelectsNode, type CanvasAlignmentGuides as AlignmentGuides, type CanvasRect as Rect } from "./canvasGeometry";
import { type GeneratedImageChoice } from "./canvasTaskResults";

export interface CanvasInteractionControllerDependencies {
  nodeConnectionHoldTimerRef: RefObject<number | null>;
  nodeConnectionHoldRef: RefObject<{ nodeId: string; clientX: number; clientY: number; worldX: number; worldY: number; } | null>;
  toWorld: (clientX: number, clientY: number) => { x: number; y: number; };
  setDragNode: Dispatch<SetStateAction<NodeDragState>>;
  setEdgeDropTarget: Dispatch<SetStateAction<{ nodeId: string; side: Side; } | null>>;
  setDraftLine: Dispatch<SetStateAction<DraftLine | null>>;
  connectionSideToward: (node: NodeData, targetX: number) => Side;
  groups: GroupData[];
  setActiveGroupId: Dispatch<SetStateAction<string | null>>;
  setSelectedNodeIds: Dispatch<SetStateAction<string[]>>;
  setSelectedEdgeIds: Dispatch<SetStateAction<string[]>>;
  setActiveNodeId: Dispatch<SetStateAction<string | null>>;
  closePromptMenus: () => void;
  setLayoutDropdownOpen: Dispatch<SetStateAction<boolean>>;
  setColorPaletteOpen: Dispatch<SetStateAction<boolean>>;
  setSelectionLayoutMenuOpen: Dispatch<SetStateAction<boolean>>;
  CONNECTION_DRAG_THRESHOLD: 6;
  middlePanning: { active: boolean; sx: number; sy: number; px: number; py: number; };
  groupDrag: GroupDragState;
  selectionBox: SelectionBox;
  textResize: TextResizeState;
  dragNode: NodeDragState;
  draftLine: DraftLine | null;
  markCanvasInteraction: () => void;
  ALIGN_THRESHOLD_PX: 8;
  viewportVisualScale: (nextViewport?: ViewportState) => number;
  setViewport: Dispatch<SetStateAction<ViewportState>>;
  setAlignmentGuides: Dispatch<SetStateAction<AlignmentGuides | null>>;
  imageGridSplitDragRef: RefObject<ImageGridSplitDragState | null>;
  nodeMap: Map<string, NodeData>;
  parseGridCellKey: (key: string) => { row: number; col: number; };
  createDetachedImageGridCellNode: (sourceNode: NodeData, row: number, col: number, rows: number, cols: number, left: number, top: number, stamp: number) => NodeData;
  nodes: NodeData[];
  edges: EdgeData[];
  setNodes: Dispatch<SetStateAction<NodeData[]>>;
  setEdges: Dispatch<SetStateAction<EdgeData[]>>;
  persistCanvas: (nextNodes?: NodeData[], nextEdges?: EdgeData[], nextName?: string, nextGroups?: GroupData[]) => Promise<string | null>;
  imageGridSplitSuppressClickRef: RefObject<boolean>;
  gridSnapEnabled: boolean;
  setSelectionBox: Dispatch<SetStateAction<SelectionBox>>;
  interactionPerformanceMode: boolean;
  visibleNodeIdSet: Set<string>;
  detectEdgeDropTarget: (worldX: number, worldY: number, fromNodeId: string) => { nodeId: string; side: Side; } | null;
  nodeSocket: (node: NodeData, side: Side) => { x: number; y: number; };
  detectEdgeHover: (worldX: number, worldY: number) => { edgeId: string; point: { x: number; y: number; }; distance: number; } | null;
  setEdgeHoverState: Dispatch<SetStateAction<EdgeHoverState | null>>;
  editingGroupTitleId: string | null;
  commitGroupTitle: (groupId: string, fallbackTitle: string) => void;
  cancelGroupTitleEdit: () => void;
  spacePressedRef: RefObject<boolean>;
  setMiddlePanning: Dispatch<SetStateAction<{ active: boolean; sx: number; sy: number; px: number; py: number; }>>;
  viewport: ViewportState;
  edgeHoverState: EdgeHoverState | null;
  edgeHitToleranceInWorld: () => number;
  removeEdge: (edgeId: string) => void;
  activeGroup: GroupData | null;
  activeGroupBounds: { left: number; top: number; right: number; bottom: number; } | null;
  beginGroupDrag: (group: GroupData, startWorldX: number, startWorldY: number, startBounds: Rect) => void;
  setTextColorMenuNodeId: Dispatch<SetStateAction<string | null>>;
  setRatioOpen: Dispatch<SetStateAction<boolean>>;
  setModelOpen: Dispatch<SetStateAction<boolean>>;
  setQuantityOpen: Dispatch<SetStateAction<boolean>>;
  setCameraOpen: Dispatch<SetStateAction<boolean>>;
  setProjectMenuOpen: Dispatch<SetStateAction<boolean>>;
  setCanvasSwitcherOpen: Dispatch<SetStateAction<boolean>>;
  editingTextNodeId: string | null;
  commitTextNodeEditing: () => void;
  resetSelectedExpandedTextNodes: () => boolean;
  setExpanded: Dispatch<SetStateAction<boolean>>;
  setStatus: Dispatch<SetStateAction<string>>;
  closeBottomPanels: () => void;
  setProjectBrowserOpen: Dispatch<SetStateAction<boolean>>;
  setStoryboardSlotMenuNodeId: Dispatch<SetStateAction<string | null>>;
  setStoryboardSlotMenuPosition: Dispatch<SetStateAction<{ x: number; y: number; } | null>>;
  canvasPointerMode: "select" | "hand";
  setGroupDrag: Dispatch<SetStateAction<GroupDragState>>;
  setTextResize: Dispatch<SetStateAction<TextResizeState>>;
  edgeIntersectsRect: (edge: EdgeData, rect: Rect) => boolean;
  hasDuplicateEdge: (fromNodeId: string, fromSide: Side, toNodeId: string, toSide: Side) => boolean;
  admitCanvasReferenceEdge: (fromNodeId: string, toNodeId: string) => { ok: true; } | { ok: false; message: string; };
  openCreationMenuAtWorld: (x: number, y: number, source: MenuSource, nextPending?: PendingConnection | null) => void;
  wheelPanDeltaRef: RefObject<{ x: number; y: number; }>;
  viewportRef: RefObject<ViewportState>;
  wheelPanFrameRef: RefObject<number | null>;
  rootRef: RefObject<HTMLDivElement | null>;
  CANVAS_VISUAL_SCALE: 1.25;
}

export function createCanvasInteractionController(deps: CanvasInteractionControllerDependencies) {
  const { nodeConnectionHoldTimerRef, nodeConnectionHoldRef, toWorld, setDragNode, setEdgeDropTarget, setDraftLine, connectionSideToward, groups, setActiveGroupId, setSelectedNodeIds, setSelectedEdgeIds, setActiveNodeId, closePromptMenus, setLayoutDropdownOpen, setColorPaletteOpen, setSelectionLayoutMenuOpen, CONNECTION_DRAG_THRESHOLD, middlePanning, groupDrag, selectionBox, textResize, dragNode, draftLine, markCanvasInteraction, ALIGN_THRESHOLD_PX, viewportVisualScale, setViewport, setAlignmentGuides, imageGridSplitDragRef, nodeMap, parseGridCellKey, createDetachedImageGridCellNode, nodes, edges, setNodes, setEdges, persistCanvas, imageGridSplitSuppressClickRef, gridSnapEnabled, setSelectionBox, interactionPerformanceMode, visibleNodeIdSet, detectEdgeDropTarget, nodeSocket, detectEdgeHover, setEdgeHoverState, editingGroupTitleId, commitGroupTitle, cancelGroupTitleEdit, spacePressedRef, setMiddlePanning, viewport, edgeHoverState, edgeHitToleranceInWorld, removeEdge, activeGroup, activeGroupBounds, beginGroupDrag, setTextColorMenuNodeId, setRatioOpen, setModelOpen, setQuantityOpen, setCameraOpen, setProjectMenuOpen, setCanvasSwitcherOpen, editingTextNodeId, commitTextNodeEditing, resetSelectedExpandedTextNodes, setExpanded, setStatus, closeBottomPanels, setProjectBrowserOpen, setStoryboardSlotMenuNodeId, setStoryboardSlotMenuPosition, canvasPointerMode, setGroupDrag, setTextResize, edgeIntersectsRect, hasDuplicateEdge, admitCanvasReferenceEdge, openCreationMenuAtWorld, wheelPanDeltaRef, viewportRef, wheelPanFrameRef, rootRef, CANVAS_VISUAL_SCALE } = deps;
function clearNodeConnectionHold() {
    if (nodeConnectionHoldTimerRef.current !== null) {
      window.clearTimeout(nodeConnectionHoldTimerRef.current);
      nodeConnectionHoldTimerRef.current = null;
    }
    nodeConnectionHoldRef.current = null;
  }

function beginNodeConnectionHold(node: NodeData, event: React.MouseEvent<HTMLElement>) {
    const point = toWorld(event.clientX, event.clientY);
    nodeConnectionHoldRef.current = {
      nodeId: node.id,
      clientX: event.clientX,
      clientY: event.clientY,
      worldX: point.x,
      worldY: point.y,
    };
    nodeConnectionHoldTimerRef.current = window.setTimeout(() => {
      const pending = nodeConnectionHoldRef.current;
      if (!pending || pending.nodeId !== node.id) return;
      clearNodeConnectionHold();
      setDragNode((current) =>
        current.nodeId === node.id ? { active: false, nodeId: null, offsetX: 0, offsetY: 0 } : current,
      );
      setEdgeDropTarget(null);
      setDraftLine({
        fromNodeId: node.id,
        fromSide: connectionSideToward(node, pending.worldX),
        fromX: pending.worldX,
        fromY: pending.worldY,
        toX: pending.worldX,
        toY: pending.worldY,
        startClientX: pending.clientX,
        startClientY: pending.clientY,
        hasMoved: false,
      });
    }, 250);
  }

function beginNodeMove(node: NodeData, event: React.MouseEvent<HTMLElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const pointerWorld = toWorld(event.clientX, event.clientY);
    const owningGroup = findGroupByNode(groups, node.id);
    setActiveGroupId(owningGroup?.id ?? null);
    setSelectedNodeIds([node.id]);
    setSelectedEdgeIds([]);
    setActiveNodeId(node.id);
    closePromptMenus();
    setLayoutDropdownOpen(false);
    setColorPaletteOpen(false);
    setSelectionLayoutMenuOpen(false);
    setDragNode({ active: true, nodeId: node.id, offsetX: pointerWorld.x - node.x, offsetY: pointerWorld.y - node.y });
  }

function onCanvasMouseMove(event: React.MouseEvent<HTMLDivElement>) {
    const world = toWorld(event.clientX, event.clientY);
    const pendingHold = nodeConnectionHoldRef.current;
    if (
      pendingHold
      && Math.hypot(event.clientX - pendingHold.clientX, event.clientY - pendingHold.clientY) >= CONNECTION_DRAG_THRESHOLD
    ) {
      clearNodeConnectionHold();
    }
    if (middlePanning.active || groupDrag.active || selectionBox.active || textResize.active || dragNode.active || draftLine) {
      markCanvasInteraction();
    }
    const alignThresholdWorld = ALIGN_THRESHOLD_PX / Math.max(0.001, viewportVisualScale());

    if (middlePanning.active) {
      setViewport((prev) => ({
        ...prev,
        panX: middlePanning.px + (event.clientX - middlePanning.sx),
        panY: middlePanning.py + (event.clientY - middlePanning.sy),
      }));
      setAlignmentGuides(null);
      return;
    }

    const pendingGridSplitDrag = imageGridSplitDragRef.current;
    if (pendingGridSplitDrag && !pendingGridSplitDrag.createdNodeId) {
      const dxClient = event.clientX - pendingGridSplitDrag.startClientX;
      const dyClient = event.clientY - pendingGridSplitDrag.startClientY;
      if (Math.hypot(dxClient, dyClient) >= 8) {
        const sourceNode = nodeMap.get(pendingGridSplitDrag.sourceNodeId);
        if (sourceNode && sourceNode.type === "image") {
          const { row, col } = parseGridCellKey(pendingGridSplitDrag.cellKey);
          const stamp = Date.now();
          const detachedNode = createDetachedImageGridCellNode(
            sourceNode,
            row,
            col,
            pendingGridSplitDrag.rows,
            pendingGridSplitDrag.cols,
            world.x - 28,
            world.y - 28,
            stamp,
          );
          const nextEdge: EdgeData = {
            id: `edge_${stamp}_grid_drag`,
            fromNodeId: sourceNode.id,
            fromSide: "right",
            toNodeId: detachedNode.id,
            toSide: "left",
          };
          const nextNodes = [...nodes, detachedNode];
          const nextEdges = [...edges, nextEdge];
          setNodes(nextNodes);
          setEdges(nextEdges);
          setSelectedNodeIds([detachedNode.id]);
          setSelectedEdgeIds([nextEdge.id]);
          setActiveGroupId(null);
          setActiveNodeId(detachedNode.id);
          setDragNode({
            active: true,
            nodeId: detachedNode.id,
            offsetX: world.x - detachedNode.x,
            offsetY: world.y - detachedNode.y,
          });
          void persistCanvas(nextNodes, nextEdges);
          imageGridSplitDragRef.current = { ...pendingGridSplitDrag, createdNodeId: detachedNode.id };
          imageGridSplitSuppressClickRef.current = true;
          return;
        }
        imageGridSplitDragRef.current = null;
      }
    }

    if (groupDrag.active && groupDrag.groupId) {
      const dx = world.x - groupDrag.startX;
      const dy = world.y - groupDrag.startY;
      const group = groups.find((g) => g.id === groupDrag.groupId);
      if (!group || !groupDrag.startBounds) return;

      const movingRect: Rect = {
        left: groupDrag.startBounds.left + dx,
        top: groupDrag.startBounds.top + dy,
        right: groupDrag.startBounds.right + dx,
        bottom: groupDrag.startBounds.bottom + dy,
      };

      const groupBounds = collectGroupBounds(groups, nodes).filter((item) => item.groupId !== group.id).map((item) => item.rect);
      const otherNodeBounds = nodes.filter((node) => !group.nodeIds.includes(node.id)).map(rectFromNode);
      const guides = alignmentForRect(movingRect, [...groupBounds, ...otherNodeBounds], alignThresholdWorld);
      setAlignmentGuides(guides.vertical || guides.horizontal ? guides : null);
      const snapDx = gridSnapEnabled ? Math.round((movingRect.left + guides.snapDx) / 20) * 20 - movingRect.left : 0;
      const snapDy = gridSnapEnabled ? Math.round((movingRect.top + guides.snapDy) / 20) * 20 - movingRect.top : 0;

      setNodes((prev) =>
        prev.map((node) => {
          if (!group.nodeIds.includes(node.id)) return node;
          const origin = groupDrag.originalPositions[node.id];
          if (!origin) return node;
          return { ...node, x: origin.x + dx + snapDx, y: origin.y + dy + snapDy };
        }),
      );
      return;
    }

    if (selectionBox.active) {
      setSelectionBox((prev) => ({ ...prev, endX: world.x, endY: world.y }));
      setAlignmentGuides(null);
      return;
    }

    if (textResize.active && textResize.nodeId) {
      const nextWidth = Math.max(220, textResize.startWidth + (world.x - textResize.startX));
      const nextHeight = Math.max(140, textResize.startHeight + (world.y - textResize.startY));
      setNodes((prev) => prev.map((node) => (node.id === textResize.nodeId ? { ...node, width: nextWidth, height: nextHeight } : node)));
      return;
    }

    if (dragNode.active && dragNode.nodeId) {
      const draggingNode = nodeMap.get(dragNode.nodeId);
      if (!draggingNode) return;
      const x = world.x - dragNode.offsetX;
      const y = world.y - dragNode.offsetY;
      const movingRect: Rect = { left: x, top: y, right: x + draggingNode.width, bottom: y + draggingNode.height };

      const otherNodeBounds = nodes
        .filter((node) => node.id !== draggingNode.id && (!interactionPerformanceMode || visibleNodeIdSet.has(node.id)))
        .map(rectFromNode);
      const groupBounds = collectGroupBounds(groups, nodes).map((item) => item.rect);
      const guides = alignmentForRect(movingRect, [...otherNodeBounds, ...groupBounds], alignThresholdWorld);
      setAlignmentGuides(guides.vertical || guides.horizontal ? guides : null);
      const snapDx = gridSnapEnabled ? Math.round((movingRect.left + guides.snapDx) / 20) * 20 - movingRect.left : 0;
      const snapDy = gridSnapEnabled ? Math.round((movingRect.top + guides.snapDy) / 20) * 20 - movingRect.top : 0;

      setNodes((prev) =>
        prev.map((node) => (node.id === dragNode.nodeId ? { ...node, x: x + snapDx, y: y + snapDy } : node)),
      );
      return;
    }

    if (draftLine) {
      const hasMoved = draftLine.hasMoved || Math.hypot(event.clientX - draftLine.startClientX, event.clientY - draftLine.startClientY) >= CONNECTION_DRAG_THRESHOLD;
      if (!hasMoved) {
        setEdgeDropTarget(null);
        setAlignmentGuides(null);
        return;
      }
      const nextDropTarget = detectEdgeDropTarget(world.x, world.y, draftLine.fromNodeId);
      if (nextDropTarget) {
        const node = nodeMap.get(nextDropTarget.nodeId);
        const socket = node ? nodeSocket(node, nextDropTarget.side) : null;
        setDraftLine((prev) => (prev ? { ...prev, hasMoved: true, toX: socket?.x ?? world.x, toY: socket?.y ?? world.y } : null));
      } else {
        setDraftLine((prev) => (prev ? { ...prev, hasMoved: true, toX: world.x, toY: world.y } : null));
      }
      setEdgeDropTarget(nextDropTarget);
      setAlignmentGuides(null);
      return;
    }

    setAlignmentGuides(null);

    const hit = detectEdgeHover(world.x, world.y);
    if (hit) {
      setEdgeHoverState((prev) =>
        !prev || prev.edgeId !== hit.edgeId
          ? { edgeId: hit.edgeId, enteredAt: Date.now(), armed: false, nearestPoint: hit.point, distance: hit.distance }
          : { ...prev, nearestPoint: hit.point, distance: hit.distance },
      );
      return;
    }

    setEdgeHoverState(null);
  }

function onCanvasMouseDown(event: React.MouseEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    const world = toWorld(event.clientX, event.clientY);
    if (editingGroupTitleId && !target.closest("[data-group-title-editor]")) {
      const group = groups.find((item) => item.id === editingGroupTitleId);
      if (group) commitGroupTitle(group.id, group.title || "分组");
      else cancelGroupTitleEdit();
    }

    if (event.button === 1 || (event.button === 0 && spacePressedRef.current)) {
      markCanvasInteraction();
      setMiddlePanning({ active: true, sx: event.clientX, sy: event.clientY, px: viewport.panX, py: viewport.panY });
      return;
    }
    if (event.button !== 0) return;

    if (edgeHoverState?.armed && edgeHoverState.distance <= edgeHitToleranceInWorld()) {
      removeEdge(edgeHoverState.edgeId);
      return;
    }

    const groupDragHandle = target.closest("[data-group-drag-handle]");
    if (groupDragHandle && activeGroup && activeGroupBounds) {
      beginGroupDrag(activeGroup, world.x, world.y, activeGroupBounds);
      return;
    }

    if (
      target.closest("[data-fixed-ui]") ||
      target.closest("[data-menu-panel]") ||
      target.closest("[data-workflow-panel]") ||
      target.closest("[data-asset-panel]") ||
      target.closest("[data-history-panel]") ||
      target.closest("[data-shortcut-panel]")
    ) {
      return;
    }

    if (
      target.closest("[data-node-card]") ||
      target.closest("[data-text-resize-handle]") ||
      target.closest("[data-asset-manager]") ||
      target.closest("[data-top-shell]") ||
      target.closest("[data-bottom-shell]")
    ) {
      setLayoutDropdownOpen(false);
      setColorPaletteOpen(false);
      setTextColorMenuNodeId(null);
      setSelectionLayoutMenuOpen(false);
      setRatioOpen(false);
      setModelOpen(false);
      setQuantityOpen(false);
      setCameraOpen(false);
      setProjectMenuOpen(false);
      setCanvasSwitcherOpen(false);
      if (editingTextNodeId && !target.closest("[data-text-editor]")) commitTextNodeEditing();
      return;
    }

    if (editingTextNodeId) commitTextNodeEditing();
    if (!editingTextNodeId) resetSelectedExpandedTextNodes();
    setActiveNodeId(null);
    setSelectedNodeIds([]);
    setSelectedEdgeIds([]);
    setActiveGroupId(null);
    closePromptMenus();
    setTextColorMenuNodeId(null);
    setExpanded(false);
    setStatus("");
    closeBottomPanels();
    setLayoutDropdownOpen(false);
    setColorPaletteOpen(false);
    setTextColorMenuNodeId(null);
    setSelectionLayoutMenuOpen(false);
    setProjectMenuOpen(false);
    setCanvasSwitcherOpen(false);
    setProjectBrowserOpen(false);
    setStoryboardSlotMenuNodeId(null);
    setStoryboardSlotMenuPosition(null);
    event.preventDefault();
    window.getSelection()?.removeAllRanges();
    if (event.shiftKey || canvasPointerMode === "select") {
      setSelectionBox({ active: true, startX: world.x, startY: world.y, endX: world.x, endY: world.y });
      return;
    }
    markCanvasInteraction();
    setMiddlePanning({ active: true, sx: event.clientX, sy: event.clientY, px: viewport.panX, py: viewport.panY });
  }

function onCanvasMouseUp(event: React.MouseEvent<HTMLDivElement>) {
    clearNodeConnectionHold();
    if (middlePanning.active) setMiddlePanning((prev) => ({ ...prev, active: false }));
    if (dragNode.active) setDragNode({ active: false, nodeId: null, offsetX: 0, offsetY: 0 });
    if (groupDrag.active) setGroupDrag({ active: false, groupId: null, startX: 0, startY: 0, originalPositions: {}, startBounds: null });
    if (textResize.active) setTextResize({ active: false, nodeId: null, startX: 0, startY: 0, startWidth: 0, startHeight: 0 });
    if (imageGridSplitDragRef.current) {
      window.setTimeout(() => {
        imageGridSplitSuppressClickRef.current = false;
      }, 0);
      imageGridSplitDragRef.current = null;
    }

    if (selectionBox.active) {
      // The final mousemove may still be batched when the pointer is released.
      const end = toWorld(event.clientX, event.clientY);
      const rect: Rect = {
        left: Math.min(selectionBox.startX, end.x),
        top: Math.min(selectionBox.startY, end.y),
        right: Math.max(selectionBox.startX, end.x),
        bottom: Math.max(selectionBox.startY, end.y),
      };
      const nodeIds = nodes.filter((node) => rectSelectsNode(rect, rectFromNode(node))).map((node) => node.id);
      const edgeIds = edges.filter((edge) => edgeIntersectsRect(edge, rect)).map((edge) => edge.id);
      const matchedGroup = groups.find((group) => group.nodeIds.length === nodeIds.length && group.nodeIds.every((id) => nodeIds.includes(id))) ?? null;

      setSelectedNodeIds(nodeIds);
      setSelectedEdgeIds(edgeIds);
      setActiveNodeId(nodeIds.length === 1 ? nodeIds[0] : null);
      setActiveGroupId(matchedGroup?.id ?? null);
      setStatus(
        nodeIds.length === 0
          ? "框选结果：0 个节点"
          : `框选结果：${nodeIds.length} 个节点 - ${nodeIds
              .map((id) => nodes.find((node) => node.id === id)?.title || id)
              .join("、")}`,
      );
      setSelectionBox((prev) => ({ ...prev, active: false }));
      setAlignmentGuides(null);
      return;
    }

    if (!draftLine) {
      setAlignmentGuides(null);
      return;
    }

    const world = toWorld(event.clientX, event.clientY);
    const hasMoved = draftLine.hasMoved || Math.hypot(event.clientX - draftLine.startClientX, event.clientY - draftLine.startClientY) >= CONNECTION_DRAG_THRESHOLD;
    if (!hasMoved) {
      setDraftLine(null);
      setEdgeDropTarget(null);
      setAlignmentGuides(null);
      return;
    }

    const sourceNode = nodeMap.get(draftLine.fromNodeId);
    const dropTarget = detectEdgeDropTarget(world.x, world.y, draftLine.fromNodeId);
    const fromSide = sourceNode ? connectionSideToward(sourceNode, world.x) : draftLine.fromSide;
    if (dropTarget && dropTarget.nodeId !== draftLine.fromNodeId && !hasDuplicateEdge(draftLine.fromNodeId, fromSide, dropTarget.nodeId, dropTarget.side)) {
      const admission = admitCanvasReferenceEdge(draftLine.fromNodeId, dropTarget.nodeId);
      if (!admission.ok) {
        setStatus(admission.message);
      } else {
        setEdges((prev) => [
          ...prev,
          {
            id: `edge_${crypto.randomUUID()}`,
            fromNodeId: draftLine.fromNodeId,
            fromSide,
            toNodeId: dropTarget.nodeId,
            toSide: dropTarget.side,
          },
        ]);
      }
    } else {
      openCreationMenuAtWorld(world.x, world.y, "connection", { fromNodeId: draftLine.fromNodeId, fromSide });
    }
    setDraftLine(null);
    setEdgeDropTarget(null);
    setAlignmentGuides(null);
  }

function onCanvasDoubleClick(event: React.MouseEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (!isCanvasBackgroundTarget(target)) return;
    const world = toWorld(event.clientX, event.clientY);
    openCreationMenuAtWorld(world.x, world.y, "doubleClick");
  }

function flushWheelPanDelta() {
    const delta = wheelPanDeltaRef.current;
    if (!delta.x && !delta.y) return;
    wheelPanDeltaRef.current = { x: 0, y: 0 };
    setViewport((prev) => {
      const next = { ...prev, panX: prev.panX + delta.x, panY: prev.panY + delta.y };
      viewportRef.current = next;
      return next;
    });
  }

function scheduleWheelPan(deltaX: number, deltaY: number) {
    wheelPanDeltaRef.current = {
      x: wheelPanDeltaRef.current.x + deltaX,
      y: wheelPanDeltaRef.current.y + deltaY,
    };
    if (wheelPanFrameRef.current !== null) return;
    wheelPanFrameRef.current = window.requestAnimationFrame(() => {
      wheelPanFrameRef.current = null;
      flushWheelPanDelta();
    });
  }

function shouldIgnoreCanvasWheel(target: EventTarget | null) {
    return shouldIgnoreCanvasWheelExternal(target);
  }

function onCanvasWheel(event: React.WheelEvent<HTMLDivElement>) {
    if (shouldIgnoreCanvasWheel(event.target)) return;
    event.preventDefault();
    markCanvasInteraction();
    if (!event.ctrlKey && !event.metaKey) {
      scheduleWheelPan(-event.deltaX, -event.deltaY);
      return;
    }
    if (wheelPanFrameRef.current !== null) {
      window.cancelAnimationFrame(wheelPanFrameRef.current);
      wheelPanFrameRef.current = null;
    }
    flushWheelPanDelta();
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    const currentViewport = viewportRef.current;
    const mx = event.clientX - rect.left;
    const my = event.clientY - rect.top;
    const factor = event.deltaY < 0 ? 1.08 : 0.92;
    const currentVisualScale = viewportVisualScale(currentViewport);
    const nextScale = Math.min(2.2, Math.max(0.1, currentViewport.scale * factor));
    const nextVisualScale = nextScale * CANVAS_VISUAL_SCALE;
    const wx = (mx - currentViewport.panX) / currentVisualScale;
    const wy = (my - currentViewport.panY) / currentVisualScale;
    const nextViewport = { scale: nextScale, panX: mx - wx * nextVisualScale, panY: my - wy * nextVisualScale };
    viewportRef.current = nextViewport;
    setViewport(nextViewport);
  }
  return { clearNodeConnectionHold, beginNodeConnectionHold, beginNodeMove, onCanvasMouseMove, onCanvasMouseDown, onCanvasMouseUp, onCanvasDoubleClick, flushWheelPanDelta, scheduleWheelPan, shouldIgnoreCanvasWheel, onCanvasWheel };
}
