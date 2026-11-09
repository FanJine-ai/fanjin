import type { VideoFrameExtractMode } from "./canvasDataTypes";

export async function readVideoPosterFile(localUrl: string, fileName: string, signal?: AbortSignal) {
  return await new Promise<File | null>((resolve, reject) => {
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    let settled = false;
    let captureTimer: number | null = null;
    const timeoutId = window.setTimeout(() => done(null), 3_600);
    const cleanup = () => {
      window.clearTimeout(timeoutId);
      if (captureTimer !== null) window.clearTimeout(captureTimer);
      signal?.removeEventListener("abort", onAbort);
      video.onloadedmetadata = null;
      video.onseeked = null;
      video.onloadeddata = null;
      video.onerror = null;
      video.removeAttribute("src");
      try { video.load(); } catch { /* no-op */ }
    };
    const done = (file: File | null, error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(file);
    };
    const onAbort = () => {
      const reason = signal?.reason;
      if (reason instanceof Error) done(null, reason);
      else {
        const error = new Error("视频封面预处理已取消");
        error.name = "AbortError";
        done(null, error);
      }
    };
    const capture = () => {
      try {
        const width = video.videoWidth || 1280;
        const height = video.videoHeight || 720;
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return done(null);
        ctx.drawImage(video, 0, 0, width, height);
        canvas.toBlob((blob) => {
          if (!blob) return done(null);
          const base = fileName.replace(/\.[^.]+$/, "") || "video";
          done(new File([blob], `${base}-poster.jpg`, { type: "image/jpeg" }));
        }, "image/jpeg", 0.82);
      } catch {
        done(null);
      }
    };
    video.onloadedmetadata = () => {
      const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
      const targetTime = duration > 0 ? Math.min(1, Math.max(0.12, duration * 0.2), Math.max(0, duration - 0.08)) : 0.12;
      try {
        video.currentTime = targetTime;
      } catch {
        capture();
      }
    };
    video.onseeked = capture;
    video.onloadeddata = () => {
      captureTimer = window.setTimeout(() => {
      if (!settled) capture();
      }, 120);
    };
    video.onerror = () => done(null);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    video.src = localUrl;
  });
}

export async function readVideoFrameFile(
  mediaUrl: string,
  fileName: string,
  mode: VideoFrameExtractMode,
  requestedTime = 0,
) {
  return await new Promise<File>((resolve, reject) => {
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    let settled = false;
    const finish = (error?: Error, file?: File) => {
      if (settled) return;
      settled = true;
      if (error || !file) reject(error || new Error("视频截帧失败"));
      else resolve(file);
    };
    const capture = () => {
      try {
        const width = video.videoWidth;
        const height = video.videoHeight;
        if (!width || !height) return finish(new Error("视频没有可读取的画面"));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) return finish(new Error("创建截帧画布失败"));
        context.drawImage(video, 0, 0, width, height);
        canvas.toBlob((blob) => {
          if (!blob) return finish(new Error("导出视频帧失败"));
          const base = fileName.replace(/\.[^.]+$/, "") || "video";
          finish(undefined, new File([blob], `${base}-${mode}-frame.png`, { type: "image/png" }));
        }, "image/png");
      } catch {
        finish(new Error("读取视频帧失败，请确认媒体允许跨域读取"));
      }
    };
    video.onloadedmetadata = () => {
      const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
      const targetTime = mode === "first"
        ? Math.min(0.05, Math.max(0, duration - 0.02))
        : mode === "last"
          ? Math.max(0, duration - 0.05)
          : Math.max(0, Math.min(requestedTime, Math.max(0, duration - 0.02)));
      try {
        video.currentTime = targetTime;
      } catch {
        capture();
      }
    };
    video.onseeked = capture;
    video.onloadeddata = () => window.setTimeout(() => {
      if (!settled && video.readyState >= 2) capture();
    }, 160);
    video.onerror = () => finish(new Error("视频加载失败，无法截帧"));
    window.setTimeout(() => finish(new Error("视频截帧超时")), 5_000);
    video.src = mediaUrl;
  });
}

export async function readMediaMeta(file: File, isVideo: boolean, signal?: AbortSignal) {
  return await new Promise<{ width: number; height: number; localUrl: string }>((resolve, reject) => {
    const localUrl = URL.createObjectURL(file);
    let settled = false;
    let video: HTMLVideoElement | null = null;
    let image: HTMLImageElement | null = null;
    const timeoutId = window.setTimeout(() => finish(new Error("读取媒体尺寸超时，请检查文件是否完整")), 15_000);
    const cleanup = () => {
      window.clearTimeout(timeoutId);
      signal?.removeEventListener("abort", onAbort);
      if (video) {
        video.onloadedmetadata = null;
        video.onerror = null;
        video.removeAttribute("src");
        try { video.load(); } catch { /* no-op */ }
      }
      if (image) {
        image.onload = null;
        image.onerror = null;
        image.src = "";
      }
    };
    const finish = (
      error?: Error,
      value?: { width: number; height: number; localUrl: string },
    ) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error || !value) {
        URL.revokeObjectURL(localUrl);
        reject(error || new Error("无法读取媒体尺寸"));
      } else {
        resolve(value);
      }
    };
    const onAbort = () => {
      const reason = signal?.reason;
      if (reason instanceof Error) finish(reason);
      else {
        const error = new Error("媒体预处理已取消");
        error.name = "AbortError";
        finish(error);
      }
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    if (isVideo) {
      video = document.createElement("video");
      video.preload = "metadata";
      video.onloadedmetadata = () => finish(undefined, { width: video?.videoWidth || 1, height: video?.videoHeight || 1, localUrl });
      video.onerror = () => finish(new Error("无法读取视频尺寸"));
      video.src = localUrl;
      return;
    }
    image = new window.Image();
    image.decoding = "async";
    image.onload = () => finish(undefined, { width: image?.naturalWidth || 1, height: image?.naturalHeight || 1, localUrl });
    image.onerror = () => finish(new Error("无法读取图片尺寸"));
    image.src = localUrl;
  });
}

export async function createLightweightImagePreviewUrl(file: File, width: number, height: number, signal?: AbortSignal) {
  if (!file.type.startsWith("image/") || /^image\/(gif|svg\+xml)$/i.test(file.type)) return "";
  const maxSide = 960;
  const largestSide = Math.max(width || 1, height || 1);
  if (largestSide <= maxSide && file.size <= 900 * 1024) return "";
  const sourceUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new window.Image();
      let settled = false;
      const timeoutId = window.setTimeout(() => finish(new Error("生成图片预览超时")), 10_000);
      const cleanup = () => {
        window.clearTimeout(timeoutId);
        signal?.removeEventListener("abort", onAbort);
        img.onload = null;
        img.onerror = null;
        if (!settled || signal?.aborted) img.src = "";
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve(img);
      };
      const onAbort = () => {
        const reason = signal?.reason;
        if (reason instanceof Error) finish(reason);
        else {
          const error = new Error("图片预览已取消");
          error.name = "AbortError";
          finish(error);
        }
      };
      img.decoding = "async";
      img.onload = () => finish();
      img.onerror = () => finish(new Error("无法生成图片预览"));
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      img.src = sourceUrl;
    });
    const scale = Math.min(1, maxSide / Math.max(1, image.naturalWidth, image.naturalHeight));
    const targetWidth = Math.max(1, Math.round(image.naturalWidth * scale));
    const targetHeight = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return "";
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "medium";
    ctx.drawImage(image, 0, 0, targetWidth, targetHeight);
    const blob = await new Promise<Blob | null>((resolve, reject) => {
      let settled = false;
      const timeoutId = window.setTimeout(() => finish(new Error("压缩图片预览超时")), 10_000);
      const cleanup = () => {
        window.clearTimeout(timeoutId);
        signal?.removeEventListener("abort", onAbort);
      };
      const finish = (error?: Error, value: Blob | null = null) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve(value);
      };
      const onAbort = () => {
        const reason = signal?.reason;
        if (reason instanceof Error) finish(reason);
        else {
          const error = new Error("图片预览压缩已取消");
          error.name = "AbortError";
          finish(error);
        }
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      canvas.toBlob((value) => finish(undefined, value), "image/webp", 0.82);
    });
    return blob ? URL.createObjectURL(blob) : "";
  } catch {
    return "";
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}

export function getDraggedMediaFiles(dataTransfer: DataTransfer | null): File[] {
  return Array.from(dataTransfer?.files || []).filter((file) => file.type.startsWith("image/") || file.type.startsWith("video/"));
}
