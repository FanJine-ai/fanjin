import { z } from "zod";
import {
  canonicalizeIdempotencyRequest,
  hashIdempotencyRequest,
} from "@/agent-runtime/idempotency";

export const A4_REVIEW_REPORT_VERSION = 1 as const;

export const A4_REVIEW_SUBJECT_TYPES = [
  "project",
  "session",
  "script",
  "asset",
  "asset_version",
  "storyboard",
  "canvas",
  "message",
  "generation_result",
  "delivery_snapshot",
] as const;

export const A4_REVIEW_DIMENSIONS = [
  "brief_alignment",
  "factual_grounding",
  "narrative_quality",
  "visual_continuity",
  "technical_quality",
  "policy_compliance",
] as const;

export const A4_REVIEW_FINDING_SEVERITIES = [
  "info",
  "minor",
  "major",
  "critical",
] as const;

export const A4_REVIEW_VERDICTS = [
  "pass",
  "pass_with_findings",
  "revise",
  "block",
] as const;

const SAFE_ID_PATTERN = /^[^\s\u0000-\u001f\u007f]+$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const TEXT_NUL_PATTERN = /\u0000/;

const boundedId = z.string().trim().min(1).max(200).regex(SAFE_ID_PATTERN);
const boundedVersion = z.string().trim().min(1).max(200).regex(SAFE_ID_PATTERN);
const boundedText = (max: number) => z.string().trim().min(1).max(max).refine(
  (value) => !TEXT_NUL_PATTERN.test(value),
);
const projectIdSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

export const a4ReviewSubjectRefSchema = z.object({
  projectId: projectIdSchema,
  type: z.enum(A4_REVIEW_SUBJECT_TYPES),
  id: boundedId,
  version: boundedVersion,
}).strict();

export const a4ReviewEvidenceRefSchema = z.object({
  refId: boundedId,
  projectId: projectIdSchema,
  type: z.enum(A4_REVIEW_SUBJECT_TYPES),
  id: boundedId,
  version: boundedVersion,
}).strict();

export const a4ReviewDimensionScoreSchema = z.object({
  dimension: z.enum(A4_REVIEW_DIMENSIONS),
  score: z.number().int().min(0).max(100),
  rationale: boundedText(2_000),
  evidenceRefIds: z.array(boundedId).min(1).max(50),
}).strict();

/**
 * A recommendation is deliberately advisory text, never an executable action.
 * There is no target, operation, tool id, arguments, patch, or authorization.
 */
export const a4ReviewRecommendationSchema = z.object({
  kind: z.literal("advisory"),
  text: boundedText(2_000),
}).strict();

export const a4ReviewFindingSchema = z.object({
  id: boundedId,
  severity: z.enum(A4_REVIEW_FINDING_SEVERITIES),
  summary: boundedText(2_000),
  evidenceRefIds: z.array(boundedId).min(1).max(50),
  recommendation: a4ReviewRecommendationSchema,
}).strict();

export const a4ReviewOverallSchema = z.object({
  verdict: z.enum(A4_REVIEW_VERDICTS),
  summary: boundedText(4_000),
}).strict();

export const a4ReviewModelUsageSchema = z.object({
  modelProfile: boundedId,
  inputTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  outputTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  costMicros: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
}).strict();

export const a4ReviewReportContentSchema = z.object({
  version: z.literal(A4_REVIEW_REPORT_VERSION),
  projectId: projectIdSchema,
  subject: a4ReviewSubjectRefSchema,
  evidenceRefs: z.array(a4ReviewEvidenceRefSchema).min(1).max(100),
  dimensions: z.array(a4ReviewDimensionScoreSchema).min(1).max(A4_REVIEW_DIMENSIONS.length),
  findings: z.array(a4ReviewFindingSchema).max(100),
  overall: a4ReviewOverallSchema,
  modelUsage: a4ReviewModelUsageSchema,
}).strict();

/** Model-produced report body. Runtime injects authoritative model usage. */
export const a4ReviewReportDraftSchema = a4ReviewReportContentSchema.omit({ modelUsage: true }).strict();

export const a4ReviewReportSchema = a4ReviewReportContentSchema.extend({
  canonicalHash: z.string().regex(HASH_PATTERN),
}).strict();

type MutableReviewReportContent = z.infer<typeof a4ReviewReportContentSchema>;
type MutableReviewReport = z.infer<typeof a4ReviewReportSchema>;

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export type A4ReviewSubjectRef = DeepReadonly<z.infer<typeof a4ReviewSubjectRefSchema>>;
export type A4ReviewEvidenceRef = DeepReadonly<z.infer<typeof a4ReviewEvidenceRefSchema>>;
export type A4ReviewDimensionScore = DeepReadonly<z.infer<typeof a4ReviewDimensionScoreSchema>>;
export type A4ReviewFinding = DeepReadonly<z.infer<typeof a4ReviewFindingSchema>>;
export type A4ReviewReportContent = DeepReadonly<MutableReviewReportContent>;
export type A4ReviewReportDraft = DeepReadonly<z.infer<typeof a4ReviewReportDraftSchema>>;
export type A4ReviewReport = DeepReadonly<MutableReviewReport>;

export type A4ReviewReportContractErrorCode =
  | "review_report_invalid"
  | "review_report_project_scope_invalid"
  | "review_report_evidence_duplicate"
  | "review_report_evidence_ref_invalid"
  | "review_report_dimension_duplicate"
  | "review_report_finding_duplicate"
  | "review_report_verdict_invalid"
  | "review_report_executable_action_forbidden"
  | "review_report_hash_mismatch";

const SAFE_MESSAGES: Readonly<Record<A4ReviewReportContractErrorCode, string>> = Object.freeze({
  review_report_invalid: "Reviewer ReviewReport 格式无效",
  review_report_project_scope_invalid: "Reviewer ReviewReport 项目范围无效",
  review_report_evidence_duplicate: "Reviewer ReviewReport 包含重复证据",
  review_report_evidence_ref_invalid: "Reviewer ReviewReport 证据引用无效",
  review_report_dimension_duplicate: "Reviewer ReviewReport 包含重复评分维度",
  review_report_finding_duplicate: "Reviewer ReviewReport 包含重复 finding",
  review_report_verdict_invalid: "Reviewer ReviewReport 总体结论与 finding 不一致",
  review_report_executable_action_forbidden: "Reviewer ReviewReport 不得包含可执行操作",
  review_report_hash_mismatch: "Reviewer ReviewReport canonical hash 不匹配",
});

export class A4ReviewReportContractError extends Error {
  readonly code: A4ReviewReportContractErrorCode;

  constructor(code: A4ReviewReportContractErrorCode) {
    super(SAFE_MESSAGES[code]);
    this.name = "A4ReviewReportContractError";
    this.code = code;
  }
}

function fail(code: A4ReviewReportContractErrorCode): never {
  throw new A4ReviewReportContractError(code);
}

const FORBIDDEN_EXECUTION_KEYS = new Set([
  "action",
  "actions",
  "command",
  "commands",
  "deleteinstruction",
  "executablepatch",
  "generateinstruction",
  "instruction",
  "instructions",
  "mutation",
  "mutations",
  "operation",
  "operations",
  "patch",
  "patches",
  "publishinstruction",
  "toolcall",
  "toolcalls",
  "writeinstruction",
  "writetarget",
  "writetargets",
]);

function normalizedKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function containsExecutableShape(value: unknown, seen = new WeakSet<object>()): boolean {
  if (!value || typeof value !== "object") return false;
  const objectValue = value as object;
  if (seen.has(objectValue)) return false;
  seen.add(objectValue);
  if (Array.isArray(value)) return value.some((item) => containsExecutableShape(item, seen));
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_EXECUTION_KEYS.has(normalizedKey(key)) || containsExecutableShape(nested, seen)) return true;
  }
  return false;
}

function uniqueSortedIds(ids: readonly string[]): string[] {
  const unique = new Set(ids);
  if (unique.size !== ids.length) fail("review_report_evidence_ref_invalid");
  return [...unique].sort((left, right) => left.localeCompare(right));
}

function evidenceIdentity(ref: A4ReviewEvidenceRef): string {
  return `${ref.projectId}\u0000${ref.type}\u0000${ref.id}\u0000${ref.version}`;
}

function assertVerdict(findings: readonly A4ReviewFinding[], verdict: MutableReviewReportContent["overall"]["verdict"]): void {
  const severities = new Set(findings.map((finding) => finding.severity));
  const hasMinor = severities.has("info") || severities.has("minor");
  const hasMajor = severities.has("major");
  const hasCritical = severities.has("critical");
  const valid = verdict === "pass"
    ? findings.length === 0
    : verdict === "pass_with_findings"
      ? findings.length > 0 && hasMinor && !hasMajor && !hasCritical
      : verdict === "revise"
        ? hasMajor && !hasCritical
        : hasCritical;
  if (!valid) fail("review_report_verdict_invalid");
}

function normalizeContent(
  input: unknown,
  options: { expectedProjectId?: number },
): MutableReviewReportContent {
  if (containsExecutableShape(input)) fail("review_report_executable_action_forbidden");
  const parsed = a4ReviewReportContentSchema.safeParse(input);
  if (!parsed.success) fail("review_report_invalid");
  const report = parsed.data;
  if ((options.expectedProjectId !== undefined
      && (!Number.isSafeInteger(options.expectedProjectId)
        || options.expectedProjectId < 1
        || report.projectId !== options.expectedProjectId))
    || report.subject.projectId !== report.projectId
    || report.evidenceRefs.some((ref) => ref.projectId !== report.projectId)) {
    fail("review_report_project_scope_invalid");
  }

  const evidenceRefIds = new Set<string>();
  const evidenceIdentities = new Set<string>();
  for (const ref of report.evidenceRefs) {
    const identity = evidenceIdentity(ref);
    if (evidenceRefIds.has(ref.refId) || evidenceIdentities.has(identity)) {
      fail("review_report_evidence_duplicate");
    }
    evidenceRefIds.add(ref.refId);
    evidenceIdentities.add(identity);
  }

  const dimensionKeys = new Set<string>();
  const dimensions = report.dimensions.map((dimension) => {
    if (dimensionKeys.has(dimension.dimension)) fail("review_report_dimension_duplicate");
    dimensionKeys.add(dimension.dimension);
    const refs = uniqueSortedIds(dimension.evidenceRefIds);
    if (refs.some((refId) => !evidenceRefIds.has(refId))) fail("review_report_evidence_ref_invalid");
    return { ...dimension, evidenceRefIds: refs };
  }).sort((left, right) => left.dimension.localeCompare(right.dimension));

  const findingIds = new Set<string>();
  const findings = report.findings.map((finding) => {
    if (findingIds.has(finding.id)) fail("review_report_finding_duplicate");
    findingIds.add(finding.id);
    const refs = uniqueSortedIds(finding.evidenceRefIds);
    if (refs.some((refId) => !evidenceRefIds.has(refId))) fail("review_report_evidence_ref_invalid");
    return {
      ...finding,
      evidenceRefIds: refs,
      recommendation: { ...finding.recommendation },
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
  assertVerdict(findings, report.overall.verdict);

  return {
    version: A4_REVIEW_REPORT_VERSION,
    projectId: report.projectId,
    subject: { ...report.subject },
    evidenceRefs: report.evidenceRefs
      .map((ref) => ({ ...ref }))
      .sort((left, right) => left.refId.localeCompare(right.refId)),
    dimensions,
    findings,
    overall: { ...report.overall },
    modelUsage: { ...report.modelUsage },
  };
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): DeepReadonly<T> {
  if (!value || typeof value !== "object") return value as DeepReadonly<T>;
  const objectValue = value as object;
  if (seen.has(objectValue)) return value as DeepReadonly<T>;
  seen.add(objectValue);
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested, seen);
  return Object.freeze(value) as DeepReadonly<T>;
}

export function canonicalizeA4ReviewReportContent(
  input: unknown,
  options: { expectedProjectId?: number } = {},
): string {
  return canonicalizeIdempotencyRequest(normalizeContent(input, options));
}

export function hashA4ReviewReportContent(
  input: unknown,
  options: { expectedProjectId?: number } = {},
): string {
  return hashIdempotencyRequest(normalizeContent(input, options));
}

/** Creates a new immutable report and derives its hash from canonical V1 content. */
export function createA4ReviewReport(
  input: unknown,
  options: { expectedProjectId?: number } = {},
): A4ReviewReport {
  const content = normalizeContent(input, options);
  return deepFreeze({
    ...content,
    canonicalHash: hashIdempotencyRequest(content),
  });
}

/** Validates a persisted immutable report without accepting or repairing hash drift. */
export function normalizeA4ReviewReport(
  input: unknown,
  options: { expectedProjectId?: number } = {},
): A4ReviewReport {
  if (containsExecutableShape(input)) fail("review_report_executable_action_forbidden");
  const parsed = a4ReviewReportSchema.safeParse(input);
  if (!parsed.success) fail("review_report_invalid");
  const { canonicalHash, ...rawContent } = parsed.data;
  const content = normalizeContent(rawContent, options);
  if (hashIdempotencyRequest(content) !== canonicalHash) fail("review_report_hash_mismatch");
  return deepFreeze({ ...content, canonicalHash });
}
