import crypto from "node:crypto";
import { types as nodeUtilTypes } from "node:util";
import {
  attachPublicDeliverySlice,
  buildDeliverySnapshot,
  readProviderNativeDeliveryAuthorization,
  type DeliveryClassificationProjection,
  type DeliveryEvidenceItem,
  type DeliveryEvidenceKind,
  type ProviderNativeDeliveryAuthorization,
} from "@/lib/videoFulfillment/deliverySnapshot";
import { publicMediaAssetUrl } from "@/lib/publicMediaAsset";
import { videoResolutionHeight } from "@/lib/videoResolutions";
import { isSeedanceAdaptive480pDelivery } from "@/lib/seedanceNativeDelivery";

const RELAY_SOURCE_EVIDENCE_VERSION = "relay-video-source-evidence/v1";
const RELAY_FINAL_EVIDENCE_VERSION = "relay-video-final-evidence/v1";
const USER_ENHANCE_ASSET_EVIDENCE_VERSION = "user-video-enhance-asset-evidence/v1";
const USER_ENHANCE_MEDIA_PROBE_VERSION = "user-video-enhance-media-probe/v1";
const DELIVERY_EVIDENCE_VERSION = "video-delivery-evidence/v1";
const MAX_ID_LENGTH = 128;
const MAX_ASSET_METADATA_BYTES = 64 * 1024;

export const USER_VIDEO_ENHANCE_RECONCILE_MARKER = "PENDING_RECONCILE:";

type PlainRecord = Record<string, unknown>;

export interface RelayVideoDeliveryTask {
  id: string;
  workspaceId?: string | null;
  projectId?: number | null;
  requestId?: string | null;
  channelId?: string | null;
  providerTaskId?: string | null;
  provider?: string | null;
  model?: string | null;
  status: string;
  requestPayload?: PlainRecord;
  providerPayload?: PlainRecord;
  resultPayload?: PlainRecord;
  errorMessage?: string | null;
}

export interface RelayVideoDeliveryAsset {
  id?: string | null;
  workspaceId?: string | null;
  projectId?: number | null;
  source?: string | null;
  assetType?: string | null;
  url?: string | null;
  mimeType?: string | null;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
  metadata?: unknown;
}

export interface UserVideoEnhanceDeliveryTask {
  id: string;
  workspaceId?: string | null;
  projectId?: number | null;
  sourceAssetId?: string | null;
  sourceUrl?: string | null;
  sourceResolution: string;
  targetResolution: string;
  enhanceChannelId?: string | null;
  providerTaskId?: string | null;
  status: string;
  resultAssetId?: string | null;
  resultUrl?: string | null;
  errorMessage?: string | null;
}

export interface RelaySourceEvidenceDescriptor {
  version: typeof RELAY_SOURCE_EVIDENCE_VERSION;
  attemptId: string;
  assetId: string;
  resolution: string;
  channelId: string;
}

export interface RelayFinalEvidenceDescriptor {
  version: typeof RELAY_FINAL_EVIDENCE_VERSION;
  taskId: string;
  channelId: string;
  generationAttemptId: string;
  winningAttemptId: string;
  assetId: string;
  resultSha256: string;
  resolution: string;
  kind: "generation_output" | "enhancement_output" | "fallback_source";
}

export interface UserEnhanceAssetEvidenceDescriptor {
  version: typeof USER_ENHANCE_ASSET_EVIDENCE_VERSION;
  taskId: string;
  workspaceId: string;
  channelId: string;
  providerAttemptId: string;
  sourceAssetId: string;
  resultAssetId: string;
  resultSha256: string;
  sourceResolution: string;
  targetResolution: string;
}

export interface UserVideoEnhanceDeliveryAsset {
  id?: string | null;
  source?: string | null;
  assetType?: string | null;
  workspaceId?: string | null;
  projectId?: number | null;
  url?: string | null;
  mimeType?: string | null;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
  metadata?: unknown;
}

export interface VideoDeliveryPublication {
  projection: DeliveryClassificationProjection | null;
  payload: Record<string, unknown>;
}

function isPlainRecord(value: unknown): value is PlainRecord {
  if (
    value == null
    || typeof value !== "object"
    || Array.isArray(value)
    || nodeUtilTypes.isProxy(value)
  ) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(
    (descriptor) => "value" in descriptor && !descriptor.get && !descriptor.set,
  );
}

function ownValue(record: PlainRecord | null, key: string): unknown {
  if (!record) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && "value" in descriptor && !descriptor.get && !descriptor.set
    ? descriptor.value
    : undefined;
}

function ownRecord(record: PlainRecord | null, key: string): PlainRecord | null {
  const value = ownValue(record, key);
  return isPlainRecord(value) ? value : null;
}

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  return clean ? clean : null;
}

function stableId(label: string, ...parts: unknown[]): string {
  const digest = crypto
    .createHash("sha256")
    .update(label)
    .update("\0")
    .update(parts.map((part) => String(part ?? "")).join("\0"))
    .digest("hex");
  return `${label}:${digest}`.slice(0, MAX_ID_LENGTH);
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function boundedIdentity(value: unknown, fallbackLabel: string, ...fallbackParts: unknown[]): string {
  const clean = cleanString(value);
  if (clean && clean.length <= MAX_ID_LENGTH) return clean;
  return stableId(fallbackLabel, clean ?? "", ...fallbackParts);
}

function requiredIdentity(value: unknown): string | null {
  const clean = cleanString(value);
  return clean && clean.length <= MAX_ID_LENGTH ? clean : null;
}

function parseAssetMetadata(value: unknown): PlainRecord | null {
  if (isPlainRecord(value)) return value;
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_ASSET_METADATA_BYTES) {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    return isPlainRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export interface RelayMediaProbe {
  version: "relay-video-media-probe/v1";
  width: number;
  height: number;
  durationMs: number;
  mimeType: string;
  contentSha256: string;
}

function positiveSafeInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

export function readRelayMediaProbe(value: unknown): RelayMediaProbe | null {
  if (!isPlainRecord(value)) return null;
  const width = positiveSafeInteger(ownValue(value, "width"));
  const height = positiveSafeInteger(ownValue(value, "height"));
  const durationMs = positiveSafeInteger(ownValue(value, "durationMs"));
  const mimeType = cleanString(ownValue(value, "mimeType"));
  const contentSha256 = cleanString(ownValue(value, "contentSha256"));
  if (
    ownValue(value, "version") !== "relay-video-media-probe/v1"
    || !width
    || !height
    || !durationMs
    || !mimeType?.startsWith("video/")
    || !contentSha256
    || !/^[0-9a-f]{64}$/.test(contentSha256)
  ) {
    return null;
  }
  return {
    version: "relay-video-media-probe/v1",
    width,
    height,
    durationMs,
    mimeType,
    contentSha256,
  };
}

export interface UserEnhanceMediaProbe {
  version: typeof USER_ENHANCE_MEDIA_PROBE_VERSION;
  width: number;
  height: number;
  durationMs: number;
  mimeType: string;
  contentSha256: string;
}

export function readUserEnhanceMediaProbe(value: unknown): UserEnhanceMediaProbe | null {
  if (!isPlainRecord(value)) return null;
  const width = positiveSafeInteger(ownValue(value, "width"));
  const height = positiveSafeInteger(ownValue(value, "height"));
  const durationMs = positiveSafeInteger(ownValue(value, "durationMs"));
  const mimeType = cleanString(ownValue(value, "mimeType"));
  const contentSha256 = cleanString(ownValue(value, "contentSha256"));
  if (
    ownValue(value, "version") !== USER_ENHANCE_MEDIA_PROBE_VERSION
    || !width
    || !height
    || !durationMs
    || !mimeType?.startsWith("video/")
    || !contentSha256
    || !/^[0-9a-f]{64}$/.test(contentSha256)
  ) {
    return null;
  }
  return {
    version: USER_ENHANCE_MEDIA_PROBE_VERSION,
    width,
    height,
    durationMs,
    mimeType,
    contentSha256,
  };
}

function evidenceItem(input: {
  idLabel: string;
  taskId: string;
  fulfillmentId: string;
  channelId: string;
  attemptId: string;
  assetId: string;
  resolution: string;
  kind: DeliveryEvidenceKind;
}): DeliveryEvidenceItem {
  const phase: Record<DeliveryEvidenceKind, "generation" | "enhancement" | "upscale" | "fallback"> = {
    generation_output: "generation",
    generation_source: "generation",
    native_source: "generation",
    enhancement_output: "enhancement",
    upscale_output: "upscale",
    fallback_source: "fallback",
  };
  return {
    id: stableId(input.idLabel, input.taskId, input.attemptId, input.assetId),
    evidenceVersion: DELIVERY_EVIDENCE_VERSION,
    taskId: input.taskId,
    fulfillmentId: input.fulfillmentId,
    channelId: input.channelId,
    winningAttemptId: input.attemptId,
    resultAssetId: input.assetId,
    resolution: input.resolution,
    trustworthy: true,
    kind: input.kind,
    status: "succeeded",
    phase: phase[input.kind],
    dispatchStatus: "dispatched",
    resultStatus: "succeeded",
  };
}

function safePublication(
  payload: PlainRecord,
  input: PlainRecord,
  requireVideoUrl = false,
): VideoDeliveryPublication {
  const result = buildDeliverySnapshot(input);
  if (!result.ok) {
    return { projection: null, payload: { public: {}, internal: {} } };
  }
  let attached = attachPublicDeliverySlice(payload, result.projection);
  const mayPublishVideo =
    result.projection.deliveryStatus === "delivered_native"
    || result.projection.deliveryStatus === "delivered_enhanced"
    || result.projection.deliveryStatus === "degraded_source_only";
  if (!mayPublishVideo && isPlainRecord(attached)) {
    const attachedPublic = ownRecord(attached, "public");
    if (attachedPublic) {
      const safePublic = { ...attachedPublic };
      delete safePublic.video_url;
      delete safePublic.resolution;
      attached = { ...attached, public: safePublic };
    }
  }
  const publication = {
    projection: result.projection,
    payload: attached,
  };
  const published = isPlainRecord(publication.payload)
    ? ownRecord(publication.payload, "public")
    : null;
  if (
    requireVideoUrl
    && mayPublishVideo
    && typeof ownValue(published, "video_url") !== "string"
  ) {
    return safePublication(
      { public: {}, internal: {} },
      {
        pipeline: ownValue(input, "pipeline"),
        requestedResolution: ownValue(input, "requestedResolution"),
        generationResolution: ownValue(input, "generationResolution"),
        allowProviderNativeNonPublicResolution: ownValue(
          input,
          "allowProviderNativeNonPublicResolution",
        ),
        channelId: ownValue(input, "channelId"),
        emptyOutput: true,
        providerErrorInternal: ownValue(input, "providerErrorInternal"),
        rawFinalization: "empty_output",
      },
    );
  }
  return publication;
}

export function readRelaySourceEvidenceDescriptor(
  value: unknown,
): RelaySourceEvidenceDescriptor | null {
  if (!isPlainRecord(value)) return null;
  const keys = Object.keys(value).sort();
  const expected = ["assetId", "attemptId", "channelId", "resolution", "version"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    return null;
  }
  const version = ownValue(value, "version");
  const attemptId = cleanString(ownValue(value, "attemptId"));
  const assetId = cleanString(ownValue(value, "assetId"));
  const resolution = cleanString(ownValue(value, "resolution"));
  const channelId = cleanString(ownValue(value, "channelId"));
  if (
    version !== RELAY_SOURCE_EVIDENCE_VERSION
    || !attemptId
    || !assetId
    || !resolution
    || !channelId
    || [attemptId, assetId, channelId].some((item) => item.length > MAX_ID_LENGTH)
  ) {
    return null;
  }
  return {
    version: RELAY_SOURCE_EVIDENCE_VERSION,
    attemptId,
    assetId,
    resolution,
    channelId,
  };
}

export function createRelaySourceEvidenceDescriptor(input: {
  taskId: string;
  channelId: string;
  generationAttemptId: string;
  sourceUrl: string;
  resolution: string;
  retainedAssetId?: string | null;
}): RelaySourceEvidenceDescriptor {
  const taskId = boundedIdentity(input.taskId, "task");
  const channelId = boundedIdentity(input.channelId, "channel", taskId);
  const attemptId = stableId("generation-attempt", taskId, channelId, input.generationAttemptId);
  const retainedAssetId = cleanString(input.retainedAssetId);
  const assetId = retainedAssetId && retainedAssetId.length <= MAX_ID_LENGTH
    ? retainedAssetId
    : stableId("generation-source", taskId, attemptId, input.sourceUrl);
  return {
    version: RELAY_SOURCE_EVIDENCE_VERSION,
    attemptId,
    assetId,
    resolution: input.resolution,
    channelId,
  };
}

export function readRelayFinalEvidenceDescriptor(
  value: unknown,
): RelayFinalEvidenceDescriptor | null {
  if (!isPlainRecord(value)) return null;
  const keys = Object.keys(value).sort();
  const expected = [
    "assetId",
    "channelId",
    "generationAttemptId",
    "kind",
    "resolution",
    "resultSha256",
    "taskId",
    "version",
    "winningAttemptId",
  ];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    return null;
  }
  const taskId = requiredIdentity(ownValue(value, "taskId"));
  const channelId = requiredIdentity(ownValue(value, "channelId"));
  const generationAttemptId = requiredIdentity(ownValue(value, "generationAttemptId"));
  const winningAttemptId = requiredIdentity(ownValue(value, "winningAttemptId"));
  const assetId = requiredIdentity(ownValue(value, "assetId"));
  const resultSha256 = cleanString(ownValue(value, "resultSha256"));
  const resolution = cleanString(ownValue(value, "resolution"));
  const kind = ownValue(value, "kind");
  if (
    ownValue(value, "version") !== RELAY_FINAL_EVIDENCE_VERSION
    || !taskId
    || !channelId
    || !generationAttemptId
    || !winningAttemptId
    || !assetId
    || !resultSha256
    || !/^[0-9a-f]{64}$/.test(resultSha256)
    || !resolution
    || (
      kind !== "generation_output"
      && kind !== "enhancement_output"
      && kind !== "fallback_source"
    )
  ) {
    return null;
  }
  return {
    version: RELAY_FINAL_EVIDENCE_VERSION,
    taskId,
    channelId,
    generationAttemptId,
    winningAttemptId,
    assetId,
    resultSha256,
    resolution,
    kind,
  };
}

export function createRelayFinalEvidenceDescriptor(input: {
  taskId: string;
  channelId: string;
  generationAttemptId: string;
  winningAttemptSeed?: string | null;
  assetId: string;
  resultUrl: string;
  resolution: string;
  kind: RelayFinalEvidenceDescriptor["kind"];
}): RelayFinalEvidenceDescriptor | null {
  const taskId = requiredIdentity(input.taskId);
  const channelId = requiredIdentity(input.channelId);
  const assetId = requiredIdentity(input.assetId);
  const generationSeed = cleanString(input.generationAttemptId);
  const winningSeed = cleanString(input.winningAttemptSeed);
  const resultUrl = cleanString(input.resultUrl);
  const resolution = cleanString(input.resolution);
  if (!taskId || !channelId || !assetId || !generationSeed || !resultUrl || !resolution) {
    return null;
  }
  const generationAttemptId = stableId(
    "generation-attempt",
    taskId,
    channelId,
    generationSeed,
  );
  const winningAttemptId = input.kind === "enhancement_output"
    ? stableId("enhancement-attempt", taskId, winningSeed ?? resultUrl)
    : generationAttemptId;
  return {
    version: RELAY_FINAL_EVIDENCE_VERSION,
    taskId,
    channelId,
    generationAttemptId,
    winningAttemptId,
    assetId,
    resultSha256: sha256(resultUrl),
    resolution,
    kind: input.kind,
  };
}

export function readUserEnhanceAssetEvidenceDescriptor(
  value: unknown,
): UserEnhanceAssetEvidenceDescriptor | null {
  if (!isPlainRecord(value)) return null;
  const keys = Object.keys(value).sort();
  const expected = [
    "channelId",
    "providerAttemptId",
    "resultAssetId",
    "resultSha256",
    "sourceAssetId",
    "sourceResolution",
    "targetResolution",
    "taskId",
    "version",
    "workspaceId",
  ];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    return null;
  }
  const taskId = requiredIdentity(ownValue(value, "taskId"));
  const workspaceId = requiredIdentity(ownValue(value, "workspaceId"));
  const channelId = requiredIdentity(ownValue(value, "channelId"));
  const providerAttemptId = requiredIdentity(ownValue(value, "providerAttemptId"));
  const sourceAssetId = requiredIdentity(ownValue(value, "sourceAssetId"));
  const resultAssetId = requiredIdentity(ownValue(value, "resultAssetId"));
  const resultSha256 = cleanString(ownValue(value, "resultSha256"));
  const sourceResolution = cleanString(ownValue(value, "sourceResolution"));
  const targetResolution = cleanString(ownValue(value, "targetResolution"));
  if (
    ownValue(value, "version") !== USER_ENHANCE_ASSET_EVIDENCE_VERSION
    || !taskId
    || !workspaceId
    || !channelId
    || !providerAttemptId
    || !sourceAssetId
    || !resultAssetId
    || !resultSha256
    || !/^[0-9a-f]{64}$/.test(resultSha256)
    || !sourceResolution
    || !targetResolution
  ) {
    return null;
  }
  return {
    version: USER_ENHANCE_ASSET_EVIDENCE_VERSION,
    taskId,
    workspaceId,
    channelId,
    providerAttemptId,
    sourceAssetId,
    resultAssetId,
    resultSha256,
    sourceResolution,
    targetResolution,
  };
}

export function createUserEnhanceAssetEvidenceDescriptor(input: {
  taskId: string;
  workspaceId: string;
  channelId: string;
  providerTaskId?: string | null;
  sourceAssetId: string;
  resultAssetId: string;
  resultUrl: string;
  sourceResolution: string;
  targetResolution: string;
}): UserEnhanceAssetEvidenceDescriptor | null {
  const taskId = requiredIdentity(input.taskId);
  const workspaceId = requiredIdentity(input.workspaceId);
  const channelId = requiredIdentity(input.channelId);
  const sourceAssetId = requiredIdentity(input.sourceAssetId);
  const resultAssetId = requiredIdentity(input.resultAssetId);
  const resultUrl = cleanString(input.resultUrl);
  const sourceResolution = cleanString(input.sourceResolution);
  const targetResolution = cleanString(input.targetResolution);
  if (
    !taskId
    || !workspaceId
    || !channelId
    || !sourceAssetId
    || !resultAssetId
    || !resultUrl
    || !sourceResolution
    || !targetResolution
  ) {
    return null;
  }
  return {
    version: USER_ENHANCE_ASSET_EVIDENCE_VERSION,
    taskId,
    workspaceId,
    channelId,
    providerAttemptId: stableId(
      "user-enhance-attempt",
      taskId,
      cleanString(input.providerTaskId) ?? resultUrl,
    ),
    sourceAssetId,
    resultAssetId,
    resultSha256: sha256(resultUrl),
    sourceResolution,
    targetResolution,
  };
}

export function userEnhanceSourceAssetIdentity(input: {
  taskId: string;
  sourceAssetId?: string | null;
  sourceUrl?: string | null;
}): string {
  return boundedIdentity(
    input.sourceAssetId,
    "user-enhance-source",
    input.taskId,
    input.sourceUrl,
  );
}

function relayPlan(task: PlainRecord): {
  pipeline: "direct_generation" | "generate_then_enhance";
  requestedResolution: string | null;
  generationResolution: string | null;
  deliveredResolution: string | null;
  fulfillmentId: string;
  source: RelaySourceEvidenceDescriptor | null;
  finalEvidence: RelayFinalEvidenceDescriptor | null;
  finalization: string | null;
  providerNativeDeliveryAuthorization: ProviderNativeDeliveryAuthorization | null;
} {
  const resultPayload = ownRecord(task, "resultPayload");
  const internal = ownRecord(resultPayload, "internal");
  const needsEnhancement = ownValue(internal, "needsTargetProcessing") === true;
  const taskId = boundedIdentity(ownValue(task, "id"), "task");
  return {
    pipeline: needsEnhancement ? "generate_then_enhance" : "direct_generation",
    requestedResolution: cleanString(ownValue(internal, "requestedResolution")),
    generationResolution: cleanString(ownValue(internal, "generationResolution")),
    deliveredResolution:
      cleanString(ownValue(internal, "deliveredResolution"))
      ?? cleanString(ownValue(internal, "finalResolution")),
    fulfillmentId: boundedIdentity(
      ownValue(internal, "recipeId"),
      "fulfillment",
      taskId,
    ),
    source: readRelaySourceEvidenceDescriptor(ownValue(internal, "deliverySourceEvidence")),
    finalEvidence: readRelayFinalEvidenceDescriptor(ownValue(internal, "deliveryFinalEvidence")),
    finalization: cleanString(ownValue(internal, "finalization")),
    providerNativeDeliveryAuthorization: readProviderNativeDeliveryAuthorization(
      ownValue(internal, "providerNativeDeliveryAuthorization"),
    ),
  };
}

function relayReconcilePending(task: PlainRecord): boolean {
  const providerPayload = ownRecord(task, "providerPayload");
  const submission = ownRecord(providerPayload, "submission");
  const state = cleanString(ownValue(submission, "state"));
  const reason = cleanString(ownValue(submission, "reconcileReason"));
  // Settlement reconciliation is independent from delivery. Only the
  // submission-uncertainty path writes reconcileReason; a billing-only
  // pending state must not revoke an already verified output.
  return Boolean(state && state.startsWith("pending_reconcile") && reason);
}

function relayAssets(value: unknown): Array<{
  id: string;
  workspaceId: string;
  projectId: number | null;
  source: string;
  assetType: string | null;
  url: string | null;
  mimeType: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  mediaProbe: RelayMediaProbe | null;
  finalEvidence: RelayFinalEvidenceDescriptor | null;
}> {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value) || value.length > 128) return [];
  const assets: Array<{
    id: string;
    workspaceId: string;
    projectId: number | null;
    source: string;
    assetType: string | null;
    url: string | null;
    mimeType: string | null;
    width: number | null;
    height: number | null;
    durationMs: number | null;
    mediaProbe: RelayMediaProbe | null;
    finalEvidence: RelayFinalEvidenceDescriptor | null;
  }> = [];
  for (const raw of value) {
    if (!isPlainRecord(raw)) return [];
    const id = cleanString(ownValue(raw, "id"));
    const workspaceId = requiredIdentity(ownValue(raw, "workspaceId"));
    const rawProjectId = ownValue(raw, "projectId");
    const projectId = rawProjectId === null ? null : positiveSafeInteger(rawProjectId);
    const source = cleanString(ownValue(raw, "source"));
    const assetType = cleanString(ownValue(raw, "assetType"));
    const urlValue = ownValue(raw, "url");
    const url = urlValue == null ? null : publicMediaAssetUrl(urlValue) || null;
    if (
      !id
      || !workspaceId
      || (rawProjectId !== null && projectId === null)
      || !source
      || id.length > MAX_ID_LENGTH
    ) return [];
    const metadata = parseAssetMetadata(ownValue(raw, "metadata"));
    assets.push({
      id,
      workspaceId,
      projectId,
      source,
      assetType,
      url,
      mimeType: cleanString(ownValue(raw, "mimeType")),
      width: positiveSafeInteger(ownValue(raw, "width")),
      height: positiveSafeInteger(ownValue(raw, "height")),
      durationMs: positiveSafeInteger(ownValue(raw, "durationMs")),
      mediaProbe: readRelayMediaProbe(ownValue(metadata, "mediaProbe")),
      finalEvidence: readRelayFinalEvidenceDescriptor(
        ownValue(metadata, "deliveryFinalEvidence"),
      ),
    });
  }
  return assets;
}

function sameRelayFinalEvidence(
  left: RelayFinalEvidenceDescriptor | null,
  right: RelayFinalEvidenceDescriptor | null,
): boolean {
  return Boolean(left && right && JSON.stringify(left) === JSON.stringify(right));
}

export function publishRelayVideoDelivery(
  rawTask: RelayVideoDeliveryTask,
  rawAssets: RelayVideoDeliveryAsset[],
): VideoDeliveryPublication {
  if (!isPlainRecord(rawTask)) {
    return { projection: null, payload: { public: {}, internal: {} } };
  }
  const task = rawTask as PlainRecord;
  const authoritativeTaskId = requiredIdentity(ownValue(task, "id"));
  const authoritativeWorkspaceId = requiredIdentity(ownValue(task, "workspaceId"));
  const rawProjectId = ownValue(task, "projectId");
  const authoritativeProjectId =
    rawProjectId === null ? null : positiveSafeInteger(rawProjectId);
  const authoritativeChannelId = requiredIdentity(ownValue(task, "channelId"));
  const taskId = authoritativeTaskId ?? "";
  const channelId = authoritativeChannelId ?? "";
  const hasAuthoritativeLineage = Boolean(
    authoritativeTaskId
    && authoritativeWorkspaceId
    && authoritativeChannelId
    && (rawProjectId === null || authoritativeProjectId !== null),
  );
  const status = cleanString(ownValue(task, "status")) ?? "failed";
  const plan = relayPlan(task);
  const provider = cleanString(ownValue(task, "provider"));
  const model = cleanString(ownValue(task, "model"));
  const providerNativeDeliveryAuthorization =
    plan.providerNativeDeliveryAuthorization
    && plan.providerNativeDeliveryAuthorization.provider === provider
    && plan.providerNativeDeliveryAuthorization.model === model
    && plan.providerNativeDeliveryAuthorization.channelId === channelId
    && plan.providerNativeDeliveryAuthorization.resolution === plan.requestedResolution
    && plan.providerNativeDeliveryAuthorization.resolution === plan.generationResolution
    && plan.providerNativeDeliveryAuthorization.resolution
      === (plan.deliveredResolution ?? plan.requestedResolution)
      ? plan.providerNativeDeliveryAuthorization
      : null;
  const expectedSourceAttemptId = stableId(
    "generation-attempt",
    taskId,
    channelId,
    ownValue(task, "providerTaskId") ?? taskId,
  );
  const trustedSource =
    plan.source
    && plan.source.channelId === channelId
    && plan.source.attemptId === expectedSourceAttemptId
    && plan.source.resolution === plan.generationResolution
      ? plan.source
      : null;
  const assets = relayAssets(rawAssets);
  const finalAssets = assets.filter(
    (asset) => asset.source === "relay_final" && asset.assetType === "video",
  );
  const finalAsset = finalAssets.length === 1 ? finalAssets[0] : null;
  const expectedFinalKind: RelayFinalEvidenceDescriptor["kind"] =
    plan.finalization === "enhancement_failed_fallback"
      ? "fallback_source"
      : plan.pipeline === "direct_generation"
        ? "generation_output"
        : "enhancement_output";
  const expectedFinalResolution =
    expectedFinalKind === "fallback_source"
      ? plan.generationResolution
      : plan.deliveredResolution ?? plan.requestedResolution;
  const expectedFinalHeight = videoResolutionHeight(expectedFinalResolution);
  const providerResponse = ownRecord(ownRecord(task, "providerPayload"), "response");
  const adaptiveNative480p = expectedFinalKind === "generation_output" && expectedFinalResolution === "480p"
    && isSeedanceAdaptive480pDelivery({ provider: ownValue(task, "provider"), model: ownValue(task, "model"),
      providerTaskId: ownValue(task, "providerTaskId"), requestRatio: ownValue(ownRecord(task, "requestPayload"), "ratio"),
      responseId: ownValue(providerResponse, "id"), responseStatus: ownValue(providerResponse, "status"),
      responseResolution: ownValue(providerResponse, "resolution"), responseRatio: ownValue(providerResponse, "ratio"),
      width: Number(finalAsset?.width), height: Number(finalAsset?.height) });
  const trustedFinalAsset =
    finalAsset
    && finalAsset.url
    && plan.finalEvidence
    && sameRelayFinalEvidence(finalAsset.finalEvidence, plan.finalEvidence)
    && plan.finalEvidence.taskId === taskId
    && plan.finalEvidence.channelId === channelId
    && plan.finalEvidence.generationAttemptId === expectedSourceAttemptId
    && plan.finalEvidence.assetId === finalAsset.id
    && finalAsset.workspaceId === authoritativeWorkspaceId
    && finalAsset.projectId === authoritativeProjectId
    && plan.finalEvidence.resultSha256 === sha256(finalAsset.url)
    && plan.finalEvidence.resolution === expectedFinalResolution
    && plan.finalEvidence.kind === expectedFinalKind
    && expectedFinalHeight > 0
    && finalAsset.width === finalAsset.mediaProbe?.width
    && finalAsset.height === finalAsset.mediaProbe?.height
    && finalAsset.durationMs === finalAsset.mediaProbe?.durationMs
    && finalAsset.mimeType === finalAsset.mediaProbe?.mimeType
    && (Math.min(Number(finalAsset.width), Number(finalAsset.height)) >= expectedFinalHeight || adaptiveNative480p)
      ? finalAsset
      : null;
  const base: PlainRecord = {
    pipeline: plan.pipeline,
    requestedResolution: plan.requestedResolution,
    generationResolution: plan.generationResolution,
    taskId,
    fulfillmentId: plan.fulfillmentId,
    channelId,
    providerErrorInternal: ownValue(task, "errorMessage"),
    ...(providerNativeDeliveryAuthorization
      ? {
          allowProviderNativeNonPublicResolution:
            providerNativeDeliveryAuthorization,
        }
      : {}),
  };

  if (relayReconcilePending(task) && !(status === "succeeded" && trustedFinalAsset && hasAuthoritativeLineage)) {
    base.outcomeUnknown = true;
  } else if (status === "queued") {
    base.inProgressPhase = "queued";
  } else if (status === "running") {
    base.inProgressPhase = "generating";
  } else if (status === "enhancing") {
    base.inProgressPhase = "enhancing";
  } else if (status === "cancelled") {
    base.cancelled = true;
    base.rawFinalization = "cancelled";
  } else if (status === "succeeded" && finalAssets.length > 1) {
    // A terminal task with multiple final rows has no unique winner.  `null`
    // is intentionally not a valid evidence array, so the exact projection
    // classifies this as EVIDENCE_INVALID instead of disguising it as no output.
    base.evidence = null;
    base.rawFinalization = "ambiguous_final_assets";
  } else if (status === "succeeded" && plan.finalization === "enhancement_failed_fallback") {
    base.enhancementFailed = true;
    base.sourceRetained = true;
    base.rawFinalization = "enhancement_failed_source_retained";
    base.deliveredResolution = plan.generationResolution;
    if (
      hasAuthoritativeLineage
      && trustedSource
      && trustedFinalAsset
      && plan.finalEvidence?.winningAttemptId === trustedSource.attemptId
      && trustedSource.assetId === trustedFinalAsset.id
    ) {
      base.sourceAttemptId = trustedSource.attemptId;
      base.sourceAssetId = trustedSource.assetId;
      base.sourceEvidence = [
        evidenceItem({
          idLabel: "fallback-source-evidence",
          taskId,
          fulfillmentId: plan.fulfillmentId,
          channelId,
          attemptId: trustedSource.attemptId,
          assetId: trustedSource.assetId,
          resolution: trustedSource.resolution,
          kind: "fallback_source",
        }),
      ];
    }
  } else if (status === "succeeded" && finalAsset?.url) {
    const deliveredResolution = plan.deliveredResolution ?? plan.requestedResolution;
    base.deliveredResolution = deliveredResolution;
    base.rawFinalization = plan.pipeline === "direct_generation"
      ? "generation_succeeded"
      : "enhancement_succeeded";
    const winningAttemptId = plan.finalEvidence?.winningAttemptId ?? "";
    if (hasAuthoritativeLineage && trustedFinalAsset && plan.finalEvidence) {
      base.winningAttemptId = winningAttemptId;
      base.resultAssetId = trustedFinalAsset.id;
      base.evidence = [
        evidenceItem({
          idLabel: "winning-evidence",
          taskId,
          fulfillmentId: plan.fulfillmentId,
          channelId,
          attemptId: winningAttemptId,
          assetId: trustedFinalAsset.id,
          resolution: deliveredResolution ?? "",
          kind: plan.pipeline === "direct_generation"
            ? "generation_output"
            : "enhancement_output",
        }),
      ];
    }
    if (hasAuthoritativeLineage && plan.pipeline === "generate_then_enhance" && trustedSource) {
      base.sourceAttemptId = trustedSource.attemptId;
      base.sourceAssetId = trustedSource.assetId;
      base.sourceEvidence = [
        evidenceItem({
          idLabel: "generation-source-evidence",
          taskId,
          fulfillmentId: plan.fulfillmentId,
          channelId,
          attemptId: trustedSource.attemptId,
          assetId: trustedSource.assetId,
          resolution: trustedSource.resolution,
          kind: "generation_source",
        }),
      ];
    }
  } else if (status === "succeeded") {
    base.emptyOutput = true;
    base.rawFinalization = "empty_output";
  } else {
    const resultPayload = ownRecord(task, "resultPayload");
    const enhancement = ownRecord(resultPayload, "enhancement");
    if (plan.pipeline === "generate_then_enhance" && enhancement) {
      base.enhancementFailed = true;
      base.rawFinalization = "enhancement_failed";
    } else {
      base.generationFailed = true;
    }
  }

  const publicPayload: PlainRecord = {
    requestId: ownValue(task, "requestId"),
    public: trustedFinalAsset?.url
      ? {
          video_url: trustedFinalAsset.url,
          resolution:
            status === "succeeded" && plan.finalization === "enhancement_failed_fallback"
              ? plan.generationResolution
              : plan.deliveredResolution ?? plan.requestedResolution,
        }
      : {},
    internal: {},
  };
  return safePublication(
    publicPayload,
    base,
    status === "succeeded",
  );
}

function userEnhanceAssets(value: unknown): Array<{
  id: string;
  workspaceId: string;
  projectId: number;
  source: string;
  assetType: string;
  url: string;
  mimeType: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  mediaProbe: UserEnhanceMediaProbe | null;
  evidence: UserEnhanceAssetEvidenceDescriptor | null;
}> {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value) || value.length > 128) return [];
  const assets: Array<{
    id: string;
    workspaceId: string;
    projectId: number;
    source: string;
    assetType: string;
    url: string;
    mimeType: string | null;
    width: number | null;
    height: number | null;
    durationMs: number | null;
    mediaProbe: UserEnhanceMediaProbe | null;
    evidence: UserEnhanceAssetEvidenceDescriptor | null;
  }> = [];
  for (const raw of value) {
    if (!isPlainRecord(raw)) return [];
    const id = requiredIdentity(ownValue(raw, "id"));
    const workspaceId = requiredIdentity(ownValue(raw, "workspaceId"));
    const projectId = positiveSafeInteger(ownValue(raw, "projectId"));
    const source = cleanString(ownValue(raw, "source"));
    const assetType = cleanString(ownValue(raw, "assetType"));
    const url = publicMediaAssetUrl(ownValue(raw, "url"));
    if (!id || !workspaceId || !projectId || !source || !assetType || !url) return [];
    const metadata = parseAssetMetadata(ownValue(raw, "metadata"));
    assets.push({
      id,
      workspaceId,
      projectId,
      source,
      assetType,
      url,
      mimeType: cleanString(ownValue(raw, "mimeType")),
      width: positiveSafeInteger(ownValue(raw, "width")),
      height: positiveSafeInteger(ownValue(raw, "height")),
      durationMs: positiveSafeInteger(ownValue(raw, "durationMs")),
      mediaProbe: readUserEnhanceMediaProbe(ownValue(metadata, "mediaProbe")),
      evidence: readUserEnhanceAssetEvidenceDescriptor(
        ownValue(metadata, "deliveryAssetEvidence"),
      ),
    });
  }
  return assets;
}

function sameUserEnhanceEvidence(
  left: UserEnhanceAssetEvidenceDescriptor | null,
  right: UserEnhanceAssetEvidenceDescriptor | null,
): boolean {
  return Boolean(left && right && JSON.stringify(left) === JSON.stringify(right));
}

export function publishUserVideoEnhanceDelivery(
  rawTask: UserVideoEnhanceDeliveryTask,
  rawAssets: UserVideoEnhanceDeliveryAsset[] = [],
): VideoDeliveryPublication {
  if (!isPlainRecord(rawTask)) {
    return { projection: null, payload: { public: {}, internal: {} } };
  }
  const task = rawTask as PlainRecord;
  const authoritativeTaskId = requiredIdentity(ownValue(task, "id"));
  const authoritativeWorkspaceId = requiredIdentity(ownValue(task, "workspaceId"));
  const authoritativeProjectId = positiveSafeInteger(ownValue(task, "projectId"));
  const authoritativeChannelId = requiredIdentity(ownValue(task, "enhanceChannelId"));
  const taskId = authoritativeTaskId ?? "";
  const workspaceId = authoritativeWorkspaceId ?? "";
  const channelId = authoritativeChannelId ?? "";
  const hasAuthoritativeLineage = Boolean(
    authoritativeTaskId
    && authoritativeWorkspaceId
    && authoritativeProjectId
    && authoritativeChannelId,
  );
  const sourceResolution = cleanString(ownValue(task, "sourceResolution"));
  const targetResolution = cleanString(ownValue(task, "targetResolution"));
  const status = cleanString(ownValue(task, "status")) ?? "failed";
  const sourceAssetId = userEnhanceSourceAssetIdentity({
    taskId,
    sourceAssetId: cleanString(ownValue(task, "sourceAssetId")),
    sourceUrl: cleanString(ownValue(task, "sourceUrl")),
  });
  const sourceAttemptId = stableId("user-enhance-source-attempt", taskId, sourceAssetId);
  const resultAssetId = requiredIdentity(ownValue(task, "resultAssetId"));
  const resultUrl = publicMediaAssetUrl(ownValue(task, "resultUrl"));
  const expectedAssetEvidence =
    hasAuthoritativeLineage
    && resultAssetId
    && resultUrl
    && sourceResolution
    && targetResolution
      ? createUserEnhanceAssetEvidenceDescriptor({
          taskId,
          workspaceId,
          channelId,
          providerTaskId: cleanString(ownValue(task, "providerTaskId")),
          sourceAssetId,
          resultAssetId,
          resultUrl,
          sourceResolution,
          targetResolution,
        })
      : null;
  const candidateAssets = userEnhanceAssets(rawAssets).filter(
    (asset) => asset.source === "video_enhance" && asset.assetType === "video",
  );
  const candidateAsset = candidateAssets.length === 1 ? candidateAssets[0] : null;
  const expectedTargetHeight = videoResolutionHeight(targetResolution);
  const trustedAsset =
    candidateAsset
    && expectedAssetEvidence
    && sameUserEnhanceEvidence(candidateAsset.evidence, expectedAssetEvidence)
    && candidateAsset.id === resultAssetId
    && candidateAsset.workspaceId === workspaceId
    && candidateAsset.projectId === authoritativeProjectId
    && candidateAsset.url === resultUrl
    && expectedAssetEvidence.resultSha256 === sha256(candidateAsset.url)
    && expectedTargetHeight > 0
    && candidateAsset.width === candidateAsset.mediaProbe?.width
    && candidateAsset.height === candidateAsset.mediaProbe?.height
    && candidateAsset.durationMs === candidateAsset.mediaProbe?.durationMs
    && candidateAsset.mimeType === candidateAsset.mediaProbe?.mimeType
    && Math.min(Number(candidateAsset.width), Number(candidateAsset.height)) >= expectedTargetHeight
      ? candidateAsset
      : null;
  const base: PlainRecord = {
    pipeline: "user_enhance",
    requestedResolution: targetResolution,
    generationResolution: sourceResolution,
    taskId,
    fulfillmentId: taskId,
    channelId,
    providerErrorInternal: ownValue(task, "errorMessage"),
  };

  const internalError = cleanString(ownValue(task, "errorMessage"));
  const requiresReconciliation = Boolean(
    internalError?.startsWith(USER_VIDEO_ENHANCE_RECONCILE_MARKER)
    || internalError === "增强结果未通过安全校验，任务已暂停并进入人工核账"
    || internalError === "结算异常，已进入人工核账"
    || internalError?.endsWith(";预扣释放异常，已进入人工核账"),
  );
  if (requiresReconciliation && !(status === "succeeded" && trustedAsset && hasAuthoritativeLineage)) {
    base.outcomeUnknown = true;
  } else if (status === "created") {
    base.inProgressPhase = "queued";
  } else if (status === "enhancing") {
    base.inProgressPhase = "enhancing";
  } else if (status === "failed") {
    base.enhancementFailed = true;
    base.rawFinalization = "enhancement_failed";
  } else if (status === "succeeded") {
    if (!resultAssetId || !resultUrl) {
      base.emptyOutput = true;
      base.rawFinalization = "empty_output";
    } else {
      const winningAttemptId = expectedAssetEvidence?.providerAttemptId ?? "";
      base.deliveredResolution = targetResolution;
      base.rawFinalization = "enhancement_succeeded";
      if (hasAuthoritativeLineage && trustedAsset && expectedAssetEvidence) {
        base.winningAttemptId = winningAttemptId;
        base.resultAssetId = resultAssetId;
        base.sourceAttemptId = sourceAttemptId;
        base.sourceAssetId = sourceAssetId;
        base.evidence = [
          evidenceItem({
            idLabel: "user-enhance-winning-evidence",
            taskId,
            fulfillmentId: taskId,
            channelId,
            attemptId: winningAttemptId,
            assetId: resultAssetId,
            resolution: targetResolution ?? "",
            kind: "upscale_output",
          }),
        ];
        base.sourceEvidence = [
          evidenceItem({
            idLabel: "user-enhance-source-evidence",
            taskId,
            fulfillmentId: taskId,
            channelId,
            attemptId: sourceAttemptId,
            assetId: sourceAssetId,
            resolution: sourceResolution ?? "",
            kind: "native_source",
          }),
        ];
      }
    }
  } else {
    base.enhancementFailed = true;
    base.rawFinalization = "enhancement_failed";
  }

  return safePublication(
    {
      public: trustedAsset
        ? {
            video_url: trustedAsset.url,
            resolution: targetResolution,
          }
        : {},
      internal: {},
    },
    base,
    status === "succeeded",
  );
}

export function publicDeliveryPart(
  publication: VideoDeliveryPublication,
): Record<string, unknown> {
  const payload = isPlainRecord(publication.payload) ? publication.payload : null;
  const publicPart = ownRecord(payload, "public");
  return publicPart ? { ...publicPart } : {};
}
