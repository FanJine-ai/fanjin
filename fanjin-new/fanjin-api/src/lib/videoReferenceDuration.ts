import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Knex } from "knex";
import oss from "@/utils/oss";
import { resolveProjectAssetVersion } from "./projectAssetVersion";
import { materializeReferenceMediaTrim } from "./referenceMediaTrim";
import { sanitizeChildProcessEnvironment } from "./childProcessEnvironment";
import type { VideoGenerationRequest } from "./videoGenerationContract";

const execute = promisify(execFile);
const durations = new Map<string, number>();

export type VideoReferenceDurations = {
  totalSeconds: number;
  sourceSeconds: number | null;
  minimumSeconds?: number;
  count: number;
  operation: VideoGenerationRequest["operation"];
  digest: string;
};

/** Only bytes read from an authorized project asset are measured. No URLs or
 * caller-supplied duration/trim metadata can lower a wallet reservation. */
export async function probeReservationVideoDuration(body: Buffer): Promise<number> {
  const digest = createHash("sha256").update(body).digest("hex");
  const cached = durations.get(digest);
  if (cached != null) return cached;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fanjin-video-price-"));
  try {
    const source = path.join(directory, "source");
    await fs.writeFile(source, body, { mode: 0o600 });
    const { stdout } = await execute(process.env.FANJIN_FFPROBE_PATH || "ffprobe", [
      "-v", "error", "-max_alloc", "67108864", "-protocol_whitelist", "file",
      "-probesize", "8388608", "-analyzeduration", "5000000", "-select_streams", "v:0",
      "-show_entries", "stream=duration:format=duration", "-of", "json", source,
    ], { timeout: 30_000, maxBuffer: 65536, env: sanitizeChildProcessEnvironment(), windowsHide: true });
    const metadata = JSON.parse(stdout);
    // Include a longer container timeline rather than under-reserve trailing frames/audio.
    const seconds = Math.max(Number(metadata.streams?.[0]?.duration) || 0, Number(metadata.format?.duration) || 0);
    if (!metadata.streams?.length || !Number.isFinite(seconds) || seconds <= 0) throw new Error("video_duration_unavailable");
    if (durations.size >= 128) durations.delete(durations.keys().next().value!);
    durations.set(digest, seconds);
    return seconds;
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

export async function resolveVideoReferenceDurations(input: {
  database: Knex | Knex.Transaction; workspaceId: string; projectId: number;
  request: VideoGenerationRequest;
}): Promise<VideoReferenceDurations | undefined> {
  const videos = input.request.inputs.filter(item => item.mediaType === "video");
  if (!videos.length || videos.length > 10 || !Number.isSafeInteger(input.projectId) || input.projectId <= 0) return;
  const evidence: Array<{ assetVersionId: string; sha256: string; seconds: number }> = [];
  for (const video of videos) {
    const asset = await resolveProjectAssetVersion({ database: input.database, workspaceId: input.workspaceId,
      projectId: input.projectId, assetVersionId: Number(video.assetVersionId) });
    if (!asset || !["video", "clip"].includes(asset.type) || !asset.filePath) return;
    try {
      const filePath = video.trim ? await materializeReferenceMediaTrim({ workspaceId: input.workspaceId,
        projectId: String(input.projectId), assetVersionId: video.assetVersionId,
        filePath: asset.filePath, mediaType: "video", trim: video.trim }) : asset.filePath;
      const body = await oss.getFile(filePath);
      const seconds = await probeReservationVideoDuration(body);
      if (seconds < 2 || seconds > 30.05) return;
      evidence.push({ assetVersionId: video.assetVersionId, sha256: createHash("sha256").update(body).digest("hex"), seconds });
    } catch {
      // Storage/probe failure retains the configured ceiling; never guess a shorter clip.
      return;
    }
  }
  const totalSeconds = evidence.reduce((sum, item) => sum + item.seconds, 0);
  if (totalSeconds > 30.05) return;
  return { totalSeconds, count: videos.length, operation: input.request.operation,
    minimumSeconds: Math.min(...evidence.map(item => item.seconds)),
    sourceSeconds: evidence.find(item => item.assetVersionId === input.request.source?.assetVersionId)?.seconds ?? null,
    digest: createHash("sha256").update(JSON.stringify(evidence)).digest("hex") };
}
