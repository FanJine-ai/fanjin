import { createCanvasGenerationActionBindings } from "./canvasGenerationActionBindings";
import { LAST_ACTIVE_CANVAS_KEY } from "./canvasPageConstants";
import { createCanvasProjectActionBindings } from "./canvasProjectActionBindings";
import { useCanvasLibraryView } from "./useCanvasLibraryView";
import { useCanvasProjectBrowserEntry } from "./useCanvasPanelLifecycle";
import {
  useCanvasExternalSync,
  useCanvasHydration,
} from "./useCanvasPersistenceLifecycle";
import { useCanvasProjectState } from "./useCanvasProjectState";
import { useCanvasPromptState } from "./useCanvasPromptState";
import { useCanvasRuntimeRefs } from "./useCanvasRuntimeRefs";
import { useCanvasSelectionState } from "./useCanvasSelectionState";
export function useCanvasHydrationEffects({
  canvasRuntimeRefsModule,
  canvasSelectionStateModule,
  canvasGenerationActionBindings,
  routeCanvasId,
  searchParams,
  forceFreshCanvasEntry,
  canvasMeta,
  location,
  setCanvasMeta,
  canvasProjectActionBindings,
  canvasProjectStateModule,
  canvasLibraryViewModule,
  navigate,
  canvasPromptStateModule,
  openProjectBrowserOnEntry,
}: {
  canvasRuntimeRefsModule: ReturnType<typeof useCanvasRuntimeRefs>;
  canvasSelectionStateModule: ReturnType<typeof useCanvasSelectionState>;
  canvasGenerationActionBindings: ReturnType<
    typeof createCanvasGenerationActionBindings
  >;
  routeCanvasId: string | undefined;
  searchParams: URLSearchParams;
  forceFreshCanvasEntry: boolean;
  canvasMeta: import("@/pages/fjtv/canvasDataTypes").CanvasMetaState;
  location: import("react-router-dom").Location<any>;
  setCanvasMeta: React.Dispatch<
    React.SetStateAction<import("@/pages/fjtv/canvasDataTypes").CanvasMetaState>
  >;
  canvasProjectActionBindings: ReturnType<
    typeof createCanvasProjectActionBindings
  >;
  canvasProjectStateModule: ReturnType<typeof useCanvasProjectState>;
  canvasLibraryViewModule: ReturnType<typeof useCanvasLibraryView>;
  navigate: import("react-router-dom").NavigateFunction;
  canvasPromptStateModule: ReturnType<typeof useCanvasPromptState>;
  openProjectBrowserOnEntry: boolean;
}) {
  useCanvasHydration(
    () => ({
      canvasServerRevisionRef: canvasRuntimeRefsModule.canvasServerRevisionRef,
      canvasConflictRef: canvasRuntimeRefsModule.canvasConflictRef,
      setCanvasConflict: canvasSelectionStateModule.setCanvasConflict,
      ensureApiKeyReady: canvasGenerationActionBindings.ensureApiKeyReady,
      LAST_ACTIVE_CANVAS_KEY,
      routeCanvasId,
      searchParams,
      forceFreshCanvasEntry,
      canvasMeta,
      location,
      setCanvasMeta,
      hydratedRef: canvasRuntimeRefsModule.hydratedRef,
      replaceCanvasFromServer:
        canvasProjectActionBindings.replaceCanvasFromServer,
      resetCanvasRuntimeState:
        canvasProjectActionBindings.resetCanvasRuntimeState,
      routeProjectContextId: canvasProjectStateModule.routeProjectContextId,
      setCurrentProjectId: canvasProjectStateModule.setCurrentProjectId,
      currentProject: canvasLibraryViewModule.currentProject,
      clearEntryQueryFlags: canvasProjectActionBindings.clearEntryQueryFlags,
      navigate,
      setCanvasSaveState: canvasSelectionStateModule.setCanvasSaveState,
      setStatus: canvasPromptStateModule.setStatus,
    }),
    [routeCanvasId, forceFreshCanvasEntry, location.pathname, location.search],
  );
  useCanvasExternalSync(
    () => ({
      canvasMeta,
      canvasServerRevisionRef: canvasRuntimeRefsModule.canvasServerRevisionRef,
      setCanvasSaveState: canvasSelectionStateModule.setCanvasSaveState,
      setStatus: canvasPromptStateModule.setStatus,
      canvasSaveState: canvasSelectionStateModule.canvasSaveState,
      saveTimerRef: canvasRuntimeRefsModule.saveTimerRef,
      canvasConflictRef: canvasRuntimeRefsModule.canvasConflictRef,
      setCanvasConflict: canvasSelectionStateModule.setCanvasConflict,
      suppressNextAutoSaveRef: canvasRuntimeRefsModule.suppressNextAutoSaveRef,
      replaceCanvasFromServer:
        canvasProjectActionBindings.replaceCanvasFromServer,
      setCanvasSavedAt: canvasSelectionStateModule.setCanvasSavedAt,
      mergeExternalCanvasSnapshot:
        canvasProjectActionBindings.mergeExternalCanvasSnapshot,
    }),
    [
      canvasMeta.canvasId,
      canvasMeta.ready,
      canvasMeta.loading,
      canvasSelectionStateModule.canvasSaveState,
    ],
  );
  useCanvasProjectBrowserEntry(
    () => ({
      openProjectBrowserOnEntry,
      setProjectBrowserOpen: canvasProjectStateModule.setProjectBrowserOpen,
      setProjectMenuOpen: canvasProjectStateModule.setProjectMenuOpen,
      setCanvasSwitcherOpen: canvasProjectStateModule.setCanvasSwitcherOpen,
      clearEntryQueryFlags: canvasProjectActionBindings.clearEntryQueryFlags,
    }),
    [openProjectBrowserOnEntry],
  );
}
