import type * as React from "react";
import type * as Router from "react-router-dom";
import { hasRenderableNodeResultValue, patchLooksActivelyGenerating } from "./canvasTaskState";
import { type NodeData } from "./canvasDataTypes";
import { nearestRatio, mediaToNodeDimensions } from "./canvasMediaGeometry";
import { isPreparingGeneration } from "../../features/quick-create/generationPreparation";
import { type CanvasGenerationDebugSnapshot } from "./canvasGenerationDebug";
import { isRemoteGenerationUrl } from "./canvasTaskResults";

export interface CanvasNodeMutationControllerDependencies {
  nodesRef: React.RefObject<NodeData[]>;
  setGenerateDebug: (snapshot: CanvasGenerationDebugSnapshot | null) => void;
  setNodes: React.Dispatch<React.SetStateAction<NodeData[]>>;
}

export function createCanvasNodeMutationController({
  nodesRef,
  setGenerateDebug,
  setNodes,
}: CanvasNodeMutationControllerDependencies) {
function setNodePatch(nodeId: string, patch: Partial<NodeData>) {
    const normalizedPatch: Partial<NodeData> = { ...patch };
    const currentNode = nodesRef.current.find((node) => node.id === nodeId);
    if (["textArtifacts", "textArtifactTab", "textArtifactInstruction", "textArtifactBindings", "textArtifactSourceModes", "artifactImageTarget", "textRequestAttempt"].some((key) => Object.prototype.hasOwnProperty.call(patch, key))) {
      normalizedPatch.artifactRevision = Math.max(Date.now(), (currentNode?.artifactRevision || 0) + 1);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "outputText")) {
      normalizedPatch.textContentVersion = Math.max(Date.now(), (currentNode?.textContentVersion || 0) + 1);
    }
    if (normalizedPatch.generationState === "submitting" || normalizedPatch.isGenerating === false) {
      normalizedPatch.preparationStage = undefined;
      normalizedPatch.statusMessage = undefined;
    }
    const patchHasResult = hasRenderableNodeResultValue(normalizedPatch);
    const patchRequestsActiveGeneration = patchLooksActivelyGenerating(normalizedPatch);
    if (patchHasResult && !patchRequestsActiveGeneration) {
      normalizedPatch.isGenerating = false;
      normalizedPatch.generationState = "idle";
      normalizedPatch.taskStatus = normalizedPatch.taskStatus === "failed" ? "failed" : "success";
      normalizedPatch.taskId = undefined;
      normalizedPatch.generationProgress = 0;
      normalizedPatch.reportedGenerationProgress = undefined;
    }
    const shouldFinalizeUpload =
      !Object.prototype.hasOwnProperty.call(normalizedPatch, "uploadState") &&
      (
        (typeof normalizedPatch.imageUrl === "string" && isRemoteGenerationUrl(normalizedPatch.imageUrl)) ||
        (typeof normalizedPatch.videoUrl === "string" && isRemoteGenerationUrl(normalizedPatch.videoUrl)) ||
        (typeof normalizedPatch.audioUrl === "string" && isRemoteGenerationUrl(normalizedPatch.audioUrl))
      );
    if (shouldFinalizeUpload) {
      normalizedPatch.uploadState = "idle";
      delete normalizedPatch.uploadProgress;
    }
    if (
      Object.prototype.hasOwnProperty.call(normalizedPatch, "imageUrl") ||
      Object.prototype.hasOwnProperty.call(normalizedPatch, "videoUrl") ||
      Object.prototype.hasOwnProperty.call(normalizedPatch, "localPreviewUrl") ||
      Object.prototype.hasOwnProperty.call(normalizedPatch, "localVideoUrl")
    ) {
      setGenerateDebug({
        phase: "node-patch-state-write",
        payload: {
          nodeId,
          patch: {
            imageUrl: normalizedPatch.imageUrl ?? "",
            videoUrl: normalizedPatch.videoUrl ?? "",
            localPreviewUrl: normalizedPatch.localPreviewUrl ?? "",
            localVideoUrl: normalizedPatch.localVideoUrl ?? "",
            fileName: normalizedPatch.fileName ?? "",
            uploadState: normalizedPatch.uploadState ?? "",
            uploadProgress: normalizedPatch.uploadProgress ?? "",
          },
        },
      });
    }
    const applyPatch = (previousNodes: NodeData[]) =>
      previousNodes.map((node) => {
        if (node.id !== nodeId) return node;
        const nextPatch = { ...normalizedPatch };
        const nextProgress = nextPatch.generationProgress;
        const nodeStillGenerating = patchLooksActivelyGenerating({ ...node, ...nextPatch });
        if (nodeStillGenerating && !isPreparingGeneration({ ...node, ...nextPatch }) && typeof nextProgress === "number" && typeof node.generationProgress === "number") {
          nextPatch.generationProgress = Math.max(node.generationProgress, nextProgress);
        }
        return { ...node, ...nextPatch };
      });
    const nextNodes = applyPatch(nodesRef.current);
    nodesRef.current = nextNodes;
    setNodes(nextNodes);
  }

function applyNodeMediaGeometry(
    nodeId: string,
    mediaWidth: number,
    mediaHeight: number,
    patch: Partial<NodeData> = {},
  ) {
    const applyGeometry = (previousNodes: NodeData[]) =>
      previousNodes.map((node) => {
        if (node.id !== nodeId) return node;
        const nextRatio = nearestRatio(mediaWidth, mediaHeight);
        // Always fit the frame to the media aspect. Keeping a stale box (e.g.
        // 16:9) under a 9:16 clip leaves black bars and crop mismatches.
        const nextDims = mediaToNodeDimensions(mediaWidth, mediaHeight);
        const centerX = node.x + node.width / 2;
        const centerY = node.y + node.height / 2;
        return {
          ...node,
          ...patch,
          ratio: nextRatio,
          mediaNaturalWidth: mediaWidth || node.mediaNaturalWidth,
          mediaNaturalHeight: mediaHeight || node.mediaNaturalHeight,
          width: nextDims.width,
          height: nextDims.height,
          x: centerX - nextDims.width / 2,
          y: centerY - nextDims.height / 2,
        };
      });
    const nextNodes = applyGeometry(nodesRef.current);
    nodesRef.current = nextNodes;
    setNodes(nextNodes);
  }
  return { setNodePatch, applyNodeMediaGeometry };
}
