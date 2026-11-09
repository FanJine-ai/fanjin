import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { consumeDistributedFixedWindow } from "@/lib/distributedRateLimit";
import { hashApiKey, readApiKeyCredential } from "@/middleware/apiKeyAuth";
import { db } from "@/utils/db";

const GLOBAL_LIMIT_KEY = "platform.gateway.globalRateLimitPerMinute";
const MODEL_LIMIT_ENABLED_KEY = "platform.gateway.modelRateLimitEnabled";
const MODEL_LIMIT_COUNT_KEY = "platform.gateway.modelRateLimitCount";
const MODEL_LIMIT_DURATION_KEY = "platform.gateway.modelRateLimitDurationMinutes";
const RATE_LIMIT_SETTING_KEYS = [
  GLOBAL_LIMIT_KEY,
  MODEL_LIMIT_ENABLED_KEY,
  MODEL_LIMIT_COUNT_KEY,
  MODEL_LIMIT_DURATION_KEY,
] as const;
const FIRST_PARTY_GENERATION_PATHS = new Set([
  "/api/artStyle/extractStylePrompt",
  "/api/assetsGenerate/batchGenerateImageAssets",
  "/api/assetsGenerate/batchPolishAssetsPrompt",
  "/api/assetsGenerate/generateAssets",
  "/api/assetsGenerate/polishAssetsPrompt",
  "/api/cornerScape/batchBindAudio",
  "/api/production/assets/batchGenerateAssetsImage",
  "/api/production/editImage/generateFlowImage",
  "/api/production/storyboard/batchGenerateImage",
  "/api/production/workbench/batchGeneratePrompt",
  "/api/production/workbench/batchGenerateVideo",
  "/api/production/workbench/generateVideo",
  "/api/production/workbench/generateVideoPrompt",
  "/api/script/extractAssets",
  "/api/script/getAiRegex",
  "/api/workbench/create/directorPlan",
  "/api/workbench/canvas/text",
  "/api/workbench/create/images",
  "/api/workbench/create/videos",
]);

export class RelayRateLimitError extends Error {
  status: number;
  code: "rate_limit_exceeded" | "rate_limit_unavailable";

  constructor(
    message: string,
    status: number,
    code: "rate_limit_exceeded" | "rate_limit_unavailable",
  ) {
    super(message);
    this.name = "RelayRateLimitError";
    this.status = status;
    this.code = code;
  }
}

interface RelayRateLimitSettings {
  globalPerMinute: number;
  modelEnabled: boolean;
  modelCount: number;
  modelDurationMinutes: number;
}

function readStrictBoolean(raw: unknown, key: string, fallback: boolean): boolean {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  throw new RelayRateLimitError(`平台限流配置 ${key} 无效`, 503, "rate_limit_unavailable");
}

function readStrictInteger(raw: unknown, key: string, fallback: number, minimum: number): number {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const text = String(raw).trim();
  if (!/^-?\d+$/.test(text)) {
    throw new RelayRateLimitError(`平台限流配置 ${key} 必须是整数`, 503, "rate_limit_unavailable");
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RelayRateLimitError(`平台限流配置 ${key} 必须不小于 ${minimum}`, 503, "rate_limit_unavailable");
  }
  return value;
}

async function readRelayRateLimitSettings(): Promise<RelayRateLimitSettings> {
  const rows = await db("o_setting").whereIn("key", [...RATE_LIMIT_SETTING_KEYS]).select("key", "value");
  const values = new Map(rows.map((row: any) => [String(row.key), row.value]));
  const globalPerMinute = readStrictInteger(values.get(GLOBAL_LIMIT_KEY), GLOBAL_LIMIT_KEY, 0, 0);
  const modelEnabled = readStrictBoolean(values.get(MODEL_LIMIT_ENABLED_KEY), MODEL_LIMIT_ENABLED_KEY, false);
  const modelCount = readStrictInteger(values.get(MODEL_LIMIT_COUNT_KEY), MODEL_LIMIT_COUNT_KEY, 60, 1);
  const modelDurationMinutes = readStrictInteger(values.get(MODEL_LIMIT_DURATION_KEY), MODEL_LIMIT_DURATION_KEY, 1, 1);
  return { globalPerMinute, modelEnabled, modelCount, modelDurationMinutes };
}

function isRelayGenerationRequest(req: Request): boolean {
  if (req.method !== "POST") return false;
  const path = req.path.replace(/\/+$/, "") || "/";
  if (/^\/v1\/(?:chat\/completions|responses|messages|images\/generations|embeddings(?:\/multimodal)?|rerank|audio\/(?:speech|transcriptions))$/.test(path)) return true;
  if (/^\/v1beta\/models\/[^/]+:(?:generateContent|streamGenerateContent)$/.test(path)) return true;
  if (path === "/api/v3/contents/generations/tasks") return true;
  if (/^\/api\/(?:mj|suno)\/submit\//.test(path)) return true;
  return FIRST_PARTY_GENERATION_PATHS.has(path);
}

function readRequestedModel(req: Request): string {
  const body = (req.body as any) || {};
  for (const value of [body.model, body.modelName, body.imageModel, body.videoModel]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const pathMatch = req.path.match(/^\/(?:api\/)?v1beta\/models\/([^/:]+):/);
  if (pathMatch?.[1]) return decodeURIComponent(pathMatch[1]);
  const queryModel = req.query?.model;
  if (typeof queryModel === "string" && queryModel.trim()) return queryModel.trim();
  return "";
}

function readPrincipal(req: Request): string {
  const auth = (req as any).auth;
  if (auth?.user?.id != null) return `user:${String(auth.user.id)}`;
  // Keep the exact 0.0.3 principal during the PostgreSQL phase of a rolling
  // release. authMiddleware has already authenticated the key before this
  // middleware runs, so parsing it again does not let invalid credentials
  // consume a shared bucket.
  const credential = readApiKeyCredential(req);
  if (credential.plainKey) return `api-key:${hashApiKey(credential.plainKey)}`;
  const workspaceId = auth?.workspaceId;
  if (workspaceId) return `workspace:${String(workspaceId)}`;
  return `anonymous:${crypto.createHash("sha256").update(String(req.ip || req.socket.remoteAddress || "unknown")).digest("hex")}`;
}

function bucketKey(scope: "global" | "model", principal = "", model = ""): string {
  if (scope === "global") return "$platform:global";
  const digest = crypto.createHash("sha256").update(`${principal}\0${model}`).digest("hex");
  return `$platform:model:${digest}`;
}

async function consumeWindow(
  bucket: string,
  limit: number,
  durationMs: number,
  message: string,
): Promise<void> {
  if (limit <= 0) return;
  const result = await consumeDistributedFixedWindow({
    namespace: "relay-rate",
    bucket,
    limit,
    durationMs,
  });
  if (result.exceeded) throw new RelayRateLimitError(message, 429, "rate_limit_exceeded");
}

function sendRateLimitError(res: Response, error: RelayRateLimitError) {
  return res.status(error.status).send({
    code: error.code,
    message: error.message,
    error: { type: error.code, code: error.code, message: error.message },
  });
}

export async function relayRateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!isRelayGenerationRequest(req)) return next();
  try {
    const settings = await readRelayRateLimitSettings();
    await consumeWindow(bucketKey("global"), settings.globalPerMinute, 60_000, "平台全局请求频率超限");
    if (settings.modelEnabled) {
      const model = readRequestedModel(req);
      if (!model) {
        throw new RelayRateLimitError(
          "模型限流已启用，但当前创作请求未在限流前解析出 model",
          503,
          "rate_limit_unavailable",
        );
      }
      await consumeWindow(
        bucketKey("model", readPrincipal(req), model),
        settings.modelCount,
        (() => {
          const durationMs = settings.modelDurationMinutes * 60_000;
          if (!Number.isSafeInteger(durationMs)) {
            throw new RelayRateLimitError(
              `平台限流配置 ${MODEL_LIMIT_DURATION_KEY} 超出安全范围`,
              503,
              "rate_limit_unavailable",
            );
          }
          return durationMs;
        })(),
        "当前用户调用该模型的请求频率超限",
      );
    }
    next();
  } catch (error: any) {
    if (error instanceof RelayRateLimitError) return sendRateLimitError(res, error);
    console.error("[relay-rate-limit] limiter unavailable", error?.message || error);
    return sendRateLimitError(
      res,
      new RelayRateLimitError("平台限流服务暂不可用", 503, "rate_limit_unavailable"),
    );
  }
}
