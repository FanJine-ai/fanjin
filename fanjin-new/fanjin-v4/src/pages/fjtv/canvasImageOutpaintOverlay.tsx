import { buildSubmitButtonPendingKey } from "./canvasSubmitPendingKeys";
import React from "react";
import { ChevronDown, X } from "lucide-react";

export function renderImageOutpaintOverlayExternal(deps: any, node: any): React.ReactNode {
  const { canvasCapabilities, activeImageOutpaint, getImageOutpaintPreviewMetrics, setImageOutpaintDragging, setActiveImageOutpaint, setImageOutpaintRatioOpen, imageOutpaintRatioOpen, IMAGE_OUTPAINT_RATIO_ITEMS, buildImageOutpaintDraftForRatio, setImageOutpaintResolutionOpen, imageOutpaintResolutionOpen, IMAGE_OUTPAINT_RESOLUTION_ITEMS, imageOutpaintResolutionOpen: _resolutionOpen, renderCompactSubmitButton, submitImageOutpaint } = deps;
  const renderImageOutpaintOverlay = (node: any) => {
    if (!canvasCapabilities.imageOutpaint) return null;
    if (!activeImageOutpaint || activeImageOutpaint.nodeId !== node.id) return null;
    const preview = getImageOutpaintPreviewMetrics(node, activeImageOutpaint);
    const insetLeft = (activeImageOutpaint.expandLeft / (1 + activeImageOutpaint.expandLeft + activeImageOutpaint.expandRight)) * preview.width;
    const insetRight = (activeImageOutpaint.expandRight / (1 + activeImageOutpaint.expandLeft + activeImageOutpaint.expandRight)) * preview.width;
    const insetTop = (activeImageOutpaint.expandTop / (1 + activeImageOutpaint.expandTop + activeImageOutpaint.expandBottom)) * preview.height;
    const insetBottom = (activeImageOutpaint.expandBottom / (1 + activeImageOutpaint.expandTop + activeImageOutpaint.expandBottom)) * preview.height;
    const sourceRect = { left: insetLeft, top: insetTop, width: preview.width - insetLeft - insetRight, height: preview.height - insetTop - insetBottom };
    return (
      <>
        <div className="pointer-events-none absolute z-30 border border-white/85 shadow-[0_0_0_9999px_rgba(0,0,0,0.24)]" style={{ left: 0, top: 0, width: preview.width, height: preview.height }}>
          <div className="absolute left-0 top-1/3 h-px w-full bg-white/30" />
          <div className="absolute left-0 top-2/3 h-px w-full bg-white/30" />
          <div className="absolute left-1/3 top-0 h-full w-px bg-white/30" />
          <div className="absolute left-2/3 top-0 h-full w-px bg-white/30" />
          <div className="absolute border border-white/50" style={sourceRect} />
        </div>
        <button className="absolute z-35 inset-y-0 left-[-10px] w-5 cursor-ew-resize bg-transparent" onMouseDown={(event) => { event.stopPropagation(); setImageOutpaintDragging({ nodeId: node.id, side: "left", startX: event.clientX, startY: event.clientY, initial: activeImageOutpaint }); }} />
        <button className="absolute z-35 inset-y-0 right-[-10px] w-5 cursor-ew-resize bg-transparent" onMouseDown={(event) => { event.stopPropagation(); setImageOutpaintDragging({ nodeId: node.id, side: "right", startX: event.clientX, startY: event.clientY, initial: activeImageOutpaint }); }} />
        <button className="absolute z-35 inset-x-0 top-[-10px] h-5 cursor-ns-resize bg-transparent" onMouseDown={(event) => { event.stopPropagation(); setImageOutpaintDragging({ nodeId: node.id, side: "top", startX: event.clientX, startY: event.clientY, initial: activeImageOutpaint }); }} />
        <button className="absolute z-35 inset-x-0 bottom-[-10px] h-5 cursor-ns-resize bg-transparent" onMouseDown={(event) => { event.stopPropagation(); setImageOutpaintDragging({ nodeId: node.id, side: "bottom", startX: event.clientX, startY: event.clientY, initial: activeImageOutpaint }); }} />
        <div className="absolute z-35 left-[-3px] top-1/2 h-10 w-1 -translate-y-1/2 rounded-full bg-white/90" />
        <div className="absolute z-35 right-[-3px] top-1/2 h-10 w-1 -translate-y-1/2 rounded-full bg-white/90" />
        <div className="absolute z-35 left-1/2 top-[-3px] h-1 w-10 -translate-x-1/2 rounded-full bg-white/90" />
        <div className="absolute z-35 bottom-[-3px] left-1/2 h-1 w-10 -translate-x-1/2 rounded-full bg-white/90" />
        <div
          data-fixed-ui
          data-node-toolbar
          className="absolute z-40 flex items-center gap-4 rounded-[18px] border border-[#3f4044] bg-[#232325] px-4 py-3 shadow-[0_22px_52px_rgba(0,0,0,0.42)]"
          style={{ left: node.x + node.width / 2, top: node.y + node.height + 16, transform: "translateX(-50%)" }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <button className="flex h-10 w-10 items-center justify-center rounded-[12px] text-white/88 hover:bg-[#2f3033]" onClick={() => setActiveImageOutpaint(null)}>
            <X className="h-5 w-5" />
          </button>
          <div className="text-[14px] text-[#a6a9b0]">PRO</div>
          <div className="relative">
            <button className="flex h-10 items-center gap-2 rounded-[12px] border border-[#4b4d52] px-3 text-white" onClick={() => setImageOutpaintRatioOpen((prev: any) => !prev)}>
              <span>{IMAGE_OUTPAINT_RATIO_ITEMS.find((item: any) => item.key === activeImageOutpaint.ratioMode)?.label || "原图比例"}</span>
              <ChevronDown className="h-4 w-4 text-[#a4a7ae]" />
            </button>
            {imageOutpaintRatioOpen ? (
              <div data-node-floating-menu className="absolute bottom-[48px] left-0 z-10 w-[132px] rounded-[14px] border border-[#4b4d52] bg-[#2a2a2c] p-2 shadow-[0_18px_40px_rgba(0,0,0,0.42)]">
                {IMAGE_OUTPAINT_RATIO_ITEMS.map((item: any) => (
                  <button
                    key={item.key}
                    className={`mb-1 block h-9 w-full rounded-[10px] px-3 text-left ${activeImageOutpaint.ratioMode === item.key ? "bg-[#505055]" : "hover:bg-[#38393d]"}`}
                    onClick={() => setActiveImageOutpaint((prev: any) => (prev ? buildImageOutpaintDraftForRatio(node, item.key, prev) : prev))}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <div className="relative">
            <button className="flex h-10 items-center gap-2 rounded-[12px] border border-[#4b4d52] px-3 text-white" onClick={() => setImageOutpaintResolutionOpen((prev: any) => !prev)}>
              <span>{activeImageOutpaint.resolution}</span>
              <ChevronDown className="h-4 w-4 text-[#a4a7ae]" />
            </button>
            {imageOutpaintResolutionOpen ? (
              <div data-node-floating-menu className="absolute bottom-[48px] left-0 z-10 w-[100px] rounded-[14px] border border-[#4b4d52] bg-[#2a2a2c] p-2 shadow-[0_18px_40px_rgba(0,0,0,0.42)]">
                {IMAGE_OUTPAINT_RESOLUTION_ITEMS.map((item: any) => (
                  <button key={item} className={`mb-1 block h-9 w-full rounded-[10px] px-3 text-left ${activeImageOutpaint.resolution === item ? "bg-[#505055]" : "hover:bg-[#38393d]"}`} onClick={() => setActiveImageOutpaint((prev: any) => (prev ? { ...prev, resolution: item } : prev))}>
                    {item}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <button className="flex h-10 items-center rounded-[12px] border border-[#4b4d52] px-3 text-white" onClick={() => setActiveImageOutpaint((prev: any) => (prev ? { ...prev, count: prev.count === 1 ? 2 : 1 } : prev))}>
            {activeImageOutpaint.count}张
          </button>
          {renderCompactSubmitButton(buildSubmitButtonPendingKey("image-outpaint", node.id), () => submitImageOutpaint(node), "flex h-10 w-10 items-center justify-center rounded-[12px] bg-white text-[#161719] disabled:cursor-wait disabled:opacity-80", "h-5 w-5")}
        </div>
      </>
    );
  };
  return renderImageOutpaintOverlay(node);
}
