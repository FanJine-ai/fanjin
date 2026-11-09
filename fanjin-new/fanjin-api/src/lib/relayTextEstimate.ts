import { imageSize } from "image-size";
import { Tiktoken } from "js-tiktoken/lite";
import o200kBase from "js-tiktoken/ranks/o200k_base";

/** A reservation estimate, never a substitute for authoritative provider usage. */
export interface RelayInputEstimate {
  method: "gpt-content-v1" | "legacy-byte-fallback";
  promptTokens: number;
  textTokens: number;
  imageTokens: number;
  imageCount: number;
  unknownImageCount: number;
  fallbackReason?: string;
}

const record = (value: unknown): Record<string, any> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : null;

// Explicit families only: a new model must not silently inherit image sizing rules.
export function supportsGptContentEstimate(model: unknown): boolean {
  return typeof model === "string" && /^gpt-(?:5\.2|5\.4(?:-(?:mini|nano))?|5\.5|5\.6(?:-(?:sol|terra|luna))?|6-astra)(?:-\d{4}-\d{2}-\d{2})?$/.test(model);
}

export function defaultGptOutputBudget(): number {
  const configured = Number(process.env.FANJIN_RELAY_DEFAULT_GPT_OUTPUT_TOKENS);
  const maximum = Number(process.env.FANJIN_RELAY_MAX_OUTPUT_TOKENS);
  const limit = Number.isSafeInteger(maximum) && maximum > 0 ? Math.min(maximum, 128_000) : 128_000;
  return Math.min(Number.isSafeInteger(configured) && configured > 0 ? configured : 32_768, limit);
}

let tokenizer: Tiktoken | undefined;
function countText(text: string): number {
  tokenizer ??= new Tiktoken(o200kBase);
  let tokens = 0;
  // Bound tokenizer work for very long repetitive inputs; chunk boundaries and
  // model-specific chat templates are covered by the reserve margin below.
  for (let offset = 0; offset < text.length; offset += 8_192) {
    tokens += tokenizer.encode(text.slice(offset, offset + 8_192), [], []).length;
  }
  return tokens;
}

function imageDimensions(url: unknown): { width: number; height: number } | null {
  if (typeof url !== "string" || !/^data:image\/(?:png|jpeg|jpg|webp|gif);base64,/i.test(url)) return null;
  // Header inspection only, no remote fetches or pixel decoding. An unusually
  // large header falls back to the model/detail ceiling rather than URL bytes.
  try {
    const header = Buffer.from(url.slice(url.indexOf(",") + 1, url.indexOf(",") + 1 + 349_528), "base64");
    const { width, height } = imageSize(header);
    return width > 0 && height > 0 ? { width, height } : null;
  } catch { return null; }
}

function imageBudget(model: string, detail: unknown): { patches: number; dimension: number } {
  const newest = /^gpt-(?:5\.6|6-astra)/.test(model);
  const version55 = /^gpt-5\.5/.test(model);
  const version52 = /^gpt-5\.2/.test(model);
  if (version52) return { patches: 6_144, dimension: 2_048 };
  if (detail === "low") return newest || version55
    ? { patches: 256, dimension: 512 } : { patches: 6_144, dimension: 2_048 };
  if (detail === "high" || (!newest && !version55 && detail !== "original")) {
    return { patches: 2_500, dimension: model.startsWith("gpt-6-astra") ? 65_535 : 2_048 };
  }
  // GPT-5.5/5.6/6 auto has original sizing, NOT high's 2,500-patch budget.
  return newest ? { patches: 30_000, dimension: 65_535 } : { patches: 10_000, dimension: 6_000 };
}

function imageTokens(model: string, part: Record<string, any>): { tokens: number; unknown: boolean } {
  const image = record(part.image_url);
  const budget = imageBudget(model, part.detail ?? image?.detail ?? "auto");
  const dimensions = imageDimensions(image?.url ?? part.image_url);
  if (!dimensions) return { tokens: Math.ceil(budget.patches * 1.2), unknown: true };
  const scale = Math.min(1, budget.dimension / Math.max(dimensions.width, dimensions.height));
  const width = Math.max(1, Math.floor(dimensions.width * scale));
  const height = Math.max(1, Math.floor(dimensions.height * scale));
  // Using the resizing budget when exceeded is a conservative upper estimate;
  // actual patch resizing can round a few patches lower. Original rejects
  // inputs over 30k patches, so its accepted exposure is bounded by that cap.
  const patches = Math.min(budget.patches, Math.ceil(width / 32) * Math.ceil(height / 32));
  return { tokens: Math.ceil(patches * 1.2), unknown: false };
}

export function estimateGptInput(requestPayload: unknown, model: string): RelayInputEstimate | null {
  if (!supportsGptContentEstimate(model)) return null;
  const payload = record(requestPayload);
  if (!payload || (!Array.isArray(payload.messages) && typeof payload.input !== "string" && !Array.isArray(payload.input))) return null;
  if (payload.messages != null && !Array.isArray(payload.messages)) return null;
  // Hidden history, files, audio and server tools need upstream token counting.
  // Until supported, do not lower their existing reservation based on visible text.
  if (payload.previous_response_id || payload.conversation || payload.prompt || payload.audio) return null;
  let textTokens = 0, images = 0, imageTokenCount = 0, unknownImages = 0, unsupported = false;
  const text = (value: unknown) => { if (typeof value === "string") textTokens += countText(value); };
  const json = (value: unknown) => { if (value != null) text(JSON.stringify(value)); };
  const content = (value: unknown) => {
    if (typeof value === "string") { text(value); return; }
    if (value == null) return;
    if (!Array.isArray(value)) { unsupported = true; return; }
    for (const valuePart of value) {
      const part = record(valuePart);
      if (!part) { unsupported = true; continue; }
      if (["text", "input_text", "output_text", "refusal"].includes(part.type)) {
        if (typeof (part.text ?? part.refusal) !== "string") { unsupported = true; continue; }
        text(part.text ?? part.refusal);
      } else if (["image_url", "input_image"].includes(part.type)) {
        const estimate = imageTokens(model, part);
        images++; imageTokenCount += estimate.tokens; unknownImages += Number(estimate.unknown);
      } else { unsupported = true; }
    }
  };
  const messages = payload.messages ?? payload.input;
  if (typeof messages === "string") text(messages);
  else for (const valueMessage of messages) {
    const message = record(valueMessage);
    if (!message) { unsupported = true; continue; }
    textTokens += 12; // role/name/separators and message framing
    if (message.type === "function_call") { text(message.name); text(message.arguments); }
    else if (message.type === "function_call_output") content(message.output);
    else if (message.role && (!message.type || message.type === "message")) {
      content(message.content); text(message.name); text(message.refusal);
      json(message.tool_calls); json(message.function_call);
    } else { unsupported = true; }
  }
  text(payload.instructions);
  if (payload.tools != null) {
    if (!Array.isArray(payload.tools) || payload.tools.some((tool: any) => tool?.type !== "function")) unsupported = true;
    else json(payload.tools);
  }
  json(payload.functions);
  json(payload.response_format);
  json(payload.text?.format);
  if (unsupported) return null;
  const floorValue = Number(process.env.FANJIN_RELAY_MIN_INPUT_RESERVE_TOKENS);
  const floor = Number.isSafeInteger(floorValue) && floorValue >= 0 ? floorValue : 0;
  return {
    method: "gpt-content-v1",
    promptTokens: Math.max(floor, Math.ceil((textTokens + imageTokenCount) * 1.2) + 256),
    textTokens, imageTokens: imageTokenCount, imageCount: images, unknownImageCount: unknownImages,
  };
}
