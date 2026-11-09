import type { NavigateFunction } from "react-router-dom";
import type { ApiErrorView } from "@/api/http";
import type { Dispatch, SetStateAction, RefObject, ReactNode, JSX } from "react";
import type { AssetManagerTab, ViewportState, NodeData, GroupData, ProjectListItem, CanvasMetaState } from "./canvasDataTypes";
import ReferencePreviewImage from "@/features/quick-create/attachments/ReferencePreviewImage";
import { CANVAS_ASSET_MANAGER_WIDTH } from "./canvasAdaptiveLayout";
import { CanvasAssetManagerTools } from "./CanvasAssetManagerTools";
import { ChevronDown, Expand, FolderOpen, Image as ImageIcon, NotebookTabs, PanelLeftClose, UnfoldHorizontal, ZoomIn, ZoomOut } from "lucide-react";
import { type AssetCatalogItem } from "@/features/assets/assetCatalog";

export interface CanvasAssetManagerDependencies {
  assetManagerOpen: boolean;
  studioChrome: boolean;
  navigate: NavigateFunction;
  setAssetManagerOpen: Dispatch<SetStateAction<boolean>>;
  setOpenNodeMenuId: Dispatch<SetStateAction<string | null>>;
  cancelSidebarRename: () => void;
  currentProject: ProjectListItem | null;
  canvasMeta: CanvasMetaState;
  assetManagerTab: AssetManagerTab;
  handleAssetManagerTabKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
  selectAssetManagerTab: (nextTab: AssetManagerTab, moveFocus?: boolean) => void;
  canvasNodeSearch: string;
  setCanvasNodeSearch: Dispatch<SetStateAction<string>>;
  openCreatePortraitAssetModal: () => void;
  projectAssetCatalogError: ApiErrorView | null;
  canvasAssetsError: string;
  filteredCanvasNodes: NodeData[];
  sidebarGroups: { group: GroupData; nodes: NodeData[]; }[];
  nodes: NodeData[];
  renderCanvasSidebarNodeItem: (node: NodeData, nested?: boolean) => JSX.Element;
  sidebarUngroupedNodes: NodeData[];
  filteredAssetEntries: AssetCatalogItem[];
  projectAssetCatalogLoading: boolean;
  canvasAssetsLoading: boolean;
  effectiveAssetProjectId: number | null;
  CANVAS_ASSET_DRAG_MIME: "application/x-fanjin-canvas-asset";
  setStatus: Dispatch<SetStateAction<string>>;
  applyAssetCatalogItem: (item: AssetCatalogItem, targetWorld?: { x: number; y: number; }) => void;
  renderMiniMapSurface: (className: string) => JSX.Element;
  zoomCanvasBy: (factor: number) => void;
  viewport: ViewportState;
  toggleZoomMode: () => void;
  assetCatalogEntries: AssetCatalogItem[];
}

export function createCanvasAssetManager(deps: CanvasAssetManagerDependencies) {
  const {
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
  } = deps;
  function renderCanvasAssetManager() { return (assetManagerOpen ? (
        <aside
          id="project-studio-asset-manager"
          data-asset-manager
          aria-label="看板内容与资产"
          className={`absolute bottom-0 left-0 z-[72] border-r border-[#2f3136] bg-[#1b1b1d] ${studioChrome ? "top-[62px]" : "top-0"}`}
          style={{ width: CANVAS_ASSET_MANAGER_WIDTH }}
        >
          <div data-asset-manager-shell className="flex h-full flex-col">
            {!studioChrome ? <div data-asset-manager-header className="border-b border-[#2b3038] px-4 pb-3 pt-5">
              <div className="mb-4 flex items-center justify-between">
                <button data-asset-manager-brand type="button" onClick={() => navigate("/workbench/canvas/editor")} className="flex items-center gap-2 text-white">
                  <div data-asset-manager-brand-mark className="flex h-5 w-5 items-center justify-center rounded-[3px] bg-white text-black">
                    <UnfoldHorizontal className="h-3.5 w-3.5" />
                  </div>
                  <ChevronDown className="h-3.5 w-3.5 text-[#8f98a8]" />
                </button>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    setAssetManagerOpen(false);
                    setOpenNodeMenuId(null);
                    cancelSidebarRename();
                  }}
                  data-asset-manager-close
                  aria-label="关闭看板内容与资产栏"
                  className="rounded-lg p-1 text-[#8f98a8] transition hover:bg-[#232833] hover:text-white"
                >
                  <PanelLeftClose className="h-4 w-4" />
                </button>
              </div>
              <div data-asset-manager-breadcrumbs className="flex items-center gap-2 text-[15px] text-white">
                <span className="max-w-[104px] truncate">{currentProject?.name || canvasMeta.name}</span>
                <span className="text-[#8f98a8]">/</span>
                <span className="max-w-[104px] truncate">{canvasMeta.name}</span>
              </div>
            </div> : null}

            <div data-asset-manager-tabs className="border-b border-[#2b3038] px-2 py-2">
              <div className="flex items-center gap-1 rounded-[10px] bg-black/[0.08] p-1" role="tablist" aria-label="内容栏">
                <button
                  type="button"
                  id="project-studio-canvas-tab"
                  role="tab"
                  aria-selected={assetManagerTab === "canvas"}
                  aria-controls="project-studio-content-panel"
                  tabIndex={assetManagerTab === "canvas" ? 0 : -1}
                  onKeyDown={handleAssetManagerTabKeyDown}
                  onClick={() => selectAssetManagerTab("canvas")}
                  data-selected={assetManagerTab === "canvas" ? "true" : "false"}
                  className={`flex-1 rounded-[7px] border border-transparent px-2.5 py-1.5 text-[13px] font-medium transition ${
                    assetManagerTab === "canvas" ? "bg-[#3a3a3d] text-white" : "text-[#b2bac8] hover:bg-[#20252e]"
                  }`}
                >
                  画布
                </button>
                <button
                  type="button"
                  id="project-studio-assets-tab"
                  role="tab"
                  aria-selected={assetManagerTab === "asset"}
                  aria-controls="project-studio-content-panel"
                  tabIndex={assetManagerTab === "asset" ? 0 : -1}
                  onKeyDown={handleAssetManagerTabKeyDown}
                  onClick={() => selectAssetManagerTab("asset")}
                  data-selected={assetManagerTab === "asset" ? "true" : "false"}
                  className={`flex-1 rounded-[7px] border border-transparent px-2.5 py-1.5 text-[13px] font-medium transition ${
                    assetManagerTab === "asset" ? "bg-[#3a3a3d] text-white" : "text-[#b2bac8] hover:bg-[#20252e]"
                  }`}
                >
                  资产
                </button>
                {!studioChrome ? (
                  <span className="ml-auto rounded-lg p-1 text-[#cfd5df]" aria-hidden="true">
                    <NotebookTabs className="h-4 w-4" />
                  </span>
                ) : null}
              </div>
            </div>

            <CanvasAssetManagerTools
              activeTab={assetManagerTab}
              searchValue={canvasNodeSearch}
              onSearchValueChange={setCanvasNodeSearch}
              onCreatePortraitAsset={() => openCreatePortraitAssetModal()}
            />

            <div
              id="project-studio-content-panel"
              role="tabpanel"
              aria-labelledby={assetManagerTab === "canvas" ? "project-studio-canvas-tab" : "project-studio-assets-tab"}
              tabIndex={0}
              data-asset-manager-content
              className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-3 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#8ed5f6]/30"
            >
              {assetManagerTab === "asset" && (projectAssetCatalogError || canvasAssetsError) ? (
                <div data-canvas-alert className="mx-1 mb-3 rounded-xl border border-[#81504b] bg-[#321d1d] px-3 py-2 text-xs leading-5 text-[#f3b8b0]" role="alert">
                  {projectAssetCatalogError ? `项目资产读取失败：${projectAssetCatalogError.message}` : null}
                  {projectAssetCatalogError && canvasAssetsError ? <br /> : null}
                  {canvasAssetsError ? `看板资产读取失败：${canvasAssetsError}` : null}
                </div>
              ) : null}
              {assetManagerTab === "canvas" ? (
                filteredCanvasNodes.length === 0 ? (
                  <div data-asset-manager-empty className="px-2 py-7 text-sm text-[#9ca4b3]" role="status">当前画布没有内容</div>
                ) : (
                  <div className="space-y-1.5">
                    {sidebarGroups.map(({ group, nodes: groupNodes }) => (
                        <div key={group.id} data-canvas-sidebar-group className="rounded-xl border border-[#242a33] bg-[#171b21]/45 p-1.5">
                        <div data-canvas-sidebar-group-title className="mb-1 flex items-center gap-2 px-2 py-1 text-sm text-white/90">
                          <FolderOpen className="h-4 w-4 text-[#b8c1cf]" />
                          <span className="truncate">{`分组 ${group.nodeIds.length} 个节点`}</span>
                        </div>
                        <div className="space-y-1">
                          {groupNodes.map((node) => renderCanvasSidebarNodeItem(node, true))}
                        </div>
                      </div>
                    ))}
                    {sidebarUngroupedNodes.map((node) => renderCanvasSidebarNodeItem(node))}
                  </div>
                )
              ) : (
                filteredAssetEntries.length === 0 ? (
                  <div data-asset-manager-empty className="px-2 py-7 text-sm text-[#9ca4b3]" role="status">
                    {projectAssetCatalogLoading || canvasAssetsLoading
                      ? "正在读取项目资产..."
                      : projectAssetCatalogError || canvasAssetsError
                        ? "资产列表暂时不可用"
                        : effectiveAssetProjectId === null
                          ? "请先选择项目"
                          : "当前项目还没有资产"}
                  </div>
                ) : (
                  <div className="space-y-2">
                    {filteredAssetEntries.map((asset) => (
                      <div
                        key={asset.catalogId}
                        data-asset-manager-asset-item
                        data-asset-source={asset.source}
                        draggable
                        onDragStart={(event) => {
                          event.dataTransfer.effectAllowed = "copy";
                          event.dataTransfer.setData(CANVAS_ASSET_DRAG_MIME, asset.catalogId);
                          event.dataTransfer.setData("text/plain", asset.name);
                          setStatus(`拖动资产「${asset.name}」到画布`);
                        }}
                        className="flex cursor-grab items-center gap-1.5 rounded-xl px-1.5 py-1.5 hover:bg-[#20242c] active:cursor-grabbing"
                      >
                        <button
                          type="button"
                          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-[#8ed5f6]/35"
                          aria-label={`把${asset.source === "project-asset" ? "项目资产" : "看板资产"} ${asset.name} 放入看板`}
                          onClick={() => applyAssetCatalogItem(asset)}
                        >
                          <div data-asset-manager-asset-thumbnail className="h-10 w-10 shrink-0 overflow-hidden rounded-lg border border-[#333845] bg-[#11151d]">
                            {asset.previewUrl ? <ReferencePreviewImage src={asset.previewUrl} alt="" className="h-full w-full object-cover" /> : <div className="flex h-full w-full items-center justify-center text-[#8f98a8]"><ImageIcon className="h-4 w-4" aria-hidden="true" /></div>}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm text-white">{asset.name}</div>
                            <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-[#8f98a8]">
                              <span className="truncate">{asset.description}</span>
                              <span className="shrink-0">{asset.source === "project-asset" ? "项目" : "看板"}</span>
                            </div>
                          </div>
                        </button>
                      </div>
                    ))}
                  </div>
                )
              )}
            </div>

            <div data-asset-manager-footer className="mt-auto border-t border-[#2b3038] px-2.5 py-2 text-sm text-[#9aa4b4]">
              {studioChrome && assetManagerTab === "canvas" ? (
                <div className="grid gap-2" data-studio-minimap>
                  {renderMiniMapSurface("h-[118px] w-full rounded-[10px] border border-white/10")}
                  <div className="flex h-8 items-center justify-between rounded-[9px] border border-white/10 bg-white/[0.035] px-1.5">
                    <button type="button" aria-label="缩小看板" title="缩小看板" className="grid h-6 w-6 place-items-center rounded-md transition hover:bg-white/10" onClick={() => zoomCanvasBy(0.84)}>
                      <ZoomOut className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                    <button type="button" aria-label={`切换看板缩放，当前 ${Math.round(viewport.scale * 100)}%`} className="min-w-[42px] rounded-md px-1 py-1 text-[11px] font-semibold transition hover:bg-white/10" onClick={toggleZoomMode}>
                      {Math.round(viewport.scale * 100)}%
                    </button>
                    <button type="button" aria-label="放大看板" title="放大看板" className="grid h-6 w-6 place-items-center rounded-md transition hover:bg-white/10" onClick={() => zoomCanvasBy(1.19)}>
                      <ZoomIn className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                    <button type="button" aria-label="适应全部看板内容" title="适应全部看板内容" className="grid h-6 w-6 place-items-center rounded-md transition hover:bg-white/10" onClick={toggleZoomMode}>
                      <Expand className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </div>
                </div>
              ) : (
                <div className="text-right">共 {assetCatalogEntries.length} 资产</div>
              )}
            </div>
          </div>
        </aside>
      ) : null); }
  return renderCanvasAssetManager;
}
