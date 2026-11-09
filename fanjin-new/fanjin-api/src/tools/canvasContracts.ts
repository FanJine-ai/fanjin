import { z } from "zod";

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nodeId = z.string().min(1).max(128);
const position = z.strictObject({ x: z.number().finite().min(-1_000_000).max(1_000_000), y: z.number().finite().min(-1_000_000).max(1_000_000) });
const common = {
  projectId: id.optional(), canvasId: id.optional(), expectedRevision: id,
  idempotencyKey: z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/),
};
const content = { title: z.string().trim().min(1).max(500).optional(), prompt: z.string().max(8000).optional(), text: z.string().max(16000).optional() };
const unique = (values: string[]) => new Set(values).size === values.length;
const define = <S extends z.ZodObject>(title: string, description: string, schema: S) => ({ title, description, schema, keyPermission: "project:write", memberPermission: "project:write", readOnly: false });
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const settings = z.strictObject({
  model: z.string().max(200).optional(), ratio: z.enum(["1:1", "16:9", "9:16", "4:3", "3:4", "21:9"]).optional(),
  resolution: z.string().max(30).optional(), quality: z.string().max(40).optional(), duration: z.string().max(20).optional(),
  quantity: z.enum(["1x", "2x", "4x"]).optional(), maxImages: z.union([z.literal(1), z.literal(2), z.literal(4)]).optional(),
  videoGenerateAudio: z.boolean().optional(), videoMode: z.enum(["text_to_video", "image_to_video", "first_last_frame", "omni_reference", "image_reference", "video_edit", "video_extension"]).optional(),
  videoRenderMode: z.enum(["draft", "finalize"]).optional(), videoOutputFormat: z.enum(["mp4", "webm"]).optional(),
  width: z.number().min(40).max(10000).optional(), height: z.number().min(40).max(20000).optional(),
  textBackgroundColor: color.optional(), textHeading: z.enum(["body", "h1", "h2", "h3"]).optional(), textFontSize: z.number().min(8).max(160).optional(),
  textBold: z.boolean().optional(), textItalic: z.boolean().optional(), textListStyle: z.enum(["none", "bullet", "number"]).optional(), textDivider: z.boolean().optional(), textExpanded: z.boolean().optional(),
});
const commands = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("nodes.delete"), nodeIds: z.array(nodeId).min(1).max(100) }),
  z.strictObject({ action: z.literal("nodes.duplicate"), nodeIds: z.array(nodeId).min(1).max(100), offset: position.default({ x: 80, y: 80 }) }),
  z.strictObject({ action: z.literal("nodes.configure"), nodeId, settings }),
  z.strictObject({ action: z.literal("nodes.layer"), nodeId, index: z.number().int().min(0).max(4999) }),
  z.strictObject({ action: z.literal("edges.connect"), fromNodeId: nodeId, toNodeId: nodeId, fromSide: z.enum(["left", "right"]).default("right"), toSide: z.enum(["left", "right"]).default("left"), index: z.number().int().min(0).optional() }),
  z.strictObject({ action: z.literal("edges.remove"), edgeIds: z.array(nodeId).min(1).max(100) }),
  z.strictObject({ action: z.literal("edges.reorder"), toNodeId: nodeId, edgeIds: z.array(nodeId).min(1).max(100) }),
  z.strictObject({ action: z.literal("groups.create"), title: z.string().min(1).max(200), nodeIds: z.array(nodeId).min(2).max(100), themeColor: color.default("#93c5fd"), layoutMode: z.enum(["grid", "horizontal", "vertical"]).default("grid") }),
  z.strictObject({ action: z.literal("groups.update"), groupId: nodeId, title: z.string().max(200).optional(), nodeIds: z.array(nodeId).min(2).max(100).optional(), themeColor: color.optional(), layoutMode: z.enum(["grid", "horizontal", "vertical"]).optional() }),
  z.strictObject({ action: z.literal("groups.remove"), groupId: nodeId }),
  z.strictObject({ action: z.literal("assets.consolidate") }),
  z.strictObject({ action: z.literal("assets.attach"), nodeId, assetId: id, assetVersionId: id }),
  z.strictObject({ action: z.literal("template.apply"), templateId: z.string().uuid(), origin: position.default({ x: 0, y: 0 }) }),
  z.strictObject({ action: z.literal("operation.undo"), operationId: z.string().uuid() }),
  z.strictObject({ action: z.literal("redraw.configure"), nodeId, sourceNodeId: nodeId, draft: z.strictObject({ version: z.literal(1), modelId: z.string().max(200), style: z.enum(["original", "cinema", "anime", "ink"]), instruction: z.string().max(8000),
    preserve: z.strictObject({ action: z.boolean(), camera: z.boolean(), cuts: z.boolean(), audio: z.boolean() }),
    mappings: z.array(z.strictObject({ id: nodeId, kind: z.enum(["character", "scene", "prop"]), source: z.string().max(500), assetId: nodeId })).max(50) }) }),
  z.strictObject({ action: z.literal("compose.configure"), nodeId, muted: z.boolean().optional(), clips: z.array(z.strictObject({ id: nodeId, nodeId, assetVersionId: id.optional(), trimStart: z.number().min(0), trimEnd: z.number().positive(), speed: z.number().min(0.25).max(4) })).min(1).max(100) }),
]);

export const canvasToolDefinitions = {
  fanjin_canvas_viewport_set: define("保存画布视角和缩放", "保存画布平移和缩放，保留节点内容。先读取 revision；页面下次同步/打开时使用此视角。", z.strictObject({ ...common, viewport: z.strictObject({ x: z.number().min(-1000000).max(1000000), y: z.number().min(-1000000).max(1000000), zoom: z.number().min(0.05).max(4) }) })),
  fanjin_canvas_execution_plan: {
    title: "读取画布分组执行顺序", description: "按与网页相同的依赖顺序列出待执行图片视频节点；循环依赖不执行。Agent 应逐个读取节点参数和输入素材，报价、提交、等待回填后再执行依赖节点。失败即停止，可按原 taskId 恢复。本工具只读，不提交生成。",
    keyPermission: "project:read", memberPermission: "project:read", readOnly: true,
    schema: z.strictObject({ projectId: id.optional(), canvasId: id.optional(), groupId: nodeId.optional(), nodeIds: z.array(nodeId).min(1).max(100).optional() }),
  },
  fanjin_canvas_graph_edit: define("编辑画布连线、分组及节点参数", "一次原子修改画布：复制/删除、连接/断开/参考顺序、分组、节点参数与样式、转绘映射、合成时间线、合并重复资产。失败整批回滚。operation.undo 仅撤销仍与操作后完全一致的画布，不覆盖后续他人修改。此工具只保存，不生成或扣费。", z.strictObject({ ...common, commands: z.array(commands).min(1).max(100) })),
  fanjin_canvas_nodes_create: define("批量新建画布节点",
    "在已有画布批量新建文本、图片、视频、音频或合成节点，可同时填写标题、提示词或文本。省略 position 时放到现有节点下方；返回新 nodeId 和 revision。text 仅用于文本节点。先读取画布取得 expectedRevision；同一幂等键安全重试，不重复建节点。不生成、不扣费，不接受任意媒体 URL。",
    z.strictObject({ ...common, nodes: z.array(z.strictObject({
      type: z.enum(["text", "image", "video", "audio", "compose"]), ...content, position: position.optional(),
      aspectRatio: z.enum(["1:1", "16:9", "9:16", "4:3", "3:4", "21:9"]).optional(),
    })).min(1).max(50) })),
  fanjin_canvas_nodes_update: define("批量修改节点文字",
    "只修改指定节点的 title、prompt 或 text，未提供字段保持不变；text 为文本节点正文。拒绝改动正在生成节点的提示词，保留已有作品和连接。先读 revision；冲突时重读后用新幂等键提交。此操作只保存文字，不提交生成。",
    z.strictObject({ ...common, updates: z.array(z.strictObject({ nodeId, ...content })).min(1).max(50).refine(v => unique(v.map(n => n.nodeId)), "nodeId 不能重复") })),
  fanjin_canvas_arrange: define("排列画布节点",
    "按 nodeIds 顺序横排、竖排或网格排列，或 mode=manual 指定 positions。仅移动指定节点，保留连接、分组、作品和其他节点；自动布局按节点实际尺寸留出间距。默认从所选节点左上角开始。必须读取最新 revision，遇到冲突不能盲目覆盖。",
    z.strictObject({ ...common, nodeIds: z.array(nodeId).min(1).max(100).refine(unique, "nodeIds 不能重复"),
      mode: z.enum(["grid", "horizontal", "vertical", "manual"]).default("grid"),
      columns: z.number().int().min(1).max(20).optional(), gap: z.number().min(40).max(1000).default(100),
      origin: position.optional(), positions: z.array(z.strictObject({ nodeId, ...position.shape })).min(1).max(100).optional(),
    })),
} as const;
export type CanvasToolName = keyof typeof canvasToolDefinitions;
