/** Server-owned extraction policy; public relay requests cannot select it. */
export function relayChatPurposeTimeout(timeoutMs: number | undefined, purpose?: "script_asset_extraction") {
  const configured = timeoutMs || 120_000;
  return purpose === "script_asset_extraction" ? Math.max(configured, 300_000) : configured;
}

export function extractionSupportsThinkingControl(model: string) {
  return /^doubao-seed-2-1-(?:pro|turbo)(?:-260628)?$/.test(model)
    || /^deepseek-v(?:3\.2|4(?:\.\d+)?)(?:-(?:flash|pro))?$/.test(model);
}
