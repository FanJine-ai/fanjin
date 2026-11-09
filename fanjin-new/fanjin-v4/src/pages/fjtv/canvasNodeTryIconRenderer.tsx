import { CanvasNodeTryIcon } from "./CanvasNodeTryIcon";

export type CanvasTryIconKind = "text" | "video" | "image" | "audio" | "boxes" | "spark";

export function renderCanvasNodeTryIcon(kind: CanvasTryIconKind) {
  return <CanvasNodeTryIcon kind={kind} />;
}
