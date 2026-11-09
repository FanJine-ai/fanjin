import path from "node:path";
import { Worker } from "node:worker_threads";

export const MAX_SCRIPT_IMPORT_BYTES = 20 * 1024 * 1024;
export const MAX_SCRIPT_IMPORT_CHARACTERS = 2_000_000;
export type ScriptImportFileType = "doc" | "docx" | "pdf" | "text" | "markdown" | "json";

export class ScriptImportError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "ScriptImportError";
  }
}

function fail(status: number, code: string, message: string): never {
  throw new ScriptImportError(status, `SCRIPT_IMPORT_${code}`, message);
}

// Run binary document parsers outside the API event loop. Neither Word nor PDF
// imports execute macros, fetch linked resources, or write uploaded files to disk.
const documentWorker = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const data = Buffer.from(workerData.data);
async function checkDocx() {
  const yauzl = require(workerData.zipPath);
  await new Promise((resolve, reject) => {
    yauzl.fromBuffer(data, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error);
      let count = 0, expanded = 0, actual = 0, hasDocument = false;
      const stop = (err) => { zip.close(); reject(err); };
      zip.on('error', stop);
      zip.on('end', () => hasDocument ? resolve() : reject(new Error('Missing document')));
      zip.on('entry', (entry) => {
        count += 1;
        expanded += entry.uncompressedSize;
        if (count > 512 || expanded > 32 * 1024 * 1024 || (entry.generalPurposeBitFlag & 1)) {
          return stop(new Error('Archive limit or encryption'));
        }
        if (entry.fileName === 'word/document.xml') hasDocument = true;
        if (entry.fileName.endsWith('/')) return zip.readEntry();
        zip.openReadStream(entry, (err, stream) => {
          if (err) return stop(err);
          stream.on('error', stop);
          stream.on('data', (chunk) => {
            actual += chunk.length;
            if (actual > 32 * 1024 * 1024) {
              stream.destroy(new Error('Archive limit'));
            }
          });
          stream.on('end', () => zip.readEntry());
        });
      });
      zip.readEntry();
    });
  });
}
(async () => {
  let text, pageCount = null;
  if (workerData.type === 'pdf') {
    const { extractText } = require(workerData.pdfPath);
    const result = await extractText(new Uint8Array(data), { mergePages: true });
    text = result.text;
    pageCount = result.totalPages;
  } else {
    if (workerData.type === 'docx') await checkDocx();
    const WordExtractor = require(workerData.wordPath);
    const doc = await new WordExtractor().extract(data);
    text = doc.getBody();
  }
  if (typeof text !== 'string' || text.length > workerData.maxCharacters) {
    return parentPort.postMessage({ error: 'too-large' });
  }
  parentPort.postMessage({ text, pageCount });
})().catch(() => parentPort.postMessage({ error: 'invalid' }));
`;

let activeParsers = 0;
async function parseDocument(data: Buffer, type: "doc" | "docx" | "pdf"): Promise<{ text: string; pageCount: number | null }> {
  if (activeParsers >= 2) fail(429, "BUSY", "当前正在解析其他文件，请稍后重试");
  activeParsers += 1;
  let worker: Worker | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise((resolve, reject) => {
      const invalid = () => reject(new ScriptImportError(422, "SCRIPT_IMPORT_DOCUMENT_INVALID",
        "文件无法解析，请确认未损坏、未加密；Word 文件可另存为 DOCX 后重试"));
      worker = new Worker(documentWorker, {
        eval: true,
        workerData: {
          data, type, maxCharacters: MAX_SCRIPT_IMPORT_CHARACTERS,
          wordPath: require.resolve("word-extractor"),
          zipPath: require.resolve("yauzl"),
          pdfPath: require.resolve("unpdf"),
        },
        resourceLimits: { maxOldGenerationSizeMb: 256 },
      });
      timer = setTimeout(() => reject(new ScriptImportError(422, "SCRIPT_IMPORT_TIMEOUT",
        "文件解析超时，请将文档拆分或另存为 TXT 后重试")), 15_000);
      worker.once("error", invalid);
      worker.once("exit", invalid);
      worker.once("message", (message) => {
        if (message.error === "too-large") {
          return reject(new ScriptImportError(413, "SCRIPT_IMPORT_TEXT_TOO_LARGE", "剧本正文不能超过 200 万字符"));
        }
        if (message.error || typeof message.text !== "string") return invalid();
        resolve({ text: message.text, pageCount: message.pageCount });
      });
    });
  } finally {
    clearTimeout(timer);
    if (worker) await worker.terminate();
    activeParsers -= 1;
  }
}

function decodeText(data: Buffer): string {
  let text: string;
  try {
    const encoding = data[0] === 0xff && data[1] === 0xfe ? "utf-16le"
      : data[0] === 0xfe && data[1] === 0xff ? "utf-16be" : "utf-8";
    try {
      text = new TextDecoder(encoding, { fatal: true }).decode(data);
    } catch (error) {
      if (encoding !== "utf-8") throw error;
      // Older Windows Chinese TXT files commonly use GBK / GB18030.
      text = new TextDecoder("gb18030", { fatal: true }).decode(data);
    }
  } catch {
    return fail(422, "ENCODING", "无法识别文本编码，请另存为 UTF-8 后重试");
  }
  if (/[\u0000-\u0008\u000b\u000e-\u001f\ufffd]/.test(text)) {
    fail(422, "BINARY_TEXT", "文件包含二进制内容，请选择正确格式的文档");
  }
  return text;
}

export async function extractScriptImportFile(input: { fileName: string; mimeType: string; data: Buffer }) {
  const { data } = input;
  if (!data.length) fail(400, "EMPTY", "上传文件为空");
  if (data.length > MAX_SCRIPT_IMPORT_BYTES) fail(413, "FILE_TOO_LARGE", "剧本文件不能超过 20MB");
  const extension = path.extname(input.fileName).toLowerCase();
  const types: Record<string, ScriptImportFileType> = {
    ".doc": "doc", ".docx": "docx", ".pdf": "pdf", ".txt": "text",
    ".md": "markdown", ".markdown": "markdown", ".json": "json",
  };
  const type = types[extension];
  if (!type) fail(415, "UNSUPPORTED", "支持 Word（DOC、DOCX）、TXT、Markdown、JSON 和文字型 PDF");
  const isPdf = data.subarray(0, 5).toString("ascii") === "%PDF-";
  const isDoc = data.subarray(0, 8).equals(Buffer.from("d0cf11e0a1b11ae1", "hex"));
  const isZip = data.subarray(0, 4).equals(Buffer.from("504b0304", "hex"));
  if ((type === "pdf") !== isPdf || (type === "doc") !== isDoc || (type === "docx") !== isZip) {
    fail(415, "TYPE_MISMATCH", "文件内容与扩展名不一致，请用正确的格式重新保存");
  }
  const result = ["doc", "docx", "pdf"].includes(type)
    ? await parseDocument(data, type as "doc" | "docx" | "pdf")
    : { text: decodeText(data), pageCount: null };
  const text = result.text.replace(/\r\n?/g, "\n").replace(/\f/g, "\n\n").trim();
  if (!text) fail(422, "TEXT_EMPTY", type === "pdf"
    ? "PDF 中没有可提取的文字；扫描件请先进行 OCR 后再导入"
    : "文件中没有可导入的剧本正文");
  if (text.length > MAX_SCRIPT_IMPORT_CHARACTERS) fail(413, "TEXT_TOO_LARGE", "剧本正文不能超过 200 万字符");
  return { text, fileType: type, pageCount: result.pageCount, characterCount: text.length };
}
