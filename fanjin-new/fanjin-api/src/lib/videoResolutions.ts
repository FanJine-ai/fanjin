/** Public + internal video resolution helpers (fulfillment recipes design). */

/** Explicit local deployment override; production and remote databases stay closed. */
export function isLocalNative480pEnabled(environment: Record<string, string | undefined> = process.env): boolean {
  if (environment.NODE_ENV !== "development" || environment.FANJIN_DEV_ALLOW_NATIVE_480P !== "1") return false;
  if (!["127.0.0.1", "::1"].includes(environment.FANJIN_BIND_HOST || "")) return false;
  try {
    const database = new URL(environment.DATABASE_URL || "");
    return ["postgres:", "postgresql:"].includes(database.protocol)
      && ["127.0.0.1", "[::1]"].includes(database.hostname)
      && database.pathname.startsWith("/fanjin_local_");
  } catch { return false; }
}

export const PUBLIC_VIDEO_RESOLUTIONS = [
  ...(isLocalNative480pEnabled() ? ["480p" as const] : []),
  "720p", "1080p", "2k", "4k",
] as const;
export type PublicVideoResolution = (typeof PUBLIC_VIDEO_RESOLUTIONS)[number];

/**
 * Provider-native generation tiers that may be selected in the authenticated
 * creation surfaces. 480p/768p are not production public fulfillment/enhancement SKUs;
 * they are exposed only when an exact model route declares them as native.
 */
export const USER_SELECTABLE_VIDEO_GENERATION_RESOLUTIONS = [
  "480p",
  "720p",
  "768p",
  "960p",
  "1080p",
  "2k",
  "4k",
] as const;
export type UserSelectableVideoGenerationResolution =
  (typeof USER_SELECTABLE_VIDEO_GENERATION_RESOLUTIONS)[number];

/** Allowed as generateResolution inside recipes (not user-facing alone). */
export const INTERNAL_VIDEO_RESOLUTIONS = ["480p", "720p", "768p", "960p", "1080p", "2k", "4k"] as const;
export type InternalVideoResolution = (typeof INTERNAL_VIDEO_RESOLUTIONS)[number];

const HEIGHT: Record<string, number> = {
  "480p": 480,
  "720p": 720,
  "768p": 768,
  "960p": 960,
  "1080p": 1080,
  "2k": 1440,
  "4k": 2160,
  "2160p": 2160,
};

/** Normalize user/API aliases into canonical tokens. */
export function normalizeVideoResolution(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const raw = String(value).trim().toLowerCase();
  if (!raw) return null;
  if (raw === "2160p" || raw === "2160" || raw === "uhd" || raw === "ultra_hd") return "4k";
  if (raw === "4k") return "4k";
  if (raw === "2k" || raw === "1440p" || raw === "1440") return "2k";
  if (raw === "1080" || raw === "1080p" || raw === "fhd") return "1080p";
  if (raw === "720" || raw === "720p" || raw === "hd") return "720p";
  if (raw === "960" || raw === "960p") return "960p";
  if (raw === "768" || raw === "768p") return "768p";
  if (raw === "480" || raw === "480p" || raw === "sd") return "480p";
  // already canonical
  if (raw in HEIGHT) return raw === "2160p" ? "4k" : raw;
  const match = raw.match(/(\d{3,4})\s*p?/);
  if (match) {
    const n = Number(match[1]);
    if (n === 480) return "480p";
    if (n === 720) return "720p";
    if (n === 960) return "960p";
    if (n === 768) return "768p";
    if (n === 1080) return "1080p";
    if (n === 1440) return "2k";
    if (n === 2160) return "4k";
  }
  return raw;
}

export function videoResolutionHeight(resolution: string | null | undefined): number {
  const normalized = normalizeVideoResolution(resolution);
  if (!normalized) return 0;
  return HEIGHT[normalized] || 0;
}

export function isPublicVideoResolution(value: unknown): value is PublicVideoResolution {
  const n = normalizeVideoResolution(value);
  return Boolean(n && (PUBLIC_VIDEO_RESOLUTIONS as readonly string[]).includes(n));
}

export function isInternalVideoResolution(value: unknown): value is InternalVideoResolution {
  const n = normalizeVideoResolution(value);
  return Boolean(n && (INTERNAL_VIDEO_RESOLUTIONS as readonly string[]).includes(n));
}

export function isUserSelectableVideoGenerationResolution(
  value: unknown,
): value is UserSelectableVideoGenerationResolution {
  const n = normalizeVideoResolution(value);
  return Boolean(
    n
    && (USER_SELECTABLE_VIDEO_GENERATION_RESOLUTIONS as readonly string[]).includes(n),
  );
}

/** Production user/API requests may not use 480p as a public deliverable. */
export function assertPublicVideoResolution(value: unknown): PublicVideoResolution {
  const n = normalizeVideoResolution(value);
  if (!n || !isPublicVideoResolution(n)) {
    throw new Error("PUBLIC_RESOLUTION_NOT_ALLOWED");
  }
  return n;
}

export function publicResolutionLabel(value: string): string {
  const n = normalizeVideoResolution(value);
  switch (n) {
    case "720p":
      return "720p";
    case "768p":
      return "768p";
    case "1080p":
      return "1080p";
    case "2k":
      return "2K";
    case "4k":
      return "4K";
    case "480p":
      return "480p";
    default:
      return String(value || "");
  }
}

/** For enhance: target must be a higher public tier than source. */
export function canEnhanceBetween(source: unknown, target: unknown): boolean {
  if (!isPublicVideoResolution(source) || !isPublicVideoResolution(target)) return false;
  return videoResolutionHeight(source) < videoResolutionHeight(target);
}

export function recipeResolutionsValid(input: {
  targetResolution: unknown;
  generateResolution: unknown;
  enhanceEnabled: boolean;
}): boolean {
  if (!isPublicVideoResolution(input.targetResolution)) return false;
  if (!isInternalVideoResolution(input.generateResolution)) return false;
  const targetH = videoResolutionHeight(input.targetResolution);
  const genH = videoResolutionHeight(input.generateResolution);
  if (!input.enhanceEnabled) return genH === targetH;
  return genH > 0 && genH < targetH;
}
