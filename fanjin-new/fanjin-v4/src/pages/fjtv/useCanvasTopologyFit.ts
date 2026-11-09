import { useMemo } from "react";
import { rectFromNode, unionRects } from "./canvasGeometry";
import { shouldSuppressCanvasTopologyFit } from "./canvasAdaptiveLayout";
export function useCanvasTopologyFit({
  canvasGraphStateModule,
  canvasRuntimeRefsModule,
  studioChrome,
  canvasMeta,
  canvasGraphActionBindings,
}: Pick<
  Parameters<typeof import("./useCanvasSurfaceView").useCanvasSurfaceView>[0],
  | "canvasGraphStateModule"
  | "canvasRuntimeRefsModule"
  | "studioChrome"
  | "canvasMeta"
  | "canvasGraphActionBindings"
>) {
  const canvasBounds = useMemo(
    () => unionRects(canvasGraphStateModule.nodes.map(rectFromNode)),
    [canvasGraphStateModule.nodes],
  );
  canvasRuntimeRefsModule.canvasBoundsRef.current = canvasBounds;
  canvasRuntimeRefsModule.studioTopologyFitRef.current = () => {
    if (
      !studioChrome ||
      !canvasMeta.ready ||
      canvasMeta.loading ||
      canvasGraphStateModule.nodes.length === 0
    )
      return;
    if (
      shouldSuppressCanvasTopologyFit(
        canvasRuntimeRefsModule.studioTopologyFitSuppressedUntilRef.current,
        Date.now(),
      )
    )
      return;
    canvasGraphActionBindings.fitViewportToBounds(
      canvasRuntimeRefsModule.canvasBoundsRef.current,
      1,
    );
  };

  return canvasBounds;
}
