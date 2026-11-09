import React, { useEffect, useState } from "react";

interface Props {
  open: boolean;
  content: string;
  onConfirm: (content: string) => void;
  onCancel: () => void;
}

export default function EditMdPreview({ open, content, onConfirm, onCancel }: Props) {
  const [editContent, setEditContent] = useState(content);

  useEffect(() => {
    if (open) setEditContent(content);
  }, [open, content]);

  if (!open) return null;

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 10000, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.3)" }} onClick={onCancel}>
      <div style={{ width: "90vw", maxHeight: "85vh", background: "#fff", borderRadius: 12, display: "flex", flexDirection: "column", overflow: "hidden" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 20px", borderBottom: "1px solid #e4e4e7" }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>编辑预览</h3>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={onCancel} style={{ padding: "6px 16px", border: "1px solid #e4e4e7", borderRadius: 8, background: "#fff", cursor: "pointer", fontSize: 13 }}>取消</button>
            <button onClick={() => { onConfirm(editContent); onCancel(); }} style={{ padding: "6px 16px", border: "none", borderRadius: 8, background: "#5d94bd", color: "#fff", cursor: "pointer", fontSize: 13 }}>确认</button>
          </div>
        </div>
        <div style={{ flex: 1, padding: 16 }}>
          <textarea
            value={editContent}
            onChange={(e) => setEditContent(e.target.value)}
            style={{ width: "100%", height: "72vh", padding: 12, border: "1px solid #e4e4e7", borderRadius: 8, fontSize: 14, fontFamily: "monospace", resize: "none", outline: "none", lineHeight: 1.6 }}
            placeholder="编辑 Markdown 内容…"
          />
        </div>
      </div>
    </div>
  );
}
