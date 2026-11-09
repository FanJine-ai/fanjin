import { createCanvasDeferredContext } from "./canvasDeferredContext";
import { createCanvasGenerationActionBindings } from "./canvasGenerationActionBindings";
import { createCanvasGraphActionBindings } from "./canvasGraphActionBindings";
import { createCanvasMediaActionBindings } from "./canvasMediaActionBindings";
import { createCanvasNodeRenderBindings } from "./canvasNodeRenderBindings";
import { createCanvasProjectActionBindings } from "./canvasProjectActionBindings";
import { useCanvasAssetPanelState } from "./useCanvasAssetPanelState";
import { useCanvasGraphState } from "./useCanvasGraphState";
import { useCanvasGroupState } from "./useCanvasGroupState";
import { useCanvasImageEditorState } from "./useCanvasImageEditorState";
import { useCanvasPlaybackState } from "./useCanvasPlaybackState";
import { useCanvasProjectState } from "./useCanvasProjectState";
import { useCanvasPromptState } from "./useCanvasPromptState";
import { useCanvasRuntimeRefs } from "./useCanvasRuntimeRefs";
import { useCanvasSelectionState } from "./useCanvasSelectionState";
import { useCanvasStoryboardState } from "./useCanvasStoryboardState";
import { useCanvasTitleEditorState } from "./useCanvasTitleEditorState";
import { useCanvasVideoEditorState } from "./useCanvasVideoEditorState";
export function createCanvasNodeRenderComposition(
  readContext: () => {
    canvasGenerationActionBindings: ReturnType<
      typeof createCanvasGenerationActionBindings
    >;
    canvasGraphActionBindings: ReturnType<
      typeof createCanvasGraphActionBindings
    >;
    canvasMediaActionBindings: ReturnType<
      typeof createCanvasMediaActionBindings
    >;
    productScriptView: ReturnType<
      typeof import("./canvasGraphControllers").createCanvasGraphControllers
    >["productScriptView"];
    canvasAssetPanelStateModule: ReturnType<typeof useCanvasAssetPanelState>;
    canvasImageEditorStateModule: ReturnType<typeof useCanvasImageEditorState>;
    canvasCapabilities: import("@/pages/fjtv/canvasCapabilities").CanvasRealCapabilities;
    canvasRuntimeRefsModule: ReturnType<typeof useCanvasRuntimeRefs>;
    canvasPlaybackStateModule: ReturnType<typeof useCanvasPlaybackState>;
    canvasTitleEditorStateModule: ReturnType<typeof useCanvasTitleEditorState>;
    textNodeBackground: (
      node: import("@/pages/fjtv/canvasDataTypes").NodeData,
    ) => string;
    textNodeFontSize: (
      node: import("@/pages/fjtv/canvasDataTypes").NodeData,
    ) => number;
    textNodeLineHeight: (
      node: import("@/pages/fjtv/canvasDataTypes").NodeData,
    ) => 1.38 | 1.28 | 1.35 | 1.5;
    commitTextNodeEditing: () => void;
    startTextNodeEditing: (
      node: import("@/pages/fjtv/canvasDataTypes").NodeData,
    ) => void;
    canvasProjectActionBindings: ReturnType<
      typeof createCanvasProjectActionBindings
    >;
    nodeMap: Map<string, import("@/pages/fjtv/canvasDataTypes").NodeData>;
    canvasColorMode: import("@/ui/theme").ThemeMode;
    renderNodeTryIcon: (
      kind: import("@/pages/fjtv/canvasNodeTryIconRenderer").CanvasTryIconKind,
    ) => React.JSX.Element;
    setTextNodePatchAndPersist: (
      nodeId: string,
      patch: Partial<import("@/pages/fjtv/canvasDataTypes").NodeData>,
    ) => void;
    applyTextListStyleToValue: (
      value: string,
      style: import("@/pages/fjtv/canvasDataTypes").TextNodeListStyle,
    ) => string;
    updateTextNodeContentAndStyle: (
      nodeId: string,
      outputText: string,
      patch?: Partial<import("@/pages/fjtv/canvasDataTypes").NodeData>,
    ) => void;
    toggleTextNodeExpanded: (
      node: import("@/pages/fjtv/canvasDataTypes").NodeData,
    ) => void;
    downloadTextNodeAsTxt: (
      node: import("@/pages/fjtv/canvasDataTypes").NodeData,
    ) => void;
    canvasProjectStateModule: ReturnType<typeof useCanvasProjectState>;
    canvasGraphStateModule: ReturnType<typeof useCanvasGraphState>;
    canvasPromptStateModule: ReturnType<typeof useCanvasPromptState>;
    canvasSelectionStateModule: ReturnType<typeof useCanvasSelectionState>;
    canvasVideoEditorStateModule: ReturnType<typeof useCanvasVideoEditorState>;
    canvasGroupStateModule: ReturnType<typeof useCanvasGroupState>;
    canvasStoryboardStateModule: ReturnType<typeof useCanvasStoryboardState>;
  },
) {
  return createCanvasNodeRenderBindings(
    createCanvasDeferredContext({
      nodeUploadIsActive: () =>
        readContext().canvasGenerationActionBindings.nodeUploadIsActive,
      nodeHasSubmittingSession: () =>
        readContext().canvasGenerationActionBindings.nodeHasSubmittingSession,
      requestCancelNodeGeneration: () =>
        readContext().canvasGenerationActionBindings
          .requestCancelNodeGeneration,
      setNodePatch: () => readContext().canvasGraphActionBindings.setNodePatch,
      generateCanvasTextNode: () =>
        readContext().canvasGenerationActionBindings.generateCanvasTextNode,
      getCanvasArtifactImages: () =>
        readContext().canvasMediaActionBindings.getCanvasArtifactImages,
      editCanvasArtifact: () =>
        readContext().canvasMediaActionBindings.editCanvasArtifact,
      productScriptView: () => readContext().productScriptView,
      canvasAssetPanelStateModule: () =>
        readContext().canvasAssetPanelStateModule,
      focusNodeInViewport: () =>
        readContext().canvasGraphActionBindings.focusNodeInViewport,
      commitSidebarRename: () =>
        readContext().canvasGraphActionBindings.commitSidebarRename,
      cancelSidebarRename: () =>
        readContext().canvasGraphActionBindings.cancelSidebarRename,
      startSidebarRename: () =>
        readContext().canvasGraphActionBindings.startSidebarRename,
      duplicateNodeFromManager: () =>
        readContext().canvasGraphActionBindings.duplicateNodeFromManager,
      canvasImageEditorStateModule: () =>
        readContext().canvasImageEditorStateModule,
      getCanvasToolbarTop: () =>
        readContext().canvasGraphActionBindings.getCanvasToolbarTop,
      getCanvasToolbarScale: () =>
        readContext().canvasGraphActionBindings.getCanvasToolbarScale,
      handleNineGridMenuAction: () =>
        readContext().canvasMediaActionBindings.handleNineGridMenuAction,
      handleImageHdMenuAction: () =>
        readContext().canvasMediaActionBindings.handleImageHdMenuAction,
      openImageGridSplitEditor: () =>
        readContext().canvasMediaActionBindings.openImageGridSplitEditor,
      handleImageTransformMenuAction: () =>
        readContext().canvasMediaActionBindings.handleImageTransformMenuAction,
      downloadNodeMedia: () =>
        readContext().canvasGraphActionBindings.downloadNodeMedia,
      openMediaViewer: () =>
        readContext().canvasMediaActionBindings.openMediaViewer,
      createDraftFinalNode: () =>
        readContext().canvasGraphActionBindings.createDraftFinalNode,
      canvasCapabilities: () => readContext().canvasCapabilities,
      submitVideoClipRewrite: () =>
        readContext().canvasMediaActionBindings.submitVideoClipRewrite,
      showVideoRewriteVersion: () =>
        readContext().canvasMediaActionBindings.showVideoRewriteVersion,
      restoreVideoRewriteSource: () =>
        readContext().canvasMediaActionBindings.restoreVideoRewriteSource,
      submitVideoStoryAnalysis: () =>
        readContext().canvasMediaActionBindings.submitVideoStoryAnalysis,
      openVideoEnhanceEditor: () =>
        readContext().canvasMediaActionBindings.openVideoEnhanceEditor,
      getNodeVideoPosterUrl: () =>
        readContext().canvasGraphActionBindings.getNodeVideoPosterUrl,
      canvasRuntimeRefsModule: () => readContext().canvasRuntimeRefsModule,
      canvasPlaybackStateModule: () => readContext().canvasPlaybackStateModule,
      canvasTitleEditorStateModule: () =>
        readContext().canvasTitleEditorStateModule,
      textNodeBackground: () => readContext().textNodeBackground,
      textNodeFontSize: () => readContext().textNodeFontSize,
      textNodeLineHeight: () => readContext().textNodeLineHeight,
      commitTextNodeEditing: () => readContext().commitTextNodeEditing,
      deleteCanvasArtifact: () =>
        readContext().canvasMediaActionBindings.deleteCanvasArtifact,
      createImageFromCanvasArtifact: () =>
        readContext().canvasMediaActionBindings.createImageFromCanvasArtifact,
      startTextNodeEditing: () => readContext().startTextNodeEditing,
      createTextVideoPresetGroup: () =>
        readContext().canvasGraphActionBindings.createTextVideoPresetGroup,
      toggleAudioNodePlayback: () =>
        readContext().canvasGraphActionBindings.toggleAudioNodePlayback,
      isEphemeralLocalUrl: () =>
        readContext().canvasProjectActionBindings.isEphemeralLocalUrl,
      nodeMap: () => readContext().nodeMap,
      openComposeEditor: () =>
        readContext().canvasMediaActionBindings.openComposeEditor,
      submitDraftFinalNode: () =>
        readContext().canvasGraphActionBindings.submitDraftFinalNode,
      canvasColorMode: () => readContext().canvasColorMode,
      createVideoFramePresetGroup: () =>
        readContext().canvasGraphActionBindings.createVideoFramePresetGroup,
      renderNodeTryIcon: () => readContext().renderNodeTryIcon,
      setTextNodePatchAndPersist: () =>
        readContext().setTextNodePatchAndPersist,
      applyTextListStyleToValue: () => readContext().applyTextListStyleToValue,
      updateTextNodeContentAndStyle: () =>
        readContext().updateTextNodeContentAndStyle,
      toggleTextNodeExpanded: () => readContext().toggleTextNodeExpanded,
      downloadTextNodeAsTxt: () => readContext().downloadTextNodeAsTxt,
      retryNodeUpload: () =>
        readContext().canvasGenerationActionBindings.retryNodeUpload,
      cancelNodeTransferOrGeneration: () =>
        readContext().canvasGenerationActionBindings
          .cancelNodeTransferOrGeneration,
      canvasProjectStateModule: () => readContext().canvasProjectStateModule,
      canvasGraphStateModule: () => readContext().canvasGraphStateModule,
      canvasPromptStateModule: () => readContext().canvasPromptStateModule,
      canvasSelectionStateModule: () =>
        readContext().canvasSelectionStateModule,
      canvasVideoEditorStateModule: () =>
        readContext().canvasVideoEditorStateModule,
      canvasGroupStateModule: () => readContext().canvasGroupStateModule,
      canvasStoryboardStateModule: () =>
        readContext().canvasStoryboardStateModule,
    }),
  );
}
