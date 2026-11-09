import type { PlatformReleaseDraft, PlatformReleaseRecord } from "./types";

export function releaseDraftFromRecord(record: PlatformReleaseRecord): PlatformReleaseDraft {
  return {
    version: record.version,
    title: record.title,
    channel: record.channel,
    summary: record.summary,
    releaseNotes: record.releaseNotes,
  };
}

export function releaseDraftChanged(initial: PlatformReleaseDraft, current: PlatformReleaseDraft) {
  return initial.version !== current.version
    || initial.title !== current.title
    || initial.channel !== current.channel
    || initial.summary !== current.summary
    || initial.releaseNotes !== current.releaseNotes;
}
