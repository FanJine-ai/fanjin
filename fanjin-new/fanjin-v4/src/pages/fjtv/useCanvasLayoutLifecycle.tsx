import { useLayoutEffect,type DependencyList } from "react";
import {
getCanvasCenterShift
} from "./canvasAdaptiveLayout";
import { STUDIO_PROJECT_HEADER_SLOT_ID } from "./canvasPageConstants";
interface useCanvasAssetPanelLayoutContext {
  previousAssetManagerOpenRef: React.RefObject<boolean>;
  assetManagerOpen: boolean;
  studioChrome: boolean;
  studioTopologyFitTimerRef: React.RefObject<number | null>;
  studioTopologyFitRef: React.RefObject<() => void>;
  rootRef: React.RefObject<HTMLDivElement | null>;
  setViewport: React.Dispatch<React.SetStateAction<import("@/pages/fjtv/canvasDataTypes").ViewportState>>;
  viewportRef: React.RefObject<import("@/pages/fjtv/canvasDataTypes").ViewportState>;
}
export function useCanvasAssetPanelLayout(readContext: () => useCanvasAssetPanelLayoutContext, dependencies: DependencyList) {
  useLayoutEffect(() => {
    const { previousAssetManagerOpenRef, assetManagerOpen, studioChrome, studioTopologyFitTimerRef, studioTopologyFitRef, rootRef, setViewport, viewportRef } = readContext();

    const previousOpen = previousAssetManagerOpenRef.current;
    previousAssetManagerOpenRef.current = assetManagerOpen;
    if (previousOpen === assetManagerOpen) return;

    if (studioChrome) {
      if (studioTopologyFitTimerRef.current !== null) {
        window.clearTimeout(studioTopologyFitTimerRef.current);
      }
      studioTopologyFitTimerRef.current = window.setTimeout(() => {
        studioTopologyFitTimerRef.current = null;
        studioTopologyFitRef.current();
      }, 80);
      return;
    }

    const viewportWidth = rootRef.current?.getBoundingClientRect().width ?? 0;
    const centerShift = getCanvasCenterShift(viewportWidth, previousOpen, assetManagerOpen);
    if (!centerShift) return;

    setViewport((current) => {
      const next = { ...current, panX: current.panX + centerShift };
      viewportRef.current = next;
      return next;
    });

  }, dependencies);
}
interface useCanvasSurfaceMeasurementContext {
  rootRef: React.RefObject<HTMLDivElement | null>;
  setCanvasSurfaceWidth: React.Dispatch<React.SetStateAction<number>>;
  setCanvasSurfaceHeight: React.Dispatch<React.SetStateAction<number>>;
}
export function useCanvasSurfaceMeasurement(readContext: () => useCanvasSurfaceMeasurementContext, dependencies: DependencyList) {
  useLayoutEffect(() => {
    const { rootRef, setCanvasSurfaceWidth, setCanvasSurfaceHeight } = readContext();

    const root = rootRef.current;
    if (!root) return;

    const updateSurfaceSize = (width: number, height: number) => {
      const nextWidth = Math.max(0, Math.round(width));
      const nextHeight = Math.max(0, Math.round(height));
      setCanvasSurfaceWidth((current) => (current === nextWidth ? current : nextWidth));
      setCanvasSurfaceHeight((current) => (current === nextHeight ? current : nextHeight));
    };
    const measureSurface = () => {
      const rect = root.getBoundingClientRect();
      updateSurfaceSize(rect.width, rect.height);
    };

    measureSurface();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver((entries) => {
        const entry = entries[0];
        const rect = root.getBoundingClientRect();
        updateSurfaceSize(
          entry?.contentRect.width ?? rect.width,
          entry?.contentRect.height ?? rect.height,
        );
      });
      observer.observe(root);
      return () => observer.disconnect();
    }

    window.addEventListener("resize", measureSurface);
    return () => window.removeEventListener("resize", measureSurface);

  }, dependencies);
}
interface useCanvasProjectHeaderPortalContext {
  studioChrome: boolean;
  studioProjectHeaderInAgent: boolean;
  setStudioProjectHeaderPortalTarget: React.Dispatch<React.SetStateAction<HTMLElement | null>>;
}
export function useCanvasProjectHeaderPortal(readContext: () => useCanvasProjectHeaderPortalContext, dependencies: DependencyList) {
  useLayoutEffect(() => {
    const { studioChrome, studioProjectHeaderInAgent, setStudioProjectHeaderPortalTarget } = readContext();

    if (!studioChrome || !studioProjectHeaderInAgent) {
      setStudioProjectHeaderPortalTarget(null);
      return;
    }
    setStudioProjectHeaderPortalTarget(document.getElementById(STUDIO_PROJECT_HEADER_SLOT_ID));

  }, dependencies);
}
interface useCanvasRouteInvalidationContext {
  invalidateCanvasPersistenceContext: () => void;
}
export function useCanvasRouteInvalidation(readContext: () => useCanvasRouteInvalidationContext, dependencies: DependencyList) {
  useLayoutEffect(() => {
    const { invalidateCanvasPersistenceContext } = readContext();

    invalidateCanvasPersistenceContext();

  }, dependencies);
}
