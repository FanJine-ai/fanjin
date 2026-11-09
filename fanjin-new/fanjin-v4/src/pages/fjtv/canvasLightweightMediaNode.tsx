import type * as React from "react";

export function renderLightweightMediaNode(node: any, previewSide: number, deps: any): React.ReactNode {
  const { getNodeImageDisplayUrl, getNodeVideoPosterUrl, getCanvasImagePreviewUrl, ReferencePreviewImage, renderCanvasNodeGlyph } = deps;
  const imageUrl = node.type === "image" ? getNodeImageDisplayUrl(node) : "";
  const videoPosterUrl = node.type === "video" ? getNodeVideoPosterUrl(node) : "";
  const previewUrl = imageUrl || videoPosterUrl;
  return <div className="h-full w-full overflow-hidden rounded-[12px] border border-[#34373f] bg-[#15171c] p-[2px]"><div className="relative h-full w-full overflow-hidden rounded-[10px] bg-black">
    {previewUrl ? <ReferencePreviewImage src={getCanvasImagePreviewUrl(previewUrl, previewSide)} alt={node.title} loading="lazy" decoding="async" className="h-full w-full object-cover" /> : <div className="flex h-full w-full items-center justify-center text-[#555557]">{renderCanvasNodeGlyph(node.type)}</div>}
    {node.type === "video" ? <div className="pointer-events-none absolute bottom-1.5 left-1.5 rounded bg-black/65 px-1.5 py-0.5 text-[10px] font-semibold text-white/85">VIDEO</div> : null}
  </div></div>;
}
