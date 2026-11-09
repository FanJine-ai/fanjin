/**
 * Pure math behind the canvas minimap (看板缩略图).
 *
 * Extracted from InfiniteCanvasStable so the projection and the drag/click
 * positioning can be unit-tested without mounting the 20k-line canvas page.
 *
 * Coordinate spaces:
 * - world: canvas node coordinates (node.x / node.y).
 * - mini:  CSS pixels inside the minimap surface content box.
 * - root:  CSS pixels inside the canvas root element (viewport pan units).
 */

export type MiniMapRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export type MiniMapRectLike = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type MiniMapMetrics = {
  /** World-space bounds the minimap draws (content ∪ viewport, padded). */
  bounds: MiniMapRect;
  /** World-space viewport rectangle, when the canvas root is measurable. */
  viewportRect: MiniMapRect | null;
  /** world → mini scale (mini px per world unit). */
  scale: number;
  /** Horizontal centering offset inside the surface, in mini px. */
  offsetX: number;
  /** Vertical centering offset inside the surface, in mini px. */
  offsetY: number;
  /** Surface content-box width used for the projection. */
  width: number;
  /** Surface content-box height used for the projection. */
  height: number;
  /** Projects a world rect into minimap pixels (min 2px so dots stay visible). */
  toMiniRect: (rect: MiniMapRect) => MiniMapRectLike;
};

export function unionMiniMapRects(rects: MiniMapRect[]): MiniMapRect | null {
  if (rects.length === 0) return null;
  return {
    left: Math.min(...rects.map((rect) => rect.left)),
    top: Math.min(...rects.map((rect) => rect.top)),
    right: Math.max(...rects.map((rect) => rect.right)),
    bottom: Math.max(...rects.map((rect) => rect.bottom)),
  };
}

/**
 * Builds the world → mini projection. Returns null when there is nothing to
 * draw (no node/group rects and no measurable viewport rect).
 *
 * `width` / `height` must be the surface content-box size in CSS pixels; the
 * caller measures the real element so rendering and pointer math share one
 * frame (a hard-coded size used to desync clicks from the projection).
 */
export function computeMiniMapMetrics(input: {
  rects: MiniMapRect[];
  viewportRect: MiniMapRect | null;
  width: number;
  height: number;
}): MiniMapMetrics | null {
  const width = Math.max(1, input.width);
  const height = Math.max(1, input.height);
  // 地图边界只由内容决定:视口矩形是在内容地图上移动的指示框。
  // 若把视口并入边界,视口包含全部内容时矩形会被锚定在原位
  // (用户拖小地图时矩形不动,看似「无法选中区域」)。
  // 空内容时退到以世界原点为中心的默认范围,矩形仍可随视口移动。
  const contentBounds = unionMiniMapRects(input.rects);
  const rawBounds = contentBounds ?? { left: -2000, top: -1500, right: 2000, bottom: 1500 };
  const rawWidth = Math.max(1, rawBounds.right - rawBounds.left);
  const rawHeight = Math.max(1, rawBounds.bottom - rawBounds.top);
  const padX = Math.max(260, rawWidth * 0.12);
  const padY = Math.max(220, rawHeight * 0.12);
  const bounds: MiniMapRect = {
    left: rawBounds.left - padX,
    top: rawBounds.top - padY,
    right: rawBounds.right + padX,
    bottom: rawBounds.bottom + padY,
  };
  const worldWidth = Math.max(1, bounds.right - bounds.left);
  const worldHeight = Math.max(1, bounds.bottom - bounds.top);
  const scale = Math.min(width / worldWidth, height / worldHeight);
  const drawWidth = worldWidth * scale;
  const drawHeight = worldHeight * scale;
  const offsetX = (width - drawWidth) / 2;
  const offsetY = (height - drawHeight) / 2;
  const toMiniRect = (rect: MiniMapRect): MiniMapRectLike => ({
    left: offsetX + (rect.left - bounds.left) * scale,
    top: offsetY + (rect.top - bounds.top) * scale,
    width: Math.max(2, (rect.right - rect.left) * scale),
    height: Math.max(2, (rect.bottom - rect.top) * scale),
  });
  return {
    bounds,
    viewportRect: input.viewportRect,
    scale,
    offsetX,
    offsetY,
    width,
    height,
    toMiniRect,
  };
}

/**
 * Maps a pointer position (client coordinates) inside the minimap surface to
 * the world point under the cursor. `surfaceRect` is the surface content box
 * (border excluded). The result is clamped to the surface so drags that leave
 * the element keep moving the viewport instead of jumping.
 */
export function miniMapClientToWorld(input: {
  clientX: number;
  clientY: number;
  surfaceRect: MiniMapRectLike;
  metrics: MiniMapMetrics;
}): { x: number; y: number } {
  const mx = Math.min(input.surfaceRect.width, Math.max(0, input.clientX - input.surfaceRect.left));
  const my = Math.min(input.surfaceRect.height, Math.max(0, input.clientY - input.surfaceRect.top));
  const safeScale = Math.max(0.000001, input.metrics.scale);
  return {
    x: input.metrics.bounds.left + (mx - input.metrics.offsetX) / safeScale,
    y: input.metrics.bounds.top + (my - input.metrics.offsetY) / safeScale,
  };
}

/**
 * Computes the canvas pan that centers the given world point in the usable
 * viewport. Inverse of the world → screen mapping used by the canvas root
 * (`screen = pan + world * visualScale`).
 */
export function computeMiniMapViewportPan(input: {
  worldX: number;
  worldY: number;
  /** viewport.scale * CANVAS_VISUAL_SCALE */
  visualScale: number;
  /** usable layout center X inside the canvas root, in px */
  centerX: number;
  /** usable layout center Y inside the canvas root, in px */
  centerY: number;
}): { panX: number; panY: number } {
  return {
    panX: input.centerX - input.worldX * input.visualScale,
    panY: input.centerY - input.worldY * input.visualScale,
  };
}

/**
 * Round-trip helper used by tests and by the drag handler sanity checks:
 * applies the pan to a world point, yielding root-space screen coordinates.
 */
export function miniMapWorldToScreen(input: {
  worldX: number;
  worldY: number;
  visualScale: number;
  panX: number;
  panY: number;
}): { x: number; y: number } {
  return {
    x: input.panX + input.worldX * input.visualScale,
    y: input.panY + input.worldY * input.visualScale,
  };
}
