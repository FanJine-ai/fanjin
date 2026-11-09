import { GenerationReferenceError } from "@/lib/generationReferenceError";
import type { VideoGenerationRequest } from "@/lib/videoGenerationContract";
import {
  containsLegacyVideoMediaRequest,
  PUBLIC_V3_LEGACY_MEDIA_UPGRADE_ERROR,
} from "@/lib/publicV3LegacyMediaAdmission";

// Positive projection is intentional: adding a provider parameter requires a
// review of its generation, authority and pricing semantics. A denylist would
// let new/internal controls leak through the durable Worker dispatch path.
const PROVIDER_FIELDS = new Set([
  "model", "content", "ratio", "duration", "resolution", "generate_audio",
  "output_format", "seed", "fps", "watermark", "metadata", "camera_fixed", "return_last_frame",
]);

const LEGACY_TEXT_FIELDS = new Set([
  "model", "prompt", "content", "projectId", "project_id", "workspaceId",
  "requestId", "provider", "ratio", "aspect_ratio", "duration", "resolution",
  "generate_audio", "audio", "output_format", "seed", "fps", "watermark", "metadata", "camera_fixed", "return_last_frame",
  "callback_url", "callbackUrl", "callback_secret", "callbackSecret",
  // Created by prepareRelayCallbackRequestPayload, never accepted from HTTP.
  "callback_secret_ciphertext",
]);

function unsupportedControl(): never {
  throw new GenerationReferenceError(422, "legacy_video_controls_require_canonical_request",
    "旧格式支持 ratio、duration、resolution、generate_audio、output_format、seed、fps、watermark、camera_fixed、return_last_frame、metadata；其他控制请按公开接口支持范围提交");
}

function invalidControl(): never {
  throw new GenerationReferenceError(400, "legacy_video_control_invalid",
    "旧版视频扩展参数类型无效");
}

function jsonObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const stack: unknown[] = [value];
  const visited = new WeakSet<object>();
  while (stack.length) {
    const item = stack.pop();
    if (item === null || typeof item === "string" || typeof item === "boolean") continue;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) return false;
      continue;
    }
    if (!item || typeof item !== "object" || visited.has(item)) return false;
    const prototype = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) return false;
    visited.add(item);
    for (const nested of Object.values(item)) stack.push(nested);
  }
  return true;
}

/**
 * Validate only the public text compatibility fields. Context and sealed
 * callback fields remain durable so full-payload idempotency can compare them;
 * Relay removes them at the provider boundary. Metadata is inert JSON and is
 * never promoted into Relay options or authority. Media scanning remains a
 * separate mandatory check before this function at the public entry point.
 */
export function projectPublicLegacyTextVideoPayload(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!LEGACY_TEXT_FIELDS.has(key)) {
      unsupportedControl();
    }
    if (value !== undefined) payload[key] = value;
  }
  validateOrdinaryExtensions(payload);
  return payload;
}

function validateOrdinaryExtensions(payload: Record<string, unknown>): void {
  if ((payload.seed !== undefined && !Number.isSafeInteger(payload.seed))
    || (payload.fps !== undefined && (!Number.isSafeInteger(payload.fps) || Number(payload.fps) <= 0))
    || (payload.watermark !== undefined && typeof payload.watermark !== "boolean")
    || (payload.camera_fixed !== undefined && typeof payload.camera_fixed !== "boolean")
    || (payload.return_last_frame !== undefined && typeof payload.return_last_frame !== "boolean")
    || (payload.output_format !== undefined && (typeof payload.output_format !== "string"
      || !["mp4", "mov"].includes(payload.output_format)))
    || (payload.metadata !== undefined && !jsonObject(payload.metadata))) {
    invalidControl();
  }
}

/**
 * Final positive projection shared by initial submits and durable Worker
 * recovery. Call after removing Fanjin context/callback fields and before
 * adding the server-configured provider idempotency field. The caller must
 * supply only a canonical checkpoint already verified at Relay's boundary.
 */
export function projectControlledVideoProviderPayload(
  input: Record<string, unknown>,
  options: { canonicalRequest?: VideoGenerationRequest | null } = {},
): Record<string, unknown> {
  const request = options.canonicalRequest ?? null;
  // A persisted empty-input generation checkpoint must remain text-only.
  // Unbound internal legacy media keeps its existing Relay/policy admission;
  // this shared projection does not change the policy-off media contract.
  if (request?.operation === "generate" && request.renderMode !== "finalize"
    && request.inputs.length === 0 && containsLegacyVideoMediaRequest(input)) {
    throw new GenerationReferenceError(409, PUBLIC_V3_LEGACY_MEDIA_UPGRADE_ERROR.code,
      PUBLIC_V3_LEGACY_MEDIA_UPGRADE_ERROR.message);
  }
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (PROVIDER_FIELDS.has(key)) {
      payload[key] = value;
    } else if (key === "draft" && request?.renderMode === "draft" && value === true) {
      payload.draft = true;
    } else if (key === "omni_reference_task_type" && request && (
      (["edit", "extend"].includes(request.operation) && value === request.operation)
      || (request.operation === "generate" && request.durationSeconds === -1
        && request.inputs.length > 0 && value === "reference")
    )) {
      payload.omni_reference_task_type = value;
    } else {
      unsupportedControl();
    }
  }
  validateOrdinaryExtensions(payload);
  const content = Array.isArray(payload.content) ? payload.content : [];
  for (const item of content) {
    if (item && typeof item === "object" && item.type === "draft_task") {
      if (request?.renderMode !== "finalize"
        || typeof request.draftSource?.providerTaskId !== "string"
        || item.draft_task?.id !== request.draftSource.providerTaskId) {
        unsupportedControl();
      }
    }
  }
  return payload;
}
