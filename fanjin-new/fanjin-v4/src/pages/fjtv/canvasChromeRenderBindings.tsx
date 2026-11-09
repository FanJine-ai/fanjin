import { canDeleteProjects } from "@/utils/permissions";
import { useNavigate } from "react-router-dom";
import type { GroupData, HistoryAssetItem, NodeData } from "./canvasDataTypes";
import { renderGroupExecutionDialogExternal } from "./canvasGroupExecutionDialog";
import { CanvasMiniMapSurface } from "./CanvasMiniMapSurface";
import { trapCanvasModalFocus } from "./canvasModalFocus";
import { createCanvasProjectHeader } from "./canvasProjectHeader";
import { createCanvasStudioHeader } from "./canvasStudioHeader";
import { type MiniMapMetrics } from "./miniMapMetrics";
import { useCanvasGroupState } from "./useCanvasGroupState";
import { useCanvasLibraryView } from "./useCanvasLibraryView";
import { useCanvasProjectRenameState } from "./useCanvasProjectRenameState";
import { useCanvasProjectState } from "./useCanvasProjectState";
export function createCanvasChromeRenderBindings(context: {
  canvasGroupStateModule: ReturnType<typeof useCanvasGroupState>;
  getGroupExecutionPlan: (
    group: GroupData,
  ) => import("@/pages/fjtv/canvasGroupExecution").CanvasExecutionPlan<NodeData>;
  closeGroupExecutionDialog: (options?: {
    restoreFocus?: boolean | undefined;
  }) => void;
  startGroupExecution: () => Promise<void>;
  canvasColorMode: import("@/ui/theme").ThemeMode;
  readMiniMapSurfaceBox: () => {
    left: number;
    top: number;
    width: number;
    height: number;
  } | null;
  updateViewportFromMiniMap: (
    clientX: number,
    clientY: number,
    rect: { left: number; top: number; width: number; height: number },
  ) => void;
  returnToCanvasContent: () => void;
  miniMapPreview: MiniMapMetrics | null;
  miniMapViewportRect:
    import("@/pages/fjtv/miniMapMetrics").MiniMapRectLike | null;
  canvasProjectRenameStateModule: ReturnType<
    typeof useCanvasProjectRenameState
  >;
  studioChrome: boolean;
  undoCanvas: () => void;
  redoCanvas: () => void;
  loadHistoryItems: () => Promise<void>;
  beginNodeGenerationSession: (nodeId: string) => string;
  pollTaskUntilDone: (
    taskId: string,
    node: NodeData,
    sessionId: string,
    startedAt?: number,
    options?: { kind?: "generation" | "video_enhance"; queryFailures?: number },
  ) => Promise<boolean>;
  canvasCapabilities: import("@/pages/fjtv/canvasCapabilities").CanvasRealCapabilities;
  openCanvasShareMenu: () => void;
  openGroupExecutionDialog: (
    group: GroupData,
    opener?: HTMLButtonElement,
  ) => void;
  canvasProjectStateModule: ReturnType<typeof useCanvasProjectState>;
  canvasLibraryViewModule: ReturnType<typeof useCanvasLibraryView>;
  commitHeaderProjectRename: () => Promise<void>;
  cancelHeaderProjectRename: () => void;
  startHeaderProjectRename: () => Promise<void>;
  canvasMeta: import("@/pages/fjtv/canvasDataTypes").CanvasMetaState;
  createNewCanvas: () => Promise<void>;
  navigateToCanvas: (canvasId: string, projectId?: string | null) => void;
  commitCanvasRename: (canvasId: string, fallbackName: string) => Promise<void>;
  handleCanvasRenameKeyDown: (
    event: React.KeyboardEvent<HTMLInputElement>,
    canvasId: string,
    fallbackName: string,
  ) => void;
  closeBottomPanels: () => void;
  navigate: ReturnType<typeof useNavigate>;
  openProjectBrowser: (preserveCanvas?: boolean) => void;
  createNewProject: () => Promise<void>;
  canDelete: ReturnType<typeof canDeleteProjects>;
  requestDeleteProjectItem: (projectId: string) => void;
  canvasRuntimeRefsModule: ReturnType<
    typeof import("./useCanvasRuntimeRefs").useCanvasRuntimeRefs
  >;
  canvasViewportUiStateModule: ReturnType<
    typeof import("./useCanvasViewportUiState").useCanvasViewportUiState
  >;
  canvasVisibilityViewModule: ReturnType<
    typeof import("./useCanvasVisibilityView").useCanvasVisibilityView
  >;
  canvasGraphStateModule: ReturnType<
    typeof import("./useCanvasGraphState").useCanvasGraphState
  >;
  canvasSelectionStateModule: ReturnType<
    typeof import("./useCanvasSelectionState").useCanvasSelectionState
  >;
  canvasPendingHistoryModule: ReturnType<
    typeof import("./useCanvasPendingHistory").useCanvasPendingHistory
  >;
  canvasPromptStateModule: ReturnType<
    typeof import("./useCanvasPromptState").useCanvasPromptState
  >;
  canvasHistoryPanelStateModule: ReturnType<
    typeof import("./useCanvasHistoryPanelState").useCanvasHistoryPanelState
  >;
}) {
  function renderGroupExecutionDialog() {
    return renderGroupExecutionDialogExternal({
      ...context.canvasGroupStateModule,
      getGroupExecutionPlan: context.getGroupExecutionPlan,
      trapCanvasModalFocus,
      closeGroupExecutionDialog: context.closeGroupExecutionDialog,
      startGroupExecution: context.startGroupExecution,
    });
  }

  function renderMiniMapSurface(className: string) {
    return (
      <CanvasMiniMapSurface
        className={className}
        canvasColorMode={context.canvasColorMode}
        miniMapSurfaceRef={context.canvasRuntimeRefsModule.miniMapSurfaceRef}
        readMiniMapSurfaceBox={context.readMiniMapSurfaceBox}
        setMiniMapDragging={
          context.canvasViewportUiStateModule.setMiniMapDragging
        }
        updateViewportFromMiniMap={context.updateViewportFromMiniMap}
        miniMapDragging={context.canvasViewportUiStateModule.miniMapDragging}
        returnToCanvasContent={context.returnToCanvasContent}
        miniMapPreview={context.miniMapPreview}
        groupBoundsMap={context.canvasVisibilityViewModule.groupBoundsMap}
        groups={context.canvasGroupStateModule.groups}
        nodes={context.canvasGraphStateModule.nodes}
        selectedNodeIds={context.canvasSelectionStateModule.selectedNodeIds}
        miniMapViewportRect={context.miniMapViewportRect}
      />
    );
  }

  function renderStudioHeaderActions() {
    return createCanvasStudioHeader({
      ...context.canvasProjectRenameStateModule,
      studioChrome: context.studioChrome,
      canvasSavedAt: context.canvasSelectionStateModule.canvasSavedAt,
      canvasSaveState: context.canvasSelectionStateModule.canvasSaveState,
      undoCanvas: context.undoCanvas,
      redoCanvas: context.redoCanvas,
      loadHistoryItems: context.loadHistoryItems,
      historyItemsWithPending:
        context.canvasPendingHistoryModule.historyItemsWithPending,
      nodesRef: context.canvasGraphStateModule.nodesRef,
      beginNodeGenerationSession: context.beginNodeGenerationSession,
      pollTaskUntilDone: context.pollTaskUntilDone,
      setStatus: context.canvasPromptStateModule.setStatus,
      setHistoryPreviewItem:
        context.canvasHistoryPanelStateModule.setHistoryPreviewItem,
      pendingElapsedLabel:
        context.canvasPendingHistoryModule.pendingElapsedLabel,
      canvasCapabilities: context.canvasCapabilities,
      openCanvasShareMenu: context.openCanvasShareMenu,
      activeGroup: context.canvasLibraryViewModule.activeGroup,
      groupExecutionDialog: context.canvasGroupStateModule.groupExecutionDialog,
      groupExecutionRunning:
        context.canvasGroupStateModule.groupExecutionRunning,
      openGroupExecutionDialog: context.openGroupExecutionDialog,
    })();
  }

  function renderProjectHeaderCluster() {
    return createCanvasProjectHeader({
      ...context.canvasProjectStateModule,
      ...context.canvasProjectRenameStateModule,
      ...context.canvasLibraryViewModule,
      studioChrome: context.studioChrome,
      commitHeaderProjectRename: context.commitHeaderProjectRename,
      cancelHeaderProjectRename: context.cancelHeaderProjectRename,
      startHeaderProjectRename: context.startHeaderProjectRename,
      canvasMeta: context.canvasMeta,
      createNewCanvas: context.createNewCanvas,
      navigateToCanvas: context.navigateToCanvas,
      commitCanvasRename: context.commitCanvasRename,
      handleCanvasRenameKeyDown: context.handleCanvasRenameKeyDown,
      closeBottomPanels: context.closeBottomPanels,
      setHistoryPreviewItem:
        context.canvasHistoryPanelStateModule.setHistoryPreviewItem,
      navigate: context.navigate,
      openProjectBrowser: context.openProjectBrowser,
      createNewProject: context.createNewProject,
      canDelete: context.canDelete,
      requestDeleteProjectItem: context.requestDeleteProjectItem,
    })();
  }
  return {
    renderGroupExecutionDialog,
    renderMiniMapSurface,
    renderStudioHeaderActions,
    renderProjectHeaderCluster,
  };
}
