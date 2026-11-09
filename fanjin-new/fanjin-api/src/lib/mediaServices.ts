import crypto from "node:crypto";
import type { Knex } from "knex";
import { MEDIA_SERVICE_TABLE } from "@/lib/migrations/mediaServices";
import { parseProviderChannelConfig } from "@/lib/providerChannelSecrets";
import { inspectProviderChannelImageXReviewCredential, sealProviderChannelCredential, withProviderChannelCredentialCiphertext, withProviderChannelImageXReviewCredential, withProviderChannelImageXReviewEnabled } from "@/lib/providerChannelCredentials";
import { resolveChannelApiKey } from "@/lib/relayChannelCredential";
import { acquirePortraitImageXChannelMutationLock, closeImageXJobsForReplacement, providerChannelImageXReviewCredentialChanged } from "@/lib/portraitImageXCredentialRotationGuard";
import { FANJIN_VALUE_VIDEO_UPSCALE_SUBMIT_ENDPOINT, FANJIN_VALUE_VIDEO_UPSCALE_RESOLUTIONS } from "@/lib/fanjinValueVideoOffers";
import { inspectImageXService } from "@/lib/imagexServiceCheck";

type Database = Knex | Knex.Transaction;
export type MediaServiceKind = "mediakit" | "imagex";
export const MEDIAKIT_BASE_URL = "https://mediakit.cn-beijing.volces.com";
export const MEDIAKIT_STATUS_ENDPOINT = `${MEDIAKIT_BASE_URL}/api/v1/tasks/{taskId}`;

/** A saved enabled ImageX service is the sole current service. */
export function acceptsImageXNewJobs(row: any): boolean {
  const mode = parseProviderChannelConfig(row.configJson).imagexRoutingMode;
  return Number(row.disabled) === 0 && (mode === undefined || mode === "active");
}

export class MediaServiceError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}

/** Media processing only reads its dedicated current-schema storage. */
export async function mediaServiceTable(database: Database): Promise<string> {
  if (!await database.schema.hasTable(MEDIA_SERVICE_TABLE)) throw new MediaServiceError("MEDIA_SERVICE_MIGRATION_REQUIRED", "媒体服务表未就绪", 503);
  return MEDIA_SERVICE_TABLE;
}

export async function findMediaService(database: Database, id: string, kind: MediaServiceKind): Promise<any | null> {
  const table = await mediaServiceTable(database);
  const query = database(table).where({ id });
  query.where({ kind });
  return await query.first() || null;
}

export function mediaKitApiKey(row: any): string {
  return resolveChannelApiKey({
    id: String(row.id), provider: "volcano", endpointType: "video_upscale",
    credentialCiphertext: row.credentialCiphertext ?? null,
    credentialRef: row.credentialRef ?? null, config: parseProviderChannelConfig(row.configJson),
  }, []);
}

export function mediaKitRuntimeConfig(row: any, targetResolution: string) {
  if (!row || Number(row.disabled) !== 0 || !FANJIN_VALUE_VIDEO_UPSCALE_RESOLUTIONS.includes(targetResolution as any)) return null;
  const config = parseProviderChannelConfig(row.configJson);
  // Migration never silently upgrades an old fast service with old cost facts.
  if (row.kind === "mediakit" && (config.mode !== "generative" || config.submitEndpoint !== FANJIN_VALUE_VIDEO_UPSCALE_SUBMIT_ENDPOINT)) return null;
  const apiKey = mediaKitApiKey(row);
  if (!apiKey) return null;
  return { apiKey, mode: "generative" as const, submitEndpoint: FANJIN_VALUE_VIDEO_UPSCALE_SUBMIT_ENDPOINT, statusEndpoint: MEDIAKIT_STATUS_ENDPOINT };
}

/** Polling an already accepted legacy task must survive the additive migration.
 * This deliberately returns no submit endpoint and cannot dispatch new work. */
export function mediaKitExistingTaskQueryConfig(row: any) {
  if (!row) return null;
  const apiKey = mediaKitApiKey(row);
  return apiKey ? { apiKey, statusEndpoint: MEDIAKIT_STATUS_ENDPOINT } : null;
}

export function mediaServiceMetadata(row: any) {
  const config = parseProviderChannelConfig(row.configJson);
  const imagex = row.kind === "imagex" ? inspectProviderChannelImageXReviewCredential(String(row.id), config) : null;
  let configured = imagex?.configured ?? false;
  if (row.kind === "mediakit") { try { configured = Boolean(mediaKitApiKey(row)); } catch { configured = false; } }
  return {
    id: String(row.id), kind: row.kind as MediaServiceKind, name: String(row.name),
    enabled: Number(row.disabled) === 0 && (imagex ? imagex.enabled : true), configured,
    mode: row.kind === "mediakit" ? "generative" : null,
    requiresConfiguration: row.kind === "mediakit" && (config.mode !== "generative" || config.submitEndpoint !== FANJIN_VALUE_VIDEO_UPSCALE_SUBMIT_ENDPOINT),
    serviceId: imagex?.credential?.serviceId ?? "", credentialGeneration: imagex?.generation ?? null,
    supportedResolutions: row.kind === "mediakit" ? [...FANJIN_VALUE_VIDEO_UPSCALE_RESOLUTIONS] : [],
    healthStatus: row.healthStatus ?? null, lastHealthCheckAt: row.lastHealthCheckAt == null ? null : Number(row.lastHealthCheckAt),
    acceptNewJobs: row.kind === "imagex" && acceptsImageXNewJobs(row),
    routingMode: row.kind === "imagex" ? (parseProviderChannelConfig(row.configJson).imagexRoutingMode ?? "active") : null,
    healthMessage: row.healthMessage ?? null,
    updateTime: Number(row.updateTime),
  };
}

export async function listMediaServices(database: Database) {
  if (!(await database.schema.hasTable(MEDIA_SERVICE_TABLE))) throw new MediaServiceError("MEDIA_SERVICE_MIGRATION_REQUIRED", "请先执行媒体服务数据库迁移", 409);
  const rows = await database(MEDIA_SERVICE_TABLE).where({ scope: "platform" }).whereNull("workspaceId").orderBy("kind").orderBy("name");
  return rows.map(mediaServiceMetadata);
}

/** Fence task insertion against credential rotation. The persisted task then
 * protects this credential for its entire nonterminal lifetime. */
export async function lockMediaServiceForTask(trx: Knex.Transaction, id: string, target: string, expectedApiKey?: string) {
  if (!id) return;
  await acquirePortraitImageXChannelMutationLock(trx, id);
  const row = await trx(MEDIA_SERVICE_TABLE).where({ id, kind: "mediakit" }).forUpdate().first();
  const config = mediaKitRuntimeConfig(row, target);
  if (!config || (expectedApiKey !== undefined && config.apiKey !== expectedApiKey)) {
    throw new MediaServiceError("MEDIA_SERVICE_CHANGED", "超分服务配置已变更，请重新获取报价后重试", 409);
  }
}

export interface SaveMediaServiceInput {
  id?: string; kind: MediaServiceKind; name: string; enabled: boolean; expectedUpdateTime?: number;
  apiKey?: string; serviceId?: string; accessKeyId?: string; secretAccessKey?: string; sessionToken?: string;
  acceptNewJobs?: boolean;
}

async function assertMediaKitNotInUse(trx: Knex.Transaction, id: string) {
  if (await trx.schema.hasTable("o_user_video_enhance_task")) {
    const task = await trx("o_user_video_enhance_task").where({ enhanceChannelId: id }).whereIn("status", ["created", "enhancing", "reconciling"]).first();
    if (task) throw new MediaServiceError("MEDIA_SERVICE_BUSY", "超分服务仍有未完成任务，请完成后再修改凭据或停用", 409);
  }
  if (await trx.schema.hasTable("o_relay_task")) {
    // Legacy tasks do not all carry the service id in a queryable column.
    const task = await trx("o_relay_task").whereIn("status", ["queued", "running", "enhancing"]).first();
    if (task) throw new MediaServiceError("MEDIA_SERVICE_BUSY", "仍有视频流水线任务，请完成后再修改超分凭据或停用", 409);
  }
}

export async function saveMediaService(database: Knex, input: SaveMediaServiceInput) {
  if (!(await database.schema.hasTable(MEDIA_SERVICE_TABLE))) throw new MediaServiceError("MEDIA_SERVICE_MIGRATION_REQUIRED", "请先执行媒体服务数据库迁移", 409);
  return database.transaction(async (trx) => {
    const id = input.id || crypto.randomUUID();
    // Serialize all platform ImageX routing changes, then per-service identity.
    if (input.kind === "imagex") await acquirePortraitImageXChannelMutationLock(trx, "media-service-imagex-routing");
    // Same lock namespace as the ImageX job writer, including migrated ids.
    await acquirePortraitImageXChannelMutationLock(trx, id);
    const existing = await trx(MEDIA_SERVICE_TABLE).where({ id }).forUpdate().first();
    if (input.id && !existing) throw new MediaServiceError("MEDIA_SERVICE_NOT_FOUND", "媒体服务不存在", 404);
    if (existing && (existing.kind !== input.kind || existing.scope !== "platform" || existing.workspaceId != null)) throw new MediaServiceError("MEDIA_SERVICE_IDENTITY_IMMUTABLE", "不可改变服务类型或越过平台服务范围", 409);
    if (existing && Number(existing.updateTime) !== input.expectedUpdateTime) throw new MediaServiceError("MEDIA_SERVICE_CONFLICT", "配置已被修改，请刷新后重试", 409);
    let config = parseProviderChannelConfig(existing?.configJson);
    let credentialChanged = false;
    const modeChanged = input.kind === "mediakit" && (config.mode !== "generative" || config.submitEndpoint !== FANJIN_VALUE_VIDEO_UPSCALE_SUBMIT_ENDPOINT);
    if (input.kind === "mediakit") {
      if (input.acceptNewJobs !== undefined) throw new MediaServiceError("MEDIA_SERVICE_KIND", "新审核任务选择仅适用于 ImageX");
      if ([input.serviceId, input.accessKeyId, input.secretAccessKey, input.sessionToken].some(Boolean)) throw new MediaServiceError("MEDIA_SERVICE_CREDENTIAL_KIND", "MediaKit 只接受 API Key，不接受 ImageX AK/SK");
      credentialChanged = Boolean(input.apiKey?.trim());
      if (existing && (credentialChanged || modeChanged || !input.enabled)) await assertMediaKitNotInUse(trx, id);
      if (credentialChanged) config = withProviderChannelCredentialCiphertext(config, sealProviderChannelCredential(id, input.apiKey!));
      config = { ...config, mode: "generative", toolVersion: "generative", supportedResolutions: [...FANJIN_VALUE_VIDEO_UPSCALE_RESOLUTIONS], submitEndpoint: FANJIN_VALUE_VIDEO_UPSCALE_SUBMIT_ENDPOINT, statusEndpoint: MEDIAKIT_STATUS_ENDPOINT };
    } else {
      if (input.apiKey) throw new MediaServiceError("MEDIA_SERVICE_CREDENTIAL_KIND", "ImageX 只接受独立 Service ID 和 AK/SK");
      const current = inspectProviderChannelImageXReviewCredential(id, config);
      const submitted = [input.accessKeyId, input.secretAccessKey, input.sessionToken].some(Boolean) || Boolean(input.serviceId && input.serviceId !== current.credential?.serviceId);
      if (submitted) {
        if (!input.serviceId || !input.accessKeyId || !input.secretAccessKey) throw new MediaServiceError("MEDIA_SERVICE_CREDENTIAL_INCOMPLETE", "请完整填写 ImageX Service ID、Access Key ID 和 Secret Access Key");
        const next = { version: "fanjin-volcano-imagex-review-credential/v1" as const, serviceId: input.serviceId, accessKeyId: input.accessKeyId, secretAccessKey: input.secretAccessKey, ...(input.sessionToken ? { sessionToken: input.sessionToken } : {}) };
        credentialChanged = providerChannelImageXReviewCredentialChanged(current.credential, next);
        if (credentialChanged) {
          await closeImageXJobsForReplacement({ transaction: trx, channelId: id, credentialGeneration: current.generation });
          config = withProviderChannelImageXReviewCredential(id, config, next);
        }
      }
      if (existing && !input.enabled) await closeImageXJobsForReplacement({ transaction: trx, channelId: id, credentialGeneration: current.generation });
      config = withProviderChannelImageXReviewEnabled(config, input.enabled);
      if (input.acceptNewJobs && !input.enabled) throw new MediaServiceError("MEDIA_SERVICE_DISABLED", "承接新审核任务前请先启用服务");
      config = { ...config, imagexRoutingMode: input.enabled ? "active" : "standby" };
    }
    const timestamp = Math.max(Date.now(), Number(existing?.updateTime || 0) + 1);
    const row = {
      id, kind: input.kind, name: input.name.trim(), scope: "platform", workspaceId: null, provider: "volcano",
      endpointType: input.kind === "mediakit" ? "video_upscale" : "imagex_review",
      baseUrl: input.kind === "mediakit" ? MEDIAKIT_BASE_URL : "https://imagex.volcengineapi.com",
      credentialRef: credentialChanged ? null : existing?.credentialRef ?? null,
      credentialCiphertext: credentialChanged ? null : existing?.credentialCiphertext ?? null,
      configJson: JSON.stringify(config), disabled: input.enabled ? 0 : 1,
      updateTime: timestamp, ...((credentialChanged || modeChanged) ? { healthStatus: null, lastHealthCheckAt: null, healthMessage: null } : {}),
    };
    const metadata = mediaServiceMetadata({ ...existing, ...row });
    if (input.enabled && !metadata.configured) throw new MediaServiceError("MEDIA_SERVICE_CREDENTIAL_REQUIRED", "启用前请填写有效的独立凭据");
    const replacedServiceIds: string[] = [];
    if (input.kind === "imagex" && input.enabled) {
      const peers = await trx(MEDIA_SERVICE_TABLE).where({ kind: "imagex", scope: "platform" }).whereNull("workspaceId").whereNot({ id }).orderBy("id").select("id");
      for (const candidate of peers) {
        await acquirePortraitImageXChannelMutationLock(trx, String(candidate.id));
        const peer = await trx(MEDIA_SERVICE_TABLE).where({ id: candidate.id }).forUpdate().first();
        if (!peer) continue;
        const peerCredential = inspectProviderChannelImageXReviewCredential(String(peer.id), parseProviderChannelConfig(peer.configJson));
        await closeImageXJobsForReplacement({ transaction: trx, channelId: String(peer.id), credentialGeneration: peerCredential.generation });
        await trx(MEDIA_SERVICE_TABLE).where({ id: peer.id }).update({
          disabled: 1,
          configJson: JSON.stringify({ imagexPortraitReviewEnabled: false, imagexRoutingMode: "standby" }),
          updateTime: Math.max(timestamp, Number(peer.updateTime) + 1),
        });
        replacedServiceIds.push(String(peer.id));
      }
    }
    if (existing) await trx(MEDIA_SERVICE_TABLE).where({ id }).update(row);
    else await trx(MEDIA_SERVICE_TABLE).insert({ ...row, createTime: timestamp });
    return { service: metadata, credentialChanged, replacedServiceIds };
  });
}

/** No paid processing: only query an intentionally absent task on the fixed host. */
export async function checkMediaKitService(database: Knex, id: string, fetcher: typeof fetch = fetch) {
  const row = await findMediaService(database, id, "mediakit");
  if (!row || row.kind !== "mediakit" || row.scope !== "platform" || row.workspaceId != null) throw new MediaServiceError("MEDIA_SERVICE_NOT_FOUND", "MediaKit 服务不存在", 404);
  const apiKey = mediaKitApiKey(row);
  if (!apiKey) throw new MediaServiceError("MEDIA_SERVICE_CREDENTIAL_REQUIRED", "请先保存 API Key");
  let ok = false;
  try {
    const response = await fetcher(`${MEDIAKIT_BASE_URL}/api/v1/tasks/fanjin-health-probe-not-found`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10000), redirect: "error" });
    if (response.status === 404 && response.headers.get("content-type")?.includes("application/json")) {
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      if (!reader) throw new Error("empty response");
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 16384) throw new Error("response too large");
          chunks.push(chunk.value);
        }
      } finally { await reader.cancel(); }
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      ok = payload?.success === false && payload?.error?.code === "InvalidParameter" && payload?.error?.type === "NotFound";
    } else { await response.body?.cancel(); }
  } catch { ok = false; }
  const count = await database(MEDIA_SERVICE_TABLE).where({ id, updateTime: row.updateTime }).update({ healthStatus: ok ? "ok" : "failed", lastHealthCheckAt: Date.now() });
  if (!count) throw new MediaServiceError("MEDIA_SERVICE_CONFLICT", "探测期间凭据已更改，请重新测试", 409);
  return { ok, message: ok ? "凭据与任务查询链路可用；尚未验证付费超分任务" : "连接校验失败，请核对凭据与服务权限" };
}

export async function checkMediaService(database: Knex, id: string, fetcher: typeof fetch = fetch) {
  const row = await database(MEDIA_SERVICE_TABLE).where({ id, scope: "platform" }).whereNull("workspaceId").first();
  if (!row) throw new MediaServiceError("MEDIA_SERVICE_NOT_FOUND", "媒体服务不存在", 404);
  if (row.kind === "mediakit") return checkMediaKitService(database, id, fetcher);
  if (row.kind !== "imagex") throw new MediaServiceError("MEDIA_SERVICE_KIND", "不支持的媒体服务类型");
  const inspected = inspectProviderChannelImageXReviewCredential(id, row.configJson);
  if (!inspected.credential) throw new MediaServiceError("MEDIA_SERVICE_CREDENTIAL_REQUIRED", "请先保存完整的 ImageX 凭据");
  const result = await inspectImageXService(inspected.credential, fetcher);
  const count = await database(MEDIA_SERVICE_TABLE).where({ id, updateTime: row.updateTime }).update({
    healthStatus: result.ok ? "limited" : "failed", healthMessage: result.message, lastHealthCheckAt: Date.now(),
  });
  if (!count) throw new MediaServiceError("MEDIA_SERVICE_CONFLICT", "检查期间配置已更改，请重新检查", 409);
  return result;
}
