import { resolveProjectAssetVersion } from "@/lib/projectAssetVersion";
import crypto from "node:crypto";
import { materializeReferenceMediaTrim } from "./referenceMediaTrim";
import { bindPreparedReferenceTrim } from "./referenceMediaTrimProof";
import type { Knex } from "knex";
import u from "@/utils";
import { db } from "@/utils/db";
export { GenerationReferenceError } from "@/lib/generationReferenceError";
import { GenerationReferenceError } from "@/lib/generationReferenceError";
import { toProviderMediaUrl } from "@/lib/providerMediaUrl";
import {
  publishRelayVideoDelivery,
  readRelayFinalEvidenceDescriptor,
} from "@/lib/videoFulfillment/deliveryConsumer";
import {
  compactLocalProviderImageDataUrl,
  normalizeAndValidateProviderVideoPayload,
  ProviderReferencePayloadError,
} from "@/lib/providerReferencePayload";
import type {
  VideoGenerationInput,
  VideoReferenceMediaType,
} from "@/lib/videoGenerationContract";
import {
  resolveVideoAssetPolicyDecisions,
  VideoAssetPolicyError,
  type TrustedVideoAssetPolicyEvidence,
  type VideoAssetPolicyResolution,
  type VideoAssetPolicyVerdict,
} from "@/lib/videoAssetPolicy";

export const GENERATION_REFERENCE_ROLES = [
  "subject",
  "style",
  "storyboard",
  "first_frame",
  "last_frame",
  "source_video",
] as const;

export type GenerationReferenceRole = (typeof GENERATION_REFERENCE_ROLES)[number];

export type GenerationReference = {
  assetVersionId: string;
  role: GenerationReferenceRole;
  /** Optional on legacy callers; the resolver always verifies it against storage. */
  mediaType?: VideoReferenceMediaType;
  /** Optional on legacy callers; omitted order is the request array position. */
  order?: number;
  trim?: { startMs: number; endMs: number };
};

export type ResolvedGenerationReferences = {
  inputs: VideoGenerationInput[];
  providerContent: Record<string, unknown>[];
  referenceDigest: string;
  /**
   * Verified policy evidence is intentionally non-enumerable at runtime so it
   * cannot enter JSON responses or ordinary structured logs by object spread.
   * Trusted dispatch code may bind it into Relay's internal envelope only.
   */
  readonly trustedPolicyEvidence: TrustedVideoAssetPolicyEvidence;
};

/**
 * Storage-backed reference shape used only for capability preflight. It does
 * not perform portrait/policy admission and its placeholder provider content
 * must never be dispatched upstream.
 */
export type InspectedGenerationReferences = {
  inputs: VideoGenerationInput[];
  providerContent: Record<string, unknown>[];
};

type AssetVersionRow = {
  id: unknown;
  assetId: unknown;
  sourceProjectId: unknown;
  filePath: unknown;
  storageKey: unknown;
  type: unknown;
};

type TrustedRelayVideoRow = {
  mediaId: unknown;
  mediaUrl: unknown;
  mediaStorageKey: unknown;
  mediaMetadata: unknown;
  mediaMimeType: unknown;
  mediaWidth: unknown;
  mediaHeight: unknown;
  mediaDurationMs: unknown;
  taskId: unknown;
  taskChannelId: unknown;
  taskProviderTaskId: unknown;
  taskRequestId: unknown;
  taskRequestPayload: unknown;
  taskProviderPayload: unknown;
  taskResultPayload: unknown;
  taskErrorMessage: unknown;
};

type ProviderMediaKind = "image" | "video" | "audio";

function mediaKind(type: unknown): ProviderMediaKind {
  const normalized = String(type || "").trim().toLowerCase();
  if (["role", "scene", "tool", "image"].includes(normalized)) return "image";
  if (["clip", "video"].includes(normalized)) return "video";
  if (normalized === "audio") return "audio";
  throw new GenerationReferenceError(400, "reference_media_type_unsupported", "参考素材类型不受支持");
}

function assertRoleSupportsMedia(role: GenerationReferenceRole, kind: ProviderMediaKind) {
  if (kind !== "image" && ["storyboard", "first_frame", "last_frame"].includes(role)) {
    throw new GenerationReferenceError(400, "reference_role_media_mismatch", "参考素材与引用角色不匹配");
  }
}

function parseJsonObject(value: unknown): Record<string, unknown> {
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

function nestedObject(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  return parseJsonObject(value[key]);
}

function nestedString(
  value: Record<string, unknown>,
  path: string[],
): string {
  let current = value;
  for (let index = 0; index < path.length - 1; index += 1) {
    current = nestedObject(current, path[index]);
  }
  return String(current[path[path.length - 1]] || "").trim();
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function trustedProviderVideoUrl(
  resultPayload: Record<string, unknown>,
  providerPayload: Record<string, unknown>,
): string | null {
  const publicUrl = nestedString(resultPayload, ["public", "video_url"]);
  const contentUrl = nestedString(resultPayload, ["content", "video_url"]);
  const providerUrl = nestedString(providerPayload, ["response", "content", "video_url"]);
  if (!publicUrl || publicUrl !== contentUrl || publicUrl !== providerUrl) return null;
  try {
    const normalized = toProviderMediaUrl(publicUrl);
    const parsed = new URL(normalized);
    if (
      normalized !== publicUrl
      || parsed.protocol !== "https:"
      || parsed.username
      || parsed.password
    ) {
      return null;
    }
    return normalized;
  } catch {
    return null;
  }
}

export async function resolveTrustedRelayProviderVideoUrl(input: {
  database: Knex | Knex.Transaction;
  workspaceId: string;
  projectId: string;
  assetId: string;
  assetVersionId: string;
  filePath: string;
  storageKey: string;
}): Promise<string | null> {
  if (!input.storageKey || input.storageKey !== input.filePath) return null;
  const rows = await input.database("o_media_asset as media")
    .innerJoin("o_relay_task as task", "task.id", "media.taskId")
    .where({
      "media.workspaceId": input.workspaceId,
      "media.projectId": Number(input.projectId),
      "media.assetType": "video",
      "media.source": "relay_final",
      "media.deletionState": "active",
      "task.workspaceId": input.workspaceId,
      "task.projectId": Number(input.projectId),
      "task.endpointType": "video_generation",
      "task.status": "succeeded",
    })
    .andWhere("media.storageKey", input.storageKey)
    .select({
      mediaId: "media.id",
      mediaUrl: "media.url",
      mediaStorageKey: "media.storageKey",
      mediaMetadata: "media.metadata",
      mediaMimeType: "media.mimeType",
      mediaWidth: "media.width",
      mediaHeight: "media.height",
      mediaDurationMs: "media.durationMs",
      taskId: "task.id",
      taskChannelId: "task.channelId",
      taskProviderTaskId: "task.providerTaskId",
      taskRequestId: "task.requestId",
      taskRequestPayload: "task.requestPayload",
      taskProviderPayload: "task.providerPayload",
      taskResultPayload: "task.resultPayload",
      taskErrorMessage: "task.errorMessage",
    }) as TrustedRelayVideoRow[];

  const exactRows = rows.filter((row) => {
    const metadata = parseJsonObject(row.mediaMetadata);
    return String(metadata.assetId || "") === input.assetId
      && String(metadata.assetVersionId || "") === input.assetVersionId;
  });
  if (exactRows.length !== 1) return null;

  const row = exactRows[0];
  const mediaId = String(row.mediaId || "").trim();
  const taskId = String(row.taskId || "").trim();
  const mediaUrl = String(row.mediaUrl || "").trim();
  const mediaStorageKey = String(row.mediaStorageKey || "").trim();
  const metadata = parseJsonObject(row.mediaMetadata);
  const resultPayload = parseJsonObject(row.taskResultPayload);
  const resultInternal = nestedObject(resultPayload, "internal");
  const mediaEvidence = readRelayFinalEvidenceDescriptor(metadata.deliveryFinalEvidence);
  const taskEvidence = readRelayFinalEvidenceDescriptor(resultInternal.deliveryFinalEvidence);
  const taskFinalRows = taskId
    ? await input.database("o_media_asset")
        .where({
          taskId,
          workspaceId: input.workspaceId,
          projectId: Number(input.projectId),
          source: "relay_final",
          assetType: "video",
        })
        .select("id")
        .limit(2)
    : [];
  const delivery = publishRelayVideoDelivery({
    id: taskId,
    workspaceId: input.workspaceId,
    projectId: Number(input.projectId),
    requestId: String(row.taskRequestId || "") || null,
    channelId: String(row.taskChannelId || "") || null,
    providerTaskId: String(row.taskProviderTaskId || "") || null,
    status: "succeeded",
    requestPayload: parseJsonObject(row.taskRequestPayload),
    providerPayload: parseJsonObject(row.taskProviderPayload),
    resultPayload,
    errorMessage: String(row.taskErrorMessage || "") || null,
  }, [{
    id: mediaId,
    workspaceId: input.workspaceId,
    projectId: Number(input.projectId),
    source: "relay_final",
    assetType: "video",
    url: mediaUrl,
    mimeType: String(row.mediaMimeType || "") || null,
    width: Number(row.mediaWidth) || null,
    height: Number(row.mediaHeight) || null,
    durationMs: Number(row.mediaDurationMs) || null,
    metadata,
  }]);
  if (
    !mediaId
    || !taskId
    || !mediaUrl
    || taskFinalRows.length !== 1
    || String(taskFinalRows[0]?.id || "") !== mediaId
    || metadata.assetOrigin !== "relay_task"
    || metadata.mirrored !== true
    || mediaStorageKey !== input.storageKey
    || mediaStorageKey !== input.filePath
    || !mediaEvidence
    || !taskEvidence
    || stableJson(mediaEvidence) !== stableJson(taskEvidence)
    || mediaEvidence.taskId !== taskId
    || mediaEvidence.assetId !== mediaId
    || mediaEvidence.kind !== "generation_output"
    || mediaEvidence.resultSha256 !== sha256(mediaUrl)
    || delivery.projection?.taskStatus !== "succeeded"
    || delivery.projection.metRequestedQuality !== true
  ) {
    return null;
  }

  return trustedProviderVideoUrl(
    resultPayload,
    parseJsonObject(row.taskProviderPayload),
  );
}

async function resolveStoredProviderUrl(
  filePath: string,
  kind: ProviderMediaKind,
  trustedVideoFallback?: () => Promise<string | null>,
): Promise<string> {
  if (/^[a-z][a-z0-9+.-]*:/i.test(filePath)) {
    throw new GenerationReferenceError(400, "reference_media_unmanaged", "参考素材必须来自项目受控存储");
  }
  try {
    const localUrl = await u.oss.getFileUrl(filePath);
    return toProviderMediaUrl(localUrl);
  } catch (error) {
    if (kind === "image") {
      try {
        return await compactLocalProviderImageDataUrl(
          await u.oss.getImageBase64(filePath),
        );
      } catch (imageError) {
        if (imageError instanceof ProviderReferencePayloadError) {
          throw new GenerationReferenceError(
            imageError.status,
            imageError.code,
            imageError.message,
          );
        }
        throw imageError;
      }
    }
    if (kind === "video" && trustedVideoFallback) {
      const trustedUrl = await trustedVideoFallback();
      if (trustedUrl) return trustedUrl;
    }
    throw new GenerationReferenceError(
      400,
      "reference_media_not_public",
      error instanceof Error ? error.message : "参考素材不可访问",
    );
  }
}

function providerRole(kind: ProviderMediaKind, role: GenerationReferenceRole): string {
  if (role === "first_frame" || role === "last_frame") return role;
  if (kind === "audio") return "reference_audio";
  return kind === "video" ? "reference_video" : "reference_image";
}

function providerContent(url: string, kind: ProviderMediaKind, role: GenerationReferenceRole) {
  const content = {
    role: providerRole(kind, role),
    reference_role: role,
  };
  if (kind === "video") {
    return { ...content, type: "video_url", video_url: { url } };
  }
  if (kind === "audio") {
    return { ...content, type: "audio_url", audio_url: { url } };
  }
  return { ...content, type: "image_url", image_url: { url } };
}

function orderedReferenceDeclarations(
  references: GenerationReference[],
): Array<GenerationReference & { order: number }> {
  const ordered = references.map((reference, index) => ({
    ...reference,
    order: reference.order ?? index,
  })).sort((left, right) => left.order - right.order);
  if (ordered.some((reference, index) => (
    !Number.isSafeInteger(reference.order)
    || reference.order !== index
    || !String(reference.assetVersionId || "").trim()
  ))) {
    throw new GenerationReferenceError(
      400,
      "reference_order_invalid",
      "参考素材必须使用从 0 开始的连续唯一顺序",
    );
  }
  for (const reference of ordered) {
    if (reference.trim === undefined) continue;
    if (
      !Number.isSafeInteger(reference.trim.startMs)
      || !Number.isSafeInteger(reference.trim.endMs)
      || reference.trim.startMs < 0
      || reference.trim.endMs <= reference.trim.startMs
    ) {
      throw new GenerationReferenceError(400, "reference_trim_invalid", "参考素材裁剪范围无效");
    }
  }
  return ordered;
}

type LoadedGenerationReference = {
  reference: GenerationReference & { order: number };
  row: AssetVersionRow;
  filePath: string;
  kind: ProviderMediaKind;
};

async function loadGenerationReferenceStructure(input: {
  database: Knex | Knex.Transaction;
  workspaceId: string;
  projectId: string;
  actorUserId?: number;
  references: GenerationReference[];
}): Promise<{
  ids: string[];
  loaded: LoadedGenerationReference[];
}> {
  const orderedReferences = orderedReferenceDeclarations(input.references);
  const ids = Array.from(new Set(
    orderedReferences.map((reference) => String(reference.assetVersionId)),
  ));
  const rows = (await Promise.all(ids.map((id) => resolveProjectAssetVersion({
    database: input.database, workspaceId: input.workspaceId, projectId: Number(input.projectId),
    assetVersionId: Number(id), actorUserId: input.actorUserId,
  })))).filter((row): row is NonNullable<typeof row> => row !== null);
  const versions = new Map(rows.map((row) => [String(row.id), row]));

  if (versions.size !== ids.length || ids.some((id) => !versions.has(id))) {
    throw new GenerationReferenceError(404, "reference_not_found", "参考素材不存在");
  }

  const loaded = orderedReferences.map((reference): LoadedGenerationReference => {
    const row = versions.get(String(reference.assetVersionId))!;
    const filePath = String(row.filePath || "").trim();
    if (!filePath) {
      throw new GenerationReferenceError(404, "reference_not_found", "参考素材不存在");
    }
    const kind = mediaKind(row.type);
    if (reference.mediaType !== undefined && reference.mediaType !== kind) {
      throw new GenerationReferenceError(
        400,
        "reference_media_type_mismatch",
        `参考素材 ${reference.order + 1} 的图片、视频或音频类型不一致，请重新上传该素材`,
      );
    }
    if (reference.trim !== undefined && kind !== "audio" && kind !== "video") {
      throw new GenerationReferenceError(
        400,
        "reference_trim_media_mismatch",
        "只有音频或视频参考素材可以设置裁剪范围",
      );
    }
    assertRoleSupportsMedia(reference.role, kind);
    return { reference, row, filePath, kind };
  });

  return { ids, loaded };
}

function canonicalReferenceInput(
  item: LoadedGenerationReference,
): VideoGenerationInput {
  return {
    assetVersionId: String(item.reference.assetVersionId).trim(),
    mediaType: item.kind,
    role: item.reference.role,
    order: item.reference.order,
    ...(item.reference.trim ? { trim: { ...item.reference.trim } } : {}),
  };
}

export async function inspectGenerationReferences(input: {
  workspaceId: string;
  projectId: string;
  actorUserId?: number;
  references: GenerationReference[];
  database?: Knex | Knex.Transaction;
}): Promise<InspectedGenerationReferences> {
  if (!input.references.length) return { inputs: [], providerContent: [] };
  const structure = await loadGenerationReferenceStructure({
    database: input.database ?? db,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    references: input.references,
    actorUserId: input.actorUserId,
  });
  return {
    inputs: structure.loaded.map(canonicalReferenceInput),
    providerContent: structure.loaded.map((item) => providerContent(
      `https://reference-preflight.invalid/${item.reference.order}`,
      item.kind,
      item.reference.role,
    )),
  };
}

type PublicResolvedGenerationReferences = Omit<
  ResolvedGenerationReferences,
  "trustedPolicyEvidence"
>;

function attachTrustedPolicyEvidence(
  result: PublicResolvedGenerationReferences,
  evidence: TrustedVideoAssetPolicyEvidence,
): ResolvedGenerationReferences {
  Object.defineProperty(result, "trustedPolicyEvidence", {
    value: evidence,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return result as ResolvedGenerationReferences;
}

const policyFailure = new Map<
VideoAssetPolicyVerdict,
{ status: number; code: string; message: string }
>([
  ["missing", {
    status: 422,
    code: "video_asset_policy_missing",
    message: "参考素材尚无有效授权与审核决定",
  }],
  ["denied", {
    status: 422,
    code: "video_asset_policy_denied",
    message: "参考素材未通过授权与审核",
  }],
  ["expired", {
    status: 422,
    code: "video_asset_consent_expired",
    message: "参考素材授权已失效",
  }],
  ["tampered", {
    status: 422,
    code: "video_asset_policy_tampered",
    message: "参考素材授权与审核决定校验失败",
  }],
  ["policy_version_mismatch", {
    status: 422,
    code: "video_asset_policy_version_mismatch",
    message: "参考素材授权与审核决定策略版本已失效",
  }],
  ["portrait_check_failed", {
    status: 409,
    code: "portrait_check_failed",
    message: "参考素材检查失败，请检查媒体服务配置后重新检测素材",
  }],
  ["portrait_pending", {
    status: 409,
    code: "portrait_admission_pending",
    message: "参考素材的人像校验尚未完成，请稍后重试",
  }],
  ["portrait_provider_pending", {
    status: 409,
    code: "portrait_provider_binding_pending",
    message: "参考素材的上游人像资产尚未就绪，请稍后重试",
  }],
  ["portrait_consent_invalid", {
    status: 409,
    code: "portrait_consent_inactive",
    message: "参考素材的人像授权未生效，请重新授权后重试",
  }],
  ["portrait_rejected", {
    status: 409,
    code: "portrait_admission_denied",
    message: "参考素材未通过人像准入校验",
  }],
  ["signing_unavailable", {
    status: 503,
    code: "video_policy_signing_unavailable",
    message: "视频素材策略签名能力不可用",
  }],
  ["storage_unavailable", {
    status: 503,
    code: "video_policy_storage_unavailable",
    message: "视频素材策略审计存储不可用",
  }],
]);

async function resolveReferencePolicy(input: {
  database: Knex | Knex.Transaction;
  workspaceId: string;
  projectId: string;
  assetVersionIds: string[];
}): Promise<VideoAssetPolicyResolution> {
  let resolution: VideoAssetPolicyResolution;
  try {
    resolution = await resolveVideoAssetPolicyDecisions(input);
  } catch (error) {
    if (error instanceof VideoAssetPolicyError) {
      throw new GenerationReferenceError(error.status, error.code, error.message);
    }
    throw error;
  }
  const rejected = resolution.decisions.find((decision) => decision.verdict !== "allowed");
  if (rejected) {
    const failure = policyFailure.get(rejected.verdict) || {
      status: 422,
      code: "video_asset_policy_denied",
      message: "参考素材未通过授权与审核",
    };
    // Portrait reasons are derived from current state in our policy code, not
    // copied from user input or upstream responses. Preserve the actionable cause.
    const message = rejected.verdict.startsWith("portrait_") && rejected.reason
      ? rejected.reason
      : failure.message;
    throw new GenerationReferenceError(failure.status, failure.code, message);
  }
  if (!resolution.trustedEvidence) {
    throw new GenerationReferenceError(
      503,
      "video_policy_evidence_unavailable",
      "视频素材策略证据不可用",
    );
  }
  return resolution;
}

export async function resolveCanonicalGenerationReferences(input: {
  workspaceId: string;
  projectId: string;
  actorUserId?: number;
  references: GenerationReference[];
  database?: Knex | Knex.Transaction;
}): Promise<ResolvedGenerationReferences> {
  const database = input.database ?? db;
  if (!input.references.length) {
    const policy = await resolveReferencePolicy({
      database,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      assetVersionIds: [],
    });
    return attachTrustedPolicyEvidence({
      inputs: [],
      providerContent: [],
      referenceDigest: sha256(stableJson([])),
    }, policy.trustedEvidence!);
  }

  const structure = await loadGenerationReferenceStructure({
    database,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    references: input.references,
    actorUserId: input.actorUserId,
  });

  // This is the single input-policy admission point shared by Quick, Canvas,
  // Agent and public video generation. It runs before storage URL resolution,
  // provider payload construction, capability pricing or dispatch.
  const policy = await resolveReferencePolicy({
    database,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    assetVersionIds: structure.ids,
  });

  const resolved: Record<string, unknown>[] = [];
  const canonicalInputs: VideoGenerationInput[] = [];
  for (const item of structure.loaded) {
    const { reference, row, filePath, kind } = item;
    const canonicalInput = canonicalReferenceInput(item);
    const preparedFilePath = reference.trim && (kind === "audio" || kind === "video")
      ? await materializeReferenceMediaTrim({
          workspaceId: policy.trustedEvidence!.workspaceId,
          projectId: String(row.sourceProjectId),
          assetVersionId: canonicalInput.assetVersionId,
          filePath, mediaType: kind, trim: reference.trim,
        })
      : filePath;
    const url = await resolveStoredProviderUrl(
      preparedFilePath,
      kind,
      kind === "video" && !reference.trim
        ? () => resolveTrustedRelayProviderVideoUrl({
            database,
            workspaceId: input.workspaceId,
            projectId: String(row.sourceProjectId),
            assetId: String(row.assetId),
            assetVersionId: String(row.id),
            filePath,
            storageKey: String(row.storageKey || "").trim(),
          })
        : undefined,
    );
    const content = providerContent(url, kind, reference.role);
    if (reference.trim) bindPreparedReferenceTrim(canonicalInput, content);
    resolved.push(content);
    canonicalInputs.push(canonicalInput);
  }
  try {
    // Reuse the provider-boundary size checks here so an oversized group is
    // rejected before capability routing, pricing, task persistence or GU
    // reservation. The returned objects intentionally retain reference_role
    // for internal capability validation.
    normalizeAndValidateProviderVideoPayload({ content: resolved });
  } catch (error) {
    if (error instanceof ProviderReferencePayloadError) {
      throw new GenerationReferenceError(error.status, error.code, error.message);
    }
    throw error;
  }
  return attachTrustedPolicyEvidence({
    inputs: canonicalInputs,
    providerContent: resolved,
    referenceDigest: sha256(stableJson(canonicalInputs)),
  }, policy.trustedEvidence!);
}

/** Provider-shaped compatibility view retained for image and legacy callers. */
export async function resolveGenerationReferences(input: {
  workspaceId: string;
  projectId: string;
  actorUserId?: number;
  references: GenerationReference[];
  database?: Knex | Knex.Transaction;
}): Promise<Record<string, unknown>[]> {
  return (await resolveCanonicalGenerationReferences(input)).providerContent;
}
