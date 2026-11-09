import { randomUUID } from "node:crypto";
import os from "node:os";

const PROCESS_BOOT_ID = randomUUID();

/** A process-lifetime identity that cannot be reused by a later PID incarnation. */
export function processBootIdentity(input: {
  hostname?: string;
  processId?: number;
} = {}): Readonly<{
  processBootId: string;
  hostname: string;
  processId: number;
  incarnationId: string;
}> {
  const hostname = String(input.hostname ?? os.hostname()).trim();
  const processId = Number(input.processId ?? process.pid);
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/u.test(hostname)
    || !Number.isSafeInteger(processId)
    || processId < 1
  ) throw new Error("process boot identity is invalid");
  return Object.freeze({
    processBootId: PROCESS_BOOT_ID,
    hostname,
    processId,
    incarnationId: `background:${hostname}:${processId}:${PROCESS_BOOT_ID}`,
  });
}
