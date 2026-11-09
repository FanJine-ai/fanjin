import { assertMembershipFeature } from "./membership";
import { v4 as uuid } from "uuid";
import type { Knex } from "knex";
import {
  CANVAS_WORKFLOW_TEMPLATE_TABLE,
} from "@/lib/migrations/canvasWorkflowTemplate";
import { db } from "@/utils/db";
import { requireLiveWorkspaceAuthority } from "@/lib/workspaceAccess";

export type CanvasWorkflowBounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export type CanvasWorkflowGroupSnapshot = {
  nodes: Array<Record<string, unknown>>;
  edges: Array<Record<string, unknown>>;
  layoutMode: "grid" | "horizontal" | "vertical";
  themeColor: string;
  bounds: CanvasWorkflowBounds;
};

export type CreateCanvasWorkflowTemplateInput = {
  workspaceId: string;
  createdBy: number;
  name: string;
  coverUrl?: string;
  coverNodeId?: string;
  note?: string;
  groupSnapshot: CanvasWorkflowGroupSnapshot;
};

function isoTime(value: unknown): string {
  const timestamp = Number(value);
  return new Date(
    Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0,
  ).toISOString();
}

function parseSnapshot(value: unknown): CanvasWorkflowGroupSnapshot {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as CanvasWorkflowGroupSnapshot;
    }
  } catch {
    // Rows can only be written through the validated API. A corrupt legacy
    // value remains non-executable and is represented as an empty snapshot.
  }
  return {
    nodes: [],
    edges: [],
    layoutMode: "grid",
    themeColor: "#93c5fd",
    bounds: { left: 0, top: 0, right: 0, bottom: 0 },
  };
}

function formatWorkflowTemplate(row: any) {
  return {
    id: String(row.id),
    userId: String(row.createdBy),
    name: String(row.name || "未命名工作流"),
    coverUrl: String(row.coverUrl || ""),
    ...(row.coverNodeId
      ? { coverNodeId: String(row.coverNodeId) }
      : {}),
    ...(row.note ? { note: String(row.note) } : {}),
    groupSnapshot: parseSnapshot(row.groupSnapshot),
    createdAt: isoTime(row.createdAt),
    updatedAt: isoTime(row.updatedAt),
  };
}

export async function canvasWorkflowTemplatesAvailable(
  database: Knex = db as unknown as Knex,
): Promise<boolean> {
  return database.schema.hasTable(CANVAS_WORKFLOW_TEMPLATE_TABLE);
}

export async function listCanvasWorkflowTemplates(input: {
  workspaceId: string;
  createdBy: number;
}) {
  const rows = await db(CANVAS_WORKFLOW_TEMPLATE_TABLE)
    .where({
      workspaceId: input.workspaceId,
      createdBy: input.createdBy,
    })
    .orderBy([
      { column: "updatedAt", order: "desc" },
      { column: "id", order: "desc" },
    ]);
  return rows.map(formatWorkflowTemplate);
}

export async function createCanvasWorkflowTemplate(
  input: CreateCanvasWorkflowTemplateInput,
) {
  await assertMembershipFeature(input.workspaceId, "workflow");
  const id = uuid();
  const now = Date.now();
  const row = {
    id,
    workspaceId: input.workspaceId,
    createdBy: input.createdBy,
    name: input.name,
    coverUrl: input.coverUrl || "",
    coverNodeId: input.coverNodeId || null,
    note: input.note || "",
    groupSnapshot: JSON.stringify(input.groupSnapshot),
    createdAt: now,
    updatedAt: now,
  };
  await db(CANVAS_WORKFLOW_TEMPLATE_TABLE).insert(row);
  return formatWorkflowTemplate(row);
}

export async function deleteCanvasWorkflowTemplate(input: {
  id: string;
  workspaceId: string;
  createdBy: number;
}): Promise<boolean> {
  return db.transaction(async (trx) => {
    // 删除已保存的模板资料，必须在事务内检查实时删除权限。
    await requireLiveWorkspaceAuthority({
      database: trx, actorUserId: input.createdBy, workspaceId: input.workspaceId,
      authenticatedWorkspaceId: input.workspaceId,
      permission: "project:delete",
    });
    const deleted = await trx(CANVAS_WORKFLOW_TEMPLATE_TABLE)
      .where({ id: input.id, workspaceId: input.workspaceId, createdBy: input.createdBy })
      .delete();
    return Number(deleted) === 1;
  });
}
