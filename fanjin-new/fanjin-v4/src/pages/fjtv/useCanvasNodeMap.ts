import { useMemo } from "react";
export function useCanvasNodeMap(
  canvasGraphStateModule: Pick<
    ReturnType<typeof import("./useCanvasGraphState").useCanvasGraphState>,
    "nodes"
  >,
) {
  const nodeMap = useMemo(
    () => new Map(canvasGraphStateModule.nodes.map((node) => [node.id, node])),
    [canvasGraphStateModule.nodes],
  );

  return nodeMap;
}
