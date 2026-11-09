import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const FORMAL_CANDIDATE_APP_READINESS_FORMAT =
  "fanjin-formal-candidate-app-readiness/v1" as const;
export const FORMAL_CANDIDATE_READINESS_FD = 3 as const;
export const FORMAL_CANDIDATE_READINESS_FD_ENV =
  "FANJIN_FORMAL_CANDIDATE_READINESS_FD" as const;
export const FORMAL_CANDIDATE_READINESS_NONCE_ENV =
  "FANJIN_FORMAL_CANDIDATE_READINESS_NONCE" as const;

const COMMAND_BINDING_DOMAIN =
  "fanjin-formal-candidate-app-readiness/v1/command";
const NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type FormalCandidateAppReadinessHandshake = Readonly<{
  format: typeof FORMAL_CANDIDATE_APP_READINESS_FORMAT;
  nonce: string;
  pid: number;
  ppid: number;
  pgid: number;
  startEpochMs: number;
  commandBinding: string;
}>;

export function buildFormalCandidateAppCommandBinding(input: Readonly<{
  executable: string;
  args: readonly string[];
  cwd: string;
}>): string {
  const canonical = JSON.stringify({
    args: [...input.args],
    cwd: input.cwd,
    domain: COMMAND_BINDING_DOMAIN,
    executable: input.executable,
  });
  return `sha256:${crypto.createHash("sha256").update(canonical).digest("hex")}`;
}

/**
 * The application calls this only after its HTTP listener or worker heartbeat
 * is ready. The nonce travels over a launcher-created dedicated pipe; stdout
 * and application logs cannot satisfy the handshake.
 */
export function emitFormalCandidateReadinessHandshake(): void {
  if (process.env.FANJIN_FORMAL_CANDIDATE_LAUNCHED !== "1") return;
  const fdText = String(process.env[FORMAL_CANDIDATE_READINESS_FD_ENV] || "");
  const nonce = String(process.env[FORMAL_CANDIDATE_READINESS_NONCE_ENV] || "");
  if (fdText !== String(FORMAL_CANDIDATE_READINESS_FD) || !NONCE_PATTERN.test(nonce)) {
    throw new Error("FORMAL_CANDIDATE_APP_READINESS_CHANNEL_INVALID");
  }
  const executable = fs.realpathSync(process.execPath);
  const cwd = fs.realpathSync(process.cwd());
  const args = process.argv.slice(1).map((value) => path.resolve(value));
  const startEpochMs = Math.round(Date.now() - process.uptime() * 1_000);
  const readiness: FormalCandidateAppReadinessHandshake = Object.freeze({
    format: FORMAL_CANDIDATE_APP_READINESS_FORMAT,
    nonce,
    pid: process.pid,
    ppid: process.ppid,
    // The detached launcher is the process-group leader. This is only a child
    // claim until the host supervisor checks the exact kernel PGID.
    pgid: process.ppid,
    startEpochMs,
    commandBinding: buildFormalCandidateAppCommandBinding({
      executable,
      args,
      cwd,
    }),
  });
  try {
    fs.writeSync(
      FORMAL_CANDIDATE_READINESS_FD,
      `${JSON.stringify(readiness)}\n`,
      null,
      "utf8",
    );
  } finally {
    try {
      fs.closeSync(FORMAL_CANDIDATE_READINESS_FD);
    } finally {
      delete process.env[FORMAL_CANDIDATE_READINESS_FD_ENV];
      delete process.env[FORMAL_CANDIDATE_READINESS_NONCE_ENV];
    }
  }
}
