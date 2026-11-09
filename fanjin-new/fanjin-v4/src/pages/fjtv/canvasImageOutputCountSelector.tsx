import type * as React from "react";

export function renderImageOutputCountSelector(deps: any): React.ReactNode {
  const { activeNode, activeNodeModelOption, getCanvasImageOutputCounts, normalizeNodeMaxImages,
    quantityOpen, setQuantityOpen, setRatioOpen, setModelOpen, setCameraOpen, Layers3,
    ChevronDown, setNodePatch, Check } = deps;
  if (!activeNode || activeNode.type !== "image") return null;
  const counts = getCanvasImageOutputCounts(activeNodeModelOption);
  const selected = normalizeNodeMaxImages(activeNode.maxImages, activeNodeModelOption);
  return <div className="relative mr-5"><button type="button" data-node-image-count-trigger
    className={`inline-flex h-8 items-center gap-2 rounded-[9px] px-2 text-[12px] transition ${quantityOpen ? "bg-[#373739] text-white" : "text-white hover:bg-[#313133]"}`}
    aria-haspopup="menu" aria-expanded={quantityOpen} onClick={() => {
      if (counts.length <= 1) return; setQuantityOpen((value: boolean) => !value);
      setRatioOpen(false); setModelOpen(false); setCameraOpen(false);
    }}><Layers3 className="h-3.5 w-3.5 text-[#d8d8dc]" /><span>{selected} 张</span>
    {counts.length > 1 ? <ChevronDown className="h-3 w-3 text-[#9ea2a9]" /> : null}</button>
    {quantityOpen && counts.length > 1 ? <div data-node-floating-menu data-node-image-count-menu role="menu"
      className="absolute bottom-[42px] left-0 z-[90] min-w-[144px] rounded-[14px] border border-[#4d4e51] bg-[#282828] p-2 shadow-[0_26px_48px_rgba(0,0,0,0.48)]">
      {counts.map((count: number) => <button key={count} type="button" role="menuitemradio" aria-checked={selected === count}
        data-node-image-count={count} className={`flex h-9 w-full items-center justify-between rounded-[9px] px-3 text-[13px] transition ${selected === count ? "bg-[#505052] text-white" : "text-[#d8dade] hover:bg-[#353537]"}`}
        onClick={() => { setNodePatch(activeNode.id, { maxImages: count, quantity: `${count}x` }); setQuantityOpen(false); }}>
        <span>{count} 张</span>{selected === count ? <Check className="h-3.5 w-3.5" /> : null}</button>)}
    </div> : null}</div>;
}
