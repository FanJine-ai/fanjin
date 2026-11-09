export type ApiKeyQuotaCompletionDecision = "consumed" | "released" | "deferred";

export interface ApiKeyQuotaBillingEvidence {
  httpSucceeded: boolean;
  hasFreeze: boolean;
  billingLifecycleState?: string | null;
  usageStatus?: string | null;
}

/**
 * Decide a request-count quota terminal state from durable billing evidence.
 *
 * A released usage row is explicit proof that an upstream rejection was on
 * the non-billable allowlist, so it overrides the earlier dispatch marker.
 * Any other dispatched/charged/pending request is conservatively consumed.
 * A freeze with no durable terminal evidence is left reserved for the
 * reconciliation worker, avoiding a response-finish race that could release
 * quota just before dispatch is persisted.
 */
export function decideApiKeyQuotaCompletion(
  evidence: ApiKeyQuotaBillingEvidence,
): ApiKeyQuotaCompletionDecision {
  if (evidence.httpSucceeded) return "consumed";

  const usageStatus = String(evidence.usageStatus || "");
  if (usageStatus === "released") return "released";
  if (["charged", "free", "pending_reconcile", "refunded"].includes(usageStatus)) {
    return "consumed";
  }

  const lifecycle = String(evidence.billingLifecycleState || "");
  if (["dispatch_started", "pending_reconcile"].includes(lifecycle)) {
    return "consumed";
  }

  return evidence.hasFreeze ? "deferred" : "released";
}
