import React from "react";

export function renderImageGridSplitOverlayExternal(deps: any, node: any): React.ReactNode {
  const { imageGridSplitEditor, setImageGridSplitEditor, buildGridCellKey, buildGridCellLabel, beginImageGridSplitDrag, imageGridSplitSuppressClickRef, toggleImageGridSplitSelection } = deps;
  const renderImageGridSplitOverlay = (node: any) => {
    if (imageGridSplitEditor?.nodeId !== node.id) return null;
    const { rows, cols, selectedCells, hoveredCell } = imageGridSplitEditor;
    return (
      <div className="absolute inset-0 z-10" onMouseLeave={() => setImageGridSplitEditor((prev: any) => (prev ? { ...prev, hoveredCell: null } : prev))}>
        {Array.from({ length: rows * cols }, (_, index) => {
          const row = Math.floor(index / cols);
          const col = index % cols;
          const cellKey = buildGridCellKey(row, col);
          const left = `${(col / cols) * 100}%`;
          const top = `${(row / rows) * 100}%`;
          const width = `${100 / cols}%`;
          const height = `${100 / rows}%`;
          const label = buildGridCellLabel(row, col);
          const selected = selectedCells.includes(cellKey);
          const hovered = hoveredCell === cellKey;
          return (
            <button
              key={cellKey}
              type="button"
              className={`absolute border transition ${selected ? "border-[#78d7ff] bg-white/14 shadow-[inset_0_0_0_1px_rgba(120,215,255,0.58)]" : hovered ? "border-white/70 bg-white/10" : "border-white/28 bg-black/4 hover:border-white/55 hover:bg-white/8"}`}
              style={{ left, top, width, height }}
              onMouseEnter={() => setImageGridSplitEditor((prev: any) => (prev ? { ...prev, hoveredCell: cellKey } : prev))}
              onMouseDown={(event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                event.stopPropagation();
                beginImageGridSplitDrag(node.id, cellKey, rows, cols, event.clientX, event.clientY);
              }}
              onClick={(event) => {
                if (imageGridSplitSuppressClickRef.current) {
                  imageGridSplitSuppressClickRef.current = false;
                  event.preventDefault();
                  event.stopPropagation();
                  return;
                }
                event.stopPropagation();
                toggleImageGridSplitSelection(cellKey, event.shiftKey);
              }}
            >
              <div className="pointer-events-none absolute inset-0 border border-white/12" />
              {selected || hovered ? (
                <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-[10px] bg-black/62 px-3 py-1.5 text-[16px] font-semibold text-white shadow-[0_10px_28px_rgba(0,0,0,0.3)]">
                  {label}
                </div>
              ) : null}
              {hovered ? (
                <div className="pointer-events-none absolute left-1/2 top-1/2 mt-11 -translate-x-1/2 rounded-[10px] bg-black/62 px-3 py-1.5 text-[11px] font-medium whitespace-nowrap text-white/88">
                  按住Shift键可批量选择
                </div>
              ) : null}
            </button>
          );
        })}
      </div>
    );
  };
  return renderImageGridSplitOverlay(node);
}
