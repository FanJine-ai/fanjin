import { useState } from "react";
import type {
CanvasMetaState
} from "./canvasDataTypes";
interface Context {
  routeCanvasId: string | undefined;
}
export function useCanvasDocumentState({ routeCanvasId }: Context) {
  const [canvasMeta, setCanvasMeta] = useState<CanvasMetaState>({
    canvasId: routeCanvasId ?? null,
    projectId: null,
    revision: null,
    name: "未命名项目",
    loading: true,
    ready: false,
  });
  return { canvasMeta, setCanvasMeta };
}
