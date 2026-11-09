import { CreditCard, Sparkles } from "lucide-react";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

export type CanvasPricingConfirmation = {
  maximumGu: number | null;
  mayDuplicatePendingRequest?: boolean;
};

export function CanvasPricingConfirmationDialog({
  confirmation,
  dark,
  onDecision,
}: {
  confirmation: CanvasPricingConfirmation;
  dark: boolean;
  onDecision: (approved: boolean) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const mayDuplicatePendingRequest = confirmation.mayDuplicatePendingRequest;
  const costLabel = confirmation.maximumGu === null
    ? "费用将在提交后按实际用量结算"
    : `${confirmation.maximumGu.toLocaleString("zh-CN", { maximumFractionDigits: 2 })} GU`;

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  return createPortal(
    <dialog
      ref={dialogRef}
      className="m-auto w-[min(440px,calc(100vw-32px))] border-0 bg-transparent p-0 shadow-none backdrop:bg-[#101827]/45 backdrop:backdrop-blur-[2px]"
      aria-labelledby="canvas-pricing-confirmation-title"
      onCancel={(event) => {
        event.preventDefault();
        onDecision(false);
      }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <section className={`overflow-hidden rounded-2xl border shadow-[0_24px_70px_rgba(15,23,42,0.24)] ${dark ? "border-white/10 bg-[#20252d] text-[#f7f9fc]" : "border-[#dce5ec] bg-white text-[#17212b]"}`}>
        <header className={`flex items-center gap-3 border-b px-6 py-5 ${dark ? "border-white/10" : "border-[#e8eef3]"}`}>
          <span className="grid size-10 place-items-center rounded-xl bg-[#e5f5fc] text-[#087aa5]">
            <Sparkles size={20} aria-hidden="true" />
          </span>
          <div>
            <p className="text-xs font-medium tracking-[0.08em] text-[#087aa5]">生成费用确认</p>
            <h2 id="canvas-pricing-confirmation-title" className="mt-0.5 text-lg font-semibold">确认后开始生成</h2>
          </div>
        </header>

        <div className="px-6 py-5">
          <p className={`text-sm leading-6 ${dark ? "text-[#bec9d6]" : "text-[#5d6b78]"}`}>
            {mayDuplicatePendingRequest
              ? "上次请求的结果和费用仍待核对。本次会创建独立的新请求；如果旧请求最终计费，两次生成都可能产生费用。"
              : "本次图片生成会占用相应额度。确认后才会向模型提交任务。"}
          </p>
          <div className={`mt-5 flex items-center justify-between rounded-xl border px-4 py-3.5 ${dark ? "border-[#3a4654] bg-[#19202a]" : "border-[#cde4f0] bg-[#f3fbfe]"}`}>
            <div className="flex items-center gap-2.5">
              <CreditCard size={18} className="text-[#087aa5]" aria-hidden="true" />
              <span className={`text-sm ${dark ? "text-[#bec9d6]" : "text-[#5d6b78]"}`}>本次最高费用</span>
            </div>
            <strong className="text-lg font-semibold text-[#087aa5]">{costLabel}</strong>
          </div>
          <p className={`mt-3 text-xs leading-5 ${dark ? "text-[#8f9cab]" : "text-[#788896]"}`}>
            {mayDuplicatePendingRequest ? "取消会保留旧请求状态，不会提交本次新请求。" : "取消不会提交本次生成，也不会产生费用。"}
          </p>
        </div>

        <footer className={`flex justify-end gap-3 border-t px-6 py-4 ${dark ? "border-white/10" : "border-[#e8eef3]"}`}>
          <button type="button" className={`rounded-lg border px-4 py-2 text-sm font-medium transition-colors ${dark ? "border-white/15 text-[#dce5ef] hover:bg-white/10" : "border-[#cfd9e1] text-[#405160] hover:bg-[#f5f8fa]"}`} onClick={() => onDecision(false)}>
            取消
          </button>
          <button autoFocus type="button" className="rounded-lg bg-[#087aa5] px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-[#06698f] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#087aa5]" onClick={() => onDecision(true)}>
            确认并生成
          </button>
        </footer>
      </section>
    </dialog>,
    document.body,
  );
}
