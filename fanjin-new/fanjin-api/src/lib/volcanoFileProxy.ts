import { createReadStream } from "node:fs";
import axios from "axios";
import FormData from "form-data";
import type { RelayChannel } from "@/lib/sharedTypes";
import { joinProviderApiPath, selectChannelCandidates } from "@/lib/channelRouter";
import { resolveChannelApiKey, resolveChannelBaseUrl } from "@/lib/relayChannelCredential";
import { parseProviderChannelConfig } from "@/lib/providerChannelSecrets";
import { RESPONSES_RESOURCE_BINDING_TABLE } from "@/lib/migrations/responsesResourceBinding";
import { volcengineModelsByEndpoint } from "@/lib/volcengineModelManifest";
import { redactSensitiveText } from "@/lib/redactSensitiveText";
import { db } from "@/utils/db";

export const MAX_VOLCANO_FILE_BYTES = 512 * 1024 * 1024;
const FILE_BINDING_PREFIX = "file:";

export interface VolcanoFileOwner {
  workspaceId: string;
  apiKeyId: string | null;
  principalId?: string | null;
}

export interface VolcanoFileUploadInput {
  owner: VolcanoFileOwner;
  purpose: "user_data";
  file?: {
    filepath: string;
    originalFilename: string;
    mimetype?: string | null;
    size: number;
  };
  url?: string;
  passthroughFields?: Record<string, string>;
  requestId?: string | null;
  idempotencyKey?: string | null;
}

export class VolcanoFileError extends Error {
  statusCode: number;
  code: string;

  constructor(message: unknown, statusCode: number, code = "file_api_error") {
    super(
      redactSensitiveText(message)
        .replace(/https?:\/\/[^\s'"<>]+/gi, "[REDACTED_URL]")
        .slice(0, 2_000) || "File API request failed",
    );
    this.name = "VolcanoFileError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

function table() {
  return (db as any)(RESPONSES_RESOURCE_BINDING_TABLE);
}

function bindingKey(fileId: string): string {
  return `${FILE_BINDING_PREFIX}${fileId}`;
}

function principalId(owner: VolcanoFileOwner): string | null {
  const value = String(owner.principalId || "").trim();
  return value || null;
}

function assertOwner(owner: VolcanoFileOwner): void {
  if (!String(owner.workspaceId || "").trim()) {
    throw new VolcanoFileError("缺少工作区上下文", 403, "authentication_error");
  }
  if (!String(owner.apiKeyId || "").trim() && !principalId(owner)) {
    throw new VolcanoFileError("缺少可验证的调用主体", 403, "authentication_error");
  }
}

function applyOwnerScope(query: any, owner: VolcanoFileOwner): any {
  query.where({ workspaceId: owner.workspaceId }).whereNull("deletedAt");
  if (owner.apiKeyId) query.andWhere({ apiKeyId: owner.apiKeyId }).whereNull("principalId");
  else query.whereNull("apiKeyId").andWhere({ principalId: principalId(owner) });
  return query;
}

function normalizedBaseUrl(channel: RelayChannel): string {
  return resolveChannelBaseUrl(channel).replace(/\/+$/, "");
}

function normalizedCredentialRef(channel: RelayChannel): string {
  return String(channel.credentialRef || (channel.config as any)?.credentialRef || "").trim();
}

function readExpiresAt(payload: any): number | null {
  const raw = Number(payload?.expire_at ?? payload?.expires_at);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  return raw < 10_000_000_000 ? Math.floor(raw * 1000) : Math.floor(raw);
}

function upstreamMessage(error: any): string {
  return String(error?.response?.data?.error?.message || error?.response?.data?.message || error?.message || "Volcano File API 请求失败");
}

async function selectVolcanoFileChannel(workspaceId: string): Promise<RelayChannel> {
  const preferred = String(process.env.FANJIN_VOLCANO_FILE_MODEL || "doubao-seed-2-0-pro-260215").trim();
  const routes = await (db as any)("o_model_route")
    .where({ endpointType: "text", provider: "volcano", disabled: 0 })
    .where((query: any) => query
      .where({ scope: "workspace", workspaceId })
      .orWhere((platform: any) => platform.where({ scope: "platform" }).whereNull("workspaceId")))
    .orderByRaw("CASE WHEN ?? = 'workspace' THEN 0 ELSE 1 END", ["scope"])
    .orderBy("priority", "asc")
    .select("model");
  const models = [
    preferred,
    ...routes.map((route: any) => String(route.model || "")),
    ...volcengineModelsByEndpoint("text").map((entry) => entry.model),
  ].filter((model, index, all) => model && all.indexOf(model) === index);
  for (const model of models) {
    const candidates = await selectChannelCandidates({
      endpointType: "text",
      model,
      provider: "volcano",
      workspaceId,
      ignoreCapacity: true,
    });
    if (candidates[0]) return candidates[0];
  }
  throw new VolcanoFileError("没有可用的 Volcano 文本通道来承载 File API", 503, "file_channel_unavailable");
}

async function persistBinding(payload: any, input: VolcanoFileUploadInput, channel: RelayChannel): Promise<void> {
  const fileId = String(payload?.id || "").trim();
  if (!fileId) throw new VolcanoFileError("File API 上游未返回文件 ID", 502, "invalid_upstream_response");
  const now = Date.now();
  await table().insert({
    responseId: bindingKey(fileId),
    workspaceId: input.owner.workspaceId,
    apiKeyId: input.owner.apiKeyId,
    principalId: input.owner.apiKeyId ? null : principalId(input.owner),
    provider: "volcano",
    channelId: channel.id,
    baseUrl: normalizedBaseUrl(channel),
    credentialRef: normalizedCredentialRef(channel),
    model: "file:user_data",
    upstreamModel: JSON.stringify({ fileId, payload }),
    expiresAt: readExpiresAt(payload),
    deletedAt: null,
    createTime: now,
    updateTime: now,
  }).onConflict("responseId").ignore();

  const existing = await table().where({ responseId: bindingKey(fileId) }).first();
  const sameOwner = existing
    && String(existing.workspaceId) === input.owner.workspaceId
    && String(existing.apiKeyId || "") === String(input.owner.apiKeyId || "")
    && String(existing.principalId || "") === String(input.owner.apiKeyId ? "" : principalId(input.owner) || "")
    && String(existing.channelId) === String(channel.id)
    && String(existing.baseUrl) === normalizedBaseUrl(channel)
    && String(existing.credentialRef || "") === normalizedCredentialRef(channel);
  if (!sameOwner) throw new VolcanoFileError("上游文件 ID 与现有租户绑定冲突", 409, "file_binding_conflict");
}

export async function uploadVolcanoFile(input: VolcanoFileUploadInput): Promise<any> {
  assertOwner(input.owner);
  if (Boolean(input.file) === Boolean(input.url)) {
    throw new VolcanoFileError("必须且只能提供 file 或 url 之一", 400, "invalid_request_error");
  }
  if (input.file && (input.file.size < 1 || input.file.size > MAX_VOLCANO_FILE_BYTES)) {
    throw new VolcanoFileError("文件大小必须在 1B 到 512MB 之间", 413, "invalid_request_error");
  }

  const channel = await selectVolcanoFileChannel(input.owner.workspaceId);
  const apiKey = resolveChannelApiKey(channel, ["VOLCANO_ARK_API_KEY"]);
  const baseUrl = resolveChannelBaseUrl(channel);
  if (!apiKey || !baseUrl) throw new VolcanoFileError("Volcano File API 通道配置不完整", 503, "file_channel_unavailable");

  const form = new FormData();
  form.append("purpose", "user_data");
  if (input.file) {
    form.append("file", createReadStream(input.file.filepath), {
      filename: input.file.originalFilename,
      contentType: input.file.mimetype || "application/octet-stream",
      knownLength: input.file.size,
    });
  } else {
    form.append("url", input.url!);
  }
  for (const [key, value] of Object.entries(input.passthroughFields || {})) form.append(key, value);

  let payload: any;
  try {
    const response = await axios.post(joinProviderApiPath(baseUrl, "files"), form, {
      headers: {
        ...form.getHeaders(),
        Authorization: `Bearer ${apiKey}`,
        ...(input.requestId ? { "X-Request-Id": input.requestId } : {}),
        ...(input.idempotencyKey ? { "Idempotency-Key": input.idempotencyKey } : {}),
      },
      maxBodyLength: MAX_VOLCANO_FILE_BYTES + 1024 * 1024,
      timeout: Math.max(Number(channel.timeoutMs) || 0, 600_000),
    });
    payload = response.data;
  } catch (error: any) {
    throw new VolcanoFileError(upstreamMessage(error), Number(error?.response?.status) || 502, "upstream_error");
  }
  try {
    await persistBinding(payload, input, channel);
  } catch (error) {
    const fileId = String(payload?.id || "").trim();
    if (fileId) {
      try {
        await axios.delete(joinProviderApiPath(baseUrl, `files/${encodeURIComponent(fileId)}`), {
          headers: { Authorization: `Bearer ${apiKey}` },
          timeout: Number(channel.timeoutMs) || 120_000,
        });
      } catch { /* best-effort orphan cleanup */ }
    }
    throw error;
  }
  return payload;
}

async function findOwnedBinding(fileId: string, owner: VolcanoFileOwner): Promise<any> {
  assertOwner(owner);
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(fileId)) {
    throw new VolcanoFileError("File ID 格式无效", 400, "invalid_request_error");
  }
  const binding = await applyOwnerScope(table().where({ responseId: bindingKey(fileId), model: "file:user_data" }), owner).first();
  if (!binding || (Number(binding.expiresAt || 0) > 0 && Number(binding.expiresAt) <= Date.now())) {
    throw new VolcanoFileError("File 不存在", 404, "file_not_found");
  }
  return binding;
}

export async function assertOwnedVolcanoFilesInResponsesInput(
  input: unknown,
  owner: VolcanoFileOwner,
  channel: RelayChannel,
): Promise<void> {
  const fileIds = new Set<string>();
  const pending: unknown[] = [input];
  const seen = new Set<object>();
  let visited = 0;
  while (pending.length && visited < 10_000) {
    const current = pending.pop();
    if (!current || typeof current !== "object") continue;
    if (seen.has(current)) continue;
    seen.add(current);
    visited += 1;
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    const record = current as Record<string, unknown>;
    if (typeof record.file_id === "string" && record.file_id.trim()) fileIds.add(record.file_id.trim());
    pending.push(...Object.values(record));
  }
  if (visited >= 10_000 && pending.length) {
    throw new VolcanoFileError("Responses 输入结构过大", 400, "invalid_request_error");
  }
  for (const fileId of fileIds) {
    const binding = await findOwnedBinding(fileId, owner);
    const matches = String(binding.channelId) === String(channel.id)
      && String(binding.baseUrl) === normalizedBaseUrl(channel)
      && String(binding.credentialRef || "") === normalizedCredentialRef(channel);
    if (!matches) throw new VolcanoFileError("file_id 与当前 Volcano 通道不匹配", 422, "file_channel_mismatch");
  }
}

async function loadBoundChannel(binding: any): Promise<RelayChannel> {
  const row = await (db as any)("o_provider_channel").where({
    id: binding.channelId,
    provider: "volcano",
    endpointType: "text",
    disabled: 0,
  }).first();
  if (!row) throw new VolcanoFileError("原始 Volcano 通道不可用", 503, "file_channel_unavailable");
  const scopeMatches = String(row.scope) === "platform"
    ? !String(row.workspaceId || "")
    : String(row.scope) === "workspace" && String(row.workspaceId) === String(binding.workspaceId);
  if (!scopeMatches) throw new VolcanoFileError("原始 Volcano 通道租户范围已变化", 503, "file_channel_unavailable");
  const channel = {
    ...row,
    id: String(row.id),
    name: String(row.name || row.id),
    baseUrl: row.baseUrl || null,
    credentialRef: row.credentialRef || null,
    credentialCiphertext: row.credentialCiphertext || null,
    config: parseProviderChannelConfig(row.configJson),
    timeoutMs: Number(row.timeoutMs) || 60_000,
  } as RelayChannel;
  if (normalizedBaseUrl(channel) !== String(binding.baseUrl)
    || normalizedCredentialRef(channel) !== String(binding.credentialRef || "")) {
    throw new VolcanoFileError("原始 Volcano 通道地址或凭据引用已变化", 503, "file_channel_unavailable");
  }
  return channel;
}

async function proxyBoundFile(fileId: string, owner: VolcanoFileOwner, method: "GET" | "DELETE"): Promise<any> {
  const binding = await findOwnedBinding(fileId, owner);
  const channel = await loadBoundChannel(binding);
  const apiKey = resolveChannelApiKey(channel, ["VOLCANO_ARK_API_KEY"]);
  if (!apiKey) throw new VolcanoFileError("原始 Volcano 通道凭据不可用", 503, "file_channel_unavailable");
  let payload: any;
  try {
    const response = await axios.request({
      method,
      url: joinProviderApiPath(resolveChannelBaseUrl(channel), `files/${encodeURIComponent(fileId)}`),
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      timeout: Number(channel.timeoutMs) || 120_000,
    });
    payload = response.data;
  } catch (error: any) {
    throw new VolcanoFileError(upstreamMessage(error), Number(error?.response?.status) || 502, "upstream_error");
  }
  const now = Date.now();
  if (method === "DELETE") {
    await applyOwnerScope(table().where({ responseId: bindingKey(fileId) }), owner).update({ deletedAt: now, updateTime: now });
  } else {
    await applyOwnerScope(table().where({ responseId: bindingKey(fileId) }), owner).update({
      upstreamModel: JSON.stringify({ fileId, payload }),
      expiresAt: readExpiresAt(payload) ?? binding.expiresAt,
      updateTime: now,
    });
  }
  return payload;
}

export function retrieveVolcanoFile(fileId: string, owner: VolcanoFileOwner): Promise<any> {
  return proxyBoundFile(fileId, owner, "GET");
}

export function deleteVolcanoFile(fileId: string, owner: VolcanoFileOwner): Promise<any> {
  return proxyBoundFile(fileId, owner, "DELETE");
}

export async function listVolcanoFiles(owner: VolcanoFileOwner, limit = 20): Promise<any> {
  assertOwner(owner);
  const safeLimit = Number.isSafeInteger(limit) && limit >= 1 && limit <= 100 ? limit : 20;
  const rows = await applyOwnerScope(table().where({ model: "file:user_data" }), owner)
    .where((query: any) => query.whereNull("expiresAt").orWhere("expiresAt", ">", Date.now()))
    .orderBy("createTime", "desc")
    .limit(safeLimit);
  const data = rows.map((row: any) => {
    try { return JSON.parse(String(row.upstreamModel || "{}")).payload || { id: String(row.responseId).slice(FILE_BINDING_PREFIX.length) }; }
    catch { return { id: String(row.responseId).slice(FILE_BINDING_PREFIX.length) }; }
  });
  return { object: "list", data, has_more: false };
}
