import { useCanvasAssetPanelState } from "./useCanvasAssetPanelState";
import { useCanvasGraphState } from "./useCanvasGraphState";
import {
  useCanvasAssetPanelLayout,
  useCanvasSurfaceMeasurement,
} from "./useCanvasLayoutLifecycle";
import { useCanvasRuntimeRefs } from "./useCanvasRuntimeRefs";
export function useCanvasAssetPanelLayoutEffects({
  previousAssetManagerOpenRef,
  canvasAssetPanelStateModule,
  studioChrome,
  canvasRuntimeRefsModule,
  canvasGraphStateModule,
}: {
  previousAssetManagerOpenRef: React.RefObject<boolean>;
  canvasAssetPanelStateModule: ReturnType<typeof useCanvasAssetPanelState>;
  studioChrome: boolean;
  canvasRuntimeRefsModule: ReturnType<typeof useCanvasRuntimeRefs>;
  canvasGraphStateModule: ReturnType<typeof useCanvasGraphState>;
}) {
  useCanvasAssetPanelLayout(
    () => ({
      previousAssetManagerOpenRef,
      assetManagerOpen: canvasAssetPanelStateModule.assetManagerOpen,
      studioChrome,
      studioTopologyFitTimerRef:
        canvasRuntimeRefsModule.studioTopologyFitTimerRef,
      studioTopologyFitRef: canvasRuntimeRefsModule.studioTopologyFitRef,
      rootRef: canvasRuntimeRefsModule.rootRef,
      setViewport: canvasGraphStateModule.setViewport,
      viewportRef: canvasGraphStateModule.viewportRef,
    }),
    [canvasAssetPanelStateModule.assetManagerOpen, studioChrome],
  );
  useCanvasSurfaceMeasurement(
    () => ({
      rootRef: canvasRuntimeRefsModule.rootRef,
      setCanvasSurfaceWidth: canvasRuntimeRefsModule.setCanvasSurfaceWidth,
      setCanvasSurfaceHeight: canvasRuntimeRefsModule.setCanvasSurfaceHeight,
    }),
    [],
  );
}
