import { getCanvasImagePreviewUrl } from "./canvasAssetPresentation";
import { toggleAudioNodePlaybackExternal } from "./canvasAudioPlayback";
import type {
  EdgeData,
  GroupData,
  LayoutMode,
  MenuSource,
  NodeData,
  PendingConnection,
  ProductScriptAssetKind,
  ProductScriptStage,
  ProductScriptWorkflow,
  ProductStoryboardShot,
  Side,
  StoryboardGroupType,
  StoryboardStitchResolution,
  VideoStoryShot,
} from "./canvasDataTypes";
import { type CanvasEmptyLauncherActionKey } from "./CanvasEmptyLauncher";
import { type CanvasRect as Rect } from "./canvasGeometry";
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
  bindStoryboardController,
  bindViewportController,
} from "./canvasGraphBindings";
import type { NodeType, RatioKey } from "./canvasMediaTypes";
import {
  getNodeModelType,
  isAiModelSelectable,
} from "./canvasModelDefinitions";
import { getModelGenerationUnavailableMessageExternal } from "./canvasModelGenerationMessage";
import {
  getNodeVideoPosterUrl as getNodeVideoPosterUrlExternal,
  primeVideoPreviewFrame as primeVideoPreviewFrameExternal,
} from "./canvasVideoPreview";
import { type MiniMapMetrics } from "./miniMapMetrics";
import { useCanvasModelCatalogState } from "./useCanvasModelCatalogState";
export function createCanvasGraphActionBindings(context: {
  viewportController: () => ReturnType<typeof bindViewportController>;
  nodeCreationController: () => ReturnType<typeof bindNodeCreationController>;
  nodeOperationsController: () => ReturnType<
    typeof bindNodeOperationsController
  >;
  canvasNodeMutationController: () => ReturnType<
    typeof bindCanvasNodeMutationController
  >;
  canvasShortcutActions: () => ReturnType<typeof bindCanvasShortcutActions>;
  canvasPanelActions: () => ReturnType<typeof bindCanvasPanelActions>;
  groupExecutionController: () => ReturnType<
    typeof bindGroupExecutionController
  >;
  productScriptController: () => ReturnType<typeof bindProductScriptController>;
  storyboardController: () => ReturnType<typeof bindStoryboardController>;
  presetController: () => ReturnType<typeof bindPresetController>;
  canvasModelCatalogStateModule: ReturnType<typeof useCanvasModelCatalogState>;
  interactionController: () => ReturnType<typeof bindInteractionController>;
  canvasEmptyLauncherActions: () => ReturnType<
    typeof bindCanvasEmptyLauncherActions
  >;
  canvasGraphStateModule: ReturnType<
    typeof import("./useCanvasGraphState").useCanvasGraphState
  >;
  canvasRuntimeRefsModule: ReturnType<
    typeof import("./useCanvasRuntimeRefs").useCanvasRuntimeRefs
  >;
}) {
  function viewportVisualScale(
    nextViewport = context.canvasGraphStateModule.viewport,
  ) {
    return context.viewportController().viewportVisualScale(nextViewport);
  }

  function markCanvasInteraction() {
    return context.viewportController().markCanvasInteraction();
  }

  function getCanvasToolbarScale(multiplier = 1) {
    return context.viewportController().getCanvasToolbarScale(multiplier);
  }

  function getCanvasToolbarTop(targetTop: number, visualOffset = 72) {
    return context
      .viewportController()
      .getCanvasToolbarTop(targetTop, visualOffset);
  }

  function toWorld(clientX: number, clientY: number) {
    return context.viewportController().toWorld(clientX, clientY);
  }

  function toScreen(worldX: number, worldY: number) {
    return context.viewportController().toScreen(worldX, worldY);
  }

  function nodeSocket(node: NodeData, side: Side) {
    return context.nodeCreationController().nodeSocket(node, side);
  }

  function connectionSideToward(node: NodeData, targetX: number): Side {
    return context.nodeCreationController().connectionSideToward(node, targetX);
  }

  function edgeHitToleranceInWorld() {
    return context.nodeCreationController().edgeHitToleranceInWorld();
  }

  function detectEdgeHover(worldX: number, worldY: number) {
    return context.nodeCreationController().detectEdgeHover(worldX, worldY);
  }

  function edgeIntersectsRect(edge: EdgeData, rect: Rect) {
    return context.nodeCreationController().edgeIntersectsRect(edge, rect);
  }

  function detectEdgeDropTarget(
    worldX: number,
    worldY: number,
    fromNodeId: string,
  ): { nodeId: string; side: Side } | null {
    return context
      .nodeCreationController()
      .detectEdgeDropTarget(worldX, worldY, fromNodeId);
  }

  function hasDuplicateEdge(
    fromNodeId: string,
    fromSide: Side,
    toNodeId: string,
    toSide: Side,
  ) {
    return context
      .nodeCreationController()
      .hasDuplicateEdge(fromNodeId, fromSide, toNodeId, toSide);
  }

  function admitCanvasReferenceEdge(
    fromNodeId: string,
    toNodeId: string,
  ): { ok: true } | { ok: false; message: string } {
    return context
      .nodeCreationController()
      .admitCanvasReferenceEdge(fromNodeId, toNodeId);
  }

  function openCreationMenuAtWorld(
    x: number,
    y: number,
    source: MenuSource,
    nextPending: PendingConnection | null = null,
  ) {
    return context
      .nodeCreationController()
      .openCreationMenuAtWorld(x, y, source, nextPending);
  }

  function closeCreationMenu() {
    return context.nodeCreationController().closeCreationMenu();
  }

  function createNodeAt(type: NodeType, worldX: number, worldY: number) {
    return context.nodeCreationController().createNodeAt(type, worldX, worldY);
  }

  function createVideoDeriveFromNode(
    kind: "extend" | "edit",
    sourceNode: NodeData | null,
    worldX: number,
    worldY: number,
  ) {
    return context
      .nodeCreationController()
      .createVideoDeriveFromNode(kind, sourceNode, worldX, worldY);
  }

  function createVideoDraftNode(x: number, y: number) {
    return context.nodeCreationController().createVideoDraftNode(x, y);
  }

  function createDraftFinalNode(source: NodeData) {
    return context.nodeCreationController().createDraftFinalNode(source);
  }

  async function executeDraftWithApproval(
    node: NodeData,
    request: Record<string, unknown>,
    attemptId: string,
  ) {
    return context
      .nodeCreationController()
      .executeDraftWithApproval(node, request, attemptId);
  }

  async function submitDraftFinalNode(node: NodeData): Promise<boolean> {
    return context.nodeCreationController().submitDraftFinalNode(node);
  }

  function startEditNodeTitle(node: NodeData) {
    return context.nodeOperationsController().startEditNodeTitle(node);
  }

  function commitNodeTitle(nodeId: string, fallbackTitle: string) {
    return context
      .nodeOperationsController()
      .commitNodeTitle(nodeId, fallbackTitle);
  }

  function cancelNodeTitleEdit() {
    return context.nodeOperationsController().cancelNodeTitleEdit();
  }

  function startEditGroupTitle(group: GroupData) {
    return context.nodeOperationsController().startEditGroupTitle(group);
  }

  function commitGroupTitle(groupId: string, fallbackTitle: string) {
    return context
      .nodeOperationsController()
      .commitGroupTitle(groupId, fallbackTitle);
  }

  function cancelGroupTitleEdit() {
    return context.nodeOperationsController().cancelGroupTitleEdit();
  }

  function beginGroupDrag(
    group: GroupData,
    startWorldX: number,
    startWorldY: number,
    startBounds: Rect,
  ) {
    return context
      .nodeOperationsController()
      .beginGroupDrag(group, startWorldX, startWorldY, startBounds);
  }

  function focusNodeInViewport(nodeId: string) {
    return context.viewportController().focusNodeInViewport(nodeId);
  }

  function focusNodeInViewportAtScale(nodeId: string, scale: number) {
    return context
      .viewportController()
      .focusNodeInViewportAtScale(nodeId, scale);
  }

  function startSidebarRename(node: NodeData) {
    return context.nodeOperationsController().startSidebarRename(node);
  }

  async function commitSidebarRename(nodeId: string, fallbackTitle: string) {
    return context
      .nodeOperationsController()
      .commitSidebarRename(nodeId, fallbackTitle);
  }

  function cancelSidebarRename() {
    return context.nodeOperationsController().cancelSidebarRename();
  }

  async function duplicateNodeFromManager(nodeId: string) {
    return context.nodeOperationsController().duplicateNodeFromManager(nodeId);
  }

  async function duplicateSelectedNodes() {
    return context.nodeOperationsController().duplicateSelectedNodes();
  }

  function createGroupFromSelection() {
    return context.nodeOperationsController().createGroupFromSelection();
  }

  function ungroupActive() {
    return context.nodeOperationsController().ungroupActive();
  }

  function updateActiveGroup(patch: Partial<GroupData>) {
    return context.nodeOperationsController().updateActiveGroup(patch);
  }

  function applyLayoutToNodeIds(
    nodeIds: string[],
    mode: LayoutMode,
    anchorRect: Rect,
  ) {
    return context
      .nodeOperationsController()
      .applyLayoutToNodeIds(nodeIds, mode, anchorRect);
  }

  function applyGroupLayout(mode: LayoutMode) {
    return context.nodeOperationsController().applyGroupLayout(mode);
  }

  function applySelectionLayout(mode: LayoutMode) {
    return context.nodeOperationsController().applySelectionLayout(mode);
  }

  function setNodePatch(nodeId: string, patch: Partial<NodeData>) {
    return context.canvasNodeMutationController().setNodePatch(nodeId, patch);
  }

  function applyNodeMediaGeometry(
    nodeId: string,
    mediaWidth: number,
    mediaHeight: number,
    patch: Partial<NodeData> = {},
  ) {
    return context
      .canvasNodeMutationController()
      .applyNodeMediaGeometry(nodeId, mediaWidth, mediaHeight, patch);
  }

  function fitViewportToBounds(bounds: Rect | null, scaleCap = 1) {
    return context.viewportController().fitViewportToBounds(bounds, scaleCap);
  }

  function zoomCanvasBy(factor: number) {
    return context.viewportController().zoomCanvasBy(factor);
  }

  function openShortcutCreateMenu() {
    return context.canvasShortcutActions().openShortcutCreateMenu();
  }

  function connectSelectedNodesShortcut() {
    return context.canvasShortcutActions().connectSelectedNodesShortcut();
  }

  function createDuplicateFromNodeIds(
    sourceIds: string[],
    offsetX = 0,
    offsetY = 48,
  ) {
    return context
      .nodeOperationsController()
      .createDuplicateFromNodeIds(sourceIds, offsetX, offsetY);
  }

  function arrangeCanvasLeftPreview() {
    return context.nodeOperationsController().arrangeCanvasLeftPreview();
  }

  function restoreArrangeSnapshot() {
    return context.nodeOperationsController().restoreArrangeSnapshot();
  }

  function keepArrangeResult() {
    return context.nodeOperationsController().keepArrangeResult();
  }

  function getViewportWorldRect(
    nextViewport = context.canvasGraphStateModule.viewport,
  ): Rect | null {
    return context.viewportController().getViewportWorldRect(nextViewport);
  }

  function doesViewportContainNode(
    nextViewport = context.canvasGraphStateModule.viewport,
  ) {
    return context.viewportController().doesViewportContainNode(nextViewport);
  }

  function returnToCanvasContent() {
    return context.viewportController().returnToCanvasContent();
  }

  function buildMiniMapMetrics(
    width: number,
    height: number,
  ): MiniMapMetrics | null {
    return context.viewportController().buildMiniMapMetrics(width, height);
  }

  function readMiniMapSurfaceBox() {
    return context.viewportController().readMiniMapSurfaceBox();
  }

  function updateViewportFromMiniMap(
    clientX: number,
    clientY: number,
    rect: { left: number; top: number; width: number; height: number },
  ) {
    return context
      .viewportController()
      .updateViewportFromMiniMap(clientX, clientY, rect);
  }

  function toggleZoomMode() {
    return context.viewportController().toggleZoomMode();
  }

  function closeBottomPanels() {
    return context.canvasPanelActions().closeBottomPanels();
  }

  async function downloadSelectedMedia() {
    return context.groupExecutionController().downloadSelectedMedia();
  }

  function getGroupDownloadNodeIds(group: GroupData) {
    return context.groupExecutionController().getGroupDownloadNodeIds(group);
  }

  async function downloadNodeMedia(node: NodeData) {
    return context.groupExecutionController().downloadNodeMedia(node);
  }

  async function downloadMediaForNodeIds(nodeIds: string[]) {
    return context.groupExecutionController().downloadMediaForNodeIds(nodeIds);
  }

  function getNodesInsideGroupArea(group: GroupData) {
    return context.groupExecutionController().getNodesInsideGroupArea(group);
  }

  function isGroupExecutableNode(node: NodeData) {
    return context.groupExecutionController().isGroupExecutableNode(node);
  }

  function getGroupExecutionPlan(group: GroupData) {
    return context.groupExecutionController().getGroupExecutionPlan(group);
  }

  function openGroupExecutionDialog(
    group: GroupData,
    opener?: HTMLButtonElement,
  ) {
    return context
      .groupExecutionController()
      .openGroupExecutionDialog(group, opener);
  }

  function closeGroupExecutionDialog({ restoreFocus = true } = {}) {
    return context
      .groupExecutionController()
      .closeGroupExecutionDialog({ restoreFocus });
  }

  async function startGroupExecution() {
    return context.groupExecutionController().startGroupExecution();
  }

  function collectConnectedEdgeIds(startNodeId: string) {
    return new Set(
      context.canvasGraphStateModule.edges
        .filter(
          (edge) =>
            edge.fromNodeId === startNodeId || edge.toNodeId === startNodeId,
        )
        .map((edge) => edge.id),
    );
  }

  function openSidebarMenu() {
    return context.nodeOperationsController().openSidebarMenu();
  }

  function removeEdge(edgeId: string) {
    return context.nodeOperationsController().removeEdge(edgeId);
  }

  function videoStoryAttemptId() {
    return (
      globalThis.crypto?.randomUUID?.() ||
      `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
    );
  }

  function getProductScriptWorkflow(node: NodeData): ProductScriptWorkflow {
    return context.productScriptController().getProductScriptWorkflow(node);
  }

  function saveProductScriptWorkflow(
    nodeId: string,
    updater:
      | ProductScriptWorkflow
      | ((current: ProductScriptWorkflow) => ProductScriptWorkflow),
  ) {
    return context
      .productScriptController()
      .saveProductScriptWorkflow(nodeId, updater);
  }

  function advanceProductScriptProgress(
    nodeId: string,
    progress: number,
    stage?: ProductScriptStage,
  ) {
    return context
      .productScriptController()
      .advanceProductScriptProgress(nodeId, progress, stage);
  }

  function stopProductScriptProgressSimulation(nodeId: string) {
    return context
      .productScriptController()
      .stopProductScriptProgressSimulation(nodeId);
  }

  function startProductScriptProgressSimulation(nodeId: string, target = 92) {
    return context
      .productScriptController()
      .startProductScriptProgressSimulation(nodeId, target);
  }

  function hasAllProductScriptAssets(workflow: ProductScriptWorkflow) {
    return context
      .productScriptController()
      .hasAllProductScriptAssets(workflow);
  }

  function openProductScriptVideoUpload(nodeId: string) {
    return context
      .productScriptController()
      .openProductScriptVideoUpload(nodeId);
  }

  function openProductScriptAssetUpload(
    nodeId: string,
    kind: ProductScriptAssetKind,
  ) {
    return context
      .productScriptController()
      .openProductScriptAssetUpload(nodeId, kind);
  }

  async function handleProductScriptVideoUploadChange(
    event: React.ChangeEvent<HTMLInputElement>,
  ) {
    return context
      .productScriptController()
      .handleProductScriptVideoUploadChange(event);
  }

  async function handleProductScriptAssetUploadChange(
    event: React.ChangeEvent<HTMLInputElement>,
  ) {
    return context
      .productScriptController()
      .handleProductScriptAssetUploadChange(event);
  }

  async function submitProductViralAnalysis(
    nodeId: string,
    videoUrl?: string,
    title?: string,
  ) {
    return context
      .productScriptController()
      .submitProductViralAnalysis(nodeId, videoUrl, title);
  }

  async function submitProductAssetsAnalysis(nodeId: string) {
    return context
      .productScriptController()
      .submitProductAssetsAnalysis(nodeId);
  }

  async function submitProductStoryboardCompose(nodeId: string) {
    return context
      .productScriptController()
      .submitProductStoryboardCompose(nodeId);
  }

  function updateProductScriptShot(
    nodeId: string,
    rowIndex: number,
    field: keyof VideoStoryShot | string,
    value: string,
  ) {
    return context
      .productScriptController()
      .updateProductScriptShot(nodeId, rowIndex, field, value);
  }

  function updateProductStoryboardShot(
    nodeId: string,
    rowIndex: number,
    field: keyof ProductStoryboardShot | string,
    value: string,
  ) {
    return context
      .productScriptController()
      .updateProductStoryboardShot(nodeId, rowIndex, field, value);
  }

  function updateProductAnalysisText(
    nodeId: string,
    field: "overallStyle" | "sellingPoints" | "visualKeywords" | "avoidNotes",
    value: string,
  ) {
    return context
      .productScriptController()
      .updateProductAnalysisText(nodeId, field, value);
  }

  async function submitProductScriptVideoNode(videoNode: NodeData) {
    return context
      .productScriptController()
      .submitProductScriptVideoNode(videoNode);
  }

  async function generateProductScriptVideos(nodeId: string) {
    return context
      .productScriptController()
      .generateProductScriptVideos(nodeId);
  }

  function buildStoryboardSlotNode(
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
    filled: boolean,
    filledByUser = false,
  ) {
    return context
      .storyboardController()
      .buildStoryboardSlotNode(
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
        filled,
        filledByUser,
      );
  }

  function storyboardSlotDimensions(ratio: RatioKey) {
    return context.storyboardController().storyboardSlotDimensions(ratio);
  }

  function getStoryboardDisplayTitle(group: GroupData) {
    return context.storyboardController().getStoryboardDisplayTitle(group);
  }

  function getGroupDisplayTitle(group: GroupData) {
    return context.storyboardController().getGroupDisplayTitle(group);
  }

  function buildStoryboardGroupNodes(
    sourceNode: NodeData,
    selectedCellKeys: string[],
    rows: number,
    cols: number,
    ratio: RatioKey,
    stamp: number,
  ): NodeData[] {
    return context
      .storyboardController()
      .buildStoryboardGroupNodes(
        sourceNode,
        selectedCellKeys,
        rows,
        cols,
        ratio,
        stamp,
      );
  }

  function buildStoryboardGroupData(
    stamp: number,
    nodeIds: string[],
    title: string,
    groupType: StoryboardGroupType,
    rows: number,
    cols: number,
    ratio: RatioKey,
  ): GroupData {
    return context
      .storyboardController()
      .buildStoryboardGroupData(
        stamp,
        nodeIds,
        title,
        groupType,
        rows,
        cols,
        ratio,
      );
  }

  function mergeStoryboardGroupsShortcut() {
    return context.storyboardController().mergeStoryboardGroupsShortcut();
  }

  function rebuildStoryboardGroupStructure(
    group: GroupData,
    rows: number,
    cols: number,
    ratio: RatioKey,
  ) {
    return context
      .storyboardController()
      .rebuildStoryboardGroupStructure(group, rows, cols, ratio);
  }

  async function stitchStoryboardGroup(
    group: GroupData,
    resolution: StoryboardStitchResolution,
  ) {
    return context
      .storyboardController()
      .stitchStoryboardGroup(group, resolution);
  }

  function clearStoryboardFilledSlots(group: GroupData) {
    return context.storyboardController().clearStoryboardFilledSlots(group);
  }

  function convertStoryboardGroupToRegular(group: GroupData) {
    return context
      .storyboardController()
      .convertStoryboardGroupToRegular(group);
  }

  function toggleAudioNodePlayback(nodeId: string) {
    toggleAudioNodePlaybackExternal(
      nodeId,
      context.canvasRuntimeRefsModule.nodeAudioRefs.current,
    );
  }

  function getNodeVideoPosterUrl(node: NodeData) {
    return getNodeVideoPosterUrlExternal(node, getCanvasImagePreviewUrl);
  }

  function primeVideoPreviewFrame(node: NodeData, target: HTMLVideoElement) {
    return primeVideoPreviewFrameExternal(
      node,
      target,
      context.canvasRuntimeRefsModule.videoPreviewPrimedRef.current,
    );
  }

  function createTextVideoPresetGroup(sourceNodeId: string) {
    return context.presetController().createTextVideoPresetGroup(sourceNodeId);
  }

  function createEmptyImageNode(
    id: string,
    title: string,
    x: number,
    y: number,
    width: number,
    height: number,
    ratio: RatioKey,
  ): NodeData {
    return context
      .presetController()
      .createEmptyImageNode(id, title, x, y, width, height, ratio);
  }

  function createImageToImagePresetGroup(
    sourceNodeId: string,
    uploadedUrl: string,
    naturalWidth: number,
    naturalHeight: number,
    baseNodes?: NodeData[] | null,
  ) {
    return context
      .presetController()
      .createImageToImagePresetGroup(
        sourceNodeId,
        uploadedUrl,
        naturalWidth,
        naturalHeight,
        baseNodes,
      );
  }

  function createVideoFramePresetGroup(
    sourceNodeId: string,
    mode: "first" | "firstLast",
  ) {
    return context
      .presetController()
      .createVideoFramePresetGroup(sourceNodeId, mode);
  }

  function getModelGenerationUnavailableMessage(node: NodeData): string {
    return getModelGenerationUnavailableMessageExternal(node, {
      ...context.canvasModelCatalogStateModule,
      getNodeModelType,
      isAiModelSelectable,
    });
  }

  function clearNodeConnectionHold() {
    return context.interactionController().clearNodeConnectionHold();
  }

  function beginNodeConnectionHold(
    node: NodeData,
    event: React.MouseEvent<HTMLElement>,
  ) {
    return context.interactionController().beginNodeConnectionHold(node, event);
  }

  function beginNodeMove(node: NodeData, event: React.MouseEvent<HTMLElement>) {
    return context.interactionController().beginNodeMove(node, event);
  }

  function onCanvasMouseMove(event: React.MouseEvent<HTMLDivElement>) {
    return context.interactionController().onCanvasMouseMove(event);
  }

  function onCanvasMouseDown(event: React.MouseEvent<HTMLDivElement>) {
    return context.interactionController().onCanvasMouseDown(event);
  }

  function onCanvasMouseUp(event: React.MouseEvent<HTMLDivElement>) {
    return context.interactionController().onCanvasMouseUp(event);
  }

  function onCanvasDoubleClick(event: React.MouseEvent<HTMLDivElement>) {
    return context.interactionController().onCanvasDoubleClick(event);
  }

  function flushWheelPanDelta() {
    return context.interactionController().flushWheelPanDelta();
  }

  function scheduleWheelPan(deltaX: number, deltaY: number) {
    return context.interactionController().scheduleWheelPan(deltaX, deltaY);
  }

  function shouldIgnoreCanvasWheel(target: EventTarget | null) {
    return context.interactionController().shouldIgnoreCanvasWheel(target);
  }

  function onCanvasWheel(event: React.WheelEvent<HTMLDivElement>) {
    return context.interactionController().onCanvasWheel(event);
  }

  function handleCanvasEmptyLauncherAction(
    action: CanvasEmptyLauncherActionKey,
  ) {
    return context
      .canvasEmptyLauncherActions()
      .handleCanvasEmptyLauncherAction(action);
  }
  return {
    viewportVisualScale,
    markCanvasInteraction,
    getCanvasToolbarScale,
    getCanvasToolbarTop,
    toWorld,
    toScreen,
    nodeSocket,
    connectionSideToward,
    edgeHitToleranceInWorld,
    detectEdgeHover,
    edgeIntersectsRect,
    detectEdgeDropTarget,
    hasDuplicateEdge,
    admitCanvasReferenceEdge,
    openCreationMenuAtWorld,
    closeCreationMenu,
    createNodeAt,
    createVideoDeriveFromNode,
    createVideoDraftNode,
    createDraftFinalNode,
    executeDraftWithApproval,
    submitDraftFinalNode,
    startEditNodeTitle,
    commitNodeTitle,
    cancelNodeTitleEdit,
    startEditGroupTitle,
    commitGroupTitle,
    cancelGroupTitleEdit,
    beginGroupDrag,
    focusNodeInViewport,
    focusNodeInViewportAtScale,
    startSidebarRename,
    commitSidebarRename,
    cancelSidebarRename,
    duplicateNodeFromManager,
    duplicateSelectedNodes,
    createGroupFromSelection,
    ungroupActive,
    updateActiveGroup,
    applyLayoutToNodeIds,
    applyGroupLayout,
    applySelectionLayout,
    setNodePatch,
    applyNodeMediaGeometry,
    fitViewportToBounds,
    zoomCanvasBy,
    openShortcutCreateMenu,
    connectSelectedNodesShortcut,
    createDuplicateFromNodeIds,
    arrangeCanvasLeftPreview,
    restoreArrangeSnapshot,
    keepArrangeResult,
    getViewportWorldRect,
    doesViewportContainNode,
    returnToCanvasContent,
    buildMiniMapMetrics,
    readMiniMapSurfaceBox,
    updateViewportFromMiniMap,
    toggleZoomMode,
    closeBottomPanels,
    downloadSelectedMedia,
    getGroupDownloadNodeIds,
    downloadNodeMedia,
    downloadMediaForNodeIds,
    getNodesInsideGroupArea,
    isGroupExecutableNode,
    getGroupExecutionPlan,
    openGroupExecutionDialog,
    closeGroupExecutionDialog,
    startGroupExecution,
    collectConnectedEdgeIds,
    openSidebarMenu,
    removeEdge,
    videoStoryAttemptId,
    getProductScriptWorkflow,
    saveProductScriptWorkflow,
    advanceProductScriptProgress,
    stopProductScriptProgressSimulation,
    startProductScriptProgressSimulation,
    hasAllProductScriptAssets,
    openProductScriptVideoUpload,
    openProductScriptAssetUpload,
    handleProductScriptVideoUploadChange,
    handleProductScriptAssetUploadChange,
    submitProductViralAnalysis,
    submitProductAssetsAnalysis,
    submitProductStoryboardCompose,
    updateProductScriptShot,
    updateProductStoryboardShot,
    updateProductAnalysisText,
    submitProductScriptVideoNode,
    generateProductScriptVideos,
    buildStoryboardSlotNode,
    storyboardSlotDimensions,
    getStoryboardDisplayTitle,
    getGroupDisplayTitle,
    buildStoryboardGroupNodes,
    buildStoryboardGroupData,
    mergeStoryboardGroupsShortcut,
    rebuildStoryboardGroupStructure,
    stitchStoryboardGroup,
    clearStoryboardFilledSlots,
    convertStoryboardGroupToRegular,
    toggleAudioNodePlayback,
    getNodeVideoPosterUrl,
    primeVideoPreviewFrame,
    createTextVideoPresetGroup,
    createEmptyImageNode,
    createImageToImagePresetGroup,
    createVideoFramePresetGroup,
    getModelGenerationUnavailableMessage,
    clearNodeConnectionHold,
    beginNodeConnectionHold,
    beginNodeMove,
    onCanvasMouseMove,
    onCanvasMouseDown,
    onCanvasMouseUp,
    onCanvasDoubleClick,
    flushWheelPanDelta,
    scheduleWheelPan,
    shouldIgnoreCanvasWheel,
    onCanvasWheel,
    handleCanvasEmptyLauncherAction,
  };
}
