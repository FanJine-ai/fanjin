import { parseProviderChannelConfig } from "@/lib/providerChannelSecrets";
import {
  providerCredentialFallbackEnvNames,
  resolveChannelApiKey,
  resolveChannelBaseUrl,
  resolvePortraitChannelCredential,
} from "@/lib/relayChannelCredential";
import {
  parseProviderChannelPortraitCredential,
  readProviderChannelPortraitCredentialMetadata,
} from "@/lib/providerChannelCredentials";
import { startVolcenginePortraitSignedFetch } from "@/lib/volcenginePortraitAssets";
import { isTokenhexPortraitOrigin } from "@/lib/tokenhexPortraitChannel";
import { TOKENHEX_PORTRAIT_ORIGIN } from "@/lib/providerChannelCredentials";
import { videoRelayProviderPollUrl, videoRelayProviderTaskId, videoRelayProviderStatus } from "@/lib/videoRelayProviderAdapter";

export type ProviderChannelHealthStatus = "ok" | "degraded" | "failed" | "disabled";
export type ProviderChannelConfigurationStatus = "ready" | "disabled" | "missing_credential" | "missing_probe_url";
export type ProviderChannelHealthFreshness = "fresh" | "stale" | "unchecked";

export interface ProviderChannelRecord {
  id: string;
  name?: string | null;
  workspaceId?: string | null;
  provider?: string | null;
  endpointType?: string | null;
  baseUrl?: string | null;
  credentialRef?: string | null;
  credentialCiphertext?: string | null;
  credentialPlaintext?: string | null;
  configJson?: unknown;
  timeoutMs?: number | string | null;
  disabled?: boolean | number | null;
  healthStatus?: string | null;
  lastHealthCheckAt?: number | string | null;
  lastHealthLatencyMs?: number | string | null;
  lastHealthError?: string | null;
}

export interface ProviderChannelConfiguration {
  status: ProviderChannelConfigurationStatus;
  credentialReady: boolean;
  probeUrl: string | null;
}

export interface ProviderChannelProbeResult extends ProviderChannelConfiguration {
  live: true;
  healthStatus: ProviderChannelHealthStatus;
  latencyMs: number | null;
  errorMessage: string | null;
  payload: Record<string, unknown>;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export const MEDIAKIT_HEALTH_PROBE_TASK_ID = "fanjin-health-probe-not-found" as const;
export const MEDIAKIT_HEALTH_PROBE_CONTRACT =
  "volcano-mediakit-authenticated-missing-task/v1" as const;

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isDisabled(value: unknown): boolean {
  return value === true || Number(value) === 1;
}

function isPortraitHealthChannel(input: {
  provider: unknown;
  endpointType: unknown;
  config: Record<string, unknown>;
}): boolean {
  return cleanString(input.provider) === "volcano"
    && cleanString(input.endpointType) === "video_generation"
    && readProviderChannelPortraitCredentialMetadata(input.config).enabled;
}

function channelCredentialForHealth(
  channel: ProviderChannelRecord,
  config: Record<string, unknown>,
): string {
  const credentialInput = {
    id: channel.id,
    provider: channel.provider,
    endpointType: channel.endpointType,
    credentialCiphertext: channel.credentialCiphertext ?? null,
    credentialPlaintext: channel.credentialPlaintext ?? null,
    credentialRef: channel.credentialRef ?? null,
    config,
  };
  if (isPortraitHealthChannel({
    provider: channel.provider,
    endpointType: channel.endpointType,
    config,
  })) {
    return resolvePortraitChannelCredential(credentialInput).value;
  }
  return resolveChannelApiKey(
    credentialInput,
    providerCredentialFallbackEnvNames(channel.provider, channel.endpointType),
  );
}

export function providerChannelHealthMaxAgeMs(): number {
  const configured = Number(process.env.FANJIN_PROVIDER_HEALTH_MAX_AGE_MS);
  return Number.isFinite(configured) && configured >= 60_000 ? configured : 15 * 60 * 1000;
}

export function providerChannelHealthFreshness(
  checkedAt: unknown,
  now = Date.now(),
  maxAgeMs = providerChannelHealthMaxAgeMs(),
): ProviderChannelHealthFreshness {
  const timestamp = Number(checkedAt || 0);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "unchecked";
  return now - timestamp <= Math.max(1, maxAgeMs) ? "fresh" : "stale";
}

function joinApiPath(baseUrl: string, apiPath: string): string {
  const root = cleanString(baseUrl).replace(/\/+$/, "");
  const path = cleanString(apiPath).replace(/^\/+/, "");
  if (!root || !path) return root || path;

  for (const prefix of ["v1", "v1beta", "api/v3", "openai"]) {
    if (root.toLowerCase().endsWith(`/${prefix}`) && path.toLowerCase().startsWith(`${prefix}/`)) {
      return `${root}/${path.slice(prefix.length + 1)}`;
    }
  }
  return `${root}/${path}`;
}

function withAzureApiVersion(url: string, config: Record<string, unknown>): string {
  const apiVersion = cleanString(config.apiVersion) || "2024-10-21";
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.has("api-version")) parsed.searchParams.set("api-version", apiVersion);
    return parsed.toString();
  } catch {
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}api-version=${encodeURIComponent(apiVersion)}`;
  }
}

export function resolveProviderChannelProbeUrl(input: {
  provider: unknown;
  endpointType?: unknown;
  baseUrl: unknown;
  config?: Record<string, unknown>;
}): string | null {
  const config = input.config || {};
  const provider = cleanString(input.provider);
  if (provider === "autodl") {
    const taskId = cleanString(config.healthProbeTaskId);
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(taskId)) return null;
    try { return videoRelayProviderPollUrl("autodl", cleanString(input.baseUrl) || cleanString(config.baseUrl), taskId); }
    catch { return null; }
  }
  if (isPortraitHealthChannel({ provider, endpointType: input.endpointType, config })) {
    return isTokenhexPortraitOrigin(input.baseUrl)
      ? `${TOKENHEX_PORTRAIT_ORIGIN}/ark/api/v1/assets/ListAssetGroups`
      : "https://ark.cn-beijing.volcengineapi.com/?Action=ListAssetGroups&Version=2024-01-01";
  }
  const explicit = cleanString(config.healthProbeUrl);
  if (explicit) return explicit;

  const fallbackBaseUrl = provider === "volcano" ? "https://ark.cn-beijing.volces.com" : "";
  const baseUrl = cleanString(input.baseUrl) || cleanString(config.baseUrl) || fallbackBaseUrl;
  if (!baseUrl) return null;

  if (provider === "volcano" && cleanString(input.endpointType) === "video_upscale") {
    return joinApiPath(baseUrl, `api/v1/tasks/${MEDIAKIT_HEALTH_PROBE_TASK_ID}`);
  }
  if (provider === "volcano") return joinApiPath(baseUrl, "api/v3/models");
  if (provider === "gemini") return joinApiPath(baseUrl, "v1beta/models");
  if (provider === "azure") return withAzureApiVersion(joinApiPath(baseUrl, "openai/models"), config);
  return joinApiPath(baseUrl, "v1/models");
}

function isJsonResponse(response: Response): boolean {
  return cleanString(response.headers.get("content-type")).toLowerCase().includes("application/json");
}

function isMediaKitAuthenticatedMissingTaskProbe(input: {
  channel: ProviderChannelRecord;
  probeUrl: string;
  response: Response;
  body: unknown;
}): boolean {
  if (
    cleanString(input.channel.provider) !== "volcano"
    || cleanString(input.channel.endpointType) !== "video_upscale"
    || input.response.status !== 404
    || !isJsonResponse(input.response)
    || !input.body
    || typeof input.body !== "object"
    || Array.isArray(input.body)
  ) return false;
  const body = input.body as Record<string, unknown>;
  if (body.success !== false) return false;
  const error = body.error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return false;
  const errorRecord = error as Record<string, unknown>;
  const errorCode = cleanString(errorRecord.code);
  const errorType = cleanString(errorRecord.type);
  const errorSemantic = [errorRecord.code, errorRecord.type, errorRecord.message]
    .map(cleanString)
    .filter(Boolean)
    .join(" ");
  if (
    !(errorCode === "InvalidParameter" && errorType === "NotFound")
    && !/(?:task[^\n]{0,80}(?:not[ _-]?found|does not exist|nonexistent)|(?:not[ _-]?found|does not exist)[^\n]{0,80}task|任务[^\n]{0,40}(?:不存在|未找到))/iu.test(errorSemantic)
  ) return false;
  try {
    const url = new URL(input.probeUrl);
    return url.protocol === "https:"
      && url.hostname === "mediakit.cn-beijing.volces.com"
      && url.pathname === `/api/v1/tasks/${MEDIAKIT_HEALTH_PROBE_TASK_ID}`;
  } catch {
    return false;
  }
}

export function resolveProviderChannelRequestHeaders(
  provider: string,
  apiKey: string,
  config: Record<string, unknown>,
): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (provider === "anthropic") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = cleanString(config.anthropicVersion) || "2023-06-01";
  } else if (provider === "gemini") {
    headers["x-goog-api-key"] = apiKey;
  } else if (provider === "azure") {
    headers["api-key"] = apiKey;
  } else if (provider === "autodl") {
    headers.Authorization = apiKey;
  } else {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

export function resolveProviderChannelTimeoutMs(
  channel: ProviderChannelRecord,
  config: Record<string, unknown>,
): number {
  const configured = Number(config.healthTimeoutMs || 10_000);
  const channelTimeout = Number(channel.timeoutMs || 600_000);
  const requested = Number.isFinite(configured) && configured > 0 ? configured : 10_000;
  const channelLimit = Number.isFinite(channelTimeout) && channelTimeout > 0 ? channelTimeout : 600_000;
  return Math.max(1_000, Math.min(requested, channelLimit, 30_000));
}

function parseResponseBody(text: string): unknown {
  const truncated = text.length > 1_200 ? `${text.slice(0, 1_200)}...` : text;
  if (!/^\s*[\[{]/.test(text)) return truncated;
  try {
    return JSON.parse(text);
  } catch {
    return truncated;
  }
}

export function inspectProviderChannelConfiguration(channel: ProviderChannelRecord): ProviderChannelConfiguration {
  const config = parseProviderChannelConfig(channel.configJson);
  const credentialValue = channelCredentialForHealth(channel, config);
  const baseUrl = resolveChannelBaseUrl({ baseUrl: channel.baseUrl ?? null, config });
  const probeUrl = resolveProviderChannelProbeUrl({
    provider: channel.provider,
    endpointType: channel.endpointType,
    baseUrl,
    config,
  });
  const credentialReady = Boolean(credentialValue);
  const status: ProviderChannelConfigurationStatus = isDisabled(channel.disabled)
    ? "disabled"
    : !credentialReady
      ? "missing_credential"
      : !probeUrl
        ? "missing_probe_url"
        : "ready";
  return { status, credentialReady, probeUrl };
}

export async function probeProviderChannel(
  channel: ProviderChannelRecord,
  options: { fetchImpl?: FetchLike } = {},
): Promise<ProviderChannelProbeResult> {
  const config = parseProviderChannelConfig(channel.configJson);
  const configuration = inspectProviderChannelConfiguration(channel);
  if (configuration.status === "disabled") {
    return {
      ...configuration,
      live: true,
      healthStatus: "disabled",
      latencyMs: null,
      errorMessage: "通道已下线",
      payload: { live: true, skipped: true, reason: "disabled" },
    };
  }
  if (configuration.status === "missing_credential") {
    return {
      ...configuration,
      live: true,
      healthStatus: "failed",
      latencyMs: null,
      errorMessage: "通道凭据未配置",
      payload: { live: true, skipped: true, reason: "credential_not_configured" },
    };
  }
  if (configuration.status === "missing_probe_url" || !configuration.probeUrl) {
    return {
      ...configuration,
      live: true,
      healthStatus: "degraded",
      latencyMs: null,
      errorMessage: "未配置可探测的供应商地址",
      payload: { live: true, skipped: true, reason: "probe_url_not_configured" },
    };
  }

  const credentialValue = channelCredentialForHealth(channel, config);
  const provider = cleanString(channel.provider);
  const timeoutMs = resolveProviderChannelTimeoutMs(channel, config);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    if (isPortraitHealthChannel({ provider, endpointType: channel.endpointType, config })) {
      const credential = parseProviderChannelPortraitCredential(credentialValue);
      if (!credential) {
        return {
          ...configuration,
          live: true,
          healthStatus: "failed",
          latencyMs: Date.now() - startedAt,
          errorMessage: "人像资产 AK/SK JSON 凭据格式无效",
          payload: { live: true, reason: "portrait_credential_invalid" },
        };
      }
      const configuredProjectName = cleanString(config.assetsProjectName || config.projectName);
      const body = JSON.stringify({
        Filter: { GroupType: "AIGC" },
        PageNumber: 1,
        PageSize: 1,
        ...(configuredProjectName ? { ProjectName: configuredProjectName } : {}),
      });
      const response = await startVolcenginePortraitSignedFetch({
        attempt: { action: "ListAssetGroups", at: new Date(), body, signal: controller.signal },
        credentialEnvelope: credentialValue,
        fetch: options.fetchImpl || fetch,
        baseUrl: channel.baseUrl,
      }).response;
      const text = await response.text();
      const payloadBody = parseResponseBody(text || "");
      const upstreamError = typeof payloadBody === "object" && payloadBody
        ? (payloadBody as any).ResponseMetadata?.Error
        : null;
      const ok = response.ok && !upstreamError;
      return {
        ...configuration,
        live: true,
        healthStatus: ok ? "ok" : response.status === 401 || response.status === 403 ? "failed" : "degraded",
        latencyMs: Date.now() - startedAt,
        errorMessage: ok ? null : cleanString(upstreamError?.Message) || `供应商探测失败：HTTP ${response.status}`,
        payload: { live: true, probeUrl: configuration.probeUrl, httpStatus: response.status, ok, body: payloadBody },
      };
    }
    const response = await (options.fetchImpl || fetch)(configuration.probeUrl, {
      method: "GET",
      headers: resolveProviderChannelRequestHeaders(provider, credentialValue, config),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - startedAt;
    const text = await response.text();
    const body = parseResponseBody(text || "");
    if (provider === "autodl") {
      const data = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
      const taskId = videoRelayProviderTaskId("autodl", data);
      const taskStatus = videoRelayProviderStatus("autodl", data);
      const ok = response.ok && taskId === config.healthProbeTaskId
        && typeof taskStatus === "string" && ["queued", "running", "success", "completed", "failed"].includes(taskStatus.toLowerCase());
      return { ...configuration, live: true, healthStatus: ok ? "ok" : "degraded", latencyMs,
        errorMessage: ok ? null : "AutoDL 任务读取校验未通过，请检查凭据及探测任务归属",
        payload: { live: true, httpStatus: response.status, ok, taskId, taskStatus, probeContract: "autodl-existing-task-read/v1" } };
    }
    const payload = {
      live: true,
      probeUrl: configuration.probeUrl,
      httpStatus: response.status,
      ok: response.ok,
      body,
    };
    if (response.ok) {
      return {
        ...configuration,
        live: true,
        healthStatus: "ok",
        latencyMs,
        errorMessage: null,
        payload,
      };
    }
    if (isMediaKitAuthenticatedMissingTaskProbe({
      channel,
      probeUrl: configuration.probeUrl,
      response,
      body,
    })) {
      return {
        ...configuration,
        live: true,
        healthStatus: "ok",
        latencyMs,
        errorMessage: null,
        payload: {
          ...payload,
          ok: true,
          probeContract: MEDIAKIT_HEALTH_PROBE_CONTRACT,
        },
      };
    }
    const healthStatus: ProviderChannelHealthStatus = response.status === 401 || response.status === 403 ? "failed" : "degraded";
    return {
      ...configuration,
      live: true,
      healthStatus,
      latencyMs,
      errorMessage: `供应商探测失败：HTTP ${response.status}`,
      payload,
    };
  } catch (error: unknown) {
    const isTimeout = error instanceof Error && error.name === "AbortError";
    const message = isTimeout
      ? `健康检查超时：${timeoutMs}ms`
      : error instanceof Error && error.message
        ? error.message
        : "供应商健康检查失败";
    return {
      ...configuration,
      live: true,
      healthStatus: "failed",
      latencyMs: Date.now() - startedAt,
      errorMessage: message,
      payload: { live: true, error: message, timeout: isTimeout },
    };
  } finally {
    clearTimeout(timer);
  }
}
