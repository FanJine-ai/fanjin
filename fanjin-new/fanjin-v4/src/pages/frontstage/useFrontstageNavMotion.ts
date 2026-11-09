import { useLayoutEffect, useRef, useState } from "react";

const DURATION = 320;
const EASING = "cubic-bezier(0.22, 1, 0.36, 1)";
const parts = [
  [".frontstageBrandMark", ["paddingLeft", "paddingRight", "marginBottom", "gap"]],
  [".frontstageBrandText, .frontstageNavLabel, .frontstageWorkspaceText", ["maxWidth", "opacity", "transform"]],
  [".frontstageNavList button", ["height", "paddingLeft", "paddingRight", "gap"]],
  [".frontstageIdentitySwitcher", ["marginBottom"]],
  [".frontstageIdentityButton", ["height", "minHeight", "paddingLeft", "paddingRight", "paddingTop", "paddingBottom", "gap", "borderRadius"]],
  [".frontstageIdentityAvatar", ["width", "height"]],
  [".frontstagePersistentDock", ["height"]],
  [".frontstagePersistentDock .frontstageTopIconButton, .frontstagePersistentDock .frontstageBalanceButton, .frontstagePersistentDock .frontstageThemeButton, .frontstagePersistentDock .frontstageMoreButton", ["left", "top", "width", "height"]],
] as const;

type Snapshot = { width: number; styles: Record<string, string>[][]; time: number };
let departing: Snapshot | null = null;

function motionAllowed() {
  return typeof window !== "undefined"
    && !window.matchMedia?.("(max-width: 760px)").matches
    && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

function snapshot(nav: HTMLElement | null): Snapshot | null {
  if (!nav || !motionAllowed()) return null;
  const width = nav.getBoundingClientRect().width;
  if (width < 60 || width > 230) return null;
  return {
    width,
    time: performance.now(),
    styles: parts.map(([selector, properties]) => Array.from(nav.querySelectorAll(selector), (element) => {
      const style = getComputedStyle(element);
      return Object.fromEntries(properties.map((property) => [property, style[property as keyof CSSStyleDeclaration] as string]));
    })),
  };
}

/** Carry the departing sidebar's rendered geometry across route component mounts.
 * Also retarget an interrupted toggle from its current frame. CSS remains the
 * fallback on mobile, with reduced motion, or without Web Animations support.
 * Only presentation is carried over, never the user's saved collapse preference.
 */
export function useFrontstageNavMotion(collapsed: boolean) {
  const navRef = useRef<HTMLElement>(null);
  const [origin] = useState(() => {
    if (!motionAllowed()) return null;
    return snapshot(document.querySelector("aside.frontstageSideNav"))
      ?? (departing && performance.now() - departing.time < 600 ? departing : null);
  });

  const originRef = useRef(origin);

  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const animations: Animation[] = [];
    const animate = (element: HTMLElement, from: Keyframe, to: Keyframe) => {
      if (JSON.stringify(from) === JSON.stringify(to)) return;
      animations.push(element.animate([from, to], { duration: DURATION, easing: EASING }));
    };
    const from = originRef.current;
    originRef.current = null;
    if (from && motionAllowed() && typeof nav.animate === "function") {
      const width = collapsed ? 64 : 224;
      if (Math.abs(from.width - width) > 1) {
        const shell = nav.closest<HTMLElement>(".projectStudioShell");
        const columns = shell ? getComputedStyle(shell).gridTemplateColumns.replace(/^\S+/, `${width}px`) : null;
        // Measure the destination geometry, even if React is still synchronizing
        // the containing grid. Restore inline styles before the browser paints.
        const navStyle = nav.style.width;
        const gridStyle = shell?.style.gridTemplateColumns ?? "";
        nav.style.width = `${width}px`;
        if (shell && columns) shell.style.gridTemplateColumns = columns;
        for (const element of [nav, shell]) {
          element?.getAnimations({ subtree: element === nav }).forEach((animation) => {
            if (typeof CSSTransition !== "undefined" && animation instanceof CSSTransition) animation.finish();
          });
        }
        const target = snapshot(nav);
        nav.style.width = navStyle;
        if (shell) shell.style.gridTemplateColumns = gridStyle;
        animate(nav, { width: `${from.width}px`, flexBasis: `${from.width}px` }, { width: `${width}px`, flexBasis: `${width}px` });
        if (shell && columns) {
          animate(shell, { gridTemplateColumns: columns.replace(/^\S+/, `${from.width}px`) }, { gridTemplateColumns: columns });
        }
        parts.forEach(([selector], partIndex) => {
          nav.querySelectorAll<HTMLElement>(selector).forEach((element, index) => {
            const startStyle = from.styles[partIndex][index];
            if (!startStyle) return;
            const to = target?.styles[partIndex][index];
            if (to) animate(element, startStyle, to);
          });
        });
      }
    }
    // Rapid route changes and manual reversals start from the current frame.
    // Resizing or enabling reduced motion immediately returns control to CSS.
    const stop = () => animations.forEach((animation) => animation.cancel());
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    window.addEventListener("resize", stop);
    reducedMotion?.addEventListener("change", stop);
    return () => {
      departing = snapshot(nav);
      originRef.current = departing;
      stop();
      window.removeEventListener("resize", stop);
      reducedMotion?.removeEventListener("change", stop);
    };
  }, [collapsed]);

  return navRef;
}
