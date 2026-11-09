import { createBrowserUuid } from "../../lib/browserUuid";

export type StableSubmissionAttempt = {
  fingerprint: string;
  idempotencyKey: string;
};

export function resolveStableSubmissionAttempt(
  current: StableSubmissionAttempt | null,
  prefix: string,
  payload: unknown,
  randomId: () => string = createBrowserUuid,
): StableSubmissionAttempt {
  const fingerprint = JSON.stringify(payload);
  if (current?.fingerprint === fingerprint) return current;
  return {
    fingerprint,
    idempotencyKey: `${prefix}:${randomId()}`,
  };
}
