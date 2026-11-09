export interface PersistedComposeClip {
  id: string;
  nodeId: string;
  assetVersionId?: number;
  trimStart: number;
  trimEnd: number;
  speed: number;
}

export interface ComposeClip extends PersistedComposeClip {
  title: string;
  url: string;
  posterUrl?: string;
  sourceDuration: number;
  duration: number;
  startAt: number;
  endAt: number;
}

export function formatComposeTime(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds || 0));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export function composeSegmentLength(clip: Pick<ComposeClip, "trimStart" | "trimEnd">) {
  return Math.max(0.1, clip.trimEnd - clip.trimStart);
}

export function composeClipDurationFromSettings(
  clip: Pick<ComposeClip, "trimStart" | "trimEnd" | "speed">,
) {
  return Math.max(0.1, composeSegmentLength(clip) / Math.max(0.25, clip.speed));
}

export function layoutComposeClips(clips: readonly ComposeClip[]): ComposeClip[] {
  let cursor = 0;
  return clips.map((clip) => {
    const duration = composeClipDurationFromSettings(clip);
    const nextClip = {
      ...clip,
      speed: Math.min(4, Math.max(0.25, clip.speed)),
      duration,
      startAt: cursor,
      endAt: cursor + duration,
    };
    cursor += duration;
    return nextClip;
  });
}

export function getComposeClipLocalTime(clip: ComposeClip, globalTime: number) {
  const relative = Math.max(0, Math.min(clip.duration, globalTime - clip.startAt));
  return Math.max(clip.trimStart, Math.min(clip.trimEnd, clip.trimStart + relative * clip.speed));
}

export function findComposeClipByTime(clips: readonly ComposeClip[], time: number) {
  if (clips.length === 0) return null;
  return clips.find((clip) => time >= clip.startAt && time < clip.endAt) ?? clips[clips.length - 1];
}

export function persistedComposeTimeline(clips: readonly ComposeClip[]): PersistedComposeClip[] {
  return clips.map((clip) => ({
    id: clip.id,
    nodeId: clip.nodeId,
    assetVersionId:
      Number.isSafeInteger(Number(clip.assetVersionId)) && Number(clip.assetVersionId) > 0
        ? Number(clip.assetVersionId)
        : undefined,
    trimStart: clip.trimStart,
    trimEnd: clip.trimEnd,
    speed: clip.speed,
  }));
}
