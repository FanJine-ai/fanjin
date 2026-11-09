import { internalModelId } from "@/lib/minimaxH3PublicIdentity";
import crypto from "node:crypto";
import type { Knex } from "knex";

import {
  calculatePricingCost,
  resolveProviderSpecificPricingRule,
  type PricingRule,
} from "@/lib/billing";
import { readVideoTokenReservationUpperBound } from "@/lib/productionPricing";
import {
  resolveTimePricing,
  type TimePricingSnapshot,
} from "@/lib/timePricing";
import { calculateMaximumVideoInputCost } from "@/lib/videoInputPricing";
import {
  buildWorkbenchModelCatalog,
  type WorkbenchModelCatalogDatabase,
  type WorkbenchModelCapability,
} from "@/lib/workbenchModelCatalog";
import { db } from "@/utils/db";

export const CANVAS_CHAIN_GU_BUDGET_VERSION =
  "canvas-chain-gu-budget/v1";

type BudgetDatabase = WorkbenchModelCatalogDatabase;
type DatabaseRow = Record<string, unknown>;

export class CanvasChainGuBudgetError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 409) {
    super(message);
    this.name = "CanvasChainGuBudgetError";
    this.code = code;
    this.status = status;
  }
}

export type CanvasChainGuBudgetInput = {
  workspaceId: string;
  imageModel: string;
  imageQuality: string;
  videoModel: string;
  videoResolution: "720p" | "1080p";
  videoDuration: number;
  videoMode: "image_to_video";
  generateAudio: false;
};

export type CanvasChainGuBudgetExposure = {
  version: typeof CANVAS_CHAIN_GU_BUDGET_VERSION;
  videoResolution: CanvasChainGuBudgetInput["videoResolution"];
  imageMaximumCostMicros: number;
  videoMaximumCostMicros: number;
  totalMaximumCostMicros: number;
  imageCalls: 1;
  videoCalls: 1;
  pricingDigest: string;
};

type AuthorizedRouteChannel = {
  provider: string;
  route: DatabaseRow;
  channel: DatabaseRow;
};

type AuthorizedPricing = AuthorizedRouteChannel & {
  rule: PricingRule;
  reservationUnits: number;
  maximumCostMicros: number;
  timePricing: TimePricingSnapshot;
};

function fail(code: string, message: string, status = 409): never {
  throw new CanvasChainGuBudgetError(code, message, status);
}

function stringValue(value: unknown): string {
  return typeof value === "string"
    ? value.trim()
    : value == null
      ? ""
      : String(value).trim();
}

function isDisabled(value: unknown): boolean {
  return value === true || Number(value) === 1;
}

function isWorkspaceRow(row: DatabaseRow, workspaceId: string): boolean {
  return (
    stringValue(row.scope) === "workspace"
    && stringValue(row.workspaceId) === workspaceId
  );
}

function compareRows(
  left: DatabaseRow,
  right: DatabaseRow,
  workspaceId: string,
): number {
  const scopeDelta =
    Number(isWorkspaceRow(right, workspaceId))
    - Number(isWorkspaceRow(left, workspaceId));
  if (scopeDelta) return scopeDelta;
  const priorityDelta =
    Number(left.priority || 0) - Number(right.priority || 0);
  if (priorityDelta) return priorityDelta;
  const fallbackDelta =
    Number(left.fallbackOrder || 0) - Number(right.fallbackOrder || 0);
  if (fallbackDelta) return fallbackDelta;
  const createDelta =
    Number(left.createTime || 0) - Number(right.createTime || 0);
  if (createDelta) return createDelta;
  return stringValue(left.id).localeCompare(stringValue(right.id));
}

function preferredRouteScope(
  rows: DatabaseRow[],
  workspaceId: string,
): DatabaseRow[] {
  const workspaceRows = rows.filter((row) =>
    isWorkspaceRow(row, workspaceId),
  );
  if (workspaceRows.length) return workspaceRows;
  return rows.filter((row) => (
    stringValue(row.scope) === "platform"
    && !stringValue(row.workspaceId)
  ));
}

function routeCanUseChannel(
  route: DatabaseRow,
  channel: DatabaseRow,
  workspaceId: string,
): boolean {
  const channelScope = stringValue(channel.scope);
  const channelWorkspaceId = stringValue(channel.workspaceId);
  if (stringValue(route.scope) === "platform") {
    return channelScope === "platform" && !channelWorkspaceId;
  }
  return (
    (channelScope === "platform" && !channelWorkspaceId)
    || (
      channelScope === "workspace"
      && channelWorkspaceId === workspaceId
    )
  );
}

async function authorizedRouteChannels(input: {
  database: BudgetDatabase;
  workspaceId: string;
  endpointType: "image_generation" | "video_generation";
  model: string;
}): Promise<AuthorizedRouteChannel[]> {
  const [routeRows, channelRows] = await Promise.all([
    input.database("o_model_route")
      .where({ endpointType: input.endpointType, model: input.model })
      .where((builder: Knex.QueryBuilder) => {
        builder
          .where((platform: Knex.QueryBuilder) =>
            platform.where({ scope: "platform" }).whereNull("workspaceId"),
          )
          .orWhere({
            scope: "workspace",
            workspaceId: input.workspaceId,
          });
      }),
    input.database("o_provider_channel")
      .where({ endpointType: input.endpointType })
      .where((builder: Knex.QueryBuilder) => {
        builder
          .where((platform: Knex.QueryBuilder) =>
            platform.where({ scope: "platform" }).whereNull("workspaceId"),
          )
          .orWhere({
            scope: "workspace",
            workspaceId: input.workspaceId,
          });
      }),
  ]);
  const preferred = preferredRouteScope(
    [...routeRows].sort((left, right) =>
      compareRows(left, right, input.workspaceId),
    ),
    input.workspaceId,
  );
  if (!preferred.length) {
    fail(
      "CANVAS_CHAIN_GU_ROUTE_MISSING",
      "当前模型没有可验证的服务端路由",
    );
  }
  const enabledRoutes = preferred.filter((row) => !isDisabled(row.disabled));
  if (!enabledRoutes.length) {
    fail(
      "CANVAS_CHAIN_GU_ROUTE_DISABLED",
      "当前工作区的模型路由已显式禁用",
    );
  }
  const enabledChannels = [...channelRows]
    .filter((row) => !isDisabled(row.disabled))
    .sort((left, right) => compareRows(left, right, input.workspaceId));
  const authorized: AuthorizedRouteChannel[] = [];
  for (const route of enabledRoutes) {
    const routeId = stringValue(route.id);
    const routeChannelId = stringValue(route.channelId);
    const routeProvider = stringValue(route.provider);
    const matches = enabledChannels.filter((channel) => {
      if (!routeCanUseChannel(route, channel, input.workspaceId)) return false;
      if (routeChannelId && stringValue(channel.id) !== routeChannelId) {
        return false;
      }
      const channelProvider = stringValue(channel.provider);
      if (!channelProvider) return false;
      if (routeProvider && channelProvider !== routeProvider) return false;
      return Boolean(routeChannelId || routeProvider);
    });
    if (!matches.length) {
      fail(
        "CANVAS_CHAIN_GU_CHANNEL_MISSING",
        `模型路由 ${routeId || "(unknown)"} 缺少可验证的供应商通道`,
      );
    }
    for (const channel of matches) {
      authorized.push({
        provider: stringValue(channel.provider),
        route,
        channel,
      });
    }
  }
  if (!authorized.length) {
    fail(
      "CANVAS_CHAIN_GU_CHANNEL_MISSING",
      "当前模型没有可验证的服务端供应商通道",
    );
  }
  return authorized;
}

function validateRule(
  rule: PricingRule | null,
  input: {
    endpointType: "image_generation" | "video_generation";
    provider: string;
    model: string;
  },
): asserts rule is PricingRule {
  if (!rule) {
    fail(
      "CANVAS_CHAIN_GU_PRICING_MISSING",
      "当前供应商与模型缺少服务端 GU 定价",
      402,
    );
  }
  const allowedUnits = input.endpointType === "image_generation"
    ? ["image"]
    : ["task", "video", "token"];
  const multiplier = Number(rule.ruleConfig?.multiplier ?? 1);
  const minimumMicros = Number(rule.ruleConfig?.minimumMicros ?? 0);
  if (
    rule.endpointType !== input.endpointType
    || rule.provider !== input.provider
    || (rule.model != null && rule.model !== input.model)
    || rule.currency !== "GU"
    || !allowedUnits.includes(rule.unit)
    || !Number.isSafeInteger(rule.unitPriceMicros)
    || rule.unitPriceMicros <= 0
    || !Number.isFinite(multiplier)
    || multiplier <= 0
    || !Number.isSafeInteger(minimumMicros)
    || minimumMicros < 0
  ) {
    fail(
      "CANVAS_CHAIN_GU_PRICING_INVALID",
      "服务端 GU 定价与模型路由不匹配",
    );
  }
}

async function authorizedPricing(input: {
  database: BudgetDatabase;
  workspaceId: string;
  endpointType: "image_generation" | "video_generation";
  model: string;
  pricingEvaluatedAt: number;
}): Promise<AuthorizedPricing[]> {
  const authorized = await authorizedRouteChannels(input);
  const ruleByProvider = new Map<string, PricingRule>();
  const result: AuthorizedPricing[] = [];
  for (const entry of authorized) {
    let rule = ruleByProvider.get(entry.provider);
    if (!rule) {
      const resolved = await resolveProviderSpecificPricingRule({
        workspaceId: input.workspaceId,
        endpointType: input.endpointType,
        provider: entry.provider,
        model: input.model,
      }, input.database);
      validateRule(resolved, {
        endpointType: input.endpointType,
        provider: entry.provider,
        model: input.model,
      });
      rule = resolved;
      ruleByProvider.set(entry.provider, rule);
    }
    let reservationUnits = 1;
    if (input.endpointType === "video_generation" && rule.unit === "token") {
      if (entry.provider !== "volcano") {
        fail(
          "CANVAS_CHAIN_GU_VIDEO_TOKEN_PROVIDER_INVALID",
          "视频 token 定价仅允许具备权威结算 token 的供应商",
        );
      }
      reservationUnits =
        readVideoTokenReservationUpperBound(rule.ruleConfig) || 0;
      if (!reservationUnits) {
        fail(
          "CANVAS_CHAIN_GU_VIDEO_UPPER_BOUND_MISSING",
          "视频 token 定价缺少服务端 reservationUpperBoundTokens",
        );
      }
    }
    let maximumCostMicros: number;
    const timePricing = resolveTimePricing(
      rule.ruleConfig,
      input.pricingEvaluatedAt,
    );
    try {
      maximumCostMicros = input.endpointType === "video_generation"
        ? calculateMaximumVideoInputCost({
            ruleConfig: rule.ruleConfig,
            baseUnitPriceMicros: rule.unitPriceMicros,
            units: reservationUnits,
            timePricingMultiplier: timePricing.multiplier,
          })
        : calculatePricingCost(
            rule,
            reservationUnits,
            undefined,
            undefined,
            input.pricingEvaluatedAt,
          );
    } catch {
      fail(
        "CANVAS_CHAIN_GU_PRICING_INVALID",
        "视频输入分档定价无法形成安全的最大 GU 暴露",
      );
    }
    if (
      !Number.isSafeInteger(maximumCostMicros)
      || maximumCostMicros <= 0
    ) {
      fail(
        "CANVAS_CHAIN_GU_EXPOSURE_INVALID",
        "服务端无法计算正安全整数的最大 GU 暴露",
      );
    }
    result.push({
      ...entry,
      rule,
      reservationUnits,
      maximumCostMicros,
      timePricing,
    });
  }
  return result;
}

function durationSupported(
  capability: WorkbenchModelCapability,
  duration: number,
): boolean {
  const contract = capability.duration;
  if (!contract || !Number.isFinite(duration) || duration <= 0) return false;
  if (contract.allowed?.length) return contract.allowed.includes(duration);
  if (
    duration < contract.min
    || duration > contract.max
    || contract.step <= 0
  ) {
    return false;
  }
  const steps = (duration - contract.min) / contract.step;
  return Math.abs(steps - Math.round(steps)) < 1e-9;
}

function hasFirstFrameSlot(capability: WorkbenchModelCapability): boolean {
  return (capability.inputSlots || []).some((slot) => {
    const id = stringValue(slot.id);
    const roles = Array.isArray(slot.roles)
      ? slot.roles.map(stringValue)
      : [];
    const modes = Array.isArray(slot.modes)
      ? slot.modes.map(stringValue)
      : [];
    return (
      (id === "first_frame" || roles.includes("first_frame"))
      && (!modes.length || modes.includes("image_to_video"))
    );
  });
}

function maximum(entries: AuthorizedPricing[]): number {
  const values = entries.map((entry) => entry.maximumCostMicros);
  if (!values.length) {
    fail(
      "CANVAS_CHAIN_GU_EXPOSURE_INVALID",
      "服务端无法计算最大 GU 暴露",
    );
  }
  return Math.max(...values);
}

function digestFacts(entries: AuthorizedPricing[]) {
  return entries
    .map((entry) => ({
      provider: entry.provider,
      route: {
        id: stringValue(entry.route.id),
        scope: stringValue(entry.route.scope),
        workspaceId: stringValue(entry.route.workspaceId),
        provider: stringValue(entry.route.provider),
        model: stringValue(entry.route.model),
        endpointType: stringValue(entry.route.endpointType),
        priority: stringValue(entry.route.priority),
        fallbackOrder: stringValue(entry.route.fallbackOrder),
        disabled: stringValue(entry.route.disabled),
        createTime: stringValue(entry.route.createTime),
        updateTime: stringValue(entry.route.updateTime),
        version: stringValue(entry.route.version),
        revision: stringValue(entry.route.revision),
      },
      channel: {
        id: stringValue(entry.channel.id),
        scope: stringValue(entry.channel.scope),
        workspaceId: stringValue(entry.channel.workspaceId),
        provider: stringValue(entry.channel.provider),
        model: stringValue(entry.channel.model),
        endpointType: stringValue(entry.channel.endpointType),
        priority: stringValue(entry.channel.priority),
        fallbackOrder: stringValue(entry.channel.fallbackOrder),
        disabled: stringValue(entry.channel.disabled),
        createTime: stringValue(entry.channel.createTime),
        updateTime: stringValue(entry.channel.updateTime),
        version: stringValue(entry.channel.version),
        revision: stringValue(entry.channel.revision),
      },
      pricing: {
        id: entry.rule.id,
        scope: entry.rule.scope,
        workspaceId: entry.rule.workspaceId || "",
        provider: entry.rule.provider || "",
        model: entry.rule.model || "",
        endpointType: entry.rule.endpointType,
        disabled: stringValue(entry.rule.disabled),
        createTime: stringValue(entry.rule.createTime),
        updateTime: stringValue(entry.rule.updateTime),
        version: stringValue(
          (entry.rule as PricingRule & { version?: unknown }).version,
        ),
        revision: stringValue(
          (entry.rule as PricingRule & { revision?: unknown }).revision,
        ),
        unit: entry.rule.unit,
        unitPriceMicros: entry.rule.unitPriceMicros,
        multiplier: Number(entry.rule.ruleConfig?.multiplier ?? 1),
        minimumMicros: Number(entry.rule.ruleConfig?.minimumMicros ?? 0),
        reservationUpperBoundTokens:
          entry.rule.unit === "token" ? entry.reservationUnits : null,
        maximumCostMicros: entry.maximumCostMicros,
        timePricing: stableTimePricingSnapshot(entry.timePricing),
      },
    }))
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
}

function stableTimePricingSnapshot(
  snapshot: TimePricingSnapshot,
): Omit<TimePricingSnapshot, "evaluatedAt"> {
  const { evaluatedAt: _evaluatedAt, ...stable } = snapshot;
  return stable;
}

export async function resolveCanvasChainGuBudgetExposure(
  input: CanvasChainGuBudgetInput,
  database: BudgetDatabase = db,
): Promise<CanvasChainGuBudgetExposure> {
  const workspaceId = stringValue(input.workspaceId);
  if (!workspaceId) {
    fail(
      "CANVAS_CHAIN_GU_WORKSPACE_REQUIRED",
      "GU 预算计算缺少工作区",
      400,
    );
  }
  // One quote is one pricing decision. Capture before any asynchronous model,
  // route or rule reads so a minute boundary cannot split the consent budget.
  const pricingEvaluatedAt = Date.now();
  const catalog = await buildWorkbenchModelCatalog(workspaceId, database);
  const imageCapability = catalog.imageModels.find((model) => (
    model.id === input.imageModel && model.canSubmit
  ));
  if (
    !imageCapability
    || !imageCapability.aspectRatios.includes("16:9")
    || !imageCapability.qualities?.includes(input.imageQuality)
  ) {
    fail(
      "CANVAS_CHAIN_GU_IMAGE_MODEL_UNAVAILABLE",
      "图片模型或质量不满足 Canvas 可提交能力",
    );
  }
  const videoCapability = catalog.videoModels.find((model) => (
    model.id === internalModelId(input.videoModel) && model.canSubmit
  ));
  if (
    !videoCapability
    || !videoCapability.resolutions?.some(
      (resolution) => resolution.toLowerCase() === input.videoResolution,
    )
    || !videoCapability.modes?.includes(input.videoMode)
    || !hasFirstFrameSlot(videoCapability)
    || !durationSupported(videoCapability, input.videoDuration)
    || input.generateAudio !== false
  ) {
    fail(
      "CANVAS_CHAIN_GU_VIDEO_MODEL_UNAVAILABLE",
      "视频模型不满足所选分辨率的最短图生视频能力",
    );
  }

  const [imagePricing, videoPricing] = await Promise.all([
    authorizedPricing({
      database,
      workspaceId,
      endpointType: "image_generation",
      model: input.imageModel,
      pricingEvaluatedAt,
    }),
    authorizedPricing({
      database,
      workspaceId,
      endpointType: "video_generation",
      model: input.videoModel,
      pricingEvaluatedAt,
    }),
  ]);
  const imageMaximumCostMicros = maximum(imagePricing);
  const videoMaximumCostMicros = maximum(videoPricing);
  const totalMaximumCostMicros =
    imageMaximumCostMicros + videoMaximumCostMicros;
  if (
    !Number.isSafeInteger(totalMaximumCostMicros)
    || totalMaximumCostMicros <= 0
  ) {
    fail(
      "CANVAS_CHAIN_GU_EXPOSURE_INVALID",
      "服务端最大 GU 暴露超出安全整数范围",
    );
  }
  const facts = {
    workspaceId,
    request: {
      imageModel: input.imageModel,
      imageQuality: input.imageQuality,
      imageCalls: 1,
      videoModel: input.videoModel,
      videoResolution: input.videoResolution,
      videoDuration: input.videoDuration,
      videoMode: input.videoMode,
      generateAudio: input.generateAudio,
      videoCalls: 1,
    },
    imagePricing: digestFacts(imagePricing),
    videoPricing: digestFacts(videoPricing),
    totalMaximumCostMicros,
  };
  return {
    version: CANVAS_CHAIN_GU_BUDGET_VERSION,
    videoResolution: input.videoResolution,
    imageMaximumCostMicros,
    videoMaximumCostMicros,
    totalMaximumCostMicros,
    imageCalls: 1,
    videoCalls: 1,
    pricingDigest: crypto.createHash("sha256")
      .update(JSON.stringify(facts))
      .digest("hex"),
  };
}
