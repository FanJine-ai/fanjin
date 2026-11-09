// @ts-nocheck
import React from "react";

export function renderCanvasArtifactSourcePickerExternal(deps: any, node: any): React.ReactNode {
  const { edges, nodesRef, getCanvasArtifactImages, allArtifactCards, patchLooksActivelyGenerating, CanvasArtifactSourcePicker, editCanvasArtifact, setNodePatch, setStatus } = deps;
  const renderCanvasArtifactSourcePicker = (node: any) => {
    const sources = edges.filter((edge) => edge.toNodeId === node.id && edge.relationship !== "draft_final")
      .map((edge) => nodesRef.current.find((source) => source.id === edge.fromNodeId))
      .filter((source): source is NodeData => source?.type === "text");
    const image = getCanvasArtifactImages().find((image) => image.nodeId === node.id);
    const selection = node.textArtifactBindings || [];
    const referenceTargets = selection.flatMap((binding) => {
      const source = sources.find((source) => source.id === binding.sourceNodeId);
      const entry = allArtifactCards(source?.textArtifacts).find((entry) => entry.card.id === binding.cardId && entry.kind !== "shots");
      return source && entry ? [{ source, entry }] : [];
    });
    return <>
      <CanvasArtifactSourcePicker sources={sources.map((source) => ({ ...source, disabled: patchLooksActivelyGenerating(source) }))} bindings={selection} modes={node.textArtifactSourceModes || {}}
        onEdit={editCanvasArtifact}
        disabled={patchLooksActivelyGenerating(node)} onChange={(textArtifactBindings, textArtifactSourceModes) => setNodePatch(node.id, { textArtifactBindings, textArtifactSourceModes })} />
      {image && referenceTargets.length ? <div className="mb-3 flex flex-wrap items-center gap-2 text-[12px] text-[#b5c5df]">
        <span>确认当前图片：</span>
        {referenceTargets.map(({ source, entry }) => <button key={`${source.id}:${entry.card.id}`} type="button"
          disabled={patchLooksActivelyGenerating(source)} className="rounded-lg border border-[#5a6c88] px-3 py-1.5 hover:bg-[#3d4c65] disabled:opacity-40"
          onClick={() => {
            const reference: CanvasArtifactReference = { nodeId: image.nodeId, assetVersionId: image.assetVersionId, imageUrl: image.imageUrl, referenceAssetUri: image.referenceAssetUri };
            editCanvasArtifact(source.id, entry.kind, entry.card.id, { reference });
            setStatus(`已设为「${entry.card.name}」参考图；后续分镜会引用这个已确认版本`);
          }}>设为「{entry.card.name}」参考图</button>)}
      </div> : null}
    </>;
  };
  return renderCanvasArtifactSourcePicker(node);
}
