import { useMemo } from "react";
import { getNodeModelType } from "./canvasModelDefinitions";
export function useCanvasActiveNodeSelection({
  canvasSelectionStateModule,
  nodeMap,
  availableModels,
}: {
  canvasSelectionStateModule: Pick<
    ReturnType<
      typeof import("./useCanvasSelectionState").useCanvasSelectionState
    >,
    "activeNodeId"
  >;
  nodeMap: Map<string, import("./canvasDataTypes").NodeData>;
  availableModels: import("@/lib/api").AiModelOption[];
}) {
  const activeNode = useMemo(
    () =>
      canvasSelectionStateModule.activeNodeId
        ? (nodeMap.get(canvasSelectionStateModule.activeNodeId) ?? null)
        : null,
    [canvasSelectionStateModule.activeNodeId, nodeMap],
  );
  const activeNodeModelOption = useMemo(
    () =>
      activeNode
        ? availableModels.find(
            (model) =>
              model.id === activeNode.model &&
              model.type === getNodeModelType(activeNode.type),
          )
        : undefined,
    [activeNode, availableModels],
  );

  return { activeNode, activeNodeModelOption };
}
