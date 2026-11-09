import { type AiModelOption } from "@/lib/api";
import type {
  CameraPresetKind,
  CanvasModelType,
  CanvasUploadRetry,
  HistoryAssetItem,
  NodeData,
  PromptReferenceRange,
  UpstreamReferenceItem,
  VideoGenerationMode,
} from "./canvasDataTypes";
import {
  bindCreateGenerationSessionController,
  bindCreateUploadController,
  bindGenerationActionsController,
  bindModelSettingsController,
  bindPromptEditingController,
  bindReferenceUploadController,
} from "./canvasGenerationBindings";
import type { RatioKey } from "./canvasMediaTypes";
import { type CanvasArtifactKind } from "./canvasTextArtifacts";
export function createCanvasGenerationActionBindings(context: {
  generationActionsController: () => ReturnType<
    typeof bindGenerationActionsController
  >;
  createGenerationSessionController: () => ReturnType<
    typeof bindCreateGenerationSessionController
  >;
  referenceUploadController: () => ReturnType<
    typeof bindReferenceUploadController
  >;
  modelSettingsController: () => ReturnType<typeof bindModelSettingsController>;
  promptEditingController: () => ReturnType<typeof bindPromptEditingController>;
  createUploadController: () => ReturnType<typeof bindCreateUploadController>;
}) {
  function markNodeSubmitting(nodeId: string) {
    return context.generationActionsController().markNodeSubmitting(nodeId);
  }

  function clearNodeSubmitting(nodeId: string) {
    return context.generationActionsController().clearNodeSubmitting(nodeId);
  }

  function nodeHasSubmittingSession(nodeId: string) {
    return context
      .generationActionsController()
      .nodeHasSubmittingSession(nodeId);
  }

  function submitButtonIsPending(key: string) {
    return context.generationActionsController().submitButtonIsPending(key);
  }

  function clearSubmitButtonPendingForNode(nodeId: string) {
    return context
      .generationActionsController()
      .clearSubmitButtonPendingForNode(nodeId);
  }

  async function runWithSubmitButtonPending(
    key: string,
    action: () => Promise<void> | void,
  ) {
    return context
      .generationActionsController()
      .runWithSubmitButtonPending(key, action);
  }

  function beginNodeGenerationSession(nodeId: string) {
    return context
      .createGenerationSessionController()
      .beginNodeGenerationSession(nodeId);
  }

  function isNodeGenerationSessionCurrent(nodeId: string, sessionId: string) {
    return context
      .createGenerationSessionController()
      .isNodeGenerationSessionCurrent(nodeId, sessionId);
  }

  function finishNodeGenerationSession(nodeId: string, sessionId?: string) {
    context
      .createGenerationSessionController()
      .finishNodeGenerationSession(nodeId, sessionId);
  }

  function stopNodeProgressTimer(nodeId: string) {
    return context.generationActionsController().stopNodeProgressTimer(nodeId);
  }

  function beginNodeProgressSimulation(
    nodeId: string,
    phase: "upload" | "generation",
  ) {
    return context
      .generationActionsController()
      .beginNodeProgressSimulation(nodeId, phase);
  }

  function finalizeNodeUploadVisual(nodeId: string, delayMs = 520) {
    return context
      .generationActionsController()
      .finalizeNodeUploadVisual(nodeId, delayMs);
  }

  function setNodeUploadProgress(nodeId: string, progress: number) {
    return context
      .generationActionsController()
      .setNodeUploadProgress(nodeId, progress);
  }

  function showNodeStatusChip(
    nodeId: string,
    text: string,
    tone: "neutral" | "success" | "error" = "neutral",
    durationMs = 2200,
  ) {
    return context
      .generationActionsController()
      .showNodeStatusChip(nodeId, text, tone, durationMs);
  }

  async function cancelNodeTransferOrGeneration(
    nodeId: string,
  ): Promise<boolean> {
    return context
      .generationActionsController()
      .cancelNodeTransferOrGeneration(nodeId);
  }

  async function retryNodeUpload(nodeId: string) {
    return context.generationActionsController().retryNodeUpload(nodeId);
  }

  async function cancelNodeGeneration(nodeId: string): Promise<boolean> {
    return context.generationActionsController().cancelNodeGeneration(nodeId);
  }

  function requestCancelNodeGeneration(nodeId: string) {
    return context
      .generationActionsController()
      .requestCancelNodeGeneration(nodeId);
  }

  function closeCancelGenerationDialog({ restoreFocus = true } = {}) {
    return context
      .generationActionsController()
      .closeCancelGenerationDialog({ restoreFocus });
  }

  async function confirmCancelNodeGeneration() {
    return context.generationActionsController().confirmCancelNodeGeneration();
  }

  function ensureApiKeyReady() {
    return context.generationActionsController().ensureApiKeyReady();
  }

  function rejectGenerate(nodeId: string | null | undefined, message: string) {
    return context
      .generationActionsController()
      .rejectGenerate(nodeId, message);
  }

  function nodeUploadIsActive(node: NodeData) {
    return context.generationActionsController().nodeUploadIsActive(node);
  }

  async function handleUploadChange(
    event: React.ChangeEvent<HTMLInputElement>,
  ) {
    return context.referenceUploadController().handleUploadChange(event);
  }

  function collectUpstreamImageUrls(nodeId: string) {
    return context.modelSettingsController().collectUpstreamImageUrls(nodeId);
  }

  function inferVideoRatioFromImageReferences(
    referenceNodes: NodeData[],
  ): RatioKey | null {
    return context
      .modelSettingsController()
      .inferVideoRatioFromImageReferences(referenceNodes);
  }

  function getImageNodeGeometry(node: NodeData | null | undefined) {
    return context.modelSettingsController().getImageNodeGeometry(node);
  }

  function inferImageReferenceGeometry(referenceNodes: NodeData[]) {
    return context
      .modelSettingsController()
      .inferImageReferenceGeometry(referenceNodes);
  }

  function shouldInheritVideoRatioFromReference(
    mode: VideoGenerationMode,
    node: NodeData,
    inferredRatio: RatioKey | null,
  ) {
    return context
      .modelSettingsController()
      .shouldInheritVideoRatioFromReference(mode, node, inferredRatio);
  }

  function parseDurationSeconds(raw?: string) {
    return context.modelSettingsController().parseDurationSeconds(raw);
  }

  function formatDurationLabel(seconds: number) {
    return context.modelSettingsController().formatDurationLabel(seconds);
  }

  function setActiveNodeResolution(next: "1K" | "2K" | "4K") {
    return context.modelSettingsController().setActiveNodeResolution(next);
  }

  function setActiveNodeResolutionGeneric(next: string) {
    return context
      .modelSettingsController()
      .setActiveNodeResolutionGeneric(next);
  }

  function setActiveNodeRatio(nextRatio: RatioKey) {
    return context.modelSettingsController().setActiveNodeRatio(nextRatio);
  }

  function resetSelectedExpandedTextNodes() {
    return context.modelSettingsController().resetSelectedExpandedTextNodes();
  }

  function setActiveNodeDuration(nextSeconds: number) {
    return context.modelSettingsController().setActiveNodeDuration(nextSeconds);
  }

  function setActiveNodeGenerateAudio(enabled: boolean) {
    return context
      .modelSettingsController()
      .setActiveNodeGenerateAudio(enabled);
  }

  function findSelectableCatalogModel(
    modelType: CanvasModelType,
    modelId?: string,
  ) {
    return context
      .modelSettingsController()
      .findSelectableCatalogModel(modelType, modelId);
  }

  function preflightCanvasModel(
    modelType: CanvasModelType,
    requestedModelId?: string,
    options: { allowCatalogDefault?: boolean; openPicker?: boolean } = {},
  ): AiModelOption | null {
    return context
      .modelSettingsController()
      .preflightCanvasModel(modelType, requestedModelId, options);
  }

  function setActiveNodeModel(model: AiModelOption) {
    return context.modelSettingsController().setActiveNodeModel(model);
  }

  function closePromptMenus() {
    return context.promptEditingController().closePromptMenus();
  }

  function bindPromptTextarea(element: HTMLTextAreaElement | null) {
    return context.promptEditingController().bindPromptTextarea(element);
  }

  function syncPromptEditorScroll(element: HTMLTextAreaElement | null) {
    return context.promptEditingController().syncPromptEditorScroll(element);
  }

  function rememberPromptSelection(element: HTMLTextAreaElement | null) {
    return context.promptEditingController().rememberPromptSelection(element);
  }

  function handlePromptInputChange(
    value: string,
    element: HTMLTextAreaElement,
  ) {
    return context
      .promptEditingController()
      .handlePromptInputChange(value, element);
  }

  function insertReferenceIntoPrompt(reference: UpstreamReferenceItem) {
    return context
      .promptEditingController()
      .insertReferenceIntoPrompt(reference);
  }

  function normalizePromptSelection(
    element: HTMLTextAreaElement | null,
    prompt: string,
  ) {
    return context
      .promptEditingController()
      .normalizePromptSelection(element, prompt);
  }

  function removePromptReferenceRange(range: PromptReferenceRange) {
    return context.promptEditingController().removePromptReferenceRange(range);
  }

  function handlePromptTextareaKeyDown(
    event: React.KeyboardEvent<HTMLTextAreaElement>,
  ) {
    return context.promptEditingController().handlePromptTextareaKeyDown(event);
  }

  async function createAndUploadVideoPoster(
    nodeId: string,
    videoUrl: string,
    fileName: string,
  ) {
    return context
      .referenceUploadController()
      .createAndUploadVideoPoster(nodeId, videoUrl, fileName);
  }

  function uploadFileIntoNode(
    nodeId: string,
    file: File,
    type: "image" | "video",
    options?: CanvasUploadRetry["options"],
  ) {
    return context
      .createUploadController()
      .uploadFileIntoNode(nodeId, file, type, options);
  }

  async function uploadMediaFileToRemote(
    file: File,
    type: "image" | "video",
    nodeId?: string,
  ) {
    return context
      .createUploadController()
      .uploadMediaFileToRemote(file, type, nodeId);
  }

  function buildReferenceResolutionSnapshot(node: NodeData | null | undefined) {
    return context
      .referenceUploadController()
      .buildReferenceResolutionSnapshot(node);
  }

  async function resolveNodeRemoteReferenceUrl(
    node: NodeData,
  ): Promise<string> {
    return context
      .referenceUploadController()
      .resolveNodeRemoteReferenceUrl(node);
  }

  async function ensureRemoteImageUrlForNode(node: NodeData): Promise<string> {
    return context
      .referenceUploadController()
      .ensureRemoteImageUrlForNode(node);
  }

  async function createMediaNodeFromFile(
    file: File,
    worldX: number,
    worldY: number,
  ) {
    return context
      .referenceUploadController()
      .createMediaNodeFromFile(file, worldX, worldY);
  }

  function openQuickUploadAtCurrentMenu() {
    return context.referenceUploadController().openQuickUploadAtCurrentMenu();
  }

  async function handleQuickUploadChange(
    event: React.ChangeEvent<HTMLInputElement>,
  ) {
    return context.referenceUploadController().handleQuickUploadChange(event);
  }

  function handleCanvasDragOver(event: React.DragEvent<HTMLDivElement>) {
    return context.referenceUploadController().handleCanvasDragOver(event);
  }

  function handleCanvasDrop(event: React.DragEvent<HTMLDivElement>) {
    return context.referenceUploadController().handleCanvasDrop(event);
  }

  function addHistoryItemToCanvas(item: HistoryAssetItem) {
    return context.referenceUploadController().addHistoryItemToCanvas(item);
  }

  async function handleStoryboardSlotUploadChange(
    event: React.ChangeEvent<HTMLInputElement>,
  ) {
    return context
      .referenceUploadController()
      .handleStoryboardSlotUploadChange(event);
  }

  function downloadHistoryItem(item: HistoryAssetItem) {
    return context.referenceUploadController().downloadHistoryItem(item);
  }

  function openCameraPanel() {
    return context.promptEditingController().openCameraPanel();
  }

  function cycleCameraDraft(kind: CameraPresetKind, direction: 1 | -1) {
    return context.promptEditingController().cycleCameraDraft(kind, direction);
  }

  function applyCameraDraft() {
    return context.promptEditingController().applyCameraDraft();
  }

  function clearCameraSemantics() {
    return context.promptEditingController().clearCameraSemantics();
  }

  async function applyTaskResultToNode(
    node: NodeData,
    taskData: any,
    sessionId?: string,
  ): Promise<boolean> {
    return context
      .generationActionsController()
      .applyTaskResultToNode(node, taskData, sessionId);
  }

  async function pollTaskUntilDone(
    taskId: string,
    node: NodeData,
    sessionId: string,
    startedAt = Date.now(),
    options?: { kind?: "generation" | "video_enhance"; queryFailures?: number },
  ): Promise<boolean> {
    return context
      .generationActionsController()
      .pollTaskUntilDone(taskId, node, sessionId, startedAt, options);
  }

  async function resolvePendingVideoBillingBeforeSubmit(
    node: NodeData,
    options?: { allowIdempotentRetryWithoutTaskId?: boolean },
  ): Promise<boolean> {
    return context
      .generationActionsController()
      .resolvePendingVideoBillingBeforeSubmit(node, options);
  }

  async function generateCanvasTextNode(
    node: NodeData,
    operation?: CanvasArtifactKind,
    newAttempt = false,
  ): Promise<boolean> {
    return context
      .generationActionsController()
      .generateCanvasTextNode(node, operation, newAttempt);
  }

  async function generateWithActiveNode(
    targetOverride?: NodeData,
  ): Promise<boolean> {
    return context
      .generationActionsController()
      .generateWithActiveNode(targetOverride);
  }
  return {
    markNodeSubmitting,
    clearNodeSubmitting,
    nodeHasSubmittingSession,
    submitButtonIsPending,
    clearSubmitButtonPendingForNode,
    runWithSubmitButtonPending,
    beginNodeGenerationSession,
    isNodeGenerationSessionCurrent,
    finishNodeGenerationSession,
    stopNodeProgressTimer,
    beginNodeProgressSimulation,
    finalizeNodeUploadVisual,
    setNodeUploadProgress,
    showNodeStatusChip,
    cancelNodeTransferOrGeneration,
    retryNodeUpload,
    cancelNodeGeneration,
    requestCancelNodeGeneration,
    closeCancelGenerationDialog,
    confirmCancelNodeGeneration,
    ensureApiKeyReady,
    rejectGenerate,
    nodeUploadIsActive,
    handleUploadChange,
    collectUpstreamImageUrls,
    inferVideoRatioFromImageReferences,
    getImageNodeGeometry,
    inferImageReferenceGeometry,
    shouldInheritVideoRatioFromReference,
    parseDurationSeconds,
    formatDurationLabel,
    setActiveNodeResolution,
    setActiveNodeResolutionGeneric,
    setActiveNodeRatio,
    resetSelectedExpandedTextNodes,
    setActiveNodeDuration,
    setActiveNodeGenerateAudio,
    findSelectableCatalogModel,
    preflightCanvasModel,
    setActiveNodeModel,
    closePromptMenus,
    bindPromptTextarea,
    syncPromptEditorScroll,
    rememberPromptSelection,
    handlePromptInputChange,
    insertReferenceIntoPrompt,
    normalizePromptSelection,
    removePromptReferenceRange,
    handlePromptTextareaKeyDown,
    createAndUploadVideoPoster,
    uploadFileIntoNode,
    uploadMediaFileToRemote,
    buildReferenceResolutionSnapshot,
    resolveNodeRemoteReferenceUrl,
    ensureRemoteImageUrlForNode,
    createMediaNodeFromFile,
    openQuickUploadAtCurrentMenu,
    handleQuickUploadChange,
    handleCanvasDragOver,
    handleCanvasDrop,
    addHistoryItemToCanvas,
    handleStoryboardSlotUploadChange,
    downloadHistoryItem,
    openCameraPanel,
    cycleCameraDraft,
    applyCameraDraft,
    clearCameraSemantics,
    applyTaskResultToNode,
    pollTaskUntilDone,
    resolvePendingVideoBillingBeforeSubmit,
    generateCanvasTextNode,
    generateWithActiveNode,
  };
}
