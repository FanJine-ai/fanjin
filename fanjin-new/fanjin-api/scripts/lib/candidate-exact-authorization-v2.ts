import { guStringFromMicros } from "../../src/lib/billingUnits";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  ReleaseArtifactAttestationError,
  verifyReleaseArtifactAttestation,
  type ReleaseArtifactAttestationV1,
} from "../../src/lib/releaseArtifactAttestation";
import {
  CANDIDATE_EXACT_AUTHORIZATION_BASE_LAUNCHER_TRUST_STORE_ENV,
  CANDIDATE_EXACT_AUTHORIZATION_FORMAL_LAUNCHER_TRUST_STORE_ENV,
} from "../../src/lib/candidateExactAuthorizationTrust";
export {
  CANDIDATE_EXACT_AUTHORIZATION_BASE_LAUNCHER_TRUST_STORE_ENV,
  CANDIDATE_EXACT_AUTHORIZATION_FORMAL_LAUNCHER_TRUST_STORE_ENV,
} from "../../src/lib/candidateExactAuthorizationTrust";
import { parseReleaseArtifactManifest } from "../../src/lib/releaseArtifactManifest";
import {
  assertCandidateRuntimeAttestationDescriptor,
  assertCandidateRuntimeChallengeResponse,
  probeCandidateRuntimeAuthority,
  type CandidateRuntimeAttestationDescriptor,
  type CandidateRuntimeChallengeResponse,
} from "../../src/lib/candidateRuntimeAttestation";
import {
  CANDIDATE_EXACT_AUTHORIZATION_ANCHOR_VERSION,
  CANDIDATE_EXACT_AUTHORIZATION_REQUIRED_KEYS,
  candidateExactAuthorizationCanonicalJson,
  compileCandidateExactAuthorizationPackage,
  parseCandidateExactAuthorizationReceipt,
  sealCandidateExactAuthorizationAnchor,
  type CandidateExactAuthorizationKey,
  type CandidateExactAuthorizationPackage,
  type CandidateExactAuthorizationReceipt,
} from "./candidate-exact-authorization-package";
import {
  parseReleaseCandidateSessionCorrelationIdentity,
  type ReleaseCandidateSessionIdentity,
} from "./release-candidate-session-identity";
import {
  verifyCandidateIndependentLauncherFormalAttestation,
  type CandidateIndependentLauncherFormalEnvelope,
  type CandidateIndependentLauncherFormalExpectation,
  type CandidateIndependentLauncherFormalTrustStore,
  type CandidateIndependentLauncherFormalVerifiedAttestation,
} from "./candidate-independent-launcher-formal-issuer";
import type {
  CandidateIndependentLauncherTrustStore,
} from "./candidate-independent-launcher-attestation";

export const CANDIDATE_EXACT_AUTHORIZATION_FORMAL_PROOF_FORMAT =
  "fanjin-candidate-formal-runtime-artifact-proof/v2" as const;
export const CANDIDATE_EXACT_AUTHORIZATION_SIGNED_RECEIPT_FORMAT =
  "fanjin-candidate-trusted-live-quote-receipt/v2" as const;
export const CANDIDATE_EXACT_AUTHORIZATION_ACTIVATION_PACKAGE_FORMAT =
  "fanjin-candidate-exact-authorization-activation-package/v2" as const;
export const CANDIDATE_EXACT_AUTHORIZATION_GUARD_FORMAT =
  "fanjin-candidate-exact-authorization-paid-guard/v2" as const;
export const CANDIDATE_EXACT_AUTHORIZATION_GUARD_MAX_BYTES = 64 * 1024;
export const CANDIDATE_EXACT_AUTHORIZATION_PACKAGE_FILE_FLAG =
  "--authorization-package-file" as const;
export const CANDIDATE_EXACT_AUTHORIZATION_PACKAGE_DIGEST_FLAG =
  "--authorization-package-digest" as const;
export const CANDIDATE_EXACT_AUTHORIZATION_PACKAGE_IDENTITY_FLAG =
  "--authorization-package-identity" as const;
export const CANDIDATE_EXACT_AUTHORIZATION_PACKAGE_FD_ENV =
  "FANJIN_CANDIDATE_EXACT_AUTHORIZATION_PACKAGE_FD" as const;
export const CANDIDATE_EXACT_AUTHORIZATION_SIGNED_DRIVER_ENV =
  "FANJIN_FORMAL_CANDIDATE_SIGNED_DRIVER" as const;
export const CANDIDATE_EXACT_AUTHORIZATION_INDEPENDENT_LAUNCHER_ATTESTATION_IMPLEMENTED:
  boolean = false;

const FORMAL_EVIDENCE_CLASS = "formal-runtime-artifact-bound" as const;
const SESSION_BINDING_DOMAIN =
  "fanjin-candidate-exact-authorization/session/v2";
const WORKSPACE_BINDING_DOMAIN =
  "fanjin-candidate-exact-authorization/workspace/v2";
const CORRELATION_IDENTITY_DOMAIN =
  "fanjin-candidate-exact-authorization/correlation-identity/v2";
const FILE_PATH_BINDING_DOMAIN =
  "fanjin-candidate-exact-authorization/package-path/v2";
const RUNTIME_PACKAGE_IDENTITY_DOMAIN =
  "fanjin-candidate-exact-authorization/runtime-package-identity/v1";
const WALLET_BINDING_DOMAIN =
  "fanjin-candidate-exact-authorization/wallet/v2";
const AVAILABLE_SCOPE_DOMAIN =
  "fanjin-candidate-exact-authorization/available-scope/v2";
const GUARD_FILE_BINDING_DOMAIN =
  "fanjin-candidate-exact-authorization/guard-file/v2";
const LIVE_READBACK_CHALLENGE_DOMAIN =
  "fanjin-candidate-exact-authorization/live-readback-challenge/v3";
const MAX_AUTHORIZATION_LIFETIME_MS = 5 * 60 * 1_000;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const SHA256_BINDING = /^sha256:[a-f0-9]{64}$/;
const SHA256_BASE64URL = /^[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SOURCE_DIGEST_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_MANIFEST_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._/@+-]+(?:\/[A-Za-z0-9._/@+-]+)*$/;
const MAX_PACKAGE_BYTES = 8 * 1024 * 1024;
const MAX_LIVE_READBACK_BYTES = 1024 * 1024;
const CANDIDATE_EXACT_AUTHORIZATION_LIVE_READBACK_ENDPOINTS = Object.freeze({
  "quick/720p": "internal/candidate-exact-authorization/quotes/quick-720p",
  "quick/1080p": "internal/candidate-exact-authorization/quotes/quick-1080p",
  "canvas/720p": "internal/candidate-exact-authorization/quotes/canvas-720p",
  "canvas/1080p": "internal/candidate-exact-authorization/quotes/canvas-1080p",
  "agent/720p": "internal/candidate-exact-authorization/quotes/agent-720p",
  "agent/1080p": "internal/candidate-exact-authorization/quotes/agent-1080p",
  "full-matrix/mixed":
    "internal/candidate-exact-authorization/preflights/full-matrix-mixed",
} satisfies Record<CandidateExactAuthorizationKey, string>);

export class CandidateExactAuthorizationV2Error extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "CandidateExactAuthorizationV2Error";
    this.code = code;
  }
}

export type CandidateFormalRuntimeArtifactIdentity = Readonly<{
  format: typeof CANDIDATE_EXACT_AUTHORIZATION_FORMAL_PROOF_FORMAT;
  evidenceClass: typeof FORMAL_EVIDENCE_CLASS;
  releaseUuid: string;
  artifactUuid: string;
  artifactSha256: string;
  /** Exact signed release-manifest.json file-bytes SHA-256. */
  artifactSignedManifestSha256: string;
  sourceDigest: string;
  configExpectedSha256: string;
  schemaExpectedSha256: string;
  releaseAttestationKeyId: string;
  /** Unsigned canonical attestation-payload digest, kept as a separate identity. */
  releaseManifestPayloadSha256: string;
  runtimeArtifact: Readonly<{
    manifestPath: string;
    sha256: string;
    byteSize: number;
  }>;
  runtimeAuthorityBinding: string;
  runtimeDescriptorDigest: string;
}>;

export type CandidateFormalRuntimeArtifactProof = Readonly<{
  format: typeof CANDIDATE_EXACT_AUTHORIZATION_FORMAL_PROOF_FORMAT;
  files: readonly [{ path: string; size: number; sha256: string }];
  artifactManifest: Record<string, unknown>;
  independentLauncherAttestation: CandidateIndependentLauncherFormalEnvelope;
  proof: Readonly<{
    formalIdentity: CandidateFormalRuntimeArtifactIdentity;
    sessionProjection: Readonly<{
      workspaceId: string;
      projectId: number;
      userId: number;
      createdAt: string;
    }>;
    sessionBinding: string;
    workspaceBinding: string;
    walletBinding: string;
    correlationIdentityDigest: string;
    receiptSignerKeyIds: readonly string[];
    runtimeDescriptor: CandidateRuntimeAttestationDescriptor;
    runtimeChallenge: string;
    runtimeChallengeResponse: CandidateRuntimeChallengeResponse;
    capturedAt: string;
    expiresAt: string;
  }>;
  attestation: ReleaseArtifactAttestationV1;
}>;

export type CandidateBatchDAbsorption = Readonly<{
  absorbedByOperationKey: string;
  sameReceiptBinding: true;
  recoveryUpstreamCalls: 0;
  recoveryChargedCalls: 0;
}>;

export type CandidateTrustedSignedReceipt = Readonly<{
  format: typeof CANDIDATE_EXACT_AUTHORIZATION_SIGNED_RECEIPT_FORMAT;
  files: readonly [{ path: string; size: number; sha256: string }];
  statement: Readonly<{
    format: typeof CANDIDATE_EXACT_AUTHORIZATION_SIGNED_RECEIPT_FORMAT;
    candidateKey: CandidateExactAuthorizationKey;
    formalCandidateIdentityDigest: string;
    receipt: CandidateExactAuthorizationReceipt;
    batchDAbsorption: CandidateBatchDAbsorption | null;
  }>;
  attestation: ReleaseArtifactAttestationV1;
}>;

type ReviewEntry = CandidateExactAuthorizationPackage["entries"][number];

export type CandidateExactAuthorizationActivationEntry = ReviewEntry & Readonly<{
  authorization: Readonly<{
    formalCandidateIdentityDigest: string;
    receiptAttestationKeyId: string;
    signedReceiptPayloadSha256: string;
  }>;
  entryDigest: string;
}>;

export type CandidateExactAuthorizationActivationPackage = Readonly<{
  format: typeof CANDIDATE_EXACT_AUTHORIZATION_ACTIVATION_PACKAGE_FORMAT;
  generatedAt: string;
  expiresAt: string;
  authorizationState: "trusted-exact-execution-authorized";
  executionAuthorized: true;
  sessionBinding: string;
  workspaceBinding: string;
  walletBinding: string;
  correlationIdentityDigest: string;
  formalCandidateIdentity: CandidateFormalRuntimeArtifactIdentity;
  formalCandidateIdentityDigest: string;
  trustBoundary: Readonly<{
    releaseTrustStoreVerified: true;
    formalRuntimeChallengeVerified: true;
    runtimeArtifactBindingVerified: true;
    independentLauncherAttestationVerified: true;
    allSevenTrustedReceiptSignaturesVerified: true;
    driverExactPackageConsumptionRequired: true;
  }>;
  entries: readonly CandidateExactAuthorizationActivationEntry[];
  batchD: Readonly<{
    mode: "absorbed-by-full-matrix-operation" | "not-authorized";
    absorbedByOperationKey: string | null;
    sameReceiptBinding: boolean;
    additionalUpstreamCalls: 0;
    additionalChargedCalls: 0;
  }>;
  totals: CandidateExactAuthorizationPackage["totals"];
  authorizationEvidence: Readonly<{
    formalProof: CandidateFormalRuntimeArtifactProof;
    independentLauncherExpectation: CandidateIndependentLauncherFormalExpectation;
    signedReceipts: readonly CandidateTrustedSignedReceipt[];
  }>;
  independentLauncherTrust: Readonly<{
    formalTrustStoreDigest: string;
    baseTrustStoreDigest: string;
    formalAttestationDigest: string;
    baseAttestationDigest: string;
    formalIssuerKeyId: string;
    formalIssuerPublicKeyFingerprintSha256: string;
    baseIssuerKeyId: string;
    baseIssuerPublicKeyFingerprintSha256: string;
  }>;
  packageDigest: string;
}>;

export type CandidateExactAuthorizationConsumption = Readonly<{
  packageFile: string;
  packageFileDigest: string;
  runtimePackageIdentityBinding: string | null;
  packageDigest: string;
  candidateKey: CandidateExactAuthorizationKey;
  driverScript: string;
  entryDigest: string;
  formalCandidateIdentityDigest: string;
  sessionBinding: string;
  workspaceBinding: string;
  walletBinding: string;
  availableScopeDigest: string;
  availableMicros: number;
  reservedMicros: 0;
  maximumCostMicros: number;
  capturedAt: string;
  expiresAt: string;
  runtimeDescriptor: CandidateRuntimeAttestationDescriptor;
  batchDAbsorbedOperationKey: string | null;
  operations: readonly Readonly<{
    operationKey: string;
    endpointType: "text" | "image_generation" | "video_generation";
    operationDigest: string;
    model: string;
    provider: string;
    routeAlias: string;
    maximumGuMicros: number;
    directoryEntryDigest: string;
    routeEntryDigest: string;
    pricingEntryDigest: string;
    parameterDigest: string;
    pricingComponentsDigest: string;
    parameters: ReviewEntry["operations"][number]["parameters"];
  }>[];
}>;

export type CandidateExactAuthorizationBillingReadback = Readonly<{
  workspaceId: string;
  sessionUserId: number;
  account: Readonly<{
    id: string;
    workspaceId: string;
    currency: string;
    availableMicros: number;
    reservedMicros: number;
    status: string;
  }>;
  accountWallet: Readonly<{
    id: string;
    userId: number;
    ownerUserId: number;
    currency: string;
    totalAvailableMicros: number;
    status: string;
    defaultWorkspaceId: string | null;
  }>;
}>;

export type CandidateExactAuthorizationLiveCaptureReadback = Readonly<{
  receipt: CandidateExactAuthorizationReceipt;
  billingReadback: CandidateExactAuthorizationBillingReadback;
  readbackDigest: string;
}>;

export type CandidateExactAuthorizationLiveReadbackProof = Readonly<{
  format: "fanjin-candidate-exact-authorization-live-readback/v2";
  checkedAt: string;
  challengeNonce: string;
  runtimeChallenge: string;
  runtimeChallengeResponse: CandidateRuntimeChallengeResponse;
  runtimeChallengeResponseDigest: string;
  captureReadback: CandidateExactAuthorizationLiveCaptureReadback;
  billingReadbackDigest: string;
  operationsReadbackDigest: string;
  walletBinding: string;
  availableScopeDigest: string;
  availableMicros: number;
  reservedMicros: 0;
  proofDigest: string;
}>;

export type CandidateExactAuthorizationAbsorbedOperationProof = Readonly<{
  candidateKey: "full-matrix/mixed";
  packageDigest: string;
  entryDigest: string;
  operationKey: string;
  operationDigest: string;
  guardFile: string;
  guardFilePathBinding: string;
  guardFileDigest: string;
  guardInodeBinding: string;
  guardDigest: string;
  guardConsumptionProofDigest: string;
  sessionBinding: string;
}>;

export type CandidateExactAuthorizationCliBinding = Readonly<{
  remainingArgs: readonly string[];
  packageFile: string | null;
  packageFileDigest: string | null;
  packageFileIdentityBinding: string | null;
}>;

export type CandidateExactAuthorizationRuntimePackageIdentity = Readonly<{
  canonicalPath: string;
  directoryDev: string;
  directoryIno: string;
  directoryUid: number;
  directoryGid: number;
  directoryMode: number;
  dev: string;
  ino: string;
  uid: number;
  gid: number;
  mode: number;
  nlink: 1;
  size: number;
  fileDigest: string;
  identityBinding: string;
}>;

export type CandidateExactAuthorizationRuntimePackageReadback = Readonly<{
  identity: CandidateExactAuthorizationRuntimePackageIdentity;
  bytes: Buffer;
}>;

export type CandidateExactAuthorizationGuardBinding = Readonly<{
  packageFilePathBinding: string;
  packageFileDigest: string;
  packageDigest: string;
  candidateKey: CandidateExactAuthorizationKey;
  driverScript: string;
  entryDigest: string;
  formalCandidateIdentityDigest: string;
  sessionBinding: string;
  workspaceBinding: string;
  walletBinding: string;
  expiresAt: string;
}>;

export function candidateExactAuthorizationOperationsReadbackDigest(
  authorization: CandidateExactAuthorizationConsumption,
): string {
  return digest(authorization.operations.map((operation) => ({
    operationKey: operation.operationKey,
    endpointType: operation.endpointType,
    model: operation.model,
    provider: operation.provider,
    routeAlias: operation.routeAlias,
    maximumGuMicros: operation.maximumGuMicros,
    directoryEntryDigest: operation.directoryEntryDigest,
    routeEntryDigest: operation.routeEntryDigest,
    pricingEntryDigest: operation.pricingEntryDigest,
    parameterDigest: operation.parameterDigest,
    pricingComponentsDigest: operation.pricingComponentsDigest,
  })));
}

function candidateExactAuthorizationReceiptPricingComponentsDigest(
  components: CandidateExactAuthorizationReceipt["operations"][number]["pricingComponents"],
): string {
  return digest(components.map((component) => {
    return {
      ...component,
      maximumGu: guStringFromMicros(component.maximumCostMicros),
    };
  }));
}

function liveOperationsMatchAuthorization(
  receipt: CandidateExactAuthorizationReceipt,
  authorization: CandidateExactAuthorizationConsumption,
): boolean {
  const expectedOperations = new Map(
    authorization.operations.map((operation) => [
      operation.operationKey,
      operation,
    ]),
  );
  return receipt.candidateKey === authorization.candidateKey
    && receipt.sessionBinding === authorization.sessionBinding
    && receipt.capturedAt === authorization.capturedAt
    && receipt.expiresAt === authorization.expiresAt
    && receipt.quoteSource === (
      authorization.candidateKey === "full-matrix/mixed"
        ? "preflight"
        : "quote"
    )
    && receipt.budget.currency === "GU"
    && receipt.budget.workspaceBinding === authorization.workspaceBinding
    && receipt.budget.walletBinding === authorization.walletBinding
    && receipt.budget.availableScopeDigest
      === authorization.availableScopeDigest
    && receipt.budget.maximumCostMicros === authorization.maximumCostMicros
    && receipt.budget.availableMicros === authorization.availableMicros
    && receipt.budget.reservedMicros === authorization.reservedMicros
    && receipt.operations.length === expectedOperations.size
    && receipt.operations.every((operation) => {
      const expected = expectedOperations.get(operation.key);
      return Boolean(expected)
        && expected!.endpointType === operation.endpointType
        && expected!.model === operation.model
        && expected!.provider === operation.provider
        && expected!.routeAlias === operation.routeAlias
        && expected!.maximumGuMicros === operation.maximumCostMicros
        && expected!.directoryEntryDigest === operation.directoryEntryDigest
        && expected!.routeEntryDigest === operation.routeEntryDigest
        && expected!.pricingEntryDigest === operation.pricingEntryDigest
        && expected!.parameterDigest === operation.parameterDigest
        && expected!.pricingComponentsDigest
          === candidateExactAuthorizationReceiptPricingComponentsDigest(
            operation.pricingComponents,
          );
    });
}

export function verifyCandidateExactAuthorizationLiveCaptureReadback(input: {
  authorization: CandidateExactAuthorizationConsumption;
  receipt: unknown;
  billingReadback: unknown;
  now: number;
  expectedBillingIdentity?: {
    workspaceId: string;
    sessionUserId: number;
  };
}): CandidateExactAuthorizationLiveCaptureReadback {
  let receipt: CandidateExactAuthorizationReceipt;
  try {
    receipt = parseCandidateExactAuthorizationReceipt(input.receipt, input.now);
  } catch {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_OPERATIONS_READBACK_INVALID");
  }
  if (!liveOperationsMatchAuthorization(receipt, input.authorization)) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_OPERATIONS_READBACK_DRIFTED");
  }
  const rawBilling = input.billingReadback;
  if (!isRecord(rawBilling)) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_BILLING_READBACK_INVALID");
  }
  const expectedBillingIdentity = input.expectedBillingIdentity ?? {
    workspaceId: String(rawBilling.workspaceId || ""),
    sessionUserId: Number(rawBilling.sessionUserId || 0),
  };
  const billingReadback = parseBillingReadback(
    rawBilling,
    expectedBillingIdentity,
  );
  const walletBinding = candidateExactAuthorizationWalletBinding(
    billingReadback,
  );
  const availableScopeDigest =
    candidateExactAuthorizationAvailableScopeDigest(billingReadback);
  if (
    walletBinding !== input.authorization.walletBinding
    || availableScopeDigest !== input.authorization.availableScopeDigest
    || billingReadback.account.availableMicros
      !== input.authorization.availableMicros
    || billingReadback.account.reservedMicros
      !== input.authorization.reservedMicros
    || billingReadback.account.availableMicros
      < input.authorization.maximumCostMicros
  ) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_BILLING_READBACK_DRIFTED");
  }
  const body = Object.freeze({ receipt, billingReadback });
  return Object.freeze({ ...body, readbackDigest: digest(body) });
}

export function candidateExactAuthorizationLiveReadbackChallenge(input: {
  authorization: CandidateExactAuthorizationConsumption;
  checkedAt: string;
  challengeNonce: string;
  captureReadbackDigest: string;
}): string {
  const checkedAt = exactIso(
    input.checkedAt,
    "CANDIDATE_EXACT_AUTHORIZATION_LIVE_READBACK_PROOF_INVALID",
  );
  if (
    !SHA256_BASE64URL.test(input.challengeNonce)
    || !isDigest(input.captureReadbackDigest)
  ) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_LIVE_READBACK_PROOF_INVALID");
  }
  return crypto.createHash("sha256").update([
    LIVE_READBACK_CHALLENGE_DOMAIN,
    candidateExactAuthorizationCanonicalJson({
      checkedAt,
      challengeNonce: input.challengeNonce,
      captureReadbackDigest: input.captureReadbackDigest,
      candidateKey: input.authorization.candidateKey,
      packageDigest: input.authorization.packageDigest,
      entryDigest: input.authorization.entryDigest,
      formalCandidateIdentityDigest:
        input.authorization.formalCandidateIdentityDigest,
      sessionBinding: input.authorization.sessionBinding,
      workspaceBinding: input.authorization.workspaceBinding,
      walletBinding: input.authorization.walletBinding,
      operationsReadbackDigest:
        candidateExactAuthorizationOperationsReadbackDigest(
          input.authorization,
        ),
      expiresAt: input.authorization.expiresAt,
    }),
  ].join("\0"), "utf8").digest("base64url");
}

export function sealCandidateExactAuthorizationLiveReadbackProof(input: {
  authorization: CandidateExactAuthorizationConsumption;
  captureReadback: CandidateExactAuthorizationLiveCaptureReadback;
  checkedAt: string;
  challengeNonce: string;
  runtimeChallengeResponse: CandidateRuntimeChallengeResponse;
  now: number;
}): CandidateExactAuthorizationLiveReadbackProof {
  const checkedAt = exactIso(
    input.checkedAt,
    "CANDIDATE_EXACT_AUTHORIZATION_LIVE_READBACK_PROOF_INVALID",
  );
  const checkedAtMs = Date.parse(checkedAt);
  if (
    checkedAtMs < Date.parse(input.authorization.capturedAt)
    || checkedAtMs >= Date.parse(input.authorization.expiresAt)
    || input.now < checkedAtMs
    || input.now >= Date.parse(input.authorization.expiresAt)
  ) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_LIVE_READBACK_PROOF_INVALID");
  }
  const verifiedCapture = verifyCandidateExactAuthorizationLiveCaptureReadback({
    authorization: input.authorization,
    receipt: input.captureReadback.receipt,
    billingReadback: input.captureReadback.billingReadback,
    now: checkedAtMs,
  });
  if (verifiedCapture.readbackDigest !== input.captureReadback.readbackDigest) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_LIVE_READBACK_PROOF_INVALID");
  }
  const runtimeChallenge = candidateExactAuthorizationLiveReadbackChallenge({
    authorization: input.authorization,
    checkedAt,
    challengeNonce: input.challengeNonce,
    captureReadbackDigest: verifiedCapture.readbackDigest,
  });
  let runtimeChallengeResponse: CandidateRuntimeChallengeResponse;
  try {
    runtimeChallengeResponse = assertCandidateRuntimeChallengeResponse({
      descriptor: input.authorization.runtimeDescriptor,
      challenge: runtimeChallenge,
      response: input.runtimeChallengeResponse,
    });
  } catch {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_LIVE_READBACK_PROOF_INVALID");
  }
  const body = {
    format: "fanjin-candidate-exact-authorization-live-readback/v2" as const,
    checkedAt,
    challengeNonce: input.challengeNonce,
    runtimeChallenge,
    runtimeChallengeResponse,
    runtimeChallengeResponseDigest: digest(runtimeChallengeResponse),
    captureReadback: verifiedCapture,
    billingReadbackDigest: digest(verifiedCapture.billingReadback),
    operationsReadbackDigest:
      candidateExactAuthorizationOperationsReadbackDigest(input.authorization),
    walletBinding: input.authorization.walletBinding,
    availableScopeDigest: input.authorization.availableScopeDigest,
    availableMicros: verifiedCapture.billingReadback.account.availableMicros,
    reservedMicros: 0 as const,
  };
  return Object.freeze({ ...body, proofDigest: digest(body) });
}

function fail(code: string): never {
  throw new CandidateExactAuthorizationV2Error(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function sha256(value: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/**
 * Hash the exact release-manifest.json file bytes.  This digest includes every
 * byte of the signed envelope, including a trailing LF when the build emitted
 * one.  It is deliberately distinct from releaseManifestPayloadSha256, which
 * commits to the unsigned canonical attestation payload.
 */
export function candidateExactAuthorizationSignedManifestFileSha256(
  bytes: crypto.BinaryLike,
): string {
  return sha256(bytes);
}

/**
 * Build-format serializer used by fixtures that model the release build.  Real
 * capture paths must hash the stable bytes they read instead of re-rendering a
 * parsed object.
 */
export function candidateExactAuthorizationReleaseManifestFileBytes(
  manifest: Record<string, unknown>,
): Buffer {
  return Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8");
}

function digest(value: unknown): string {
  return `sha256:${sha256(candidateExactAuthorizationCanonicalJson(value))}`;
}

/**
 * A detached file hash is not evidence that the challenged process executed
 * that file.  Formal authorization therefore requires the runtime authority's
 * own descriptor (and, transitively, its challenge signature) to commit to the
 * exact signed-manifest entry being served.
 */
export function candidateExactAuthorizationRuntimeArtifactExecutionBindingMatches(
  input: Readonly<{
    runtimeDescriptor: CandidateRuntimeAttestationDescriptor;
    artifactManifest: Record<string, unknown>;
    artifactSignedManifestSha256: string;
    runtimeArtifact: Readonly<{
      manifestPath: string;
      sha256: string;
      byteSize: number;
    }>;
  }>,
): boolean {
  const binding = input.runtimeDescriptor.artifactExecutionBinding;
  const runtime = isRecord(input.artifactManifest.runtime)
    ? input.artifactManifest.runtime
    : null;
  const files = Array.isArray(input.artifactManifest.files)
    ? input.artifactManifest.files.filter(isRecord)
    : [];
  const matchingFiles = files.filter(
    (candidate) => candidate.path === input.runtimeArtifact.manifestPath,
  );
  return binding !== null
    && binding.artifactSignedManifestSha256
      === input.artifactSignedManifestSha256
    && binding.manifestPath === input.runtimeArtifact.manifestPath
    && binding.sha256 === input.runtimeArtifact.sha256
    && binding.byteSize === input.runtimeArtifact.byteSize
    && runtime?.entrypoint === input.runtimeArtifact.manifestPath
    && matchingFiles.length === 1
    && matchingFiles[0].sha256 === input.runtimeArtifact.sha256
    && matchingFiles[0].size === input.runtimeArtifact.byteSize;
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && SHA256_BINDING.test(value);
}

function exactIso(value: unknown, code: string): string {
  if (typeof value !== "string" || !value || value !== value.trim()) fail(code);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    fail(code);
  }
  return value;
}

function safePositiveInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) fail(code);
  return Number(value);
}

function safeNonNegativeInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail(code);
  return Number(value);
}

function exactNonEmptyString(value: unknown, code: string): string {
  if (typeof value !== "string" || !value || value !== value.trim()) fail(code);
  return value;
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return candidateExactAuthorizationCanonicalJson(left)
    === candidateExactAuthorizationCanonicalJson(right);
}

function immutableArtifactIdentityMatches(
  legacy: ReleaseCandidateSessionIdentity,
  formal: CandidateFormalRuntimeArtifactIdentity,
): boolean {
  return legacy.releaseUuid === formal.releaseUuid
    && legacy.artifactUuid === formal.artifactUuid
    && legacy.artifactSha256 === formal.artifactSha256
    && legacy.artifactSignedManifestSha256
      === formal.artifactSignedManifestSha256
    && legacy.sourceDigest === formal.sourceDigest
    && legacy.configExpectedSha256 === formal.configExpectedSha256
    && legacy.schemaExpectedSha256 === formal.schemaExpectedSha256
    && legacy.attestationKeyId === formal.releaseAttestationKeyId;
}

type CandidateIndependentLauncherCompilerInputs = Readonly<{
  attestation?: unknown;
  expectation: CandidateIndependentLauncherFormalExpectation;
  formalTrustStore?: CandidateIndependentLauncherFormalTrustStore;
  baseTrustStore?: CandidateIndependentLauncherTrustStore;
}>;

function launcherTrustStoreFromEnvironment<T>(input: Readonly<{
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>;
  key: string;
}>): T {
  const encoded = input.environment[input.key];
  if (
    typeof encoded !== "string"
    || encoded.length < 2
    || Buffer.byteLength(encoded, "utf8") > 1024 * 1024
  ) {
    return fail(
      "CANDIDATE_EXACT_AUTHORIZATION_INDEPENDENT_LAUNCHER_TRUST_STORE_REQUIRED",
    );
  }
  try {
    return JSON.parse(encoded) as T;
  } catch {
    return fail(
      "CANDIDATE_EXACT_AUTHORIZATION_INDEPENDENT_LAUNCHER_TRUST_STORE_INVALID",
    );
  }
}

function verifyIndependentLauncherBinding(input: Readonly<{
  formalProof: CandidateFormalRuntimeArtifactProof;
  launcher: CandidateIndependentLauncherCompilerInputs;
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>;
  now: number;
}>): Readonly<{
  verified: CandidateIndependentLauncherFormalVerifiedAttestation;
  expectation: CandidateIndependentLauncherFormalExpectation;
  formalTrustStoreDigest: string;
  baseTrustStoreDigest: string;
}> {
  const attestation = input.launcher.attestation
    ?? input.formalProof.independentLauncherAttestation;
  if (!sameCanonical(attestation, input.formalProof.independentLauncherAttestation)) {
    return fail(
      "CANDIDATE_EXACT_AUTHORIZATION_INDEPENDENT_LAUNCHER_ATTESTATION_MISMATCH",
    );
  }
  const formalTrustStore = input.launcher.formalTrustStore
    ?? launcherTrustStoreFromEnvironment<CandidateIndependentLauncherFormalTrustStore>({
      environment: input.environment,
      key: CANDIDATE_EXACT_AUTHORIZATION_FORMAL_LAUNCHER_TRUST_STORE_ENV,
    });
  const baseTrustStore = input.launcher.baseTrustStore
    ?? launcherTrustStoreFromEnvironment<CandidateIndependentLauncherTrustStore>({
      environment: input.environment,
      key: CANDIDATE_EXACT_AUTHORIZATION_BASE_LAUNCHER_TRUST_STORE_ENV,
    });
  let verified: CandidateIndependentLauncherFormalVerifiedAttestation;
  try {
    verified = verifyCandidateIndependentLauncherFormalAttestation({
      envelope: attestation,
      trustStore: formalTrustStore,
      baseTrustStore,
      expectation: input.launcher.expectation,
      now: input.now,
    });
  } catch {
    return fail(
      "CANDIDATE_EXACT_AUTHORIZATION_INDEPENDENT_LAUNCHER_ATTESTATION_INVALID",
    );
  }
  const formal = input.formalProof.proof.formalIdentity;
  const base = verified.base.statement;
  const runtimeDescriptor = input.formalProof.proof.runtimeDescriptor;
  const artifactRuntime = isRecord(input.formalProof.artifactManifest.runtime)
    ? input.formalProof.artifactManifest.runtime
    : null;
  if (
    verified.formalReady !== true
    || verified.issuerIntegrated !== true
    || verified.independentLauncherAttestationVerified !== true
    || verified.signatureValid !== true
    || verified.expectationBound !== true
    || base.candidate.releaseUuid !== formal.releaseUuid
    || base.candidate.artifactUuid !== formal.artifactUuid
    || base.candidate.artifactSha256 !== formal.artifactSha256
    || base.candidate.artifactSignedManifestSha256
      !== formal.artifactSignedManifestSha256
    || base.candidate.sourceDigest !== formal.sourceDigest
    || base.candidate.configExpectedSha256 !== formal.configExpectedSha256
    || base.candidate.schemaExpectedSha256 !== formal.schemaExpectedSha256
    || base.candidate.releaseAttestationKeyId !== formal.releaseAttestationKeyId
    || base.signedManifest.attestationKeyId !== formal.releaseAttestationKeyId
    || base.signedManifest.payloadSha256 !== formal.releaseManifestPayloadSha256
    || base.signedManifest.signedManifestSha256
      !== formal.artifactSignedManifestSha256
    || base.releaseRoot.releaseId
      !== input.formalProof.artifactManifest.releaseId
    || !artifactRuntime
    || !sameCanonical(base.nodeRuntime, artifactRuntime.nodeRuntime)
    || base.runtime.descriptorDigest !== formal.runtimeDescriptorDigest
    || base.runtime.authorityBinding !== formal.runtimeAuthorityBinding
    || base.runtime.descriptorDigest !== digest(runtimeDescriptor)
    || base.runtime.authorityBinding !== runtimeDescriptor.authorityBinding
    || base.runtime.descriptor.apiPid !== runtimeDescriptor.apiPid
    || base.processes.application.pid !== runtimeDescriptor.apiPid
    || base.session.sessionBinding !== input.formalProof.proof.sessionBinding
    || base.session.sessionBinding !== runtimeDescriptor.sessionBinding
    || base.session.checkpointBinding !== runtimeDescriptor.checkpointBinding
    || !sameCanonical(
      verified.statement.artifactExecutionBinding,
      runtimeDescriptor.artifactExecutionBinding,
    )
    || verified.statement.artifactExecutionBinding.manifestPath
      !== formal.runtimeArtifact.manifestPath
    || verified.statement.artifactExecutionBinding.sha256
      !== formal.runtimeArtifact.sha256
    || verified.statement.artifactExecutionBinding.byteSize
      !== formal.runtimeArtifact.byteSize
    || verified.statement.artifactExecutionBinding.artifactSignedManifestSha256
      !== formal.artifactSignedManifestSha256
  ) {
    return fail(
      "CANDIDATE_EXACT_AUTHORIZATION_INDEPENDENT_LAUNCHER_CROSS_BINDING_INVALID",
    );
  }
  return Object.freeze({
    verified,
    expectation: input.launcher.expectation,
    formalTrustStoreDigest: digest(formalTrustStore),
    baseTrustStoreDigest: digest(baseTrustStore),
  });
}

function verifiedReleaseAttestation(
  value: unknown,
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
): { keyId: string; payloadSha256: string } {
  try {
    return verifyReleaseArtifactAttestation(value, environment);
  } catch (error) {
    if (error instanceof ReleaseArtifactAttestationError) {
      fail(`CANDIDATE_EXACT_AUTHORIZATION_${error.code}`);
    }
    return fail("CANDIDATE_EXACT_AUTHORIZATION_TRUST_VERIFICATION_FAILED");
  }
}

export function candidateExactAuthorizationCorrelationIdentityDigest(
  identity: ReleaseCandidateSessionIdentity,
): string {
  const parsed = parseReleaseCandidateSessionCorrelationIdentity(identity);
  return `sha256:${sha256([
    CORRELATION_IDENTITY_DOMAIN,
    candidateExactAuthorizationCanonicalJson(parsed),
  ].join("\0"))}`;
}

export function candidateExactAuthorizationSessionBinding(session: {
  workspaceId: string;
  projectId: number;
  userId: number;
  createdAt: string;
  candidateIdentity?: ReleaseCandidateSessionIdentity;
}): string {
  if (
    typeof session.workspaceId !== "string"
    || !session.workspaceId
    || !Number.isSafeInteger(session.projectId)
    || session.projectId <= 0
    || !Number.isSafeInteger(session.userId)
    || session.userId <= 0
    || !session.candidateIdentity
  ) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_SESSION_INVALID");
  }
  const createdAt = exactIso(
    session.createdAt,
    "CANDIDATE_EXACT_AUTHORIZATION_SESSION_INVALID",
  );
  const identity = parseReleaseCandidateSessionCorrelationIdentity(
    session.candidateIdentity,
  );
  return `sha256:${sha256([
    SESSION_BINDING_DOMAIN,
    session.workspaceId,
    String(session.projectId),
    String(session.userId),
    createdAt,
    candidateExactAuthorizationCanonicalJson(identity),
  ].join("\0"))}`;
}

export function candidateExactAuthorizationWorkspaceBinding(
  workspaceId: string,
): string {
  if (typeof workspaceId !== "string" || !workspaceId || workspaceId !== workspaceId.trim()) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_WORKSPACE_INVALID");
  }
  return `sha256:${sha256([WORKSPACE_BINDING_DOMAIN, workspaceId].join("\0"))}`;
}

function parseBillingReadback(
  value: unknown,
  expected: { workspaceId: string; sessionUserId: number },
): CandidateExactAuthorizationBillingReadback {
  if (!isRecord(value) || !isRecord(value.account) || !isRecord(value.accountWallet)) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_BILLING_READBACK_INVALID");
  }
  const account = value.account;
  const accountWallet = value.accountWallet;
  const workspaceId = exactNonEmptyString(
    expected.workspaceId,
    "CANDIDATE_EXACT_AUTHORIZATION_BILLING_READBACK_INVALID",
  );
  const sessionUserId = safePositiveInteger(
    expected.sessionUserId,
    "CANDIDATE_EXACT_AUTHORIZATION_BILLING_READBACK_INVALID",
  );
  const accountWorkspaceId = exactNonEmptyString(
    account.workspaceId,
    "CANDIDATE_EXACT_AUTHORIZATION_BILLING_READBACK_INVALID",
  );
  if (accountWorkspaceId !== workspaceId) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_BILLING_WORKSPACE_MISMATCH");
  }
  const accountCurrency = exactNonEmptyString(
    account.currency,
    "CANDIDATE_EXACT_AUTHORIZATION_BILLING_READBACK_INVALID",
  ).toUpperCase();
  const walletCurrency = exactNonEmptyString(
    accountWallet.currency,
    "CANDIDATE_EXACT_AUTHORIZATION_BILLING_READBACK_INVALID",
  ).toUpperCase();
  if (accountCurrency !== "GU" || walletCurrency !== accountCurrency) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_BILLING_CURRENCY_MISMATCH");
  }
  const walletUserId = safePositiveInteger(
    accountWallet.userId,
    "CANDIDATE_EXACT_AUTHORIZATION_BILLING_READBACK_INVALID",
  );
  const ownerUserId = safePositiveInteger(
    accountWallet.ownerUserId,
    "CANDIDATE_EXACT_AUTHORIZATION_BILLING_READBACK_INVALID",
  );
  if (walletUserId !== ownerUserId) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_BILLING_WALLET_OWNER_MISMATCH");
  }
  const defaultWorkspaceId = accountWallet.defaultWorkspaceId === null
    ? null
    : exactNonEmptyString(
        accountWallet.defaultWorkspaceId,
        "CANDIDATE_EXACT_AUTHORIZATION_BILLING_READBACK_INVALID",
      );
  return Object.freeze({
    workspaceId,
    sessionUserId,
    account: Object.freeze({
      id: exactNonEmptyString(
        account.id,
        "CANDIDATE_EXACT_AUTHORIZATION_BILLING_READBACK_INVALID",
      ),
      workspaceId: accountWorkspaceId,
      currency: accountCurrency,
      availableMicros: safeNonNegativeInteger(
        account.availableMicros,
        "CANDIDATE_EXACT_AUTHORIZATION_BILLING_READBACK_INVALID",
      ),
      reservedMicros: safeNonNegativeInteger(
        account.reservedMicros,
        "CANDIDATE_EXACT_AUTHORIZATION_BILLING_READBACK_INVALID",
      ),
      status: exactNonEmptyString(
        account.status,
        "CANDIDATE_EXACT_AUTHORIZATION_BILLING_READBACK_INVALID",
      ),
    }),
    accountWallet: Object.freeze({
      id: exactNonEmptyString(
        accountWallet.id,
        "CANDIDATE_EXACT_AUTHORIZATION_BILLING_READBACK_INVALID",
      ),
      userId: walletUserId,
      ownerUserId,
      currency: walletCurrency,
      totalAvailableMicros: safeNonNegativeInteger(
        accountWallet.totalAvailableMicros,
        "CANDIDATE_EXACT_AUTHORIZATION_BILLING_READBACK_INVALID",
      ),
      status: exactNonEmptyString(
        accountWallet.status,
        "CANDIDATE_EXACT_AUTHORIZATION_BILLING_READBACK_INVALID",
      ),
      defaultWorkspaceId,
    }),
  });
}

export function candidateExactAuthorizationWalletBinding(
  readback: CandidateExactAuthorizationBillingReadback,
): string {
  const parsed = parseBillingReadback(readback, {
    workspaceId: readback.workspaceId,
    sessionUserId: readback.sessionUserId,
  });
  return `sha256:${sha256([
    WALLET_BINDING_DOMAIN,
    candidateExactAuthorizationCanonicalJson({
      workspaceId: parsed.workspaceId,
      sessionUserId: parsed.sessionUserId,
      account: {
        id: parsed.account.id,
        workspaceId: parsed.account.workspaceId,
        currency: parsed.account.currency,
      },
      accountWallet: {
        id: parsed.accountWallet.id,
        userId: parsed.accountWallet.userId,
        ownerUserId: parsed.accountWallet.ownerUserId,
        currency: parsed.accountWallet.currency,
        defaultWorkspaceId: parsed.accountWallet.defaultWorkspaceId,
      },
    }),
  ].join("\0"))}`;
}

export function candidateExactAuthorizationAvailableScopeDigest(
  readback: CandidateExactAuthorizationBillingReadback,
): string {
  const parsed = parseBillingReadback(readback, {
    workspaceId: readback.workspaceId,
    sessionUserId: readback.sessionUserId,
  });
  return `sha256:${sha256([
    AVAILABLE_SCOPE_DOMAIN,
    candidateExactAuthorizationCanonicalJson({
      walletBinding: candidateExactAuthorizationWalletBinding(parsed),
      workspaceId: parsed.workspaceId,
      accountId: parsed.account.id,
      walletId: parsed.accountWallet.id,
      accountStatus: parsed.account.status,
      walletStatus: parsed.accountWallet.status,
      availableMicros: parsed.account.availableMicros,
      reservedMicros: parsed.account.reservedMicros,
      walletTotalAvailableMicros: parsed.accountWallet.totalAvailableMicros,
    }),
  ].join("\0"))}`;
}

function parseFormalIdentity(value: unknown): CandidateFormalRuntimeArtifactIdentity {
  if (!isRecord(value) || !exactKeys(value, [
    "artifactSha256",
    "artifactSignedManifestSha256",
    "artifactUuid",
    "configExpectedSha256",
    "evidenceClass",
    "format",
    "releaseAttestationKeyId",
    "releaseManifestPayloadSha256",
    "releaseUuid",
    "runtimeArtifact",
    "runtimeAuthorityBinding",
    "runtimeDescriptorDigest",
    "schemaExpectedSha256",
    "sourceDigest",
  ])) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_FORMAL_IDENTITY_INVALID");
  }
  if (!isRecord(value.runtimeArtifact) || !exactKeys(value.runtimeArtifact, [
    "byteSize",
    "manifestPath",
    "sha256",
  ])) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_RUNTIME_ARTIFACT_INVALID");
  }
  const runtimeArtifact = value.runtimeArtifact;
  if (
    value.format !== CANDIDATE_EXACT_AUTHORIZATION_FORMAL_PROOF_FORMAT
    || value.evidenceClass !== FORMAL_EVIDENCE_CLASS
    || !UUID_PATTERN.test(String(value.releaseUuid ?? ""))
    || !UUID_PATTERN.test(String(value.artifactUuid ?? ""))
    || !SHA256_HEX.test(String(value.artifactSha256 ?? ""))
    || !SHA256_HEX.test(String(value.artifactSignedManifestSha256 ?? ""))
    || !SOURCE_DIGEST_PATTERN.test(String(value.sourceDigest ?? ""))
    || !SHA256_HEX.test(String(value.configExpectedSha256 ?? ""))
    || !SHA256_HEX.test(String(value.schemaExpectedSha256 ?? ""))
    || !KEY_ID_PATTERN.test(String(value.releaseAttestationKeyId ?? ""))
    || String(value.releaseAttestationKeyId).startsWith("dev-local-only-")
    || !isDigest(value.releaseManifestPayloadSha256)
    || !SAFE_MANIFEST_PATH.test(String(runtimeArtifact.manifestPath ?? ""))
    || !SHA256_HEX.test(String(runtimeArtifact.sha256 ?? ""))
    || !isDigest(value.runtimeAuthorityBinding)
    || !isDigest(value.runtimeDescriptorDigest)
  ) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_FORMAL_IDENTITY_INVALID");
  }
  return {
    format: CANDIDATE_EXACT_AUTHORIZATION_FORMAL_PROOF_FORMAT,
    evidenceClass: FORMAL_EVIDENCE_CLASS,
    releaseUuid: String(value.releaseUuid),
    artifactUuid: String(value.artifactUuid),
    artifactSha256: String(value.artifactSha256),
    artifactSignedManifestSha256: String(value.artifactSignedManifestSha256),
    sourceDigest: String(value.sourceDigest),
    configExpectedSha256: String(value.configExpectedSha256),
    schemaExpectedSha256: String(value.schemaExpectedSha256),
    releaseAttestationKeyId: String(value.releaseAttestationKeyId),
    releaseManifestPayloadSha256: String(value.releaseManifestPayloadSha256),
    runtimeArtifact: {
      manifestPath: String(runtimeArtifact.manifestPath),
      sha256: String(runtimeArtifact.sha256),
      byteSize: safePositiveInteger(
        runtimeArtifact.byteSize,
        "CANDIDATE_EXACT_AUTHORIZATION_RUNTIME_ARTIFACT_INVALID",
      ),
    },
    runtimeAuthorityBinding: String(value.runtimeAuthorityBinding),
    runtimeDescriptorDigest: String(value.runtimeDescriptorDigest),
  };
}

function verifyFormalProof(input: {
  value: unknown;
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>;
  now: number;
}): CandidateFormalRuntimeArtifactProof {
  const value = input.value;
  if (!isRecord(value)) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_FORMAL_PROOF_INVALID");
  }
  // Verify with the repository's release-artifact trust store before any
  // identity, signer allow-list, runtime key or receipt field is trusted.
  const verified = verifiedReleaseAttestation(value, input.environment);
  if (!exactKeys(value, [
    "artifactManifest",
    "attestation",
    "files",
    "format",
    "independentLauncherAttestation",
    "proof",
  ])) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_FORMAL_PROOF_INVALID");
  }
  if (
    value.format !== CANDIDATE_EXACT_AUTHORIZATION_FORMAL_PROOF_FORMAT
    || !Array.isArray(value.files)
    || value.files.length !== 1
    || !isRecord(value.independentLauncherAttestation)
    || !isRecord(value.proof)
  ) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_FORMAL_PROOF_INVALID");
  }
  const proof = value.proof;
  if (!exactKeys(proof, [
    "capturedAt",
    "correlationIdentityDigest",
    "expiresAt",
    "formalIdentity",
    "receiptSignerKeyIds",
    "runtimeChallenge",
    "runtimeChallengeResponse",
    "runtimeDescriptor",
    "sessionProjection",
    "sessionBinding",
    "walletBinding",
    "workspaceBinding",
  ])) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_FORMAL_PROOF_INVALID");
  }
  const formalIdentity = parseFormalIdentity(proof.formalIdentity);
  if (!isRecord(value.artifactManifest)) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_ARTIFACT_MANIFEST_INVALID");
  }
  const verifiedArtifactManifest = verifiedReleaseAttestation(
    value.artifactManifest,
    input.environment,
  );
  let parsedArtifactManifest;
  try {
    parsedArtifactManifest = parseReleaseArtifactManifest(value.artifactManifest);
  } catch {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_ARTIFACT_MANIFEST_INVALID");
  }
  const capturedAt = exactIso(
    proof.capturedAt,
    "CANDIDATE_EXACT_AUTHORIZATION_FORMAL_PROOF_TIME_INVALID",
  );
  const expiresAt = exactIso(
    proof.expiresAt,
    "CANDIDATE_EXACT_AUTHORIZATION_FORMAL_PROOF_TIME_INVALID",
  );
  const capturedAtMs = Date.parse(capturedAt);
  const expiresAtMs = Date.parse(expiresAt);
  if (
    !Number.isFinite(input.now)
    || expiresAtMs <= capturedAtMs
    || expiresAtMs - capturedAtMs > MAX_AUTHORIZATION_LIFETIME_MS
    || input.now < capturedAtMs
    || input.now >= expiresAtMs
  ) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_FORMAL_PROOF_EXPIRED");
  }
  if (!isRecord(proof.sessionProjection) || !exactKeys(
    proof.sessionProjection,
    ["createdAt", "projectId", "userId", "workspaceId"],
  )) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_SESSION_INVALID");
  }
  const sessionProjection = {
    workspaceId: exactNonEmptyString(
      proof.sessionProjection.workspaceId,
      "CANDIDATE_EXACT_AUTHORIZATION_SESSION_INVALID",
    ),
    projectId: safePositiveInteger(
      proof.sessionProjection.projectId,
      "CANDIDATE_EXACT_AUTHORIZATION_SESSION_INVALID",
    ),
    userId: safePositiveInteger(
      proof.sessionProjection.userId,
      "CANDIDATE_EXACT_AUTHORIZATION_SESSION_INVALID",
    ),
    createdAt: exactIso(
      proof.sessionProjection.createdAt,
      "CANDIDATE_EXACT_AUTHORIZATION_SESSION_INVALID",
    ),
  };
  if (
    formalIdentity.releaseAttestationKeyId !== verified.keyId
    || verifiedArtifactManifest.keyId !== verified.keyId
    || formalIdentity.releaseManifestPayloadSha256
      !== `sha256:${verifiedArtifactManifest.payloadSha256}`
    || formalIdentity.sourceDigest !== parsedArtifactManifest.sourceCommit
    || !isDigest(proof.sessionBinding)
    || !isDigest(proof.workspaceBinding)
    || !isDigest(proof.walletBinding)
    || !isDigest(proof.correlationIdentityDigest)
    || proof.workspaceBinding
      !== candidateExactAuthorizationWorkspaceBinding(
        sessionProjection.workspaceId,
      )
    || !Array.isArray(proof.receiptSignerKeyIds)
    || proof.receiptSignerKeyIds.length < 1
    || proof.receiptSignerKeyIds.length > 32
    || proof.receiptSignerKeyIds.some((key) => (
      typeof key !== "string"
      || !KEY_ID_PATTERN.test(key)
      || key.startsWith("dev-local-only-")
    ))
    || new Set(proof.receiptSignerKeyIds).size !== proof.receiptSignerKeyIds.length
  ) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_FORMAL_PROOF_INVALID");
  }

  let runtimeDescriptor: CandidateRuntimeAttestationDescriptor;
  try {
    runtimeDescriptor = assertCandidateRuntimeAttestationDescriptor(
      proof.runtimeDescriptor,
    );
  } catch {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_RUNTIME_PROOF_INVALID");
  }
  if (
    runtimeDescriptor.runtimeMode !== "candidate"
    || runtimeDescriptor.runtimePolicy.recoveryOnly
    || runtimeDescriptor.sessionBinding !== proof.sessionBinding
    || runtimeDescriptor.authorityBinding
      !== formalIdentity.runtimeAuthorityBinding
    || digest(runtimeDescriptor) !== formalIdentity.runtimeDescriptorDigest
  ) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_RUNTIME_PROOF_INVALID");
  }
  if (!candidateExactAuthorizationRuntimeArtifactExecutionBindingMatches({
    runtimeDescriptor,
    artifactManifest: value.artifactManifest,
    artifactSignedManifestSha256:
      formalIdentity.artifactSignedManifestSha256,
    runtimeArtifact: formalIdentity.runtimeArtifact,
  })) {
    return fail(
      "CANDIDATE_EXACT_AUTHORIZATION_RUNTIME_ARTIFACT_EXECUTION_BINDING_INVALID",
    );
  }
  try {
    assertCandidateRuntimeChallengeResponse({
      descriptor: runtimeDescriptor,
      challenge: String(proof.runtimeChallenge ?? ""),
      response: proof.runtimeChallengeResponse,
    });
  } catch {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_RUNTIME_PROOF_INVALID");
  }

  const file = value.files[0];
  const artifactFiles = Array.isArray(value.artifactManifest.files)
    ? value.artifactManifest.files
    : [];
  const signedRuntimeFile = artifactFiles.find((candidate) => (
    isRecord(candidate)
    && candidate.path === formalIdentity.runtimeArtifact.manifestPath
  ));
  if (
    !isRecord(file)
    || !exactKeys(file, ["path", "sha256", "size"])
    || file.path !== formalIdentity.runtimeArtifact.manifestPath
    || file.sha256 !== formalIdentity.runtimeArtifact.sha256
    || file.size !== formalIdentity.runtimeArtifact.byteSize
    || !isRecord(signedRuntimeFile)
    || signedRuntimeFile.sha256 !== formalIdentity.runtimeArtifact.sha256
    || signedRuntimeFile.size !== formalIdentity.runtimeArtifact.byteSize
  ) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_RUNTIME_ARTIFACT_INVALID");
  }
  return value as unknown as CandidateFormalRuntimeArtifactProof;
}

function verifySignedReceipt(input: {
  value: unknown;
  formal: CandidateFormalRuntimeArtifactProof;
  formalIdentityDigest: string;
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>;
  now: number;
}): {
  signed: CandidateTrustedSignedReceipt;
  receipt: CandidateExactAuthorizationReceipt;
  attestationKeyId: string;
  payloadSha256: string;
} {
  const value = input.value;
  if (!isRecord(value)) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_SIGNED_RECEIPT_INVALID");
  }
  const verified = verifiedReleaseAttestation(value, input.environment);
  if (
    !exactKeys(value, ["attestation", "files", "format", "statement"])
    || value.format !== CANDIDATE_EXACT_AUTHORIZATION_SIGNED_RECEIPT_FORMAT
    || !Array.isArray(value.files)
    || value.files.length !== 1
    || !isRecord(value.statement)
  ) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_SIGNED_RECEIPT_INVALID");
  }
  const statement = value.statement;
  if (!exactKeys(statement, [
    "batchDAbsorption",
    "candidateKey",
    "formalCandidateIdentityDigest",
    "format",
    "receipt",
  ])) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_SIGNED_RECEIPT_INVALID");
  }
  if (
    statement.format !== CANDIDATE_EXACT_AUTHORIZATION_SIGNED_RECEIPT_FORMAT
    || statement.formalCandidateIdentityDigest !== input.formalIdentityDigest
    || !input.formal.proof.receiptSignerKeyIds.includes(verified.keyId)
  ) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_RECEIPT_SIGNER_UNTRUSTED");
  }
  let receipt: CandidateExactAuthorizationReceipt;
  try {
    receipt = parseCandidateExactAuthorizationReceipt(statement.receipt, input.now);
  } catch {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_SIGNED_RECEIPT_INVALID");
  }
  if (statement.candidateKey !== receipt.candidateKey) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_SIGNED_RECEIPT_INVALID");
  }
  const receiptCapturedAt = Date.parse(receipt.capturedAt);
  const receiptExpiresAt = Date.parse(receipt.expiresAt);
  if (
    receiptExpiresAt - receiptCapturedAt > MAX_AUTHORIZATION_LIFETIME_MS
    || input.now < receiptCapturedAt
    || input.now >= receiptExpiresAt
  ) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_SIGNED_RECEIPT_EXPIRED");
  }
  const receiptBytes = Buffer.from(
    candidateExactAuthorizationCanonicalJson(receipt),
    "utf8",
  );
  const file = value.files[0];
  const expectedPath = `candidate-authorization/receipts/${receipt.candidateKey.replace("/", "-")}.json`;
  if (
    !isRecord(file)
    || !exactKeys(file, ["path", "sha256", "size"])
    || file.path !== expectedPath
    || file.sha256 !== sha256(receiptBytes)
    || file.size !== receiptBytes.byteLength
  ) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_SIGNED_RECEIPT_INVALID");
  }
  const formalIdentity = input.formal.proof.formalIdentity;
  if (
    receipt.sessionBinding !== input.formal.proof.sessionBinding
    || receipt.budget.workspaceBinding !== input.formal.proof.workspaceBinding
    || receipt.budget.walletBinding !== input.formal.proof.walletBinding
    || !immutableArtifactIdentityMatches(receipt.candidateIdentity, formalIdentity)
  ) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_RECEIPT_BINDING_MISMATCH");
  }
  const absorption = statement.batchDAbsorption;
  if (receipt.candidateKey !== "full-matrix/mixed" && absorption !== null) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_BATCH_D_BINDING_INVALID");
  }
  if (absorption !== null) {
    if (
      !isRecord(absorption)
      || !exactKeys(absorption, [
        "absorbedByOperationKey",
        "recoveryChargedCalls",
        "recoveryUpstreamCalls",
        "sameReceiptBinding",
      ])
      || absorption.sameReceiptBinding !== true
      || absorption.recoveryUpstreamCalls !== 0
      || absorption.recoveryChargedCalls !== 0
    ) {
      return fail("CANDIDATE_EXACT_AUTHORIZATION_BATCH_D_BINDING_INVALID");
    }
    const operation = receipt.operations.find(
      (candidate) => candidate.key === absorption.absorbedByOperationKey,
    );
    if (
      !operation
      || operation.endpointType !== "image_generation"
      || operation.chargedCallCeiling !== 1
      || operation.media?.kind !== "image"
    ) {
      return fail("CANDIDATE_EXACT_AUTHORIZATION_BATCH_D_BINDING_INVALID");
    }
  }
  return {
    signed: value as unknown as CandidateTrustedSignedReceipt,
    receipt,
    attestationKeyId: verified.keyId,
    payloadSha256: `sha256:${verified.payloadSha256}`,
  };
}

export function compileCandidateExactAuthorizationActivationPackage(input: {
  formalProof: unknown;
  signedReceipts: readonly unknown[];
  independentLauncher: CandidateIndependentLauncherCompilerInputs;
  environment?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  now?: number;
}): CandidateExactAuthorizationActivationPackage {
  const now = input.now ?? Date.now();
  if (!Number.isFinite(now)) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_TIME_INVALID");
  }
  const environment = input.environment ?? process.env;
  const formalProof = verifyFormalProof({
    value: input.formalProof,
    environment,
    now,
  });
  if (!input.independentLauncher || !input.independentLauncher.expectation) {
    return fail(
      "CANDIDATE_EXACT_AUTHORIZATION_INDEPENDENT_LAUNCHER_ATTESTATION_REQUIRED",
    );
  }
  const independentLauncher = verifyIndependentLauncherBinding({
    formalProof,
    launcher: input.independentLauncher,
    environment,
    now,
  });
  const formalCandidateIdentityDigest = digest(
    formalProof.proof.formalIdentity,
  );
  if (input.signedReceipts.length !== CANDIDATE_EXACT_AUTHORIZATION_REQUIRED_KEYS.length) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_RECEIPT_SET_INCOMPLETE");
  }
  const verifiedReceipts = input.signedReceipts.map((value) => (
    verifySignedReceipt({
      value,
      formal: formalProof,
      formalIdentityDigest: formalCandidateIdentityDigest,
      environment,
      now,
    })
  ));
  const byKey = new Map(verifiedReceipts.map((item) => [
    item.receipt.candidateKey,
    item,
  ]));
  if (
    byKey.size !== CANDIDATE_EXACT_AUTHORIZATION_REQUIRED_KEYS.length
    || CANDIDATE_EXACT_AUTHORIZATION_REQUIRED_KEYS.some((key) => !byKey.has(key))
  ) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_RECEIPT_SET_INCOMPLETE");
  }
  const first = byKey.get(CANDIDATE_EXACT_AUTHORIZATION_REQUIRED_KEYS[0]);
  if (!first) return fail("CANDIDATE_EXACT_AUTHORIZATION_RECEIPT_SET_INCOMPLETE");
  const exactCorrelationIdentity = first.receipt.candidateIdentity;
  if (
    verifiedReceipts.some((item) => !sameCanonical(
      item.receipt.candidateIdentity,
      exactCorrelationIdentity,
    ))
    || formalProof.proof.correlationIdentityDigest
      !== candidateExactAuthorizationCorrelationIdentityDigest(
        exactCorrelationIdentity,
      )
    || formalProof.proof.sessionBinding
      !== candidateExactAuthorizationSessionBinding({
        ...formalProof.proof.sessionProjection,
        candidateIdentity: exactCorrelationIdentity,
      })
  ) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_CORRELATION_IDENTITY_MISMATCH");
  }
  const anchor = sealCandidateExactAuthorizationAnchor({
    format: CANDIDATE_EXACT_AUTHORIZATION_ANCHOR_VERSION,
    candidateIdentity: first.receipt.candidateIdentity,
    sessionBinding: formalProof.proof.sessionBinding,
    workspaceBinding: formalProof.proof.workspaceBinding,
    walletBinding: formalProof.proof.walletBinding,
  });
  const review = compileCandidateExactAuthorizationPackage({
    anchor,
    receipts: CANDIDATE_EXACT_AUTHORIZATION_REQUIRED_KEYS.map(
      (key) => byKey.get(key)!.receipt,
    ),
    now,
  });
  const entries = review.entries.map((entry) => {
    const signed = byKey.get(entry.candidateKey)!;
    const body = {
      ...entry,
      authorization: {
        formalCandidateIdentityDigest,
        receiptAttestationKeyId: signed.attestationKeyId,
        signedReceiptPayloadSha256: signed.payloadSha256,
      },
    };
    return { ...body, entryDigest: digest(body) };
  });
  const fullMatrix = byKey.get("full-matrix/mixed")!;
  const absorption = fullMatrix.signed.statement.batchDAbsorption;
  const expiresAt = [
    formalProof.proof.expiresAt,
    independentLauncher.verified.statement.expiresAt,
    ...verifiedReceipts.map((item) => item.receipt.expiresAt),
  ].sort((left, right) => Date.parse(left) - Date.parse(right))[0];
  const generatedAt = [
    formalProof.proof.capturedAt,
    ...verifiedReceipts.map((item) => item.receipt.capturedAt),
  ].sort((left, right) => Date.parse(right) - Date.parse(left))[0];
  if (Date.parse(generatedAt) >= Date.parse(expiresAt)) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_PACKAGE_EXPIRED");
  }
  const body = {
    format: CANDIDATE_EXACT_AUTHORIZATION_ACTIVATION_PACKAGE_FORMAT,
    generatedAt,
    expiresAt,
    authorizationState: "trusted-exact-execution-authorized" as const,
    executionAuthorized: true as const,
    sessionBinding: formalProof.proof.sessionBinding,
    workspaceBinding: formalProof.proof.workspaceBinding,
    walletBinding: formalProof.proof.walletBinding,
    correlationIdentityDigest: formalProof.proof.correlationIdentityDigest,
    formalCandidateIdentity: formalProof.proof.formalIdentity,
    formalCandidateIdentityDigest,
    trustBoundary: {
      releaseTrustStoreVerified: true as const,
      formalRuntimeChallengeVerified: true as const,
      runtimeArtifactBindingVerified: true as const,
      independentLauncherAttestationVerified: true as const,
      allSevenTrustedReceiptSignaturesVerified: true as const,
      driverExactPackageConsumptionRequired: true as const,
    },
    entries,
    batchD: absorption
      ? {
          mode: "absorbed-by-full-matrix-operation" as const,
          absorbedByOperationKey: absorption.absorbedByOperationKey,
          sameReceiptBinding: true,
          additionalUpstreamCalls: 0 as const,
          additionalChargedCalls: 0 as const,
        }
      : {
          mode: "not-authorized" as const,
          absorbedByOperationKey: null,
          sameReceiptBinding: false,
          additionalUpstreamCalls: 0 as const,
          additionalChargedCalls: 0 as const,
        },
    totals: review.totals,
    authorizationEvidence: {
      formalProof,
      independentLauncherExpectation: independentLauncher.expectation,
      signedReceipts: CANDIDATE_EXACT_AUTHORIZATION_REQUIRED_KEYS.map(
        (key) => byKey.get(key)!.signed,
      ),
    },
    independentLauncherTrust: {
      formalTrustStoreDigest: independentLauncher.formalTrustStoreDigest,
      baseTrustStoreDigest: independentLauncher.baseTrustStoreDigest,
      formalAttestationDigest:
        independentLauncher.verified.attestationDigest,
      baseAttestationDigest:
        independentLauncher.verified.v1AttestationDigest,
      formalIssuerKeyId: independentLauncher.verified.keyId,
      formalIssuerPublicKeyFingerprintSha256:
        independentLauncher.verified.publicKeyFingerprintSha256,
      baseIssuerKeyId: independentLauncher.verified.base.keyId,
      baseIssuerPublicKeyFingerprintSha256:
        independentLauncher.verified.base.publicKeyFingerprintSha256,
    },
  };
  return { ...body, packageDigest: digest(body) };
}

export function renderCandidateExactAuthorizationActivationPackage(
  value: CandidateExactAuthorizationActivationPackage,
): string {
  return `${candidateExactAuthorizationCanonicalJson(value)}\n`;
}

export function verifyCandidateExactAuthorizationActivationPackage(input: {
  value: unknown;
  environment?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  now?: number;
}): CandidateExactAuthorizationActivationPackage {
  if (!isRecord(input.value) || !isRecord(input.value.authorizationEvidence)) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_PACKAGE_INVALID");
  }
  const evidence = input.value.authorizationEvidence;
  if (!exactKeys(evidence, [
    "formalProof",
    "independentLauncherExpectation",
    "signedReceipts",
  ])
    || !Array.isArray(evidence.signedReceipts)) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_PACKAGE_INVALID");
  }
  const compiled = compileCandidateExactAuthorizationActivationPackage({
    formalProof: evidence.formalProof,
    signedReceipts: evidence.signedReceipts,
    independentLauncher: {
      expectation: evidence.independentLauncherExpectation as
        CandidateIndependentLauncherFormalExpectation,
    },
    environment: input.environment,
    now: input.now,
  });
  if (!sameCanonical(input.value, compiled)) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_PACKAGE_TAMPERED");
  }
  return compiled;
}

export function candidateExactAuthorizationPackageFileDigest(
  bytes: Buffer | string,
): string {
  return `sha256:${sha256(bytes)}`;
}

function readProtectedPackageFile(filePath: string): { canonicalPath: string; bytes: Buffer } {
  if (!path.isAbsolute(filePath) || path.normalize(filePath) !== filePath) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_PACKAGE_PATH_INVALID");
  }
  let descriptor: number | null = null;
  try {
    const before = fs.lstatSync(filePath);
    const canonicalPath = fs.realpathSync(filePath);
    if (
      canonicalPath !== filePath
      || before.isSymbolicLink()
      || !before.isFile()
      || before.nlink !== 1
      || (before.mode & 0o777) !== 0o600
      || before.size < 2
      || before.size > MAX_PACKAGE_BYTES
      || (typeof process.getuid === "function" && before.uid !== process.getuid())
    ) {
      return fail("CANDIDATE_EXACT_AUTHORIZATION_PACKAGE_FILE_UNSAFE");
    }
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY
        | (typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0),
    );
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isFile()
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size !== before.size
    ) {
      return fail("CANDIDATE_EXACT_AUTHORIZATION_PACKAGE_FILE_CHANGED");
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (
      after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs
      || bytes.byteLength !== opened.size
    ) {
      return fail("CANDIDATE_EXACT_AUTHORIZATION_PACKAGE_FILE_CHANGED");
    }
    return { canonicalPath, bytes };
  } catch (error) {
    if (error instanceof CandidateExactAuthorizationV2Error) throw error;
    return fail("CANDIDATE_EXACT_AUTHORIZATION_PACKAGE_READ_FAILED");
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function sameRuntimePackageFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.gid === right.gid
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size;
}

function sameRuntimePackageDirectoryIdentity(
  left: fs.Stats,
  right: fs.Stats,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.gid === right.gid
    && left.mode === right.mode;
}

function runtimePackageIdentity(input: Readonly<{
  canonicalPath: string;
  directory: fs.Stats;
  file: fs.Stats;
  fileDigest: string;
}>): CandidateExactAuthorizationRuntimePackageIdentity {
  const body = Object.freeze({
    canonicalPath: input.canonicalPath,
    directoryDev: String(input.directory.dev),
    directoryIno: String(input.directory.ino),
    directoryUid: input.directory.uid,
    directoryGid: input.directory.gid,
    directoryMode: input.directory.mode & 0o7777,
    dev: String(input.file.dev),
    ino: String(input.file.ino),
    uid: input.file.uid,
    gid: input.file.gid,
    mode: input.file.mode & 0o7777,
    nlink: 1 as const,
    size: input.file.size,
    fileDigest: input.fileDigest,
  });
  return Object.freeze({
    ...body,
    identityBinding: digest({
      domain: RUNTIME_PACKAGE_IDENTITY_DOMAIN,
      ...body,
    }),
  });
}

/**
 * Reads the runtime-owned package snapshot without following links and binds
 * both the file and its 0700 parent directory. The binding is suitable for a
 * signed argv hand-off; a same-uid rename/replacement therefore cannot silently
 * substitute another inode even when it contains identical bytes.
 */
export function readCandidateExactAuthorizationRuntimePackageSnapshot(
  input: Readonly<{
    filePath: string;
    ownerUid: number;
    ownerGid: number;
    expectedIdentityBinding?: string;
  }>,
): CandidateExactAuthorizationRuntimePackageReadback {
  if (
    !path.isAbsolute(input.filePath)
    || path.normalize(input.filePath) !== input.filePath
    || input.filePath.includes("\0")
    || !Number.isSafeInteger(input.ownerUid)
    || input.ownerUid < 0
    || !Number.isSafeInteger(input.ownerGid)
    || input.ownerGid < 0
    || (
      input.expectedIdentityBinding !== undefined
      && !SHA256_BINDING.test(input.expectedIdentityBinding)
    )
  ) return fail("CANDIDATE_EXACT_AUTHORIZATION_RUNTIME_PACKAGE_INPUT_INVALID");

  const directory = path.dirname(input.filePath);
  let directoryDescriptor: number | null = null;
  let descriptor: number | null = null;
  try {
    const directoryBefore = fs.lstatSync(directory);
    if (
      fs.realpathSync(directory) !== directory
      || directoryBefore.isSymbolicLink()
      || !directoryBefore.isDirectory()
      || directoryBefore.uid !== input.ownerUid
      || directoryBefore.gid !== input.ownerGid
      || (directoryBefore.mode & 0o7777) !== 0o700
    ) return fail("CANDIDATE_EXACT_AUTHORIZATION_RUNTIME_PACKAGE_PARENT_UNSAFE");
    directoryDescriptor = fs.openSync(
      directory,
      fs.constants.O_RDONLY
        | (typeof fs.constants.O_DIRECTORY === "number" ? fs.constants.O_DIRECTORY : 0)
        | (typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0),
    );
    const directoryOpened = fs.fstatSync(directoryDescriptor);
    if (
      !directoryOpened.isDirectory()
      || !sameRuntimePackageDirectoryIdentity(directoryBefore, directoryOpened)
    ) return fail("CANDIDATE_EXACT_AUTHORIZATION_RUNTIME_PACKAGE_PARENT_CHANGED");

    const before = fs.lstatSync(input.filePath);
    if (
      fs.realpathSync(input.filePath) !== input.filePath
      || before.isSymbolicLink()
      || !before.isFile()
      || before.nlink !== 1
      || before.uid !== input.ownerUid
      || before.gid !== input.ownerGid
      || (before.mode & 0o7777) !== 0o600
      || before.size < 2
      || before.size > MAX_PACKAGE_BYTES
    ) return fail("CANDIDATE_EXACT_AUTHORIZATION_RUNTIME_PACKAGE_FILE_UNSAFE");
    descriptor = fs.openSync(
      input.filePath,
      fs.constants.O_RDONLY
        | (typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0),
    );
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || !sameRuntimePackageFileIdentity(before, opened)) {
      return fail("CANDIDATE_EXACT_AUTHORIZATION_RUNTIME_PACKAGE_FILE_CHANGED");
    }
    const bytes = fs.readFileSync(descriptor);
    const afterDescriptor = fs.fstatSync(descriptor);
    const afterPath = fs.lstatSync(input.filePath);
    const directoryAfter = fs.lstatSync(directory);
    if (
      !sameRuntimePackageFileIdentity(opened, afterDescriptor)
      || !sameRuntimePackageFileIdentity(opened, afterPath)
      || opened.mtimeMs !== afterDescriptor.mtimeMs
      || opened.ctimeMs !== afterDescriptor.ctimeMs
      || bytes.byteLength !== opened.size
      || !sameRuntimePackageDirectoryIdentity(directoryOpened, directoryAfter)
    ) return fail("CANDIDATE_EXACT_AUTHORIZATION_RUNTIME_PACKAGE_FILE_CHANGED");
    const identity = runtimePackageIdentity({
      canonicalPath: input.filePath,
      directory: directoryOpened,
      file: opened,
      fileDigest: candidateExactAuthorizationPackageFileDigest(bytes),
    });
    if (
      input.expectedIdentityBinding !== undefined
      && identity.identityBinding !== input.expectedIdentityBinding
    ) return fail("CANDIDATE_EXACT_AUTHORIZATION_RUNTIME_PACKAGE_IDENTITY_MISMATCH");
    return Object.freeze({ identity, bytes });
  } catch (error) {
    if (error instanceof CandidateExactAuthorizationV2Error) throw error;
    return fail("CANDIDATE_EXACT_AUTHORIZATION_RUNTIME_PACKAGE_READ_FAILED");
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    if (directoryDescriptor !== null) fs.closeSync(directoryDescriptor);
  }
}

export function inspectCandidateExactAuthorizationRuntimePackageSnapshot(
  input: Readonly<{
    filePath: string;
    ownerUid: number;
    ownerGid: number;
    expectedIdentityBinding?: string;
  }>,
): CandidateExactAuthorizationRuntimePackageIdentity {
  return readCandidateExactAuthorizationRuntimePackageSnapshot(input).identity;
}

function readProtectedPackageDescriptor(input: Readonly<{
  filePath: string;
  descriptor: number;
  ownerUid: number;
}>): { canonicalPath: string; bytes: Buffer } {
  if (
    !path.isAbsolute(input.filePath)
    || path.normalize(input.filePath) !== input.filePath
    || !Number.isSafeInteger(input.descriptor)
    || input.descriptor < 3
    || !Number.isSafeInteger(input.ownerUid)
    || input.ownerUid < 0
  ) return fail("CANDIDATE_EXACT_AUTHORIZATION_PACKAGE_FD_INVALID");
  try {
    const before = fs.fstatSync(input.descriptor);
    if (
      !before.isFile()
      || before.nlink !== 1
      || (before.mode & 0o777) !== 0o600
      || before.uid !== input.ownerUid
      || before.size < 2
      || before.size > MAX_PACKAGE_BYTES
    ) return fail("CANDIDATE_EXACT_AUTHORIZATION_PACKAGE_FD_UNSAFE");
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(
        input.descriptor,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (count <= 0) break;
      offset += count;
    }
    const after = fs.fstatSync(input.descriptor);
    if (
      offset !== bytes.length
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs
    ) return fail("CANDIDATE_EXACT_AUTHORIZATION_PACKAGE_FD_CHANGED");
    return { canonicalPath: input.filePath, bytes };
  } catch (error) {
    if (error instanceof CandidateExactAuthorizationV2Error) throw error;
    return fail("CANDIDATE_EXACT_AUTHORIZATION_PACKAGE_FD_READ_FAILED");
  } finally {
    // Ownership of the inherited descriptor transfers to this single consume.
    // Closing it prevents same-uid descendants from reopening /proc/$pid/fd/3
    // after the exact package bytes have been stabilized in memory.
    try {
      fs.closeSync(input.descriptor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EBADF") throw error;
    }
  }
}

export function consumeCandidateExactAuthorizationPackage(input: {
  packageFile: string;
  expectedPackageFileDigest: string;
  expectedCandidateKey: CandidateExactAuthorizationKey;
  expectedDriverScript: string;
  session: {
    apiBaseUrl: string;
    workspaceId: string;
    projectId: number;
    userId: number;
    createdAt: string;
    candidateIdentity?: ReleaseCandidateSessionIdentity;
  };
  environment?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  now?: number;
  inheritedPackage?: Readonly<{ descriptor: number; ownerUid: number }>;
  runtimePackage?: Readonly<{
    ownerUid: number;
    ownerGid: number;
    expectedIdentityBinding: string;
  }>;
}): CandidateExactAuthorizationConsumption {
  if (!isDigest(input.expectedPackageFileDigest)) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_PACKAGE_DIGEST_INVALID");
  }
  const expectedDriverScript = exactNonEmptyString(
    input.expectedDriverScript,
    "CANDIDATE_EXACT_AUTHORIZATION_DRIVER_SCRIPT_INVALID",
  );
  if (!SAFE_MANIFEST_PATH.test(expectedDriverScript)) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_DRIVER_SCRIPT_INVALID");
  }
  const inheritedFile = input.inheritedPackage
    ? readProtectedPackageDescriptor({
      filePath: input.packageFile,
      descriptor: input.inheritedPackage.descriptor,
      ownerUid: input.inheritedPackage.ownerUid,
    })
    : null;
  if (input.inheritedPackage && !input.runtimePackage) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_RUNTIME_PACKAGE_BINDING_REQUIRED");
  }
  const runtimeFile = input.runtimePackage
    ? readCandidateExactAuthorizationRuntimePackageSnapshot({
      filePath: input.packageFile,
      ownerUid: input.runtimePackage.ownerUid,
      ownerGid: input.runtimePackage.ownerGid,
      expectedIdentityBinding: input.runtimePackage.expectedIdentityBinding,
    })
    : null;
  if (
    inheritedFile
    && runtimeFile
    && (
      inheritedFile.bytes.byteLength !== runtimeFile.bytes.byteLength
      || !crypto.timingSafeEqual(inheritedFile.bytes, runtimeFile.bytes)
    )
  ) return fail("CANDIDATE_EXACT_AUTHORIZATION_ROOT_RUNTIME_PACKAGE_MISMATCH");
  const protectedFile = runtimeFile
    ? { canonicalPath: runtimeFile.identity.canonicalPath, bytes: runtimeFile.bytes }
    : inheritedFile ?? readProtectedPackageFile(input.packageFile);
  const runtimePackageIdentityBinding = runtimeFile?.identity.identityBinding ?? null;
  const packageFileDigest = candidateExactAuthorizationPackageFileDigest(
    protectedFile.bytes,
  );
  if (packageFileDigest !== input.expectedPackageFileDigest) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_PACKAGE_FILE_DIGEST_MISMATCH");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
      protectedFile.bytes,
    ));
  } catch {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_PACKAGE_JSON_INVALID");
  }
  const now = input.now ?? Date.now();
  const verified = verifyCandidateExactAuthorizationActivationPackage({
    value: parsed,
    environment: input.environment,
    now,
  });
  if (
    renderCandidateExactAuthorizationActivationPackage(verified)
      !== protectedFile.bytes.toString("utf8")
  ) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_PACKAGE_NON_CANONICAL");
  }
  if (!input.session.candidateIdentity) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_SESSION_IDENTITY_MISSING");
  }
  const correlationIdentity = parseReleaseCandidateSessionCorrelationIdentity(
    input.session.candidateIdentity,
  );
  const expectedSessionBinding = candidateExactAuthorizationSessionBinding(
    input.session,
  );
  const expectedWorkspaceBinding = candidateExactAuthorizationWorkspaceBinding(
    input.session.workspaceId,
  );
  if (
    verified.sessionBinding !== expectedSessionBinding
    || verified.workspaceBinding !== expectedWorkspaceBinding
    || verified.correlationIdentityDigest
      !== candidateExactAuthorizationCorrelationIdentityDigest(correlationIdentity)
    || !immutableArtifactIdentityMatches(
      correlationIdentity,
      verified.formalCandidateIdentity,
    )
    || verified.authorizationEvidence.formalProof.proof.runtimeDescriptor.apiBaseUrl
      !== input.session.apiBaseUrl
  ) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_DRIVER_SESSION_MISMATCH");
  }
  const entry = verified.entries.find(
    (candidate) => candidate.candidateKey === input.expectedCandidateKey,
  );
  if (!entry) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_DRIVER_ENTRY_MISSING");
  }
  if (entry.driverScript !== expectedDriverScript) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_DRIVER_SCRIPT_MISMATCH");
  }
  const { entryDigest, ...entryBody } = entry;
  if (entryDigest !== digest(entryBody)) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_DRIVER_ENTRY_TAMPERED");
  }
  const signedReceipt = verified.authorizationEvidence.signedReceipts.find(
    (candidate) => candidate.statement.candidateKey === input.expectedCandidateKey,
  );
  if (!signedReceipt) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_DRIVER_RECEIPT_MISSING");
  }
  const receiptBudget = signedReceipt.statement.receipt.budget;
  if (
    receiptBudget.availableScopeDigest
      !== entry.budgetAuthority.availableScopeDigest
    || receiptBudget.walletBinding !== verified.walletBinding
    || receiptBudget.workspaceBinding !== verified.workspaceBinding
  ) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_DRIVER_BUDGET_TAMPERED");
  }
  return Object.freeze({
    packageFile: protectedFile.canonicalPath,
    packageFileDigest,
    runtimePackageIdentityBinding,
    packageDigest: verified.packageDigest,
    candidateKey: input.expectedCandidateKey,
    driverScript: entry.driverScript,
    entryDigest,
    formalCandidateIdentityDigest: verified.formalCandidateIdentityDigest,
    sessionBinding: verified.sessionBinding,
    workspaceBinding: verified.workspaceBinding,
    walletBinding: verified.walletBinding,
    availableScopeDigest: receiptBudget.availableScopeDigest,
    availableMicros: receiptBudget.availableMicros,
    reservedMicros: 0,
    maximumCostMicros: receiptBudget.maximumCostMicros,
    capturedAt: verified.generatedAt,
    expiresAt: verified.expiresAt,
    runtimeDescriptor:
      verified.authorizationEvidence.formalProof.proof.runtimeDescriptor,
    batchDAbsorbedOperationKey:
      input.expectedCandidateKey === "full-matrix/mixed"
      && verified.batchD.mode === "absorbed-by-full-matrix-operation"
        ? verified.batchD.absorbedByOperationKey
        : null,
    operations: Object.freeze(entry.operations.map((operation) => Object.freeze({
      operationKey: operation.operationKey,
      endpointType: operation.endpointType,
      operationDigest: digest(operation),
      model: operation.model,
      provider: operation.provider,
      routeAlias: operation.routeAlias,
      maximumGuMicros: operation.maximumGuMicros,
      directoryEntryDigest: operation.directoryEntryDigest,
      routeEntryDigest: operation.routeEntryDigest,
      pricingEntryDigest: operation.pricingEntryDigest,
      parameterDigest: operation.parameterDigest,
      pricingComponentsDigest: digest(operation.pricingComponents),
      parameters: operation.parameters,
    }))),
  });
}

export async function revalidateCandidateExactAuthorizationLiveBindings(input: {
  authorization: CandidateExactAuthorizationConsumption;
  session: {
    apiBaseUrl: string;
    token: string;
    workspaceId: string;
    projectId: number;
    userId: number;
  };
  fetchImpl?: typeof fetch;
  now?: () => number;
  challengeNonce?: string;
}): Promise<CandidateExactAuthorizationLiveReadbackProof> {
  const now = input.now || Date.now;
  const startedAt = now();
  if (
    !Number.isFinite(startedAt)
    || startedAt < Date.parse(input.authorization.capturedAt)
    || startedAt >= Date.parse(input.authorization.expiresAt)
  ) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_LIVE_READBACK_EXPIRED");
  }
  const token = exactNonEmptyString(
    input.session.token,
    "CANDIDATE_EXACT_AUTHORIZATION_LIVE_READBACK_TOKEN_INVALID",
  );
  if (!token.startsWith("Bearer ") || token.length < 16) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_LIVE_READBACK_TOKEN_INVALID");
  }
  const apiBaseUrl = exactNonEmptyString(
    input.session.apiBaseUrl,
    "CANDIDATE_EXACT_AUTHORIZATION_LIVE_READBACK_SESSION_INVALID",
  ).replace(/\/+$/, "");
  const projectId = safePositiveInteger(
    input.session.projectId,
    "CANDIDATE_EXACT_AUTHORIZATION_LIVE_READBACK_SESSION_INVALID",
  );
  if (
    input.authorization.runtimeDescriptor.apiBaseUrl !== apiBaseUrl
    || input.authorization.workspaceBinding
      !== candidateExactAuthorizationWorkspaceBinding(input.session.workspaceId)
  ) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_LIVE_READBACK_SESSION_INVALID");
  }
  const operationsEndpointPath =
    CANDIDATE_EXACT_AUTHORIZATION_LIVE_READBACK_ENDPOINTS[
      input.authorization.candidateKey
    ];
  const operationsEndpoint = new URL(
    operationsEndpointPath,
    `${apiBaseUrl}/`,
  );
  if (
    operationsEndpoint.toString()
      !== `${apiBaseUrl}/${operationsEndpointPath}`
  ) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_OPERATIONS_ENDPOINT_INVALID");
  }
  const fetchImpl = input.fetchImpl || fetch;
  const captureRequestBody = Object.freeze({
    candidateKey: input.authorization.candidateKey,
    projectId,
    capturedAt: input.authorization.capturedAt,
    expiresAt: input.authorization.expiresAt,
    zeroPaidQuoteOnly: true,
  });
  const readCapture = async () => {
    let response: Response;
    try {
      response = await fetchImpl(operationsEndpoint, {
        method: "POST",
        redirect: "manual",
        headers: {
          accept: "application/json",
          authorization: token,
          "content-type": "application/json",
        },
        body: JSON.stringify(captureRequestBody),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      if (error instanceof CandidateExactAuthorizationV2Error) throw error;
      return fail("CANDIDATE_EXACT_AUTHORIZATION_LIVE_READBACK_FAILED");
    }
    if (response.status !== 200) {
      await response.arrayBuffer().catch(() => undefined);
      return fail("CANDIDATE_EXACT_AUTHORIZATION_OPERATIONS_READBACK_FAILED");
    }
    const responseBody = await response.text();
    if (Buffer.byteLength(responseBody, "utf8") > MAX_LIVE_READBACK_BYTES) {
      return fail("CANDIDATE_EXACT_AUTHORIZATION_OPERATIONS_READBACK_TOO_LARGE");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(responseBody);
    } catch {
      return fail("CANDIDATE_EXACT_AUTHORIZATION_OPERATIONS_READBACK_INVALID");
    }
    if (
      !isRecord(parsed)
      || !isRecord(parsed.data)
      || !exactKeys(parsed.data, [
        "batchDAbsorption",
        "billingReadback",
        "receipt",
      ])
    ) {
      return fail("CANDIDATE_EXACT_AUTHORIZATION_OPERATIONS_READBACK_INVALID");
    }
    return verifyCandidateExactAuthorizationLiveCaptureReadback({
      authorization: input.authorization,
      receipt: parsed.data.receipt,
      billingReadback: parsed.data.billingReadback,
      now: startedAt,
      expectedBillingIdentity: {
        workspaceId: input.session.workspaceId,
        sessionUserId: input.session.userId,
      },
    });
  };
  const firstCapture = await readCapture();
  const secondCapture = await readCapture();
  if (!sameCanonical(firstCapture, secondCapture)) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_LIVE_READBACK_CAPTURE_DRIFTED");
  }
  const checkedAtMs = now();
  if (
    !Number.isFinite(checkedAtMs)
    || checkedAtMs < startedAt
    || checkedAtMs >= Date.parse(input.authorization.expiresAt)
  ) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_LIVE_READBACK_EXPIRED");
  }
  const checkedAt = new Date(checkedAtMs).toISOString();
  const challengeNonce = input.challengeNonce
    ?? crypto.randomBytes(32).toString("base64url");
  const runtimeChallenge = candidateExactAuthorizationLiveReadbackChallenge({
    authorization: input.authorization,
    checkedAt,
    challengeNonce,
    captureReadbackDigest: secondCapture.readbackDigest,
  });
  let runtimeChallengeResponse: CandidateRuntimeChallengeResponse;
  try {
    runtimeChallengeResponse = await probeCandidateRuntimeAuthority({
      descriptor: input.authorization.runtimeDescriptor,
      token,
      fetchImpl,
      challenge: runtimeChallenge,
    });
  } catch (error) {
    if (error instanceof CandidateExactAuthorizationV2Error) throw error;
    return fail("CANDIDATE_EXACT_AUTHORIZATION_LIVE_READBACK_FAILED");
  }
  const completedAt = now();
  if (
    !Number.isFinite(completedAt)
    || completedAt < checkedAtMs
    || completedAt >= Date.parse(input.authorization.expiresAt)
  ) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_LIVE_READBACK_EXPIRED");
  }
  return sealCandidateExactAuthorizationLiveReadbackProof({
    authorization: input.authorization,
    captureReadback: secondCapture,
    checkedAt,
    challengeNonce,
    runtimeChallengeResponse,
    now: completedAt,
  });
}

export function parseCandidateExactAuthorizationCliBinding(
  args: readonly string[],
): CandidateExactAuthorizationCliBinding {
  let packageFile: string | null = null;
  let packageFileDigest: string | null = null;
  let packageFileIdentityBinding: string | null = null;
  const remainingArgs: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (
      argument !== CANDIDATE_EXACT_AUTHORIZATION_PACKAGE_FILE_FLAG
      && argument !== CANDIDATE_EXACT_AUTHORIZATION_PACKAGE_DIGEST_FLAG
      && argument !== CANDIDATE_EXACT_AUTHORIZATION_PACKAGE_IDENTITY_FLAG
    ) {
      remainingArgs.push(argument);
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      return fail("CANDIDATE_EXACT_AUTHORIZATION_PACKAGE_ARGUMENT_VALUE_REQUIRED");
    }
    if (argument === CANDIDATE_EXACT_AUTHORIZATION_PACKAGE_FILE_FLAG) {
      if (packageFile !== null) {
        return fail("CANDIDATE_EXACT_AUTHORIZATION_PACKAGE_ARGUMENT_DUPLICATE");
      }
      if (!path.isAbsolute(value) || path.normalize(value) !== value) {
        return fail("CANDIDATE_EXACT_AUTHORIZATION_PACKAGE_PATH_INVALID");
      }
      packageFile = value;
    } else if (argument === CANDIDATE_EXACT_AUTHORIZATION_PACKAGE_DIGEST_FLAG) {
      if (packageFileDigest !== null) {
        return fail("CANDIDATE_EXACT_AUTHORIZATION_PACKAGE_ARGUMENT_DUPLICATE");
      }
      if (!isDigest(value)) {
        return fail("CANDIDATE_EXACT_AUTHORIZATION_PACKAGE_DIGEST_INVALID");
      }
      packageFileDigest = value;
    } else {
      if (packageFileIdentityBinding !== null) {
        return fail("CANDIDATE_EXACT_AUTHORIZATION_PACKAGE_ARGUMENT_DUPLICATE");
      }
      if (!SHA256_BINDING.test(value)) {
        return fail("CANDIDATE_EXACT_AUTHORIZATION_RUNTIME_PACKAGE_IDENTITY_INVALID");
      }
      packageFileIdentityBinding = value;
    }
    index += 1;
  }
  if ((packageFile === null) !== (packageFileDigest === null)) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_PACKAGE_ARGUMENT_INCOMPLETE");
  }
  if (packageFileIdentityBinding !== null && packageFile === null) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_PACKAGE_ARGUMENT_INCOMPLETE");
  }
  return Object.freeze({
    remainingArgs,
    packageFile,
    packageFileDigest,
    packageFileIdentityBinding,
  });
}

export function requireCandidateExactAuthorizationCliBinding(
  binding: CandidateExactAuthorizationCliBinding,
): {
  packageFile: string;
  packageFileDigest: string;
  packageFileIdentityBinding: string | null;
} {
  if (!binding.packageFile || !binding.packageFileDigest) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_PACKAGE_REQUIRED");
  }
  return {
    packageFile: binding.packageFile,
    packageFileDigest: binding.packageFileDigest,
    packageFileIdentityBinding: binding.packageFileIdentityBinding,
  };
}

export function candidateExactAuthorizationGuardBinding(
  authorization: CandidateExactAuthorizationConsumption,
): CandidateExactAuthorizationGuardBinding {
  return Object.freeze({
    packageFilePathBinding: `sha256:${sha256([
      FILE_PATH_BINDING_DOMAIN,
      authorization.packageFile,
    ].join("\0"))}`,
    packageFileDigest: authorization.packageFileDigest,
    packageDigest: authorization.packageDigest,
    candidateKey: authorization.candidateKey,
    driverScript: authorization.driverScript,
    entryDigest: authorization.entryDigest,
    formalCandidateIdentityDigest: authorization.formalCandidateIdentityDigest,
    sessionBinding: authorization.sessionBinding,
    workspaceBinding: authorization.workspaceBinding,
    walletBinding: authorization.walletBinding,
    expiresAt: authorization.expiresAt,
  });
}

function assertLiveReadbackProof(input: {
  value: unknown;
  authorization: CandidateExactAuthorizationConsumption;
  now: number;
}): CandidateExactAuthorizationLiveReadbackProof {
  if (!isRecord(input.value) || !exactKeys(input.value, [
    "availableMicros",
    "availableScopeDigest",
    "billingReadbackDigest",
    "captureReadback",
    "challengeNonce",
    "checkedAt",
    "format",
    "operationsReadbackDigest",
    "proofDigest",
    "reservedMicros",
    "runtimeChallenge",
    "runtimeChallengeResponse",
    "runtimeChallengeResponseDigest",
    "walletBinding",
  ]) || !isRecord(input.value.captureReadback) || !exactKeys(
    input.value.captureReadback,
    ["billingReadback", "readbackDigest", "receipt"],
  )) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_LIVE_READBACK_PROOF_INVALID");
  }
  const value = input.value as unknown as
    CandidateExactAuthorizationLiveReadbackProof;
  try {
    const verified = sealCandidateExactAuthorizationLiveReadbackProof({
      authorization: input.authorization,
      captureReadback: value.captureReadback,
      checkedAt: value.checkedAt,
      challengeNonce: value.challengeNonce,
      runtimeChallengeResponse: value.runtimeChallengeResponse,
      now: input.now,
    });
    if (!sameCanonical(verified, value)) {
      return fail("CANDIDATE_EXACT_AUTHORIZATION_LIVE_READBACK_PROOF_INVALID");
    }
    return verified;
  } catch {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_LIVE_READBACK_PROOF_INVALID");
  }
}

export function sealCandidateExactAuthorizationGuardPayload(
  driver: Record<string, unknown>,
  authorization: CandidateExactAuthorizationConsumption,
  liveReadback: CandidateExactAuthorizationLiveReadbackProof,
  createdAt: string = new Date().toISOString(),
): Record<string, unknown> {
  const createdAtValue = exactIso(
    createdAt,
    "CANDIDATE_EXACT_AUTHORIZATION_GUARD_TIME_INVALID",
  );
  const createdAtMs = Date.parse(createdAtValue);
  const verifiedLiveReadback = assertLiveReadbackProof({
    value: liveReadback,
    authorization,
    now: createdAtMs,
  });
  if (
    createdAtMs < Date.parse(authorization.capturedAt)
    || createdAtMs >= Date.parse(authorization.expiresAt)
  ) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_GUARD_TIME_INVALID");
  }
  const body = {
    format: CANDIDATE_EXACT_AUTHORIZATION_GUARD_FORMAT,
    createdAt: createdAtValue,
    driver,
    authorization: candidateExactAuthorizationGuardBinding(authorization),
    liveReadback: verifiedLiveReadback,
  };
  return { ...body, guardDigest: digest(body) };
}

export function assertCandidateExactAuthorizationGuardPayload(input: {
  value: unknown;
  authorization: CandidateExactAuthorizationConsumption;
  expectedDriver: Record<string, unknown>;
  expectedLiveReadback?: CandidateExactAuthorizationLiveReadbackProof;
  now?: number;
}): void {
  if (!isRecord(input.value) || !exactKeys(input.value, [
    "authorization",
    "createdAt",
    "driver",
    "format",
    "guardDigest",
    "liveReadback",
  ])) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_GUARD_INVALID");
  }
  const { guardDigest, ...body } = input.value;
  const now = input.now ?? Date.now();
  const createdAt = Date.parse(exactIso(
    input.value.createdAt,
    "CANDIDATE_EXACT_AUTHORIZATION_GUARD_TIME_INVALID",
  ));
  const liveReadback = assertLiveReadbackProof({
    value: input.value.liveReadback,
    authorization: input.authorization,
    now,
  });
  if (
    input.value.format !== CANDIDATE_EXACT_AUTHORIZATION_GUARD_FORMAT
    || !isDigest(guardDigest)
    || guardDigest !== digest(body)
    || !sameCanonical(input.value.driver, input.expectedDriver)
    || !sameCanonical(
      input.value.authorization,
      candidateExactAuthorizationGuardBinding(input.authorization),
    )
    || (
      input.expectedLiveReadback
      && !sameCanonical(liveReadback, input.expectedLiveReadback)
    )
    || createdAt < Date.parse(liveReadback.checkedAt)
    || createdAt >= Date.parse(input.authorization.expiresAt)
    || now < createdAt
    || now >= Date.parse(input.authorization.expiresAt)
  ) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_GUARD_TAMPERED");
  }
}

function readProtectedGuardFile(filePath: string): {
  canonicalPath: string;
  bytes: Buffer;
  stat: fs.Stats;
} {
  if (!path.isAbsolute(filePath) || path.normalize(filePath) !== filePath) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_GUARD_PATH_INVALID");
  }
  let descriptor: number | null = null;
  try {
    const before = fs.lstatSync(filePath);
    const canonicalPath = fs.realpathSync(filePath);
    if (
      canonicalPath !== filePath
      || before.isSymbolicLink()
      || !before.isFile()
      || before.nlink !== 1
      || (before.mode & 0o777) !== 0o600
      || before.size < 2
      || before.size > CANDIDATE_EXACT_AUTHORIZATION_GUARD_MAX_BYTES
      || (typeof process.getuid === "function" && before.uid !== process.getuid())
    ) {
      return fail("CANDIDATE_EXACT_AUTHORIZATION_GUARD_FILE_UNSAFE");
    }
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY
        | (typeof fs.constants.O_NOFOLLOW === "number"
          ? fs.constants.O_NOFOLLOW
          : 0),
    );
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isFile()
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size !== before.size
    ) {
      return fail("CANDIDATE_EXACT_AUTHORIZATION_GUARD_FILE_CHANGED");
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (
      after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs
      || bytes.byteLength !== opened.size
    ) {
      return fail("CANDIDATE_EXACT_AUTHORIZATION_GUARD_FILE_CHANGED");
    }
    return { canonicalPath, bytes, stat: after };
  } catch (error) {
    if (error instanceof CandidateExactAuthorizationV2Error) throw error;
    return fail("CANDIDATE_EXACT_AUTHORIZATION_GUARD_READ_FAILED");
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

/**
 * Candidate E may consume the one image operation named by the already
 * verified full-matrix receipt only after the real O_EXCL paid guard exists.
 */
export function candidateExactAuthorizationAbsorbedImageOperationProof(input: {
  authorization: CandidateExactAuthorizationConsumption;
  operationKey: string;
  guardFile: string;
  expectedDriver: Record<string, unknown>;
  now?: number;
}): CandidateExactAuthorizationAbsorbedOperationProof {
  const { authorization, operationKey } = input;
  if (
    authorization.candidateKey !== "full-matrix/mixed"
    || authorization.batchDAbsorbedOperationKey !== operationKey
  ) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_ABSORBED_ENTRY_INVALID");
  }
  const operation = authorization.operations.find(
    (candidate) => candidate.operationKey === operationKey,
  );
  if (!operation || operation.endpointType !== "image_generation") {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_ABSORBED_OPERATION_INVALID");
  }
  const protectedGuard = readProtectedGuardFile(input.guardFile);
  let guard: unknown;
  try {
    guard = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
      protectedGuard.bytes,
    ));
  } catch {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_GUARD_INVALID");
  }
  assertCandidateExactAuthorizationGuardPayload({
    value: guard,
    authorization,
    expectedDriver: input.expectedDriver,
    now: input.now,
  });
  if (!isRecord(guard) || !isDigest(guard.guardDigest)) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_GUARD_INVALID");
  }
  const guardFilePathBinding = `sha256:${sha256([
    GUARD_FILE_BINDING_DOMAIN,
    protectedGuard.canonicalPath,
  ].join("\0"))}`;
  const guardFileDigest = candidateExactAuthorizationPackageFileDigest(
    protectedGuard.bytes,
  );
  const guardInodeBinding = `sha256:${sha256([
    GUARD_FILE_BINDING_DOMAIN,
    String(protectedGuard.stat.dev),
    String(protectedGuard.stat.ino),
    String(protectedGuard.stat.size),
  ].join("\0"))}`;
  const body = {
    candidateKey: "full-matrix/mixed" as const,
    packageDigest: authorization.packageDigest,
    entryDigest: authorization.entryDigest,
    operationKey,
    operationDigest: operation.operationDigest,
    guardFile: protectedGuard.canonicalPath,
    guardFilePathBinding,
    guardFileDigest,
    guardInodeBinding,
    guardDigest: guard.guardDigest,
    sessionBinding: authorization.sessionBinding,
  };
  return Object.freeze({
    ...body,
    guardConsumptionProofDigest: digest(body),
  });
}
