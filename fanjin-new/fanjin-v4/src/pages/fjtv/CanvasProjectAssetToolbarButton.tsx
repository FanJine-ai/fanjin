import { Workflow } from "lucide-react";

export function CanvasProjectAssetToolbarButton({ open, onOpen }: { open: boolean; onOpen: () => void }) {
  return <button type="button" aria-label="打开当前项目真实资产" aria-expanded={open} aria-controls="project-studio-content-panel" onClick={(event) => { event.stopPropagation(); onOpen(); }} className={`canvas-main-toolbar-btn relative flex items-center justify-center transition ${open ? "bg-[#34353a] text-white" : ""}`}><Workflow className="h-3.5 w-3.5" /><span className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-[#53cbff]" /></button>;
}
