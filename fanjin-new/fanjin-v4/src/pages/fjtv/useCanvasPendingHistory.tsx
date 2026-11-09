import { useMemo,useRef,useState } from "react";
import type {
HistoryAssetItem,
NodeData
} from "./canvasDataTypes";
import { pendingElapsedLabel as getPendingElapsedLabel,resolvePendingGenerationProgress as getPendingGenerationProgress } from "./canvasGenerationProgress";
import { buildPendingHistoryItems } from "./canvasViewModel";
import { useCanvasPendingProgress } from "./useCanvasGenerationLifecycle";
interface Context {
  nodes: NodeData[];
  historyItems: HistoryAssetItem[];
}
export function useCanvasPendingHistory({ nodes, historyItems }: Context) {
  const pendingProgressStartedRef = useRef<Record<string, number>>({});
  const [pendingProgressTick, setPendingProgressTick] = useState(0);

  const resolvePendingGenerationProgress = (node: NodeData) => getPendingGenerationProgress(node, pendingProgressStartedRef.current);
  const pendingElapsedLabel = (nodeId: string) => getPendingElapsedLabel(nodeId, pendingProgressStartedRef.current);

  // Live tick so pending history % advances without waiting for a node patch.
  // Depend only on the boolean flip — restarting the interval every time
  // `nodes` changes (progress simulation patches every ~800ms) would starve
  // the 1s timer and make the elapsed label jump with irregular renders.
  const hasPendingGeneration = useMemo(() => nodes.some((node) =>
    node.isGenerating
    || node.generationState === "submitting"
    || node.generationState === "processing"
    || node.taskStatus === "processing",
  ), [nodes]);
  useCanvasPendingProgress(() => ({ hasPendingGeneration, setPendingProgressTick }), [hasPendingGeneration]);

  /** In-flight generations shown at the top of 生成历史 with live progress. */
  const pendingHistoryItems = useMemo<HistoryAssetItem[]>(() => {
    void pendingProgressTick;
    return buildPendingHistoryItems(nodes, pendingProgressStartedRef.current);
  }, [nodes, pendingProgressTick]);

  const historyItemsWithPending = useMemo(
    () => [...pendingHistoryItems, ...historyItems],
    [pendingHistoryItems, historyItems],
  );

  return {
    pendingElapsedLabel, pendingHistoryItems, historyItemsWithPending,
  };
}
