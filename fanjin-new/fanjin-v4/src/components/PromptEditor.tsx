import React, { useCallback, useEffect, useRef, useState } from "react";

interface Reference {
  type: "image" | "video" | "audio" | "text";
  src: string;
}

interface Props {
  value?: string;
  onChange?: (value: string) => void;
  references?: Reference[];
  placeholder?: string;
}

export default function PromptEditor({ value = "", onChange, references = [], placeholder = "输入提示词…" }: Props) {
  const editorRef = useRef<HTMLDivElement>(null);
  const [showRefs, setShowRefs] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const internalUpdate = useRef(false);

  useEffect(() => {
    if (editorRef.current && !internalUpdate.current) {
      editorRef.current.textContent = value;
    }
    internalUpdate.current = false;
  }, [value]);

  const handleInput = useCallback(() => {
    if (!editorRef.current) return;
    internalUpdate.current = true;
    const text = editorRef.current.textContent || "";
    onChange?.(text);
  }, [onChange]);

  const handleKeydown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "@") {
      setShowRefs(true);
      setActiveIndex(0);
    }
    if (showRefs) {
      if (e.key === "ArrowDown") { e.preventDefault(); setActiveIndex((i) => Math.min(i + 1, references.length - 1)); }
      if (e.key === "ArrowUp") { e.preventDefault(); setActiveIndex((i) => Math.max(i - 1, 0)); }
      if (e.key === "Enter" && references.length) { e.preventDefault(); selectReference(activeIndex); }
      if (e.key === "Escape") { setShowRefs(false); }
    }
  }, [showRefs, activeIndex, references]);

  function selectReference(index: number) {
    const ref = references[index];
    if (!ref) return;
    setShowRefs(false);
    // Insert reference text at cursor
    const refText = `@参考${index + 1} `;
    document.execCommand("insertText", false, refText);
  }

  function handlePaste(e: React.ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of Array.from(items)) {
      if (item.type.startsWith("image/") || item.type.startsWith("video/")) {
        e.preventDefault();
        return;
      }
    }
  }

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <div
        ref={editorRef}
        contentEditable
        onInput={handleInput}
        onKeyDown={handleKeydown}
        onPaste={handlePaste}
        onBlur={() => setTimeout(() => setShowRefs(false), 200)}
        data-placeholder={placeholder}
        suppressContentEditableWarning
        style={{
          width: "100%", height: "100%", padding: 12, border: "none", outline: "none",
          fontSize: 14, lineHeight: 1.6, color: "#18181b", overflow: "auto", resize: "none",
          wordBreak: "break-word",
        }}
      />
      <style>{`
        [data-placeholder]:empty::before {
          content: attr(data-placeholder);
          color: #a1a1aa;
          pointer-events: none;
        }
      `}</style>

      {showRefs && references.length > 0 && (
        <div style={{ position: "absolute", bottom: "100%", left: 12, marginBottom: 8, width: 280, maxHeight: 200, overflow: "auto", border: "1px solid #e4e4e7", borderRadius: 10, background: "#fff", boxShadow: "0 4px 16px rgba(0,0,0,0.1)", zIndex: 100 }}>
          {references.map((ref, idx) => (
            <div
              key={idx}
              onClick={() => selectReference(idx)}
              style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", cursor: "pointer", background: idx === activeIndex ? "rgba(93,148,189,0.1)" : "transparent" }}
              onMouseEnter={() => setActiveIndex(idx)}
            >
              {ref.type === "image" ? (
                <img src={ref.src} alt="" style={{ width: 32, height: 32, borderRadius: 6, objectFit: "cover" }} />
              ) : (
                <span style={{ width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 6, background: "#f4f4f5", fontSize: 12, color: "#71717a" }}>
                  {ref.type === "video" ? "🎬" : ref.type === "audio" ? "🔊" : "文"}
                </span>
              )}
              <span style={{ fontSize: 13, color: "#18181b" }}>参考 {idx + 1}</span>
              <span style={{ marginLeft: "auto", fontSize: 11, color: "#a1a1aa", fontWeight: 600 }}>#{idx + 1}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
