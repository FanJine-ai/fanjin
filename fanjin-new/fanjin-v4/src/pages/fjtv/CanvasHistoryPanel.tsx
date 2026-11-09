import type { Dispatch, SetStateAction, RefObject, ReactNode, JSX } from "react";
import type { HistoryAssetItem } from "./canvasDataTypes";
import ReferencePreviewImage from "@/features/quick-create/attachments/ReferencePreviewImage";
import { ReferencePreviewVideo } from "@/features/quick-create/attachments/AuthenticatedReferenceMedia";
import { generationPreparationMessage, isPreparingGeneration } from "../../features/quick-create/generationPreparation";
import { AlertTriangle, LoaderCircle, Play, Trash2, X } from "lucide-react";
import { getCanvasImagePreviewUrl } from "./canvasAssetPresentation";

export interface CanvasHistoryPanelDependencies {
  historyPanelOpen: boolean;
  loadHistoryItems: () => Promise<void>;
  historyLoading: boolean;
  setHistoryPanelOpen: Dispatch<SetStateAction<boolean>>;
  historyItemsWithPending: HistoryAssetItem[];
  historyTab: "audio" | "image" | "video";
  setHistoryTab: Dispatch<SetStateAction<"audio" | "image" | "video">>;
  setHistoryPreviewItem: Dispatch<SetStateAction<HistoryAssetItem | null>>;
  pendingElapsedLabel: (nodeId: string) => string;
  canDelete: boolean;
  deleteHistoryItem: (item: HistoryAssetItem) => Promise<void>;
  addHistoryItemToCanvas: (item: HistoryAssetItem) => void;
  downloadHistoryItem: (item: HistoryAssetItem) => void;
}

export function createCanvasHistoryPanel(deps: CanvasHistoryPanelDependencies) {
  const {
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
  } = deps;
  function renderCanvasHistoryPanel() { return (historyPanelOpen ? (
        <div id="canvas-history-panel" data-history-panel data-fixed-ui role="dialog" aria-modal="true" aria-labelledby="canvas-history-title" className="absolute inset-0 z-[96] bg-black/50 px-6 py-12">
          <div data-canvas-dialog className="mx-auto h-full max-w-[1750px] rounded-[24px] border border-[#37383c] bg-[#262626] shadow-[0_30px_80px_rgba(0,0,0,0.45)]">
            <div className="flex items-center justify-between border-b border-[#3a3a3d] px-8 py-5">
              <div id="canvas-history-title" className="text-[30px] font-semibold text-white">历史资产</div>
              <div className="flex items-center gap-3">
                <button className="rounded-[10px] border border-[#434448] px-4 py-2 text-sm text-white" onClick={() => void loadHistoryItems()}>{historyLoading ? "加载中..." : "刷新"}</button>
                <button aria-label="关闭历史资产" className="flex h-10 w-10 items-center justify-center rounded-[12px] text-[#a3a5ab] transition hover:bg-[#333335]" onClick={() => setHistoryPanelOpen(false)}>
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>
            <div className="flex h-[calc(100%-81px)] flex-col px-8 py-6">
              <div className="mb-6 flex items-center justify-between">
                <div className="flex items-center gap-8 text-[15px]" role="tablist" aria-label="历史资产类型">
                  {[
                    ["image", `图片历史(${historyItemsWithPending.filter((item) => item.type === "image").length})`],
                    ["video", `视频历史(${historyItemsWithPending.filter((item) => item.type === "video").length})`],
                    ["audio", `音频历史(${historyItemsWithPending.filter((item) => item.type === "audio").length})`],
                  ].map(([key, label]) => (
                    <button key={key} role="tab" aria-selected={historyTab === key} className={`${historyTab === key ? "text-white" : "text-[#8d8f96]"} transition`} onClick={() => setHistoryTab(key as "image" | "video" | "audio")}>
                      {label}
                    </button>
                  ))}
                </div>
                <div className="text-sm text-[#c3c5cb]">时间排序</div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto pr-2">
                {historyLoading ? (
                  <div className="flex h-full items-center justify-center text-[#9ea2a9]"><LoaderCircle className="mr-2 h-5 w-5 animate-spin" />加载中</div>
                ) : historyItemsWithPending.filter((item) => item.type === historyTab).length === 0 ? (
                  <div className="flex h-full items-center justify-center text-[#8f939a]">暂无{historyTab === "image" ? "图片" : historyTab === "video" ? "视频" : "音频"}历史</div>
                ) : (
                  Object.entries(
                    historyItemsWithPending
                      .filter((item) => item.type === historyTab)
                      .reduce<Record<string, HistoryAssetItem[]>>((acc, item) => {
                        const dateKey = item.pending ? "进行中" : String(item.createdAt || "").slice(0, 10) || item.dateGroup || "未分组";
                        (acc[dateKey] ||= []).push(item);
                        return acc;
                      }, {}),
                  ).map(([dateGroup, items]) => (
                    <div key={dateGroup} className="mb-8">
                      <div className="mb-4 text-[30px] font-semibold text-white">{dateGroup}</div>
                      <div className="grid grid-cols-[repeat(auto-fill,minmax(146px,1fr))] gap-4">
                        {items.map((item) => (
                          <div key={item.id} className="group relative text-left">
                            <button type="button" aria-label={item.pending ? "生成进行中" : `预览${item.type === "video" ? "视频" : item.type === "audio" ? "音频" : "图片"}历史`} className="block w-full text-left" onClick={() => {
                              if (item.pending) return;
                              setHistoryPreviewItem(item);
                            }}>
                              <div className="relative aspect-square overflow-hidden rounded-[14px] bg-[#343436]">
                              {item.pending ? (
                                <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-3">
                                  <LoaderCircle className="h-7 w-7 animate-spin text-[#8ed5f6]" />
                                  <div className="w-full">
                                    <div className="mb-1 text-center text-[12px] text-white">{generationPreparationMessage(item) || (item.progress == null ? "生成中" : `生成中 ${item.progress}%`)}</div>
                                    <div className="mb-1 text-center text-[10px] text-[#9aa0a8]">
                                      {pendingElapsedLabel(String(item.id).replace(/^pending-/, ""))}
                                      {isPreparingGeneration(item) ? " · 审核通过后自动生成" : item.type === "video" ? " · 耗时取决于排队与处理" : ""}
                                    </div>
                                    <div hidden={isPreparingGeneration(item)} className="h-1.5 overflow-hidden rounded-full bg-white/12">
                                      <div
                                        className="h-full rounded-full bg-[#8ed5f6] transition-[width] duration-500"
                                        style={{ width: item.progress == null ? "35%" : `${item.progress}%`, animation: item.progress == null ? "pulse 1.5s ease-in-out infinite" : undefined }}
                                      />
                                    </div>
                                  </div>
                                </div>
                              ) : item.status === "failed" ? (
                                <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-3 text-center">
                                  <AlertTriangle className="h-7 w-7 text-[#f0a0a0]" />
                                  <div className="text-[12px] font-semibold text-white">生成失败</div>
                                  <div className="text-[11px] leading-snug text-[#f0b0b0]">{item.errorMessage || "被上游拒绝"}</div>
                                  <div className="text-[10px] text-[#9aa0a8]">未扣费 / 已退冻结额度</div>
                                </div>
                              ) : item.type === "video" ? (
                                <div className="relative h-full w-full">
                                  <ReferencePreviewVideo src={item.url} className="h-full w-full object-cover" />
                                  <div className="absolute inset-0 flex items-center justify-center bg-black/18"><Play className="h-8 w-8 text-white" /></div>
                                </div>
                              ) : (
                                <ReferencePreviewImage src={getCanvasImagePreviewUrl(item.url)} alt={item.prompt || item.model} className="h-full w-full object-cover transition duration-200 group-hover:scale-[1.02]" />
                              )}
                              </div>
                            </button>
                            {!item.pending ? (
                              <>
                            <div className="pointer-events-none absolute inset-0 rounded-[14px] bg-black/0 transition group-hover:bg-black/50 group-focus-within:bg-black/50" />
                            <div data-history-hover-actions className="pointer-events-none absolute right-3 top-3 z-10 opacity-0 transition group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
                              <button
                                type="button"
                                aria-label="删除历史资产"
                                disabled={!canDelete}
                                className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-[#1f2023]/92 text-[#f3f4f6] transition hover:bg-[#2b2c2f]"
                                onClick={() => void deleteHistoryItem(item)}
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </div>
                            <div data-history-hover-actions className="pointer-events-none absolute inset-x-0 bottom-4 z-10 flex items-center justify-center gap-3 px-3 opacity-0 transition group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
                              <button className="min-w-[52px] rounded-full bg-black/42 px-3 py-2 text-sm font-semibold text-white transition hover:bg-black/58" onClick={() => setHistoryPreviewItem(item)}>查看</button>
                              <button className="min-w-[52px] rounded-full bg-black/42 px-3 py-2 text-sm font-semibold text-white transition hover:bg-black/58" onClick={() => addHistoryItemToCanvas(item)}>使用</button>
                              <button className="min-w-[52px] rounded-full bg-black/42 px-3 py-2 text-sm font-semibold text-white transition hover:bg-black/58" onClick={() => downloadHistoryItem(item)}>下载</button>
                            </div>
                              </>
                            ) : (
                              <div className="pointer-events-none absolute inset-x-0 bottom-2 z-10 px-2">
                                <div className="truncate rounded-[8px] bg-black/45 px-2 py-1 text-center text-[11px] text-white">{item.prompt}</div>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      ) : null); }
  return renderCanvasHistoryPanel;
}
