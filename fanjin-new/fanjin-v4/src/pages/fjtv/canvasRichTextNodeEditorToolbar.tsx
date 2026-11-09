import React from "react";
import type { NodeData, TextNodeHeading, TextNodeListStyle } from "./canvasDataTypes";
import type { LucideIcon } from "lucide-react";

interface RichTextToolbarDependencies {
  TEXT_BACKGROUND_SWATCHES: readonly { key: string; color: string; bg: string; ring: string }[];
  setTextNodePatchAndPersist: (id: string, patch: Partial<NodeData>) => void;
  applyTextListStyleToValue: (value: string, style: TextNodeListStyle) => string;
  editingTextNodeId: string | null;
  textEditorDraft: string;
  updateTextNodeContentAndStyle: (id: string, value: string, patch: Partial<NodeData>) => void;
  setStatus: (value: string) => void;
  setTextColorMenuNodeId: React.Dispatch<React.SetStateAction<string | null>>;
  textColorMenuNodeId: string | null;
  Rows3: LucideIcon;
  Columns3: LucideIcon;
  Minus: LucideIcon;
  Copy: LucideIcon;
  Expand: LucideIcon;
  toggleTextNodeExpanded: (node: NodeData) => void;
}

export function renderRichTextNodeEditorToolbarExternal(node: NodeData, deps: RichTextToolbarDependencies) {
    const { TEXT_BACKGROUND_SWATCHES, setTextNodePatchAndPersist, applyTextListStyleToValue, editingTextNodeId, textEditorDraft, updateTextNodeContentAndStyle, setStatus, setTextColorMenuNodeId, textColorMenuNodeId, Rows3, Columns3, Minus, Copy, Expand, toggleTextNodeExpanded } = deps;
    const activeColor = TEXT_BACKGROUND_SWATCHES.find((item) => item.color === node.textBackgroundColor) || TEXT_BACKGROUND_SWATCHES[0];
    const toolbarButtonClass = "flex h-11 min-w-11 items-center justify-center rounded-[10px] px-2 text-[24px] font-medium text-[#b9bbc0] transition hover:bg-[#333336] hover:text-white";
    const separator = <div className="mx-2 h-8 w-px bg-[#3c3d42]" />;
    const applyHeading = (heading: TextNodeHeading) => setTextNodePatchAndPersist(node.id, { textHeading: heading });
    const toggleList = (style: TextNodeListStyle) => {
      const nextStyle = node.textListStyle === style ? "none" : style;
      const nextText = applyTextListStyleToValue(editingTextNodeId === node.id ? textEditorDraft : node.outputText || "", nextStyle);
      updateTextNodeContentAndStyle(node.id, nextText, { textListStyle: nextStyle });
    };
    const copyText = () => {
      const text = editingTextNodeId === node.id ? textEditorDraft : node.outputText || "";
      void navigator.clipboard?.writeText(text);
      setStatus("文本已复制");
    };
    return (
      <div
        data-text-editor
        data-node-toolbar
        className="absolute z-30 flex items-center rounded-[18px] border border-[#35363a] bg-[#292929] px-7 py-3 text-white shadow-[0_20px_42px_rgba(0,0,0,0.38)]"
        style={{ left: node.x + node.width / 2, top: node.y - 90, transform: "translateX(-50%)" }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="relative">
          <button
            type="button"
            className={toolbarButtonClass}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setTextColorMenuNodeId((current) => (current === node.id ? null : node.id));
            }}
          >
            {node.textBackgroundColor ? (
              <span className="block h-7 w-7 rounded-full" style={{ backgroundColor: activeColor.bg }} />
            ) : (
              <span className="relative block h-7 w-7 rounded-full bg-[#343434]">
                <span className="absolute left-1/2 top-1/2 h-[2px] w-8 -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-full bg-[#d73c3c]" />
              </span>
            )}
          </button>
          {textColorMenuNodeId === node.id ? (
            <div data-node-floating-menu className="absolute left-0 top-[58px] z-40 grid w-[420px] grid-cols-5 gap-7 rounded-[18px] border border-white/8 bg-[#292929] px-7 py-7 shadow-[0_24px_54px_rgba(0,0,0,0.45)]">
              {TEXT_BACKGROUND_SWATCHES.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className="relative flex h-12 w-12 items-center justify-center rounded-full transition hover:scale-105"
                  style={{ backgroundColor: item.key === "none" ? "#343434" : item.bg, boxShadow: item.color === node.textBackgroundColor ? `0 0 0 4px ${item.ring}` : "none" }}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setTextColorMenuNodeId(null);
                    setTextNodePatchAndPersist(node.id, { textBackgroundColor: item.color || undefined });
                  }}
                >
                  {item.key === "none" ? <span className="h-[2px] w-12 rotate-45 rounded-full bg-[#d73c3c]" /> : null}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        {separator}
        {(["h1", "h2", "h3"] as const).map((heading) => (
          <button
            key={heading}
            type="button"
            className={`${toolbarButtonClass} ${node.textHeading === heading ? "text-white" : ""}`}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              applyHeading(heading);
            }}
          >
            {heading.toUpperCase()}
          </button>
        ))}
        <button
          type="button"
          className={`${toolbarButtonClass} ${!node.textHeading || node.textHeading === "body" ? "text-white" : ""}`}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            applyHeading("body");
          }}
        >
          ¶
        </button>
        {separator}
        <button
          type="button"
          className={`${toolbarButtonClass} ${node.textBold ? "text-white" : ""}`}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setTextNodePatchAndPersist(node.id, { textBold: !node.textBold });
          }}
        >
          B
        </button>
        <button
          type="button"
          className={`${toolbarButtonClass} italic ${node.textItalic ? "text-white" : ""}`}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setTextNodePatchAndPersist(node.id, { textItalic: !node.textItalic });
          }}
        >
          I
        </button>
        {separator}
        <button
          type="button"
          className={`${toolbarButtonClass} ${node.textListStyle === "bullet" ? "text-white" : ""}`}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            toggleList("bullet");
          }}
        >
          <Rows3 className="h-7 w-7" />
        </button>
        <button
          type="button"
          className={`${toolbarButtonClass} ${node.textListStyle === "number" ? "text-white" : ""}`}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            toggleList("number");
          }}
        >
          <Columns3 className="h-7 w-7" />
        </button>
        {separator}
        <button
          type="button"
          className={`${toolbarButtonClass} ${node.textDivider ? "text-white" : ""}`}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setTextNodePatchAndPersist(node.id, { textDivider: !node.textDivider });
          }}
        >
          <Minus className="h-7 w-7" />
        </button>
        {separator}
        <button
          type="button"
          className={toolbarButtonClass}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            copyText();
          }}
        >
          <Copy className="h-7 w-7" />
        </button>
        <button
          type="button"
          className={`${toolbarButtonClass} ${node.textExpanded ? "text-white" : ""}`}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            toggleTextNodeExpanded(node);
          }}
        >
          <Expand className="h-7 w-7" />
        </button>
      </div>
    );
  }
