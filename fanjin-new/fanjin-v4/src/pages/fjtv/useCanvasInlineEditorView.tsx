import { useCallback,useMemo,type CSSProperties } from "react";
import {
getCanvasInlineNodeEditorLayout,
getCanvasUsableLayout
} from "./canvasAdaptiveLayout";
import {
nodeHasMedia
} from "./canvasAssetPresentation";
import {
getCanvasNodeEditorPresentation
} from "./CanvasCompactNodeEditorLauncher";
import type {
NodeData,
ViewportState
} from "./canvasDataTypes";
import { PROMPT_PANEL_FONT_STACK } from "./canvasPageConstants";
interface Context {
  activeNode: NodeData | null;
  toScreen: (worldX: number, worldY: number) => { x: number; y: number; };
  viewport: ViewportState;
  canvasSurfaceWidth: number;
  rootRef: React.RefObject<HTMLDivElement | null>;
  canvasSurfaceHeight: number;
  assetManagerOpen: boolean;
  nodeEditorPinned: boolean;
  expanded: boolean;
  mediaViewerNodeId: string | null;
  nodeMap: Map<string, NodeData>;
}
export function useCanvasInlineEditorView({ activeNode, toScreen, viewport, canvasSurfaceWidth, rootRef, canvasSurfaceHeight, assetManagerOpen, nodeEditorPinned, expanded, mediaViewerNodeId, nodeMap }: Context) {
  const controlsPos = useMemo(() => {
    if (!activeNode) return null;
    const top = toScreen(activeNode.x + activeNode.width / 2, activeNode.y);
    const bottom = toScreen(activeNode.x + activeNode.width / 2, activeNode.y + activeNode.height);
    return { uploadX: top.x, uploadY: top.y - 24, promptX: bottom.x, promptY: bottom.y + 48 };
  }, [activeNode, viewport.panX, viewport.panY, viewport.scale]);
  const getInlineNodeEditorStyle = useCallback((preferredWidth: number): CSSProperties => {
    const surfaceWidth = Math.max(
      1,
      canvasSurfaceWidth || rootRef.current?.getBoundingClientRect().width || 1,
    );
    const surfaceHeight = Math.max(
      1,
      canvasSurfaceHeight || rootRef.current?.getBoundingClientRect().height || 1,
    );
    const layout = getCanvasInlineNodeEditorLayout(
      surfaceWidth,
      surfaceHeight,
      assetManagerOpen,
      nodeEditorPinned ? Number.NaN : controlsPos?.promptX ?? Number.NaN,
      nodeEditorPinned ? surfaceHeight : controlsPos?.promptY ?? Number.NaN,
      preferredWidth,
    );

    return {
      width: layout.width,
      left: layout.left,
      ...(layout.bottom !== null
        ? { bottom: layout.bottom, top: "auto" }
        : { top: layout.top ?? 16, bottom: "auto" }),
      transform: "translateX(-50%)",
      fontFamily: PROMPT_PANEL_FONT_STACK,
    };
  }, [assetManagerOpen, canvasSurfaceHeight, canvasSurfaceWidth, controlsPos, nodeEditorPinned]);
  const nodeEditorAvailableWidth = getCanvasUsableLayout(
    canvasSurfaceWidth,
    assetManagerOpen,
  ).width;
  const nodeEditorPresentation = getCanvasNodeEditorPresentation(
    viewport.scale,
    expanded,
    nodeEditorAvailableWidth,
  );
  const activeNodeHasMedia = activeNode ? nodeHasMedia(activeNode) : false;
  const mediaViewerNode = useMemo(
    () => (mediaViewerNodeId ? nodeMap.get(mediaViewerNodeId) ?? null : null),
    [mediaViewerNodeId, nodeMap],
  );

  return {
    controlsPos, getInlineNodeEditorStyle, nodeEditorPresentation,
    activeNodeHasMedia, mediaViewerNode,
  };
}
