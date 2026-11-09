import crypto from "node:crypto";
import type { Knex } from "knex";
import { db } from "@/utils/db";
import u from "@/utils";
import {
  PORTRAIT_ADMISSION_TABLE,
  PORTRAIT_MANUAL_REVIEW_TABLE,
} from "@/lib/migrations/portraitAssetAdmission";
import { readPortraitControlResponse } from "@/lib/portraitRemoteResponse";
import { detectPortraitImageFacesWithImageX } from "@/lib/portraitImageXReviewRuntime";
import { detectPortraitVideoFacesWithImageX } from "@/lib/portraitVideoSampler";
import { canRecoverPortraitFace, isPortraitRetrySafeFailure, portraitFailure, portraitRecoveryHistory, readPortraitEvidence } from "@/lib/portraitFailure";

export type PortraitFaceScanResult = {
  state: "no_face" | "single_face" | "multiple_faces" | "uncertain" | "failed";
  faceCount: number | null;
  confidence: number | null;
  detectorName: string;
  detectorVersion: string;
  evidenceHash: string;
  evidence: Record<string, unknown>;
  coverage?: "full_image" | "sampled_video" | "full_video" | "none";
};

export interface PortraitPreflightDetector {
  detect(input: {
    sourceUrl: string;
    mediaType: "image" | "video";
    sourceSha256: string | null;
    signal: AbortSignal;
  }): Promise<PortraitFaceScanResult>;
}

type Environment = Record<string, string | undefined>;
type Row = Record<string, any>;

export type PortraitPreflightConfiguration = Readonly<{
  configured: boolean;
  valid: boolean;
  reason: string | null;
}>;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function sha256(value: unknown): string {
  return crypto.createHash("sha256").update(
    typeof value === "string" ? value : stableJson(value),
  ).digest("hex");
}

function boundedTimeout(value: unknown): number {
  const parsed = Number(value || 20_000);
  return Number.isSafeInteger(parsed) && parsed >= 1_000 && parsed <= 60_000
    ? parsed
    : 20_000;
}

function safeDetectorUrl(raw: unknown, env: Environment): URL | null {
  const value = String(raw || "").trim();
  if (!value) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("FANJIN_PORTRAIT_DETECTOR_URL is invalid");
  }
  const production = ["prod", "production"].includes(String(env.NODE_ENV || "").toLowerCase());
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(loopback && !production)) {
    throw new Error("portrait detector must use HTTPS outside local development");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("portrait detector URL may not contain credentials or fragments");
  }
  return parsed;
}

/**
 * Return a secret-free configuration verdict for readiness and Admin.
 * This intentionally never exposes the detector URL or bearer token.
 */
export function inspectPortraitPreflightConfiguration(
  environment: Environment = process.env,
): PortraitPreflightConfiguration {
  try {
    const endpoint = safeDetectorUrl(environment.FANJIN_PORTRAIT_DETECTOR_URL, environment);
    if (!endpoint) {
      return { configured: false, valid: true, reason: "endpoint_not_configured" };
    }
    const token = String(environment.FANJIN_PORTRAIT_DETECTOR_TOKEN || "").trim();
    if (!token || token.length > 8_192 || /[\u0000-\u001f\u007f]/u.test(token)) {
      return { configured: true, valid: false, reason: "token_not_configured" };
    }
    return { configured: true, valid: true, reason: null };
  } catch (error) {
    return {
      configured: true,
      valid: false,
      reason: error instanceof Error ? error.message : "configuration_invalid",
    };
  }
}

function normalizedDetectorResponse(
  value: unknown,
  sourceSha256: string | null,
  mediaType: "image" | "video",
): PortraitFaceScanResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("portrait detector response is invalid");
  }
  const row = value as Record<string, unknown>;
  const faceCount = Number(row.faceCount);
  const confidence = row.confidence == null ? null : Number(row.confidence);
  const detectorVersion = String(row.detectorVersion || "").trim();
  const evidenceId = String(row.evidenceId || "").trim();
  const reportedCoverage = String(row.coverage || "").trim().toLowerCase();
  if (
    !Number.isSafeInteger(faceCount)
    || faceCount < 0
    || faceCount > 100
    || (confidence !== null && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1))
    || !detectorVersion
    || detectorVersion.length > 128
    || (evidenceId && evidenceId.length > 256)
  ) throw new Error("portrait detector response fields are invalid");
  const state = faceCount === 0
    ? "no_face"
    : faceCount === 1
      ? "single_face"
      : "multiple_faces";
  const evidence = {
    version: "portrait-detector-evidence/v1",
    detectorVersion,
    evidenceId: evidenceId || null,
    faceCount,
    confidence,
    coverage: mediaType === "image"
      ? "full_image"
      : reportedCoverage === "full_video" ? "full_video" : "sampled_video",
    sourceSha256,
  };
  return {
    state,
    faceCount,
    confidence,
    detectorName: "configured-http",
    detectorVersion,
    evidenceHash: sha256(evidence),
    evidence,
    coverage: mediaType === "image"
      ? "full_image"
      : reportedCoverage === "full_video" ? "full_video" : "sampled_video",
  };
}

export function createConfiguredPortraitDetector(input: {
  environment?: Environment;
  fetchImpl?: typeof fetch;
} = {}): PortraitPreflightDetector {
  const environment = input.environment ?? process.env;
  const endpoint = safeDetectorUrl(environment.FANJIN_PORTRAIT_DETECTOR_URL, environment);
  const token = String(environment.FANJIN_PORTRAIT_DETECTOR_TOKEN || "").trim();
  const timeoutMs = boundedTimeout(environment.FANJIN_PORTRAIT_DETECTOR_TIMEOUT_MS);
  const fetchImpl = input.fetchImpl ?? fetch;

  return {
    async detect(request) {
      if (!endpoint) {
        const evidence = {
          version: "portrait-detector-evidence/v1",
          reason: "detector_not_configured",
          sourceSha256: request.sourceSha256,
        };
        return {
          state: "uncertain",
          faceCount: null,
          confidence: null,
          detectorName: "manual-required",
          detectorVersion: "unconfigured",
          evidenceHash: sha256(evidence),
          evidence,
          coverage: "none",
        };
      }
      if (!token) throw new Error("portrait detector token is not configured");
      const controller = new AbortController();
      const onAbort = () => controller.abort(request.signal.reason);
      request.signal.addEventListener("abort", onAbort, { once: true });
      const timeout = setTimeout(() => controller.abort(new Error("portrait detector timeout")), timeoutMs);
      timeout.unref?.();
      try {
        const response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            version: "portrait-preflight-request/v1",
            mediaType: request.mediaType,
            sourceUrl: request.sourceUrl,
            sourceSha256: request.sourceSha256,
          }),
          signal: controller.signal,
        });
        const body = await readPortraitControlResponse(response);
        if (!response.ok) throw new Error(`portrait detector returned HTTP ${response.status}`);
        return normalizedDetectorResponse(
          JSON.parse(body),
          request.sourceSha256,
          request.mediaType,
        );
      } finally {
        clearTimeout(timeout);
        request.signal.removeEventListener("abort", onAbort);
      }
    },
  };
}

export type PortraitPreflightWorkerDependencies = {
  database?: Knex;
  detector?: PortraitPreflightDetector;
  resolveSourceUrl?: (storagePath: string) => Promise<string>;
  now?: () => number;
  workerId?: string;
};

const STALE_SCAN_MS = 5 * 60_000;
const MAX_BATCH = 8;
const TERMINAL_FACE_SCAN_STATES = [
  "no_face",
  "single_face",
  "multiple_faces",
  "uncertain",
  "failed",
] as const;

const PORTRAIT_DETECTOR_DISPATCH_FENCE_VERSION =
  "portrait-detector-dispatch-fence/v1" as const;

function portraitDetectorDispatchFence(input: {
  admissionId: string;
  claimedRevision: number;
  mediaType: "image" | "video";
  sourceSha256: string;
  workspaceId: string;
}): Record<string, unknown> {
  return {
    version: PORTRAIT_DETECTOR_DISPATCH_FENCE_VERSION,
    admissionId: input.admissionId,
    claimedRevision: input.claimedRevision,
    mediaType: input.mediaType,
    sourceSha256: input.sourceSha256,
    workspaceId: input.workspaceId,
  };
}

function portraitDetectorFailureResult(input: {
  reason: "detector_failed" | "dispatch_outcome_unknown";
  sourceSha256: string;
  dispatchFenceHash?: string | null;
  diagnostic?: ReturnType<typeof portraitFailure>;
  recoveryHistory?: unknown[];
}): PortraitFaceScanResult {
  const evidence = {
    version: input.diagnostic ? "portrait-detector-failure/v2" : "portrait-detector-evidence/v1",
    reason: input.reason,
    sourceSha256: input.sourceSha256,
    dispatchFenceHash: input.dispatchFenceHash || null,
    retryAllowed: false,
    ...(input.diagnostic ? { diagnostic: input.diagnostic, recoveryHistory: input.recoveryHistory ?? [] } : {}),
  };
  return {
    state: "failed",
    faceCount: null,
    confidence: null,
    detectorName: "dispatch-fenced",
    detectorVersion: "at-most-once-v1",
    evidenceHash: sha256(evidence),
    evidence,
    coverage: "none",
  };
}

/**
 * Convert the retired 0.1.1 administrator-review queue into the 0.1.2
 * ImageX-presence workflow. The review row is retained as immutable history,
 * but it can no longer block a user or be claimed by an administrator.
 */
export async function supersedeLegacyPortraitManualReviews(input: {
  database: Knex;
  now?: number;
}): Promise<number> {
  if (!(await input.database.schema.hasTable(PORTRAIT_MANUAL_REVIEW_TABLE))) return 0;
  const now = input.now ?? Date.now();
  return input.database.transaction(async (trx) => {
    const rows = await trx(`${PORTRAIT_MANUAL_REVIEW_TABLE} as review`)
      .innerJoin(`${PORTRAIT_ADMISSION_TABLE} as admission`, "admission.id", "review.admissionId")
      .whereIn("review.state", ["pending", "claimed"])
      .select(
        "review.id",
        "review.admissionId",
        "review.revision as reviewRevision",
        "admission.faceCount",
        "admission.moderationState",
        "admission.declarationState",
        "admission.revision as admissionRevision",
      );
    let changed = 0;
    for (const row of rows) {
      const reviewChanged = await trx(PORTRAIT_MANUAL_REVIEW_TABLE)
        .where({ id: row.id, revision: row.reviewRevision })
        .whereIn("state", ["pending", "claimed"])
        .update({
          state: "superseded",
          claimOwnerUserId: null,
          claimSessionHash: null,
          claimLeaseExpiresAt: null,
          revision: Number(row.reviewRevision) + 1,
          updatedAt: now,
        });
      if (reviewChanged !== 1) continue;
      const hasFace = Number(row.faceCount || 0) >= 1;
      const alreadyDeclared = String(row.declarationState) === "confirmed";
      await trx(PORTRAIT_ADMISSION_TABLE)
        .where({ id: row.admissionId, revision: row.admissionRevision })
        .update({
          ...(alreadyDeclared ? {} : Number(row.faceCount || 0) >= 2 ? {
            faceScanState: "multiple_faces",
            subjectKind: "multiple_faces",
            declarationState: "not_required",
            complianceState: "denied",
          } : hasFace ? {
            faceScanState: Number(row.faceCount) >= 2 ? "multiple_faces" : "single_face",
            subjectKind: "pending",
            declarationState: "pending",
            complianceState: "pending",
          } : {
            faceScanState: "no_face",
            subjectKind: "ordinary",
            declarationState: "not_required",
            complianceState: "pending",
          }),
          manualReviewState: "superseded",
          manualReviewDecision: null,
          manualReviewEvidenceHash: null,
          manualReviewPolicyVersion: null,
          manualReviewedByUserId: null,
          manualReviewedAt: null,
          ...(alreadyDeclared ? {} : { providerSyncState: "not_needed" }),
          safeErrorCode: null,
          safeErrorMessage: null,
          revision: Number(row.admissionRevision) + 1,
          updatedAt: now,
        });
      changed += 1;
    }
    return changed;
  });
}

function resultAdmissionState(
  result: PortraitFaceScanResult,
  _moderationState: string,
): Record<string, unknown> {
  if (result.state === "no_face") {
    return {
      subjectKind: "ordinary",
      declarationState: "not_required",
      // A full-image no-face result completes the portrait-specific gate.
      // General content review is delegated to the generation provider.
      complianceState: result.coverage === "full_image" ? "not_required" : "pending",
      providerSyncState: "not_needed",
      safeErrorCode: null,
      safeErrorMessage: null,
    };
  }
  if (result.state === "single_face" || result.state === "multiple_faces") {
    return {
      subjectKind: "detected_person",
      declarationState: "not_required",
      complianceState: "allowed",
      providerSyncState: "queued",
      safeErrorCode: null,
      safeErrorMessage: null,
    };
  }
  return {
    // Inconclusive scan: never auto-classify as ordinary. Leave the user
    // declaration open so they can confirm virtual/real once; the platform
    // then finishes identity + provider work.
    subjectKind: "pending",
    declarationState: "pending",
    complianceState: "pending",
    providerSyncState: "not_needed",
    safeErrorCode: null,
    safeErrorMessage: null,
  };
}

function videoResultForPersistence(result: PortraitFaceScanResult): PortraitFaceScanResult {
  const state = result.faceCount == null
    ? result.state
    : result.faceCount >= 2 ? "multiple_faces"
      : result.faceCount === 1 ? "single_face" : "uncertain";
  return {
    ...result,
    state,
    coverage: result.coverage === "none" ? "none" : "sampled_video",
  };
}

async function persistPortraitPreflightResult(input: {
  database: Knex;
  admissionId: string;
  claimedRevision: number;
  result: PortraitFaceScanResult;
  mediaType: "image" | "video";
  moderationState: string;
  now: number;
}): Promise<boolean> {
  return input.database.transaction(async (trx) => {
    const admission = await trx(PORTRAIT_ADMISSION_TABLE)
      .where({
        id: input.admissionId,
        revision: input.claimedRevision,
        faceScanState: "scanning",
      })
      .forUpdate()
      .first();
    if (!admission) return false;
    const result = input.mediaType === "video"
      ? videoResultForPersistence(input.result)
      : {
          ...input.result,
          coverage: ["no_face", "single_face", "multiple_faces"].includes(input.result.state)
            ? "full_image" as const
            : input.result.coverage ?? "none",
        };
    await trx(PORTRAIT_ADMISSION_TABLE).where({ id: admission.id }).update({
      faceScanState: result.state,
      faceScanCoverage: result.coverage === "full_image"
        ? "full_image"
        : result.coverage === "none" ? "none" : "sampled_video",
      faceCount: result.faceCount,
      detectorName: result.detectorName,
      detectorVersion: result.detectorVersion,
      detectorConfidence: result.confidence,
      detectorEvidenceHash: result.evidenceHash,
      detectorEvidenceJson: stableJson(result.evidence),
      ...resultAdmissionState(result, input.moderationState),
      manualReviewState: "not_required",
      currentManualReviewId: null,
      manualReviewDecision: null,
      manualReviewEvidenceHash: null,
      manualReviewPolicyVersion: null,
      manualReviewedByUserId: null,
      manualReviewedAt: null,
      revision: Number(admission.revision) + 1,
      updatedAt: input.now,
    });
    return true;
  });
}

function cachedPortraitPreflightResult(row: Row | undefined): PortraitFaceScanResult | null {
  const state = String(row?.faceScanState || "") as PortraitFaceScanResult["state"];
  if (!row || !TERMINAL_FACE_SCAN_STATES.some((candidate) => candidate === state)) return null;
  if (!String(row.detectorEvidenceHash || "").trim()) return null;
  let evidence: Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(row.detectorEvidenceJson || "{}"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    evidence = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  return {
    state,
    faceCount: row.faceCount == null ? null : Number(row.faceCount),
    confidence: row.detectorConfidence == null ? null : Number(row.detectorConfidence),
    detectorName: String(row.detectorName || "cached-imagex"),
    detectorVersion: String(row.detectorVersion || "cached"),
    evidenceHash: String(row.detectorEvidenceHash),
    evidence,
    coverage: row.faceScanCoverage === "full_image"
      ? "full_image"
      : row.faceScanCoverage === "none" ? "none" : "sampled_video",
  };
}

async function findReusablePortraitPreflightResult(input: {
  database: Knex;
  admissionId: string;
  workspaceId: string;
  mediaType: "image" | "video";
  sourceSha256: string;
  recovering?: boolean;
  rejectedEvidenceHashes?: string[];
}): Promise<PortraitFaceScanResult | null> {
  const rows = await input.database(PORTRAIT_ADMISSION_TABLE)
    .where({
      workspaceId: input.workspaceId,
      mediaType: input.mediaType,
      sourceSha256: input.sourceSha256,
    })
    .whereNot({ id: input.admissionId })
    .whereIn("faceScanState", [...TERMINAL_FACE_SCAN_STATES])
    .orderBy("createdAt", "asc")
    .orderBy("id", "asc")
    .limit(MAX_BATCH);
  // A proven auth rejection did not execute a detector operation. Only an
  // explicitly requested recovery can ignore it; unknown/legacy fences remain.
  const rejectedHashes = new Set(input.rejectedEvidenceHashes ?? []);
  if (input.recovering) {
    // Copies can cache a known auth rejection. Follow only bounded, hash-checked
    // provenance; a legacy/unknown/corrupt cache is never a replay permission.
    for (let depth = 0; depth < rows.length; depth += 1) {
      const before = rejectedHashes.size;
      for (const row of rows) {
        const evidence = readPortraitEvidence(row);
        if (row.faceScanState === "failed" && evidence?.version === "portrait-detector-cache-reuse/v1"
          && evidence.state === "failed" && rejectedHashes.has(evidence.sourceDetectorEvidenceHash)) {
          rejectedHashes.add(String(row.detectorEvidenceHash));
        }
      }
      if (before === rejectedHashes.size) break;
    }
  }
  const candidates = rows.filter(row => !(input.recovering
    && (canRecoverPortraitFace(row) || rejectedHashes.has(String(row.detectorEvidenceHash)))));
  // Prefer an already confirmed result after a successful recovery of the same
  // immutable bytes, rather than permanently reusing an earlier auth failure.
  candidates.sort((a, b) => Number(["failed", "uncertain"].includes(a.faceScanState)) - Number(["failed", "uncertain"].includes(b.faceScanState)));
  for (const row of candidates) {
    const cached = cachedPortraitPreflightResult(row);
    if (!cached) continue;
    const reuseEvidence = {
      version: "portrait-detector-cache-reuse/v1",
      admissionId: input.admissionId,
      sourceAdmissionId: String(row.id),
      sourceDetectorEvidenceHash: cached.evidenceHash,
      sourceSha256: input.sourceSha256,
      state: cached.state,
      faceCount: cached.faceCount,
    };
    return {
      ...cached,
      evidenceHash: sha256(reuseEvidence),
      evidence: reuseEvidence,
    };
  }
  // A malformed or legacy terminal row still proves that the exact bytes may
  // already have crossed the paid detector boundary. Evidence corruption must
  // degrade to a local failed signal, never authorize another provider call.
  if (candidates.length > 0) {
    return portraitDetectorFailureResult({
      reason: "dispatch_outcome_unknown",
      sourceSha256: input.sourceSha256,
      dispatchFenceHash: String(candidates[0]?.detectorEvidenceHash || "") || null,
    });
  }
  return null;
}

async function isCanonicalPortraitPreflightClaim(input: {
  database: Knex;
  admissionId: string;
  workspaceId: string;
  mediaType: "image" | "video";
  sourceSha256: string;
}): Promise<boolean> {
  const row = await input.database(PORTRAIT_ADMISSION_TABLE)
    .where({
      workspaceId: input.workspaceId,
      mediaType: input.mediaType,
      sourceSha256: input.sourceSha256,
    })
    .whereIn("faceScanState", ["queued", "scanning"])
    .orderBy("createdAt", "asc")
    .orderBy("id", "asc")
    .select("id")
    .first();
  return String(row?.id || "") === input.admissionId;
}

async function repairLegacyDetectorFailureDenials(input: {
  database: Knex;
  now: number;
}): Promise<number> {
  const rows = await input.database(PORTRAIT_ADMISSION_TABLE)
    .whereIn("faceScanState", ["uncertain", "failed"])
    .where({
      subjectKind: "ambiguous",
      safeErrorCode: "PORTRAIT_SCAN_FAILED",
    })
    .orderBy("updatedAt", "asc")
    .limit(MAX_BATCH)
    .select("id", "revision", "moderationState");
  let repaired = 0;
  for (const row of rows) {
    const changed = await input.database(PORTRAIT_ADMISSION_TABLE)
      .where({
        id: row.id,
        revision: row.revision,
        subjectKind: "ambiguous",
        safeErrorCode: "PORTRAIT_SCAN_FAILED",
      })
      .whereIn("faceScanState", ["uncertain", "failed"])
      .update({
        subjectKind: "pending",
        declarationState: "pending",
        complianceState: "pending",
        providerSyncState: "not_needed",
        safeErrorCode: null,
        safeErrorMessage: null,
        revision: Number(row.revision) + 1,
        updatedAt: input.now,
      });
    if (changed === 1) repaired += 1;
  }
  return repaired;
}

export async function runPortraitPreflightBatch(
  dependencies: PortraitPreflightWorkerDependencies = {},
): Promise<{ claimed: number; processed: number }> {
  const database = dependencies.database ?? db;
  const maintenanceNow = (dependencies.now ?? Date.now)();
  await supersedeLegacyPortraitManualReviews({ database, now: maintenanceNow });
  await repairLegacyDetectorFailureDenials({ database, now: maintenanceNow });
  // The external detector remains an explicit dependency-injection override.
  // Production defaults are first-party ImageX for images and the bounded
  // ImageX frame sampler for videos; URL/token configuration is not required.
  const detector = dependencies.detector;
  const currentTime = (dependencies.now ?? Date.now)();
  const sourceStorageColumn = await database.schema.hasColumn("o_image", "storageKey")
    ? database.raw('COALESCE(NULLIF(??, ?), ??) AS ??', ["version.storageKey", "", "version.filePath", "sourceStorageKey"])
    : database.ref("version.filePath").as("sourceStorageKey");
  const rows = await database(`${PORTRAIT_ADMISSION_TABLE} as admission`)
    .innerJoin("o_image as version", "version.id", "admission.assetVersionId")
    .where((builder) => builder
      .where("admission.faceScanState", "queued")
      .orWhere((stale) => stale
        .where("admission.faceScanState", "scanning")
        .andWhere("admission.updatedAt", "<", currentTime - STALE_SCAN_MS)))
    // Historical schema-40 rows are materialized before their bytes have a
    // durable digest. Never hand such an object to ImageX/the detector; the
    // source-recovery worker must first bind the exact Fanjin object bytes.
    .whereNotNull("admission.sourceSha256")
    .orderBy("admission.updatedAt", "asc")
    .limit(MAX_BATCH)
    .select(
      "admission.id",
      "admission.workspaceId",
      "admission.projectId",
      "admission.assetVersionId",
      "admission.mediaType",
      "admission.faceScanState",
      "admission.detectorEvidenceHash",
      "admission.detectorEvidenceJson",
      "admission.sourceSha256",
      "admission.revision",
      "admission.moderationState",
      sourceStorageColumn,
    );
  let claimed = 0;
  let processed = 0;
  for (const row of rows) {
    const revision = Number(row.revision);
    const mediaType: "image" | "video" = row.mediaType === "video" ? "video" : "image";
    const sourceSha256 = String(row.sourceSha256 || "");
    const recoveryHistory = portraitRecoveryHistory(row);
    const withRecovery = (result: PortraitFaceScanResult): PortraitFaceScanResult => {
      if (!recoveryHistory.length) return result;
      const evidence = { ...result.evidence, sourceSha256, recoveryHistory };
      return { ...result, evidence, evidenceHash: sha256(evidence) };
    };
    const reusableInput = {
      database,
      admissionId: String(row.id),
      workspaceId: String(row.workspaceId),
      mediaType,
      sourceSha256,
      recovering: recoveryHistory.length > 0,
      rejectedEvidenceHashes: recoveryHistory.filter(item => isPortraitRetrySafeFailure(item?.diagnostic)
        && /^[a-f0-9]{64}$/u.test(String(item?.previousEvidenceHash))).map(item => String(item.previousEvidenceHash)),
    };

    // `scanning` is the durable at-most-once dispatch fence. Once a row has
    // entered that state, a previous worker may already have sent the paid
    // ImageX request even if it crashed before persisting the response. A stale
    // fence therefore may reuse another terminal result for the exact bytes,
    // but it must never be reopened or dispatched a second time.
    if (String(row.faceScanState) === "scanning") {
      const reusable = await findReusablePortraitPreflightResult(reusableInput);
      const recovered = await persistPortraitPreflightResult({
        database,
        admissionId: String(row.id),
        claimedRevision: revision,
        result: withRecovery(reusable ?? portraitDetectorFailureResult({
          reason: "dispatch_outcome_unknown",
          sourceSha256,
          dispatchFenceHash: String(row.detectorEvidenceHash || "") || null,
        })),
        mediaType,
        moderationState: String(row.moderationState || "pending"),
        now: (dependencies.now ?? Date.now)(),
      });
      if (recovered) {
        claimed += 1;
        processed += 1;
      }
      continue;
    }

    const claimedRevision = revision + 1;
    const dispatchFence = { ...portraitDetectorDispatchFence({
      admissionId: String(row.id),
      claimedRevision,
      mediaType,
      sourceSha256,
      workspaceId: String(row.workspaceId),
    }), ...(recoveryHistory.length ? { recoveryHistory } : {}) };
    const changed = await database(PORTRAIT_ADMISSION_TABLE)
      .where({ id: row.id, revision, faceScanState: "queued" })
      .update({
        faceScanState: "scanning",
        faceScanCoverage: "none",
        faceCount: null,
        detectorName: "dispatch-fenced",
        detectorVersion: "at-most-once-v1",
        detectorConfidence: null,
        detectorEvidenceHash: sha256(dispatchFence),
        detectorEvidenceJson: stableJson(dispatchFence),
        revision: claimedRevision,
        updatedAt: currentTime,
      });
    if (changed !== 1) continue;
    claimed += 1;
    const controller = new AbortController();
    try {
      let reusable = await findReusablePortraitPreflightResult(reusableInput);
      if (!reusable && !(await isCanonicalPortraitPreflightClaim(reusableInput))) {
        await database(PORTRAIT_ADMISSION_TABLE)
          .where({ id: row.id, revision: claimedRevision, faceScanState: "scanning" })
          .update({
            faceScanState: "queued",
            detectorName: null,
            detectorVersion: null,
            detectorEvidenceHash: row.detectorEvidenceHash ?? null,
            detectorEvidenceJson: row.detectorEvidenceJson || "{}",
            revision: revision + 2,
            updatedAt: currentTime,
          });
        continue;
      }
      // Close the small race in which the canonical claim finishes between
      // the first cache lookup and the canonical-row check.
      reusable ??= await findReusablePortraitPreflightResult(reusableInput);
      if (reusable) {
        const reused = await persistPortraitPreflightResult({
          database,
          admissionId: String(row.id),
          claimedRevision,
          result: withRecovery(reusable),
          mediaType,
          moderationState: String(row.moderationState || "pending"),
          now: (dependencies.now ?? Date.now)(),
        });
        if (reused) processed += 1;
        continue;
      }
      const resolveSourceUrl = dependencies.resolveSourceUrl
        ?? ((storagePath: string) => u.oss.getPrivateFileUrl(
          storagePath,
          { expiresInSeconds: 300 },
        ));
      const sourceUrl = await resolveSourceUrl(String(row.sourceStorageKey || ""));
      // ImageX is the first-party production image detector. Dependency
      // injection keeps deterministic unit tests and an explicit video sample
      // detector, but the default image path must not silently fall back to a
      // separately configured generic endpoint.
      const result = !detector && mediaType === "image"
        ? await detectPortraitImageFacesWithImageX({
            admissionId: String(row.id),
            admissionRevision: claimedRevision,
            assetVersionId: Number(row.assetVersionId),
            database,
            projectId: Number(row.projectId),
            signal: controller.signal,
            sourceSha256: String(row.sourceSha256 || ""),
            sourceUrl,
            workspaceId: String(row.workspaceId),
          })
        : !detector
          ? await detectPortraitVideoFacesWithImageX({
              database,
              projectId: Number(row.projectId),
              signal: controller.signal,
              sourceSha256: String(row.sourceSha256 || ""),
              sourceUrl,
              workspaceId: String(row.workspaceId),
            })
          : await detector.detect({
              sourceUrl,
              mediaType,
              sourceSha256: row.sourceSha256 ? String(row.sourceSha256) : null,
              signal: controller.signal,
            });
      const finishedAt = (dependencies.now ?? Date.now)();
      const finalChanged = await persistPortraitPreflightResult({
        database,
        admissionId: String(row.id),
        claimedRevision,
        result: withRecovery(result),
        mediaType,
        moderationState: String(row.moderationState || "pending"),
        now: finishedAt,
      });
      if (finalChanged) processed += 1;
    } catch (caught) {
      const failedAt = (dependencies.now ?? Date.now)();
      const failureResult = portraitDetectorFailureResult({
        reason: "detector_failed",
        sourceSha256,
        dispatchFenceHash: sha256(dispatchFence),
        diagnostic: portraitFailure(caught),
        recoveryHistory,
      });
      try {
        const failureChanged = await persistPortraitPreflightResult({
          database,
          admissionId: String(row.id),
          claimedRevision,
          result: failureResult,
          mediaType,
          moderationState: String(row.moderationState || "pending"),
          now: failedAt,
        });
        if (failureChanged) processed += 1;
      } catch {
        const fallbackChanged = await database(PORTRAIT_ADMISSION_TABLE)
          .where({ id: row.id, revision: claimedRevision, faceScanState: "scanning" })
          .update({
            faceScanState: "failed",
            faceScanCoverage: "none",
            faceCount: null,
            detectorName: failureResult.detectorName,
            detectorVersion: failureResult.detectorVersion,
            detectorConfidence: null,
            detectorEvidenceHash: failureResult.evidenceHash,
            detectorEvidenceJson: stableJson(failureResult.evidence),
            subjectKind: "pending",
            declarationState: "pending",
            complianceState: "pending",
            providerSyncState: "not_needed",
            safeErrorCode: null,
            safeErrorMessage: null,
            revision: revision + 2,
            updatedAt: failedAt,
          });
        if (fallbackChanged === 1) processed += 1;
      }
    }
  }
  return { claimed, processed };
}

let workerTimer: NodeJS.Timeout | null = null;
let workerTick: Promise<unknown> | null = null;

export function startPortraitPreflightWorker(): void {
  if (workerTimer) return;
  const run = () => {
    if (workerTick) return;
    workerTick = runPortraitPreflightBatch()
      .catch(() => undefined)
      .finally(() => { workerTick = null; });
  };
  run();
  workerTimer = setInterval(run, 5_000);
  workerTimer.unref?.();
}

export async function stopPortraitPreflightWorker(): Promise<void> {
  if (workerTimer) clearInterval(workerTimer);
  workerTimer = null;
  await workerTick;
}
