import type * as React from "react";
import type * as Router from "react-router-dom";
import { buildCanvasShortcutSections } from "./canvasShortcutViewModel";
import { CANVAS_ASSET_DRAG_MIME } from "./canvasPageConstants";
import { createCanvasHistoryPanel } from "./CanvasHistoryPanel";
import { createCanvasAssetManager } from "./CanvasAssetManager";
import { CanvasShortcutPanel } from "./CanvasShortcutPanel";
import { CanvasHistoryPreviewDialog } from "./CanvasHistoryPreviewDialog";
import { type AssetManagerTab, type ViewportState, type NodeData, type GroupData, type ProjectListItem, type HistoryAssetItem, type CanvasMetaState } from "./canvasDataTypes";
import { api } from "@/lib/api";
import { type AssetCatalogItem } from "@/features/assets/assetCatalog";

export interface CanvasPageLibraryPanelsProps {
  historyPanelOpen: boolean;
  loadHistoryItems: () => Promise<void>;
  historyLoading: boolean;
  setHistoryPanelOpen: React.Dispatch<React.SetStateAction<boolean>>;
  historyItemsWithPending: HistoryAssetItem[];
  historyTab: "image" | "video" | "audio";
  setHistoryTab: React.Dispatch<React.SetStateAction<"image" | "video" | "audio">>;
  setHistoryPreviewItem: React.Dispatch<React.SetStateAction<HistoryAssetItem | null>>;
  pendingElapsedLabel: (nodeId: string) => string;
  canDelete: boolean;
  deleteHistoryItem: (item: HistoryAssetItem) => Promise<void>;
  addHistoryItemToCanvas: (item: HistoryAssetItem) => void;
  downloadHistoryItem: (item: HistoryAssetItem) => void;
  historyPreviewItem: HistoryAssetItem | null;
  shortcutPanelOpen: boolean;
  setShortcutPanelOpen: React.Dispatch<React.SetStateAction<boolean>>;
  assetManagerOpen: boolean;
  studioChrome: boolean;
  navigate: Router.NavigateFunction;
  setAssetManagerOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setOpenNodeMenuId: React.Dispatch<React.SetStateAction<string | null>>;
  cancelSidebarRename: () => void;
  currentProject: ProjectListItem | null;
  canvasMeta: CanvasMetaState;
  assetManagerTab: AssetManagerTab;
  handleAssetManagerTabKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
  selectAssetManagerTab: (nextTab: AssetManagerTab, moveFocus?: boolean) => void;
  canvasNodeSearch: string;
  setCanvasNodeSearch: React.Dispatch<React.SetStateAction<string>>;
  openCreatePortraitAssetModal: () => void;
  projectAssetCatalogError: import("@/api/http").ApiErrorView | null;
  canvasAssetsError: string;
  filteredCanvasNodes: NodeData[];
  sidebarGroups: { group: GroupData; nodes: NodeData[]; }[];
  nodes: NodeData[];
  renderCanvasSidebarNodeItem: (node: NodeData, nested?: boolean) => React.JSX.Element;
  sidebarUngroupedNodes: NodeData[];
  filteredAssetEntries: AssetCatalogItem[];
  projectAssetCatalogLoading: boolean;
  canvasAssetsLoading: boolean;
  effectiveAssetProjectId: number | null;
  setStatus: React.Dispatch<React.SetStateAction<string>>;
  applyAssetCatalogItem: (item: AssetCatalogItem, targetWorld?: { x: number; y: number; }) => void;
  renderMiniMapSurface: (className: string) => React.JSX.Element;
  zoomCanvasBy: (factor: number) => void;
  viewport: ViewportState;
  toggleZoomMode: () => void;
  assetCatalogEntries: AssetCatalogItem[];
}
export function CanvasPageLibraryPanels({
  historyPanelOpen,
  loadHistoryItems,
  historyLoading,
  setHistoryPanelOpen,
  historyItemsWithPending,
  historyTab,
  setHistoryTab,
  setHistoryPreviewItem,
  pendingElapsedLabel,
  canDelete,
  deleteHistoryItem,
  addHistoryItemToCanvas,
  downloadHistoryItem,
  historyPreviewItem,
  shortcutPanelOpen,
  setShortcutPanelOpen,
  assetManagerOpen,
  studioChrome,
  navigate,
  setAssetManagerOpen,
  setOpenNodeMenuId,
  cancelSidebarRename,
  currentProject,
  canvasMeta,
  assetManagerTab,
  handleAssetManagerTabKeyDown,
  selectAssetManagerTab,
  canvasNodeSearch,
  setCanvasNodeSearch,
  openCreatePortraitAssetModal,
  projectAssetCatalogError,
  canvasAssetsError,
  filteredCanvasNodes,
  sidebarGroups,
  nodes,
  renderCanvasSidebarNodeItem,
  sidebarUngroupedNodes,
  filteredAssetEntries,
  projectAssetCatalogLoading,
  canvasAssetsLoading,
  effectiveAssetProjectId,
  setStatus,
  applyAssetCatalogItem,
  renderMiniMapSurface,
  zoomCanvasBy,
  viewport,
  toggleZoomMode,
  assetCatalogEntries,
}: CanvasPageLibraryPanelsProps) {
  return <>
{createCanvasHistoryPanel({
      historyPanelOpen,
      loadHistoryItems,
      historyLoading,
      setHistoryPanelOpen,
      historyItemsWithPending,
      historyTab,
      setHistoryTab,
      setHistoryPreviewItem,
      pendingElapsedLabel,
      canDelete,
      deleteHistoryItem,
      addHistoryItemToCanvas,
      downloadHistoryItem,
    })()}

      {historyPreviewItem ? (
        <CanvasHistoryPreviewDialog item={historyPreviewItem} onClose={() => setHistoryPreviewItem(null)} />
      ) : null}

      {shortcutPanelOpen ? (
        <CanvasShortcutPanel
          sections={buildCanvasShortcutSections(/Mac|iPhone|iPod|iPad/i.test(navigator.platform))}
          onClose={() => setShortcutPanelOpen(false)}
        />
      ) : null}

      {createCanvasAssetManager({
      assetManagerOpen,
      studioChrome,
      navigate,
      setAssetManagerOpen,
      setOpenNodeMenuId,
      cancelSidebarRename,
      currentProject,
      canvasMeta,
      assetManagerTab,
      handleAssetManagerTabKeyDown,
      selectAssetManagerTab,
      canvasNodeSearch,
      setCanvasNodeSearch,
      openCreatePortraitAssetModal,
      projectAssetCatalogError,
      canvasAssetsError,
      filteredCanvasNodes,
      sidebarGroups,
      nodes,
      renderCanvasSidebarNodeItem,
      sidebarUngroupedNodes,
      filteredAssetEntries,
      projectAssetCatalogLoading,
      canvasAssetsLoading,
      effectiveAssetProjectId,
      CANVAS_ASSET_DRAG_MIME,
      setStatus,
      applyAssetCatalogItem,
      renderMiniMapSurface,
      zoomCanvasBy,
      viewport,
      toggleZoomMode,
      assetCatalogEntries,
    })()}
</>;
}
