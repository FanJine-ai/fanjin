import { PanelLeftClose, PanelLeftOpen } from "lucide-react";

export function CanvasAssetManagerToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return <button type="button" aria-label={open ? "收起画布内容与资产栏" : "展开画布内容与资产栏"} aria-expanded={open} aria-controls="project-studio-asset-manager" onClick={(event) => { event.stopPropagation(); onToggle(); }} className="canvas-asset-button flex items-center transition hover:bg-[#2c2d31]">{open ? <PanelLeftClose className="h-3.5 w-3.5" /> : <PanelLeftOpen className="h-3.5 w-3.5" />}<span>资产管理</span></button>;
}
