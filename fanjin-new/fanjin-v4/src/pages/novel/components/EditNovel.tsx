import React, { useRef, useState } from "react";
import { apiPost } from "../../../api/http";
import type { StableSubmissionAttempt } from "../../../features/quick-create/submissionAttempt";
import {
  normalizeNovelUpdateAcknowledgement,
  resolveWritingSubmissionAttempt,
  writingSubmissionError,
} from "../../writing/writeSubmission";

interface EditNovelProps {
  open: boolean;
  item: { id: number | string; title?: string; content?: string; index?: number | string; event?: string };
  onClose: () => void;
}

export default function EditNovel({ open, item, onClose }: EditNovelProps) {
  const inFlightRef = useRef(false);
  const attemptRef = useRef<StableSubmissionAttempt | null>(null);
  const [title, setTitle] = useState(item.title || "");
  const [content, setContent] = useState(item.content || "");
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState("");

  if (!open) return null;

  async function handleSave() {
    if (inFlightRef.current || !title.trim() || !content.trim()) return;
    const id = Number(item.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      setSubmitError("小说章节 ID 无效，无法保存");
      return;
    }
    const payload = {
      id,
      index: item.index || 1,
      reel: title,
      chapter: title,
      chapterData: content,
      event: item.event || "",
    };
    const attempt = resolveWritingSubmissionAttempt(
      attemptRef.current,
      `novel-edit:${id}`,
      payload,
    );
    attemptRef.current = attempt;
    inFlightRef.current = true;
    setSaving(true);
    setSubmitError("");
    try {
      const result = await apiPost<unknown>(
        "/novel/updateNovel",
        payload,
        undefined,
        { headers: { "Idempotency-Key": attempt.idempotencyKey } },
      );
      normalizeNovelUpdateAcknowledgement(result);
      attemptRef.current = null;
      onClose();
    } catch (error) {
      setSubmitError(writingSubmissionError(error, "保存失败"));
    } finally {
      inFlightRef.current = false;
      setSaving(false);
    }
  }

  const inputStyle: React.CSSProperties = { padding: "8px 12px", border: `1px solid ${"#e4e4e7"}`, borderRadius: 8, fontSize: 14, color: "#18181b", outline: "none", width: "100%", boxSizing: "border-box" };

  function requestClose() {
    if (!inFlightRef.current) onClose();
  }

  return (
    <div className="writingModalBackdrop" style={{ position: "fixed", inset: 0, zIndex: 10000, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center" }} onClick={requestClose}>
      <div className="writingModalPanel" role="dialog" aria-modal="true" aria-label="编辑小说" data-testid="novel-edit-dialog" style={{ width: 640, maxHeight: "80vh", background: "#fff", borderRadius: 12, padding: 24, overflow: "auto", display: "flex", flexDirection: "column" }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: "0 0 16px", color: "#18181b" }}>编辑小说</h3>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, fontWeight: 600, color: "#71717a", marginBottom: 12 }}>
          标题
          <input data-testid="novel-edit-title-input" value={title} onChange={(e) => setTitle(e.target.value)} required style={inputStyle} />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, fontWeight: 600, color: "#71717a", flex: 1 }}>
          内容
          <textarea data-testid="novel-edit-content-input" value={content} onChange={(e) => setContent(e.target.value)} required style={{ ...inputStyle, flex: 1, minHeight: 300, resize: "vertical", fontFamily: "inherit" }} />
        </label>
        {submitError ? <div role="alert" data-testid="novel-edit-error" style={{ marginTop: 12, color: "#b91c1c", fontSize: 13 }}>{submitError}</div> : null}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
          <button onClick={requestClose} disabled={saving} style={{ padding: "8px 20px", borderRadius: 8, border: `1px solid ${"#e4e4e7"}`, background: "#fff", cursor: saving ? "not-allowed" : "pointer" }}>取消</button>
          <button data-testid="novel-edit-save-button" onClick={handleSave} disabled={saving || !title.trim() || !content.trim()} style={{ padding: "8px 20px", borderRadius: 8, border: "none", background: "#5d94bd", color: "#fff", cursor: saving || !title.trim() || !content.trim() ? "not-allowed" : "pointer", fontWeight: 600, opacity: saving || !title.trim() || !content.trim() ? 0.6 : 1 }}>{saving ? "保存中…" : "保存"}</button>
        </div>
      </div>
    </div>
  );
}
