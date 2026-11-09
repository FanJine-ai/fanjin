import { useCanvasGroupState } from "./useCanvasGroupState";
import {
  useCanvasGroupExecutionFocus,
  useCanvasShareFocus,
} from "./useCanvasPanelLifecycle";
import { useCanvasProjectRenameState } from "./useCanvasProjectRenameState";
export function useCanvasShareFocusEffects({
  canvasProjectRenameStateModule,
  canvasGroupStateModule,
}: {
  canvasProjectRenameStateModule: ReturnType<
    typeof useCanvasProjectRenameState
  >;
  canvasGroupStateModule: ReturnType<typeof useCanvasGroupState>;
}) {
  useCanvasShareFocus(
    () => ({
      canvasShareOverlay: canvasProjectRenameStateModule.canvasShareOverlay,
      canvasSharePopoverRef:
        canvasProjectRenameStateModule.canvasSharePopoverRef,
    }),
    [canvasProjectRenameStateModule.canvasShareOverlay],
  );
  useCanvasGroupExecutionFocus(
    () => ({
      groupExecutionDialog: canvasGroupStateModule.groupExecutionDialog,
      groupExecutionCancelRef: canvasGroupStateModule.groupExecutionCancelRef,
    }),
    [canvasGroupStateModule.groupExecutionDialog],
  );
}
