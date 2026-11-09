import ReferencePreviewImage from "@/features/quick-create/attachments/ReferencePreviewImage";
import {
  Circle,
  Columns3,
  Copy,
  Download,
  Expand,
  Minus,
  Rows3,
  Type,
} from "lucide-react";
import { renderCanvasArtifactSourcePickerExternal } from "./canvasArtifactSourcePicker";
import {
  getCanvasImagePreviewUrl,
  getNodeImageDisplayUrl,
  getNodeTextContent,
} from "./canvasAssetPresentation";
import type {
  EdgeData,
  NodeData,
  ProductScriptWorkflow,
} from "./canvasDataTypes";
import { bindProductScriptView } from "./canvasGraphBindings";
import { renderNineGridMenuIcon } from "./canvasGridDefinitions";
import { renderLightweightMediaNode as renderLightweightMediaNodeExternal } from "./canvasLightweightMediaNode";
import {
  IMAGE_HD_MENU_ITEMS,
  IMAGE_NINE_GRID_MENU_ITEMS,
  IMAGE_TRANSFORM_MENU_ITEMS,
} from "./canvasMediaMenuConfig";
import { renderNodeEditorPositionToggle as renderNodeEditorPositionToggleExternal } from "./canvasNodeEditorPositionToggle";
import { createCanvasNodeMediaToolbar } from "./canvasNodeMediaToolbar";
import { createCanvasNodePlaceholder } from "./canvasNodePlaceholder";
import { renderCanvasNodeProgressChip } from "./canvasNodeProgressRenderer";
import { renderCanvasNodeGlyph } from "./canvasNodeRenderHelpers";
import { renderNodeUploadOverlay as renderNodeUploadOverlayExternal } from "./canvasNodeUploadOverlay";
import {
  TEXT_BACKGROUND_SWATCHES,
  TEXT_TRY_ACTIONS,
  VIDEO_TRY_ACTIONS,
} from "./canvasPageConstants";
import { renderRichTextNodeEditorToolbarExternal } from "./canvasRichTextNodeEditorToolbar";
import { createCanvasSidebarRenderer } from "./canvasSidebarNodeItem";
import { patchLooksActivelyGenerating } from "./canvasTaskState";
import {
  CanvasArtifactSourcePicker,
  CanvasArtifactToolbar,
} from "./CanvasTextArtifactPanel";
import {
  allArtifactCards,
  type CanvasArtifactCard,
  type CanvasArtifactKind,
} from "./canvasTextArtifacts";
import { renderTextDownloadButton } from "./canvasTextDownloadButton";
import { renderTextNodeEditorToolbarExternal } from "./canvasTextNodeEditorToolbar";
import { useCanvasAssetPanelState } from "./useCanvasAssetPanelState";
import { useCanvasImageEditorState } from "./useCanvasImageEditorState";
import { useCanvasPlaybackState } from "./useCanvasPlaybackState";
import { useCanvasRuntimeRefs } from "./useCanvasRuntimeRefs";
import { useCanvasTitleEditorState } from "./useCanvasTitleEditorState";
export function createCanvasNodeRenderBindings(context: {
  nodeUploadIsActive: (node: NodeData) => boolean;
  nodeHasSubmittingSession: (nodeId: string) => boolean;
  requestCancelNodeGeneration: (nodeId: string) => void;
  setNodePatch: (nodeId: string, patch: Partial<NodeData>) => void;
  generateCanvasTextNode: (
    node: NodeData,
    operation?: CanvasArtifactKind,
    newAttempt?: boolean,
  ) => Promise<boolean>;
  getCanvasArtifactImages: () => {
    nodeId: string;
    title: string;
    assetVersionId: number;
    imageUrl: string;
    referenceAssetUri: string | undefined;
  }[];
  editCanvasArtifact: (
    nodeId: string,
    kind: CanvasArtifactKind,
    cardId: string,
    patch: Partial<CanvasArtifactCard>,
  ) => void;
  productScriptView: () => ReturnType<typeof bindProductScriptView>;
  canvasAssetPanelStateModule: ReturnType<typeof useCanvasAssetPanelState>;
  focusNodeInViewport: (nodeId: string) => void;
  commitSidebarRename: (nodeId: string, fallbackTitle: string) => Promise<void>;
  cancelSidebarRename: () => void;
  startSidebarRename: (node: NodeData) => void;
  duplicateNodeFromManager: (nodeId: string) => Promise<void>;
  canvasImageEditorStateModule: ReturnType<typeof useCanvasImageEditorState>;
  getCanvasToolbarTop: (targetTop: number, visualOffset?: number) => number;
  getCanvasToolbarScale: (multiplier?: number) => number;
  handleNineGridMenuAction: (
    node: NodeData,
    item: (typeof IMAGE_NINE_GRID_MENU_ITEMS)[number],
  ) => void;
  handleImageHdMenuAction: (
    node: NodeData,
    item: (typeof IMAGE_HD_MENU_ITEMS)[number],
  ) => void;
  openImageGridSplitEditor: (
    node: NodeData,
    rows: number,
    cols: number,
  ) => void;
  handleImageTransformMenuAction: (
    node: NodeData,
    item: (typeof IMAGE_TRANSFORM_MENU_ITEMS)[number],
  ) => void;
  downloadNodeMedia: (node: NodeData) => Promise<void>;
  openMediaViewer: (node: NodeData | null | undefined) => void;
  createDraftFinalNode: (source: NodeData) => void;
  canvasCapabilities: import("@/pages/fjtv/canvasCapabilities").CanvasRealCapabilities;
  submitVideoClipRewrite: (node: NodeData) => Promise<boolean>;
  showVideoRewriteVersion: (
    node: NodeData,
    viewing: "source" | "output",
  ) => void;
  restoreVideoRewriteSource: (node: NodeData) => void;
  submitVideoStoryAnalysis: (
    sourceNode: NodeData,
    retryOfTaskId?: number,
  ) => Promise<void>;
  openVideoEnhanceEditor: (node: NodeData) => Promise<void>;
  getNodeVideoPosterUrl: (node: NodeData) => string;
  canvasRuntimeRefsModule: ReturnType<typeof useCanvasRuntimeRefs>;
  canvasPlaybackStateModule: ReturnType<typeof useCanvasPlaybackState>;
  canvasTitleEditorStateModule: ReturnType<typeof useCanvasTitleEditorState>;
  textNodeBackground: (node: NodeData) => string;
  textNodeFontSize: (node: NodeData) => number;
  textNodeLineHeight: (node: NodeData) => 1.38 | 1.28 | 1.35 | 1.5;
  commitTextNodeEditing: () => void;
  deleteCanvasArtifact: (
    nodeId: string,
    kind: CanvasArtifactKind,
    cardId: string,
  ) => void;
  createImageFromCanvasArtifact: (sourceNodeId: string, cardId: string) => void;
  startTextNodeEditing: (node: NodeData) => void;
  createTextVideoPresetGroup: (sourceNodeId: string) => void;
  toggleAudioNodePlayback: (nodeId: string) => void;
  isEphemeralLocalUrl: (value: string | undefined | null) => boolean;
  nodeMap: Map<string, NodeData>;
  openComposeEditor: (nodeId: string) => Promise<void>;
  submitDraftFinalNode: (node: NodeData) => Promise<boolean>;
  canvasColorMode: import("@/ui/theme").ThemeMode;
  createVideoFramePresetGroup: (
    sourceNodeId: string,
    mode: "first" | "firstLast",
  ) => void;
  renderNodeTryIcon: (
    kind: import("@/pages/fjtv/canvasNodeTryIconRenderer").CanvasTryIconKind,
  ) => React.JSX.Element;
  setTextNodePatchAndPersist: (
    nodeId: string,
    patch: Partial<NodeData>,
  ) => void;
  applyTextListStyleToValue: (
    value: string,
    style: import("@/pages/fjtv/canvasDataTypes").TextNodeListStyle,
  ) => string;
  updateTextNodeContentAndStyle: (
    nodeId: string,
    outputText: string,
    patch?: Partial<NodeData>,
  ) => void;
  toggleTextNodeExpanded: (node: NodeData) => void;
  downloadTextNodeAsTxt: (node: NodeData) => void;
  retryNodeUpload: (nodeId: string) => Promise<void>;
  cancelNodeTransferOrGeneration: (nodeId: string) => Promise<boolean>;
  canvasProjectStateModule: ReturnType<
    typeof import("./useCanvasProjectState").useCanvasProjectState
  >;
  canvasGraphStateModule: ReturnType<
    typeof import("./useCanvasGraphState").useCanvasGraphState
  >;
  canvasPromptStateModule: ReturnType<
    typeof import("./useCanvasPromptState").useCanvasPromptState
  >;
  canvasSelectionStateModule: ReturnType<
    typeof import("./useCanvasSelectionState").useCanvasSelectionState
  >;
  canvasVideoEditorStateModule: ReturnType<
    typeof import("./useCanvasVideoEditorState").useCanvasVideoEditorState
  >;
  canvasGroupStateModule: ReturnType<
    typeof import("./useCanvasGroupState").useCanvasGroupState
  >;
  canvasStoryboardStateModule: ReturnType<
    typeof import("./useCanvasStoryboardState").useCanvasStoryboardState
  >;
}) {
  function renderNodeProgressChip(node: NodeData) {
    return renderCanvasNodeProgressChip({
      node,
      nodeUploadIsActive: context.nodeUploadIsActive,
      nodeHasSubmittingSession: context.nodeHasSubmittingSession,
      cancelOpen:
        context.canvasProjectStateModule.cancelGenerationConfirmNodeId ===
        node.id,
      onCancel: () => context.requestCancelNodeGeneration(node.id),
    });
  }

  function renderCanvasArtifactToolbar(node: NodeData) {
    return (
      <CanvasArtifactToolbar
        disabled={patchLooksActivelyGenerating(node)}
        hasText={Boolean(getNodeTextContent(node).trim())}
        instruction={node.textArtifactInstruction || ""}
        pending={
          !patchLooksActivelyGenerating(node) &&
          Boolean(node.textGenerationAttemptId || node.textRequestAttempt)
        }
        onInstruction={(textArtifactInstruction) =>
          context.setNodePatch(node.id, { textArtifactInstruction })
        }
        onGenerate={(operation) => {
          void context.generateCanvasTextNode(node, operation);
        }}
        onRetry={() => {
          void context.generateCanvasTextNode(node);
        }}
        onRestart={
          node.textRequestAttempt?.payload.operation
            ? () => {
                void context.generateCanvasTextNode(
                  node,
                  node.textRequestAttempt?.payload.operation,
                  true,
                );
              }
            : undefined
        }
      />
    );
  }

  function renderCanvasArtifactSourcePicker(node: NodeData) {
    return renderCanvasArtifactSourcePickerExternal(
      {
        edges: context.canvasGraphStateModule.edges,
        nodesRef: context.canvasGraphStateModule.nodesRef,
        getCanvasArtifactImages: context.getCanvasArtifactImages,
        allArtifactCards,
        patchLooksActivelyGenerating,
        CanvasArtifactSourcePicker,
        editCanvasArtifact: context.editCanvasArtifact,
        setNodePatch: context.setNodePatch,
        setStatus: context.canvasPromptStateModule.setStatus,
      },
      node,
    );
  }

  function renderProductScriptProgressChip(
    workflow: ProductScriptWorkflow,
    label?: string,
  ) {
    return context
      .productScriptView()
      .renderProductScriptProgressChip(workflow, label);
  }

  function renderProductScriptSkeleton(
    workflow: ProductScriptWorkflow,
    compact = false,
  ) {
    return context
      .productScriptView()
      .renderProductScriptSkeleton(workflow, compact);
  }

  function renderProductScriptMiniSteps(workflow: ProductScriptWorkflow) {
    return context.productScriptView().renderProductScriptMiniSteps(workflow);
  }

  function renderProductScriptNode(node: NodeData) {
    return context.productScriptView().renderProductScriptNode(node);
  }

  function renderEditableProductViralTable(
    node: NodeData,
    workflow: ProductScriptWorkflow,
  ) {
    return context
      .productScriptView()
      .renderEditableProductViralTable(node, workflow);
  }

  function renderProductAssetsEditor(
    node: NodeData,
    workflow: ProductScriptWorkflow,
  ) {
    return context
      .productScriptView()
      .renderProductAssetsEditor(node, workflow);
  }

  function renderProductStoryboardEditor(
    node: NodeData,
    workflow: ProductScriptWorkflow,
  ) {
    return context
      .productScriptView()
      .renderProductStoryboardEditor(node, workflow);
  }

  function renderProductScriptFullscreen() {
    return context.productScriptView().renderProductScriptFullscreen();
  }

  function renderCanvasSidebarNodeItem(node: NodeData, nested = false) {
    return createCanvasSidebarRenderer({
      ...context.canvasAssetPanelStateModule,
      activeNodeId: context.canvasSelectionStateModule.activeNodeId,
      focusNodeInViewport: context.focusNodeInViewport,
      commitSidebarRename: context.commitSidebarRename,
      cancelSidebarRename: context.cancelSidebarRename,
      startSidebarRename: context.startSidebarRename,
      duplicateNodeFromManager: context.duplicateNodeFromManager,
    })(node, nested);
  }

  function renderNodeMediaToolbar(node: NodeData) {
    return createCanvasNodeMediaToolbar({
      ...context.canvasImageEditorStateModule,
      getCanvasToolbarTop: context.getCanvasToolbarTop,
      getCanvasToolbarScale: context.getCanvasToolbarScale,
      setVideoEnhanceResolutionOpen:
        context.canvasVideoEditorStateModule.setVideoEnhanceResolutionOpen,
      handleNineGridMenuAction: context.handleNineGridMenuAction,
      renderNineGridMenuIcon,
      handleImageHdMenuAction: context.handleImageHdMenuAction,
      openImageGridSplitEditor: context.openImageGridSplitEditor,
      handleImageTransformMenuAction: context.handleImageTransformMenuAction,
      setActiveNodeId: context.canvasSelectionStateModule.setActiveNodeId,
      fileInputRef: context.canvasRuntimeRefsModule.fileInputRef,
      downloadNodeMedia: context.downloadNodeMedia,
      openMediaViewer: context.openMediaViewer,
      createDraftFinalNode: context.createDraftFinalNode,
      canvasCapabilities: context.canvasCapabilities,
      submitVideoClipRewrite: context.submitVideoClipRewrite,
      showVideoRewriteVersion: context.showVideoRewriteVersion,
      restoreVideoRewriteSource: context.restoreVideoRewriteSource,
      submitVideoStoryAnalysis: context.submitVideoStoryAnalysis,
      openVideoEnhanceEditor: context.openVideoEnhanceEditor,
    })(node);
  }

  function renderLightweightMediaNode(node: NodeData, previewSide: number) {
    return renderLightweightMediaNodeExternal(node, previewSide, {
      getNodeImageDisplayUrl,
      getNodeVideoPosterUrl: context.getNodeVideoPosterUrl,
      getCanvasImagePreviewUrl,
      ReferencePreviewImage,
      renderCanvasNodeGlyph,
    });
  }

  function renderNodePlaceholder(node: NodeData) {
    return createCanvasNodePlaceholder({
      ...context.canvasRuntimeRefsModule,
      ...context.canvasPlaybackStateModule,
      ...context.canvasTitleEditorStateModule,
      edges: context.canvasGraphStateModule.edges,
      setSelectedNodeIds: context.canvasSelectionStateModule.setSelectedNodeIds,
      setActiveGroupId: context.canvasGroupStateModule.setActiveGroupId,
      setActiveNodeId: context.canvasSelectionStateModule.setActiveNodeId,
      setStatus: context.canvasPromptStateModule.setStatus,
      setStoryboardSlotMenuPosition:
        context.canvasStoryboardStateModule.setStoryboardSlotMenuPosition,
      setStoryboardSlotMenuNodeId:
        context.canvasStoryboardStateModule.setStoryboardSlotMenuNodeId,
      renderCanvasNodeGlyph,
      textNodeBackground: context.textNodeBackground,
      textNodeFontSize: context.textNodeFontSize,
      textNodeLineHeight: context.textNodeLineHeight,
      commitTextNodeEditing: context.commitTextNodeEditing,
      setNodePatch: context.setNodePatch,
      getCanvasArtifactImages: context.getCanvasArtifactImages,
      editCanvasArtifact: context.editCanvasArtifact,
      deleteCanvasArtifact: context.deleteCanvasArtifact,
      createImageFromCanvasArtifact: context.createImageFromCanvasArtifact,
      TEXT_TRY_ACTIONS,
      startTextNodeEditing: context.startTextNodeEditing,
      createTextVideoPresetGroup: context.createTextVideoPresetGroup,
      cancelGenerationConfirmNodeId:
        context.canvasProjectStateModule.cancelGenerationConfirmNodeId,
      requestCancelNodeGeneration: context.requestCancelNodeGeneration,
      toggleAudioNodePlayback: context.toggleAudioNodePlayback,
      isEphemeralLocalUrl: context.isEphemeralLocalUrl,
      nodeMap: context.nodeMap,
      openComposeEditor: context.openComposeEditor,
      nodeHasSubmittingSession: context.nodeHasSubmittingSession,
      submitDraftFinalNode: context.submitDraftFinalNode,
      canvasColorMode: context.canvasColorMode,
      VIDEO_TRY_ACTIONS,
      createVideoFramePresetGroup: context.createVideoFramePresetGroup,
      renderNodeTryIcon: context.renderNodeTryIcon,
    })(node);
  }

  function renderRichTextNodeEditorToolbar(node: NodeData) {
    return renderRichTextNodeEditorToolbarExternal(node, {
      ...context.canvasTitleEditorStateModule,
      TEXT_BACKGROUND_SWATCHES,
      setTextNodePatchAndPersist: context.setTextNodePatchAndPersist,
      applyTextListStyleToValue: context.applyTextListStyleToValue,
      updateTextNodeContentAndStyle: context.updateTextNodeContentAndStyle,
      setStatus: context.canvasPromptStateModule.setStatus,
      Rows3,
      Columns3,
      Minus,
      Copy,
      Expand,
      toggleTextNodeExpanded: context.toggleTextNodeExpanded,
    });
  }

  function renderTextNodeEditorToolbar(node: NodeData) {
    return renderTextNodeEditorToolbarExternal(node, {
      Circle,
      Type,
      Rows3,
      Columns3,
      Minus,
      Copy,
      Expand,
    });
  }

  function renderTextNodeDownloadButton(node: NodeData) {
    return renderTextDownloadButton(
      node,
      context.downloadTextNodeAsTxt,
      Download,
    );
  }

  function renderNodeUploadOverlay(node: NodeData) {
    return renderNodeUploadOverlayExternal(node, {
      nodeUploadIsActive: context.nodeUploadIsActive,
      nodeUploadSingleFlightRef:
        context.canvasRuntimeRefsModule.nodeUploadSingleFlightRef,
      retryNodeUpload: context.retryNodeUpload,
      cancelNodeTransferOrGeneration: context.cancelNodeTransferOrGeneration,
    });
  }

  function renderNodeGenerationOverlay(_node: NodeData) {
    return null;
  }

  function renderNodeEditorPositionToggle() {
    return renderNodeEditorPositionToggleExternal(
      context.canvasPromptStateModule.nodeEditorPinned,
      context.canvasPromptStateModule.setNodeEditorPinned,
    );
  }
  return {
    renderNodeProgressChip,
    renderCanvasArtifactToolbar,
    renderCanvasArtifactSourcePicker,
    renderProductScriptProgressChip,
    renderProductScriptSkeleton,
    renderProductScriptMiniSteps,
    renderProductScriptNode,
    renderEditableProductViralTable,
    renderProductAssetsEditor,
    renderProductStoryboardEditor,
    renderProductScriptFullscreen,
    renderCanvasSidebarNodeItem,
    renderNodeMediaToolbar,
    renderLightweightMediaNode,
    renderNodePlaceholder,
    renderRichTextNodeEditorToolbar,
    renderTextNodeEditorToolbar,
    renderTextNodeDownloadButton,
    renderNodeUploadOverlay,
    renderNodeGenerationOverlay,
    renderNodeEditorPositionToggle,
  };
}
