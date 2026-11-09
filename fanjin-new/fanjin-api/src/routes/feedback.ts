import express from "express";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { createUserFeedback, getFeedbackAttachment, UserFeedbackError } from "@/lib/userFeedback";

const router = express.Router();
const screenshotSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp", "image/gif"]),
  dataUrl: z.string().min(1).max(Math.ceil(5 * 1024 * 1024 / 3) * 4 + 64),
}).strict();
export const payloadSchema = z.object({
  description: z.string().trim().min(2).max(4000),
  pageTitle: z.string().max(200).optional().default(""),
  pageUrl: z.string().url().max(2048),
  screenshots: z.array(screenshotSchema).max(3).optional().default([]),
}).strict();

router.post("/", async (req, res) => {
  try {
    const input = payloadSchema.parse(req.body);
    const auth = (req as any).auth || {};
    const user = auth.user || (req as any).user || {};
    const userId = Number(user.id || 0);
    const workspaceId = String(auth.workspaceId || "").trim();
    const userLabel = String(user.displayName || user.nickname || user.username || user.email || `User ${userId}`);
    const result = await createUserFeedback({ ...input, userId, workspaceId, userLabel });
    return res.status(201).send(success(result));
  } catch (caught) {
    if (caught instanceof z.ZodError) return res.status(400).send(error("Invalid feedback data"));
    if (caught instanceof UserFeedbackError) return res.status(caught.status).send(error(caught.message));
    throw caught;
  }
});

router.get("/attachments/:id", async (req, res) => {
  const auth = (req as any).auth || {};
  const user = auth.user || (req as any).user || {};
  const attachment = await getFeedbackAttachment({
    attachmentId: String(req.params.id || ""),
    actorUserId: Number(user.id || 0),
    actorWorkspaceId: String(auth.workspaceId || ""),
    actorRole: String(user.role || ""),
  });
  if (!attachment) return res.status(404).send(error("Feedback attachment not found"));
  const safeName = attachment.fileName.replace(/[\p{Cc}\p{Cf}\\/]/gu, "").slice(0, 200) || "feedback-image";
  res.set({
    "Cache-Control": "private, no-store",
    "Content-Type": attachment.mimeType,
    "Content-Disposition": `inline; filename="feedback-image"; filename*=UTF-8''${encodeURIComponent(safeName)}`,
    "X-Content-Type-Options": "nosniff",
  });
  return res.send(attachment.body);
});

export default router;
