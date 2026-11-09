import { portraitRegistrationFailureMessage } from "@/lib/portraitRegistrationFailure";
import { isPortraitProviderRefusal, PORTRAIT_PROVIDER_REFUSAL_MESSAGE } from "@/lib/portraitSubmissionPolicy";
import { hasUpstreamRealPersonRejection, UPSTREAM_REAL_PERSON_REJECTION } from "@/lib/portraitUpstreamRejection";
import { portraitScopeCompliance, wherePortraitScopeEligible, withPortraitReviewScope } from "@/lib/portraitReviewScope";
import { resolveProjectAssetVersion } from "@/lib/projectAssetVersion";
import { isAutomaticPortrait, prepareAutomaticPortraitRegistrations } from "@/lib/portraitAutomaticRegistration";
import { preferredVolcanoPortraitChannel } from "@/lib/portraitProviderChannel";
import crypto from "node:crypto";
import type { Knex } from "knex";
import { v4 as uuid } from "uuid";

import { writeAuditLog } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { recoverUnknownPortraitRegistrations } from "./portraitUnknownRegistrationRecovery";
import {
  PORTRAIT_ADMISSION_TABLE,
  PORTRAIT_AUTH_SESSION_TABLE,
  PORTRAIT_CONSENT_TABLE,
  PORTRAIT_IDENTITY_TABLE,
  PORTRAIT_PROVIDER_ASSET_TABLE,
  PORTRAIT_PROVIDER_GROUP_TABLE,
} from "@/lib/migrations/portraitAssetAdmission";
import { readPortraitAdmission, type PortraitAdmissionDto } from "@/lib/portraitAdmissionStore";
import { parseProviderChannelConfig } from "@/lib/providerChannelSecrets";
import {
  inspectProviderChannelPortraitCredential,
  TOKENHEX_PORTRAIT_CREDENTIAL_VERSION,
  readProviderChannelPortraitCredentialMetadata,
} from "@/lib/providerChannelCredentials";
import {
  withPortraitChannelCredentialForDispatch,
} from "@/lib/relayChannelCredential";
import { isFormalCandidateCredentialRuntimeDeclared } from "@/lib/formalCandidateCredentialRuntime";
import {
  createVolcenginePortraitAssetsClientForCredentialDispatch,
  VolcenginePortraitAssetsError,
  type VolcenginePortraitAssetGroupRef,
  type VolcenginePortraitAssetScope,
  type VolcenginePortraitAssetsClient,
  type VolcengineVisualValidateSession,
} from "@/lib/volcenginePortraitAssets";
import {
  applyVolcenginePortraitAssetSubmitFailure,
  applyVolcenginePortraitAssetSubmitted,
  createQueuedVolcenginePortraitAssetSync,
  markVolcenginePortraitAssetSubmitting,
  pollVolcenginePortraitAssetSync,
  type VolcenginePortraitAssetSubmitInput,
  type VolcenginePortraitAssetSyncRecord,
} from "@/lib/volcenginePortraitAssetSync";
import {
  applyVolcenginePortraitAuthCallback,
  applyVolcenginePortraitAuthSessionCreated,
  applyVolcenginePortraitAuthSucceeded,
  applyVolcenginePortraitGroupActive,
  createQueuedVolcenginePortraitGroupSync,
  createVolcenginePortraitAuthSessionRecord,
  markVolcenginePortraitGroupAuthorizing,
  markVolcenginePortraitGroupCreating,
  type VolcenginePortraitAuthSessionSyncRecord,
  type VolcenginePortraitGroupSyncRecord,
  volcenginePortraitBytedTokenDigest,
  volcenginePortraitCallbackNonceHash,
} from "@/lib/volcenginePortraitGroupSync";
import { KnexVolcenginePortraitIdempotencyStore } from "@/lib/volcenginePortraitIdempotencyStore";
import { db } from "@/utils/db";
import u from "@/utils";

const CALLBACK_PATH = "/api/public/portrait-assets/callback";
const AUTH_TTL_MS = 30 * 60_000;
const ASSET_TIMEOUT_MS = 2 * 60 * 60_000;
const WORKER_LEASE_MS = 2 * 60_000;
const STALE_MUTATION_MS = 5 * 60_000;
const WORKER_BATCH = 8;
const MATERIALIZATION_RETRY_MS = 30_000;
const workerOwner = `portrait-provider-${process.pid}-${uuid()}`;

type Environment = Record<string, string | undefined>;
type ChannelRow = Record<string, any>;
type AdmissionRuntimeRow = Record<string, any>;

import { PortraitProviderRuntimeError } from "./portraitProviderError";
export { PortraitProviderRuntimeError } from "./portraitProviderError";

export type PortraitProviderQueueResult = Readonly<{
  admissionId: string;
  assetBindingId: string | null;
  providerAssetUri: string | null;
  state: "authorizing" | "creating_group" | "processing" | "active";
}>;

export type PortraitAuthorizationStart = Readonly<{
  admission: PortraitAdmissionDto;
  authorizationUrl: string;
  expiresAt: number;
}>;

export type PortraitAuthorizationCallbackResult = Readonly<{
  admissionId: string;
  assetVersionId: number;
  state: "succeeded" | "failed" | "expired";
}>;

function runtimeError(status: number, code: string, message: string): never {
  throw new PortraitProviderRuntimeError(status, code, message);
}

/** Keep the API error contract while retaining the durable upstream failure for the worker. */
class PortraitBindingRuntimeError extends PortraitProviderRuntimeError {
  readonly registrationCode: string;
  constructor(status: number, code: string, message: string, binding: Record<string, any>) {
    super(status, code, message);
    this.registrationCode = cleanString(binding.safeErrorCode, 180) || code;
  }
}

function cleanString(value: unknown, maximum = 256): string {
  const parsed = String(value ?? "").trim();
  if (!parsed || parsed.length > maximum || /[\u0000-\u001f\u007f]/u.test(parsed)) return "";
  return parsed;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    runtimeError(400, "portrait_request_invalid", `${label} 无效`);
  }
  return parsed;
}

function safeId(value: unknown, label: string): string {
  const parsed = cleanString(value);
  if (!parsed || /\s/u.test(parsed)) runtimeError(400, "portrait_request_invalid", `${label} 无效`);
  return parsed;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function sameDigest(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function isProduction(environment: Environment): boolean {
  return ["prod", "production"].includes(String(environment.NODE_ENV || "").trim().toLowerCase());
}

/** The callback origin is never inferred from Host/X-Forwarded-* request headers. */
export function resolvePortraitProviderPublicOrigin(
  environment: Environment = process.env,
): string {
  const raw = cleanString(
    environment.FANJIN_PORTRAIT_CALLBACK_ORIGIN
      || environment.FANJIN_PUBLIC_BASE_URL
      || environment.PUBLIC_BASE_URL,
    2_048,
  );
  if (!raw) runtimeError(503, "portrait_callback_origin_missing", "真人认证公网回调地址未配置");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    runtimeError(503, "portrait_callback_origin_invalid", "真人认证公网回调地址无效");
  }
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  if (
    (parsed.protocol !== "https:" && !(loopback && !isProduction(environment)))
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    runtimeError(503, "portrait_callback_origin_invalid", "真人认证公网回调地址必须使用 HTTPS origin");
  }
  return parsed.origin;
}

export function portraitAuthorizationCallbackUrl(
  callbackNonce: string,
  environment: Environment = process.env,
): string {
  const nonce = safeId(callbackNonce, "callback nonce");
  const callback = new URL(CALLBACK_PATH, resolvePortraitProviderPublicOrigin(environment));
  // `state` is redacted by the shared request logger. The raw nonce never
  // appears in a route path or durable row; only its SHA-256 digest is stored.
  callback.searchParams.set("state", nonce);
  return callback.toString();
}

export function derivePortraitProviderGroupType(
  subjectKind: unknown,
): "AIGC" | "LivenessFace" {
  if (subjectKind === "real_person") return "LivenessFace";
  if (subjectKind === "detected_person" || subjectKind === "virtual_person" || subjectKind === "trusted_output") return "AIGC";
  runtimeError(422, "portrait_provider_subject_unsupported", "当前素材类型不需要或不能创建上游人像资产");
}

function channelScope(channel: ChannelRow): VolcenginePortraitAssetScope {
  const config = parseProviderChannelConfig(channel.configJson);
  const channelId = safeId(channel.id, "供应商通道");
  const endpointType = cleanString(channel.endpointType);
  if (endpointType !== "video_generation") {
    runtimeError(
      409,
      "portrait_provider_asset_uri_protocol_unsupported",
      "人像 asset:// 资产仅支持已发布协议的 Volcano 视频生成通道",
    );
  }
  const providerAccountId = cleanString(
    config.providerAccountId ?? config.volcengineAccountId ?? config.accountId,
    128,
  );
  const projectName = cleanString(config.assetsProjectName ?? config.projectName, 128);
  if (!providerAccountId || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,127}$/u.test(providerAccountId)) {
    runtimeError(503, "portrait_provider_account_missing", "火山通道缺少人像资产账号标识");
  }
  if (!projectName || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u.test(projectName)) {
    runtimeError(503, "portrait_provider_project_missing", "火山通道缺少人像资产 ProjectName");
  }
  const metadata = readProviderChannelPortraitCredentialMetadata(config);
  if (!metadata.enabled || !metadata.binding || metadata.generation < 1) {
    runtimeError(503, "portrait_provider_disabled", "火山通道未启用人像资产能力");
  }
  if (
    !isFormalCandidateCredentialRuntimeDeclared()
    && !inspectProviderChannelPortraitCredential(channelId, config).configured
  ) {
    runtimeError(503, "portrait_provider_credential_missing", "火山人像资产通道凭据不可用");
  }
  return Object.freeze({ channelId, providerAccountId, projectName });
}

function channelPortraitCredentialBinding(channel: ChannelRow): string {
  const metadata = readProviderChannelPortraitCredentialMetadata(
    parseProviderChannelConfig(channel.configJson),
  );
  if (!metadata.enabled || !metadata.binding || metadata.generation < 1) {
    runtimeError(503, "portrait_provider_disabled", "火山通道未启用人像资产能力");
  }
  return metadata.binding;
}

/** Rotating the AK/SK generation intentionally invalidates prior provider assets. */
export function portraitProviderAccountFingerprint(
  scope: VolcenginePortraitAssetScope,
  credentialBinding: string,
): string {
  if (!/^hmac-sha256:[a-f0-9]{64}$/u.test(credentialBinding)) {
    runtimeError(503, "portrait_provider_credential_binding_invalid", "火山人像资产凭据绑定无效");
  }
  return sha256(JSON.stringify({
    channelId: scope.channelId,
    credentialBinding,
    projectName: scope.projectName,
    providerAccountId: scope.providerAccountId,
    version: "portrait-provider-account/v2",
  }));
}

async function providerChannel(input: {
  database: Knex | Knex.Transaction;
  workspaceId: string;
  channelId: string;
  lock?: boolean;
}): Promise<ChannelRow> {
  const query = input.database("o_provider_channel")
    .where({
      id: input.channelId,
      provider: "volcano",
      disabled: 0,
    })
    .where((builder) => builder
      .where((workspace) => workspace.where({ scope: "workspace", workspaceId: input.workspaceId }))
      .orWhere((platform) => platform.where("scope", "platform").whereNull("workspaceId")));
  if (input.lock) query.forUpdate();
  const row = await query.first();
  if (!row) runtimeError(409, "portrait_provider_channel_unavailable", "火山人像资产通道不可用");
  channelScope(row);
  return row;
}

async function withPortraitClient<T>(input: {
  database?: Knex | Knex.Transaction;
  channel: ChannelRow;
  workspaceId: string;
  actorUserId: number;
  operation: (client: VolcenginePortraitAssetsClient) => Promise<T>;
}): Promise<T> {
  const channelId = safeId(input.channel.id, "供应商通道");
  const endpointType = cleanString(input.channel.endpointType);
  const credentialChannel = {
    id: channelId,
    provider: "volcano",
    endpointType,
    baseUrl: input.channel.baseUrl,
    credentialRef: input.channel.credentialRef,
    config: parseProviderChannelConfig(input.channel.configJson),
  } as const;
  const client = createVolcenginePortraitAssetsClientForCredentialDispatch({
    id: channelId,
    provider: "volcano",
    endpointType,
    baseUrl: input.channel.baseUrl,
    credentialRef: input.channel.credentialRef,
    configJson: input.channel.configJson,
  }, {
    idempotencyStore: new KnexVolcenginePortraitIdempotencyStore({
      actorUserId: input.actorUserId,
      database: input.database ?? db,
      workspaceId: input.workspaceId,
    }),
  }, (use) => withPortraitChannelCredentialForDispatch(
    credentialChannel,
    {
      channelId,
      provider: "volcano",
      endpointType,
      model: "volcano-portrait-assets",
    },
    (credentialEnvelope) => {
      if (!credentialEnvelope) {
        runtimeError(503, "portrait_provider_credential_missing", "火山人像资产通道凭据不可用");
      }
      return use(credentialEnvelope);
    },
  ));
  return await input.operation(client);
}

async function admissionRuntimeRow(input: {
  database: Knex | Knex.Transaction;
  workspaceId: string;
  projectId?: number;
  assetVersionId?: number;
  admissionId?: string;
  lock?: boolean;
}): Promise<AdmissionRuntimeRow> {
  const query = input.database(`${PORTRAIT_ADMISSION_TABLE} as admission`)
    .innerJoin(`${PORTRAIT_IDENTITY_TABLE} as identity`, "identity.id", "admission.identityId")
    .leftJoin(`${PORTRAIT_CONSENT_TABLE} as consent`, "consent.id", "admission.currentConsentId")
    .innerJoin("o_image as version", "version.id", "admission.assetVersionId")
    .where("admission.workspaceId", input.workspaceId)
    .select(
      "admission.*",
      "identity.ownerUserId",
      "identity.kind as identityKind",
      "identity.label as identityLabel",
      "identity.state as identityState",
      "identity.revision as identityRevision",
      "consent.status as consentStatus",
      "consent.expiresAt as consentExpiresAt",
      "version.filePath",
      "version.type as versionMediaType",
    );
  if (input.admissionId) query.andWhere("admission.id", input.admissionId);
  else query.andWhere({
    "admission.projectId": input.projectId,
    "admission.assetVersionId": input.assetVersionId,
  });
  if (input.lock) query.forUpdate("admission", "identity", "version");
  const row = await query.first();
  if (!row) runtimeError(404, "portrait_admission_not_found", "素材人像准入记录不存在");
  return withPortraitReviewScope(row);
}

function assertCurrentConsent(row: AdmissionRuntimeRow, now: number): void {
  if (isAutomaticPortrait(row) && row.identityKind === "detected_person" && row.identityState === "active" && row.currentConsentId == null) return;
  if (row.consentStatus !== "active" || (row.consentExpiresAt && Number(row.consentExpiresAt) <= now)) {
    runtimeError(409, "portrait_consent_inactive", "素材肖像授权已失效，请重新确认");
  }
}

function groupRecord(row: Record<string, any>, scope: VolcenginePortraitAssetScope): VolcenginePortraitGroupSyncRecord {
  return Object.freeze({
    activeAt: row.activeAt == null ? null : Number(row.activeAt),
    createdAt: Number(row.createdAt),
    group: row.providerGroupId ? Object.freeze({
      groupId: String(row.providerGroupId),
      groupType: row.groupType,
      scope,
    }) : null,
    groupType: row.groupType,
    idempotencyKey: String(row.idempotencyKey),
    nextAttemptAt: Number(row.nextAttemptAt),
    retryCount: Number(row.retryCount || 0),
    safeErrorCode: row.safeErrorCode == null ? null : String(row.safeErrorCode),
    safeErrorMessage: row.safeErrorMessage == null ? null : String(row.safeErrorMessage),
    scope,
    state: row.state,
    updatedAt: Number(row.updatedAt),
  });
}

function authRecord(row: Record<string, any>, scope: VolcenginePortraitAssetScope): VolcenginePortraitAuthSessionSyncRecord {
  return Object.freeze({
    bytedTokenDigest: row.bytedTokenDigest == null ? null : String(row.bytedTokenDigest),
    callbackNonceHash: String(row.callbackNonceHash),
    consumedAt: row.consumedAt == null ? null : Number(row.consumedAt),
    createdAt: Number(row.createdAt),
    expiresAt: Number(row.expiresAt),
    providerSessionId: row.providerSessionId == null ? null : String(row.providerSessionId),
    resultReceivedAt: row.resultReceivedAt == null ? null : Number(row.resultReceivedAt),
    safeErrorCode: row.safeErrorCode == null ? null : String(row.safeErrorCode),
    safeErrorMessage: row.safeErrorMessage == null ? null : String(row.safeErrorMessage),
    scope,
    state: row.state,
    updatedAt: Number(row.updatedAt),
  });
}

function groupWrite(record: VolcenginePortraitGroupSyncRecord): Record<string, unknown> {
  return {
    state: record.state,
    providerGroupId: record.group?.groupId ?? null,
    retryCount: record.retryCount,
    nextAttemptAt: record.nextAttemptAt,
    safeErrorCode: record.safeErrorCode,
    safeErrorMessage: record.safeErrorMessage,
    activeAt: record.activeAt,
    updatedAt: record.updatedAt,
  };
}

function authWrite(record: VolcenginePortraitAuthSessionSyncRecord): Record<string, unknown> {
  return {
    state: record.state,
    bytedTokenDigest: record.bytedTokenDigest,
    consumedAt: record.consumedAt,
    resultReceivedAt: record.resultReceivedAt,
    safeErrorCode: record.safeErrorCode,
    safeErrorMessage: record.safeErrorMessage,
    updatedAt: record.updatedAt,
  };
}

async function ensureGroupRow(input: {
  trx: Knex.Transaction;
  row: AdmissionRuntimeRow;
  channel: ChannelRow;
  now: number;
  retryFailed?: boolean;
}): Promise<Record<string, any>> {
  const scope = channelScope(input.channel);
  const groupType = derivePortraitProviderGroupType(input.row.subjectKind);
  const fingerprint = portraitProviderAccountFingerprint(
    scope,
    channelPortraitCredentialBinding(input.channel),
  );
  let group = await input.trx(PORTRAIT_PROVIDER_GROUP_TABLE)
    .where({
      identityId: input.row.identityId,
      channelId: scope.channelId,
      providerAccountFingerprint: fingerprint,
      projectName: scope.projectName,
      groupType,
    })
    .forUpdate()
    .first();
  if (group) {
    if (["failed", "stale"].includes(String(group.state))) {
      if (group.safeErrorCode === "VOLC_PORTRAIT_OUTCOME_UNKNOWN") {
        throw new PortraitBindingRuntimeError(409, "portrait_provider_outcome_unknown", "上游素材组创建结果待管理员核对，不能自动重放", group);
      }
      if (input.retryFailed === false) {
        throw new PortraitBindingRuntimeError(409, "portrait_provider_binding_failed", "上游素材组登记失败，请查看登记原因", group);
      }
      const idempotencyKey = `portrait-group-${group.id}-${uuid()}`;
      await input.trx(PORTRAIT_PROVIDER_GROUP_TABLE).where({ id: group.id }).update({
        state: "queued",
        providerGroupId: null,
        idempotencyKey,
        retryCount: 0,
        nextAttemptAt: input.now,
        leaseOwner: null,
        leaseExpiresAt: null,
        safeErrorCode: null,
        safeErrorMessage: null,
        activeAt: null,
        updatedAt: input.now,
      });
      group = { ...group, state: "queued", providerGroupId: null, idempotencyKey, retryCount: 0, nextAttemptAt: input.now, safeErrorCode: null, safeErrorMessage: null, activeAt: null, updatedAt: input.now };
    }
    return group;
  }
  const id = uuid();
  const queued = createQueuedVolcenginePortraitGroupSync({
    groupType,
    idempotencyKey: `portrait-group-${id}`,
    now: input.now,
    scope,
  });
  try {
    await input.trx(PORTRAIT_PROVIDER_GROUP_TABLE).insert({
      id,
      workspaceId: input.row.workspaceId,
      identityId: input.row.identityId,
      channelId: scope.channelId,
      provider: "volcano",
      providerAccountFingerprint: fingerprint,
      projectName: scope.projectName,
      groupType,
      providerGroupId: null,
      state: queued.state,
      idempotencyKey: queued.idempotencyKey,
      retryCount: queued.retryCount,
      nextAttemptAt: queued.nextAttemptAt,
      leaseOwner: null,
      leaseExpiresAt: null,
      safeErrorCode: null,
      safeErrorMessage: null,
      activeAt: null,
      createdAt: input.now,
      updatedAt: input.now,
    });
  } catch (caught) {
    group = await input.trx(PORTRAIT_PROVIDER_GROUP_TABLE)
      .where({
        identityId: input.row.identityId,
        channelId: scope.channelId,
        providerAccountFingerprint: fingerprint,
        projectName: scope.projectName,
        groupType,
      })
      .forUpdate()
      .first();
    if (!group) throw caught;
    return group;
  }
  return await input.trx(PORTRAIT_PROVIDER_GROUP_TABLE).where({ id }).forUpdate().first();
}

async function ensureAssetRow(input: {
  trx: Knex.Transaction;
  row: AdmissionRuntimeRow;
  group: Record<string, any>;
  scope: VolcenginePortraitAssetScope;
  now: number;
  retryFailed?: boolean;
  refreshFailedObservation?: boolean;
}): Promise<Record<string, any>> {
  let asset = await input.trx(PORTRAIT_PROVIDER_ASSET_TABLE)
    .where({ admissionId: input.row.id, groupBindingId: input.group.id })
    .forUpdate()
    .first();
  if (asset) {
    if (["failed", "stale"].includes(String(asset.state))) {
      if (asset.safeErrorCode === "VOLC_PORTRAIT_OUTCOME_UNKNOWN") {
        throw new PortraitBindingRuntimeError(409, "portrait_provider_outcome_unknown", "上游素材创建结果待管理员核对，不能自动重放", asset);
      }
      if (input.refreshFailedObservation && asset.state === "failed"
        && asset.safeErrorCode === "VOLC_PORTRAIT_RESPONSE_INVALID"
        && cleanString(asset.providerAssetId)
        && asset.sourceSha256 === input.row.sourceSha256
        && (!asset.leaseExpiresAt || Number(asset.leaseExpiresAt) < input.now)) {
        // Only resume a GET on the original provider ID. Keep the create key,
        // receipt, error evidence and source binding; never queue another POST.
        await input.trx(PORTRAIT_PROVIDER_ASSET_TABLE).where({ id: asset.id }).update({
          state: "processing", nextAttemptAt: input.now, leaseOwner: null,
          leaseExpiresAt: null, updatedAt: input.now,
        });
        await writeAuditLog({ workspaceId: input.row.workspaceId, actor: { actorKind: "system" } }, {
          workspaceId: input.row.workspaceId, action: "portrait.provider_asset.observation_resumed",
          resourceType: "portrait_provider_asset", resourceId: asset.id, required: true,
          metadata: { channelId: input.scope.channelId, previousErrorCode: asset.safeErrorCode,
            operation: "GetAsset", createReplayed: false },
        }, input.trx);
        return { ...asset, state: "processing", nextAttemptAt: input.now, leaseOwner: null,
          leaseExpiresAt: null, updatedAt: input.now };
      }
      if (input.retryFailed === false) {
        const mediaFailure = portraitRegistrationFailureMessage(asset.safeErrorCode);
        if (mediaFailure) throw new PortraitBindingRuntimeError(422, "portrait_provider_media_invalid", mediaFailure, asset);
        throw new PortraitBindingRuntimeError(409, "portrait_provider_binding_failed", "上游素材登记失败，请查看登记原因", asset);
      }
      const idempotencyKey = `portrait-asset-${asset.id}-${uuid()}`;
      await input.trx(PORTRAIT_PROVIDER_ASSET_TABLE).where({ id: asset.id }).update({
        state: "queued",
        providerAssetId: null,
        providerAssetUri: null,
        idempotencyKey,
        retryCount: 0,
        nextAttemptAt: input.now,
        leaseOwner: null,
        leaseExpiresAt: null,
        safeErrorCode: null,
        safeErrorMessage: null,
        activeAt: null,
        updatedAt: input.now,
      });
      asset = { ...asset, state: "queued", providerAssetId: null, providerAssetUri: null, idempotencyKey, retryCount: 0, nextAttemptAt: input.now, safeErrorCode: null, safeErrorMessage: null, activeAt: null, updatedAt: input.now };
    }
    return asset;
  }
  if (!input.row.sourceSha256 || !/^[a-f0-9]{64}$/u.test(String(input.row.sourceSha256))) {
    runtimeError(409, "portrait_source_digest_missing", "素材缺少可验证的源文件摘要");
  }
  const providerGroup: VolcenginePortraitAssetGroupRef = Object.freeze({
    groupId: safeId(input.group.providerGroupId, "上游素材组"),
    groupType: input.group.groupType,
    scope: input.scope,
  });
  const id = uuid();
  const request: VolcenginePortraitAssetSubmitInput = Object.freeze({
    assetType: input.row.mediaType === "video" ? "Video" : "Image",
    group: providerGroup,
    idempotencyKey: `portrait-asset-${id}`,
    name: cleanString(input.row.identityLabel, 64) || undefined,
    sourceSha256: String(input.row.sourceSha256),
    // URL is deliberately excluded from the durable request fingerprint. The
    // authoritative object-store URL is resolved immediately before dispatch.
    url: "https://placeholder.invalid/authoritative-object",
  });
  const queued = createQueuedVolcenginePortraitAssetSync({ now: input.now, request });
  try {
    await input.trx(PORTRAIT_PROVIDER_ASSET_TABLE).insert({
      id,
      workspaceId: input.row.workspaceId,
      admissionId: input.row.id,
      groupBindingId: input.group.id,
      channelId: input.scope.channelId,
      providerAssetId: null,
      providerAssetUri: null,
      state: queued.state,
      idempotencyKey: queued.idempotencyKey,
      sourceSha256: queued.sourceSha256,
      retryCount: queued.retryCount,
      nextAttemptAt: queued.nextAttemptAt,
      leaseOwner: null,
      leaseExpiresAt: null,
      safeErrorCode: null,
      safeErrorMessage: null,
      activeAt: null,
      createdAt: input.now,
      updatedAt: input.now,
    });
  } catch (caught) {
    asset = await input.trx(PORTRAIT_PROVIDER_ASSET_TABLE)
      .where({ admissionId: input.row.id, groupBindingId: input.group.id })
      .forUpdate()
      .first();
    if (!asset) throw caught;
    return asset;
  }
  return await input.trx(PORTRAIT_PROVIDER_ASSET_TABLE).where({ id }).forUpdate().first();
}

/**
 * Materialize the channel-specific provider binding. Relay may call this with
 * the actually selected Volcano channel; no client-controlled GroupType is
 * accepted. Missing bindings remain a retryable 409 until the worker reaches
 * Active.
 */
export async function ensurePortraitProviderBindingQueued(input: {
  database?: Knex;
  workspaceId: string;
  projectId: number;
  assetVersionId: number;
  channelId: string;
  now?: number;
  /** Generation submission prepares missing rows but cannot replay failed mutations. */
  retryFailed?: boolean;
  /** Explicit registration may re-read an existing Tokenhex ID after a local parse failure. */
  refreshFailedObservation?: boolean;
}): Promise<PortraitProviderQueueResult> {
  const database = input.database ?? db;
  const source = await resolveProjectAssetVersion({ ...input, database });
  if (!source) runtimeError(404, "portrait_admission_not_found", "素材不存在或无权使用");
  const projectId = source.sourceProjectId;
  const assetVersionId = positiveInteger(input.assetVersionId, "assetVersionId");
  const channelId = safeId(input.channelId, "channelId");
  const now = input.now ?? Date.now();
  const channel = await providerChannel({ database, workspaceId: input.workspaceId, channelId });
  return await database.transaction(async (trx) => {
    const row = await admissionRuntimeRow({
      database: trx,
      workspaceId: input.workspaceId,
      projectId,
      assetVersionId,
      lock: true,
    });
    if (
      row.sourceRecoveryState !== "ready"
      || !/^[a-f0-9]{64}$/u.test(String(row.sourceSha256 || ""))
    ) {
      runtimeError(409, "portrait_source_digest_pending", "素材完整性证据尚未就绪");
    }
    if (hasUpstreamRealPersonRejection(row)) {
      runtimeError(409, "portrait_upstream_review_required", "火山已拒绝该人物参考，请确认来源并登记或联系管理员复核");
    }
    if (isPortraitProviderRefusal(row.safeErrorCode)) {
      runtimeError(409, "portrait_provider_review_required", PORTRAIT_PROVIDER_REFUSAL_MESSAGE);
    }
    assertCurrentConsent(row, now);
    if (portraitScopeCompliance(row) !== "allowed") {
      runtimeError(409, "portrait_admission_pending", "素材人像准入尚未完成");
    }
    if (row.subjectKind === "real_person" && row.identityState !== "active") {
      runtimeError(409, "portrait_real_authorization_required", "真人素材尚未完成火山授权");
    }
    if (!["virtual_person", "trusted_output", "real_person", "detected_person"].includes(String(row.subjectKind))) {
      runtimeError(422, "portrait_provider_subject_unsupported", "当前素材不需要创建上游人像资产");
    }
    // Additional routes have their own durable groups/assets. Keep the current
    // usable registration and its policy proof stable while another is prepared.
    const preserveActiveBinding = row.providerSyncState === "active"
      && Boolean(row.currentProviderAssetBindingId)
      && row.preferredProviderChannelId !== channelId;
    const group = await ensureGroupRow({ trx, row, channel, now, retryFailed: input.retryFailed });
    if (group.state !== "active" || !group.providerGroupId) {
      const state = row.subjectKind === "real_person" ? "authorizing" : "creating_group";
      if (preserveActiveBinding) {
        return { admissionId: String(row.id), assetBindingId: null, providerAssetUri: null, state };
      }
      await trx(PORTRAIT_ADMISSION_TABLE).where({ id: row.id }).update({
        preferredProviderChannelId: channelId,
        providerSyncState: state,
        currentProviderAssetBindingId: null,
        revision: Number(row.revision) + 1,
        updatedAt: now,
      });
      return { admissionId: String(row.id), assetBindingId: null, providerAssetUri: null, state };
    }
    const scope = channelScope(channel);
    const asset = await ensureAssetRow({ trx, row, group, scope, now, retryFailed: input.retryFailed,
      refreshFailedObservation: input.refreshFailedObservation === true
        && inspectProviderChannelPortraitCredential(channelId, channel.configJson).credential?.version
          === TOKENHEX_PORTRAIT_CREDENTIAL_VERSION,
    });
    if (asset.state === "active" && asset.providerAssetUri) {
      if (preserveActiveBinding || (row.preferredProviderChannelId === channelId
        && row.providerSyncState === "active"
        && row.currentProviderAssetBindingId === asset.id
        && !row.safeErrorCode && !row.safeErrorMessage)) {
        return { admissionId: String(row.id), assetBindingId: String(asset.id),
          providerAssetUri: String(asset.providerAssetUri), state: "active" };
      }
      await trx(PORTRAIT_ADMISSION_TABLE).where({ id: row.id }).update({
        preferredProviderChannelId: channelId,
        providerSyncState: "active",
        currentProviderAssetBindingId: asset.id,
        safeErrorCode: null,
        safeErrorMessage: null,
        revision: Number(row.revision) + 1,
        updatedAt: now,
      });
      return {
        admissionId: String(row.id),
        assetBindingId: String(asset.id),
        providerAssetUri: String(asset.providerAssetUri),
        state: "active",
      };
    }
    if (!preserveActiveBinding) await trx(PORTRAIT_ADMISSION_TABLE).where({ id: row.id }).update({
      preferredProviderChannelId: channelId,
      providerSyncState: "processing",
      currentProviderAssetBindingId: null,
      revision: Number(row.revision) + 1,
      updatedAt: now,
    });
    return {
      admissionId: String(row.id),
      assetBindingId: String(asset.id),
      providerAssetUri: null,
      state: "processing",
    };
  });
}

function safeProviderFailure(caught: unknown): { code: string; message: string; outcomeUnknown: boolean } {
  if (caught instanceof PortraitBindingRuntimeError) {
    return { code: caught.registrationCode, message: caught.message,
      outcomeUnknown: caught.registrationCode === "VOLC_PORTRAIT_OUTCOME_UNKNOWN" };
  }
  if (caught instanceof PortraitProviderRuntimeError) {
    return { code: caught.code, message: caught.message, outcomeUnknown: false };
  }
  if (caught instanceof VolcenginePortraitAssetsError) {
    const outcomeUnknown = caught.code === "VOLC_PORTRAIT_OUTCOME_UNKNOWN"
      || caught.dispatchState === "outcome_unknown";
    return {
      code: outcomeUnknown ? "VOLC_PORTRAIT_OUTCOME_UNKNOWN" : caught.code,
      message: outcomeUnknown
        ? "上游创建结果不确定，需要管理员核对"
        : portraitRegistrationFailureMessage(caught.code) ?? "火山人像资产服务暂不可用",
      outcomeUnknown,
    };
  }
  return {
    code: "VOLC_PORTRAIT_REQUEST_FAILED",
    message: "火山人像资产服务暂不可用",
    outcomeUnknown: false,
  };
}

function failedGroupRecord(
  record: VolcenginePortraitGroupSyncRecord,
  now: number,
  code: string,
  message: string,
): VolcenginePortraitGroupSyncRecord {
  return Object.freeze({
    ...record,
    activeAt: null,
    nextAttemptAt: now,
    safeErrorCode: code,
    safeErrorMessage: message,
    state: "failed",
    updatedAt: now,
  });
}

function failedAuthRecord(
  record: VolcenginePortraitAuthSessionSyncRecord,
  now: number,
  state: "failed" | "expired",
  code: string,
  message: string,
): VolcenginePortraitAuthSessionSyncRecord {
  return Object.freeze({
    ...record,
    safeErrorCode: code,
    safeErrorMessage: message,
    state,
    updatedAt: now,
  });
}

export async function startPortraitLivenessAuthorization(input: {
  database?: Knex;
  workspaceId: string;
  projectId: number;
  assetVersionId: number;
  admissionId?: string | null;
  actorUserId: number;
  expectedRevision: number;
  identityLabel?: string | null;
  rightsConfirmed: boolean;
  environment?: Environment;
  auditContext?: Parameters<typeof writeAuditLog>[0];
  now?: () => number;
}): Promise<PortraitAuthorizationStart> {
  const database = input.database ?? db;
  const projectId = positiveInteger(input.projectId, "projectId");
  const assetVersionId = positiveInteger(input.assetVersionId, "assetVersionId");
  const actorUserId = positiveInteger(input.actorUserId, "actorUserId");
  const expectedRevision = positiveInteger(input.expectedRevision, "revision");
  if (!input.rightsConfirmed) {
    runtimeError(422, "portrait_rights_attestation_required", "必须确认已获得素材和肖像使用权");
  }
  const now = input.now ?? Date.now;
  const requestedAt = now();
  const initial = await admissionRuntimeRow({
    database,
    workspaceId: input.workspaceId,
    projectId,
    assetVersionId,
    admissionId: input.admissionId ? safeId(input.admissionId, "admissionId") : undefined,
  });
  if (Number(initial.revision) !== expectedRevision) {
    runtimeError(409, "portrait_revision_conflict", "素材状态已更新，请刷新后重试");
  }
  if (initial.subjectKind !== "real_person" || initial.identityKind !== "real_person") {
    runtimeError(409, "portrait_real_authorization_not_applicable", "该素材不是待授权真人素材");
  }
  if (portraitScopeCompliance(initial) !== "allowed") {
    runtimeError(409, "portrait_admission_pending", "素材人像准入尚未完成，不能发起真人授权");
  }
  if (Number(initial.ownerUserId) !== actorUserId) {
    runtimeError(403, "portrait_identity_owner_required", "只有人像权利确认人可以发起真人授权");
  }
  assertCurrentConsent(initial, requestedAt);
  if (initial.identityState === "active") {
    runtimeError(409, "portrait_real_authorization_complete", "该真人素材已经完成授权");
  }
  const channelId = safeId(initial.preferredProviderChannelId, "供应商通道");
  const channel = await providerChannel({ database, workspaceId: input.workspaceId, channelId });
  const scope = channelScope(channel);
  const callbackNonce = crypto.randomBytes(32).toString("base64url");
  const callbackUrl = portraitAuthorizationCallbackUrl(callbackNonce, input.environment);
  const authSessionId = uuid();
  const authIdempotencyKey = `portrait-auth-${authSessionId}`;
  let durableGroup!: Record<string, any>;
  let durableAuth!: VolcenginePortraitAuthSessionSyncRecord;

  await database.transaction(async (trx) => {
    const row = await admissionRuntimeRow({
      database: trx,
      workspaceId: input.workspaceId,
      projectId,
      assetVersionId,
      admissionId: input.admissionId ? safeId(input.admissionId, "admissionId") : undefined,
      lock: true,
    });
    if (Number(row.revision) !== expectedRevision) {
      runtimeError(409, "portrait_revision_conflict", "素材状态已更新，请刷新后重试");
    }
    if (row.subjectKind !== "real_person" || Number(row.ownerUserId) !== actorUserId) {
      runtimeError(409, "portrait_real_authorization_not_applicable", "真人授权状态已变化");
    }
    if (portraitScopeCompliance(row) !== "allowed") {
      runtimeError(409, "portrait_admission_pending", "素材人像准入尚未完成，不能发起真人授权");
    }
    assertCurrentConsent(row, requestedAt);
    const existingGroup = await ensureGroupRow({ trx, row, channel, now: requestedAt });
    if (existingGroup.state === "active") {
      runtimeError(409, "portrait_real_authorization_complete", "该真人素材已经完成授权");
    }
    await trx(PORTRAIT_AUTH_SESSION_TABLE)
      .where({ admissionId: row.id })
      .whereIn("state", ["created", "waiting_user", "verifying"])
      .update({
        state: "cancelled",
        safeErrorCode: "VOLC_PORTRAIT_AUTH_SUPERSEDED",
        safeErrorMessage: "已发起新的真人认证会话",
        updatedAt: requestedAt,
      });
    const freshGroup = markVolcenginePortraitGroupAuthorizing({
      now: requestedAt,
      record: createQueuedVolcenginePortraitGroupSync({
        groupType: "LivenessFace",
        idempotencyKey: authIdempotencyKey,
        now: Number(existingGroup.createdAt || requestedAt),
        scope,
      }),
    });
    durableAuth = createVolcenginePortraitAuthSessionRecord({
      callbackNonce,
      expiresAt: requestedAt + AUTH_TTL_MS,
      now: requestedAt,
      scope,
    });
    await trx(PORTRAIT_PROVIDER_GROUP_TABLE).where({ id: existingGroup.id }).update({
      ...groupWrite(freshGroup),
      idempotencyKey: authIdempotencyKey,
      providerGroupId: null,
      leaseOwner: workerOwner,
      leaseExpiresAt: requestedAt + WORKER_LEASE_MS,
    });
    await trx(PORTRAIT_AUTH_SESSION_TABLE).insert({
      id: authSessionId,
      workspaceId: row.workspaceId,
      admissionId: row.id,
      identityId: row.identityId,
      groupBindingId: existingGroup.id,
      channelId,
      state: durableAuth.state,
      callbackNonceHash: durableAuth.callbackNonceHash,
      providerSessionId: null,
      bytedTokenDigest: null,
      expiresAt: durableAuth.expiresAt,
      consumedAt: null,
      resultReceivedAt: null,
      safeErrorCode: null,
      safeErrorMessage: null,
      createdAt: requestedAt,
      updatedAt: requestedAt,
    });
    const identityLabel = cleanString(input.identityLabel, 120);
    await trx(PORTRAIT_IDENTITY_TABLE).where({ id: row.identityId }).update({
      ...(identityLabel ? { label: identityLabel } : {}),
      state: "authorizing",
      revision: Number(row.identityRevision || 1) + 1,
      updatedAt: requestedAt,
    });
    await trx(PORTRAIT_ADMISSION_TABLE).where({ id: row.id }).update({
      providerSyncState: "authorizing",
      safeErrorCode: null,
      safeErrorMessage: null,
      revision: Number(row.revision) + 1,
      updatedAt: requestedAt,
    });
    await writeAuditLog(input.auditContext ?? null, {
      workspaceId: input.workspaceId,
      action: "portrait.authorization.request",
      resourceType: "portrait_auth_session",
      resourceId: authSessionId,
      required: true,
      actor: { actorUserId, actorKind: "user" },
      metadata: { admissionId: row.id, assetVersionId, channelId },
    }, trx);
    durableGroup = { ...existingGroup, ...groupWrite(freshGroup), idempotencyKey: authIdempotencyKey };
  });

  let providerSessionIssued = false;
  try {
    const session = await withPortraitClient({
      database,
      channel,
      workspaceId: input.workspaceId,
      actorUserId,
      operation: (client) => client.createVisualValidateSession({
        callbackUrl,
        idempotencyKey: authIdempotencyKey,
      }),
    });
    providerSessionIssued = true;
    const completedAt = now();
    // The provider sets its 30-minute deadline at response time. Adjust only
    // the durable deadline/digest; H5Link and raw BytedToken remain in memory.
    const startedAuth = applyVolcenginePortraitAuthSessionCreated({
      now: completedAt,
      record: Object.freeze({ ...durableAuth, expiresAt: session.expiresAt }),
      session,
    });
    await database.transaction(async (trx) => {
      const auth = await trx(PORTRAIT_AUTH_SESSION_TABLE).where({ id: authSessionId }).forUpdate().first();
      const group = await trx(PORTRAIT_PROVIDER_GROUP_TABLE).where({ id: durableGroup.id }).forUpdate().first();
      if (!auth || auth.state !== "created" || !group || group.idempotencyKey !== authIdempotencyKey) {
        runtimeError(409, "portrait_authorization_superseded", "真人认证会话已被新的操作替代");
      }
      await trx(PORTRAIT_AUTH_SESSION_TABLE).where({ id: authSessionId }).update({
        ...authWrite(startedAuth),
        expiresAt: startedAuth.expiresAt,
      });
      await trx(PORTRAIT_PROVIDER_GROUP_TABLE).where({ id: group.id }).update({
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: completedAt,
      });
      await writeAuditLog(input.auditContext ?? null, {
        workspaceId: input.workspaceId,
        action: "portrait.authorization.h5_issued",
        resourceType: "portrait_auth_session",
        resourceId: authSessionId,
        required: true,
        actor: { actorUserId, actorKind: "user" },
        metadata: { admissionId: initial.id, expiresAt: session.expiresAt },
      }, trx);
    });
    const admission = await readPortraitAdmission({
      database,
      workspaceId: input.workspaceId,
      projectId,
      assetVersionId,
    });
    if (!admission) runtimeError(500, "portrait_admission_missing_after_write", "素材准入记录读取失败");
    return { admission, authorizationUrl: session.h5Link, expiresAt: session.expiresAt };
  } catch (caught) {
    const failedAt = now();
    const baseFailure = safeProviderFailure(caught);
    const failure = providerSessionIssued
      ? {
        code: "VOLC_PORTRAIT_OUTCOME_UNKNOWN",
        message: "真人认证会话已由上游创建，但本地登记未完成，需要管理员核对",
        outcomeUnknown: true,
      }
      : baseFailure;
    let operationStillOwned = false;
    await database.transaction(async (trx) => {
      const auth = await trx(PORTRAIT_AUTH_SESSION_TABLE).where({ id: authSessionId }).forUpdate().first();
      const group = await trx(PORTRAIT_PROVIDER_GROUP_TABLE).where({ id: durableGroup.id }).forUpdate().first();
      operationStillOwned = Boolean(
        auth
        && auth.state === "created"
        && group
        && group.idempotencyKey === authIdempotencyKey
        && group.state === "authorizing",
      );
      if (!operationStillOwned) return;
      if (auth) {
        const failedAuth = failedAuthRecord(
          authRecord(auth, scope),
          failedAt,
          "failed",
          failure.code,
          failure.message,
        );
        await trx(PORTRAIT_AUTH_SESSION_TABLE).where({ id: authSessionId }).update(authWrite(failedAuth));
      }
      if (group) {
        await trx(PORTRAIT_PROVIDER_GROUP_TABLE).where({ id: group.id }).update({
          ...groupWrite(failedGroupRecord(groupRecord(group, scope), failedAt, failure.code, failure.message)),
          leaseOwner: null,
          leaseExpiresAt: null,
        });
      }
      await trx(PORTRAIT_IDENTITY_TABLE).where({ id: initial.identityId }).update({
        state: "pending",
        updatedAt: failedAt,
      });
      await trx(PORTRAIT_ADMISSION_TABLE).where({ id: initial.id }).update({
        providerSyncState: "authorizing",
        safeErrorCode: failure.code,
        safeErrorMessage: failure.message,
        revision: trx.raw('"revision" + 1'),
        updatedAt: failedAt,
      });
      await writeAuditLog(input.auditContext ?? null, {
        workspaceId: input.workspaceId,
        action: "portrait.authorization.failed",
        resourceType: "portrait_auth_session",
        resourceId: authSessionId,
        required: true,
        actor: { actorUserId, actorKind: "user" },
        metadata: { admissionId: initial.id, errorCode: failure.code, outcomeUnknown: failure.outcomeUnknown },
      }, trx);
    });
    if (!operationStillOwned) {
      if (caught instanceof PortraitProviderRuntimeError) throw caught;
      runtimeError(409, "portrait_authorization_superseded", "真人认证会话已被新的操作替代");
    }
    runtimeError(503, failure.code, failure.message);
  }
}

function callbackParameters(input: {
  callbackNonce: string;
  bytedToken: string;
  resultCode: string;
  algorithmBaseRespCode?: string | null;
  reqMeasureInfoValue?: string | null;
  verifyType?: string | null;
  environment?: Environment;
}): { callbackUrl: string; expectedCallbackUrl: string } {
  const expectedCallbackUrl = portraitAuthorizationCallbackUrl(input.callbackNonce, input.environment);
  const callback = new URL(expectedCallbackUrl);
  callback.searchParams.set("bytedToken", input.bytedToken);
  callback.searchParams.set("resultCode", input.resultCode);
  if (input.algorithmBaseRespCode) callback.searchParams.set("algorithmBaseRespCode", input.algorithmBaseRespCode);
  if (input.reqMeasureInfoValue) callback.searchParams.set("reqMeasureInfoValue", input.reqMeasureInfoValue);
  if (input.verifyType) callback.searchParams.set("verify_type", input.verifyType);
  return { callbackUrl: callback.toString(), expectedCallbackUrl };
}

export async function completePortraitLivenessCallback(input: {
  database?: Knex;
  callbackNonce: string;
  bytedToken: string;
  resultCode: string;
  algorithmBaseRespCode?: string | null;
  reqMeasureInfoValue?: string | null;
  verifyType?: string | null;
  environment?: Environment;
  now?: () => number;
}): Promise<PortraitAuthorizationCallbackResult> {
  const database = input.database ?? db;
  const callbackNonce = safeId(input.callbackNonce, "callback nonce");
  const bytedToken = cleanString(input.bytedToken, 4_096);
  if (!bytedToken) runtimeError(400, "portrait_callback_invalid", "真人认证回调缺少有效令牌");
  const resultCode = cleanString(input.resultCode, 16);
  if (!/^\d{1,16}$/u.test(resultCode)) {
    runtimeError(400, "portrait_callback_invalid", "真人认证回调结果无效");
  }
  const now = input.now ?? Date.now;
  const receivedAt = now();
  const nonceHash = volcenginePortraitCallbackNonceHash(callbackNonce);
  const tokenDigest = volcenginePortraitBytedTokenDigest(bytedToken);
  const row = await database(`${PORTRAIT_AUTH_SESSION_TABLE} as auth`)
    .innerJoin(`${PORTRAIT_PROVIDER_GROUP_TABLE} as providerGroup`, "providerGroup.id", "auth.groupBindingId")
    .innerJoin(`${PORTRAIT_ADMISSION_TABLE} as admission`, "admission.id", "auth.admissionId")
    .innerJoin(`${PORTRAIT_IDENTITY_TABLE} as identity`, "identity.id", "auth.identityId")
    .innerJoin("o_provider_channel as channel", "channel.id", "auth.channelId")
    .where("auth.callbackNonceHash", nonceHash)
    .select(
      "auth.*",
      "providerGroup.state as groupState",
      "providerGroup.groupType",
      "providerGroup.providerGroupId",
      "providerGroup.idempotencyKey",
      "providerGroup.retryCount",
      "providerGroup.nextAttemptAt",
      "providerGroup.activeAt",
      "providerGroup.createdAt as groupCreatedAt",
      "providerGroup.updatedAt as groupUpdatedAt",
      "providerGroup.safeErrorCode as groupSafeErrorCode",
      "providerGroup.safeErrorMessage as groupSafeErrorMessage",
      "providerGroup.id as providerGroupBindingId",
      "admission.projectId",
      "admission.assetVersionId",
      "admission.revision as admissionRevision",
      "admission.moderationState",
      "admission.complianceState",
      "identity.ownerUserId",
      "channel.configJson",
      "channel.credentialRef",
      "channel.provider",
      "channel.endpointType",
      "channel.disabled",
      "channel.scope",
      "channel.workspaceId as channelWorkspaceId",
    )
    .first();
  if (!row) runtimeError(404, "portrait_callback_not_found", "真人认证回调会话不存在");
  // Authenticate every callback replay before revealing terminal state. A
  // completed nonce is not itself bearer authority; only the original
  // short-lived BytedToken may receive an idempotent success response.
  if (!row.bytedTokenDigest || !sameDigest(String(row.bytedTokenDigest), tokenDigest)) {
    runtimeError(403, "portrait_callback_token_mismatch", "真人认证回调证据不匹配");
  }
  if (row.state !== "waiting_user") {
    if (row.state === "succeeded") {
      return { admissionId: String(row.admissionId), assetVersionId: Number(row.assetVersionId), state: "succeeded" };
    }
    runtimeError(409, "portrait_callback_state_invalid", "真人认证会话已结束或已被替代");
  }
  const channel = await providerChannel({
    database,
    workspaceId: String(row.workspaceId),
    channelId: String(row.channelId),
  });
  const scope = channelScope(channel);
  const auth = authRecord(row, scope);
  const group = groupRecord({
    state: row.groupState,
    groupType: row.groupType,
    providerGroupId: row.providerGroupId,
    idempotencyKey: row.idempotencyKey,
    retryCount: row.retryCount,
    nextAttemptAt: row.nextAttemptAt,
    activeAt: row.activeAt,
    createdAt: row.groupCreatedAt,
    updatedAt: row.groupUpdatedAt,
    safeErrorCode: row.groupSafeErrorCode,
    safeErrorMessage: row.groupSafeErrorMessage,
  }, scope);
  const { callbackUrl, expectedCallbackUrl } = callbackParameters({ ...input, callbackNonce, bytedToken, resultCode });
  const session: VolcengineVisualValidateSession = Object.freeze({
    bytedToken,
    callbackUrl: expectedCallbackUrl,
    expiresAt: auth.expiresAt,
    h5Link: "https://ark.volcengine.com/",
    idempotencyKey: group.idempotencyKey,
    issuedAt: auth.createdAt,
    scope,
  });
  let callbackApplied: ReturnType<typeof applyVolcenginePortraitAuthCallback>;
  try {
    callbackApplied = applyVolcenginePortraitAuthCallback({
      callbackNonce,
      callbackUrl,
      now: receivedAt,
      record: auth,
      session,
    });
  } catch (caught) {
    if (caught instanceof VolcenginePortraitAssetsError) {
      runtimeError(400, caught.code, caught.message);
    }
    throw caught;
  }

  if (callbackApplied.record.state !== "verifying") {
    const terminal = callbackApplied.record.state === "expired" ? "expired" : "failed";
    await database.transaction(async (trx) => {
      const changed = await trx(PORTRAIT_AUTH_SESSION_TABLE)
        .where({ id: row.id, state: "waiting_user", callbackNonceHash: nonceHash })
        .update(authWrite(callbackApplied.record));
      if (Number(changed) !== 1) runtimeError(409, "portrait_callback_state_invalid", "真人认证会话已变化");
      const failureCode = callbackApplied.record.safeErrorCode ?? "VOLC_PORTRAIT_VISUAL_VALIDATE_FAILED";
      await trx(PORTRAIT_PROVIDER_GROUP_TABLE).where({ id: row.providerGroupBindingId }).update({
        ...groupWrite(failedGroupRecord(group, receivedAt, failureCode, "真人认证未通过")),
        leaseOwner: null,
        leaseExpiresAt: null,
      });
      await trx(PORTRAIT_IDENTITY_TABLE).where({ id: row.identityId }).update({ state: "pending", updatedAt: receivedAt });
      await trx(PORTRAIT_ADMISSION_TABLE).where({
        id: row.admissionId,
        workspaceId: row.workspaceId,
        identityId: row.identityId,
        preferredProviderChannelId: row.channelId,
      }).update({
        providerSyncState: "authorizing",
        safeErrorCode: failureCode,
        safeErrorMessage: terminal === "expired" ? "真人认证会话已过期" : "真人认证未通过",
        revision: trx.raw('"revision" + 1'),
        updatedAt: receivedAt,
      });
      await writeAuditLog({ workspaceId: String(row.workspaceId), actor: { actorKind: "system" } }, {
        workspaceId: String(row.workspaceId),
        action: "portrait.authorization.callback_failed",
        resourceType: "portrait_auth_session",
        resourceId: row.id,
        required: true,
        actor: { actorKind: "system" },
        metadata: { admissionId: row.admissionId, errorCode: failureCode },
      }, trx);
    });
    return { admissionId: String(row.admissionId), assetVersionId: Number(row.assetVersionId), state: terminal };
  }

  await database.transaction(async (trx) => {
    const changed = await trx(PORTRAIT_AUTH_SESSION_TABLE)
      .where({ id: row.id, state: "waiting_user", callbackNonceHash: nonceHash })
      .update(authWrite(callbackApplied.record));
    if (Number(changed) !== 1) runtimeError(409, "portrait_callback_state_invalid", "真人认证会话已变化");
    await writeAuditLog({ workspaceId: String(row.workspaceId), actor: { actorKind: "system" } }, {
      workspaceId: String(row.workspaceId),
      action: "portrait.authorization.callback_verified",
      resourceType: "portrait_auth_session",
      resourceId: row.id,
      required: true,
      actor: { actorKind: "system" },
      metadata: { admissionId: row.admissionId },
    }, trx);
  });

  let providerGroupObserved = false;
  try {
    const providerGroup = await withPortraitClient({
      database,
      channel,
      workspaceId: String(row.workspaceId),
      actorUserId: Number(row.ownerUserId),
      operation: (client) => client.getVisualValidateResult({ session }),
    });
    providerGroupObserved = true;
    const completedAt = now();
    const completedAuth = applyVolcenginePortraitAuthSucceeded({
      group: providerGroup,
      now: completedAt,
      record: callbackApplied.record,
    });
    const activeGroup = applyVolcenginePortraitGroupActive({
      group: providerGroup,
      now: completedAt,
      record: group,
    });
    let shouldQueueProviderAsset = false;
    await database.transaction(async (trx) => {
      const currentAuth = await trx(PORTRAIT_AUTH_SESSION_TABLE).where({ id: row.id }).forUpdate().first();
      const currentGroup = await trx(PORTRAIT_PROVIDER_GROUP_TABLE).where({ id: row.providerGroupBindingId }).forUpdate().first();
      const currentAdmission = await trx(PORTRAIT_ADMISSION_TABLE)
        .where({ id: row.admissionId, workspaceId: row.workspaceId })
        .forUpdate()
        .first();
      if (!currentAuth || currentAuth.state !== "verifying" || !currentGroup || currentGroup.state !== "authorizing") {
        runtimeError(409, "portrait_callback_state_invalid", "真人认证结果已被处理");
      }
      if (!currentAdmission) {
        runtimeError(409, "portrait_callback_state_invalid", "真人认证关联素材已不存在");
      }
      await trx(PORTRAIT_AUTH_SESSION_TABLE).where({ id: row.id }).update(authWrite(completedAuth));
      await trx(PORTRAIT_PROVIDER_GROUP_TABLE).where({ id: row.providerGroupBindingId }).update({
        ...groupWrite(activeGroup),
        leaseOwner: null,
        leaseExpiresAt: null,
      });
      await trx(PORTRAIT_IDENTITY_TABLE).where({ id: row.identityId }).update({
        state: "active",
        revision: trx.raw('"revision" + 1'),
        updatedAt: completedAt,
      });
      const stillOwnsAdmission = String(currentAdmission.identityId || "") === String(row.identityId)
        && String(currentAdmission.preferredProviderChannelId || "") === String(row.channelId)
        && currentAdmission.subjectKind === "real_person";
      let consentStillActive = false;
      if (stillOwnsAdmission && currentAdmission.currentConsentId) {
        const currentConsent = await trx(PORTRAIT_CONSENT_TABLE).where({
          id: currentAdmission.currentConsentId,
          workspaceId: row.workspaceId,
          admissionId: row.admissionId,
          identityId: row.identityId,
          status: "active",
        }).first();
        consentStillActive = Boolean(
          currentConsent
          && (!currentConsent.expiresAt || Number(currentConsent.expiresAt) > completedAt),
        );
      }
      shouldQueueProviderAsset = stillOwnsAdmission
        && consentStillActive
        && portraitScopeCompliance(currentAdmission) === "allowed";
      // Never overwrite a concurrently replaced identity/channel binding. If
      // the admission still owns this authorization, derive its next state
      // from the locked current row rather than the pre-provider snapshot.
      if (stillOwnsAdmission) {
        await trx(PORTRAIT_ADMISSION_TABLE).where({ id: row.admissionId }).update({
          providerSyncState: shouldQueueProviderAsset ? "queued" : "not_needed",
          safeErrorCode: null,
          safeErrorMessage: null,
          revision: trx.raw('"revision" + 1'),
          updatedAt: completedAt,
        });
      }
      await writeAuditLog({ workspaceId: String(row.workspaceId), actor: { actorKind: "system" } }, {
        workspaceId: String(row.workspaceId),
        action: "portrait.authorization.succeeded",
        resourceType: "portrait_provider_group",
        resourceId: row.providerGroupBindingId,
        required: true,
        actor: { actorKind: "system" },
        metadata: { admissionId: row.admissionId, groupType: "LivenessFace" },
      }, trx);
    });
    if (shouldQueueProviderAsset) {
      // Authorization is already durable at this point. A queueing hiccup must
      // not roll a successful liveness result back; the worker materializer
      // will retry this idempotently from admission.providerSyncState=queued.
      try {
        await ensurePortraitProviderBindingQueued({
          database,
          workspaceId: String(row.workspaceId),
          projectId: Number(row.projectId),
          assetVersionId: Number(row.assetVersionId),
          channelId: String(row.channelId),
          now: completedAt,
        });
      } catch {
        // Fail closed: the admission remains queued and is not usable until an
        // Active provider asset binding is materialized.
      }
    }
    return { admissionId: String(row.admissionId), assetVersionId: Number(row.assetVersionId), state: "succeeded" };
  } catch (caught) {
    const failedAt = now();
    const baseFailure = safeProviderFailure(caught);
    const failure = providerGroupObserved
      ? {
        code: "VOLC_PORTRAIT_OUTCOME_UNKNOWN",
        message: "真人素材组结果已返回，但本地登记未完成，需要管理员核对",
        outcomeUnknown: true,
      }
      : baseFailure;
    await database.transaction(async (trx) => {
      const currentAuth = await trx(PORTRAIT_AUTH_SESSION_TABLE).where({ id: row.id }).forUpdate().first();
      if (currentAuth?.state === "verifying") {
        await trx(PORTRAIT_AUTH_SESSION_TABLE).where({ id: row.id }).update(authWrite(failedAuthRecord(
          authRecord(currentAuth, scope),
          failedAt,
          "failed",
          failure.code,
          failure.message,
        )));
      }
      await trx(PORTRAIT_PROVIDER_GROUP_TABLE).where({ id: row.providerGroupBindingId, state: "authorizing" }).update({
        ...groupWrite(failedGroupRecord(group, failedAt, failure.code, failure.message)),
        leaseOwner: null,
        leaseExpiresAt: null,
      });
      await trx(PORTRAIT_IDENTITY_TABLE).where({ id: row.identityId }).update({ state: "pending", updatedAt: failedAt });
      await trx(PORTRAIT_ADMISSION_TABLE).where({
        id: row.admissionId,
        workspaceId: row.workspaceId,
        identityId: row.identityId,
        preferredProviderChannelId: row.channelId,
      }).update({
        providerSyncState: "authorizing",
        safeErrorCode: failure.code,
        safeErrorMessage: failure.message,
        revision: trx.raw('"revision" + 1'),
        updatedAt: failedAt,
      });
      await writeAuditLog({ workspaceId: String(row.workspaceId), actor: { actorKind: "system" } }, {
        workspaceId: String(row.workspaceId),
        action: "portrait.authorization.result_failed",
        resourceType: "portrait_auth_session",
        resourceId: row.id,
        required: true,
        actor: { actorKind: "system" },
        metadata: { admissionId: row.admissionId, errorCode: failure.code },
      }, trx);
    });
    runtimeError(503, failure.code, failure.message);
  }
}

function assetRequest(input: {
  row: Record<string, any>;
  group: VolcenginePortraitAssetGroupRef;
  sourceUrl: string;
}): VolcenginePortraitAssetSubmitInput {
  return Object.freeze({
    assetType: input.row.mediaType === "video" ? "Video" : "Image",
    group: input.group,
    idempotencyKey: String(input.row.idempotencyKey),
    name: cleanString(input.row.identityLabel, 64) || undefined,
    sourceSha256: String(input.row.sourceSha256),
    url: input.sourceUrl,
  });
}

function assetRecord(
  row: Record<string, any>,
  group: VolcenginePortraitAssetGroupRef,
): VolcenginePortraitAssetSyncRecord {
  const seed = createQueuedVolcenginePortraitAssetSync({
    now: Number(row.createdAt),
    policy: { timeoutMs: ASSET_TIMEOUT_MS },
    request: assetRequest({
      row,
      group,
      sourceUrl: "https://placeholder.invalid/authoritative-object",
    }),
  });
  return Object.freeze({
    ...seed,
    activeAt: row.activeAt == null ? null : Number(row.activeAt),
    asset: row.providerAssetId ? Object.freeze({
      assetId: String(row.providerAssetId),
      assetType: row.mediaType === "video" ? "Video" : "Image",
      createdAt: Number(row.createdAt),
      group,
      idempotencyKey: String(row.idempotencyKey),
      sourceSha256: String(row.sourceSha256),
      scope: group.scope,
    }) : null,
    nextAttemptAt: Number(row.nextAttemptAt),
    providerAssetUri: row.providerAssetUri == null ? null : String(row.providerAssetUri),
    retryCount: Number(row.retryCount || 0),
    safeErrorCode: row.safeErrorCode == null ? null : String(row.safeErrorCode),
    safeErrorMessage: row.safeErrorMessage == null ? null : String(row.safeErrorMessage),
    state: row.state,
    updatedAt: Number(row.updatedAt),
  });
}

function assetWrite(record: VolcenginePortraitAssetSyncRecord): Record<string, unknown> {
  return {
    state: record.state,
    providerAssetId: record.asset?.assetId ?? null,
    providerAssetUri: record.providerAssetUri,
    retryCount: record.retryCount,
    nextAttemptAt: record.nextAttemptAt,
    safeErrorCode: record.safeErrorCode,
    safeErrorMessage: record.safeErrorMessage,
    activeAt: record.activeAt,
    updatedAt: record.updatedAt,
  };
}

// Registration reconciliation must not erase a separate generation refusal.
function whereNoGenerationRefusal(query: Knex.QueryBuilder, prefix = ""): void {
  const column = prefix ? `${prefix}.safeErrorCode` : "safeErrorCode";
  query.where(builder => builder.whereNull(column).orWhere(allowed => allowed
    .whereNotIn(column, [UPSTREAM_REAL_PERSON_REJECTION, "CONTENT_REJECTED", "CONTENT_REVIEW_REJECTED", "VOLC_PORTRAIT_ASSET_REJECTED"])
    .whereRaw("UPPER(??) NOT LIKE ?", [column, "INPUTIMAGESENSITIVECONTENTDETECTED%"])
    .whereRaw("UPPER(??) NOT LIKE ?", [column, "INPUTVIDEOSENSITIVECONTENTDETECTED%"])));
}

async function reconcileUnknownMutations(database: Knex, now: number): Promise<number> {
  let reconciled = 0;
  await database.transaction(async (trx) => {
    const authSessions = await trx(PORTRAIT_AUTH_SESSION_TABLE)
      .where((builder) => builder
        .where((created) => created
          .where("state", "created")
          .where("updatedAt", "<", now - STALE_MUTATION_MS))
        .orWhere((waiting) => waiting
          .where("state", "waiting_user")
          .where("expiresAt", "<=", now))
        .orWhere((verifying) => verifying
          .where("state", "verifying")
          .where("updatedAt", "<", now - STALE_MUTATION_MS)))
      .forUpdate()
      .limit(WORKER_BATCH);
    for (const auth of authSessions) {
      const interruptedMutation = auth.state === "created";
      const expired = auth.state === "waiting_user";
      const errorCode = interruptedMutation
        ? "VOLC_PORTRAIT_OUTCOME_UNKNOWN"
        : expired
          ? "VOLC_PORTRAIT_BYTED_TOKEN_EXPIRED"
          : "VOLC_PORTRAIT_AUTH_RESULT_INTERRUPTED";
      const errorMessage = interruptedMutation
        ? "上游真人认证会话创建结果不确定，需要管理员核对"
        : expired
          ? "真人认证会话已过期，请重新发起"
          : "真人认证结果处理已中断，请重新发起";
      await trx(PORTRAIT_AUTH_SESSION_TABLE).where({ id: auth.id, state: auth.state }).update({
        state: expired ? "expired" : "failed",
        safeErrorCode: errorCode,
        safeErrorMessage: errorMessage,
        updatedAt: now,
      });
      await trx(PORTRAIT_PROVIDER_GROUP_TABLE).where({ id: auth.groupBindingId, state: "authorizing" }).update({
        state: "failed",
        providerGroupId: null,
        activeAt: null,
        safeErrorCode: errorCode,
        safeErrorMessage: errorMessage,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: now,
      });
      await trx(PORTRAIT_IDENTITY_TABLE).where({ id: auth.identityId }).update({
        state: "pending",
        revision: trx.raw('"revision" + 1'),
        updatedAt: now,
      });
      await trx(PORTRAIT_ADMISSION_TABLE).modify(whereNoGenerationRefusal).where({ id: auth.admissionId }).update({
        providerSyncState: "authorizing",
        safeErrorCode: errorCode,
        safeErrorMessage: errorMessage,
        revision: trx.raw('"revision" + 1'),
        updatedAt: now,
      });
      await writeAuditLog({ workspaceId: auth.workspaceId, actor: { actorKind: "worker" } }, {
        workspaceId: auth.workspaceId,
        action: interruptedMutation
          ? "portrait.authorization.outcome_unknown"
          : expired
            ? "portrait.authorization.expired"
            : "portrait.authorization.interrupted",
        resourceType: "portrait_auth_session",
        resourceId: auth.id,
        required: true,
        actor: { actorKind: "worker" },
        metadata: { admissionId: auth.admissionId, replayed: false },
      }, trx);
      reconciled += 1;
    }
    const groups = await trx(PORTRAIT_PROVIDER_GROUP_TABLE)
      .where("state", "creating")
      .andWhere((builder) => builder
        .whereNull("leaseExpiresAt")
        .orWhere("leaseExpiresAt", "<", now))
      .where("updatedAt", "<", now - STALE_MUTATION_MS)
      .forUpdate()
      .limit(WORKER_BATCH);
    for (const group of groups) {
      await trx(PORTRAIT_PROVIDER_GROUP_TABLE).where({ id: group.id, state: "creating" }).update({
        state: "failed",
        safeErrorCode: "VOLC_PORTRAIT_OUTCOME_UNKNOWN",
        safeErrorMessage: "上游素材组创建结果不确定，需要管理员核对",
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: now,
      });
      await trx(PORTRAIT_ADMISSION_TABLE).modify(whereNoGenerationRefusal).where({ identityId: group.identityId, preferredProviderChannelId: group.channelId }).update({
        providerSyncState: "failed",
        safeErrorCode: "VOLC_PORTRAIT_OUTCOME_UNKNOWN",
        safeErrorMessage: "上游素材组创建结果不确定，需要管理员核对",
        revision: trx.raw('"revision" + 1'),
        updatedAt: now,
      });
      await writeAuditLog({ workspaceId: group.workspaceId, actor: { actorKind: "worker" } }, {
        workspaceId: group.workspaceId,
        action: "portrait.provider_group.outcome_unknown",
        resourceType: "portrait_provider_group",
        resourceId: group.id,
        required: true,
        actor: { actorKind: "worker" },
        metadata: { replayed: false },
      }, trx);
      reconciled += 1;
    }
    const assets = await trx(PORTRAIT_PROVIDER_ASSET_TABLE)
      .where("state", "submitting")
      .andWhere((builder) => builder
        .whereNull("leaseExpiresAt")
        .orWhere("leaseExpiresAt", "<", now))
      .where("updatedAt", "<", now - STALE_MUTATION_MS)
      .forUpdate()
      .limit(WORKER_BATCH);
    for (const asset of assets) {
      await trx(PORTRAIT_PROVIDER_ASSET_TABLE).where({ id: asset.id, state: "submitting" }).update({
        state: "failed",
        providerAssetId: null,
        providerAssetUri: null,
        activeAt: null,
        safeErrorCode: "VOLC_PORTRAIT_OUTCOME_UNKNOWN",
        safeErrorMessage: "上游素材创建结果不确定，需要管理员核对",
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: now,
      });
      await trx(PORTRAIT_ADMISSION_TABLE).modify(whereNoGenerationRefusal).where({ id: asset.admissionId, preferredProviderChannelId: asset.channelId }).update({
        providerSyncState: "failed",
        currentProviderAssetBindingId: null,
        safeErrorCode: "VOLC_PORTRAIT_OUTCOME_UNKNOWN",
        safeErrorMessage: "上游素材创建结果不确定，需要管理员核对",
        revision: trx.raw('"revision" + 1'),
        updatedAt: now,
      });
      await writeAuditLog({ workspaceId: asset.workspaceId, actor: { actorKind: "worker" } }, {
        workspaceId: asset.workspaceId,
        action: "portrait.provider_asset.outcome_unknown",
        resourceType: "portrait_provider_asset",
        resourceId: asset.id,
        required: true,
        actor: { actorKind: "worker" },
        metadata: { admissionId: asset.admissionId, replayed: false },
      }, trx);
      reconciled += 1;
    }
  });
  return reconciled;
}

/** Recover declarations made by older MCP clients without a provider channel.
 * This routes an existing user attestation; it never creates a declaration. */
export async function bindUnroutedDeclaredPortraits(database: Knex, now: number): Promise<number> {
  const rows = await database(PORTRAIT_ADMISSION_TABLE)
    .where({ declarationState: "confirmed", providerSyncState: "queued" })
    .whereIn("subjectKind", ["virtual_person", "trusted_output"])
    .whereNull("preferredProviderChannelId").whereNotNull("identityId")
    .modify(wherePortraitScopeEligible).modify(whereNoGenerationRefusal)
    .orderBy("updatedAt", "asc").limit(WORKER_BATCH)
    .select("id", "workspaceId", "identityId", "revision");
  let bound = 0;
  for (const row of rows) {
    try {
      const channelId = await preferredVolcanoPortraitChannel({ database, workspaceId: row.workspaceId });
      if (!channelId) runtimeError(503, "portrait_provider_channel_unavailable", "素材登记通道暂不可用，平台将自动重试");
      bound += await database(PORTRAIT_ADMISSION_TABLE)
        .where({ id: row.id, revision: row.revision, identityId: row.identityId,
          declarationState: "confirmed", providerSyncState: "queued" })
        .whereNull("preferredProviderChannelId")
        .update({ preferredProviderChannelId: channelId, safeErrorCode: null, safeErrorMessage: null,
          revision: database.raw('"revision" + 1'), updatedAt: now });
    } catch (caught) {
      const failure = safeProviderFailure(caught);
      await database(PORTRAIT_ADMISSION_TABLE).where({ id: row.id, revision: row.revision })
        .whereNull("preferredProviderChannelId").update({ safeErrorCode: failure.code,
          safeErrorMessage: failure.message, revision: Number(row.revision) + 1, updatedAt: now });
      logger.warn({ worker: "portrait-provider", admissionId: row.id, code: failure.code },
        "Portrait registration channel selection failed");
    }
  }
  return bound;
}

export async function materializeQueuedAdmissions(database: Knex, now: number): Promise<number> {
  const rows = await database(`${PORTRAIT_ADMISSION_TABLE} as admission`)
    .innerJoin(`${PORTRAIT_IDENTITY_TABLE} as identity`, "identity.id", "admission.identityId")
    .where({
      "admission.sourceRecoveryState": "ready",
    })
    .modify(wherePortraitScopeEligible, "admission")
        .modify(whereNoGenerationRefusal, "admission")
    .whereNotNull("admission.sourceSha256")
    .where((progress) => progress
      .whereIn("admission.providerSyncState", ["queued", "creating_group", "processing"])
      .orWhere((retired) => retired.where("admission.providerSyncState", "failed")
        .where((error) => error.whereLike("admission.safeErrorCode", "PORTRAIT_MODERATION_%")
          .orWhereLike("admission.safeErrorCode", "IMAGEX_VIDEO_%"))))
    .whereNotNull("admission.preferredProviderChannelId")
    .where((due) => due.whereNull("admission.safeErrorCode")
      .orWhereLike("admission.safeErrorCode", "PORTRAIT_MODERATION_%")
      .orWhereLike("admission.safeErrorCode", "IMAGEX_VIDEO_%")
      .orWhere("admission.updatedAt", "<=", now - MATERIALIZATION_RETRY_MS))
    .where((builder) => builder
      .whereIn("admission.subjectKind", ["virtual_person", "trusted_output", "detected_person"])
      .orWhere((real) => real
        .where("admission.subjectKind", "real_person")
        .where("identity.state", "active")))
    .orderBy("admission.updatedAt", "asc")
    .orderBy("admission.id", "asc")
    .limit(WORKER_BATCH)
    .select({
      id: "admission.id",
      revision: "admission.revision",
      identityId: "admission.identityId",
      workspaceId: "admission.workspaceId",
      projectId: "admission.projectId",
      assetVersionId: "admission.assetVersionId",
      preferredProviderChannelId: "admission.preferredProviderChannelId",
    });
  // A route requested after initial registration must progress even while the
  // admission retains another Active binding. Do not revisit already materialized
  // assets; their own worker/state machine owns retry and uncertain outcomes.
  const additional = await database(`${PORTRAIT_PROVIDER_GROUP_TABLE} as providerGroup`)
    .innerJoin(`${PORTRAIT_ADMISSION_TABLE} as admission`, "admission.identityId", "providerGroup.identityId")
    .innerJoin(`${PORTRAIT_IDENTITY_TABLE} as identity`, "identity.id", "admission.identityId")
    .leftJoin(`${PORTRAIT_CONSENT_TABLE} as consent`, "consent.id", "admission.currentConsentId")
    .innerJoin("o_provider_channel as channel", "channel.id", "providerGroup.channelId")
    .innerJoin("o_image as version", "version.id", "admission.assetVersionId")
    .innerJoin("o_assets as asset", "asset.id", "version.assetsId")
    .innerJoin("o_project as project", "project.id", "asset.projectId")
    .where({
      "providerGroup.state": "active",
      "admission.providerSyncState": "active",
      "admission.sourceRecoveryState": "ready",
      "identity.state": "active",
      "channel.provider": "volcano",
      "channel.endpointType": "video_generation",
      "channel.disabled": 0,
      "version.deletionState": "active",
      "asset.deletionState": "active",
      "project.deletionState": "active",
    })
    .modify(wherePortraitScopeEligible, "admission")
        .modify(whereNoGenerationRefusal, "admission")
    .whereRaw("?? = ??", ["providerGroup.workspaceId", "admission.workspaceId"])
    .whereRaw("?? = ??", ["project.workspaceId", "admission.workspaceId"])
    .whereRaw("?? <> ??", ["providerGroup.channelId", "admission.preferredProviderChannelId"])
    .where((scope) => scope
      .where((platform) => platform.where("channel.scope", "platform").whereNull("channel.workspaceId"))
      .orWhere((workspace) => workspace.where("channel.scope", "workspace")
        .whereRaw("?? = ??", ["channel.workspaceId", "admission.workspaceId"])))
    .where((eligibility) => eligibility
      .where((automatic) => automatic.where("admission.subjectKind", "detected_person")
        .where("admission.declarationState", "not_required").whereNull("admission.currentConsentId"))
      .orWhere((declared) => declared.where("consent.status", "active")
        .whereRaw("?? = ??", ["identity.activeConsentId", "consent.id"])
        .whereRaw("?? = ??", ["consent.identityId", "identity.id"])
        .where((expiry) => expiry.whereNull("consent.expiresAt").orWhere("consent.expiresAt", ">", now))))
    .whereNotExists(database(PORTRAIT_PROVIDER_ASSET_TABLE)
      .whereRaw("?? = ??", ["admissionId", "admission.id"])
      .whereRaw("?? = ??", ["groupBindingId", "providerGroup.id"]).select(database.raw("1")))
    .orderBy("providerGroup.updatedAt", "asc")
    .orderBy("providerGroup.id", "asc")
    .limit(WORKER_BATCH)
    .select({
      id: "admission.id",
      revision: "admission.revision",
      identityId: "admission.identityId",
      additionalGroupId: "providerGroup.id",
      workspaceId: "admission.workspaceId",
      projectId: "admission.projectId",
      assetVersionId: "admission.assetVersionId",
      preferredProviderChannelId: "providerGroup.channelId",
    });
  let materialized = 0;
  for (const row of [...rows, ...additional]) {
    try {
      await ensurePortraitProviderBindingQueued({
        database,
        workspaceId: String(row.workspaceId),
        projectId: Number(row.projectId),
        assetVersionId: Number(row.assetVersionId),
        channelId: String(row.preferredProviderChannelId),
        now,
        retryFailed: false,
      });
      materialized += 1;
    } catch (caught) {
      const failure = safeProviderFailure(caught);
      const additionalGroupId = "additionalGroupId" in row ? row.additionalGroupId : null;
      if (additionalGroupId) {
        // Another channel's failure cannot replace a currently usable binding.
        // Rotate this group so it cannot monopolize the oldest additional work.
        await database(PORTRAIT_PROVIDER_GROUP_TABLE).where({ id: additionalGroupId, state: "active" })
          .update({ updatedAt: now });
      } else {
        // An old failed binding used to remain queued forever and occupy all
        // eight worker slots. Reflect terminal registration outcomes, and give
        // transient local errors a bounded retry delay without replaying POSTs.
        await database(PORTRAIT_ADMISSION_TABLE).where({ id: row.id, revision: row.revision,
          identityId: row.identityId, preferredProviderChannelId: row.preferredProviderChannelId })
          .whereNot("providerSyncState", "active").modify(whereNoGenerationRefusal)
          .update({
            ...(caught instanceof PortraitBindingRuntimeError ? { providerSyncState: "failed" } : {}),
            safeErrorCode: failure.code, safeErrorMessage: failure.message,
            revision: Number(row.revision) + 1, updatedAt: now,
          });
      }
      logger.warn({ worker: "portrait-provider", admissionId: row.id,
        assetVersionId: Number(row.assetVersionId), code: failure.code,
        additionalRoute: Boolean(additionalGroupId) }, "Portrait registration queue preparation failed");
    }
  }
  return materialized;
}

async function processQueuedGroups(database: Knex, now: () => number): Promise<number> {
  const dueAt = now();
  const rows = await database(`${PORTRAIT_PROVIDER_GROUP_TABLE} as providerGroup`)
    .innerJoin(`${PORTRAIT_IDENTITY_TABLE} as identity`, "identity.id", "providerGroup.identityId")
    .innerJoin("o_provider_channel as channel", "channel.id", "providerGroup.channelId")
    .where({ "providerGroup.state": "queued", "providerGroup.groupType": "AIGC" })
    .where({
      "channel.provider": "volcano",
      "channel.disabled": 0,
    })
    .where("channel.endpointType", "video_generation")
    .where((builder) => builder
      .where((platform) => platform.where("channel.scope", "platform").whereNull("channel.workspaceId"))
      .orWhere((workspace) => workspace
        .where("channel.scope", "workspace")
        .whereRaw("?? = ??", ["channel.workspaceId", "providerGroup.workspaceId"])))
    .where("providerGroup.nextAttemptAt", "<=", dueAt)
    .where((builder) => builder.whereNull("providerGroup.leaseExpiresAt").orWhere("providerGroup.leaseExpiresAt", "<", dueAt))
    .orderBy("providerGroup.nextAttemptAt", "asc")
    .limit(WORKER_BATCH)
    .select(
      "providerGroup.*",
      "identity.ownerUserId",
      "identity.label as identityLabel",
      "channel.configJson",
      "channel.credentialRef",
      "channel.provider as channelProvider",
      "channel.endpointType as channelEndpointType",
      "channel.disabled as channelDisabled",
    );
  let processed = 0;
  for (const row of rows) {
    const channel: ChannelRow = {
      id: row.channelId,
      configJson: row.configJson,
      credentialRef: row.credentialRef,
      provider: row.channelProvider,
      endpointType: row.channelEndpointType,
      disabled: row.channelDisabled,
    };
    let creating: VolcenginePortraitGroupSyncRecord;
    const claimedAt = now();
    const claimed = await database.transaction(async (trx) => {
      const eligible = await trx(`${PORTRAIT_ADMISSION_TABLE} as admission`)
        .innerJoin(`${PORTRAIT_IDENTITY_TABLE} as currentIdentity`, "currentIdentity.id", "admission.identityId")
        .leftJoin(`${PORTRAIT_CONSENT_TABLE} as currentConsent`, "currentConsent.id", "admission.currentConsentId")
        .where({
          "admission.workspaceId": row.workspaceId,
          "admission.identityId": row.identityId,
          "admission.sourceRecoveryState": "ready",
          "currentIdentity.state": "active",
        })
        .modify(wherePortraitScopeEligible, "admission")
        .modify(whereNoGenerationRefusal, "admission")
        .whereNotNull("admission.sourceSha256")
        .whereIn("admission.subjectKind", ["virtual_person", "trusted_output", "detected_person"])
        .where((progress) => progress
          .where((primary) => primary.where("admission.preferredProviderChannelId", row.channelId)
            .whereIn("admission.providerSyncState", ["queued", "creating_group", "processing"]))
          .orWhere((additional) => additional.where("admission.providerSyncState", "active")
            .whereNotNull("admission.currentProviderAssetBindingId")))
        .where((eligibility) => eligibility
          .where((automatic) => automatic
            .where("admission.subjectKind", "detected_person")
            .where("admission.declarationState", "not_required")
            .where("currentIdentity.kind", "detected_person")
            .whereNull("admission.currentConsentId"))
          .orWhere((declared) => declared
            .whereNot("admission.subjectKind", "detected_person")
            .where("currentConsent.status", "active")
            .whereRaw("?? = ??", ["currentIdentity.activeConsentId", "admission.currentConsentId"])
            .whereRaw("?? = ??", ["currentConsent.identityId", "admission.identityId"])
            .where((expiry) => expiry.whereNull("currentConsent.expiresAt").orWhere("currentConsent.expiresAt", ">", claimedAt))))
        .select("admission.subjectKind", "currentConsent.consentType")
        .forUpdate("admission", "currentIdentity")
        .first();
      const expectedConsentType = eligible?.subjectKind === "trusted_output"
        ? "trusted_output_attestation"
        : "virtual_person_rights";
      if (!eligible || (eligible.subjectKind !== "detected_person" && eligible.consentType !== expectedConsentType)) return false;
      const current = await trx(PORTRAIT_PROVIDER_GROUP_TABLE).where({ id: row.id }).forUpdate().first();
      if (!current || current.state !== "queued" || (current.leaseExpiresAt && Number(current.leaseExpiresAt) >= claimedAt)) return false;
      const activeChannel = await providerChannel({
        database: trx,
        workspaceId: String(row.workspaceId),
        channelId: String(row.channelId),
        lock: true,
      });
      const scope = channelScope(activeChannel);
      if (
        portraitProviderAccountFingerprint(scope, channelPortraitCredentialBinding(activeChannel))
        !== String(current.providerAccountFingerprint)
      ) {
        await trx(PORTRAIT_PROVIDER_GROUP_TABLE).where({ id: current.id, state: "queued" }).update({
          state: "stale",
          safeErrorCode: "VOLC_PORTRAIT_CREDENTIAL_ROTATED",
          safeErrorMessage: "人像资产凭据已轮换，需要重建上游绑定",
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: claimedAt,
        });
        await trx(PORTRAIT_ADMISSION_TABLE).modify(whereNoGenerationRefusal).where({ identityId: current.identityId, preferredProviderChannelId: current.channelId }).update({
          providerSyncState: "failed",
          safeErrorCode: "VOLC_PORTRAIT_CREDENTIAL_ROTATED",
          safeErrorMessage: "人像资产凭据已轮换，需要重新同步",
          revision: trx.raw('"revision" + 1'),
          updatedAt: claimedAt,
        });
        return false;
      }
      creating = markVolcenginePortraitGroupCreating({ now: claimedAt, record: groupRecord(current, scope) });
      await trx(PORTRAIT_PROVIDER_GROUP_TABLE).where({ id: current.id, state: "queued" }).update({
        ...groupWrite(creating),
        leaseOwner: workerOwner,
        leaseExpiresAt: claimedAt + WORKER_LEASE_MS,
      });
      await trx(PORTRAIT_ADMISSION_TABLE).modify(whereNoGenerationRefusal).where({ identityId: current.identityId, preferredProviderChannelId: current.channelId }).update({
        providerSyncState: "creating_group",
        revision: trx.raw('"revision" + 1'),
        updatedAt: claimedAt,
      });
      return true;
    }).catch((caught) => {
      logger.warn({ worker: "portrait-provider", groupBindingId: row.id,
        code: safeProviderFailure(caught).code }, "Portrait group preparation failed before dispatch");
      return false;
    });
    if (!claimed) {
      await database(PORTRAIT_PROVIDER_GROUP_TABLE).where({ id: row.id, state: "queued", updatedAt: row.updatedAt })
        .update({ nextAttemptAt: now() + MATERIALIZATION_RETRY_MS });
      continue;
    }
    let providerGroupCreated = false;
    try {
      const activeChannel = await providerChannel({
        database,
        workspaceId: String(row.workspaceId),
        channelId: String(row.channelId),
      });
      if (
        portraitProviderAccountFingerprint(
          channelScope(activeChannel),
          channelPortraitCredentialBinding(activeChannel),
        ) !== String(row.providerAccountFingerprint)
      ) {
        runtimeError(409, "portrait_provider_channel_changed", "火山人像资产通道账号范围已变化，请重新建立绑定");
      }
      const providerGroup = await withPortraitClient({
        database,
        channel: activeChannel,
        workspaceId: String(row.workspaceId),
        actorUserId: Number(row.ownerUserId),
        operation: (client) => client.createAigcAssetGroup({
          name: cleanString(row.identityLabel, 64) || "Fanjin 虚拟人像",
          description: "Fanjin 私域虚拟人像资产组",
          idempotencyKey: creating!.idempotencyKey,
        }),
      });
      providerGroupCreated = true;
      const completedAt = now();
      const active = applyVolcenginePortraitGroupActive({ group: providerGroup, now: completedAt, record: creating! });
      await database.transaction(async (trx) => {
        const current = await trx(PORTRAIT_PROVIDER_GROUP_TABLE).where({ id: row.id }).forUpdate().first();
        if (!current || current.state !== "creating" || current.leaseOwner !== workerOwner) {
          runtimeError(409, "portrait_provider_lease_lost", "人像素材组同步租约已失效");
        }
        await trx(PORTRAIT_PROVIDER_GROUP_TABLE).where({ id: row.id }).update({
          ...groupWrite(active),
          leaseOwner: null,
          leaseExpiresAt: null,
        });
        await trx(PORTRAIT_ADMISSION_TABLE).modify(whereNoGenerationRefusal).where({ identityId: row.identityId, preferredProviderChannelId: row.channelId }).update({
          providerSyncState: "queued",
          safeErrorCode: null,
          safeErrorMessage: null,
          revision: trx.raw('"revision" + 1'),
          updatedAt: completedAt,
        });
        await writeAuditLog({ workspaceId: row.workspaceId, actor: { actorKind: "worker" } }, {
          workspaceId: row.workspaceId,
          action: "portrait.provider_group.active",
          resourceType: "portrait_provider_group",
          resourceId: row.id,
          required: true,
          actor: { actorKind: "worker" },
          metadata: { groupType: "AIGC", channelId: row.channelId },
        }, trx);
      });
    } catch (caught) {
      const failedAt = now();
      const baseFailure = safeProviderFailure(caught);
      const failure = providerGroupCreated
        ? {
          code: "VOLC_PORTRAIT_OUTCOME_UNKNOWN",
          message: "上游素材组已创建，但本地登记未完成，需要管理员核对",
          outcomeUnknown: true,
        }
        : baseFailure;
      await database.transaction(async (trx) => {
        const current = await trx(PORTRAIT_PROVIDER_GROUP_TABLE).where({ id: row.id }).forUpdate().first();
        if (!current || current.state !== "creating" || current.leaseOwner !== workerOwner) return;
        await trx(PORTRAIT_PROVIDER_GROUP_TABLE).where({ id: row.id }).update({
          ...groupWrite(failedGroupRecord(creating!, failedAt, failure.code, failure.message)),
          leaseOwner: null,
          leaseExpiresAt: null,
        });
        await trx(PORTRAIT_ADMISSION_TABLE).modify(whereNoGenerationRefusal).where({ identityId: row.identityId, preferredProviderChannelId: row.channelId }).update({
          providerSyncState: "failed",
          safeErrorCode: failure.code,
          safeErrorMessage: failure.message,
          revision: trx.raw('"revision" + 1'),
          updatedAt: failedAt,
        });
        await writeAuditLog({ workspaceId: row.workspaceId, actor: { actorKind: "worker" } }, {
          workspaceId: row.workspaceId,
          action: "portrait.provider_group.failed",
          resourceType: "portrait_provider_group",
          resourceId: row.id,
          required: true,
          actor: { actorKind: "worker" },
          metadata: { errorCode: failure.code, outcomeUnknown: failure.outcomeUnknown },
        }, trx);
      });
    }
    processed += 1;
  }
  return processed;
}

async function processProviderAssets(database: Knex, now: () => number): Promise<number> {
  const dueAt = now();
  const rows = await database(`${PORTRAIT_PROVIDER_ASSET_TABLE} as providerAsset`)
    .innerJoin(`${PORTRAIT_PROVIDER_GROUP_TABLE} as providerGroup`, "providerGroup.id", "providerAsset.groupBindingId")
    .innerJoin(`${PORTRAIT_ADMISSION_TABLE} as admission`, "admission.id", "providerAsset.admissionId")
    .innerJoin(`${PORTRAIT_IDENTITY_TABLE} as identity`, "identity.id", "admission.identityId")
    .innerJoin("o_image as version", "version.id", "admission.assetVersionId")
    .innerJoin("o_provider_channel as channel", "channel.id", "providerAsset.channelId")
    .whereIn("providerAsset.state", ["queued", "processing"])
    .where({
      "channel.provider": "volcano",
      "channel.disabled": 0,
      "admission.sourceRecoveryState": "ready",
    })
    .whereRaw("?? = ??", ["providerAsset.sourceSha256", "admission.sourceSha256"])
    .where("channel.endpointType", "video_generation")
    .where((builder) => builder
      .where((platform) => platform.where("channel.scope", "platform").whereNull("channel.workspaceId"))
      .orWhere((workspace) => workspace
        .where("channel.scope", "workspace")
        .whereRaw("?? = ??", ["channel.workspaceId", "providerAsset.workspaceId"])))
    .where("providerAsset.nextAttemptAt", "<=", dueAt)
    .where("providerGroup.state", "active")
    .where((builder) => builder.whereNull("providerAsset.leaseExpiresAt").orWhere("providerAsset.leaseExpiresAt", "<", dueAt))
    .orderBy("providerAsset.nextAttemptAt", "asc")
    .limit(WORKER_BATCH)
    .select(
      "providerAsset.*",
      "providerGroup.providerGroupId",
      "providerGroup.groupType",
      "providerGroup.projectName",
      "providerGroup.providerAccountFingerprint",
      "admission.mediaType",
      "admission.projectId",
      "admission.assetVersionId",
      "admission.revision as admissionRevision",
      "identity.ownerUserId",
      "identity.label as identityLabel",
      "version.filePath",
      "channel.configJson",
      "channel.credentialRef",
      "channel.provider as channelProvider",
      "channel.endpointType as channelEndpointType",
      "channel.disabled as channelDisabled",
    );
  let processed = 0;
  for (const row of rows) {
    const channel: ChannelRow = {
      id: row.channelId,
      configJson: row.configJson,
      credentialRef: row.credentialRef,
      provider: row.channelProvider,
      endpointType: row.channelEndpointType,
      disabled: row.channelDisabled,
    };
    let scope: VolcenginePortraitAssetScope;
    try {
      scope = channelScope(channel);
    } catch (caught) {
      await database(PORTRAIT_PROVIDER_ASSET_TABLE).where({ id: row.id, state: row.state, updatedAt: row.updatedAt })
        .update({ nextAttemptAt: now() + MATERIALIZATION_RETRY_MS });
      logger.warn({ worker: "portrait-provider", assetBindingId: row.id,
        code: safeProviderFailure(caught).code }, "Portrait asset channel unavailable before dispatch");
      continue;
    }
    const providerGroup: VolcenginePortraitAssetGroupRef = Object.freeze({
      groupId: String(row.providerGroupId),
      groupType: row.groupType,
      scope,
    });
    const claimedAt = now();
    const claimed = await database.transaction(async (trx) => {
      const currentAdmission = await trx(`${PORTRAIT_ADMISSION_TABLE} as admission`)
        .innerJoin(`${PORTRAIT_IDENTITY_TABLE} as currentIdentity`, "currentIdentity.id", "admission.identityId")
        .leftJoin(`${PORTRAIT_CONSENT_TABLE} as currentConsent`, "currentConsent.id", "admission.currentConsentId")
        .where({
          "admission.id": row.admissionId,
          "admission.workspaceId": row.workspaceId,
          "admission.sourceRecoveryState": "ready",
          "admission.sourceSha256": row.sourceSha256,
          "currentIdentity.state": "active",
        })
        .modify(wherePortraitScopeEligible, "admission")
        .modify(whereNoGenerationRefusal, "admission")
        .whereIn("admission.subjectKind", ["real_person", "virtual_person", "trusted_output", "detected_person"])
        .where((progress) => progress
          .where((primary) => primary.where("admission.preferredProviderChannelId", row.channelId)
            .whereIn("admission.providerSyncState", ["queued", "processing"]))
          .orWhere((additional) => additional.where("admission.providerSyncState", "active")
            .whereNotNull("admission.currentProviderAssetBindingId")))
        .where((eligibility) => eligibility
          .where((automatic) => automatic
            .where("admission.subjectKind", "detected_person")
            .where("admission.declarationState", "not_required")
            .where("currentIdentity.kind", "detected_person")
            .whereNull("admission.currentConsentId"))
          .orWhere((declared) => declared
            .whereNot("admission.subjectKind", "detected_person")
            .where("currentConsent.status", "active")
            .whereRaw("?? = ??", ["currentIdentity.activeConsentId", "admission.currentConsentId"])
            .whereRaw("?? = ??", ["currentConsent.identityId", "admission.identityId"])
            .where((expiry) => expiry.whereNull("currentConsent.expiresAt").orWhere("currentConsent.expiresAt", ">", claimedAt))))
        .select("admission.identityId", "admission.subjectKind", "currentConsent.consentType")
        .forUpdate("admission", "currentIdentity")
        .first();
      const expectedConsentType = currentAdmission?.subjectKind === "real_person"
        ? "real_person_rights"
        : currentAdmission?.subjectKind === "trusted_output"
          ? "trusted_output_attestation"
          : "virtual_person_rights";
      if (!currentAdmission || (currentAdmission.subjectKind !== "detected_person" && currentAdmission.consentType !== expectedConsentType)) return false;
      const currentGroup = await trx(PORTRAIT_PROVIDER_GROUP_TABLE)
        .where({
          id: row.groupBindingId,
          workspaceId: row.workspaceId,
          identityId: currentAdmission.identityId,
          channelId: row.channelId,
          state: "active",
        })
        .forUpdate()
        .first();
      if (
        !currentGroup
        || currentGroup.providerAccountFingerprint !== row.providerAccountFingerprint
        || currentGroup.providerGroupId !== row.providerGroupId
      ) return false;
      const current = await trx(PORTRAIT_PROVIDER_ASSET_TABLE)
        .where({ id: row.id, state: row.state, admissionId: row.admissionId, groupBindingId: row.groupBindingId })
        .where((builder) => builder.whereNull("leaseExpiresAt").orWhere("leaseExpiresAt", "<", claimedAt))
        .forUpdate()
        .first();
      if (!current) return false;
      const activeChannel = await providerChannel({
        database: trx,
        workspaceId: String(row.workspaceId),
        channelId: String(row.channelId),
        lock: true,
      });
      if (
        portraitProviderAccountFingerprint(
          channelScope(activeChannel),
          channelPortraitCredentialBinding(activeChannel),
        ) !== String(row.providerAccountFingerprint)
      ) return false;
      const affected = await trx(PORTRAIT_PROVIDER_ASSET_TABLE).where({ id: row.id, state: row.state }).update({
        ...(row.state === "queued" ? { state: "submitting" } : {}),
        leaseOwner: workerOwner,
        leaseExpiresAt: claimedAt + WORKER_LEASE_MS,
        updatedAt: claimedAt,
      });
      return Number(affected) === 1;
    }).catch((caught) => {
      logger.warn({ worker: "portrait-provider", assetBindingId: row.id,
        code: safeProviderFailure(caught).code }, "Portrait asset preparation failed before dispatch");
      return false;
    });
    if (!claimed) {
      await database(PORTRAIT_PROVIDER_ASSET_TABLE).where({ id: row.id, state: row.state, updatedAt: row.updatedAt })
        .update({ nextAttemptAt: now() + MATERIALIZATION_RETRY_MS });
      continue;
    }
    let currentRecord = assetRecord({ ...row, state: row.state === "queued" ? "submitting" : "processing", updatedAt: claimedAt }, providerGroup);
    if (row.state === "queued") {
      // Validate the exact queued->submitting transition before any provider IO.
      currentRecord = markVolcenginePortraitAssetSubmitting({
        now: claimedAt,
        record: assetRecord(row, providerGroup),
        request: assetRequest({ row, group: providerGroup, sourceUrl: "https://placeholder.invalid/authoritative-object" }),
      });
    }
    let providerAssetCreated = false;
    try {
      const activeChannel = await providerChannel({
        database,
        workspaceId: String(row.workspaceId),
        channelId: String(row.channelId),
      });
      if (
        portraitProviderAccountFingerprint(
          channelScope(activeChannel),
          channelPortraitCredentialBinding(activeChannel),
        ) !== String(row.providerAccountFingerprint)
      ) {
        runtimeError(409, "portrait_provider_channel_changed", "火山人像资产通道账号范围已变化，请重新建立绑定");
      }
      let sourceUrl = "https://placeholder.invalid/read-only-poll";
      if (currentRecord.state === "submitting") {
        try {
          // Fanjin object storage remains the sole source of truth. The
          // provider receives only an ephemeral private URL generated at the
          // last possible moment; it is never persisted or logged.
          sourceUrl = await u.oss.getPrivateFileUrl(String(row.filePath || ""), {
            expiresInSeconds: 300,
          });
        } catch {
          // Object storage failed before provider dispatch, so this mutation is
          // provably safe to retry and must not be classified outcome_unknown.
          const retryAt = now();
          await database(PORTRAIT_PROVIDER_ASSET_TABLE)
            .where({ id: row.id, state: "submitting", leaseOwner: workerOwner })
            .update({
              state: "queued",
              retryCount: Number(row.retryCount || 0) + 1,
              nextAttemptAt: retryAt + 5_000,
              safeErrorCode: "PORTRAIT_SOURCE_URL_UNAVAILABLE",
              safeErrorMessage: "源素材暂时不可读取，等待安全重试",
              leaseOwner: null,
              leaseExpiresAt: null,
              updatedAt: retryAt,
            });
          processed += 1;
          continue;
        }
      }
      const request = assetRequest({ row, group: providerGroup, sourceUrl });
      const resultRecord = await withPortraitClient({
        database,
        channel: activeChannel,
        workspaceId: String(row.workspaceId),
        actorUserId: Number(row.ownerUserId),
        operation: async (client) => {
          if (currentRecord.state === "submitting") {
            const asset = await client.createAsset(request);
            providerAssetCreated = true;
            return applyVolcenginePortraitAssetSubmitted({
              asset,
              now: now(),
              record: currentRecord,
            });
          }
          return (await pollVolcenginePortraitAssetSync({
            client,
            now,
            record: currentRecord,
          })).record;
        },
      });
      await database.transaction(async (trx) => {
        const current = await trx(PORTRAIT_PROVIDER_ASSET_TABLE).where({ id: row.id }).forUpdate().first();
        if (!current || current.leaseOwner !== workerOwner || !["submitting", "processing"].includes(String(current.state))) {
          runtimeError(409, "portrait_provider_lease_lost", "人像素材同步租约已失效");
        }
        await trx(PORTRAIT_PROVIDER_ASSET_TABLE).where({ id: row.id }).update({
          ...assetWrite(resultRecord),
          leaseOwner: null,
          leaseExpiresAt: null,
        });
        if (resultRecord.state === "active") {
          await trx(PORTRAIT_ADMISSION_TABLE).modify(whereNoGenerationRefusal).where({ id: row.admissionId, preferredProviderChannelId: row.channelId }).update({
            providerSyncState: "active",
            currentProviderAssetBindingId: row.id,
            safeErrorCode: null,
            safeErrorMessage: null,
            revision: trx.raw('"revision" + 1'),
            updatedAt: resultRecord.updatedAt,
          });
          await writeAuditLog({ workspaceId: row.workspaceId, actor: { actorKind: "worker" } }, {
            workspaceId: row.workspaceId,
            action: "portrait.provider_asset.active",
            resourceType: "portrait_provider_asset",
            resourceId: row.id,
            required: true,
            actor: { actorKind: "worker" },
            metadata: { admissionId: row.admissionId, channelId: row.channelId },
          }, trx);
        } else if (resultRecord.state === "failed") {
          await trx(PORTRAIT_ADMISSION_TABLE).modify(whereNoGenerationRefusal).where({ id: row.admissionId, preferredProviderChannelId: row.channelId }).update({
            providerSyncState: "failed",
            currentProviderAssetBindingId: null,
            safeErrorCode: resultRecord.safeErrorCode,
            safeErrorMessage: resultRecord.safeErrorMessage,
            revision: trx.raw('"revision" + 1'),
            updatedAt: resultRecord.updatedAt,
          });
        }
      });
    } catch (caught) {
      const failedAt = now();
      const baseFailure = safeProviderFailure(caught);
      const failure = providerAssetCreated
        ? {
          code: "VOLC_PORTRAIT_OUTCOME_UNKNOWN",
          message: "上游素材已创建，但本地登记未完成，需要管理员核对",
          outcomeUnknown: true,
        }
        : baseFailure;
      let failedRecord: VolcenginePortraitAssetSyncRecord;
      if (currentRecord.state === "submitting") {
        const providerError = providerAssetCreated
          ? new VolcenginePortraitAssetsError({
            code: failure.code,
            dispatchState: "outcome_unknown",
            message: failure.message,
          })
          : caught instanceof VolcenginePortraitAssetsError
          ? caught
          : new VolcenginePortraitAssetsError({
            code: failure.code,
            dispatchState: caught instanceof PortraitProviderRuntimeError ? "not_dispatched" : "outcome_unknown",
            message: failure.message,
            retryable: caught instanceof PortraitProviderRuntimeError,
          });
        failedRecord = applyVolcenginePortraitAssetSubmitFailure({
          error: providerError,
          now: failedAt,
          record: currentRecord,
        });
      } else {
        failedRecord = Object.freeze({
          ...currentRecord,
          nextAttemptAt: failedAt + 5_000,
          retryCount: currentRecord.retryCount + 1,
          safeErrorCode: failure.code,
          safeErrorMessage: failure.message,
          state: "processing",
          updatedAt: failedAt,
        });
      }
      await database.transaction(async (trx) => {
        const current = await trx(PORTRAIT_PROVIDER_ASSET_TABLE).where({ id: row.id }).forUpdate().first();
        if (!current || current.leaseOwner !== workerOwner) return;
        await trx(PORTRAIT_PROVIDER_ASSET_TABLE).where({ id: row.id }).update({
          ...assetWrite(failedRecord),
          leaseOwner: null,
          leaseExpiresAt: null,
        });
        if (failedRecord.state === "failed") {
          await trx(PORTRAIT_ADMISSION_TABLE).modify(whereNoGenerationRefusal).where({ id: row.admissionId, preferredProviderChannelId: row.channelId }).update({
            providerSyncState: "failed",
            currentProviderAssetBindingId: null,
            safeErrorCode: failedRecord.safeErrorCode,
            safeErrorMessage: failedRecord.safeErrorMessage,
            revision: trx.raw('"revision" + 1'),
            updatedAt: failedAt,
          });
          await writeAuditLog({ workspaceId: row.workspaceId, actor: { actorKind: "worker" } }, {
            workspaceId: row.workspaceId,
            action: "portrait.provider_asset.failed",
            resourceType: "portrait_provider_asset",
            resourceId: row.id,
            required: true,
            actor: { actorKind: "worker" },
            metadata: {
              admissionId: row.admissionId,
              errorCode: failedRecord.safeErrorCode,
              ...(caught instanceof VolcenginePortraitAssetsError ? {
                providerRequestId: caught.requestId,
                httpStatus: caught.httpStatus,
              } : {}),
            },
          }, trx);
        }
      });
    }
    processed += 1;
  }
  return processed;
}

export async function runPortraitProviderRuntimeBatch(input: {
  database?: Knex;
  now?: () => number;
} = {}): Promise<{
  reconciled: number;
  materialized: number;
  groupsProcessed: number;
  assetsProcessed: number;
}> {
  const database = input.database ?? db;
  const now = input.now ?? Date.now;
  await prepareAutomaticPortraitRegistrations(database, now());
  await bindUnroutedDeclaredPortraits(database, now());
  const reconciled = await reconcileUnknownMutations(database, now());
  await recoverUnknownPortraitRegistrations({ database, now,
    fingerprint: channel => portraitProviderAccountFingerprint(channelScope(channel), channelPortraitCredentialBinding(channel)),
    lookup: async ({ channel, asset, group, admission }) => withPortraitClient({ database, channel,
      workspaceId: asset.workspaceId, actorUserId: Number(admission.ownerUserId), operation: async client => ({
        group: await client.executeAction({ action: "GetAssetGroup", body: { Id: group.providerGroupId, ProjectName: group.projectName } }),
        assets: await client.executeAction({ action: "ListAssets", body: { Filter: { GroupIds: [group.providerGroupId] },
          ProjectName: group.projectName, PageNumber: 1, PageSize: 100 } }),
      }) }),
  });
  const materialized = await materializeQueuedAdmissions(database, now());
  const groupsProcessed = await processQueuedGroups(database, now);
  // Active groups from this tick are materialized before processing assets.
  const additionallyMaterialized = await materializeQueuedAdmissions(database, now());
  const assetsProcessed = await processProviderAssets(database, now);
  return {
    reconciled,
    materialized: materialized + additionallyMaterialized,
    groupsProcessed,
    assetsProcessed,
  };
}

let providerWorkerTimer: NodeJS.Timeout | null = null;
let providerWorkerTick: Promise<unknown> | null = null;

export function startPortraitProviderRuntimeWorker(): void {
  if (providerWorkerTimer) return;
  const run = () => {
    if (providerWorkerTick) return;
    providerWorkerTick = runPortraitProviderRuntimeBatch()
      .catch((caught) => {
        logger.error({ worker: "portrait-provider", code: safeProviderFailure(caught).code },
          "Portrait registration worker tick failed");
      })
      .finally(() => { providerWorkerTick = null; });
  };
  run();
  providerWorkerTimer = setInterval(run, 5_000);
  providerWorkerTimer.unref?.();
}

export async function stopPortraitProviderRuntimeWorker(): Promise<void> {
  if (providerWorkerTimer) clearInterval(providerWorkerTimer);
  providerWorkerTimer = null;
  await providerWorkerTick;
}
