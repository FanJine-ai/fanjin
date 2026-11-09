import { CanvasSelectionMarquee } from "./CanvasSelectionMarquee";
import { CanvasEdgeDisconnectButton } from "./CanvasEdgeDisconnectButton";

export function CanvasWorldOverlayLayer({ selectionBox, edgeHoverState, onDisconnect }: { selectionBox: { active: boolean; startX: number; startY: number; endX: number; endY: number }; edgeHoverState: { armed?: boolean; nearestPoint: { x: number; y: number }; edgeId: string } | null; onDisconnect: () => void }) {
  return <>
    {selectionBox.active ? <CanvasSelectionMarquee startX={selectionBox.startX} startY={selectionBox.startY} endX={selectionBox.endX} endY={selectionBox.endY} /> : null}
    {edgeHoverState?.armed ? <CanvasEdgeDisconnectButton point={edgeHoverState.nearestPoint} onDisconnect={onDisconnect} /> : null}
  </>;
}
