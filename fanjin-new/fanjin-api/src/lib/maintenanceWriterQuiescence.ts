import { createHash, randomBytes } from "node:crypto";
import fs, { constants } from "node:fs";
import path from "node:path";

import type { Knex } from "knex";

export const MAINTENANCE_WRITER_QUIESCENCE_FORMAT =
  "fanjin-maintenance-writer-quiescence/v1" as const;

const SAFE_OPERATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{5,127}$/u;
const SAFE_NONCE_RE = /^[A-Za-z0-9_-]{32,128}$/u;
const POSTGRES_ROLE_RE = /^[a-z_][a-z0-9_$]{0,62}$/u;
const SHA256_RE = /^[a-f0-9]{64}$/u;
const MAX_SESSIONS = 256;
const MAX_SAMPLE_INTERVAL_MS = 30 * 60_000;
const MAX_PROOF_BYTES = 1024 * 1024;
const SNAPSHOT_KEYS = Object.freeze([
  "databaseIdentitySha256",
  "databaseName",
  "schemaName",
  "observerPid",
  "observerRole",
  "observedAtMs",
  "allowedDatabaseRoles",
  "applicationDatabaseRoles",
  "sessions",
  "snapshotSha256",
] as const);
const SESSION_KEYS = Object.freeze([
  "pid",
  "databaseRole",
  "applicationName",
  "clientAddress",
  "backendStartedAtMs",
  "state",
] as const);
const PROOF_KEYS = Object.freeze([
  "format",
  "deploymentId",
  "nonce",
  "databaseIdentitySha256",
  "minimumSampleIntervalMs",
  "maximumSampleIntervalMs",
  "allowedDatabaseRoles",
  "applicationDatabaseRoles",
  "samples",
  "proofSha256",
] as const);

export class MaintenanceWriterQuiescenceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MaintenanceWriterQuiescenceError";
  }
}

function fail(code: string, message: string): never {
  throw new MaintenanceWriterQuiescenceError(code, message);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(object[key])}`
  )).join(",")}}`;
}

function hasExactKeys(value: unknown, keys: readonly string[]): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const observed = Object.keys(value);
  return observed.length === keys.length
    && observed.every((key, index) => key === keys[index]);
}

function rawRows(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) {
    const rows = Array.isArray(result[0]) ? result[0] : result;
    return rows.filter((row): row is Record<string, unknown> => (
      Boolean(row) && typeof row === "object" && !Array.isArray(row)
    ));
  }
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows)
    ? rows.filter((row): row is Record<string, unknown> => (
      Boolean(row) && typeof row === "object" && !Array.isArray(row)
    ))
    : [];
}

function exactText(value: unknown, label: string, maximum = 255): string {
  const normalized = String(value ?? "");
  if (
    normalized.length < 1
    || normalized.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    fail("MAINTENANCE_WRITER_SNAPSHOT_INVALID", `${label} is invalid`);
  }
  return normalized;
}

function integer(value: unknown, label: string, minimum = 0): number {
  const normalized = typeof value === "string" && /^[0-9]+$/u.test(value)
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(normalized) || Number(normalized) < minimum) {
    fail("MAINTENANCE_WRITER_SNAPSHOT_INVALID", `${label} is invalid`);
  }
  return Number(normalized);
}

function exactRoles(values: readonly string[], label: string): string[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > 16) {
    fail("MAINTENANCE_WRITER_ROLE_ALLOWLIST_INVALID", `${label} is invalid`);
  }
  const roles = values.map((value) => String(value || "").trim()).sort();
  if (
    roles.some((role) => !POSTGRES_ROLE_RE.test(role))
    || new Set(roles).size !== roles.length
  ) {
    fail("MAINTENANCE_WRITER_ROLE_ALLOWLIST_INVALID", `${label} is invalid`);
  }
  return roles;
}

export interface MaintenanceDatabaseSessionIdentity {
  pid: number;
  databaseRole: string;
  applicationName: string;
  clientAddress: string;
  backendStartedAtMs: number;
  state: string;
}

export interface MaintenanceWriterSessionSnapshot {
  databaseIdentitySha256: string;
  databaseName: string;
  schemaName: string;
  observerPid: number;
  observerRole: string;
  observedAtMs: number;
  allowedDatabaseRoles: string[];
  applicationDatabaseRoles: string[];
  sessions: MaintenanceDatabaseSessionIdentity[];
  snapshotSha256: string;
}

export interface MaintenanceWriterQuiescenceProof {
  format: typeof MAINTENANCE_WRITER_QUIESCENCE_FORMAT;
  deploymentId: string;
  nonce: string;
  databaseIdentitySha256: string;
  minimumSampleIntervalMs: number;
  maximumSampleIntervalMs: number;
  allowedDatabaseRoles: string[];
  applicationDatabaseRoles: string[];
  samples: [MaintenanceWriterSessionSnapshot, MaintenanceWriterSessionSnapshot];
  proofSha256: string;
}

export interface PersistedMaintenanceWriterQuiescenceProof {
  filePath: string;
  contentSha256: string;
  proof: MaintenanceWriterQuiescenceProof;
}

function normalizedSession(
  row: Record<string, unknown>,
): MaintenanceDatabaseSessionIdentity {
  return {
    pid: integer(row.pid, "session.pid", 1),
    databaseRole: exactText(row.database_role, "session.databaseRole", 63),
    applicationName: exactText(
      String(row.application_name || "unnamed"),
      "session.applicationName",
      128,
    ),
    clientAddress: exactText(
      String(row.client_address || "local"),
      "session.clientAddress",
      128,
    ),
    backendStartedAtMs: integer(
      row.backend_started_at_ms,
      "session.backendStartedAtMs",
      1,
    ),
    state: exactText(String(row.state || "unknown"), "session.state", 64),
  };
}

function snapshotCommitment(
  snapshot: Omit<MaintenanceWriterSessionSnapshot, "snapshotSha256">,
): string {
  return canonicalJson(snapshot);
}

function assertSnapshot(
  snapshot: MaintenanceWriterSessionSnapshot,
  input: {
    databaseIdentitySha256: string;
    allowedDatabaseRoles: readonly string[];
    applicationDatabaseRoles: readonly string[];
  },
): void {
  if (
    !hasExactKeys(snapshot, SNAPSHOT_KEYS)
    || !Array.isArray(snapshot.sessions)
    || snapshot.sessions.some((session) => !hasExactKeys(session, SESSION_KEYS))
  ) {
    fail("MAINTENANCE_WRITER_SNAPSHOT_INVALID", "writer snapshot shape is invalid");
  }
  const allowedRoles = exactRoles(input.allowedDatabaseRoles, "allowedDatabaseRoles");
  const applicationRoles = exactRoles(
    input.applicationDatabaseRoles,
    "applicationDatabaseRoles",
  );
  if (applicationRoles.some((role) => allowedRoles.includes(role))) {
    fail(
      "MAINTENANCE_WRITER_ROLE_ALLOWLIST_OVERLAP",
      "application database roles cannot be allowlisted during maintenance",
    );
  }
  if (
    !SHA256_RE.test(snapshot.databaseIdentitySha256)
    || snapshot.databaseIdentitySha256 !== input.databaseIdentitySha256
    || snapshot.allowedDatabaseRoles.join("\0") !== allowedRoles.join("\0")
    || snapshot.applicationDatabaseRoles.join("\0") !== applicationRoles.join("\0")
    || !allowedRoles.includes(snapshot.observerRole)
    || !Number.isSafeInteger(snapshot.observerPid)
    || snapshot.observerPid < 1
    || !Number.isSafeInteger(snapshot.observedAtMs)
    || snapshot.observedAtMs < 1
    || snapshot.sessions.length < 1
    || snapshot.sessions.length > MAX_SESSIONS
    || new Set(snapshot.sessions.map(({ pid }) => pid)).size !== snapshot.sessions.length
    || !snapshot.sessions.some(({ pid, databaseRole }) => (
      pid === snapshot.observerPid && databaseRole === snapshot.observerRole
    ))
  ) {
    fail("MAINTENANCE_WRITER_SNAPSHOT_INVALID", "writer snapshot identity is invalid");
  }
  if (snapshot.sessions.some(({ databaseRole }) => applicationRoles.includes(databaseRole))) {
    fail(
      "MAINTENANCE_APPLICATION_DATABASE_CONNECTION_ACTIVE",
      "an application database role still has an active client connection",
    );
  }
  if (snapshot.sessions.some(({ databaseRole }) => !allowedRoles.includes(databaseRole))) {
    fail(
      "MAINTENANCE_DATABASE_CONNECTION_NOT_ALLOWLISTED",
      "a non-allowlisted database session is active during maintenance",
    );
  }
  const sorted = [...snapshot.sessions].sort((left, right) => (
    left.pid - right.pid
      || left.databaseRole.localeCompare(right.databaseRole)
      || left.applicationName.localeCompare(right.applicationName)
  ));
  if (canonicalJson(sorted) !== canonicalJson(snapshot.sessions)) {
    fail("MAINTENANCE_WRITER_SNAPSHOT_INVALID", "writer sessions are not canonical");
  }
  const { snapshotSha256, ...commitment } = snapshot;
  if (
    !SHA256_RE.test(snapshotSha256)
    || snapshotSha256 !== sha256(snapshotCommitment(commitment))
  ) {
    fail("MAINTENANCE_WRITER_SNAPSHOT_DIGEST_MISMATCH", "writer snapshot digest is invalid");
  }
}

export async function collectMaintenanceWriterSessionSnapshot(input: {
  database: Knex;
  databaseIdentitySha256: string;
  allowedDatabaseRoles: readonly string[];
  applicationDatabaseRoles: readonly string[];
}): Promise<MaintenanceWriterSessionSnapshot> {
  if (!SHA256_RE.test(input.databaseIdentitySha256)) {
    fail("MAINTENANCE_DATABASE_IDENTITY_INVALID", "database identity is invalid");
  }
  const allowedRoles = exactRoles(input.allowedDatabaseRoles, "allowedDatabaseRoles");
  const applicationRoles = exactRoles(
    input.applicationDatabaseRoles,
    "applicationDatabaseRoles",
  );
  if (applicationRoles.some((role) => allowedRoles.includes(role))) {
    fail(
      "MAINTENANCE_WRITER_ROLE_ALLOWLIST_OVERLAP",
      "application database roles cannot be allowlisted during maintenance",
    );
  }
  let rows: Array<Record<string, unknown>>;
  try {
    rows = rawRows(await input.database.raw(`
      SELECT
        activity.pid::text AS pid,
        activity.usename AS database_role,
        COALESCE(NULLIF(activity.application_name, ''), 'unnamed') AS application_name,
        COALESCE(activity.client_addr::text, 'local') AS client_address,
        FLOOR(EXTRACT(EPOCH FROM activity.backend_start) * 1000)::bigint::text
          AS backend_started_at_ms,
        COALESCE(activity.state, 'unknown') AS state,
        pg_backend_pid()::text AS observer_pid,
        current_user AS observer_role,
        current_database() AS database_name,
        current_schema() AS schema_name,
        FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint::text
          AS observed_at_ms
      FROM pg_catalog.pg_stat_activity AS activity
      WHERE activity.datname = current_database()
        AND activity.backend_type = 'client backend'
      ORDER BY activity.pid ASC,
               activity.usename ASC,
               activity.application_name ASC
    `));
  } catch {
    return fail(
      "MAINTENANCE_WRITER_SNAPSHOT_UNAVAILABLE",
      "database sessions cannot be inspected",
    );
  }
  if (rows.length < 1 || rows.length > MAX_SESSIONS) {
    fail("MAINTENANCE_WRITER_SNAPSHOT_INVALID", "database session count is invalid");
  }
  const first = rows[0];
  const observerPid = integer(first.observer_pid, "observerPid", 1);
  const observerRole = exactText(first.observer_role, "observerRole", 63);
  const databaseName = exactText(first.database_name, "databaseName", 128);
  const schemaName = exactText(first.schema_name, "schemaName", 128);
  const observedAtMs = integer(first.observed_at_ms, "observedAtMs", 1);
  if (rows.some((row) => (
    integer(row.observer_pid, "observerPid", 1) !== observerPid
    || exactText(row.observer_role, "observerRole", 63) !== observerRole
    || exactText(row.database_name, "databaseName", 128) !== databaseName
    || exactText(row.schema_name, "schemaName", 128) !== schemaName
    || integer(row.observed_at_ms, "observedAtMs", 1) < observedAtMs
      - 1_000
    || integer(row.observed_at_ms, "observedAtMs", 1) > observedAtMs
      + 1_000
  ))) {
    fail("MAINTENANCE_WRITER_SNAPSHOT_INVALID", "database observation is inconsistent");
  }
  const sessions = rows.map(normalizedSession).sort((left, right) => (
    left.pid - right.pid
      || left.databaseRole.localeCompare(right.databaseRole)
      || left.applicationName.localeCompare(right.applicationName)
  ));
  const commitment = {
    databaseIdentitySha256: input.databaseIdentitySha256,
    databaseName,
    schemaName,
    observerPid,
    observerRole,
    observedAtMs,
    allowedDatabaseRoles: allowedRoles,
    applicationDatabaseRoles: applicationRoles,
    sessions,
  };
  const snapshot: MaintenanceWriterSessionSnapshot = {
    ...commitment,
    snapshotSha256: sha256(snapshotCommitment(commitment)),
  };
  assertSnapshot(snapshot, input);
  return snapshot;
}

export function createMaintenanceWriterQuiescenceProof(input: {
  deploymentId: string;
  nonce: string;
  databaseIdentitySha256: string;
  allowedDatabaseRoles: readonly string[];
  applicationDatabaseRoles: readonly string[];
  first: MaintenanceWriterSessionSnapshot;
  second: MaintenanceWriterSessionSnapshot;
  minimumSampleIntervalMs: number;
  maximumSampleIntervalMs?: number;
}): MaintenanceWriterQuiescenceProof {
  if (!SAFE_OPERATION_ID_RE.test(input.deploymentId)) {
    fail("MAINTENANCE_DEPLOYMENT_ID_INVALID", "maintenance deployment id is invalid");
  }
  if (!SAFE_NONCE_RE.test(input.nonce)) {
    fail("MAINTENANCE_ACTIVATION_NONCE_INVALID", "maintenance activation nonce is invalid");
  }
  if (!SHA256_RE.test(input.databaseIdentitySha256)) {
    fail("MAINTENANCE_DATABASE_IDENTITY_INVALID", "database identity is invalid");
  }
  const minimumSampleIntervalMs = integer(
    input.minimumSampleIntervalMs,
    "minimumSampleIntervalMs",
    1_000,
  );
  const maximumSampleIntervalMs = integer(
    input.maximumSampleIntervalMs ?? MAX_SAMPLE_INTERVAL_MS,
    "maximumSampleIntervalMs",
    minimumSampleIntervalMs,
  );
  if (maximumSampleIntervalMs > MAX_SAMPLE_INTERVAL_MS) {
    fail("MAINTENANCE_WRITER_SAMPLE_INTERVAL_INVALID", "sample interval is invalid");
  }
  const roles = {
    allowedDatabaseRoles: exactRoles(
      input.allowedDatabaseRoles,
      "allowedDatabaseRoles",
    ),
    applicationDatabaseRoles: exactRoles(
      input.applicationDatabaseRoles,
      "applicationDatabaseRoles",
    ),
  };
  assertSnapshot(input.first, { databaseIdentitySha256: input.databaseIdentitySha256, ...roles });
  assertSnapshot(input.second, { databaseIdentitySha256: input.databaseIdentitySha256, ...roles });
  const elapsed = input.second.observedAtMs - input.first.observedAtMs;
  if (elapsed < minimumSampleIntervalMs || elapsed > maximumSampleIntervalMs) {
    fail("MAINTENANCE_WRITER_SAMPLE_INTERVAL_INVALID", "writer sample interval is invalid");
  }
  const commitment = {
    format: MAINTENANCE_WRITER_QUIESCENCE_FORMAT,
    deploymentId: input.deploymentId,
    nonce: input.nonce,
    databaseIdentitySha256: input.databaseIdentitySha256,
    minimumSampleIntervalMs,
    maximumSampleIntervalMs,
    ...roles,
    samples: [input.first, input.second] as [
      MaintenanceWriterSessionSnapshot,
      MaintenanceWriterSessionSnapshot,
    ],
  };
  return {
    ...commitment,
    proofSha256: sha256(canonicalJson(commitment)),
  };
}

export function assertMaintenanceWriterQuiescenceProof(
  proof: MaintenanceWriterQuiescenceProof,
  expected: {
    deploymentId: string;
    nonce: string;
    databaseIdentitySha256: string;
    allowedDatabaseRoles: readonly string[];
    applicationDatabaseRoles: readonly string[];
  },
): void {
  if (
    !hasExactKeys(proof, PROOF_KEYS)
    || !Array.isArray(proof.samples)
    || proof.samples.length !== 2
  ) {
    fail(
      "MAINTENANCE_WRITER_QUIESCENCE_PROOF_MISMATCH",
      "writer quiescence proof shape is invalid",
    );
  }
  const rebuilt = createMaintenanceWriterQuiescenceProof({
    ...expected,
    first: proof.samples?.[0],
    second: proof.samples?.[1],
    minimumSampleIntervalMs: proof.minimumSampleIntervalMs,
    maximumSampleIntervalMs: proof.maximumSampleIntervalMs,
  });
  if (
    proof.format !== MAINTENANCE_WRITER_QUIESCENCE_FORMAT
    || proof.deploymentId !== expected.deploymentId
    || proof.nonce !== expected.nonce
    || proof.proofSha256 !== rebuilt.proofSha256
    || canonicalJson(proof) !== canonicalJson(rebuilt)
  ) {
    fail(
      "MAINTENANCE_WRITER_QUIESCENCE_PROOF_MISMATCH",
      "writer quiescence proof does not match the maintenance activation",
    );
  }
}

function trustedOwner(uid: number): boolean {
  const effectiveUid = typeof process.geteuid === "function" ? process.geteuid() : uid;
  return uid === effectiveUid || uid === 0;
}

function protectedProofDirectory(directory: string, create: boolean): string {
  if (!path.isAbsolute(directory)) {
    fail(
      "MAINTENANCE_WRITER_PROOF_DIRECTORY_UNSAFE",
      "writer proof directory must be absolute",
    );
  }
  const resolved = path.resolve(directory);
  if (create && !fs.existsSync(resolved)) {
    try {
      fs.mkdirSync(resolved, { mode: 0o700 });
      fs.chmodSync(resolved, 0o700);
    } catch {
      fail(
        "MAINTENANCE_WRITER_PROOF_DIRECTORY_UNSAFE",
        "writer proof directory cannot be created safely",
      );
    }
  }
  let stat: fs.Stats;
  let canonical: string;
  try {
    stat = fs.lstatSync(resolved);
    canonical = fs.realpathSync(resolved);
  } catch {
    return fail(
      "MAINTENANCE_WRITER_PROOF_DIRECTORY_UNSAFE",
      "writer proof directory is unavailable",
    );
  }
  if (
    canonical !== resolved
    || stat.isSymbolicLink()
    || !stat.isDirectory()
    || (stat.mode & 0o7777) !== 0o700
    || !trustedOwner(stat.uid)
  ) {
    fail(
      "MAINTENANCE_WRITER_PROOF_DIRECTORY_UNSAFE",
      "writer proof directory must be an owned canonical 0700 directory",
    );
  }
  return canonical;
}

function proofFileName(proofSha256: string): string {
  if (!SHA256_RE.test(proofSha256)) {
    fail("MAINTENANCE_WRITER_QUIESCENCE_PROOF_MISMATCH", "writer proof digest is invalid");
  }
  return `${proofSha256}.json`;
}

function assertSafeOpenAvailable(): void {
  if (!Number.isSafeInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW === 0) {
    fail(
      "MAINTENANCE_WRITER_PROOF_SAFE_OPEN_UNAVAILABLE",
      "safe writer proof file access is unsupported",
    );
  }
}

function readProtectedProofFile(filePath: string): Buffer {
  assertSafeOpenAvailable();
  if (!path.isAbsolute(filePath)) {
    fail("MAINTENANCE_WRITER_PROOF_FILE_UNSAFE", "writer proof file path must be absolute");
  }
  let before: fs.Stats;
  try {
    before = fs.lstatSync(filePath);
  } catch {
    return fail("MAINTENANCE_WRITER_PROOF_FILE_UNSAFE", "writer proof file is unavailable");
  }
  if (
    before.isSymbolicLink()
    || !before.isFile()
    || before.nlink !== 1
    || (before.mode & 0o7777) !== 0o600
    || !trustedOwner(before.uid)
    || before.size < 1
    || before.size > MAX_PROOF_BYTES
  ) {
    fail(
      "MAINTENANCE_WRITER_PROOF_FILE_UNSAFE",
      "writer proof must be an owned 0600 single-link regular file",
    );
  }
  const descriptor = fs.openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isFile()
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.uid !== before.uid
      || opened.nlink !== 1
      || (opened.mode & 0o7777) !== 0o600
      || opened.size !== before.size
      || opened.mtimeMs !== before.mtimeMs
    ) {
      fail("MAINTENANCE_WRITER_PROOF_FILE_UNSAFE", "writer proof changed during open");
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.lstatSync(filePath);
    if (
      after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.uid !== opened.uid
      || after.nlink !== 1
      || (after.mode & 0o7777) !== 0o600
      || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs
    ) {
      fail("MAINTENANCE_WRITER_PROOF_FILE_UNSAFE", "writer proof changed during read");
    }
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

/**
 * Atomically publishes the nonce-bearing writer proof in a protected private
 * directory. The final name is content-addressed and never replaced.
 */
export function persistMaintenanceWriterQuiescenceProof(input: {
  directory: string;
  proof: MaintenanceWriterQuiescenceProof;
  expected: {
    deploymentId: string;
    nonce: string;
    databaseIdentitySha256: string;
    allowedDatabaseRoles: readonly string[];
    applicationDatabaseRoles: readonly string[];
  };
}): PersistedMaintenanceWriterQuiescenceProof {
  assertMaintenanceWriterQuiescenceProof(input.proof, input.expected);
  assertSafeOpenAvailable();
  const directory = protectedProofDirectory(input.directory, true);
  const filePath = path.join(directory, proofFileName(input.proof.proofSha256));
  if (fs.existsSync(filePath)) {
    fail(
      "MAINTENANCE_WRITER_PROOF_ALREADY_EXISTS",
      "writer quiescence proof has already been published",
    );
  }
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${randomBytes(12).toString("hex")}.tmp`,
  );
  const bytes = Buffer.from(`${JSON.stringify(input.proof)}\n`, "utf8");
  if (bytes.length > MAX_PROOF_BYTES) {
    fail("MAINTENANCE_WRITER_PROOF_TOO_LARGE", "writer proof exceeds the protected file limit");
  }
  let descriptor: number | undefined;
  let published = false;
  try {
    descriptor = fs.openSync(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    fs.fchmodSync(descriptor, 0o600);
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(descriptor, bytes, offset, bytes.length - offset);
      if (written < 1) {
        fail("MAINTENANCE_WRITER_PROOF_WRITE_FAILED", "writer proof write made no progress");
      }
      offset += written;
    }
    fs.fsyncSync(descriptor);
    const temporary = fs.fstatSync(descriptor);
    if (
      !temporary.isFile()
      || temporary.nlink !== 1
      || (temporary.mode & 0o7777) !== 0o600
      || !trustedOwner(temporary.uid)
      || temporary.size !== bytes.length
    ) {
      fail("MAINTENANCE_WRITER_PROOF_WRITE_FAILED", "temporary writer proof is unsafe");
    }
    fs.closeSync(descriptor);
    descriptor = undefined;
    try {
      fs.linkSync(temporaryPath, filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
        fail(
          "MAINTENANCE_WRITER_PROOF_ALREADY_EXISTS",
          "writer quiescence proof has already been published",
        );
      }
      throw error;
    }
    published = true;
    fs.unlinkSync(temporaryPath);
    const directoryDescriptor = fs.openSync(
      directory,
      constants.O_RDONLY | (constants.O_DIRECTORY || 0),
    );
    try {
      fs.fsyncSync(directoryDescriptor);
    } finally {
      fs.closeSync(directoryDescriptor);
    }
    const readBack = readProtectedProofFile(filePath);
    if (!readBack.equals(bytes)) {
      fail("MAINTENANCE_WRITER_PROOF_WRITE_FAILED", "writer proof readback differs");
    }
    return {
      filePath,
      contentSha256: createHash("sha256").update(readBack).digest("hex"),
      proof: input.proof,
    };
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Preserve the authoritative failure.
      }
    }
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // The private temporary name may not have been created.
    }
    if (published) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // Best-effort cleanup after a failed durable publish verification.
      }
    }
    if (error instanceof MaintenanceWriterQuiescenceError) throw error;
    return fail(
      "MAINTENANCE_WRITER_PROOF_WRITE_FAILED",
      "writer quiescence proof could not be published",
    );
  }
}

export function readMaintenanceWriterQuiescenceProofFile(input: {
  filePath: string;
  expected: {
    deploymentId: string;
    nonce: string;
    databaseIdentitySha256: string;
    allowedDatabaseRoles: readonly string[];
    applicationDatabaseRoles: readonly string[];
  };
}): PersistedMaintenanceWriterQuiescenceProof {
  protectedProofDirectory(path.dirname(input.filePath), false);
  const bytes = readProtectedProofFile(input.filePath);
  let proof: MaintenanceWriterQuiescenceProof;
  try {
    proof = JSON.parse(bytes.toString("utf8")) as MaintenanceWriterQuiescenceProof;
  } catch {
    return fail("MAINTENANCE_WRITER_PROOF_JSON_INVALID", "writer proof JSON is invalid");
  }
  assertMaintenanceWriterQuiescenceProof(proof, input.expected);
  if (path.basename(input.filePath) !== proofFileName(proof.proofSha256)) {
    fail("MAINTENANCE_WRITER_PROOF_FILE_UNSAFE", "writer proof file name is not content addressed");
  }
  return {
    filePath: input.filePath,
    contentSha256: createHash("sha256").update(bytes).digest("hex"),
    proof,
  };
}
