export type MimeExtensionMap = Record<string, string>;

export const imageMimeExtensions: MimeExtensionMap = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

export const audioMimeExtensions: MimeExtensionMap = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/aiff": "aiff",
  "audio/x-aiff": "aiff",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
};

export const videoMimeExtensions: MimeExtensionMap = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
};

export const uploadMimeExtensions: MimeExtensionMap = {
  ...imageMimeExtensions,
  ...audioMimeExtensions,
  ...videoMimeExtensions,
};

export interface ParsedDataUrl {
  mime: string;
  ext: string;
  data: Buffer;
}

export function parseBase64DataUrl(value: string, allowedMimes: MimeExtensionMap, label = "文件"): ParsedDataUrl {
  const match = String(value || "").match(/^data:([^;]+);base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match) {
    throw new Error(`${label}必须是 base64 data URL`);
  }

  const mime = match[1].toLowerCase();
  const ext = allowedMimes[mime];
  if (!ext) {
    throw new Error(`不支持的${label}类型: ${mime}`);
  }

  const base64 = match[2].replace(/\s/g, "");
  return {
    mime,
    ext,
    data: Buffer.from(base64, "base64"),
  };
}
