import React from "react";
import { LayoutGrid, PanelLeftClose, Save, Workflow } from "lucide-react";

export function renderImageGridSplitToolbarExternal(deps: any, node: any): React.ReactNode {
  const { imageGridSplitEditor, getCanvasToolbarScale, closeImageGridSplitEditor, createImageGridSplitGroup, submitImageGridSplitAssets } = deps;
  const renderImageGridSplitToolbar = (node: any) => {
    if (imageGridSplitEditor?.nodeId !== node.id) return null;
    const selectionCount = imageGridSplitEditor.selectedCells.length;
    const actionsEnabled = selectionCount > 0;
    const statusText = actionsEnabled ? `已选 ${selectionCount} 个宫格` : "请选择宫格进行操作";
    return (
      <div
        data-fixed-ui
        data-node-toolbar
        className="absolute z-[85] flex h-[54px] items-center rounded-[18px] border border-white/10 bg-[#232325]/98 px-3 text-white shadow-[0_24px_70px_rgba(0,0,0,0.38)] backdrop-blur whitespace-nowrap"
        style={{ left: node.x + node.width / 2, top: node.y - 72, width: 560, transform: `translateX(-50%) scale(${getCanvasToolbarScale()})`, transformOrigin: "center top" }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] text-white/82 transition hover:bg-white/10 hover:text-white"
          onClick={() => closeImageGridSplitEditor()}
        >
          <PanelLeftClose className="h-5 w-5" />
        </button>
        <div className="mx-4 h-8 w-px shrink-0 bg-white/10" />
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] text-white/88">
          <LayoutGrid className="h-5 w-5" />
        </div>
        <div className="mx-4 h-8 w-px shrink-0 bg-white/10" />
        <div className={`w-[190px] shrink-0 truncate whitespace-nowrap text-[14px] font-medium tracking-[0.01em] ${actionsEnabled ? "text-white/92" : "text-white/44"}`}>{statusText}</div>
        <div className="mx-4 h-8 w-px shrink-0 bg-white/10" />
        <button
          className={`inline-flex h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-[10px] px-3 text-[13px] font-medium transition ${actionsEnabled ? "text-white hover:bg-white/8" : "cursor-not-allowed text-white/28"}`}
          disabled={!actionsEnabled}
          onClick={() => void createImageGridSplitGroup()}
        >
          <Workflow className="h-4 w-4" />
          创建分镜组
        </button>
        <div className="mx-4 h-8 w-px shrink-0 bg-white/10" />
        <button
          className={`inline-flex h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-[10px] px-3 text-[13px] font-medium transition ${actionsEnabled ? "text-white hover:bg-white/8" : "cursor-not-allowed text-white/28"}`}
          disabled={!actionsEnabled}
          onClick={() => void submitImageGridSplitAssets()}
        >
          <Save className="h-4 w-4" />
          拆分并保存
        </button>
      </div>
    );
  };
  return renderImageGridSplitToolbar(node);
}
