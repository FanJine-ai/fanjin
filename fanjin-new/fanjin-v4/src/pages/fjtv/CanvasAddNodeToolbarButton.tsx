import { Plus } from "lucide-react";

export function CanvasAddNodeToolbarButton({ open, onOpen }: { open: boolean; onOpen: () => void }) {
  return <button type="button" aria-label="添加看板节点" aria-expanded={open} aria-controls="canvas-creation-menu" onClick={(event) => { event.stopPropagation(); onOpen(); }} className="canvas-main-toolbar-add mr-1 flex items-center justify-center transition"><Plus className="h-5 w-5" /></button>;
}
