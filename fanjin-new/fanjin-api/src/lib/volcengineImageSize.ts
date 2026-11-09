/**
 * Volcengine Ark Seedream recommended pixel sizes.
 *
 * Keep this table as the single wire-size contract for every internal image
 * generation entry point. A capability may advertise only a subset of these
 * qualities or ratios; callers must validate that model capability first.
 *
 * Do not synthesize a size for an unknown combination. Seedream validates
 * total pixels as well as aspect ratio, so a mathematically similar fallback
 * can still be rejected by the provider after billing dispatch starts.
 */
export const VOLCENGINE_IMAGE_SIZE_PRESETS = {
  "1K": {
    "1:1": "1024x1024",
    "4:3": "1152x864",
    "3:4": "864x1152",
    "16:9": "1280x720",
    "9:16": "720x1280",
    "3:2": "1248x832",
    "2:3": "832x1248",
    "21:9": "1512x648",
  },
  "2K": {
    "1:1": "2048x2048",
    "4:3": "2304x1728",
    "3:4": "1728x2304",
    "16:9": "2848x1600",
    "9:16": "1600x2848",
    "3:2": "2496x1664",
    "2:3": "1664x2496",
    "21:9": "3136x1344",
  },
  "4K": {
    "1:1": "4096x4096",
    "4:3": "4704x3520",
    "3:4": "3520x4704",
    "16:9": "5504x3040",
    "9:16": "3040x5504",
    "3:2": "4992x3328",
    "2:3": "3328x4992",
    "21:9": "6240x2656",
  },
} as const satisfies Record<string, Record<string, string>>;

export type VolcengineImageQuality =
  keyof typeof VOLCENGINE_IMAGE_SIZE_PRESETS;
export type VolcengineImageAspectRatio =
  keyof (typeof VOLCENGINE_IMAGE_SIZE_PRESETS)["2K"];

/**
 * Resolve an already capability-approved quality/ratio pair.
 *
 * `null` is deliberate: unsupported or newly advertised combinations must
 * fail before task creation, provider dispatch, and billing side effects.
 */
export function resolveVolcengineImageSize(
  quality: unknown,
  ratio: unknown,
): string | null {
  const normalizedQuality = String(quality ?? "").trim().toUpperCase();
  const normalizedRatio = String(ratio ?? "").trim();
  const qualityTable = (
    VOLCENGINE_IMAGE_SIZE_PRESETS as Record<string, Record<string, string>>
  )[normalizedQuality];
  return qualityTable?.[normalizedRatio] ?? null;
}

/**
 * Map a provider wire-size back to its catalog quality tier.
 *
 * Workbench requests send the exact pixel preset to Ark. Certification must
 * therefore classify those persisted request payloads as 2K/4K evidence
 * instead of silently treating every pixel size as the base route.
 */
export function volcengineImageQualityForSize(
  size: unknown,
): VolcengineImageQuality | null {
  const normalizedSize = String(size ?? "").trim().toLowerCase();
  if (!normalizedSize) return null;
  for (const [quality, ratios] of Object.entries(VOLCENGINE_IMAGE_SIZE_PRESETS)) {
    if (Object.values(ratios).some((candidate) => candidate.toLowerCase() === normalizedSize)) {
      return quality as VolcengineImageQuality;
    }
  }
  return null;
}
