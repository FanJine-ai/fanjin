import React from "react";
import { ChevronDown, X } from "lucide-react";

export function renderImageCropOverlayExternal(deps: any, node: any): React.ReactNode {
  const { activeImageCrop, clampImageCropDraft, aspectForImageRatioMode, setImageCropDragging, setActiveImageCrop, setImageCropRatioOpen, imageCropRatioOpen, IMAGE_OUTPAINT_RATIO_ITEMS, buildImageCropDraftForRatio, submitImageCrop } = deps;
  const renderImageCropOverlay = (node: any) => {
    if (!activeImageCrop || activeImageCrop.nodeId !== node.id) return null;
    const crop = clampImageCropDraft(activeImageCrop);
    const left = crop.x * node.width;
    const top = crop.y * node.height;
    const width = crop.width * node.width;
    const height = crop.height * node.height;
    const aspect = aspectForImageRatioMode(activeImageCrop.ratioMode);
    return (
      <>
        <div
          className="absolute z-30 border border-white/85 shadow-[0_0_0_9999px_rgba(0,0,0,0.32)]"
          style={{ left, top, width, height }}
          onMouseDown={(event) => {
            event.stopPropagation();
            setImageCropDragging({ nodeId: node.id, type: "move", startX: event.clientX, startY: event.clientY, initial: crop, aspect });
          }}
        >
          <div className="absolute left-0 top-1/3 h-px w-full bg-white/30" />
          <div className="absolute left-0 top-2/3 h-px w-full bg-white/30" />
          <div className="absolute left-1/3 top-0 h-full w-px bg-white/30" />
          <div className="absolute left-2/3 top-0 h-full w-px bg-white/30" />
          <button className="absolute inset-y-0 left-[-10px] w-5 cursor-ew-resize bg-transparent" onMouseDown={(event) => { event.stopPropagation(); setImageCropDragging({ nodeId: node.id, type: "left", startX: event.clientX, startY: event.clientY, initial: crop, aspect }); }} />
          <button className="absolute inset-y-0 right-[-10px] w-5 cursor-ew-resize bg-transparent" onMouseDown={(event) => { event.stopPropagation(); setImageCropDragging({ nodeId: node.id, type: "right", startX: event.clientX, startY: event.clientY, initial: crop, aspect }); }} />
          <button className="absolute inset-x-0 top-[-10px] h-5 cursor-ns-resize bg-transparent" onMouseDown={(event) => { event.stopPropagation(); setImageCropDragging({ nodeId: node.id, type: "top", startX: event.clientX, startY: event.clientY, initial: crop, aspect }); }} />
          <button className="absolute inset-x-0 bottom-[-10px] h-5 cursor-ns-resize bg-transparent" onMouseDown={(event) => { event.stopPropagation(); setImageCropDragging({ nodeId: node.id, type: "bottom", startX: event.clientX, startY: event.clientY, initial: crop, aspect }); }} />
          <button className="absolute -bottom-2 -right-2 h-4 w-4 cursor-nwse-resize rounded-full bg-white" onMouseDown={(event) => { event.stopPropagation(); setImageCropDragging({ nodeId: node.id, type: "corner", startX: event.clientX, startY: event.clientY, initial: crop, aspect }); }} />
        </div>
        <div
          data-fixed-ui
          data-node-toolbar
          className="absolute z-40 flex items-center gap-4 rounded-[18px] border border-[#3f4044] bg-[#232325] px-4 py-3 shadow-[0_22px_52px_rgba(0,0,0,0.42)]"
          style={{ left: node.x + node.width / 2, top: node.y - 54, transform: "translateX(-50%)" }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <button className="flex h-10 w-10 items-center justify-center rounded-[12px] text-white/88 hover:bg-[#2f3033]" onClick={() => setActiveImageCrop(null)}>
            <X className="h-5 w-5" />
          </button>
          <div className="relative">
            <button className="flex h-10 items-center gap-2 rounded-[12px] border border-[#4b4d52] px-3 text-white" onClick={() => setImageCropRatioOpen((prev: any) => !prev)}>
              <span>{IMAGE_OUTPAINT_RATIO_ITEMS.find((item: any) => item.key === activeImageCrop.ratioMode)?.label || "原图比例"}</span>
              <ChevronDown className="h-4 w-4 text-[#a4a7ae]" />
            </button>
            {imageCropRatioOpen ? (
              <div data-node-floating-menu className="absolute bottom-[48px] left-0 z-10 w-[132px] rounded-[14px] border border-[#4b4d52] bg-[#2a2a2c] p-2 shadow-[0_18px_40px_rgba(0,0,0,0.42)]">
                {IMAGE_OUTPAINT_RATIO_ITEMS.map((item: any) => (
                  <button key={item.key} className={`mb-1 block h-9 w-full rounded-[10px] px-3 text-left ${activeImageCrop.ratioMode === item.key ? "bg-[#505055]" : "hover:bg-[#38393d]"}`} onClick={() => setActiveImageCrop((prev: any) => (prev ? buildImageCropDraftForRatio(node, item.key, prev) : prev))}>
                    {item.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <button className="flex h-10 items-center justify-center rounded-[12px] bg-white px-4 text-[#161719]" onClick={() => void submitImageCrop(node)}>
            确认
          </button>
        </div>
      </>
    );
  };
  return renderImageCropOverlay(node);
}
