export type RecoveryAwareWorkerStartInput = Readonly<{
  enabled: boolean;
  recoveryOnly: boolean;
  startRecoveryWork(): Promise<void>;
  startHeartbeatManagedWork(): Promise<void>;
}>;

export type RecoveryAwareWorkerStartMode =
  | "disabled"
  | "recovery-without-heartbeat"
  | "heartbeat-managed";

/**
 * A recovered checkpoint may run the two explicitly constrained materializers,
 * but it must never register the ordinary aggregate worker heartbeat. The
 * heartbeat lifecycle writes admission rows even when no generation is due.
 */
export async function startRecoveryAwareWorkerLifecycle(
  input: RecoveryAwareWorkerStartInput,
): Promise<RecoveryAwareWorkerStartMode> {
  if (!input.enabled) return "disabled";
  if (input.recoveryOnly) {
    await input.startRecoveryWork();
    return "recovery-without-heartbeat";
  }
  await input.startHeartbeatManagedWork();
  return "heartbeat-managed";
}

export type RecoveryAwareWorkerShutdownInput = Readonly<{
  recoveryOnly: boolean;
  beginHeartbeatShutdown(): void;
  stopRecoveryWork(): Promise<void>;
  stopHeartbeatManagedWork(): Promise<void>;
  stopHeartbeat(): Promise<void>;
}>;

/** Starts the stop path synchronously so no poller can claim new work. */
export function beginRecoveryAwareWorkerShutdown(
  input: RecoveryAwareWorkerShutdownInput,
): Promise<void> {
  if (input.recoveryOnly) return input.stopRecoveryWork();
  input.beginHeartbeatShutdown();
  return (async () => {
    await input.stopHeartbeatManagedWork();
    await input.stopHeartbeat();
  })();
}
