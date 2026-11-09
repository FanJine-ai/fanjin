import fs from "node:fs";
import path from "node:path";

export interface EnvironmentLike {
  [key: string]: string | undefined;
}

const MAX_DATABASE_SSL_CA_FILE_BYTES = 1024 * 1024;

function value(env: EnvironmentLike, name: string): string {
  return String(env[name] || "").trim();
}

function positiveInteger(raw: string, name: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return parsed;
}

function invalidCaFile(): Error {
  return new Error(
    "FANJIN_DATABASE_SSL_CA_FILE must be an absolute canonical path to a non-symlink regular file "
    + `between 1 and ${MAX_DATABASE_SSL_CA_FILE_BYTES} bytes that is not group- or world-writable`,
  );
}

function readPostgresCaFile(filePath: string): string {
  try {
    if (!path.isAbsolute(filePath) || path.resolve(filePath) !== filePath) throw invalidCaFile();
    const noFollow = fs.constants.O_NOFOLLOW;
    if (typeof noFollow !== "number" || noFollow === 0) throw invalidCaFile();

    const linkStat = fs.lstatSync(filePath);
    if (linkStat.isSymbolicLink() || !linkStat.isFile()) throw invalidCaFile();

    const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
    try {
      const openedStat = fs.fstatSync(descriptor);
      if (
        !openedStat.isFile()
        || openedStat.dev !== linkStat.dev
        || openedStat.ino !== linkStat.ino
        || (openedStat.mode & 0o022) !== 0
        || openedStat.size < 1
        || openedStat.size > MAX_DATABASE_SSL_CA_FILE_BYTES
      ) {
        throw invalidCaFile();
      }

      const bytes = fs.readFileSync(descriptor);
      const finalStat = fs.fstatSync(descriptor);
      if (
        finalStat.dev !== openedStat.dev
        || finalStat.ino !== openedStat.ino
        || finalStat.size !== openedStat.size
        || bytes.length !== openedStat.size
      ) {
        throw invalidCaFile();
      }

      const ca = bytes.toString("utf8");
      if (!ca.trim() || ca.includes("\0")) throw invalidCaFile();
      return ca;
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {
    throw invalidCaFile();
  }
}

function postgresSsl(env: EnvironmentLike): false | { rejectUnauthorized: boolean; ca?: string } | undefined {
  const inlineCa = value(env, "FANJIN_DATABASE_SSL_CA");
  const caFile = value(env, "FANJIN_DATABASE_SSL_CA_FILE");
  if (inlineCa && caFile) {
    throw new Error("FANJIN_DATABASE_SSL_CA and FANJIN_DATABASE_SSL_CA_FILE must not both be set");
  }
  const mode = value(env, "FANJIN_DATABASE_SSL").toLowerCase();
  if (!mode) return undefined;
  if (["0", "false", "off", "disable", "disabled"].includes(mode)) return false;
  if (!["1", "true", "on", "require", "verify-ca", "verify-full"].includes(mode)) {
    throw new Error("FANJIN_DATABASE_SSL must be disable, require, verify-ca, or verify-full");
  }
  const rejectUnauthorized = mode === "verify-ca" || mode === "verify-full" || value(env, "FANJIN_DATABASE_SSL_REJECT_UNAUTHORIZED") === "1";
  const ca = caFile ? readPostgresCaFile(caFile) : inlineCa.replace(/\\n/g, "\n");
  return ca ? { rejectUnauthorized, ca } : { rejectUnauthorized };
}

export function postgresConnectionFromEnv(env: EnvironmentLike = process.env): string | Record<string, unknown> {
  const databaseUrl = value(env, "DATABASE_URL");
  const ssl = postgresSsl(env);
  if (databaseUrl) {
    return ssl === undefined ? databaseUrl : { connectionString: databaseUrl, ssl };
  }

  const required = [
    "FANJIN_DATABASE_HOST",
    "FANJIN_DATABASE_PORT",
    "FANJIN_DATABASE_NAME",
    "FANJIN_DATABASE_USER",
    "FANJIN_DATABASE_PASSWORD",
  ];
  const missing = required.filter((name) => !value(env, name));
  if (missing.length) {
    throw new Error(`PostgreSQL configuration is incomplete: ${missing.join(", ")}`);
  }

  return {
    host: value(env, "FANJIN_DATABASE_HOST"),
    port: positiveInteger(value(env, "FANJIN_DATABASE_PORT"), "FANJIN_DATABASE_PORT"),
    database: value(env, "FANJIN_DATABASE_NAME"),
    user: value(env, "FANJIN_DATABASE_USER"),
    password: value(env, "FANJIN_DATABASE_PASSWORD"),
    ...(ssl === undefined ? {} : { ssl }),
  };
}
