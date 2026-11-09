import { isAutomaticPortrait } from "@/lib/portraitAutomaticRegistration";
import crypto from "node:crypto";
import os from "node:os";
import type { Knex } from "knex";
import { mediaServiceTable, findMediaService, acceptsImageXNewJobs } from "@/lib/mediaServices";
import { MEDIA_SERVICE_TABLE } from "@/lib/migrations/mediaServices";
import { db } from "@/utils/db";
import u from "@/utils";
import { getReleaseIdentity } from "@/lib/releaseIdentity";
import { PORTRAIT_ADMISSION_TABLE } from "@/lib/migrations/portraitAssetAdmission";
import {
  inspectProviderChannelImageXReviewCredential,
  readProviderChannelImageXReviewCredentialMetadata,
} from "@/lib/providerChannelCredentials";
import { openSecret, sealSecret, secretPurposeHmac } from "@/lib/secretEnvelope";
import {
  acquireFormalCandidateImageXReviewLease,
  disposeFormalCandidateImageXImageOperation,
  disposeFormalCandidateImageXReviewLease,
  FormalCandidateCredentialRuntimeError,
  isFormalCandidateCredentialRuntimeDeclared,
  isFormalCandidateRuntimeCapabilityDeclared,
  runFormalCandidateImageXFaceDetection,
  runFormalCandidateImageXImageAudit,
} from "@/lib/formalCandidateCredentialRuntime";
import {
  FORMAL_CANDIDATE_PORTRAIT_IMAGEX_REVIEW_MODEL,
  PORTRAIT_IMAGEX_REVIEW_RUNTIME_CAPABILITY,
} from "@/lib/portraitRuntimeCapability";
import { acquirePortraitImageXChannelMutationLock } from "@/lib/portraitImageXCredentialRotationGuard";
import {
  createVolcengineImageXReviewClient,
  VolcengineImageXReviewError,
  type VolcengineImageAuditResult,
  type VolcengineImageFaceResult,
  type VolcengineImageXReviewProviderChannel,
  type VolcengineVideoAuditPollResult,
  type VolcengineVideoAuditSubmission,
} from "@/lib/volcengineImageXReview";
import { preparePortraitAuditImage } from "@/lib/portraitAuditImage";

export const PORTRAIT_IMAGEX_REVIEW_JOB_TABLE = "o_portrait_imagex_review_job";
export const PORTRAIT_IMAGEX_REVIEW_POLICY_VERSION = "fanjin-imagex-portrait-review/v1";
export const PORTRAIT_IMAGEX_REVIEW_WORKER_HEARTBEAT_ROLE =
  "portrait-imagex-review" as const;

const MAX_BATCH = 8;
const WORKER_INTERVAL_MS = 5_000;
const WORKER_LEASE_MS = 45_000;
const VIDEO_POLL_INTERVAL_MS = 10_000;
const VIDEO_POLL_DEADLINE_MS = 20 * 60_000;
const STALE_SUBMISSION_REASON = "IMAGEX_VIDEO_SUBMISSION_OUTCOME_UNKNOWN";
const TASK_SECRET_PURPOSE = "portrait-imagex-video-task/v1";
const MARKER_SECRET_PURPOSE = "portrait-imagex-video-marker/v1";
const DATA_ID_PURPOSE = "portrait-imagex-data-id/v1";

type Row = Record<string, any>;
type Database = Knex | Knex.Transaction;

export type PortraitImageXRuntimeInspection = Readonly<{
  configured: boolean;
  valid: boolean;
  reason: string | null;
  channelCount: number;
}>;

export type PortraitImageXReviewWorkerInspection = Readonly<{
  running: boolean;
  inFlight: boolean;
  lastTickAt: number | null;
  lastSuccessAt: number | null;
  safeReason: "imagex_review_channel_unavailable" | "imagex_review_worker_tick_failed" | null;
}>;

export type PortraitImageXFaceDecision = Readonly<{
  state: "no_face" | "single_face" | "multiple_faces";
  faceCount: number;
  confidence: null;
  detectorName: "volcano-imagex";
  detectorVersion: typeof PORTRAIT_IMAGEX_REVIEW_POLICY_VERSION;
  evidenceHash: string;
  evidence: Readonly<Record<string, unknown>>;
  coverage: "full_image";
}>;

export type PortraitImageXSampleFrameDecision = Readonly<{
  faceCount: number;
  evidenceHash: string;
  detectorVersion: typeof PORTRAIT_IMAGEX_REVIEW_POLICY_VERSION;
}>;

export type PortraitImageXModerationDecision = Readonly<{
  state: "allowed" | "denied";
  policyVersion: typeof PORTRAIT_IMAGEX_REVIEW_POLICY_VERSION;
  reasonCode: string | null;
  evidenceHash: string;
}>;

export interface PortraitImageXReviewClient {
  readonly channelId: string;
  readonly credentialGeneration: number;
  detectImageFaces(input: {
    imageUri: string;
    signal?: AbortSignal;
  }): Promise<VolcengineImageFaceResult>;
  auditImage(input: {
    dataId: string;
    imageUri: string;
    signal?: AbortSignal;
  }): Promise<VolcengineImageAuditResult>;
  createVideoAuditTask(input: {
    dataId: string;
    signal?: AbortSignal;
    videoUri: string;
  }): Promise<VolcengineVideoAuditSubmission>;
  getVideoAuditResult(input: {
    sourceUrlHash: string;
    dataId: string;
    limit?: number;
    marker?: string;
    signal?: AbortSignal;
    taskId: string;
  }): Promise<VolcengineVideoAuditPollResult>;
}

export type PortraitImageXReviewClientFactory = (
  channel: VolcengineImageXReviewProviderChannel,
) => PortraitImageXReviewClient;

type BoundChannel = Readonly<{
  row: Row;
  channelId: string;
  credentialGeneration: number;
}>;

export type PortraitImageXReviewWorkerDependencies = Readonly<{
  database?: Knex;
  clientFactory?: PortraitImageXReviewClientFactory;
  resolveSourceUrl?: (storagePath: string) => Promise<string>;
  now?: () => number;
  workerId?: string;
}>;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(row[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function sha256(value: unknown): string {
  return crypto.createHash("sha256").update(
    typeof value === "string" ? value : stableJson(value),
  ).digest("hex");
}

function safeId(value: unknown, label: string): string {
  const text = String(value ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(text)) {
    throw new Error(`${label}_invalid`);
  }
  return text;
}

function safeSourceSha256(value: unknown): string {
  const digest = String(value ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error("portrait_source_hash_invalid");
  return digest;
}

function canonicalHttpsUrl(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!text || text.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(text)) {
    throw new Error("portrait_source_url_invalid");
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error("portrait_source_url_invalid");
  }
  if (
    url.protocol !== "https:"
    || !url.hostname
    || url.username
    || url.password
    || url.hash
  ) throw new Error("portrait_source_url_invalid");
  return url.toString();
}

function safeWorkerId(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(text)) {
    throw new Error("portrait_imagex_worker_id_invalid");
  }
  return text;
}

function safeGeneration(value: unknown): number {
  const generation = Number(value);
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error("portrait_imagex_credential_generation_invalid");
  }
  return generation;
}

function safeRevision(value: unknown): number {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("portrait_imagex_revision_invalid");
  }
  return revision;
}

function safePositiveInteger(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${label}_invalid`);
  return number;
}

function secretPurpose(kind: "task" | "marker", job: Row): string {
  const jobId = safeId(job.id, "imagex_job_id");
  const admissionId = safeId(job.admissionId, "imagex_admission_id");
  const prefix = kind === "task" ? TASK_SECRET_PURPOSE : MARKER_SECRET_PURPOSE;
  return `${prefix}:${jobId}:${admissionId}`;
}

function sealJobSecret(kind: "task" | "marker", value: string, job: Row): string {
  return sealSecret(value, secretPurpose(kind, job));
}

function openJobSecret(kind: "task" | "marker", value: unknown, job: Row): string {
  const envelope = String(value ?? "").trim();
  if (!envelope) return "";
  return openSecret(envelope, secretPurpose(kind, job));
}

function dataId(input: {
  admissionRevision: number;
  admissionId: string;
  assetVersionId: number;
  operation: "image-audit" | "video-audit";
  projectId: number;
  sourceSha256: string;
  workspaceId: string;
}): string {
  return secretPurposeHmac(stableJson({
    admissionId: input.admissionId,
    admissionRevision: input.admissionRevision,
    assetVersionId: input.assetVersionId,
    operation: input.operation,
    projectId: input.projectId,
    sourceSha256: input.sourceSha256,
    version: PORTRAIT_IMAGEX_REVIEW_POLICY_VERSION,
    workspaceId: input.workspaceId,
  }), DATA_ID_PURPOSE);
}

function channelScopeMatches(row: Row, workspaceId?: string): boolean {
  const scope = String(row.scope ?? "").trim();
  if (scope === "platform") return row.workspaceId == null;
  if (scope === "workspace") return Boolean(workspaceId) && String(row.workspaceId) === workspaceId;
  return false;
}

function boundChannel(row: Row): BoundChannel | null {
  const channelId = String(row.id ?? "").trim();
  if (!channelId) return null;
  try {
    if (isFormalCandidateCredentialRuntimeDeclared()) {
      const metadata = readProviderChannelImageXReviewCredentialMetadata(row.configJson);
      if (
        !isFormalCandidateRuntimeCapabilityDeclared(PORTRAIT_IMAGEX_REVIEW_RUNTIME_CAPABILITY)
        || !metadata.enabled
        || metadata.generation < 1
        || !/^hmac-sha256:[a-f0-9]{64}$/u.test(metadata.binding)
      ) return null;
      return Object.freeze({
        row,
        channelId,
        credentialGeneration: metadata.generation,
      });
    }
    const inspection = inspectProviderChannelImageXReviewCredential(channelId, row.configJson);
    if (!inspection.enabled || !inspection.configured || inspection.generation < 1) return null;
    return Object.freeze({
      row,
      channelId,
      credentialGeneration: inspection.generation,
    });
  } catch {
    return null;
  }
}

async function usableChannels(database: Database, workspaceId?: string): Promise<BoundChannel[]> {
  const table = await mediaServiceTable(database);
  const rows = await database(table)
    .where({ kind: "imagex", disabled: 0 })
    .orderBy("priority", "asc")
    .orderBy("id", "asc")
    .select("*");
  return rows
    .filter((row: Row) => acceptsImageXNewJobs(row))
    .filter((row: Row) => channelScopeMatches(row, workspaceId))
    .map(boundChannel)
    .filter((row: BoundChannel | null): row is BoundChannel => row !== null)
    .sort((left, right) => {
      const leftWorkspace = String(left.row.scope) === "workspace" ? 0 : 1;
      const rightWorkspace = String(right.row.scope) === "workspace" ? 0 : 1;
      return leftWorkspace - rightWorkspace;
    });
}

async function resolveChannel(database: Database, workspaceId: string): Promise<BoundChannel> {
  const channels = await usableChannels(database, workspaceId);
  if (!channels[0]) {
    throw new VolcengineImageXReviewError({
      code: "PORTRAIT_IMAGEX_CHANNEL_UNAVAILABLE",
      dispatchState: "not_dispatched",
      message: "ImageX 审核通道未配置",
    });
  }
  return channels[0];
}

async function resolveExactChannel(input: {
  database: Database;
  channelId: string;
  credentialGeneration: number;
  workspaceId: string;
}): Promise<BoundChannel> {
  const row = await findMediaService(input.database, input.channelId, "imagex");
  if (!row || Number(row.disabled) !== 0 || (row.kind !== "imagex" && row.healthStatus !== "ok") || !channelScopeMatches(row, input.workspaceId)) {
    throw new Error("portrait_imagex_channel_binding_mismatch");
  }
  const bound = boundChannel(row);
  if (!bound || bound.credentialGeneration !== input.credentialGeneration) {
    throw new Error("portrait_imagex_credential_binding_mismatch");
  }
  return bound;
}

function defaultClientFactory(channel: VolcengineImageXReviewProviderChannel) {
  return createVolcengineImageXReviewClient(channel);
}

function makeClient(
  channel: BoundChannel,
  factory: PortraitImageXReviewClientFactory = defaultClientFactory,
): PortraitImageXReviewClient {
  const client = factory({
    id: channel.channelId,
    provider: "volcano",
    endpointType: "video_generation",
    configJson: channel.row.configJson,
  });
  if (
    client.channelId !== channel.channelId
    || client.credentialGeneration !== channel.credentialGeneration
  ) throw new Error("portrait_imagex_client_binding_mismatch");
  return client;
}

async function withBoundClient<T>(input: {
  channel: BoundChannel;
  clientFactory?: PortraitImageXReviewClientFactory;
  operation: (client: PortraitImageXReviewClient) => Promise<T>;
}): Promise<T> {
  if (input.clientFactory) {
    return input.operation(makeClient(input.channel, input.clientFactory));
  }
  if (!isFormalCandidateCredentialRuntimeDeclared()) {
    return input.operation(makeClient(input.channel));
  }
  // A Promise (including one hidden inside a holder object) must never cross
  // the FD6 synchronous credential callback. Formal calls use the dedicated
  // bounded protocol lease below; one-shot image calls receive their own
  // formal-runtime lease rather than falling through this helper.
  throw new Error("FORMAL_CANDIDATE_IMAGEX_REVIEW_LEASE_REQUIRED");
}

function acquireBoundFormalVideoLease(input: {
  channel: BoundChannel;
  job: Row;
  marker?: string | null;
  taskId?: string | null;
}) {
  if (
    String(input.job.channelId) !== input.channel.channelId
    || Number(input.job.credentialGeneration) !== input.channel.credentialGeneration
  ) throw new Error("FORMAL_CANDIDATE_IMAGEX_REVIEW_BINDING_INVALID");
  const metadata = readProviderChannelImageXReviewCredentialMetadata(input.channel.row.configJson);
  if (
    metadata.generation !== input.channel.credentialGeneration
    || !/^hmac-sha256:[a-f0-9]{64}$/u.test(metadata.binding)
  ) throw new Error("FORMAL_CANDIDATE_IMAGEX_REVIEW_BINDING_INVALID");
  const submittedAt = input.job.submittedAt == null ? null : Number(input.job.submittedAt);
  return acquireFormalCandidateImageXReviewLease({
    request: {
      channelId: input.channel.channelId,
      provider: "volcano",
      endpointType: "video_generation",
      model: FORMAL_CANDIDATE_PORTRAIT_IMAGEX_REVIEW_MODEL,
    },
    operationId: safeId(input.job.id, "imagex_job_id"),
    dataId: safeId(input.job.dataId, "imagex_data_id"),
    sourceUrlHash: String(input.job.sourceUrlHash),
    credentialGeneration: input.channel.credentialGeneration,
    expectedCredentialBinding: metadata.binding,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.marker ? { marker: input.marker } : {}),
    ...(submittedAt === null
      ? {}
      : { expiresAtMs: submittedAt + VIDEO_POLL_DEADLINE_MS }),
  });
}

function formalImageXOperationInput(input: {
  channel: BoundChannel;
  operation: "face" | "image-audit";
  scopedBinding: Record<string, unknown>;
}) {
  const metadata = readProviderChannelImageXReviewCredentialMetadata(input.channel.row.configJson);
  if (
    metadata.generation !== input.channel.credentialGeneration
    || !/^hmac-sha256:[a-f0-9]{64}$/u.test(metadata.binding)
  ) throw new Error("FORMAL_CANDIDATE_IMAGEX_REVIEW_BINDING_INVALID");
  return {
    request: {
      channelId: input.channel.channelId,
      provider: "volcano",
      endpointType: "video_generation",
      model: FORMAL_CANDIDATE_PORTRAIT_IMAGEX_REVIEW_MODEL,
    },
    operationId: `imagex-${input.operation}-${sha256(input.scopedBinding)}`,
    credentialGeneration: input.channel.credentialGeneration,
    expectedCredentialBinding: metadata.binding,
  } as const;
}

function bindingEvidence(input: {
  admissionRevision: number;
  admissionId: string;
  assetVersionId: number;
  channelId: string;
  credentialGeneration: number;
  dataId?: string;
  operation: string;
  projectId: number;
  sourceSha256: string;
  sourceUrlHash: string;
  workspaceId: string;
}): Record<string, unknown> {
  return {
    bindingHash: sha256({
      admissionId: input.admissionId,
      admissionRevision: input.admissionRevision,
      assetVersionId: input.assetVersionId,
      channelId: input.channelId,
      credentialGeneration: input.credentialGeneration,
      dataId: input.dataId ?? null,
      operation: input.operation,
      projectId: input.projectId,
      sourceSha256: input.sourceSha256,
      sourceUrlHash: input.sourceUrlHash,
      workspaceId: input.workspaceId,
    }),
    policyVersion: PORTRAIT_IMAGEX_REVIEW_POLICY_VERSION,
    provider: "volcano-imagex",
  };
}

export async function inspectPortraitImageXReviewRuntimeConfiguration(input: {
  database?: Knex;
} = {}): Promise<PortraitImageXRuntimeInspection> {
  try {
    const channels = await usableChannels(input.database ?? db);
    return Object.freeze({
      configured: channels.length > 0,
      valid: channels.length > 0,
      reason: channels.length > 0 ? null : "imagex_review_channel_unavailable",
      channelCount: channels.length,
    });
  } catch {
    return Object.freeze({
      configured: false,
      valid: false,
      reason: "imagex_review_channel_inspection_failed",
      channelCount: 0,
    });
  }
}

async function assertExactImageAdmissionBinding(input: {
  admissionId: string;
  admissionRevision: number;
  assetVersionId: number;
  database: Database;
  operation: "face" | "moderation";
  projectId: number;
  sourceSha256: string;
  workspaceId: string;
}): Promise<void> {
  const admission = await input.database(PORTRAIT_ADMISSION_TABLE)
    .where({ id: input.admissionId })
    .first();
  if (
    !admission
    || String(admission.workspaceId) !== input.workspaceId
    || Number(admission.projectId) !== input.projectId
    || Number(admission.assetVersionId) !== input.assetVersionId
    || safeSourceSha256(admission.sourceSha256) !== input.sourceSha256
    || String(admission.mediaType) !== "image"
    || Number(admission.revision) !== input.admissionRevision
    || (input.operation === "face" && String(admission.faceScanState) !== "scanning")
    || (input.operation === "moderation" && String(admission.moderationState) !== "checking")
  ) throw new Error("portrait_imagex_admission_binding_mismatch");
}

export async function detectPortraitImageFacesWithImageX(input: {
  admissionId: string;
  admissionRevision: number;
  assetVersionId: number;
  clientFactory?: PortraitImageXReviewClientFactory;
  database?: Knex;
  projectId: number;
  signal?: AbortSignal;
  sourceSha256: string;
  sourceUrl: string;
  workspaceId: string;
}): Promise<PortraitImageXFaceDecision> {
  const database = input.database ?? db;
  const admissionId = safeId(input.admissionId, "portrait_admission_id");
  const admissionRevision = safePositiveInteger(input.admissionRevision, "portrait_admission_revision");
  const workspaceId = safeId(input.workspaceId, "workspace_id");
  const projectId = safePositiveInteger(input.projectId, "portrait_project_id");
  const assetVersionId = safePositiveInteger(input.assetVersionId, "portrait_asset_version_id");
  const sourceSha256 = safeSourceSha256(input.sourceSha256);
  const sourceUrl = canonicalHttpsUrl(input.sourceUrl);
  await assertExactImageAdmissionBinding({
    admissionId,
    admissionRevision,
    assetVersionId,
    database,
    operation: "face",
    projectId,
    sourceSha256,
    workspaceId,
  });
  const channel = await resolveChannel(database, workspaceId);
  const sourceUrlHash = sha256(sourceUrl);
  const result = !input.clientFactory && isFormalCandidateCredentialRuntimeDeclared()
    ? await runFormalCandidateImageXFaceDetection({
      ...formalImageXOperationInput({
        channel,
        operation: "face",
        scopedBinding: {
          admissionId,
          admissionRevision,
          assetVersionId,
          channelId: channel.channelId,
          credentialGeneration: channel.credentialGeneration,
          projectId,
          sourceSha256,
          sourceUrlHash,
          workspaceId,
        },
      }),
      imageUri: sourceUrl,
      signal: input.signal,
    })
    : await withBoundClient({
      channel,
      clientFactory: input.clientFactory,
      operation: (client) => client.detectImageFaces({ imageUri: sourceUrl, signal: input.signal }),
    });
  const state = result.classification === "none"
    ? "no_face" as const
    : result.classification === "single"
      ? "single_face" as const
      : "multiple_faces" as const;
  const binding = bindingEvidence({
    admissionId,
    admissionRevision,
    assetVersionId,
    channelId: channel.channelId,
    credentialGeneration: channel.credentialGeneration,
    operation: "image-face-detect",
    projectId,
    sourceSha256,
    sourceUrlHash,
    workspaceId,
  });
  const evidence = Object.freeze({
    ...binding,
    classification: result.classification,
    faceCount: result.faceCount,
    sourceSha256,
    version: "portrait-imagex-face-evidence/v1",
  });
  return Object.freeze({
    state,
    faceCount: result.faceCount,
    confidence: null,
    detectorName: "volcano-imagex",
    detectorVersion: PORTRAIT_IMAGEX_REVIEW_POLICY_VERSION,
    evidenceHash: sha256(evidence),
    evidence,
    coverage: "full_image",
  });
}

/**
 * Detect one ephemeral video sample without weakening the normal admission
 * binding used by full images. The caller owns source-byte verification,
 * exact-version temporary storage and cleanup; this function owns the exact
 * ImageX channel/credential binding and returns no URL or channel identifier.
 */
export async function detectPortraitVideoSampleFrameWithImageX(input: {
  clientFactory?: PortraitImageXReviewClientFactory;
  database?: Knex;
  frameSha256: string;
  frameUrl: string;
  sampleIndex: number;
  signal?: AbortSignal;
  sourceSha256: string;
  workspaceId: string;
}): Promise<PortraitImageXSampleFrameDecision> {
  const database = input.database ?? db;
  const workspaceId = safeId(input.workspaceId, "workspace_id");
  const sourceSha256 = safeSourceSha256(input.sourceSha256);
  const frameSha256 = safeSourceSha256(input.frameSha256);
  const frameUrl = canonicalHttpsUrl(input.frameUrl);
  const sampleIndex = Number(input.sampleIndex);
  if (!Number.isSafeInteger(sampleIndex) || sampleIndex < 0 || sampleIndex > 31) {
    throw new Error("portrait_video_sample_index_invalid");
  }
  const channel = await resolveChannel(database, workspaceId);
  const frameUrlHash = sha256(frameUrl);
  const scopedBinding = {
    channelId: channel.channelId,
    credentialGeneration: channel.credentialGeneration,
    frameSha256,
    frameUrlHash,
    operation: "video-sample-face-detect",
    sampleIndex,
    sourceSha256,
    workspaceId,
  };
  let result: VolcengineImageFaceResult;
  if (!input.clientFactory && isFormalCandidateCredentialRuntimeDeclared()) {
    const operation = formalImageXOperationInput({
      channel,
      operation: "face",
      scopedBinding,
    });
    try {
      result = await runFormalCandidateImageXFaceDetection({
        ...operation,
        imageUri: frameUrl,
        signal: input.signal,
      });
    } finally {
      disposeFormalCandidateImageXImageOperation(operation.operationId);
    }
  } else {
    result = await withBoundClient({
      channel,
      clientFactory: input.clientFactory,
      operation: (client) => client.detectImageFaces({
        imageUri: frameUrl,
        signal: input.signal,
      }),
    });
  }
  if (!Number.isSafeInteger(result.faceCount) || result.faceCount < 0) {
    throw new Error("portrait_video_sample_face_count_invalid");
  }
  const faceCount = Math.min(result.faceCount, 100);
  return Object.freeze({
    faceCount,
    detectorVersion: PORTRAIT_IMAGEX_REVIEW_POLICY_VERSION,
    evidenceHash: sha256({
      ...scopedBinding,
      channelId: sha256(channel.channelId),
      faceCount,
      version: "portrait-imagex-video-sample-evidence/v1",
    }),
  });
}

export async function moderatePortraitImageWithImageX(input: {
  admissionId: string;
  admissionRevision: number;
  assetVersionId: number;
  clientFactory?: PortraitImageXReviewClientFactory;
  database?: Knex;
  projectId: number;
  signal?: AbortSignal;
  sourceSha256: string;
  sourceUrl: string;
  workspaceId: string;
}): Promise<PortraitImageXModerationDecision> {
  const database = input.database ?? db;
  const admissionId = safeId(input.admissionId, "portrait_admission_id");
  const admissionRevision = safePositiveInteger(input.admissionRevision, "portrait_admission_revision");
  const workspaceId = safeId(input.workspaceId, "workspace_id");
  const projectId = safePositiveInteger(input.projectId, "portrait_project_id");
  const assetVersionId = safePositiveInteger(input.assetVersionId, "portrait_asset_version_id");
  const sourceSha256 = safeSourceSha256(input.sourceSha256);
  const sourceUrl = canonicalHttpsUrl(input.sourceUrl);
  await assertExactImageAdmissionBinding({
    admissionId,
    admissionRevision,
    assetVersionId,
    database,
    operation: "moderation",
    projectId,
    sourceSha256,
    workspaceId,
  });
  const channel = await resolveChannel(database, workspaceId);
  const scopedDataId = dataId({
    admissionRevision,
    admissionId,
    assetVersionId,
    operation: "image-audit",
    projectId,
    sourceSha256,
    workspaceId,
  });
  const sourceUrlHash = sha256(sourceUrl);
  // Large RGBA PNGs make ImageX SingleImageAudit fail with InternalError.RTCAudit
  // even when face detection on the same URI succeeds. Normalize before dispatch.
  let auditImageUri = sourceUrl;
  try {
    const prepared = await preparePortraitAuditImage({
      sourceSha256,
      sourceUrl,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    auditImageUri = prepared.imageUri;
  } catch {
    // If preparation fails, still try the original URI so a transient
    // normalization problem does not invent a content decision.
    auditImageUri = sourceUrl;
  }
  const result = !input.clientFactory && isFormalCandidateCredentialRuntimeDeclared()
    ? await runFormalCandidateImageXImageAudit({
      ...formalImageXOperationInput({
        channel,
        operation: "image-audit",
        scopedBinding: {
          admissionId,
          admissionRevision,
          assetVersionId,
          channelId: channel.channelId,
          credentialGeneration: channel.credentialGeneration,
          dataId: scopedDataId,
          projectId,
          sourceSha256,
          sourceUrlHash,
          workspaceId,
        },
      }),
      dataId: scopedDataId,
      imageUri: auditImageUri,
      signal: input.signal,
    })
    : await withBoundClient({
      channel,
      clientFactory: input.clientFactory,
      operation: (client) => client.auditImage({
        dataId: scopedDataId,
        imageUri: auditImageUri,
        signal: input.signal,
      }),
    });
  const evidence = {
    ...bindingEvidence({
      admissionId,
      admissionRevision,
      assetVersionId,
      channelId: channel.channelId,
      credentialGeneration: channel.credentialGeneration,
      dataId: scopedDataId,
      operation: "image-content-audit",
      projectId,
      sourceSha256,
      sourceUrlHash,
      workspaceId,
    }),
    advice: result.advice,
    decision: result.decision,
    imageType: result.imageType,
    sourceSha256,
    version: "portrait-imagex-moderation-evidence/v1",
  };
  return Object.freeze({
    state: result.decision === "allow" ? "allowed" : "denied",
    policyVersion: PORTRAIT_IMAGEX_REVIEW_POLICY_VERSION,
    reasonCode: result.decision === "allow" ? null : "imagex_image_denied",
    evidenceHash: sha256(evidence),
  });
}

function videoRequestEvidence(input: {
  admissionRevision: number;
  admissionId: string;
  assetVersionId: number;
  channelId: string;
  credentialGeneration: number;
  dataId: string;
  projectId: number;
  sourceSha256: string;
  sourceUrlHash: string;
  workspaceId: string;
}): string {
  return sha256({
    ...input,
    policyVersion: PORTRAIT_IMAGEX_REVIEW_POLICY_VERSION,
    taskType: "audit_video",
    type: "Url",
    version: "portrait-imagex-video-request/v1",
  });
}

function sameSha256(left: unknown, right: unknown): boolean {
  const aText = String(left ?? "").trim().toLowerCase();
  const bText = String(right ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(aText) || !/^[a-f0-9]{64}$/u.test(bText)) return false;
  const a = Buffer.from(aText, "hex");
  const b = Buffer.from(bText, "hex");
  return crypto.timingSafeEqual(a, b);
}

function materialAdmissionJobBinding(job: Row, admission: Row): boolean {
  try {
    return !(
      String(admission.id ?? "") !== String(job.admissionId ?? "")
      || String(admission.currentImageXReviewJobId ?? "") !== String(job.id ?? "")
      || String(admission.workspaceId ?? "") !== String(job.workspaceId ?? "")
      || Number(admission.projectId) !== Number(job.projectId)
      || Number(admission.assetVersionId) !== Number(job.assetVersionId)
      || safeSourceSha256(admission.sourceSha256) !== safeSourceSha256(job.sourceSha256)
      || String(admission.mediaType ?? "") !== "video"
      || String(admission.moderationState ?? "") !== "checking"
      || !(
        isAutomaticPortrait(admission)
        || ["no_face", "uncertain", "failed"].includes(String(admission.faceScanState ?? ""))
        || (
          String(admission.faceScanState ?? "") === "single_face"
          && String(admission.declarationState ?? "") === "confirmed"
        )
      )
      || String(job.policyVersion ?? "") !== PORTRAIT_IMAGEX_REVIEW_POLICY_VERSION
    );
  } catch {
    return false;
  }
}

function exactAdmissionJobBinding(job: Row, admission: Row): boolean {
  try {
    if (!materialAdmissionJobBinding(job, admission)) return false;
    const admissionRevision = safeRevision(admission.revision);
    const admissionId = safeId(job.admissionId, "imagex_admission_id");
    const assetVersionId = safePositiveInteger(job.assetVersionId, "imagex_asset_version_id");
    const projectId = safePositiveInteger(job.projectId, "imagex_project_id");
    const sourceSha256 = safeSourceSha256(job.sourceSha256);
    const workspaceId = safeId(job.workspaceId, "imagex_workspace_id");
    const expectedDataId = dataId({
      admissionRevision,
      admissionId,
      assetVersionId,
      operation: "video-audit",
      projectId,
      sourceSha256,
      workspaceId,
    });
    if (String(job.dataId) !== expectedDataId) return false;
    const expected = videoRequestEvidence({
      admissionRevision,
      admissionId,
      assetVersionId,
      channelId: safeId(job.channelId, "imagex_channel_id"),
      credentialGeneration: safeGeneration(job.credentialGeneration),
      dataId: expectedDataId,
      projectId,
      sourceSha256,
      sourceUrlHash: safeSourceSha256(job.sourceUrlHash),
      workspaceId,
    });
    return sameSha256(job.requestEvidenceHash, expected);
  } catch {
    return false;
  }
}

function terminalEvidence(job: Row, outcome: string, details: Record<string, unknown> = {}): string {
  return sha256({
    admissionId: String(job.admissionId),
    assetVersionId: Number(job.assetVersionId),
    channelId: String(job.channelId),
    credentialGeneration: Number(job.credentialGeneration),
    dataId: String(job.dataId),
    outcome,
    policyVersion: PORTRAIT_IMAGEX_REVIEW_POLICY_VERSION,
    requestEvidenceHash: String(job.requestEvidenceHash),
    sourceSha256: String(job.sourceSha256),
    sourceUrlHash: String(job.sourceUrlHash),
    taskIdHash: job.taskIdHash ? String(job.taskIdHash) : null,
    version: "portrait-imagex-video-result/v1",
    ...details,
  });
}

function resultingCompliance(row: Row, state: "allowed" | "denied"): string {
  if (state === "denied") return "denied";
  if (isAutomaticPortrait(row)) return "allowed";
  const scan = String(row.faceScanState || "");
  const subject = String(row.subjectKind || "");
  const declaration = String(row.declarationState || "");
  if (["no_face", "uncertain", "failed"].includes(scan) && subject === "ordinary") {
    return "not_required";
  }
  if (
    scan === "single_face"
    && declaration === "confirmed"
    && ["real_person", "virtual_person", "trusted_output", "detected_person"].includes(subject)
  ) return "allowed";
  return "pending";
}

function resultingProviderSync(row: Row, complianceState: string): string {
  const subject = String(row.subjectKind || "");
  if (complianceState !== "allowed") {
    return complianceState === "denied"
      && ["real_person", "virtual_person", "trusted_output", "detected_person"].includes(subject)
      ? "failed"
      : "not_needed";
  }
  if (subject === "real_person") return row.identityId ? "queued" : "authorizing";
  if (["virtual_person", "trusted_output", "detected_person"].includes(subject)) return "queued";
  return "not_needed";
}

async function finalizeAdmission(input: {
  database: Database;
  job: Row;
  moderationState: "allowed" | "denied" | "failed";
  evidenceHash: string | null;
  reasonCode: string;
  safeErrorCode: string | null;
  safeErrorMessage: string | null;
  now: number;
}): Promise<boolean> {
  const admission = await input.database(PORTRAIT_ADMISSION_TABLE)
    .where({ id: input.job.admissionId })
    .forUpdate()
    .first();
  if (!admission || !exactAdmissionJobBinding(input.job, admission)) return false;
  const complianceState = input.moderationState === "allowed"
    ? resultingCompliance(admission, "allowed")
    : input.moderationState === "denied" ? "denied" : "pending";
  const changed = await input.database(PORTRAIT_ADMISSION_TABLE).where({
    id: admission.id,
    revision: admission.revision,
    currentImageXReviewJobId: input.job.id,
  }).update({
    moderationState: input.moderationState,
    moderationEvidenceHash: input.evidenceHash,
    moderationPolicyVersion: PORTRAIT_IMAGEX_REVIEW_POLICY_VERSION,
    moderationReasonCode: input.reasonCode,
    moderationUpdatedAt: input.now,
    complianceState,
    providerSyncState: input.moderationState === "failed"
      ? "not_needed"
      : resultingProviderSync(admission, complianceState),
    safeErrorCode: input.safeErrorCode,
    safeErrorMessage: input.safeErrorMessage,
    revision: Number(admission.revision) + 1,
    updatedAt: input.now,
  });
  return changed === 1;
}

async function failAdmissionForBindingMismatch(input: {
  database: Database;
  admission: Row | null | undefined;
  job: Row;
  now: number;
}): Promise<void> {
  if (!input.admission || !materialAdmissionJobBinding(input.job, input.admission)) return;
  await input.database(PORTRAIT_ADMISSION_TABLE).where({
    id: input.admission.id,
    revision: input.admission.revision,
    currentImageXReviewJobId: input.job.id,
    moderationState: "checking",
  }).update({
    moderationState: "failed",
    moderationEvidenceHash: null,
    moderationPolicyVersion: PORTRAIT_IMAGEX_REVIEW_POLICY_VERSION,
    moderationReasonCode: "imagex_video_binding_stale",
    moderationUpdatedAt: input.now,
    complianceState: "pending",
    providerSyncState: "not_needed",
    safeErrorCode: "IMAGEX_VIDEO_BINDING_STALE",
    safeErrorMessage: "视频安全审核绑定已变化，请重新提交素材",
    revision: Number(input.admission.revision) + 1,
    updatedAt: input.now,
  });
}

async function prepareVideoJobs(input: {
  database: Knex;
  now: number;
  resolveSourceUrl: (storagePath: string) => Promise<string>;
}): Promise<number> {
  const rows = await input.database(`${PORTRAIT_ADMISSION_TABLE} as admission`)
    .innerJoin("o_image as version", "version.id", "admission.assetVersionId")
    .where({
      "admission.mediaType": "video",
      "admission.moderationState": "pending",
    })
    .where((builder) => builder
      .whereIn("admission.faceScanState", ["no_face", "uncertain", "failed"])
      .orWhere("admission.subjectKind", "detected_person")
      .orWhere((portrait) => portrait
        .where("admission.faceScanState", "single_face")
        .andWhere("admission.declarationState", "confirmed")))
    .whereNull("admission.currentImageXReviewJobId")
    .orderBy("admission.updatedAt", "asc")
    .limit(MAX_BATCH)
    .select("admission.*", "version.filePath");
  let prepared = 0;
  for (const row of rows) {
    let channel: BoundChannel;
    let sourceUrl: string;
    let sourceSha256: string;
    try {
      channel = await resolveChannel(input.database, String(row.workspaceId));
      sourceSha256 = safeSourceSha256(row.sourceSha256);
      sourceUrl = canonicalHttpsUrl(await input.resolveSourceUrl(String(row.filePath || "")));
    } catch {
      continue;
    }
    const id = crypto.randomUUID();
    const sourceUrlHash = sha256(sourceUrl);
    try {
      const inserted = await input.database.transaction(async (trx) => {
        await acquirePortraitImageXChannelMutationLock(trx, channel.channelId);
        let currentChannel: BoundChannel;
        try {
          currentChannel = await resolveExactChannel({
            database: trx,
            channelId: channel.channelId,
            credentialGeneration: channel.credentialGeneration,
            workspaceId: String(row.workspaceId),
          });
          if (currentChannel.row.kind === "imagex" && !acceptsImageXNewJobs(currentChannel.row)) return false;
        } catch {
          // An Admin rotation won the channel-generation fence after the
          // out-of-transaction queue scan. Never persist a stale-generation
          // job; the admission remains pending for the next worker pass.
          return false;
        }
        const admission = await trx(PORTRAIT_ADMISSION_TABLE)
          .where({ id: row.id })
          .forUpdate()
          .first();
        if (
          !admission
          || admission.currentImageXReviewJobId != null
          || String(admission.moderationState) !== "pending"
          || safeSourceSha256(admission.sourceSha256) !== sourceSha256
          || String(admission.workspaceId) !== String(row.workspaceId)
          || Number(admission.projectId) !== Number(row.projectId)
          || Number(admission.assetVersionId) !== Number(row.assetVersionId)
          || String(admission.mediaType) !== "video"
          || !(
            isAutomaticPortrait(admission)
            || ["no_face", "uncertain", "failed"].includes(String(admission.faceScanState))
            || (
              String(admission.faceScanState) === "single_face"
              && String(admission.declarationState) === "confirmed"
            )
          )
        ) return false;
        const admissionRevision = safeRevision(admission.revision) + 1;
        const scopedDataId = dataId({
          admissionRevision,
          admissionId: String(admission.id),
          assetVersionId: Number(admission.assetVersionId),
          operation: "video-audit",
          projectId: Number(admission.projectId),
          sourceSha256,
          workspaceId: String(admission.workspaceId),
        });
        const requestEvidenceHash = videoRequestEvidence({
          admissionRevision,
          admissionId: String(admission.id),
          assetVersionId: Number(admission.assetVersionId),
          channelId: currentChannel.channelId,
          credentialGeneration: currentChannel.credentialGeneration,
          dataId: scopedDataId,
          projectId: Number(admission.projectId),
          sourceSha256,
          sourceUrlHash,
          workspaceId: String(admission.workspaceId),
        });
        await trx(PORTRAIT_IMAGEX_REVIEW_JOB_TABLE).insert({
          id,
          admissionId: String(admission.id),
          workspaceId: String(admission.workspaceId),
          projectId: Number(admission.projectId),
          assetVersionId: Number(admission.assetVersionId),
          sourceSha256,
          channelId: currentChannel.channelId,
          credentialGeneration: currentChannel.credentialGeneration,
          dataId: scopedDataId,
          sourceUrlHash,
          requestEvidenceHash,
          state: "prepared",
          taskIdCiphertext: null,
          taskIdHash: null,
          pollMarkerCiphertext: null,
          pollMarkerHash: null,
          resultEvidenceHash: null,
          policyVersion: PORTRAIT_IMAGEX_REVIEW_POLICY_VERSION,
          safeReasonCode: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          submittedAt: null,
          lastPolledAt: null,
          completedAt: null,
          revision: 0,
          createdAt: input.now,
          updatedAt: input.now,
        });
        const changed = await trx(PORTRAIT_ADMISSION_TABLE)
          .where({ id: admission.id, revision: admission.revision })
          .whereNull("currentImageXReviewJobId")
          .update({
            currentImageXReviewJobId: id,
            moderationState: "checking",
            moderationEvidenceHash: null,
            moderationPolicyVersion: PORTRAIT_IMAGEX_REVIEW_POLICY_VERSION,
            moderationReasonCode: null,
            moderationUpdatedAt: null,
            revision: admissionRevision,
            updatedAt: input.now,
          });
        if (changed !== 1) throw new Error("portrait_imagex_admission_prepare_conflict");
        return true;
      });
      if (inserted) prepared += 1;
    } catch (caught: any) {
      // A unique binding winner is equivalent to another worker preparing the
      // same admission. All other failures remain fail-closed and are retried
      // without ever issuing an upstream POST.
      if (!String(caught?.code || "").includes("CONSTRAINT")) continue;
    }
  }
  return prepared;
}

async function markStaleSubmissionsUnknown(database: Knex, now: number): Promise<number> {
  const stale = await database(PORTRAIT_IMAGEX_REVIEW_JOB_TABLE)
    .where({ state: "submitting" })
    .whereNotNull("leaseExpiresAt")
    .andWhere("leaseExpiresAt", "<=", now)
    .limit(MAX_BATCH)
    .select("id", "admissionId");
  let changedCount = 0;
  for (const candidate of stale) {
    const changed = await database.transaction(async (trx) => {
      await trx(PORTRAIT_ADMISSION_TABLE)
        .where({ id: candidate.admissionId })
        .forUpdate()
        .first();
      const job = await trx(PORTRAIT_IMAGEX_REVIEW_JOB_TABLE)
        .where({ id: candidate.id, state: "submitting" })
        .andWhere("leaseExpiresAt", "<=", now)
        .forUpdate()
        .first();
      if (!job) return false;
      const updated = await trx(PORTRAIT_IMAGEX_REVIEW_JOB_TABLE).where({
        id: job.id,
        state: "submitting",
        revision: job.revision,
      }).andWhere("leaseExpiresAt", "<=", now).update({
        state: "submission_unknown",
        safeReasonCode: STALE_SUBMISSION_REASON,
        leaseOwner: null,
        leaseExpiresAt: null,
        completedAt: now,
        revision: Number(job.revision) + 1,
        updatedAt: now,
      });
      if (updated !== 1) return false;
      await finalizeAdmission({
        database: trx,
        job,
        moderationState: "failed",
        evidenceHash: null,
        reasonCode: "imagex_video_submission_unknown",
        safeErrorCode: STALE_SUBMISSION_REASON,
        safeErrorMessage: "视频安全审核提交结果未知，已停止自动重试，请联系管理员",
        now,
      });
      return true;
    });
    if (changed) changedCount += 1;
  }
  return changedCount;
}

async function claimPreparedJob(input: {
  database: Knex;
  jobId: string;
  now: number;
  sourceUrl: string;
  workerId: string;
}): Promise<{ job: Row; channel: BoundChannel } | null> {
  return input.database.transaction(async (trx) => {
    const hint = await trx(PORTRAIT_IMAGEX_REVIEW_JOB_TABLE)
      .where({ id: input.jobId, state: "prepared" })
      .select("admissionId")
      .first();
    if (!hint) return null;
    // All transactions touching both records lock admission before job. This
    // matches the prepare/finalize order and avoids a PostgreSQL deadlock.
    const admission = await trx(PORTRAIT_ADMISSION_TABLE)
      .where({ id: hint.admissionId })
      .forUpdate()
      .first();
    const job = await trx(PORTRAIT_IMAGEX_REVIEW_JOB_TABLE)
      .where({ id: input.jobId, state: "prepared" })
      .forUpdate()
      .first();
    if (!job) return null;
    if (!admission || !exactAdmissionJobBinding(job, admission)) {
      const evidenceHash = terminalEvidence(job, "stale_binding");
      await trx(PORTRAIT_IMAGEX_REVIEW_JOB_TABLE).where({
        id: job.id,
        state: "prepared",
        revision: job.revision,
      }).update({
        state: "failed",
        resultEvidenceHash: evidenceHash,
        safeReasonCode: "IMAGEX_VIDEO_BINDING_STALE",
        completedAt: input.now,
        revision: Number(job.revision) + 1,
        updatedAt: input.now,
      });
      await failAdmissionForBindingMismatch({
        database: trx,
        admission,
        job,
        now: input.now,
      });
      return null;
    }
    let channel: BoundChannel;
    try {
      channel = await resolveExactChannel({
        database: trx,
        channelId: String(job.channelId),
        credentialGeneration: Number(job.credentialGeneration),
        workspaceId: String(job.workspaceId),
      });
    } catch {
      const evidenceHash = terminalEvidence(job, "credential_binding_mismatch");
      await trx(PORTRAIT_IMAGEX_REVIEW_JOB_TABLE).where({ id: job.id }).update({
        state: "failed",
        resultEvidenceHash: evidenceHash,
        safeReasonCode: "IMAGEX_VIDEO_CREDENTIAL_BINDING_MISMATCH",
        completedAt: input.now,
        revision: Number(job.revision) + 1,
        updatedAt: input.now,
      });
      await finalizeAdmission({
        database: trx,
        job,
        moderationState: "failed",
        evidenceHash,
        reasonCode: "imagex_video_credential_changed",
        safeErrorCode: "IMAGEX_VIDEO_CREDENTIAL_BINDING_MISMATCH",
        safeErrorMessage: "视频安全审核凭据已变更，请重新提交素材",
        now: input.now,
      });
      return null;
    }
    const sourceUrlHash = sha256(input.sourceUrl);
    const requestEvidenceHash = videoRequestEvidence({
      admissionRevision: safeRevision(admission.revision),
      admissionId: String(job.admissionId),
      assetVersionId: Number(job.assetVersionId),
      channelId: String(job.channelId),
      credentialGeneration: Number(job.credentialGeneration),
      dataId: String(job.dataId),
      projectId: Number(job.projectId),
      sourceSha256: String(job.sourceSha256),
      sourceUrlHash,
      workspaceId: String(job.workspaceId),
    });
    const revision = Number(job.revision) + 1;
    const changed = await trx(PORTRAIT_IMAGEX_REVIEW_JOB_TABLE).where({
      id: job.id,
      state: "prepared",
      revision: job.revision,
    }).update({
      sourceUrlHash,
      requestEvidenceHash,
      state: "submitting",
      safeReasonCode: null,
      leaseOwner: input.workerId,
      leaseExpiresAt: input.now + WORKER_LEASE_MS,
      revision,
      updatedAt: input.now,
    });
    if (changed !== 1) return null;
    return {
      job: { ...job, sourceUrlHash, requestEvidenceHash, state: "submitting", revision },
      channel,
    };
  });
}

async function finishSubmission(input: {
  database: Knex;
  job: Row;
  now: number;
  submission: VolcengineVideoAuditSubmission;
  workerId: string;
}): Promise<boolean> {
  const taskId = safeId(input.submission.taskId, "imagex_task_id");
  if (input.submission.dataId !== input.job.dataId) throw new Error("imagex_submission_scope_mismatch");
  const taskIdHash = sha256(taskId);
  const taskIdCiphertext = sealJobSecret("task", taskId, input.job);
  return input.database.transaction(async (trx) => {
    const admission = await trx(PORTRAIT_ADMISSION_TABLE)
      .where({ id: input.job.admissionId })
      .forUpdate()
      .first();
    const job = await trx(PORTRAIT_IMAGEX_REVIEW_JOB_TABLE)
      .where({
        id: input.job.id,
        state: "submitting",
        revision: input.job.revision,
        leaseOwner: input.workerId,
      })
      .andWhere("leaseExpiresAt", ">", input.now)
      .forUpdate()
      .first();
    if (!job) return false;
    if (!admission || !exactAdmissionJobBinding(job, admission)) {
      const evidenceHash = terminalEvidence(job, "stale_binding_after_submission");
      await trx(PORTRAIT_IMAGEX_REVIEW_JOB_TABLE).where({
        id: job.id,
        state: "submitting",
        revision: job.revision,
        leaseOwner: input.workerId,
      }).update({
        state: "failed",
        resultEvidenceHash: evidenceHash,
        safeReasonCode: "IMAGEX_VIDEO_BINDING_STALE",
        leaseOwner: null,
        leaseExpiresAt: null,
        completedAt: input.now,
        revision: Number(job.revision) + 1,
        updatedAt: input.now,
      });
      await failAdmissionForBindingMismatch({
        database: trx,
        admission,
        job,
        now: input.now,
      });
      return false;
    }
    const changed = await trx(PORTRAIT_IMAGEX_REVIEW_JOB_TABLE).where({
      id: job.id,
      state: "submitting",
      revision: job.revision,
      leaseOwner: input.workerId,
    }).andWhere("leaseExpiresAt", ">", input.now).update({
      state: "polling",
      taskIdCiphertext,
      taskIdHash,
      leaseOwner: null,
      leaseExpiresAt: null,
      submittedAt: input.now,
      revision: Number(job.revision) + 1,
      updatedAt: input.now,
    });
    return changed === 1;
  });
}

function submissionFailure(caught: unknown): {
  state: "failed" | "submission_unknown";
  reason: string;
} {
  if (caught instanceof VolcengineImageXReviewError && caught.dispatchState === "not_dispatched") {
    return { state: "failed", reason: "IMAGEX_VIDEO_SUBMISSION_NOT_DISPATCHED" };
  }
  if (caught instanceof FormalCandidateCredentialRuntimeError) {
    return { state: "failed", reason: "IMAGEX_VIDEO_SUBMISSION_NOT_DISPATCHED" };
  }
  return { state: "submission_unknown", reason: STALE_SUBMISSION_REASON };
}

async function finishSubmissionFailure(input: {
  caught: unknown;
  database: Knex;
  job: Row;
  now: number;
  workerId: string;
}): Promise<boolean> {
  const failure = submissionFailure(input.caught);
  const evidenceHash = failure.state === "failed"
    ? terminalEvidence(input.job, "submission_not_dispatched")
    : null;
  return input.database.transaction(async (trx) => {
    await trx(PORTRAIT_ADMISSION_TABLE)
      .where({ id: input.job.admissionId })
      .forUpdate()
      .first();
    const job = await trx(PORTRAIT_IMAGEX_REVIEW_JOB_TABLE)
      .where({
        id: input.job.id,
        state: "submitting",
        revision: input.job.revision,
        leaseOwner: input.workerId,
      })
      .forUpdate()
      .first();
    if (!job) return false;
    const changed = await trx(PORTRAIT_IMAGEX_REVIEW_JOB_TABLE)
      .where({
        id: job.id,
        state: "submitting",
        revision: job.revision,
        leaseOwner: input.workerId,
      }).update({
        state: failure.state,
        resultEvidenceHash: evidenceHash,
        safeReasonCode: failure.reason,
        leaseOwner: null,
        leaseExpiresAt: null,
        completedAt: input.now,
        revision: Number(job.revision) + 1,
        updatedAt: input.now,
      });
    if (changed !== 1) return false;
    await finalizeAdmission({
      database: trx,
      job,
      moderationState: "failed",
      evidenceHash,
      reasonCode: failure.state === "submission_unknown"
        ? "imagex_video_submission_unknown"
        : "imagex_video_submission_failed",
      safeErrorCode: failure.reason,
      safeErrorMessage: failure.state === "submission_unknown"
        ? "视频安全审核提交结果未知，已停止自动重试，请联系管理员"
        : "视频安全审核暂时失败，请重新提交素材",
      now: input.now,
    });
    return true;
  });
}

async function processPreparedJobs(input: {
  clientFactory?: PortraitImageXReviewClientFactory;
  database: Knex;
  now: () => number;
  resolveSourceUrl: (storagePath: string) => Promise<string>;
  workerId: string;
}): Promise<{ claimed: number; processed: number }> {
  const rows = await input.database(`${PORTRAIT_IMAGEX_REVIEW_JOB_TABLE} as job`)
    .innerJoin("o_image as version", "version.id", "job.assetVersionId")
    .where("job.state", "prepared")
    .orderBy("job.updatedAt", "asc")
    .limit(MAX_BATCH)
    .select("job.id", "version.filePath");
  let claimed = 0;
  let processed = 0;
  for (const row of rows) {
    let sourceUrl: string;
    try {
      sourceUrl = canonicalHttpsUrl(await input.resolveSourceUrl(String(row.filePath || "")));
    } catch {
      continue;
    }
    const claimedAt = input.now();
    const claim = await claimPreparedJob({
      database: input.database,
      jobId: String(row.id),
      now: claimedAt,
      sourceUrl,
      workerId: input.workerId,
    });
    if (!claim) continue;
    claimed += 1;
    let formalLease: ReturnType<typeof acquireBoundFormalVideoLease> | null = null;
    try {
      formalLease = !input.clientFactory && isFormalCandidateCredentialRuntimeDeclared()
        ? acquireBoundFormalVideoLease({ channel: claim.channel, job: claim.job })
        : null;
      const submission = formalLease
        ? await formalLease.createVideoAuditTask({
          videoUri: sourceUrl,
          signal: new AbortController().signal,
        })
        : await withBoundClient({
          channel: claim.channel,
          clientFactory: input.clientFactory,
          operation: (client) => client.createVideoAuditTask({
            dataId: String(claim.job.dataId),
            videoUri: sourceUrl,
            signal: new AbortController().signal,
          }),
        });
      const finished = await finishSubmission({
        database: input.database,
        job: claim.job,
        now: input.now(),
        submission,
        workerId: input.workerId,
      });
      if (finished) processed += 1;
      else formalLease?.dispose();
    } catch (caught) {
      formalLease?.dispose();
      if (await finishSubmissionFailure({
        caught,
        database: input.database,
        job: claim.job,
        now: input.now(),
        workerId: input.workerId,
      })) processed += 1;
    }
  }
  return { claimed, processed };
}

function retryablePollError(caught: unknown): boolean {
  if (!(caught instanceof VolcengineImageXReviewError)) return false;
  if (["VOLC_IMAGEX_TIMEOUT", "VOLC_IMAGEX_TRANSPORT_FAILED", "VOLC_IMAGEX_ABORTED"].includes(caught.code)) {
    return true;
  }
  return caught.httpStatus === 429 || Boolean(caught.httpStatus && caught.httpStatus >= 500);
}

async function claimPollingJob(input: {
  database: Knex;
  jobId: string;
  now: number;
  workerId: string;
}): Promise<Row | null> {
  return input.database.transaction(async (trx) => {
    const hint = await trx(PORTRAIT_IMAGEX_REVIEW_JOB_TABLE)
      .where({ id: input.jobId, state: "polling" })
      .select("admissionId")
      .first();
    if (!hint) return null;
    const admission = await trx(PORTRAIT_ADMISSION_TABLE)
      .where({ id: hint.admissionId })
      .forUpdate()
      .first();
    const job = await trx(PORTRAIT_IMAGEX_REVIEW_JOB_TABLE)
      .where({ id: input.jobId, state: "polling" })
      .where((builder) => builder.whereNull("leaseExpiresAt").orWhere("leaseExpiresAt", "<=", input.now))
      .forUpdate()
      .first();
    if (!job) return null;
    if (!admission || !exactAdmissionJobBinding(job, admission)) {
      const evidenceHash = terminalEvidence(job, "stale_binding_before_poll");
      await trx(PORTRAIT_IMAGEX_REVIEW_JOB_TABLE).where({
        id: job.id,
        state: "polling",
        revision: job.revision,
      }).update({
        state: "failed",
        resultEvidenceHash: evidenceHash,
        safeReasonCode: "IMAGEX_VIDEO_BINDING_STALE",
        leaseOwner: null,
        leaseExpiresAt: null,
        completedAt: input.now,
        revision: Number(job.revision) + 1,
        updatedAt: input.now,
      });
      await failAdmissionForBindingMismatch({
        database: trx,
        admission,
        job,
        now: input.now,
      });
      return null;
    }
    const revision = Number(job.revision) + 1;
    const changed = await trx(PORTRAIT_IMAGEX_REVIEW_JOB_TABLE).where({
      id: job.id,
      state: "polling",
      revision: job.revision,
    }).update({
      leaseOwner: input.workerId,
      leaseExpiresAt: input.now + WORKER_LEASE_MS,
      revision,
      updatedAt: input.now,
    });
    if (changed !== 1) return null;
    return { ...job, revision, leaseOwner: input.workerId, leaseExpiresAt: input.now + WORKER_LEASE_MS };
  });
}

async function releasePollingJob(input: {
  database: Knex;
  job: Row;
  marker: string | null;
  now: number;
  workerId: string;
  safeReasonCode?: string | null;
}): Promise<boolean> {
  const marker = input.marker || "";
  const markerCiphertext = marker ? sealJobSecret("marker", marker, input.job) : null;
  const markerHash = marker ? sha256(marker) : null;
  const changed = await input.database(PORTRAIT_IMAGEX_REVIEW_JOB_TABLE)
    .where({
      id: input.job.id,
      state: "polling",
      revision: input.job.revision,
      leaseOwner: input.workerId,
    })
    .update({
      pollMarkerCiphertext: markerCiphertext,
      pollMarkerHash: markerHash,
      safeReasonCode: input.safeReasonCode ?? null,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastPolledAt: input.now,
      revision: Number(input.job.revision) + 1,
      updatedAt: input.now,
    });
  return changed === 1;
}

function pollOutcome(result: VolcengineVideoAuditPollResult): {
  state: "allowed" | "denied" | "review_required" | "failed";
  moderationState: "allowed" | "denied" | "failed";
  reasonCode: string;
  safeErrorCode: string | null;
  safeErrorMessage: string | null;
} {
  if (result.decision === "allow") {
    return {
      state: "allowed",
      moderationState: "allowed",
      reasonCode: "imagex_video_allowed",
      safeErrorCode: null,
      safeErrorMessage: null,
    };
  }
  if (result.decision === "deny") {
    return {
      state: "denied",
      moderationState: "denied",
      reasonCode: "imagex_video_denied",
      safeErrorCode: "IMAGEX_VIDEO_DENIED",
      safeErrorMessage: "视频素材未通过安全审核，请更换素材",
    };
  }
  if (result.decision === "review") {
    return {
      state: "review_required",
      moderationState: "failed",
      reasonCode: "imagex_video_review_required",
      safeErrorCode: "IMAGEX_VIDEO_REVIEW_REQUIRED",
      safeErrorMessage: "视频安全审核需要人工复核，暂不可用于生成",
    };
  }
  return {
    state: "failed",
    moderationState: "failed",
    reasonCode: "imagex_video_failed",
    safeErrorCode: "IMAGEX_VIDEO_REVIEW_FAILED",
    safeErrorMessage: "视频安全审核失败，请重新提交素材",
  };
}

async function finishPollTerminal(input: {
  database: Knex;
  job: Row;
  now: number;
  result: VolcengineVideoAuditPollResult;
  workerId: string;
}): Promise<boolean> {
  if (
    input.result.status !== "complete"
    || input.result.decision === "pending"
    || input.result.haveMore
    || input.result.taskId !== openJobSecret("task", input.job.taskIdCiphertext, input.job)
    || input.result.dataId !== input.job.dataId
  ) throw new Error("portrait_imagex_poll_binding_invalid");
  const outcome = pollOutcome(input.result);
  const evidenceHash = terminalEvidence(input.job, outcome.state, {
    decision: input.result.decision,
    problemCount: input.result.problemCount,
  });
  return input.database.transaction(async (trx) => {
    const admission = await trx(PORTRAIT_ADMISSION_TABLE)
      .where({ id: input.job.admissionId })
      .forUpdate()
      .first();
    const job = await trx(PORTRAIT_IMAGEX_REVIEW_JOB_TABLE)
      .where({
        id: input.job.id,
        state: "polling",
        revision: input.job.revision,
        leaseOwner: input.workerId,
      })
      .forUpdate()
      .first();
    if (!job) return false;
    if (!admission || !exactAdmissionJobBinding(job, admission)) {
      const staleEvidenceHash = terminalEvidence(job, "stale_binding_at_terminal");
      await trx(PORTRAIT_IMAGEX_REVIEW_JOB_TABLE).where({
        id: job.id,
        state: "polling",
        revision: job.revision,
        leaseOwner: input.workerId,
      }).update({
        state: "failed",
        resultEvidenceHash: staleEvidenceHash,
        safeReasonCode: "IMAGEX_VIDEO_BINDING_STALE",
        leaseOwner: null,
        leaseExpiresAt: null,
        lastPolledAt: input.now,
        completedAt: input.now,
        revision: Number(job.revision) + 1,
        updatedAt: input.now,
      });
      await failAdmissionForBindingMismatch({ database: trx, admission, job, now: input.now });
      return false;
    }
    const changed = await trx(PORTRAIT_IMAGEX_REVIEW_JOB_TABLE)
      .where({
        id: job.id,
        state: "polling",
        revision: job.revision,
        leaseOwner: input.workerId,
      })
      .update({
        state: outcome.state,
        resultEvidenceHash: evidenceHash,
        safeReasonCode: outcome.safeErrorCode,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastPolledAt: input.now,
        completedAt: input.now,
        revision: Number(job.revision) + 1,
        updatedAt: input.now,
      });
    if (changed !== 1) return false;
    await finalizeAdmission({
      database: trx,
      job,
      moderationState: outcome.moderationState,
      evidenceHash,
      reasonCode: outcome.reasonCode,
      safeErrorCode: outcome.safeErrorCode,
      safeErrorMessage: outcome.safeErrorMessage,
      now: input.now,
    });
    return true;
  });
}

async function finishPollFailure(input: {
  database: Knex;
  job: Row;
  now: number;
  reason: string;
  admissionReasonCode?: string;
  safeErrorMessage?: string;
  workerId: string;
}): Promise<boolean> {
  const evidenceHash = terminalEvidence(input.job, "failed", { reason: input.reason });
  return input.database.transaction(async (trx) => {
    const admission = await trx(PORTRAIT_ADMISSION_TABLE)
      .where({ id: input.job.admissionId })
      .forUpdate()
      .first();
    const job = await trx(PORTRAIT_IMAGEX_REVIEW_JOB_TABLE)
      .where({
        id: input.job.id,
        state: "polling",
        revision: input.job.revision,
        leaseOwner: input.workerId,
      })
      .forUpdate()
      .first();
    if (!job) return false;
    const changed = await trx(PORTRAIT_IMAGEX_REVIEW_JOB_TABLE)
      .where({
        id: job.id,
        state: "polling",
        revision: job.revision,
        leaseOwner: input.workerId,
      })
      .update({
        state: "failed",
        resultEvidenceHash: evidenceHash,
        safeReasonCode: input.reason,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastPolledAt: input.now,
        completedAt: input.now,
        revision: Number(job.revision) + 1,
        updatedAt: input.now,
      });
    if (changed !== 1) return false;
    await finalizeAdmission({
      database: trx,
      job,
      moderationState: "failed",
      evidenceHash,
      reasonCode: input.admissionReasonCode ?? "imagex_video_response_invalid",
      safeErrorCode: input.reason,
      safeErrorMessage: input.safeErrorMessage ?? "视频安全审核结果无效，暂不可用于生成",
      now: input.now,
    });
    return true;
  });
}

async function processPollingJobs(input: {
  clientFactory?: PortraitImageXReviewClientFactory;
  database: Knex;
  now: () => number;
  workerId: string;
}): Promise<{ claimed: number; processed: number }> {
  const currentTime = input.now();
  const rows = await input.database(PORTRAIT_IMAGEX_REVIEW_JOB_TABLE)
    .where({ state: "polling" })
    .where((builder) => builder.whereNull("leaseExpiresAt").orWhere("leaseExpiresAt", "<=", currentTime))
    .where((builder) => builder
      .whereNull("lastPolledAt")
      .orWhere("lastPolledAt", "<=", currentTime - VIDEO_POLL_INTERVAL_MS))
    .orderBy("updatedAt", "asc")
    .limit(MAX_BATCH)
    .select("id");
  let claimed = 0;
  let processed = 0;
  for (const row of rows) {
    const job = await claimPollingJob({
      database: input.database,
      jobId: String(row.id),
      now: input.now(),
      workerId: input.workerId,
    });
    if (!job) continue;
    claimed += 1;
    let formalLease: ReturnType<typeof acquireBoundFormalVideoLease> | null = null;
    try {
      const submittedAt = Number(job.submittedAt);
      const pollTime = input.now();
      if (
        !Number.isSafeInteger(submittedAt)
        || submittedAt > pollTime
        || pollTime - submittedAt >= VIDEO_POLL_DEADLINE_MS
      ) {
        disposeFormalCandidateImageXReviewLease(String(job.id));
        if (await finishPollFailure({
          database: input.database,
          job,
          now: pollTime,
          reason: "IMAGEX_VIDEO_POLL_DEADLINE_EXCEEDED",
          admissionReasonCode: "imagex_video_poll_deadline_exceeded",
          safeErrorMessage: "视频安全审核等待超时，请重新提交素材",
          workerId: input.workerId,
        })) processed += 1;
        continue;
      }
      const taskId = openJobSecret("task", job.taskIdCiphertext, job);
      if (!taskId || sha256(taskId) !== String(job.taskIdHash || "")) {
        throw new Error("portrait_imagex_task_binding_invalid");
      }
      const marker = openJobSecret("marker", job.pollMarkerCiphertext, job);
      if ((marker ? sha256(marker) : null) !== (job.pollMarkerHash || null)) {
        throw new Error("portrait_imagex_marker_binding_invalid");
      }
      const channel = await resolveExactChannel({
        database: input.database,
        channelId: String(job.channelId),
        credentialGeneration: Number(job.credentialGeneration),
        workspaceId: String(job.workspaceId),
      });
      formalLease = !input.clientFactory && isFormalCandidateCredentialRuntimeDeclared()
        ? acquireBoundFormalVideoLease({ channel, job, marker, taskId })
        : null;
      const result = formalLease
        ? await formalLease.getVideoAuditResult({ signal: new AbortController().signal })
        : await withBoundClient({
          channel,
          clientFactory: input.clientFactory,
          operation: (client) => client.getVideoAuditResult({
            dataId: String(job.dataId),
            sourceUrlHash: String(job.sourceUrlHash),
            ...(marker ? { marker } : {}),
            signal: new AbortController().signal,
            taskId,
          }),
        });
      if (result.status === "pending" && result.decision === "pending") {
        const released = await releasePollingJob({
          database: input.database,
          job,
          marker: result.marker,
          now: input.now(),
          workerId: input.workerId,
        });
        if (released) processed += 1;
        else formalLease?.dispose();
      } else {
        const finished = await finishPollTerminal({
          database: input.database,
          job,
          now: input.now(),
          result,
          workerId: input.workerId,
        });
        formalLease?.dispose();
        if (finished) processed += 1;
      }
    } catch (caught) {
      if (retryablePollError(caught)) {
        const released = await releasePollingJob({
          database: input.database,
          job,
          marker: openJobSecret("marker", job.pollMarkerCiphertext, job) || null,
          now: input.now(),
          safeReasonCode: "IMAGEX_VIDEO_POLL_RETRYABLE",
          workerId: input.workerId,
        });
        if (released) processed += 1;
        else formalLease?.dispose();
      } else {
        formalLease?.dispose();
        disposeFormalCandidateImageXReviewLease(String(job.id));
        if (await finishPollFailure({
          database: input.database,
          job,
          now: input.now(),
          reason: "IMAGEX_VIDEO_RESPONSE_INVALID",
          workerId: input.workerId,
        })) processed += 1;
      }
    }
  }
  return { claimed, processed };
}

/** Recover a parser/poll failure by reading the original provider task once.
 * Never creates another audit task or resets completed face detection. */
export async function recoverPortraitVideoReviewResult(input: {
  database: Knex; workspaceId: string; projectId: number; assetVersionId: number;
  expectedRevision?: number | null; clientFactory?: PortraitImageXReviewClientFactory;
}): Promise<boolean> {
  const admission = await input.database(PORTRAIT_ADMISSION_TABLE)
    .where({ workspaceId: input.workspaceId, projectId: input.projectId, assetVersionId: input.assetVersionId }).first();
  if (!admission || admission.mediaType !== "video" || admission.moderationState !== "failed"
    || !admission.currentImageXReviewJobId) return false;
  if (input.expectedRevision != null && Number(input.expectedRevision) !== Number(admission.revision)) return false;
  const job = await input.database(PORTRAIT_IMAGEX_REVIEW_JOB_TABLE)
    .where({ id: admission.currentImageXReviewJobId, state: "failed" }).first();
  if (!job || !["IMAGEX_VIDEO_RESPONSE_INVALID", "IMAGEX_VIDEO_POLL_DEADLINE_EXCEEDED"].includes(job.safeReasonCode)) return false;
  // A terminal failure increments the admission revision exactly once. Verify
  // its original signed request evidence without changing either revision.
  if (!exactAdmissionJobBinding(job, { ...admission, moderationState: "checking", revision: Number(admission.revision) - 1 })
    || admission.moderationEvidenceHash !== job.resultEvidenceHash) return false;
  const channel = await resolveExactChannel({ database: input.database, channelId: job.channelId,
    credentialGeneration: Number(job.credentialGeneration), workspaceId: input.workspaceId });
  const taskId = openJobSecret("task", job.taskIdCiphertext, job);
  const formalLease = !input.clientFactory && isFormalCandidateCredentialRuntimeDeclared()
    ? acquireFormalCandidateImageXReviewLease({
      request: { channelId: channel.channelId, provider: "volcano", endpointType: "video_generation", model: FORMAL_CANDIDATE_PORTRAIT_IMAGEX_REVIEW_MODEL },
      operationId: `recover:${job.id}`, dataId: job.dataId, taskId, sourceUrlHash: job.sourceUrlHash,
      credentialGeneration: channel.credentialGeneration,
      expectedCredentialBinding: readProviderChannelImageXReviewCredentialMetadata(channel.row.configJson).binding,
      expiresAtMs: Date.now() + 60_000,
    }) : null;
  let result: VolcengineVideoAuditPollResult;
  try {
    result = formalLease ? await formalLease.getVideoAuditResult()
      : await withBoundClient({ channel, clientFactory: input.clientFactory,
        operation: (client) => client.getVideoAuditResult({ dataId: job.dataId, taskId, sourceUrlHash: job.sourceUrlHash }) });
  } finally { formalLease?.dispose(); }
  if (result.taskId !== taskId || result.dataId !== job.dataId) throw new Error("portrait_imagex_recovery_binding_mismatch");
  if (result.status === "pending") return true;
  const outcome = pollOutcome(result);
  const evidenceHash = terminalEvidence(job, outcome.state, result);
  await input.database.transaction(async (trx) => {
    const current = await trx(PORTRAIT_ADMISSION_TABLE).where({ id: admission.id }).forUpdate().first();
    const currentJob = await trx(PORTRAIT_IMAGEX_REVIEW_JOB_TABLE).where({ id: job.id }).forUpdate().first();
    if (!current || !currentJob || Number(current.revision) !== Number(admission.revision)
      || Number(currentJob.revision) !== Number(job.revision) || currentJob.state !== "failed"
      || current.currentImageXReviewJobId !== job.id || current.sourceSha256 !== job.sourceSha256) return;
    const now = Date.now();
    const complianceState = outcome.moderationState === "allowed" ? resultingCompliance(current, "allowed")
      : outcome.moderationState === "denied" ? "denied" : "pending";
    await trx(PORTRAIT_IMAGEX_REVIEW_JOB_TABLE).where({ id: job.id }).update({
      state: outcome.state, resultEvidenceHash: evidenceHash, safeReasonCode: outcome.safeErrorCode,
      lastPolledAt: now, completedAt: now, updatedAt: now, revision: Number(job.revision) + 1,
    });
    await trx(PORTRAIT_ADMISSION_TABLE).where({ id: admission.id }).update({
      moderationState: outcome.moderationState, moderationEvidenceHash: evidenceHash,
      moderationPolicyVersion: PORTRAIT_IMAGEX_REVIEW_POLICY_VERSION, moderationReasonCode: outcome.reasonCode,
      moderationUpdatedAt: now, complianceState, providerSyncState: resultingProviderSync(current, complianceState),
      safeErrorCode: outcome.safeErrorCode, safeErrorMessage: outcome.safeErrorMessage,
      updatedAt: now, revision: Number(admission.revision) + 1,
    });
  });
  return true;
}

export async function runPortraitImageXReviewBatch(
  dependencies: PortraitImageXReviewWorkerDependencies = {},
): Promise<{ claimed: number; processed: number; configured: boolean }> {
  const database = dependencies.database ?? db;
  const inspection = await inspectPortraitImageXReviewRuntimeConfiguration({ database });
  const acceptsNewWork = inspection.configured && inspection.valid;
  // Draining keeps already bound tasks queryable even when every service has
  // stopped accepting new work. Missing schema still fails closed.
  if (!acceptsNewWork && !(await database.schema.hasTable(PORTRAIT_IMAGEX_REVIEW_JOB_TABLE))) {
    return { claimed: 0, processed: 0, configured: false };
  }
  const now = dependencies.now ?? Date.now;
  const workerId = safeWorkerId(
    dependencies.workerId ?? `imagex-review-${process.pid}-${crypto.randomUUID()}`,
  );
  const resolveSourceUrl = dependencies.resolveSourceUrl
    ?? ((storagePath: string) => u.oss.getPrivateFileUrl(storagePath, { expiresInSeconds: 300 }));
  const stale = await markStaleSubmissionsUnknown(database, now());
  if (acceptsNewWork) await prepareVideoJobs({ database, now: now(), resolveSourceUrl });
  const prepared = await processPreparedJobs({
    clientFactory: dependencies.clientFactory,
    database,
    now,
    resolveSourceUrl,
    workerId,
  });
  const polling = await processPollingJobs({
    clientFactory: dependencies.clientFactory,
    database,
    now,
    workerId,
  });
  return {
    claimed: prepared.claimed + polling.claimed,
    processed: stale + prepared.processed + polling.processed,
    configured: acceptsNewWork,
  };
}

let workerTimer: NodeJS.Timeout | null = null;
let workerTick: Promise<unknown> | null = null;
let workerRunning = false;
let workerLastTickAt: number | null = null;
let workerLastSuccessAt: number | null = null;
let workerSafeReason: PortraitImageXReviewWorkerInspection["safeReason"] = null;
let workerHeartbeatDatabase: Knex | null = null;
let workerHeartbeatId: string | null = null;
let workerHeartbeatIncarnationId: string | null = null;
let workerStartedAt: number | null = null;

function workerNodeId(): string | null {
  const value = String(
    process.env.FANJIN_RELEASE_NODE_ID
      || process.env.FANJIN_NODE_ID
      || "",
  ).trim();
  return value || null;
}

async function writePortraitImageXReviewWorkerHeartbeat(input: {
  acceptingWork: 0 | 1;
  activeTaskCount: 0 | 1;
  heartbeatAt: number;
}): Promise<void> {
  const database = workerHeartbeatDatabase;
  const id = workerHeartbeatId;
  const incarnationId = workerHeartbeatIncarnationId;
  const startedAt = workerStartedAt;
  if (!database || !id || !incarnationId || startedAt == null) return;
  const release = getReleaseIdentity();
  const patch = {
    role: PORTRAIT_IMAGEX_REVIEW_WORKER_HEARTBEAT_ROLE,
    hostname: os.hostname(),
    processId: process.pid,
    nodeId: workerNodeId(),
    incarnationId,
    releaseId: release.releaseId,
    artifactSha256: release.artifactSha256,
    schemaVersion: release.schemaVersion,
    acceptingWork: input.acceptingWork,
    activeTaskCount: input.activeTaskCount,
    drainOperationId: null,
    controlRevision: null,
    heartbeatAt: input.heartbeatAt,
    updatedAt: input.heartbeatAt,
  };
  const updated = await database("o_worker_heartbeat")
    .where({ id, incarnationId })
    .update(patch);
  if (Number(updated) > 0) return;
  try {
    await database("o_worker_heartbeat").insert({
      id,
      ...patch,
      startedAt,
      createdAt: startedAt,
    });
  } catch (error) {
    const retried = await database("o_worker_heartbeat")
      .where({ id, incarnationId })
      .update(patch);
    if (Number(retried) === 0) throw error;
  }
}

async function removePortraitImageXReviewWorkerHeartbeat(): Promise<void> {
  const database = workerHeartbeatDatabase;
  const id = workerHeartbeatId;
  const incarnationId = workerHeartbeatIncarnationId;
  if (!database || !id || !incarnationId) return;
  await database("o_worker_heartbeat")
    .where({
      id,
      incarnationId,
      role: PORTRAIT_IMAGEX_REVIEW_WORKER_HEARTBEAT_ROLE,
    })
    .delete()
    .catch(() => undefined);
}

export function inspectPortraitImageXReviewWorker(): PortraitImageXReviewWorkerInspection {
  return Object.freeze({
    running: workerRunning,
    inFlight: workerTick !== null,
    lastTickAt: workerLastTickAt,
    lastSuccessAt: workerLastSuccessAt,
    safeReason: workerSafeReason,
  });
}

export function startPortraitImageXReviewWorker(
  dependencies: PortraitImageXReviewWorkerDependencies = {},
): void {
  if (workerRunning) return;
  workerRunning = true;
  workerSafeReason = null;
  const clock = dependencies.now ?? Date.now;
  workerHeartbeatDatabase = dependencies.database ?? db;
  workerHeartbeatIncarnationId = crypto.randomUUID();
  workerHeartbeatId = `${PORTRAIT_IMAGEX_REVIEW_WORKER_HEARTBEAT_ROLE}:${os.hostname()}:${process.pid}:${workerHeartbeatIncarnationId}`;
  workerStartedAt = clock();
  const run = () => {
    if (!workerRunning || workerTick) return;
    workerLastTickAt = clock();
    workerTick = runPortraitImageXReviewBatch(dependencies)
      .then(async (result) => {
        if (result.configured) {
          workerLastSuccessAt = clock();
          workerSafeReason = null;
        } else {
          workerSafeReason = "imagex_review_channel_unavailable";
        }
        await writePortraitImageXReviewWorkerHeartbeat({
          acceptingWork: result.configured ? 1 : 0,
          activeTaskCount: 0,
          heartbeatAt: clock(),
        });
      })
      .catch(async () => {
        workerSafeReason = "imagex_review_worker_tick_failed";
        await writePortraitImageXReviewWorkerHeartbeat({
          acceptingWork: 0,
          activeTaskCount: 0,
          heartbeatAt: clock(),
        }).catch(() => undefined);
      })
      .finally(() => { workerTick = null; });
  };
  run();
  workerTimer = setInterval(run, WORKER_INTERVAL_MS);
  workerTimer.unref?.();
}

export async function stopPortraitImageXReviewWorker(): Promise<void> {
  workerRunning = false;
  if (workerTimer) clearInterval(workerTimer);
  workerTimer = null;
  await workerTick;
  await removePortraitImageXReviewWorkerHeartbeat();
  workerHeartbeatDatabase = null;
  workerHeartbeatId = null;
  workerHeartbeatIncarnationId = null;
  workerStartedAt = null;
}
