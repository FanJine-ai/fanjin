import { buildRedrawPlan, type RedrawDraft } from "./redrawDraft";

type InputNode = { id: string; type: string; title: string; imageUrl?: string; primaryImageUrl?: string; localPreviewUrl?: string; videoUrl?: string; localVideoUrl?: string };
type InputEdge = { fromNodeId: string; toNodeId: string };
/** The graph is authoritative. A deleted edge must never become a hidden source via lineage metadata. */
export function getRedrawInputs<T extends InputNode>(targetId: string, nodes: T[], edges: InputEdge[]) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const ids = [...new Set(edges.filter(edge => edge.toNodeId === targetId).map(edge => edge.fromNodeId))];
  const inputs = ids.map(id => byId.get(id)).filter((node): node is T => Boolean(node));
  const videos = inputs.filter(node => node.type === "video");
  const images = inputs.filter(node => node.type === "image");
  const unsupported = inputs.filter(node => node.type !== "video" && node.type !== "image");
  const source = videos.length === 1 ? videos[0] : null;
  const error = unsupported.length ? "转绘节点目前支持原片视频和图片参考，请移除其他类型的输入。"
    : videos.length > 1 ? "一个转绘节点只编辑一段原片，请保留一个视频输入。多段原片请分别创建转绘节点。"
    : !source ? "请先连接一段原片视频，再配置人物、场景和道具替换。"
    : !(source.videoUrl || source.localVideoUrl) ? "原片尚未上传完成，请等待视频可用后再配置。"
    : images.some(node => !(node.imageUrl || node.primaryImageUrl || node.localPreviewUrl)) ? "有图片参考尚未上传完成，请等待素材可用。" : "";
  return { source, images, videos, unsupported, error };
}
/** New connections are visible as explicit, unassigned rows; no identity is guessed from an image. */
export function addConnectedRedrawAssets(draft: RedrawDraft, ids: string[]): RedrawDraft {
  const mapped = new Set(draft.mappings.map(item => item.assetId));
  return { ...draft, mappings: [...draft.mappings, ...[...new Set(ids)].filter(id => !mapped.has(id)).map(id => ({ id: `connected-${id}`, kind: "prop" as const, source: "", assetId: id }))] };
}
export function validateRedrawSubmission<T extends InputNode>(targetId: string, draft: RedrawDraft | undefined, nodes: T[], edges: InputEdge[]) {
  const inputs = getRedrawInputs(targetId, nodes, edges);
  if (inputs.error) throw new Error(inputs.error);
  if (!draft) throw new Error("请先打开转绘配置，指定每个输入的替换用途并保存。");
  const plan = buildRedrawPlan(draft, inputs.images.map(node => ({ id: node.id, name: node.title, imageUrl: node.imageUrl || node.primaryImageUrl || node.localPreviewUrl || "" })));
  if (plan.referenceIds.length !== inputs.images.length || plan.referenceIds.some((id, index) => inputs.images[index].id !== id)) {
    throw new Error("参考连线发生了变化，请打开转绘配置确认用途并更新节点后再生成。");
  }
  return { ...plan, sourceId: inputs.source!.id };
}
