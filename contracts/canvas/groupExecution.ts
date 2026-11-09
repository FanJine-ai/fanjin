export type CanvasExecutionNode = {
  id: string;
  x: number;
  y: number;
};

export type CanvasExecutionEdge = {
  fromNodeId: string;
  toNodeId: string;
};

export type CanvasExecutionPlan<TNode extends CanvasExecutionNode> = {
  orderedNodes: TNode[];
  cycleNodeIds: string[];
};

export function planCanvasGroupExecution<TNode extends CanvasExecutionNode>(
  nodes: TNode[],
  edges: CanvasExecutionEdge[],
): CanvasExecutionPlan<TNode> {
  const byPosition = (a: TNode, b: TNode) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id);
  const ids = new Set(nodes.map((node) => node.id));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(nodes.map((node) => [node.id, [] as string[]]));

  for (const edge of edges) {
    if (!ids.has(edge.fromNodeId) || !ids.has(edge.toNodeId)) continue;
    outgoing.get(edge.fromNodeId)?.push(edge.toNodeId);
    indegree.set(edge.toNodeId, (indegree.get(edge.toNodeId) ?? 0) + 1);
  }

  const queue = nodes.filter((node) => (indegree.get(node.id) ?? 0) === 0).sort(byPosition);
  const orderedNodes: TNode[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    orderedNodes.push(node);
    for (const nextId of outgoing.get(node.id) ?? []) {
      const nextDegree = (indegree.get(nextId) ?? 0) - 1;
      indegree.set(nextId, nextDegree);
      if (nextDegree !== 0) continue;
      const nextNode = byId.get(nextId);
      if (!nextNode) continue;
      queue.push(nextNode);
      queue.sort(byPosition);
    }
  }

  const orderedIds = new Set(orderedNodes.map((node) => node.id));
  return {
    orderedNodes,
    cycleNodeIds: nodes
      .filter((node) => !orderedIds.has(node.id))
      .sort(byPosition)
      .map((node) => node.id),
  };
}
