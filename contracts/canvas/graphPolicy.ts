export type CanvasGraphNodeType = "image" | "video" | "text" | "audio" | "compose" | "script";

export const OPEN_CANVAS_NODE_CREATION_KEYS = ["text", "image", "video", "compose"] as const;

const openCanvasNodeCreationKeys = new Set<string>(OPEN_CANVAS_NODE_CREATION_KEYS);

const connectionTargets: Record<CanvasGraphNodeType, ReadonlySet<CanvasGraphNodeType>> = {
  text: new Set(["text", "image", "video", "script"]),
  image: new Set(["text", "image", "video", "script"]),
  video: new Set(["text", "video", "compose", "script"]),
  audio: new Set(["text", "video", "compose", "script"]),
  compose: new Set(["text", "video", "script"]),
  script: new Set(["text", "image", "video"]),
};

export function isCanvasNodeCreationOpen(key: string) {
  return openCanvasNodeCreationKeys.has(key);
}

export function isCanvasNodeConnectionAllowed(
  sourceType: CanvasGraphNodeType,
  targetType: CanvasGraphNodeType,
) {
  return connectionTargets[sourceType].has(targetType);
}

type GraphNode = { id: string };
type GraphEdge = { id: string; fromNodeId: string; toNodeId: string };
type GraphGroup = { nodeIds: string[] };

/**
 * Applies the same deletion policy used by the keyboard shortcut: selected
 * nodes, explicitly selected edges, every incident edge, and now-invalid
 * one-node groups are removed as one atomic graph mutation.
 */
export function removeCanvasGraphSelection<
  TNode extends GraphNode,
  TEdge extends GraphEdge,
  TGroup extends GraphGroup,
>(input: {
  nodes: readonly TNode[];
  edges: readonly TEdge[];
  groups: readonly TGroup[];
  selectedNodeIds: readonly string[];
  selectedEdgeIds: readonly string[];
}) {
  const removedNodeIds = new Set(input.selectedNodeIds);
  const removedEdgeIds = new Set(input.selectedEdgeIds);
  const nodes = input.nodes.filter((node) => !removedNodeIds.has(node.id));
  const edges = input.edges.filter(
    (edge) => !removedEdgeIds.has(edge.id)
      && !removedNodeIds.has(edge.fromNodeId)
      && !removedNodeIds.has(edge.toNodeId),
  );
  const groups = input.groups
    .map((group) => ({
      ...group,
      nodeIds: group.nodeIds.filter((nodeId) => !removedNodeIds.has(nodeId)),
    }))
    .filter((group) => group.nodeIds.length >= 2) as TGroup[];

  return { nodes, edges, groups };
}
