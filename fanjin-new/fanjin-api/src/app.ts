import { startToolsWorker, stopToolsWorker } from "@/tools/worker";
// import "./logger";
import "./err";
import "./env";
import { productionRuntimeConfigIdentity } from "@/lib/productionRuntimeConfigIdentity";
import express, { Request, Response, NextFunction } from "express";
import { Server } from "socket.io";
import http from "node:http";
import expressWs from "express-ws";
import logger from "morgan";
import cors from "cors";
import { logger as pinoLogger } from "@/lib/logger";
import {
  assertCandidateRuntimeServerAddress,
  candidateRuntimeBindHost,
  logRuntimeFilesystemFailure,
  logRuntimePath,
} from "@/lib/candidateRuntimeLogProjection";
import { requestIdMiddleware, httpLoggerMiddleware, errorLoggerMiddleware } from "@/middleware/requestLogger";
import { traceContextMiddleware } from "@/lib/tracing";
import buildRoute from "@/core";
import path from "path";
import fs from "fs";
import u from "@/utils";
import socketInit from "@/socket/index";
import { getWebPath } from "@/utils/getPath";
import { ensureThumbnail, ThumbnailSize } from "@/utils/image";
import {
  LocalOssThumbnailPathError,
  openContainedStaticReadFile,
  resolveContainedStaticReadPath,
  resolveLocalOssThumbnailPaths,
} from "@/lib/localOssThumbnailPath";
import authMiddleware from "@/middleware/auth";
import { adminAutomationMiddleware } from "@/middleware/adminAutomation";
import { apiKeyAuth } from "@/middleware/apiKeyAuth";
import { relayRateLimitMiddleware } from "@/middleware/relayRateLimit";
import { guardProjectScopedRoutes } from "@/middleware/projectAccess";
import { adminOperationAuditMiddleware } from "@/middleware/adminOperationAudit";
import { adminOperationPolicyMiddleware } from "@/middleware/adminOperationPolicy";
import { adminStepUpMiddleware } from "@/middleware/adminStepUp";
import { errorRedactionMiddleware } from "@/middleware/errorRedaction";
import { recoveryOnlyFenceMiddleware } from "@/middleware/recoveryOnlyFence";
import {
  httpSurfaceAllowsUpgrade,
  httpSurfaceBoundary,
  parseHttpSurface,
  type HttpSurface,
} from "@/middleware/httpSurface";
import { isRecoveryOnlyMode } from "@/lib/recoveryOnlyMode";
import {
  candidateRuntimeAttestationHandler,
  candidateRuntimeReadResponseAttestationMiddleware,
} from "@/lib/candidateRuntimeAttestation";
import {
  candidateReadonlyDatabaseConnectionProbeHandler,
} from "@/lib/candidateReadonlyDatabaseConnectionProbe";
import { buildCorsOptions, securityHeadersMiddleware } from "@/middleware/httpSecurity";
import { startRelayTaskWorker, stopRelayTaskWorker } from "@/lib/relay";
import { runBillingContext } from "@/lib/billingContext";
import {
  precompressedStaticMiddleware,
  precompressWebAssets,
  webStaticMiddleware,
} from "@/lib/staticWebAssets";
import { REQUEST_BODY_LIMIT_TEXT, requestBodyLimit, streamingTimeout } from "@/middleware/relayGuard";
import { db, dbReady } from "@/utils/db";
import { redactRequestUrl, requestLogMiddleware } from "@/lib/requestLog";
import { expireAccountGiftGrants } from "@/lib/accountWallet";
import { processDueMembershipPeriods } from "@/lib/membership";
import { membershipHttpGuard } from "@/middleware/membership";
import { commercialTenantContextMiddleware } from "@/lib/commercialTenant";
import { commercialTenantContextMiddlewareV2 } from "@/lib/tenantDirectory";
import { startBillingReconciliationWorker, stopBillingReconciliationWorker } from "@/lib/billingReconciliation";
import { startRelayCallbackDeliveryWorker, stopRelayCallbackDeliveryWorker } from "@/lib/relayCallback";
import {
  handleRealtimeConnection,
  startRelayRealtimeConnections,
  stopRelayRealtimeConnections,
} from "@/lib/relayRealtime";
import {
  assertRealtimeRequestAllowed,
  REALTIME_RELAY_UNAVAILABLE_MESSAGE,
  RealtimeRelaySafetyError,
  realtimeRelayAvailable,
} from "@/lib/realtimeRelaySafety";
import {
  beginWorkerHeartbeatShutdown,
  probeRuntimeReadiness,
  startWorkerHeartbeat,
  stopWorkerHeartbeat,
} from "@/lib/runtimeReadiness";
import { startDataRetentionWorker, stopDataRetentionWorker } from "@/lib/dataRetention";
import { startUserFeedbackSyncWorker, stopUserFeedbackSyncWorker } from "@/lib/userFeedback";
import {
  startCacheStorageBillingWorker,
  stopCacheStorageBillingWorker,
} from "@/lib/cacheStorageBilling";
import * as backupScheduler from "@/lib/backupScheduler";
import {
  startDeletionWorker,
  stopDeletionWorker,
} from "@/lib/deletionWorker";
import { getReleaseIdentity } from "@/lib/releaseIdentity";
import {
  assertProductionPrestartRuntimeClaim,
  productionPrestartReadinessReceipt,
} from "@/lib/productionPrestartReceipt";
import { emitFormalCandidateReadinessHandshake } from "@/lib/formalCandidateReadinessHandshake";
import {
  PORTRAIT_ASSETS_RUNTIME_CAPABILITY,
  PORTRAIT_IMAGEX_REVIEW_RUNTIME_CAPABILITY,
} from "@/lib/portraitRuntimeCapability";
import { PORTRAIT_ASSET_RELAY_RUNTIME_CAPABILITY } from "@/lib/portraitAssetRelayContract";
import {
  EDITOR_TIMELINE_V2_RUNTIME_CAPABILITY,
  PROJECT_FINAL_RENDER_SPEED_RUNTIME_CAPABILITY,
} from "@/lib/videoEditorRuntimeCapability";
import {
  DISTRIBUTED_RATE_LIMIT_SETTING_KEYS,
  MODEL_RATE_LIMIT_DURATION_KEY,
  MODEL_RATE_LIMIT_ENABLED_KEY,
  REDIS_RATE_LIMIT_RUNTIME_CAPABILITY,
  inspectDistributedRateLimitConfiguration,
  inspectDistributedRateLimitCutoverRuntime,
  inspectDistributedRateLimitWindowSettings,
} from "@/lib/distributedRateLimit";
import {
  redisCache,
  RedisUnavailableError,
  type RedisCacheRuntime,
} from "@/lib/redisCache";
import { redisRuntimeFingerprint } from "@/lib/redisRuntimeFingerprint";
import { inspectRedisBusinessCacheConfiguration } from "@/lib/cacheAside";
import { ReleaseDrainManager, releaseDrainInternalPrefix } from "@/lib/releaseDrain";
import {
  beginRecoveryAwareWorkerShutdown,
  startRecoveryAwareWorkerLifecycle,
} from "@/lib/recoveryOnlyWorkerLifecycle";
import {
  isConfiguredAgentRuntimeWorkerServiceRunning,
  startConfiguredAgentRuntimeWorkerService,
  stopConfiguredAgentRuntimeWorkerService,
} from "@/agent-runtime/workerService";
import {
  probeAgentRuntimeWorkerReadiness,
} from "@/agent-runtime/workerReadiness";
import {
  getAgentRuntimeModelAlias,
  isAgentRuntimeEnabled,
  isAgentRuntimeExecutionConfigured,
  isAgentRuntimeModelEnabled,
  isAgentRuntimePersistenceOnlyEnabled,
  isAgentRuntimeToolsEnabled,
  isAgentRuntimeWorkerEnabled,
} from "@/agent-runtime/featureFlags";
import { isProductionRuntime } from "@/lib/legacyAsyncRelaySafety";
import {
  startStoryboardImageTaskWorker,
  stopStoryboardImageTaskWorker,
} from "@/lib/storyboardImageTaskWorker";
import {
  startPortraitPreflightWorker,
  stopPortraitPreflightWorker,
} from "@/lib/portraitPreflight";
import {
  startPortraitProviderRuntimeWorker,
  stopPortraitProviderRuntimeWorker,
} from "@/lib/portraitProviderRuntime";
import {
  startPortraitSourceRecoveryWorker,
  stopPortraitSourceRecoveryWorker,
} from "@/lib/portraitSourceRecovery";
import {
  drainOperationalObservabilityCollector,
  startOperationalObservabilityCollector,
} from "@/lib/operationalObservability";
import {
  startTenantDomainOperationRecoveryWorker,
  stopTenantDomainOperationRecoveryWorker,
} from "@/lib/tenantDomainProductionOrchestrator";

const app = express();
const server = http.createServer(app);
// express-ws cannot share the main HTTP server with Socket.IO: both libraries
// would otherwise try to consume the same upgrade. A non-listening bridge owns
// the realtime WSS, while the main server forwards only the canonical path.
const realtimeUpgradeServer = http.createServer(app);
const realtimeWsInstance = expressWs(app, realtimeUpgradeServer);
const realtimeUpgradePaths = new Set(["/v1/realtime"]);
let activeHttpSurface: HttpSurface = "combined";
const releaseDrain = new ReleaseDrainManager({
  server,
  currentArtifactSha256: () => getReleaseIdentity().artifactSha256,
  realtimeWsConnections: () => realtimeWsInstance.getWss().clients.size,
});
const forwardRealtimeUpgrade = (request: http.IncomingMessage, socket: any, head: Buffer) => {
  const pathname = String(request.url || "").split("?", 1)[0];
  if (!httpSurfaceAllowsUpgrade(activeHttpSurface, pathname)) {
    const body = JSON.stringify({
      error: { code: "surface_not_found", message: "API 404 Not Found" },
    });
    socket.end([
      "HTTP/1.1 404 Not Found",
      "Connection: close",
      "Content-Type: application/json; charset=utf-8",
      `Content-Length: ${Buffer.byteLength(body)}`,
      "",
      body,
    ].join("\r\n"));
    return;
  }
  // Socket.IO owns its own upgrade listener. Returning here lets that listener
  // handle the only other allowlisted websocket transport.
  if (!realtimeUpgradePaths.has(pathname)) return;
  if (releaseDrain.isDraining()) {
    socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
    return;
  }
  realtimeUpgradeServer.emit("upgrade", request, socket, head);
};
server.on("upgrade", forwardRealtimeUpgrade);
let socketServer: Server | null = null;
let runtimeShuttingDown = false;
let serveShutdownPromise: Promise<void> | null = null;
logger.token("safe-url", (req: any) => redactRequestUrl(req.originalUrl || req.url || ""));

// 可信代理配置：决定 req.ip 是否采信 X-Forwarded-For。
// 默认关闭（直接使用 socket 来源 IP），避免客户端伪造 X-Forwarded-For
// 绕过 API Key 的 IP 白名单。部署在反向代理后时，通过 FANJIN_TRUST_PROXY
// 显式声明可信代理（如 "1"、"loopback"、具体子网或代理跳数）。
function parseTrustProxySetting(): boolean | string | number {
  const raw = String(process.env.FANJIN_TRUST_PROXY || process.env.TRUST_PROXY || "").trim();
  if (!raw) return false;
  if (/^(false|0|off|no)$/i.test(raw)) return false;
  if (/^(true|on|yes)$/i.test(raw)) return true;
  const num = Number(raw);
  if (Number.isInteger(num) && num >= 0) return num;
  return raw;
}
app.set("trust proxy", parseTrustProxySetting());

declare const __APP_VERSION__: string | undefined;

type ProcessRole = "all" | "api" | "worker";

function parseProcessRole(): ProcessRole {
  const raw = String(process.env.FANJIN_PROCESS_ROLE || process.env.FANJIN_SERVICE_ROLE || "all").trim().toLowerCase();
  if (raw === "all" || raw === "api" || raw === "server" || raw === "web") return raw === "server" || raw === "web" ? "api" : raw;
  if (raw === "worker" || raw === "relay-worker" || raw === "relay_worker") return "worker";
  throw new Error(`无效服务角色 FANJIN_PROCESS_ROLE=${raw}，可选值：all/api/worker`);
}

function shouldStartHttp(role: ProcessRole): boolean {
  return role === "all" || role === "api";
}

function shouldStartWorker(role: ProcessRole): boolean {
  return role === "all" || role === "worker";
}

export interface RedisReadinessContractInput {
  production: boolean;
  redisConfigured: boolean;
  redisRequired: boolean;
  redisAvailable: boolean;
  redisTopologyValid: boolean;
  businessCacheEnabled: boolean;
  businessCacheValid: boolean;
  rateLimitEnabled: boolean;
  rateLimitValid: boolean;
  rateLimitWindowsValid: boolean;
}

export interface RedisReadinessContractResult {
  ready: boolean;
  configurationReady: boolean;
  topologyReady: boolean;
  businessCacheReady: boolean;
  rateLimitReady: boolean;
}

/**
 * Production cannot silently fall back to process-local/database behavior:
 * every API node must share the same authenticated, non-local Redis service.
 * TLS is the default; the topology validator owns the temporary exact-host-
 * bound private-VPC exception. Cache-aside and both static/dynamic counter
 * windows must be valid. Development/test retain disabled-Redis workflows.
 */
export function evaluateRedisReadinessContract(
  input: RedisReadinessContractInput,
): RedisReadinessContractResult {
  const configurationReady = !input.production
    || (input.redisConfigured && input.redisRequired);
  const topologyReady = input.redisTopologyValid;
  const businessCacheReady = input.businessCacheValid
    && (!input.production || input.businessCacheEnabled)
    && (!input.businessCacheEnabled || (input.redisConfigured && input.redisAvailable));
  const rateLimitReady = input.rateLimitValid
    && input.rateLimitWindowsValid
    && (!input.production || input.rateLimitEnabled);
  const ready = configurationReady
    && topologyReady
    && input.redisAvailable
    && businessCacheReady
    && rateLimitReady;
  return {
    ready,
    configurationReady,
    topologyReady,
    businessCacheReady,
    rateLimitReady,
  };
}

type RedisReadinessProbe = Awaited<ReturnType<RedisCacheRuntime["probe"]>>;

async function probeRedisForReadiness(): Promise<RedisReadinessProbe> {
  if (!isRecoveryOnlyMode()) return await redisCache.probe();

  // The ordinary probe verifies Redis ACLs with a short-lived SET/GET/EVAL/DEL
  // cycle. Recovery endpoints may inspect only local runtime state, so an
  // accidentally configured Redis remains not-ready without being contacted.
  const snapshot = redisCache.snapshot();
  const disabled = !snapshot.configured
    && !snapshot.required
    && snapshot.status === "disabled";
  return {
    configured: snapshot.configured,
    required: snapshot.required,
    ready: disabled,
    latencyMs: null,
    status: disabled ? "disabled" : "unavailable",
  };
}

function parsePort(randomPort: boolean): number {
  if (randomPort) return 0;
  const rawPort = process.env.FANJIN_APP_PORT || process.env.PORT || "10588";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`无效端口配置：${rawPort}`);
  }
  return port;
}

let giftExpireTimer: NodeJS.Timeout | null = null;
let giftExpireRunning = false;

function startGiftGrantExpiryWorker() {
  if (giftExpireTimer || process.env.FANJIN_DISABLE_GIFT_GRANT_EXPIRY_WORKER === "1") return;
  const intervalMs = Math.max(60_000, Number(process.env.FANJIN_GIFT_GRANT_EXPIRY_INTERVAL_MS || 30 * 60_000));
  const run = async () => {
    if (giftExpireRunning) return;
    giftExpireRunning = true;
    try {
      const result = await expireAccountGiftGrants();
      if (result.expiredCount > 0) console.log(`[赠送 GU 到期清理]: expired=${result.expiredCount}`);
    } catch (err: any) {
      console.warn("赠送 GU 到期清理失败:", err?.message || err);
    } finally {
      giftExpireRunning = false;
    }
  };
  void run();
  giftExpireTimer = setInterval(run, intervalMs);
  giftExpireTimer.unref?.();
}

let membershipTimer: NodeJS.Timeout | null = null;
let membershipRunning = false;
function startMembershipGrantWorker() {
  if (membershipTimer || process.env.FANJIN_DISABLE_MEMBERSHIP_GRANT_WORKER === "1") return;
  const run = async () => {
    if (membershipRunning) return;
    membershipRunning = true;
    try {
      const result = await processDueMembershipPeriods({ limit: 100 });
      if (result.failed) console.warn(`[会员额度发放待恢复]: count=${result.failed}`);
    } catch { console.warn("会员额度发放待恢复，将自动重试"); }
    finally { membershipRunning = false; }
  };
  void run();
  membershipTimer = setInterval(run, 60_000);
  membershipTimer.unref?.();
}

async function stopGiftGrantExpiryWorker(): Promise<void> {
  if (membershipTimer) clearInterval(membershipTimer);
  membershipTimer = null;
  while (membershipRunning) await new Promise(resolve => setTimeout(resolve, 25));
  if (giftExpireTimer) clearInterval(giftExpireTimer);
  giftExpireTimer = null;
  while (giftExpireRunning) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export default async function startServe(randomPort: boolean = false) {
  // This must precede relay connections, database readiness, Redis startup,
  // observability registration and the HTTP bind. In the production image a
  // direct command override to app.js therefore cannot bypass preparation.
  assertProductionPrestartRuntimeClaim(
    process.env,
    typeof __APP_VERSION__ === "undefined" ? "dev" : __APP_VERSION__,
  );
  if (server.listening) throw new Error("HTTP 服务已在运行");
  await releaseDrain.initializeRollingToken();
  runtimeShuttingDown = false;
  serveShutdownPromise = null;
  const role = parseProcessRole();
  const httpSurface = parseHttpSurface();
  activeHttpSurface = httpSurface;
  if (!shouldStartHttp(role)) {
    throw new Error(`当前服务角色为 ${role}，不能启动 HTTP 服务`);
  }
  if (isRecoveryOnlyMode()) {
    await stopRelayRealtimeConnections();
  } else {
    startRelayRealtimeConnections();
  }
  await dbReady;
  await startOperationalObservabilityCollector({
    database: db as unknown as import("knex").Knex,
    workspaceId: String(
      process.env.FANJIN_OBSERVABILITY_SYNTHETIC_WORKSPACE_ID
        || (isProductionRuntime() ? "" : "default"),
    ),
    intervalMs: Number(process.env.FANJIN_OBSERVABILITY_INTERVAL_MS || 60_000),
    workerMaxAgeMs: Number(
      process.env.FANJIN_AGENT_WORKER_READINESS_MAX_AGE_MS || 45_000,
    ),
    reservationMaxAgeMs: Number(
      process.env.FANJIN_OBSERVABILITY_RESERVATION_MAX_AGE_MS || 60 * 60_000,
    ),
    billingScanIntervalMs: Number(
      process.env.FANJIN_OBSERVABILITY_BILLING_SCAN_INTERVAL_MS || 15 * 60_000,
    ),
  });
  if (!isRecoveryOnlyMode()) await redisCache.start();

  if (!isRecoveryOnlyMode()) await u.writeVersion();
  const corsOptions = buildCorsOptions();
  // Socket.IO carries Studio-only collaboration traffic. A relay-only
  // listener must not attach the Engine.IO upgrade handler at all; otherwise
  // it would bypass the ordinary Express surface fence.
  const io = httpSurface === "relay"
    ? null
    : new Server(server, { cors: corsOptions });
  socketServer = io;
  const socketIoConnections = new Set<{
    transport: { close(): void };
  }>();
  io?.engine.on("connection", (connection) => {
    socketIoConnections.add(connection);
    connection.once("close", () => socketIoConnections.delete(connection));
  });
  releaseDrain.setConnectionCounters({
    socketIoConnections: () => io?.engine.clientsCount ?? 0,
    realtimeWsConnections: () => realtimeWsInstance.getWss().clients.size,
    // Close Engine.IO transports directly. A Socket.IO namespace disconnect
    // tells clients not to reconnect; a transport loss lets their Manager
    // reconnect through CLB to a healthy node.
    closeSocketIoConnections: () => {
      for (const connection of socketIoConnections) {
        try {
          connection.transport.close();
        } catch {
          // The authoritative connection count remains non-zero on failure,
          // so the release controller will time out rather than activate.
        }
      }
    },
    closeRealtimeWsConnections: () => {
      for (const client of realtimeWsInstance.getWss().clients) {
        client.close(1012, "NODE_DRAINING");
      }
    },
  });
  if (io) {
    io.engine.use((request: any, response: any, next: (error?: Error) => void) => {
      if (isRecoveryOnlyMode()) {
        response.writeHead(503, { connection: "close", "content-type": "application/json" });
        response.end(JSON.stringify({ ok: false, code: "RECOVERY_ONLY_MUTATION_BLOCKED" }));
        return;
      }
      const hasExistingSession = typeof request?._query?.sid === "string" && request._query.sid.length > 0;
      if (releaseDrain.socketIoHandshakeAllowed(hasExistingSession)) {
        next();
        return;
      }
      response.writeHead(503, { connection: "close", "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false, code: "NODE_DRAINING" }));
    });
    if (!isRecoveryOnlyMode()) socketInit(io);
  }

  if (["dev", "development"].includes(String(process.env.NODE_ENV))) await buildRoute();

  // Pyroscope 性能剖析（需配置 FANJIN_PYROSCOPE_SERVER_ADDRESS）
  import("@/lib/pyroscope").then(({ initPyroscope }) => initPyroscope()).catch(() => {});

  // Realtime API WebSocket 端点
  const handleRealtimeWs = async (ws: any, req: express.Request) => {
    if (releaseDrain.isDraining()) return ws.close(1012, "NODE_DRAINING");
    if (isRecoveryOnlyMode()) return ws.close(1008, "RECOVERY_ONLY_MUTATION_BLOCKED");
    if (!realtimeRelayAvailable()) return ws.close(1013, REALTIME_RELAY_UNAVAILABLE_MESSAGE);
    const model = String(req.query.model || "");
    if (!model) return ws.close(1008, "REALTIME_MODEL_REQUIRED");
    const origin = String(req.headers.origin || "").trim() || null;
    try {
      assertRealtimeRequestAllowed({ model, origin });
    } catch (error) {
      const safetyError = error instanceof RealtimeRelaySafetyError ? error : null;
      return ws.close(safetyError?.closeCode || 1013, safetyError?.code || REALTIME_RELAY_UNAVAILABLE_MESSAGE);
    }
    const auth = (req as any).auth;
    const apiKey = (req as any).apiKey;
    const workspaceId = apiKey?.workspaceId ?? auth?.workspaceId ?? null;
    if (!workspaceId) return ws.close(1008, "REALTIME_WORKSPACE_REQUIRED");
    await handleRealtimeConnection(ws, model, {
      workspaceId,
      apiKeyId: apiKey?.id ?? null,
      sessionId: auth?.session?.id ? String(auth.session.id) : null,
      userId: auth?.user?.id ? Number(auth.user.id) : null,
      principalId: auth?.user?.id ? String(auth.user.id) : null,
      requestId: (req as any).requestId || null,
      origin,
    });
  };

  // 请求 ID 中间件 - 必须在最前面
  app.use(requestIdMiddleware);
  
  // 分布式追踪中间件 - 添加 trace ID 到响应头
  app.use(traceContextMiddleware());
  
  // 结构化日志中间件 - 记录所有 HTTP 请求/响应
  app.use(httpLoggerMiddleware);
  
  // 指标收集中间件 - 记录 HTTP 请求指标
  const { metricsMiddleware } = await import("@/lib/metrics");
  app.use(metricsMiddleware());
  
  app.use(logger(":method :safe-url :status :response-time ms - :res[content-length]"));
  app.use(securityHeadersMiddleware);
  app.use((req, res, next) => cors(buildCorsOptions(req))(req, res, next));
  app.use(requestBodyLimit);
  const capturePaymentCallbackBody = (req: Request, _res: Response, buffer: Buffer) => {
    if (req.path.startsWith("/api/billing/payment/callbacks/")) {
      (req as any).rawPaymentCallbackBody = buffer.toString("utf8");
    }
  };
  app.use(express.json({ limit: REQUEST_BODY_LIMIT_TEXT, verify: capturePaymentCallbackBody }));
  app.use(express.urlencoded({ extended: true, limit: REQUEST_BODY_LIMIT_TEXT, verify: capturePaymentCallbackBody }));
  // Parse a bounded request body before the recovery fence so candidate POST
  // reads can be checked against the same exact signed query/body contract as
  // the evidence runner. The fence still precedes every control, health,
  // static and business route, including release-drain mutations.
  app.use(recoveryOnlyFenceMiddleware);
  app.use(releaseDrain.middleware());
  app.use(releaseDrainInternalPrefix, releaseDrain.router());

  app.get("/api/health", (req, res) => {
    const response = {
      ok: true,
      name: "fanjin",
      version: typeof __APP_VERSION__ === "undefined" ? "dev" : __APP_VERSION__,
      release: getReleaseIdentity(),
      env: process.env.NODE_ENV || "dev",
      httpSurface,
      agent: {
        runtimeEnabled: isAgentRuntimeEnabled(),
        workerEnabled: isAgentRuntimeWorkerEnabled(),
        modelEnabled: isAgentRuntimeModelEnabled(),
        executionConfigured: isAgentRuntimeExecutionConfigured(),
        persistenceOnlyEnabled: isAgentRuntimePersistenceOnlyEnabled(),
        workerRunning: isConfiguredAgentRuntimeWorkerServiceRunning(),
        modelAlias: getAgentRuntimeModelAlias(),
        toolsEnabled: isAgentRuntimeToolsEnabled(),
      },
      time: new Date().toISOString(),
    };
    
    const logger = (req as any).logger || pinoLogger;
    logger.debug({ health: response }, "Health check");
    
    res.status(200).send(response);
  });
  
  // Kubernetes-style health endpoints (without /api prefix)
  app.get("/health", (req, res) => {
    res.status(200).send({
      status: "ok",
      timestamp: new Date().toISOString(),
    });
  });
  
  app.get("/healthz", (req, res) => {
    res.status(200).send({
      status: "ok",
      timestamp: new Date().toISOString(),
    });
  });
  app.get("/api/ready", async (req, res) => {
    const logger = (req as any).logger || pinoLogger;
    const redisFingerprint = redisRuntimeFingerprint();
    const requireProductionPrestartReceipt =
      process.env.FANJIN_REQUIRE_PRODUCTION_PRESTART_RECEIPT === "1";
    const productionPreparation = productionPrestartReadinessReceipt(
      process.env,
      typeof __APP_VERSION__ === "undefined" ? "dev" : __APP_VERSION__,
    );
    // Never expose the authenticated role claim or its HMAC through a public
    // readiness response. Operators need only the bounded phase/result.
    const productionPreparationSummary = productionPreparation ? {
      schema: productionPreparation.schema,
      role: productionPreparation.role,
      phase: productionPreparation.phase,
      readinessScore: productionPreparation.readinessScore,
      releaseReady: productionPreparation.releaseReady,
      p0Blockers: productionPreparation.p0Blockers,
      receiptDigest: productionPreparation.receiptDigest,
    } : null;
    const runtimeCapabilities = [
      EDITOR_TIMELINE_V2_RUNTIME_CAPABILITY,
      PORTRAIT_ASSET_RELAY_RUNTIME_CAPABILITY,
      PORTRAIT_ASSETS_RUNTIME_CAPABILITY,
      PROJECT_FINAL_RENDER_SPEED_RUNTIME_CAPABILITY,
      REDIS_RATE_LIMIT_RUNTIME_CAPABILITY,
      PORTRAIT_IMAGEX_REVIEW_RUNTIME_CAPABILITY,
    ];
    if (runtimeShuttingDown || releaseDrain.isDraining()) {
      const response = {
        ok: false,
        status: runtimeShuttingDown ? "shutting_down" : "draining",
        release: getReleaseIdentity(),
        runtime: { httpSurface, redisFingerprint, capabilities: runtimeCapabilities },
        checks: { shutdown: !runtimeShuttingDown, drain: !releaseDrain.isDraining() },
        time: new Date().toISOString(),
      };
      logger.warn({ readiness: response }, "Readiness check failed: service shutting down or draining");
      return res.status(503).send(response);
    }
    const workerRequirement = process.env.FANJIN_READINESS_REQUIRE_WORKER;
    // MODEL=1 is itself a declaration that an Agent worker must be reachable.
    // Requiring WORKER=1 here would accidentally make MODEL-only
    // misconfiguration report healthy.
    const agentModelEnabled = isAgentRuntimeModelEnabled();
    const agentExecutionConfigured = isAgentRuntimeExecutionConfigured();
    const agentWorkerRequired = agentModelEnabled;
    // Agent execution is an optional capability from the public traffic
    // plane's perspective. Its own admission endpoints fail closed, but an
    // Agent-only Worker incident must not remove login, billing, assets and
    // every other API route from the CLB target group.
    const requireWorker = workerRequirement === "1" || (
      workerRequirement !== "0" && (
        shouldStartWorker(role) || process.env.FANJIN_EXPECT_EXTERNAL_WORKER === "1"
      )
    );
    const requireWeb = isProductionRuntime() && process.env.FANJIN_READINESS_REQUIRE_WEB !== "0";
    const readiness = await probeRuntimeReadiness(db as any, { requireWorker, requireWeb });
    const agentWorkerReadiness = agentWorkerRequired
      ? await probeAgentRuntimeWorkerReadiness(db as any)
      : null;
    const redis = await probeRedisForReadiness();
    const redisServerTimeMs = redis.configured && redis.ready
      ? await redisCache.serverTimeMs()
      : null;
    const redisTopology = redisCache.productionTopologyInspection();
    const rateLimit = inspectDistributedRateLimitConfiguration();
    const businessCache = inspectRedisBusinessCacheConfiguration();
    const rateLimitCutover = await inspectDistributedRateLimitCutoverRuntime({
      database: db as unknown as import("knex").Knex,
      redis: redisCache,
      runtimeFingerprint: redisFingerprint,
      redisServerTimeMs,
      allowActivation: !isRecoveryOnlyMode(),
    });
    let rateLimitWindowsReady = false;
    try {
      const rows = await db("o_setting")
        .whereIn("key", [...DISTRIBUTED_RATE_LIMIT_SETTING_KEYS])
        .select("key", "value");
      const values = new Map(rows.map((row: any) => [String(row.key), row.value]));
      rateLimitWindowsReady = inspectDistributedRateLimitWindowSettings({
        configuration: rateLimit,
        modelEnabled: values.get(MODEL_RATE_LIMIT_ENABLED_KEY),
        modelDurationMinutes: values.get(MODEL_RATE_LIMIT_DURATION_KEY),
      }).valid;
    } catch {
      rateLimitWindowsReady = false;
    }
    const agentWorkerHeartbeatReady =
      !agentWorkerRequired || agentWorkerReadiness?.ready === true;
    const localAgentWorkerServiceReady =
      !agentWorkerRequired
      || !shouldStartWorker(role)
      || isConfiguredAgentRuntimeWorkerServiceRunning();
    const agentWorkerReady = !agentWorkerRequired || (
      agentExecutionConfigured
      && agentWorkerHeartbeatReady
      && localAgentWorkerServiceReady
    );
    const redisContract = evaluateRedisReadinessContract({
      production: redisTopology.production,
      redisConfigured: redis.configured,
      redisRequired: redis.required,
      redisAvailable: redis.ready,
      redisTopologyValid: redisTopology.valid,
      businessCacheEnabled: businessCache.enabled,
      businessCacheValid: businessCache.status !== "invalid",
      rateLimitEnabled: rateLimit.redisEnabled,
      rateLimitValid: rateLimit.valid,
      rateLimitWindowsValid: rateLimitWindowsReady,
    });
    // Keep a node with a missing/unsafe topology, bad credentials, or an
    // unreachable shared endpoint out of CLB. This is deliberately stricter in
    // production while local test/dev can still run with Redis disabled.
    const ready = readiness.ready
      && redisContract.ready
      && rateLimitCutover.valid
      && (!redis.configured || redisServerTimeMs !== null)
      && (!requireProductionPrestartReceipt || productionPreparation !== null);
    
    const response = {
      ok: ready,
      status: ready ? "ready" : "not_ready",
      release: getReleaseIdentity(),
      productionPreparation: productionPreparationSummary,
      runtimeConfig: productionRuntimeConfigIdentity(),
      runtime: {
        httpSurface,
        redisFingerprint,
        capabilities: runtimeCapabilities,
        redisRateLimitCutover: rateLimitCutover,
      },
      checks: {
        ...readiness.checks,
        redis: redis.ready,
        redisConfigured: redis.configured,
        redisRequired: redis.required,
        redisAvailable: redis.ready,
        redisConfiguration: redisContract.configurationReady,
        redisTopology: redisContract.topologyReady,
        redisRemoteEndpoint: redisTopology.endpointScope === "remote",
        redisTls: redisTopology.tlsConfigured,
        redisAuthenticated: redisTopology.authConfigured,
        redisInsecurePrivateVpcMode: redisTopology.insecurePrivateVpcMode,
        redisReleaseTestExemption: redisTopology.testOnlyExemption,
        redisRateLimit: redisContract.rateLimitReady,
        redisRateLimitEnabled: rateLimit.redisEnabled,
        redisRateLimitWindows: rateLimitWindowsReady,
        redisRateLimitCutover: rateLimitCutover.valid,
        redisServerTime: !redis.configured || redisServerTimeMs !== null,
        redisBusinessCache: redisContract.businessCacheReady,
        redisBusinessCacheEnabled: businessCache.enabled,
        agentWorkerHeartbeat: agentWorkerHeartbeatReady,
        agentWorkerLocalService: localAgentWorkerServiceReady,
        agentWorker: agentWorkerReady,
        productionPrestart:
          !requireProductionPrestartReceipt || productionPreparation !== null,
        shutdown: true,
        drain: true,
      },
      time: new Date().toISOString(),
    };
    
    if (ready) {
      logger.debug({ readiness: response }, "Readiness check passed");
    } else {
      const failedChecks = Object.entries(response.checks)
        .filter(([_, value]) => value === false)
        .map(([key]) => key);
      logger.warn({ readiness: response, failedChecks }, "Readiness check failed");
    }
    
    return res.status(ready ? 200 : 503).send(response);
  });
  
  // Kubernetes-style readiness endpoint (simplified version)
  app.get("/readiness", async (req, res) => {
    if (runtimeShuttingDown || releaseDrain.isDraining()) {
      return res.status(503).send({ status: "not_ready", reason: "shutting_down_or_draining" });
    }
    
    const readiness = await probeRuntimeReadiness(db as any, { requireWorker: false, requireWeb: false });
    const redis = await probeRedisForReadiness();
    
    if (readiness.ready && redis.ready) {
      return res.status(200).send({ status: "ready" });
    }
    
    return res.status(503).send({ status: "not_ready", reason: "dependencies_unavailable" });
  });
  
  app.get("/ready", async (req, res) => {
    if (runtimeShuttingDown || releaseDrain.isDraining()) {
      return res.status(503).send({ status: "not_ready" });
    }
    
    const readiness = await probeRuntimeReadiness(db as any, { requireWorker: false, requireWeb: false });
    return res.status(readiness.ready ? 200 : 503).send({ 
      status: readiness.ready ? "ready" : "not_ready",
    });
  });
  
  // Metrics endpoint
  app.get("/metrics", async (req, res) => {
    const workerRequirement = process.env.FANJIN_READINESS_REQUIRE_WORKER;
    const requireWorker = isAgentRuntimeModelEnabled() || workerRequirement === "1" || (
      workerRequirement !== "0" && (
        shouldStartWorker(role) || process.env.FANJIN_EXPECT_EXTERNAL_WORKER === "1"
      )
    );
    const [readinessResult, redisResult] = await Promise.allSettled([
      probeRuntimeReadiness(db as any, { requireWorker, requireWeb: false }),
      probeRedisForReadiness(),
    ]);
    const readiness = readinessResult.status === "fulfilled" ? readinessResult.value : null;
    const redis = redisResult.status === "fulfilled" ? redisResult.value : null;
    const { getPrometheusMetrics } = await import("@/lib/metrics");
    const metrics = getPrometheusMetrics({
      version: typeof __APP_VERSION__ === "undefined" ? "dev" : __APP_VERSION__,
      health: {
        database: readiness?.checks.database === true,
        redis: redis?.ready === true,
        worker: readiness?.checks.worker === true,
        web: true,
      },
    });
    res
      .status(200)
      .set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
      .send(metrics);
  });
  
  app.get("/api/metrics", async (req, res) => {
    const { getMetrics } = await import("@/lib/metrics");
    const metrics = getMetrics();
    res.status(200).json(metrics);
  });
  
  app.use(requestLogMiddleware());
  app.use(errorRedactionMiddleware());
  app.use(httpSurfaceBoundary(httpSurface));
  await startRecoveryAwareWorkerLifecycle({
    enabled: shouldStartWorker(role),
    recoveryOnly: isRecoveryOnlyMode(),
    startRecoveryWork: startRecoveryBackgroundWorkers,
    startHeartbeatManagedWork: () => startWorkerHeartbeat(db as any, {
      startWork: startBackgroundWorkers,
      stopWork: stopBackgroundWorkers,
    }),
  });

  // oss 静态资源
  const ossDir = u.getPath("oss");
  if (!fs.existsSync(ossDir) && !isRecoveryOnlyMode()) {
    fs.mkdirSync(ossDir, { recursive: true });
  }
  logRuntimePath("文件目录:", ossDir);

  type OssByteRange = Readonly<{ start: number; end: number }>;
  type OssByteRangeResult =
    | Readonly<{ kind: "range"; value: OssByteRange }>
    | Readonly<{ kind: "unsatisfiable" }>
    | Readonly<{ kind: "ignore" }>;
  const parseOssByteRange = (
    rawRange: string,
    fileSize: number,
  ): OssByteRangeResult => {
    const trimmed = rawRange.trim();
    // Multipart byte ranges are valid HTTP, but this delivery surface does not
    // synthesize multipart/byteranges. RFC semantics permit ignoring Range and
    // returning the complete representation; 416 would be incorrect when one
    // or more members are satisfiable.
    if (trimmed.includes(",")) return Object.freeze({ kind: "ignore" });
    const match = /^bytes=(\d*)-(\d*)$/i.exec(trimmed);
    if (!match || (!match[1] && !match[2])) {
      return Object.freeze({ kind: "ignore" });
    }
    if (fileSize <= 0) return Object.freeze({ kind: "unsatisfiable" });

    if (!match[1]) {
      const suffixLength = Number(match[2]);
      if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
        return Object.freeze({ kind: "unsatisfiable" });
      }
      return Object.freeze({
        kind: "range",
        value: Object.freeze({
          start: Math.max(0, fileSize - suffixLength),
          end: fileSize - 1,
        }),
      });
    }

    const start = Number(match[1]);
    const requestedEnd = match[2] ? Number(match[2]) : fileSize - 1;
    if (
      !Number.isSafeInteger(start)
      || !Number.isSafeInteger(requestedEnd)
      || start < 0
      || start >= fileSize
      || requestedEnd < start
    ) {
      return Object.freeze({ kind: "unsatisfiable" });
    }
    return Object.freeze({
      kind: "range",
      value: Object.freeze({
        start,
        end: Math.min(requestedEnd, fileSize - 1),
      }),
    });
  };

  const ifRangeMatches = (
    rawIfRange: string | undefined,
    opened: NonNullable<ReturnType<typeof openContainedStaticReadFile>>,
  ): boolean => {
    if (rawIfRange === undefined) return true;
    const validator = rawIfRange.trim();
    if (!validator || /^W\//i.test(validator)) return false;
    if (validator.startsWith('"')) return validator === opened.etag;
    const timestamp = Date.parse(validator);
    if (!Number.isFinite(timestamp)) return false;
    // HTTP dates have one-second precision. Treat the descriptor as unchanged
    // when its last modification falls within the represented second.
    return opened.mtimeMs < timestamp + 1_000;
  };

  const closeOssDescriptor = (fd: number): void => {
    try {
      fs.closeSync(fd);
    } catch {
      // The response path is already terminal; a duplicate/late close is safe.
    }
  };

  const serveContainedOssFile = (
    requestPath: string,
    req: Request,
    res: Response,
    next: NextFunction,
  ): void => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      next();
      return;
    }

    let opened: ReturnType<typeof openContainedStaticReadFile>;
    try {
      opened = openContainedStaticReadFile({
        rootDirectory: ossDir,
        requestPath,
      });
    } catch (error) {
      if (error instanceof LocalOssThumbnailPathError) {
        res.status(400).send({
          code: error.code,
          message: "资源路径无效",
        });
        return;
      }
      throw error;
    }
    if (!opened) {
      next();
      return;
    }

    res.status(200);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "public, max-age=0");
    res.setHeader("ETag", opened.etag);
    res.setHeader("Last-Modified", new Date(opened.mtimeMs).toUTCString());
    res.type(path.extname(opened.resolvedPath) || "application/octet-stream");

    if (req.method === "GET" && req.fresh) {
      closeOssDescriptor(opened.fd);
      res.status(304);
      res.removeHeader("Content-Length");
      res.end();
      return;
    }

    let range: OssByteRange | undefined;
    if (
      req.method === "GET"
      && typeof req.headers.range === "string"
      && ifRangeMatches(
        typeof req.headers["if-range"] === "string"
          ? req.headers["if-range"]
          : req.headers["if-range"] === undefined
            ? undefined
            : "",
        opened,
      )
    ) {
      const parsedRange = parseOssByteRange(req.headers.range, opened.size);
      if (parsedRange.kind === "unsatisfiable") {
        closeOssDescriptor(opened.fd);
        res
          .status(416)
          .setHeader("Content-Range", `bytes */${opened.size}`)
          .end();
        return;
      }
      if (parsedRange.kind === "range") {
        range = parsedRange.value;
        res.status(206);
        res.setHeader(
          "Content-Range",
          `bytes ${range.start}-${range.end}/${opened.size}`,
        );
        res.setHeader("Content-Length", String(range.end - range.start + 1));
      }
    }
    if (!range) {
      res.setHeader("Content-Length", String(opened.size));
    }

    if (req.method === "HEAD") {
      closeOssDescriptor(opened.fd);
      res.end();
      return;
    }

    // Transfer ownership of the already-validated descriptor to the stream;
    // the pathname is never reopened after the containment proof.
    const stream = fs.createReadStream(opened.resolvedPath, {
      fd: opened.fd,
      autoClose: true,
      ...(range ? { start: range.start, end: range.end } : {}),
    });
    stream.once("error", (error) => {
      if (!res.headersSent) {
        next(error);
        return;
      }
      res.destroy(error);
    });
    res.once("close", () => stream.destroy());
    stream.pipe(res);
  };

  const serveOriginalOssFile = (
    req: Request,
    res: Response,
    next: NextFunction,
  ): void => serveContainedOssFile(req.path, req, res, next);

  const ossRequestPathForFile = (filePath: string): string => {
    const relative = path.relative(ossDir, filePath);
    return `/${relative
      .split(path.sep)
      .map((segment) => encodeURIComponent(segment))
      .join("/")}`;
  };

  app.use(
    "/oss",
    (req, res, next) => {
      try {
        const resolvedPath = resolveContainedStaticReadPath({
          rootDirectory: ossDir,
          requestPath: req.path,
        });
        const relativePath = path.relative(ossDir, resolvedPath).split(path.sep).join("/");
        if (/^\d+\/assets\/references\/[^/]+$/i.test(relativePath)
          || /^feedback(?:\/|$)/i.test(relativePath)) {
          res.setHeader("Cache-Control", "private, no-store, max-age=0");
          res.setHeader("Pragma", "no-cache");
          res.setHeader("X-Content-Type-Options", "nosniff");
          return res.status(404).send({ message: "资源不存在" });
        }
        return next();
      } catch (error) {
        if (error instanceof LocalOssThumbnailPathError) {
          return res.status(400).send({
            code: error.code,
            message: "资源路径无效",
          });
        }
        throw error;
      }
    },
    (req, res, next) => {
      // Recovery is allowed to read the original evidence only. Thumbnail
      // generation would turn a GET into a filesystem write before the HTTP
      // recovery fence runs.
      if (isRecoveryOnlyMode()) {
        next();
        return;
      }
      // The only shipped thumbnail contract is `?size=20` (20 percent).
      // Keeping this finite prevents anonymous callers from manufacturing an
      // unbounded cache-key space. HEAD and non-GET methods never create files.
      if (req.method === "GET" && req.query.size !== undefined) {
        const size = typeof req.query.size === "string"
          ? req.query.size.trim()
          : "";
        if (size !== "20") {
          res.status(400).send({
            code: "LOCAL_OSS_THUMBNAIL_SIZE_UNSUPPORTED",
            message: "不支持的缩略图尺寸",
          });
          return;
        }
        const sizeSubDir = "20p";
        const sizeOpts: ThumbnailSize = { type: "percentage", value: 20 };

        let originalPath: string;
        let smallImagePath: string;
        try {
          const resolved = resolveLocalOssThumbnailPaths({
            ossDirectory: ossDir,
            requestPath: req.path,
            sizeKey: sizeSubDir,
          });
          originalPath = resolved.originalPath;
          smallImagePath = resolved.thumbnailPath;
        } catch (error) {
          if (error instanceof LocalOssThumbnailPathError) {
            res.status(400).send({
              code: error.code,
              message: "缩略图路径无效",
            });
            return;
          }
          throw error;
        }

        ensureThumbnail(originalPath, smallImagePath, sizeOpts)
          .then((thumbnailPath) => {
            if (thumbnailPath) {
              serveContainedOssFile(
                ossRequestPathForFile(thumbnailPath),
                req,
                res,
                next,
              );
            } else {
              // 缩略图生成失败，降级返回原图
              serveOriginalOssFile(req, res, next);
            }
          })
          .catch((err) => {
            // 缩略图生成异常：不能让请求悬挂，降级返回原图
            logRuntimeFilesystemFailure(
              "[thumbnail] ensureThumbnail failed",
              err,
            );
            serveOriginalOssFile(req, res, next);
          });
        return;
      }
      next();
    },
    // Canvas/final-render videos are returned as public /oss URLs. Browsers
    // need byte ranges for seeking; descriptor-backed delivery also proves
    // that ordinary and recovery reads cannot follow a raced symlink outside
    // the configured object root.
    serveOriginalOssFile,
  );
  // skills 静态资源
  const skillsDir = u.getPath("skills");
  if (!fs.existsSync(skillsDir) && !isRecoveryOnlyMode()) {
    fs.mkdirSync(skillsDir, { recursive: true });
  }
  logRuntimePath("文件目录:", skillsDir);
  // 只允许图片文件访问
  app.use(
    "/skills",
    (req, res, next) => {
      if (!isRecoveryOnlyMode()) return next();
      try {
        resolveContainedStaticReadPath({
          rootDirectory: skillsDir,
          requestPath: req.path,
        });
        return next();
      } catch (error) {
        if (error instanceof LocalOssThumbnailPathError) {
          return res.status(400).send({
            code: error.code,
            message: "恢复证据路径无效",
          });
        }
        throw error;
      }
    },
    (req, res, next) => {
      /\.(jpe?g|png|gif|webp|svg|ico|bmp)$/i.test(req.path) ? next() : res.status(403).end();
    },
    express.static(skillsDir, {
      acceptRanges: false,
      dotfiles: "deny",
      index: false,
      redirect: false,
    }),
  );

  // assets 静态资源
  const assetsDir = u.getPath("assets");
  if (!fs.existsSync(assetsDir) && !isRecoveryOnlyMode()) {
    fs.mkdirSync(assetsDir, { recursive: true });
  }
  logRuntimePath("文件目录:", assetsDir);
  app.use(
    "/assets",
    (req, res, next) => {
      if (!isRecoveryOnlyMode()) return next();
      try {
        resolveContainedStaticReadPath({
          rootDirectory: assetsDir,
          requestPath: req.path,
        });
        return next();
      } catch (error) {
        if (error instanceof LocalOssThumbnailPathError) {
          return res.status(400).send({
            code: error.code,
            message: "恢复证据路径无效",
          });
        }
        throw error;
      }
    },
    express.static(assetsDir, {
      acceptRanges: false,
      dotfiles: "deny",
      index: false,
      redirect: false,
    }),
  );

  // data/web 静态网站
  const webDir = getWebPath();
  if (isRecoveryOnlyMode()) {
    console.log("恢复候选不托管 Web 制品，仅使用独立前端验收服务");
  } else if (fs.existsSync(webDir)) {
    logRuntimePath("静态网站目录:", webDir);
    let precompressionReady = false;
    try {
      const precompression = await precompressWebAssets(webDir);
      precompressionReady = true;
      console.log(`静态网站预压缩: generated=${precompression.compressed}, current=${precompression.current}`);
    } catch (err: any) {
      logRuntimeFilesystemFailure("静态网站预压缩失败:", err);
    }
    if (precompressionReady) app.use(precompressedStaticMiddleware(webDir));
    app.use(webStaticMiddleware(webDir));
  } else {
    logRuntimePath("静态网站目录不存在:", webDir, { level: "warn" });
  }

  // 中转站保护：流式超时（在路由之前生效）
  app.use(streamingTimeout);

  // 0.1.4：租户目录 db 模式时按数据库运行时快照解析 Host（严格 fail-closed）；
  // 默认 env 模式沿用 0.1.3 环境变量解析，行为完全兼容。
  app.use(commercialTenantContextMiddlewareV2);
  // 多域名发布的零费用 SSE 传输探针。该端点必须经过租户 Host 解析和
  // release drain fence，但不创建模型任务、账单或持久化记录；单帧发送后
  // 立即关闭，避免把发布验活变成长期匿名连接。
  app.get("/api/health/stream", (req, res) => {
    const tenant = (req as any).commercialTenant;
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-store, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    res.write(`event: ready\ndata: ${JSON.stringify({
      ok: true,
      tenantId: String(tenant?.id || ""),
      release: getReleaseIdentity(),
    })}\n\n`);
    res.end();
  });
  app.use(authMiddleware);
  app.use(adminAutomationMiddleware);
  // This endpoint is inert (404) in ordinary runtimes. An isolated candidate
  // launcher installs an in-memory Ed25519 authority after binding its exact
  // session, checkpoint and SQLite inode; evidence runners then prove that the
  // loopback API answering their reads is that same process.
  app.get(
    "/api/internal/candidate-runtime-attestation",
    candidateRuntimeAttestationHandler,
  );
  app.use(candidateRuntimeReadResponseAttestationMiddleware);
  app.get(
    "/api/internal/candidate-runtime-database-attestation",
    candidateReadonlyDatabaseConnectionProbeHandler,
  );
  // API Key 与登录态创作请求共享平台全局/模型限流，避免 session
  // 绕过只存在于 apiKeyAuth 内的 per-key 保护。
  app.use(relayRateLimitMiddleware);
  // 创作台统一计费上下文：把登录态的工作区/用户透传给深层 u.Ai 调用。
  // 模型连通性测试等管理诊断路径（/api/setting/vendorConfig/modelTest）不参与扣费。
  app.use((req: Request, res: Response, next: NextFunction) => {
    const auth = (req as any).auth;
    const apiKey = (req as any).apiKey;
    const skip = req.path.startsWith("/api/setting/vendorConfig/modelTest");
    runBillingContext(
      {
        workspaceId: auth?.workspaceId ?? apiKey?.workspaceId ?? null,
        userId: auth?.user?.id ?? null,
        projectId: Number((req.body as any)?.projectId || (req.query as any)?.projectId) || null,
        requestId: String((req as any).requestId || res.getHeader("X-Request-Id") || "") || null,
        skipBilling: skip,
      },
      next,
    );
  });
  app.use(guardProjectScopedRoutes);
  app.use(membershipHttpGuard);
  app.use(adminOperationPolicyMiddleware);
  app.use(adminOperationAuditMiddleware());
  app.use(adminStepUpMiddleware);
  const realtimeHttpAuth = apiKeyAuth({ optional: true, permission: "relay:text" });
  // express-ws handlers receive (ws, req, next), whereas ordinary Express
  // middleware receives (req, res, next). Adapt the auth failure response to a
  // WebSocket policy close instead of accidentally treating `ws` as Request.
  const realtimeAuth = (ws: any, req: Request, next: NextFunction) => {
    let statusCode = 401;
    const authResponse = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      send(payload: any) {
        const message = String(payload?.message || `WebSocket authentication failed (${statusCode})`).slice(0, 40);
        ws.close(statusCode === 429 ? 1013 : 1008, message);
        return this;
      },
    } as unknown as Response;
    void Promise.resolve(realtimeHttpAuth(req, authResponse, next)).catch(next);
  };
  (app as any).ws("/v1/realtime", realtimeAuth, handleRealtimeWs);

  const router = await import("@/router");
  await router.default(app);

  // 404 处理
  app.use((_, res, next: NextFunction) => {
    return res.status(404).send({ message: "API 404 Not Found" });
  });

  // 错误日志中间件 - 记录所有未处理的错误
  app.use(errorLoggerMiddleware);

  // 错误处理
  app.use((err: any, req: Request, res: Response, __: NextFunction) => {
    res.locals.message = err.message;
    res.locals.error = err;
    const status = err.status || 500;
    if (process.env.NODE_ENV === "prod") {
      return res.status(status).send({
        message: status >= 500 ? "服务器内部错误" : err.message || "请求失败",
      });
    }
    res.status(status).send({
      message: err?.message || "请求失败",
      name: err?.name,
      stack: err?.stack,
      requestId: res.getHeader("X-Request-Id"),
      path: req.path,
    });
  });

  const port = parsePort(randomPort);
  const bindHost = candidateRuntimeBindHost();
  return await new Promise((resolve, reject) => {
    const onListening = async () => {
      const address = server.address();
      const realPort = typeof address === "string" ? address : address?.port;
      try {
        assertCandidateRuntimeServerAddress(
          typeof address === "string" ? null : address?.address,
        );
      } catch (error) {
        server.close(() => reject(error));
        return;
      }
      console.log(`[服务启动成功]: http://localhost:${realPort}`);
      pinoLogger.info({
        port: realPort,
        env: process.env.NODE_ENV,
        processRole: process.env.FANJIN_PROCESS_ROLE,
        httpSurface,
        version: typeof __APP_VERSION__ === "undefined" ? "dev" : __APP_VERSION__,
        release: getReleaseIdentity(),
      }, `Server started on port ${realPort}`);
      emitFormalCandidateReadinessHandshake();
      resolve(realPort);
    };
    server.once("error", reject);
    if (bindHost) server.listen(port, bindHost, onListening);
    else server.listen(port, onListening);
  });
}

function websocketDrainTimeoutMs(): number {
  const configured = Number(process.env.FANJIN_WEBSOCKET_DRAIN_TIMEOUT_MS || 5_000);
  return Number.isFinite(configured) && configured >= 100 ? configured : 5_000;
}

function closeHttpListener(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error?: Error) => {
      if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(error);
      else resolve();
    });
    // Do not let idle keep-alive sockets consume the application drain window.
    server.closeIdleConnections?.();
  });
}

function closeRealtimeWebSocketServer(): Promise<void> {
  const wss = realtimeWsInstance.getWss();
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(forceTimer);
      if (error) reject(error);
      else resolve();
    };
    const forceTimer = setTimeout(() => {
      for (const client of wss.clients) client.terminate();
    }, websocketDrainTimeoutMs());
    forceTimer.unref?.();
    for (const client of wss.clients) client.close(1012, "server shutting down");
    wss.close(finish);
  });
}

function beginHttpDrain(): Promise<void> {
  runtimeShuttingDown = true;
  // server.close() is invoked before any await, so the process stops accepting
  // new HTTP work before waiting for workers or existing requests to finish.
  const httpDrain = closeHttpListener();
  server.off("upgrade", forwardRealtimeUpgrade);
  const io = socketServer;
  socketServer = null;
  const socketIoDrain = io ? io.close().then(() => undefined) : Promise.resolve();
  const realtimeAccountingDrain = stopRelayRealtimeConnections();
  const realtimeSocketDrain = closeRealtimeWebSocketServer();
  return Promise.all([httpDrain, socketIoDrain, realtimeAccountingDrain, realtimeSocketDrain]).then(() => undefined);
}

async function stopBackgroundWorkers(): Promise<void> {
  // Evaluating this array invokes every stop method before the first await, so
  // all pollers cease claiming work immediately and then drain concurrently.
  stopBackupScheduler();
  await Promise.all([
    stopToolsWorker(),
    stopRelayTaskWorker(),
    stopRelayCallbackDeliveryWorker(),
    stopBillingReconciliationWorker(),
    stopCacheStorageBillingWorker(),
    stopGiftGrantExpiryWorker(),
    stopDataRetentionWorker(),
    stopDeletionWorker(),
    stopConfiguredAgentRuntimeWorkerService(),
    stopStoryboardImageTaskWorker(),
    stopPortraitPreflightWorker(),
    stopPortraitSourceRecoveryWorker(),
    stopPortraitProviderRuntimeWorker(),
    stopTenantDomainOperationRecoveryWorker(),
    stopUserFeedbackSyncWorker(),
  ]);
}

async function startRecoveryBackgroundWorkers(): Promise<void> {
  try {
    startRelayTaskWorker();
    startStoryboardImageTaskWorker();
  } catch (error) {
    await stopRecoveryBackgroundWorkers();
    throw error;
  }
}

async function stopRecoveryBackgroundWorkers(): Promise<void> {
  await Promise.all([
    stopRelayTaskWorker(),
    stopStoryboardImageTaskWorker(),
  ]);
}

async function startBackgroundWorkers(): Promise<void> {
  // Deletion and durable object-write recovery are release-critical. Do not
  // advertise the aggregate Worker heartbeat until their first DB poll and
  // compensation pass have completed and written a dedicated heartbeat.
  await startDeletionWorker(db as any);
  try {
    await startTenantDomainOperationRecoveryWorker();
    startToolsWorker();
    startRelayTaskWorker();
    startRelayCallbackDeliveryWorker();
    startGiftGrantExpiryWorker();
    startMembershipGrantWorker();
    startBillingReconciliationWorker();
    startCacheStorageBillingWorker(db);
    startDataRetentionWorker();
    startUserFeedbackSyncWorker(db);
    startConfiguredAgentRuntimeWorkerService();
    startStoryboardImageTaskWorker();
    // Historical schema-40 image/video rows must acquire an exact Fanjin
    // object digest before any detector, provider request, task, or billing.
    startPortraitSourceRecoveryWorker(db);
    // Only face/identity admission runs here; content is reviewed by the generation provider.
    startPortraitPreflightWorker();
    startPortraitProviderRuntimeWorker();
    startBackupScheduler();
  } catch (error) {
    await stopBackgroundWorkers();
    throw error;
  }
}

function startBackupScheduler(): void {
  if (process.env.FANJIN_DISABLE_BACKUP_SCHEDULER === "1") return;
  try {
    backupScheduler.startBackupScheduler(db);
  } catch (error) {
    console.warn("备份调度器启动失败:", error);
  }
}

function stopBackupScheduler(): void {
  try {
    backupScheduler.stopBackupScheduler();
  } catch (error) {
    console.warn("备份调度器停止失败:", error);
  }
}

export type WorkerRedisStartupRuntime = Pick<RedisCacheRuntime, "start" | "probe">;

/** Dedicated Workers have no HTTP readiness endpoint, so they must fail before
 * registering a heartbeat or claiming work when mandatory Redis is unsafe or
 * unreachable. API processes still expose transient connectivity failures via
 * /api/ready, while both paths share RedisCacheRuntime.start() topology checks. */
export async function assertWorkerRedisStartup(
  redis: WorkerRedisStartupRuntime = redisCache,
): Promise<void> {
  await redis.start();
  const probe = await redis.probe();
  if (probe.required && (
    !probe.configured
    || !probe.ready
    || probe.status !== "ready"
  )) {
    throw new RedisUnavailableError("Worker 必需 Redis 未就绪");
  }
}

// 支持await关闭
export function closeServe(): Promise<void> {
  if (serveShutdownPromise) return serveShutdownPromise;
  const recoveryOnly = isRecoveryOnlyMode();
  serveShutdownPromise = (async () => {
    const httpDrain = beginHttpDrain();
    const workerDrain = beginRecoveryAwareWorkerShutdown({
      recoveryOnly,
      beginHeartbeatShutdown: beginWorkerHeartbeatShutdown,
      stopRecoveryWork: stopRecoveryBackgroundWorkers,
      stopHeartbeatManagedWork: stopBackgroundWorkers,
      stopHeartbeat: stopWorkerHeartbeat,
    });
    await Promise.all([
      httpDrain,
      workerDrain,
      drainOperationalObservabilityCollector(),
    ]);
    await redisCache.close();
    console.log("[服务已关闭]");
  })();
  return serveShutdownPromise;
}

export async function startWorkerProcess(): Promise<void> {
  // Worker role ownership is asserted before the database wait, Redis probe,
  // heartbeat file, or background work can claim readiness.
  assertProductionPrestartRuntimeClaim(
    process.env,
    typeof __APP_VERSION__ === "undefined" ? "dev" : __APP_VERSION__,
  );
  const role = parseProcessRole();
  if (!shouldStartWorker(role)) {
    throw new Error(`当前服务角色为 ${role}，不能启动后台任务服务`);
  }
  if (process.env.FANJIN_DISABLE_RELAY_WORKER === "1") {
    throw new Error("当前为 worker 角色，但 FANJIN_DISABLE_RELAY_WORKER=1，后台任务服务不会启动");
  }
  if (isRecoveryOnlyMode()) {
    throw new Error("RECOVERY_ONLY_DEDICATED_WORKER_FORBIDDEN");
  }
  await dbReady;
  await assertWorkerRedisStartup();
  await startWorkerHeartbeat(db as any, {
    startWork: startBackgroundWorkers,
    stopWork: stopBackgroundWorkers,
  });
  emitFormalCandidateReadinessHandshake();
  console.log(`[后台任务服务启动成功]: role=${role}`);
  pinoLogger.info({
    processRole: role,
    env: process.env.NODE_ENV,
    version: typeof __APP_VERSION__ === "undefined" ? "dev" : __APP_VERSION__,
  }, `Background worker started`);
}

export async function stopWorkerProcess(): Promise<void> {
  runtimeShuttingDown = true;
  if (isRecoveryOnlyMode()) {
    await stopRecoveryBackgroundWorkers();
    await redisCache.close();
    console.log("[恢复后台任务服务已关闭]");
    return;
  }
  beginWorkerHeartbeatShutdown();
  await stopBackgroundWorkers();
  await stopWorkerHeartbeat();
  await redisCache.close();
  console.log("[后台任务服务已关闭]");
  pinoLogger.info("Background worker stopped");
}

let gracefulShutdownStarted = false;

function installGracefulShutdown(role: ProcessRole): void {
  const shutdown = (signal: "SIGINT" | "SIGTERM") => {
    if (gracefulShutdownStarted) return;
    gracefulShutdownStarted = true;
    console.log(`[服务收到 ${signal}，开始安全关闭]`);
    pinoLogger.info({ signal, timeoutMs: process.env.FANJIN_SHUTDOWN_TIMEOUT_MS || 30_000 }, `Graceful shutdown initiated`);
    const configuredTimeout = Number(process.env.FANJIN_SHUTDOWN_TIMEOUT_MS || 30_000);
    const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout >= 1_000 ? configuredTimeout : 30_000;
    const forceExit = setTimeout(() => {
      console.error("[服务安全关闭超时]");
      pinoLogger.error({ timeoutMs }, "Graceful shutdown timeout, forcing exit");
      process.exit(1);
    }, timeoutMs);

    const closing = shouldStartHttp(role) ? closeServe() : stopWorkerProcess();
    void (async () => {
      try {
        await closing;
        // Tests call closeServe() repeatedly in one process, so pool teardown is
        // deliberately process-signal-only. All HTTP/WS/worker DB users have
        // drained by this point.
        await (db as any).destroy?.();
        clearTimeout(forceExit);
        pinoLogger.info("Graceful shutdown completed");
        process.exit(0);
      } catch (error) {
        clearTimeout(forceExit);
        console.error("[服务安全关闭失败]", error instanceof Error ? error.name : "UnknownError");
        pinoLogger.error({ err: error }, "Graceful shutdown failed");
        process.exit(1);
      }
    })();
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

if (process.env.FANJIN_DISABLE_AUTO_START !== "1") {
  const role = parseProcessRole();
  installGracefulShutdown(role);
  const startup = shouldStartHttp(role) ? startServe() : startWorkerProcess();
  void startup.catch((error) => {
    // A rejected top-level startup promise must be observable by Docker, PM2,
    // systemd, and release scripts. Merely logging an unhandled rejection lets
    // a process with no listener/worker exit with status 0 and masks a failed
    // database connection or migration check as a successful deployment.
    console.error("[服务启动失败]", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
