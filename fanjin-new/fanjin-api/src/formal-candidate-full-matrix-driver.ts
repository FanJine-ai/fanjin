#!/usr/bin/env node

import { formalCandidateFullMatrixSelfCheck } from "./formal-candidate-full-matrix-self-check";

// This tiny signed-artifact entrypoint is the sole production invocation of
// the full-matrix driver. Self-check must remain a zero-I/O operation, so it
// completes before importing the paid graph (which owns a database-backed
// authorization read model). Every non-self-check invocation still delegates
// exactly once to the canonical driver main.
async function run(): Promise<void> {
  const argumentsSnapshot = process.argv.slice(2);
  if (
    argumentsSnapshot.length === 0
    || (
      argumentsSnapshot.length === 1
      && argumentsSnapshot[0] === "--self-check"
    )
  ) {
    process.stdout.write(
      `${JSON.stringify(formalCandidateFullMatrixSelfCheck(), null, 2)}\n`,
    );
    return;
  }
  const { main } = await import(
    "../scripts/verify-workbench-full-matrix-real-candidate"
  );
  await main();
}

void run().catch(() => {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    errorCode: "FULL_MATRIX_DRIVER_BOOTSTRAP_FAILED",
    paidCallsStarted: 0,
    automaticPaidRetry: false,
    outputRedacted: true,
  }, null, 2)}\n`);
  process.exitCode = 1;
});
