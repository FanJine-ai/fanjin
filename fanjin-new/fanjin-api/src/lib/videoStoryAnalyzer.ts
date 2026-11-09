import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { sanitizeChildProcessEnvironment } from "@/lib/childProcessEnvironment";

const execFileAsync = promisify(execFile);

const MAX_SOURCE_BYTES = 256 * 1024 * 1024;
const MAX_DURATION_SECONDS = 2 * 60 * 60;
const MAX_DIMENSION = 16_384;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MEDIA_TIMEOUT_MS = 10 * 60_000;
const READINESS_CACHE_MS = 30_000;

type Environment = Record<string, string | undefined>;

export type VideoStoryAnalyzerReadiness = Readonly<{
  available: boolean;
  reason: string | null;
}>;

export type VideoStoryTechnicalShot = Readonly<{
  startTime: number;
  endTime: number;
  duration: number;
  frameTime: number;
  sceneConfidence: number | null;
  frame: Buffer;
}>;

export type VideoStoryTechnicalAnalysis = Readonly<{
  duration: number;
  width: number;
  height: number;
  sourceSha256: string;
  sceneThreshold: number;
  shots: readonly VideoStoryTechnicalShot[];
}>;

export type VideoStoryAnalyzerDependencies = Readonly<{
  ffmpegPath?: string;
  ffprobePath?: string;
}>;

let readinessCache: { expiresAt: number; value: VideoStoryAnalyzerReadiness } | null = null;

function executablePath(
  environment: Environment,
  variable: "FANJIN_FFMPEG_PATH" | "FANJIN_FFPROBE_PATH",
  fallback: "ffmpeg" | "ffprobe",
): string | null {
  const configured = String(environment[variable] || "").trim();
  const name = configured || fallback;
  if (/[/\\]/u.test(name) && !path.isAbsolute(name)) return null;
  const candidates = path.isAbsolute(name)
    ? [name]
    : String(environment.PATH || process.env.PATH || "")
        .split(path.delimiter)
        .filter(Boolean)
        .map((directory) => path.join(directory, name));
  for (const candidate of candidates) {
    try {
      const canonical = fs.realpathSync(candidate);
      const stat = fs.statSync(canonical);
      fs.accessSync(canonical, fs.constants.X_OK);
      if (stat.isFile()) return canonical;
    } catch {
      // Readiness never exposes candidate paths.
    }
  }
  return null;
}

function mediaToolWorks(executable: string | null, expected: "ffmpeg" | "ffprobe", environment: Environment) {
  if (!executable) return false;
  const result = spawnSync(executable, ["-version"], {
    encoding: "utf8",
    env: sanitizeChildProcessEnvironment(environment),
    maxBuffer: 8 * 1024,
    timeout: 2_000,
    windowsHide: true,
  });
  return result.status === 0
    && !result.signal
    && result.stdout.startsWith(`${expected} version `);
}

export function inspectVideoStoryAnalyzerConfiguration(
  environment: Environment = process.env,
): VideoStoryAnalyzerReadiness {
  const now = Date.now();
  if (environment === process.env && readinessCache && readinessCache.expiresAt > now) {
    return readinessCache.value;
  }
  const ffmpeg = executablePath(environment, "FANJIN_FFMPEG_PATH", "ffmpeg");
  const ffprobe = executablePath(environment, "FANJIN_FFPROBE_PATH", "ffprobe");
  const available = mediaToolWorks(ffmpeg, "ffmpeg", environment)
    && mediaToolWorks(ffprobe, "ffprobe", environment);
  const value = Object.freeze({
    available,
    reason: available ? null : "video_story_media_tool_unavailable",
  });
  if (environment === process.env) {
    readinessCache = { expiresAt: now + READINESS_CACHE_MS, value };
  }
  return value;
}

function resolvedTool(
  explicit: string | undefined,
  variable: "FANJIN_FFMPEG_PATH" | "FANJIN_FFPROBE_PATH",
  fallback: "ffmpeg" | "ffprobe",
) {
  if (explicit) return explicit;
  const resolved = executablePath(process.env, variable, fallback);
  if (!resolved) throw new Error("video_story_media_tool_unavailable");
  return resolved;
}

function roundedSeconds(value: number) {
  return Math.round(value * 1_000) / 1_000;
}

function selectBoundaries(values: readonly number[], duration: number, maximumShots: number): number[] {
  const unique = Array.from(new Set([
    0,
    ...values
      .filter((value) => Number.isFinite(value) && value > 0.08 && value < duration - 0.08)
      .map(roundedSeconds),
  ])).sort((a, b) => a - b);
  if (unique.length <= maximumShots) return unique;
  const sampled: number[] = [];
  for (let index = 0; index < maximumShots; index += 1) {
    const sourceIndex = Math.round(index * (unique.length - 1) / Math.max(1, maximumShots - 1));
    sampled.push(unique[sourceIndex]);
  }
  return Array.from(new Set(sampled)).sort((a, b) => a - b);
}

async function probeVideo(inputPath: string, ffprobePath: string, signal: AbortSignal) {
  const { stdout } = await execFileAsync(ffprobePath, [
    "-v", "error",
    "-max_alloc", String(64 * 1024 * 1024),
    "-protocol_whitelist", "file",
    "-probesize", String(16 * 1024 * 1024),
    "-analyzeduration", "8000000",
    "-max_probe_packets", "8192",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height,duration:format=duration",
    "-of", "json",
    inputPath,
  ], {
    encoding: "utf8",
    env: sanitizeChildProcessEnvironment(),
    maxBuffer: 64 * 1024,
    signal,
    timeout: 30_000,
    windowsHide: true,
  });
  let parsed: any;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("video_story_probe_invalid");
  }
  const stream = Array.isArray(parsed?.streams) ? parsed.streams[0] : null;
  const duration = Number(stream?.duration ?? parsed?.format?.duration);
  const width = Number(stream?.width);
  const height = Number(stream?.height);
  if (
    !Number.isFinite(duration)
    || duration <= 0
    || duration > MAX_DURATION_SECONDS
    || !Number.isSafeInteger(width)
    || !Number.isSafeInteger(height)
    || width <= 0
    || height <= 0
    || width > MAX_DIMENSION
    || height > MAX_DIMENSION
  ) {
    throw new Error("video_story_video_unsupported");
  }
  return { duration: roundedSeconds(duration), width, height };
}

async function detectSceneBoundaries(
  inputPath: string,
  ffmpegPath: string,
  threshold: number,
  signal: AbortSignal,
) {
  try {
    const { stderr } = await execFileAsync(ffmpegPath, [
      "-hide_banner",
      "-nostdin",
      "-v", "info",
      "-protocol_whitelist", "file",
      "-i", inputPath,
      "-an",
      "-vf", `select='gt(scene,${threshold})',showinfo`,
      "-vsync", "vfr",
      "-f", "null",
      "-",
    ], {
      encoding: "utf8",
      env: sanitizeChildProcessEnvironment(),
      maxBuffer: 4 * 1024 * 1024,
      signal,
      timeout: MEDIA_TIMEOUT_MS,
      windowsHide: true,
    });
    return Array.from(stderr.matchAll(/pts_time:([0-9]+(?:\.[0-9]+)?)/gu))
      .map((match) => Number(match[1]))
      .filter(Number.isFinite);
  } catch (error: any) {
    if (signal.aborted || error?.name === "AbortError") throw error;
    throw new Error("video_story_scene_detection_failed");
  }
}

async function extractFrame(
  inputPath: string,
  outputPath: string,
  timestamp: number,
  ffmpegPath: string,
  signal: AbortSignal,
) {
  try {
    await execFileAsync(ffmpegPath, [
      "-hide_banner",
      "-nostdin",
      "-v", "error",
      "-protocol_whitelist", "file",
      "-ss", timestamp.toFixed(3),
      "-i", inputPath,
      "-frames:v", "1",
      "-vf", "scale='min(1280,iw)':-2",
      "-q:v", "3",
      "-y",
      outputPath,
    ], {
      encoding: "utf8",
      env: sanitizeChildProcessEnvironment(),
      maxBuffer: 64 * 1024,
      signal,
      timeout: 60_000,
      windowsHide: true,
    });
  } catch (error: any) {
    if (signal.aborted || error?.name === "AbortError") throw error;
    throw new Error("video_story_frame_extract_failed");
  }
  const frame = await fs.promises.readFile(outputPath);
  if (
    frame.byteLength < 4
    || frame.byteLength > MAX_FRAME_BYTES
    || frame[0] !== 0xff
    || frame[1] !== 0xd8
    || frame.at(-2) !== 0xff
    || frame.at(-1) !== 0xd9
  ) {
    throw new Error("video_story_frame_invalid");
  }
  return frame;
}

export async function analyzeVideoStoryBuffer(input: {
  body: Buffer;
  extension: string;
  maximumShots: number;
  sceneThreshold?: number;
  signal: AbortSignal;
}, dependencies: VideoStoryAnalyzerDependencies = {}): Promise<VideoStoryTechnicalAnalysis> {
  if (!Buffer.isBuffer(input.body) || input.body.byteLength < 16 || input.body.byteLength > MAX_SOURCE_BYTES) {
    throw new Error("video_story_source_size_invalid");
  }
  if (!Number.isSafeInteger(input.maximumShots) || input.maximumShots < 1 || input.maximumShots > 40) {
    throw new Error("video_story_maximum_shots_invalid");
  }
  input.signal.throwIfAborted();
  const ffmpegPath = resolvedTool(dependencies.ffmpegPath, "FANJIN_FFMPEG_PATH", "ffmpeg");
  const ffprobePath = resolvedTool(dependencies.ffprobePath, "FANJIN_FFPROBE_PATH", "ffprobe");
  const threshold = Math.max(0.05, Math.min(0.95, Number(input.sceneThreshold ?? 0.28)));
  const temporaryDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "fanjin-video-story-"));
  const safeExtension = /^[a-z0-9]{1,8}$/u.test(input.extension) ? input.extension : "mp4";
  const inputPath = path.join(temporaryDirectory, `source.${safeExtension}`);
  try {
    await fs.promises.writeFile(inputPath, input.body, { signal: input.signal });
    const sourceSha256 = (await import("node:crypto")).createHash("sha256").update(input.body).digest("hex");
    const probed = await probeVideo(inputPath, ffprobePath, input.signal);
    const detected = await detectSceneBoundaries(inputPath, ffmpegPath, threshold, input.signal);
    const boundaries = selectBoundaries(detected, probed.duration, input.maximumShots);
    const shots: VideoStoryTechnicalShot[] = [];
    for (let index = 0; index < boundaries.length; index += 1) {
      input.signal.throwIfAborted();
      const startTime = boundaries[index];
      const endTime = roundedSeconds(boundaries[index + 1] ?? probed.duration);
      if (endTime <= startTime) continue;
      const duration = roundedSeconds(endTime - startTime);
      const frameTime = roundedSeconds(Math.min(endTime, startTime + Math.min(0.25, duration / 2)));
      const frame = await extractFrame(
        inputPath,
        path.join(temporaryDirectory, `shot-${index + 1}.jpg`),
        frameTime,
        ffmpegPath,
        input.signal,
      );
      shots.push({
        startTime,
        endTime,
        duration,
        frameTime,
        sceneConfidence: null,
        frame,
      });
    }
    if (!shots.length) throw new Error("video_story_no_shots");
    return {
      duration: probed.duration,
      width: probed.width,
      height: probed.height,
      sourceSha256,
      sceneThreshold: threshold,
      shots,
    };
  } finally {
    await fs.promises.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
  }
}
