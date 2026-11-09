import { useCanvasAssetPanelState } from "./useCanvasAssetPanelState";
import {
  useCanvasAssetManagerCloseRequest,
  useCanvasAssetManagerNotification,
  useCanvasAssetManagerToggleRequest,
} from "./useCanvasPanelLifecycle";
export function useCanvasAssetManagerNotificationEffects({
  onAssetManagerOpenChange,
  canvasAssetPanelStateModule,
  assetManagerCloseRequest,
  assetManagerToggleRequest,
}: {
  onAssetManagerOpenChange: ((open: boolean) => void) | undefined;
  canvasAssetPanelStateModule: ReturnType<typeof useCanvasAssetPanelState>;
  assetManagerCloseRequest: number;
  assetManagerToggleRequest: number;
}) {
  useCanvasAssetManagerNotification(
    () => ({
      onAssetManagerOpenChange,
      assetManagerOpen: canvasAssetPanelStateModule.assetManagerOpen,
    }),
    [canvasAssetPanelStateModule.assetManagerOpen, onAssetManagerOpenChange],
  );
  useCanvasAssetManagerCloseRequest(
    () => ({
      assetManagerCloseRequest,
      previousAssetManagerCloseRequestRef:
        canvasAssetPanelStateModule.previousAssetManagerCloseRequestRef,
      setOpenNodeMenuId: canvasAssetPanelStateModule.setOpenNodeMenuId,
      setSidebarRenamingNodeId:
        canvasAssetPanelStateModule.setSidebarRenamingNodeId,
      setAssetManagerOpen: canvasAssetPanelStateModule.setAssetManagerOpen,
    }),
    [assetManagerCloseRequest],
  );
  useCanvasAssetManagerToggleRequest(
    () => ({
      assetManagerToggleRequest,
      previousAssetManagerToggleRequestRef:
        canvasAssetPanelStateModule.previousAssetManagerToggleRequestRef,
      setOpenNodeMenuId: canvasAssetPanelStateModule.setOpenNodeMenuId,
      setSidebarRenamingNodeId:
        canvasAssetPanelStateModule.setSidebarRenamingNodeId,
      selectAssetManagerTab: canvasAssetPanelStateModule.selectAssetManagerTab,
      setAssetManagerOpen: canvasAssetPanelStateModule.setAssetManagerOpen,
    }),
    [
      assetManagerToggleRequest,
      canvasAssetPanelStateModule.selectAssetManagerTab,
    ],
  );
}
