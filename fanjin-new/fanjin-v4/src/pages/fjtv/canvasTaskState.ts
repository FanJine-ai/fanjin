import type { NodeData } from "./canvasDataTypes";
import { getGeneratedImageChoiceUrl } from "./canvasAssetPresentation";

export function hasRenderableNodeResultValue(data: Partial<NodeData>) {
  return Boolean(
    data.imageUrl ||
    data.primaryImageUrl ||
    data.videoUrl ||
    data.audioUrl ||
    data.outputText ||
    (Array.isArray(data.generatedImages) && data.generatedImages.some((choice) => Boolean(getGeneratedImageChoiceUrl(choice).trim())))
  );
}

export function patchLooksActivelyGenerating(patch: Partial<NodeData>) {
  return Boolean(
    patch.isGenerating ||
    patch.generationState === "submitting" ||
    patch.generationState === "processing" ||
    patch.taskStatus === "processing"
  );
}

export function createGenerationSessionId(nodeId: string) {
  return `${nodeId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function taskRequiresBillingReconciliation(taskData: any): boolean {
  const billingState = String(
    taskData?.billingState
    || taskData?.billing_state
    || taskData?.billing?.state
    || "",
  ).toLowerCase();
  return taskData?.billingReconciliationRequired === true
    || billingState === "pending_reconcile"
    || billingState === "reconciliation_required";
}

export function taskResultKind(taskData: any, fallback?: NodeData["taskKind"]): NodeData["taskKind"] {
  return taskData?.kind === "user_video_enhance"
    || taskData?.billingSubject === "video_enhance"
    ? "video_enhance"
    : fallback || "generation";
}
