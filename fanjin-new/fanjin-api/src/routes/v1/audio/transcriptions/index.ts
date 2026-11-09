// /v1/audio/transcriptions — OpenAI 兼容音频转写中转
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import formidable from "formidable";
import { BillingError } from "@/lib/billing";
import {
  executeRelayTranscription,
  MAX_TRANSCRIPTION_FILE_BYTES,
  RelayMediaError,
  type TranscriptionFileInput,
  type TranscriptionRequest,
  type TranscriptionResponseFormat,
} from "@/lib/relayMedia";
import { apiKeyAuth, type RelayApiKeyContext } from "@/middleware/apiKeyAuth";
import { resolveRelayPrincipalId, resolveRelayWorkspaceId } from "@/lib/relayUtils";

const router = express.Router();
const SAFE_REQUEST_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const MULTIPART_HARD_LIMIT_BYTES = MAX_TRANSCRIPTION_FILE_BYTES + 1024 * 1024;
const RESPONSE_FORMATS = new Set<TranscriptionResponseFormat>([
  "json",
  "text",
  "srt",
  "verbose_json",
  "vtt",
]);

interface ParsedTranscriptionUpload {
  fields: formidable.Fields;
  file: formidable.File;
}

function firstField(fields: formidable.Fields, name: string): string | undefined {
  const values = fields[name];
  if (!values || values.length === 0) return undefined;
  if (values.length !== 1) throw new RelayMediaError(`${name} 只能提供一次`, 400, false);
  return values[0];
}

function repeatedField(fields: formidable.Fields, ...names: string[]): string[] {
  return names.flatMap((name) => fields[name] || []);
}

async function drainRejectedUpload(req: express.Request): Promise<void> {
  if (req.destroyed || req.complete) return;
  await new Promise<void>((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      req.removeListener("end", finish);
      req.removeListener("close", finish);
      resolve();
    };
    const timer = setTimeout(finish, 5_000);
    req.once("end", finish);
    req.once("close", finish);
    req.resume();
  });
}

async function parseMultipartUpload(
  req: express.Request,
  temporaryPaths: Set<string>,
  temporaryDirectories: Set<string>,
  temporaryStreams: Set<WriteStream>,
): Promise<ParsedTranscriptionUpload> {
  if (!/^multipart\/form-data\s*;/i.test(String(req.headers["content-type"] || ""))) {
    throw new RelayMediaError("Content-Type 必须是 multipart/form-data", 415, false);
  }

  const configuredUploadDir = String(process.env.FANJIN_TRANSCRIPTION_TEMP_DIR || "").trim();
  const requestUploadDir = await mkdtemp(path.join(configuredUploadDir || tmpdir(), "fanjin-transcription-"));
  temporaryDirectories.add(requestUploadDir);
  const form = formidable({
    uploadDir: requestUploadDir,
    allowEmptyFiles: false,
    minFileSize: 1,
    maxFiles: 1,
    // Keep a small parser headroom so a just-over-limit file can be fully
    // drained and receive a structured 413. The business limit below remains
    // exactly 25MB; much larger bodies are still cut off early.
    maxFileSize: MULTIPART_HARD_LIMIT_BYTES,
    maxTotalFileSize: MULTIPART_HARD_LIMIT_BYTES,
    maxFields: 20,
    maxFieldsSize: 64 * 1024,
    keepExtensions: false,
    hashAlgorithm: "sha256",
    multiples: true,
    fileWriteStreamHandler: (file) => {
      // Formidable's runtime VolatileFile carries filepath, although the
      // published VolatileFile declaration currently omits that property.
      const filepath = (file as unknown as { filepath?: string } | undefined)?.filepath;
      if (!filepath) throw new Error("Formidable 未提供临时文件路径");
      const stream = createWriteStream(filepath, { flags: "wx", mode: 0o600 });
      temporaryStreams.add(stream);
      return stream;
    },
  });
  form.on("fileBegin", (_name, file) => {
    if (file.filepath) temporaryPaths.add(file.filepath);
  });
  form.on("file", (_name, file) => {
    if (file.filepath) temporaryPaths.add(file.filepath);
  });

  let fields: formidable.Fields;
  let files: formidable.Files;
  try {
    [fields, files] = await form.parse(req);
  } catch (error: any) {
    // Formidable pauses the request on parser/limit errors. Resume draining the
    // remaining multipart bytes so clients receive the structured 4xx instead
    // of an ECONNRESET while they are still uploading.
    await drainRejectedUpload(req);
    const reportedStatus = Number(error?.httpCode ?? error?.statusCode ?? error?.status);
    const errorMessage = String(error?.message || "");
    const tooManyFiles = /maxFiles|too many files/i.test(errorMessage);
    const tooLarge = !tooManyFiles && (
      reportedStatus === 413 ||
      /maxFileSize|maxTotalFileSize|too large/i.test(errorMessage)
    );
    throw new RelayMediaError(
      tooLarge
        ? "音频文件不能超过 25MB"
        : tooManyFiles
          ? "只能上传一个音频文件"
          : "multipart/form-data 请求格式无效",
      tooLarge ? 413 : 400,
      false,
    );
  }

  const entries = Object.entries(files).flatMap(([fieldName, uploaded]) =>
    (uploaded || []).map((file) => ({ fieldName, file })),
  );
  if (entries.length !== 1 || entries[0].fieldName !== "file") {
    throw new RelayMediaError("必须且只能通过 file 字段上传一个音频文件", 400, false);
  }
  if (entries[0].file.size > MAX_TRANSCRIPTION_FILE_BYTES) {
    throw new RelayMediaError("音频文件不能超过 25MB", 413, false);
  }
  return { fields, file: entries[0].file };
}

function normalizeRequest(fields: formidable.Fields): TranscriptionRequest {
  const model = String(firstField(fields, "model") || "").trim();
  if (!model || model.length > 256) throw new RelayMediaError("model is required", 400, false);

  const language = String(firstField(fields, "language") || "").trim();
  if (language && !/^[A-Za-z0-9-]{1,32}$/.test(language)) {
    throw new RelayMediaError("language 格式无效", 400, false);
  }
  const prompt = firstField(fields, "prompt");
  if (prompt !== undefined && prompt.length > 10_000) {
    throw new RelayMediaError("prompt 不能超过 10000 个字符", 400, false);
  }

  const rawFormat = String(firstField(fields, "response_format") || "json").trim();
  if (!RESPONSE_FORMATS.has(rawFormat as TranscriptionResponseFormat)) {
    throw new RelayMediaError("response_format 格式无效", 400, false);
  }

  const rawTemperature = firstField(fields, "temperature");
  let temperature: number | undefined;
  if (rawTemperature !== undefined) {
    temperature = Number(rawTemperature);
    if (!rawTemperature.trim() || !Number.isFinite(temperature) || temperature < 0 || temperature > 1) {
      throw new RelayMediaError("temperature 必须是 0 到 1 之间的数字", 400, false);
    }
  }

  const timestampGranularities = repeatedField(
    fields,
    "timestamp_granularities[]",
    "timestamp_granularities",
  );
  if (timestampGranularities.some((value) => value !== "word" && value !== "segment")) {
    throw new RelayMediaError("timestamp_granularities 只能包含 word 或 segment", 400, false);
  }

  return {
    model,
    ...(language ? { language } : {}),
    ...(prompt !== undefined && prompt !== "" ? { prompt } : {}),
    response_format: rawFormat as TranscriptionResponseFormat,
    ...(temperature !== undefined ? { temperature } : {}),
    ...(timestampGranularities.length > 0
      ? { timestamp_granularities: [...new Set(timestampGranularities)] as Array<"word" | "segment"> }
      : {}),
  };
}

function normalizeFile(file: formidable.File): TranscriptionFileInput {
  const sha256 = typeof file.hash === "string" ? file.hash : "";
  return {
    filepath: file.filepath,
    originalFilename: file.originalFilename || "audio",
    mimetype: file.mimetype,
    size: file.size,
    sha256,
  };
}

function sendTranscriptionResult(
  res: express.Response,
  result: any,
  format: TranscriptionResponseFormat,
) {
  if (format === "text") return res.type("text/plain; charset=utf-8").send(result);
  if (format === "srt") return res.type("application/x-subrip; charset=utf-8").send(result);
  if (format === "vtt") return res.type("text/vtt; charset=utf-8").send(result);
  return res.json(result);
}

async function closeTemporaryStream(stream: WriteStream): Promise<void> {
  if (stream.closed) return;
  await new Promise<void>((resolve) => {
    stream.once("close", resolve);
    if (!stream.destroyed) stream.destroy();
  });
}

async function cleanupTemporaryFiles(
  paths: Set<string>,
  directories: Set<string>,
  streams: Set<WriteStream>,
): Promise<void> {
  await Promise.all([...streams].map(closeTemporaryStream));
  await Promise.all([...directories].map(async (directory) => {
    try {
      await rm(directory, { recursive: true, force: true });
    } catch (error: any) {
      if (error?.code !== "ENOENT") {
        console.warn("[relay-transcription] 清理临时目录失败", error?.message || error);
      }
    }
  }));

  // A directory-level cleanup is the primary privacy boundary. Keep a
  // defensive warning if a parser ever reports a path outside that directory.
  for (const filepath of paths) {
    if (![...directories].some((directory) => path.dirname(filepath) === directory)) {
      console.warn("[relay-transcription] 临时文件路径不在请求隔离目录内", filepath);
    }
  }
}

router.post(
  "/",
  apiKeyAuth({ optional: true, permission: "relay:text", reserveRequestQuota: true }),
  async (req, res) => {
    const apiKey = (req as any).apiKey as RelayApiKeyContext | undefined;
    const workspaceId = resolveRelayWorkspaceId(req);
    if (!apiKey && !workspaceId) {
      return res.status(403).json({ error: { message: "缺少工作区上下文", type: "authentication_error" } });
    }

    const clientRequestId = String(req.header("x-request-id") || "").trim();
    const idempotencyKey = String(req.header("idempotency-key") || "").trim();
    if (clientRequestId && !SAFE_REQUEST_ID.test(clientRequestId)) {
      return res.status(400).json({ error: { message: "X-Request-Id 格式无效", type: "invalid_request_error" } });
    }
    if (idempotencyKey && !SAFE_REQUEST_ID.test(idempotencyKey)) {
      return res.status(400).json({ error: { message: "Idempotency-Key 格式无效", type: "invalid_request_error" } });
    }

    const temporaryPaths = new Set<string>();
    const temporaryDirectories = new Set<string>();
    const temporaryStreams = new Set<WriteStream>();
    const outcome = await (async () => {
      try {
        const upload = await parseMultipartUpload(
          req,
          temporaryPaths,
          temporaryDirectories,
          temporaryStreams,
        );
        const transcriptionRequest = normalizeRequest(upload.fields);
        // Keep request logging useful without ever attaching the uploaded file,
        // temporary path, prompt, or raw multipart fields to req.body.
        req.body = {
          model: transcriptionRequest.model,
          response_format: transcriptionRequest.response_format,
          fileSizeBytes: upload.file.size,
        };
        if (
          apiKey?.modelAllowlist.length &&
          !apiKey.modelAllowlist.includes(transcriptionRequest.model)
        ) {
          return {
            kind: "error" as const,
            status: 403,
            message: "API Key 不允许调用该模型",
            type: "authentication_error",
          };
        }

        const result = await executeRelayTranscription(
          transcriptionRequest,
          normalizeFile(upload.file),
          {
            workspaceId: workspaceId!,
            apiKeyId: apiKey?.id ?? null,
            principalId: resolveRelayPrincipalId(req),
            requestId: String((req as any).requestId || clientRequestId || "").trim() || null,
            idempotencyKey: idempotencyKey || null,
          },
        );
        return {
          kind: "success" as const,
          result,
          format: transcriptionRequest.response_format || "json",
        };
      } catch (error: any) {
        if (error instanceof BillingError) {
          return {
            kind: "error" as const,
            status: error.status,
            message: error.message,
            type: "billing_error",
          };
        }
        if (error instanceof RelayMediaError) {
          return {
            kind: "error" as const,
            status: error.statusCode,
            message: error.message,
            type: "api_error",
          };
        }
        return {
          kind: "error" as const,
          status: 500,
          message: error?.message || "internal error",
          type: "server_error",
        };
      }
    })();

    // Do not commit the HTTP response while the uploaded audio is still on
    // disk. Besides tightening the privacy boundary, this gives callers a
    // deterministic lifecycle: once the request resolves, its temp file is
    // already gone rather than being cleaned up in a trailing async task.
    await cleanupTemporaryFiles(temporaryPaths, temporaryDirectories, temporaryStreams);

    if (outcome.kind === "success") {
      return sendTranscriptionResult(res, outcome.result, outcome.format);
    }
    return res.status(outcome.status).json({
      error: { message: outcome.message, type: outcome.type },
    });
  },
);

export default router;
