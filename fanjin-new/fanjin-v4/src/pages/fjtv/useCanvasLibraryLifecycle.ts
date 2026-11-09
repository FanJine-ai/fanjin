import { useEffect, type DependencyList, type Dispatch, type SetStateAction, type RefObject, type ReactNode, type JSX } from "react";
import type { WorkflowTemplate, AssetTemplate, ProjectListItem, ProjectCanvasItem, ProjectFolderItem, CanvasMetaState } from "./canvasDataTypes";
import { toApiErrorView } from "@/api/http";

interface UseCanvasProjectAssetsContext {
  selectedProjectId: number | null;
  fetchProjectAssetCatalog: (params?: { type?: string; page?: number; limit?: number; }) => Promise<void>;
}

export function useCanvasProjectAssets(readContext: () => UseCanvasProjectAssetsContext, dependencies: DependencyList) {
  useEffect(() => {
    const { selectedProjectId, fetchProjectAssetCatalog } = readContext();

    if (selectedProjectId === null) return;
    void fetchProjectAssetCatalog();

  }, dependencies);
}

interface UseCanvasAssetTemplatesContext {
  setAssets: Dispatch<SetStateAction<AssetTemplate[]>>;
  setAssetDetailId: Dispatch<SetStateAction<string | null>>;
  setCanvasAssetsError: Dispatch<SetStateAction<string>>;
  effectiveAssetProjectId: number | null;
  setCanvasAssetsLoading: Dispatch<SetStateAction<boolean>>;
  loadAssetTemplates: (projectId: number) => Promise<any>;
  readOnlyProofMode: boolean;
  migrateLegacyAssetTemplates: (remoteAssets: AssetTemplate[], activeProjectId: number) => Promise<any>;
}

export function useCanvasAssetTemplates(readContext: () => UseCanvasAssetTemplatesContext, dependencies: DependencyList) {
  useEffect(() => {
    const { setAssets, setAssetDetailId, setCanvasAssetsError, effectiveAssetProjectId, setCanvasAssetsLoading, loadAssetTemplates, readOnlyProofMode, migrateLegacyAssetTemplates } = readContext();

    let disposed = false;
    setAssets([]);
    setAssetDetailId(null);
    setCanvasAssetsError("");
    if (effectiveAssetProjectId === null) {
      setCanvasAssetsLoading(false);
      return () => {
        disposed = true;
      };
    }

    setCanvasAssetsLoading(true);
    void loadAssetTemplates(effectiveAssetProjectId)
      .then((remoteAssets) => (
        readOnlyProofMode
          ? remoteAssets
          : migrateLegacyAssetTemplates(remoteAssets, effectiveAssetProjectId)
      ))
      .then((nextAssets) => {
        if (disposed) return;
        setAssets(nextAssets);
      })
      .catch((error) => {
        if (disposed) return;
        setAssets([]);
        setCanvasAssetsError(toApiErrorView(error).message);
      })
      .finally(() => {
        if (!disposed) setCanvasAssetsLoading(false);
      });

    return () => {
      disposed = true;
    };

  }, dependencies);
}

interface UseCanvasWorkflowTemplatesContext {
  refreshWorkflowTemplates: () => Promise<{ available: boolean; workflows: any; }>;
  setWorkflows: Dispatch<SetStateAction<WorkflowTemplate[]>>;
  readOnlyProofMode: boolean;
  migrateLegacyWorkflowTemplates: (remoteWorkflows: WorkflowTemplate[]) => Promise<any>;
}

export function useCanvasWorkflowTemplates(readContext: () => UseCanvasWorkflowTemplatesContext, dependencies: DependencyList) {
  useEffect(() => {
    const { refreshWorkflowTemplates, setWorkflows, readOnlyProofMode, migrateLegacyWorkflowTemplates } = readContext();

    let disposed = false;
    async function loadTemplateLibraries() {
      const response = await refreshWorkflowTemplates();
      if (disposed) return;
      if (!response.available) {
        setWorkflows([]);
        return;
      }
      const migratedWorkflows = readOnlyProofMode
        ? response.workflows
        : await migrateLegacyWorkflowTemplates(response.workflows);
      if (disposed) return;
      setWorkflows(migratedWorkflows);
    }
    void loadTemplateLibraries().catch(() => undefined);
    return () => {
      disposed = true;
    };

  }, dependencies);
}

interface UseCanvasProjectCatalogContext {
  refreshProjects: (options?: { throwOnError?: boolean; }) => Promise<ProjectListItem[]>;
  refreshProjectFolders: (options?: { throwOnError?: boolean; }) => Promise<ProjectFolderItem[]>;
}

export function useCanvasProjectCatalog(readContext: () => UseCanvasProjectCatalogContext, dependencies: DependencyList) {
  useEffect(() => {
    const { refreshProjects, refreshProjectFolders } = readContext();

    void refreshProjects();
    void refreshProjectFolders();

  }, dependencies);
}

interface UseCanvasProjectInferenceContext {
  canvasMeta: CanvasMetaState;
  projectsLoading: boolean;
  projectsError: string;
  canvasContextEpochRef: RefObject<number>;
  inferCurrentProjectForCanvas: (canvasId: string) => Promise<string | null>;
  setStatus: Dispatch<SetStateAction<string>>;
}

export function useCanvasProjectInference(readContext: () => UseCanvasProjectInferenceContext, dependencies: DependencyList) {
  useEffect(() => {
    const { canvasMeta, projectsLoading, projectsError, canvasContextEpochRef, inferCurrentProjectForCanvas, setStatus } = readContext();

    if (!canvasMeta.canvasId || projectsLoading || projectsError) return;
    const contextEpoch = canvasContextEpochRef.current;
    void inferCurrentProjectForCanvas(canvasMeta.canvasId).catch((error) => {
      if (canvasContextEpochRef.current !== contextEpoch) return;
      setStatus(`项目归属读取失败：${toApiErrorView(error).message || "请稍后重试"}`);
    });

  }, dependencies);
}

interface UseCanvasProjectCanvasesContext {
  currentProjectId: string | null;
  canvasContextEpochRef: RefObject<number>;
  ensureProjectCanvases: (projectId: string, expectedContextEpoch?: number) => Promise<ProjectCanvasItem[]>;
  setStatus: Dispatch<SetStateAction<string>>;
}

export function useCanvasProjectCanvases(readContext: () => UseCanvasProjectCanvasesContext, dependencies: DependencyList) {
  useEffect(() => {
    const { currentProjectId, canvasContextEpochRef, ensureProjectCanvases, setStatus } = readContext();

    if (!currentProjectId) return;
    const contextEpoch = canvasContextEpochRef.current;
    void ensureProjectCanvases(currentProjectId).catch((error) => {
      if (canvasContextEpochRef.current !== contextEpoch) return;
      setStatus(`项目画布读取失败：${toApiErrorView(error).message || "请稍后重试"}`);
    });

  }, dependencies);
}
