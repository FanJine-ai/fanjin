import { ApiError } from "../../../api/http";

export interface ReleaseSafetyAcknowledgements {
  artifactAndRollback: boolean;
  nodeInventoryFrozen: boolean;
  nMinusOneCapacityVerified: boolean;
}

/**
 * Human release-window gates are deliberately separate acknowledgements: a
 * single generic confirmation makes it too easy to overlook fleet drift or
 * capacity evidence during an incident-driven release.
 */
export function isReleaseSafetyGateSatisfied(
  acknowledgements: ReleaseSafetyAcknowledgements,
): boolean {
  return acknowledgements.artifactAndRollback === true
    && acknowledgements.nodeInventoryFrozen === true
    && acknowledgements.nMinusOneCapacityVerified === true;
}

/** A conflict means the server refused the confirmed preview commitment. */
export function shouldClearReleasePreview(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409;
}
