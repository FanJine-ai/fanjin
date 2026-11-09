import crypto from "node:crypto";
import { z } from "zod";
import { redactSensitiveText } from "@/lib/redactSensitiveText";
import type { RelayTask } from "@/lib/relay";

/** Only HTTP adapters may opt into this protocol; JSON cannot supply this symbol. */
export const ARK_VIDEO_PROTOCOL = Symbol("ark-video-v3");
export const ARK_VIDEO_PROTOCOL_VERSION = "ark-video-v3/upstream-url-v1";
const VERSION = ARK_VIDEO_PROTOCOL_VERSION;
const locator = z.object({ url: z.string().min(1) }).strict();
const content = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }).strict(),
  z.object({ type: z.literal("image_url"), image_url: locator,
    role: z.enum(["first_frame", "last_frame", "reference_image"]).optional() }).strict(),
  z.object({ type: z.literal("video_url"), video_url: locator, role: z.literal("reference_video") }).strict(),
  z.object({ type: z.literal("audio_url"), audio_url: locator, role: z.literal("reference_audio") }).strict(),
  z.object({ type: z.literal("draft_task"), draft_task: z.object({ id: z.string().min(1) }).strict() }).strict(),
]);

// Official wire fields only. Never spread HTTP input into Relay's trusted options.
export const arkVideoRequestSchema = z.object({
  model: z.string().trim().min(1), content: z.array(content).min(1),
  resolution: z.enum(["480p", "720p", "1080p", "4k"]).optional(),
  ratio: z.string().optional(), duration: z.number().int().optional(),
  frames: z.number().int().optional(), seed: z.number().int().optional(),
  camera_fixed: z.boolean().optional(), watermark: z.boolean().optional(),
  generate_audio: z.boolean().optional(), return_last_frame: z.boolean().optional(),
  draft: z.boolean().optional(), output_format: z.enum(["mp4", "mov"]).optional(),
  service_tier: z.enum(["default", "flex"]).optional(),
  priority: z.number().int().min(0).max(9).optional(),
  safety_identifier: z.string().max(64).optional(),
  execution_expires_after: z.number().int().min(3600).max(259200).optional(),
  callback_url: z.string().url().optional(),
  omni_reference_task_type: z.enum(["auto", "reference", "edit", "extend"]).optional(),
  tools: z.array(z.object({ type: z.literal("web_search") }).strict()).optional(),
}).strict();

export function arkProtocolError(message: string, status = 400, code = "InvalidParameter") {
  return Object.assign(new Error(message), { status, statusCode: status, code });
}

export function parseArkVideoRequest(value: unknown): Record<string, any> {
  const parsed = arkVideoRequestSchema.safeParse(value);
  if (!parsed.success) throw arkProtocolError(parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; "));
  // References are forwarded, never fetched by Fanjin. Reject local/blob/file
  // locators and embedded URL credentials before storing the dispatch intent.
  for (const part of parsed.data.content) {
    if (!["image_url", "video_url", "audio_url"].includes(part.type)) continue;
    const url = (part as any)[part.type].url as string;
    if (/^asset:\/\/[A-Za-z0-9_-]+$/.test(url)) continue;
    if ((part.type === "image_url" && /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\r\n]+$/.test(url))
      || (part.type === "audio_url" && /^data:audio\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\r\n]+$/.test(url))) continue;
    let parsedUrl: URL;
    try { parsedUrl = new URL(url); } catch { throw arkProtocolError("参考素材必须使用公网 URL、官方支持的 Base64 或 asset:// ID"); }
    if (!["https:", "http:"].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) {
      throw arkProtocolError("参考素材 URL 无效");
    }
  }
  return parsed.data;
}

function object(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function digest(payload: Record<string, unknown>): string {
  const stable = (v: any): any => Array.isArray(v) ? v.map(stable)
    : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v;
  return crypto.createHash("sha256").update(JSON.stringify(stable(payload))).digest("hex");
}

export function arkVideoCheckpoint(payload: Record<string, unknown>) {
  return { version: VERSION, requestDigest: digest(payload), delivery: "upstream_url" };
}

export function isArkVideoTask(task: Pick<RelayTask, "resultPayload">): boolean {
  return object(object(task.resultPayload).internal).arkVideoProtocol?.version === VERSION;
}

export function assertArkVideoCheckpoint(task: RelayTask): void {
  const checkpoint = object(object(task.resultPayload.internal).arkVideoProtocol);
  if (!isArkVideoTask(task) || task.provider !== "volcano" || !task.apiKeyId || !task.workspaceId
    || task.projectId !== null || checkpoint.delivery !== "upstream_url"
    || checkpoint.requestDigest !== digest(task.requestPayload)) {
    throw arkProtocolError("中转请求检查点不一致，已停止派发", 409, "RelayCheckpointConflict");
  }
}

export function arkProviderPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const { callback_secret_ciphertext: _secret, ...body } = payload;
  const parsed = parseArkVideoRequest(body);
  // Our durable callback queue publishes the public task ID and official DTO.
  delete parsed.callback_url;
  return parsed;
}

export function arkVideoPlan(payload: Record<string, unknown>) {
  const resolution = typeof payload.resolution === "string" ? payload.resolution : null;
  return { requestedResolution: resolution, generationResolution: resolution,
    finalResolution: resolution, needsEnhancement: false, upstreamModel: String(payload.model) };
}

const RESPONSE_FIELDS = ["model", "content", "usage", "seed", "resolution", "ratio", "duration", "frames", "safety_identifier",
  "framespersecond", "service_tier", "execution_expires_after", "generate_audio", "draft", "priority",
  "tools", "output_format", "created_at", "updated_at", "error"] as const;
const STATUSES = new Set(["queued", "running", "succeeded", "failed", "cancelled", "expired"]);

/** No delivery projection, asset lookup, URL signing or media persistence. */
export function formatArkVideoTask(task: RelayTask): Record<string, unknown> {
  const upstream = object(task.resultPayload);
  const response: Record<string, unknown> = {};
  for (const key of RESPONSE_FIELDS) if (upstream[key] !== undefined) response[key] = upstream[key];
  if (response.content) {
    const content = object(response.content);
    response.content = Object.fromEntries(["video_url", "last_frame_url"]
      .filter(key => typeof content[key] === "string").map(key => [key, content[key]]));
  }
  if (response.error) {
    const error = object(response.error);
    response.error = { code: redactSensitiveText(error.code || "GenerationFailed"),
      message: redactSensitiveText(error.message || "视频生成失败") };
  }
  const submission = object(object(task.providerPayload).submission);
  const awaitingOutcome = String(submission.state || "").startsWith("pending_reconcile")
    && Boolean(submission.reconcileReason);
  const status = typeof upstream.status === "string" && STATUSES.has(upstream.status)
    ? upstream.status : task.status === "enhancing" ? "running"
    : awaitingOutcome ? "running"
    : STATUSES.has(task.status) ? task.status : "running";
  return {
    ...response, id: task.id, model: response.model ?? task.model,
    status,
    created_at: response.created_at ?? Math.floor(task.createTime / 1000),
    updated_at: response.updated_at ?? Math.floor(task.updateTime / 1000),
    ...(status === "failed" && !response.error ? { error: {
      code: "GenerationFailed", message: redactSensitiveText(task.errorMessage || "视频生成失败"),
    } } : {}),
  };
}

export function hasArkVideoResult(payload: Record<string, unknown>): boolean {
  const url = object(payload.content).video_url;
  try { return typeof url === "string" && ["https:", "http:"].includes(new URL(url).protocol); } catch { return false; }
}
