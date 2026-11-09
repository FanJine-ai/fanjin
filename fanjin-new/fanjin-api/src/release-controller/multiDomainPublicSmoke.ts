import dns from "node:dns/promises";
import tls from "node:tls";
import type { Knex } from "knex";
import WebSocket from "ws";

import type {
  LoadBalancer,
  LoadBalancerBackend,
  DrainResult,
  PublicSmokeResult,
  ReleaseActionContext,
  ReleaseArtifact,
} from "@/release-controller/types";

export type RequiredSmokeTarget = {
  origin: string;
  hostname: string;
  tenantId: string;
  /** 数据库域名主键；用于把公网 runtime snapshot 精确绑定到发布 revision。 */
  domainId?: string;
  required: boolean;
  source: "database" | "environment";
  /** 域名用途（数据库目标固定自租户域名行）。 */
  purpose?: string;
  /** 域名期望 revision（数据库目标固定自租户域名行）。 */
  revision?: number | null;
};

export type MultiDomainSmokeCheckResult = {
  origin: string;
  hostname: string;
  tenantId: string;
  ok: boolean;
  failures: string[];
  checks: Array<{ id: string; label: string; passed: boolean }>;
};

export type MultiDomainSmokeResult = {
  ok: boolean;
  targets: MultiDomainSmokeCheckResult[];
  failedRequired: string[];
};

export type MultiDomainSmokeDb = Knex | { (table: string): any };

const DEFAULT_TOTAL_TIMEOUT_MS = 60_000;
const DEFAULT_STEP_TIMEOUT_MS = 8_000;
const TLS_HANDSHAKE_TIMEOUT_MS = 8_000;
const MAX_SSE_FIRST_FRAME_BYTES = 64 * 1024;
const DEFAULT_SSE_PATH = "/api/health/stream";
const DEFAULT_WS_PATH = "/socket.io/?EIO=4&transport=websocket";

/**
 * 可注入探测传输层：单元测试必须离线运行，不访问公网。
 * 未注入时使用真实 DNS/fetch/TLS/Upgrade 实现。
 */
export type SmokeProbeTransports = {
  fetchImpl?: typeof fetch;
  resolveDns?: (hostname: string) => Promise<string[]>;
  tlsConnect?: (hostname: string, port: number) => Promise<boolean>;
  webSocketPingPong?: (input: {
    origin: string;
    hostname: string;
    port: number;
    path: string;
    timeoutMs: number;
  }) => Promise<{ ok: boolean; status?: number }>;
  /** @deprecated 仅保留测试/旧调用方兼容；生产默认执行真实 ping/pong。 */
  webSocketUpgrade?: (input: {
    origin: string;
    hostname: string;
    port: number;
    path: string;
    timeoutMs: number;
  }) => Promise<{ ok: boolean; status?: number }>;
};

async function defaultResolveDns(hostname: string): Promise<string[]> {
  try {
    return await dns.resolve4(hostname);
  } catch {
    try {
      return await dns.resolve6(hostname);
    } catch {
      return [];
    }
  }
}

/**
 * 默认 WebSocket 探测：连接 Socket.IO 的 Engine.IO WebSocket transport，
 * 校验 open 帧后发送 WebSocket Ping 控制帧，并要求收到匹配 Pong。`ws` 自身还会
 * 校验 101、Sec-WebSocket-Accept 与 TLS，因此不会把只完成 Upgrade 后立即
 * 关闭的错误入口误报为可用。
 */
function defaultWebSocketPingPong(input: {
  origin: string;
  hostname: string;
  port: number;
  path: string;
  timeoutMs: number;
}): Promise<{ ok: boolean; status?: number }> {
  return new Promise((resolve) => {
    const url = new URL(input.origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.port = String(input.port);
    const path = new URL(input.path, input.origin);
    url.pathname = path.pathname;
    url.search = path.search;
    const socket = new WebSocket(url, {
      origin: new URL(input.origin).origin,
      handshakeTimeout: input.timeoutMs,
      followRedirects: false,
      maxPayload: MAX_SSE_FIRST_FRAME_BYTES,
      perMessageDeflate: false,
    });
    let settled = false;
    let engineOpened = false;
    const timer = setTimeout(() => finish(false), input.timeoutMs);
    timer.unref?.();
    const finish = (ok: boolean, status?: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.on("error", () => undefined);
      if (socket.readyState === WebSocket.OPEN) {
        socket.close(1000, "smoke complete");
      } else {
        socket.terminate();
      }
      resolve({ ok, status });
    };
    socket.on("unexpected-response", (_request, response) => finish(false, response.statusCode));
    socket.on("message", (data, isBinary) => {
      if (isBinary) return finish(false);
      const message = data.toString("utf8");
      if (!engineOpened) {
        if (!message.startsWith("0")) return finish(false);
        try {
          const opened = JSON.parse(message.slice(1));
          if (!opened || typeof opened.sid !== "string" || !opened.sid) return finish(false);
        } catch {
          return finish(false);
        }
        engineOpened = true;
        socket.ping(Buffer.from("fanjin-smoke", "utf8"));
      }
    });
    socket.on("pong", (payload) => {
      if (engineOpened && payload.toString("utf8") === "fanjin-smoke") finish(true, 101);
    });
    socket.on("error", () => finish(false));
    socket.on("close", () => finish(false));
  });
}

/**
 * 解析强制探测域名集合（设计文档 §16.3）：
 * - 数据库：active 商业租户的 active 域名（tenant_domain 生命周期 active）
 * - 环境变量 FANJIN_RELEASE_PUBLIC_SMOKE_BASE_URL 始终作为 required 目标（兼容 0.1.3）
 * - FANJIN_RELEASE_PUBLIC_SMOKE_DOMAINS_JSON 为紧急覆盖：提供时完全替代数据库集合
 * - suspended/draft/备案未完成的域名不进入强制集合
 */
export async function resolveRequiredSmokeTargets(
  database: MultiDomainSmokeDb | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RequiredSmokeTarget[]> {
  const targets: RequiredSmokeTarget[] = [];
  const overrideRaw = String(env.FANJIN_RELEASE_PUBLIC_SMOKE_DOMAINS_JSON || "").trim();
  if (overrideRaw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(overrideRaw);
    } catch {
      throw new Error("FANJIN_RELEASE_PUBLIC_SMOKE_DOMAINS_JSON must be a JSON array");
    }
    if (!Array.isArray(parsed)) {
      throw new Error("FANJIN_RELEASE_PUBLIC_SMOKE_DOMAINS_JSON must be a JSON array");
    }
    for (const item of parsed) {
      const origin = String((item as any)?.origin || "").trim();
      const tenantId = String((item as any)?.tenantId || "").trim();
      if (!origin || !tenantId) continue;
      targets.push({
        origin: normalizeOrigin(origin),
        hostname: hostnameOf(origin),
        tenantId,
        required: (item as any)?.required !== false,
        source: "environment",
      });
    }
    return dedupeTargets(targets);
  }

  if (database) {
    const rows = await (database as any)("o_tenant_domain as d")
      .join("o_commercial_tenant as t", "t.id", "d.tenantId")
      .whereNull("d.deletedAt")
      .whereNull("t.deletedAt")
      .where({ "d.lifecycleState": "active", "t.status": "active" })
      .whereNotIn("d.icpState", ["pending", "rejected"])
      .select("d.id", "d.hostname", "d.tenantId", "d.purpose", "d.desiredRevision");
    for (const row of rows) {
      const hostname = String(row.hostname || "").trim();
      const tenantId = String(row.tenantId || "").trim();
      if (!hostname || !tenantId) continue;
      targets.push({
        origin: `https://${hostname}`,
        hostname,
        tenantId,
        domainId: String(row.id),
        required: true,
        source: "database",
        purpose: String(row.purpose || "web_api"),
        revision: row.desiredRevision == null ? null : Number(row.desiredRevision),
      });
    }
  }

  const baseUrl = String(env.FANJIN_RELEASE_PUBLIC_SMOKE_BASE_URL || "").trim();
  if (baseUrl) {
    const origin = normalizeOrigin(baseUrl);
    targets.push({
      origin,
      hostname: hostnameOf(origin),
      tenantId: String(env.FANJIN_RELEASE_PUBLIC_SMOKE_EXPECTED_TENANT_ID || "FANJIN"),
      required: true,
      source: "environment",
    });
  }
  return dedupeTargets(targets);
}

function dedupeTargets(targets: RequiredSmokeTarget[]): RequiredSmokeTarget[] {
  const byOrigin = new Map<string, RequiredSmokeTarget>();
  for (const target of targets) {
    const existing = byOrigin.get(target.origin);
    if (existing) {
      byOrigin.set(target.origin, {
        ...existing,
        required: existing.required || target.required,
      });
    } else {
      byOrigin.set(target.origin, target);
    }
  }
  return [...byOrigin.values()];
}

function normalizeOrigin(origin: string): string {
  const withScheme = /^https?:\/\//i.test(origin) ? origin : `https://${origin}`;
  const url = new URL(withScheme);
  url.username = "";
  url.password = "";
  url.hash = "";
  url.search = "";
  url.pathname = "/";
  return url.toString().replace(/\/$/, "");
}

function hostnameOf(origin: string): string {
  return new URL(/^https?:\/\//i.test(origin) ? origin : `https://${origin}`).hostname;
}

/**
 * 单域名探测（设计文档 §16.3 / MT-P0-13）：
 * DNS 解析 → TLS/SNI 证书覆盖 → /api/ready + 制品一致 → 首页 → Host/租户响应头
 * → SSE 建连与完整首帧 → Engine.IO open + WebSocket ping/pong。
 * 所有网络能力可通过 transports 注入；单元测试离线运行。
 */
export async function probeSmokeTarget(
  target: RequiredSmokeTarget,
  options: {
    signal?: AbortSignal;
    stepTimeoutMs?: number;
    artifactSha256?: string;
    transports?: SmokeProbeTransports;
    allowedDnsTargets?: readonly string[];
    ssePath?: string;
    wsPath?: string;
  } = {},
): Promise<MultiDomainSmokeCheckResult> {
  const stepTimeoutMs = options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  const transports = options.transports ?? {};
  const fetchImpl = transports.fetchImpl ?? fetch;
  const checks: MultiDomainSmokeCheckResult["checks"] = [];
  const failures: string[] = [];

  // DNS 解析：必须至少返回一个地址；配置允许目标集合时必须完全落入集合。
  // IP 直连目标无需 DNS 解析（地址本身就是目标），但仍受允许集合约束。
  const resolveDns = transports.resolveDns ?? defaultResolveDns;
  const isIpLiteral = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(target.hostname)
    || target.hostname.includes(":");
  const addresses = isIpLiteral ? [target.hostname] : await resolveDns(target.hostname);
  const allowed = options.allowedDnsTargets?.length
    ? options.allowedDnsTargets.map((entry) => entry.trim()).filter(Boolean)
    : null;
  const dnsOk = addresses.length > 0
    && (allowed === null || addresses.every((address) => allowed.includes(address)));
  checks.push({
    id: "dns_resolution",
    label: allowed ? "DNS 解析到允许的入口地址" : "DNS 解析返回地址",
    passed: dnsOk,
  });
  if (!dnsOk) {
    // DNS 是后续所有公网探测的信任前提。解析缺失或指向未授权
    // 入口时立即失败，避免继续发起 TLS/HTTP/SSE/WebSocket 请求。
    failures.push("dns_resolution");
    return {
      origin: target.origin,
      hostname: target.hostname,
      tenantId: target.tenantId,
      ok: false,
      failures,
      checks,
    };
  }

  const targetUrl = new URL(target.origin);
  const isHttps = targetUrl.protocol === "https:";
  // TLS/SNI 证书覆盖检查仅对 https 源执行（生产全部为 https）。
  if (isHttps) {
    const tlsProbe = transports.tlsConnect ?? probeTlsCertificate;
    const tlsCheck = await tlsProbe(target.hostname, Number(targetUrl.port || 443));
    checks.push({ id: "tls_sni", label: "TLS 证书覆盖 SNI", passed: tlsCheck });
    if (!tlsCheck) failures.push("tls_sni");
  }

  const ready = await fetchJsonWith(fetchImpl, `${target.origin}/api/ready`, { stepTimeoutMs, signal: options.signal });
  const readyOk = ready.ok
    && ready.body?.ok === true
    && (options.artifactSha256 == null
      || String(ready.body?.release?.artifactSha256 || "") === options.artifactSha256);
  checks.push({ id: "api_ready", label: "/api/ready 就绪且制品一致", passed: readyOk });
  if (!readyOk) failures.push("api_ready");

  // /api/ready 在租户中间件之前注册，是节点级就绪端点，不能作为 Host
  // 身份证据。租户身份与 staged snapshot revision 必须从经过 Host 解析的
  // /api/runtime/tenant 读回。
  const runtimeTenant = await fetchJsonWith(fetchImpl, `${target.origin}/api/runtime/tenant`, {
    stepTimeoutMs,
    signal: options.signal,
  });
  const tenantHeaderOk = runtimeTenant.ok
    && String(runtimeTenant.headers.get("x-fanjin-commercial-tenant") || "").toUpperCase() === target.tenantId.toUpperCase()
    && String(runtimeTenant.body?.data?.id || "").toUpperCase() === target.tenantId.toUpperCase();
  checks.push({ id: "tenant_identity", label: "Host 解析后的租户响应头与载荷一致", passed: tenantHeaderOk });
  if (!tenantHeaderOk) failures.push("tenant_identity");

  if (target.domainId && Number.isSafeInteger(target.revision) && Number(target.revision) > 0) {
    const revision = String(runtimeTenant.headers.get("x-fanjin-tenant-snapshot-revision") || "");
    const revisionOk = revision.includes(`${target.domainId}:${target.revision}`);
    checks.push({ id: "tenant_revision", label: "公网租户快照包含目标域名 revision", passed: revisionOk });
    if (!revisionOk) failures.push("tenant_revision");
  }

  const homepage = await fetchTextWith(fetchImpl, `${target.origin}/`, { stepTimeoutMs, signal: options.signal });
  const homepageOk = homepage.ok && /<!doctype html|<html/i.test(homepage.body.slice(0, 2_048));
  checks.push({ id: "homepage", label: "首页 HTML 可达", passed: homepageOk });
  if (!homepageOk) failures.push("homepage");

  // SSE 建连与首帧：响应必须是 text/event-stream 且收到首个事件帧。
  const ssePath = options.ssePath ?? DEFAULT_SSE_PATH;
  const sse = await fetchSseFirstFrame(fetchImpl, `${target.origin}${ssePath}`, {
    stepTimeoutMs,
    signal: options.signal,
  });
  checks.push({ id: "sse_first_frame", label: "SSE 建连并收到首帧", passed: sse });
  if (!sse) failures.push("sse_first_frame");

  // WebSocket：除 101 握手外，必须完成 Engine.IO open + WebSocket ping/pong。
  const wsPath = options.wsPath ?? DEFAULT_WS_PATH;
  const wsProbe = transports.webSocketPingPong
    ?? transports.webSocketUpgrade
    ?? defaultWebSocketPingPong;
  const ws = await wsProbe({
    origin: target.origin,
    hostname: target.hostname,
    port: Number(targetUrl.port || (isHttps ? 443 : 80)),
    path: wsPath,
    timeoutMs: stepTimeoutMs,
  });
  checks.push({ id: "websocket_ping_pong", label: "Engine.IO open 并完成 WebSocket ping/pong", passed: ws.ok });
  if (!ws.ok) failures.push("websocket_ping_pong");

  return {
    origin: target.origin,
    hostname: target.hostname,
    tenantId: target.tenantId,
    ok: failures.length === 0,
    failures,
    checks,
  };
}

async function fetchSseFirstFrame(
  fetchImpl: typeof fetch,
  url: string,
  options: { stepTimeoutMs: number; signal?: AbortSignal },
): Promise<boolean> {
  try {
    const response = await fetchImpl(url, {
      headers: { accept: "text/event-stream", "cache-control": "no-store" },
      redirect: "error",
      signal: mergeSignal(options.signal, options.stepTimeoutMs),
    });
    if (!response.ok || !response.body) return false;
    if (!String(response.headers.get("content-type") || "").includes("text/event-stream")) return false;
    const reader = response.body.getReader();
    let buffered = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return false;
        if (!value) continue;
        buffered += Buffer.from(value).toString("utf8");
        if (Buffer.byteLength(buffered) > MAX_SSE_FIRST_FRAME_BYTES) return false;
        const boundary = buffered.search(/\r?\n\r?\n/);
        if (boundary < 0) continue;
        const frame = buffered.slice(0, boundary);
        return frame.length > 0
          && frame.split(/\r?\n/).some((line) => /^(?::|data:|event:|id:|retry:)/.test(line));
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      try {
        reader.releaseLock();
      } catch {
        // Probe closes intentionally after the first complete frame.
      }
    }
  } catch {
    return false;
  }
}

async function probeTlsCertificate(hostname: string, port = 443): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const socket = tls.connect(
      {
        host: hostname,
        port,
        servername: hostname,
        timeout: TLS_HANDSHAKE_TIMEOUT_MS,
        rejectUnauthorized: true,
      },
      () => {
        try {
          const cert = socket.getPeerCertificate();
          if (!cert || !cert.subjectaltname) {
            settled = true;
            socket.destroy();
            resolve(false);
            return;
          }
          const names = cert.subjectaltname
            .split(",")
            .map((entry) => entry.trim().replace(/^DNS:/i, ""))
            .filter(Boolean);
          const commonName = String(cert.subject?.CN || "");
          const covers = [commonName, ...names].some((pattern) => (
            pattern && hostnameMatchesCertificate(hostname, pattern)
          ));
          settled = true;
          socket.destroy();
          resolve(covers);
        } catch {
          settled = true;
          socket.destroy();
          resolve(false);
        }
      },
    );
    socket.on("error", () => {
      if (settled) return;
      settled = true;
      resolve(false);
    });
    socket.on("timeout", () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(false);
    });
  });
}

function hostnameMatchesCertificate(hostname: string, pattern: string): boolean {
  if (pattern === hostname) return true;
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1);
    return hostname.endsWith(suffix) && hostname.length > suffix.length;
  }
  return false;
}

async function fetchJsonWith(
  fetchImpl: typeof fetch,
  url: string,
  options: { stepTimeoutMs: number; signal?: AbortSignal },
): Promise<{ ok: boolean; body: any; headers: Headers }> {
  try {
    const response = await fetchImpl(url, {
      headers: { accept: "application/json", "cache-control": "no-store" },
      redirect: "error",
      signal: mergeSignal(options.signal, options.stepTimeoutMs),
    });
    const body = await response.json().catch(() => null);
    return { ok: response.ok, body, headers: response.headers };
  } catch {
    return { ok: false, body: null, headers: new Headers() };
  }
}

async function fetchTextWith(
  fetchImpl: typeof fetch,
  url: string,
  options: { stepTimeoutMs: number; signal?: AbortSignal },
): Promise<{ ok: boolean; body: string }> {
  try {
    const response = await fetchImpl(url, {
      headers: { accept: "text/html", "cache-control": "no-store" },
      redirect: "error",
      signal: mergeSignal(options.signal, options.stepTimeoutMs),
    });
    const body = await response.text().catch(() => "");
    return { ok: response.ok, body: body.slice(0, 65_536) };
  } catch {
    return { ok: false, body: "" };
  }
}

function mergeSignal(callerSignal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
  if (!callerSignal) {
    // 只保留定时器；fetch 完成后自动失效。
    setTimeout(() => clearTimeout(timer), timeoutMs + 1_000);
    return timeoutController.signal;
  }
  const combined = AbortSignal.any?.([callerSignal, timeoutController.signal]);
  return combined ?? timeoutController.signal;
}

/**
 * 多域名探测：所有 required 目标必须全部通过。
 */
export async function runMultiDomainPublicSmoke(input: {
  targets: readonly RequiredSmokeTarget[];
  signal?: AbortSignal;
  totalTimeoutMs?: number;
  stepTimeoutMs?: number;
  artifactSha256?: string;
  transports?: SmokeProbeTransports;
  allowedDnsTargets?: readonly string[];
  ssePath?: string;
  wsPath?: string;
}): Promise<MultiDomainSmokeResult> {
  const deadline = Date.now() + (input.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS);
  const results: MultiDomainSmokeCheckResult[] = [];
  for (const target of input.targets) {
    if (Date.now() > deadline) {
      results.push({
        origin: target.origin,
        hostname: target.hostname,
        tenantId: target.tenantId,
        ok: false,
        failures: ["deadline_exceeded"],
        checks: [],
      });
      continue;
    }
    results.push(await probeSmokeTarget(target, {
      signal: input.signal,
      stepTimeoutMs: input.stepTimeoutMs,
      artifactSha256: input.artifactSha256,
      transports: input.transports,
      allowedDnsTargets: input.allowedDnsTargets,
      ssePath: input.ssePath,
      wsPath: input.wsPath,
    }));
  }
  const failedRequired = results
    .filter((result, index) => !result.ok && input.targets[index]?.required)
    .map((result) => result.origin);
  return { ok: failedRequired.length === 0, targets: results, failedRequired };
}

/**
 * 包装任意 LoadBalancer：publicSmoke 在原有单域名 composite smoke 基础上
 * 增加多租户域名强制探测（DNS/TLS/Host/API/SSE/WS）。任一 required 域名失败
 * → 发布失败（安全恢复）。上层状态机仍只看到 LoadBalancer 接口。
 */
export class MultiDomainSmokeLoadBalancer implements LoadBalancer {
  constructor(
    public readonly inner: LoadBalancer,
    private readonly resolveTargets: () => Promise<readonly RequiredSmokeTarget[]>,
    private readonly options: {
      signal?: AbortSignal;
      totalTimeoutMs?: number;
      stepTimeoutMs?: number;
      transports?: SmokeProbeTransports;
      allowedDnsTargets?: readonly string[];
      ssePath?: string;
      wsPath?: string;
    } = {},
  ) {}

  async listBackends(context: ReleaseActionContext): Promise<readonly LoadBalancerBackend[]> {
    return await this.inner.listBackends(context);
  }

  async getBackend(nodeId: string, context: ReleaseActionContext): Promise<LoadBalancerBackend> {
    return await this.inner.getBackend(nodeId, context);
  }

  async setWeight(nodeId: string, weight: number, context: ReleaseActionContext): Promise<void> {
    return await this.inner.setWeight(nodeId, weight, context);
  }

  async waitForDrain(nodeId: string, context: ReleaseActionContext): Promise<DrainResult> {
    return await this.inner.waitForDrain(nodeId, context);
  }

  async publicSmoke(artifact: ReleaseArtifact, context: ReleaseActionContext): Promise<PublicSmokeResult> {
    const base = await this.inner.publicSmoke(artifact, context);
    const targets = await this.resolveTargets();
    if (!targets.length) return base;
    const multi = await runMultiDomainPublicSmoke({
      targets,
      signal: this.options.signal,
      totalTimeoutMs: this.options.totalTimeoutMs,
      stepTimeoutMs: this.options.stepTimeoutMs,
      artifactSha256: artifact.sha256,
      transports: this.options.transports,
      allowedDnsTargets: this.options.allowedDnsTargets,
      ssePath: this.options.ssePath,
      wsPath: this.options.wsPath,
    });
    if (base.ok && multi.ok) return base;
    return {
      ok: false,
      artifactSha256: base.artifactSha256,
      code: !base.ok
        ? (base.code || "PUBLIC_SMOKE_FAILED")
        : `MULTI_DOMAIN_SMOKE_FAILED:${multi.failedRequired.join(",")}`,
    };
  }
}
