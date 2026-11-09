import type { FocusEvent, ReactNode } from "react";
import { Map as MapIcon } from "lucide-react";

export function CanvasMiniMapPopover({ open, dragging, onOpen, onClose, onFocus, onBlur, renderSurface }: { open: boolean; dragging: boolean; onOpen: () => void; onClose: () => void; onFocus: () => void; onBlur: (event: FocusEvent<HTMLDivElement>) => void; renderSurface: () => ReactNode }) {
  return <div className="relative" onMouseEnter={onOpen} onFocus={onFocus} onMouseLeave={() => { if (!dragging) onClose(); }} onBlur={onBlur}>
    <button type="button" aria-label="查看看板缩略图" aria-expanded={open} className={`canvas-zoom-tool-button flex items-center justify-center transition ${open ? "bg-[#333336]" : ""}`}><MapIcon className="h-3.5 w-3.5" /></button>
    {open ? <div data-canvas-popover className="absolute bottom-[46px] left-1/2 w-[238px] -translate-x-1/2 rounded-[22px] border border-[#47494f] bg-[#2c2c2d]/96 p-[15px] shadow-[0_24px_54px_rgba(0,0,0,0.48)]" onMouseDown={(event) => event.stopPropagation()}>{renderSurface()}</div> : null}
  </div>;
}
