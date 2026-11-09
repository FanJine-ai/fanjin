import crypto from "node:crypto";

export const CANDIDATE_EXACT_AUTHORIZATION_RECEIPT_VERSION =
  "fanjin-candidate-exact-authorization-receipt/v1" as const;

export const CANDIDATE_EXACT_AUTHORIZATION_CAPTURE_LIFETIME_MS =
  4 * 60 * 1_000;

export type CandidateExactAuthorizationKey =
  | "quick/720p"
  | "quick/1080p"
  | "canvas/720p"
  | "canvas/1080p"
  | "agent/720p"
  | "agent/1080p"
  | "full-matrix/mixed";

export type CandidateExactAuthorizationEndpointType =
  | "text"
  | "image_generation"
  | "video_generation";

export type CandidateExactAuthorizationMedia = Readonly<{
  kind: "image" | "video";
  mode: string | null;
  resolution: "720p" | "1080p" | null;
  ratio: string;
  quality: string | null;
  durationSeconds: number | null;
  generateAudio: boolean | null;
  count: number;
  ffprobeRequired: boolean;
  selfFfprobe: boolean;
}>;

export type CandidateExactAuthorizationPricingComponent = Readonly<{
  component: string;
  unit: string;
  maximumUnits: number;
  unitPriceMicros: number;
  maximumCostMicros: number;
}>;

export type CandidateExactAuthorizationCanonicalOperation = Readonly<{
  key: string;
  endpointType: CandidateExactAuthorizationEndpointType;
  model: string;
  provider: string;
  routeAlias: string;
  chargedCallCeiling: number;
  maximumCostMicros: number;
  directoryEntryDigest: string;
  routeEntryDigest: string;
  pricingEntryDigest: string;
  parameterDigest: string;
  pricingComponents: readonly CandidateExactAuthorizationPricingComponent[];
  media: CandidateExactAuthorizationMedia | null;
}>;

export const FORMAL_CANDIDATE_PRELAUNCH_SESSION_EVIDENCE_CLASS =
  "formal-production-prelaunch-trust-bound" as const;

export type CandidateExactAuthorizationSessionIdentity = Readonly<{
  format: "fanjin-release-candidate-session-identity/v1";
  evidenceClass:
    | "dev-local-only-contract-fixture"
    | typeof FORMAL_CANDIDATE_PRELAUNCH_SESSION_EVIDENCE_CLASS;
  formalB0Eligible: false;
  runtimeArtifactBindingVerified: false;
  freezeReceiptDigest: string;
  freezeSha256: string;
  releaseUuid: string;
  artifactUuid: string;
  artifactSha256: string;
  artifactSignedManifestSha256: string;
  sourceDigest: string;
  configExpectedSha256: string;
  schemaExpectedSha256: string;
  attestationKeyId: string;
}>;

export type CandidateExactAuthorizationRuntimeSession = Readonly<{
  workspaceId: string;
  projectId: number;
  userId: number;
  createdAt: string;
  candidateIdentity: CandidateExactAuthorizationSessionIdentity;
}>;

export type CandidateExactAuthorizationBillingReadback = Readonly<{
  workspaceId: string;
  sessionUserId: number;
  account: Readonly<{
    id: string;
    workspaceId: string;
    currency: "GU";
    availableMicros: number;
    reservedMicros: 0;
    status: "active";
  }>;
  accountWallet: Readonly<{
    id: string;
    userId: number;
    ownerUserId: number;
    currency: "GU";
    totalAvailableMicros: number;
    status: "active";
    defaultWorkspaceId: string | null;
  }>;
}>;

export type CandidateExactAuthorizationReceipt = Readonly<{
  format: typeof CANDIDATE_EXACT_AUTHORIZATION_RECEIPT_VERSION;
  candidateKey: CandidateExactAuthorizationKey;
  candidateIdentity: CandidateExactAuthorizationSessionIdentity;
  sessionBinding: string;
  quoteSource: "quote" | "preflight";
  capturedAt: string;
  expiresAt: string;
  directoryDigest: string;
  routeDigest: string;
  pricingDigest: string;
  quoteDigest: string;
  budget: Readonly<{
    currency: "GU";
    workspaceBinding: string;
    walletBinding: string;
    availableScopeDigest: string;
    maximumCostMicros: number;
    availableMicros: number;
    reservedMicros: 0;
  }>;
  operations: readonly CandidateExactAuthorizationCanonicalOperation[];
  receiptDigest: string;
}>;

export class CandidateExactAuthorizationCanonicalError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "CandidateExactAuthorizationCanonicalError";
    this.code = code;
  }
}

const SESSION_BINDING_DOMAIN =
  "fanjin-candidate-exact-authorization/session/v2";
const WORKSPACE_BINDING_DOMAIN =
  "fanjin-candidate-exact-authorization/workspace/v2";
const WALLET_BINDING_DOMAIN =
  "fanjin-candidate-exact-authorization/wallet/v2";
const AVAILABLE_SCOPE_DOMAIN =
  "fanjin-candidate-exact-authorization/available-scope/v2";
const SHA256_HEX = /^[a-f0-9]{64}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SOURCE_DIGEST = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function fail(code: string): never {
  throw new CandidateExactAuthorizationCanonicalError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length
    && actual.every((key, index) => key === sorted[index]);
}

export function candidateExactAuthorizationCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(candidateExactAuthorizationCanonicalJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => (
        `${JSON.stringify(key)}:${candidateExactAuthorizationCanonicalJson(child)}`
      ))
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) return fail("CANDIDATE_EXACT_AUTHORIZATION_VALUE_INVALID");
  return encoded;
}

export function candidateExactAuthorizationDigest(value: unknown): string {
  return `sha256:${crypto.createHash("sha256")
    .update(candidateExactAuthorizationCanonicalJson(value))
    .digest("hex")}`;
}

function rawBinding(parts: readonly string[]): string {
  return `sha256:${crypto.createHash("sha256")
    .update(parts.join("\0"))
    .digest("hex")}`;
}

export function parseCandidateExactAuthorizationSessionIdentity(
  value: unknown,
): CandidateExactAuthorizationSessionIdentity {
  if (!isRecord(value) || !exactKeys(value, [
    "artifactSha256",
    "artifactSignedManifestSha256",
    "artifactUuid",
    "attestationKeyId",
    "configExpectedSha256",
    "evidenceClass",
    "format",
    "formalB0Eligible",
    "freezeReceiptDigest",
    "freezeSha256",
    "releaseUuid",
    "runtimeArtifactBindingVerified",
    "schemaExpectedSha256",
    "sourceDigest",
  ])) return fail("CANDIDATE_EXACT_AUTHORIZATION_IDENTITY_INVALID");
  const attestationKeyId = String(value.attestationKeyId || "");
  if (
    value.format !== "fanjin-release-candidate-session-identity/v1"
    || value.evidenceClass !== "dev-local-only-contract-fixture"
    || value.formalB0Eligible !== false
    || value.runtimeArtifactBindingVerified !== false
    || !attestationKeyId.startsWith("dev-local-only-")
    || !SHA256_HEX.test(String(value.freezeReceiptDigest || ""))
    || !SHA256_HEX.test(String(value.freezeSha256 || ""))
    || !UUID.test(String(value.releaseUuid || ""))
    || !UUID.test(String(value.artifactUuid || ""))
    || !SHA256_HEX.test(String(value.artifactSha256 || ""))
    || !SHA256_HEX.test(String(value.artifactSignedManifestSha256 || ""))
    || !SOURCE_DIGEST.test(String(value.sourceDigest || ""))
    || !SHA256_HEX.test(String(value.configExpectedSha256 || ""))
    || !SHA256_HEX.test(String(value.schemaExpectedSha256 || ""))
    || !KEY_ID.test(attestationKeyId)
  ) return fail("CANDIDATE_EXACT_AUTHORIZATION_IDENTITY_INVALID");
  return Object.freeze(value as unknown as CandidateExactAuthorizationSessionIdentity);
}

export function parseFormalCandidatePrelaunchSessionIdentity(
  value: unknown,
): CandidateExactAuthorizationSessionIdentity {
  if (!isRecord(value) || !exactKeys(value, [
    "artifactSha256",
    "artifactSignedManifestSha256",
    "artifactUuid",
    "attestationKeyId",
    "configExpectedSha256",
    "evidenceClass",
    "format",
    "formalB0Eligible",
    "freezeReceiptDigest",
    "freezeSha256",
    "releaseUuid",
    "runtimeArtifactBindingVerified",
    "schemaExpectedSha256",
    "sourceDigest",
  ])) return fail("CANDIDATE_EXACT_AUTHORIZATION_FORMAL_IDENTITY_INVALID");
  const attestationKeyId = String(value.attestationKeyId || "");
  if (
    value.format !== "fanjin-release-candidate-session-identity/v1"
    || value.evidenceClass !== FORMAL_CANDIDATE_PRELAUNCH_SESSION_EVIDENCE_CLASS
    || value.formalB0Eligible !== false
    || value.runtimeArtifactBindingVerified !== false
    || attestationKeyId.startsWith("dev-local-only-")
    || !SHA256_HEX.test(String(value.freezeReceiptDigest || ""))
    || !SHA256_HEX.test(String(value.freezeSha256 || ""))
    || !UUID.test(String(value.releaseUuid || ""))
    || !UUID.test(String(value.artifactUuid || ""))
    || !SHA256_HEX.test(String(value.artifactSha256 || ""))
    || !SHA256_HEX.test(String(value.artifactSignedManifestSha256 || ""))
    || !SOURCE_DIGEST.test(String(value.sourceDigest || ""))
    || !SHA256_HEX.test(String(value.configExpectedSha256 || ""))
    || !SHA256_HEX.test(String(value.schemaExpectedSha256 || ""))
    || !KEY_ID.test(attestationKeyId)
  ) return fail("CANDIDATE_EXACT_AUTHORIZATION_FORMAL_IDENTITY_INVALID");
  return Object.freeze(value as unknown as CandidateExactAuthorizationSessionIdentity);
}

export function parseCandidateExactAuthorizationCorrelationIdentity(
  value: unknown,
): CandidateExactAuthorizationSessionIdentity {
  if (
    isRecord(value)
    && value.evidenceClass === FORMAL_CANDIDATE_PRELAUNCH_SESSION_EVIDENCE_CLASS
  ) return parseFormalCandidatePrelaunchSessionIdentity(value);
  return parseCandidateExactAuthorizationSessionIdentity(value);
}

function exactIso(value: unknown): string {
  if (typeof value !== "string" || value !== value.trim()) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_SESSION_INVALID");
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_SESSION_INVALID");
  }
  return value;
}

export function candidateExactAuthorizationSessionBinding(
  session: CandidateExactAuthorizationRuntimeSession,
): string {
  if (
    typeof session.workspaceId !== "string"
    || !session.workspaceId
    || session.workspaceId !== session.workspaceId.trim()
    || !Number.isSafeInteger(session.projectId)
    || session.projectId <= 0
    || !Number.isSafeInteger(session.userId)
    || session.userId <= 0
  ) return fail("CANDIDATE_EXACT_AUTHORIZATION_SESSION_INVALID");
  const identity = parseCandidateExactAuthorizationCorrelationIdentity(
    session.candidateIdentity,
  );
  return rawBinding([
    SESSION_BINDING_DOMAIN,
    session.workspaceId,
    String(session.projectId),
    String(session.userId),
    exactIso(session.createdAt),
    candidateExactAuthorizationCanonicalJson(identity),
  ]);
}

export function candidateExactAuthorizationWorkspaceBinding(
  workspaceId: string,
): string {
  if (!workspaceId || workspaceId !== workspaceId.trim()) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_WORKSPACE_INVALID");
  }
  return rawBinding([
    WORKSPACE_BINDING_DOMAIN,
    workspaceId,
  ]);
}

export function candidateExactAuthorizationWalletBinding(
  readback: CandidateExactAuthorizationBillingReadback,
): string {
  return rawBinding([
    WALLET_BINDING_DOMAIN,
    candidateExactAuthorizationCanonicalJson({
      workspaceId: readback.workspaceId,
      sessionUserId: readback.sessionUserId,
      account: {
        id: readback.account.id,
        workspaceId: readback.account.workspaceId,
        currency: readback.account.currency,
      },
      accountWallet: {
        id: readback.accountWallet.id,
        userId: readback.accountWallet.userId,
        ownerUserId: readback.accountWallet.ownerUserId,
        currency: readback.accountWallet.currency,
        defaultWorkspaceId: readback.accountWallet.defaultWorkspaceId,
      },
    }),
  ]);
}

export function candidateExactAuthorizationAvailableScopeDigest(
  readback: CandidateExactAuthorizationBillingReadback,
): string {
  return rawBinding([
    AVAILABLE_SCOPE_DOMAIN,
    candidateExactAuthorizationCanonicalJson({
      walletBinding: candidateExactAuthorizationWalletBinding(readback),
      workspaceId: readback.workspaceId,
      accountId: readback.account.id,
      walletId: readback.accountWallet.id,
      accountStatus: readback.account.status,
      walletStatus: readback.accountWallet.status,
      availableMicros: readback.account.availableMicros,
      reservedMicros: readback.account.reservedMicros,
      walletTotalAvailableMicros:
        readback.accountWallet.totalAvailableMicros,
    }),
  ]);
}

export function sealCandidateExactAuthorizationReceipt(
  body: Omit<CandidateExactAuthorizationReceipt, "receiptDigest">,
): CandidateExactAuthorizationReceipt {
  return Object.freeze({
    ...body,
    receiptDigest: candidateExactAuthorizationDigest(body),
  });
}

export function buildCandidateExactAuthorizationCanonicalOperation(input: {
  key: string;
  endpointType: CandidateExactAuthorizationEndpointType;
  model: string;
  provider: string;
  routeAlias: string;
  chargedCallCeiling: number;
  directoryEntry: Record<string, unknown>;
  routeEntry: Record<string, unknown>;
  pricingEntry: Record<string, unknown>;
  pricingComponents: readonly CandidateExactAuthorizationPricingComponent[];
  media: CandidateExactAuthorizationMedia | null;
}): CandidateExactAuthorizationCanonicalOperation {
  const maximumCostMicros = input.pricingComponents.reduce(
    (total, component) => total + component.maximumCostMicros,
    0,
  );
  if (
    !input.key
    || !input.model
    || !input.provider
    || !input.routeAlias
    || !Number.isSafeInteger(input.chargedCallCeiling)
    || input.chargedCallCeiling <= 0
    || !input.pricingComponents.length
    || input.pricingComponents.some((component) => (
      !component.component
      || !component.unit
      || !Number.isSafeInteger(component.maximumUnits)
      || component.maximumUnits <= 0
      || !Number.isSafeInteger(component.unitPriceMicros)
      || component.unitPriceMicros <= 0
      || !Number.isSafeInteger(component.maximumCostMicros)
      || component.maximumCostMicros <= 0
      || !Number.isSafeInteger(
        component.maximumUnits * component.unitPriceMicros,
      )
      || component.maximumUnits * component.unitPriceMicros
        !== component.maximumCostMicros
    ))
    || !Number.isSafeInteger(maximumCostMicros)
    || maximumCostMicros <= 0
  ) return fail("CANDIDATE_EXACT_AUTHORIZATION_OPERATION_INVALID");
  return Object.freeze({
    key: input.key,
    endpointType: input.endpointType,
    model: input.model,
    provider: input.provider,
    routeAlias: input.routeAlias,
    chargedCallCeiling: input.chargedCallCeiling,
    maximumCostMicros,
    directoryEntryDigest: candidateExactAuthorizationDigest(
      input.directoryEntry,
    ),
    routeEntryDigest: candidateExactAuthorizationDigest(input.routeEntry),
    pricingEntryDigest: candidateExactAuthorizationDigest(input.pricingEntry),
    parameterDigest: candidateExactAuthorizationDigest(input.media),
    pricingComponents: Object.freeze([...input.pricingComponents]),
    media: input.media,
  });
}
