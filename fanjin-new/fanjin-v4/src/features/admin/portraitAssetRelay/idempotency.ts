import { ApiError } from "../../../api/http";
import type { PortraitAssetAction } from "./types";

export interface PortraitWriteOperation {
  action: PortraitAssetAction;
  body: Record<string, unknown>;
  workspaceId: string;
  consentConfirmed?: boolean;
}

export interface PortraitWriteKeyState {
  fingerprint: string;
  key: string;
}

export type PortraitWriteRetryDisposition = "retain-key" | "new-attempt";

const ambiguousResponseCodes = new Set([
  "VOLC_PORTRAIT_ABORTED",
  "VOLC_PORTRAIT_IDEMPOTENCY_COMMIT_FAILED",
  "VOLC_PORTRAIT_IDEMPOTENCY_LEASE_LOST",
  "VOLC_PORTRAIT_OPERATION_IN_PROGRESS",
  "VOLC_PORTRAIT_RESPONSE_INVALID",
  "VOLC_PORTRAIT_TIMEOUT",
  "VOLC_PORTRAIT_TRANSPORT_FAILED",
]);

function definiteLocalFailureCode(code: string): boolean {
  return code.startsWith("portrait_asset_")
    || code.startsWith("VOLC_PORTRAIT_CREDENTIAL_")
    || code.startsWith("VOLC_PORTRAIT_IDEMPOTENCY_");
}

export function portraitWriteRetryDisposition(error: unknown): PortraitWriteRetryDisposition {
  if (error instanceof ApiError) {
    const code = String(error.code || "").trim();
    if (code.includes("OUTCOME_UNKNOWN") || ambiguousResponseCodes.has(code)) return "retain-key";
    if (error.status !== undefined && error.status >= 500 && !definiteLocalFailureCode(code)) {
      return "retain-key";
    }
    return "new-attempt";
  }
  if (error instanceof TypeError) return "retain-key";
  if (error instanceof Error && (
    error.name === "AbortError"
    || /(?:failed to fetch|network|网络|timeout|超时|响应未知|结果未知)/iu.test(error.message)
  )) {
    return "retain-key";
  }
  return "new-attempt";
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]),
  );
}

export function portraitWriteFingerprint(operation: PortraitWriteOperation): string {
  return JSON.stringify(canonicalize({
    action: operation.action,
    body: operation.body,
    workspaceId: operation.workspaceId.trim(),
    ...(operation.consentConfirmed === undefined
      ? {}
      : { consentConfirmed: operation.consentConfirmed }),
  }));
}

export function resolvePortraitWriteKey(
  current: PortraitWriteKeyState | null,
  operation: PortraitWriteOperation,
  createKey: () => string,
): PortraitWriteKeyState {
  const fingerprint = portraitWriteFingerprint(operation);
  if (current?.fingerprint === fingerprint) return current;
  return { fingerprint, key: createKey() };
}
