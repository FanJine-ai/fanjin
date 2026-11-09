import express from "express";
import { z } from "zod";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { isPlatformAdmin, requireWorkspacePermission } from "@/middleware/permissions";
import { relayTaskCategories } from "@/lib/taskCenter";
const router = express.Router();
router.use(requireWorkspacePermission("project:read"));

const bodySchema = z.object({
  workspaceId: z.string().trim().min(1).optional().nullable(),
}).strict();

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  const workspaceId = parsed.data.workspaceId || (req as any).auth?.workspaceId || "default";
  const legacyQuery = u
    .db("o_tasks")
    .leftJoin("o_project", "o_project.id", "o_tasks.projectId")
    .select("o_tasks.taskClass as taskClass")
    .groupBy("o_tasks.taskClass");
  if (!isPlatformAdmin(req) || parsed.data.workspaceId) legacyQuery.where("o_project.workspaceId", workspaceId);
  const list = await legacyQuery;
  const relayQuery = u.db("o_relay_task").count({ total: "*" }).first();
  if (!isPlatformAdmin(req) || parsed.data.workspaceId) relayQuery.where("workspaceId", workspaceId);
  const relayCount = (await relayQuery) as any;
  const legacyCategories = list.filter((item) => item.taskClass).map((item) => ({ taskClass: String(item.taskClass) }));
  const relayCategories = Number(relayCount?.total || 0) > 0 ? relayTaskCategories.map((taskClass) => ({ taskClass })) : [];
  const seen = new Set<string>();
  const data = [...legacyCategories, ...relayCategories].filter((item) => {
    if (seen.has(item.taskClass)) return false;
    seen.add(item.taskClass);
    return true;
  });
  res.status(200).send(success(data));
});
