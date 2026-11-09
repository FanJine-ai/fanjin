import { apiPost } from "../../api/http";

export const MAX_NOVEL_IMPORT_FILE_BYTES = 20 * 1024 * 1024;

export type NovelImportExtraction = {
  text: string;
  fileType: "pdf" | "text" | "markdown";
  pageCount: number | null;
  characterCount: number;
};

function canonicalMimeType(file: File): string {
  const name = file.name.toLowerCase();
  if (name.endsWith(".pdf")) return "application/pdf";
  if (name.endsWith(".md")) return "text/markdown";
  if (name.endsWith(".txt")) return "text/plain";
  throw new Error("仅支持 PDF、TXT 和 Markdown 小说文件");
}

function readDataUrl(file: File, mimeType: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("文件读取失败"));
    reader.onload = () => {
      const value = typeof reader.result === "string" ? reader.result : "";
      const comma = value.indexOf(",");
      if (comma < 0 || !value.slice(0, comma).toLowerCase().includes(";base64")) {
        reject(new Error("文件读取结果无效"));
        return;
      }
      resolve(`data:${mimeType};base64,${value.slice(comma + 1)}`);
    };
    reader.readAsDataURL(file);
  });
}

export async function extractNovelImportFile(file: File, projectId: number): Promise<NovelImportExtraction> {
  if (!Number.isSafeInteger(projectId) || projectId <= 0) throw new Error("请先选择有效项目");
  if (!file.size) throw new Error("上传文件为空");
  if (file.size > MAX_NOVEL_IMPORT_FILE_BYTES) throw new Error("小说文件不能超过 20MB");
  const mimeType = canonicalMimeType(file);
  if (file.type && file.type.toLowerCase() !== mimeType && !(mimeType === "text/markdown" && file.type === "text/x-markdown")) {
    throw new Error("文件扩展名与 MIME 类型不一致");
  }
  return apiPost<NovelImportExtraction>("/novel/extractFile", {
    projectId,
    fileName: file.name,
    dataUrl: await readDataUrl(file, mimeType),
  });
}
