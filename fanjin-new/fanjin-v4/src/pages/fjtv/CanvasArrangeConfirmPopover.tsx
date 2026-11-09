interface CanvasArrangeSnapshot {
  mergedCount?: number;
}

interface CanvasArrangeConfirmPopoverProps {
  snapshot: CanvasArrangeSnapshot | null;
  onRestore: () => void;
  onKeep: () => void;
}

export function CanvasArrangeConfirmPopover({ snapshot, onRestore, onKeep }: CanvasArrangeConfirmPopoverProps) {
  return (
    <div data-canvas-popover className="absolute bottom-[52px] left-0 w-[236px] rounded-[16px] border border-[#3f4044] bg-[#2b2b2c] p-3 text-white shadow-[0_24px_50px_rgba(0,0,0,0.42)]">
      <div className="mb-3 text-[13px] font-medium leading-5">是否保留此次整理结果？</div>
      <p aria-live="polite" className="mb-3 text-[12px] leading-5 opacity-75">{snapshot?.mergedCount ? `已合并 ${snapshot.mergedCount} 个重复素材节点，保留全部连线和参考顺序。资产库中的原文件不变。` : "已整理画布，没有可合并的重复素材节点。"}</p>
      <div className="flex justify-end gap-2"><button className="rounded-[10px] px-3 py-1.5 text-[13px] hover:bg-[#3a3a3d]" onClick={onRestore}>还原</button><button data-canvas-control className="rounded-[10px] border border-[#5b5c60] bg-[#5b5c60] px-3 py-1.5 text-[13px] text-white" onClick={onKeep}>保留</button></div>
    </div>
  );
}
