import express from "express";
import { z } from "zod";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { isPlatformAdmin, requireWorkspacePermission } from "@/middleware/permissions";
import {
  publicProjectCorrelationDigest,
  readPublicCreationTokenKey,
} from "@/lib/publicCreationObservability";
import { excludeInspirationWorkspaceProjects } from "@/lib/inspirationWorkspaceProject";
const router = express.Router();
router.use(requireWorkspacePermission("project:read"));

const bodySchema = z.object({
  workspaceId: z.string().trim().min(1).optional().nullable(),
}).strict();

const getProjects: express.RequestHandler = async (req, res) => {
  const parsed = bodySchema.safeParse(
    req.method === "GET" ? req.query : (req.body ?? {}),
  );
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  const query = u.db("o_project")
    .where("deletionState", "active")
    .select("*");
  excludeInspirationWorkspaceProjects(query);
  const workspaceId = parsed.data.workspaceId || (req as any).auth?.workspaceId;
  if (!isPlatformAdmin(req) || workspaceId) {
    query.where("workspaceId", workspaceId || "default");
  }
  const tokenKey = await readPublicCreationTokenKey(u.db);
  const data = await query.orderBy("createTime", "desc");
  res.status(200).send(success(data.map((project: any) => ({
    ...project,
    correlationDigest: publicProjectCorrelationDigest({
      tokenKey,
      workspaceId: project.workspaceId || workspaceId || "default",
      projectId: project.id,
    }),
  }))));
};

router.get("/", getProjects);
router.post("/", getProjects);

export default router;
