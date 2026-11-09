import type * as React from "react";

export function renderGenerateButton(node: any, deps: any): React.ReactNode {
  const { generateButtonPendingNodeIds, nodeHasSubmittingSession, patchLooksActivelyGenerating,
    getModelGenerationUnavailableMessage, setGenerateButtonPendingNodeIds, generateWithActiveNode,
    LoaderCircle, ArrowUp } = deps;
  if (node.type === "audio") return null;
  const spinning = generateButtonPendingNodeIds.includes(node.id) || nodeHasSubmittingSession(node.id) || patchLooksActivelyGenerating(node);
  const unavailable = getModelGenerationUnavailableMessage(node);
  const disabled = spinning || Boolean(unavailable);
  const label = unavailable || (spinning ? "生成中" : "提交生成");
  return <button data-node-generate-button data-node-id={node.id} data-node-type={node.type}
    data-model-catalog-unavailable={unavailable ? "true" : undefined}
    className="inline-flex h-9 w-9 items-center justify-center gap-1.5 rounded-[11px] bg-[#9d9ea2] text-[#1d1d1f] transition hover:bg-[#b3b4b8] disabled:cursor-not-allowed disabled:opacity-70"
    disabled={disabled} title={label} onClick={async () => { if (disabled) return;
      setGenerateButtonPendingNodeIds((prev: string[]) => prev.includes(node.id) ? prev : [...prev, node.id]);
      try { await generateWithActiveNode(); } finally { setGenerateButtonPendingNodeIds((prev: string[]) => prev.filter((id: string) => id !== node.id)); }
    }} aria-busy={spinning} aria-label={label}>{spinning ? <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <ArrowUp className="h-4 w-4" />}</button>;
}
