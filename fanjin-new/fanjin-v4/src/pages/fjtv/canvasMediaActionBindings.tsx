import { type ComposeClip } from "./canvasComposeTimeline";
import type {
  ImageEraseKind,
  NodeData,
  VideoFrameExtractMode,
  VideoSubtitleEraseType,
} from "./canvasDataTypes";
import {
  bindArtifactEditingController,
  bindCanvasMediaViewerActions,
  bindComposeController,
  bindImageGridController,
  bindImageMenuController,
  bindImageToolsController,
  bindVideoStoryController,
  bindVideoToolsController,
} from "./canvasMediaBindings";
import {
  IMAGE_HD_MENU_ITEMS,
  IMAGE_NINE_GRID_MENU_ITEMS,
  IMAGE_TRANSFORM_MENU_ITEMS,
} from "./canvasMediaMenuConfig";
import {
  type CharacterThreeViewMode,
  type MultiAngleNineGridMode,
} from "./canvasPromptTemplates";
import {
  type CanvasArtifactCard,
  type CanvasArtifactKind,
} from "./canvasTextArtifacts";
export function createCanvasMediaActionBindings(context: {
  artifactEditingController: () => ReturnType<
    typeof bindArtifactEditingController
  >;
  videoToolsController: () => ReturnType<typeof bindVideoToolsController>;
  composeController: () => ReturnType<typeof bindComposeController>;
  imageToolsController: () => ReturnType<typeof bindImageToolsController>;
  videoStoryController: () => ReturnType<typeof bindVideoStoryController>;
  canvasMediaViewerActions: () => ReturnType<
    typeof bindCanvasMediaViewerActions
  >;
  imageMenuController: () => ReturnType<typeof bindImageMenuController>;
  imageGridController: () => ReturnType<typeof bindImageGridController>;
}) {
  function editCanvasArtifact(
    nodeId: string,
    kind: CanvasArtifactKind,
    cardId: string,
    patch: Partial<CanvasArtifactCard>,
  ) {
    return context
      .artifactEditingController()
      .editCanvasArtifact(nodeId, kind, cardId, patch);
  }

  function deleteCanvasArtifact(
    nodeId: string,
    kind: CanvasArtifactKind,
    cardId: string,
  ) {
    return context
      .artifactEditingController()
      .deleteCanvasArtifact(nodeId, kind, cardId);
  }

  function getCanvasArtifactImages() {
    return context.artifactEditingController().getCanvasArtifactImages();
  }

  function createImageFromCanvasArtifact(sourceNodeId: string, cardId: string) {
    return context
      .artifactEditingController()
      .createImageFromCanvasArtifact(sourceNodeId, cardId);
  }

  function bindUploadedImageToArtifact(nodeId: string): boolean {
    return context
      .artifactEditingController()
      .bindUploadedImageToArtifact(nodeId);
  }

  async function submitVideoClipRewrite(node: NodeData): Promise<boolean> {
    return context.videoToolsController().submitVideoClipRewrite(node);
  }

  function showVideoRewriteVersion(
    node: NodeData,
    viewing: "source" | "output",
  ) {
    return context
      .videoToolsController()
      .showVideoRewriteVersion(node, viewing);
  }

  function restoreVideoRewriteSource(node: NodeData) {
    return context.videoToolsController().restoreVideoRewriteSource(node);
  }

  function getNodeMediaUrl(node: NodeData | null | undefined) {
    return context.composeController().getNodeMediaUrl(node);
  }

  async function readVideoDuration(url: string) {
    return context.composeController().readVideoDuration(url);
  }

  function persistComposeDraft(
    nodeId: string,
    clips: ComposeClip[],
    muted: boolean,
    options: { preserveAttempt?: boolean } = {},
  ) {
    return context
      .composeController()
      .persistComposeDraft(nodeId, clips, muted, options);
  }

  function updateComposeClips(
    updater: ComposeClip[] | ((prev: ComposeClip[]) => ComposeClip[]),
  ) {
    return context.composeController().updateComposeClips(updater);
  }

  function closeComposeEditor() {
    return context.composeController().closeComposeEditor();
  }

  async function openComposeEditor(nodeId: string) {
    return context.composeController().openComposeEditor(nodeId);
  }

  function seekComposeTime(nextTime: number) {
    return context.composeController().seekComposeTime(nextTime);
  }

  function selectComposeClip(clipId: string) {
    return context.composeController().selectComposeClip(clipId);
  }

  function splitComposeClip() {
    return context.composeController().splitComposeClip();
  }

  function trimComposeClipLeft() {
    return context.composeController().trimComposeClipLeft();
  }

  function trimComposeClipRight() {
    return context.composeController().trimComposeClipRight();
  }

  function setComposeClipSpeed(nextSpeed: number) {
    return context.composeController().setComposeClipSpeed(nextSpeed);
  }

  function setComposeClipDuration(nextDuration: number) {
    return context.composeController().setComposeClipDuration(nextDuration);
  }

  function jumpComposeToPreviousClip() {
    return context.composeController().jumpComposeToPreviousClip();
  }

  function jumpComposeToNextClip() {
    return context.composeController().jumpComposeToNextClip();
  }

  function toggleComposeMuted() {
    return context.composeController().toggleComposeMuted();
  }

  async function exportComposeToCanvas() {
    return context.composeController().exportComposeToCanvas();
  }

  async function exportComposeToLocal() {
    return context.composeController().exportComposeToLocal();
  }

  function applyTrimSnap(value: number, enabled: boolean) {
    return context.videoToolsController().applyTrimSnap(value, enabled);
  }

  function openVideoTrimEditor(node: NodeData) {
    return context.videoToolsController().openVideoTrimEditor(node);
  }

  function openVideoSubtitleEraseEditor(node: NodeData) {
    return context.videoToolsController().openVideoSubtitleEraseEditor(node);
  }

  function openVideoRegionEraseEditor(node: NodeData) {
    return context.videoToolsController().openVideoRegionEraseEditor(node);
  }

  function closeVideoEditor() {
    return context.videoToolsController().closeVideoEditor();
  }

  async function createDerivedVideoNode(
    sourceNode: NodeData,
    patch: Partial<NodeData>,
    titleSuffix: string,
  ) {
    return context
      .videoToolsController()
      .createDerivedVideoNode(sourceNode, patch, titleSuffix);
  }

  async function createDerivedImageNode(
    sourceNode: NodeData,
    title: string,
    patch: Partial<NodeData> = {},
  ) {
    return context
      .imageToolsController()
      .createDerivedImageNode(sourceNode, title, patch);
  }

  function create16x9DerivedImagePatch(
    sourceNode: NodeData,
  ): Partial<NodeData> {
    return context
      .imageToolsController()
      .create16x9DerivedImagePatch(sourceNode);
  }

  function create2x1DerivedImagePatch(sourceNode: NodeData): Partial<NodeData> {
    return context
      .imageToolsController()
      .create2x1DerivedImagePatch(sourceNode);
  }

  function openImageEnhanceEditor(sourceNode: NodeData) {
    return context.imageToolsController().openImageEnhanceEditor(sourceNode);
  }

  async function submitImageEnhance(node: NodeData) {
    return context.imageToolsController().submitImageEnhance(node);
  }

  function openImageOutpaintEditor(node: NodeData) {
    return context.imageToolsController().openImageOutpaintEditor(node);
  }

  async function submitImageOutpaint(node: NodeData) {
    return context.imageToolsController().submitImageOutpaint(node);
  }

  function openImageCropEditor(node: NodeData) {
    return context.imageToolsController().openImageCropEditor(node);
  }

  async function submitImageCrop(node: NodeData) {
    return context.imageToolsController().submitImageCrop(node);
  }

  async function submitRemoveImageBackground(sourceNode: NodeData) {
    return context
      .imageToolsController()
      .submitRemoveImageBackground(sourceNode);
  }

  async function submitImageErase(sourceNode: NodeData, kind: ImageEraseKind) {
    return context.imageToolsController().submitImageErase(sourceNode, kind);
  }

  function openImageTransformEditor(sourceNode: NodeData) {
    return context.imageToolsController().openImageTransformEditor(sourceNode);
  }

  function saveImageTransform(node: NodeData) {
    return context.imageToolsController().saveImageTransform(node);
  }

  async function tryBuildMultiAngleShotPlan(
    sourceNode: NodeData,
    mode: MultiAngleNineGridMode,
    promptContext: string,
  ) {
    return context
      .imageToolsController()
      .tryBuildMultiAngleShotPlan(sourceNode, mode, promptContext);
  }

  async function submitMultiAngleNineGrid(sourceNode: NodeData) {
    return context.imageToolsController().submitMultiAngleNineGrid(sourceNode);
  }

  function collectReferenceDesignContext(sourceNode: NodeData) {
    return context
      .imageToolsController()
      .collectReferenceDesignContext(sourceNode);
  }

  async function submitReferenceDesignSheet(
    sourceNode: NodeData,
    title: string,
    prompt: string,
    statusLabel: string,
    emptyStatus: string,
    smallStatus: string,
  ) {
    return context
      .imageToolsController()
      .submitReferenceDesignSheet(
        sourceNode,
        title,
        prompt,
        statusLabel,
        emptyStatus,
        smallStatus,
      );
  }

  async function submitSceneSheet(sourceNode: NodeData) {
    return context.imageToolsController().submitSceneSheet(sourceNode);
  }

  async function submitCharacterSheet(sourceNode: NodeData) {
    return context.imageToolsController().submitCharacterSheet(sourceNode);
  }

  async function submitProductSheet(sourceNode: NodeData) {
    return context.imageToolsController().submitProductSheet(sourceNode);
  }

  async function submitCinematicLighting(sourceNode: NodeData) {
    return context.imageToolsController().submitCinematicLighting(sourceNode);
  }

  async function submitStoryboard25Grid(sourceNode: NodeData) {
    return context.imageToolsController().submitStoryboard25Grid(sourceNode);
  }

  async function submitCharacterThreeView(
    sourceNode: NodeData,
    mode: CharacterThreeViewMode,
  ) {
    return context
      .imageToolsController()
      .submitCharacterThreeView(sourceNode, mode);
  }

  function startQuickCharacterThreeView() {
    return context.imageToolsController().startQuickCharacterThreeView();
  }

  async function submitAudioSeparate(sourceNode: NodeData) {
    return context.videoToolsController().submitAudioSeparate(sourceNode);
  }

  async function confirmVideoTrim() {
    return context.videoToolsController().confirmVideoTrim();
  }

  async function openVideoEnhanceEditor(node: NodeData) {
    return context.videoToolsController().openVideoEnhanceEditor(node);
  }

  async function submitVideoEnhance(node: NodeData) {
    return context.videoToolsController().submitVideoEnhance(node);
  }

  function updateVideoStoryCell(
    nodeId: string,
    rowIndex: number,
    key: string,
    value: string,
  ) {
    return context
      .videoStoryController()
      .updateVideoStoryCell(nodeId, rowIndex, key, value);
  }

  function writeVideoStoryToStoryboard(sourceNode: NodeData) {
    return context
      .videoStoryController()
      .writeVideoStoryToStoryboard(sourceNode);
  }

  function patchVideoStoryNode(
    nodeId: string,
    patch: Partial<NodeData>,
    options: { persist?: boolean } = {},
  ) {
    return context
      .videoStoryController()
      .patchVideoStoryNode(nodeId, patch, options);
  }

  async function pollVideoStoryAnalysis(
    nodeId: string,
    projectId: number,
    taskId: number,
  ) {
    return context
      .videoStoryController()
      .pollVideoStoryAnalysis(nodeId, projectId, taskId);
  }

  async function submitVideoStoryAnalysis(
    sourceNode: NodeData,
    retryOfTaskId?: number,
  ) {
    return context
      .videoStoryController()
      .submitVideoStoryAnalysis(sourceNode, retryOfTaskId);
  }

  async function cancelVideoStoryAnalysis(node: NodeData) {
    return context.videoStoryController().cancelVideoStoryAnalysis(node);
  }

  async function submitVideoFrameExtract(
    sourceNode: NodeData,
    extractMode: VideoFrameExtractMode,
  ) {
    return context
      .videoToolsController()
      .submitVideoFrameExtract(sourceNode, extractMode);
  }

  async function submitVideoSubtitleErase(
    sourceNode: NodeData,
    eraseType: VideoSubtitleEraseType,
  ) {
    return context
      .videoToolsController()
      .submitVideoSubtitleErase(sourceNode, eraseType);
  }

  function openMediaViewer(node: NodeData | null | undefined) {
    return context.canvasMediaViewerActions().openMediaViewer(node);
  }

  function closeImageToolbarMenus() {
    return context.imageMenuController().closeImageToolbarMenus();
  }

  function handleImageHdMenuAction(
    node: NodeData,
    item: (typeof IMAGE_HD_MENU_ITEMS)[number],
  ) {
    return context.imageMenuController().handleImageHdMenuAction(node, item);
  }

  function handleImageTransformMenuAction(
    node: NodeData,
    item: (typeof IMAGE_TRANSFORM_MENU_ITEMS)[number],
  ) {
    return context
      .imageMenuController()
      .handleImageTransformMenuAction(node, item);
  }

  function handleNineGridMenuAction(
    node: NodeData,
    item: (typeof IMAGE_NINE_GRID_MENU_ITEMS)[number],
  ) {
    return context.imageMenuController().handleNineGridMenuAction(node, item);
  }

  function openImageGridSplitEditor(
    node: NodeData,
    rows: number,
    cols: number,
  ) {
    return context
      .imageGridController()
      .openImageGridSplitEditor(node, rows, cols);
  }

  function toggleImageGridSplitSelection(cellKey: string, append = false) {
    return context
      .imageGridController()
      .toggleImageGridSplitSelection(cellKey, append);
  }

  function beginImageGridSplitDrag(
    sourceNodeId: string,
    cellKey: string,
    rows: number,
    cols: number,
    clientX: number,
    clientY: number,
  ) {
    return context
      .imageGridController()
      .beginImageGridSplitDrag(
        sourceNodeId,
        cellKey,
        rows,
        cols,
        clientX,
        clientY,
      );
  }

  function closeImageGridSplitEditor() {
    return context.imageGridController().closeImageGridSplitEditor();
  }

  function buildImageGridSplitSlotMetrics(
    sourceNode: NodeData,
    rows: number,
    cols: number,
  ) {
    return context
      .imageGridController()
      .buildImageGridSplitSlotMetrics(sourceNode, rows, cols);
  }

  function createImageGridCellNode(
    sourceNode: NodeData,
    row: number,
    col: number,
    rows: number,
    cols: number,
    left: number,
    top: number,
    slotWidth: number,
    slotHeight: number,
    stamp: number,
    suffix: string,
  ): NodeData {
    return context
      .imageGridController()
      .createImageGridCellNode(
        sourceNode,
        row,
        col,
        rows,
        cols,
        left,
        top,
        slotWidth,
        slotHeight,
        stamp,
        suffix,
      );
  }

  function createDetachedImageGridCellNode(
    sourceNode: NodeData,
    row: number,
    col: number,
    rows: number,
    cols: number,
    left: number,
    top: number,
    stamp: number,
  ) {
    return context
      .imageGridController()
      .createDetachedImageGridCellNode(
        sourceNode,
        row,
        col,
        rows,
        cols,
        left,
        top,
        stamp,
      );
  }

  async function buildCroppedImageFile(
    sourceNode: NodeData,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
  ): Promise<File> {
    return context
      .imageGridController()
      .buildCroppedImageFile(sourceNode, x1, y1, x2, y2);
  }

  async function buildGridCellImageFile(
    sourceNode: NodeData,
    row: number,
    col: number,
    rows: number,
    cols: number,
  ): Promise<File> {
    return context
      .imageGridController()
      .buildGridCellImageFile(sourceNode, row, col, rows, cols);
  }

  async function submitImageGridSplitAssets() {
    return context.imageGridController().submitImageGridSplitAssets();
  }

  async function createImageGridSplitGroup() {
    return context.imageGridController().createImageGridSplitGroup();
  }
  return {
    editCanvasArtifact,
    deleteCanvasArtifact,
    getCanvasArtifactImages,
    createImageFromCanvasArtifact,
    bindUploadedImageToArtifact,
    submitVideoClipRewrite,
    showVideoRewriteVersion,
    restoreVideoRewriteSource,
    getNodeMediaUrl,
    readVideoDuration,
    persistComposeDraft,
    updateComposeClips,
    closeComposeEditor,
    openComposeEditor,
    seekComposeTime,
    selectComposeClip,
    splitComposeClip,
    trimComposeClipLeft,
    trimComposeClipRight,
    setComposeClipSpeed,
    setComposeClipDuration,
    jumpComposeToPreviousClip,
    jumpComposeToNextClip,
    toggleComposeMuted,
    exportComposeToCanvas,
    exportComposeToLocal,
    applyTrimSnap,
    openVideoTrimEditor,
    openVideoSubtitleEraseEditor,
    openVideoRegionEraseEditor,
    closeVideoEditor,
    createDerivedVideoNode,
    createDerivedImageNode,
    create16x9DerivedImagePatch,
    create2x1DerivedImagePatch,
    openImageEnhanceEditor,
    submitImageEnhance,
    openImageOutpaintEditor,
    submitImageOutpaint,
    openImageCropEditor,
    submitImageCrop,
    submitRemoveImageBackground,
    submitImageErase,
    openImageTransformEditor,
    saveImageTransform,
    tryBuildMultiAngleShotPlan,
    submitMultiAngleNineGrid,
    collectReferenceDesignContext,
    submitReferenceDesignSheet,
    submitSceneSheet,
    submitCharacterSheet,
    submitProductSheet,
    submitCinematicLighting,
    submitStoryboard25Grid,
    submitCharacterThreeView,
    startQuickCharacterThreeView,
    submitAudioSeparate,
    confirmVideoTrim,
    openVideoEnhanceEditor,
    submitVideoEnhance,
    updateVideoStoryCell,
    writeVideoStoryToStoryboard,
    patchVideoStoryNode,
    pollVideoStoryAnalysis,
    submitVideoStoryAnalysis,
    cancelVideoStoryAnalysis,
    submitVideoFrameExtract,
    submitVideoSubtitleErase,
    openMediaViewer,
    closeImageToolbarMenus,
    handleImageHdMenuAction,
    handleImageTransformMenuAction,
    handleNineGridMenuAction,
    openImageGridSplitEditor,
    toggleImageGridSplitSelection,
    beginImageGridSplitDrag,
    closeImageGridSplitEditor,
    buildImageGridSplitSlotMetrics,
    createImageGridCellNode,
    createDetachedImageGridCellNode,
    buildCroppedImageFile,
    buildGridCellImageFile,
    submitImageGridSplitAssets,
    createImageGridSplitGroup,
  };
}
