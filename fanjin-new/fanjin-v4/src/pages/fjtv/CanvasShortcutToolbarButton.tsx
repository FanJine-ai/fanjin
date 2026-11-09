import { Keyboard } from "lucide-react";

export function CanvasShortcutToolbarButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return <button type="button" aria-label={open ? "收起快捷键说明" : "打开快捷键说明"} aria-expanded={open} aria-controls="canvas-shortcut-panel" onClick={(event) => { event.stopPropagation(); onToggle(); }} className={`canvas-main-toolbar-btn flex items-center justify-center transition ${open ? "bg-[#34353a] text-white" : ""}`}><Keyboard className="h-3.5 w-3.5" /></button>;
}
