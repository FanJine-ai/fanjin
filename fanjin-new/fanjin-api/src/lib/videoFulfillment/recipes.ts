import { Knex } from "knex";
import { isFanjinValueVideoModel, fanjinValueVideoResolutionPair } from "@/lib/fanjinValueVideoOffers";
import { v4 as uuid } from "uuid";
import {
  isPublicVideoResolution,
  normalizeVideoResolution,
  recipeResolutionsValid,
  type PublicVideoResolution,
} from "@/lib/videoResolutions";
import {
  VIDEO_FULFILLMENT_RECIPE_TABLE,
  VIDEO_PUBLIC_OFFER_TABLE,
} from "@/lib/migrations/videoFulfillmentRecipe";

export interface VideoFulfillmentRecipe {
  id: string;
  publicModel: string;
  targetResolution: PublicVideoResolution;
  name: string;
  generateChannelId: string;
  generateResolution: string;
  upstreamModel: string | null;
  enhanceEnabled: boolean;
  enhanceChannelId: string | null;
  weight: number;
  priority: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface VideoPublicOffer {
  id: string;
  publicModel: string;
  displayName: string;
  visibleResolutions: PublicVideoResolution[];
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface FulfillmentPlan {
  publicModel: string;
  requestedResolution: PublicVideoResolution;
  generationResolution: string;
  finalResolution: PublicVideoResolution;
  needsEnhancement: boolean;
  recipeId: string | null;
  generateChannelId: string | null;
  enhanceChannelId: string | null;
  upstreamModel: string | null;
  pipeline: "direct_generation" | "generate_then_enhance" | "legacy_fallback";
}

function now(): number {
  return Date.now();
}

function parseResolutions(raw: unknown): PublicVideoResolution[] {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw || "[]");
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => normalizeVideoResolution(item))
    .filter((item): item is PublicVideoResolution => Boolean(item && isPublicVideoResolution(item)));
}

function mapRecipe(row: any): VideoFulfillmentRecipe {
  return {
    id: String(row.id),
    publicModel: String(row.publicModel),
    targetResolution: normalizeVideoResolution(row.targetResolution) as PublicVideoResolution,
    name: String(row.name || ""),
    generateChannelId: String(row.generateChannelId),
    generateResolution: String(normalizeVideoResolution(row.generateResolution) || row.generateResolution),
    upstreamModel: row.upstreamModel == null ? null : String(row.upstreamModel),
    enhanceEnabled: Boolean(Number(row.enhanceEnabled || 0)),
    enhanceChannelId: row.enhanceChannelId == null || row.enhanceChannelId === "" ? null : String(row.enhanceChannelId),
    weight: Math.max(0, Number(row.weight || 0)),
    priority: Number(row.priority || 100),
    enabled: Boolean(Number(row.enabled || 0)),
    createdAt: Number(row.createdAt || 0),
    updatedAt: Number(row.updatedAt || 0),
  };
}

function mapOffer(row: any): VideoPublicOffer {
  return {
    id: String(row.id),
    publicModel: String(row.publicModel),
    displayName: String(row.displayName || row.publicModel),
    visibleResolutions: parseResolutions(row.visibleResolutions),
    enabled: Boolean(Number(row.enabled || 0)),
    createdAt: Number(row.createdAt || 0),
    updatedAt: Number(row.updatedAt || 0),
  };
}

export async function listVideoPublicOffers(knex: Knex): Promise<VideoPublicOffer[]> {
  if (!(await knex.schema.hasTable(VIDEO_PUBLIC_OFFER_TABLE))) return [];
  const rows = await knex(VIDEO_PUBLIC_OFFER_TABLE).orderBy("displayName", "asc");
  return rows.map(mapOffer);
}

export async function listRecipesForTarget(
  knex: Knex,
  input: { publicModel: string; targetResolution: string; onlyEnabled?: boolean },
): Promise<VideoFulfillmentRecipe[]> {
  if (!(await knex.schema.hasTable(VIDEO_FULFILLMENT_RECIPE_TABLE))) return [];
  const target = normalizeVideoResolution(input.targetResolution);
  if (!target || !isPublicVideoResolution(target)) return [];
  const query = knex(VIDEO_FULFILLMENT_RECIPE_TABLE)
    .where({ publicModel: String(input.publicModel || "").trim(), targetResolution: target })
    .orderBy("priority", "asc")
    .orderBy("weight", "desc")
    .orderBy("createdAt", "asc");
  if (input.onlyEnabled !== false) query.andWhere({ enabled: 1 });
  const rows = await query;
  return rows.map(mapRecipe).filter((recipe) =>
    recipeResolutionsValid({
      targetResolution: recipe.targetResolution,
      generateResolution: recipe.generateResolution,
      enhanceEnabled: recipe.enhanceEnabled,
    }),
  );
}

/** Weighted random among recipes with weight>0; zero-weight skipped; if all zero, use priority order first. */
export function pickWeightedRecipe<T extends { weight: number; priority: number; id: string }>(
  recipes: T[],
  random: () => number = Math.random,
): T | null {
  if (!recipes.length) return null;
  const positive = recipes.filter((item) => item.weight > 0);
  const pool = positive.length ? positive : [...recipes].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  if (!positive.length) return pool[0] || null;
  const total = pool.reduce((sum, item) => sum + item.weight, 0);
  if (total <= 0) return pool[0] || null;
  let cursor = random() * total;
  for (const item of pool) {
    cursor -= item.weight;
    if (cursor <= 0) return item;
  }
  return pool[pool.length - 1] || null;
}

/**
 * 路径 A failover 候选池排序(design §5.1):
 * priority 小的配方整体优先(严格分层,不用权重跨层插队);
 * 加权随机只发生在同一 priority 层内(无放回抽样,决定层内尝试次序)。
 * 零权重配方在同层内排在正权重之后,按 id 稳定兜底。
 */
export function orderFailoverCandidates<T extends { weight: number; priority: number; id: string }>(
  recipes: T[],
  random: () => number = Math.random,
): T[] {
  const byPriority = new Map<number, T[]>();
  for (const recipe of recipes) {
    const bucket = byPriority.get(recipe.priority) || [];
    bucket.push(recipe);
    byPriority.set(recipe.priority, bucket);
  }
  const ordered: T[] = [];
  const priorities = [...byPriority.keys()].sort((a, b) => a - b);
  for (const priority of priorities) {
    const remaining = [...(byPriority.get(priority) || [])].sort((a, b) => a.id.localeCompare(b.id));
    while (remaining.length) {
      const picked = pickWeightedRecipe(remaining, random);
      if (!picked) break;
      ordered.push(picked);
      remaining.splice(remaining.findIndex((item) => item.id === picked.id), 1);
    }
  }
  return ordered;
}

/**
 * 同 (publicModel, targetResolution) 的 enabled 配方,按 failover 次序排列。
 * excludeRecipeIds 用于跳过本任务已经尝试过的配方。
 */
export async function listFailoverCandidateRecipes(
  knex: Knex,
  input: {
    publicModel: string;
    targetResolution: string;
    excludeRecipeIds?: string[];
    onlyEnabled?: boolean;
  },
): Promise<VideoFulfillmentRecipe[]> {
  const recipes = await listRecipesForTarget(knex, {
    publicModel: input.publicModel,
    targetResolution: input.targetResolution,
    onlyEnabled: input.onlyEnabled !== false,
  });
  const excluded = new Set((input.excludeRecipeIds || []).map(String));
  return orderFailoverCandidates(recipes.filter((recipe) => !excluded.has(recipe.id)));
}

/**
 * 配方任务的首条尝试 = failover 候选池头部(priority 最小,同层加权)。
 * 与 resolveFulfillmentPlan 的区别:严格 priority 分层优先,权重只在同层生效。
 */
export async function resolveFailoverFulfillmentPlan(
  knex: Knex,
  input: { publicModel: string; resolution: unknown },
): Promise<FulfillmentPlan | null> {
  const target = normalizeVideoResolution(input.resolution);
  if (!target || !isPublicVideoResolution(target)) return null;
  const candidates = await listFailoverCandidateRecipes(knex, {
    publicModel: input.publicModel,
    targetResolution: target,
    onlyEnabled: true,
  });
  const first = candidates[0];
  return first ? planFromRecipe(input.publicModel, first) : null;
}

export function planFromRecipe(
  publicModel: string,
  recipe: VideoFulfillmentRecipe,
): FulfillmentPlan {
  return {
    publicModel,
    requestedResolution: recipe.targetResolution,
    generationResolution: recipe.generateResolution,
    finalResolution: recipe.targetResolution,
    needsEnhancement: recipe.enhanceEnabled,
    recipeId: recipe.id,
    generateChannelId: recipe.generateChannelId,
    enhanceChannelId: recipe.enhanceEnabled ? recipe.enhanceChannelId : null,
    upstreamModel: recipe.upstreamModel,
    pipeline: recipe.enhanceEnabled ? "generate_then_enhance" : "direct_generation",
  };
}

export async function resolveFulfillmentPlan(
  knex: Knex,
  input: { publicModel: string; resolution: unknown; excludeRecipeIds?: string[] },
): Promise<FulfillmentPlan | null> {
  const target = normalizeVideoResolution(input.resolution);
  if (!target || !isPublicVideoResolution(target)) return null;
  const recipes = await listRecipesForTarget(knex, {
    publicModel: input.publicModel,
    targetResolution: target,
    onlyEnabled: true,
  });
  const excluded = new Set((input.excludeRecipeIds || []).map(String));
  const candidates = recipes.filter((recipe) => !excluded.has(recipe.id));
  const picked = pickWeightedRecipe(candidates);
  if (!picked) return null;
  return planFromRecipe(input.publicModel, picked);
}

export async function upsertVideoPublicOffer(
  knex: Knex,
  input: {
    publicModel: string;
    displayName: string;
    visibleResolutions: string[];
    enabled?: boolean;
  },
): Promise<VideoPublicOffer> {
  const timestamp = now();
  const publicModel = String(input.publicModel || "").trim();
  if (!publicModel) throw new Error("PUBLIC_MODEL_REQUIRED");
  if (isFanjinValueVideoModel(publicModel) && input.visibleResolutions.some((value) => !fanjinValueVideoResolutionPair(value))) throw new Error("VALUE_VIDEO_ONLY_720P_1080P");
  const visibleResolutions = input.visibleResolutions
    .map((item) => normalizeVideoResolution(item))
    .filter((item): item is PublicVideoResolution => Boolean(item && isPublicVideoResolution(item)));
  const existing = await knex(VIDEO_PUBLIC_OFFER_TABLE).where({ publicModel }).first();
  if (existing) {
    await knex(VIDEO_PUBLIC_OFFER_TABLE).where({ id: existing.id }).update({
      displayName: String(input.displayName || publicModel).trim(),
      visibleResolutions: JSON.stringify(visibleResolutions),
      enabled: input.enabled === false ? 0 : 1,
      updatedAt: timestamp,
    });
    return mapOffer(await knex(VIDEO_PUBLIC_OFFER_TABLE).where({ id: existing.id }).first());
  }
  const id = uuid();
  await knex(VIDEO_PUBLIC_OFFER_TABLE).insert({
    id,
    publicModel,
    displayName: String(input.displayName || publicModel).trim(),
    visibleResolutions: JSON.stringify(visibleResolutions),
    enabled: input.enabled === false ? 0 : 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  return mapOffer(await knex(VIDEO_PUBLIC_OFFER_TABLE).where({ id }).first());
}

export async function createRecipe(
  knex: Knex,
  input: Omit<VideoFulfillmentRecipe, "id" | "createdAt" | "updatedAt" | "targetResolution"> & {
    targetResolution: string;
  },
): Promise<VideoFulfillmentRecipe> {
  const targetResolution = normalizeVideoResolution(input.targetResolution);
  const generateResolution = normalizeVideoResolution(input.generateResolution);
  if (
    !recipeResolutionsValid({
      targetResolution,
      generateResolution,
      enhanceEnabled: input.enhanceEnabled,
    })
  ) {
    throw new Error("RECIPE_RESOLUTION_INVALID");
  }
  if (input.enhanceEnabled && !input.enhanceChannelId) {
    throw new Error("ENHANCE_CHANNEL_REQUIRED");
  }
  const timestamp = now();
  const id = uuid();
  await knex(VIDEO_FULFILLMENT_RECIPE_TABLE).insert({
    id,
    publicModel: String(input.publicModel).trim(),
    targetResolution,
    name: String(input.name || "").trim(),
    generateChannelId: String(input.generateChannelId).trim(),
    generateResolution,
    upstreamModel: input.upstreamModel ? String(input.upstreamModel).trim() : null,
    enhanceEnabled: input.enhanceEnabled ? 1 : 0,
    enhanceChannelId: input.enhanceEnabled ? String(input.enhanceChannelId).trim() : null,
    weight: Math.max(0, Number(input.weight || 100)),
    priority: Number(input.priority || 100),
    enabled: input.enabled === false ? 0 : 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  return mapRecipe(await knex(VIDEO_FULFILLMENT_RECIPE_TABLE).where({ id }).first());
}

export const USER_VIDEO_ENHANCE_BILLING_SUBJECT = "video_enhance";
export const VIDEO_GENERATION_BILLING_SUBJECT = "video_generation";
