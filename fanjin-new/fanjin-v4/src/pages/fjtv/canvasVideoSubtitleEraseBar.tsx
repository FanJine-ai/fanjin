import { buildSubmitButtonPendingKey } from "./canvasSubmitPendingKeys";
import React from "react";
import { X } from "lucide-react";

export function renderVideoSubtitleEraseBarExternal(deps: any, node: any): React.ReactNode {
  const { canvasCapabilities, activeVideoEditor, closeVideoEditor, renderCompactSubmitButton, submitVideoSubtitleErase } = deps;
  if (!canvasCapabilities.videoSubtitleErase) return null;
  if (activeVideoEditor?.nodeId !== node.id || activeVideoEditor.mode !== "erase-subtitle") return null;
  return (
    <div data-fixed-ui data-node-toolbar className="absolute z-40 flex items-center gap-4 rounded-[18px] border border-[#3f4044] bg-[#232325] px-4 py-3 shadow-[0_22px_52px_rgba(0,0,0,0.42)]" style={{ left: node.x + node.width / 2, top: node.y + node.height + 18, transform: "translateX(-50%)" }} onMouseDown={(event) => event.stopPropagation()}>
      <button className="flex h-10 w-10 items-center justify-center rounded-[12px] text-white/88 hover:bg-[#2f3033]" onClick={closeVideoEditor}><X className="h-5 w-5" /></button>
      <div className="h-8 w-px bg-[#3d3f44]" />
      <div className="min-w-[120px] text-center text-[20px] font-medium text-white">智能擦除</div>
      <div className="text-[14px] text-[#9ea2a9]">⚡ 0</div>
      {renderCompactSubmitButton(buildSubmitButtonPendingKey("video-erase-subtitle", node.id), () => submitVideoSubtitleErase(node, "subtitle"), "flex h-10 w-10 items-center justify-center rounded-[12px] bg-white text-[#161719] disabled:cursor-wait disabled:opacity-80", "h-5 w-5")}
    </div>
  );
}
