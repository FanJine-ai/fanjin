import { apiKeyPayload, authPayload, buildInviteLink, clearAuth, readAuth, writeAuth } from "./auth-storage";
import { apiDelete, apiGet, apiPost, readApiSettings } from "@/api/http";
import type { AuthUser, Transaction } from "@/types";
import { uploadReferenceAttachment } from "@/features/quick-create/attachments/api";

const API_BASE_URL = import.meta.env?.VITE_API_BASE_URL || "";

class ApiError extends Error {
  status: number;
  url?: string;
  responseText?: string;
  details?: unknown;

  constructor(message: string, status = 500, extra?: { url?: string; responseText?: string; details?: unknown }) {
    super(message);
    this.status = status;
    this.url = extra?.url;
    this.responseText = extra?.responseText;
    this.details = extra?.details;
  }
}

type DirectUploadSignature = {
  assetId: string;
  key: string;
  type: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  method: string;
  uploadUrl: string;
  publicUrl: string;
  headers: Record<string, string>;
  expiresInSeconds: number;
};

type UploadRequestOptions = {
  signal?: AbortSignal;
  onProgress?: (progress: number) => void;
  projectId?: number;
};

type UploadedMedia = {
  assetId: string;
  assetVersionId?: number;
  url: string;
  fileName: string;
  type: string;
};

export type DeletionOperationDto = {
  id: string;
  kind: "image" | "asset" | "project";
  workspaceId: string;
  projectId: string | number;
  resourceId: string;
  status: "preparing" | "deleting" | "completed" | "blocked";
  errorCode: string | null;
  requestedAt?: number;
  finalizedAt?: number | null;
};

type DeletionOperationResponse = {
  operation: DeletionOperationDto;
};

type VideoEnhanceSource = {
  nodeId?: string;
  sourceAssetId?: string;
  videoUrl: string;
  targetResolution: string;
  attemptId?: string;
};

function compactVideoEnhanceToken(value: unknown, fallback: string, maxLength = 48) {
  const normalized = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (normalized || fallback).slice(0, maxLength);
}

function hashVideoEnhanceSource(value: string) {
  // FNV-1a keeps potentially signed URLs out of the idempotency key while
  // still making a changed source produce a different request identity.
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function createStableVideoAttemptId() {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (randomUuid) return randomUuid;
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function normalizePublicVideoResolution(value: unknown, fallback: string) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === "2160p" || raw === "4k" || raw === "uhd") return "4k";
  if (raw === "2k" || raw === "1440p") return "2k";
  if (raw.includes("1080") || raw === "fhd") return "1080p";
  if (raw.includes("720") || raw === "hd") return "720p";
  return fallback;
}

export function createCanvasImageGenerationAttemptId() {
  return createStableVideoAttemptId();
}

export function resolveCanvasImageGenerationAttemptId(existingAttemptId?: string) {
  const existing = String(existingAttemptId || "").trim();
  return existing || createCanvasImageGenerationAttemptId();
}

export function buildCanvasImageIdempotencyKey(input: {
  nodeId?: string;
  attemptId?: string;
}) {
  const node = compactVideoEnhanceToken(input.nodeId, "request");
  const attempt = compactVideoEnhanceToken(
    input.attemptId || createCanvasImageGenerationAttemptId(),
    "attempt",
    64,
  );
  return `canvas-image:${node}:${attempt}`;
}

export function shouldRetainCanvasImageGenerationAttempt(status?: number | null, code?: string) {
  if (["image_task_upstream_rejected", "image_task_refunded", "image_task_billing_failed", "pricing_confirmation_required", "idempotency_conflict", "idempotency_scope_conflict"].includes(code || "")) return false;
  if (["image_task_pending_reconcile", "image_task_persistence_retryable"].includes(code || "")) return true;
  return status == null || status === 409 || status >= 500;
}

export function createCanvasVideoGenerationAttemptId() {
  return createStableVideoAttemptId();
}

export function resolveCanvasVideoGenerationAttemptId(existingAttemptId?: string) {
  const existing = String(existingAttemptId || "").trim();
  return existing || createCanvasVideoGenerationAttemptId();
}

/** New draw (不满意再抽) must not reuse the previous attempt's idempotency key. */
export function nextCanvasVideoGenerationAttemptId(existingAttemptId?: string, recovering?: boolean) {
  if (recovering && existingAttemptId) return String(existingAttemptId).trim();
  return createCanvasVideoGenerationAttemptId();
}

export function shouldRetainCanvasVideoGenerationAttempt(status?: number | null) {
  // An HTTP response, including 409/5xx, is a confirmed submission result.
  // Keep the idempotency key only when the browser received no response at all.
  return status == null;
}

export function createCanvasComposeAttemptId() {
  return createStableVideoAttemptId();
}

export function resolveCanvasComposeAttemptId(existingAttemptId?: string) {
  const existing = String(existingAttemptId || "").trim();
  return existing || createCanvasComposeAttemptId();
}

export function buildCanvasComposeIdempotencyKey(input: {
  nodeId?: string;
  attemptId?: string;
}) {
  const node = compactVideoEnhanceToken(input.nodeId, "request");
  const attempt = compactVideoEnhanceToken(
    input.attemptId || createCanvasComposeAttemptId(),
    "attempt",
    64,
  );
  return `canvas-compose:${node}:${attempt}`;
}

export function shouldRetainCanvasComposeAttempt(status?: number | null) {
  return status == null || status === 409 || status >= 500;
}

export type CanvasComposeVideoInput = {
  projectId: number;
  ratio: string;
  clips: Array<{
    assetVersionId: number;
    trimStartSeconds: number;
    trimEndSeconds: number;
    speed: number;
    volume: number;
  }>;
};

export type CanvasComposeVideoAsset = {
  id: string;
  taskId: string;
  assetId: number;
  assetVersionId: number;
  url: string;
  width: number;
  height: number;
  durationMs: number;
  createdAt: number;
};

export type CanvasShareRecord = {
  id: string;
  slug: string;
  projectId: number;
  canvasId: number;
  title: string;
  snapshotRevision: number;
  snapshotHash: string;
  status: "active" | "revoked";
  revision: number;
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
  revokedAt: number | null;
};

export type FjtvPublicationRecord = {
  id: string;
  slug: string;
  projectId: number;
  canvasId: number;
  title: string;
  description: string;
  coverUrl: string | null;
  snapshotRevision: number;
  snapshotHash: string;
  status: "pending_review" | "published" | "rejected" | "unpublished";
  revision: number;
  moderationReason?: string | null;
  moderatedAt?: number | null;
  publishedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export function createVideoEnhanceAttemptId() {
  return createStableVideoAttemptId();
}

export function buildVideoEnhanceIdempotencyKey(input: VideoEnhanceSource) {
  const sourceIdentity = input.sourceAssetId
    ? `asset:${String(input.sourceAssetId).trim()}`
    : `url:${String(input.videoUrl || "").trim()}`;
  const sourceFingerprint = hashVideoEnhanceSource(sourceIdentity);
  const node = compactVideoEnhanceToken(input.nodeId, "request");
  const resolution = compactVideoEnhanceToken(input.targetResolution, "target", 16).toLowerCase();
  const attempt = compactVideoEnhanceToken(input.attemptId || createVideoEnhanceAttemptId(), "attempt", 64);
  return `canvas-enhance:${node}:${sourceFingerprint}:${resolution}:${attempt}`;
}

export type AiModelCapabilities = Record<string, unknown> & {
  status?: string;
  canSubmit?: boolean;
  unavailableReason?: string | null;
  resolutions?: string[];
  defaultResolution?: string;
  qualities?: string[];
  defaultQuality?: string;
  maxOutputs?: number;
  aspectRatios?: string[];
  defaultAspectRatio?: string;
  parameters?: Record<string, unknown>;
};

export type AiModelOption = {
  id: string;
  name: string;
  type: "image" | "video" | "text" | "audio" | string;
  platform?: string;
  price?: number;
  async?: boolean;
  description?: string;
  /** 后台映射的用户可见名；展示时优先于 name */
  displayName?: string;
  /** 超分/增强组合场景下的用户可见名 */
  enhanceDisplayName?: string;
  /** 后台配置的默认模型标记 */
  isDefault?: boolean;
  capabilities?: AiModelCapabilities;
  capabilityStatus?: string;
  unavailableReason?: string;
};

type CanvasModelOptionsResponse = {
  models?: unknown[];
  videoModels?: unknown[];
  imageModels?: unknown[];
};

function modelRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function firstModelString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function normalizeCanvasModelType(value: unknown, fallback?: "image" | "video") {
  const normalized = String(value || fallback || "").trim().toLowerCase();
  if (["image", "images", "image_generation", "image-generation"].includes(normalized)) return "image";
  if (["video", "videos", "video_generation", "video-generation"].includes(normalized)) return "video";
  if (["text", "chat", "responses", "completion", "completions", "llm"].includes(normalized)) return "text";
  if (["audio", "tts", "speech", "transcription"].includes(normalized)) return "audio";
  return fallback || normalized;
}

function normalizeCanvasCapabilities(rawModel: Record<string, unknown>): AiModelCapabilities | undefined {
  const capabilities = modelRecord(rawModel.capabilities);
  const promotedKeys = [
    "resolutions",
    "defaultResolution",
    "qualities",
    "defaultQuality",
    "maxOutputs",
    "aspectRatios",
    "defaultAspectRatio",
    "duration",
    "supportsGenerateAudio",
    "modes",
    "inputSlots",
    "videoGeneration",
    "parameters",
  ] as const;
  const promoted = Object.fromEntries(
    promotedKeys.flatMap((key) => (rawModel[key] === undefined ? [] : [[key, rawModel[key]]])),
  );
  const normalized = { ...promoted, ...capabilities };
  return Object.keys(normalized).length ? normalized : undefined;
}

function normalizeCanvasModelOption(
  value: unknown,
  fallbackType?: "image" | "video",
): AiModelOption | null {
  const rawModel = modelRecord(value);
  const id = firstModelString(rawModel.id, rawModel.model, rawModel.modelId);
  const typeCandidates = [rawModel.endpointType, rawModel.type, rawModel.category]
    .map((candidate) => normalizeCanvasModelType(candidate))
    .filter(Boolean);
  const type = typeCandidates.find((candidate) => ["image", "video", "text", "audio"].includes(candidate))
    || normalizeCanvasModelType(typeCandidates[0], fallbackType);
  if (!id || !type) return null;

  const capabilities = normalizeCanvasCapabilities(rawModel);
  const explicitlyUnavailable = rawModel.disabled === true || rawModel.available === false;
  const capabilityStatus = explicitlyUnavailable
    ? "unavailable"
    : firstModelString(rawModel.capabilityStatus, capabilities?.status) || "unverified";
  const rawPrice = rawModel.price ?? rawModel.points;
  const price = typeof rawPrice === "number" ? rawPrice : Number(rawPrice);
  const unavailableReason = firstModelString(
    rawModel.unavailableReason,
    rawModel.unsupportedReason,
    capabilities?.unavailableReason,
  );

  return {
    id,
    name: firstModelString(rawModel.name, rawModel.label, rawModel.displayName, id),
    type,
    ...(firstModelString(rawModel.platform, rawModel.provider, rawModel.providerType, rawModel.vendor)
      ? { platform: firstModelString(rawModel.platform, rawModel.provider, rawModel.providerType, rawModel.vendor) }
      : {}),
    ...(Number.isFinite(price) ? { price } : {}),
    ...(typeof rawModel.async === "boolean" ? { async: rawModel.async } : {}),
    ...(firstModelString(rawModel.description, rawModel.desc) ? { description: firstModelString(rawModel.description, rawModel.desc) } : {}),
    ...(firstModelString(rawModel.displayName) ? { displayName: firstModelString(rawModel.displayName) } : {}),
    ...(firstModelString(rawModel.enhanceDisplayName) ? { enhanceDisplayName: firstModelString(rawModel.enhanceDisplayName) } : {}),
    ...(rawModel.isDefault === true ? { isDefault: true } : {}),
    ...(capabilities ? { capabilities } : {}),
    ...(capabilityStatus ? { capabilityStatus } : {}),
    ...(unavailableReason ? { unavailableReason } : {}),
  };
}

function mergeCanvasModelOption(previous: AiModelOption, next: AiModelOption): AiModelOption {
  return {
    ...previous,
    ...next,
    platform: next.platform || previous.platform,
    description: next.description || previous.description,
    capabilities:
      previous.capabilities || next.capabilities
        ? { ...(previous.capabilities || {}), ...(next.capabilities || {}) }
        : undefined,
    capabilityStatus: next.capabilityStatus || previous.capabilityStatus,
    unavailableReason: next.unavailableReason || previous.unavailableReason,
    displayName: next.displayName || previous.displayName,
    enhanceDisplayName: next.enhanceDisplayName || previous.enhanceDisplayName,
    isDefault: next.isDefault ?? previous.isDefault,
  };
}

export function normalizeCanvasModelOptions(
  response: unknown,
): AiModelOption[] {
  const body = Array.isArray(response) ? { models: response } : modelRecord(response);
  const sources: Array<{ values: unknown; fallbackType?: "image" | "video" }> = [
    { values: body.models },
    { values: body.imageModels, fallbackType: "image" },
    { values: body.videoModels, fallbackType: "video" },
  ];
  const models = new Map<string, AiModelOption>();
  for (const source of sources) {
    if (!Array.isArray(source.values)) continue;
    for (const value of source.values) {
      const model = normalizeCanvasModelOption(value, source.fallbackType);
      if (!model) continue;
      const key = `${model.type}:${model.id}`;
      const previous = models.get(key);
      models.set(key, previous ? mergeCanvasModelOption(previous, model) : model);
    }
  }
  return Array.from(models.values());
}

function resolveApiUrl(path: string) {
  if (API_BASE_URL) return `${API_BASE_URL.replace(/\/+$/, "")}${path}`;
  const apiBase = readApiSettings().baseUrl.replace(/\/+$/, "");
  const originBase = apiBase.endsWith("/api") ? apiBase.slice(0, -4) : apiBase;
  return `${originBase}${path}`;
}

function shouldResetAuth(status: number, message: string) {
  if (status !== 401 && status !== 404) return false;
  return /invalid user credentials|missing apiKey|user not found/i.test(message);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const url = resolveApiUrl(path);
  const platformToken = readApiSettings().token;
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...(platformToken ? { Authorization: platformToken } : {}),
      ...(init.headers || {}),
    },
  });
  const responseText = await response.text();
  let data: any = {};
  try {
    data = responseText ? JSON.parse(responseText) : {};
  } catch {
    data = {};
  }
  if (!response.ok || data.success === false) {
    const message = data.message || data.error || `请求失败 ${response.status}`;
    if (shouldResetAuth(response.status, String(message))) {
      clearAuth();
    }
    throw new ApiError(message, response.status, { url, responseText, details: data });
  }
  return (data.data ?? data) as T;
}

async function requestBlob(path: string): Promise<{ blob: Blob; contentType: string }> {
  const platformToken = readApiSettings().token;
  const response = await fetch(resolveApiUrl(path), {
    headers: platformToken ? { Authorization: platformToken } : undefined,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ApiError(body?.message || `下载失败：${response.status}`, response.status);
  }
  return {
    blob: await response.blob(),
    contentType: response.headers.get("content-type") || "application/octet-stream",
  };
}

function post<T>(path: string, body: unknown, init: RequestInit = {}) {
  return request<T>(path, { ...init, method: "POST", body: JSON.stringify(body) });
}

function assertDeletionOperation(
  value: unknown,
  expectedKind?: DeletionOperationDto["kind"],
): DeletionOperationDto {
  const operation = value as Partial<DeletionOperationDto> | null;
  if (
    !operation
    || typeof operation.id !== "string"
    || !operation.id
    || !["image", "asset", "project"].includes(String(operation.kind))
    || (expectedKind && operation.kind !== expectedKind)
    || !["preparing", "deleting", "completed", "blocked"].includes(
      String(operation.status),
    )
  ) {
    throw new ApiError("删除服务返回了无效的 operation", 502, {
      details: value,
    });
  }
  return operation as DeletionOperationDto;
}

function deletionBlockedMessage(operation: DeletionOperationDto): string {
  const code = operation.errorCode || "DELETION_REMEDIATION_REQUIRED";
  return `项目删除需要人工处理（${code}）`;
}

async function requestWithTimeout<T>(
  path: string,
  init: RequestInit,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await request<T>(path, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ApiError(timeoutMessage, 408, { details: { path, timeoutMs } });
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timeoutId);
  }
}

async function requestProjectDeletionOperation(
  projectId: string,
): Promise<DeletionOperationDto> {
  const response = await requestWithTimeout<DeletionOperationResponse>(
    `/api/projects/${encodeURIComponent(projectId)}`,
    { method: "DELETE" },
    15_000,
    "项目删除请求超时，请重试",
  );
  const operation = assertDeletionOperation(response.operation, "project");
  if (operation.status === "blocked") {
    throw new ApiError(deletionBlockedMessage(operation), 409, {
      details: { operation },
    });
  }
  return operation;
}

async function waitForProjectDeletion(
  initial: DeletionOperationDto,
  timeoutMs = 30_000,
): Promise<DeletionOperationDto> {
  let operation = initial;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (operation.status === "completed") return operation;
    if (operation.status === "blocked") {
      throw new ApiError(deletionBlockedMessage(operation), 409, {
        details: { operation },
      });
    }
    if (Date.now() >= deadline) {
      throw new ApiError(
        "项目删除请求已受理，仍在后台处理中；请稍后重试以查看状态",
        202,
        { details: { operation } },
      );
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 1_000));
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) continue;
    try {
      const response = await requestWithTimeout<DeletionOperationResponse>(
        `/api/deletion/operations/${encodeURIComponent(operation.id)}`,
        {},
        Math.max(1, Math.min(5_000, remainingMs)),
        "项目删除状态读取超时",
      );
      operation = assertDeletionOperation(response.operation, "project");
    } catch (error) {
      if (error instanceof ApiError && error.status === 408) continue;
      throw error;
    }
  }
}

type LocalProject = {
  projectId: string;
  name: string;
  coverImageUrl: string;
  createdAt: string;
  updatedAt: string;
};

type LocalCanvas = {
  canvasId: string;
  projectId: string;
  revision: number;
  name: string;
  coverImageUrl: string;
  createdAt: string;
  updatedAt: string;
  nodes: any[];
  edges: any[];
  connections: any[];
  groups: any[];
};

type LocalProjectFolder = {
  id: string;
  name: string;
  projectIds: string[];
  createdAt: string;
  updatedAt: string;
};

type LocalCanvasAsset = {
  id: string;
  userId: string;
  projectId?: number;
  name: string;
  saveLocation: string;
  tag: string;
  coverUrl: string;
  assetType?: "snapshot" | "portrait";
  referenceAssetUri?: string;
  createdAt: string;
  updatedAt: string;
  snapshot: { nodes: any[]; edges: any[]; bounds: any; meta?: any };
};

type LocalCanvasWorkflow = {
  id: string;
  userId: string;
  name: string;
  coverUrl: string;
  coverNodeId?: string;
  note?: string;
  groupSnapshot: { nodes: any[]; edges: any[]; layoutMode: string; themeColor: string; bounds: any };
  createdAt: string;
  updatedAt: string;
};

const LOCAL_PROJECTS_KEY = "fanjin_fjtv_local_projects";
const LOCAL_CANVASES_KEY = "fanjin_fjtv_local_canvases";
const LOCAL_FOLDERS_KEY = "fanjin_fjtv_local_folders";
const LOCAL_ASSETS_KEY = "fanjin_fjtv_local_assets";
const LOCAL_WORKFLOWS_KEY = "fanjin_fjtv_local_workflows";

function hasRemoteAuth() {
  const auth = readAuth();
  return Boolean(readApiSettings().token || (auth?.userId && auth?.apiKey));
}

function localNow() {
  return new Date().toISOString();
}

function localId(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
}

function positiveLocalCanvasRevision(value: unknown) {
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision > 0 ? revision : 1;
}

function readLocalJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeLocalJson<T>(key: string, value: T) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Local persistence is best-effort; the canvas should keep running in memory.
  }
}

function cloneLocal<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function localProjects() {
  return readLocalJson<LocalProject[]>(LOCAL_PROJECTS_KEY, []);
}

function localCanvases() {
  return readLocalJson<LocalCanvas[]>(LOCAL_CANVASES_KEY, []);
}

function localProjectFolders() {
  return readLocalJson<LocalProjectFolder[]>(LOCAL_FOLDERS_KEY, []);
}

function touchLocalProject(projectId: string, patch: Partial<LocalProject> = {}) {
  const now = localNow();
  const projects = localProjects();
  const nextProjects = projects.map((project) => (project.projectId === projectId ? { ...project, ...patch, updatedAt: now } : project));
  writeLocalJson(LOCAL_PROJECTS_KEY, nextProjects);
}

function ensureLocalProject(name = "未命名项目") {
  const projects = localProjects();
  if (projects[0]) return projects[0];
  const created = localCreateProject(name);
  return localProjects().find((project) => project.projectId === created.projectId)!;
}

function localCreateProject(name = "未命名项目") {
  const now = localNow();
  const projectId = localId("project");
  const defaultCanvasId = localId("canvas");
  const project: LocalProject = {
    projectId,
    name,
    coverImageUrl: "",
    createdAt: now,
    updatedAt: now,
  };
  const defaultCanvas: LocalCanvas = {
    canvasId: defaultCanvasId,
    projectId,
    revision: 1,
    name: "画布 1",
    coverImageUrl: "",
    createdAt: now,
    updatedAt: now,
    nodes: [],
    edges: [],
    connections: [],
    groups: [],
  };
  writeLocalJson(LOCAL_PROJECTS_KEY, [project, ...localProjects()]);
  writeLocalJson(LOCAL_CANVASES_KEY, [defaultCanvas, ...localCanvases()]);
  return { projectId, defaultCanvasId };
}

function ensureLocalProjectById(projectId: string) {
  const existing = localProjects().find((project) => project.projectId === projectId);
  if (existing) return existing;
  const now = localNow();
  const project: LocalProject = {
    projectId,
    name: "未命名项目",
    coverImageUrl: "",
    createdAt: now,
    updatedAt: now,
  };
  writeLocalJson(LOCAL_PROJECTS_KEY, [project, ...localProjects()]);
  return project;
}

function localCreateCanvas(name = "未命名画布", projectId?: string) {
  const ownerProjectId = projectId || ensureLocalProject().projectId;
  ensureLocalProjectById(ownerProjectId);
  const now = localNow();
  const canvas: LocalCanvas = {
    canvasId: localId("canvas"),
    projectId: ownerProjectId,
    revision: 1,
    name,
    coverImageUrl: "",
    createdAt: now,
    updatedAt: now,
    nodes: [],
    edges: [],
    connections: [],
    groups: [],
  };
  writeLocalJson(LOCAL_CANVASES_KEY, [canvas, ...localCanvases()]);
  touchLocalProject(ownerProjectId);
  return { canvasId: canvas.canvasId, revision: canvas.revision };
}

function normalizeLocalCanvas(canvas: LocalCanvas) {
  const edges = Array.isArray(canvas.edges) ? canvas.edges : Array.isArray(canvas.connections) ? canvas.connections : [];
  return {
    ...canvas,
    revision: positiveLocalCanvasRevision(canvas.revision),
    edges,
    connections: Array.isArray(canvas.connections) ? canvas.connections : edges,
    nodes: Array.isArray(canvas.nodes) ? canvas.nodes : [],
    groups: Array.isArray(canvas.groups) ? canvas.groups : [],
  };
}

function localLoadCanvas(canvasId: string) {
  const canvases = localCanvases();
  const existing = canvases.find((canvas) => canvas.canvasId === canvasId);
  if (existing) return cloneLocal(normalizeLocalCanvas(existing));

  const project = ensureLocalProject("未命名项目");
  const now = localNow();
  const canvas: LocalCanvas = {
    canvasId,
    projectId: project.projectId,
    revision: 1,
    name: "未命名项目",
    coverImageUrl: "",
    createdAt: now,
    updatedAt: now,
    nodes: [],
    edges: [],
    connections: [],
    groups: [],
  };
  writeLocalJson(LOCAL_CANVASES_KEY, [canvas, ...canvases]);
  touchLocalProject(project.projectId);
  return cloneLocal(normalizeLocalCanvas(canvas));
}

function localSaveCanvas(payload: any) {
  const canvasId = String(payload?.canvasId || localId("canvas"));
  const canvases = localCanvases();
  const existing = canvases.find((canvas) => canvas.canvasId === canvasId);
  const ownerProjectId = String(payload?.projectId || existing?.projectId || ensureLocalProject().projectId);
  ensureLocalProjectById(ownerProjectId);
  const currentRevision = positiveLocalCanvasRevision(existing?.revision);
  const expectedRevision = payload?.expectedRevision == null ? null : Number(payload.expectedRevision);
  if (
    expectedRevision !== null
    && (!Number.isSafeInteger(expectedRevision) || expectedRevision <= 0 || expectedRevision !== currentRevision)
  ) {
    throw new ApiError("画布已被其他请求更新，请重新加载后再保存", 409, {
      details: {
        code: 409,
        data: { expectedRevision, currentRevision },
      },
    });
  }

  const now = localNow();
  const nextEdges = Array.isArray(payload?.edges)
    ? payload.edges
    : Array.isArray(payload?.connections)
      ? payload.connections
      : existing?.edges || [];
  const nextCanvas: LocalCanvas = {
    canvasId,
    projectId: ownerProjectId,
    revision: existing ? currentRevision + 1 : 1,
    name: String(payload?.name || payload?.canvasName || existing?.name || "未命名画布"),
    coverImageUrl: String(payload?.coverImageUrl || payload?.coverUrl || existing?.coverImageUrl || ""),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    nodes: Array.isArray(payload?.nodes) ? payload.nodes : existing?.nodes || [],
    edges: nextEdges,
    connections: Array.isArray(payload?.connections) ? payload.connections : nextEdges,
    groups: Array.isArray(payload?.groups) ? payload.groups : existing?.groups || [],
  };
  writeLocalJson(LOCAL_CANVASES_KEY, [nextCanvas, ...canvases.filter((canvas) => canvas.canvasId !== canvasId)]);
  touchLocalProject(ownerProjectId, nextCanvas.coverImageUrl ? { coverImageUrl: nextCanvas.coverImageUrl } : {});
  return { canvasId, revision: nextCanvas.revision };
}

async function remoteOrLocal<T>(
  remote: () => Promise<T>,
  local: () => T | Promise<T>,
  options: { authenticatedFallback?: boolean } = {},
): Promise<T> {
  if (!hasRemoteAuth()) return local();
  try {
    return await remote();
  } catch (error) {
    // An authenticated request targets the server as the source of truth.
    // Falling back after a server/network failure would fabricate successful
    // local_* records that the user's workspace does not actually contain.
    // Authenticated fallback is therefore opt-in; unauthenticated local mode
    // remains available above for the explicitly local experience.
    if (options.authenticatedFallback !== true) throw error;
    return local();
  }
}

function requireCanvasAssetProjectId(value: unknown) {
  const projectId = Number(value);
  if (!Number.isSafeInteger(projectId) || projectId <= 0) {
    throw new ApiError("无效的项目 ID，无法访问看板资产", 400);
  }
  return projectId;
}

function parseJsonSafely(text: string) {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

function uploadViaXhr<T>(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body: Document | XMLHttpRequestBodyInit | null;
    signal?: AbortSignal;
    onProgress?: (progress: number) => void;
    parseApiEnvelope?: boolean;
  },
): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const method = options.method || "POST";
    let aborted = false;
    let detachAbort: (() => void) | null = null;

    xhr.open(method, url, true);

    Object.entries(options.headers || {}).forEach(([key, value]) => {
      if (typeof value === "string" && value.length > 0) {
        xhr.setRequestHeader(key, value);
      }
    });

    xhr.upload.onprogress = (event) => {
      if (!options.onProgress || !event.lengthComputable || event.total <= 0) return;
      options.onProgress(Math.round((event.loaded / event.total) * 100));
    };

    const cleanup = () => {
      if (detachAbort) {
        detachAbort();
        detachAbort = null;
      }
    };

    xhr.onload = () => {
      cleanup();
      const responseText = xhr.responseText || "";
      const data = parseJsonSafely(responseText);
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new ApiError(`请求失败 ${xhr.status}`, xhr.status, { url, responseText, details: data }));
        return;
      }
      options.onProgress?.(100);
      if (!options.parseApiEnvelope) {
        resolve((data || responseText) as T);
        return;
      }
      if (data.success === false) {
        const message = data.message || data.error || `请求失败 ${xhr.status}`;
        reject(new ApiError(message, xhr.status, { url, responseText, details: data }));
        return;
      }
      resolve((data.data ?? data) as T);
    };

    xhr.onerror = () => {
      cleanup();
      reject(new ApiError("网络请求失败", xhr.status || 500, { url, responseText: xhr.responseText || "" }));
    };

    xhr.onabort = () => {
      cleanup();
      aborted = true;
      reject(new ApiError("上传已取消", 499, { url }));
    };

    if (options.signal) {
      if (options.signal.aborted) {
        xhr.abort();
        return;
      }
      const abortHandler = () => {
        if (!aborted) xhr.abort();
      };
      options.signal.addEventListener("abort", abortHandler, { once: true });
      detachAbort = () => options.signal?.removeEventListener("abort", abortHandler);
    }

    xhr.send(options.body);
  });
}

export const api = {
  sendCode(phone: string) {
    return post<{ devCode?: string }>("/api/user/sendCode", { phone });
  },

  async verifyCode(phone: string, code: string, inviteCode?: string) {
    const result = await post<{ userId: string; isNewUser: boolean; user: any }>("/api/user/verifyCode", {
      phone,
      code,
      inviteCode,
    });
    const user = result.user || {};
    const auth: AuthUser = {
      isLoggedIn: true,
      userId: user.id || result.userId,
      apiKey: user.apiKey || "",
      phone: user.phone || phone,
      points: Number(user.points ?? user.grains ?? 0),
      grains: Number(user.grains ?? user.points ?? 0),
      nickname: user.nickname || `用户_${phone.slice(0, 6)}`,
      inviteCode: user.inviteCode || "",
      inviteLink: buildInviteLink(user.inviteCode),
      loginTime: new Date().toISOString(),
    };
    writeAuth(auth);
    try {
      const refreshed = await request<{ user: any }>(
        "/api/user/info",
      );
      const nextUser = refreshed.user || {};
      const next: AuthUser = {
        ...auth,
        apiKey: nextUser.apiKey || auth.apiKey,
        phone: nextUser.phone || auth.phone,
        points: Number(nextUser.points ?? nextUser.grains ?? auth.points),
        grains: Number(nextUser.grains ?? nextUser.points ?? auth.grains),
        nickname: nextUser.nickname || auth.nickname,
        avatarUrl: nextUser.avatarUrl || auth.avatarUrl,
        inviteCode: nextUser.inviteCode || auth.inviteCode,
        inviteLink: buildInviteLink(nextUser.inviteCode || auth.inviteCode),
      };
      writeAuth(next);
      return next;
    } catch {
      return auth;
    }
  },

  async refreshUser() {
    const auth = readAuth();
    if (!auth) return null;
    const result = await request<{ user: any }>(
      "/api/user/info",
    );
    const user = result.user || {};
    const next: AuthUser = {
      ...auth,
      apiKey: user.apiKey || auth.apiKey,
      phone: user.phone || auth.phone,
      points: Number(user.points ?? user.grains ?? auth.points),
      grains: Number(user.grains ?? user.points ?? auth.grains),
      avatarUrl: user.avatarUrl || auth.avatarUrl,
      inviteCode: user.inviteCode || auth.inviteCode,
      inviteLink: buildInviteLink(user.inviteCode || auth.inviteCode),
    };
    writeAuth(next);
    return next;
  },

  resetApiKey() {
    return post<{ apiKey: string }>("/api/user/reset-apikey", authPayload());
  },

  transactions() {
    return request<{ transactions: Transaction[] }>(
      "/api/user/transactions?limit=50",
    );
  },

  createPayment(amount: number) {
    return post<{ orderId: string; wechatParams: { codeUrl: string }; qrImage?: string; points: number }>(
      "/api/payment/create",
      { ...authPayload(), amount, payType: "native" },
    );
  },

  createVipPayment(payload: { memberType: "creator" | "team"; billing: "year" | "month"; planName: string }) {
    return post<{ orderId: string; amount: number; description: string; wechatParams: { codeUrl: string }; qrImage?: string }>(
      "/api/payment/vip/create",
      { ...authPayload(), ...payload, payType: "native" },
    );
  },

  queryPayment(orderId: string) {
    return request<{ order: any }>(`/api/payment/query?orderId=${encodeURIComponent(orderId)}`);
  },

  async models(): Promise<{ models: AiModelOption[] }> {
    const response = await apiGet<CanvasModelOptionsResponse>("/workbench/create/modelOptions");
    return { models: normalizeCanvasModelOptions(response) };
  },

  /**
   * 后台模型目录（Worker A 契约）：
   * GET /api/workbench/models/catalog?type=video|image|text|audio
   * 返回原始响应，由调用方（modelCatalog.ts）按契约归一化。
   */
  async modelsCatalog(type?: "video" | "image" | "text" | "audio" | string): Promise<unknown> {
    const query = type ? `?type=${encodeURIComponent(type)}` : "";
    return request<unknown>(`/api/workbench/models/catalog${query}`);
  },

  /** Server-owned action directory; model-specific offers stay in modelsCatalog. */
  async canvasCapabilities(): Promise<unknown> {
    return request<unknown>("/api/workbench/capabilities");
  },

  listCanvasShares(projectId: number, canvasId: number) {
    return request<{ shares: CanvasShareRecord[] }>(
      `/api/canvas/publication/shares?projectId=${encodeURIComponent(String(projectId))}&canvasId=${encodeURIComponent(String(canvasId))}`,
    );
  },

  createCanvasShare(payload: {
    projectId: number;
    canvasId: number;
    expectedRevision: number;
    idempotencyKey: string;
    title?: string;
    expiresAt?: number | null;
  }) {
    return post<{ share: CanvasShareRecord }>("/api/canvas/publication/shares", payload);
  },

  revokeCanvasShare(projectId: number, shareId: string, expectedRevision: number) {
    return request<{ share: CanvasShareRecord }>(
      `/api/canvas/publication/shares/${encodeURIComponent(shareId)}?projectId=${encodeURIComponent(String(projectId))}&expectedRevision=${encodeURIComponent(String(expectedRevision))}`,
      { method: "DELETE" },
    );
  },

  listCanvasFjtvSubmissions(projectId: number, canvasId: number) {
    return request<{ publications: FjtvPublicationRecord[] }>(
      `/api/canvas/publication/fjtv?projectId=${encodeURIComponent(String(projectId))}&canvasId=${encodeURIComponent(String(canvasId))}`,
    );
  },

  submitCanvasToFjtv(payload: {
    projectId: number;
    canvasId: number;
    expectedRevision: number;
    idempotencyKey: string;
    title?: string;
    description?: string;
    coverUrl?: string | null;
  }) {
    return post<{ publication: FjtvPublicationRecord }>("/api/canvas/publication/fjtv", payload);
  },

  getPublicCanvasShare(slug: string) {
    return request<{ share: CanvasShareRecord & { snapshot: any } }>(
      `/api/public/canvas/shares/${encodeURIComponent(slug)}`,
      { cache: "no-store" },
    );
  },

  listPublicFjtv(limit = 24) {
    return request<{ publications: FjtvPublicationRecord[] }>(
      `/api/public/canvas/fjtv?limit=${encodeURIComponent(String(limit))}`,
      { cache: "no-store" },
    );
  },

  getPublicFjtvPublication(slug: string) {
    return request<{ publication: FjtvPublicationRecord & { snapshot: any } }>(
      `/api/public/canvas/fjtv/${encodeURIComponent(slug)}`,
      { cache: "no-store" },
    );
  },

  createCanvas(name = "未命名画布", projectId?: string) {
    return remoteOrLocal(
      () => {
        if (projectId) {
          return post<{ canvasId: string; revision: number }>(`/api/projects/${projectId}/canvases`, { ...authPayload(), name });
        }
        return post<{ canvasId: string; revision?: number }>("/api/canvas/create", { ...authPayload(), name });
      },
      () => localCreateCanvas(name, projectId),
      { authenticatedFallback: false },
    );
  },

  listProjects() {
    return remoteOrLocal(
      () =>
        request<{ projects: Array<{ projectId: string; name: string; intro?: string; type?: string; coverImageUrl: string; createdAt: string; updatedAt: string; correlationDigest?: string | null }> }>(
          "/api/projects",
        ),
      () => ({ projects: cloneLocal(localProjects()) }),
      { authenticatedFallback: false },
    );
  },

  createProject(name = "未命名项目") {
    return remoteOrLocal(
      () => post<{
        projectId: string;
        defaultCanvasId: string;
        defaultSessionId?: string;
        defaultThreadId?: string;
      }>("/api/projects", { ...authPayload(), name }),
      () => localCreateProject(name),
      { authenticatedFallback: false },
    );
  },

  listProjectFolders() {
    return remoteOrLocal(
      () =>
        request<{ folders: Array<{ id: string; name: string; projectIds: string[]; createdAt: string; updatedAt: string }> }>(
          "/api/project-folders",
        ),
      () => ({ folders: cloneLocal(localProjectFolders()) }),
    );
  },

  createProjectFolder(payload?: { name?: string; projectIds?: string[] }) {
    return remoteOrLocal(
      () =>
        post<{ folder: { id: string; name: string; projectIds: string[]; createdAt: string; updatedAt: string } }>("/api/project-folders", {
          ...authPayload(),
          ...(payload || {}),
        }),
      () => {
        const now = localNow();
        const folder: LocalProjectFolder = {
          id: localId("folder"),
          name: payload?.name || "未命名文件夹",
          projectIds: Array.isArray(payload?.projectIds) ? payload!.projectIds! : [],
          createdAt: now,
          updatedAt: now,
        };
        writeLocalJson(LOCAL_FOLDERS_KEY, [folder, ...localProjectFolders()]);
        return { folder: cloneLocal(folder) };
      },
    );
  },

  updateProjectFolder(folderId: string, payload: { name?: string; projectIds?: string[] }) {
    return remoteOrLocal(
      () =>
        request<{ folder: { id: string; name: string; projectIds: string[]; createdAt: string; updatedAt: string } }>(`/api/project-folders/${folderId}`, {
          method: "PATCH",
          body: JSON.stringify({ ...authPayload(), ...payload }),
        }),
      () => {
        const now = localNow();
        const folders = localProjectFolders();
        const existing = folders.find((folder) => folder.id === folderId);
        const folder: LocalProjectFolder = {
          id: folderId,
          name: payload.name || existing?.name || "未命名文件夹",
          projectIds: Array.isArray(payload.projectIds) ? payload.projectIds : existing?.projectIds || [],
          createdAt: existing?.createdAt || now,
          updatedAt: now,
        };
        writeLocalJson(LOCAL_FOLDERS_KEY, [folder, ...folders.filter((item) => item.id !== folderId)]);
        return { folder: cloneLocal(folder) };
      },
    );
  },

  deleteProjectFolder(folderId: string) {
    return remoteOrLocal(
      () =>
        request<{ success: boolean }>(
          `/api/project-folders/${encodeURIComponent(folderId)}`,
          { method: "DELETE" },
        ),
      () => {
        writeLocalJson(LOCAL_FOLDERS_KEY, localProjectFolders().filter((folder) => folder.id !== folderId));
        return { success: true };
      },
    );
  },

  updateProject(projectId: string, payload: { name?: string; coverImageUrl?: string }) {
    return remoteOrLocal(
      () => request<{ success: boolean }>(`/api/projects/${projectId}`, { method: "PATCH", body: JSON.stringify({ ...authPayload(), ...payload }) }),
      () => {
        ensureLocalProjectById(projectId);
        touchLocalProject(projectId, payload);
        return { success: true };
      },
      { authenticatedFallback: false },
    );
  },

  renameProject(projectId: string, name: string) {
    return this.updateProject(projectId, { name });
  },

  requestProjectDeletion(projectId: string) {
    return remoteOrLocal(
      () => requestProjectDeletionOperation(projectId),
      () => {
        writeLocalJson(LOCAL_PROJECTS_KEY, localProjects().filter((project) => project.projectId !== projectId));
        writeLocalJson(LOCAL_CANVASES_KEY, localCanvases().filter((canvas) => canvas.projectId !== projectId));
        writeLocalJson(
          LOCAL_FOLDERS_KEY,
          localProjectFolders().map((folder) => ({ ...folder, projectIds: folder.projectIds.filter((id) => id !== projectId), updatedAt: localNow() })),
        );
        return {
          id: `local-project-delete-${projectId}-${Date.now()}`,
          kind: "project" as const,
          workspaceId: "local",
          projectId,
          resourceId: projectId,
          status: "completed" as const,
          errorCode: null,
          finalizedAt: Date.now(),
        };
      },
      { authenticatedFallback: false },
    );
  },

  waitForProjectDeletion(operation: DeletionOperationDto, timeoutMs = 30_000) {
    return waitForProjectDeletion(
      assertDeletionOperation(operation, "project"),
      timeoutMs,
    );
  },

  async deleteProject(projectId: string) {
    const operation = await this.requestProjectDeletion(projectId);
    return this.waitForProjectDeletion(operation);
  },

  async getDeletionOperation(operationId: string) {
    const response = await request<DeletionOperationResponse>(
      `/api/deletion/operations/${encodeURIComponent(operationId)}`,
    );
    return assertDeletionOperation(response.operation);
  },

  getProjectCanvases(projectId: string) {
    return remoteOrLocal(
      () =>
        request<{ canvases: Array<{ canvasId: string; revision: number; name: string; coverImageUrl: string; createdAt: string; updatedAt: string }> }>(
          `/api/projects/${projectId}/canvases`,
        ),
      () => ({ canvases: cloneLocal(localCanvases().filter((canvas) => canvas.projectId === projectId).map(normalizeLocalCanvas)) }),
      { authenticatedFallback: false },
    );
  },

  renameProjectCanvas(projectId: string, canvasId: string, name: string, expectedRevision?: number) {
    return remoteOrLocal(
      () =>
        request<{ success: boolean; canvasId: string; revision: number }>(`/api/projects/${projectId}/canvases/${canvasId}`, {
          method: "PATCH",
          body: JSON.stringify({ ...authPayload(), name, expectedRevision }),
        }),
      () => {
        const now = localNow();
        const canvases = localCanvases();
        const current = canvases.find((canvas) => canvas.canvasId === canvasId && canvas.projectId === projectId);
        if (!current) throw new ApiError("画布不存在", 404);
        const currentRevision = positiveLocalCanvasRevision(current.revision);
        if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
          throw new ApiError("画布已被其他请求更新，请重新加载后再重命名", 409, {
            details: {
              code: 409,
              data: { expectedRevision, currentRevision },
            },
          });
        }
        const revision = currentRevision + 1;
        const nextCanvases = canvases.map((canvas) => (
          canvas.canvasId === canvasId
            ? { ...canvas, projectId, name, revision, updatedAt: now }
            : canvas
        ));
        writeLocalJson(LOCAL_CANVASES_KEY, nextCanvases);
        touchLocalProject(projectId);
        return { success: true, canvasId, revision };
      },
      { authenticatedFallback: false },
    );
  },

  loadCanvas(canvasId: string) {
    return remoteOrLocal(
      () =>
        request<any>(
          `/api/canvas/load?canvasId=${encodeURIComponent(canvasId)}`,
        ),
      () => localLoadCanvas(canvasId),
      { authenticatedFallback: false },
    );
  },

  listCanvas() {
    return remoteOrLocal(
      () =>
        request<Array<{ id: string; name: string; coverImageUrl: string; createdAt: string; updatedAt: string }>>(
          "/api/canvas/list",
        ),
      () =>
        localCanvases().map((canvas) => ({
          id: canvas.canvasId,
          name: canvas.name,
          coverImageUrl: canvas.coverImageUrl,
          createdAt: canvas.createdAt,
          updatedAt: canvas.updatedAt,
        })),
      { authenticatedFallback: false },
    );
  },

  saveCanvas(payload: any) {
    return remoteOrLocal(
      () => post<{ canvasId: string; revision: number }>("/api/canvas/save", { ...authPayload(), ...payload }),
      () => localSaveCanvas(payload),
      { authenticatedFallback: false },
    );
  },

  getCanvasAssets(projectIdInput: number) {
    const projectId = requireCanvasAssetProjectId(projectIdInput);
    return remoteOrLocal(
      () =>
        request<{ assets: Array<{ id: string; userId: string; projectId?: number; name: string; saveLocation: string; tag: string; coverUrl: string; assetType?: "snapshot" | "portrait"; referenceAssetUri?: string; snapshot: { nodes: any[]; edges: any[]; bounds: any; meta?: any } }> }>(
          `/api/canvas/assets?projectId=${encodeURIComponent(String(projectId))}`,
        ),
      () => ({
        assets: cloneLocal(
          readLocalJson<LocalCanvasAsset[]>(LOCAL_ASSETS_KEY, [])
            .filter((asset) => Number(asset.projectId) === projectId),
        ),
      }),
      { authenticatedFallback: false },
    );
  },

  getCanvasWorkflows() {
    return remoteOrLocal(
      () =>
        request<{
          available: boolean;
          workflows: Array<{
            id: string;
            userId: string;
            name: string;
            coverUrl: string;
            coverNodeId?: string;
            note?: string;
            groupSnapshot: { nodes: any[]; edges: any[]; layoutMode: string; themeColor: string; bounds: any };
            createdAt: string;
            updatedAt: string;
          }>;
        }>("/api/canvas/workflows"),
      () => ({ workflows: cloneLocal(readLocalJson<LocalCanvasWorkflow[]>(LOCAL_WORKFLOWS_KEY, [])) }),
      { authenticatedFallback: false },
    );
  },

  createCanvasWorkflow(payload: {
    name: string;
    coverUrl?: string;
    coverNodeId?: string;
    note?: string;
    groupSnapshot: { nodes: any[]; edges: any[]; layoutMode: string; themeColor: string; bounds: any };
  }) {
    return remoteOrLocal(
      () => post<{ workflow: any }>("/api/canvas/workflows", payload),
      () => {
        const now = localNow();
        const workflow: LocalCanvasWorkflow = {
          id: localId("workflow"),
          userId: "local",
          name: payload.name,
          coverUrl: payload.coverUrl || "",
          coverNodeId: payload.coverNodeId,
          note: payload.note,
          groupSnapshot: payload.groupSnapshot,
          createdAt: now,
          updatedAt: now,
        };
        writeLocalJson(LOCAL_WORKFLOWS_KEY, [workflow, ...readLocalJson<LocalCanvasWorkflow[]>(LOCAL_WORKFLOWS_KEY, [])]);
        return { workflow: cloneLocal(workflow) };
      },
      { authenticatedFallback: false },
    );
  },

  deleteCanvasWorkflow(workflowId: string) {
    return remoteOrLocal(
      () =>
        request<{}>(
          `/api/canvas/workflows/${encodeURIComponent(workflowId)}`,
          { method: "DELETE" },
        ),
      () => {
        writeLocalJson(
          LOCAL_WORKFLOWS_KEY,
          readLocalJson<LocalCanvasWorkflow[]>(LOCAL_WORKFLOWS_KEY, []).filter((workflow) => workflow.id !== workflowId),
        );
        return {};
      },
      { authenticatedFallback: false },
    );
  },

  createCanvasAsset(payload: { projectId: number; name: string; saveLocation?: string; tag?: string; coverUrl?: string; assetType?: "snapshot" | "portrait"; referenceAssetUri?: string; nodes: any[]; edges?: any[]; bounds?: any }) {
    const projectId = requireCanvasAssetProjectId(payload.projectId);
    return remoteOrLocal(
      () => post<{ asset: any }>("/api/canvas/assets", { ...payload, projectId }),
      () => {
        const now = localNow();
        const asset: LocalCanvasAsset = {
          id: localId("asset"),
          userId: "local",
          projectId,
          name: payload.name,
          saveLocation: payload.saveLocation || "",
          tag: payload.tag || "",
          coverUrl: payload.coverUrl || "",
          assetType: payload.assetType || "snapshot",
          referenceAssetUri: payload.referenceAssetUri,
          createdAt: now,
          updatedAt: now,
          snapshot: {
            nodes: Array.isArray(payload.nodes) ? payload.nodes : [],
            edges: Array.isArray(payload.edges) ? payload.edges : [],
            bounds: payload.bounds || { left: 0, top: 0, right: 0, bottom: 0 },
            meta: { projectId },
          },
        };
        writeLocalJson(LOCAL_ASSETS_KEY, [asset, ...readLocalJson<LocalCanvasAsset[]>(LOCAL_ASSETS_KEY, [])]);
        return { asset: cloneLocal(asset) };
      },
      { authenticatedFallback: false },
    );
  },

  updateCanvasAsset(assetId: string, payload: { projectId: number; name?: string; saveLocation?: string; tag?: string; coverUrl?: string; assetType?: "snapshot" | "portrait"; referenceAssetUri?: string; snapshot?: any }) {
    const projectId = requireCanvasAssetProjectId(payload.projectId);
    return remoteOrLocal(
      () => request<{ asset: any }>(`/api/canvas/assets/${assetId}`, { method: "PATCH", body: JSON.stringify({ ...payload, projectId }) }),
      () => {
        const now = localNow();
        const assets = readLocalJson<LocalCanvasAsset[]>(LOCAL_ASSETS_KEY, []);
        const existing = assets.find((asset) => asset.id === assetId && Number(asset.projectId) === projectId);
        const asset: LocalCanvasAsset = {
          id: assetId,
          userId: existing?.userId || "local",
          projectId,
          name: payload.name || existing?.name || "未命名资产",
          saveLocation: payload.saveLocation ?? existing?.saveLocation ?? "",
          tag: payload.tag ?? existing?.tag ?? "",
          coverUrl: payload.coverUrl ?? existing?.coverUrl ?? "",
          assetType: payload.assetType || existing?.assetType || "snapshot",
          referenceAssetUri: payload.referenceAssetUri ?? existing?.referenceAssetUri,
          createdAt: existing?.createdAt || now,
          updatedAt: now,
          snapshot: payload.snapshot || existing?.snapshot || { nodes: [], edges: [], bounds: { left: 0, top: 0, right: 0, bottom: 0 } },
        };
        writeLocalJson(LOCAL_ASSETS_KEY, [
          asset,
          ...assets.filter((item) => item.id !== assetId || Number(item.projectId) !== projectId),
        ]);
        return { asset: cloneLocal(asset) };
      },
      { authenticatedFallback: false },
    );
  },

  deleteCanvasAsset(assetId: string, projectIdInput: number) {
    const projectId = requireCanvasAssetProjectId(projectIdInput);
    return remoteOrLocal(
      () =>
        request<{}>(`/api/canvas/assets/${assetId}?projectId=${encodeURIComponent(String(projectId))}`, {
          method: "DELETE",
        }),
      () => {
        writeLocalJson(
          LOCAL_ASSETS_KEY,
          readLocalJson<LocalCanvasAsset[]>(LOCAL_ASSETS_KEY, [])
            .filter((asset) => asset.id !== assetId || Number(asset.projectId) !== projectId),
        );
        return {};
      },
      { authenticatedFallback: false },
    );
  },

  canvasDraft(payload: any) {
    return apiPost<any>("/workbench/canvas/draft", payload);
  },

  generateCanvasText(payload: import("@/pages/fjtv/canvasTextArtifacts").CanvasTextRequest, idempotencyKey: string) {
    return apiPost<{ text: string; cards?: import("@/pages/fjtv/canvasTextArtifacts").CanvasArtifactResult[] }>("/workbench/canvas/text", { ...payload }, undefined, {
      headers: { "Idempotency-Key": idempotencyKey },
    });
  },

  generateNode(payload: any) {
    if (payload?.mediaType === "image") {
      const projectId = Number(payload.projectId);
      if (!Number.isSafeInteger(projectId) || projectId <= 0) {
        return Promise.reject(new ApiError("请先选择项目，再提交图片生成", 400));
      }
      const idempotencyKey = String(payload.idempotencyKey || "").trim()
        || buildCanvasImageIdempotencyKey({
          nodeId: payload.nodeId,
          attemptId: payload.generationAttemptId,
        });
      return apiPost<any>("/workbench/create/images", {
        projectId,
        model: payload.model,
        prompt: payload.prompt,
        count: payload.count,
        quality: payload.quality,
        ratio: payload.ratio,
        ...(payload.pricingConfirmation
          ? { pricingConfirmation: payload.pricingConfirmation }
          : {}),
        references: Array.isArray(payload.references) ? payload.references : [],
      }, undefined, {
        headers: { "Idempotency-Key": idempotencyKey },
      });
    }
    return apiPost<any>("/workbench/canvas/generate", payload);
  },

  composeCanvasVideo(
    payload: CanvasComposeVideoInput,
    options: { idempotencyKey: string; signal?: AbortSignal },
  ) {
    return apiPost<{ asset: CanvasComposeVideoAsset; reused: boolean }>(
      "/workbench/canvas/composeVideo",
      payload,
      undefined,
      {
        headers: { "Idempotency-Key": options.idempotencyKey },
        signal: options.signal,
      },
    );
  },

  generateDesignSheet(payload: any) {
    void payload;
    return Promise.reject(new ApiError("设定图已改用项目受控图片生成链路", 422));
  },

  enhanceImage(payload: {
    canvasId?: string;
    nodeId: string;
    imageUrl: string;
    model?: string;
    version?: "standard" | "professional";
    factor?: number;
    sourceWidth?: number;
    sourceHeight?: number;
  }) {
    void payload;
    return Promise.reject(new ApiError("图片高清能力尚未开放", 422));
  },

  outpaintImage(payload: {
    canvasId?: string;
    nodeId: string;
    imageUrl: string;
    expandLeft: number;
    expandRight: number;
    expandTop: number;
    expandBottom: number;
    ratioMode?: "original" | "1:1" | "4:3" | "3:4" | "16:9" | "9:16" | "custom";
    resolution?: "1K" | "2K" | "4K";
    count?: number;
  }) {
    void payload;
    return Promise.reject(new ApiError("扩图能力尚未开放", 422));
  },

  cropImage(payload: {
    canvasId?: string;
    nodeId: string;
    imageUrl: string;
    customX1: number;
    customY1: number;
    customX2: number;
    customY2: number;
    ratioMode?: "original" | "1:1" | "4:3" | "3:4" | "16:9" | "9:16" | "custom";
  }) {
    void payload;
    return Promise.reject(new ApiError("图片裁剪已改为浏览器本地处理并写入项目资产", 422));
  },

  removeImageBackground(payload: {
    canvasId?: string;
    nodeId: string;
    imageUrl: string;
    scene?: "general";
  }) {
    void payload;
    return Promise.reject(new ApiError("图像背景移除能力尚未开放", 422));
  },

  eraseImage(payload: {
    canvasId?: string;
    nodeId: string;
    imageUrl: string;
    eraseKind: "icon" | "text";
    eraseText?: string;
  }) {
    void payload;
    return Promise.reject(new ApiError("图像擦除能力尚未开放", 422));
  },

  enhanceVideo(payload: {
    canvasId?: string;
    nodeId: string;
    videoUrl: string;
    /** Stable o_media_asset id owned by the active workspace, when known. */
    sourceAssetId?: string;
    /** Source public resolution (720p/1080p/2k/4k). Defaults to 720p. */
    sourceResolution?: string;
    /** Target public resolution (720p/1080p/2k/4k or legacy 720P/1080P/2K/4K). */
    resolution?: "720P" | "1080P" | "2K" | "4K" | string;
    /** @deprecated Browser-provided duration is not authoritative for billing and is not submitted. */
    durationSeconds?: number;
    /** Optional deterministic attempt id for a transport retry of the same explicit submission. */
    attemptId?: string;
    /** @deprecated kept for canvas callers; ignored by workbench enhance. */
    model?: string;
    /** @deprecated kept for canvas callers; ignored by workbench enhance. */
    version?: "standard" | "professional";
    /** @deprecated kept for canvas callers; ignored by workbench enhance. */
    frameRate?: "original" | "24" | "30" | "60" | "90" | "120";
  }) {
    // Path B: workbench user enhance (separate video_enhance billing). Not the legacy /api/ai/enhance-video.
    const targetResolution = normalizePublicVideoResolution(payload.resolution, "1080p");
    const sourceResolution = normalizePublicVideoResolution(payload.sourceResolution, "720p");
    const sourceAssetId = String(payload.sourceAssetId || "").trim() || null;
    const idempotencyKey = buildVideoEnhanceIdempotencyKey({
      nodeId: payload.nodeId,
      sourceAssetId: sourceAssetId || undefined,
      videoUrl: payload.videoUrl,
      targetResolution,
      attemptId: payload.attemptId,
    });
    return apiPost<any>("/workbench/video/enhance/create", {
      sourceAssetId,
      sourceUrl: payload.videoUrl,
      sourceResolution,
      targetResolution,
      // Duration is deliberately omitted: the server only trusts the owned
      // o_media_asset.durationMs value for quote and settlement.
      idempotencyKey,
    }, undefined, {
      headers: { "Idempotency-Key": idempotencyKey },
    });
  },

  quoteVideoEnhance(payload: {
    sourceResolution: string;
    targetResolution: string;
    durationSeconds?: number;
  }) {
    return apiPost<any>("/workbench/video/enhance/quote", {
      sourceResolution: normalizePublicVideoResolution(payload.sourceResolution, "720p"),
      targetResolution: normalizePublicVideoResolution(payload.targetResolution, "1080p"),
      durationSeconds: payload.durationSeconds,
    });
  },

  queryVideoEnhanceTask(taskId: string) {
    return apiPost<any>("/workbench/video/enhance/task", { taskId });
  },

  extractVideoFrame(payload: {
    canvasId?: string;
    nodeId: string;
    videoUrl: string;
    extractMode: "current" | "first" | "last";
    specifiedTime?: number;
  }) {
    void payload;
    return Promise.reject(new ApiError("视频截帧已改为浏览器本地处理并写入项目资产", 422));
  },

  analyzeVideoStory(payload: {
    projectId: number;
    assetVersionId: number;
    title?: string;
    maximumShots?: number;
    rightsConfirmed: true;
    retryOfTaskId?: number;
    idempotencyKey: string;
  }) {
    const { idempotencyKey, ...body } = payload;
    return apiPost<any>("/workbench/canvas/videoStoryAnalysis", body, undefined, {
      headers: { "Idempotency-Key": idempotencyKey },
    });
  },

  queryVideoStoryAnalysisTasks(payload: {
    projectId: number;
    taskIds?: number[];
  }) {
    return apiPost<any[]>("/workbench/canvas/videoStoryAnalysis/status", payload);
  },

  cancelVideoStoryAnalysis(payload: { projectId: number; taskId: number }) {
    return apiPost<any>("/workbench/canvas/videoStoryAnalysis/cancel", payload);
  },

  analyzeProductViralVideo(payload: {
    canvasId?: string;
    nodeId: string;
    videoUrl: string;
    title?: string;
    maxShots?: number;
    productCategory?: string;
    brandTone?: string;
  }) {
    void payload;
    return Promise.reject(new ApiError("爆款视频拆解能力尚未开放", 422));
  },

  analyzeProductAssets(payload: {
    canvasId?: string;
    nodeId: string;
    productName?: string;
    productCategory?: string;
    assets: Array<{ kind: string; label?: string; url?: string; imageUrl?: string; note?: string }>;
  }) {
    void payload;
    return Promise.reject(new ApiError("产品素材解析能力尚未开放", 422));
  },

  composeProductStoryboard(payload: {
    canvasId?: string;
    nodeId: string;
    productName?: string;
    ratio?: string;
    viralAnalysis: any;
    productAnalysis: any;
  }) {
    void payload;
    return Promise.reject(new ApiError("产品分镜合成能力尚未开放", 422));
  },

  separateAudio(payload: {
    canvasId?: string;
    sourceType: "video" | "audio";
    videoUrl?: string;
    audioUrl?: string;
    voiceNodeId: string;
    bgmNodeId: string;
    muteVideoNodeId?: string;
  }) {
    void payload;
    return Promise.reject(new ApiError("音频分离能力尚未开放", 422));
  },

  eraseVideoSubtitle(payload: {
    canvasId?: string;
    nodeId: string;
    videoUrl: string;
    eraseType: "subtitle" | "region";
    eraseAreas?: Array<{
      top_left_x: number;
      top_left_y: number;
      bottom_right_x: number;
      bottom_right_y: number;
    }>;
  }) {
    void payload;
    return Promise.reject(new ApiError("视频字幕擦除能力尚未开放", 422));
  },

  uploadImage(file: File, options: UploadRequestOptions = {}): Promise<UploadedMedia> {
    const auth = readAuth();
    const projectId = Number(options.projectId);
    if (Number.isSafeInteger(projectId) && projectId > 0) {
      const category = file.type.startsWith("image/")
        ? "image"
        : file.type.startsWith("video/")
          ? "video"
          : file.type.startsWith("audio/")
            ? "audio"
            : null;
      if (!category) return Promise.reject(new ApiError("不支持的项目参考素材类型", 415));
      return uploadReferenceAttachment(projectId, file, {
        signal: options.signal,
        onProgress: options.onProgress,
      })
        .then((uploaded) => {
          return {
            assetId: String(uploaded.assetId),
            assetVersionId: uploaded.assetVersionId,
            url: uploaded.previewUrl,
            fileName: uploaded.name || file.name,
            type: uploaded.type || category,
          };
        });
    }
    const fallbackUpload = () => {
      const form = new FormData();
      form.append("file", file);
      if (auth) {
        form.append("userId", auth.userId);
        form.append("apiKey", auth.apiKey);
      }
      return uploadViaXhr<UploadedMedia>(resolveApiUrl("/api/upload/image"), {
        method: "POST",
        body: form,
        headers: auth ? { "x-user-id": auth.userId, "x-api-key": auth.apiKey } : undefined,
        signal: options.signal,
        onProgress: options.onProgress,
        parseApiEnvelope: true,
      });
    };

    const directUpload = async () => {
      const signature = await post<DirectUploadSignature>(
        "/api/upload/direct-sign",
        {
          ...authPayload(),
          fileName: file.name,
          fileSize: file.size,
          mimeType: file.type || "application/octet-stream",
        },
        auth ? { headers: { "x-user-id": auth.userId, "x-api-key": auth.apiKey } } : {},
      );
      const cosHeaders = { ...signature.headers };
      delete cosHeaders.Host;

      await uploadViaXhr<void>(signature.uploadUrl, {
        method: signature.method || "PUT",
        headers: cosHeaders,
        body: file,
        signal: options.signal,
        onProgress: options.onProgress,
      });
      options.onProgress?.(100);

      return request<UploadedMedia>("/api/upload/complete", {
        method: "POST",
        body: JSON.stringify({
          ...authPayload(),
          assetId: signature.assetId,
          key: signature.key,
          url: signature.publicUrl,
          type: signature.type,
          fileName: signature.fileName || file.name,
          fileSize: file.size,
          mimeType: signature.mimeType || file.type || "application/octet-stream",
        }),
        headers: auth ? { "x-user-id": auth.userId, "x-api-key": auth.apiKey } : undefined,
      });
    };

    return directUpload().catch(() => fallbackUpload());
  },

  queryTask(taskId: string) {
    return apiGet<any>(`/workbench/canvas/tasks/${encodeURIComponent(taskId)}`);
  },

  cancelTask(taskId: string) {
    return apiDelete<any>(`/workbench/canvas/tasks/${encodeURIComponent(taskId)}`);
  },

  async getAiHistory(payload: { type?: string; sort?: "asc" | "desc"; limit?: number }) {
    const type = payload.type && payload.type !== "all" ? payload.type : undefined;
    const result = await apiPost<any>("/workbench/library/list", {
      page: 1,
      limit: Math.min(60, Math.max(1, Number(payload.limit || 60))),
      type,
    });
    const rawItems = Array.isArray(result?.data) ? result.data : [];
    const items = rawItems
      .map((item: any) => {
        const assetType = String(item?.assetType || "").toLowerCase();
        if (!(["image", "video", "audio"] as string[]).includes(assetType)) return null;
        const createdAtMs = Number(item?.createdAt || 0);
        const createdAt = Number.isFinite(createdAtMs) && createdAtMs > 0
          ? new Date(createdAtMs).toISOString()
          : new Date(0).toISOString();
        return {
          id: String(item?.id || ""),
          mediaAssetId: String(item?.id || ""),
          taskId: String(item?.taskId || ""),
          type: assetType as "image" | "video" | "audio",
          url: String(item?.url || ""),
          model: String(item?.model || ""),
          prompt: String(item?.prompt || ""),
          status: String(item?.status || ""),
          preparationStage: item?.preparationStage === "portrait_registration" ? "portrait_registration" : undefined,
          statusMessage: typeof item?.statusMessage === "string" ? item.statusMessage : undefined,
          ...(item?.preparationStage === "portrait_registration" ? { pending: true, progress: 0 } : {}),
          errorMessage: item?.errorMessage ? String(item.errorMessage) : "",
          width: Number.isFinite(Number(item?.width)) && Number(item.width) > 0 ? Number(item.width) : null,
          height: Number.isFinite(Number(item?.height)) && Number(item.height) > 0 ? Number(item.height) : null,
          durationMs: Number.isFinite(Number(item?.durationMs)) && Number(item.durationMs) > 0 ? Number(item.durationMs) : null,
          metadata: item?.metadata && typeof item.metadata === "object" ? item.metadata : {},
          createdAt,
          dateGroup: createdAt.slice(0, 10),
        };
      })
      .filter(Boolean);
    if (payload.sort === "asc") items.reverse();
    return { items };
  },

  downloadMediaAsset(assetId: string) {
    return requestBlob(`/api/workbench/library/list/download/${encodeURIComponent(assetId)}`);
  },

  deleteAiHistory(ids: string[]) {
    return apiPost<{ deleted: number; requested: number }>("/workbench/library/delete", { ids });
  },

  startCliAuth(payload?: { clientName?: string }) {
    return post<{ deviceCode: string; userCode: string; verifyUrl: string; expiresAt: string; pollIntervalSeconds: number }>(
      "/api/cli/auth/start",
      payload || {},
    );
  },

  approveCliAuth(payload: { deviceCode: string; userCode: string }) {
    return post<{ ok: boolean; approved: boolean; deviceCode: string; userCode: string }>("/api/cli/auth/approve", {
      ...authPayload(),
      ...payload,
    });
  },

  saveProfile(payload: { nickname?: string; signature?: string; avatarUrl?: string }) {
    return post<{ profile: any }>("/api/user/profile", { ...authPayload(), ...payload });
  },

  createProfileShare() {
    return post<{ shareLink: string; profile: any }>("/api/user/profile/share", authPayload());
  },

  getPublicProfile(code: string) {
    return request<{ profile: any }>(`/api/user/profile/public/${encodeURIComponent(code)}`);
  },

  getInvites(limit?: number) {
    const params = new URLSearchParams();
    if (limit) params.set("limit", String(limit));
    return request<{ total: number; invitees: Array<{ userId: string; nickname: string; phoneMasked: string; registeredAt: string; rewardStatus: string }> }>(
      `/api/user/invites?${params.toString()}`
    );
  },
};

export { ApiError };
