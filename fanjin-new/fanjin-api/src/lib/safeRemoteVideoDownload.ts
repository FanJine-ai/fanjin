import dns from "node:dns/promises";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import path from "node:path";
import {
  embeddedIpv4FromIpv6Address,
  isCandidateVolcanoFakeIpDnsAnswer,
} from "@/lib/candidateMediaDnsCompatibility";

export interface RemoteVideoDnsAddress {
  address: string;
  family: 4 | 6;
}

export interface RemoteVideoResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Uint8Array | Buffer | string>;
  cancel(): void;
}

export interface RemoteVideoRequest {
  url: URL;
  target: RemoteVideoDnsAddress;
  signal: AbortSignal;
  mediaKind?: "video" | "image";
}

export interface SafeRemoteVideoDownloadTestHooks {
  lookup?: (hostname: string) => Promise<RemoteVideoDnsAddress[]>;
  request?: (input: RemoteVideoRequest) => Promise<RemoteVideoResponse>;
}

export interface SafeRemoteVideoDownloadInput {
  url: string;
  maximumBytes: number;
  timeoutMs: number;
  maximumRedirects?: number;
  testHooks?: SafeRemoteVideoDownloadTestHooks;
  /**
   * The downloader keeps one DNS-pinning and SSRF policy for provider media.
   * Existing callers remain video-only by default; generated-image
   * persistence opts into the same transport with the narrower image MIME
   * allow-list.
   */
  mediaKind?: "video" | "image";
}

export type SafeRemoteImageDownloadInput = Omit<
  SafeRemoteVideoDownloadInput,
  "mediaKind"
>;

export interface SafeRemoteVideoDownloadResult {
  body: Buffer;
  finalUrl: string;
  mimeType: string;
  redirects: number;
}

export interface SafeRemoteVideoFileDownloadInput
  extends Omit<SafeRemoteVideoDownloadInput, "mediaKind"> {
  /** Absolute, non-existing destination path below a caller-owned temp dir. */
  destinationPath: string;
}

export interface SafeRemoteVideoFileDownloadResult {
  filePath: string;
  sizeBytes: number;
  finalUrl: string;
  mimeType: string;
  redirects: number;
}

export class SafeRemoteVideoDownloadError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "SafeRemoteVideoDownloadError";
    this.code = code;
  }
}

const MAXIMUM_URL_LENGTH = 8_192;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const NON_PUBLIC_ADDRESSES = new BlockList();

for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  NON_PUBLIC_ADDRESSES.addSubnet(network, prefix, "ipv4");
}

for (const [network, prefix] of [
  ["::", 96],
  ["64:ff9b::", 96],
  // RFC 8215 local-use NAT64 prefix. Its embedded IPv4 destination can be a
  // loopback, link-local, metadata, or RFC1918 address after translation.
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 32],
  ["2001:2::", 48],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  NON_PUBLIC_ADDRESSES.addSubnet(network, prefix, "ipv6");
}

function isPublicRemoteAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    return !NON_PUBLIC_ADDRESSES.check(address, "ipv4");
  }
  if (family === 6) {
    if (embeddedIpv4FromIpv6Address(address)) return false;
    return !NON_PUBLIC_ADDRESSES.check(address, "ipv6");
  }
  return false;
}

const ALLOWED_VIDEO_MIME_TYPES = new Set([
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/x-matroska",
  "video/mpeg",
]);
const ALLOWED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

function downloadError(code: string): never {
  throw new SafeRemoteVideoDownloadError(code);
}

function normalizedHostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/gu, "").replace(/\.$/u, "").toLowerCase();
}

function parseRemoteVideoUrl(rawUrl: string): URL {
  const value = String(rawUrl || "").trim();
  if (!value || value.length > MAXIMUM_URL_LENGTH) {
    return downloadError("REMOTE_VIDEO_URL_INVALID");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return downloadError("REMOTE_VIDEO_URL_INVALID");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    return downloadError("REMOTE_VIDEO_PROTOCOL_FORBIDDEN");
  }
  if (url.username || url.password) {
    return downloadError("REMOTE_VIDEO_CREDENTIALS_FORBIDDEN");
  }
  if (url.hash) {
    return downloadError("REMOTE_VIDEO_FRAGMENT_FORBIDDEN");
  }
  const hostname = normalizedHostname(url);
  if (
    !hostname
    || hostname === "localhost"
    || hostname === "metadata"
    || hostname === "metadata.google.internal"
    || hostname === "instance-data"
    || hostname === "kubernetes.default"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname.endsWith(".internal")
    || hostname.endsWith(".home.arpa")
    || hostname.endsWith(".lan")
  ) {
    return downloadError("REMOTE_VIDEO_HOST_FORBIDDEN");
  }
  if (isIP(hostname) && !isPublicRemoteAddress(hostname)) {
    return downloadError("REMOTE_VIDEO_ADDRESS_FORBIDDEN");
  }
  return url;
}

function assertTestHooksAllowed(
  hooks: SafeRemoteVideoDownloadTestHooks | undefined,
): void {
  if (
    hooks
    && (hooks.lookup || hooks.request)
    && process.env.NODE_ENV !== "test"
  ) {
    downloadError("REMOTE_VIDEO_TEST_HOOKS_FORBIDDEN");
  }
}

async function defaultLookup(hostname: string): Promise<RemoteVideoDnsAddress[]> {
  const answers = await dns.lookup(hostname, { all: true, verbatim: true });
  return answers.filter(
    (answer): answer is RemoteVideoDnsAddress =>
      answer.family === 4 || answer.family === 6,
  );
}

function abortError(): SafeRemoteVideoDownloadError {
  return new SafeRemoteVideoDownloadError("REMOTE_VIDEO_DOWNLOAD_TIMEOUT");
}

async function raceWithAbort<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw abortError();
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(abortError()));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

async function resolvePinnedTarget(
  url: URL,
  lookup: (hostname: string) => Promise<RemoteVideoDnsAddress[]>,
  signal: AbortSignal,
): Promise<RemoteVideoDnsAddress> {
  const hostname = normalizedHostname(url);
  const literalFamily = isIP(hostname);
  if (literalFamily === 4 || literalFamily === 6) {
    if (!isPublicRemoteAddress(hostname)) {
      downloadError("REMOTE_VIDEO_ADDRESS_FORBIDDEN");
    }
    return { address: hostname, family: literalFamily };
  }

  let answers: RemoteVideoDnsAddress[];
  try {
    answers = await raceWithAbort(lookup(hostname), signal);
  } catch (error) {
    if (error instanceof SafeRemoteVideoDownloadError) throw error;
    return downloadError("REMOTE_VIDEO_DNS_FAILED");
  }
  if (!answers.length) return downloadError("REMOTE_VIDEO_DNS_EMPTY");
  const publicAnswers: RemoteVideoDnsAddress[] = [];
  const candidateFakeIpAnswers: RemoteVideoDnsAddress[] = [];
  for (const answer of answers) {
    if (
      ![4, 6].includes(answer.family)
      || isIP(answer.address) !== answer.family
    ) {
      return downloadError("REMOTE_VIDEO_DNS_UNSAFE");
    }
    if (isPublicRemoteAddress(answer.address)) {
      publicAnswers.push(answer);
      continue;
    }
    if (isCandidateVolcanoFakeIpDnsAnswer(url, answer)) {
      candidateFakeIpAnswers.push(answer);
      continue;
    }
    return downloadError("REMOTE_VIDEO_DNS_UNSAFE");
  }
  return publicAnswers[0]
    ?? candidateFakeIpAnswers.find((answer) => answer.family === 4)
    ?? candidateFakeIpAnswers[0]
    ?? downloadError("REMOTE_VIDEO_DNS_UNSAFE");
}

async function defaultPinnedRequest(
  input: RemoteVideoRequest,
): Promise<RemoteVideoResponse> {
  const secure = input.url.protocol === "https:";
  const transport = secure ? https : http;
  const originalHostname = normalizedHostname(input.url);
  return await new Promise<RemoteVideoResponse>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      callback();
    };
    const request = transport.request(
      {
        protocol: input.url.protocol,
        hostname: input.target.address,
        family: input.target.family,
        port: input.url.port || (secure ? 443 : 80),
        method: "GET",
        path: `${input.url.pathname || "/"}${input.url.search}`,
        servername: secure && !isIP(originalHostname)
          ? originalHostname
          : undefined,
        rejectUnauthorized: true,
        signal: input.signal,
        headers: {
          Accept: input.mediaKind === "image" ? "image/*" : "video/*",
          Host: input.url.host,
          "User-Agent": "Fanjin-Relay-Media/1.0",
        },
      },
      (response) => finish(() => resolve({
        statusCode: Number(response.statusCode || 0),
        headers: response.headers,
        body: response,
        cancel: () => response.destroy(),
      })),
    );
    request.once("error", (error) => finish(() => reject(error)));
    request.end();
  });
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const expected = name.toLowerCase();
  const entry = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === expected,
  )?.[1];
  if (Array.isArray(entry)) return entry[0] == null ? null : String(entry[0]);
  return entry == null ? null : String(entry);
}

async function readBoundedVideoBody(
  response: RemoteVideoResponse,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  const iterator = response.body[Symbol.asyncIterator]();
  try {
    while (true) {
      const next = await raceWithAbort(iterator.next(), signal);
      if (next.done) break;
      const chunk = Buffer.isBuffer(next.value)
        ? next.value
        : Buffer.from(next.value);
      totalBytes += chunk.length;
      if (totalBytes > maximumBytes) {
        response.cancel();
        return downloadError("REMOTE_VIDEO_TOO_LARGE");
      }
      chunks.push(chunk);
    }
  } catch (error) {
    response.cancel();
    throw error;
  }
  if (totalBytes === 0) return downloadError("REMOTE_VIDEO_BODY_EMPTY");
  return Buffer.concat(chunks, totalBytes);
}

async function writeBoundedVideoBodyToFile(
  response: RemoteVideoResponse,
  maximumBytes: number,
  signal: AbortSignal,
  destinationPath: string,
): Promise<number> {
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  let created = false;
  let completed = false;
  let totalBytes = 0;
  const iterator = response.body[Symbol.asyncIterator]();
  try {
    // `wx` prevents an unexpected existing path from being overwritten. The
    // caller owns and later removes the containing temporary directory.
    handle = await fs.open(destinationPath, "wx", 0o600);
    created = true;
    while (true) {
      const next = await raceWithAbort(iterator.next(), signal);
      if (next.done) break;
      const chunk = Buffer.isBuffer(next.value)
        ? next.value
        : Buffer.from(next.value);
      totalBytes += chunk.length;
      if (totalBytes > maximumBytes) {
        response.cancel();
        return downloadError("REMOTE_VIDEO_TOO_LARGE");
      }
      let offset = 0;
      while (offset < chunk.length) {
        const writeResult = await raceWithAbort(
          handle.write(chunk, offset, chunk.length - offset).then((value) => value.bytesWritten),
          signal,
        );
        if (writeResult <= 0) {
          return downloadError("REMOTE_VIDEO_FILE_WRITE_FAILED");
        }
        offset += writeResult;
      }
    }
    if (totalBytes === 0) return downloadError("REMOTE_VIDEO_BODY_EMPTY");
    await handle.sync();
    completed = true;
    return totalBytes;
  } catch (error) {
    response.cancel();
    if (error instanceof SafeRemoteVideoDownloadError) throw error;
    return downloadError("REMOTE_VIDEO_FILE_WRITE_FAILED");
  } finally {
    await handle?.close().catch(() => undefined);
    if (created && !completed) {
      await fs.rm(destinationPath, { force: true }).catch(() => undefined);
    }
  }
}

interface SafeRemoteDownloadEnvelope<TBody> {
  body: TBody;
  finalUrl: string;
  mimeType: string;
  redirects: number;
}

type SafeRemoteBodyReader<TBody> = (
  response: RemoteVideoResponse,
  maximumBytes: number,
  signal: AbortSignal,
) => Promise<TBody>;

async function downloadWithSignal<TBody>(
  input: SafeRemoteVideoDownloadInput,
  signal: AbortSignal,
  readBody: SafeRemoteBodyReader<TBody>,
): Promise<SafeRemoteDownloadEnvelope<TBody>> {
  const lookup = input.testHooks?.lookup || defaultLookup;
  const request = input.testHooks?.request || defaultPinnedRequest;
  const maximumRedirects = input.maximumRedirects ?? 3;
  let url = parseRemoteVideoUrl(input.url);
  const seen = new Set<string>();

  for (let redirects = 0; redirects <= maximumRedirects; redirects += 1) {
    const canonicalUrl = url.toString();
    if (seen.has(canonicalUrl)) {
      return downloadError("REMOTE_VIDEO_REDIRECT_LOOP");
    }
    seen.add(canonicalUrl);
    const target = await resolvePinnedTarget(url, lookup, signal);
    let response: RemoteVideoResponse;
    try {
      response = await raceWithAbort(
        request({
          url,
          target,
          signal,
          mediaKind: input.mediaKind === "image" ? "image" : "video",
        }),
        signal,
      );
    } catch (error) {
      if (error instanceof SafeRemoteVideoDownloadError) throw error;
      return downloadError("REMOTE_VIDEO_REQUEST_FAILED");
    }

    if (REDIRECT_STATUSES.has(response.statusCode)) {
      const location = headerValue(response.headers, "location");
      response.cancel();
      if (!location) return downloadError("REMOTE_VIDEO_REDIRECT_INVALID");
      if (redirects >= maximumRedirects) {
        return downloadError("REMOTE_VIDEO_REDIRECT_LIMIT");
      }
      let nextUrl: URL;
      try {
        nextUrl = parseRemoteVideoUrl(
          new URL(location, url).toString(),
        );
      } catch (error) {
        if (error instanceof SafeRemoteVideoDownloadError) throw error;
        return downloadError("REMOTE_VIDEO_REDIRECT_INVALID");
      }
      if (url.protocol === "https:" && nextUrl.protocol !== "https:") {
        return downloadError("REMOTE_VIDEO_REDIRECT_DOWNGRADE");
      }
      url = nextUrl;
      continue;
    }

    if (response.statusCode < 200 || response.statusCode >= 300) {
      response.cancel();
      return downloadError("REMOTE_VIDEO_HTTP_STATUS");
    }
    const mimeType = String(
      headerValue(response.headers, "content-type") || "",
    ).split(";", 1)[0].trim().toLowerCase();
    const allowedMimeTypes = input.mediaKind === "image"
      ? ALLOWED_IMAGE_MIME_TYPES
      : ALLOWED_VIDEO_MIME_TYPES;
    if (!allowedMimeTypes.has(mimeType)) {
      response.cancel();
      return downloadError("REMOTE_VIDEO_MIME_INVALID");
    }
    const contentLengthHeader = headerValue(
      response.headers,
      "content-length",
    );
    if (contentLengthHeader !== null) {
      const contentLength = Number(contentLengthHeader);
      if (
        !Number.isSafeInteger(contentLength)
        || contentLength < 0
      ) {
        response.cancel();
        return downloadError("REMOTE_VIDEO_CONTENT_LENGTH_INVALID");
      }
      if (contentLength > input.maximumBytes) {
        response.cancel();
        return downloadError("REMOTE_VIDEO_TOO_LARGE");
      }
    }
    const body = await readBody(
      response,
      input.maximumBytes,
      signal,
    );
    return {
      body,
      finalUrl: canonicalUrl,
      mimeType,
      redirects,
    };
  }
  return downloadError("REMOTE_VIDEO_REDIRECT_LIMIT");
}

export async function validatePublicRemoteVideoUrl(input: {
  url: string;
  timeoutMs: number;
  testHooks?: SafeRemoteVideoDownloadTestHooks;
}): Promise<string> {
  assertTestHooksAllowed(input.testHooks);
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0) {
    return downloadError("REMOTE_VIDEO_DOWNLOAD_CONFIGURATION_INVALID");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const url = parseRemoteVideoUrl(input.url);
    await resolvePinnedTarget(
      url,
      input.testHooks?.lookup || defaultLookup,
      controller.signal,
    );
    return url.toString();
  } finally {
    clearTimeout(timer);
  }
}

export async function downloadPublicRemoteVideo(
  input: SafeRemoteVideoDownloadInput,
): Promise<SafeRemoteVideoDownloadResult> {
  assertTestHooksAllowed(input.testHooks);
  if (
    !Number.isSafeInteger(input.maximumBytes)
    || input.maximumBytes <= 0
    || !Number.isSafeInteger(input.timeoutMs)
    || input.timeoutMs <= 0
    || !Number.isSafeInteger(input.maximumRedirects ?? 3)
    || (input.maximumRedirects ?? 3) < 0
    || (input.maximumRedirects ?? 3) > 3
  ) {
    return downloadError("REMOTE_VIDEO_DOWNLOAD_CONFIGURATION_INVALID");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    return await downloadWithSignal(
      input,
      controller.signal,
      readBoundedVideoBody,
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * DNS-pinned, redirect-bounded remote video download that writes each body
 * chunk directly to a caller-owned temporary file. It deliberately shares
 * the exact URL, DNS, redirect, TLS/SNI, MIME and length checks used by the
 * in-memory relay downloader.
 */
export async function downloadPublicRemoteVideoToFile(
  input: SafeRemoteVideoFileDownloadInput,
): Promise<SafeRemoteVideoFileDownloadResult> {
  assertTestHooksAllowed(input.testHooks);
  if (!path.isAbsolute(input.destinationPath)) {
    return downloadError("REMOTE_VIDEO_DOWNLOAD_CONFIGURATION_INVALID");
  }
  if (
    !Number.isSafeInteger(input.maximumBytes)
    || input.maximumBytes <= 0
    || !Number.isSafeInteger(input.timeoutMs)
    || input.timeoutMs <= 0
    || !Number.isSafeInteger(input.maximumRedirects ?? 3)
    || (input.maximumRedirects ?? 3) < 0
    || (input.maximumRedirects ?? 3) > 3
  ) {
    return downloadError("REMOTE_VIDEO_DOWNLOAD_CONFIGURATION_INVALID");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const result = await downloadWithSignal(
      { ...input, mediaKind: "video" },
      controller.signal,
      (response, maximumBytes, signal) => writeBoundedVideoBodyToFile(
        response,
        maximumBytes,
        signal,
        input.destinationPath,
      ),
    );
    return {
      filePath: input.destinationPath,
      sizeBytes: result.body,
      finalUrl: result.finalUrl,
      mimeType: result.mimeType,
      redirects: result.redirects,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Downloads a provider image through the same DNS-pinned, redirect-bounded
 * and candidate Fake-IP-compatible transport used for video. The generated
 * image persistence layer still verifies the file signature before storage.
 */
export async function downloadPublicRemoteImage(
  input: SafeRemoteImageDownloadInput,
): Promise<SafeRemoteVideoDownloadResult> {
  return downloadPublicRemoteVideo({
    ...input,
    mediaKind: "image",
  });
}
