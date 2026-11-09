export function getNodeVideoPosterUrl(node: any, getCanvasImagePreviewUrl: (url: string, size: number) => string) {
  return getCanvasImagePreviewUrl(node.videoPosterUrl || "", 1200);
}

export function primeVideoPreviewFrame(node: any, target: HTMLVideoElement, primed: Record<string, string | undefined>) {
  const src = node.localVideoUrl || node.videoUrl || "";
  if (!src || primed[node.id] === src) return;
  const duration = Number.isFinite(target.duration) && target.duration > 0 ? target.duration : 0;
  const trimStart = typeof node.videoTrimStart === "number" && node.videoTrimStart >= 0 ? node.videoTrimStart : 0;
  const previewTime = duration > 0 ? Math.min(Math.max(trimStart + 0.12, 0.12), Math.max(0, duration - 0.08)) : trimStart;
  primed[node.id] = src;
  if (Math.abs(target.currentTime - previewTime) < 0.03) return;
  try { target.currentTime = previewTime; } catch { delete primed[node.id]; }
}
