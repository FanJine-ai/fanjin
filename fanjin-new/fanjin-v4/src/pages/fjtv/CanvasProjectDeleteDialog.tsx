import type { RefObject } from "react";

export function CanvasProjectDeleteDialog({
  pending,
  canDelete,
  error,
  cancelRef,
  onCancel,
  onConfirm,
  onTrapFocus,
}: {
  pending: boolean;
  canDelete: boolean;
  error: string | null;
  cancelRef: RefObject<HTMLButtonElement | null>;
  onCancel: () => void;
  onConfirm: () => void;
  onTrapFocus: (event: React.KeyboardEvent<HTMLDivElement>) => void;
}) {
  return (
    <div data-fixed-ui className="fixed inset-0 z-[168] flex items-center justify-center bg-black/72 px-4">
      <div id="canvas-project-delete-dialog" data-canvas-dialog role="alertdialog" aria-modal="true" aria-labelledby="canvas-project-delete-title" aria-describedby="canvas-project-delete-description" tabIndex={-1} onKeyDown={onTrapFocus} className="w-full max-w-[568px] rounded-[18px] border border-white/12 bg-[#262626] px-7 py-7 shadow-[0_30px_80px_rgba(0,0,0,.58)]">
        <div id="canvas-project-delete-title" className="text-[26px] font-black text-[#ffffff]">删除项目</div>
        <div id="canvas-project-delete-description" className="mt-7 text-[20px] font-medium text-white/56">确定要删除该项目吗?</div>
        {error ? <div data-canvas-alert role="alert" className="mt-4 rounded-[10px] border border-[#a44b4b] bg-[#522c2c] px-4 py-3 text-sm font-medium text-[#ffd5d5]">{error}</div> : null}
        <div className="mt-8 flex justify-end gap-4">
          <button ref={cancelRef} data-canvas-control type="button" disabled={pending} onClick={onCancel} className="h-[52px] rounded-[12px] border border-white/12 bg-white/12 px-6 text-[20px] font-bold text-[#ffffff] hover:bg-white/18 disabled:cursor-not-allowed disabled:opacity-45">取消</button>
          <button type="button" disabled={pending || !canDelete} onClick={onConfirm} className="h-[52px] rounded-[12px] bg-white px-6 text-[20px] font-bold text-black hover:bg-white/90 disabled:cursor-wait disabled:opacity-60">{pending ? "删除中..." : "确认"}</button>
        </div>
      </div>
    </div>
  );
}
