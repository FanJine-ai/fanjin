import type * as React from "react";
import type * as Router from "react-router-dom";
import { NODE_RADIUS, GROUP_THEME_COLORS, NODE_SELECTION_BORDER, NODE_SELECTION_GLOW } from "./canvasPageConstants";
import { CanvasWorldSelectionOverlay } from "./CanvasWorldSelectionOverlay";
import { renderCanvasNodeGlyph, renderVirtualizedNodePlaceholder } from "./canvasNodeRenderHelpers";
import { CanvasWorldLayers } from "./CanvasWorldLayers";
import { isStoryboardGroup } from "./canvasStoryboardUtils";
import { type Side, type LayoutMode, type MaxImageCount, type VideoEnhanceVersion, type VideoEnhanceResolution, type VideoEnhanceFrameRate, type VideoSubtitleEraseType, type AudioSeparateRole, type ImageEnhanceVersion, type ImageEraseKind, type StoryboardStitchResolution, type TextNodeHeading, type TextNodeListStyle, type EraseRatioLocation, type ViewportState, type CameraSettings, type VideoStoryAnalysis, type VideoStoryTaskState, type ProductScriptWorkflow, type NodeData, type EdgeData, type GroupData, type SelectionBox, type NodeDragState, type GroupDragState, type TextResizeState, type DraftLine, type EdgeHoverState, type CanvasHistorySnapshot, type VideoGenerationMode, type CanvasUploadRetry } from "./canvasDataTypes";
import { type NodeType, type RatioKey, type ImageOutpaintRatioMode, type ImageOutpaintResolution } from "./canvasMediaTypes";
import { type VideoOutputFormat } from "../../features/quick-create/videoOutputContract";
import { type CanvasArtifactKind } from "./canvasTextArtifacts";
import { type PersistedComposeClip } from "./canvasComposeTimeline";
import { type CanvasAlignmentGuides as AlignmentGuides, type CanvasRect as Rect } from "./canvasGeometry";
import { type GeneratedImageChoice } from "./canvasTaskResults";

export interface CanvasPageWorldProps {
  activeGroupBounds: { left: number; top: number; right: number; bottom: number; } | null;
  activeGroup: GroupData | null;
  groupDrag: GroupDragState;
  toWorld: (clientX: number, clientY: number) => { x: number; y: number; };
  nodes: NodeData[];
  setGroupDrag: React.Dispatch<React.SetStateAction<GroupDragState>>;
  setSelectedNodeIds: React.Dispatch<React.SetStateAction<string[]>>;
  setSelectedEdgeIds: React.Dispatch<React.SetStateAction<string[]>>;
  setActiveNodeId: React.Dispatch<React.SetStateAction<string | null>>;
  activeGroupFullySelected: boolean;
  groupToolbarCenterX: number | null;
  getCanvasToolbarTop: (targetTop: number, visualOffset?: number) => number;
  getCanvasToolbarScale: (multiplier?: number) => number;
  setStoryboardToolbarRatioOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setStoryboardToolbarGridOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setStoryboardToolbarStitchOpen: React.Dispatch<React.SetStateAction<boolean>>;
  storyboardToolbarRatioOpen: boolean;
  rebuildStoryboardGroupStructure: (group: GroupData, rows: number, cols: number, ratio: RatioKey) => void;
  storyboardToolbarGridOpen: boolean;
  storyboardToolbarStitchOpen: boolean;
  setGroups: React.Dispatch<React.SetStateAction<GroupData[]>>;
  stitchStoryboardGroup: (group: GroupData, resolution: StoryboardStitchResolution) => Promise<void>;
  updateActiveGroup: (patch: Partial<GroupData>) => void;
  clearStoryboardFilledSlots: (group: GroupData) => void;
  convertStoryboardGroupToRegular: (group: GroupData) => void;
  ungroupActive: () => void;
  setColorPaletteOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setLayoutDropdownOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setSelectionLayoutMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  colorPaletteOpen: boolean;
  layoutDropdownOpen: boolean;
  applyGroupLayout: (mode: LayoutMode) => void;
  groupExecutionDialog: { groupId: string; } | null;
  openGroupExecutionDialog: (group: GroupData, opener?: HTMLButtonElement) => void;
  workflowTemplatesAvailable: boolean;
  openCreateWorkflowModal: () => void;
  downloadMediaForNodeIds: (nodeIds: string[]) => Promise<void>;
  getGroupDownloadNodeIds: (group: GroupData) => string[];
  storyboardSlotMenuNodeId: string | null;
  storyboardSlotMenuPosition: { x: number; y: number; } | null;
  setStoryboardSlotUploadTargetNodeId: React.Dispatch<React.SetStateAction<string | null>>;
  setStoryboardSlotMenuNodeId: React.Dispatch<React.SetStateAction<string | null>>;
  setStoryboardSlotMenuPosition: React.Dispatch<React.SetStateAction<{ x: number; y: number; } | null>>;
  storyboardSlotUploadInputRef: React.RefObject<HTMLInputElement | null>;
  setStoryboardHistoryTargetNodeId: React.Dispatch<React.SetStateAction<string | null>>;
  setHistoryPanelOpen: React.Dispatch<React.SetStateAction<boolean>>;
  selectedBounds: { left: number; top: number; right: number; bottom: number; } | null;
  selectedNodeIds: string[];
  selectionToolbarCenterX: number | null;
  canvasFrameDashStyle: { readonly border: "none"; readonly backgroundImage: string; readonly backgroundPosition: "left top, left bottom, left top, right top"; readonly backgroundRepeat: "repeat-x, repeat-x, repeat-y, repeat-y"; readonly backgroundSize: `auto ${number}px, auto ${number}px, ${number}px auto, ${number}px auto`; readonly filter: "none"; };
  selectionLayoutMenuOpen: boolean;
  applySelectionLayout: (mode: LayoutMode) => void;
  openCreateAssetModal: () => void;
  duplicateSelectedNodes: () => Promise<void>;
  downloadSelectedMedia: () => Promise<void>;
  createGroupFromSelection: () => void;
  selectionBox: SelectionBox;
  edgeHoverState: EdgeHoverState | null;
  removeEdge: (edgeId: string) => void;
  viewport: ViewportState;
  viewportVisualScale: (nextViewport?: ViewportState) => number;
  groups: GroupData[];
  groupBoundsMap: Map<string, { left: number; top: number; right: number; bottom: number; }>;
  activeGroupId: string | null;
  editingTextNodeId: string | null;
  commitTextNodeEditing: () => void;
  beginGroupDrag: (group: GroupData, startWorldX: number, startWorldY: number, startBounds: Rect) => void;
  closePromptMenus: () => void;
  visibleEdges: EdgeData[];
  nodeMap: Map<string, NodeData>;
  nodeSocket: (node: NodeData, side: Side) => { x: number; y: number; };
  selectedEdgeIds: string[];
  animatedEdgeIds: Set<string>;
  draftLine: DraftLine | null;
  alignmentGuides: AlignmentGuides | null;
  editingGroupTitleId: string | null;
  setActiveGroupId: React.Dispatch<React.SetStateAction<string | null>>;
  editingGroupTitleDraft: string;
  setEditingGroupTitleDraft: React.Dispatch<React.SetStateAction<string>>;
  commitGroupTitle: (groupId: string, fallbackTitle: string) => void;
  cancelGroupTitleEdit: () => void;
  startEditGroupTitle: (group: GroupData) => void;
  getGroupDisplayTitle: (group: GroupData) => string;
  visibleNodes: NodeData[];
  visibleNodeIdSet: Set<string>;
  interactionPerformanceMode: boolean;
  editingNodeTitleId: string | null;
  findStoryboardGroupByNodeId: (nodeId: string) => GroupData | null;
  singleSelectedNodeId: string | null;
  formatDurationLabel: (seconds: number) => string;
  activeNodeId: string | null;
  renderNodeMediaToolbar: (node: NodeData) => React.JSX.Element | null;
  renderTextNodeDownloadButton: (node: NodeData) => React.ReactNode;
  renderRichTextNodeEditorToolbar: (node: NodeData) => React.JSX.Element;
  beginNodeMove: (node: NodeData, event: React.MouseEvent<HTMLElement>) => void;
  editingNodeTitleDraft: string;
  setEditingNodeTitleDraft: React.Dispatch<React.SetStateAction<string>>;
  commitNodeTitle: (nodeId: string, fallbackTitle: string) => void;
  cancelNodeTitleEdit: () => void;
  startEditNodeTitle: (node: NodeData) => void;
  dragNode: NodeDragState;
  selectedNodeIdSet: Set<string>;
  ensureApiKeyReady: () => boolean;
  canvasContextEpochRef: React.RefObject<number>;
  uploadFileIntoNode: (nodeId: string, file: File, type: "image" | "video", options?: CanvasUploadRetry["options"]) => any;
  createMediaNodeFromFile: (file: File, worldX: number, worldY: number) => Promise<void>;
  setHoverTextNodeId: React.Dispatch<React.SetStateAction<string | null>>;
  createDuplicateFromNodeIds: (sourceIds: string[], offsetX?: number, offsetY?: number) => { duplicatedNodes: { id: string; x: number; y: number; title: string; titleCustomized: boolean; type: NodeType; width: number; height: number; ratio: RatioKey; prompt: string; promptPlaceholder?: string; model: string; quality: string; resolution: string; cameraControl: string; cameraSettings?: CameraSettings; panorama: string; quantity: string; maxImages?: MaxImageCount; videoGenerateAudio?: boolean; videoMode?: VideoGenerationMode; videoRenderMode?: "draft" | "finalize"; videoOutputFormat?: VideoOutputFormat; videoDraftTaskId?: string; videoDraftExpiresAt?: number; videoDraftParentNodeId?: string; price: string; duration?: string; outputText?: string; isGenerating?: boolean; generationState?: "idle" | "submitting" | "processing" | "cancelled"; taskId?: string; taskKind?: "generation" | "video_enhance"; taskStatus?: "idle" | "processing" | "pending_reconcile" | "query_failed" | "success" | "failed"; textGenerationAttemptId?: string; imageGenerationAttemptId?: string; imageRequestAttempt?: { id: string; payload: Record<string, any>; }; imagePendingMessage?: string; imagePendingCode?: string; videoGenerationAttemptId?: string; videoRequestAttempt?: { id: string; payload: Record<string, any>; }; videoEnhanceAttemptId?: string; imageUrl?: string; primaryImageUrl?: string; imageResultVersion?: number; generatedImages?: GeneratedImageChoice[]; imageChoicesCollapsed?: boolean; localPreviewUrl?: string; videoUrl?: string; localVideoUrl?: string; videoPosterUrl?: string; generationVersions?: Array<{ version: number; kind: "image" | "video"; url: string; posterUrl?: string; createdAt?: number; label?: string; draftTaskId?: string; draftExpiresAt?: number; }>; activeGenerationVersion?: number; suppressEmptyTryActions?: boolean; fileName?: string; uploadState?: "idle" | "preparing" | "uploading" | "failed"; uploadProgress?: number; uploadError?: string; generationProgress?: number; reportedGenerationProgress?: number; preparationStage?: "portrait_registration"; statusMessage?: string; statusChipText?: string; statusChipTone?: "neutral" | "success" | "error"; mediaNaturalWidth?: number; mediaNaturalHeight?: number; mediaAssetId?: string; mediaAssetUrl?: string; mediaDurationMs?: number; videoTrimStart?: number; videoTrimEnd?: number; videoRewriteSourceVideoUrl?: string; videoRewriteSourceAssetVersionId?: number; videoRewriteSourceReferenceAssetUri?: string; videoRewriteOutputVideoUrl?: string; videoRewriteOutputAssetVersionId?: number; videoRewriteOutputReferenceAssetUri?: string; videoRewriteInstruction?: string; videoRewriteStartMs?: number; videoRewriteEndMs?: number; videoRewriteViewing?: "source" | "output"; videoRewritePending?: boolean; videoLoopSelection?: boolean; videoSnapToWholeSecond?: boolean; cropX?: number; cropY?: number; cropWidth?: number; cropHeight?: number; videoEnhanceMode?: boolean; videoEnhanceModel?: string; videoEnhanceVersion?: VideoEnhanceVersion; videoEnhanceResolution?: VideoEnhanceResolution; videoEnhanceFrameRate?: VideoEnhanceFrameRate; videoEnhanceAvailableResolutions?: VideoEnhanceResolution[]; videoEnhanceQuoteGu?: Partial<Record<VideoEnhanceResolution, number>>; videoSubtitleEraseMode?: boolean; videoSubtitleEraseType?: VideoSubtitleEraseType; videoSubtitleEraseAreas?: EraseRatioLocation[]; videoStoryAnalysis?: VideoStoryAnalysis; videoStoryAnalyzing?: boolean; videoStoryTaskId?: number; videoStoryTaskState?: VideoStoryTaskState; videoStoryFailureReason?: string; videoStoryAttemptId?: string; videoStoryStoryboardGroupId?: string; scriptWorkflow?: ProductScriptWorkflow; audioSeparateMode?: boolean; audioSeparateRole?: AudioSeparateRole; imageEnhanceMode?: boolean; imageEnhanceVersion?: ImageEnhanceVersion; imageEnhanceFactor?: number; imageOutpaintMode?: boolean; imageOutpaintRatioMode?: ImageOutpaintRatioMode; imageOutpaintResolution?: ImageOutpaintResolution; imageOutpaintCount?: number; imageCropMode?: boolean; imageCropRatioMode?: ImageOutpaintRatioMode; imageBackgroundRemoveMode?: boolean; imageEraseMode?: boolean; imageEraseKind?: ImageEraseKind; imageEraseText?: string; imageTransformMode?: boolean; imageRotation?: number; imageFlipX?: boolean; imageFlipY?: boolean; audioUrl?: string; localAudioUrl?: string; audioVoice?: string; audioMood?: string; textVisited?: boolean; textBackgroundColor?: string; textHeading?: TextNodeHeading; textFontSize?: number; textBold?: boolean; textItalic?: boolean; textListStyle?: TextNodeListStyle; textDivider?: boolean; textExpanded?: boolean; composeMuted?: boolean; composeTimeline?: PersistedComposeClip[]; composeRenderAttemptId?: string; referenceAssetUri?: string; assetVersionId?: number; sourceImageNodeId?: string; inputAssetVersionId?: number; firstFrameAssetVersionId?: number; referenceAssetKind?: "portrait"; referenceAssetPreviewUrl?: string; storyboardCellKey?: string; storyboardSlotFilledByUser?: boolean; storyboardSlotPlaceholder?: boolean; storyboardSlotOrder?: number; textArtifacts?: import("@/pages/fjtv/canvasTextArtifacts").CanvasTextArtifacts; textArtifactTab?: "body" | CanvasArtifactKind; textArtifactInstruction?: string; textArtifactBindings?: import("@/pages/fjtv/canvasTextArtifacts").CanvasArtifactBinding[]; textArtifactSourceModes?: Record<string, "body" | "cards">; artifactImageTarget?: import("@/pages/fjtv/canvasTextArtifacts").CanvasArtifactBinding; textRequestAttempt?: { id: string; payload: import("@/pages/fjtv/canvasTextArtifacts").CanvasTextRequest; }; artifactRevision?: number; textContentVersion?: number; }[]; duplicatedEdges: EdgeData[]; idMap: Map<string, string>; } | null;
  edges: EdgeData[];
  recordCanvasHistoryMutation: (snapshot: CanvasHistorySnapshot, previousSnapshot?: CanvasHistorySnapshot) => any;
  buildHistorySnapshot: (nextNodes?: NodeData[], nextEdges?: EdgeData[], nextGroups?: GroupData[], nextViewport?: ViewportState) => CanvasHistorySnapshot;
  setNodes: React.Dispatch<React.SetStateAction<NodeData[]>>;
  setEdges: React.Dispatch<React.SetStateAction<EdgeData[]>>;
  setDragNode: React.Dispatch<React.SetStateAction<NodeDragState>>;
  beginNodeConnectionHold: (node: NodeData, event: React.MouseEvent<HTMLElement>) => void;
  openComposeEditor: (nodeId: string) => Promise<void>;
  startTextNodeEditing: (node: NodeData) => void;
  renderLightweightMediaNode: (node: NodeData, previewSide: number) => React.ReactNode;
  renderProductScriptNode: (node: NodeData) => React.JSX.Element;
  canvasColorMode: import("@/ui/theme").ThemeMode;
  getNodeVideoPosterUrl: (node: NodeData) => string;
  videoNodePlaying: Record<string, boolean>;
  canvasPerformanceMode: boolean;
  nodeVideoRefs: React.RefObject<Record<string, HTMLVideoElement | null>>;
  setVideoNodeDurations: React.Dispatch<React.SetStateAction<Record<string, number>>>;
  applyNodeMediaGeometry: (nodeId: string, mediaWidth: number, mediaHeight: number, patch?: Partial<NodeData>) => void;
  primeVideoPreviewFrame: (node: NodeData, target: HTMLVideoElement) => void;
  setVideoNodeCurrentTimes: React.Dispatch<React.SetStateAction<Record<string, number>>>;
  setVideoNodeMuted: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  setVideoNodePlaying: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  renderInlineVideoControls: (node: NodeData) => React.JSX.Element | null;
  renderNodePlaceholder: (node: NodeData) => React.JSX.Element;
  renderNodeUploadOverlay: (node: NodeData) => React.ReactNode;
  renderNodeGenerationOverlay: (_node: NodeData) => null;
  renderNodeProgressChip: (node: NodeData) => React.JSX.Element | null;
  renderImageGridSplitOverlay: (node: NodeData) => React.ReactNode;
  renderImageOutpaintOverlay: (node: NodeData) => React.ReactNode;
  renderImageCropOverlay: (node: NodeData) => React.ReactNode;
  renderVideoEraseRegionOverlay: (node: NodeData) => React.JSX.Element | null;
  renderVideoSubtitleEraseBar: (node: NodeData) => React.ReactNode;
  renderImageGridSplitToolbar: (node: NodeData) => React.ReactNode;
  renderImageTransformEditor: (node: NodeData) => React.ReactNode;
  renderVideoTrimEditor: (node: NodeData) => React.JSX.Element | null;
  renderVideoStoryPanel: (node: NodeData) => React.ReactNode;
  setTextResize: React.Dispatch<React.SetStateAction<TextResizeState>>;
}
export function CanvasPageWorld({
  activeGroupBounds,
  activeGroup,
  groupDrag,
  toWorld,
  nodes,
  setGroupDrag,
  setSelectedNodeIds,
  setSelectedEdgeIds,
  setActiveNodeId,
  activeGroupFullySelected,
  groupToolbarCenterX,
  getCanvasToolbarTop,
  getCanvasToolbarScale,
  setStoryboardToolbarRatioOpen,
  setStoryboardToolbarGridOpen,
  setStoryboardToolbarStitchOpen,
  storyboardToolbarRatioOpen,
  rebuildStoryboardGroupStructure,
  storyboardToolbarGridOpen,
  storyboardToolbarStitchOpen,
  setGroups,
  stitchStoryboardGroup,
  updateActiveGroup,
  clearStoryboardFilledSlots,
  convertStoryboardGroupToRegular,
  ungroupActive,
  setColorPaletteOpen,
  setLayoutDropdownOpen,
  setSelectionLayoutMenuOpen,
  colorPaletteOpen,
  layoutDropdownOpen,
  applyGroupLayout,
  groupExecutionDialog,
  openGroupExecutionDialog,
  workflowTemplatesAvailable,
  openCreateWorkflowModal,
  downloadMediaForNodeIds,
  getGroupDownloadNodeIds,
  storyboardSlotMenuNodeId,
  storyboardSlotMenuPosition,
  setStoryboardSlotUploadTargetNodeId,
  setStoryboardSlotMenuNodeId,
  setStoryboardSlotMenuPosition,
  storyboardSlotUploadInputRef,
  setStoryboardHistoryTargetNodeId,
  setHistoryPanelOpen,
  selectedBounds,
  selectedNodeIds,
  selectionToolbarCenterX,
  canvasFrameDashStyle,
  selectionLayoutMenuOpen,
  applySelectionLayout,
  openCreateAssetModal,
  duplicateSelectedNodes,
  downloadSelectedMedia,
  createGroupFromSelection,
  selectionBox,
  edgeHoverState,
  removeEdge,
  viewport,
  viewportVisualScale,
  groups,
  groupBoundsMap,
  activeGroupId,
  editingTextNodeId,
  commitTextNodeEditing,
  beginGroupDrag,
  closePromptMenus,
  visibleEdges,
  nodeMap,
  nodeSocket,
  selectedEdgeIds,
  animatedEdgeIds,
  draftLine,
  alignmentGuides,
  editingGroupTitleId,
  setActiveGroupId,
  editingGroupTitleDraft,
  setEditingGroupTitleDraft,
  commitGroupTitle,
  cancelGroupTitleEdit,
  startEditGroupTitle,
  getGroupDisplayTitle,
  visibleNodes,
  visibleNodeIdSet,
  interactionPerformanceMode,
  editingNodeTitleId,
  findStoryboardGroupByNodeId,
  singleSelectedNodeId,
  formatDurationLabel,
  activeNodeId,
  renderNodeMediaToolbar,
  renderTextNodeDownloadButton,
  renderRichTextNodeEditorToolbar,
  beginNodeMove,
  editingNodeTitleDraft,
  setEditingNodeTitleDraft,
  commitNodeTitle,
  cancelNodeTitleEdit,
  startEditNodeTitle,
  dragNode,
  selectedNodeIdSet,
  ensureApiKeyReady,
  canvasContextEpochRef,
  uploadFileIntoNode,
  createMediaNodeFromFile,
  setHoverTextNodeId,
  createDuplicateFromNodeIds,
  edges,
  recordCanvasHistoryMutation,
  buildHistorySnapshot,
  setNodes,
  setEdges,
  setDragNode,
  beginNodeConnectionHold,
  openComposeEditor,
  startTextNodeEditing,
  renderLightweightMediaNode,
  renderProductScriptNode,
  canvasColorMode,
  getNodeVideoPosterUrl,
  videoNodePlaying,
  canvasPerformanceMode,
  nodeVideoRefs,
  setVideoNodeDurations,
  applyNodeMediaGeometry,
  primeVideoPreviewFrame,
  setVideoNodeCurrentTimes,
  setVideoNodeMuted,
  setVideoNodePlaying,
  renderInlineVideoControls,
  renderNodePlaceholder,
  renderNodeUploadOverlay,
  renderNodeGenerationOverlay,
  renderNodeProgressChip,
  renderImageGridSplitOverlay,
  renderImageOutpaintOverlay,
  renderImageCropOverlay,
  renderVideoEraseRegionOverlay,
  renderVideoSubtitleEraseBar,
  renderImageGridSplitToolbar,
  renderImageTransformEditor,
  renderVideoTrimEditor,
  renderVideoStoryPanel,
  setTextResize,
}: CanvasPageWorldProps) {
  return <>
<CanvasWorldLayers groupToolbar={{
      activeGroupBounds,
      activeGroup,
      groupDrag,
      toWorld,
      nodes,
      setGroupDrag,
      setSelectedNodeIds,
      setSelectedEdgeIds,
      setActiveNodeId,
      activeGroupFullySelected,
      groupToolbarCenterX,
      isStoryboardGroup,
      getCanvasToolbarTop,
      getCanvasToolbarScale,
      setStoryboardToolbarRatioOpen,
      setStoryboardToolbarGridOpen,
      setStoryboardToolbarStitchOpen,
      storyboardToolbarRatioOpen,
      rebuildStoryboardGroupStructure,
      storyboardToolbarGridOpen,
      storyboardToolbarStitchOpen,
      setGroups,
      stitchStoryboardGroup,
      updateActiveGroup,
      clearStoryboardFilledSlots,
      convertStoryboardGroupToRegular,
      ungroupActive,
      setColorPaletteOpen,
      setLayoutDropdownOpen,
      setSelectionLayoutMenuOpen,
      colorPaletteOpen,
      GROUP_THEME_COLORS,
      layoutDropdownOpen,
      applyGroupLayout,
      groupExecutionDialog,
      openGroupExecutionDialog,
      workflowTemplatesAvailable,
      openCreateWorkflowModal,
      downloadMediaForNodeIds,
      getGroupDownloadNodeIds,
      }} storyboardPosition={storyboardSlotMenuNodeId && storyboardSlotMenuPosition ? storyboardSlotMenuPosition : null} onStoryboardUpload={() => {
        if (!storyboardSlotMenuNodeId) return;
        setStoryboardSlotUploadTargetNodeId(storyboardSlotMenuNodeId);
        setStoryboardSlotMenuNodeId(null);
        setStoryboardSlotMenuPosition(null);
        storyboardSlotUploadInputRef.current?.click();
      }} onStoryboardHistory={() => {
        if (!storyboardSlotMenuNodeId) return;
        setStoryboardHistoryTargetNodeId(storyboardSlotMenuNodeId);
        setStoryboardSlotMenuNodeId(null);
        setStoryboardSlotMenuPosition(null);
        setHistoryPanelOpen(true);
      }} selectionOverlay={<CanvasWorldSelectionOverlay bounds={selectedBounds && selectedNodeIds.length >= 2 && !activeGroup ? selectedBounds : null} centerX={selectedBounds && selectedNodeIds.length >= 2 && !activeGroup ? selectionToolbarCenterX : null} top={selectedBounds ? getCanvasToolbarTop(selectedBounds.top, 74) : 0} scale={getCanvasToolbarScale()} frameStyle={canvasFrameDashStyle} layoutOpen={selectionLayoutMenuOpen} onToggleLayout={() => { setSelectionLayoutMenuOpen((prev) => !prev); setLayoutDropdownOpen(false); }} onApplyLayout={applySelectionLayout} onSave={openCreateAssetModal} onDuplicate={() => { void duplicateSelectedNodes(); }} onDownload={() => { void downloadSelectedMedia(); }} onGroup={createGroupFromSelection} />} selectionBox={selectionBox} edgeHoverState={edgeHoverState} onDisconnect={() => { if (edgeHoverState) removeEdge(edgeHoverState.edgeId); }} transform={`translate(${viewport.panX}px, ${viewport.panY}px) scale(${viewportVisualScale()})`} background={{
      groups,
      groupBoundsMap,
      isStoryboardGroup,
      activeGroupId,
      groupDrag,
      editingTextNodeId,
      commitTextNodeEditing,
      toWorld,
      beginGroupDrag,
      closePromptMenus,
      setLayoutDropdownOpen,
      setColorPaletteOpen,
      setSelectionLayoutMenuOpen,
      }} edge={{
      visibleEdges,
      nodeMap,
      nodeSocket,
      edgeHoverState,
      selectedEdgeIds,
      animatedEdgeIds,
      NODE_SELECTION_BORDER,
      draftLine,
      alignmentGuides,
      }} group={{
      groups,
      groupBoundsMap,
      activeGroupId,
      isStoryboardGroup,
      editingGroupTitleId,
      toWorld,
      beginGroupDrag,
      editingTextNodeId,
      commitTextNodeEditing,
      setActiveGroupId,
      setSelectedNodeIds,
      setSelectedEdgeIds,
      setActiveNodeId,
      closePromptMenus,
      setLayoutDropdownOpen,
      setColorPaletteOpen,
      setSelectionLayoutMenuOpen,
      editingGroupTitleDraft,
      setEditingGroupTitleDraft,
      commitGroupTitle,
      cancelGroupTitleEdit,
      startEditGroupTitle,
      getGroupDisplayTitle,
    }} node={{
      visibleNodes,
      visibleNodeIdSet,
      interactionPerformanceMode,
      viewportVisualScale,
      editingNodeTitleId,
      editingTextNodeId,
      findStoryboardGroupByNodeId,
      singleSelectedNodeId,
      nodes,
      formatDurationLabel,
      activeNodeId,
      renderNodeMediaToolbar,
      renderTextNodeDownloadButton,
      renderRichTextNodeEditorToolbar,
      beginNodeMove,
      renderCanvasNodeGlyph,
      editingNodeTitleDraft,
      setEditingNodeTitleDraft,
      commitNodeTitle,
      cancelNodeTitleEdit,
      startEditNodeTitle,
      dragNode,
      NODE_RADIUS,
      selectedNodeIdSet,
      NODE_SELECTION_BORDER,
      NODE_SELECTION_GLOW,
      ensureApiKeyReady,
      canvasContextEpochRef,
      uploadFileIntoNode,
      createMediaNodeFromFile,
      setHoverTextNodeId,
      toWorld,
      createDuplicateFromNodeIds,
      edges,
      recordCanvasHistoryMutation,
      buildHistorySnapshot,
      groups,
      viewport,
      setNodes,
      setEdges,
      setSelectedNodeIds,
      setSelectedEdgeIds,
      setActiveGroupId,
      setActiveNodeId,
      setDragNode,
      selectedNodeIds,
      closePromptMenus,
      setLayoutDropdownOpen,
      setColorPaletteOpen,
      setSelectionLayoutMenuOpen,
      beginNodeConnectionHold,
      commitTextNodeEditing,
      openComposeEditor,
      startTextNodeEditing,
      renderVirtualizedNodePlaceholder,
      renderLightweightMediaNode,
      renderProductScriptNode,
      canvasColorMode,
      getNodeVideoPosterUrl,
      videoNodePlaying,
      canvasPerformanceMode,
      nodeVideoRefs,
      setVideoNodeDurations,
      applyNodeMediaGeometry,
      primeVideoPreviewFrame,
      setVideoNodeCurrentTimes,
      setVideoNodeMuted,
      setVideoNodePlaying,
      renderInlineVideoControls,
      renderNodePlaceholder,
      renderNodeUploadOverlay,
      renderNodeGenerationOverlay,
      renderNodeProgressChip,
      renderImageGridSplitOverlay,
      renderImageOutpaintOverlay,
      renderImageCropOverlay,
      renderVideoEraseRegionOverlay,
      renderVideoSubtitleEraseBar,
      renderImageGridSplitToolbar,
      renderImageTransformEditor,
      renderVideoTrimEditor,
      renderVideoStoryPanel,
      setTextResize,
    }}>

      </CanvasWorldLayers>
</>;
}
