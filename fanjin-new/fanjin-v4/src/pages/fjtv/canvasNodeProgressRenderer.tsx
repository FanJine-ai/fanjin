import type { NodeData } from "./canvasDataTypes";
import { CanvasNodeProgressChip } from "./CanvasNodeProgressChip";
import { generationPreparationMessage } from "../../features/quick-create/generationPreparation";
import { canvasGenerationProgressLabel } from "./canvasGenerationProgress";
import { hasRenderableNodeResultValue } from "./canvasTaskState";

export function renderCanvasNodeProgressChip({
  node,
  nodeUploadIsActive,
  nodeHasSubmittingSession,
  cancelOpen,
  onCancel,
}: {
  node: NodeData;
  nodeUploadIsActive: (node: NodeData) => boolean;
  nodeHasSubmittingSession: (nodeId: string) => boolean;
  cancelOpen: boolean;
  onCancel: () => void;
}) {
  const isUploading = nodeUploadIsActive(node);
  const hasResult = hasRenderableNodeResultValue(node);
  const isGenerating = !hasResult && Boolean(
    node.isGenerating ||
    node.generationState === "submitting" ||
    node.generationState === "processing" ||
    nodeHasSubmittingSession(node.id),
  );
  if (isUploading) return null;
  if (!isGenerating && !node.statusChipText) return null;
  const label = isGenerating
    ? generationPreparationMessage(node) || canvasGenerationProgressLabel(node)
    : node.statusChipText || "";
  return (
    <CanvasNodeProgressChip
      label={label}
      tone={node.statusChipTone || "neutral"}
      nodeId={node.id}
      cancelOpen={cancelOpen}
      onCancel={onCancel}
    />
  );
}
