import type { AiModelOption } from "@/lib/api";

export type CanvasImageOutputCount = 1 | 2 | 4;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function numericOptions(value: unknown): CanvasImageOutputCount[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(Number)
    .filter((item): item is CanvasImageOutputCount => item === 1 || item === 2 || item === 4);
}

export function getCanvasImageOutputCounts(
  model: AiModelOption | undefined,
): CanvasImageOutputCount[] {
  const capabilities = model?.capabilities;
  const parameters = record(capabilities?.parameters);
  const countParameter = record(parameters.count);
  for (const value of [
    capabilities?.outputCounts,
    countParameter.options,
    countParameter.values,
  ]) {
    const explicit = numericOptions(value);
    if (explicit.length) {
      return Array.from(new Set(explicit)).sort((left, right) => left - right);
    }
  }
  const maxOutputs = Number(
    capabilities?.maxOutputs ?? countParameter.maximum ?? countParameter.max,
  );
  if (!Number.isSafeInteger(maxOutputs) || maxOutputs < 1) return [1];
  return ([1, 2, 4] as CanvasImageOutputCount[])
    .filter((value) => value <= maxOutputs);
}

export function normalizeNodeMaxImages(
  value: unknown,
  model: AiModelOption | undefined,
): CanvasImageOutputCount {
  const allowed = getCanvasImageOutputCounts(model);
  const requested = Number(value);
  return allowed.includes(requested as CanvasImageOutputCount)
    ? requested as CanvasImageOutputCount
    : allowed[0] || 1;
}
