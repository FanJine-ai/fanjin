import fanjinLogo from "@/assets/fanjin-logo-fj.svg";
import type * as Router from "react-router-dom";
import {
CANVAS_ASSET_MANAGER_WIDTH,
getCanvasEmptyLauncherColumnCount
} from "./canvasAdaptiveLayout";
import { CanvasAnimationStyles } from "./CanvasAnimationStyles";
import type { createCanvasChromeRenderBindings } from "./canvasChromeRenderBindings";
import { CanvasCreationMenuOverlay } from "./CanvasCreationMenuOverlay";
import type {
NodeData
} from "./canvasDataTypes";
import { CanvasDraftQuoteDialog } from "./CanvasDraftQuoteDialog";
import { CanvasEmptyLauncher } from "./CanvasEmptyLauncher";
import type { createCanvasGenerationActionBindings } from "./canvasGenerationActionBindings";
import type { createCanvasGraphActionBindings } from "./canvasGraphActionBindings";
import { CanvasHiddenUploadInputs } from "./CanvasHiddenUploadInputs";
import type { createCanvasMediaActionBindings } from "./canvasMediaActionBindings";
import type { createCanvasMediaRenderBindings } from "./canvasMediaRenderBindings";
import { CanvasMediaViewerOverlay } from "./CanvasMediaViewerOverlay";
import type { createCanvasNodeRenderBindings } from "./canvasNodeRenderBindings";
import { FIXED_UI_ZOOM } from "./canvasPageConstants";
import { CanvasPageHeader } from "./CanvasPageHeader";
import { CanvasPageLibraryPanels } from "./CanvasPageLibraryPanels";
import { CanvasPageNodeEditor } from "./CanvasPageNodeEditor";
import { CanvasPageProjectDialogs } from "./CanvasPageProjectDialogs";
import { CanvasPageToolbars } from "./CanvasPageToolbars";
import { CanvasPageWorkflowDialogs } from "./CanvasPageWorkflowDialogs";
import { CanvasPageWorld } from "./CanvasPageWorld";
import { CanvasPricingConfirmationDialog } from "./CanvasPricingConfirmationDialog";
import type { createCanvasProjectActionBindings } from "./canvasProjectActionBindings";
import type { createCanvasPromptRenderBindings } from "./canvasPromptRenderBindings";
import { CanvasRuntimeOverlays } from "./CanvasRuntimeOverlays";
import { CanvasThemeStyles } from "./CanvasThemeStyles";
import type { useCanvasActiveModelView } from "./useCanvasActiveModelView";
import type { useCanvasAssetPanelState } from "./useCanvasAssetPanelState";
import type { useCanvasConnectionState } from "./useCanvasConnectionState";
import type { useCanvasGenerationDebugState } from "./useCanvasGenerationDebugState";
import type { useCanvasGraphState } from "./useCanvasGraphState";
import type { useCanvasGroupState } from "./useCanvasGroupState";
import type { useCanvasHistoryPanelState } from "./useCanvasHistoryPanelState";
import type { useCanvasImageEditorState } from "./useCanvasImageEditorState";
import type { useCanvasInlineEditorView } from "./useCanvasInlineEditorView";
import type { useCanvasLibraryView } from "./useCanvasLibraryView";
import type { useCanvasPendingHistory } from "./useCanvasPendingHistory";
import type { useCanvasPlaybackState } from "./useCanvasPlaybackState";
import type { useCanvasPricingDecisions } from "./useCanvasPricingDecisions";
import type { useCanvasProjectRenameState } from "./useCanvasProjectRenameState";
import type { useCanvasProjectState } from "./useCanvasProjectState";
import type { useCanvasPromptState } from "./useCanvasPromptState";
import type { useCanvasPublicationState } from "./useCanvasPublicationState";
import type { useCanvasRuntimeRefs } from "./useCanvasRuntimeRefs";
import type { useCanvasSelectionState } from "./useCanvasSelectionState";
import type { useCanvasStoryboardState } from "./useCanvasStoryboardState";
import type { useCanvasTemplateState } from "./useCanvasTemplateState";
import type { useCanvasTitleEditorState } from "./useCanvasTitleEditorState";
import type { useCanvasViewportUiState } from "./useCanvasViewportUiState";
import type { useCanvasVisibilityView } from "./useCanvasVisibilityView";
export function CanvasPageLayout({ canvasRuntimeRefsModule, canvasGraphStateModule, canvasColorMode, canvasAssetPanelStateModule, studioChrome, canvasSelectionStateModule, canvasViewportUiStateModule, canvasGraphActionBindings, canvasGenerationActionBindings, canvasDotBackgroundStyle, canvasPricingDecisionsModule, canvasMediaRenderBindings, canvasNodeRenderBindings, studioProjectHeaderInAgent, studioProjectHeaderPortalTarget, canvasChromeRenderBindings, canvasProjectRenameStateModule, canvasPublicationStateModule, canvasCapabilities, canvasProjectActionBindings, canvasPromptStateModule, canvasLibraryViewModule, canvasBalance, switchCanvasColorMode, viewportMissingContent, canvasConnectionStateModule, canvasTemplateStateModule, canvasPendingHistoryModule, canvasHistoryPanelStateModule, canDelete, navigate, canvasMeta, projectAssetCatalogError, projectAssetCatalogLoading, canvasProjectStateModule, nodeMap, canvasVisibilityViewModule, groupToolbarCenterX, canvasStoryboardStateModule, canvasGroupStateModule, selectionToolbarCenterX, canvasFrameDashStyle, canvasTitleEditorStateModule, commitTextNodeEditing, interactionPerformanceMode, singleSelectedNodeId, canvasMediaActionBindings, startTextNodeEditing, canvasPlaybackStateModule, creationMenuScreen, availableModels, canvasInlineEditorViewModule, activeNode, canvasImageEditorStateModule, canvasPromptRenderBindings, canvasActiveModelViewModule, activeNodeModelOption, canvasGenerationDebugVisible, canvasGenerationDebugStateModule }: {
  canvasRuntimeRefsModule: ReturnType<typeof useCanvasRuntimeRefs>;
  canvasGraphStateModule: ReturnType<typeof useCanvasGraphState>;
  canvasColorMode: import("@/ui/theme").ThemeMode;
  canvasAssetPanelStateModule: ReturnType<typeof useCanvasAssetPanelState>;
  studioChrome: boolean;
  canvasSelectionStateModule: ReturnType<typeof useCanvasSelectionState>;
  canvasViewportUiStateModule: ReturnType<typeof useCanvasViewportUiState>;
  canvasGraphActionBindings: ReturnType<typeof createCanvasGraphActionBindings>;
  canvasGenerationActionBindings: ReturnType<typeof createCanvasGenerationActionBindings>;
  canvasDotBackgroundStyle: { readonly backgroundImage: `radial-gradient(circle, var(--studio-grid-dot, #d7dce5) ${number}px, transparent ${number}px)` | `radial-gradient(circle, var(--studio-grid-dot, #313131) ${number}px, transparent ${number}px)`; readonly backgroundPosition: `${number}px ${number}px`; readonly backgroundSize: `${number}px ${number}px`; };
  canvasPricingDecisionsModule: ReturnType<typeof useCanvasPricingDecisions>;
  canvasMediaRenderBindings: ReturnType<typeof createCanvasMediaRenderBindings>;
  canvasNodeRenderBindings: ReturnType<typeof createCanvasNodeRenderBindings>;
  studioProjectHeaderInAgent: boolean;
  studioProjectHeaderPortalTarget: HTMLElement | null;
  canvasChromeRenderBindings: ReturnType<typeof createCanvasChromeRenderBindings>;
  canvasProjectRenameStateModule: ReturnType<typeof useCanvasProjectRenameState>;
  canvasPublicationStateModule: ReturnType<typeof useCanvasPublicationState>;
  canvasCapabilities: import("@/pages/fjtv/canvasCapabilities").CanvasRealCapabilities;
  canvasProjectActionBindings: ReturnType<typeof createCanvasProjectActionBindings>;
  canvasPromptStateModule: ReturnType<typeof useCanvasPromptState>;
  canvasLibraryViewModule: ReturnType<typeof useCanvasLibraryView>;
  canvasBalance: { refresh: () => void; loading: boolean; error: string; availableMicros: number; reservedMicros: number; baselineMicros: number; spentMicros: number; percent: number; lastRechargeAt: number | null; };
  switchCanvasColorMode: (m: import("@/ui/theme").ThemeMode) => void;
  viewportMissingContent: boolean;
  canvasConnectionStateModule: ReturnType<typeof useCanvasConnectionState>;
  canvasTemplateStateModule: ReturnType<typeof useCanvasTemplateState>;
  canvasPendingHistoryModule: ReturnType<typeof useCanvasPendingHistory>;
  canvasHistoryPanelStateModule: ReturnType<typeof useCanvasHistoryPanelState>;
  canDelete: boolean;
  navigate: Router.NavigateFunction;
  canvasMeta: import("@/pages/fjtv/canvasDataTypes").CanvasMetaState;
  projectAssetCatalogError: import("@/api/http").ApiErrorView | null;
  projectAssetCatalogLoading: boolean;
  canvasProjectStateModule: ReturnType<typeof useCanvasProjectState>;
  nodeMap: Map<string, NodeData>;
  canvasVisibilityViewModule: ReturnType<typeof useCanvasVisibilityView>;
  groupToolbarCenterX: number | null;
  canvasStoryboardStateModule: ReturnType<typeof useCanvasStoryboardState>;
  canvasGroupStateModule: ReturnType<typeof useCanvasGroupState>;
  selectionToolbarCenterX: number | null;
  canvasFrameDashStyle: { readonly border: "none"; readonly backgroundImage: string; readonly backgroundPosition: "left top, left bottom, left top, right top"; readonly backgroundRepeat: "repeat-x, repeat-x, repeat-y, repeat-y"; readonly backgroundSize: `auto ${number}px, auto ${number}px, ${number}px auto, ${number}px auto`; readonly filter: "none"; };
  canvasTitleEditorStateModule: ReturnType<typeof useCanvasTitleEditorState>;
  commitTextNodeEditing: () => void;
  interactionPerformanceMode: boolean;
  singleSelectedNodeId: string | null;
  canvasMediaActionBindings: ReturnType<typeof createCanvasMediaActionBindings>;
  startTextNodeEditing: (node: NodeData) => void;
  canvasPlaybackStateModule: ReturnType<typeof useCanvasPlaybackState>;
  creationMenuScreen: { x: number; y: number; } | null;
  availableModels: import("@/lib/api").AiModelOption[];
  canvasInlineEditorViewModule: ReturnType<typeof useCanvasInlineEditorView>;
  activeNode: NodeData | null;
  canvasImageEditorStateModule: ReturnType<typeof useCanvasImageEditorState>;
  canvasPromptRenderBindings: ReturnType<typeof createCanvasPromptRenderBindings>;
  canvasActiveModelViewModule: ReturnType<typeof useCanvasActiveModelView>;
  activeNodeModelOption: import("@/lib/api").AiModelOption | undefined;
  canvasGenerationDebugVisible: boolean;
  canvasGenerationDebugStateModule: ReturnType<typeof useCanvasGenerationDebugState>;
}) {
const mediaViewerNode = canvasInlineEditorViewModule.mediaViewerNode;
  return (
    <div
      ref={canvasRuntimeRefsModule.rootRef}
      data-testid="infinite-canvas-root"
      data-node-count={canvasGraphStateModule.nodes.length}
      data-edge-count={canvasGraphStateModule.edges.length}
      data-project-theme={canvasColorMode}
      data-asset-manager-open={canvasAssetPanelStateModule.assetManagerOpen ? "true" : "false"}
      data-studio-chrome={studioChrome ? "true" : "false"}
      className={`mh-canvas-no-native-selection relative h-screen w-full overflow-hidden bg-[#171717] text-white ${canvasSelectionStateModule.middlePanning.active ? "cursor-grabbing" : canvasViewportUiStateModule.canvasPointerMode === "select" ? "cursor-crosshair" : "cursor-grab"}`}
      onMouseMove={canvasGraphActionBindings.onCanvasMouseMove}
      onMouseDown={canvasGraphActionBindings.onCanvasMouseDown}
      onMouseUp={canvasGraphActionBindings.onCanvasMouseUp}
      onDoubleClick={canvasGraphActionBindings.onCanvasDoubleClick}
      onWheel={canvasGraphActionBindings.onCanvasWheel}
      onDragOver={canvasGenerationActionBindings.handleCanvasDragOver}
      onDrop={canvasGenerationActionBindings.handleCanvasDrop}
    >
      <div className="canvas-grid-background pointer-events-none absolute inset-0" style={canvasDotBackgroundStyle} />
      {canvasPricingDecisionsModule.draftQuote ? <CanvasDraftQuoteDialog quote={canvasPricingDecisionsModule.draftQuote} dark={canvasColorMode === "dark"} onDecision={approved => { canvasPricingDecisionsModule.setDraftQuote(null); canvasPricingDecisionsModule.draftDecisionRef.current?.(approved); canvasPricingDecisionsModule.draftDecisionRef.current = null; }} /> : null}
      {canvasPricingDecisionsModule.pricingConfirmation ? <CanvasPricingConfirmationDialog confirmation={canvasPricingDecisionsModule.pricingConfirmation} dark={canvasColorMode === "dark"} onDecision={approved => { canvasPricingDecisionsModule.setPricingConfirmation(null); canvasPricingDecisionsModule.pricingDecisionRef.current?.(approved); canvasPricingDecisionsModule.pricingDecisionRef.current = null; }} /> : null}
      {canvasMediaRenderBindings.renderComposeEditor()}
      {canvasMediaRenderBindings.renderVideoStoryFullscreen()}
      {canvasNodeRenderBindings.renderProductScriptFullscreen()}
      <CanvasThemeStyles fixedUiZoom={FIXED_UI_ZOOM} />

      <CanvasPageHeader {...{
        studioChrome,
        studioProjectHeaderInAgent,
        studioProjectHeaderPortalTarget,
        renderProjectHeaderCluster: canvasChromeRenderBindings.renderProjectHeaderCluster,
        renderStudioHeaderActions: canvasChromeRenderBindings.renderStudioHeaderActions,
        canvasShareOverlay: canvasProjectRenameStateModule.canvasShareOverlay,
        canvasSharePopoverRef: canvasProjectRenameStateModule.canvasSharePopoverRef,
        canvasPublicationError: canvasPublicationStateModule.canvasPublicationError,
        canvasPublicationBusy: canvasPublicationStateModule.canvasPublicationBusy,
        canvasCapabilities,
        submitCurrentCanvasToFjtv: canvasProjectActionBindings.submitCurrentCanvasToFjtv,
        createPublicCanvasShare: canvasProjectActionBindings.createPublicCanvasShare,
        fjtvPublications: canvasPublicationStateModule.fjtvPublications,
        publicFjtvUrl: canvasProjectActionBindings.publicFjtvUrl,
        canvasPublicationLoading: canvasPublicationStateModule.canvasPublicationLoading,
        canvasShares: canvasPublicationStateModule.canvasShares,
        publicCanvasShareUrl: canvasProjectActionBindings.publicCanvasShareUrl,
        setStatus: canvasPromptStateModule.setStatus,
        revokePublicCanvasShare: canvasProjectActionBindings.revokePublicCanvasShare,
        accountBalanceLabel: canvasLibraryViewModule.accountBalanceLabel,
        canvasBalance,
        navigateFromCanvasPanel: canvasLibraryViewModule.navigateFromCanvasPanel,
        setCanvasShareOverlay: canvasProjectRenameStateModule.setCanvasShareOverlay,
        accountProfile: canvasLibraryViewModule.accountProfile,
        canvasColorMode,
        switchCanvasColorMode,
        handleCanvasLogout: canvasLibraryViewModule.handleCanvasLogout,
      }} />
      <CanvasPageToolbars {...{
        viewportMissingContent,
        returnToCanvasContent: canvasGraphActionBindings.returnToCanvasContent,
        studioChrome,
        assetManagerOpen: canvasAssetPanelStateModule.assetManagerOpen,
        toggleAssetManager: canvasAssetPanelStateModule.toggleAssetManager,
        canvasPointerMode: canvasViewportUiStateModule.canvasPointerMode,
        gridSnapEnabled: canvasViewportUiStateModule.gridSnapEnabled,
        viewport: canvasGraphStateModule.viewport,
        arrangeConfirmOpen: canvasViewportUiStateModule.arrangeConfirmOpen,
        arrangeSnapshot: canvasViewportUiStateModule.arrangeSnapshot,
        restoreArrangeSnapshot: canvasGraphActionBindings.restoreArrangeSnapshot,
        keepArrangeResult: canvasGraphActionBindings.keepArrangeResult,
        arrangeCanvasLeftPreview: canvasGraphActionBindings.arrangeCanvasLeftPreview,
        setCanvasPointerMode: canvasViewportUiStateModule.setCanvasPointerMode,
        setStatus: canvasPromptStateModule.setStatus,
        setGridSnapEnabled: canvasViewportUiStateModule.setGridSnapEnabled,
        toggleZoomMode: canvasGraphActionBindings.toggleZoomMode,
        miniMapOpen: canvasViewportUiStateModule.miniMapOpen,
        miniMapDragging: canvasViewportUiStateModule.miniMapDragging,
        setMiniMapOpen: canvasViewportUiStateModule.setMiniMapOpen,
        renderMiniMapSurface: canvasChromeRenderBindings.renderMiniMapSurface,
        creationMenu: canvasConnectionStateModule.creationMenu,
        workflowTemplatesAvailable: canvasTemplateStateModule.workflowTemplatesAvailable,
        workflowPanelOpen: canvasTemplateStateModule.workflowPanelOpen,
        assetManagerTab: canvasAssetPanelStateModule.assetManagerTab,
        historyPanelOpen: canvasProjectRenameStateModule.historyPanelOpen,
        shortcutPanelOpen: canvasProjectRenameStateModule.shortcutPanelOpen,
        pendingHistoryItems: canvasPendingHistoryModule.pendingHistoryItems,
        openSidebarMenu: canvasGraphActionBindings.openSidebarMenu,
        closeCreationMenu: canvasGraphActionBindings.closeCreationMenu,
        setHistoryPanelOpen: canvasProjectRenameStateModule.setHistoryPanelOpen,
        setShortcutPanelOpen: canvasProjectRenameStateModule.setShortcutPanelOpen,
        setWorkflowPanelOpen: canvasTemplateStateModule.setWorkflowPanelOpen,
        setAssetManagerOpen: canvasAssetPanelStateModule.setAssetManagerOpen,
        selectAssetManagerTab: canvasAssetPanelStateModule.selectAssetManagerTab,
        loadHistoryItems: canvasProjectActionBindings.loadHistoryItems,
      }} />

      <CanvasPageLibraryPanels {...{
        historyPanelOpen: canvasProjectRenameStateModule.historyPanelOpen,
        loadHistoryItems: canvasProjectActionBindings.loadHistoryItems,
        historyLoading: canvasHistoryPanelStateModule.historyLoading,
        setHistoryPanelOpen: canvasProjectRenameStateModule.setHistoryPanelOpen,
        historyItemsWithPending: canvasPendingHistoryModule.historyItemsWithPending,
        historyTab: canvasHistoryPanelStateModule.historyTab,
        setHistoryTab: canvasHistoryPanelStateModule.setHistoryTab,
        setHistoryPreviewItem: canvasHistoryPanelStateModule.setHistoryPreviewItem,
        pendingElapsedLabel: canvasPendingHistoryModule.pendingElapsedLabel,
        canDelete,
        deleteHistoryItem: canvasProjectActionBindings.deleteHistoryItem,
        addHistoryItemToCanvas: canvasGenerationActionBindings.addHistoryItemToCanvas,
        downloadHistoryItem: canvasGenerationActionBindings.downloadHistoryItem,
        historyPreviewItem: canvasHistoryPanelStateModule.historyPreviewItem,
        shortcutPanelOpen: canvasProjectRenameStateModule.shortcutPanelOpen,
        setShortcutPanelOpen: canvasProjectRenameStateModule.setShortcutPanelOpen,
        assetManagerOpen: canvasAssetPanelStateModule.assetManagerOpen,
        studioChrome,
        navigate,
        setAssetManagerOpen: canvasAssetPanelStateModule.setAssetManagerOpen,
        setOpenNodeMenuId: canvasAssetPanelStateModule.setOpenNodeMenuId,
        cancelSidebarRename: canvasGraphActionBindings.cancelSidebarRename,
        currentProject: canvasLibraryViewModule.currentProject,
        canvasMeta,
        assetManagerTab: canvasAssetPanelStateModule.assetManagerTab,
        handleAssetManagerTabKeyDown: canvasAssetPanelStateModule.handleAssetManagerTabKeyDown,
        selectAssetManagerTab: canvasAssetPanelStateModule.selectAssetManagerTab,
        canvasNodeSearch: canvasAssetPanelStateModule.canvasNodeSearch,
        setCanvasNodeSearch: canvasAssetPanelStateModule.setCanvasNodeSearch,
        openCreatePortraitAssetModal: canvasProjectActionBindings.openCreatePortraitAssetModal,
        projectAssetCatalogError,
        canvasAssetsError: canvasTemplateStateModule.canvasAssetsError,
        filteredCanvasNodes: canvasLibraryViewModule.filteredCanvasNodes,
        sidebarGroups: canvasLibraryViewModule.sidebarGroups,
        nodes: canvasGraphStateModule.nodes,
        renderCanvasSidebarNodeItem: canvasNodeRenderBindings.renderCanvasSidebarNodeItem,
        sidebarUngroupedNodes: canvasLibraryViewModule.sidebarUngroupedNodes,
        filteredAssetEntries: canvasLibraryViewModule.filteredAssetEntries,
        projectAssetCatalogLoading,
        canvasAssetsLoading: canvasTemplateStateModule.canvasAssetsLoading,
        effectiveAssetProjectId: canvasLibraryViewModule.effectiveAssetProjectId,
        setStatus: canvasPromptStateModule.setStatus,
        applyAssetCatalogItem: canvasProjectActionBindings.applyAssetCatalogItem,
        renderMiniMapSurface: canvasChromeRenderBindings.renderMiniMapSurface,
        zoomCanvasBy: canvasGraphActionBindings.zoomCanvasBy,
        viewport: canvasGraphStateModule.viewport,
        toggleZoomMode: canvasGraphActionBindings.toggleZoomMode,
        assetCatalogEntries: canvasLibraryViewModule.assetCatalogEntries,
      }} />

      <CanvasPageProjectDialogs {...{
        cancelGenerationConfirmNodeId: canvasProjectStateModule.cancelGenerationConfirmNodeId,
        nodeMap,
        cancelGenerationPending: canvasProjectStateModule.cancelGenerationPending,
        cancelGenerationReturnRef: canvasProjectStateModule.cancelGenerationReturnRef,
        closeCancelGenerationDialog: canvasGenerationActionBindings.closeCancelGenerationDialog,
        confirmCancelNodeGeneration: canvasGenerationActionBindings.confirmCancelNodeGeneration,
        projectDeleteConfirmId: canvasProjectStateModule.projectDeleteConfirmId,
        projectDeletePending: canvasProjectStateModule.projectDeletePending,
        canDelete,
        projectDeleteError: canvasProjectStateModule.projectDeleteError,
        projectDeleteCancelRef: canvasProjectStateModule.projectDeleteCancelRef,
        closeProjectDeleteDialog: canvasProjectActionBindings.closeProjectDeleteDialog,
        confirmDeleteProjectItem: canvasProjectActionBindings.confirmDeleteProjectItem,
        projectBrowserOpen: canvasProjectStateModule.projectBrowserOpen,
        canvasColorMode,
        folderCreateToastOpen: canvasProjectRenameStateModule.folderCreateToastOpen,
        setFolderCreateToastOpen: canvasProjectRenameStateModule.setFolderCreateToastOpen,
        closeProjectBrowser: canvasProjectActionBindings.closeProjectBrowser,
        createProjectFolder: canvasProjectActionBindings.createProjectFolder,
        projectsError: canvasProjectStateModule.projectsError,
        projectFoldersError: canvasProjectStateModule.projectFoldersError,
        refreshProjects: canvasProjectActionBindings.refreshProjects,
        refreshProjectFolders: canvasProjectActionBindings.refreshProjectFolders,
        projectsLoading: canvasProjectStateModule.projectsLoading,
        projectFoldersLoading: canvasProjectStateModule.projectFoldersLoading,
        projects: canvasProjectStateModule.projects,
        projectFolders: canvasProjectStateModule.projectFolders,
        createNewProject: canvasProjectActionBindings.createNewProject,
        projectBrowserFolderId: canvasProjectStateModule.projectBrowserFolderId,
        setProjectBrowserFolderId: canvasProjectStateModule.setProjectBrowserFolderId,
        projectBrowserRenamingId: canvasProjectRenameStateModule.projectBrowserRenamingId,
        projectBrowserRenameDraft: canvasProjectRenameStateModule.projectBrowserRenameDraft,
        setProjectBrowserRenameDraft: canvasProjectRenameStateModule.setProjectBrowserRenameDraft,
        commitProjectBrowserRename: canvasProjectActionBindings.commitProjectBrowserRename,
        handleProjectBrowserRenameKeyDown: canvasProjectActionBindings.handleProjectBrowserRenameKeyDown,
        setFolderActionMenuId: canvasProjectStateModule.setFolderActionMenuId,
        folderActionMenuId: canvasProjectStateModule.folderActionMenuId,
        setProjectBrowserRenamingId: canvasProjectRenameStateModule.setProjectBrowserRenamingId,
        deleteFolderItem: canvasProjectActionBindings.deleteFolderItem,
        visibleProjects: canvasLibraryViewModule.visibleProjects,
        openProjectById: canvasProjectActionBindings.openProjectById,
        setProjectActionMenuId: canvasProjectStateModule.setProjectActionMenuId,
        projectActionMenuId: canvasProjectStateModule.projectActionMenuId,
        duplicateProjectItem: canvasProjectActionBindings.duplicateProjectItem,
        moveProjectToFolder: canvasProjectActionBindings.moveProjectToFolder,
        requestDeleteProjectItem: canvasProjectActionBindings.requestDeleteProjectItem,
      }} />

      <CanvasAnimationStyles />

      {!canvasProjectStateModule.projectBrowserOpen && canvasGraphStateModule.nodes.length === 0 && (!studioChrome || Boolean(canvasMeta.canvasId && canvasProjectStateModule.activeProjectContextId)) ? (
        <CanvasEmptyLauncher
          logoSrc={fanjinLogo}
          columns={getCanvasEmptyLauncherColumnCount(canvasRuntimeRefsModule.canvasSurfaceWidth, canvasAssetPanelStateModule.assetManagerOpen)}
          leftOffset={canvasAssetPanelStateModule.assetManagerOpen ? Math.min(CANVAS_ASSET_MANAGER_WIDTH, canvasRuntimeRefsModule.canvasSurfaceWidth) : 0}
          onAction={canvasGraphActionBindings.handleCanvasEmptyLauncherAction}
        />
      ) : null}

      <CanvasPageWorld {...{
        activeGroupBounds: canvasVisibilityViewModule.activeGroupBounds,
        activeGroup: canvasLibraryViewModule.activeGroup,
        groupDrag: canvasSelectionStateModule.groupDrag,
        toWorld: canvasGraphActionBindings.toWorld,
        nodes: canvasGraphStateModule.nodes,
        setGroupDrag: canvasSelectionStateModule.setGroupDrag,
        setSelectedNodeIds: canvasSelectionStateModule.setSelectedNodeIds,
        setSelectedEdgeIds: canvasSelectionStateModule.setSelectedEdgeIds,
        setActiveNodeId: canvasSelectionStateModule.setActiveNodeId,
        activeGroupFullySelected: canvasVisibilityViewModule.activeGroupFullySelected,
        groupToolbarCenterX,
        getCanvasToolbarTop: canvasGraphActionBindings.getCanvasToolbarTop,
        getCanvasToolbarScale: canvasGraphActionBindings.getCanvasToolbarScale,
        setStoryboardToolbarRatioOpen: canvasStoryboardStateModule.setStoryboardToolbarRatioOpen,
        setStoryboardToolbarGridOpen: canvasStoryboardStateModule.setStoryboardToolbarGridOpen,
        setStoryboardToolbarStitchOpen: canvasStoryboardStateModule.setStoryboardToolbarStitchOpen,
        storyboardToolbarRatioOpen: canvasStoryboardStateModule.storyboardToolbarRatioOpen,
        rebuildStoryboardGroupStructure: canvasGraphActionBindings.rebuildStoryboardGroupStructure,
        storyboardToolbarGridOpen: canvasStoryboardStateModule.storyboardToolbarGridOpen,
        storyboardToolbarStitchOpen: canvasStoryboardStateModule.storyboardToolbarStitchOpen,
        setGroups: canvasGroupStateModule.setGroups,
        stitchStoryboardGroup: canvasGraphActionBindings.stitchStoryboardGroup,
        updateActiveGroup: canvasGraphActionBindings.updateActiveGroup,
        clearStoryboardFilledSlots: canvasGraphActionBindings.clearStoryboardFilledSlots,
        convertStoryboardGroupToRegular: canvasGraphActionBindings.convertStoryboardGroupToRegular,
        ungroupActive: canvasGraphActionBindings.ungroupActive,
        setColorPaletteOpen: canvasGroupStateModule.setColorPaletteOpen,
        setLayoutDropdownOpen: canvasGroupStateModule.setLayoutDropdownOpen,
        setSelectionLayoutMenuOpen: canvasGroupStateModule.setSelectionLayoutMenuOpen,
        colorPaletteOpen: canvasGroupStateModule.colorPaletteOpen,
        layoutDropdownOpen: canvasGroupStateModule.layoutDropdownOpen,
        applyGroupLayout: canvasGraphActionBindings.applyGroupLayout,
        groupExecutionDialog: canvasGroupStateModule.groupExecutionDialog,
        openGroupExecutionDialog: canvasGraphActionBindings.openGroupExecutionDialog,
        workflowTemplatesAvailable: canvasTemplateStateModule.workflowTemplatesAvailable,
        openCreateWorkflowModal: canvasProjectActionBindings.openCreateWorkflowModal,
        downloadMediaForNodeIds: canvasGraphActionBindings.downloadMediaForNodeIds,
        getGroupDownloadNodeIds: canvasGraphActionBindings.getGroupDownloadNodeIds,
        storyboardSlotMenuNodeId: canvasStoryboardStateModule.storyboardSlotMenuNodeId,
        storyboardSlotMenuPosition: canvasStoryboardStateModule.storyboardSlotMenuPosition,
        setStoryboardSlotUploadTargetNodeId: canvasStoryboardStateModule.setStoryboardSlotUploadTargetNodeId,
        setStoryboardSlotMenuNodeId: canvasStoryboardStateModule.setStoryboardSlotMenuNodeId,
        setStoryboardSlotMenuPosition: canvasStoryboardStateModule.setStoryboardSlotMenuPosition,
        storyboardSlotUploadInputRef: canvasRuntimeRefsModule.storyboardSlotUploadInputRef,
        setStoryboardHistoryTargetNodeId: canvasStoryboardStateModule.setStoryboardHistoryTargetNodeId,
        setHistoryPanelOpen: canvasProjectRenameStateModule.setHistoryPanelOpen,
        selectedBounds: canvasVisibilityViewModule.selectedBounds,
        selectedNodeIds: canvasSelectionStateModule.selectedNodeIds,
        selectionToolbarCenterX,
        canvasFrameDashStyle,
        selectionLayoutMenuOpen: canvasGroupStateModule.selectionLayoutMenuOpen,
        applySelectionLayout: canvasGraphActionBindings.applySelectionLayout,
        openCreateAssetModal: canvasProjectActionBindings.openCreateAssetModal,
        duplicateSelectedNodes: canvasGraphActionBindings.duplicateSelectedNodes,
        downloadSelectedMedia: canvasGraphActionBindings.downloadSelectedMedia,
        createGroupFromSelection: canvasGraphActionBindings.createGroupFromSelection,
        selectionBox: canvasSelectionStateModule.selectionBox,
        edgeHoverState: canvasConnectionStateModule.edgeHoverState,
        removeEdge: canvasGraphActionBindings.removeEdge,
        viewport: canvasGraphStateModule.viewport,
        viewportVisualScale: canvasGraphActionBindings.viewportVisualScale,
        groups: canvasGroupStateModule.groups,
        groupBoundsMap: canvasVisibilityViewModule.groupBoundsMap,
        activeGroupId: canvasGroupStateModule.activeGroupId,
        editingTextNodeId: canvasTitleEditorStateModule.editingTextNodeId,
        commitTextNodeEditing,
        beginGroupDrag: canvasGraphActionBindings.beginGroupDrag,
        closePromptMenus: canvasGenerationActionBindings.closePromptMenus,
        visibleEdges: canvasVisibilityViewModule.visibleEdges,
        nodeMap,
        nodeSocket: canvasGraphActionBindings.nodeSocket,
        selectedEdgeIds: canvasSelectionStateModule.selectedEdgeIds,
        animatedEdgeIds: canvasVisibilityViewModule.animatedEdgeIds,
        draftLine: canvasConnectionStateModule.draftLine,
        alignmentGuides: canvasConnectionStateModule.alignmentGuides,
        editingGroupTitleId: canvasTitleEditorStateModule.editingGroupTitleId,
        setActiveGroupId: canvasGroupStateModule.setActiveGroupId,
        editingGroupTitleDraft: canvasTitleEditorStateModule.editingGroupTitleDraft,
        setEditingGroupTitleDraft: canvasTitleEditorStateModule.setEditingGroupTitleDraft,
        commitGroupTitle: canvasGraphActionBindings.commitGroupTitle,
        cancelGroupTitleEdit: canvasGraphActionBindings.cancelGroupTitleEdit,
        startEditGroupTitle: canvasGraphActionBindings.startEditGroupTitle,
        getGroupDisplayTitle: canvasGraphActionBindings.getGroupDisplayTitle,
        visibleNodes: canvasVisibilityViewModule.visibleNodes,
        visibleNodeIdSet: canvasVisibilityViewModule.visibleNodeIdSet,
        interactionPerformanceMode,
        editingNodeTitleId: canvasTitleEditorStateModule.editingNodeTitleId,
        findStoryboardGroupByNodeId: canvasVisibilityViewModule.findStoryboardGroupByNodeId,
        singleSelectedNodeId,
        formatDurationLabel: canvasGenerationActionBindings.formatDurationLabel,
        activeNodeId: canvasSelectionStateModule.activeNodeId,
        renderNodeMediaToolbar: canvasNodeRenderBindings.renderNodeMediaToolbar,
        renderTextNodeDownloadButton: canvasNodeRenderBindings.renderTextNodeDownloadButton,
        renderRichTextNodeEditorToolbar: canvasNodeRenderBindings.renderRichTextNodeEditorToolbar,
        beginNodeMove: canvasGraphActionBindings.beginNodeMove,
        editingNodeTitleDraft: canvasTitleEditorStateModule.editingNodeTitleDraft,
        setEditingNodeTitleDraft: canvasTitleEditorStateModule.setEditingNodeTitleDraft,
        commitNodeTitle: canvasGraphActionBindings.commitNodeTitle,
        cancelNodeTitleEdit: canvasGraphActionBindings.cancelNodeTitleEdit,
        startEditNodeTitle: canvasGraphActionBindings.startEditNodeTitle,
        dragNode: canvasSelectionStateModule.dragNode,
        selectedNodeIdSet: canvasVisibilityViewModule.selectedNodeIdSet,
        ensureApiKeyReady: canvasGenerationActionBindings.ensureApiKeyReady,
        canvasContextEpochRef: canvasRuntimeRefsModule.canvasContextEpochRef,
        uploadFileIntoNode: canvasGenerationActionBindings.uploadFileIntoNode,
        createMediaNodeFromFile: canvasGenerationActionBindings.createMediaNodeFromFile,
        setHoverTextNodeId: canvasTitleEditorStateModule.setHoverTextNodeId,
        createDuplicateFromNodeIds: canvasGraphActionBindings.createDuplicateFromNodeIds,
        edges: canvasGraphStateModule.edges,
        recordCanvasHistoryMutation: canvasProjectActionBindings.recordCanvasHistoryMutation,
        buildHistorySnapshot: canvasProjectActionBindings.buildHistorySnapshot,
        setNodes: canvasGraphStateModule.setNodes,
        setEdges: canvasGraphStateModule.setEdges,
        setDragNode: canvasSelectionStateModule.setDragNode,
        beginNodeConnectionHold: canvasGraphActionBindings.beginNodeConnectionHold,
        openComposeEditor: canvasMediaActionBindings.openComposeEditor,
        startTextNodeEditing,
        renderLightweightMediaNode: canvasNodeRenderBindings.renderLightweightMediaNode,
        renderProductScriptNode: canvasNodeRenderBindings.renderProductScriptNode,
        canvasColorMode,
        getNodeVideoPosterUrl: canvasGraphActionBindings.getNodeVideoPosterUrl,
        videoNodePlaying: canvasPlaybackStateModule.videoNodePlaying,
        canvasPerformanceMode: canvasGraphStateModule.canvasPerformanceMode,
        nodeVideoRefs: canvasRuntimeRefsModule.nodeVideoRefs,
        setVideoNodeDurations: canvasPlaybackStateModule.setVideoNodeDurations,
        applyNodeMediaGeometry: canvasGraphActionBindings.applyNodeMediaGeometry,
        primeVideoPreviewFrame: canvasGraphActionBindings.primeVideoPreviewFrame,
        setVideoNodeCurrentTimes: canvasPlaybackStateModule.setVideoNodeCurrentTimes,
        setVideoNodeMuted: canvasPlaybackStateModule.setVideoNodeMuted,
        setVideoNodePlaying: canvasPlaybackStateModule.setVideoNodePlaying,
        renderInlineVideoControls: canvasMediaRenderBindings.renderInlineVideoControls,
        renderNodePlaceholder: canvasNodeRenderBindings.renderNodePlaceholder,
        renderNodeUploadOverlay: canvasNodeRenderBindings.renderNodeUploadOverlay,
        renderNodeGenerationOverlay: canvasNodeRenderBindings.renderNodeGenerationOverlay,
        renderNodeProgressChip: canvasNodeRenderBindings.renderNodeProgressChip,
        renderImageGridSplitOverlay: canvasMediaRenderBindings.renderImageGridSplitOverlay,
        renderImageOutpaintOverlay: canvasMediaRenderBindings.renderImageOutpaintOverlay,
        renderImageCropOverlay: canvasMediaRenderBindings.renderImageCropOverlay,
        renderVideoEraseRegionOverlay: canvasMediaRenderBindings.renderVideoEraseRegionOverlay,
        renderVideoSubtitleEraseBar: canvasMediaRenderBindings.renderVideoSubtitleEraseBar,
        renderImageGridSplitToolbar: canvasMediaRenderBindings.renderImageGridSplitToolbar,
        renderImageTransformEditor: canvasMediaRenderBindings.renderImageTransformEditor,
        renderVideoTrimEditor: canvasMediaRenderBindings.renderVideoTrimEditor,
        renderVideoStoryPanel: canvasMediaRenderBindings.renderVideoStoryPanel,
        setTextResize: canvasSelectionStateModule.setTextResize,
      }} />

      <CanvasCreationMenuOverlay open={canvasConnectionStateModule.creationMenu.open} screen={creationMenuScreen} source={canvasConnectionStateModule.creationMenu.source} sourceNodeType={canvasConnectionStateModule.creationMenu.sourceNodeType} sourceNodeId={canvasConnectionStateModule.creationMenu.sourceNodeId} nodes={canvasGraphStateModule.nodes} x={canvasConnectionStateModule.creationMenu.x} y={canvasConnectionStateModule.creationMenu.y} availableModels={availableModels} onHoverChange={canvasConnectionStateModule.setSidebarMenuHover} onCreateNode={canvasGraphActionBindings.createNodeAt} onCreateDraft={canvasGraphActionBindings.createVideoDraftNode} onCreateVideo={canvasGraphActionBindings.createVideoDeriveFromNode} onMaterial={() => { canvasAssetPanelStateModule.setAssetManagerOpen(true); canvasAssetPanelStateModule.selectAssetManagerTab("asset"); canvasGraphActionBindings.closeCreationMenu(); }} onUpload={canvasGenerationActionBindings.openQuickUploadAtCurrentMenu} onHistory={() => { canvasGraphActionBindings.closeCreationMenu(); canvasProjectRenameStateModule.setHistoryPanelOpen(true); void canvasProjectActionBindings.loadHistoryItems(); }} onClose={canvasGraphActionBindings.closeCreationMenu} />
      <CanvasHiddenUploadInputs quickRef={canvasRuntimeRefsModule.quickUploadInputRef} storyboardRef={canvasRuntimeRefsModule.storyboardSlotUploadInputRef} productVideoRef={canvasRuntimeRefsModule.productScriptVideoUploadInputRef} productAssetRef={canvasRuntimeRefsModule.productScriptAssetUploadInputRef} onQuick={canvasGenerationActionBindings.handleQuickUploadChange} onStoryboard={canvasGenerationActionBindings.handleStoryboardSlotUploadChange} onProductVideo={canvasGraphActionBindings.handleProductScriptVideoUploadChange} onProductAsset={canvasGraphActionBindings.handleProductScriptAssetUploadChange} />

      {mediaViewerNode ? <CanvasMediaViewerOverlay node={mediaViewerNode} mediaUrl={canvasMediaActionBindings.getNodeMediaUrl(mediaViewerNode)} onDownload={() => void canvasGraphActionBindings.downloadNodeMedia(mediaViewerNode)} onClose={() => canvasPromptStateModule.setMediaViewerNodeId(null)} /> : null}

      <CanvasPageNodeEditor {...{
        activeNode,
        controlsPos: canvasInlineEditorViewModule.controlsPos,
        draftLine: canvasConnectionStateModule.draftLine,
        creationMenu: canvasConnectionStateModule.creationMenu,
        editingTextNodeId: canvasTitleEditorStateModule.editingTextNodeId,
        activeNodeHasMedia: canvasInlineEditorViewModule.activeNodeHasMedia,
        activeImageOutpaint: canvasImageEditorStateModule.activeImageOutpaint,
        activeImageCrop: canvasImageEditorStateModule.activeImageCrop,
        fileInputRef: canvasRuntimeRefsModule.fileInputRef,
        handleUploadChange: canvasGenerationActionBindings.handleUploadChange,
        nodeEditorPresentation: canvasInlineEditorViewModule.nodeEditorPresentation,
        nodeUploadIsActive: canvasGenerationActionBindings.nodeUploadIsActive,
        renderCompactNodeEditorLauncher: canvasPromptRenderBindings.renderCompactNodeEditorLauncher,
        renderCollapsedPromptShell: canvasPromptRenderBindings.renderCollapsedPromptShell,
        renderVideoEnhancePanel: canvasMediaRenderBindings.renderVideoEnhancePanel,
        renderImageEnhancePanel: canvasMediaRenderBindings.renderImageEnhancePanel,
        setExpanded: canvasPromptStateModule.setExpanded,
        modelOpen: canvasPromptStateModule.modelOpen,
        videoSettingsOpen: canvasPromptStateModule.videoSettingsOpen,
        ratioOpen: canvasPromptStateModule.ratioOpen,
        quantityOpen: canvasPromptStateModule.quantityOpen,
        cameraOpen: canvasPromptStateModule.cameraOpen,
        referencePickerOpen: canvasPromptStateModule.referencePickerOpen,
        renderUpstreamReferenceStrip: canvasPromptRenderBindings.renderUpstreamReferenceStrip,
        renderCanvasArtifactSourcePicker: canvasNodeRenderBindings.renderCanvasArtifactSourcePicker,
        renderReferencePicker: canvasPromptRenderBindings.renderReferencePicker,
        renderPromptEditor: canvasPromptRenderBindings.renderPromptEditor,
        modelMenuOpenerRef: canvasPromptStateModule.modelMenuOpenerRef,
        setModelOpen: canvasPromptStateModule.setModelOpen,
        setRatioOpen: canvasPromptStateModule.setRatioOpen,
        setQuantityOpen: canvasPromptStateModule.setQuantityOpen,
        setCameraOpen: canvasPromptStateModule.setCameraOpen,
        activePromptModelLabel: canvasActiveModelViewModule.activePromptModelLabel,
        renderModelCatalogStatus: canvasPromptRenderBindings.renderModelCatalogStatus,
        activeNodeModelOptions: canvasActiveModelViewModule.activeNodeModelOptions,
        setActiveNodeModel: canvasGenerationActionBindings.setActiveNodeModel,
        activeNodeModelOption,
        setActiveNodeResolution: canvasGenerationActionBindings.setActiveNodeResolution,
        setActiveNodeRatio: canvasGenerationActionBindings.setActiveNodeRatio,
        renderImageOutputCountSelector: canvasPromptRenderBindings.renderImageOutputCountSelector,
        openCameraPanel: canvasGenerationActionBindings.openCameraPanel,
        activeNodeTotalPriceLabel: canvasActiveModelViewModule.activeNodeTotalPriceLabel,
        renderGenerateButton: canvasPromptRenderBindings.renderGenerateButton,
        renderVideoPromptTabs: canvasPromptRenderBindings.renderVideoPromptTabs,
        renderStoryboardVideoPrompt: canvasPromptRenderBindings.renderStoryboardVideoPrompt,
        activeStoryboardVideoInputs: canvasActiveModelViewModule.activeStoryboardVideoInputs,
        setVideoSettingsOpen: canvasPromptStateModule.setVideoSettingsOpen,
        videoSettingsTriggerRef: canvasPromptStateModule.videoSettingsTriggerRef,
        videoSettingsOpenerRef: canvasPromptStateModule.videoSettingsOpenerRef,
        setActiveNodeResolutionGeneric: canvasGenerationActionBindings.setActiveNodeResolutionGeneric,
        renderVideoOutputFormatPicker: canvasPromptRenderBindings.renderVideoOutputFormatPicker,
        parseDurationSeconds: canvasGenerationActionBindings.parseDurationSeconds,
        activeNodeVideoDurationCapability: canvasActiveModelViewModule.activeNodeVideoDurationCapability,
        setActiveNodeDuration: canvasGenerationActionBindings.setActiveNodeDuration,
        activeNodeVideoDurationMode: canvasActiveModelViewModule.activeNodeVideoDurationMode,
        setActiveNodeGenerateAudio: canvasGenerationActionBindings.setActiveNodeGenerateAudio,
        setNodePatch: canvasGraphActionBindings.setNodePatch,
        setStatus: canvasPromptStateModule.setStatus,
        renderCanvasArtifactToolbar: canvasNodeRenderBindings.renderCanvasArtifactToolbar,
        cameraSemanticsEnabled: canvasPromptStateModule.cameraSemanticsEnabled,
        setCameraSemanticsEnabled: canvasPromptStateModule.setCameraSemanticsEnabled,
        cameraDraft: canvasPromptStateModule.cameraDraft,
        cycleCameraDraft: canvasGenerationActionBindings.cycleCameraDraft,
        applyCameraDraft: canvasGenerationActionBindings.applyCameraDraft,
      }} />

      <CanvasPageWorkflowDialogs {...{
        assetCreateModalOpen: canvasTemplateStateModule.assetCreateModalOpen,
        assetCreateMode: canvasTemplateStateModule.assetCreateMode,
        setAssetCreateModalOpen: canvasTemplateStateModule.setAssetCreateModalOpen,
        portraitPreviewUrl: canvasTemplateStateModule.portraitPreviewUrl,
        assetName: canvasTemplateStateModule.assetName,
        portraitAssetUri: canvasTemplateStateModule.portraitAssetUri,
        nodes: canvasGraphStateModule.nodes,
        selectedNodeIds: canvasSelectionStateModule.selectedNodeIds,
        nodeMap,
        setAssetName: canvasTemplateStateModule.setAssetName,
        assetSaveLocation: canvasProjectRenameStateModule.assetSaveLocation,
        setAssetSaveLocation: canvasProjectRenameStateModule.setAssetSaveLocation,
        assetSaveTag: canvasProjectRenameStateModule.assetSaveTag,
        setAssetSaveTag: canvasProjectRenameStateModule.setAssetSaveTag,
        setPortraitAssetUri: canvasTemplateStateModule.setPortraitAssetUri,
        setPortraitPreviewUrl: canvasTemplateStateModule.setPortraitPreviewUrl,
        createPortraitAsset: canvasProjectActionBindings.createPortraitAsset,
        createAssetFromSelection: canvasProjectActionBindings.createAssetFromSelection,
        workflowTemplatesAvailable: canvasTemplateStateModule.workflowTemplatesAvailable,
        workflowPanelOpen: canvasTemplateStateModule.workflowPanelOpen,
        workflows: canvasTemplateStateModule.workflows,
        workflowsLoading: canvasTemplateStateModule.workflowsLoading,
        workflowsError: canvasTemplateStateModule.workflowsError,
        canDelete,
        setWorkflowPanelOpen: canvasTemplateStateModule.setWorkflowPanelOpen,
        refreshWorkflowTemplates: canvasProjectActionBindings.refreshWorkflowTemplates,
        migrateLegacyWorkflowTemplates: canvasProjectActionBindings.migrateLegacyWorkflowTemplates,
        setWorkflows: canvasTemplateStateModule.setWorkflows,
        removeWorkflow: canvasProjectActionBindings.removeWorkflow,
        applyWorkflow: canvasProjectActionBindings.applyWorkflow,
        renderGroupExecutionDialog: canvasChromeRenderBindings.renderGroupExecutionDialog,
        createWorkflowModalOpen: canvasTemplateStateModule.createWorkflowModalOpen,
        workflowCoverCandidates: canvasLibraryViewModule.workflowCoverCandidates,
        workflowCoverNodeId: canvasTemplateStateModule.workflowCoverNodeId,
        workflowName: canvasTemplateStateModule.workflowName,
        workflowNote: canvasTemplateStateModule.workflowNote,
        setCreateWorkflowModalOpen: canvasTemplateStateModule.setCreateWorkflowModalOpen,
        setWorkflowCoverNodeId: canvasTemplateStateModule.setWorkflowCoverNodeId,
        setWorkflowName: canvasTemplateStateModule.setWorkflowName,
        setWorkflowNote: canvasTemplateStateModule.setWorkflowNote,
        createWorkflowFromGroup: canvasProjectActionBindings.createWorkflowFromGroup,
      }} />

      <CanvasRuntimeOverlays showGate={studioChrome && !canvasProjectStateModule.projectBrowserOpen && canvasMeta.ready && !canvasMeta.loading && (!canvasMeta.canvasId || !canvasProjectStateModule.activeProjectContextId)} activeProjectId={canvasProjectStateModule.activeProjectContextId} onCreateCanvas={() => void canvasProjectActionBindings.createNewCanvas()} onOpenProjects={() => canvasProjectActionBindings.openProjectBrowser(false)} onCreateProject={() => void canvasProjectActionBindings.createNewProject()} conflict={canvasSelectionStateModule.canvasConflict} onReloadConflict={() => void canvasProjectActionBindings.loadLatestCanvasAfterConflict()} status={canvasPromptStateModule.status} portraitAssets={canvasActiveModelViewModule.activePortraitAdmissionAssets} portraitPolicy={canvasActiveModelViewModule.activePortraitVideoPolicy} portraitProjectId={canvasProjectStateModule.activeProjectContextId ? Number(canvasProjectStateModule.activeProjectContextId) : null} portraitModel={activeNode?.model} portraitTaskStatus={activeNode?.taskStatus} portraitLayout={canvasPromptStateModule.portraitAdmissionLayout} setPortraitLayout={canvasPromptStateModule.setPortraitAdmissionLayout} debugVisible={canvasGenerationDebugVisible} debug={canvasGenerationDebugStateModule.generateDebug} onCloseDebug={() => canvasGenerationDebugStateModule.setGenerateDebug(null)} />
    </div>
  );
}
