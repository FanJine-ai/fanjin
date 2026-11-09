import { createCanvasChromeRenderBindings } from "./canvasChromeRenderBindings";
import { createCanvasDeferredContext } from "./canvasDeferredContext";
import { createCanvasGenerationActionBindings } from "./canvasGenerationActionBindings";
import { createCanvasGraphActionBindings } from "./canvasGraphActionBindings";
import { createCanvasProjectActionBindings } from "./canvasProjectActionBindings";
import { useCanvasGraphState } from "./useCanvasGraphState";
import { useCanvasGroupState } from "./useCanvasGroupState";
import { useCanvasHistoryPanelState } from "./useCanvasHistoryPanelState";
import { useCanvasLibraryView } from "./useCanvasLibraryView";
import { useCanvasPendingHistory } from "./useCanvasPendingHistory";
import { useCanvasProjectRenameState } from "./useCanvasProjectRenameState";
import { useCanvasProjectState } from "./useCanvasProjectState";
import { useCanvasPromptState } from "./useCanvasPromptState";
import { useCanvasRuntimeRefs } from "./useCanvasRuntimeRefs";
import { useCanvasSelectionState } from "./useCanvasSelectionState";
import { useCanvasViewportUiState } from "./useCanvasViewportUiState";
import { useCanvasVisibilityView } from "./useCanvasVisibilityView";
export function createCanvasChromeRenderComposition(
  readContext: () => {
    canvasGroupStateModule: ReturnType<typeof useCanvasGroupState>;
    canvasGraphActionBindings: ReturnType<
      typeof createCanvasGraphActionBindings
    >;
    canvasColorMode: import("@/ui/theme").ThemeMode;
    miniMapPreview: ReturnType<
      typeof import("./useCanvasSurfaceView").useCanvasSurfaceView
    >["miniMapPreview"];
    miniMapViewportRect: ReturnType<
      typeof import("./useCanvasSurfaceView").useCanvasSurfaceView
    >["miniMapViewportRect"];
    canvasProjectRenameStateModule: ReturnType<
      typeof useCanvasProjectRenameState
    >;
    studioChrome: boolean;
    canvasProjectActionBindings: ReturnType<
      typeof createCanvasProjectActionBindings
    >;
    canvasGenerationActionBindings: ReturnType<
      typeof createCanvasGenerationActionBindings
    >;
    canvasCapabilities: import("@/pages/fjtv/canvasCapabilities").CanvasRealCapabilities;
    canvasProjectStateModule: ReturnType<typeof useCanvasProjectState>;
    canvasLibraryViewModule: ReturnType<typeof useCanvasLibraryView>;
    canvasMeta: import("@/pages/fjtv/canvasDataTypes").CanvasMetaState;
    navigate: import("react-router-dom").NavigateFunction;
    canDelete: boolean;
    canvasRuntimeRefsModule: ReturnType<typeof useCanvasRuntimeRefs>;
    canvasViewportUiStateModule: ReturnType<typeof useCanvasViewportUiState>;
    canvasVisibilityViewModule: ReturnType<typeof useCanvasVisibilityView>;
    canvasGraphStateModule: ReturnType<typeof useCanvasGraphState>;
    canvasSelectionStateModule: ReturnType<typeof useCanvasSelectionState>;
    canvasPendingHistoryModule: ReturnType<typeof useCanvasPendingHistory>;
    canvasPromptStateModule: ReturnType<typeof useCanvasPromptState>;
    canvasHistoryPanelStateModule: ReturnType<
      typeof useCanvasHistoryPanelState
    >;
  },
) {
  return createCanvasChromeRenderBindings(
    createCanvasDeferredContext({
      canvasGroupStateModule: () => readContext().canvasGroupStateModule,
      getGroupExecutionPlan: () =>
        readContext().canvasGraphActionBindings.getGroupExecutionPlan,
      closeGroupExecutionDialog: () =>
        readContext().canvasGraphActionBindings.closeGroupExecutionDialog,
      startGroupExecution: () =>
        readContext().canvasGraphActionBindings.startGroupExecution,
      canvasColorMode: () => readContext().canvasColorMode,
      readMiniMapSurfaceBox: () =>
        readContext().canvasGraphActionBindings.readMiniMapSurfaceBox,
      updateViewportFromMiniMap: () =>
        readContext().canvasGraphActionBindings.updateViewportFromMiniMap,
      returnToCanvasContent: () =>
        readContext().canvasGraphActionBindings.returnToCanvasContent,
      miniMapPreview: () => readContext().miniMapPreview,
      miniMapViewportRect: () => readContext().miniMapViewportRect,
      canvasProjectRenameStateModule: () =>
        readContext().canvasProjectRenameStateModule,
      studioChrome: () => readContext().studioChrome,
      undoCanvas: () => readContext().canvasProjectActionBindings.undoCanvas,
      redoCanvas: () => readContext().canvasProjectActionBindings.redoCanvas,
      loadHistoryItems: () =>
        readContext().canvasProjectActionBindings.loadHistoryItems,
      beginNodeGenerationSession: () =>
        readContext().canvasGenerationActionBindings.beginNodeGenerationSession,
      pollTaskUntilDone: () =>
        readContext().canvasGenerationActionBindings.pollTaskUntilDone,
      canvasCapabilities: () => readContext().canvasCapabilities,
      openCanvasShareMenu: () =>
        readContext().canvasProjectActionBindings.openCanvasShareMenu,
      openGroupExecutionDialog: () =>
        readContext().canvasGraphActionBindings.openGroupExecutionDialog,
      canvasProjectStateModule: () => readContext().canvasProjectStateModule,
      canvasLibraryViewModule: () => readContext().canvasLibraryViewModule,
      commitHeaderProjectRename: () =>
        readContext().canvasProjectActionBindings.commitHeaderProjectRename,
      cancelHeaderProjectRename: () =>
        readContext().canvasProjectActionBindings.cancelHeaderProjectRename,
      startHeaderProjectRename: () =>
        readContext().canvasProjectActionBindings.startHeaderProjectRename,
      canvasMeta: () => readContext().canvasMeta,
      createNewCanvas: () =>
        readContext().canvasProjectActionBindings.createNewCanvas,
      navigateToCanvas: () =>
        readContext().canvasProjectActionBindings.navigateToCanvas,
      commitCanvasRename: () =>
        readContext().canvasProjectActionBindings.commitCanvasRename,
      handleCanvasRenameKeyDown: () =>
        readContext().canvasProjectActionBindings.handleCanvasRenameKeyDown,
      closeBottomPanels: () =>
        readContext().canvasGraphActionBindings.closeBottomPanels,
      navigate: () => readContext().navigate,
      openProjectBrowser: () =>
        readContext().canvasProjectActionBindings.openProjectBrowser,
      createNewProject: () =>
        readContext().canvasProjectActionBindings.createNewProject,
      canDelete: () => readContext().canDelete,
      requestDeleteProjectItem: () =>
        readContext().canvasProjectActionBindings.requestDeleteProjectItem,
      canvasRuntimeRefsModule: () => readContext().canvasRuntimeRefsModule,
      canvasViewportUiStateModule: () =>
        readContext().canvasViewportUiStateModule,
      canvasVisibilityViewModule: () =>
        readContext().canvasVisibilityViewModule,
      canvasGraphStateModule: () => readContext().canvasGraphStateModule,
      canvasSelectionStateModule: () =>
        readContext().canvasSelectionStateModule,
      canvasPendingHistoryModule: () =>
        readContext().canvasPendingHistoryModule,
      canvasPromptStateModule: () => readContext().canvasPromptStateModule,
      canvasHistoryPanelStateModule: () =>
        readContext().canvasHistoryPanelStateModule,
    }),
  );
}
