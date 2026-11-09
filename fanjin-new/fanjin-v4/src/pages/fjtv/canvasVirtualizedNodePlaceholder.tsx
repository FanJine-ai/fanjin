import type * as React from "react";

export function renderVirtualizedNodePlaceholder(node: any, renderCanvasNodeGlyph: (type: string) => React.ReactNode): React.ReactNode {
  return <div className="flex h-full w-full items-center justify-center rounded-[16px] border border-[#2f2f31] bg-[#252525] text-[#555557]">{renderCanvasNodeGlyph(node.type)}</div>;
}
