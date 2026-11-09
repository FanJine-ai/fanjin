import express from "express";
import { z } from "zod";
import { requireProjectPermission } from "@/middleware/projectAccess";
import { success } from "@/lib/responseFormat";
import { buildExplainableAutoEdit, createEditRevisionBundle } from "../../../../../../contracts/creation/quickWorkflow";

const id = z.number().int().positive();
const clip = z.strictObject({
  videoId: id, title: z.string().max(500).optional(), duration: z.number().positive().max(86400),
  trimStart: z.number().min(0), trimEnd: z.number().positive(), volume: z.number().min(0).max(2),
}).refine(c => c.trimStart < c.trimEnd && c.trimEnd <= c.duration, "裁切范围超出素材时长");
export const bodySchema = z.strictObject({
  projectId: id,
  clips: z.array(clip).min(1).max(200).refine(cs => new Set(cs.map(c => c.videoId)).size === cs.length, "素材编号不能重复"),
  preferences: z.strictObject({
    targetDuration: z.number().positive().max(3600), pace: z.enum(["slow", "balanced", "fast"]),
    originalAudio: z.enum(["keep", "duck", "mute"]), subtitles: z.boolean(),
    soundtrackAssetVersionId: id.nullable().default(null),
    sourceSelections: z.array(z.strictObject({ videoId: id, included: z.boolean(), purpose: z.enum(["hook", "story", "proof", "cta"]), order: z.number().int().min(0) })).max(200).optional(),
  }),
});

const router = express.Router();
router.post("/", requireProjectPermission("project:read"), (req, res) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ code: "INVALID_AUTO_EDIT", message: "请检查初剪素材和偏好", errors: parsed.error.issues });
  // Like the browser, this is a pure plan over supplied clip metadata. It does
  // not read media, grant access to these IDs, save a draft or start a render.
  const { clips, preferences } = parsed.data;
  const plan = buildExplainableAutoEdit(clips, preferences);
  return res.json(success({ ...plan,
    autoEditPlan: { preferences, explanations: plan.explanations, subtitleCues: plan.subtitleCues, beatMarkers: plan.beatMarkers },
    revisionBundle: createEditRevisionBundle(clips, plan.timeline, Date.now()),
    nextOperation: "editing.draft.save", generationSubmitted: false,
  }));
});
export default router;
