import express, { type Request } from "express";
import { z } from "zod";

import {
  addProjectAssetReference,
  AssetLibraryError,
  grantAssetAccess,
  listAssetGrants,
  listAssetLibrary,
  removeProjectAssetReference,
  revokeAssetGrant,
  transferAssetToWorkspace,
  type AssetLibraryView,
} from "@/lib/accountWorkspaceAssetLibrary";
import { success } from "@/lib/responseFormat";
import { MembershipError } from "@/lib/membershipCatalog";
import { recommendAuthorizedAssets } from "@/lib/assetRecommendations";
import { requireProjectPermission } from "@/middleware/projectAccess";
import { db } from "@/utils/db";
import u from "@/utils";

const router = express.Router();
const viewSchema = z.enum(["mine", "workspace", "shared_with_me", "project_refs", "all"]);
const grantSchema = z.object({
  granteeType: z.enum(["workspace", "user"]),
  granteeUserId: z.number().int().positive().optional().nullable(),
  canView: z.boolean().optional(),
  canUse: z.boolean().optional(),
  canManage: z.boolean().optional(),
  expectedOwnershipRevision: z.number().int().positive().optional(),
});
const projectRefSchema = z.object({
  assetId: z.number().int().positive(),
  assetVersionId: z.string().trim().min(1).max(256).optional().nullable(),
  expectedOwnershipRevision: z.number().int().positive().optional(),
});
const transferSchema = z.object({ expectedRevision: z.number().int().positive() });
const exactAssetIdsSchema = z.array(z.coerce.number().int().positive()).max(8);
const exactAssetVersionsSchema = z.array(z.string().regex(/^\d+:\d+$/)).max(8);

function exactAssetIds(req: Request): number[] | undefined {
  const raw = req.query.assetId;
  if (raw == null) return undefined;
  const values = (Array.isArray(raw) ? raw : [raw])
    .flatMap((value) => String(value).split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set(exactAssetIdsSchema.parse(values))];
}

function exactAssetVersions(req: Request): Array<{ assetId: number; assetVersionId: number }> | undefined {
  const raw = req.query.assetVersion;
  if (raw == null) return undefined;
  const values = (Array.isArray(raw) ? raw : [raw])
    .flatMap((value) => String(value).split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  const parsed = exactAssetVersionsSchema.parse(values).map((value) => {
    const [assetId, assetVersionId] = value.split(":").map(Number);
    return { assetId, assetVersionId };
  });
  return [...new Map(parsed.map((identity) => [
    `${identity.assetId}:${identity.assetVersionId}`,
    identity,
  ])).values()];
}

function identity(req: Request) {
  const actorUserId = Number((req as any).auth?.user?.id || (req as any).user?.id || 0);
  const workspaceId = String((req as any).auth?.workspaceId || "").trim();
  if (!Number.isSafeInteger(actorUserId) || actorUserId <= 0 || !workspaceId) {
    throw new AssetLibraryError("ASSET_LIBRARY_AUTH_REQUIRED", "请先登录并选择工作区", 401);
  }
  return { actorUserId, workspaceId };
}

function idempotencyKey(req: Request): string {
  const value = String(req.get("Idempotency-Key") || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)) {
    throw new AssetLibraryError(
      "ASSET_LIBRARY_IDEMPOTENCY_KEY_REQUIRED",
      "Idempotency-Key 缺失或格式无效",
      400,
    );
  }
  return value;
}

function sendError(res: express.Response, error: unknown) {
  if (error instanceof AssetLibraryError || error instanceof MembershipError) {
    return res.status(error.status).send({ code: error.code, message: error.message });
  }
  throw error;
}

router.get("/", async (req, res) => {
  try {
    const { actorUserId, workspaceId } = identity(req);
    const view = viewSchema.parse(req.query.view || "all") as AssetLibraryView;
    const projectId = req.query.projectId == null ? null : Number(req.query.projectId);
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
    const result = await listAssetLibrary({
      database: db,
      workspaceId,
      actorUserId,
      view,
      assetIds: exactAssetIds(req),
      assetVersions: exactAssetVersions(req),
      projectId,
      type: req.query.type == null ? null : String(req.query.type),
      name: req.query.name == null ? null : String(req.query.name),
      limit,
      offset: (page - 1) * limit,
    });
    const items = await Promise.all(result.items.map(async (item: any) => ({
      ...item,
      src: item.filePath
        ? (["role", "tool", "scene"].includes(String(item.type))
            ? await u.oss.getSmallImageUrl(String(item.filePath))
            : await u.oss.getFileUrl(String(item.filePath)))
        : null,
    })));
    return res.status(200).send(success({ ...result, items }));
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).send({ code: "ASSET_LIBRARY_INPUT_INVALID", message: "资产库查询参数无效" });
    }
    return sendError(res, error);
  }
});

router.get("/recommendations", requireProjectPermission("project:read"), async (req, res) => {
  try {
    const { actorUserId, workspaceId } = identity(req);
    const projectId = z.coerce.number().int().positive().parse(req.query.projectId);
    const limit = z.coerce.number().int().min(1).max(20).optional().parse(req.query.limit);
    const query = z.string().max(500).optional().parse(req.query.query);
    const context = z.string().max(120).optional().parse(req.query.context);
    const catalog = await listAssetLibrary({
      database: db,
      workspaceId,
      actorUserId,
      view: "all",
      projectId,
      limit: 200,
      offset: 0,
    });
    const recommendations = recommendAuthorizedAssets({
      projectId,
      query,
      context,
      limit,
      candidates: catalog.items,
    });
    return res.status(200).send(success({
      recommendations,
      trace: {
        projectId,
        ruleVersion: "asset-metadata-literal-v1",
        authorization: "filtered_before_ranking",
        billing: { mode: "retrieval_only", chargeMicros: 0 },
      },
    }));
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).send({ code: "ASSET_RECOMMENDATION_INPUT_INVALID", message: "资产推荐参数无效" });
    }
    return sendError(res, error);
  }
});

router.get("/:assetId/grants", async (req, res) => {
  try {
    const { actorUserId, workspaceId } = identity(req);
    const grants = await listAssetGrants({
      database: db,
      workspaceId,
      actorUserId,
      assetId: Number(req.params.assetId),
      includeRevoked: String(req.query.includeRevoked || "") === "true",
    });
    return res.status(200).send(success({ grants }));
  } catch (error) {
    return sendError(res, error);
  }
});

router.post("/:assetId/grants", async (req, res) => {
  try {
    const { actorUserId, workspaceId } = identity(req);
    const body = grantSchema.parse(req.body || {});
    const grant = await grantAssetAccess({
      database: db,
      workspaceId,
      actorUserId,
      assetId: Number(req.params.assetId),
      ...body,
      idempotencyKey: idempotencyKey(req),
    });
    return res.status(200).send(success({ grant }));
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).send({ code: "ASSET_LIBRARY_INPUT_INVALID", message: "资产分享参数无效" });
    }
    return sendError(res, error);
  }
});

router.delete("/:assetId/grants/:grantId", async (req, res) => {
  try {
    const { actorUserId, workspaceId } = identity(req);
    const grant = await revokeAssetGrant({
      database: db,
      workspaceId,
      actorUserId,
      assetId: Number(req.params.assetId),
      grantId: req.params.grantId,
      expectedRevision: req.query.expectedRevision == null
        ? null
        : Number(req.query.expectedRevision),
      idempotencyKey: idempotencyKey(req),
    });
    return res.status(200).send(success({ grant }));
  } catch (error) {
    return sendError(res, error);
  }
});

router.post("/:assetId/transfer-to-workspace", async (req, res) => {
  try {
    const { actorUserId, workspaceId } = identity(req);
    const body = transferSchema.parse(req.body || {});
    const ownership = await transferAssetToWorkspace({
      database: db,
      workspaceId,
      actorUserId,
      assetId: Number(req.params.assetId),
      expectedRevision: body.expectedRevision,
      idempotencyKey: idempotencyKey(req),
    });
    return res.status(200).send(success({ ownership }));
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).send({ code: "ASSET_LIBRARY_INPUT_INVALID", message: "资产归属转移参数无效" });
    }
    return sendError(res, error);
  }
});

router.post(
  "/projects/:projectId/refs",
  requireProjectPermission("project:write"),
  async (req, res) => {
    try {
      const { actorUserId, workspaceId } = identity(req);
      const body = projectRefSchema.parse(req.body || {});
      const ref = await addProjectAssetReference({
        database: db,
        workspaceId,
        actorUserId,
        projectId: Number(req.params.projectId),
        assetId: body.assetId,
        assetVersionId: body.assetVersionId,
        expectedOwnershipRevision: body.expectedOwnershipRevision,
        idempotencyKey: idempotencyKey(req),
      });
      return res.status(200).send(success({ ref }));
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).send({ code: "ASSET_LIBRARY_INPUT_INVALID", message: "项目资产引用参数无效" });
      }
      return sendError(res, error);
    }
  },
);

router.delete(
  "/projects/:projectId/refs/:refId",
  requireProjectPermission("project:write"),
  async (req, res) => {
    try {
      const { actorUserId, workspaceId } = identity(req);
      const ref = await removeProjectAssetReference({
        database: db,
        workspaceId,
        actorUserId,
        projectId: Number(req.params.projectId),
        refId: String(req.params.refId),
        expectedRevision: req.query.expectedRevision == null
          ? null
          : Number(req.query.expectedRevision),
        idempotencyKey: idempotencyKey(req),
      });
      return res.status(200).send(success({ ref }));
    } catch (error) {
      return sendError(res, error);
    }
  },
);

export default router;
