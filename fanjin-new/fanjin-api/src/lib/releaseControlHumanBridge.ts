import { createHash, createPrivateKey, createPublicKey, randomUUID, type KeyObject } from "node:crypto";
import { readFile } from "node:fs/promises";
import jwt from "jsonwebtoken";
import { Agent, request, type Dispatcher } from "undici";

export const RELEASE_CONTROL_HUMAN_SCOPES = [
  "release.plan.create",
  "release.read",
  "release.authorize.production",
  "release.execute.production",
  "release.cancel.production",
  "release.unit.web",
  "release.unit.api",
  "release.unit.worker",
  "release.unit.controller",
  "release.migration",
] as const;

export type ReleaseControlHumanScope = (typeof RELEASE_CONTROL_HUMAN_SCOPES)[number];

const MAX_UPSTREAM_RESPONSE_BYTES = 2_097_152;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_TOKEN_TTL_SECONDS = 60;
const SAFE_KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const SAFE_HUMAN_PATH = /^\/v1\/human\/(?:plans|executions|release-candidates|modular\/(?:impact-preview|plans|executions))(?:[/?]|$)/;

export class ReleaseControlBridgeError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(code: string, message: string, status = 503) {
    super(message);
    this.name = "ReleaseControlBridgeError";
    this.status = status;
    this.code = code;
  }
}

export interface ReleaseControlHumanAuthority {
  readonly issuer: string;
  readonly audience: string;
  readonly keyId: string;
  readonly jwks: Readonly<{ keys: readonly Readonly<Record<string, unknown>>[] }>;
  issue(input: {
    userId: number;
    sessionId: string;
    scopes: readonly ReleaseControlHumanScope[];
    mfaVerified: boolean;
  }): string;
}

export interface ReleaseControlBridgeRuntime {
  readonly baseUrl: URL;
  readonly authority: ReleaseControlHumanAuthority;
  readonly dispatcher: Dispatcher;
  readonly requestTimeoutMs: number;
}

export interface ReleaseControlProxyResponse {
  readonly status: number;
  readonly payload: unknown;
  readonly requestId: string | null;
}

function requiredEnvironment(environment: NodeJS.ProcessEnv, name: string): string {
  const value = String(environment[name] ?? "").trim();
  if (!value) {
    throw new ReleaseControlBridgeError(
      "RELEASE_CONTROL_BRIDGE_CONFIG_MISSING",
      `发布器身份桥缺少配置 ${name}`,
      503,
    );
  }
  return value;
}

function exactHttpsUrl(value: string, label: string, allowPath: boolean): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ReleaseControlBridgeError(
      "RELEASE_CONTROL_BRIDGE_CONFIG_INVALID",
      `${label} 必须是有效 HTTPS URL`,
      503,
    );
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || (!allowPath && parsed.pathname !== "/")
  ) {
    throw new ReleaseControlBridgeError(
      "RELEASE_CONTROL_BRIDGE_CONFIG_INVALID",
      `${label} 必须是无凭据、无查询参数的 HTTPS URL`,
      503,
    );
  }
  return parsed;
}

function positiveInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const value = Number(raw ?? String(fallback));
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ReleaseControlBridgeError(
      "RELEASE_CONTROL_BRIDGE_CONFIG_INVALID",
      `${label} 必须是 ${minimum}-${maximum} 的整数`,
      503,
    );
  }
  return value;
}

async function readLimitedUpstreamBody(body: Dispatcher.ResponseData["body"]): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    for await (const chunk of body) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_UPSTREAM_RESPONSE_BYTES) {
        body.destroy();
        throw new ReleaseControlBridgeError(
          "RELEASE_CONTROL_UPSTREAM_RESPONSE_TOO_LARGE",
          "独立发布器响应超过安全上限",
          502,
        );
      }
      chunks.push(bytes);
    }
  } catch (error) {
    if (error instanceof ReleaseControlBridgeError) throw error;
    throw new ReleaseControlBridgeError(
      "RELEASE_CONTROL_UPSTREAM_RESPONSE_INVALID",
      "读取独立发布器响应失败",
      502,
    );
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

function normalizeScopes(scopes: readonly ReleaseControlHumanScope[]): ReleaseControlHumanScope[] {
  const values = [...new Set(scopes)];
  if (
    values.length < 1
    || values.some((scope) => !RELEASE_CONTROL_HUMAN_SCOPES.includes(scope))
  ) {
    throw new ReleaseControlBridgeError(
      "RELEASE_CONTROL_BRIDGE_SCOPE_INVALID",
      "发布器身份桥请求了未允许的作用域",
      500,
    );
  }
  return values;
}

export function createReleaseControlHumanAuthority(input: {
  issuer: string;
  audience: string;
  keyId: string;
  privateKey: string | Buffer;
  tokenTtlSeconds?: number;
}): ReleaseControlHumanAuthority {
  const issuer = exactHttpsUrl(input.issuer, "OIDC issuer", true).toString().replace(/\/$/, "");
  const audience = String(input.audience || "").trim();
  const keyId = String(input.keyId || "").trim();
  if (!audience || audience.length > 256 || !SAFE_KEY_ID.test(keyId)) {
    throw new ReleaseControlBridgeError(
      "RELEASE_CONTROL_BRIDGE_CONFIG_INVALID",
      "OIDC audience 或 key id 无效",
      503,
    );
  }
  const tokenTtlSeconds = positiveInteger(
    input.tokenTtlSeconds == null ? undefined : String(input.tokenTtlSeconds),
    DEFAULT_TOKEN_TTL_SECONDS,
    30,
    120,
    "OIDC token TTL",
  );
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(input.privateKey);
  } catch {
    throw new ReleaseControlBridgeError(
      "RELEASE_CONTROL_BRIDGE_SIGNING_KEY_INVALID",
      "发布器 OIDC 私钥无法解析",
      503,
    );
  }
  if (
    privateKey.asymmetricKeyType !== "rsa"
    || Number(privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
  ) {
    throw new ReleaseControlBridgeError(
      "RELEASE_CONTROL_BRIDGE_SIGNING_KEY_INVALID",
      "发布器 OIDC 私钥必须是至少 2048 位的 RSA 私钥",
      503,
    );
  }
  const publicJwk = createPublicKey(privateKey).export({ format: "jwk" });
  const jwk = Object.freeze({
    ...publicJwk,
    kid: keyId,
    use: "sig",
    alg: "RS256",
  }) as Readonly<Record<string, unknown>>;
  const jwks = Object.freeze({ keys: Object.freeze([jwk]) });

  return Object.freeze({
    issuer,
    audience,
    keyId,
    jwks,
    issue(identity: {
      userId: number;
      sessionId: string;
      scopes: readonly ReleaseControlHumanScope[];
      mfaVerified: boolean;
    }) {
      const userId = Number(identity.userId);
      const sessionId = String(identity.sessionId || "").trim();
      if (!Number.isSafeInteger(userId) || userId < 1 || !sessionId || sessionId.length > 128) {
        throw new ReleaseControlBridgeError(
          "RELEASE_CONTROL_BRIDGE_IDENTITY_INVALID",
          "当前 Fanjin 身份无法签发发布器令牌",
          401,
        );
      }
      const scopes = normalizeScopes(identity.scopes);
      return jwt.sign({
        scope: scopes.join(" "),
        amr: identity.mfaVerified ? ["mfa"] : ["pwd"],
        // Keep the release audit identity stable across short-lived bridge
        // tokens without disclosing the Fanjin session identifier itself.
        sid: `fanjin-session:${createHash("sha256").update(sessionId).digest("hex")}`,
      }, privateKey, {
        algorithm: "RS256",
        issuer,
        audience,
        subject: `fanjin-user:${userId}`,
        jwtid: randomUUID(),
        keyid: keyId,
        expiresIn: tokenTtlSeconds,
        notBefore: -5,
        header: { typ: "JWT", alg: "RS256", kid: keyId },
      });
    },
  });
}

export async function loadReleaseControlBridgeRuntime(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ReleaseControlBridgeRuntime> {
  const baseUrl = exactHttpsUrl(
    requiredEnvironment(environment, "FANJIN_RELEASE_CONTROL_INTERNAL_URL"),
    "发布器内部地址",
    false,
  );
  const [privateKey, serverCa] = await Promise.all([
    readFile(requiredEnvironment(environment, "FANJIN_RELEASE_CONTROL_OIDC_PRIVATE_KEY_FILE")),
    readFile(requiredEnvironment(environment, "FANJIN_RELEASE_CONTROL_SERVER_CA_FILE")),
  ]).catch(() => {
    throw new ReleaseControlBridgeError(
      "RELEASE_CONTROL_BRIDGE_SECRET_UNAVAILABLE",
      "发布器身份桥密钥或 CA 文件不可用",
      503,
    );
  });
  const serverName = String(environment.FANJIN_RELEASE_CONTROL_TLS_SERVER_NAME ?? "").trim();
  const dispatcher = new Agent({
    connect: {
      ca: serverCa,
      rejectUnauthorized: true,
      ...(serverName ? { servername: serverName } : {}),
    },
    connections: 8,
    pipelining: 1,
  });
  return Object.freeze({
    baseUrl,
    authority: createReleaseControlHumanAuthority({
      issuer: requiredEnvironment(environment, "FANJIN_RELEASE_CONTROL_OIDC_ISSUER"),
      audience: requiredEnvironment(environment, "FANJIN_RELEASE_CONTROL_OIDC_AUDIENCE"),
      keyId: requiredEnvironment(environment, "FANJIN_RELEASE_CONTROL_OIDC_KEY_ID"),
      privateKey,
      tokenTtlSeconds: positiveInteger(
        environment.FANJIN_RELEASE_CONTROL_OIDC_TOKEN_TTL_SECONDS,
        DEFAULT_TOKEN_TTL_SECONDS,
        30,
        120,
        "OIDC token TTL",
      ),
    }),
    dispatcher,
    requestTimeoutMs: positiveInteger(
      environment.FANJIN_RELEASE_CONTROL_REQUEST_TIMEOUT_MS,
      DEFAULT_REQUEST_TIMEOUT_MS,
      1_000,
      30_000,
      "发布器请求超时",
    ),
  });
}

let configuredRuntime: Promise<ReleaseControlBridgeRuntime> | null = null;

export function getConfiguredReleaseControlBridgeRuntime(): Promise<ReleaseControlBridgeRuntime> {
  configuredRuntime ??= loadReleaseControlBridgeRuntime().catch((error) => {
    configuredRuntime = null;
    throw error;
  });
  return configuredRuntime;
}

function safeHumanPath(path: string): string {
  const value = String(path || "");
  if (
    !SAFE_HUMAN_PATH.test(value)
    || value.includes("..")
    || value.includes("#")
    || /[\r\n]/.test(value)
  ) {
    throw new ReleaseControlBridgeError(
      "RELEASE_CONTROL_BRIDGE_PATH_REJECTED",
      "发布器身份桥拒绝了非白名单路径",
      500,
    );
  }
  return value;
}

function safeIdempotencyKey(value: string | null | undefined): string | null {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;
  if (!SAFE_IDEMPOTENCY_KEY.test(normalized)) {
    throw new ReleaseControlBridgeError(
      "RELEASE_CONTROL_IDEMPOTENCY_KEY_INVALID",
      "Idempotency-Key 格式无效",
      400,
    );
  }
  return normalized;
}

export async function proxyReleaseControlHumanRequest(
  runtime: ReleaseControlBridgeRuntime,
  input: {
    method: "GET" | "POST";
    path: string;
    token: string;
    body?: unknown;
    idempotencyKey?: string | null;
  },
): Promise<ReleaseControlProxyResponse> {
  const path = safeHumanPath(input.path);
  const token = String(input.token || "").trim();
  if (!token) {
    throw new ReleaseControlBridgeError(
      "RELEASE_CONTROL_BRIDGE_IDENTITY_INVALID",
      "发布器内部令牌缺失",
      500,
    );
  }
  const idempotencyKey = safeIdempotencyKey(input.idempotencyKey);
  const body = input.method === "POST" ? JSON.stringify(input.body ?? {}) : undefined;
  const url = new URL(path, runtime.baseUrl);
  let response: Dispatcher.ResponseData;
  try {
    response = await request(url, {
      method: input.method,
      dispatcher: runtime.dispatcher,
      headersTimeout: runtime.requestTimeoutMs,
      bodyTimeout: runtime.requestTimeoutMs,
      signal: AbortSignal.timeout(runtime.requestTimeoutMs),
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        ...(body ? { "content-type": "application/json" } : {}),
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      },
      body,
    });
  } catch {
    throw new ReleaseControlBridgeError(
      "RELEASE_CONTROL_UPSTREAM_UNAVAILABLE",
      "独立发布器暂不可用",
      503,
    );
  }
  const text = await readLimitedUpstreamBody(response.body);
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new ReleaseControlBridgeError(
      "RELEASE_CONTROL_UPSTREAM_RESPONSE_INVALID",
      "独立发布器返回了无效响应",
      502,
    );
  }
  const requestIdValue = response.headers["x-request-id"];
  const requestId = Array.isArray(requestIdValue)
    ? String(requestIdValue[0] ?? "")
    : String(requestIdValue ?? "");
  return {
    status: response.statusCode,
    payload,
    requestId: /^[A-Za-z0-9-]{1,128}$/.test(requestId) ? requestId : null,
  };
}
