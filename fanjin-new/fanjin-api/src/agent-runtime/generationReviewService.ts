import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import { AGENT_GENERATION_REVIEW_TABLE } from "@/lib/migrations/agentGenerationReview";

/**
 * Reviewer 质量门(REVAMP-PLAN 2.3)。
 *
 * 一期规则版(本文件,不烧模型):generation submit 工具执行成功后,在
 * Gateway 同事务内校验 资产存在 / 尺寸与请求一致 / 时长(视频)/ prompt
 * 非空,产出结构化审核记录(o_agent_generation_review);任一规则失败则
 * verdict=attention 并置 needsHumanAttention=1(标记 Run 结果需人工注意),
 * 不自动重试、不改变工具执行语义。
 *
 * 二期模型版接口预留:GenerationReviewEvaluator 抽象允许接入
 * ModelGenerationReviewEvaluator——经既有委派链路(agent.delegate →
 * reviewer 子 Run → A4ReviewReportService)产出模型评估,落表时
 * engine="model_v1",与规则版记录按 (runId, stepId, engine) 共存。
 *
 * 存储选型说明(摸底结论):A4ReviewReportService.append 只允许 running 的
 * reviewer 委派 Run 经 running 的 review.report.create Tool Step 写入
 * (reviewReportService.loadReviewerAccess),规则门在工具 execute 内同步
 * 执行、无 Reviewer Run/Step 上下文,故一期使用独立轻量表,不伪造 A4 语义。
 */

export const GENERATION_REVIEW_ENGINE_RULES_V1 = "rules_v1" as const;

export type GenerationReviewVerdict = "pass" | "attention";

export interface GenerationReviewCheck {
  readonly rule: string;
  readonly status: "pass" | "fail";
  readonly summary: string;
  readonly expected?: string | number | null;
  readonly actual?: string | number | null;
}

export interface GenerationReviewSubject {
  readonly mediaAssetId: string;
  readonly assetId: number | null;
  readonly assetVersionId: number | null;
}

export interface GenerationReviewEvaluation {
  readonly verdict: GenerationReviewVerdict;
  readonly checks: readonly GenerationReviewCheck[];
}

// ─── 评审输入(请求事实 + 持久化事实) ────────────────────────────────────────

export interface ImageReviewAssetFacts {
  readonly mediaAssetId: string;
  readonly assetId: number;
  readonly assetVersionId: number;
  /** 事务内回读的 o_media_asset 行;null = 资产缺失。 */
  readonly mediaAssetRow: { readonly id: string; readonly url: string | null } | null;
  /** 事务内回读的 o_assets 行;null = 资产缺失。 */
  readonly assetRow: { readonly id: number; readonly imageId: number | null } | null;
  /** 事务内回读的 o_image(asset version)行;null = 资产缺失。 */
  readonly assetVersionRow: {
    readonly id: number;
    readonly assetsId: number | null;
    readonly resolution: string | null;
    readonly state: string | null;
  } | null;
}

export interface ImageGenerationReviewInput {
  readonly generationType: "image";
  readonly request: {
    readonly prompt: string;
    readonly model: string;
    readonly size: string;
    readonly units: number;
  };
  readonly assets: readonly ImageReviewAssetFacts[];
}

export interface VideoGenerationReviewInput {
  readonly generationType: "video";
  readonly request: {
    readonly prompt: string;
    readonly model: string;
    readonly duration: number;
    readonly resolution: string;
  };
  readonly task: {
    readonly taskId: string | null;
    readonly status: string | null;
    /** 实际提交给上游的时长(秒);null = 任务创建失败/未提交。 */
    readonly submittedDuration: number | null;
  };
}

export type GenerationReviewInput = ImageGenerationReviewInput | VideoGenerationReviewInput;

/**
 * 质量评估器接口(二期模型版留口)。实现必须纯函数式:输入即全部事实,不
 * 允许自行读写数据库或调用外部服务;持久化由 GenerationReviewService 负责。
 */
export interface GenerationReviewEvaluator {
  readonly engine: string;
  evaluate(input: GenerationReviewInput): GenerationReviewEvaluation;
}

// ─── 一期规则版评估器 ────────────────────────────────────────────────────────

function pass(rule: string, summary: string): GenerationReviewCheck {
  return { rule, status: "pass", summary };
}

function fail(
  rule: string,
  summary: string,
  expected?: string | number | null,
  actual?: string | number | null,
): GenerationReviewCheck {
  return { rule, status: "fail", summary, expected: expected ?? null, actual: actual ?? null };
}

/** 解析 "WxH" 尺寸;无法解析返回 null(由调用方按失败处理)。 */
export function parseImageSize(value: string | null | undefined): { width: number; height: number } | null {
  const match = String(value || "").trim().match(/^(\d{1,5})x(\d{1,5})$/);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

function evaluateImage(input: ImageGenerationReviewInput): GenerationReviewEvaluation {
  const checks: GenerationReviewCheck[] = [];
  const prompt = input.request.prompt.trim();
  checks.push(prompt.length > 0
    ? pass("prompt_non_empty", "提示词非空")
    : fail("prompt_non_empty", "提示词为空"));

  if (input.assets.length === input.request.units && input.assets.length >= 1) {
    checks.push(pass("asset_count", `入库资产数量 ${input.assets.length} 与请求 ${input.request.units} 一致`));
  } else {
    checks.push(fail(
      "asset_count",
      `入库资产数量 ${input.assets.length} 与请求 ${input.request.units} 不一致`,
      input.request.units,
      input.assets.length,
    ));
  }

  const expectedSize = parseImageSize(input.request.size);
  for (const [index, asset] of input.assets.entries()) {
    const label = `资产#${index + 1}(${asset.mediaAssetId})`;
    const rowsPresent = asset.mediaAssetRow !== null && asset.assetRow !== null && asset.assetVersionRow !== null;
    checks.push(rowsPresent
      ? pass("asset_rows_present", `${label} 三表记录(o_media_asset/o_assets/o_image)均存在`)
      : fail(
          "asset_rows_present",
          `${label} 存在缺失记录:`
            + ` o_media_asset=${asset.mediaAssetRow ? "有" : "缺"}`
            + ` o_assets=${asset.assetRow ? "有" : "缺"}`
            + ` o_image=${asset.assetVersionRow ? "有" : "缺"}`,
          "三表记录齐全",
          `o_media_asset=${asset.mediaAssetRow ? "有" : "缺"}`
            + `,o_assets=${asset.assetRow ? "有" : "缺"}`
            + `,o_image=${asset.assetVersionRow ? "有" : "缺"}`,
        ));

    if (asset.assetRow && asset.assetVersionRow) {
      const linked = Number(asset.assetRow.imageId) === Number(asset.assetVersionRow.id)
        && Number(asset.assetVersionRow.assetsId) === Number(asset.assetRow.id);
      checks.push(linked
        ? pass("asset_linkage", `${label} o_assets.imageId 与 o_image.assetsId 双向关联正确`)
        : fail(
            "asset_linkage",
            `${label} 资产关联损坏`,
            `o_assets.imageId=${asset.assetVersionRow.id},o_image.assetsId=${asset.assetRow.id}`,
            `o_assets.imageId=${String(asset.assetRow.imageId)},o_image.assetsId=${String(asset.assetVersionRow.assetsId)}`,
          ));
    }

    if (asset.assetVersionRow) {
      const actualSize = parseImageSize(asset.assetVersionRow.resolution);
      const sizeMatches = expectedSize !== null && actualSize !== null
        && actualSize.width === expectedSize.width && actualSize.height === expectedSize.height;
      checks.push(sizeMatches
        ? pass("size_matches_request", `${label} 尺寸 ${asset.assetVersionRow.resolution} 与请求 ${input.request.size} 一致`)
        : fail(
            "size_matches_request",
            `${label} 尺寸与请求不一致`,
            input.request.size,
            asset.assetVersionRow.resolution ?? null,
          ));
    }
  }
  return {
    verdict: checks.every((check) => check.status === "pass") ? "pass" : "attention",
    checks,
  };
}

function evaluateVideo(input: VideoGenerationReviewInput): GenerationReviewEvaluation {
  const checks: GenerationReviewCheck[] = [];
  const prompt = input.request.prompt.trim();
  checks.push(prompt.length > 0
    ? pass("prompt_non_empty", "提示词非空")
    : fail("prompt_non_empty", "提示词为空"));

  const taskCreated = Boolean(input.task.taskId && String(input.task.taskId).trim())
    && Boolean(input.task.status && String(input.task.status).trim());
  checks.push(taskCreated
    ? pass("task_created", `异步任务 ${input.task.taskId} 已创建(status=${input.task.status})`)
    : fail("task_created", "异步生成任务未创建", "taskId/status 非空",
        `taskId=${String(input.task.taskId)},status=${String(input.task.status)}`));

  const durationMatches = input.task.submittedDuration !== null
    && Number.isFinite(input.task.submittedDuration)
    && input.task.submittedDuration === input.request.duration;
  checks.push(durationMatches
    ? pass("duration_matches_request", `提交时长 ${input.task.submittedDuration}s 与请求 ${input.request.duration}s 一致`)
    : fail(
        "duration_matches_request",
        "提交时长与请求不一致",
        input.request.duration,
        input.task.submittedDuration ?? null,
      ));
  // 一期边界:成片时长/分辨率的资产级校验发生在 relay 终态回写之后,需挂
  // storeOrUpdateFinalVideoAsset 钩子,列二期(见 REVAMP-PLAN 2.3 遗留)。
  return {
    verdict: checks.every((check) => check.status === "pass") ? "pass" : "attention",
    checks,
  };
}

/** 一期规则版评估器:不查库、不烧模型,输入事实即全部依据。 */
export class RulesGenerationReviewEvaluator implements GenerationReviewEvaluator {
  readonly engine = GENERATION_REVIEW_ENGINE_RULES_V1;

  evaluate(input: GenerationReviewInput): GenerationReviewEvaluation {
    return input.generationType === "image" ? evaluateImage(input) : evaluateVideo(input);
  }
}

// ─── 持久化服务 ──────────────────────────────────────────────────────────────

export interface StoredGenerationReview {
  readonly id: string;
  readonly engine: string;
  readonly verdict: GenerationReviewVerdict;
  readonly checks: readonly GenerationReviewCheck[];
  readonly subjects: readonly GenerationReviewSubject[];
  readonly needsHumanAttention: boolean;
  readonly createdAt: number;
}

export interface RecordGenerationReviewInput {
  readonly workspaceId: string;
  readonly projectId: number;
  readonly runId: string;
  readonly stepId: string;
  readonly toolId: string;
  readonly quoteId: string | null;
  readonly review: GenerationReviewInput;
}

export interface GenerationReviewServiceOptions {
  readonly clock?: () => number;
  readonly idFactory?: () => string;
  readonly evaluator?: GenerationReviewEvaluator;
}

interface RawGenerationReviewRow {
  id: string;
  engine: string;
  verdict: string;
  checksJson: unknown;
  subjectJson: unknown;
  needsHumanAttention: number | string;
  createdAt: number | string;
}

function parseJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function mapStored(row: RawGenerationReviewRow): StoredGenerationReview {
  return Object.freeze({
    id: String(row.id),
    engine: String(row.engine),
    verdict: String(row.verdict) === "attention" ? "attention" : "pass",
    checks: Object.freeze(parseJsonArray(row.checksJson) as GenerationReviewCheck[]),
    subjects: Object.freeze(parseJsonArray(row.subjectJson) as GenerationReviewSubject[]),
    needsHumanAttention: Number(row.needsHumanAttention) === 1,
    createdAt: Number(row.createdAt),
  });
}

export class GenerationReviewService {
  private readonly clock: () => number;
  private readonly idFactory: () => string;
  private readonly evaluator: GenerationReviewEvaluator;

  constructor(
    private readonly database: Knex,
    options: GenerationReviewServiceOptions = {},
  ) {
    this.clock = options.clock ?? Date.now;
    this.idFactory = options.idFactory ?? (() => `greview_${randomUUID()}`);
    this.evaluator = options.evaluator ?? new RulesGenerationReviewEvaluator();
  }

  /**
   * 评审并持久化。幂等:(runId, stepId, engine) 唯一约束下重放返回已存记录,
   * 不产生第二行。二期模型版通过 options.evaluator 注入,落表 engine 不同。
   */
  async reviewAndRecord(
    input: RecordGenerationReviewInput,
    trx?: Knex.Transaction,
  ): Promise<StoredGenerationReview> {
    const evaluation = this.evaluator.evaluate(input.review);
    const subjects: readonly GenerationReviewSubject[] = input.review.generationType === "image"
      ? input.review.assets.map((asset) => ({
          mediaAssetId: asset.mediaAssetId,
          assetId: asset.assetId,
          assetVersionId: asset.assetVersionId,
        }))
      : Object.freeze([]);
    const client = trx ?? this.database;
    const replayKey = {
      runId: input.runId,
      stepId: input.stepId,
      engine: this.evaluator.engine,
    };
    const existing = await client(AGENT_GENERATION_REVIEW_TABLE).where(replayKey).first();
    if (existing) return mapStored(existing as RawGenerationReviewRow);

    const createdAt = this.clock();
    await client(AGENT_GENERATION_REVIEW_TABLE)
      .insert({
        id: this.idFactory(),
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        runId: input.runId,
        stepId: input.stepId,
        toolId: input.toolId,
        generationType: input.review.generationType,
        quoteId: input.quoteId,
        engine: this.evaluator.engine,
        verdict: evaluation.verdict,
        checksJson: JSON.stringify(evaluation.checks),
        subjectJson: JSON.stringify(subjects),
        needsHumanAttention: evaluation.verdict === "attention" ? 1 : 0,
        createdAt,
      })
      .onConflict(["runId", "stepId", "engine"])
      .ignore();
    const stored = await client(AGENT_GENERATION_REVIEW_TABLE).where(replayKey).first();
    if (!stored) {
      throw new Error("生成质量评审记录保存后无法读取");
    }
    return mapStored(stored as RawGenerationReviewRow);
  }
}

export interface GenerationReviewLogger {
  warn(message: string, metadata?: Record<string, unknown>): void;
}

const defaultReviewLogger: GenerationReviewLogger = {
  warn(message, metadata) {
    console.warn(message, metadata ?? "");
  },
};

/**
 * 工具 execute 内的安全入口:质量门自身的任何异常只记日志、绝不让已成功的
 * 生成执行变失败。attention 结论经结构化日志外发,与表记录同事实。
 */
export async function runGenerationReviewGateSafely(input: {
  service: GenerationReviewService;
  review: RecordGenerationReviewInput;
  trx?: Knex.Transaction;
  logger?: GenerationReviewLogger;
}): Promise<StoredGenerationReview | null> {
  const logger = input.logger ?? defaultReviewLogger;
  try {
    const stored = await input.service.reviewAndRecord(input.review, input.trx);
    if (stored.verdict === "attention") {
      logger.warn("[agent-review-gate] generation review requires human attention", {
        reviewId: stored.id,
        runId: input.review.runId,
        stepId: input.review.stepId,
        toolId: input.review.toolId,
        failedRules: stored.checks.filter((check) => check.status === "fail").map((check) => check.rule),
      });
    }
    return stored;
  } catch (error) {
    logger.warn("[agent-review-gate] generation review gate failed", {
      runId: input.review.runId,
      stepId: input.review.stepId,
      toolId: input.review.toolId,
      errorName: error instanceof Error && error.name ? error.name : "UnknownError",
    });
    return null;
  }
}
