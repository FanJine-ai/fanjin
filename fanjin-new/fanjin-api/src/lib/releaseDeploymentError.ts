/**
 * Shared release-domain error without database or runtime initialization.
 *
 * Keep this class in a side-effect-free module so manifest validation can be
 * used by the standalone production migrator without importing the
 * application release repository (and its global database client).
 */
export class ReleaseDeploymentError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    status = 400,
    code = "RELEASE_DEPLOYMENT_ERROR",
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ReleaseDeploymentError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
