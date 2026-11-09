import { createCanvasGenerationActionBindings } from "./canvasGenerationActionBindings";
import {
  bindCanvasReferencePreviewView,
  bindCanvasSubmitButtonView,
  bindCreateGenerationSessionController,
  bindCreateUploadController,
  bindGenerationActionsController,
  bindModelSettingsController,
  bindPromptEditingController,
  bindReferenceUploadController,
} from "./canvasGenerationBindings";
import { createCanvasGraphActionBindings } from "./canvasGraphActionBindings";
import { createCanvasMediaActionBindings } from "./canvasMediaActionBindings";
import { createCanvasProjectActionBindings } from "./canvasProjectActionBindings";
import { useCanvasAssetPanelState } from "./useCanvasAssetPanelState";
import { useCanvasConnectionState } from "./useCanvasConnectionState";
import { useCanvasGenerationDebugState } from "./useCanvasGenerationDebugState";
import { useCanvasGraphState } from "./useCanvasGraphState";
import { useCanvasGroupState } from "./useCanvasGroupState";
import { useCanvasHistoryPanelState } from "./useCanvasHistoryPanelState";
import { useCanvasImageEditorState } from "./useCanvasImageEditorState";
import { useCanvasLibraryView } from "./useCanvasLibraryView";
import { useCanvasModelCatalogState } from "./useCanvasModelCatalogState";
import { useCanvasPlaybackState } from "./useCanvasPlaybackState";
import { useCanvasPricingDecisions } from "./useCanvasPricingDecisions";
import { useCanvasProjectRenameState } from "./useCanvasProjectRenameState";
import { useCanvasProjectState } from "./useCanvasProjectState";
import { useCanvasPromptState } from "./useCanvasPromptState";
import { useCanvasRuntimeRefs } from "./useCanvasRuntimeRefs";
import { useCanvasSelectionState } from "./useCanvasSelectionState";
import { useCanvasStoryboardState } from "./useCanvasStoryboardState";
import { useCanvasTitleEditorState } from "./useCanvasTitleEditorState";
import { useCanvasVisibilityView } from "./useCanvasVisibilityView";
export function createCanvasGenerationControllers(
  readContext: () => {
    canvasRuntimeRefsModule: ReturnType<typeof useCanvasRuntimeRefs>;
    canvasGraphStateModule: ReturnType<typeof useCanvasGraphState>;
    canvasSelectionStateModule: ReturnType<typeof useCanvasSelectionState>;
    canvasPromptStateModule: ReturnType<typeof useCanvasPromptState>;
    canvasProjectStateModule: ReturnType<typeof useCanvasProjectState>;
    canvasGraphActionBindings: ReturnType<
      typeof createCanvasGraphActionBindings
    >;
    canvasGenerationActionBindings: ReturnType<
      typeof createCanvasGenerationActionBindings
    >;
    createGenerationSessionController: () => {
      beginNodeGenerationSession: (nodeId: string) => string;
      isNodeGenerationSessionCurrent: (
        nodeId: string,
        sessionId: string,
      ) => boolean;
      finishNodeGenerationSession: (nodeId: string, sessionId?: string) => void;
      cancelNodeGeneration: (nodeId: string) => Promise<boolean>;
    };
    canvasBalance: {
      refresh: () => void;
      loading: boolean;
      error: string;
      availableMicros: number;
      reservedMicros: number;
      baselineMicros: number;
      spentMicros: number;
      percent: number;
      lastRechargeAt: number | null;
    };
    canvasProjectActionBindings: ReturnType<
      typeof createCanvasProjectActionBindings
    >;
    canvasMediaActionBindings: ReturnType<
      typeof createCanvasMediaActionBindings
    >;
    activeNode: import("./canvasDataTypes").NodeData | null;
    canvasGroupStateModule: ReturnType<typeof useCanvasGroupState>;
    canvasGenerationDebugStateModule: ReturnType<
      typeof useCanvasGenerationDebugState
    >;
    canvasPlaybackStateModule: ReturnType<typeof useCanvasPlaybackState>;
    canvasPricingDecisionsModule: ReturnType<typeof useCanvasPricingDecisions>;
    canvasConnectionStateModule: ReturnType<typeof useCanvasConnectionState>;
    canvasStoryboardStateModule: ReturnType<typeof useCanvasStoryboardState>;
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
    nodeMap: Map<string, import("./canvasDataTypes").NodeData>;
    canvasLibraryViewModule: ReturnType<typeof useCanvasLibraryView>;
    canvasHistoryPanelStateModule: ReturnType<
      typeof useCanvasHistoryPanelState
    >;
    canvasProjectRenameStateModule: ReturnType<
      typeof useCanvasProjectRenameState
    >;
    canvasAssetPanelStateModule: ReturnType<typeof useCanvasAssetPanelState>;
    canvasModelCatalogStateModule: ReturnType<
      typeof useCanvasModelCatalogState
    >;
    activeNodeModelOption: import("@/lib/api").AiModelOption | undefined;
    canvasImageEditorStateModule: ReturnType<typeof useCanvasImageEditorState>;
    canvasTitleEditorStateModule: ReturnType<typeof useCanvasTitleEditorState>;
    canvasVisibilityViewModule: ReturnType<typeof useCanvasVisibilityView>;
    canvasColorMode: import("@/ui/theme").ThemeMode;
  },
) {
  function generationActionsController() {
    return bindGenerationActionsController(() => ({
      canvasRuntimeRefsModule: readContext().canvasRuntimeRefsModule,
      canvasGraphStateModule: readContext().canvasGraphStateModule,
      canvasSelectionStateModule: readContext().canvasSelectionStateModule,
      canvasPromptStateModule: readContext().canvasPromptStateModule,
      canvasProjectStateModule: readContext().canvasProjectStateModule,
      setNodePatch: readContext().canvasGraphActionBindings.setNodePatch,
      uploadFileIntoNode:
        readContext().canvasGenerationActionBindings.uploadFileIntoNode,
      createGenerationSessionController:
        readContext().createGenerationSessionController,
      isNodeGenerationSessionCurrent:
        readContext().canvasGenerationActionBindings
          .isNodeGenerationSessionCurrent,
      finishNodeGenerationSession:
        readContext().canvasGenerationActionBindings
          .finishNodeGenerationSession,
      canvasBalance: readContext().canvasBalance,
      loadHistoryItems:
        readContext().canvasProjectActionBindings.loadHistoryItems,
      applyNodeMediaGeometry:
        readContext().canvasGraphActionBindings.applyNodeMediaGeometry,
      createAndUploadVideoPoster:
        readContext().canvasGenerationActionBindings.createAndUploadVideoPoster,
      persistCanvas: readContext().canvasProjectActionBindings.persistCanvas,
      editCanvasArtifact:
        readContext().canvasMediaActionBindings.editCanvasArtifact,
      beginNodeGenerationSession:
        readContext().canvasGenerationActionBindings.beginNodeGenerationSession,
      preflightCanvasModel:
        readContext().canvasGenerationActionBindings.preflightCanvasModel,
      activeNode: readContext().activeNode,
      submitDraftFinalNode:
        readContext().canvasGraphActionBindings.submitDraftFinalNode,
      buildReferenceResolutionSnapshot:
        readContext().canvasGenerationActionBindings
          .buildReferenceResolutionSnapshot,
      resolveNodeRemoteReferenceUrl:
        readContext().canvasGenerationActionBindings
          .resolveNodeRemoteReferenceUrl,
      getImageNodeGeometry:
        readContext().canvasGenerationActionBindings.getImageNodeGeometry,
      inferImageReferenceGeometry:
        readContext().canvasGenerationActionBindings
          .inferImageReferenceGeometry,
      inferVideoRatioFromImageReferences:
        readContext().canvasGenerationActionBindings
          .inferVideoRatioFromImageReferences,
      shouldInheritVideoRatioFromReference:
        readContext().canvasGenerationActionBindings
          .shouldInheritVideoRatioFromReference,
      parseDurationSeconds:
        readContext().canvasGenerationActionBindings.parseDurationSeconds,
      executeDraftWithApproval:
        readContext().canvasGraphActionBindings.executeDraftWithApproval,
      canvasGroupStateModule: readContext().canvasGroupStateModule,
      canvasGenerationDebugStateModule:
        readContext().canvasGenerationDebugStateModule,
      canvasPlaybackStateModule: readContext().canvasPlaybackStateModule,
      canvasPricingDecisionsModule: readContext().canvasPricingDecisionsModule,
    }));
  }

  function canvasSubmitButtonView() {
    return bindCanvasSubmitButtonView(() => ({
      submitButtonIsPending:
        readContext().canvasGenerationActionBindings.submitButtonIsPending,
      runWithSubmitButtonPending:
        readContext().canvasGenerationActionBindings.runWithSubmitButtonPending,
    }));
  }

  function createGenerationSessionController() {
    return bindCreateGenerationSessionController(() => ({
      markNodeSubmitting:
        readContext().canvasGenerationActionBindings.markNodeSubmitting,
      clearNodeSubmitting:
        readContext().canvasGenerationActionBindings.clearNodeSubmitting,
      setNodePatch: readContext().canvasGraphActionBindings.setNodePatch,
      stopNodeProgressTimer:
        readContext().canvasGenerationActionBindings.stopNodeProgressTimer,
      clearSubmitButtonPendingForNode:
        readContext().canvasGenerationActionBindings
          .clearSubmitButtonPendingForNode,
      persistCanvas: readContext().canvasProjectActionBindings.persistCanvas,
      showNodeStatusChip:
        readContext().canvasGenerationActionBindings.showNodeStatusChip,
      beginNodeProgressSimulation:
        readContext().canvasGenerationActionBindings
          .beginNodeProgressSimulation,
      canvasRuntimeRefsModule: readContext().canvasRuntimeRefsModule,
      canvasGraphStateModule: readContext().canvasGraphStateModule,
      canvasPromptStateModule: readContext().canvasPromptStateModule,
    }));
  }

  function referenceUploadController() {
    return bindReferenceUploadController(() => ({
      canvasRuntimeRefsModule: readContext().canvasRuntimeRefsModule,
      canvasGraphStateModule: readContext().canvasGraphStateModule,
      canvasSelectionStateModule: readContext().canvasSelectionStateModule,
      canvasConnectionStateModule: readContext().canvasConnectionStateModule,
      canvasStoryboardStateModule: readContext().canvasStoryboardStateModule,
      activeNode: readContext().activeNode,
      ensureApiKeyReady:
        readContext().canvasGenerationActionBindings.ensureApiKeyReady,
      showNodeStatusChip:
        readContext().canvasGenerationActionBindings.showNodeStatusChip,
      uploadFileIntoNode:
        readContext().canvasGenerationActionBindings.uploadFileIntoNode,
      createImageToImagePresetGroup:
        readContext().canvasGraphActionBindings.createImageToImagePresetGroup,
      persistCanvas: readContext().canvasProjectActionBindings.persistCanvas,
      canvasMeta: readContext().canvasMeta,
      bindUploadedImageToArtifact:
        readContext().canvasMediaActionBindings.bindUploadedImageToArtifact,
      setNodePatch: readContext().canvasGraphActionBindings.setNodePatch,
      nodeSerialCounter: readContext().nodeSerialCounter,
      setNodeSerialCounter: readContext().setNodeSerialCounter,
      closeBottomPanels:
        readContext().canvasGraphActionBindings.closeBottomPanels,
      closePromptMenus:
        readContext().canvasGenerationActionBindings.closePromptMenus,
      applyAssetCatalogItem:
        readContext().canvasProjectActionBindings.applyAssetCatalogItem,
      toWorld: readContext().canvasGraphActionBindings.toWorld,
      nodeMap: readContext().nodeMap,
      canvasPromptStateModule: readContext().canvasPromptStateModule,
      canvasGenerationDebugStateModule:
        readContext().canvasGenerationDebugStateModule,
      canvasLibraryViewModule: readContext().canvasLibraryViewModule,
      canvasHistoryPanelStateModule:
        readContext().canvasHistoryPanelStateModule,
      canvasProjectRenameStateModule:
        readContext().canvasProjectRenameStateModule,
      canvasAssetPanelStateModule: readContext().canvasAssetPanelStateModule,
    }));
  }

  function modelSettingsController() {
    return bindModelSettingsController(() => ({
      canvasGraphStateModule: readContext().canvasGraphStateModule,
      canvasPromptStateModule: readContext().canvasPromptStateModule,
      canvasModelCatalogStateModule:
        readContext().canvasModelCatalogStateModule,
      nodeMap: readContext().nodeMap,
      activeNode: readContext().activeNode,
      setNodePatch: readContext().canvasGraphActionBindings.setNodePatch,
      activeNodeModelOption: readContext().activeNodeModelOption,
      persistCanvas: readContext().canvasProjectActionBindings.persistCanvas,
      canvasRuntimeRefsModule: readContext().canvasRuntimeRefsModule,
      canvasSelectionStateModule: readContext().canvasSelectionStateModule,
      canvasProjectStateModule: readContext().canvasProjectStateModule,
    }));
  }

  function promptEditingController() {
    return bindPromptEditingController(() => ({
      canvasGraphStateModule: readContext().canvasGraphStateModule,
      canvasPromptStateModule: readContext().canvasPromptStateModule,
      canvasImageEditorStateModule: readContext().canvasImageEditorStateModule,
      activeNode: readContext().activeNode,
      setNodePatch: readContext().canvasGraphActionBindings.setNodePatch,
      persistCanvas: readContext().canvasProjectActionBindings.persistCanvas,
      canvasMeta: readContext().canvasMeta,
      canvasRuntimeRefsModule: readContext().canvasRuntimeRefsModule,
      canvasTitleEditorStateModule: readContext().canvasTitleEditorStateModule,
      canvasVisibilityViewModule: readContext().canvasVisibilityViewModule,
      canvasGroupStateModule: readContext().canvasGroupStateModule,
    }));
  }

  function canvasReferencePreviewView() {
    return bindCanvasReferencePreviewView(() => ({
      canvasColorMode: readContext().canvasColorMode,
    }));
  }

  function createUploadController() {
    return bindCreateUploadController(() => ({
      canvasRuntimeRefsModule: readContext().canvasRuntimeRefsModule,
      canvasGraphStateModule: readContext().canvasGraphStateModule,
      setNodePatch: readContext().canvasGraphActionBindings.setNodePatch,
      beginNodeProgressSimulation:
        readContext().canvasGenerationActionBindings
          .beginNodeProgressSimulation,
      stopNodeProgressTimer:
        readContext().canvasGenerationActionBindings.stopNodeProgressTimer,
      setNodeUploadProgress:
        readContext().canvasGenerationActionBindings.setNodeUploadProgress,
      finalizeNodeUploadVisual:
        readContext().canvasGenerationActionBindings.finalizeNodeUploadVisual,
      persistCanvas: readContext().canvasProjectActionBindings.persistCanvas,
      assertCanvasOperationActive:
        readContext().canvasProjectActionBindings.assertCanvasOperationActive,
      canvasProjectStateModule: readContext().canvasProjectStateModule,
      canvasPromptStateModule: readContext().canvasPromptStateModule,
      canvasGenerationDebugStateModule:
        readContext().canvasGenerationDebugStateModule,
    }));
  }
  return {
    generationActionsController,
    canvasSubmitButtonView,
    createGenerationSessionController,
    referenceUploadController,
    modelSettingsController,
    promptEditingController,
    canvasReferencePreviewView,
    createUploadController,
  };
}
