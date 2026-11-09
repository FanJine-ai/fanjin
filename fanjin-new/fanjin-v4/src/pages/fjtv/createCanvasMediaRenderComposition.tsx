import { createCanvasDeferredContext } from "./canvasDeferredContext";
import { createCanvasGenerationActionBindings } from "./canvasGenerationActionBindings";
import { createCanvasGraphActionBindings } from "./canvasGraphActionBindings";
import { createCanvasMediaActionBindings } from "./canvasMediaActionBindings";
import { createCanvasMediaRenderBindings } from "./canvasMediaRenderBindings";
import { createCanvasPromptRenderBindings } from "./canvasPromptRenderBindings";
import { useCanvasComposeState } from "./useCanvasComposeState";
import { useCanvasComposeView } from "./useCanvasComposeView";
import { useCanvasImageEditorState } from "./useCanvasImageEditorState";
import { useCanvasInlineEditorView } from "./useCanvasInlineEditorView";
import { useCanvasModelCatalogState } from "./useCanvasModelCatalogState";
import { useCanvasPlaybackState } from "./useCanvasPlaybackState";
import { useCanvasProjectState } from "./useCanvasProjectState";
import { useCanvasRuntimeRefs } from "./useCanvasRuntimeRefs";
import { useCanvasSelectionState } from "./useCanvasSelectionState";
import { useCanvasVideoEditorState } from "./useCanvasVideoEditorState";
export function createCanvasMediaRenderComposition(
  readContext: () => {
    composeController: ReturnType<
      typeof import("./canvasMediaControllers").createCanvasMediaControllers
    >["composeController"];
    canvasMediaActionBindings: ReturnType<
      typeof createCanvasMediaActionBindings
    >;
    canvasCapabilities: import("@/pages/fjtv/canvasCapabilities").CanvasRealCapabilities;
    canvasMeta: import("@/pages/fjtv/canvasDataTypes").CanvasMetaState;
    nodeMap: Map<string, import("@/pages/fjtv/canvasDataTypes").NodeData>;
    canvasGraphActionBindings: ReturnType<
      typeof createCanvasGraphActionBindings
    >;
    canvasPromptRenderBindings: ReturnType<
      typeof createCanvasPromptRenderBindings
    >;
    canvasImageEditorStateModule: ReturnType<typeof useCanvasImageEditorState>;
    canvasVideoEditorStateModule: ReturnType<typeof useCanvasVideoEditorState>;
    canvasPlaybackStateModule: ReturnType<typeof useCanvasPlaybackState>;
    canvasGenerationActionBindings: ReturnType<
      typeof createCanvasGenerationActionBindings
    >;
    canvasComposeStateModule: ReturnType<typeof useCanvasComposeState>;
    canvasComposeViewModule: ReturnType<typeof useCanvasComposeView>;
    canvasProjectStateModule: ReturnType<typeof useCanvasProjectState>;
    canvasSelectionStateModule: ReturnType<typeof useCanvasSelectionState>;
    canvasInlineEditorViewModule: ReturnType<typeof useCanvasInlineEditorView>;
    canvasModelCatalogStateModule: ReturnType<
      typeof useCanvasModelCatalogState
    >;
    canvasRuntimeRefsModule: ReturnType<typeof useCanvasRuntimeRefs>;
  },
) {
  return createCanvasMediaRenderBindings(
    createCanvasDeferredContext({
      composeController: () => readContext().composeController,
      updateVideoStoryCell: () =>
        readContext().canvasMediaActionBindings.updateVideoStoryCell,
      canvasCapabilities: () => readContext().canvasCapabilities,
      cancelVideoStoryAnalysis: () =>
        readContext().canvasMediaActionBindings.cancelVideoStoryAnalysis,
      writeVideoStoryToStoryboard: () =>
        readContext().canvasMediaActionBindings.writeVideoStoryToStoryboard,
      submitVideoStoryAnalysis: () =>
        readContext().canvasMediaActionBindings.submitVideoStoryAnalysis,
      canvasMeta: () => readContext().canvasMeta,
      pollVideoStoryAnalysis: () =>
        readContext().canvasMediaActionBindings.pollVideoStoryAnalysis,
      nodeMap: () => readContext().nodeMap,
      getCanvasToolbarScale: () =>
        readContext().canvasGraphActionBindings.getCanvasToolbarScale,
      closeImageGridSplitEditor: () =>
        readContext().canvasMediaActionBindings.closeImageGridSplitEditor,
      createImageGridSplitGroup: () =>
        readContext().canvasMediaActionBindings.createImageGridSplitGroup,
      submitImageGridSplitAssets: () =>
        readContext().canvasMediaActionBindings.submitImageGridSplitAssets,
      renderCompactSubmitButton: () =>
        readContext().canvasPromptRenderBindings.renderCompactSubmitButton,
      submitImageEnhance: () =>
        readContext().canvasMediaActionBindings.submitImageEnhance,
      canvasImageEditorStateModule: () =>
        readContext().canvasImageEditorStateModule,
      submitImageOutpaint: () =>
        readContext().canvasMediaActionBindings.submitImageOutpaint,
      submitImageCrop: () =>
        readContext().canvasMediaActionBindings.submitImageCrop,
      saveImageTransform: () =>
        readContext().canvasMediaActionBindings.saveImageTransform,
      beginImageGridSplitDrag: () =>
        readContext().canvasMediaActionBindings.beginImageGridSplitDrag,
      toggleImageGridSplitSelection: () =>
        readContext().canvasMediaActionBindings.toggleImageGridSplitSelection,
      canvasVideoEditorStateModule: () =>
        readContext().canvasVideoEditorStateModule,
      closeVideoEditor: () =>
        readContext().canvasMediaActionBindings.closeVideoEditor,
      confirmVideoTrim: () =>
        readContext().canvasMediaActionBindings.confirmVideoTrim,
      submitVideoSubtitleErase: () =>
        readContext().canvasMediaActionBindings.submitVideoSubtitleErase,
      setNodePatch: () => readContext().canvasGraphActionBindings.setNodePatch,
      submitVideoEnhance: () =>
        readContext().canvasMediaActionBindings.submitVideoEnhance,
      canvasPlaybackStateModule: () => readContext().canvasPlaybackStateModule,
      nodeHasSubmittingSession: () =>
        readContext().canvasGenerationActionBindings.nodeHasSubmittingSession,
      submitVideoFrameExtract: () =>
        readContext().canvasMediaActionBindings.submitVideoFrameExtract,
      canvasComposeStateModule: () => readContext().canvasComposeStateModule,
      canvasComposeViewModule: () => readContext().canvasComposeViewModule,
      exportComposeToLocal: () =>
        readContext().canvasMediaActionBindings.exportComposeToLocal,
      exportComposeToCanvas: () =>
        readContext().canvasMediaActionBindings.exportComposeToCanvas,
      closeComposeEditor: () =>
        readContext().canvasMediaActionBindings.closeComposeEditor,
      jumpComposeToPreviousClip: () =>
        readContext().canvasMediaActionBindings.jumpComposeToPreviousClip,
      jumpComposeToNextClip: () =>
        readContext().canvasMediaActionBindings.jumpComposeToNextClip,
      splitComposeClip: () =>
        readContext().canvasMediaActionBindings.splitComposeClip,
      trimComposeClipLeft: () =>
        readContext().canvasMediaActionBindings.trimComposeClipLeft,
      trimComposeClipRight: () =>
        readContext().canvasMediaActionBindings.trimComposeClipRight,
      toggleComposeMuted: () =>
        readContext().canvasMediaActionBindings.toggleComposeMuted,
      seekComposeTime: () =>
        readContext().canvasMediaActionBindings.seekComposeTime,
      setComposeClipSpeed: () =>
        readContext().canvasMediaActionBindings.setComposeClipSpeed,
      setComposeClipDuration: () =>
        readContext().canvasMediaActionBindings.setComposeClipDuration,
      selectComposeClip: () =>
        readContext().canvasMediaActionBindings.selectComposeClip,
      canvasProjectStateModule: () => readContext().canvasProjectStateModule,
      canvasSelectionStateModule: () =>
        readContext().canvasSelectionStateModule,
      canvasInlineEditorViewModule: () =>
        readContext().canvasInlineEditorViewModule,
      canvasModelCatalogStateModule: () =>
        readContext().canvasModelCatalogStateModule,
      canvasRuntimeRefsModule: () => readContext().canvasRuntimeRefsModule,
    }),
  );
}
