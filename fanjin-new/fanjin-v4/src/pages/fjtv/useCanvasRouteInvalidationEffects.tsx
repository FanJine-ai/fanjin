import { createCanvasProjectActionBindings } from "./canvasProjectActionBindings";
import { useCanvasRuntimeCleanup } from "./useCanvasGenerationLifecycle";
import { useCanvasRouteInvalidation } from "./useCanvasLayoutLifecycle";
import { useCanvasProjectState } from "./useCanvasProjectState";
import { useCanvasRuntimeRefs } from "./useCanvasRuntimeRefs";
export function useCanvasRouteInvalidationEffects({
  canvasProjectActionBindings,
  routeCanvasId,
  canvasProjectStateModule,
  forceFreshCanvasEntry,
  location,
  canvasRuntimeRefsModule,
}: {
  canvasProjectActionBindings: ReturnType<
    typeof createCanvasProjectActionBindings
  >;
  routeCanvasId: string | undefined;
  canvasProjectStateModule: ReturnType<typeof useCanvasProjectState>;
  forceFreshCanvasEntry: boolean;
  location: import("react-router-dom").Location<any>;
  canvasRuntimeRefsModule: ReturnType<typeof useCanvasRuntimeRefs>;
}) {
  useCanvasRouteInvalidation(
    () => ({
      invalidateCanvasPersistenceContext:
        canvasProjectActionBindings.invalidateCanvasPersistenceContext,
    }),
    [
      routeCanvasId,
      canvasProjectStateModule.routeProjectContextId,
      forceFreshCanvasEntry,
      location.pathname,
      location.search,
    ],
  );
  useCanvasRuntimeCleanup(
    () => ({
      generationSessionRef: canvasRuntimeRefsModule.generationSessionRef,
      abortCanvasNodeUploads: canvasRuntimeRefsModule.abortCanvasNodeUploads,
      clearCanvasNodeTimers: canvasRuntimeRefsModule.clearCanvasNodeTimers,
    }),
    [
      canvasRuntimeRefsModule.abortCanvasNodeUploads,
      canvasRuntimeRefsModule.clearCanvasNodeTimers,
    ],
  );
}
