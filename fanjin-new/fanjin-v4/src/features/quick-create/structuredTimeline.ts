export const STRUCTURED_TIMELINE_VERSION = "structured-timeline.v1" as const;
export const STRUCTURED_TIMELINE_DURATION_SECONDS = 30 as const;

export type StructuredTimelineShot = {
  id: string;
  title: string;
  prompt: string;
  startSeconds: number;
  endSeconds: number;
  assetVersionIds: string[];
};

export type StructuredTimelineAudioCue = {
  id: string;
  label: string;
  assetVersionId: string;
  startSeconds: number;
  endSeconds: number;
  sourceStartSeconds: number;
  volume: number;
};

export type StructuredThirtySecondTimeline = {
  version: typeof STRUCTURED_TIMELINE_VERSION;
  durationSeconds: typeof STRUCTURED_TIMELINE_DURATION_SECONDS;
  shots: StructuredTimelineShot[];
  audioCues: StructuredTimelineAudioCue[];
};

export type TimelineAttachment = {
  assetVersionId: string;
  mediaType: "image" | "video" | "audio";
  label: string;
};

type StructuredTimelineDirectorPlan = {
  shots: Array<{
    title?: string;
    script?: string;
    visual?: string;
    prompt?: string;
    duration?: number;
  }>;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === [...expected].sort()[index]);
}

function finiteRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function cleanId(value: unknown, max = 200): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return id && id.length <= max ? id : null;
}

export function normalizeStructuredThirtySecondTimeline(
  value: unknown,
): StructuredThirtySecondTimeline | null {
  if (!isObject(value) || !hasExactKeys(value, ["audioCues", "durationSeconds", "shots", "version"])) {
    return null;
  }
  if (
    value.version !== STRUCTURED_TIMELINE_VERSION
    || value.durationSeconds !== STRUCTURED_TIMELINE_DURATION_SECONDS
    || !Array.isArray(value.shots)
    || value.shots.length < 1
    || value.shots.length > 30
    || !Array.isArray(value.audioCues)
    || value.audioCues.length > 50
  ) return null;

  const shots: StructuredTimelineShot[] = [];
  const shotIds = new Set<string>();
  let cursor = 0;
  for (const raw of value.shots) {
    if (!isObject(raw) || !hasExactKeys(raw, [
      "assetVersionIds",
      "endSeconds",
      "id",
      "prompt",
      "startSeconds",
      "title",
    ])) return null;
    const id = cleanId(raw.id, 80);
    const title = cleanId(raw.title);
    const prompt = cleanId(raw.prompt, 2_000);
    if (
      !id || !title || !prompt || shotIds.has(id)
      || !finiteRange(raw.startSeconds, 0, 30)
      || !finiteRange(raw.endSeconds, 0, 30)
      || Math.abs(raw.startSeconds - cursor) > 1e-6
      || raw.endSeconds - raw.startSeconds < 0.1
      || !Array.isArray(raw.assetVersionIds)
      || raw.assetVersionIds.length > 12
    ) return null;
    const assetVersionIds = raw.assetVersionIds.map((asset) => cleanId(asset));
    if (assetVersionIds.some((asset) => !asset)) return null;
    const cleanAssets = assetVersionIds as string[];
    if (new Set(cleanAssets).size !== cleanAssets.length) return null;
    shots.push({
      id,
      title,
      prompt,
      startSeconds: raw.startSeconds,
      endSeconds: raw.endSeconds,
      assetVersionIds: cleanAssets,
    });
    shotIds.add(id);
    cursor = raw.endSeconds;
  }
  if (Math.abs(cursor - 30) > 1e-6) return null;

  const audioCues: StructuredTimelineAudioCue[] = [];
  const cueIds = new Set<string>();
  for (const raw of value.audioCues) {
    if (!isObject(raw) || !hasExactKeys(raw, [
      "assetVersionId",
      "endSeconds",
      "id",
      "label",
      "sourceStartSeconds",
      "startSeconds",
      "volume",
    ])) return null;
    const id = cleanId(raw.id, 80);
    const label = cleanId(raw.label);
    const assetVersionId = cleanId(raw.assetVersionId);
    if (
      !id || !label || !assetVersionId || cueIds.has(id)
      || !finiteRange(raw.startSeconds, 0, 30)
      || !finiteRange(raw.endSeconds, 0, 30)
      || raw.endSeconds - raw.startSeconds < 0.05
      || !finiteRange(raw.sourceStartSeconds, 0, 24 * 60 * 60)
      || !finiteRange(raw.volume, 0, 2)
    ) return null;
    audioCues.push({
      id,
      label,
      assetVersionId,
      startSeconds: raw.startSeconds,
      endSeconds: raw.endSeconds,
      sourceStartSeconds: raw.sourceStartSeconds,
      volume: raw.volume,
    });
    cueIds.add(id);
  }
  return { version: STRUCTURED_TIMELINE_VERSION, durationSeconds: 30, shots, audioCues };
}

function timelineBoundaries(plan: StructuredTimelineDirectorPlan): number[] {
  const weights = plan.shots.map((shot) => {
    const duration = Number(shot.duration);
    return Number.isFinite(duration) && duration > 0 ? duration : 1;
  });
  const total = weights.reduce((sum, duration) => sum + duration, 0) || weights.length;
  const boundaries = [0];
  let elapsed = 0;
  weights.forEach((weight, index) => {
    elapsed += weight;
    boundaries.push(index === weights.length - 1
      ? STRUCTURED_TIMELINE_DURATION_SECONDS
      : Number(((elapsed / total) * STRUCTURED_TIMELINE_DURATION_SECONDS).toFixed(3)));
  });
  return boundaries;
}

/** Build an editable provider-neutral timeline from a director plan. */
export function buildStructuredThirtySecondTimeline(input: {
  plan: StructuredTimelineDirectorPlan;
  attachments: TimelineAttachment[];
}): StructuredThirtySecondTimeline {
  if (!input.plan.shots.length) throw new Error("导演计划至少需要一个镜头");
  const boundaries = timelineBoundaries(input.plan);
  const visualAssets = input.attachments.filter((attachment) => attachment.mediaType !== "audio");
  const audioAssets = input.attachments.filter((attachment) => attachment.mediaType === "audio");
  const shots = input.plan.shots.map((shot, index) => ({
    id: `shot-${index + 1}`,
    title: shot.title?.trim() || `镜头 ${index + 1}`,
    prompt: shot.prompt?.trim() || shot.visual?.trim() || shot.script?.trim() || `镜头 ${index + 1}`,
    startSeconds: boundaries[index],
    endSeconds: boundaries[index + 1],
    assetVersionIds: visualAssets[index]
      ? [visualAssets[index].assetVersionId]
      : [],
  }));
  const audioCues = audioAssets.map((attachment, index) => ({
    id: `audio-${index + 1}`,
    label: attachment.label.trim() || `音频 ${index + 1}`,
    assetVersionId: attachment.assetVersionId,
    startSeconds: 0,
    endSeconds: STRUCTURED_TIMELINE_DURATION_SECONDS,
    sourceStartSeconds: 0,
    volume: 1,
  }));
  const timeline: StructuredThirtySecondTimeline = {
    version: STRUCTURED_TIMELINE_VERSION,
    durationSeconds: STRUCTURED_TIMELINE_DURATION_SECONDS,
    shots,
    audioCues,
  };
  const normalized = normalizeStructuredThirtySecondTimeline(timeline);
  if (!normalized) throw new Error("无法从导演计划建立连续的 30 秒时间线");
  return normalized;
}

export function bindStructuredTimelineAttachments(input: {
  timeline: StructuredThirtySecondTimeline;
  attachments: TimelineAttachment[];
}): StructuredThirtySecondTimeline {
  const visualAssets = input.attachments.filter((attachment) => attachment.mediaType !== "audio");
  const assetsByShot = input.timeline.shots.map(() => [] as string[]);
  visualAssets.forEach((attachment, index) => {
    const target = assetsByShot[index % assetsByShot.length];
    if (target && target.length < 12 && !target.includes(attachment.assetVersionId)) {
      target.push(attachment.assetVersionId);
    }
  });
  const timeline: StructuredThirtySecondTimeline = {
    ...input.timeline,
    shots: input.timeline.shots.map((shot, index) => ({
      ...shot,
      assetVersionIds: assetsByShot[index],
    })),
    audioCues: input.attachments
      .filter((attachment) => attachment.mediaType === "audio")
      .slice(0, 50)
      .map((attachment, index) => ({
        id: `audio-${index + 1}`,
        label: attachment.label.trim() || `音频 ${index + 1}`,
        assetVersionId: attachment.assetVersionId,
        startSeconds: 0,
        endSeconds: STRUCTURED_TIMELINE_DURATION_SECONDS,
        sourceStartSeconds: 0,
        volume: 1,
      })),
  };
  const normalized = normalizeStructuredThirtySecondTimeline(timeline);
  if (!normalized) throw new Error("素材绑定后的 30 秒时间线无效");
  return normalized;
}

export function timelineAssetVersionIds(timeline: StructuredThirtySecondTimeline): string[] {
  return Array.from(new Set([
    ...timeline.shots.flatMap((shot) => shot.assetVersionIds),
    ...timeline.audioCues.map((cue) => cue.assetVersionId),
  ]));
}
