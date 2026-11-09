import crypto from "node:crypto";
import type { Knex } from "knex";

import { quoteSqlIdentifier } from "@/lib/dbDialect";
import {
  DELETION_AUDIT_CHUNK_TABLE,
  DELETION_CHECKPOINT_TABLE,
  DELETION_MANIFEST_CHUNK_TABLE,
} from "@/lib/migrations/deletionChunkStore";

export {
  DELETION_AUDIT_CHUNK_TABLE,
  DELETION_CHECKPOINT_TABLE,
  DELETION_MANIFEST_CHUNK_TABLE,
};

const DELETION_OPERATION_TABLE = "o_deletion_operation";
const MAX_CHUNK_COUNT = 500;
const MAX_CURSOR_JSON_BYTES = 65_536;

export const DELETION_CHUNK_PHASES = [
  "source_scan",
  "storage_scan",
  "dispatch",
  "verify",
  "db_finalize",
  "completed",
] as const;

export type DeletionChunkPhase = typeof DELETION_CHUNK_PHASES[number];
export type DeletionManifestChunkPhase = Extract<
  DeletionChunkPhase,
  "source_scan" | "storage_scan" | "verify"
>;

export type DeletionChunkStoreErrorCode =
  | "DELETION_CHUNK_TRANSACTION_REQUIRED"
  | "DELETION_CHUNK_INPUT_INVALID"
  | "DELETION_CHUNK_LEASE_LOST"
  | "DELETION_CHUNK_CURSOR_LOST"
  | "DELETION_CHUNK_ORDINAL_CONFLICT"
  | "DELETION_CHUNK_CONTENT_CONFLICT"
  | "DELETION_CHUNK_ROW_INVALID";

export class DeletionChunkStoreError extends Error {
  readonly code: DeletionChunkStoreErrorCode;
  readonly status: number;

  constructor(
    message: string,
    code: DeletionChunkStoreErrorCode,
    status: number,
  ) {
    super(message);
    this.name = "DeletionChunkStoreError";
    this.code = code;
    this.status = status;
  }
}

export interface DeletionChunkLease {
  operationId: string;
  owner: string;
  fence: number;
  now: number;
}

export interface DeletionStorageMarker {
  keyMarker: string;
  versionIdMarker: string;
}

export interface DeletionAuditCursorInput {
  tableOrdinal: number;
  tableName: string;
  cursor: unknown;
}

export interface DeletionChunkCheckpoint {
  operationId: string;
  leaseOwner: string;
  leaseFence: number;
  phase: DeletionChunkPhase;
  epoch: number;
  providerId: string;
  providerFingerprint: string;
  bucket: string;
  objectPrefix: string;
  keyMarker: string | null;
  versionIdMarker: string | null;
  cursorHash: string;
  nextManifestChunkOrdinal: number;
  manifestChainHash: string;
  manifestItemCount: number;
  auditTableOrdinal: number;
  auditTableName: string | null;
  auditCursorJson: string | null;
  auditCursorHash: string | null;
  nextAuditChunkOrdinal: number;
  auditChainHash: string;
  auditRowCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface DeletionManifestChunk {
  operationId: string;
  epoch: number;
  phase: DeletionManifestChunkPhase;
  ordinal: number;
  providerId: string;
  providerFingerprint: string;
  bucket: string;
  objectPrefix: string;
  inputKeyMarker: string | null;
  inputVersionIdMarker: string | null;
  outputKeyMarker: string | null;
  outputVersionIdMarker: string | null;
  inputCursorHash: string;
  outputCursorHash: string;
  itemCount: number;
  contentHash: string;
  previousChainHash: string;
  chunkHash: string;
  chainHash: string;
  createdAt: number;
}

export interface DeletionAuditChunk {
  operationId: string;
  epoch: number;
  tableOrdinal: number;
  tableName: string;
  ordinal: number;
  inputAuditCursorJson: string;
  inputAuditCursorHash: string;
  outputAuditCursorJson: string;
  outputAuditCursorHash: string;
  inputCursorHash: string;
  outputCursorHash: string;
  rowCount: number;
  rowsHash: string;
  previousChainHash: string;
  chunkHash: string;
  chainHash: string;
  createdAt: number;
}

export interface InitializeDeletionChunkCheckpointInput {
  lease: DeletionChunkLease;
  phase: Exclude<DeletionChunkPhase, "completed">;
  epoch: number;
  providerId: string;
  providerFingerprint: string;
  bucket: string;
  objectPrefix: string;
  marker?: DeletionStorageMarker | null;
  audit?: DeletionAuditCursorInput;
}

export interface AdvanceDeletionChunkCheckpointInput {
  lease: DeletionChunkLease;
  expectedPhase: Exclude<DeletionChunkPhase, "completed">;
  expectedEpoch: number;
  expectedCursorHash: string;
  nextPhase: Exclude<DeletionChunkPhase, "source_scan">;
  nextMarker?: DeletionStorageMarker | null;
  audit?: DeletionAuditCursorInput;
}

export interface AdvanceDeletionAuditTableInput {
  lease: DeletionChunkLease;
  expectedEpoch: number;
  expectedCursorHash: string;
  expectedTableOrdinal: number;
  expectedTableName: string;
  nextTableName: string;
  nextCursor: unknown;
}

export interface AppendDeletionManifestChunkInput {
  lease: DeletionChunkLease;
  phase: DeletionManifestChunkPhase;
  epoch: number;
  ordinal: number;
  inputCursorHash: string;
  inputMarker: DeletionStorageMarker | null;
  outputMarker: DeletionStorageMarker | null;
  itemCount: number;
  contentHash: string;
}

export interface AppendDeletionAuditChunkInput {
  lease: DeletionChunkLease;
  epoch: number;
  tableOrdinal: number;
  tableName: string;
  ordinal: number;
  inputCursorHash: string;
  inputAuditCursor: unknown;
  outputAuditCursor: unknown;
  rowCount: number;
  rowsHash: string;
}

export interface AppendDeletionManifestChunkResult {
  checkpoint: DeletionChunkCheckpoint;
  chunk: DeletionManifestChunk;
  idempotent: boolean;
}

export interface AppendDeletionAuditChunkResult {
  checkpoint: DeletionChunkCheckpoint;
  chunk: DeletionAuditChunk;
  idempotent: boolean;
}

export type BeforeDeletionManifestCheckpointAdvance = (
  transaction: Knex.Transaction,
  context: Readonly<{
    currentCheckpoint: DeletionChunkCheckpoint;
    nextCheckpoint: DeletionChunkCheckpoint;
    chunk: DeletionManifestChunk;
  }>,
) => Promise<void>;

type RawRow = Record<string, unknown>;

type NormalizedLease = DeletionChunkLease;

interface NormalizedAuditCursor {
  tableOrdinal: number;
  tableName: string;
  cursorJson: string;
  cursorHash: string;
}

function fail(
  message: string,
  code: DeletionChunkStoreErrorCode,
  status: number,
): never {
  throw new DeletionChunkStoreError(message, code, status);
}

function inputInvalid(message: string): never {
  fail(message, "DELETION_CHUNK_INPUT_INVALID", 400);
}

function leaseLost(): never {
  fail(
    "删除任务租约已过期、转移或 fencing token 不匹配",
    "DELETION_CHUNK_LEASE_LOST",
    409,
  );
}

function cursorLost(): never {
  fail(
    "删除 checkpoint 的 phase、epoch 或 cursor 已被推进",
    "DELETION_CHUNK_CURSOR_LOST",
    409,
  );
}

function ordinalConflict(): never {
  fail(
    "删除 chunk 序号不连续",
    "DELETION_CHUNK_ORDINAL_CONFLICT",
    409,
  );
}

function contentConflict(): never {
  fail(
    "删除 chunk 序号或内容寻址记录发生冲突",
    "DELETION_CHUNK_CONTENT_CONFLICT",
    409,
  );
}

function rowInvalid(): never {
  fail(
    "删除 chunk 持久化证据无效",
    "DELETION_CHUNK_ROW_INVALID",
    500,
  );
}

function assertCallerTransaction(transaction: Knex.Transaction): void {
  if (!(transaction as unknown as { isTransaction?: boolean }).isTransaction) {
    fail(
      "删除 chunk store 必须使用调用方提供的 transaction",
      "DELETION_CHUNK_TRANSACTION_REQUIRED",
      500,
    );
  }
}

function stableJson(value: unknown): string {
  const seen = new Set<object>();
  const normalize = (entry: unknown, depth: number): unknown => {
    if (depth > 16) inputInvalid("audit cursor 嵌套层级过深");
    if (
      entry === null
      || typeof entry === "string"
      || typeof entry === "boolean"
    ) {
      return entry;
    }
    if (typeof entry === "number") {
      if (!Number.isFinite(entry)) inputInvalid("audit cursor 数字无效");
      return entry;
    }
    if (Array.isArray(entry)) {
      if (entry.length > 256) inputInvalid("audit cursor 数组过大");
      if (seen.has(entry)) inputInvalid("audit cursor 不能包含循环引用");
      seen.add(entry);
      const result = entry.map((item) => normalize(item, depth + 1));
      seen.delete(entry);
      return result;
    }
    if (entry && typeof entry === "object") {
      if (seen.has(entry)) inputInvalid("audit cursor 不能包含循环引用");
      const prototype = Object.getPrototypeOf(entry);
      if (prototype !== Object.prototype && prototype !== null) {
        inputInvalid("audit cursor 必须是 JSON 值");
      }
      const keys = Object.keys(entry as Record<string, unknown>).sort();
      if (keys.length > 256) inputInvalid("audit cursor 字段过多");
      seen.add(entry);
      const result: Record<string, unknown> = {};
      for (const key of keys) {
        const item = (entry as Record<string, unknown>)[key];
        if (
          item === undefined
          || typeof item === "bigint"
          || typeof item === "function"
          || typeof item === "symbol"
        ) {
          inputInvalid("audit cursor 必须是 JSON 值");
        }
        result[key] = normalize(item, depth + 1);
      }
      seen.delete(entry);
      return result;
    }
    inputInvalid("audit cursor 必须是 JSON 值");
  };
  const serialized = JSON.stringify(normalize(value, 0));
  if (
    typeof serialized !== "string"
    || Buffer.byteLength(serialized, "utf8") > MAX_CURSOR_JSON_BYTES
  ) {
    inputInvalid("audit cursor 超过持久化上限");
  }
  return serialized;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function inputText(value: unknown, name: string, maximum: number): string {
  if (
    typeof value !== "string"
    || !value
    || value !== value.trim()
    || value.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    inputInvalid(`${name} 无效`);
  }
  return value;
}

function persistedText(value: unknown, maximum: number): string {
  if (
    typeof value !== "string"
    || !value
    || value !== value.trim()
    || value.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    rowInvalid();
  }
  return value;
}

function inputHash(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    inputInvalid(`${name} 必须是小写 SHA-256`);
  }
  return value;
}

function persistedHash(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    rowInvalid();
  }
  return value;
}

function inputInteger(
  value: unknown,
  name: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > maximum) {
    inputInvalid(`${name} 必须是有效非负整数`);
  }
  return number;
}

function persistedInteger(
  value: unknown,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > maximum) {
    rowInvalid();
  }
  return number;
}

function checkedAdd(
  left: number,
  right: number,
  invalid: () => never,
): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) invalid();
  return result;
}

function inputPhase(value: unknown): DeletionChunkPhase {
  if (
    typeof value !== "string"
    || !(DELETION_CHUNK_PHASES as readonly string[]).includes(value)
  ) {
    inputInvalid("phase 无效");
  }
  return value as DeletionChunkPhase;
}

function persistedPhase(value: unknown): DeletionChunkPhase {
  if (
    typeof value !== "string"
    || !(DELETION_CHUNK_PHASES as readonly string[]).includes(value)
  ) {
    rowInvalid();
  }
  return value as DeletionChunkPhase;
}

function inputManifestPhase(value: unknown): DeletionManifestChunkPhase {
  const phase = inputPhase(value);
  if (!["source_scan", "storage_scan", "verify"].includes(phase)) {
    inputInvalid("manifest chunk phase 无效");
  }
  return phase as DeletionManifestChunkPhase;
}

function persistedManifestPhase(
  value: unknown,
): DeletionManifestChunkPhase {
  const phase = persistedPhase(value);
  if (!["source_scan", "storage_scan", "verify"].includes(phase)) {
    rowInvalid();
  }
  return phase as DeletionManifestChunkPhase;
}

function normalizeMarker(
  marker: DeletionStorageMarker | null | undefined,
): DeletionStorageMarker | null {
  if (marker === null || marker === undefined) return null;
  if (!marker || typeof marker !== "object") {
    inputInvalid("storage marker 无效");
  }
  return {
    keyMarker: inputText(marker.keyMarker, "keyMarker", 4_096),
    versionIdMarker: inputText(
      marker.versionIdMarker,
      "versionIdMarker",
      4_096,
    ),
  };
}

function persistedMarker(
  keyMarker: unknown,
  versionIdMarker: unknown,
): DeletionStorageMarker | null {
  if (
    (keyMarker === null || keyMarker === undefined)
    && (versionIdMarker === null || versionIdMarker === undefined)
  ) {
    return null;
  }
  if (
    keyMarker === null
    || keyMarker === undefined
    || versionIdMarker === null
    || versionIdMarker === undefined
  ) {
    rowInvalid();
  }
  return {
    keyMarker: persistedText(keyMarker, 4_096),
    versionIdMarker: persistedText(versionIdMarker, 4_096),
  };
}

function markerMatches(
  marker: DeletionStorageMarker | null,
  keyMarker: string | null,
  versionIdMarker: string | null,
): boolean {
  return (marker?.keyMarker ?? null) === keyMarker
    && (marker?.versionIdMarker ?? null) === versionIdMarker;
}

function normalizeLease(lease: DeletionChunkLease): NormalizedLease {
  if (!lease || typeof lease !== "object") inputInvalid("lease 无效");
  return {
    operationId: inputText(lease.operationId, "operationId", 255),
    owner: inputText(lease.owner, "lease owner", 255),
    fence: inputInteger(lease.fence, "lease fence"),
    now: inputInteger(lease.now, "lease now"),
  };
}

function normalizeAuditCursor(
  input: DeletionAuditCursorInput,
): NormalizedAuditCursor {
  if (!input || typeof input !== "object") {
    inputInvalid("audit cursor 无效");
  }
  const cursorJson = stableJson(input.cursor);
  return {
    tableOrdinal: inputInteger(input.tableOrdinal, "audit table ordinal"),
    tableName: inputText(input.tableName, "audit table name", 128),
    cursorJson,
    cursorHash: sha256(cursorJson),
  };
}

function parsePersistedCursor(
  cursorJson: unknown,
  cursorHash: unknown,
): { cursorJson: string; cursorHash: string } {
  if (
    typeof cursorJson !== "string"
    || Buffer.byteLength(cursorJson, "utf8") > MAX_CURSOR_JSON_BYTES
  ) {
    rowInvalid();
  }
  const normalizedHash = persistedHash(cursorHash);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cursorJson);
  } catch {
    rowInvalid();
  }
  let canonical: string;
  try {
    canonical = stableJson(parsed);
  } catch {
    rowInvalid();
  }
  if (canonical !== cursorJson || sha256(cursorJson) !== normalizedHash) {
    rowInvalid();
  }
  return { cursorJson, cursorHash: normalizedHash };
}

function checkpointCursorHash(
  checkpoint: Omit<
    DeletionChunkCheckpoint,
    "cursorHash" | "createdAt" | "updatedAt"
  >,
): string {
  return sha256(JSON.stringify([
    "deletion-checkpoint-cursor.v1",
    checkpoint.operationId,
    checkpoint.leaseOwner,
    checkpoint.leaseFence,
    checkpoint.phase,
    checkpoint.epoch,
    checkpoint.providerId,
    checkpoint.providerFingerprint,
    checkpoint.bucket,
    checkpoint.objectPrefix,
    checkpoint.keyMarker,
    checkpoint.versionIdMarker,
    checkpoint.nextManifestChunkOrdinal,
    checkpoint.manifestChainHash,
    checkpoint.manifestItemCount,
    checkpoint.auditTableOrdinal,
    checkpoint.auditTableName,
    checkpoint.auditCursorHash,
    checkpoint.nextAuditChunkOrdinal,
    checkpoint.auditChainHash,
    checkpoint.auditRowCount,
  ]));
}

export function deletionManifestChainSeed(input: {
  operationId: string;
  epoch: number;
  providerFingerprint: string;
  bucket: string;
  objectPrefix: string;
}): string {
  return sha256(JSON.stringify([
    "deletion-manifest-chain-seed.v1",
    input.operationId,
    input.epoch,
    input.providerFingerprint,
    input.bucket,
    input.objectPrefix,
  ]));
}

export function deletionAuditChainSeed(input: {
  operationId: string;
  epoch: number;
}): string {
  return sha256(JSON.stringify([
    "deletion-audit-chain-seed.v1",
    input.operationId,
    input.epoch,
  ]));
}

function manifestChunkHash(
  chunk: Omit<
    DeletionManifestChunk,
    "chunkHash" | "chainHash" | "createdAt"
  >,
): string {
  return sha256(JSON.stringify([
    "deletion-manifest-chunk.v1",
    chunk.operationId,
    chunk.epoch,
    chunk.phase,
    chunk.ordinal,
    chunk.providerId,
    chunk.providerFingerprint,
    chunk.bucket,
    chunk.objectPrefix,
    chunk.inputKeyMarker,
    chunk.inputVersionIdMarker,
    chunk.outputKeyMarker,
    chunk.outputVersionIdMarker,
    chunk.inputCursorHash,
    chunk.itemCount,
    chunk.contentHash,
    chunk.previousChainHash,
  ]));
}

function manifestChainHash(
  previousChainHash: string,
  chunkHash: string,
  itemCount: number,
): string {
  return sha256(JSON.stringify([
    "deletion-manifest-chain.v1",
    previousChainHash,
    chunkHash,
    itemCount,
  ]));
}

function auditChunkHash(
  chunk: Omit<
    DeletionAuditChunk,
    "chunkHash" | "chainHash" | "createdAt"
  >,
): string {
  return sha256(JSON.stringify([
    "deletion-audit-chunk.v1",
    chunk.operationId,
    chunk.epoch,
    chunk.tableOrdinal,
    chunk.tableName,
    chunk.ordinal,
    chunk.inputAuditCursorJson,
    chunk.inputAuditCursorHash,
    chunk.outputAuditCursorJson,
    chunk.outputAuditCursorHash,
    chunk.inputCursorHash,
    chunk.rowCount,
    chunk.rowsHash,
    chunk.previousChainHash,
  ]));
}

function auditChainHash(
  previousChainHash: string,
  chunkHash: string,
  rowCount: number,
): string {
  return sha256(JSON.stringify([
    "deletion-audit-chain.v1",
    previousChainHash,
    chunkHash,
    rowCount,
  ]));
}

function mapCheckpoint(row: RawRow): DeletionChunkCheckpoint {
  const phase = persistedPhase(row.phase);
  const marker = persistedMarker(row.keyMarker, row.versionIdMarker);
  const rawAuditFields = [
    row.auditTableName,
    row.auditCursorJson,
    row.auditCursorHash,
  ];
  const hasNoAudit = rawAuditFields.every(
    (entry) => entry === null || entry === undefined,
  );
  const hasFullAudit = rawAuditFields.every(
    (entry) => entry !== null && entry !== undefined,
  );
  if (!hasNoAudit && !hasFullAudit) rowInvalid();
  let auditTableName: string | null = null;
  let auditCursorJson: string | null = null;
  let auditCursorHash: string | null = null;
  if (hasFullAudit) {
    if (!["db_finalize", "completed"].includes(phase)) rowInvalid();
    auditTableName = persistedText(row.auditTableName, 128);
    const cursor = parsePersistedCursor(
      row.auditCursorJson,
      row.auditCursorHash,
    );
    auditCursorJson = cursor.cursorJson;
    auditCursorHash = cursor.cursorHash;
  }
  const checkpointWithoutCursor = {
    operationId: persistedText(row.operationId, 255),
    leaseOwner: persistedText(row.leaseOwner, 255),
    leaseFence: persistedInteger(row.leaseFence),
    phase,
    epoch: persistedInteger(row.epoch),
    providerId: persistedText(row.providerId, 255),
    providerFingerprint: persistedHash(row.providerFingerprint),
    bucket: persistedText(row.bucket, 255),
    objectPrefix: persistedText(row.objectPrefix, 4_096),
    keyMarker: marker?.keyMarker ?? null,
    versionIdMarker: marker?.versionIdMarker ?? null,
    nextManifestChunkOrdinal: persistedInteger(
      row.nextManifestChunkOrdinal,
    ),
    manifestChainHash: persistedHash(row.manifestChainHash),
    manifestItemCount: persistedInteger(row.manifestItemCount),
    auditTableOrdinal: persistedInteger(row.auditTableOrdinal),
    auditTableName,
    auditCursorJson,
    auditCursorHash,
    nextAuditChunkOrdinal: persistedInteger(row.nextAuditChunkOrdinal),
    auditChainHash: persistedHash(row.auditChainHash),
    auditRowCount: persistedInteger(row.auditRowCount),
  };
  const createdAt = persistedInteger(row.createdAt);
  const updatedAt = persistedInteger(row.updatedAt);
  const cursorHash = persistedHash(row.cursorHash);
  if (
    updatedAt < createdAt
    || checkpointCursorHash(checkpointWithoutCursor) !== cursorHash
  ) {
    rowInvalid();
  }
  return {
    ...checkpointWithoutCursor,
    cursorHash,
    createdAt,
    updatedAt,
  };
}

function mapManifestChunk(row: RawRow): DeletionManifestChunk {
  const inputMarker = persistedMarker(
    row.inputKeyMarker,
    row.inputVersionIdMarker,
  );
  const outputMarker = persistedMarker(
    row.outputKeyMarker,
    row.outputVersionIdMarker,
  );
  const chunkWithoutHashes = {
    operationId: persistedText(row.operationId, 255),
    epoch: persistedInteger(row.epoch),
    phase: persistedManifestPhase(row.phase),
    ordinal: persistedInteger(row.ordinal),
    providerId: persistedText(row.providerId, 255),
    providerFingerprint: persistedHash(row.providerFingerprint),
    bucket: persistedText(row.bucket, 255),
    objectPrefix: persistedText(row.objectPrefix, 4_096),
    inputKeyMarker: inputMarker?.keyMarker ?? null,
    inputVersionIdMarker: inputMarker?.versionIdMarker ?? null,
    outputKeyMarker: outputMarker?.keyMarker ?? null,
    outputVersionIdMarker: outputMarker?.versionIdMarker ?? null,
    inputCursorHash: persistedHash(row.inputCursorHash),
    outputCursorHash: persistedHash(row.outputCursorHash),
    itemCount: persistedInteger(row.itemCount, MAX_CHUNK_COUNT),
    contentHash: persistedHash(row.contentHash),
    previousChainHash: persistedHash(row.previousChainHash),
  };
  const chunkHash = persistedHash(row.chunkHash);
  const chainHash = persistedHash(row.chainHash);
  if (
    manifestChunkHash(chunkWithoutHashes) !== chunkHash
    || manifestChainHash(
      chunkWithoutHashes.previousChainHash,
      chunkHash,
      chunkWithoutHashes.itemCount,
    ) !== chainHash
  ) {
    rowInvalid();
  }
  return {
    ...chunkWithoutHashes,
    chunkHash,
    chainHash,
    createdAt: persistedInteger(row.createdAt),
  };
}

function mapAuditChunk(row: RawRow): DeletionAuditChunk {
  const inputAuditCursor = parsePersistedCursor(
    row.inputAuditCursorJson,
    row.inputAuditCursorHash,
  );
  const outputAuditCursor = parsePersistedCursor(
    row.outputAuditCursorJson,
    row.outputAuditCursorHash,
  );
  const chunkWithoutHashes = {
    operationId: persistedText(row.operationId, 255),
    epoch: persistedInteger(row.epoch),
    tableOrdinal: persistedInteger(row.tableOrdinal),
    tableName: persistedText(row.tableName, 128),
    ordinal: persistedInteger(row.ordinal),
    inputAuditCursorJson: inputAuditCursor.cursorJson,
    inputAuditCursorHash: inputAuditCursor.cursorHash,
    outputAuditCursorJson: outputAuditCursor.cursorJson,
    outputAuditCursorHash: outputAuditCursor.cursorHash,
    inputCursorHash: persistedHash(row.inputCursorHash),
    outputCursorHash: persistedHash(row.outputCursorHash),
    rowCount: persistedInteger(row.rowCount, MAX_CHUNK_COUNT),
    rowsHash: persistedHash(row.rowsHash),
    previousChainHash: persistedHash(row.previousChainHash),
  };
  const chunkHash = persistedHash(row.chunkHash);
  const chainHash = persistedHash(row.chainHash);
  if (
    auditChunkHash(chunkWithoutHashes) !== chunkHash
    || auditChainHash(
      chunkWithoutHashes.previousChainHash,
      chunkHash,
      chunkWithoutHashes.rowCount,
    ) !== chainHash
  ) {
    rowInvalid();
  }
  return {
    ...chunkWithoutHashes,
    chunkHash,
    chainHash,
    createdAt: persistedInteger(row.createdAt),
  };
}

async function assertActiveLease(
  transaction: Knex.Transaction,
  lease: NormalizedLease,
): Promise<void> {
  const row = await transaction(DELETION_OPERATION_TABLE)
    .where({ id: lease.operationId })
    .select(
      "status",
      "coordinatorLeaseOwner",
      "coordinatorLeaseExpiresAt",
      "coordinatorFence",
    )
    .first() as RawRow | undefined;
  if (
    !row
    || !["preparing", "deleting"].includes(String(row.status || ""))
    || row.coordinatorLeaseOwner !== lease.owner
    || Number(row.coordinatorFence) !== lease.fence
    || !Number.isSafeInteger(Number(row.coordinatorLeaseExpiresAt))
    || Number(row.coordinatorLeaseExpiresAt) <= lease.now
  ) {
    leaseLost();
  }
}

async function readCheckpoint(
  transaction: Knex.Transaction,
  operationId: string,
): Promise<DeletionChunkCheckpoint | null> {
  const row = await transaction(DELETION_CHECKPOINT_TABLE)
    .where({ operationId })
    .first() as RawRow | undefined;
  return row ? mapCheckpoint(row) : null;
}

export async function readDeletionChunkCheckpointInTransaction(
  transaction: Knex.Transaction,
  operationId: string,
): Promise<DeletionChunkCheckpoint | null> {
  assertCallerTransaction(transaction);
  return readCheckpoint(
    transaction,
    inputText(operationId, "operationId", 255),
  );
}

function sameInitialCheckpoint(
  checkpoint: DeletionChunkCheckpoint,
  expected: DeletionChunkCheckpoint,
): boolean {
  return checkpoint.operationId === expected.operationId
    && checkpoint.leaseOwner === expected.leaseOwner
    && checkpoint.leaseFence === expected.leaseFence
    && checkpoint.phase === expected.phase
    && checkpoint.epoch === expected.epoch
    && checkpoint.providerId === expected.providerId
    && checkpoint.providerFingerprint === expected.providerFingerprint
    && checkpoint.bucket === expected.bucket
    && checkpoint.objectPrefix === expected.objectPrefix
    && checkpoint.keyMarker === expected.keyMarker
    && checkpoint.versionIdMarker === expected.versionIdMarker
    && checkpoint.cursorHash === expected.cursorHash
    && checkpoint.nextManifestChunkOrdinal === 0
    && checkpoint.manifestChainHash === expected.manifestChainHash
    && checkpoint.manifestItemCount === 0
    && checkpoint.auditTableOrdinal === expected.auditTableOrdinal
    && checkpoint.auditTableName === expected.auditTableName
    && checkpoint.auditCursorJson === expected.auditCursorJson
    && checkpoint.auditCursorHash === expected.auditCursorHash
    && checkpoint.nextAuditChunkOrdinal === 0
    && checkpoint.auditChainHash === expected.auditChainHash
    && checkpoint.auditRowCount === 0;
}

export async function initializeDeletionChunkCheckpointInTransaction(
  transaction: Knex.Transaction,
  input: InitializeDeletionChunkCheckpointInput,
): Promise<{ checkpoint: DeletionChunkCheckpoint; idempotent: boolean }> {
  assertCallerTransaction(transaction);
  const lease = normalizeLease(input.lease);
  const phase = inputPhase(input.phase);
  if (phase === "completed") inputInvalid("不能初始化 completed checkpoint");
  const epoch = inputInteger(input.epoch, "epoch");
  const providerId = inputText(input.providerId, "providerId", 255);
  const providerFingerprint = inputHash(
    input.providerFingerprint,
    "providerFingerprint",
  );
  const bucket = inputText(input.bucket, "bucket", 255);
  const objectPrefix = inputText(input.objectPrefix, "objectPrefix", 4_096);
  const marker = normalizeMarker(input.marker);
  if (marker && !["source_scan", "storage_scan", "verify"].includes(phase)) {
    inputInvalid("当前 phase 不允许 storage marker");
  }
  const audit = input.audit ? normalizeAuditCursor(input.audit) : null;
  if ((phase === "db_finalize") !== Boolean(audit)) {
    inputInvalid("db_finalize 初始化必须且只能携带 audit cursor");
  }
  const base = {
    operationId: lease.operationId,
    leaseOwner: lease.owner,
    leaseFence: lease.fence,
    phase,
    epoch,
    providerId,
    providerFingerprint,
    bucket,
    objectPrefix,
    keyMarker: marker?.keyMarker ?? null,
    versionIdMarker: marker?.versionIdMarker ?? null,
    nextManifestChunkOrdinal: 0,
    manifestChainHash: deletionManifestChainSeed({
      operationId: lease.operationId,
      epoch,
      providerFingerprint,
      bucket,
      objectPrefix,
    }),
    manifestItemCount: 0,
    auditTableOrdinal: audit?.tableOrdinal ?? 0,
    auditTableName: audit?.tableName ?? null,
    auditCursorJson: audit?.cursorJson ?? null,
    auditCursorHash: audit?.cursorHash ?? null,
    nextAuditChunkOrdinal: 0,
    auditChainHash: deletionAuditChainSeed({
      operationId: lease.operationId,
      epoch,
    }),
    auditRowCount: 0,
  };
  const expected: DeletionChunkCheckpoint = {
    ...base,
    cursorHash: checkpointCursorHash(base),
    createdAt: lease.now,
    updatedAt: lease.now,
  };

  return transaction.transaction(async (savepoint) => {
    await assertActiveLease(savepoint, lease);
    const existing = await readCheckpoint(savepoint, lease.operationId);
    if (existing) {
      if (!sameInitialCheckpoint(existing, expected)) contentConflict();
      return { checkpoint: existing, idempotent: true };
    }
    await savepoint(DELETION_CHECKPOINT_TABLE)
      .insert(expected)
      .onConflict("operationId")
      .ignore();
    const checkpoint = await readCheckpoint(savepoint, lease.operationId);
    if (!checkpoint || !sameInitialCheckpoint(checkpoint, expected)) {
      contentConflict();
    }
    return { checkpoint, idempotent: false };
  });
}

function activeLeaseExistsQuery(
  transaction: Knex.Transaction,
  lease: NormalizedLease,
): Knex.QueryBuilder {
  const checkpointTable = quoteSqlIdentifier(DELETION_CHECKPOINT_TABLE);
  return transaction
    .select(transaction.raw("1"))
    .from({ operation: DELETION_OPERATION_TABLE })
    .whereRaw(
      `"operation"."id" = ${checkpointTable}."operationId"`,
    )
    .where("operation.coordinatorLeaseOwner", lease.owner)
    .where("operation.coordinatorFence", lease.fence)
    .where("operation.coordinatorLeaseExpiresAt", ">", lease.now)
    .whereIn("operation.status", ["preparing", "deleting"]);
}

async function casCheckpoint(
  transaction: Knex.Transaction,
  lease: NormalizedLease,
  expected: {
    phase: DeletionChunkPhase;
    epoch: number;
    cursorHash: string;
  },
  next: DeletionChunkCheckpoint,
): Promise<DeletionChunkCheckpoint> {
  const patch = {
    leaseOwner: next.leaseOwner,
    leaseFence: next.leaseFence,
    phase: next.phase,
    keyMarker: next.keyMarker,
    versionIdMarker: next.versionIdMarker,
    cursorHash: next.cursorHash,
    nextManifestChunkOrdinal: next.nextManifestChunkOrdinal,
    manifestChainHash: next.manifestChainHash,
    manifestItemCount: next.manifestItemCount,
    auditTableOrdinal: next.auditTableOrdinal,
    auditTableName: next.auditTableName,
    auditCursorJson: next.auditCursorJson,
    auditCursorHash: next.auditCursorHash,
    nextAuditChunkOrdinal: next.nextAuditChunkOrdinal,
    auditChainHash: next.auditChainHash,
    auditRowCount: next.auditRowCount,
    updatedAt: next.updatedAt,
  };
  const affected = await transaction(DELETION_CHECKPOINT_TABLE)
    .where({
      operationId: lease.operationId,
      phase: expected.phase,
      epoch: expected.epoch,
      cursorHash: expected.cursorHash,
    })
    .whereExists(activeLeaseExistsQuery(transaction, lease))
    .update(patch);
  if (Number(affected) !== 1) {
    await assertActiveLease(transaction, lease);
    cursorLost();
  }
  const checkpoint = await readCheckpoint(transaction, lease.operationId);
  if (!checkpoint || checkpoint.cursorHash !== next.cursorHash) rowInvalid();
  return checkpoint;
}

const NEXT_PHASE: Readonly<
  Record<Exclude<DeletionChunkPhase, "completed">, DeletionChunkPhase>
> = {
  source_scan: "storage_scan",
  storage_scan: "dispatch",
  dispatch: "verify",
  verify: "db_finalize",
  db_finalize: "completed",
};

export async function advanceDeletionChunkCheckpointInTransaction(
  transaction: Knex.Transaction,
  input: AdvanceDeletionChunkCheckpointInput,
): Promise<DeletionChunkCheckpoint> {
  assertCallerTransaction(transaction);
  const lease = normalizeLease(input.lease);
  const expectedPhase = inputPhase(input.expectedPhase);
  const nextPhase = inputPhase(input.nextPhase);
  if (
    expectedPhase === "completed"
    || nextPhase === "source_scan"
    || NEXT_PHASE[expectedPhase] !== nextPhase
  ) {
    inputInvalid("checkpoint phase 跳转无效");
  }
  const expectedEpoch = inputInteger(input.expectedEpoch, "expected epoch");
  const expectedCursorHash = inputHash(
    input.expectedCursorHash,
    "expected cursorHash",
  );
  const nextMarker = normalizeMarker(input.nextMarker);
  if (
    nextMarker
    && !["source_scan", "storage_scan", "verify"].includes(nextPhase)
  ) {
    inputInvalid("目标 phase 不允许 storage marker");
  }
  const audit = input.audit ? normalizeAuditCursor(input.audit) : null;
  if ((nextPhase === "db_finalize") !== Boolean(audit)) {
    inputInvalid("进入 db_finalize 必须且只能提供首个 audit cursor");
  }

  const current = await readCheckpoint(transaction, lease.operationId);
  if (
    !current
    || current.phase !== expectedPhase
    || current.epoch !== expectedEpoch
    || current.cursorHash !== expectedCursorHash
  ) {
    await assertActiveLease(transaction, lease);
    cursorLost();
  }
  if (current.keyMarker !== null || current.versionIdMarker !== null) {
    inputInvalid("storage scan 尚有未消费的双 marker");
  }
  const base = {
    ...current,
    leaseOwner: lease.owner,
    leaseFence: lease.fence,
    phase: nextPhase,
    keyMarker: nextMarker?.keyMarker ?? null,
    versionIdMarker: nextMarker?.versionIdMarker ?? null,
    auditTableOrdinal: audit?.tableOrdinal ?? current.auditTableOrdinal,
    auditTableName: audit?.tableName ?? current.auditTableName,
    auditCursorJson: audit?.cursorJson ?? current.auditCursorJson,
    auditCursorHash: audit?.cursorHash ?? current.auditCursorHash,
    updatedAt: Math.max(current.updatedAt, lease.now),
  };
  const {
    cursorHash: _cursorHash,
    createdAt,
    updatedAt,
    ...cursorInput
  } = base;
  const next: DeletionChunkCheckpoint = {
    ...cursorInput,
    cursorHash: checkpointCursorHash(cursorInput),
    createdAt,
    updatedAt,
  };
  return casCheckpoint(transaction, lease, {
    phase: expectedPhase,
    epoch: expectedEpoch,
    cursorHash: expectedCursorHash,
  }, next);
}

export async function advanceDeletionAuditTableInTransaction(
  transaction: Knex.Transaction,
  input: AdvanceDeletionAuditTableInput,
): Promise<DeletionChunkCheckpoint> {
  assertCallerTransaction(transaction);
  const lease = normalizeLease(input.lease);
  const expectedEpoch = inputInteger(input.expectedEpoch, "expected epoch");
  const expectedCursorHash = inputHash(
    input.expectedCursorHash,
    "expected cursorHash",
  );
  const expectedTableOrdinal = inputInteger(
    input.expectedTableOrdinal,
    "expected audit table ordinal",
  );
  const expectedTableName = inputText(
    input.expectedTableName,
    "expected audit table name",
    128,
  );
  const nextTableOrdinal = checkedAdd(
    expectedTableOrdinal,
    1,
    () => inputInvalid("audit table ordinal 溢出"),
  );
  const nextAudit = normalizeAuditCursor({
    tableOrdinal: nextTableOrdinal,
    tableName: input.nextTableName,
    cursor: input.nextCursor,
  });
  const current = await readCheckpoint(transaction, lease.operationId);
  if (
    !current
    || current.phase !== "db_finalize"
    || current.epoch !== expectedEpoch
    || current.cursorHash !== expectedCursorHash
    || current.auditTableOrdinal !== expectedTableOrdinal
    || current.auditTableName !== expectedTableName
  ) {
    await assertActiveLease(transaction, lease);
    cursorLost();
  }
  const base = {
    ...current,
    leaseOwner: lease.owner,
    leaseFence: lease.fence,
    auditTableOrdinal: nextAudit.tableOrdinal,
    auditTableName: nextAudit.tableName,
    auditCursorJson: nextAudit.cursorJson,
    auditCursorHash: nextAudit.cursorHash,
    nextAuditChunkOrdinal: 0,
    updatedAt: Math.max(current.updatedAt, lease.now),
  };
  const {
    cursorHash: _cursorHash,
    createdAt,
    updatedAt,
    ...cursorInput
  } = base;
  const next: DeletionChunkCheckpoint = {
    ...cursorInput,
    cursorHash: checkpointCursorHash(cursorInput),
    createdAt,
    updatedAt,
  };
  return casCheckpoint(transaction, lease, {
    phase: "db_finalize",
    epoch: expectedEpoch,
    cursorHash: expectedCursorHash,
  }, next);
}

function sameManifestReplay(
  chunk: DeletionManifestChunk,
  input: {
    operationId: string;
    phase: DeletionManifestChunkPhase;
    epoch: number;
    ordinal: number;
    inputCursorHash: string;
    inputMarker: DeletionStorageMarker | null;
    outputMarker: DeletionStorageMarker | null;
    itemCount: number;
    contentHash: string;
  },
): boolean {
  return chunk.operationId === input.operationId
    && chunk.phase === input.phase
    && chunk.epoch === input.epoch
    && chunk.ordinal === input.ordinal
    && chunk.inputCursorHash === input.inputCursorHash
    && markerMatches(
      input.inputMarker,
      chunk.inputKeyMarker,
      chunk.inputVersionIdMarker,
    )
    && markerMatches(
      input.outputMarker,
      chunk.outputKeyMarker,
      chunk.outputVersionIdMarker,
    )
    && chunk.itemCount === input.itemCount
    && chunk.contentHash === input.contentHash;
}

export async function appendDeletionManifestChunkInTransaction(
  transaction: Knex.Transaction,
  input: AppendDeletionManifestChunkInput,
  /**
   * Runs once, after the immutable chunk insert and before the checkpoint
   * CAS, inside the same savepoint. The workflow uses this for one bounded
   * (at most 500 item) outbox batch. Exact replays do not invoke the hook.
   */
  beforeCheckpointAdvance?: BeforeDeletionManifestCheckpointAdvance,
): Promise<AppendDeletionManifestChunkResult> {
  assertCallerTransaction(transaction);
  const lease = normalizeLease(input.lease);
  const phase = inputManifestPhase(input.phase);
  const epoch = inputInteger(input.epoch, "epoch");
  const ordinal = inputInteger(input.ordinal, "ordinal");
  const inputCursorHash = inputHash(
    input.inputCursorHash,
    "input cursorHash",
  );
  const inputMarker = normalizeMarker(input.inputMarker);
  const outputMarker = normalizeMarker(input.outputMarker);
  const itemCount = inputInteger(
    input.itemCount,
    "manifest item count",
    MAX_CHUNK_COUNT,
  );
  const contentHash = inputHash(input.contentHash, "contentHash");
  const normalized = {
    operationId: lease.operationId,
    phase,
    epoch,
    ordinal,
    inputCursorHash,
    inputMarker,
    outputMarker,
    itemCount,
    contentHash,
  };

  return transaction.transaction(async (savepoint) => {
    await assertActiveLease(savepoint, lease);
    const rawExisting = await savepoint(DELETION_MANIFEST_CHUNK_TABLE)
      .where({
        operationId: lease.operationId,
        epoch,
        ordinal,
      })
      .first() as RawRow | undefined;
    if (rawExisting) {
      const chunk = mapManifestChunk(rawExisting);
      if (!sameManifestReplay(chunk, normalized)) contentConflict();
      const checkpoint = await readCheckpoint(savepoint, lease.operationId);
      if (
        !checkpoint
        || checkpoint.epoch !== epoch
        || checkpoint.nextManifestChunkOrdinal <= ordinal
      ) {
        rowInvalid();
      }
      return { checkpoint, chunk, idempotent: true };
    }

    const current = await readCheckpoint(savepoint, lease.operationId);
    if (
      !current
      || current.phase !== phase
      || current.epoch !== epoch
      || current.cursorHash !== inputCursorHash
      || !markerMatches(
        inputMarker,
        current.keyMarker,
        current.versionIdMarker,
      )
    ) {
      cursorLost();
    }
    if (current.nextManifestChunkOrdinal !== ordinal) ordinalConflict();
    const nextItemCount = checkedAdd(
      current.manifestItemCount,
      itemCount,
      rowInvalid,
    );
    const nextOrdinal = checkedAdd(ordinal, 1, ordinalConflict);
    const chunkWithoutHashes = {
      operationId: lease.operationId,
      epoch,
      phase,
      ordinal,
      providerId: current.providerId,
      providerFingerprint: current.providerFingerprint,
      bucket: current.bucket,
      objectPrefix: current.objectPrefix,
      inputKeyMarker: inputMarker?.keyMarker ?? null,
      inputVersionIdMarker: inputMarker?.versionIdMarker ?? null,
      outputKeyMarker: outputMarker?.keyMarker ?? null,
      outputVersionIdMarker: outputMarker?.versionIdMarker ?? null,
      inputCursorHash,
      outputCursorHash: inputCursorHash,
      itemCount,
      contentHash,
      previousChainHash: current.manifestChainHash,
    };
    const chunkHash = manifestChunkHash(chunkWithoutHashes);
    const chainHash = manifestChainHash(
      current.manifestChainHash,
      chunkHash,
      itemCount,
    );
    const nextCursorInput = {
      operationId: current.operationId,
      leaseOwner: lease.owner,
      leaseFence: lease.fence,
      phase: current.phase,
      epoch: current.epoch,
      providerId: current.providerId,
      providerFingerprint: current.providerFingerprint,
      bucket: current.bucket,
      objectPrefix: current.objectPrefix,
      keyMarker: outputMarker?.keyMarker ?? null,
      versionIdMarker: outputMarker?.versionIdMarker ?? null,
      nextManifestChunkOrdinal: nextOrdinal,
      manifestChainHash: chainHash,
      manifestItemCount: nextItemCount,
      auditTableOrdinal: current.auditTableOrdinal,
      auditTableName: current.auditTableName,
      auditCursorJson: current.auditCursorJson,
      auditCursorHash: current.auditCursorHash,
      nextAuditChunkOrdinal: current.nextAuditChunkOrdinal,
      auditChainHash: current.auditChainHash,
      auditRowCount: current.auditRowCount,
    };
    const outputCursorHash = checkpointCursorHash(nextCursorInput);
    const chunk: DeletionManifestChunk = {
      ...chunkWithoutHashes,
      outputCursorHash,
      chunkHash,
      chainHash,
      createdAt: lease.now,
    };
    const duplicate = await savepoint(DELETION_MANIFEST_CHUNK_TABLE)
      .where({
        operationId: lease.operationId,
        chunkHash: chunk.chunkHash,
      })
      .first();
    if (duplicate) contentConflict();
    const next: DeletionChunkCheckpoint = {
      ...current,
      ...nextCursorInput,
      cursorHash: outputCursorHash,
      updatedAt: Math.max(current.updatedAt, lease.now),
    };
    try {
      await savepoint.transaction(async (insertSavepoint) => {
        await insertSavepoint(DELETION_MANIFEST_CHUNK_TABLE).insert(chunk);
      });
    } catch {
      const racedRaw = await savepoint(DELETION_MANIFEST_CHUNK_TABLE)
        .where({
          operationId: lease.operationId,
          epoch,
          ordinal,
        })
        .first() as RawRow | undefined;
      if (racedRaw) {
        const racedChunk = mapManifestChunk(racedRaw);
        if (!sameManifestReplay(racedChunk, normalized)) contentConflict();
        const racedCheckpoint = await readCheckpoint(
          savepoint,
          lease.operationId,
        );
        if (
          !racedCheckpoint
          || racedCheckpoint.epoch !== epoch
          || racedCheckpoint.nextManifestChunkOrdinal <= ordinal
        ) {
          rowInvalid();
        }
        return {
          checkpoint: racedCheckpoint,
          chunk: racedChunk,
          idempotent: true,
        };
      }
      await assertActiveLease(savepoint, lease);
      const latest = await readCheckpoint(savepoint, lease.operationId);
      if (
        !latest
        || latest.phase !== phase
        || latest.epoch !== epoch
        || latest.cursorHash !== inputCursorHash
      ) {
        cursorLost();
      }
      contentConflict();
    }
    if (beforeCheckpointAdvance) {
      await beforeCheckpointAdvance(savepoint, {
        currentCheckpoint: current,
        nextCheckpoint: next,
        chunk,
      });
    }
    const checkpoint = await casCheckpoint(savepoint, lease, {
      phase,
      epoch,
      cursorHash: inputCursorHash,
    }, next);
    return { checkpoint, chunk, idempotent: false };
  });
}

function sameAuditReplay(
  chunk: DeletionAuditChunk,
  input: {
    operationId: string;
    epoch: number;
    tableOrdinal: number;
    tableName: string;
    ordinal: number;
    inputCursorHash: string;
    inputAuditCursorJson: string;
    outputAuditCursorJson: string;
    rowCount: number;
    rowsHash: string;
  },
): boolean {
  return chunk.operationId === input.operationId
    && chunk.epoch === input.epoch
    && chunk.tableOrdinal === input.tableOrdinal
    && chunk.tableName === input.tableName
    && chunk.ordinal === input.ordinal
    && chunk.inputCursorHash === input.inputCursorHash
    && chunk.inputAuditCursorJson === input.inputAuditCursorJson
    && chunk.outputAuditCursorJson === input.outputAuditCursorJson
    && chunk.rowCount === input.rowCount
    && chunk.rowsHash === input.rowsHash;
}

export async function appendDeletionAuditChunkInTransaction(
  transaction: Knex.Transaction,
  input: AppendDeletionAuditChunkInput,
): Promise<AppendDeletionAuditChunkResult> {
  assertCallerTransaction(transaction);
  const lease = normalizeLease(input.lease);
  const epoch = inputInteger(input.epoch, "epoch");
  const tableOrdinal = inputInteger(
    input.tableOrdinal,
    "audit table ordinal",
  );
  const tableName = inputText(input.tableName, "audit table name", 128);
  const ordinal = inputInteger(input.ordinal, "ordinal");
  const inputCursorHash = inputHash(
    input.inputCursorHash,
    "input cursorHash",
  );
  const inputAuditCursorJson = stableJson(input.inputAuditCursor);
  const outputAuditCursorJson = stableJson(input.outputAuditCursor);
  const rowCount = inputInteger(
    input.rowCount,
    "audit row count",
    MAX_CHUNK_COUNT,
  );
  const rowsHash = inputHash(input.rowsHash, "rowsHash");
  const normalized = {
    operationId: lease.operationId,
    epoch,
    tableOrdinal,
    tableName,
    ordinal,
    inputCursorHash,
    inputAuditCursorJson,
    outputAuditCursorJson,
    rowCount,
    rowsHash,
  };

  return transaction.transaction(async (savepoint) => {
    await assertActiveLease(savepoint, lease);
    const rawExisting = await savepoint(DELETION_AUDIT_CHUNK_TABLE)
      .where({
        operationId: lease.operationId,
        epoch,
        tableOrdinal,
        ordinal,
      })
      .first() as RawRow | undefined;
    if (rawExisting) {
      const chunk = mapAuditChunk(rawExisting);
      if (!sameAuditReplay(chunk, normalized)) contentConflict();
      const checkpoint = await readCheckpoint(savepoint, lease.operationId);
      if (
        !checkpoint
        || checkpoint.epoch !== epoch
        || (
          checkpoint.auditTableOrdinal === tableOrdinal
          && checkpoint.nextAuditChunkOrdinal <= ordinal
        )
        || checkpoint.auditTableOrdinal < tableOrdinal
      ) {
        rowInvalid();
      }
      return { checkpoint, chunk, idempotent: true };
    }

    const current = await readCheckpoint(savepoint, lease.operationId);
    if (
      !current
      || current.phase !== "db_finalize"
      || current.epoch !== epoch
      || current.cursorHash !== inputCursorHash
      || current.auditTableOrdinal !== tableOrdinal
      || current.auditTableName !== tableName
      || current.auditCursorJson !== inputAuditCursorJson
    ) {
      cursorLost();
    }
    if (current.nextAuditChunkOrdinal !== ordinal) ordinalConflict();
    const nextRowCount = checkedAdd(
      current.auditRowCount,
      rowCount,
      rowInvalid,
    );
    const nextOrdinal = checkedAdd(ordinal, 1, ordinalConflict);
    const outputAuditCursorHash = sha256(outputAuditCursorJson);
    const provisionalCursorInput = {
      operationId: current.operationId,
      leaseOwner: lease.owner,
      leaseFence: lease.fence,
      phase: current.phase,
      epoch: current.epoch,
      providerId: current.providerId,
      providerFingerprint: current.providerFingerprint,
      bucket: current.bucket,
      objectPrefix: current.objectPrefix,
      keyMarker: current.keyMarker,
      versionIdMarker: current.versionIdMarker,
      nextManifestChunkOrdinal: current.nextManifestChunkOrdinal,
      manifestChainHash: current.manifestChainHash,
      manifestItemCount: current.manifestItemCount,
      auditTableOrdinal: current.auditTableOrdinal,
      auditTableName: current.auditTableName,
      auditCursorJson: outputAuditCursorJson,
      auditCursorHash: outputAuditCursorHash,
      nextAuditChunkOrdinal: nextOrdinal,
      auditChainHash: current.auditChainHash,
      auditRowCount: nextRowCount,
    };
    const chunkWithoutHashes = {
      operationId: lease.operationId,
      epoch,
      tableOrdinal,
      tableName,
      ordinal,
      inputAuditCursorJson,
      inputAuditCursorHash: sha256(inputAuditCursorJson),
      outputAuditCursorJson,
      outputAuditCursorHash,
      inputCursorHash,
      outputCursorHash: inputCursorHash,
      rowCount,
      rowsHash,
      previousChainHash: current.auditChainHash,
    };
    const chunkHash = auditChunkHash(chunkWithoutHashes);
    const chainHash = auditChainHash(
      current.auditChainHash,
      chunkHash,
      rowCount,
    );
    const finalCursorInput = {
      ...provisionalCursorInput,
      auditChainHash: chainHash,
    };
    const outputCursorHash = checkpointCursorHash(finalCursorInput);
    const chunk: DeletionAuditChunk = {
      ...chunkWithoutHashes,
      outputCursorHash,
      chunkHash,
      chainHash,
      createdAt: lease.now,
    };
    const duplicate = await savepoint(DELETION_AUDIT_CHUNK_TABLE)
      .where({
        operationId: lease.operationId,
        chunkHash: chunk.chunkHash,
      })
      .first();
    if (duplicate) contentConflict();
    try {
      await savepoint.transaction(async (insertSavepoint) => {
        await insertSavepoint(DELETION_AUDIT_CHUNK_TABLE).insert(chunk);
      });
    } catch {
      const racedRaw = await savepoint(DELETION_AUDIT_CHUNK_TABLE)
        .where({
          operationId: lease.operationId,
          epoch,
          tableOrdinal,
          ordinal,
        })
        .first() as RawRow | undefined;
      if (racedRaw) {
        const racedChunk = mapAuditChunk(racedRaw);
        if (!sameAuditReplay(racedChunk, normalized)) contentConflict();
        const racedCheckpoint = await readCheckpoint(
          savepoint,
          lease.operationId,
        );
        if (
          !racedCheckpoint
          || racedCheckpoint.epoch !== epoch
          || (
            racedCheckpoint.auditTableOrdinal === tableOrdinal
            && racedCheckpoint.nextAuditChunkOrdinal <= ordinal
          )
          || racedCheckpoint.auditTableOrdinal < tableOrdinal
        ) {
          rowInvalid();
        }
        return {
          checkpoint: racedCheckpoint,
          chunk: racedChunk,
          idempotent: true,
        };
      }
      await assertActiveLease(savepoint, lease);
      const latest = await readCheckpoint(savepoint, lease.operationId);
      if (
        !latest
        || latest.phase !== "db_finalize"
        || latest.epoch !== epoch
        || latest.cursorHash !== inputCursorHash
      ) {
        cursorLost();
      }
      contentConflict();
    }
    const next: DeletionChunkCheckpoint = {
      ...current,
      ...finalCursorInput,
      cursorHash: outputCursorHash,
      updatedAt: Math.max(current.updatedAt, lease.now),
    };
    const checkpoint = await casCheckpoint(savepoint, lease, {
      phase: "db_finalize",
      epoch,
      cursorHash: inputCursorHash,
    }, next);
    return { checkpoint, chunk, idempotent: false };
  });
}

export const appendDeletionManifestChunkAndAdvanceCheckpointInTransaction =
  appendDeletionManifestChunkInTransaction;
export const appendDeletionAuditChunkAndAdvanceCheckpointInTransaction =
  appendDeletionAuditChunkInTransaction;
