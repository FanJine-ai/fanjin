import type React from "react";
import type { NodeData } from "./canvasDataTypes";
import { splitPromptSegments } from "./canvasPromptReferences";

export interface PromptEditorOptions {
  value: string;
  placeholder: string;
  textareaClassName: string;
  previewClassName: string;
}
interface PromptEditorDependencies {
  expanded: boolean;
  activeNode: NodeData | null | undefined;
  bindPromptTextarea: React.RefCallback<HTMLTextAreaElement>;
  handlePromptInputChange: (value: string, element: HTMLTextAreaElement) => void;
  rememberPromptSelection: (element: HTMLTextAreaElement) => void;
  canvasColorMode: string;
  promptTextareaRef: React.RefObject<HTMLTextAreaElement | null>;
  promptEditorScroll: { left: number; top: number };
  renderPromptReferenceCapsule: (label: string) => React.ReactNode;
  handlePromptTextareaKeyDown: React.KeyboardEventHandler<HTMLTextAreaElement>;
  syncPromptEditorScroll: (element: HTMLTextAreaElement) => void;
}

export function renderPromptEditorExternal(options: PromptEditorOptions, deps: PromptEditorDependencies) {
    const { value, placeholder, textareaClassName, previewClassName } = options;
    const { expanded, activeNode, bindPromptTextarea, handlePromptInputChange, rememberPromptSelection, canvasColorMode, promptTextareaRef, promptEditorScroll, renderPromptReferenceCapsule, handlePromptTextareaKeyDown, syncPromptEditorScroll } = deps;
    const segments = splitPromptSegments(value);
    const hasReferenceSegments = segments.some((segment) => segment.type === "reference");
    if (expanded) {
      return (
        <div data-prompt-editor className="relative h-full min-h-0 w-full" onWheelCapture={(event) => event.stopPropagation()}>
          {value ? null : (
            <div
              data-prompt-preview
              className={`pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words ${previewClassName}`}
              style={{ writingMode: "horizontal-tb", textOrientation: "mixed" }}
            >
              <span className="text-inherit opacity-70">{placeholder}</span>
            </div>
          )}
          <textarea
            key={`expanded-prompt-${activeNode?.id ?? "node"}`}
            ref={bindPromptTextarea}
            className={`mh-prompt-scrollbar relative z-10 block h-full min-h-full w-full resize-none overscroll-contain bg-transparent text-white caret-white selection:bg-[#7ea1ff]/35 ${textareaClassName}`}
            value={value}
            rows={4}
            autoFocus
            spellCheck={false}
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onWheel={(e) => e.stopPropagation()}
            onChange={(e) => handlePromptInputChange(e.currentTarget.value, e.currentTarget)}
            onSelect={(e) => rememberPromptSelection(e.currentTarget)}
            style={{
              writingMode: "horizontal-tb",
              textOrientation: "mixed",
              caretColor: canvasColorMode === "light" ? "#111827" : "#ffffff",
              color: canvasColorMode === "light" ? "#111827" : "#ffffff",
              WebkitTextFillColor: canvasColorMode === "light" ? "#111827" : "#ffffff",
            }}
          />
        </div>
      );
    }
    return (
      <div
        data-prompt-editor
        className="relative h-full min-h-0 w-full"
        onWheelCapture={(event) => event.stopPropagation()}
        onMouseDown={(event) => {
          const target = event.target as HTMLElement;
          if (target.tagName.toLowerCase() === "textarea") return;
          window.setTimeout(() => {
            promptTextareaRef.current?.focus();
          }, 0);
        }}
      >
        {hasReferenceSegments || segments.length === 0 ? (
          <div
            data-prompt-preview
            className={`pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words ${previewClassName}`}
            style={{ writingMode: "horizontal-tb", textOrientation: "mixed" }}
          >
            <div
              style={{
                transform: `translate(${-promptEditorScroll.left}px, ${-promptEditorScroll.top}px)`,
                minHeight: "100%",
              }}
            >
              {segments.length === 0 ? (
                <span className="text-inherit opacity-70">{placeholder}</span>
              ) : (
                segments.map((segment, index) =>
                  segment.type === "reference" ? (
                    <span key={`ref-${index}`}>{renderPromptReferenceCapsule(segment.value)}</span>
                  ) : (
                    <span key={`text-${index}`}>{segment.value}</span>
                  ),
                )
              )}
            </div>
          </div>
        ) : null}
        <textarea
          ref={bindPromptTextarea}
          className={`mh-prompt-scrollbar relative z-10 block h-full min-h-full w-full overscroll-contain caret-white selection:bg-[#7ea1ff]/35 ${hasReferenceSegments ? "text-transparent" : "text-[#f3f4f6]"} ${textareaClassName}`}
          value={value}
          rows={4}
          spellCheck={false}
          onMouseDown={(e) => e.stopPropagation()}
          onWheel={(e) => e.stopPropagation()}
          onChange={(e) => handlePromptInputChange(e.target.value, e.currentTarget)}
          onKeyDown={handlePromptTextareaKeyDown}
          onClick={(e) => rememberPromptSelection(e.currentTarget)}
          onFocus={(e) => rememberPromptSelection(e.currentTarget)}
          onKeyUp={(e) => rememberPromptSelection(e.currentTarget)}
          onSelect={(e) => rememberPromptSelection(e.currentTarget)}
          onScroll={(e) => syncPromptEditorScroll(e.currentTarget)}
          style={{
            writingMode: "horizontal-tb",
            textOrientation: "mixed",
            color: hasReferenceSegments ? "transparent" : canvasColorMode === "light" ? "#111827" : "#f3f4f6",
            WebkitTextFillColor: hasReferenceSegments ? "transparent" : canvasColorMode === "light" ? "#111827" : "#f3f4f6",
            caretColor: canvasColorMode === "light" ? "#111827" : "#ffffff",
          }}
        />
      </div>
    );
  }
