import { isAutomaticPortrait } from "@/lib/portraitAutomaticRegistration";
import crypto from "node:crypto";
import { portraitFailure } from "@/lib/portraitFailure";
import type { Knex } from "knex";
import { db } from "@/utils/db";
import u from "@/utils";
import { PORTRAIT_ADMISSION_TABLE } from "@/lib/migrations/portraitAssetAdmission";
import { readPortraitControlResponse } from "@/lib/portraitRemoteResponse";
import {
  inspectPortraitImageXReviewRuntimeConfiguration,
  moderatePortraitImageWithImageX,
} from "@/lib/portraitImageXReviewRuntime";

type Environment = Record<string, string | undefined>;

export type PortraitModerationDecision = Readonly<{
  state: "allowed" | "denied";
  policyVersion: string;
  reasonCode: string | null;
  evidenceHash: string;
}>;

export interface PortraitModerationClient {
  moderate(input: {
    sourceUrl: string;
    sourceSha256: string | null;
    mediaType: "image" | "video";
    signal: AbortSignal;
  }): Promise<PortraitModerationDecision>;
}

export type PortraitModerationConfiguration = Readonly<{
  configured: boolean;
  valid: boolean;
  reason: string | null;
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

function parseEndpoint(environment: Environment): URL | null {
  const raw = String(environment.FANJIN_REFERENCE_MODERATION_URL || "").trim();
  if (!raw) return null;
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new Error("FANJIN_REFERENCE_MODERATION_URL is invalid");
  }
  const production = ["prod", "production"].includes(
    String(environment.NODE_ENV || "").trim().toLowerCase(),
  );
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(endpoint.hostname);
  if (endpoint.protocol !== "https:" && !(loopback && !production)) {
    throw new Error("reference moderation endpoint must use HTTPS outside local development");
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("reference moderation endpoint may not contain credentials or fragments");
  }
  return endpoint;
}

function timeoutMs(value: unknown): number {
  const parsed = Number(value || 20_000);
  return Number.isSafeInteger(parsed) && parsed >= 1_000 && parsed <= 60_000
    ? parsed
    : 20_000;
}

function safeToken(value: unknown, maximum: number): string {
  const parsed = String(value ?? "").trim();
  return parsed
    && parsed.length <= maximum
    && !/[\u0000-\u001f\u007f]/u.test(parsed)
    ? parsed
    : "";
}

export function inspectPortraitModerationConfiguration(
  environment: Environment = process.env,
): PortraitModerationConfiguration {
  try {
    const endpoint = parseEndpoint(environment);
    if (!endpoint) return { configured: false, valid: true, reason: "endpoint_not_configured" };
    if (!safeToken(environment.FANJIN_REFERENCE_MODERATION_TOKEN, 8_192)) {
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

export function createConfiguredPortraitModerationClient(input: {
  environment?: Environment;
  fetchImpl?: typeof fetch;
} = {}): PortraitModerationClient | null {
  const environment = input.environment ?? process.env;
  const endpoint = parseEndpoint(environment);
  if (!endpoint) return null;
  const token = safeToken(environment.FANJIN_REFERENCE_MODERATION_TOKEN, 8_192);
  if (!token) throw new Error("FANJIN_REFERENCE_MODERATION_TOKEN is not configured");
  const requestTimeoutMs = timeoutMs(environment.FANJIN_REFERENCE_MODERATION_TIMEOUT_MS);
  const fetchImpl = input.fetchImpl ?? fetch;

  return {
    async moderate(request) {
      const controller = new AbortController();
      const onAbort = () => controller.abort(request.signal.reason);
      request.signal.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(
        () => controller.abort(new Error("reference moderation timeout")),
        requestTimeoutMs,
      );
      timer.unref?.();
      try {
        const response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            version: "fanjin-reference-moderation-request/v1",
            mediaType: request.mediaType,
            sourceUrl: request.sourceUrl,
            sourceSha256: request.sourceSha256,
          }),
          signal: controller.signal,
        });
        const body = await readPortraitControlResponse(response);
        if (!response.ok) throw new Error(`reference moderation returned HTTP ${response.status}`);
        const parsed = JSON.parse(body) as Record<string, unknown>;
        const state = parsed?.decision;
        const policyVersion = safeToken(parsed?.policyVersion, 128);
        const evidenceId = safeToken(parsed?.evidenceId, 256);
        const reasonCode = parsed?.reasonCode == null
          ? null
          : safeToken(parsed.reasonCode, 128);
        if (
          (state !== "allowed" && state !== "denied")
          || !policyVersion
          || !evidenceId
          || (parsed?.reasonCode != null && !reasonCode)
        ) throw new Error("reference moderation response fields are invalid");
        const evidence = {
          version: "fanjin-reference-moderation-evidence/v1",
          evidenceId,
          mediaType: request.mediaType,
          policyVersion,
          reasonCode,
          sourceSha256: request.sourceSha256,
          state,
        };
        return {
          state,
          policyVersion,
          reasonCode,
          evidenceHash: sha256(evidence),
        };
      } finally {
        clearTimeout(timer);
        request.signal.removeEventListener("abort", onAbort);
      }
    },
  };
}

export type PortraitModerationWorkerDependencies = {
  database?: Knex;
  client?: PortraitModerationClient | null;
  resolveSourceUrl?: (storagePath: string) => Promise<string>;
  now?: () => number;
};

const MAX_BATCH = 8;
const STALE_MODERATION_MS = 5 * 60_000;

function resultingCompliance(row: Record<string, unknown>, state: "allowed" | "denied") {
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

function resultingProviderSync(
  row: Record<string, unknown>,
  complianceState: string,
): string {
  const subject = String(row.subjectKind || "");
  if (complianceState !== "allowed") {
    return complianceState === "denied"
      && ["real_person", "virtual_person", "trusted_output", "detected_person"].includes(subject)
      ? "failed"
      : "not_needed";
  }
  if (subject === "real_person") {
    return String(row.identityState || "") === "active" ? "queued" : "authorizing";
  }
  if (["virtual_person", "trusted_output", "detected_person"].includes(subject)) return "queued";
  return "not_needed";
}

export async function runPortraitModerationBatch(
  dependencies: PortraitModerationWorkerDependencies = {},
): Promise<{ claimed: number; processed: number; configured: boolean }> {
  const database = dependencies.database ?? db;
  const useImageX = dependencies.client === undefined;
  const client = useImageX ? null : dependencies.client;
  if (useImageX) {
    const inspection = await inspectPortraitImageXReviewRuntimeConfiguration({ database });
    if (!inspection.configured || !inspection.valid) {
      return { claimed: 0, processed: 0, configured: false };
    }
  } else if (!client) {
    return { claimed: 0, processed: 0, configured: false };
  }
  const now = dependencies.now ?? Date.now;
  const startedAt = now();
  const sourceStorageColumn = await database.schema.hasColumn("o_image", "storageKey")
    ? "version.storageKey"
    : "version.filePath";
  const rows = await database(`${PORTRAIT_ADMISSION_TABLE} as admission`)
    .innerJoin("o_image as version", "version.id", "admission.assetVersionId")
    .leftJoin("o_portrait_identity as identity", "identity.id", "admission.identityId")
    // Video content review is exclusively owned by the durable ImageX
    // full-film state machine. Letting this synchronous image worker claim a
    // video row would race that job and could incorrectly make a video
    // compliant without the full-film review.
    .where("admission.mediaType", "image")
    .where((builder) => builder
      .where("admission.moderationState", "pending")
      .orWhere((stale) => stale
        .where("admission.moderationState", "checking")
        .andWhere("admission.updatedAt", "<", startedAt - STALE_MODERATION_MS)))
    // Content review does not depend on a person-type declaration. Review
    // immediately; resultingCompliance still requires the correct declaration
    // before any portrait can enter provider registration.
    .whereIn("admission.faceScanState", ["no_face", "uncertain", "failed", "single_face", "multiple_faces"])
    .whereNotNull("admission.sourceSha256")
    .orderBy("admission.updatedAt", "asc")
    .limit(MAX_BATCH)
    .select(
      "admission.*",
      "identity.state as identityState",
      { sourceStorageKey: sourceStorageColumn },
    );
  let claimed = 0;
  let processed = 0;
  for (const row of rows) {
    const revision = Number(row.revision);
    const claimedAt = now();
    const changed = await database(PORTRAIT_ADMISSION_TABLE)
      .where({ id: row.id, revision })
      .whereIn("moderationState", ["pending", "checking"])
      .update({ moderationState: "checking", revision: revision + 1, updatedAt: claimedAt });
    if (changed !== 1) continue;
    claimed += 1;
    try {
      const resolveSourceUrl = dependencies.resolveSourceUrl
        ?? ((storagePath: string) => u.oss.getPrivateFileUrl(
          storagePath,
          { expiresInSeconds: 300 },
        ));
      const sourceUrl = await resolveSourceUrl(String(row.sourceStorageKey || ""));
      const controller = new AbortController();
      const decision = useImageX
        ? await moderatePortraitImageWithImageX({
            admissionId: String(row.id),
            admissionRevision: revision + 1,
            assetVersionId: Number(row.assetVersionId),
            database,
            projectId: Number(row.projectId),
            signal: controller.signal,
            sourceSha256: String(row.sourceSha256 || ""),
            sourceUrl,
            workspaceId: String(row.workspaceId),
          })
        : await client!.moderate({
            sourceUrl,
            sourceSha256: row.sourceSha256 ? String(row.sourceSha256) : null,
            mediaType: "image",
            signal: controller.signal,
          });
      const complianceState = resultingCompliance(row, decision.state);
      const finishedAt = now();
      const finalChanged = await database(PORTRAIT_ADMISSION_TABLE)
        .where({ id: row.id, revision: revision + 1, moderationState: "checking" })
        .update({
          moderationState: decision.state,
          moderationEvidenceHash: decision.evidenceHash,
          moderationPolicyVersion: decision.policyVersion,
          moderationReasonCode: decision.reasonCode,
          moderationUpdatedAt: finishedAt,
          complianceState,
          providerSyncState: resultingProviderSync(row, complianceState),
          safeErrorCode: decision.state === "denied" ? "PORTRAIT_MODERATION_DENIED" : null,
          safeErrorMessage: decision.state === "denied" ? "素材未通过安全审核，请更换素材" : null,
          revision: revision + 2,
          updatedAt: finishedAt,
        });
      if (finalChanged === 1) processed += 1;
    } catch (caught) {
      const failure = portraitFailure(caught);
      const failedAt = now();
      await database(PORTRAIT_ADMISSION_TABLE)
        .where({ id: row.id, revision: revision + 1, moderationState: "checking" })
        .update({
          moderationState: "failed",
          moderationEvidenceHash: null,
          moderationPolicyVersion: null,
          moderationReasonCode: failure.category === "configuration" ? "moderation_configuration_error" : "moderation_unavailable",
          moderationUpdatedAt: failedAt,
          complianceState: "pending",
          safeErrorCode: failure.category === "configuration" ? "PORTRAIT_MODERATION_CONFIGURATION_ERROR" : "PORTRAIT_MODERATION_FAILED",
          safeErrorMessage: `${failure.message}${failure.requestId ? `（请求号 ${failure.requestId}；${failure.upstreamCode || failure.code}）` : ""}`,
          revision: revision + 2,
          updatedAt: failedAt,
        });
    }
  }
  return { claimed, processed, configured: true };
}

let workerTimer: NodeJS.Timeout | null = null;
let workerTick: Promise<unknown> | null = null;

export function startPortraitModerationWorker(): void {
  if (workerTimer) return;
  const run = () => {
    if (workerTick) return;
    workerTick = runPortraitModerationBatch()
      .catch(() => undefined)
      .finally(() => { workerTick = null; });
  };
  run();
  workerTimer = setInterval(run, 5_000);
  workerTimer.unref?.();
}

export async function stopPortraitModerationWorker(): Promise<void> {
  if (workerTimer) clearInterval(workerTimer);
  workerTimer = null;
  await workerTick;
}
