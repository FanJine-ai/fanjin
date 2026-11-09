import { z } from "zod";
import type { Router } from "express";

// A finite business-action registry. URLs, headers, credentials and arbitrary
// route selection are deliberately not part of the tool input.
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const str = z.string().trim().min(1).max(200);
const object = z.record(z.string(), z.unknown());
const empty = z.strictObject({});
const project = { projectId: id };
const usage = z.enum(["role", "scene", "tool", "action", "audio", "camera", "style", "composition", "other"]);
const ids = z.array(id).min(1).max(100);
type Loader = () => Promise<{ default: Router }>;
export type StudioOperation = {
  name: string; title: string; module: string; method: string; mount: string; path: string;
  load: Loader; schema: z.ZodObject; keyPermission: string; memberPermission: string;
  readOnly: boolean; projectField?: string; execution?: boolean;
  routeSchema?: boolean;
  schemaLoader?: () => Promise<z.ZodObject>;
  bodyIdempotency?: boolean;
};
export const studioOperations: StudioOperation[] = [];
function add(module: string, mount: string, load: Loader, rows: Array<[
  string, string, string, string, z.ZodObject, string, string?, string?, boolean?
]>) {
  for (const [name, title, method, path, schema, keyPermission, memberPermission = keyPermission, projectField, execution] of rows) {
    studioOperations.push({ name, title, module, method, mount, path, schema, keyPermission, memberPermission, projectField, execution,
      readOnly: keyPermission.endsWith(":read"), load });
  }
}
const read = "project:read", write = "project:write", del = "project:delete";
const ar = "asset:read", aw = "asset:write";
const idem = { idempotencyKey: z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/).optional() };
function route(name: string, title: string, module: string, mount: string, load: Loader,
  permission: string, options: { method?: string; path?: string; fields?: z.ZodRawShape; schemaLoader?: () => Promise<z.ZodObject>; empty?: boolean; projectField?: string; execution?: boolean; memberPermission?: string } = {}) {
  const method = options.method || "POST", path = options.path || "/";
  const pathFields: Record<string, z.ZodType> = {};
  for (const match of `${mount}${path}`.matchAll(/:([A-Za-z0-9_]+)/g)) pathFields[match[1]] = /^(projectId|canvasId)$/.test(match[1]) ? id : str;
  studioOperations.push({ name, title, module, method, mount, path, load, keyPermission: permission,
    memberPermission: options.memberPermission || (permission === "workflow:execute" ? "generation:create" : permission),
    schema: z.strictObject({ ...pathFields, ...(method !== "GET" ? idem : {}), ...options.fields }),
    readOnly: permission.endsWith(":read"), routeSchema: !options.empty && !options.schemaLoader,
    schemaLoader: options.schemaLoader, projectField: options.projectField, execution: options.execution || permission === "workflow:execute" });
}
add("files", "/api/file-manager", () => import("@/routes/file-manager"), [
  ["files.list", "搜索全部可见文件、用途、类型与回收站", "POST", "/list", z.strictObject({ projectId: id.optional(), folderId: z.string().uuid().nullable().optional(), trash: z.boolean().optional(), source: z.enum(["uploaded", "generated"]).optional(), type: z.enum(["image", "video", "audio", "document", "role", "scene", "tool"]).optional(), usage: z.enum([...usage.options, "uncategorized"]).optional(), keyword: z.string().max(200).optional(), page: id.default(1), limit: id.max(60).default(36) }), ar, read],
  ["files.update", "修改文件名、标签，移入或恢复回收站", "POST", "/update", z.strictObject({ assetId: id, expectedRevision: id, name: str.optional(), tags: z.array(z.string().min(1).max(40)).max(20).optional(), action: z.enum(["trash", "restore"]).optional() }), aw, write],
  ["files.folders", "读取项目文件夹", "POST", "/folders", z.strictObject(project), ar, read],
  ["files.folder.save", "创建、修改或删除文件夹", "POST", "/folder", z.strictObject({ ...project, id: z.string().uuid().optional(), name: str.optional(), parentId: z.string().uuid().nullable().optional(), expectedRevision: id.optional(), remove: z.boolean().optional() }), aw, write],
  ["files.move", "移动项目中的文件引用", "POST", "/place", z.strictObject({ ...project, refId: str, folderId: z.string().uuid().nullable(), expectedRevision: id }), aw, write],
  ["history.visibility", "隐藏或恢复生成历史", "POST", "/history-visibility", z.strictObject({ ids: z.array(z.string().uuid()).min(1).max(100), hidden: z.boolean() }), aw, write],
  ["history.import", "把已有生成结果导入项目；重复导入复用资产", "POST", "/history-import", z.strictObject({ ...project, mediaId: z.string().uuid() }), aw, write],
  ["files.url", "取得已有文件的短期预览地址", "POST", "/url", z.strictObject({ assetId: id, versionId: id }), ar, read],
]);
add("assets", "/api/assets", () => import("@/routes/assets/metadata"), [
  ["assets.classify", "设置角色、场景、道具等用途分类", "POST", "/metadata", z.strictObject({ ...project, id, usage: usage.nullable() }), aw, write],
  ["assets.group.create", "把同一角色、场景或道具的多状态素材建组", "POST", "/groups", z.strictObject({ ...project, name: str.max(80), usage: z.enum(["role", "scene", "tool"]), assetIds: ids }), aw, write],
]);
add("projects", "/api/project-folders", () => import("@/routes/project-folders"), [
  ["project_folders.list", "读取项目文件夹", "GET", "/", empty, read],
  ["project_folders.create", "创建项目文件夹", "POST", "/", z.strictObject({ name: str.optional(), projectIds: z.array(str).max(500).optional() }), write],
  ["project_folders.update", "修改文件夹名称或所含项目", "PATCH", "/:folderId", z.strictObject({ folderId: str, name: str.optional(), projectIds: z.array(str).max(500).optional() }), write],
  ["project_folders.delete", "删除项目文件夹", "DELETE", "/:folderId", z.strictObject({ folderId: str }), del],
]);
add("projects", "/api/projects/:projectId/canvases", () => import("@/routes/projects/[projectId]/canvases/index"), [
  ["canvases.list", "列出项目全部画布", "GET", "/", z.strictObject(project), read],
  ["canvases.create", "创建项目内的新画布", "POST", "/", z.strictObject({ ...project, name: str.optional() }), write],
]);
add("projects", "/api/projects/:projectId/canvases/:canvasId", () => import("@/routes/projects/[projectId]/canvases/[canvasId]"), [
  ["canvases.rename", "修改画布名称", "PATCH", "/", z.strictObject({ ...project, canvasId: id, name: str, expectedRevision: id }), write],
]);
add("projects", "/api/projects/:projectId", () => import("@/routes/projects/[projectId]/index"), [
  ["projects.cover.update", "更换项目封面", "PATCH", "/", z.strictObject({ ...project, coverImageUrl: z.string().max(400_000) }), write],
]);
route("projects.deletion.status", "查询项目或素材删除进度及失败原因", "projects", "/api/deletion/operations/:operationId", () => import("@/routes/deletion/operations/[operationId]"), read, { method: "GET", empty: true });
route("editing.autocut", "按网页同一算法生成初剪时间线、字幕和节奏点；不付费渲染", "editing", "/api/production/workbench/autoEdit", () => import("@/routes/production/workbench/autoEdit"), read, { schemaLoader: () => import("@/routes/production/workbench/autoEdit").then(m => m.bodySchema) });
add("projects", "/api/project/editProject", () => import("@/routes/project/editProject"), [
  ["projects.update", "修改完整项目制作资料；先读取现有资料", "POST", "/", z.strictObject({ id, name: str, intro: z.string(), type: z.string(), artStyle: z.string(), directorManual: z.string(), videoRatio: z.string(), imageModel: z.string(), videoModel: z.string(), projectType: z.string(), imageQuality: z.string(), mode: z.string() }), write, write, "id"],
]);
add("projects", "/api/project/delProject", () => import("@/routes/project/delProject"), [
  ["projects.delete", "删除项目，沿用网页删除流程", "POST", "/", z.strictObject({ id }), del, del, "id"],
]);
add("assets", "/api/assets/library", () => import("@/routes/assets/library"), [
  ["assets.library", "查询个人、工作区、共享和项目引用素材", "GET", "/", z.strictObject({ view: z.enum(["mine", "workspace", "shared_with_me", "project_refs", "all"]).optional(), projectId: id.optional(), type: str.optional(), name: z.string().max(200).optional(), page: id.optional(), limit: id.max(100).optional() }), ar, read],
  ["assets.grants.list", "读取素材共享授权", "GET", "/:assetId/grants", z.strictObject({ assetId: id }), ar, read],
  ["assets.grants.create", "添加素材共享授权", "POST", "/:assetId/grants", z.strictObject({ assetId: id, granteeType: z.enum(["user", "workspace"]), granteeUserId: id.nullable().optional(), canView: z.boolean().optional(), canUse: z.boolean().optional(), canManage: z.boolean().optional(), expectedOwnershipRevision: id.optional() }), aw, write],
  ["assets.grants.revoke", "撤销素材共享授权", "DELETE", "/:assetId/grants/:grantId", z.strictObject({ assetId: id, grantId: str }), aw, write],
  ["assets.transfer", "把本人素材转入当前工作区", "POST", "/:assetId/transfer-to-workspace", z.strictObject({ assetId: id, expectedRevision: id }), aw, write],
  ["assets.reference.add", "把已有资产引用到项目", "POST", "/projects/:projectId/refs", z.strictObject({ ...project, assetId: id, assetVersionId: str.optional() }), aw, write],
  ["assets.reference.remove", "移除项目中的资产引用", "DELETE", "/projects/:projectId/refs/:refId", z.strictObject({ ...project, refId: str }), aw, write],
]);


// Web-backed operations use the exact route validators for input discovery.
route("history.list", "统一查询网页生成历史", "history", "/api/workbench/library/list", () => import("@/routes/workbench/library/list"), "asset:read", { memberPermission: "project:read" });
route("assets.profile.create", "新建角色场景道具资料", "assets", "/api/assets/addAssets", () => import("@/routes/assets/addAssets"), "project:write");
route("assets.profile.update", "修改素材描述与资料", "assets", "/api/assets/updateAssets", () => import("@/routes/assets/updateAssets"), "project:write");
route("assets.profile.delete", "删除资产资料", "assets", "/api/assets/delAssets", () => import("@/routes/assets/delAssets"), "project:delete");
route("assets.versions", "读取资产全部版本", "assets", "/api/assets/getImage", () => import("@/routes/assets/getImage"), "project:read");
route("canvas.asset_snapshots.list", "读取节点组资产", "canvas", "/api/canvas/assets", () => import("@/routes/canvas/assets"), "project:read", { method: "GET" });
route("canvas.asset_snapshots.create", "保存节点组资产", "canvas", "/api/canvas/assets", () => import("@/routes/canvas/assets"), "project:write");
route("canvas.asset_snapshots.update", "修改节点组资产", "canvas", "/api/canvas/assets", () => import("@/routes/canvas/assets"), "project:write", { method: "PATCH", path: "/:assetId" });
route("canvas.asset_snapshots.delete", "删除节点组资产", "canvas", "/api/canvas/assets", () => import("@/routes/canvas/assets"), "project:delete", { method: "DELETE", path: "/:assetId" });
route("creation.plan", "生成导演计划", "creation", "/api/workbench/create/directorPlan", () => import("@/routes/workbench/create/directorPlan"), "workflow:execute");
route("creation.materialize", "把导演计划创建为项目和分镜", "creation", "/api/workbench/create/materialize", () => import("@/routes/workbench/create/materialize"), "workflow:execute");
route("canvas.text.generate", "生成或修改画布文字产物", "creation", "/api/workbench/canvas/text", () => import("@/routes/workbench/canvas/text"), "workflow:execute");
route("canvas.compose", "合成视频片段", "creation", "/api/workbench/canvas/composeVideo", () => import("@/routes/workbench/canvas/composeVideo"), "workflow:execute");
route("video.analysis.start", "启动逐帧拉片", "creation", "/api/workbench/canvas/videoStoryAnalysis", () => import("@/routes/workbench/canvas/videoStoryAnalysis"), "workflow:execute");
route("video.analysis.status", "读取拉片结果", "creation", "/api/workbench/canvas/videoStoryAnalysis", () => import("@/routes/workbench/canvas/videoStoryAnalysis"), "project:read", { path: "/status" });
route("video.analysis.cancel", "取消拉片", "creation", "/api/workbench/canvas/videoStoryAnalysis", () => import("@/routes/workbench/canvas/videoStoryAnalysis"), "generation:create", { path: "/cancel" });
route("video.enhance.create", "按报价提交视频超分", "creation", "/api/workbench/video/enhance/create", () => import("@/routes/workbench/video/enhance/create"), "workflow:execute");
route("novel.list", "读取小说章节", "novel", "/api/novel/getNovel", () => import("@/routes/novel/getNovel"), "project:read");
route("novel.indices", "读取小说索引", "novel", "/api/novel/getNovelIndex", () => import("@/routes/novel/getNovelIndex"), "project:read");
route("novel.chapter", "读取小说章节详情", "novel", "/api/novel/getNovelData", () => import("@/routes/novel/getNovelData"), "project:read");
route("novel.import", "导入小说正文", "novel", "/api/novel/addNovel", () => import("@/routes/novel/addNovel"), "project:write");
route("novel.update", "修改小说章节", "novel", "/api/novel/updateNovel", () => import("@/routes/novel/updateNovel"), "project:write");
route("novel.events.status", "读取章节事件分析状态", "novel", "/api/novel/getNovelEventState", () => import("@/routes/novel/getNovelEventState"), "project:read");
route("novel.events.generate", "生成章节事件", "novel", "/api/novel/event/generateEvents", () => import("@/routes/novel/event/generateEvents"), "workflow:execute");
route("novel.events.list", "读取章节事件", "novel", "/api/novel/event/getEvent", () => import("@/routes/novel/event/getEvent"), "project:read");
route("novel.events.delete", "删除章节事件", "novel", "/api/novel/event/batchDeleteEvent", () => import("@/routes/novel/event/batchDeleteEvent"), "project:write");
route("scripts.list", "读取剧本", "scripts", "/api/script/getScrptApi", () => import("@/routes/script/getScrptApi"), "project:read");
route("scripts.create", "新建剧本", "scripts", "/api/script/addScript", () => import("@/routes/script/addScript"), "project:write");
route("scripts.import", "批量导入剧本", "scripts", "/api/script/batchAddScript", () => import("@/routes/script/batchAddScript"), "project:write");
route("scripts.update", "修改剧本", "scripts", "/api/script/updateScript", () => import("@/routes/script/updateScript"), "project:write");
route("scripts.delete", "删除剧本", "scripts", "/api/script/delScript", () => import("@/routes/script/delScript"), "project:delete");
route("storyboards.list", "读取分镜", "storyboards", "/api/production/getStoryboardData", () => import("@/routes/production/getStoryboardData"), "project:read");
route("storyboards.create", "创建分镜", "storyboards", "/api/production/storyboard/addStoryboard", () => import("@/routes/production/storyboard/addStoryboard"), "project:write");
route("storyboards.update", "修改分镜", "storyboards", "/api/production/storyboard/editStoryboardInfo", () => import("@/routes/production/storyboard/editStoryboardInfo"), "project:write");
route("storyboards.delete", "批量删除分镜", "storyboards", "/api/production/storyboard/batchDelete", () => import("@/routes/production/storyboard/batchDelete"), "project:write");
route("storyboards.reorder", "排列分镜", "storyboards", "/api/production/storyboard/reorderStoryboard", () => import("@/routes/production/storyboard/reorderStoryboard"), "project:write");
route("storyboards.images.generate", "批量生成分镜图片", "storyboards", "/api/production/storyboard/batchGenerateImage", () => import("@/routes/production/storyboard/batchGenerateImage"), "workflow:execute");
route("production.list", "读取制作素材与任务", "production", "/api/production/workbench/getGenerateData", () => import("@/routes/production/workbench/getGenerateData"), "project:read");
route("production.status", "读取制作流水线状态", "production", "/api/production/workbench/getPipelineStatus", () => import("@/routes/production/workbench/getPipelineStatus"), "project:read");
route("production.videos.generate", "批量生成镜头视频", "production", "/api/production/workbench/batchGenerateVideo", () => import("@/routes/production/workbench/batchGenerateVideo"), "workflow:execute");
route("production.videos.select", "选择镜头视频版本", "production", "/api/production/workbench/selectVideo", () => import("@/routes/production/workbench/selectVideo"), "project:write");
route("production.videos.delete", "删除镜头视频版本", "production", "/api/production/workbench/delVideo", () => import("@/routes/production/workbench/delVideo"), "project:write");
route("production.prompt.update", "修改镜头提示词", "production", "/api/production/workbench/updateVideoPrompt", () => import("@/routes/production/workbench/updateVideoPrompt"), "project:write");
route("production.duration.update", "修改镜头时长", "production", "/api/production/workbench/updateVideoDuration", () => import("@/routes/production/workbench/updateVideoDuration"), "project:write");
route("editing.draft.get", "读取剪辑草稿", "editing", "/api/production/workbench/getEditorDraft", () => import("@/routes/production/workbench/getEditorDraft"), "project:read");
route("editing.draft.save", "保存剪辑草稿", "editing", "/api/production/workbench/saveEditorDraft", () => import("@/routes/production/workbench/saveEditorDraft"), "project:write");
route("editing.versions", "读取剪辑草稿历史版本", "editing", "/api/production/workbench/listEditorDraftVersions", () => import("@/routes/production/workbench/listEditorDraftVersions"), "project:read");
route("editing.restore", "恢复剪辑草稿版本", "editing", "/api/production/workbench/restoreEditorDraftVersion", () => import("@/routes/production/workbench/restoreEditorDraftVersion"), "project:write");
route("editing.render", "合成最终成片", "editing", "/api/production/workbench/renderFinalVideo", () => import("@/routes/production/workbench/renderFinalVideo"), "workflow:execute");
route("editing.result", "读取最终成片", "editing", "/api/production/workbench/getFinalVideo", () => import("@/routes/production/workbench/getFinalVideo"), "project:read");
route("director.scene.get", "读取 3D 预演场景", "director", "/api/production/director/getScene", () => import("@/routes/production/director/getScene"), "project:read");
route("director.scene.save", "保存 3D 预演场景及分镜绑定", "director", "/api/production/director/saveScene", () => import("@/routes/production/director/saveScene"), "project:write");


route("video.enhance.quote", "视频超分报价", "creation", "/api/workbench/video/enhance/quote", () => import("@/routes/workbench/video/enhance/quote"), "generation:quote", { schemaLoader: () => import("@/routes/workbench/video/enhance/quote").then(m => m.bodySchema), memberPermission: "generation:create" });
route("sessions.get", "读取项目当前创作会话", "creation", "/api/projects/:projectId/creationSessions/current", () => import("@/routes/projects/[projectId]/creationSessions/current"), "project:read", { method: "GET", empty: true });
route("sessions.ensure", "建立或恢复创作会话", "creation", "/api/projects/:projectId/creationSessions/current", () => import("@/routes/projects/[projectId]/creationSessions/current"), "project:write", { schemaLoader: () => import("@/routes/projects/[projectId]/creationSessions/current").then(m => m.ensureSchema) });
route("sessions.update", "保存创作会话参数和参考素材", "creation", "/api/projects/:projectId/creationSessions/:sessionId", () => import("@/routes/projects/[projectId]/creationSessions/[sessionId]"), "project:write", { method: "PUT", schemaLoader: () => import("@/routes/projects/[projectId]/creationSessions/[sessionId]").then(m => m.updateSchema) });
route("canvas.templates.list", "列出画布工作流模板", "canvas", "/api/canvas/workflows", () => import("@/routes/canvas/workflows"), "project:read", { method: "GET", empty: true });
route("canvas.templates.create", "保存画布工作流模板", "canvas", "/api/canvas/workflows", () => import("@/routes/canvas/workflows"), "project:write", { schemaLoader: () => import("@/routes/canvas/workflows").then(m => m.createSchema) });
route("canvas.templates.delete", "删除画布工作流模板", "canvas", "/api/canvas/workflows", () => import("@/routes/canvas/workflows"), "project:delete", { method: "DELETE", path: "/:workflowId", empty: true });
route("canvas.shares.list", "读取画布分享", "sharing", "/api/canvas/publication", () => import("@/routes/canvas/publication/index"), "project:read", { method: "GET", path: "/shares", schemaLoader: () => import("@/routes/canvas/publication/index").then(m => m.scopeSchema) });
route("canvas.shares.create", "创建画布分享链接", "sharing", "/api/canvas/publication", () => import("@/routes/canvas/publication/index"), "project:write", { path: "/shares", schemaLoader: () => import("@/routes/canvas/publication/index").then(m => m.createShareSchema) });
route("canvas.fjtv.get", "读取社区发布状态", "sharing", "/api/canvas/publication", () => import("@/routes/canvas/publication/index"), "project:read", { method: "GET", path: "/fjtv", schemaLoader: () => import("@/routes/canvas/publication/index").then(m => m.scopeSchema) });
route("canvas.fjtv.submit", "投稿至社区", "sharing", "/api/canvas/publication", () => import("@/routes/canvas/publication/index"), "project:write", { path: "/fjtv", schemaLoader: () => import("@/routes/canvas/publication/index").then(m => m.createPublicationSchema) });
route("agent.threads.list", "列出项目 Agent 会话", "agent", "/api/agent/threads", () => import("@/routes/agent/threads/index"), "project:read", { method: "GET", schemaLoader: () => import("@/routes/agent/threads/index").then(m => m.listSchema) });
route("agent.threads.create", "创建 Agent 会话", "agent", "/api/agent/threads", () => import("@/routes/agent/threads/index"), "project:write", { schemaLoader: () => import("@/routes/agent/threads/index").then(m => m.createSchema) });
route("agent.threads.ensure", "查找或恢复 Agent 会话", "agent", "/api/agent/threads", () => import("@/routes/agent/threads/index"), "project:write", { path: "/ensure", schemaLoader: () => import("@/routes/agent/threads/index").then(m => m.ensureSchema) });
route("agent.threads.get", "读取 Agent 会话", "agent", "/api/agent/threads/:id", () => import("@/routes/agent/threads/[id]"), "project:read", { method: "GET", empty: true });
route("agent.messages.list", "读取会话消息", "agent", "/api/agent/threads/:id/messages", () => import("@/routes/agent/threads/[id]/messages"), "project:read", { method: "GET", schemaLoader: () => import("@/routes/agent/threads/[id]/messages").then(m => m.listSchema) });
route("agent.messages.send", "向 Agent 发送消息并启动运行", "agent", "/api/agent/threads/:id/messages", () => import("@/routes/agent/threads/[id]/messages"), "workflow:execute", { schemaLoader: () => import("@/routes/agent/threads/[id]/messages").then(m => m.sendSchema) });
route("agent.runs.get", "读取 Agent 运行", "agent", "/api/agent/runs/:id", () => import("@/routes/agent/runs/[id]"), "project:read", { method: "GET", empty: true });
route("agent.runs.steps", "读取 Agent 运行步骤", "agent", "/api/agent/runs/:id/steps", () => import("@/routes/agent/runs/[id]/steps"), "project:read", { method: "GET", schemaLoader: () => import("@/routes/agent/runs/[id]/steps").then(m => m.listSchema) });
route("agent.runs.approvals", "读取 Agent 审批", "agent", "/api/agent/runs/:id/approvals", () => import("@/routes/agent/runs/[id]/approvals"), "project:read", { method: "GET", schemaLoader: () => import("@/routes/agent/runs/[id]/approvals").then(m => m.listSchema) });
route("agent.runs.cancel", "取消 Agent 运行", "agent", "/api/agent/runs/:id/cancel", () => import("@/routes/agent/runs/[id]/cancel"), "generation:create", { schemaLoader: () => import("@/routes/agent/runs/[id]/cancel").then(m => m.bodySchema) });
route("agent.approvals.decide", "批准或拒绝待执行操作", "agent", "/api/agent/approvals/:id/decision", () => import("@/routes/agent/approvals/[id]/decision"), "workflow:execute", { schemaLoader: () => import("@/routes/agent/approvals/[id]/decision").then(m => m.decisionSchema) });
route("agent.skills", "读取可用技能", "agent", "/api/agent/skills", () => import("@/routes/agent/skills/index"), "project:read", { method: "GET", empty: true });
route("agent.models", "读取对话模型", "agent", "/api/agent/chat-models", () => import("@/routes/agent/chat-models/index"), "model:read", { method: "GET", empty: true, memberPermission: "project:read" });
route("agent.budget.get", "读取项目 Agent 预算", "agent", "/api/agent/projects/:id/budget", () => import("@/routes/agent/projects/[id]/budget"), "project:read", { method: "GET", empty: true });
route("agent.budget.update", "设置项目 Agent 预算", "agent", "/api/agent/projects/:id/budget", () => import("@/routes/agent/projects/[id]/budget"), "workflow:execute", { method: "PUT", schemaLoader: () => import("@/routes/agent/projects/[id]/budget").then(m => m.putBudgetSchema), memberPermission: "project:write" });
route("workspace.update", "修改工作区资料", "workspace", "/api/workspace/update", () => import("@/routes/workspace/update"), "workspace:write", { schemaLoader: () => import("@/routes/workspace/update").then(m => m.bodySchema) });
route("workspace.members.list", "读取工作区成员和配额", "workspace", "/api/workspace/subaccounts/list", () => import("@/routes/workspace/subaccounts/list"), "member:read", { schemaLoader: () => import("@/routes/workspace/subaccounts/list").then(m => m.bodySchema) });
route("workspace.members.update", "修改成员角色和配额", "workspace", "/api/workspace/subaccounts/update", () => import("@/routes/workspace/subaccounts/update"), "member:write", { schemaLoader: () => import("@/routes/workspace/subaccounts/update").then(m => m.bodySchema) });
route("workspace.members.disable", "停用工作区成员", "workspace", "/api/workspace/subaccounts/disable", () => import("@/routes/workspace/subaccounts/disable"), "member:write", { schemaLoader: () => import("@/routes/workspace/subaccounts/disable").then(m => m.bodySchema) });
route("workspace.invitations.list", "读取工作区邀请", "workspace", "/api/workspace/invitations/list", () => import("@/routes/workspace/invitations/list"), "member:read", { schemaLoader: () => import("@/routes/workspace/invitations/list").then(m => m.bodySchema) });
route("workspace.invitations.create", "创建工作区邀请", "workspace", "/api/workspace/invitations/create", () => import("@/routes/workspace/invitations/create"), "member:write", { schemaLoader: () => import("@/routes/workspace/invitations/create").then(m => m.bodySchema) });
route("workspace.invitations.revoke", "撤销工作区邀请", "workspace", "/api/workspace/invitations/revoke", () => import("@/routes/workspace/invitations/revoke"), "member:write", { schemaLoader: () => import("@/routes/workspace/invitations/revoke").then(m => m.bodySchema) });
route("billing.overview", "读取工作区费用概览", "billing", "/api/billing/overview", () => import("@/routes/billing/overview"), "billing:read", { method: "GET", schemaLoader: () => import("@/routes/billing/overview").then(m => m.bodySchema) });
route("billing.orders.list", "读取充值订单", "billing", "/api/billing/payment/orders/list", () => import("@/routes/billing/payment/orders/list"), "billing:read", { schemaLoader: () => import("@/routes/billing/payment/orders/list").then(m => m.bodySchema) });
route("billing.orders.create", "创建充值订单并返回本人付款入口", "billing", "/api/billing/payment/orders/create", () => import("@/routes/billing/payment/orders/create"), "billing:request:create", { schemaLoader: () => import("@/routes/billing/payment/orders/create").then(m => m.bodySchema) });
route("billing.orders.query", "查询充值订单", "billing", "/api/billing/payment/orders/query/:id", () => import("@/routes/billing/payment/orders/query/[id]"), "billing:read", { empty: true });
route("billing.orders.refund", "申请订单退款", "billing", "/api/billing/payment/orders/refund/:id", () => import("@/routes/billing/payment/orders/refund/[id]"), "billing:request:create", { empty: true });
route("billing.requests.list", "读取服务申请单", "billing", "/api/billing/serviceRequests/list", () => import("@/routes/billing/serviceRequests/list"), "billing:read", { schemaLoader: () => import("@/routes/billing/serviceRequests/list").then(m => m.bodySchema) });
route("developer.tasks", "查询中转 API 任务", "developer", "/api/developer/tasks", () => import("@/routes/developer/tasks"), "usage:read", { schemaLoader: () => import("@/routes/developer/tasks").then(m => m.bodySchema), memberPermission: "api_key:read" });
route("developer.logs", "查询中转 API 请求日志", "developer", "/api/developer/requestLogs", () => import("@/routes/developer/requestLogs"), "usage:read", { schemaLoader: () => import("@/routes/developer/requestLogs").then(m => m.bodySchema), memberPermission: "api_key:read" });
route("account.profile", "读取本人资料", "account", "/api/account/profile", () => import("@/routes/account/profile"), "account:read", { method: "GET", empty: true, memberPermission: "workspace:read" });
route("feedback.submit", "提交问题反馈", "account", "/api/feedback", () => import("@/routes/feedback"), "account:write", { schemaLoader: () => import("@/routes/feedback").then(m => m.payloadSchema), memberPermission: "workspace:read" });


route("scripts.assets.extract", "提取剧本人物场景道具", "scripts", "/api/script/extractAssets", () => import("@/routes/script/extractAssets"), "workflow:execute");
route("scripts.assets.status", "查询素材提取尝试", "scripts", "/api/script/extractAssets", () => import("@/routes/script/extractAssets"), "project:read", { path: "/status", memberPermission: "generation:create" });
route("scripts.assets.merge", "合并批次素材提案", "scripts", "/api/script/extractAssets", () => import("@/routes/script/extractAssets"), "project:write", { path: "/merge", memberPermission: "generation:create" });
route("scripts.assets.confirm", "确认提取素材并入库", "scripts", "/api/script/extractAssets", () => import("@/routes/script/extractAssets"), "asset:write", { path: "/confirm", memberPermission: "project:write" });
route("novel.events.analyze", "分析指定小说章节", "novel", "/api/novel/eventAnalysis", () => import("@/routes/novel/eventAnalysis"), "workflow:execute");
route("novel.events.task", "查询事件分析任务", "novel", "/api/novel/event/generateEvents", () => import("@/routes/novel/event/generateEvents"), "project:read", { path: "/status" });
route("novel.events.cancel", "取消未派发的事件分析", "novel", "/api/novel/event/generateEvents", () => import("@/routes/novel/event/generateEvents"), "generation:create", { path: "/cancel" });
route("novel.delete", "删除小说章节", "novel", "/api/novel/batchDeleteNovel", () => import("@/routes/novel/batchDeleteNovel"), "project:delete");
route("novel.file.extract", "从上传文档抽取小说正文", "novel", "/api/novel/extractFile", () => import("@/routes/novel/extractFile"), "project:write", { schemaLoader: () => import("@/routes/novel/extractFile").then(m => m.bodySchema) });
route("creation.tasks", "读取网页项目生成任务", "creation", "/api/workbench/create/tasks", () => import("@/routes/workbench/create/tasks"), "generation:read", { memberPermission: "project:read" });
route("canvas.task.get", "读取网页节点生成结果", "creation", "/api/workbench/canvas/tasks/:id", () => import("@/routes/workbench/canvas/tasks/[id]"), "generation:read", { method: "GET", empty: true, memberPermission: "project:read" });
route("canvas.task.cancel", "取消网页节点任务", "creation", "/api/workbench/canvas/tasks/:id", () => import("@/routes/workbench/canvas/tasks/[id]"), "generation:create", { method: "DELETE", empty: true });
route("video.enhance.status", "查询视频超分任务", "creation", "/api/workbench/video/enhance/task", () => import("@/routes/workbench/video/enhance/task"), "generation:read", { fields: { taskId: str }, empty: true, memberPermission: "project:read" });
route("canvas.capabilities", "查询当前画布实际开放能力", "canvas", "/api/workbench/capabilities", () => import("@/routes/workbench/capabilities/index"), "model:read", { method: "GET", empty: true, memberPermission: "project:read" });
route("models.catalog", "查询图片视频音频文字模型", "creation", "/api/workbench/models/catalog", () => import("@/routes/workbench/models/catalog"), "model:read", { method: "GET", fields: { type: z.enum(["image", "video", "audio", "text"]).optional() }, empty: true, memberPermission: "project:read" });
route("canvas.shares.revoke", "撤销画布分享", "sharing", "/api/canvas/publication", () => import("@/routes/canvas/publication/index"), "project:write", { method: "DELETE", path: "/shares/:shareId", fields: { projectId: id, expectedRevision: id }, empty: true });
route("agent.events", "按游标查询 Agent 新消息与事件", "agent", "/api/agent/threads/:id/events", () => import("@/routes/agent/threads/[id]/events"), "project:read", { method: "GET", fields: { after: z.number().int().min(0).optional(), format: z.literal("json").default("json") }, empty: true });
route("account.profile.update", "修改本人显示名称", "account", "/api/account/profile", () => import("@/routes/account/profile"), "account:write", { fields: { displayName: z.string().trim().min(2).max(64) }, empty: true, memberPermission: "workspace:read" });
route("billing.membership", "读取会员状态与套餐", "billing", "/api/billing/membership", () => import("@/routes/billing/membership/index"), "billing:read", { path: "/status", empty: true });
route("billing.membership.quote", "获取当前套餐价格", "billing", "/api/billing/membership", () => import("@/routes/billing/membership/index"), "billing:request:create", { path: "/quote", fields: { planId: str, months: id, seedanceShare: z.number().int(), version: str }, empty: true });

route("developer.models", "读取 API 调试模型与兼容协议", "developer", "/api/developer/models", () => import("@/routes/developer/models"), "model:read", { memberPermission: "api_key:read", schemaLoader: async () => (await import("@/routes/developer/models")).bodySchema });
route("developer.keys.list", "读取本人可见密钥的脱敏信息与额度", "developer", "/api/apiKeys/list", () => import("@/routes/apiKeys/list"), "account:read", { memberPermission: "api_key:read", schemaLoader: async () => (await import("@/routes/apiKeys/list")).bodySchema });
route("publications.list", "浏览已公开的 FJTV 作品", "sharing", "/api/public/canvas", () => import("@/routes/public/canvas/index"), "project:read", { method: "GET", path: "/fjtv", fields: { limit: id.max(100).optional() }, empty: true });
route("publications.get", "读取公开作品", "sharing", "/api/public/canvas", () => import("@/routes/public/canvas/index"), "project:read", { method: "GET", path: "/fjtv/:slug", empty: true });
route("shares.get", "读取仍有效的分享画布", "sharing", "/api/public/canvas", () => import("@/routes/public/canvas/index"), "project:read", { method: "GET", path: "/shares/:slug", empty: true });
route("service.notice", "读取平台公告", "account", "/api/developer/config", () => import("@/routes/developer/config"), "account:read", { method: "GET", path: "/notice", empty: true, memberPermission: "workspace:read" });
route("service.version", "读取当前服务版本", "account", "/api/other/getVersion", () => import("@/routes/other/getVersion"), "account:read", { method: "GET", empty: true, memberPermission: "workspace:read" });

route("ui.state.get", "读取主题字号、通知和已读状态", "account", "/api/account/uiState", () => import("@/routes/account/uiState"), "account:read", { method: "GET", empty: true, memberPermission: "workspace:read" });
route("ui.state.update", "修改主题字号、通知已读或未读；网页自动同步", "account", "/api/account/uiState", () => import("@/routes/account/uiState"), "account:write", { schemaLoader: () => import("@/routes/account/uiState").then(m => m.bodySchema), memberPermission: "workspace:read" });

export const studioOperationNames = () => studioOperations.map(op => op.name);
export function studioOperation(name: string) { return studioOperations.find(op => op.name === name); }
export function describeStudioOperation(op: StudioOperation, schema = op.schema) {
  return { name: op.name, title: op.title, module: op.module, readOnly: op.readOnly,
    keyPermission: op.keyPermission, memberPermission: op.memberPermission,
    inputSchema: z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }),
    ...(!op.readOnly ? { retry: "Never blindly retry an interrupted write. Read its result first; pass the original idempotency key when supported by its schema." } : {}) };
}

export const studioToolDefinitions = {
  fanjin_studio_operations: {
    title: "查询工作台操作与参数", description: "查询网页业务操作的 MCP 目录。按 module 筛选，或提供 operation 读取其完整 inputSchema。只返回当前成员和密钥有权调用的操作。调用 fanjin_studio_execute 时 parameters 必须符合该 schema；不会接受 URL、方法或请求头。",
    keyPermission: null, memberPermission: "workspace:read", readOnly: true,
    schema: z.strictObject({ module: str.optional(), operation: str.optional() }),
  },
  fanjin_studio_execute: {
    title: "执行工作台业务操作", description: "执行已登记的项目、资产、历史和制作操作，复用网页处理流程及权限检查。先用 fanjin_studio_operations 获取参数。parameters 不接受任意 HTTP 地址或认证信息。写入超时后先查状态，不能盲目重试。",
    keyPermission: null, memberPermission: "workspace:read", readOnly: false,
    schema: z.strictObject({ operation: str, parameters: object.default({}) }),
  },
} as const;
