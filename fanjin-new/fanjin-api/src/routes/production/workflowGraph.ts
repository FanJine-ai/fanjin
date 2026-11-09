import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { requireProjectPermission } from "@/middleware/projectAccess";

const router = express.Router();

/** 保存工作流图（节点/边/视口） */
router.post(
  "/save",
  validateFields({
    projectId: z.number(),
    episodesId: z.number(),
    nodes: z.array(z.any()),
    edges: z.array(z.any()),
  }),
  requireProjectPermission("project:write"),
  async (req, res) => {
    const { projectId, episodesId, name, nodes, edges, viewport } = req.body;
    const now = Date.now();

    const existing = await u
      .db("o_workflow_graph")
      .where("projectId", String(projectId))
      .where("episodesId", String(episodesId))
      .first();

    const data = {
      projectId: String(projectId),
      episodesId: String(episodesId),
      name: name || "未命名工作流",
      nodes: JSON.stringify(nodes),
      edges: JSON.stringify(edges),
      viewport: JSON.stringify(viewport || { x: 0, y: 0, zoom: 1 }),
      updateTime: now,
    };

    if (existing) {
      await u.db("o_workflow_graph").where("id", existing.id).update(data as any);
    } else {
      (data as any).createTime = now;
      await u.db("o_workflow_graph").insert(data as any);
    }

    res.send(success("已保存"));
  },
);

/** 获取工作流图 */
router.post(
  "/get",
  validateFields({
    projectId: z.number(),
    episodesId: z.number(),
  }),
  requireProjectPermission("project:read"),
  async (req, res) => {
    const { projectId, episodesId } = req.body;

    const row = await u
      .db("o_workflow_graph")
      .where("projectId", String(projectId))
      .where("episodesId", String(episodesId))
      .first();

    if (!row) {
      res.send(success({ nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 }, name: "" }));
      return;
    }

    res.send(
      success({
        name: row.name,
        nodes: JSON.parse(row.nodes || "[]"),
        edges: JSON.parse(row.edges || "[]"),
        viewport: JSON.parse(row.viewport || '{"x":0,"y":0,"zoom":1}'),
        updateTime: row.updateTime,
      }),
    );
  },
);

export default router;
