import { ChevronDown, Plus, Search } from "lucide-react";
import "./CanvasAssetManagerTools.css";

export type CanvasAssetManagerTab = "canvas" | "asset";

type CanvasAssetManagerToolsProps = {
  activeTab: CanvasAssetManagerTab;
  searchValue: string;
  onSearchValueChange: (value: string) => void;
  onCreatePortraitAsset: () => void;
};

export function CanvasAssetManagerTools({
  activeTab,
  searchValue,
  onSearchValueChange,
  onCreatePortraitAsset,
}: CanvasAssetManagerToolsProps) {
  const canvasTabActive = activeTab === "canvas";

  return (
    <>
      <div
        data-asset-manager-section-head
        className="canvasAssetManagerSectionHead flex items-center justify-between px-3 pb-2 pt-3"
      >
        <div className="canvasAssetManagerSectionTitle text-[#cfd5df]">
          {canvasTabActive ? "画布内容" : "资产列表"}
        </div>
        <div className="canvasAssetManagerControls flex items-center gap-2 text-[#cfd5df]">
          {canvasTabActive ? (
            <span className="canvasAssetManagerSort">
              <span>默认排序</span>
              <ChevronDown size={14} className="text-[#8f98a8]" aria-hidden="true" />
            </span>
          ) : (
            <button
              type="button"
              onClick={onCreatePortraitAsset}
              className="inline-flex items-center gap-1 rounded-lg border border-[#38404d] bg-[#1f2430] px-2.5 py-1 text-xs text-white transition hover:bg-[#293040]"
            >
              <Plus size={14} aria-hidden="true" />
              <span>人像资产</span>
            </button>
          )}
        </div>
      </div>

      <div className="px-3 pb-2">
        <label
          htmlFor="project-studio-asset-search"
          data-asset-manager-search
          className="canvasAssetManagerSearch flex items-center rounded-[10px] border border-[#2b3038] bg-[#11141a] px-2.5 text-[13px] text-[#9ba5b5] transition focus-within:border-[#6e8ca1] focus-within:ring-2 focus-within:ring-[#8ed5f6]/20"
        >
          <span className="sr-only">{canvasTabActive ? "搜索看板内容" : "搜索资产"}</span>
          <Search size={14} className="canvasAssetManagerSearchIcon mr-2" aria-hidden="true" />
          <input
            id="project-studio-asset-search"
            type="search"
            value={searchValue}
            onChange={(event) => onSearchValueChange(event.currentTarget.value)}
            placeholder={canvasTabActive ? "请输入搜索内容" : "搜索资产"}
            className="cuiInput canvasAssetManagerSearchInput"
          />
        </label>
      </div>
    </>
  );
}
