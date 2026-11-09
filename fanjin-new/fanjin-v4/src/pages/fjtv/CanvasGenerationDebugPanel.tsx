import { X } from "lucide-react";

export function CanvasGenerationDebugPanel({ debug, onClose }: { debug: Record<string, unknown>; onClose: () => void }) {
  return <div data-fixed-ui className="absolute bottom-16 right-4 z-[96] w-[420px] overflow-hidden rounded-[12px] border border-[#3d4046] bg-[#16181d]/95 shadow-[0_18px_40px_rgba(0,0,0,0.4)]">
    <div className="flex items-center justify-between border-b border-[#2a2d33] px-3 py-2 text-xs text-[#cfd6df]"><span>生成请求调试</span><button type="button" aria-label="关闭生成调试" className="rounded px-2 py-1 text-[#9ea6b2] hover:bg-[#23262c] hover:text-white" onClick={onClose}><X className="h-4 w-4" /></button></div>
    <div className="max-h-[280px] overflow-auto px-3 py-2 text-[11px] leading-5 text-[#d7dde7]"><div className="mb-2 text-[#8fd3ff]">phase: {String(debug.phase || "")}</div><pre className="whitespace-pre-wrap break-all">{JSON.stringify(debug, null, 2)}</pre></div>
  </div>;
}
