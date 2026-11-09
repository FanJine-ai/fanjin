import express from "express";
import { z } from "zod";

import {
  CanvasPublicationError,
  createCanvasShare,
  listCanvasShares,
  listOwnFjtvPublications,
  revokeCanvasShare,
  submitFjtvPublication,
} from "@/lib/canvasPublication";
import { success } from "@/lib/responseFormat";
import { requireProjectPermission } from "@/middleware/projectAccess";
import { db } from "@/utils/db";

const router = express.Router();
const positiveInteger = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const scopeSchema = z.object({
  projectId: positiveInteger,
  canvasId: positiveInteger,
}).strict();
export const createShareSchema = scopeSchema.extend({
  expectedRevision: positiveInteger,
  idempotencyKey: z.string().trim().min(8).max(200),
  title: z.string().trim().max(500).optional(),
  expiresAt: z.coerce.number().int().positive().optional().nullable(),
}).strict();
export const createPublicationSchema = scopeSchema.extend({
  expectedRevision: positiveInteger,
  idempotencyKey: z.string().trim().min(8).max(200),
  title: z.string().trim().max(500).optional(),
  description: z.string().trim().max(5_000).optional(),
  coverUrl: z.string().trim().url().max(8_192).optional().nullable(),
}).strict();

function authIdentity(req: express.Request) {
  const auth = (req as any).auth ?? {};
  const user = auth.user ?? (req as any).user ?? {};
  return {
    workspaceId: String(auth.workspaceId || (req as any).project?.workspaceId || "").trim(),
    userId: Number(user.id || 0),
  };
}

function sendFailure(res: express.Response, error: unknown) {
  if (error instanceof CanvasPublicationError) {
    return res.status(error.status).send({ code: error.code, message: error.message });
  }
  console.error("[canvas-publication] request failed", error);
  return res.status(500).send({ code: "CANVAS_PUBLICATION_FAILED", message: "画布发布服务暂时不可用" });
}

router.get("/shares", requireProjectPermission("project:read"), async (req, res) => {
  const parsed = scopeSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  try {
    const identity = authIdentity(req);
    const shares = await listCanvasShares(db, { ...identity, ...parsed.data });
    return res.status(200).send(success({ shares }));
  } catch (error) {
    return sendFailure(res, error);
  }
});

router.post("/shares", requireProjectPermission("project:write"), async (req, res) => {
  const parsed = createShareSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  try {
    const share = await createCanvasShare(db, { ...authIdentity(req), ...parsed.data });
    return res.status(201).send(success({ share }));
  } catch (error) {
    return sendFailure(res, error);
  }
});

router.delete("/shares/:shareId", requireProjectPermission("project:write"), async (req, res) => {
  const parsed = z.object({
    projectId: positiveInteger,
    expectedRevision: positiveInteger,
  }).strict().safeParse(req.query);
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  try {
    const share = await revokeCanvasShare(db, {
      ...authIdentity(req),
      ...parsed.data,
      shareId: req.params.shareId,
    });
    return res.status(200).send(success({ share }));
  } catch (error) {
    return sendFailure(res, error);
  }
});

router.get("/fjtv", requireProjectPermission("project:read"), async (req, res) => {
  const parsed = scopeSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  try {
    const publications = await listOwnFjtvPublications(db, { ...authIdentity(req), ...parsed.data });
    return res.status(200).send(success({ publications }));
  } catch (error) {
    return sendFailure(res, error);
  }
});

router.post("/fjtv", requireProjectPermission("project:write"), async (req, res) => {
  const parsed = createPublicationSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  try {
    const publication = await submitFjtvPublication(db, { ...authIdentity(req), ...parsed.data });
    return res.status(201).send(success({ publication }));
  } catch (error) {
    return sendFailure(res, error);
  }
});

export default router;
