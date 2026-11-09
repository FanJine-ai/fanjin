import type { Dispatch, SetStateAction, RefObject, ReactNode, JSX } from "react";
import { createNode } from "./canvasNodeDefaults";
import { patchLooksActivelyGenerating } from "./canvasTaskState";
import type { NodeData, EdgeData, GroupData } from "./canvasDataTypes";
import { allArtifactCards, type CanvasArtifactKind, type CanvasArtifactCard } from "./canvasTextArtifacts";
import { resolveCanvasTextGenerationAttemptId } from "./canvasStoryGeneration";
import { getNodeImageDisplayUrl } from "./canvasAssetPresentation";

export interface CanvasArtifactEditingControllerDependencies {
  nodesRef: RefObject<NodeData[]>;
  setNodePatch: (nodeId: string, patch: Partial<NodeData>) => void;
  setStatus: Dispatch<SetStateAction<string>>;
  edges: EdgeData[];
  setNodes: Dispatch<SetStateAction<NodeData[]>>;
  setEdges: Dispatch<SetStateAction<EdgeData[]>>;
  setSelectedNodeIds: Dispatch<SetStateAction<string[]>>;
  setSelectedEdgeIds: Dispatch<SetStateAction<string[]>>;
  setActiveGroupId: Dispatch<SetStateAction<string | null>>;
  setActiveNodeId: Dispatch<SetStateAction<string | null>>;
  setExpanded: Dispatch<SetStateAction<boolean>>;
  persistCanvas: (nextNodes?: NodeData[], nextEdges?: EdgeData[], nextName?: string, nextGroups?: GroupData[]) => Promise<string | null>;
}

export function createCanvasArtifactEditingController(deps: CanvasArtifactEditingControllerDependencies) {
  const { nodesRef, setNodePatch, setStatus, edges, setNodes, setEdges, setSelectedNodeIds, setSelectedEdgeIds, setActiveGroupId, setActiveNodeId, setExpanded, persistCanvas } = deps;
function editCanvasArtifact(nodeId: string, kind: CanvasArtifactKind, cardId: string, patch: Partial<CanvasArtifactCard>) {
    const source = nodesRef.current.find((node) => node.id === nodeId);
    const collection = source?.textArtifacts?.[kind];
    if (!source || !collection || patchLooksActivelyGenerating(source)) return;
    setNodePatch(nodeId, { textArtifacts: {
      ...source.textArtifacts,
      [kind]: { ...collection, cards: collection.cards.map((card) => card.id === cardId ? { ...card, ...patch } : card) },
    } });
  }

function deleteCanvasArtifact(nodeId: string, kind: CanvasArtifactKind, cardId: string) {
    const source = nodesRef.current.find((node) => node.id === nodeId);
    const collection = source?.textArtifacts?.[kind];
    if (!source || !collection || patchLooksActivelyGenerating(source)) return;
    setNodePatch(nodeId, { textArtifacts: { ...source.textArtifacts, [kind]: {
      ...collection, cards: collection.cards.filter((card) => card.id !== cardId),
    } } });
    setStatus("卡片已移除；关联它的分镜和图片节点需要重新选择素材");
  }

function getCanvasArtifactImages() {
    return nodesRef.current.flatMap((node) => {
      const imageUrl = getNodeImageDisplayUrl(node);
      const assetVersionId = Number(node.assetVersionId);
      if (node.type !== "image" || !imageUrl || !Number.isSafeInteger(assetVersionId) || assetVersionId <= 0 || patchLooksActivelyGenerating(node)) return [];
      return [{ nodeId: node.id, title: node.title, assetVersionId, imageUrl, referenceAssetUri: node.referenceAssetUri }];
    });
  }

function createImageFromCanvasArtifact(sourceNodeId: string, cardId: string) {
    const source = nodesRef.current.find((node) => node.id === sourceNodeId);
    const entry = allArtifactCards(source?.textArtifacts).find((entry) => entry.card.id === cardId);
    if (!source || !entry) return;
    const id = `node_${resolveCanvasTextGenerationAttemptId()}`;
    const siblingCount = nodesRef.current.filter((node) => node.artifactImageTarget?.sourceNodeId === source.id).length;
    const image = {
      ...createNode(id, "image", source.x + source.width + 280 + Math.floor(siblingCount / 4) * 440, source.y + 200 + (siblingCount % 4) * 440),
      title: `${entry.card.name} · ${entry.kind === "shots" ? "分镜图" : "设定图"}`, titleCustomized: true,
      textArtifactBindings: [{ sourceNodeId, cardId }],
      textArtifactSourceModes: { [sourceNodeId]: "cards" as const },
      artifactImageTarget: { sourceNodeId, cardId }, artifactRevision: Date.now(),
    };
    const nextNodes = [...nodesRef.current, image];
    const nextEdges: EdgeData[] = [...edges, { id: `edge_${id}`, fromNodeId: sourceNodeId, fromSide: "right", toNodeId: id, toSide: "left" }];
    nodesRef.current = nextNodes;
    setNodes(nextNodes);
    setEdges(nextEdges);
    setSelectedNodeIds([id]);
    setSelectedEdgeIds([]);
    setActiveGroupId(null);
    setActiveNodeId(id);
    setExpanded(false);
    setStatus("图片节点已创建并选中卡片，可补充画面要求后手动生成");
    void persistCanvas(nextNodes, nextEdges).catch(() => setStatus("节点已创建，但保存失败，请保持页面打开等待重试"));
  }

function bindUploadedImageToArtifact(nodeId: string): boolean {
    const imageNode = nodesRef.current.find((node) => node.id === nodeId);
    const assetVersionId = Number(imageNode?.assetVersionId);
    const imageUrl = imageNode ? getNodeImageDisplayUrl(imageNode) : "";
    if (
      imageNode?.type !== "image"
      || !imageUrl
      || !Number.isSafeInteger(assetVersionId)
      || assetVersionId <= 0
    ) return false;
    let bound = false;
    for (const binding of imageNode.textArtifactBindings || []) {
      const source = nodesRef.current.find((node) => node.id === binding.sourceNodeId);
      const entry = allArtifactCards(source?.textArtifacts)
        .find((candidate) => candidate.card.id === binding.cardId);
      if (!source || !entry) continue;
      editCanvasArtifact(source.id, entry.kind, binding.cardId, {
        reference: {
          nodeId: imageNode.id,
          assetVersionId,
          imageUrl,
          referenceAssetUri: imageNode.referenceAssetUri,
        },
      });
      bound = true;
    }
    if (bound) setStatus("上传成功，已设为对应卡片的设定图");
    return bound;
  }
  return { editCanvasArtifact, deleteCanvasArtifact, getCanvasArtifactImages, createImageFromCanvasArtifact, bindUploadedImageToArtifact };
}
