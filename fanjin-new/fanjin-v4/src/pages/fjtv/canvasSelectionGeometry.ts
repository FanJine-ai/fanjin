export function getSelectionMarqueeStyle(startX: number, startY: number, endX: number, endY: number) {
  return { left: Math.min(startX, endX), top: Math.min(startY, endY), width: Math.abs(endX - startX), height: Math.abs(endY - startY) };
}
