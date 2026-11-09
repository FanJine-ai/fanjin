import { parseProviderChannelConfig } from "@/lib/providerChannelSecrets";
import {
  resolveProviderChannelProbeUrl,
  resolveProviderChannelRequestHeaders,
  resolveProviderChannelTimeoutMs,
  type ProviderChannelRecord,
} from "@/lib/providerChannelHealth";
import {
  providerCredentialFallbackEnvNames,
  resolveChannelApiKey,
  resolveChannelBaseUrl,
} from "@/lib/relayChannelCredential";

const MAX_MODEL_COUNT = 1_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class ProviderChannelModelDiscoveryError extends Error {
  readonly statusCode: 400 | 502 | 504;

  constructor(message: string, statusCode: 400 | 502 | 504) {
    super(message);
    this.name = "ProviderChannelModelDiscoveryError";
    this.statusCode = statusCode;
  }
}

export interface ProviderChannelModelDiscoveryResult {
  models: string[];
  total: number;
  truncated: boolean;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function resolveModelListUrl(channel: ProviderChannelRecord, config: Record<string, unknown>): string | null {
  const explicit = cleanString(config.modelDiscoveryUrl)
    || cleanString(config.modelListUrl)
    || cleanString(config.modelsUrl);
  if (explicit) return explicit;
  return resolveProviderChannelProbeUrl({
    provider: channel.provider,
    baseUrl: resolveChannelBaseUrl({ baseUrl: channel.baseUrl ?? null, config }),
    config,
  });
}

function modelCollection(payload: unknown): unknown[] | null {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  for (const key of ["data", "models", "items", "results"]) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  for (const key of ["data", "result", "response"]) {
    const nested = modelCollection(record[key]);
    if (nested) return nested;
  }
  return null;
}

function normalizeModelName(value: unknown): string {
  const name = cleanString(value);
  if (!name || name.length > 512) return "";
  return name
    .replace(/^publishers\/[^/]+\/models\//, "")
    .replace(/^models\//, "");
}

function modelName(item: unknown): string {
  if (typeof item === "string") return normalizeModelName(item);
  if (!item || typeof item !== "object" || Array.isArray(item)) return "";
  const record = item as Record<string, unknown>;
  for (const key of ["id", "model", "modelId", "model_id", "endpointId", "endpoint_id", "name"]) {
    const normalized = normalizeModelName(record[key]);
    if (normalized) return normalized;
  }
  return "";
}

async function readLimitedResponseText(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new ProviderChannelModelDiscoveryError("上游模型列表过大，无法安全读取", 502);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new ProviderChannelModelDiscoveryError("上游模型列表过大，无法安全读取", 502);
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

export async function discoverProviderChannelModels(
  channel: ProviderChannelRecord,
  options: { fetchImpl?: FetchLike } = {},
): Promise<ProviderChannelModelDiscoveryResult> {
  const config = parseProviderChannelConfig(channel.configJson);
  const apiKey = resolveChannelApiKey({
    id: channel.id,
    provider: channel.provider,
    endpointType: channel.endpointType,
    credentialCiphertext: channel.credentialCiphertext ?? null,
    credentialPlaintext: channel.credentialPlaintext ?? null,
    credentialRef: channel.credentialRef ?? null,
    config,
  }, providerCredentialFallbackEnvNames(channel.provider, channel.endpointType));
  if (!apiKey) {
    throw new ProviderChannelModelDiscoveryError("通道凭据未配置，无法获取上游模型", 400);
  }

  const jwsType = channel.provider === "openai" && config.imageTransport === "jws-async-v1" && channel.endpointType === "image_generation" ? "image" : null;
  const modelsUrl = jwsType
    ? resolveProviderChannelProbeUrl({provider: "openai", baseUrl: resolveChannelBaseUrl({baseUrl: channel.baseUrl ?? null, config})})?.replace(/\/models$/, `/catalog/models?type=${jwsType}`)
    : resolveModelListUrl(channel, config);
  if (!modelsUrl) {
    throw new ProviderChannelModelDiscoveryError("未配置可获取模型的供应商地址", 400);
  }

  const provider = cleanString(channel.provider);
  const timeoutMs = resolveProviderChannelTimeoutMs(channel, config);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await (options.fetchImpl || fetch)(modelsUrl, {
      method: "GET",
      redirect: "error",
      headers: resolveProviderChannelRequestHeaders(provider, apiKey, config),
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      const hint = response.status === 401 || response.status === 403 ? "，请检查 API Key 权限" : "";
      throw new ProviderChannelModelDiscoveryError(`上游模型列表请求失败：HTTP ${response.status}${hint}`, 502);
    }

    const text = await readLimitedResponseText(response);
    let payload: unknown;
    try {
      payload = JSON.parse(text || "null");
    } catch {
      throw new ProviderChannelModelDiscoveryError("上游模型列表不是有效 JSON", 502);
    }
    const collection = modelCollection(payload);
    if (!collection) {
      throw new ProviderChannelModelDiscoveryError("上游响应中没有可识别的模型列表", 502);
    }

    const names = jwsType ? collection.filter((item: any) => typeof item?.id === "string" && item.id.startsWith(`${jwsType}:`) && typeof item.name === "string").map((item: any) => normalizeModelName(item.name)) : collection.map(modelName);
    const allModels = [...new Set(names.filter(Boolean))];
    return {
      models: allModels.slice(0, MAX_MODEL_COUNT),
      total: allModels.length,
      truncated: allModels.length > MAX_MODEL_COUNT,
    };
  } catch (caught) {
    if (caught instanceof ProviderChannelModelDiscoveryError) throw caught;
    if (caught instanceof Error && caught.name === "AbortError") {
      throw new ProviderChannelModelDiscoveryError(`获取上游模型超时：${timeoutMs}ms`, 504);
    }
    throw new ProviderChannelModelDiscoveryError("无法连接上游模型接口", 502);
  } finally {
    clearTimeout(timer);
  }
}
