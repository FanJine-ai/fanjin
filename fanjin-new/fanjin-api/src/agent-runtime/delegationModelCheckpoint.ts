const REQUIRED_MODEL_TURN_FIELDS = [
  "approvalId",
  "assistantText",
  "calls",
  "content",
  "outcome",
  "toolResults",
  "turn",
  "type",
] as const;

const ALLOWED_MODEL_TURN_FIELDS = new Set<string>([
  ...REQUIRED_MODEL_TURN_FIELDS,
  "reasoningContent",
]);

/**
 * Shared field contract for delegation admission and completion. Old persisted
 * turns omit reasoningContent; current ToolLoop turns include a bounded string.
 * Stage-specific checks (including consumed tool results) remain in each reader.
 */
export function hasValidDelegationModelCheckpointFields(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  if (!REQUIRED_MODEL_TURN_FIELDS.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    || !keys.every((key) => ALLOWED_MODEL_TURN_FIELDS.has(key))) {
    return false;
  }
  return !Object.prototype.hasOwnProperty.call(value, "reasoningContent")
    || (typeof value.reasoningContent === "string" && value.reasoningContent.length <= 32_000);
}
