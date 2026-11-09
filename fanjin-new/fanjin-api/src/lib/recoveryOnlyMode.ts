export const RECOVERY_ONLY_MODE_ENV = "FANJIN_RECOVERY_ONLY_MODE";

/**
 * A recovered real-candidate is evidence, not a second generation runner.
 * Keep this predicate tiny and dependency-free so every submission boundary
 * can fail closed without introducing a worker/import cycle.
 */
export function isRecoveryOnlyMode(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return String(environment[RECOVERY_ONLY_MODE_ENV] || "").trim() === "1";
}
export type RecoveryOnlyWorkDisposition = Readonly<{
  action: "skip" | "provider_get" | "persist_result";
  providerGet: boolean;
  providerPost: false;
  generationSubmission: false;
  usageReservation: false;
  freezeCreation: false;
}>;

const SKIP: RecoveryOnlyWorkDisposition = Object.freeze({
  action: "skip",
  providerGet: false,
  providerPost: false,
  generationSubmission: false,
  usageReservation: false,
  freezeCreation: false,
});

const PROVIDER_GET: RecoveryOnlyWorkDisposition = Object.freeze({
  action: "provider_get",
  providerGet: true,
  providerPost: false,
  generationSubmission: false,
  usageReservation: false,
  freezeCreation: false,
});

const PERSIST_RESULT: RecoveryOnlyWorkDisposition = Object.freeze({
  action: "persist_result",
  providerGet: false,
  providerPost: false,
  generationSubmission: false,
  usageReservation: false,
  freezeCreation: false,
});

export function recoveryOnlyRelayWorkDisposition(input: {
  providerTaskId?: unknown;
}): RecoveryOnlyWorkDisposition {
  return String(input.providerTaskId || "").trim() ? PROVIDER_GET : SKIP;
}

export function recoveryOnlyStoryboardWorkDisposition(input: {
  phase?: unknown;
}): RecoveryOnlyWorkDisposition {
  return ["provider_succeeded", "persisting"].includes(
    String(input.phase || "").trim(),
  )
    ? PERSIST_RESULT
    : SKIP;
}

export function recoveryOnlyAgentWorkDisposition(): RecoveryOnlyWorkDisposition {
  return SKIP;
}
