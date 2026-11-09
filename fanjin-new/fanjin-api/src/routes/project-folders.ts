import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { requireActiveWorkspacePermission } from "@/middleware/permissions";
import { db } from "@/utils/db";

const router = express.Router();

const folderName = z.string().trim().min(1).max(200);
const projectIds = z.array(z.string().trim().min(1)).max(500).transform((ids) => Array.from(new Set(ids)));

function actor(req: express.Request): { userId: number; workspaceId: string } {
  return {
    userId: Number((req as any).auth?.user?.id || 0),
    workspaceId: String((req as any).auth?.workspaceId || "").trim(),
  };
}

function parseProjectIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((id) => id.trim()).filter(Boolean);
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed.map(String).map((id) => id.trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function formatFolder(row: any) {
  return {
    id: String(row.id),
    name: String(row.name || "未命名文件夹"),
    projectIds: parseProjectIds(row.projectIds),
    createdAt: new Date(Number(row.createdAt || 0)).toISOString(),
    updatedAt: new Date(Number(row.updatedAt || 0)).toISOString(),
  };
}

async function projectsBelongToWorkspace(workspaceId: string, ids: string[]) {
  if (!ids.length) return true;
  const rows = await db("o_project").where({ workspaceId }).whereIn("id", ids).select("id");
  const found = new Set(rows.map((row: any) => String(row.id)));
  return ids.every((id) => found.has(id));
}

router.get("/", requireActiveWorkspacePermission("project:read"), async (req, res) => {
  const { workspaceId } = actor(req);
  const rows = await db("o_project_folder")
    .where({ workspaceId })
    .orderBy("updatedAt", "desc")
    .orderBy("id", "desc");
  return res.status(200).send(success({ folders: rows.map(formatFolder) }));
});

router.post("/", requireActiveWorkspacePermission("project:write"), async (req, res) => {
  const parsed = z.object({ name: folderName.optional(), projectIds: projectIds.optional() }).strict().safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  const { userId, workspaceId } = actor(req);
  const ids = parsed.data.projectIds || [];
  if (!(await projectsBelongToWorkspace(workspaceId, ids))) {
    return res.status(403).send({ message: "文件夹只能包含当前工作区内的项目" });
  }
  const now = Date.now();
  const row = {
    id: `folder-${now}-${Math.random().toString(16).slice(2)}`,
    workspaceId,
    createdBy: userId,
    name: parsed.data.name || "未命名文件夹",
    projectIds: JSON.stringify(ids),
    createdAt: now,
    updatedAt: now,
  };
  await db("o_project_folder").insert(row);
  return res.status(201).send(success({ folder: formatFolder(row) }));
});

router.patch("/:folderId", requireActiveWorkspacePermission("project:write"), async (req, res) => {
  const parsed = z.object({ name: folderName.optional(), projectIds: projectIds.optional() }).strict().safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  const { workspaceId } = actor(req);
  const query = db("o_project_folder").where({ id: req.params.folderId, workspaceId });
  const existing = await query.first();
  if (!existing) return res.status(404).send({ message: "文件夹不存在" });
  const ids = parsed.data.projectIds ?? parseProjectIds(existing.projectIds);
  if (!(await projectsBelongToWorkspace(workspaceId, ids))) {
    return res.status(403).send({ message: "文件夹只能包含当前工作区内的项目" });
  }
  const updates: Record<string, unknown> = { updatedAt: Date.now() };
  if (parsed.data.name !== undefined) updates.name = parsed.data.name;
  if (parsed.data.projectIds !== undefined) updates.projectIds = JSON.stringify(ids);
  await query.update(updates);
  return res.status(200).send(success({ folder: formatFolder({ ...existing, ...updates, projectIds: JSON.stringify(ids) }) }));
});

router.delete("/:folderId", requireActiveWorkspacePermission("project:delete"), async (req, res) => {
  const { workspaceId } = actor(req);
  const deleted = await db("o_project_folder").where({ id: req.params.folderId, workspaceId }).delete();
  if (!deleted) return res.status(404).send({ message: "文件夹不存在" });
  return res.status(200).send(success({ success: true }));
});

export default router;
