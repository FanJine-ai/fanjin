import path from "node:path";

import { extractText } from "unpdf";

export const MAX_NOVEL_IMPORT_BYTES = 20 * 1024 * 1024;
export const MAX_NOVEL_IMPORT_CHARACTERS = 12_000_000;

export type NovelImportFileType = "pdf" | "text" | "markdown";

export class NovelImportError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "NovelImportError";
    this.status = status;
    this.code = code;
  }
}

function fail(status: number, code: string, message: string): never {
  throw new NovelImportError(status, code, message);
}

function normalizeText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000\uFFFD]/g, "")
    .trim();
}

function decodeUtf8(data: Buffer): string {
  if (data.includes(0)) {
    return fail(422, "NOVEL_IMPORT_TEXT_BINARY", "文本文件包含二进制内容，无法作为小说正文导入");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return fail(422, "NOVEL_IMPORT_TEXT_ENCODING", "文本文件不是有效的 UTF-8 编码，请转换编码后重试");
  }
}

function fileType(fileName: string, mimeType: string, data: Buffer): NovelImportFileType {
  const extension = path.extname(fileName).toLowerCase();
  const mime = mimeType.trim().toLowerCase();
  const pdfMagic = data.subarray(0, 5).toString("ascii") === "%PDF-";
  if (extension === ".pdf" || mime === "application/pdf" || pdfMagic) {
    if (extension !== ".pdf" || mime !== "application/pdf" || !pdfMagic) {
      return fail(415, "NOVEL_IMPORT_PDF_MISMATCH", "PDF 文件的扩展名、MIME 或文件签名不一致");
    }
    return "pdf";
  }
  if (extension === ".md" || mime === "text/markdown" || mime === "text/x-markdown") {
    if (extension !== ".md" || !["text/markdown", "text/x-markdown"].includes(mime)) {
      return fail(415, "NOVEL_IMPORT_MARKDOWN_MISMATCH", "Markdown 文件的扩展名和 MIME 不一致");
    }
    return "markdown";
  }
  if (extension === ".txt" && mime === "text/plain") return "text";
  return fail(415, "NOVEL_IMPORT_TYPE_UNSUPPORTED", "仅支持 PDF、TXT 和 Markdown 小说文件");
}

export function assertNovelChapterText(value: string): void {
  const text = String(value || "");
  const trimmed = text.trimStart();
  if (text.includes("\u0000") || trimmed.startsWith("%PDF-")) {
    fail(422, "NOVEL_BINARY_CONTENT_REJECTED", "检测到 PDF 或其他二进制内容，请通过文件上传解析后再导入");
  }
  if (text.length > MAX_NOVEL_IMPORT_CHARACTERS) {
    fail(413, "NOVEL_IMPORT_TEXT_TOO_LARGE", `小说正文不能超过 ${MAX_NOVEL_IMPORT_CHARACTERS.toLocaleString("en-US")} 个字符`);
  }
}

export async function extractNovelImportFile(input: {
  fileName: string;
  mimeType: string;
  data: Buffer;
}): Promise<{
  text: string;
  fileType: NovelImportFileType;
  pageCount: number | null;
  characterCount: number;
}> {
  if (!input.data.length) fail(400, "NOVEL_IMPORT_FILE_EMPTY", "上传文件为空");
  if (input.data.length > MAX_NOVEL_IMPORT_BYTES) {
    fail(413, "NOVEL_IMPORT_FILE_TOO_LARGE", "小说文件不能超过 20MB");
  }
  const type = fileType(input.fileName, input.mimeType, input.data);
  let text: string;
  let pageCount: number | null = null;
  if (type === "pdf") {
    try {
      const extracted = await extractText(new Uint8Array(input.data), { mergePages: true });
      text = extracted.text;
      pageCount = extracted.totalPages;
    } catch {
      return fail(422, "NOVEL_IMPORT_PDF_INVALID", "PDF 无法解析，请确认文件未损坏、未加密且允许提取文本");
    }
  } else {
    text = decodeUtf8(input.data);
  }
  const normalized = normalizeText(text);
  if (!normalized) {
    return fail(
      422,
      "NOVEL_IMPORT_TEXT_EMPTY",
      type === "pdf"
        ? "PDF 中没有可提取的文字；如果是扫描件，请先进行 OCR 后再导入"
        : "文件中没有可导入的小说正文",
    );
  }
  assertNovelChapterText(normalized);
  return {
    text: normalized,
    fileType: type,
    pageCount,
    characterCount: normalized.length,
  };
}
