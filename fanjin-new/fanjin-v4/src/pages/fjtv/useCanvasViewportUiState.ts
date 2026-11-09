import type { ArrangeSnapshot } from "./canvasDataTypes";
import { useState } from "react";

export function useCanvasViewportUiState() {
  const [arrangeSnapshot, setArrangeSnapshot] = useState<ArrangeSnapshot | null>(null);
  const [arrangeConfirmOpen, setArrangeConfirmOpen] = useState(false);
  const [miniMapOpen, setMiniMapOpen] = useState(false);
  const [miniMapDragging, setMiniMapDragging] = useState(false);
  // Real content-box size of the mounted minimap surface. The projection must
  // use the measured size (the asset-rail surface is w-full, so a hard-coded
  // width would desync the rendered dots from the click/drag math).
  const [miniMapSurfaceSize, setMiniMapSurfaceSize] = useState<{ width: number; height: number } | null>(null);
  const [gridSnapEnabled, setGridSnapEnabled] = useState(false);
  /** `select` = drag empty canvas to marquee-select; `hand` = drag to pan. */
  const [canvasPointerMode, setCanvasPointerMode] = useState<"select" | "hand">("hand");
  return {
    arrangeSnapshot, setArrangeSnapshot,
    arrangeConfirmOpen, setArrangeConfirmOpen,
    miniMapOpen, setMiniMapOpen,
    miniMapDragging, setMiniMapDragging,
    miniMapSurfaceSize, setMiniMapSurfaceSize,
    gridSnapEnabled, setGridSnapEnabled,
    canvasPointerMode, setCanvasPointerMode,
  };
}
