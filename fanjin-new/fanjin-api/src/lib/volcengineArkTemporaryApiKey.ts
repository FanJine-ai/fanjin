import { createHash, createHmac } from "node:crypto";

import { canonicalVolcengineQuery } from "@/release-controller/volcengineOpenApi";

const ALGORITHM = "HMAC-SHA256";
const TERMINATOR = "request";
const SERVICE = "ark";
const REGION = "cn-beijing";
const HOST = "open.volcengineapi.com";
const VERSION = "2024-01-01";
const ACTION = "GetApiKey";
const RESOURCE_TYPE = "presetendpoint";
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MIN_DURATION_SECONDS = 60;
const MAX_DURATION_SECONDS = 2_592_000;
const MAX_RESOURCE_IDS = 100;

export const VOLCENGINE_ARK_TEMPORARY_API_KEY_DURATION_SECONDS = 6 * 60 * 60;
export const VOLCENGINE_ARK_TEMPORARY_API_KEY_PROJECT = "default";
export const VOLCENGINE_ARK_TEMPORARY_API_KEY_ENDPOINT =
  `https://${HOST}/?Action=${ACTION}&Version=${VERSION}`;

export type VolcengineArkTemporaryApiKeyFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export type VolcengineArkTemporaryApiKeySignInput = {
  accessKeyId: string;
  secretAccessKey: string;
  body: string;
  at: Date;
};

export type VolcengineArkTemporaryApiKeySignResult = {
  authorization: string;
  bodyHash: string;
  canonicalRequest: string;
  credentialScope: string;
  dateTime: string;
  headers: Readonly<Record<string, string>>;
  signature: string;
  signedHeaders: string;
  stringToSign: string;
};

export type MintVolcengineArkTemporaryApiKeyInput = {
  accessKeyId: string;
  secretAccessKey: string;
  resourceIds: readonly string[];
  projectName?: string;
  durationSeconds?: number;
  fetch?: VolcengineArkTemporaryApiKeyFetch;
  now?: () => Date;
};

export type MintVolcengineArkTemporaryApiKeyResult = {
  apiKey: string;
  durationSeconds: number;
  projectName: string;
  resourceCount: number;
};

export class VolcengineArkTemporaryApiKeyError extends Error {
  readonly code: string;
  readonly httpStatus?: number;

  constructor(code: string, httpStatus?: number) {
    super(code);
    this.name = "VolcengineArkTemporaryApiKeyError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function safeToken(value: string, code: string, maximum: number): string {
  const normalized = value.trim();
  if (
    !normalized
    || normalized.length > maximum
    || /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new VolcengineArkTemporaryApiKeyError(code);
  }
  return normalized;
}

function accessKeyId(value: string): string {
  const normalized = safeToken(value, "VOLCENGINE_ARK_ACCESS_KEY_INVALID", 256);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]+$/.test(normalized)) {
    throw new VolcengineArkTemporaryApiKeyError("VOLCENGINE_ARK_ACCESS_KEY_INVALID");
  }
  return normalized;
}

function secretAccessKey(value: string): string {
  if (!value || value.length > 4_096 || value.includes("\0")) {
    throw new VolcengineArkTemporaryApiKeyError("VOLCENGINE_ARK_SECRET_KEY_INVALID");
  }
  return value;
}

function projectName(value: string): string {
  const normalized = safeToken(value, "VOLCENGINE_ARK_PROJECT_INVALID", 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(normalized)) {
    throw new VolcengineArkTemporaryApiKeyError("VOLCENGINE_ARK_PROJECT_INVALID");
  }
  return normalized;
}

function durationSeconds(value: number): number {
  if (
    !Number.isSafeInteger(value)
    || value < MIN_DURATION_SECONDS
    || value > MAX_DURATION_SECONDS
  ) {
    throw new VolcengineArkTemporaryApiKeyError("VOLCENGINE_ARK_DURATION_INVALID");
  }
  return value;
}

export function normalizeVolcengineArkPresetResourceIds(
  values: readonly string[],
): string[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > MAX_RESOURCE_IDS) {
    throw new VolcengineArkTemporaryApiKeyError("VOLCENGINE_ARK_RESOURCE_IDS_INVALID");
  }
  const normalized = Array.from(new Set(values.map((value) => {
    if (typeof value !== "string") {
      throw new VolcengineArkTemporaryApiKeyError("VOLCENGINE_ARK_RESOURCE_IDS_INVALID");
    }
    const id = value.trim();
    if (
      id.length < 3
      || id.length > 256
      || !/^[a-z0-9][a-z0-9._-]+$/i.test(id)
    ) {
      throw new VolcengineArkTemporaryApiKeyError("VOLCENGINE_ARK_RESOURCE_IDS_INVALID");
    }
    return id;
  }))).sort();
  if (normalized.length < 1) {
    throw new VolcengineArkTemporaryApiKeyError("VOLCENGINE_ARK_RESOURCE_IDS_INVALID");
  }
  return normalized;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

function signingDate(at: Date): string {
  if (!(at instanceof Date) || !Number.isFinite(at.getTime())) {
    throw new VolcengineArkTemporaryApiKeyError("VOLCENGINE_ARK_SIGNING_CLOCK_INVALID");
  }
  return at.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

/**
 * Signs the exact JSON POST shape documented by the Volcengine Ark GetApiKey
 * OpenAPI. This is deliberately separate from the release-controller's
 * GET-only CLB compatibility client so that its audited allowlist is unchanged.
 */
export function signVolcengineArkTemporaryApiKeyRequest(
  input: VolcengineArkTemporaryApiKeySignInput,
): VolcengineArkTemporaryApiKeySignResult {
  const normalizedAccessKeyId = accessKeyId(input.accessKeyId);
  const normalizedSecretAccessKey = secretAccessKey(input.secretAccessKey);
  if (typeof input.body !== "string" || Buffer.byteLength(input.body, "utf8") > 64 * 1024) {
    throw new VolcengineArkTemporaryApiKeyError("VOLCENGINE_ARK_REQUEST_BODY_INVALID");
  }
  const dateTime = signingDate(input.at);
  const date = dateTime.slice(0, 8);
  const credentialScope = `${date}/${REGION}/${SERVICE}/${TERMINATOR}`;
  const bodyHash = sha256Hex(input.body);
  const canonicalQuery = canonicalVolcengineQuery({
    Action: ACTION,
    Version: VERSION,
  });
  const canonicalHeaders = [
    `host:${HOST}`,
    `x-content-sha256:${bodyHash}`,
    `x-date:${dateTime}`,
  ].join("\n");
  const signedHeaders = "host;x-content-sha256;x-date";
  const canonicalRequest = [
    "POST",
    "/",
    canonicalQuery,
    `${canonicalHeaders}\n`,
    signedHeaders,
    bodyHash,
  ].join("\n");
  const stringToSign = [
    ALGORITHM,
    dateTime,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const keyDate = hmac(normalizedSecretAccessKey, date);
  const keyRegion = hmac(keyDate, REGION);
  const keyService = hmac(keyRegion, SERVICE);
  const signingKey = hmac(keyService, TERMINATOR);
  const signature = createHmac("sha256", signingKey)
    .update(stringToSign, "utf8")
    .digest("hex");
  const authorization = `${ALGORITHM} Credential=${normalizedAccessKeyId}/${credentialScope}, `
    + `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return Object.freeze({
    authorization,
    bodyHash,
    canonicalRequest,
    credentialScope,
    dateTime,
    headers: Object.freeze({
      Host: HOST,
      "X-Content-Sha256": bodyHash,
      "X-Date": dateTime,
      Authorization: authorization,
      "Content-Type": "application/json; charset=UTF-8",
    }),
    signature,
    signedHeaders,
    stringToSign,
  });
}

async function boundedResponseText(response: Response): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsed = Number(declaredLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_RESPONSE_BYTES) {
      throw new VolcengineArkTemporaryApiKeyError(
        "VOLCENGINE_ARK_RESPONSE_TOO_LARGE",
        response.status,
      );
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
        throw new VolcengineArkTemporaryApiKeyError(
          "VOLCENGINE_ARK_RESPONSE_TOO_LARGE",
          response.status,
        );
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
    throw new VolcengineArkTemporaryApiKeyError(
      "VOLCENGINE_ARK_RESPONSE_INVALID",
      response.status,
    );
  }
}

function returnedApiKey(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 16
    || value.length > 4_096
    || !/^[A-Za-z0-9._-]+$/.test(value)
  ) {
    throw new VolcengineArkTemporaryApiKeyError("VOLCENGINE_ARK_API_KEY_INVALID");
  }
  return value;
}

export async function mintVolcengineArkTemporaryApiKey(
  input: MintVolcengineArkTemporaryApiKeyInput,
): Promise<MintVolcengineArkTemporaryApiKeyResult> {
  const normalizedProjectName = projectName(
    input.projectName ?? VOLCENGINE_ARK_TEMPORARY_API_KEY_PROJECT,
  );
  const normalizedDurationSeconds = durationSeconds(
    input.durationSeconds ?? VOLCENGINE_ARK_TEMPORARY_API_KEY_DURATION_SECONDS,
  );
  const normalizedResourceIds = normalizeVolcengineArkPresetResourceIds(input.resourceIds);
  const body = JSON.stringify({
    DurationSeconds: normalizedDurationSeconds,
    ProjectName: normalizedProjectName,
    ResourceType: RESOURCE_TYPE,
    ResourceIds: normalizedResourceIds,
  });
  const signed = signVolcengineArkTemporaryApiKeyRequest({
    accessKeyId: input.accessKeyId,
    secretAccessKey: input.secretAccessKey,
    body,
    at: (input.now ?? (() => new Date()))(),
  });
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, DEFAULT_TIMEOUT_MS);
  let response: Response;
  let responseText: string;
  try {
    response = await (input.fetch ?? fetch)(VOLCENGINE_ARK_TEMPORARY_API_KEY_ENDPOINT, {
      method: "POST",
      headers: signed.headers,
      body,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: controller.signal,
    });
    responseText = await boundedResponseText(response);
  } catch (error) {
    if (error instanceof VolcengineArkTemporaryApiKeyError) throw error;
    if (timedOut) {
      throw new VolcengineArkTemporaryApiKeyError("VOLCENGINE_ARK_GET_API_KEY_TIMEOUT");
    }
    throw new VolcengineArkTemporaryApiKeyError("VOLCENGINE_ARK_GET_API_KEY_REQUEST_FAILED");
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new VolcengineArkTemporaryApiKeyError(
      `VOLCENGINE_ARK_GET_API_KEY_HTTP_${response.status}`,
      response.status,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    throw new VolcengineArkTemporaryApiKeyError(
      "VOLCENGINE_ARK_RESPONSE_INVALID",
      response.status,
    );
  }
  const result = (
    parsed
    && typeof parsed === "object"
    && !Array.isArray(parsed)
    && "Result" in parsed
    && parsed.Result
    && typeof parsed.Result === "object"
    && !Array.isArray(parsed.Result)
  )
    ? parsed.Result as Record<string, unknown>
    : null;
  const apiKey = returnedApiKey(result?.ApiKey);
  return Object.freeze({
    apiKey,
    durationSeconds: normalizedDurationSeconds,
    projectName: normalizedProjectName,
    resourceCount: normalizedResourceIds.length,
  });
}
