import type { Knex } from "knex";
import { ToolError } from "./contracts";
import { saveCanonicalCanvas } from "@/lib/projectCanvasService";

/** Only server-resolved managed media may be written; never accept client URLs. */
export async function attachCanvasOutput(db: Knex.Transaction, input: {
  projectId: number; canvasId: number; nodeId: string; expectedRevision: number; taskId: string;
  asset: { assetId: number; assetVersionId: number; type: string; url: string };
}, now = Date.now()) {
  const row = await db("o_workflow_graph").where({ id: input.canvasId, projectId: input.projectId }).forUpdate().first();
  if (!row) throw new ToolError("CANVAS_NOT_FOUND", "画布不存在或不属于当前项目", 404);
  if (Number(row.revision || 1) !== input.expectedRevision) throw new ToolError("CANVAS_REVISION_CONFLICT", "画布已更新，作品已保存。请重新读取画布后再放入节点", 409);
  let nodes: any[];
  try { nodes = typeof row.nodes === "string" ? JSON.parse(row.nodes) : row.nodes; }
  catch { throw new ToolError("INVALID_CANVAS", "画布暂时无法读取", 409); }
  if (!Array.isArray(nodes)) throw new ToolError("INVALID_CANVAS", "画布节点格式无效", 409);
  const node = nodes.find(n => n.id === input.nodeId);
  if (!node) throw new ToolError("NODE_NOT_FOUND", "指定节点不存在，作品仍保存在资产库", 404);
  if (!["image", "video"].includes(input.asset.type) || node.type !== input.asset.type) throw new ToolError("NODE_TYPE_MISMATCH", "作品类型与目标节点不一致", 409);
  const data = node.data && typeof node.data === "object" ? node.data : node;
  if (data.isGenerating || ["queued", "running", "preparing"].includes(data.taskStatus)) throw new ToolError("NODE_BUSY", "节点正在处理其他任务，作品已保存，请稍后回填", 409);
  const versions = Array.isArray(data.generationVersions) ? [...data.generationVersions] : [];
  const previousUrl = input.asset.type === "video" ? data.videoUrl : data.imageUrl;
  let version = versions.reduce((n, v) => Math.max(n, Number(v.version) || 0), 0);
  if (previousUrl && !versions.some(v => v.url === previousUrl)) versions.push({ version: ++version, kind: input.asset.type, url: previousUrl, createdAt: now, label: `v${version}` });
  versions.push({ version: ++version, kind: input.asset.type, url: input.asset.url, createdAt: now, label: `v${version}`, assetVersionId: input.asset.assetVersionId });
  // Remove transient previews and old task pointers that would mask the saved output.
  for (const field of ["localPreviewUrl", "localVideoUrl", "taskId", "generationTaskId", "generationError"]) delete data[field];
  Object.assign(data, { ...(input.asset.type === "video" ? { videoUrl: input.asset.url } : { imageUrl: input.asset.url, primaryImageUrl: input.asset.url }),
    assetVersionId: input.asset.assetVersionId, referenceAssetUri: `asset://${input.asset.assetId}`,
    generationVersions: versions, activeGenerationVersion: version, externalToolTaskId: input.taskId,
    taskStatus: "success", generationState: "idle", isGenerating: false, generationProgress: 0 });
  const result = await saveCanonicalCanvas({ canvasId: input.canvasId, projectId: input.projectId, expectedRevision: input.expectedRevision, nodes }, db);
  if (!result || result.kind === "conflict") throw new ToolError("CANVAS_REVISION_CONFLICT", "画布已更新，作品已保存，请重新读取后回填", 409);
  return { status: "attached", canvasId: input.canvasId, nodeId: input.nodeId, revision: result.revision, assetVersionId: input.asset.assetVersionId };
}
