import crypto from "node:crypto";

import { getReleaseIdentity } from "@/lib/releaseIdentity";
import { processBootIdentity } from "@/lib/processBootIdentity";

export const RELAY_WORKER_EXECUTION_ATTESTATION_FORMAT =
  "fanjin-relay-worker-execution-attestation/v1" as const;

const SHA256 = /^[a-f0-9]{64}$/u;
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const SOURCE_COMMIT = /^[a-f0-9]{40}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,255}$/u;

type EnvironmentLike = Record<string, string | undefined>;

export type RelayWorkerExecutionAttestation = Readonly<{
  format: typeof RELAY_WORKER_EXECUTION_ATTESTATION_FORMAT;
  taskId: string;
  requestIdSha256: string;
  processRole: "worker";
  nodeId: string;
  incarnationId: string;
  processBootId: string;
  hostname: string;
  processId: number;
  releaseId: string;
  sourceCommit: string;
  artifactSha256: string;
  schemaVersion: number;
  imageDigest: string;
  leaseOwnerSha256: string;
  dispatchStartedAt: number;
  heartbeatStartedAt: number;
  heartbeatAt: number;
  heartbeatUpdatedAt: number;
  heartbeatProofSha256: string;
  attestationSha256: string;
}>;

export class RelayWorkerExecutionAttestationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "RelayWorkerExecutionAttestationError";
  }
}

function fail(message: string): never {
  throw new RelayWorkerExecutionAttestationError(
    "RELAY_WORKER_EXECUTION_ATTESTATION_INVALID",
    message,
  );
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) fail("worker execution attestation contains an unsupported value");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  )).join(",")}}`;
}

function digest(value: unknown): string {
  return crypto.createHash("sha256").update(
    typeof value === "string" ? value : canonicalJson(value),
    "utf8",
  ).digest("hex");
}

function exactKeys(value: unknown, expected: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("worker execution attestation must be an object");
  }
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    fail("worker execution attestation contains unexpected fields");
  }
}

function exactId(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) fail(`${label} is invalid`);
  return value;
}

function exactTimestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) fail(`${label} is invalid`);
  return Number(value);
}

export function createRelayWorkerExecutionAttestation(input: {
  taskId: string;
  requestId: string;
  leaseOwner: string;
  dispatchStartedAt: number;
  heartbeat: Record<string, unknown> | undefined;
  environment?: EnvironmentLike;
  hostname?: string;
  processId?: number;
}): RelayWorkerExecutionAttestation {
  const environment = input.environment ?? process.env;
  const processRole = String(
    environment.FANJIN_PROCESS_ROLE || environment.FANJIN_SERVICE_ROLE || "all",
  ).trim().toLowerCase();
  const processIdentity = processBootIdentity({
    ...(input.hostname === undefined ? {} : { hostname: input.hostname }),
    ...(input.processId === undefined ? {} : { processId: input.processId }),
  });
  const hostname = processIdentity.hostname;
  const processId = processIdentity.processId;
  const nodeId = String(
    environment.FANJIN_RELEASE_NODE_ID || environment.FANJIN_NODE_ID || "",
  ).trim();
  const release = getReleaseIdentity(environment);
  const imageDigest = String(environment.FANJIN_IMAGE_DIGEST || "").trim().toLowerCase();
  const dispatchStartedAt = exactTimestamp(input.dispatchStartedAt, "dispatchStartedAt");
  const heartbeat = input.heartbeat;
  const heartbeatStartedAt = Number(heartbeat?.startedAt);
  const heartbeatAt = Number(heartbeat?.heartbeatAt);
  const heartbeatUpdatedAt = Number(heartbeat?.updatedAt);
  const heartbeatCreatedAt = Number(heartbeat?.createdAt);
  const configuredMaximumAge = Number(environment.FANJIN_WORKER_HEARTBEAT_MAX_AGE_MS || 45_000);
  const configuredFutureSkew = Number(environment.FANJIN_WORKER_HEARTBEAT_FUTURE_SKEW_MS || 5_000);
  const maximumHeartbeatAgeMs = Number.isSafeInteger(configuredMaximumAge)
    ? configuredMaximumAge
    : 45_000;
  const maximumFutureSkewMs = Number.isSafeInteger(configuredFutureSkew)
    ? configuredFutureSkew
    : 5_000;
  if (
    processRole !== "worker"
    || !SAFE_ID.test(hostname)
    || !Number.isSafeInteger(processId)
    || processId < 1
    || !SAFE_ID.test(nodeId)
    || !release.releaseId
    || !SAFE_ID.test(release.releaseId)
    || !release.sourceCommit
    || !SOURCE_COMMIT.test(release.sourceCommit)
    || !release.artifactSha256
    || !SHA256.test(release.artifactSha256)
    || !Number.isSafeInteger(release.schemaVersion)
    || Number(release.schemaVersion) < 1
    || !IMAGE_DIGEST.test(imageDigest)
    || typeof input.requestId !== "string"
    || input.requestId.length < 1
    || input.requestId.length > 1_024
    || !heartbeat
    || heartbeat.id !== processIdentity.incarnationId
    || heartbeat.incarnationId !== processIdentity.incarnationId
    || heartbeat.role !== "background"
    || heartbeat.hostname !== hostname
    || Number(heartbeat.processId) !== processId
    || heartbeat.nodeId !== nodeId
    || heartbeat.releaseId !== release.releaseId
    || heartbeat.artifactSha256 !== release.artifactSha256
    || Number(heartbeat.schemaVersion) !== Number(release.schemaVersion)
    || Number(heartbeat.acceptingWork) !== 1
    || !Number.isSafeInteger(heartbeatStartedAt)
    || !Number.isSafeInteger(heartbeatAt)
    || !Number.isSafeInteger(heartbeatUpdatedAt)
    || !Number.isSafeInteger(heartbeatCreatedAt)
    || maximumHeartbeatAgeMs < 1_000
    || maximumHeartbeatAgeMs > 300_000
    || maximumFutureSkewMs < 0
    || maximumFutureSkewMs > 60_000
    || heartbeatCreatedAt > heartbeatStartedAt
    || heartbeatStartedAt > dispatchStartedAt
    || heartbeatAt < dispatchStartedAt - maximumHeartbeatAgeMs
    || heartbeatAt > dispatchStartedAt + maximumFutureSkewMs
    || heartbeatUpdatedAt < heartbeatAt
  ) fail("worker process cannot prove its exact release identity");
  const heartbeatProof = {
    id: heartbeat.id,
    role: heartbeat.role,
    hostname: heartbeat.hostname,
    processId: Number(heartbeat.processId),
    nodeId: heartbeat.nodeId,
    incarnationId: heartbeat.incarnationId,
    releaseId: heartbeat.releaseId,
    artifactSha256: heartbeat.artifactSha256,
    schemaVersion: Number(heartbeat.schemaVersion),
    acceptingWork: Number(heartbeat.acceptingWork),
    startedAt: heartbeatStartedAt,
    heartbeatAt,
    createdAt: heartbeatCreatedAt,
    updatedAt: heartbeatUpdatedAt,
  };
  const commitment = {
    format: RELAY_WORKER_EXECUTION_ATTESTATION_FORMAT,
    taskId: exactId(input.taskId, "taskId"),
    requestIdSha256: digest(input.requestId),
    processRole: "worker" as const,
    nodeId,
    incarnationId: processIdentity.incarnationId,
    processBootId: processIdentity.processBootId,
    hostname,
    processId,
    releaseId: release.releaseId,
    sourceCommit: release.sourceCommit,
    artifactSha256: release.artifactSha256,
    schemaVersion: Number(release.schemaVersion),
    imageDigest,
    leaseOwnerSha256: digest(exactId(input.leaseOwner, "leaseOwner")),
    dispatchStartedAt,
    heartbeatStartedAt,
    heartbeatAt,
    heartbeatUpdatedAt,
    heartbeatProofSha256: digest(heartbeatProof),
  };
  return assertRelayWorkerExecutionAttestation({
    ...commitment,
    attestationSha256: digest(commitment),
  });
}

export function assertRelayWorkerExecutionAttestation(
  value: unknown,
): RelayWorkerExecutionAttestation {
  exactKeys(value, [
    "artifactSha256",
    "attestationSha256",
    "dispatchStartedAt",
    "format",
    "heartbeatAt",
    "heartbeatProofSha256",
    "heartbeatStartedAt",
    "heartbeatUpdatedAt",
    "hostname",
    "imageDigest",
    "incarnationId",
    "leaseOwnerSha256",
    "nodeId",
    "processBootId",
    "processId",
    "processRole",
    "releaseId",
    "requestIdSha256",
    "schemaVersion",
    "sourceCommit",
    "taskId",
  ]);
  const attestation = value as unknown as RelayWorkerExecutionAttestation;
  const processId = exactTimestamp(attestation.processId, "processId");
  const hostname = exactId(attestation.hostname, "hostname");
  if (
    attestation.format !== RELAY_WORKER_EXECUTION_ATTESTATION_FORMAT
    || attestation.processRole !== "worker"
    || !/^[a-f0-9-]{36}$/u.test(attestation.processBootId)
    || exactId(attestation.incarnationId, "incarnationId")
      !== `background:${hostname}:${processId}:${attestation.processBootId}`
    || !SHA256.test(attestation.artifactSha256)
    || !SOURCE_COMMIT.test(attestation.sourceCommit)
    || !IMAGE_DIGEST.test(attestation.imageDigest)
    || !Number.isSafeInteger(attestation.schemaVersion)
    || attestation.schemaVersion < 1
  ) fail("worker execution attestation identity is invalid");
  exactId(attestation.taskId, "taskId");
  if (!SHA256.test(attestation.requestIdSha256)) fail("requestIdSha256 is invalid");
  exactId(attestation.nodeId, "nodeId");
  exactId(attestation.releaseId, "releaseId");
  const dispatchStartedAt = exactTimestamp(attestation.dispatchStartedAt, "dispatchStartedAt");
  const heartbeatStartedAt = exactTimestamp(attestation.heartbeatStartedAt, "heartbeatStartedAt");
  const heartbeatAt = exactTimestamp(attestation.heartbeatAt, "heartbeatAt");
  const heartbeatUpdatedAt = exactTimestamp(attestation.heartbeatUpdatedAt, "heartbeatUpdatedAt");
  if (
    heartbeatStartedAt > dispatchStartedAt
    || heartbeatUpdatedAt < heartbeatAt
    || !SHA256.test(attestation.heartbeatProofSha256)
    || !SHA256.test(attestation.leaseOwnerSha256)
  ) fail("worker heartbeat or lease digest is invalid");
  const { attestationSha256, ...commitment } = attestation;
  if (!SHA256.test(attestationSha256) || attestationSha256 !== digest(commitment)) {
    fail("worker execution attestation digest is invalid");
  }
  return Object.freeze(attestation);
}
