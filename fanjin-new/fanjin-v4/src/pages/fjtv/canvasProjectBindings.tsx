import {
  type AssetCatalogItem,
  type ProjectAssetCatalogItem,
} from "@/features/assets/assetCatalog";
import type * as Router from "react-router-dom";
import { createCanvasConflictActions } from "./canvasConflictActions";
import type {
  AssetSnapshot,
  AssetTemplate,
  CanvasHistorySnapshot,
  EdgeData,
  GroupData,
  HistoryAssetItem,
  NodeData,
  ProjectListItem,
  WorkflowTemplate,
} from "./canvasDataTypes";
import { createCanvasHistoryController } from "./canvasHistoryController";
import { createCanvasHistoryLoading } from "./canvasHistoryLoading";
import type { NodeType } from "./canvasMediaTypes";
import {
  buildPortraitReferenceNode,
  createNode,
  isAssetUri,
  normalizeAssetCategory,
  repairLegacyNodes,
  toTimestamp,
} from "./canvasNodeDefaults";
import {
  ASSET_SAVE_LOCATIONS,
  ASSET_STORAGE_KEY,
  ASSET_TAGS,
  GROUP_THEME_COLORS,
  LAST_ACTIVE_CANVAS_KEY,
  WORKFLOW_STORAGE_KEY,
} from "./canvasPageConstants";
import { createCanvasPersistenceController } from "./canvasPersistenceCoordinator";
import { createCanvasProjectAssetController } from "./canvasProjectAssetController";
import { createCanvasProjectController } from "./canvasProjectController";
import { createCanvasPublicationController } from "./canvasPublicationController";
import { createCanvasRouteActions } from "./canvasRouteActions";
import { createCanvasTemplateController } from "./canvasTemplateController";
import type { useCanvasAssetPanelState } from "./useCanvasAssetPanelState";
import type { useCanvasGraphState } from "./useCanvasGraphState";
import type { useCanvasGroupState } from "./useCanvasGroupState";
import type { useCanvasHistoryPanelState } from "./useCanvasHistoryPanelState";
import type { useCanvasLibraryView } from "./useCanvasLibraryView";
import type { useCanvasProjectRenameState } from "./useCanvasProjectRenameState";
import type { useCanvasProjectState } from "./useCanvasProjectState";
import type { useCanvasPromptState } from "./useCanvasPromptState";
import type { useCanvasPublicationState } from "./useCanvasPublicationState";
import type { useCanvasRuntimeRefs } from "./useCanvasRuntimeRefs";
import type { useCanvasSelectionState } from "./useCanvasSelectionState";
import type { useCanvasTemplateState } from "./useCanvasTemplateState";
export function bindCanvasRouteActions(
  readContext: () => {
    canvasRuntimeRefsModule: ReturnType<typeof useCanvasRuntimeRefs>;
    canvasSelectionStateModule: ReturnType<typeof useCanvasSelectionState>;
    canvasPromptStateModule: ReturnType<typeof useCanvasPromptState>;
    canvasAssetPanelStateModule: ReturnType<typeof useCanvasAssetPanelState>;
    canvasProjectStateModule: ReturnType<typeof useCanvasProjectState>;
    studioChrome: boolean;
    navigate: Router.NavigateFunction;
    location: Router.Location<any>;
    searchParams: URLSearchParams;
    canvasMeta: import("@/pages/fjtv/canvasDataTypes").CanvasMetaState;
    routeCanvasId: string | undefined;
    canvasGraphStateModule: ReturnType<
      typeof import("./useCanvasGraphState").useCanvasGraphState
    >;
    canvasGroupStateModule: ReturnType<
      typeof import("./useCanvasGroupState").useCanvasGroupState
    >;
    canvasViewportUiStateModule: ReturnType<
      typeof import("./useCanvasViewportUiState").useCanvasViewportUiState
    >;
    canvasProjectRenameStateModule: ReturnType<
      typeof import("./useCanvasProjectRenameState").useCanvasProjectRenameState
    >;
  },
) {
  const context = readContext();

  return createCanvasRouteActions({
    ...context.canvasRuntimeRefsModule,
    ...context.canvasSelectionStateModule,
    ...context.canvasPromptStateModule,
    ...context.canvasAssetPanelStateModule,
    ...context.canvasProjectStateModule,
    studioChrome: context.studioChrome,
    navigate: context.navigate,
    location: context.location,
    setNodes: context.canvasGraphStateModule.setNodes,
    setEdges: context.canvasGraphStateModule.setEdges,
    setGroups: context.canvasGroupStateModule.setGroups,
    setArrangeSnapshot: context.canvasViewportUiStateModule.setArrangeSnapshot,
    setArrangeConfirmOpen:
      context.canvasViewportUiStateModule.setArrangeConfirmOpen,
    setActiveGroupId: context.canvasGroupStateModule.setActiveGroupId,
    searchParams: context.searchParams,
    canvasMeta: context.canvasMeta,
    routeCanvasId: context.routeCanvasId,
    setProjectBrowserRenamingId:
      context.canvasProjectRenameStateModule.setProjectBrowserRenamingId,
    setProjectBrowserRenameDraft:
      context.canvasProjectRenameStateModule.setProjectBrowserRenameDraft,
  });
}

export function bindProjectController(
  readContext: () => {
    canvasRuntimeRefsModule: ReturnType<typeof useCanvasRuntimeRefs>;
    canvasProjectStateModule: ReturnType<typeof useCanvasProjectState>;
    canvasProjectRenameStateModule: ReturnType<
      typeof useCanvasProjectRenameState
    >;
    canvasMeta: import("@/pages/fjtv/canvasDataTypes").CanvasMetaState;
    sanitizeNodesForPersistence: (nextNodes: NodeData[]) => any;
    canDelete: boolean;
    navigateToCanvas: (canvasId: string, projectId?: string | null) => void;
    studioChrome: boolean;
    setCanvasMeta: React.Dispatch<
      React.SetStateAction<
        import("@/pages/fjtv/canvasDataTypes").CanvasMetaState
      >
    >;
    sanitizeNodeForPersistence: (node: NodeData) => NodeData;
    location: Router.Location<any>;
    selectedProjectId: number | null;
    boundSessionProjectId: number | null;
    removeSelectedProject: (id: string | number) => void;
    clearSelectedProject: () => void;
    clearCreationSession: () => void;
    resetCanvasRuntimeState: () => void;
    navigate: Router.NavigateFunction;
    openProjectBrowser: (preserveCanvas?: boolean) => void;
    canvasLibraryViewModule: ReturnType<
      typeof import("./useCanvasLibraryView").useCanvasLibraryView
    >;
    canvasPromptStateModule: ReturnType<
      typeof import("./useCanvasPromptState").useCanvasPromptState
    >;
    canvasGraphStateModule: ReturnType<
      typeof import("./useCanvasGraphState").useCanvasGraphState
    >;
    canvasSelectionStateModule: ReturnType<
      typeof import("./useCanvasSelectionState").useCanvasSelectionState
    >;
  },
) {
  const context = readContext();

  return createCanvasProjectController({
    ...context.canvasRuntimeRefsModule,
    ...context.canvasProjectStateModule,
    ...context.canvasProjectRenameStateModule,
    currentProject: context.canvasLibraryViewModule.currentProject,
    canvasMeta: context.canvasMeta,
    setStatus: context.canvasPromptStateModule.setStatus,
    nodes: context.canvasGraphStateModule.nodes,
    edges: context.canvasGraphStateModule.edges,
    sanitizeNodesForPersistence: context.sanitizeNodesForPersistence,
    canDelete: context.canDelete,
    navigateToCanvas: context.navigateToCanvas,
    studioChrome: context.studioChrome,
    setCanvasMeta: context.setCanvasMeta,
    setCanvasConflict: context.canvasSelectionStateModule.setCanvasConflict,
    setCanvasSaveState: context.canvasSelectionStateModule.setCanvasSaveState,
    repairLegacyNodes,
    sanitizeNodeForPersistence: context.sanitizeNodeForPersistence,
    location: context.location,
    selectedProjectId: context.selectedProjectId,
    boundSessionProjectId: context.boundSessionProjectId,
    removeSelectedProject: context.removeSelectedProject,
    clearSelectedProject: context.clearSelectedProject,
    clearCreationSession: context.clearCreationSession,
    LAST_ACTIVE_CANVAS_KEY,
    resetCanvasRuntimeState: context.resetCanvasRuntimeState,
    navigate: context.navigate,
    openProjectBrowser: context.openProjectBrowser,
  });
}

export function bindPersistenceController(
  readContext: () => {
    canvasRuntimeRefsModule: ReturnType<typeof useCanvasRuntimeRefs>;
    canvasGraphStateModule: ReturnType<typeof useCanvasGraphState>;
    ensureApiKeyReady: () => boolean;
    canvasMeta: import("@/pages/fjtv/canvasDataTypes").CanvasMetaState;
    studioChrome: boolean;
    selectedProjectId: number | null;
    routeCanvasId: string | undefined;
    location: Router.Location<any>;
    navigate: Router.NavigateFunction;
    setCanvasMeta: React.Dispatch<
      React.SetStateAction<
        import("@/pages/fjtv/canvasDataTypes").CanvasMetaState
      >
    >;
    latestCanvasSaveInputRef: React.RefObject<{
      edges: EdgeData[];
      groups: GroupData[];
      name: string;
    }>;
    canvasHistoryController: () => {
      buildHistorySnapshot: (
        nextNodes?: NodeData[],
        nextEdges?: EdgeData[],
        nextGroups?: GroupData[],
        nextViewport?: import("@/pages/fjtv/canvasDataTypes").ViewportState,
      ) => CanvasHistorySnapshot;
      recordCanvasHistoryMutation: (
        snapshot: CanvasHistorySnapshot,
        previousSnapshot?: CanvasHistorySnapshot,
      ) => void;
      applyHistorySnapshot: (snapshot: CanvasHistorySnapshot) => void;
      undoCanvas: () => void;
      redoCanvas: () => void;
    };
    canvasProjectStateModule: ReturnType<
      typeof import("./useCanvasProjectState").useCanvasProjectState
    >;
    canvasPromptStateModule: ReturnType<
      typeof import("./useCanvasPromptState").useCanvasPromptState
    >;
    canvasSelectionStateModule: ReturnType<
      typeof import("./useCanvasSelectionState").useCanvasSelectionState
    >;
    canvasGroupStateModule: ReturnType<
      typeof import("./useCanvasGroupState").useCanvasGroupState
    >;
  },
) {
  const context = readContext();

  return createCanvasPersistenceController({
    ...context.canvasRuntimeRefsModule,
    ...context.canvasGraphStateModule,
    ensureApiKeyReady: context.ensureApiKeyReady,
    canvasMeta: context.canvasMeta,
    currentProjectId: context.canvasProjectStateModule.currentProjectId,
    routeProjectContextId:
      context.canvasProjectStateModule.routeProjectContextId,
    studioChrome: context.studioChrome,
    selectedProjectId: context.selectedProjectId,
    setStatus: context.canvasPromptStateModule.setStatus,
    routeCanvasId: context.routeCanvasId,
    location: context.location,
    navigate: context.navigate,
    setCanvasConflict: context.canvasSelectionStateModule.setCanvasConflict,
    setCanvasSaveState: context.canvasSelectionStateModule.setCanvasSaveState,
    setCanvasMeta: context.setCanvasMeta,
    latestCanvasSaveInputRef: context.latestCanvasSaveInputRef,
    groups: context.canvasGroupStateModule.groups,
    canvasHistoryController: context.canvasHistoryController,
  });
}

export function bindTemplateController(
  readContext: () => {
    canvasGraphStateModule: ReturnType<typeof useCanvasGraphState>;
    canvasSelectionStateModule: ReturnType<typeof useCanvasSelectionState>;
    canvasTemplateStateModule: ReturnType<typeof useCanvasTemplateState>;
    canvasAssetPanelStateModule: ReturnType<typeof useCanvasAssetPanelState>;
    canvasProjectRenameStateModule: ReturnType<
      typeof useCanvasProjectRenameState
    >;
    canvasLibraryViewModule: ReturnType<typeof useCanvasLibraryView>;
    toWorld: (clientX: number, clientY: number) => { x: number; y: number };
    canDelete: boolean;
    nodeSerialCounter: Record<NodeType, number>;
    setNodeSerialCounter: React.Dispatch<
      React.SetStateAction<Record<NodeType, number>>
    >;
    persistCanvas: (
      nextNodes?: NodeData[],
      nextEdges?: EdgeData[],
      nextName?: string,
      nextGroups?: GroupData[],
    ) => any;
    canvasVisibilityViewModule: ReturnType<
      typeof import("./useCanvasVisibilityView").useCanvasVisibilityView
    >;
    canvasPromptStateModule: ReturnType<
      typeof import("./useCanvasPromptState").useCanvasPromptState
    >;
    canvasRuntimeRefsModule: ReturnType<
      typeof import("./useCanvasRuntimeRefs").useCanvasRuntimeRefs
    >;
    canvasGroupStateModule: ReturnType<
      typeof import("./useCanvasGroupState").useCanvasGroupState
    >;
  },
) {
  const context = readContext();

  return createCanvasTemplateController({
    ...context.canvasGraphStateModule,
    ...context.canvasSelectionStateModule,
    ...context.canvasTemplateStateModule,
    ...context.canvasAssetPanelStateModule,
    ...context.canvasProjectRenameStateModule,
    ...context.canvasLibraryViewModule,
    toTimestamp,
    repairLegacyNodes,
    GROUP_THEME_COLORS,
    normalizeAssetCategory,
    WORKFLOW_STORAGE_KEY,
    ASSET_STORAGE_KEY,
    activeGroupBounds: context.canvasVisibilityViewModule.activeGroupBounds,
    setStatus: context.canvasPromptStateModule.setStatus,
    rootRef: context.canvasRuntimeRefsModule.rootRef,
    toWorld: context.toWorld,
    setGroups: context.canvasGroupStateModule.setGroups,
    setActiveGroupId: context.canvasGroupStateModule.setActiveGroupId,
    canDelete: context.canDelete,
    ASSET_SAVE_LOCATIONS,
    ASSET_TAGS,
    isAssetUri,
    buildPortraitReferenceNode,
    nodeSerialCounter: context.nodeSerialCounter,
    createNode,
    setNodeSerialCounter: context.setNodeSerialCounter,
    persistCanvas: context.persistCanvas,
  });
}

export function bindProjectAssetController(
  readContext: () => {
    canvasHistoryPanelStateModule: ReturnType<
      typeof useCanvasHistoryPanelState
    >;
    canDelete: boolean;
    templateController: () => {
      normalizeWorkflowTemplate: (raw: any) => WorkflowTemplate;
      normalizeAssetTemplate: (raw: any) => AssetTemplate;
      workflowSignature: (template: WorkflowTemplate) => string;
      assetSignature: (template: AssetTemplate) => string;
      refreshWorkflowTemplates: () => Promise<{
        available: boolean;
        workflows: any;
      }>;
      loadAssetTemplates: (projectId: number) => Promise<any>;
      migrateLegacyWorkflowTemplates: (
        remoteWorkflows: WorkflowTemplate[],
      ) => Promise<any>;
      migrateLegacyAssetTemplates: (
        remoteAssets: AssetTemplate[],
        activeProjectId: number,
      ) => Promise<any>;
      openCreateWorkflowModal: () => void;
      createWorkflowFromGroup: () => Promise<void>;
      applyWorkflow: (template: WorkflowTemplate) => void;
      removeWorkflow: (id: string) => Promise<void>;
      openCreateAssetModal: () => void;
      openCreatePortraitAssetModal: () => void;
      createAssetFromSelection: () => Promise<void>;
      createPortraitAsset: () => Promise<void>;
      appendAssetSnapshot: (
        snapshot: AssetSnapshot,
        mode: "all" | "single",
        singleNodeId?: string,
        targetWorld?: { x: number; y: number },
      ) => void;
      applyAsset: (template: AssetTemplate) => void;
      appendProjectAssetCatalogItem: (
        item: ProjectAssetCatalogItem,
        targetWorld?: { x: number; y: number },
      ) => void;
      applyAssetCatalogItem: (
        item: AssetCatalogItem,
        targetWorld?: { x: number; y: number },
      ) => void;
      applySingleAssetNode: (template: AssetTemplate, nodeId: string) => void;
    };
    canvasPromptStateModule: ReturnType<
      typeof import("./useCanvasPromptState").useCanvasPromptState
    >;
  },
) {
  const context = readContext();

  return createCanvasProjectAssetController({
    ...context.canvasHistoryPanelStateModule,
    canDelete: context.canDelete,
    setStatus: context.canvasPromptStateModule.setStatus,
    templateController: context.templateController,
  });
}

export function bindCanvasHistoryController(
  readContext: () => {
    canvasRuntimeRefsModule: ReturnType<typeof useCanvasRuntimeRefs>;
    canvasGraphStateModule: ReturnType<typeof useCanvasGraphState>;
    canvasSelectionStateModule: ReturnType<typeof useCanvasSelectionState>;
    canvasGroupStateModule: ReturnType<typeof useCanvasGroupState>;
    closePromptMenus: () => void;
    canvasViewportUiStateModule: ReturnType<
      typeof import("./useCanvasViewportUiState").useCanvasViewportUiState
    >;
    canvasPromptStateModule: ReturnType<
      typeof import("./useCanvasPromptState").useCanvasPromptState
    >;
  },
) {
  const context = readContext();

  return createCanvasHistoryController({
    ...context.canvasRuntimeRefsModule,
    ...context.canvasGraphStateModule,
    ...context.canvasSelectionStateModule,
    ...context.canvasGroupStateModule,
    closePromptMenus: context.closePromptMenus,
    setArrangeSnapshot: context.canvasViewportUiStateModule.setArrangeSnapshot,
    setStatus: context.canvasPromptStateModule.setStatus,
    setExpanded: context.canvasPromptStateModule.setExpanded,
    setArrangeConfirmOpen:
      context.canvasViewportUiStateModule.setArrangeConfirmOpen,
  });
}

export function bindPublicationController(
  readContext: () => {
    canvasProjectStateModule: ReturnType<typeof useCanvasProjectState>;
    canvasPublicationStateModule: ReturnType<typeof useCanvasPublicationState>;
    closeBottomPanels: () => void;
    canvasMeta: import("@/pages/fjtv/canvasDataTypes").CanvasMetaState;
    persistCanvas: (
      nextNodes?: NodeData[],
      nextEdges?: EdgeData[],
      nextName?: string,
      nextGroups?: GroupData[],
    ) => any;
    canvasCoverUrl: (nextNodes: NodeData[]) => any;
    canvasProjectRenameStateModule: ReturnType<
      typeof import("./useCanvasProjectRenameState").useCanvasProjectRenameState
    >;
    canvasGraphStateModule: ReturnType<
      typeof import("./useCanvasGraphState").useCanvasGraphState
    >;
    canvasGroupStateModule: ReturnType<
      typeof import("./useCanvasGroupState").useCanvasGroupState
    >;
    canvasPromptStateModule: ReturnType<
      typeof import("./useCanvasPromptState").useCanvasPromptState
    >;
  },
) {
  const context = readContext();

  return createCanvasPublicationController({
    ...context.canvasProjectStateModule,
    ...context.canvasPublicationStateModule,
    closeBottomPanels: context.closeBottomPanels,
    setCanvasShareOverlay:
      context.canvasProjectRenameStateModule.setCanvasShareOverlay,
    canvasShareTriggerRef:
      context.canvasProjectRenameStateModule.canvasShareTriggerRef,
    canvasMeta: context.canvasMeta,
    persistCanvas: context.persistCanvas,
    nodesRef: context.canvasGraphStateModule.nodesRef,
    edges: context.canvasGraphStateModule.edges,
    groups: context.canvasGroupStateModule.groups,
    setStatus: context.canvasPromptStateModule.setStatus,
    canvasCoverUrl: context.canvasCoverUrl,
  });
}

export function bindCanvasHistoryLoading(
  readContext: () => {
    ensureApiKeyReady: () => boolean;
    canvasHistoryPanelStateModule: ReturnType<
      typeof import("./useCanvasHistoryPanelState").useCanvasHistoryPanelState
    >;
    canvasPromptStateModule: ReturnType<
      typeof import("./useCanvasPromptState").useCanvasPromptState
    >;
  },
) {
  const context = readContext();

  return createCanvasHistoryLoading({
    ensureApiKeyReady: context.ensureApiKeyReady,
    setHistoryLoading: context.canvasHistoryPanelStateModule.setHistoryLoading,
    setHistoryItems: context.canvasHistoryPanelStateModule.setHistoryItems,
    setStatus: context.canvasPromptStateModule.setStatus,
  });
}

export function bindCanvasConflictActions(
  readContext: () => {
    canvasRuntimeRefsModule: ReturnType<typeof useCanvasRuntimeRefs>;
    canvasGraphStateModule: ReturnType<typeof useCanvasGraphState>;
    canvasSelectionStateModule: ReturnType<typeof useCanvasSelectionState>;
    initialBrief: string;
    resetCanvasRuntimeState: () => void;
    setCanvasMeta: React.Dispatch<
      React.SetStateAction<
        import("@/pages/fjtv/canvasDataTypes").CanvasMetaState
      >
    >;
    canvasMeta: import("@/pages/fjtv/canvasDataTypes").CanvasMetaState;
    canvasProjectStateModule: ReturnType<
      typeof import("./useCanvasProjectState").useCanvasProjectState
    >;
    canvasGroupStateModule: ReturnType<
      typeof import("./useCanvasGroupState").useCanvasGroupState
    >;
    canvasPromptStateModule: ReturnType<
      typeof import("./useCanvasPromptState").useCanvasPromptState
    >;
  },
) {
  const context = readContext();

  return createCanvasConflictActions({
    ...context.canvasRuntimeRefsModule,
    ...context.canvasGraphStateModule,
    ...context.canvasSelectionStateModule,
    routeProjectContextId:
      context.canvasProjectStateModule.routeProjectContextId,
    initialBrief: context.initialBrief,
    resetCanvasRuntimeState: context.resetCanvasRuntimeState,
    setGroups: context.canvasGroupStateModule.setGroups,
    setCurrentProjectId: context.canvasProjectStateModule.setCurrentProjectId,
    setCanvasMeta: context.setCanvasMeta,
    setStatus: context.canvasPromptStateModule.setStatus,
    canvasMeta: context.canvasMeta,
  });
}
