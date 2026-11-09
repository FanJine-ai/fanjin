export const QUICK_CREATE_IMAGE_CHECKPOINT_MATERIALIZE_HEADER =
  "x-fanjin-checkpoint-materialize-only";

export const QUICK_CREATE_IMAGE_CHECKPOINT_MATERIALIZE_VALUE =
  "settled-provider-checkpoint-v1";
const QUICK_CREATE_IMAGE_CHECKPOINT_RECOVERY_AUTHORIZED_PREFIX =
  `${QUICK_CREATE_IMAGE_CHECKPOINT_MATERIALIZE_VALUE};recovery-authorized:`;

export function quickCreateImageCheckpointRecoveryAuthorizedValue(
  guardDigest: string,
): string {
  if (!/^sha256:[a-f0-9]{64}$/u.test(guardDigest)) {
    throw new Error("IMAGE_CHECKPOINT_MATERIALIZE_RECOVERY_GUARD_INVALID");
  }
  return `${QUICK_CREATE_IMAGE_CHECKPOINT_RECOVERY_AUTHORIZED_PREFIX}${guardDigest}`;
}

/**
 * This recovery switch is intentionally candidate-only. It turns the normal
 * image command into a fail-closed local materialization request: callers may
 * consume an already-settled provider checkpoint, but can never cross the
 * provider-dispatch boundary.
 */
export function quickCreateImageCheckpointMaterializeOnly(
  headerValue: unknown,
  environment: NodeJS.ProcessEnv = process.env,
): "disabled" | "enabled" | "forbidden" {
  const value = String(headerValue || "").trim();
  if (!value) return "disabled";
  const isolatedTestAuthorized =
    value === QUICK_CREATE_IMAGE_CHECKPOINT_MATERIALIZE_VALUE
    && environment.NODE_ENV === "test"
    && environment.FANJIN_REAL_CANDIDATE_ALLOW_VOLCANO_FAKE_IP_DNS === "1";
  const recoveryFenceAuthorized =
    environment.FANJIN_RECOVERY_ONLY_MODE === "1"
    && value.startsWith(QUICK_CREATE_IMAGE_CHECKPOINT_RECOVERY_AUTHORIZED_PREFIX)
    && /^sha256:[a-f0-9]{64}$/u.test(
      value.slice(QUICK_CREATE_IMAGE_CHECKPOINT_RECOVERY_AUTHORIZED_PREFIX.length),
    );
  return (isolatedTestAuthorized || recoveryFenceAuthorized)
    ? "enabled"
    : "forbidden";
}
