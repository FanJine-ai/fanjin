import React, { useRef, useState } from "react";
import { apiPost } from "../../../api/http";
import type { StableSubmissionAttempt } from "../../../features/quick-create/submissionAttempt";
import {
  normalizeScriptUpdateAcknowledgement,
  resolveWritingSubmissionAttempt,
  writingSubmissionError,
} from "../../writing/writeSubmission";

interface EditScriptProps {
  open: boolean;
  item: {
    id: number | string;
    title?: string;
    content?: string;
    relatedAssets?: Array<{ id: number; name: string }>;
  };
  onClose: () => void;
}

export default function EditScript({ open, item, onClose }: EditScriptProps) {
  const inFlightRef = useRef(false);
  const attemptRef = useRef<StableSubmissionAttempt | null>(null);
  const [form, setForm] = useState({ title: item.title || "", content: item.content || "" });
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState("");
  if (!open) return null;
  async function handleSave() {
    if (inFlightRef.current || !form.title.trim() || !form.content.trim()) return;
    const id = Number(item.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      setSubmitError("剧本 ID 无效，无法保存");
      return;
    }
    const assets = (item.relatedAssets || []).map((asset) => Number(asset.id));
    if (
      assets.some((assetId) => !Number.isSafeInteger(assetId) || assetId <= 0)
      || new Set(assets).size !== assets.length
    ) {
      setSubmitError("关联素材数据无效，已阻止覆盖原有关联");
      return;
    }
    const payload = { id, name: form.title, content: form.content, assets };
    const attempt = resolveWritingSubmissionAttempt(
      attemptRef.current,
      `script-edit:${id}`,
      payload,
    );
    attemptRef.current = attempt;
    inFlightRef.current = true;
    setSaving(true);
    setSubmitError("");
    try {
      const result = await apiPost<unknown>(
        "/script/updateScript",
        payload,
        undefined,
        { headers: { "Idempotency-Key": attempt.idempotencyKey } },
      );
      normalizeScriptUpdateAcknowledgement(result, id);
      attemptRef.current = null;
      onClose();
    }
    catch (error) {
      setSubmitError(writingSubmissionError(error, "保存失败"));
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
	      <div className="writingModalPanel" role="dialog" aria-modal="true" aria-label="编辑脚本" data-testid="script-edit-dialog" style={{ width: 640, maxHeight: "80vh", background: "#fff", borderRadius: 12, padding: 24, overflow: "auto", display: "flex", flexDirection: "column" }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: "0 0 16px", color: "#18181b" }}>编辑脚本</h3>
	        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, fontWeight: 600, color: "#71717a", marginBottom: 12 }}>标题 <input data-testid="script-edit-title-input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required style={iS} /></label>
	        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, fontWeight: 600, color: "#71717a", flex: 1 }}>内容 <textarea data-testid="script-edit-content-input" value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} required style={{ ...iS, flex: 1, minHeight: 250, resize: "vertical", fontFamily: "inherit" }} /></label>
        {submitError ? <div role="alert" data-testid="script-edit-error" style={{ marginTop: 12, color: "#b91c1c", fontSize: 13 }}>{submitError}</div> : null}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
          <button onClick={requestClose} disabled={saving} style={{ padding: "8px 20px", borderRadius: 8, border: `1px solid ${"#e4e4e7"}`, background: "#fff", cursor: saving ? "not-allowed" : "pointer" }}>取消</button>
	          <button data-testid="script-edit-save-button" onClick={handleSave} disabled={saving || !form.title.trim() || !form.content.trim()} style={{ padding: "8px 20px", borderRadius: 8, border: "none", background: "#5d94bd", color: "#fff", cursor: saving || !form.title.trim() || !form.content.trim() ? "not-allowed" : "pointer", fontWeight: 600, opacity: saving || !form.title.trim() || !form.content.trim() ? 0.6 : 1 }}>{saving ? "保存中…" : "保存"}</button>
        </div>
      </div>
    </div>
  );
}
