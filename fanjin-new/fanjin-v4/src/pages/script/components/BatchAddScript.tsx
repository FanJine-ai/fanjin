import React, { useEffect, useMemo, useRef, useState } from "react";
import { apiPost } from "../../../api/http";
import type { StableSubmissionAttempt } from "../../../features/quick-create/submissionAttempt";
import {
  normalizeScriptBatchAcknowledgement,
  resolveWritingSubmissionAttempt,
  writingSubmissionError,
} from "../../writing/writeSubmission";
import { extractScriptImportFile, SCRIPT_IMPORT_ACCEPT } from "../scriptImportFile";
import { looksLikeScriptJson, parseBatchScriptText, type ScriptSplitMode } from "../scriptBatchText";

interface BatchAddScriptProps {
  open: boolean;
  onClose: () => void;
  projectId?: number | string;
  autoCreateStoryboardDrafts?: boolean;
}

export default function BatchAddScript({ open, onClose, projectId, autoCreateStoryboardDrafts = false }: BatchAddScriptProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const inFlightRef = useRef(false);
  const attemptRef = useRef<StableSubmissionAttempt | null>(null);
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState("");
  const [uploading, setUploading] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [reading, setReading] = useState(false);
  const [splitMode, setSplitMode] = useState<ScriptSplitMode>("auto");
  const readEpoch = useRef(0);
  useEffect(() => {
    readEpoch.current += 1;
    setReading(false);
    setText("");
    setFileName("");
    setSubmitError("");
    setSplitMode("auto");
    attemptRef.current = null;
    return () => { readEpoch.current += 1; };
  }, [open, projectId]);
  const preview = useMemo(() => {
    try { return { data: parseBatchScriptText(text, splitMode, /\.json$/i.test(fileName)), error: "" }; }
    catch (error) { return { data: [], error: writingSubmissionError(error, "请检查剧本内容") }; }
  }, [text, splitMode, fileName]);
  const importDisabled = uploading || reading || !projectId || !preview.data.length || Boolean(preview.error);
  if (!open) return null;
  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    event.target.value = "";
    const epoch = ++readEpoch.current;
    setFileName(file.name);
    setText("");
    setReading(true);
    try {
      setSubmitError("");
      const result = await extractScriptImportFile(file, Number(projectId));
      if (epoch === readEpoch.current) setText(result.text);
    } catch (error) {
      if (epoch === readEpoch.current) setSubmitError(writingSubmissionError(error, "文件读取失败"));
    } finally {
      if (epoch === readEpoch.current) setReading(false);
    }
  }
  async function handleImport() {
    if (inFlightRef.current || importDisabled) return;
    const data = preview.data;
    if (!data.length) return;
    const payload = { projectId: Number(projectId), data, autoCreateStoryboardDrafts };
    const epoch = readEpoch.current;
    const attempt = resolveWritingSubmissionAttempt(
      attemptRef.current,
      `script-batch:${Number(projectId)}`,
      payload,
    );
    attemptRef.current = attempt;
    inFlightRef.current = true;
    setUploading(true);
    setSubmitError("");
    try {
      const result = await apiPost<unknown>(
        "/script/batchAddScript",
        payload,
        undefined,
        { headers: { "Idempotency-Key": attempt.idempotencyKey } },
      );
      normalizeScriptBatchAcknowledgement(result, data.length);
      if (epoch === readEpoch.current) {
        attemptRef.current = null;
        onClose();
      }
    } catch (error) {
      if (epoch === readEpoch.current) setSubmitError(writingSubmissionError(error, "导入失败"));
    } finally {
      inFlightRef.current = false;
      setUploading(false);
    }
  }
  function requestClose() {
    if (!inFlightRef.current) {
      readEpoch.current += 1;
      onClose();
    }
  }
  return (
    <div className="writingModalBackdrop" style={{ position: "fixed", inset: 0, zIndex: 10000, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center" }} onClick={requestClose}>
	      <div className="writingModalPanel" role="dialog" aria-modal="true" aria-label="批量导入脚本" data-testid="script-batch-dialog" style={{ width: 560, maxHeight: "80vh", background: "#fff", borderRadius: 12, padding: 24, overflow: "auto" }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: "0 0 16px", color: "#18181b" }}>批量导入脚本</h3>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <label style={{ fontSize: 13, fontWeight: 600, color: "#71717a" }}>
            上传文件
            <input ref={fileRef} type="file" accept={SCRIPT_IMPORT_ACCEPT} disabled={uploading} onChange={(event) => void handleFileChange(event)} style={{ position: "absolute", width: 1, height: 1, opacity: 0 }} />
            <button type="button" disabled={uploading} onClick={() => fileRef.current?.click()} style={{ display: "block", width: "100%", marginTop: 4, padding: "8px 12px", border: "1px solid #e4e4e7", borderRadius: 8, background: "#fafafa", textAlign: "left", cursor: "pointer" }}>
              {fileName || "选择 Word / 文本 / PDF 文件"}
            </button>
          </label>
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-200, #71717a)" }}>支持 DOC、DOCX、TXT、Markdown、JSON 和文字型 PDF，单个文件最大 20MB。</p>
          {reading ? <div role="status" style={{ fontSize: 13 }}>正在解析文件…</div> : null}
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, fontWeight: 600, color: "#71717a" }}>
            正文预览与编辑，也可直接粘贴文本 / JSON
	            <textarea data-testid="script-batch-textarea" value={text} disabled={reading || uploading} onChange={(e) => { setText(e.target.value); setSubmitError(""); }} rows={8} placeholder={'第一场：街道 外/日\n在这里粘贴剧本正文，或选择文件解析。'} style={{ padding: 8, border: "1px solid #e4e4e7", borderRadius: 8, fontSize: 13, resize: "vertical", outline: "none", fontFamily: "inherit" }} />
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 13 }}>
            <span style={{ flexShrink: 0 }}>拆分方式</span>
            <select aria-label="拆分方式" value={splitMode} disabled={reading || uploading || /\.json$/i.test(fileName) || looksLikeScriptJson(text)} onChange={(e) => setSplitMode(e.target.value as ScriptSplitMode)} style={{ padding: "6px 10px", border: "1px solid #e4e4e7", borderRadius: 8, background: "#fff" }}>
              <option value="auto">自动识别场次</option>
              <option value="whole">保留为一个剧本</option>
              <option value="paragraphs">按空行拆分</option>
            </select>
          </label>
          {!reading && preview.data.length ? <div role="status" style={{ fontSize: 13, lineHeight: 1.7 }}>
            <strong>预计导入 {preview.data.length} 个剧本</strong>
            <div style={{ color: "var(--text-200, #71717a)", overflowWrap: "anywhere" }}>{preview.data.slice(0, 3).map((item) => item.scriptName).join(" · ")}{preview.data.length > 3 ? " …" : ""}</div>
          </div> : <p style={{ margin: 0, fontSize: 12, color: "var(--text-200, #71717a)" }}>按文档原顺序导入；未识别到场次标题时保留为一个剧本。JSON 按数组顺序导入。</p>}
        </div>
        {submitError || preview.error ? <div role="alert" data-testid="script-batch-error" style={{ marginTop: 12, color: "#b91c1c", fontSize: 13 }}>{submitError || preview.error}</div> : null}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
          <button onClick={requestClose} disabled={uploading} style={{ padding: "8px 20px", borderRadius: 8, border: `1px solid ${"#e4e4e7"}`, background: "#fff", cursor: uploading ? "not-allowed" : "pointer" }}>取消</button>
	          <button data-testid="script-batch-save-button" onClick={handleImport} disabled={importDisabled} style={{ padding: "8px 20px", borderRadius: 8, border: "none", background: "#5d94bd", color: "#fff", cursor: importDisabled ? "not-allowed" : "pointer", fontWeight: 600, opacity: importDisabled ? 0.6 : 1 }}>{uploading ? "导入中…" : "确认导入"}</button>
        </div>
      </div>
    </div>
  );
}
