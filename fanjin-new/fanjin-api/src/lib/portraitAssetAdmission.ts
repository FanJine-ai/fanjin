import { createHmac, timingSafeEqual } from "node:crypto";

export const PORTRAIT_ASSET_ADMISSION_VERSION =
  "portrait-asset-admission/v1" as const;
export const PORTRAIT_ASSET_ADMISSION_ENVELOPE_VERSION =
  "portrait-asset-admission-envelope/v1" as const;
export const PORTRAIT_USER_DECLARATION_VERSION =
  "portrait-user-declaration/v1" as const;
export const PORTRAIT_TRUSTED_OUTPUT_EVIDENCE_VERSION =
  "portrait-trusted-output-evidence/v1" as const;
export const PORTRAIT_LIVENESS_EVIDENCE_VERSION =
  "portrait-liveness-evidence/v1" as const;

export const PORTRAIT_FACE_SCAN_STATES = [
  "queued",
  "scanning",
  "no_face",
  "single_face",
  "multiple_faces",
  "uncertain",
  "failed",
] as const;

export const PORTRAIT_FACE_SCAN_COVERAGES = [
  "none",
  "full_image",
  "sampled_video",
  "full_video_manual",
] as const;

export const PORTRAIT_MANUAL_REVIEW_STATES = [
  "not_required",
  "pending",
  "in_review",
  "completed",
  "superseded",
] as const;

export const PORTRAIT_MANUAL_REVIEW_DECISIONS = [
  "no_face",
  "single_face",
  "multiple_faces",
  "uncertain",
] as const;

export const PORTRAIT_SUBJECT_KINDS = [
  "pending",
  "ordinary",
  "real_person",
  "virtual_person",
  "trusted_output",
  "ambiguous",
  "multiple_faces",
] as const;

export const PORTRAIT_DECLARATION_STATES = [
  "not_required",
  "pending",
  "confirmed",
  "revoked",
] as const;

export const PORTRAIT_COMPLIANCE_STATES = [
  "pending",
  "not_required",
  "allowed",
  "denied",
  "expired",
  "revoked",
] as const;

export const PORTRAIT_PROVIDER_SYNC_STATES = [
  "not_needed",
  "queued",
  "authorizing",
  "creating_group",
  "processing",
  "active",
  "failed",
  "stale",
] as const;

export const PORTRAIT_PROVIDER_GROUP_TYPES = ["AIGC", "LivenessFace"] as const;
export const PORTRAIT_MODERATION_STATES = ["pending", "allowed", "denied"] as const;

export type PortraitFaceScanState = (typeof PORTRAIT_FACE_SCAN_STATES)[number];
export type PortraitFaceScanCoverage = (typeof PORTRAIT_FACE_SCAN_COVERAGES)[number];
export type PortraitManualReviewState = (typeof PORTRAIT_MANUAL_REVIEW_STATES)[number];
export type PortraitManualReviewDecision = (typeof PORTRAIT_MANUAL_REVIEW_DECISIONS)[number];
export type PortraitSubjectKind = (typeof PORTRAIT_SUBJECT_KINDS)[number];
export type PortraitDeclarationState = (typeof PORTRAIT_DECLARATION_STATES)[number];
export type PortraitComplianceState = (typeof PORTRAIT_COMPLIANCE_STATES)[number];
export type PortraitProviderSyncState = (typeof PORTRAIT_PROVIDER_SYNC_STATES)[number];
export type PortraitProviderGroupType = (typeof PORTRAIT_PROVIDER_GROUP_TYPES)[number];
export type PortraitModerationState = (typeof PORTRAIT_MODERATION_STATES)[number];
export type PortraitUserDeclaredSubjectKind = "real_person" | "virtual_person";

export const PORTRAIT_FACE_SCAN_TRANSITIONS = {
  queued: ["scanning"],
  scanning: ["no_face", "single_face", "multiple_faces", "uncertain", "failed"],
  no_face: [],
  single_face: [],
  multiple_faces: [],
  uncertain: [],
  failed: [],
} as const satisfies Readonly<
Record<PortraitFaceScanState, readonly PortraitFaceScanState[]>
>;

export const PORTRAIT_PROVIDER_SYNC_TRANSITIONS = {
  not_needed: ["queued"],
  queued: ["authorizing", "creating_group", "failed", "stale"],
  authorizing: ["creating_group", "failed", "stale"],
  creating_group: ["processing", "failed", "stale"],
  processing: ["active", "failed", "stale"],
  active: ["stale"],
  failed: ["queued", "stale"],
  stale: ["queued"],
} as const satisfies Readonly<
Record<PortraitProviderSyncState, readonly PortraitProviderSyncState[]>
>;

export const PORTRAIT_COMPLIANCE_TRANSITIONS = {
  pending: ["not_required", "allowed", "denied"],
  not_required: [],
  allowed: ["denied", "expired", "revoked"],
  denied: [],
  expired: [],
  revoked: [],
} as const satisfies Readonly<
Record<PortraitComplianceState, readonly PortraitComplianceState[]>
>;

export const PORTRAIT_ASSET_ERROR_CODES = [
  "portrait_input_invalid",
  "portrait_state_invalid",
  "portrait_event_invalid",
  "portrait_unknown_field",
  "portrait_group_type_user_forbidden",
  "portrait_provider_type_user_forbidden",
  "portrait_invalid_state_transition",
  "portrait_event_time_invalid",
  "portrait_face_scan_required",
  "portrait_face_scan_failed",
  "portrait_multiple_faces_not_supported",
  "portrait_face_scan_uncertain",
  "portrait_declaration_required",
  "portrait_declaration_conflict",
  "portrait_rights_attestation_required",
  "portrait_authorization_evidence_required",
  "portrait_trusted_output_not_user_declarable",
  "portrait_trusted_output_evidence_required",
  "portrait_trusted_output_evidence_invalid",
  "portrait_trusted_output_signature_invalid",
  "portrait_liveness_evidence_required",
  "portrait_liveness_evidence_invalid",
  "portrait_liveness_signature_invalid",
  "portrait_moderation_required",
  "portrait_moderation_denied",
  "portrait_provider_sync_required",
  "portrait_provider_sync_not_allowed",
  "portrait_provider_sync_failed",
  "portrait_provider_type_mismatch",
  "portrait_compliance_expired",
  "portrait_compliance_revoked",
  "portrait_serialization_invalid",
  "portrait_integrity_key_invalid",
  "portrait_context_mismatch",
  "portrait_checksum_mismatch",
] as const;

export type PortraitAssetAdmissionErrorCode =
  (typeof PORTRAIT_ASSET_ERROR_CODES)[number];

export class PortraitAssetAdmissionError extends Error {
  readonly code: PortraitAssetAdmissionErrorCode;
  readonly field: string | null;

  constructor(
    code: PortraitAssetAdmissionErrorCode,
    message: string,
    field: string | null = null,
  ) {
    super(message);
    this.name = "PortraitAssetAdmissionError";
    this.code = code;
    this.field = field;
  }
}

export interface PortraitFaceScanEvidence {
  detectorName: string;
  detectorVersion: string;
  confidence: number;
  evidenceHash: string;
  faceCount: number | null;
}

export interface PortraitUserDeclaration {
  version: typeof PORTRAIT_USER_DECLARATION_VERSION;
  subjectKind: PortraitUserDeclaredSubjectKind;
  rightsConfirmed: true;
  authorizationEvidenceId: string;
  evidenceHash: string;
  termsVersion: string;
  declaredByUserId: number;
  declaredAt: string;
  revokedAt: string | null;
}

/**
 * This is first-party evidence, not a user assertion. A caller must only build
 * it after validating the referenced Fanjin task receipt.
 */
export interface PortraitTrustedOutputEvidence {
  version: typeof PORTRAIT_TRUSTED_OUTPUT_EVIDENCE_VERSION;
  admissionId: string;
  assetVersionId: number;
  evidenceId: string;
  evidenceHash: string;
  sourceTaskId: string;
  verifiedAt: string;
  signature: string;
}

export interface IssuePortraitTrustedOutputEvidenceInput {
  admissionId: string;
  assetVersionId: number;
  evidenceId: string;
  evidenceHash: string;
  sourceTaskId: string;
  verifiedAt: string;
}

export interface PortraitLivenessEvidence {
  version: typeof PORTRAIT_LIVENESS_EVIDENCE_VERSION;
  admissionId: string;
  assetVersionId: number;
  providerSessionId: string;
  evidenceHash: string;
  verifiedAt: string;
  signature: string;
}

export interface IssuePortraitLivenessEvidenceInput {
  admissionId: string;
  assetVersionId: number;
  providerSessionId: string;
  evidenceHash: string;
  verifiedAt: string;
}

export interface PortraitModerationDecision {
  state: PortraitModerationState;
  evidenceHash: string | null;
  reasonCode: string | null;
  decidedAt: string | null;
}

export interface PortraitProviderBinding {
  providerAssetId: string;
  providerAssetUri: string;
  activeAt: string;
}

export interface PortraitAssetAdmissionState {
  version: typeof PORTRAIT_ASSET_ADMISSION_VERSION;
  admissionId: string;
  assetVersionId: number;
  faceScanState: PortraitFaceScanState;
  faceScanEvidence: PortraitFaceScanEvidence | null;
  subjectKind: PortraitSubjectKind;
  declarationState: PortraitDeclarationState;
  userDeclaration: PortraitUserDeclaration | null;
  trustedOutputEvidence: PortraitTrustedOutputEvidence | null;
  moderation: PortraitModerationDecision;
  complianceState: PortraitComplianceState;
  providerGroupType: PortraitProviderGroupType | null;
  providerSyncState: PortraitProviderSyncState;
  livenessEvidence: PortraitLivenessEvidence | null;
  providerBinding: PortraitProviderBinding | null;
  providerAttempt: number;
  providerErrorCode: string | null;
  safeErrorCode: PortraitAssetAdmissionErrorCode | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreatePortraitAssetAdmissionInput {
  admissionId: string;
  assetVersionId: number;
  createdAt: string;
}

export interface PortraitAssetAdmissionTransitionOptions {
  trustedOutputEvidenceKey?: string;
  livenessEvidenceKey?: string;
}

export interface PortraitAssetAdmissionSerializationOptions {
  integrityKey: string;
  trustedOutputEvidenceKey?: string;
  livenessEvidenceKey?: string;
}

export interface PortraitAssetAdmissionDeserializationOptions
extends PortraitAssetAdmissionSerializationOptions {
  expectedAdmissionId: string;
  expectedAssetVersionId: number;
}

export type PortraitAssetAdmissionEvent =
  | Readonly<{ type: "start_face_scan"; occurredAt: string }>
  | Readonly<{
    type: "complete_face_scan";
    result: "no_face" | "single_face" | "multiple_faces" | "uncertain";
    evidence: PortraitFaceScanEvidence;
    occurredAt: string;
  }>
  | Readonly<{
    type: "fail_face_scan";
    reasonCode: string;
    occurredAt: string;
  }>
  | Readonly<{
    type: "declare_subject";
    subjectKind: PortraitUserDeclaredSubjectKind;
    rightsConfirmed: true;
    authorizationEvidenceId: string;
    evidenceHash: string;
    termsVersion: string;
    declaredByUserId: number;
    occurredAt: string;
  }>
  | Readonly<{
    type: "attest_trusted_output";
    evidence: PortraitTrustedOutputEvidence;
    occurredAt: string;
  }>
  | Readonly<{
    type: "moderation_allowed";
    evidenceHash: string;
    occurredAt: string;
  }>
  | Readonly<{
    type: "moderation_denied";
    evidenceHash: string;
    reasonCode: string;
    occurredAt: string;
  }>
  | Readonly<{ type: "provider_authorization_started"; occurredAt: string }>
  | Readonly<{
    type: "provider_authorization_succeeded";
    evidence: PortraitLivenessEvidence;
    occurredAt: string;
  }>
  | Readonly<{ type: "provider_group_creation_started"; occurredAt: string }>
  | Readonly<{ type: "provider_group_ready"; occurredAt: string }>
  | Readonly<{
    type: "provider_asset_activated";
    providerAssetId: string;
    providerAssetUri: string;
    observedGroupType: PortraitProviderGroupType;
    occurredAt: string;
  }>
  | Readonly<{
    type: "provider_sync_failed";
    reasonCode: string;
    occurredAt: string;
  }>
  | Readonly<{ type: "mark_provider_sync_stale"; occurredAt: string }>
  | Readonly<{ type: "retry_provider_sync"; occurredAt: string }>
  | Readonly<{ type: "expire_compliance"; occurredAt: string }>
  | Readonly<{ type: "revoke_compliance"; occurredAt: string }>;

export interface PortraitAssetAdmissionEnvelope {
  format: typeof PORTRAIT_ASSET_ADMISSION_ENVELOPE_VERSION;
  state: PortraitAssetAdmissionState;
  checksum: string;
}

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_TOKEN_PATTERN = /^[^\u0000-\u001f\u007f\s]{1,256}$/u;
const SAFE_ERROR_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u;
const MAX_SERIALIZED_BYTES = 64 * 1024;
const MIN_INTEGRITY_KEY_BYTES = 32;

type Row = Record<string, unknown>;

function fail(
  code: PortraitAssetAdmissionErrorCode,
  message: string,
  field: string | null = null,
): never {
  throw new PortraitAssetAdmissionError(code, message, field);
}

function isRecord(value: unknown): value is Row {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function record(
  value: unknown,
  code: PortraitAssetAdmissionErrorCode,
  field: string,
): Row {
  if (!isRecord(value)) fail(code, `${field} 必须是对象`, field);
  return value;
}

function exactKeys(
  value: Row,
  expected: readonly string[],
  code: PortraitAssetAdmissionErrorCode,
  field: string,
): void {
  const allowed = new Set(expected);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) {
    fail("portrait_unknown_field", `${field} 包含未知字段`, `${field}.${unknown}`);
  }
  const missing = expected.find((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (missing) fail(code, `${field} 缺少必要字段`, `${field}.${missing}`);
}

function exactKeysWithOptional(
  value: Row,
  required: readonly string[],
  optional: readonly string[],
  code: PortraitAssetAdmissionErrorCode,
  field: string,
): void {
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) {
    if (
      (unknown === "groupType" || unknown === "providerGroupType")
      && value[unknown] === "GroupType"
    ) {
      fail(
        "portrait_group_type_user_forbidden",
        "GroupType 只能由系统根据主体类型派生，用户不得选择",
        `${field}.${unknown}`,
      );
    }
    if (unknown === "groupType" || unknown === "providerGroupType") {
      fail(
        "portrait_provider_type_user_forbidden",
        "供应商人像分组类型不能由用户指定",
        `${field}.${unknown}`,
      );
    }
    fail("portrait_unknown_field", `${field} 包含未知字段`, `${field}.${unknown}`);
  }
  const missing = required.find((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (missing) fail(code, `${field} 缺少必要字段`, `${field}.${missing}`);
}

function rejectUserSelectedProviderGroupType(value: Row, field: string): void {
  for (const key of ["groupType", "providerGroupType"] as const) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    if (value[key] === "GroupType") {
      fail(
        "portrait_group_type_user_forbidden",
        "GroupType 只能由系统根据主体类型派生，用户不得选择",
        `${field}.${key}`,
      );
    }
    fail(
      "portrait_provider_type_user_forbidden",
      "供应商人像分组类型不能由用户指定",
      `${field}.${key}`,
    );
  }
}

function safeId(
  value: unknown,
  code: PortraitAssetAdmissionErrorCode,
  field: string,
): string {
  if (typeof value !== "string" || value !== value.trim() || !SAFE_TOKEN_PATTERN.test(value)) {
    fail(code, `${field} 无效`, field);
  }
  return value;
}

function safeErrorCode(
  value: unknown,
  code: PortraitAssetAdmissionErrorCode,
  field: string,
): string {
  if (typeof value !== "string" || !SAFE_ERROR_CODE_PATTERN.test(value)) {
    fail(code, `${field} 无效`, field);
  }
  return value;
}

function positiveInteger(
  value: unknown,
  code: PortraitAssetAdmissionErrorCode,
  field: string,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    fail(code, `${field} 必须是正整数`, field);
  }
  return value;
}

function nonNegativeInteger(
  value: unknown,
  code: PortraitAssetAdmissionErrorCode,
  field: string,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail(code, `${field} 必须是非负整数`, field);
  }
  return value;
}

function canonicalTimestamp(
  value: unknown,
  code: PortraitAssetAdmissionErrorCode,
  field: string,
): string {
  if (typeof value !== "string") fail(code, `${field} 必须是时间字符串`, field);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    fail(code, `${field} 必须是规范 ISO-8601 UTC 时间`, field);
  }
  return value;
}

function integrityKey(value: unknown, field: string): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") < MIN_INTEGRITY_KEY_BYTES) {
    fail(
      "portrait_integrity_key_invalid",
      "肖像资产完整性密钥至少需要 32 字节",
      field,
    );
  }
  return value;
}

function hmacSha256(value: string, key: string): string {
  return createHmac("sha256", key).update(value, "utf8").digest("hex");
}

function hash(
  value: unknown,
  code: PortraitAssetAdmissionErrorCode,
  field: string,
): string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    fail(code, `${field} 必须是小写 SHA-256`, field);
  }
  return value;
}

function enumValue<T extends readonly string[]>(
  value: unknown,
  values: T,
  code: PortraitAssetAdmissionErrorCode,
  field: string,
): T[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    fail(code, `${field} 无效`, field);
  }
  return value as T[number];
}

function parseFaceScanEvidence(
  value: unknown,
  code: PortraitAssetAdmissionErrorCode,
  field: string,
): PortraitFaceScanEvidence {
  const input = record(value, code, field);
  exactKeys(
    input,
    ["detectorName", "detectorVersion", "confidence", "evidenceHash", "faceCount"],
    code,
    field,
  );
  const confidence = input.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence)
    || confidence < 0 || confidence > 1) {
    fail(code, `${field}.confidence 必须位于 0 到 1`, `${field}.confidence`);
  }
  const faceCount = input.faceCount === null
    ? null
    : nonNegativeInteger(input.faceCount, code, `${field}.faceCount`);
  return {
    detectorName: safeId(input.detectorName, code, `${field}.detectorName`),
    detectorVersion: safeId(input.detectorVersion, code, `${field}.detectorVersion`),
    confidence,
    evidenceHash: hash(input.evidenceHash, code, `${field}.evidenceHash`),
    faceCount,
  };
}

function assertFaceCount(
  result: "no_face" | "single_face" | "multiple_faces" | "uncertain",
  evidence: PortraitFaceScanEvidence,
  code: PortraitAssetAdmissionErrorCode,
): void {
  if (result === "no_face" && evidence.faceCount !== 0) {
    fail(code, "no_face 扫描结果必须绑定 faceCount=0", "evidence.faceCount");
  }
  if (result === "single_face" && evidence.faceCount !== 1) {
    fail(code, "single_face 扫描结果必须绑定 faceCount=1", "evidence.faceCount");
  }
  if (result === "multiple_faces" && (evidence.faceCount === null || evidence.faceCount < 2)) {
    fail(code, "multiple_faces 扫描结果必须绑定 faceCount>=2", "evidence.faceCount");
  }
}

function parseTrustedOutputEvidence(
  value: unknown,
  admissionId: string,
  assetVersionId: number,
  code: PortraitAssetAdmissionErrorCode,
  field: string,
): PortraitTrustedOutputEvidence {
  const input = record(value, code, field);
  exactKeys(
    input,
    [
      "version",
      "admissionId",
      "assetVersionId",
      "evidenceId",
      "evidenceHash",
      "sourceTaskId",
      "verifiedAt",
      "signature",
    ],
    code,
    field,
  );
  if (input.version !== PORTRAIT_TRUSTED_OUTPUT_EVIDENCE_VERSION) {
    fail(code, "可信输出证据版本无效", `${field}.version`);
  }
  const boundAdmissionId = safeId(input.admissionId, code, `${field}.admissionId`);
  if (boundAdmissionId !== admissionId) {
    fail(
      "portrait_trusted_output_evidence_invalid",
      "可信输出证据未绑定当前准入记录",
      `${field}.admissionId`,
    );
  }
  const boundAssetVersionId = positiveInteger(input.assetVersionId, code, `${field}.assetVersionId`);
  if (boundAssetVersionId !== assetVersionId) {
    fail(
      "portrait_trusted_output_evidence_invalid",
      "可信输出证据未绑定当前资产版本",
      `${field}.assetVersionId`,
    );
  }
  return {
    version: PORTRAIT_TRUSTED_OUTPUT_EVIDENCE_VERSION,
    admissionId: boundAdmissionId,
    assetVersionId: boundAssetVersionId,
    evidenceId: safeId(input.evidenceId, code, `${field}.evidenceId`),
    evidenceHash: hash(input.evidenceHash, code, `${field}.evidenceHash`),
    sourceTaskId: safeId(input.sourceTaskId, code, `${field}.sourceTaskId`),
    verifiedAt: canonicalTimestamp(input.verifiedAt, code, `${field}.verifiedAt`),
    signature: hash(input.signature, code, `${field}.signature`),
  };
}

function trustedOutputSignaturePayload(
  evidence: Omit<PortraitTrustedOutputEvidence, "signature">,
): string {
  return canonicalJson({
    version: evidence.version,
    admissionId: evidence.admissionId,
    assetVersionId: evidence.assetVersionId,
    evidenceId: evidence.evidenceId,
    evidenceHash: evidence.evidenceHash,
    sourceTaskId: evidence.sourceTaskId,
    verifiedAt: evidence.verifiedAt,
  });
}

export function issuePortraitTrustedOutputEvidence(
  rawInput: IssuePortraitTrustedOutputEvidenceInput,
  signingKey: string,
): PortraitTrustedOutputEvidence {
  const input = record(rawInput, "portrait_trusted_output_evidence_invalid", "input");
  exactKeys(
    input,
    ["admissionId", "assetVersionId", "evidenceId", "evidenceHash", "sourceTaskId", "verifiedAt"],
    "portrait_trusted_output_evidence_invalid",
    "input",
  );
  const key = integrityKey(signingKey, "signingKey");
  const unsigned: Omit<PortraitTrustedOutputEvidence, "signature"> = {
    version: PORTRAIT_TRUSTED_OUTPUT_EVIDENCE_VERSION,
    admissionId: safeId(
      input.admissionId,
      "portrait_trusted_output_evidence_invalid",
      "input.admissionId",
    ),
    assetVersionId: positiveInteger(
      input.assetVersionId,
      "portrait_trusted_output_evidence_invalid",
      "input.assetVersionId",
    ),
    evidenceId: safeId(
      input.evidenceId,
      "portrait_trusted_output_evidence_invalid",
      "input.evidenceId",
    ),
    evidenceHash: hash(
      input.evidenceHash,
      "portrait_trusted_output_evidence_invalid",
      "input.evidenceHash",
    ),
    sourceTaskId: safeId(
      input.sourceTaskId,
      "portrait_trusted_output_evidence_invalid",
      "input.sourceTaskId",
    ),
    verifiedAt: canonicalTimestamp(
      input.verifiedAt,
      "portrait_trusted_output_evidence_invalid",
      "input.verifiedAt",
    ),
  };
  return {
    ...unsigned,
    signature: hmacSha256(trustedOutputSignaturePayload(unsigned), key),
  };
}

function assertTrustedOutputEvidenceSignature(
  evidence: PortraitTrustedOutputEvidence,
  verificationKey: unknown,
): void {
  const key = integrityKey(verificationKey, "trustedOutputEvidenceKey");
  const { signature, ...unsigned } = evidence;
  const expected = hmacSha256(trustedOutputSignaturePayload(unsigned), key);
  if (!checksumEqual(signature, expected)) {
    fail(
      "portrait_trusted_output_signature_invalid",
      "可信输出证据签名无效",
      "trustedOutputEvidence.signature",
    );
  }
}

export function verifyPortraitTrustedOutputEvidence(
  rawEvidence: unknown,
  context: { admissionId: string; assetVersionId: number },
  verificationKey: string,
): boolean {
  try {
    const admissionId = safeId(
      context.admissionId,
      "portrait_trusted_output_evidence_invalid",
      "context.admissionId",
    );
    const assetVersionId = positiveInteger(
      context.assetVersionId,
      "portrait_trusted_output_evidence_invalid",
      "context.assetVersionId",
    );
    const evidence = parseTrustedOutputEvidence(
      rawEvidence,
      admissionId,
      assetVersionId,
      "portrait_trusted_output_evidence_invalid",
      "evidence",
    );
    assertTrustedOutputEvidenceSignature(evidence, verificationKey);
    return true;
  } catch (error) {
    if (error instanceof PortraitAssetAdmissionError) return false;
    throw error;
  }
}

function parseLivenessEvidence(
  value: unknown,
  admissionId: string,
  assetVersionId: number,
  code: PortraitAssetAdmissionErrorCode,
  field: string,
): PortraitLivenessEvidence {
  const input = record(value, code, field);
  exactKeys(
    input,
    [
      "version",
      "admissionId",
      "assetVersionId",
      "providerSessionId",
      "evidenceHash",
      "verifiedAt",
      "signature",
    ],
    code,
    field,
  );
  if (input.version !== PORTRAIT_LIVENESS_EVIDENCE_VERSION) {
    fail(code, "LivenessFace 授权证据版本无效", `${field}.version`);
  }
  const boundAdmissionId = safeId(input.admissionId, code, `${field}.admissionId`);
  const boundAssetVersionId = positiveInteger(input.assetVersionId, code, `${field}.assetVersionId`);
  if (boundAdmissionId !== admissionId || boundAssetVersionId !== assetVersionId) {
    fail(
      "portrait_liveness_evidence_invalid",
      "LivenessFace 授权证据未绑定当前准入记录和资产版本",
      field,
    );
  }
  return {
    version: PORTRAIT_LIVENESS_EVIDENCE_VERSION,
    admissionId: boundAdmissionId,
    assetVersionId: boundAssetVersionId,
    providerSessionId: safeId(input.providerSessionId, code, `${field}.providerSessionId`),
    evidenceHash: hash(input.evidenceHash, code, `${field}.evidenceHash`),
    verifiedAt: canonicalTimestamp(input.verifiedAt, code, `${field}.verifiedAt`),
    signature: hash(input.signature, code, `${field}.signature`),
  };
}

function livenessSignaturePayload(
  evidence: Omit<PortraitLivenessEvidence, "signature">,
): string {
  return canonicalJson({
    version: evidence.version,
    admissionId: evidence.admissionId,
    assetVersionId: evidence.assetVersionId,
    providerSessionId: evidence.providerSessionId,
    evidenceHash: evidence.evidenceHash,
    verifiedAt: evidence.verifiedAt,
  });
}

export function issuePortraitLivenessEvidence(
  rawInput: IssuePortraitLivenessEvidenceInput,
  signingKey: string,
): PortraitLivenessEvidence {
  const input = record(rawInput, "portrait_liveness_evidence_invalid", "input");
  exactKeys(
    input,
    ["admissionId", "assetVersionId", "providerSessionId", "evidenceHash", "verifiedAt"],
    "portrait_liveness_evidence_invalid",
    "input",
  );
  const key = integrityKey(signingKey, "signingKey");
  const unsigned: Omit<PortraitLivenessEvidence, "signature"> = {
    version: PORTRAIT_LIVENESS_EVIDENCE_VERSION,
    admissionId: safeId(input.admissionId, "portrait_liveness_evidence_invalid", "input.admissionId"),
    assetVersionId: positiveInteger(
      input.assetVersionId,
      "portrait_liveness_evidence_invalid",
      "input.assetVersionId",
    ),
    providerSessionId: safeId(
      input.providerSessionId,
      "portrait_liveness_evidence_invalid",
      "input.providerSessionId",
    ),
    evidenceHash: hash(
      input.evidenceHash,
      "portrait_liveness_evidence_invalid",
      "input.evidenceHash",
    ),
    verifiedAt: canonicalTimestamp(
      input.verifiedAt,
      "portrait_liveness_evidence_invalid",
      "input.verifiedAt",
    ),
  };
  return {
    ...unsigned,
    signature: hmacSha256(livenessSignaturePayload(unsigned), key),
  };
}

function assertLivenessEvidenceSignature(
  evidence: PortraitLivenessEvidence,
  verificationKey: unknown,
): void {
  const key = integrityKey(verificationKey, "livenessEvidenceKey");
  const { signature, ...unsigned } = evidence;
  const expected = hmacSha256(livenessSignaturePayload(unsigned), key);
  if (!checksumEqual(signature, expected)) {
    fail(
      "portrait_liveness_signature_invalid",
      "LivenessFace 授权证据签名无效",
      "livenessEvidence.signature",
    );
  }
}

export function verifyPortraitLivenessEvidence(
  rawEvidence: unknown,
  context: { admissionId: string; assetVersionId: number },
  verificationKey: string,
): boolean {
  try {
    const admissionId = safeId(
      context.admissionId,
      "portrait_liveness_evidence_invalid",
      "context.admissionId",
    );
    const assetVersionId = positiveInteger(
      context.assetVersionId,
      "portrait_liveness_evidence_invalid",
      "context.assetVersionId",
    );
    const evidence = parseLivenessEvidence(
      rawEvidence,
      admissionId,
      assetVersionId,
      "portrait_liveness_evidence_invalid",
      "evidence",
    );
    assertLivenessEvidenceSignature(evidence, verificationKey);
    return true;
  } catch (error) {
    if (error instanceof PortraitAssetAdmissionError) return false;
    throw error;
  }
}

function parseUserDeclaration(
  value: unknown,
  code: PortraitAssetAdmissionErrorCode,
  field: string,
): PortraitUserDeclaration {
  const input = record(value, code, field);
  if (input.subjectKind === "GroupType") {
    fail(
      "portrait_group_type_user_forbidden",
      "GroupType 只能由系统派生，用户不得选择",
      `${field}.subjectKind`,
    );
  }
  if (input.subjectKind === "trusted_output") {
    fail(
      "portrait_trusted_output_not_user_declarable",
      "可信输出必须由第一方任务证据判定，不能由用户声明",
      `${field}.subjectKind`,
    );
  }
  exactKeys(
    input,
    [
      "version",
      "subjectKind",
      "rightsConfirmed",
      "authorizationEvidenceId",
      "evidenceHash",
      "termsVersion",
      "declaredByUserId",
      "declaredAt",
      "revokedAt",
    ],
    code,
    field,
  );
  if (input.version !== PORTRAIT_USER_DECLARATION_VERSION) {
    fail(code, "用户声明版本无效", `${field}.version`);
  }
  const subjectKind = enumValue(
    input.subjectKind,
    ["real_person", "virtual_person"] as const,
    code,
    `${field}.subjectKind`,
  );
  if (input.rightsConfirmed !== true) {
    fail(
      "portrait_rights_attestation_required",
      "真人或虚拟人物素材必须确认权利声明",
      `${field}.rightsConfirmed`,
    );
  }
  const revokedAt = input.revokedAt === null
    ? null
    : canonicalTimestamp(input.revokedAt, code, `${field}.revokedAt`);
  return {
    version: PORTRAIT_USER_DECLARATION_VERSION,
    subjectKind,
    rightsConfirmed: true,
    authorizationEvidenceId: safeId(
      input.authorizationEvidenceId,
      "portrait_authorization_evidence_required",
      `${field}.authorizationEvidenceId`,
    ),
    evidenceHash: hash(input.evidenceHash, code, `${field}.evidenceHash`),
    termsVersion: safeId(input.termsVersion, code, `${field}.termsVersion`),
    declaredByUserId: positiveInteger(input.declaredByUserId, code, `${field}.declaredByUserId`),
    declaredAt: canonicalTimestamp(input.declaredAt, code, `${field}.declaredAt`),
    revokedAt,
  };
}

function parseModeration(
  value: unknown,
  code: PortraitAssetAdmissionErrorCode,
  field: string,
): PortraitModerationDecision {
  const input = record(value, code, field);
  exactKeys(input, ["state", "evidenceHash", "reasonCode", "decidedAt"], code, field);
  const state = enumValue(input.state, PORTRAIT_MODERATION_STATES, code, `${field}.state`);
  if (state === "pending") {
    if (input.evidenceHash !== null || input.reasonCode !== null || input.decidedAt !== null) {
      fail(code, "待审核状态不能提前携带审核结果", field);
    }
    return { state, evidenceHash: null, reasonCode: null, decidedAt: null };
  }
  const evidenceHash = hash(input.evidenceHash, code, `${field}.evidenceHash`);
  const decidedAt = canonicalTimestamp(input.decidedAt, code, `${field}.decidedAt`);
  if (state === "allowed") {
    if (input.reasonCode !== null) fail(code, "审核通过不能携带拒绝原因", `${field}.reasonCode`);
    return { state, evidenceHash, reasonCode: null, decidedAt };
  }
  return {
    state,
    evidenceHash,
    reasonCode: safeErrorCode(input.reasonCode, code, `${field}.reasonCode`),
    decidedAt,
  };
}

function parseProviderBinding(
  value: unknown,
  code: PortraitAssetAdmissionErrorCode,
  field: string,
): PortraitProviderBinding {
  const input = record(value, code, field);
  exactKeys(input, ["providerAssetId", "providerAssetUri", "activeAt"], code, field);
  return {
    providerAssetId: safeId(input.providerAssetId, code, `${field}.providerAssetId`),
    providerAssetUri: safeId(input.providerAssetUri, code, `${field}.providerAssetUri`),
    activeAt: canonicalTimestamp(input.activeAt, code, `${field}.activeAt`),
  };
}

function timestampAtOrAfter(
  value: string,
  lowerBound: string,
  code: PortraitAssetAdmissionErrorCode,
  field: string,
): void {
  if (Date.parse(value) < Date.parse(lowerBound)) {
    fail(code, `${field} 早于允许的状态时间`, field);
  }
}

export function canTransitionPortraitFaceScan(
  from: PortraitFaceScanState,
  to: PortraitFaceScanState,
): boolean {
  return (PORTRAIT_FACE_SCAN_TRANSITIONS[from] as readonly PortraitFaceScanState[]).includes(to);
}

export function canTransitionPortraitProviderSync(
  from: PortraitProviderSyncState,
  to: PortraitProviderSyncState,
): boolean {
  return (
    PORTRAIT_PROVIDER_SYNC_TRANSITIONS[from] as readonly PortraitProviderSyncState[]
  ).includes(to);
}

export function canTransitionPortraitCompliance(
  from: PortraitComplianceState,
  to: PortraitComplianceState,
): boolean {
  return (
    PORTRAIT_COMPLIANCE_TRANSITIONS[from] as readonly PortraitComplianceState[]
  ).includes(to);
}

function assertTransition(
  allowed: boolean,
  from: string,
  to: string,
  field: string,
): void {
  if (!allowed) {
    fail(
      "portrait_invalid_state_transition",
      `不允许 ${field} 从 ${from} 转换到 ${to}`,
      field,
    );
  }
}

export function resolvePortraitProviderGroupType(
  subjectKind: PortraitSubjectKind,
): PortraitProviderGroupType | null {
  if (subjectKind === "real_person") return "LivenessFace";
  if (subjectKind === "virtual_person" || subjectKind === "trusted_output") return "AIGC";
  return null;
}

function errorForFaceScan(faceScanState: PortraitFaceScanState): PortraitAssetAdmissionErrorCode {
  if (faceScanState === "multiple_faces") return "portrait_multiple_faces_not_supported";
  if (faceScanState === "uncertain") return "portrait_face_scan_uncertain";
  if (faceScanState === "failed") return "portrait_face_scan_failed";
  return "portrait_face_scan_required";
}

function deriveSafeErrorCode(
  state: Pick<PortraitAssetAdmissionState,
  | "faceScanState"
  | "subjectKind"
  | "moderation"
  | "complianceState"
  | "providerSyncState">,
): PortraitAssetAdmissionErrorCode | null {
  if (["queued", "scanning"].includes(state.faceScanState)) return "portrait_face_scan_required";
  if (["multiple_faces", "uncertain", "failed"].includes(state.faceScanState)) {
    return errorForFaceScan(state.faceScanState);
  }
  if (state.complianceState === "denied" || state.moderation.state === "denied") {
    return "portrait_moderation_denied";
  }
  if (state.complianceState === "expired") return "portrait_compliance_expired";
  if (state.complianceState === "revoked") return "portrait_compliance_revoked";
  if (state.faceScanState === "single_face" && state.subjectKind === "pending") {
    return "portrait_declaration_required";
  }
  if (state.moderation.state !== "allowed") return "portrait_moderation_required";
  if (state.complianceState === "allowed" && state.providerSyncState === "failed") {
    return "portrait_provider_sync_failed";
  }
  if (state.complianceState === "allowed" && state.providerSyncState !== "active") {
    return "portrait_provider_sync_required";
  }
  return null;
}

function normalizedAfterEvidence(
  state: PortraitAssetAdmissionState,
): PortraitAssetAdmissionState {
  if (state.moderation.state === "denied") {
    return {
      ...state,
      complianceState: "denied",
      providerSyncState: state.providerSyncState === "not_needed" ? "not_needed" : "stale",
      providerBinding: null,
      safeErrorCode: "portrait_moderation_denied",
    };
  }
  if (state.faceScanState === "no_face") {
    const complianceState: PortraitComplianceState = state.moderation.state === "allowed"
      ? "not_required"
      : "pending";
    const next: PortraitAssetAdmissionState = {
      ...state,
      subjectKind: "ordinary" as const,
      declarationState: "not_required" as const,
      complianceState,
      providerGroupType: null,
      providerSyncState: "not_needed" as const,
      livenessEvidence: null,
      providerBinding: null,
      providerAttempt: 0,
      providerErrorCode: null,
    };
    return { ...next, safeErrorCode: deriveSafeErrorCode(next) };
  }
  if (state.faceScanState !== "single_face") return state;
  const subjectKind: PortraitSubjectKind = state.trustedOutputEvidence?.assetVersionId === state.assetVersionId
    ? "trusted_output"
    : state.userDeclaration?.subjectKind ?? "pending";
  const declarationState: PortraitDeclarationState = state.trustedOutputEvidence
    ? "not_required"
    : state.userDeclaration
      ? state.userDeclaration.revokedAt ? "revoked" : "confirmed"
      : "pending";
  const providerGroupType = resolvePortraitProviderGroupType(subjectKind);
  let complianceState: PortraitComplianceState = "pending";
  let providerSyncState: PortraitProviderSyncState = state.providerSyncState;
  if (declarationState === "revoked") {
    complianceState = "revoked";
    providerSyncState = providerSyncState === "not_needed" ? "not_needed" : "stale";
  } else if (subjectKind !== "pending" && state.moderation.state === "allowed") {
    complianceState = "allowed";
    if (providerSyncState === "not_needed") providerSyncState = "queued";
  }
  const next: PortraitAssetAdmissionState = {
    ...state,
    subjectKind,
    declarationState,
    complianceState,
    providerGroupType,
    providerSyncState,
  };
  return { ...next, safeErrorCode: deriveSafeErrorCode(next) };
}

export function createPortraitAssetAdmission(
  rawInput: CreatePortraitAssetAdmissionInput,
): PortraitAssetAdmissionState {
  const input = record(rawInput, "portrait_input_invalid", "input");
  exactKeysWithOptional(
    input,
    ["admissionId", "assetVersionId", "createdAt"],
    [],
    "portrait_input_invalid",
    "input",
  );
  const createdAt = canonicalTimestamp(input.createdAt, "portrait_input_invalid", "input.createdAt");
  return {
    version: PORTRAIT_ASSET_ADMISSION_VERSION,
    admissionId: safeId(input.admissionId, "portrait_input_invalid", "input.admissionId"),
    assetVersionId: positiveInteger(
      input.assetVersionId,
      "portrait_input_invalid",
      "input.assetVersionId",
    ),
    faceScanState: "queued",
    faceScanEvidence: null,
    subjectKind: "pending",
    declarationState: "pending",
    userDeclaration: null,
    trustedOutputEvidence: null,
    moderation: { state: "pending", evidenceHash: null, reasonCode: null, decidedAt: null },
    complianceState: "pending",
    providerGroupType: null,
    providerSyncState: "not_needed",
    livenessEvidence: null,
    providerBinding: null,
    providerAttempt: 0,
    providerErrorCode: null,
    safeErrorCode: "portrait_face_scan_required",
    revision: 1,
    createdAt,
    updatedAt: createdAt,
  };
}

function parseEvent(rawEvent: PortraitAssetAdmissionEvent): PortraitAssetAdmissionEvent {
  const event = record(rawEvent, "portrait_event_invalid", "event");
  const type = event.type;
  if (typeof type !== "string") fail("portrait_event_invalid", "event.type 无效", "event.type");
  const base = ["type", "occurredAt"] as const;
  if ([
    "start_face_scan",
    "provider_authorization_started",
    "provider_group_creation_started",
    "provider_group_ready",
    "mark_provider_sync_stale",
    "retry_provider_sync",
    "expire_compliance",
    "revoke_compliance",
  ].includes(type)) {
    exactKeys(event, base, "portrait_event_invalid", "event");
    return ({
      type,
      occurredAt: canonicalTimestamp(event.occurredAt, "portrait_event_invalid", "event.occurredAt"),
    }) as PortraitAssetAdmissionEvent;
  }
  if (type === "complete_face_scan") {
    exactKeys(event, ["type", "result", "evidence", "occurredAt"], "portrait_event_invalid", "event");
    const result = enumValue(
      event.result,
      ["no_face", "single_face", "multiple_faces", "uncertain"] as const,
      "portrait_event_invalid",
      "event.result",
    );
    const evidence = parseFaceScanEvidence(event.evidence, "portrait_event_invalid", "event.evidence");
    assertFaceCount(result, evidence, "portrait_event_invalid");
    return {
      type,
      result,
      evidence,
      occurredAt: canonicalTimestamp(event.occurredAt, "portrait_event_invalid", "event.occurredAt"),
    };
  }
  if (type === "fail_face_scan" || type === "provider_sync_failed") {
    exactKeys(event, ["type", "reasonCode", "occurredAt"], "portrait_event_invalid", "event");
    return {
      type,
      reasonCode: safeErrorCode(event.reasonCode, "portrait_event_invalid", "event.reasonCode"),
      occurredAt: canonicalTimestamp(event.occurredAt, "portrait_event_invalid", "event.occurredAt"),
    };
  }
  if (type === "declare_subject") {
    rejectUserSelectedProviderGroupType(event, "event");
    if (event.subjectKind === "GroupType") {
      fail(
        "portrait_group_type_user_forbidden",
        "GroupType 只能由系统根据主体类型派生，用户不得选择",
        "event.subjectKind",
      );
    }
    if (event.subjectKind === "trusted_output") {
      fail(
        "portrait_trusted_output_not_user_declarable",
        "可信输出不能由用户声明",
        "event.subjectKind",
      );
    }
    exactKeys(
      event,
      [
        "type",
        "subjectKind",
        "rightsConfirmed",
        "authorizationEvidenceId",
        "evidenceHash",
        "termsVersion",
        "declaredByUserId",
        "occurredAt",
      ],
      "portrait_event_invalid",
      "event",
    );
    const subjectKind = enumValue(
      event.subjectKind,
      ["real_person", "virtual_person"] as const,
      "portrait_event_invalid",
      "event.subjectKind",
    );
    if (event.rightsConfirmed !== true) {
      fail(
        "portrait_rights_attestation_required",
        "真人或虚拟人物素材必须确认权利声明",
        "event.rightsConfirmed",
      );
    }
    return {
      type,
      subjectKind,
      rightsConfirmed: true,
      authorizationEvidenceId: safeId(
        event.authorizationEvidenceId,
        "portrait_authorization_evidence_required",
        "event.authorizationEvidenceId",
      ),
      evidenceHash: hash(event.evidenceHash, "portrait_event_invalid", "event.evidenceHash"),
      termsVersion: safeId(event.termsVersion, "portrait_event_invalid", "event.termsVersion"),
      declaredByUserId: positiveInteger(
        event.declaredByUserId,
        "portrait_event_invalid",
        "event.declaredByUserId",
      ),
      occurredAt: canonicalTimestamp(event.occurredAt, "portrait_event_invalid", "event.occurredAt"),
    };
  }
  if (type === "attest_trusted_output") {
    exactKeys(event, ["type", "evidence", "occurredAt"], "portrait_event_invalid", "event");
    const occurredAt = canonicalTimestamp(event.occurredAt, "portrait_event_invalid", "event.occurredAt");
    const evidenceRow = record(event.evidence, "portrait_event_invalid", "event.evidence");
    return {
      type,
      evidence: evidenceRow as unknown as PortraitTrustedOutputEvidence,
      occurredAt,
    };
  }
  if (type === "provider_authorization_succeeded") {
    exactKeys(event, ["type", "evidence", "occurredAt"], "portrait_event_invalid", "event");
    return {
      type,
      evidence: record(
        event.evidence,
        "portrait_event_invalid",
        "event.evidence",
      ) as unknown as PortraitLivenessEvidence,
      occurredAt: canonicalTimestamp(event.occurredAt, "portrait_event_invalid", "event.occurredAt"),
    };
  }
  if (type === "moderation_allowed") {
    exactKeys(event, ["type", "evidenceHash", "occurredAt"], "portrait_event_invalid", "event");
    return {
      type,
      evidenceHash: hash(event.evidenceHash, "portrait_event_invalid", "event.evidenceHash"),
      occurredAt: canonicalTimestamp(event.occurredAt, "portrait_event_invalid", "event.occurredAt"),
    };
  }
  if (type === "moderation_denied") {
    exactKeys(
      event,
      ["type", "evidenceHash", "reasonCode", "occurredAt"],
      "portrait_event_invalid",
      "event",
    );
    return {
      type,
      evidenceHash: hash(event.evidenceHash, "portrait_event_invalid", "event.evidenceHash"),
      reasonCode: safeErrorCode(event.reasonCode, "portrait_event_invalid", "event.reasonCode"),
      occurredAt: canonicalTimestamp(event.occurredAt, "portrait_event_invalid", "event.occurredAt"),
    };
  }
  if (type === "provider_asset_activated") {
    exactKeys(
      event,
      ["type", "providerAssetId", "providerAssetUri", "observedGroupType", "occurredAt"],
      "portrait_event_invalid",
      "event",
    );
    return {
      type,
      providerAssetId: safeId(event.providerAssetId, "portrait_event_invalid", "event.providerAssetId"),
      providerAssetUri: safeId(event.providerAssetUri, "portrait_event_invalid", "event.providerAssetUri"),
      observedGroupType: enumValue(
        event.observedGroupType,
        PORTRAIT_PROVIDER_GROUP_TYPES,
        "portrait_event_invalid",
        "event.observedGroupType",
      ),
      occurredAt: canonicalTimestamp(event.occurredAt, "portrait_event_invalid", "event.occurredAt"),
    };
  }
  fail("portrait_event_invalid", "未知的肖像资产状态事件", "event.type");
}

function eventTime(event: PortraitAssetAdmissionEvent): string {
  return event.occurredAt;
}

function nextRevision(
  state: PortraitAssetAdmissionState,
  occurredAt: string,
): Pick<PortraitAssetAdmissionState, "revision" | "updatedAt"> {
  timestampAtOrAfter(
    occurredAt,
    state.updatedAt,
    "portrait_event_time_invalid",
    "event.occurredAt",
  );
  return { revision: state.revision + 1, updatedAt: occurredAt };
}

function assertMutable(state: PortraitAssetAdmissionState): void {
  if (["denied", "expired", "revoked"].includes(state.complianceState)) {
    fail(
      "portrait_invalid_state_transition",
      `合规终态 ${state.complianceState} 不可逆`,
      "complianceState",
    );
  }
}

export function transitionPortraitAssetAdmission(
  rawState: PortraitAssetAdmissionState,
  rawEvent: PortraitAssetAdmissionEvent,
  options: PortraitAssetAdmissionTransitionOptions = {},
): PortraitAssetAdmissionState {
  const state = parsePortraitAssetAdmission(rawState);
  if (state.trustedOutputEvidence) {
    assertTrustedOutputEvidenceSignature(
      state.trustedOutputEvidence,
      options.trustedOutputEvidenceKey,
    );
  }
  if (state.livenessEvidence) {
    assertLivenessEvidenceSignature(state.livenessEvidence, options.livenessEvidenceKey);
  }
  const event = parseEvent(rawEvent);
  const clock = nextRevision(state, eventTime(event));

  if (event.type === "start_face_scan") {
    assertTransition(
      canTransitionPortraitFaceScan(state.faceScanState, "scanning"),
      state.faceScanState,
      "scanning",
      "faceScanState",
    );
    return parsePortraitAssetAdmission({
      ...state,
      faceScanState: "scanning",
      safeErrorCode: "portrait_face_scan_required",
      ...clock,
    });
  }

  if (event.type === "complete_face_scan") {
    assertTransition(
      canTransitionPortraitFaceScan(state.faceScanState, event.result),
      state.faceScanState,
      event.result,
      "faceScanState",
    );
    let next: PortraitAssetAdmissionState = {
      ...state,
      faceScanState: event.result,
      faceScanEvidence: event.evidence,
      ...clock,
    };
    if (event.result === "no_face") {
      next = normalizedAfterEvidence({
        ...next,
        subjectKind: "ordinary",
        declarationState: "not_required",
      });
    } else if (event.result === "single_face") {
      next = normalizedAfterEvidence(next);
    } else {
      const subjectKind = event.result === "multiple_faces" ? "multiple_faces" : "ambiguous";
      next = {
        ...next,
        subjectKind,
        declarationState: "not_required",
        complianceState: "denied",
        providerGroupType: null,
        providerSyncState: "not_needed",
        livenessEvidence: null,
        providerBinding: null,
        providerAttempt: 0,
        providerErrorCode: null,
        safeErrorCode: errorForFaceScan(event.result),
      };
    }
    return parsePortraitAssetAdmission(next);
  }

  if (event.type === "fail_face_scan") {
    assertTransition(
      canTransitionPortraitFaceScan(state.faceScanState, "failed"),
      state.faceScanState,
      "failed",
      "faceScanState",
    );
    return parsePortraitAssetAdmission({
      ...state,
      faceScanState: "failed",
      subjectKind: "ambiguous",
      declarationState: "not_required",
      complianceState: "denied",
      providerSyncState: "not_needed",
      livenessEvidence: null,
      providerErrorCode: null,
      safeErrorCode: "portrait_face_scan_failed",
      ...clock,
    });
  }

  assertMutable(state);

  if (event.type === "declare_subject") {
    if (
      state.faceScanState !== "single_face"
      || state.subjectKind !== "pending"
      || state.userDeclaration !== null
      || state.trustedOutputEvidence !== null
    ) {
      fail(
        "portrait_declaration_conflict",
        "只有单人脸且尚未分类的素材可以提交用户声明",
        "subjectKind",
      );
    }
    const userDeclaration: PortraitUserDeclaration = {
      version: PORTRAIT_USER_DECLARATION_VERSION,
      subjectKind: event.subjectKind,
      rightsConfirmed: true,
      authorizationEvidenceId: event.authorizationEvidenceId,
      evidenceHash: event.evidenceHash,
      termsVersion: event.termsVersion,
      declaredByUserId: event.declaredByUserId,
      declaredAt: event.occurredAt,
      revokedAt: null,
    };
    return parsePortraitAssetAdmission(normalizedAfterEvidence({
      ...state,
      userDeclaration,
      subjectKind: event.subjectKind,
      declarationState: "confirmed",
      ...clock,
    }));
  }

  if (event.type === "attest_trusted_output") {
    if (
      state.faceScanState !== "single_face"
      || state.subjectKind !== "pending"
      || state.userDeclaration !== null
      || state.trustedOutputEvidence !== null
    ) {
      fail(
        "portrait_declaration_conflict",
        "可信输出证据只能绑定尚未分类的单人脸素材",
        "subjectKind",
      );
    }
    const evidence = parseTrustedOutputEvidence(
      event.evidence,
      state.admissionId,
      state.assetVersionId,
      "portrait_trusted_output_evidence_invalid",
      "event.evidence",
    );
    assertTrustedOutputEvidenceSignature(evidence, options.trustedOutputEvidenceKey);
    if (Date.parse(evidence.verifiedAt) > Date.parse(event.occurredAt)) {
      fail(
        "portrait_trusted_output_evidence_invalid",
        "可信输出证据的验证时间不能晚于状态事件",
        "event.evidence.verifiedAt",
      );
    }
    return parsePortraitAssetAdmission(normalizedAfterEvidence({
      ...state,
      trustedOutputEvidence: evidence,
      subjectKind: "trusted_output",
      declarationState: "not_required",
      ...clock,
    }));
  }

  if (event.type === "moderation_allowed" || event.type === "moderation_denied") {
    if (!["no_face", "single_face"].includes(state.faceScanState)
      || state.moderation.state !== "pending") {
      fail(
        "portrait_invalid_state_transition",
        "当前状态不能写入内容审核决定",
        "moderation.state",
      );
    }
    const moderation: PortraitModerationDecision = event.type === "moderation_allowed"
      ? {
        state: "allowed",
        evidenceHash: event.evidenceHash,
        reasonCode: null,
        decidedAt: event.occurredAt,
      }
      : {
        state: "denied",
        evidenceHash: event.evidenceHash,
        reasonCode: event.reasonCode,
        decidedAt: event.occurredAt,
      };
    return parsePortraitAssetAdmission(normalizedAfterEvidence({
      ...state,
      moderation,
      ...clock,
    }));
  }

  if (event.type === "provider_authorization_started") {
    if (state.subjectKind !== "real_person" || state.providerGroupType !== "LivenessFace") {
      fail(
        "portrait_provider_sync_not_allowed",
        "只有真人素材可以进入 LivenessFace 授权",
        "providerSyncState",
      );
    }
    if (state.complianceState !== "allowed") {
      fail("portrait_provider_sync_not_allowed", "合规未通过，不能同步供应商资产", "complianceState");
    }
    assertTransition(
      canTransitionPortraitProviderSync(state.providerSyncState, "authorizing"),
      state.providerSyncState,
      "authorizing",
      "providerSyncState",
    );
    return parsePortraitAssetAdmission({
      ...state,
      providerSyncState: "authorizing",
      livenessEvidence: null,
      providerAttempt: state.providerAttempt + 1,
      providerErrorCode: null,
      safeErrorCode: "portrait_provider_sync_required",
      ...clock,
    });
  }

  if (event.type === "provider_authorization_succeeded") {
    if (
      state.subjectKind !== "real_person"
      || state.providerGroupType !== "LivenessFace"
      || state.complianceState !== "allowed"
    ) {
      fail(
        "portrait_provider_sync_not_allowed",
        "只有合规有效的真人素材可以完成 LivenessFace 授权",
        "providerSyncState",
      );
    }
    assertTransition(
      canTransitionPortraitProviderSync(state.providerSyncState, "creating_group"),
      state.providerSyncState,
      "creating_group",
      "providerSyncState",
    );
    const evidence = parseLivenessEvidence(
      event.evidence,
      state.admissionId,
      state.assetVersionId,
      "portrait_liveness_evidence_invalid",
      "event.evidence",
    );
    assertLivenessEvidenceSignature(evidence, options.livenessEvidenceKey);
    if (Date.parse(evidence.verifiedAt) > Date.parse(event.occurredAt)) {
      fail(
        "portrait_liveness_evidence_invalid",
        "LivenessFace 授权证据验证时间不能晚于状态事件",
        "event.evidence.verifiedAt",
      );
    }
    return parsePortraitAssetAdmission({
      ...state,
      providerSyncState: "creating_group",
      livenessEvidence: evidence,
      providerErrorCode: null,
      safeErrorCode: "portrait_provider_sync_required",
      ...clock,
    });
  }

  if (event.type === "provider_group_creation_started") {
    if (state.complianceState !== "allowed" || state.providerGroupType === null) {
      fail("portrait_provider_sync_not_allowed", "合规未通过，不能创建供应商资产组", "complianceState");
    }
    if (state.subjectKind === "real_person") {
      fail(
        "portrait_provider_sync_not_allowed",
        "真人素材必须通过携带验证证据的授权成功事件推进",
        "providerSyncState",
      );
    }
    assertTransition(
      canTransitionPortraitProviderSync(state.providerSyncState, "creating_group"),
      state.providerSyncState,
      "creating_group",
      "providerSyncState",
    );
    return parsePortraitAssetAdmission({
      ...state,
      providerSyncState: "creating_group",
      providerAttempt: state.providerSyncState === "queued"
        ? state.providerAttempt + 1
        : state.providerAttempt,
      providerErrorCode: null,
      safeErrorCode: "portrait_provider_sync_required",
      ...clock,
    });
  }

  if (event.type === "provider_group_ready") {
    if (state.complianceState !== "allowed") {
      fail("portrait_provider_sync_not_allowed", "合规未通过，不能创建供应商资产", "complianceState");
    }
    assertTransition(
      canTransitionPortraitProviderSync(state.providerSyncState, "processing"),
      state.providerSyncState,
      "processing",
      "providerSyncState",
    );
    return parsePortraitAssetAdmission({
      ...state,
      providerSyncState: "processing",
      safeErrorCode: "portrait_provider_sync_required",
      ...clock,
    });
  }

  if (event.type === "provider_asset_activated") {
    if (state.complianceState !== "allowed" || state.providerGroupType === null) {
      fail("portrait_provider_sync_not_allowed", "合规未通过，不能激活供应商资产", "complianceState");
    }
    if (event.observedGroupType !== state.providerGroupType) {
      fail(
        "portrait_provider_type_mismatch",
        "供应商返回的资产组类型与系统派生类型不一致",
        "event.observedGroupType",
      );
    }
    assertTransition(
      canTransitionPortraitProviderSync(state.providerSyncState, "active"),
      state.providerSyncState,
      "active",
      "providerSyncState",
    );
    return parsePortraitAssetAdmission({
      ...state,
      providerSyncState: "active",
      providerBinding: {
        providerAssetId: event.providerAssetId,
        providerAssetUri: event.providerAssetUri,
        activeAt: event.occurredAt,
      },
      providerErrorCode: null,
      safeErrorCode: null,
      ...clock,
    });
  }

  if (event.type === "provider_sync_failed") {
    if (state.complianceState !== "allowed" || ![
      "queued",
      "authorizing",
      "creating_group",
      "processing",
    ].includes(state.providerSyncState)) {
      fail(
        "portrait_provider_sync_not_allowed",
        "当前状态不能记录供应商同步失败",
        "providerSyncState",
      );
    }
    assertTransition(
      canTransitionPortraitProviderSync(state.providerSyncState, "failed"),
      state.providerSyncState,
      "failed",
      "providerSyncState",
    );
    return parsePortraitAssetAdmission({
      ...state,
      providerSyncState: "failed",
      providerBinding: null,
      providerAttempt: state.providerSyncState === "queued"
        ? state.providerAttempt + 1
        : state.providerAttempt,
      providerErrorCode: event.reasonCode,
      safeErrorCode: "portrait_provider_sync_failed",
      ...clock,
    });
  }

  if (event.type === "mark_provider_sync_stale") {
    if (state.complianceState !== "allowed" || state.providerSyncState === "not_needed") {
      fail(
        "portrait_provider_sync_not_allowed",
        "只有合规有效且已建立同步流程的肖像资产可以标记为陈旧",
        "providerSyncState",
      );
    }
    assertTransition(
      canTransitionPortraitProviderSync(state.providerSyncState, "stale"),
      state.providerSyncState,
      "stale",
      "providerSyncState",
    );
    return parsePortraitAssetAdmission({
      ...state,
      providerSyncState: "stale",
      providerBinding: null,
      livenessEvidence: null,
      providerErrorCode: null,
      safeErrorCode: "portrait_provider_sync_required",
      ...clock,
    });
  }

  if (event.type === "retry_provider_sync") {
    if (state.complianceState !== "allowed" || !["failed", "stale"].includes(state.providerSyncState)) {
      fail(
        "portrait_provider_sync_not_allowed",
        "只有合规有效的失败或陈旧绑定可以重试",
        "providerSyncState",
      );
    }
    assertTransition(
      canTransitionPortraitProviderSync(state.providerSyncState, "queued"),
      state.providerSyncState,
      "queued",
      "providerSyncState",
    );
    return parsePortraitAssetAdmission({
      ...state,
      providerSyncState: "queued",
      providerBinding: null,
      livenessEvidence: null,
      providerErrorCode: null,
      safeErrorCode: "portrait_provider_sync_required",
      ...clock,
    });
  }

  if (event.type === "expire_compliance" || event.type === "revoke_compliance") {
    if (state.complianceState !== "allowed") {
      fail(
        "portrait_invalid_state_transition",
        "只有已通过的肖像合规决定可以失效或撤销",
        "complianceState",
      );
    }
    const complianceState = event.type === "expire_compliance" ? "expired" : "revoked";
    assertTransition(
      canTransitionPortraitCompliance(state.complianceState, complianceState),
      state.complianceState,
      complianceState,
      "complianceState",
    );
    const userDeclaration = event.type === "revoke_compliance" && state.userDeclaration
      ? { ...state.userDeclaration, revokedAt: event.occurredAt }
      : state.userDeclaration;
    return parsePortraitAssetAdmission({
      ...state,
      complianceState,
      declarationState: event.type === "revoke_compliance" && userDeclaration
        ? "revoked"
        : state.declarationState,
      userDeclaration,
      providerSyncState: state.providerSyncState === "not_needed" ? "not_needed" : "stale",
      providerBinding: null,
      safeErrorCode: event.type === "expire_compliance"
        ? "portrait_compliance_expired"
        : "portrait_compliance_revoked",
      ...clock,
    });
  }

  return fail("portrait_event_invalid", "未知的肖像资产状态事件", "event.type");
}

const STATE_KEYS = [
  "version",
  "admissionId",
  "assetVersionId",
  "faceScanState",
  "faceScanEvidence",
  "subjectKind",
  "declarationState",
  "userDeclaration",
  "trustedOutputEvidence",
  "moderation",
  "complianceState",
  "providerGroupType",
  "providerSyncState",
  "livenessEvidence",
  "providerBinding",
  "providerAttempt",
  "providerErrorCode",
  "safeErrorCode",
  "revision",
  "createdAt",
  "updatedAt",
] as const;

function validateStateInvariants(state: PortraitAssetAdmissionState): void {
  timestampAtOrAfter(state.updatedAt, state.createdAt, "portrait_state_invalid", "updatedAt");
  if (state.faceScanEvidence) {
    if (!["no_face", "single_face", "multiple_faces", "uncertain"].includes(state.faceScanState)) {
      fail("portrait_state_invalid", "当前人脸扫描状态不能携带扫描证据", "faceScanEvidence");
    }
    assertFaceCount(
      state.faceScanState as "no_face" | "single_face" | "multiple_faces" | "uncertain",
      state.faceScanEvidence,
      "portrait_state_invalid",
    );
  } else if (["no_face", "single_face", "multiple_faces", "uncertain"].includes(state.faceScanState)) {
    fail("portrait_state_invalid", "完成的人脸扫描状态缺少证据", "faceScanEvidence");
  }

  const expectedSubject: PortraitSubjectKind = state.faceScanState === "no_face"
    ? "ordinary"
    : state.faceScanState === "multiple_faces"
      ? "multiple_faces"
      : ["uncertain", "failed"].includes(state.faceScanState)
        ? "ambiguous"
        : state.faceScanState === "single_face"
          ? state.trustedOutputEvidence
            ? "trusted_output"
            : state.userDeclaration?.subjectKind ?? "pending"
          : "pending";
  if (state.subjectKind !== expectedSubject) {
    fail("portrait_state_invalid", "subjectKind 与扫描/声明证据不一致", "subjectKind");
  }

  if (state.userDeclaration) {
    if (state.faceScanState !== "single_face" || state.trustedOutputEvidence) {
      fail("portrait_state_invalid", "用户声明只能绑定单人脸且不能覆盖可信输出证据", "userDeclaration");
    }
    timestampAtOrAfter(
      state.userDeclaration.declaredAt,
      state.createdAt,
      "portrait_state_invalid",
      "userDeclaration.declaredAt",
    );
    if (Date.parse(state.userDeclaration.declaredAt) > Date.parse(state.updatedAt)) {
      fail("portrait_state_invalid", "用户声明时间晚于状态更新时间", "userDeclaration.declaredAt");
    }
  }
  if (state.trustedOutputEvidence) {
    if (state.faceScanState !== "single_face" || state.userDeclaration) {
      fail("portrait_state_invalid", "可信输出证据只能独占绑定单人脸素材", "trustedOutputEvidence");
    }
    if (Date.parse(state.trustedOutputEvidence.verifiedAt) > Date.parse(state.updatedAt)) {
      fail("portrait_state_invalid", "可信输出证据验证时间晚于状态更新时间", "trustedOutputEvidence.verifiedAt");
    }
    timestampAtOrAfter(
      state.trustedOutputEvidence.verifiedAt,
      state.createdAt,
      "portrait_state_invalid",
      "trustedOutputEvidence.verifiedAt",
    );
  }

  const expectedDeclarationState: PortraitDeclarationState = state.faceScanState === "single_face"
    ? state.trustedOutputEvidence
      ? "not_required"
      : state.userDeclaration
        ? state.userDeclaration.revokedAt ? "revoked" : "confirmed"
        : "pending"
    : ["queued", "scanning"].includes(state.faceScanState)
      ? "pending"
      : "not_required";
  if (state.declarationState !== expectedDeclarationState) {
    fail("portrait_state_invalid", "declarationState 与证据不一致", "declarationState");
  }
  if (
    state.userDeclaration?.revokedAt
    && (
      state.complianceState !== "revoked"
      || state.providerSyncState !== "stale"
      || state.providerBinding !== null
    )
  ) {
    fail(
      "portrait_state_invalid",
      "已撤销的权利声明必须立即撤销合规并使供应商绑定失效",
      "userDeclaration.revokedAt",
    );
  }
  if (state.userDeclaration?.revokedAt) {
    timestampAtOrAfter(
      state.userDeclaration.revokedAt,
      state.userDeclaration.declaredAt,
      "portrait_state_invalid",
      "userDeclaration.revokedAt",
    );
    if (Date.parse(state.userDeclaration.revokedAt) > Date.parse(state.updatedAt)) {
      fail("portrait_state_invalid", "权利撤销时间晚于状态更新时间", "userDeclaration.revokedAt");
    }
  }

  const expectedGroupType = resolvePortraitProviderGroupType(state.subjectKind);
  if (state.providerGroupType !== expectedGroupType) {
    if ((state.providerGroupType as unknown) === "GroupType") {
      fail(
        "portrait_group_type_user_forbidden",
        "GroupType 不允许进入领域状态",
        "providerGroupType",
      );
    }
    fail("portrait_state_invalid", "providerGroupType 未按主体类型派生", "providerGroupType");
  }

  if (state.moderation.decidedAt) {
    timestampAtOrAfter(
      state.moderation.decidedAt,
      state.createdAt,
      "portrait_state_invalid",
      "moderation.decidedAt",
    );
    if (Date.parse(state.moderation.decidedAt) > Date.parse(state.updatedAt)) {
      fail("portrait_state_invalid", "审核时间晚于状态更新时间", "moderation.decidedAt");
    }
  }

  if (["queued", "scanning"].includes(state.faceScanState)) {
    if (
      state.moderation.state !== "pending"
      || state.complianceState !== "pending"
      || state.providerSyncState !== "not_needed"
    ) {
      fail("portrait_state_invalid", "扫描完成前不得预置审核、合规或供应商状态", "faceScanState");
    }
  }
  if (
    state.faceScanState === "queued"
    && (
      state.revision !== 1
      || state.updatedAt !== state.createdAt
      || state.safeErrorCode !== "portrait_face_scan_required"
    )
  ) {
    fail("portrait_state_invalid", "queued 必须是未发生事件的初始状态", "revision");
  }
  if (state.faceScanState === "scanning" && state.revision < 2) {
    fail("portrait_state_invalid", "scanning 状态缺少启动扫描事件", "revision");
  }
  if (
    ["no_face", "single_face", "multiple_faces", "uncertain", "failed"].includes(
      state.faceScanState,
    )
    && state.revision < 3
  ) {
    fail("portrait_state_invalid", "完成的扫描状态缺少必要事件历史", "revision");
  }

  if (state.faceScanState === "no_face") {
    const expectedCompliance = state.moderation.state === "allowed"
      ? "not_required"
      : state.moderation.state === "denied" ? "denied" : "pending";
    if (state.complianceState !== expectedCompliance || state.providerSyncState !== "not_needed") {
      fail(
        "portrait_state_invalid",
        "普通素材必须经审核，但不得要求肖像授权或供应商人像同步",
        "complianceState",
      );
    }
  }

  if (["multiple_faces", "uncertain", "failed"].includes(state.faceScanState)) {
    if (state.complianceState !== "denied" || state.providerSyncState !== "not_needed") {
      fail("portrait_state_invalid", "多脸或不确定素材必须 fail closed", "complianceState");
    }
  }

  if (state.faceScanState === "single_face") {
    if (state.moderation.state === "denied" && state.complianceState !== "denied") {
      fail("portrait_state_invalid", "审核拒绝必须使合规状态拒绝", "complianceState");
    }
    if (
      state.subjectKind === "pending"
      && state.moderation.state !== "denied"
      && state.complianceState !== "pending"
    ) {
      fail("portrait_state_invalid", "未声明单人脸素材必须保持待定", "complianceState");
    }
    if (
      state.subjectKind !== "pending"
      && state.moderation.state === "pending"
      && state.complianceState !== "pending"
    ) {
      fail("portrait_state_invalid", "缺少审核的肖像素材必须保持待定", "complianceState");
    }
    if (
      state.subjectKind !== "pending"
      && state.moderation.state === "allowed"
      && !["allowed", "expired", "revoked"].includes(state.complianceState)
    ) {
      fail("portrait_state_invalid", "证据齐全的单人脸素材合规状态无效", "complianceState");
    }
  }

  if (state.providerSyncState === "not_needed") {
    if (
      state.providerAttempt !== 0
      || state.providerBinding
      || state.providerErrorCode
      || state.livenessEvidence
    ) {
      fail("portrait_state_invalid", "无需同步状态不能携带供应商执行数据", "providerSyncState");
    }
  } else {
    if (state.providerGroupType === null || state.complianceState === "pending") {
      fail("portrait_state_invalid", "供应商同步缺少已分类的肖像主体", "providerSyncState");
    }
    if (["authorizing", "creating_group", "processing", "active", "failed"].includes(
      state.providerSyncState,
    ) && state.providerAttempt < 1) {
      fail("portrait_state_invalid", "已开始的供应商同步必须记录尝试次数", "providerAttempt");
    }
  }
  if (
    ["denied", "expired", "revoked"].includes(state.complianceState)
    && !["not_needed", "stale"].includes(state.providerSyncState)
  ) {
    fail(
      "portrait_state_invalid",
      "无效合规终态不得保留可执行的供应商同步状态",
      "providerSyncState",
    );
  }
  if (state.providerSyncState === "authorizing"
    && (state.subjectKind !== "real_person" || state.providerGroupType !== "LivenessFace")) {
    fail("portrait_state_invalid", "只有真人素材可以处于 authorizing", "providerSyncState");
  }
  if (state.livenessEvidence) {
    if (state.subjectKind !== "real_person" || state.providerGroupType !== "LivenessFace") {
      fail("portrait_state_invalid", "LivenessFace 证据只能绑定真人素材", "livenessEvidence");
    }
    timestampAtOrAfter(
      state.livenessEvidence.verifiedAt,
      state.createdAt,
      "portrait_state_invalid",
      "livenessEvidence.verifiedAt",
    );
    if (Date.parse(state.livenessEvidence.verifiedAt) > Date.parse(state.updatedAt)) {
      fail("portrait_state_invalid", "LivenessFace 证据时间晚于状态更新时间", "livenessEvidence.verifiedAt");
    }
  }
  if (
    state.subjectKind === "real_person"
    && ["creating_group", "processing", "active"].includes(state.providerSyncState)
    && !state.livenessEvidence
  ) {
    fail(
      "portrait_liveness_evidence_required",
      "真人素材完成授权前不得创建或激活供应商资产",
      "livenessEvidence",
    );
  }
  if (
    state.subjectKind !== "real_person"
    && state.livenessEvidence
  ) {
    fail("portrait_state_invalid", "非真人素材不能携带 LivenessFace 证据", "livenessEvidence");
  }
  if (state.providerSyncState === "active") {
    if (!state.providerBinding || state.complianceState !== "allowed") {
      fail("portrait_state_invalid", "active 供应商同步必须绑定有效资产且合规通过", "providerBinding");
    }
    if (Date.parse(state.providerBinding.activeAt) > Date.parse(state.updatedAt)) {
      fail("portrait_state_invalid", "供应商资产激活时间晚于状态更新时间", "providerBinding.activeAt");
    }
    timestampAtOrAfter(
      state.providerBinding.activeAt,
      state.createdAt,
      "portrait_state_invalid",
      "providerBinding.activeAt",
    );
  } else if (state.providerBinding !== null) {
    fail("portrait_state_invalid", "非 active 状态不能持有供应商资产绑定", "providerBinding");
  }
  if (state.providerSyncState === "failed") {
    if (!state.providerErrorCode) {
      fail("portrait_state_invalid", "失败的供应商同步必须包含安全错误码", "providerErrorCode");
    }
  } else if (state.providerErrorCode && state.faceScanState !== "failed") {
    fail("portrait_state_invalid", "非失败状态不能残留供应商错误码", "providerErrorCode");
  }

  const expectedSafeError = deriveSafeErrorCode(state);
  if (state.safeErrorCode !== expectedSafeError) {
    fail("portrait_state_invalid", "safeErrorCode 与准入状态不一致", "safeErrorCode");
  }
}

export function parsePortraitAssetAdmission(
  rawState: unknown,
): PortraitAssetAdmissionState {
  const input = record(rawState, "portrait_state_invalid", "state");
  exactKeys(input, STATE_KEYS, "portrait_state_invalid", "state");
  if (input.version !== PORTRAIT_ASSET_ADMISSION_VERSION) {
    fail("portrait_state_invalid", "肖像资产准入状态版本无效", "state.version");
  }
  const admissionId = safeId(input.admissionId, "portrait_state_invalid", "state.admissionId");
  const assetVersionId = positiveInteger(
    input.assetVersionId,
    "portrait_state_invalid",
    "state.assetVersionId",
  );
  const faceScanState = enumValue(
    input.faceScanState,
    PORTRAIT_FACE_SCAN_STATES,
    "portrait_state_invalid",
    "state.faceScanState",
  );
  const faceScanEvidence = input.faceScanEvidence === null
    ? null
    : parseFaceScanEvidence(input.faceScanEvidence, "portrait_state_invalid", "state.faceScanEvidence");
  const userDeclaration = input.userDeclaration === null
    ? null
    : parseUserDeclaration(input.userDeclaration, "portrait_state_invalid", "state.userDeclaration");
  const trustedOutputEvidence = input.trustedOutputEvidence === null
    ? null
    : parseTrustedOutputEvidence(
      input.trustedOutputEvidence,
      admissionId,
      assetVersionId,
      "portrait_state_invalid",
      "state.trustedOutputEvidence",
    );
  let providerGroupType: PortraitProviderGroupType | null = null;
  if (input.providerGroupType !== null) {
    if (input.providerGroupType === "GroupType") {
      fail(
        "portrait_group_type_user_forbidden",
        "GroupType 不允许进入领域状态",
        "state.providerGroupType",
      );
    }
    providerGroupType = enumValue(
      input.providerGroupType,
      PORTRAIT_PROVIDER_GROUP_TYPES,
      "portrait_state_invalid",
      "state.providerGroupType",
    );
  }
  const providerSyncState = enumValue(
    input.providerSyncState,
    PORTRAIT_PROVIDER_SYNC_STATES,
    "portrait_state_invalid",
    "state.providerSyncState",
  );
  const livenessEvidence = input.livenessEvidence === null
    ? null
    : parseLivenessEvidence(
      input.livenessEvidence,
      admissionId,
      assetVersionId,
      "portrait_state_invalid",
      "state.livenessEvidence",
    );
  const providerBinding = input.providerBinding === null
    ? null
    : parseProviderBinding(input.providerBinding, "portrait_state_invalid", "state.providerBinding");
  const providerErrorCode = input.providerErrorCode === null
    ? null
    : safeErrorCode(input.providerErrorCode, "portrait_state_invalid", "state.providerErrorCode");
  const safeError = input.safeErrorCode === null
    ? null
    : enumValue(
      input.safeErrorCode,
      PORTRAIT_ASSET_ERROR_CODES,
      "portrait_state_invalid",
      "state.safeErrorCode",
    );
  const state: PortraitAssetAdmissionState = {
    version: PORTRAIT_ASSET_ADMISSION_VERSION,
    admissionId,
    assetVersionId,
    faceScanState,
    faceScanEvidence,
    subjectKind: enumValue(
      input.subjectKind,
      PORTRAIT_SUBJECT_KINDS,
      "portrait_state_invalid",
      "state.subjectKind",
    ),
    declarationState: enumValue(
      input.declarationState,
      PORTRAIT_DECLARATION_STATES,
      "portrait_state_invalid",
      "state.declarationState",
    ),
    userDeclaration,
    trustedOutputEvidence,
    moderation: parseModeration(input.moderation, "portrait_state_invalid", "state.moderation"),
    complianceState: enumValue(
      input.complianceState,
      PORTRAIT_COMPLIANCE_STATES,
      "portrait_state_invalid",
      "state.complianceState",
    ),
    providerGroupType,
    providerSyncState,
    livenessEvidence,
    providerBinding,
    providerAttempt: nonNegativeInteger(
      input.providerAttempt,
      "portrait_state_invalid",
      "state.providerAttempt",
    ),
    providerErrorCode,
    safeErrorCode: safeError,
    revision: positiveInteger(input.revision, "portrait_state_invalid", "state.revision"),
    createdAt: canonicalTimestamp(input.createdAt, "portrait_state_invalid", "state.createdAt"),
    updatedAt: canonicalTimestamp(input.updatedAt, "portrait_state_invalid", "state.updatedAt"),
  };
  validateStateInvariants(state);
  return state;
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("portrait_serialization_invalid", "状态包含非有限数字");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return fail("portrait_serialization_invalid", "状态包含不可序列化值");
}

export function portraitAssetAdmissionChecksum(
  rawState: PortraitAssetAdmissionState,
  options: PortraitAssetAdmissionSerializationOptions,
): string {
  const state = parsePortraitAssetAdmission(rawState);
  if (state.trustedOutputEvidence) {
    assertTrustedOutputEvidenceSignature(
      state.trustedOutputEvidence,
      options.trustedOutputEvidenceKey,
    );
  }
  if (state.livenessEvidence) {
    assertLivenessEvidenceSignature(state.livenessEvidence, options.livenessEvidenceKey);
  }
  const key = integrityKey(options.integrityKey, "options.integrityKey");
  return hmacSha256(canonicalJson(state), key);
}

export function serializePortraitAssetAdmission(
  rawState: PortraitAssetAdmissionState,
  options: PortraitAssetAdmissionSerializationOptions,
): string {
  const state = parsePortraitAssetAdmission(rawState);
  if (state.trustedOutputEvidence) {
    assertTrustedOutputEvidenceSignature(
      state.trustedOutputEvidence,
      options.trustedOutputEvidenceKey,
    );
  }
  if (state.livenessEvidence) {
    assertLivenessEvidenceSignature(state.livenessEvidence, options.livenessEvidenceKey);
  }
  const key = integrityKey(options.integrityKey, "options.integrityKey");
  const envelope: PortraitAssetAdmissionEnvelope = {
    format: PORTRAIT_ASSET_ADMISSION_ENVELOPE_VERSION,
    state,
    checksum: hmacSha256(canonicalJson(state), key),
  };
  return canonicalJson(envelope);
}

function checksumEqual(left: string, right: string): boolean {
  if (!HASH_PATTERN.test(left) || !HASH_PATTERN.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export function deserializePortraitAssetAdmission(
  serialized: string,
  options: PortraitAssetAdmissionDeserializationOptions,
): PortraitAssetAdmissionState {
  const key = integrityKey(options.integrityKey, "options.integrityKey");
  const expectedAdmissionId = safeId(
    options.expectedAdmissionId,
    "portrait_context_mismatch",
    "options.expectedAdmissionId",
  );
  const expectedAssetVersionId = positiveInteger(
    options.expectedAssetVersionId,
    "portrait_context_mismatch",
    "options.expectedAssetVersionId",
  );
  if (typeof serialized !== "string" || !serialized || Buffer.byteLength(serialized, "utf8") > MAX_SERIALIZED_BYTES) {
    fail("portrait_serialization_invalid", "肖像资产准入状态序列化内容无效");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    fail("portrait_serialization_invalid", "肖像资产准入状态不是合法 JSON");
  }
  const envelope = record(parsed, "portrait_serialization_invalid", "envelope");
  exactKeys(
    envelope,
    ["format", "state", "checksum"],
    "portrait_serialization_invalid",
    "envelope",
  );
  if (envelope.format !== PORTRAIT_ASSET_ADMISSION_ENVELOPE_VERSION) {
    fail("portrait_serialization_invalid", "肖像资产准入序列化版本无效", "envelope.format");
  }
  const checksum = hash(
    envelope.checksum,
    "portrait_serialization_invalid",
    "envelope.checksum",
  );
  const expected = hmacSha256(canonicalJson(envelope.state), key);
  if (!checksumEqual(checksum, expected)) {
    fail("portrait_checksum_mismatch", "肖像资产准入状态校验和不匹配", "envelope.checksum");
  }
  const state = parsePortraitAssetAdmission(envelope.state);
  if (
    state.admissionId !== expectedAdmissionId
    || state.assetVersionId !== expectedAssetVersionId
  ) {
    fail(
      "portrait_context_mismatch",
      "序列化状态未绑定预期的准入记录和资产版本",
      "envelope.state",
    );
  }
  if (state.trustedOutputEvidence) {
    assertTrustedOutputEvidenceSignature(
      state.trustedOutputEvidence,
      options.trustedOutputEvidenceKey,
    );
  }
  if (state.livenessEvidence) {
    assertLivenessEvidenceSignature(state.livenessEvidence, options.livenessEvidenceKey);
  }
  return state;
}

export function isPortraitAssetAdmitted(
  rawState: PortraitAssetAdmissionState,
  options: PortraitAssetAdmissionTransitionOptions = {},
): boolean {
  const state = parsePortraitAssetAdmission(rawState);
  if (state.subjectKind === "ordinary") {
    return state.moderation.state === "allowed"
      && state.complianceState === "not_required"
      && state.providerSyncState === "not_needed";
  }
  if (state.subjectKind === "trusted_output") {
    if (!state.trustedOutputEvidence) return false;
    try {
      assertTrustedOutputEvidenceSignature(
        state.trustedOutputEvidence,
        options.trustedOutputEvidenceKey,
      );
    } catch (error) {
      if (error instanceof PortraitAssetAdmissionError) return false;
      throw error;
    }
  }
  if (state.subjectKind === "real_person") {
    if (!state.livenessEvidence) return false;
    try {
      assertLivenessEvidenceSignature(state.livenessEvidence, options.livenessEvidenceKey);
    } catch (error) {
      if (error instanceof PortraitAssetAdmissionError) return false;
      throw error;
    }
  }
  return ["real_person", "virtual_person", "trusted_output"].includes(state.subjectKind)
    && state.moderation.state === "allowed"
    && state.complianceState === "allowed"
    && (state.subjectKind === "trusted_output"
      || (state.declarationState === "confirmed"
        && state.userDeclaration !== null
        && state.userDeclaration.revokedAt === null))
    && state.providerSyncState === "active"
    && state.providerBinding !== null;
}

export function assertPortraitAssetAdmitted(
  rawState: PortraitAssetAdmissionState,
  options: PortraitAssetAdmissionTransitionOptions = {},
): void {
  const state = parsePortraitAssetAdmission(rawState);
  if (state.trustedOutputEvidence) {
    assertTrustedOutputEvidenceSignature(
      state.trustedOutputEvidence,
      options.trustedOutputEvidenceKey,
    );
  }
  if (state.livenessEvidence) {
    assertLivenessEvidenceSignature(state.livenessEvidence, options.livenessEvidenceKey);
  }
  if (isPortraitAssetAdmitted(state, options)) return;
  const code = state.safeErrorCode ?? "portrait_state_invalid";
  fail(code, "肖像资产尚未满足生成准入条件", "safeErrorCode");
}
