import { Share2 } from "lucide-react";

export function CanvasWorkflowToolbarButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return <button type="button" aria-label={open ? "收起工作流模板" : "打开工作流模板"} aria-expanded={open} aria-controls="canvas-workflow-panel" onClick={(event) => { event.stopPropagation(); onToggle(); }} className={`canvas-main-toolbar-btn flex items-center justify-center transition ${open ? "bg-[#34353a] text-white" : ""}`}><Share2 className="h-3.5 w-3.5" /></button>;
}
