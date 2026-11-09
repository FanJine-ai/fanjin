import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import oss from "@/utils/oss";
import { sanitizeChildProcessEnvironment } from "./childProcessEnvironment";
import { GenerationReferenceError } from "./generationReferenceError";

const execute = promisify(execFile);
type Trim = { startMs: number; endMs: number };
const pending = new Map<string, Promise<string>>();
const prepared = new Map<string, { filePath: string; expiresAt: number }>();

function invalid(message: string): never {
  throw new GenerationReferenceError(422, "reference_trim_invalid", message);
}

/** Decode the selected range locally; providers receive an ordinary media file. */
export async function encodeReferenceMediaTrim(body: Buffer, kind: "audio" | "video", trim: Trim): Promise<Buffer> {
  if (!Number.isSafeInteger(trim.startMs) || !Number.isSafeInteger(trim.endMs)
    || trim.startMs < 0 || trim.endMs <= trim.startMs) invalid("参考素材时间段无效，请重新选择");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fanjin-reference-trim-"));
  const source = path.join(directory, "source");
  const target = path.join(directory, kind === "audio" ? "clip.mp3" : "clip.mp4");
  const options = { timeout: 60_000, maxBuffer: 1024 * 1024, env: sanitizeChildProcessEnvironment(), windowsHide: true };
  try {
    await fs.writeFile(source, body, { mode: 0o600 });
    const probe = await execute(process.env.FANJIN_FFPROBE_PATH || "ffprobe", [
      "-v", "error", "-protocol_whitelist", "file,pipe", "-show_format", "-show_streams", "-of", "json", source,
    ], options);
    const metadata = JSON.parse(probe.stdout);
    const stream = metadata.streams?.find((item: any) => item.codec_type === kind);
    const durationMs = Number(stream?.duration ?? metadata.format?.duration) * 1000;
    if (!stream || !Number.isFinite(durationMs) || durationMs <= 0) invalid("无法读取参考素材时长，请重新上传素材");
    if (trim.startMs >= durationMs || trim.endMs > durationMs + 50) invalid("所选时间段超过参考素材时长，请调整后重试");
    const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-threads", "1",
      "-protocol_whitelist", "file,pipe", "-i", source,
      "-ss", String(trim.startMs / 1000), "-t", String((Math.min(trim.endMs, durationMs) - trim.startMs) / 1000),
      "-map_metadata", "-1", "-threads", "1"];
    if (kind === "audio") args.push("-map", "0:a:0", "-vn", "-c:a", "libmp3lame", "-b:a", "192k");
    else args.push("-map", "0:v:0", "-map", "0:a:0?", "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart");
    await execute(process.env.FANJIN_FFMPEG_PATH || "ffmpeg", [...args, target], options);
    const output = await fs.readFile(target);
    if (!output.length) invalid("参考素材时间段处理失败，请重试");
    return output;
  } catch (error) {
    if (error instanceof GenerationReferenceError) throw error;
    console.error("reference_media_trim_failed", { mediaType: kind, code: (error as NodeJS.ErrnoException)?.code || "MEDIA_PROCESSING_FAILED" });
    throw new GenerationReferenceError(503, "reference_trim_processing_failed", "参考素材时间段处理失败，请稍后重试");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

export async function materializeReferenceMediaTrim(input: {
  workspaceId: string; projectId: string; assetVersionId: string;
  filePath: string; mediaType: "audio" | "video"; trim: Trim;
}): Promise<string> {
  const identity = JSON.stringify(input);
  const cached = prepared.get(identity);
  if (cached && cached.expiresAt > Date.now()) return cached.filePath;
  prepared.delete(identity);
  const existing = pending.get(identity);
  if (existing) return existing;
  const result = (async () => {
    // Read only the storage path resolved from the authorized asset version.
    const body = await oss.getFile(input.filePath);
    const output = await encodeReferenceMediaTrim(body, input.mediaType, input.trim);
    const digest = createHash("sha256").update(output).digest("hex");
    const key = `workspaces/${encodeURIComponent(input.workspaceId)}/projects/${input.projectId}/reference-clips/${digest}.${input.mediaType === "audio" ? "mp3" : "mp4"}`;
    await oss.writeFile(key, output);
    for (const [id, entry] of prepared) if (entry.expiresAt <= Date.now()) prepared.delete(id);
    if (prepared.size >= 128) prepared.delete(prepared.keys().next().value!);
    prepared.set(identity, { filePath: key, expiresAt: Date.now() + 5 * 60_000 });
    return key;
  })();
  pending.set(identity, result);
  // Coalesce concurrent quote/submit preparation; no permanent lock on failure.
  try { return await result; } finally { pending.delete(identity); }
}
