import { getSelectionMarqueeStyle } from "./canvasSelectionGeometry";

export function CanvasSelectionMarquee({ startX, startY, endX, endY }: { startX: number; startY: number; endX: number; endY: number }) {
  return <div className="pointer-events-none absolute" style={{ ...getSelectionMarqueeStyle(startX, startY, endX, endY), border: "1.5px solid #53cbff", background: "rgba(83, 203, 255, 0.14)", boxShadow: "0 0 0 1px rgba(83, 203, 255, 0.28), 0 0 18px rgba(83, 203, 255, 0.18)", borderRadius: 2 }} />;
}
