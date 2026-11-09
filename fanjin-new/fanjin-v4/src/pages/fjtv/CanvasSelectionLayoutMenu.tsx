import { Columns3, LayoutGrid, Rows3 } from "lucide-react";

export function CanvasSelectionLayoutMenu({ open, onToggle, onApply }: { open: boolean; onToggle: () => void; onApply: (mode: "grid" | "horizontal" | "vertical") => void }) {
  return <div className="relative">
    <button className={`flex h-9 min-w-[104px] flex-none items-center justify-center gap-2 rounded-[10px] px-4 whitespace-nowrap transition ${open ? "bg-[#3a3a3d]" : "hover:bg-[#333336]"}`} onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); onToggle(); }}>
      <LayoutGrid className="h-4 w-4" /><span>宫格排列</span>
    </button>
    {open ? <div data-canvas-popover className="absolute bottom-[48px] left-0 z-20 w-[140px] rounded-[14px] border border-[#4a4b50] bg-[#28282a] p-2 shadow-[0_20px_42px_rgba(0,0,0,0.38)]">
      <button className="flex h-10 w-full items-center gap-2 rounded-[10px] px-3 text-left whitespace-nowrap hover:bg-[#343437]" onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); onApply("grid"); }}><LayoutGrid className="h-4 w-4" /><span>宫格排列</span></button>
      <button className="mt-1 flex h-10 w-full items-center gap-2 rounded-[10px] px-3 text-left whitespace-nowrap hover:bg-[#343437]" onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); onApply("horizontal"); }}><Rows3 className="h-4 w-4" /><span>水平排列</span></button>
      <button className="mt-1 flex h-10 w-full items-center gap-2 rounded-[10px] px-3 text-left whitespace-nowrap hover:bg-[#343437]" onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); onApply("vertical"); }}><Columns3 className="h-4 w-4" /><span>垂直排列</span></button>
    </div> : null}
  </div>;
}
