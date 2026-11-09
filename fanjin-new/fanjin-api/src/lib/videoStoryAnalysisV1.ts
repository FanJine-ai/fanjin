import { z } from "zod";

export const VIDEO_STORY_ANALYSIS_VERSION = "video-story-analysis.v1" as const;
export const VIDEO_STORY_ANALYZER_VERSION = "ffmpeg-scene-detection.v1" as const;

const boundedText = (maximum: number) => z.string().trim().max(maximum);
const seconds = z.number().finite().min(0).max(24 * 60 * 60);

export const videoStoryShotV1Schema = z.object({
  id: z.string().uuid(),
  shot: z.number().int().positive().max(100),
  startTime: seconds,
  endTime: seconds,
  duration: seconds,
  frameTime: seconds,
  sceneConfidence: z.number().finite().min(0).max(1).nullable(),
  keyframeAssetId: z.number().int().positive(),
  keyframeAssetVersionId: z.number().int().positive(),
  keyframeUrl: boundedText(2_000),
  visualDescription: boundedText(4_000),
  narrative: boundedText(4_000),
  shotSize: boundedText(500),
  cameraAngle: boundedText(500),
  cameraMovement: boundedText(500),
  focusDepth: boundedText(500),
  lighting: boundedText(1_000),
  backgroundMusic: boundedText(1_000),
  voiceSound: boundedText(1_000),
  subtitle: boundedText(2_000),
  imagePrompt: boundedText(4_000),
  videoMotionPrompt: boundedText(4_000),
  keywords: boundedText(1_000),
}).strict().superRefine((shot, ctx) => {
  if (shot.endTime <= shot.startTime) {
    ctx.addIssue({ code: "custom", path: ["endTime"], message: "镜头结束时间必须晚于开始时间" });
  }
  if (Math.abs(shot.duration - (shot.endTime - shot.startTime)) > 0.02) {
    ctx.addIssue({ code: "custom", path: ["duration"], message: "镜头时长必须与时间码一致" });
  }
  if (shot.frameTime < shot.startTime || shot.frameTime > shot.endTime) {
    ctx.addIssue({ code: "custom", path: ["frameTime"], message: "关键帧时间必须位于镜头范围内" });
  }
});

export const videoStoryAnalysisV1Schema = z.object({
  version: z.literal(VIDEO_STORY_ANALYSIS_VERSION),
  analyzer: z.object({
    id: z.literal("ffmpeg-scene-detection"),
    version: z.literal(VIDEO_STORY_ANALYZER_VERSION),
    semanticUnderstanding: z.literal(false),
    sceneThreshold: z.number().finite().min(0).max(1),
  }).strict(),
  source: z.object({
    projectId: z.number().int().positive(),
    assetId: z.number().int().positive(),
    assetVersionId: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  }).strict(),
  title: boundedText(500),
  duration: seconds.positive(),
  width: z.number().int().positive().max(16_384),
  height: z.number().int().positive().max(16_384),
  generatedAt: z.string().datetime({ offset: true }),
  rights: z.object({
    confirmed: z.literal(true),
    confirmedAt: z.string().datetime({ offset: true }),
    confirmedByUserId: z.number().int().positive(),
  }).strict(),
  billing: z.object({
    billable: z.literal(false),
    costGu: z.literal(0),
    status: z.literal("not_applicable"),
    refundStatus: z.literal("not_applicable"),
    reason: z.literal("local_ffmpeg_analysis"),
  }).strict(),
  rows: z.array(videoStoryShotV1Schema).min(1).max(100),
}).strict().superRefine((analysis, ctx) => {
  let previousEnd = 0;
  const shotIds = new Set<string>();
  const versionIds = new Set<number>();
  analysis.rows.forEach((shot, index) => {
    if (shot.shot !== index + 1) {
      ctx.addIssue({ code: "custom", path: ["rows", index, "shot"], message: "镜号必须连续" });
    }
    if (shot.startTime < previousEnd - 0.02) {
      ctx.addIssue({ code: "custom", path: ["rows", index, "startTime"], message: "镜头时间码不能重叠" });
    }
    if (shot.endTime > analysis.duration + 0.02) {
      ctx.addIssue({ code: "custom", path: ["rows", index, "endTime"], message: "镜头时间码超出视频时长" });
    }
    if (shotIds.has(shot.id) || versionIds.has(shot.keyframeAssetVersionId)) {
      ctx.addIssue({ code: "custom", path: ["rows", index], message: "镜头或关键帧版本不能重复" });
    }
    shotIds.add(shot.id);
    versionIds.add(shot.keyframeAssetVersionId);
    previousEnd = shot.endTime;
  });
});

export type VideoStoryAnalysisV1 = z.infer<typeof videoStoryAnalysisV1Schema>;
export type VideoStoryShotV1 = z.infer<typeof videoStoryShotV1Schema>;

export function parseVideoStoryAnalysisV1(value: unknown): VideoStoryAnalysisV1 {
  return videoStoryAnalysisV1Schema.parse(value);
}
