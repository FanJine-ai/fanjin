import { api } from "@/lib/api";
import { toApiErrorView } from "@/api/http";
import type { NodeData, EdgeData } from "./canvasDataTypes";
import { patchLooksActivelyGenerating } from "./canvasTaskState";
import { getNodeTextContent } from "./canvasAssetPresentation";
import { canvasArtifactContext, reconcileArtifactCards, ARTIFACT_LABELS, type CanvasArtifactKind } from "./canvasTextArtifacts";
import { buildCanvasTextIdempotencyKey, resolveCanvasTextGenerationAttemptId, shouldRetainCanvasTextGenerationAttempt } from "./canvasStoryGeneration";

export interface CanvasTextGenerationDependencies {
  nodesRef: { current: NodeData[] };
  edges: EdgeData[];
  setStatus: (message: string) => void;
  ensureApiKeyReady: () => boolean;
  preflightCanvasModel: (type: "text", model?: string, options?: { openPicker?: boolean }) => { id: string } | null;
  beginNodeGenerationSession: (nodeId: string) => string;
  setNodePatch: (nodeId: string, patch: Partial<NodeData>) => void;
  beginNodeProgressSimulation: (nodeId: string, phase: "generation") => void;
  persistCanvas: (nodes?: NodeData[], edges?: EdgeData[]) => Promise<string | null>;
  isNodeGenerationSessionCurrent: (nodeId: string, sessionId: string) => boolean;
  stopNodeProgressTimer: (nodeId: string) => void;
  finishNodeGenerationSession: (nodeId: string, sessionId?: string) => void;
  showNodeStatusChip: (nodeId: string, text: string, tone?: "neutral" | "success" | "error", durationMs?: number) => void;
  canvasBalance: { refresh: () => unknown };
}

export function createCanvasTextGeneration({
  nodesRef,
  edges,
  setStatus,
  ensureApiKeyReady,
  preflightCanvasModel,
  beginNodeGenerationSession,
  setNodePatch,
  beginNodeProgressSimulation,
  persistCanvas,
  isNodeGenerationSessionCurrent,
  stopNodeProgressTimer,
  finishNodeGenerationSession,
  showNodeStatusChip,
  canvasBalance,
}: CanvasTextGenerationDependencies) {
  async function generateCanvasTextNode(node: NodeData, operation?: CanvasArtifactKind, newAttempt = false): Promise<boolean> {
    node = nodesRef.current.find((candidate) => candidate.id === node.id) || node;
    if (patchLooksActivelyGenerating(node)) {
      setStatus("当前节点正在生成中，请稍候");
      return false;
    }
    if (!ensureApiKeyReady()) return false;
    if (newAttempt) {
      // The old command remains in durable storage. Only an explicit new-request
      // action abandons its local handle; never resubmit it under another key.
      node = { ...node, textGenerationAttemptId: undefined, textRequestAttempt: undefined };
    }
    if (node.textGenerationAttemptId && !node.textRequestAttempt) {
      setStatus("上次文本请求结果尚未确认，请先恢复原请求，暂不能发起新的提取");
      if (operation) return false;
    }
    if (node.textRequestAttempt && operation && node.textRequestAttempt.payload.operation !== operation) {
      setStatus("请先恢复上次文本请求，再执行其他操作");
      return false;
    }
    const catalogModel = preflightCanvasModel("text", node.textRequestAttempt?.payload.model || node.model, { openPicker: true });
    if (!catalogModel) return false;

    const runtimeNodeMap = new Map(nodesRef.current.map((candidate) => [candidate.id, candidate]));
    const upstreamText = edges
      .filter((edge) => edge.toNodeId === node.id)
      .map((edge) => runtimeNodeMap.get(edge.fromNodeId))
      .filter((candidate): candidate is NodeData => Boolean(candidate?.type === "text"))
      .map((candidate) => getNodeTextContent(candidate))
      .filter(Boolean);
    const prompt = node.textRequestAttempt?.payload.prompt || (operation ? getNodeTextContent(node).trim() : [...upstreamText, node.prompt.trim()].filter(Boolean).join("\n\n"));
    if (!prompt) {
      setStatus("请先输入故事主题或连接一个已有文本节点");
      return false;
    }

    const attemptId = node.textRequestAttempt?.id || resolveCanvasTextGenerationAttemptId(node.textGenerationAttemptId);
    const idempotencyKey = buildCanvasTextIdempotencyKey({
      nodeId: node.id,
      attemptId,
    });
    const payload = node.textRequestAttempt?.payload || {
      prompt, model: catalogModel.id,
      ...(operation ? { operation, instruction: node.textArtifactInstruction || "", context: canvasArtifactContext(node.textArtifacts) } : {}),
    };
    const sessionId = beginNodeGenerationSession(node.id);
    setNodePatch(node.id, {
      textGenerationAttemptId: attemptId,
      textRequestAttempt: { id: attemptId, payload },
      isGenerating: true,
      generationState: "submitting",
      taskStatus: "processing",
      generationProgress: 1,
    });
    beginNodeProgressSimulation(node.id, "generation");

    try {
      await persistCanvas(nodesRef.current, edges);
      setNodePatch(node.id, { generationState: "processing" });
      const result = await api.generateCanvasText(payload, idempotencyKey);
      if (!isNodeGenerationSessionCurrent(node.id, sessionId)) return false;
      const outputText = result.text.trim();
      if (!outputText) throw new Error("文本模型未返回正文");
      const currentNode = nodesRef.current.find((candidate) => candidate.id === node.id);
      if (!currentNode) return false;
      const artifactOperation = payload.operation;
      if (artifactOperation && !Array.isArray(result.cards)) throw new Error("模型未返回有效卡片，旧结果已保留");
      const protectedCardIds = new Set<string>();
      for (const candidate of nodesRef.current) {
        for (const binding of [...(candidate.textArtifactBindings || []), ...(candidate.artifactImageTarget ? [candidate.artifactImageTarget] : [])]) {
          if (binding.sourceNodeId === node.id) protectedCardIds.add(binding.cardId);
        }
      }
      for (const shot of currentNode.textArtifacts?.shots?.cards || []) {
        for (const id of [...shot.characterIds, ...shot.sceneIds, ...shot.propIds]) protectedCardIds.add(id);
      }
      const resultPatch: Partial<NodeData> = artifactOperation ? {
        textArtifacts: {
          ...currentNode.textArtifacts,
          [artifactOperation]: {
            sourceText: payload.prompt,
            cards: reconcileArtifactCards(currentNode.textArtifacts?.[artifactOperation]?.cards || [], result.cards || [], () => `card_${resolveCanvasTextGenerationAttemptId()}`, protectedCardIds),
          },
        },
        textArtifactTab: artifactOperation,
      } : { outputText };
      stopNodeProgressTimer(node.id);
      setNodePatch(node.id, {
        ...resultPatch,
        textVisited: true,
        textGenerationAttemptId: undefined,
        textRequestAttempt: undefined,
        isGenerating: false,
        generationState: "idle",
        taskStatus: "success",
        generationProgress: 0,
      });
      finishNodeGenerationSession(node.id, sessionId);
      showNodeStatusChip(node.id, artifactOperation ? `${ARTIFACT_LABELS[artifactOperation]}卡片已更新` : "文本生成完成", "success", 2600);
      setStatus(artifactOperation ? `已提取 ${result.cards?.length || 0} 张${ARTIFACT_LABELS[artifactOperation]}卡片；同名卡片已更新，已有参考图或被引用的旧卡片会保留，可手动移除` : "文本已生成，可提取角色、场景、道具或细化分镜");
      canvasBalance.refresh();
      await persistCanvas(nodesRef.current, edges).catch(() => {
        setStatus("文本已生成，但画布保存失败；请保持页面打开后重试保存");
      });
      return true;
    } catch (error) {
      if (!isNodeGenerationSessionCurrent(node.id, sessionId)) return false;
      stopNodeProgressTimer(node.id);
      const errorView = toApiErrorView(error);
      const retainAttempt = shouldRetainCanvasTextGenerationAttempt(errorView.status);
      setNodePatch(node.id, {
        textGenerationAttemptId: retainAttempt ? attemptId : undefined,
        textRequestAttempt: retainAttempt ? { id: attemptId, payload } : undefined,
        isGenerating: false,
        generationState: "idle",
        taskStatus: "failed",
        generationProgress: 0,
      });
      finishNodeGenerationSession(node.id, sessionId);
      showNodeStatusChip(
        node.id,
        retainAttempt ? "请求结果未确认，请勿重复提交" : "文本生成失败",
        "error",
        3600,
      );
      setStatus(errorView.message || "文本生成失败");
      void persistCanvas(nodesRef.current, edges).catch(() => {
        setStatus(
          `${errorView.message || "文本生成失败"}；画布失败状态保存失败，请保持页面打开等待自动重试`,
        );
      });
      return false;
    }
  }

  return generateCanvasTextNode;
}
