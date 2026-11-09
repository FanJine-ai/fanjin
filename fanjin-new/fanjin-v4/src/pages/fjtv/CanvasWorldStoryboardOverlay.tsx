import { CanvasStoryboardSlotMenu } from "./CanvasStoryboardSlotMenu";

export function CanvasWorldStoryboardOverlay({ position, onUpload, onHistory }: { position: { x: number; y: number } | null; onUpload: () => void; onHistory: () => void }) {
  return position ? <CanvasStoryboardSlotMenu position={position} onUpload={onUpload} onHistory={onHistory} /> : null;
}
