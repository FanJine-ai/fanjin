import { useLayoutEffect, type RefObject } from "react";

export function useCanvasFloatingMenuPlacement(rootRef: RefObject<HTMLElement | null>, enabled: boolean) {
  useLayoutEffect(() => {
    if (!enabled) return undefined;
    const root = rootRef.current;
    if (!root) return undefined;
    let placementFrame = 0;
    const placeMenusInsideViewport = () => {
      const rootRect = root.getBoundingClientRect();
      const leftBoundary = Math.max(12, rootRect.left + 12);
      const rightBoundary = Math.min(window.innerWidth - 12, rootRect.right - 12);
      const availableWidth = Math.max(0, rightBoundary - leftBoundary);
      root.querySelectorAll<HTMLElement>("[data-node-video-settings-menu], [data-node-model-menu], #canvas-share-popover[data-canvas-popover]").forEach((menu) => {
        menu.style.setProperty("--canvas-floating-menu-shift-x", "0px");
        menu.style.setProperty("--canvas-floating-menu-max-width", `${availableWidth}px`);
        let rect = menu.getBoundingClientRect();
        const renderedScale = menu.offsetWidth > 0 ? rect.width / menu.offsetWidth : 1;
        if (renderedScale > 0 && rect.width > availableWidth) {
          menu.style.setProperty("--canvas-floating-menu-max-width", `${Math.max(0, availableWidth / renderedScale)}px`);
          rect = menu.getBoundingClientRect();
        }
        const shift = rect.right > rightBoundary ? rightBoundary - rect.right : rect.left < leftBoundary ? leftBoundary - rect.left : 0;
        menu.style.setProperty("--canvas-floating-menu-shift-x", `${Math.round(shift * 100) / 100}px`);
      });
    };
    const schedulePlacement = () => {
      window.cancelAnimationFrame(placementFrame);
      placementFrame = window.requestAnimationFrame(placeMenusInsideViewport);
    };
    placeMenusInsideViewport();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedulePlacement);
    observer?.observe(root);
    window.addEventListener("resize", schedulePlacement);
    window.visualViewport?.addEventListener("resize", schedulePlacement);
    return () => {
      window.cancelAnimationFrame(placementFrame);
      observer?.disconnect();
      window.removeEventListener("resize", schedulePlacement);
      window.visualViewport?.removeEventListener("resize", schedulePlacement);
    };
  }, [enabled, rootRef]);
}
