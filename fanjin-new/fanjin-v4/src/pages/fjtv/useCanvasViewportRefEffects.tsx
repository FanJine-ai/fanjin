import { createCanvasGenerationActionBindings } from "./canvasGenerationActionBindings";
import { createCanvasGraphActionBindings } from "./canvasGraphActionBindings";
import {
  getDefaultVideoPromptTab,
  getVideoModeForTab,
  getVideoTabForMode,
  isVideoPromptTabEnabled,
} from "./canvasModelDefinitions";
import { createCanvasProjectActionBindings } from "./canvasProjectActionBindings";
import { useCanvasActiveModelView } from "./useCanvasActiveModelView";
import { useCanvasFloatingMenuPlacement } from "./useCanvasFloatingMenuPlacement";
import { useCanvasPendingTaskRecovery } from "./useCanvasGenerationLifecycle";
import { useCanvasGraphState } from "./useCanvasGraphState";
import { useCanvasImageEditorState } from "./useCanvasImageEditorState";
import { useCanvasHistoryLoading } from "./useCanvasPanelLifecycle";
import { useCanvasViewportRef } from "./useCanvasPersistenceLifecycle";
import { useCanvasProjectRenameState } from "./useCanvasProjectRenameState";
import {
  useCanvasNodeEditorReset,
  useCanvasVideoPromptTab,
} from "./useCanvasPromptLifecycle";
import { useCanvasPromptState } from "./useCanvasPromptState";
import { useCanvasRuntimeRefs } from "./useCanvasRuntimeRefs";
import { useCanvasSelectionState } from "./useCanvasSelectionState";
import { useCanvasVideoEditorState } from "./useCanvasVideoEditorState";
import {
  useCanvasNativeWheel,
  useCanvasWheelCleanup,
} from "./useCanvasViewportLifecycle";
export function useCanvasViewportRefEffects({
  canvasGraphStateModule,
  canvasPromptStateModule,
  canvasVideoEditorStateModule,
  canvasImageEditorStateModule,
  canvasSelectionStateModule,
  canvasRuntimeRefsModule,
  canvasProjectRenameStateModule,
  activeNode,
  canvasActiveModelViewModule,
  activeNodeModelOption,
  canvasGraphActionBindings,
  canvasProjectActionBindings,
  canvasGenerationActionBindings,
}: {
  canvasGraphStateModule: ReturnType<typeof useCanvasGraphState>;
  canvasPromptStateModule: ReturnType<typeof useCanvasPromptState>;
  canvasVideoEditorStateModule: ReturnType<typeof useCanvasVideoEditorState>;
  canvasImageEditorStateModule: ReturnType<typeof useCanvasImageEditorState>;
  canvasSelectionStateModule: ReturnType<typeof useCanvasSelectionState>;
  canvasRuntimeRefsModule: ReturnType<typeof useCanvasRuntimeRefs>;
  canvasProjectRenameStateModule: ReturnType<
    typeof useCanvasProjectRenameState
  >;
  activeNode: import("@/pages/fjtv/canvasDataTypes").NodeData | null;
  canvasActiveModelViewModule: ReturnType<typeof useCanvasActiveModelView>;
  activeNodeModelOption: import("@/lib/api").AiModelOption | undefined;
  canvasGraphActionBindings: ReturnType<typeof createCanvasGraphActionBindings>;
  canvasProjectActionBindings: ReturnType<
    typeof createCanvasProjectActionBindings
  >;
  canvasGenerationActionBindings: ReturnType<
    typeof createCanvasGenerationActionBindings
  >;
}) {
  useCanvasViewportRef(
    () => ({
      viewportRef: canvasGraphStateModule.viewportRef,
      viewport: canvasGraphStateModule.viewport,
    }),
    [canvasGraphStateModule.viewport],
  );
  useCanvasWheelCleanup(
    () => ({ wheelPanFrameRef: canvasGraphStateModule.wheelPanFrameRef }),
    [],
  );
  useCanvasNodeEditorReset(
    () => ({
      setRatioOpen: canvasPromptStateModule.setRatioOpen,
      setModelOpen: canvasPromptStateModule.setModelOpen,
      setQuantityOpen: canvasPromptStateModule.setQuantityOpen,
      setCameraOpen: canvasPromptStateModule.setCameraOpen,
      setVideoSettingsOpen: canvasPromptStateModule.setVideoSettingsOpen,
      setVideoFrameMenuNodeId:
        canvasVideoEditorStateModule.setVideoFrameMenuNodeId,
      setImageNineGridMenuNodeId:
        canvasImageEditorStateModule.setImageNineGridMenuNodeId,
      setImageGridMenuNodeId:
        canvasImageEditorStateModule.setImageGridMenuNodeId,
      setImageGridCustomMenuNodeId:
        canvasImageEditorStateModule.setImageGridCustomMenuNodeId,
      setImageGridCustomPreview:
        canvasImageEditorStateModule.setImageGridCustomPreview,
      setExpanded: canvasPromptStateModule.setExpanded,
      setMediaViewerNodeId: canvasPromptStateModule.setMediaViewerNodeId,
      setHoveredVideoPromptTab:
        canvasPromptStateModule.setHoveredVideoPromptTab,
    }),
    [canvasSelectionStateModule.activeNodeId],
  );
  useCanvasFloatingMenuPlacement(
    canvasRuntimeRefsModule.rootRef,
    Boolean(
      canvasPromptStateModule.videoSettingsOpen ||
      canvasPromptStateModule.modelOpen ||
      canvasProjectRenameStateModule.canvasShareOverlay !== null,
    ),
  );
  useCanvasVideoPromptTab(
    () => ({
      activeNode,
      getDefaultVideoPromptTab,
      activeNodeVideoReferenceSummary:
        canvasActiveModelViewModule.activeNodeVideoReferenceSummary,
      activeNodeModelOption,
      getVideoTabForMode,
      isVideoPromptTabEnabled,
      videoPromptTab: canvasPromptStateModule.videoPromptTab,
      setVideoPromptTab: canvasPromptStateModule.setVideoPromptTab,
      getVideoModeForTab,
      setNodePatch: canvasGraphActionBindings.setNodePatch,
    }),
    [
      activeNode?.id,
      activeNode?.model,
      activeNode?.type,
      activeNode?.videoMode,
      canvasActiveModelViewModule.activeNodeVideoReferenceSummary,
      activeNodeModelOption,
      canvasPromptStateModule.videoPromptTab,
    ],
  );
  useCanvasNativeWheel(
    () => ({ rootRef: canvasRuntimeRefsModule.rootRef }),
    [],
  );
  useCanvasHistoryLoading(
    () => ({
      historyPanelOpen: canvasProjectRenameStateModule.historyPanelOpen,
      loadHistoryItems: canvasProjectActionBindings.loadHistoryItems,
    }),
    [canvasProjectRenameStateModule.historyPanelOpen],
  );
  useCanvasPendingTaskRecovery(
    () => ({
      nodes: canvasGraphStateModule.nodes,
      generationSessionRef: canvasRuntimeRefsModule.generationSessionRef,
      resumedFailedQueriesRef: canvasRuntimeRefsModule.resumedFailedQueriesRef,
      beginNodeGenerationSession:
        canvasGenerationActionBindings.beginNodeGenerationSession,
      pollTaskUntilDone: canvasGenerationActionBindings.pollTaskUntilDone,
    }),
    [canvasGraphStateModule.nodes],
  );
}
