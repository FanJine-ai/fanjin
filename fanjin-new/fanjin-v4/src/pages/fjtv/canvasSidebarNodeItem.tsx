import type { Dispatch, SetStateAction } from "react";
import type { NodeData } from "./canvasDataTypes";
import ReferencePreviewImage from "@/features/quick-create/attachments/ReferencePreviewImage";
import { ReferencePreviewVideo } from "@/features/quick-create/attachments/AuthenticatedReferenceMedia";
import { Image as ImageIcon, MoreHorizontal, Scissors, Type, Video } from "lucide-react";

export interface CanvasSidebarRendererDependencies {
  activeNodeId: string | null;
  sidebarRenamingNodeId: string | null;
  focusNodeInViewport: (nodeId: string) => void;
  sidebarRenameDraft: string;
  setSidebarRenameDraft: Dispatch<SetStateAction<string>>;
  commitSidebarRename: (nodeId: string, fallbackTitle: string) => Promise<void>;
  cancelSidebarRename: () => void;
  openNodeMenuId: string | null;
  setOpenNodeMenuId: Dispatch<SetStateAction<string | null>>;
  startSidebarRename: (node: NodeData) => void;
  duplicateNodeFromManager: (nodeId: string) => Promise<void>;
}

export function createCanvasSidebarRenderer(deps: CanvasSidebarRendererDependencies) {
  const {
    activeNodeId,
    sidebarRenamingNodeId,
    focusNodeInViewport,
    sidebarRenameDraft,
    setSidebarRenameDraft,
    commitSidebarRename,
    cancelSidebarRename,
    openNodeMenuId,
    setOpenNodeMenuId,
    startSidebarRename,
    duplicateNodeFromManager,
  } = deps;
  function renderCanvasSidebarNodeItem(node: NodeData, nested = false) {
    const isActive = node.id === activeNodeId;
    const isRenaming = sidebarRenamingNodeId === node.id;
    const preview = node.imageUrl || node.localPreviewUrl || node.videoUrl || node.localVideoUrl;
    return (
      <div
        key={node.id}
        data-canvas-sidebar-node
        data-active={isActive ? "true" : "false"}
        data-nested={nested ? "true" : "false"}
        className={`group relative rounded-xl border px-2 py-1.5 transition ${
          isActive ? "border-[#3a414d] bg-[#252a33]" : "border-transparent bg-transparent hover:bg-[#20242c]"
        } ${nested ? "ml-3" : ""}`}
        onClick={(event) => {
          event.stopPropagation();
          focusNodeInViewport(node.id);
        }}
      >
        <div className="flex items-center gap-2">
          <div data-canvas-sidebar-thumbnail className="h-9 w-9 shrink-0 overflow-hidden rounded-lg border border-[#333845] bg-[#11151d]">
            {preview ? (
              node.type === "video" ? (
                <ReferencePreviewVideo src={preview} className="h-full w-full object-cover" />
              ) : (
                <ReferencePreviewImage src={preview} alt={node.title} className="h-full w-full object-cover" />
              )
            ) : (
              <div className="flex h-full w-full items-center justify-center text-[#8f98a8]">
                {node.type === "image" ? <ImageIcon className="h-4 w-4" /> : node.type === "video" ? <Video className="h-4 w-4" /> : node.type === "compose" ? <Scissors className="h-4 w-4" /> : <Type className="h-4 w-4" />}
              </div>
            )}
          </div>
          <div className="min-w-0 flex-1">
            {isRenaming ? (
              <input
                autoFocus
                value={sidebarRenameDraft}
                onChange={(event) => setSidebarRenameDraft(event.target.value)}
                onClick={(event) => event.stopPropagation()}
                onBlur={() => void commitSidebarRename(node.id, node.title)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void commitSidebarRename(node.id, node.title);
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    cancelSidebarRename();
                  }
                }}
                className="h-8 w-full rounded-lg border border-[#3a404a] bg-[#10151f] px-2 text-sm text-white outline-none"
              />
            ) : (
              <div data-canvas-sidebar-node-title className="truncate text-sm text-white">{node.title}</div>
            )}
          </div>
          <button
            type="button"
            aria-label={`打开 ${node.title} 操作菜单`}
            aria-expanded={openNodeMenuId === node.id}
            onClick={(event) => {
              event.stopPropagation();
              setOpenNodeMenuId((prev) => (prev === node.id ? null : node.id));
            }}
            data-canvas-sidebar-node-more
            className="flex h-7 w-7 items-center justify-center rounded-lg text-[#cbd2dc] opacity-100 transition hover:bg-[#303641] hover:text-white"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
        </div>

        {openNodeMenuId === node.id ? (
          <div data-canvas-sidebar-node-menu className="absolute right-2 top-[calc(100%+8px)] z-20 w-[132px] overflow-hidden rounded-2xl border border-[#2e333c] bg-[#15181f] py-1 shadow-[0_16px_35px_rgba(0,0,0,0.45)]">
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                startSidebarRename(node);
              }}
              className="block w-full px-4 py-2 text-left text-sm text-white transition hover:bg-[#242933]"
            >
              重命名
            </button>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                void duplicateNodeFromManager(node.id);
              }}
              className="block w-full px-4 py-2 text-left text-sm text-white transition hover:bg-[#242933]"
            >
              创建副本
            </button>
          </div>
        ) : null}
      </div>
    );
  }
  return renderCanvasSidebarNodeItem;
}
