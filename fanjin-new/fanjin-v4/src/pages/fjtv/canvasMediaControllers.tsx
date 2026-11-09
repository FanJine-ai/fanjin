import { createCanvasGenerationActionBindings } from "./canvasGenerationActionBindings";
import { createCanvasGraphActionBindings } from "./canvasGraphActionBindings";
import { createCanvasMediaActionBindings } from "./canvasMediaActionBindings";
import {
  bindArtifactEditingController,
  bindCanvasMediaViewerActions,
  bindCanvasStoryboardVideoPromptView,
  bindComposeController,
  bindImageGridController,
  bindImageMenuController,
  bindImageToolsController,
  bindVideoStoryController,
  bindVideoToolsController,
} from "./canvasMediaBindings";
import { createCanvasProjectActionBindings } from "./canvasProjectActionBindings";
import { useCanvasActiveModelView } from "./useCanvasActiveModelView";
import { useCanvasAssetPanelState } from "./useCanvasAssetPanelState";
import { useCanvasComposeState } from "./useCanvasComposeState";
import { useCanvasComposeView } from "./useCanvasComposeView";
import { useCanvasGenerationDebugState } from "./useCanvasGenerationDebugState";
import { useCanvasGraphState } from "./useCanvasGraphState";
import { useCanvasGroupState } from "./useCanvasGroupState";
import { useCanvasImageEditorState } from "./useCanvasImageEditorState";
import { useCanvasPlaybackState } from "./useCanvasPlaybackState";
import { useCanvasProjectState } from "./useCanvasProjectState";
import { useCanvasPromptState } from "./useCanvasPromptState";
import { useCanvasRuntimeRefs } from "./useCanvasRuntimeRefs";
import { useCanvasSelectionState } from "./useCanvasSelectionState";
import { useCanvasVideoEditorState } from "./useCanvasVideoEditorState";
export function createCanvasMediaControllers(
  readContext: () => {
    canvasGraphStateModule: ReturnType<typeof useCanvasGraphState>;
    canvasSelectionStateModule: ReturnType<typeof useCanvasSelectionState>;
    canvasGraphActionBindings: ReturnType<
      typeof createCanvasGraphActionBindings
    >;
    canvasProjectActionBindings: ReturnType<
      typeof createCanvasProjectActionBindings
    >;
    canvasPromptStateModule: ReturnType<typeof useCanvasPromptState>;
    canvasGroupStateModule: ReturnType<typeof useCanvasGroupState>;
    canvasActiveModelViewModule: ReturnType<typeof useCanvasActiveModelView>;
    canvasVideoEditorStateModule: ReturnType<typeof useCanvasVideoEditorState>;
    canvasCapabilities: import("@/pages/fjtv/canvasCapabilities").CanvasRealCapabilities;
    canvasGenerationActionBindings: ReturnType<
      typeof createCanvasGenerationActionBindings
    >;
    canvasMeta: import("@/pages/fjtv/canvasDataTypes").CanvasMetaState;
    nodeMap: Map<string, import("./canvasDataTypes").NodeData>;
    canvasMediaActionBindings: ReturnType<
      typeof createCanvasMediaActionBindings
    >;
    canvasProjectStateModule: ReturnType<typeof useCanvasProjectState>;
    canvasPlaybackStateModule: ReturnType<typeof useCanvasPlaybackState>;
    canvasGenerationDebugStateModule: ReturnType<
      typeof useCanvasGenerationDebugState
    >;
    canvasRuntimeRefsModule: ReturnType<typeof useCanvasRuntimeRefs>;
    canvasComposeStateModule: ReturnType<typeof useCanvasComposeState>;
    canvasComposeViewModule: ReturnType<typeof useCanvasComposeView>;
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
    canvasImageEditorStateModule: ReturnType<typeof useCanvasImageEditorState>;
    setNodeSerialCounter: React.Dispatch<
      React.SetStateAction<
        Record<import("@/pages/fjtv/canvasMediaTypes").NodeType, number>
      >
    >;
    canvasAssetPanelStateModule: ReturnType<typeof useCanvasAssetPanelState>;
  },
) {
  function artifactEditingController() {
    return bindArtifactEditingController(() => ({
      canvasGraphStateModule: readContext().canvasGraphStateModule,
      canvasSelectionStateModule: readContext().canvasSelectionStateModule,
      setNodePatch: readContext().canvasGraphActionBindings.setNodePatch,
      persistCanvas: readContext().canvasProjectActionBindings.persistCanvas,
      canvasPromptStateModule: readContext().canvasPromptStateModule,
      canvasGroupStateModule: readContext().canvasGroupStateModule,
    }));
  }

  function canvasStoryboardVideoPromptView() {
    return bindCanvasStoryboardVideoPromptView(() => ({
      canvasActiveModelViewModule: readContext().canvasActiveModelViewModule,
    }));
  }

  function videoToolsController() {
    return bindVideoToolsController(() => ({
      canvasGraphStateModule: readContext().canvasGraphStateModule,
      canvasSelectionStateModule: readContext().canvasSelectionStateModule,
      canvasPromptStateModule: readContext().canvasPromptStateModule,
      canvasVideoEditorStateModule: readContext().canvasVideoEditorStateModule,
      canvasCapabilities: readContext().canvasCapabilities,
      resolvePendingVideoBillingBeforeSubmit:
        readContext().canvasGenerationActionBindings
          .resolvePendingVideoBillingBeforeSubmit,
      preflightCanvasModel:
        readContext().canvasGenerationActionBindings.preflightCanvasModel,
      parseDurationSeconds:
        readContext().canvasGenerationActionBindings.parseDurationSeconds,
      beginNodeGenerationSession:
        readContext().canvasGenerationActionBindings.beginNodeGenerationSession,
      setNodePatch: readContext().canvasGraphActionBindings.setNodePatch,
      isNodeGenerationSessionCurrent:
        readContext().canvasGenerationActionBindings
          .isNodeGenerationSessionCurrent,
      persistCanvas: readContext().canvasProjectActionBindings.persistCanvas,
      beginNodeProgressSimulation:
        readContext().canvasGenerationActionBindings
          .beginNodeProgressSimulation,
      pollTaskUntilDone:
        readContext().canvasGenerationActionBindings.pollTaskUntilDone,
      finishNodeGenerationSession:
        readContext().canvasGenerationActionBindings
          .finishNodeGenerationSession,
      showNodeStatusChip:
        readContext().canvasGenerationActionBindings.showNodeStatusChip,
      ensureApiKeyReady:
        readContext().canvasGenerationActionBindings.ensureApiKeyReady,
      resolveNodeRemoteReferenceUrl:
        readContext().canvasGenerationActionBindings
          .resolveNodeRemoteReferenceUrl,
      canvasMeta: readContext().canvasMeta,
      applyTaskResultToNode:
        readContext().canvasGenerationActionBindings.applyTaskResultToNode,
      nodeMap: readContext().nodeMap,
      stopNodeProgressTimer:
        readContext().canvasGenerationActionBindings.stopNodeProgressTimer,
      createDerivedImageNode:
        readContext().canvasMediaActionBindings.createDerivedImageNode,
      canvasProjectStateModule: readContext().canvasProjectStateModule,
      canvasPlaybackStateModule: readContext().canvasPlaybackStateModule,
      canvasGenerationDebugStateModule:
        readContext().canvasGenerationDebugStateModule,
      canvasRuntimeRefsModule: readContext().canvasRuntimeRefsModule,
    }));
  }

  function composeController() {
    return bindComposeController(() => ({
      canvasGraphStateModule: readContext().canvasGraphStateModule,
      canvasSelectionStateModule: readContext().canvasSelectionStateModule,
      canvasComposeStateModule: readContext().canvasComposeStateModule,
      canvasComposeViewModule: readContext().canvasComposeViewModule,
      setNodePatch: readContext().canvasGraphActionBindings.setNodePatch,
      persistCanvas: readContext().canvasProjectActionBindings.persistCanvas,
      nodeMap: readContext().nodeMap,
      canvasBalance: readContext().canvasBalance,
      canvasRuntimeRefsModule: readContext().canvasRuntimeRefsModule,
      canvasPromptStateModule: readContext().canvasPromptStateModule,
      canvasProjectStateModule: readContext().canvasProjectStateModule,
    }));
  }

  function imageToolsController() {
    return bindImageToolsController(() => ({
      canvasRuntimeRefsModule: readContext().canvasRuntimeRefsModule,
      canvasGraphStateModule: readContext().canvasGraphStateModule,
      canvasSelectionStateModule: readContext().canvasSelectionStateModule,
      canvasImageEditorStateModule: readContext().canvasImageEditorStateModule,
      persistCanvas: readContext().canvasProjectActionBindings.persistCanvas,
      closePromptMenus:
        readContext().canvasGenerationActionBindings.closePromptMenus,
      closeImageToolbarMenus:
        readContext().canvasMediaActionBindings.closeImageToolbarMenus,
      ensureApiKeyReady:
        readContext().canvasGenerationActionBindings.ensureApiKeyReady,
      nodeMap: readContext().nodeMap,
      ensureRemoteImageUrlForNode:
        readContext().canvasGenerationActionBindings
          .ensureRemoteImageUrlForNode,
      beginNodeGenerationSession:
        readContext().canvasGenerationActionBindings.beginNodeGenerationSession,
      setNodePatch: readContext().canvasGraphActionBindings.setNodePatch,
      canvasMeta: readContext().canvasMeta,
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
      buildCroppedImageFile:
        readContext().canvasMediaActionBindings.buildCroppedImageFile,
      findSelectableCatalogModel:
        readContext().canvasGenerationActionBindings.findSelectableCatalogModel,
      preflightCanvasModel:
        readContext().canvasGenerationActionBindings.preflightCanvasModel,
      resolveNodeRemoteReferenceUrl:
        readContext().canvasGenerationActionBindings
          .resolveNodeRemoteReferenceUrl,
      setNodeSerialCounter: readContext().setNodeSerialCounter,
      canvasPromptStateModule: readContext().canvasPromptStateModule,
      canvasProjectStateModule: readContext().canvasProjectStateModule,
      canvasGroupStateModule: readContext().canvasGroupStateModule,
      canvasAssetPanelStateModule: readContext().canvasAssetPanelStateModule,
    }));
  }

  function videoStoryController() {
    return bindVideoStoryController(() => ({
      canvasGraphStateModule: readContext().canvasGraphStateModule,
      canvasSelectionStateModule: readContext().canvasSelectionStateModule,
      canvasGroupStateModule: readContext().canvasGroupStateModule,
      buildStoryboardGroupData:
        readContext().canvasGraphActionBindings.buildStoryboardGroupData,
      persistCanvas: readContext().canvasProjectActionBindings.persistCanvas,
      canvasMeta: readContext().canvasMeta,
      ensureApiKeyReady:
        readContext().canvasGenerationActionBindings.ensureApiKeyReady,
      videoStoryAttemptId:
        readContext().canvasGraphActionBindings.videoStoryAttemptId,
      canvasPromptStateModule: readContext().canvasPromptStateModule,
      canvasVideoEditorStateModule: readContext().canvasVideoEditorStateModule,
      canvasProjectStateModule: readContext().canvasProjectStateModule,
    }));
  }

  function canvasMediaViewerActions() {
    return bindCanvasMediaViewerActions(() => ({
      getNodeMediaUrl: readContext().canvasMediaActionBindings.getNodeMediaUrl,
      canvasPromptStateModule: readContext().canvasPromptStateModule,
    }));
  }

  function imageMenuController() {
    return bindImageMenuController(() => ({
      canvasImageEditorStateModule: readContext().canvasImageEditorStateModule,
      openImageEnhanceEditor:
        readContext().canvasMediaActionBindings.openImageEnhanceEditor,
      openImageOutpaintEditor:
        readContext().canvasMediaActionBindings.openImageOutpaintEditor,
      openImageCropEditor:
        readContext().canvasMediaActionBindings.openImageCropEditor,
      submitRemoveImageBackground:
        readContext().canvasMediaActionBindings.submitRemoveImageBackground,
      submitImageErase:
        readContext().canvasMediaActionBindings.submitImageErase,
      openImageTransformEditor:
        readContext().canvasMediaActionBindings.openImageTransformEditor,
      submitMultiAngleNineGrid:
        readContext().canvasMediaActionBindings.submitMultiAngleNineGrid,
      submitProductSheet:
        readContext().canvasMediaActionBindings.submitProductSheet,
      submitSceneSheet:
        readContext().canvasMediaActionBindings.submitSceneSheet,
      submitCharacterSheet:
        readContext().canvasMediaActionBindings.submitCharacterSheet,
      submitCharacterThreeView:
        readContext().canvasMediaActionBindings.submitCharacterThreeView,
      submitCinematicLighting:
        readContext().canvasMediaActionBindings.submitCinematicLighting,
      submitStoryboard25Grid:
        readContext().canvasMediaActionBindings.submitStoryboard25Grid,
      canvasVideoEditorStateModule: readContext().canvasVideoEditorStateModule,
      canvasSelectionStateModule: readContext().canvasSelectionStateModule,
      canvasPromptStateModule: readContext().canvasPromptStateModule,
    }));
  }

  function imageGridController() {
    return bindImageGridController(() => ({
      canvasRuntimeRefsModule: readContext().canvasRuntimeRefsModule,
      canvasGraphStateModule: readContext().canvasGraphStateModule,
      canvasSelectionStateModule: readContext().canvasSelectionStateModule,
      canvasGroupStateModule: readContext().canvasGroupStateModule,
      canvasImageEditorStateModule: readContext().canvasImageEditorStateModule,
      nodeMap: readContext().nodeMap,
      showNodeStatusChip:
        readContext().canvasGenerationActionBindings.showNodeStatusChip,
      buildStoryboardGroupNodes:
        readContext().canvasGraphActionBindings.buildStoryboardGroupNodes,
      buildStoryboardGroupData:
        readContext().canvasGraphActionBindings.buildStoryboardGroupData,
      persistCanvas: readContext().canvasProjectActionBindings.persistCanvas,
      canvasMeta: readContext().canvasMeta,
      assertCanvasOperationActive:
        readContext().canvasProjectActionBindings.assertCanvasOperationActive,
      uploadMediaFileToRemote:
        readContext().canvasGenerationActionBindings.uploadMediaFileToRemote,
      canvasPromptStateModule: readContext().canvasPromptStateModule,
      canvasVideoEditorStateModule: readContext().canvasVideoEditorStateModule,
      canvasGenerationDebugStateModule:
        readContext().canvasGenerationDebugStateModule,
    }));
  }
  return {
    artifactEditingController,
    canvasStoryboardVideoPromptView,
    videoToolsController,
    composeController,
    imageToolsController,
    videoStoryController,
    canvasMediaViewerActions,
    imageMenuController,
    imageGridController,
  };
}
