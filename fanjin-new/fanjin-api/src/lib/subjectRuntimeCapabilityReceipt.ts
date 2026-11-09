import { createHash, createPublicKey } from "node:crypto";
import { canonicalJson, sha256 } from "./releaseProtocol/canonicalJson";
import { verifySubjectRuntimeConfig, verifySubjectStorageCapabilityReceipt, type SubjectEd25519TrustKey } from "./releaseProtocol/subjectRuntimeConfig";
import { verifySubjectCentralPreparationReceipt, type SubjectCentralPreparationSchemaCompatibility } from "./releaseProtocol/subjectCentralPreparationReceipt";
import { productionPrestartReadinessReceipt } from "./productionPrestartReceipt";
import type { ObjectStorageConfiguration } from "./objectStorageConfig";
import type { ObjectStorageCapabilityAttestationInspection } from "./objectStorageCapabilityAttestation";
import { readStartupJson, startupFailure } from "../../scripts/lib/production-startup-files";
import { verifyProductionStartupEnvironment } from "../../scripts/lib/production-startup-environment";

const ROOT = "/opt/fanjin/release";
const TRUST = "/opt/fanjin/trust";
const SUBJECT_IDENTITY_NAMES = ["FANJIN_RUNTIME_CONFIG_SHA256", "FANJIN_RUNTIME_CONFIG_REVISION", "FANJIN_RELEASE_TARGET_ID", "FANJIN_RELEASE_ENVIRONMENT"];
export function usesSubjectRuntimeCapabilityReceipt(environment: NodeJS.ProcessEnv): boolean {
  // A partial identity is an invalid new runtime, not permission to use legacy evidence.
  return SUBJECT_IDENTITY_NAMES.some((name) => environment[name] !== undefined);
}
function fail(code: string): never { return startupFailure(code, "runtime-storage-capability", "Signed runtime storage capability verification failed"); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("SUBJECT_RUNTIME_CAPABILITY_RECEIPT_INVALID");
  return value as Record<string, unknown>;
}
function assert(condition: unknown, code = "CONFIG_RECEIPT_MISMATCH"): asserts condition { if (!condition) fail(code); }
function keys(raw: unknown): SubjectEd25519TrustKey[] {
  assert(Array.isArray(raw) && raw.length > 0 && raw.length <= 16, "RUNTIME_TRUST_INVALID");
  const result = raw.map((entry) => {
    const key = record(entry);
    assert(Object.keys(key).sort().join(",") === "keyId,publicKeyPem"
      && typeof key.keyId === "string" && typeof key.publicKeyPem === "string" && key.publicKeyPem.length < 4096, "RUNTIME_TRUST_INVALID");
    const parsed = createPublicKey(key.publicKeyPem);
    assert(parsed.asymmetricKeyType === "ed25519"
      && `sha256:${createHash("sha256").update(parsed.export({ type: "spki", format: "der" })).digest("hex")}` === key.keyId, "RUNTIME_TRUST_INVALID");
    return { keyId: key.keyId, publicKeyPem: key.publicKeyPem };
  });
  assert(new Set(result.map((key) => key.keyId)).size === result.length, "RUNTIME_TRUST_INVALID");
  return result;
}

/** Pure local receipt verification: no provider calls, PG connection, writes or new proofs. */
export function inspectSubjectRuntimeCapabilityReceipt(input: {
  environment: NodeJS.ProcessEnv;
  configuration: ObjectStorageConfiguration;
  now: number;
}, dependencies: { readJson?: (file: string) => unknown } = {}): ObjectStorageCapabilityAttestationInspection {
  const failure = (errorCode: string): ObjectStorageCapabilityAttestationInspection => ({
    ready: false, reason: "subject_receipt_invalid", authority: "subject-signed-config", errorCode,
    observedAt: null, ageMs: null, maximumAgeMs: null, storageIdentityMatches: false, releaseShaMatches: false,
  });
  try {
    const { environment, configuration, now } = input;
    const role = environment.FANJIN_PROCESS_ROLE;
    const sourceCommit = environment.FANJIN_SOURCE_COMMIT;
    const roleArtifact = environment.FANJIN_ARTIFACT_SHA256;
    const schemaVersion = Number(environment.FANJIN_RELEASE_SCHEMA_VERSION);
    const targetId = environment.FANJIN_RELEASE_TARGET_ID;
    const releaseEnvironment = environment.FANJIN_RELEASE_ENVIRONMENT;
    assert(role === "api" || role === "worker", "RUNTIME_TARGET_INVALID");
    assert(typeof sourceCommit === "string" && /^[a-f0-9]{40}$/u.test(sourceCommit)
      && typeof roleArtifact === "string" && /^[a-f0-9]{64}$/u.test(roleArtifact), "RUNTIME_IDENTITY_MISMATCH");
    assert(typeof targetId === "string" && targetId.length > 0 && (releaseEnvironment === "test" || releaseEnvironment === "production"), "RUNTIME_TARGET_INVALID");
    assert(Number.isSafeInteger(now) && now >= 0, "RUNTIME_CAPABILITY_CLOCK_INVALID");
    const readJson = dependencies.readJson ?? ((file: string) => readStartupJson(file, file.startsWith(`${TRUST}/`) ? TRUST : ROOT));
    const trust = record(readJson(`${TRUST}/release-authorities.json`));
    assert(trust.schema === "fanjin-subject-release-authorities/v1" && Object.keys(trust).sort().join(",") === "capabilityKeys,configKeys,schema", "RUNTIME_TRUST_INVALID");
    const configKeys = keys(trust.configKeys), capabilityKeys = keys(trust.capabilityKeys);
    assert(!configKeys.some((key) => capabilityKeys.some((other) => key.keyId === other.keyId)), "RUNTIME_TRUST_AUTHORITY_OVERLAP");
    const config = verifySubjectRuntimeConfig(readJson(`${ROOT}/runtime-config.json`), configKeys);
    assert(environment.FANJIN_RUNTIME_CONFIG_SHA256 === config.configSha
      && environment.FANJIN_RUNTIME_CONFIG_REVISION === String(config.revision));
    const manifest = record(readJson(`${ROOT}/release-manifest.json`));
    assert(typeof manifest.subjectCandidateDigest === "string" && /^sha256:[a-f0-9]{64}$/u.test(manifest.subjectCandidateDigest));
    assert(manifest.identityKind === "subject-candidate" && manifest.artifactSha256 === manifest.subjectCandidateDigest.slice(7)
      && manifest.unitArtifactSha256 === roleArtifact && manifest.sourceCommit === sourceCommit
      && manifest.schemaVersion === schemaVersion && manifest.releaseId === environment.FANJIN_RELEASE_ID, "RUNTIME_IDENTITY_MISMATCH");
    const rawCapabilities = readJson(`${ROOT}/storage-capabilities.json`);
    assert(Array.isArray(rawCapabilities) && rawCapabilities.length === 2);
    const capabilities = rawCapabilities.map((receipt) => verifySubjectStorageCapabilityReceipt(receipt, config, capabilityKeys, configKeys))
      .sort((a, b) => a.role.localeCompare(b.role));
    assert(capabilities[0].role === "api" && capabilities[1].role === "worker");
    const rawPreparation = record(readJson(`${ROOT}/central-preparation.json`));
    const version = typeof __APP_VERSION__ === "undefined" ? String(rawPreparation.platformVersion ?? "") : __APP_VERSION__;
    const originalDbIdentity = record(readJson(`${ROOT}/database-identity.json`));
    // The startup schema probe already verifies the live database. Bind this
    // local check to the same environment-specific, centrally signed identity.
    const databaseIdentityShapeMatches = releaseEnvironment === "production"
      ? originalDbIdentity.schema === "fanjin-postgres-runtime-database-identity/v1"
        && originalDbIdentity.environment === "production"
        && Object.keys(originalDbIdentity).sort().join(",") === "connection,environment,migrationSchema,observation,schema,targetId"
      : originalDbIdentity.schema === "fanjin-empty-test-database-identity/v1"
        && Object.keys(originalDbIdentity).sort().join(",") === "clusterMarker,database,host,port,schema,targetId,user";
    assert(databaseIdentityShapeMatches && originalDbIdentity.targetId === targetId, "RUNTIME_DATABASE_IDENTITY_MISMATCH");
    const preparation = verifySubjectCentralPreparationReceipt(rawPreparation, capabilityKeys, {
      environment: releaseEnvironment, targetId, configSha: config.configSha, configRevision: config.revision,
      candidateDigest: manifest.subjectCandidateDigest, sourceCommit, platformVersion: version,
      roleArtifactClaims: (["api", "worker"] as const).map((entry) => ({ role: entry, artifactSha256: config.roleClaims.find((claim) => claim.role === entry)!.artifactSha256 })),
      schemaCompatibility: rawPreparation.schemaCompatibility as SubjectCentralPreparationSchemaCompatibility,
      databaseIdentityDigest: `sha256:${sha256(originalDbIdentity)}`,
      capabilityReceiptDigests: capabilities.map((receipt) => ({ role: receipt.role as "api" | "worker", receiptSha: receipt.receiptSha })),
    });
    const nativeClaim = productionPrestartReadinessReceipt(environment, version);
    assert(nativeClaim && canonicalJson(nativeClaim) === canonicalJson(preparation.nativePrestartClaims.find((claim) => claim.role === role)), "PRODUCTION_PRESTART_ROLE_CLAIM_INVALID");
    const originalEnvironment = { ...environment };
    delete originalEnvironment.FANJIN_PRODUCTION_PRESTART_RECEIPT;
    verifyProductionStartupEnvironment(originalEnvironment, config, {
      role, releaseId: environment.FANJIN_RELEASE_ID!, sourceCommit, artifactSha256: roleArtifact, schemaVersion,
      configSha: config.configSha, configRevision: config.revision, targetId, environment: releaseEnvironment,
    });
    // The pure signing contract calls the transport tos-s3. The application
    // supports tos and s3 aliases, but all six concrete storage fields must
    // equal the capability actually tested, not merely another signed object.
    assert(["tos", "s3"].includes(configuration.provider)
      && canonicalJson({ provider: "tos-s3", bucket: configuration.bucket, region: configuration.region,
        endpoint: configuration.endpoint, keyPrefix: `${configuration.keyPrefix}/`, forcePathStyle: configuration.forcePathStyle }) === canonicalJson(config.storage),
    "SUBJECT_RUNTIME_STORAGE_IDENTITY_MISMATCH");
    const capability = capabilities.find((receipt) => receipt.role === role)!;
    assert(capability.artifactSha256 === `sha256:${roleArtifact}`);
    const ageMs = now - Date.parse(capability.issuedAt);
    assert(ageMs >= -60_000 && now - Date.parse(preparation.issuedAt) >= -60_000, "RUNTIME_CAPABILITY_FROM_FUTURE");
    return {
      ready: true, reason: "ready", authority: "subject-signed-config",
      observedAt: capability.issuedAt, ageMs, maximumAgeMs: null,
      storageIdentityMatches: true, releaseShaMatches: true,
      configSha: config.configSha, configRevision: config.revision,
      capabilityReceiptSha: capability.receiptSha, centralPreparationReceiptSha: preparation.receiptSha,
    };
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return failure(typeof code === "string" && /^[A-Z][A-Z0-9_]{0,100}$/u.test(code) ? code : "SUBJECT_RUNTIME_CAPABILITY_RECEIPT_INVALID");
  }
}

declare const __APP_VERSION__: string | undefined;
