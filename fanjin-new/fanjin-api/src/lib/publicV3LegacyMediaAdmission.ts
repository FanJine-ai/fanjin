const MEDIA_TYPE_TOKENS = new Set([
  "audio",
  "audio_url",
  "file",
  "file_url",
  "image",
  "image_url",
  "input_audio",
  "input_file",
  "input_image",
  "input_video",
  "media",
  "media_url",
  "reference_audio",
  "reference_file",
  "reference_image",
  "reference_video",
  "video",
  "video_url",
]);

const TEXT_KEYS = new Set(["text", "input_text"]);
const LOCATOR_KEYS = new Set(["url", "uri", "href", "src"]);

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizedToken(value: unknown): string {
  return typeof value === "string"
    ? value
        .trim()
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .toLowerCase()
        .replace(/[\s.-]+/g, "_")
    : "";
}

function hasMediaToken(value: unknown): boolean {
  const token = normalizedToken(value);
  if (!token) return false;
  if (MEDIA_TYPE_TOKENS.has(token)) return true;
  return token.split("_").some((part) => (
    part === "audio"
    || part === "file"
    || part === "frame"
    || part === "image"
    || part === "media"
    || part === "video"
  ));
}

function isMediaNamedKey(key: string): boolean {
  const token = normalizedToken(key);
  if (!token || token === "type") return false;
  if (token === "base64" || token === "b64_json" || token === "mime_type" || token === "mimetype") {
    return true;
  }
  return hasMediaToken(token);
}

function stringLooksLikeMediaLocator(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const candidate = value.trim().toLowerCase();
  if (!candidate) return false;
  if (/^data:(?:(?:image|video|audio)\/|application\/(?:octet-stream|pdf))/.test(candidate)) return true;
  if (/^(?:asset|blob|https?):\/\//.test(candidate)) return true;
  if (candidate.length >= 64 && /^[a-z0-9+/]+={0,2}$/i.test(candidate)) return true;
  return /(?:^|[/?#&=])[^/?#&=]+\.(?:avif|bmp|gif|heic|heif|jpe?g|m4a|m4v|mov|mp3|mp4|mpeg|ogg|pdf|png|svg|wav|webm|webp)(?:[?#&=]|$)/i
    .test(candidate);
}

/**
 * Public v3 historically accepted provider-shaped `content[]`. It has no
 * Fanjin asset identity, ownership or portrait-admission evidence, so media
 * references cannot safely enter pricing/task creation. Text-only legacy
 * requests remain compatible while callers migrate to `canonicalRequest`.
 */
export function containsLegacyProviderMediaReference(content: unknown): boolean {
  if (!Array.isArray(content)) return false;

  const stack: Array<{ key: string | null; value: unknown }> = content.map((value) => ({
    key: null,
    value,
  }));
  const visited = new WeakSet<object>();

  while (stack.length > 0) {
    const current = stack.pop()!;

    if (Array.isArray(current.value)) {
      if (visited.has(current.value)) continue;
      visited.add(current.value);
      for (const value of current.value) stack.push({ key: current.key, value });
      continue;
    }

    const item = record(current.value);
    if (item) {
      if (visited.has(item)) continue;
      visited.add(item);
      if (hasMediaToken(item.type)) return true;
      for (const [key, value] of Object.entries(item)) {
        const normalizedKey = normalizedToken(key);
        if (isMediaNamedKey(normalizedKey)) return true;
        if (LOCATOR_KEYS.has(normalizedKey) && typeof value === "string" && value.trim()) return true;
        stack.push({ key: normalizedKey, value });
      }
      continue;
    }

    // A URL written inside an explicit text field is still text. Media data
    // in any other field is a provider reference and must use an asset ID.
    if (!TEXT_KEYS.has(current.key || "") && stringLooksLikeMediaLocator(current.value)) return true;
  }

  return false;
}

const LEGACY_VIDEO_TEXT_OR_CONTROL_KEYS = new Set([
  "callbackUrl",
  "callbackSecret",
  "callback_secret",
  "callback_url",
  "canonicalRequest",
  "content",
  "model",
  "projectId",
  "project_id",
  "prompt",
  "provider",
  "requestId",
  "resolution",
  "workspaceId",
]);

function isLegacyVideoSafeScalarControl(key: string, value: unknown): boolean {
  if (key === "aspect_ratio") return typeof value === "string";
  if (key === "audio") return typeof value === "boolean";
  if (key === "generate_audio") return typeof value === "boolean";
  // Output/display controls are scalar choices, never media locators.
  if (key === "return_last_frame" || key === "camera_fixed") return typeof value === "boolean";
  return false;
}

/**
 * Scan the whole provider-shaped request, not only `content[]`. Historical
 * clients also placed media in fields such as `first_frame` and nested
 * `provider_options`, which must not bypass asset ownership/admission checks.
 */
export function containsLegacyVideoMediaRequest(
  input: Record<string, unknown>,
): boolean {
  if (containsLegacyProviderMediaReference(input.content)) return true;
  const providerExtensions = Object.fromEntries(
    Object.entries(input).filter(([key, value]) => (
      !LEGACY_VIDEO_TEXT_OR_CONTROL_KEYS.has(key)
      && !isLegacyVideoSafeScalarControl(key, value)
    )),
  );
  return containsLegacyProviderMediaReference([providerExtensions]);
}

export const PUBLIC_V3_LEGACY_MEDIA_UPGRADE_ERROR = Object.freeze({
  code: "legacy_media_requires_canonical_request",
  message: "媒体参考必须使用 canonicalRequest，并通过 Fanjin assetVersionId 提交",
});
