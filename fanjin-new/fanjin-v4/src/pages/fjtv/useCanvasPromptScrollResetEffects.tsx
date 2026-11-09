import { createCanvasProjectActionBindings } from "./canvasProjectActionBindings";
import { useCanvasPublicationRefresh } from "./useCanvasPanelLifecycle";
import { useCanvasProjectRenameState } from "./useCanvasProjectRenameState";
import { useCanvasProjectState } from "./useCanvasProjectState";
import {
  useCanvasPromptFocus,
  useCanvasPromptScrollReset,
} from "./useCanvasPromptLifecycle";
import { useCanvasPromptState } from "./useCanvasPromptState";
import { useCanvasRuntimeRefs } from "./useCanvasRuntimeRefs";
import { useCanvasSelectionState } from "./useCanvasSelectionState";
import { useCanvasTitleEditorState } from "./useCanvasTitleEditorState";
export function useCanvasPromptScrollResetEffects({
  canvasTitleEditorStateModule,
  canvasSelectionStateModule,
  canvasPromptStateModule,
  activeNode,
  canvasRuntimeRefsModule,
  canvasProjectRenameStateModule,
  canvasProjectActionBindings,
  canvasMeta,
  canvasProjectStateModule,
}: {
  canvasTitleEditorStateModule: ReturnType<typeof useCanvasTitleEditorState>;
  canvasSelectionStateModule: ReturnType<typeof useCanvasSelectionState>;
  canvasPromptStateModule: ReturnType<typeof useCanvasPromptState>;
  activeNode: import("@/pages/fjtv/canvasDataTypes").NodeData | null;
  canvasRuntimeRefsModule: ReturnType<typeof useCanvasRuntimeRefs>;
  canvasProjectRenameStateModule: ReturnType<
    typeof useCanvasProjectRenameState
  >;
  canvasProjectActionBindings: ReturnType<
    typeof createCanvasProjectActionBindings
  >;
  canvasMeta: import("@/pages/fjtv/canvasDataTypes").CanvasMetaState;
  canvasProjectStateModule: ReturnType<typeof useCanvasProjectState>;
}) {
  useCanvasPromptScrollReset(
    () => ({
      setPromptEditorScroll: canvasTitleEditorStateModule.setPromptEditorScroll,
    }),
    [canvasSelectionStateModule.activeNodeId, canvasPromptStateModule.expanded],
  );
  useCanvasPromptFocus(
    () => ({
      expanded: canvasPromptStateModule.expanded,
      activeNode,
      promptTextareaRef: canvasRuntimeRefsModule.promptTextareaRef,
    }),
    [canvasPromptStateModule.expanded, activeNode?.id],
  );
  useCanvasPublicationRefresh(
    () => ({
      canvasShareOverlay: canvasProjectRenameStateModule.canvasShareOverlay,
      refreshCanvasPublications:
        canvasProjectActionBindings.refreshCanvasPublications,
    }),
    [
      canvasProjectRenameStateModule.canvasShareOverlay,
      canvasMeta.canvasId,
      canvasMeta.revision,
      canvasProjectStateModule.activeProjectContextId,
    ],
  );
}
