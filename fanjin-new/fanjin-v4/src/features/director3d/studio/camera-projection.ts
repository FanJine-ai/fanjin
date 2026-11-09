/**
 * Director-studio FOV values use the horizontal angle of view shown by LibTV.
 * Three.js PerspectiveCamera expects a vertical FOV, so every real render must
 * convert through the selected output aspect ratio first.
 */
export function getVerticalFovFromHorizontal(
  horizontalFov: number,
  aspectRatio: number,
): number {
  const safeAspectRatio =
    Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : 16 / 9;
  const horizontalRadians = (horizontalFov * Math.PI) / 180;

  return (
    (2 * Math.atan(Math.tan(horizontalRadians / 2) / safeAspectRatio) * 180) /
    Math.PI
  );
}

export function getCameraFrustumHalfSize(
  horizontalFov: number,
  aspectRatio: number,
  depth: number,
): { halfWidth: number; halfHeight: number } {
  const safeAspectRatio =
    Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : 16 / 9;
  const safeDepth = Math.max(0, depth);
  const halfWidth =
    Math.tan((horizontalFov * Math.PI) / 360) * safeDepth;

  return {
    halfWidth,
    halfHeight: halfWidth / safeAspectRatio,
  };
}
