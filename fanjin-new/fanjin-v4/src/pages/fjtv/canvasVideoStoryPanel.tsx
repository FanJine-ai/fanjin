import React from "react";
import { Expand, LoaderCircle, NotebookTabs } from "lucide-react";

export function renderVideoStoryPanelExternal(deps: any, node: any): React.ReactNode {
  const { canvasCapabilities, renderVideoStoryTable, cancelVideoStoryAnalysis, writeVideoStoryToStoryboard, setVideoStoryFullscreenNodeId, submitVideoStoryAnalysis, currentProjectId, canvasMeta, pollVideoStoryAnalysis } = deps;
  const renderVideoStoryPanel = (node: any) => {
    if (!canvasCapabilities.videoStoryAnalysis) return null;
    if (node.type !== "video" || (!node.videoStoryAnalysis && !node.videoStoryAnalyzing && !node.videoStoryFailureReason)) return null;
    const width = Math.max(820, Math.min(1060, node.width));
    return (
      <div
        data-video-story-panel
        className="absolute z-30 overflow-hidden rounded-[14px] border border-[#313236] bg-[#101010]/96 text-white shadow-[0_22px_48px_rgba(0,0,0,0.42)]"
        style={{ left: node.x, top: node.y + node.height + 26, width }}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex h-12 items-center justify-between border-b border-[#26272b] px-4">
          <div className="flex items-center gap-2 text-[15px] text-[#dfe2e7]">
            <NotebookTabs className="h-4 w-4 text-[#b27cff]" />
            <span>{node.videoStoryAnalysis?.title || "视频故事"}</span>
            {node.videoStoryAnalyzing ? <span className="text-[13px] text-[#9aa1ad]">{node.videoStoryTaskState === "persisting" ? "正在保存关键帧..." : "解析中..."}</span> : null}
            {node.videoStoryAnalysis?.billing?.billable === false ? <span className="rounded bg-emerald-400/12 px-2 py-0.5 text-[12px] text-emerald-200">0 GU</span> : null}
          </div>
          <div className="flex items-center gap-2">
            {node.videoStoryAnalyzing && ["queued", "running"].includes(String(node.videoStoryTaskState || "")) ? (
              <button className="rounded-[8px] border border-white/12 px-3 py-1.5 text-[12px] text-white/76 hover:bg-white/8" onClick={() => void cancelVideoStoryAnalysis(node)}>取消</button>
            ) : null}
            {node.videoStoryAnalysis ? (
              <button className="rounded-[8px] border border-white/12 px-3 py-1.5 text-[12px] text-white/76 hover:bg-white/8" onClick={() => writeVideoStoryToStoryboard(node)}>写入分镜组</button>
            ) : null}
            {node.videoStoryAnalysis ? (
              <button className="flex h-8 w-8 items-center justify-center rounded-[8px] text-[#c8cbd2] hover:bg-white/8" onClick={() => setVideoStoryFullscreenNodeId(node.id)}>
                <Expand className="h-4 w-4" />
              </button>
            ) : null}
          </div>
        </div>
        {node.videoStoryAnalyzing ? (
          <div className="flex h-[118px] items-center justify-center gap-3 text-[15px] text-[#d5d8df]">
            <LoaderCircle className="h-5 w-5 animate-spin" />
            <span>正在拆解关键帧并生成视频故事表格</span>
          </div>
        ) : node.videoStoryAnalysis ? renderVideoStoryTable(node.videoStoryAnalysis, false, node.id) : (
          <div className="flex min-h-[118px] items-center justify-between gap-4 px-5 py-4 text-[14px] text-rose-200">
            <span>{node.videoStoryFailureReason || "逐帧拉片失败"}</span>
            {node.videoStoryTaskState === "failed" ? (
              <button className="shrink-0 rounded-[9px] bg-white px-4 py-2 font-semibold text-black" onClick={() => void submitVideoStoryAnalysis(node, node.videoStoryTaskId)}>重试</button>
            ) : ["queued", "running", "persisting"].includes(String(node.videoStoryTaskState || "")) && node.videoStoryTaskId ? (
              <button className="shrink-0 rounded-[9px] bg-white px-4 py-2 font-semibold text-black" onClick={() => void pollVideoStoryAnalysis(node.id, Number(currentProjectId || canvasMeta.projectId || 0), Number(node.videoStoryTaskId))}>继续查询</button>
            ) : null}
          </div>
        )}
      </div>
    );
  };
  return renderVideoStoryPanel(node);
}
