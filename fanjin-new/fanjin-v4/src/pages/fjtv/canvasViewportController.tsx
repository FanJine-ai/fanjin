import type { Dispatch, SetStateAction, RefObject, ReactNode, JSX } from "react";
import type { ViewportState, NodeData } from "./canvasDataTypes";
import { getCanvasFitViewport, getCanvasUsableLayout } from "./canvasAdaptiveLayout";
import { computeMiniMapMetrics, computeMiniMapViewportPan, miniMapClientToWorld, type MiniMapMetrics } from "./miniMapMetrics";
import { rectFromNode, rectIntersects, type CanvasRect as Rect } from "./canvasGeometry";

export interface CanvasViewportControllerDependencies {
  viewport: ViewportState;
  CANVAS_VISUAL_SCALE: 1.25;
  setCanvasPerformanceMode: Dispatch<SetStateAction<boolean>>;
  canvasInteractionTimerRef: RefObject<number | null>;
  rootRef: RefObject<HTMLDivElement | null>;
  nodeMap: Map<string, NodeData>;
  assetManagerOpen: boolean;
  setViewport: Dispatch<SetStateAction<ViewportState>>;
  setSelectedNodeIds: Dispatch<SetStateAction<string[]>>;
  setSelectedEdgeIds: Dispatch<SetStateAction<string[]>>;
  setActiveNodeId: Dispatch<SetStateAction<string | null>>;
  viewportRef: RefObject<ViewportState>;
  nodes: NodeData[];
  canvasBounds: Rect | null;
  getGroupBoundsMap: () => Map<string, Rect>;
  miniMapSurfaceRef: RefObject<HTMLDivElement | null>;
}

export function createCanvasViewportController(deps: CanvasViewportControllerDependencies) {
  const { viewport, CANVAS_VISUAL_SCALE, setCanvasPerformanceMode, canvasInteractionTimerRef, rootRef, nodeMap, assetManagerOpen, setViewport, setSelectedNodeIds, setSelectedEdgeIds, setActiveNodeId, viewportRef, nodes, canvasBounds, getGroupBoundsMap, miniMapSurfaceRef } = deps;
function viewportVisualScale(nextViewport = viewport) {
    return nextViewport.scale * CANVAS_VISUAL_SCALE;
  }

function markCanvasInteraction() {
    setCanvasPerformanceMode(true);
    if (canvasInteractionTimerRef.current !== null) {
      window.clearTimeout(canvasInteractionTimerRef.current);
    }
    canvasInteractionTimerRef.current = window.setTimeout(() => {
      canvasInteractionTimerRef.current = null;
      setCanvasPerformanceMode(false);
    }, 180);
  }

function getCanvasToolbarScale(multiplier = 1) {
    return multiplier / Math.max(0.2, viewportVisualScale());
  }

function getCanvasToolbarTop(targetTop: number, visualOffset = 72) {
    return targetTop - visualOffset / Math.max(0.2, viewportVisualScale());
  }

function toWorld(clientX: number, clientY: number) {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    const scale = viewportVisualScale();
    return {
      x: (clientX - rect.left - viewport.panX) / scale,
      y: (clientY - rect.top - viewport.panY) / scale,
    };
  }

function toScreen(worldX: number, worldY: number) {
    const scale = viewportVisualScale();
    return { x: viewport.panX + worldX * scale, y: viewport.panY + worldY * scale };
  }

function focusNodeInViewport(nodeId: string) {
    const node = nodeMap.get(nodeId);
    const rect = rootRef.current?.getBoundingClientRect();
    if (!node || !rect) return;
    const usableLayout = getCanvasUsableLayout(rect.width, assetManagerOpen);
    const targetScale = Math.max(0.72, Math.min(1, viewport.scale));
    const visualScale = targetScale * CANVAS_VISUAL_SCALE;
    const nextPanX = usableLayout.centerX - (node.x + node.width / 2) * visualScale;
    const nextPanY = rect.height / 2 - (node.y + node.height / 2) * visualScale;
    setViewport({ scale: targetScale, panX: nextPanX, panY: nextPanY });
    setSelectedNodeIds([nodeId]);
    setSelectedEdgeIds([]);
    setActiveNodeId(nodeId);
  }

function focusNodeInViewportAtScale(nodeId: string, scale: number) {
    const node = nodeMap.get(nodeId);
    const rect = rootRef.current?.getBoundingClientRect();
    if (!node || !rect) return;
    const usableLayout = getCanvasUsableLayout(rect.width, assetManagerOpen);
    const targetScale = Math.min(2.2, Math.max(0.02, scale));
    const visualScale = targetScale * CANVAS_VISUAL_SCALE;
    const nextPanX = usableLayout.centerX - (node.x + node.width / 2) * visualScale;
    const nextPanY = rect.height / 2 - (node.y + node.height / 2) * visualScale;
    setViewport({ scale: targetScale, panX: nextPanX, panY: nextPanY });
    setSelectedNodeIds([nodeId]);
    setSelectedEdgeIds([]);
    setActiveNodeId(nodeId);
  }

function fitViewportToBounds(bounds: Rect | null, scaleCap = 1) {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect || !bounds) return;
    const nextViewport = getCanvasFitViewport(rect.width, rect.height, bounds, assetManagerOpen, {
      visualScaleMultiplier: CANVAS_VISUAL_SCALE,
      scaleCap,
      minimumVisualScale: 0.02,
    });
    viewportRef.current = nextViewport;
    setViewport(nextViewport);
  }

function zoomCanvasBy(factor: number) {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    const centerX = getCanvasUsableLayout(rect.width, assetManagerOpen).centerX;
    const centerY = rect.height / 2;
    const currentVisualScale = viewportVisualScale();
    const wx = (centerX - viewport.panX) / currentVisualScale;
    const wy = (centerY - viewport.panY) / currentVisualScale;
    const nextScale = Math.min(2.2, Math.max(0.02, viewport.scale * factor));
    const nextVisualScale = nextScale * CANVAS_VISUAL_SCALE;
    setViewport({
      scale: nextScale,
      panX: centerX - wx * nextVisualScale,
      panY: centerY - wy * nextVisualScale,
    });
  }

function getViewportWorldRect(nextViewport = viewport): Rect | null {
    const rootRect = rootRef.current?.getBoundingClientRect();
    if (!rootRect) return null;
    const usableLayout = getCanvasUsableLayout(rootRect.width, assetManagerOpen);
    const scale = Math.max(0.001, viewportVisualScale(nextViewport));
    return {
      left: (usableLayout.left - nextViewport.panX) / scale,
      top: -nextViewport.panY / scale,
      right: (usableLayout.left + usableLayout.width - nextViewport.panX) / scale,
      bottom: (rootRect.height - nextViewport.panY) / scale,
    };
  }

function doesViewportContainNode(nextViewport = viewport) {
    if (nodes.length === 0) return true;
    const viewportRect = getViewportWorldRect(nextViewport);
    if (!viewportRect) return true;
    return nodes.some((node) => rectIntersects(rectFromNode(node), viewportRect));
  }

function returnToCanvasContent() {
    if (!canvasBounds || nodes.length === 0) {
      setViewport({ scale: 1, panX: 0, panY: 0 });
      return;
    }
    fitViewportToBounds(canvasBounds, 1);
  }

function buildMiniMapMetrics(width: number, height: number): MiniMapMetrics | null {
    const viewportRect = getViewportWorldRect();
    return computeMiniMapMetrics({
      rects: [...nodes.map(rectFromNode), ...Array.from(getGroupBoundsMap().values())],
      viewportRect,
      width,
      height,
    });
  }

function readMiniMapSurfaceBox() {
    const surface = miniMapSurfaceRef.current;
    if (!surface) return null;
    const rect = surface.getBoundingClientRect();
    // Pointer math must run in the same frame as the projection: absolutely
    // positioned children live inside the content box, while
    // getBoundingClientRect also contains the 1px border.
    return {
      left: rect.left + surface.clientLeft,
      top: rect.top + surface.clientTop,
      width: surface.clientWidth,
      height: surface.clientHeight,
    };
  }

function updateViewportFromMiniMap(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }) {
    if (!rootRef.current) return;
    const metrics = buildMiniMapMetrics(rect.width, rect.height);
    if (!metrics) return;
    const world = miniMapClientToWorld({ clientX, clientY, surfaceRect: rect, metrics });
    const rootRect = rootRef.current.getBoundingClientRect();
    const usableLayout = getCanvasUsableLayout(rootRect.width, assetManagerOpen);
    setViewport((prev) => {
      const pan = computeMiniMapViewportPan({
        worldX: world.x,
        worldY: world.y,
        visualScale: prev.scale * CANVAS_VISUAL_SCALE,
        centerX: usableLayout.centerX,
        centerY: rootRect.height / 2,
      });
      return { ...prev, ...pan };
    });
  }

function toggleZoomMode() {
    if (nodes.length === 0 || !canvasBounds) {
      setViewport((prev) => ({ ...prev, scale: prev.scale >= 0.98 ? 0.1 : 1 }));
      return;
    }
    if (viewport.scale > 0.18) {
      fitViewportToBounds(canvasBounds, 0.1);
      return;
    }
    fitViewportToBounds(canvasBounds, 1);
  }
  return { viewportVisualScale, markCanvasInteraction, getCanvasToolbarScale, getCanvasToolbarTop, toWorld, toScreen, focusNodeInViewport, focusNodeInViewportAtScale, fitViewportToBounds, zoomCanvasBy, getViewportWorldRect, doesViewportContainNode, returnToCanvasContent, buildMiniMapMetrics, readMiniMapSurfaceBox, updateViewportFromMiniMap, toggleZoomMode };
}
