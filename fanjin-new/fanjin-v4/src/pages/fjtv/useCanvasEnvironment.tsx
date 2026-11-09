import { useSessionStore } from "@/features/quick-create/session/sessionStore";
import { useFrontstageBalance } from "@/pages/frontstage/useFrontstageBalance";
import { useAssetStore } from "@/stores/assetStore";
import { useAuthStore } from "@/stores/authStore";
import { useProjectStore } from "@/stores/projectStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useV4Theme } from "@/ui/useV4Theme";
import { canDeleteProjects, isPlatformAdmin } from "@/utils/permissions";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import {
  isCanvasGenerationDebugFlagEnabled,
  shouldShowCanvasGenerationDebug,
} from "./canvasGenerationDebug";
import { GENERATE_DEBUG_ENABLED } from "./canvasPageConstants";
export function useCanvasEnvironment({}: {}) {
  const navigate = useNavigate();
  const location = useLocation();
  const { id: routeCanvasId } = useParams();
  const canvasTheme = useV4Theme();
  const canvasColorMode = canvasTheme.mode;
  const switchCanvasColorMode = canvasTheme.setMode;
  const selectedProjectId = useProjectStore((state) => state.currentProjectId);
  const currentWorkspaceId = useWorkspaceStore(
    (state) => state.currentWorkspaceId,
  );
  const authenticatedUser = useAuthStore((state) => state.user);
  const authenticatedWorkspace = useAuthStore(
    (state) => state.currentWorkspace,
  );
  const canDelete = canDeleteProjects({
    user: authenticatedUser,
    workspace: authenticatedWorkspace,
  });
  const canvasGenerationDebugVisible = shouldShowCanvasGenerationDebug({
    devMode: import.meta.env.DEV,
    explicitDebugEnabled:
      GENERATE_DEBUG_ENABLED ||
      isCanvasGenerationDebugFlagEnabled(
        import.meta.env.VITE_FANJIN_CANVAS_GENERATION_DEBUG,
      ),
    isPlatformAdmin: isPlatformAdmin({
      user: authenticatedUser,
      workspace: authenticatedWorkspace,
    }),
  });
  const canvasBalance = useFrontstageBalance(currentWorkspaceId);
  const removeSelectedProject = useProjectStore((state) => state.removeProject);
  const clearSelectedProject = useProjectStore((state) => state.clearProject);
  const boundSessionProjectId = useSessionStore(
    (state) => state.boundProjectId,
  );
  const clearCreationSession = useSessionStore((state) => state.clear);
  const projectAssetCatalog = useAssetStore((state) => state.catalog);
  const projectAssetCatalogProjectId = useAssetStore(
    (state) => state.catalogProjectId,
  );
  const projectAssetCatalogLoading = useAssetStore((state) => state.loading);
  const projectAssetCatalogError = useAssetStore((state) => state.error);
  const fetchProjectAssetCatalog = useAssetStore((state) => state.fetchAssets);
  return {
    navigate,
    location,
    routeCanvasId,
    canvasTheme,
    canvasColorMode,
    switchCanvasColorMode,
    selectedProjectId,
    currentWorkspaceId,
    authenticatedUser,
    authenticatedWorkspace,
    canDelete,
    canvasGenerationDebugVisible,
    canvasBalance,
    removeSelectedProject,
    clearSelectedProject,
    boundSessionProjectId,
    clearCreationSession,
    projectAssetCatalog,
    projectAssetCatalogProjectId,
    projectAssetCatalogLoading,
    projectAssetCatalogError,
    fetchProjectAssetCatalog,
  };
}
