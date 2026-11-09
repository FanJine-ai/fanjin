import { z } from "zod";

export const EDITOR_TIMELINE_V2_VERSION = "editor-timeline.v2" as const;
export const EDITOR_TIMELINE_V2_MAX_CLIPS = 100;
export const EDITOR_TIMELINE_V2_MAX_SECONDS = 24 * 60 * 60;

const boundedSecondsSchema = z.number()
  .finite()
  .min(0)
  .max(EDITOR_TIMELINE_V2_MAX_SECONDS);

export const editorTimelineV2ClipSchema = z.object({
  videoId: z.number().int().positive(),
  trimStartSeconds: boundedSecondsSchema,
  trimEndSeconds: boundedSecondsSchema,
  speed: z.number().finite().min(0.25).max(4),
  volume: z.number().finite().min(0).max(2),
}).strict().superRefine((clip, context) => {
  if (clip.trimEndSeconds <= clip.trimStartSeconds) {
    context.addIssue({
      code: "custom",
      path: ["trimEndSeconds"],
      message: "出点必须晚于入点",
    });
  }
});

export const editorTimelineV2Schema = z.object({
  version: z.literal(EDITOR_TIMELINE_V2_VERSION),
  // An empty timeline is a valid editable draft (for example after the user
  // intentionally removes every clip). The final-render route still requires
  // at least one clip before any media work can start.
  timeline: z.array(editorTimelineV2ClipSchema)
    .max(EDITOR_TIMELINE_V2_MAX_CLIPS),
  soundtrack: z.object({
    assetVersionId: z.number().int().positive().nullable(),
    volume: z.number().finite().min(0).max(2),
  }).strict(),
  savedAt: z.number().int().nonnegative(),
  // Quick mode keeps its explainable first-cut metadata alongside the
  // canonical Timeline v2 fields. The request body already has a strict byte
  // ceiling; readers additionally validate these optional structures before
  // exposing them in the editor.
  revisions: z.unknown().optional(),
  autoEditPlan: z.unknown().optional(),
  autoEditPreferences: z.unknown().optional(),
}).strict().superRefine((draft, context) => {
  const seenVideoIds = new Set<number>();
  let renderedDurationSeconds = 0;
  draft.timeline.forEach((clip, index) => {
    if (seenVideoIds.has(clip.videoId)) {
      context.addIssue({
        code: "custom",
        path: ["timeline", index, "videoId"],
        message: "同一视频不能在成片时间线中重复出现",
      });
    }
    seenVideoIds.add(clip.videoId);
    renderedDurationSeconds += (
      clip.trimEndSeconds - clip.trimStartSeconds
    ) / clip.speed;
  });
  if (renderedDurationSeconds > EDITOR_TIMELINE_V2_MAX_SECONDS) {
    context.addIssue({
      code: "custom",
      path: ["timeline"],
      message: "变速后的成片时长超过 24 小时上限",
    });
  }
});

export type EditorTimelineV2 = z.infer<typeof editorTimelineV2Schema>;

export function isEditorTimelineV2Candidate(
  value: unknown,
): value is Record<string, unknown> & { version: typeof EDITOR_TIMELINE_V2_VERSION } {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && (value as Record<string, unknown>).version === EDITOR_TIMELINE_V2_VERSION,
  );
}
