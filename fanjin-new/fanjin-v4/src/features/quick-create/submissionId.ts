import { createBrowserUuid } from "../../lib/browserUuid";

export function createSubmissionId(): string {
  return createBrowserUuid();
}

export function buildIdempotencyKey(input: {
  sessionId: string;
  operation: "director" | "materialize" | "image" | "video";
  submissionId: string;
  sourceId?: string;
}): string {
  const source = input.sourceId ? `:${input.sourceId}` : "";
  return `quick:${input.sessionId}:${input.operation}${source}:${input.submissionId}`;
}
