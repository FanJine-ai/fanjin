import type { Location, NavigateFunction } from "react-router-dom";
import type { Dispatch, SetStateAction, RefObject, ReactNode, JSX } from "react";
import { positiveCanvasRevision, positiveCanvasProjectId, canvasConflictFromError } from "./canvasSnapshotCodec";
import type { NodeData, EdgeData, ProjectListItem, ProjectCanvasItem, ProjectFolderItem, CanvasMetaState, CanvasConflictState } from "./canvasDataTypes";
import { ApiError, api, type DeletionOperationDto } from "@/lib/api";
import { toApiErrorView } from "@/api/http";
import { buildProjectModeHref, readProjectModeRouteContext } from "@/routes/projectModeRoutes";
import { sameProjectIdentity } from "./canvasProjectIdentity";

export interface CanvasProjectControllerDependencies {
  setProjectMenuOpen: Dispatch<SetStateAction<boolean>>;
  setCanvasSwitcherOpen: Dispatch<SetStateAction<boolean>>;
  currentProjectId: string | null;
  currentProject: ProjectListItem | null;
  canvasMeta: CanvasMetaState;
  setStatus: Dispatch<SetStateAction<string>>;
  nodes: NodeData[];
  edges: EdgeData[];
  sanitizeNodesForPersistence: (nextNodes: NodeData[]) => NodeData[];
  canDelete: boolean;
  setCurrentProjectId: Dispatch<SetStateAction<string | null>>;
  navigateToCanvas: (canvasId: string, projectId?: string | null) => void;
  setHeaderProjectRenaming: Dispatch<SetStateAction<boolean>>;
  setHeaderProjectRenameDraft: Dispatch<SetStateAction<string>>;
  canvasContextEpochRef: RefObject<number>;
  projectCanvases: Record<string, ProjectCanvasItem[]>;
  setProjectCanvases: Dispatch<SetStateAction<Record<string, ProjectCanvasItem[]>>>;
  projectListRequestVersionRef: RefObject<number>;
  setProjectsLoading: Dispatch<SetStateAction<boolean>>;
  setProjectsError: Dispatch<SetStateAction<string>>;
  deletedProjectIdsRef: RefObject<Set<string>>;
  projects: ProjectListItem[];
  setProjects: Dispatch<SetStateAction<ProjectListItem[]>>;
  projectFolderListRequestVersionRef: RefObject<number>;
  setProjectFoldersLoading: Dispatch<SetStateAction<boolean>>;
  setProjectFoldersError: Dispatch<SetStateAction<string>>;
  deletedFolderIdsRef: RefObject<Set<string>>;
  projectFolders: ProjectFolderItem[];
  setProjectFolders: Dispatch<SetStateAction<ProjectFolderItem[]>>;
  headerProjectRenameDraft: string;
  projectsLoading: boolean;
  projectsError: string;
  setProjectBrowserOpen: Dispatch<SetStateAction<boolean>>;
  setProjectBrowserFolderId: Dispatch<SetStateAction<string | null>>;
  routeProjectContextId: string | number | null | undefined;
  studioChrome: boolean;
  setCanvasRenamingId: Dispatch<SetStateAction<string | null>>;
  setCanvasRenameDraft: Dispatch<SetStateAction<string>>;
  canvasRenameDraft: string;
  canvasServerRevisionRef: RefObject<number | null>;
  setCanvasMeta: Dispatch<SetStateAction<CanvasMetaState>>;
  canvasConflictRef: RefObject<boolean>;
  setCanvasConflict: Dispatch<SetStateAction<CanvasConflictState | null>>;
  setCanvasSaveState: Dispatch<SetStateAction<"dirty" | "saving" | "saved" | "error">>;
  setProjectBrowserRenamingId: Dispatch<SetStateAction<string | null>>;
  setProjectBrowserRenameDraft: Dispatch<SetStateAction<string>>;
  setFolderCreateToastOpen: Dispatch<SetStateAction<boolean>>;
  projectBrowserRenameDraft: string;
  repairLegacyNodes: (rawNodes: any[]) => NodeData[];
  sanitizeNodeForPersistence: (node: NodeData) => NodeData;
  projectDeleteOpenerRef: RefObject<HTMLElement | null>;
  setProjectActionMenuId: Dispatch<SetStateAction<string | null>>;
  setProjectDeleteError: Dispatch<SetStateAction<string>>;
  setProjectDeletePending: Dispatch<SetStateAction<boolean>>;
  setProjectDeleteConfirmId: Dispatch<SetStateAction<string | null>>;
  projectDeleteConfirmId: string | null;
  projectDeletePending: boolean;
  location: Location<any>;
  selectedProjectId: number | null;
  boundSessionProjectId: number | null;
  removeSelectedProject: (id: string | number) => void;
  clearSelectedProject: () => void;
  clearCreationSession: () => void;
  saveTimerRef: RefObject<number | null>;
  saveRevisionRef: RefObject<number>;
  hydratedRef: RefObject<boolean>;
  LAST_ACTIVE_CANVAS_KEY: "infinite_canvas_last_active_canvas_id";
  resetCanvasRuntimeState: () => void;
  setProjectBrowserReturnCanvasId: Dispatch<SetStateAction<string | null>>;
  navigate: NavigateFunction;
  openProjectBrowser: (preserveCanvas?: boolean) => void;
  projectBrowserFolderId: string | null;
  setFolderActionMenuId: Dispatch<SetStateAction<string | null>>;
}

export function createCanvasProjectController(deps: CanvasProjectControllerDependencies) {
  const { setProjectMenuOpen, setCanvasSwitcherOpen, currentProjectId, currentProject, canvasMeta, setStatus, nodes, edges, sanitizeNodesForPersistence, canDelete, setCurrentProjectId, navigateToCanvas, setHeaderProjectRenaming, setHeaderProjectRenameDraft, canvasContextEpochRef, projectCanvases, setProjectCanvases, projectListRequestVersionRef, setProjectsLoading, setProjectsError, deletedProjectIdsRef, projects, setProjects, projectFolderListRequestVersionRef, setProjectFoldersLoading, setProjectFoldersError, deletedFolderIdsRef, projectFolders, setProjectFolders, headerProjectRenameDraft, projectsLoading, projectsError, setProjectBrowserOpen, setProjectBrowserFolderId, routeProjectContextId, studioChrome, setCanvasRenamingId, setCanvasRenameDraft, canvasRenameDraft, canvasServerRevisionRef, setCanvasMeta, canvasConflictRef, setCanvasConflict, setCanvasSaveState, setProjectBrowserRenamingId, setProjectBrowserRenameDraft, setFolderCreateToastOpen, projectBrowserRenameDraft, repairLegacyNodes, sanitizeNodeForPersistence, projectDeleteOpenerRef, setProjectActionMenuId, setProjectDeleteError, setProjectDeletePending, setProjectDeleteConfirmId, projectDeleteConfirmId, projectDeletePending, location, selectedProjectId, boundSessionProjectId, removeSelectedProject, clearSelectedProject, clearCreationSession, saveTimerRef, saveRevisionRef, hydratedRef, LAST_ACTIVE_CANVAS_KEY, resetCanvasRuntimeState, setProjectBrowserReturnCanvasId, navigate, openProjectBrowser, projectBrowserFolderId, setFolderActionMenuId } = deps;
async function startHeaderProjectRename() {
    setProjectMenuOpen(false);
    setCanvasSwitcherOpen(false);

    let targetProjectId = currentProjectId;
    let draftName = currentProject?.name || canvasMeta.name || "未命名项目";

    if (!targetProjectId) {
      const created = await api.createProject(draftName).catch(() => null);
      const projectId = (created as any)?.projectId;
      const defaultCanvasId = (created as any)?.defaultCanvasId;
      if (!projectId || !defaultCanvasId) {
        setStatus("创建项目失败");
        return;
      }

      if (nodes.length > 0 || edges.length > 0) {
        try {
          await api.saveCanvas({
            canvasId: defaultCanvasId,
            name: canvasMeta.name || "画布 1",
            nodes: sanitizeNodesForPersistence(nodes),
            edges,
          });
        } catch (error) {
          // 失败清理仍是项目删除，编辑权限不能隐式获得删除能力。
          const cleanedUp = canDelete && await api.deleteProject(projectId).then(() => true).catch(() => false);
          setStatus(
            cleanedUp
              ? `创建项目失败：${toApiErrorView(error).message || "当前画布内容未保存"}`
              : `创建项目失败且残留了未完成项目，请稍后清理：${toApiErrorView(error).message || "当前画布内容未保存"}`,
          );
          return;
        }
      }

      targetProjectId = projectId;
      await refreshProjects();
      await refreshProjectFolders();
      setCurrentProjectId(projectId);
      navigateToCanvas(defaultCanvasId, projectId);
    }

    setHeaderProjectRenaming(true);
    setHeaderProjectRenameDraft(draftName);
  }

function normalizeProjectFolder(raw: any): ProjectFolderItem {
    return {
      id: String(raw?.id || ""),
      name: String(raw?.name || "未命名文件夹"),
      projectIds: Array.isArray(raw?.projectIds) ? raw.projectIds.map((item: any) => String(item || "")).filter(Boolean) : [],
      createdAt: String(raw?.createdAt || new Date().toISOString()),
      updatedAt: raw?.updatedAt ? String(raw.updatedAt) : undefined,
    };
  }

function normalizeProjectFolders(input: any): ProjectFolderItem[] {
    const raw = Array.isArray(input?.folders) ? input.folders : Array.isArray(input) ? input : [];
    return raw.map(normalizeProjectFolder);
  }

async function ensureProjectCanvases(
    projectId: string,
    expectedContextEpoch = canvasContextEpochRef.current,
  ): Promise<ProjectCanvasItem[]> {
    if (projectCanvases[projectId]) return projectCanvases[projectId];
    const result = await api.getProjectCanvases(projectId);
    if (!Array.isArray((result as any)?.canvases)) {
      throw new Error("项目画布列表响应格式错误");
    }
    if (canvasContextEpochRef.current !== expectedContextEpoch) {
      throw new Error("项目上下文已切换，请重试");
    }
    const canvases = (result as any).canvases as ProjectCanvasItem[];
    setProjectCanvases((prev) => ({ ...prev, [projectId]: canvases }));
    return canvases;
  }

async function refreshProjects({ throwOnError = false }: { throwOnError?: boolean } = {}) {
    const requestVersion = projectListRequestVersionRef.current + 1;
    projectListRequestVersionRef.current = requestVersion;
    setProjectsLoading(true);
    setProjectsError("");
    try {
      const result = await api.listProjects();
      if (!Array.isArray((result as any)?.projects)) {
        throw new Error("项目列表响应格式错误");
      }
      const nextProjects = ((result as any).projects as ProjectListItem[])
        .filter((project) => !deletedProjectIdsRef.current.has(String(project.projectId)));
      if (requestVersion !== projectListRequestVersionRef.current) {
        return projects.filter((project) => !deletedProjectIdsRef.current.has(String(project.projectId)));
      }
      setProjects(nextProjects);
      setProjectsError("");
      return nextProjects;
    } catch (error) {
      if (requestVersion === projectListRequestVersionRef.current) {
        setProjectsError(toApiErrorView(error).message || "项目列表读取失败，请稍后重试");
      }
      if (throwOnError) throw error;
      return projects;
    } finally {
      if (requestVersion === projectListRequestVersionRef.current) {
        setProjectsLoading(false);
      }
    }
  }

async function refreshProjectFolders({ throwOnError = false }: { throwOnError?: boolean } = {}) {
    const requestVersion = projectFolderListRequestVersionRef.current + 1;
    projectFolderListRequestVersionRef.current = requestVersion;
    setProjectFoldersLoading(true);
    setProjectFoldersError("");
    try {
      const result = await api.listProjectFolders();
      if (!Array.isArray((result as any)?.folders) && !Array.isArray(result)) {
        throw new Error("文件夹列表响应格式错误");
      }
      const nextFolders = normalizeProjectFolders(result)
        .filter((folder) => !deletedFolderIdsRef.current.has(folder.id))
        .map((folder) => ({
          ...folder,
          projectIds: folder.projectIds.filter((id) => !deletedProjectIdsRef.current.has(id)),
        }));
      if (requestVersion !== projectFolderListRequestVersionRef.current) {
        return projectFolders
          .filter((folder) => !deletedFolderIdsRef.current.has(folder.id))
          .map((folder) => ({
            ...folder,
            projectIds: folder.projectIds.filter((id) => !deletedProjectIdsRef.current.has(id)),
          }));
      }
      setProjectFolders(nextFolders);
      setProjectFoldersError("");
      return nextFolders;
    } catch (error) {
      if (requestVersion === projectFolderListRequestVersionRef.current) {
        setProjectFoldersError(toApiErrorView(error).message || "文件夹列表读取失败，请稍后重试");
      }
      if (throwOnError) throw error;
      return projectFolders;
    } finally {
      if (requestVersion === projectFolderListRequestVersionRef.current) {
        setProjectFoldersLoading(false);
      }
    }
  }

async function commitHeaderProjectRename() {
    if (!currentProjectId) {
      setHeaderProjectRenaming(false);
      return;
    }
    const fallbackName = currentProject?.name || canvasMeta.name || "未命名项目";
    const nextName = headerProjectRenameDraft.trim() || fallbackName;
    try {
      await api.renameProject(currentProjectId, nextName);
      setProjects((current) => current.map((project) => (
        project.projectId === currentProjectId ? { ...project, name: nextName } : project
      )));
      setHeaderProjectRenaming(false);
      setHeaderProjectRenameDraft("");
      setStatus(`项目已重命名为「${nextName}」`);
    } catch (error) {
      setStatus(`项目重命名失败：${toApiErrorView(error).message || "请稍后重试"}`);
    }
  }

function cancelHeaderProjectRename() {
    setHeaderProjectRenaming(false);
    setHeaderProjectRenameDraft("");
  }

async function inferCurrentProjectForCanvas(canvasId: string) {
    const contextEpoch = canvasContextEpochRef.current;
    const projectList = !projectsLoading && !projectsError
      ? projects
      : await refreshProjects({ throwOnError: true });
    if (canvasContextEpochRef.current !== contextEpoch) return null;
    for (const project of projectList) {
      const canvases = await ensureProjectCanvases(project.projectId, contextEpoch);
      if (canvasContextEpochRef.current !== contextEpoch) return null;
      if (canvases.some((canvas) => canvas.canvasId === canvasId)) {
        setCurrentProjectId(project.projectId);
        return project.projectId;
      }
    }
    return null;
  }

async function openProjectById(projectId: string) {
    try {
      const canvases = await ensureProjectCanvases(projectId);
      if (canvases.length > 0) {
        setCurrentProjectId(projectId);
        setProjectBrowserOpen(false);
        setProjectBrowserFolderId(null);
        navigateToCanvas(canvases[0].canvasId, projectId);
        return;
      }
      const created = await api.createCanvas("画布 1", projectId);
      const canvasId = String((created as any)?.canvasId || "");
      const revision = positiveCanvasRevision((created as any)?.revision);
      if (!canvasId || revision === null) {
        throw new Error("新画布创建响应缺少有效版本");
      }
      setProjectCanvases((current) => ({
        ...current,
        [projectId]: [{
          canvasId,
          revision,
          name: "画布 1",
          coverImageUrl: "",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }],
      }));
      setCurrentProjectId(projectId);
      setProjectBrowserOpen(false);
      setProjectBrowserFolderId(null);
      navigateToCanvas(canvasId, projectId);
    } catch (error) {
      setStatus(`打开项目失败：${toApiErrorView(error).message || "无法读取项目画布"}`);
    }
  }

async function createNewProject() {
    const created = await api.createProject("未命名项目");
    const projectId = (created as any)?.projectId;
    const defaultCanvasId = (created as any)?.defaultCanvasId;
    await refreshProjects();
    await refreshProjectFolders();
    if (projectId) setCurrentProjectId(projectId);
    if (defaultCanvasId) {
      setProjectMenuOpen(false);
      setProjectBrowserOpen(false);
      setProjectBrowserFolderId(null);
      navigateToCanvas(defaultCanvasId, projectId);
    }
  }

async function ensureProjectContextForCanvasCreation() {
    if (currentProjectId) return currentProjectId;
    const routedProjectId = positiveCanvasProjectId(routeProjectContextId);
    if (routedProjectId) {
      setCurrentProjectId(routedProjectId);
      return routedProjectId;
    }
    if (canvasMeta.canvasId) {
      const inferred = await inferCurrentProjectForCanvas(canvasMeta.canvasId);
      if (inferred) return inferred;
    }
    if (studioChrome) return null;
    const projectList = !projectsLoading && !projectsError
      ? projects
      : await refreshProjects({ throwOnError: true });
    if (projectList[0]?.projectId) {
      setCurrentProjectId(projectList[0].projectId);
      return projectList[0].projectId;
    }
    const created = await api.createProject("未命名项目").catch(() => null);
    const projectId = (created as any)?.projectId;
    if (projectId) {
      await refreshProjects();
      setCurrentProjectId(projectId);
      return projectId;
    }
    return null;
  }

async function createNewCanvas() {
    try {
      const projectId = await ensureProjectContextForCanvasCreation();
      if (!projectId) {
        setStatus("当前无法确定画布所属项目，请稍后重试");
        return;
      }
      const canvasesForProject = await ensureProjectCanvases(projectId);
      const defaultName = `画布 ${canvasesForProject.length + 1}`;
      const created = await api.createCanvas(defaultName, projectId);
      const canvasId = String((created as any)?.canvasId || "");
      const createdRevision = positiveCanvasRevision((created as any)?.revision);
      if (!canvasId || createdRevision === null) {
        throw new Error("画布创建响应缺少有效版本");
      }
      const canvases = await api.getProjectCanvases(projectId);
      if (!Array.isArray((canvases as any)?.canvases)) throw new Error("画布列表响应格式错误");
      setProjectCanvases((prev) => ({ ...prev, [projectId]: (canvases as any).canvases }));
      setCurrentProjectId(projectId);
      setCanvasSwitcherOpen(true);
      setCanvasRenamingId(canvasId);
      setCanvasRenameDraft(defaultName);
      navigateToCanvas(canvasId, projectId);
    } catch (error) {
      setStatus(`创建画布失败：${toApiErrorView(error).message || "请稍后重试"}`);
    }
  }

async function commitCanvasRename(canvasId: string, fallbackName: string) {
    try {
      const projectId = currentProjectId || (await inferCurrentProjectForCanvas(canvasId));
      if (!projectId) {
        setStatus("当前画布还没有有效项目归属，名称未保存");
        return;
      }
      const nextName = canvasRenameDraft.trim() || fallbackName;
      let expectedRevision = canvasMeta.canvasId === canvasId
        ? canvasServerRevisionRef.current
        : positiveCanvasRevision(
          (projectCanvases[projectId] || []).find((canvas) => canvas.canvasId === canvasId)?.revision,
        );
      if (expectedRevision === null) {
        try {
          const latest = await api.loadCanvas(canvasId);
          expectedRevision = positiveCanvasRevision((latest as any)?.revision);
        } catch (error) {
          setStatus(`画布重命名失败：${toApiErrorView(error).message || "无法读取画布版本"}`);
          return;
        }
      }
      if (expectedRevision === null) {
        setStatus("无法读取画布版本，名称未保存");
        return;
      }
      const renamed = await api.renameProjectCanvas(
        projectId,
        canvasId,
        nextName,
        expectedRevision,
      );
      const nextRevision = positiveCanvasRevision((renamed as any)?.revision);
      if (nextRevision === null || nextRevision !== expectedRevision + 1) {
        throw new Error("服务器未返回有效画布版本");
      }
      setProjectCanvases((current) => ({
        ...current,
        [projectId]: (current[projectId] || []).map((canvas) => (
          canvas.canvasId === canvasId
            ? { ...canvas, name: nextName, revision: nextRevision }
            : canvas
        )),
      }));
      setCurrentProjectId(projectId);
      if (canvasMeta.canvasId === canvasId) {
        canvasServerRevisionRef.current = nextRevision;
        setCanvasMeta((prev) => ({ ...prev, name: nextName, revision: nextRevision }));
      }
      setCanvasRenamingId(null);
      setCanvasRenameDraft("");
      setStatus(`画布已重命名为「${nextName}」`);
    } catch (error) {
      const conflict = canvasConflictFromError(error);
      if (conflict) {
        canvasConflictRef.current = true;
        setCanvasConflict(conflict);
        setCanvasSaveState("error");
        setStatus("画布已被其他操作更新，名称未覆盖服务器");
      } else {
        setStatus(`画布重命名失败：${toApiErrorView(error).message || "请稍后重试"}`);
      }
    }
  }

function cancelCanvasRename() {
    setCanvasRenamingId(null);
    setCanvasRenameDraft("");
  }

function handleCanvasRenameKeyDown(
    event: React.KeyboardEvent<HTMLInputElement>,
    canvasId: string,
    fallbackName: string,
  ) {
    if (event.key === "Enter") {
      event.preventDefault();
      void commitCanvasRename(canvasId, fallbackName);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      cancelCanvasRename();
    }
  }

async function createProjectFolder() {
    let created;
    try {
      created = await api.createProjectFolder({ name: "未命名文件夹", projectIds: [] });
    } catch (error) {
      setStatus(`创建文件夹失败：${error instanceof Error ? error.message : "请稍后重试"}`);
      return;
    }
    const folder = created ? normalizeProjectFolder((created as any).folder) : null;
    if (!folder) {
      setStatus("创建文件夹失败");
      return;
    }
    setProjectFolders((prev) => [folder, ...prev.filter((item) => item.id !== folder.id)]);
    setProjectBrowserRenamingId(folder.id);
    setProjectBrowserRenameDraft(folder.name);
    setFolderCreateToastOpen(true);
    window.setTimeout(() => setFolderCreateToastOpen(false), 2800);
  }

async function commitProjectBrowserRename(id: string, kind: "project" | "folder", fallbackName: string) {
    const nextName = projectBrowserRenameDraft.trim() || fallbackName;
    try {
      if (kind === "project") {
        await api.renameProject(id, nextName);
        setProjects((current) => current.map((project) => (
          project.projectId === id ? { ...project, name: nextName } : project
        )));
      } else {
        const updated = await api.updateProjectFolder(id, { name: nextName });
        if (!(updated as any)?.folder) throw new Error("文件夹响应格式错误");
        const folder = normalizeProjectFolder((updated as any).folder);
        setProjectFolders((prev) => prev.map((item) => (item.id === id ? folder : item)));
      }
      setProjectBrowserRenamingId(null);
      setProjectBrowserRenameDraft("");
      setStatus(`${kind === "project" ? "项目" : "文件夹"}已重命名为「${nextName}」`);
    } catch (error) {
      setStatus(`${kind === "project" ? "项目" : "文件夹"}重命名失败：${toApiErrorView(error).message || "请稍后重试"}`);
    }
  }

async function duplicateProjectItem(project: ProjectListItem) {
    let nextProjectId = "";
    try {
      const created = await api.createProject(`${project.name} - 副本`);
      nextProjectId = String((created as any)?.projectId || "");
      const defaultCanvasId = String((created as any)?.defaultCanvasId || "");
      if (!nextProjectId || !defaultCanvasId) throw new Error("副本项目创建失败");

      if (project.coverImageUrl) {
        await api.updateProject(nextProjectId, { coverImageUrl: project.coverImageUrl });
      }
      const sourceCanvases = await ensureProjectCanvases(project.projectId);
      for (let index = 0; index < sourceCanvases.length; index += 1) {
        const sourceCanvas = sourceCanvases[index];
        const targetCanvasId = index === 0
          ? defaultCanvasId
          : String((await api.createCanvas(sourceCanvas.name || `画布 ${index + 1}`, nextProjectId) as any)?.canvasId || "");
        if (!targetCanvasId) throw new Error(`第 ${index + 1} 个画布创建失败`);
        const loaded = await api.loadCanvas(sourceCanvas.canvasId);
        const duplicateNodes = repairLegacyNodes(Array.isArray((loaded as any)?.nodes) ? (loaded as any).nodes : []);
        const connections = Array.isArray((loaded as any)?.connections)
          ? (loaded as any).connections
          : Array.isArray((loaded as any)?.edges)
            ? (loaded as any).edges
            : [];
        await api.saveCanvas({
          canvasId: targetCanvasId,
          name: sourceCanvas.name || `画布 ${index + 1}`,
          nodes: duplicateNodes.map(sanitizeNodeForPersistence),
          edges: connections,
          connections,
          coverImageUrl: sourceCanvas.coverImageUrl || project.coverImageUrl || "",
        });
      }

      const refreshedProjects = await refreshProjects({ throwOnError: true });
      const canvases = await api.getProjectCanvases(nextProjectId);
      setProjectCanvases((current) => ({
        ...current,
        [nextProjectId]: Array.isArray((canvases as any)?.canvases) ? (canvases as any).canvases : [],
      }));
      setStatus(`项目「${project.name}」副本已创建`);
      if (refreshedProjects.some((item: ProjectListItem) => item.projectId === nextProjectId)) {
        setCurrentProjectId(nextProjectId);
      }
    } catch (error) {
      if (nextProjectId && canDelete) await api.deleteProject(nextProjectId).catch(() => null);
      setStatus(error instanceof Error ? `创建副本失败：${error.message}` : "创建副本失败，请稍后重试");
    }
  }

async function moveProjectToFolder(projectId: string, folderId: string) {
    const target = projectFolders.find((folder) => folder.id === folderId);
    if (!target) {
      setStatus("目标文件夹不存在，请刷新后重试");
      return;
    }
    const sources = projectFolders.filter((folder) => (
      folder.id !== folderId && folder.projectIds.includes(projectId)
    ));
    try {
      // Add to the target first. If a later source removal fails, the project
      // remains reachable in both folders instead of disappearing from all.
      await api.updateProjectFolder(folderId, {
        projectIds: Array.from(new Set([...target.projectIds, projectId])),
      });
      for (const source of sources) {
        await api.updateProjectFolder(source.id, {
          projectIds: source.projectIds.filter((id) => id !== projectId),
        });
      }
      await refreshProjectFolders({ throwOnError: true });
      setStatus(`项目已移动到「${target.name}」`);
    } catch (error) {
      await refreshProjectFolders().catch(() => projectFolders);
      setStatus(error instanceof Error
        ? `移动未完全完成：${error.message}；项目仍保留在至少一个文件夹，请刷新后核对`
        : "移动未完全完成；项目仍保留在至少一个文件夹，请刷新后核对");
    }
  }

function requestDeleteProjectItem(projectId: string) {
    if (!canDelete) return;
    projectDeleteOpenerRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setProjectActionMenuId(null);
    setProjectMenuOpen(false);
    setProjectDeleteError("");
    setProjectDeletePending(false);
    setProjectDeleteConfirmId(projectId);
  }

function closeProjectDeleteDialog({ restoreFocus = true } = {}) {
    setProjectDeleteConfirmId(null);
    setProjectDeleteError("");
    if (restoreFocus) {
      window.requestAnimationFrame(() => {
        const opener = projectDeleteOpenerRef.current;
        if (opener?.isConnected) opener.focus({ preventScroll: true });
      });
    }
  }

async function confirmDeleteProjectItem() {
    if (!canDelete) return;
    const projectId = projectDeleteConfirmId;
    if (!projectId || projectDeletePending) return;

    const routeProjectId = readProjectModeRouteContext(location).projectId;
    const deletingCurrentContext = (
      sameProjectIdentity(currentProjectId, projectId)
      || sameProjectIdentity(routeProjectId, projectId)
      || sameProjectIdentity(selectedProjectId, projectId)
    );
    const deletingSelectedProject = sameProjectIdentity(selectedProjectId, projectId);
    const deletingBoundSession = sameProjectIdentity(boundSessionProjectId, projectId);

    setProjectDeletePending(true);
    setProjectDeleteError("");
    let deletionOperation: DeletionOperationDto;
    try {
      deletionOperation = await api.requestProjectDeletion(projectId);
    } catch (error) {
      const message = toApiErrorView(error).message || "删除项目失败，请稍后重试";
      setProjectDeleteError(message);
      setStatus(message);
      setProjectDeletePending(false);
      return;
    }

    if (deletingCurrentContext) canvasContextEpochRef.current += 1;
    deletedProjectIdsRef.current.add(String(projectId));
    projectListRequestVersionRef.current += 1;
    projectFolderListRequestVersionRef.current += 1;
    removeSelectedProject(projectId);
    setProjects((current) => current.filter((project) => project.projectId !== projectId));
    setProjectFolders((current) => current.map((folder) => ({
      ...folder,
      projectIds: folder.projectIds.filter((folderProjectId) => folderProjectId !== projectId),
    })));
    setProjectCanvases((current) => {
      const next = { ...current };
      delete next[projectId];
      return next;
    });
    closeProjectDeleteDialog({ restoreFocus: false });

    if (deletingSelectedProject) {
      clearSelectedProject();
    }
    if (deletingBoundSession) {
      clearCreationSession();
    }

    if (deletingCurrentContext) {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      saveRevisionRef.current += 1;
      hydratedRef.current = false;
      canvasServerRevisionRef.current = null;
      canvasConflictRef.current = false;
      setCanvasConflict(null);
      window.localStorage.removeItem(LAST_ACTIVE_CANVAS_KEY);
      resetCanvasRuntimeState();
      setCanvasMeta({
        canvasId: null,
        projectId: null,
        revision: null,
        name: "未命名项目",
        loading: false,
        ready: false,
      });
      setCurrentProjectId(null);
      setProjectBrowserReturnCanvasId(null);

      const clearedHref = buildProjectModeHref("canvas", {
        projectId: null,
        sessionId: null,
        threadId: null,
        canvasId: null,
      }, location.search);
      const [pathname, rawSearch = ""] = clearedHref.split("?");
      const nextSearch = new URLSearchParams(rawSearch);
      nextSearch.set("browser", "projects");
      navigate(`${pathname}?${nextSearch.toString()}`, { replace: true });
      openProjectBrowser(false);
    }

    const finalizationPending = deletionOperation.status !== "completed";
    setStatus(finalizationPending
      ? "项目已从列表移除，正在后台清理"
      : "项目已删除");
    setProjectDeletePending(false);

    void Promise.allSettled([
      refreshProjects({ throwOnError: true }),
      refreshProjectFolders({ throwOnError: true }),
    ]).then((refreshResults) => {
      if (refreshResults.some((result) => result.status === "rejected")) {
        setStatus("项目已删除，但项目或文件夹列表刷新失败，请重试");
      }
    });

    if (finalizationPending) {
      void api.waitForProjectDeletion(deletionOperation).then(() => {
        setStatus("项目已删除");
      }).catch((error) => {
        if (error instanceof ApiError && error.status === 202) return;
        const message = toApiErrorView(error).message || "请稍后重试";
        setStatus(`项目已从列表移除，但后台清理未完成：${message}`);
      });
    }
  }

async function deleteFolderItem(folderId: string) {
    if (!canDelete) return;
    try {
      await api.deleteProjectFolder(folderId);
    } catch (error) {
      setStatus(toApiErrorView(error).message || "删除文件夹失败，请稍后重试");
      return;
    }

    deletedFolderIdsRef.current.add(folderId);
    projectFolderListRequestVersionRef.current += 1;
    setProjectFolders((current) => current.filter((folder) => folder.id !== folderId));
    if (projectBrowserFolderId === folderId) setProjectBrowserFolderId(null);
    setFolderActionMenuId(null);
    try {
      await refreshProjectFolders({ throwOnError: true });
      setStatus("文件夹已删除");
    } catch {
      setStatus("文件夹已删除，但文件夹列表刷新失败，请重试");
    }
  }

function handleProjectBrowserRenameKeyDown(event: React.KeyboardEvent<HTMLInputElement>, id: string, kind: "project" | "folder", fallbackName: string) {
    if (event.key === "Enter") {
      event.preventDefault();
      void commitProjectBrowserRename(id, kind, fallbackName);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setProjectBrowserRenamingId(null);
      setProjectBrowserRenameDraft("");
    }
  }
  return { startHeaderProjectRename, normalizeProjectFolder, normalizeProjectFolders, ensureProjectCanvases, refreshProjects, refreshProjectFolders, commitHeaderProjectRename, cancelHeaderProjectRename, inferCurrentProjectForCanvas, openProjectById, createNewProject, ensureProjectContextForCanvasCreation, createNewCanvas, commitCanvasRename, cancelCanvasRename, handleCanvasRenameKeyDown, createProjectFolder, commitProjectBrowserRename, duplicateProjectItem, moveProjectToFolder, requestDeleteProjectItem, closeProjectDeleteDialog, confirmDeleteProjectItem, deleteFolderItem, handleProjectBrowserRenameKeyDown };
}
