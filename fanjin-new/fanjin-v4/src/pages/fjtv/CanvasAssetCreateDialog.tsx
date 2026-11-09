import type { Dispatch, SetStateAction, RefObject, ReactNode, JSX } from "react";
import type { CanvasAssetType, NodeData } from "./canvasDataTypes";
import ReferencePreviewImage from "@/features/quick-create/attachments/ReferencePreviewImage";
import { ReferencePreviewVideo } from "@/features/quick-create/attachments/AuthenticatedReferenceMedia";
import { Image as ImageIcon, Play, X } from "lucide-react";
import { getCanvasImagePreviewUrl } from "./canvasAssetPresentation";

export interface CanvasAssetCreateDialogDependencies {
  assetCreateModalOpen: boolean;
  assetCreateMode: CanvasAssetType;
  setAssetCreateModalOpen: Dispatch<SetStateAction<boolean>>;
  portraitPreviewUrl: string;
  assetName: string;
  portraitAssetUri: string;
  nodes: NodeData[];
  selectedNodeIds: string[];
  nodeMap: Map<string, NodeData>;
  setAssetName: Dispatch<SetStateAction<string>>;
  assetSaveLocation: string;
  setAssetSaveLocation: Dispatch<SetStateAction<string>>;
  ASSET_SAVE_LOCATIONS: string[];
  assetSaveTag: string;
  setAssetSaveTag: Dispatch<SetStateAction<string>>;
  ASSET_TAGS: string[];
  setPortraitAssetUri: Dispatch<SetStateAction<string>>;
  setPortraitPreviewUrl: Dispatch<SetStateAction<string>>;
  createPortraitAsset: () => Promise<void>;
  createAssetFromSelection: () => Promise<void>;
}

export function createCanvasAssetCreateDialog(deps: CanvasAssetCreateDialogDependencies) {
  const {
    assetCreateModalOpen,
    assetCreateMode,
    setAssetCreateModalOpen,
    portraitPreviewUrl,
    assetName,
    portraitAssetUri,
    nodes,
    selectedNodeIds,
    nodeMap,
    setAssetName,
    assetSaveLocation,
    setAssetSaveLocation,
    ASSET_SAVE_LOCATIONS,
    assetSaveTag,
    setAssetSaveTag,
    ASSET_TAGS,
    setPortraitAssetUri,
    setPortraitPreviewUrl,
    createPortraitAsset,
    createAssetFromSelection,
  } = deps;
  function renderCanvasAssetCreateDialog() { return (assetCreateModalOpen ? (
        <div data-fixed-ui className="absolute inset-0 z-[99] flex items-center justify-center bg-black/60">
          <div data-canvas-dialog role="dialog" aria-modal="true" aria-labelledby="canvas-asset-dialog-title" className="relative w-[738px] rounded-[18px] border border-[#434448] bg-[#2a2a2b] shadow-[0_30px_80px_rgba(0,0,0,0.55)]">
            <div className="flex items-center justify-between border-b border-[#3d3e42] px-6 py-4">
              <div id="canvas-asset-dialog-title" className="text-[28px] text-white">{assetCreateMode === "portrait" ? "\u65b0\u589e\u4eba\u50cf\u8d44\u4ea7" : "\u4fdd\u5b58\u8d44\u4ea7"}</div>
              <button type="button" aria-label="关闭资产编辑" className="text-[#9ea1a7]" onClick={() => setAssetCreateModalOpen(false)}>
                <X className="h-6 w-6" />
              </button>
            </div>

            <div className="grid grid-cols-[1fr_240px] gap-6 p-6">
              <div data-canvas-surface className="rounded-[14px] border border-[#434448] bg-[#2b2b2d] p-3">
                {assetCreateMode === "portrait" ? (
                  <div>
                    <div data-media-preview className="flex h-[320px] items-center justify-center overflow-hidden rounded-[12px] bg-[#1b1b1d]">
                      {portraitPreviewUrl ? (
                        <ReferencePreviewImage src={portraitPreviewUrl} alt={assetName || "\u4eba\u50cf\u9884\u89c8"} className="h-full w-full object-contain" />
                      ) : (
                        <div className="text-center text-sm text-[#8f9198]">
                          <ImageIcon className="mx-auto mb-3 h-10 w-10" />
                          <div>{"\u586b\u5199\u9884\u89c8\u56fe\u5730\u5740\u540e\uff0c\u8fd9\u91cc\u4f1a\u663e\u793a\u8282\u70b9\u9884\u89c8"}</div>
                        </div>
                      )}
                    </div>
                    <div data-canvas-info className="mt-5 rounded-[12px] border border-[#3d3e42] bg-[#242427] p-4 text-sm text-[#b6bcc8]">
                      <div>{"\u753b\u5e03\u8282\u70b9\u5c55\u793a\uff1a\u9884\u89c8\u56fe"}</div>
                      <div className="mt-2">Seedance 2.0 {"\u5b9e\u9645\u4f20\u53c2\uff1a"}{portraitAssetUri.trim() || "asset://..."}</div>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="flex gap-3 overflow-hidden">
                      {nodes
                        .filter((node) => selectedNodeIds.includes(node.id))
                        .filter((node) => (node.type === "image" && (node.imageUrl || node.localPreviewUrl)) || (node.type === "video" && (node.videoUrl || node.localVideoUrl)))
                        .slice(0, 6)
                        .map((node) => {
                          const src = node.type === "video" ? node.videoUrl || node.localVideoUrl : node.imageUrl || node.localPreviewUrl;
                          return (
                            <div key={node.id} className="w-[116px] shrink-0">
                              <div data-media-preview className="h-[116px] overflow-hidden rounded-[10px] bg-[#1b1b1d]">
                                {node.type === "video" ? (
                                  <div className="relative h-full w-full">
                                    <ReferencePreviewVideo src={src} className="h-full w-full object-cover" />
                                    <div className="absolute inset-0 flex items-center justify-center"><Play className="h-8 w-8 text-white" /></div>
                                  </div>
                                ) : (
                                  <ReferencePreviewImage src={getCanvasImagePreviewUrl(src || "", 420)} alt={node.title} loading="lazy" decoding="async" className="h-full w-full object-cover" />
                                )}
                              </div>
                              <div className="mt-2 text-[14px] text-white">{node.type === "video" ? "\u89c6\u9891\u7d20\u6750" : "\u56fe\u7247\u7d20\u6750"}</div>
                            </div>
                          );
                        })}
                    </div>
                    <div className="mt-8 text-sm text-[#8f9198]">{"\u5df2\u9009\u62e9 "}{selectedNodeIds.filter((id) => { const node = nodeMap.get(id); return Boolean(node && ((node.type === "image" && (node.imageUrl || node.localPreviewUrl)) || (node.type === "video" && (node.videoUrl || node.localVideoUrl)))); }).length}{" \u4e2a\u7d20\u6750"}</div>
                  </>
                )}
              </div>

              <div className="space-y-5">
                <div>
                  <div className="mb-2 text-[14px] text-white">{"\u8d44\u4ea7\u540d\u79f0"}</div>
                  <input
                    value={assetName}
                    onChange={(event) => setAssetName(event.target.value)}
                    placeholder={assetCreateMode === "portrait" ? "\u4f8b\u5982\uff1aElena \u4eba\u50cf" : "\u8bf7\u8f93\u5165\u8d44\u4ea7\u540d\u79f0"}
                    className="h-12 w-full rounded-[10px] border border-[#3d3e42] bg-[#353538] px-4 text-white outline-none placeholder:text-[#8f9198]"
                  />
                </div>
                <div>
                  <div className="mb-2 text-[14px] text-white">{"\u4fdd\u5b58\u4f4d\u7f6e"}<span className="text-[#ff6c6c]">*</span></div>
                  <select value={assetSaveLocation} onChange={(event) => setAssetSaveLocation(event.target.value)} className="h-12 w-full rounded-[10px] border border-[#3d3e42] bg-[#353538] px-4 text-white outline-none">
                    {ASSET_SAVE_LOCATIONS.map((item) => <option key={item} value={item}>{item}</option>)}
                  </select>
                </div>
                <div>
                  <div className="mb-2 text-[14px] text-white">{"\u6807\u7b7e"}</div>
                  <select value={assetSaveTag} onChange={(event) => setAssetSaveTag(event.target.value)} className="h-12 w-full rounded-[10px] border border-[#3d3e42] bg-[#353538] px-4 text-white outline-none">
                    {ASSET_TAGS.map((item) => <option key={item} value={item}>{item}</option>)}
                  </select>
                </div>
                {assetCreateMode === "portrait" ? (
                  <>
                    <div>
                      <div className="mb-2 text-[14px] text-white">{"\u4eba\u50cf Asset URI"}<span className="text-[#ff6c6c]">*</span></div>
                      <input
                        value={portraitAssetUri}
                        onChange={(event) => setPortraitAssetUri(event.target.value)}
                        placeholder="asset://asset-20260616164123-ht6gm"
                        className="h-12 w-full rounded-[10px] border border-[#3d3e42] bg-[#353538] px-4 text-white outline-none placeholder:text-[#8f9198]"
                      />
                    </div>
                    <div>
                      <div className="mb-2 text-[14px] text-white">{"\u9884\u89c8\u56fe\u5730\u5740"}<span className="text-[#ff6c6c]">*</span></div>
                      <input
                        value={portraitPreviewUrl}
                        onChange={(event) => setPortraitPreviewUrl(event.target.value)}
                        placeholder="https://..."
                        className="h-12 w-full rounded-[10px] border border-[#3d3e42] bg-[#353538] px-4 text-white outline-none placeholder:text-[#8f9198]"
                      />
                    </div>
                  </>
                ) : null}
              </div>
            </div>

            <div className="flex justify-end gap-3 px-6 pb-5">
              <button className="rounded-[10px] bg-[#4b4c50] px-5 py-2.5 text-white" onClick={() => setAssetCreateModalOpen(false)}>{"\u53d6\u6d88"}</button>
              <button className="rounded-[10px] bg-[#d8d8da] px-5 py-2.5 text-[#1c1c1e]" onClick={assetCreateMode === "portrait" ? createPortraitAsset : createAssetFromSelection}>
                {assetCreateMode === "portrait" ? "\u6dfb\u52a0\u4eba\u50cf\u8d44\u4ea7" : "\u4fdd\u5b58"}
              </button>
            </div>
          </div>
        </div>
      ) : null); }
  return renderCanvasAssetCreateDialog;
}
