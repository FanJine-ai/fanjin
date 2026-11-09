import { createHash, createHmac } from "node:crypto";
import type { Knex } from "knex";

import { redactSensitiveText } from "@/lib/redactSensitiveText";

const OBSERVABILITY_VERSION = 1 as const;
const PROMPT_MAX_LENGTH = 2_000;
// Keep the displayed reference compact while retaining 96 bits of collision
// resistance. 64-bit references become collision-prone at production scale.
const REQUEST_REF_LENGTH = 24;

type SafeParameterValue = string | number | boolean;

export type PublicCreationCorrelation = {
  version: typeof OBSERVABILITY_VERSION;
  projectDigest: string | null;
  generationDigest: string;
  taskDigest: string;
  assetDigest?: string;
};

export type PublicCreationObservability = {
  version: typeof OBSERVABILITY_VERSION;
  prompt: string;
  parameters: Record<string, SafeParameterValue>;
  requestRef: string;
  correlation: PublicCreationCorrelation;
};

const SAFE_PARAMETER_FIELDS = Object.freeze({
  resolution: "resolution",
  requestedResolution: "resolution",
  finalResolution: "resolution",
  ratio: "aspectRatio",
  aspectRatio: "aspectRatio",
  duration: "durationSeconds",
  durationSeconds: "durationSeconds",
  size: "quality",
  quality: "quality",
  imageQuality: "quality",
  fps: "fps",
  generate_audio: "audio",
  generateAudio: "audio",
  audio: "audio",
  watermark: "watermark",
  mode: "mode",
} satisfies Record<string, string>);

function observabilityKey(tokenKey: string): Buffer {
  return createHash("sha256")
    .update("fanjin-public-creation-observability-v1\0", "utf8")
    .update(tokenKey, "utf8")
    .digest();
}

export async function readPublicCreationTokenKey(knex: Knex): Promise<string> {
  const setting = await knex<any>("o_setting")
    .where({ key: "tokenKey" })
    .select("value")
    .first();
  const tokenKey = String(setting?.value || "").trim();
  if (tokenKey.length < 32) {
    throw new Error("PUBLIC_CREATION_CORRELATION_KEY_UNAVAILABLE");
  }
  return tokenKey;
}

function canonicalPart(value: unknown): string {
  if (value === null || value === undefined) return "-";
  const normalized = String(value).trim();
  return normalized || "-";
}

function digest(tokenKey: string, scope: string, parts: readonly unknown[]): string {
  if (tokenKey.trim().length < 32) {
    throw new Error("PUBLIC_CREATION_CORRELATION_KEY_UNAVAILABLE");
  }
  const mac = createHmac("sha256", observabilityKey(tokenKey));
  mac.update(`fanjin:${scope}:v1`, "utf8");
  for (const part of parts) {
    mac.update("\0", "utf8");
    mac.update(canonicalPart(part), "utf8");
  }
  return mac.digest("hex");
}

function safeProjectId(value: unknown): number | null {
  const normalized = Number(value);
  return Number.isSafeInteger(normalized) && normalized > 0 ? normalized : null;
}

function publicPrompt(value: unknown): string {
  if (typeof value !== "string") return "";
  return redactSensitiveText(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, PROMPT_MAX_LENGTH);
}

function parseRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function primitiveParameter(value: unknown): SafeParameterValue | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const normalized = redactSensitiveText(value).trim();
  if (!normalized || normalized.length > 120 || normalized.includes("[REDACTED]")) return null;
  return normalized;
}

export function publicCreationPrompt(payloadValue: unknown, fallback: unknown = ""): string {
  const payload = parseRecord(payloadValue);
  const direct = publicPrompt(payload.prompt);
  if (direct) return direct;
  if (Array.isArray(payload.content)) {
    for (const entry of payload.content) {
      const item = parseRecord(entry);
      if (item.type !== "text") continue;
      const text = publicPrompt(item.text);
      if (text) return text;
    }
  }
  return publicPrompt(fallback);
}

export function publicCreationParameters(payloadValue: unknown): Record<string, SafeParameterValue> {
  const payload = parseRecord(payloadValue);
  const output: Record<string, SafeParameterValue> = {};
  for (const [privateField, publicField] of Object.entries(SAFE_PARAMETER_FIELDS)) {
    if (Object.hasOwn(output, publicField) || !Object.hasOwn(payload, privateField)) continue;
    const value = primitiveParameter(payload[privateField]);
    if (value !== null) output[publicField] = value;
  }
  return output;
}

export function publicProjectCorrelationDigest(input: {
  tokenKey: string;
  workspaceId: unknown;
  projectId: unknown;
}): string | null {
  const projectId = safeProjectId(input.projectId);
  if (projectId === null) return null;
  return digest(input.tokenKey, "project", [input.workspaceId, projectId]);
}

export function publicCreationCorrelation(input: {
  tokenKey: string;
  workspaceId: unknown;
  projectId: unknown;
  taskId: unknown;
  assetId?: unknown;
}): PublicCreationCorrelation {
  const projectId = safeProjectId(input.projectId);
  const projectDigest = publicProjectCorrelationDigest({
    tokenKey: input.tokenKey,
    workspaceId: input.workspaceId,
    projectId,
  });
  const common = [input.workspaceId, projectId, input.taskId] as const;
  return {
    version: OBSERVABILITY_VERSION,
    projectDigest,
    generationDigest: digest(input.tokenKey, "generation", common),
    taskDigest: digest(input.tokenKey, "task", common),
    ...(input.assetId === undefined
      ? {}
      : { assetDigest: digest(input.tokenKey, "asset", [...common, input.assetId]) }),
  };
}

/**
 * Stable, non-reversible reference used to connect a derived asset to its
 * source without publishing an internal media/task/version identifier.
 */
export function publicCreationLineageDigest(input: {
  tokenKey: string;
  workspaceId: unknown;
  projectId: unknown;
  referenceKind: "asset" | "asset_version" | "task";
  referenceId: unknown;
}): string {
  return digest(input.tokenKey, "lineage", [
    input.workspaceId,
    safeProjectId(input.projectId),
    input.referenceKind,
    input.referenceId,
  ]);
}

export function publicCreationRequestRef(input: {
  tokenKey: string;
  workspaceId: unknown;
  requestId: unknown;
  taskId: unknown;
}): string {
  return `req_${digest(input.tokenKey, "request", [input.workspaceId, input.requestId, input.taskId]).slice(0, REQUEST_REF_LENGTH)}`;
}

export function buildPublicCreationObservability(input: {
  tokenKey: string;
  workspaceId: unknown;
  projectId: unknown;
  taskId: unknown;
  requestId?: unknown;
  requestPayload?: unknown;
  fallbackPrompt?: unknown;
}): PublicCreationObservability {
  return {
    version: OBSERVABILITY_VERSION,
    prompt: publicCreationPrompt(input.requestPayload, input.fallbackPrompt),
    parameters: publicCreationParameters(input.requestPayload),
    requestRef: publicCreationRequestRef({
      tokenKey: input.tokenKey,
      workspaceId: input.workspaceId,
      requestId: input.requestId,
      taskId: input.taskId,
    }),
    correlation: publicCreationCorrelation(input),
  };
}

export function publicContentSha256(metadataValue: unknown): string | null {
  const metadata = parseRecord(metadataValue);
  const projections = [metadata, parseRecord(metadata.mediaProbe)];
  for (const projection of projections) {
    for (const key of ["contentSha256", "downloadSha256", "sha256"] as const) {
      const candidate = typeof projection[key] === "string"
        ? projection[key].trim().toLowerCase()
        : "";
      if (/^[a-f0-9]{64}$/.test(candidate)) return candidate;
    }
  }
  return null;
}
