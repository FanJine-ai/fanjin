import {
  constants,
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import type { Knex } from "knex";
import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  verify,
  type KeyObject,
} from "node:crypto";

import type { ReleaseDeploymentMode, LoadBalancer } from "./types";
import {
  type VolcengineMaintenanceCanaryTrafficGate,
  type VolcengineMaintenanceCanaryTrafficGateObservation,
  type VolcengineMaintenanceCanaryTrafficGateQuery,
} from "./volcengineClb";
import type { VolcengineAlbAdapterOptions } from "./volcengineAlb";
import { createLoadBalancerFromEnv, type LoadBalancerProvider } from "./loadBalancerProvider";
import {
  MultiDomainSmokeLoadBalancer,
  resolveRequiredSmokeTargets,
  type SmokeProbeTransports,
} from "./multiDomainPublicSmoke";
import type { MaintenanceCanaryPlanReceipt } from "./types";

const CONTROL_PLANE_FILE_ENV = "FANJIN_RELEASE_MAINTENANCE_CONTROL_PLANE_FILE";
const CONTROL_PLANE_FORMAT = "fanjin-volcengine-maintenance-control-plane/v1" as const;
const REQUEST_FORMAT = "fanjin-trusted-maintenance-control-request/v1" as const;
const ENVELOPE_FORMAT = "fanjin-trusted-maintenance-control-envelope/v1" as const;
const PREFLIGHT_FORMAT = "fanjin-volcengine-maintenance-preflight/v1" as const;
const OBSERVATION_BINDING_FORMAT = "fanjin-release-maintenance-production-observation-binding/v1" as const;
const OBSERVATION_POLICY_FORMAT = "fanjin-release-maintenance-production-observation-policy/v1" as const;
const OBSERVATION_RECEIPT_FORMAT = "fanjin-release-maintenance-production-observation/v1" as const;
const MAX_CONTROL_PLANE_FILE_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;
const SHA256_RE = /^[a-f0-9]{64}$/u;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,255}$/u;
const SIGNATURE_RE = /^[A-Za-z0-9+/]+={0,2}$/u;

type JsonObject = Record<string, unknown>;
type FetchLike = typeof fetch;

export interface ReleaseMaintenanceProductionObservationPolicy {
  format: typeof OBSERVATION_POLICY_FORMAT;
  minimumRequestCount: number;
  maximumErrorRateBps: number;
  maximumP95LatencyMs: number;
  maximumDatabaseErrorCount: number;
  maximumUnexpectedWriterSessions: number;
  maximumQueueFailedDelta: number;
  maximumQueueOldestReadyAgeMs: number;
  maximumBillingAnomalyCount: number;
  maximumBillingReconciliationBacklog: number;
  policySha256: string;
}

export interface ReleaseMaintenanceProductionObservationBinding {
  format: typeof OBSERVATION_BINDING_FORMAT;
  operationId: string;
  planSha256: string;
  openedReceiptSha256: string;
  providerObservationReceiptSha256: string;
  providerRevision: string;
  artifactSha256: string;
  sourceCommit: string;
  imageDigest: string;
  schemaVersion: 48;
  homogeneousFleetEvidenceSha256: string;
  observedFrom: number;
  observedUntil: number;
  publicSmokeStart: Readonly<{ ok: true; artifactSha256: string }>;
  publicSmokeComplete: Readonly<{ ok: true; artifactSha256: string }>;
  productionBackends: readonly Readonly<{
    nodeId: string;
    health: "up";
    weight: 0;
  }>[];
  apiReadiness: readonly Readonly<{
    nodeId: string;
    ready: true;
    artifactSha256: string;
    sourceCommit: string;
    schemaVersion: 48;
    deploymentMode: ReleaseDeploymentMode;
    imageDigest: string;
  }>[];
  workerReadiness: readonly Readonly<{
    nodeId: string;
    healthy: true;
    acceptingWork: true;
    artifactSha256: string;
    observedDatabaseSchemaVersion: 48;
    schemaRuntimeMode: "normal";
  }>[];
}

export interface ReleaseMaintenanceProductionObservationMeasurements {
  requestCount: number;
  errorCount: number;
  errorRateBps: number;
  p95LatencyMs: number;
  databaseReachable: boolean;
  databaseErrorCount: number;
  unexpectedWriterSessions: number;
  queueFailedDelta: number;
  queueOldestReadyAgeMs: number;
  billingAnomalyCount: number;
  billingReconciliationBacklog: number;
  apiReadyNodeIds: readonly string[];
  workerReadyNodeIds: readonly string[];
}

export interface TrustedMaintenanceReceiptAttestation {
  format: typeof ENVELOPE_FORMAT;
  keyId: string;
  requestSha256: string;
  issuedAt: number;
  expiresAt: number;
  signatureBase64: string;
  envelopeSha256: string;
}

export interface ReleaseMaintenanceProductionObservationReceipt {
  format: typeof OBSERVATION_RECEIPT_FORMAT;
  provider: "volcengine-clb";
  observerId: string;
  binding: ReleaseMaintenanceProductionObservationBinding;
  policy: ReleaseMaintenanceProductionObservationPolicy;
  measurements: ReleaseMaintenanceProductionObservationMeasurements;
  verdict: "PASS";
  attestation: TrustedMaintenanceReceiptAttestation;
  receiptSha256: string;
}

export interface PersistedReleaseMaintenanceProductionObservationReceipt {
  filePath: string;
  contentSha256: string;
  receiptSha256: string;
  receipt: ReleaseMaintenanceProductionObservationReceipt;
}

export interface ReleaseMaintenanceProductionCanaryObserver {
  readonly observerId: string;
  readonly policy: ReleaseMaintenanceProductionObservationPolicy;
  observe(
    binding: Readonly<ReleaseMaintenanceProductionObservationBinding>,
  ): Promise<ReleaseMaintenanceProductionObservationReceipt>;
}

export interface TrustedVolcengineMaintenanceControlPlaneConfig {
  format: typeof CONTROL_PLANE_FORMAT;
  gateEndpoint: string;
  observerEndpoint: string;
  observerId: string;
  authorizationToken: string;
  receiptKeyId: string;
  receiptPublicKeyPem: string;
  requestTimeoutMs: number;
  maximumClockSkewMs: number;
  maximumReceiptTtlMs: number;
  observationReceiptDirectory: string;
  observationPolicy: ReleaseMaintenanceProductionObservationPolicy;
  configSha256: string;
}

export interface TrustedVolcengineMaintenanceRuntime {
  /** 统一 provider 解析后的适配器，已包装多域名强制探测门禁。 */
  loadBalancer: LoadBalancer;
  /** 实际选中的 provider（volcengine_clb / volcengine_alb）。 */
  loadBalancerProvider: LoadBalancerProvider;
  observer: ReleaseMaintenanceProductionCanaryObserver;
  persistObservationReceipt(
    receipt: ReleaseMaintenanceProductionObservationReceipt,
  ): PersistedReleaseMaintenanceProductionObservationReceipt;
  controlPlaneConfigSha256: string;
}

export class TrustedVolcengineMaintenanceControlPlaneError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "TrustedVolcengineMaintenanceControlPlaneError";
  }
}

function fail(code: string, message: string): never {
  throw new TrustedVolcengineMaintenanceControlPlaneError(code, message);
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: unknown, keys: readonly string[], label: string): JsonObject {
  if (!isObject(value)) fail("MAINTENANCE_CONTROL_PLANE_RESPONSE_INVALID", `${label} is invalid`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("MAINTENANCE_CONTROL_PLANE_RESPONSE_INVALID", `${label} fields are invalid`);
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as JsonObject;
  return `{${Object.keys(object).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(object[key])}`
  )).join(",")}}`;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactSha256(value: unknown, label: string): string {
  const normalized = String(value || "");
  if (!SHA256_RE.test(normalized)) fail("MAINTENANCE_CONTROL_PLANE_RESPONSE_INVALID", `${label} is invalid`);
  return normalized;
}

function exactId(value: unknown, label: string): string {
  const normalized = String(value || "").trim();
  if (!SAFE_ID_RE.test(normalized)) fail("MAINTENANCE_CONTROL_PLANE_CONFIG_INVALID", `${label} is invalid`);
  return normalized;
}

function exactInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < minimum || normalized > maximum) {
    fail("MAINTENANCE_CONTROL_PLANE_CONFIG_INVALID", `${label} is invalid`);
  }
  return normalized;
}

function exactUrl(value: unknown, label: string): string {
  let url: URL;
  try {
    url = new URL(String(value || ""));
  } catch {
    return fail("MAINTENANCE_CONTROL_PLANE_CONFIG_INVALID", `${label} is invalid`);
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.search
    || url.hash
    || !url.hostname
    || url.pathname === "/"
    || url.pathname.endsWith("/")
  ) {
    fail("MAINTENANCE_CONTROL_PLANE_CONFIG_INVALID", `${label} must be an exact HTTPS endpoint`);
  }
  return url.toString();
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function sortedUnique(values: readonly string[], label: string): string[] {
  const sorted = [...values].sort();
  if (!sorted.length || new Set(sorted).size !== sorted.length) {
    fail("MAINTENANCE_PRODUCTION_OBSERVATION_INVALID", `${label} must be unique and non-empty`);
  }
  return sorted;
}

function observationPolicy(value: unknown): ReleaseMaintenanceProductionObservationPolicy {
  const raw = exactKeys(value, [
    "format",
    "minimumRequestCount",
    "maximumErrorRateBps",
    "maximumP95LatencyMs",
    "maximumDatabaseErrorCount",
    "maximumUnexpectedWriterSessions",
    "maximumQueueFailedDelta",
    "maximumQueueOldestReadyAgeMs",
    "maximumBillingAnomalyCount",
    "maximumBillingReconciliationBacklog",
    "policySha256",
  ], "observation policy");
  const withoutDigest = {
    format: OBSERVATION_POLICY_FORMAT,
    minimumRequestCount: exactInteger(raw.minimumRequestCount, "minimumRequestCount", 1, 10_000_000),
    maximumErrorRateBps: exactInteger(raw.maximumErrorRateBps, "maximumErrorRateBps", 0, 10_000),
    maximumP95LatencyMs: exactInteger(raw.maximumP95LatencyMs, "maximumP95LatencyMs", 1, 600_000),
    maximumDatabaseErrorCount: exactInteger(raw.maximumDatabaseErrorCount, "maximumDatabaseErrorCount", 0, 1_000_000),
    maximumUnexpectedWriterSessions: exactInteger(raw.maximumUnexpectedWriterSessions, "maximumUnexpectedWriterSessions", 0, 100_000),
    maximumQueueFailedDelta: exactInteger(raw.maximumQueueFailedDelta, "maximumQueueFailedDelta", 0, 1_000_000),
    maximumQueueOldestReadyAgeMs: exactInteger(raw.maximumQueueOldestReadyAgeMs, "maximumQueueOldestReadyAgeMs", 0, 86_400_000),
    maximumBillingAnomalyCount: exactInteger(raw.maximumBillingAnomalyCount, "maximumBillingAnomalyCount", 0, 1_000_000),
    maximumBillingReconciliationBacklog: exactInteger(raw.maximumBillingReconciliationBacklog, "maximumBillingReconciliationBacklog", 0, 1_000_000),
  };
  const digest = sha256(canonicalJson(withoutDigest));
  if (raw.format !== OBSERVATION_POLICY_FORMAT || raw.policySha256 !== digest) {
    fail("MAINTENANCE_CONTROL_PLANE_CONFIG_INVALID", "observation policy digest is invalid");
  }
  return Object.freeze({ ...withoutDigest, policySha256: digest });
}

function trustedOwner(uid: number): boolean {
  const effectiveUid = typeof process.geteuid === "function" ? process.geteuid() : uid;
  return uid === effectiveUid || uid === 0;
}

function readProtectedControlPlaneFile(filePath: string): unknown {
  if (!path.isAbsolute(filePath) || path.resolve(filePath) !== filePath) {
    fail("MAINTENANCE_CONTROL_PLANE_FILE_UNSAFE", "control-plane file path must be canonical and absolute");
  }
  if (!Number.isSafeInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW === 0) {
    fail("MAINTENANCE_CONTROL_PLANE_FILE_UNSAFE", "safe control-plane file access is unsupported");
  }
  let before;
  try {
    before = lstatSync(filePath);
  } catch {
    return fail("MAINTENANCE_CONTROL_PLANE_FILE_UNSAFE", "control-plane file is unavailable");
  }
  if (
    before.isSymbolicLink()
    || !before.isFile()
    || before.nlink !== 1
    || (before.mode & 0o7777) !== 0o600
    || !trustedOwner(before.uid)
    || before.size < 1
    || before.size > MAX_CONTROL_PLANE_FILE_BYTES
  ) {
    fail(
      "MAINTENANCE_CONTROL_PLANE_FILE_UNSAFE",
      "control-plane file must be an owned 0600 single-link regular file",
    );
  }
  const descriptor = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile()
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.uid !== before.uid
      || opened.nlink !== 1
      || (opened.mode & 0o7777) !== 0o600
      || opened.size !== before.size
      || opened.mtimeMs !== before.mtimeMs
    ) {
      fail("MAINTENANCE_CONTROL_PLANE_FILE_UNSAFE", "control-plane file changed during secure open");
    }
    const bytes = readFileSync(descriptor);
    const after = lstatSync(filePath);
    if (
      after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.uid !== opened.uid
      || after.nlink !== 1
      || (after.mode & 0o7777) !== 0o600
      || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs
    ) {
      fail("MAINTENANCE_CONTROL_PLANE_FILE_UNSAFE", "control-plane file changed during read");
    }
    try {
      return JSON.parse(bytes.toString("utf8"));
    } catch {
      return fail("MAINTENANCE_CONTROL_PLANE_CONFIG_INVALID", "control-plane file is not valid JSON");
    }
  } finally {
    closeSync(descriptor);
  }
}

export function parseTrustedVolcengineMaintenanceControlPlaneConfig(
  value: unknown,
): TrustedVolcengineMaintenanceControlPlaneConfig {
  const raw = exactKeys(value, [
    "format",
    "gateEndpoint",
    "observerEndpoint",
    "observerId",
    "authorizationToken",
    "receiptKeyId",
    "receiptPublicKeyPem",
    "requestTimeoutMs",
    "maximumClockSkewMs",
    "maximumReceiptTtlMs",
    "observationReceiptDirectory",
    "observationPolicy",
    "configSha256",
  ], "control-plane config");
  const authorizationToken = String(raw.authorizationToken || "");
  const receiptPublicKeyPem = String(raw.receiptPublicKeyPem || "");
  const observationReceiptDirectory = String(raw.observationReceiptDirectory || "");
  if (
    raw.format !== CONTROL_PLANE_FORMAT
    || authorizationToken.length < 32
    || authorizationToken.length > 512
    || /[\u0000-\u0020\u007f]/u.test(authorizationToken)
    || receiptPublicKeyPem.length < 64
    || receiptPublicKeyPem.length > 16 * 1024
    || !path.isAbsolute(observationReceiptDirectory)
    || path.resolve(observationReceiptDirectory) !== observationReceiptDirectory
  ) {
    fail("MAINTENANCE_CONTROL_PLANE_CONFIG_INVALID", "control-plane identity or secret fields are invalid");
  }
  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey(receiptPublicKeyPem);
  } catch {
    return fail("MAINTENANCE_CONTROL_PLANE_CONFIG_INVALID", "receipt public key is invalid");
  }
  if (publicKey.asymmetricKeyType !== "ed25519") {
    fail("MAINTENANCE_CONTROL_PLANE_CONFIG_INVALID", "receipt public key must be Ed25519");
  }
  const policy = observationPolicy(raw.observationPolicy);
  const withoutDigest = {
    format: CONTROL_PLANE_FORMAT,
    gateEndpoint: exactUrl(raw.gateEndpoint, "gateEndpoint"),
    observerEndpoint: exactUrl(raw.observerEndpoint, "observerEndpoint"),
    observerId: exactId(raw.observerId, "observerId"),
    authorizationToken,
    receiptKeyId: exactId(raw.receiptKeyId, "receiptKeyId"),
    receiptPublicKeyPem,
    requestTimeoutMs: exactInteger(raw.requestTimeoutMs, "requestTimeoutMs", 1_000, 120_000),
    maximumClockSkewMs: exactInteger(raw.maximumClockSkewMs, "maximumClockSkewMs", 0, 300_000),
    maximumReceiptTtlMs: exactInteger(raw.maximumReceiptTtlMs, "maximumReceiptTtlMs", 1_000, 600_000),
    observationReceiptDirectory,
    observationPolicy: policy,
  };
  const digest = sha256(canonicalJson(withoutDigest));
  if (raw.configSha256 !== digest) {
    fail("MAINTENANCE_CONTROL_PLANE_CONFIG_INVALID", "control-plane config digest is invalid");
  }
  return Object.freeze({ ...withoutDigest, configSha256: digest });
}

function exactNonNegative(value: unknown, label: string): number {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    fail("MAINTENANCE_PRODUCTION_OBSERVATION_INVALID", `${label} is invalid`);
  }
  return normalized;
}

function observationMeasurements(value: unknown): ReleaseMaintenanceProductionObservationMeasurements {
  const raw = exactKeys(value, [
    "requestCount",
    "errorCount",
    "errorRateBps",
    "p95LatencyMs",
    "databaseReachable",
    "databaseErrorCount",
    "unexpectedWriterSessions",
    "queueFailedDelta",
    "queueOldestReadyAgeMs",
    "billingAnomalyCount",
    "billingReconciliationBacklog",
    "apiReadyNodeIds",
    "workerReadyNodeIds",
  ], "production observation measurements");
  if (
    typeof raw.databaseReachable !== "boolean"
    || !Array.isArray(raw.apiReadyNodeIds)
    || !Array.isArray(raw.workerReadyNodeIds)
    || raw.apiReadyNodeIds.some((entry) => typeof entry !== "string")
    || raw.workerReadyNodeIds.some((entry) => typeof entry !== "string")
  ) {
    fail("MAINTENANCE_PRODUCTION_OBSERVATION_INVALID", "production observation measurement shape is invalid");
  }
  return {
    requestCount: exactNonNegative(raw.requestCount, "requestCount"),
    errorCount: exactNonNegative(raw.errorCount, "errorCount"),
    errorRateBps: exactNonNegative(raw.errorRateBps, "errorRateBps"),
    p95LatencyMs: exactNonNegative(raw.p95LatencyMs, "p95LatencyMs"),
    databaseReachable: raw.databaseReachable,
    databaseErrorCount: exactNonNegative(raw.databaseErrorCount, "databaseErrorCount"),
    unexpectedWriterSessions: exactNonNegative(raw.unexpectedWriterSessions, "unexpectedWriterSessions"),
    queueFailedDelta: exactNonNegative(raw.queueFailedDelta, "queueFailedDelta"),
    queueOldestReadyAgeMs: exactNonNegative(raw.queueOldestReadyAgeMs, "queueOldestReadyAgeMs"),
    billingAnomalyCount: exactNonNegative(raw.billingAnomalyCount, "billingAnomalyCount"),
    billingReconciliationBacklog: exactNonNegative(raw.billingReconciliationBacklog, "billingReconciliationBacklog"),
    apiReadyNodeIds: sortedUnique(raw.apiReadyNodeIds as string[], "apiReadyNodeIds"),
    workerReadyNodeIds: sortedUnique(raw.workerReadyNodeIds as string[], "workerReadyNodeIds"),
  };
}

function observationAttestation(value: unknown): TrustedMaintenanceReceiptAttestation {
  const raw = exactKeys(value, [
    "format",
    "keyId",
    "requestSha256",
    "issuedAt",
    "expiresAt",
    "signatureBase64",
    "envelopeSha256",
  ], "production observation attestation");
  const signatureBase64 = String(raw.signatureBase64 || "");
  if (raw.format !== ENVELOPE_FORMAT || !SIGNATURE_RE.test(signatureBase64)) {
    fail("MAINTENANCE_PRODUCTION_OBSERVATION_INVALID", "production observation attestation is invalid");
  }
  return {
    format: ENVELOPE_FORMAT,
    keyId: exactId(raw.keyId, "attestation.keyId"),
    requestSha256: exactSha256(raw.requestSha256, "attestation.requestSha256"),
    issuedAt: exactNonNegative(raw.issuedAt, "attestation.issuedAt"),
    expiresAt: exactNonNegative(raw.expiresAt, "attestation.expiresAt"),
    signatureBase64,
    envelopeSha256: exactSha256(raw.envelopeSha256, "attestation.envelopeSha256"),
  };
}

export function assertReleaseMaintenanceProductionObservationBinding(
  binding: ReleaseMaintenanceProductionObservationBinding,
): ReleaseMaintenanceProductionObservationBinding {
  if (
    !isObject(binding)
    || binding.format !== OBSERVATION_BINDING_FORMAT
    || !SAFE_ID_RE.test(binding.operationId)
    || !SHA256_RE.test(binding.planSha256)
    || !SHA256_RE.test(binding.openedReceiptSha256)
    || !SHA256_RE.test(binding.providerObservationReceiptSha256)
    || !binding.providerRevision
    || binding.providerRevision.length > 256
    || /[\u0000-\u001f\u007f]/u.test(binding.providerRevision)
    || !SHA256_RE.test(binding.artifactSha256)
    || !/^[a-f0-9]{40}$/u.test(binding.sourceCommit)
    || !/^sha256:[a-f0-9]{64}$/u.test(binding.imageDigest)
    || binding.schemaVersion !== 48
    || !SHA256_RE.test(binding.homogeneousFleetEvidenceSha256)
    || !Number.isSafeInteger(binding.observedFrom)
    || !Number.isSafeInteger(binding.observedUntil)
    || binding.observedUntil <= binding.observedFrom
    || binding.publicSmokeStart?.ok !== true
    || binding.publicSmokeStart.artifactSha256 !== binding.artifactSha256
    || binding.publicSmokeComplete?.ok !== true
    || binding.publicSmokeComplete.artifactSha256 !== binding.artifactSha256
    || !Array.isArray(binding.productionBackends)
    || !Array.isArray(binding.apiReadiness)
    || !Array.isArray(binding.workerReadiness)
  ) {
    fail("MAINTENANCE_PRODUCTION_OBSERVATION_INVALID", "production observation binding is invalid");
  }
  const backendIds = sortedUnique(binding.productionBackends.map(({ nodeId }) => nodeId), "production backend ids");
  const apiIds = sortedUnique(binding.apiReadiness.map(({ nodeId }) => nodeId), "API readiness ids");
  const workerIds = sortedUnique(binding.workerReadiness.map(({ nodeId }) => nodeId), "Worker readiness ids");
  if (
    !sameJson(backendIds, apiIds)
    || binding.productionBackends.some(({ health, weight }) => health !== "up" || weight !== 0)
    || binding.apiReadiness.some((readiness) => (
      readiness.ready !== true
      || readiness.artifactSha256 !== binding.artifactSha256
      || readiness.sourceCommit !== binding.sourceCommit
      || readiness.schemaVersion !== 48
      || readiness.deploymentMode !== "container-image"
      || readiness.imageDigest !== binding.imageDigest
    ))
    || binding.workerReadiness.some((readiness) => (
      readiness.healthy !== true
      || readiness.acceptingWork !== true
      || readiness.artifactSha256 !== binding.artifactSha256
      || readiness.observedDatabaseSchemaVersion !== 48
      || readiness.schemaRuntimeMode !== "normal"
    ))
  ) {
    fail("MAINTENANCE_PRODUCTION_OBSERVATION_INVALID", "production observation fleet evidence is invalid");
  }
  if (!workerIds.length) {
    fail("MAINTENANCE_PRODUCTION_OBSERVATION_INVALID", "production observation has no Worker fleet");
  }
  return binding;
}

export function assertReleaseMaintenanceProductionObservationMeasurements(input: {
  measurements: ReleaseMaintenanceProductionObservationMeasurements;
  expectedBinding: Readonly<ReleaseMaintenanceProductionObservationBinding>;
  policy: Readonly<ReleaseMaintenanceProductionObservationPolicy>;
}): ReleaseMaintenanceProductionObservationMeasurements {
  assertReleaseMaintenanceProductionObservationBinding(input.expectedBinding);
  const policy = observationPolicy(input.policy);
  const measurements = observationMeasurements(input.measurements);
  const expectedApiIds = input.expectedBinding.apiReadiness.map(({ nodeId }) => nodeId).sort();
  const expectedWorkerIds = input.expectedBinding.workerReadiness.map(({ nodeId }) => nodeId).sort();
  const computedErrorRateBps = measurements.requestCount === 0
    ? 10_000
    : Math.ceil((measurements.errorCount * 10_000) / measurements.requestCount);
  if (
    !sameJson(input.measurements, measurements)
    || measurements.requestCount < policy.minimumRequestCount
    || measurements.errorCount > measurements.requestCount
    || measurements.errorRateBps !== computedErrorRateBps
    || measurements.errorRateBps > policy.maximumErrorRateBps
    || measurements.p95LatencyMs > policy.maximumP95LatencyMs
    || measurements.databaseReachable !== true
    || measurements.databaseErrorCount > policy.maximumDatabaseErrorCount
    || measurements.unexpectedWriterSessions > policy.maximumUnexpectedWriterSessions
    || measurements.queueFailedDelta > policy.maximumQueueFailedDelta
    || measurements.queueOldestReadyAgeMs > policy.maximumQueueOldestReadyAgeMs
    || measurements.billingAnomalyCount > policy.maximumBillingAnomalyCount
    || measurements.billingReconciliationBacklog > policy.maximumBillingReconciliationBacklog
    || !sameJson(measurements.apiReadyNodeIds, expectedApiIds)
    || !sameJson(measurements.workerReadyNodeIds, expectedWorkerIds)
  ) {
    fail("MAINTENANCE_PRODUCTION_OBSERVATION_REJECTED", "production measurements did not satisfy the fixed policy");
  }
  return measurements;
}

export function assertReleaseMaintenanceProductionObservationReceipt(input: {
  receipt: ReleaseMaintenanceProductionObservationReceipt;
  expectedBinding: Readonly<ReleaseMaintenanceProductionObservationBinding>;
  expectedPolicy: Readonly<ReleaseMaintenanceProductionObservationPolicy>;
  expectedObserverId: string;
}): ReleaseMaintenanceProductionObservationReceipt {
  const { receipt, expectedBinding, expectedPolicy, expectedObserverId } = input;
  exactKeys(receipt, [
    "format",
    "provider",
    "observerId",
    "binding",
    "policy",
    "measurements",
    "verdict",
    "attestation",
    "receiptSha256",
  ], "production observation receipt");
  assertReleaseMaintenanceProductionObservationBinding(receipt.binding);
  const policy = observationPolicy(receipt.policy);
  const measurements = assertReleaseMaintenanceProductionObservationMeasurements({
    measurements: receipt.measurements,
    expectedBinding,
    policy,
  });
  const attestation = observationAttestation(receipt.attestation);
  const { receiptSha256, ...withoutDigest } = receipt;
  const rebuiltDigest = sha256(canonicalJson(withoutDigest));
  const attestedEnvelopeSha256 = sha256(canonicalJson({
    format: ENVELOPE_FORMAT,
    requestSha256: attestation.requestSha256,
    issuedAt: attestation.issuedAt,
    expiresAt: attestation.expiresAt,
    keyId: attestation.keyId,
    payload: {
      format: receipt.format,
      provider: receipt.provider,
      observerId: receipt.observerId,
      binding: receipt.binding,
      policy: receipt.policy,
      measurements: receipt.measurements,
      verdict: receipt.verdict,
    },
  }));
  if (
    receipt.format !== OBSERVATION_RECEIPT_FORMAT
    || receipt.provider !== "volcengine-clb"
    || receipt.observerId !== expectedObserverId
    || receipt.verdict !== "PASS"
    || !sameJson(receipt.binding, expectedBinding)
    || !sameJson(policy, expectedPolicy)
    || !sameJson(receipt.policy, policy)
    || !sameJson(receipt.measurements, measurements)
    || attestation.expiresAt <= attestation.issuedAt
    || attestation.envelopeSha256 !== attestedEnvelopeSha256
    || receiptSha256 !== rebuiltDigest
  ) {
    fail("MAINTENANCE_PRODUCTION_OBSERVATION_REJECTED", "production observation did not satisfy the fixed policy");
  }
  return receipt;
}

interface SignedCallResult {
  payload: JsonObject;
  attestation: TrustedMaintenanceReceiptAttestation;
}

interface TrustedControlPlaneClientOptions {
  config: TrustedVolcengineMaintenanceControlPlaneConfig;
  fetch?: FetchLike;
  now?: () => number;
  signal?: AbortSignal;
}

function operationUrl(endpoint: string, operation: string): string {
  const url = new URL(endpoint);
  url.pathname = `${url.pathname}/${operation}`;
  return url.toString();
}

function gateObservation(value: unknown): VolcengineMaintenanceCanaryTrafficGateObservation {
  const raw = exactKeys(value, [
    "operationId",
    "artifactSha256",
    "planDigestSha256",
    "state",
    "trafficWeightPercent",
    "maintenanceTrafficWeightPercent",
    "autoContainAfterMs",
    "productionBackendsAllZero",
    "productionListenerId",
    "productionServerGroupId",
    "canaryListenerId",
    "trafficGateId",
    "maintenanceServerGroupId",
    "canaryServerGroupId",
    "apiNodeIds",
    "productionTargets",
    "canaryTargets",
    "providerRevision",
  ], "gate observation");
  if (
    (raw.operationId !== null && typeof raw.operationId !== "string")
    || (raw.artifactSha256 !== null && typeof raw.artifactSha256 !== "string")
    || (raw.planDigestSha256 !== null && typeof raw.planDigestSha256 !== "string")
    || (raw.state !== "open" && raw.state !== "contained")
    || !Number.isSafeInteger(raw.trafficWeightPercent)
    || !Number.isSafeInteger(raw.maintenanceTrafficWeightPercent)
    || !Number.isSafeInteger(raw.autoContainAfterMs)
    || typeof raw.productionBackendsAllZero !== "boolean"
    || !Array.isArray(raw.apiNodeIds)
    || !Array.isArray(raw.productionTargets)
    || !Array.isArray(raw.canaryTargets)
  ) {
    fail("MAINTENANCE_CONTROL_PLANE_RESPONSE_INVALID", "gate observation shape is invalid");
  }
  return raw as unknown as VolcengineMaintenanceCanaryTrafficGateObservation;
}

function topologyFromQuery(query: VolcengineMaintenanceCanaryTrafficGateQuery): JsonObject {
  return {
    productionListenerId: query.productionListenerId,
    productionServerGroupId: query.productionServerGroupId,
    canaryListenerId: query.canaryListenerId,
    trafficGateId: query.trafficGateId,
    maintenanceServerGroupId: query.maintenanceServerGroupId,
    canaryServerGroupId: query.canaryServerGroupId,
    apiNodeIds: [...query.apiNodeIds],
    productionTargets: query.productionTargets.map((target) => ({ ...target })),
    canaryTargets: query.canaryTargets.map((target) => ({ ...target })),
    productionBackendWeight: query.productionBackendWeight,
    maintenanceTrafficWeightPercent: query.maintenanceTrafficWeightPercent,
    trafficWeightPercent: query.trafficWeightPercent,
    autoContainAfterMs: query.autoContainAfterMs,
  };
}

export class TrustedVolcengineMaintenanceControlPlane
implements VolcengineMaintenanceCanaryTrafficGate, ReleaseMaintenanceProductionCanaryObserver {
  private readonly config: TrustedVolcengineMaintenanceControlPlaneConfig;
  private readonly fetchFn: FetchLike;
  private readonly now: () => number;
  private readonly signal?: AbortSignal;
  private readonly publicKey!: KeyObject;

  constructor(options: TrustedControlPlaneClientOptions) {
    this.config = options.config;
    this.fetchFn = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.signal = options.signal;
    try {
      this.publicKey = createPublicKey(this.config.receiptPublicKeyPem);
    } catch {
      return fail("MAINTENANCE_CONTROL_PLANE_CONFIG_INVALID", "receipt public key is invalid");
    }
    if (this.publicKey.asymmetricKeyType !== "ed25519") {
      fail("MAINTENANCE_CONTROL_PLANE_CONFIG_INVALID", "receipt public key must be Ed25519");
    }
  }

  get observerId(): string {
    return this.config.observerId;
  }

  get policy(): ReleaseMaintenanceProductionObservationPolicy {
    return this.config.observationPolicy;
  }

  private async signedCall(
    endpoint: string,
    operation: "preflight" | "inspect" | "open" | "contain" | "observe",
    payload: unknown,
  ): Promise<SignedCallResult> {
    if (this.signal?.aborted) {
      fail("MAINTENANCE_CONTROL_PLANE_ABORTED", "trusted maintenance control request was aborted");
    }
    const issuedAt = this.now();
    const requestWithoutDigest = {
      format: REQUEST_FORMAT,
      operation,
      requestId: randomUUID(),
      issuedAt,
      controlPlaneConfigSha256: this.config.configSha256,
      payload,
    };
    const requestSha256 = sha256(canonicalJson(requestWithoutDigest));
    const requestBody = JSON.stringify({ ...requestWithoutDigest, requestSha256 });
    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    this.signal?.addEventListener("abort", forwardAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    let response: Response;
    try {
      response = await this.fetchFn(operationUrl(endpoint, operation), {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer ${this.config.authorizationToken}`,
          "x-fanjin-request-sha256": requestSha256,
        },
        body: requestBody,
        signal: controller.signal,
      });
    } catch {
      return fail("MAINTENANCE_CONTROL_PLANE_UNAVAILABLE", "trusted maintenance control request failed");
    } finally {
      clearTimeout(timer);
      this.signal?.removeEventListener("abort", forwardAbort);
    }
    if (
      response.status !== 200
      || !String(response.headers.get("content-type") || "").toLowerCase().startsWith("application/json")
    ) {
      fail("MAINTENANCE_CONTROL_PLANE_REJECTED", "trusted maintenance control request was rejected");
    }
    const text = await response.text();
    if (!text || Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
      fail("MAINTENANCE_CONTROL_PLANE_RESPONSE_INVALID", "trusted maintenance control response is invalid");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return fail("MAINTENANCE_CONTROL_PLANE_RESPONSE_INVALID", "trusted maintenance control response is invalid JSON");
    }
    const envelope = exactKeys(parsed, [
      "format",
      "requestSha256",
      "issuedAt",
      "expiresAt",
      "keyId",
      "payload",
      "signatureBase64",
    ], "trusted maintenance envelope");
    const responseIssuedAt = Number(envelope.issuedAt);
    const expiresAt = Number(envelope.expiresAt);
    const signatureBase64 = String(envelope.signatureBase64 || "");
    const now = this.now();
    if (
      envelope.format !== ENVELOPE_FORMAT
      || envelope.requestSha256 !== requestSha256
      || envelope.keyId !== this.config.receiptKeyId
      || !Number.isSafeInteger(responseIssuedAt)
      || !Number.isSafeInteger(expiresAt)
      || responseIssuedAt < issuedAt - this.config.maximumClockSkewMs
      || responseIssuedAt > now + this.config.maximumClockSkewMs
      || expiresAt <= now
      || expiresAt <= responseIssuedAt
      || expiresAt - responseIssuedAt > this.config.maximumReceiptTtlMs
      || !isObject(envelope.payload)
      || !SIGNATURE_RE.test(signatureBase64)
    ) {
      fail("MAINTENANCE_CONTROL_PLANE_RESPONSE_INVALID", "trusted maintenance envelope identity is invalid");
    }
    const signed = {
      format: ENVELOPE_FORMAT,
      requestSha256,
      issuedAt: responseIssuedAt,
      expiresAt,
      keyId: this.config.receiptKeyId,
      payload: envelope.payload,
    };
    const signature = Buffer.from(signatureBase64, "base64");
    if (
      signature.length !== 64
      || !verify(null, Buffer.from(canonicalJson(signed)), this.publicKey, signature)
    ) {
      fail("MAINTENANCE_CONTROL_PLANE_SIGNATURE_INVALID", "trusted maintenance response signature is invalid");
    }
    return {
      payload: envelope.payload,
      attestation: {
        format: ENVELOPE_FORMAT,
        keyId: this.config.receiptKeyId,
        requestSha256,
        issuedAt: responseIssuedAt,
        expiresAt,
        signatureBase64,
        envelopeSha256: sha256(canonicalJson(signed)),
      },
    };
  }

  private async preflight(query: VolcengineMaintenanceCanaryTrafficGateQuery): Promise<void> {
    const expectedTopology = topologyFromQuery(query);
    const result = await this.signedCall(this.config.gateEndpoint, "preflight", {
      format: PREFLIGHT_FORMAT,
      provider: "volcengine-clb",
      observerId: this.config.observerId,
      operationId: query.operationId,
      artifactSha256: query.artifactSha256,
      topology: expectedTopology,
    });
    const preflight = exactKeys(result.payload, [
      "format",
      "provider",
      "observerId",
      "operationId",
      "artifactSha256",
      "controlPlaneConfigSha256",
      "topology",
      "capabilities",
    ], "maintenance gate preflight");
    const capabilities = exactKeys(preflight.capabilities, [
      "atomicOpenCompareAndSwap",
      "providerAutoContainment",
      "restartInspection",
      "signedDurableReceipts",
      "productionObservationV1",
    ], "maintenance gate capabilities");
    if (
      preflight.format !== PREFLIGHT_FORMAT
      || preflight.provider !== "volcengine-clb"
      || preflight.observerId !== this.config.observerId
      || preflight.operationId !== query.operationId
      || preflight.artifactSha256 !== query.artifactSha256
      || preflight.controlPlaneConfigSha256 !== this.config.configSha256
      || !sameJson(preflight.topology, expectedTopology)
      || capabilities.atomicOpenCompareAndSwap !== true
      || capabilities.providerAutoContainment !== true
      || capabilities.restartInspection !== true
      || capabilities.signedDurableReceipts !== true
      || capabilities.productionObservationV1 !== true
    ) {
      fail("MAINTENANCE_CONTROL_PLANE_PREFLIGHT_FAILED", "trusted maintenance gate capabilities or topology mismatch");
    }
  }

  async inspect(
    query: Readonly<VolcengineMaintenanceCanaryTrafficGateQuery>,
  ): Promise<VolcengineMaintenanceCanaryTrafficGateObservation> {
    await this.preflight(query);
    const result = await this.signedCall(this.config.gateEndpoint, "inspect", query);
    return gateObservation(result.payload);
  }

  async open(
    plan: Readonly<MaintenanceCanaryPlanReceipt>,
  ): Promise<VolcengineMaintenanceCanaryTrafficGateObservation> {
    const result = await this.signedCall(this.config.gateEndpoint, "open", plan);
    return gateObservation(result.payload);
  }

  async contain(
    query: Readonly<VolcengineMaintenanceCanaryTrafficGateQuery & { planDigestSha256: string }>,
  ): Promise<VolcengineMaintenanceCanaryTrafficGateObservation> {
    const result = await this.signedCall(this.config.gateEndpoint, "contain", query);
    return gateObservation(result.payload);
  }

  async observe(
    binding: Readonly<ReleaseMaintenanceProductionObservationBinding>,
  ): Promise<ReleaseMaintenanceProductionObservationReceipt> {
    assertReleaseMaintenanceProductionObservationBinding(binding);
    const result = await this.signedCall(this.config.observerEndpoint, "observe", {
      binding,
      policy: this.config.observationPolicy,
      observerId: this.config.observerId,
    });
    const payload = exactKeys(result.payload, [
      "format",
      "provider",
      "observerId",
      "binding",
      "policy",
      "measurements",
      "verdict",
    ], "production observation payload");
    const withoutDigest = {
      format: payload.format,
      provider: payload.provider,
      observerId: payload.observerId,
      binding: payload.binding,
      policy: payload.policy,
      measurements: payload.measurements,
      verdict: payload.verdict,
      attestation: result.attestation,
    } as Omit<ReleaseMaintenanceProductionObservationReceipt, "receiptSha256">;
    const receipt = {
      ...withoutDigest,
      receiptSha256: sha256(canonicalJson(withoutDigest)),
    } as ReleaseMaintenanceProductionObservationReceipt;
    return assertReleaseMaintenanceProductionObservationReceipt({
      receipt,
      expectedBinding: binding,
      expectedPolicy: this.config.observationPolicy,
      expectedObserverId: this.config.observerId,
    });
  }
}

function protectedReceiptDirectory(directory: string): string {
  if (!path.isAbsolute(directory) || path.resolve(directory) !== directory) {
    fail("MAINTENANCE_OBSERVATION_RECEIPT_DIRECTORY_UNSAFE", "observation receipt directory must be canonical and absolute");
  }
  try {
    mkdirSync(directory, { recursive: false, mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") {
      return fail("MAINTENANCE_OBSERVATION_RECEIPT_DIRECTORY_UNSAFE", "observation receipt directory cannot be created");
    }
  }
  const metadata = lstatSync(directory);
  if (
    metadata.isSymbolicLink()
    || !metadata.isDirectory()
    || (metadata.mode & 0o7777) !== 0o700
    || !trustedOwner(metadata.uid)
    || realpathSync(directory) !== directory
  ) {
    fail("MAINTENANCE_OBSERVATION_RECEIPT_DIRECTORY_UNSAFE", "observation receipt directory must be owned 0700");
  }
  return directory;
}

function readProtectedReceipt(filePath: string, maximumBytes: number): Buffer {
  if (!Number.isSafeInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW === 0) {
    fail("MAINTENANCE_OBSERVATION_RECEIPT_FILE_UNSAFE", "safe observation receipt access is unsupported");
  }
  const before = lstatSync(filePath);
  if (
    before.isSymbolicLink()
    || !before.isFile()
    || before.nlink !== 1
    || (before.mode & 0o7777) !== 0o600
    || !trustedOwner(before.uid)
    || before.size < 1
    || before.size > maximumBytes
  ) {
    fail("MAINTENANCE_OBSERVATION_RECEIPT_FILE_UNSAFE", "observation receipt file is unsafe");
  }
  const descriptor = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (
      opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.uid !== before.uid
      || opened.nlink !== 1
      || (opened.mode & 0o7777) !== 0o600
      || opened.size !== before.size
      || opened.mtimeMs !== before.mtimeMs
    ) {
      fail("MAINTENANCE_OBSERVATION_RECEIPT_FILE_UNSAFE", "observation receipt changed during open");
    }
    const bytes = readFileSync(descriptor);
    const after = lstatSync(filePath);
    if (
      after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.uid !== opened.uid
      || after.nlink !== 1
      || (after.mode & 0o7777) !== 0o600
      || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs
    ) {
      fail("MAINTENANCE_OBSERVATION_RECEIPT_FILE_UNSAFE", "observation receipt changed during read");
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

export function persistReleaseMaintenanceProductionObservationReceipt(input: {
  directory: string;
  receipt: ReleaseMaintenanceProductionObservationReceipt;
}): PersistedReleaseMaintenanceProductionObservationReceipt {
  const receipt = input.receipt;
  assertReleaseMaintenanceProductionObservationReceipt({
    receipt,
    expectedBinding: receipt.binding,
    expectedPolicy: receipt.policy,
    expectedObserverId: receipt.observerId,
  });
  const directory = protectedReceiptDirectory(input.directory);
  const bytes = Buffer.from(`${JSON.stringify(receipt)}\n`, "utf8");
  if (bytes.length > MAX_RESPONSE_BYTES) {
    fail("MAINTENANCE_OBSERVATION_RECEIPT_TOO_LARGE", "observation receipt exceeds the protected limit");
  }
  const filePath = path.join(directory, `${receipt.receiptSha256}.json`);
  try {
    const existing = readProtectedReceipt(filePath, MAX_RESPONSE_BYTES);
    if (!existing.equals(bytes)) {
      fail("MAINTENANCE_OBSERVATION_RECEIPT_ALREADY_EXISTS", "observation receipt identity already exists with other bytes");
    }
    return {
      filePath,
      contentSha256: sha256(existing),
      receiptSha256: receipt.receiptSha256,
      receipt,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
  const temporaryPath = path.join(
    directory,
    `.${receipt.receiptSha256}.${randomBytes(12).toString("hex")}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    fchmodSync(descriptor, 0o600);
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
      if (written < 1) fail("MAINTENANCE_OBSERVATION_RECEIPT_WRITE_FAILED", "observation receipt write made no progress");
      offset += written;
    }
    fsyncSync(descriptor);
    const temporary = fstatSync(descriptor);
    if (
      !temporary.isFile()
      || temporary.nlink !== 1
      || (temporary.mode & 0o7777) !== 0o600
      || !trustedOwner(temporary.uid)
      || temporary.size !== bytes.length
    ) {
      fail("MAINTENANCE_OBSERVATION_RECEIPT_WRITE_FAILED", "temporary observation receipt is unsafe");
    }
    closeSync(descriptor);
    descriptor = undefined;
    linkSync(temporaryPath, filePath);
    unlinkSync(temporaryPath);
    const directoryDescriptor = openSync(directory, constants.O_RDONLY | (constants.O_DIRECTORY || 0));
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
    const readback = readProtectedReceipt(filePath, MAX_RESPONSE_BYTES);
    if (!readback.equals(bytes)) {
      fail("MAINTENANCE_OBSERVATION_RECEIPT_WRITE_FAILED", "observation receipt readback differs");
    }
    return {
      filePath,
      contentSha256: sha256(readback),
      receiptSha256: receipt.receiptSha256,
      receipt,
    };
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(temporaryPath); } catch { /* best-effort private temp cleanup */ }
    throw error;
  }
}

export function loadTrustedVolcengineMaintenanceControlPlaneConfig(
  env: NodeJS.ProcessEnv = process.env,
): TrustedVolcengineMaintenanceControlPlaneConfig {
  const filePath = String(env[CONTROL_PLANE_FILE_ENV] || "").trim();
  if (!filePath) {
    fail("MAINTENANCE_CONTROL_PLANE_CONFIG_MISSING", `${CONTROL_PLANE_FILE_ENV} is required`);
  }
  return parseTrustedVolcengineMaintenanceControlPlaneConfig(
    readProtectedControlPlaneFile(filePath),
  );
}

export function createTrustedVolcengineMaintenanceRuntimeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  overrides: {
    /** CLB/ALB 共有选项。 */
    minHealthyBackends?: number;
    signal?: AbortSignal;
    /** CLB 专用选项。 */
    drainGraceMs?: number;
    /** ALB 专用 transport（测试注入）。 */
    albFetch?: VolcengineAlbAdapterOptions["fetch"];
    controlPlaneFetch?: FetchLike;
    controlPlaneNow?: () => number;
    /**
     * 数据库连接：用于解析 required 多域名 smoke 目标（active 租户的
     * active 域名）。未提供时仅使用环境变量目标（0.1.3 兼容）。
     */
    database?: Knex | null;
    /** 多域名探测注入（测试离线运行）。 */
    smokeTransports?: SmokeProbeTransports;
    allowedDnsTargets?: readonly string[];
    ssePath?: string;
    wsPath?: string;
  } = {},
): TrustedVolcengineMaintenanceRuntime {
  const {
    controlPlaneFetch,
    controlPlaneNow,
    database = null,
    smokeTransports,
    allowedDnsTargets,
    ssePath,
    wsPath,
    ...loadBalancerOverrides
  } = overrides;
  const config = loadTrustedVolcengineMaintenanceControlPlaneConfig(env);
  const controlPlane = new TrustedVolcengineMaintenanceControlPlane({
    config,
    fetch: controlPlaneFetch,
    now: controlPlaneNow,
    signal: loadBalancerOverrides.signal,
  });
  // R4：FANJIN_RELEASE_LB_PROVIDER 真正决定 CLB/ALB，
  // 并对最终选中的 provider 包装多域名强制探测门禁。
  const { provider, adapter } = createLoadBalancerFromEnv(env, {
    minHealthyBackends: loadBalancerOverrides.minHealthyBackends,
    drainGraceMs: loadBalancerOverrides.drainGraceMs,
    signal: loadBalancerOverrides.signal,
    albFetch: loadBalancerOverrides.albFetch,
    clbMaintenanceCanaryGate: controlPlane,
  });
  const allowedDnsTargetsFromEnv = String(
    env.FANJIN_RELEASE_PUBLIC_SMOKE_DNS_TARGETS || "",
  ).split(",").map((entry) => entry.trim()).filter(Boolean);
  const loadBalancer = new MultiDomainSmokeLoadBalancer(
    adapter,
    () => resolveRequiredSmokeTargets(database, env),
    {
      signal: loadBalancerOverrides.signal,
      transports: smokeTransports,
      allowedDnsTargets: allowedDnsTargets?.length ? allowedDnsTargets : allowedDnsTargetsFromEnv,
      ssePath: ssePath ?? (env.FANJIN_RELEASE_PUBLIC_SMOKE_SSE_PATH || undefined),
      wsPath: wsPath ?? (env.FANJIN_RELEASE_PUBLIC_SMOKE_WS_PATH || undefined),
    },
  );
  return Object.freeze({
    loadBalancer,
    loadBalancerProvider: provider,
    observer: controlPlane,
    persistObservationReceipt: (receipt: ReleaseMaintenanceProductionObservationReceipt) => (
      persistReleaseMaintenanceProductionObservationReceipt({
        directory: config.observationReceiptDirectory,
        receipt,
      })
    ),
    controlPlaneConfigSha256: config.configSha256,
  });
}

export const trustedVolcengineMaintenanceControlPlaneFormats = Object.freeze({
  controlPlane: CONTROL_PLANE_FORMAT,
  request: REQUEST_FORMAT,
  envelope: ENVELOPE_FORMAT,
  preflight: PREFLIGHT_FORMAT,
  observationBinding: OBSERVATION_BINDING_FORMAT,
  observationPolicy: OBSERVATION_POLICY_FORMAT,
  observationReceipt: OBSERVATION_RECEIPT_FORMAT,
});
