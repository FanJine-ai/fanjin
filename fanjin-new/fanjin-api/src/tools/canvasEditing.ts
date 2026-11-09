import { createHash, randomUUID } from "node:crypto";
import type { Knex } from "knex";
import { saveCanonicalCanvas } from "@/lib/projectCanvasService";
import { EXTERNAL_TOOL_TABLE } from "@/lib/migrations/externalTools";
import { ToolError } from "./contracts";
import { stableJson } from "./serialization";
import type { ToolIdentity } from "./creationService";
import type { CanvasToolName } from "./canvasContracts";
import { editCanvasGraph, graphDigest, parseGraphArray } from "./canvasGraphEditing";

const fail = (code: string, message: string, status = 409, details?: Record<string, unknown>): never => { throw new ToolError(code, message, status, details); };
const payload = (node: any) => node.data && typeof node.data === "object" && !Array.isArray(node.data) ? node.data : node;
const finite = (v: unknown, fallback: number) => Number.isFinite(Number(v)) ? Number(v) : fallback;
const point = (n: any) => ({ x: finite(n.position?.x ?? n.x, 0), y: finite(n.position?.y ?? n.y, 0) });
const size = (n: any) => ({ width: Math.max(1, finite(n.width ?? n.measured?.width, 440)), height: Math.max(1, finite(n.height ?? n.measured?.height, 440)) });
function move(n: any, x: number, y: number) {
  if (![x, y].every(v => Number.isFinite(v) && Math.abs(v) <= 1_000_000)) fail("LAYOUT_OUT_OF_RANGE", "排列后超出画布范围，请缩小间距或调整起点", 400);
  if (n.position && typeof n.position === "object") n.position = { ...n.position, x, y };
  if (!n.position || "x" in n || "y" in n) { n.x = x; n.y = y; }
}
function setContent(node: any, input: any) {
  const data = payload(node);
  if (input.text !== undefined && node.type !== "text") fail("NODE_TYPE_MISMATCH", "text 正文仅适用于文本节点；图片和视频请修改 prompt", 400);
  if (input.title !== undefined) {
    data.title = input.title; data.titleCustomized = true;
    if ("label" in data) data.label = input.title;
  }
  if (input.prompt !== undefined) data.prompt = input.prompt;
  if (input.text !== undefined) {
    data.outputText = input.text; data.textVisited = true;
    if ("body" in data) data.body = input.text;
    if ("textContent" in data) data.textContent = input.text;
  }
}
function summary(node: any) {
  const data = payload(node);
  return { id: node.id, type: node.type, title: data.title ?? data.label ?? null, position: point(node), ...size(node) };
}

/** Caller locks/revalidates live identity before this atomic journal + canvas edit. */
export async function editCanvas(tx: Knex.Transaction, identity: ToolIdentity, name: CanvasToolName, input: Record<string, any>, now: number, resolveAsset?: (assetId: number, assetVersionId: number) => Promise<Record<string, any>>) {
  if (!input.projectId || !input.canvasId) fail("CANVAS_CONTEXT_REQUIRED", "请指定 projectId 和 canvasId，或在 MCP 连接中绑定", 400);
  const project = await tx("o_project").where({ id: input.projectId, workspaceId: identity.workspaceId, deletionState: "active" }).forUpdate().first();
  if (!project) fail("PROJECT_NOT_FOUND", "项目不存在或无权访问", 404);
  const { idempotencyKey, ...request } = input;
  const scope = { workspaceId: identity.workspaceId, keyId: identity.keyId, userId: identity.userId, kind: name, idempotencyKey };
  const hash = createHash("sha256").update(stableJson(request)).digest("hex");
  const id = randomUUID();
  await tx(EXTERNAL_TOOL_TABLE).insert({ id, ...scope, projectId: input.projectId, requestHash: hash,
    requestJson: stableJson({ ...request, _source: identity.source || "api" }), status: "editing", createdAt: now, updatedAt: now,
  }).onConflict(["workspaceId", "keyId", "kind", "idempotencyKey"]).ignore();
  const op = await tx(EXTERNAL_TOOL_TABLE).where(scope).first();
  if (!op || op.requestHash !== hash) fail("IDEMPOTENCY_CONFLICT", "同一幂等键不能用于不同画布操作");
  // Check the canvas still exists even on replay; return the original receipt, not a second mutation.
  const row = await tx("o_workflow_graph").where({ id: input.canvasId, projectId: input.projectId }).forUpdate().first();
  if (!row) fail("CANVAS_NOT_FOUND", "画布不存在或不属于当前项目", 404);
  if (op.id !== id) {
    if (op.status !== "succeeded" || !op.resultJson) fail("CANVAS_EDIT_IN_PROGRESS", "画布操作仍在处理，请使用原幂等键重试");
    const { _undo, ...receipt } = JSON.parse(op.resultJson);
    return { ...receipt, replayed: true, currentRevision: Number(row.revision || 1) };
  }
  const revision = Number(row.revision || 1);
  if (revision !== input.expectedRevision) fail("CANVAS_REVISION_CONFLICT", "画布已被更新，请重新读取后编辑", 409, { expectedRevision: input.expectedRevision, currentRevision: revision });
  let nodes: any[];
  try { nodes = typeof row.nodes === "string" ? JSON.parse(row.nodes) : row.nodes; }
  catch { return fail("INVALID_CANVAS", "画布节点暂时无法读取"); }
  if (!Array.isArray(nodes) || nodes.some(n => !n || typeof n !== "object" || typeof n.id !== "string") || new Set(nodes.map(n => n.id)).size !== nodes.length) fail("INVALID_CANVAS", "画布节点格式无效，请先检查画布");
  const changed: any[] = [];
  let graphPatch: { edges: any[]; groups: any[] } | undefined;
  let undoRecord: any;
  let graphReceipt: Record<string, unknown> = {};
  const find = (id: string) => nodes.find(n => n.id === id) ?? fail("NODE_NOT_FOUND", "指定节点不存在，未修改画布", 404);
  if (name === "fanjin_canvas_nodes_create") {
    if (nodes.length + input.nodes.length > 5000) fail("CANVAS_TOO_LARGE", "画布节点已达上限，请使用其他画布", 413);
    const startX = nodes.length ? Math.min(...nodes.map(n => point(n).x)) : 0;
    let nextY = nodes.length ? Math.max(...nodes.map(n => point(n).y + size(n).height)) + 100 : 0;
    for (const item of input.nodes) {
      const ratio = item.aspectRatio || (item.type === "video" ? "9:16" : "1:1");
      const [w, h] = ratio.split(":").map(Number);
      const width = item.type === "text" ? 440 : 440 * Math.max(1, w / h);
      const height = item.type === "text" ? 440 : 440 * Math.max(1, h / w);
      const node: any = { id: `mcp_${randomUUID()}`, type: item.type, title: { text: "文本节点", image: "图片节点", video: "视频节点", audio: "音频节点", compose: "合成节点" }[item.type as "text" | "image" | "video" | "audio" | "compose"],
        titleCustomized: false, x: item.position?.x ?? startX, y: item.position?.y ?? nextY, width, height, ratio,
        prompt: "", model: "", quality: "高", resolution: item.type === "video" ? "720P" : "2K", quantity: "1x", maxImages: 1,
        videoGenerateAudio: true, videoOutputFormat: "mp4", ...(item.type === "video" ? { videoMode: "text_to_video" } : {}),
        price: "", duration: "5", textVisited: false, isGenerating: false, generationState: "idle", taskStatus: "idle" };
      setContent(node, item); move(node, node.x, node.y); nodes.push(node); changed.push(node);
      nextY = Math.max(nextY, node.y + height + 100);
    }
  } else if (name === "fanjin_canvas_nodes_update") {
    for (const update of input.updates) {
      if (!["title", "prompt", "text"].some(k => update[k] !== undefined)) fail("EMPTY_NODE_UPDATE", "至少提供 title、prompt 或 text 中的一项", 400);
      const node = find(update.nodeId), data = payload(node);
      if (!["text", "image", "video"].includes(node.type)) fail("NODE_TYPE_UNSUPPORTED", "当前仅支持文本、图片和视频节点文字修改", 400);
      if ((update.prompt !== undefined || update.text !== undefined) && (data.isGenerating || [data.taskStatus, data.generationState].some(s => ["queued", "running", "preparing", "generating"].includes(s)))) fail("NODE_BUSY", "节点正在生成，完成后再修改提示词；本次批量修改未保存");
      setContent(node, update); changed.push(node);
    }
  } else if (name === "fanjin_canvas_graph_edit") {
    const before = structuredClone({ nodes, edges: parseGraphArray(row.edges), groups: parseGraphArray(row.groups) });
    const edited = await editCanvasGraph(structuredClone(before), input.commands, async operationId => {
      const previous = await tx(EXTERNAL_TOOL_TABLE).where({ id: operationId, workspaceId: identity.workspaceId, projectId: input.projectId, userId: identity.userId, kind: name, status: "succeeded" }).first();
      if (!previous?.resultJson) return null;
      const saved = JSON.parse(previous.resultJson);
      return saved.canvasId === input.canvasId ? saved._undo : null;
    }, { resolveAsset, loadTemplate: async templateId => {
      const template = await tx("o_canvas_workflow_template").where({ id: templateId, workspaceId: identity.workspaceId, createdBy: identity.userId }).first();
      return template ? { ...template, groupSnapshot: typeof template.groupSnapshot === "string" ? JSON.parse(template.groupSnapshot) : template.groupSnapshot } : null;
    } });
    nodes = edited.nodes; graphPatch = { edges: edited.edges, groups: edited.groups };
    changed.push(...nodes.filter(n => edited.changedNodeIds.includes(n.id)));
    undoRecord = { before, afterDigest: graphDigest({ nodes, ...graphPatch }) };
    graphReceipt = { createdNodeIds: edited.createdNodeIds, createdGroupIds: edited.createdGroupIds, totalNodes: nodes.length, totalEdges: edited.edges.length, totalGroups: edited.groups.length };
  } else if (name === "fanjin_canvas_viewport_set") {
    // Persisted separately from node edits; do not mutate graph content.
  } else {
    const selected = input.nodeIds.map(find);
    if (input.mode === "manual") {
      if (input.origin || input.columns !== undefined || !input.positions || input.positions.length !== selected.length || new Set(input.positions.map((p: any) => p.nodeId)).size !== selected.length || input.positions.some((p: any) => !input.nodeIds.includes(p.nodeId))) fail("INVALID_LAYOUT", "手动排列的 positions 必须与 nodeIds 一一对应，且不传 origin/columns", 400);
      for (const p of input.positions) move(find(p.nodeId), p.x, p.y);
    } else {
      if (input.positions || input.mode !== "grid" && input.columns !== undefined) fail("INVALID_LAYOUT", "positions 仅用于手动排列，columns 仅用于网格排列", 400);
      const columns = input.mode === "horizontal" ? selected.length : input.mode === "vertical" ? 1 : input.columns ?? Math.ceil(Math.sqrt(selected.length));
      const origin = input.origin ?? { x: Math.min(...selected.map((n: any) => point(n).x)), y: Math.min(...selected.map((n: any) => point(n).y)) };
      let y = origin.y;
      for (let offset = 0; offset < selected.length; offset += columns) {
        const rowNodes = selected.slice(offset, offset + columns);
        let x = origin.x;
        for (const node of rowNodes) { move(node, x, y); x += size(node).width + input.gap; }
        y += Math.max(...rowNodes.map((n: any) => size(n).height)) + input.gap;
      }
    }
    changed.push(...selected);
  }
  const result = await saveCanonicalCanvas({ projectId: input.projectId, canvasId: input.canvasId, expectedRevision: revision, nodes, ...graphPatch, ...(name === "fanjin_canvas_viewport_set" ? { viewport: input.viewport } : {}) }, tx);
  if (!result || result.kind !== "saved") return fail("CANVAS_REVISION_CONFLICT", "画布已更新，请重新读取后编辑");
  const receipt = { projectId: input.projectId, canvasId: input.canvasId, revision: result.revision, operationId: id, nodes: changed.map(summary), replayed: false, generationSubmitted: false, ...graphReceipt };
  await tx(EXTERNAL_TOOL_TABLE).where({ id }).update({ status: "succeeded", resultJson: stableJson({ ...receipt, ...(undoRecord ? { _undo: undoRecord } : {}) }), updatedAt: now });
  return receipt;
}
