import express from "express";
import { z } from "zod";

import {
  canvasWorkflowTemplatesAvailable,
  createCanvasWorkflowTemplate,
  deleteCanvasWorkflowTemplate,
  listCanvasWorkflowTemplates,
} from "@/lib/canvasWorkflowTemplateService";
import { success } from "@/lib/responseFormat";
import { requireActiveWorkspacePermission } from "@/middleware/permissions";

const router = express.Router();

export const CANVAS_WORKFLOW_TEMPLATE_SCHEMA_PENDING_CODE =
  "CANVAS_WORKFLOW_TEMPLATES_SCHEMA_PENDING" as const;

const schemaPendingResponse = Object.freeze({
  code: CANVAS_WORKFLOW_TEMPLATE_SCHEMA_PENDING_CODE,
  message: "Canvas 工作流模板正在完成 schema 41 滚动升级，请稍后重试。",
});

const finiteCoordinate = z.number().finite().min(-10_000_000).max(10_000_000);
const boundsSchema = z.object({
  left: finiteCoordinate,
  top: finiteCoordinate,
  right: finiteCoordinate,
  bottom: finiteCoordinate,
}).strict().superRefine((value, context) => {
  if (value.right < value.left) {
    context.addIssue({ code: "custom", path: ["right"], message: "right 必须大于等于 left" });
  }
  if (value.bottom < value.top) {
    context.addIssue({ code: "custom", path: ["bottom"], message: "bottom 必须大于等于 top" });
  }
});
const jsonObjectSchema = z.record(z.string().max(128), z.unknown());
const snapshotSchema = z.object({
  nodes: z.array(jsonObjectSchema).max(200),
  edges: z.array(jsonObjectSchema).max(400),
  layoutMode: z.enum(["grid", "horizontal", "vertical"]),
  themeColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  bounds: boundsSchema,
}).strict().superRefine((value, context) => {
  let bytes = Number.POSITIVE_INFINITY;
  try {
    bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    // Cycles are not valid JSON request bodies, but fail closed if a custom
    // Express parser ever supplies one.
  }
  if (bytes > 1_000_000) {
    context.addIssue({
      code: "custom",
      message: "工作流快照不能超过 1 MB",
    });
  }
});
export const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  coverUrl: z.string().trim().max(4096).refine(
    (value) => !value || /^(?:https:\/\/|\/api\/|asset:\/\/)/i.test(value),
    "封面只允许受控 HTTPS、API 或 asset 地址",
  ).optional(),
  coverNodeId: z.string().trim().min(1).max(128).optional(),
  note: z.string().trim().max(1000).optional(),
  groupSnapshot: snapshotSchema,
}).strict();
const workflowIdSchema = z.string().uuid();

function authScope(req: express.Request): { workspaceId: string; createdBy: number } {
  return {
    workspaceId: String((req as any).auth?.workspaceId || "").trim(),
    createdBy: Number((req as any).auth?.user?.id || 0),
  };
}

async function schemaAvailable(res: express.Response): Promise<boolean> {
  if (await canvasWorkflowTemplatesAvailable()) return true;
  res.setHeader("Cache-Control", "private, no-store");
  res.status(503).send(schemaPendingResponse);
  return false;
}

/**
 * Schema 41 is additive and rolling-compatible. A schema-41 binary may be
 * staged while the database is still at 40, so GET remains a stable empty
 * read and advertises `available=false`; writes fail closed until the table is
 * physically present. The Web only exposes the template controls after this
 * server-owned availability bit becomes true.
 */
router.get(
  "/",
  requireActiveWorkspacePermission("project:read"),
  async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    if (!(await canvasWorkflowTemplatesAvailable())) {
      return res.status(200).send(success({ available: false, workflows: [] }));
    }
    const workflows = await listCanvasWorkflowTemplates(authScope(req));
    return res.status(200).send(success({ available: true, workflows }));
  },
);

router.post(
  "/",
  requireActiveWorkspacePermission("project:write"),
  async (req, res) => {
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).send({
        message: parsed.error.issues[0]?.message || "工作流模板参数无效",
        code: "CANVAS_WORKFLOW_TEMPLATE_INPUT_INVALID",
        errors: parsed.error.issues,
      });
    }
    if (!(await schemaAvailable(res))) return;
    const workflow = await createCanvasWorkflowTemplate({
      ...authScope(req),
      ...parsed.data,
    });
    res.setHeader("Cache-Control", "private, no-store");
    return res.status(201).send(success({ workflow }));
  },
);

router.delete(
  "/:workflowId",
  requireActiveWorkspacePermission("project:delete"),
  async (req, res) => {
    const parsed = workflowIdSchema.safeParse(req.params.workflowId);
    if (!parsed.success) {
      return res.status(400).send({
        message: "workflowId 必须是 UUID",
        code: "CANVAS_WORKFLOW_TEMPLATE_ID_INVALID",
      });
    }
    if (!(await schemaAvailable(res))) return;
    const removed = await deleteCanvasWorkflowTemplate({
      id: parsed.data,
      ...authScope(req),
    });
    if (!removed) {
      return res.status(404).send({
        message: "工作流模板不存在",
        code: "CANVAS_WORKFLOW_TEMPLATE_NOT_FOUND",
      });
    }
    res.setHeader("Cache-Control", "private, no-store");
    return res.status(200).send(success({}));
  },
);

export default router;
