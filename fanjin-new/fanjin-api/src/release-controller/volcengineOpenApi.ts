import { createHash, createHmac } from "node:crypto";

const ALGORITHM = "HMAC-SHA256";
const TERMINATOR = "request";
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const MAX_QUERY_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 120_000;
const ALLOWED_CLB_ACTIONS = new Set([
  "DescribeServerGroupAttributes",
  "ModifyServerGroupAttributes",
  "DescribeListenerHealth",
  "DescribeListenerAttributes",
  "ModifyListenerAttributes",
  "DescribeRules",
  "ModifyRules",
]);

/**
 * 0.1.4 ALB action allowlist（设计文档 §11/§26）：
 * 仅覆盖发布器滚动发布所需的最小 ALB 动作面。
 */
const ALLOWED_ALB_ACTIONS = new Set([
  "DescribeLoadBalancerAttributes",
  "DescribeListeners",
  "DescribeListenerAttributes",
  "ModifyListenerAttributes",
  "DescribeListenerHealth",
  "DescribeServerGroups",
  "DescribeServerGroupAttributes",
  "ModifyServerGroupAttributes",
  "DescribeServerGroupBackendServers",
  "ModifyServerGroupBackendServers",
  "AddServerGroupBackendServers",
  "RemoveServerGroupBackendServers",
  "DescribeRules",
  "ModifyRules",
  "CreateRules",
  "DeleteRules",
  "DescribeCertificates",
]);

function allowedActionsForService(serviceName: string): Set<string> {
  if (serviceName === "clb") return ALLOWED_CLB_ACTIONS;
  if (serviceName === "alb") return ALLOWED_ALB_ACTIONS;
  return new Set<string>();
}

type QueryScalar = string | number | boolean | null | undefined;
type QueryValue = QueryScalar | readonly QueryScalar[];
type QueryRecord = Readonly<Record<string, unknown>>;

export type VolcengineOpenApiFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface VolcengineOpenApiServiceOptions {
  accessKeyId: string;
  secretKey: string;
  sessionToken?: string;
  region: string;
  host: string;
  serviceName: string;
  protocol?: "https:";
  defaultVersion?: string;
  fetch?: VolcengineOpenApiFetch;
  now?: () => Date;
}

export interface VolcengineCreateApiOptions {
  Version?: string;
  method?: string;
}

export interface VolcengineApiCallOptions {
  /** Accepted for compatibility with the former SDK; the registered action wins. */
  Action?: string;
  timeout?: number;
  signal?: AbortSignal;
}

export interface VolcengineV4SignInput {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
  service: string;
  method: "GET" | "POST";
  pathname: string;
  query: Readonly<Record<string, QueryValue>>;
  at: Date;
  /** POST 请求体的 SHA-256 hex；GET 请求固定为空串（空载荷哈希）。 */
  payloadHash?: string;
}

export interface VolcengineV4SignResult {
  authorization: string;
  canonicalQuery: string;
  canonicalRequest: string;
  credentialScope: string;
  dateTime: string;
  headers: Readonly<Record<string, string>>;
  signature: string;
  signedHeaders: string;
  stringToSign: string;
}

export class VolcengineOpenApiError extends Error {
  readonly code: string;
  readonly httpStatus?: number;

  constructor(code: string, message: string, httpStatus?: number) {
    super(message);
    this.name = "VolcengineOpenApiError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function assertSafeToken(value: string, name: string, maximum: number): string {
  if (!value || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new VolcengineOpenApiError("VOLC_CONFIG_INVALID", `${name} has an invalid format`);
  }
  return value;
}

function validateAccessKeyId(value: string): string {
  const normalized = assertSafeToken(value.trim(), "accessKeyId", 256);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]+$/.test(normalized)) {
    throw new VolcengineOpenApiError("VOLC_CONFIG_INVALID", "accessKeyId has an invalid format");
  }
  return normalized;
}

function validateSecret(value: string): string {
  if (!value || value.length > 4_096 || value.includes("\0")) {
    throw new VolcengineOpenApiError("VOLC_CONFIG_INVALID", "secretAccessKey has an invalid format");
  }
  return value;
}

function validateRegion(value: string): string {
  const normalized = value.trim();
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(normalized)) {
    throw new VolcengineOpenApiError("VOLC_CONFIG_INVALID", "region has an invalid format");
  }
  return normalized;
}

function validateService(value: string): string {
  const normalized = value.trim();
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(normalized)) {
    throw new VolcengineOpenApiError("VOLC_CONFIG_INVALID", "serviceName has an invalid format");
  }
  return normalized;
}

function validateAction(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z][A-Za-z0-9]{1,127}$/.test(normalized)) {
    throw new VolcengineOpenApiError("VOLC_API_INVALID", "OpenAPI action has an invalid format");
  }
  return normalized;
}

function validateActionRequest(
  serviceName: string,
  action: string,
  requestData: Record<string, unknown>,
): void {
  if (action !== "ModifyListenerAttributes") return;
  if (serviceName === "alb") {
    const invalid = () => { throw new VolcengineOpenApiError("VOLC_API_INVALID", "ALB listener update requires indexed, explicit SNI operations only"); };
    if (typeof requestData.ListenerId !== "string" || !/^lsn-[A-Za-z0-9-]{1,120}$/.test(requestData.ListenerId)) invalid();
    const groups = new Map<number, Record<string, unknown>>();
    for (const key of Reflect.ownKeys(requestData)) {
      if (key === "ListenerId") continue;
      const match = typeof key === "string" ? /^DomainExtensions\.([1-9][0-9]?)\.(Action|DomainExtensionId|Domain|CertificateSource|CertCenterCertificateId)$/.exec(key) : null;
      if (!match) invalid();
      const index = Number(match![1]); if (index > 20) invalid();
      const entry = groups.get(index) ?? {}; entry[match![2]!] = requestData[key as string]; groups.set(index, entry);
    }
    if (!groups.size || [...groups.keys()].sort((a,b)=>a-b).some((v,i)=>v!==i+1)) invalid();
    for (const entry of groups.values()) {
      const id = typeof entry.DomainExtensionId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/.test(entry.DomainExtensionId);
      if (entry.Action === "delete") {
        if (!id || Object.keys(entry).sort().join(",") !== "Action,DomainExtensionId") invalid();
        continue;
      }
      if (!["create", "modify"].includes(String(entry.Action)) || (entry.Action === "modify" && !id)
          || (entry.Action === "create" && entry.DomainExtensionId !== undefined)
          || typeof entry.Domain !== "string" || !/^(?=.{1,128}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(entry.Domain)
          || entry.CertificateSource !== "cert_center" || typeof entry.CertCenterCertificateId !== "string"
          || !/^[A-Za-z0-9][A-Za-z0-9._:-]{1,255}$/.test(entry.CertCenterCertificateId)) invalid();
    }
    return;
  }
  const keys = Reflect.ownKeys(requestData);
  if (
    keys.length !== 2
    || keys.some((key) => typeof key !== "string")
    || !keys.includes("ListenerId")
    || !keys.includes("Enabled")
  ) {
    throw new VolcengineOpenApiError(
      "VOLC_API_INVALID",
      "ModifyListenerAttributes accepts exactly ListenerId and Enabled",
    );
  }
  const listenerId = requestData.ListenerId;
  if (
    typeof listenerId !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/.test(listenerId)
  ) {
    throw new VolcengineOpenApiError(
      "VOLC_API_INVALID",
      "ModifyListenerAttributes ListenerId has an invalid format",
    );
  }
  if (requestData.Enabled !== "on" && requestData.Enabled !== "off") {
    throw new VolcengineOpenApiError(
      "VOLC_API_INVALID",
      "ModifyListenerAttributes Enabled must be exactly on or off",
    );
  }
}

function validateVersion(value: string): string {
  const normalized = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new VolcengineOpenApiError("VOLC_API_INVALID", "OpenAPI version has an invalid format");
  }
  return normalized;
}

function validateHost(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9.-]+(?::\d{1,5})?$/.test(normalized)) {
    throw new VolcengineOpenApiError("VOLC_CONFIG_INVALID", "OpenAPI host has an invalid format");
  }
  let parsed: URL;
  try {
    parsed = new URL(`https://${normalized}`);
  } catch {
    throw new VolcengineOpenApiError("VOLC_CONFIG_INVALID", "OpenAPI host has an invalid format");
  }
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new VolcengineOpenApiError("VOLC_CONFIG_INVALID", "OpenAPI host has an invalid format");
  }
  if (parsed.port && (Number(parsed.port) < 1 || Number(parsed.port) > 65_535)) {
    throw new VolcengineOpenApiError("VOLC_CONFIG_INVALID", "OpenAPI host port is out of range");
  }
  return normalized;
}

/**
 * CLB is a regional OpenAPI service. A configured host is only an assertion
 * of the endpoint derived from the signing region; it must never redirect a
 * production mutation/read client to the global or another regional host.
 */
export function resolveVolcengineClbRegionalHost(
  region: string,
  configuredHost?: string,
): string {
  const normalizedRegion = validateRegion(region);
  const expectedHost = `clb.${normalizedRegion}.volcengineapi.com`;
  if (configuredHost === undefined) return expectedHost;
  if (validateHost(configuredHost) !== expectedHost) {
    throw new VolcengineOpenApiError(
      "VOLC_CONFIG_INVALID",
      "CLB OpenAPI host must match the exact regional endpoint",
    );
  }
  return expectedHost;
}

/**
 * 0.1.4 ALB 也是区域化 OpenAPI 服务，host 必须与签名 region 派生的端点一致。
 */
export function resolveVolcengineAlbRegionalHost(
  region: string,
  configuredHost?: string,
): string {
  const normalizedRegion = validateRegion(region);
  const expectedHost = `alb.${normalizedRegion}.volcengineapi.com`;
  if (configuredHost === undefined) return expectedHost;
  if (validateHost(configuredHost) !== expectedHost) {
    throw new VolcengineOpenApiError(
      "VOLC_CONFIG_INVALID",
      "ALB OpenAPI host must match the exact regional endpoint",
    );
  }
  return expectedHost;
}

function validatePathname(value: string): string {
  if (!value.startsWith("/") || value.includes("?") || value.includes("#") || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new VolcengineOpenApiError("VOLC_API_INVALID", "OpenAPI pathname has an invalid format");
  }
  return value;
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function queryScalar(value: unknown, key: string): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  throw new VolcengineOpenApiError(
    "VOLC_API_INVALID",
    `OpenAPI query parameter ${key} must be a finite scalar or scalar array`,
  );
}

export function canonicalVolcengineQuery(query: QueryRecord): string {
  const pairs: Array<readonly [string, string]> = [];
  for (const [rawKey, rawValue] of Object.entries(query)) {
    if (!rawKey || rawKey.length > 256 || /[\u0000-\u001f\u007f]/.test(rawKey)) {
      throw new VolcengineOpenApiError("VOLC_API_INVALID", "OpenAPI query parameter name is invalid");
    }
    const key = encodeRfc3986(rawKey);
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    if (values.length > 1_000) {
      throw new VolcengineOpenApiError("VOLC_API_INVALID", `OpenAPI query parameter ${rawKey} has too many values`);
    }
    for (const raw of values) pairs.push([key, encodeRfc3986(queryScalar(raw, rawKey))]);
  }
  pairs.sort(([leftKey, leftValue], [rightKey, rightValue]) => {
    if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1;
    if (leftValue === rightValue) return 0;
    return leftValue < rightValue ? -1 : 1;
  });
  const result = pairs.map(([key, value]) => `${key}=${value}`).join("&");
  if (Buffer.byteLength(result, "utf8") > MAX_QUERY_BYTES) {
    throw new VolcengineOpenApiError("VOLC_API_INVALID", "OpenAPI query exceeds the bounded size limit");
  }
  return result;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

function dateTime(at: Date): string {
  if (!(at instanceof Date) || !Number.isFinite(at.getTime())) {
    throw new VolcengineOpenApiError("VOLC_CLOCK_INVALID", "signing clock returned an invalid date");
  }
  return at.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function canonicalHeaderValue(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Volcano Engine V4 header signing for the bounded GET-only CLB call surface.
 *
 * This intentionally matches @volcengine/openapi 1.36.2's official Signer
 * contract: X-Date (and optional X-Security-Token) are signed, GET uses the
 * SHA-256 of an empty payload, and the key ladder ends in `request`.
 */
export function signVolcengineV4(input: VolcengineV4SignInput): VolcengineV4SignResult {
  const accessKeyId = validateAccessKeyId(input.accessKeyId);
  const secretAccessKey = validateSecret(input.secretAccessKey);
  const region = validateRegion(input.region);
  const service = validateService(input.service);
  const pathname = validatePathname(input.pathname);
  const timestamp = dateTime(input.at);
  const date = timestamp.slice(0, 8);
  const credentialScope = `${date}/${region}/${service}/${TERMINATOR}`;
  const canonicalQuery = canonicalVolcengineQuery(input.query);
  const payloadHash = input.method === "POST"
    ? (input.payloadHash && /^[a-f0-9]{64}$/.test(input.payloadHash)
      ? input.payloadHash
      : EMPTY_SHA256)
    : EMPTY_SHA256;
  const headers: Record<string, string> = { "X-Date": timestamp };
  if (input.method === "POST") headers["X-Content-Sha256"] = payloadHash;
  if (input.sessionToken !== undefined) {
    headers["X-Security-Token"] = assertSafeToken(input.sessionToken, "sessionToken", 8_192);
  }
  const normalizedHeaders = Object.entries(headers)
    .map(([key, value]) => [key.toLowerCase(), canonicalHeaderValue(value)] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  const canonicalHeaders = normalizedHeaders.map(([key, value]) => `${key}:${value}`).join("\n");
  const signedHeaders = normalizedHeaders.map(([key]) => key).join(";");
  const canonicalRequest = [
    input.method,
    pathname,
    canonicalQuery,
    `${canonicalHeaders}\n`,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const stringToSign = [
    ALGORITHM,
    timestamp,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const keyDate = hmac(secretAccessKey, date);
  const keyRegion = hmac(keyDate, region);
  const keyService = hmac(keyRegion, service);
  const signingKey = hmac(keyService, TERMINATOR);
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");
  const authorization = `${ALGORITHM} Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return Object.freeze({
    authorization,
    canonicalQuery,
    canonicalRequest,
    credentialScope,
    dateTime: timestamp,
    headers: Object.freeze({ ...headers, Authorization: authorization }),
    signature,
    signedHeaders,
    stringToSign,
  });
}

function timeoutMilliseconds(value: unknown): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > MAX_TIMEOUT_MS) {
    throw new VolcengineOpenApiError("VOLC_API_INVALID", "OpenAPI timeout is out of range");
  }
  return Number(value);
}

async function boundedResponseText(response: Response): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsed = Number(declaredLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_RESPONSE_BYTES) {
      throw new VolcengineOpenApiError("VOLC_API_RESPONSE_TOO_LARGE", "OpenAPI response exceeds the size limit");
    }
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new VolcengineOpenApiError("VOLC_API_RESPONSE_TOO_LARGE", "OpenAPI response exceeds the size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new VolcengineOpenApiError("VOLC_API_INVALID_RESPONSE", "OpenAPI response is not valid UTF-8");
  }
}

/**
 * Small compatibility surface for the former SDK's Service#createAPI.
 * Only the bounded CLB/ALB actions used by the release controller and its
 * isolated trusted maintenance-rule provider are in scope.
 */
export class Service {
  private readonly accessKeyId: string;
  private readonly secretAccessKey: string;
  private readonly sessionToken?: string;
  private readonly region: string;
  private readonly host: string;
  private readonly serviceName: string;
  private readonly defaultVersion?: string;
  private readonly fetchFn: VolcengineOpenApiFetch;
  private readonly now: () => Date;

  constructor(options: VolcengineOpenApiServiceOptions) {
    if (options.protocol !== undefined && options.protocol !== "https:") {
      throw new VolcengineOpenApiError("VOLC_CONFIG_INVALID", "OpenAPI protocol must be https");
    }
    this.accessKeyId = validateAccessKeyId(options.accessKeyId);
    this.secretAccessKey = validateSecret(options.secretKey);
    this.sessionToken = options.sessionToken === undefined
      ? undefined
      : assertSafeToken(options.sessionToken, "sessionToken", 8_192);
    this.region = validateRegion(options.region);
    this.serviceName = validateService(options.serviceName);
    this.host = this.serviceName === "clb"
      ? resolveVolcengineClbRegionalHost(this.region, options.host)
      : this.serviceName === "alb"
        ? resolveVolcengineAlbRegionalHost(this.region, options.host)
        : validateHost(options.host);
    this.defaultVersion = options.defaultVersion === undefined
      ? undefined
      : validateVersion(options.defaultVersion);
    this.fetchFn = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  createAPI<RequestData extends Record<string, unknown>, Result = unknown>(
    actionInput: string,
    createOptions: VolcengineCreateApiOptions = {},
  ): (
    requestData: RequestData,
    callOptions?: VolcengineApiCallOptions,
  ) => Promise<Result> {
    const action = validateAction(actionInput);
    if (!allowedActionsForService(this.serviceName).has(action)) {
      throw new VolcengineOpenApiError(
        "VOLC_API_UNSUPPORTED",
        "OpenAPI action is outside the release-controller CLB/ALB allowlist",
      );
    }
    const method = (createOptions.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "POST") {
      throw new VolcengineOpenApiError(
        "VOLC_API_UNSUPPORTED",
        "minimal Volcengine OpenAPI client only supports signed GET/POST requests",
      );
    }
    if (method === "POST" && this.serviceName !== "alb") {
      throw new VolcengineOpenApiError(
        "VOLC_API_UNSUPPORTED",
        "signed POST requests are only enabled for the ALB service surface",
      );
    }
    const version = validateVersion(createOptions.Version ?? this.defaultVersion ?? "");

    return async (requestData: RequestData, callOptions: VolcengineApiCallOptions = {}): Promise<Result> => {
      if (requestData === null || typeof requestData !== "object" || Array.isArray(requestData)) {
        throw new VolcengineOpenApiError("VOLC_API_INVALID", "OpenAPI request data must be an object");
      }
      validateActionRequest(this.serviceName, action, requestData);
      const query: Record<string, QueryValue> = {
        Action: action,
        Version: version,
      };
      let payload: string | undefined;
      let payloadHash: string | undefined;
      if (method === "POST") {
        payload = JSON.stringify(requestData);
        payloadHash = createHash("sha256").update(payload, "utf8").digest("hex");
      } else {
        Object.assign(query, requestData as Record<string, QueryValue>);
      }
      const signed = signVolcengineV4({
        accessKeyId: this.accessKeyId,
        secretAccessKey: this.secretAccessKey,
        sessionToken: this.sessionToken,
        region: this.region,
        service: this.serviceName,
        method: method as "GET" | "POST",
        pathname: "/",
        query,
        at: this.now(),
        payloadHash,
      });
      const url = `https://${this.host}/?${signed.canonicalQuery}`;
      const timeoutMs = timeoutMilliseconds(callOptions.timeout);
      const controller = new AbortController();
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      const callerSignal = callOptions.signal;
      const onCallerAbort = () => controller.abort();
      if (callerSignal?.aborted) controller.abort();
      else callerSignal?.addEventListener("abort", onCallerAbort, { once: true });

      try {
        const response = await this.fetchFn(url, {
          method,
          headers: {
            ...signed.headers,
            "Content-Type": method === "POST"
              ? "application/json"
              : "application/x-www-form-urlencoded",
          },
          body: payload,
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
          signal: controller.signal,
        });
        const body = await boundedResponseText(response);
        if (!response.ok) {
          throw new VolcengineOpenApiError(
            "VOLC_API_HTTP_ERROR",
            `OpenAPI request failed with HTTP ${response.status}`,
            response.status,
          );
        }
        try {
          return JSON.parse(body) as Result;
        } catch {
          throw new VolcengineOpenApiError(
            "VOLC_API_INVALID_RESPONSE",
            "OpenAPI response is not valid JSON",
            response.status,
          );
        }
      } catch (error) {
        if (error instanceof VolcengineOpenApiError) throw error;
        if (timedOut) {
          throw new VolcengineOpenApiError("VOLC_API_TIMEOUT", "OpenAPI request exceeded its timeout");
        }
        if (callerSignal?.aborted) {
          throw new VolcengineOpenApiError("VOLC_API_ABORTED", "OpenAPI request was aborted");
        }
        throw new VolcengineOpenApiError("VOLC_API_REQUEST_FAILED", "OpenAPI request failed");
      } finally {
        clearTimeout(timeout);
        callerSignal?.removeEventListener("abort", onCallerAbort);
      }
    };
  }
}
