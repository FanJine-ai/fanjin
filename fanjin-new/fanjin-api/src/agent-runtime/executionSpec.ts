import { z } from "zod";
import type { AgentApproval } from "@/agent-runtime/approvalService";
import type { AgentTaskRef } from "@/agent-runtime/delegationContracts";
import type { DelegationGrantRecord } from "@/agent-runtime/delegationGrantService";
import type {
  GenerationQuoteBinding,
  VerifiedAgentGenerationQuote,
} from "@/agent-runtime/generationQuoteService";
import { hashIdempotencyRequest } from "@/agent-runtime/idempotency";

export const EXECUTION_SPEC_VERSION = 1 as const;
export const EXECUTION_SPEC_VIDEO_RESOLUTIONS = ["480p", "720p", "1080p", "2160p", "2k", "4k"] as const;

const EXECUTION_INPUT_REF_TYPES = ["script", "asset", "asset_version", "storyboard", "canvas"] as const;
const EXECUTION_TOOL_IDS = ["generation.image.submit", "generation.video.submit"] as const;
const SAFE_ID_PATTERN = /^[^\s\u0000-\u001f\u007f]+$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const IMAGE_SIZE_PATTERN = /^(\d{2,5})x(\d{2,5})$/;

const boundedId = (max = 200) => z.string().trim().min(1).max(max).regex(SAFE_ID_PATTERN);
const boundedText = (max: number) => z.string().trim().min(1).max(max).refine((value) => !value.includes("\u0000"));
const digest = z.string().regex(SHA256_PATTERN);

const projectRefSchema = z.object({
  type: z.literal("project"),
  id: boundedId(),
  version: boundedId(),
}).strict();

const inputRefSchema = z.object({
  type: z.enum(EXECUTION_INPUT_REF_TYPES),
  id: boundedId(),
  version: boundedId(),
}).strict();

const imageSizeSchema = z.string().trim().transform((value) => value.toLowerCase().replace(/\s+/g, ""))
  .refine((value) => {
    const match = IMAGE_SIZE_PATTERN.exec(value);
    if (!match) return false;
    const width = Number(match[1]);
    const height = Number(match[2]);
    return width >= 64 && width <= 16_384 && height >= 64 && height <= 16_384;
  }, "图片 size 必须是 64 到 16384 范围内的 WIDTHxHEIGHT");

const commonIntent = {
  provider: boundedId(100),
  model: boundedId(200),
  prompt: boundedText(32_000),
};

const imageIntentSchema = z.object({
  generationType: z.literal("image"),
  ...commonIntent,
  units: z.number().int().min(1).max(10),
  size: imageSizeSchema,
}).strict();

const videoIntentSchema = z.object({
  generationType: z.literal("video"),
  ...commonIntent,
  units: z.literal(1),
  resolution: z.string().trim().toLowerCase().pipe(z.enum(EXECUTION_SPEC_VIDEO_RESOLUTIONS)),
  durationSeconds: z.number().int().min(1).max(86_400),
}).strict();

export const executionSpecSchema = z.object({
  version: z.literal(EXECUTION_SPEC_VERSION),
  projectRef: projectRefSchema,
  inputRefs: z.array(inputRefSchema).max(50),
  intent: z.discriminatedUnion("generationType", [imageIntentSchema, videoIntentSchema]),
  tool: z.object({
    id: z.enum(EXECUTION_TOOL_IDS),
    version: boundedId(),
  }).strict(),
  authorization: z.object({
    quote: z.object({
      quoteId: boundedId(),
      bindingDigest: digest,
      pricingDigest: digest,
    }).strict(),
    approval: z.object({
      approvalId: boundedId(),
      scopeHash: digest,
    }).strict(),
    grant: z.object({
      grantId: boundedId(),
    }).strict(),
  }).strict(),
  idempotencyKey: boundedId(512),
  budget: z.object({
    currency: z.literal("GU"),
    maxEstimatedMicros: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    maxActualMicros: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  }).strict(),
}).strict().superRefine((spec, context) => {
  const expectedTool = spec.intent.generationType === "image"
    ? "generation.image.submit"
    : "generation.video.submit";
  if (spec.tool.id !== expectedTool) {
    context.addIssue({
      code: "custom",
      path: ["tool", "id"],
      message: "tool.id 与 generationType 不匹配",
    });
  }
  const identities = new Set<string>();
  spec.inputRefs.forEach((ref, index) => {
    const identity = `${ref.type}\u0000${ref.id}`;
    if (identities.has(identity)) {
      context.addIssue({ code: "custom", path: ["inputRefs", index], message: "inputRefs 不能重复" });
    }
    identities.add(identity);
  });
});

export type ExecutionSpec = z.infer<typeof executionSpecSchema>;
export type ExecutionSpecIntent = ExecutionSpec["intent"];
export type ExecutionSpecInputRef = Pick<AgentTaskRef, "id"> & {
  type: (typeof EXECUTION_INPUT_REF_TYPES)[number];
  version: string;
};

export type ExecutionSpecContractErrorCode =
  | "execution_spec_invalid"
  | "execution_spec_project_mismatch"
  | "execution_spec_resource_version_mismatch"
  | "execution_spec_quote_mismatch"
  | "execution_spec_approval_mismatch"
  | "execution_spec_grant_mismatch"
  | "execution_spec_resource_scope_mismatch"
  | "execution_spec_budget_exceeded"
  | "execution_spec_idempotency_mismatch";

const SAFE_MESSAGES: Readonly<Record<ExecutionSpecContractErrorCode, string>> = Object.freeze({
  execution_spec_invalid: "ExecutionSpec 格式无效",
  execution_spec_project_mismatch: "ExecutionSpec 项目绑定无效",
  execution_spec_resource_version_mismatch: "ExecutionSpec 资源版本绑定无效",
  execution_spec_quote_mismatch: "ExecutionSpec 报价绑定无效",
  execution_spec_approval_mismatch: "ExecutionSpec 审批绑定无效",
  execution_spec_grant_mismatch: "ExecutionSpec DelegationGrant 绑定无效",
  execution_spec_resource_scope_mismatch: "ExecutionSpec 输入引用超出 DelegationGrant 范围",
  execution_spec_budget_exceeded: "ExecutionSpec 超出报价或 DelegationGrant 预算上限",
  execution_spec_idempotency_mismatch: "ExecutionSpec 幂等键未绑定 DelegationGrant",
});

export class ExecutionSpecContractError extends Error {
  constructor(readonly code: ExecutionSpecContractErrorCode) {
    super(SAFE_MESSAGES[code]);
    this.name = "ExecutionSpecContractError";
  }
}

function fail(code: ExecutionSpecContractErrorCode): never {
  throw new ExecutionSpecContractError(code);
}

function refIdentity(ref: { type: string; id: string; version: string }): string {
  return `${ref.type}\u0000${ref.id}\u0000${ref.version}`;
}

export function normalizeExecutionSpec(input: unknown): ExecutionSpec {
  const parsed = executionSpecSchema.safeParse(input);
  if (!parsed.success) fail("execution_spec_invalid");
  return {
    ...parsed.data,
    projectRef: { ...parsed.data.projectRef },
    inputRefs: [...parsed.data.inputRefs]
      .sort((left, right) => refIdentity(left).localeCompare(refIdentity(right)))
      .map((ref) => ({ ...ref })),
    intent: { ...parsed.data.intent },
    tool: { ...parsed.data.tool },
    authorization: {
      quote: { ...parsed.data.authorization.quote },
      approval: { ...parsed.data.authorization.approval },
      grant: { ...parsed.data.authorization.grant },
    },
    budget: { ...parsed.data.budget },
  };
}

export function executionSpecApprovalArguments(input: unknown) {
  const spec = normalizeExecutionSpec(input);
  return {
    version: spec.version,
    projectRef: spec.projectRef,
    inputRefs: spec.inputRefs,
    intent: spec.intent,
    tool: spec.tool,
    quote: spec.authorization.quote,
    budget: spec.budget,
  };
}

export function hashExecutionSpecApprovalArguments(input: unknown): string {
  return hashIdempotencyRequest(executionSpecApprovalArguments(input));
}

export function hashExecutionSpec(input: unknown): string {
  return hashIdempotencyRequest(normalizeExecutionSpec(input));
}

export function executionSpecIdempotencyPayload(input: unknown) {
  const spec = normalizeExecutionSpec(input);
  const { idempotencyKey: _excluded, ...payload } = spec;
  return payload;
}

export function deriveExecutionSpecIdempotencyKey(input: unknown, grantIdempotencyPrefix: string): string {
  const prefix = String(grantIdempotencyPrefix || "");
  if (!SAFE_ID_PATTERN.test(prefix) || prefix.length > 400) fail("execution_spec_idempotency_mismatch");
  return `${prefix}:execution:${hashIdempotencyRequest(executionSpecIdempotencyPayload(input))}`;
}

export interface ExecutionSpecBindingEvidence {
  now: number;
  workspaceId: string;
  projectId: number;
  projectRevision: number;
  resourceVersions: Readonly<Record<string, string>>;
  parentRunId: string;
  executionRunId: string;
  quote: VerifiedAgentGenerationQuote;
  approval: AgentApproval;
  grant: DelegationGrantRecord;
}

// ─── 相邻分镜首尾帧配对（AGENTKIT-ADOPTION-CHECKLIST P1 1.3 / P5） ────────────
//
// AgentKit video_gen 验证的产品路径:4 张分镜图按相邻两张配对为首尾帧,
// 一次性生成 3 段过渡视频。这里把它建模为 Executor 确定性工作流的纯函数:
// 输入有序分镜资产版本序列,输出 (i, i+1) 配对列表;不经过模型自由调用。

export interface StoryboardTransitionPair {
  /** 从 0 开始的过渡段序号。 */
  index: number;
  firstFrameAssetVersionId: number;
  lastFrameAssetVersionId: number;
}

export type StoryboardTransitionPlanCode =
  | "storyboard_transition_frames_invalid"
  | "storyboard_transition_insufficient_frames";

const STORYBOARD_TRANSITION_MESSAGES: Readonly<Record<StoryboardTransitionPlanCode, string>> = Object.freeze({
  storyboard_transition_frames_invalid: "分镜序列必须是非重复的正整数资产版本 ID",
  storyboard_transition_insufficient_frames: "分镜序列至少需要 2 帧才能生成过渡视频",
});

export class StoryboardTransitionPlanError extends Error {
  constructor(readonly code: StoryboardTransitionPlanCode) {
    super(STORYBOARD_TRANSITION_MESSAGES[code]);
    this.name = "StoryboardTransitionPlanError";
  }
}

/**
 * 相邻分镜配对：[a, b, c, d] → [(a,b), (b,c), (c,d)]。
 * 输入必须是非空、非重复的正整数；空序列抛配置错误，单帧返回空数组；
 * 配对数量 = 帧数 - 1。
 */
export function pairAdjacentStoryboardFrames(
  storyboardAssetVersionIds: readonly number[],
): StoryboardTransitionPair[] {
  const frames = [...storyboardAssetVersionIds];
  if (frames.length === 0) throw new StoryboardTransitionPlanError("storyboard_transition_insufficient_frames");
  const seen = new Set<number>();
  for (const frame of frames) {
    if (!Number.isSafeInteger(frame) || frame <= 0 || seen.has(frame)) {
      throw new StoryboardTransitionPlanError("storyboard_transition_frames_invalid");
    }
    seen.add(frame);
  }
  const pairs: StoryboardTransitionPair[] = [];
  for (let index = 0; index + 1 < frames.length; index += 1) {
    pairs.push({
      index,
      firstFrameAssetVersionId: frames[index],
      lastFrameAssetVersionId: frames[index + 1],
    });
  }
  return pairs;
}

// ─── storyVideo 管线契约（AGENTKIT-ADOPTION-CHECKLIST P5） ────────────────────
//
// 端到端路径:故事 → 场景改写 → 分镜帧(资产版本) → 相邻配对过渡视频任务 →
// 成片拼接 → 托管预览。本契约只描述确定性计划(纯数据 + 纯展开函数);
// 每段的报价/审批/执行仍复用 generation.video.submit 的 R2 链路,拼接走
// video.merge(R2),本契约不引入任何新的副作用通道。

export const STORY_VIDEO_PIPELINE_SPEC_VERSION = 1 as const;

const storyVideoSceneSchema = z.object({
  summary: boundedText(2_000),
  transitionPrompt: boundedText(4_000).nullable(),
}).strict();

const storyVideoVideoIntentSchema = z.object({
  model: boundedId(200),
  ratio: z.string().trim().regex(/^\d{1,3}:\d{1,3}$/),
  resolution: z.string().trim().min(1).max(20),
  durationSeconds: z.union([z.literal(-1), z.number().int().min(1).max(60)]),
  generateAudio: z.boolean(),
}).strict();

export const storyVideoPipelineSpecSchema = z.object({
  version: z.literal(STORY_VIDEO_PIPELINE_SPEC_VERSION),
  projectRef: projectRefSchema,
  story: z.object({
    title: boundedText(200),
    scenes: z.array(storyVideoSceneSchema).min(1).max(12),
  }).strict(),
  /** 有序分镜帧资产版本;帧数必须恰为场景数 + 1(AgentKit:3 场景 4 帧)。 */
  storyboardAssetVersionIds: z.array(z.number().int().positive()).min(2).max(13),
  video: storyVideoVideoIntentSchema,
  /** 过渡段全部成功后是否触发成片拼接(P2 video.merge)。 */
  mergeTransitions: z.boolean(),
}).strict().superRefine((spec, context) => {
  if (spec.storyboardAssetVersionIds.length !== spec.story.scenes.length + 1) {
    context.addIssue({
      code: "custom",
      path: ["storyboardAssetVersionIds"],
      message: "分镜帧数必须等于场景数 + 1",
    });
  }
  const seen = new Set<number>();
  spec.storyboardAssetVersionIds.forEach((frame, index) => {
    if (seen.has(frame)) {
      context.addIssue({
        code: "custom",
        path: ["storyboardAssetVersionIds", index],
        message: "分镜帧资产版本不能重复",
      });
    }
    seen.add(frame);
  });
});

export type StoryVideoPipelineSpec = z.infer<typeof storyVideoPipelineSpecSchema>;

/**
 * 确定性过渡任务:每个相邻配对展开为一个 video submit 意图。
 * prompt 优先使用场景级 transitionPrompt,缺省回退到场景摘要;
 * 帧引用来自配对结果,模型不得在展开阶段改写。
 */
export interface StoryVideoTransitionTask {
  /** 与 StoryboardTransitionPair.index 对应。 */
  index: number;
  prompt: string;
  firstFrameAssetVersionId: number;
  lastFrameAssetVersionId: number;
  video: {
    model: string;
    ratio: string;
    resolution: string;
    durationSeconds: number;
    generateAudio: boolean;
  };
}

export function normalizeStoryVideoPipelineSpec(input: unknown): StoryVideoPipelineSpec {
  return storyVideoPipelineSpecSchema.parse(input);
}

/**
 * 把 storyVideo 管线计划展开为逐段过渡视频任务列表。
 * 纯函数:不查库、不调用工具;调用方(Executor)按顺序为每段走
 * generation.video.submit 的报价-审批-执行链路。
 */
export function planStoryVideoTransitionTasks(input: unknown): StoryVideoTransitionTask[] {
  const spec = normalizeStoryVideoPipelineSpec(input);
  const pairs = pairAdjacentStoryboardFrames(spec.storyboardAssetVersionIds);
  return pairs.map((pair) => {
    const scene = spec.story.scenes[pair.index];
    return {
      index: pair.index,
      prompt: scene?.transitionPrompt ?? scene?.summary ?? `第 ${pair.index + 1} 段过渡`,
      firstFrameAssetVersionId: pair.firstFrameAssetVersionId,
      lastFrameAssetVersionId: pair.lastFrameAssetVersionId,
      video: {
        model: spec.video.model,
        ratio: spec.video.ratio,
        resolution: spec.video.resolution,
        durationSeconds: spec.video.durationSeconds,
        generateAudio: spec.video.generateAudio,
      },
    };
  });
}

/**
 * storyVideo 失败语义(AGENTKIT-ADOPTION-CHECKLIST P5 5.2):
 * 单段过渡视频失败 → 管线失败,不自动重试扣费;重试只能通过显式的
 * generation.task.retry(新 Step)发起。本函数把逐段终态折叠为管线级
 * 结论,禁止把部分失败伪装成成功。
 */
export type StoryVideoTransitionOutcome =
  | { status: "pending"; succeededCount: number; totalCount: number }
  | { status: "succeeded"; succeededCount: number; totalCount: number }
  | {
    status: "failed";
    succeededCount: number;
    totalCount: number;
    failedIndexes: number[];
    /** 已成功段保留为已计费事实;失败段不自动重试。 */
    retryPolicy: "explicit-task-retry-only";
  };

export function foldStoryVideoTransitionOutcomes(
  outcomes: ReadonlyArray<{ index: number; status: "succeeded" | "failed" | "pending" }>,
): StoryVideoTransitionOutcome {
  const totalCount = outcomes.length;
  const succeededCount = outcomes.filter((outcome) => outcome.status === "succeeded").length;
  const failedIndexes = outcomes.filter((outcome) => outcome.status === "failed").map((outcome) => outcome.index);
  if (failedIndexes.length > 0) {
    return {
      status: "failed",
      succeededCount,
      totalCount,
      failedIndexes,
      retryPolicy: "explicit-task-retry-only",
    };
  }
  if (succeededCount === totalCount && totalCount > 0) {
    return { status: "succeeded", succeededCount, totalCount };
  }
  return { status: "pending", succeededCount, totalCount };
}

function sameQuoteBinding(intent: ExecutionSpecIntent, binding: GenerationQuoteBinding): boolean {
  return intent.generationType === binding.generationType
    && intent.provider === binding.provider
    && intent.model === binding.model
    && intent.units === binding.units;
}

function resourceScopeKey(type: ExecutionSpecInputRef["type"]): keyof DelegationGrantRecord["resourceScope"] {
  if (type === "script") return "scriptIds";
  if (type === "asset") return "assetIds";
  if (type === "asset_version") return "assetVersionIds";
  if (type === "storyboard") return "storyboardIds";
  return "canvasIds";
}

function expectedResourceVersions(spec: ExecutionSpec): Record<string, string> {
  return Object.fromEntries([
    [`project:${spec.projectRef.id}`, spec.projectRef.version],
    ...spec.inputRefs.map((ref) => [`${ref.type}:${ref.id}`, ref.version] as const),
  ]);
}

function hasExactResourceVersions(
  actual: unknown,
  expected: Readonly<Record<string, string>>,
): boolean {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
  const record = actual as Record<string, unknown>;
  const expectedKeys = Object.keys(expected);
  const actualKeys = Object.keys(record);
  return actualKeys.length === expectedKeys.length
    && expectedKeys.every((key) => Object.prototype.hasOwnProperty.call(record, key)
      && record[key] === expected[key]);
}

function hasRemainingBudget(consumed: number, requested: number, limit: number): boolean {
  return Number.isSafeInteger(consumed)
    && consumed >= 0
    && Number.isSafeInteger(limit)
    && limit >= 0
    && consumed <= limit
    && requested <= limit - consumed;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return isNonNegativeSafeInteger(value) && value > 0;
}

/**
 * Pure evidence check only. Callers must still reload and cryptographically
 * verify the quote, Approval and Grant immediately before any future dispatch.
 */
export function validateExecutionSpecBindings(
  input: unknown,
  evidence: ExecutionSpecBindingEvidence,
): ExecutionSpec {
  const spec = normalizeExecutionSpec(input);
  const now = evidence.now;
  if (!isNonNegativeSafeInteger(now)) fail("execution_spec_invalid");
  const projectRevision = evidence.projectRevision;
  if (!isPositiveSafeInteger(evidence.projectId)
    || !isPositiveSafeInteger(projectRevision)) fail("execution_spec_project_mismatch");
  if (spec.projectRef.id !== String(evidence.projectId)
    || spec.projectRef.version !== String(projectRevision)
    || evidence.grant.workspaceId !== evidence.workspaceId
    || evidence.grant.projectId !== String(evidence.projectId)) {
    fail("execution_spec_project_mismatch");
  }
  const resourceVersions = expectedResourceVersions(spec);
  if (!hasExactResourceVersions(evidence.resourceVersions, resourceVersions)
    || !hasExactResourceVersions(evidence.approval.resourceVersions, resourceVersions)) {
    fail("execution_spec_resource_version_mismatch");
  }

  const quote = evidence.quote;
  if (spec.authorization.quote.quoteId !== quote.quote.quoteId
    || spec.authorization.quote.bindingDigest !== quote.bindingDigest
    || spec.authorization.quote.pricingDigest !== quote.pricingDigest
    || !isNonNegativeSafeInteger(quote.quote.estimatedCostMicros)
    || !isNonNegativeSafeInteger(quote.quote.maximumCostMicros)
    || quote.quote.maximumCostMicros < quote.quote.estimatedCostMicros
    || !isPositiveSafeInteger(quote.quote.expiresAt)
    || quote.quote.expiresAt <= now
    || !sameQuoteBinding(spec.intent, quote.quote)) {
    fail("execution_spec_quote_mismatch");
  }
  if (quote.quote.estimatedCostMicros > spec.budget.maxEstimatedMicros
    || quote.quote.maximumCostMicros > spec.budget.maxActualMicros) {
    fail("execution_spec_budget_exceeded");
  }

  const approval = evidence.approval;
  if (spec.authorization.approval.approvalId !== approval.id
    || spec.authorization.approval.scopeHash !== approval.scopeHash
    || approval.workspaceId !== evidence.workspaceId
    || approval.projectId !== evidence.projectId
    || approval.runId !== evidence.parentRunId
    || approval.status !== "approved"
    || approval.consumedAt !== null
    || approval.consumedStepId !== null
    || approval.revokedAt !== null
    || approval.revokedBy !== null
    || !isPositiveSafeInteger(approval.expiresAt)
    || approval.expiresAt <= now
    || approval.riskClass !== "R2"
    || approval.evidenceKind !== "quote"
    || approval.toolId !== spec.tool.id
    || approval.toolVersion !== spec.tool.version
    || approval.argumentsHash !== hashExecutionSpecApprovalArguments(spec)
    || hashIdempotencyRequest(approval.quote) !== hashIdempotencyRequest(quote.approvalQuote)) {
    fail("execution_spec_approval_mismatch");
  }

  const grant = evidence.grant;
  if (spec.authorization.grant.grantId !== grant.id
    || grant.status !== "active"
    || !isPositiveSafeInteger(grant.expiresAt)
    || grant.expiresAt <= now
    || grant.parentRunId !== evidence.parentRunId
    || grant.boundRunId !== evidence.executionRunId
    || grant.granteeRole !== "executor"
    || !grant.allowedTools.includes(spec.tool.id)
    || !grant.approval
    || grant.approval.approvalId !== approval.id
    || grant.approval.scopeHash !== approval.scopeHash
    || grant.approval.policyVersion !== approval.policyVersion
    || !isPositiveSafeInteger(grant.limits.maxToolCalls)
    || !isNonNegativeSafeInteger(grant.consumedToolCalls)
    || grant.consumedToolCalls >= grant.limits.maxToolCalls
    || !Array.isArray(grant.limits.allowedModels)
    || !grant.limits.allowedModels.includes(spec.intent.model)
    || !isPositiveSafeInteger(grant.limits.maxOutputCount)
    || grant.limits.maxOutputCount < spec.intent.units
    || (spec.intent.generationType === "video"
      && (!isPositiveSafeInteger(grant.limits.maxDurationSeconds)
        || grant.limits.maxDurationSeconds < spec.intent.durationSeconds))) {
    fail("execution_spec_grant_mismatch");
  }
  for (const ref of spec.inputRefs) {
    if (!(grant.resourceScope[resourceScopeKey(ref.type)] ?? []).includes(ref.id)) {
      fail("execution_spec_resource_scope_mismatch");
    }
  }
  if (grant.spend.currency !== spec.budget.currency
    || !hasRemainingBudget(
      grant.consumedEstimatedMicros,
      spec.budget.maxEstimatedMicros,
      grant.spend.maxEstimatedMicros,
    )
    || !hasRemainingBudget(
      grant.consumedActualMicros,
      spec.budget.maxActualMicros,
      grant.spend.maxActualMicros,
    )) {
    fail("execution_spec_budget_exceeded");
  }
  if (spec.idempotencyKey !== deriveExecutionSpecIdempotencyKey(spec, grant.idempotencyPrefix)) {
    fail("execution_spec_idempotency_mismatch");
  }
  return spec;
}
