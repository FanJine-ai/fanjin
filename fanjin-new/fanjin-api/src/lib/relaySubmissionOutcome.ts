import { publicRelayStatus } from "@/lib/relayMockPolicy";

export type RelaySubmissionStatus =
  | "queued"
  | "running"
  | "pending_reconcile"
  | "succeeded"
  | "failed"
  | "cancelled";

export type RelaySubmissionOutcome = {
  status: RelaySubmissionStatus;
  accepted: boolean;
  succeeded: boolean;
  code: string | null;
  message: string | null;
};

function normalized(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

function submissionState(providerPayload: unknown): string {
  if (!providerPayload || typeof providerPayload !== "object" || Array.isArray(providerPayload)) {
    return "";
  }
  const submission = (providerPayload as Record<string, unknown>).submission;
  if (!submission || typeof submission !== "object" || Array.isArray(submission)) return "";
  return normalized((submission as Record<string, unknown>).state);
}

function failedOutcome(
  status: Exclude<RelaySubmissionStatus, "queued" | "running" | "succeeded">,
): RelaySubmissionOutcome {
  if (status === "pending_reconcile") {
    return {
      status,
      accepted: false,
      succeeded: false,
      code: "relay_task_pending_reconcile",
      message: "暂未取得上游结果，请稍后查看；费用记录可在账单中查询，请勿重复提交",
    };
  }
  if (status === "cancelled") {
    return {
      status,
      accepted: false,
      succeeded: false,
      code: "relay_task_cancelled",
      message: "视频生成任务已取消",
    };
  }
  return {
    status,
    accepted: false,
    succeeded: false,
    code: "relay_task_failed",
    message: "视频生成任务创建失败，请稍后重试",
  };
}

/**
 * `createRelayTask` may return an idempotently replayed or immediately-final
 * task instead of throwing. Callers must inspect that task before announcing
 * that submission succeeded.
 */
export function resolveRelaySubmissionOutcome(input: {
  status: unknown;
  billingState?: unknown;
  providerPayload?: unknown;
  runtime?: string;
}): RelaySubmissionOutcome {
  const providerSubmissionState = submissionState(input.providerPayload);
  const status = normalized(publicRelayStatus(normalized(input.status), input.runtime));
  // Billing is an independent ledger. It must never turn a completed video
  // into a rejected submission or stop polling a live provider task.
  if (status === "pending_reconcile") return failedOutcome("pending_reconcile");
  if (status === "queued") {
    return {
      status,
      accepted: true,
      succeeded: false,
      code: null,
      message: null,
    };
  }
  if (status === "running" || status === "enhancing") {
    return {
      status: "running",
      accepted: true,
      succeeded: false,
      code: null,
      message: null,
    };
  }
  if (status === "succeeded" || status === "success" || status === "completed") {
    return {
      status: "succeeded",
      accepted: false,
      succeeded: true,
      code: null,
      message: null,
    };
  }
  if (status === "cancelled" || status === "canceled") {
    return failedOutcome("cancelled");
  }
  if (providerSubmissionState.startsWith("pending_reconcile")) {
    return failedOutcome("pending_reconcile");
  }
  return failedOutcome("failed");
}
