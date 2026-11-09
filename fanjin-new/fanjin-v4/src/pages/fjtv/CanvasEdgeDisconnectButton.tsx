import { Scissors } from "lucide-react";

export function CanvasEdgeDisconnectButton({ point, onDisconnect }: { point: { x: number; y: number }; onDisconnect: () => void }) {
  return <button type="button" aria-label="断开连接" className="absolute z-40 flex h-8 w-8 items-center justify-center rounded-full border border-[#4a4f58] bg-[#2e3238]" style={{ left: point.x - 16, top: point.y - 16 }} onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); }} onClick={(event) => { event.stopPropagation(); onDisconnect(); }}><Scissors className="h-4 w-4" aria-hidden="true" /></button>;
}
