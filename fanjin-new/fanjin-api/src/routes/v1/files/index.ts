import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import formidable from "formidable";
import { apiKeyAuth, type RelayApiKeyContext } from "@/middleware/apiKeyAuth";
import { resolveRelayPrincipalId, resolveRelayWorkspaceId } from "@/lib/relayUtils";
import {
  deleteVolcanoFile,
  listVolcanoFiles,
  MAX_VOLCANO_FILE_BYTES,
  retrieveVolcanoFile,
  uploadVolcanoFile,
  VolcanoFileError,
  type VolcanoFileOwner,
} from "@/lib/volcanoFileProxy";

const router = express.Router();
const SAFE_REQUEST_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_MULTIPART_BYTES = MAX_VOLCANO_FILE_BYTES + 1024 * 1024;
const PASSTHROUGH_FIELDS = new Set([
  "preprocess_configs[video][fps]",
  "max_video_tokens",
  "min_frames",
  "tos[bucket]",
  "tos[prefix]",
]);
const auth = apiKeyAuth({ optional: true, permission: "relay:text", reserveRequestQuota: true });

function ownerFromRequest(req: express.Request): VolcanoFileOwner {
  const apiKey = (req as any).apiKey as RelayApiKeyContext | undefined;
  return {
    workspaceId: resolveRelayWorkspaceId(req) || "",
    apiKeyId: apiKey?.id ?? null,
    principalId: resolveRelayPrincipalId(req),
  };
}

function firstField(fields: formidable.Fields, name: string): string | undefined {
  const values = fields[name];
  if (!values?.length) return undefined;
  if (values.length !== 1) throw new VolcanoFileError(`${name} 只能提供一次`, 400, "invalid_request_error");
  return values[0];
}

function sendError(res: express.Response, error: unknown) {
  if (error instanceof VolcanoFileError) {
    return res.status(error.statusCode).json({
      error: { message: error.message, type: error.code, code: error.code },
    });
  }
  console.error("[volcano-files] error", (error as any)?.message || error);
  return res.status(500).json({ error: { message: "internal error", type: "server_error" } });
}

router.post("/", auth, async (req, res) => {
  const owner = ownerFromRequest(req);
  if (!owner.workspaceId || (!owner.apiKeyId && !owner.principalId)) {
    return res.status(403).json({ error: { message: "缺少工作区或调用主体", type: "authentication_error" } });
  }
  if (!/^multipart\/form-data\s*;/i.test(String(req.headers["content-type"] || ""))) {
    return res.status(415).json({ error: { message: "Content-Type 必须是 multipart/form-data", type: "invalid_request_error" } });
  }

  let uploadDirectory: string | null = null;
  try {
    uploadDirectory = await mkdtemp(path.join(tmpdir(), "fanjin-volcano-file-"));
    const form = formidable({
      uploadDir: uploadDirectory,
      allowEmptyFiles: false,
      minFileSize: 1,
      maxFiles: 1,
      maxFileSize: MAX_MULTIPART_BYTES,
      maxTotalFileSize: MAX_MULTIPART_BYTES,
      maxFields: 20,
      maxFieldsSize: 128 * 1024,
      multiples: true,
    });

    let fields: formidable.Fields;
    let files: formidable.Files;
    try {
      [fields, files] = await form.parse(req);
    } catch (error: any) {
      const tooLarge = Number(error?.httpCode || error?.statusCode) === 413
        || /maxFileSize|maxTotalFileSize|too large/i.test(String(error?.message || ""));
      throw new VolcanoFileError(
        tooLarge ? "文件不能超过 512MB" : "multipart/form-data 请求格式无效",
        tooLarge ? 413 : 400,
        "invalid_request_error",
      );
    }

    const purpose = String(firstField(fields, "purpose") || "").trim();
    if (purpose !== "user_data") {
      throw new VolcanoFileError("purpose 必须是 user_data", 400, "invalid_request_error");
    }
    const url = String(firstField(fields, "url") || "").trim();
    if (url && !/^(https:\/\/|tos:\/\/)[^\s]+$/i.test(url)) {
      throw new VolcanoFileError("url 必须是 https:// 或 tos:// 地址", 400, "invalid_request_error");
    }
    const entries = Object.entries(files).flatMap(([fieldName, values]) =>
      (values || []).map((file) => ({ fieldName, file })),
    );
    if (entries.some((entry) => entry.fieldName !== "file") || entries.length > 1) {
      throw new VolcanoFileError("只能通过 file 字段上传一个文件", 400, "invalid_request_error");
    }
    if (Boolean(entries[0]) === Boolean(url)) {
      throw new VolcanoFileError("必须且只能提供 file 或 url 之一", 400, "invalid_request_error");
    }
    if (entries[0] && entries[0].file.size > MAX_VOLCANO_FILE_BYTES) {
      throw new VolcanoFileError("文件不能超过 512MB", 413, "invalid_request_error");
    }

    const unknownFields = Object.keys(fields).filter((key) =>
      key !== "purpose" && key !== "url" && !PASSTHROUGH_FIELDS.has(key),
    );
    if (unknownFields.length) {
      throw new VolcanoFileError(`不支持的字段：${unknownFields.join(", ")}`, 400, "invalid_request_error");
    }
    const passthroughFields = Object.fromEntries(
      [...PASSTHROUGH_FIELDS]
        .map((key) => [key, firstField(fields, key)] as const)
        .filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    const requestId = String((req as any).requestId || req.header("x-request-id") || "").trim();
    const idempotencyKey = String(req.header("idempotency-key") || "").trim();
    if ((requestId && !SAFE_REQUEST_ID.test(requestId)) || (idempotencyKey && !SAFE_REQUEST_ID.test(idempotencyKey))) {
      throw new VolcanoFileError("请求 ID 格式无效", 400, "invalid_request_error");
    }

    req.body = { purpose, source: entries[0] ? "file" : "url", bytes: entries[0]?.file.size || null };
    const payload = await uploadVolcanoFile({
      owner,
      purpose: "user_data",
      ...(entries[0] ? {
        file: {
          filepath: entries[0].file.filepath,
          originalFilename: entries[0].file.originalFilename || "file",
          mimetype: entries[0].file.mimetype,
          size: entries[0].file.size,
        },
      } : { url }),
      passthroughFields,
      requestId: requestId || null,
      idempotencyKey: idempotencyKey || null,
    });
    return res.status(200).json(payload);
  } catch (error) {
    return sendError(res, error);
  } finally {
    if (uploadDirectory) await rm(uploadDirectory, { recursive: true, force: true });
  }
});

router.get("/", auth, async (req, res) => {
  try {
    const rawLimit = req.query.limit === undefined ? 20 : Number(req.query.limit);
    if (!Number.isSafeInteger(rawLimit) || rawLimit < 1 || rawLimit > 100) {
      throw new VolcanoFileError("limit 必须是 1 到 100 的整数", 400, "invalid_request_error");
    }
    return res.json(await listVolcanoFiles(ownerFromRequest(req), rawLimit));
  } catch (error) { return sendError(res, error); }
});

router.get("/:fileId", auth, async (req, res) => {
  try { return res.json(await retrieveVolcanoFile(String(req.params.fileId), ownerFromRequest(req))); }
  catch (error) { return sendError(res, error); }
});

router.delete("/:fileId", auth, async (req, res) => {
  try { return res.json(await deleteVolcanoFile(String(req.params.fileId), ownerFromRequest(req))); }
  catch (error) { return sendError(res, error); }
});

export default router;
