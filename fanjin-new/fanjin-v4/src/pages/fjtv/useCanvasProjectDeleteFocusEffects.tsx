import {
  useCanvasCancelGenerationFocus,
  useCanvasProjectDeleteFocus,
} from "./useCanvasPanelLifecycle";
import { useCanvasProjectState } from "./useCanvasProjectState";
export function useCanvasProjectDeleteFocusEffects({
  canvasProjectStateModule,
}: {
  canvasProjectStateModule: ReturnType<typeof useCanvasProjectState>;
}) {
  useCanvasProjectDeleteFocus(
    () => ({
      projectDeleteConfirmId: canvasProjectStateModule.projectDeleteConfirmId,
      projectDeleteCancelRef: canvasProjectStateModule.projectDeleteCancelRef,
    }),
    [canvasProjectStateModule.projectDeleteConfirmId],
  );
  useCanvasCancelGenerationFocus(
    () => ({
      cancelGenerationConfirmNodeId:
        canvasProjectStateModule.cancelGenerationConfirmNodeId,
      cancelGenerationReturnRef:
        canvasProjectStateModule.cancelGenerationReturnRef,
    }),
    [canvasProjectStateModule.cancelGenerationConfirmNodeId],
  );
}
