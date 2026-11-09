import type * as React from "react";

export function renderTextDownloadButton(node: any, downloadTextNodeAsTxt: (node: any) => void, Download: React.ComponentType<any>): React.ReactNode {
  return <button data-node-toolbar className="absolute z-30 flex h-16 w-16 items-center justify-center rounded-[18px] border border-[#4a4b50] bg-[#2a2a2b] text-white shadow-[0_20px_42px_rgba(0,0,0,0.38)] transition hover:bg-[#323234]"
    style={{ left: node.x + node.width / 2 - 32, top: node.y - 124 }} onMouseDown={(event) => {
      event.preventDefault(); event.stopPropagation(); downloadTextNodeAsTxt(node);
    }}><Download className="h-8 w-8" /></button>;
}
