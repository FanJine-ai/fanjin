import { buildSubmitButtonPendingKey } from "./canvasSubmitPendingKeys";
import type React from "react";
import { X } from "lucide-react";

export function renderVideoEraseRegionOverlayExternal(node: any, deps: any) {
  const { activeVideoEditor, videoCropDraft, clampVideoCropDraft, setVideoCropDragging, closeVideoEditor, renderCompactSubmitButton, submitVideoSubtitleErase } = deps;
  if (activeVideoEditor?.nodeId !== node.id || activeVideoEditor.mode !== "erase-region" || !videoCropDraft) return null;
  const crop = clampVideoCropDraft(videoCropDraft);
  const cropWidthPx = crop.width * node.width, cropHeightPx = crop.height * node.height;
  const cropLeftPx = crop.x * node.width, cropTopPx = crop.y * node.height;
  const labelWidth = Math.max(1, Math.round((node.mediaNaturalWidth || 1280) * crop.width));
  const labelHeight = Math.max(1, Math.round((node.mediaNaturalHeight || 720) * crop.height));
  const begin = (event: React.MouseEvent, type: string) => { event.stopPropagation(); setVideoCropDragging({ type, startX: event.clientX, startY: event.clientY, initial: crop, aspect: crop.width / Math.max(0.08, crop.height) }); };
  return <>
    <div className="pointer-events-auto absolute z-30 border border-[#48c8ff] shadow-[0_0_0_9999px_rgba(0,0,0,0.32)]" style={{ left: cropLeftPx, top: cropTopPx, width: cropWidthPx, height: cropHeightPx }} onMouseDown={(event) => begin(event, "move")}>
      <div className="absolute left-2 top-2 rounded-[8px] bg-[#2b2d31] px-2 py-1 text-[12px] font-medium text-white">{labelWidth} x {labelHeight}</div>
      <div className="absolute left-0 top-1/2 h-px w-full bg-white/35" /><div className="absolute left-1/3 top-0 h-full w-px bg-white/25" /><div className="absolute left-2/3 top-0 h-full w-px bg-white/25" /><div className="absolute left-0 top-1/3 h-px w-full bg-white/25" /><div className="absolute left-0 top-2/3 h-px w-full bg-white/25" />
      <button className="absolute inset-y-0 left-[-10px] w-5 cursor-ew-resize bg-transparent" onMouseDown={(e) => begin(e, "left")} /><button className="absolute inset-y-0 right-[-10px] w-5 cursor-ew-resize bg-transparent" onMouseDown={(e) => begin(e, "right")} /><button className="absolute inset-x-0 top-[-10px] h-5 cursor-ns-resize bg-transparent" onMouseDown={(e) => begin(e, "top")} /><button className="absolute inset-x-0 bottom-[-10px] h-5 cursor-ns-resize bg-transparent" onMouseDown={(e) => begin(e, "bottom")} /><button className="absolute -right-2 bottom-[-8px] h-4 w-4 cursor-nwse-resize rounded-full bg-[#48c8ff]" onMouseDown={(e) => begin(e, "corner")} />
      <div className="absolute -left-1 top-1/2 h-2 w-2 -translate-y-1/2 rounded-full bg-[#48c8ff]" /><div className="absolute -right-1 top-1/2 h-2 w-2 -translate-y-1/2 rounded-full bg-[#48c8ff]" /><div className="absolute left-1/2 -top-1 h-2 w-2 -translate-x-1/2 rounded-full bg-[#48c8ff]" /><div className="absolute left-1/2 -bottom-1 h-2 w-2 -translate-x-1/2 rounded-full bg-[#48c8ff]" />
    </div>
    <div data-fixed-ui data-node-toolbar className="absolute z-40 flex items-center gap-4 rounded-[18px] border border-[#3f4044] bg-[#232325] px-4 py-3 shadow-[0_22px_52px_rgba(0,0,0,0.42)]" style={{ left: "50%", top: node.height + 16, transform: "translateX(-50%)" }} onMouseDown={(event) => event.stopPropagation()}>
      <button className="flex h-10 w-10 items-center justify-center rounded-[12px] text-white/88 hover:bg-[#2f3033]" onClick={closeVideoEditor}><X className="h-5 w-5" /></button><div className="min-w-[180px] text-center text-[18px] text-white">框选擦除</div><div className="text-[14px] text-[#aab2bc]">{labelWidth} x {labelHeight}</div><div className="text-[14px] text-[#9ea2a9]">⚡ 0</div>
      {renderCompactSubmitButton(buildSubmitButtonPendingKey("video-erase-region", node.id), () => submitVideoSubtitleErase(node, "region"), "flex h-10 w-10 items-center justify-center rounded-[12px] bg-white text-[#161719] disabled:cursor-wait disabled:opacity-80", "h-5 w-5")}
    </div>
  </>;
}
