import type { AiModelOption } from "@/lib/api";
import type { EdgeData, NodeData } from "./canvasDataTypes";
import { getNodeModelType } from "./canvasModelDefinitions";
import { isCanvasCatalogVideoModeSupported } from "./canvasCatalogContract";
import { isCanvasSourceVideoMode } from "./canvasVideoExtension";
import type { CanvasCatalogVideoDuration, CanvasCatalogVideoMode } from "./canvasCatalogContract";

export function resolveActiveVideoDurationMode(node: NodeData | null, model: AiModelOption | undefined, fallbackMode: CanvasCatalogVideoMode) {
  if (!node || node.type !== "video" || !model) return null;
  const persistedMode = node.videoMode as CanvasCatalogVideoMode;
  return isCanvasCatalogVideoModeSupported(model, persistedMode) ? persistedMode : fallbackMode;
}

export function resolveActiveVideoDurationCapability(
  model: AiModelOption | undefined,
  mode: CanvasCatalogVideoMode | null,
  getDuration: (model: AiModelOption | undefined, mode: CanvasCatalogVideoMode) => CanvasCatalogVideoDuration | null,
): CanvasCatalogVideoDuration | null {
  return mode ? getDuration(model, mode) : null;
}

export function resolveActiveNodeModelName(node: NodeData | null, models: AiModelOption[], resolveLabel: (input: { nodeType: NodeData["type"]; modelId?: string; models: AiModelOption[] }) => string) {
  if (!node) return "";
  return resolveLabel({ nodeType: node.type, modelId: node.model, models });
}

export function getActiveModelCatalogStatusMessage(input: {
  node: NodeData | null;
  catalogState: string;
  modelOptionsCount: number;
  error?: string;
}) {
  if (!input.node) return "";
  if (input.catalogState === "loading") return "正在加载当前工作区的模型目录…";
  if (input.catalogState === "failed") return input.error || "模型目录加载失败";
  if (!input.modelOptionsCount) return "当前类型暂无可用模型，请先在模型管理中完成配置";
  return "";
}

export function getActivePromptModelLabel(input: { node: NodeData | null; catalogState: string; modelOptionsCount: number; modelName: string }) {
  if (!input.node) return "";
  if (input.catalogState === "loading") return "正在加载模型";
  if (input.catalogState === "failed") return "模型目录不可用";
  if (!input.modelOptionsCount) return "暂无可用模型";
  return input.modelName || "请选择模型";
}

export function getActiveNodeTotalPriceLabel(
  node: NodeData | null,
  models: AiModelOption[],
  getPrice: (node: NodeData, models: AiModelOption[]) => number | null,
  formatPrice: (value: number) => string,
) {
  if (!node) return "";
  const price = getPrice(node, models);
  return price === null ? "以提交前服务端报价为准" : formatPrice(price);
}

export function getActiveNodeModelOptions(
  node: NodeData | null,
  models: AiModelOption[],
) {
  if (!node) return [] as AiModelOption[];
  const nodeType = getNodeModelType(node.type);
  return models.filter((item) => item.type === nodeType && (
    !isCanvasSourceVideoMode(node.videoMode) || isCanvasCatalogVideoModeSupported(item, node.videoMode!)
  ));
}

export function getActiveNodeUpstreamMediaNodes(
  node: NodeData | null,
  edges: EdgeData[],
  nodeMap: Map<string, NodeData>,
) {
  if (!node) return [] as NodeData[];
  return edges
    .filter((edge) => edge.toNodeId === node.id)
    .map((edge) => nodeMap.get(edge.fromNodeId))
    .filter((candidate): candidate is NodeData => Boolean(candidate && (candidate.type === "image" || candidate.type === "video" || candidate.type === "audio")));
}
