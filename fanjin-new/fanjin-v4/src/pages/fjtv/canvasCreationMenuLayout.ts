export type CanvasMenuViewport = {
  width: number;
  height: number;
};

export type CanvasMenuPosition = {
  x: number;
  y: number;
};

const DEFAULT_MENU_WIDTH = 326;
const DEFAULT_MENU_HEIGHT = 560;
const DEFAULT_MARGIN = 12;

export function clampCanvasCreationMenuPosition(
  position: CanvasMenuPosition,
  viewport: CanvasMenuViewport,
  options: {
    width?: number;
    height?: number;
    margin?: number;
  } = {},
): CanvasMenuPosition {
  const width = options.width ?? DEFAULT_MENU_WIDTH;
  const height = options.height ?? DEFAULT_MENU_HEIGHT;
  const margin = options.margin ?? DEFAULT_MARGIN;
  const maxX = Math.max(margin, viewport.width - width - margin);
  const maxY = Math.max(margin, viewport.height - height - margin);
  return {
    x: Math.min(Math.max(position.x, margin), maxX),
    y: Math.min(Math.max(position.y, margin), maxY),
  };
}
