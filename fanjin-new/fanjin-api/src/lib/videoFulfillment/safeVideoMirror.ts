import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import path from "node:path";
import { lookup } from "node:dns/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { sanitizeChildProcessEnvironment } from "@/lib/childProcessEnvironment";
import { normalizeObjectKey } from "@/lib/objectStorage";
import { publicMediaAssetUrl } from "@/lib/publicMediaAsset";
import {
  embeddedIpv4FromIpv6Address,
  isCandidateVolcanoFakeIpDnsAnswer,
} from "@/lib/candidateMediaDnsCompatibility";
import {
  cleanupContainedLocalFile,
  commitContainedLocalFile,
  ContainedLocalFileError,
  createContainedLocalWriteStream,
  ensureDurableContainedLocalRoot,
  prepareContainedLocalFile,
  type CommittedContainedLocalFile,
  type ContainedLocalFilePlan,
} from "@/lib/containedLocalFile";
import { isRecoveryOnlyMode } from "@/lib/recoveryOnlyMode";
import getPath from "@/utils/getPath";

export class SafeVideoMirrorError extends Error {
  readonly code:
    | "INVALID_URL"
    | "SSRF_BLOCKED"
    | "DNS_FAILED"
    | "REDIRECT_INVALID"
    | "DOWNLOAD_FAILED"
    | "INVALID_MIME"
    | "OUTPUT_TOO_LARGE"
    | "MIRROR_DISABLED"
    | "UNSAFE_STORAGE_PATH";

  constructor(code: SafeVideoMirrorError["code"], message: string) {
    super(message);
    this.name = "SafeVideoMirrorError";
    this.code = code;
  }
}

export interface SafeMirroredVideo {
  url: string;
  localPath: string | null;
  mirrored: boolean;
  mimeType: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  videoCodec: string | null;
  bitrateBps: number | null;
  audioTrackCount: number | null;
  audioCodecs: string[] | null;
  contentLengthBytes: number | null;
  contentSha256: string | null;
}

export interface PinnedTarget {
  address: string;
  family: 4 | 6;
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (
    parts.length !== 4
    || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return true;
  }
  const [a, b] = parts;
  return a === 0
    || a === 10
    || a === 127
    || a >= 224
    || a === 169 && b === 254
    || a === 172 && b >= 16 && b <= 31
    || a === 192 && b === 168
    || a === 100 && b >= 64 && b <= 127
    || a === 198 && (b === 18 || b === 19);
}

function isPrivateOrSpecialIp(rawAddress: string): boolean {
  const address = rawAddress.replace(/^\[|\]$/g, "").toLowerCase();
  const family = isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family !== 6) return true;
  if (embeddedIpv4FromIpv6Address(address)) return true;
  return address === "::"
    || address === "::1"
    || /^f[cd]/.test(address)
    || /^fe[89a-f]/.test(address)
    || address.startsWith("ff")
    || address.startsWith("100:")
    || address.startsWith("64:ff9b:")
    || address.startsWith("2001:0:")
    || address.startsWith("2001:2:")
    || address.startsWith("2001:db8:")
    || address.startsWith("2002:");
}

function forbiddenHostname(rawHostname: string): boolean {
  const hostname = rawHostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!hostname) return true;
  if (isIP(hostname)) return isPrivateOrSpecialIp(hostname);
  return hostname === "localhost"
    || hostname === "metadata"
    || hostname === "metadata.google.internal"
    || hostname === "instance-data"
    || hostname === "kubernetes.default"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname.endsWith(".internal")
    || hostname.endsWith(".home.arpa")
    || hostname.endsWith(".lan");
}

function allowPrivateForTests(): boolean {
  return process.env.NODE_ENV === "test"
    && process.env.FANJIN_TEST_ALLOW_PRIVATE_MEDIA_URLS === "1";
}

function parseExternalUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(String(rawUrl || "").trim());
  } catch {
    throw new SafeVideoMirrorError("INVALID_URL", "视频结果地址无效");
  }
  if (
    !["http:", "https:"].includes(url.protocol)
    || url.username
    || url.password
  ) {
    throw new SafeVideoMirrorError("INVALID_URL", "视频结果必须使用无凭据的 HTTP(S) 地址");
  }
  if (!allowPrivateForTests() && forbiddenHostname(url.hostname)) {
    throw new SafeVideoMirrorError("SSRF_BLOCKED", "视频结果地址不能指向本地或内网服务");
  }
  return url;
}

export function resolveSafeVideoMirrorRedirectUrl(
  current: URL,
  location: string,
): URL {
  const next = parseExternalUrl(new URL(location, current).toString());
  if (current.protocol === "https:" && next.protocol !== "https:") {
    throw new SafeVideoMirrorError(
      "REDIRECT_INVALID",
      "视频结果不允许从 HTTPS 重定向到明文 HTTP 地址",
    );
  }
  return next;
}

export function selectSafeVideoMirrorDnsTarget(
  url: URL,
  targets: readonly PinnedTarget[],
): PinnedTarget {
  const publicTargets: PinnedTarget[] = [];
  const candidateFakeIpTargets: PinnedTarget[] = [];
  for (const target of targets) {
    if (!isPrivateOrSpecialIp(target.address)) {
      publicTargets.push(target);
      continue;
    }
    if (isCandidateVolcanoFakeIpDnsAnswer(url, target)) {
      candidateFakeIpTargets.push(target);
      continue;
    }
    throw new SafeVideoMirrorError("SSRF_BLOCKED", "视频结果地址解析到了非公网地址");
  }
  const selected = publicTargets[0]
    ?? candidateFakeIpTargets.find((target) => target.family === 4)
    ?? candidateFakeIpTargets[0];
  if (!selected) {
    throw new SafeVideoMirrorError("SSRF_BLOCKED", "视频结果地址解析到了非公网地址");
  }
  return selected;
}

async function pinnedTarget(url: URL): Promise<PinnedTarget> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const literalFamily = isIP(hostname);
  if (literalFamily === 4 || literalFamily === 6) {
    return { address: hostname, family: literalFamily };
  }
  let timer: NodeJS.Timeout | null = null;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("dns_timeout")), 5000);
      timer.unref?.();
    });
    const answers = await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      timeout,
    ]);
    const targets = answers.filter(
      (answer): answer is PinnedTarget => answer.family === 4 || answer.family === 6,
    );
    if (allowPrivateForTests() && targets.length) return targets[0];
    return selectSafeVideoMirrorDnsTarget(url, targets);
  } catch (error) {
    if (error instanceof SafeVideoMirrorError) throw error;
    throw new SafeVideoMirrorError("DNS_FAILED", "视频结果公网地址无法解析");
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function downloadTimeoutMs(): number {
  const value = Number(process.env.FANJIN_RELAY_MEDIA_DOWNLOAD_TIMEOUT_MS || 600000);
  return Number.isSafeInteger(value) && value >= 1000 ? value : 600000;
}

function maximumBytes(): number {
  const value = Number(
    process.env.FANJIN_RELAY_MEDIA_MAX_BYTES
    || process.env.FANJIN_VIDEO_ENHANCE_MAX_OUTPUT_BYTES
    || 1024 * 1024 * 1024,
  );
  return Number.isSafeInteger(value) && value > 0 ? value : 1024 * 1024 * 1024;
}

export interface ProbedVideoFile {
  width: number;
  height: number;
  durationMs: number;
  videoCodec: string;
  bitrateBps: number;
  audioTrackCount: number;
  audioCodecs: string[];
  contentLengthBytes: number;
}

function ffprobeTimeoutMs(): number {
  const value = Number(process.env.FANJIN_FFPROBE_TIMEOUT_MS || 15_000);
  return Number.isSafeInteger(value) && value >= 1000 ? value : 15_000;
}

function ffmpegDecodeTimeoutMs(): number {
  const value = Number(
    process.env.FANJIN_FFMPEG_TIMEOUT_MS
    || process.env.FANJIN_FFPROBE_TIMEOUT_MS
    || 15_000,
  );
  return Number.isSafeInteger(value) && value >= 1000 ? value : 15_000;
}

function containsDecodedVideoFrameHash(output: string): boolean {
  const lines = output.split(/\r?\n/gu);
  if (
    !lines.some((line) => line.trim() === "#format: frame checksums")
    || !lines.some((line) => line.trim() === "#hash: SHA256")
  ) {
    return false;
  }
  return lines.some((line) => (
    /^\s*\d+\s*,\s*(?:-?\d+|N\/A)\s*,\s*(?:-?\d+|N\/A)\s*,\s*(?:-?\d+|N\/A)\s*,\s*[1-9]\d*\s*,\s*[0-9a-f]{64}\s*$/iu
  ).test(line));
}

async function requireDecodableVideoFrame(filePath: string): Promise<void> {
  const ffmpegPath = String(process.env.FANJIN_FFMPEG_PATH || "ffmpeg").trim() || "ffmpeg";
  await new Promise<void>((resolve, reject) => {
    execFile(
      ffmpegPath,
      [
        "-nostdin",
        "-v",
        "error",
        "-xerror",
        "-i",
        filePath,
        "-map",
        "0:v:0",
        "-an",
        "-sn",
        "-dn",
        "-frames:v",
        "1",
        "-hash",
        "sha256",
        "-f",
        "framehash",
        "-",
      ],
      {
        env: sanitizeChildProcessEnvironment(),
        timeout: ffmpegDecodeTimeoutMs(),
        maxBuffer: 64 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (
          error
          || stderr.length !== 0
          || !containsDecodedVideoFrameHash(stdout)
        ) {
          reject(new SafeVideoMirrorError(
            "DOWNLOAD_FAILED",
            "视频结果无法解码有效画面",
          ));
          return;
        }
        resolve();
      },
    );
  });
}

/**
 * MIME headers and file extensions are attacker-controlled. A final delivery
 * is eligible for billing only after ffprobe confirms finite stream metadata
 * and ffmpeg emits a clean decoded-frame hash.
 */
export async function probeVideoFile(filePath: string): Promise<ProbedVideoFile> {
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile() || stat.size <= 0 || stat.size > maximumBytes()) {
    throw new SafeVideoMirrorError("DOWNLOAD_FAILED", "视频结果文件为空或大小无效");
  }
  const ffprobePath = String(process.env.FANJIN_FFPROBE_PATH || "ffprobe").trim() || "ffprobe";
  const output = await new Promise<string>((resolve, reject) => {
    execFile(
      ffprobePath,
      [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type,codec_name,width,height,duration,bit_rate:format=duration,bit_rate,size",
        "-of",
        "json",
        filePath,
      ],
      {
        env: sanitizeChildProcessEnvironment(),
        timeout: ffprobeTimeoutMs(),
        maxBuffer: 64 * 1024,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          reject(new SafeVideoMirrorError("DOWNLOAD_FAILED", "视频结果未通过媒体探测"));
          return;
        }
        resolve(stdout);
      },
    );
  });
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(output) as Record<string, unknown>;
  } catch {
    throw new SafeVideoMirrorError("DOWNLOAD_FAILED", "视频结果媒体探测数据无效");
  }
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const stream = streams.find(
    (value) => value && typeof value === "object"
      && String((value as Record<string, unknown>).codec_type || "") === "video",
  ) as Record<string, unknown> | undefined;
  const audioStreams = streams.filter(
    (value) => value && typeof value === "object"
      && String((value as Record<string, unknown>).codec_type || "") === "audio",
  ) as Record<string, unknown>[];
  const format = parsed.format && typeof parsed.format === "object"
    ? parsed.format as Record<string, unknown>
    : {};
  const width = Number(stream?.width);
  const height = Number(stream?.height);
  const durationSeconds = Number(stream?.duration ?? format.duration);
  const durationMs = Math.round(durationSeconds * 1000);
  // ffprobe always reports codec_name for ordinary production media. Keep the
  // probe usable for legacy/test fixtures that omit it, but do not let such a
  // result become high-resolution delivery evidence (deliveryProof rejects
  // the explicit "unknown" sentinel).
  const videoCodec = String(stream?.codec_name || "unknown").trim().toLowerCase();
  const declaredBitrate = Number(stream?.bit_rate ?? format.bit_rate);
  const computedBitrate = Math.round((stat.size * 8) / durationSeconds);
  const bitrateBps = Number.isSafeInteger(declaredBitrate) && declaredBitrate > 0
    ? declaredBitrate
    : computedBitrate;
  const audioCodecs = Array.from(new Set(
    audioStreams
      .map((audio) => String(audio.codec_name || "").trim().toLowerCase())
      .filter(Boolean),
  ));
  if (
    !Number.isSafeInteger(width)
    || width <= 0
    || !Number.isSafeInteger(height)
    || height <= 0
    || !Number.isSafeInteger(durationMs)
    || durationMs <= 0
    || !Number.isSafeInteger(bitrateBps)
    || bitrateBps <= 0
  ) {
    throw new SafeVideoMirrorError("DOWNLOAD_FAILED", "视频结果缺少有效画面尺寸、时长或码率");
  }
  // Container metadata and a zero ffmpeg exit status are not delivery proof.
  // Some ffmpeg versions report corrupt trailing packets on stderr but still
  // exit zero after producing the first frame. Require a bounded real decode,
  // a verifiable SHA-256 framehash row, and no decoder diagnostics before the
  // bytes are eligible for persistence or billing.
  await requireDecodableVideoFrame(filePath);
  return {
    width,
    height,
    durationMs,
    videoCodec,
    bitrateBps,
    audioTrackCount: audioStreams.length,
    audioCodecs,
    contentLengthBytes: stat.size,
  };
}

export async function sha256VideoFile(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  await pipeline(fs.createReadStream(filePath), new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      callback();
    },
  }));
  return hash.digest("hex");
}

export function resolveOwnedVideoLocalPath(
  publicUrl: string,
  persistedLocalPath?: string | null,
): string | null {
  let pathname = publicUrl;
  if (!pathname.startsWith("/")) {
    try {
      pathname = new URL(pathname).pathname;
    } catch {
      return null;
    }
  }
  const marker = "/oss/";
  const markerIndex = pathname.indexOf(marker);
  if (markerIndex < 0) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname.slice(markerIndex + marker.length));
  } catch {
    return null;
  }
  const segments = decoded.split("/").filter(Boolean);
  if (
    !segments.length
    || segments.some((segment) =>
      segment === "."
      || segment === ".."
      || segment.includes("\\")
      || segment.includes("\0"))
  ) {
    return null;
  }
  const candidate = getPath(["oss", ...segments]);
  if (persistedLocalPath && path.resolve(persistedLocalPath) !== candidate) return null;
  if (!fs.existsSync(candidate)) return null;
  try {
    const root = fs.realpathSync(getPath(["oss"]));
    const canonical = fs.realpathSync(candidate);
    const relative = path.relative(root, canonical);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
    if (persistedLocalPath && fs.realpathSync(persistedLocalPath) !== canonical) return null;
    return canonical;
  } catch {
    return null;
  }
}

/**
 * Resolve a durable local-object key to the one canonical file it names.
 *
 * Historical durable video rows persisted the relative object key in
 * localPath. That value is accepted only when it exactly matches storageKey;
 * it never participates in filesystem resolution. New rows persist the
 * canonical absolute path. In both cases the public URL, object key and
 * canonical file below the owned OSS root must all identify the same file.
 */
export function resolveOwnedVideoStorageKeyLocalPath(
  publicUrl: string,
  storageKey: string,
  persistedLocalPath?: string | null,
): string | null {
  let normalizedKey: string;
  try {
    normalizedKey = normalizeObjectKey(storageKey);
  } catch {
    return null;
  }
  let pathname: string;
  try {
    const rawUrl = String(publicUrl || "").trim();
    if (!rawUrl || rawUrl.startsWith("//")) return null;
    pathname = new URL(rawUrl, "https://owned-media.invalid").pathname;
  } catch {
    return null;
  }
  const marker = "/oss/";
  const markerIndex = pathname.indexOf(marker);
  if (markerIndex < 0) return null;
  let decodedKey: string;
  try {
    decodedKey = decodeURIComponent(pathname.slice(markerIndex + marker.length));
  } catch {
    return null;
  }
  if (decodedKey !== normalizedKey) return null;
  const segments = normalizedKey.split("/");
  const candidate = getPath(["oss", ...segments]);
  const declaredPath = String(persistedLocalPath || "").trim();
  if (declaredPath && !path.isAbsolute(declaredPath)) {
    try {
      if (normalizeObjectKey(declaredPath) !== normalizedKey) return null;
    } catch {
      return null;
    }
  }
  if (!fs.existsSync(candidate)) return null;
  try {
    const root = fs.realpathSync(getPath(["oss"]));
    const canonical = fs.realpathSync(candidate);
    const relative = path.relative(root, canonical);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
    if (
      declaredPath
      && path.isAbsolute(declaredPath)
      && fs.realpathSync(declaredPath) !== canonical
    ) {
      return null;
    }
    return canonical;
  } catch {
    return null;
  }
}

async function requestPinned(
  url: URL,
  target: PinnedTarget,
  signal: AbortSignal,
): Promise<IncomingMessage> {
  const secure = url.protocol === "https:";
  const transport = secure ? https : http;
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  return await new Promise<IncomingMessage>((resolve, reject) => {
    const request = transport.request(
      {
        protocol: url.protocol,
        hostname: target.address,
        family: target.family,
        port: url.port || (secure ? 443 : 80),
        method: "GET",
        path: `${url.pathname || "/"}${url.search}`,
        servername: secure && !isIP(hostname) ? hostname : undefined,
        rejectUnauthorized: true,
        signal,
        headers: {
          Accept: "video/*",
          Host: url.host,
          "User-Agent": "Fanjin-Relay-Video-Mirror/1.0",
        },
      },
      resolve,
    );
    request.setTimeout(
      downloadTimeoutMs(),
      () => request.destroy(new Error("video mirror download timed out")),
    );
    request.once("error", reject);
    request.end();
  });
}

async function fetchValidatedVideo(
  rawUrl: string,
  signal: AbortSignal,
): Promise<{ response: IncomingMessage; mimeType: string }> {
  let current = parseExternalUrl(rawUrl);
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    const target = await pinnedTarget(current);
    const response = await requestPinned(current, target, signal);
    const status = Number(response.statusCode || 0);
    if ([301, 302, 303, 307, 308].includes(status)) {
      const header = response.headers.location;
      const location = Array.isArray(header) ? header[0] : header;
      response.destroy();
      if (!location || redirect === 3) {
        throw new SafeVideoMirrorError(
          "REDIRECT_INVALID",
          "视频结果包含无效或过多的重定向",
        );
      }
      current = resolveSafeVideoMirrorRedirectUrl(current, location);
      continue;
    }
    if (status < 200 || status >= 300) {
      response.destroy();
      throw new SafeVideoMirrorError("DOWNLOAD_FAILED", "视频结果文件暂时无法读取");
    }
    const mimeType = String(response.headers["content-type"] || "")
      .split(";", 1)[0]
      .trim()
      .toLowerCase();
    if (!mimeType.startsWith("video/")) {
      response.destroy();
      throw new SafeVideoMirrorError("INVALID_MIME", "视频结果响应不是视频文件");
    }
    const contentLengthHeader = response.headers["content-length"];
    if (contentLengthHeader) {
      const length = Number(
        Array.isArray(contentLengthHeader) ? contentLengthHeader[0] : contentLengthHeader,
      );
      if (!Number.isSafeInteger(length) || length < 0 || length > maximumBytes()) {
        response.destroy();
        throw new SafeVideoMirrorError("OUTPUT_TOO_LARGE", "视频结果文件超过允许大小");
      }
    }
    return { response, mimeType };
  }
  throw new SafeVideoMirrorError("REDIRECT_INVALID", "视频结果地址无效");
}

function extensionForMimeType(mimeType: string): string {
  if (mimeType === "video/webm") return "webm";
  if (mimeType === "video/quicktime") return "mov";
  if (mimeType === "video/x-matroska") return "mkv";
  if (mimeType === "video/mpeg") return "mpeg";
  return "mp4";
}

function mimeTypeForOwnedPath(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".webm":
      return "video/webm";
    case ".mov":
      return "video/quicktime";
    case ".mkv":
      return "video/x-matroska";
    case ".mpeg":
    case ".mpg":
      return "video/mpeg";
    default:
      return "video/mp4";
  }
}

function publicUrl(relativeUrl: string): string {
  const base = process.env.FANJIN_PUBLIC_BASE_URL || process.env.PUBLIC_BASE_URL || "";
  return base
    ? `${base.replace(/\/+$/, "")}${relativeUrl.startsWith("/") ? relativeUrl : `/${relativeUrl}`}`
    : relativeUrl;
}

export async function mirrorVideoToOwnedStorage(
  taskId: string,
  rawUrl: string,
): Promise<SafeMirroredVideo> {
  const alreadyOwned = publicMediaAssetUrl(rawUrl);
  if (alreadyOwned) {
    const localPath = resolveOwnedVideoLocalPath(alreadyOwned);
    let probe: ProbedVideoFile | null = null;
    let contentSha256: string | null = null;
    if (localPath) {
      try {
        [probe, contentSha256] = await Promise.all([
          probeVideoFile(localPath),
          sha256VideoFile(localPath),
        ]);
      } catch {
        probe = null;
        contentSha256 = null;
      }
    }
    return {
      url: alreadyOwned,
      localPath,
      mirrored: false,
      mimeType: mimeTypeForOwnedPath(localPath || alreadyOwned),
      width: probe?.width ?? null,
      height: probe?.height ?? null,
      durationMs: probe?.durationMs ?? null,
      videoCodec: probe?.videoCodec ?? null,
      bitrateBps: probe?.bitrateBps ?? null,
      audioTrackCount: probe?.audioTrackCount ?? null,
      audioCodecs: probe ? [...probe.audioCodecs] : null,
      contentLengthBytes: probe?.contentLengthBytes ?? null,
      contentSha256,
    };
  }
  if (process.env.FANJIN_MIRROR_RELAY_MEDIA === "0") {
    throw new SafeVideoMirrorError(
      "MIRROR_DISABLED",
      "外部视频必须转存到 Fanjin 托管存储后才能交付",
    );
  }

  let filePlan: ContainedLocalFilePlan | null = null;
  let committedFile: CommittedContainedLocalFile | null = null;
  let activeResponse: IncomingMessage | null = null;
  const downloadController = new AbortController();
  const downloadDeadline = setTimeout(
    () => downloadController.abort(),
    downloadTimeoutMs(),
  );
  downloadDeadline.unref?.();
  try {
    const { response, mimeType } = await fetchValidatedVideo(
      rawUrl,
      downloadController.signal,
    );
    activeResponse = response;
    const taskDigest = crypto.createHash("sha256").update(taskId).digest("hex").slice(0, 24);
    const nonce = crypto.randomUUID();
    const extension = extensionForMimeType(mimeType);
    const relativePath = path.join("relay", taskDigest, `${nonce}.${extension}`);
    const ossRoot = getPath("oss");
    if (!isRecoveryOnlyMode()) {
      ensureDurableContainedLocalRoot(ossRoot);
    }
    filePlan = prepareContainedLocalFile({
      rootDirectory: ossRoot,
      relativePath,
      temporarySuffix: ".part",
    });
    let downloaded = 0;
    const limit = maximumBytes();
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        downloaded += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
        if (downloaded > limit) {
          callback(new SafeVideoMirrorError("OUTPUT_TOO_LARGE", "视频结果文件超过允许大小"));
          return;
        }
        callback(null, chunk);
      },
    });
    await pipeline(activeResponse, limiter, createContainedLocalWriteStream(filePlan));
    activeResponse = null;
    committedFile = commitContainedLocalFile(filePlan);
    const [probe, contentSha256] = await Promise.all([
      probeVideoFile(filePlan.finalPath),
      sha256VideoFile(filePlan.finalPath),
    ]);
    return {
      url: publicUrl(`/oss/${relativePath.replace(/\\/g, "/")}`),
      localPath: filePlan.finalPath,
      mirrored: true,
      mimeType,
      width: probe.width,
      height: probe.height,
      durationMs: probe.durationMs,
      videoCodec: probe.videoCodec,
      bitrateBps: probe.bitrateBps,
      audioTrackCount: probe.audioTrackCount,
      audioCodecs: [...probe.audioCodecs],
      contentLengthBytes: probe.contentLengthBytes,
      contentSha256,
    };
  } catch (error) {
    if (filePlan) cleanupContainedLocalFile(filePlan, committedFile);
    if (error instanceof ContainedLocalFileError) {
      throw new SafeVideoMirrorError(
        "UNSAFE_STORAGE_PATH",
        "视频结果托管存储路径不安全",
      );
    }
    if (error instanceof SafeVideoMirrorError) throw error;
    throw new SafeVideoMirrorError("DOWNLOAD_FAILED", "视频结果下载失败");
  } finally {
    activeResponse?.destroy();
    clearTimeout(downloadDeadline);
  }
}

export function removeMirroredVideo(result: SafeMirroredVideo): void {
  if (result.mirrored && result.localPath) {
    fs.rmSync(result.localPath, { force: true });
  }
}
