import { PenLine } from "lucide-react";

export const CANVAS_COMPACT_EDITOR_ZOOM_THRESHOLD = 0.5;
export const CANVAS_INLINE_NODE_EDITOR_WIDTH = 940;
export const CANVAS_INLINE_NODE_EDITOR_HORIZONTAL_INSET = 16;
export const CANVAS_INLINE_NODE_EDITOR_MIN_AVAILABLE_WIDTH =
  CANVAS_INLINE_NODE_EDITOR_WIDTH + CANVAS_INLINE_NODE_EDITOR_HORIZONTAL_INSET * 2;

export function shouldUseCompactNodeEditor(
  scale: number,
  availableWidth = Number.POSITIVE_INFINITY,
) {
  const zoomNeedsCompact =
    Number.isFinite(scale) && scale < CANVAS_COMPACT_EDITOR_ZOOM_THRESHOLD;
  const widthNeedsCompact =
    Number.isFinite(availableWidth)
    && availableWidth < CANVAS_INLINE_NODE_EDITOR_MIN_AVAILABLE_WIDTH;

  return zoomNeedsCompact || widthNeedsCompact;
}

export type CanvasNodeEditorPresentation = "compact" | "inline" | "expanded";

export function getCanvasNodeEditorPresentation(
  scale: number,
  expanded: boolean,
  availableWidth = Number.POSITIVE_INFINITY,
): CanvasNodeEditorPresentation {
  if (expanded) return "expanded";
  return shouldUseCompactNodeEditor(scale, availableWidth) ? "compact" : "inline";
}

export function getCompactNodeEditorSummary(prompt: string) {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  return normalized || "尚未填写创作描述";
}

interface CanvasCompactNodeEditorLauncherProps {
  nodeId: string;
  left: number;
  top: number;
  width?: number;
  nodeTitle: string;
  prompt: string;
  fontFamily: string;
  onEdit: () => void;
}

export function CanvasCompactNodeEditorLauncher({
  nodeId,
  left,
  top,
  width,
  nodeTitle,
  prompt,
  fontFamily,
  onEdit,
}: CanvasCompactNodeEditorLauncherProps) {
  const summary = getCompactNodeEditorSummary(prompt);
  const accessibleTitle = nodeTitle.trim() || "当前节点";

  return (
    <div
      data-fixed-ui
      data-node-prompt-panel
      data-node-compact-editor-launcher
      data-node-id={nodeId}
      data-node-editor-presentation="compact"
      role="group"
      aria-label={`${accessibleTitle}编辑摘要`}
      className="absolute z-[80] flex items-center gap-3 rounded-[14px] border border-[#3f4042] bg-[#2a2a2a] p-2 pl-3 text-white shadow-[0_18px_38px_rgba(0,0,0,0.42)]"
      style={{
        width: width === undefined ? "min(312px, calc(100vw - 32px))" : `${width}px`,
        left,
        top,
        transform: "translateX(-50%)",
        fontFamily,
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] font-semibold text-[#f0f1f3]">{accessibleTitle}</div>
        <div
          data-node-compact-editor-summary
          className="mt-1 truncate text-[12px] leading-5 text-[#9ea2aa]"
          title={summary}
        >
          {summary}
        </div>
      </div>
      <button
        type="button"
        data-node-compact-editor-button
        aria-label={`编辑节点 ${accessibleTitle}`}
        className="inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-[10px] border border-[#55575b] bg-[#343436] px-3 text-[12px] font-semibold text-white transition-colors duration-150 hover:border-[#6c6e73] hover:bg-[#404043] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8ccfff] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--canvas-overlay-surface)]"
        onClick={onEdit}
      >
        <PenLine className="h-3.5 w-3.5" aria-hidden="true" />
        编辑
      </button>
    </div>
  );
}
