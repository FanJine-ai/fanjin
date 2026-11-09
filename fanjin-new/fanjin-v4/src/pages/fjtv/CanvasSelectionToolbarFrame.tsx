import type { CSSProperties, ReactNode } from "react";

export function CanvasSelectionToolbarFrame({ bounds, centerX, top, scale, frameStyle, children }: { bounds: { left: number; top: number; right: number; bottom: number }; centerX: number; top: number; scale: number; frameStyle: CSSProperties; children: ReactNode }) {
  return <><div className="pointer-events-none absolute -z-10 bg-white/[0.018] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.012)]" style={{ left: bounds.left, top: bounds.top, width: bounds.right - bounds.left, height: bounds.bottom - bounds.top, borderRadius: 10, ...frameStyle }} /><div data-canvas-toolbar className="absolute rounded-[14px] border border-[#4a4b50] bg-[#28282a] px-4 py-2 text-[14px] text-[#f2f2f3] shadow-[0_20px_42px_rgba(0,0,0,0.38)]" style={{ left: centerX, top, transform: `translateX(-50%) scale(${scale})`, transformOrigin: "center top" }}><div className="flex min-w-max items-center whitespace-nowrap">{children}</div></div></>;
}
