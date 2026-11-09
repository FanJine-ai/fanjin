import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { aroundAll } from "vitest";
import {
  closeTestDatabaseLifecycles,
  type TestDatabaseLifecycle,
} from "./databaseLifecycle";

const TEST_DATABASE_LIFECYCLES = Symbol.for("fanjin.test.database-lifecycles");
const previousDatabaseLifecycles = (globalThis as any)[TEST_DATABASE_LIFECYCLES] as
  | Set<TestDatabaseLifecycle>
  | undefined;
const databaseLifecycles = previousDatabaseLifecycles ?? new Set<TestDatabaseLifecycle>();

// Vitest skips suite hooks when a file fails during collection. Reuse any
// uncleared registry in the next file instead of losing those resources;
// successful files delete the registry during their outermost suite cleanup.
(globalThis as any)[TEST_DATABASE_LIFECYCLES] = databaseLifecycles;

const closeTestDatabases = async () => {
  const lifecycles = [...databaseLifecycles];
  databaseLifecycles.clear();
  if ((globalThis as any)[TEST_DATABASE_LIFECYCLES] === databaseLifecycles) {
    delete (globalThis as any)[TEST_DATABASE_LIFECYCLES];
  }

  // The strict PostgreSQL 16 lane points the application database at a fresh
  // database and therefore waits for the complete production schema before
  // teardown. The schema-52 catalog can take more than 60s on a cold or
  // contended Docker Desktop volume; keep the release lane bounded while
  // avoiding a deterministic teardown race. Client shutdown retains its
  // independent 30s fail-closed bound.
  await closeTestDatabaseLifecycles(
    lifecycles,
    process.env.FANJIN_REQUIRE_PG16 === "1"
      ? { readyTimeoutMs: 120_000, closeTimeoutMs: 30_000 }
      : {},
  );
};

// setupFiles registers this first, making it the outermost suite wrapper. The
// finally block still runs if a suite-owned afterAll hook fails, preventing a
// successfully collected file from leaving migrations in the next environment.
aroundAll(async (runSuite) => {
  try {
    await runSuite();
  } finally {
    await closeTestDatabases();
  }
});

const runId = `${Date.now()}-${process.pid}`;
const testRunRoot = process.env.FANJIN_TEST_RUN_ROOT || path.resolve(process.cwd(), ".test-data");
const dataDir = path.join(testRunRoot, runId);

fs.mkdirSync(dataDir, { recursive: true });

// Every isolated Vitest file gets its own SQLite/data directory. Remove these
// reproducible artifacts when the worker exits so repeated full-suite runs do
// not eventually fill the developer or CI disk.
let cleaned = false;
const cleanupDataDir = () => {
  if (cleaned) return;
  cleaned = true;
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Process exit must not be turned into a test failure by best-effort
    // artifact cleanup (for example, an already removed temp directory).
  }
};

// The global teardown removes the complete run root after all suites and
// their database/server hooks have closed. Keep this as a fallback for a
// worker that exits normally before global teardown.
process.once("exit", cleanupDataDir);

process.env.NODE_ENV = "test";
process.env.FANJIN_DISABLE_AUTO_START = "1";
process.env.FANJIN_PROCESS_ROLE = "api";
process.env.FANJIN_DISABLE_RELAY_WORKER = "1";
process.env.FANJIN_DISABLE_GIFT_GRANT_EXPIRY_WORKER = "1";
process.env.FANJIN_DISABLE_MEMBERSHIP_GRANT_WORKER = "1";
process.env.FANJIN_DISABLE_NOVEL_EVENT_EXTRACTION = "1";
process.env.FANJIN_DISABLE_STORYBOARD_IMAGE_GENERATION = "1";
// Existing release-deployment suites exercise the archived controller by
// explicit opt-in. Production defaults to the converged publisher because the
// flag is fail-closed when absent.
process.env.FANJIN_LEGACY_RELEASE_DEPLOYMENT_WRITES_ENABLED = "true";
process.env.FANJIN_MAX_REQUEST_BODY_MB = "1";
process.env.FANJIN_DATA_DIR = dataDir;
process.env.FANJIN_ROOT_PASSWORD = "admin123";
process.env.FANJIN_EXPOSE_RESET_TOKEN = "1";
process.env.FANJIN_PUBLIC_BASE_URL = process.env.FANJIN_PUBLIC_BASE_URL || "http://127.0.0.1:5173";
process.env.FANJIN_APP_PUBLIC_URL = process.env.FANJIN_APP_PUBLIC_URL || process.env.FANJIN_PUBLIC_BASE_URL;
// Most legacy suites expect register → session. Dedicated verification tests unset this.
process.env.FANJIN_TEST_AUTO_VERIFY_EMAIL = process.env.FANJIN_TEST_AUTO_VERIFY_EMAIL || "1";
process.env.FANJIN_OBJECT_STORAGE_PROVIDER = "local";
// A developer or CI host may export production Redis settings globally.
// Unit/API tests must never connect to that Redis implicitly; suites that
// exercise Redis inject an isolated environment and a fake/local client.
delete process.env.REDIS_URL;
for (const name of Object.keys(process.env)) {
  if (name.startsWith("FANJIN_REDIS_")) delete process.env[name];
}
delete process.env.FANJIN_OBJECT_STORAGE_DRIVER;
delete process.env.FANJIN_OBJECT_STORAGE_BUCKET;
delete process.env.FANJIN_OBJECT_STORAGE_REGION;
delete process.env.FANJIN_OBJECT_STORAGE_ENDPOINT;
delete process.env.FANJIN_OBJECT_STORAGE_CDN_URL;
delete process.env.FANJIN_OBJECT_STORAGE_ACCESS_KEY;
delete process.env.FANJIN_OBJECT_STORAGE_SECRET_KEY;
delete process.env.FANJIN_OBJECT_STORAGE_KEY_PREFIX;
delete process.env.FANJIN_OBJECT_STORAGE_URL_MODE;
delete process.env.FANJIN_OBJECT_STORAGE_SIGNED_URL_TTL_SECONDS;
delete process.env.FANJIN_OBJECT_STORAGE_FORCE_PATH_STYLE;
delete process.env.FANJIN_OBJECT_STORAGE_CORS_ORIGINS;
process.env.TMPDIR = os.tmpdir();
