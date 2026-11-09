import { createHash } from "node:crypto";

export const RELEASE_FULL_MAINTENANCE_SSH_MUTATION_UNCERTAINTY_FORMAT =
  "fanjin-release-full-maintenance-ssh-mutation-uncertainty/v1" as const;

// Production maintenance mutation calls are bounded twice: the local SSH
// child has a fixed outer deadline, while the remote fixed-action wrapper has
// a bounded exclusive-lock wait and a fixed action timeout. Recovery waits the
// complete remote lifetime from takeover before trusting a second stopped
// observation, so an orphaned old-owner SSH session cannot activate late.
export const RELEASE_FULL_MAINTENANCE_SSH_CONNECT_TIMEOUT_MAX_MS = 120_000 as const;
export const RELEASE_FULL_MAINTENANCE_SSH_LOCAL_CHILD_TIMEOUT_MAX_MS =
  45 * 60_000;
export const RELEASE_FULL_MAINTENANCE_SSH_REMOTE_LOCK_WAIT_MAX_MS =
  10 * 60_000;
export const RELEASE_FULL_MAINTENANCE_SSH_REMOTE_ACTION_TIMEOUT_MAX_MS =
  45 * 60_000;
export const RELEASE_FULL_MAINTENANCE_SSH_REMOTE_KILL_GRACE_MS = 5_000 as const;
export const RELEASE_FULL_MAINTENANCE_SSH_ORPHAN_SETTLE_MS =
  RELEASE_FULL_MAINTENANCE_SSH_CONNECT_TIMEOUT_MAX_MS
  + RELEASE_FULL_MAINTENANCE_SSH_REMOTE_LOCK_WAIT_MAX_MS
  + RELEASE_FULL_MAINTENANCE_SSH_REMOTE_ACTION_TIMEOUT_MAX_MS
  + RELEASE_FULL_MAINTENANCE_SSH_REMOTE_KILL_GRACE_MS;

export interface ReleaseFullMaintenanceSshMutationUncertaintyBinding {
  format: typeof RELEASE_FULL_MAINTENANCE_SSH_MUTATION_UNCERTAINTY_FORMAT;
  connectTimeoutMaxMs: typeof RELEASE_FULL_MAINTENANCE_SSH_CONNECT_TIMEOUT_MAX_MS;
  localChildTimeoutMaxMs: number;
  remoteLockWaitMaxMs: number;
  remoteActionTimeoutMaxMs: number;
  remoteKillGraceMs: typeof RELEASE_FULL_MAINTENANCE_SSH_REMOTE_KILL_GRACE_MS;
  settleMs: number;
  bindingSha256: string;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(object[key])}`
  )).join(",")}}`;
}

export function releaseFullMaintenanceSshMutationUncertaintyBinding():
ReleaseFullMaintenanceSshMutationUncertaintyBinding {
  const commitment = Object.freeze({
    format: RELEASE_FULL_MAINTENANCE_SSH_MUTATION_UNCERTAINTY_FORMAT,
    connectTimeoutMaxMs: RELEASE_FULL_MAINTENANCE_SSH_CONNECT_TIMEOUT_MAX_MS,
    localChildTimeoutMaxMs: RELEASE_FULL_MAINTENANCE_SSH_LOCAL_CHILD_TIMEOUT_MAX_MS,
    remoteLockWaitMaxMs: RELEASE_FULL_MAINTENANCE_SSH_REMOTE_LOCK_WAIT_MAX_MS,
    remoteActionTimeoutMaxMs: RELEASE_FULL_MAINTENANCE_SSH_REMOTE_ACTION_TIMEOUT_MAX_MS,
    remoteKillGraceMs: RELEASE_FULL_MAINTENANCE_SSH_REMOTE_KILL_GRACE_MS,
    settleMs: RELEASE_FULL_MAINTENANCE_SSH_ORPHAN_SETTLE_MS,
  });
  return Object.freeze({
    ...commitment,
    bindingSha256: createHash("sha256")
      .update(canonicalJson(commitment), "utf8")
      .digest("hex"),
  });
}

export function assertReleaseFullMaintenanceSshMutationUncertaintyBinding(
  value: unknown,
): ReleaseFullMaintenanceSshMutationUncertaintyBinding {
  const expected = releaseFullMaintenanceSshMutationUncertaintyBinding();
  if (canonicalJson(value) !== canonicalJson(expected)) {
    throw Object.assign(
      new Error("full-maintenance SSH mutation uncertainty binding is invalid"),
      { code: "RELEASE_FULL_MAINTENANCE_SSH_MUTATION_UNCERTAINTY_INVALID" },
    );
  }
  return expected;
}
