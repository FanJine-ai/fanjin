import type { ModelRouteFilters, ModelRouteForm, ModelRouteRecord, ModelRouteRow } from "./types";

export const emptyModelRouteFilters: ModelRouteFilters = { keyword: "", endpointType: "", provider: "", status: "" };

export const endpointLabels: Record<string, string> = {
  video_generation: "视频生成",
  video_upscale: "视频增强",
  image_generation: "图片生成",
  text: "文本",
  embedding: "文本向量",
  multimodal_embedding: "多模态向量",
  tts: "语音合成",
  rerank: "文本重排",
  transcription: "音频转写",
};

export const modelRouteScopes = ["platform", "workspace"] as const;
export const modelRouteEndpointTypes = [
  "video_generation",
  "video_upscale",
  "image_generation",
  "text",
  "embedding",
  "multimodal_embedding",
  "tts",
  "rerank",
  "transcription",
] as const;
export const modelRouteProviders = ["", "volcano", "autodl", "custom", "openai", "anthropic", "codex", "gemini", "azure"] as const;

export function endpointLabel(value: string) { return endpointLabels[value] || value || "-"; }

export function parseListText(value: string) {
  return Array.from(new Set(value.split(/[\n,，]+/).map((item) => item.trim()).filter(Boolean)));
}

export function normalizeModelRoute(item: ModelRouteRecord, index: number): ModelRouteRow {
  const config = item.routeConfig && typeof item.routeConfig === "object" && !Array.isArray(item.routeConfig) ? item.routeConfig : {};
  const resolutions = Array.isArray(config.resolutions) ? config.resolutions.map(String).map((value) => value.trim()).filter(Boolean) : [];
  return {
    id: String(item.id || `${item.model || "route"}-${index}`),
    source: item,
    name: String(item.name || item.model || "未命名路由"),
    displayName: String(item.displayName || "").trim(),
    enhanceDisplayName: String(config.enhanceDisplayName || "").trim(),
    model: String(item.model || "-"),
    endpointType: String(item.endpointType || "-"),
    provider: String(item.provider || "-") ,
    channelId: String(item.channelId || "-"),
    scope: String(item.scope || item.workspaceId || "platform"),
    priority: Number.isFinite(Number(item.priority)) ? Number(item.priority) : 0,
    fallbackOrder: Number.isFinite(Number(item.fallbackOrder)) ? Number(item.fallbackOrder) : 0,
    resolutions,
    defaultResolution: String(config.defaultResolution || config.resolutionDefault || resolutions[0] || ""),
    status: item.disabled === true || Number(item.disabled) === 1 ? "disabled" : "enabled",
    readiness: item.readiness && typeof item.readiness === "object" ? item.readiness : null,
  };
}

export function filterModelRouteRows(rows: ModelRouteRow[], filters: ModelRouteFilters) {
  const keyword = filters.keyword.trim().toLowerCase();
  return rows.filter((row) => {
    const text = [row.id, row.name, row.displayName, row.model, row.provider, row.channelId, row.scope].join(" ").toLowerCase();
    return (!keyword || text.includes(keyword))
      && (!filters.endpointType || row.endpointType === filters.endpointType)
      && (!filters.provider || row.provider === filters.provider)
      && (!filters.status || row.status === filters.status);
  });
}

export function emptyModelRouteForm(): ModelRouteForm {
  return {
    id: "",
    name: "",
    displayName: "",
    enhanceDisplayName: "",
    scope: "platform",
    workspaceId: "",
    endpointType: "video_generation",
    model: "",
    provider: "",
    channelId: "",
    priority: 100,
    fallbackOrder: 0,
    routeConfigText: "{}",
    disabled: false,
  };
}

export function safeJson(value: unknown) {
  try { return JSON.stringify(value ?? {}, null, 2); } catch { return String(value); }
}

export function modelRouteFormFromRoute(row: ModelRouteRow): ModelRouteForm {
  return {
    id: row.id,
    name: row.name,
    displayName: row.displayName,
    enhanceDisplayName: row.enhanceDisplayName,
    scope: String(row.source.scope || "platform"),
    workspaceId: String(row.source.workspaceId || ""),
    endpointType: row.endpointType,
    model: row.model === "-" ? "" : row.model,
    provider: row.provider === "-" ? "" : row.provider,
    channelId: row.channelId === "-" ? "" : row.channelId,
    priority: row.priority,
    fallbackOrder: row.fallbackOrder,
    routeConfigText: safeJson(row.source.routeConfig || {}),
    disabled: row.status === "disabled",
  };
}

export type ModelRouteFormErrors = Partial<Record<
  "name" | "scope" | "workspaceId" | "endpointType" | "model" | "provider" | "priority" | "fallbackOrder" | "routeConfigText",
  string
>>;

export function validateModelRouteForm(form: ModelRouteForm): ModelRouteFormErrors {
  const errors: ModelRouteFormErrors = {};
  if (!form.name.trim()) errors.name = "请输入路由名称";
  if (!modelRouteScopes.includes(form.scope as (typeof modelRouteScopes)[number])) {
    errors.scope = `不支持的范围「${form.scope || "空值"}」`;
  }
  if (form.scope === "workspace" && !form.workspaceId.trim()) errors.workspaceId = "Workspace ID 不能为空";
  if (!modelRouteEndpointTypes.includes(form.endpointType as (typeof modelRouteEndpointTypes)[number])) {
    errors.endpointType = `不支持的能力类型「${form.endpointType || "空值"}」，请选择有效能力。`;
  }
  if (!form.model.trim()) errors.model = "请输入模型 ID";
  if (!modelRouteProviders.includes(form.provider as (typeof modelRouteProviders)[number])) {
    errors.provider = `不支持的供应商「${form.provider}」，请选择有效供应商。`;
  }
  if (!Number.isInteger(form.priority)) errors.priority = "优先级必须是整数";
  if (!Number.isInteger(form.fallbackOrder)) errors.fallbackOrder = "回退顺序必须是整数";
  try {
    const parsed = JSON.parse(form.routeConfigText.trim() || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) errors.routeConfigText = "Route Config 必须是 JSON 对象";
  } catch {
    errors.routeConfigText = "JSON 格式错误，请检查引号、逗号和括号";
  }
  return errors;
}

export function modelRoutePayloadFromForm(form: ModelRouteForm): Record<string, unknown> {
  const errors = validateModelRouteForm(form);
  const message = Object.values(errors)[0];
  if (message) throw new Error(message);
  const routeConfig = JSON.parse(form.routeConfigText.trim() || "{}") as Record<string, unknown>;
  const enhanceDisplayName = form.enhanceDisplayName.trim();
  if (enhanceDisplayName) routeConfig.enhanceDisplayName = enhanceDisplayName;
  else delete routeConfig.enhanceDisplayName;
  return {
    name: form.name.trim(),
    displayName: form.displayName.trim() || null,
    scope: form.scope,
    workspaceId: form.scope === "workspace" ? form.workspaceId.trim() : null,
    endpointType: form.endpointType,
    model: form.model.trim(),
    provider: form.provider || null,
    channelId: form.channelId.trim() || null,
    priority: form.priority,
    fallbackOrder: form.fallbackOrder,
    routeConfig,
    disabled: form.disabled ? 1 : 0,
  };
}
