// /v1/embeddings — OpenAI 兼容 Embeddings 中转
import express from "express";
import { apiKeyAuth } from "@/middleware/apiKeyAuth";
import {
  executeRelayEmbeddings,
  executeRelayMultimodalEmbeddings,
  RelayMediaError,
  type MultimodalEmbeddingInput,
  type MultimodalEmbeddingsRequest,
} from "@/lib/relayMedia";
import { BillingError } from "@/lib/billing";
import { resolveRelayPrincipalId, resolveRelayWorkspaceId } from "@/lib/relayUtils";

const router = express.Router();
const relayTextAuth = apiKeyAuth({ optional: true, permission: "relay:text", reserveRequestQuota: true });

function invalidRequest(res: express.Response, message: string) {
  return res.status(400).json({ error: { message, type: "invalid_request_error" } });
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function unknownField(value: Record<string, unknown>, allowed: readonly string[]): string | null {
  const allowedSet = new Set(allowed);
  return Object.keys(value).find((key) => !allowedSet.has(key)) ?? null;
}

function validMediaUrl(value: unknown, kind: "image" | "video"): value is string {
  if (typeof value !== "string" || !value || value.trim() !== value) return false;
  if (value.startsWith("data:")) {
    const comma = value.indexOf(",");
    if (comma <= 5 || comma === value.length - 1) return false;
    const metadata = value.slice(5, comma).toLowerCase();
    const payload = value.slice(comma + 1);
    if (!metadata.startsWith(`${kind}/`) || !metadata.endsWith(";base64")) return false;
    return payload.length % 4 !== 1 && /^[A-Za-z0-9+/]+={0,2}$/.test(payload);
  }
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

function validatePositiveTokenInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 131_072;
}

function parseMultimodalInputItem(
  raw: unknown,
  index: number,
): { value?: MultimodalEmbeddingInput; error?: string } {
  if (!plainObject(raw)) return { error: `input[${index}] must be an object` };
  if (raw.type === "text") {
    const extra = unknownField(raw, ["type", "text"]);
    if (extra) return { error: `input[${index}].${extra} is not allowed` };
    if (typeof raw.text !== "string" || raw.text.length === 0) {
      return { error: `input[${index}].text must be a non-empty string` };
    }
    return { value: { type: "text", text: raw.text } };
  }
  if (raw.type === "image_url") {
    const extra = unknownField(raw, ["type", "image_url"]);
    if (extra) return { error: `input[${index}].${extra} is not allowed` };
    if (!plainObject(raw.image_url)) return { error: `input[${index}].image_url must be an object` };
    const nestedExtra = unknownField(raw.image_url, ["url"]);
    if (nestedExtra) return { error: `input[${index}].image_url.${nestedExtra} is not allowed` };
    if (!validMediaUrl(raw.image_url.url, "image")) {
      return { error: `input[${index}].image_url.url must be an HTTP(S) URL or base64 image data URL` };
    }
    return { value: { type: "image_url", image_url: { url: raw.image_url.url } } };
  }
  if (raw.type === "video_url") {
    const extra = unknownField(raw, ["type", "video_url"]);
    if (extra) return { error: `input[${index}].${extra} is not allowed` };
    if (!plainObject(raw.video_url)) return { error: `input[${index}].video_url must be an object` };
    const nestedExtra = unknownField(raw.video_url, [
      "url",
      "fps",
      "max_video_tokens",
      "min_frame_tokens",
      "max_frame_tokens",
      "min_frames",
    ]);
    if (nestedExtra) return { error: `input[${index}].video_url.${nestedExtra} is not allowed` };
    if (!validMediaUrl(raw.video_url.url, "video")) {
      return { error: `input[${index}].video_url.url must be an HTTP(S) URL or base64 video data URL` };
    }
    if (raw.video_url.fps !== undefined && (
      typeof raw.video_url.fps !== "number" || !Number.isFinite(raw.video_url.fps) || raw.video_url.fps <= 0
    )) {
      return { error: `input[${index}].video_url.fps must be a positive finite number` };
    }
    for (const key of ["max_video_tokens", "min_frame_tokens", "max_frame_tokens", "min_frames"] as const) {
      if (raw.video_url[key] !== undefined && !validatePositiveTokenInteger(raw.video_url[key])) {
        return { error: `input[${index}].video_url.${key} must be an integer between 1 and 131072` };
      }
    }
    const minFrameTokens = Number(raw.video_url.min_frame_tokens || 0);
    const maxFrameTokens = Number(raw.video_url.max_frame_tokens || 0);
    const maxVideoTokens = Number(raw.video_url.max_video_tokens || 0);
    const minFrames = Number(raw.video_url.min_frames || 0);
    if (minFrameTokens && maxFrameTokens && minFrameTokens > maxFrameTokens) {
      return { error: `input[${index}].video_url.min_frame_tokens must not exceed max_frame_tokens` };
    }
    if (maxFrameTokens && maxVideoTokens && maxFrameTokens > maxVideoTokens) {
      return { error: `input[${index}].video_url.max_frame_tokens must not exceed max_video_tokens` };
    }
    if (minFrames && minFrameTokens && maxVideoTokens && minFrames * minFrameTokens > maxVideoTokens) {
      return { error: `input[${index}] minimum frame token budget exceeds max_video_tokens` };
    }
    return {
      value: {
        type: "video_url",
        video_url: {
          url: raw.video_url.url,
          ...(raw.video_url.fps !== undefined ? { fps: raw.video_url.fps } : {}),
          ...(raw.video_url.max_video_tokens !== undefined
            ? { max_video_tokens: raw.video_url.max_video_tokens as number }
            : {}),
          ...(raw.video_url.min_frame_tokens !== undefined
            ? { min_frame_tokens: raw.video_url.min_frame_tokens as number }
            : {}),
          ...(raw.video_url.max_frame_tokens !== undefined
            ? { max_frame_tokens: raw.video_url.max_frame_tokens as number }
            : {}),
          ...(raw.video_url.min_frames !== undefined ? { min_frames: raw.video_url.min_frames as number } : {}),
        },
      },
    };
  }
  return { error: `input[${index}].type must be text, image_url, or video_url` };
}

function parseMultimodalRequest(raw: unknown): { value?: MultimodalEmbeddingsRequest; error?: string } {
  if (!plainObject(raw)) return { error: "request body must be an object" };
  const extra = unknownField(raw, [
    "model",
    "input",
    "encoding_format",
    "dimensions",
    "instructions",
    "sparse_embedding",
    "multi_embedding",
  ]);
  if (extra) return { error: `${extra} is not allowed` };
  const model = typeof raw.model === "string" ? raw.model.trim() : "";
  if (!model) return { error: "model is required" };
  if (!Array.isArray(raw.input) || raw.input.length === 0) {
    return { error: "input must be a non-empty typed input array" };
  }
  const input: MultimodalEmbeddingInput[] = [];
  for (let index = 0; index < raw.input.length; index += 1) {
    const parsed = parseMultimodalInputItem(raw.input[index], index);
    if (parsed.error || !parsed.value) return { error: parsed.error || `input[${index}] is invalid` };
    input.push(parsed.value);
  }
  if (raw.encoding_format !== undefined && raw.encoding_format !== null && !["float", "base64"].includes(String(raw.encoding_format))) {
    return { error: "encoding_format must be float, base64, or null" };
  }
  if (raw.dimensions !== undefined && raw.dimensions !== 1024 && raw.dimensions !== 2048) {
    return { error: "dimensions must be 1024 or 2048" };
  }
  if (raw.instructions !== undefined && typeof raw.instructions !== "string") {
    return { error: "instructions must be a string" };
  }
  if (raw.sparse_embedding !== undefined) {
    if (!plainObject(raw.sparse_embedding)) return { error: "sparse_embedding must be an object" };
    const sparseExtra = unknownField(raw.sparse_embedding, ["type"]);
    if (sparseExtra) return { error: `sparse_embedding.${sparseExtra} is not allowed` };
    if (raw.sparse_embedding.type !== "enabled" && raw.sparse_embedding.type !== "disabled") {
      return { error: "sparse_embedding.type must be enabled or disabled" };
    }
    if (raw.sparse_embedding.type === "enabled" && input.some((item) => item.type !== "text")) {
      return { error: "sparse_embedding can only be enabled for text-only input" };
    }
  }
  if (raw.multi_embedding !== undefined) {
    if (!plainObject(raw.multi_embedding)) return { error: "multi_embedding must be an object" };
    const multiExtra = unknownField(raw.multi_embedding, ["type", "compression"]);
    if (multiExtra) return { error: `multi_embedding.${multiExtra} is not allowed` };
    if (raw.multi_embedding.type !== "enabled" && raw.multi_embedding.type !== "disabled") {
      return { error: "multi_embedding.type must be enabled or disabled" };
    }
    if (
      raw.multi_embedding.compression !== undefined &&
      raw.multi_embedding.compression !== "blosc2" &&
      raw.multi_embedding.compression !== "zstd"
    ) {
      return { error: "multi_embedding.compression must be blosc2 or zstd" };
    }
  }

  return {
    value: {
      model,
      input,
      ...(raw.encoding_format !== undefined
        ? { encoding_format: raw.encoding_format as "float" | "base64" | null }
        : {}),
      ...(raw.dimensions !== undefined ? { dimensions: raw.dimensions as 1024 | 2048 } : {}),
      ...(raw.instructions !== undefined ? { instructions: raw.instructions as string } : {}),
      ...(plainObject(raw.sparse_embedding)
        ? { sparse_embedding: { type: raw.sparse_embedding.type as "enabled" | "disabled" } }
        : {}),
      ...(plainObject(raw.multi_embedding)
        ? {
            multi_embedding: {
              type: raw.multi_embedding.type as "enabled" | "disabled",
              ...(raw.multi_embedding.compression !== undefined
                ? { compression: raw.multi_embedding.compression as "blosc2" | "zstd" }
                : {}),
            },
          }
        : {}),
    },
  };
}

function relayBillingContext(req: express.Request, res: express.Response) {
  const workspaceId = resolveRelayWorkspaceId(req);
  const apiKey = (req as any).apiKey;
  if (!apiKey && !workspaceId) {
    res.status(403).json({ error: { message: "缺少工作区上下文", type: "authentication_error" } });
    return null;
  }
  const idempotencyKey = String(req.header("idempotency-key") || "").trim();
  if (idempotencyKey && !/^[A-Za-z0-9_.:-]{1,128}$/.test(idempotencyKey)) {
    invalidRequest(res, "Idempotency-Key 格式无效");
    return null;
  }
  return {
    workspaceId: workspaceId!,
    apiKeyId: apiKey?.id ?? null,
    principalId: resolveRelayPrincipalId(req),
    requestId: String((req as any).requestId || req.header("x-request-id") || "").trim() || null,
    idempotencyKey: idempotencyKey || null,
  };
}

function sendRelayError(res: express.Response, err: any) {
  if (err instanceof BillingError) {
    return res.status(err.status).json({ error: { message: err.message, type: "billing_error" } });
  }
  if (err instanceof RelayMediaError) {
    return res.status(err.statusCode).json({ error: { message: err.message, type: "api_error" } });
  }
  return res.status(500).json({ error: { message: err?.message || "internal error", type: "server_error" } });
}

router.post("/multimodal", relayTextAuth, async (req, res) => {
  const parsed = parseMultimodalRequest(req.body);
  if (!parsed.value) return invalidRequest(res, parsed.error || "invalid multimodal embedding request");
  const context = relayBillingContext(req, res);
  if (!context) return;
  try {
    return res.json(await executeRelayMultimodalEmbeddings(parsed.value, context));
  } catch (err) {
    return sendRelayError(res, err);
  }
});

router.post("/", relayTextAuth, async (req, res) => {
  const body = req.body ?? {};
  const model = typeof body.model === "string" ? body.model.trim() : "";
  const input = body.input;
  const validInput = (typeof input === "string" && input.length > 0) ||
    (Array.isArray(input) && input.length > 0 && input.every((item) => typeof item === "string" && item.length > 0));
  if (!model) return res.status(400).json({ error: { message: "model is required", type: "invalid_request_error" } });
  if (!validInput) {
    return res.status(400).json({
      error: { message: "input must be a non-empty string or non-empty string array", type: "invalid_request_error" },
    });
  }
  if (body.encoding_format !== undefined && !["float", "base64"].includes(body.encoding_format)) {
    return res.status(400).json({ error: { message: "encoding_format must be float or base64", type: "invalid_request_error" } });
  }
  if (body.dimensions !== undefined && (!Number.isSafeInteger(body.dimensions) || body.dimensions <= 0)) {
    return res.status(400).json({ error: { message: "dimensions must be a positive integer", type: "invalid_request_error" } });
  }

  const context = relayBillingContext(req, res);
  if (!context) return;

  try {
    const result = await executeRelayEmbeddings(
      {
        model,
        input,
        encoding_format: body.encoding_format,
        dimensions: body.dimensions,
      },
      context,
    );
    res.json(result);
  } catch (err) {
    return sendRelayError(res, err);
  }
});

export default router;
