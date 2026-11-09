import { createHash, createHmac } from "node:crypto";
import {
  resolveObjectStorageConfiguration,
  type ObjectStorageConfiguration,
} from "@/lib/objectStorageConfig";

export interface ObjectStorageAdapter {
  put(
    key: string,
    data: Buffer | Uint8Array,
    contentType?: string,
    options?: { signal?: AbortSignal },
  ): Promise<ObjectStorageWriteReceipt>;
  get(
    key: string,
    options?: { versionId?: string | null; signal?: AbortSignal },
  ): Promise<Buffer>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  deletePrefix(prefix: string): Promise<void>;
  inspectGeneration(
    key: string,
    options?: { versionId?: string | null; signal?: AbortSignal },
  ): Promise<ObjectStorageGenerationSnapshot>;
  listGenerationSnapshots(
    prefix: string,
    options?: {
      maximumObjects?: number;
      signal?: AbortSignal;
      exactKey?: boolean;
      pageTimeoutMs?: number;
    },
  ): Promise<ObjectStorageGenerationSnapshot[]>;
  /**
   * Remote adapters expose one strict provider page. It remains optional on
   * the broad adapter contract so existing in-memory/local test adapters do
   * not accidentally claim remote version-listing support.
   */
  listGenerationSnapshotPage?(
    prefix: string,
    options?: ObjectStorageGenerationSnapshotPageOptions,
  ): Promise<ObjectStorageGenerationSnapshotPage>;
  deleteGenerationIfMatch(
    key: string,
    condition: {
      etag: string | null;
      versionId?: string | null;
      deleteMarker?: boolean;
      signal?: AbortSignal;
    },
  ): Promise<ObjectStorageConditionalDeleteReceipt>;
  getUrl(
    key: string,
    options?: { versionId?: string | null },
  ): Promise<string>;
  /**
   * Return a private, short-lived download URL even when the configured
   * delivery mode is a stable CDN URL. Consumers that hand an object to an
   * external processor must use this capability instead of `getUrl`.
   *
   * It is optional on the broad adapter contract so local and in-memory test
   * adapters do not accidentally claim that they can produce private remote
   * delivery evidence.
   */
  getSignedUrl?(
    key: string,
    options?: { versionId?: string | null; expiresInSeconds?: number },
  ): Promise<string>;
  createUploadUrl(
    key: string,
    options?: {
      expiresInSeconds?: number;
      contentLength?: number;
      contentType?: string;
    },
  ): Promise<{ url: string; method: "PUT"; expiresAt: number }>;
  /**
   * Multipart is deliberately optional on the broad adapter contract. Local
   * and small in-memory adapters must not accidentally claim that resumable
   * remote uploads are durable.
   */
  initiateMultipartUpload?(
    key: string,
    options: { contentType: string },
  ): Promise<ObjectStorageMultipartInitiation>;
  createMultipartPartUploadUrl?(
    key: string,
    options: ObjectStorageMultipartPartTargetOptions,
  ): Promise<ObjectStorageMultipartPartTarget>;
  listMultipartParts?(
    key: string,
    options: { uploadId: string },
  ): Promise<ObjectStorageMultipartPartListing>;
  completeMultipartUpload?(
    key: string,
    options: {
      uploadId: string;
      parts: ObjectStorageMultipartPart[];
    },
  ): Promise<ObjectStorageMultipartCompletion>;
  abortMultipartUpload?(
    key: string,
    options: { uploadId: string },
  ): Promise<{ requestId: string }>;
}

export interface ObjectStorageMultipartInitiation {
  uploadId: string;
  requestId: string;
}

export interface ObjectStorageMultipartPartTargetOptions {
  uploadId: string;
  partNumber: number;
  contentLength: number;
  expiresInSeconds?: number;
}

export interface ObjectStorageMultipartPartTarget {
  url: string;
  method: "PUT";
  expiresAt: number;
  /** Content-Length is browser-managed but remains bound into the signature. */
  requiredHeaders: Record<string, never>;
}

export interface ObjectStorageMultipartPart {
  partNumber: number;
  etag: string;
  size: number;
  lastModified: string;
}

export interface ObjectStorageMultipartPartListing {
  parts: ObjectStorageMultipartPart[];
  requestId: string;
}

export interface ObjectStorageMultipartCompletion {
  etag: string;
  versionId: string | null;
  requestId: string;
}

export interface ObjectStorageWriteReceipt {
  provider: Exclude<ObjectStorageConfiguration["provider"], "local">;
  bucket: string;
  region: string;
  endpoint: string;
  keyPrefix: string;
  forcePathStyle: boolean;
  /** Logical key before the configured provider prefix is applied. */
  key: string;
  etag: string | null;
  versionId: string | null;
  requestId: string;
  size: number;
  sha256: string;
}

export interface ObjectStorageGenerationSnapshot {
  provider: Exclude<ObjectStorageConfiguration["provider"], "local">;
  bucket: string;
  key: string;
  exists: boolean;
  deleteMarker: boolean;
  etag: string | null;
  versionId: string | null;
  size: number | null;
  /** Present for strict HEAD evidence; version listings may omit it. */
  contentType?: string | null;
  lastModified: string | null;
  requestId: string;
}

export const OBJECT_STORAGE_VERSION_LIST_PAGE_MAX_ITEMS = 500;
export const OBJECT_STORAGE_VERSION_LIST_MAX_XML_BYTES = 4 * 1024 * 1024;
export const OBJECT_STORAGE_VERSION_LIST_PAGE_TIMEOUT_MS = 15_000;
export const OBJECT_STORAGE_MULTIPART_MAX_PARTS = 10_000;
export const OBJECT_STORAGE_MULTIPART_LIST_PAGE_MAX_ITEMS = 1_000;
export const OBJECT_STORAGE_MULTIPART_MAX_XML_BYTES = 4 * 1024 * 1024;

export interface ObjectStorageGenerationSnapshotPageOptions {
  maximumObjects?: number;
  keyMarker?: string | null;
  versionIdMarker?: string | null;
  signal?: AbortSignal;
  exactKey?: boolean;
  timeoutMs?: number;
}

export interface ObjectStorageGenerationSnapshotPage {
  snapshots: ObjectStorageGenerationSnapshot[];
  truncated: boolean;
  /**
   * Provider cursor for the next page. Both markers are non-null only when
   * truncated=true; callers can persist the pair without reinterpretation.
   */
  keyMarker: string | null;
  versionIdMarker: string | null;
}

export type ObjectStorageConditionalDeleteReceipt =
  | {
      outcome: "deleted";
      requestId: string;
    }
  | {
      outcome: "target_already_absent";
      requestId: string;
    };

type FetchImplementation = typeof fetch;

export class ObjectStorageUpstreamError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, statusCode: number) {
    super(code);
    this.name = "ObjectStorageUpstreamError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function awsEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function encodeKeyPath(key: string): string {
  return key.split("/").map(awsEncode).join("/");
}

export function normalizeObjectKey(key: string): string {
  const normalized = String(key || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.length > 1024 || normalized.includes("\0")) {
    throw new Error("OBJECT_STORAGE_KEY_INVALID");
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("OBJECT_STORAGE_KEY_INVALID");
  }
  return segments.join("/");
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function signingKey(secretKey: string, date: string, region: string): Buffer {
  const dateKey = hmac(`AWS4${secretKey}`, date);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, "s3");
  return hmac(serviceKey, "aws4_request");
}

function formatAmzDate(date: Date): { amzDate: string; shortDate: string } {
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate, shortDate: amzDate.slice(0, 8) };
}

function canonicalQuery(parameters: URLSearchParams): string {
  return [...parameters.entries()]
    .map(([key, value]) => [awsEncode(key), awsEncode(value)] as const)
    // SigV4 requires the URI-encoded octets to be sorted by byte value.
    // localeCompare() is locale/ICU dependent and, for example, can place the
    // lowercase `versionId` parameter before uppercase `X-Amz-*` parameters.
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
      if (leftKey < rightKey) return -1;
      if (leftKey > rightKey) return 1;
      if (leftValue < rightValue) return -1;
      if (leftValue > rightValue) return 1;
      return 0;
    })
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

function xmlDecode(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function xmlElement(block: string, name: string): string | null {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...block.matchAll(new RegExp(
    `<(?:[A-Za-z_][\\w.-]*:)?${escapedName}>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?${escapedName}>`,
    "gu",
  ))];
  if (matches.length > 1) {
    throw new ObjectStorageUpstreamError(
      "OBJECT_STORAGE_VERSION_LIST_INVALID",
      502,
    );
  }
  const rawValue = matches[0]?.[1];
  if (rawValue === undefined) return null;
  if (
    /</u.test(rawValue)
    || /&(?!(?:lt|gt|quot|apos|amp);)/u.test(rawValue)
  ) {
    throw new ObjectStorageUpstreamError(
      "OBJECT_STORAGE_VERSION_LIST_INVALID",
      502,
    );
  }
  return xmlDecode(rawValue);
}

function xmlBlocks(document: string, name: string): string[] {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...document.matchAll(new RegExp(
    `<(?:[A-Za-z_][\\w.-]*:)?${escapedName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?${escapedName}>`,
    "gu",
  ))].map((match) => match[1]);
}

function assertWellFormedVersionListingXml(document: string): void {
  const elements: string[] = [];
  let cursor = 0;
  let declarationSeen = false;
  let rootSeen = false;
  const invalid = (): never => {
    throw new ObjectStorageUpstreamError(
      "OBJECT_STORAGE_VERSION_LIST_INVALID",
      502,
    );
  };
  const validateText = (value: string): void => {
    if (/&(?!(?:lt|gt|quot|apos|amp);)/u.test(value)) invalid();
    if (elements.length === 0 && value.trim()) invalid();
  };

  while (cursor < document.length) {
    const tagStart = document.indexOf("<", cursor);
    if (tagStart < 0) {
      validateText(document.slice(cursor));
      break;
    }
    validateText(document.slice(cursor, tagStart));
    const tagEnd = document.indexOf(">", tagStart + 1);
    if (tagEnd < 0) invalid();
    const tag = document.slice(tagStart, tagEnd + 1);
    cursor = tagEnd + 1;

    if (tag.startsWith("<?xml")) {
      if (
        declarationSeen
        || rootSeen
        || !/^<\?xml\s+[^<>?]+\?>$/u.test(tag)
      ) {
        invalid();
      }
      declarationSeen = true;
      continue;
    }
    if (tag.startsWith("<!") || tag.startsWith("<?")) invalid();

    const closing = tag.match(/^<\/([A-Za-z_][\w.:-]*)\s*>$/u);
    if (closing) {
      if (elements.pop() !== closing[1]) invalid();
      continue;
    }
    const opening = tag.match(
      /^<([A-Za-z_][\w.:-]*)(?:\s+[^<>]*)?(\/?)>$/u,
    );
    if (!opening) return invalid();
    const attributeText = tag.slice(opening[1].length + 1, tag.length - 1);
    if (
      (attributeText.match(/"/gu)?.length ?? 0) % 2 !== 0
      || (attributeText.match(/'/gu)?.length ?? 0) % 2 !== 0
    ) {
      invalid();
    }
    if (elements.length === 0) {
      if (rootSeen) invalid();
      rootSeen = true;
    }
    if (opening[2] !== "/") elements.push(opening[1]);
  }
  if (!rootSeen || elements.length !== 0) invalid();
}

function requiredVersionListingText(
  block: string,
  name: string,
  code: string,
): string {
  const value = xmlElement(block, name);
  if (
    value === null
    || !value
    || value.length > 4096
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new ObjectStorageUpstreamError(code, 502);
  }
  return value;
}

function requiredVersionListingTimestamp(block: string): string {
  const value = requiredVersionListingText(
    block,
    "LastModified",
    "OBJECT_STORAGE_VERSION_LIST_INVALID",
  );
  if (value.length > 128 || Number.isNaN(Date.parse(value))) {
    throw new ObjectStorageUpstreamError(
      "OBJECT_STORAGE_VERSION_LIST_INVALID",
      502,
    );
  }
  return value;
}

function requiredVersionListingBoolean(block: string, name: string): boolean {
  const value = xmlElement(block, name);
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ObjectStorageUpstreamError(
    "OBJECT_STORAGE_VERSION_LIST_INVALID",
    502,
  );
}

function requiredResponseRequestId(response: Response): string {
  const requestId = [
    response.headers.get("x-amz-request-id"),
    response.headers.get("x-tos-request-id"),
    response.headers.get("x-request-id"),
  ].map((value) => String(value || "").trim()).find(Boolean);
  if (
    !requestId
    || requestId.length > 512
    || /[\u0000-\u001f\u007f]/u.test(requestId)
  ) {
    throw new ObjectStorageUpstreamError(
      "OBJECT_STORAGE_REQUEST_ID_MISSING",
      response.status || 502,
    );
  }
  return requestId;
}

function normalizedEntityTag(value: string | null): string | null {
  const etag = String(value || "").trim();
  if (
    !etag
    || etag.length > 512
    || /[\u0000-\u001f\u007f]/u.test(etag)
    || !/^"(?:[^"\\]|\\.)+"$/u.test(etag)
  ) {
    return null;
  }
  return etag;
}

function normalizedVersionId(value: string | null): string | null {
  const versionId = String(value || "");
  if (!versionId) return null;
  if (
    versionId !== versionId.trim()
    || versionId.length > 512
    || /[\u0000-\u001f\u007f]/u.test(versionId)
  ) {
    throw new ObjectStorageUpstreamError(
      "OBJECT_STORAGE_VERSION_ID_INVALID",
      502,
    );
  }
  return versionId;
}

function assertStableVersionId(versionId: string | null): void {
  if (versionId === "null") {
    throw new ObjectStorageUpstreamError(
      "OBJECT_STORAGE_NULL_VERSION_UNSAFE",
      503,
    );
  }
}

function normalizedSignedContentType(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const contentType = String(value).trim().toLowerCase();
  if (
    !contentType
    || contentType.length > 160
    || /[\u0000-\u001f\u007f]/u.test(contentType)
    || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u
      .test(contentType)
  ) {
    throw new Error("OBJECT_STORAGE_CONTENT_TYPE_INVALID");
  }
  return contentType;
}

function multipartInvalid(
  code = "OBJECT_STORAGE_MULTIPART_RESPONSE_INVALID",
): ObjectStorageUpstreamError {
  return new ObjectStorageUpstreamError(code, 502);
}

function normalizedMultipartUploadId(value: unknown): string {
  const uploadId = String(value ?? "");
  if (
    !uploadId
    || uploadId !== uploadId.trim()
    || uploadId.length > 4_096
    || /[\u0000-\u001f\u007f]/u.test(uploadId)
  ) {
    throw multipartInvalid("OBJECT_STORAGE_MULTIPART_UPLOAD_ID_INVALID");
  }
  return uploadId;
}

function normalizedMultipartPartNumber(value: unknown): number {
  const partNumber = Number(value);
  if (
    !Number.isSafeInteger(partNumber)
    || partNumber < 1
    || partNumber > OBJECT_STORAGE_MULTIPART_MAX_PARTS
  ) {
    throw multipartInvalid("OBJECT_STORAGE_MULTIPART_PART_NUMBER_INVALID");
  }
  return partNumber;
}

function multipartRoot(xml: string, rootName: string): string {
  try {
    assertWellFormedVersionListingXml(xml);
  } catch {
    throw multipartInvalid();
  }
  const escapedName = rootName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expression = new RegExp(
    `^\\s*(?:<\\?xml[^?]*\\?>\\s*)?<(?:[A-Za-z_][\\w.-]*:)?${escapedName}(?:\\s[^>]*)?>([\\s\\S]*)<\\/(?:[A-Za-z_][\\w.-]*:)?${escapedName}>\\s*$`,
    "u",
  );
  const match = xml.match(expression);
  const roots = [...xml.matchAll(new RegExp(
    `<(?:[A-Za-z_][\\w.-]*:)?${escapedName}(?:\\s[^>]*)?>`,
    "gu",
  ))];
  if (!match || roots.length !== 1) throw multipartInvalid();
  return match[1];
}

function multipartText(
  block: string,
  name: string,
  maximumLength = 4_096,
): string {
  try {
    const value = xmlElement(block, name);
    if (
      value === null
      || !value
      || value.length > maximumLength
      || /[\u0000-\u001f\u007f]/u.test(value)
    ) {
      throw multipartInvalid();
    }
    return value;
  } catch (error) {
    if (
      error instanceof ObjectStorageUpstreamError
      && error.code.startsWith("OBJECT_STORAGE_MULTIPART_")
    ) {
      throw error;
    }
    throw multipartInvalid();
  }
}

function multipartBoolean(block: string, name: string): boolean {
  try {
    const value = xmlElement(block, name);
    if (value === "true") return true;
    if (value === "false") return false;
  } catch {
    // Use one stable, sanitized error below.
  }
  throw multipartInvalid("OBJECT_STORAGE_MULTIPART_LIST_INVALID");
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

async function readMultipartXml(response: Response): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^(?:0|[1-9]\d*)$/u.test(contentLength)) throw multipartInvalid();
    const parsed = Number(contentLength);
    if (
      !Number.isSafeInteger(parsed)
      || parsed > OBJECT_STORAGE_MULTIPART_MAX_XML_BYTES
    ) {
      throw multipartInvalid("OBJECT_STORAGE_MULTIPART_RESPONSE_TOO_LARGE");
    }
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let completed = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        completed = true;
        break;
      }
      if (!chunk.value) continue;
      byteLength += chunk.value.byteLength;
      if (byteLength > OBJECT_STORAGE_MULTIPART_MAX_XML_BYTES) {
        throw multipartInvalid("OBJECT_STORAGE_MULTIPART_RESPONSE_TOO_LARGE");
      }
      chunks.push(chunk.value);
    }
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), byteLength),
    );
  } catch {
    throw multipartInvalid();
  }
}

function validatedListingKeyMarker(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const marker = String(value);
  if (
    marker !== marker.trim()
    || marker.length > 4_096
    || /[\u0000-\u001f\u007f]/u.test(marker)
  ) {
    throw new ObjectStorageUpstreamError(
      "OBJECT_STORAGE_LIST_CURSOR_INVALID",
      502,
    );
  }
  return marker;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

async function withVersionListPageSignal<T>(
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  externalSignal?.throwIfAborted();
  const controller = new AbortController();
  let abortSource: "external" | "timeout" | null = null;
  let rejectCancellation:
    ((reason?: unknown) => void) | null = null;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const abortFromExternal = (): void => {
    if (controller.signal.aborted) return;
    abortSource = "external";
    const reason = externalSignal?.reason
      ?? new DOMException("Aborted", "AbortError");
    controller.abort(reason);
    rejectCancellation?.(reason);
  };
  externalSignal?.addEventListener("abort", abortFromExternal, {
    once: true,
  });
  const timer = setTimeout(() => {
    if (controller.signal.aborted) return;
    abortSource = "timeout";
    const reason = new Error("OBJECT_STORAGE_VERSION_LIST_TIMEOUT");
    controller.abort(reason);
    rejectCancellation?.(reason);
  }, timeoutMs);
  timer.unref?.();
  try {
    return await Promise.race([
      operation(controller.signal),
      cancellation,
    ]);
  } catch (error) {
    if (abortSource === "timeout") {
      throw new ObjectStorageUpstreamError(
        "OBJECT_STORAGE_VERSION_LIST_TIMEOUT",
        504,
      );
    }
    if (abortSource === "external") {
      externalSignal?.throwIfAborted();
    }
    throw error;
  } finally {
    rejectCancellation = null;
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", abortFromExternal);
  }
}

async function readVersionListXml(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
  const contentLengthHeader = response.headers.get("content-length");
  if (contentLengthHeader !== null) {
    if (!/^(?:0|[1-9]\d*)$/u.test(contentLengthHeader)) {
      throw new ObjectStorageUpstreamError(
        "OBJECT_STORAGE_VERSION_LIST_INVALID",
        502,
      );
    }
    const contentLength = Number(contentLengthHeader);
    if (
      !Number.isSafeInteger(contentLength)
      || contentLength > OBJECT_STORAGE_VERSION_LIST_MAX_XML_BYTES
    ) {
      throw new ObjectStorageUpstreamError(
        "OBJECT_STORAGE_VERSION_LIST_RESPONSE_TOO_LARGE",
        502,
      );
    }
  }
  signal.throwIfAborted();
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let completed = false;
  let rejectOnAbort: ((reason?: unknown) => void) | null = null;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = reject;
  });
  const abort = (): void => {
    rejectOnAbort?.(
      signal.reason ?? new DOMException("Aborted", "AbortError"),
    );
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await Promise.race([reader.read(), aborted]);
      if (chunk.done) {
        completed = true;
        break;
      }
      if (!chunk.value) continue;
      byteLength += chunk.value.byteLength;
      if (byteLength > OBJECT_STORAGE_VERSION_LIST_MAX_XML_BYTES) {
        throw new ObjectStorageUpstreamError(
          "OBJECT_STORAGE_VERSION_LIST_RESPONSE_TOO_LARGE",
          502,
        );
      }
      chunks.push(chunk.value);
    }
  } finally {
    signal.removeEventListener("abort", abort);
    rejectOnAbort = null;
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), byteLength),
    );
  } catch {
    throw new ObjectStorageUpstreamError(
      "OBJECT_STORAGE_VERSION_LIST_INVALID",
      502,
    );
  }
}

export class S3CompatibleObjectStorage implements ObjectStorageAdapter {
  private readonly config: Required<Pick<ObjectStorageConfiguration,
    "provider" | "bucket" | "region" | "endpoint" | "accessKey" | "secretKey" | "keyPrefix" |
    "urlMode" | "signedUrlTtlSeconds" | "forcePathStyle">> & Pick<ObjectStorageConfiguration, "cdnUrl">;
  private readonly fetchImplementation: FetchImplementation;
  private readonly now: () => Date;

  constructor(
    configuration: ObjectStorageConfiguration = resolveObjectStorageConfiguration(),
    options: { fetch?: FetchImplementation; now?: () => Date } = {},
  ) {
    if (configuration.provider === "local" || !configuration.bucket || !configuration.region ||
      !configuration.endpoint || !configuration.accessKey || !configuration.secretKey) {
      throw new Error("OBJECT_STORAGE_CONFIGURATION_INVALID");
    }
    this.config = configuration as typeof this.config;
    this.fetchImplementation = options.fetch || fetch;
    this.now = options.now || (() => new Date());
  }

  private storedKey(key: string): string {
    const normalized = normalizeObjectKey(key);
    return this.config.keyPrefix ? `${normalizeObjectKey(this.config.keyPrefix)}/${normalized}` : normalized;
  }

  private objectUrl(storedKey?: string): URL {
    const url = new URL(this.config.endpoint);
    const basePath = url.pathname.replace(/\/+$/, "");
    if (this.config.forcePathStyle) {
      url.pathname = `${basePath}/${awsEncode(this.config.bucket)}${storedKey ? `/${encodeKeyPath(storedKey)}` : ""}`;
    } else {
      url.hostname = `${this.config.bucket}.${url.hostname}`;
      url.pathname = `${basePath}${storedKey ? `/${encodeKeyPath(storedKey)}` : "/"}`;
    }
    return url;
  }

  private authorization(method: string, url: URL, payloadHash: string, date: Date): Record<string, string> {
    const { amzDate, shortDate } = formatAmzDate(date);
    const canonicalHeaders = `host:${url.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
    const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
    const canonicalRequest = [
      method,
      url.pathname,
      canonicalQuery(url.searchParams),
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");
    const scope = `${shortDate}/${this.config.region}/s3/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256(canonicalRequest)}`;
    const signature = createHmac("sha256", signingKey(this.config.secretKey, shortDate, this.config.region))
      .update(stringToSign)
      .digest("hex");
    return {
      "x-amz-date": amzDate,
      "x-amz-content-sha256": payloadHash,
      authorization: `AWS4-HMAC-SHA256 Credential=${this.config.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    };
  }

  private async request(
    method: string,
    url: URL,
    body?: Uint8Array,
    extraHeaders: Record<string, string> = {},
    signal?: AbortSignal,
  ): Promise<Response> {
    const payloadHash = sha256(body || "");
    const response = await this.fetchImplementation(url, {
      method,
      headers: { ...this.authorization(method, url, payloadHash, this.now()), ...extraHeaders },
      body: body as BodyInit | undefined,
      signal,
    });
    return response;
  }

  private assertResponse(response: Response, allowed: number[] = [200, 204]): void {
    if (!allowed.includes(response.status)) {
      throw new ObjectStorageUpstreamError(
        `OBJECT_STORAGE_UPSTREAM_ERROR_${response.status}`,
        response.status,
      );
    }
  }

  async put(
    key: string,
    data: Buffer | Uint8Array,
    contentType = "application/octet-stream",
    options: { signal?: AbortSignal } = {},
  ): Promise<ObjectStorageWriteReceipt> {
    options.signal?.throwIfAborted();
    const normalizedKey = normalizeObjectKey(key);
    const payload = new Uint8Array(data);
    const response = await this.request(
      "PUT",
      this.objectUrl(this.storedKey(normalizedKey)),
      payload,
      { "content-type": contentType },
      options.signal,
    );
    options.signal?.throwIfAborted();
    this.assertResponse(response, [200, 201, 204]);
    const versionId = normalizedVersionId(
      response.headers.get("x-amz-version-id")
        || response.headers.get("x-tos-version-id"),
    );
    assertStableVersionId(versionId);
    return {
      // The constructor rejects the local provider before assigning config.
      provider: this.config.provider as Exclude<
        ObjectStorageConfiguration["provider"],
        "local"
      >,
      bucket: this.config.bucket,
      region: this.config.region,
      endpoint: this.config.endpoint,
      keyPrefix: this.config.keyPrefix,
      forcePathStyle: this.config.forcePathStyle,
      key: normalizedKey,
      etag: normalizedEntityTag(response.headers.get("etag")),
      versionId,
      requestId: requiredResponseRequestId(response),
      size: payload.byteLength,
      sha256: sha256(payload),
    };
  }

  async get(
    key: string,
    options: { versionId?: string | null; signal?: AbortSignal } = {},
  ): Promise<Buffer> {
    options.signal?.throwIfAborted();
    const normalizedKey = normalizeObjectKey(key);
    const versionId = normalizedVersionId(options.versionId ?? null);
    assertStableVersionId(versionId);
    const url = this.objectUrl(this.storedKey(normalizedKey));
    if (versionId) url.searchParams.set("versionId", versionId);
    const response = await this.request("GET", url, undefined, {}, options.signal);
    options.signal?.throwIfAborted();
    this.assertResponse(response, [200]);
    const observedVersionId = normalizedVersionId(
      response.headers.get("x-amz-version-id")
        || response.headers.get("x-tos-version-id"),
    );
    assertStableVersionId(observedVersionId);
    if (versionId && observedVersionId !== versionId) {
      throw new ObjectStorageUpstreamError(
        "OBJECT_STORAGE_VERSION_ID_MISMATCH",
        412,
      );
    }
    return Buffer.from(await response.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    const response = await this.request("DELETE", this.objectUrl(this.storedKey(key)));
    this.assertResponse(response, [200, 202, 204]);
  }

  async exists(key: string): Promise<boolean> {
    const response = await this.request("HEAD", this.objectUrl(this.storedKey(key)));
    if (response.status === 404) return false;
    this.assertResponse(response, [200, 204]);
    return true;
  }

  async inspectGeneration(
    key: string,
    options: { versionId?: string | null; signal?: AbortSignal } = {},
  ): Promise<ObjectStorageGenerationSnapshot> {
    options.signal?.throwIfAborted();
    const normalizedKey = normalizeObjectKey(key);
    const versionId = normalizedVersionId(options.versionId ?? null);
    assertStableVersionId(versionId);
    const url = this.objectUrl(this.storedKey(normalizedKey));
    if (versionId) url.searchParams.set("versionId", versionId);
    const response = await this.request("HEAD", url, undefined, {}, options.signal);
    options.signal?.throwIfAborted();
    const requestId = requiredResponseRequestId(response);
    const deleteMarkerHeaders = [
      response.headers.get("x-amz-delete-marker"),
      response.headers.get("x-tos-delete-marker"),
    ].map((value) => String(value || "").trim().toLowerCase()).filter(Boolean);
    if (
      deleteMarkerHeaders.some((value) => value !== "true" && value !== "false")
      || new Set(deleteMarkerHeaders).size > 1
    ) {
      throw new ObjectStorageUpstreamError(
        "OBJECT_STORAGE_GENERATION_EVIDENCE_INVALID",
        502,
      );
    }
    const responseDeleteMarker = deleteMarkerHeaders.includes("true");
    const observedVersionId = normalizedVersionId(
      response.headers.get("x-amz-version-id")
        || response.headers.get("x-tos-version-id"),
    );
    assertStableVersionId(observedVersionId);
    if (
      responseDeleteMarker
      && (response.status === 404 || response.status === 405)
    ) {
      // A physical delete marker is positive generation evidence, so an
      // exact-version request must still be echoed by the provider.
      if (versionId && observedVersionId !== versionId) {
        throw new ObjectStorageUpstreamError(
          "OBJECT_STORAGE_VERSION_ID_MISMATCH",
          412,
        );
      }
      const deleteMarkerVersionId = observedVersionId ?? versionId;
      const lastModified = String(response.headers.get("last-modified") || "").trim();
      if (
        !deleteMarkerVersionId
        || !lastModified
        || lastModified.length > 128
        || Number.isNaN(Date.parse(lastModified))
      ) {
        throw new ObjectStorageUpstreamError(
          "OBJECT_STORAGE_GENERATION_EVIDENCE_INVALID",
          502,
        );
      }
      return {
        provider: this.config.provider as Exclude<ObjectStorageConfiguration["provider"], "local">,
        bucket: this.config.bucket,
        key: normalizedKey,
        exists: true,
        deleteMarker: true,
        etag: null,
        versionId: deleteMarkerVersionId,
        size: null,
        lastModified,
        requestId,
      };
    }
    if (response.status === 404) {
      // TOS does not echo x-tos-version-id after the exact physical
      // generation has been deleted. The signed versionId query plus a 404 is
      // direct absence evidence, but this accommodation must never turn a
      // successful or delete-marker response into fabricated provenance.
      if (
        versionId
        && (
          (observedVersionId && observedVersionId !== versionId)
          || (!observedVersionId && this.config.provider !== "tos")
        )
      ) {
        throw new ObjectStorageUpstreamError(
          "OBJECT_STORAGE_VERSION_ID_MISMATCH",
          412,
        );
      }
      if (!versionId && observedVersionId) {
        throw new ObjectStorageUpstreamError(
          "OBJECT_STORAGE_GENERATION_EVIDENCE_INVALID",
          502,
        );
      }
      return {
        provider: this.config.provider as Exclude<ObjectStorageConfiguration["provider"], "local">,
        bucket: this.config.bucket,
        key: normalizedKey,
        exists: false,
        deleteMarker: false,
        etag: null,
        versionId,
        size: null,
        lastModified: null,
        requestId,
      };
    }
    this.assertResponse(response, [200, 204]);
    // A successful exact-version HEAD is positive generation evidence only
    // when the provider echoes the selected immutable generation.
    if (versionId && observedVersionId !== versionId) {
      throw new ObjectStorageUpstreamError(
        "OBJECT_STORAGE_VERSION_ID_MISMATCH",
        412,
      );
    }
    if (responseDeleteMarker) {
      throw new ObjectStorageUpstreamError(
        "OBJECT_STORAGE_GENERATION_EVIDENCE_INVALID",
        502,
      );
    }
    const etag = normalizedEntityTag(response.headers.get("etag"));
    const contentLengthText = response.headers.get("content-length");
    const contentLength = Number(contentLengthText);
    const contentType = normalizedSignedContentType(
      response.headers.get("content-type"),
    );
    const lastModified = String(response.headers.get("last-modified") || "").trim();
    if (
      !etag
      || contentLengthText === null
      || !/^(?:0|[1-9]\d*)$/u.test(contentLengthText)
      || !Number.isSafeInteger(contentLength)
      || contentLength < 0
      || !contentType
      || !lastModified
      || lastModified.length > 128
      || Number.isNaN(Date.parse(lastModified))
    ) {
      throw new ObjectStorageUpstreamError(
        "OBJECT_STORAGE_GENERATION_EVIDENCE_INVALID",
        502,
      );
    }
    return {
      provider: this.config.provider as Exclude<ObjectStorageConfiguration["provider"], "local">,
      bucket: this.config.bucket,
      key: normalizedKey,
      exists: true,
      deleteMarker: false,
      etag,
      versionId: observedVersionId ?? versionId,
      size: contentLength,
      contentType,
      lastModified,
      requestId,
    };
  }

  async listGenerationSnapshots(
    prefix: string,
    options: {
      maximumObjects?: number;
      signal?: AbortSignal;
      exactKey?: boolean;
      pageTimeoutMs?: number;
    } = {},
  ): Promise<ObjectStorageGenerationSnapshot[]> {
    const maximumObjects = options.maximumObjects ?? 10_000;
    if (!Number.isSafeInteger(maximumObjects) || maximumObjects < 1 || maximumObjects > 10_000) {
      throw new Error("OBJECT_STORAGE_LIST_LIMIT_INVALID");
    }
    const snapshots: ObjectStorageGenerationSnapshot[] = [];
    const seenGenerations = new Set<string>();
    const seenPaginationMarkers = new Set<string>();
    let keyMarker: string | null = null;
    let versionIdMarker: string | null = null;
    seenPaginationMarkers.add("\0");
    while (true) {
      options.signal?.throwIfAborted();
      const remaining = maximumObjects - snapshots.length;
      if (remaining < 1) {
        throw new ObjectStorageUpstreamError(
          "OBJECT_STORAGE_LIST_LIMIT_EXCEEDED",
          409,
        );
      }
      const page = await this.listGenerationSnapshotPage(prefix, {
        maximumObjects: Math.min(
          OBJECT_STORAGE_VERSION_LIST_PAGE_MAX_ITEMS,
          remaining,
        ),
        keyMarker,
        versionIdMarker,
        signal: options.signal,
        exactKey: options.exactKey,
        timeoutMs: options.pageTimeoutMs,
      });
      for (const snapshot of page.snapshots) {
        const identity = `${snapshot.key}\0${snapshot.versionId ?? ""}`;
        if (seenGenerations.has(identity)) {
          throw new ObjectStorageUpstreamError(
            "OBJECT_STORAGE_LIST_DUPLICATE_VERSION",
            502,
          );
        }
        seenGenerations.add(identity);
        snapshots.push(snapshot);
        if (snapshots.length > maximumObjects) {
          throw new ObjectStorageUpstreamError(
            "OBJECT_STORAGE_LIST_LIMIT_EXCEEDED",
            409,
          );
        }
      }
      if (!page.truncated) break;
      if (options.exactKey === true && page.snapshots.length === 0) break;
      if (snapshots.length >= maximumObjects) {
        throw new ObjectStorageUpstreamError(
          "OBJECT_STORAGE_LIST_LIMIT_EXCEEDED",
          409,
        );
      }
      const paginationIdentity =
        `${page.keyMarker ?? ""}\0${page.versionIdMarker ?? ""}`;
      if (seenPaginationMarkers.has(paginationIdentity)) {
        throw new ObjectStorageUpstreamError(
          "OBJECT_STORAGE_LIST_PAGINATION_LOOP",
          502,
        );
      }
      seenPaginationMarkers.add(paginationIdentity);
      keyMarker = page.keyMarker;
      versionIdMarker = page.versionIdMarker;
    }
    return snapshots.sort((left, right) =>
      left.key.localeCompare(right.key)
      || String(left.versionId ?? "").localeCompare(String(right.versionId ?? ""))
      || Number(left.deleteMarker) - Number(right.deleteMarker),
    );
  }

  async listGenerationSnapshotPage(
    prefix: string,
    options: ObjectStorageGenerationSnapshotPageOptions = {},
  ): Promise<ObjectStorageGenerationSnapshotPage> {
    const normalizedPrefix = normalizeObjectKey(prefix.replace(/\/+$/u, ""));
    const exactKey = options.exactKey === true;
    const maximumObjects = options.maximumObjects
      ?? OBJECT_STORAGE_VERSION_LIST_PAGE_MAX_ITEMS;
    if (
      !Number.isSafeInteger(maximumObjects)
      || maximumObjects < 1
      || maximumObjects > OBJECT_STORAGE_VERSION_LIST_PAGE_MAX_ITEMS
    ) {
      throw new Error("OBJECT_STORAGE_LIST_PAGE_LIMIT_INVALID");
    }
    const timeoutMs = options.timeoutMs
      ?? OBJECT_STORAGE_VERSION_LIST_PAGE_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(timeoutMs)
      || timeoutMs < 1
      || timeoutMs > 5 * 60_000
    ) {
      throw new Error("OBJECT_STORAGE_LIST_TIMEOUT_INVALID");
    }
    const storedPrefix = this.storedKey(normalizedPrefix)
      + (exactKey ? "" : "/");
    const configuredPrefix = this.config.keyPrefix
      ? `${normalizeObjectKey(this.config.keyPrefix)}/`
      : "";
    const logicalKeyForStoredKey = (storedKey: string): string | null => {
      if (configuredPrefix && !storedKey.startsWith(configuredPrefix)) {
        throw new ObjectStorageUpstreamError(
          "OBJECT_STORAGE_LIST_KEY_OUTSIDE_PREFIX",
          502,
        );
      }
      let logicalKey: string;
      try {
        logicalKey = normalizeObjectKey(
          configuredPrefix
            ? storedKey.slice(configuredPrefix.length)
            : storedKey,
        );
      } catch {
        throw new ObjectStorageUpstreamError(
          "OBJECT_STORAGE_VERSION_LIST_INVALID",
          502,
        );
      }
      if (exactKey) {
        if (logicalKey === normalizedPrefix) return logicalKey;
        if (logicalKey.startsWith(normalizedPrefix)) return null;
        throw new ObjectStorageUpstreamError(
          "OBJECT_STORAGE_LIST_KEY_OUTSIDE_TARGET",
          502,
        );
      }
      if (!logicalKey.startsWith(`${normalizedPrefix}/`)) {
        throw new ObjectStorageUpstreamError(
          "OBJECT_STORAGE_LIST_KEY_OUTSIDE_TARGET",
          502,
        );
      }
      return logicalKey;
    };

    const keyMarker = validatedListingKeyMarker(options.keyMarker);
    const versionIdMarker = normalizedVersionId(
      options.versionIdMarker ?? null,
    );
    assertStableVersionId(versionIdMarker);
    if (Boolean(keyMarker) !== Boolean(versionIdMarker)) {
      throw new ObjectStorageUpstreamError(
        "OBJECT_STORAGE_LIST_CURSOR_INVALID",
        502,
      );
    }
    if (keyMarker) logicalKeyForStoredKey(keyMarker);

    return withVersionListPageSignal(
      options.signal,
      timeoutMs,
      async (signal) => {
        const url = this.objectUrl();
        url.searchParams.set("versions", "");
        url.searchParams.set("prefix", storedPrefix);
        url.searchParams.set("max-keys", String(maximumObjects));
        if (keyMarker && versionIdMarker) {
          url.searchParams.set("key-marker", keyMarker);
          url.searchParams.set("version-id-marker", versionIdMarker);
        }
        const response = await this.request(
          "GET",
          url,
          undefined,
          {},
          signal,
        );
        signal.throwIfAborted();
        this.assertResponse(response, [200]);
        const xml = await readVersionListXml(response, signal);
        signal.throwIfAborted();
        const requestId = requiredResponseRequestId(response);
        assertWellFormedVersionListingXml(xml);

        const allowedRootNames = this.config.provider === "tos"
          ? ["ListVersionsResult", "ListObjectVersionsOutput"]
          : ["ListVersionsResult"];
        const rootCandidates = allowedRootNames.flatMap((rootName) => {
          const expression = new RegExp(
            `^\\s*(?:<\\?xml[^?]*\\?>\\s*)?<(?:[A-Za-z_][\\w.-]*:)?${rootName}(?:\\s[^>]*)?>([\\s\\S]*)<\\/(?:[A-Za-z_][\\w.-]*:)?${rootName}>\\s*$`,
            "u",
          );
          const match = xml.match(expression);
          const startCount = [
            ...xml.matchAll(new RegExp(
              `<(?:[A-Za-z_][\\w.-]*:)?${rootName}(?:\\s[^>]*)?>`,
              "gu",
            )),
          ].length;
          return match && startCount === 1 ? [match] : [];
        });
        if (rootCandidates.length !== 1) {
          throw new ObjectStorageUpstreamError(
            "OBJECT_STORAGE_VERSION_LIST_INVALID",
            502,
          );
        }
        const root = rootCandidates[0][1];
        const versionMatches = [
          ...root.matchAll(
            /<(?:[A-Za-z_][\w.-]*:)?Version(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?Version>/gu,
          ),
        ];
        const deleteMarkerMatches = [
          ...root.matchAll(
            /<(?:[A-Za-z_][\w.-]*:)?DeleteMarker(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?DeleteMarker>/gu,
          ),
        ];
        const versionStartCount = [
          ...root.matchAll(
            /<(?:[A-Za-z_][\w.-]*:)?Version(?:\s[^>]*)?>/gu,
          ),
        ].length;
        const deleteMarkerStartCount = [
          ...root.matchAll(
            /<(?:[A-Za-z_][\w.-]*:)?DeleteMarker(?:\s[^>]*)?>/gu,
          ),
        ].length;
        if (
          versionMatches.length !== versionStartCount
          || deleteMarkerMatches.length !== deleteMarkerStartCount
        ) {
          throw new ObjectStorageUpstreamError(
            "OBJECT_STORAGE_VERSION_LIST_INVALID",
            502,
          );
        }
        const generationBlocks = [
          ...versionMatches.map((match) => ({
            kind: "version" as const,
            index: match.index,
            block: match[1],
          })),
          ...deleteMarkerMatches.map((match) => ({
            kind: "deleteMarker" as const,
            index: match.index,
            block: match[1],
          })),
        ].sort((left, right) => left.index - right.index);
        if (generationBlocks.length > maximumObjects) {
          throw new ObjectStorageUpstreamError(
            "OBJECT_STORAGE_LIST_LIMIT_EXCEEDED",
            409,
          );
        }
        const snapshots: ObjectStorageGenerationSnapshot[] = [];
        const seenGenerations = new Set<string>();
        for (const generation of generationBlocks) {
          const storedKey = requiredVersionListingText(
            generation.block,
            "Key",
            "OBJECT_STORAGE_VERSION_LIST_INVALID",
          );
          const listedVersionId = normalizedVersionId(
            requiredVersionListingText(
              generation.block,
              "VersionId",
              "OBJECT_STORAGE_VERSION_LIST_INVALID",
            ),
          );
          assertStableVersionId(listedVersionId);
          requiredVersionListingBoolean(generation.block, "IsLatest");
          const lastModified = requiredVersionListingTimestamp(
            generation.block,
          );
          if (!listedVersionId) {
            throw new ObjectStorageUpstreamError(
              this.config.provider === "tos"
                ? "OBJECT_STORAGE_TOS_VERSION_ID_REQUIRED"
                : "OBJECT_STORAGE_VERSION_LIST_INVALID",
              this.config.provider === "tos" ? 503 : 502,
            );
          }
          const logicalKey = logicalKeyForStoredKey(storedKey);
          if (!logicalKey) continue;
          const identity = `${logicalKey}\0${listedVersionId}`;
          if (seenGenerations.has(identity)) {
            throw new ObjectStorageUpstreamError(
              "OBJECT_STORAGE_LIST_DUPLICATE_VERSION",
              502,
            );
          }
          seenGenerations.add(identity);
          if (snapshots.length >= maximumObjects) {
            throw new ObjectStorageUpstreamError(
              "OBJECT_STORAGE_LIST_LIMIT_EXCEEDED",
              409,
            );
          }
          if (generation.kind === "deleteMarker") {
            snapshots.push({
              provider: this.config.provider as Exclude<
                ObjectStorageConfiguration["provider"],
                "local"
              >,
              bucket: this.config.bucket,
              key: logicalKey,
              exists: true,
              deleteMarker: true,
              etag: null,
              versionId: listedVersionId,
              size: null,
              lastModified,
              requestId,
            });
            continue;
          }
          const etag = normalizedEntityTag(
            xmlElement(generation.block, "ETag"),
          );
          const sizeText = requiredVersionListingText(
            generation.block,
            "Size",
            "OBJECT_STORAGE_VERSION_LIST_INVALID",
          );
          if (!etag || !/^(?:0|[1-9]\d*)$/u.test(sizeText)) {
            throw new ObjectStorageUpstreamError(
              "OBJECT_STORAGE_VERSION_LIST_INVALID",
              502,
            );
          }
          const size = Number(sizeText);
          if (!Number.isSafeInteger(size)) {
            throw new ObjectStorageUpstreamError(
              "OBJECT_STORAGE_VERSION_LIST_INVALID",
              502,
            );
          }
          snapshots.push({
            provider: this.config.provider as Exclude<
              ObjectStorageConfiguration["provider"],
              "local"
            >,
            bucket: this.config.bucket,
            key: logicalKey,
            exists: true,
            deleteMarker: false,
            etag,
            versionId: listedVersionId,
            size,
            lastModified,
            requestId,
          });
        }

        const truncated = requiredVersionListingBoolean(
          root,
          "IsTruncated",
        );
        const nextKeyMarker = validatedListingKeyMarker(
          xmlElement(root, "NextKeyMarker"),
        );
        const nextVersionIdMarker = normalizedVersionId(
          xmlElement(root, "NextVersionIdMarker"),
        );
        assertStableVersionId(nextVersionIdMarker);
        if (!truncated) {
          if (nextKeyMarker || nextVersionIdMarker) {
            throw new ObjectStorageUpstreamError(
              "OBJECT_STORAGE_VERSION_LIST_INVALID",
              502,
            );
          }
          return {
            snapshots,
            truncated: false,
            keyMarker: null,
            versionIdMarker: null,
          };
        }
        if (!nextKeyMarker || !nextVersionIdMarker) {
          throw new ObjectStorageUpstreamError(
            "OBJECT_STORAGE_VERSION_LIST_INVALID",
            502,
          );
        }
        logicalKeyForStoredKey(nextKeyMarker);
        if (!exactKey && snapshots.length === 0) {
          throw new ObjectStorageUpstreamError(
            "OBJECT_STORAGE_LIST_PAGINATION_NO_PROGRESS",
            502,
          );
        }
        if (keyMarker && versionIdMarker) {
          const keyProgress = compareUtf8(nextKeyMarker, keyMarker);
          if (
            keyProgress < 0
            || (
              keyProgress === 0
              && nextVersionIdMarker === versionIdMarker
            )
          ) {
            throw new ObjectStorageUpstreamError(
              "OBJECT_STORAGE_LIST_PAGINATION_LOOP",
              502,
            );
          }
        }
        return {
          snapshots,
          truncated: true,
          keyMarker: nextKeyMarker,
          versionIdMarker: nextVersionIdMarker,
        };
      },
    );
  }

  async deleteGenerationIfMatch(
    key: string,
    condition: {
      etag: string | null;
      versionId?: string | null;
      deleteMarker?: boolean;
      signal?: AbortSignal;
    },
  ): Promise<ObjectStorageConditionalDeleteReceipt> {
    const normalizedKey = normalizeObjectKey(key);
    if (
      condition.deleteMarker !== undefined
      && typeof condition.deleteMarker !== "boolean"
    ) {
      throw new Error("OBJECT_STORAGE_DELETE_MARKER_INVALID");
    }
    const deleteMarker = condition.deleteMarker === true;
    const etag = normalizedEntityTag(condition.etag);
    const versionId = normalizedVersionId(condition.versionId ?? null);
    assertStableVersionId(versionId);
    if (
      (deleteMarker && (etag || !versionId))
      || (!deleteMarker && !etag)
    ) {
      throw new Error(
        deleteMarker
          ? "OBJECT_STORAGE_DELETE_MARKER_CONDITION_INVALID"
          : "OBJECT_STORAGE_ETAG_INVALID",
      );
    }
    if (this.config.provider === "tos" && !versionId) {
      throw new ObjectStorageUpstreamError(
        "OBJECT_STORAGE_TOS_VERSION_ID_REQUIRED",
        503,
      );
    }
    const url = this.objectUrl(this.storedKey(normalizedKey));
    if (versionId) url.searchParams.set("versionId", versionId);
    const response = await this.request(
      "DELETE",
      url,
      undefined,
      this.config.provider === "s3" && !deleteMarker
        ? { "if-match": etag! }
        : {},
      condition.signal,
    );
    const requestId = requiredResponseRequestId(response);
    if (response.status === 404) {
      return { outcome: "target_already_absent", requestId };
    }
    if (response.status === 412 || response.status === 409) {
      throw new ObjectStorageUpstreamError(
        "OBJECT_STORAGE_GENERATION_PRECONDITION_FAILED",
        response.status,
      );
    }
    this.assertResponse(response, [200, 202, 204]);
    const deletedVersionId = normalizedVersionId(
      response.headers.get("x-amz-version-id")
        || response.headers.get("x-tos-version-id"),
    );
    if (versionId && deletedVersionId && deletedVersionId !== versionId) {
      throw new ObjectStorageUpstreamError(
        "OBJECT_STORAGE_VERSION_ID_MISMATCH",
        502,
      );
    }
    return { outcome: "deleted", requestId };
  }

  async deletePrefix(prefix: string): Promise<void> {
    const storedPrefix = this.storedKey(prefix.replace(/\/+$/, "")) + "/";
    let continuationToken = "";
    do {
      const url = this.objectUrl();
      url.searchParams.set("list-type", "2");
      url.searchParams.set("prefix", storedPrefix);
      if (continuationToken) url.searchParams.set("continuation-token", continuationToken);
      const response = await this.request("GET", url);
      this.assertResponse(response, [200]);
      const xml = await response.text();
      const keys = [...xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((match) => xmlDecode(match[1]));
      for (const storedKey of keys) {
        const deleteResponse = await this.request("DELETE", this.objectUrl(storedKey));
        this.assertResponse(deleteResponse, [200, 202, 204]);
      }
      continuationToken = xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/)?.[1] || "";
      continuationToken = xmlDecode(continuationToken);
    } while (continuationToken);
  }

  async initiateMultipartUpload(
    key: string,
    options: { contentType: string },
  ): Promise<ObjectStorageMultipartInitiation> {
    const contentType = normalizedSignedContentType(options.contentType);
    if (!contentType) {
      throw new Error("OBJECT_STORAGE_CONTENT_TYPE_INVALID");
    }
    const url = this.objectUrl(this.storedKey(key));
    url.searchParams.set("uploads", "");
    const response = await this.request(
      "POST",
      url,
      undefined,
      { "content-type": contentType },
    );
    this.assertResponse(response, [200]);
    const requestId = requiredResponseRequestId(response);
    const root = multipartRoot(
      await readMultipartXml(response),
      "InitiateMultipartUploadResult",
    );
    return {
      uploadId: normalizedMultipartUploadId(
        multipartText(root, "UploadId"),
      ),
      requestId,
    };
  }

  async createMultipartPartUploadUrl(
    key: string,
    options: ObjectStorageMultipartPartTargetOptions,
  ): Promise<ObjectStorageMultipartPartTarget> {
    const uploadId = normalizedMultipartUploadId(options.uploadId);
    const partNumber = normalizedMultipartPartNumber(options.partNumber);
    const contentLength = Number(options.contentLength);
    if (!Number.isSafeInteger(contentLength) || contentLength < 1) {
      throw new Error("OBJECT_STORAGE_CONTENT_LENGTH_INVALID");
    }
    const expiresInSeconds = options.expiresInSeconds
      ?? Math.min(this.config.signedUrlTtlSeconds, 900);
    if (
      !Number.isSafeInteger(expiresInSeconds)
      || expiresInSeconds < 60
      || expiresInSeconds > 900
    ) {
      throw new Error("OBJECT_STORAGE_UPLOAD_TTL_INVALID");
    }

    const url = this.objectUrl(this.storedKey(key));
    url.searchParams.set("partNumber", String(partNumber));
    url.searchParams.set("uploadId", uploadId);
    const now = this.now();
    const { amzDate, shortDate } = formatAmzDate(now);
    const scope = `${shortDate}/${this.config.region}/s3/aws4_request`;
    url.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
    url.searchParams.set("X-Amz-Credential", `${this.config.accessKey}/${scope}`);
    url.searchParams.set("X-Amz-Date", amzDate);
    url.searchParams.set("X-Amz-Expires", String(expiresInSeconds));
    const signedHeaders = "content-length;host";
    const canonicalHeaders = `content-length:${contentLength}\nhost:${url.host}\n`;
    url.searchParams.set("X-Amz-SignedHeaders", signedHeaders);
    const canonicalRequest = [
      "PUT",
      url.pathname,
      canonicalQuery(url.searchParams),
      canonicalHeaders,
      signedHeaders,
      "UNSIGNED-PAYLOAD",
    ].join("\n");
    const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256(canonicalRequest)}`;
    const signature = createHmac(
      "sha256",
      signingKey(this.config.secretKey, shortDate, this.config.region),
    ).update(stringToSign).digest("hex");
    url.searchParams.set("X-Amz-Signature", signature);
    return {
      url: url.toString(),
      method: "PUT",
      expiresAt: now.getTime() + expiresInSeconds * 1_000,
      requiredHeaders: {},
    };
  }

  async listMultipartParts(
    key: string,
    options: { uploadId: string },
  ): Promise<ObjectStorageMultipartPartListing> {
    const uploadId = normalizedMultipartUploadId(options.uploadId);
    const parts: ObjectStorageMultipartPart[] = [];
    const seen = new Set<number>();
    let marker = 0;
    let requestId = "";
    do {
      const url = this.objectUrl(this.storedKey(key));
      url.searchParams.set("uploadId", uploadId);
      url.searchParams.set(
        "max-parts",
        String(OBJECT_STORAGE_MULTIPART_LIST_PAGE_MAX_ITEMS),
      );
      if (marker > 0) {
        url.searchParams.set("part-number-marker", String(marker));
      }
      const response = await this.request("GET", url);
      this.assertResponse(response, [200]);
      requestId = requiredResponseRequestId(response);
      let root: string;
      try {
        root = multipartRoot(await readMultipartXml(response), "ListPartsResult");
      } catch {
        throw multipartInvalid("OBJECT_STORAGE_MULTIPART_LIST_INVALID");
      }
      const blocks = xmlBlocks(root, "Part");
      const partStarts = [
        ...root.matchAll(/<(?:[A-Za-z_][\w.-]*:)?Part(?:\s[^>]*)?>/gu),
      ];
      if (
        blocks.length !== partStarts.length
        || blocks.length > OBJECT_STORAGE_MULTIPART_LIST_PAGE_MAX_ITEMS
        || parts.length + blocks.length > OBJECT_STORAGE_MULTIPART_MAX_PARTS
      ) {
        throw multipartInvalid("OBJECT_STORAGE_MULTIPART_LIST_INVALID");
      }
      let pageLastPart = marker;
      for (const block of blocks) {
        let partNumber: number;
        let size: number;
        let etag: string | null;
        let lastModified: string;
        try {
          const partNumberText = multipartText(block, "PartNumber", 8);
          if (!/^[1-9]\d*$/u.test(partNumberText)) throw new Error();
          partNumber = normalizedMultipartPartNumber(partNumberText);
          const sizeText = multipartText(block, "Size", 32);
          if (!/^(?:0|[1-9]\d*)$/u.test(sizeText)) throw new Error();
          size = Number(sizeText);
          etag = normalizedEntityTag(multipartText(block, "ETag", 512));
          lastModified = multipartText(block, "LastModified", 128);
        } catch {
          throw multipartInvalid("OBJECT_STORAGE_MULTIPART_LIST_INVALID");
        }
        if (
          !Number.isSafeInteger(size)
          || size < 1
          || !etag
          || Number.isNaN(Date.parse(lastModified))
          || partNumber <= pageLastPart
          || seen.has(partNumber)
        ) {
          throw multipartInvalid("OBJECT_STORAGE_MULTIPART_LIST_INVALID");
        }
        pageLastPart = partNumber;
        seen.add(partNumber);
        parts.push({ partNumber, etag, size, lastModified });
      }

      const truncated = multipartBoolean(root, "IsTruncated");
      let nextMarker: number | null = null;
      try {
        const rawNextMarker = xmlElement(root, "NextPartNumberMarker");
        if (rawNextMarker !== null && rawNextMarker !== "") {
          // TOS returns 0 on the final page, including when it contains parts.
          // A continuation cursor is meaningful only when IsTruncated is true.
          if (!/^(?:0|[1-9]\d*)$/u.test(rawNextMarker)) throw new Error();
          nextMarker = rawNextMarker === "0" ? 0 : normalizedMultipartPartNumber(rawNextMarker);
        }
      } catch {
        throw multipartInvalid("OBJECT_STORAGE_MULTIPART_LIST_INVALID");
      }
      if (!truncated) {
        break;
      }
      if (
        nextMarker === null
        || blocks.length === 0
        || nextMarker < pageLastPart
        || nextMarker <= marker
      ) {
        throw multipartInvalid("OBJECT_STORAGE_MULTIPART_LIST_INVALID");
      }
      marker = nextMarker;
    } while (parts.length < OBJECT_STORAGE_MULTIPART_MAX_PARTS);

    if (!requestId) {
      throw multipartInvalid("OBJECT_STORAGE_MULTIPART_LIST_INVALID");
    }
    return { parts, requestId };
  }

  async completeMultipartUpload(
    key: string,
    options: {
      uploadId: string;
      parts: ObjectStorageMultipartPart[];
    },
  ): Promise<ObjectStorageMultipartCompletion> {
    const uploadId = normalizedMultipartUploadId(options.uploadId);
    if (
      !Array.isArray(options.parts)
      || options.parts.length < 1
      || options.parts.length > OBJECT_STORAGE_MULTIPART_MAX_PARTS
    ) {
      throw new Error("OBJECT_STORAGE_MULTIPART_PARTS_INVALID");
    }
    let previousPart = 0;
    const partXml = options.parts.map((part) => {
      const partNumber = normalizedMultipartPartNumber(part.partNumber);
      const etag = normalizedEntityTag(part.etag);
      if (!etag || partNumber <= previousPart) {
        throw new Error("OBJECT_STORAGE_MULTIPART_PARTS_INVALID");
      }
      previousPart = partNumber;
      return `<Part><ETag>${xmlEscape(etag)}</ETag><PartNumber>${partNumber}</PartNumber></Part>`;
    }).join("");
    // TOS' S3-compatible endpoint validates the canonical S3 XML namespace
    // and element order. Match the AWS SDK wire format so a fully uploaded
    // release cannot become stranded at CompleteMultipartUpload.
    const body = new TextEncoder().encode(
      '<?xml version="1.0" encoding="UTF-8"?>'
        + '<CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
        + `${partXml}</CompleteMultipartUpload>`,
    );
    const url = this.objectUrl(this.storedKey(key));
    url.searchParams.set("uploadId", uploadId);
    const response = await this.request(
      "POST",
      url,
      body,
      { "content-type": "application/xml" },
    );
    this.assertResponse(response, [200]);
    const requestId = requiredResponseRequestId(response);
    let etag: string | null;
    try {
      const root = multipartRoot(
        await readMultipartXml(response),
        "CompleteMultipartUploadResult",
      );
      etag = normalizedEntityTag(multipartText(root, "ETag", 512));
    } catch {
      throw multipartInvalid("OBJECT_STORAGE_MULTIPART_COMPLETE_INVALID");
    }
    if (!etag) {
      throw multipartInvalid("OBJECT_STORAGE_MULTIPART_COMPLETE_INVALID");
    }
    const versionId = normalizedVersionId(
      response.headers.get("x-amz-version-id")
        || response.headers.get("x-tos-version-id"),
    );
    assertStableVersionId(versionId);
    return { etag, versionId, requestId };
  }

  async abortMultipartUpload(
    key: string,
    options: { uploadId: string },
  ): Promise<{ requestId: string }> {
    const uploadId = normalizedMultipartUploadId(options.uploadId);
    const url = this.objectUrl(this.storedKey(key));
    url.searchParams.set("uploadId", uploadId);
    const response = await this.request("DELETE", url);
    this.assertResponse(response, [200, 202, 204, 404]);
    return { requestId: requiredResponseRequestId(response) };
  }

  async getUrl(
    key: string,
    options: { versionId?: string | null } = {},
  ): Promise<string> {
    const storedKey = this.storedKey(key);
    const versionId = normalizedVersionId(options.versionId ?? null);
    assertStableVersionId(versionId);
    if (this.config.urlMode === "cdn") {
      if (versionId) {
        throw new Error("OBJECT_STORAGE_EXACT_GENERATION_REQUIRES_SIGNED_URL");
      }
      if (!this.config.cdnUrl) throw new Error("OBJECT_STORAGE_CDN_CONFIGURATION_INVALID");
      return `${this.config.cdnUrl.replace(/\/+$/, "")}/${encodeKeyPath(storedKey)}`;
    }
    return this.signedDownloadUrl(storedKey, {
      versionId,
      expiresInSeconds: this.config.signedUrlTtlSeconds,
    });
  }

  /**
   * Explicit private delivery for upstream processors. This intentionally
   * ignores `urlMode=cdn` and caps every URL at fifteen minutes so a provider
   * never receives a stable public object URL.
   */
  async getSignedUrl(
    key: string,
    options: { versionId?: string | null; expiresInSeconds?: number } = {},
  ): Promise<string> {
    const expiresInSeconds = options.expiresInSeconds
      ?? Math.min(this.config.signedUrlTtlSeconds, 900);
    if (!Number.isSafeInteger(expiresInSeconds) || expiresInSeconds < 60 || expiresInSeconds > 900) {
      throw new Error("OBJECT_STORAGE_DOWNLOAD_TTL_INVALID");
    }
    const versionId = normalizedVersionId(options.versionId ?? null);
    assertStableVersionId(versionId);
    return this.signedDownloadUrl(this.storedKey(key), {
      versionId,
      expiresInSeconds,
    });
  }

  private signedDownloadUrl(
    storedKey: string,
    options: { versionId: string | null; expiresInSeconds: number },
  ): string {
    const url = this.objectUrl(storedKey);
    if (options.versionId) url.searchParams.set("versionId", options.versionId);
    const { amzDate, shortDate } = formatAmzDate(this.now());
    const scope = `${shortDate}/${this.config.region}/s3/aws4_request`;
    url.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
    url.searchParams.set("X-Amz-Credential", `${this.config.accessKey}/${scope}`);
    url.searchParams.set("X-Amz-Date", amzDate);
    url.searchParams.set("X-Amz-Expires", String(options.expiresInSeconds));
    url.searchParams.set("X-Amz-SignedHeaders", "host");
    const canonicalRequest = [
      "GET",
      url.pathname,
      canonicalQuery(url.searchParams),
      `host:${url.host}\n`,
      "host",
      "UNSIGNED-PAYLOAD",
    ].join("\n");
    const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256(canonicalRequest)}`;
    const signature = createHmac("sha256", signingKey(this.config.secretKey, shortDate, this.config.region))
      .update(stringToSign)
      .digest("hex");
    url.searchParams.set("X-Amz-Signature", signature);
    return url.toString();
  }

  /**
   * Create a short-lived browser/CI upload URL without exposing the storage
   * credential. The object remains private and must still be verified by the
   * release controller before it can be deployed.
   */
  async createUploadUrl(
    key: string,
    options: {
      expiresInSeconds?: number;
      contentLength?: number;
      contentType?: string;
    } = {},
  ): Promise<{ url: string; method: "PUT"; expiresAt: number }> {
    const expiresInSeconds = options.expiresInSeconds ?? Math.min(this.config.signedUrlTtlSeconds, 900);
    if (!Number.isSafeInteger(expiresInSeconds) || expiresInSeconds < 60 || expiresInSeconds > 900) {
      throw new Error("OBJECT_STORAGE_UPLOAD_TTL_INVALID");
    }
    const contentLength = options.contentLength;
    if (
      contentLength !== undefined
      && (!Number.isSafeInteger(contentLength) || contentLength < 1)
    ) {
      throw new Error("OBJECT_STORAGE_CONTENT_LENGTH_INVALID");
    }
    const contentType = normalizedSignedContentType(options.contentType);

    const url = this.objectUrl(this.storedKey(key));
    const now = this.now();
    const { amzDate, shortDate } = formatAmzDate(now);
    const scope = `${shortDate}/${this.config.region}/s3/aws4_request`;
    url.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
    url.searchParams.set("X-Amz-Credential", `${this.config.accessKey}/${scope}`);
    url.searchParams.set("X-Amz-Date", amzDate);
    url.searchParams.set("X-Amz-Expires", String(expiresInSeconds));
    const signedHeaderEntries: Array<[string, string]> = [];
    if (contentLength !== undefined) {
      signedHeaderEntries.push(["content-length", String(contentLength)]);
    }
    if (contentType) signedHeaderEntries.push(["content-type", contentType]);
    signedHeaderEntries.push(["host", url.host]);
    const signedHeaders = signedHeaderEntries.map(([name]) => name).join(";");
    const canonicalHeaders = signedHeaderEntries
      .map(([name, value]) => `${name}:${value}\n`)
      .join("");
    url.searchParams.set("X-Amz-SignedHeaders", signedHeaders);
    const canonicalRequest = [
      "PUT",
      url.pathname,
      canonicalQuery(url.searchParams),
      canonicalHeaders,
      signedHeaders,
      "UNSIGNED-PAYLOAD",
    ].join("\n");
    const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256(canonicalRequest)}`;
    const signature = createHmac("sha256", signingKey(this.config.secretKey, shortDate, this.config.region))
      .update(stringToSign)
      .digest("hex");
    url.searchParams.set("X-Amz-Signature", signature);
    return {
      url: url.toString(),
      method: "PUT",
      expiresAt: now.getTime() + expiresInSeconds * 1_000,
    };
  }
}

export function createRemoteObjectStorageAdapter(
  configuration: ObjectStorageConfiguration = resolveObjectStorageConfiguration(),
  options: { fetch?: FetchImplementation; now?: () => Date } = {},
): ObjectStorageAdapter {
  return new S3CompatibleObjectStorage(configuration, options);
}
