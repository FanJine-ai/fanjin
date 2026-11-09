import crypto from "node:crypto";
import type { Knex } from "knex";
import { isPostgresClient } from "@/lib/dbDialect";

export const REDIS_RATE_LIMIT_CUTOVER_SETTING_KEY = "platform.gateway.redisRateLimitCutoverState";
export const REDIS_RATE_LIMIT_CUTOVER_ARM_MARKER_SETTING_KEY =
  "platform.gateway.redisRateLimitCutoverArmMarker";
export const REDIS_RATE_LIMIT_FINGERPRINT_ROTATION_RECEIPT_SETTING_KEY =
  "platform.gateway.redisRateLimitFingerprintRotationReceipt";
export const REDIS_RATE_LIMIT_CUTOVER_SCHEMA_VERSION = 1 as const;
export const REDIS_RATE_LIMIT_FINGERPRINT_ROTATION_SCHEMA_VERSION = 1 as const;
export const POSTGRES_REDIS_RATE_LIMIT_CUTOVER_LOCK_SQL =
  "SELECT pg_advisory_xact_lock(?::bigint)";

// Stable, process-independent lock id (ASCII "FJCU"). The setting row cannot
// provide a row lock while it is absent, so PostgreSQL writers must first take
// this transaction-scoped advisory lock.
const POSTGRES_REDIS_RATE_LIMIT_CUTOVER_LOCK_ID = 0x464a4355;
const CONTRACT_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const PERSISTED_KEYS = [
  "schemaVersion",
  "state",
  "contractFingerprint",
  "cutoverAtMs",
  "scheduledAtRedisMs",
  "activatedAtRedisMs",
] as const;
const ARM_MARKER_KEYS = [
  "schemaVersion",
  "contractFingerprint",
  "cutoverAtMs",
  "scheduledAtRedisMs",
] as const;
const MAX_SQLITE_RETRIES = 5;
const MAX_FINGERPRINT_ROLLBACK_WINDOW_MS = 24 * 60 * 60_000;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{5,127}$/;
const ROTATION_CENTRAL_RECEIPT_HMAC_FORMAT =
  "fanjin-redis-runtime-fingerprint-central-receipt-hmac/v1";
const ROTATION_CENTRAL_RECEIPT_HMAC_KEY_CONTEXT =
  "fanjin-redis-runtime-fingerprint-central-receipt-hmac-key/v1";
const ROTATION_RECEIPT_KEYS = [
  "schemaVersion",
  "operationId",
  "state",
  "previousFingerprint",
  "nextFingerprint",
  "authorizationSha256",
  "rollbackAuthorizationSha256",
  "appliedAtMs",
  "rollbackDeadlineMs",
  "rolledBackAtMs",
] as const;

interface RedisRateLimitCutoverArmMarker {
  schemaVersion: typeof REDIS_RATE_LIMIT_CUTOVER_SCHEMA_VERSION;
  contractFingerprint: string;
  cutoverAtMs: number;
  scheduledAtRedisMs: number;
}

export type RedisRateLimitCutoverStatus = "unarmed" | "scheduled" | "active";

export interface RedisRateLimitCutoverUnarmedState {
  schemaVersion: typeof REDIS_RATE_LIMIT_CUTOVER_SCHEMA_VERSION;
  state: "unarmed";
  contractFingerprint: null;
  cutoverAtMs: null;
  scheduledAtRedisMs: null;
  activatedAtRedisMs: null;
}

export interface RedisRateLimitCutoverScheduledState {
  schemaVersion: typeof REDIS_RATE_LIMIT_CUTOVER_SCHEMA_VERSION;
  state: "scheduled";
  contractFingerprint: string;
  cutoverAtMs: number;
  scheduledAtRedisMs: number;
  activatedAtRedisMs: null;
}

export interface RedisRateLimitCutoverActiveState {
  schemaVersion: typeof REDIS_RATE_LIMIT_CUTOVER_SCHEMA_VERSION;
  state: "active";
  contractFingerprint: string;
  cutoverAtMs: number;
  scheduledAtRedisMs: number;
  activatedAtRedisMs: number;
}

export type PersistedRedisRateLimitCutoverState =
  | RedisRateLimitCutoverScheduledState
  | RedisRateLimitCutoverActiveState;

export type RedisRateLimitCutoverState =
  | RedisRateLimitCutoverUnarmedState
  | PersistedRedisRateLimitCutoverState;

export type RedisRateLimitCutoverErrorCode =
  | "redis_rate_limit_cutover_invalid_input"
  | "redis_rate_limit_cutover_invalid_state"
  | "redis_rate_limit_cutover_conflict"
  | "redis_rate_limit_cutover_not_scheduled"
  | "redis_rate_limit_cutover_too_early"
  | "redis_rate_limit_cutover_lead_too_short"
  | "redis_rate_limit_cutover_time_unavailable"
  | "redis_rate_limit_cutover_rollback_expired"
  | "redis_rate_limit_cutover_unavailable";

export class RedisRateLimitCutoverError extends Error {
  readonly code: RedisRateLimitCutoverErrorCode;

  constructor(code: RedisRateLimitCutoverErrorCode, message: string) {
    super(message);
    this.name = "RedisRateLimitCutoverError";
    this.code = code;
  }
}

export interface RedisRateLimitCutoverInspection {
  valid: boolean;
  state: RedisRateLimitCutoverStatus | null;
  schemaVersion: number | null;
  /** A non-comparable, redacted hint. Use the parsed state for equality checks. */
  contractFingerprintHint: string | null;
  cutoverAtMs: number | null;
  scheduledAtRedisMs: number | null;
  activatedAtRedisMs: number | null;
  errorCode: RedisRateLimitCutoverErrorCode | null;
}

export interface ScheduleRedisRateLimitCutoverInput {
  database: Knex;
  contractFingerprint: string;
  cutoverAtMs: number;
  /** Resolved inside the serialized mutation after reading the central latch. */
  redisNowMs: number | (() => Promise<number>);
  minimumLeadMs?: number;
}

export interface ActivateRedisRateLimitCutoverInput {
  database: Knex;
  contractFingerprint: string;
  cutoverAtMs: number;
  redisNowMs: number;
}

export interface RedisRateLimitFingerprintRotationReceipt {
  schemaVersion: typeof REDIS_RATE_LIMIT_FINGERPRINT_ROTATION_SCHEMA_VERSION;
  operationId: string;
  state: "forward_applied" | "rollback_applied";
  previousFingerprint: string;
  nextFingerprint: string;
  authorizationSha256: string;
  rollbackAuthorizationSha256: string | null;
  appliedAtMs: number;
  rollbackDeadlineMs: number;
  rolledBackAtMs: number | null;
}

export interface RotateRedisRateLimitFingerprintInput {
  database: Knex;
  operationId: string;
  expectedFingerprint: string;
  nextFingerprint: string;
  authorizationSha256: string;
  observedAtMs: number;
  rollbackDeadlineMs: number;
}

export interface RollbackRedisRateLimitFingerprintInput {
  database: Knex;
  operationId: string;
  expectedCurrentFingerprint: string;
  rollbackFingerprint: string;
  rollbackAuthorizationSha256: string;
  observedAtMs: number;
}

const UNARMED_STATE: RedisRateLimitCutoverUnarmedState = Object.freeze({
  schemaVersion: REDIS_RATE_LIMIT_CUTOVER_SCHEMA_VERSION,
  state: "unarmed",
  contractFingerprint: null,
  cutoverAtMs: null,
  scheduledAtRedisMs: null,
  activatedAtRedisMs: null,
});

class CutoverCompareAndSwapConflict extends Error {}

function invalidState(): RedisRateLimitCutoverError {
  // Never include the persisted value in this error: o_setting may have been
  // corrupted with arbitrary (and potentially secret) text.
  return new RedisRateLimitCutoverError(
    "redis_rate_limit_cutover_invalid_state",
    "Redis rate-limit cutover state is invalid",
  );
}

function invalidInput(message: string): RedisRateLimitCutoverError {
  return new RedisRateLimitCutoverError(
    "redis_rate_limit_cutover_invalid_input",
    message,
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactPersistedKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value).sort();
  const expected = [...PERSISTED_KEYS].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function isSafeRedisTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function assertContractFingerprint(value: unknown): asserts value is string {
  if (typeof value !== "string" || !CONTRACT_FINGERPRINT_PATTERN.test(value)) {
    throw invalidInput("contractFingerprint must be a lowercase SHA-256 digest");
  }
}

function assertRedisTimestamp(value: unknown, field: string): asserts value is number {
  if (!isSafeRedisTimestamp(value)) {
    throw invalidInput(`${field} must be a non-negative safe integer`);
  }
}

function assertOperationId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !OPERATION_ID_PATTERN.test(value)) {
    throw invalidInput("operationId is invalid");
  }
}

function parseFingerprintRotationReceipt(raw: unknown): RedisRateLimitFingerprintRotationReceipt {
  if (typeof raw !== "string" || !raw) throw invalidState();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw invalidState();
  }
  if (!isPlainObject(value)) throw invalidState();
  const keys = Object.keys(value).sort();
  const expectedKeys = [...ROTATION_RECEIPT_KEYS].sort();
  if (
    keys.length !== expectedKeys.length
    || !keys.every((key, index) => key === expectedKeys[index])
    || value.schemaVersion !== REDIS_RATE_LIMIT_FINGERPRINT_ROTATION_SCHEMA_VERSION
    || typeof value.operationId !== "string"
    || !OPERATION_ID_PATTERN.test(value.operationId)
    || (value.state !== "forward_applied" && value.state !== "rollback_applied")
    || typeof value.previousFingerprint !== "string"
    || !CONTRACT_FINGERPRINT_PATTERN.test(value.previousFingerprint)
    || typeof value.nextFingerprint !== "string"
    || !CONTRACT_FINGERPRINT_PATTERN.test(value.nextFingerprint)
    || value.previousFingerprint === value.nextFingerprint
    || typeof value.authorizationSha256 !== "string"
    || !CONTRACT_FINGERPRINT_PATTERN.test(value.authorizationSha256)
    || !isSafeRedisTimestamp(value.appliedAtMs)
    || !isSafeRedisTimestamp(value.rollbackDeadlineMs)
    || value.rollbackDeadlineMs <= value.appliedAtMs
    || value.rollbackDeadlineMs - value.appliedAtMs > MAX_FINGERPRINT_ROLLBACK_WINDOW_MS
  ) throw invalidState();
  if (value.state === "forward_applied") {
    if (value.rollbackAuthorizationSha256 !== null || value.rolledBackAtMs !== null) {
      throw invalidState();
    }
  } else if (
    typeof value.rollbackAuthorizationSha256 !== "string"
    || !CONTRACT_FINGERPRINT_PATTERN.test(value.rollbackAuthorizationSha256)
    || !isSafeRedisTimestamp(value.rolledBackAtMs)
    || value.rolledBackAtMs < value.appliedAtMs
    || value.rolledBackAtMs > value.rollbackDeadlineMs
  ) {
    throw invalidState();
  }
  return value as unknown as RedisRateLimitFingerprintRotationReceipt;
}

function serializeFingerprintRotationReceipt(
  receipt: RedisRateLimitFingerprintRotationReceipt,
): string {
  return JSON.stringify(receipt);
}

export function redisFingerprintRotationCentralReceiptHmac(input: {
  action: "forward" | "rollback";
  receipt: RedisRateLimitFingerprintRotationReceipt;
  secret: string;
}): string {
  const receipt = parseFingerprintRotationReceipt(
    serializeFingerprintRotationReceipt(input.receipt),
  );
  if (Buffer.byteLength(input.secret, "utf8") < 32) {
    throw invalidInput("central receipt HMAC secret must contain at least 32 bytes");
  }
  const authorizationSha256 = input.action === "forward"
    ? receipt.authorizationSha256
    : receipt.rollbackAuthorizationSha256;
  const rolledBackAtMs = input.action === "forward" ? null : receipt.rolledBackAtMs;
  if (
    (input.action === "forward" && receipt.state !== "forward_applied")
    || (input.action === "rollback" && receipt.state !== "rollback_applied")
    || authorizationSha256 === null
    || (input.action === "forward" && receipt.rolledBackAtMs !== null)
    || (input.action === "rollback" && rolledBackAtMs === null)
  ) throw invalidInput("central receipt does not match its HMAC action");

  const key = crypto
    .createHmac("sha256", Buffer.from(input.secret, "utf8"))
    .update(ROTATION_CENTRAL_RECEIPT_HMAC_KEY_CONTEXT, "utf8")
    .digest();
  const material = [
    ROTATION_CENTRAL_RECEIPT_HMAC_FORMAT,
    input.action,
    receipt.operationId,
    receipt.previousFingerprint,
    receipt.nextFingerprint,
    authorizationSha256,
    String(receipt.appliedAtMs),
    String(receipt.rollbackDeadlineMs),
    rolledBackAtMs === null ? "" : String(rolledBackAtMs),
  ].join("\0");
  return crypto
    .createHmac("sha256", key)
    .update(material, "utf8")
    .digest("hex");
}

function parsePersistedObject(value: unknown): PersistedRedisRateLimitCutoverState {
  if (!isPlainObject(value) || !hasExactPersistedKeys(value)) throw invalidState();
  if (value.schemaVersion !== REDIS_RATE_LIMIT_CUTOVER_SCHEMA_VERSION) throw invalidState();
  if (value.state !== "scheduled" && value.state !== "active") throw invalidState();
  if (
    typeof value.contractFingerprint !== "string"
    || !CONTRACT_FINGERPRINT_PATTERN.test(value.contractFingerprint)
    || !isSafeRedisTimestamp(value.cutoverAtMs)
    || !isSafeRedisTimestamp(value.scheduledAtRedisMs)
    || value.cutoverAtMs <= value.scheduledAtRedisMs
  ) {
    throw invalidState();
  }

  if (value.state === "scheduled") {
    if (value.activatedAtRedisMs !== null) throw invalidState();
    return {
      schemaVersion: REDIS_RATE_LIMIT_CUTOVER_SCHEMA_VERSION,
      state: "scheduled",
      contractFingerprint: value.contractFingerprint,
      cutoverAtMs: value.cutoverAtMs,
      scheduledAtRedisMs: value.scheduledAtRedisMs,
      activatedAtRedisMs: null,
    };
  }

  if (
    !isSafeRedisTimestamp(value.activatedAtRedisMs)
    || value.activatedAtRedisMs < value.cutoverAtMs
  ) {
    throw invalidState();
  }
  return {
    schemaVersion: REDIS_RATE_LIMIT_CUTOVER_SCHEMA_VERSION,
    state: "active",
    contractFingerprint: value.contractFingerprint,
    cutoverAtMs: value.cutoverAtMs,
    scheduledAtRedisMs: value.scheduledAtRedisMs,
    activatedAtRedisMs: value.activatedAtRedisMs,
  };
}

/**
 * Strictly parse the value stored in o_setting. An absent row is the only
 * representation of `unarmed`; a persisted `unarmed` object is rejected so a
 * writer cannot turn an active latch back into an apparently fresh record.
 */
export function parseRedisRateLimitCutoverState(raw: unknown): RedisRateLimitCutoverState {
  if (raw === undefined) return UNARMED_STATE;
  if (typeof raw !== "string" || raw.length === 0) throw invalidState();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalidState();
  }
  return parsePersistedObject(parsed);
}

function fingerprintHint(fingerprint: string | null): string | null {
  if (!fingerprint) return null;
  return `${fingerprint.slice(0, 8)}…${fingerprint.slice(-4)}`;
}

/** Return an operationally useful view without reflecting arbitrary raw data. */
export function inspectRedisRateLimitCutoverValue(raw: unknown): RedisRateLimitCutoverInspection {
  try {
    const state = parseRedisRateLimitCutoverState(raw);
    return {
      valid: true,
      state: state.state,
      schemaVersion: state.schemaVersion,
      contractFingerprintHint: fingerprintHint(state.contractFingerprint),
      cutoverAtMs: state.cutoverAtMs,
      scheduledAtRedisMs: state.scheduledAtRedisMs,
      activatedAtRedisMs: state.activatedAtRedisMs,
      errorCode: null,
    };
  } catch (error) {
    return {
      valid: false,
      state: null,
      schemaVersion: null,
      contractFingerprintHint: null,
      cutoverAtMs: null,
      scheduledAtRedisMs: null,
      activatedAtRedisMs: null,
      errorCode: error instanceof RedisRateLimitCutoverError
        ? error.code
        : "redis_rate_limit_cutover_invalid_state",
    };
  }
}

function serializePersistedState(state: PersistedRedisRateLimitCutoverState): string {
  return JSON.stringify({
    schemaVersion: state.schemaVersion,
    state: state.state,
    contractFingerprint: state.contractFingerprint,
    cutoverAtMs: state.cutoverAtMs,
    scheduledAtRedisMs: state.scheduledAtRedisMs,
    activatedAtRedisMs: state.activatedAtRedisMs,
  });
}

function armMarkerFromState(
  state: PersistedRedisRateLimitCutoverState,
): RedisRateLimitCutoverArmMarker {
  return {
    schemaVersion: REDIS_RATE_LIMIT_CUTOVER_SCHEMA_VERSION,
    contractFingerprint: state.contractFingerprint,
    cutoverAtMs: state.cutoverAtMs,
    scheduledAtRedisMs: state.scheduledAtRedisMs,
  };
}

function serializeArmMarker(marker: RedisRateLimitCutoverArmMarker): string {
  return JSON.stringify(marker);
}

function parseArmMarker(raw: unknown): RedisRateLimitCutoverArmMarker {
  if (typeof raw !== "string" || !raw) throw invalidState();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw invalidState();
  }
  if (!isPlainObject(value)) throw invalidState();
  const keys = Object.keys(value).sort();
  const expectedKeys = [...ARM_MARKER_KEYS].sort();
  if (
    keys.length !== expectedKeys.length
    || !keys.every((key, index) => key === expectedKeys[index])
    || value.schemaVersion !== REDIS_RATE_LIMIT_CUTOVER_SCHEMA_VERSION
    || typeof value.contractFingerprint !== "string"
    || !CONTRACT_FINGERPRINT_PATTERN.test(value.contractFingerprint)
    || !isSafeRedisTimestamp(value.cutoverAtMs)
    || !isSafeRedisTimestamp(value.scheduledAtRedisMs)
    || value.cutoverAtMs <= value.scheduledAtRedisMs
  ) {
    throw invalidState();
  }
  return {
    schemaVersion: REDIS_RATE_LIMIT_CUTOVER_SCHEMA_VERSION,
    contractFingerprint: value.contractFingerprint,
    cutoverAtMs: value.cutoverAtMs,
    scheduledAtRedisMs: value.scheduledAtRedisMs,
  };
}

function assertArmMarkerMatches(
  state: PersistedRedisRateLimitCutoverState,
  marker: RedisRateLimitCutoverArmMarker,
): void {
  if (
    marker.contractFingerprint !== state.contractFingerprint
    || marker.cutoverAtMs !== state.cutoverAtMs
    || marker.scheduledAtRedisMs !== state.scheduledAtRedisMs
  ) {
    throw invalidState();
  }
}

function isKnownCutoverError(error: unknown): error is RedisRateLimitCutoverError {
  return error instanceof RedisRateLimitCutoverError;
}

function isSqliteContention(error: unknown): boolean {
  const code = String((error as { code?: unknown } | null)?.code || "");
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED";
}

function unavailableError(): RedisRateLimitCutoverError {
  return new RedisRateLimitCutoverError(
    "redis_rate_limit_cutover_unavailable",
    "Redis rate-limit cutover state is unavailable",
  );
}

async function readSettingRow(
  client: Knex | Knex.Transaction,
  forUpdate: boolean,
  key = REDIS_RATE_LIMIT_CUTOVER_SETTING_KEY,
): Promise<{ value: unknown } | undefined> {
  let query = client("o_setting")
    .where({ key })
    .select("value");
  if (forUpdate && isPostgresClient(client)) query = query.forUpdate();
  return query.first();
}

async function readPersistedCutover(
  client: Knex | Knex.Transaction,
  forUpdate: boolean,
): Promise<{
  state: PersistedRedisRateLimitCutoverState;
  rawStateValue: unknown;
  rawMarkerValue: unknown;
} | null> {
  const stateRow = await readSettingRow(client, forUpdate);
  const markerRow = await readSettingRow(
    client,
    forUpdate,
    REDIS_RATE_LIMIT_CUTOVER_ARM_MARKER_SETTING_KEY,
  );
  if (!stateRow && !markerRow) return null;
  // The marker is intentionally independent from the mutable scheduled/active
  // row. Losing either half proves central state was deleted or corrupted, so a
  // fresh process must fail closed instead of interpreting absence as unarmed.
  if (!stateRow || !markerRow) throw invalidState();
  const state = parseRedisRateLimitCutoverState(stateRow.value);
  if (state.state === "unarmed") throw invalidState();
  assertArmMarkerMatches(state, parseArmMarker(markerRow.value));
  return {
    state,
    rawStateValue: stateRow.value,
    rawMarkerValue: markerRow.value,
  };
}

async function withSerializedMutation<T>(
  database: Knex,
  operation: (client: Knex | Knex.Transaction) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < MAX_SQLITE_RETRIES; attempt += 1) {
    try {
      if (isPostgresClient(database)) {
        return await database.transaction(async (trx) => {
          await trx.raw(POSTGRES_REDIS_RATE_LIMIT_CUTOVER_LOCK_SQL, [
            POSTGRES_REDIS_RATE_LIMIT_CUTOVER_LOCK_ID,
          ]);
          return operation(trx);
        });
      }

      // SQLite has no row-level SELECT ... FOR UPDATE. A deferred read/write
      // transaction can deadlock with another process trying to upgrade the
      // same snapshot, so use single-statement INSERT-ignore / value-CAS
      // writes instead. Every SQLite statement is itself transactional.
      return await operation(database);
    } catch (error) {
      if (isKnownCutoverError(error)) throw error;
      if (
        (error instanceof CutoverCompareAndSwapConflict || isSqliteContention(error))
        && attempt + 1 < MAX_SQLITE_RETRIES
      ) {
        continue;
      }
      throw unavailableError();
    }
  }
  throw unavailableError();
}

/** Read the durable latch. Any query or parse failure is fail-closed. */
export async function readRedisRateLimitCutoverState(
  database: Knex,
): Promise<RedisRateLimitCutoverState> {
  try {
    const persisted = await readPersistedCutover(database, false);
    return persisted?.state ?? UNARMED_STATE;
  } catch (error) {
    if (isKnownCutoverError(error)) throw error;
    throw unavailableError();
  }
}

function assertContractMatches(
  state: PersistedRedisRateLimitCutoverState,
  contractFingerprint: string,
  cutoverAtMs: number,
): void {
  if (
    state.contractFingerprint !== contractFingerprint
    || state.cutoverAtMs !== cutoverAtMs
  ) {
    throw new RedisRateLimitCutoverError(
      "redis_rate_limit_cutover_conflict",
      "Redis rate-limit cutover schedule is immutable",
    );
  }
}

/**
 * Arm the latch exactly once. Identical retries are idempotent, including a
 * delayed retry after activation; a different fingerprint or time is refused.
 */
export async function scheduleRedisRateLimitCutover(
  input: ScheduleRedisRateLimitCutoverInput,
): Promise<PersistedRedisRateLimitCutoverState> {
  assertContractFingerprint(input.contractFingerprint);
  assertRedisTimestamp(input.cutoverAtMs, "cutoverAtMs");
  const minimumLeadMs = input.minimumLeadMs ?? 1;
  if (!Number.isSafeInteger(minimumLeadMs) || minimumLeadMs < 1) {
    throw invalidInput("minimumLeadMs must be a positive safe integer");
  }
  if (typeof input.redisNowMs !== "function") {
    assertRedisTimestamp(input.redisNowMs, "redisNowMs");
  }

  return withSerializedMutation(input.database, async (trx) => {
    // Read behind the PostgreSQL advisory/row lock first. Identical retries
    // remain idempotent even after the boundary; only a genuinely absent latch
    // needs a fresh distributed-clock decision.
    const existing = await readPersistedCutover(trx, true);
    if (existing) {
      assertContractMatches(existing.state, input.contractFingerprint, input.cutoverAtMs);
      return existing.state;
    }

    let redisNowMs: number;
    try {
      redisNowMs = typeof input.redisNowMs === "function"
        ? await input.redisNowMs()
        : input.redisNowMs;
    } catch {
      throw new RedisRateLimitCutoverError(
        "redis_rate_limit_cutover_time_unavailable",
        "Redis server time is unavailable while scheduling cutover",
      );
    }
    if (!isSafeRedisTimestamp(redisNowMs)) {
      throw new RedisRateLimitCutoverError(
        "redis_rate_limit_cutover_time_unavailable",
        "Redis server time is invalid while scheduling cutover",
      );
    }
    if (input.cutoverAtMs - redisNowMs < minimumLeadMs) {
      throw new RedisRateLimitCutoverError(
        "redis_rate_limit_cutover_lead_too_short",
        "Redis rate-limit cutover no longer has the required lead time",
      );
    }

    const candidate: RedisRateLimitCutoverScheduledState = {
      schemaVersion: REDIS_RATE_LIMIT_CUTOVER_SCHEMA_VERSION,
      state: "scheduled",
      contractFingerprint: input.contractFingerprint,
      cutoverAtMs: input.cutoverAtMs,
      scheduledAtRedisMs: redisNowMs,
      activatedAtRedisMs: null,
    };
    await trx("o_setting")
      .insert([
        {
          key: REDIS_RATE_LIMIT_CUTOVER_SETTING_KEY,
          value: serializePersistedState(candidate),
        },
        {
          key: REDIS_RATE_LIMIT_CUTOVER_ARM_MARKER_SETTING_KEY,
          value: serializeArmMarker(armMarkerFromState(candidate)),
        },
      ])
      .onConflict("key")
      .ignore();

    const current = await readPersistedCutover(trx, true);
    if (!current) throw new CutoverCompareAndSwapConflict();
    assertContractMatches(current.state, input.contractFingerprint, input.cutoverAtMs);
    return current.state;
  });
}

/**
 * Permanently activate a matching schedule once Redis server time reaches the
 * cutover. The update is a value-level CAS for SQLite and a row update behind
 * the advisory/row locks on PostgreSQL.
 */
export async function activateRedisRateLimitCutover(
  input: ActivateRedisRateLimitCutoverInput,
): Promise<RedisRateLimitCutoverActiveState> {
  assertContractFingerprint(input.contractFingerprint);
  assertRedisTimestamp(input.cutoverAtMs, "cutoverAtMs");
  assertRedisTimestamp(input.redisNowMs, "redisNowMs");

  return withSerializedMutation(input.database, async (trx) => {
    const persisted = await readPersistedCutover(trx, true);
    if (!persisted) {
      throw new RedisRateLimitCutoverError(
        "redis_rate_limit_cutover_not_scheduled",
        "Redis rate-limit cutover has not been scheduled",
      );
    }
    const current = persisted.state;
    assertContractMatches(current, input.contractFingerprint, input.cutoverAtMs);
    if (current.state === "active") return current;
    if (input.redisNowMs < current.cutoverAtMs) {
      throw new RedisRateLimitCutoverError(
        "redis_rate_limit_cutover_too_early",
        "Redis rate-limit cutover time has not been reached",
      );
    }

    const active: RedisRateLimitCutoverActiveState = {
      ...current,
      state: "active",
      activatedAtRedisMs: input.redisNowMs,
    };
    const updated = await trx("o_setting")
      .where({
        key: REDIS_RATE_LIMIT_CUTOVER_SETTING_KEY,
        value: persisted.rawStateValue,
      })
      .update({ value: serializePersistedState(active) });
    if (Number(updated) !== 1) throw new CutoverCompareAndSwapConflict();
    return active;
  });
}

function assertPostgresRotationDatabase(database: Knex): void {
  if (!isPostgresClient(database)) {
    throw invalidInput("fingerprint rotation requires PostgreSQL");
  }
}

function rotatedState(
  state: PersistedRedisRateLimitCutoverState,
  fingerprint: string,
): PersistedRedisRateLimitCutoverState {
  return { ...state, contractFingerprint: fingerprint };
}

async function replacePersistedFingerprint(
  trx: Knex | Knex.Transaction,
  persisted: {
    state: PersistedRedisRateLimitCutoverState;
    rawStateValue: unknown;
    rawMarkerValue: unknown;
  },
  fingerprint: string,
): Promise<void> {
  const nextState = rotatedState(persisted.state, fingerprint);
  const stateUpdated = await trx("o_setting")
    .where({
      key: REDIS_RATE_LIMIT_CUTOVER_SETTING_KEY,
      value: persisted.rawStateValue,
    })
    .update({ value: serializePersistedState(nextState) });
  const markerUpdated = await trx("o_setting")
    .where({
      key: REDIS_RATE_LIMIT_CUTOVER_ARM_MARKER_SETTING_KEY,
      value: persisted.rawMarkerValue,
    })
    .update({ value: serializeArmMarker(armMarkerFromState(nextState)) });
  if (Number(stateUpdated) !== 1 || Number(markerUpdated) !== 1) {
    throw new CutoverCompareAndSwapConflict();
  }
}

/**
 * Rotate the immutable Redis runtime fingerprint only while the entire fleet
 * is drained for a transport cutover. The PostgreSQL advisory lock, two-row
 * CAS, and one-time receipt make this an audited maintenance mutation rather
 * than a general-purpose way to weaken the original latch.
 */
export async function rotateRedisRateLimitFingerprint(
  input: RotateRedisRateLimitFingerprintInput,
): Promise<RedisRateLimitFingerprintRotationReceipt> {
  assertPostgresRotationDatabase(input.database);
  assertOperationId(input.operationId);
  assertContractFingerprint(input.expectedFingerprint);
  assertContractFingerprint(input.nextFingerprint);
  assertContractFingerprint(input.authorizationSha256);
  assertRedisTimestamp(input.observedAtMs, "observedAtMs");
  assertRedisTimestamp(input.rollbackDeadlineMs, "rollbackDeadlineMs");
  if (input.expectedFingerprint === input.nextFingerprint) {
    throw invalidInput("nextFingerprint must differ from expectedFingerprint");
  }

  return withSerializedMutation(input.database, async (trx) => {
    const persisted = await readPersistedCutover(trx, true);
    if (!persisted) {
      throw new RedisRateLimitCutoverError(
        "redis_rate_limit_cutover_not_scheduled",
        "Redis rate-limit cutover has not been scheduled",
      );
    }
    const receiptRow = await readSettingRow(
      trx,
      true,
      REDIS_RATE_LIMIT_FINGERPRINT_ROTATION_RECEIPT_SETTING_KEY,
    );
    if (receiptRow) {
      const receipt = parseFingerprintRotationReceipt(receiptRow.value);
      if (
        receipt.operationId === input.operationId
        && receipt.state === "forward_applied"
        && receipt.previousFingerprint === input.expectedFingerprint
        && receipt.nextFingerprint === input.nextFingerprint
        && receipt.authorizationSha256 === input.authorizationSha256
        && receipt.rollbackDeadlineMs === input.rollbackDeadlineMs
        && persisted.state.contractFingerprint === input.nextFingerprint
      ) return receipt;
      throw new RedisRateLimitCutoverError(
        "redis_rate_limit_cutover_conflict",
        "Redis fingerprint rotation receipt is immutable",
      );
    }
    if (
      input.rollbackDeadlineMs <= input.observedAtMs
      || input.rollbackDeadlineMs - input.observedAtMs > MAX_FINGERPRINT_ROLLBACK_WINDOW_MS
    ) throw invalidInput("rollbackDeadlineMs is outside the supported window");
    if (persisted.state.contractFingerprint !== input.expectedFingerprint) {
      throw new RedisRateLimitCutoverError(
        "redis_rate_limit_cutover_conflict",
        "Redis fingerprint rotation does not match the current latch",
      );
    }
    const receipt: RedisRateLimitFingerprintRotationReceipt = {
      schemaVersion: REDIS_RATE_LIMIT_FINGERPRINT_ROTATION_SCHEMA_VERSION,
      operationId: input.operationId,
      state: "forward_applied",
      previousFingerprint: input.expectedFingerprint,
      nextFingerprint: input.nextFingerprint,
      authorizationSha256: input.authorizationSha256,
      rollbackAuthorizationSha256: null,
      appliedAtMs: input.observedAtMs,
      rollbackDeadlineMs: input.rollbackDeadlineMs,
      rolledBackAtMs: null,
    };
    await replacePersistedFingerprint(trx, persisted, input.nextFingerprint);
    await trx("o_setting").insert({
      key: REDIS_RATE_LIMIT_FINGERPRINT_ROTATION_RECEIPT_SETTING_KEY,
      value: serializeFingerprintRotationReceipt(receipt),
    });
    return receipt;
  });
}

/** Roll back exactly the preceding one-time rotation within its receipt window. */
export async function rollbackRedisRateLimitFingerprint(
  input: RollbackRedisRateLimitFingerprintInput,
): Promise<RedisRateLimitFingerprintRotationReceipt> {
  assertPostgresRotationDatabase(input.database);
  assertOperationId(input.operationId);
  assertContractFingerprint(input.expectedCurrentFingerprint);
  assertContractFingerprint(input.rollbackFingerprint);
  assertContractFingerprint(input.rollbackAuthorizationSha256);
  assertRedisTimestamp(input.observedAtMs, "observedAtMs");

  return withSerializedMutation(input.database, async (trx) => {
    const persisted = await readPersistedCutover(trx, true);
    if (!persisted) throw invalidState();
    const receiptRow = await readSettingRow(
      trx,
      true,
      REDIS_RATE_LIMIT_FINGERPRINT_ROTATION_RECEIPT_SETTING_KEY,
    );
    if (!receiptRow) throw invalidState();
    const receipt = parseFingerprintRotationReceipt(receiptRow.value);
    if (
      receipt.operationId !== input.operationId
      || receipt.nextFingerprint !== input.expectedCurrentFingerprint
      || receipt.previousFingerprint !== input.rollbackFingerprint
    ) {
      throw new RedisRateLimitCutoverError(
        "redis_rate_limit_cutover_conflict",
        "Redis fingerprint rollback does not match its receipt",
      );
    }
    if (receipt.state === "rollback_applied") {
      if (
        receipt.rollbackAuthorizationSha256 === input.rollbackAuthorizationSha256
        && persisted.state.contractFingerprint === input.rollbackFingerprint
      ) return receipt;
      throw new RedisRateLimitCutoverError(
        "redis_rate_limit_cutover_conflict",
        "Redis fingerprint rollback receipt is immutable",
      );
    }
    if (
      input.observedAtMs < receipt.appliedAtMs
      || input.observedAtMs > receipt.rollbackDeadlineMs
    ) {
      throw new RedisRateLimitCutoverError(
        "redis_rate_limit_cutover_rollback_expired",
        "Redis fingerprint rollback window has expired",
      );
    }
    if (persisted.state.contractFingerprint !== input.expectedCurrentFingerprint) {
      throw new RedisRateLimitCutoverError(
        "redis_rate_limit_cutover_conflict",
        "Redis fingerprint rollback does not match the current latch",
      );
    }
    const rolledBack: RedisRateLimitFingerprintRotationReceipt = {
      ...receipt,
      state: "rollback_applied",
      rollbackAuthorizationSha256: input.rollbackAuthorizationSha256,
      rolledBackAtMs: input.observedAtMs,
    };
    await replacePersistedFingerprint(trx, persisted, input.rollbackFingerprint);
    const receiptUpdated = await trx("o_setting")
      .where({
        key: REDIS_RATE_LIMIT_FINGERPRINT_ROTATION_RECEIPT_SETTING_KEY,
        value: receiptRow.value,
      })
      .update({ value: serializeFingerprintRotationReceipt(rolledBack) });
    if (Number(receiptUpdated) !== 1) throw new CutoverCompareAndSwapConflict();
    return rolledBack;
  });
}
