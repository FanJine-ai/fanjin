import fs from "node:fs";
import path from "node:path";
import axios, { type AxiosRequestConfig } from "axios";
import type { Knex } from "knex";
import rawVendorData from "@/lib/vendor.json";
import getPath from "@/utils/getPath";
import { assertProviderDispatchAllowed } from "@/lib/relayChannelCredential";

export const VENDOR_VM_CAPABILITY = "model-api-v1";
export const VENDOR_VM_CAPABILITY_MANIFEST =
  `// @fanjin-vendor-capabilities: ${VENDOR_VM_CAPABILITY}`;
export const VENDOR_VM_SOURCE_POLICY_ERROR =
  "VENDOR_VM_SOURCE_POLICY_FORBIDDEN";

export const VENDOR_VM_NETWORK_ERROR = {
  invalidRequest: "VENDOR_VM_NETWORK_REQUEST_INVALID",
  methodForbidden: "VENDOR_VM_NETWORK_METHOD_FORBIDDEN",
  bodyForbidden: "VENDOR_VM_NETWORK_BODY_FORBIDDEN",
  storageTargetForbidden: "VENDOR_VM_STORAGE_TARGET_FORBIDDEN",
  requestFailed: "VENDOR_VM_NETWORK_REQUEST_FAILED",
} as const;

type VendorVmNetworkErrorCode =
  (typeof VENDOR_VM_NETWORK_ERROR)[keyof typeof VENDOR_VM_NETWORK_ERROR];

export class VendorVmNetworkPolicyError extends Error {
  readonly code: VendorVmNetworkErrorCode;

  constructor(code: VendorVmNetworkErrorCode) {
    super(code);
    this.name = "VendorVmNetworkPolicyError";
    this.code = code;
  }
}

interface VendorVmNetworkRequest {
  url: unknown;
  method?: unknown;
  headers?: unknown;
  body?: unknown;
}

const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST"]);
const SIGNED_QUERY_KEYS = new Set([
  "awsaccesskeyid",
  "googleaccessid",
  "ossaccesskeyid",
  "x-amz-algorithm",
  "x-amz-credential",
  "x-amz-signature",
  "x-goog-algorithm",
  "x-goog-credential",
  "x-goog-signature",
  "x-oss-signature",
  "x-tos-algorithm",
  "x-tos-credential",
  "x-tos-signature",
]);

function policyError(code: VendorVmNetworkErrorCode): never {
  throw new VendorVmNetworkPolicyError(code);
}

function normalizeHeaders(raw: unknown): Headers {
  try {
    if (!raw) return new Headers();
    if (
      typeof raw === "object"
      && raw !== null
      && "toJSON" in raw
      && typeof (raw as { toJSON?: unknown }).toJSON === "function"
    ) {
      return new Headers(
        (raw as { toJSON(): Record<string, string> }).toJSON(),
      );
    }
    return new Headers(raw as HeadersInit);
  } catch {
    return policyError(VENDOR_VM_NETWORK_ERROR.invalidRequest);
  }
}

function normalizeTarget(raw: unknown): URL {
  try {
    const value = raw instanceof URL
      ? raw.href
      : typeof raw === "string"
        ? raw
        : typeof raw === "object"
          && raw !== null
          && "url" in raw
          ? String((raw as { url: unknown }).url)
          : "";
    const target = new URL(value);
    if (
      !["http:", "https:"].includes(target.protocol)
      || target.username
      || target.password
    ) {
      return policyError(VENDOR_VM_NETWORK_ERROR.invalidRequest);
    }
    return target;
  } catch (error) {
    if (error instanceof VendorVmNetworkPolicyError) throw error;
    return policyError(VENDOR_VM_NETWORK_ERROR.invalidRequest);
  }
}

function isKnownObjectStorageHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return (
    /(?:^|\.)s3(?:[.-][a-z0-9-]+)*\.amazonaws\.com$/.test(host)
    || /(?:^|\.)tos(?:-s3)?(?:[.-][a-z0-9-]+)*\.volces\.com$/.test(host)
    || /(?:^|\.)oss(?:[.-][a-z0-9-]+)*\.aliyuncs\.com$/.test(host)
    || /(?:^|\.)storage\.googleapis\.com$/.test(host)
  );
}

function hasStorageSignature(target: URL, headers: Headers): boolean {
  for (const key of target.searchParams.keys()) {
    if (SIGNED_QUERY_KEYS.has(key.toLowerCase())) return true;
  }
  for (const key of SIGNED_QUERY_KEYS) {
    if (headers.has(key)) return true;
  }
  const authorization = headers.get("authorization") || "";
  return /^(?:AWS|AWS4-HMAC-SHA256|TOS4-HMAC-SHA256)\b/i.test(
    authorization.trim(),
  );
}

function hasMethodOverride(target: URL, headers: Headers): boolean {
  const headerValue = headers.get("x-http-method-override")
    || headers.get("x-method-override")
    || "";
  if (
    headerValue
    && !ALLOWED_METHODS.has(headerValue.trim().toUpperCase())
  ) {
    return true;
  }
  for (const key of ["_method", "x-http-method-override"]) {
    const value = target.searchParams.get(key);
    if (value && !ALLOWED_METHODS.has(value.trim().toUpperCase())) return true;
  }
  return false;
}

function isJsonMediaType(contentType: string): boolean {
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json"
    || /^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(mediaType);
}

function isJsonCompatibleBody(body: unknown): boolean {
  if (body === undefined || body === null) return true;
  if (typeof body === "string") {
    if (!body.trim()) return true;
    try {
      JSON.parse(body);
      return true;
    } catch {
      return false;
    }
  }
  if (
    typeof body === "number"
    || typeof body === "boolean"
    || Array.isArray(body)
  ) {
    return true;
  }
  if (typeof body !== "object") return false;
  if (
    body instanceof ArrayBuffer
    || ArrayBuffer.isView(body)
    || (typeof Blob !== "undefined" && body instanceof Blob)
    || (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams)
    || (typeof ReadableStream !== "undefined" && body instanceof ReadableStream)
  ) {
    return false;
  }
  const candidate = body as Record<string, unknown>;
  if (
    typeof candidate.getBoundary === "function"
    || typeof candidate.getHeaders === "function"
    || String((candidate as any)[Symbol.toStringTag] || "").toLowerCase()
      === "formdata"
  ) {
    return false;
  }
  const prototype = Object.getPrototypeOf(body);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Enforces the only raw network contract available to persisted vendor code.
 * It deliberately returns no target details so callers cannot reflect signed
 * URLs or credentials through policy failures.
 */
export function assertVendorVmNetworkRequest(
  request: VendorVmNetworkRequest,
): void {
  try {
    const method = String(request.method ?? "GET").trim().toUpperCase();
    if (!ALLOWED_METHODS.has(method)) {
      policyError(VENDOR_VM_NETWORK_ERROR.methodForbidden);
    }
    const target = normalizeTarget(request.url);
    const headers = normalizeHeaders(request.headers);
    if (
      isKnownObjectStorageHost(target.hostname)
      || hasStorageSignature(target, headers)
    ) {
      policyError(VENDOR_VM_NETWORK_ERROR.storageTargetForbidden);
    }
    if (headers.has("host") || hasMethodOverride(target, headers)) {
      policyError(VENDOR_VM_NETWORK_ERROR.methodForbidden);
    }
    if (method !== "POST") return;

    const contentType = headers.get("content-type") || "";
    if (
      /multipart\/form-data|application\/x-www-form-urlencoded|application\/octet-stream/i
        .test(contentType)
      || (contentType && !isJsonMediaType(contentType))
      || !isJsonCompatibleBody(request.body)
    ) {
      policyError(VENDOR_VM_NETWORK_ERROR.bodyForbidden);
    }
  } catch (error) {
    if (error instanceof VendorVmNetworkPolicyError) throw error;
    policyError(VENDOR_VM_NETWORK_ERROR.invalidRequest);
  }
}

function asStableNetworkFailure(error: unknown): never {
  if (error instanceof VendorVmNetworkPolicyError) throw error;
  return policyError(VENDOR_VM_NETWORK_ERROR.requestFailed);
}

export function createVendorVmFetch(
  transport: typeof fetch = globalThis.fetch,
): typeof fetch {
  const safeFetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    assertProviderDispatchAllowed();
    let safeInit: RequestInit;
    try {
      const inputRequest =
        typeof Request !== "undefined" && input instanceof Request
          ? input
          : null;
      const headers = new Headers(inputRequest?.headers);
      new Headers(init?.headers).forEach((value, key) => {
        headers.set(key, value);
      });
      const body = init?.body ?? inputRequest?.body;
      const method = String(
        init?.method ?? inputRequest?.method ?? "GET",
      ).trim().toUpperCase();
      assertVendorVmNetworkRequest({
        url: inputRequest?.url ?? input,
        method,
        headers,
        body,
      });
      if (
        method === "POST"
        && body !== undefined
        && body !== null
        && typeof body !== "string"
      ) {
        policyError(VENDOR_VM_NETWORK_ERROR.bodyForbidden);
      }
      safeInit = {
        method,
        headers,
        ...(init?.body !== undefined ? { body: init.body } : {}),
        ...(init?.signal ? { signal: init.signal } : {}),
        // A 307/308 redirect could otherwise turn an approved model POST into
        // an object-store write without a second policy decision.
        redirect: "error",
      };
    } catch (error) {
      if (error instanceof VendorVmNetworkPolicyError) throw error;
      policyError(VENDOR_VM_NETWORK_ERROR.invalidRequest);
    }
    try {
      return await transport(input, safeInit);
    } catch (error) {
      return asStableNetworkFailure(error);
    }
  };
  return Object.freeze(safeFetch) as typeof fetch;
}

type AxiosTransport = {
  request(config: AxiosRequestConfig): Promise<unknown>;
};

type VendorVmAxios = ((
  configOrUrl: AxiosRequestConfig | string,
  config?: AxiosRequestConfig,
) => Promise<unknown>) & {
  request(config: AxiosRequestConfig): Promise<unknown>;
  get(url: string, config?: AxiosRequestConfig): Promise<unknown>;
  head(url: string, config?: AxiosRequestConfig): Promise<unknown>;
  post(
    url: string,
    data?: unknown,
    config?: AxiosRequestConfig,
  ): Promise<unknown>;
  put(): Promise<never>;
  patch(): Promise<never>;
  delete(): Promise<never>;
};

function normalizeAxiosParameters(
  params: unknown,
): Record<string, unknown> | URLSearchParams | undefined {
  if (params === undefined || params === null) return undefined;
  let entries: Array<[string, unknown]>;
  const isUrlSearchParams = params instanceof URLSearchParams;
  try {
    if (isUrlSearchParams) {
      entries = [...params.entries()];
    } else if (
      typeof params === "object"
      && (
        Object.getPrototypeOf(params) === Object.prototype
        || Object.getPrototypeOf(params) === null
      )
    ) {
      entries = Object.entries(params as Record<string, unknown>);
    } else {
      return policyError(VENDOR_VM_NETWORK_ERROR.invalidRequest);
    }
  } catch {
    return policyError(VENDOR_VM_NETWORK_ERROR.invalidRequest);
  }
  try {
    for (const [rawKey, rawValue] of entries) {
      const key = rawKey.trim().toLowerCase();
      if (SIGNED_QUERY_KEYS.has(key)) {
        policyError(VENDOR_VM_NETWORK_ERROR.storageTargetForbidden);
      }
      if (
        ["_method", "x-http-method-override"].includes(key)
        && !ALLOWED_METHODS.has(String(rawValue).trim().toUpperCase())
      ) {
        policyError(VENDOR_VM_NETWORK_ERROR.methodForbidden);
      }
    }
    if (isUrlSearchParams) {
      return new URLSearchParams(
        entries.map(([key, value]) => [key, String(value)]),
      );
    }
    return JSON.parse(JSON.stringify(Object.fromEntries(entries)));
  } catch (error) {
    if (error instanceof VendorVmNetworkPolicyError) throw error;
    return policyError(VENDOR_VM_NETWORK_ERROR.invalidRequest);
  }
}

function canonicalAxiosUrl(config: AxiosRequestConfig): string {
  try {
    const rawUrl = String(config.url || "");
    const target = config.baseURL
      ? new URL(rawUrl, String(config.baseURL))
      : new URL(rawUrl);
    return target.href;
  } catch {
    return policyError(VENDOR_VM_NETWORK_ERROR.invalidRequest);
  }
}

export function createVendorVmAxios(
  transport: AxiosTransport = axios,
): VendorVmAxios {
  const request = async (
    rawConfig: AxiosRequestConfig,
  ): Promise<unknown> => {
    assertProviderDispatchAllowed();
    let safeConfig: AxiosRequestConfig;
    try {
      const config = { ...rawConfig };
      const url = canonicalAxiosUrl(config);
      const method = String(config.method ?? "GET").trim().toUpperCase();
      const headers = normalizeHeaders(config.headers);
      assertVendorVmNetworkRequest({
        url,
        method,
        headers,
        body: config.data,
      });
      const params = normalizeAxiosParameters(config.params);
      let data = config.data;
      if (
        method === "POST"
        && data !== undefined
        && data !== null
        && typeof data !== "string"
      ) {
        try {
          data = JSON.parse(JSON.stringify(data));
        } catch {
          policyError(VENDOR_VM_NETWORK_ERROR.bodyForbidden);
        }
      }
      const responseType = config.responseType;
      if (
        responseType
        && !["arraybuffer", "json", "text"].includes(responseType)
      ) {
        policyError(VENDOR_VM_NETWORK_ERROR.invalidRequest);
      }
      const timeout = Number(config.timeout);
      safeConfig = {
        url,
        method,
        headers: Object.fromEntries(headers.entries()),
        ...(params !== undefined ? { params } : {}),
        ...(data !== undefined ? { data } : {}),
        ...(Number.isFinite(timeout) && timeout >= 0 ? { timeout } : {}),
        ...(responseType ? { responseType } : {}),
        maxRedirects: 0,
      };
    } catch (error) {
      if (error instanceof VendorVmNetworkPolicyError) throw error;
      policyError(VENDOR_VM_NETWORK_ERROR.invalidRequest);
    }
    try {
      return await transport.request(safeConfig);
    } catch (error) {
      return asStableNetworkFailure(error);
    }
  };
  const forbidden = async (): Promise<never> =>
    policyError(VENDOR_VM_NETWORK_ERROR.methodForbidden);
  const safeAxios = Object.assign(
    (
      configOrUrl: AxiosRequestConfig | string,
      config: AxiosRequestConfig = {},
    ) => request(
      typeof configOrUrl === "string"
        ? { ...config, url: configOrUrl }
        : configOrUrl,
    ),
    {
      request,
      get: (url: string, config: AxiosRequestConfig = {}) =>
        request({ ...config, method: "GET", url }),
      head: (url: string, config: AxiosRequestConfig = {}) =>
        request({ ...config, method: "HEAD", url }),
      post: (
        url: string,
        data?: unknown,
        config: AxiosRequestConfig = {},
      ) => request({ ...config, data, method: "POST", url }),
      put: forbidden,
      patch: forbidden,
      delete: forbidden,
    },
  );
  return Object.freeze(safeAxios);
}

export interface VendorVmSourceInspection {
  ready: boolean;
  capabilitySource: "manifest" | "bundled" | null;
  manifestCount: number;
  missingManifest: boolean;
  invalidCapabilityCount: number;
  forbiddenSourcePatternCount: number;
  rawStorageWriteDetected: boolean;
}

const BUNDLED_VENDOR_DATA = rawVendorData as Record<string, string>;
const SOURCE_LIMIT_BYTES = 1024 * 1024;

function isApprovedBundledSource(id: string, source: string): boolean {
  const bundled = BUNDLED_VENDOR_DATA[`${id}.ts`];
  if (!bundled || id === "volcengineSd2") return false;
  return bundled === source;
}

function forbiddenSourcePatterns(source: string): RegExp[] {
  const patterns = [
    /\bFormData\b/i,
    /multipart\/form-data/i,
    /\bcrypto\s*\./i,
    /\bcreate(?:Hmac|Hash|Sign|PrivateKey)\s*\(/i,
    /\baxios\s*(?:\?\.)?\s*(?:put|patch|delete)\s*\(/i,
    /\bmethod\s*:\s*["'`](?:PUT|PATCH|DELETE)["'`]/i,
    /\b(?:X-Amz|X-Tos|X-Oss)-(?:Algorithm|Credential|Signature)\b/i,
    /\b(?:AWS4-HMAC-SHA256|TOS4-HMAC-SHA256)\b/i,
    /\b(?:raw-object-upload|object-upload|storage-write)\b/i,
  ];
  return patterns.filter((pattern) => pattern.test(source));
}

/**
 * A custom persisted vendor must explicitly attest to the narrow model API
 * contract. Exact reviewed bundled sources carry the same capability
 * implicitly so an unmodified installation remains deployable.
 */
export function inspectVendorVmSource(
  id: string,
  source: string,
): VendorVmSourceInspection {
  const firstNonEmptyLine = source
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/, 256)
    .find((line) => line.trim().length > 0)
    ?.trim() || "";
  const manifestMatches = [
    ...source.slice(0, 8_192).matchAll(
      /^\s*\/\/\s*@fanjin-vendor-capabilities\s*:\s*([^\r\n]+)\s*$/gim,
    ),
  ];
  const capabilities = manifestMatches.flatMap((match) =>
    String(match[1] || "")
      .split(/[\s,]+/)
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  const invalidCapabilityCount = capabilities.filter(
    (capability) => capability !== VENDOR_VM_CAPABILITY,
  ).length + Math.max(0, manifestMatches.length - 1);
  const forbiddenPatterns = forbiddenSourcePatterns(source);
  const bundled = isApprovedBundledSource(id, source);
  const validManifest = manifestMatches.length === 1
    && capabilities.length === 1
    && capabilities[0] === VENDOR_VM_CAPABILITY
    && firstNonEmptyLine === VENDOR_VM_CAPABILITY_MANIFEST;
  const capabilitySource = validManifest
    ? "manifest"
    : bundled
      ? "bundled"
      : null;
  const rawStorageWriteDetected = forbiddenPatterns.length > 0;
  return {
    ready:
      source.length > 0
      && Buffer.byteLength(source, "utf8") <= SOURCE_LIMIT_BYTES
      && capabilitySource !== null
      && manifestMatches.length <= 1
      && invalidCapabilityCount === 0
      && forbiddenPatterns.length === 0,
    capabilitySource,
    manifestCount: manifestMatches.length,
    missingManifest: capabilitySource === null,
    invalidCapabilityCount,
    forbiddenSourcePatternCount: forbiddenPatterns.length,
    rawStorageWriteDetected,
  };
}

export interface EnabledVendorVmSafetyInspection {
  ready: boolean;
  available: boolean;
  enabledCount: number | null;
  safeCount: number | null;
  bundledCapabilityCount: number | null;
  explicitManifestCount: number | null;
  invalidIdCount: number | null;
  missingSourceCount: number | null;
  missingManifestCount: number | null;
  invalidCapabilityCount: number | null;
  forbiddenSourceCount: number | null;
  rawStorageWriteCount: number | null;
}

function unavailableVendorInspection(): EnabledVendorVmSafetyInspection {
  return {
    ready: false,
    available: false,
    enabledCount: null,
    safeCount: null,
    bundledCapabilityCount: null,
    explicitManifestCount: null,
    invalidIdCount: null,
    missingSourceCount: null,
    missingManifestCount: null,
    invalidCapabilityCount: null,
    forbiddenSourceCount: null,
    rawStorageWriteCount: null,
  };
}

async function readRegularVendorSource(
  filePath: string,
  maximumBytes: number,
): Promise<string | null> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(
      filePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > maximumBytes) {
      return null;
    }
    return await handle.readFile("utf8");
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function inspectEnabledVendorVmSources(
  database: Knex,
  options: {
    vendorDirectory?: string;
    maximumSourceBytes?: number;
  } = {},
): Promise<EnabledVendorVmSafetyInspection> {
  try {
    const rows = await database<{ id: unknown }>("o_vendorConfig")
      .where({ enable: 1 })
      .select("id");
    const vendorDirectory = path.resolve(
      options.vendorDirectory || getPath("vendor"),
    );
    const maximumSourceBytes = Math.min(
      SOURCE_LIMIT_BYTES,
      Math.max(1, Number(options.maximumSourceBytes) || SOURCE_LIMIT_BYTES),
    );
    const result: EnabledVendorVmSafetyInspection = {
      ready: false,
      available: true,
      enabledCount: rows.length,
      safeCount: 0,
      bundledCapabilityCount: 0,
      explicitManifestCount: 0,
      invalidIdCount: 0,
      missingSourceCount: 0,
      missingManifestCount: 0,
      invalidCapabilityCount: 0,
      forbiddenSourceCount: 0,
      rawStorageWriteCount: 0,
    };
    if (rows.length > 0) {
      try {
        const directoryStat = await fs.promises.lstat(vendorDirectory);
        if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
          result.missingSourceCount = rows.length;
          return result;
        }
      } catch {
        result.missingSourceCount = rows.length;
        return result;
      }
    }
    for (const row of rows) {
      const id = typeof row.id === "string" ? row.id : "";
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) {
        result.invalidIdCount! += 1;
        continue;
      }
      const source = await readRegularVendorSource(
        path.join(vendorDirectory, `${id}.ts`),
        maximumSourceBytes,
      );
      if (source === null) {
        result.missingSourceCount! += 1;
        continue;
      }
      const inspection = inspectVendorVmSource(id, source);
      if (inspection.missingManifest) result.missingManifestCount! += 1;
      if (inspection.invalidCapabilityCount > 0) {
        result.invalidCapabilityCount! += 1;
      }
      if (inspection.forbiddenSourcePatternCount > 0) {
        result.forbiddenSourceCount! += 1;
      }
      if (inspection.rawStorageWriteDetected) {
        result.rawStorageWriteCount! += 1;
      }
      if (inspection.capabilitySource === "bundled") {
        result.bundledCapabilityCount! += 1;
      } else if (inspection.capabilitySource === "manifest") {
        result.explicitManifestCount! += 1;
      }
      if (inspection.ready) result.safeCount! += 1;
    }
    result.ready = result.safeCount === result.enabledCount;
    return result;
  } catch {
    return unavailableVendorInspection();
  }
}
