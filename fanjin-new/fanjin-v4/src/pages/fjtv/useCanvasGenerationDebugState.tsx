import { useCallback,useState } from "react";
import {
redactCanvasGenerationDebugSnapshot,
type CanvasGenerationDebugSnapshot
} from "./canvasGenerationDebug";
import { useCanvasDebugVisibility } from "./useCanvasGenerationLifecycle";
interface Context {
  canvasGenerationDebugVisible: boolean;
}
export function useCanvasGenerationDebugState({ canvasGenerationDebugVisible }: Context) {
  const [generateDebug, setGenerateDebugState] = useState<CanvasGenerationDebugSnapshot | null>(null);
  const setGenerateDebug = useCallback((snapshot: CanvasGenerationDebugSnapshot | null) => {
    if (!canvasGenerationDebugVisible) return;
    setGenerateDebugState(
      snapshot
        ? redactCanvasGenerationDebugSnapshot(snapshot)
        : null,
    );
  }, [canvasGenerationDebugVisible]);
  useCanvasDebugVisibility(() => ({ canvasGenerationDebugVisible, setGenerateDebugState }), [canvasGenerationDebugVisible]);
  return { generateDebug, setGenerateDebugState, setGenerateDebug };
}
