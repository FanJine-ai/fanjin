#!/usr/bin/env node

import {
  FormalCandidateRuntimeBootstrapError,
  startFormalCandidateRuntimeBootstrap,
  waitForFormalCandidateRuntimeShutdownSignal,
} from "./lib/formalCandidateRuntimeBootstrap";
import { CandidateRuntimeAttestationError } from "./lib/candidateRuntimeAttestation";

export const FORMAL_CANDIDATE_RUNTIME_ENTRYPOINT_FORMAT =
  "fanjin-formal-candidate-runtime-entrypoint/v1" as const;

async function loadFixedApplication() {
  // This literal is the only application entry accepted by the signed runtime
  // entrypoint.  The launcher fixes FANJIN_DISABLE_AUTO_START=1 before this
  // module is evaluated; start is invoked exactly once after FD4 and the
  // artifact-bound runtime authority have both been verified.
  const application = await import("./app");
  return Object.freeze({
    start: async () => Number(await application.default(false)),
    stop: application.closeServe,
  });
}

export async function runFormalCandidateRuntimeEntrypoint(): Promise<number> {
  const controller = await startFormalCandidateRuntimeBootstrap(
    loadFixedApplication,
  );
  return await waitForFormalCandidateRuntimeShutdownSignal(controller);
}

function publicFailureCode(error: unknown): string {
  if (
    error instanceof FormalCandidateRuntimeBootstrapError
    || error instanceof CandidateRuntimeAttestationError
  ) {
    return error.code;
  }
  return "FORMAL_CANDIDATE_RUNTIME_ENTRYPOINT_FAILED";
}

if (require.main === module) {
  void runFormalCandidateRuntimeEntrypoint().then(
    (status) => { process.exitCode = status; },
    (error) => {
      process.stderr.write(`${publicFailureCode(error)}\n`);
      process.exitCode = 1;
    },
  );
}
