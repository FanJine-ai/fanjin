import type { ComponentType, ReactNode } from "react";

export function CanvasSelectionActionButton({ label, Icon, className, onAction, suffix }: { label: string; Icon: ComponentType<{ className?: string }>; className: string; onAction: () => void; suffix?: ReactNode }) {
  return <button className={className} onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); onAction(); }}><Icon className="h-4 w-4" /><span>{label}</span>{suffix}</button>;
}
