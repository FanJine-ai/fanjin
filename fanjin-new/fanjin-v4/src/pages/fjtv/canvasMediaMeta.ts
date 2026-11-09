export type CanvasMediaMeta = { width: number; height: number; durationMs?: number };

/** Metadata is optional display information, never a delivery gate. Browsers can
 * leave detached media pending forever (connection limits, codec, slow CDN). */
export function readCanvasRemoteMediaMeta(url: string, type: "image" | "video", timeoutMs = 3000): Promise<CanvasMediaMeta> {
  return new Promise(resolve => {
    if (!url) return resolve({ width: 0, height: 0 });
    let finished = false;
    let cleanup = () => {};
    const finish = (meta: CanvasMediaMeta) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      cleanup();
      resolve(meta);
    };
    const empty = () => finish({ width: 0, height: 0 });
    const timer = setTimeout(empty, timeoutMs);
    try {
      if (type === "video") {
        const video = document.createElement("video");
        video.preload = "metadata";
        cleanup = () => {
          video.onloadedmetadata = null;
          video.onerror = null;
          video.removeAttribute("src");
          try { video.load(); } catch { /* Detached media cleanup is best-effort. */ }
        };
        video.onloadedmetadata = () => finish({ width: video.videoWidth || 0, height: video.videoHeight || 0,
          durationMs: Number.isFinite(video.duration) && video.duration > 0 ? Math.round(video.duration * 1000) : undefined });
        video.onerror = empty;
        video.src = url;
      } else {
        const img = new Image();
        cleanup = () => { img.onload = null; img.onerror = null; img.src = ""; };
        img.onload = () => finish({ width: img.naturalWidth || 0, height: img.naturalHeight || 0 });
        img.onerror = empty;
        img.src = url;
      }
    } catch { empty(); }
  });
}

export function canvasTaskVideoMeta(task: any): CanvasMediaMeta | null {
  const output = Array.isArray(task?.output) ? task.output.find((item: any) => item?.type === "video") : null;
  const width = Number(output?.width), height = Number(output?.height), durationMs = Number(output?.duration_ms);
  return width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height)
    ? { width, height, durationMs: durationMs > 0 && Number.isFinite(durationMs) ? durationMs : undefined } : null;
}
