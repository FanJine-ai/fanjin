export function getCanvasCreationMenuScreenPosition({
  menu,
  rootRect,
  assetManagerOpen,
  getSidebarPosition,
  toScreen,
  clamp,
}: {
  menu: { open: boolean; source: string; x: number; y: number };
  rootRect: { width: number; height: number } | null;
  assetManagerOpen: boolean;
  getSidebarPosition: (width: number, assetManagerOpen: boolean) => { left: number };
  toScreen: (x: number, y: number) => { x: number; y: number };
  clamp: (position: { x: number; y: number }, viewport: { width: number; height: number }) => { x: number; y: number };
}) {
  if (!menu.open) return null;
  const viewport = {
    width: rootRect?.width ?? window.innerWidth,
    height: rootRect?.height ?? window.innerHeight,
  };
  const rawPosition = menu.source === "sidebar"
    ? { x: getSidebarPosition(viewport.width, assetManagerOpen).left + 12, y: viewport.height / 2 - 220 }
    : toScreen(menu.x, menu.y);
  return clamp(rawPosition, viewport);
}
