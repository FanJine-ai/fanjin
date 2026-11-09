import type React from "react";
import { X } from "lucide-react";
import type { UpstreamReferenceItem } from "./canvasDataTypes";

interface ReferenceStripDependencies {
  upstreamReferences: UpstreamReferenceItem[];
  canvasColorMode: string;
  referencePickerOpen: boolean;
  setReferencePickerOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setReferencePreview: React.Dispatch<React.SetStateAction<UpstreamReferenceItem | null>>;
  referencePreview: UpstreamReferenceItem | null;
  renderReferenceVisual: (reference: UpstreamReferenceItem, className?: string) => React.ReactNode;
  insertReferenceIntoPrompt: (reference: UpstreamReferenceItem) => void;
}

export function renderUpstreamReferenceStripExternal(deps: ReferenceStripDependencies, options?: { showPickerButton?: boolean; compact?: boolean; marginClassName?: string }) {
    const { upstreamReferences, canvasColorMode, referencePickerOpen, setReferencePickerOpen, setReferencePreview, renderReferenceVisual, referencePreview, insertReferenceIntoPrompt } = deps;
    if (upstreamReferences.length === 0) return null;
    const showPickerButton = options?.showPickerButton ?? true;
    const compact = options?.compact ?? false;
    const marginClassName = options?.marginClassName ?? "mb-3";
    const lightMode = canvasColorMode === "light";
    const triggerTone = referencePickerOpen
      ? lightMode ? "border-[#b8c2cf] bg-[#e4e9f1] text-[#2f3a48]" : "border-[#6c6f76] bg-[#555658] text-white"
      : lightMode ? "border-[#d8dee7] bg-[#f4f6f9] text-[#55606e] hover:bg-[#eaeef4]" : "border-[#57585c] bg-[#2c2c2d] text-[#d8d8dd] hover:bg-[#333334]";
    const thumbnailTone = lightMode
      ? "border-[#d8dee7] bg-[#f4f6f9] shadow-[inset_0_1px_0_rgba(255,255,255,0.65)] hover:border-[#bfc9d6] hover:bg-[#eceff4]"
      : "border-[#5d6066] bg-[#303133] shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] hover:border-[#72757d]";
    return (
      <div className={`${marginClassName} relative flex items-center gap-1.5`}>
        {showPickerButton ? (
          <button
            data-node-reference-trigger
            className={`flex flex-col items-center justify-center rounded-[10px] border transition ${compact ? "h-[42px] w-[44px]" : "h-[46px] w-[52px]"} ${triggerTone}`}
            onClick={() => setReferencePickerOpen((prev) => !prev)}
          >
            <span className={`leading-none ${compact ? "mb-0.5 text-[16px]" : "mb-1 text-[18px]"}`}>@</span>
            <span className="text-[11px]">引用</span>
          </button>
        ) : null}
        {upstreamReferences.map((reference) => (
          <button
            key={reference.id}
            data-node-reference-thumbnail
            className={`relative overflow-hidden rounded-[10px] border transition ${thumbnailTone} ${compact ? "h-[44px] w-[44px]" : "h-[46px] w-[46px]"}`}
            onClick={() => setReferencePreview(reference)}
            title={`${reference.label} · 点击预览`}
          >
            {renderReferenceVisual(reference)}
            <span data-prompt-reference-badge className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-[#64686f] px-1 text-[10px] font-semibold leading-none text-white">
              {reference.badge}
            </span>
          </button>
        ))}
        {referencePreview ? (
          <div
            data-canvas-popover
            role="dialog"
            aria-label={`预览 ${referencePreview.label}`}
            className="absolute left-1/2 top-[calc(100%+8px)] z-[130] w-[min(320px,70vw)] -translate-x-1/2 overflow-hidden rounded-[14px] border border-[#4a4d53] bg-[#1f2023] shadow-[0_24px_48px_rgba(0,0,0,0.45)]"
          >
            <div className="flex items-center justify-between gap-2 px-3 py-2">
              <div className="min-w-0 truncate text-[12px] font-medium text-white">{referencePreview.label}</div>
              <button
                type="button"
                aria-label="关闭预览"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] text-[#9aa0a8] hover:bg-white/10 hover:text-white"
                onClick={() => setReferencePreview(null)}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="flex max-h-[220px] items-center justify-center overflow-hidden bg-black/30 px-2 pb-2">
              {renderReferenceVisual(referencePreview, "h-[180px] w-full")}
            </div>
            <div className="flex items-center justify-end gap-2 px-3 pb-3 pt-2">
              <button
                type="button"
                className="rounded-[9px] border border-[#5b5e65] px-3 py-1.5 text-[12px] text-white hover:bg-white/10"
                onClick={() => {
                  insertReferenceIntoPrompt(referencePreview);
                  setReferencePreview(null);
                }}
              >
                插入提示词
              </button>
            </div>
          </div>
        ) : null}
      </div>
    );
  }

export function renderReferencePickerExternal(deps: Pick<ReferenceStripDependencies, "upstreamReferences" | "referencePickerOpen" | "insertReferenceIntoPrompt" | "renderReferenceVisual">) {
    const { upstreamReferences, referencePickerOpen, insertReferenceIntoPrompt, renderReferenceVisual } = deps;
    if (!referencePickerOpen || upstreamReferences.length === 0) return null;
    return (
      <div data-node-floating-menu className="mb-3 w-[264px] overflow-hidden rounded-[12px] border border-[#4a4d53] bg-[#2f3032] shadow-[0_18px_34px_rgba(0,0,0,0.42)]">
        <div className="border-b border-[#3e4146] px-4 py-2 text-[13px] font-medium text-white">@</div>
        <div className="p-2">
          {upstreamReferences.map((reference) => (
            <button
              key={reference.id}
              className="flex w-full items-center gap-3 rounded-[10px] px-2 py-2 text-left transition hover:bg-[#3a3b3e]"
              onClick={() => insertReferenceIntoPrompt(reference)}
            >
              <span className="h-10 w-10 overflow-hidden rounded-[9px] border border-[#5f6268] bg-[#3a3c40]">
                {renderReferenceVisual(reference)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-medium text-white">{reference.label}</span>
                <span className="block truncate text-[12px] text-[#9ea2aa]">(@{reference.badge})</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    );
  }
