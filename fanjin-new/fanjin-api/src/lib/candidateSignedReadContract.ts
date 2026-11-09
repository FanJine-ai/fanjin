import { z } from "zod";

export const CANDIDATE_SIGNED_READ_CONTRACT_REVISION =
  "fanjin-candidate-signed-read-contract/3" as const;
export const CANDIDATE_SIGNED_READ_CONTRACT_REVISION_HEADER =
  "x-fanjin-candidate-read-contract-revision" as const;

export type CandidateSignedReadMethod = "GET" | "HEAD" | "POST";

export class CandidateSignedReadContractError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "CandidateSignedReadContractError";
    this.code = code;
  }
}

function fail(code: string): never {
  throw new CandidateSignedReadContractError(code);
}

const scopeIdString = z.string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._:-]+$/);
const scopeId = z.union([
  z.number().int().positive().safe(),
  scopeIdString,
]);
const positiveIntegerQuery = z.string().regex(/^[1-9]\d{0,15}$/);
const nonNegativeIntegerQuery = z.string().regex(/^(?:0|[1-9]\d{0,15})$/);
const boundedText = z.string().max(2_048);
const workspaceId = z.string().trim().min(1).max(200);
const emptyObjectSchema = z.object({}).strict();

const forbiddenResponseKey = /^(?:api[-_]?key|authorization|cookie|credential|password|secret|token)$/i;
const safeJsonScalar = z.union([
  z.string().max(4_000_000),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const safeJsonValue: z.ZodType<unknown> = z.lazy(() => z.union([
  safeJsonScalar,
  z.array(safeJsonValue).max(20_000),
  z.record(z.string(), safeJsonValue).superRefine((value, context) => {
    const keys = Object.keys(value);
    if (
      keys.length > 500
      || keys.some((key) => (
        key.length > 200
        || forbiddenResponseKey.test(key)
        || ["__proto__", "constructor", "prototype"].includes(key)
      ))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "unsafe signed-read response object",
      });
    }
  }),
]));
const boundedJsonObject = z.record(z.string(), safeJsonValue).superRefine((value, context) => {
  const keys = Object.keys(value);
  if (
    keys.length > 500
    || keys.some((key) => (
      key.length > 200
      || forbiddenResponseKey.test(key)
      || ["__proto__", "constructor", "prototype"].includes(key)
    ))
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "unsafe signed-read response object",
    });
  }
});
const finiteNumber = z.number().finite();
const safeInteger = z.number().int().safe();
const nonNegativeSafeInteger = safeInteger.nonnegative();
const positiveSafeInteger = safeInteger.positive();
const idScalar = z.union([safeInteger, z.string().min(1).max(200)]);
const nullableText = z.string().max(4_000_000).nullable();
const nullableSafeInteger = safeInteger.nullable();
const nullableFiniteNumber = finiteNumber.nullable();
const timestampValue = z.union([
  nonNegativeSafeInteger,
  z.string().datetime(),
]);

const publicUserSchema = z.object({
  id: positiveSafeInteger,
  name: nullableText,
  email: nullableText,
  displayName: nullableText,
  role: z.string().min(1).max(100),
  status: z.string().min(1).max(100),
  currentWorkspaceId: z.string().max(200).nullable(),
  defaultWorkspaceId: z.string().max(200).nullable(),
  createdAt: nullableSafeInteger,
  updatedAt: nullableSafeInteger,
  lastLoginAt: nullableSafeInteger,
}).strict();

const workspaceSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(500),
  ownerUserId: positiveSafeInteger,
  slug: z.string().min(1).max(500),
  status: z.string().min(1).max(100),
  createdAt: nonNegativeSafeInteger,
  updatedAt: nonNegativeSafeInteger,
  memberId: z.string().max(200).nullable(),
  memberRole: z.string().min(1).max(100),
  memberStatus: z.string().min(1).max(100),
  memberPermissions: z.array(z.string().min(1).max(200)).max(500),
  memberPermissionsConfigured: z.boolean(),
}).strict();

const identitySubjectSchema = z.object({
  contractVersion: z.literal("identity.v1"),
  userId: positiveSafeInteger,
  userStatus: z.enum(["active", "disabled", "locked"]),
  legacyRole: z.string().min(1).max(100).nullable(),
  platformRole: z.enum(["root", "admin", "super_admin"]).nullable(),
  financeRole: z.enum([
    "finance_viewer",
    "finance_operator",
    "finance_manager",
  ]).nullable(),
  workspaceId: z.string().max(200).nullable(),
  workspaceStatus: z.enum(["active", "suspended"]).nullable(),
  membershipId: z.string().max(200).nullable(),
  membershipStatus: z.enum(["active", "disabled"]).nullable(),
  workspaceRole: z.string().max(100).nullable(),
  platformPermissions: z.array(z.string().max(200)).max(500),
  financePermissions: z.array(z.string().max(200)).max(500),
  workspacePermissions: z.array(z.string().max(200)).max(500),
}).strict();

const authProfileSchema = z.object({
  user: publicUserSchema,
  workspace: workspaceSchema.nullable(),
  workspaces: z.array(workspaceSchema).max(1_000),
  role: z.string().min(1).max(100),
  permissions: z.array(z.string().max(200)).max(500),
  identity: identitySubjectSchema,
  platformAccess: z.object({
    role: z.string().max(100).nullable(),
    effectivePermissions: z.array(z.string().max(200)).max(1_000),
  }).strict(),
}).strict();

const passwordPolicySchema = z.object({
  minLength: positiveSafeInteger,
  requireUppercase: z.boolean(),
  requireLowercase: z.boolean(),
  requireNumber: z.boolean(),
  requireSymbol: z.boolean(),
  rejectHistoryCount: nonNegativeSafeInteger,
  expireDays: nonNegativeSafeInteger,
  maxRetriesPerHour: positiveSafeInteger,
  lockMinutes: positiveSafeInteger,
}).strict();
const sessionPolicySchema = z.object({
  idleMinutes: positiveSafeInteger,
  absoluteHours: positiveSafeInteger,
}).strict();
const verificationSchema = z.object({
  type: z.enum(["personal", "enterprise"]),
  status: z.enum(["not_started", "pending", "approved", "rejected"]),
  subjectName: nullableText,
  companyName: nullableText,
  unifiedSocialCreditCode: nullableText,
  legalRepresentative: nullableText,
  contactPhone: nullableText,
  idNumberMasked: nullableText,
  submittedAt: nullableSafeInteger,
  approvedAt: nullableSafeInteger,
  rejectedReason: nullableText,
  metadata: boundedJsonObject,
}).strict();
const accountProfileSchema = z.object({
  user: z.object({
    id: positiveSafeInteger,
    name: nullableText,
    email: nullableText,
    displayName: nullableText,
    role: z.string().min(1).max(100),
    status: z.string().min(1).max(100),
    createdAt: nullableSafeInteger,
    updatedAt: nullableSafeInteger,
    lastLoginAt: nullableSafeInteger,
  }).strict(),
  workspace: z.object({
    id: z.string().min(1).max(200),
    name: z.string().min(1).max(500),
    slug: z.string().min(1).max(500),
    status: z.string().min(1).max(100),
  }).strict(),
  verification: z.object({
    personal: verificationSchema,
    enterprise: verificationSchema,
  }).strict(),
  security: z.object({
    phone: nullableText,
    email: nullableText,
    phoneBound: z.boolean(),
    emailBound: z.boolean(),
    mfaEnabled: z.boolean(),
    loginProtectionEnabled: z.boolean(),
    sensitiveOperationProtectionEnabled: z.boolean(),
    loginIpAllowlist: z.string().max(20_000),
    passwordPolicy: passwordPolicySchema,
    sessionPolicy: sessionPolicySchema,
    passwordChangedAt: nullableSafeInteger,
    passwordExpiresAt: nullableSafeInteger,
    passwordExpired: z.boolean(),
    updatedAt: nullableSafeInteger,
  }).strict(),
}).strict();

function legacySuccess<T extends z.ZodTypeAny>(data: T) {
  return z.object({
    code: z.literal(200),
    data,
    message: z.string().max(1_000),
  }).strict();
}

function agentSuccess<T extends z.ZodTypeAny>(data: T) {
  return z.object({
    code: z.literal("ok"),
    data,
  }).strict();
}

const folderSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().max(200),
  projectIds: z.array(z.string().max(200)).max(500),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

const agentThreadSchema = z.object({
  id: scopeIdString,
  projectId: z.number().int().positive().safe(),
  sessionId: z.string().max(200).nullable(),
  title: z.string().max(120),
  status: z.enum(["active", "archived"]),
  activeRootRunId: z.string().max(200).nullable(),
  messageSeq: z.number().int().nonnegative().safe(),
  eventSeq: z.number().int().nonnegative().safe(),
  lastMessageAt: z.number().int().nonnegative().safe().nullable(),
  createdAt: z.number().int().nonnegative().safe(),
  updatedAt: z.number().int().nonnegative().safe(),
  archivedAt: z.number().int().nonnegative().safe().nullable(),
}).strict();

const agentMessageSchema = z.object({
  id: scopeIdString,
  threadId: scopeIdString,
  runId: scopeIdString.nullable(),
  replyToId: scopeIdString.nullable(),
  clientMessageId: z.string().min(1).max(200).nullable(),
  seq: z.number().int().positive().safe(),
  role: z.enum(["user", "assistant", "system", "tool"]),
  agentRole: z.enum([
    "main",
    "writer",
    "visual",
    "storyboard",
    "executor",
    "reviewer",
  ]).nullable(),
  status: z.enum(["pending", "streaming", "completed", "stopped", "error"]),
  content: z.array(z.object({
    type: z.string().min(1).max(100),
  }).catchall(safeJsonValue)).max(20_000),
  referenceRefs: z.array(z.string().min(1).max(500)).max(500),
  contextSnapshot: boundedJsonObject.nullable(),
  contextUsage: boundedJsonObject.nullable(),
  error: z.object({
    code: z.string().min(1).max(200),
    message: z.string().min(1).max(4_000),
  }).strict().nullable(),
  createdAt: z.number().int().nonnegative().safe(),
  updatedAt: z.number().int().nonnegative().safe(),
  completedAt: z.number().int().nonnegative().safe().nullable(),
}).strict();

const agentChatModelSchema = z.object({
  id: z.string().min(1).max(200),
  displayName: z.string().min(1).max(500),
  description: z.string().max(4_000),
  free: z.boolean(),
  priceMicros: nonNegativeSafeInteger,
  default: z.boolean(),
}).strict();

const databaseProjectSchema = z.object({
  id: positiveSafeInteger,
  agentBudgetMicros: nullableSafeInteger,
  agentBudgetReservedMicros: nonNegativeSafeInteger,
  artStyle: nullableText,
  coverImageUrl: nullableText,
  coverStorageKey: nullableText,
  createTime: nullableSafeInteger,
  deletionFinalizeFence: nullableSafeInteger,
  deletionOperationId: nullableText,
  deletionRequestedAt: nullableSafeInteger,
  deletionState: z.string().max(100),
  directorManual: nullableText,
  imageModel: nullableText,
  imageQuality: nullableText,
  intro: nullableText,
  mode: nullableText,
  name: nullableText,
  projectType: nullableText,
  revision: nonNegativeSafeInteger,
  type: nullableText,
  updatedAt: nonNegativeSafeInteger,
  userId: nullableSafeInteger,
  videoModel: nullableText,
  videoRatio: nullableText,
  workspaceId: z.string().min(1).max(200),
}).strict();
const correlatedProjectSchema = databaseProjectSchema.extend({
  correlationDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

const projectNameSchema = z.object({
  id: positiveSafeInteger,
  name: z.string().min(1).max(500),
}).strict();

const canonicalProjectSchema = z.object({
  projectId: scopeIdString,
  name: z.string().max(500),
  intro: z.string().max(20_000),
  type: z.string().max(200),
  coverImageUrl: z.string().max(4_000_000),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  correlationDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

const workspaceCanvasSummarySchema = z.object({
  id: scopeIdString,
  projectId: scopeIdString,
  name: z.string().max(500),
  coverImageUrl: z.string().max(4_000_000),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

const projectCanvasSummarySchema = z.object({
  canvasId: scopeIdString,
  revision: positiveSafeInteger,
  name: z.string().max(500),
  coverImageUrl: z.string().max(4_000_000),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

const canonicalCanvasSchema = z.object({
  canvasId: scopeIdString,
  projectId: scopeIdString,
  name: z.string().max(500),
  coverImageUrl: z.string().max(4_000_000),
  nodes: z.array(safeJsonValue).max(20_000),
  edges: z.array(safeJsonValue).max(20_000),
  connections: z.array(safeJsonValue).max(20_000),
  groups: z.array(safeJsonValue).max(20_000),
  viewport: boundedJsonObject,
  revision: positiveSafeInteger,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

const assetRowSchema: z.ZodType<unknown> = z.lazy(() => z.object({
  id: positiveSafeInteger,
  assetsId: nullableSafeInteger.optional(),
  audioBindState: nullableSafeInteger.optional(),
  deletionFinalizeFence: nullableSafeInteger.optional(),
  deletionOperationId: nullableText.optional(),
  deletionRequestedAt: nullableSafeInteger.optional(),
  deletionState: z.string().max(100).optional(),
  describe: nullableText.optional(),
  flowId: nullableSafeInteger.optional(),
  imageId: nullableSafeInteger.optional(),
  name: nullableText.optional(),
  projectId: nullableSafeInteger.optional(),
  prompt: nullableText.optional(),
  promptErrorReason: nullableText.optional(),
  promptState: nullableText.optional(),
  remark: nullableText.optional(),
  scriptId: nullableSafeInteger.optional(),
  startTime: nullableSafeInteger.optional(),
  type: nullableText.optional(),
  filePath: nullableText.optional(),
  state: nullableText.optional(),
  errorReason: nullableText.optional(),
  src: z.union([z.string().max(4_000_000), z.literal(false), z.null()]).optional(),
  sex: nullableText.optional(),
  sonAssets: z.array(assetRowSchema).max(20_000).optional(),
}).strict());

const cornerAssetSchema = z.object({
  id: positiveSafeInteger,
  assetsId: nullableSafeInteger.optional(),
  audioBindState: nullableSafeInteger.optional(),
  deletionFinalizeFence: nullableSafeInteger.optional(),
  deletionOperationId: nullableText.optional(),
  deletionRequestedAt: nullableSafeInteger.optional(),
  deletionState: z.string().max(100).optional(),
  describe: nullableText.optional(),
  flowId: nullableSafeInteger.optional(),
  imageId: nullableSafeInteger.optional(),
  name: nullableText.optional(),
  projectId: nullableSafeInteger.optional(),
  prompt: nullableText.optional(),
  promptErrorReason: nullableText.optional(),
  promptState: nullableText.optional(),
  remark: nullableText.optional(),
  scriptId: nullableSafeInteger.optional(),
  startTime: nullableSafeInteger.optional(),
  type: nullableText.optional(),
  filePath: nullableText,
  state: nullableText,
  model: nullableText,
  resolution: nullableText,
  errorReason: nullableText,
  historyImages: z.array(z.object({
    id: positiveSafeInteger,
    filePath: nullableText,
  }).strict()).max(20_000),
  relepedAudio: z.array(z.object({
    id: nullableSafeInteger,
    name: nullableText,
    assetsRoleId: positiveSafeInteger,
  }).strict()).max(20_000),
}).strict();

const novelRowSchema = z.object({
  id: positiveSafeInteger,
  chapter: nullableText.optional(),
  chapterData: nullableText.optional(),
  chapterIndex: nullableSafeInteger.optional(),
  createTime: nullableSafeInteger.optional(),
  errorReason: nullableText.optional(),
  event: nullableText.optional(),
  eventState: nullableSafeInteger.optional(),
  projectId: nullableSafeInteger.optional(),
  reel: nullableText.optional(),
}).strict();

const novelListRowSchema = z.object({
  id: positiveSafeInteger,
  index: nullableSafeInteger,
  reel: nullableText,
  chapter: nullableText,
  chapterData: nullableText,
  event: nullableText,
  eventState: nullableSafeInteger,
  errorReason: nullableText,
}).strict();

const scriptRowSchema = z.object({
  id: positiveSafeInteger,
  content: nullableText.optional(),
  createTime: nullableSafeInteger.optional(),
  errorReason: nullableText.optional(),
  extractState: nullableSafeInteger.optional(),
  name: nullableText.optional(),
  projectId: nullableSafeInteger.optional(),
}).strict();

const scriptListRowSchema = z.object({
  id: positiveSafeInteger,
  name: nullableText,
  content: nullableText,
  extractState: nullableSafeInteger,
  errorReason: nullableText,
  createTime: nullableSafeInteger,
  relatedAssets: z.array(z.object({
    id: positiveSafeInteger,
    name: nullableText,
  }).strict()).max(20_000),
}).strict();

const storyboardRowSchema = z.object({
  id: positiveSafeInteger,
  createTime: nullableSafeInteger.optional(),
  duration: nullableText.optional(),
  filePath: nullableText.optional(),
  flowId: nullableSafeInteger.optional(),
  index: nullableSafeInteger.optional(),
  projectId: nullableSafeInteger.optional(),
  prompt: nullableText.optional(),
  reason: nullableText.optional(),
  scriptId: nullableSafeInteger.optional(),
  shouldGenerateImage: nullableSafeInteger.optional(),
  state: nullableText.optional(),
  storageKey: nullableText.optional(),
  track: nullableText.optional(),
  trackId: nullableSafeInteger.optional(),
  videoDesc: nullableText.optional(),
}).strict();

const storyboardShotSchema = z.object({
  id: positiveSafeInteger,
  createTime: nullableSafeInteger.optional(),
  duration: finiteNumber.optional(),
  filePath: z.string().max(4_000_000).optional(),
  prompt: nullableText.optional(),
  scriptId: nullableSafeInteger.optional(),
  projectId: nullableSafeInteger.optional(),
  state: z.string().max(100),
  reason: z.string().max(4_000_000),
  videoDesc: z.string().max(20_000),
  shouldGenerateImage: safeInteger,
  trackId: nullableSafeInteger.optional(),
  characters: z.array(z.object({
    name: z.string().max(500),
    type: z.string().max(100),
    avatar: z.string().max(4_000_000).optional(),
  }).strict()).max(20_000),
  index: nullableSafeInteger,
}).strict();

const generationStoryboardSchema = storyboardRowSchema.extend({
  src: z.string().max(4_000_000),
}).strict();

const taskCenterRowSchema = z.object({
  id: idScalar,
  projectId: nullableSafeInteger,
  projectName: nullableText,
  taskClass: nullableText,
  relatedObjects: z.string().max(4_000_000),
  model: z.string().max(500),
  describe: z.string().max(4_000_000),
  state: nullableText,
  startTime: nullableSafeInteger,
  reason: nullableText,
  workspaceId: z.string().max(200).nullable().optional(),
  source: z.enum(["legacy", "relay"]),
  origin: z.lazy(() => taskOriginSchema).nullable(),
}).strict();

const projectImageTaskSchema = z.object({
  taskId: positiveSafeInteger,
  projectId: positiveSafeInteger,
  flow: z.enum(["storyboard", "asset"]),
  assetId: nullableSafeInteger,
  scriptId: nullableSafeInteger,
  storyboardId: nullableSafeInteger,
  phase: z.enum([
    "preparing",
    "queued",
    "dispatching",
    "provider_succeeded",
    "persisting",
    "succeeded",
    "failed",
    "cancelled",
    "pending_reconcile",
  ]),
  state: z.enum([
    "queued",
    "running",
    "succeeded",
    "failed",
    "cancelled",
    "pending_reconcile",
  ]),
  cancelAllowed: z.boolean(),
  model: z.string().max(500),
  reason: nullableText,
  startedAt: nullableSafeInteger,
  response: safeJsonValue.nullable(),
}).strict();

const canvasAssetSnapshotSchema = z.object({
  nodes: z.array(safeJsonValue).max(20_000),
  edges: z.array(safeJsonValue).max(20_000),
  bounds: safeJsonValue,
  meta: boundedJsonObject.optional(),
}).catchall(safeJsonValue);
const canvasAssetSchema = z.object({
  id: scopeIdString,
  userId: scopeIdString,
  projectId: positiveSafeInteger,
  name: z.string().max(500),
  saveLocation: z.string().max(4_000),
  tag: z.string().max(4_000),
  coverUrl: z.string().max(4_000_000),
  assetType: z.enum(["snapshot", "portrait"]),
  referenceAssetUri: z.string().max(4_000_000).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  snapshot: canvasAssetSnapshotSchema,
}).strict();

const canvasWorkflowBoundsSchema = z.object({
  left: finiteNumber,
  top: finiteNumber,
  right: finiteNumber,
  bottom: finiteNumber,
}).strict();
const canvasWorkflowSnapshotSchema = z.object({
  nodes: z.array(boundedJsonObject).max(500),
  edges: z.array(boundedJsonObject).max(2_000),
  layoutMode: z.enum(["grid", "horizontal", "vertical"]),
  themeColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  bounds: canvasWorkflowBoundsSchema,
}).strict();
const canvasWorkflowSchema = z.object({
  id: scopeIdString,
  userId: scopeIdString,
  name: z.string().max(500),
  coverUrl: z.string().max(4_000_000),
  coverNodeId: z.string().max(256).optional(),
  note: z.string().max(20_000).optional(),
  groupSnapshot: canvasWorkflowSnapshotSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

const creationCorrelationSchema = z.object({
  version: z.literal(1),
  projectDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  generationDigest: z.string().regex(/^[a-f0-9]{64}$/),
  taskDigest: z.string().regex(/^[a-f0-9]{64}$/),
  assetDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
const creationObservabilitySchema = z.object({
  version: z.literal(1),
  prompt: z.string().max(2_000),
  parameters: z.record(
    z.string().max(100),
    z.union([z.string().max(120), finiteNumber, z.boolean()]),
  ),
  requestRef: z.string().regex(/^req_[a-f0-9]{24}$/),
  correlation: creationCorrelationSchema,
}).strict();

const libraryItemSchema = z.object({
  id: idScalar,
  taskId: idScalar,
  assetId: nullableSafeInteger,
  assetVersionId: nullableSafeInteger,
  assetType: z.string().max(100),
  url: z.string().max(4_000_000),
  mimeType: z.string().max(500),
  width: nullableSafeInteger,
  height: nullableSafeInteger,
  durationMs: nullableSafeInteger,
  status: z.string().max(100),
  endpointType: z.string().max(200),
  model: z.string().max(500),
  source: z.enum(["\u5feb\u901f\u521b\u4f5c", "\u9879\u76ee\u521b\u4f5c", "API"]),
  requestId: z.string().max(500),
  prompt: z.string().max(4_000),
  projectId: nullableSafeInteger,
  correlation: creationCorrelationSchema,
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  errorMessage: z.string().max(4_000),
  metadata: boundedJsonObject,
  createdAt: nonNegativeSafeInteger,
}).strict();

const quickCreateTaskAttemptSchema = z.object({
  videoId: positiveSafeInteger,
  trackId: nullableSafeInteger,
  scriptId: nullableSafeInteger,
  projectId: nullableSafeInteger,
  relayTaskId: z.string().max(200).nullable(),
  requestId: z.string().max(500).nullable(),
  status: z.string().min(1).max(100),
  state: z.string().max(100),
  prompt: z.string().max(20_000),
  duration: finiteNumber,
  url: z.string().max(4_000_000),
  errorReason: z.string().max(4_000),
  createdAt: nonNegativeSafeInteger,
}).strict();
const quickCreateTaskSchema = quickCreateTaskAttemptSchema.extend({
  history: z.array(quickCreateTaskAttemptSchema).max(20_000),
  hiddenHistoryCount: nonNegativeSafeInteger,
}).strict();

const finalVideoAssetSchema = z.object({
  id: scopeIdString,
  taskId: scopeIdString,
  assetId: nullableSafeInteger,
  assetVersionId: nullableSafeInteger,
  url: z.string().max(4_000_000),
  width: nonNegativeSafeInteger,
  height: nonNegativeSafeInteger,
  durationMs: nonNegativeSafeInteger,
  createdAt: nonNegativeSafeInteger,
  audioIncluded: z.boolean(),
  task: z.object({
    id: scopeIdString,
    state: z.string().max(100),
    reason: nullableText,
    startedAt: nonNegativeSafeInteger,
  }).strict().nullable(),
}).strict();

const generateMediaSchema = z.object({
  id: positiveSafeInteger.optional(),
  name: nullableText.optional(),
  describe: nullableText.optional(),
  type: nullableText.optional(),
  fileType: z.enum(["image", "video", "audio"]),
  sources: z.enum(["storyboard", "assets"]).optional(),
  prompt: nullableText.optional(),
  videoDesc: z.string().max(20_000).optional(),
  src: z.string().max(4_000_000),
  index: nullableSafeInteger.optional(),
}).strict();
const generateVideoSchema = z.object({
  id: positiveSafeInteger,
  src: z.string().max(4_000_000),
  state: z.enum(["\u672a\u751f\u6210", "\u751f\u6210\u4e2d", "\u5df2\u5b8c\u6210", "\u751f\u6210\u5931\u8d25"]),
  errorReason: z.string().max(4_000).optional(),
  relayTaskId: z.string().max(200).nullable(),
  relay: z.object({
    id: scopeIdString,
    status: z.string().max(100),
    providerTaskId: z.string().max(500).nullable(),
    processingStage: z.string().max(200),
    resolutionPlan: z.object({
      requestedResolution: safeJsonScalar.nullable(),
      generationResolution: safeJsonScalar.nullable(),
      finalResolution: safeJsonScalar.nullable(),
      needsEnhancement: z.boolean(),
    }).strict().nullable(),
    storage: z.object({
      source: z.string().max(200),
      mirrored: z.boolean(),
      label: z.string().max(500),
    }).strict().nullable(),
  }).strict().nullable(),
}).strict();
const generateTrackSchema = z.object({
  id: positiveSafeInteger.optional(),
  prompt: z.string().max(20_000),
  state: z.enum(["\u672a\u751f\u6210", "\u751f\u6210\u4e2d", "\u5df2\u5b8c\u6210", "\u751f\u6210\u5931\u8d25"]),
  reason: z.string().max(4_000).optional(),
  duration: finiteNumber.optional(),
  selectVideoId: finiteNumber.optional(),
  medias: z.array(generateMediaSchema).max(20_000),
  videoList: z.array(generateVideoSchema).max(20_000),
}).strict();

const taskOriginSchema = z.object({
  version: z.literal(1),
  surface: z.enum(["quick-create", "production", "canvas", "agent"]),
  projectId: positiveSafeInteger,
  scriptId: positiveSafeInteger.optional(),
  trackId: positiveSafeInteger.optional(),
}).strict();

const taskMediaAssetSchema = z.object({
  assetType: z.enum(["video", "image", "audio", "file"]),
  url: z.string().max(4_000_000),
  mimeType: z.string().max(500),
  correlation: creationCorrelationSchema,
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
const relayTaskProgressSchema = z.object({
  status: z.string().max(100),
  stage: z.enum([
    "queued",
    "generating",
    "processing",
    "completed",
    "failed",
    "cancelled",
  ]),
  stageLabel: z.string().max(500),
  progress: finiteNumber,
  progressPercent: finiteNumber,
  targetResolution: nullableText,
  needsTargetProcessing: z.boolean(),
}).strict();
const legacyTaskDetailSchema = z.object({
  id: positiveSafeInteger,
  projectId: nullableSafeInteger.optional(),
  taskClass: nullableText.optional(),
  relatedObjects: nullableText.optional(),
  model: nullableText.optional(),
  describe: nullableText.optional(),
  state: nullableText.optional(),
  startTime: nullableSafeInteger.optional(),
  reason: nullableText.optional(),
  mediaAssets: z.array(taskMediaAssetSchema).max(20),
  observability: creationObservabilitySchema,
}).strict();
const relayTaskDetailSchema = taskCenterRowSchema.extend({
  observability: creationObservabilitySchema,
  relay: z.object({
    progress: relayTaskProgressSchema,
    submittedAt: nullableSafeInteger,
    completedAt: nullableSafeInteger,
  }).strict(),
  mediaAssets: z.array(taskMediaAssetSchema).max(20),
  video: z.object({
    id: idScalar,
    videoTrackId: idScalar.nullable(),
  }).strict().nullable(),
  syntheticQuarantine: z.object({
    active: z.literal(true),
    reason: z.string().max(4_000),
  }).strict().nullable(),
}).strict();
const taskDetailSchema = z.union([
  legacyTaskDetailSchema,
  relayTaskDetailSchema,
]);

const billingLedgerSchema = z.object({
  id: z.string().min(1).max(200),
  workspaceId: z.string().min(1).max(200),
  accountId: z.string().min(1).max(200),
  type: z.string().min(1).max(100),
  status: z.string().min(1).max(100),
  amountMicros: safeInteger,
  remainingMicros: safeInteger,
  currency: z.string().min(1).max(20),
  balanceBeforeMicros: safeInteger,
  balanceAfterMicros: safeInteger,
  frozenBeforeMicros: safeInteger,
  frozenAfterMicros: safeInteger,
  creditLimitMicros: safeInteger,
  relatedLedgerId: z.string().max(200).nullable(),
  usageRecordId: z.string().max(200).nullable(),
  taskId: z.string().max(200).nullable(),
  apiKeyId: z.string().max(200).nullable(),
  requestId: z.string().max(500).nullable(),
  idempotencyKey: z.string().max(500).nullable(),
  description: nullableText,
  metadata: boundedJsonObject,
  operatorUserId: nullableSafeInteger,
  createTime: nonNegativeSafeInteger,
  updateTime: nonNegativeSafeInteger,
  amountGu: finiteNumber.optional(),
  amountYuan: finiteNumber.optional(),
  amountYuanEquivalent: finiteNumber.optional(),
  createdAt: nonNegativeSafeInteger.optional(),
}).strict();
const usageRecordSchema = z.object({
  id: z.string().min(1).max(200),
  taskId: z.string().max(200).nullable(),
  apiKeyId: z.string().max(200).nullable(),
  workspaceId: z.string().max(200).nullable(),
  provider: z.string().max(200).nullable(),
  channelId: z.string().max(200).nullable(),
  endpointType: z.string().max(200),
  model: z.string().max(500).nullable(),
  units: finiteNumber,
  unit: z.string().max(100),
  costMicros: safeInteger,
  currency: z.string().max(20),
  status: z.string().max(100),
  createTime: nonNegativeSafeInteger,
}).strict();
const billingAccountSchema = z.object({
  id: z.string().min(1).max(200),
  workspaceId: z.string().min(1).max(200),
  currency: z.string().max(20),
  balanceMicros: safeInteger,
  creditLimitMicros: safeInteger,
  frozenMicros: safeInteger,
  availableMicros: safeInteger,
  planId: z.string().max(200).nullable(),
  status: z.string().max(100),
  currentPeriodStart: nullableSafeInteger,
  currentPeriodEnd: nullableSafeInteger,
  metadata: boundedJsonObject,
  createTime: nonNegativeSafeInteger,
  updateTime: nonNegativeSafeInteger,
  reservedMicros: safeInteger,
  allocatedQuotaMicros: safeInteger,
  reservedQuotaMicros: safeInteger,
  remainingQuotaMicros: safeInteger,
  ownerSpendableMicros: safeInteger,
  balanceGu: finiteNumber,
  creditLimitGu: finiteNumber,
  reservedGu: finiteNumber,
  availableGu: finiteNumber,
  balanceYuan: finiteNumber,
  creditLimitYuan: finiteNumber,
  reservedYuan: finiteNumber,
  availableYuan: finiteNumber,
  balanceYuanEquivalent: finiteNumber,
  creditLimitYuanEquivalent: finiteNumber,
  reservedYuanEquivalent: finiteNumber,
  availableYuanEquivalent: finiteNumber,
}).strict();
const accountWalletSchema = z.object({
  id: z.string().min(1).max(200),
  userId: positiveSafeInteger,
  currency: z.string().max(20),
  balanceMicros: safeInteger,
  giftBalanceMicros: safeInteger,
  cashReservedMicros: safeInteger,
  giftReservedMicros: safeInteger,
  creditLimitMicros: safeInteger,
  creditUsedMicros: safeInteger,
  creditReservedMicros: safeInteger,
  status: z.string().max(100),
  metadata: boundedJsonObject,
  createdAt: nonNegativeSafeInteger,
  updatedAt: nonNegativeSafeInteger,
  cashAvailableMicros: safeInteger,
  giftAvailableMicros: safeInteger,
  creditAvailableMicros: safeInteger,
  totalAvailableMicros: safeInteger,
  balanceGu: finiteNumber,
  giftBalanceGu: finiteNumber,
  creditLimitGu: finiteNumber,
  totalAvailableGu: finiteNumber,
  balanceYuanEquivalent: finiteNumber,
  ownerUserId: positiveSafeInteger,
  defaultWorkspaceId: z.string().max(200).nullable(),
  isDefaultWorkspace: z.boolean(),
}).strict();
const billingPlanSchema = z.object({
  id: z.string().min(1).max(200),
  code: z.string().max(200),
  name: z.string().max(500),
  status: z.string().max(100),
  currency: z.string().max(20),
  billingPeriod: z.string().max(100),
  priceMicros: safeInteger,
  includedCreditsMicros: safeInteger,
  creditLimitMicros: safeInteger,
  quotas: boundedJsonObject,
  features: boundedJsonObject,
  metadata: boundedJsonObject,
  createTime: nonNegativeSafeInteger,
  updateTime: nonNegativeSafeInteger,
  apiQuota: finiteNumber,
  memberLimit: finiteNumber,
  keyLimit: finiteNumber,
}).strict();
const billingSubscriptionSchema = z.object({
  id: z.string().min(1).max(200),
  workspaceId: z.string().min(1).max(200),
  planId: z.string().min(1).max(200),
  status: z.string().max(100),
  currentPeriodStart: nullableSafeInteger,
  currentPeriodEnd: nullableSafeInteger,
  cancelAt: nullableSafeInteger,
  metadata: boundedJsonObject,
  createTime: nonNegativeSafeInteger,
  updateTime: nonNegativeSafeInteger,
}).strict();
const billingOverviewSchema = z.object({
  account: billingAccountSchema,
  accountWallet: accountWalletSchema.nullable(),
  plan: billingPlanSchema.nullable(),
  subscription: billingSubscriptionSchema.nullable(),
  ledger: z.object({
    items: z.array(billingLedgerSchema).max(20_000),
    total: nonNegativeSafeInteger,
    pageNum: positiveSafeInteger,
    pageSize: positiveSafeInteger,
  }).strict(),
  latestRecharge: billingLedgerSchema.nullable(),
  usage: z.object({
    items: z.array(usageRecordSchema).max(20_000),
    total: nonNegativeSafeInteger,
    pageNum: positiveSafeInteger,
    pageSize: positiveSafeInteger,
    chargedCalls: nonNegativeSafeInteger,
    reservedCalls: nonNegativeSafeInteger,
    totalCostMicros: safeInteger,
    totalCostGu: finiteNumber,
    totalCostYuan: finiteNumber,
    totalCostYuanEquivalent: finiteNumber,
    reservedCostMicros: safeInteger,
    reservedCostGu: finiteNumber,
    reservedCostYuan: finiteNumber,
    reservedCostYuanEquivalent: finiteNumber,
  }).strict(),
  recentLedger: z.array(billingLedgerSchema).max(20_000),
}).strict();

const publicPricingModelSchema = z.object({
  id: idScalar,
  model_name: z.string().max(500),
  name: z.string().max(500),
  description: nullableText,
  vendor_id: z.null(),
  vendor_name: z.string().max(200),
  vendor_icon: z.string().max(200),
  category: z.string().max(200),
  endpoint_type: z.string().max(200),
  api_style: z.string().max(200),
  modalities: z.array(z.string().max(200)).max(100),
  output: z.string().max(200),
  status: z.enum(["disabled", "active", "unconfigured"]),
  quota_type: z.union([z.literal(0), z.literal(1)]),
  unit: z.string().max(100),
  currency: z.string().max(20),
  unit_price_micros: nonNegativeSafeInteger,
  pricing_configured: z.boolean(),
  input_price_micros: nullableSafeInteger,
  output_price_micros: nullableSafeInteger,
  model_ratio: finiteNumber,
  completion_ratio: finiteNumber,
  capabilities: z.array(z.string().max(200)).max(100),
  context_length: nullableFiniteNumber,
  max_output_tokens: nullableFiniteNumber,
  tags: z.string().max(20_000),
  enable_groups: z.array(z.literal("default")).max(1),
  supported_endpoint_types: z.array(z.string().max(200)).max(100),
}).strict();
const publicPricingSchema = z.object({
  data: z.array(publicPricingModelSchema).max(10_000),
  vendors: z.array(z.object({
    id: positiveSafeInteger,
    name: z.string().max(200),
    icon: z.string().max(200),
    description: z.null(),
  }).strict()).max(10_000),
  group_ratio: z.object({ default: z.literal(1) }).strict(),
  usable_group: z.object({
    default: z.object({
      desc: z.literal("Default group"),
      ratio: z.literal(1),
    }).strict(),
  }).strict(),
  supported_endpoint: z.record(z.string().max(200), z.string().max(200)),
  auto_groups: z.array(z.literal("default")).max(1),
}).strict();

const durationCapabilitySchema = z.object({
  min: finiteNumber,
  max: finiteNumber,
  step: finiteNumber,
  default: finiteNumber,
  auto: z.boolean().optional(),
  allowed: z.array(finiteNumber).max(1_000).optional(),
}).strict();
const inputSlotSchema = z.object({
  id: z.string().max(200).optional(),
  label: z.string().max(500).optional(),
  role: z.string().max(200).optional(),
  roles: z.array(z.string().max(200)).max(100).optional(),
  accepts: z.array(z.string().max(200)).max(100).optional(),
  min: finiteNumber.optional(),
  max: finiteNumber.optional(),
  modes: z.array(z.string().max(200)).max(100).optional(),
  required: z.boolean().optional(),
  mediaType: z.string().max(200).optional(),
  allowDuplicateAsset: z.boolean().optional(),
  supportsTrim: z.boolean().optional(),
}).strict();
const videoGenerationDirectorySchema = z.object({
  version: z.literal("workbench-video-generation/v1"),
  contractFamily: z.string().min(1).max(200).nullable(),
  dispatchable: z.boolean(),
  operations: z.array(z.object({
    operation: z.enum(["generate", "extend", "edit"]),
    enabled: z.boolean(),
    modes: z.array(z.string().max(100)).max(100),
    aspectRatios: z.array(z.string().max(100)).max(100).optional(),
    duration: durationCapabilitySchema,
    resolutions: z.array(z.string().max(100)).max(100),
  }).strict()).max(3),
  inputSlots: z.array(z.object({
    id: z.string().min(1).max(200),
    label: z.string().min(1).max(500),
    mediaTypes: z.array(z.enum(["image", "video", "audio"])).max(3),
    roles: z.array(z.enum(["subject", "style", "storyboard", "first_frame", "last_frame"])).max(5),
    operations: z.array(z.enum(["generate", "extend", "edit"])).max(3),
    modes: z.array(z.string().max(100)).max(100),
    min: z.number().int().nonnegative(),
    max: z.number().int().positive(),
    allowDuplicateAsset: z.boolean(),
    supportsTrim: z.boolean(),
  }).strict()).max(100),
  totalInputLimit: z.number().int().nonnegative().max(100),
  mediaTypeLimits: z.object({
    image: z.number().int().nonnegative().max(100),
    video: z.number().int().nonnegative().max(100),
    audio: z.number().int().nonnegative().max(100),
  }).strict(),
  supportsGenerateAudio: z.boolean(),
  supportsPreserveSourceAudio: z.boolean(),
  supportsMask: z.boolean(),
  supportsTimeRange: z.boolean(),
  supportsSourceTaskContinuation: z.boolean(),
}).strict();
const genericCatalogCapabilitySchema = z.object({
  status: z.string().min(1).max(100),
  canSubmit: z.boolean(),
  unavailableReason: nullableText,
}).strict();
const imageCatalogCapabilitySchema = genericCatalogCapabilitySchema.extend({
  aliases: z.array(z.string().max(500)).max(100),
  description: nullableText,
  aspectRatios: z.array(z.string().max(100)).max(100),
  defaultAspectRatio: z.string().max(100).nullable(),
  inputSlots: z.array(inputSlotSchema).max(100),
  qualities: z.array(z.string().max(100)).max(100),
  defaultQuality: z.string().max(100).nullable(),
  maxOutputs: z.literal(1),
}).strict();
const videoCatalogCapabilitySchema = genericCatalogCapabilitySchema.extend({
  aliases: z.array(z.string().max(500)).max(100),
  description: nullableText,
  aspectRatios: z.array(z.string().max(100)).max(100),
  defaultAspectRatio: z.string().max(100).nullable(),
  inputSlots: z.array(inputSlotSchema).max(100),
  resolutions: z.array(z.string().max(100)).max(100),
  defaultResolution: z.string().max(100).nullable(),
  duration: durationCapabilitySchema.nullable(),
  supportsGenerateAudio: z.boolean().nullable(),
  modes: z.array(z.string().max(100)).max(100),
  videoGeneration: videoGenerationDirectorySchema,
}).strict();
const catalogCapabilitySchema = z.union([
  genericCatalogCapabilitySchema,
  imageCatalogCapabilitySchema,
  videoCatalogCapabilitySchema,
]);

const catalogEntrySchema = z.object({
  id: z.string().min(1).max(300),
  model: z.string().min(1).max(300),
  type: z.enum(["video", "image", "text", "audio"]),
  name: z.string().min(1).max(300),
  displayName: z.string().min(1).max(300),
  enhanceDisplayName: z.string().max(300).nullable().optional(),
  capabilities: catalogCapabilitySchema,
  isDefault: z.boolean(),
}).strict();

const workbenchModelCapabilitySchema = z.object({
  id: z.string().min(1).max(300),
  model: z.string().min(1).max(300),
  aliases: z.array(z.string().max(500)).max(100).optional(),
  label: z.string().max(500),
  description: z.string().max(20_000).optional(),
  endpointType: z.enum(["image_generation", "video_generation"]),
  capabilityStatus: z.enum([
    "verified",
    "configured",
    "legacy",
    "unverified",
    "unavailable",
  ]),
  canSubmit: z.boolean(),
  unavailableReason: z.string().max(4_000).optional(),
  routeId: z.string().max(300).optional(),
  routeName: z.string().max(500).optional(),
  displayName: z.string().max(500).optional(),
  enhanceDisplayName: z.string().max(500).optional(),
  qualities: z.array(z.string().max(100)).max(100).optional(),
  defaultQuality: z.string().max(100).optional(),
  maxOutputs: positiveSafeInteger.optional(),
  resolutions: z.array(z.string().max(100)).max(100).optional(),
  defaultResolution: z.string().max(100).optional(),
  aspectRatios: z.array(z.string().max(100)).max(100),
  defaultAspectRatio: z.string().max(100).optional(),
  duration: durationCapabilitySchema.optional(),
  supportsGenerateAudio: z.boolean().optional(),
  modes: z.array(z.string().max(100)).max(100).optional(),
  inputSlots: z.array(inputSlotSchema).max(100).optional(),
  videoGeneration: videoGenerationDirectorySchema.optional(),
  source: z.object({ kind: z.enum(["route", "channel"]) }).strict(),
}).strict();
const workbenchTextModelSchema = z.object({
  id: z.string().min(1).max(300),
  label: z.string().max(500),
  description: z.string().max(4_000),
  capabilityStatus: z.literal("verified"),
  canSubmit: z.literal(true),
}).strict();

const modelDirectorySchema = z.object({
  type: z.enum(["video", "image", "text", "audio", "all"]),
  defaults: z.object({
    image: z.string().min(1).max(300).optional(),
    video: z.string().min(1).max(300).optional(),
    text: z.string().min(1).max(300).optional(),
    agentChat: z.string().min(1).max(300).optional(),
  }).strict(),
  models: z.array(catalogEntrySchema).max(10_000),
}).strict();

const modelOptionsDataSchema = z.object({
  catalogVersion: z.string().min(1).max(200),
  models: z.array(workbenchModelCapabilitySchema).max(10_000),
  llmModels: z.array(workbenchTextModelSchema).max(10_000),
  imageModels: z.array(workbenchModelCapabilitySchema).max(10_000),
  videoModels: z.array(workbenchModelCapabilitySchema).max(10_000),
}).strict();

const imageTaskStatusResponseSchema = z.object({
  code: z.literal(0),
  data: z.array(projectImageTaskSchema).max(100),
}).strict();

type CandidateSignedReadPathBinding = "project" | "resource";
export type CandidateSignedReadResponseScope =
  | "none"
  | "project-bound"
  | "workspace-project-list";
export type CandidateSignedReadFixtureMissClass = "trusted-read" | "local-only";
export type CandidateSignedReadReuseProjection =
  | "none"
  | "authorized-library-image";

type CandidateSignedReadContractDefinition = Readonly<{
  id: string;
  methods: readonly CandidateSignedReadMethod[];
  path: string | RegExp;
  querySchema: z.ZodType<Record<string, string>>;
  bodySchema: z.ZodType<Record<string, unknown>>;
  responseSchema: z.ZodType<unknown>;
  pathBinding?: CandidateSignedReadPathBinding;
  projectBodyKeys: readonly string[];
  projectBodyRequired: boolean;
  resourceBodyKeys: readonly string[];
  resourceQueryKeys: readonly string[];
  responseScope: CandidateSignedReadResponseScope;
  fixtureMissClass: CandidateSignedReadFixtureMissClass;
  reuseProjection: CandidateSignedReadReuseProjection;
}>;

function contract(input: CandidateSignedReadContractDefinition): CandidateSignedReadContractDefinition {
  return Object.freeze({
    ...input,
    methods: Object.freeze([...input.methods]),
    projectBodyKeys: Object.freeze([...input.projectBodyKeys]),
    resourceBodyKeys: Object.freeze([...input.resourceBodyKeys]),
    resourceQueryKeys: Object.freeze([...input.resourceQueryKeys]),
  });
}

function get(input: {
  id: string;
  path: string | RegExp;
  querySchema?: z.ZodType<Record<string, string>>;
  responseSchema: z.ZodType<unknown>;
  pathBinding?: CandidateSignedReadPathBinding;
  resourceQueryKeys?: readonly string[];
  responseScope?: CandidateSignedReadResponseScope;
  fixtureMissClass?: CandidateSignedReadFixtureMissClass;
  reuseProjection?: CandidateSignedReadReuseProjection;
}): CandidateSignedReadContractDefinition {
  return contract({
    id: input.id,
    methods: ["GET", "HEAD"],
    path: input.path,
    querySchema: input.querySchema ?? emptyObjectSchema,
    bodySchema: emptyObjectSchema,
    responseSchema: input.responseSchema,
    ...(input.pathBinding ? { pathBinding: input.pathBinding } : {}),
    projectBodyKeys: [],
    projectBodyRequired: false,
    resourceBodyKeys: [],
    resourceQueryKeys: input.resourceQueryKeys ?? [],
    responseScope: input.responseScope ?? "none",
    fixtureMissClass: input.fixtureMissClass ?? "trusted-read",
    reuseProjection: input.reuseProjection ?? "none",
  });
}

function post(input: {
  id: string;
  path: string;
  bodySchema: z.ZodType<Record<string, unknown>>;
  responseSchema: z.ZodType<unknown>;
  projectBodyKeys?: readonly string[];
  projectBodyRequired?: boolean;
  resourceBodyKeys?: readonly string[];
  responseScope?: CandidateSignedReadResponseScope;
  fixtureMissClass?: CandidateSignedReadFixtureMissClass;
  reuseProjection?: CandidateSignedReadReuseProjection;
}): CandidateSignedReadContractDefinition {
  return contract({
    id: input.id,
    methods: ["POST"],
    path: input.path,
    querySchema: emptyObjectSchema,
    bodySchema: input.bodySchema,
    responseSchema: input.responseSchema,
    projectBodyKeys: input.projectBodyKeys ?? [],
    projectBodyRequired: input.projectBodyRequired ?? false,
    resourceBodyKeys: input.resourceBodyKeys ?? [],
    resourceQueryKeys: [],
    responseScope: input.responseScope ?? "none",
    fixtureMissClass: input.fixtureMissClass ?? "trusted-read",
    reuseProjection: input.reuseProjection ?? "none",
  });
}

const projectQuerySchema = z.object({
  projectId: scopeIdString,
}).strict();
function isAgentThreadCursor(value: string): boolean {
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) return false;
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return Boolean(
      parsed
      && typeof parsed === "object"
      && !Array.isArray(parsed)
      && Object.keys(parsed).length === 2
      && Number.isSafeInteger(parsed.updatedAt)
      && parsed.updatedAt >= 0
      && typeof parsed.id === "string"
      && parsed.id.length >= 1
      && parsed.id.length <= 200
      && /^[A-Za-z0-9._:-]+$/.test(parsed.id),
    );
  } catch {
    return false;
  }
}
const agentThreadListQuerySchema = z.object({
  projectId: scopeIdString,
  before: z.string().min(1).max(500).regex(/^[A-Za-z0-9_-]+$/)
    .refine(isAgentThreadCursor).optional(),
  limit: z.string().regex(/^(?:[1-9]|[1-9]\d|100)$/).optional(),
}).strict();
const agentMessageListQuerySchema = z.object({
  after: nonNegativeIntegerQuery.optional(),
  limit: z.string().regex(/^(?:[1-9]|[1-9]\d|1\d\d|200)$/).optional(),
}).strict();

function legacyArrayResponse<T extends z.ZodTypeAny>(
  rowSchema: T,
  max = 20_000,
) {
  return legacySuccess(z.array(rowSchema).max(max));
}

function legacyPagedResponse<T extends z.ZodTypeAny>(rowSchema: T) {
  return legacySuccess(z.object({
    data: z.array(rowSchema).max(20_000),
    total: z.union([nonNegativeSafeInteger, z.string().regex(/^\d+$/)]),
  }).strict());
}

/**
 * The sole response-signing registry. Browser policy, trusted fetch/cache,
 * recovery admission and the API response signer must resolve a route through
 * this immutable table. Every route owns an exact request-query/body schema
 * and a route-specific response envelope.
 */
export const CANDIDATE_SIGNED_READ_CONTRACTS = Object.freeze([
  get({
    id: "internal-database-attestation",
    path: "/api/internal/candidate-runtime-database-attestation",
    responseSchema: z.object({
      ok: z.literal(true),
      databaseConnectionBinding: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      queryOnly: z.literal(true),
      journalMode: z.literal("delete"),
      attachedDatabaseCount: z.literal(0),
    }).strict(),
  }),
  get({ id: "auth-me", path: "/api/auth/me", responseSchema: legacySuccess(authProfileSchema) }),
  get({ id: "account-profile", path: "/api/account/profile", responseSchema: legacySuccess(accountProfileSchema) }),
  get({
    id: "assets-get",
    path: "/api/assets/getAssetsApi",
    querySchema: z.object({
      projectId: scopeIdString,
      type: z.string().trim().min(1).max(50),
      name: boundedText.optional(),
      page: positiveIntegerQuery.optional(),
      limit: positiveIntegerQuery.optional(),
    }).strict(),
    responseSchema: legacyPagedResponse(assetRowSchema),
    responseScope: "project-bound",
  }),
  get({
    id: "billing-overview",
    path: "/api/billing/overview",
    querySchema: z.object({ workspaceId: workspaceId.optional() }).strict(),
    responseSchema: legacySuccess(billingOverviewSchema),
  }),
  get({ id: "canvas-list", path: "/api/canvas/list", responseSchema: legacyArrayResponse(workspaceCanvasSummarySchema) }),
  get({
    id: "canvas-load",
    path: "/api/canvas/load",
    querySchema: z.object({ canvasId: positiveIntegerQuery }).strict(),
    resourceQueryKeys: ["canvasId"],
    responseSchema: legacySuccess(canonicalCanvasSchema),
  }),
  get({
    id: "canvas-assets",
    path: "/api/canvas/assets",
    querySchema: projectQuerySchema,
    responseSchema: legacySuccess(z.object({
      assets: z.array(canvasAssetSchema).max(20_000),
    }).strict()),
    responseScope: "project-bound",
  }),
  get({
    id: "canvas-workflows",
    path: "/api/canvas/workflows",
    responseSchema: legacySuccess(z.object({
      workflows: z.array(canvasWorkflowSchema).max(20_000),
    }).strict()),
  }),
  get({
    id: "developer-notice",
    path: "/api/developer/config/notice",
    responseSchema: legacySuccess(z.object({ notice: z.string().max(20_000) }).strict()),
  }),
  get({
    id: "project-get",
    path: "/api/project/getProject",
    querySchema: z.object({ workspaceId: workspaceId.optional() }).strict(),
    responseSchema: legacyArrayResponse(correlatedProjectSchema),
    responseScope: "workspace-project-list",
  }),
  get({
    id: "projects",
    path: "/api/projects",
    responseSchema: legacySuccess(z.object({
      projects: z.array(canonicalProjectSchema).max(20_000),
    }).strict()),
    responseScope: "workspace-project-list",
  }),
  get({
    id: "project-folders",
    path: "/api/project-folders",
    responseSchema: legacySuccess(z.object({ folders: z.array(folderSchema).max(10_000) }).strict()),
  }),
  get({ id: "public-pricing", path: "/api/public/pricing", responseSchema: legacySuccess(publicPricingSchema) }),
  get({
    id: "model-options",
    path: "/api/workbench/create/modelOptions",
    responseSchema: legacySuccess(modelOptionsDataSchema),
  }),
  get({
    id: "model-catalog",
    path: "/api/workbench/models/catalog",
    querySchema: z.object({ type: z.enum(["video", "image", "text", "audio"]).optional() }).strict(),
    responseSchema: legacySuccess(modelDirectorySchema),
  }),
  get({
    id: "agent-skills",
    path: "/api/agent/skills",
    responseSchema: agentSuccess(z.object({
      skills: z.array(z.object({
        key: z.string().min(1).max(100),
        version: z.string().min(1).max(50),
        displayName: z.string().min(1).max(200),
        roles: z.array(z.string().min(1).max(100)).max(20),
      }).strict()).max(100),
    }).strict()),
  }),
  get({
    id: "agent-chat-models",
    path: "/api/agent/chat-models",
    responseSchema: agentSuccess(z.object({
      available: z.boolean(),
      reason: z.string().min(1).max(100).nullable(),
      message: z.string().min(1).max(1_000).nullable(),
      capabilities: z.object({
        chat: z.boolean(),
        tools: z.boolean(),
        imageGeneration: z.boolean(),
        videoGeneration: z.boolean(),
      }).strict(),
      models: z.array(agentChatModelSchema).max(100),
    }).strict()),
  }),
  get({
    id: "agent-threads",
    path: "/api/agent/threads",
    querySchema: agentThreadListQuerySchema,
    responseSchema: agentSuccess(z.object({
      data: z.array(agentThreadSchema).max(100),
      nextCursor: z.string().min(1).max(500).regex(/^[A-Za-z0-9_-]+$/)
        .refine(isAgentThreadCursor).nullable(),
    }).strict()),
  }),
  get({
    id: "agent-thread",
    path: /^\/api\/agent\/threads\/([A-Za-z0-9._:-]{1,200})$/,
    pathBinding: "resource",
    responseSchema: agentSuccess(agentThreadSchema),
  }),
  get({
    id: "agent-thread-messages",
    path: /^\/api\/agent\/threads\/([A-Za-z0-9._:-]{1,200})\/messages$/,
    pathBinding: "resource",
    querySchema: agentMessageListQuerySchema,
    responseSchema: agentSuccess(z.object({
      data: z.array(agentMessageSchema).max(200),
      nextCursor: z.number().int().nonnegative().safe().nullable(),
    }).strict()),
  }),
  get({
    id: "project-canvases",
    path: /^\/api\/projects\/([A-Za-z0-9._:-]{1,200})\/canvases$/,
    pathBinding: "project",
    responseSchema: legacySuccess(z.object({
      canvases: z.array(projectCanvasSummarySchema).max(20_000),
    }).strict()),
  }),
  get({
    id: "agent-project-budget",
    path: /^\/api\/agent\/projects\/([A-Za-z0-9._:-]{1,200})\/budget$/,
    pathBinding: "project",
    responseSchema: agentSuccess(z.object({
      projectId: z.number().int().positive().safe(),
      agentBudgetMicros: z.number().int().positive().safe().nullable(),
      agentBudgetReservedMicros: z.number().int().nonnegative().safe(),
      autoApproveEnabled: z.boolean(),
    }).strict()),
    responseScope: "project-bound",
  }),
  post({
    id: "assets-post",
    path: "/api/assets/getAssetsApi",
    bodySchema: z.object({
      projectId: scopeId,
      type: z.string().trim().min(1).max(50),
      name: boundedText.optional(),
      page: z.number().int().positive().safe(),
      limit: z.number().int().positive().max(1_000).safe(),
    }).strict(),
    projectBodyKeys: ["projectId"],
    projectBodyRequired: true,
    responseSchema: legacyPagedResponse(assetRowSchema),
    responseScope: "project-bound",
  }),
  post({
    id: "corner-assets",
    path: "/api/cornerScape/getAllAssets",
    bodySchema: z.object({
      projectId: scopeId,
      type: z.array(z.enum(["role", "scene", "tool"])).max(3).optional(),
    }).strict(),
    projectBodyKeys: ["projectId"],
    projectBodyRequired: true,
    responseSchema: legacyArrayResponse(cornerAssetSchema),
    responseScope: "project-bound",
  }),
  post({
    id: "single-project",
    path: "/api/general/getSingleProject",
    bodySchema: z.object({ id: scopeId }).strict(),
    projectBodyKeys: ["id"],
    projectBodyRequired: true,
    responseSchema: legacyArrayResponse(databaseProjectSchema, 1),
    responseScope: "project-bound",
  }),
  post({
    id: "novel",
    path: "/api/novel/getNovel",
    bodySchema: z.object({
      projectId: scopeId,
      page: z.number().int().positive().safe(),
      limit: z.number().int().positive().max(1_000).safe(),
      search: boundedText.optional(),
    }).strict(),
    projectBodyKeys: ["projectId"],
    projectBodyRequired: true,
    responseSchema: legacyPagedResponse(novelListRowSchema),
    responseScope: "project-bound",
  }),
  post({
    id: "novel-data",
    path: "/api/novel/getNovelData",
    bodySchema: z.object({ projectId: scopeId }).strict(),
    projectBodyKeys: ["projectId"],
    projectBodyRequired: true,
    responseSchema: legacyArrayResponse(novelRowSchema),
    responseScope: "project-bound",
  }),
  post({
    id: "storyboard",
    path: "/api/production/getStoryboardData",
    bodySchema: z.object({ projectId: scopeId, scriptId: scopeId }).strict(),
    projectBodyKeys: ["projectId"],
    projectBodyRequired: true,
    resourceBodyKeys: ["scriptId"],
    responseSchema: legacyArrayResponse(storyboardShotSchema),
    responseScope: "project-bound",
  }),
  post({
    id: "storyboard-image-task-status",
    path: "/api/production/storyboard/batchGenerateImage/tasks/status",
    bodySchema: z.object({
      projectId: scopeId,
      taskIds: z.array(scopeId).max(100).optional(),
    }).strict(),
    projectBodyKeys: ["projectId"],
    projectBodyRequired: true,
    resourceBodyKeys: ["taskIds"],
    responseSchema: imageTaskStatusResponseSchema,
    responseScope: "project-bound",
  }),
  post({
    id: "editor-draft",
    path: "/api/production/workbench/getEditorDraft",
    bodySchema: z.object({
      projectId: scopeId,
      episodesId: z.union([scopeId, z.literal(-8)]),
    }).strict(),
    projectBodyKeys: ["projectId"],
    projectBodyRequired: true,
    resourceBodyKeys: ["episodesId"],
    responseSchema: legacySuccess(z.object({
      data: safeJsonValue.nullable(),
      updatedAt: z.union([z.number().finite(), z.string().max(200)]).nullable(),
      corrupted: z.literal(true).optional(),
    }).strict()),
    responseScope: "project-bound",
  }),
  post({
    id: "final-video",
    path: "/api/production/workbench/getFinalVideo",
    bodySchema: z.object({ projectId: scopeId }).strict(),
    projectBodyKeys: ["projectId"],
    projectBodyRequired: true,
    responseSchema: legacySuccess(z.object({
      asset: finalVideoAssetSchema.nullable(),
    }).strict()),
    responseScope: "project-bound",
  }),
  post({
    id: "generate-data",
    path: "/api/production/workbench/getGenerateData",
    bodySchema: z.object({ projectId: scopeId, scriptId: scopeId }).strict(),
    projectBodyKeys: ["projectId"],
    projectBodyRequired: true,
    resourceBodyKeys: ["scriptId"],
    responseSchema: legacySuccess(z.object({
      storyboardList: z.array(generationStoryboardSchema).max(20_000),
      trackList: z.array(generateTrackSchema).max(20_000),
    }).strict()),
    fixtureMissClass: "local-only",
    responseScope: "project-bound",
  }),
  post({
    id: "project-post",
    path: "/api/project/getProject",
    bodySchema: z.object({ workspaceId: workspaceId.optional().nullable() }).strict(),
    responseSchema: legacyArrayResponse(correlatedProjectSchema),
    responseScope: "workspace-project-list",
  }),
  post({
    id: "script",
    path: "/api/script/getScrptApi",
    bodySchema: z.object({ projectId: scopeId, name: boundedText.optional() }).strict(),
    projectBodyKeys: ["projectId"],
    projectBodyRequired: true,
    responseSchema: legacyArrayResponse(scriptListRowSchema),
    responseScope: "project-bound",
  }),
  post({
    id: "task-project",
    path: "/api/task/getProject",
    bodySchema: z.object({ workspaceId: workspaceId.optional().nullable() }).strict(),
    responseSchema: legacyArrayResponse(projectNameSchema),
    responseScope: "workspace-project-list",
  }),
  post({
    id: "tasks",
    path: "/api/task/getTaskApi",
    bodySchema: z.object({
      state: boundedText.optional().nullable(),
      taskClass: boundedText.optional().nullable(),
      projectId: scopeId,
      keyword: boundedText.optional().nullable(),
      startTimeFrom: z.number().int().nonnegative().safe().optional().nullable(),
      startTimeTo: z.number().int().nonnegative().safe().optional().nullable(),
      page: z.number().int().positive().safe(),
      limit: z.number().int().positive().max(1_000).safe(),
    }).strict(),
    projectBodyKeys: ["projectId"],
    projectBodyRequired: true,
    responseSchema: legacyPagedResponse(taskCenterRowSchema),
    responseScope: "project-bound",
  }),
  post({
    id: "task-categories",
    path: "/api/task/getTaskCategories",
    bodySchema: z.object({ workspaceId: workspaceId.optional().nullable() }).strict(),
    responseSchema: legacySuccess(z.array(z.object({
      taskClass: z.string().min(1).max(200),
    }).strict()).max(10_000)),
  }),
  post({
    id: "task-detail",
    path: "/api/task/taskDetails",
    bodySchema: z.object({
      taskId: scopeId,
      source: z.enum(["legacy", "relay"]).optional().nullable(),
      projectId: scopeId,
    }).strict(),
    projectBodyKeys: ["projectId"],
    projectBodyRequired: true,
    resourceBodyKeys: ["taskId"],
    responseSchema: legacySuccess(taskDetailSchema),
    responseScope: "project-bound",
  }),
  post({
    id: "image-task-status",
    path: "/api/workbench/create/images/tasks/status",
    bodySchema: z.object({
      projectId: scopeId,
      taskIds: z.array(scopeId).max(100).optional(),
    }).strict(),
    projectBodyKeys: ["projectId"],
    projectBodyRequired: true,
    resourceBodyKeys: ["taskIds"],
    responseSchema: imageTaskStatusResponseSchema,
    responseScope: "project-bound",
  }),
  post({
    id: "model-options-post",
    path: "/api/workbench/create/modelOptions",
    bodySchema: emptyObjectSchema,
    responseSchema: legacySuccess(modelOptionsDataSchema),
  }),
  post({
    id: "creation-tasks",
    path: "/api/workbench/create/tasks",
    bodySchema: z.object({ projectId: scopeId }).strict(),
    projectBodyKeys: ["projectId"],
    projectBodyRequired: true,
    responseSchema: legacyArrayResponse(quickCreateTaskSchema),
    fixtureMissClass: "local-only",
    responseScope: "project-bound",
  }),
  post({
    id: "library",
    path: "/api/workbench/library/list",
    bodySchema: z.object({
      projectId: scopeId,
      page: z.number().int().positive().safe().optional(),
      limit: z.number().int().positive().max(60).safe().optional(),
      type: boundedText.optional().nullable(),
      status: boundedText.optional().nullable(),
      keyword: boundedText.optional().nullable(),
    }).strict(),
    projectBodyKeys: ["projectId"],
    projectBodyRequired: true,
    responseSchema: legacySuccess(z.object({
      data: z.array(libraryItemSchema).max(20_000),
      total: z.number().int().nonnegative().safe(),
      page: z.number().int().positive().safe(),
      limit: z.number().int().positive().max(60).safe(),
    }).strict()),
    responseScope: "project-bound",
    reuseProjection: "authorized-library-image",
  }),
] as const);

export type CandidateSignedReadScope = Readonly<{
  projectId?: string | number;
  workspaceId?: string | number;
  allowedResourceIds?: ReadonlySet<string>;
}>;

export type CandidateSignedReadProjection = Readonly<{
  revision: typeof CANDIDATE_SIGNED_READ_CONTRACT_REVISION;
  contractId: string;
  method: CandidateSignedReadMethod;
  normalizedPath: string;
  normalizedQuery: string;
  normalizedTarget: string;
  requestBody: Readonly<Record<string, unknown>>;
}>;

export type CandidateSignedReadPolicy = Readonly<{
  projection: CandidateSignedReadProjection;
  responseScope: CandidateSignedReadResponseScope;
  fixtureMissClass: CandidateSignedReadFixtureMissClass;
  reuseProjection: CandidateSignedReadReuseProjection;
}>;

function canonicalQuery(input: URL): {
  record: Record<string, string>;
  value: string;
} {
  const record: Record<string, string> = {};
  for (const [key, value] of input.searchParams) {
    if (
      !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key)
      || Object.prototype.hasOwnProperty.call(record, key)
      || value.length > 2_048
    ) fail("CANDIDATE_SIGNED_READ_QUERY_INVALID");
    record[key] = value;
  }
  const sorted = new URLSearchParams();
  for (const key of Object.keys(record).sort((a, b) => a.localeCompare(b, "en"))) {
    sorted.set(key, record[key]);
  }
  return { record, value: sorted.toString() };
}

function parseTarget(value: unknown): {
  path: string;
  query: Record<string, string>;
  normalizedQuery: string;
  normalizedTarget: string;
} {
  const raw = String(value || "");
  if (
    !raw.startsWith("/api/")
    || raw.length > 4_096
    || /[\0\r\n\\#]/.test(raw)
    || /%(?:2e|2f|5c)/i.test(raw)
  ) fail("CANDIDATE_SIGNED_READ_TARGET_INVALID");
  let parsed: URL;
  try {
    parsed = new URL(raw, "http://candidate.invalid");
  } catch {
    return fail("CANDIDATE_SIGNED_READ_TARGET_INVALID");
  }
  if (
    parsed.origin !== "http://candidate.invalid"
    || parsed.username
    || parsed.password
    || parsed.hash
    || /\/{2,}/.test(parsed.pathname)
  ) fail("CANDIDATE_SIGNED_READ_TARGET_INVALID");
  const path = parsed.pathname.length > 1
    ? parsed.pathname.replace(/\/+$/, "")
    : parsed.pathname;
  const query = canonicalQuery(parsed);
  return {
    path,
    query: query.record,
    normalizedQuery: query.value,
    normalizedTarget: `${path}${query.value ? `?${query.value}` : ""}`,
  };
}

function parseBody(
  value: unknown,
  schema: z.ZodType<Record<string, unknown>>,
): Record<string, unknown> {
  let body = value;
  if (typeof body === "string") {
    if (Buffer.byteLength(body, "utf8") > 1024 * 1024) {
      fail("CANDIDATE_SIGNED_READ_BODY_INVALID");
    }
    try {
      body = body.trim() === "" ? {} : JSON.parse(body);
    } catch {
      return fail("CANDIDATE_SIGNED_READ_BODY_INVALID");
    }
  }
  if (body === undefined || body === null) body = {};
  const parsed = schema.safeParse(body);
  if (!parsed.success) fail("CANDIDATE_SIGNED_READ_BODY_INVALID");
  const serialized = JSON.stringify(parsed.data);
  if (
    /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i.test(serialized)
    || /"(?:api[-_]?key|authorization|cookie|credential|password|secret|token)"\s*:/i.test(serialized)
  ) fail("CANDIDATE_SIGNED_READ_BODY_INVALID");
  return parsed.data;
}

function definitionFor(
  method: CandidateSignedReadMethod,
  path: string,
): {
  definition: CandidateSignedReadContractDefinition;
  pathBindingValue?: string;
} {
  for (const definition of CANDIDATE_SIGNED_READ_CONTRACTS) {
    if (!(definition.methods as readonly string[]).includes(method)) continue;
    if (typeof definition.path === "string") {
      if (definition.path === path) return { definition };
      continue;
    }
    const match = path.match(definition.path);
    if (match) return { definition, pathBindingValue: match[1] };
  }
  return fail("CANDIDATE_SIGNED_READ_CONTRACT_NOT_FOUND");
}

function assertScope(input: {
  definition: CandidateSignedReadContractDefinition;
  pathBindingValue?: string;
  query: Record<string, string>;
  body: Record<string, unknown>;
  scope?: CandidateSignedReadScope;
}): void {
  if (!input.scope) return;
  const expectedProject = input.scope.projectId === undefined
    ? undefined
    : String(input.scope.projectId);
  const allowedResources = input.scope.allowedResourceIds ?? new Set<string>();
  if (input.definition.pathBinding === "project") {
    if (
      expectedProject === undefined
      || input.pathBindingValue !== expectedProject
    ) fail("CANDIDATE_SIGNED_READ_SCOPE_INVALID");
  }
  if (input.definition.pathBinding === "resource") {
    if (
      input.pathBindingValue === undefined
      || !allowedResources.has(input.pathBindingValue)
    ) fail("CANDIDATE_SIGNED_READ_SCOPE_INVALID");
  }
  if (
    input.query.projectId !== undefined
    && (expectedProject === undefined || input.query.projectId !== expectedProject)
  ) fail("CANDIDATE_SIGNED_READ_SCOPE_INVALID");
  if (input.query.workspaceId !== undefined) {
    if (
      input.scope.workspaceId === undefined
      || input.query.workspaceId !== String(input.scope.workspaceId)
    ) fail("CANDIDATE_SIGNED_READ_SCOPE_INVALID");
  }
  if (Object.prototype.hasOwnProperty.call(input.body, "workspaceId")) {
    const actualWorkspace = input.body.workspaceId;
    if (
      actualWorkspace !== null
      && actualWorkspace !== undefined
      && (
        input.scope.workspaceId === undefined
        || String(actualWorkspace) !== String(input.scope.workspaceId)
      )
    ) fail("CANDIDATE_SIGNED_READ_SCOPE_INVALID");
  }
  const suppliedProjectKeys = input.definition.projectBodyKeys.filter((key) => (
    Object.prototype.hasOwnProperty.call(input.body, key)
  ));
  if (
    suppliedProjectKeys.some((key) => (
      expectedProject === undefined || String(input.body[key]) !== expectedProject
    ))
    || (
      input.definition.projectBodyRequired
      && (expectedProject === undefined || suppliedProjectKeys.length === 0)
    )
  ) fail("CANDIDATE_SIGNED_READ_SCOPE_INVALID");
  for (const key of input.definition.resourceQueryKeys) {
    const value = input.query[key];
    if (value !== undefined && !allowedResources.has(value)) {
      fail("CANDIDATE_SIGNED_READ_SCOPE_INVALID");
    }
  }
  for (const key of input.definition.resourceBodyKeys) {
    if (!Object.prototype.hasOwnProperty.call(input.body, key)) continue;
    const values = Array.isArray(input.body[key])
      ? input.body[key] as unknown[]
      : [input.body[key]];
    if (
      key === "episodesId"
      && input.definition.id === "editor-draft"
      && values.length === 1
      && Number(values[0]) === -8
    ) continue;
    if (values.some((item) => !allowedResources.has(String(item)))) {
      fail("CANDIDATE_SIGNED_READ_SCOPE_INVALID");
    }
  }
}

export function resolveCandidateSignedReadContract(input: {
  method: unknown;
  requestTarget: unknown;
  requestBody?: unknown;
  scope?: CandidateSignedReadScope;
}): CandidateSignedReadProjection {
  const method = String(input.method || "").trim().toUpperCase();
  if (!(<[string, string, string]>["GET", "HEAD", "POST"]).includes(method)) {
    fail("CANDIDATE_SIGNED_READ_METHOD_INVALID");
  }
  const typedMethod = method as CandidateSignedReadMethod;
  const target = parseTarget(input.requestTarget);
  const resolved = definitionFor(typedMethod, target.path);
  const queryResult = resolved.definition.querySchema.safeParse(target.query);
  if (!queryResult.success) fail("CANDIDATE_SIGNED_READ_QUERY_INVALID");
  if (typedMethod !== "POST" && input.requestBody !== undefined) {
    fail("CANDIDATE_SIGNED_READ_BODY_INVALID");
  }
  const body = typedMethod === "POST"
    ? parseBody(input.requestBody, resolved.definition.bodySchema)
    : {};
  assertScope({
    definition: resolved.definition,
    pathBindingValue: resolved.pathBindingValue,
    query: queryResult.data,
    body,
    scope: input.scope,
  });
  return Object.freeze({
    revision: CANDIDATE_SIGNED_READ_CONTRACT_REVISION,
    contractId: resolved.definition.id,
    method: typedMethod,
    normalizedPath: target.path,
    normalizedQuery: target.normalizedQuery,
    normalizedTarget: target.normalizedTarget,
    requestBody: Object.freeze({ ...body }),
  });
}

/**
 * Resolves request admission and the route-owned response policy in one pass.
 * Callers must not recreate path sets for project filtering or fixture
 * behavior; those semantics are part of the signed registry entry.
 */
export function resolveCandidateSignedReadPolicy(input: {
  method: unknown;
  requestTarget: unknown;
  requestBody?: unknown;
  scope?: CandidateSignedReadScope;
}): CandidateSignedReadPolicy {
  const projection = resolveCandidateSignedReadContract(input);
  const definition = CANDIDATE_SIGNED_READ_CONTRACTS.find(
    (item) => item.id === projection.contractId,
  );
  if (!definition) fail("CANDIDATE_SIGNED_READ_REGISTRY_INVALID");
  return Object.freeze({
    projection,
    responseScope: definition.responseScope,
    fixtureMissClass: definition.fixtureMissClass,
    reuseProjection: definition.reuseProjection,
  });
}

/** Route membership only; request signing must always call the full resolver. */
export function candidateSignedReadContractHasRoute(input: {
  method: unknown;
  path: unknown;
}): boolean {
  const method = String(input.method || "").trim().toUpperCase();
  if (!(<[string, string, string]>["GET", "HEAD", "POST"]).includes(method)) {
    return false;
  }
  try {
    const target = parseTarget(input.path);
    definitionFor(method as CandidateSignedReadMethod, target.path);
    return Object.keys(target.query).length === 0;
  } catch {
    return false;
  }
}

export function candidateSignedReadStaticPaths(
  method: CandidateSignedReadMethod,
): readonly string[] {
  return Object.freeze(CANDIDATE_SIGNED_READ_CONTRACTS.flatMap((definition) => (
    typeof definition.path === "string" && definition.methods.includes(method)
      ? [definition.path]
      : []
  )));
}

export function candidateSignedReadStaticPathsByPolicy(input: Readonly<{
  method: CandidateSignedReadMethod;
  fixtureMissClass?: CandidateSignedReadFixtureMissClass;
  responseScope?: CandidateSignedReadResponseScope;
}>): readonly string[] {
  return Object.freeze(CANDIDATE_SIGNED_READ_CONTRACTS.flatMap((definition) => (
    typeof definition.path === "string"
    && definition.methods.includes(input.method)
    && (
      input.fixtureMissClass === undefined
      || definition.fixtureMissClass === input.fixtureMissClass
    )
    && (
      input.responseScope === undefined
      || definition.responseScope === input.responseScope
    )
      ? [definition.path]
      : []
  )));
}

export function validateCandidateSignedReadResponse(input: {
  projection: CandidateSignedReadProjection;
  status: number;
  contentType: unknown;
  body: Buffer | Uint8Array | string;
}): unknown {
  if (
    input.projection.revision !== CANDIDATE_SIGNED_READ_CONTRACT_REVISION
    || !Number.isSafeInteger(input.status)
    || input.status < 200
    || input.status >= 300
  ) fail("CANDIDATE_SIGNED_READ_RESPONSE_INVALID");
  const contentType = String(input.contentType || "").trim().toLowerCase();
  if (!contentType.includes("application/json") || /[\r\n\0]/.test(contentType)) {
    fail("CANDIDATE_SIGNED_READ_RESPONSE_INVALID");
  }
  const bytes = typeof input.body === "string"
    ? Buffer.from(input.body, "utf8")
    : Buffer.from(input.body);
  if (bytes.byteLength > 32 * 1024 * 1024) {
    fail("CANDIDATE_SIGNED_READ_RESPONSE_INVALID");
  }
  if (input.projection.method === "HEAD") {
    if (bytes.byteLength !== 0) fail("CANDIDATE_SIGNED_READ_RESPONSE_INVALID");
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return fail("CANDIDATE_SIGNED_READ_RESPONSE_INVALID");
  }
  let canonical: CandidateSignedReadProjection;
  try {
    canonical = resolveCandidateSignedReadContract({
      method: input.projection.method,
      requestTarget: input.projection.normalizedTarget,
      ...(input.projection.method === "POST"
        ? { requestBody: input.projection.requestBody }
        : {}),
    });
  } catch {
    return fail("CANDIDATE_SIGNED_READ_RESPONSE_INVALID");
  }
  if (
    canonical.contractId !== input.projection.contractId
    || canonical.normalizedPath !== input.projection.normalizedPath
    || canonical.normalizedQuery !== input.projection.normalizedQuery
  ) fail("CANDIDATE_SIGNED_READ_RESPONSE_INVALID");
  const definition = CANDIDATE_SIGNED_READ_CONTRACTS.find(
    (item) => item.id === canonical.contractId,
  );
  if (!definition || !definition.responseSchema.safeParse(parsed).success) {
    fail("CANDIDATE_SIGNED_READ_RESPONSE_INVALID");
  }
  return parsed;
}

export function candidateSignedReadContractSelfCheck(): Readonly<{
  revision: typeof CANDIDATE_SIGNED_READ_CONTRACT_REVISION;
  contractCount: number;
  contractIds: readonly string[];
}> {
  const contractIds = CANDIDATE_SIGNED_READ_CONTRACTS.map((item) => item.id);
  const routeKeys = CANDIDATE_SIGNED_READ_CONTRACTS.flatMap((item) => (
    item.methods.map((method) => `${method}:${String(item.path)}`)
  ));
  if (
    new Set(contractIds).size !== contractIds.length
    || new Set(routeKeys).size !== routeKeys.length
    || contractIds.some((id) => !/^[a-z0-9-]{2,80}$/.test(id))
    || CANDIDATE_SIGNED_READ_CONTRACTS.some((item) => (
      item.methods.length === 0
      || (item.path instanceof RegExp && !item.pathBinding)
    ))
  ) fail("CANDIDATE_SIGNED_READ_REGISTRY_INVALID");
  return Object.freeze({
    revision: CANDIDATE_SIGNED_READ_CONTRACT_REVISION,
    contractCount: contractIds.length,
    contractIds: Object.freeze([...contractIds]),
  });
}
