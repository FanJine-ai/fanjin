import type { Side, DraftLine, EdgeHoverState, CreationMenuState, PendingConnection } from "./canvasDataTypes";
import { useRef, useState } from "react";
import { type CanvasAlignmentGuides as AlignmentGuides } from "./canvasGeometry";

export function useCanvasConnectionState() {
  const [draftLine, setDraftLine] = useState<DraftLine | null>(null);
  const [edgeDropTarget, setEdgeDropTarget] = useState<{ nodeId: string; side: Side } | null>(null);
  const [edgeHoverState, setEdgeHoverState] = useState<EdgeHoverState | null>(null);
  const [alignmentGuides, setAlignmentGuides] = useState<AlignmentGuides | null>(null);
  const nodeConnectionHoldTimerRef = useRef<number | null>(null);
  const nodeConnectionHoldRef = useRef<{
    nodeId: string;
    clientX: number;
    clientY: number;
    worldX: number;
    worldY: number;
  } | null>(null);

  const [pendingConnection, setPendingConnection] = useState<PendingConnection | null>(null);
  const [creationMenu, setCreationMenu] = useState<CreationMenuState>({ open: false, x: 0, y: 0, source: "sidebar" });
  const [sidebarMenuHover, setSidebarMenuHover] = useState(false);
  const [quickUploadPos, setQuickUploadPos] = useState<{ x: number; y: number } | null>(null);
  return {
    draftLine, setDraftLine,
    edgeDropTarget, setEdgeDropTarget,
    edgeHoverState, setEdgeHoverState,
    alignmentGuides, setAlignmentGuides,
    nodeConnectionHoldTimerRef, nodeConnectionHoldRef,
    pendingConnection, setPendingConnection,
    creationMenu, setCreationMenu,
    setSidebarMenuHover, quickUploadPos,
    setQuickUploadPos,
  };
}
