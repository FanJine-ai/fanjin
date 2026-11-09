import crypto from "node:crypto";
import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { v4 as uuid } from "uuid";
import { redactSensitiveText } from "@/lib/redactSensitiveText";
import { isProductionRuntime } from "@/lib/legacyAsyncRelaySafety";
import { db } from "@/utils/db";

export type RelayCallbackDeliveryStatus = "pending" | "leased" | "delivered" | "dead";

export interface RelayCallbackDelivery {
  id: string;
  taskId: string;
  event: string;
  callbackUrl: string;
  secretCiphertext: string | null;
  payload: string;
  payloadHash: string;
  status: RelayCallbackDeliveryStatus;
  attempts: number;
  nextAttemptAt: number;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  lastHttpStatus: number | null;
  lastError: string | null;
  deliveredAt: number | null;
  createTime: number;
  updateTime: number;
}

export interface CallbackDnsAddress {
  address: string;
  family: 4 | 6;
}

export type CallbackDnsLookup = (hostname: string) => Promise<CallbackDnsAddress[]>;

export class RelayCallbackUrlError extends Error {
  code: string;
  retryable: boolean;

  constructor(message: string, code: string, retryable = false) {
    super(message);
    this.name = "RelayCallbackUrlError";
    this.code = code;
    this.retryable = retryable;
  }
}

interface CallbackHttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  responseText: string;
  finalUrl: string;
  redirects: number;
}

interface CallbackAttemptResult {
  delivered: boolean;
  retryable: boolean;
  httpStatus: number | null;
  error: string | null;
  retryAfterMs?: number;
}

const CALLBACK_EVENT = "relay.task.terminal";
const CALLBACK_WORKER_OWNER = `relay-callback-${process.pid}-${uuid()}`;
const DEV_SIGNING_SECRET = crypto.randomBytes(32).toString("base64url");
const MAX_URL_LENGTH = 4096;

function callbackTable() {
  return db("o_relay_callback_delivery");
}

function callbackTimeoutMs(): number {
  const value = Number(process.env.FANJIN_RELAY_CALLBACK_TIMEOUT_MS || 5000);
  return Number.isFinite(value) && value >= 500 ? Math.min(value, 60_000) : 5000;
}

function callbackMaxRedirects(): number {
  const value = Number(process.env.FANJIN_RELAY_CALLBACK_MAX_REDIRECTS || 3);
  return Number.isInteger(value) && value >= 0 ? Math.min(value, 5) : 3;
}

function callbackDnsTimeoutMs(): number {
  const value = Number(process.env.FANJIN_RELAY_CALLBACK_DNS_TIMEOUT_MS || 3000);
  return Number.isFinite(value) && value >= 500 ? Math.min(value, 15_000) : 3000;
}

function callbackMaxAttempts(): number {
  const value = Number(process.env.FANJIN_RELAY_CALLBACK_MAX_ATTEMPTS || 8);
  return Number.isInteger(value) && value > 0 ? Math.min(value, 20) : 8;
}

function callbackMaxPayloadBytes(): number {
  const value = Number(process.env.FANJIN_RELAY_CALLBACK_MAX_PAYLOAD_BYTES || 256 * 1024);
  return Number.isFinite(value) && value >= 1024 ? Math.min(value, 2 * 1024 * 1024) : 256 * 1024;
}

function callbackLeaseMs(requested?: number): number {
  const minimum = (callbackTimeoutMs() + callbackDnsTimeoutMs()) * (callbackMaxRedirects() + 1) + 10_000;
  const configured = Number(requested || process.env.FANJIN_RELAY_CALLBACK_LEASE_MS || 60_000);
  return Math.max(minimum, Number.isFinite(configured) ? configured : 60_000);
}

function allowLoopbackCallbackForTest(): boolean {
  return process.env.NODE_ENV === "test" && process.env.FANJIN_TEST_ALLOW_LOCAL_CALLBACK_URLS === "1";
}

function allowInsecureHttpCallback(): boolean {
  if (isProductionRuntime()) return false;
  return allowLoopbackCallbackForTest() || process.env.FANJIN_RELAY_CALLBACK_ALLOW_HTTP === "1";
}

function signingSecret(): string {
  const configured = String(process.env.FANJIN_RELAY_CALLBACK_SIGNING_SECRET || "");
  if (Buffer.byteLength(configured, "utf8") >= 32) return configured;
  if (!isProductionRuntime()) return DEV_SIGNING_SECRET;
  throw new RelayCallbackUrlError(
    "回调签名密钥未配置或短于 32 字节",
    "callback_signing_secret_missing",
    true,
  );
}

function callbackSecretEncryptionKey(masterSecret: string): Buffer {
  return crypto.createHash("sha256").update(`fanjin-relay-callback-secret:v1\0${masterSecret}`).digest();
}

export function sealRelayCallbackSecret(secret: string, callbackUrl: string): string {
  const secretBytes = Buffer.byteLength(secret, "utf8");
  if (secretBytes < 32 || secretBytes > 512) {
    throw new RelayCallbackUrlError("callback_secret 必须为 32-512 字节", "invalid_callback_secret");
  }
  const normalizedUrl = parseAndValidateCallbackUrl(callbackUrl).toString();
  const key = callbackSecretEncryptionKey(signingSecret());
  // 相同 URL + secret 得到相同密文，使 API 幂等请求保持稳定。GCM nonce
  // 只会在明文也完全相同时复用，不会形成不同明文共用 nonce。
  const nonce = crypto.createHmac("sha256", key).update(normalizedUrl).update("\0").update(secret).digest().subarray(0, 12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(normalizedUrl, "utf8"));
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", nonce.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url")].join(".");
}

function openRelayCallbackSecret(ciphertext: string, callbackUrl: string): string {
  const [version, nonceValue, tagValue, encryptedValue, ...extra] = String(ciphertext || "").split(".");
  if (version !== "v1" || !nonceValue || !tagValue || !encryptedValue || extra.length) {
    throw new RelayCallbackUrlError("callback secret 密文格式无效", "callback_secret_ciphertext_invalid");
  }
  try {
    const normalizedUrl = parseAndValidateCallbackUrl(callbackUrl).toString();
    const key = callbackSecretEncryptionKey(signingSecret());
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(nonceValue, "base64url"));
    decipher.setAAD(Buffer.from(normalizedUrl, "utf8"));
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(encryptedValue, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    const bytes = Buffer.byteLength(plaintext, "utf8");
    if (bytes < 32 || bytes > 512) throw new Error("invalid plaintext length");
    return plaintext;
  } catch (error: any) {
    if (error instanceof RelayCallbackUrlError) throw error;
    throw new RelayCallbackUrlError(
      "callback secret 无法解密；请检查签名主密钥是否被错误轮换",
      "callback_secret_decryption_failed",
      true,
    );
  }
}

export function assertRelayCallbackConfigured(): void {
  signingSecret();
  if (isProductionRuntime() && process.env.FANJIN_RELAY_CALLBACK_ALLOW_HTTP === "1") {
    throw new RelayCallbackUrlError("生产环境禁止允许明文 HTTP 回调", "insecure_callback_policy", false);
  }
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "");
}

function parseIpv4(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet < 0 || octet > 255) return null;
    value = (value * 256 + octet) >>> 0;
  }
  return value >>> 0;
}

function ipv4InCidr(address: number, base: string, prefix: number): boolean {
  const baseValue = parseIpv4(base);
  if (baseValue == null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (address & mask) >>> 0 === (baseValue & mask) >>> 0;
}

const NON_PUBLIC_IPV4_RANGES: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function isIpv4Loopback(address: string): boolean {
  const value = parseIpv4(address);
  return value != null && ipv4InCidr(value, "127.0.0.0", 8);
}

function parseIpv6(address: string): Buffer | null {
  let value = stripIpv6Brackets(address).toLowerCase();
  const zoneIndex = value.indexOf("%");
  if (zoneIndex >= 0) value = value.slice(0, zoneIndex);

  const embeddedIpv4Match = value.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/);
  if (embeddedIpv4Match) {
    const ipv4 = parseIpv4(embeddedIpv4Match[1]);
    if (ipv4 == null) return null;
    value = value.slice(0, -embeddedIpv4Match[1].length) + `${((ipv4 >>> 16) & 0xffff).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  }

  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (left.some((part) => !/^[0-9a-f]{1,4}$/.test(part)) || right.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const words = [...left, ...Array(missing).fill("0"), ...right].map((part) => Number.parseInt(part, 16));
  if (words.length !== 8) return null;
  const bytes = Buffer.alloc(16);
  words.forEach((word, index) => bytes.writeUInt16BE(word, index * 2));
  return bytes;
}

function bufferHasPrefix(value: Buffer, prefix: Buffer, prefixBits: number): boolean {
  const wholeBytes = Math.floor(prefixBits / 8);
  const remainingBits = prefixBits % 8;
  for (let index = 0; index < wholeBytes; index += 1) {
    if (value[index] !== prefix[index]) return false;
  }
  if (!remainingBits) return true;
  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return (value[wholeBytes] & mask) === (prefix[wholeBytes] & mask);
}

function ipv6Prefix(value: Buffer, address: string, prefixBits: number): boolean {
  const prefix = parseIpv6(address);
  return Boolean(prefix && bufferHasPrefix(value, prefix, prefixBits));
}

function isIpv6Loopback(address: string): boolean {
  const value = parseIpv6(address);
  return Boolean(value && value.equals(Buffer.from("00000000000000000000000000000001", "hex")));
}

function embeddedMappedIpv4(value: Buffer): string | null {
  const mappedPrefix = Buffer.from("00000000000000000000ffff", "hex");
  if (!value.subarray(0, 12).equals(mappedPrefix)) return null;
  return `${value[12]}.${value[13]}.${value[14]}.${value[15]}`;
}

export function isPublicRelayCallbackAddress(address: string): boolean {
  const normalized = stripIpv6Brackets(String(address || "").trim().toLowerCase());
  const version = isIP(normalized);
  if (version === 4) {
    if (allowLoopbackCallbackForTest() && isIpv4Loopback(normalized)) return true;
    const value = parseIpv4(normalized);
    return value != null && !NON_PUBLIC_IPV4_RANGES.some(([base, prefix]) => ipv4InCidr(value, base, prefix));
  }
  if (version === 6) {
    if (allowLoopbackCallbackForTest() && isIpv6Loopback(normalized)) return true;
    const value = parseIpv6(normalized);
    if (!value) return false;
    const mappedIpv4 = embeddedMappedIpv4(value);
    if (mappedIpv4) return isPublicRelayCallbackAddress(mappedIpv4);
    if (value.equals(Buffer.alloc(16)) || isIpv6Loopback(normalized)) return false;
    return ipv6Prefix(value, "2000::", 3) && !(
      ipv6Prefix(value, "100::", 64) ||
      ipv6Prefix(value, "2001:db8::", 32) ||
      ipv6Prefix(value, "fc00::", 7) ||
      ipv6Prefix(value, "fe80::", 10) ||
      ipv6Prefix(value, "ff00::", 8)
    );
  }
  return false;
}

function parseAndValidateCallbackUrl(value: unknown): URL {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_URL_LENGTH) {
    throw new RelayCallbackUrlError("callback_url 格式无效", "invalid_callback_url");
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new RelayCallbackUrlError("callback_url 格式无效", "invalid_callback_url");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new RelayCallbackUrlError("callback_url 仅支持 HTTPS", "invalid_callback_protocol");
  }
  if (url.protocol === "http:" && !allowInsecureHttpCallback()) {
    throw new RelayCallbackUrlError("callback_url 必须使用 HTTPS", "insecure_callback_url");
  }
  if (url.username || url.password) {
    throw new RelayCallbackUrlError("callback_url 不允许包含用户名或密码", "callback_credentials_forbidden");
  }
  if (url.hash) {
    throw new RelayCallbackUrlError("callback_url 不允许包含 fragment", "callback_fragment_forbidden");
  }
  const hostname = stripIpv6Brackets(url.hostname).toLowerCase();
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "metadata.google.internal") {
    throw new RelayCallbackUrlError("callback_url 不允许指向本机、内网或云元数据地址", "unsafe_callback_host");
  }
  if (isIP(hostname) && !isPublicRelayCallbackAddress(hostname)) {
    throw new RelayCallbackUrlError("callback_url 不允许指向本机、内网或云元数据地址", "unsafe_callback_address");
  }
  return url;
}

export function isSafeRelayCallbackUrl(value: unknown): boolean {
  try {
    parseAndValidateCallbackUrl(value);
    return true;
  } catch {
    return false;
  }
}

async function defaultDnsLookup(hostname: string): Promise<CallbackDnsAddress[]> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(Object.assign(new Error("DNS lookup timed out"), { code: "ETIMEOUT" })),
      callbackDnsTimeoutMs(),
    );
    timer.unref?.();
  });
  const answers = await Promise.race([dns.lookup(hostname, { all: true, verbatim: true }), timeout])
    .finally(() => {
      if (timer) clearTimeout(timer);
    });
  return answers
    .filter((answer): answer is { address: string; family: 4 | 6 } => answer.family === 4 || answer.family === 6)
    .map((answer) => ({ address: answer.address, family: answer.family }));
}

async function resolveCallbackTarget(url: URL, lookup: CallbackDnsLookup): Promise<CallbackDnsAddress> {
  const hostname = stripIpv6Brackets(url.hostname).toLowerCase();
  if (isIP(hostname)) {
    if (!isPublicRelayCallbackAddress(hostname)) {
      throw new RelayCallbackUrlError("回调目标地址不是公网地址", "unsafe_callback_address");
    }
    return { address: hostname, family: isIP(hostname) as 4 | 6 };
  }

  let answers: CallbackDnsAddress[];
  try {
    answers = await lookup(hostname);
  } catch (error: any) {
    throw new RelayCallbackUrlError(
      `callback_url DNS 解析失败: ${String(error?.code || error?.message || "unknown")}`,
      "callback_dns_failed",
      true,
    );
  }
  if (!answers.length) {
    throw new RelayCallbackUrlError("callback_url DNS 没有返回地址", "callback_dns_empty", true);
  }
  if (answers.some((answer) => !isPublicRelayCallbackAddress(answer.address))) {
    throw new RelayCallbackUrlError("callback_url DNS 返回了非公网地址", "unsafe_callback_dns_answer");
  }
  return answers[0];
}

export async function validateRelayCallbackUrl(
  value: unknown,
  options: { lookup?: CallbackDnsLookup } = {},
): Promise<string> {
  const url = parseAndValidateCallbackUrl(value);
  await resolveCallbackTarget(url, options.lookup || defaultDnsLookup);
  return url.toString();
}

/** Normalize and protect callback fields before a relay task is persisted. */
export async function prepareRelayCallbackRequestPayload<T extends Record<string, unknown>>(
  input: T,
  options: { requireClientSecret?: boolean } = {},
): Promise<T & { callback_url?: string; callback_secret_ciphertext?: string }> {
  const payload: Record<string, unknown> = { ...input };
  const callbackUrl = payload.callback_url || payload.callbackUrl;
  const snakeSecret = payload.callback_secret;
  const camelSecret = payload.callbackSecret;
  // This field is server-owned. Never trust an envelope supplied by an API caller.
  delete payload.callback_secret_ciphertext;

  if (!callbackUrl) {
    if (snakeSecret != null || camelSecret != null) {
      throw new RelayCallbackUrlError("callback_secret 必须和 callback_url 一起提供", "callback_url_required");
    }
    delete payload.callback_secret;
    delete payload.callbackSecret;
    return payload as T & { callback_url?: string; callback_secret_ciphertext?: string };
  }
  if (typeof callbackUrl !== "string") {
    throw new RelayCallbackUrlError("callback_url 格式无效", "invalid_callback_url");
  }

  assertRelayCallbackConfigured();
  const normalizedUrl = await validateRelayCallbackUrl(callbackUrl);
  if (
    (snakeSecret != null && typeof snakeSecret !== "string") ||
    (camelSecret != null && typeof camelSecret !== "string")
  ) {
    throw new RelayCallbackUrlError("callback_secret 格式无效", "invalid_callback_secret");
  }
  if (snakeSecret && camelSecret && snakeSecret !== camelSecret) {
    throw new RelayCallbackUrlError("callback_secret 与 callbackSecret 不一致", "callback_secret_conflict");
  }
  const callbackSecret = (snakeSecret || camelSecret || null) as string | null;
  if (isProductionRuntime() && !callbackSecret && options.requireClientSecret !== false) {
    throw new RelayCallbackUrlError(
      "生产环境使用 callback_url 时必须同时提供至少 32 字节的 callback_secret",
      "callback_secret_required",
    );
  }
  if (callbackSecret) {
    payload["callback_secret_ciphertext"] = sealRelayCallbackSecret(callbackSecret, normalizedUrl);
  }
  payload["callback_url"] = normalizedUrl;
  delete payload.callbackUrl;
  delete payload.callback_secret;
  delete payload.callbackSecret;
  return payload as T & { callback_url?: string; callback_secret_ciphertext?: string };
}

function redactCallbackUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = url.search ? "?[REDACTED]" : "";
    return url.toString();
  } catch {
    return "[INVALID_CALLBACK_URL]";
  }
}

function safeError(value: unknown): string {
  return redactSensitiveText(value).replace(/https?:\/\/[^\s]+/gi, (url) => redactCallbackUrl(url)).slice(0, 1000);
}

function parseDelivery(row: any): RelayCallbackDelivery {
  return {
    id: String(row.id),
    taskId: String(row.taskId),
    event: String(row.event || CALLBACK_EVENT),
    callbackUrl: String(row.callbackUrl),
    secretCiphertext: row.secretCiphertext ?? null,
    payload: String(row.payload || "{}"),
    payloadHash: String(row.payloadHash || ""),
    status: row.status,
    attempts: Number(row.attempts || 0),
    nextAttemptAt: Number(row.nextAttemptAt || 0),
    leaseOwner: row.leaseOwner ?? null,
    leaseExpiresAt: row.leaseExpiresAt == null ? null : Number(row.leaseExpiresAt),
    lastHttpStatus: row.lastHttpStatus == null ? null : Number(row.lastHttpStatus),
    lastError: row.lastError ?? null,
    deliveredAt: row.deliveredAt == null ? null : Number(row.deliveredAt),
    createTime: Number(row.createTime || 0),
    updateTime: Number(row.updateTime || 0),
  };
}

async function updateTaskCallbackProjection(delivery: RelayCallbackDelivery): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const row = await db("o_relay_task").where({ id: delivery.taskId }).select("providerPayload").first();
    if (!row) return;
    let providerPayload: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(String(row.providerPayload || "{}"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) providerPayload = parsed;
    } catch {
      providerPayload = {};
    }
    const callback = {
      deliveryId: delivery.id,
      event: delivery.event,
      status: delivery.status,
      attempts: delivery.attempts,
      nextAttemptAt: delivery.status === "pending" ? delivery.nextAttemptAt : null,
      attemptedAt: delivery.attempts > 0 ? delivery.updateTime : null,
      deliveredAt: delivery.deliveredAt,
      ok: delivery.status === "delivered",
      httpStatus: delivery.lastHttpStatus,
      error: delivery.lastError,
      url: redactCallbackUrl(delivery.callbackUrl),
    };
    const nextPayload = JSON.stringify({ ...providerPayload, callback });
    const affected = await db("o_relay_task")
      .where({ id: delivery.taskId, providerPayload: row.providerPayload })
      .update({ providerPayload: nextPayload });
    if (Number(affected || 0) === 1) return;
  }
}

export async function getRelayCallbackDeliveryByTask(taskId: string): Promise<RelayCallbackDelivery | null> {
  const row = await callbackTable().where({ taskId }).first();
  return row ? parseDelivery(row) : null;
}

export async function enqueueRelayCallbackDelivery(input: {
  taskId: string;
  callbackUrl: string;
  payload: Record<string, unknown>;
  event?: string;
  signingSecret?: string;
  secretCiphertext?: string | null;
}): Promise<RelayCallbackDelivery> {
  const url = parseAndValidateCallbackUrl(input.callbackUrl).toString();
  if (input.signingSecret && input.secretCiphertext) {
    throw new RelayCallbackUrlError("回调签名密钥输入冲突", "callback_secret_conflict");
  }
  const secretCiphertext = input.signingSecret
    ? sealRelayCallbackSecret(input.signingSecret, url)
    : input.secretCiphertext || null;
  if (secretCiphertext) openRelayCallbackSecret(secretCiphertext, url);
  const payload = JSON.stringify(input.payload);
  if (Buffer.byteLength(payload, "utf8") > callbackMaxPayloadBytes()) {
    throw new RelayCallbackUrlError("回调 payload 超过大小限制", "callback_payload_too_large");
  }
  const payloadHash = crypto.createHash("sha256").update(payload).digest("hex");
  const timestamp = Date.now();
  const id = uuid();
  try {
    await callbackTable().insert({
      id,
      taskId: input.taskId,
      event: input.event || CALLBACK_EVENT,
      callbackUrl: url,
      secretCiphertext,
      payload,
      payloadHash,
      status: "pending",
      attempts: 0,
      nextAttemptAt: timestamp,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastHttpStatus: null,
      lastError: null,
      deliveredAt: null,
      createTime: timestamp,
      updateTime: timestamp,
    });
  } catch (error) {
    const existing = await callbackTable().where({ taskId: input.taskId }).first();
    if (!existing) throw error;
    const delivery = parseDelivery(existing);
    if (
      delivery.callbackUrl !== url ||
      delivery.payloadHash !== payloadHash ||
      (delivery.secretCiphertext || null) !== secretCiphertext
    ) {
      throw new RelayCallbackUrlError("同一任务的回调快照已存在且内容不一致", "callback_snapshot_conflict");
    }
    return delivery;
  }
  const delivery = parseDelivery(await callbackTable().where({ id }).first());
  await updateTaskCallbackProjection(delivery).catch(() => undefined);
  return delivery;
}

async function requestPinnedCallback(input: {
  url: URL;
  target: CallbackDnsAddress;
  headers: Record<string, string>;
  body: string;
}): Promise<{ status: number; headers: http.IncomingHttpHeaders; responseText: string }> {
  const hostname = stripIpv6Brackets(input.url.hostname);
  const secure = input.url.protocol === "https:";
  const transport = secure ? https : http;
  const maxResponseBytes = 4096;
  return await new Promise((resolve, reject) => {
    let settled = false;
    let absoluteTimer: NodeJS.Timeout | null = null;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (absoluteTimer) clearTimeout(absoluteTimer);
      callback();
    };
    const request = transport.request(
      {
        protocol: input.url.protocol,
        hostname: input.target.address,
        family: input.target.family,
        port: input.url.port || (secure ? 443 : 80),
        method: "POST",
        path: `${input.url.pathname || "/"}${input.url.search}`,
        servername: secure && !isIP(hostname) ? hostname : undefined,
        rejectUnauthorized: true,
        headers: {
          ...input.headers,
          Host: input.url.host,
          "Content-Length": String(Buffer.byteLength(input.body, "utf8")),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let total = 0;
        response.on("data", (chunk: Buffer | string) => {
          if (total >= maxResponseBytes) return;
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          const remaining = maxResponseBytes - total;
          chunks.push(buffer.subarray(0, remaining));
          total += Math.min(buffer.length, remaining);
          if (total >= maxResponseBytes) {
            finish(() => resolve({
              status: Number(response.statusCode || 0),
              headers: response.headers,
              responseText: Buffer.concat(chunks).toString("utf8"),
            }));
            response.destroy();
          }
        });
        response.on("end", () => finish(() => resolve({
          status: Number(response.statusCode || 0),
          headers: response.headers,
          responseText: Buffer.concat(chunks).toString("utf8"),
        })));
        response.on("error", (error) => finish(() => reject(error)));
        response.on("aborted", () => finish(() => reject(new Error("callback response aborted"))));
      },
    );
    absoluteTimer = setTimeout(() => request.destroy(new Error("callback request timed out")), callbackTimeoutMs());
    absoluteTimer.unref?.();
    request.on("error", (error) => finish(() => reject(error)));
    request.end(input.body);
  });
}

async function postCallbackWithRedirectValidation(input: {
  callbackUrl: string;
  headers: Record<string, string>;
  body: string;
  lookup?: CallbackDnsLookup;
}): Promise<CallbackHttpResult> {
  const lookup = input.lookup || defaultDnsLookup;
  let url = parseAndValidateCallbackUrl(input.callbackUrl);
  const seen = new Set<string>();
  const maxRedirects = callbackMaxRedirects();

  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    const canonicalUrl = url.toString();
    if (seen.has(canonicalUrl)) {
      throw new RelayCallbackUrlError("callback_url 重定向形成循环", "callback_redirect_loop");
    }
    seen.add(canonicalUrl);
    const target = await resolveCallbackTarget(url, lookup);
    const response = await requestPinnedCallback({ url, target, headers: input.headers, body: input.body });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return { ...response, finalUrl: canonicalUrl, redirects };
    }
    const location = Array.isArray(response.headers.location) ? response.headers.location[0] : response.headers.location;
    if (!location) {
      throw new RelayCallbackUrlError("callback_url 重定向缺少 Location", "callback_redirect_missing_location");
    }
    if (redirects >= maxRedirects) {
      throw new RelayCallbackUrlError("callback_url 重定向次数过多", "callback_redirect_limit");
    }
    let nextUrl: URL;
    try {
      nextUrl = new URL(location, url);
    } catch {
      throw new RelayCallbackUrlError("callback_url 重定向 Location 无效", "callback_redirect_invalid");
    }
    nextUrl = parseAndValidateCallbackUrl(nextUrl.toString());
    if (url.protocol === "https:" && nextUrl.protocol !== "https:") {
      throw new RelayCallbackUrlError("callback_url 禁止从 HTTPS 降级重定向到 HTTP", "callback_redirect_downgrade");
    }
    url = nextUrl;
  }
  throw new RelayCallbackUrlError("callback_url 重定向次数过多", "callback_redirect_limit");
}

function signatureHeaders(delivery: RelayCallbackDelivery): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const canonical = `${delivery.id}.${timestamp}.${delivery.payload}`;
  const deliverySecret = delivery.secretCiphertext
    ? openRelayCallbackSecret(delivery.secretCiphertext, delivery.callbackUrl)
    : signingSecret();
  const signature = crypto.createHmac("sha256", deliverySecret).update(canonical).digest("hex");
  return {
    "Content-Type": "application/json",
    "User-Agent": "Fanjin-Relay-Webhook/1.0",
    "Idempotency-Key": delivery.id,
    "X-Fanjin-Event": delivery.event,
    "X-Fanjin-Webhook-Id": delivery.id,
    "X-Fanjin-Webhook-Attempt": String(delivery.attempts),
    "X-Fanjin-Webhook-Timestamp": timestamp,
    "X-Fanjin-Webhook-Signature": `v1=${signature}`,
  };
}

function retryAfterMs(value: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 24 * 60 * 60_000);
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, Math.min(date - Date.now(), 24 * 60 * 60_000));
  return undefined;
}

async function attemptDelivery(delivery: RelayCallbackDelivery, lookup?: CallbackDnsLookup): Promise<CallbackAttemptResult> {
  try {
    const response = await postCallbackWithRedirectValidation({
      callbackUrl: delivery.callbackUrl,
      headers: signatureHeaders(delivery),
      body: delivery.payload,
      lookup,
    });
    if (response.status >= 200 && response.status < 300) {
      return { delivered: true, retryable: false, httpStatus: response.status, error: null };
    }
    const retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
    return {
      delivered: false,
      retryable,
      httpStatus: response.status,
      error: safeError(`callback HTTP ${response.status}: ${response.responseText || "empty response"}`),
      retryAfterMs: retryAfterMs(response.headers["retry-after"]),
    };
  } catch (error: any) {
    if (error instanceof RelayCallbackUrlError) {
      return { delivered: false, retryable: error.retryable, httpStatus: null, error: `${error.code}: ${safeError(error.message)}` };
    }
    return { delivered: false, retryable: true, httpStatus: null, error: safeError(error?.message || error) };
  }
}

function retryDelayMs(delivery: RelayCallbackDelivery, requested?: number): number {
  if (requested != null && Number.isFinite(requested)) return Math.max(1000, requested);
  const base = Math.min(6 * 60 * 60_000, 5000 * 2 ** Math.max(0, delivery.attempts - 1));
  const deterministicJitter = Number.parseInt(delivery.payloadHash.slice(0, 8), 16) % Math.max(1, Math.floor(base / 5));
  return base + deterministicJitter;
}

async function claimDelivery(input: {
  workerId: string;
  now: number;
  leaseMs?: number;
  taskId?: string;
}): Promise<RelayCallbackDelivery | null> {
  const candidates = callbackTable()
    .where((builder) => {
      builder
        .where((pending) => pending.where({ status: "pending" }).andWhere("nextAttemptAt", "<=", input.now))
        .orWhere((expired) => expired.where({ status: "leased" }).andWhere("leaseExpiresAt", "<=", input.now));
    })
    .orderBy("nextAttemptAt", "asc");
  if (input.taskId) candidates.andWhere({ taskId: input.taskId });
  const candidate = await candidates.first();
  if (!candidate) return null;

  const affected = await callbackTable()
    .where({ id: candidate.id })
    .where((builder) => {
      builder
        .where((pending) => pending.where({ status: "pending" }).andWhere("nextAttemptAt", "<=", input.now))
        .orWhere((expired) => expired.where({ status: "leased" }).andWhere("leaseExpiresAt", "<=", input.now));
    })
    .update({
      status: "leased",
      leaseOwner: input.workerId,
      leaseExpiresAt: input.now + callbackLeaseMs(input.leaseMs),
      attempts: db.raw("COALESCE(attempts, 0) + 1"),
      updateTime: input.now,
    });
  if (Number(affected || 0) !== 1) return null;
  const claimed = await callbackTable().where({ id: candidate.id, status: "leased", leaseOwner: input.workerId }).first();
  return claimed ? parseDelivery(claimed) : null;
}

async function finishDelivery(
  delivery: RelayCallbackDelivery,
  workerId: string,
  result: CallbackAttemptResult,
): Promise<RelayCallbackDelivery> {
  const timestamp = Date.now();
  const exhausted = delivery.attempts >= callbackMaxAttempts();
  const status: RelayCallbackDeliveryStatus = result.delivered
    ? "delivered"
    : result.retryable && !exhausted
      ? "pending"
      : "dead";
  const nextAttemptAt = status === "pending" ? timestamp + retryDelayMs(delivery, result.retryAfterMs) : timestamp;
  const affected = await callbackTable()
    .where({ id: delivery.id, status: "leased", leaseOwner: workerId })
    .update({
      status,
      nextAttemptAt,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastHttpStatus: result.httpStatus,
      lastError: result.error,
      deliveredAt: result.delivered ? timestamp : null,
      updateTime: timestamp,
    });
  if (Number(affected || 0) !== 1) {
    const current = await callbackTable().where({ id: delivery.id }).first();
    if (current) return parseDelivery(current);
    throw new Error("回调投递记录在完成 CAS 时丢失");
  }
  const row = await callbackTable().where({ id: delivery.id }).first();
  const updated = parseDelivery(row);
  await updateTaskCallbackProjection(updated).catch(() => undefined);
  return updated;
}

export async function processRelayCallbackDeliveryForTask(input: {
  taskId: string;
  workerId?: string;
  now?: number;
  leaseMs?: number;
  lookup?: CallbackDnsLookup;
}): Promise<RelayCallbackDelivery | null> {
  const workerId = input.workerId || `${CALLBACK_WORKER_OWNER}:task:${uuid()}`;
  const delivery = await claimDelivery({
    workerId,
    taskId: input.taskId,
    now: input.now ?? Date.now(),
    leaseMs: input.leaseMs,
  });
  if (!delivery) return null;
  const result = await attemptDelivery(delivery, input.lookup);
  return await finishDelivery(delivery, workerId, result);
}

export async function processRelayCallbackDeliveryBatch(input: {
  workerId?: string;
  limit?: number;
  now?: number;
  leaseMs?: number;
  lookup?: CallbackDnsLookup;
} = {}): Promise<{ claimed: number; processed: number }> {
  const workerId = input.workerId || CALLBACK_WORKER_OWNER;
  const limit = Math.max(1, Math.min(Number(input.limit || 20), 100));
  let claimed = 0;
  let processed = 0;
  for (let index = 0; index < limit; index += 1) {
    const delivery = await claimDelivery({ workerId, now: input.now ?? Date.now(), leaseMs: input.leaseMs });
    if (!delivery) break;
    claimed += 1;
    const result = await attemptDelivery(delivery, input.lookup);
    await finishDelivery(delivery, workerId, result);
    processed += 1;
  }
  return { claimed, processed };
}

export async function repairMissingRelayCallbackDeliveries(limit = 100): Promise<number> {
  const rows = await db("o_relay_task as task")
    .leftJoin("o_relay_callback_delivery as delivery", "delivery.taskId", "task.id")
    .select("task.*")
    .whereIn("task.status", ["mocked", "succeeded", "failed", "cancelled"])
    .whereNull("delivery.id")
    .andWhere((builder) => {
      builder
        .where("task.requestPayload", "like", '%"callback_url":"%')
        .orWhere("task.requestPayload", "like", '%"callbackUrl":"%');
    })
    .orderBy("task.completedAt", "asc")
    .limit(Math.max(1, Math.min(limit, 500)));
  if (!rows.length) return 0;

  // 动态导入避免 relay.ts 在终态入队路径静态依赖本模块时形成初始化循环。
  const relay = await import("@/lib/relay");
  let repaired = 0;
  for (const row of rows) {
    const task = relay.parseRelayTask(row);
    const callbackUrl = task.requestPayload.callback_url || task.requestPayload.callbackUrl;
    if (typeof callbackUrl !== "string" || !callbackUrl.trim()) continue;
    const legacyCallback = task.providerPayload.callback && typeof task.providerPayload.callback === "object"
      ? task.providerPayload.callback as Record<string, unknown>
      : null;
    const legacyDeliveredAt = Number(legacyCallback?.deliveredAt || 0);
    // Delivered outbox rows are intentionally subject to long-term retention.
    // The task projection is the durable tombstone that prevents the repair
    // scan from recreating a purged delivery on every subsequent worker tick.
    if (legacyDeliveredAt > 0) continue;
    try {
      await enqueueRelayCallbackDelivery({
        taskId: task.id,
        callbackUrl,
        payload: await relay.formatPublicRelayTask(task),
        secretCiphertext: typeof task.requestPayload.callback_secret_ciphertext === "string"
          ? task.requestPayload.callback_secret_ciphertext
          : null,
      });
      repaired += 1;
    } catch (error: any) {
      console.warn("[relay-callback] repair enqueue failed", task.id, safeError(error?.message || error));
    }
  }
  return repaired;
}

let callbackWorkerTimer: NodeJS.Timeout | null = null;
let callbackWorkerRunning = false;

export function startRelayCallbackDeliveryWorker(): void {
  if (callbackWorkerTimer || process.env.FANJIN_DISABLE_RELAY_CALLBACK_WORKER === "1") return;
  const intervalMs = Math.max(5000, Number(process.env.FANJIN_RELAY_CALLBACK_WORKER_INTERVAL_MS || 30_000));
  const batchSize = Math.max(1, Math.min(Number(process.env.FANJIN_RELAY_CALLBACK_WORKER_BATCH_SIZE || 20), 100));
  const run = async () => {
    if (callbackWorkerRunning) return;
    callbackWorkerRunning = true;
    try {
      await repairMissingRelayCallbackDeliveries(batchSize);
      await processRelayCallbackDeliveryBatch({ workerId: CALLBACK_WORKER_OWNER, limit: batchSize });
    } catch (error: any) {
      console.warn("[relay-callback] worker batch failed", safeError(error?.message || error));
    } finally {
      callbackWorkerRunning = false;
    }
  };
  void run();
  callbackWorkerTimer = setInterval(run, intervalMs);
  callbackWorkerTimer.unref?.();
}

export async function stopRelayCallbackDeliveryWorker(): Promise<void> {
  if (callbackWorkerTimer) clearInterval(callbackWorkerTimer);
  callbackWorkerTimer = null;
  while (callbackWorkerRunning) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
