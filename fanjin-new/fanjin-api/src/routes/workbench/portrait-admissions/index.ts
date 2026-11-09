import { preferredVolcanoPortraitChannel } from "@/lib/portraitProviderChannel";
import { resolvePortraitVideoRoutePolicy } from "@/lib/portraitVideoRoutePolicy";
import { registerPortraitAsset } from "@/lib/portraitAssetRegistration";
import { resolveProjectAssetVersion } from "@/lib/projectAssetVersion";
import express from "express";
import { z } from "zod";
import { db } from "@/utils/db";
import { error, success } from "@/lib/responseFormat";
import { requireProjectPermission } from "@/middleware/projectAccess";
import {
  PORTRAIT_DECLARATION_VERSION,
  ensurePortraitAdmissionForAsset,
  readPortraitAdmission,
} from "@/lib/portraitAdmissionStore";
import {
  declarePortraitAdmission,
  PortraitAdmissionWorkflowError,
  retryPortraitAdmissionChecks,
} from "@/lib/portraitAdmissionWorkflow";
import {
  PortraitProviderRuntimeError,
  startPortraitLivenessAuthorization,
} from "@/lib/portraitProviderRuntime";
import { writeAuditLog } from "@/lib/audit";

const router = express.Router();

router.get("/video-route-policy", requireProjectPermission("project:read"), async (req, res) => {
  const parsed = z.object({
    projectId: z.coerce.number().int().positive(),
    model: z.string().trim().min(1).max(256),
  }).safeParse(req.query);
  if (!parsed.success) return res.status(400).send(error("参数错误", { code: "portrait_request_invalid" }));
  const policy = await resolvePortraitVideoRoutePolicy(workspaceId(req), parsed.data.model);
  res.set("Cache-Control", "no-store");
  return res.status(200).send(success(policy));
});

const querySchema = z.object({
  projectId: z.coerce.number().int().positive(),
  assetVersionId: z.coerce.number().int().positive(),
});

const declarationSchema = z.object({
  projectId: z.number().int().positive(),
  assetVersionId: z.number().int().positive(),
  revision: z.number().int().positive(),
  choice: z.enum([
    "ordinary_no_person",
    "real_person_with_rights",
    "fully_virtual_person",
  ]),
  termsVersion: z.literal(PORTRAIT_DECLARATION_VERSION),
  termsAccepted: z.literal(true),
  model: z.string().trim().min(1).max(256).optional(),
  sourceTaskId: z.string().trim().min(1).max(256).optional(),
}).strict();

const retrySchema = z.object({
  projectId: z.number().int().positive(),
  assetVersionId: z.number().int().positive(),
  revision: z.number().int().positive(),
}).strict();

const authorizationSchema = z.object({
  projectId: z.number().int().positive(),
  assetVersionId: z.number().int().positive(),
  revision: z.number().int().positive(),
  identityLabel: z.string().trim().min(1).max(120),
  rightsConfirmed: z.literal(true),
}).strict();

function userId(req: express.Request): number {
  return Number((req as any).auth?.user?.id || (req as any).user?.id || 0);
}

function workspaceId(req: express.Request): string {
  return String((req as any).project?.workspaceId || "").trim();
}

function sendWorkflowError(res: express.Response, caught: unknown) {
  if (caught instanceof PortraitAdmissionWorkflowError || caught instanceof PortraitProviderRuntimeError) {
    return res.status(caught.status).send(error(caught.message, { code: caught.code }));
  }
  if (String((caught as Error)?.message || "").startsWith("AUDIT_REQUIRED_WRITE_FAILED:")) {
    return res.status(503).send(error("审计服务暂不可用，本次操作未生效", {
      code: "portrait_audit_unavailable",
    }));
  }
  throw caught;
}

async function authorizePortrait(
  req: express.Request,
  res: express.Response,
  admissionId?: string,
) {
  const parsed = authorizationSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send(error("参数错误", { code: "portrait_request_invalid" }));
  const actorUserId = userId(req);
  if (!actorUserId) return res.status(401).send(error("仅登录用户可以发起真人授权", {
    code: "portrait_user_required",
  }));
  const scopedWorkspaceId = workspaceId(req);
  try {
    const result = await startPortraitLivenessAuthorization({
      database: db,
      workspaceId: scopedWorkspaceId,
      projectId: parsed.data.projectId,
      assetVersionId: parsed.data.assetVersionId,
      admissionId: admissionId || null,
      actorUserId,
      expectedRevision: parsed.data.revision,
      identityLabel: parsed.data.identityLabel,
      rightsConfirmed: parsed.data.rightsConfirmed,
      auditContext: req,
    });
    res.set("Cache-Control", "no-store");
    return res.status(200).send(success(result));
  } catch (caught) {
    return sendWorkflowError(res, caught);
  }
}


router.get(
  "/",
  requireProjectPermission("project:read"),
  async (req, res) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).send(error("参数错误", { code: "portrait_request_invalid" }));
    const scopedWorkspaceId = workspaceId(req);
    const { projectId, assetVersionId } = parsed.data;
    const admissionId = await ensurePortraitAdmissionForAsset({
      database: db,
      workspaceId: scopedWorkspaceId,
      projectId,
      assetVersionId,
      actorUserId: userId(req),
    });
    if (!admissionId) return res.status(404).send(error("素材不存在或不支持人像准入", {
      code: "portrait_admission_not_found",
    }));
    const admission = await readPortraitAdmission({
      database: db,
      workspaceId: scopedWorkspaceId,
      projectId,
      assetVersionId,
      actorUserId: userId(req),
    });
    if (!admission) return res.status(404).send(error("素材人像准入记录不存在", {
      code: "portrait_admission_not_found",
    }));
    return res.status(200).send(success(admission));
  },
);

router.post(
  "/register",
  requireProjectPermission("project:write"),
  async (req, res) => {
    const parsed = retrySchema.extend({ model: z.string().trim().min(1).max(200).optional() }).safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).send(error("参数错误", { code: "portrait_request_invalid" }));
    const actorUserId = userId(req);
    if (!actorUserId) return res.status(401).send(error("仅登录用户可以登记资产", { code: "portrait_user_required" }));
    const scopedWorkspaceId = workspaceId(req);
    try {
      const result = await db.transaction(async (trx) => {
        const registered = await registerPortraitAsset({
          database: trx, workspaceId: scopedWorkspaceId, actorUserId,
          projectId: parsed.data.projectId, assetVersionId: parsed.data.assetVersionId,
          expectedRevision: parsed.data.revision, model: parsed.data.model,
        });
        await writeAuditLog(req, {
          workspaceId: scopedWorkspaceId, action: "portrait.asset.register",
          resourceType: "portrait_admission", resourceId: registered.admission.id, required: true,
          metadata: { assetVersionId: registered.admission.assetVersionId,
            revision: registered.admission.revision, status: registered.registration.status,
            ...(parsed.data.model ? { model: parsed.data.model } : {}) },
        }, trx);
        return registered;
      });
      res.set("Cache-Control", "no-store");
      return res.status(200).send(success(result));
    } catch (caught) {
      return sendWorkflowError(res, caught);
    }
  },
);

router.post(
  "/declaration",
  requireProjectPermission("project:write"),
  async (req, res) => {
    const parsed = declarationSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).send(error("参数错误", { code: "portrait_request_invalid" }));
    const actorUserId = userId(req);
    if (!actorUserId) return res.status(401).send(error("仅登录用户可以确认素材来源", {
      code: "portrait_user_required",
    }));
    const scopedWorkspaceId = workspaceId(req);
    const preferredProviderChannelId = await preferredVolcanoPortraitChannel({
      database: db,
      workspaceId: scopedWorkspaceId,
      model: parsed.data.model,
    });
    try {
      const admission = await db.transaction(async (trx) => {
        const result = await declarePortraitAdmission({
          database: trx as any,
          workspaceId: scopedWorkspaceId,
          projectId: parsed.data.projectId,
          assetVersionId: parsed.data.assetVersionId,
          actorUserId,
          choice: parsed.data.choice,
          termsVersion: parsed.data.termsVersion,
          termsAccepted: parsed.data.termsAccepted,
          // Each named declaration is itself an explicit rights attestation;
          // the server still derives all provider group types.
          rightsConfirmed: true,
          sourceTaskId: parsed.data.sourceTaskId,
          preferredProviderChannelId,
          expectedRevision: parsed.data.revision,
        });
        await writeAuditLog(req, {
          workspaceId: scopedWorkspaceId,
          action: "portrait.admission.declare",
          resourceType: "portrait_admission",
          resourceId: result.id,
          required: true,
          metadata: {
            assetVersionId: result.assetVersionId,
            choice: parsed.data.choice,
            termsVersion: parsed.data.termsVersion,
            revision: result.revision,
          },
        }, trx);
        return result;
      });
      return res.status(200).send(success(admission));
    } catch (caught) {
      return sendWorkflowError(res, caught);
    }
  },
);

router.post(
  "/authorization",
  requireProjectPermission("project:write"),
  async (req, res) => authorizePortrait(req, res),
);

router.post(
  "/:id/authorization",
  requireProjectPermission("project:write"),
  async (req, res) => {
    const admissionId = String(req.params.id || "").trim();
    if (!/^[A-Za-z0-9-]{8,128}$/u.test(admissionId)) {
      return res.status(400).send(error("参数错误", { code: "portrait_request_invalid" }));
    }
    return authorizePortrait(req, res, admissionId);
  },
);

router.post(
  "/retry",
  requireProjectPermission("project:write"),
  async (req, res) => {
    const parsed = retrySchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).send(error("参数错误", { code: "portrait_request_invalid" }));
    const actorUserId = userId(req);
    if (!actorUserId) return res.status(401).send(error("仅登录用户可以重试素材检查", {
      code: "portrait_user_required",
    }));
    const scopedWorkspaceId = workspaceId(req);
    const source = await resolveProjectAssetVersion({ database: db, workspaceId: scopedWorkspaceId,
      projectId: parsed.data.projectId, assetVersionId: parsed.data.assetVersionId, actorUserId });
    if (!source) return res.status(404).send(error("素材不存在或无权使用", { code: "portrait_admission_not_found" }));
    try {
      const admission = await db.transaction(async (trx) => {
        const result = await retryPortraitAdmissionChecks({
          database: trx as any,
          workspaceId: scopedWorkspaceId,
          projectId: source.sourceProjectId,
          assetVersionId: parsed.data.assetVersionId,
          expectedRevision: parsed.data.revision,
        });
        await writeAuditLog(req, {
          workspaceId: scopedWorkspaceId,
          action: "portrait.admission.retry",
          resourceType: "portrait_admission",
          resourceId: result.id,
          required: true,
          metadata: { assetVersionId: result.assetVersionId, revision: result.revision },
        }, trx);
        return result;
      });
      return res.status(200).send(success(admission));
    } catch (caught) {
      return sendWorkflowError(res, caught);
    }
  },
);

export default router;
