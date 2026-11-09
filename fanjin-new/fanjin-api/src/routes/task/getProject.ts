import express from "express";
import { z } from "zod";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { isPlatformAdmin, requireWorkspacePermission } from "@/middleware/permissions";
import { excludeInspirationWorkspaceProjects } from "@/lib/inspirationWorkspaceProject";
const router = express.Router();
router.use(requireWorkspacePermission("project:read"));

const bodySchema = z.object({
  workspaceId: z.string().trim().min(1).optional().nullable(),
}).strict();

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  const query = u.db("o_project")
    .where("deletionState", "active")
    .select("id", "name")
    .groupBy("id", "name");
  excludeInspirationWorkspaceProjects(query);
  const workspaceId = parsed.data.workspaceId || (req as any).auth?.workspaceId;
  if (!isPlatformAdmin(req) || workspaceId) query.where("workspaceId", workspaceId || "default");
  const list = await query;
  const data = list.filter((item) => item.name);
  res.status(200).send(success(data));
});
