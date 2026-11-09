import React, { useRef, useState } from "react";
import { apiPost } from "../../../api/http";
import type { StableSubmissionAttempt } from "../../../features/quick-create/submissionAttempt";
import {
  normalizeScriptAddAcknowledgement,
  resolveWritingSubmissionAttempt,
  writingSubmissionError,
} from "../../writing/writeSubmission";

interface AddScriptProps {
  open: boolean;
  onClose: () => void;
  projectId?: number | string;
  autoCreateStoryboardDrafts?: boolean;
}

export default function AddScript({ open, onClose, projectId, autoCreateStoryboardDrafts = false }: AddScriptProps) {
  const inFlightRef = useRef(false);
  const attemptRef = useRef<StableSubmissionAttempt | null>(null);
  const [form, setForm] = useState({ title: "", content: "" });
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState("");
  if (!open) return null;
  async function handleSave() {
    if (inFlightRef.current || !form.title.trim() || !form.content.trim() || !projectId) return;
    const payload = {
      name: form.title,
      content: form.content,
      projectId: Number(projectId),
      assets: [] as number[],
      autoCreateStoryboardDrafts,
    };
    const attempt = resolveWritingSubmissionAttempt(
      attemptRef.current,
      `script-add:${Number(projectId)}`,
      payload,
    );
    attemptRef.current = attempt;
    inFlightRef.current = true;
    setSaving(true);
    setSubmitError("");
    try {
      const result = await apiPost<unknown>(
        "/script/addScript",
        payload,
        undefined,
        { headers: { "Idempotency-Key": attempt.idempotencyKey } },
      );
      normalizeScriptAddAcknowledgement(result);
      attemptRef.current = null;
      onClose();
    }
    catch (error) {
      setSubmitError(writingSubmissionError(error, "创建失败"));
    } finally {
      inFlightRef.current = false;
      setSaving(false);
    }
  }
  function requestClose() {
    if (!inFlightRef.current) onClose();
  }
  const iS: React.CSSProperties = { padding: "8px 12px", border: `1px solid ${"#e4e4e7"}`, borderRadius: 8, fontSize: 14, color: "#18181b", outline: "none", width: "100%", boxSizing: "border-box" };
  return (
	    <div className="writingModalBackdrop" style={{ position: "fixed", inset: 0, zIndex: 10000, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center" }} onClick={requestClose}>
	      <div className="writingModalPanel" role="dialog" aria-modal="true" aria-label="新增脚本" data-testid="script-add-dialog" style={{ width: 560, maxHeight: "80vh", background: "#fff", borderRadius: 12, padding: 24, overflow: "auto" }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: "0 0 16px", color: "#18181b" }}>新增脚本</h3>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
	          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, fontWeight: 600, color: "#71717a" }}>标题 <input data-testid="script-title-input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="脚本标题" required style={iS} /></label>
	          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, fontWeight: 600, color: "#71717a" }}>内容 <textarea data-testid="script-content-input" value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} rows={6} placeholder="脚本内容…" required style={{ ...iS, resize: "vertical", fontFamily: "inherit" }} /></label>
        </div>
        {submitError ? <div role="alert" data-testid="script-add-error" style={{ marginTop: 12, color: "#b91c1c", fontSize: 13 }}>{submitError}</div> : null}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
          <button onClick={requestClose} disabled={saving} style={{ padding: "8px 20px", borderRadius: 8, border: `1px solid ${"#e4e4e7"}`, background: "#fff", cursor: saving ? "not-allowed" : "pointer" }}>取消</button>
	          <button data-testid="script-save-button" onClick={handleSave} disabled={saving || !projectId || !form.title.trim() || !form.content.trim()} style={{ padding: "8px 20px", borderRadius: 8, border: "none", background: "#5d94bd", color: "#fff", cursor: saving || !projectId || !form.title.trim() || !form.content.trim() ? "not-allowed" : "pointer", fontWeight: 600, opacity: saving || !projectId || !form.title.trim() || !form.content.trim() ? 0.6 : 1 }}>{saving ? "创建中…" : "创建"}</button>
        </div>
      </div>
    </div>
  );
}
