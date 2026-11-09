import type { ReleaseSchemaCompatibility } from "./types";
import {
  releaseSchemaCompatibilityProofSha256,
  schemaCompatibilitySupports,
} from "./schemaCompatibility";

const PREFIX = "fanjin-worker-schema-bridge.v1.";
const OPERATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{5,127}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const MAX_FENCE_BYTES = 768;

export interface WorkerSchemaBridgeFence {
  contractVersion: "fanjin-worker-schema-bridge.v1";
  operationId: string;
  artifactSha256: string;
  artifactSchemaVersion: number;
  fromVersion: number;
  toVersion: number;
  compatibilityProofSha256: string;
}

function validVersion(value: unknown): value is number {
  return Number.isSafeInteger(value)
    && Number(value) >= 1
    && Number(value) <= 2_147_483_647;
}

function invalidFence(): null {
  return null;
}

/**
 * The fence is deliberately stored in the existing durable Worker control
 * operationId. This keeps the handshake deployable on the source schema:
 * no target DDL is needed before the target binary can prove bridge safety.
 */
export function encodeWorkerSchemaBridgeFence(
  input: Omit<WorkerSchemaBridgeFence, "contractVersion">,
): string {
  if (
    !OPERATION_ID_RE.test(input.operationId)
    || !SHA256_RE.test(input.artifactSha256)
    || !validVersion(input.artifactSchemaVersion)
    || !validVersion(input.fromVersion)
    || !validVersion(input.toVersion)
    || input.fromVersion >= input.toVersion
    || !SHA256_RE.test(input.compatibilityProofSha256)
  ) {
    throw new TypeError("Worker schema bridge fence is invalid");
  }
  const payload = JSON.stringify([
    input.operationId,
    input.artifactSha256,
    input.artifactSchemaVersion,
    input.fromVersion,
    input.toVersion,
    input.compatibilityProofSha256,
  ]);
  const fence = `${PREFIX}${Buffer.from(payload, "utf8").toString("base64url")}`;
  if (Buffer.byteLength(fence, "utf8") > MAX_FENCE_BYTES) {
    throw new TypeError("Worker schema bridge fence is too large");
  }
  return fence;
}

export function decodeWorkerSchemaBridgeFence(value: unknown): WorkerSchemaBridgeFence | null {
  if (
    typeof value !== "string"
    || !value.startsWith(PREFIX)
    || Buffer.byteLength(value, "utf8") > MAX_FENCE_BYTES
  ) {
    return invalidFence();
  }
  try {
    const encoded = value.slice(PREFIX.length);
    if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) return invalidFence();
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    const parsed = JSON.parse(decoded) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 6) return invalidFence();
    const [
      operationId,
      artifactSha256,
      artifactSchemaVersion,
      fromVersion,
      toVersion,
      compatibilityProofSha256,
    ] = parsed;
    if (
      typeof operationId !== "string"
      || !OPERATION_ID_RE.test(operationId)
      || typeof artifactSha256 !== "string"
      || !SHA256_RE.test(artifactSha256)
      || !validVersion(artifactSchemaVersion)
      || !validVersion(fromVersion)
      || !validVersion(toVersion)
      || fromVersion >= toVersion
      || typeof compatibilityProofSha256 !== "string"
      || !SHA256_RE.test(compatibilityProofSha256)
    ) {
      return invalidFence();
    }
    const canonical = encodeWorkerSchemaBridgeFence({
      operationId,
      artifactSha256,
      artifactSchemaVersion,
      fromVersion,
      toVersion,
      compatibilityProofSha256,
    });
    if (canonical !== value) return invalidFence();
    return {
      contractVersion: "fanjin-worker-schema-bridge.v1",
      operationId,
      artifactSha256,
      artifactSchemaVersion,
      fromVersion,
      toVersion,
      compatibilityProofSha256,
    };
  } catch {
    return invalidFence();
  }
}

export function workerSchemaBridgeFenceMatches(input: {
  fence: WorkerSchemaBridgeFence;
  operationId: string;
  artifactSha256: string;
  artifactSchemaVersion: number;
  observedDatabaseSchemaVersion: number;
  compatibility: ReleaseSchemaCompatibility;
}): boolean {
  const { fence, compatibility } = input;
  return fence.operationId === input.operationId
    && fence.artifactSha256 === input.artifactSha256
    && fence.artifactSchemaVersion === input.artifactSchemaVersion
    && (
      input.observedDatabaseSchemaVersion === fence.fromVersion
      || input.observedDatabaseSchemaVersion === fence.toVersion
    )
    && schemaCompatibilitySupports(compatibility, fence.fromVersion)
    && schemaCompatibilitySupports(compatibility, fence.toVersion)
    && fence.compatibilityProofSha256
      === releaseSchemaCompatibilityProofSha256(compatibility);
}
