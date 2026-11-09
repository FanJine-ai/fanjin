import { History } from "lucide-react";

export function CanvasHistoryToolbarButton({ open, pendingCount, onToggle }: { open: boolean; pendingCount: number; onToggle: () => void }) {
  return <button type="button" aria-label={open ? "收起生成历史" : "打开生成历史"} aria-expanded={open} aria-controls="canvas-history-panel" title="生成历史" onClick={(event) => { event.stopPropagation(); onToggle(); }} className={`canvas-main-toolbar-btn relative flex items-center justify-center transition ${open ? "bg-[#34353a] text-white" : ""}`}><History className="h-3.5 w-3.5" />{pendingCount > 0 ? <span className="absolute -right-0.5 -top-0.5 min-w-[14px] rounded-full bg-[#53cbff] px-1 text-[9px] font-semibold leading-[14px] text-[#0b1b24]" title={`${pendingCount} 项任务待更新`}>{pendingCount > 9 ? "9+" : pendingCount}</span> : null}</button>;
}
