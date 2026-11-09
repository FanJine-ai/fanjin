type EnvironmentLike = Record<string, string | undefined>;

export const CANDIDATE_RUNTIME_LOG_PROJECTION_ENV =
  "FANJIN_CANDIDATE_RUNTIME_LOG_PROJECTION";
export const CANDIDATE_RUNTIME_LOG_PROJECTION_REDACTED = "redacted-v1";
export const PRIVATE_RUNTIME_PATH_MARKER = "[private-runtime-path]";
export const PRIVATE_RUNTIME_FAILURE_CODE = "PRIVATE_RUNTIME_FAILURE";
export const CANDIDATE_RUNTIME_LOOPBACK_HOST = "127.0.0.1";

export interface RuntimeLogSink {
  log(...values: unknown[]): void;
  warn(...values: unknown[]): void;
}

export function candidateRuntimeLogProjectionEnabled(
  environment: EnvironmentLike = process.env,
): boolean {
  return environment[CANDIDATE_RUNTIME_LOG_PROJECTION_ENV]
    === CANDIDATE_RUNTIME_LOG_PROJECTION_REDACTED;
}

export function candidateRuntimeBindHost(
  environment: EnvironmentLike = process.env,
): string | undefined {
  if (candidateRuntimeLogProjectionEnabled(environment)) {
    return CANDIDATE_RUNTIME_LOOPBACK_HOST;
  }
  const configured = String(environment.FANJIN_BIND_HOST || "").trim();
  return configured || undefined;
}

export function assertCandidateRuntimeServerAddress(
  address: string | null | undefined,
  environment: EnvironmentLike = process.env,
): void {
  if (!candidateRuntimeLogProjectionEnabled(environment)) return;
  if (!["127.0.0.1", "::1"].includes(String(address || ""))) {
    throw new Error("REAL_CANDIDATE_SERVER_NOT_LOOPBACK");
  }
}

/**
 * Candidate checkpoints live below the user's private Application Support
 * directory. Their absolute paths must never reach captured acceptance logs.
 * Ordinary API processes keep the existing path diagnostics unless the exact
 * candidate-only projection value is present.
 */
export function logRuntimePath(
  label: string,
  absolutePath: string,
  options: {
    environment?: EnvironmentLike;
    level?: "log" | "warn";
    sink?: RuntimeLogSink;
  } = {},
): void {
  const environment = options.environment ?? process.env;
  const sink = options.sink ?? console;
  const level = options.level ?? "log";
  sink[level](
    label,
    candidateRuntimeLogProjectionEnabled(environment)
      ? PRIVATE_RUNTIME_PATH_MARKER
      : absolutePath,
  );
}

/**
 * Filesystem error messages commonly embed their target path. Candidate mode
 * therefore emits a stable non-sensitive code; normal service logs retain the
 * original diagnostic message.
 */
export function logRuntimeFilesystemFailure(
  label: string,
  error: unknown,
  options: {
    environment?: EnvironmentLike;
    sink?: RuntimeLogSink;
  } = {},
): void {
  const environment = options.environment ?? process.env;
  const sink = options.sink ?? console;
  if (candidateRuntimeLogProjectionEnabled(environment)) {
    sink.warn(label, PRIVATE_RUNTIME_FAILURE_CODE);
    return;
  }
  const message = error && typeof error === "object" && "message" in error
    ? (error as { message?: unknown }).message || error
    : error;
  sink.warn(label, message);
}
