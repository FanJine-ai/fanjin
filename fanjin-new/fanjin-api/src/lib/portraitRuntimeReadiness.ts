import type { Knex } from "knex";

import { parseProviderChannelConfig } from "@/lib/providerChannelSecrets";
import {
  inspectProviderChannelPortraitCredential,
  readProviderChannelPortraitCredentialMetadata,
} from "@/lib/providerChannelCredentials";
import type { PortraitModerationConfiguration } from "@/lib/portraitModeration";
import type { PortraitPreflightConfiguration } from "@/lib/portraitPreflight";
import {
  inspectPortraitVideoSampleCleanupBacklog,
  inspectPortraitVideoSamplerConfiguration,
  type PortraitVideoSampleCleanupInspection,
} from "@/lib/portraitVideoSampler";
import {
  isFormalCandidateRuntimeCapabilityDeclared,
} from "@/lib/formalCandidateCredentialRuntime";
import {
  PORTRAIT_ASSETS_RUNTIME_CAPABILITY,
  PORTRAIT_IMAGEX_REVIEW_RUNTIME_CAPABILITY,
} from "@/lib/portraitRuntimeCapability";
import {
  inspectPortraitImageXReviewRuntimeConfiguration,
  inspectPortraitImageXReviewWorker,
  PORTRAIT_IMAGEX_REVIEW_WORKER_HEARTBEAT_ROLE,
  type PortraitImageXRuntimeInspection,
} from "@/lib/portraitImageXReviewRuntime";
import { getReleaseIdentity } from "@/lib/releaseIdentity";
import { resolveWorkerHeartbeatFutureSkewMs } from "@/lib/workerHeartbeatPolicy";

type Environment = Record<string, string | undefined>;

export type PortraitCallbackConfiguration = Readonly<{
  configured: boolean;
  valid: boolean;
  reason: string | null;
}>;

export type PortraitProviderChannelInspection = Readonly<{
  inspected: boolean;
  ready: boolean;
  enabledChannelCount: number | null;
  usableChannelCount: number | null;
  reason: string | null;
}>;

export const portraitImageXWorkerSafeReasons = [
  "imagex_review_channel_unavailable",
  "imagex_review_worker_tick_failed",
  "imagex_review_worker_not_running",
  "imagex_review_worker_not_observed",
  "imagex_review_worker_heartbeat_stale",
  "imagex_review_worker_heartbeat_future",
  "imagex_review_worker_release_mismatch",
  "imagex_review_worker_release_unverifiable",
  "imagex_review_worker_unhealthy",
  "imagex_review_worker_inspection_failed",
] as const;

export type PortraitImageXWorkerSafeReason =
  (typeof portraitImageXWorkerSafeReasons)[number] | null;

export type PortraitImageXWorkerReadinessInspection = Readonly<{
  source: "local" | "durable_heartbeat";
  requiredLocally: boolean;
  running: boolean;
  inFlight: boolean;
  heartbeatFresh: boolean;
  heartbeatAt: number | null;
  heartbeatAgeMs: number | null;
  lastTickAt: number | null;
  lastSuccessAt: number | null;
  safeReason: PortraitImageXWorkerSafeReason;
}>;

export type PortraitImageXReadinessInspection = Readonly<
  PortraitImageXRuntimeInspection & {
    worker: PortraitImageXWorkerReadinessInspection;
  }
>;

export type PortraitRuntimeReadinessInspection = Readonly<{
  required: boolean;
  ready: boolean;
  preflight: PortraitPreflightConfiguration;
  moderation: PortraitModerationConfiguration;
  imageXReview: PortraitImageXReadinessInspection;
  callback: PortraitCallbackConfiguration;
  providerChannels: PortraitProviderChannelInspection;
  videoSampleCleanup: PortraitVideoSampleCleanupInspection;
}>;

function isProduction(environment: Environment): boolean {
  return ["prod", "production"].includes(
    String(environment.NODE_ENV || "").trim().toLowerCase(),
  );
}

function requiresLocalImageXWorker(environment: Environment): boolean {
  const role = String(
    environment.FANJIN_PROCESS_ROLE
      || environment.FANJIN_SERVICE_ROLE
      || "all",
  ).trim().toLowerCase();
  if (["api", "server", "web"].includes(role)) return false;
  // Unknown roles fail closed here; app startup independently rejects them.
  return true;
}

const DEFAULT_IMAGEX_WORKER_HEARTBEAT_MAX_AGE_MS = 45_000;

function positiveHeartbeatAge(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 5_000 && parsed <= 24 * 60 * 60_000
    ? parsed
    : DEFAULT_IMAGEX_WORKER_HEARTBEAT_MAX_AGE_MS;
}

function localImageXWorkerInspection(
  requiredLocally: boolean,
): PortraitImageXWorkerReadinessInspection {
  const lifecycle = inspectPortraitImageXReviewWorker();
  const heartbeatAt = lifecycle.lastSuccessAt ?? lifecycle.lastTickAt;
  return Object.freeze({
    source: "local",
    requiredLocally,
    running: lifecycle.running,
    inFlight: lifecycle.inFlight,
    heartbeatFresh: lifecycle.running && heartbeatAt !== null,
    heartbeatAt,
    heartbeatAgeMs: heartbeatAt === null ? null : Math.max(0, Date.now() - heartbeatAt),
    lastTickAt: lifecycle.lastTickAt,
    lastSuccessAt: lifecycle.lastSuccessAt,
    safeReason: lifecycle.safeReason ?? (
      lifecycle.running ? null : "imagex_review_worker_not_running"
    ),
  });
}

async function durableImageXWorkerInspection(input: {
  database: Knex;
  environment: Environment;
  now?: number;
}): Promise<PortraitImageXWorkerReadinessInspection> {
  const now = input.now ?? Date.now();
  const empty = (
    safeReason: PortraitImageXWorkerSafeReason,
    heartbeatAt: number | null = null,
  ): PortraitImageXWorkerReadinessInspection => Object.freeze({
    source: "durable_heartbeat",
    requiredLocally: false,
    running: false,
    inFlight: false,
    heartbeatFresh: false,
    heartbeatAt,
    heartbeatAgeMs: heartbeatAt === null ? null : Math.max(0, now - heartbeatAt),
    lastTickAt: heartbeatAt,
    lastSuccessAt: null,
    safeReason,
  });
  try {
    const rows = await input.database<Record<string, unknown>>("o_worker_heartbeat")
      .where({ role: PORTRAIT_IMAGEX_REVIEW_WORKER_HEARTBEAT_ROLE })
      .orderBy("heartbeatAt", "desc");
    if (!rows.length) return empty("imagex_review_worker_not_observed");
    const futureSkewMs = resolveWorkerHeartbeatFutureSkewMs(
      input.environment.FANJIN_WORKER_HEARTBEAT_FUTURE_SKEW_MS,
    );
    const timestamps = rows.map((row) => Number(row.heartbeatAt));
    if (timestamps.some((value) => (
      !Number.isSafeInteger(value) || value > now + futureSkewMs
    ))) {
      return empty("imagex_review_worker_heartbeat_future");
    }
    const release = getReleaseIdentity(input.environment);
    const topology = String(
      input.environment.FANJIN_RELEASE_WORKER_TOPOLOGY || "",
    ).trim().toLowerCase();
    const exactIdentityRequired = isProduction(input.environment)
      || topology === "dedicated"
      || String(input.environment.FANJIN_FORMAL_CANDIDATE_RUNTIME || "").trim() === "1";
    if (exactIdentityRequired && (!release.artifactSha256 || release.schemaVersion === null)) {
      return empty("imagex_review_worker_release_unverifiable");
    }
    const matchingRows = exactIdentityRequired
      ? rows.filter((row) => (
          row.artifactSha256 === release.artifactSha256
          && Number(row.schemaVersion) === release.schemaVersion
        ))
      : rows;
    if (!matchingRows.length) {
      return empty(
        "imagex_review_worker_release_mismatch",
        Number(rows[0]?.heartbeatAt) || null,
      );
    }
    const row = matchingRows[0];
    const heartbeatAt = Number(row.heartbeatAt);
    const maxAgeMs = positiveHeartbeatAge(
      input.environment.FANJIN_WORKER_HEARTBEAT_MAX_AGE_MS,
    );
    if (heartbeatAt < now - maxAgeMs) {
      return empty("imagex_review_worker_heartbeat_stale", heartbeatAt);
    }
    const healthy = row.acceptingWork === true || Number(row.acceptingWork) === 1;
    return Object.freeze({
      source: "durable_heartbeat",
      requiredLocally: false,
      running: true,
      inFlight: false,
      heartbeatFresh: true,
      heartbeatAt,
      heartbeatAgeMs: Math.max(0, now - heartbeatAt),
      lastTickAt: heartbeatAt,
      lastSuccessAt: healthy ? heartbeatAt : null,
      safeReason: healthy ? null : "imagex_review_worker_unhealthy",
    });
  } catch {
    return empty("imagex_review_worker_inspection_failed");
  }
}

function callbackOrigin(environment: Environment): URL | null {
  const raw = String(
    environment.FANJIN_PORTRAIT_CALLBACK_ORIGIN
      || environment.FANJIN_PUBLIC_BASE_URL
      || environment.PUBLIC_BASE_URL
      || "",
  ).trim();
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("callback_origin_invalid");
  }
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  if (
    (parsed.protocol !== "https:" && !(loopback && !isProduction(environment)))
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) throw new Error("callback_origin_invalid");
  return parsed;
}

/** Secret-free validation used by both readiness and release evidence. */
export function inspectPortraitCallbackConfiguration(
  environment: Environment = process.env,
): PortraitCallbackConfiguration {
  try {
    const origin = callbackOrigin(environment);
    return origin
      ? { configured: true, valid: true, reason: null }
      : { configured: false, valid: true, reason: "callback_origin_not_configured" };
  } catch {
    return { configured: true, valid: false, reason: "callback_origin_invalid" };
  }
}

function nonEmpty(value: unknown, maximum = 256): boolean {
  const parsed = String(value ?? "").trim();
  return Boolean(
    parsed
    && parsed.length <= maximum
    && !/[\u0000-\u001f\u007f]/u.test(parsed),
  );
}

function channelIsUsable(
  row: Record<string, unknown>,
): boolean {
  if (!nonEmpty(row.id)) return false;
  try {
    const config = parseProviderChannelConfig(row.configJson);
    const providerAccountId = config.providerAccountId
      ?? config.volcengineAccountId
      ?? config.accountId;
    const projectName = config.assetsProjectName ?? config.projectName;
    const account = String(providerAccountId ?? "").trim();
    const project = String(projectName ?? "").trim();
    const credential = inspectProviderChannelPortraitCredential(String(row.id), config);
    return credential.enabled
      && credential.configured
      && nonEmpty(account, 128)
      && /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,127}$/u.test(account)
      && nonEmpty(project, 128)
      && /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u.test(project);
  } catch {
    return false;
  }
}

export async function inspectPortraitProviderChannels(
  database: Knex,
  environment: Environment = process.env,
): Promise<PortraitProviderChannelInspection> {
  // Formal readiness reflects only the root-owned FD4 expectation copied from
  // the signed manifest. It never reads/consumes FD6 or trusts an environment
  // switch as proof. FD6 independently cross-binds the identical capability
  // set before exposing the exact `volcano-portrait-assets` scope.
  if (String(environment.FANJIN_FORMAL_CANDIDATE_RUNTIME || "").trim() === "1") {
    const ready = isFormalCandidateRuntimeCapabilityDeclared(
      PORTRAIT_ASSETS_RUNTIME_CAPABILITY,
    );
    return {
      inspected: true,
      ready,
      enabledChannelCount: null,
      usableChannelCount: ready ? 1 : 0,
      reason: ready ? null : "formal_portrait_capability_unattested",
    };
  }
  try {
    const rows = await database<Record<string, unknown>>("o_provider_channel")
      .where({
        provider: "volcano",
        endpointType: "video_generation",
        disabled: 0,
        scope: "platform",
      })
      .whereNull("workspaceId")
      .select("id", "configJson");
    const enabledRows = rows.filter((row) => (
      readProviderChannelPortraitCredentialMetadata(row.configJson).enabled
    ));
    const usableChannelCount = enabledRows.filter((row) => channelIsUsable(row)).length;
    return {
      inspected: true,
      ready: usableChannelCount > 0,
      enabledChannelCount: enabledRows.length,
      usableChannelCount,
      reason: usableChannelCount > 0
        ? null
        : enabledRows.length > 0
          ? "provider_channel_portrait_credential_unavailable"
          : "provider_channel_portrait_assets_not_enabled",
    };
  } catch {
    return {
      inspected: false,
      ready: false,
      enabledChannelCount: null,
      usableChannelCount: null,
      reason: "provider_channel_inspection_failed",
    };
  }
}

/** Secret-free ImageX audit verdict shared by readiness and Admin. */
export async function inspectPortraitImageXReviewReadinessConfiguration(input: {
  database: Knex;
  environment?: Environment;
  required?: boolean;
}): Promise<PortraitImageXReadinessInspection> {
  const environment = input.environment ?? process.env;
  const requiredLocally = false; // The separate content-audit worker is retired.
  const worker = requiresLocalImageXWorker(environment)
    ? localImageXWorkerInspection(requiredLocally)
    : await durableImageXWorkerInspection({
        database: input.database,
        environment,
      });
  if (input.required === false) {
    return Object.freeze({
      configured: false,
      valid: true,
      reason: "not_required",
      channelCount: 0,
      worker,
    });
  }
  if (String(environment.FANJIN_FORMAL_CANDIDATE_RUNTIME || "").trim() === "1") {
    const declared = isFormalCandidateRuntimeCapabilityDeclared(
      PORTRAIT_IMAGEX_REVIEW_RUNTIME_CAPABILITY,
    );
    if (!declared) {
      return Object.freeze({
        configured: false,
        valid: false,
        reason: "formal_imagex_review_capability_unattested",
        channelCount: 0,
        worker,
      });
    }
  }
  // The configuration inspector remains metadata-only in formal mode: it
  // verifies enabled/generation/binding without opening FD6 or exposing any
  // ServiceId/AK/SK. FD4 declaration alone is not sufficient.
  const configuration = await inspectPortraitImageXReviewRuntimeConfiguration({
    database: input.database,
  });
  return Object.freeze({
    ...configuration,
    // Face detection still needs valid isolated ImageX credentials; the
    // retired full-film content-audit worker is no longer a readiness gate.
    valid: configuration.valid,
    reason: configuration.reason,
    worker,
  });
}

export async function inspectPortraitRuntimeReadiness(input: {
  database: Knex;
  environment?: Environment;
  required: boolean;
}): Promise<PortraitRuntimeReadinessInspection> {
  const environment = input.environment ?? process.env;
  const sampler = inspectPortraitVideoSamplerConfiguration(environment);
  const videoSampleCleanup = input.required
    ? await inspectPortraitVideoSampleCleanupBacklog(input.database)
    : Object.freeze({
        inspected: false,
        ready: true,
        outstandingCount: 0,
        reason: null,
      });
  const callback = inspectPortraitCallbackConfiguration(environment);
  const imageXReview = await inspectPortraitImageXReviewReadinessConfiguration({
    database: input.database,
    environment,
    required: input.required,
  });
  // Production preflight is the complete built-in ImageX sampler: media
  // tools + exact remote storage configuration + a usable ImageX runtime.
  // The legacy HTTP detector remains injectable for tests/controlled
  // overrides, but its endpoint/token cannot make release readiness healthy.
  const preflight: PortraitPreflightConfiguration = sampler.valid
    && videoSampleCleanup.ready
    ? Object.freeze({
        configured: imageXReview.configured,
        valid: imageXReview.valid,
        reason: imageXReview.reason,
      })
    : !sampler.valid
      ? sampler
      : Object.freeze({
          configured: true,
          valid: false,
          reason: videoSampleCleanup.reason,
        });
  const moderation: PortraitModerationConfiguration = Object.freeze({
    configured: false,
    valid: true,
    reason: "delegated_to_generation_provider",
  });
  const providerChannels = input.required
    ? await inspectPortraitProviderChannels(input.database, environment)
    : {
        inspected: false,
        ready: true,
        enabledChannelCount: null,
        usableChannelCount: null,
        reason: null,
      } as const;
  const ready = !input.required || (
    preflight.configured
    && preflight.valid
    && imageXReview.configured
    && imageXReview.valid
    && callback.configured
    && callback.valid
    && providerChannels.ready
    && videoSampleCleanup.ready
  );
  return Object.freeze({
    required: input.required,
    ready,
    preflight,
    moderation,
    imageXReview,
    callback,
    providerChannels,
    videoSampleCleanup,
  });
}
