import type React from "react";

export function renderPromptReferenceCapsuleExternal(
  deps: {
    upstreamReferenceLabelMap: Map<string, any>;
    renderReferenceVisual: (reference: any, className?: string) => React.ReactNode;
  },
  referenceLabel: string,
) {
  const reference = deps.upstreamReferenceLabelMap.get(referenceLabel);
  if (!reference) {
    return (
      <span data-prompt-reference-capsule className="inline-flex min-h-[24px] items-center whitespace-nowrap rounded-[7px] bg-[#4d4f54] px-2.5 py-[2px] align-middle text-[13px] font-medium leading-none text-white">
        {referenceLabel}
      </span>
    );
  }
  return (
    <span data-prompt-reference-capsule className="inline-flex min-h-[24px] items-center gap-1.5 whitespace-nowrap rounded-[7px] bg-[#4d4f54] px-2 py-[2px] align-middle text-[13px] font-medium leading-none text-white">
      <span className="h-[18px] w-[18px] shrink-0 overflow-hidden rounded-[4px] border border-[#6a6d72] bg-[#3a3b3e]">
        {deps.renderReferenceVisual(reference)}
      </span>
      <span className="shrink-0">{reference.label}</span>
    </span>
  );
}
