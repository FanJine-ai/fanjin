import express from "express";
import { z } from "zod";
import {
  createCanvasAsset,
  getCanvasAsset,
  listCanvasAssets,
  updateCanvasAsset,
} from "@/lib/canvasAssetService";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { requireProjectPermission } from "@/middleware/projectAccess";

const router = express.Router();

const projectIdSchema = z.union([
  z.number().int().positive().refine(Number.isSafeInteger),
  z.string().regex(/^[1-9]\d*$/).refine((value) => Number.isSafeInteger(Number(value))),
]);
const assetIdSchema = z.string().uuid();
const assetTypeSchema = z.enum(["snapshot", "portrait"]);
const snapshotSchema = z.object({
  nodes: z.array(z.any()),
  edges: z.array(z.any()).optional(),
  bounds: z.any().optional(),
  meta: z.record(z.string(), z.any()).optional(),
}).passthrough();

function authScope(req: express.Request) {
  return {
    workspaceId: String((req as any).auth?.workspaceId || ""),
    actorUserId: Number((req as any).auth?.user?.id || 0),
  };
}

router.get(
  "/",
  validateFields({ projectId: projectIdSchema }, "query"),
  requireProjectPermission("project:read"),
  async (req, res) => {
    const { workspaceId } = authScope(req);
    const assets = await listCanvasAssets({
      workspaceId,
      projectId: Number(req.query.projectId),
    });
    return res.status(200).send(success({ assets }));
  },
);

router.post(
  "/",
  validateFields({
    projectId: projectIdSchema,
    name: z.string().trim().min(1).max(200),
    saveLocation: z.string().max(500).optional(),
    tag: z.string().max(500).optional(),
    coverUrl: z.string().max(4_000_000).optional(),
    assetType: assetTypeSchema.optional(),
    referenceAssetUri: z.string().max(4_000_000).optional(),
    nodes: z.array(z.any()),
    edges: z.array(z.any()).optional(),
    bounds: z.any().optional(),
  }),
  requireProjectPermission("project:write"),
  async (req, res) => {
    const { workspaceId, actorUserId } = authScope(req);
    const asset = await createCanvasAsset({
      workspaceId,
      projectId: Number(req.body.projectId),
      actorUserId,
      name: req.body.name.trim(),
      saveLocation: req.body.saveLocation,
      tag: req.body.tag,
      coverUrl: req.body.coverUrl,
      assetType: req.body.assetType,
      referenceAssetUri: req.body.referenceAssetUri,
      nodes: req.body.nodes,
      edges: req.body.edges,
      bounds: req.body.bounds,
    });
    return res.status(201).send(success({ asset }));
  },
);

router.patch(
  "/:assetId",
  validateFields({ assetId: assetIdSchema }, "params"),
  validateFields({
    projectId: projectIdSchema,
    name: z.string().trim().min(1).max(200).optional(),
    saveLocation: z.string().max(500).optional(),
    tag: z.string().max(500).optional(),
    coverUrl: z.string().max(4_000_000).optional(),
    assetType: assetTypeSchema.optional(),
    referenceAssetUri: z.string().max(4_000_000).nullable().optional(),
    snapshot: snapshotSchema.optional(),
  }),
  requireProjectPermission("project:write"),
  async (req, res) => {
    const patchFields = [
      "name",
      "saveLocation",
      "tag",
      "coverUrl",
      "assetType",
      "referenceAssetUri",
      "snapshot",
    ];
    if (!patchFields.some((field) => Object.prototype.hasOwnProperty.call(req.body, field))) {
      return res.status(400).send({ message: "至少提供一个可更新字段" });
    }
    const { workspaceId } = authScope(req);
    const asset = await updateCanvasAsset({
      id: String(req.params.assetId),
      workspaceId,
      projectId: Number(req.body.projectId),
      patch: {
        name: req.body.name?.trim(),
        saveLocation: req.body.saveLocation,
        tag: req.body.tag,
        coverUrl: req.body.coverUrl,
        assetType: req.body.assetType,
        referenceAssetUri: req.body.referenceAssetUri,
        snapshot: req.body.snapshot,
      },
    });
    if (!asset) return res.status(404).send({ message: "画布资产不存在" });
    return res.status(200).send(success({ asset }));
  },
);

router.delete(
  "/:assetId",
  validateFields({ assetId: assetIdSchema }, "params"),
  validateFields({ projectId: projectIdSchema }, "query"),
  requireProjectPermission("project:write"),
  async (req, res) => {
    const { workspaceId } = authScope(req);
    const asset = await getCanvasAsset({
      id: String(req.params.assetId),
      workspaceId,
      projectId: Number(req.query.projectId),
    });
    if (!asset) return res.status(404).send({ message: "画布资产不存在" });
    return res.status(501).send(
      error("画布资产删除工作流尚未上线，已拒绝同步删除", {
        code: "DELETION_ASSET_WORKFLOW_UNAVAILABLE",
      }),
    );
  },
);

export default router;
