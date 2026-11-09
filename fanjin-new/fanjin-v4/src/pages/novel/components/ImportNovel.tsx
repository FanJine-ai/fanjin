import React, { useRef, useState } from "react";
import { apiPost } from "../../../api/http";
import type { StableSubmissionAttempt } from "../../../features/quick-create/submissionAttempt";
import {
  normalizeNovelImportAcknowledgement,
  resolveWritingSubmissionAttempt,
  writingSubmissionError,
} from "../../writing/writeSubmission";
import { extractNovelImportFile } from "../novelImportFile";

interface ImportNovelProps {
  open: boolean;
  onClose: () => void;
  projectId?: number | string;
}

export default function ImportNovel({ open, onClose, projectId }: ImportNovelProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const inFlightRef = useRef(false);
  const attemptRef = useRef<StableSubmissionAttempt | null>(null);
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [fileName, setFileName] = useState("");
  const [fileSummary, setFileSummary] = useState("");
  const [parsingFile, setParsingFile] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [submitError, setSubmitError] = useState("");

  if (!open) return null;

  async function handleImport() {
    if (inFlightRef.current || parsingFile || !text.trim() || !projectId) return;
    const chapter = title.trim() || "第1章";
    const payload = {
      projectId: Number(projectId),
      data: [{ index: 1, reel: chapter, chapter, chapterData: text }],
    };
    const attempt = resolveWritingSubmissionAttempt(
      attemptRef.current,
      `novel-import:${Number(projectId)}`,
      payload,
    );
    attemptRef.current = attempt;
    inFlightRef.current = true;
    setUploading(true);
    setSubmitError("");
    try {
      const result = await apiPost<unknown>(
        "/novel/addNovel",
        payload,
        undefined,
        { headers: { "Idempotency-Key": attempt.idempotencyKey } },
      );
      normalizeNovelImportAcknowledgement(result, payload.data.length);
      attemptRef.current = null;
      onClose();
    } catch (error) {
      setSubmitError(writingSubmissionError(error, "导入失败"));
    } finally {
      inFlightRef.current = false;
      setUploading(false);
    }
  }

  const inputStyle: React.CSSProperties = { padding: "8px 12px", border: `1px solid ${"#e4e4e7"}`, borderRadius: 8, fontSize: 14, color: "#18181b", outline: "none", width: "100%", boxSizing: "border-box" };
  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setFileSummary("");
    setParsingFile(true);
    try {
      setSubmitError("");
      if (!projectId) throw new Error("请先选择有效项目");
      const extracted = await extractNovelImportFile(file, Number(projectId));
      setText(extracted.text);
      setFileSummary(extracted.fileType === "pdf"
        ? `PDF 解析完成：${extracted.pageCount ?? "—"} 页，${extracted.characterCount.toLocaleString("zh-CN")} 字符`
        : `文件读取完成：${extracted.characterCount.toLocaleString("zh-CN")} 字符`);
    } catch (error) {
      setSubmitError(writingSubmissionError(error, "文件读取失败"));
    } finally {
      setParsingFile(false);
      event.target.value = "";
    }
  }

  function requestClose() {
    if (!inFlightRef.current && !parsingFile) onClose();
  }

  return (
    <div className="writingModalBackdrop" style={{ position: "fixed", inset: 0, zIndex: 10000, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center" }} onClick={requestClose}>
      <div className="writingModalPanel" role="dialog" aria-modal="true" aria-label="导入小说" data-testid="novel-import-dialog" style={{ width: 560, maxHeight: "80vh", background: "#fff", borderRadius: 12, padding: 24, overflow: "auto" }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: "0 0 16px", color: "#18181b" }}>导入小说</h3>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, fontWeight: 600, color: "#71717a" }}>
            标题
            <input data-testid="novel-title-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="小说标题" style={inputStyle} />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, fontWeight: 600, color: "#71717a" }}>
            或上传文件
            <input ref={fileRef} type="file" accept=".pdf,.txt,.md,application/pdf,text/plain,text/markdown" onChange={(event) => void handleFileChange(event)} style={{ position: "absolute", width: 1, height: 1, opacity: 0 }} />
            <button type="button" disabled={parsingFile || uploading} onClick={() => fileRef.current?.click()} style={{ ...inputStyle, textAlign: "left", background: "#fafafa", cursor: parsingFile || uploading ? "wait" : "pointer" }}>
              {parsingFile ? `正在解析 ${fileName || "文件"}…` : fileName || "选择 .pdf / .txt / .md 文件"}
            </button>
            {fileSummary ? <span role="status" data-testid="novel-file-summary" style={{ color: "#2563eb", fontWeight: 500 }}>{fileSummary}</span> : null}
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, fontWeight: 600, color: "#71717a" }}>
            或直接粘贴文本
            <textarea data-testid="novel-content-input" value={text} onChange={(e) => setText(e.target.value)} rows={8} placeholder="粘贴小说原文…" style={{ ...inputStyle, resize: "vertical", fontFamily: "inherit" }} />
          </label>
        </div>
        {submitError ? <div role="alert" data-testid="novel-import-error" style={{ marginTop: 12, color: "#b91c1c", fontSize: 13 }}>{submitError}</div> : null}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
          <button onClick={requestClose} disabled={uploading} style={{ padding: "8px 20px", borderRadius: 8, border: `1px solid ${"#e4e4e7"}`, background: "#fff", cursor: uploading ? "not-allowed" : "pointer" }}>取消</button>
          <button data-testid="novel-save-button" onClick={handleImport} disabled={uploading || parsingFile || !projectId || !text.trim()} style={{ padding: "8px 20px", borderRadius: 8, border: "none", background: "#5d94bd", color: "#fff", cursor: uploading || parsingFile || !projectId || !text.trim() ? "not-allowed" : "pointer", fontWeight: 600, opacity: uploading || parsingFile || !projectId || !text.trim() ? 0.6 : 1 }}>
            {uploading ? "导入中…" : "导入"}
          </button>
        </div>
      </div>
    </div>
  );
}
