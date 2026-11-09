import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { sanitizeChildProcessEnvironment } from "@/lib/childProcessEnvironment";

export type FinalRenderDimensions = {
  width: number;
  height: number;
};

export type FinalRenderInput = {
  clips: Buffer[];
  ratio: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  clipDurationsSeconds?: number[];
  clipEdits?: Array<{
    trimStartSeconds?: number;
    trimEndSeconds?: number;
    speed?: number;
    volume?: number;
  }>;
  soundtrack?: {
    body: Buffer;
    volume?: number;
  } | null;
  subtitleCues?: Array<{
    startSeconds: number;
    endSeconds: number;
    text: string;
  }>;
  strictClipEdits?: boolean;
  timeoutMs?: number;
};

export function resolveFinalRenderDimensions(ratio: string): FinalRenderDimensions {
  if (ratio === "9:16") return { width: 1080, height: 1920 };
  if (ratio === "1:1") return { width: 1080, height: 1080 };
  if (ratio === "4:3") return { width: 1440, height: 1080 };
  if (ratio === "3:4") return { width: 1080, height: 1440 };
  return { width: 1920, height: 1080 };
}

function buildAtempoFilters(speed: number): string {
  if (Math.abs(speed - 1) < 0.000_001) return "";
  const factors: number[] = [];
  let remaining = speed;
  while (remaining < 0.5 - 0.000_001) {
    factors.push(0.5);
    remaining /= 0.5;
  }
  while (remaining > 2 + 0.000_001) {
    factors.push(2);
    remaining /= 2;
  }
  if (Math.abs(remaining - 1) >= 0.000_001) factors.push(remaining);
  return factors.map((factor) => `atempo=${factor.toFixed(3)},`).join("");
}

export function buildFinalRenderFfmpegArguments(input: {
  inputPaths: string[];
  outputPath: string;
  dimensions: FinalRenderDimensions;
  audioPresence?: boolean[];
  clipDurationsSeconds?: number[];
  clipTrimStartSeconds?: number[];
  clipTrimEndSeconds?: number[];
  clipSpeeds?: number[];
  clipVolumes?: number[];
  soundtrackPath?: string | null;
  soundtrackVolume?: number;
  subtitleOverlays?: Array<{
    inputPath: string;
    startSeconds: number;
    endSeconds: number;
  }>;
}): string[] {
  if (!input.inputPaths.length) throw new Error("FINAL_RENDER_CLIPS_EMPTY");
  const { width, height } = input.dimensions;
  const subtitleOverlays = input.subtitleOverlays ?? [];
  const allInputPaths = [
    ...input.inputPaths,
    ...subtitleOverlays.map((subtitle) => subtitle.inputPath),
    ...(input.soundtrackPath ? [input.soundtrackPath] : []),
  ];
  const inputArguments = allInputPaths.flatMap((inputPath) => ["-i", inputPath]);
  const clipDurations = input.inputPaths.map((_, index) => {
    const sourceDuration = Number(input.clipDurationsSeconds?.[index] || 0);
    const safeSourceDuration = Number.isFinite(sourceDuration) && sourceDuration > 0
      ? sourceDuration
      : 1;
    const requestedStart = Number(input.clipTrimStartSeconds?.[index] || 0);
    const trimStart = Number.isFinite(requestedStart)
      ? Math.max(0, Math.min(requestedStart, Math.max(0, safeSourceDuration - 0.05)))
      : 0;
    const requestedEnd = Number(input.clipTrimEndSeconds?.[index] || 0);
    const trimEnd = Number.isFinite(requestedEnd) && requestedEnd > trimStart
      ? Math.min(requestedEnd, safeSourceDuration)
      : safeSourceDuration;
    const requestedSpeed = Number(input.clipSpeeds?.[index] ?? 1);
    const speed = Number.isFinite(requestedSpeed)
      ? Math.max(0.25, Math.min(requestedSpeed, 4))
      : 1;
    return {
      trimStart,
      trimEnd: Math.max(trimStart + 0.05, trimEnd),
      speed,
      duration: Math.max(0.05, (trimEnd - trimStart) / speed),
    };
  });
  const preparedVideoStreams = input.inputPaths.map(
    (_, index) => {
      const start = clipDurations[index].trimStart.toFixed(3);
      const end = clipDurations[index].trimEnd.toFixed(3);
      const speed = clipDurations[index].speed;
      const setpts = Math.abs(speed - 1) < 0.000_001
        ? "setpts=PTS-STARTPTS"
        : `setpts=(PTS-STARTPTS)/${speed.toFixed(3)}`;
      return (
        `[${index}:v:0]scale=${width}:${height}:force_original_aspect_ratio=decrease,`
        + `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,`
        + `setsar=1,fps=30,format=yuv420p,trim=start=${start}:end=${end},${setpts}`
        + `[v${index}]`
      );
    },
  );
  const preparedAudioStreams = input.inputPaths.map((_, index) => {
    const start = clipDurations[index].trimStart.toFixed(3);
    const end = clipDurations[index].trimEnd.toFixed(3);
    const duration = clipDurations[index].duration.toFixed(3);
    const speed = clipDurations[index].speed;
    const requestedVolume = Number(input.clipVolumes?.[index] ?? 1);
    const volume = Number.isFinite(requestedVolume)
      ? Math.max(0, Math.min(requestedVolume, 2))
      : 1;
    const atempo = buildAtempoFilters(speed);
    if (input.audioPresence?.[index]) {
      return (
        `[${index}:a:0]aresample=48000,`
        + "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,"
        + `apad,atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS,${atempo}`
        + `volume=${volume.toFixed(3)}`
        + `[a${index}]`
      );
    }
    return (
      "anullsrc=channel_layout=stereo:sample_rate=48000,"
      + `atrim=duration=${duration},asetpts=PTS-STARTPTS[a${index}]`
    );
  });
  const concatInputs = input.inputPaths
    .map((_, index) => `[v${index}][a${index}]`)
    .join("");
  const concatAudioLabel = input.soundtrackPath ? "clipa" : "outa";
  const concatVideoLabel = subtitleOverlays.length ? "outv0" : "outv";
  const filter = [
    ...preparedVideoStreams,
    ...preparedAudioStreams,
    `${concatInputs}concat=n=${input.inputPaths.length}:v=1:a=1[${concatVideoLabel}][${concatAudioLabel}]`,
  ].join(";");
  const subtitleFilters = subtitleOverlays.map((subtitle, index) => {
    const inputIndex = input.inputPaths.length + index;
    const priorLabel = index === 0 ? concatVideoLabel : `outv${index}`;
    const outputLabel = index === subtitleOverlays.length - 1 ? "outv" : `outv${index + 1}`;
    return (
      `[${priorLabel}][${inputIndex}:v:0]overlay=x=(W-w)/2:y=H-h-72:`
      + `enable='between(t,${subtitle.startSeconds.toFixed(3)},${subtitle.endSeconds.toFixed(3)})':`
      + `eof_action=repeat[${outputLabel}]`
    );
  });
  const totalDuration = clipDurations.reduce((sum, clip) => sum + clip.duration, 0);
  const soundtrackInputIndex = input.inputPaths.length + subtitleOverlays.length;
  const soundtrackFilter = input.soundtrackPath
    ? [
        `[${soundtrackInputIndex}:a:0]aresample=48000,`
          + "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,"
          + `apad,atrim=duration=${totalDuration.toFixed(3)},asetpts=PTS-STARTPTS,`
          + `volume=${Math.max(0, Math.min(Number(input.soundtrackVolume ?? 1) || 0, 2)).toFixed(3)}`
          + "[music]",
        "[clipa][music]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[outa]",
      ]
    : [];
  const completeFilter = [filter, ...subtitleFilters, ...soundtrackFilter].join(";");
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    ...inputArguments,
    "-filter_complex",
    completeFilter,
    "-map",
    "[outv]",
    "-map",
    "[outa]",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    input.outputPath,
  ];
}

function escapeSubtitleXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function wrapSubtitleText(value: string, maxCharacters: number): string[] {
  const paragraphs = value.replace(/\r\n?/g, "\n").split("\n");
  return paragraphs.flatMap((paragraph) => {
    const characters = Array.from(paragraph.trim());
    if (!characters.length) return [];
    const lines: string[] = [];
    for (let index = 0; index < characters.length; index += maxCharacters) {
      lines.push(characters.slice(index, index + maxCharacters).join(""));
    }
    return lines;
  }).slice(0, 3);
}

async function createSubtitleOverlays(input: {
  directory: string;
  dimensions: FinalRenderDimensions;
  cues: NonNullable<FinalRenderInput["subtitleCues"]>;
}): Promise<Array<{ inputPath: string; startSeconds: number; endSeconds: number }>> {
  const { width, height } = input.dimensions;
  const fontSize = Math.max(38, Math.round(Math.min(width, height) * 0.045));
  const lineHeight = Math.round(fontSize * 1.38);
  const cardWidth = Math.max(320, Math.round(width * 0.84));
  const maxCharacters = Math.max(10, Math.floor((cardWidth - 96) / fontSize * 1.8));
  const overlays: Array<{ inputPath: string; startSeconds: number; endSeconds: number }> = [];
  for (const [index, cue] of input.cues.entries()) {
    const startSeconds = Number(cue.startSeconds);
    const endSeconds = Number(cue.endSeconds);
    const text = String(cue.text || "").trim();
    if (
      !Number.isFinite(startSeconds)
      || !Number.isFinite(endSeconds)
      || startSeconds < 0
      || endSeconds <= startSeconds
      || !text
    ) {
      throw new Error(`FINAL_RENDER_SUBTITLE_INVALID:${index}`);
    }
    const lines = wrapSubtitleText(text, maxCharacters);
    if (!lines.length) throw new Error(`FINAL_RENDER_SUBTITLE_INVALID:${index}`);
    const cardHeight = Math.max(96, lines.length * lineHeight + 48);
    const firstBaseline = Math.round((cardHeight - (lines.length - 1) * lineHeight) / 2 + fontSize * 0.34);
    const tspans = lines.map((line, lineIndex) => (
      `<tspan x="${cardWidth / 2}" y="${firstBaseline + lineIndex * lineHeight}">${escapeSubtitleXml(line)}</tspan>`
    )).join("");
    const svg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${cardWidth}" height="${cardHeight}">`
      + "<defs><filter id=\"shadow\" x=\"-20%\" y=\"-20%\" width=\"140%\" height=\"140%\"><feGaussianBlur stdDeviation=\"3\"/><feOffset dy=\"2\"/></filter></defs>"
      + `<rect x="0" y="0" width="${cardWidth}" height="${cardHeight}" rx="18" fill="rgba(0,0,0,0.68)"/>`
      + `<text text-anchor="middle" font-family="PingFang SC,Hiragino Sans GB,Microsoft YaHei,sans-serif" font-size="${fontSize}" font-weight="600" fill="black" opacity="0.72" filter="url(#shadow)">${tspans}</text>`
      + `<text text-anchor="middle" font-family="PingFang SC,Hiragino Sans GB,Microsoft YaHei,sans-serif" font-size="${fontSize}" font-weight="600" fill="white">${tspans}</text>`
      + "</svg>",
    );
    const inputPath = path.join(input.directory, `subtitle-${String(index).padStart(3, "0")}.png`);
    await fs.writeFile(inputPath, await sharp(svg).png().toBuffer());
    overlays.push({ inputPath, startSeconds, endSeconds });
  }
  return overlays;
}

async function probeClip(input: {
  executable: string;
  inputPath: string;
  fallbackDurationSeconds: number;
  timeoutMs: number;
}): Promise<{ hasAudio: boolean; durationSeconds: number; probed: boolean }> {
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(input.executable, [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type",
        "-show_entries",
        "format=duration",
        "-of",
        "json",
        input.inputPath,
      ], {
        env: sanitizeChildProcessEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        output = `${output}${chunk}`.slice(-65_536);
      });
      child.stderr.on("data", (chunk: string) => {
        stderr = `${stderr}${chunk}`.slice(-16_384);
      });
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("FINAL_RENDER_PROBE_TIMEOUT"));
      }, input.timeoutMs);
      timeout.unref?.();
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("close", (code, signal) => {
        clearTimeout(timeout);
        if (code === 0) {
          resolve(output);
          return;
        }
        reject(new Error(
          `FINAL_RENDER_PROBE_FAILED:${code ?? signal ?? "unknown"}:${stderr || "no stderr"}`,
        ));
      });
    });
    const parsed = JSON.parse(stdout) as {
      streams?: Array<{ codec_type?: string }>;
      format?: { duration?: string | number };
    };
    const probedDuration = Number(parsed.format?.duration || 0);
    return {
      hasAudio: Boolean(parsed.streams?.some((stream) => stream.codec_type === "audio")),
      durationSeconds: Number.isFinite(probedDuration) && probedDuration > 0
        ? probedDuration
        : input.fallbackDurationSeconds,
      probed: true,
    };
  } catch {
    return {
      hasAudio: false,
      durationSeconds: input.fallbackDurationSeconds,
      probed: false,
    };
  }
}

async function runFfmpeg(
  executable: string,
  args: string[],
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, {
      env: sanitizeChildProcessEnvironment(),
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-16_384);
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("FINAL_RENDER_TIMEOUT"));
    }, timeoutMs);
    timeout.unref?.();
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(
        `FINAL_RENDER_FFMPEG_FAILED:${code ?? signal ?? "unknown"}:${stderr || "no stderr"}`,
      ));
    });
  });
}

export async function renderProjectFinalVideo(input: FinalRenderInput): Promise<{
  body: Buffer;
  dimensions: FinalRenderDimensions;
  audioIncluded: boolean;
}> {
  if (!input.clips.length) throw new Error("FINAL_RENDER_CLIPS_EMPTY");
  if (input.clips.length > 100) throw new Error("FINAL_RENDER_TOO_MANY_CLIPS");
  const totalBytes = input.clips.reduce((sum, clip) => sum + clip.byteLength, 0);
  if (totalBytes <= 0 || totalBytes > 2 * 1024 * 1024 * 1024) {
    throw new Error("FINAL_RENDER_INPUT_TOO_LARGE");
  }
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "fanjin-final-render-"));
  try {
    const inputPaths: string[] = [];
    for (const [index, clip] of input.clips.entries()) {
      const inputPath = path.join(temporaryDirectory, `clip-${String(index).padStart(3, "0")}.mp4`);
      await fs.writeFile(inputPath, clip);
      inputPaths.push(inputPath);
    }
    const outputPath = path.join(temporaryDirectory, "final.mp4");
    const soundtrackPath = input.soundtrack
      ? path.join(temporaryDirectory, "soundtrack")
      : null;
    if (soundtrackPath && input.soundtrack) {
      if (!input.soundtrack.body.length) throw new Error("FINAL_RENDER_SOUNDTRACK_EMPTY");
      await fs.writeFile(soundtrackPath, input.soundtrack.body);
    }
    const dimensions = resolveFinalRenderDimensions(input.ratio);
    const subtitleOverlays = await createSubtitleOverlays({
      directory: temporaryDirectory,
      dimensions,
      cues: input.subtitleCues ?? [],
    });
    const probes = await Promise.all(inputPaths.map((inputPath, index) => {
      const requestedFallback = Number(input.clipDurationsSeconds?.[index] || 0);
      return probeClip({
        executable: input.ffprobePath || process.env.FANJIN_FFPROBE_PATH || "ffprobe",
        inputPath,
        fallbackDurationSeconds: Number.isFinite(requestedFallback) && requestedFallback > 0
          ? requestedFallback
          : 1,
        timeoutMs: Math.min(
          input.timeoutMs ?? Number(process.env.FANJIN_FINAL_RENDER_TIMEOUT_MS || 30 * 60_000),
          30_000,
        ),
      });
    }));
    if (input.strictClipEdits) {
      for (const [index, probe] of probes.entries()) {
        if (!probe.probed) {
          throw new Error(`FINAL_RENDER_PROBE_FAILED:${index}`);
        }
        const edit = input.clipEdits?.[index];
        const start = Number(edit?.trimStartSeconds);
        const end = Number(edit?.trimEndSeconds);
        const speed = Number(edit?.speed ?? 1);
        if (
          !Number.isFinite(start)
          || !Number.isFinite(end)
          || !Number.isFinite(speed)
          || start < 0
          || end <= start
          || end > probe.durationSeconds + 0.05
          || speed < 0.25
          || speed > 4
        ) {
          throw new Error(`FINAL_RENDER_CLIP_EDIT_INVALID:${index}`);
        }
      }
    }
    const args = buildFinalRenderFfmpegArguments({
      inputPaths,
      outputPath,
      dimensions,
      audioPresence: probes.map((probe) => probe.hasAudio),
      clipDurationsSeconds: probes.map((probe) => probe.durationSeconds),
      clipTrimStartSeconds: probes.map((_, index) => Number(input.clipEdits?.[index]?.trimStartSeconds || 0)),
      clipTrimEndSeconds: probes.map((probe, index) => {
        const requested = Number(input.clipEdits?.[index]?.trimEndSeconds || 0);
        return Number.isFinite(requested) && requested > 0 ? requested : probe.durationSeconds;
      }),
      clipSpeeds: probes.map((_, index) => Number(input.clipEdits?.[index]?.speed ?? 1)),
      clipVolumes: probes.map((_, index) => Number(input.clipEdits?.[index]?.volume ?? 1)),
      soundtrackPath,
      soundtrackVolume: input.soundtrack?.volume,
      subtitleOverlays,
    });
    await runFfmpeg(
      input.ffmpegPath || process.env.FANJIN_FFMPEG_PATH || "ffmpeg",
      args,
      input.timeoutMs ?? Number(process.env.FANJIN_FINAL_RENDER_TIMEOUT_MS || 30 * 60_000),
    );
    const body = await fs.readFile(outputPath);
    if (body.length < 24 || body.subarray(4, 8).toString("ascii") !== "ftyp") {
      throw new Error("FINAL_RENDER_OUTPUT_INVALID");
    }
    return {
      body,
      dimensions,
      audioIncluded: probes.some((probe) => probe.hasAudio) || Boolean(input.soundtrack),
    };
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}
