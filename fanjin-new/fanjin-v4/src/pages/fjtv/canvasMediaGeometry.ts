import type { NodeType, RatioKey, ImageOutpaintRatioMode, ImageOutpaintDraft, ImageCropDraft } from "./canvasMediaTypes";

export interface CanvasImageGeometryNode {
  id: string;
  width: number;
  height: number;
  mediaNaturalWidth?: number;
  mediaNaturalHeight?: number;
  imageRotation?: number;
  imageFlipX?: boolean;
  imageFlipY?: boolean;
}

export const NODE_WIDTH = 440;

export const RATIOS: Array<{ key: RatioKey; label: string; w: number; h: number }> = [
  { key: "1:1", label: "1:1", w: 1, h: 1 },
  { key: "2:1", label: "2:1", w: 2, h: 1 },
  { key: "2:3", label: "2:3", w: 2, h: 3 },
  { key: "3:2", label: "3:2", w: 3, h: 2 },
  { key: "4:5", label: "4:5", w: 4, h: 5 },
  { key: "5:4", label: "5:4", w: 5, h: 4 },
  { key: "16:9", label: "16:9", w: 16, h: 9 },
  { key: "9:16", label: "9:16", w: 9, h: 16 },
  { key: "21:9", label: "21:9", w: 21, h: 9 },
  { key: "9:21", label: "9:21", w: 9, h: 21 },
  { key: "3:4", label: "3:4", w: 3, h: 4 },
  { key: "4:3", label: "4:3", w: 4, h: 3 },
  { key: "auto", label: "自适应", w: 1, h: 1 },
];

export function ratioToHeight(key: RatioKey, type: NodeType = "image"): number {
  if (key === "auto") {
    return type === "video" ? ratioToHeight("16:9", "video") : NODE_WIDTH;
  }
  const target = RATIOS.find((r) => r.key === key);
  if (!target) return NODE_WIDTH;
  return (NODE_WIDTH * target.h) / target.w;
}

export function ratioToNodeDimensions(key: RatioKey, type: NodeType = "image") {
  if (type === "script") {
    return { width: 460, height: 330 };
  }
  if (type === "text") {
    return { width: NODE_WIDTH, height: ratioToHeight(key, type) };
  }
  if (key === "auto") {
    return { width: NODE_WIDTH, height: NODE_WIDTH };
  }
  const target = RATIOS.find((r) => r.key === key);
  if (!target) {
    return { width: NODE_WIDTH, height: NODE_WIDTH };
  }
  if (target.w >= target.h) {
    return { width: (NODE_WIDTH * target.w) / target.h, height: NODE_WIDTH };
  }
  return { width: NODE_WIDTH, height: (NODE_WIDTH * target.h) / target.w };
}

export function nearestRatio(width: number, height: number): RatioKey {
  if (!width || !height) return "auto";
  const target = width / height;
  let best: { key: RatioKey; diff: number } = { key: "1:1", diff: Number.MAX_VALUE };
  RATIOS.forEach((r) => {
    if (r.key === "auto") return;
    const diff = Math.abs(target - r.w / r.h);
    if (diff < best.diff) best = { key: r.key, diff };
  });
  return best.key;
}

export function mediaToNodeDimensions(width: number, height: number) {
  if (!width || !height) {
    return { width: NODE_WIDTH, height: NODE_WIDTH };
  }
  if (width >= height) {
    return { width: (NODE_WIDTH * width) / height, height: NODE_WIDTH };
  }
  return { width: NODE_WIDTH, height: (NODE_WIDTH * height) / width };
}

export function aspectForImageRatioMode(ratioMode: ImageOutpaintRatioMode) {
  if (ratioMode === "1:1") return 1;
  if (ratioMode === "4:3") return 4 / 3;
  if (ratioMode === "3:4") return 3 / 4;
  if (ratioMode === "16:9") return 16 / 9;
  if (ratioMode === "9:16") return 9 / 16;
  return null;
}

export function normalizeImageRotation(value: number) {
  const normalized = ((Number(value) || 0) % 360 + 360) % 360;
  return normalized > 180 ? normalized - 360 : normalized;
}

export function buildImageTransformStyle(node: CanvasImageGeometryNode) {
  const rotation = normalizeImageRotation(node.imageRotation || 0);
  const scaleX = node.imageFlipX ? -1 : 1;
  const scaleY = node.imageFlipY ? -1 : 1;
  if (!rotation && scaleX === 1 && scaleY === 1) return undefined;
  return { transform: `rotate(${rotation}deg) scaleX(${scaleX}) scaleY(${scaleY})` };
}

export function clampImageOutpaintValue(value: number) {
  return Math.max(0, Math.min(0.4, Number(value) || 0));
}

export function clampImageOutpaintDraft(draft: ImageOutpaintDraft): ImageOutpaintDraft {
  return {
    ...draft,
    expandLeft: clampImageOutpaintValue(draft.expandLeft),
    expandRight: clampImageOutpaintValue(draft.expandRight),
    expandTop: clampImageOutpaintValue(draft.expandTop),
    expandBottom: clampImageOutpaintValue(draft.expandBottom),
    count: Math.max(1, Math.min(4, Math.round(draft.count || 1))),
  };
}

export function buildImageOutpaintDraftForRatio(node: CanvasImageGeometryNode, ratioMode: ImageOutpaintRatioMode, previous?: ImageOutpaintDraft | null): ImageOutpaintDraft {
  const sourceWidth = Math.max(1, node.mediaNaturalWidth || Math.round(node.width));
  const sourceHeight = Math.max(1, node.mediaNaturalHeight || Math.round(node.height));
  const currentRatio = sourceWidth / sourceHeight;
  const targetRatio = aspectForImageRatioMode(ratioMode);
  let expandLeft = previous?.expandLeft || 0;
  let expandRight = previous?.expandRight || 0;
  let expandTop = previous?.expandTop || 0;
  let expandBottom = previous?.expandBottom || 0;
  if (ratioMode !== "custom") {
    expandLeft = 0;
    expandRight = 0;
    expandTop = 0;
    expandBottom = 0;
    if (targetRatio && Math.abs(targetRatio - currentRatio) > 0.0001) {
      if (targetRatio > currentRatio) {
        const targetWidth = sourceHeight * targetRatio;
        const extraRatio = Math.max(0, (targetWidth - sourceWidth) / sourceWidth);
        expandLeft = clampImageOutpaintValue(extraRatio / 2);
        expandRight = clampImageOutpaintValue(extraRatio / 2);
      } else {
        const targetHeight = sourceWidth / targetRatio;
        const extraRatio = Math.max(0, (targetHeight - sourceHeight) / sourceHeight);
        expandTop = clampImageOutpaintValue(extraRatio / 2);
        expandBottom = clampImageOutpaintValue(extraRatio / 2);
      }
    }
  }
  return clampImageOutpaintDraft({
    nodeId: node.id,
    ratioMode,
    resolution: previous?.resolution || "2K",
    count: previous?.count || 1,
    expandLeft,
    expandRight,
    expandTop,
    expandBottom,
  });
}

export function getImageOutpaintPreviewMetrics(node: CanvasImageGeometryNode, draft: ImageOutpaintDraft) {
  const sourceWidth = Math.max(1, node.mediaNaturalWidth || Math.round(node.width));
  const sourceHeight = Math.max(1, node.mediaNaturalHeight || Math.round(node.height));
  const naturalWidth = Math.max(1, Math.round(sourceWidth * (1 + draft.expandLeft + draft.expandRight)));
  const naturalHeight = Math.max(1, Math.round(sourceHeight * (1 + draft.expandTop + draft.expandBottom)));
  const dims = mediaToNodeDimensions(naturalWidth, naturalHeight);
  return {
    width: dims.width,
    height: dims.height,
    naturalWidth,
    naturalHeight,
    expandLeft: draft.expandLeft,
    expandRight: draft.expandRight,
    expandTop: draft.expandTop,
    expandBottom: draft.expandBottom,
  };
}

export function clampImageCropDraft(draft: ImageCropDraft): ImageCropDraft {
  const width = Math.max(0.08, Math.min(1, draft.width));
  const height = Math.max(0.08, Math.min(1, draft.height));
  const x = Math.max(0, Math.min(1 - width, draft.x));
  const y = Math.max(0, Math.min(1 - height, draft.y));
  return { ...draft, x, y, width, height };
}

export function buildImageCropDraftForRatio(node: CanvasImageGeometryNode, ratioMode: ImageOutpaintRatioMode, previous?: ImageCropDraft | null): ImageCropDraft {
  const current = previous && previous.nodeId === node.id ? previous : null;
  const targetRatio = aspectForImageRatioMode(ratioMode);
  if (!targetRatio || ratioMode === "custom" || ratioMode === "original") {
    return clampImageCropDraft(
      current || {
        nodeId: node.id,
        ratioMode,
        x: 0,
        y: 0,
        width: 1,
        height: 1,
      },
    );
  }
  const sourceRatio = Math.max(0.08, (node.mediaNaturalWidth || node.width) / Math.max(1, node.mediaNaturalHeight || node.height));
  let width = 1;
  let height = 1;
  if (targetRatio > sourceRatio) {
    height = Math.min(1, sourceRatio / targetRatio);
  } else {
    width = Math.min(1, targetRatio / sourceRatio);
  }
  return clampImageCropDraft({
    nodeId: node.id,
    ratioMode,
    x: (1 - width) / 2,
    y: (1 - height) / 2,
    width,
    height,
  });
}
