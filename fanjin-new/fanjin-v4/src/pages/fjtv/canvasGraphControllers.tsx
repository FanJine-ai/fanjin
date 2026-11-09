import { createCanvasGenerationActionBindings } from "./canvasGenerationActionBindings";
import { createCanvasGraphActionBindings } from "./canvasGraphActionBindings";
import {
  bindCanvasEmptyLauncherActions,
  bindCanvasNodeMutationController,
  bindCanvasPanelActions,
  bindCanvasShortcutActions,
  bindGroupExecutionController,
  bindInteractionController,
  bindNodeCreationController,
  bindNodeOperationsController,
  bindPresetController,
  bindProductScriptController,
  bindProductScriptView,
  bindStoryboardController,
  bindViewportController,
} from "./canvasGraphBindings";
import { createCanvasMediaActionBindings } from "./canvasMediaActionBindings";
import { createCanvasProjectActionBindings } from "./canvasProjectActionBindings";
import { useCanvasAssetPanelState } from "./useCanvasAssetPanelState";
import { useCanvasConnectionState } from "./useCanvasConnectionState";
import { useCanvasGenerationDebugState } from "./useCanvasGenerationDebugState";
import { useCanvasGraphState } from "./useCanvasGraphState";
import { useCanvasGroupState } from "./useCanvasGroupState";
import { useCanvasLibraryView } from "./useCanvasLibraryView";
import { useCanvasModelCatalogState } from "./useCanvasModelCatalogState";
import { useCanvasPricingDecisions } from "./useCanvasPricingDecisions";
import { useCanvasProductState } from "./useCanvasProductState";
import { useCanvasProjectRenameState } from "./useCanvasProjectRenameState";
import { useCanvasProjectState } from "./useCanvasProjectState";
import { useCanvasPromptState } from "./useCanvasPromptState";
import { useCanvasRuntimeRefs } from "./useCanvasRuntimeRefs";
import { useCanvasSelectionState } from "./useCanvasSelectionState";
import { useCanvasStoryboardState } from "./useCanvasStoryboardState";
import { useCanvasTemplateState } from "./useCanvasTemplateState";
import { useCanvasTitleEditorState } from "./useCanvasTitleEditorState";
import { useCanvasViewportUiState } from "./useCanvasViewportUiState";
import { useCanvasVisibilityView } from "./useCanvasVisibilityView";
export function createCanvasGraphControllers(
  readContext: () => {
    nodeMap: Map<string, import("./canvasDataTypes").NodeData>;
    canvasBounds: import("./canvasGeometry").CanvasRect | null;
    canvasGraphStateModule: ReturnType<typeof useCanvasGraphState>;
    canvasRuntimeRefsModule: ReturnType<typeof useCanvasRuntimeRefs>;
    canvasAssetPanelStateModule: ReturnType<typeof useCanvasAssetPanelState>;
    canvasSelectionStateModule: ReturnType<typeof useCanvasSelectionState>;
    canvasVisibilityViewModule: ReturnType<typeof useCanvasVisibilityView>;
    canvasConnectionStateModule: ReturnType<typeof useCanvasConnectionState>;
    canvasPricingDecisionsModule: ReturnType<typeof useCanvasPricingDecisions>;
    canvasGraphActionBindings: ReturnType<
      typeof createCanvasGraphActionBindings
    >;
    studioChrome: boolean;
    canvasMeta: import("@/pages/fjtv/canvasDataTypes").CanvasMetaState;
    nodeSerialCounter: Record<
      import("@/pages/fjtv/canvasMediaTypes").NodeType,
      number
    >;
    setNodeSerialCounter: React.Dispatch<
      React.SetStateAction<
        Record<import("@/pages/fjtv/canvasMediaTypes").NodeType, number>
      >
    >;
    availableModels: import("@/lib/api").AiModelOption[];
    canvasGenerationActionBindings: ReturnType<
      typeof createCanvasGenerationActionBindings
    >;
    canvasModelCatalogStateModule: ReturnType<
      typeof useCanvasModelCatalogState
    >;
    canvasTemplateStateModule: ReturnType<typeof useCanvasTemplateState>;
    canvasProjectRenameStateModule: ReturnType<
      typeof useCanvasProjectRenameState
    >;
    canvasProjectStateModule: ReturnType<typeof useCanvasProjectState>;
    canvasPromptStateModule: ReturnType<typeof useCanvasPromptState>;
    canvasGroupStateModule: ReturnType<typeof useCanvasGroupState>;
    canvasTitleEditorStateModule: ReturnType<typeof useCanvasTitleEditorState>;
    canvasViewportUiStateModule: ReturnType<typeof useCanvasViewportUiState>;
    canvasProjectActionBindings: ReturnType<
      typeof createCanvasProjectActionBindings
    >;
    canvasLibraryViewModule: ReturnType<typeof useCanvasLibraryView>;
    canvasGenerationDebugStateModule: ReturnType<
      typeof useCanvasGenerationDebugState
    >;
    canvasMediaActionBindings: ReturnType<
      typeof createCanvasMediaActionBindings
    >;
    canvasCapabilities: import("@/pages/fjtv/canvasCapabilities").CanvasRealCapabilities;
    canvasProductStateModule: ReturnType<typeof useCanvasProductState>;
    interactionPerformanceMode: boolean;
    commitTextNodeEditing: () => void;
    canvasStoryboardStateModule: ReturnType<typeof useCanvasStoryboardState>;
  },
) {
  function viewportController() {
    return bindViewportController(() => ({
      nodeMap: readContext().nodeMap,
      canvasBounds: readContext().canvasBounds,
      canvasGraphStateModule: readContext().canvasGraphStateModule,
      canvasRuntimeRefsModule: readContext().canvasRuntimeRefsModule,
      canvasAssetPanelStateModule: readContext().canvasAssetPanelStateModule,
      canvasSelectionStateModule: readContext().canvasSelectionStateModule,
      get canvasVisibilityViewModule() {
        return readContext().canvasVisibilityViewModule;
      },
    }));
  }

  function nodeCreationController() {
    return bindNodeCreationController(() => ({
      canvasRuntimeRefsModule: readContext().canvasRuntimeRefsModule,
      canvasGraphStateModule: readContext().canvasGraphStateModule,
      canvasSelectionStateModule: readContext().canvasSelectionStateModule,
      canvasConnectionStateModule: readContext().canvasConnectionStateModule,
      canvasPricingDecisionsModule: readContext().canvasPricingDecisionsModule,
      viewportVisualScale:
        readContext().canvasGraphActionBindings.viewportVisualScale,
      nodeMap: readContext().nodeMap,
      studioChrome: readContext().studioChrome,
      canvasMeta: readContext().canvasMeta,
      nodeSerialCounter: readContext().nodeSerialCounter,
      setNodeSerialCounter: readContext().setNodeSerialCounter,
      availableModels: readContext().availableModels,
      beginNodeGenerationSession:
        readContext().canvasGenerationActionBindings.beginNodeGenerationSession,
      setNodePatch: readContext().canvasGraphActionBindings.setNodePatch,
      finishNodeGenerationSession:
        readContext().canvasGenerationActionBindings
          .finishNodeGenerationSession,
      beginNodeProgressSimulation:
        readContext().canvasGenerationActionBindings
          .beginNodeProgressSimulation,
      pollTaskUntilDone:
        readContext().canvasGenerationActionBindings.pollTaskUntilDone,
      canvasModelCatalogStateModule:
        readContext().canvasModelCatalogStateModule,
      canvasTemplateStateModule: readContext().canvasTemplateStateModule,
      canvasProjectRenameStateModule:
        readContext().canvasProjectRenameStateModule,
      canvasProjectStateModule: readContext().canvasProjectStateModule,
      canvasPromptStateModule: readContext().canvasPromptStateModule,
      canvasAssetPanelStateModule: readContext().canvasAssetPanelStateModule,
    }));
  }

  function nodeOperationsController() {
    return bindNodeOperationsController(() => ({
      canvasGraphStateModule: readContext().canvasGraphStateModule,
      canvasSelectionStateModule: readContext().canvasSelectionStateModule,
      canvasGroupStateModule: readContext().canvasGroupStateModule,
      canvasTitleEditorStateModule: readContext().canvasTitleEditorStateModule,
      canvasAssetPanelStateModule: readContext().canvasAssetPanelStateModule,
      canvasViewportUiStateModule: readContext().canvasViewportUiStateModule,
      persistCanvas: readContext().canvasProjectActionBindings.persistCanvas,
      nodeMap: readContext().nodeMap,
      recordCanvasHistoryMutation:
        readContext().canvasProjectActionBindings.recordCanvasHistoryMutation,
      buildHistorySnapshot:
        readContext().canvasProjectActionBindings.buildHistorySnapshot,
      focusNodeInViewport:
        readContext().canvasGraphActionBindings.focusNodeInViewport,
      canvasMeta: readContext().canvasMeta,
      applyHistorySnapshot:
        readContext().canvasProjectActionBindings.applyHistorySnapshot,
      toWorld: readContext().canvasGraphActionBindings.toWorld,
      openCreationMenuAtWorld:
        readContext().canvasGraphActionBindings.openCreationMenuAtWorld,
      canvasLibraryViewModule: readContext().canvasLibraryViewModule,
      canvasVisibilityViewModule: readContext().canvasVisibilityViewModule,
      canvasPromptStateModule: readContext().canvasPromptStateModule,
      canvasRuntimeRefsModule: readContext().canvasRuntimeRefsModule,
      canvasConnectionStateModule: readContext().canvasConnectionStateModule,
    }));
  }

  function canvasNodeMutationController() {
    return bindCanvasNodeMutationController(() => ({
      canvasGraphStateModule: readContext().canvasGraphStateModule,
      canvasGenerationDebugStateModule:
        readContext().canvasGenerationDebugStateModule,
    }));
  }

  function canvasShortcutActions() {
    return bindCanvasShortcutActions(() => ({
      canvasGraphStateModule: readContext().canvasGraphStateModule,
      toWorld: readContext().canvasGraphActionBindings.toWorld,
      openCreationMenuAtWorld:
        readContext().canvasGraphActionBindings.openCreationMenuAtWorld,
      hasDuplicateEdge:
        readContext().canvasGraphActionBindings.hasDuplicateEdge,
      persistCanvas: readContext().canvasProjectActionBindings.persistCanvas,
      canvasMeta: readContext().canvasMeta,
      canvasRuntimeRefsModule: readContext().canvasRuntimeRefsModule,
      canvasAssetPanelStateModule: readContext().canvasAssetPanelStateModule,
      canvasSelectionStateModule: readContext().canvasSelectionStateModule,
      canvasPromptStateModule: readContext().canvasPromptStateModule,
      canvasGroupStateModule: readContext().canvasGroupStateModule,
    }));
  }

  function canvasPanelActions() {
    return bindCanvasPanelActions(() => ({
      closePromptMenus:
        readContext().canvasGenerationActionBindings.closePromptMenus,
      closeComposeEditor:
        readContext().canvasMediaActionBindings.closeComposeEditor,
      closeVideoEditor:
        readContext().canvasMediaActionBindings.closeVideoEditor,
      canvasConnectionStateModule: readContext().canvasConnectionStateModule,
      canvasTemplateStateModule: readContext().canvasTemplateStateModule,
      canvasProjectRenameStateModule:
        readContext().canvasProjectRenameStateModule,
    }));
  }

  function groupExecutionController() {
    return bindGroupExecutionController(() => ({
      canvasGraphStateModule: readContext().canvasGraphStateModule,
      canvasSelectionStateModule: readContext().canvasSelectionStateModule,
      canvasGroupStateModule: readContext().canvasGroupStateModule,
      generateWithActiveNode:
        readContext().canvasGenerationActionBindings.generateWithActiveNode,
      persistCanvas: readContext().canvasProjectActionBindings.persistCanvas,
      canvasVisibilityViewModule: readContext().canvasVisibilityViewModule,
      canvasPromptStateModule: readContext().canvasPromptStateModule,
    }));
  }

  function productScriptView() {
    return bindProductScriptView(() => ({
      canvasCapabilities: readContext().canvasCapabilities,
      getProductScriptWorkflow:
        readContext().canvasGraphActionBindings.getProductScriptWorkflow,
      openProductScriptVideoUpload:
        readContext().canvasGraphActionBindings.openProductScriptVideoUpload,
      updateProductScriptShot:
        readContext().canvasGraphActionBindings.updateProductScriptShot,
      saveProductScriptWorkflow:
        readContext().canvasGraphActionBindings.saveProductScriptWorkflow,
      submitProductAssetsAnalysis:
        readContext().canvasGraphActionBindings.submitProductAssetsAnalysis,
      openProductScriptAssetUpload:
        readContext().canvasGraphActionBindings.openProductScriptAssetUpload,
      updateProductAnalysisText:
        readContext().canvasGraphActionBindings.updateProductAnalysisText,
      submitProductStoryboardCompose:
        readContext().canvasGraphActionBindings.submitProductStoryboardCompose,
      updateProductStoryboardShot:
        readContext().canvasGraphActionBindings.updateProductStoryboardShot,
      nodeMap: readContext().nodeMap,
      generateProductScriptVideos:
        readContext().canvasGraphActionBindings.generateProductScriptVideos,
      canvasPromptStateModule: readContext().canvasPromptStateModule,
      canvasProductStateModule: readContext().canvasProductStateModule,
    }));
  }

  function productScriptController() {
    return bindProductScriptController(() => ({
      canvasRuntimeRefsModule: readContext().canvasRuntimeRefsModule,
      canvasGraphStateModule: readContext().canvasGraphStateModule,
      canvasSelectionStateModule: readContext().canvasSelectionStateModule,
      canvasProductStateModule: readContext().canvasProductStateModule,
      persistCanvas: readContext().canvasProjectActionBindings.persistCanvas,
      ensureApiKeyReady:
        readContext().canvasGenerationActionBindings.ensureApiKeyReady,
      uploadMediaFileToRemote:
        readContext().canvasGenerationActionBindings.uploadMediaFileToRemote,
      assertCanvasOperationActive:
        readContext().canvasProjectActionBindings.assertCanvasOperationActive,
      nodeMap: readContext().nodeMap,
      canvasMeta: readContext().canvasMeta,
      preflightCanvasModel:
        readContext().canvasGenerationActionBindings.preflightCanvasModel,
      setNodePatch: readContext().canvasGraphActionBindings.setNodePatch,
      beginNodeGenerationSession:
        readContext().canvasGenerationActionBindings.beginNodeGenerationSession,
      parseDurationSeconds:
        readContext().canvasGenerationActionBindings.parseDurationSeconds,
      isNodeGenerationSessionCurrent:
        readContext().canvasGenerationActionBindings
          .isNodeGenerationSessionCurrent,
      beginNodeProgressSimulation:
        readContext().canvasGenerationActionBindings
          .beginNodeProgressSimulation,
      pollTaskUntilDone:
        readContext().canvasGenerationActionBindings.pollTaskUntilDone,
      applyTaskResultToNode:
        readContext().canvasGenerationActionBindings.applyTaskResultToNode,
      finishNodeGenerationSession:
        readContext().canvasGenerationActionBindings
          .finishNodeGenerationSession,
      setNodeSerialCounter: readContext().setNodeSerialCounter,
      canvasPromptStateModule: readContext().canvasPromptStateModule,
      canvasProjectStateModule: readContext().canvasProjectStateModule,
    }));
  }

  function storyboardController() {
    return bindStoryboardController(() => ({
      canvasGraphStateModule: readContext().canvasGraphStateModule,
      canvasSelectionStateModule: readContext().canvasSelectionStateModule,
      canvasGroupStateModule: readContext().canvasGroupStateModule,
      canvasVisibilityViewModule: readContext().canvasVisibilityViewModule,
      createImageGridCellNode:
        readContext().canvasMediaActionBindings.createImageGridCellNode,
      nodeMap: readContext().nodeMap,
      persistCanvas: readContext().canvasProjectActionBindings.persistCanvas,
      canvasMeta: readContext().canvasMeta,
      uploadMediaFileToRemote:
        readContext().canvasGenerationActionBindings.uploadMediaFileToRemote,
      assertCanvasOperationActive:
        readContext().canvasProjectActionBindings.assertCanvasOperationActive,
      canvasPromptStateModule: readContext().canvasPromptStateModule,
      canvasRuntimeRefsModule: readContext().canvasRuntimeRefsModule,
    }));
  }

  function presetController() {
    return bindPresetController(() => ({
      canvasGraphStateModule: readContext().canvasGraphStateModule,
      canvasSelectionStateModule: readContext().canvasSelectionStateModule,
      canvasGroupStateModule: readContext().canvasGroupStateModule,
      nodeMap: readContext().nodeMap,
      persistCanvas: readContext().canvasProjectActionBindings.persistCanvas,
      canvasMeta: readContext().canvasMeta,
      canvasTitleEditorStateModule: readContext().canvasTitleEditorStateModule,
      canvasPromptStateModule: readContext().canvasPromptStateModule,
    }));
  }

  function interactionController() {
    return bindInteractionController(() => ({
      canvasRuntimeRefsModule: readContext().canvasRuntimeRefsModule,
      canvasGraphStateModule: readContext().canvasGraphStateModule,
      canvasSelectionStateModule: readContext().canvasSelectionStateModule,
      canvasConnectionStateModule: readContext().canvasConnectionStateModule,
      canvasGroupStateModule: readContext().canvasGroupStateModule,
      canvasPromptStateModule: readContext().canvasPromptStateModule,
      canvasTitleEditorStateModule: readContext().canvasTitleEditorStateModule,
      canvasProjectStateModule: readContext().canvasProjectStateModule,
      toWorld: readContext().canvasGraphActionBindings.toWorld,
      connectionSideToward:
        readContext().canvasGraphActionBindings.connectionSideToward,
      closePromptMenus:
        readContext().canvasGenerationActionBindings.closePromptMenus,
      markCanvasInteraction:
        readContext().canvasGraphActionBindings.markCanvasInteraction,
      viewportVisualScale:
        readContext().canvasGraphActionBindings.viewportVisualScale,
      nodeMap: readContext().nodeMap,
      createDetachedImageGridCellNode:
        readContext().canvasMediaActionBindings.createDetachedImageGridCellNode,
      persistCanvas: readContext().canvasProjectActionBindings.persistCanvas,
      interactionPerformanceMode: readContext().interactionPerformanceMode,
      detectEdgeDropTarget:
        readContext().canvasGraphActionBindings.detectEdgeDropTarget,
      nodeSocket: readContext().canvasGraphActionBindings.nodeSocket,
      detectEdgeHover: readContext().canvasGraphActionBindings.detectEdgeHover,
      commitGroupTitle:
        readContext().canvasGraphActionBindings.commitGroupTitle,
      cancelGroupTitleEdit:
        readContext().canvasGraphActionBindings.cancelGroupTitleEdit,
      edgeHitToleranceInWorld:
        readContext().canvasGraphActionBindings.edgeHitToleranceInWorld,
      removeEdge: readContext().canvasGraphActionBindings.removeEdge,
      beginGroupDrag: readContext().canvasGraphActionBindings.beginGroupDrag,
      commitTextNodeEditing: readContext().commitTextNodeEditing,
      resetSelectedExpandedTextNodes:
        readContext().canvasGenerationActionBindings
          .resetSelectedExpandedTextNodes,
      closeBottomPanels:
        readContext().canvasGraphActionBindings.closeBottomPanels,
      edgeIntersectsRect:
        readContext().canvasGraphActionBindings.edgeIntersectsRect,
      hasDuplicateEdge:
        readContext().canvasGraphActionBindings.hasDuplicateEdge,
      admitCanvasReferenceEdge:
        readContext().canvasGraphActionBindings.admitCanvasReferenceEdge,
      openCreationMenuAtWorld:
        readContext().canvasGraphActionBindings.openCreationMenuAtWorld,
      canvasViewportUiStateModule: readContext().canvasViewportUiStateModule,
      canvasVisibilityViewModule: readContext().canvasVisibilityViewModule,
      canvasLibraryViewModule: readContext().canvasLibraryViewModule,
      canvasStoryboardStateModule: readContext().canvasStoryboardStateModule,
    }));
  }

  function canvasEmptyLauncherActions() {
    return bindCanvasEmptyLauncherActions(() => ({
      startQuickCharacterThreeView:
        readContext().canvasMediaActionBindings.startQuickCharacterThreeView,
      createNodeAt: readContext().canvasGraphActionBindings.createNodeAt,
      canvasPromptStateModule: readContext().canvasPromptStateModule,
    }));
  }
  return {
    viewportController,
    nodeCreationController,
    nodeOperationsController,
    canvasNodeMutationController,
    canvasShortcutActions,
    canvasPanelActions,
    groupExecutionController,
    productScriptView,
    productScriptController,
    storyboardController,
    presetController,
    interactionController,
    canvasEmptyLauncherActions,
  };
}
