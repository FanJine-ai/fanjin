import { isNativeResponsesChannel } from "@/lib/responsesTransport";
import type { RelayChannel } from "@/lib/sharedTypes";
import { joinProviderApiPath } from "@/lib/channelRouter";
import { resolveChannelApiKey, resolveChannelBaseUrl } from "@/lib/relayChannelCredential";
import { parseProviderChannelConfig } from "@/lib/providerChannelSecrets";
import { RESPONSES_RESOURCE_BINDING_TABLE } from "@/lib/migrations/responsesResourceBinding";
import { db } from "@/utils/db";
import { redactSensitiveText } from "@/lib/redactSensitiveText";

export interface ResponsesResourceOwner {
  workspaceId: string;
  apiKeyId: string | null;
  principalId?: string | null;
}

export interface StoredResponsesRequestContext extends ResponsesResourceOwner {
  requestId?: string | null;
  idempotencyKey?: string | null;
}

export class ResponsesResourceError extends Error {
  statusCode: number;
  code: string;

  constructor(message: string, statusCode: number, code = "responses_resource_error") {
    super(
      redactSensitiveText(message)
        .replace(/https?:\/\/[^\s'"<>]+/gi, "[REDACTED_URL]")
        .slice(0, 2_000) || "Responses resource request failed",
    );
    this.name = "ResponsesResourceError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export interface StoredResponsesProxyResult {
  statusCode: number;
  body: unknown;
  contentType: string;
}

function table() {
  return (db as any)(RESPONSES_RESOURCE_BINDING_TABLE);
}

function normalizedPrincipalId(value: unknown): string | null {
  const principalId = String(value || "").trim();
  return principalId || null;
}

function normalizedChannelBaseUrl(channel: Pick<RelayChannel, "baseUrl" | "config">): string {
  return resolveChannelBaseUrl(channel).replace(/\/+$/, "");
}

function normalizedCredentialRef(channel: Pick<RelayChannel, "credentialRef" | "config">): string {
  return String(channel.credentialRef || (channel.config as any)?.credentialRef || "").trim();
}

function assertOwner(owner: ResponsesResourceOwner): void {
  if (!String(owner.workspaceId || "").trim()) {
    throw new ResponsesResourceError("缺少工作区上下文", 403, "authentication_error");
  }
  if (!String(owner.apiKeyId || "").trim() && !normalizedPrincipalId(owner.principalId)) {
    throw new ResponsesResourceError("缺少可验证的调用主体", 403, "authentication_error");
  }
}

function applyOwnerScope(query: any, owner: ResponsesResourceOwner): any {
  query.where({ workspaceId: owner.workspaceId }).whereNull("deletedAt");
  if (owner.apiKeyId) {
    query.andWhere({ apiKeyId: owner.apiKeyId }).whereNull("principalId");
  } else {
    query.whereNull("apiKeyId").andWhere({ principalId: normalizedPrincipalId(owner.principalId) });
  }
  return query;
}

function readExpiresAt(response: any): number | null {
  const raw = Number(response?.expire_at ?? response?.expires_at);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  // Ark timestamps are normally seconds; preserve millisecond values if one is returned.
  return raw < 10_000_000_000 ? Math.floor(raw * 1000) : Math.floor(raw);
}

export async function persistNativeResponseBinding(input: {
  response: any;
  owner: ResponsesResourceOwner;
  channel: RelayChannel;
  model: string;
  upstreamModel: string;
}): Promise<void> {
  const responseId = String(input.response?.id || "").trim();
  if (!responseId) return;
  assertOwner(input.owner);
  if (!isNativeResponsesChannel(input.channel)) {
    throw new ResponsesResourceError("仅原生 Responses 通道允许持久化绑定", 500);
  }
  const baseUrl = normalizedChannelBaseUrl(input.channel);
  if (!baseUrl) {
    throw new ResponsesResourceError("原生 Responses 通道缺少 baseUrl", 500);
  }
  const credentialRef = normalizedCredentialRef(input.channel);

  const now = Date.now();
  await table()
    .insert({
      responseId,
      workspaceId: input.owner.workspaceId,
      apiKeyId: input.owner.apiKeyId,
      principalId: input.owner.apiKeyId ? null : normalizedPrincipalId(input.owner.principalId),
      provider: input.channel.provider,
      channelId: input.channel.id,
      baseUrl,
      credentialRef,
      model: input.model,
      upstreamModel: input.upstreamModel,
      expiresAt: readExpiresAt(input.response),
      deletedAt: null,
      createTime: now,
      updateTime: now,
    })
    .onConflict("responseId")
    .ignore();

  const existing = await table().where({ responseId }).first();
  const sameOwner = existing
    && String(existing.workspaceId) === input.owner.workspaceId
    && String(existing.apiKeyId || "") === String(input.owner.apiKeyId || "")
    && String(existing.principalId || "") === String(input.owner.apiKeyId ? "" : normalizedPrincipalId(input.owner.principalId) || "")
    && String(existing.channelId) === input.channel.id
    && String(existing.baseUrl || "") === baseUrl
    && String(existing.credentialRef || "") === credentialRef
    && String(existing.provider) === input.channel.provider;
  if (!sameOwner) {
    throw new ResponsesResourceError("上游 Response ID 与现有租户绑定冲突", 409, "response_binding_conflict");
  }
}

async function findOwnedBinding(responseId: string, owner: ResponsesResourceOwner): Promise<any> {
  assertOwner(owner);
  if (responseId.startsWith("file:")) {
    throw new ResponsesResourceError("Response 不存在", 404, "response_not_found");
  }
  const binding = await applyOwnerScope(
    table().where({ responseId }).whereNot({ model: "file:user_data" }),
    owner,
  ).first();
  if (!binding) {
    // Do not distinguish an unknown ID from another tenant's ID.
    throw new ResponsesResourceError("Response 不存在", 404, "response_not_found");
  }
  const expiresAt = Number(binding.expiresAt || 0);
  if (expiresAt > 0 && expiresAt <= Date.now()) {
    throw new ResponsesResourceError("Response 不存在", 404, "response_not_found");
  }
  return binding;
}

function assertBindingMatchesChannel(binding: any, channel: RelayChannel): void {
  const matches = isNativeResponsesChannel(channel)
    && String(binding.provider || "") === channel.provider
    && String(binding.channelId || "") === String(channel.id || "")
    && String(binding.baseUrl || "") === normalizedChannelBaseUrl(channel)
    && String(binding.credentialRef || "") === normalizedCredentialRef(channel);
  if (!matches) {
    throw new ResponsesResourceError(
      "previous_response_id 与当前原生 Responses 通道不匹配",
      422,
      "response_channel_mismatch",
    );
  }
}

export async function assertOwnedNativeResponseReference(input: {
  responseId: unknown;
  owner: ResponsesResourceOwner;
  channel: RelayChannel;
}): Promise<void> {
  const responseId = String(input.responseId || "").trim();
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(responseId)) {
    throw new ResponsesResourceError("previous_response_id 格式无效", 400, "invalid_request_error");
  }
  const binding = await findOwnedBinding(responseId, input.owner);
  assertBindingMatchesChannel(binding, input.channel);
}

async function loadBoundNativeChannel(binding: any): Promise<RelayChannel> {
  if (!["volcano", "openai"].includes(String(binding.provider || ""))) {
    throw new ResponsesResourceError("Response 通道类型不可用", 503, "response_channel_unavailable");
  }
  const row = await (db as any)("o_provider_channel")
    .where({
      id: binding.channelId,
      provider: binding.provider,
      endpointType: "text",
      disabled: 0,
    })
    .first();
  if (!row) throw new ResponsesResourceError("原始 Responses 通道不可用", 503, "response_channel_unavailable");

  const scope = String(row.scope || "").trim();
  const channelWorkspaceId = String(row.workspaceId || "").trim();
  const bindingWorkspaceId = String(binding.workspaceId || "").trim();
  const scopeMatches = scope === "platform"
    ? !channelWorkspaceId
    : scope === "workspace" && channelWorkspaceId === bindingWorkspaceId;
  if (!scopeMatches) {
    throw new ResponsesResourceError("原始 Responses 通道租户范围已变化", 503, "response_channel_unavailable");
  }

  const channel = {
    ...row,
    id: String(row.id),
    name: String(row.name || row.id),
    provider: binding.provider,
    endpointType: "text",
    baseUrl: row.baseUrl || null,
    credentialRef: row.credentialRef || null,
    credentialCiphertext: row.credentialCiphertext || null,
    config: parseProviderChannelConfig(row.configJson),
    timeoutMs: Number(row.timeoutMs) || 60_000,
  } as RelayChannel;
  if (!isNativeResponsesChannel(channel)) throw new ResponsesResourceError("原始通道不再支持原生 Responses", 503, "response_channel_unavailable");
  const identityMatches = String(binding.baseUrl || "") === normalizedChannelBaseUrl(channel)
    && String(binding.credentialRef || "") === normalizedCredentialRef(channel);
  if (!identityMatches) {
    throw new ResponsesResourceError(
      "原始 Responses 通道地址或凭据引用已变化",
      503,
      "response_channel_unavailable",
    );
  }
  return channel;
}

function appendQueryValue(params: URLSearchParams, key: string, value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) appendQueryValue(params, key, item);
    return;
  }
  if (typeof value === "string" && value.trim()) params.append(key, value.trim());
}

function buildInputItemsQuery(query: Record<string, unknown> | undefined): string {
  const params = new URLSearchParams();
  for (const key of ["after", "before"]) {
    appendQueryValue(params, key, query?.[key]);
  }
  appendQueryValue(params, "include[]", query?.["include[]"]);
  appendQueryValue(params, "include[]", query?.include);
  for (const key of ["limit", "order"]) appendQueryValue(params, key, query?.[key]);
  const value = params.toString();
  return value ? `?${value}` : "";
}

function upstreamMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const candidate = (body as any)?.error?.message || (body as any)?.message;
    if (candidate) return String(candidate);
  }
  if (typeof body === "string" && body.trim()) return body.slice(0, 2_000);
  return fallback;
}

export async function proxyStoredNativeResponse(input: {
  responseId: string;
  action: "retrieve" | "delete" | "input_items";
  owner: StoredResponsesRequestContext;
  query?: Record<string, unknown>;
}): Promise<StoredResponsesProxyResult> {
  const responseId = String(input.responseId || "").trim();
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(responseId)) {
    throw new ResponsesResourceError("Response ID 格式无效", 400, "invalid_request_error");
  }
  const binding = await findOwnedBinding(responseId, input.owner);
  const channel = await loadBoundNativeChannel(binding);
  const apiKey = resolveChannelApiKey(channel, channel.provider === "volcano" ? ["VOLCANO_ARK_API_KEY"] : []);
  const baseUrl = resolveChannelBaseUrl(channel);
  if (!apiKey) throw new ResponsesResourceError("供应商通道未配置 apiKey", 503, "response_channel_unavailable");
  if (!baseUrl) throw new ResponsesResourceError("供应商通道未配置 baseUrl", 503, "response_channel_unavailable");

  const suffix = input.action === "input_items" ? "/input_items" : "";
  const query = input.action === "input_items" ? buildInputItemsQuery(input.query) : "";
  const url = `${joinProviderApiPath(baseUrl, `v1/responses/${encodeURIComponent(responseId)}${suffix}`)}${query}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
  };
  const requestId = String(input.owner.requestId || "").trim();
  const idempotencyKey = String(input.owner.idempotencyKey || "").trim();
  if (requestId) headers["X-Request-Id"] = requestId;
  if (input.action === "delete" && idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

  let response: Response;
  try {
    response = await fetch(url, {
      method: input.action === "delete" ? "DELETE" : "GET",
      headers,
      signal: AbortSignal.timeout(channel.timeoutMs || 120_000),
    });
  } catch (error: any) {
    throw new ResponsesResourceError(error?.message || "原生 Responses 请求失败", 502, "upstream_error");
  }

  const rawBody = await response.text();
  let body: unknown = null;
  if (rawBody) {
    try {
      body = JSON.parse(rawBody);
    } catch {
      body = rawBody;
    }
  }
  if (!response.ok) {
    throw new ResponsesResourceError(
      upstreamMessage(body, "原生 Responses 请求失败"),
      response.status,
      "upstream_error",
    );
  }

  if (input.action === "delete") {
    try {
      await applyOwnerScope(table().where({ responseId }), input.owner).update({
        deletedAt: Date.now(),
        updateTime: Date.now(),
      });
    } catch (error: any) {
      // The upstream resource is already deleted. A local tombstone is only an
      // access-optimization hint and must not turn that success into a retry.
      console.error(
        "[responsesResourceBinding] 本地 Response tombstone 保存失败",
        redactSensitiveText(error?.message || error),
      );
    }
  }
  return {
    statusCode: response.status,
    body,
    contentType: response.headers.get("content-type") || "application/json",
  };
}

// Keep existing Ark callers compatible while both providers share ownership checks.
export const persistVolcanoResponseBinding = persistNativeResponseBinding;
export const assertOwnedVolcanoResponseReference = assertOwnedNativeResponseReference;
export const proxyStoredVolcanoResponse = proxyStoredNativeResponse;
