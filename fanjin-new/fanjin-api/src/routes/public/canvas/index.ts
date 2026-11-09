import express from "express";

import {
  CanvasPublicationError,
  getPublicCanvasShare,
  getPublicFjtvPublication,
  listPublicFjtv,
} from "@/lib/canvasPublication";
import { success } from "@/lib/responseFormat";
import { db } from "@/utils/db";

const router = express.Router();

// Shares can be revoked and publications can be taken down at any time.
router.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  next();
});

function sendFailure(res: express.Response, error: unknown) {
  if (error instanceof CanvasPublicationError) {
    return res.status(error.status).send({ code: error.code, message: error.message });
  }
  console.error("[public-canvas] request failed", error);
  return res.status(500).send({ code: "PUBLIC_CANVAS_FAILED", message: "公开作品服务暂时不可用" });
}

router.get("/shares/:slug", async (req, res) => {
  try {
    const share = await getPublicCanvasShare(db, req.params.slug);
    return res.status(200).send(success({ share }));
  } catch (error) {
    return sendFailure(res, error);
  }
});

router.get("/fjtv", async (req, res) => {
  try {
    const publications = await listPublicFjtv(db, req.query.limit);
    return res.status(200).send(success({ publications }));
  } catch (error) {
    return sendFailure(res, error);
  }
});

router.get("/fjtv/:slug", async (req, res) => {
  try {
    const publication = await getPublicFjtvPublication(db, req.params.slug);
    return res.status(200).send(success({ publication }));
  } catch (error) {
    return sendFailure(res, error);
  }
});

export default router;
