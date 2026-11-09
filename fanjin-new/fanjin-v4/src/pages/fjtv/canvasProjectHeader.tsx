import type { Dispatch, SetStateAction, RefObject, ReactNode, JSX } from "react";
import type { ProjectCanvasItem, HistoryAssetItem, CanvasMetaState } from "./canvasDataTypes";
import { ChevronDown, FolderOpen, Plus } from "lucide-react";

export interface CanvasProjectHeaderDependencies {
  studioChrome: boolean;
  projectMenuOpen: boolean;
  setProjectMenuOpen: Dispatch<SetStateAction<boolean>>;
  setCanvasSwitcherOpen: Dispatch<SetStateAction<boolean>>;
  headerProjectRenaming: boolean;
  headerProjectRenameDraft: string;
  setHeaderProjectRenameDraft: Dispatch<SetStateAction<string>>;
  commitHeaderProjectRename: () => Promise<void>;
  cancelHeaderProjectRename: () => void;
  startHeaderProjectRename: () => Promise<void>;
  headerProjectName: string;
  showStudioCanvasSwitcher: boolean;
  canvasMeta: CanvasMetaState;
  canvasSwitcherOpen: boolean;
  createNewCanvas: () => Promise<void>;
  currentProjectCanvases: ProjectCanvasItem[];
  canvasRenamingId: string | null;
  navigateToCanvas: (canvasId: string, projectId?: string | null) => void;
  setCanvasRenamingId: Dispatch<SetStateAction<string | null>>;
  setCanvasRenameDraft: Dispatch<SetStateAction<string>>;
  canvasRenameDraft: string;
  commitCanvasRename: (canvasId: string, fallbackName: string) => Promise<void>;
  handleCanvasRenameKeyDown: (event: React.KeyboardEvent<HTMLInputElement>, canvasId: string, fallbackName: string) => void;
  closeBottomPanels: () => void;
  setHistoryPreviewItem: Dispatch<SetStateAction<HistoryAssetItem | null>>;
  navigate: (to: string) => void;
  openProjectBrowser: (preserveCanvas?: boolean) => void;
  createNewProject: () => Promise<void>;
  projectDeleteConfirmId: string | null;
  activeProjectContextId: string | null;
  canDelete: boolean;
  requestDeleteProjectItem: (projectId: string) => void;
}

export function createCanvasProjectHeader(deps: CanvasProjectHeaderDependencies) {
  const {
    studioChrome,
    projectMenuOpen,
    setProjectMenuOpen,
    setCanvasSwitcherOpen,
    headerProjectRenaming,
    headerProjectRenameDraft,
    setHeaderProjectRenameDraft,
    commitHeaderProjectRename,
    cancelHeaderProjectRename,
    startHeaderProjectRename,
    headerProjectName,
    showStudioCanvasSwitcher,
    canvasMeta,
    canvasSwitcherOpen,
    createNewCanvas,
    currentProjectCanvases,
    canvasRenamingId,
    navigateToCanvas,
    setCanvasRenamingId,
    setCanvasRenameDraft,
    canvasRenameDraft,
    commitCanvasRename,
    handleCanvasRenameKeyDown,
    closeBottomPanels,
    setHistoryPreviewItem,
    navigate,
    openProjectBrowser,
    createNewProject,
    projectDeleteConfirmId,
    activeProjectContextId,
    canDelete,
    requestDeleteProjectItem,
  } = deps;
  function renderProjectHeaderCluster() {
    return (
      <div
        data-top-shell
        className={`canvas-project-header-cluster relative flex items-center gap-2 ${studioChrome ? "canvas-studio-project-header-cluster" : ""}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="canvas-topbar-cluster flex items-center text-[13px]">
          <button
            type="button"
            aria-label={projectMenuOpen ? "收起项目菜单" : "打开项目菜单"}
            aria-expanded={projectMenuOpen}
            aria-controls="canvas-project-menu"
            onClick={() => {
              setProjectMenuOpen((prev) => !prev);
              setCanvasSwitcherOpen(false);
            }}
            className={`canvas-project-menu-button flex items-center transition ${studioChrome ? "canvas-studio-project-menu-button" : "h-10 gap-2 rounded-[10px] px-3"}`}
          >
            {studioChrome ? (
              <FolderOpen className="h-4 w-4" aria-hidden="true" />
            ) : (
              <span className="canvas-brand-mark" aria-hidden="true">
                <svg className="canvas-brand-logo-image" viewBox="212 232 362 440" focusable="false">
                  <path fill="currentColor" d="M212 232H438V314H296V672H212V232Z" />
                  <path fill="currentColor" d="M486 232H574V556C574 626.2 528.2 672 458 672H348V588H454C473.6 588 486 575.6 486 556V232Z" />
                  <rect fill="currentColor" x="348" y="412" width="88" height="88" />
                </svg>
              </span>
            )}
            <ChevronDown className="h-3 w-3 text-[#9a9ca2]" />
          </button>
          {studioChrome ? <span className="canvas-studio-project-label">项目</span> : null}
          {headerProjectRenaming ? (
            <input
              autoFocus
              value={headerProjectRenameDraft}
              onChange={(event) => setHeaderProjectRenameDraft(event.target.value)}
              onBlur={() => void commitHeaderProjectRename()}
              onClick={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void commitHeaderProjectRename();
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  cancelHeaderProjectRename();
                }
              }}
              className={studioChrome ? "canvas-studio-project-input" : "h-10 w-[220px] rounded-[10px] bg-[#333336] px-4 text-white outline-none"}
            />
          ) : (
            <button
              type="button"
              onDoubleClick={(event) => {
                event.stopPropagation();
                startHeaderProjectRename();
              }}
              className="canvas-project-title-button flex h-10 max-w-[220px] items-center rounded-[10px] px-4 transition"
            >
              <span className="truncate">{headerProjectName}</span>
            </button>
          )}
          {!studioChrome || showStudioCanvasSwitcher ? (
            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  setCanvasSwitcherOpen((prev) => !prev);
                  setProjectMenuOpen(false);
                }}
                className="canvas-canvas-switcher-button flex h-10 items-center gap-2 rounded-[10px] bg-[#4a4a4d] px-4 transition hover:bg-[#55565a]"
              >
                <span className="max-w-[140px] truncate">{canvasMeta.name}</span>
                <ChevronDown className="h-3 w-3 text-[#dbdcdf]" />
              </button>
              {canvasSwitcherOpen ? (
                <div data-canvas-switcher-menu className="absolute left-0 top-[54px] z-20 w-[214px] rounded-[16px] border border-[#434448] bg-[#2a2a2b] p-3 shadow-[0_22px_42px_rgba(0,0,0,0.34)]">
                  <div className="mb-2 flex items-center justify-between text-[12px] text-[#9a9ca2]">
                    <span>画布</span>
                    <button type="button" aria-label="创建新看板" className="rounded p-1 hover:bg-[#37373a]" onClick={() => void createNewCanvas()}>
                      <Plus className="h-4 w-4 text-white" aria-hidden="true" />
                    </button>
                  </div>
                  <div className="space-y-1">
                    {currentProjectCanvases.map((canvas) => (
                      <button
                        key={canvas.canvasId}
                        className={`flex h-11 w-full items-center justify-between rounded-[10px] px-3 text-left text-[15px] ${canvas.canvasId === canvasMeta.canvasId ? "bg-[#333336] text-white" : "text-[#d8d8da] hover:bg-[#333336]"}`}
                        onClick={() => {
                          if (canvasRenamingId === canvas.canvasId) return;
                          navigateToCanvas(canvas.canvasId);
                        }}
                        onDoubleClick={(event) => {
                          event.stopPropagation();
                          setCanvasRenamingId(canvas.canvasId);
                          setCanvasRenameDraft(canvas.name);
                        }}
                      >
                        {canvasRenamingId === canvas.canvasId ? (
                          <input
                            data-canvas-control
                            autoFocus
                            value={canvasRenameDraft}
                            onChange={(event) => setCanvasRenameDraft(event.target.value)}
                            onBlur={() => void commitCanvasRename(canvas.canvasId, canvas.name)}
                            onClick={(event) => event.stopPropagation()}
                            onDoubleClick={(event) => event.stopPropagation()}
                            onKeyDown={(event) => handleCanvasRenameKeyDown(event, canvas.canvasId, canvas.name)}
                            className="mr-3 h-8 flex-1 rounded bg-[#2c2c2f] px-2 text-white outline-none"
                          />
                        ) : (
                          <span className="truncate">{canvas.name}</span>
                        )}
                        {canvas.canvasId === canvasMeta.canvasId ? <span className="text-white">✓</span> : null}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        {projectMenuOpen ? (
          <div id="canvas-project-menu" data-project-menu className="absolute left-0 top-[56px] z-20 w-[198px] rounded-[16px] border border-[#434448] bg-[#2a2a2b] p-2 shadow-[0_22px_42px_rgba(0,0,0,0.34)]">
            <button className="block h-11 w-full rounded-[10px] px-4 text-left text-[15px] text-white hover:bg-[#3a3a3d]" onClick={() => { closeBottomPanels(); setProjectMenuOpen(false); setCanvasSwitcherOpen(false); setHistoryPreviewItem(null); navigate("/workbench/create"); }}>
              回到主页
            </button>
            <button className="mt-1 block h-11 w-full rounded-[10px] px-4 text-left text-[15px] text-white hover:bg-[#3a3a3d]" onClick={() => openProjectBrowser()}>
              全部项目
            </button>
            <button className="mt-1 block h-11 w-full rounded-[10px] bg-[#4a4a4d] px-4 text-left text-[15px] text-white hover:bg-[#56565b]" onClick={() => void createNewProject()}>
              创建新项目
            </button>
            <button
              type="button"
              aria-haspopup="dialog"
              aria-expanded={projectDeleteConfirmId === activeProjectContextId}
              aria-controls="canvas-project-delete-dialog"
                        disabled={!canDelete}
              className="mt-1 block h-11 w-full rounded-[10px] px-4 text-left text-[15px] text-white hover:bg-[#3a3a3d]"
              onClick={() => activeProjectContextId ? requestDeleteProjectItem(activeProjectContextId) : undefined}
            >
              删除项目
            </button>
          </div>
        ) : null}
      </div>
    );
  }
  return renderProjectHeaderCluster;
}
