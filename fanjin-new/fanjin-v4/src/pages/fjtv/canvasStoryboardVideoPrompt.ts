import type { CanvasArtifactNodeFields } from "./canvasTextArtifacts";

type StoryboardNode = CanvasArtifactNodeFields & { id: string; type: string };
type StoryboardEdge = { fromNodeId: string; toNodeId: string; relationship?: string };

export function resolveCanvasStoryboardVideoInputs(input: {
  images: StoryboardNode[];
  nodes: StoryboardNode[];
  edges: StoryboardEdge[];
}) {
  const prompts: string[] = [];
  const names: string[] = [];
  const errors: string[] = [];
  const included = new Set<string>();
  const nodeMap = new Map(input.nodes.map((node) => [node.id, node]));
  for (const image of input.images) {
    if (image.type !== "image") continue;
    const bindings = image.textArtifactBindings ?? (image.artifactImageTarget ? [image.artifactImageTarget] : []);
    for (const binding of bindings) {
      if (image.textArtifactSourceModes?.[binding.sourceNodeId] === "body") continue;
      const source = nodeMap.get(binding.sourceNodeId);
      const connected = input.edges.some((edge) => edge.fromNodeId === binding.sourceNodeId && edge.toNodeId === image.id && edge.relationship !== "draft_final");
      if (!source || source.type !== "text" || !connected) {
        errors.push("分镜图的文本来源已断开，请重新连接或清除图片节点的素材引用");
        continue;
      }
      const shot = source.textArtifacts?.shots?.cards.find((card) => card.id === binding.cardId);
      if (!shot) {
        const otherCard = [source.textArtifacts?.characters, source.textArtifacts?.scenes, source.textArtifacts?.props]
          .some((collection) => collection?.cards.some((card) => card.id === binding.cardId));
        if (!otherCard) errors.push("分镜图引用的卡片已不存在，请在图片节点重新选择");
        continue;
      }
      if (!shot.name.trim() || !shot.description.trim()) {
        errors.push("分镜名称和描述不能为空，请先补充分镜内容");
        continue;
      }
      const key = JSON.stringify([source.id, shot.id]);
      if (included.has(key)) continue;
      included.add(key);
      names.push(shot.name);
      prompts.push(`分镜「${shot.name}」：${shot.description}`);
    }
  }
  return { prompts, names, errors: [...new Set(errors)] };
}
