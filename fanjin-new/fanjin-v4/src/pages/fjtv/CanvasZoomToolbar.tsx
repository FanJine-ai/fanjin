import { Hand, LayoutGrid, Magnet, MousePointer2 } from "lucide-react";
import type { ReactNode } from "react";

export function CanvasZoomToolbar({
  studioChrome,
  canvasPointerMode,
  gridSnapEnabled,
  zoomPercent,
  arrangeConfirmOpen,
  arrangeConfirm,
  onArrange,
  onTogglePointerMode,
  onToggleGridSnap,
  onToggleZoom,
  miniMap,
}: {
  studioChrome: boolean;
  canvasPointerMode: "select" | "hand";
  gridSnapEnabled: boolean;
  zoomPercent: number;
  arrangeConfirmOpen: boolean;
  arrangeConfirm: ReactNode;
  onArrange: () => void;
  onTogglePointerMode: () => void;
  onToggleGridSnap: () => void;
  onToggleZoom: () => void;
  miniMap?: ReactNode;
}) {
  return (
    <div className="canvas-zoom-toolbar relative flex items-center text-sm">
      <button type="button" aria-label="整理并聚焦看板内容" title="整理画布并合并重复素材节点" className="canvas-zoom-tool-button flex items-center justify-center transition" onClick={(event) => { event.stopPropagation(); onArrange(); }}>
        <LayoutGrid className="h-3.5 w-3.5" />
      </button>
      <button type="button" aria-label={canvasPointerMode === "select" ? "切换为抓手拖动画布" : "切换为光标框选节点"} aria-pressed={canvasPointerMode === "select"} title={canvasPointerMode === "select" ? "框选模式 · 点击切换为抓手" : "抓手模式 · 点击切换为框选"} className={`canvas-zoom-tool-button flex items-center justify-center transition ${canvasPointerMode === "select" ? "bg-[#3f3f42] text-white" : ""}`} onClick={(event) => { event.stopPropagation(); onTogglePointerMode(); }}>
        {canvasPointerMode === "select" ? <MousePointer2 className="h-3.5 w-3.5" /> : <Hand className="h-3.5 w-3.5" />}
      </button>
      {miniMap}
      <button type="button" className={`canvas-zoom-tool-button flex items-center justify-center transition ${gridSnapEnabled ? "bg-[#3f3f42] text-white" : ""}`} aria-label={gridSnapEnabled ? "关闭节点吸附" : "开启节点吸附"} aria-pressed={gridSnapEnabled} title={gridSnapEnabled ? "关闭节点吸附，恢复自由拖动" : "开启节点吸附"} onClick={(event) => { event.stopPropagation(); onToggleGridSnap(); }}>
        <Magnet className="h-3.5 w-3.5" />
      </button>
      {!studioChrome ? <button type="button" aria-label={`切换看板缩放，当前 ${zoomPercent}%`} className="canvas-zoom-label rounded-[10px] text-center leading-none" onClick={(event) => { event.stopPropagation(); onToggleZoom(); }}>{zoomPercent}%</button> : null}
      {arrangeConfirmOpen ? arrangeConfirm : null}
    </div>
  );
}
