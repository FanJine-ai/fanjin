const PUBLIC_METADATA_FIELDS = new Set([
  "durationMs",
  "durationSeconds",
  "finalResolution",
  "height",
  "mirrored",
  "quality",
  "requestedResolution",
  "resolution",
  "sourceResolution",
  "targetResolution",
  "width",
]);

const PUBLIC_RESOLUTIONS = new Set(["480p", "720p", "1080p", "2160p", "2k", "4k"]);
const PUBLIC_IMAGE_QUALITIES = new Set(["1K", "2K", "4K"]);
const PUBLIC_DIMENSION_FIELDS = new Set(["durationMs", "durationSeconds", "height", "width"]);

function parseMetadata(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 64 * 1024) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function safeMetadataValue(key: string, value: unknown): string | number | boolean | undefined {
  if (key === "mirrored") return typeof value === "boolean" ? value : undefined;
  if (key === "quality") {
    if (typeof value !== "string") return undefined;
    const quality = value.trim().toUpperCase();
    return PUBLIC_IMAGE_QUALITIES.has(quality) ? quality : undefined;
  }
  if (PUBLIC_DIMENSION_FIELDS.has(key)) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0
      ? value
      : undefined;
  }
  if (typeof value !== "string") return undefined;
  const clean = value.trim().toLowerCase();
  return PUBLIC_RESOLUTIONS.has(clean) ? clean : undefined;
}

/**
 * Creative-library metadata is an explicit public contract. Provider details,
 * lineage evidence, credentials and legacy providerVideoUrl values are omitted
 * by construction rather than recursively scrubbed.
 */
export function publicMediaAssetMetadata(value: unknown): Record<string, string | number | boolean> {
  const raw = parseMetadata(value);
  const result: Record<string, string | number | boolean> = {};
  for (const key of PUBLIC_METADATA_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    const publicValue = safeMetadataValue(key, raw[key]);
    if (publicValue !== undefined) result[key] = publicValue;
  }
  return result;
}

function normalizedConfiguredBase(value: unknown): URL | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

function isWithinConfiguredBase(candidate: URL, base: URL): boolean {
  if (candidate.origin !== base.origin) return false;
  const basePath = base.pathname.replace(/\/+$/, "");
  return !basePath
    || basePath === "/"
    || candidate.pathname === basePath
    || candidate.pathname.startsWith(`${basePath}/`);
}

/**
 * Only application-controlled media URLs may cross the library boundary.
 * Signed query strings, fragments, userinfo and arbitrary provider origins
 * fail closed. Local /oss/ media remains usable.
 */
export function publicMediaAssetUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  const clean = value.trim();
  if (!clean) return "";

  if (clean.startsWith("/oss/")) {
    try {
      const parsed = new URL(clean, "http://fanjin.local");
      if (parsed.search || parsed.hash || !parsed.pathname.startsWith("/oss/")) return "";
      if (parsed.pathname.split("/").some((part) => part === ".." || part === ".")) return "";
      return parsed.pathname;
    } catch {
      return "";
    }
  }

  let candidate: URL;
  try {
    candidate = new URL(clean);
  } catch {
    return "";
  }
  if (
    !["http:", "https:"].includes(candidate.protocol)
    || candidate.username
    || candidate.password
    || candidate.search
    || candidate.hash
  ) {
    return "";
  }

  const configuredBases = [
    process.env.ossURL,
    process.env.FANJIN_PUBLIC_BASE_URL,
    process.env.PUBLIC_BASE_URL,
    process.env.FANJIN_OBJECT_STORAGE_CDN_URL,
  ]
    .map(normalizedConfiguredBase)
    .filter((base): base is URL => base !== null);
  return configuredBases.some((base) => isWithinConfiguredBase(candidate, base))
    ? candidate.toString()
    : "";
}

export function publicMediaAssetError(value: unknown, failed: boolean): string {
  if (!failed || typeof value !== "string" || !value.trim()) return "";
  return friendlyGenerationFailureReason(value);
}

/**
 * Map upstream reject text to a short, user-actionable history reason.
 * Keep raw provider wording out of the product surface; never echo request ids.
 */
export function friendlyGenerationFailureReason(raw: unknown): string {
  const text = String(raw ?? "").trim();
  if (!text) return "生成失败";
  const lower = text.toLowerCase();
  // Preserve this exact application validation reason without publishing arbitrary provider text.
  if (/^素材 [1-9]\d{0,2}：文件格式与声明类型不一致$/.test(text)) return text;
  if (/may contain real person|真人|real person/i.test(text)) {
    return "上游认为参考素材可能含真人，请打开人物素材检查确认来源、登记或联系管理员复核";
  }
  if (/may contain sensitive information|敏感/.test(text) || (/content\[\d+\]/.test(text) && /sensitive/i.test(lower))) {
    return "提示词包含敏感内容，被上游拒绝";
  }
  if (/parameter .* is not valid|参数.*(无效|不合法)|invalid parameter/.test(lower) || /parameter .* specified in the request is not valid/i.test(text)) {
    return "请求参数不合法，被上游拒绝";
  }
  if (/rate.?limit|限流|too many/i.test(lower)) {
    return "上游限流，请稍后重试";
  }
  if (/timeout|超时/i.test(lower)) {
    return "上游超时，生成失败";
  }
  if (/insufficient|余额|quota|欠费/i.test(lower)) {
    return "余额或额度不足，生成失败";
  }
  // Unrecognized provider text may contain internal routes, local paths or
  // credentials. Publish only the mapped reasons above; keep raw details in logs.
  return "生成失败";
}
