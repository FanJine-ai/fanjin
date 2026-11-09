import type {
  CandidateRuntimeArtifactExecutionBinding,
  CandidateRuntimeAttestationDescriptor,
} from "./candidateRuntimeAttestation";
import {
  candidateExactAuthorizationCanonicalJson,
  candidateExactAuthorizationDigest,
  parseFormalCandidatePrelaunchSessionIdentity,
  type CandidateExactAuthorizationSessionIdentity,
} from "./candidateExactAuthorizationCanonical";

export const FORMAL_CANDIDATE_RUNTIME_ARTIFACT_PROOF_FORMAT =
  "fanjin-candidate-formal-runtime-artifact-proof/v2" as const;
export const FORMAL_CANDIDATE_RUNTIME_ARTIFACT_EVIDENCE_CLASS =
  "formal-runtime-artifact-bound" as const;

const SHA256_HEX = /^[a-f0-9]{64}$/u;
const SHA256_BINDING = /^sha256:[a-f0-9]{64}$/u;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export type FormalCandidateRuntimeArtifactIdentity = Readonly<{
  format: typeof FORMAL_CANDIDATE_RUNTIME_ARTIFACT_PROOF_FORMAT;
  evidenceClass: typeof FORMAL_CANDIDATE_RUNTIME_ARTIFACT_EVIDENCE_CLASS;
  releaseUuid: string;
  artifactUuid: string;
  artifactSha256: string;
  artifactSignedManifestSha256: string;
  sourceDigest: string;
  configExpectedSha256: string;
  schemaExpectedSha256: string;
  releaseAttestationKeyId: string;
  releaseManifestPayloadSha256: string;
  runtimeArtifact: Readonly<{
    manifestPath: string;
    sha256: string;
    byteSize: number;
  }>;
  runtimeAuthorityBinding: string;
  runtimeDescriptorDigest: string;
}>;

export class FormalCandidateRuntimeIdentityError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "FormalCandidateRuntimeIdentityError";
  }
}

function fail(code: string): never {
  throw new FormalCandidateRuntimeIdentityError(code);
}

/**
 * The single canonical construction used by both the root capture process and
 * the signed runtime.  Keeping this projection in `src/` prevents the FD6
 * consumer from inventing a second candidate-binding algorithm.
 */
export function buildFormalCandidateRuntimeArtifactIdentity(input: Readonly<{
  candidateIdentity: CandidateExactAuthorizationSessionIdentity;
  releaseAttestationKeyId: string;
  releaseManifestPayloadSha256: string;
  runtimeArtifact: CandidateRuntimeArtifactExecutionBinding;
  runtimeDescriptor: CandidateRuntimeAttestationDescriptor;
}>): FormalCandidateRuntimeArtifactIdentity {
  const candidate = parseFormalCandidatePrelaunchSessionIdentity(
    input.candidateIdentity,
  );
  const artifact = input.runtimeArtifact;
  const descriptorArtifact = input.runtimeDescriptor.artifactExecutionBinding;
  if (
    !KEY_ID.test(input.releaseAttestationKeyId)
    || input.releaseAttestationKeyId.startsWith("dev-local-only-")
    || input.releaseAttestationKeyId !== candidate.attestationKeyId
    || !SHA256_BINDING.test(input.releaseManifestPayloadSha256)
    || !artifact
    || artifact.artifactSignedManifestSha256
      !== candidate.artifactSignedManifestSha256
    || !SHA256_HEX.test(artifact.sha256)
    || !Number.isSafeInteger(artifact.byteSize)
    || artifact.byteSize < 1
    || descriptorArtifact === null
    || candidateExactAuthorizationCanonicalJson(descriptorArtifact)
      !== candidateExactAuthorizationCanonicalJson(artifact)
    || !SHA256_BINDING.test(input.runtimeDescriptor.authorityBinding)
  ) {
    return fail("FORMAL_CANDIDATE_RUNTIME_IDENTITY_BINDING_INVALID");
  }
  return Object.freeze({
    format: FORMAL_CANDIDATE_RUNTIME_ARTIFACT_PROOF_FORMAT,
    evidenceClass: FORMAL_CANDIDATE_RUNTIME_ARTIFACT_EVIDENCE_CLASS,
    releaseUuid: candidate.releaseUuid,
    artifactUuid: candidate.artifactUuid,
    artifactSha256: candidate.artifactSha256,
    artifactSignedManifestSha256: candidate.artifactSignedManifestSha256,
    sourceDigest: candidate.sourceDigest,
    configExpectedSha256: candidate.configExpectedSha256,
    schemaExpectedSha256: candidate.schemaExpectedSha256,
    releaseAttestationKeyId: input.releaseAttestationKeyId,
    releaseManifestPayloadSha256: input.releaseManifestPayloadSha256,
    runtimeArtifact: Object.freeze({
      manifestPath: artifact.manifestPath,
      sha256: artifact.sha256,
      byteSize: artifact.byteSize,
    }),
    runtimeAuthorityBinding: input.runtimeDescriptor.authorityBinding,
    runtimeDescriptorDigest: candidateExactAuthorizationDigest(
      input.runtimeDescriptor,
    ),
  });
}

export function formalCandidateRuntimeArtifactIdentityDigest(
  input: Parameters<typeof buildFormalCandidateRuntimeArtifactIdentity>[0],
): string {
  return candidateExactAuthorizationDigest(
    buildFormalCandidateRuntimeArtifactIdentity(input),
  );
}
