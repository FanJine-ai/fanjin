import { createHash, timingSafeEqual, randomBytes } from "node:crypto";
import { lstat, readFile, mkdir, open } from "node:fs/promises";
import type http from "node:http";
import path from "node:path";

import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
  type Router,
} from "express";

export const ROLLING_DRAIN_TOKEN_DIRECTORY = "/tmp/fanjin-release-drain";

/** Container-private token: no host mount, network bootstrap or shared secret.
 * Called only after the production runtime prestart claim has been verified. */
export async function prepareRollingDrainToken(directory = ROLLING_DRAIN_TOKEN_DIRECTORY): Promise<string> {
  await mkdir(directory, {mode: 0o700}).catch(error => {if (error.code !== "EEXIST") throw error;});
  const dir = await lstat(directory);
  if (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o777) !== 0o700 || dir.uid !== process.getuid?.())
    throw new Error("Unsafe rolling drain token directory");
  const file = path.join(directory, "token");
  let handle;
  try {handle = await open(file, "wx", 0o600);} catch (error: any) {if (error.code !== "EEXIST") throw error;}
  if (handle) {try {await handle.writeFile(randomBytes(48).toString("base64url")); await handle.sync();} finally {await handle.close();}}
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600
    || info.uid !== process.getuid?.() || info.size !== 64 || !/^[A-Za-z0-9_-]{64}$/.test(await readFile(file, "utf8")))
    throw new Error("Unsafe rolling drain token file");
  return file;
}

const TOKEN_PATTERN = /^[A-Za-z0-9._~+/=-]{32,4096}$/;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{5,127}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const INTERNAL_PREFIX = "/api/internal/release/drain";
const UNTRACKED_PATHS = new Set(["/api/health", "/api/ready"]);
const DEFAULT_SOFT_DEADLINE_MS = 300_000;
const MAX_SOFT_DEADLINE_MS = 3_600_000;

export interface ReleaseDrainSnapshot {
  draining: boolean;
  httpInflight: number;
  sseConnections: number;
  socketIoConnections: number;
  realtimeWsConnections: number;
  total: number;
}

export interface ReleaseDrainManagerOptions {
  server: http.Server;
  currentArtifactSha256(): string | null;
  socketIoConnections?(): number;
  realtimeWsConnections?(): number;
  closeSocketIoConnections?(): void;
  closeRealtimeWsConnections?(): void;
  softDeadlineMs?: number;
  environment?: NodeJS.ProcessEnv;
}

interface DrainIdentity {
  operationId: string | null;
  expectedCurrentArtifactSha256: string | null;
}

class ReleaseDrainRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ReleaseDrainRequestError";
    this.status = status;
    this.code = code;
  }
}

function isLoopbackAddress(value: string | undefined): boolean {
  const address = String(value || "").trim().toLowerCase();
  return address === "127.0.0.1"
    || address === "::1"
    || address === "::ffff:127.0.0.1";
}

function bearerToken(header: string | undefined): string | null {
  const match = /^Bearer ([A-Za-z0-9._~+/=-]{32,4096})$/.exec(String(header || ""));
  return match?.[1] || null;
}

function sameSecret(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left, "utf8").digest();
  const rightDigest = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function contentType(response: http.ServerResponse): string {
  const value = response.getHeader("content-type");
  return Array.isArray(value) ? value.join(";") : String(value || "");
}

function scalar(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function requestIdentity(request: Request): DrainIdentity {
  const body = request.body && typeof request.body === "object" && !Array.isArray(request.body)
    ? request.body as Record<string, unknown>
    : {};
  const query = request.query && typeof request.query === "object"
    ? request.query as Record<string, unknown>
    : {};
  const operationId = scalar(body.operationId ?? query.operationId);
  const expectedCurrentArtifactSha256 = scalar(
    body.expectedCurrentArtifactSha256 ?? query.expectedCurrentArtifactSha256,
  );
  if (operationId !== null && !OPERATION_ID_PATTERN.test(operationId)) {
    throw new ReleaseDrainRequestError(400, "INVALID_OPERATION_ID", "operationId 格式无效");
  }
  if (
    expectedCurrentArtifactSha256 !== null
    && !SHA256_PATTERN.test(expectedCurrentArtifactSha256)
  ) {
    throw new ReleaseDrainRequestError(
      400,
      "INVALID_ARTIFACT_SHA",
      "expectedCurrentArtifactSha256 格式无效",
    );
  }
  if (operationId === null || expectedCurrentArtifactSha256 === null) {
    throw new ReleaseDrainRequestError(
      400,
      "INCOMPLETE_DRAIN_IDENTITY",
      "operationId 与 expectedCurrentArtifactSha256 必须同时提供",
    );
  }
  return { operationId, expectedCurrentArtifactSha256 };
}

/**
 * Process-local application drain controller.
 *
 * CLB first stops assigning new traffic. This manager then rejects any late
 * business request while allowing requests that were already in flight to
 * finish. At a bounded soft deadline it normally ends established SSE streams
 * and asks the Socket.IO/Realtime registries to close their underlying
 * transports. Ordinary HTTP responses are never force-closed here.
 */
export class ReleaseDrainManager {
  private readonly server: http.Server;
  private readonly currentArtifactSha256: ReleaseDrainManagerOptions["currentArtifactSha256"];
  private readonly environment: NodeJS.ProcessEnv;
  private readonly softDeadlineMs: number;
  private socketIoConnections: () => number;
  private realtimeWsConnections: () => number;
  private closeSocketIoConnections: () => void;
  private closeRealtimeWsConnections: () => void;
  private readonly activeResponses = new Set<http.ServerResponse>();
  private softDeadlineTimer: NodeJS.Timeout | null = null;
  private draining = false;
  private rollingTokenFile: string | null = null;
  private identity: DrainIdentity = {
    operationId: null,
    expectedCurrentArtifactSha256: null,
  };

  constructor(options: ReleaseDrainManagerOptions) {
    this.server = options.server;
    this.currentArtifactSha256 = options.currentArtifactSha256;
    this.environment = options.environment ?? process.env;
    this.softDeadlineMs = this.resolveSoftDeadlineMs(options.softDeadlineMs);
    this.socketIoConnections = options.socketIoConnections ?? (() => 0);
    this.realtimeWsConnections = options.realtimeWsConnections ?? (() => 0);
    this.closeSocketIoConnections = options.closeSocketIoConnections ?? (() => undefined);
    this.closeRealtimeWsConnections = options.closeRealtimeWsConnections ?? (() => undefined);
  }

  async initializeRollingToken(): Promise<void> {
    if (this.environment.FANJIN_REQUIRE_PRODUCTION_PRESTART_RECEIPT !== "1" || this.environment.FANJIN_PROCESS_ROLE !== "api"
      || !/^sha256:[a-f0-9]{64}$/.test(this.environment.FANJIN_RUNTIME_CONFIG_SHA256 || "")
      || this.environment.FANJIN_DRAIN_TOKEN_FILE) return;
    this.rollingTokenFile = await prepareRollingDrainToken();
  }

  setConnectionCounters(counters: {
    socketIoConnections(): number;
    realtimeWsConnections(): number;
    closeSocketIoConnections?(): void;
    closeRealtimeWsConnections?(): void;
  }): void {
    this.socketIoConnections = counters.socketIoConnections;
    this.realtimeWsConnections = counters.realtimeWsConnections;
    this.closeSocketIoConnections = counters.closeSocketIoConnections ?? (() => undefined);
    this.closeRealtimeWsConnections = counters.closeRealtimeWsConnections ?? (() => undefined);
  }

  isDraining(): boolean {
    return this.draining;
  }

  /** Express gate installed before every business route. */
  middleware(): RequestHandler {
    return (request, response, next) => {
      const pathname = request.path;
      if (pathname.startsWith(INTERNAL_PREFIX) || UNTRACKED_PATHS.has(pathname)) {
        next();
        return;
      }
      if (this.draining) {
        response.setHeader("connection", "close");
        response.status(503).send({
          ok: false,
          code: "NODE_DRAINING",
          message: "服务节点正在平滑升级，请重试",
        });
        return;
      }

      this.activeResponses.add(response);
      let removed = false;
      const remove = () => {
        if (removed) return;
        removed = true;
        this.activeResponses.delete(response);
        response.off("finish", remove);
        response.off("close", remove);
      };
      response.once("finish", remove);
      response.once("close", remove);
      next();
    };
  }

  socketIoHandshakeAllowed(hasExistingSession: boolean): boolean {
    return !this.draining || hasExistingSession;
  }

  snapshot(): ReleaseDrainSnapshot {
    let sseConnections = 0;
    let httpInflight = 0;
    for (const response of this.activeResponses) {
      if (/^text\/event-stream(?:\s*;|$)/i.test(contentType(response))) sseConnections += 1;
      else httpInflight += 1;
    }
    const socketIoConnections = this.safeCount(this.socketIoConnections());
    const realtimeWsConnections = this.safeCount(this.realtimeWsConnections());
    const total = httpInflight + sseConnections + socketIoConnections + realtimeWsConnections;
    return {
      draining: this.draining,
      httpInflight,
      sseConnections,
      socketIoConnections,
      realtimeWsConnections,
      total,
    };
  }

  router(): Router {
    const router = express.Router();
    router.use((_request, response, next) => {
      if (String(this.environment.FANJIN_RECOVERY_ONLY_MODE || "").trim() !== "1") {
        next();
        return;
      }
      response.status(503).send({
        ok: false,
        code: "RECOVERY_ONLY_MUTATION_BLOCKED",
        message: "恢复候选不参与版本排空控制",
      });
    });
    router.use(express.json({ limit: "8kb", strict: true }));
    router.use((request, response, next) => {
      void this.authenticate(request).then(next, next);
    });
    router.post("/start", (request, response, next) => {
      try {
        const identity = requestIdentity(request);
        if (request.body.preserveStreams !== undefined && typeof request.body.preserveStreams !== "boolean")
          throw new ReleaseDrainRequestError(400, "INVALID_DRAIN_MODE", "排空模式无效");
        this.begin(identity, request.body.preserveStreams === true);
        response.status(200).send({ drain: this.snapshot() });
      } catch (error) {
        next(error);
      }
    });
    router.get("/status", (request, response, next) => {
      try {
        const identity = requestIdentity(request);
        this.assertCurrentArtifact(identity.expectedCurrentArtifactSha256);
        this.assertIdentity(identity);
        response.status(200).send({ drain: this.snapshot() });
      } catch (error) {
        next(error);
      }
    });
    router.post("/cancel", (request, response, next) => {
      try {
        const identity = requestIdentity(request);
        this.assertCurrentArtifact(identity.expectedCurrentArtifactSha256);
        this.assertIdentity(identity);
        this.clearSoftDeadlineTimer();
        this.draining = false;
        this.identity = { operationId: null, expectedCurrentArtifactSha256: null };
        response.status(200).send({ drain: this.snapshot() });
      } catch (error) {
        next(error);
      }
    });
    router.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
      const safe = error instanceof ReleaseDrainRequestError
        ? error
        : new ReleaseDrainRequestError(500, "DRAIN_CONTROL_FAILED", "节点排空控制失败");
      response.status(safe.status).send({ ok: false, code: safe.code, message: safe.message });
    });
    return router;
  }

  private begin(identity: DrainIdentity, preserveStreams = false): void {
    this.assertCurrentArtifact(identity.expectedCurrentArtifactSha256);
    if (this.draining) {
      this.assertIdentity(identity);
      return;
    }
    this.identity = identity;
    this.draining = true;
    for (const response of this.activeResponses) {
      if (!response.headersSent) response.setHeader("connection", "close");
    }
    // Close only idle keep-alive sockets. Active requests remain reflected in
    // snapshot(); long-lived transports get their bounded grace window below.
    this.server.closeIdleConnections?.();
    if (!preserveStreams) {
      this.softDeadlineTimer = setTimeout(() => this.closeLongConnections(), this.softDeadlineMs);
      this.softDeadlineTimer.unref?.();
    }
  }

  private closeLongConnections(): void {
    this.softDeadlineTimer = null;
    if (!this.draining) return;

    // A normal SSE response end causes EventSource clients to reconnect to a
    // healthy CLB backend while preserving their Last-Event-ID cursor.
    for (const response of this.activeResponses) {
      if (
        /^text\/event-stream(?:\s*;|$)/i.test(contentType(response))
        && !response.writableEnded
        && !response.destroyed
      ) {
        response.end();
      }
    }

    // Keep the two registries independent: a faulty close hook must not stop
    // the other connection class from being drained. Counts remain the
    // controller's fail-closed activation gate if either close is ineffective.
    try {
      this.closeSocketIoConnections();
    } catch (error) {
      console.warn(
        "[release-drain] Socket.IO transport close failed",
        error instanceof Error ? error.name : "UnknownError",
      );
    }
    try {
      this.closeRealtimeWsConnections();
    } catch (error) {
      console.warn(
        "[release-drain] Realtime WebSocket close failed",
        error instanceof Error ? error.name : "UnknownError",
      );
    }
  }

  private clearSoftDeadlineTimer(): void {
    if (this.softDeadlineTimer) clearTimeout(this.softDeadlineTimer);
    this.softDeadlineTimer = null;
  }

  private resolveSoftDeadlineMs(explicit: number | undefined): number {
    const configured = String(
      this.environment.FANJIN_RELEASE_DRAIN_SOFT_TIMEOUT_MS ?? "",
    ).trim();
    const raw = explicit ?? (configured ? Number(configured) : DEFAULT_SOFT_DEADLINE_MS);
    if (!Number.isSafeInteger(raw) || raw < 0 || raw > MAX_SOFT_DEADLINE_MS) {
      throw new Error("FANJIN_RELEASE_DRAIN_SOFT_TIMEOUT_MS must be an integer between 0 and 3600000");
    }
    return raw;
  }

  private assertIdentity(identity: DrainIdentity): void {
    if (!this.draining) return;
    if (identity.operationId !== this.identity.operationId) {
      throw new ReleaseDrainRequestError(409, "DRAIN_OPERATION_CONFLICT", "节点已由其他发布操作排空");
    }
    if (
      identity.expectedCurrentArtifactSha256 !== this.identity.expectedCurrentArtifactSha256
    ) {
      throw new ReleaseDrainRequestError(409, "DRAIN_ARTIFACT_CONFLICT", "节点排空版本身份不一致");
    }
  }

  private assertCurrentArtifact(expected: string | null): void {
    if (expected === null) return;
    if (this.currentArtifactSha256() !== expected) {
      throw new ReleaseDrainRequestError(409, "CURRENT_ARTIFACT_CONFLICT", "节点当前版本与排空请求不一致");
    }
  }

  private safeCount(value: number): number {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ReleaseDrainRequestError(500, "DRAIN_COUNTER_INVALID", "节点排空连接计数无效");
    }
    return value;
  }

  private tokenPath(): string {
    const configured = String(this.environment.FANJIN_DRAIN_TOKEN_FILE || "").trim();
    const base = String(this.environment.FANJIN_BASE || "/opt/fanjin").trim() || "/opt/fanjin";
    const result = configured || this.rollingTokenFile || path.resolve(base, "shared/env/release-drain.token");
    if (!path.isAbsolute(result)) {
      throw new ReleaseDrainRequestError(503, "DRAIN_TOKEN_INVALID", "节点排空凭证路径无效");
    }
    return result;
  }

  private async readToken(): Promise<string> {
    const tokenPath = this.tokenPath();
    const stats = await lstat(tokenPath).catch(() => null);
    if (
      !stats
      || !stats.isFile()
      || stats.isSymbolicLink()
      || stats.size < 32
      || stats.size > 4096
      || (stats.mode & 0o027) !== 0
    ) {
      throw new ReleaseDrainRequestError(503, "DRAIN_TOKEN_INVALID", "节点排空凭证不可用");
    }
    const token = (await readFile(tokenPath, "utf8")).trim();
    if (!TOKEN_PATTERN.test(token)) {
      throw new ReleaseDrainRequestError(503, "DRAIN_TOKEN_INVALID", "节点排空凭证格式无效");
    }
    return token;
  }

  private async authenticate(request: Request): Promise<void> {
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      throw new ReleaseDrainRequestError(403, "DRAIN_CONTROL_LOCAL_ONLY", "排空控制端点仅允许本机访问");
    }
    const supplied = bearerToken(request.get("authorization"));
    if (!supplied) {
      throw new ReleaseDrainRequestError(401, "DRAIN_TOKEN_REQUIRED", "缺少节点排空凭证");
    }
    let expected: string;
    try {
      expected = await this.readToken();
    } catch (error) {
      if (error instanceof ReleaseDrainRequestError) throw error;
      throw new ReleaseDrainRequestError(503, "DRAIN_TOKEN_INVALID", "节点排空凭证不可用");
    }
    if (!sameSecret(supplied, expected)) {
      throw new ReleaseDrainRequestError(401, "DRAIN_TOKEN_INVALID", "节点排空凭证无效");
    }
  }
}

export const releaseDrainInternalPrefix = INTERNAL_PREFIX;
