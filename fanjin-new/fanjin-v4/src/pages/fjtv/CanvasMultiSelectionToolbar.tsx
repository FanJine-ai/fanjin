import { useCanvasRedraw } from "./CanvasRedrawProvider";
import { Palette } from "lucide-react";
import { NODE_WIDTH } from "./canvasMediaGeometry";
import { Copy, Download, FolderPlus, Workflow, ChevronDown } from "lucide-react";
import { CanvasSelectionToolbarFrame } from "./CanvasSelectionToolbarFrame";
import { CanvasSelectionLayoutMenu } from "./CanvasSelectionLayoutMenu";
import { CanvasSelectionActionButton } from "./CanvasSelectionActionButton";

export function CanvasMultiSelectionToolbar({ bounds, centerX, top, scale, frameStyle, layoutOpen, onToggleLayout, onApplyLayout, onSave, onDuplicate, onDownload, onGroup }: { bounds: { left: number; top: number; right: number; bottom: number }; centerX: number; top: number; scale: number; frameStyle: CSSProperties; layoutOpen: boolean; onToggleLayout: () => void; onApplyLayout: (layout: "grid" | "horizontal" | "vertical") => void; onSave: () => void; onDuplicate: () => void; onDownload: () => void; onGroup: () => void }) {
  const redraw=useCanvasRedraw();
  return <CanvasSelectionToolbarFrame bounds={bounds} centerX={centerX} top={top} scale={scale} frameStyle={frameStyle}>
    <div className="relative pr-3"><CanvasSelectionLayoutMenu open={layoutOpen} onToggle={onToggleLayout} onApply={onApplyLayout} /></div>
    <div className="h-7 w-px bg-[#3c3d42]" />
    {redraw ? <CanvasSelectionActionButton label="转绘节点" Icon={Palette} className="flex h-9 flex-none items-center gap-2 px-4 hover:text-white" onAction={()=>redraw.create(bounds.right+NODE_WIDTH/2+100,(bounds.top+bounds.bottom)/2,redraw.selectedNodeIds)}/> : null}
    <CanvasSelectionActionButton label="保存到资产" Icon={FolderPlus} className="flex h-9 min-w-[112px] flex-none items-center justify-center gap-2 px-4 whitespace-nowrap hover:text-white" onAction={onSave} />
    <div className="h-7 w-px bg-[#3c3d42]" />
    <CanvasSelectionActionButton label="创建副本" Icon={Copy} className="flex h-9 min-w-[104px] flex-none items-center justify-center gap-2 px-4 whitespace-nowrap hover:text-white" onAction={onDuplicate} />
    <div className="h-7 w-px bg-[#3c3d42]" />
    <CanvasSelectionActionButton label="下载" Icon={Download} className="flex h-9 min-w-[78px] flex-none items-center justify-center gap-2 px-4 whitespace-nowrap hover:text-white" onAction={onDownload} />
    <div className="h-7 w-px bg-[#3c3d42]" />
    <CanvasSelectionActionButton label="打组" Icon={Workflow} className="flex h-9 min-w-[86px] flex-none items-center justify-center gap-2 px-4 whitespace-nowrap hover:text-white" onAction={onGroup} suffix={<ChevronDown className="h-3 w-3 text-[#a7a7ab]" />} />
    <div className="ml-3 h-1.5 w-1.5 rounded-full bg-[#4ec6ff]" />
  </CanvasSelectionToolbarFrame>;
}
import type { CSSProperties } from "react";
