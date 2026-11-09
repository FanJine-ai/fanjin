// Vendored pure wire contract from fanjin-release-control/src/domain/errors.ts.
// No controller runtime, credentials, network or deployment operations are included.
export class ReleaseControlError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: string,
    message: string,
    status = 400,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "ReleaseControlError";
    this.code = code;
    this.status = status;
    if (details) this.details = details;
  }
}

export function invariant(
  condition: unknown,
  code: string,
  message: string,
  status = 400,
  details?: Readonly<Record<string, unknown>>,
): asserts condition {
  if (!condition) throw new ReleaseControlError(code, message, status, details);
}

