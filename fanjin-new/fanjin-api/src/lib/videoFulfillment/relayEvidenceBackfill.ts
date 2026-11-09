import fs from "node:fs";
import { createHash } from "node:crypto";
import { isPostgresClient } from "@/lib/dbDialect";
import { publicMediaAssetUrl } from "@/lib/publicMediaAsset";
import {
  createRelayFinalEvidenceDescriptor,
  createRelaySourceEvidenceDescriptor,
  readRelayFinalEvidenceDescriptor,
  readRelaySourceEvidenceDescriptor,
  type RelayFinalEvidenceDescriptor,
  type RelaySourceEvidenceDescriptor,
} from "@/lib/videoFulfillment/deliveryConsumer";
import {
  probeVideoFile,
  resolveOwnedVideoLocalPath,
  sha256VideoFile,
} from "@/lib/videoFulfillment/safeVideoMirror";

const MAX_JSON_BYTES = 256 * 1024;
const MAX_DETAIL_ROWS = 100;

type PlainRecord = Record<string, unknown>;

export interface RelayEvidenceBackfillTaskRow {
  id?: unknown;
  workspaceId?: unknown;
  projectId?: unknown;
  endpointType?: unknown;
  status?: unknown;
  channelId?: unknown;
  providerTaskId?: unknown;
  resultPayload?: unknown;
  requestPayload?: unknown;
  providerPayload?: unknown;
  errorMessage?: unknown;
}

export interface RelayEvidenceBackfillAssetRow {
  id?: unknown;
  taskId?: unknown;
  workspaceId?: unknown;
  projectId?: unknown;
  assetType?: unknown;
  source?: unknown;
  url?: unknown;
  localPath?: unknown;
  mimeType?: unknown;
  width?: unknown;
  height?: unknown;
  durationMs?: unknown;
  metadata?: unknown;
}

export type RelayEvidenceBackfillReason =
  | "invalid_task_lineage"
  | "invalid_result_payload"
  | "invalid_resolution_plan"
  | "ambiguous_final_assets"
  | "missing_final_asset"
  | "invalid_final_asset"
  | "untrusted_final_asset_url"
  | "invalid_asset_metadata"
  | "missing_authoritative_media_probe"
  | "missing_legacy_provider_binding"
  | "ambiguous_finalization"
  | "missing_generation_source"
  | "conflicting_delivery_evidence";

export type RelayEvidenceBackfillClassification =
  | { state: "retained_after_project_deletion"; taskId: string }
  | {
      state: "current";
      taskId: string;
    }
  | {
      state: "eligible";
      taskId: string;
      resultPayload: PlainRecord;
      assetId: string;
      assetMetadata: PlainRecord;
      finalEvidence: RelayFinalEvidenceDescriptor;
      sourceEvidence: RelaySourceEvidenceDescriptor | null;
    }
  | {
      state: "unresolved";
      taskId: string;
      reason: RelayEvidenceBackfillReason;
    };

export interface RelayEvidenceBackfillReport {
  scanned: number;
  current: number;
  retainedAfterProjectDeletion: number;
  eligible: number;
  applied: number;
  unresolved: number;
  remaining: number;
  ready: boolean;
  details: Array<{ taskId: string; reason: RelayEvidenceBackfillReason }>;
  detailsTruncated: boolean;
}

function cleanString(value: unknown, maxLength = 128): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const clean = String(value).trim();
  if (!clean || clean.length > maxLength || /[\u0000-\u001f\u007f]/.test(clean)) {
    return null;
  }
  return clean;
}

function positiveProjectId(value: unknown): number | null {
  const projectId = Number(value);
  return Number.isSafeInteger(projectId) && projectId > 0 ? projectId : null;
}

function parseRecord(value: unknown): PlainRecord | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as PlainRecord;
  }
  if (
    typeof value !== "string"
    || Buffer.byteLength(value, "utf8") > MAX_JSON_BYTES
  ) {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as PlainRecord
      : null;
  } catch {
    return null;
  }
}

function nestedRecord(value: unknown): PlainRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as PlainRecord
    : null;
}

function valueAtPath(record: PlainRecord, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => {
    const current = nestedRecord(value);
    return current ? current[key] : undefined;
  }, record);
}

function firstStringAtPath(record: PlainRecord, paths: string[]): string | null {
  for (const path of paths) {
    const value = cleanString(valueAtPath(record, path), 16 * 1024);
    if (value) return value;
  }
  const output = record.output;
  if (Array.isArray(output) && output.length === 1) {
    const first = nestedRecord(output[0]);
    const value = first
      ? cleanString(first.url ?? first.video_url, 16 * 1024)
      : null;
    if (value) return value;
  }
  return null;
}

function extractVideoUrl(payload: PlainRecord): string | null {
  return firstStringAtPath(payload, [
    "content.video_url",
    "content.video.url",
    "video_url",
    "video.url",
    "output.video_url",
    "output.url",
    "data.content.video_url",
    "data.output.video_url",
    "data.output.url",
    "data.video_url",
    "data.url",
    "result.video_url",
    "result.url",
  ]);
}

function evidenceMatches(
  actual: RelayFinalEvidenceDescriptor | RelaySourceEvidenceDescriptor | null,
  expected: RelayFinalEvidenceDescriptor | RelaySourceEvidenceDescriptor | null,
): boolean {
  return actual === null && expected === null
    || Boolean(actual && expected && JSON.stringify(actual) === JSON.stringify(expected));
}

function resolutionMinimumDimension(value: string): number | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "480p") return 480;
  if (normalized === "720p") return 720;
  if (normalized === "960p") return 960;
  if (normalized === "768p") return 768;
  if (normalized === "1080p") return 1080;
  if (normalized === "2k" || normalized === "1440p") return 1440;
  if (normalized === "4k" || normalized === "2160p") return 2160;
  return null;
}

function hasAuthoritativeMediaProbe(
  asset: RelayEvidenceBackfillAssetRow,
  metadata: PlainRecord,
  resolution: string,
): boolean {
  const width = Number(asset.width);
  const height = Number(asset.height);
  const durationMs = Number(asset.durationMs);
  const minimumDimension = resolutionMinimumDimension(resolution);
  const mimeType = cleanString(asset.mimeType, 256)?.toLowerCase() ?? "";
  const mediaProbe = nestedRecord(metadata.mediaProbe);
  const contentSha256 = cleanString(mediaProbe?.contentSha256, 128) ?? "";
  return Boolean(
    mediaProbe?.version === "relay-video-media-probe/v1"
    && minimumDimension
    && mimeType.startsWith("video/")
    && mediaProbe.mimeType === mimeType
    && Number(mediaProbe.width) === width
    && Number(mediaProbe.height) === height
    && Number(mediaProbe.durationMs) === durationMs
    && Number.isSafeInteger(width)
    && width > 0
    && Number.isSafeInteger(height)
    && height > 0
    && Number.isSafeInteger(durationMs)
    && durationMs > 0
    && Math.min(width, height) >= minimumDimension
    && /^[0-9a-f]{64}$/.test(contentSha256)
  );
}

function hasOwn(record: PlainRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function unresolved(
  taskId: string,
  reason: RelayEvidenceBackfillReason,
): RelayEvidenceBackfillClassification {
  return { state: "unresolved", taskId, reason };
}

/**
 * Derives evidence only from the immutable Relay task lineage plus the unique
 * server-owned final asset row. It never trusts a request/client-supplied URL.
 * Any ambiguity is deliberately left for an operator instead of being guessed.
 */
export function classifyRelayVideoEvidenceBackfill(
  task: RelayEvidenceBackfillTaskRow,
  assets: RelayEvidenceBackfillAssetRow[],
): RelayEvidenceBackfillClassification {
  const taskId = cleanString(task.id) ?? "(invalid-task)";
  const workspaceId = cleanString(task.workspaceId);
  const taskProjectId = task.projectId === null ? null : positiveProjectId(task.projectId);
  const channelId = cleanString(task.channelId);
  const generationAttemptSeed = cleanString(task.providerTaskId) ?? (
    taskId !== "(invalid-task)" ? taskId : null
  );
  if (
    taskId === "(invalid-task)"
    || !workspaceId
    || (task.projectId !== null && taskProjectId === null)
    || cleanString(task.endpointType) !== "video_generation"
    || cleanString(task.status) !== "succeeded"
    || !channelId
    || !generationAttemptSeed
  ) {
    return unresolved(taskId, "invalid_task_lineage");
  }

  const resultPayload = parseRecord(task.resultPayload);
  if (!resultPayload) return unresolved(taskId, "invalid_result_payload");
  const internal = nestedRecord(resultPayload.internal);
  if (!internal) return unresolved(taskId, "invalid_resolution_plan");
  const requestedResolution = cleanString(internal.requestedResolution);
  const generationResolution = cleanString(internal.generationResolution);
  const deliveredResolution =
    cleanString(internal.deliveredResolution)
    ?? cleanString(internal.finalResolution)
    ?? requestedResolution;
  if (
    typeof internal.needsTargetProcessing !== "boolean"
    || !generationResolution
    || !deliveredResolution
  ) {
    return unresolved(taskId, "invalid_resolution_plan");
  }

  const finalAssets = assets.filter(
    (asset) => cleanString(asset.source) === "relay_final"
      && cleanString(asset.assetType) === "video",
  );
  if (finalAssets.length > 1) return unresolved(taskId, "ambiguous_final_assets");
  if (finalAssets.length === 0) return unresolved(taskId, "missing_final_asset");
  const finalAsset = finalAssets[0];
  const assetId = cleanString(finalAsset.id);
  const resultUrl = cleanString(finalAsset.url, 16 * 1024);
  const finalAssetProjectId =
    finalAsset.projectId === null ? null : positiveProjectId(finalAsset.projectId);
  if (
    !assetId
    || !resultUrl
    || cleanString(finalAsset.taskId) !== taskId
    || cleanString(finalAsset.workspaceId) !== workspaceId
    || (finalAsset.projectId !== null && finalAssetProjectId === null)
    || finalAssetProjectId !== taskProjectId
  ) {
    return unresolved(taskId, "invalid_final_asset");
  }
  if (publicMediaAssetUrl(resultUrl) !== resultUrl) {
    return unresolved(taskId, "untrusted_final_asset_url");
  }
  const assetMetadata = parseRecord(finalAsset.metadata);
  if (!assetMetadata) return unresolved(taskId, "invalid_asset_metadata");

  const enhancement = nestedRecord(resultPayload.enhancement);
  const finalization = cleanString(internal.finalization, 256);
  let kind: RelayFinalEvidenceDescriptor["kind"];
  let winningAttemptSeed: string | null = null;
  let sourceEvidence: RelaySourceEvidenceDescriptor | null = null;
  if (finalization === "enhancement_failed_fallback") {
    kind = "fallback_source";
    sourceEvidence = createRelaySourceEvidenceDescriptor({
      taskId,
      channelId,
      generationAttemptId: generationAttemptSeed,
      sourceUrl: resultUrl,
      resolution: generationResolution,
      retainedAssetId: assetId,
    });
  } else if (internal.needsTargetProcessing === false) {
    kind = "generation_output";
  } else {
    winningAttemptSeed = enhancement
      ? cleanString(enhancement.taskId ?? enhancement.task_id)
      : null;
    const provider = nestedRecord(resultPayload.provider);
    const sourceUrl = provider ? extractVideoUrl(provider) : null;
    if (!winningAttemptSeed) return unresolved(taskId, "ambiguous_finalization");
    if (!sourceUrl) return unresolved(taskId, "missing_generation_source");
    kind = "enhancement_output";
    sourceEvidence = createRelaySourceEvidenceDescriptor({
      taskId,
      channelId,
      generationAttemptId: generationAttemptSeed,
      sourceUrl,
      resolution: generationResolution,
    });
  }

  const finalResolution = kind === "fallback_source"
    ? generationResolution
    : deliveredResolution;
  const finalEvidence = createRelayFinalEvidenceDescriptor({
    taskId,
    channelId,
    generationAttemptId: generationAttemptSeed,
    winningAttemptSeed,
    assetId,
    resultUrl,
    resolution: finalResolution,
    kind,
  });
  if (!finalEvidence) return unresolved(taskId, "invalid_final_asset");

  const existingTaskFinal = readRelayFinalEvidenceDescriptor(
    internal.deliveryFinalEvidence,
  );
  const existingAssetFinal = readRelayFinalEvidenceDescriptor(
    assetMetadata.deliveryFinalEvidence,
  );
  const existingSource = readRelaySourceEvidenceDescriptor(
    internal.deliverySourceEvidence,
  );
  const taskHasFinal = hasOwn(internal, "deliveryFinalEvidence");
  const assetHasFinal = hasOwn(assetMetadata, "deliveryFinalEvidence");
  const taskHasSource = hasOwn(internal, "deliverySourceEvidence");
  if (!hasAuthoritativeMediaProbe(finalAsset, assetMetadata, finalResolution)) {
    return unresolved(taskId, "missing_authoritative_media_probe");
  }
  if (
    taskHasFinal && !evidenceMatches(existingTaskFinal, finalEvidence)
    || assetHasFinal && !evidenceMatches(existingAssetFinal, finalEvidence)
    || sourceEvidence && taskHasSource && !evidenceMatches(existingSource, sourceEvidence)
  ) {
    return unresolved(taskId, "conflicting_delivery_evidence");
  }
  if (
    evidenceMatches(existingTaskFinal, finalEvidence)
    && evidenceMatches(existingAssetFinal, finalEvidence)
    && evidenceMatches(existingSource, sourceEvidence)
  ) {
    return { state: "current", taskId };
  }

  // A legacy row did not have the v1 descriptor at production time. It can be
  // upgraded only when the old server-written provider binding and an
  // authoritative media probe both corroborate the final asset. Declared
  // request/internal resolution alone is never promoted into winning evidence.
  const provider = nestedRecord(resultPayload.provider);
  const enhancementPayload = enhancement
    ? nestedRecord(enhancement.payload)
    : null;
  const expectedProviderUrl = kind === "enhancement_output"
    ? enhancementPayload ? extractVideoUrl(enhancementPayload) : null
    : provider ? extractVideoUrl(provider) : null;
  if (
    !expectedProviderUrl
    || cleanString(assetMetadata.providerVideoUrl, 16 * 1024) !== expectedProviderUrl
  ) {
    return unresolved(taskId, "missing_legacy_provider_binding");
  }
  return {
    state: "eligible",
    taskId,
    resultPayload: {
      ...resultPayload,
      internal: {
        ...internal,
        ...(sourceEvidence ? { deliverySourceEvidence: sourceEvidence } : {}),
        deliveryFinalEvidence: finalEvidence,
      },
    },
    assetId,
    assetMetadata: {
      ...assetMetadata,
      deliveryFinalEvidence: finalEvidence,
    },
    finalEvidence,
    sourceEvidence,
  };
}

/** Deleted projects retain billing rows while deliberately scrubbing content.
 * Require the exact completed deletion and its hash-verified snapshot; an empty
 * payload or missing asset alone must never exempt a live delivery. */
export function isFinalizedProjectRelayRetention(
  task: RelayEvidenceBackfillTaskRow,
  project: PlainRecord | null,
  operation: PlainRecord | null,
): boolean {
  const projectId = positiveProjectId(task.projectId);
  const workspaceId = cleanString(task.workspaceId);
  if (!projectId || !workspaceId || task.status !== "succeeded"
    || task.endpointType !== "video_generation"
    || task.requestPayload !== "{}" || task.providerPayload !== "{}"
    || task.resultPayload !== "{}" || task.errorMessage !== null
    || !project || project.deletionState !== "deleted"
    || Number(project.id) !== projectId || project.workspaceId !== workspaceId
    || !operation || operation.kind !== "project" || operation.status !== "completed"
    || !cleanString(operation.id) || project.deletionOperationId !== operation.id
    || Number(operation.projectId) !== projectId || String(operation.resourceId) !== String(projectId)
    || operation.workspaceId !== workspaceId || operation.errorCode !== null
    || typeof operation.auditSnapshot !== "string"
    || Buffer.byteLength(operation.auditSnapshot, "utf8") > MAX_JSON_BYTES
    || createHash("sha256").update(operation.auditSnapshot).digest("hex") !== operation.auditSnapshotHash) return false;
  const finalizedAt = Number(operation.finalizedAt);
  const requestedAt = Number(operation.requestedAt);
  const audit = parseRecord(operation.auditSnapshot);
  const identity = nestedRecord(audit?.operation);
  const finalizer = nestedRecord(audit?.databaseFinalizer);
  return Number.isSafeInteger(finalizedAt) && finalizedAt > 0
    && Number.isSafeInteger(requestedAt) && requestedAt > 0 && finalizedAt >= requestedAt
    && audit?.version === "project-deletion-completion.v2"
    && identity?.id === operation.id && identity?.workspaceId === workspaceId
    && Number(identity?.projectId) === projectId
    && Number(identity?.finalizedAt) === finalizedAt && Number(identity?.requestedAt) === requestedAt
    && identity?.requestHash === operation.requestHash && identity?.manifestHash === operation.manifestHash
    && finalizer?.catalogVersion === "project-deletion-finalizer.v2";
}

async function classifyLockedTask(
  database: any,
  taskId: string,
  forUpdate: boolean,
): Promise<RelayEvidenceBackfillClassification> {
  const taskQuery = database("o_relay_task").where({ id: taskId });
  if (forUpdate && isPostgresClient(database)) taskQuery.forUpdate();
  const task = await taskQuery.first();
  if (!task) return unresolved(taskId, "invalid_task_lineage");
  let retained = false;
  if (positiveProjectId(task.projectId) && task.resultPayload === "{}"
    && task.requestPayload === "{}" && task.providerPayload === "{}" && task.errorMessage === null) {
    const project = await database("o_project").where({ id: task.projectId, workspaceId: task.workspaceId }).first();
    const operation = project?.deletionState === "deleted" && project.deletionOperationId
      ? await database("o_deletion_operation").where({ id: project.deletionOperationId }).first()
      : null;
    retained = isFinalizedProjectRelayRetention(task, project ?? null, operation ?? null);
  }
  const assets = await database("o_media_asset")
    .where({
      taskId,
      workspaceId: task.workspaceId,
      projectId: task.projectId,
    })
    .orderBy("createTime", "asc");
  if (retained && assets.length === 0) return { state: "retained_after_project_deletion", taskId };
  return classifyRelayVideoEvidenceBackfill(task, assets);
}

async function reprobeLockedRelayAsset(
  database: any,
  taskId: string,
): Promise<boolean> {
  const task = await database("o_relay_task")
    .where({ id: taskId })
    .select("workspaceId", "projectId")
    .first();
  if (!task) return false;
  const assetQuery = database("o_media_asset")
    .where({
      taskId,
      workspaceId: task.workspaceId,
      projectId: task.projectId,
      source: "relay_final",
      assetType: "video",
    })
    .orderBy("createTime", "asc");
  if (isPostgresClient(database)) assetQuery.forUpdate();
  const assets = await assetQuery;
  if (assets.length !== 1) return false;
  const asset = assets[0];
  const assetId = cleanString(asset.id);
  const resultUrl = cleanString(asset.url, 16 * 1024);
  const mimeType = cleanString(asset.mimeType, 256)?.toLowerCase() ?? "";
  const metadata = parseRecord(asset.metadata);
  if (
    !assetId
    || !resultUrl
    || publicMediaAssetUrl(resultUrl) !== resultUrl
    || !mimeType.startsWith("video/")
    || !metadata
  ) {
    return false;
  }
  const persistedLocalPath = cleanString(asset.localPath, 16 * 1024);
  const localPath = resolveOwnedVideoLocalPath(resultUrl, persistedLocalPath);
  if (!localPath) return false;
  try {
    const before = await fs.promises.stat(localPath);
    const [probe, contentSha256] = await Promise.all([
      probeVideoFile(localPath),
      sha256VideoFile(localPath),
    ]);
    const after = await fs.promises.stat(localPath);
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
    ) {
      return false;
    }
    await database("o_media_asset").where({
      id: assetId,
      taskId,
      workspaceId: task.workspaceId,
      projectId: task.projectId,
    }).update({
      localPath,
      width: probe.width,
      height: probe.height,
      durationMs: probe.durationMs,
      metadata: JSON.stringify({
        ...metadata,
        mediaProbe: {
          version: "relay-video-media-probe/v1",
          width: probe.width,
          height: probe.height,
          durationMs: probe.durationMs,
          mimeType,
          contentSha256,
        },
      }),
    });
    return true;
  } catch {
    return false;
  }
}

export async function inspectRelayVideoEvidenceBackfill(
  database: any,
  options: { apply?: boolean; detailLimit?: number } = {},
): Promise<RelayEvidenceBackfillReport> {
  const detailLimit = Math.max(
    0,
    Math.min(MAX_DETAIL_ROWS, Math.floor(options.detailLimit ?? MAX_DETAIL_ROWS)),
  );
  const rows = await database("o_relay_task")
    .where({ endpointType: "video_generation", status: "succeeded" })
    .select("id")
    .orderBy("id", "asc");
  const report: RelayEvidenceBackfillReport = {
    scanned: rows.length,
    current: 0,
    retainedAfterProjectDeletion: 0,
    eligible: 0,
    applied: 0,
    unresolved: 0,
    remaining: 0,
    ready: false,
    details: [],
    detailsTruncated: false,
  };

  for (const row of rows) {
    const taskId = cleanString(row.id) ?? "(invalid-task)";
    const classification = options.apply
      ? await database.transaction(async (trx: any) => {
          let locked = await classifyLockedTask(trx, taskId, true);
          let changed = false;
          if (
            locked.state === "unresolved"
            && locked.reason === "missing_authoritative_media_probe"
          ) {
            changed = await reprobeLockedRelayAsset(trx, taskId);
            if (changed) locked = await classifyLockedTask(trx, taskId, false);
          }
          if (locked.state === "eligible") {
            await trx("o_relay_task").where({ id: taskId }).update({
              resultPayload: JSON.stringify(locked.resultPayload),
            });
            await trx("o_media_asset").where({ id: locked.assetId, taskId }).update({
              metadata: JSON.stringify(locked.assetMetadata),
            });
            changed = true;
          }
          if (changed) report.applied += 1;
          return changed
            ? await classifyLockedTask(trx, taskId, false)
            : locked;
        })
      : await classifyLockedTask(database, taskId, false);

    if (classification.state === "retained_after_project_deletion") {
      report.retainedAfterProjectDeletion += 1;
    } else if (classification.state === "current") {
      report.current += 1;
    } else if (classification.state === "eligible") {
      report.eligible += 1;
    } else {
      report.unresolved += 1;
      if (report.details.length < detailLimit) {
        report.details.push({
          taskId: classification.taskId,
          reason: classification.reason,
        });
      } else {
        report.detailsTruncated = true;
      }
    }
  }
  report.remaining = report.eligible + report.unresolved;
  report.ready = report.remaining === 0;
  return report;
}
