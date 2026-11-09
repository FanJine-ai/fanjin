export const CANVAS_GENERATION_DEBUG_REDACTED = "[REDACTED]";

export type CanvasGenerationDebugSnapshot = {
  phase: string;
  payload?: unknown;
  response?: unknown;
  error?: string;
};

export type CanvasGenerationDebugAccess = {
  devMode: boolean;
  explicitDebugEnabled: boolean;
  isPlatformAdmin: boolean;
};

const SENSITIVE_KEY_NAMES = new Set([
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
  "password",
  "passwd",
  "secret",
  "clientsecret",
  "apikey",
  "accesskey",
  "accesskeyid",
  "secretaccesskey",
  "credential",
  "credentials",
  "credentialciphertext",
  "credentialref",
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "csrftoken",
  "session",
  "sessionid",
  "sessiontoken",
  "mfa",
  "mfacode",
  "otp",
  "totp",
  "recoverycode",
]);

const SENSITIVE_KEY_SUFFIXES = [
  "password",
  "secret",
  "apikey",
  "accesskey",
  "accesskeyid",
  "secretaccesskey",
  "credential",
  "credentials",
  "credentialciphertext",
  "credentialref",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "csrftoken",
  "sessionid",
  "sessiontoken",
  "mfacode",
  "recoverycode",
];

const INLINE_SECRET_ASSIGNMENT = /(\b(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|client[-_]?secret|api[-_]?key|access[-_]?key(?:[-_]?id)?|secret[-_]?access[-_]?key|credential(?:s)?|(?:access|refresh|id|csrf|session)[-_]?token|session[-_]?id|mfa(?:[-_]?code)?|otp|totp|recovery[-_]?code)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}\]]+)/gi;
const URL_SECRET_PARAMETER = /([?&](?:access[-_]?token|refresh[-_]?token|id[-_]?token|session[-_]?(?:id|token)|api[-_]?key|access[-_]?key(?:[-_]?id)?|secret|signature|credential|x-amz-(?:credential|signature|security-token)|mfa[-_]?code|otp|totp|recovery[-_]?code)=)[^&#\s]+/gi;
const AUTHORIZATION_VALUE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const URL_USER_INFO = /(https?:\/\/)([^/@\s:]+):([^/@\s]+)@/gi;
const MAX_DEBUG_DEPTH = 12;

function normalizedKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function isSensitiveCanvasGenerationDebugKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return SENSITIVE_KEY_NAMES.has(normalized)
    || SENSITIVE_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
    || (normalized.endsWith("token") && !normalized.endsWith("tokens"));
}

export function isCanvasGenerationDebugFlagEnabled(value: unknown): boolean {
  return value === true || String(value || "").trim().toLowerCase() === "1"
    || String(value || "").trim().toLowerCase() === "true";
}

export function shouldShowCanvasGenerationDebug(input: CanvasGenerationDebugAccess): boolean {
  // v0.0.8-hotfix.2 contract: raw generation diagnostics never render in a
  // production build. The explicit flag is only an opt-in for local builds;
  // platform-admin identity must not turn the panel back on in production.
  return input.devMode && input.explicitDebugEnabled;
}

function redactDebugString(
  value: string,
  seen: WeakSet<object>,
  depth: number,
): string {
  const trimmed = value.trim();
  if (
    trimmed.length <= 200_000
    && ((trimmed.startsWith("{") && trimmed.endsWith("}"))
      || (trimmed.startsWith("[") && trimmed.endsWith("]")))
  ) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") {
        return JSON.stringify(redactDebugValue(parsed, seen, depth + 1));
      }
    } catch {
      // Provider errors are not always valid JSON; redact their plain text below.
    }
  }

  return value
    .replace(AUTHORIZATION_VALUE, (_match, scheme: string) => `${scheme} ${CANVAS_GENERATION_DEBUG_REDACTED}`)
    .replace(URL_USER_INFO, `$1${CANVAS_GENERATION_DEBUG_REDACTED}@`)
    .replace(URL_SECRET_PARAMETER, `$1${CANVAS_GENERATION_DEBUG_REDACTED}`)
    .replace(INLINE_SECRET_ASSIGNMENT, `$1"${CANVAS_GENERATION_DEBUG_REDACTED}"`);
}

function redactDebugValue(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
): unknown {
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") return redactDebugString(value, seen, depth);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return String(value);
  if (depth >= MAX_DEBUG_DEPTH) return "[TRUNCATED]";
  if (seen.has(value as object)) return "[CIRCULAR]";
  seen.add(value as object);

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactDebugString(value.message, seen, depth + 1),
      ...(value.stack ? { stack: redactDebugString(value.stack, seen, depth + 1) } : {}),
    };
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactDebugValue(item, seen, depth + 1));
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      isSensitiveCanvasGenerationDebugKey(key)
        ? CANVAS_GENERATION_DEBUG_REDACTED
        : redactDebugValue(item, seen, depth + 1),
    ]),
  );
}

export function redactCanvasGenerationDebugSnapshot(
  snapshot: CanvasGenerationDebugSnapshot,
): CanvasGenerationDebugSnapshot {
  return redactDebugValue(snapshot, new WeakSet<object>(), 0) as CanvasGenerationDebugSnapshot;
}
