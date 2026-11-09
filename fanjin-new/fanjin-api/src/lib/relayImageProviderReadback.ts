import { hashIdempotencyRequest } from "@/agent-runtime/idempotency";
import {
  settleApiTaskReservation,
  type ApiTaskReservationSettlementInput,
  type ApiTaskReservationSettlementResult,
} from "@/lib/billing";
import { resolveChannelApiKey, resolveChannelBaseUrl } from "@/lib/relayChannelCredential";
import { resolveProviderChannelRequestHeaders } from "@/lib/providerChannelHealth";
import { parseProviderChannelConfig } from "@/lib/providerChannelSecrets";
import type { RelayChannel } from "@/lib/sharedTypes";
import type { RelayImageRequest, RelayImageResult } from "@/lib/relayImage";
import type { Knex } from "knex";

export const RELAY_IMAGE_PROVIDER_READBACK_CONTRACT_VERSION =
  "relay-image-provider-readback.v1" as const;
export const RELAY_IMAGE_PROVIDER_READBACK_PROOF_VERSION =
  "relay-image-provider-readback-proof.v1" as const;
export const RELAY_IMAGE_PROVIDER_READBACK_CAPABILITY_VERSION =
  "relay-image-provider-readback-capability.v1" as const;
export const RELAY_IMAGE_REQUEST_RECORD_READBACK_VERSION =
  "relay-image-request-record-readback.v1" as const;
export const RELAY_IMAGE_PROVIDER_READBACK_SETTLEMENT_AUTHORIZATION_VERSION =
  "relay-image-provider-readback-settlement-authorization.v1" as const;
export const RELAY_IMAGE_PROVIDER_READBACK_SETTLEMENT_PROOF_VERSION =
  "relay-image-provider-readback-settlement-proof.v1" as const;

const PROVIDER_REQUEST_ID_PLACEHOLDER = "{providerRequestId}";
const MAX_READBACK_BODY_BYTES = 2 * 1024 * 1024;

export type RelayImageProviderReadbackPolicy =
  | "authoritative_required"
  | "manual_reconcile";

export type RelayImageProviderReadbackUnsupportedReason =
  | "volcano_sync_images_generation_no_authoritative_readback"
  | "openai_sync_images_generation_no_authoritative_readback"
  | "provider_readback_not_configured"
  | "provider_readback_custom_gateway_required"
  | "provider_readback_configuration_invalid";

interface RelayImageProviderReadbackCapabilityBase {
  contractVersion: typeof RELAY_IMAGE_PROVIDER_READBACK_CAPABILITY_VERSION;
  provider: string;
  channelId: string;
  policy: RelayImageProviderReadbackPolicy;
}

export type RelayImageProviderReadbackCapability =
  | (RelayImageProviderReadbackCapabilityBase & {
      readbackSupported: true;
      readbackUnsupported: false;
      readiness: "ready" | "degraded";
      reason: null;
      adapterVersion: typeof RELAY_IMAGE_REQUEST_RECORD_READBACK_VERSION;
      mode: "provider_request_id";
      pathTemplate: string;
    })
  | (RelayImageProviderReadbackCapabilityBase & {
      readbackSupported: false;
      readbackUnsupported: true;
      readiness: "degraded" | "blocked";
      reason: RelayImageProviderReadbackUnsupportedReason;
      adapterVersion: null;
      mode: null;
      pathTemplate: null;
    });

export interface RelayImageProviderReadbackAdmission {
  allowed: boolean;
  capability: RelayImageProviderReadbackCapability;
}

export type RelayImageProviderReadbackState =
  | "accepted_unknown"
  | "definitively_not_accepted"
  | "recovered_result"
  | "unsupported";

export interface RelayImageProviderReadbackBinding {
  contractVersion: typeof RELAY_IMAGE_PROVIDER_READBACK_PROOF_VERSION;
  provider: string;
  providerRequestId: string;
  model: string;
  requestHash: string;
  adapterVersion: string;
  observedAt: number;
  providerRecordId: string;
  providerDisposition:
    | "accepted_unknown"
    | "definitively_not_accepted"
    | "recovered_result";
}

export interface RelayImageProviderRecoveredResultBinding
  extends RelayImageProviderReadbackBinding {
  resultHash: string;
}

export interface RelayImageProviderReadbackSettlementAuthorization {
  contractVersion:
    typeof RELAY_IMAGE_PROVIDER_READBACK_SETTLEMENT_AUTHORIZATION_VERSION;
  policy: "authoritative_required";
  readiness: "ready";
  workspaceId: string;
  reservationId: string;
  usageRecordId: string;
  provider: string;
  channelId: string;
  providerRequestId: string;
  model: string;
  requestHash: string;
  resultHash: string;
  adapterVersion: string;
  billingKey: string;
  units: number;
  unit: "image";
  actualCostMicros: number;
}

export interface RelayImageProviderReadbackSettlementProof {
  contractVersion:
    typeof RELAY_IMAGE_PROVIDER_READBACK_SETTLEMENT_PROOF_VERSION;
  authorizationContractVersion:
    typeof RELAY_IMAGE_PROVIDER_READBACK_SETTLEMENT_AUTHORIZATION_VERSION;
  workspaceId: string;
  reservationId: string;
  usageRecordId: string;
  provider: string;
  channelId: string;
  providerRequestId: string;
  model: string;
  requestHash: string;
  resultHash: string;
  billingKey: string;
  units: number;
  unit: "image";
  actualCostMicros: number;
  captureLedgerId: string;
  idempotent: boolean;
}

export type RelayImageProviderAdapterOutcome =
  | {
      state: "accepted_unknown";
      reason: string;
      binding: RelayImageProviderReadbackBinding;
    }
  | {
      state: "definitively_not_accepted";
      reason: string;
      binding: RelayImageProviderReadbackBinding;
    }
  | {
      state: "recovered_result";
      result: RelayImageResult;
      binding: RelayImageProviderRecoveredResultBinding;
    };

export interface RelayImageProviderReadbackAdapter {
  provider: string;
  version: string;
  readByProviderRequestId(input: {
    providerRequestId: string;
    model: string;
    requestHash: string;
    expectedCount: number;
  }): Promise<RelayImageProviderAdapterOutcome>;
}

interface RelayImageProviderReadbackBase {
  contractVersion: typeof RELAY_IMAGE_PROVIDER_READBACK_CONTRACT_VERSION;
  provider: string;
  providerRequestId: string;
  model: string;
  requestHash: string;
  checkedAt: number;
  /** A readback is evidence collection, never authorization for another POST. */
  automaticRedispatchAllowed: false;
  /** Billing release always remains a separately fenced reconciliation action. */
  automaticReleaseAllowed: false;
}

export type RelayImageProviderReadbackOutcome =
  | (RelayImageProviderReadbackBase & {
      state: "unsupported";
      reason: string;
      adapterVersion: null;
      binding: null;
      result: null;
      settlementAuthorization: null;
      mayMaterializeAssets: false;
      maySettleBilling: false;
    })
  | (RelayImageProviderReadbackBase & {
      state: "accepted_unknown";
      reason: string;
      adapterVersion: string | null;
      binding: RelayImageProviderReadbackBinding | null;
      result: null;
      settlementAuthorization: null;
      mayMaterializeAssets: false;
      maySettleBilling: false;
    })
  | (RelayImageProviderReadbackBase & {
      state: "definitively_not_accepted";
      reason: string;
      adapterVersion: string;
      binding: RelayImageProviderReadbackBinding;
      result: null;
      settlementAuthorization: null;
      mayMaterializeAssets: false;
      maySettleBilling: false;
    })
  | (RelayImageProviderReadbackBase & {
      state: "recovered_result";
      reason: null;
      adapterVersion: string;
      binding: RelayImageProviderRecoveredResultBinding;
      result: RelayImageResult;
    } & (
      | {
          settlementAuthorization:
            RelayImageProviderReadbackSettlementAuthorization;
          mayMaterializeAssets: true;
          maySettleBilling: true;
        }
      | {
          settlementAuthorization: null;
          mayMaterializeAssets: false;
          maySettleBilling: false;
        }
    ));

export class RelayImageProviderReadbackProtocolError extends Error {
  readonly code = "relay_image_provider_readback_protocol_invalid";

  constructor(message: string) {
    super(message);
    this.name = "RelayImageProviderReadbackProtocolError";
  }
}

export type RelayImageProviderReadbackFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function requiredString(value: unknown, field: string, maxLength = 512): string {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > maxLength) {
    throw new RelayImageProviderReadbackProtocolError(
      `图片上游回查缺少有效的 ${field}`,
    );
  }
  return normalized;
}

function nonNegativeTimestamp(value: unknown, field: string): number {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new RelayImageProviderReadbackProtocolError(
      `图片上游回查缺少有效的 ${field}`,
    );
  }
  return normalized;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (isPlainObject(value)) return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizedProvider(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

function policyFromChannelConfig(config: Record<string, unknown>): {
  policy: RelayImageProviderReadbackPolicy;
  invalid: boolean;
} {
  const nested = isPlainObject(config.imageReadback)
    ? config.imageReadback
    : null;
  const configured = nested?.policy ?? config.imageReadbackPolicy;
  if (configured == null || String(configured).trim() === "") {
    return {
      policy: nested ? "authoritative_required" : "manual_reconcile",
      invalid: false,
    };
  }
  if (
    configured === "authoritative_required"
    || configured === "manual_reconcile"
  ) {
    return { policy: configured, invalid: false };
  }
  // A misspelled explicit policy must not silently downgrade to a paid
  // manual-reconciliation route. Absence remains the migration-safe default.
  return { policy: "authoritative_required", invalid: true };
}

function unsupportedCapability(input: {
  channel: RelayChannel;
  policy: RelayImageProviderReadbackPolicy;
  reason: RelayImageProviderReadbackUnsupportedReason;
}): RelayImageProviderReadbackCapability {
  return {
    contractVersion: RELAY_IMAGE_PROVIDER_READBACK_CAPABILITY_VERSION,
    provider: normalizedProvider(input.channel.provider),
    channelId: String(input.channel.id || "").trim(),
    policy: input.policy,
    readbackSupported: false,
    readbackUnsupported: true,
    readiness: input.policy === "authoritative_required" ? "blocked" : "degraded",
    reason: input.reason,
    adapterVersion: null,
    mode: null,
    pathTemplate: null,
  };
}

function validReadbackPathTemplate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const template = value.trim();
  const placeholderCount = template.split(PROVIDER_REQUEST_ID_PLACEHOLDER).length - 1;
  return (
    template.length > 0
    && template.length <= 1_024
    && template.startsWith("/")
    && placeholderCount === 1
    && !template.startsWith("//")
    && !template.includes("\\")
    && !template.includes("#")
    && !template.split("/").includes("..")
  );
}

function sameOriginReadbackUrl(input: {
  channel: RelayChannel;
  pathTemplate: string;
  providerRequestId: string;
}): string {
  const baseUrl = resolveChannelBaseUrl(input.channel);
  let base: URL;
  let resolved: URL;
  try {
    base = new URL(baseUrl);
    resolved = new URL(
      input.pathTemplate.replace(
        PROVIDER_REQUEST_ID_PLACEHOLDER,
        encodeURIComponent(input.providerRequestId),
      ),
      base,
    );
  } catch {
    throw new RelayImageProviderReadbackProtocolError(
      "图片上游回查地址无效",
    );
  }
  if (
    !["http:", "https:"].includes(base.protocol)
    || base.username
    || base.password
    || base.hash
    || resolved.origin !== base.origin
    || resolved.username
    || resolved.password
    || resolved.hash
  ) {
    throw new RelayImageProviderReadbackProtocolError(
      "图片上游回查地址必须与供应商通道同源",
    );
  }
  return resolved.toString();
}

/**
 * Built-in Volcano/OpenAI image endpoints are synchronous POST APIs and do
 * not expose a request-id lookup endpoint. Only an explicitly configured
 * custom gateway that persists request records can claim authoritative
 * readback. Routes without an explicit policy remain manual_reconcile so the
 * migration does not disable today's real provider calls.
 */
export function resolveRelayImageProviderReadbackCapability(
  channel: RelayChannel,
): RelayImageProviderReadbackCapability {
  const config = channel.config || {};
  const provider = normalizedProvider(channel.provider);
  const policyResolution = policyFromChannelConfig(config);
  if (policyResolution.invalid) {
    return unsupportedCapability({
      channel,
      policy: policyResolution.policy,
      reason: "provider_readback_configuration_invalid",
    });
  }
  const readback = isPlainObject(config.imageReadback)
    ? config.imageReadback
    : null;
  if (!readback) {
    const reason: RelayImageProviderReadbackUnsupportedReason = provider === "volcano"
      ? "volcano_sync_images_generation_no_authoritative_readback"
      : provider === "openai"
        ? "openai_sync_images_generation_no_authoritative_readback"
        : "provider_readback_not_configured";
    return unsupportedCapability({
      channel,
      policy: policyResolution.policy,
      reason,
    });
  }
  if (provider !== "custom") {
    return unsupportedCapability({
      channel,
      policy: policyResolution.policy,
      reason: "provider_readback_custom_gateway_required",
    });
  }
  if (
    readback.version !== RELAY_IMAGE_REQUEST_RECORD_READBACK_VERSION
    || readback.mode !== "provider_request_id"
    || !validReadbackPathTemplate(readback.pathTemplate)
  ) {
    return unsupportedCapability({
      channel,
      policy: policyResolution.policy,
      reason: "provider_readback_configuration_invalid",
    });
  }
  try {
    sameOriginReadbackUrl({
      channel,
      pathTemplate: readback.pathTemplate,
      providerRequestId: "capability-probe",
    });
  } catch {
    return unsupportedCapability({
      channel,
      policy: policyResolution.policy,
      reason: "provider_readback_configuration_invalid",
    });
  }
  return {
    contractVersion: RELAY_IMAGE_PROVIDER_READBACK_CAPABILITY_VERSION,
    provider,
    channelId: String(channel.id || "").trim(),
    policy: policyResolution.policy,
    readbackSupported: true,
    readbackUnsupported: false,
    // A configured adapter proves technical recoverability. The B11 release
    // gate is green only when the route also requires that authority; a
    // manual policy remains visibly degraded and cannot masquerade as done.
    readiness: policyResolution.policy === "authoritative_required"
      ? "ready"
      : "degraded",
    reason: null,
    adapterVersion: RELAY_IMAGE_REQUEST_RECORD_READBACK_VERSION,
    mode: "provider_request_id",
    pathTemplate: readback.pathTemplate.trim(),
  };
}

export function resolveRelayImageProviderReadbackAdmission(
  channel: RelayChannel,
): RelayImageProviderReadbackAdmission {
  const capability = resolveRelayImageProviderReadbackCapability(channel);
  return {
    allowed: capability.readiness !== "blocked",
    capability,
  };
}

export function relayImageProviderReadbackDispatchHeaders(input: {
  channel: RelayChannel;
  providerRequestId: string;
  requestHash: string;
}): Record<string, string> {
  const capability = resolveRelayImageProviderReadbackCapability(input.channel);
  if (!capability.readbackSupported) return {};
  const providerRequestId = requiredString(
    input.providerRequestId,
    "providerRequestId",
  );
  const requestHash = requiredString(input.requestHash, "requestHash", 64);
  if (!/^[a-f0-9]{64}$/.test(requestHash)) {
    throw new RelayImageProviderReadbackProtocolError(
      "图片上游派发请求摘要无效",
    );
  }
  return {
    "X-Fanjin-Readback-Contract": capability.adapterVersion,
    "X-Fanjin-Provider-Request-Id": providerRequestId,
    "X-Fanjin-Request-SHA256": requestHash,
  };
}

export function relayImageProviderReadbackBillingMetadata(
  capability: RelayImageProviderReadbackCapability,
): Record<string, unknown> {
  return {
    contractVersion: capability.contractVersion,
    policy: capability.policy,
    readiness: capability.readiness,
    readbackSupported: capability.readbackSupported,
    readbackUnsupported: capability.readbackUnsupported,
    reason: capability.reason,
    adapterVersion: capability.adapterVersion,
  };
}

function isValidImageItem(
  value: unknown,
): value is { url?: string; b64_json?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.url === "string" && Boolean(item.url.trim())
  ) || (
    typeof item.b64_json === "string" && Boolean(item.b64_json.trim())
  );
}

function validateRecoveredResult(
  result: RelayImageResult,
  expectedCount: number,
): RelayImageResult {
  if (
    !result
    || typeof result !== "object"
    || !Number.isSafeInteger(Number(result.created))
    || Number(result.created) < 0
    || !Array.isArray(result.data)
    || result.data.length !== expectedCount
    || result.data.some((item) => !isValidImageItem(item))
  ) {
    throw new RelayImageProviderReadbackProtocolError(
      "图片上游回查结果数量或媒体字段与原请求不一致",
    );
  }
  return result;
}

function validateBinding(input: {
  binding: RelayImageProviderReadbackBinding;
  provider: string;
  providerRequestId: string;
  model: string;
  requestHash: string;
  adapterVersion: string;
  expectedState: Exclude<RelayImageProviderReadbackState, "unsupported">;
}): RelayImageProviderReadbackBinding {
  const binding = input.binding;
  if (
    !binding
    || binding.contractVersion !== RELAY_IMAGE_PROVIDER_READBACK_PROOF_VERSION
    || requiredString(binding.provider, "binding.provider", 100) !== input.provider
    || requiredString(binding.providerRequestId, "binding.providerRequestId")
      !== input.providerRequestId
    || requiredString(binding.model, "binding.model", 200) !== input.model
    || requiredString(binding.requestHash, "binding.requestHash", 64)
      !== input.requestHash
    || requiredString(binding.adapterVersion, "binding.adapterVersion", 100)
      !== input.adapterVersion
    || binding.providerDisposition !== input.expectedState
    || !/^[a-f0-9]{64}$/.test(binding.requestHash)
  ) {
    throw new RelayImageProviderReadbackProtocolError(
      "图片上游回查证明与原始供应商请求不一致",
    );
  }
  nonNegativeTimestamp(binding.observedAt, "binding.observedAt");
  requiredString(binding.providerRecordId, "binding.providerRecordId");
  return binding;
}

/**
 * Stable request hash used by a provider adapter to bind readback evidence to
 * the exact paid POST. Raw prompts, reference URLs and credentials are never
 * copied into the readback checkpoint.
 */
export function relayImageProviderRequestHash(
  request: RelayImageRequest,
): string {
  return hashIdempotencyRequest(request);
}

async function readBoundedResponseText(
  response: Response,
  maximumBytes = MAX_READBACK_BODY_BYTES,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    total += item.value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new RelayImageProviderReadbackProtocolError(
        "图片上游回查响应超过安全大小限制",
      );
    }
    chunks.push(item.value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total)
    .toString("utf8");
}

function responseHeader(
  response: Response,
  name: string,
): string {
  return String(response.headers.get(name) || "").trim();
}

function readGatewayResult(value: unknown): RelayImageResult {
  if (!isPlainObject(value)) {
    throw new RelayImageProviderReadbackProtocolError(
      "图片上游回查成功记录缺少结果",
    );
  }
  const created = nonNegativeTimestamp(value.created, "result.created");
  if (!Array.isArray(value.data)) {
    throw new RelayImageProviderReadbackProtocolError(
      "图片上游回查成功记录缺少图片数组",
    );
  }
  const data = value.data.map((item) => {
    if (!isValidImageItem(item)) {
      throw new RelayImageProviderReadbackProtocolError(
        "图片上游回查成功记录含无效图片",
      );
    }
    const record = item as Record<string, unknown>;
    return {
      ...(typeof record.url === "string" ? { url: record.url } : {}),
      ...(typeof record.b64_json === "string"
        ? { b64_json: record.b64_json }
        : {}),
    };
  });
  let usage: RelayImageResult["usage"];
  if (value.usage !== undefined) {
    if (!isPlainObject(value.usage)) {
      throw new RelayImageProviderReadbackProtocolError(
        "图片上游回查成功记录的 usage 无效",
      );
    }
    usage = {};
    for (const field of [
      "prompt_tokens",
      "completion_tokens",
      "image_tokens",
      "total_tokens",
    ] as const) {
      if (value.usage[field] === undefined) continue;
      const amount = Number(value.usage[field]);
      if (!Number.isSafeInteger(amount) || amount < 0) {
        throw new RelayImageProviderReadbackProtocolError(
          `图片上游回查成功记录的 ${field} 无效`,
        );
      }
      usage[field] = amount;
    }
  }
  return { created, data, ...(usage ? { usage } : {}) };
}

export function createConfiguredRelayImageProviderReadbackAdapter(input: {
  channel: RelayChannel;
  fetchImpl?: RelayImageProviderReadbackFetch;
  now?: () => number;
}): RelayImageProviderReadbackAdapter {
  const capability = resolveRelayImageProviderReadbackCapability(input.channel);
  if (!capability.readbackSupported) {
    throw new RelayImageProviderReadbackProtocolError(
      `图片供应商通道不具备权威回查能力：${capability.reason}`,
    );
  }
  const apiKey = resolveChannelApiKey(input.channel);
  if (!apiKey) {
    throw new RelayImageProviderReadbackProtocolError(
      "图片上游回查通道缺少凭据",
    );
  }
  const fetchImpl = input.fetchImpl || fetch;
  const now = input.now || Date.now;
  return {
    provider: normalizedProvider(input.channel.provider),
    version: capability.adapterVersion,
    async readByProviderRequestId(readInput) {
      const url = sameOriginReadbackUrl({
        channel: input.channel,
        pathTemplate: capability.pathTemplate,
        providerRequestId: readInput.providerRequestId,
      });
      const headers = {
        ...resolveProviderChannelRequestHeaders(
          normalizedProvider(input.channel.provider),
          apiKey,
          input.channel.config || {},
        ),
        "X-Fanjin-Readback-Contract": capability.adapterVersion,
        "X-Fanjin-Provider-Request-Id": readInput.providerRequestId,
        "X-Fanjin-Request-SHA256": readInput.requestHash,
      };
      const response = await fetchImpl(url, {
        method: "GET",
        headers,
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(
          Math.max(1_000, Math.min(Number(input.channel.timeoutMs) || 30_000, 30_000)),
        ),
      });
      const rawBody = await readBoundedResponseText(response);
      if (!response.ok) {
        throw new Error(`图片上游回查 HTTP ${response.status}`);
      }
      if (
        responseHeader(response, "X-Fanjin-Readback-Contract")
        !== capability.adapterVersion
      ) {
        throw new RelayImageProviderReadbackProtocolError(
          "图片上游回查响应缺少匹配的协议版本",
        );
      }
      let payload: unknown;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        throw new RelayImageProviderReadbackProtocolError(
          "图片上游回查响应不是有效 JSON",
        );
      }
      if (!isPlainObject(payload)) {
        throw new RelayImageProviderReadbackProtocolError(
          "图片上游回查响应结构无效",
        );
      }
      const providerRecordId = requiredString(payload.id, "id");
      const requestId = requiredString(payload.request_id, "request_id");
      const requestHash = requiredString(payload.request_hash, "request_hash", 64);
      const model = requiredString(payload.model, "model", 200);
      const status = requiredString(payload.status, "status", 50);
      if (
        requestId !== readInput.providerRequestId
        || requestHash !== readInput.requestHash
        || model !== readInput.model
        || !/^[a-f0-9]{64}$/.test(requestHash)
      ) {
        throw new RelayImageProviderReadbackProtocolError(
          "图片上游回查记录与原始请求标识、摘要或模型不一致",
        );
      }
      const observedAt = nonNegativeTimestamp(now(), "observedAt");
      const bindingBase = {
        contractVersion: RELAY_IMAGE_PROVIDER_READBACK_PROOF_VERSION,
        provider: normalizedProvider(input.channel.provider),
        providerRequestId: requestId,
        model,
        requestHash,
        adapterVersion: capability.adapterVersion,
        observedAt,
        providerRecordId,
      };
      if (status === "succeeded") {
        const result = readGatewayResult(payload.result);
        return {
          state: "recovered_result",
          result,
          binding: {
            ...bindingBase,
            providerDisposition: "recovered_result",
            resultHash: hashIdempotencyRequest(result),
          },
        };
      }
      if (status === "not_accepted") {
        return {
          state: "definitively_not_accepted",
          reason: "provider_proved_request_not_accepted",
          binding: {
            ...bindingBase,
            providerDisposition: "definitively_not_accepted",
          },
        };
      }
      if (["queued", "running"].includes(status)) {
        return {
          state: "accepted_unknown",
          reason: "provider_request_pending",
          binding: {
            ...bindingBase,
            providerDisposition: "accepted_unknown",
          },
        };
      }
      if (["failed", "cancelled"].includes(status)) {
        return {
          state: "accepted_unknown",
          reason: "provider_request_terminal_without_recoverable_result",
          binding: {
            ...bindingBase,
            providerDisposition: "accepted_unknown",
          },
        };
      }
      throw new RelayImageProviderReadbackProtocolError(
        "图片上游回查响应包含未知状态",
      );
    },
  };
}

interface ProductionSettlementBinding {
  capability: Extract<
    RelayImageProviderReadbackCapability,
    { readbackSupported: true }
  >;
  workspaceId: string;
  reservationId: string;
  usageRecordId: string;
  channelId: string;
  billingKey: string;
  units: number;
  actualCostMicros: number;
}

type ProductionAdapterResolution =
  | {
      kind: "adapter";
      adapter: RelayImageProviderReadbackAdapter;
      settlementBinding: ProductionSettlementBinding | null;
    }
  | { kind: "unsupported"; reason: string }
  | { kind: "accepted_unknown"; reason: string };

function exactNonNegativeSafeInteger(
  value: unknown,
  field: string,
): number {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new RelayImageProviderReadbackProtocolError(
      `图片上游回查的 ${field} 无效`,
    );
  }
  return normalized;
}

function relayBillingKeyFromReservation(value: unknown): string | null {
  const idempotencyKey = String(value || "").trim();
  const suffix = ":reserve";
  if (!idempotencyKey.endsWith(suffix)) return null;
  const billingKey = idempotencyKey.slice(0, -suffix.length);
  return billingKey.startsWith("relay-relay-image:") ? billingKey : null;
}

function channelFromRow(row: Record<string, unknown>): RelayChannel {
  return {
    id: String(row.id || ""),
    name: String(row.name || row.id || ""),
    provider: String(row.provider || "") as RelayChannel["provider"],
    endpointType: String(row.endpointType || "") as RelayChannel["endpointType"],
    baseUrl: row.baseUrl == null ? null : String(row.baseUrl),
    credentialRef: row.credentialRef == null ? null : String(row.credentialRef),
    credentialCiphertext: row.credentialCiphertext == null
      ? null
      : String(row.credentialCiphertext),
    config: parseProviderChannelConfig(row.configJson),
    timeoutMs: Number(row.timeoutMs) || 30_000,
  };
}

async function productionAdapterForProvider(input: {
  provider: string;
  providerRequestId: string;
  model: string;
  requestHash: string;
  expectedCount: number;
  database?: Knex | Knex.Transaction;
  fetchImpl?: RelayImageProviderReadbackFetch;
  now?: () => number;
}): Promise<ProductionAdapterResolution> {
  const database = input.database
    || (await import("@/utils/db")).default;
  try {
    const reservations = await database("o_billing_ledger")
      .where({ type: "freeze", requestId: input.providerRequestId })
      .orderBy("createdAt", "desc")
      .limit(2);
    if (reservations.length === 0) {
      return {
        kind: "accepted_unknown",
        reason: "provider_dispatch_binding_missing",
      };
    }
    if (reservations.length !== 1) {
      return {
        kind: "accepted_unknown",
        reason: "provider_dispatch_binding_ambiguous",
      };
    }
    const reservation = reservations[0] as Record<string, unknown>;
    const metadata = parseJsonObject(reservation.metadata);
    const priceSnapshot = parseJsonObject(metadata.priceSnapshot);
    const usageRecordId = String(
      reservation.relatedUsageId || metadata.usageRecordId || "",
    ).trim();
    const channelId = String(metadata.dispatchChannelId || "").trim();
    const dispatchStartedAt = Number(metadata.dispatchStartedAt);
    const workspaceId = String(reservation.workspaceId || "").trim();
    const reservationId = String(reservation.id || "").trim();
    const reservationAmountMicros = Number(reservation.amountMicros);
    const reservationRemainingMicros = Number(reservation.remainingMicros);
    const reservedCostMicros = Number(metadata.reservedCostMicros);
    const reservedUnits = Number(metadata.reservedUnits);
    const billingKey = relayBillingKeyFromReservation(
      reservation.idempotencyKey,
    );
    if (
      String(metadata.source || "") !== "relay-image"
      || String(metadata.requestHash || "") !== input.requestHash
      || String(metadata.dispatchRequestId || "") !== input.providerRequestId
      || normalizedProvider(metadata.dispatchProvider) !== input.provider
      || !channelId
      || !usageRecordId
      || !workspaceId
      || !reservationId
      || !billingKey
      || !Number.isSafeInteger(dispatchStartedAt)
      || dispatchStartedAt < 0
      || !Number.isSafeInteger(reservationAmountMicros)
      || reservationAmountMicros <= 0
      || reservationRemainingMicros !== reservationAmountMicros
      || !Number.isSafeInteger(reservedCostMicros)
      || reservedCostMicros !== reservationAmountMicros
      || !Number.isSafeInteger(reservedUnits)
      || reservedUnits !== input.expectedCount
      || String(priceSnapshot.unit || "") !== "image"
      || !["dispatch_started", "pending_reconcile"].includes(
        String(metadata.billingLifecycleState || ""),
      )
    ) {
      return {
        kind: "accepted_unknown",
        reason: "provider_dispatch_binding_invalid",
      };
    }
    const usage = await database("o_usage_record")
      .where({ id: usageRecordId })
      .first();
    if (
      !usage
      || String(usage.id || "") !== usageRecordId
      || String(usage.workspaceId || "") !== workspaceId
      || String(usage.endpointType || "") !== "image_generation"
      || normalizedProvider(usage.provider) !== input.provider
      || String(usage.channelId || "") !== channelId
      || String(usage.model || "") !== input.model
      || Number(usage.units) !== input.expectedCount
      || String(usage.unit || "") !== "image"
      || !["reserved", "pending_reconcile"].includes(String(usage.status || ""))
      || (
        String(usage.status || "") === "reserved"
        && Number(usage.costMicros) !== reservationAmountMicros
      )
      || (
        String(usage.status || "") === "pending_reconcile"
        && Number(usage.costMicros) !== 0
      )
    ) {
      return {
        kind: "accepted_unknown",
        reason: "provider_usage_binding_invalid",
      };
    }
    const row = await database("o_provider_channel")
      .where({ id: channelId })
      .first();
    if (
      !row
      || normalizedProvider(row.provider) !== input.provider
      || String(row.endpointType || "") !== "image_generation"
    ) {
      return {
        kind: "accepted_unknown",
        reason: "provider_channel_binding_invalid",
      };
    }
    const channel = channelFromRow(row as Record<string, unknown>);
    const capability = resolveRelayImageProviderReadbackCapability(channel);
    if (!capability.readbackSupported) {
      return { kind: "unsupported", reason: capability.reason };
    }
    try {
      return {
        kind: "adapter",
        adapter: createConfiguredRelayImageProviderReadbackAdapter({
          channel,
          fetchImpl: input.fetchImpl,
          now: input.now,
        }),
        settlementBinding:
          capability.policy === "authoritative_required"
          && capability.readiness === "ready"
            ? {
                capability,
                workspaceId,
                reservationId,
                usageRecordId,
                channelId,
                billingKey,
                units: input.expectedCount,
                actualCostMicros: reservationAmountMicros,
              }
            : null,
      };
    } catch {
      // Credentials may be rotated or temporarily unavailable after the POST.
      // That never proves non-acceptance and must leave the freeze pending.
      return {
        kind: "accepted_unknown",
        reason: "provider_readback_adapter_unavailable",
      };
    }
  } catch (error) {
    if (error instanceof RelayImageProviderReadbackProtocolError) throw error;
    return {
      kind: "accepted_unknown",
      reason: "provider_dispatch_binding_read_failed",
    };
  }
}

function unsupportedOutcome(
  base: RelayImageProviderReadbackBase,
  reason: string,
): RelayImageProviderReadbackOutcome {
  return {
    ...base,
    state: "unsupported",
    reason,
    adapterVersion: null,
    binding: null,
    result: null,
    settlementAuthorization: null,
    mayMaterializeAssets: false,
    maySettleBilling: false,
  };
}

function acceptedUnknownOutcome(
  base: RelayImageProviderReadbackBase,
  reason: string,
  adapterVersion: string | null = null,
): RelayImageProviderReadbackOutcome {
  return {
    ...base,
    state: "accepted_unknown",
    reason,
    adapterVersion,
    binding: null,
    result: null,
    settlementAuthorization: null,
    mayMaterializeAssets: false,
    maySettleBilling: false,
  };
}

export async function readRelayImageProviderResult(input: {
  provider: string;
  providerRequestId: string;
  request: RelayImageRequest;
  expectedCount: number;
  checkedAt?: number;
  /** Deterministic adapter injection for unit tests and provider packages. */
  adapter?: RelayImageProviderReadbackAdapter | null;
  production?: {
    database?: Knex | Knex.Transaction;
    fetchImpl?: RelayImageProviderReadbackFetch;
    now?: () => number;
  };
}): Promise<RelayImageProviderReadbackOutcome> {
  const provider = requiredString(input.provider, "provider", 100);
  const providerRequestId = requiredString(
    input.providerRequestId,
    "providerRequestId",
  );
  const model = requiredString(input.request.model, "model", 200);
  const expectedCount = Number(input.expectedCount);
  if (
    !Number.isSafeInteger(expectedCount)
    || expectedCount < 1
    || expectedCount > 10
  ) {
    throw new RelayImageProviderReadbackProtocolError(
      "图片上游回查的期望结果数量无效",
    );
  }
  const checkedAt = nonNegativeTimestamp(
    input.checkedAt ?? Date.now(),
    "checkedAt",
  );
  const requestHash = relayImageProviderRequestHash(input.request);
  const base: RelayImageProviderReadbackBase = {
    contractVersion: RELAY_IMAGE_PROVIDER_READBACK_CONTRACT_VERSION,
    provider,
    providerRequestId,
    model,
    requestHash,
    checkedAt,
    automaticRedispatchAllowed: false,
    automaticReleaseAllowed: false,
  };

  let adapter: RelayImageProviderReadbackAdapter | null;
  let settlementBinding: ProductionSettlementBinding | null = null;
  if (input.adapter !== undefined) {
    adapter = input.adapter;
  } else {
    const resolution = await productionAdapterForProvider({
      provider,
      providerRequestId,
      model,
      requestHash,
      expectedCount,
      database: input.production?.database,
      fetchImpl: input.production?.fetchImpl,
      now: input.production?.now,
    });
    if (resolution.kind === "unsupported") {
      return unsupportedOutcome(base, resolution.reason);
    }
    if (resolution.kind === "accepted_unknown") {
      return acceptedUnknownOutcome(base, resolution.reason);
    }
    adapter = resolution.adapter;
    settlementBinding = resolution.settlementBinding;
  }

  if (!adapter) {
    return unsupportedOutcome(base, "provider_readback_adapter_missing");
  }
  const adapterProvider = requiredString(adapter.provider, "adapter.provider", 100);
  const adapterVersion = requiredString(adapter.version, "adapter.version", 100);
  if (adapterProvider !== provider) {
    throw new RelayImageProviderReadbackProtocolError(
      "图片上游回查适配器与供应商不匹配",
    );
  }

  let outcome: RelayImageProviderAdapterOutcome;
  try {
    outcome = await adapter.readByProviderRequestId({
      providerRequestId,
      model,
      requestHash,
      expectedCount,
    });
  } catch (error) {
    if (error instanceof RelayImageProviderReadbackProtocolError) throw error;
    return acceptedUnknownOutcome(
      base,
      "provider_readback_failed",
      adapterVersion,
    );
  }

  const binding = validateBinding({
    binding: outcome.binding,
    provider,
    providerRequestId,
    model,
    requestHash,
    adapterVersion,
    expectedState: outcome.state,
  });
  if (outcome.state === "accepted_unknown") {
    return {
      ...base,
      state: outcome.state,
      reason: requiredString(outcome.reason, "reason", 500),
      adapterVersion,
      binding,
      result: null,
      settlementAuthorization: null,
      mayMaterializeAssets: false,
      maySettleBilling: false,
    };
  }
  if (outcome.state === "definitively_not_accepted") {
    return {
      ...base,
      state: outcome.state,
      reason: requiredString(outcome.reason, "reason", 500),
      adapterVersion,
      binding,
      result: null,
      settlementAuthorization: null,
      mayMaterializeAssets: false,
      maySettleBilling: false,
    };
  }
  if (outcome.state !== "recovered_result") {
    throw new RelayImageProviderReadbackProtocolError(
      "图片上游回查适配器返回了未知状态",
    );
  }
  const result = validateRecoveredResult(outcome.result, expectedCount);
  const recoveredBinding = binding as RelayImageProviderRecoveredResultBinding;
  const resultHash = requiredString(
    recoveredBinding.resultHash,
    "binding.resultHash",
    64,
  );
  if (
    !/^[a-f0-9]{64}$/.test(resultHash)
    || resultHash !== hashIdempotencyRequest(result)
  ) {
    throw new RelayImageProviderReadbackProtocolError(
      "图片上游回查结果与绑定证明不一致",
    );
  }
  const settlementAuthorization = settlementBinding
    ? {
        contractVersion:
          RELAY_IMAGE_PROVIDER_READBACK_SETTLEMENT_AUTHORIZATION_VERSION,
        policy: "authoritative_required" as const,
        readiness: "ready" as const,
        workspaceId: settlementBinding.workspaceId,
        reservationId: settlementBinding.reservationId,
        usageRecordId: settlementBinding.usageRecordId,
        provider,
        channelId: settlementBinding.channelId,
        providerRequestId,
        model,
        requestHash,
        resultHash,
        adapterVersion,
        billingKey: settlementBinding.billingKey,
        units: settlementBinding.units,
        unit: "image" as const,
        actualCostMicros: settlementBinding.actualCostMicros,
      }
    : null;
  const recoveredBase = {
    ...base,
    state: outcome.state,
    reason: null,
    adapterVersion,
    binding: recoveredBinding,
    result,
  } as const;
  return settlementAuthorization
    ? {
        ...recoveredBase,
        settlementAuthorization,
        mayMaterializeAssets: true,
        maySettleBilling: true,
      }
    : {
        ...recoveredBase,
        settlementAuthorization: null,
        mayMaterializeAssets: false,
        maySettleBilling: false,
      };
}

export type RelayImageProviderReadbackSettlement = (
  input: ApiTaskReservationSettlementInput,
) => Promise<ApiTaskReservationSettlementResult>;

/**
 * Settle an authoritatively recovered synchronous image result using the same
 * atomic billing primitive as the ordinary success path. The authorization is
 * minted only by the production ledger -> usage -> channel resolver above;
 * injected/test adapters and manual-reconcile routes can never reach this
 * function with billing authority.
 */
export async function settleRecoveredRelayImageProviderResult(
  outcome: RelayImageProviderReadbackOutcome,
  options: {
    settleImpl?: RelayImageProviderReadbackSettlement;
  } = {},
): Promise<RelayImageProviderReadbackSettlementProof> {
  if (
    outcome.state !== "recovered_result"
    || !outcome.settlementAuthorization
    || !outcome.mayMaterializeAssets
    || !outcome.maySettleBilling
  ) {
    throw new RelayImageProviderReadbackProtocolError(
      "图片上游恢复结果不具备权威计费授权",
    );
  }
  const authorization = outcome.settlementAuthorization;
  const resultHash = hashIdempotencyRequest(outcome.result);
  if (
    authorization.contractVersion
      !== RELAY_IMAGE_PROVIDER_READBACK_SETTLEMENT_AUTHORIZATION_VERSION
    || authorization.policy !== "authoritative_required"
    || authorization.readiness !== "ready"
    || authorization.provider !== outcome.provider
    || authorization.providerRequestId !== outcome.providerRequestId
    || authorization.model !== outcome.model
    || authorization.requestHash !== outcome.requestHash
    || authorization.resultHash !== resultHash
    || authorization.resultHash !== outcome.binding.resultHash
    || authorization.adapterVersion !== outcome.adapterVersion
    || authorization.adapterVersion !== outcome.binding.adapterVersion
    || !authorization.workspaceId
    || !authorization.reservationId
    || !authorization.usageRecordId
    || !authorization.channelId
    || !authorization.billingKey.startsWith("relay-relay-image:")
    || exactNonNegativeSafeInteger(authorization.units, "units") < 1
    || authorization.units !== outcome.result.data.length
    || authorization.unit !== "image"
    || exactNonNegativeSafeInteger(
      authorization.actualCostMicros,
      "actualCostMicros",
    ) < 1
  ) {
    throw new RelayImageProviderReadbackProtocolError(
      "图片上游恢复结果与计费授权不一致",
    );
  }

  const settleImpl = options.settleImpl || settleApiTaskReservation;
  const settled = await settleImpl({
    workspaceId: authorization.workspaceId,
    reservationId: authorization.reservationId,
    actualCostMicros: authorization.actualCostMicros,
    units: authorization.units,
    unit: authorization.unit,
    provider: authorization.provider,
    channelId: authorization.channelId,
    requestId: authorization.providerRequestId,
    idempotencyKey: authorization.billingKey,
    description: `relay-image recovered: ${authorization.model}`,
    metadata: {
      source: "relay-image",
      requestHash: authorization.requestHash,
      providerReadbackContractVersion: outcome.contractVersion,
      providerReadbackAdapterVersion: authorization.adapterVersion,
      providerReadbackResultHash: authorization.resultHash,
      providerReadbackRecordId: outcome.binding.providerRecordId,
    },
  });
  const usage = settled.usage;
  const reservation = settled.reservation;
  const capture = settled.captureLedger;
  if (
    usage.id !== authorization.usageRecordId
    || usage.workspaceId !== authorization.workspaceId
    || usage.provider !== authorization.provider
    || usage.channelId !== authorization.channelId
    || usage.model !== authorization.model
    || usage.endpointType !== "image_generation"
    || usage.units !== authorization.units
    || usage.unit !== authorization.unit
    || usage.costMicros !== authorization.actualCostMicros
    || usage.status !== "charged"
    || reservation.id !== authorization.reservationId
    || reservation.workspaceId !== authorization.workspaceId
    || reservation.type !== "freeze"
    || reservation.requestId !== authorization.providerRequestId
    || reservation.remainingMicros !== 0
    || String(reservation.metadata.requestHash || "")
      !== authorization.requestHash
    || !capture
    || capture.type !== "deduct"
    || capture.workspaceId !== authorization.workspaceId
    || capture.relatedLedgerId !== authorization.reservationId
    || capture.usageRecordId !== authorization.usageRecordId
    || capture.requestId !== authorization.providerRequestId
    || capture.idempotencyKey !== `${authorization.billingKey}:capture`
    || capture.amountMicros !== authorization.actualCostMicros
  ) {
    throw new RelayImageProviderReadbackProtocolError(
      "图片上游恢复结果的计费结算证明不完整",
    );
  }
  return {
    contractVersion: RELAY_IMAGE_PROVIDER_READBACK_SETTLEMENT_PROOF_VERSION,
    authorizationContractVersion: authorization.contractVersion,
    workspaceId: authorization.workspaceId,
    reservationId: authorization.reservationId,
    usageRecordId: authorization.usageRecordId,
    provider: authorization.provider,
    channelId: authorization.channelId,
    providerRequestId: authorization.providerRequestId,
    model: authorization.model,
    requestHash: authorization.requestHash,
    resultHash: authorization.resultHash,
    billingKey: authorization.billingKey,
    units: authorization.units,
    unit: authorization.unit,
    actualCostMicros: authorization.actualCostMicros,
    captureLedgerId: capture.id,
    idempotent: settled.idempotent,
  };
}
