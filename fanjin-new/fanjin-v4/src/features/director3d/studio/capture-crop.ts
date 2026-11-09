export interface CaptureCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function getCaptureAspectRatio(ratio: string): number {
  const [ratioWidth, ratioHeight] = ratio.split(":").map(Number);
  const aspectRatio = ratioWidth / ratioHeight;

  return Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : 16 / 9;
}

export function getCaptureCrop(
  width: number,
  height: number,
  ratio: string,
): CaptureCrop {
  const targetAspectRatio = getCaptureAspectRatio(ratio);
  const sourceAspectRatio = width / height;

  if (sourceAspectRatio > targetAspectRatio) {
    const cropWidth = Math.round(height * targetAspectRatio);
    return {
      x: Math.round((width - cropWidth) / 2),
      y: 0,
      width: cropWidth,
      height,
    };
  }

  const cropHeight = Math.round(width / targetAspectRatio);
  return {
    x: 0,
    y: Math.round((height - cropHeight) / 2),
    width,
    height: cropHeight,
  };
}
