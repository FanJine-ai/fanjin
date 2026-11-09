const QUICK_CREATE_IMAGE_MODEL_ALIASES: Record<string, string> = {
  "图片 4.0": "doubao-seedream-5-0-lite-260128",
  "图片 4.1": "doubao-seedream-5-0-lite-260128",
};

export function resolveQuickCreateImageModel(model?: string | null): string | null {
  const value = String(model || "").trim();
  if (!value) return null;
  return QUICK_CREATE_IMAGE_MODEL_ALIASES[value] || value;
}
