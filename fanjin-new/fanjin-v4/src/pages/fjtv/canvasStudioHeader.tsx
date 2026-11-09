import type { Dispatch, SetStateAction, RefObject, ReactNode, JSX } from "react";
import type { NodeData, GroupData, HistoryAssetItem } from "./canvasDataTypes";
import { generationPreparationMessage, isPreparingGeneration } from "../../features/quick-create/generationPreparation";
import { type CanvasRealCapabilities } from "./canvasCapabilities";
import { Check, Circle, LoaderCircle, Play, History, Redo2, Share2, Undo2, X } from "lucide-react";
import LocalMcpStatus from "@/components/LocalMcpStatus";

export interface CanvasStudioHeaderDependencies {
  studioChrome: boolean;
  canvasSavedAt: Date | null;
  canvasSaveState: "error" | "dirty" | "saving" | "saved";
  undoCanvas: () => void;
  redoCanvas: () => void;
  historyQuickOpen: boolean;
  setHistoryQuickOpen: Dispatch<SetStateAction<boolean>>;
  loadHistoryItems: () => Promise<void>;
  historyItemsWithPending: HistoryAssetItem[];
  nodesRef: RefObject<NodeData[]>;
  beginNodeGenerationSession: (nodeId: string) => string;
  pollTaskUntilDone: (taskId: string, node: NodeData, sessionId: string, startedAt?: number, options?: { kind?: "generation" | "video_enhance"; queryFailures?: number; }) => Promise<boolean>;
  setStatus: Dispatch<SetStateAction<string>>;
  setHistoryPreviewItem: Dispatch<SetStateAction<HistoryAssetItem | null>>;
  pendingElapsedLabel: (nodeId: string) => string;
  setHistoryPanelOpen: Dispatch<SetStateAction<boolean>>;
  canvasCapabilities: CanvasRealCapabilities;
  canvasShareTriggerRef: RefObject<HTMLButtonElement | null>;
  canvasShareOverlay: "menu" | "pointsPopover" | "user" | null;
  openCanvasShareMenu: () => void;
  activeGroup: GroupData | null;
  groupExecutionDialog: { groupId: string; } | null;
  groupExecutionRunning: boolean;
  openGroupExecutionDialog: (group: GroupData, opener?: HTMLButtonElement) => void;
}

export function createCanvasStudioHeader(deps: CanvasStudioHeaderDependencies) {
  const {
    studioChrome,
    canvasSavedAt,
    canvasSaveState,
    undoCanvas,
    redoCanvas,
    historyQuickOpen,
    setHistoryQuickOpen,
    loadHistoryItems,
    historyItemsWithPending,
    nodesRef,
    beginNodeGenerationSession,
    pollTaskUntilDone,
    setStatus,
    setHistoryPreviewItem,
    pendingElapsedLabel,
    setHistoryPanelOpen,
    canvasCapabilities,
    canvasShareTriggerRef,
    canvasShareOverlay,
    openCanvasShareMenu,
    activeGroup,
    groupExecutionDialog,
    groupExecutionRunning,
    openGroupExecutionDialog,
  } = deps;
  function renderStudioHeaderActions() {
    if (!studioChrome) return null;
    const savedTime = canvasSavedAt?.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
    const saveLabel = canvasSaveState === "saving"
      ? "保存中"
      : canvasSaveState === "dirty"
        ? "待保存"
        : canvasSaveState === "error"
          ? "保存失败"
          : savedTime
            ? `已保存 ${savedTime}`
            : "已保存";
    return (
      <div className="canvas-studio-header-actions" aria-label="看板操作">
        <LocalMcpStatus />
        <span className={`canvas-studio-save-state canvas-studio-save-state--${canvasSaveState}`} aria-label={`看板状态：${saveLabel}`}>
          {canvasSaveState === "saving" ? (
            <LoaderCircle className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          ) : canvasSaveState === "error" ? (
            <Circle className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
          ) : (
            <Check className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          <span>{saveLabel}</span>
        </span>
        <button type="button" aria-label="撤销" title="撤销" onClick={undoCanvas}>
          <Undo2 className="h-4 w-4" aria-hidden="true" />
        </button>
        <button type="button" aria-label="重做" title="重做" onClick={redoCanvas}>
          <Redo2 className="h-4 w-4" aria-hidden="true" />
        </button>
        <div className="relative">
          <button
            type="button"
            aria-label="生成历史"
            aria-haspopup="dialog"
            aria-expanded={historyQuickOpen}
            title="本画布生成历史"
            className={historyQuickOpen ? "bg-[#333336]" : ""}
            onClick={() => {
              const next = !historyQuickOpen;
              setHistoryQuickOpen(next);
              if (next) void loadHistoryItems();
            }}
          >
            <History className="h-4 w-4" aria-hidden="true" />
            <span className="max-sm:hidden">历史</span>
          </button>
          {historyQuickOpen ? (
            <div
              data-canvas-popover
              role="dialog"
              aria-label="本画布生成历史"
              className="absolute right-0 top-[calc(100%+8px)] z-[130] w-[320px] max-h-[420px] overflow-auto rounded-[14px] border border-[#3e4045] bg-[#232326] shadow-[0_22px_48px_rgba(0,0,0,0.4)]"
            >
              <div className="flex items-center justify-between border-b border-[#34363b] px-3 py-2">
                <div className="text-[13px] font-semibold text-white">生成历史</div>
                <button
                  type="button"
                  aria-label="关闭生成历史"
                  className="flex h-7 w-7 items-center justify-center rounded-[8px] text-[#9aa0a8] hover:bg-white/10 hover:text-white"
                  onClick={() => setHistoryQuickOpen(false)}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              {historyItemsWithPending.length === 0 ? (
                <div className="px-3 py-6 text-center text-[12px] text-[#9aa0a8]">暂无生成记录</div>
              ) : (
                <ul className="p-2">
                  {historyItemsWithPending.slice(0, 12).map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 rounded-[10px] px-2 py-2 text-left hover:bg-white/8"
                        onClick={() => {
                          if (item.pending) {
                            if (item.status === "query_failed" || item.status === "pending_reconcile") {
                              const node = nodesRef.current.find(n => n.id === String(item.id).replace(/^pending-/, ""));
                              if (node?.taskId) {
                                const session = beginNodeGenerationSession(node.id);
                                void pollTaskUntilDone(node.taskId, node, session, Date.now(), { kind: node.taskKind === "video_enhance" ? "video_enhance" : "generation" });
                              } else {
                                setStatus("旧节点缺少任务编号，暂时无法核对结果；请勿重复提交");
                              }
                            }
                            return;
                          }
                          setHistoryQuickOpen(false);
                          setHistoryPreviewItem(item);
                        }}
                      >
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-[8px] bg-black/30">
                          {item.pending && !["query_failed", "pending_reconcile"].includes(item.status || "") ? (
                            <LoaderCircle className="h-4 w-4 animate-spin text-[#8ed5f6]" />
                          ) : item.type === "image" && item.url ? (
                            <img src={item.url} alt="" className="h-full w-full object-cover" />
                          ) : item.type === "video" && item.url ? (
                            <video src={item.url} muted playsInline preload="metadata" className="h-full w-full object-cover" />
                          ) : (
                            <History className="h-4 w-4 text-[#9aa0a8]" />
                          )}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[12px] text-white">
                            {item.status === "pending_reconcile" ? "任务待核对" : item.status === "query_failed" ? "结果查询失败 · 点击重试" : item.pending ? generationPreparationMessage(item) || (item.progress == null ? "生成中" : `生成中 ${item.progress}%`) : item.status === "failed" ? `生成失败 · ${item.errorMessage || "被上游拒绝"}` : item.prompt || "生成结果"}
                          </span>
                          <span className="block truncate text-[11px] text-[#9aa0a8]">
                            {item.status === "pending_reconcile" ? "结果和费用尚未确认，请勿重复提交" : item.status === "query_failed" ? "保留原任务编号，仅重新查询，不重新生成" : item.pending
                              ? `${item.type} · ${pendingElapsedLabel(String(item.id).replace(/^pending-/, ""))}${isPreparingGeneration(item) ? " · 审核通过后自动生成" : item.type === "video" ? " · 耗时取决于排队与处理" : ""}`
                              : item.status === "failed"
                                ? `${item.type} · 未扣费/已退冻结额度`
                                : `${item.type} · ${item.createdAt ? new Date(item.createdAt).toLocaleString("zh-CN", { hour12: false }) : ""}`}
                          </span>
                          {item.pending && !isPreparingGeneration(item) && !["query_failed", "pending_reconcile"].includes(item.status || "") ? (
                            <span className="mt-1 block h-1 overflow-hidden rounded-full bg-white/12">
                              <span
                                className="block h-full rounded-full bg-[#8ed5f6] transition-[width] duration-500"
                                style={{ width: item.progress == null ? "35%" : `${item.progress}%`, animation: item.progress == null ? "pulse 1.5s ease-in-out infinite" : undefined }}
                              />
                            </span>
                          ) : null}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="border-t border-[#34363b] px-3 py-2">
                <button
                  type="button"
                  className="text-[12px] text-[#8ed5f6] hover:underline"
                  onClick={() => {
                    setHistoryQuickOpen(false);
                    setHistoryPanelOpen(true);
                    void loadHistoryItems();
                  }}
                >
                  打开完整历史 →
                </button>
              </div>
            </div>
          ) : null}
        </div>
        {canvasCapabilities.canvasShare ? (
          <button
            ref={canvasShareTriggerRef}
            type="button"
            className="canvas-studio-share-action"
            aria-label="分享看板"
            aria-haspopup="dialog"
            aria-expanded={canvasShareOverlay === "menu"}
            aria-controls="canvas-share-popover"
            title="分享看板"
            onClick={openCanvasShareMenu}
          >
            <Share2 className="h-4 w-4" aria-hidden="true" />
            <span>分享</span>
          </button>
        ) : null}
        <button
          type="button"
          className="canvas-studio-run-action"
          aria-label={activeGroup ? "运行当前分组" : "选中分组后运行"}
          aria-haspopup="dialog"
          aria-expanded={groupExecutionDialog !== null}
          aria-controls="canvas-group-execution-dialog"
          disabled={!activeGroup || groupExecutionRunning}
          title={activeGroup ? "运行当前分组" : "选中分组后运行"}
          onClick={(event) => activeGroup && openGroupExecutionDialog(activeGroup, event.currentTarget)}
        >
          <Play className="h-4 w-4 fill-current" aria-hidden="true" />
          <span>运行</span>
        </button>
      </div>
    );
  }
  return renderStudioHeaderActions;
}
