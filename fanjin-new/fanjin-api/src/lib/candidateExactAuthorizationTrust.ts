import crypto from "node:crypto";

import {
  candidateExactAuthorizationCanonicalJson,
} from "./candidateExactAuthorizationCanonical";
import {
  RELEASE_ARTIFACT_TRUSTED_PUBLIC_KEYS_ENV,
  parseReleaseArtifactTrustedPublicKeys,
} from "./releaseArtifactAttestation";

export const CANDIDATE_EXACT_AUTHORIZATION_FORMAL_LAUNCHER_TRUST_STORE_ENV =
  "FANJIN_CANDIDATE_FORMAL_LAUNCHER_TRUST_STORE_JSON" as const;
export const CANDIDATE_EXACT_AUTHORIZATION_BASE_LAUNCHER_TRUST_STORE_ENV =
  "FANJIN_CANDIDATE_BASE_LAUNCHER_TRUST_STORE_JSON" as const;
export const FORMAL_CANDIDATE_EXACT_AUTHORIZATION_TRUST_BUNDLE_FORMAT =
  "fanjin-formal-candidate-exact-authorization-trust/v1" as const;

const TRUST_BUNDLE_BINDING_DOMAIN =
  "fanjin-formal-candidate-exact-authorization-trust/v1/binding";
const SHA256_BINDING = /^sha256:[a-f0-9]{64}$/u;
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export type CandidateExactAuthorizationLauncherTrustedKey = Readonly<{
  keyId: string;
  algorithm: "Ed25519";
  publicKeySpkiBase64Url: string;
  publicKeyFingerprintSha256: string;
}>;

export type CandidateExactAuthorizationFormalLauncherTrustStore = Readonly<{
  format: "fanjin-candidate-independent-launcher-formal-trust-store/v2";
  issuerClass: "root-owned-independent-node-agent";
  keys: readonly CandidateExactAuthorizationLauncherTrustedKey[];
}>;

export type CandidateExactAuthorizationBaseLauncherTrustStore = Readonly<{
  format: "fanjin-candidate-independent-launcher-trust-store/v1";
  issuerClass: "independent-launcher-node-agent";
  keys: readonly CandidateExactAuthorizationLauncherTrustedKey[];
}>;

export class CandidateExactAuthorizationTrustError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "CandidateExactAuthorizationTrustError";
    this.code = code;
  }
}

export type FormalCandidateExactAuthorizationTrustBundle = Readonly<{
  format: typeof FORMAL_CANDIDATE_EXACT_AUTHORIZATION_TRUST_BUNDLE_FORMAT;
  releaseArtifactTrustedPublicKeys: Readonly<Record<string, string>>;
  formalLauncherTrustStore: CandidateExactAuthorizationFormalLauncherTrustStore;
  baseLauncherTrustStore: CandidateExactAuthorizationBaseLauncherTrustStore;
  binding: string;
}>;

export type CandidateExactAuthorizationTrustEnvironment = Readonly<
  Record<string, string>
>;

function fail(code: string): never {
  throw new CandidateExactAuthorizationTrustError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function parseTrustedKey(
  value: unknown,
): CandidateExactAuthorizationLauncherTrustedKey {
  if (!isRecord(value) || !exactKeys(value, [
    "algorithm",
    "keyId",
    "publicKeyFingerprintSha256",
    "publicKeySpkiBase64Url",
  ])
    || value.algorithm !== "Ed25519"
    || typeof value.keyId !== "string"
    || !KEY_ID.test(value.keyId)
    || value.keyId.startsWith("dev-local-only-")
    || typeof value.publicKeySpkiBase64Url !== "string"
    || typeof value.publicKeyFingerprintSha256 !== "string"
    || !SHA256_HEX.test(value.publicKeyFingerprintSha256)) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_TRUST_KEY_INVALID");
  }
  try {
    const der = Buffer.from(value.publicKeySpkiBase64Url, "base64url");
    if (
      der.byteLength !== 44
      || der.toString("base64url") !== value.publicKeySpkiBase64Url
    ) return fail("CANDIDATE_EXACT_AUTHORIZATION_TRUST_KEY_INVALID");
    const key = crypto.createPublicKey({ key: der, format: "der", type: "spki" });
    const normalized = Buffer.from(key.export({ format: "der", type: "spki" }));
    const fingerprint = crypto.createHash("sha256").update(normalized).digest("hex");
    if (
      key.asymmetricKeyType !== "ed25519"
      || normalized.byteLength !== der.byteLength
      || !crypto.timingSafeEqual(normalized, der)
      || fingerprint !== value.publicKeyFingerprintSha256
    ) return fail("CANDIDATE_EXACT_AUTHORIZATION_TRUST_KEY_INVALID");
    return Object.freeze({
      keyId: value.keyId,
      algorithm: "Ed25519",
      publicKeySpkiBase64Url: normalized.toString("base64url"),
      publicKeyFingerprintSha256: fingerprint,
    });
  } catch (error) {
    if (error instanceof CandidateExactAuthorizationTrustError) throw error;
    return fail("CANDIDATE_EXACT_AUTHORIZATION_TRUST_KEY_INVALID");
  }
}

function parseLauncherTrustStore(
  value: unknown,
  profile: "formal" | "base",
): CandidateExactAuthorizationFormalLauncherTrustStore
  | CandidateExactAuthorizationBaseLauncherTrustStore {
  if (!isRecord(value) || !exactKeys(value, ["format", "issuerClass", "keys"])
    || !Array.isArray(value.keys)
    || value.keys.length !== 1) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_LAUNCHER_TRUST_STORE_INVALID");
  }
  const expectedFormat = profile === "formal"
    ? "fanjin-candidate-independent-launcher-formal-trust-store/v2"
    : "fanjin-candidate-independent-launcher-trust-store/v1";
  const expectedIssuer = profile === "formal"
    ? "root-owned-independent-node-agent"
    : "independent-launcher-node-agent";
  if (value.format !== expectedFormat || value.issuerClass !== expectedIssuer) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_LAUNCHER_TRUST_STORE_INVALID");
  }
  const keys = Object.freeze(value.keys.map(parseTrustedKey));
  return Object.freeze({
    format: expectedFormat,
    issuerClass: expectedIssuer,
    keys,
  }) as CandidateExactAuthorizationFormalLauncherTrustStore
    | CandidateExactAuthorizationBaseLauncherTrustStore;
}

function trustBundleBinding(value: Omit<
  FormalCandidateExactAuthorizationTrustBundle,
  "binding"
>): string {
  return `sha256:${crypto.createHash("sha256").update([
    TRUST_BUNDLE_BINDING_DOMAIN,
    candidateExactAuthorizationCanonicalJson(value),
  ].join("\0"), "utf8").digest("hex")}`;
}

export function parseFormalCandidateExactAuthorizationTrustBundle(
  value: unknown,
  expectedReleaseAttestationKeyId: string,
): FormalCandidateExactAuthorizationTrustBundle {
  if (!isRecord(value) || !exactKeys(value, [
    "baseLauncherTrustStore",
    "binding",
    "formalLauncherTrustStore",
    "format",
    "releaseArtifactTrustedPublicKeys",
  ])
    || value.format !== FORMAL_CANDIDATE_EXACT_AUTHORIZATION_TRUST_BUNDLE_FORMAT
    || typeof value.binding !== "string"
    || !SHA256_BINDING.test(value.binding)) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_TRUST_BUNDLE_INVALID");
  }
  try {
    const releaseArtifactTrustedPublicKeys =
      parseReleaseArtifactTrustedPublicKeys(
        value.releaseArtifactTrustedPublicKeys,
      );
    const releaseKeyIds = Object.keys(releaseArtifactTrustedPublicKeys);
    const formalLauncherTrustStore =
      parseLauncherTrustStore(value.formalLauncherTrustStore, "formal") as
        CandidateExactAuthorizationFormalLauncherTrustStore;
    const baseLauncherTrustStore =
      parseLauncherTrustStore(value.baseLauncherTrustStore, "base") as
        CandidateExactAuthorizationBaseLauncherTrustStore;
    if (
      releaseKeyIds.length !== 1
      || releaseKeyIds[0] !== expectedReleaseAttestationKeyId
      || formalLauncherTrustStore.keys.length !== 1
      || baseLauncherTrustStore.keys.length !== 1
    ) return fail("CANDIDATE_EXACT_AUTHORIZATION_TRUST_BUNDLE_SCOPE_INVALID");
    const body = Object.freeze({
      format: FORMAL_CANDIDATE_EXACT_AUTHORIZATION_TRUST_BUNDLE_FORMAT,
      releaseArtifactTrustedPublicKeys,
      formalLauncherTrustStore,
      baseLauncherTrustStore,
    });
    if (value.binding !== trustBundleBinding(body)) {
      return fail("CANDIDATE_EXACT_AUTHORIZATION_TRUST_BUNDLE_BINDING_INVALID");
    }
    return Object.freeze({ ...body, binding: value.binding });
  } catch (error) {
    if (error instanceof CandidateExactAuthorizationTrustError) throw error;
    return fail("CANDIDATE_EXACT_AUTHORIZATION_TRUST_BUNDLE_INVALID");
  }
}

export function compileFormalCandidateExactAuthorizationTrustBundle(
  input: Readonly<{
    releaseArtifactTrustedPublicKeys: unknown;
    formalLauncherTrustStore: unknown;
    baseLauncherTrustStore: unknown;
    expectedReleaseAttestationKeyId: string;
  }>,
): FormalCandidateExactAuthorizationTrustBundle {
  const body = {
    format: FORMAL_CANDIDATE_EXACT_AUTHORIZATION_TRUST_BUNDLE_FORMAT,
    releaseArtifactTrustedPublicKeys:
      parseReleaseArtifactTrustedPublicKeys(
        input.releaseArtifactTrustedPublicKeys,
      ),
    formalLauncherTrustStore:
      parseLauncherTrustStore(input.formalLauncherTrustStore, "formal") as
        CandidateExactAuthorizationFormalLauncherTrustStore,
    baseLauncherTrustStore:
      parseLauncherTrustStore(input.baseLauncherTrustStore, "base") as
        CandidateExactAuthorizationBaseLauncherTrustStore,
  } as const;
  return parseFormalCandidateExactAuthorizationTrustBundle({
    ...body,
    binding: trustBundleBinding(body),
  }, input.expectedReleaseAttestationKeyId);
}

export function candidateExactAuthorizationTrustEnvironment(
  bundle: FormalCandidateExactAuthorizationTrustBundle,
): CandidateExactAuthorizationTrustEnvironment {
  const parsed = parseFormalCandidateExactAuthorizationTrustBundle(
    bundle,
    Object.keys(bundle.releaseArtifactTrustedPublicKeys)[0] || "",
  );
  return Object.freeze({
    [RELEASE_ARTIFACT_TRUSTED_PUBLIC_KEYS_ENV]:
      candidateExactAuthorizationCanonicalJson(
        parsed.releaseArtifactTrustedPublicKeys,
      ),
    [CANDIDATE_EXACT_AUTHORIZATION_FORMAL_LAUNCHER_TRUST_STORE_ENV]:
      candidateExactAuthorizationCanonicalJson(
        parsed.formalLauncherTrustStore,
      ),
    [CANDIDATE_EXACT_AUTHORIZATION_BASE_LAUNCHER_TRUST_STORE_ENV]:
      candidateExactAuthorizationCanonicalJson(
        parsed.baseLauncherTrustStore,
      ),
  });
}
