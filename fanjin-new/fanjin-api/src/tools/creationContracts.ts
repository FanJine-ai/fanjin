import { z } from "zod";
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const uuid = z.string().uuid();
const key = z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const page = { limit: z.number().int().min(1).max(100).default(20), cursor: z.string().min(1).max(2048).optional() };
const newGenerationRequestSchema = z.strictObject({
  renderMode: z.enum(["standard", "draft"]).optional(),
  outputFormat: z.enum(["mp4", "mov"]).optional(),
  projectId: id, type: z.enum(["image", "video"]), modelId: z.string().trim().min(1).max(200),
  prompt: z.string().trim().max(8000), aspectRatio: z.string().min(1).max(20),
  resolution: z.string().min(1).max(20), duration: z.union([z.literal(-1), z.number().int().min(1).max(60)]).optional(),
  count: z.number().int().min(1).max(10).default(1), audio: z.boolean().default(false),
  mode: z.string().min(1).max(64).optional(),
  /** generate = 新抽；extend = 续写上一条；edit = 修改上一条。 */
  operation: z.enum(["generate", "extend", "edit"]).default("generate"),
  /** extend/edit 的完整原片，必须同时包含在 references 中；首尾帧不能替代原片。 */
  sourceAssetVersionId: z.string().regex(/^[1-9]\d*$/).max(16).optional(),
  references: z.array(z.strictObject({
    assetVersionId: z.string().regex(/^[1-9]\d*$/).max(16).refine(v => Number.isSafeInteger(Number(v)), "Invalid asset version ID"),
    role: z.enum(["subject", "style", "storyboard", "first_frame", "last_frame", "source_video"]),
    trim: z.strictObject({ startMs: z.number().int().min(0), endMs: z.number().int().positive() }).refine(v => v.endMs > v.startMs, "裁剪结束时间必须晚于开始时间").optional(),
  })).max(50).default([]),
}).superRefine((request, context) => {
  if (!request.prompt && (request.type !== "video" || !request.references.length || request.operation === "edit")) context.addIssue({ code: z.ZodIssueCode.custom, path: ["prompt"], message: "请输入提示词；视频参考生成可仅使用素材，编辑仍需修改指令" });
  // Video model limits are enforced by the catalog and adapter after asset types are resolved.
  if (request.references.length > 16 && request.type !== "video") context.addIssue({ code: z.ZodIssueCode.custom, path: ["references"], message: "参考素材不能超过 16 个" });
});
export const generationRequestSchema = z.union([newGenerationRequestSchema, z.strictObject({
  projectId: id, type: z.literal("video"), renderMode: z.literal("finalize"), draftTaskId: uuid,
  outputFormat: z.enum(["mp4", "mov"]).optional(),
})]);
export type GenerationRequest = z.infer<typeof generationRequestSchema>;
export const generationQuoteRequestSchema = z.union([
  z.strictObject({ ...newGenerationRequestSchema.shape, projectId: id.optional(), aspectRatio: z.string().min(1).max(20).optional(), resolution: z.string().min(1).max(20).optional() }),
  generationRequestSchema.options[1].extend({ projectId: id.optional() }),
]);
const definition = <S extends z.ZodObject>(title: string, keyPermission: string, memberPermission: string, schema: S, readOnly: boolean, description = title) =>
  ({ title, description, keyPermission, memberPermission, schema, readOnly });
const asset = { projectId: id.optional(), assetId: id, assetVersionId: id.optional() };
export const creationToolDefinitions = {
  fanjin_project_create: definition("创建项目和默认画布", "project:create", "project:write", z.strictObject({ name: z.string().trim().min(1).max(200), idempotencyKey: key }), false),
  fanjin_assets_list: definition("列出项目素材", "asset:read", "project:read", z.strictObject({ projectId: id.optional(), type: z.enum(["image", "video", "audio", "text", "document"]).optional(), ...page }), true, "列出项目素材及 portraitAdmission 审核状态；已有素材直接引用 assetVersionId，无需查询独立人像中转接口。"),
  fanjin_asset_get: definition("读取素材版本", "asset:read", "project:read", z.strictObject(asset), true, "读取素材及 portraitAdmission（审核、同步状态和下一步）。status: active 仅表示素材已保存；人像就绪请检查 portraitAdmission。无需 relay:portrait_assets:* 权限或独立火山 AK/SK。"),
  fanjin_upload_prepare: definition("准备素材上传", "asset:write", "project:write", z.strictObject({ projectId: id.optional(), fileName: z.string().min(1).max(255), assetName: z.string().min(1).max(255), assetType: z.enum(["image", "video", "audio", "document"]), mimeType: z.string().min(1).max(150), sizeBytes: id.max(2 * 1024 ** 3), contentHash: z.string().regex(/^[a-f0-9]{64}$/), idempotencyKey: key }), false, "建立限时上传会话；客户端传输文件字节，远端 MCP 不读取客户端路径。"),
  fanjin_upload_get: definition("查询上传状态", "asset:read", "project:read", z.strictObject({ projectId: id.optional(), uploadId: uuid }), true),
  fanjin_upload_complete: definition("核验上传并登记素材", "asset:write", "project:write", z.strictObject({ projectId: id.optional(), uploadId: uuid }), false, "核验字节并登记平台素材，自动进入适用的素材审核流程；返回 assetVersionId 和 portraitAdmission。审核可能尚未完成，请用 fanjin_asset_get 查询，不要另行调用 /api/v3/portrait-assets 入库。"),
  fanjin_generation_quote: definition("生成或编辑报价", "generation:quote", "generation:create", z.strictObject({ request: generationQuoteRequestSchema, idempotencyKey: key }), false, "绑定项目后可省略 projectId；普通生成省略画幅、分辨率、时长时使用模型目录默认值，报价回显最终参数与人民币/GU。样片使用 renderMode=draft、resolution=480p。样片转正式片只传 type=video、renderMode=finalize、projectId、draftTaskId（繁境任务编号），可选 outputFormat=mp4/mov，不传继承参数；两阶段分别报价与提交。保存完整请求和最高 GU 报价；不提交供应商或扣费。原生编辑用 operation=edit、mode=video_edit、aspectRatio=adaptive、duration=-1，并以 sourceAssetVersionId 指定 references 中的 4–30 秒原片，其他参考视频须符合目录限制；完整修改和保留要求写入 prompt。仅目录声明 edit 的模型可用。海外 Seedance 2.5 按官方目录支持图片、视频、音频与纯音频参考，最多 50 个素材（图片 30、视频 10、音频 10）；原声保留要求写入提示词，不保证逐帧或原声无损复制。参考图使用已入库的 assetVersionId；人像审核进度通过 fanjin_asset_get 查询，不使用独立人像中转接口。报价不代替最终准入校验或用户预算批准。"),
  fanjin_approval_request: definition("请求用户确认生成预算", "generation:create", "generation:create", z.strictObject({ quoteId: uuid, idempotencyKey: key }), false, "返回网页确认地址，由密钥所属用户登录批准。"),
  fanjin_approval_confirm: definition("密钥所属用户确认生成预算", "generation:create", "generation:create", z.strictObject({ quoteId: uuid, decision: z.enum(["approved", "rejected"]).default("approved"), idempotencyKey: key }), false, "由密钥所属用户在 MCP/CLI 直接确认或拒绝该报价，无需打开网页；确认后可用 fanjin_generation_submit 提交。"),
  fanjin_approval_get: definition("查询预算确认结果", "generation:read", "project:read", z.strictObject({ approvalId: uuid }), true),
  fanjin_generation_submit: definition("提交生成（MCP/CLI 可直接放行）", "generation:create", "generation:create", z.strictObject({ quoteId: uuid, approvalId: uuid.optional(), targetCanvas: z.strictObject({ canvasId: id, nodeId: z.string().min(1).max(128), expectedRevision: id }).optional(), budgetGu: z.string().regex(/^\d+(?:\.\d{1,8})?$/).max(30).optional(), idempotencyKey: key }), false, "密钥所属用户提交已报价生成。可传 budgetGu 作为已授权的 GU 上限，报价超过时不提交。可传 targetCanvas，在作品保存后自动放回指定节点；版本冲突保留作品，不覆盖画布。省略 approvalId 时按密钥所有者身份直接放行；提供 approvalId 时沿用网页确认结果。一次授权只启动一个持久任务。参考素材需要登记时返回 preparing，后台自动登记，通过后继续生成，无需重新报价或重复提交；等待登记不冻结生成额度，真正生成时不超过已确认预算。用 fanjin_task_get 查询进度；上游明确拒绝会返回失败原因，不会自动重投。超时后以原键恢复，不能换键重试。"),
  fanjin_tasks_list: definition("列出生成任务", "generation:read", "project:read", z.strictObject({ projectId: id.optional(), ...page }), true),
  fanjin_task_get: definition("读取任务和保存结果", "generation:read", "project:read", z.strictObject({ taskId: uuid }), true, "查询原任务。deliveryReady=true 才表示作品已保存可取用；账务更新不影响交付。nextAction 表示等待、取用结果或处理失败。不要因费用状态不明重新生成。"),
  fanjin_task_wait: definition("等待原任务结果", "generation:read", "project:read", z.strictObject({ taskId: uuid, waitMs: z.number().int().min(0).max(20000).default(10000) }), true, "最多等待 20 秒，完成或失败时立即返回，等待到期仍返回原任务进度；可继续等待同一个 taskId。只查询，不生成、不重新扣费。交付与账务分离，无需核账才能获取作品。"),
  fanjin_task_billing: definition("查询任务账单", "billing:read", "billing:read", z.strictObject({ taskId: uuid }), true, "独立只读查账：返回报价上限、当前冻结、已扣费、已释放与已退款，以及人民币和 GU。暂未同步的金额为 null，不能当成 0 元；查账不阻断作品交付、不发起生成、不修改账本。"),
  fanjin_canvas_attach: definition("把作品放回画布节点", "project:write", "project:write", z.strictObject({
    projectId: id.optional(), canvasId: id.optional(), taskId: uuid, nodeId: z.string().min(1).max(128),
    expectedRevision: id, assetIndex: z.number().int().min(0).max(9).default(0), idempotencyKey: key,
  }), false, "将本项目已保存的生成作品放入指定的现有图片/视频节点；不启动生成。先读取画布取得 revision；版本冲突时重新读取，不能覆盖用户的新编辑。同一幂等键只回填一次。"),
  fanjin_task_recover: definition("按原幂等键恢复任务查询", "generation:read", "project:read", z.strictObject({ idempotencyKey: key }), true),
  fanjin_task_cancel: definition("取消尚未派发的生成", "generation:create", "generation:create", z.strictObject({ taskId: uuid }), false, "可取消工具队列或仍在登记参考素材的任务；只有服务端确认尚未派发生成时才返回取消成功。已开始生成的任务不会被虚报取消或退款。"),
  fanjin_asset_download: definition("获取授权作品下载", "asset:download", "project:read", z.strictObject(asset), true, "只返回已持久化素材的下载指引；下载时再次鉴权。"),
  fanjin_history_list: definition("列出生成历史", "generation:read", "project:read", z.strictObject({ projectId: id.optional(), ...page }), true),
  fanjin_asset_rename: definition("重命名素材", "asset:write", "project:write", z.strictObject({ projectId: id.optional(), assetId: id, name: z.string().trim().min(1).max(255), expectedUpdatedAt: id, idempotencyKey: key }), false),
  fanjin_portrait_asset_register: definition(
    "主动登记人像资产",
    "asset:write",
    "project:write",
    z.strictObject({ projectId: id.optional(), assetVersionId: id, model: z.string().trim().min(1).max(200).optional(), expectedRevision: id.optional(), idempotencyKey: key }),
    false,
    "对上传时已选择模型线路的图片或视频主动绑定该线路并启动资产登记；这类素材无需再次向用户索要人像声明。可选 model 精确选择模型通道；未配置时失败，不回退其他通道。指定模型时仅 registration.status 证明该目标通道状态，通用 portraitAdmission 可仍表示原通道；原幂等键返回原回执，不是动态状态。已有登记会复用，不重新上传。只有上游明确要求真人来源授权时才进入真人授权流程；上游明确拒绝仍须保留拒绝原因并更换素材或申请复核，不能改写为通过。registration.status 为 processing 时仅代表正在登记，可以直接提交生成，任务会自动等待登记通过；registered 才代表目标通道已登记。同一版本已就绪时直接复用 assetVersionId，无需重复声明。不创建生成任务、不冻结生成预算。重试同一请求必须使用原幂等键。",
  ),
  fanjin_portrait_admission_retry: definition(
    "重试人物素材检查",
    "asset:write",
    "project:write",
    z.strictObject({
      projectId: id.optional(),
      assetVersionId: id,
      expectedRevision: id.optional(),
      idempotencyKey: key,
    }),
    false,
    "将服务失败的素材检查重新排队。不会重新上传、不改内容结论；已确认违规的素材不会被改写为通过。",
  ),
  fanjin_portrait_admission_declare: definition(
    "声明人像素材类型",
    "asset:write",
    "project:write",
    z.strictObject({
      projectId: id.optional(),
      assetVersionId: id,
      choice: z.enum(["ordinary_no_person", "real_person_with_rights", "fully_virtual_person"]),
      termsAccepted: z.literal(true),
      expectedRevision: id.optional(),
      idempotencyKey: key,
    }),
    false,
    "兼容未携带模型线路的旧素材，或上游明确要求补充来源确认时使用。正常上传流程已在选择参考线路时完成路由，不应再次调用本工具向用户索要声明。若确需调用，须先向用户展示人像免责声明并取得真实来源确认，不能由 Agent 自行推断授权。ordinary_no_person 仅用于无人像；fully_virtual_person 仅用于不对应现实个人的 AI 虚构人物；real_person_with_rights 进入真人授权流程。图片或视频被上游以疑似真人拒绝后，确为虚构人物的素材可在用户确认后提交虚拟人像库审核；免责声明不保证通过，不自动重投生成。",
  ),
  fanjin_portrait_admission_authorize: definition(
    "发起真人授权并返回网页链接",
    "asset:write",
    "project:write",
    z.strictObject({
      projectId: id.optional(),
      assetVersionId: id,
      identityLabel: z.string().trim().min(1).max(120),
      rightsConfirmed: z.literal(true),
      expectedRevision: id.optional(),
      idempotencyKey: key,
    }),
    false,
    "返回授权网页 URL，必须由用户在浏览器完成验证；工具不能代替用户完成授权或创建生成任务。",
  ),
};
