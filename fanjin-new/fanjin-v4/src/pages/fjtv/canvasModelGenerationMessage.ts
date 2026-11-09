export function getModelGenerationUnavailableMessageExternal(
  node: any,
  deps: { modelCatalogState: string; modelCatalogError?: string; models: any[]; getNodeModelType: (type: any) => string; isAiModelSelectable: (model: any) => boolean },
): string {
  if (node.type !== "image" && node.type !== "video" && node.type !== "text") return "";
  if (deps.modelCatalogState === "loading") return "模型目录仍在加载，请稍后再试";
  if (deps.modelCatalogState === "failed") return deps.modelCatalogError || "模型目录不可用，已阻止生成任务";
  if (deps.modelCatalogState === "empty") return "当前工作区尚未配置可用模型，已阻止生成任务";
  const modelType = deps.getNodeModelType(node.type);
  const selectableModels = deps.models.filter((model) => model.type === modelType && deps.isAiModelSelectable(model));
  if (!selectableModels.length) return "当前类型暂无可用模型，已阻止生成任务";
  const selectedModel = selectableModels.find((model) => model.id === String(node.model || "").trim());
  if (!selectedModel) return "请先从真实模型目录选择可用模型";
  return "";
}
