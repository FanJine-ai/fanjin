/** Public workflow guidance; never includes provider credentials or namespaces. */
export const managedPortraitWorkflow = {
  workflow: "platform_managed_assets",
  uploadTool: "fanjin_upload_prepare",
  completeTool: "fanjin_upload_complete",
  statusTool: "fanjin_asset_get",
  declarationTool: "fanjin_portrait_admission_declare",
  registrationTool: "fanjin_portrait_asset_register",
  quoteTool: "fanjin_generation_quote",
  referenceField: "references[].assetVersionId",
  requiresPortraitRelay: false,
  docsPath: "/#/docs/mcp#mcp-portraits",
  message: "项目参考素材通过上传工具入库，使用 fanjin_asset_get 查询 portraitAdmission，并以 assetVersionId 引用。正常 MCP / CLI 创作不需要调用 /api/v3/portrait-assets，也不需要 relay:portrait_assets:* 权限或工作区独立火山 AK/SK。正常创作直接校验目标模型、报价并在已授权预算内提交；素材需要登记时由原生成任务后台等待并继续，不必先等检查完成，不重复声明或登记。上游明确拒绝会在任务中返回原因，不自动重投。",
} as const;

export const portraitRelayGuidance = {
  workflow: "workspace_portrait_relay",
  managedAlternative: managedPortraitWorkflow,
  message: "此接口仅用于工作区独立火山人像库中转，与平台项目素材审核分开。只有明确使用独立中转时，才需要对应 relay 权限、工作区独占通道及命名空间；该接口不可用不代表平台素材审核缺少凭据。",
} as const;
