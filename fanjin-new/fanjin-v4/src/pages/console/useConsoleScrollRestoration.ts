import { type RefObject, useLayoutEffect } from "react";

type ConsoleNavigationType = "POP" | "PUSH" | "REPLACE";

type UseConsoleScrollRestorationOptions = {
  containerRef: RefObject<HTMLElement | null>;
  locationKey: string;
  navigationType: ConsoleNavigationType;
};

const MAX_SAVED_POSITIONS = 80;
const RESTORE_WINDOW_MS = 4_000;
const scrollPositions = new Map<string, number>();
const scrollKeys = new Set([
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "End",
  "Home",
  "PageDown",
  "PageUp",
  " ",
]);

function rememberScrollPosition(locationKey: string, scrollTop: number) {
  scrollPositions.delete(locationKey);
  scrollPositions.set(locationKey, Math.max(0, scrollTop));

  while (scrollPositions.size > MAX_SAVED_POSITIONS) {
    const oldestKey = scrollPositions.keys().next().value;
    if (oldestKey === undefined) break;
    scrollPositions.delete(oldestKey);
  }
}

/**
 * React Router restores the window by default, while the console scrolls inside
 * its content pane. Keep a small location-keyed cache for that pane and retry a
 * POP restoration while async route content is still changing size.
 */
export function useConsoleScrollRestoration({
  containerRef,
  locationKey,
  navigationType,
}: UseConsoleScrollRestorationOptions) {
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const savedPosition = scrollPositions.get(locationKey);
    const shouldRestore = navigationType === "POP" && savedPosition !== undefined;
    const targetPosition = shouldRestore ? savedPosition : 0;
    let restoring = shouldRestore && targetPosition > 0;
    let disposed = false;
    let animationFrame = 0;
    let restoreTimeout = 0;
    let lastKnownPosition = container.scrollTop;
    let resizeObserver: ResizeObserver | undefined;
    let mutationObserver: MutationObserver | undefined;

    const saveCurrentPosition = () => {
      lastKnownPosition = container.scrollTop;
      if (!restoring) rememberScrollPosition(locationKey, lastKnownPosition);
    };

    const disconnectRestorationObservers = () => {
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      if (restoreTimeout) window.clearTimeout(restoreTimeout);
      animationFrame = 0;
      restoreTimeout = 0;
    };

    const stopRestoring = (saveCurrent = true) => {
      if (!restoring) return;
      restoring = false;
      disconnectRestorationObservers();
      lastKnownPosition = container.scrollTop;
      if (saveCurrent) rememberScrollPosition(locationKey, lastKnownPosition);
    };

    const applyTargetPosition = () => {
      animationFrame = 0;
      if (disposed || !restoring) return;
      container.scrollTop = targetPosition;
    };

    const scheduleRestoration = () => {
      if (disposed || !restoring || animationFrame) return;
      animationFrame = window.requestAnimationFrame(applyTargetPosition);
    };

    const observeContentSize = () => {
      if (!resizeObserver) return;
      resizeObserver.observe(container);
      Array.from(container.children).forEach((child) => resizeObserver?.observe(child));
    };

    const interruptRestoration = () => stopRestoring(true);
    const interruptRestorationFromKeyboard = (event: KeyboardEvent) => {
      if (scrollKeys.has(event.key)) interruptRestoration();
    };

    container.addEventListener("scroll", saveCurrentPosition, { passive: true });
    container.addEventListener("wheel", interruptRestoration, { passive: true });
    container.addEventListener("touchstart", interruptRestoration, { passive: true });
    container.addEventListener("pointerdown", interruptRestoration, { passive: true });
    container.addEventListener("keydown", interruptRestorationFromKeyboard);

    if (!restoring) {
      container.scrollTop = 0;
      lastKnownPosition = 0;
      rememberScrollPosition(locationKey, 0);
    } else {
      applyTargetPosition();

      if (typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(scheduleRestoration);
        observeContentSize();
      }

      if (typeof MutationObserver !== "undefined") {
        mutationObserver = new MutationObserver(() => {
          observeContentSize();
          scheduleRestoration();
        });
        mutationObserver.observe(container, { childList: true, subtree: true });
      }

      scheduleRestoration();
      restoreTimeout = window.setTimeout(() => stopRestoring(true), RESTORE_WINDOW_MS);
    }

    return () => {
      disposed = true;
      disconnectRestorationObservers();
      container.removeEventListener("scroll", saveCurrentPosition);
      container.removeEventListener("wheel", interruptRestoration);
      container.removeEventListener("touchstart", interruptRestoration);
      container.removeEventListener("pointerdown", interruptRestoration);
      container.removeEventListener("keydown", interruptRestorationFromKeyboard);

      // During an unfinished automatic POP restoration, preserve the original
      // target instead of overwriting it with a temporarily clamped position.
      if (!restoring) rememberScrollPosition(locationKey, lastKnownPosition);
    };
  }, [containerRef, locationKey, navigationType]);
}
