import { z } from "zod";

export const generationSubmitAssetSchema = z.object({
  mediaAssetId: z.string().min(1),
  assetId: z.number().int().positive(),
  assetVersionId: z.number().int().positive(),
  url: z.string().min(1),
  mirrored: z.boolean(),
}).strict();

export const generationSubmitReviewSchema = z.object({
  reviewId: z.string().min(1),
  engine: z.string().min(1),
  verdict: z.enum(["pass", "attention"]),
}).strict().nullable();

export const generationImageSubmitOutputSchema = z.object({
  status: z.enum(["succeeded", "failed", "unavailable"]),
  code: z.string().min(1).nullable(),
  message: z.string().min(1).nullable(),
  generationType: z.literal("image"),
  quoteId: z.string().min(1).nullable(),
  provider: z.string().min(1).nullable(),
  model: z.string().min(1),
  units: z.number().int().positive(),
  size: z.string().min(1).nullable(),
  assets: z.array(generationSubmitAssetSchema).max(10),
  review: generationSubmitReviewSchema,
}).strict();

export const generationVideoSubmitOutputSchema = z.object({
  status: z.enum(["succeeded", "failed", "unavailable"]),
  code: z.string().min(1).nullable(),
  message: z.string().min(1).nullable(),
  generationType: z.literal("video"),
  quoteId: z.string().min(1).nullable(),
  provider: z.string().min(1).nullable(),
  model: z.string().min(1),
  units: z.literal(1),
  task: z.object({
    taskId: z.string().min(1),
    status: z.string().min(1),
    requestId: z.string().min(1).nullable(),
  }).strict().nullable(),
  assetVersionId: z.number().int().positive().nullable(),
  review: generationSubmitReviewSchema,
}).strict();

export type GenerationSubmitReviewSummary =
  z.infer<typeof generationSubmitReviewSchema>;
export type GenerationImageSubmitOutput =
  z.infer<typeof generationImageSubmitOutputSchema>;
export type GenerationVideoSubmitOutput =
  z.infer<typeof generationVideoSubmitOutputSchema>;
