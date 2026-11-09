import { useMemo } from "react";
import type {
DraftLine,
EdgeData,
EdgeHoverState,
GroupData,
NodeData,
NodeDragState,
Side,
ViewportState
} from "./canvasDataTypes";
import { buildGroupBoundsMap,getGroupBounds } from "./canvasGroupViewModel";
import { GROUP_FRAME_PAD,SELECTION_FRAME_PAD } from "./canvasPageConstants";
import { buildUpstreamReferences } from "./canvasReferenceViewModel";
import { getSelectionBounds } from "./canvasSelectionViewModel";
import { findStoryboardGroupByNodeId as findStoryboardGroupByNodeIdExternal,getStoryboardFilledCount as getStoryboardFilledCountExternal,getStoryboardGroupSlots as getStoryboardGroupSlotsExternal } from "./canvasStoryboardUtils";
import { buildVisibleCanvasNodeIds,filterVisibleCanvasEdges } from "./canvasVisibilityViewModel";
interface Context {
  nodes: NodeData[];
  selectedNodeIds: string[];
  activeGroup: GroupData | null;
  activeNodeId: string | null;
  collectConnectedEdgeIds: (startNodeId: string) => Set<string>;
  edges: EdgeData[];
  rootRef: React.RefObject<HTMLDivElement | null>;
  viewport: ViewportState;
  viewportVisualScale: (nextViewport?: ViewportState) => number;
  assetManagerOpen: boolean;
  interactionPerformanceMode: boolean;
  dragNode: NodeDragState;
  editingTextNodeId: string | null;
  draftLine: DraftLine | null;
  edgeDropTarget: { nodeId: string; side: Side; } | null;
  selectedEdgeIds: string[];
  edgeHoverState: EdgeHoverState | null;
  canvasRenderTick: number;
  groups: GroupData[];
  nodeMap: Map<string, NodeData>;
}
export function useCanvasVisibilityView({ nodes, selectedNodeIds, activeGroup, activeNodeId, collectConnectedEdgeIds, edges, rootRef, viewport, viewportVisualScale, assetManagerOpen, interactionPerformanceMode, dragNode, editingTextNodeId, draftLine, edgeDropTarget, selectedEdgeIds, edgeHoverState, canvasRenderTick, groups, nodeMap }: Context) {
  const selectedBounds = useMemo(() => getSelectionBounds(nodes, selectedNodeIds, SELECTION_FRAME_PAD), [nodes, selectedNodeIds]);
  const selectedNodeIdSet = useMemo(() => new Set(selectedNodeIds), [selectedNodeIds]);
  const activeGroupNodeIds = useMemo(() => new Set(activeGroup?.nodeIds ?? []), [activeGroup]);
  const activeGroupFullySelected = useMemo(
    () => Boolean(activeGroup && activeGroup.nodeIds.length > 0 && activeGroup.nodeIds.every((nodeId) => selectedNodeIdSet.has(nodeId))),
    [activeGroup, selectedNodeIdSet],
  );
  const animatedEdgeIds = useMemo(() => {
    if (!activeNodeId) return new Set<string>();
    return collectConnectedEdgeIds(activeNodeId);
  }, [activeNodeId, edges]);
  const visibleNodeIdSet = useMemo(() => {
    const rect = rootRef.current?.getBoundingClientRect() ?? null;
    return buildVisibleCanvasNodeIds({
      nodes, edges, viewport, visualScale: viewportVisualScale(), rootRect: rect, assetManagerOpen, interactionPerformanceMode,
      selectedNodeIds, activeNodeId, dragNodeId: dragNode.nodeId,
      editingTextNodeId, draftLineFromNodeId: draftLine?.fromNodeId,
      edgeDropTargetNodeId: edgeDropTarget?.nodeId, selectedEdgeIds,
      edgeHoverId: edgeHoverState?.edgeId, animatedEdgeIds,
    });
  }, [
    nodes,
    selectedNodeIds,
    activeNodeId,
    dragNode.nodeId,
    editingTextNodeId,
    draftLine,
    edgeDropTarget,
    edges,
    selectedEdgeIds,
    edgeHoverState,
    animatedEdgeIds,
    viewport.panX,
    viewport.panY,
    viewport.scale,
    assetManagerOpen,
    interactionPerformanceMode,
    canvasRenderTick,
  ]);
  const visibleNodes = useMemo(() => nodes.filter((node) => visibleNodeIdSet.has(node.id)), [nodes, visibleNodeIdSet]);
  const visibleEdges = useMemo(
    () => filterVisibleCanvasEdges(edges, visibleNodeIdSet, selectedEdgeIds, edgeHoverState?.edgeId, animatedEdgeIds),
    [edges, visibleNodeIdSet, selectedEdgeIds, edgeHoverState, animatedEdgeIds],
  );

  const activeGroupBounds = useMemo(() => getGroupBounds(activeGroup, nodes, GROUP_FRAME_PAD), [activeGroup, nodes]);
  const groupBoundsMap = useMemo(() => buildGroupBoundsMap(groups, nodes, GROUP_FRAME_PAD), [groups, nodes]);
  const findStoryboardGroupByNodeId = (nodeId: string) => findStoryboardGroupByNodeIdExternal(groups, nodeId);
  const getStoryboardGroupSlots = (group: GroupData | null | undefined) => getStoryboardGroupSlotsExternal(group, nodeMap);
  const getStoryboardFilledCount = (group: GroupData | null | undefined) => getStoryboardFilledCountExternal(group, nodeMap);

  const upstreamReferences = useMemo(() => buildUpstreamReferences(activeNodeId, edges, nodeMap), [activeNodeId, edges, nodeMap]);
  const upstreamReferenceLabelMap = useMemo(() => new Map(upstreamReferences.map((item) => [item.label, item])), [upstreamReferences]);

  return {
    selectedBounds, selectedNodeIdSet, activeGroupFullySelected,
    animatedEdgeIds, visibleNodeIdSet, visibleNodes,
    visibleEdges, activeGroupBounds, groupBoundsMap,
    findStoryboardGroupByNodeId, getStoryboardGroupSlots, getStoryboardFilledCount,
    upstreamReferences, upstreamReferenceLabelMap,
  };
}
