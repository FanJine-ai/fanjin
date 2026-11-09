import crypto from "node:crypto";
import { z } from "zod";

export const STRUCTURED_TIMELINE_VERSION = "structured-timeline.v1" as const;
export const STRUCTURED_TIMELINE_DURATION_SECONDS = 30 as const;
export const STRUCTURED_TIMELINE_SUBMISSION_BINDING_VERSION =
  "structured-timeline-submission-binding.v1" as const;
export const STRUCTURED_TIMELINE_RELAY_CONTEXT_VERSION =
  "structured-timeline-relay-context.v1" as const;

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

const finiteTimelineSecond = z.number().finite().min(0).max(STRUCTURED_TIMELINE_DURATION_SECONDS);
const assetVersionId = z.string().trim().min(1).max(200);

const shotSchema = z.object({
  id: z.string().trim().min(1).max(80),
  title: z.string().trim().min(1).max(200),
  prompt: z.string().trim().min(1).max(2_000),
  startSeconds: finiteTimelineSecond,
  endSeconds: finiteTimelineSecond,
  assetVersionIds: z.array(assetVersionId).max(12).default([]),
}).strict().superRefine((shot, context) => {
  if (shot.endSeconds - shot.startSeconds < 0.1) {
    context.addIssue({
      code: "custom",
      path: ["endSeconds"],
      message: "镜头时长至少为 0.1 秒",
    });
  }
  if (new Set(shot.assetVersionIds).size !== shot.assetVersionIds.length) {
    context.addIssue({
      code: "custom",
      path: ["assetVersionIds"],
      message: "同一镜头不能重复引用同一素材版本",
    });
  }
});

const audioCueSchema = z.object({
  id: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(200),
  assetVersionId,
  startSeconds: finiteTimelineSecond,
  endSeconds: finiteTimelineSecond,
  sourceStartSeconds: z.number().finite().min(0).max(24 * 60 * 60).default(0),
  volume: z.number().finite().min(0).max(2).default(1),
}).strict().superRefine((cue, context) => {
  if (cue.endSeconds - cue.startSeconds < 0.05) {
    context.addIssue({
      code: "custom",
      path: ["endSeconds"],
      message: "音频卡点时长至少为 0.05 秒",
    });
  }
});

export const structuredThirtySecondTimelineSchema = z.object({
  version: z.literal(STRUCTURED_TIMELINE_VERSION),
  durationSeconds: z.literal(STRUCTURED_TIMELINE_DURATION_SECONDS),
  shots: z.array(shotSchema).min(1).max(30),
  audioCues: z.array(audioCueSchema).max(50).default([]),
}).strict().superRefine((timeline, context) => {
  const shotIds = new Set<string>();
  let cursor = 0;
  timeline.shots.forEach((shot, index) => {
    if (shotIds.has(shot.id)) {
      context.addIssue({
        code: "custom",
        path: ["shots", index, "id"],
        message: "镜头 ID 不能重复",
      });
    }
    shotIds.add(shot.id);

    if (Math.abs(shot.startSeconds - cursor) > 1e-6) {
      context.addIssue({
        code: "custom",
        path: ["shots", index, "startSeconds"],
        message: "镜头必须从 0 秒开始且连续排列，不能重叠或留空",
      });
    }
    cursor = shot.endSeconds;
  });
  if (Math.abs(cursor - STRUCTURED_TIMELINE_DURATION_SECONDS) > 1e-6) {
    context.addIssue({
      code: "custom",
      path: ["shots", Math.max(0, timeline.shots.length - 1), "endSeconds"],
      message: "最后一个镜头必须在 30 秒结束",
    });
  }

  const cueIds = new Set<string>();
  timeline.audioCues.forEach((cue, index) => {
    if (cueIds.has(cue.id)) {
      context.addIssue({
        code: "custom",
        path: ["audioCues", index, "id"],
        message: "音频卡点 ID 不能重复",
      });
    }
    cueIds.add(cue.id);
  });
});

export type StructuredThirtySecondTimeline = z.infer<typeof structuredThirtySecondTimelineSchema>;

const structuredTimelineAudioTrimBindingSchema = z.object({
  assetVersionId,
  startMs: z.number().int().min(0),
  endMs: z.number().int().positive(),
}).strict().refine((trim) => trim.endMs > trim.startMs, {
  message: "音频裁剪结束时间必须大于开始时间",
  path: ["endMs"],
});

const structuredTimelineTrackBindingSchema = z.object({
  trackId: z.number().int().positive(),
  shotId: z.string().trim().min(1).max(80),
  shotIndex: z.number().int().min(0).max(29),
  promptDigest: sha256,
  durationMs: z.number().int().positive().max(30_000),
  referenceDigest: sha256,
  assetVersionIds: z.array(assetVersionId).max(62),
  audioTrims: z.array(structuredTimelineAudioTrimBindingSchema).max(50),
}).strict();

export const structuredTimelineSubmissionBindingSchema = z.object({
  version: z.literal(STRUCTURED_TIMELINE_SUBMISSION_BINDING_VERSION),
  timelineVersion: z.literal(STRUCTURED_TIMELINE_VERSION),
  timelineDigest: sha256,
  requestHash: sha256,
  trackCount: z.number().int().min(1).max(30),
  tracks: z.array(structuredTimelineTrackBindingSchema).min(1).max(30),
}).strict().superRefine((binding, context) => {
  if (binding.trackCount !== binding.tracks.length) {
    context.addIssue({
      code: "custom",
      path: ["trackCount"],
      message: "时间线绑定的镜头数量不一致",
    });
  }
  const trackIds = binding.tracks.map((track) => track.trackId);
  const shotIds = binding.tracks.map((track) => track.shotId);
  if (new Set(trackIds).size !== trackIds.length) {
    context.addIssue({ code: "custom", path: ["tracks"], message: "时间线绑定包含重复 Track ID" });
  }
  if (new Set(shotIds).size !== shotIds.length) {
    context.addIssue({ code: "custom", path: ["tracks"], message: "时间线绑定包含重复镜头 ID" });
  }
  binding.tracks.forEach((track, index) => {
    if (track.shotIndex !== index) {
      context.addIssue({
        code: "custom",
        path: ["tracks", index, "shotIndex"],
        message: "时间线绑定的镜头顺序不连续",
      });
    }
    if (new Set(track.assetVersionIds).size !== track.assetVersionIds.length) {
      context.addIssue({
        code: "custom",
        path: ["tracks", index, "assetVersionIds"],
        message: "时间线绑定包含重复素材版本",
      });
    }
  });
});

export type StructuredTimelineTrackBinding = z.infer<typeof structuredTimelineTrackBindingSchema>;
export type StructuredTimelineSubmissionBinding = z.infer<typeof structuredTimelineSubmissionBindingSchema>;

export const structuredTimelineRelayContextSchema = z.object({
  version: z.literal(STRUCTURED_TIMELINE_RELAY_CONTEXT_VERSION),
  timelineVersion: z.literal(STRUCTURED_TIMELINE_VERSION),
  timelineDigest: sha256,
  requestHash: sha256,
  trackCount: z.number().int().min(1).max(30),
  track: structuredTimelineTrackBindingSchema,
  canonicalRequestDigest: sha256,
}).strict();

export type StructuredTimelineRelayContext = z.infer<typeof structuredTimelineRelayContextSchema>;

type StructuredTimelineTrackRequest = {
  trackId: number;
  prompt: string;
  duration: number;
  references?: Array<{
    assetVersionId: string;
    role?: string;
    mediaType?: string;
    order?: number;
    trim?: { startMs: number; endMs: number };
  }>;
};

export class StructuredTimelineError extends Error {
  readonly code = "structured_timeline_invalid";
  readonly issues: z.ZodIssue[];

  constructor(issues: z.ZodIssue[]) {
    super(issues[0]?.message || "30 秒结构化时间线无效");
    this.name = "StructuredTimelineError";
    this.issues = issues;
  }
}

function stableJson(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (!input || typeof input !== "object") return input;
    return Object.fromEntries(Object.entries(input as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, normalize(item)]));
  };
  return JSON.stringify(normalize(value));
}

function digest(value: unknown): string {
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex");
}

export function structuredTimelineTextDigest(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function exactTimelineMilliseconds(value: number, path: Array<string | number>): number {
  const milliseconds = Math.round(value * 1_000);
  if (Math.abs(milliseconds / 1_000 - value) > 1e-6) {
    throw new StructuredTimelineError([{
      code: "custom",
      path,
      message: "30 秒时间线仅支持毫秒精度",
    }]);
  }
  return milliseconds;
}

function mismatch(path: Array<string | number>, message: string): never {
  throw new StructuredTimelineError([{ code: "custom", path, message }]);
}

function normalizedReferenceForDigest(
  reference: NonNullable<StructuredTimelineTrackRequest["references"]>[number],
): Record<string, unknown> {
  return {
    assetVersionId: reference.assetVersionId,
    ...(reference.role === undefined ? {} : { role: reference.role }),
    ...(reference.mediaType === undefined ? {} : { mediaType: reference.mediaType }),
    ...(reference.order === undefined ? {} : { order: reference.order }),
    ...(reference.trim === undefined ? {} : {
      trim: { startMs: reference.trim.startMs, endMs: reference.trim.endMs },
    }),
  };
}

/**
 * Proves that the per-track HTTP representation is an exact materialization of
 * the server-parsed 30 second timeline. Roles/order may be chosen by the model
 * input-slot resolver, but no asset, prompt, duration or audio trim may be
 * added, removed or changed here.
 */
export function bindStructuredTimelineTracks(input: {
  timeline: StructuredThirtySecondTimeline;
  tracks: StructuredTimelineTrackRequest[];
}): StructuredTimelineTrackBinding[] {
  if (input.timeline.shots.length !== input.tracks.length) {
    mismatch(["trackData"], "30 秒时间线与提交镜头数量不一致");
  }
  return input.timeline.shots.map((shot, shotIndex) => {
    const track = input.tracks[shotIndex];
    if (!track || track.prompt !== shot.prompt) {
      mismatch(["trackData", shotIndex, "prompt"], `镜头 ${shotIndex + 1} 的提示词与 30 秒时间线不一致`);
    }
    const durationMs = exactTimelineMilliseconds(
      shot.endSeconds - shot.startSeconds,
      ["structuredTimeline", "shots", shotIndex, "endSeconds"],
    );
    if (
      exactTimelineMilliseconds(track.duration, ["trackData", shotIndex, "duration"])
      !== durationMs
    ) {
      mismatch(["trackData", shotIndex, "duration"], `镜头 ${shotIndex + 1} 的时长与 30 秒时间线不一致`);
    }

    const overlappingAudio = input.timeline.audioCues.filter((cue) => (
      cue.endSeconds > shot.startSeconds && cue.startSeconds < shot.endSeconds
    ));
    const overlappingAudioIds = overlappingAudio.map((cue) => cue.assetVersionId);
    if (new Set(overlappingAudioIds).size !== overlappingAudioIds.length) {
      mismatch(
        ["structuredTimeline", "audioCues"],
        `镜头 ${shotIndex + 1} 对同一音频素材存在多个重叠裁剪，无法唯一绑定`,
      );
    }
    const expectedIds = [...shot.assetVersionIds, ...overlappingAudioIds];
    if (new Set(expectedIds).size !== expectedIds.length) {
      mismatch(
        ["structuredTimeline", "shots", shotIndex, "assetVersionIds"],
        `镜头 ${shotIndex + 1} 的画面与音频素材版本不能重复`,
      );
    }
    const references = track.references ?? [];
    const actualIds = references.map((reference) => reference.assetVersionId);
    if (
      actualIds.length !== expectedIds.length
      || new Set(actualIds).size !== actualIds.length
      || expectedIds.some((id) => !actualIds.includes(id))
    ) {
      mismatch(["trackData", shotIndex, "references"], `镜头 ${shotIndex + 1} 的参考素材与 30 秒时间线不一致`);
    }

    for (const visualAssetVersionId of shot.assetVersionIds) {
      const reference = references.find((item) => item.assetVersionId === visualAssetVersionId);
      if (!reference || reference.trim !== undefined || reference.mediaType === "audio") {
        mismatch(
          ["trackData", shotIndex, "references"],
          `镜头 ${shotIndex + 1} 的画面素材裁剪或媒体类型与时间线不一致`,
        );
      }
    }

    const audioTrims = overlappingAudio.map((cue) => {
      const overlapStart = Math.max(cue.startSeconds, shot.startSeconds);
      const overlapEnd = Math.min(cue.endSeconds, shot.endSeconds);
      const sourceStartSeconds = cue.sourceStartSeconds + (overlapStart - cue.startSeconds);
      const expected = {
        assetVersionId: cue.assetVersionId,
        startMs: Math.round(sourceStartSeconds * 1_000),
        endMs: Math.round((sourceStartSeconds + overlapEnd - overlapStart) * 1_000),
      };
      const reference = references.find((item) => item.assetVersionId === cue.assetVersionId);
      if (
        !reference
        || reference.mediaType !== "audio"
        || !reference.trim
        || reference.trim.startMs !== expected.startMs
        || reference.trim.endMs !== expected.endMs
      ) {
        mismatch(
          ["trackData", shotIndex, "references"],
          `镜头 ${shotIndex + 1} 的音频裁剪与 30 秒时间线不一致`,
        );
      }
      return expected;
    });

    return {
      trackId: track.trackId,
      shotId: shot.id,
      shotIndex,
      promptDigest: structuredTimelineTextDigest(shot.prompt),
      durationMs,
      referenceDigest: digest(references.map(normalizedReferenceForDigest)),
      assetVersionIds: expectedIds,
      audioTrims,
    };
  });
}

export function structuredThirtySecondTimelineDigest(
  timeline: StructuredThirtySecondTimeline,
): string {
  return digest(parseStructuredThirtySecondTimeline(timeline));
}

export function createStructuredTimelineSubmissionBinding(input: {
  timeline: StructuredThirtySecondTimeline;
  tracks: StructuredTimelineTrackRequest[];
  canonicalRequestDigests: string[];
  workspaceId: string;
  projectId: number;
  scriptId: number;
  model: string;
  resolution: string;
  audio: boolean;
}): StructuredTimelineSubmissionBinding {
  const timeline = parseStructuredThirtySecondTimeline(input.timeline);
  const tracks = bindStructuredTimelineTracks({ timeline, tracks: input.tracks });
  if (
    input.canonicalRequestDigests.length !== tracks.length
    || input.canonicalRequestDigests.some((item) => !sha256.safeParse(item).success)
  ) {
    mismatch(["trackData"], "30 秒时间线缺少完整的统一请求摘要");
  }
  const timelineDigest = structuredThirtySecondTimelineDigest(timeline);
  const requestHash = digest({
    version: STRUCTURED_TIMELINE_SUBMISSION_BINDING_VERSION,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    scriptId: input.scriptId,
    model: input.model,
    resolution: input.resolution,
    audio: input.audio,
    timelineDigest,
    tracks: tracks.map((track, index) => ({
      ...track,
      canonicalRequestDigest: input.canonicalRequestDigests[index],
    })),
  });
  return parseStructuredTimelineSubmissionBinding({
    version: STRUCTURED_TIMELINE_SUBMISSION_BINDING_VERSION,
    timelineVersion: timeline.version,
    timelineDigest,
    requestHash,
    trackCount: tracks.length,
    tracks,
  });
}

export function parseStructuredTimelineSubmissionBinding(
  value: unknown,
): StructuredTimelineSubmissionBinding {
  const parsed = structuredTimelineSubmissionBindingSchema.safeParse(value);
  if (!parsed.success) throw new StructuredTimelineError(parsed.error.issues);
  return parsed.data;
}

export function createStructuredTimelineRelayContext(input: {
  binding: StructuredTimelineSubmissionBinding;
  trackId: number;
  canonicalRequestDigest: string;
}): StructuredTimelineRelayContext {
  const binding = parseStructuredTimelineSubmissionBinding(input.binding);
  const track = binding.tracks.find((item) => item.trackId === input.trackId);
  if (!track) mismatch(["trackId"], "Relay 任务不属于当前 30 秒时间线");
  return parseStructuredTimelineRelayContext({
    version: STRUCTURED_TIMELINE_RELAY_CONTEXT_VERSION,
    timelineVersion: binding.timelineVersion,
    timelineDigest: binding.timelineDigest,
    requestHash: binding.requestHash,
    trackCount: binding.trackCount,
    track,
    canonicalRequestDigest: input.canonicalRequestDigest,
  });
}

export function parseStructuredTimelineRelayContext(
  value: unknown,
): StructuredTimelineRelayContext {
  const parsed = structuredTimelineRelayContextSchema.safeParse(value);
  if (!parsed.success) throw new StructuredTimelineError(parsed.error.issues);
  return parsed.data;
}

export function parseStructuredThirtySecondTimeline(
  value: unknown,
): StructuredThirtySecondTimeline {
  const parsed = structuredThirtySecondTimelineSchema.safeParse(value);
  if (!parsed.success) throw new StructuredTimelineError(parsed.error.issues);
  return parsed.data;
}

export function referencedTimelineAssetVersionIds(
  timeline: StructuredThirtySecondTimeline,
): string[] {
  return Array.from(new Set([
    ...timeline.shots.flatMap((shot) => shot.assetVersionIds),
    ...timeline.audioCues.map((cue) => cue.assetVersionId),
  ])).sort();
}

/**
 * A timeline can only reference versions already bound to the CreationSession.
 * This prevents a hidden timeline payload from bypassing the session's visible
 * asset selection and keeps workspace/project authorization at the existing
 * asset-resolution boundary.
 */
export function assertTimelineAssetsSelected(input: {
  timeline: StructuredThirtySecondTimeline;
  selectedAssetVersionIds: string[];
}): void {
  const selected = new Set(input.selectedAssetVersionIds.map((id) => id.trim()).filter(Boolean));
  const missing = referencedTimelineAssetVersionIds(input.timeline)
    .filter((id) => !selected.has(id));
  if (!missing.length) return;
  throw new StructuredTimelineError([{
    code: "custom",
    path: ["structuredTimeline"],
    message: `时间线引用了未选中的素材版本：${missing.join("、")}`,
  }]);
}

export function validateStructuredTimelineParameters(input: {
  parameters: Record<string, unknown>;
  selectedAssetVersionIds: string[];
}): Record<string, unknown> {
  if (!Object.prototype.hasOwnProperty.call(input.parameters, "structuredTimeline")) {
    return input.parameters;
  }
  // `null` is the cross-version clear marker used by Quick Create. Older
  // clients always included the key before a timeline existed, while newer
  // clients only send it when clearing a previously persisted timeline. In
  // both cases the durable representation is absence, not an invalid object.
  if (input.parameters.structuredTimeline == null) {
    const { structuredTimeline: _cleared, ...parameters } = input.parameters;
    return parameters;
  }
  const timeline = parseStructuredThirtySecondTimeline(input.parameters.structuredTimeline);
  assertTimelineAssetsSelected({ timeline, selectedAssetVersionIds: input.selectedAssetVersionIds });
  return { ...input.parameters, structuredTimeline: timeline };
}
