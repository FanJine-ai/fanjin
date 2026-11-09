import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";

import type { PublicSmokeResult, ReleaseArtifact } from "./types";

const DEFAULT_TOTAL_TIMEOUT_MS = 30_000;
const DEFAULT_STEP_TIMEOUT_MS = 5_000;
const MAX_JSON_OR_HTML_BYTES = 1024 * 1024;
const MAX_SSE_FIRST_FRAME_BYTES = 64 * 1024;
const MAX_PASSWORD_FILE_BYTES = 4 * 1024;
const MAX_FIRST_SCREEN_ASSETS = 100;
const SOCKET_IO_NAMESPACE = "/api/socket/scriptAgent";
const SOCKET_IO_STABILITY_MS = 250;
const AGENT_SURFACE_CAPABILITIES = [
  "chat",
  "tools",
  "imageGeneration",
  "videoGeneration",
] as const;

type JsonRecord = Record<string, unknown>;
export type PublicSmokeFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface RawSmokeSocket {
  onOpen(listener: () => void): void;
  onMessage(listener: (message: string) => void): void;
  onError(listener: () => void): void;
  onClose(listener: () => void): void;
  send(message: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  removeAllListeners(): void;
}

export type RawSmokeSocketConnector = (
  url: string,
  options: { origin: string; handshakeTimeoutMs: number },
) => RawSmokeSocket;

export interface CompositePublicSmokeOptionOverrides {
  publicSmokeBaseUrl?: string;
  publicSmokeTimeoutMs?: number;
  publicSmokeStepTimeoutMs?: number;
  publicSmokeCanaryUsername?: string;
  publicSmokeCanaryPasswordFile?: string;
  publicSmokeCanaryUserId?: number | string;
  publicSmokeCanaryWorkspaceId?: string;
  publicSmokeAgentSseEnabled?: boolean;
  publicSmokeCanaryThreadId?: string;
  publicSmokeCanaryProjectId?: number | string;
  /** Test seam. Production code uses a TLS-valid raw `ws` client. */
  rawSmokeSocketConnector?: RawSmokeSocketConnector;
}

export interface CompositePublicSmokeConfig {
  baseUrl: URL;
  totalTimeoutMs: number;
  stepTimeoutMs: number;
  canaryUsername: string;
  canaryPasswordFile: string;
  canaryUserId: number;
  canaryWorkspaceId: string;
  agentSseEnabled: boolean;
  /** Required when `agentSseEnabled` is true. */
  canaryThreadId?: string;
  canaryProjectId: number;
}

export class CompositePublicSmokeConfigError extends Error {
  readonly code: string;

  constructor(code: "PUBLIC_SMOKE_CONFIG_MISSING" | "PUBLIC_SMOKE_CONFIG_INVALID") {
    super(code);
    this.name = "CompositePublicSmokeConfigError";
    this.code = code;
  }
}

class SmokeFailure extends Error {
  readonly code: string;
  readonly artifactSha256?: string;

  constructor(code: string, artifactSha256?: string) {
    super(code);
    this.name = "SmokeFailure";
    this.code = code;
    this.artifactSha256 = artifactSha256;
  }
}

class SmokeBodyTooLargeError extends Error {}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function positiveInteger(value: unknown, fallback?: number): number | undefined {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function strictBinarySwitch(value: unknown, fallback: boolean): boolean | undefined {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  return undefined;
}

function validateOpaqueId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new CompositePublicSmokeConfigError("PUBLIC_SMOKE_CONFIG_INVALID");
  }
  return value;
}

function validateUsername(value: string): string {
  if (value.length > 254 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new CompositePublicSmokeConfigError("PUBLIC_SMOKE_CONFIG_INVALID");
  }
  return value;
}

function validateBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CompositePublicSmokeConfigError("PUBLIC_SMOKE_CONFIG_INVALID");
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.search
    || url.hash
    || (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new CompositePublicSmokeConfigError("PUBLIC_SMOKE_CONFIG_INVALID");
  }
  url.pathname = "/";
  return url;
}

/**
 * Opens the password without following the final path component, then verifies
 * the opened inode. The secret is never included in a thrown error.
 */
export function readCanaryPasswordFile(filePath: string): string {
  try {
    if (!path.isAbsolute(filePath) || path.resolve(filePath) !== filePath) throw new Error();
    const noFollow = fs.constants.O_NOFOLLOW;
    if (typeof noFollow !== "number") throw new Error();
    const linkStat = fs.lstatSync(filePath);
    if (linkStat.isSymbolicLink() || !linkStat.isFile()) throw new Error();

    const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
    try {
      const openedStat = fs.fstatSync(descriptor);
      if (
        !openedStat.isFile()
        || openedStat.dev !== linkStat.dev
        || openedStat.ino !== linkStat.ino
        || (openedStat.mode & 0o7777) !== 0o600
        || openedStat.size < 1
        || openedStat.size > MAX_PASSWORD_FILE_BYTES
      ) {
        throw new Error();
      }
      const effectiveUid = process.geteuid?.();
      if (effectiveUid !== undefined && openedStat.uid !== effectiveUid) throw new Error();

      const bytes = fs.readFileSync(descriptor);
      const finalStat = fs.fstatSync(descriptor);
      if (finalStat.dev !== openedStat.dev || finalStat.ino !== openedStat.ino || finalStat.size !== bytes.length) {
        throw new Error();
      }
      let password = bytes.toString("utf8");
      if (password.endsWith("\r\n")) password = password.slice(0, -2);
      else if (password.endsWith("\n")) password = password.slice(0, -1);
      if (!password || Buffer.byteLength(password) > MAX_PASSWORD_FILE_BYTES || /[\u0000\r\n]/.test(password)) {
        throw new Error();
      }
      return password;
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {
    throw new CompositePublicSmokeConfigError("PUBLIC_SMOKE_CONFIG_INVALID");
  }
}

export function resolveCompositePublicSmokeConfig(
  options: CompositePublicSmokeOptionOverrides,
  env: NodeJS.ProcessEnv = process.env,
): CompositePublicSmokeConfig {
  const baseUrl = nonEmpty(options.publicSmokeBaseUrl) ?? nonEmpty(env.FANJIN_RELEASE_PUBLIC_SMOKE_BASE_URL);
  const canaryUsername = nonEmpty(options.publicSmokeCanaryUsername)
    ?? nonEmpty(env.FANJIN_RELEASE_PUBLIC_SMOKE_CANARY_USERNAME);
  const canaryPasswordFile = nonEmpty(options.publicSmokeCanaryPasswordFile)
    ?? nonEmpty(env.FANJIN_RELEASE_PUBLIC_SMOKE_CANARY_PASSWORD_FILE);
  const canaryUserIdRaw = options.publicSmokeCanaryUserId
    ?? nonEmpty(env.FANJIN_RELEASE_PUBLIC_SMOKE_CANARY_USER_ID);
  const canaryWorkspaceId = nonEmpty(options.publicSmokeCanaryWorkspaceId)
    ?? nonEmpty(env.FANJIN_RELEASE_PUBLIC_SMOKE_CANARY_WORKSPACE_ID);
  const agentSseEnabled = strictBinarySwitch(
    options.publicSmokeAgentSseEnabled ?? nonEmpty(env.FANJIN_RELEASE_PUBLIC_SMOKE_AGENT_SSE_ENABLED),
    true,
  );
  const canaryThreadId = nonEmpty(options.publicSmokeCanaryThreadId)
    ?? nonEmpty(env.FANJIN_RELEASE_PUBLIC_SMOKE_CANARY_THREAD_ID);
  const canaryProjectIdRaw = options.publicSmokeCanaryProjectId
    ?? nonEmpty(env.FANJIN_RELEASE_PUBLIC_SMOKE_CANARY_PROJECT_ID);

  if (
    !baseUrl
    || !canaryUsername
    || !canaryPasswordFile
    || canaryUserIdRaw === undefined
    || !canaryWorkspaceId
    || (agentSseEnabled === true && !canaryThreadId)
    || canaryProjectIdRaw === undefined
  ) {
    throw new CompositePublicSmokeConfigError("PUBLIC_SMOKE_CONFIG_MISSING");
  }

  const totalTimeoutMs = positiveInteger(
    options.publicSmokeTimeoutMs ?? nonEmpty(env.FANJIN_RELEASE_PUBLIC_SMOKE_TIMEOUT_MS),
    DEFAULT_TOTAL_TIMEOUT_MS,
  );
  const stepTimeoutMs = positiveInteger(
    options.publicSmokeStepTimeoutMs ?? nonEmpty(env.FANJIN_RELEASE_PUBLIC_SMOKE_STEP_TIMEOUT_MS),
    DEFAULT_STEP_TIMEOUT_MS,
  );
  const canaryUserId = positiveInteger(canaryUserIdRaw);
  const canaryProjectId = positiveInteger(canaryProjectIdRaw);
  if (
    agentSseEnabled === undefined
    || !totalTimeoutMs
    || !stepTimeoutMs
    || stepTimeoutMs > totalTimeoutMs
    || !canaryUserId
    || !canaryProjectId
  ) {
    throw new CompositePublicSmokeConfigError("PUBLIC_SMOKE_CONFIG_INVALID");
  }

  const normalizedPasswordFile = path.resolve(canaryPasswordFile);
  if (normalizedPasswordFile !== canaryPasswordFile) {
    throw new CompositePublicSmokeConfigError("PUBLIC_SMOKE_CONFIG_INVALID");
  }
  // Validate eagerly so a missing/insecure secret prevents adapter and
  // Controller startup. The file is re-opened for every smoke to support safe
  // atomic rotation without retaining the password in adapter configuration.
  readCanaryPasswordFile(normalizedPasswordFile);

  return Object.freeze({
    baseUrl: validateBaseUrl(baseUrl),
    totalTimeoutMs,
    stepTimeoutMs,
    canaryUsername: validateUsername(canaryUsername),
    canaryPasswordFile: normalizedPasswordFile,
    canaryUserId,
    canaryWorkspaceId: validateOpaqueId(canaryWorkspaceId),
    agentSseEnabled,
    ...(canaryThreadId ? { canaryThreadId: validateOpaqueId(canaryThreadId) } : {}),
    canaryProjectId,
  });
}

export function assertCompositePublicSmokeConfiguration(env: NodeJS.ProcessEnv = process.env): void {
  resolveCompositePublicSmokeConfig({}, env);
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      () => {
        signal.removeEventListener("abort", onAbort);
        reject(new Error("failed"));
      },
    );
  });
}

async function readBodyLimited(response: Response, signal: AbortSignal, maximumBytes: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await raceWithAbort(reader.read(), signal);
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        void reader.cancel().catch(() => undefined);
        throw new SmokeBodyTooLargeError();
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, totalBytes);
  } finally {
    if (signal.aborted) void reader.cancel().catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {
      // Cancellation is best-effort for synthetic streams used in tests.
    }
  }
}

async function readJson(response: Response, signal: AbortSignal, invalidCode: string): Promise<JsonRecord> {
  try {
    const bytes = await readBodyLimited(response, signal, MAX_JSON_OR_HTML_BYTES);
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (!isRecord(parsed)) throw new Error();
    return parsed;
  } catch (error) {
    if (signal.aborted) throw error;
    if (error instanceof SmokeBodyTooLargeError) {
      throw new SmokeFailure(invalidCode.replace(/_INVALID_BODY$/, "_BODY_TOO_LARGE"));
    }
    throw new SmokeFailure(invalidCode);
  }
}

interface StepContext {
  overallSignal: AbortSignal;
  overallTimedOut: () => boolean;
  leaseAborted: () => boolean;
  timeoutMs: number;
  timeoutCode: string;
  failureCode: string;
}

async function runStep<T>(context: StepContext, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let stepTimedOut = false;
  const abortFromOverall = () => controller.abort();
  context.overallSignal.addEventListener("abort", abortFromOverall, { once: true });
  if (context.overallSignal.aborted) controller.abort();
  const timeout = setTimeout(() => {
    stepTimedOut = true;
    controller.abort();
  }, context.timeoutMs);
  try {
    return await operation(controller.signal);
  } catch (error) {
    if (error instanceof SmokeFailure) throw error;
    if (stepTimedOut) throw new SmokeFailure(context.timeoutCode);
    if (context.overallTimedOut()) throw new SmokeFailure("PUBLIC_SMOKE_TIMEOUT");
    if (context.leaseAborted()) throw new SmokeFailure("PUBLIC_SMOKE_ABORTED");
    throw new SmokeFailure(context.failureCode);
  } finally {
    clearTimeout(timeout);
    context.overallSignal.removeEventListener("abort", abortFromOverall);
    controller.abort();
  }
}

async function fetchResponse(
  fetchFn: PublicSmokeFetch,
  url: URL,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Response> {
  return raceWithAbort(fetchFn(url, { ...init, redirect: "error", signal }), signal);
}

async function probeReadiness(
  fetchFn: PublicSmokeFetch,
  baseUrl: URL,
  signal: AbortSignal,
): Promise<string | undefined> {
  const response = await fetchResponse(fetchFn, new URL("/api/ready", baseUrl), {
    method: "GET",
    headers: { accept: "application/json", "cache-control": "no-store" },
  }, signal);
  if (response.status !== 200) throw new SmokeFailure("PUBLIC_SMOKE_HTTP_STATUS");
  const body = await readJson(response, signal, "PUBLIC_SMOKE_INVALID_BODY");
  const release = isRecord(body.release) ? body.release : undefined;
  const observedSha = release && nonEmpty(release.artifactSha256);
  if (body.ok !== true) throw new SmokeFailure("PUBLIC_SMOKE_NOT_READY", observedSha);
  return observedSha;
}

function attribute(tag: string, name: string): string | undefined {
  const expression = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]+)"|'([^']+)'|([^\\s>]+))`, "i");
  const match = tag.match(expression);
  return match ? (match[1] ?? match[2] ?? match[3]) : undefined;
}

function firstScreenAssetUrls(html: string, baseUrl: URL): { scripts: URL[]; styles: URL[] } {
  const scripts = new Map<string, URL>();
  const styles = new Map<string, URL>();
  for (const match of html.matchAll(/<(?:script|link)\b[^>]*>/gi)) {
    const tag = match[0];
    const rawReference = attribute(tag, /^<script/i.test(tag) ? "src" : "href");
    if (!rawReference) continue;
    let url: URL;
    try {
      url = new URL(rawReference, baseUrl);
    } catch {
      continue;
    }
    if (url.origin !== baseUrl.origin || url.username || url.password) continue;
    if (/\.(?:m?js)$/i.test(url.pathname)) scripts.set(url.toString(), url);
    if (/\.css$/i.test(url.pathname)) styles.set(url.toString(), url);
  }
  if (scripts.size + styles.size > MAX_FIRST_SCREEN_ASSETS) {
    throw new SmokeFailure("PUBLIC_SMOKE_ASSET_REFERENCES_INVALID");
  }
  return { scripts: [...scripts.values()], styles: [...styles.values()] };
}

async function probeHomepage(fetchFn: PublicSmokeFetch, baseUrl: URL, signal: AbortSignal): Promise<string> {
  const response = await fetchResponse(fetchFn, new URL("/", baseUrl), {
    method: "GET",
    headers: { accept: "text/html", "cache-control": "no-store" },
  }, signal);
  if (response.status !== 200) throw new SmokeFailure("PUBLIC_SMOKE_HOME_HTTP_STATUS");
  if (!String(response.headers.get("content-type") || "").toLowerCase().startsWith("text/html")) {
    throw new SmokeFailure("PUBLIC_SMOKE_HOME_CONTENT_TYPE");
  }
  let html: string;
  try {
    html = (await readBodyLimited(response, signal, MAX_JSON_OR_HTML_BYTES)).toString("utf8");
  } catch (error) {
    if (error instanceof SmokeBodyTooLargeError) throw new SmokeFailure("PUBLIC_SMOKE_HOME_BODY_TOO_LARGE");
    throw error;
  }
  if (!/<(?:!doctype\s+html|html)\b/i.test(html)) throw new SmokeFailure("PUBLIC_SMOKE_HOME_INVALID_BODY");
  return html;
}

async function requireNonEmptyBody(response: Response, signal: AbortSignal): Promise<void> {
  if (!response.body) throw new SmokeFailure("PUBLIC_SMOKE_ASSET_EMPTY");
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await raceWithAbort(reader.read(), signal);
      if (done) throw new SmokeFailure("PUBLIC_SMOKE_ASSET_EMPTY");
      if (value && value.byteLength > 0) return;
    }
  } finally {
    void reader.cancel().catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {
      // Best-effort cancellation of the remaining immutable asset bytes.
    }
  }
}

async function probeAsset(
  fetchFn: PublicSmokeFetch,
  url: URL,
  expected: "script" | "style",
  signal: AbortSignal,
): Promise<void> {
  const response = await fetchResponse(fetchFn, url, {
    method: "GET",
    headers: {
      accept: expected === "style" ? "text/css" : "application/javascript,text/javascript",
      "cache-control": "no-store",
    },
  }, signal);
  if (response.status !== 200) throw new SmokeFailure("PUBLIC_SMOKE_ASSET_HTTP_STATUS");
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  if (expected === "style" ? !contentType.startsWith("text/css") : !/(?:java|ecma)script/.test(contentType)) {
    throw new SmokeFailure("PUBLIC_SMOKE_ASSET_CONTENT_TYPE");
  }
  await requireNonEmptyBody(response, signal);
}

interface LoginResult {
  token: string;
  profile: JsonRecord;
}

async function probeLogin(
  fetchFn: PublicSmokeFetch,
  config: CompositePublicSmokeConfig,
  password: string,
  signal: AbortSignal,
  onToken: (token: string) => void,
): Promise<LoginResult> {
  const response = await fetchResponse(fetchFn, new URL("/api/auth/login", config.baseUrl), {
    method: "POST",
    headers: { accept: "application/json", "cache-control": "no-store", "content-type": "application/json" },
    body: JSON.stringify({ username: config.canaryUsername, password }),
  }, signal);
  if (response.status !== 200) throw new SmokeFailure("PUBLIC_SMOKE_LOGIN_HTTP_STATUS");
  const body = await readJson(response, signal, "PUBLIC_SMOKE_LOGIN_INVALID_BODY");
  const profile = isRecord(body.data) ? body.data : undefined;
  const token = profile && nonEmpty(profile.token);
  if (token && /^Bearer\s+\S+$/i.test(token)) onToken(token);
  if (body.code !== 200 || !profile || !token || !/^Bearer\s+\S+$/i.test(token)) {
    throw new SmokeFailure("PUBLIC_SMOKE_LOGIN_INVALID_BODY");
  }
  return { token, profile };
}

function assertCanaryIdentity(
  profile: JsonRecord,
  config: CompositePublicSmokeConfig,
  mismatchCode: string,
): void {
  const user = isRecord(profile.user) ? profile.user : undefined;
  const workspace = isRecord(profile.workspace) ? profile.workspace : undefined;
  if (
    !user
    || !workspace
    || Number(user.id) !== config.canaryUserId
    || String(workspace.id || "") !== config.canaryWorkspaceId
  ) {
    throw new SmokeFailure(mismatchCode);
  }
  const roles = [user.role, profile.role, workspace.memberRole]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().toLowerCase());
  if (roles.length < 3 || roles.some((role) => role !== "member")) {
    throw new SmokeFailure("PUBLIC_SMOKE_CANARY_NOT_LOW_PRIVILEGE");
  }
}

async function probeMe(
  fetchFn: PublicSmokeFetch,
  config: CompositePublicSmokeConfig,
  token: string,
  signal: AbortSignal,
): Promise<JsonRecord> {
  const response = await fetchResponse(fetchFn, new URL("/api/auth/me", config.baseUrl), {
    method: "GET",
    headers: { accept: "application/json", authorization: token, "cache-control": "no-store" },
  }, signal);
  if (response.status !== 200) throw new SmokeFailure("PUBLIC_SMOKE_ME_HTTP_STATUS");
  const body = await readJson(response, signal, "PUBLIC_SMOKE_ME_INVALID_BODY");
  if (body.code !== 200 || !isRecord(body.data)) throw new SmokeFailure("PUBLIC_SMOKE_ME_INVALID_BODY");
  return body.data;
}

async function probeAuthenticatedHealth(
  fetchFn: PublicSmokeFetch,
  baseUrl: URL,
  token: string,
  expectedVersion: string,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetchResponse(fetchFn, new URL("/api/health", baseUrl), {
    method: "GET",
    headers: { accept: "application/json", authorization: token, "cache-control": "no-store" },
  }, signal);
  if (response.status !== 200) throw new SmokeFailure("PUBLIC_SMOKE_AGENT_HEALTH_HTTP_STATUS");
  const body = await readJson(response, signal, "PUBLIC_SMOKE_AGENT_HEALTH_INVALID_BODY");
  if (body.ok !== true) throw new SmokeFailure("PUBLIC_SMOKE_AGENT_HEALTH_NOT_OK");
  if (nonEmpty(body.version) !== expectedVersion) {
    throw new SmokeFailure("PUBLIC_SMOKE_AGENT_HEALTH_VERSION_MISMATCH");
  }
}

async function probeAuthenticatedReadiness(
  fetchFn: PublicSmokeFetch,
  baseUrl: URL,
  token: string,
  expectedArtifactSha256: string,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetchResponse(fetchFn, new URL("/api/ready", baseUrl), {
    method: "GET",
    headers: { accept: "application/json", authorization: token, "cache-control": "no-store" },
  }, signal);
  if (response.status !== 200) throw new SmokeFailure("PUBLIC_SMOKE_AGENT_READY_HTTP_STATUS");
  const body = await readJson(response, signal, "PUBLIC_SMOKE_AGENT_READY_INVALID_BODY");
  const release = isRecord(body.release) ? body.release : undefined;
  const observedSha = release && nonEmpty(release.artifactSha256);
  if (body.ok !== true || nonEmpty(body.status) !== "ready") {
    throw new SmokeFailure("PUBLIC_SMOKE_AGENT_NOT_READY", observedSha);
  }
  if (observedSha !== expectedArtifactSha256) {
    throw new SmokeFailure("PUBLIC_SMOKE_AGENT_READY_ARTIFACT_MISMATCH", observedSha);
  }
}

async function probeAgentModelSurface(
  fetchFn: PublicSmokeFetch,
  baseUrl: URL,
  token: string,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetchResponse(fetchFn, new URL("/api/agent/chat-models", baseUrl), {
    method: "GET",
    headers: { accept: "application/json", authorization: token, "cache-control": "no-store" },
  }, signal);
  if (response.status !== 200) throw new SmokeFailure("PUBLIC_SMOKE_AGENT_SURFACE_HTTP_STATUS");
  const body = await readJson(response, signal, "PUBLIC_SMOKE_AGENT_SURFACE_INVALID_BODY");
  const data = isRecord(body.data) ? body.data : undefined;
  const capabilities = data && isRecord(data.capabilities) ? data.capabilities : undefined;
  const rawModels = data && Array.isArray(data.models) ? data.models : undefined;
  if (body.code !== "ok" || !data || !capabilities || !rawModels) {
    throw new SmokeFailure("PUBLIC_SMOKE_AGENT_SURFACE_INVALID_BODY");
  }
  if (data.available !== true) throw new SmokeFailure("PUBLIC_SMOKE_AGENT_SURFACE_UNAVAILABLE");
  for (const capability of AGENT_SURFACE_CAPABILITIES) {
    if (capabilities[capability] !== true) {
      throw new SmokeFailure(
        `PUBLIC_SMOKE_AGENT_CAPABILITY_${capability.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase()}_UNAVAILABLE`,
      );
    }
  }
  if (!rawModels.length) throw new SmokeFailure("PUBLIC_SMOKE_AGENT_SURFACE_MODELS_EMPTY");
  const models = rawModels.filter(isRecord);
  if (models.length !== rawModels.length) {
    throw new SmokeFailure("PUBLIC_SMOKE_AGENT_SURFACE_INVALID_BODY");
  }
  const agentMainModels = models.filter((model) => model.id === "agent-main");
  if (!agentMainModels.length) throw new SmokeFailure("PUBLIC_SMOKE_AGENT_MAIN_MISSING");
  if (agentMainModels.length !== 1) throw new SmokeFailure("PUBLIC_SMOKE_AGENT_MAIN_DUPLICATE");
  const defaultModels = models.filter((model) => model.default === true);
  if (defaultModels.length !== 1) {
    throw new SmokeFailure("PUBLIC_SMOKE_AGENT_DEFAULT_MODEL_COUNT_INVALID");
  }
  if (defaultModels[0] !== agentMainModels[0] || agentMainModels[0].default !== true) {
    throw new SmokeFailure("PUBLIC_SMOKE_AGENT_MAIN_NOT_DEFAULT");
  }
}

async function probeSseFirstFrame(
  fetchFn: PublicSmokeFetch,
  baseUrl: URL,
  canaryThreadId: string,
  token: string,
  signal: AbortSignal,
): Promise<void> {
  const url = new URL(`/api/agent/threads/${encodeURIComponent(canaryThreadId)}/events`, baseUrl);
  url.searchParams.set("after", "0");
  const response = await fetchResponse(fetchFn, url, {
    method: "GET",
    headers: { accept: "text/event-stream", authorization: token, "cache-control": "no-store" },
  }, signal);
  if (response.status !== 200) throw new SmokeFailure("PUBLIC_SMOKE_SSE_HTTP_STATUS");
  if (!String(response.headers.get("content-type") || "").toLowerCase().startsWith("text/event-stream")) {
    throw new SmokeFailure("PUBLIC_SMOKE_SSE_CONTENT_TYPE");
  }
  if (!response.body) throw new SmokeFailure("PUBLIC_SMOKE_SSE_FIRST_FRAME_INVALID");
  const reader = response.body.getReader();
  let buffered = "";
  try {
    while (true) {
      const { done, value } = await raceWithAbort(reader.read(), signal);
      if (done) throw new SmokeFailure("PUBLIC_SMOKE_SSE_FIRST_FRAME_INVALID");
      if (!value) continue;
      buffered += Buffer.from(value).toString("utf8");
      if (Buffer.byteLength(buffered) > MAX_SSE_FIRST_FRAME_BYTES) {
        throw new SmokeFailure("PUBLIC_SMOKE_SSE_FIRST_FRAME_INVALID");
      }
      const boundary = buffered.search(/\r?\n\r?\n/);
      if (boundary < 0) continue;
      const frame = buffered.slice(0, boundary);
      if (!frame || !frame.split(/\r?\n/).some((line) => /^(?::|data:|event:|id:|retry:)/.test(line))) {
        throw new SmokeFailure("PUBLIC_SMOKE_SSE_FIRST_FRAME_INVALID");
      }
      return;
    }
  } finally {
    void reader.cancel().catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {
      // The smoke intentionally closes immediately after the first frame.
    }
  }
}

function defaultRawSocketConnector(
  url: string,
  options: { origin: string; handshakeTimeoutMs: number },
): RawSmokeSocket {
  const socket = new WebSocket(url, {
    origin: options.origin,
    handshakeTimeout: options.handshakeTimeoutMs,
    followRedirects: false,
    maxPayload: MAX_SSE_FIRST_FRAME_BYTES,
    perMessageDeflate: false,
  });
  return {
    onOpen: (listener) => { socket.on("open", listener); },
    onMessage: (listener) => {
      socket.on("message", (data, isBinary) => {
        if (!isBinary) listener(data.toString("utf8"));
      });
    },
    onError: (listener) => { socket.on("error", listener); },
    onClose: (listener) => { socket.on("close", listener); },
    send: (message) => socket.send(message),
    close: (code, reason) => socket.close(code, reason),
    terminate: () => socket.terminate(),
    removeAllListeners: () => { socket.removeAllListeners(); },
  };
}

export async function probeRawSocketIoNamespace(input: {
  config: CompositePublicSmokeConfig;
  token: string;
  artifactSha256: string;
  signal: AbortSignal;
  connector?: RawSmokeSocketConnector;
}): Promise<void> {
  const url = new URL("/socket.io/", input.config.baseUrl);
  url.protocol = "wss:";
  url.searchParams.set("EIO", "4");
  url.searchParams.set("transport", "websocket");
  const connector = input.connector ?? defaultRawSocketConnector;
  const socket = connector(url.toString(), {
    origin: input.config.baseUrl.origin,
    handshakeTimeoutMs: input.config.stepTimeoutMs,
  });

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let engineOpened = false;
    let namespaceConnected = false;
    let stabilityTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: SmokeFailure) => {
      if (settled) return;
      settled = true;
      if (stabilityTimer) clearTimeout(stabilityTimer);
      input.signal.removeEventListener("abort", onAbort);
      if (namespaceConnected) {
        try {
          socket.send(`41${SOCKET_IO_NAMESPACE},`);
        } catch {
          // The namespace may have closed between the acknowledgement and cleanup.
        }
      }
      try {
        socket.close(1000, "smoke complete");
      } catch {
        socket.terminate();
      }
      socket.removeAllListeners();
      socket.onError(() => undefined);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => {
      try {
        socket.terminate();
      } finally {
        finish(new SmokeFailure("PUBLIC_SMOKE_SOCKET_IO_TIMEOUT"));
      }
    };
    input.signal.addEventListener("abort", onAbort, { once: true });
    if (input.signal.aborted) {
      onAbort();
      return;
    }

    socket.onOpen(() => undefined);
    socket.onError(() => finish(new SmokeFailure("PUBLIC_SMOKE_SOCKET_IO_HANDSHAKE_FAILED")));
    socket.onClose(() => {
      if (!settled) finish(new SmokeFailure("PUBLIC_SMOKE_SOCKET_IO_HANDSHAKE_FAILED"));
    });
    socket.onMessage((message) => {
      if (settled) return;
      if (message === "2") {
        try {
          socket.send("3");
        } catch {
          finish(new SmokeFailure("PUBLIC_SMOKE_SOCKET_IO_HANDSHAKE_FAILED"));
        }
        return;
      }
      if (!engineOpened) {
        if (!message.startsWith("0")) {
          finish(new SmokeFailure("PUBLIC_SMOKE_SOCKET_IO_HANDSHAKE_FAILED"));
          return;
        }
        try {
          const openPacket: unknown = JSON.parse(message.slice(1));
          if (!isRecord(openPacket) || !nonEmpty(openPacket.sid)) throw new Error();
        } catch {
          finish(new SmokeFailure("PUBLIC_SMOKE_SOCKET_IO_HANDSHAKE_FAILED"));
          return;
        }
        engineOpened = true;
        try {
          socket.send(`40${SOCKET_IO_NAMESPACE},${JSON.stringify({
            token: input.token,
            isolationKey: `release-smoke:${input.artifactSha256.slice(0, 16)}:${crypto.randomUUID()}`,
            projectId: input.config.canaryProjectId,
          })}`);
        } catch {
          finish(new SmokeFailure("PUBLIC_SMOKE_SOCKET_IO_HANDSHAKE_FAILED"));
        }
        return;
      }
      if (message.startsWith(`44${SOCKET_IO_NAMESPACE},`) || message.startsWith(`41${SOCKET_IO_NAMESPACE},`)) {
        finish(new SmokeFailure("PUBLIC_SMOKE_SOCKET_IO_HANDSHAKE_FAILED"));
        return;
      }
      if (message === `40${SOCKET_IO_NAMESPACE}` || message.startsWith(`40${SOCKET_IO_NAMESPACE},`)) {
        namespaceConnected = true;
        // The current namespace authenticates immediately after connection.
        // A brief stability window catches the server-side policy disconnect
        // without emitting any application event (especially `chat`).
        stabilityTimer = setTimeout(() => finish(), SOCKET_IO_STABILITY_MS);
      }
    });
  });
}

async function probeLogout(
  fetchFn: PublicSmokeFetch,
  config: CompositePublicSmokeConfig,
  token: string,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetchResponse(fetchFn, new URL("/api/auth/logout", config.baseUrl), {
    method: "POST",
    headers: { accept: "application/json", authorization: token, "cache-control": "no-store" },
  }, signal);
  if (response.status !== 200) throw new SmokeFailure("PUBLIC_SMOKE_LOGOUT_FAILED");
  const body = await readJson(response, signal, "PUBLIC_SMOKE_LOGOUT_FAILED");
  if (body.code !== 200) throw new SmokeFailure("PUBLIC_SMOKE_LOGOUT_FAILED");
}

function failureResult(error: unknown, observedSha?: string): PublicSmokeResult {
  if (error instanceof SmokeFailure) {
    return {
      ok: false,
      artifactSha256: error.artifactSha256 ?? observedSha,
      code: error.code,
    };
  }
  return { ok: false, artifactSha256: observedSha, code: "PUBLIC_SMOKE_REQUEST_FAILED" };
}

export async function runCompositePublicSmoke(input: {
  config: CompositePublicSmokeConfig;
  artifact: ReleaseArtifact;
  fetchFn: PublicSmokeFetch;
  rawSocketConnector?: RawSmokeSocketConnector;
  leaseSignal?: AbortSignal;
}): Promise<PublicSmokeResult> {
  const overallController = new AbortController();
  let overallTimedOut = false;
  let leaseAborted = false;
  const abortFromLease = () => {
    leaseAborted = true;
    overallController.abort();
  };
  input.leaseSignal?.addEventListener("abort", abortFromLease, { once: true });
  if (input.leaseSignal?.aborted) abortFromLease();
  const overallTimeout = setTimeout(() => {
    overallTimedOut = true;
    overallController.abort();
  }, input.config.totalTimeoutMs);

  let token: string | undefined;
  let observedSha: string | undefined;
  let failure: unknown;
  const step = <T>(
    timeoutCode: string,
    failureCode: string,
    operation: (signal: AbortSignal) => Promise<T>,
  ) => runStep({
    overallSignal: overallController.signal,
    overallTimedOut: () => overallTimedOut,
    leaseAborted: () => leaseAborted,
    timeoutMs: input.config.stepTimeoutMs,
    timeoutCode,
    failureCode,
  }, operation);

  try {
    observedSha = await step(
      "PUBLIC_SMOKE_READY_TIMEOUT",
      "PUBLIC_SMOKE_REQUEST_FAILED",
      (signal) => probeReadiness(input.fetchFn, input.config.baseUrl, signal),
    );
    if (observedSha !== input.artifact.sha256) {
      throw new SmokeFailure("PUBLIC_SMOKE_ARTIFACT_MISMATCH", observedSha);
    }

    const html = await step(
      "PUBLIC_SMOKE_HOME_TIMEOUT",
      "PUBLIC_SMOKE_HOME_REQUEST_FAILED",
      (signal) => probeHomepage(input.fetchFn, input.config.baseUrl, signal),
    );
    const assets = firstScreenAssetUrls(html, input.config.baseUrl);
    if (!assets.scripts.length || !assets.styles.length) throw new SmokeFailure("PUBLIC_SMOKE_ASSET_REFERENCES_MISSING");
    await step(
      "PUBLIC_SMOKE_ASSET_TIMEOUT",
      "PUBLIC_SMOKE_ASSET_REQUEST_FAILED",
      (signal) => Promise.all([
        ...assets.scripts.map((url) => probeAsset(input.fetchFn, url, "script", signal)),
        ...assets.styles.map((url) => probeAsset(input.fetchFn, url, "style", signal)),
      ]).then(() => undefined),
    );

    let password: string;
    try {
      password = readCanaryPasswordFile(input.config.canaryPasswordFile);
    } catch {
      throw new SmokeFailure("PUBLIC_SMOKE_CANARY_PASSWORD_FILE_INVALID");
    }
    let login: LoginResult;
    try {
      login = await step(
        "PUBLIC_SMOKE_LOGIN_TIMEOUT",
        "PUBLIC_SMOKE_LOGIN_REQUEST_FAILED",
        (signal) => probeLogin(input.fetchFn, input.config, password, signal, (issuedToken) => {
          token = issuedToken;
        }),
      );
    } finally {
      password = "";
    }
    token = login.token;
    assertCanaryIdentity(login.profile, input.config, "PUBLIC_SMOKE_LOGIN_IDENTITY_MISMATCH");

    const me = await step(
      "PUBLIC_SMOKE_ME_TIMEOUT",
      "PUBLIC_SMOKE_ME_REQUEST_FAILED",
      (signal) => probeMe(input.fetchFn, input.config, token!, signal),
    );
    assertCanaryIdentity(me, input.config, "PUBLIC_SMOKE_ME_IDENTITY_MISMATCH");

    // This is the zero-GU Agent release gate. Authentication has already been
    // bound to the fixed low-privilege canary identity above; these probes use
    // only GET, carry no request body, and return only fixed failure codes.
    await Promise.all([
      step(
        "PUBLIC_SMOKE_AGENT_HEALTH_TIMEOUT",
        "PUBLIC_SMOKE_AGENT_HEALTH_REQUEST_FAILED",
        (signal) => probeAuthenticatedHealth(
          input.fetchFn,
          input.config.baseUrl,
          token!,
          input.artifact.version,
          signal,
        ),
      ),
      step(
        "PUBLIC_SMOKE_AGENT_READY_TIMEOUT",
        "PUBLIC_SMOKE_AGENT_READY_REQUEST_FAILED",
        (signal) => probeAuthenticatedReadiness(
          input.fetchFn,
          input.config.baseUrl,
          token!,
          input.artifact.sha256,
          signal,
        ),
      ),
      step(
        "PUBLIC_SMOKE_AGENT_SURFACE_TIMEOUT",
        "PUBLIC_SMOKE_AGENT_SURFACE_REQUEST_FAILED",
        (signal) => probeAgentModelSurface(
          input.fetchFn,
          input.config.baseUrl,
          token!,
          signal,
        ),
      ),
    ]);

    if (input.config.agentSseEnabled) {
      const canaryThreadId = input.config.canaryThreadId;
      if (!canaryThreadId) throw new SmokeFailure("PUBLIC_SMOKE_CONFIG_MISSING");
      await step(
        "PUBLIC_SMOKE_SSE_TIMEOUT",
        "PUBLIC_SMOKE_SSE_REQUEST_FAILED",
        (signal) => probeSseFirstFrame(
          input.fetchFn,
          input.config.baseUrl,
          canaryThreadId,
          token!,
          signal,
        ),
      );
    }
    await step(
      "PUBLIC_SMOKE_SOCKET_IO_TIMEOUT",
      "PUBLIC_SMOKE_SOCKET_IO_HANDSHAKE_FAILED",
      (signal) => probeRawSocketIoNamespace({
        config: input.config,
        token: token!,
        artifactSha256: input.artifact.sha256,
        signal,
        connector: input.rawSocketConnector,
      }),
    );
  } catch (error) {
    failure = error;
  } finally {
    clearTimeout(overallTimeout);
    input.leaseSignal?.removeEventListener("abort", abortFromLease);
    overallController.abort();
    if (token) {
      const cleanupController = new AbortController();
      const cleanupTimeout = setTimeout(() => cleanupController.abort(), input.config.stepTimeoutMs);
      try {
        await probeLogout(input.fetchFn, input.config, token, cleanupController.signal);
      } catch {
        failure = new SmokeFailure("PUBLIC_SMOKE_LOGOUT_FAILED", observedSha);
      } finally {
        clearTimeout(cleanupTimeout);
        cleanupController.abort();
        token = undefined;
      }
    }
  }

  if (failure) return failureResult(failure, observedSha);
  return { ok: true, artifactSha256: observedSha };
}
