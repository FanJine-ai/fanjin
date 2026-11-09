import { CanvasMultiSelectionToolbar } from "./CanvasMultiSelectionToolbar";
import type { ComponentProps, CSSProperties } from "react";

export function CanvasWorldSelectionOverlay({
  bounds,
  centerX,
  top,
  scale,
  frameStyle,
  layoutOpen,
  onToggleLayout,
  onApplyLayout,
  onSave,
  onDuplicate,
  onDownload,
  onGroup,
}: {
  bounds: { left: number; top: number; right: number; bottom: number } | null;
  centerX: number | null;
  top: number;
  scale: number;
  frameStyle: CSSProperties;
  layoutOpen: boolean;
  onToggleLayout: () => void;
  onApplyLayout: (mode: Parameters<ComponentProps<typeof CanvasMultiSelectionToolbar>["onApplyLayout"]>[0]) => void;
  onSave: () => void;
  onDuplicate: () => void;
  onDownload: () => void;
  onGroup: () => void;
}) {
  if (!bounds || centerX === null) return null;
  return (
    <CanvasMultiSelectionToolbar
      bounds={bounds}
      centerX={centerX}
      top={top}
      scale={scale}
      frameStyle={frameStyle}
      layoutOpen={layoutOpen}
      onToggleLayout={onToggleLayout}
      onApplyLayout={onApplyLayout}
      onSave={onSave}
      onDuplicate={onDuplicate}
      onDownload={onDownload}
      onGroup={onGroup}
    />
  );
}
