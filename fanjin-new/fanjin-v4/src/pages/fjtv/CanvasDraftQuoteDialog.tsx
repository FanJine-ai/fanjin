import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
export type DraftQuote = { maximumGu: number; token: string; expiresAt: number; renderMode: "draft" | "finalize" };
export function CanvasDraftQuoteDialog({ quote, onDecision, dark }: { quote: DraftQuote; onDecision: (approved: boolean) => void; dark: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => { dialog?.close(); }; }, []);
  return createPortal(<dialog ref={ref} aria-labelledby="draft-quote-title" onCancel={event => { event.preventDefault(); onDecision(false); }}
    onMouseDown={event => event.stopPropagation()} style={{ color: dark ? "#f3f6fa" : "#263746", background: dark ? "#25292e" : "#fff" }}
    className="m-auto w-[min(440px,calc(100vw-32px))] rounded-2xl border border-slate-400/20 p-6 shadow-2xl backdrop:bg-black/35">
    <h2 id="draft-quote-title" className="text-lg font-semibold">{quote.renderMode === "draft" ? "生成 480p 样片" : "生成 1080p 正式片"}</h2>
    <p className="mt-3 text-sm leading-6 opacity-75">{quote.renderMode === "draft" ? "先检查构图和动作。样片成功后，可在其创建起 7 天内另行付费生成正式片。" : "沿用所选样片的提示词、素材、画幅、时长和声音，另存一条正式片。"}</p>
    <div className="my-5 rounded-xl bg-slate-400/10 p-4"><div className="text-xs opacity-70">本次最高预留</div><strong className="mt-1 block text-2xl">{quote.maximumGu.toLocaleString("zh-CN", { maximumFractionDigits: 2 })} GU</strong><p className="mt-2 text-xs opacity-70">完成后按实际用量结算并释放差额。仅确认当前这一步。</p></div>
    <div className="flex justify-end gap-3"><button autoFocus className="rounded-lg border border-slate-400/30 px-4 py-2 text-sm focus-visible:outline focus-visible:outline-2" onClick={() => onDecision(false)}>取消</button><button className="rounded-lg bg-[#117794] px-4 py-2 text-sm font-medium text-white focus-visible:outline focus-visible:outline-2" onClick={() => onDecision(true)}>确认并生成</button></div>
  </dialog>, document.body);
}
