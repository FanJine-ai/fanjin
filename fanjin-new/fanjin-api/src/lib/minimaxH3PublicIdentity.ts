import { AUTODL_H3_MODEL, AUTODL_H3_CINEMA_MODEL } from "./autodlH3Manifest";

export const MINIMAX_H3_FANJIN_MODEL = "minimax-h3-fanjin";
export const MINIMAX_H3_FANJIN_NAME = "MiniMax H3-Fanjin";
export const MINIMAX_H3_CINEMA_MODEL = "minimax-h3-fanjin-cinema";
export const MINIMAX_H3_CINEMA_NAME = "H3 影视版";

/** Keep persisted routing, certification and billing identities unchanged. */
export function internalModelId<T extends string | null | undefined>(model: T): T {
  return (model === MINIMAX_H3_CINEMA_MODEL ? AUTODL_H3_CINEMA_MODEL : model === MINIMAX_H3_FANJIN_MODEL ? AUTODL_H3_MODEL : model) as T;
}

export function publicModelId<T extends string | null | undefined>(model: T): T {
  return (model === AUTODL_H3_CINEMA_MODEL ? MINIMAX_H3_CINEMA_MODEL : model === AUTODL_H3_MODEL ? MINIMAX_H3_FANJIN_MODEL : model) as T;
}

export function isFanjinH3Model(model: unknown): boolean {
  return model === AUTODL_H3_MODEL || model === MINIMAX_H3_FANJIN_MODEL
    || model === AUTODL_H3_CINEMA_MODEL || model === MINIMAX_H3_CINEMA_MODEL;
}

/** Only this exact alias is equivalent; unrelated models never gain permission. */
export function modelAllowlistIncludes(allowlist: string[], model: string): boolean {
  return allowlist.some(allowed => internalModelId(allowed) === internalModelId(model));
}

export function publicH3Text(text: string): string {
  return text.replace(/autodl-h3-cinema/gi, MINIMAX_H3_CINEMA_MODEL)
    .replace(/autodl-h3(?!-cinema)/gi, MINIMAX_H3_FANJIN_MODEL)
    .replace(/autodl H3/gi, MINIMAX_H3_FANJIN_NAME)
    .replace(/autodl_/gi, "minimax_h3_fanjin_")
    .replace(/autodl/gi, "Fanjin");
}

/** Historical request/task metadata: change identity fields, never user content. */
export function publicModelFields<T>(value: T): T {
  if (Array.isArray(value)) return value.map(publicModelFields) as T;
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => {
    if (["model", "modelId", "videoModel", "modelRouteId", "routeId"].includes(key) && typeof child === "string") {
      return [key, child === "fanjin-autodl-h3-cinema-route" ? MINIMAX_H3_CINEMA_MODEL : child === "fanjin-autodl-h3-route" ? MINIMAX_H3_FANJIN_MODEL : publicModelId(child)];
    }
    return [key, publicModelFields(child)];
  })) as T;
}

const INTERNAL_DIRECTORY_KEYS = new Set([
  "channelId", "channelIds", "source", "officialDocumentation", "documentationUrl",
  "routeConfig", "config", "configJson", "credentialRef", "baseUrl", "upstreamModel",
]);
const IDENTITY_KEYS = new Set(["id", "model", "modelId", "model_name", "routeId", "resolvedModel"]);
const NAME_KEYS = new Set(["name", "label", "displayName", "routeName"]);

/** Model-directory metadata only. Never pass prompts, asset URLs or user content. */
export function publicH3ModelCapability<T extends Record<string, any>>(value: T): T {
  if (![value.model, value.id, value.modelId, value.model_name].some(isFanjinH3Model)) return value;
  const cinema = [value.model, value.id, value.modelId, value.model_name]
    .some(model => model === AUTODL_H3_CINEMA_MODEL || model === MINIMAX_H3_CINEMA_MODEL);
  function metadata(child: unknown): unknown {
    if (typeof child === "string") return publicH3Text(child);
    if (Array.isArray(child)) return child.map(metadata);
    if (!child || typeof child !== "object") return child;
    return Object.fromEntries(Object.entries(child).filter(([key]) => !INTERNAL_DIRECTORY_KEYS.has(key))
      .map(([key, item]) => [key, metadata(item)]));
  }
  const result = metadata(value) as Record<string, any>;
  for (const key of IDENTITY_KEYS) if (key in result) result[key] = cinema ? MINIMAX_H3_CINEMA_MODEL : MINIMAX_H3_FANJIN_MODEL;
  for (const key of NAME_KEYS) if (key in result) result[key] = cinema ? MINIMAX_H3_CINEMA_NAME : MINIMAX_H3_FANJIN_NAME;
  for (const key of ["provider", "vendor_name"]) if (key in result) result[key] = "Fanjin";
  for (const key of ["vendor_icon"]) if (key in result) result[key] = "fanjin";
  for (const key of ["apiStyle", "api_style"]) if (key in result) result[key] = "Fanjin media generation API";
  if ("aliases" in result) result.aliases = [];
  if ("enhanceDisplayName" in result) result.enhanceDisplayName = null;
  return result as T;
}
