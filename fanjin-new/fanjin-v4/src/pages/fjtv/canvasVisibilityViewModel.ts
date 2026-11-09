import type { EdgeData, NodeData, ViewportState } from "./canvasDataTypes";
import { getCanvasUsableLayout } from "./canvasAdaptiveLayout";
import { rectFromNode, rectIntersects, type CanvasRect } from "./canvasGeometry";

export function buildVisibleCanvasNodeIds(input: {
  nodes: NodeData[];
  edges: EdgeData[];
  viewport: ViewportState;
  visualScale?: number;
  rootRect: { width: number; height: number } | null;
  assetManagerOpen: boolean;
  interactionPerformanceMode: boolean;
  selectedNodeIds: string[];
  activeNodeId: string | null;
  dragNodeId?: string | null;
  editingTextNodeId?: string | null;
  draftLineFromNodeId?: string | null;
  edgeDropTargetNodeId?: string | null;
  selectedEdgeIds: string[];
  edgeHoverId?: string | null;
  animatedEdgeIds: Set<string>;
}): Set<string> {
  const { nodes, edges, viewport, rootRect } = input;
  if (!rootRect) return new Set(nodes.map((node) => node.id));

  const usableLayout = getCanvasUsableLayout(rootRect.width, input.assetManagerOpen);
  const scale = Math.max(0.05, input.visualScale ?? viewport.scale);
  const margin = input.interactionPerformanceMode ? 320 : 960;
  const viewportRect: CanvasRect = {
    left: (usableLayout.left - viewport.panX - margin) / scale,
    top: (-viewport.panY - margin) / scale,
    right: (usableLayout.left + usableLayout.width - viewport.panX + margin) / scale,
    bottom: (-viewport.panY + rootRect.height + margin) / scale,
  };
  const alwaysKeep = new Set(input.selectedNodeIds);
  [input.activeNodeId, input.dragNodeId, input.editingTextNodeId, input.draftLineFromNodeId, input.edgeDropTargetNodeId]
    .forEach((id) => { if (id) alwaysKeep.add(id); });
  edges.forEach((edge) => {
    if (input.selectedEdgeIds.includes(edge.id) || input.edgeHoverId === edge.id || input.animatedEdgeIds.has(edge.id)) {
      alwaysKeep.add(edge.fromNodeId);
      alwaysKeep.add(edge.toNodeId);
    }
  });
  return new Set(nodes.filter((node) => alwaysKeep.has(node.id) || rectIntersects(rectFromNode(node), viewportRect)).map((node) => node.id));
}

export function filterVisibleCanvasEdges(
  edges: EdgeData[],
  visibleNodeIds: Set<string>,
  selectedEdgeIds: string[],
  edgeHoverId: string | null | undefined,
  animatedEdgeIds: Set<string>,
) {
  return edges.filter((edge) => (
    selectedEdgeIds.includes(edge.id)
    || edgeHoverId === edge.id
    || animatedEdgeIds.has(edge.id)
    || (visibleNodeIds.has(edge.fromNodeId) && visibleNodeIds.has(edge.toNodeId))
  ));
}
