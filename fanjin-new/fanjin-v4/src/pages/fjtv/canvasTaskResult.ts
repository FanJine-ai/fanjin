export type CanvasTaskAssetLink = {
  mediaAssetId?: string;
  assetId?: number;
  assetVersionId?: number;
};

export type CanvasTaskCancellationOutcome =
  | {
      kind: "terminal_cancelled";
      status: "cancelled" | "canceled";
      billingState: string;
    }
  | {
      kind: "pending_reconcile";
      status: string;
      billingState: "pending_reconcile" | "reconciliation_required";
    }
  | {
      kind: "rejected";
      status: string;
      billingState: string;
    };

export function getCanvasPendingCancellationPatch(input: {
  taskId: string;
  taskKind?: "generation" | "video_enhance";
}) {
  return {
    isGenerating: false as const,
    generationState: "idle" as const,
    taskId: input.taskId,
    taskKind: input.taskKind || "generation" as const,
    taskStatus: "pending_reconcile" as const,
    videoGenerationAttemptId: undefined,
    generationProgress: 0,
    statusChipText: undefined,
    statusChipTone: undefined,
  };
}

function record(value: unknown): Record<string, any> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : null;
}

export function getCanvasTaskCancellationOutcome(
  response: unknown,
): CanvasTaskCancellationOutcome {
  const root = record(response) || {};
  const task = record(root.task) || record(root.data) || root;
  const status = String(task.status || root.status || "").trim().toLowerCase();
  const billingState = String(
    task.billing_state
    || task.billingState
    || record(task.billing)?.state
    || root.billing_state
    || root.billingState
    || record(root.billing)?.state
    || "",
  ).trim().toLowerCase();
  if (
    ["pending_reconcile", "reconciliation_required"].includes(billingState)
    && ["pending_reconcile", "cancelled", "canceled"].includes(status)
  ) {
    return {
      kind: "pending_reconcile",
      status,
      billingState: billingState as "pending_reconcile" | "reconciliation_required",
    };
  }
  if (status === "cancelled" || status === "canceled") {
    return { kind: "terminal_cancelled", status, billingState };
  }
  return { kind: "rejected", status, billingState };
}

function positiveInteger(value: unknown): number | undefined {
  const normalized = Number(value);
  return Number.isSafeInteger(normalized) && normalized > 0 ? normalized : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function candidateArrays(taskData: any): unknown[][] {
  return [
    taskData?.output,
    taskData?.task?.output,
    taskData?.result?.output,
    taskData?.assets,
    taskData?.task?.assets,
    taskData?.result?.assets,
  ].filter(Array.isArray);
}

export function getCanvasTaskAssetLink(
  taskData: unknown,
  expectedType?: "image" | "video" | "audio",
): CanvasTaskAssetLink | null {
  const value = taskData as any;
  for (const candidates of candidateArrays(value)) {
    for (const raw of candidates) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const item = raw as Record<string, unknown>;
      const type = nonEmptyString(item.type ?? item.assetType)?.toLowerCase();
      if (expectedType && type && type !== expectedType) continue;
      const mediaAssetId = nonEmptyString(item.media_asset_id ?? item.mediaAssetId ?? item.id);
      const assetId = positiveInteger(item.asset_id ?? item.assetId);
      const assetVersionId = positiveInteger(item.asset_version_id ?? item.assetVersionId);
      if (!mediaAssetId && !assetId && !assetVersionId) continue;
      return {
        ...(mediaAssetId ? { mediaAssetId } : {}),
        ...(assetId ? { assetId } : {}),
        ...(assetVersionId ? { assetVersionId } : {}),
      };
    }
  }
  return null;
}
