import type * as React from "react";

export function renderNodeEditorPositionToggle(nodeEditorPinned: boolean, setNodeEditorPinned: (next: (current: boolean) => boolean) => void): React.ReactNode {
  return <button type="button" aria-pressed={nodeEditorPinned}
    onClick={() => setNodeEditorPinned((current) => !current)}
    className="absolute -top-11 left-0 h-10 rounded-lg border border-[#55575b] bg-[#282828] px-3 text-[13px] text-white shadow-md">
    {nodeEditorPinned ? "跟随节点" : "固定参数面板"}
  </button>;
}
