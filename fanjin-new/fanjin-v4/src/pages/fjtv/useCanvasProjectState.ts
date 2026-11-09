import type { ProjectListItem, ProjectCanvasItem, ProjectFolderItem } from "./canvasDataTypes";
import { useMemo, useRef, useState } from "react";
import { readProjectModeRouteContext } from "@/routes/projectModeRoutes";
import { normalizeProjectId } from "@/stores/projectStore";

export function useCanvasProjectState({ studioChrome, location, routeCanvasId, selectedProjectId }: { studioChrome: boolean; location: { pathname: string; search: string }; routeCanvasId: string | undefined; selectedProjectId: number | null }) {
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [canvasSwitcherOpen, setCanvasSwitcherOpen] = useState(false);
  const [projectBrowserOpen, setProjectBrowserOpen] = useState(false);
  const [projectBrowserFolderId, setProjectBrowserFolderId] = useState<string | null>(null);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsError, setProjectsError] = useState("");
  const [projectFoldersLoading, setProjectFoldersLoading] = useState(true);
  const [projectFoldersError, setProjectFoldersError] = useState("");
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [projectCanvases, setProjectCanvases] = useState<Record<string, ProjectCanvasItem[]>>({});
  const [projectFolders, setProjectFolders] = useState<ProjectFolderItem[]>([]);
  const projectListRequestVersionRef = useRef(0);
  const projectFolderListRequestVersionRef = useRef(0);
  const deletedProjectIdsRef = useRef(new Set<string>());
  const deletedFolderIdsRef = useRef(new Set<string>());
  // The routed project is authoritative from the first render. Waiting for the
  // canvas-to-project scan below briefly labels the canvas as the project,
  // hides the canvas switcher, and can arm persistence without an owner.
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(() => {
    const routedProjectId = readProjectModeRouteContext(location).projectId;
    return routedProjectId ? String(routedProjectId) : null;
  });
  const routeProjectContextId = useMemo(
    () => readProjectModeRouteContext(location).projectId,
    [location.pathname, location.search],
  );
  const activeProjectContextId = currentProjectId
    || (routeProjectContextId ? String(routeProjectContextId) : null)
    || (!studioChrome && normalizeProjectId(selectedProjectId) !== null
      ? String(normalizeProjectId(selectedProjectId))
      : null);
  const [projectBrowserReturnCanvasId, setProjectBrowserReturnCanvasId] = useState<string | null>(routeCanvasId ?? null);
  const [projectActionMenuId, setProjectActionMenuId] = useState<string | null>(null);
  const [folderActionMenuId, setFolderActionMenuId] = useState<string | null>(null);
  const [projectDeleteConfirmId, setProjectDeleteConfirmId] = useState<string | null>(null);
  const [projectDeletePending, setProjectDeletePending] = useState(false);
  const [projectDeleteError, setProjectDeleteError] = useState("");
  const [cancelGenerationConfirmNodeId, setCancelGenerationConfirmNodeId] = useState<string | null>(null);
  const [cancelGenerationPending, setCancelGenerationPending] = useState(false);
  const projectDeleteOpenerRef = useRef<HTMLElement | null>(null);
  const projectDeleteCancelRef = useRef<HTMLButtonElement | null>(null);
  const cancelGenerationOpenerRef = useRef<HTMLElement | null>(null);
  const cancelGenerationReturnRef = useRef<HTMLButtonElement | null>(null);
  return {
    projectMenuOpen, setProjectMenuOpen,
    canvasSwitcherOpen, setCanvasSwitcherOpen,
    projectBrowserOpen, setProjectBrowserOpen,
    projectBrowserFolderId, setProjectBrowserFolderId,
    projectsLoading, setProjectsLoading,
    projectsError, setProjectsError,
    projectFoldersLoading, setProjectFoldersLoading,
    projectFoldersError, setProjectFoldersError,
    projects, setProjects,
    projectCanvases, setProjectCanvases,
    projectFolders, setProjectFolders,
    projectListRequestVersionRef, projectFolderListRequestVersionRef,
    deletedProjectIdsRef, deletedFolderIdsRef,
    currentProjectId, setCurrentProjectId,
    routeProjectContextId, activeProjectContextId,
    projectBrowserReturnCanvasId, setProjectBrowserReturnCanvasId,
    projectActionMenuId, setProjectActionMenuId,
    folderActionMenuId, setFolderActionMenuId,
    projectDeleteConfirmId, setProjectDeleteConfirmId,
    projectDeletePending, setProjectDeletePending,
    projectDeleteError, setProjectDeleteError,
    cancelGenerationConfirmNodeId, setCancelGenerationConfirmNodeId,
    cancelGenerationPending, setCancelGenerationPending,
    projectDeleteOpenerRef, projectDeleteCancelRef,
    cancelGenerationOpenerRef, cancelGenerationReturnRef,
  };
}
