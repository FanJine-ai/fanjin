import { createCanvasGenerationActionBindings } from "./canvasGenerationActionBindings";
import { createCanvasGraphActionBindings } from "./canvasGraphActionBindings";
import {
  CANVAS_SHORTCUTS,
  matchesCanvasShortcut,
} from "./canvasKeyboardDefinitions";
import { EDGE_ARM_DELAY_MS } from "./canvasPageConstants";
import { createCanvasProjectActionBindings } from "./canvasProjectActionBindings";
import { useCanvasConnectionState } from "./useCanvasConnectionState";
import { useCanvasGraphState } from "./useCanvasGraphState";
import { useCanvasGroupState } from "./useCanvasGroupState";
import { useCanvasProjectRenameState } from "./useCanvasProjectRenameState";
import { useCanvasProjectState } from "./useCanvasProjectState";
import { useCanvasPromptState } from "./useCanvasPromptState";
import { useCanvasRuntimeRefs } from "./useCanvasRuntimeRefs";
import { useCanvasSelectionState } from "./useCanvasSelectionState";
import { useCanvasTemplateState } from "./useCanvasTemplateState";
import {
  useCanvasEdgeArming,
  useCanvasInitialFit,
  useCanvasKeyboardShortcuts,
  useCanvasMiniMapDrag,
  useCanvasMiniMapMeasure,
  useCanvasMouseRelease,
  useCanvasStudioResize,
} from "./useCanvasViewportLifecycle";
import { useCanvasViewportUiState } from "./useCanvasViewportUiState";
import { useCanvasVisibilityView } from "./useCanvasVisibilityView";
export function useCanvasViewportInteractionEffects({
  canvasRuntimeRefsModule,
  canvasMeta,
  studioChrome,
  canvasSelectionStateModule,
  canvasProjectActionBindings,
  canvasProjectStateModule,
  canvasConnectionStateModule,
  canvasGraphStateModule,
  canvasGroupStateModule,
  canvasTemplateStateModule,
  canvasPromptStateModule,
  canvasViewportUiStateModule,
  canvasGraphActionBindings,
  studioMiniMapVisible,
  canvasBounds,
  isEditableKeyboardTarget,
  canvasProjectRenameStateModule,
  canvasGenerationActionBindings,
  canvasVisibilityViewModule,
  nodeMap,
}: {
  canvasRuntimeRefsModule: ReturnType<typeof useCanvasRuntimeRefs>;
  canvasMeta: import("@/pages/fjtv/canvasDataTypes").CanvasMetaState;
  studioChrome: boolean;
  canvasSelectionStateModule: ReturnType<typeof useCanvasSelectionState>;
  canvasProjectActionBindings: ReturnType<
    typeof createCanvasProjectActionBindings
  >;
  canvasProjectStateModule: ReturnType<typeof useCanvasProjectState>;
  canvasConnectionStateModule: ReturnType<typeof useCanvasConnectionState>;
  canvasGraphStateModule: ReturnType<typeof useCanvasGraphState>;
  canvasGroupStateModule: ReturnType<typeof useCanvasGroupState>;
  canvasTemplateStateModule: ReturnType<typeof useCanvasTemplateState>;
  canvasPromptStateModule: ReturnType<typeof useCanvasPromptState>;
  canvasViewportUiStateModule: ReturnType<typeof useCanvasViewportUiState>;
  canvasGraphActionBindings: ReturnType<typeof createCanvasGraphActionBindings>;
  studioMiniMapVisible: boolean;
  canvasBounds: import("@/pages/fjtv/canvasGeometry").CanvasRect | null;
  isEditableKeyboardTarget: (target: EventTarget | null) => boolean;
  canvasProjectRenameStateModule: ReturnType<
    typeof useCanvasProjectRenameState
  >;
  canvasGenerationActionBindings: ReturnType<
    typeof createCanvasGenerationActionBindings
  >;
  canvasVisibilityViewModule: ReturnType<typeof useCanvasVisibilityView>;
  nodeMap: Map<string, import("@/pages/fjtv/canvasDataTypes").NodeData>;
}) {
  useCanvasMouseRelease(
    () => ({
      setMiddlePanning: canvasSelectionStateModule.setMiddlePanning,
      setDragNode: canvasSelectionStateModule.setDragNode,
      setGroupDrag: canvasSelectionStateModule.setGroupDrag,
      setTextResize: canvasSelectionStateModule.setTextResize,
      setMiniMapDragging: canvasViewportUiStateModule.setMiniMapDragging,
      setAlignmentGuides: canvasConnectionStateModule.setAlignmentGuides,
    }),
    [],
  );
  useCanvasEdgeArming(
    () => ({
      edgeHoverState: canvasConnectionStateModule.edgeHoverState,
      EDGE_ARM_DELAY_MS,
      setEdgeHoverState: canvasConnectionStateModule.setEdgeHoverState,
    }),
    [canvasConnectionStateModule.edgeHoverState],
  );
  useCanvasMiniMapDrag(
    () => ({
      miniMapDragging: canvasViewportUiStateModule.miniMapDragging,
      readMiniMapSurfaceBox: canvasGraphActionBindings.readMiniMapSurfaceBox,
      updateViewportFromMiniMap:
        canvasGraphActionBindings.updateViewportFromMiniMap,
      setMiniMapDragging: canvasViewportUiStateModule.setMiniMapDragging,
    }),
    [
      canvasViewportUiStateModule.miniMapDragging,
      canvasGraphStateModule.nodes,
      canvasGroupStateModule.groups,
      canvasGraphStateModule.viewport.scale,
      canvasGraphStateModule.viewport.panX,
      canvasGraphStateModule.viewport.panY,
    ],
  );
  useCanvasMiniMapMeasure(
    () => ({
      miniMapOpen: canvasViewportUiStateModule.miniMapOpen,
      studioMiniMapVisible,
      setMiniMapSurfaceSize: canvasViewportUiStateModule.setMiniMapSurfaceSize,
      miniMapSurfaceRef: canvasRuntimeRefsModule.miniMapSurfaceRef,
    }),
    [canvasViewportUiStateModule.miniMapOpen, studioMiniMapVisible],
  );
  useCanvasInitialFit(
    () => ({
      canvasMeta,
      nodes: canvasGraphStateModule.nodes,
      canvasBounds,
      contentAutoFitCanvasKeyRef:
        canvasRuntimeRefsModule.contentAutoFitCanvasKeyRef,
      studioChrome,
      doesViewportContainNode:
        canvasGraphActionBindings.doesViewportContainNode,
      returnToCanvasContent: canvasGraphActionBindings.returnToCanvasContent,
    }),
    [
      canvasMeta.canvasId,
      canvasMeta.ready,
      canvasMeta.loading,
      canvasGraphStateModule.nodes.length,
      canvasBounds,
      studioChrome,
    ],
  );
  useCanvasStudioResize(
    () => ({
      studioChrome,
      rootRef: canvasRuntimeRefsModule.rootRef,
      studioTopologyFitTimerRef:
        canvasRuntimeRefsModule.studioTopologyFitTimerRef,
      studioTopologyFitRef: canvasRuntimeRefsModule.studioTopologyFitRef,
    }),
    [studioChrome, canvasMeta.canvasId],
  );
  useCanvasKeyboardShortcuts(
    () => ({
      isEditableKeyboardTarget,
      modelOpen: canvasPromptStateModule.modelOpen,
      videoSettingsOpen: canvasPromptStateModule.videoSettingsOpen,
      canvasShareOverlay: canvasProjectRenameStateModule.canvasShareOverlay,
      groupExecutionDialog: canvasGroupStateModule.groupExecutionDialog,
      cancelGenerationConfirmNodeId:
        canvasProjectStateModule.cancelGenerationConfirmNodeId,
      projectDeleteConfirmId: canvasProjectStateModule.projectDeleteConfirmId,
      cancelGenerationPending: canvasProjectStateModule.cancelGenerationPending,
      projectDeletePending: canvasProjectStateModule.projectDeletePending,
      closeBottomPanels: canvasGraphActionBindings.closeBottomPanels,
      setAssetCreateModalOpen:
        canvasTemplateStateModule.setAssetCreateModalOpen,
      setLayoutDropdownOpen: canvasGroupStateModule.setLayoutDropdownOpen,
      setColorPaletteOpen: canvasGroupStateModule.setColorPaletteOpen,
      setSelectionLayoutMenuOpen:
        canvasGroupStateModule.setSelectionLayoutMenuOpen,
      setProjectMenuOpen: canvasProjectStateModule.setProjectMenuOpen,
      setCanvasSwitcherOpen: canvasProjectStateModule.setCanvasSwitcherOpen,
      closeCanvasShareOverlay:
        canvasProjectActionBindings.closeCanvasShareOverlay,
      closeGroupExecutionDialog:
        canvasGraphActionBindings.closeGroupExecutionDialog,
      closeCancelGenerationDialog:
        canvasGenerationActionBindings.closeCancelGenerationDialog,
      closeProjectDeleteDialog:
        canvasProjectActionBindings.closeProjectDeleteDialog,
      projectBrowserOpen: canvasProjectStateModule.projectBrowserOpen,
      closeProjectBrowser: canvasProjectActionBindings.closeProjectBrowser,
      setActiveNodeId: canvasSelectionStateModule.setActiveNodeId,
      setSelectedNodeIds: canvasSelectionStateModule.setSelectedNodeIds,
      setSelectedEdgeIds: canvasSelectionStateModule.setSelectedEdgeIds,
      modelMenuOpenerRef: canvasPromptStateModule.modelMenuOpenerRef,
      videoSettingsOpenerRef: canvasPromptStateModule.videoSettingsOpenerRef,
      videoSettingsTriggerRef: canvasPromptStateModule.videoSettingsTriggerRef,
      shortcutPanelOpen: canvasProjectRenameStateModule.shortcutPanelOpen,
      spacePressedRef: canvasRuntimeRefsModule.spacePressedRef,
      matchesCanvasShortcut,
      CANVAS_SHORTCUTS,
      selectedNodeIds: canvasSelectionStateModule.selectedNodeIds,
      selectedEdgeIds: canvasSelectionStateModule.selectedEdgeIds,
      locallyDeletedNodeIdsRef:
        canvasRuntimeRefsModule.locallyDeletedNodeIdsRef,
      nodes: canvasGraphStateModule.nodes,
      edges: canvasGraphStateModule.edges,
      groups: canvasGroupStateModule.groups,
      recordCanvasHistoryMutation:
        canvasProjectActionBindings.recordCanvasHistoryMutation,
      buildHistorySnapshot: canvasProjectActionBindings.buildHistorySnapshot,
      viewport: canvasGraphStateModule.viewport,
      setNodes: canvasGraphStateModule.setNodes,
      setEdges: canvasGraphStateModule.setEdges,
      setGroups: canvasGroupStateModule.setGroups,
      activeNodeId: canvasSelectionStateModule.activeNodeId,
      persistCanvas: canvasProjectActionBindings.persistCanvas,
      canvasMeta,
      setStatus: canvasPromptStateModule.setStatus,
      undoCanvas: canvasProjectActionBindings.undoCanvas,
      redoCanvas: canvasProjectActionBindings.redoCanvas,
      ungroupActive: canvasGraphActionBindings.ungroupActive,
      createGroupFromSelection:
        canvasGraphActionBindings.createGroupFromSelection,
      mergeStoryboardGroupsShortcut:
        canvasGraphActionBindings.mergeStoryboardGroupsShortcut,
      duplicateSelectedNodes: canvasGraphActionBindings.duplicateSelectedNodes,
      connectSelectedNodesShortcut:
        canvasGraphActionBindings.connectSelectedNodesShortcut,
      generateWithActiveNode:
        canvasGenerationActionBindings.generateWithActiveNode,
      openShortcutCreateMenu: canvasGraphActionBindings.openShortcutCreateMenu,
      zoomCanvasBy: canvasGraphActionBindings.zoomCanvasBy,
      returnToCanvasContent: canvasGraphActionBindings.returnToCanvasContent,
      arrangeCanvasLeftPreview:
        canvasGraphActionBindings.arrangeCanvasLeftPreview,
    }),
    [
      canvasGroupStateModule.activeGroupId,
      canvasSelectionStateModule.activeNodeId,
      canvasBounds,
      canvasProjectRenameStateModule.canvasShareOverlay,
      canvasProjectStateModule.cancelGenerationConfirmNodeId,
      canvasProjectStateModule.cancelGenerationPending,
      canvasMeta.canvasId,
      canvasMeta.name,
      canvasGraphStateModule.edges,
      canvasVisibilityViewModule.groupBoundsMap,
      canvasGroupStateModule.groupExecutionDialog,
      canvasGroupStateModule.groups,
      nodeMap,
      canvasGraphStateModule.nodes,
      canvasProjectStateModule.projectBrowserOpen,
      canvasProjectStateModule.projectDeleteConfirmId,
      canvasProjectStateModule.projectDeletePending,
      canvasPromptStateModule.modelOpen,
      canvasSelectionStateModule.selectedEdgeIds,
      canvasSelectionStateModule.selectedNodeIds,
      canvasProjectRenameStateModule.shortcutPanelOpen,
      canvasPromptStateModule.videoSettingsOpen,
      canvasGraphStateModule.viewport.panX,
      canvasGraphStateModule.viewport.panY,
      canvasGraphStateModule.viewport.scale,
    ],
  );
}
