import type * as React from "react";
import type * as Router from "react-router-dom";
import { CanvasViewportEmptyNotice } from "./CanvasViewportEmptyNotice";
import { CanvasMiniMapPopover } from "./CanvasMiniMapPopover";
import { CanvasAssetManagerToggle } from "./CanvasAssetManagerToggle";
import { CanvasMainToolbar } from "./CanvasMainToolbar";
import { CanvasZoomToolbar } from "./CanvasZoomToolbar";
import { CanvasArrangeConfirmPopover } from "./CanvasArrangeConfirmPopover";
import { type AssetManagerTab, type ViewportState, type HistoryAssetItem, type CreationMenuState, type ArrangeSnapshot } from "./canvasDataTypes";

export interface CanvasPageToolbarsProps {
  viewportMissingContent: boolean;
  returnToCanvasContent: () => void;
  studioChrome: boolean;
  assetManagerOpen: boolean;
  toggleAssetManager: () => void;
  canvasPointerMode: "select" | "hand";
  gridSnapEnabled: boolean;
  viewport: ViewportState;
  arrangeConfirmOpen: boolean;
  arrangeSnapshot: ArrangeSnapshot | null;
  restoreArrangeSnapshot: () => void;
  keepArrangeResult: () => void;
  arrangeCanvasLeftPreview: () => void;
  setCanvasPointerMode: React.Dispatch<React.SetStateAction<"select" | "hand">>;
  setStatus: React.Dispatch<React.SetStateAction<string>>;
  setGridSnapEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  toggleZoomMode: () => void;
  miniMapOpen: boolean;
  miniMapDragging: boolean;
  setMiniMapOpen: React.Dispatch<React.SetStateAction<boolean>>;
  renderMiniMapSurface: (className: string) => React.JSX.Element;
  creationMenu: CreationMenuState;
  workflowTemplatesAvailable: boolean;
  workflowPanelOpen: boolean;
  assetManagerTab: AssetManagerTab;
  historyPanelOpen: boolean;
  shortcutPanelOpen: boolean;
  pendingHistoryItems: HistoryAssetItem[];
  openSidebarMenu: () => void;
  closeCreationMenu: () => void;
  setHistoryPanelOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setShortcutPanelOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setWorkflowPanelOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setAssetManagerOpen: React.Dispatch<React.SetStateAction<boolean>>;
  selectAssetManagerTab: (nextTab: AssetManagerTab, moveFocus?: boolean) => void;
  loadHistoryItems: () => Promise<void>;
}
export function CanvasPageToolbars({
  viewportMissingContent,
  returnToCanvasContent,
  studioChrome,
  assetManagerOpen,
  toggleAssetManager,
  canvasPointerMode,
  gridSnapEnabled,
  viewport,
  arrangeConfirmOpen,
  arrangeSnapshot,
  restoreArrangeSnapshot,
  keepArrangeResult,
  arrangeCanvasLeftPreview,
  setCanvasPointerMode,
  setStatus,
  setGridSnapEnabled,
  toggleZoomMode,
  miniMapOpen,
  miniMapDragging,
  setMiniMapOpen,
  renderMiniMapSurface,
  creationMenu,
  workflowTemplatesAvailable,
  workflowPanelOpen,
  assetManagerTab,
  historyPanelOpen,
  shortcutPanelOpen,
  pendingHistoryItems,
  openSidebarMenu,
  closeCreationMenu,
  setHistoryPanelOpen,
  setShortcutPanelOpen,
  setWorkflowPanelOpen,
  setAssetManagerOpen,
  selectAssetManagerTab,
  loadHistoryItems,
}: CanvasPageToolbarsProps) {
  return <>
{viewportMissingContent ? (
        <CanvasViewportEmptyNotice onReturn={returnToCanvasContent} />
      ) : null}

      <div data-bottom-shell className="canvas-adaptive-left canvas-bottom-left-tools absolute bottom-4 left-4 z-[70] flex items-center gap-2">
        {!studioChrome ? <CanvasAssetManagerToggle open={assetManagerOpen} onToggle={toggleAssetManager} /> : null}
        <CanvasZoomToolbar
          studioChrome={studioChrome}
          canvasPointerMode={canvasPointerMode}
          gridSnapEnabled={gridSnapEnabled}
          zoomPercent={Math.round(viewport.scale * 100)}
          arrangeConfirmOpen={arrangeConfirmOpen}
          arrangeConfirm={<CanvasArrangeConfirmPopover snapshot={arrangeSnapshot} onRestore={restoreArrangeSnapshot} onKeep={keepArrangeResult} />}
          onArrange={arrangeCanvasLeftPreview}
          onTogglePointerMode={() => {
            setCanvasPointerMode((mode) => (mode === "select" ? "hand" : "select"));
            setStatus(canvasPointerMode === "select" ? "已切换为抓手，拖动画布" : "已切换为框选，拖动可框选节点");
          }}
          onToggleGridSnap={() => {
            const next = !gridSnapEnabled;
            setGridSnapEnabled(next);
            setStatus(next ? "节点吸附已开启" : "自由拖动已开启");
          }}
          onToggleZoom={toggleZoomMode}
          miniMap={!studioChrome ? <CanvasMiniMapPopover open={miniMapOpen} dragging={miniMapDragging} onOpen={() => setMiniMapOpen(true)} onFocus={() => setMiniMapOpen(true)} onClose={() => setMiniMapOpen(false)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null) && !miniMapDragging) setMiniMapOpen(false); }} renderSurface={() => renderMiniMapSurface("h-[142px] w-[208px] rounded-[12px]")} /> : null}
        />
      </div>

      <div data-bottom-shell className="canvas-adaptive-center absolute bottom-4 left-1/2 z-[70] -translate-x-1/2">
        <CanvasMainToolbar creationOpen={creationMenu.open} workflowAvailable={workflowTemplatesAvailable} workflowOpen={workflowPanelOpen} assetOpen={assetManagerOpen && assetManagerTab === "asset"} historyOpen={historyPanelOpen} shortcutOpen={shortcutPanelOpen} pendingHistoryCount={pendingHistoryItems.length} onCreation={openSidebarMenu} onWorkflow={() => { closeCreationMenu(); setHistoryPanelOpen(false); setShortcutPanelOpen(false); setWorkflowPanelOpen((prev) => !prev); }} onAsset={() => { closeCreationMenu(); setWorkflowPanelOpen(false); setHistoryPanelOpen(false); setShortcutPanelOpen(false); setAssetManagerOpen(true); selectAssetManagerTab("asset"); }} onHistory={() => { closeCreationMenu(); setWorkflowPanelOpen(false); setShortcutPanelOpen(false); setHistoryPanelOpen((prev) => !prev); if (!historyPanelOpen) void loadHistoryItems(); }} onShortcut={() => { closeCreationMenu(); setWorkflowPanelOpen(false); setHistoryPanelOpen(false); setShortcutPanelOpen((prev) => !prev); }} />

      </div>
</>;
}
