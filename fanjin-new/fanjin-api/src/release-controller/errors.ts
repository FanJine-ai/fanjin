import type { ReleasePhase, SafeReleaseError } from "./types";

const SECRET_FIELD = "authorization|proxy-authorization|token|access[_-]?token|refresh[_-]?token|api[_-]?key|accesskeyid|accesskey|secretaccesskey|secretkey|sessiontoken|secret|password|passwd|credential|cookie|set-cookie";
const SECRET_ASSIGNMENT = new RegExp(`\\b(${SECRET_FIELD})\\b\\s*[:=]\\s*(?:bearer\\s+)?([^\\s,;]+)`, "gi");
const JSON_SECRET = new RegExp(`(["'])(${SECRET_FIELD})\\1\\s*:\\s*(["'])[^"'\\r\\n]*\\3`, "gi");
const URL_CREDENTIAL = /(https?:\/\/)([^\s/@:]+):([^\s/@]+)@/gi;
const QUERY_SECRET = /([?&](?:token|access_token|refresh_token|api_key|apikey|accesskeyid|accesskey|secretaccesskey|secretkey|sessiontoken|secret|password|signature|x-tos-signature)=)[^&#\s]+/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi;
const PRIVATE_KEY = /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi;

/** Redact before an adapter error crosses an API, event, or persistence boundary. */
export function redactReleaseErrorMessage(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value ?? "unknown failure");
  const redacted = raw
    .replace(PRIVATE_KEY, "[REDACTED_PRIVATE_KEY]")
    .replace(JSON_SECRET, "$1$2$1:$3[REDACTED]$3")
    .replace(URL_CREDENTIAL, "$1[REDACTED]@")
    .replace(QUERY_SECRET, "$1[REDACTED]")
    .replace(BEARER, "Bearer [REDACTED]")
    .replace(SECRET_ASSIGNMENT, "$1=[REDACTED]")
    .replace(/[\r\n\t]+/g, " ")
    .trim();

  return (redacted || "release step failed").slice(0, 500);
}

export class ReleaseControllerError extends Error {
  readonly code: string;
  readonly phase: ReleasePhase;
  readonly nodeId: string | null;

  constructor(error: SafeReleaseError) {
    super(error.message);
    this.name = "ReleaseControllerError";
    this.code = error.code;
    this.phase = error.phase;
    this.nodeId = error.nodeId;
  }
}

export class ReleaseInvariantError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ReleaseInvariantError";
    this.code = code;
  }
}

/**
 * Internal control-flow signal raised only at a durable action boundary.
 *
 * It bypasses rollback/failure handling because the runtime still owns a
 * valid lease and will atomically return the unchanged checkpoint to queue.
 */
export class ReleaseHandoffRequestedError extends Error {
  readonly code = "RELEASE_CONTROLLER_HANDOFF_REQUESTED";

  constructor() {
    super("发布控制器正在安全交接任务");
    this.name = "ReleaseHandoffRequestedError";
  }
}
