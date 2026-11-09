import { api, type AiModelCapabilities, type AiModelOption } from "@/lib/api";

/**
 * 画布模型目录接入层。
 *
 * 后端契约（Worker A）：
 *   GET /api/workbench/models/catalog?type=video|image|text|audio
 *   → [{ id, model, name, displayName, enhanceDisplayName, capabilities, isDefault }]
 *
 * 本模块职责：
 *   1. 按契约归一化目录条目（纯函数，可单测）；
 *   2. 从后端实时拉取目录（四个类型并发，单类型失败不影响其他类型）；
 *   3. 用户可见名展示规则：displayName 优先，超分/增强组合用 enhanceDisplayName。
 *
 * 目录为空或请求失败时不注入任何前端模型；调用方必须展示真实空态并阻止提交。
 */

export type ModelCatalogType = "video" | "image" | "text" | "audio";

export const MODEL_CATALOG_TYPES: readonly ModelCatalogType[] = ["video", "image", "text", "audio"];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function normalizeCatalogType(value: unknown): ModelCatalogType | "" {
  const normalized = String(value || "").trim().toLowerCase();
  if (["video", "videos", "video_generation", "video-generation"].includes(normalized)) return "video";
  if (["image", "images", "image_generation", "image-generation"].includes(normalized)) return "image";
  if (["text", "chat", "completion", "completions", "llm", "responses"].includes(normalized)) return "text";
  if (["audio", "tts", "speech", "transcription"].includes(normalized)) return "audio";
  return "";
}

/** 按 Worker A 契约归一化单条目录模型。 */
export function normalizeCatalogModel(value: unknown, fallbackType?: ModelCatalogType): AiModelOption | null {
  const raw = asRecord(value);
  const id = firstString(raw.id, raw.model, raw.modelId);
  const type = normalizeCatalogType(raw.type ?? raw.endpointType ?? raw.category) || fallbackType || "";
  if (!id || !type) return null;

  const capabilities = asRecord(raw.capabilities);
  const declaredStatus = firstString(raw.capabilityStatus, capabilities.status).toLowerCase();
  const explicitlyUnavailable = raw.available === false
    || raw.disabled === true
    || raw.canSubmit === false
    || capabilities.canSubmit === false
    || ["unavailable", "unverified", "disabled", "retired"].includes(declaredStatus);
  const normalizedCapabilities: AiModelCapabilities = {
    ...capabilities,
    ...(typeof capabilities.canSubmit === "boolean"
      ? {}
      : typeof raw.canSubmit === "boolean"
        ? { canSubmit: raw.canSubmit }
        : explicitlyUnavailable
          ? { canSubmit: false }
          : {}),
    ...(firstString(capabilities.status, declaredStatus)
      ? { status: firstString(capabilities.status, declaredStatus) }
      : explicitlyUnavailable
        ? { status: "unavailable" }
        : {}),
    ...(firstString(capabilities.unavailableReason, raw.unavailableReason, raw.reason)
      ? { unavailableReason: firstString(capabilities.unavailableReason, raw.unavailableReason, raw.reason) }
      : {}),
  };
  const hasCapabilities = Object.keys(normalizedCapabilities).length > 0;
  const displayName = firstString(raw.displayName);
  const enhanceDisplayName = firstString(raw.enhanceDisplayName);
  const rawPrice = raw.price ?? raw.points;
  const price = typeof rawPrice === "number" ? rawPrice : Number(rawPrice);

  return {
    id,
    name: firstString(raw.name, raw.label, displayName, id),
    type,
    // 后台目录即运营配置来源，默认视为已配置可用；后端显式给出状态则以后端为准
    capabilityStatus: declaredStatus || (explicitlyUnavailable ? "unavailable" : "configured"),
    ...(firstString(raw.platform, raw.provider, raw.vendor)
      ? { platform: firstString(raw.platform, raw.provider, raw.vendor) }
      : {}),
    ...(Number.isFinite(price) ? { price } : {}),
    ...(firstString(raw.description, raw.desc) ? { description: firstString(raw.description, raw.desc) } : {}),
    ...(displayName ? { displayName } : {}),
    ...(enhanceDisplayName ? { enhanceDisplayName } : {}),
    ...(raw.isDefault === true ? { isDefault: true } : {}),
    ...(firstString(raw.unavailableReason, raw.reason, capabilities.unavailableReason)
      ? { unavailableReason: firstString(raw.unavailableReason, raw.reason, capabilities.unavailableReason) }
      : {}),
    ...(hasCapabilities ? { capabilities: normalizedCapabilities } : {}),
  };
}

function extractCatalogList(response: unknown): unknown[] {
  if (Array.isArray(response)) return response;
  const body = asRecord(response);
  for (const key of ["models", "data", "items", "list", "catalog"] as const) {
    if (Array.isArray(body[key])) return body[key] as unknown[];
  }
  return [];
}

/** 归一化目录接口响应（兼容数组 / {models} / {data} / {items} / {list} 包装）。 */
export function normalizeCatalogModels(response: unknown, fallbackType?: ModelCatalogType): AiModelOption[] {
  const deduped = new Map<string, AiModelOption>();
  for (const value of extractCatalogList(response)) {
    const model = normalizeCatalogModel(value, fallbackType);
    if (!model) continue;
    const key = `${model.type}:${model.id}`;
    const previous = deduped.get(key);
    if (!previous) {
      deduped.set(key, model);
      continue;
    }
    deduped.set(key, {
      ...previous,
      ...model,
      displayName: model.displayName || previous.displayName,
      enhanceDisplayName: model.enhanceDisplayName || previous.enhanceDisplayName,
      isDefault: model.isDefault ?? previous.isDefault,
      capabilities:
        previous.capabilities || model.capabilities
          ? ({ ...(previous.capabilities || {}), ...(model.capabilities || {}) } as AiModelCapabilities)
          : undefined,
    });
  }
  return Array.from(deduped.values());
}

/** 用户可见名：后台映射名 displayName 优先，其次 name，最后 id。 */
export function getModelDisplayName(model: Pick<AiModelOption, "id" | "name"> & Partial<AiModelOption>): string {
  const displayName = String(model.displayName || "").trim();
  if (displayName) return displayName;
  const name = String(model.name || "").trim();
  if (name) return name;
  return String(model.id || "").trim();
}

/** 超分/增强组合可见名：enhanceDisplayName 优先，无则 displayName +「超分」后缀。 */
export function getModelEnhanceDisplayName(model: Pick<AiModelOption, "id" | "name"> & Partial<AiModelOption>): string {
  const enhanceDisplayName = String(model.enhanceDisplayName || "").trim();
  if (enhanceDisplayName) return enhanceDisplayName;
  const base = getModelDisplayName(model);
  return base ? `${base} 超分` : "超分";
}

/**
 * 仅接受目录明确返回的非负价格。缺失或非法值返回 null，避免把未知价格展示成免费。
 */
export function getCatalogModelPrice(model: { price?: unknown } | null | undefined): number | null {
  if (model?.price === null || model?.price === undefined || model.price === "") return null;
  const price = Number(model.price);
  return Number.isFinite(price) && price >= 0 ? price : null;
}

const SELECTABLE_MODEL_CAPABILITY_STATUSES = new Set([
  "verified",
  "configured",
  "legacy",
]);

/**
 * Paid generation is fail-closed: a display status alone is not enough.
 * The server-authorized catalog must explicitly mark the route as submittable.
 */
export function isCatalogModelSelectable(model: AiModelOption): boolean {
  const status = String(model.capabilityStatus || model.capabilities?.status || "")
    .trim()
    .toLowerCase();
  return model.capabilities?.canSubmit === true
    && SELECTABLE_MODEL_CAPABILITY_STATUSES.has(status);
}

export function getCatalogModelUnavailableMessage(model: AiModelOption): string {
  if (isCatalogModelSelectable(model)) return "";
  const reason = String(
    model.unavailableReason || model.capabilities?.unavailableReason || "",
  ).trim();
  if (reason) return reason;
  if (model.capabilities?.canSubmit !== true) return "后台尚未授权该模型提交";
  const status = String(model.capabilityStatus || model.capabilities?.status || "unverified")
    .trim()
    .toLowerCase();
  if (status === "unverified") return "能力未验证，暂不可用";
  if (status === "retired") return "模型已下线";
  return `能力状态：${status || "unknown"}，暂不可用`;
}

/** 增强/超分面板「模型选择」行：按源模型在目录中的映射显示，查不到时回退给定常量。 */
export function resolveEnhanceModelLabel(
  sourceModelId: string | undefined,
  models: readonly AiModelOption[],
  fallbackLabel: string,
): string {
  const normalizedId = String(sourceModelId || "").trim();
  const found = normalizedId ? models.find((model) => model.id === normalizedId) : undefined;
  if (found) return getModelEnhanceDisplayName(found);
  return fallbackLabel;
}

/** 类型默认模型：isDefault 优先，否则该类型第一项。 */
export function pickDefaultCatalogModel(
  models: readonly AiModelOption[],
  type: ModelCatalogType | string,
): AiModelOption | undefined {
  const typed = models.filter((model) => model.type === type);
  return typed.find((model) => model.isDefault) ?? typed[0];
}

/**
 * 节点模型胶囊文案（纯函数版，供 InfiniteCanvasStable 与单测共用）。
 *
 * 只有后端目录命中的模型才展示运营名称；已下线或未知的历史模型不会伪装成可用项。
 */
export function resolveNodeModelLabel(input: {
  nodeType: string;
  modelId?: string;
  models: readonly AiModelOption[];
}): string {
  const { nodeType, modelId, models } = input;
  const found = models.find((item) => item.id === modelId);
  if (found) return getModelDisplayName(found);
  const trimmed = String(modelId || "").trim();
  if (["image", "video", "text", "audio", "script"].includes(nodeType)) return "请选择模型";
  return trimmed;
}

export type ModelCatalogFetchType = (type: ModelCatalogType) => Promise<unknown>;

/**
 * 拉取全部类型的模型目录（四个类型并发）。
 * 单类型失败只损失该类型；全部失败才 reject（由调用方进入 failed 态）。
 */
export async function loadModelCatalog(fetchType: ModelCatalogFetchType): Promise<AiModelOption[]> {
  const results = await Promise.allSettled(
    MODEL_CATALOG_TYPES.map((type) => fetchType(type).then((response) => normalizeCatalogModels(response, type))),
  );
  const models: AiModelOption[] = [];
  let succeeded = 0;
  for (const result of results) {
    if (result.status === "fulfilled") {
      succeeded += 1;
      models.push(...result.value);
    }
  }
  if (succeeded === 0) {
    const firstReason = results.find((result) => result.status === "rejected") as PromiseRejectedResult | undefined;
    throw firstReason?.reason instanceof Error ? firstReason.reason : new Error("模型目录加载失败");
  }
  return models;
}

/** 从当前会话工作区实时拉取目录；每次调用都会发起新请求。 */
export function loadModelCatalogFromApi(): Promise<AiModelOption[]> {
  return loadModelCatalog((type) => api.modelsCatalog(type));
}

/** @deprecated 使用 loadModelCatalogFromApi；此兼容入口同样不再缓存。 */
export function loadModelCatalogCached(): Promise<AiModelOption[]> {
  return loadModelCatalogFromApi();
}

/** @deprecated 目录已不缓存；仅保留供旧测试调用。 */
export function resetModelCatalogCacheForTest(): void {
  // no-op
}
