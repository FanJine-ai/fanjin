import {
  type AssetCatalogItem,
  type ProjectAssetCatalogItem,
} from "@/features/assets/assetCatalog";
import { type CanvasShareRecord } from "@/lib/api";
import type {
  AssetSnapshot,
  AssetTemplate,
  CanvasHistorySnapshot,
  EdgeData,
  GroupData,
  HistoryAssetItem,
  NodeData,
  ProjectCanvasItem,
  ProjectFolderItem,
  ProjectListItem,
  WorkflowTemplate,
} from "./canvasDataTypes";
import {
  bindCanvasConflictActions,
  bindCanvasHistoryLoading,
  bindCanvasRouteActions,
  bindPersistenceController,
  bindProjectAssetController,
  bindProjectController,
  bindPublicationController,
  bindTemplateController,
} from "./canvasProjectBindings";
export function createCanvasProjectActionBindings(context: {
  canvasRouteActions: () => ReturnType<typeof bindCanvasRouteActions>;
  projectController: () => ReturnType<typeof bindProjectController>;
  persistenceController: () => ReturnType<typeof bindPersistenceController>;
  latestCanvasSaveInputRef: React.RefObject<{
    edges: EdgeData[];
    groups: GroupData[];
    name: string;
  }>;
  templateController: () => ReturnType<typeof bindTemplateController>;
  projectAssetController: () => ReturnType<typeof bindProjectAssetController>;
  publicationController: () => ReturnType<typeof bindPublicationController>;
  canvasHistoryLoading: () => ReturnType<typeof bindCanvasHistoryLoading>;
  canvasConflictActions: () => ReturnType<typeof bindCanvasConflictActions>;
  canvasProjectStateModule: ReturnType<
    typeof import("./useCanvasProjectState").useCanvasProjectState
  >;
  canvasGraphStateModule: ReturnType<
    typeof import("./useCanvasGraphState").useCanvasGraphState
  >;
  canvasRuntimeRefsModule: ReturnType<
    typeof import("./useCanvasRuntimeRefs").useCanvasRuntimeRefs
  >;
  canvasGroupStateModule: ReturnType<
    typeof import("./useCanvasGroupState").useCanvasGroupState
  >;
}) {
  function assertCanvasOperationActive(
    expectedEpoch: number,
    signal?: AbortSignal,
  ) {
    return context
      .canvasRouteActions()
      .assertCanvasOperationActive(expectedEpoch, signal);
  }

  function invalidateCanvasPersistenceContext() {
    return context.canvasRouteActions().invalidateCanvasPersistenceContext();
  }

  function navigateToCanvas(
    canvasId: string,
    projectId: string | null = context.canvasProjectStateModule
      .currentProjectId,
  ) {
    return context.canvasRouteActions().navigateToCanvas(canvasId, projectId);
  }

  function resetCanvasRuntimeState() {
    return context.canvasRouteActions().resetCanvasRuntimeState();
  }

  function clearEntryQueryFlags(flagNames: string[]) {
    return context.canvasRouteActions().clearEntryQueryFlags(flagNames);
  }

  function openProjectBrowser(preserveCanvas = true) {
    return context.canvasRouteActions().openProjectBrowser(preserveCanvas);
  }

  function closeProjectBrowser() {
    return context.canvasRouteActions().closeProjectBrowser();
  }

  async function startHeaderProjectRename() {
    return context.projectController().startHeaderProjectRename();
  }

  function isEphemeralLocalUrl(value: string | undefined | null) {
    return context.persistenceController().isEphemeralLocalUrl(value);
  }

  function sanitizeNodeForPersistence(node: NodeData): NodeData {
    return context.persistenceController().sanitizeNodeForPersistence(node);
  }

  function sanitizeNodesForPersistence(nextNodes: NodeData[]) {
    return context
      .persistenceController()
      .sanitizeNodesForPersistence(nextNodes);
  }

  function canvasCoverUrl(nextNodes: NodeData[]) {
    return context.persistenceController().canvasCoverUrl(nextNodes);
  }

  async function persistCanvasOnce(
    nextNodes: NodeData[],
    nextEdges: EdgeData[],
    nextName: string,
    nextGroups: GroupData[],
    contextEpoch: number,
  ) {
    return context
      .persistenceController()
      .persistCanvasOnce(
        nextNodes,
        nextEdges,
        nextName,
        nextGroups,
        contextEpoch,
      );
  }

  function persistCanvas(
    nextNodes = context.canvasGraphStateModule.nodesRef.current,
    nextEdges = context.latestCanvasSaveInputRef.current.edges,
    nextName = context.latestCanvasSaveInputRef.current.name,
    nextGroups = context.latestCanvasSaveInputRef.current.groups,
  ) {
    return context
      .persistenceController()
      .persistCanvas(nextNodes, nextEdges, nextName, nextGroups);
  }

  function pickExternalNodePatch(remoteNode: NodeData) {
    return context.persistenceController().pickExternalNodePatch(remoteNode);
  }

  function externalValuesDiffer(localNode: NodeData, patch: Partial<NodeData>) {
    return context
      .persistenceController()
      .externalValuesDiffer(localNode, patch);
  }

  function hasLockedMediaAspect(node: Partial<NodeData>) {
    return context.persistenceController().hasLockedMediaAspect(node);
  }

  function normalizeExternalNodePatch(
    localNode: NodeData,
    patch: Partial<NodeData>,
  ) {
    return context
      .persistenceController()
      .normalizeExternalNodePatch(localNode, patch);
  }

  function mergeExternalCanvasSnapshot(
    remoteNodesRaw: any[],
    remoteEdgesRaw: any[],
  ) {
    return context
      .persistenceController()
      .mergeExternalCanvasSnapshot(remoteNodesRaw, remoteEdgesRaw);
  }

  function normalizeWorkflowTemplate(raw: any): WorkflowTemplate {
    return context.templateController().normalizeWorkflowTemplate(raw);
  }

  function normalizeAssetTemplate(raw: any): AssetTemplate {
    return context.templateController().normalizeAssetTemplate(raw);
  }

  function workflowSignature(template: WorkflowTemplate) {
    return context.templateController().workflowSignature(template);
  }

  function assetSignature(template: AssetTemplate) {
    return context.templateController().assetSignature(template);
  }

  async function refreshWorkflowTemplates() {
    return context.templateController().refreshWorkflowTemplates();
  }

  async function loadAssetTemplates(projectId: number) {
    return context.templateController().loadAssetTemplates(projectId);
  }

  async function migrateLegacyWorkflowTemplates(
    remoteWorkflows: WorkflowTemplate[],
  ) {
    return context
      .templateController()
      .migrateLegacyWorkflowTemplates(remoteWorkflows);
  }

  async function migrateLegacyAssetTemplates(
    remoteAssets: AssetTemplate[],
    activeProjectId: number,
  ) {
    return context
      .templateController()
      .migrateLegacyAssetTemplates(remoteAssets, activeProjectId);
  }

  function openCreateWorkflowModal() {
    return context.templateController().openCreateWorkflowModal();
  }

  async function createWorkflowFromGroup() {
    return context.templateController().createWorkflowFromGroup();
  }

  function applyWorkflow(template: WorkflowTemplate) {
    return context.templateController().applyWorkflow(template);
  }

  async function removeWorkflow(id: string) {
    return context.templateController().removeWorkflow(id);
  }

  function normalizeProjectFolder(raw: any): ProjectFolderItem {
    return context.projectController().normalizeProjectFolder(raw);
  }

  function normalizeProjectFolders(input: any): ProjectFolderItem[] {
    return context.projectController().normalizeProjectFolders(input);
  }

  async function ensureProjectCanvases(
    projectId: string,
    expectedContextEpoch = context.canvasRuntimeRefsModule.canvasContextEpochRef
      .current,
  ): Promise<ProjectCanvasItem[]> {
    return context
      .projectController()
      .ensureProjectCanvases(projectId, expectedContextEpoch);
  }

  async function refreshProjects({
    throwOnError = false,
  }: { throwOnError?: boolean } = {}) {
    return context.projectController().refreshProjects({ throwOnError });
  }

  async function refreshProjectFolders({
    throwOnError = false,
  }: { throwOnError?: boolean } = {}) {
    return context.projectController().refreshProjectFolders({ throwOnError });
  }

  async function commitHeaderProjectRename() {
    return context.projectController().commitHeaderProjectRename();
  }

  function cancelHeaderProjectRename() {
    return context.projectController().cancelHeaderProjectRename();
  }

  async function inferCurrentProjectForCanvas(canvasId: string) {
    return context.projectController().inferCurrentProjectForCanvas(canvasId);
  }

  async function openProjectById(projectId: string) {
    return context.projectController().openProjectById(projectId);
  }

  async function createNewProject() {
    return context.projectController().createNewProject();
  }

  async function ensureProjectContextForCanvasCreation() {
    return context.projectController().ensureProjectContextForCanvasCreation();
  }

  async function createNewCanvas() {
    return context.projectController().createNewCanvas();
  }

  async function commitCanvasRename(canvasId: string, fallbackName: string) {
    return context
      .projectController()
      .commitCanvasRename(canvasId, fallbackName);
  }

  function cancelCanvasRename() {
    return context.projectController().cancelCanvasRename();
  }

  function handleCanvasRenameKeyDown(
    event: React.KeyboardEvent<HTMLInputElement>,
    canvasId: string,
    fallbackName: string,
  ) {
    return context
      .projectController()
      .handleCanvasRenameKeyDown(event, canvasId, fallbackName);
  }

  async function createProjectFolder() {
    return context.projectController().createProjectFolder();
  }

  async function commitProjectBrowserRename(
    id: string,
    kind: "project" | "folder",
    fallbackName: string,
  ) {
    return context
      .projectController()
      .commitProjectBrowserRename(id, kind, fallbackName);
  }

  async function duplicateProjectItem(project: ProjectListItem) {
    return context.projectController().duplicateProjectItem(project);
  }

  async function moveProjectToFolder(projectId: string, folderId: string) {
    return context.projectController().moveProjectToFolder(projectId, folderId);
  }

  function requestDeleteProjectItem(projectId: string) {
    return context.projectController().requestDeleteProjectItem(projectId);
  }

  function closeProjectDeleteDialog({ restoreFocus = true } = {}) {
    return context
      .projectController()
      .closeProjectDeleteDialog({ restoreFocus });
  }

  async function confirmDeleteProjectItem() {
    return context.projectController().confirmDeleteProjectItem();
  }

  async function deleteFolderItem(folderId: string) {
    return context.projectController().deleteFolderItem(folderId);
  }

  function openCreateAssetModal() {
    return context.templateController().openCreateAssetModal();
  }

  function openCreatePortraitAssetModal() {
    return context.templateController().openCreatePortraitAssetModal();
  }

  async function deleteHistoryItem(item: HistoryAssetItem) {
    return context.projectAssetController().deleteHistoryItem(item);
  }

  async function createAssetFromSelection() {
    return context.templateController().createAssetFromSelection();
  }

  async function createPortraitAsset() {
    return context.templateController().createPortraitAsset();
  }

  function appendAssetSnapshot(
    snapshot: AssetSnapshot,
    mode: "all" | "single",
    singleNodeId?: string,
    targetWorld?: { x: number; y: number },
  ) {
    return context
      .projectAssetController()
      .appendAssetSnapshot(snapshot, mode, singleNodeId, targetWorld);
  }

  function applyAsset(template: AssetTemplate) {
    return context.templateController().applyAsset(template);
  }

  function appendProjectAssetCatalogItem(
    item: ProjectAssetCatalogItem,
    targetWorld?: { x: number; y: number },
  ) {
    return context
      .projectAssetController()
      .appendProjectAssetCatalogItem(item, targetWorld);
  }

  function applyAssetCatalogItem(
    item: AssetCatalogItem,
    targetWorld?: { x: number; y: number },
  ) {
    return context
      .projectAssetController()
      .applyAssetCatalogItem(item, targetWorld);
  }

  function applySingleAssetNode(template: AssetTemplate, nodeId: string) {
    return context
      .projectAssetController()
      .applySingleAssetNode(template, nodeId);
  }

  function buildHistorySnapshot(
    nextNodes = context.canvasGraphStateModule.nodes,
    nextEdges = context.canvasGraphStateModule.edges,
    nextGroups = context.canvasGroupStateModule.groups,
    nextViewport = context.canvasGraphStateModule.viewport,
  ): CanvasHistorySnapshot {
    return context
      .persistenceController()
      .buildHistorySnapshot(nextNodes, nextEdges, nextGroups, nextViewport);
  }

  function recordCanvasHistoryMutation(
    snapshot: CanvasHistorySnapshot,
    previousSnapshot?: CanvasHistorySnapshot,
  ) {
    return context
      .persistenceController()
      .recordCanvasHistoryMutation(snapshot, previousSnapshot);
  }

  function applyHistorySnapshot(snapshot: CanvasHistorySnapshot) {
    return context.persistenceController().applyHistorySnapshot(snapshot);
  }

  function undoCanvas() {
    return context.persistenceController().undoCanvas();
  }

  function redoCanvas() {
    return context.persistenceController().redoCanvas();
  }

  function openCanvasShareMenu() {
    return context.publicationController().openCanvasShareMenu();
  }

  function closeCanvasShareOverlay({ restoreFocus = true } = {}) {
    return context
      .publicationController()
      .closeCanvasShareOverlay({ restoreFocus });
  }

  function currentCanvasPublicationScope() {
    return context.publicationController().currentCanvasPublicationScope();
  }

  function canvasPublicationAttempt(kind: "share" | "fjtv", revision: number) {
    return context
      .publicationController()
      .canvasPublicationAttempt(kind, revision);
  }

  async function refreshCanvasPublications() {
    return context.publicationController().refreshCanvasPublications();
  }

  async function authoritativeCanvasPublicationIdentity() {
    return context
      .publicationController()
      .authoritativeCanvasPublicationIdentity();
  }

  function publicCanvasShareUrl(slug: string) {
    return context.publicationController().publicCanvasShareUrl(slug);
  }

  function publicFjtvUrl(slug: string) {
    return context.publicationController().publicFjtvUrl(slug);
  }

  async function createPublicCanvasShare() {
    return context.publicationController().createPublicCanvasShare();
  }

  async function submitCurrentCanvasToFjtv() {
    return context.publicationController().submitCurrentCanvasToFjtv();
  }

  async function revokePublicCanvasShare(share: CanvasShareRecord) {
    return context.publicationController().revokePublicCanvasShare(share);
  }

  async function loadHistoryItems() {
    return context.canvasHistoryLoading().loadHistoryItems();
  }

  function handleProjectBrowserRenameKeyDown(
    event: React.KeyboardEvent<HTMLInputElement>,
    id: string,
    kind: "project" | "folder",
    fallbackName: string,
  ) {
    return context
      .projectController()
      .handleProjectBrowserRenameKeyDown(event, id, kind, fallbackName);
  }

  function replaceCanvasFromServer(
    result: any,
    fallbackCanvasId: string,
    options?: { seedBrief?: boolean },
  ) {
    return context
      .canvasConflictActions()
      .replaceCanvasFromServer(result, fallbackCanvasId, options);
  }

  async function loadLatestCanvasAfterConflict() {
    return context.canvasConflictActions().loadLatestCanvasAfterConflict();
  }
  return {
    assertCanvasOperationActive,
    invalidateCanvasPersistenceContext,
    navigateToCanvas,
    resetCanvasRuntimeState,
    clearEntryQueryFlags,
    openProjectBrowser,
    closeProjectBrowser,
    startHeaderProjectRename,
    isEphemeralLocalUrl,
    sanitizeNodeForPersistence,
    sanitizeNodesForPersistence,
    canvasCoverUrl,
    persistCanvasOnce,
    persistCanvas,
    pickExternalNodePatch,
    externalValuesDiffer,
    hasLockedMediaAspect,
    normalizeExternalNodePatch,
    mergeExternalCanvasSnapshot,
    normalizeWorkflowTemplate,
    normalizeAssetTemplate,
    workflowSignature,
    assetSignature,
    refreshWorkflowTemplates,
    loadAssetTemplates,
    migrateLegacyWorkflowTemplates,
    migrateLegacyAssetTemplates,
    openCreateWorkflowModal,
    createWorkflowFromGroup,
    applyWorkflow,
    removeWorkflow,
    normalizeProjectFolder,
    normalizeProjectFolders,
    ensureProjectCanvases,
    refreshProjects,
    refreshProjectFolders,
    commitHeaderProjectRename,
    cancelHeaderProjectRename,
    inferCurrentProjectForCanvas,
    openProjectById,
    createNewProject,
    ensureProjectContextForCanvasCreation,
    createNewCanvas,
    commitCanvasRename,
    cancelCanvasRename,
    handleCanvasRenameKeyDown,
    createProjectFolder,
    commitProjectBrowserRename,
    duplicateProjectItem,
    moveProjectToFolder,
    requestDeleteProjectItem,
    closeProjectDeleteDialog,
    confirmDeleteProjectItem,
    deleteFolderItem,
    openCreateAssetModal,
    openCreatePortraitAssetModal,
    deleteHistoryItem,
    createAssetFromSelection,
    createPortraitAsset,
    appendAssetSnapshot,
    applyAsset,
    appendProjectAssetCatalogItem,
    applyAssetCatalogItem,
    applySingleAssetNode,
    buildHistorySnapshot,
    recordCanvasHistoryMutation,
    applyHistorySnapshot,
    undoCanvas,
    redoCanvas,
    openCanvasShareMenu,
    closeCanvasShareOverlay,
    currentCanvasPublicationScope,
    canvasPublicationAttempt,
    refreshCanvasPublications,
    authoritativeCanvasPublicationIdentity,
    publicCanvasShareUrl,
    publicFjtvUrl,
    createPublicCanvasShare,
    submitCurrentCanvasToFjtv,
    revokePublicCanvasShare,
    loadHistoryItems,
    handleProjectBrowserRenameKeyDown,
    replaceCanvasFromServer,
    loadLatestCanvasAfterConflict,
  };
}
