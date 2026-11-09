import { createHash, createHmac } from "node:crypto";

const ALGORITHM = "HMAC-SHA256";
const TERMINATOR = "request";
const JSON_CONTENT_TYPE = "application/json";

export type VolcengineV4Method = "GET" | "POST";

export interface VolcengineV4SignInput {
  accessKeyId: string;
  at: Date;
  body?: string;
  host: string;
  method: VolcengineV4Method;
  pathname?: string;
  query: Readonly<Record<string, string>>;
  region: string;
  secretAccessKey: string;
  service: string;
  sessionToken?: string;
}

export type VolcengineV4SignResult = Readonly<{
  authorization: string;
  canonicalQuery: string;
  canonicalRequest: string;
  credentialScope: string;
  dateTime: string;
  headers: Readonly<Record<string, string>>;
  payloadHash: string;
  signature: string;
  signedHeaders: string;
  stringToSign: string;
}>;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function canonicalQuery(input: Readonly<Record<string, string>>): string {
  return Object.entries(input)
    .map(([key, value]) => [encodeRfc3986(key), encodeRfc3986(value)] as const)
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
      if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1;
      if (leftValue === rightValue) return 0;
      return leftValue < rightValue ? -1 : 1;
    })
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

function opaque(value: unknown, code: string, maximum: number): string {
  if (
    typeof value !== "string"
    || !value
    || value !== value.trim()
    || value.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) throw new Error(code);
  return value;
}

function signDate(at: Date): string {
  if (!(at instanceof Date) || !Number.isFinite(at.getTime())) {
    throw new Error("VOLCENGINE_V4_CLOCK_INVALID");
  }
  return at.toISOString().replace(/[:-]|\.\d{3}/gu, "");
}

export function signVolcengineV4(input: VolcengineV4SignInput): VolcengineV4SignResult {
  const accessKeyId = opaque(input.accessKeyId, "VOLCENGINE_V4_ACCESS_KEY_INVALID", 256);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,255}$/u.test(accessKeyId)) {
    throw new Error("VOLCENGINE_V4_ACCESS_KEY_INVALID");
  }
  const secretAccessKey = opaque(input.secretAccessKey, "VOLCENGINE_V4_SECRET_KEY_INVALID", 4_096);
  const host = opaque(input.host.toLowerCase(), "VOLCENGINE_V4_HOST_INVALID", 255);
  if (!/^[a-z0-9.-]+$/u.test(host) || host.startsWith(".") || host.endsWith(".") || host.includes("..")) {
    throw new Error("VOLCENGINE_V4_HOST_INVALID");
  }
  const region = opaque(input.region, "VOLCENGINE_V4_REGION_INVALID", 64);
  const service = opaque(input.service, "VOLCENGINE_V4_SERVICE_INVALID", 64);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(region) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(service)) {
    throw new Error("VOLCENGINE_V4_SCOPE_INVALID");
  }
  const pathname = input.pathname ?? "/";
  if (!pathname.startsWith("/") || pathname.includes("?") || pathname.includes("#") || /[\u0000-\u001f\u007f]/u.test(pathname)) {
    throw new Error("VOLCENGINE_V4_PATH_INVALID");
  }
  if (input.method === "GET" && input.body !== undefined && input.body !== "") {
    throw new Error("VOLCENGINE_V4_GET_BODY_FORBIDDEN");
  }
  const body = input.method === "POST" ? (input.body ?? "") : "";
  if (typeof body !== "string") throw new Error("VOLCENGINE_V4_BODY_INVALID");
  for (const [key, value] of Object.entries(input.query)) {
    if (typeof key !== "string" || !key || typeof value !== "string") {
      throw new Error("VOLCENGINE_V4_QUERY_INVALID");
    }
  }

  const dateTime = signDate(input.at);
  const date = dateTime.slice(0, 8);
  const payloadHash = sha256Hex(body);
  const query = canonicalQuery(input.query);
  const headers: Record<string, string> = {
    "content-type": JSON_CONTENT_TYPE,
    host,
    "x-content-sha256": payloadHash,
    "x-date": dateTime,
  };
  if (input.sessionToken !== undefined) {
    headers["x-security-token"] = opaque(
      input.sessionToken,
      "VOLCENGINE_V4_SESSION_TOKEN_INVALID",
      8_192,
    );
  }
  const entries = Object.entries(headers)
    .map(([key, value]) => [key.toLowerCase(), value.replace(/\s+/gu, " ").trim()] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  const canonicalHeaders = entries.map(([key, value]) => `${key}:${value}`).join("\n");
  const signedHeaders = entries.map(([key]) => key).join(";");
  const canonicalRequest = [
    input.method,
    pathname,
    query,
    `${canonicalHeaders}\n`,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const credentialScope = `${date}/${region}/${service}/${TERMINATOR}`;
  const stringToSign = [
    ALGORITHM,
    dateTime,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const keyDate = hmac(secretAccessKey, date);
  const keyRegion = hmac(keyDate, region);
  const keyService = hmac(keyRegion, service);
  const signingKey = hmac(keyService, TERMINATOR);
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");
  const authorization = `${ALGORITHM} Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const outputHeaders: Record<string, string> = {
    "Content-Type": JSON_CONTENT_TYPE,
    Host: host,
    "X-Content-Sha256": payloadHash,
    "X-Date": dateTime,
    Authorization: authorization,
  };
  if (input.sessionToken !== undefined) outputHeaders["X-Security-Token"] = headers["x-security-token"];
  return Object.freeze({
    authorization,
    canonicalQuery: query,
    canonicalRequest,
    credentialScope,
    dateTime,
    headers: Object.freeze(outputHeaders),
    payloadHash,
    signature,
    signedHeaders,
    stringToSign,
  });
}

export function signVolcengineV4JsonPost(
  input: Omit<VolcengineV4SignInput, "method"> & { body: string },
): VolcengineV4SignResult {
  return signVolcengineV4({ ...input, method: "POST" });
}

export function signVolcengineV4Get(
  input: Omit<VolcengineV4SignInput, "body" | "method">,
): VolcengineV4SignResult {
  return signVolcengineV4({ ...input, method: "GET" });
}
