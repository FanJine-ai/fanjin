import {
  VideoGenerationRelayBillingAuditError,
} from "@/lib/videoGenerationRelayBillingAudit";

export const WORKBENCH_VIDEO_BILLING_AUDIT_QUARANTINE_REASON =
  "视频任务账务证据异常，已停止自动处理";

/**
 * One legacy or corrupted task must not make every task in the project
 * unreadable. Billing evidence is still fail-closed: the quarantined row is
 * projected as a terminal failure with no media URL, while unrelated rows may
 * continue through their independently verified projections.
 */
export function projectWorkbenchVideoBillingAuditQuarantine(
  video: Record<string, unknown>,
  error: unknown,
): Record<string, unknown> {
  if (!(error instanceof VideoGenerationRelayBillingAuditError)) throw error;
  return {
    ...video,
    state: "生成失败",
    filePath: "",
    errorReason: WORKBENCH_VIDEO_BILLING_AUDIT_QUARANTINE_REASON,
    relayBillingState: null,
  };
}
