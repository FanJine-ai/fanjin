import { guStringFromMicros } from "../../src/lib/billingUnits";
import crypto from "node:crypto";

import {
  parseReleaseCandidateSessionCorrelationIdentity,
  type ReleaseCandidateSessionIdentity,
} from "./release-candidate-session-identity";

export const CANDIDATE_EXACT_AUTHORIZATION_ANCHOR_VERSION =
  "fanjin-candidate-exact-authorization-anchor/v1" as const;
export const CANDIDATE_EXACT_AUTHORIZATION_RECEIPT_VERSION =
  "fanjin-candidate-exact-authorization-receipt/v1" as const;
export const CANDIDATE_EXACT_AUTHORIZATION_PACKAGE_VERSION =
  "fanjin-candidate-exact-authorization-package/v1" as const;

const SHA256_BINDING = /^sha256:[a-f0-9]{64}$/;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;

export type CandidateExactAuthorizationKey =
  | "quick/720p"
  | "quick/1080p"
  | "canvas/720p"
  | "canvas/1080p"
  | "agent/720p"
  | "agent/1080p"
  | "full-matrix/mixed";

export type CandidateExactAuthorizationMode =
  | "quick"
  | "canvas"
  | "agent"
  | "full-matrix";

export type CandidateExactAuthorizationResolution =
  | "720p"
  | "1080p"
  | "mixed";

type EndpointType = "text" | "image_generation" | "video_generation";

type DriverControl = Readonly<{
  key: CandidateExactAuthorizationKey;
  mode: CandidateExactAuthorizationMode;
  resolution: CandidateExactAuthorizationResolution;
  driverScript: string;
  paidFlag: string;
  acknowledgementEnvironment: string;
  acknowledgementValue: string;
  irreversibleGuardSuffix: string;
  exactUpstreamCallCeiling: number;
  exactChargedCallCeiling: number;
  chargedShape: Readonly<Record<EndpointType, number>>;
}>;

/**
 * Price-independent execution controls mirrored from the four candidate
 * drivers. No GU value belongs here: GU authority must come from a fresh,
 * session-bound quote/preflight receipt.
 */
export const CANDIDATE_EXACT_AUTHORIZATION_DRIVER_CONTROLS = Object.freeze({
  "quick/720p": Object.freeze({
    key: "quick/720p",
    mode: "quick",
    resolution: "720p",
    driverScript: "scripts/verify-workbench-real-candidate.ts",
    paidFlag: "--paid-minimal",
    acknowledgementEnvironment: "FANJIN_REAL_CANDIDATE_PAID_ACK",
    acknowledgementValue:
      "I_ACCEPT_EXACTLY_3_REAL_UPSTREAM_REQUESTS_TEXT_IMAGE_720P",
    irreversibleGuardSuffix: ".paid-minimal.started",
    exactUpstreamCallCeiling: 3,
    exactChargedCallCeiling: 3,
    chargedShape: Object.freeze({
      text: 1,
      image_generation: 1,
      video_generation: 1,
    }),
  }),
  "quick/1080p": Object.freeze({
    key: "quick/1080p",
    mode: "quick",
    resolution: "1080p",
    driverScript: "scripts/verify-workbench-real-candidate.ts",
    paidFlag: "--paid-minimal-1080p",
    acknowledgementEnvironment: "FANJIN_REAL_CANDIDATE_1080P_PAID_ACK",
    acknowledgementValue:
      "I_ACCEPT_EXACTLY_3_REAL_UPSTREAM_REQUESTS_TEXT_IMAGE_1080P",
    irreversibleGuardSuffix: ".paid-minimal-1080p.started",
    exactUpstreamCallCeiling: 3,
    exactChargedCallCeiling: 3,
    chargedShape: Object.freeze({
      text: 1,
      image_generation: 1,
      video_generation: 1,
    }),
  }),
  "canvas/720p": Object.freeze({
    key: "canvas/720p",
    mode: "canvas",
    resolution: "720p",
    driverScript: "scripts/verify-canvas-real-candidate.ts",
    paidFlag: "--paid-minimal",
    acknowledgementEnvironment: "FANJIN_CANVAS_REAL_CANDIDATE_PAID_ACK",
    acknowledgementValue:
      "I_ACCEPT_EXACTLY_2_REAL_UPSTREAM_REQUESTS_IMAGE_AND_SHORTEST_720P_VIDEO",
    irreversibleGuardSuffix: ".canvas-paid-minimal.started",
    exactUpstreamCallCeiling: 2,
    exactChargedCallCeiling: 2,
    chargedShape: Object.freeze({
      text: 0,
      image_generation: 1,
      video_generation: 1,
    }),
  }),
  "canvas/1080p": Object.freeze({
    key: "canvas/1080p",
    mode: "canvas",
    resolution: "1080p",
    driverScript: "scripts/verify-canvas-real-candidate.ts",
    paidFlag: "--paid-minimal-1080p",
    acknowledgementEnvironment:
      "FANJIN_CANVAS_REAL_CANDIDATE_1080P_PAID_ACK",
    acknowledgementValue:
      "I_ACCEPT_EXACTLY_2_REAL_UPSTREAM_REQUESTS_IMAGE_AND_SHORTEST_1080P_VIDEO",
    irreversibleGuardSuffix: ".canvas-paid-minimal-1080p.started",
    exactUpstreamCallCeiling: 2,
    exactChargedCallCeiling: 2,
    chargedShape: Object.freeze({
      text: 0,
      image_generation: 1,
      video_generation: 1,
    }),
  }),
  "agent/720p": Object.freeze({
    key: "agent/720p",
    mode: "agent",
    resolution: "720p",
    driverScript: "scripts/verify-agent-720p-real-candidate.ts",
    paidFlag: "--paid-agent-720p",
    acknowledgementEnvironment: "FANJIN_REAL_AGENT_720P_PAID_ACK",
    acknowledgementValue:
      "I_ACCEPT_AT_MOST_4_REAL_UPSTREAM_CALLS_AND_EXACTLY_1_AGENT_720P_VIDEO",
    irreversibleGuardSuffix: ".agent-720p-real.started",
    exactUpstreamCallCeiling: 4,
    exactChargedCallCeiling: 3,
    chargedShape: Object.freeze({
      text: 2,
      image_generation: 0,
      video_generation: 1,
    }),
  }),
  "agent/1080p": Object.freeze({
    key: "agent/1080p",
    mode: "agent",
    resolution: "1080p",
    driverScript: "scripts/verify-agent-720p-real-candidate.ts",
    paidFlag: "--paid-agent-1080p",
    acknowledgementEnvironment: "FANJIN_REAL_AGENT_1080P_PAID_ACK",
    acknowledgementValue:
      "I_ACCEPT_AT_MOST_4_REAL_UPSTREAM_CALLS_AND_EXACTLY_1_AGENT_1080P_VIDEO",
    irreversibleGuardSuffix: ".agent-1080p-real.started",
    exactUpstreamCallCeiling: 4,
    exactChargedCallCeiling: 3,
    chargedShape: Object.freeze({
      text: 2,
      image_generation: 0,
      video_generation: 1,
    }),
  }),
  "full-matrix/mixed": Object.freeze({
    key: "full-matrix/mixed",
    mode: "full-matrix",
    resolution: "mixed",
    driverScript: "scripts/verify-workbench-full-matrix-real-candidate.ts",
    paidFlag: "--paid-full-matrix",
    acknowledgementEnvironment: "FANJIN_REAL_FULL_MATRIX_ACK",
    acknowledgementValue:
      "I_ACCEPT_EXACTLY_41_REAL_UPSTREAM_REQUESTS_FULL_MATRIX_NO_AUTOMATIC_RETRY",
    irreversibleGuardSuffix: ".paid-full-matrix.started",
    exactUpstreamCallCeiling: 41,
    exactChargedCallCeiling: 41,
    chargedShape: Object.freeze({
      text: 5,
      image_generation: 24,
      video_generation: 12,
    }),
  }),
} satisfies Record<CandidateExactAuthorizationKey, DriverControl>);

export const CANDIDATE_EXACT_AUTHORIZATION_REQUIRED_KEYS = Object.freeze(
  Object.keys(
    CANDIDATE_EXACT_AUTHORIZATION_DRIVER_CONTROLS,
  ) as CandidateExactAuthorizationKey[],
);

export class CandidateExactAuthorizationError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "CandidateExactAuthorizationError";
    this.code = code;
  }
}

export type CandidateExactAuthorizationAnchor = {
  format: typeof CANDIDATE_EXACT_AUTHORIZATION_ANCHOR_VERSION;
  candidateIdentity: ReleaseCandidateSessionIdentity;
  sessionBinding: string;
  workspaceBinding: string;
  walletBinding: string;
  anchorDigest: string;
};

export type CandidateExactAuthorizationMedia = {
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
};

export type CandidateExactAuthorizationOperation = {
  key: string;
  endpointType: EndpointType;
  model: string;
  provider: string;
  routeAlias: string;
  chargedCallCeiling: number;
  maximumCostMicros: number;
  directoryEntryDigest: string;
  routeEntryDigest: string;
  pricingEntryDigest: string;
  parameterDigest: string;
  pricingComponents: Array<{
    component: string;
    unit: string;
    maximumUnits: number;
    unitPriceMicros: number;
    maximumCostMicros: number;
  }>;
  media: CandidateExactAuthorizationMedia | null;
};

export type CandidateExactAuthorizationReceipt = {
  format: typeof CANDIDATE_EXACT_AUTHORIZATION_RECEIPT_VERSION;
  candidateKey: CandidateExactAuthorizationKey;
  candidateIdentity: ReleaseCandidateSessionIdentity;
  sessionBinding: string;
  quoteSource: "quote" | "preflight";
  capturedAt: string;
  expiresAt: string;
  directoryDigest: string;
  routeDigest: string;
  pricingDigest: string;
  quoteDigest: string;
  budget: {
    currency: "GU";
    workspaceBinding: string;
    walletBinding: string;
    availableScopeDigest: string;
    maximumCostMicros: number;
    availableMicros: number;
    reservedMicros: 0;
  };
  operations: CandidateExactAuthorizationOperation[];
  receiptDigest: string;
};

type AnchorBody = Omit<CandidateExactAuthorizationAnchor, "anchorDigest">;
type ReceiptBody = Omit<CandidateExactAuthorizationReceipt, "receiptDigest">;

export type CandidateExactAuthorizationPackage = {
  format: typeof CANDIDATE_EXACT_AUTHORIZATION_PACKAGE_VERSION;
  generatedAt: string;
  authorizationState: "review-only-non-executable";
  executionAuthorized: false;
  reviewScope: "all-listed-independent-runs";
  candidateIdentity: ReleaseCandidateSessionIdentity;
  candidateIdentityDigest: string;
  sessionBinding: string;
  workspaceBinding: string;
  walletBinding: string;
  trustBoundary: {
    receiptDigestPurpose: "integrity-only-not-authenticity";
    trustedReceiptSignatureVerified: false;
    heldSourceCapabilityVerified: false;
    formalCandidateIdentityVerified: false;
    driverPackageDigestConsumptionBound: false;
  };
  activationRequirements: readonly [
    "trusted-signed-live-quote-receipts",
    "formal-runtime-artifact-bound-candidate-identity",
    "every-driver-guard-consumes-this-package-digest",
  ];
  entries: Array<{
    candidateKey: CandidateExactAuthorizationKey;
    mode: CandidateExactAuthorizationMode;
    resolution: CandidateExactAuthorizationResolution;
    driverScript: string;
    exactUpstreamCallCeiling: number;
    exactChargedCallCeiling: number;
    maximumGuMicros: number;
    maximumGu: string;
    budgetAuthority: {
      source: "quote" | "preflight";
      quoteDigest: string;
      receiptDigest: string;
      directoryDigest: string;
      routeDigest: string;
      pricingDigest: string;
      workspaceBinding: string;
      walletBinding: string;
      availableScopeDigest: string;
      capturedAt: string;
      expiresAt: string;
    };
    controls: {
      paidFlag: string;
      exactAcknowledgementEnvironment: string;
      exactAcknowledgementValue: string;
      irreversibleGuardSuffix: string;
      absorbedContinuationAuthorized: false;
    };
    completeness: {
      candidateIdentity: true;
      sessionBinding: true;
      directory: true;
      routing: true;
      pricing: true;
      guBudget: true;
    };
    operations: Array<{
      operationKey: string;
      endpointType: EndpointType;
      model: string;
      provider: string;
      routeAlias: string;
      chargedCallCeiling: number;
      maximumGuMicros: number;
      maximumGu: string;
      directoryEntryDigest: string;
      routeEntryDigest: string;
      pricingEntryDigest: string;
      parameterDigest: string;
      pricingComponents: Array<{
        component: string;
        unit: string;
        maximumUnits: number;
        unitPriceMicros: number;
        maximumCostMicros: number;
        maximumGu: string;
      }>;
      parameters: CandidateExactAuthorizationMedia | null;
    }>;
    ffprobeCoverage: Array<{
      operationKey: string;
      kind: "image" | "video";
      selfFfprobe: boolean;
      jointlyCoveredByFullMatrix: boolean;
      fullMatrixOperationKeys: string[];
      authority: "driver-self" | "full-matrix-joint" | "not-required";
    }>;
  }>;
  executionChecklist: {
    batchDSettledImageMaterializationRecovery: {
      status: "hard-blocked";
      distinctFromB11ProviderResponseUnknown: true;
      creationCallCeiling: {
        upstream: 1;
        charged: 1;
        maximumGu: "requires-live-quote";
      };
      recoveryCallCeiling: {
        upstream: 0;
        charged: 0;
        maximumGu: "0 GU";
      };
      recoveryDriver:
        "scripts/materialize-full-matrix-image-checkpoint.ts";
      recoveryDriverAvailable: true;
      candidateOnlySettledBeforeMaterializationFailpointAvailable: false;
      syntheticAfterSettlementIsRug: false;
      blocker:
        "candidate-only-live-settled-before-materialization-failpoint-missing";
      requiredEvidence: readonly [
        "one-live-image-provider-call-and-one-charged-usage",
        "settled-checkpoint-before-asset-materialization",
        "materialize-only-zero-upstream-recovery",
        "permanent-replay-rejection-and-unchanged-billing",
      ];
    };
  };
  totals: {
    exactUpstreamCallCeiling: number;
    exactChargedCallCeiling: number;
    maximumGuMicros: number;
    maximumGu: string;
  };
  packageDigest: string;
};

function fail(code: string): never {
  throw new CandidateExactAuthorizationError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

export function candidateExactAuthorizationCanonicalJson(
  value: unknown,
): string {
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
  if (encoded === undefined) fail("CANDIDATE_EXACT_AUTHORIZATION_VALUE_INVALID");
  return encoded;
}

function digest(value: unknown): string {
  return `sha256:${crypto
    .createHash("sha256")
    .update(candidateExactAuthorizationCanonicalJson(value))
    .digest("hex")}`;
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && SHA256_BINDING.test(value);
}

function sameIdentity(
  left: ReleaseCandidateSessionIdentity,
  right: ReleaseCandidateSessionIdentity,
): boolean {
  return candidateExactAuthorizationCanonicalJson(left)
    === candidateExactAuthorizationCanonicalJson(right);
}

function parseTimestamp(value: unknown, code: string): number {
  if (typeof value !== "string" || !value || value !== value.trim()) {
    return fail(code);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    return fail(code);
  }
  return parsed;
}

function positiveSafeInteger(value: unknown, code: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fail(code);
  return parsed;
}

function nonNegativeSafeInteger(value: unknown, code: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return fail(code);
  return parsed;
}

function safeAdd(left: number, right: number, code: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) return fail(code);
  return result;
}

export function sealCandidateExactAuthorizationAnchor(
  body: AnchorBody,
): CandidateExactAuthorizationAnchor {
  return {
    ...body,
    anchorDigest: digest(body),
  };
}

export function parseCandidateExactAuthorizationAnchor(
  value: unknown,
): CandidateExactAuthorizationAnchor {
  if (!isRecord(value) || !exactKeys(value, [
    "anchorDigest",
    "candidateIdentity",
    "format",
    "sessionBinding",
    "walletBinding",
    "workspaceBinding",
  ])) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_ANCHOR_INVALID");
  }
  let candidateIdentity: ReleaseCandidateSessionIdentity;
  try {
    candidateIdentity = parseReleaseCandidateSessionCorrelationIdentity(
      value.candidateIdentity,
    );
  } catch {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_IDENTITY_INVALID");
  }
  const body: AnchorBody = {
    format: value.format as typeof CANDIDATE_EXACT_AUTHORIZATION_ANCHOR_VERSION,
    candidateIdentity,
    sessionBinding: String(value.sessionBinding ?? ""),
    workspaceBinding: String(value.workspaceBinding ?? ""),
    walletBinding: String(value.walletBinding ?? ""),
  };
  if (
    body.format !== CANDIDATE_EXACT_AUTHORIZATION_ANCHOR_VERSION
    || !isDigest(body.sessionBinding)
    || !isDigest(body.workspaceBinding)
    || !isDigest(body.walletBinding)
    || !isDigest(value.anchorDigest)
    || value.anchorDigest !== digest(body)
  ) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_ANCHOR_INVALID");
  }
  return {
    ...body,
    anchorDigest: value.anchorDigest,
  };
}

/**
 * Adds an integrity checksum only. This is intentionally not a signature and
 * cannot promote a caller-supplied receipt into execution authority.
 */
export function sealCandidateExactAuthorizationReceipt(
  body: ReceiptBody,
): CandidateExactAuthorizationReceipt {
  return {
    ...body,
    receiptDigest: digest(body),
  };
}

function parseMedia(value: unknown): CandidateExactAuthorizationMedia {
  if (!isRecord(value) || !exactKeys(value, [
    "count",
    "durationSeconds",
    "ffprobeRequired",
    "generateAudio",
    "kind",
    "mode",
    "quality",
    "ratio",
    "resolution",
    "selfFfprobe",
  ])) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_MEDIA_INVALID");
  }
  const count = positiveSafeInteger(
    value.count,
    "CANDIDATE_EXACT_AUTHORIZATION_MEDIA_INVALID",
  );
  const ratio = String(value.ratio ?? "");
  if (
    !["image", "video"].includes(String(value.kind))
    || !SAFE_IDENTIFIER.test(ratio)
    || typeof value.ffprobeRequired !== "boolean"
    || typeof value.selfFfprobe !== "boolean"
  ) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_MEDIA_INVALID");
  }

  if (value.kind === "image") {
    if (
      value.mode !== null
      || value.resolution !== null
      || typeof value.quality !== "string"
      || !SAFE_IDENTIFIER.test(value.quality)
      || value.durationSeconds !== null
      || value.generateAudio !== null
    ) {
      return fail("CANDIDATE_EXACT_AUTHORIZATION_MEDIA_INVALID");
    }
    return {
      kind: "image",
      mode: null,
      resolution: null,
      ratio,
      quality: value.quality,
      durationSeconds: null,
      generateAudio: null,
      count,
      ffprobeRequired: value.ffprobeRequired,
      selfFfprobe: value.selfFfprobe,
    };
  }

  const durationSeconds = positiveSafeInteger(
    value.durationSeconds,
    "CANDIDATE_EXACT_AUTHORIZATION_MEDIA_INVALID",
  );
  if (
    typeof value.mode !== "string"
    || !SAFE_IDENTIFIER.test(value.mode)
    || !["720p", "1080p"].includes(String(value.resolution))
    || value.quality !== null
    || typeof value.generateAudio !== "boolean"
  ) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_MEDIA_INVALID");
  }
  return {
    kind: "video",
    mode: value.mode,
    resolution: value.resolution as "720p" | "1080p",
    ratio,
    quality: null,
    durationSeconds,
    generateAudio: value.generateAudio,
    count,
    ffprobeRequired: value.ffprobeRequired,
    selfFfprobe: value.selfFfprobe,
  };
}

function parseOperation(
  value: unknown,
): CandidateExactAuthorizationOperation {
  if (!isRecord(value) || !exactKeys(value, [
    "chargedCallCeiling",
    "directoryEntryDigest",
    "endpointType",
    "key",
    "maximumCostMicros",
    "media",
    "model",
    "parameterDigest",
    "pricingComponents",
    "pricingEntryDigest",
    "provider",
    "routeAlias",
    "routeEntryDigest",
  ])) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_OPERATION_INVALID");
  }
  const endpointType = String(value.endpointType);
  const key = String(value.key ?? "");
  const model = String(value.model ?? "");
  const provider = String(value.provider ?? "");
  const routeAlias = String(value.routeAlias ?? "");
  if (
    !["text", "image_generation", "video_generation"].includes(endpointType)
    || !SAFE_IDENTIFIER.test(key)
    || !SAFE_IDENTIFIER.test(model)
    || !SAFE_IDENTIFIER.test(provider)
    || !SAFE_IDENTIFIER.test(routeAlias)
    || !isDigest(value.directoryEntryDigest)
    || !isDigest(value.routeEntryDigest)
    || !isDigest(value.pricingEntryDigest)
    || !isDigest(value.parameterDigest)
    || !Array.isArray(value.pricingComponents)
    || value.pricingComponents.length === 0
  ) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_OPERATION_INVALID");
  }
  const pricingComponents = value.pricingComponents.map((component) => {
    if (!isRecord(component) || !exactKeys(component, [
      "component",
      "maximumCostMicros",
      "maximumUnits",
      "unit",
      "unitPriceMicros",
    ])) {
      return fail("CANDIDATE_EXACT_AUTHORIZATION_PRICING_COMPONENT_INVALID");
    }
    const componentName = String(component.component ?? "");
    const unit = String(component.unit ?? "");
    const maximumUnits = positiveSafeInteger(
      component.maximumUnits,
      "CANDIDATE_EXACT_AUTHORIZATION_PRICING_COMPONENT_INVALID",
    );
    const unitPriceMicros = positiveSafeInteger(
      component.unitPriceMicros,
      "CANDIDATE_EXACT_AUTHORIZATION_PRICING_COMPONENT_INVALID",
    );
    const maximumCostMicros = positiveSafeInteger(
      component.maximumCostMicros,
      "CANDIDATE_EXACT_AUTHORIZATION_PRICING_COMPONENT_INVALID",
    );
    if (
      !SAFE_IDENTIFIER.test(componentName)
      || !SAFE_IDENTIFIER.test(unit)
      || !Number.isSafeInteger(maximumUnits * unitPriceMicros)
      || maximumUnits * unitPriceMicros !== maximumCostMicros
    ) {
      return fail("CANDIDATE_EXACT_AUTHORIZATION_PRICING_COMPONENT_INVALID");
    }
    return {
      component: componentName,
      unit,
      maximumUnits,
      unitPriceMicros,
      maximumCostMicros,
    };
  });
  const pricingMaximum = pricingComponents.reduce(
    (total, component) => safeAdd(
      total,
      component.maximumCostMicros,
      "CANDIDATE_EXACT_AUTHORIZATION_PRICING_COMPONENT_INVALID",
    ),
    0,
  );
  const media = value.media === null ? null : parseMedia(value.media);
  if (
    (endpointType === "text" && media !== null)
    || (endpointType === "image_generation" && media?.kind !== "image")
    || (endpointType === "video_generation" && media?.kind !== "video")
  ) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_OPERATION_MEDIA_MISMATCH");
  }
  const maximumCostMicros = positiveSafeInteger(
    value.maximumCostMicros,
    "CANDIDATE_EXACT_AUTHORIZATION_OPERATION_INVALID",
  );
  if (pricingMaximum !== maximumCostMicros) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_OPERATION_PRICE_INVALID");
  }
  return {
    key,
    endpointType: endpointType as EndpointType,
    model,
    provider,
    routeAlias,
    chargedCallCeiling: positiveSafeInteger(
      value.chargedCallCeiling,
      "CANDIDATE_EXACT_AUTHORIZATION_OPERATION_INVALID",
    ),
    maximumCostMicros,
    directoryEntryDigest: value.directoryEntryDigest,
    routeEntryDigest: value.routeEntryDigest,
    pricingEntryDigest: value.pricingEntryDigest,
    parameterDigest: value.parameterDigest,
    pricingComponents,
    media,
  };
}

function assertReceiptShape(
  receipt: CandidateExactAuthorizationReceipt,
): void {
  const control = CANDIDATE_EXACT_AUTHORIZATION_DRIVER_CONTROLS[
    receipt.candidateKey
  ];
  if (!control) return fail("CANDIDATE_EXACT_AUTHORIZATION_KEY_INVALID");
  if (!receipt.operations.length) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_OPERATIONS_MISSING");
  }
  const keys = new Set(receipt.operations.map((operation) => operation.key));
  if (keys.size !== receipt.operations.length) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_OPERATION_DUPLICATE");
  }
  const shape: Record<EndpointType, number> = {
    text: 0,
    image_generation: 0,
    video_generation: 0,
  };
  let maximumCostMicros = 0;
  let chargedCallCeiling = 0;
  for (const operation of receipt.operations) {
    shape[operation.endpointType] = safeAdd(
      shape[operation.endpointType],
      operation.chargedCallCeiling,
      "CANDIDATE_EXACT_AUTHORIZATION_CALL_CEILING_INVALID",
    );
    chargedCallCeiling = safeAdd(
      chargedCallCeiling,
      operation.chargedCallCeiling,
      "CANDIDATE_EXACT_AUTHORIZATION_CALL_CEILING_INVALID",
    );
    maximumCostMicros = safeAdd(
      maximumCostMicros,
      operation.maximumCostMicros,
      "CANDIDATE_EXACT_AUTHORIZATION_GU_INVALID",
    );
  }
  if (
    shape.text !== control.chargedShape.text
    || shape.image_generation !== control.chargedShape.image_generation
    || shape.video_generation !== control.chargedShape.video_generation
    || chargedCallCeiling !== control.exactChargedCallCeiling
    || maximumCostMicros !== receipt.budget.maximumCostMicros
    || receipt.budget.availableMicros < receipt.budget.maximumCostMicros
    || receipt.budget.reservedMicros !== 0
  ) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_BUDGET_SHAPE_INVALID");
  }

  const videos = receipt.operations.filter(
    (operation) => operation.endpointType === "video_generation",
  );
  if (control.resolution !== "mixed" && videos.some(
    (operation) => operation.media?.resolution !== control.resolution,
  )) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_RESOLUTION_INVALID");
  }
  if (
    control.mode === "quick"
    && videos.some((operation) => (
      operation.media?.ffprobeRequired !== true
      || operation.media.selfFfprobe !== false
    ))
  ) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_QUICK_FFPROBE_CONTRACT_INVALID");
  }
  if (
    (control.mode === "canvas" || control.mode === "agent")
    && videos.some((operation) => (
      operation.media?.ffprobeRequired !== true
      || operation.media.selfFfprobe !== true
    ))
  ) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_DRIVER_FFPROBE_CONTRACT_INVALID");
  }
  if (control.mode === "full-matrix") {
    const media = receipt.operations.filter((operation) => operation.media);
    if (
      receipt.operations.length !== 41
      || receipt.operations.some((operation) => (
        operation.chargedCallCeiling !== 1
      ))
      || media.length !== 36
      || media.some((operation) => (
        operation.media?.ffprobeRequired !== true
        || operation.media.selfFfprobe !== true
      ))
      || !videos.some((operation) => operation.media?.resolution === "720p")
      || !videos.some((operation) => operation.media?.resolution === "1080p")
    ) {
      return fail("CANDIDATE_EXACT_AUTHORIZATION_FULL_MATRIX_SHAPE_INVALID");
    }
  }
}

export function parseCandidateExactAuthorizationReceipt(
  value: unknown,
  now: number = Date.now(),
): CandidateExactAuthorizationReceipt {
  if (!isRecord(value) || !exactKeys(value, [
    "budget",
    "candidateIdentity",
    "candidateKey",
    "capturedAt",
    "directoryDigest",
    "expiresAt",
    "format",
    "operations",
    "pricingDigest",
    "quoteDigest",
    "quoteSource",
    "receiptDigest",
    "routeDigest",
    "sessionBinding",
  ])) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_RECEIPT_INVALID");
  }
  if (!isRecord(value.budget) || !exactKeys(value.budget, [
    "availableMicros",
    "availableScopeDigest",
    "currency",
    "maximumCostMicros",
    "reservedMicros",
    "walletBinding",
    "workspaceBinding",
  ])) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_GU_INCOMPLETE");
  }
  const candidateKey = String(value.candidateKey) as CandidateExactAuthorizationKey;
  if (!CANDIDATE_EXACT_AUTHORIZATION_DRIVER_CONTROLS[candidateKey]) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_KEY_INVALID");
  }
  let candidateIdentity: ReleaseCandidateSessionIdentity;
  try {
    candidateIdentity = parseReleaseCandidateSessionCorrelationIdentity(
      value.candidateIdentity,
    );
  } catch {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_IDENTITY_INVALID");
  }
  const capturedAt = parseTimestamp(
    value.capturedAt,
    "CANDIDATE_EXACT_AUTHORIZATION_CAPTURE_TIME_INVALID",
  );
  const expiresAt = parseTimestamp(
    value.expiresAt,
    "CANDIDATE_EXACT_AUTHORIZATION_EXPIRY_INVALID",
  );
  if (
    !Number.isFinite(now)
    || expiresAt <= capturedAt
    || now < capturedAt
    || now > expiresAt
  ) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_RECEIPT_EXPIRED");
  }
  if (
    value.format !== CANDIDATE_EXACT_AUTHORIZATION_RECEIPT_VERSION
    || !isDigest(value.sessionBinding)
    || !["quote", "preflight"].includes(String(value.quoteSource))
    || !isDigest(value.directoryDigest)
    || !isDigest(value.routeDigest)
    || !isDigest(value.pricingDigest)
    || !isDigest(value.quoteDigest)
    || !isDigest(value.receiptDigest)
    || value.budget.currency !== "GU"
    || !isDigest(value.budget.workspaceBinding)
    || !isDigest(value.budget.walletBinding)
    || !isDigest(value.budget.availableScopeDigest)
    || Number(value.budget.reservedMicros) !== 0
    || !Array.isArray(value.operations)
  ) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_RECEIPT_INVALID");
  }
  const budget = {
    currency: "GU" as const,
    workspaceBinding: value.budget.workspaceBinding,
    walletBinding: value.budget.walletBinding,
    availableScopeDigest: value.budget.availableScopeDigest,
    maximumCostMicros: positiveSafeInteger(
      value.budget.maximumCostMicros,
      "CANDIDATE_EXACT_AUTHORIZATION_GU_INCOMPLETE",
    ),
    availableMicros: nonNegativeSafeInteger(
      value.budget.availableMicros,
      "CANDIDATE_EXACT_AUTHORIZATION_GU_INCOMPLETE",
    ),
    reservedMicros: 0 as const,
  };
  const body: ReceiptBody = {
    format: CANDIDATE_EXACT_AUTHORIZATION_RECEIPT_VERSION,
    candidateKey,
    candidateIdentity,
    sessionBinding: value.sessionBinding,
    quoteSource: value.quoteSource as "quote" | "preflight",
    capturedAt: value.capturedAt as string,
    expiresAt: value.expiresAt as string,
    directoryDigest: value.directoryDigest,
    routeDigest: value.routeDigest,
    pricingDigest: value.pricingDigest,
    quoteDigest: value.quoteDigest,
    budget,
    operations: value.operations.map(parseOperation),
  };
  if (value.receiptDigest !== digest(body)) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_RECEIPT_DIGEST_INVALID");
  }
  const receipt: CandidateExactAuthorizationReceipt = {
    ...body,
    receiptDigest: value.receiptDigest,
  };
  assertReceiptShape(receipt);
  return receipt;
}

function guString(micros: number): string {
  if (!Number.isSafeInteger(micros) || micros < 0) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_GU_INVALID");
  }
  return guStringFromMicros(micros);
}

function fullMatrixCoverageKey(
  operation: CandidateExactAuthorizationOperation,
): string | null {
  const media = operation.media;
  if (!media) return null;
  if (media.kind === "video") {
    // The joint gate proves the exact provider model's emitted pixel tier.
    // Mode, prompt and duration remain owned by the calling driver.
    return candidateExactAuthorizationCanonicalJson({
      endpointType: operation.endpointType,
      kind: media.kind,
      model: operation.model,
      provider: operation.provider,
      resolution: media.resolution,
      routeEntryDigest: operation.routeEntryDigest,
    });
  }
  return candidateExactAuthorizationCanonicalJson({
    endpointType: operation.endpointType,
    kind: media.kind,
    model: operation.model,
    provider: operation.provider,
    quality: media.quality,
    ratio: media.ratio,
    routeEntryDigest: operation.routeEntryDigest,
  });
}

export function compileCandidateExactAuthorizationPackage(input: {
  anchor: unknown;
  receipts: readonly unknown[];
  now?: number;
}): CandidateExactAuthorizationPackage {
  const now = input.now ?? Date.now();
  if (!Number.isFinite(now)) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_TIME_INVALID");
  }
  const anchor = parseCandidateExactAuthorizationAnchor(input.anchor);
  const receipts = input.receipts.map((receipt) => (
    parseCandidateExactAuthorizationReceipt(receipt, now)
  ));
  if (receipts.length !== CANDIDATE_EXACT_AUTHORIZATION_REQUIRED_KEYS.length) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_RECEIPT_SET_INCOMPLETE");
  }
  const byKey = new Map<CandidateExactAuthorizationKey, CandidateExactAuthorizationReceipt>();
  for (const receipt of receipts) {
    if (byKey.has(receipt.candidateKey)) {
      return fail("CANDIDATE_EXACT_AUTHORIZATION_RECEIPT_DUPLICATE");
    }
    if (
      receipt.sessionBinding !== anchor.sessionBinding
      || !sameIdentity(receipt.candidateIdentity, anchor.candidateIdentity)
      || receipt.budget.workspaceBinding !== anchor.workspaceBinding
      || receipt.budget.walletBinding !== anchor.walletBinding
    ) {
      return fail("CANDIDATE_EXACT_AUTHORIZATION_CANDIDATE_BINDING_MISMATCH");
    }
    byKey.set(receipt.candidateKey, receipt);
  }
  if (CANDIDATE_EXACT_AUTHORIZATION_REQUIRED_KEYS.some((key) => !byKey.has(key))) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_RECEIPT_SET_INCOMPLETE");
  }

  const fullMatrix = byKey.get("full-matrix/mixed");
  if (!fullMatrix) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_FULL_MATRIX_MISSING");
  }
  const fullMatrixCoverage = new Map<string, string[]>();
  for (const operation of fullMatrix.operations) {
    const coverageKey = fullMatrixCoverageKey(operation);
    if (!coverageKey || operation.media?.selfFfprobe !== true) continue;
    const keys = fullMatrixCoverage.get(coverageKey) || [];
    keys.push(operation.key);
    fullMatrixCoverage.set(coverageKey, keys);
  }

  let totalUpstream = 0;
  let totalCharged = 0;
  let totalGuMicros = 0;
  const entries: CandidateExactAuthorizationPackage["entries"] = [];
  for (const key of CANDIDATE_EXACT_AUTHORIZATION_REQUIRED_KEYS) {
    const receipt = byKey.get(key);
    const control = CANDIDATE_EXACT_AUTHORIZATION_DRIVER_CONTROLS[key];
    if (!receipt) {
      return fail("CANDIDATE_EXACT_AUTHORIZATION_RECEIPT_SET_INCOMPLETE");
    }
    const ffprobeCoverage = receipt.operations.flatMap((operation) => {
      const media = operation.media;
      if (!media) return [];
      const coverageKey = fullMatrixCoverageKey(operation);
      const fullMatrixOperationKeys = coverageKey
        ? [...(fullMatrixCoverage.get(coverageKey) || [])].sort()
        : [];
      const jointlyCoveredByFullMatrix = fullMatrixOperationKeys.length > 0;
      if (
        media.ffprobeRequired
        && !media.selfFfprobe
        && !jointlyCoveredByFullMatrix
      ) {
        return fail("CANDIDATE_EXACT_AUTHORIZATION_FFPROBE_COVERAGE_MISSING");
      }
      return [{
        operationKey: operation.key,
        kind: media.kind,
        selfFfprobe: media.selfFfprobe,
        jointlyCoveredByFullMatrix,
        fullMatrixOperationKeys,
        authority: media.selfFfprobe
          ? "driver-self" as const
          : jointlyCoveredByFullMatrix
            ? "full-matrix-joint" as const
            : "not-required" as const,
      }];
    });
    totalUpstream = safeAdd(
      totalUpstream,
      control.exactUpstreamCallCeiling,
      "CANDIDATE_EXACT_AUTHORIZATION_TOTAL_INVALID",
    );
    totalCharged = safeAdd(
      totalCharged,
      control.exactChargedCallCeiling,
      "CANDIDATE_EXACT_AUTHORIZATION_TOTAL_INVALID",
    );
    totalGuMicros = safeAdd(
      totalGuMicros,
      receipt.budget.maximumCostMicros,
      "CANDIDATE_EXACT_AUTHORIZATION_TOTAL_INVALID",
    );
    entries.push({
      candidateKey: key,
      mode: control.mode,
      resolution: control.resolution,
      driverScript: control.driverScript,
      exactUpstreamCallCeiling: control.exactUpstreamCallCeiling,
      exactChargedCallCeiling: control.exactChargedCallCeiling,
      maximumGuMicros: receipt.budget.maximumCostMicros,
      maximumGu: guString(receipt.budget.maximumCostMicros),
      budgetAuthority: {
        source: receipt.quoteSource,
        quoteDigest: receipt.quoteDigest,
        receiptDigest: receipt.receiptDigest,
        directoryDigest: receipt.directoryDigest,
        routeDigest: receipt.routeDigest,
        pricingDigest: receipt.pricingDigest,
        workspaceBinding: receipt.budget.workspaceBinding,
        walletBinding: receipt.budget.walletBinding,
        availableScopeDigest: receipt.budget.availableScopeDigest,
        capturedAt: receipt.capturedAt,
        expiresAt: receipt.expiresAt,
      },
      controls: {
        paidFlag: control.paidFlag,
        exactAcknowledgementEnvironment: control.acknowledgementEnvironment,
        exactAcknowledgementValue: control.acknowledgementValue,
        irreversibleGuardSuffix: control.irreversibleGuardSuffix,
        absorbedContinuationAuthorized: false,
      },
      completeness: {
        candidateIdentity: true,
        sessionBinding: true,
        directory: true,
        routing: true,
        pricing: true,
        guBudget: true,
      },
      operations: receipt.operations.map((operation) => ({
        operationKey: operation.key,
        endpointType: operation.endpointType,
        model: operation.model,
        provider: operation.provider,
        routeAlias: operation.routeAlias,
        chargedCallCeiling: operation.chargedCallCeiling,
        maximumGuMicros: operation.maximumCostMicros,
        maximumGu: guString(operation.maximumCostMicros),
        directoryEntryDigest: operation.directoryEntryDigest,
        routeEntryDigest: operation.routeEntryDigest,
        pricingEntryDigest: operation.pricingEntryDigest,
        parameterDigest: operation.parameterDigest,
        pricingComponents: operation.pricingComponents.map((component) => ({
          ...component,
          maximumGu: guString(component.maximumCostMicros),
        })),
        parameters: operation.media,
      })),
      ffprobeCoverage,
    });
  }

  const body = {
    format: CANDIDATE_EXACT_AUTHORIZATION_PACKAGE_VERSION,
    generatedAt: new Date(now).toISOString(),
    authorizationState: "review-only-non-executable" as const,
    executionAuthorized: false as const,
    reviewScope: "all-listed-independent-runs" as const,
    candidateIdentity: anchor.candidateIdentity,
    candidateIdentityDigest: digest(anchor.candidateIdentity),
    sessionBinding: anchor.sessionBinding,
    workspaceBinding: anchor.workspaceBinding,
    walletBinding: anchor.walletBinding,
    trustBoundary: {
      receiptDigestPurpose: "integrity-only-not-authenticity" as const,
      trustedReceiptSignatureVerified: false as const,
      heldSourceCapabilityVerified: false as const,
      formalCandidateIdentityVerified: false as const,
      driverPackageDigestConsumptionBound: false as const,
    },
    activationRequirements: [
      "trusted-signed-live-quote-receipts",
      "formal-runtime-artifact-bound-candidate-identity",
      "every-driver-guard-consumes-this-package-digest",
    ] as const,
    entries,
    executionChecklist: {
      batchDSettledImageMaterializationRecovery: {
        status: "hard-blocked" as const,
        distinctFromB11ProviderResponseUnknown: true as const,
        creationCallCeiling: {
          upstream: 1 as const,
          charged: 1 as const,
          maximumGu: "requires-live-quote" as const,
        },
        recoveryCallCeiling: {
          upstream: 0 as const,
          charged: 0 as const,
          maximumGu: "0 GU" as const,
        },
        recoveryDriver:
          "scripts/materialize-full-matrix-image-checkpoint.ts" as const,
        recoveryDriverAvailable: true as const,
        candidateOnlySettledBeforeMaterializationFailpointAvailable:
          false as const,
        syntheticAfterSettlementIsRug: false as const,
        blocker:
          "candidate-only-live-settled-before-materialization-failpoint-missing" as const,
        requiredEvidence: [
          "one-live-image-provider-call-and-one-charged-usage",
          "settled-checkpoint-before-asset-materialization",
          "materialize-only-zero-upstream-recovery",
          "permanent-replay-rejection-and-unchanged-billing",
        ] as const,
      },
    },
    totals: {
      exactUpstreamCallCeiling: totalUpstream,
      exactChargedCallCeiling: totalCharged,
      maximumGuMicros: totalGuMicros,
      maximumGu: guString(totalGuMicros),
    },
  };
  return {
    ...body,
    packageDigest: digest(body),
  };
}

function selfCheckIdentity(): ReleaseCandidateSessionIdentity {
  return {
    format: "fanjin-release-candidate-session-identity/v1",
    evidenceClass: "dev-local-only-contract-fixture",
    formalB0Eligible: false,
    runtimeArtifactBindingVerified: false,
    freezeReceiptDigest: "1".repeat(64),
    freezeSha256: "2".repeat(64),
    releaseUuid: "11111111-1111-4111-8111-111111111111",
    artifactUuid: "22222222-2222-4222-8222-222222222222",
    artifactSha256: "3".repeat(64),
    artifactSignedManifestSha256: "4".repeat(64),
    sourceDigest: "5".repeat(40),
    configExpectedSha256: "6".repeat(64),
    schemaExpectedSha256: "7".repeat(64),
    attestationKeyId: "dev-local-only-exact-authorization-self-check",
  };
}

function syntheticOperation(input: {
  key: string;
  endpointType: EndpointType;
  model: string;
  chargedCallCeiling?: number;
  maximumCostMicros?: number;
  media?: CandidateExactAuthorizationMedia;
}): CandidateExactAuthorizationOperation {
  const maximumCostMicros = input.maximumCostMicros || 1_000_000;
  return {
    key: input.key,
    endpointType: input.endpointType,
    model: input.model,
    provider: "self-check-provider",
    routeAlias: "self-check-route",
    chargedCallCeiling: input.chargedCallCeiling || 1,
    maximumCostMicros,
    directoryEntryDigest: `sha256:${"a".repeat(64)}`,
    routeEntryDigest: `sha256:${"b".repeat(64)}`,
    pricingEntryDigest: `sha256:${"c".repeat(64)}`,
    parameterDigest: `sha256:${"d".repeat(64)}`,
    pricingComponents: [{
      component: "synthetic-fixture-only",
      unit: "fixture-unit",
      maximumUnits: 1,
      unitPriceMicros: maximumCostMicros,
      maximumCostMicros,
    }],
    media: input.media || null,
  };
}

function syntheticVideo(
  resolution: "720p" | "1080p",
  selfFfprobe: boolean,
): CandidateExactAuthorizationMedia {
  return {
    kind: "video",
    mode: "text_to_video",
    resolution,
    ratio: "16:9",
    quality: null,
    durationSeconds: 5,
    generateAudio: false,
    count: 1,
    ffprobeRequired: true,
    selfFfprobe,
  };
}

function selfCheckOperations(
  key: CandidateExactAuthorizationKey,
): CandidateExactAuthorizationOperation[] {
  const resolution = key.endsWith("1080p") ? "1080p" : "720p";
  const videoModel = resolution === "1080p"
    ? "self-check-video-1080"
    : "self-check-video-720";
  if (key.startsWith("quick/")) {
    return [
      syntheticOperation({ key: `${key}/text`, endpointType: "text", model: "self-check-text" }),
      syntheticOperation({
        key: `${key}/image`,
        endpointType: "image_generation",
        model: "self-check-image",
        media: {
          kind: "image",
          mode: null,
          resolution: null,
          ratio: "16:9",
          quality: "2K",
          durationSeconds: null,
          generateAudio: null,
          count: 1,
          ffprobeRequired: false,
          selfFfprobe: false,
        },
      }),
      syntheticOperation({
        key: `${key}/video`,
        endpointType: "video_generation",
        model: videoModel,
        media: syntheticVideo(resolution, false),
      }),
    ];
  }
  if (key.startsWith("canvas/")) {
    return [
      syntheticOperation({
        key: `${key}/image`,
        endpointType: "image_generation",
        model: "self-check-image",
        media: {
          kind: "image",
          mode: null,
          resolution: null,
          ratio: "16:9",
          quality: "2K",
          durationSeconds: null,
          generateAudio: null,
          count: 1,
          ffprobeRequired: true,
          selfFfprobe: true,
        },
      }),
      syntheticOperation({
        key: `${key}/video`,
        endpointType: "video_generation",
        model: videoModel,
        media: syntheticVideo(resolution, true),
      }),
    ];
  }
  if (key.startsWith("agent/")) {
    return [
      syntheticOperation({
        key: `${key}/text`,
        endpointType: "text",
        model: "self-check-text",
        chargedCallCeiling: 2,
        maximumCostMicros: 2_000_000,
      }),
      syntheticOperation({
        key: `${key}/video`,
        endpointType: "video_generation",
        model: videoModel,
        media: syntheticVideo(resolution, true),
      }),
    ];
  }

  const operations: CandidateExactAuthorizationOperation[] = [];
  for (let index = 0; index < 5; index += 1) {
    operations.push(syntheticOperation({
      key: `full-matrix/text/${index}`,
      endpointType: "text",
      model: `self-check-text-${index}`,
    }));
  }
  for (let index = 0; index < 24; index += 1) {
    operations.push(syntheticOperation({
      key: `full-matrix/image/${index}`,
      endpointType: "image_generation",
      model: `self-check-image-${index % 3}`,
      media: {
        kind: "image",
        mode: null,
        resolution: null,
        ratio: index === 0 ? "16:9" : `ratio-${index}`,
        quality: "2K",
        durationSeconds: null,
        generateAudio: null,
        count: 1,
        ffprobeRequired: true,
        selfFfprobe: true,
      },
    }));
  }
  for (let index = 0; index < 12; index += 1) {
    const rowResolution = index === 1 ? "1080p" : "720p";
    const model = index === 0
      ? "self-check-video-720"
      : index === 1
        ? "self-check-video-1080"
        : `self-check-video-${index}`;
    operations.push(syntheticOperation({
      key: `full-matrix/video/${index}`,
      endpointType: "video_generation",
      model,
      media: syntheticVideo(rowResolution, true),
    }));
  }
  return operations;
}

export function candidateExactAuthorizationSelfCheck(): Record<string, unknown> {
  const now = Date.parse("2030-01-01T00:00:00.000Z");
  const identity = selfCheckIdentity();
  const sessionBinding = `sha256:${"8".repeat(64)}`;
  const anchor = sealCandidateExactAuthorizationAnchor({
    format: CANDIDATE_EXACT_AUTHORIZATION_ANCHOR_VERSION,
    candidateIdentity: identity,
    sessionBinding,
    workspaceBinding: `sha256:${"9".repeat(64)}`,
    walletBinding: `sha256:${"a".repeat(64)}`,
  });
  const receipts = CANDIDATE_EXACT_AUTHORIZATION_REQUIRED_KEYS.map((key) => {
    const operations = selfCheckOperations(key);
    const maximumCostMicros = operations.reduce(
      (total, operation) => total + operation.maximumCostMicros,
      0,
    );
    return sealCandidateExactAuthorizationReceipt({
      format: CANDIDATE_EXACT_AUTHORIZATION_RECEIPT_VERSION,
      candidateKey: key,
      candidateIdentity: identity,
      sessionBinding,
      quoteSource: key === "full-matrix/mixed" ? "preflight" : "quote",
      capturedAt: "2029-12-31T23:59:00.000Z",
      expiresAt: "2030-01-01T00:01:00.000Z",
      directoryDigest: `sha256:${"9".repeat(64)}`,
      routeDigest: `sha256:${"a".repeat(64)}`,
      pricingDigest: `sha256:${"b".repeat(64)}`,
      quoteDigest: `sha256:${"c".repeat(64)}`,
      budget: {
        currency: "GU",
        workspaceBinding: anchor.workspaceBinding,
        walletBinding: anchor.walletBinding,
        availableScopeDigest: `sha256:${"e".repeat(64)}`,
        maximumCostMicros,
        availableMicros: maximumCostMicros,
        reservedMicros: 0,
      },
      operations,
    });
  });
  const compiled = compileCandidateExactAuthorizationPackage({
    anchor,
    receipts,
    now,
  });
  const expectedUpstream = Object.values(
    CANDIDATE_EXACT_AUTHORIZATION_DRIVER_CONTROLS,
  ).reduce((total, control) => total + control.exactUpstreamCallCeiling, 0);
  const expectedCharged = Object.values(
    CANDIDATE_EXACT_AUTHORIZATION_DRIVER_CONTROLS,
  ).reduce((total, control) => total + control.exactChargedCallCeiling, 0);
  if (
    compiled.entries.length !== CANDIDATE_EXACT_AUTHORIZATION_REQUIRED_KEYS.length
    || compiled.executionAuthorized !== false
    || compiled.authorizationState !== "review-only-non-executable"
    || compiled.totals.exactUpstreamCallCeiling !== expectedUpstream
    || compiled.totals.exactChargedCallCeiling !== expectedCharged
    || compiled.entries.some((entry) => entry.ffprobeCoverage.some(
      (coverage) => (
        coverage.operationKey.endsWith("/video")
        && !coverage.selfFfprobe
        && !coverage.jointlyCoveredByFullMatrix
      ),
    ))
  ) {
    return fail("CANDIDATE_EXACT_AUTHORIZATION_SELF_CHECK_FAILED");
  }
  return {
    ok: true,
    mode: "self-check",
    networkRequests: 0,
    browserLaunches: 0,
    productionRequests: 0,
    paidCalls: 0,
    secretReads: 0,
    fileReads: 0,
    fileWrites: 0,
    syntheticFixturePricesOnly: true,
    realGuAuthorized: false,
    authorizationState: compiled.authorizationState,
    executionAuthorized: compiled.executionAuthorized,
    receiptDigestAuthenticatesSource: false,
    driverConsumesPackageDigest: false,
    requiredReceipts: CANDIDATE_EXACT_AUTHORIZATION_REQUIRED_KEYS.length,
    callCeilings: Object.fromEntries(
      CANDIDATE_EXACT_AUTHORIZATION_REQUIRED_KEYS.map((key) => {
        const control = CANDIDATE_EXACT_AUTHORIZATION_DRIVER_CONTROLS[key];
        return [key, {
          upstream: control.exactUpstreamCallCeiling,
          charged: control.exactChargedCallCeiling,
        }];
      }),
    ),
    failClosed: {
      candidateIdentity: true,
      sessionBinding: true,
      directory: true,
      routing: true,
      pricing: true,
      guBudget: true,
      quoteExpiry: true,
      fullMatrixFfprobe: true,
    },
    hardBlockers: {
      trustedSignedLiveQuoteReceipts: true,
      formalRuntimeArtifactIdentity: true,
      driverPackageDigestConsumption: true,
      batchDSettledBeforeMaterializationFailpoint: true,
    },
    selfCheckPackageDigest: compiled.packageDigest,
  };
}
