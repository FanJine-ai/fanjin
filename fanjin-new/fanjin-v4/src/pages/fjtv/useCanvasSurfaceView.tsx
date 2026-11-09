import { useMemo } from "react";
import {
  CANVAS_ASSET_MANAGER_WIDTH,
  getCanvasUsableLayout,
} from "./canvasAdaptiveLayout";
import { clampCanvasCreationMenuPosition } from "./canvasCreationMenuLayout";
import { getCanvasCreationMenuScreenPosition } from "./canvasCreationMenuPosition";
import type { createCanvasGraphActionBindings } from "./canvasGraphActionBindings";
import {
  buildCanvasDotBackgroundStyle,
  buildCanvasFrameDashStyle,
} from "./canvasSurfaceStyles";
import {
  buildCanvasScaleMetrics,
  buildCanvasSelectionMetrics,
} from "./canvasViewModel";
import type { useCanvasAssetPanelState } from "./useCanvasAssetPanelState";
import type { useCanvasConnectionState } from "./useCanvasConnectionState";
import type { useCanvasGraphState } from "./useCanvasGraphState";
import type { useCanvasRuntimeRefs } from "./useCanvasRuntimeRefs";
import type { useCanvasSelectionState } from "./useCanvasSelectionState";
import type { useCanvasViewportUiState } from "./useCanvasViewportUiState";
import type { useCanvasVisibilityView } from "./useCanvasVisibilityView";
export function useCanvasSurfaceView({
  canvasConnectionStateModule,
  canvasRuntimeRefsModule,
  canvasAssetPanelStateModule,
  canvasGraphActionBindings,
  canvasGraphStateModule,
  canvasSelectionStateModule,
  canvasVisibilityViewModule,
  studioChrome,
  canvasViewportUiStateModule,
  canvasMeta,
  canvasColorMode,
}: {
  canvasConnectionStateModule: ReturnType<typeof useCanvasConnectionState>;
  canvasRuntimeRefsModule: ReturnType<typeof useCanvasRuntimeRefs>;
  canvasAssetPanelStateModule: ReturnType<typeof useCanvasAssetPanelState>;
  canvasGraphActionBindings: ReturnType<typeof createCanvasGraphActionBindings>;
  canvasGraphStateModule: ReturnType<typeof useCanvasGraphState>;
  canvasSelectionStateModule: ReturnType<typeof useCanvasSelectionState>;
  canvasVisibilityViewModule: ReturnType<typeof useCanvasVisibilityView>;
  studioChrome: boolean;
  canvasViewportUiStateModule: ReturnType<typeof useCanvasViewportUiState>;
  canvasMeta: import("@/pages/fjtv/canvasDataTypes").CanvasMetaState;
  canvasColorMode: import("@/ui/theme").ThemeMode;
}) {
  const creationMenuScreen = useMemo(
    () =>
      getCanvasCreationMenuScreenPosition({
        menu: canvasConnectionStateModule.creationMenu,
        rootRect:
          canvasRuntimeRefsModule.rootRef.current?.getBoundingClientRect() ??
          null,
        assetManagerOpen: canvasAssetPanelStateModule.assetManagerOpen,
        getSidebarPosition: getCanvasUsableLayout,
        toScreen: canvasGraphActionBindings.toScreen,
        clamp: clampCanvasCreationMenuPosition,
      }),
    [
      canvasAssetPanelStateModule.assetManagerOpen,
      canvasConnectionStateModule.creationMenu,
      canvasGraphStateModule.viewport.panX,
      canvasGraphStateModule.viewport.panY,
      canvasGraphStateModule.viewport.scale,
    ],
  );

  const singleSelectedNodeId =
    canvasSelectionStateModule.selectedNodeIds.length === 1
      ? canvasSelectionStateModule.selectedNodeIds[0]
      : null;
  const { selectionToolbarCenterX, groupToolbarCenterX } =
    buildCanvasSelectionMetrics(
      canvasVisibilityViewModule.selectedBounds,
      canvasVisibilityViewModule.activeGroupBounds,
    );
  const canvasScaleMetrics = buildCanvasScaleMetrics(
    canvasGraphActionBindings.viewportVisualScale(),
  );
  const canvasFrameScale = canvasScaleMetrics.frameScale;
  const canvasFrameStrokeWidth = canvasScaleMetrics.frameStrokeWidth;
  const canvasFrameDash = canvasScaleMetrics.frameDash;
  const canvasFrameGap = canvasScaleMetrics.frameGap;
  const canvasDotSpacing = canvasScaleMetrics.dotSpacing;
  const canvasDotRadius = canvasScaleMetrics.dotRadius;
  const studioMiniMapVisible =
    studioChrome &&
    canvasAssetPanelStateModule.assetManagerOpen &&
    canvasAssetPanelStateModule.assetManagerTab === "canvas";
  const miniMapSurfaceWidth =
    canvasViewportUiStateModule.miniMapSurfaceSize?.width ??
    (studioMiniMapVisible ? CANVAS_ASSET_MANAGER_WIDTH - 28 : 208);
  const miniMapSurfaceHeight =
    canvasViewportUiStateModule.miniMapSurfaceSize?.height ??
    (studioMiniMapVisible ? 118 : 142);
  const miniMapPreview =
    canvasViewportUiStateModule.miniMapOpen || studioMiniMapVisible
      ? canvasGraphActionBindings.buildMiniMapMetrics(
          miniMapSurfaceWidth,
          miniMapSurfaceHeight,
        )
      : null;
  const miniMapViewportRect = miniMapPreview?.viewportRect
    ? miniMapPreview.toMiniRect(miniMapPreview.viewportRect)
    : null;
  const viewportMissingContent =
    canvasMeta.ready &&
    !canvasMeta.loading &&
    canvasGraphStateModule.nodes.length > 0 &&
    !canvasGraphActionBindings.doesViewportContainNode();

  const canvasFrameDashStyle = buildCanvasFrameDashStyle(
    canvasFrameStrokeWidth,
    canvasFrameDash,
    canvasFrameGap,
  );
  const canvasDotBackgroundStyle = buildCanvasDotBackgroundStyle(
    canvasColorMode,
    canvasGraphStateModule.viewport.panX,
    canvasGraphStateModule.viewport.panY,
    canvasDotSpacing,
    canvasDotRadius,
  );
  return {
    creationMenuScreen,
    singleSelectedNodeId,
    selectionToolbarCenterX,
    groupToolbarCenterX,
    canvasScaleMetrics,
    canvasFrameScale,
    canvasFrameStrokeWidth,
    canvasFrameDash,
    canvasFrameGap,
    canvasDotSpacing,
    canvasDotRadius,
    studioMiniMapVisible,
    miniMapSurfaceWidth,
    miniMapSurfaceHeight,
    miniMapPreview,
    miniMapViewportRect,
    viewportMissingContent,
    canvasFrameDashStyle,
    canvasDotBackgroundStyle,
  };
}
