/**
 * Database Backup Management
 * 
 * Provides automated backup creation, retention, and restoration for Fanjin API.
 * Supports both PostgreSQL and SQLite databases with configurable schedules.
 * 
 * Features:
 * - Scheduled automatic backups (cron-based)
 * - Configurable retention policies (by count and age)
 * - Backup verification and integrity checks
 * - Restore from backup with safety checks
 * - Cloud storage upload (S3-compatible)
 */

import { Knex } from "knex";
import { spawn, type ChildProcess } from "child_process";
import { createReadStream, createWriteStream } from "fs";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { pipeline } from "stream/promises";
import { logger as pinoLogger } from "./logger";

const logger = pinoLogger.child({ module: "backup" });

interface ChildProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  launchFailed: boolean;
}

interface PostgresCommandContext {
  connectionArgs: string[];
  env: NodeJS.ProcessEnv;
  cleanup: () => Promise<void>;
}

interface PostgresConnectionObject {
  connectionString?: unknown;
  host?: unknown;
  port?: unknown;
  database?: unknown;
  user?: unknown;
  password?: unknown;
  ssl?: unknown;
}

const POSTGRES_SSL_QUERY_PARAMETERS = [
  "ssl",
  "sslmode",
  "sslcert",
  "sslkey",
  "sslrootcert",
  "sslcrl",
  "sslcompression",
  "sslnegotiation",
  "sslsni",
];

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return String(value);
}

function decodedUrlValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizedPostgresUrl(
  connectionString: string,
  overrides?: PostgresConnectionObject,
): { connectionString: string; password?: string } {
  try {
    const url = new URL(connectionString);
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
      throw new Error("unsupported protocol");
    }

    const passwordParameters = [...url.searchParams.keys()]
      .filter((parameter) => parameter.toLowerCase() === "password");
    const queryPassword = passwordParameters.length > 0
      ? url.searchParams.get(passwordParameters[passwordParameters.length - 1]) ?? undefined
      : undefined;
    const urlPassword = url.password ? decodedUrlValue(url.password) : undefined;
    const password = optionalString(overrides?.password) ?? queryPassword ?? urlPassword;

    // Passwords must only be supplied through PGPASSWORD, never command-line
    // arguments where they are visible in process listings.
    url.password = "";
    for (const parameter of passwordParameters) url.searchParams.delete(parameter);

    if (overrides) {
      const host = optionalString(overrides.host);
      const port = optionalString(overrides.port);
      const database = optionalString(overrides.database);
      const user = optionalString(overrides.user);

      if (host !== undefined) url.hostname = host;
      if (port !== undefined) url.port = port;
      if (database !== undefined) url.pathname = `/${encodeURIComponent(database)}`;
      if (user !== undefined) url.username = user;

      if (overrides.ssl !== undefined) {
        for (const parameter of [...url.searchParams.keys()]) {
          if (POSTGRES_SSL_QUERY_PARAMETERS.includes(parameter.toLowerCase())) {
            url.searchParams.delete(parameter);
          }
        }
      }
    }

    return { connectionString: url.toString(), password };
  } catch {
    // Do not include a possibly credential-bearing connection string in errors.
    throw new Error("PostgreSQL connection configuration is invalid");
  }
}

async function postgresSslEnvironment(ssl: unknown): Promise<{
  env: NodeJS.ProcessEnv;
  cleanup: () => Promise<void>;
}> {
  if (ssl === undefined || ssl === null) {
    return { env: {}, cleanup: async () => undefined };
  }

  if (ssl === false) {
    return { env: { PGSSLMODE: "disable" }, cleanup: async () => undefined };
  }

  const sslObject = typeof ssl === "object" && ssl !== null
    ? ssl as Record<string, unknown>
    : {};
  const env: NodeJS.ProcessEnv = {
    PGSSLMODE: sslObject.rejectUnauthorized === false ? "require" : "verify-full",
  };
  let temporaryDirectory: string | undefined;

  const materialize = async (value: unknown, filename: string): Promise<string | undefined> => {
    if (value === undefined || value === null) return undefined;
    const content = Buffer.isBuffer(value) ? value : String(value);

    if (typeof content === "string" && !content.includes("\n") && !content.includes("-----BEGIN")) {
      try {
        await fs.access(content, fs.constants.R_OK);
        return content;
      } catch {
        // A non-existent path is still passed to libpq so it fails closed.
        if (path.isAbsolute(content)) return content;
      }
    }

    temporaryDirectory ||= await fs.mkdtemp(path.join(os.tmpdir(), "fanjin-pg-ssl-"));
    const filePath = path.join(temporaryDirectory, filename);
    await fs.writeFile(filePath, content, { mode: 0o600 });
    return filePath;
  };

  try {
    const rootCertificate = await materialize(sslObject.ca, "root.crt");
    const clientCertificate = await materialize(sslObject.cert, "postgresql.crt");
    const clientKey = await materialize(sslObject.key, "postgresql.key");
    if (rootCertificate) env.PGSSLROOTCERT = rootCertificate;
    if (clientCertificate) env.PGSSLCERT = clientCertificate;
    if (clientKey) env.PGSSLKEY = clientKey;

    return {
      env,
      cleanup: async () => {
        if (temporaryDirectory) {
          await fs.rm(temporaryDirectory, { recursive: true, force: true });
        }
      },
    };
  } catch {
    if (temporaryDirectory) {
      await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
    throw new Error("PostgreSQL SSL configuration is invalid");
  }
}

async function postgresCommandContext(database: Knex): Promise<PostgresCommandContext> {
  const connection = database.client.config.connection as unknown;
  let connectionArgs: string[];
  let password: string | undefined;
  let ssl: unknown;

  if (typeof connection === "string") {
    const normalized = normalizedPostgresUrl(connection);
    connectionArgs = [`--dbname=${normalized.connectionString}`];
    password = normalized.password;
  } else if (connection && typeof connection === "object") {
    const object = connection as PostgresConnectionObject;
    const connectionString = optionalString(object.connectionString);
    ssl = object.ssl;

    if (connectionString) {
      const normalized = normalizedPostgresUrl(connectionString, object);
      connectionArgs = [`--dbname=${normalized.connectionString}`];
      password = normalized.password;
    } else {
      const host = optionalString(object.host) || "localhost";
      const port = optionalString(object.port) || "5432";
      const databaseName = optionalString(object.database);
      const user = optionalString(object.user);

      connectionArgs = [`--host=${host}`, `--port=${port}`];
      if (user !== undefined) connectionArgs.push(`--username=${user}`);
      if (databaseName !== undefined) connectionArgs.push(`--dbname=${databaseName}`);
      password = optionalString(object.password);
    }
  } else {
    throw new Error("PostgreSQL connection configuration is invalid");
  }

  const sslEnvironment = await postgresSslEnvironment(ssl);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...sslEnvironment.env,
    PGAPPNAME: "fanjin-backup",
  };
  if (password !== undefined) env.PGPASSWORD = password;

  return {
    connectionArgs,
    env,
    cleanup: sslEnvironment.cleanup,
  };
}

function waitForChildProcess(child: ChildProcess): Promise<ChildProcessResult> {
  return new Promise((resolve) => {
    let launchFailed = false;
    child.once("error", () => {
      launchFailed = true;
    });
    child.once("close", (exitCode, signal) => {
      resolve({ exitCode, signal, launchFailed });
    });
  });
}

function childProcessFailed(result: ChildProcessResult): boolean {
  return result.launchFailed || result.exitCode !== 0 || result.signal !== null;
}

function terminateChildProcesses(children: ChildProcess[]): void {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null && !child.killed) {
      child.kill();
    }
  }
}

function isSafeBackupIdentifier(value: string): boolean {
  return value.length > 0
    && value.length <= 160
    && value !== "."
    && value !== ".."
    && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

function isSafeBackupFilename(value: unknown): value is string {
  return typeof value === "string"
    && isSafeBackupIdentifier(value)
    && !path.isAbsolute(value)
    && path.basename(value) === value;
}

export interface BackupConfig {
  enabled: boolean;
  schedule: string; // Cron expression
  retentionDays: number;
  retentionCount: number;
  backupDir: string;
  verifyBackup: boolean;
  uploadToCloud: boolean;
  s3Bucket?: string;
  s3Region?: string;
  s3AccessKeyId?: string;
  s3SecretAccessKey?: string;
  s3Endpoint?: string; // For S3-compatible services
}

/**
 * Test/operations adapter for running the unchanged streaming pg_dump/psql
 * pipelines through a pinned executable such as `docker exec`. Production
 * callers omit this and continue to execute the native PostgreSQL 16 tools.
 */
export interface PostgresBackupCommand {
  executable: string;
  prefixArgs?: readonly string[];
  connectionArgs?: readonly string[];
}

export interface PostgresBackupCommands {
  pgDump?: PostgresBackupCommand;
  psql?: PostgresBackupCommand;
}

export interface BackupMetadata {
  id: string;
  timestamp: number;
  filename: string;
  size: number;
  checksum: string;
  databaseClient: string;
  verified: boolean;
  uploadedToCloud: boolean;
  s3Key?: string;
}

function retentionInteger(raw: string | undefined, fallback: number, minimum: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

/**
 * Load backup configuration from environment variables
 */
export function loadBackupConfig(): BackupConfig {
  return {
    enabled: process.env.FANJIN_BACKUP_ENABLED === "1",
    schedule: process.env.FANJIN_BACKUP_SCHEDULE || "0 2 * * *", // 2 AM daily
    retentionDays: retentionInteger(process.env.FANJIN_BACKUP_RETENTION_DAYS, 30, 0),
    // Always retain at least one local recovery point. Cleanup is destructive
    // and must fail safe when an invalid value reaches it programmatically.
    retentionCount: retentionInteger(process.env.FANJIN_BACKUP_RETENTION_COUNT, 10, 1),
    backupDir: process.env.FANJIN_BACKUP_DIR || path.join(process.env.FANJIN_DATA_DIR || "/opt/fanjin/shared/data", "backups"),
    verifyBackup: process.env.FANJIN_BACKUP_VERIFY !== "0",
    uploadToCloud: process.env.FANJIN_BACKUP_UPLOAD_TO_CLOUD === "1",
    s3Bucket: process.env.FANJIN_BACKUP_S3_BUCKET,
    s3Region: process.env.FANJIN_BACKUP_S3_REGION || "us-east-1",
    s3AccessKeyId: process.env.FANJIN_BACKUP_S3_ACCESS_KEY_ID,
    s3SecretAccessKey: process.env.FANJIN_BACKUP_S3_SECRET_ACCESS_KEY,
    s3Endpoint: process.env.FANJIN_BACKUP_S3_ENDPOINT,
  };
}

/**
 * Create a database backup
 */
export async function createBackup(
  database: Knex,
  config: BackupConfig,
  postgresCommands: PostgresBackupCommands = {},
): Promise<BackupMetadata> {
  const startTime = Date.now();
  const timestamp = Date.now();
  const backupId = `backup-${timestamp}-${crypto.randomBytes(4).toString("hex")}`;
  const databaseClient = database.client.config.client;
  
  logger.info({ backupId, databaseClient }, "Starting database backup");
  
  // Ensure backup directory exists
  await fs.mkdir(config.backupDir, { recursive: true });
  
  let filename: string;
  let backupPath: string;
  
  if (["pg", "postgres", "postgresql"].includes(databaseClient)) {
    filename = `${backupId}.sql.gz`;
    backupPath = path.join(config.backupDir, filename);
    await createPostgresBackup(database, backupPath, postgresCommands.pgDump);
  } else if (databaseClient === "sqlite3" || databaseClient === "better-sqlite3") {
    filename = `${backupId}.sqlite`;
    backupPath = path.join(config.backupDir, filename);
    await createSQLiteBackup(database, backupPath);
  } else {
    throw new Error(`Unsupported database client for backup: ${databaseClient}`);
  }
  
  // Calculate checksum
  const checksum = await calculateChecksum(backupPath);
  const stats = await fs.stat(backupPath);
  
  const metadata: BackupMetadata = {
    id: backupId,
    timestamp,
    filename,
    size: stats.size,
    checksum,
    databaseClient,
    verified: false,
    uploadedToCloud: false,
  };
  
  // Verify backup if enabled
  if (config.verifyBackup) {
    const isValid = await verifyBackup(backupPath, metadata);
    metadata.verified = isValid;
    
    if (!isValid) {
      logger.error({ backupId, backupPath }, "Backup verification failed");
      throw new Error("Backup verification failed");
    }
  }
  
  // Save metadata
  await saveBackupMetadata(config.backupDir, metadata);
  
  const duration = Date.now() - startTime;
  logger.info({ 
    backupId, 
    filename, 
    size: metadata.size, 
    durationMs: duration,
    verified: metadata.verified,
  }, "Database backup completed");
  
  // Upload to cloud if enabled
  if (config.uploadToCloud && config.s3Bucket) {
    try {
      const s3Key = await uploadBackupToS3(backupPath, metadata, config);
      metadata.uploadedToCloud = true;
      metadata.s3Key = s3Key;
      await saveBackupMetadata(config.backupDir, metadata);
      logger.info({ backupId, s3Key }, "Backup uploaded to S3");
    } catch (error) {
      logger.error({ backupId, error }, "Failed to upload backup to S3");
      // Don't fail the backup if upload fails
    }
  }
  
  return metadata;
}

/**
 * Create PostgreSQL backup using pg_dump
 */
function postgresBackupCommand(
  command: PostgresBackupCommand | undefined,
  fallback: "pg_dump" | "psql",
): { executable: string; prefixArgs: string[]; connectionArgs?: string[] } {
  const executable = String(command?.executable || fallback).trim();
  const prefixArgs = [...(command?.prefixArgs || [])];
  const connectionArgs = command?.connectionArgs === undefined
    ? undefined
    : [...command.connectionArgs];
  if (
    !executable
    || executable.includes("\0")
    || prefixArgs.some((argument) => (
      typeof argument !== "string" || argument.includes("\0")
    ))
    || connectionArgs?.some((argument) => (
      typeof argument !== "string" || !argument || argument.includes("\0")
    ))
  ) {
    throw new Error("PostgreSQL backup command configuration is invalid");
  }
  return { executable, prefixArgs, connectionArgs };
}

async function createPostgresBackup(
  database: Knex,
  backupPath: string,
  configuredCommand?: PostgresBackupCommand,
): Promise<void> {
  let context: PostgresCommandContext | undefined;
  let outputCreated = false;
  try {
    context = await postgresCommandContext(database);
    const command = postgresBackupCommand(configuredCommand, "pg_dump");
    const pgDump = spawn(command.executable, [
      ...command.prefixArgs,
      ...(command.connectionArgs ?? context.connectionArgs),
      "--no-password",
      "--format=plain",
      "--clean",
      "--if-exists",
    ], {
      env: context.env,
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const gzip = spawn("gzip", [], {
      shell: false,
      stdio: ["pipe", "pipe", "ignore"],
    });
    const output = createWriteStream(backupPath, { flags: "wx", mode: 0o600 });
    output.once("open", () => {
      outputCreated = true;
    });
    const children: ChildProcess[] = [pgDump, gzip];
    const pgDumpResult = waitForChildProcess(pgDump);
    const gzipResult = waitForChildProcess(gzip);

    const guardedPipeline = (promise: Promise<void>): Promise<void> => promise.catch((error) => {
      terminateChildProcesses(children);
      throw error;
    });
    const streamResults = Promise.allSettled([
      guardedPipeline(pipeline(pgDump.stdout, gzip.stdin)),
      guardedPipeline(pipeline(gzip.stdout, output)),
    ]);

    const [[dumpStatus, gzipStatus], settledStreams] = await Promise.all([
      Promise.all([pgDumpResult, gzipResult]),
      streamResults,
    ]);
    const streamFailed = settledStreams.some((result) => result.status === "rejected");

    if (childProcessFailed(dumpStatus) || childProcessFailed(gzipStatus) || streamFailed) {
      logger.error({
        pgDump: dumpStatus,
        gzip: gzipStatus,
        streamFailed,
      }, "PostgreSQL backup pipeline failed");
      throw new Error("PostgreSQL backup failed");
    }
  } catch {
    if (outputCreated) await fs.unlink(backupPath).catch(() => undefined);
    throw new Error("PostgreSQL backup failed");
  } finally {
    await context?.cleanup().catch(() => undefined);
  }
}

/**
 * Create SQLite backup using VACUUM INTO
 */
async function createSQLiteBackup(database: Knex, backupPath: string): Promise<void> {
  try {
    // Use VACUUM INTO for atomic backup
    await database.raw(`VACUUM INTO ?`, [backupPath]);
  } catch (error) {
    logger.error({ error, backupPath }, "SQLite backup failed");
    throw new Error(`SQLite backup failed: ${error}`);
  }
}

/**
 * Calculate SHA256 checksum of a file
 */
async function calculateChecksum(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

/**
 * Verify backup integrity
 */
async function verifyBackup(backupPath: string, metadata: BackupMetadata): Promise<boolean> {
  try {
    // Verify file exists and is readable
    await fs.access(backupPath, fs.constants.R_OK);
    
    // Verify checksum
    const actualChecksum = await calculateChecksum(backupPath);
    if (actualChecksum !== metadata.checksum) {
      logger.error({ expected: metadata.checksum, actual: actualChecksum }, "Checksum mismatch");
      return false;
    }
    
    // Verify file size
    const stats = await fs.stat(backupPath);
    if (stats.size !== metadata.size) {
      logger.error({ expected: metadata.size, actual: stats.size }, "File size mismatch");
      return false;
    }
    
    // For PostgreSQL, test gunzip
    if (backupPath.endsWith(".gz")) {
      try {
        const gunzip = spawn("gunzip", ["-t", "--", backupPath], {
          shell: false,
          stdio: "ignore",
        });
        const result = await waitForChildProcess(gunzip);
        if (childProcessFailed(result)) {
          logger.error({ gunzip: result }, "Gzip integrity check failed");
          return false;
        }
      } catch {
        logger.error("Gzip integrity check failed");
        return false;
      }
    }
    
    return true;
  } catch (error) {
    logger.error({ error, backupPath }, "Backup verification error");
    return false;
  }
}

/**
 * Save backup metadata to JSON file
 */
async function saveBackupMetadata(backupDir: string, metadata: BackupMetadata): Promise<void> {
  const metadataPath = path.join(backupDir, `${metadata.id}.json`);
  await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), { mode: 0o600 });
}

/**
 * Load backup metadata from JSON file
 */
async function loadBackupMetadata(backupDir: string, backupId: string): Promise<BackupMetadata | null> {
  if (!isSafeBackupIdentifier(backupId)) return null;
  const metadataPath = path.join(backupDir, `${backupId}.json`);
  
  try {
    const content = await fs.readFile(metadataPath, "utf-8");
    const metadata = JSON.parse(content) as Partial<BackupMetadata>;
    if (metadata.id !== backupId || !isSafeBackupFilename(metadata.filename)) return null;
    return metadata as BackupMetadata;
  } catch (error) {
    return null;
  }
}

/**
 * List all available backups
 */
export async function listBackups(config: BackupConfig): Promise<BackupMetadata[]> {
  try {
    const files = await fs.readdir(config.backupDir);
    const metadataFiles = files.filter(f => f.endsWith(".json"));
    
    const backups: BackupMetadata[] = [];
    for (const file of metadataFiles) {
      const backupId = file.replace(".json", "");
      const metadata = await loadBackupMetadata(config.backupDir, backupId);
      if (metadata) {
        backups.push(metadata);
      }
    }
    
    // Sort by timestamp descending (newest first)
    backups.sort((a, b) => b.timestamp - a.timestamp);
    
    return backups;
  } catch (error) {
    logger.error({ error }, "Failed to list backups");
    return [];
  }
}

/**
 * Clean up old backups based on retention policy
 */
export async function cleanupOldBackups(config: BackupConfig): Promise<number> {
  if (
    !Number.isSafeInteger(config.retentionDays)
    || config.retentionDays < 0
    || !Number.isSafeInteger(config.retentionCount)
    || config.retentionCount < 1
  ) {
    throw new Error("Invalid backup retention policy");
  }
  const backups = await listBackups(config);
  const now = Date.now();
  const retentionMs = config.retentionDays * 24 * 60 * 60 * 1000;
  
  let deletedCount = 0;
  
  for (let i = 0; i < backups.length; i++) {
    const backup = backups[i];
    const age = now - backup.timestamp;
    // The count is a minimum safety floor, not a maximum. A backup is only
    // eligible once it is both outside the newest N and older than the age
    // window, matching the documented "keep the larger set" policy.
    const shouldDelete =
      (i >= config.retentionCount) // Beyond minimum count
      && (age > retentionMs); // Beyond age window
    
    if (shouldDelete) {
      try {
        const backupPath = path.join(config.backupDir, backup.filename);
        const metadataPath = path.join(config.backupDir, `${backup.id}.json`);
        
        await fs.unlink(backupPath);
        await fs.unlink(metadataPath);
        
        deletedCount++;
        logger.info({ backupId: backup.id, age: Math.round(age / 1000 / 60 / 60 / 24) }, "Deleted old backup");
      } catch (error) {
        logger.error({ error, backupId: backup.id }, "Failed to delete old backup");
      }
    }
  }
  
  return deletedCount;
}

/**
 * Upload backup to S3-compatible storage
 */
async function uploadBackupToS3(
  backupPath: string,
  metadata: BackupMetadata,
  config: BackupConfig,
): Promise<string> {
  // Dynamic import to avoid loading AWS SDK if not needed
  const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
  
  const s3Config: any = {
    region: config.s3Region,
    credentials: {
      accessKeyId: config.s3AccessKeyId!,
      secretAccessKey: config.s3SecretAccessKey!,
    },
  };
  
  if (config.s3Endpoint) {
    s3Config.endpoint = config.s3Endpoint;
    s3Config.forcePathStyle = true; // Required for MinIO and other S3-compatible services
  }
  
  const s3 = new S3Client(s3Config);
  
  const s3Key = `fanjin-backups/${metadata.id}/${metadata.filename}`;
  
  await s3.send(new PutObjectCommand({
    Bucket: config.s3Bucket!,
    Key: s3Key,
    Body: createReadStream(backupPath),
    ContentLength: metadata.size,
    Metadata: {
      "backup-id": metadata.id,
      "backup-timestamp": metadata.timestamp.toString(),
      "backup-checksum": metadata.checksum,
      "database-client": metadata.databaseClient,
    },
  }));
  
  return s3Key;
}

/**
 * Restore database from backup
 */
export async function restoreFromBackup(
  database: Knex,
  backupId: string,
  config: BackupConfig,
  postgresCommands: PostgresBackupCommands = {},
): Promise<void> {
  const metadata = await loadBackupMetadata(config.backupDir, backupId);
  if (!metadata) {
    throw new Error("Backup not found");
  }
  
  const backupPath = path.join(config.backupDir, metadata.filename);
  
  // Verify backup before restoring
  const isValid = await verifyBackup(backupPath, metadata);
  if (!isValid) {
    throw new Error("Backup verification failed, refusing to restore");
  }
  
  logger.warn({ backupId, filename: metadata.filename }, "Starting database restore - THIS WILL OVERWRITE CURRENT DATA");
  
  const databaseClient = database.client.config.client;
  
  if (["pg", "postgres", "postgresql"].includes(databaseClient)) {
    await restorePostgresBackup(database, backupPath, postgresCommands.psql);
  } else if (databaseClient === "sqlite3" || databaseClient === "better-sqlite3") {
    await restoreSQLiteBackup(database, backupPath);
  } else {
    throw new Error(`Unsupported database client for restore: ${databaseClient}`);
  }
  
  logger.info({ backupId }, "Database restore completed");
}

/**
 * Restore PostgreSQL backup using psql
 */
async function restorePostgresBackup(
  database: Knex,
  backupPath: string,
  configuredCommand?: PostgresBackupCommand,
): Promise<void> {
  let context: PostgresCommandContext | undefined;
  try {
    context = await postgresCommandContext(database);
    const gunzip = spawn("gunzip", ["-c", "--", backupPath], {
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const command = postgresBackupCommand(configuredCommand, "psql");
    const psql = spawn(command.executable, [
      ...command.prefixArgs,
      ...(command.connectionArgs ?? context.connectionArgs),
      "--no-password",
      "--no-psqlrc",
      "--single-transaction",
      "--set=ON_ERROR_STOP=on",
    ], {
      env: context.env,
      shell: false,
      stdio: ["pipe", "ignore", "ignore"],
    });
    const children: ChildProcess[] = [gunzip, psql];
    const gunzipResult = waitForChildProcess(gunzip);
    const psqlResult = waitForChildProcess(psql);
    const streamResult = pipeline(gunzip.stdout, psql.stdin).catch((error) => {
      terminateChildProcesses(children);
      throw error;
    });

    const [[gunzipStatus, psqlStatus], settledStream] = await Promise.all([
      Promise.all([gunzipResult, psqlResult]),
      Promise.allSettled([streamResult]),
    ]);
    const streamFailed = settledStream[0].status === "rejected";

    if (childProcessFailed(gunzipStatus) || childProcessFailed(psqlStatus) || streamFailed) {
      logger.error({
        gunzip: gunzipStatus,
        psql: psqlStatus,
        streamFailed,
      }, "PostgreSQL restore pipeline failed");
      throw new Error("PostgreSQL restore failed");
    }
  } catch {
    throw new Error("PostgreSQL restore failed");
  } finally {
    await context?.cleanup().catch(() => undefined);
  }
}

/**
 * Restore SQLite backup by replacing database file
 */
async function restoreSQLiteBackup(database: Knex, backupPath: string): Promise<void> {
  const config = database.client.config.connection as any;
  const dbPath = config.filename;
  
  if (!dbPath) {
    throw new Error("SQLite database path not found in configuration");
  }
  
  // Close all connections
  await database.destroy();
  
  try {
    // Replace database file
    await fs.copyFile(backupPath, dbPath);
  } catch (error) {
    logger.error({ error }, "SQLite restore failed");
    throw new Error(`SQLite restore failed: ${error}`);
  }
}
