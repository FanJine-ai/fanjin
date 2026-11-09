import type * as Router from "react-router-dom";
import { createCanvasGenerationActionBindings } from "./canvasGenerationActionBindings";
import { createCanvasGraphActionBindings } from "./canvasGraphActionBindings";
import { createCanvasProjectActionBindings } from "./canvasProjectActionBindings";
import {
  bindCanvasConflictActions,
  bindCanvasHistoryController,
  bindCanvasHistoryLoading,
  bindCanvasRouteActions,
  bindPersistenceController,
  bindProjectAssetController,
  bindProjectController,
  bindPublicationController,
  bindTemplateController,
} from "./canvasProjectBindings";
import { useCanvasAssetPanelState } from "./useCanvasAssetPanelState";
import { useCanvasGraphState } from "./useCanvasGraphState";
import { useCanvasGroupState } from "./useCanvasGroupState";
import { useCanvasHistoryPanelState } from "./useCanvasHistoryPanelState";
import { useCanvasLibraryView } from "./useCanvasLibraryView";
import { useCanvasProjectRenameState } from "./useCanvasProjectRenameState";
import { useCanvasProjectState } from "./useCanvasProjectState";
import { useCanvasPromptState } from "./useCanvasPromptState";
import { useCanvasPublicationState } from "./useCanvasPublicationState";
import { useCanvasRuntimeRefs } from "./useCanvasRuntimeRefs";
import { useCanvasSelectionState } from "./useCanvasSelectionState";
import { useCanvasTemplateState } from "./useCanvasTemplateState";
import { useCanvasViewportUiState } from "./useCanvasViewportUiState";
import { useCanvasVisibilityView } from "./useCanvasVisibilityView";
export function createCanvasProjectControllers(
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
    canvasGraphStateModule: ReturnType<typeof useCanvasGraphState>;
    canvasGroupStateModule: ReturnType<typeof useCanvasGroupState>;
    canvasViewportUiStateModule: ReturnType<typeof useCanvasViewportUiState>;
    canvasProjectRenameStateModule: ReturnType<
      typeof useCanvasProjectRenameState
    >;
    canvasProjectActionBindings: ReturnType<
      typeof createCanvasProjectActionBindings
    >;
    canDelete: boolean;
    setCanvasMeta: React.Dispatch<
      React.SetStateAction<
        import("@/pages/fjtv/canvasDataTypes").CanvasMetaState
      >
    >;
    selectedProjectId: number | null;
    boundSessionProjectId: number | null;
    removeSelectedProject: (id: string | number) => void;
    clearSelectedProject: () => void;
    clearCreationSession: () => void;
    canvasLibraryViewModule: ReturnType<typeof useCanvasLibraryView>;
    canvasGenerationActionBindings: ReturnType<
      typeof createCanvasGenerationActionBindings
    >;
    latestCanvasSaveInputRef: React.RefObject<{
      edges: import("./canvasDataTypes").EdgeData[];
      groups: import("./canvasDataTypes").GroupData[];
      name: string;
    }>;
    canvasHistoryController: () => {
      buildHistorySnapshot: (
        nextNodes?: import("@/pages/fjtv/canvasDataTypes").NodeData[],
        nextEdges?: import("@/pages/fjtv/canvasDataTypes").EdgeData[],
        nextGroups?: import("@/pages/fjtv/canvasDataTypes").GroupData[],
        nextViewport?: import("@/pages/fjtv/canvasDataTypes").ViewportState,
      ) => import("@/pages/fjtv/canvasDataTypes").CanvasHistorySnapshot;
      recordCanvasHistoryMutation: (
        snapshot: import("@/pages/fjtv/canvasDataTypes").CanvasHistorySnapshot,
        previousSnapshot?: import("@/pages/fjtv/canvasDataTypes").CanvasHistorySnapshot,
      ) => void;
      applyHistorySnapshot: (
        snapshot: import("@/pages/fjtv/canvasDataTypes").CanvasHistorySnapshot,
      ) => void;
      undoCanvas: () => void;
      redoCanvas: () => void;
    };
    canvasTemplateStateModule: ReturnType<typeof useCanvasTemplateState>;
    canvasGraphActionBindings: ReturnType<
      typeof createCanvasGraphActionBindings
    >;
    nodeSerialCounter: Record<
      import("@/pages/fjtv/canvasMediaTypes").NodeType,
      number
    >;
    setNodeSerialCounter: React.Dispatch<
      React.SetStateAction<
        Record<import("@/pages/fjtv/canvasMediaTypes").NodeType, number>
      >
    >;
    canvasVisibilityViewModule: ReturnType<typeof useCanvasVisibilityView>;
    canvasHistoryPanelStateModule: ReturnType<
      typeof useCanvasHistoryPanelState
    >;
    templateController: () => {
      normalizeWorkflowTemplate: (
        raw: any,
      ) => import("@/pages/fjtv/canvasDataTypes").WorkflowTemplate;
      normalizeAssetTemplate: (
        raw: any,
      ) => import("@/pages/fjtv/canvasDataTypes").AssetTemplate;
      workflowSignature: (
        template: import("@/pages/fjtv/canvasDataTypes").WorkflowTemplate,
      ) => string;
      assetSignature: (
        template: import("@/pages/fjtv/canvasDataTypes").AssetTemplate,
      ) => string;
      refreshWorkflowTemplates: () => Promise<{
        available: boolean;
        workflows: any;
      }>;
      loadAssetTemplates: (projectId: number) => Promise<any>;
      migrateLegacyWorkflowTemplates: (
        remoteWorkflows: import("@/pages/fjtv/canvasDataTypes").WorkflowTemplate[],
      ) => Promise<any>;
      migrateLegacyAssetTemplates: (
        remoteAssets: import("@/pages/fjtv/canvasDataTypes").AssetTemplate[],
        activeProjectId: number,
      ) => Promise<any>;
      openCreateWorkflowModal: () => void;
      createWorkflowFromGroup: () => Promise<void>;
      applyWorkflow: (
        template: import("@/pages/fjtv/canvasDataTypes").WorkflowTemplate,
      ) => void;
      removeWorkflow: (id: string) => Promise<void>;
      openCreateAssetModal: () => void;
      openCreatePortraitAssetModal: () => void;
      createAssetFromSelection: () => Promise<void>;
      createPortraitAsset: () => Promise<void>;
      appendAssetSnapshot: (
        snapshot: import("@/pages/fjtv/canvasDataTypes").AssetSnapshot,
        mode: "all" | "single",
        singleNodeId?: string,
        targetWorld?: { x: number; y: number },
      ) => void;
      applyAsset: (
        template: import("@/pages/fjtv/canvasDataTypes").AssetTemplate,
      ) => void;
      appendProjectAssetCatalogItem: (
        item: import("@/features/assets/assetCatalog").ProjectAssetCatalogItem,
        targetWorld?: { x: number; y: number },
      ) => void;
      applyAssetCatalogItem: (
        item: import("@/features/assets/assetCatalog").AssetCatalogItem,
        targetWorld?: { x: number; y: number },
      ) => void;
      applySingleAssetNode: (
        template: import("@/pages/fjtv/canvasDataTypes").AssetTemplate,
        nodeId: string,
      ) => void;
    };
    canvasPublicationStateModule: ReturnType<typeof useCanvasPublicationState>;
    initialBrief: string;
  },
) {
  function canvasRouteActions() {
    return bindCanvasRouteActions(() => ({
      canvasRuntimeRefsModule: readContext().canvasRuntimeRefsModule,
      canvasSelectionStateModule: readContext().canvasSelectionStateModule,
      canvasPromptStateModule: readContext().canvasPromptStateModule,
      canvasAssetPanelStateModule: readContext().canvasAssetPanelStateModule,
      canvasProjectStateModule: readContext().canvasProjectStateModule,
      studioChrome: readContext().studioChrome,
      navigate: readContext().navigate,
      location: readContext().location,
      searchParams: readContext().searchParams,
      canvasMeta: readContext().canvasMeta,
      routeCanvasId: readContext().routeCanvasId,
      canvasGraphStateModule: readContext().canvasGraphStateModule,
      canvasGroupStateModule: readContext().canvasGroupStateModule,
      canvasViewportUiStateModule: readContext().canvasViewportUiStateModule,
      canvasProjectRenameStateModule:
        readContext().canvasProjectRenameStateModule,
    }));
  }

  function projectController() {
    return bindProjectController(() => ({
      canvasRuntimeRefsModule: readContext().canvasRuntimeRefsModule,
      canvasProjectStateModule: readContext().canvasProjectStateModule,
      canvasProjectRenameStateModule:
        readContext().canvasProjectRenameStateModule,
      canvasMeta: readContext().canvasMeta,
      sanitizeNodesForPersistence:
        readContext().canvasProjectActionBindings.sanitizeNodesForPersistence,
      canDelete: readContext().canDelete,
      navigateToCanvas:
        readContext().canvasProjectActionBindings.navigateToCanvas,
      studioChrome: readContext().studioChrome,
      setCanvasMeta: readContext().setCanvasMeta,
      sanitizeNodeForPersistence:
        readContext().canvasProjectActionBindings.sanitizeNodeForPersistence,
      location: readContext().location,
      selectedProjectId: readContext().selectedProjectId,
      boundSessionProjectId: readContext().boundSessionProjectId,
      removeSelectedProject: readContext().removeSelectedProject,
      clearSelectedProject: readContext().clearSelectedProject,
      clearCreationSession: readContext().clearCreationSession,
      resetCanvasRuntimeState:
        readContext().canvasProjectActionBindings.resetCanvasRuntimeState,
      navigate: readContext().navigate,
      openProjectBrowser:
        readContext().canvasProjectActionBindings.openProjectBrowser,
      canvasLibraryViewModule: readContext().canvasLibraryViewModule,
      canvasPromptStateModule: readContext().canvasPromptStateModule,
      canvasGraphStateModule: readContext().canvasGraphStateModule,
      canvasSelectionStateModule: readContext().canvasSelectionStateModule,
    }));
  }

  function persistenceController() {
    return bindPersistenceController(() => ({
      canvasRuntimeRefsModule: readContext().canvasRuntimeRefsModule,
      canvasGraphStateModule: readContext().canvasGraphStateModule,
      ensureApiKeyReady:
        readContext().canvasGenerationActionBindings.ensureApiKeyReady,
      canvasMeta: readContext().canvasMeta,
      studioChrome: readContext().studioChrome,
      selectedProjectId: readContext().selectedProjectId,
      routeCanvasId: readContext().routeCanvasId,
      location: readContext().location,
      navigate: readContext().navigate,
      setCanvasMeta: readContext().setCanvasMeta,
      latestCanvasSaveInputRef: readContext().latestCanvasSaveInputRef,
      canvasHistoryController: readContext().canvasHistoryController,
      canvasProjectStateModule: readContext().canvasProjectStateModule,
      canvasPromptStateModule: readContext().canvasPromptStateModule,
      canvasSelectionStateModule: readContext().canvasSelectionStateModule,
      canvasGroupStateModule: readContext().canvasGroupStateModule,
    }));
  }

  function templateController() {
    return bindTemplateController(() => ({
      canvasGraphStateModule: readContext().canvasGraphStateModule,
      canvasSelectionStateModule: readContext().canvasSelectionStateModule,
      canvasTemplateStateModule: readContext().canvasTemplateStateModule,
      canvasAssetPanelStateModule: readContext().canvasAssetPanelStateModule,
      canvasProjectRenameStateModule:
        readContext().canvasProjectRenameStateModule,
      canvasLibraryViewModule: readContext().canvasLibraryViewModule,
      toWorld: readContext().canvasGraphActionBindings.toWorld,
      canDelete: readContext().canDelete,
      nodeSerialCounter: readContext().nodeSerialCounter,
      setNodeSerialCounter: readContext().setNodeSerialCounter,
      persistCanvas: readContext().canvasProjectActionBindings.persistCanvas,
      canvasVisibilityViewModule: readContext().canvasVisibilityViewModule,
      canvasPromptStateModule: readContext().canvasPromptStateModule,
      canvasRuntimeRefsModule: readContext().canvasRuntimeRefsModule,
      canvasGroupStateModule: readContext().canvasGroupStateModule,
    }));
  }

  function projectAssetController() {
    return bindProjectAssetController(() => ({
      canvasHistoryPanelStateModule:
        readContext().canvasHistoryPanelStateModule,
      canDelete: readContext().canDelete,
      templateController: readContext().templateController,
      canvasPromptStateModule: readContext().canvasPromptStateModule,
    }));
  }

  function canvasHistoryController() {
    return bindCanvasHistoryController(() => ({
      canvasRuntimeRefsModule: readContext().canvasRuntimeRefsModule,
      canvasGraphStateModule: readContext().canvasGraphStateModule,
      canvasSelectionStateModule: readContext().canvasSelectionStateModule,
      canvasGroupStateModule: readContext().canvasGroupStateModule,
      closePromptMenus:
        readContext().canvasGenerationActionBindings.closePromptMenus,
      canvasViewportUiStateModule: readContext().canvasViewportUiStateModule,
      canvasPromptStateModule: readContext().canvasPromptStateModule,
    }));
  }

  function publicationController() {
    return bindPublicationController(() => ({
      canvasProjectStateModule: readContext().canvasProjectStateModule,
      canvasPublicationStateModule: readContext().canvasPublicationStateModule,
      closeBottomPanels:
        readContext().canvasGraphActionBindings.closeBottomPanels,
      canvasMeta: readContext().canvasMeta,
      persistCanvas: readContext().canvasProjectActionBindings.persistCanvas,
      canvasCoverUrl: readContext().canvasProjectActionBindings.canvasCoverUrl,
      canvasProjectRenameStateModule:
        readContext().canvasProjectRenameStateModule,
      canvasGraphStateModule: readContext().canvasGraphStateModule,
      canvasGroupStateModule: readContext().canvasGroupStateModule,
      canvasPromptStateModule: readContext().canvasPromptStateModule,
    }));
  }

  function canvasHistoryLoading() {
    return bindCanvasHistoryLoading(() => ({
      ensureApiKeyReady:
        readContext().canvasGenerationActionBindings.ensureApiKeyReady,
      canvasHistoryPanelStateModule:
        readContext().canvasHistoryPanelStateModule,
      canvasPromptStateModule: readContext().canvasPromptStateModule,
    }));
  }

  function canvasConflictActions() {
    return bindCanvasConflictActions(() => ({
      canvasRuntimeRefsModule: readContext().canvasRuntimeRefsModule,
      canvasGraphStateModule: readContext().canvasGraphStateModule,
      canvasSelectionStateModule: readContext().canvasSelectionStateModule,
      initialBrief: readContext().initialBrief,
      resetCanvasRuntimeState:
        readContext().canvasProjectActionBindings.resetCanvasRuntimeState,
      setCanvasMeta: readContext().setCanvasMeta,
      canvasMeta: readContext().canvasMeta,
      canvasProjectStateModule: readContext().canvasProjectStateModule,
      canvasGroupStateModule: readContext().canvasGroupStateModule,
      canvasPromptStateModule: readContext().canvasPromptStateModule,
    }));
  }
  return {
    canvasRouteActions,
    projectController,
    persistenceController,
    templateController,
    projectAssetController,
    canvasHistoryController,
    publicationController,
    canvasHistoryLoading,
    canvasConflictActions,
  };
}
