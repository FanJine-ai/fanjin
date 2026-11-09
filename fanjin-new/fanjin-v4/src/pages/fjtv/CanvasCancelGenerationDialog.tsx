import type { RefObject } from "react";

export function CanvasCancelGenerationDialog({
  preparing,
  pending,
  returnRef,
  onClose,
  onConfirm,
  onTrapFocus,
}: {
  preparing: boolean;
  pending: boolean;
  returnRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onConfirm: () => void;
  onTrapFocus: (event: React.KeyboardEvent<HTMLDivElement>) => void;
}) {
  return (
    <div data-fixed-ui className="fixed inset-0 z-[155] flex items-center justify-center bg-black/72 px-4" onMouseDown={() => { if (!pending) onClose(); }}>
      <div id="canvas-cancel-generation-dialog" data-canvas-dialog role="alertdialog" aria-modal="true" aria-labelledby="canvas-cancel-generation-title" aria-describedby="canvas-cancel-generation-description" tabIndex={-1} onKeyDown={onTrapFocus} className="w-full max-w-[568px] rounded-[18px] border border-white/12 bg-[#262626] px-7 py-7 text-white shadow-[0_30px_80px_rgba(0,0,0,.58)]" onMouseDown={(event) => event.stopPropagation()}>
        <div id="canvas-cancel-generation-title" className="text-[26px] font-black">取消生成</div>
        <div id="canvas-cancel-generation-description" className="mt-7 text-[20px] font-medium leading-8 text-white/56">{preparing ? "参考素材正在登记，尚未提交生成。取消结果和实际费用以服务端返回为准。" : "任务正在处理中。取消结果和实际费用以服务端返回为准。"}</div>
        <div className="mt-8 flex justify-end gap-4">
          <button ref={returnRef} data-canvas-control type="button" disabled={pending} onClick={onClose} className="h-[52px] rounded-[12px] border border-white/12 bg-white/12 px-6 text-[20px] font-bold text-white hover:bg-white/18 disabled:cursor-wait disabled:opacity-50">返回</button>
          <button type="button" disabled={pending} onClick={onConfirm} className="h-[52px] rounded-[12px] bg-white px-6 text-[20px] font-bold text-black hover:bg-white/90 disabled:cursor-wait disabled:opacity-60">{pending ? "正在取消..." : "确认取消任务"}</button>
        </div>
      </div>
    </div>
  );
}
