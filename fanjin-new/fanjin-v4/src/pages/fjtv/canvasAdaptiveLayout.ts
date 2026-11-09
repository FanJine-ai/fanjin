// The Studio rail mirrors the narrow “看板内容 / 资产” column in the approved
// workspace composition. Keeping this value in the layout helper also makes
// pan/fit calculations use the same visible width as the rendered rail.
export const CANVAS_ASSET_MANAGER_WIDTH = 200;
export const CANVAS_MIN_REFLOW_WIDTH = 600;
export const CANVAS_EMPTY_LAUNCHER_TWO_COLUMN_MIN_WIDTH = 600;
export const CANVAS_EMPTY_LAUNCHER_FOUR_COLUMN_MIN_WIDTH = 1040;
export const CANVAS_EMPTY_FIRST_NODE_VIEWPORT_SCALE = 0.49;
export const CANVAS_SIDEBAR_NODE_VERTICAL_RATIO = 0.32;
export const CANVAS_FIRST_NODE_AUTO_FIT_SUPPRESSION_MS = 1_200;

export type CanvasEmptyLauncherColumnCount = 1 | 2 | 4;

export type CanvasUsableLayout = {
  left: number;
  width: number;
  centerX: number;
};

export type CanvasSidebarNodePlacement = {
  centerX: number;
  centerY: number;
  viewportScale: number | null;
};

export type CanvasInlineNodeEditorLayout = {
  width: number;
  left: number;
  top: number | null;
  bottom: number | null;
};

export type CanvasCompactNodeEditorLayout = {
  width: number;
  left: number;
  top: number;
};

export type CanvasBoundsLike = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export type CanvasViewportLike = {
  scale: number;
  panX: number;
  panY: number;
};

export function getCanvasFirstNodeAutoFitSuppressionDeadline(
  nowMs: number,
): number {
  const safeNow = Number.isFinite(nowMs) ? nowMs : 0;
  return safeNow + CANVAS_FIRST_NODE_AUTO_FIT_SUPPRESSION_MS;
}

export function shouldSuppressCanvasTopologyFit(
  suppressionDeadlineMs: number,
  nowMs: number,
): boolean {
  return (
    Number.isFinite(suppressionDeadlineMs)
    && Number.isFinite(nowMs)
    && suppressionDeadlineMs > nowMs
  );
}

export function getCanvasUsableLayout(
  viewportWidth: number,
  assetManagerOpen: boolean,
  assetManagerWidth = CANVAS_ASSET_MANAGER_WIDTH,
): CanvasUsableLayout {
  const safeViewportWidth = Math.max(0, viewportWidth);
  const shouldReflow = assetManagerOpen && safeViewportWidth >= CANVAS_MIN_REFLOW_WIDTH;
  const left = shouldReflow ? Math.min(assetManagerWidth, safeViewportWidth) : 0;
  const width = Math.max(1, safeViewportWidth - left);

  return {
    left,
    width,
    centerX: left + width / 2,
  };
}

/**
 * Keeps an inline node editor inside the visible canvas at both release
 * viewports. The editor stays below its node while there is vertical room and
 * docks to the bottom inset when the selected node already occupies the lower
 * half of the canvas.
 */
export function getCanvasInlineNodeEditorLayout(
  viewportWidth: number,
  viewportHeight: number,
  assetManagerOpen: boolean,
  anchorX: number,
  anchorY: number,
  preferredWidth: number,
  inset = 16,
): CanvasInlineNodeEditorLayout {
  const safeHeight = Math.max(1, viewportHeight);
  const safeInset = Math.max(0, inset);
  const usableLayout = getCanvasUsableLayout(viewportWidth, assetManagerOpen);
  const horizontalInset = Math.min(
    safeInset,
    Math.max(0, (usableLayout.width - 1) / 2),
  );
  const verticalInset = Math.min(
    safeInset,
    Math.max(0, (safeHeight - 1) / 2),
  );
  const width = Math.min(
    Math.max(1, preferredWidth),
    Math.max(1, usableLayout.width - horizontalInset * 2),
  );
  const minimumCenterX = usableLayout.left + horizontalInset + width / 2;
  const maximumCenterX = usableLayout.left + usableLayout.width - horizontalInset - width / 2;
  const safeAnchorX = Number.isFinite(anchorX) ? anchorX : usableLayout.centerX;
  const left = Math.min(maximumCenterX, Math.max(minimumCenterX, safeAnchorX));
  const safeAnchorY = Math.max(
    verticalInset,
    Number.isFinite(anchorY) ? anchorY : verticalInset,
  );
  const anchorToBottom = safeAnchorY > safeHeight * 0.55;

  return {
    width,
    left,
    top: anchorToBottom ? null : Math.min(safeAnchorY, safeHeight - verticalInset),
    bottom: anchorToBottom ? verticalInset : null,
  };
}

/** Keeps the low-zoom editor launcher fully reachable even when its selected
 * node sits against an edge of the visible canvas. */
export function getCanvasCompactNodeEditorLayout(
  viewportWidth: number,
  viewportHeight: number,
  assetManagerOpen: boolean,
  anchorX: number,
  anchorY: number,
  preferredWidth = 312,
  preferredHeight = 68,
  inset = 16,
): CanvasCompactNodeEditorLayout {
  const safeHeight = Math.max(1, viewportHeight);
  const safeInset = Math.max(0, inset);
  const usableLayout = getCanvasUsableLayout(viewportWidth, assetManagerOpen);
  const horizontalInset = Math.min(
    safeInset,
    Math.max(0, (usableLayout.width - 1) / 2),
  );
  const verticalInset = Math.min(
    safeInset,
    Math.max(0, (safeHeight - 1) / 2),
  );
  const width = Math.min(
    Math.max(1, preferredWidth),
    Math.max(1, usableLayout.width - horizontalInset * 2),
  );
  const minimumCenterX = usableLayout.left + horizontalInset + width / 2;
  const maximumCenterX = usableLayout.left + usableLayout.width - horizontalInset - width / 2;
  const safeAnchorX = Number.isFinite(anchorX) ? anchorX : usableLayout.centerX;
  const safeAnchorY = Number.isFinite(anchorY) ? anchorY : verticalInset;
  const maximumTop = Math.max(verticalInset, safeHeight - Math.max(1, preferredHeight) - verticalInset);

  return {
    width,
    left: Math.min(maximumCenterX, Math.max(minimumCenterX, safeAnchorX)),
    top: Math.min(maximumTop, Math.max(verticalInset, safeAnchorY)),
  };
}

/**
 * Keeps nodes created from the Studio add button inside the work area rather
 * than underneath the asset rail. The first node starts just below 50% zoom so
 * the existing compact-editor launcher is used; its explicit Edit action opens
 * the centered editor without mounting the 940px inline panel outside a
 * 1440×900 canvas.
 */
export function getCanvasSidebarNodePlacement(
  viewportWidth: number,
  viewportHeight: number,
  assetManagerOpen: boolean,
  emptyCanvas: boolean,
): CanvasSidebarNodePlacement {
  const usableLayout = getCanvasUsableLayout(
    viewportWidth,
    assetManagerOpen,
  );
  const safeHeight = Math.max(1, viewportHeight);

  return {
    centerX: usableLayout.centerX,
    centerY: safeHeight * (
      emptyCanvas ? CANVAS_SIDEBAR_NODE_VERTICAL_RATIO : 0.52
    ),
    viewportScale: emptyCanvas
      ? CANVAS_EMPTY_FIRST_NODE_VIEWPORT_SCALE
      : null,
  };
}

export function getCanvasCenterShift(
  viewportWidth: number,
  previousAssetManagerOpen: boolean,
  nextAssetManagerOpen: boolean,
) {
  const previous = getCanvasUsableLayout(viewportWidth, previousAssetManagerOpen);
  const next = getCanvasUsableLayout(viewportWidth, nextAssetManagerOpen);
  return next.centerX - previous.centerX;
}

/**
 * Chooses a safe empty-launcher grid from the canvas width that remains after
 * the asset rail reflows the work area. Keeping this calculation outside the
 * component prevents the launcher from rendering beneath the rail.
 */
export function getCanvasEmptyLauncherColumnCount(
  viewportWidth: number,
  assetManagerOpen: boolean,
  assetManagerWidth = CANVAS_ASSET_MANAGER_WIDTH,
): CanvasEmptyLauncherColumnCount {
  const { width: usableWidth } = getCanvasUsableLayout(
    viewportWidth,
    assetManagerOpen,
    assetManagerWidth,
  );

  if (usableWidth >= CANVAS_EMPTY_LAUNCHER_FOUR_COLUMN_MIN_WIDTH) return 4;
  if (usableWidth >= CANVAS_EMPTY_LAUNCHER_TWO_COLUMN_MIN_WIDTH) return 2;
  return 1;
}

/**
 * Calculates a camera that fits the whole workflow into the currently usable
 * canvas. This is intentionally pure so topology changes can be tested without
 * involving pointer-driven pan and zoom state.
 */
export function getCanvasFitViewport(
  viewportWidth: number,
  viewportHeight: number,
  bounds: CanvasBoundsLike,
  assetManagerOpen: boolean,
  options: {
    assetManagerWidth?: number;
    visualScaleMultiplier?: number;
    scaleCap?: number;
    fillRatio?: number;
    minimumVisualScale?: number;
  } = {},
): CanvasViewportLike {
  const {
    assetManagerWidth = CANVAS_ASSET_MANAGER_WIDTH,
    visualScaleMultiplier = 1,
    scaleCap = 1,
    fillRatio = 0.78,
    minimumVisualScale = 0.08,
  } = options;
  const usableLayout = getCanvasUsableLayout(viewportWidth, assetManagerOpen, assetManagerWidth);
  const safeHeight = Math.max(1, viewportHeight);
  const contentWidth = Math.max(1, bounds.right - bounds.left);
  const contentHeight = Math.max(1, bounds.bottom - bounds.top);
  const scaleX = (usableLayout.width * fillRatio) / contentWidth;
  const scaleY = (safeHeight * fillRatio) / contentHeight;
  const cappedVisualScale = Math.max(
    minimumVisualScale,
    Math.min(scaleCap * visualScaleMultiplier, scaleX, scaleY),
  );
  const contentCenterX = (bounds.left + bounds.right) / 2;
  const contentCenterY = (bounds.top + bounds.bottom) / 2;

  return {
    scale: cappedVisualScale / Math.max(0.001, visualScaleMultiplier),
    panX: usableLayout.centerX - contentCenterX * cappedVisualScale,
    panY: safeHeight / 2 - contentCenterY * cappedVisualScale,
  };
}

/** Ignore sub-pixel/layout-animation noise and react only to a real shell
 * topology or viewport change. */
export function shouldRefitCanvasAfterResize(
  previous: { width: number; height: number } | null,
  next: { width: number; height: number },
  minimumDelta = 24,
) {
  if (!previous) return false;
  return Math.abs(next.width - previous.width) >= minimumDelta
    || Math.abs(next.height - previous.height) >= minimumDelta;
}
