export type CanvasComposePortSide = "left" | "right";

export type CanvasComposeEdgeLike = {
  fromNodeId: string;
  fromSide: CanvasComposePortSide;
  toNodeId: string;
  toSide: CanvasComposePortSide;
};

export type CanvasComposeNodeLike = {
  id: string;
  type: string;
};

/**
 * Resolves video inputs by port meaning instead of drag direction.
 *
 * Canvas edges preserve the endpoint where the pointer drag started. A user can
 * therefore connect the compose node's left input to a video's right output and
 * produce an edge whose stored `fromNodeId` is the compose node. Treat that
 * shape as an input while keeping compose-right -> video-left result edges out
 * of the source timeline.
 */
export function resolveCanvasComposeInputNodeIds(
  composeNodeId: string,
  edges: readonly CanvasComposeEdgeLike[],
  nodes: readonly CanvasComposeNodeLike[],
): string[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const inputIds: string[] = [];
  const seen = new Set<string>();

  for (const edge of edges) {
    let candidateId = "";

    if (edge.toNodeId === composeNodeId) {
      // Preserve existing/legacy inbound edges even when they were saved before
      // ports were interpreted semantically.
      candidateId = edge.fromNodeId;
    } else if (
      edge.fromNodeId === composeNodeId
      && edge.fromSide === "left"
      && edge.toSide === "right"
    ) {
      // Pointer drag started at the compose input and ended at the video output.
      candidateId = edge.toNodeId;
    }

    const candidate = nodeById.get(candidateId);
    if (!candidate || candidate.type !== "video" || seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    inputIds.push(candidate.id);
  }

  return inputIds;
}
