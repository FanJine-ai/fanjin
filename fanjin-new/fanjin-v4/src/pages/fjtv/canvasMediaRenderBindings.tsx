import { type AiModelOption, type CanvasComposeVideoAsset } from "@/lib/api";
import {
  clampVideoCropDraft,
  formatVideoClock,
} from "./canvasAssetPresentation";
import { renderComposeEditorExternal } from "./canvasComposeEditor";
import type {
  NodeData,
  VideoFrameExtractMode,
  VideoStoryAnalysis,
  VideoSubtitleEraseType,
} from "./canvasDataTypes";
import { buildGridCellKey, buildGridCellLabel } from "./canvasGridDefinitions";
import { renderImageCropOverlayExternal } from "./canvasImageCropOverlay";
import { renderImageEnhancePanelExternal } from "./canvasImageEnhancePanel";
import { renderImageGridSplitOverlayExternal } from "./canvasImageGridSplitOverlay";
import { renderImageGridSplitToolbarExternal } from "./canvasImageGridSplitToolbar";
import { renderImageOutpaintOverlayExternal } from "./canvasImageOutpaintOverlay";
import { renderImageTransformEditorExternal } from "./canvasImageTransformEditor";
import { renderInlineVideoControlsExternal } from "./canvasInlineVideoControls";
import { bindComposeController } from "./canvasMediaBindings";
import {
  aspectForImageRatioMode,
  buildImageCropDraftForRatio,
  buildImageOutpaintDraftForRatio,
  clampImageCropDraft,
  getImageOutpaintPreviewMetrics,
  normalizeImageRotation,
} from "./canvasMediaGeometry";
import {
  IMAGE_ENHANCE_FACTORS_PROFESSIONAL,
  IMAGE_ENHANCE_FACTORS_STANDARD,
  IMAGE_ENHANCE_MODEL_FALLBACK,
  IMAGE_OUTPAINT_RATIO_ITEMS,
  IMAGE_OUTPAINT_RESOLUTION_ITEMS,
  buildVideoEnhanceNodeTitle,
} from "./canvasMediaToolDefinitions";
import { patchLooksActivelyGenerating } from "./canvasTaskState";
import { renderVideoEnhancePanelExternal } from "./canvasVideoEnhancePanel";
import { renderVideoEraseRegionOverlayExternal } from "./canvasVideoEraseRegionOverlay";
import { renderVideoStoryFullscreenExternal } from "./canvasVideoStoryFullscreen";
import { renderVideoStoryPanelExternal } from "./canvasVideoStoryPanel";
import { CanvasVideoStoryTable } from "./CanvasVideoStoryTable";
import { renderVideoSubtitleEraseBarExternal } from "./canvasVideoSubtitleEraseBar";
import { renderVideoTrimEditorExternal } from "./canvasVideoTrimEditor";
import { resolveEnhanceModelLabel } from "./modelCatalog";
import { useCanvasComposeState } from "./useCanvasComposeState";
import { useCanvasComposeView } from "./useCanvasComposeView";
import { useCanvasImageEditorState } from "./useCanvasImageEditorState";
import { useCanvasPlaybackState } from "./useCanvasPlaybackState";
import { useCanvasVideoEditorState } from "./useCanvasVideoEditorState";
export function createCanvasMediaRenderBindings(context: {
  composeController: () => ReturnType<typeof bindComposeController>;
  updateVideoStoryCell: (
    nodeId: string,
    rowIndex: number,
    key: string,
    value: string,
  ) => void;
  canvasCapabilities: import("@/pages/fjtv/canvasCapabilities").CanvasRealCapabilities;
  cancelVideoStoryAnalysis: (node: NodeData) => Promise<void>;
  writeVideoStoryToStoryboard: (sourceNode: NodeData) => void;
  submitVideoStoryAnalysis: (
    sourceNode: NodeData,
    retryOfTaskId?: number,
  ) => Promise<void>;
  canvasMeta: import("@/pages/fjtv/canvasDataTypes").CanvasMetaState;
  pollVideoStoryAnalysis: (
    nodeId: string,
    projectId: number,
    taskId: number,
  ) => Promise<void>;
  nodeMap: Map<string, NodeData>;
  getCanvasToolbarScale: (multiplier?: number) => number;
  closeImageGridSplitEditor: () => void;
  createImageGridSplitGroup: () => Promise<void>;
  submitImageGridSplitAssets: () => Promise<void>;
  renderCompactSubmitButton: (
    key: string,
    action: () => Promise<void> | void,
    className?: string,
    iconClassName?: string,
    blocked?: boolean,
  ) => React.JSX.Element;
  submitImageEnhance: (node: NodeData) => Promise<void>;
  canvasImageEditorStateModule: ReturnType<typeof useCanvasImageEditorState>;
  submitImageOutpaint: (node: NodeData) => Promise<void>;
  submitImageCrop: (node: NodeData) => Promise<void>;
  saveImageTransform: (node: NodeData) => void;
  beginImageGridSplitDrag: (
    sourceNodeId: string,
    cellKey: string,
    rows: number,
    cols: number,
    clientX: number,
    clientY: number,
  ) => void;
  toggleImageGridSplitSelection: (cellKey: string, append?: boolean) => void;
  canvasVideoEditorStateModule: ReturnType<typeof useCanvasVideoEditorState>;
  closeVideoEditor: () => void;
  confirmVideoTrim: () => Promise<void>;
  submitVideoSubtitleErase: (
    sourceNode: NodeData,
    eraseType: VideoSubtitleEraseType,
  ) => Promise<void>;
  setNodePatch: (nodeId: string, patch: Partial<NodeData>) => void;
  submitVideoEnhance: (node: NodeData) => Promise<void>;
  canvasPlaybackStateModule: ReturnType<typeof useCanvasPlaybackState>;
  nodeHasSubmittingSession: (nodeId: string) => boolean;
  submitVideoFrameExtract: (
    sourceNode: NodeData,
    extractMode: VideoFrameExtractMode,
  ) => Promise<void>;
  canvasComposeStateModule: ReturnType<typeof useCanvasComposeState>;
  canvasComposeViewModule: ReturnType<typeof useCanvasComposeView>;
  exportComposeToLocal: () => Promise<void>;
  exportComposeToCanvas: () => Promise<void>;
  closeComposeEditor: () => void;
  jumpComposeToPreviousClip: () => void;
  jumpComposeToNextClip: () => void;
  splitComposeClip: () => void;
  trimComposeClipLeft: () => void;
  trimComposeClipRight: () => void;
  toggleComposeMuted: () => void;
  seekComposeTime: (nextTime: number) => void;
  setComposeClipSpeed: (nextSpeed: number) => void;
  setComposeClipDuration: (nextDuration: number) => void;
  selectComposeClip: (clipId: string) => void;
  canvasProjectStateModule: ReturnType<
    typeof import("./useCanvasProjectState").useCanvasProjectState
  >;
  canvasSelectionStateModule: ReturnType<
    typeof import("./useCanvasSelectionState").useCanvasSelectionState
  >;
  canvasInlineEditorViewModule: ReturnType<
    typeof import("./useCanvasInlineEditorView").useCanvasInlineEditorView
  >;
  canvasModelCatalogStateModule: ReturnType<
    typeof import("./useCanvasModelCatalogState").useCanvasModelCatalogState
  >;
  canvasRuntimeRefsModule: ReturnType<
    typeof import("./useCanvasRuntimeRefs").useCanvasRuntimeRefs
  >;
}) {
  async function renderComposeVideo(): Promise<CanvasComposeVideoAsset | null> {
    return context.composeController().renderComposeVideo();
  }

  function renderVideoStoryTable(
    analysis: VideoStoryAnalysis,
    fullscreen = false,
    nodeId?: string,
  ) {
    return (
      <CanvasVideoStoryTable
        analysis={analysis}
        fullscreen={fullscreen}
        nodeId={nodeId}
        updateVideoStoryCell={context.updateVideoStoryCell}
      />
    );
  }

  function renderVideoStoryPanel(node: NodeData) {
    return renderVideoStoryPanelExternal(
      {
        canvasCapabilities: context.canvasCapabilities,
        renderVideoStoryTable,
        cancelVideoStoryAnalysis: context.cancelVideoStoryAnalysis,
        writeVideoStoryToStoryboard: context.writeVideoStoryToStoryboard,
        setVideoStoryFullscreenNodeId:
          context.canvasVideoEditorStateModule.setVideoStoryFullscreenNodeId,
        submitVideoStoryAnalysis: context.submitVideoStoryAnalysis,
        currentProjectId: context.canvasProjectStateModule.currentProjectId,
        canvasMeta: context.canvasMeta,
        pollVideoStoryAnalysis: context.pollVideoStoryAnalysis,
      },
      node,
    );
  }

  function renderVideoStoryFullscreen() {
    return renderVideoStoryFullscreenExternal({
      videoStoryFullscreenNodeId:
        context.canvasVideoEditorStateModule.videoStoryFullscreenNodeId,
      nodeMap: context.nodeMap,
      setVideoStoryFullscreenNodeId:
        context.canvasVideoEditorStateModule.setVideoStoryFullscreenNodeId,
      writeVideoStoryToStoryboard: context.writeVideoStoryToStoryboard,
      renderVideoStoryTable,
    });
  }

  function renderImageGridSplitToolbar(node: NodeData) {
    return renderImageGridSplitToolbarExternal(
      {
        imageGridSplitEditor:
          context.canvasImageEditorStateModule.imageGridSplitEditor,
        getCanvasToolbarScale: context.getCanvasToolbarScale,
        closeImageGridSplitEditor: context.closeImageGridSplitEditor,
        createImageGridSplitGroup: context.createImageGridSplitGroup,
        submitImageGridSplitAssets: context.submitImageGridSplitAssets,
      },
      node,
    );
  }

  function renderImageEnhancePanel(node: NodeData) {
    return renderImageEnhancePanelExternal(
      {
        canvasCapabilities: context.canvasCapabilities,
        activeNodeId: context.canvasSelectionStateModule.activeNodeId,
        activeImageEnhance:
          context.canvasImageEditorStateModule.activeImageEnhance,
        controlsPos: context.canvasInlineEditorViewModule.controlsPos,
        IMAGE_ENHANCE_FACTORS_PROFESSIONAL,
        IMAGE_ENHANCE_FACTORS_STANDARD,
        resolveEnhanceModelLabel,
        models: context.canvasModelCatalogStateModule.models,
        IMAGE_ENHANCE_MODEL_FALLBACK,
        setActiveImageEnhance:
          context.canvasImageEditorStateModule.setActiveImageEnhance,
        renderCompactSubmitButton: context.renderCompactSubmitButton,
        submitImageEnhance: context.submitImageEnhance,
      },
      node,
    );
  }

  function renderImageOutpaintOverlay(node: NodeData) {
    return renderImageOutpaintOverlayExternal(
      {
        ...context.canvasImageEditorStateModule,
        canvasCapabilities: context.canvasCapabilities,
        getImageOutpaintPreviewMetrics,
        IMAGE_OUTPAINT_RATIO_ITEMS,
        buildImageOutpaintDraftForRatio,
        IMAGE_OUTPAINT_RESOLUTION_ITEMS,
        renderCompactSubmitButton: context.renderCompactSubmitButton,
        submitImageOutpaint: context.submitImageOutpaint,
      },
      node,
    );
  }

  function renderImageCropOverlay(node: NodeData) {
    return renderImageCropOverlayExternal(
      {
        ...context.canvasImageEditorStateModule,
        clampImageCropDraft,
        aspectForImageRatioMode,
        IMAGE_OUTPAINT_RATIO_ITEMS,
        buildImageCropDraftForRatio,
        submitImageCrop: context.submitImageCrop,
      },
      node,
    );
  }

  function renderImageTransformEditor(node: NodeData) {
    return renderImageTransformEditorExternal(
      {
        activeImageTransform:
          context.canvasImageEditorStateModule.activeImageTransform,
        setActiveImageTransform:
          context.canvasImageEditorStateModule.setActiveImageTransform,
        normalizeImageRotation,
        saveImageTransform: context.saveImageTransform,
      },
      node,
    );
  }

  function renderImageGridSplitOverlay(node: NodeData) {
    return renderImageGridSplitOverlayExternal(
      {
        imageGridSplitEditor:
          context.canvasImageEditorStateModule.imageGridSplitEditor,
        setImageGridSplitEditor:
          context.canvasImageEditorStateModule.setImageGridSplitEditor,
        buildGridCellKey,
        buildGridCellLabel,
        beginImageGridSplitDrag: context.beginImageGridSplitDrag,
        imageGridSplitSuppressClickRef:
          context.canvasRuntimeRefsModule.imageGridSplitSuppressClickRef,
        toggleImageGridSplitSelection: context.toggleImageGridSplitSelection,
      },
      node,
    );
  }

  function renderVideoTrimEditor(node: NodeData) {
    return renderVideoTrimEditorExternal(node, {
      ...context.canvasVideoEditorStateModule,
      videoNodeCurrentTimes:
        context.canvasPlaybackStateModule.videoNodeCurrentTimes,
      closeVideoEditor: context.closeVideoEditor,
      confirmVideoTrim: context.confirmVideoTrim,
    });
  }

  function renderVideoEraseRegionOverlay(node: NodeData) {
    return renderVideoEraseRegionOverlayExternal(node, {
      ...context.canvasVideoEditorStateModule,
      clampVideoCropDraft,
      closeVideoEditor: context.closeVideoEditor,
      renderCompactSubmitButton: context.renderCompactSubmitButton,
      submitVideoSubtitleErase: context.submitVideoSubtitleErase,
    });
  }

  function renderVideoSubtitleEraseBar(node: NodeData) {
    return renderVideoSubtitleEraseBarExternal(
      {
        canvasCapabilities: context.canvasCapabilities,
        activeVideoEditor:
          context.canvasVideoEditorStateModule.activeVideoEditor,
        closeVideoEditor: context.closeVideoEditor,
        renderCompactSubmitButton: context.renderCompactSubmitButton,
        submitVideoSubtitleErase: context.submitVideoSubtitleErase,
      },
      node,
    );
  }

  function renderVideoEnhancePanel(node: NodeData) {
    return renderVideoEnhancePanelExternal(
      {
        activeNodeId: context.canvasSelectionStateModule.activeNodeId,
        controlsPos: context.canvasInlineEditorViewModule.controlsPos,
        setVideoEnhanceResolutionOpen:
          context.canvasVideoEditorStateModule.setVideoEnhanceResolutionOpen,
        videoEnhanceResolutionOpen:
          context.canvasVideoEditorStateModule.videoEnhanceResolutionOpen,
        setNodePatch: context.setNodePatch,
        buildVideoEnhanceNodeTitle,
        renderCompactSubmitButton: context.renderCompactSubmitButton,
        submitVideoEnhance: context.submitVideoEnhance,
      },
      node,
    );
  }

  function renderInlineVideoControls(node: NodeData) {
    return renderInlineVideoControlsExternal(node, {
      ...context.canvasPlaybackStateModule,
      patchLooksActivelyGenerating,
      nodeHasSubmittingSession: context.nodeHasSubmittingSession,
      videoFrameMenuNodeId:
        context.canvasVideoEditorStateModule.videoFrameMenuNodeId,
      setNodePatch: context.setNodePatch,
      nodeVideoRefs: context.canvasRuntimeRefsModule.nodeVideoRefs,
      setVideoFrameMenuNodeId:
        context.canvasVideoEditorStateModule.setVideoFrameMenuNodeId,
      submitVideoFrameExtract: context.submitVideoFrameExtract,
      formatVideoClock,
    });
  }

  function renderComposeEditor() {
    return renderComposeEditorExternal({
      ...context.canvasComposeStateModule,
      ...context.canvasComposeViewModule,
      composePreviewRef: context.canvasRuntimeRefsModule.composePreviewRef,
      composeTimelineRef: context.canvasRuntimeRefsModule.composeTimelineRef,
      exportComposeToLocal: context.exportComposeToLocal,
      exportComposeToCanvas: context.exportComposeToCanvas,
      closeComposeEditor: context.closeComposeEditor,
      jumpComposeToPreviousClip: context.jumpComposeToPreviousClip,
      jumpComposeToNextClip: context.jumpComposeToNextClip,
      splitComposeClip: context.splitComposeClip,
      trimComposeClipLeft: context.trimComposeClipLeft,
      trimComposeClipRight: context.trimComposeClipRight,
      toggleComposeMuted: context.toggleComposeMuted,
      seekComposeTime: context.seekComposeTime,
      setComposeClipSpeed: context.setComposeClipSpeed,
      setComposeClipDuration: context.setComposeClipDuration,
      selectComposeClip: context.selectComposeClip,
    });
  }
  return {
    renderComposeVideo,
    renderVideoStoryTable,
    renderVideoStoryPanel,
    renderVideoStoryFullscreen,
    renderImageGridSplitToolbar,
    renderImageEnhancePanel,
    renderImageOutpaintOverlay,
    renderImageCropOverlay,
    renderImageTransformEditor,
    renderImageGridSplitOverlay,
    renderVideoTrimEditor,
    renderVideoEraseRegionOverlay,
    renderVideoSubtitleEraseBar,
    renderVideoEnhancePanel,
    renderInlineVideoControls,
    renderComposeEditor,
  };
}
