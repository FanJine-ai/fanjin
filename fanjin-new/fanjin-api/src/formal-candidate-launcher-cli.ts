#!/usr/bin/env node

import {
  FormalCandidateLauncherError,
  runFormalCandidateLauncher,
} from "./formal-candidate-launcher";

void runFormalCandidateLauncher().then((status) => {
  process.exitCode = status;
}).catch((error) => {
  const code = error instanceof FormalCandidateLauncherError
    ? error.code
    : "FORMAL_CANDIDATE_LAUNCHER_UNEXPECTED_FAILURE";
  process.stderr.write(`${JSON.stringify({ ok: false, code })}\n`);
  process.exitCode = 1;
});
