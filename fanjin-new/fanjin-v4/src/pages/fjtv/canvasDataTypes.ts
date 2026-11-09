import type { RedrawDraft } from "../../features/video-redraw/redrawDraft";
import type { NodeType, RatioKey, ImageOutpaintRatioMode, ImageOutpaintResolution, ImageOutpaintDraft, ImageCropDraft } from "./canvasMediaTypes";
import type { VideoOutputFormat } from "../../features/quick-create/videoOutputContract";
import type { CanvasArtifactNodeFields } from "./canvasTextArtifacts";
import type { PersistedComposeClip } from "./canvasComposeTimeline";
import type { CanvasCatalogVideoMode } from "./canvasCatalogContract";
import type { CanvasRect as Rect } from "./canvasGeometry";
import type { GeneratedImageChoice } from "./canvasTaskResults";

export type Side = "left" | "right";

export type CanvasModelType = "image" | "video" | "text" | "audio";

export type ModelCatalogState = "loading" | "ready" | "empty" | "failed";

export type GenerateDebugSnapshot = { phase: string; payload?: any; response?: any; error?: string };

export type CanvasShortcut = {
  keys: readonly string[];
  primary?: boolean;
  alt?: boolean;
  shift?: boolean;
  labelKey?: string;
};

export type MenuSource = "sidebar" | "doubleClick" | "connection";

export type AssetManagerTab = "canvas" | "asset";

export type LayoutMode = "grid" | "horizontal" | "vertical";

export type MaxImageCount = 1 | 2 | 4;

export type CameraPresetKind = "camera" | "lens" | "focalLength" | "aperture";

export type VideoEnhanceVersion = "standard" | "professional";

export type VideoEnhanceResolution = "720P" | "1080P" | "2K" | "4K";

export type VideoEnhanceFrameRate = "original" | "24" | "30" | "60" | "90" | "120";

export type VideoSubtitleEraseType = "subtitle" | "region";

export type VideoFrameExtractMode = "current" | "first" | "last";

export type AudioSeparateRole = "voice" | "bgm" | "mute-video";

export type ImageEnhanceVersion = "standard" | "professional";

export type ImageEraseKind = "icon" | "text";

export type CanvasAssetType = "snapshot" | "portrait";

export type StoryboardGroupType = "storyboard" | "storyboard-hd";

export type StoryboardStitchResolution = "2k" | "4k";

export type TextNodeHeading = "body" | "h1" | "h2" | "h3";

export type TextNodeListStyle = "none" | "bullet" | "number";

export interface EraseRatioLocation {
  top_left_x: number;
  top_left_y: number;
  bottom_right_x: number;
  bottom_right_y: number;
}

export interface ViewportState {
  scale: number;
  panX: number;
  panY: number;
}

export interface CameraSettings {
  camera: string;
  lens: string;
  focalLength: string;
  aperture: string;
}

export interface UpstreamReferenceItem {
  id: string;
  nodeId: string;
  type: NodeType;
  label: string;
  mentionToken: string;
  thumbnailSrc: string;
  sourceUrl?: string;
  badge: number;
}

export interface PromptSegment {
  type: "text" | "reference";
  value: string;
}

export interface PromptReferenceRange {
  label: string;
  start: number;
  end: number;
}

export interface VideoStoryShot {
  id?: string;
  shot: number;
  startTime: number;
  endTime: number;
  duration: number;
  visualDescription: string;
  narrative: string;
  shotSize: string;
  cameraAngle: string;
  cameraMovement: string;
  focusDepth: string;
  lighting: string;
  backgroundMusic: string;
  voiceSound: string;
  subtitle?: string;
  imagePrompt: string;
  videoMotionPrompt: string;
  keywords?: string;
  keyframeUrl?: string;
  frameTime?: number;
  sceneConfidence?: number | null;
  keyframeAssetId?: number;
  keyframeAssetVersionId?: number;
}

export interface VideoStoryAnalysis {
  version?: "video-story-analysis.v1";
  title: string;
  model?: string;
  duration?: number;
  generatedAt?: string;
  analyzer?: {
    id: string;
    version: string;
    semanticUnderstanding: boolean;
    sceneThreshold: number;
  };
  source?: {
    projectId: number;
    assetId: number;
    assetVersionId: number;
    sha256: string;
  };
  billing?: {
    billable: boolean;
    costGu: number;
    status: string;
    refundStatus: string;
    reason: string;
  };
  rows: VideoStoryShot[];
  keyframes?: Array<{ shot: number; time: number; url: string }>;
}

export type VideoStoryTaskState = "queued" | "running" | "persisting" | "succeeded" | "failed" | "cancelled";

export type ProductScriptStep = 1 | 2 | 3;

export type ProductScriptStage = "empty" | "uploading" | "analyzing-viral" | "shots-ready" | "analyzing-product" | "assets-ready" | "composing-storyboard" | "storyboard-ready" | "generating-video" | "video-ready" | "failed";

export type ProductScriptAssetKind = "model" | "product" | "makeup";

export interface ProductScriptAsset {
  kind: ProductScriptAssetKind;
  label: string;
  imageUrl?: string;
  fileName?: string;
  summary?: string;
  details?: string;
  sellingPoints?: string[];
  visualKeywords?: string[];
  avoidNotes?: string[];
  imagePromptHint?: string;
  videoUsageHint?: string;
  uploading?: boolean;
  progress?: number;
}

export interface ProductAssetAnalysis {
  productName?: string;
  category?: string;
  overallStyle?: string;
  sellingPoints?: string[];
  visualKeywords?: string[];
  avoidNotes?: string[];
  assets?: ProductScriptAsset[];
  generatedAt?: string;
  model?: string;
}

export interface ProductStoryboardShot {
  shot: number;
  startTime: number;
  endTime: number;
  duration: number;
  visualDescription: string;
  narrative: string;
  shotSize: string;
  cameraAngle: string;
  cameraMovement: string;
  focusDepth: string;
  lighting: string;
  productSellingPoint: string;
  assetUsage: string;
  imagePrompt: string;
  videoMotionPrompt: string;
  finalPrompt: string;
  keywords?: string;
  sourceKeyframeUrl?: string;
}

export interface ProductStoryboard {
  title: string;
  productName?: string;
  generatedAt?: string;
  model?: string;
  rows: ProductStoryboardShot[];
}

export interface ProductScriptWorkflow {
  step: ProductScriptStep;
  stage: ProductScriptStage;
  progress: number;
  sourceVideoUrl?: string;
  sourceVideoName?: string;
  viralAnalysis?: VideoStoryAnalysis;
  productAnalysis?: ProductAssetAnalysis;
  storyboard?: ProductStoryboard;
  assets: ProductScriptAsset[];
  productName: string;
  productCategory: string;
  error?: string;
  generatedVideoNodeIds?: string[];
}

export interface NodeData extends CanvasArtifactNodeFields {
  id: string;
  type: NodeType;
  title: string;
  titleCustomized?: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  ratio: RatioKey;
  prompt: string;
  promptPlaceholder?: string;
  model: string;
  quality: string;
  resolution: string;
  cameraControl: string;
  cameraSettings?: CameraSettings;
  panorama: string;
  quantity: string;
  maxImages?: MaxImageCount;
  videoGenerateAudio?: boolean;
  videoMode?: VideoGenerationMode;
  videoRenderMode?: "draft" | "finalize";
  videoOutputFormat?: VideoOutputFormat;
  videoDraftTaskId?: string;
  videoDraftExpiresAt?: number;
  videoDraftParentNodeId?: string;
  price: string;
  duration?: string;
  outputText?: string;
  isGenerating?: boolean;
  generationState?: "idle" | "submitting" | "processing" | "cancelled";
  taskId?: string;
  taskKind?: "generation" | "video_enhance";
  taskStatus?: "idle" | "processing" | "pending_reconcile" | "query_failed" | "success" | "failed";
  textGenerationAttemptId?: string;
  imageGenerationAttemptId?: string;
  imageRequestAttempt?: { id: string; payload: Record<string, any> };
  imagePendingMessage?: string;
  imagePendingCode?: string;
  videoGenerationAttemptId?: string;
  videoRequestAttempt?: { id: string; payload: Record<string, any> };
  videoEnhanceAttemptId?: string;
  imageUrl?: string;
  primaryImageUrl?: string;
  imageResultVersion?: number;
  generatedImages?: GeneratedImageChoice[];
  imageChoicesCollapsed?: boolean;
  localPreviewUrl?: string;
  videoUrl?: string;
  localVideoUrl?: string;
  videoPosterUrl?: string;
  /** Draw history: previous outputs kept as v1, v2… so a user can switch back. */
  generationVersions?: Array<{
    version: number;
    kind: "image" | "video";
    url: string;
    posterUrl?: string;
    createdAt?: number;
    label?: string;
    draftTaskId?: string;
    draftExpiresAt?: number;
  }>;
  activeGenerationVersion?: number;
  suppressEmptyTryActions?: boolean;
  fileName?: string;
  uploadState?: "idle" | "preparing" | "uploading" | "failed";
  uploadProgress?: number;
  uploadError?: string;
  generationProgress?: number;
  reportedGenerationProgress?: number;
  preparationStage?: "portrait_registration";
  statusMessage?: string;
  statusChipText?: string;
  statusChipTone?: "neutral" | "success" | "error";
  mediaNaturalWidth?: number;
  mediaNaturalHeight?: number;
  /** Owned o_media_asset identity bound to mediaAssetUrl. */
  mediaAssetId?: string;
  /** URL that mediaAssetId was resolved for; prevents reusing a stale id after source replacement. */
  mediaAssetUrl?: string;
  /** Measured/display metadata only. Billing uses the server-owned asset duration. */
  mediaDurationMs?: number;
  videoTrimStart?: number;
  videoTrimEnd?: number;
  /** Non-destructive FEAT-05 rewrite lineage. The source remains restorable. */
  videoRewriteSourceVideoUrl?: string;
  videoRewriteSourceAssetVersionId?: number;
  videoRewriteSourceReferenceAssetUri?: string;
  videoRewriteOutputVideoUrl?: string;
  videoRewriteOutputAssetVersionId?: number;
  videoRewriteOutputReferenceAssetUri?: string;
  videoRewriteInstruction?: string;
  videoRewriteStartMs?: number;
  videoRewriteEndMs?: number;
  videoRewriteViewing?: "source" | "output";
  videoRewritePending?: boolean;
  videoLoopSelection?: boolean;
  videoSnapToWholeSecond?: boolean;
  cropX?: number;
  cropY?: number;
  cropWidth?: number;
  cropHeight?: number;
  videoEnhanceMode?: boolean;
  videoEnhanceModel?: string;
  videoEnhanceVersion?: VideoEnhanceVersion;
  videoEnhanceResolution?: VideoEnhanceResolution;
  videoEnhanceFrameRate?: VideoEnhanceFrameRate;
  videoEnhanceAvailableResolutions?: VideoEnhanceResolution[];
  videoEnhanceQuoteGu?: Partial<Record<VideoEnhanceResolution, number>>;
  videoSubtitleEraseMode?: boolean;
  videoSubtitleEraseType?: VideoSubtitleEraseType;
  videoSubtitleEraseAreas?: EraseRatioLocation[];
  videoStoryAnalysis?: VideoStoryAnalysis;
  videoWorkflow?: "redraw";
  videoRedrawDraft?: RedrawDraft;
  videoRedrawSourceNodeId?: string;
  videoStoryAnalyzing?: boolean;
  videoStoryTaskId?: number;
  videoStoryTaskState?: VideoStoryTaskState;
  videoStoryFailureReason?: string;
  videoStoryAttemptId?: string;
  videoStoryStoryboardGroupId?: string;
  scriptWorkflow?: ProductScriptWorkflow;
  audioSeparateMode?: boolean;
  audioSeparateRole?: AudioSeparateRole;
  imageEnhanceMode?: boolean;
  imageEnhanceVersion?: ImageEnhanceVersion;
  imageEnhanceFactor?: number;
  imageOutpaintMode?: boolean;
  imageOutpaintRatioMode?: ImageOutpaintRatioMode;
  imageOutpaintResolution?: ImageOutpaintResolution;
  imageOutpaintCount?: number;
  imageCropMode?: boolean;
  imageCropRatioMode?: ImageOutpaintRatioMode;
  imageBackgroundRemoveMode?: boolean;
  imageEraseMode?: boolean;
  imageEraseKind?: ImageEraseKind;
  imageEraseText?: string;
  imageTransformMode?: boolean;
  imageRotation?: number;
  imageFlipX?: boolean;
  imageFlipY?: boolean;
  audioUrl?: string;
  localAudioUrl?: string;
  audioVoice?: string;
  audioMood?: string;
  textVisited?: boolean;
  textBackgroundColor?: string;
  textHeading?: TextNodeHeading;
  textFontSize?: number;
  textBold?: boolean;
  textItalic?: boolean;
  textListStyle?: TextNodeListStyle;
  textDivider?: boolean;
  textExpanded?: boolean;
  composeMuted?: boolean;
  composeTimeline?: PersistedComposeClip[];
  composeRenderAttemptId?: string;
  referenceAssetUri?: string;
  assetVersionId?: number;
  /** Persisted provenance for a completed image-to-video node. */
  sourceImageNodeId?: string;
  inputAssetVersionId?: number;
  firstFrameAssetVersionId?: number;
  referenceAssetKind?: "portrait";
  referenceAssetPreviewUrl?: string;
  storyboardCellKey?: string;
  storyboardSlotFilledByUser?: boolean;
  storyboardSlotPlaceholder?: boolean;
  storyboardSlotOrder?: number;
}

export interface ImageGridSplitEditorState {
  nodeId: string;
  rows: number;
  cols: number;
  selectedCells: string[];
  hoveredCell: string | null;
  enhanceFactor: 2 | 4;
  factorMenuOpen: boolean;
}

export interface ImageGridSplitDragState {
  sourceNodeId: string;
  cellKey: string;
  rows: number;
  cols: number;
  startClientX: number;
  startClientY: number;
  createdNodeId: string | null;
}

export interface VideoTrimDraft {
  start: number;
  end: number;
  duration: number;
  snapToWholeSecond: boolean;
  loopSelection: boolean;
}

export interface VideoCropDraft {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ImageEnhanceEditorState {
  nodeId: string;
  version: ImageEnhanceVersion;
  factor: number;
}

export interface ImageTransformEditorState {
  nodeId: string;
  rotation: number;
  flipX: boolean;
  flipY: boolean;
  editingAngle: boolean;
  angleInput: string;
}

export interface ImageOutpaintDragState {
  nodeId: string;
  side: "left" | "right" | "top" | "bottom";
  startX: number;
  startY: number;
  initial: ImageOutpaintDraft;
}

export interface ImageCropDragState {
  nodeId: string;
  type: "move" | "left" | "right" | "top" | "bottom" | "corner";
  startX: number;
  startY: number;
  initial: ImageCropDraft;
  aspect: number | null;
}

export interface EdgeData {
  id: string;
  relationship?: "draft_final";
  fromNodeId: string;
  fromSide: Side;
  toNodeId: string;
  toSide: Side;
}

export interface GroupData {
  id: string;
  nodeIds: string[];
  layoutMode: LayoutMode;
  themeColor: string;
  title: string;
  groupType?: StoryboardGroupType | "default";
  storyboardRows?: number;
  storyboardCols?: number;
  storyboardRatio?: RatioKey;
  storyboardStitchResolution?: StoryboardStitchResolution;
  storyboardShowOrder?: boolean;
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  createdAt: number;
  coverUrl?: string;
  coverNodeId?: string;
  note?: string;
  groupSnapshot: {
    nodes: NodeData[];
    edges: EdgeData[];
    layoutMode: LayoutMode;
    themeColor: string;
    bounds: Rect;
  };
}

export interface AssetSnapshot {
  nodes: NodeData[];
  edges: EdgeData[];
  bounds: Rect;
}

export interface AssetTemplate {
  id: string;
  projectId?: number;
  name: string;
  category: "人物" | "场景" | "物品" | "风格" | "其它";
  assetType?: CanvasAssetType;
  referenceAssetUri?: string;
  saveLocation?: string;
  tag?: string;
  coverUrl?: string;
  createdAt: number;
  snapshot: AssetSnapshot;
}

export interface ProjectListItem {
  projectId: string;
  name: string;
  coverImageUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectCanvasItem {
  canvasId: string;
  revision: number;
  name: string;
  coverImageUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectFolderItem {
  id: string;
  name: string;
  coverUrl?: string;
  projectIds: string[];
  createdAt: string;
  updatedAt?: string;
}

export interface HistoryAssetItem {
  id: string;
  mediaAssetId?: string;
  taskId: string;
  type: "image" | "video" | "audio";
  url: string;
  model: string;
  prompt: string;
  status?: string;
  errorMessage?: string;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
  metadata?: Record<string, unknown>;
  createdAt: string;
  dateGroup: string;
  /** Live generation still running; shown with a progress bar. */
  pending?: boolean;
  progress?: number;
  preparationStage?: "portrait_registration";
  statusMessage?: string;
}

export interface SelectionBox {
  active: boolean;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

export interface NodeDragState {
  active: boolean;
  nodeId: string | null;
  offsetX: number;
  offsetY: number;
}

export interface GroupDragState {
  active: boolean;
  groupId: string | null;
  startX: number;
  startY: number;
  originalPositions: Record<string, { x: number; y: number }>;
  startBounds: Rect | null;
}

export interface TextResizeState {
  active: boolean;
  nodeId: string | null;
  startX: number;
  startY: number;
  startWidth: number;
  startHeight: number;
}

export interface DraftLine {
  fromNodeId: string;
  fromSide: Side;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  startClientX: number;
  startClientY: number;
  hasMoved: boolean;
}

export interface EdgeHoverState {
  edgeId: string;
  enteredAt: number;
  armed: boolean;
  nearestPoint: { x: number; y: number };
  distance: number;
}

export interface CreationMenuState {
  open: boolean;
  x: number;
  y: number;
  source: MenuSource;
  sourceNodeType?: NodeType;
  sourceNodeId?: string;
}

export interface PendingConnection {
  fromNodeId: string;
  fromSide: Side;
}

export interface CanvasMetaState {
  canvasId: string | null;
  projectId: string | null;
  revision: number | null;
  name: string;
  loading: boolean;
  ready: boolean;
}

export type CanvasConflictState = {
  message: string;
  expectedRevision: number | null;
  currentRevision: number | null;
};

export interface ArrangeSnapshot {
  before: CanvasHistorySnapshot;
  after: CanvasHistorySnapshot;
  mergedCount: number;
}

export interface CanvasHistorySnapshot {
  nodes: NodeData[];
  edges: EdgeData[];
  groups: GroupData[];
  viewport: ViewportState;
}

export interface RatioPanelItem {
  key: RatioKey;
  label: string;
  glyphWidth: number;
  glyphHeight: number;
}

export interface ModelVisualMeta {
  icon: "link" | "image" | "bars";
}

export interface CameraPresetOption {
  id: string;
  label: string;
  sublabel: string;
  icon: CameraPresetKind;
  heroText?: string;
}

export type VideoGenerationMode = CanvasCatalogVideoMode;

export interface VideoReferenceSummary {
  imageCount: number;
  videoCount: number;
  audioCount: number;
  totalCount: number;
  hasImages: boolean;
  hasVideos: boolean;
  hasAudios: boolean;
  hasMixedMedia: boolean;
}

export interface VideoPromptTabAvailability {
  enabled: boolean;
  hintLines: string[];
}

export interface InfiniteCanvasStableProps {
  studioChrome?: boolean;
  studioMode?: "agent" | "canvas";
  studioProjectHeaderInAgent?: boolean;
  initialBrief?: string;
  assetManagerCloseRequest?: number;
  assetManagerToggleRequest?: number;
  projectBrowserToggleRequest?: number;
  onAssetManagerOpenChange?: (open: boolean) => void;
}

export interface CanvasPersistRequest {
  nodes: NodeData[];
  edges: EdgeData[];
  name: string;
  groups: GroupData[];
  contextEpoch: number;
}

export interface CanvasUploadRetry {
  file: File;
  type: "image" | "video";
  options?: {
    skipAutoPersist?: boolean;
    onLocalReady?: (local: { url: string; width: number; height: number; nodes: NodeData[] }) => void;
  };
}

export interface CanvasNodeUploadResult {
  url: string;
  width: number;
  height: number;
  nodes: NodeData[] | null;
}

export type VideoPromptTab = "文生视频" | "全能参考" | "图生视频" | "首尾帧" | "图片参考" | "延长视频" | "修改视频";
