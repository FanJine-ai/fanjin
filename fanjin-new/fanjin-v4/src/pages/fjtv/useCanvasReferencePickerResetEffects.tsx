import { useCanvasGraphState } from "./useCanvasGraphState";
import { useCanvasReferencePickerReset } from "./useCanvasPromptLifecycle";
import { useCanvasPromptState } from "./useCanvasPromptState";
import { useCanvasRuntimeRefs } from "./useCanvasRuntimeRefs";
import { useCanvasSelectionState } from "./useCanvasSelectionState";
import { useCanvasVisibleResize } from "./useCanvasViewportLifecycle";
export function useCanvasReferencePickerResetEffects({
  canvasPromptStateModule,
  canvasRuntimeRefsModule,
  canvasSelectionStateModule,
  canvasGraphStateModule,
}: {
  canvasPromptStateModule: ReturnType<typeof useCanvasPromptState>;
  canvasRuntimeRefsModule: ReturnType<typeof useCanvasRuntimeRefs>;
  canvasSelectionStateModule: ReturnType<typeof useCanvasSelectionState>;
  canvasGraphStateModule: ReturnType<typeof useCanvasGraphState>;
}) {
  useCanvasReferencePickerReset(
    () => ({
      setReferencePickerOpen: canvasPromptStateModule.setReferencePickerOpen,
      promptSelectionRef: canvasRuntimeRefsModule.promptSelectionRef,
    }),
    [canvasSelectionStateModule.activeNodeId, canvasPromptStateModule.expanded],
  );
  useCanvasVisibleResize(
    () => ({
      setCanvasRenderTick: canvasGraphStateModule.setCanvasRenderTick,
      canvasInteractionTimerRef:
        canvasGraphStateModule.canvasInteractionTimerRef,
    }),
    [],
  );
}
