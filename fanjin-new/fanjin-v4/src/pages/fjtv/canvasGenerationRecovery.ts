type RecoverableNode = {
  type: string;
  taskId?: string;
  isGenerating?: boolean;
  generationState?: string;
  taskStatus?: string;
  imageGenerationAttemptId?: string;
  videoGenerationAttemptId?: string;
  videoEnhanceAttemptId?: string;
  imagePendingMessage?: string;
  textGenerationAttemptId?: string;
  textRequestAttempt?: { id: string };
};

/** A reload loses the HTTP response, not necessarily the submitted job. */
export function canvasInterruptedSubmissionPatch(node: RecoverableNode) {
  // Reload ends the local HTTP session. Keep the saved request and attempt ID
  // for an explicit idempotent retry instead of leaving the toolbar locked.
  if (node.type === "text" && !node.taskId
    && (node.textGenerationAttemptId || node.textRequestAttempt)
    && (node.isGenerating || node.generationState === "submitting" || node.generationState === "processing" || node.taskStatus === "processing")) {
    return { isGenerating: false, generationState: "idle" as const, generationProgress: 0, taskStatus: "pending_reconcile" as const };
  }
  if (!["image", "video"].includes(node.type) || node.taskId) return null;
  if (!node.isGenerating && node.generationState !== "submitting"
    && node.generationState !== "processing" && node.taskStatus !== "processing") return null;
  const hasAttempt = node.type === "image"
    ? Boolean(node.imageGenerationAttemptId)
    : Boolean(node.videoGenerationAttemptId || node.videoEnhanceAttemptId);
  return {
    isGenerating: false,
    generationState: "idle" as const,
    generationProgress: 0,
    // A page reload cannot safely continue an image submission. Surface a
    // normal failure so the user can start a fresh request from Generate.
    taskStatus: node.type === "video" && hasAttempt ? "pending_reconcile" as const : "failed" as const,
    ...(node.type === "image" ? {
      imageGenerationAttemptId: undefined,
      imagePendingMessage: undefined,
    } : {}),
  };
}

/** There is only one session-guarded poller, including after hydration. */
export function shouldResumeCanvasTask(node: RecoverableNode) {
  return Boolean(node.taskId) && ["image", "video", "audio"].includes(node.type)
    && (node.isGenerating || node.generationState === "submitting"
      || node.generationState === "processing" || node.taskStatus === "processing"
      || node.taskStatus === "query_failed");
}

export function canvasTaskNeedsPolling(status: string, taskId: string) {
  return Boolean(taskId) && ["created", "queued", "running", "enhancing", "processing",
    "generating", "in_progress"].includes(status.toLowerCase());
}

export function savedCanvasGenerationPayload(
  attempt: { id: string; payload: Record<string, any> } | undefined,
  attemptId: string | undefined,
  projectId: number,
) {
  // Never replay a request from a copied node in a different project.
  return attempt && attempt.id === attemptId && Number(attempt.payload.projectId) === projectId
    ? structuredClone(attempt.payload) : null;
}
