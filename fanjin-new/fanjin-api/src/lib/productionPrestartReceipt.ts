import { createHmac, timingSafeEqual } from "node:crypto";
import {
  isProductionPlatformVersion,
  isProductionReleaseId,
} from "@/lib/productionReleaseIdentity";

const SHA256 = /^[a-f0-9]{64}$/u;
const SOURCE_COMMIT = /^[a-f0-9]{40}$/u;
const RECEIPT_SCHEMA = "fanjin-production-prestart-receipt/v1";

type ProductionRuntimeRole = "api" | "worker";

export interface ProductionPrestartReadinessReceipt {
  schema: typeof RECEIPT_SCHEMA;
  platformVersion: string;
  releaseId: string;
  sourceCommit: string;
  schemaVersion: number;
  role: ProductionRuntimeRole;
  artifactSha256: string;
  phase: "database-prepared" | "ready";
  observedArtifacts: Partial<Record<ProductionRuntimeRole, string>>;
  readinessScore: number | null;
  releaseReady: boolean;
  p0Blockers: number | null;
  receiptDigest: string;
  claimMac: string;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

function claimPayload(
  receipt: ProductionPrestartReadinessReceipt,
): Omit<ProductionPrestartReadinessReceipt, "claimMac"> {
  const { claimMac: _claimMac, ...payload } = receipt;
  return payload;
}

export function productionPrestartClaimMac(
  receipt: Omit<ProductionPrestartReadinessReceipt, "claimMac">,
  key: string,
): string {
  return createHmac("sha256", key).update(canonical(receipt)).digest("hex");
}

function validMac(receipt: ProductionPrestartReadinessReceipt, key: string): boolean {
  if (Buffer.byteLength(key, "utf8") < 32 || !SHA256.test(receipt.claimMac)) return false;
  const expected = Buffer.from(productionPrestartClaimMac(claimPayload(receipt), key), "hex");
  const actual = Buffer.from(receipt.claimMac, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function runtimeRole(environment: NodeJS.ProcessEnv): ProductionRuntimeRole | null {
  const role = String(environment.FANJIN_PROCESS_ROLE || "").trim();
  return role === "api" || role === "worker" ? role : null;
}

/**
 * Parse and authenticate the short-lived role claim emitted by the parent
 * prestart process. The claim is tied to the exact compiled version, release
 * identity, schema, role and role-specific artifact digest. A receipt copied
 * from another role or release artifact is therefore rejected.
 */
export function productionPrestartReadinessReceipt(
  environment: NodeJS.ProcessEnv = process.env,
  platformVersion = typeof __APP_VERSION__ === "undefined" ? "" : __APP_VERSION__,
): ProductionPrestartReadinessReceipt | null {
  const encoded = String(environment.FANJIN_PRODUCTION_PRESTART_RECEIPT || "").trim();
  if (!encoded || encoded.length > 16_384 || !/^[A-Za-z0-9_-]+$/u.test(encoded)) return null;
  let value: unknown;
  try { value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); }
  catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const receipt = value as ProductionPrestartReadinessReceipt;
  const role = runtimeRole(environment);
  const artifacts = receipt.observedArtifacts;
  const releaseId = String(environment.FANJIN_RELEASE_ID || "").trim();
  const sourceCommit = String(environment.FANJIN_SOURCE_COMMIT || "").trim();
  const artifactSha256 = String(environment.FANJIN_ARTIFACT_SHA256 || "").trim();
  const schemaVersion = Number(environment.FANJIN_RELEASE_SCHEMA_VERSION);
  const settingsKey = String(environment.FANJIN_SETTINGS_ENCRYPTION_KEY || "");
  const readinessValid = receipt.role === "api"
    ? receipt.phase === "ready"
      && receipt.releaseReady === true
      && receipt.readinessScore === 100
      && receipt.p0Blockers === 0
    : (receipt.phase === "database-prepared"
      && receipt.releaseReady === false
      && receipt.readinessScore === null
      && receipt.p0Blockers === null)
      || (receipt.phase === "ready"
        && receipt.releaseReady === true
        && receipt.readinessScore === 100
        && receipt.p0Blockers === 0);

  if (
    receipt.schema !== RECEIPT_SCHEMA
    || !role
    || receipt.role !== role
    || !isProductionPlatformVersion(platformVersion)
    || receipt.platformVersion !== platformVersion
    || !isProductionReleaseId(releaseId)
    || receipt.releaseId !== releaseId
    || !SOURCE_COMMIT.test(sourceCommit)
    || receipt.sourceCommit !== sourceCommit
    || !Number.isSafeInteger(schemaVersion)
    || schemaVersion < 1
    || receipt.schemaVersion !== schemaVersion
    || !SHA256.test(artifactSha256)
    || receipt.artifactSha256 !== artifactSha256
    || !SHA256.test(receipt.receiptDigest)
    || !artifacts
    || typeof artifacts !== "object"
    || Array.isArray(artifacts)
    || Object.keys(artifacts).some((key) => key !== "api" && key !== "worker")
    || !SHA256.test(String(artifacts[role] || ""))
    || artifacts[role] !== artifactSha256
    || (artifacts.api !== undefined && !SHA256.test(String(artifacts.api)))
    || (artifacts.worker !== undefined && !SHA256.test(String(artifacts.worker)))
    || !readinessValid
    || !validMac(receipt, settingsKey)
  ) return null;

  return Object.freeze({
    ...receipt,
    observedArtifacts: Object.freeze({ ...artifacts }),
  });
}

/** Fail before binding HTTP or registering a Worker heartbeat/claim. */
export function assertProductionPrestartRuntimeClaim(
  environment: NodeJS.ProcessEnv = process.env,
  platformVersion = typeof __APP_VERSION__ === "undefined" ? "" : __APP_VERSION__,
): ProductionPrestartReadinessReceipt | null {
  if (environment.FANJIN_REQUIRE_PRODUCTION_PRESTART_RECEIPT !== "1") return null;
  const receipt = productionPrestartReadinessReceipt(environment, platformVersion);
  if (!receipt) {
    throw Object.assign(
      new Error("production runtime prestart role claim is missing or invalid"),
      { code: "PRODUCTION_PRESTART_ROLE_CLAIM_INVALID" },
    );
  }
  return receipt;
}

declare const __APP_VERSION__: string | undefined;
