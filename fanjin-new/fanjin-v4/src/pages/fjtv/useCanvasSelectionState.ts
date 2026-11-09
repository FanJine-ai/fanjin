import type { SelectionBox, NodeDragState, GroupDragState, TextResizeState, CanvasConflictState } from "./canvasDataTypes";
import { useState } from "react";

export function useCanvasSelectionState() {
  const [canvasSaveState, setCanvasSaveState] = useState<"dirty" | "saving" | "saved" | "error">("saved");
  const [canvasSavedAt, setCanvasSavedAt] = useState<Date | null>(null);
  const [canvasConflict, setCanvasConflict] = useState<CanvasConflictState | null>(null);
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<string[]>([]);
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);

  const [selectionBox, setSelectionBox] = useState<SelectionBox>({ active: false, startX: 0, startY: 0, endX: 0, endY: 0 });
  const [dragNode, setDragNode] = useState<NodeDragState>({ active: false, nodeId: null, offsetX: 0, offsetY: 0 });
  const [groupDrag, setGroupDrag] = useState<GroupDragState>({ active: false, groupId: null, startX: 0, startY: 0, originalPositions: {}, startBounds: null });
  const [textResize, setTextResize] = useState<TextResizeState>({ active: false, nodeId: null, startX: 0, startY: 0, startWidth: 0, startHeight: 0 });
  const [middlePanning, setMiddlePanning] = useState({ active: false, sx: 0, sy: 0, px: 0, py: 0 });
  return {
    canvasSaveState, setCanvasSaveState,
    canvasSavedAt, setCanvasSavedAt,
    canvasConflict, setCanvasConflict,
    selectedNodeIds, setSelectedNodeIds,
    selectedEdgeIds, setSelectedEdgeIds,
    activeNodeId, setActiveNodeId,
    selectionBox, setSelectionBox,
    dragNode, setDragNode,
    groupDrag, setGroupDrag,
    textResize, setTextResize,
    middlePanning, setMiddlePanning,
  };
}
