import { createCanvasProjectActionBindings } from "./canvasProjectActionBindings";
import {
  useCanvasAssetTemplates,
  useCanvasProjectAssets,
  useCanvasProjectCanvases,
  useCanvasProjectCatalog,
  useCanvasProjectInference,
  useCanvasWorkflowTemplates,
} from "./useCanvasLibraryLifecycle";
import { useCanvasLibraryView } from "./useCanvasLibraryView";
import { useCanvasModelCatalogState } from "./useCanvasModelCatalogState";
import { useCanvasModelCatalog } from "./useCanvasModelLifecycle";
import { useCanvasProjectState } from "./useCanvasProjectState";
import { useCanvasPromptState } from "./useCanvasPromptState";
import { useCanvasRuntimeRefs } from "./useCanvasRuntimeRefs";
import { useCanvasTemplateState } from "./useCanvasTemplateState";
export function useCanvasLibraryCatalogEffects({
  canvasRuntimeRefsModule,
  canvasMeta,
  readOnlyProofMode,
  canvasProjectActionBindings,
  canvasProjectStateModule,
  canvasModelCatalogStateModule,
  currentWorkspaceId,
  selectedProjectId,
  fetchProjectAssetCatalog,
  canvasTemplateStateModule,
  canvasLibraryViewModule,
  canvasPromptStateModule,
}: {
  canvasRuntimeRefsModule: ReturnType<typeof useCanvasRuntimeRefs>;
  canvasMeta: import("@/pages/fjtv/canvasDataTypes").CanvasMetaState;
  readOnlyProofMode: boolean;
  canvasProjectActionBindings: ReturnType<
    typeof createCanvasProjectActionBindings
  >;
  canvasProjectStateModule: ReturnType<typeof useCanvasProjectState>;
  canvasModelCatalogStateModule: ReturnType<typeof useCanvasModelCatalogState>;
  currentWorkspaceId: string | number | null;
  selectedProjectId: number | null;
  fetchProjectAssetCatalog: (params?: {
    type?: string;
    page?: number;
    limit?: number;
  }) => Promise<void>;
  canvasTemplateStateModule: ReturnType<typeof useCanvasTemplateState>;
  canvasLibraryViewModule: ReturnType<typeof useCanvasLibraryView>;
  canvasPromptStateModule: ReturnType<typeof useCanvasPromptState>;
}) {
  useCanvasModelCatalog(
    () => ({
      setModels: canvasModelCatalogStateModule.setModels,
      setModelCatalogError: canvasModelCatalogStateModule.setModelCatalogError,
      setModelCatalogState: canvasModelCatalogStateModule.setModelCatalogState,
    }),
    [currentWorkspaceId, canvasModelCatalogStateModule.modelCatalogReloadToken],
  );
  useCanvasProjectAssets(
    () => ({ selectedProjectId, fetchProjectAssetCatalog }),
    [fetchProjectAssetCatalog, selectedProjectId],
  );
  useCanvasAssetTemplates(
    () => ({
      setAssets: canvasTemplateStateModule.setAssets,
      setAssetDetailId: canvasTemplateStateModule.setAssetDetailId,
      setCanvasAssetsError: canvasTemplateStateModule.setCanvasAssetsError,
      effectiveAssetProjectId: canvasLibraryViewModule.effectiveAssetProjectId,
      setCanvasAssetsLoading: canvasTemplateStateModule.setCanvasAssetsLoading,
      loadAssetTemplates: canvasProjectActionBindings.loadAssetTemplates,
      readOnlyProofMode,
      migrateLegacyAssetTemplates:
        canvasProjectActionBindings.migrateLegacyAssetTemplates,
    }),
    [canvasLibraryViewModule.effectiveAssetProjectId, readOnlyProofMode],
  );
  useCanvasWorkflowTemplates(
    () => ({
      refreshWorkflowTemplates:
        canvasProjectActionBindings.refreshWorkflowTemplates,
      setWorkflows: canvasTemplateStateModule.setWorkflows,
      readOnlyProofMode,
      migrateLegacyWorkflowTemplates:
        canvasProjectActionBindings.migrateLegacyWorkflowTemplates,
    }),
    [currentWorkspaceId, readOnlyProofMode],
  );
  useCanvasProjectCatalog(
    () => ({
      refreshProjects: canvasProjectActionBindings.refreshProjects,
      refreshProjectFolders: canvasProjectActionBindings.refreshProjectFolders,
    }),
    [],
  );
  useCanvasProjectInference(
    () => ({
      canvasMeta,
      projectsLoading: canvasProjectStateModule.projectsLoading,
      projectsError: canvasProjectStateModule.projectsError,
      canvasContextEpochRef: canvasRuntimeRefsModule.canvasContextEpochRef,
      inferCurrentProjectForCanvas:
        canvasProjectActionBindings.inferCurrentProjectForCanvas,
      setStatus: canvasPromptStateModule.setStatus,
    }),
    [
      canvasMeta.canvasId,
      canvasProjectStateModule.projects,
      canvasProjectStateModule.projectsLoading,
      canvasProjectStateModule.projectsError,
    ],
  );
  useCanvasProjectCanvases(
    () => ({
      currentProjectId: canvasProjectStateModule.currentProjectId,
      canvasContextEpochRef: canvasRuntimeRefsModule.canvasContextEpochRef,
      ensureProjectCanvases: canvasProjectActionBindings.ensureProjectCanvases,
      setStatus: canvasPromptStateModule.setStatus,
    }),
    [canvasProjectStateModule.currentProjectId],
  );
}
