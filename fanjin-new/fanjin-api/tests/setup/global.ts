import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export function setup() {
  const configuredTestDataRoot = process.env.FANJIN_TEST_DATA_ROOT?.trim();
  const testDataRoot = configuredTestDataRoot
    ? path.resolve(configuredTestDataRoot)
    : path.resolve(process.cwd(), ".test-data");
  const runRoot = path.join(testDataRoot, `run-${Date.now()}-${process.pid}-${randomUUID()}`);
  fs.mkdirSync(runRoot, { recursive: true });
  process.env.FANJIN_TEST_RUN_ROOT = runRoot;

  return () => {
    fs.rmSync(runRoot, { recursive: true, force: true });
    if (
      !configuredTestDataRoot
      && fs.existsSync(testDataRoot)
      && fs.readdirSync(testDataRoot).length === 0
    ) {
      fs.rmdirSync(testDataRoot);
    }
    delete process.env.FANJIN_TEST_RUN_ROOT;
  };
}
