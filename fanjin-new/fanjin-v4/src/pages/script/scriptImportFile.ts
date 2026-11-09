import { apiPost } from "../../api/http";

export const SCRIPT_IMPORT_ACCEPT = ".doc,.docx,.txt,.md,.markdown,.json,.pdf";
export const MAX_SCRIPT_IMPORT_FILE_BYTES = 20 * 1024 * 1024;
export type ScriptImportExtraction = {
  text: string;
  fileType: "doc" | "docx" | "text" | "markdown" | "json" | "pdf";
  pageCount: number | null;
  characterCount: number;
};

export async function extractScriptImportFile(file: File, projectId: number): Promise<ScriptImportExtraction> {
  if (!Number.isSafeInteger(projectId) || projectId <= 0) throw new Error("请先选择有效项目");
  if (!file.size) throw new Error("上传文件为空");
  if (file.size > MAX_SCRIPT_IMPORT_FILE_BYTES) throw new Error("剧本文件不能超过 20MB");
  const extension = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
  if (!SCRIPT_IMPORT_ACCEPT.split(",").includes(extension)) {
    throw new Error("支持 Word（DOC、DOCX）、TXT、Markdown、JSON 和文字型 PDF");
  }
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("文件读取失败"));
    reader.onabort = () => reject(new Error("文件读取已取消"));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      if (comma < 0 || !result.slice(0, comma).includes(";base64")) return reject(new Error("文件读取结果无效"));
      // Browser MIME detection varies for Word and Markdown; the API verifies the
      // actual file signature and extension before invoking a document parser.
      resolve(`data:application/octet-stream;base64,${result.slice(comma + 1)}`);
    };
    reader.readAsDataURL(file);
  });
  const result = await apiPost<ScriptImportExtraction>("/script/importFile", { projectId, fileName: file.name, dataUrl });
  if (!result || typeof result.text !== "string" || !result.text.trim()) throw new Error("文件中没有可导入的剧本正文");
  return result;
}
