import React from "react";
import { X } from "lucide-react";

export function renderVideoStoryFullscreenExternal(deps: any): React.ReactNode {
  const { videoStoryFullscreenNodeId, nodeMap, setVideoStoryFullscreenNodeId, writeVideoStoryToStoryboard, renderVideoStoryTable } = deps;
  const renderVideoStoryFullscreen = () => {
    const node = videoStoryFullscreenNodeId ? nodeMap.get(videoStoryFullscreenNodeId) : null;
    const analysis = node?.videoStoryAnalysis;
    if (!node || !analysis) return null;
    return (
      <div data-fixed-ui className="absolute inset-0 z-[180] bg-black/92 text-white backdrop-blur-[2px]" onMouseDown={(event) => event.stopPropagation()}>
        <div className="flex h-[86px] items-center justify-between border-b border-[#202124] px-9">
          <div className="text-[22px] font-semibold">{analysis.title || "视频故事"}</div>
          <button className="flex h-10 w-10 items-center justify-center rounded-full text-[#9fa3aa] hover:bg-white/8 hover:text-white" onClick={() => setVideoStoryFullscreenNodeId(null)}>
            <X className="h-6 w-6" />
          </button>
        </div>
        <div className="p-3">
          <div className="mb-3 flex items-center justify-between px-3 text-[13px] text-white/56">
            <span>技术切点和时间码为原始证据；其余字段可编辑，默认“待人工补充”不代表 AI 语义判断。</span>
            <button className="rounded-[9px] bg-white px-4 py-2 font-semibold text-black" onClick={() => writeVideoStoryToStoryboard(node)}>写入新分镜组</button>
          </div>
          {renderVideoStoryTable(analysis, true, node.id)}
        </div>
      </div>
    );
  };
  return renderVideoStoryFullscreen();
}
