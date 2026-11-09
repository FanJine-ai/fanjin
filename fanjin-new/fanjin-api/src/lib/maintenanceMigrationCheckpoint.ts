import { createHash, randomBytes } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import {
  GetObjectCommand,
  GetObjectRetentionCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import type { Knex } from "knex";

import {
  createBackup,
  restoreFromBackup,
  type BackupConfig,
  type BackupMetadata,
} from "@/lib/backup";
import {
  DATABASE_MIGRATIONS,
  inspectDatabaseMigrations,
  type DatabaseMigration,
  type DatabaseMigrationStatus,
} from "@/lib/databaseMigrations";
import { isPostgresClient } from "@/lib/dbDialect";
import {
  MaintenanceMigrationCheckpointError,
  readMaintenanceDatabaseIdentity,
  type MaintenanceDatabaseIdentity,
} from "@/lib/maintenanceDatabaseIdentity";
import {
  RELEASE_MIGRATION_BACKUP_CHECKPOINT_FORMAT,
  verifyReleaseMigrationSchema,
} from "@/release-controller/releaseSchemaMigrator";

const SHA256_RE = /^[a-f0-9]{64}$/u;
const SOURCE_COMMIT_RE = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{5,127}$/u;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{5,255}$/u;
const REMOTE_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._~+/=-]{0,1023}$/u;
const MAX_CHECKPOINT_TTL_MS = 60 * 60_000;
const MIN_CHECKPOINT_TTL_MS = 5 * 60_000;
const MAX_DRILL_METRIC_MS = 30 * 24 * 60 * 60_000;
const SCHEMA_40 = 40;
const SCHEMA_48 = 48;
const SCHEMA_48_MIGRATIONS = Object.freeze(
  DATABASE_MIGRATIONS.slice(0, SCHEMA_48),
);

export const MAINTENANCE_CHECKPOINT_CORE_COUNT_TABLES = Object.freeze([
  "o_user",
  "o_assets",
  "o_image",
  "o_media_asset",
  "o_account_wallet",
  "o_billing_ledger",
  "o_usage_record",
  "o_tasks",
  "o_relay_task",
  "o_agent_run",
  "o_billing_reconcile_job",
] as const);

export {
  MaintenanceMigrationCheckpointError,
  readMaintenanceDatabaseIdentity,
  type MaintenanceDatabaseIdentity,
} from "@/lib/maintenanceDatabaseIdentity";

function fail(code: string, message: string): never {
  throw new MaintenanceMigrationCheckpointError(code, message);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function checksumChain(definitions: readonly DatabaseMigration[]): string {
  return sha256(definitions.map(({ version, name, checksum }) => (
    `${version}:${name}:${checksum}`
  )).join("\n"));
}

function checkpointFileName(runId: string): string {
  return `${sha256(runId)}.json`;
}

function exactAppliedPrefix(
  status: DatabaseMigrationStatus,
  definitions: readonly DatabaseMigration[],
  fromVersion = SCHEMA_40,
  toVersion = SCHEMA_48,
): boolean {
  const applied = definitions.slice(0, fromVersion);
  const pending = definitions.slice(fromVersion);
  const same = (
    observed: { version: number; name: string; checksum: string } | undefined,
    expected: DatabaseMigration | undefined,
  ) => Boolean(observed && expected)
    && observed!.version === expected!.version
    && observed!.name === expected!.name
    && observed!.checksum === expected!.checksum;
  return definitions.length === toVersion
    && definitions.every((definition, index) => definition.version === index + 1)
    && status.tableExists
    && !status.current
    && status.databaseVersion === fromVersion
    && status.knownLatestVersion === toVersion
    && status.latestVersion === toVersion
    && status.applied.length === applied.length
    && status.pending.length === pending.length
    && status.applied.every((entry, index) => same(entry, applied[index]))
    && status.pending.every((entry, index) => same(entry, pending[index]));
}

function requiredBaselineConstraints(
  definitions: readonly DatabaseMigration[],
  fromVersion = SCHEMA_40,
): string[] {
  const constraints = definitions
    .slice(0, fromVersion)
    .flatMap((definition) => [...(definition.requiredConstraints || [])])
    .sort();
  if (
    constraints.length === 0
    || constraints.length > 1280
    || new Set(constraints).size !== constraints.length
  ) {
    fail(
      "MAINTENANCE_CHECKPOINT_SCHEMA_CONTRACT_INVALID",
      "reviewed schema 40 constraint contract is invalid",
    );
  }
  return constraints;
}

function rawRows(result: unknown): Array<Record<string, unknown>> {
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows)
    ? rows.filter((row): row is Record<string, unknown> => (
      Boolean(row) && typeof row === "object" && !Array.isArray(row)
    ))
    : [];
}

export interface MaintenanceDatabaseEvidence {
  checksumChain: string;
  schemaFingerprint: string;
  dataSummarySha256: string;
  coreCounts: Record<(typeof MAINTENANCE_CHECKPOINT_CORE_COUNT_TABLES)[number], string>;
  identity: MaintenanceDatabaseIdentity;
}

async function assertEmptyDrillDatabase(database: Knex): Promise<void> {
  let rows: Array<Record<string, unknown>>;
  try {
    rows = rawRows(await database.raw(
      `SELECT count(*)::text AS object_count
         FROM pg_catalog.pg_class AS relation
         JOIN pg_catalog.pg_namespace AS namespace_row
           ON namespace_row.oid = relation.relnamespace
        WHERE namespace_row.nspname = current_schema()
          AND relation.relkind IN ('r', 'p', 'v', 'm', 'S')`,
    ));
  } catch {
    return fail(
      "MAINTENANCE_CHECKPOINT_DRILL_INSPECTION_FAILED",
      "restore drill database cannot be inspected",
    );
  }
  if (String(rows[0]?.object_count || "") !== "0") {
    fail(
      "MAINTENANCE_CHECKPOINT_DRILL_DATABASE_NOT_EMPTY",
      "restore drill database must be explicitly empty",
    );
  }
}

async function coreDataSummary(database: Knex): Promise<{
  sha256: string;
  counts: Record<(typeof MAINTENANCE_CHECKPOINT_CORE_COUNT_TABLES)[number], string>;
}> {
  const counts = {} as Record<
    (typeof MAINTENANCE_CHECKPOINT_CORE_COUNT_TABLES)[number],
    string
  >;
  for (const tableName of MAINTENANCE_CHECKPOINT_CORE_COUNT_TABLES) {
    if (!await database.schema.hasTable(tableName)) {
      fail(
        "MAINTENANCE_CHECKPOINT_CORE_TABLE_MISSING",
        "core recovery summary table is unavailable",
      );
    }
    let rows: Array<Record<string, unknown>>;
    try {
      rows = rawRows(await database.raw(
        `SELECT count(*)::text AS row_count FROM "${tableName}"`,
      ));
    } catch {
      return fail(
        "MAINTENANCE_CHECKPOINT_CORE_SUMMARY_FAILED",
        "core recovery summary cannot be collected",
      );
    }
    const count = String(rows[0]?.row_count || "");
    if (!/^(?:0|[1-9][0-9]*)$/u.test(count)) {
      fail(
        "MAINTENANCE_CHECKPOINT_CORE_SUMMARY_INVALID",
        "core recovery summary is invalid",
      );
    }
    counts[tableName] = count;
  }
  return { sha256: sha256(JSON.stringify(counts)), counts };
}

async function collectDatabaseEvidence(
  database: Knex,
  definitions: readonly DatabaseMigration[],
  fromVersion = SCHEMA_40,
  toVersion = SCHEMA_48,
): Promise<MaintenanceDatabaseEvidence> {
  try {
    const status = await inspectDatabaseMigrations(database, definitions);
    if (!exactAppliedPrefix(status, definitions, fromVersion, toVersion)) {
      fail(
        fromVersion === SCHEMA_40 && toVersion === SCHEMA_48
          ? "MAINTENANCE_CHECKPOINT_SCHEMA40_BASELINE_MISMATCH"
          : "MAINTENANCE_CHECKPOINT_BASELINE_MISMATCH",
        `database is not the exact reviewed schema ${fromVersion} baseline for target ${toVersion}`,
      );
    }
    const requiredConstraints = requiredBaselineConstraints(definitions, fromVersion);
    const schema = await verifyReleaseMigrationSchema(
      database,
      requiredConstraints,
    );
    if (
      !SHA256_RE.test(schema.fingerprint)
      || schema.validatedConstraints.join("\0") !== requiredConstraints.join("\0")
    ) {
      fail(
        "MAINTENANCE_CHECKPOINT_SCHEMA_FINGERPRINT_INVALID",
        `schema ${fromVersion} fingerprint evidence is incomplete`,
      );
    }
    const summary = await coreDataSummary(database);
    return {
      checksumChain: checksumChain(definitions.slice(0, fromVersion)),
      schemaFingerprint: schema.fingerprint,
      dataSummarySha256: summary.sha256,
      coreCounts: summary.counts,
      identity: await readMaintenanceDatabaseIdentity(database),
    };
  } catch (error) {
    if (error instanceof MaintenanceMigrationCheckpointError) throw error;
    return fail(
      "MAINTENANCE_CHECKPOINT_DATABASE_EVIDENCE_FAILED",
      `schema ${fromVersion} database evidence could not be collected`,
    );
  }
}

function sameDatabaseEvidence(
  left: MaintenanceDatabaseEvidence,
  right: MaintenanceDatabaseEvidence,
): boolean {
  return left.checksumChain === right.checksumChain
    && left.schemaFingerprint === right.schemaFingerprint
    && left.dataSummarySha256 === right.dataSummarySha256
    && JSON.stringify(left.coreCounts) === JSON.stringify(right.coreCounts);
}

export interface ImmutableBackupPutInput {
  filePath: string;
  key: string;
  size: number;
  sha256: string;
  retainUntil: number;
  runIdSha256: string;
}

export interface ImmutableBackupObjectSnapshot {
  versionId: string;
  size: number;
  sha256: string;
  checksumSha256Base64: string;
  runIdSha256: string;
  format: string;
  retentionMode: string;
  retainUntil: number;
}

export interface ImmutableBackupObjectBody {
  versionId: string;
  body: AsyncIterable<Uint8Array>;
}

export interface ImmutableMigrationBackupStore {
  readonly identity: string;
  put(input: ImmutableBackupPutInput): Promise<{ versionId: string }>;
  head(input: { key: string; versionId: string }): Promise<ImmutableBackupObjectSnapshot>;
  retention(input: { key: string; versionId: string }): Promise<{
    mode: string;
    retainUntil: number;
  }>;
  get(input: { key: string; versionId: string }): Promise<ImmutableBackupObjectBody>;
}

type S3Sender = {
  send(command: unknown): Promise<any>;
};

function asyncBody(value: unknown): AsyncIterable<Uint8Array> {
  if (
    value
    && typeof value === "object"
    && Symbol.asyncIterator in value
    && typeof (value as Record<PropertyKey, unknown>)[Symbol.asyncIterator] === "function"
  ) {
    return value as AsyncIterable<Uint8Array>;
  }
  fail(
    "MAINTENANCE_CHECKPOINT_REMOTE_BODY_INVALID",
    "immutable backup body is not streamable",
  );
}

function remoteTimestamp(value: unknown): number {
  const timestamp = value instanceof Date ? value.getTime() : Number.NaN;
  return Number.isSafeInteger(timestamp) ? timestamp : -1;
}

export class S3ImmutableMigrationBackupStore
implements ImmutableMigrationBackupStore {
  readonly identity: string;
  private readonly client: S3Sender;
  private readonly bucket: string;

  constructor(input: {
    client: S3Sender;
    bucket: string;
    providerIdentity?: string;
  }) {
    const bucket = String(input.bucket || "").trim();
    const providerIdentity = String(
      input.providerIdentity || "s3-compatible",
    ).trim();
    if (!bucket || bucket.length > 255 || !providerIdentity) {
      fail(
        "MAINTENANCE_CHECKPOINT_REMOTE_CONFIGURATION_INVALID",
        "immutable backup store configuration is invalid",
      );
    }
    this.client = input.client;
    this.bucket = bucket;
    this.identity = `${providerIdentity}:${sha256(bucket)}`;
  }

  async put(input: ImmutableBackupPutInput): Promise<{ versionId: string }> {
    const response = await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: input.key,
      Body: createReadStream(input.filePath),
      ContentLength: input.size,
      ContentType: "application/gzip",
      ChecksumSHA256: Buffer.from(input.sha256, "hex").toString("base64"),
      ObjectLockMode: "COMPLIANCE",
      ObjectLockRetainUntilDate: new Date(input.retainUntil),
      Metadata: {
        "fanjin-format": RELEASE_MIGRATION_BACKUP_CHECKPOINT_FORMAT,
        "fanjin-run-id-sha256": input.runIdSha256,
        "fanjin-sha256": input.sha256,
        "fanjin-size": String(input.size),
      },
    }));
    return { versionId: String(response?.VersionId || "") };
  }

  async head(input: {
    key: string;
    versionId: string;
  }): Promise<ImmutableBackupObjectSnapshot> {
    const response = await this.client.send(new HeadObjectCommand({
      Bucket: this.bucket,
      Key: input.key,
      VersionId: input.versionId,
      ChecksumMode: "ENABLED",
    }));
    const metadata = response?.Metadata || {};
    return {
      versionId: String(response?.VersionId || ""),
      size: Number(response?.ContentLength),
      sha256: String(metadata["fanjin-sha256"] || ""),
      checksumSha256Base64: String(response?.ChecksumSHA256 || ""),
      runIdSha256: String(metadata["fanjin-run-id-sha256"] || ""),
      format: String(metadata["fanjin-format"] || ""),
      retentionMode: String(response?.ObjectLockMode || ""),
      retainUntil: remoteTimestamp(response?.ObjectLockRetainUntilDate),
    };
  }

  async retention(input: {
    key: string;
    versionId: string;
  }): Promise<{ mode: string; retainUntil: number }> {
    const response = await this.client.send(new GetObjectRetentionCommand({
      Bucket: this.bucket,
      Key: input.key,
      VersionId: input.versionId,
    }));
    return {
      mode: String(response?.Retention?.Mode || ""),
      retainUntil: remoteTimestamp(response?.Retention?.RetainUntilDate),
    };
  }

  async get(input: {
    key: string;
    versionId: string;
  }): Promise<ImmutableBackupObjectBody> {
    const response = await this.client.send(new GetObjectCommand({
      Bucket: this.bucket,
      Key: input.key,
      VersionId: input.versionId,
      ChecksumMode: "ENABLED",
    }));
    return {
      versionId: String(response?.VersionId || ""),
      body: asyncBody(response?.Body),
    };
  }
}

async function calculateFileSha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

async function ensureProtectedDirectory(directory: string): Promise<string> {
  if (!path.isAbsolute(directory) || path.normalize(directory) !== directory) {
    fail(
      "MAINTENANCE_CHECKPOINT_DIRECTORY_INVALID",
      "checkpoint working directory must be a normalized absolute path",
    );
  }
  await fs.mkdir(directory, { recursive: true, mode: 0o700 }).catch(() => undefined);
  let entry;
  let canonical: string;
  let resolved;
  try {
    entry = await fs.lstat(directory);
    canonical = await fs.realpath(directory);
    resolved = await fs.lstat(canonical);
  } catch {
    return fail(
      "MAINTENANCE_CHECKPOINT_DIRECTORY_UNAVAILABLE",
      "checkpoint working directory is unavailable",
    );
  }
  const currentUid = typeof process.getuid === "function" ? process.getuid() : -1;
  if (
    canonical !== directory
    || entry.isSymbolicLink()
    || !entry.isDirectory()
    || !resolved.isDirectory()
    || resolved.isSymbolicLink()
    || entry.dev !== resolved.dev
    || entry.ino !== resolved.ino
    || (resolved.mode & 0o022) !== 0
    || (resolved.uid !== 0 && resolved.uid !== currentUid)
  ) {
    fail(
      "MAINTENANCE_CHECKPOINT_DIRECTORY_UNSAFE",
      "checkpoint working directory is unsafe",
    );
  }
  return canonical;
}

async function validateLocalBackup(
  directory: string,
  metadata: BackupMetadata,
): Promise<string> {
  if (
    !metadata.verified
    || !SAFE_ID_RE.test(String(metadata.id || ""))
    || !Number.isSafeInteger(metadata.timestamp)
    || metadata.timestamp < 1
    || !Number.isSafeInteger(metadata.size)
    || metadata.size < 1
    || !SHA256_RE.test(metadata.checksum)
    || metadata.filename !== `${metadata.id}.sql.gz`
    || !["pg", "postgres", "postgresql"].includes(
      String(metadata.databaseClient || "").toLowerCase(),
    )
  ) {
    fail(
      "MAINTENANCE_CHECKPOINT_LOCAL_BACKUP_INVALID",
      "local PostgreSQL backup evidence is invalid",
    );
  }
  const filePath = path.join(directory, metadata.filename);
  let stat;
  try {
    stat = await fs.lstat(filePath);
  } catch {
    return fail(
      "MAINTENANCE_CHECKPOINT_LOCAL_BACKUP_UNAVAILABLE",
      "local PostgreSQL backup is unavailable",
    );
  }
  const currentUid = typeof process.getuid === "function" ? process.getuid() : -1;
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.nlink !== 1
    || (stat.mode & 0o777) !== 0o600
    || (stat.uid !== 0 && stat.uid !== currentUid)
    || stat.size !== metadata.size
    || await calculateFileSha256(filePath) !== metadata.checksum
  ) {
    fail(
      "MAINTENANCE_CHECKPOINT_LOCAL_BACKUP_INVALID",
      "local PostgreSQL backup failed exact integrity verification",
    );
  }
  const metadataPath = path.join(directory, `${metadata.id}.json`);
  const noFollow = constants.O_NOFOLLOW;
  if (!Number.isSafeInteger(noFollow) || noFollow === 0) {
    fail(
      "MAINTENANCE_CHECKPOINT_SAFE_OPEN_UNAVAILABLE",
      "safe local backup metadata verification is unsupported",
    );
  }
  let metadataHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    metadataHandle = await fs.open(
      metadataPath,
      constants.O_RDONLY | noFollow,
    );
    const before = await metadataHandle.stat();
    if (
      !before.isFile()
      || before.isSymbolicLink()
      || before.nlink !== 1
      || (before.uid !== 0 && before.uid !== currentUid)
    ) {
      fail(
        "MAINTENANCE_CHECKPOINT_LOCAL_BACKUP_METADATA_INVALID",
        "local PostgreSQL backup metadata is unsafe",
      );
    }
    await metadataHandle.chmod(0o600);
    const after = await metadataHandle.stat();
    if (
      !after.isFile()
      || after.nlink !== 1
      || after.dev !== before.dev
      || after.ino !== before.ino
      || (after.mode & 0o777) !== 0o600
      || (after.uid !== 0 && after.uid !== currentUid)
    ) {
      fail(
        "MAINTENANCE_CHECKPOINT_LOCAL_BACKUP_METADATA_INVALID",
        "local PostgreSQL backup metadata is unsafe",
      );
    }
  } catch (error) {
    if (error instanceof MaintenanceMigrationCheckpointError) throw error;
    return fail(
      "MAINTENANCE_CHECKPOINT_LOCAL_BACKUP_METADATA_INVALID",
      "local PostgreSQL backup metadata is unavailable",
    );
  } finally {
    await metadataHandle?.close().catch(() => undefined);
  }
  return filePath;
}

async function writeExactRemoteBody(
  body: AsyncIterable<Uint8Array>,
  filePath: string,
  expectedSize: number,
  expectedSha256: string,
): Promise<void> {
  const noFollow = constants.O_NOFOLLOW;
  if (!Number.isSafeInteger(noFollow) || noFollow === 0) {
    fail(
      "MAINTENANCE_CHECKPOINT_SAFE_OPEN_UNAVAILABLE",
      "safe local restore materialization is unsupported",
    );
  }
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let created = false;
  let completed = false;
  try {
    handle = await fs.open(
      filePath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
      0o600,
    );
    created = true;
    await handle.chmod(0o600);
    const hash = createHash("sha256");
    let size = 0;
    for await (const value of body) {
      const chunk = Buffer.from(value);
      size += chunk.length;
      if (size > expectedSize) {
        fail(
          "MAINTENANCE_CHECKPOINT_REMOTE_LENGTH_MISMATCH",
          "immutable backup readback exceeded its declared length",
        );
      }
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        const result = await handle.write(chunk, offset, chunk.length - offset);
        if (result.bytesWritten < 1) {
          fail(
            "MAINTENANCE_CHECKPOINT_REMOTE_WRITE_FAILED",
            "immutable backup readback could not be materialized",
          );
        }
        offset += result.bytesWritten;
      }
    }
    if (size !== expectedSize || hash.digest("hex") !== expectedSha256) {
      fail(
        "MAINTENANCE_CHECKPOINT_REMOTE_DIGEST_MISMATCH",
        "immutable backup readback does not match the local backup",
      );
    }
    await handle.sync();
    completed = true;
  } catch (error) {
    if (error instanceof MaintenanceMigrationCheckpointError) throw error;
    fail(
      "MAINTENANCE_CHECKPOINT_REMOTE_READBACK_FAILED",
      "immutable backup readback failed",
    );
  } finally {
    await handle?.close().catch(() => undefined);
    if (created && completed) {
      const stat = await fs.lstat(filePath).catch(() => null);
      if (
        !stat
        || !stat.isFile()
        || stat.isSymbolicLink()
        || stat.nlink !== 1
        || (stat.mode & 0o777) !== 0o600
      ) {
        await fs.unlink(filePath).catch(() => undefined);
      }
    } else if (created) {
      await fs.unlink(filePath).catch(() => undefined);
    }
  }
}

export interface VerifiedImmutableBackup {
  versionId: string;
  objectIdentitySha256: string;
  retentionMode: "COMPLIANCE";
  retainUntil: number;
  restoredFilePath: string;
}

async function uploadAndReadBackImmutableBackup(input: {
  store: ImmutableMigrationBackupStore;
  localFilePath: string;
  restoreFilePath: string;
  key: string;
  size: number;
  sha256: string;
  retainUntil: number;
  runId: string;
}): Promise<VerifiedImmutableBackup> {
  const expectedChecksumBase64 = Buffer.from(input.sha256, "hex").toString("base64");
  const runIdSha256 = sha256(input.runId);
  let put: { versionId: string };
  try {
    put = await input.store.put({
      filePath: input.localFilePath,
      key: input.key,
      size: input.size,
      sha256: input.sha256,
      retainUntil: input.retainUntil,
      runIdSha256,
    });
  } catch {
    return fail(
      "MAINTENANCE_CHECKPOINT_REMOTE_UPLOAD_FAILED",
      "immutable backup upload failed",
    );
  }
  const versionId = String(put.versionId || "");
  if (!REMOTE_VERSION_RE.test(versionId)) {
    fail(
      "MAINTENANCE_CHECKPOINT_REMOTE_VERSION_REQUIRED",
      "immutable backup upload did not return a usable version identity",
    );
  }
  let head: ImmutableBackupObjectSnapshot;
  let retention: { mode: string; retainUntil: number };
  try {
    [head, retention] = await Promise.all([
      input.store.head({ key: input.key, versionId }),
      input.store.retention({ key: input.key, versionId }),
    ]);
  } catch {
    return fail(
      "MAINTENANCE_CHECKPOINT_REMOTE_HEAD_FAILED",
      "immutable backup metadata cannot be read back",
    );
  }
  // TOS (and several S3-compatible stores) omit the x-amz-checksum-sha256
  // response header on HeadObject and truncate object-lock retention
  // timestamps to whole seconds. Content integrity is still independently
  // proven by the exact readback below (writeExactRemoteBody re-hashes the
  // downloaded body and enforces the expected size), so a missing HEAD
  // checksum is tolerated while any present checksum must match exactly,
  // and retention is compared at the store's second granularity.
  const secondGranularity = (value: number): number =>
    Number.isSafeInteger(value) && value > 0 ? Math.floor(value / 1000) * 1000 : value;
  const headChecksumOk = head.checksumSha256Base64 === expectedChecksumBase64
    || head.checksumSha256Base64 === "";
  if (
    head.versionId !== versionId
    || head.size !== input.size
    || head.sha256 !== input.sha256
    || !headChecksumOk
    || head.runIdSha256 !== runIdSha256
    || head.format !== RELEASE_MIGRATION_BACKUP_CHECKPOINT_FORMAT
    || head.retentionMode !== "COMPLIANCE"
    || secondGranularity(head.retainUntil) !== secondGranularity(input.retainUntil)
    || retention.mode !== "COMPLIANCE"
    || secondGranularity(retention.retainUntil) !== secondGranularity(input.retainUntil)
  ) {
    fail(
      "MAINTENANCE_CHECKPOINT_REMOTE_EVIDENCE_MISMATCH",
      "immutable backup metadata, retention, or checksum evidence is incomplete",
    );
  }
  let object: ImmutableBackupObjectBody;
  try {
    object = await input.store.get({ key: input.key, versionId });
  } catch {
    return fail(
      "MAINTENANCE_CHECKPOINT_REMOTE_GET_FAILED",
      "immutable backup cannot be read back",
    );
  }
  if (object.versionId !== versionId) {
    fail(
      "MAINTENANCE_CHECKPOINT_REMOTE_VERSION_MISMATCH",
      "immutable backup readback returned a different version",
    );
  }
  await writeExactRemoteBody(
    object.body,
    input.restoreFilePath,
    input.size,
    input.sha256,
  );
  return {
    versionId,
    objectIdentitySha256: sha256([
      input.store.identity,
      input.key,
      versionId,
    ].join("\0")),
    retentionMode: "COMPLIANCE",
    retainUntil: input.retainUntil,
    restoredFilePath: input.restoreFilePath,
  };
}

export interface MaintenanceMigrationCheckpointDocument {
  artifactSha256: string;
  backupSha256: string;
  backupSize: number;
  checkpointId: string;
  checksumChain: string;
  expiresAt: number;
  format: typeof RELEASE_MIGRATION_BACKUP_CHECKPOINT_FORMAT;
  remoteCopyVerified: true;
  remoteObjectIdentitySha256: string;
  remoteObjectVersionId: string;
  remoteRetainUntil: number;
  remoteRetentionMode: "COMPLIANCE";
  restoreDatabaseIdentitySha256: string;
  restoreDataSummarySha256: string;
  restoreDrillId: string;
  restoreRpoMs: number;
  restoreRtoMs: number;
  runId: string;
  schemaFingerprint: string;
  schemaVersion: number;
  sourceDatabaseIdentitySha256: string;
  sourceCommit: string;
  verifiedAt: number;
}

async function atomicWriteCheckpoint(
  directory: string,
  document: MaintenanceMigrationCheckpointDocument,
): Promise<string> {
  const canonicalDirectory = await ensureProtectedDirectory(directory);
  const finalPath = path.join(canonicalDirectory, checkpointFileName(document.runId));
  const temporaryPath = path.join(
    canonicalDirectory,
    `.${checkpointFileName(document.runId)}.${randomBytes(8).toString("hex")}.tmp`,
  );
  const noFollow = constants.O_NOFOLLOW;
  if (!Number.isSafeInteger(noFollow) || noFollow === 0) {
    fail(
      "MAINTENANCE_CHECKPOINT_SAFE_OPEN_UNAVAILABLE",
      "safe checkpoint creation is unsupported",
    );
  }
  const bytes = Buffer.from(`${JSON.stringify(document)}\n`, "utf8");
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let published = false;
  try {
    handle = await fs.open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
      0o600,
    );
    await handle.chmod(0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    // link(2) publishes the complete file atomically and refuses to replace an
    // existing checkpoint. Removing the private temporary name restores the
    // exact single-link invariant consumed by the migrator.
    await fs.link(temporaryPath, finalPath);
    published = true;
    await fs.unlink(temporaryPath);
    const final = await fs.lstat(finalPath);
    if (
      !final.isFile()
      || final.isSymbolicLink()
      || final.nlink !== 1
      || (final.mode & 0o777) !== 0o600
      || final.size !== bytes.length
    ) {
      fail(
        "MAINTENANCE_CHECKPOINT_ATOMIC_WRITE_INVALID",
        "published checkpoint metadata is unsafe",
      );
    }
    const directoryHandle = await fs.open(canonicalDirectory, constants.O_RDONLY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
    return finalPath;
  } catch (error) {
    if (published) {
      await fs.unlink(finalPath).catch(() => undefined);
    }
    if (error instanceof MaintenanceMigrationCheckpointError) throw error;
    return fail(
      "MAINTENANCE_CHECKPOINT_ATOMIC_WRITE_FAILED",
      "checkpoint could not be published atomically",
    );
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.unlink(temporaryPath).catch(() => undefined);
  }
}

export interface MaintenanceMigrationCheckpointDependencies {
  createBackup: typeof createBackup;
  restoreFromBackup: typeof restoreFromBackup;
  collectDatabaseEvidence: typeof collectDatabaseEvidence;
  readDatabaseIdentity: typeof readMaintenanceDatabaseIdentity;
  assertEmptyDrillDatabase: typeof assertEmptyDrillDatabase;
}

const DEFAULT_DEPENDENCIES: MaintenanceMigrationCheckpointDependencies = {
  createBackup,
  restoreFromBackup,
  collectDatabaseEvidence,
  readDatabaseIdentity: readMaintenanceDatabaseIdentity,
  assertEmptyDrillDatabase,
};

export interface PrepareMaintenanceMigrationCheckpointInput {
  sourceDatabase: Knex;
  drillDatabase: Knex;
  store: ImmutableMigrationBackupStore;
  runId: string;
  artifactSha256: string;
  sourceCommit: string;
  checkpointDirectory: string;
  backupDirectory: string;
  environment?: string;
  checkpointTtlMs?: number;
  retentionMs?: number;
  now?: () => number;
  expectedFromVersion?: number;
  expectedToVersion?: number;
  migrationDefinitions?: readonly DatabaseMigration[];
  dependencies?: Partial<MaintenanceMigrationCheckpointDependencies>;
}

export interface PreparedMaintenanceMigrationCheckpoint {
  checkpointFileName: string;
  document: MaintenanceMigrationCheckpointDocument;
  restoredCoreCounts: MaintenanceDatabaseEvidence["coreCounts"];
}

export async function prepareMaintenanceMigrationCheckpoint(
  input: PrepareMaintenanceMigrationCheckpointInput,
): Promise<PreparedMaintenanceMigrationCheckpoint> {
  const environment = String(input.environment || process.env.NODE_ENV || "")
    .trim()
    .toLowerCase();
  if (environment !== "prod" && environment !== "production") {
    fail(
      "MAINTENANCE_CHECKPOINT_PRODUCTION_REQUIRED",
      "maintenance checkpoint creation requires an explicit production environment",
    );
  }
  if (!isPostgresClient(input.sourceDatabase) || !isPostgresClient(input.drillDatabase)) {
    fail(
      "MAINTENANCE_CHECKPOINT_POSTGRES_REQUIRED",
      "maintenance checkpoint creation requires PostgreSQL source and drill databases",
    );
  }
  if (!RUN_ID_RE.test(input.runId)) {
    fail("MAINTENANCE_CHECKPOINT_RUN_ID_INVALID", "migration run identity is invalid");
  }
  if (!SHA256_RE.test(input.artifactSha256)) {
    fail("MAINTENANCE_CHECKPOINT_ARTIFACT_INVALID", "migration artifact identity is invalid");
  }
  if (!SOURCE_COMMIT_RE.test(input.sourceCommit)) {
    fail("MAINTENANCE_CHECKPOINT_SOURCE_COMMIT_INVALID", "source commit identity is invalid");
  }
  const checkpointTtlMs = input.checkpointTtlMs ?? 30 * 60_000;
  const retentionMs = input.retentionMs ?? 30 * 24 * 60 * 60_000;
  if (
    !Number.isSafeInteger(checkpointTtlMs)
    || checkpointTtlMs < MIN_CHECKPOINT_TTL_MS
    || checkpointTtlMs > MAX_CHECKPOINT_TTL_MS
    || !Number.isSafeInteger(retentionMs)
    || retentionMs < 24 * 60 * 60_000
    || retentionMs > 10 * 365 * 24 * 60 * 60_000
  ) {
    fail(
      "MAINTENANCE_CHECKPOINT_RETENTION_INVALID",
      "checkpoint or immutable backup retention is invalid",
    );
  }
  const now = input.now ?? Date.now;
  // Defaults preserve the immutable historical schema 40 -> 48 contract.
  // Modular releases must pass an explicit reviewed from/to pair and the
  // exact compiled migration prefix ending at `toVersion`.
  const fromVersion = input.expectedFromVersion ?? SCHEMA_40;
  const toVersion = input.expectedToVersion ?? SCHEMA_48;
  const definitions = input.migrationDefinitions ?? SCHEMA_48_MIGRATIONS;
  if (
    !Number.isSafeInteger(fromVersion)
    || !Number.isSafeInteger(toVersion)
    || fromVersion < 1
    || toVersion <= fromVersion
    || definitions.length !== toVersion
    || definitions.some((definition, index) => definition.version !== index + 1)
  ) {
    fail(
      "MAINTENANCE_CHECKPOINT_MIGRATION_RANGE_INVALID",
      "checkpoint migration definitions do not match the exact from/to schema range",
    );
  }
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...input.dependencies };
  const backupDirectory = await ensureProtectedDirectory(input.backupDirectory);
  await ensureProtectedDirectory(input.checkpointDirectory);

  const [sourceIdentity, drillIdentity] = await Promise.all([
    dependencies.readDatabaseIdentity(input.sourceDatabase),
    dependencies.readDatabaseIdentity(input.drillDatabase),
  ]);
  if (sourceIdentity.databaseName === drillIdentity.databaseName) {
    fail(
      "MAINTENANCE_CHECKPOINT_DRILL_DATABASE_NOT_INDEPENDENT",
      "restore drill database must have a distinct database identity",
    );
  }
  await dependencies.assertEmptyDrillDatabase(input.drillDatabase);

  const sourceBefore = await dependencies.collectDatabaseEvidence(
    input.sourceDatabase,
    definitions,
    fromVersion,
    toVersion,
  );
  const backupConfig: BackupConfig = {
    enabled: true,
    schedule: "0 0 * * *",
    retentionDays: 30,
    retentionCount: 1,
    backupDir: backupDirectory,
    verifyBackup: true,
    uploadToCloud: false,
  };
  const metadata = await dependencies.createBackup(input.sourceDatabase, backupConfig);
  const localBackupPath = await validateLocalBackup(backupDirectory, metadata);
  const sourceAfter = await dependencies.collectDatabaseEvidence(
    input.sourceDatabase,
    definitions,
    fromVersion,
    toVersion,
  );
  if (!sameDatabaseEvidence(sourceBefore, sourceAfter)) {
    fail(
      "MAINTENANCE_CHECKPOINT_SOURCE_CHANGED_DURING_BACKUP",
      "source database changed while the maintenance backup was captured",
    );
  }

  const drillId = `restore-drill:${sha256(`${input.runId}\0${metadata.id}`).slice(0, 32)}`;
  const restoreRoot = await fs.mkdtemp(path.join(backupDirectory, ".restore-drill-"));
  await fs.chmod(restoreRoot, 0o700);
  const restoredFilePath = path.join(restoreRoot, metadata.filename);
  const remoteKey = [
    "fanjin-migration-checkpoints",
    sha256(input.runId),
    metadata.filename,
  ].join("/");
  const retainUntil = Math.floor((now() + retentionMs) / 1000) * 1000;
  let immutable: VerifiedImmutableBackup;
  const restoreStartedAt = now();
  try {
    immutable = await uploadAndReadBackImmutableBackup({
      store: input.store,
      localFilePath: localBackupPath,
      restoreFilePath: restoredFilePath,
      key: remoteKey,
      size: metadata.size,
      sha256: metadata.checksum,
      retainUntil,
      runId: input.runId,
    });
    const remoteMetadata: BackupMetadata = {
      ...metadata,
      uploadedToCloud: true,
    };
    await fs.writeFile(
      path.join(restoreRoot, `${metadata.id}.json`),
      JSON.stringify(remoteMetadata),
      { flag: "wx", mode: 0o600 },
    );
    await dependencies.restoreFromBackup(input.drillDatabase, metadata.id, {
      ...backupConfig,
      backupDir: restoreRoot,
    });
    const restored = await dependencies.collectDatabaseEvidence(
      input.drillDatabase,
      definitions,
      fromVersion,
      toVersion,
    );
    if (!sameDatabaseEvidence(sourceBefore, restored)) {
      fail(
        "MAINTENANCE_CHECKPOINT_RESTORE_VERIFICATION_MISMATCH",
        `restored database does not match the schema ${fromVersion} source evidence`,
      );
    }
    const verifiedAt = now();
    const restoreRpoMs = Math.max(0, restoreStartedAt - metadata.timestamp);
    const restoreRtoMs = Math.max(0, verifiedAt - restoreStartedAt);
    if (
      !Number.isSafeInteger(restoreRpoMs)
      || !Number.isSafeInteger(restoreRtoMs)
      || restoreRpoMs > MAX_DRILL_METRIC_MS
      || restoreRtoMs > MAX_DRILL_METRIC_MS
    ) {
      fail(
        "MAINTENANCE_CHECKPOINT_RESTORE_METRICS_INVALID",
        "restore drill RPO or RTO evidence is invalid",
      );
    }
    const expiresAt = verifiedAt + checkpointTtlMs;
    if (immutable.retainUntil < expiresAt) {
      fail(
        "MAINTENANCE_CHECKPOINT_REMOTE_RETENTION_TOO_SHORT",
        "immutable backup retention does not cover the checkpoint lifetime",
      );
    }
    const document: MaintenanceMigrationCheckpointDocument = {
      artifactSha256: input.artifactSha256,
      backupSha256: metadata.checksum,
      backupSize: metadata.size,
      checkpointId: `backup:${metadata.id}`,
      checksumChain: sourceBefore.checksumChain,
      expiresAt,
      format: RELEASE_MIGRATION_BACKUP_CHECKPOINT_FORMAT,
      remoteCopyVerified: true,
      remoteObjectIdentitySha256: immutable.objectIdentitySha256,
      remoteObjectVersionId: immutable.versionId,
      remoteRetainUntil: immutable.retainUntil,
      remoteRetentionMode: immutable.retentionMode,
      restoreDatabaseIdentitySha256: restored.identity.sha256,
      restoreDataSummarySha256: restored.dataSummarySha256,
      restoreDrillId: drillId,
      restoreRpoMs,
      restoreRtoMs,
      runId: input.runId,
      schemaFingerprint: sourceBefore.schemaFingerprint,
      schemaVersion: fromVersion,
      sourceDatabaseIdentitySha256: sourceBefore.identity.sha256,
      sourceCommit: input.sourceCommit,
      verifiedAt,
    };
    await atomicWriteCheckpoint(input.checkpointDirectory, document);
    return {
      checkpointFileName: checkpointFileName(input.runId),
      document,
      restoredCoreCounts: restored.coreCounts,
    };
  } finally {
    await fs.rm(restoreRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}
