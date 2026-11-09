import { createCanvasProjectActionBindings } from "./canvasProjectActionBindings";
import { useCanvasAutosaveSnapshot } from "./useCanvasAutosaveSnapshot";
import { useCanvasConnectionState } from "./useCanvasConnectionState";
import { useCanvasGraphState } from "./useCanvasGraphState";
import { useCanvasGroupState } from "./useCanvasGroupState";
import {
  useCanvasAutoSave,
  useCanvasHistoryCapture,
} from "./useCanvasPersistenceLifecycle";
import { useCanvasProjectState } from "./useCanvasProjectState";
import { useCanvasRuntimeRefs } from "./useCanvasRuntimeRefs";
import { useCanvasSelectionState } from "./useCanvasSelectionState";
export function useCanvasSaveHistoryEffects({
  canvasRuntimeRefsModule,
  canvasMeta,
  readOnlyProofMode,
  studioChrome,
  canvasSelectionStateModule,
  canvasAutosaveSnapshotModule,
  canvasProjectActionBindings,
  canvasProjectStateModule,
  canvasConnectionStateModule,
  canvasGraphStateModule,
  canvasGroupStateModule,
}: {
  canvasRuntimeRefsModule: ReturnType<typeof useCanvasRuntimeRefs>;
  canvasMeta: import("@/pages/fjtv/canvasDataTypes").CanvasMetaState;
  readOnlyProofMode: boolean;
  studioChrome: boolean;
  canvasSelectionStateModule: ReturnType<typeof useCanvasSelectionState>;
  canvasAutosaveSnapshotModule: ReturnType<typeof useCanvasAutosaveSnapshot>;
  canvasProjectActionBindings: ReturnType<
    typeof createCanvasProjectActionBindings
  >;
  canvasProjectStateModule: ReturnType<typeof useCanvasProjectState>;
  canvasConnectionStateModule: ReturnType<typeof useCanvasConnectionState>;
  canvasGraphStateModule: ReturnType<typeof useCanvasGraphState>;
  canvasGroupStateModule: ReturnType<typeof useCanvasGroupState>;
}) {
  useCanvasAutoSave(
    () => ({
      hydratedRef: canvasRuntimeRefsModule.hydratedRef,
      canvasMeta,
      readOnlyProofMode,
      suppressNextAutoSaveRef: canvasRuntimeRefsModule.suppressNextAutoSaveRef,
      canvasConflictRef: canvasRuntimeRefsModule.canvasConflictRef,
      studioChrome,
      saveTimerRef: canvasRuntimeRefsModule.saveTimerRef,
      saveRevisionRef: canvasRuntimeRefsModule.saveRevisionRef,
      setCanvasSaveState: canvasSelectionStateModule.setCanvasSaveState,
      canvasAutosaveSnapshotRef:
        canvasAutosaveSnapshotModule.canvasAutosaveSnapshotRef,
      persistCanvas: canvasProjectActionBindings.persistCanvas,
      setCanvasSavedAt: canvasSelectionStateModule.setCanvasSavedAt,
    }),
    [
      canvasAutosaveSnapshotModule.canvasAutosaveFingerprint,
      canvasMeta.canvasId,
      canvasMeta.name,
      canvasMeta.ready,
      canvasProjectStateModule.currentProjectId,
      studioChrome,
      readOnlyProofMode,
    ],
  );
  useCanvasHistoryCapture(
    () => ({
      hydratedRef: canvasRuntimeRefsModule.hydratedRef,
      canvasMeta,
      middlePanning: canvasSelectionStateModule.middlePanning,
      dragNode: canvasSelectionStateModule.dragNode,
      groupDrag: canvasSelectionStateModule.groupDrag,
      textResize: canvasSelectionStateModule.textResize,
      selectionBox: canvasSelectionStateModule.selectionBox,
      draftLine: canvasConnectionStateModule.draftLine,
      buildHistorySnapshot: canvasProjectActionBindings.buildHistorySnapshot,
      historyReadyRef: canvasRuntimeRefsModule.historyReadyRef,
      historyCurrentRef: canvasRuntimeRefsModule.historyCurrentRef,
      historyApplyingRef: canvasRuntimeRefsModule.historyApplyingRef,
      historyTimerRef: canvasRuntimeRefsModule.historyTimerRef,
      undoStackRef: canvasRuntimeRefsModule.undoStackRef,
      redoStackRef: canvasRuntimeRefsModule.redoStackRef,
    }),
    [
      canvasGraphStateModule.nodes,
      canvasGraphStateModule.edges,
      canvasGroupStateModule.groups,
      canvasMeta.ready,
      canvasSelectionStateModule.middlePanning.active,
      canvasSelectionStateModule.dragNode.active,
      canvasSelectionStateModule.groupDrag.active,
      canvasSelectionStateModule.textResize.active,
      canvasSelectionStateModule.selectionBox.active,
      canvasConnectionStateModule.draftLine,
    ],
  );
}
