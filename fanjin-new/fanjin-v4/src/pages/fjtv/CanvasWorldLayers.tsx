import type { ReactNode } from "react";
import { createCanvasGroupBackgroundLayer, type CanvasGroupBackgroundLayerDependencies } from "./CanvasGroupBackgroundLayer";
import { createCanvasEdgeLayer, type CanvasEdgeLayerDependencies } from "./CanvasEdgeLayer";
import { createCanvasGroupLayer, type CanvasGroupLayerDependencies } from "./CanvasGroupLayer";
import { createCanvasNodeLayer, type CanvasNodeLayerDependencies } from "./CanvasNodeLayer";
import { CanvasWorldOverlayLayer } from "./CanvasWorldOverlayLayer";
import { createCanvasGroupToolbar, type CanvasGroupToolbarDependencies } from "./CanvasGroupToolbar";
import { CanvasWorldStoryboardOverlay } from "./CanvasWorldStoryboardOverlay";
import { CanvasWorldSelectionOverlay } from "./CanvasWorldSelectionOverlay";

export function CanvasWorldLayers({ transform, background, edge, group, node, groupToolbar, storyboardPosition, onStoryboardUpload, onStoryboardHistory, selectionOverlay, overlays, children, selectionBox, edgeHoverState, onDisconnect }: { transform: string; background?: CanvasGroupBackgroundLayerDependencies; edge?: CanvasEdgeLayerDependencies; group?: CanvasGroupLayerDependencies; node?: CanvasNodeLayerDependencies; groupToolbar?: CanvasGroupToolbarDependencies; storyboardPosition?: { x: number; y: number } | null; onStoryboardUpload?: () => void; onStoryboardHistory?: () => void; selectionOverlay?: ReactNode; overlays?: ReactNode; children?: ReactNode; selectionBox?: { active: boolean; startX: number; startY: number; endX: number; endY: number }; edgeHoverState?: { armed?: boolean; nearestPoint: { x: number; y: number }; edgeId: string } | null; onDisconnect?: () => void }) {
  return <div data-canvas-world className="absolute left-0 top-0 h-full w-full" style={{ transform, transformOrigin: "0 0" }}>
    {background ? createCanvasGroupBackgroundLayer(background)() : null}
    {edge ? createCanvasEdgeLayer(edge)() : null}
    {group ? createCanvasGroupLayer(group)() : null}
    {node ? createCanvasNodeLayer(node)() : null}
    {groupToolbar ? createCanvasGroupToolbar(groupToolbar)() : null}
    {storyboardPosition && onStoryboardUpload && onStoryboardHistory ? <CanvasWorldStoryboardOverlay position={storyboardPosition} onUpload={onStoryboardUpload} onHistory={onStoryboardHistory} /> : null}
    {selectionOverlay}
    {children}
    {selectionBox && edgeHoverState !== undefined && onDisconnect ? <CanvasWorldOverlayLayer selectionBox={selectionBox} edgeHoverState={edgeHoverState} onDisconnect={onDisconnect} /> : null}
    {overlays}
  </div>;
}
