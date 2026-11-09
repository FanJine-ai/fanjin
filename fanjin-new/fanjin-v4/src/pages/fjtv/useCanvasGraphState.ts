import type { ViewportState, NodeData, EdgeData } from "./canvasDataTypes";
import { useRef, useState } from "react";

export function useCanvasGraphState() {
  const [viewport, setViewport] = useState<ViewportState>({ scale: 1, panX: 0, panY: 0 });
  const viewportRef = useRef<ViewportState>({ scale: 1, panX: 0, panY: 0 });
  const wheelPanDeltaRef = useRef({ x: 0, y: 0 });
  const wheelPanFrameRef = useRef<number | null>(null);
  const canvasInteractionTimerRef = useRef<number | null>(null);
  const [canvasRenderTick, setCanvasRenderTick] = useState(0);
  const [canvasPerformanceMode, setCanvasPerformanceMode] = useState(false);
  const [nodes, setNodes] = useState<NodeData[]>([]);
  const nodesRef = useRef<NodeData[]>([]);
  const [edges, setEdges] = useState<EdgeData[]>([]);
  return {
    viewport, setViewport,
    viewportRef, wheelPanDeltaRef,
    wheelPanFrameRef, canvasInteractionTimerRef,
    canvasRenderTick, setCanvasRenderTick,
    canvasPerformanceMode, setCanvasPerformanceMode,
    nodes, setNodes,
    nodesRef, edges,
    setEdges,
  };
}
