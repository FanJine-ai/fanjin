import { randomUUID, createHash } from "node:crypto";
import { isCanvasNodeConnectionAllowed, removeCanvasGraphSelection, type CanvasGraphNodeType } from "../../../../contracts/canvas/graphPolicy";
import { consolidateCanvasAssets } from "../../../../contracts/canvas/assetConsolidation";
import { buildRedrawPlan } from "../../../../contracts/canvas/redrawDraft";
import { ToolError } from "./contracts";
import { stableJson } from "./serialization";

type Graph = { nodes: any[]; edges: any[]; groups: any[] };
export const graphDigest = (graph: Graph) => createHash("sha256").update(stableJson(graph)).digest("hex");
export function parseGraphArray(value: unknown): any[] {
  const parsed = typeof value === "string" ? JSON.parse(value) : value ?? [];
  if (!Array.isArray(parsed)) throw new ToolError("INVALID_CANVAS", "画布结构无效", 409);
  return parsed;
}
const data = (node: any) => node.data && typeof node.data === "object" ? node.data : node;
const fail = (message: string): never => { throw new ToolError("INVALID_GRAPH_EDIT", message, 409); };
const busy = (n: any) => data(n).isGenerating || [data(n).taskStatus, data(n).generationState].some(s => ["queued", "preparing", "running", "processing", "submitting"].includes(s));

export async function editCanvasGraph(graph: Graph, commands: any[], undo: (operationId: string) => Promise<any>, adapters: { resolveAsset?: (assetId: number, assetVersionId: number) => Promise<Record<string, any>>; loadTemplate?: (id: string) => Promise<any> } = {}) {
  let { nodes, edges, groups } = structuredClone(graph);
  edges = edges.map(e => ({ ...e, fromNodeId: e.fromNodeId ?? e.source, toNodeId: e.toNodeId ?? e.target }));
  const changed = new Set<string>(), created: Record<string, string> = {}, createdGroups: string[] = [];
  const find = (id: string) => nodes.find(n => n.id === id) ?? fail(`节点 ${id} 不存在`);
  const editable = (id: string) => { const node = find(id); if (busy(node)) fail("节点正在生成，完成后再修改"); return node; };
  const ensureUnique = (ids: string[]) => { if (new Set(ids).size !== ids.length) fail("节点或连线 ID 不能重复"); };
  const connect = (from: string, to: string, options: any = {}) => {
    const source = find(from), target = editable(to);
    if (from === to || !isCanvasNodeConnectionAllowed(source.type as CanvasGraphNodeType, target.type as CanvasGraphNodeType)) fail("这两种节点不能连接");
    if (edges.some(e => (e.fromNodeId ?? e.source) === from && (e.toNodeId ?? e.target) === to)) fail("连接已存在");
    const edge = { id: `mcp_${randomUUID()}`, fromNodeId: from, toNodeId: to, fromSide: options.fromSide || "right", toSide: options.toSide || "left" };
    const index = options.index ?? edges.length;
    if (index > edges.length) fail("连接顺序越界");
    edges.splice(index, 0, edge); changed.add(to);
  };
  for (const command of commands) {
    switch (command.action) {
      case "nodes.delete": {
        ensureUnique(command.nodeIds); command.nodeIds.forEach(editable);
        ({ nodes, edges, groups } = removeCanvasGraphSelection({ nodes, edges: edges.map(e => ({ ...e, fromNodeId: e.fromNodeId ?? e.source, toNodeId: e.toNodeId ?? e.target })), groups, selectedNodeIds: command.nodeIds, selectedEdgeIds: [] }));
        break;
      }
      case "nodes.duplicate": {
        ensureUnique(command.nodeIds);
        if (nodes.length + command.nodeIds.length > 5000) fail("画布节点已达上限");
        const selected = command.nodeIds.map(editable), mapping = new Map<string, string>();
        for (const node of selected) {
          const copy = structuredClone(node), p = data(copy), id = `mcp_${randomUUID()}`;
          mapping.set(node.id, id); created[node.id] = id; copy.id = id;
          if (copy.position) { copy.position.x += command.offset.x; copy.position.y += command.offset.y; }
          else { copy.x += command.offset.x; copy.y += command.offset.y; }
          for (const key of Object.keys(p)) if (/AttemptId$|RequestAttempt$/.test(key) || ["taskId", "externalToolTaskId", "videoStoryTaskId", "videoEnhanceAttemptId"].includes(key)) delete p[key];
          Object.assign(p, { isGenerating: false, generationState: "idle", taskStatus: "idle" });
          nodes.push(copy); changed.add(id);
        }
        edges.push(...edges.filter(e => mapping.has(e.fromNodeId) && mapping.has(e.toNodeId)).map(e => ({ ...e, id: `mcp_${randomUUID()}`, fromNodeId: mapping.get(e.fromNodeId), toNodeId: mapping.get(e.toNodeId) })));
        break;
      }
      case "nodes.configure": {
        const node = editable(command.nodeId);
        Object.assign(data(node), command.settings);
        // Geometry belongs to the outer node in legacy nested records too.
        for (const key of ["width", "height"]) if (command.settings[key] !== undefined) node[key] = command.settings[key];
        changed.add(node.id); break;
      }
      case "nodes.layer": {
        const node = find(command.nodeId); nodes = nodes.filter(n => n.id !== node.id); nodes.splice(Math.min(command.index, nodes.length), 0, node); changed.add(node.id); break;
      }
      case "edges.connect": connect(command.fromNodeId, command.toNodeId, command); break;
      case "edges.remove": {
        ensureUnique(command.edgeIds);
        for (const id of command.edgeIds) { const edge = edges.find(e => e.id === id) ?? fail("指定连接不存在"); editable(edge.toNodeId ?? edge.target); }
        edges = edges.filter(e => !command.edgeIds.includes(e.id)); break;
      }
      case "edges.reorder": {
        editable(command.toNodeId); ensureUnique(command.edgeIds);
        const incoming = edges.filter(e => (e.toNodeId ?? e.target) === command.toNodeId);
        if (incoming.length !== command.edgeIds.length || incoming.some(e => !command.edgeIds.includes(e.id))) fail("必须按新顺序提供目标节点全部输入连线");
        let i = 0;
        edges = edges.map(e => {
          if (!incoming.includes(e)) return e;
          const id = command.edgeIds[i++];
          return incoming.find(candidate => candidate.id === id)!;
        }); break;
      }
      case "groups.create": {
        ensureUnique(command.nodeIds); command.nodeIds.forEach(find);
        groups = groups.map(g => ({ ...g, nodeIds: g.nodeIds.filter((id: string) => !command.nodeIds.includes(id)) })).filter(g => g.nodeIds.length >= 2);
        const id = `mcp_${randomUUID()}`;
        groups.push({ id, nodeIds: command.nodeIds, title: command.title, themeColor: command.themeColor, layoutMode: command.layoutMode, groupType: "default" });
        createdGroups.push(id); break;
      }
      case "groups.update": {
        const group = groups.find(g => g.id === command.groupId) ?? fail("分组不存在");
        if (command.nodeIds) {
          ensureUnique(command.nodeIds); command.nodeIds.forEach(find);
          groups = groups.map(g => g.id === group.id ? g : { ...g, nodeIds: g.nodeIds.filter((id: string) => !command.nodeIds.includes(id)) }).filter(g => g.id === group.id || g.nodeIds.length >= 2);
        }
        for (const key of ["nodeIds", "title", "themeColor", "layoutMode"]) if (command[key] !== undefined) group[key] = command[key];
        break;
      }
      case "groups.remove": {
        if (!groups.some(g => g.id === command.groupId)) fail("分组不存在");
        groups = groups.filter(g => g.id !== command.groupId); break;
      }
      case "assets.consolidate": nodes.forEach(n => editable(n.id)); ({ nodes, edges, groups } = consolidateCanvasAssets({ nodes, edges, groups })); break;
      case "assets.attach": {
        const node = editable(command.nodeId);
        const asset = await adapters.resolveAsset?.(command.assetId, command.assetVersionId) ?? fail("素材无权使用或未就绪");
        if (!["image", "video", "audio"].includes(asset.type) || node.type !== asset.type) fail("资产类型与节点不一致，或资产无权使用");
        const p = data(node);
        for (const key of ["localPreviewUrl", "localVideoUrl", "localAudioUrl", "taskId", "generationTaskId", "generationError", "generatedImages", "generationVersions", "activeGenerationVersion"]) delete p[key];
        Object.assign(p, { [asset.type === "image" ? "imageUrl" : asset.type === "video" ? "videoUrl" : "audioUrl"]: asset.url,
          ...(asset.type === "image" ? { primaryImageUrl: asset.url } : {}), assetVersionId: asset.assetVersionId, referenceAssetUri: `asset://${asset.assetId}`,
          isGenerating: false, generationState: "idle", taskStatus: "success" });
        changed.add(node.id); break;
      }
      case "template.apply": {
        const template = await adapters.loadTemplate?.(command.templateId);
        if (!template) fail("模板不存在或无权访问");
        const snapshot = template.groupSnapshot;
        if (!Array.isArray(snapshot?.nodes) || !snapshot.nodes.length || !Array.isArray(snapshot.edges) || nodes.length + snapshot.nodes.length > 5000) fail("模板内容无效或画布节点过多");
        const mapping = new Map<string, string>();
        for (const n of snapshot.nodes) { if (typeof n.id !== "string" || mapping.has(n.id) || !["text", "image", "video", "audio", "compose", "script"].includes(n.type)) fail("模板节点无效"); mapping.set(n.id, `mcp_${randomUUID()}`); }
        const cloned = structuredClone(snapshot.nodes);
        for (const n of cloned) {
          const old = n.id; n.id = mapping.get(old); created[old] = n.id;
          n.x = Number(n.x || 0) - Number(snapshot.bounds?.left || 0) + command.origin.x;
          n.y = Number(n.y || 0) - Number(snapshot.bounds?.top || 0) + command.origin.y;
          if (![n.x, n.y].every(v => Number.isFinite(v) && Math.abs(v) <= 1_000_000)) fail("模板位置越界");
          const p = data(n);
          for (const key of Object.keys(p)) if (/AttemptId$|RequestAttempt$/.test(key) || ["taskId", "externalToolTaskId", "videoStoryTaskId"].includes(key)) delete p[key];
          Object.assign(p, { isGenerating: false, generationState: "idle", taskStatus: "idle" });
          changed.add(n.id);
        }
        const remap = (value: any, key = ""): any => {
          if (typeof value === "string" && /(?:nodeids?|assetId)$/i.test(key)) return mapping.get(value) ?? value;
          if (Array.isArray(value)) return value.map(v => remap(v, key));
          if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, remap(v, k)]));
          return value;
        };
        nodes.push(...cloned.map((n: any) => remap(n)));
        for (const edge of snapshot.edges) {
          if (!mapping.has(edge.fromNodeId) || !mapping.has(edge.toNodeId)) fail("模板连接引用不存在的节点");
          connect(mapping.get(edge.fromNodeId)!, mapping.get(edge.toNodeId)!, edge);
        }
        const groupId = `mcp_${randomUUID()}`; createdGroups.push(groupId);
        groups.push({ id: groupId, nodeIds: [...mapping.values()], title: template.name, themeColor: snapshot.themeColor, layoutMode: snapshot.layoutMode, groupType: "default" });
        break;
      }
      case "operation.undo": {
        if (commands.length !== 1) fail("撤销须单独提交");
        const previous = await undo(command.operationId);
        if (!previous || previous.afterDigest !== graphDigest({ nodes, edges, groups })) fail("画布内容已继续变化，不能覆盖后续修改");
        ({ nodes, edges, groups } = previous.before); break;
      }
      case "redraw.configure": {
        const target = editable(command.nodeId), source = find(command.sourceNodeId);
        if (target.type !== "video" || source.type !== "video" || target.id === source.id) fail("转绘需要独立的原视频和结果视频节点");
        const assets = command.draft.mappings.filter((m: any) => m.assetId).map((m: any) => { const n = find(m.assetId); if (n.type !== "image") fail("转绘替换素材必须是图片节点"); return { id: n.id, name: data(n).title || n.id, imageUrl: data(n).imageUrl || "" }; });
        const plan = buildRedrawPlan(command.draft, assets);
        edges = edges.filter(e => (e.toNodeId ?? e.target) !== target.id);
        connect(source.id, target.id); plan.referenceIds.forEach(id => connect(id, target.id));
        Object.assign(data(target), { videoWorkflow: "redraw", videoMode: plan.mode, duration: plan.duration, prompt: plan.prompt, model: command.draft.modelId, videoRedrawDraft: command.draft, videoRedrawSourceNodeId: source.id });
        changed.add(target.id); break;
      }
      case "compose.configure": {
        const target = editable(command.nodeId); if (target.type !== "compose") fail("目标必须是合成节点");
        for (const clip of command.clips) { const n = find(clip.nodeId); if (!["video", "audio"].includes(n.type) || clip.trimEnd <= clip.trimStart || clip.assetVersionId && clip.assetVersionId !== data(n).assetVersionId) fail("合成片段或素材版本不一致"); }
        Object.assign(data(target), { composeTimeline: command.clips, ...(command.muted === undefined ? {} : { composeMuted: command.muted }) });
        edges = edges.filter(e => (e.toNodeId ?? e.target) !== target.id);
        [...new Set<string>(command.clips.map((clip: any) => clip.nodeId))].forEach(id => connect(id, target.id));
        changed.add(target.id); break;
      }
      default: fail("未知画布命令");
    }
  }
  return { nodes, edges, groups, changedNodeIds: [...changed], createdNodeIds: created, createdGroupIds: createdGroups };
}
