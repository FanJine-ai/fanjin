import { GU_MICROS_PER_GU } from "@/utils/billingUnits";
import { isValueVideoModel, valueVideoPair } from "./valueVideo";
import {
  INTERNAL_VIDEO_RESOLUTIONS,
  PUBLIC_VIDEO_RESOLUTIONS,
  type PublicVideoResolution,
  type RecipeForm,
  type RecipeFormErrors,
  type VideoRecipe,
} from "./types";

export const RESOLUTION_HEIGHT: Record<string, number> = {
  "480p": 480,
  "720p": 720,
  "1080p": 1080,
  "2k": 1440,
  "4k": 2160,
};

export function resLabel(value: string): string {
  if (value === "2k") return "2K";
  if (value === "4k") return "4K";
  return value || "-";
}

export function resolutionHeight(value: string): number {
  return RESOLUTION_HEIGHT[value] || 0;
}

export function emptyRecipeForm(): RecipeForm {
  return {
    id: "",
    name: "",
    generateChannelId: "",
    generateResolution: "720p",
    upstreamModel: "",
    enhanceEnabled: false,
    enhanceChannelId: "",
    weight: 100,
    priority: 100,
    enabled: true,
  };
}

export function recipeFormFromRecipe(recipe: VideoRecipe): RecipeForm {
  return {
    id: recipe.id,
    name: recipe.name,
    generateChannelId: recipe.generateChannelId,
    generateResolution: recipe.generateResolution,
    upstreamModel: recipe.upstreamModel || "",
    enhanceEnabled: recipe.enhanceEnabled,
    enhanceChannelId: recipe.enhanceChannelId || "",
    weight: recipe.weight,
    priority: recipe.priority,
    enabled: recipe.enabled,
  };
}

/** 与设计 §3.2 一致:不开超分 gen==target;开超分 gen<target。 */
export function validateRecipeForm(form: RecipeForm, targetResolution: string, publicModel = ""): RecipeFormErrors {
  const errors: RecipeFormErrors = {};
  if (!form.generateChannelId.trim()) errors.generateChannelId = "请选择生成通道";
  const gen = form.generateResolution;
  const pair = valueVideoPair(publicModel, targetResolution);
  if (isValueVideoModel(publicModel) && (!pair || gen !== pair.source || !form.enhanceEnabled)) errors.generateResolution = "繁境特价版必须使用 480→720 或 720→1080 大模型版超分配方";
  if (!(INTERNAL_VIDEO_RESOLUTIONS as readonly string[]).includes(gen)) {
    errors.generateResolution = `不支持的内部分辨率「${gen || "空值"}」`;
  } else if (form.enhanceEnabled) {
    if (!(resolutionHeight(gen) < resolutionHeight(targetResolution))) {
      errors.generateResolution = `开启超分时原生分辨率须低于目标档 ${resLabel(targetResolution)}`;
    }
  } else if (gen !== targetResolution) {
    errors.generateResolution = `不开超分时原生分辨率须等于目标档 ${resLabel(targetResolution)}`;
  }
  if (form.enhanceEnabled && !form.enhanceChannelId.trim()) {
    errors.enhanceChannelId = "开启超分时必须选择超分服务";
  }
  if (form.enhanceEnabled && targetResolution === "4k" && form.enabled) errors.enhanceChannelId = "大模型版超分不支持 4K；请选择原生生成配方";
  if (!Number.isInteger(form.weight) || form.weight < 0) errors.weight = "权重须为非负整数";
  if (!Number.isInteger(form.priority)) errors.priority = "次序须为整数";
  return errors;
}

export function recipePayloadFromForm(form: RecipeForm): Record<string, unknown> {
  return {
    name: form.name.trim(),
    generateChannelId: form.generateChannelId,
    generateResolution: form.generateResolution,
    upstreamModel: form.upstreamModel.trim() || null,
    enhanceEnabled: form.enhanceEnabled,
    enhanceChannelId: form.enhanceEnabled ? form.enhanceChannelId : null,
    weight: form.weight,
    priority: form.priority,
    enabled: form.enabled,
  };
}

/** 状态灯:enabled>0 绿;有配方但全停用 黄;无配方 灰。 */
export type LightTone = "ok" | "warn" | "off";

export function resolutionLightTone(count: { enabled: number; total: number } | undefined): LightTone {
  if (!count || count.total === 0) return "off";
  if (count.enabled > 0) return "ok";
  return "warn";
}

export function guFromMicros(micros: number): number {
  return micros / GU_MICROS_PER_GU;
}

export function microsFromGu(gu: number): number {
  return Math.round(gu * GU_MICROS_PER_GU);
}

export const PUBLIC_RESOLUTION_LIST = PUBLIC_VIDEO_RESOLUTIONS as readonly string[];
export type { PublicVideoResolution };
