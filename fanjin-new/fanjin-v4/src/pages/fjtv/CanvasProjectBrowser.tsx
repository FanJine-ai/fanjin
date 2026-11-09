import type { Dispatch, SetStateAction, RefObject, ReactNode, JSX } from "react";
import type { ProjectListItem, ProjectFolderItem } from "./canvasDataTypes";
import ReferencePreviewImage from "@/features/quick-create/attachments/ReferencePreviewImage";
import { Check, ChevronLeft, FolderPlus, Image as ImageIcon, LoaderCircle, MoreHorizontal, Plus, X } from "lucide-react";
import fanjinLogo from "@/assets/fanjin-logo-fj.svg";
import { getCanvasImagePreviewUrl } from "./canvasAssetPresentation";

export interface CanvasProjectBrowserDependencies {
  projectBrowserOpen: boolean;
  canvasColorMode: "dark" | "light";
  folderCreateToastOpen: boolean;
  setFolderCreateToastOpen: Dispatch<SetStateAction<boolean>>;
  closeProjectBrowser: () => void;
  createProjectFolder: () => Promise<void>;
  projectsError: string;
  projectFoldersError: string;
  refreshProjects: (options?: { throwOnError?: boolean; }) => Promise<ProjectListItem[]>;
  refreshProjectFolders: (options?: { throwOnError?: boolean; }) => Promise<ProjectFolderItem[]>;
  projectsLoading: boolean;
  projectFoldersLoading: boolean;
  projects: ProjectListItem[];
  projectFolders: ProjectFolderItem[];
  createNewProject: () => Promise<void>;
  projectBrowserFolderId: string | null;
  setProjectBrowserFolderId: Dispatch<SetStateAction<string | null>>;
  projectBrowserRenamingId: string | null;
  projectBrowserRenameDraft: string;
  setProjectBrowserRenameDraft: Dispatch<SetStateAction<string>>;
  commitProjectBrowserRename: (id: string, kind: "project" | "folder", fallbackName: string) => Promise<void>;
  handleProjectBrowserRenameKeyDown: (event: React.KeyboardEvent<HTMLInputElement>, id: string, kind: "project" | "folder", fallbackName: string) => void;
  setFolderActionMenuId: Dispatch<SetStateAction<string | null>>;
  folderActionMenuId: string | null;
  setProjectBrowserRenamingId: Dispatch<SetStateAction<string | null>>;
  canDelete: boolean;
  deleteFolderItem: (folderId: string) => Promise<void>;
  visibleProjects: ProjectListItem[];
  openProjectById: (projectId: string) => Promise<void>;
  setProjectActionMenuId: Dispatch<SetStateAction<string | null>>;
  projectActionMenuId: string | null;
  duplicateProjectItem: (project: ProjectListItem) => Promise<void>;
  moveProjectToFolder: (projectId: string, folderId: string) => Promise<void>;
  projectDeleteConfirmId: string | null;
  requestDeleteProjectItem: (projectId: string) => void;
}

export function createCanvasProjectBrowser(deps: CanvasProjectBrowserDependencies) {
  const {
    projectBrowserOpen,
    canvasColorMode,
    folderCreateToastOpen,
    setFolderCreateToastOpen,
    closeProjectBrowser,
    createProjectFolder,
    projectsError,
    projectFoldersError,
    refreshProjects,
    refreshProjectFolders,
    projectsLoading,
    projectFoldersLoading,
    projects,
    projectFolders,
    createNewProject,
    projectBrowserFolderId,
    setProjectBrowserFolderId,
    projectBrowserRenamingId,
    projectBrowserRenameDraft,
    setProjectBrowserRenameDraft,
    commitProjectBrowserRename,
    handleProjectBrowserRenameKeyDown,
    setFolderActionMenuId,
    folderActionMenuId,
    setProjectBrowserRenamingId,
    canDelete,
    deleteFolderItem,
    visibleProjects,
    openProjectById,
    setProjectActionMenuId,
    projectActionMenuId,
    duplicateProjectItem,
    moveProjectToFolder,
    projectDeleteConfirmId,
    requestDeleteProjectItem,
  } = deps;
  function renderCanvasProjectBrowser() { return (projectBrowserOpen ? (
        <div data-fixed-ui data-project-browser data-project-theme={canvasColorMode} role="region" aria-label="项目选择" className="absolute inset-0 z-[88] overflow-auto px-4 pb-10 pt-5" style={{ background: "var(--studio-workspace-bg, var(--canvas-overlay-surface))" }}>
          {folderCreateToastOpen ? (
            <div className="fixed left-1/2 top-12 z-[170] flex h-[66px] -translate-x-1/2 items-center gap-4 rounded-[16px] bg-[#318a2f] px-7 text-[24px] font-bold text-white shadow-[0_18px_42px_rgba(0,0,0,.35)]">
              <Check className="h-8 w-8 rounded-full border-2 border-white p-1" />
              文件夹创建成功
              <button type="button" onClick={() => setFolderCreateToastOpen(false)} className="ml-5 text-white/80 hover:text-white"><X className="h-8 w-8" /></button>
            </div>
          ) : null}
          <div
            data-project-browser-content
            className="mx-auto max-w-[1780px]"
            style={{ zoom: 1 }}
          >
            <div data-project-browser-toolbar className="mb-6 flex flex-wrap items-center justify-between gap-3">
              <div className="flex shrink-0 items-center gap-3 text-white">
                <ReferencePreviewImage src={fanjinLogo} alt="繁境" className="h-6 w-6" style={{ filter: canvasColorMode === "dark" ? "invert(1)" : undefined }} />
                <span className="text-sm font-semibold">繁境</span>
              </div>
            </div>

            <div data-project-browser-heading className="mb-6 flex flex-wrap items-center justify-between gap-3">
              <div className="flex shrink-0 items-center gap-4 text-white">
                <button className="inline-flex h-10 items-center gap-1 text-sm hover:text-white/78" onClick={closeProjectBrowser}><ChevronLeft className="h-4 w-4" />返回</button>
                <span className="h-5 w-px bg-white/24" />
                <h2 className="text-lg font-semibold">全部项目</h2>
              </div>
              <button className="ml-auto inline-flex h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-[10px] bg-[#2f2f31] px-3 text-sm font-medium text-white transition hover:bg-[#6b6b6d]" onClick={createProjectFolder}><FolderPlus className="h-4 w-4" />新建文件夹</button>
            </div>

            {projectsError || projectFoldersError ? (
              <div data-canvas-alert role="alert" className="mb-6 flex items-center justify-between gap-5 rounded-[14px] border border-[#8a5a3b] bg-[#35271f] px-5 py-4 text-white">
                <div>
                  <div className="text-[16px] font-semibold">项目库加载失败</div>
                  <div data-canvas-danger className="mt-1 text-[13px] leading-6 text-[#e1bea7]">
                    {[projectsError, projectFoldersError].filter(Boolean).join("；")}
                  </div>
                </div>
                <button
                  type="button"
                  className="shrink-0 rounded-[10px] border border-white/24 px-4 py-2 text-[13px] font-semibold hover:bg-white/10"
                  onClick={() => {
                    void Promise.allSettled([
                      refreshProjects({ throwOnError: true }),
                      refreshProjectFolders({ throwOnError: true }),
                    ]);
                  }}
                >
                  重新加载
                </button>
              </div>
            ) : null}
            {(projectsLoading || projectFoldersLoading) && projects.length === 0 && projectFolders.length === 0 ? (
              <div data-canvas-info role="status" className="mb-6 flex items-center gap-3 rounded-[14px] border border-[#3e4045] bg-[#222326] px-5 py-4 text-[#b5b8bf]">
                <LoaderCircle className="h-5 w-5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                正在读取项目与文件夹…
              </div>
            ) : null}

            <div
              data-project-browser-grid
              className="grid gap-4"
              style={{
                gridTemplateColumns: "repeat(auto-fill, minmax(min(144px, 100%), 1fr))",
              }}
            >
              <button className="w-full max-w-[220px] self-start text-left" onClick={() => void createNewProject()}>
                <div className="flex aspect-[9/16] items-center justify-center rounded-[18px] border border-[#434448] bg-[#2a2a2b] text-[#9a9ca2]">
                  <div className="text-center">
                    <Plus className="mx-auto mb-3 h-8 w-8" />
                    <div className="text-base font-medium text-white">开始创作</div>
                  </div>
                </div>
                <div className="mt-3 text-sm font-medium text-white">创建新的视频项目</div>
              </button>

              {projectFolders.filter((folder) => !projectBrowserFolderId || folder.id === projectBrowserFolderId).map((folder) => (
                <div key={folder.id} className="group relative w-full max-w-[220px] self-start">
                  <button
                    type="button"
                    aria-label={`打开文件夹 ${folder.name}`}
                    className="block w-full text-left"
                    onClick={() => setProjectBrowserFolderId(folder.id)}
                  >
                    <div className="relative aspect-[9/16] overflow-hidden rounded-[18px] border border-[#44454a] bg-[#151515] transition group-hover:border-white/28">
                      <div className="absolute inset-[18px] rounded-[17px] border border-white/55 bg-transparent" />
                      <div className="absolute left-[6%] top-[1px] h-[68px] w-[35%] rounded-t-[15px] border border-white/70 bg-[linear-gradient(180deg,#6a6b6d_0%,#4b4c4e_44%,#303133_100%)] shadow-[inset_0_1px_2px_rgba(255,255,255,.22)]" />
                      <div className="absolute left-[26%] top-[38px] h-[22px] w-[34%] -skew-x-[32deg] rounded-r-[12px] bg-[#393a3c]" />
                      <div className="absolute left-[9%] right-[5%] top-[42px] h-[103px] rounded-[14px] border border-white/60 bg-[linear-gradient(180deg,#4a4b4d_0%,#323335_43%,#151516_100%)] shadow-[inset_0_1px_2px_rgba(255,255,255,.16),0_16px_28px_rgba(0,0,0,.42)]" />
                      <div className="absolute left-[9%] right-[5%] bottom-[9px] h-[55px] rounded-b-[14px] bg-[linear-gradient(180deg,transparent,rgba(0,0,0,.34))]" />
                    </div>
                  </button>
                  <div className="mt-3 flex items-center justify-between gap-2 text-white">
                    {projectBrowserRenamingId === folder.id ? (
                      <input aria-label="文件夹名称" data-canvas-control autoFocus value={projectBrowserRenameDraft} onChange={(e) => setProjectBrowserRenameDraft(e.target.value)} onBlur={() => void commitProjectBrowserRename(folder.id, "folder", folder.name)} onKeyDown={(event) => handleProjectBrowserRenameKeyDown(event, folder.id, "folder", folder.name)} className="w-[85%] rounded bg-[#2c2c2f] px-2 py-1 outline-none" />
                    ) : (
                      <button type="button" className="min-w-0 flex-1 truncate text-left text-sm font-medium" onClick={() => setProjectBrowserFolderId(folder.id)}>{folder.name}</button>
                    )}
                    <button type="button" aria-label={`打开文件夹菜单 ${folder.name}`} onClick={() => setFolderActionMenuId((prev) => prev === folder.id ? null : folder.id)}><MoreHorizontal className="h-4 w-4" /></button>
                  </div>
                  <div className="mt-1 text-xs text-[#9aa4b4]">{new Date(folder.createdAt).toISOString().slice(0, 10)}</div>
                  {folderActionMenuId === folder.id ? (
                    <div data-folder-action-menu className="absolute right-0 top-[calc(100%-72px)] z-10 w-[170px] rounded-[14px] border border-[#434448] bg-[#2a2a2b] p-2 text-sm text-white">
                      <button className="block h-10 w-full rounded px-3 text-left hover:bg-[#3a3a3d]" onClick={() => setProjectBrowserFolderId(folder.id)}>打开</button>
                      <button className="block h-10 w-full rounded px-3 text-left hover:bg-[#3a3a3d]" onClick={() => { setProjectBrowserRenamingId(folder.id); setProjectBrowserRenameDraft(folder.name); setFolderActionMenuId(null); }}>重命名</button>
                      <button disabled={!canDelete} className="block h-10 w-full rounded px-3 text-left text-[#ff8d8d] hover:bg-[#3a3a3d] disabled:opacity-45 disabled:cursor-not-allowed" onClick={() => void deleteFolderItem(folder.id)}>删除文件夹</button>
                    </div>
                  ) : null}
                </div>
              ))}

              {visibleProjects.map((project) => (
                <div key={project.projectId} className="group relative w-full max-w-[220px] self-start">
                  <button
                    type="button"
                    aria-label={`打开项目 ${project.name}`}
                    className="block w-full text-left"
                    onClick={() => void openProjectById(project.projectId)}
                  >
                    <div className="aspect-[9/16] overflow-hidden rounded-[18px] border border-[#34353a] bg-[#242426] transition group-hover:border-white/18">
                      {project.coverImageUrl ? <ReferencePreviewImage src={getCanvasImagePreviewUrl(project.coverImageUrl, 540)} alt={project.name} loading="lazy" decoding="async" className="h-full w-full object-cover transition duration-300 ease-out group-hover:scale-[1.04]" /> : <div className="flex h-full items-center justify-center text-[#6e7075]"><ImageIcon className="h-10 w-10" /></div>}
                    </div>
                  </button>
                  <div className="mt-3 flex items-center justify-between gap-2 text-white">
                    {projectBrowserRenamingId === project.projectId ? (
                      <input data-canvas-control autoFocus value={projectBrowserRenameDraft} onChange={(e) => setProjectBrowserRenameDraft(e.target.value)} onBlur={() => void commitProjectBrowserRename(project.projectId, "project", project.name)} onKeyDown={(event) => handleProjectBrowserRenameKeyDown(event, project.projectId, "project", project.name)} className="w-[85%] rounded bg-[#2c2c2f] px-2 py-1 outline-none" />
                    ) : (
                      <button type="button" className="min-w-0 flex-1 truncate text-left text-sm font-medium" onClick={() => void openProjectById(project.projectId)}>{project.name}</button>
                    )}
                    <button type="button" aria-label={`打开项目菜单 ${project.name}`} onClick={() => setProjectActionMenuId((prev) => prev === project.projectId ? null : project.projectId)}><MoreHorizontal className="h-4 w-4" /></button>
                  </div>
                  <div className="mt-1 text-xs text-[#9aa4b4]">{String(project.updatedAt).slice(0, 10)}</div>
                  {projectActionMenuId === project.projectId ? (
                    <div data-project-action-menu className="absolute right-0 top-[calc(100%-72px)] z-10 w-[192px] rounded-[14px] border border-[#434448] bg-[#2a2a2b] p-2 text-sm text-white">
                      <button className="block h-10 w-full rounded px-3 text-left hover:bg-[#3a3a3d]" onClick={() => void openProjectById(project.projectId)}>打开</button>
                      <button className="block h-10 w-full rounded px-3 text-left hover:bg-[#3a3a3d]" onClick={() => { setProjectBrowserRenamingId(project.projectId); setProjectBrowserRenameDraft(project.name); setProjectActionMenuId(null); }}>重命名</button>
                      <button className="block h-10 w-full rounded px-3 text-left hover:bg-[#3a3a3d]" onClick={() => { void duplicateProjectItem(project); setProjectActionMenuId(null); }}>创建副本</button>
                      <div className="px-3 py-2 text-[#9a9ca2]">移动至文件夹</div>
                      {projectFolders.length > 0 ? projectFolders.map((folder) => (
                        <button key={folder.id} className="block h-9 w-full rounded px-3 text-left hover:bg-[#3a3a3d]" onClick={() => { moveProjectToFolder(project.projectId, folder.id); setProjectActionMenuId(null); }}>
                          {folder.name}
                        </button>
                      )) : <div className="px-3 py-1 text-[#6f7176]">暂无文件夹</div>}
                      <button
                        type="button"
                        aria-haspopup="dialog"
                        aria-expanded={projectDeleteConfirmId === project.projectId}
                        aria-controls="canvas-project-delete-dialog"
                        disabled={!canDelete}
                        className="mt-1 block h-10 w-full rounded px-3 text-left text-[#ff8d8d] hover:bg-[#3a3a3d]"
                        onClick={() => requestDeleteProjectItem(project.projectId)}
                      >
                        删除项目
                      </button>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
            {!projectsLoading && !projectFoldersLoading && !projectsError && !projectFoldersError ? (
              <div className="mt-10 text-center text-xs text-[#7d8694]">没有更多了</div>
            ) : null}
          </div>
        </div>
      ) : null); }
  return renderCanvasProjectBrowser;
}
