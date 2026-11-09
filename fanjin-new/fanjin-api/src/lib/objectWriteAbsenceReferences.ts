import { createHash } from "node:crypto";
import type { Knex } from "knex";
import { isPostgresClient, quoteSqlIdentifier, rawRows } from "@/lib/dbDialect";

type LinkKind = "image" | "asset" | "ownership" | "grant" | "project_asset" | "portrait";

export interface ObjectWriteAbsenceReferenceTable {
  readonly table: string;
  /** Only these application reference fields are inspected, never whole rows. */
  readonly columns: readonly string[];
  readonly link?: LinkKind;
}

const entries: ObjectWriteAbsenceReferenceTable[] = [
  { table: "o_image", columns: ["storageKey", "filePath"], link: "image" },
  { table: "o_assets", columns: ["describe", "prompt", "remark"], link: "asset" },
  { table: "o_asset_ownership", columns: [], link: "ownership" },
  { table: "o_asset_grant", columns: [], link: "grant" },
  { table: "o_project_asset_ref", columns: ["assetVersionId"], link: "project_asset" },
  { table: "o_portrait_admission", columns: ["sourceRecoveryObjectIdentityJson", "detectorEvidenceJson"], link: "portrait" },
  { table: "o_media_asset", columns: ["storageKey", "localPath", "url", "metadata"] },
  { table: "o_tasks", columns: ["relatedObjects"] },
  { table: "o_workflow_graph", columns: ["coverStorageKey", "coverImageUrl", "nodes", "edges", "groups"] },
  { table: "o_canvas_asset", columns: ["coverStorageKey", "coverUrl", "saveStorageKey", "saveLocation", "referenceAssetUri", "snapshot"] },
  { table: "o_canvas_share", columns: ["snapshotJson"] },
  { table: "o_canvas_workflow_template", columns: ["coverUrl", "groupSnapshot"] },
  { table: "o_fjtv_publication", columns: ["coverUrl", "snapshotJson"] },
  { table: "o_relay_task", columns: ["requestPayload", "providerPayload", "resultPayload"] },
  { table: "o_creation_session", columns: ["inputs", "parameters", "selectedAssetVersionIds"] },
  { table: "o_creation_session_mutation", columns: ["beforeSnapshot", "afterSnapshot", "changedFields"] },
  { table: "o_imageFlow", columns: ["flowData"] },
  { table: "o_agent_message", columns: ["content", "metadata", "referenceRefs"] },
  { table: "o_agent_run", columns: ["policySnapshot", "waitRef"] },
  { table: "o_project", columns: ["coverStorageKey", "coverImageUrl"] },
  { table: "o_storyboard", columns: ["storageKey", "filePath", "track"] },
  { table: "o_video", columns: ["storageKey", "filePath"] },
  { table: "o_reference_multipart_upload", columns: ["storageKey", "probeJson", "assetId", "assetVersionId"] },
  { table: "o_canvas_command_mutation", columns: ["beforeSnapshot", "afterSnapshot", "commandSetJson", "resultJson"] },
  { table: "o_project_mutation", columns: ["beforeSnapshot", "afterSnapshot", "changedFields"] },
  { table: "o_agentWorkData", columns: ["data"] },
  { table: "o_agent_step", columns: ["inputRefs", "outputRefs"] },
  { table: "o_agent_delegation", columns: ["inputRefs", "resourceScope", "resultJson", "taskJson", "writeTargets", "outputContract"] },
  { table: "o_agent_event", columns: ["payload"] },
  { table: "o_agent_approval", columns: ["argumentsSummary", "impactSummary", "resourceVersions", "quote"] },
  { table: "o_agent_generation_review", columns: ["subjectJson", "checksJson"] },
  { table: "o_agent_review_report", columns: ["reportJson"] },
  { table: "o_agent_thread", columns: ["metadata"] },
  { table: "o_agent_idempotency", columns: ["responseBody", "resourceId"] },
  { table: "o_user_video_enhance_task", columns: ["sourceUrl", "resultUrl", "sourceAssetId", "resultAssetId", "quoteJson"] },
  { table: "o_relay_callback_delivery", columns: ["payload"] },
  { table: "o_agent_delegation_usage", columns: ["resourceRefs"] },
  { table: "o_artStyle", columns: ["fileUrl"] },
];

export const OBJECT_WRITE_ABSENCE_REFERENCE_MANIFEST: readonly ObjectWriteAbsenceReferenceTable[] = Object.freeze(
  entries.sort((a, b) => a.table < b.table ? -1 : a.table > b.table ? 1 : 0).map(entry => Object.freeze({
    ...entry,
    columns: Object.freeze([...entry.columns].sort()),
  })),
);

const linkColumns: Readonly<Record<LinkKind, readonly string[]>> = Object.freeze({
  image: ["id", "assetsId"],
  asset: ["id", "imageId"],
  ownership: ["assetId"],
  grant: ["assetId"],
  project_asset: ["assetId", "assetVersionId"],
  portrait: ["assetId", "assetVersionId"],
});

export const OBJECT_WRITE_ABSENCE_REFERENCE_BARRIERS = Object.freeze([
  Object.freeze({ table: "o_deletion_operation", columns: Object.freeze(["projectId", "status"]) }),
  Object.freeze({ table: "o_deletion_outbox", columns: Object.freeze(["objectKey", "status"]) }),
]);

export const OBJECT_WRITE_ABSENCE_REFERENCE_MANIFEST_SHA256 = createHash("sha256").update(JSON.stringify({
  format: "object-write-absence-reference-manifest.v1",
  referenceTables: OBJECT_WRITE_ABSENCE_REFERENCE_MANIFEST,
  linkColumns,
  barriers: OBJECT_WRITE_ABSENCE_REFERENCE_BARRIERS,
  matching: "exclusive-uuid-key-and-numeric-links;ascii-json-uri-fold.v1;all-status-references;deletion-status-not-completed",
})).digest("hex");

export interface ObjectWriteAbsenceReferenceIntent {
  id: string;
  objectKey: string;
  projectId: number;
}

export interface ObjectWriteAbsenceReferenceScan {
  format: "object-write-absence-reference-scan.v1";
  manifestSha256: string;
  schema: string;
  checkedTables: string[];
  intents: Array<{
    intentId: string;
    counts: Record<string, number>;
    totalReferences: number;
    activeDeletionOperations: number;
    activeDeletionObjects: number;
  }>;
}

export class ObjectWriteAbsenceReferencesError extends Error {
  constructor(readonly code: string, readonly details: Record<string, unknown> = {}) {
    super(code);
    this.name = "ObjectWriteAbsenceReferencesError";
  }
}

const requiredTables = Object.freeze([
  ...OBJECT_WRITE_ABSENCE_REFERENCE_MANIFEST.map(entry => Object.freeze({
    table: entry.table,
    columns: Object.freeze([...new Set([...entry.columns, ...(entry.link ? linkColumns[entry.link] : [])])].sort()),
  })),
  ...OBJECT_WRITE_ABSENCE_REFERENCE_BARRIERS,
].sort((a, b) => a.table < b.table ? -1 : a.table > b.table ? 1 : 0));

const lockContexts = new WeakMap<object, { schema: string; backendPid: number }>();
function error(code: string, details: Record<string, unknown> = {}): never {
  throw new ObjectWriteAbsenceReferencesError(code, details);
}
const identifier = quoteSqlIdentifier;
const relation = (schema: string, table: string) => `${identifier(schema)}.${identifier(table)}`;

function requireTransaction(trx: Knex.Transaction): void {
  if (!isPostgresClient(trx) || trx.isTransaction !== true || trx.isCompleted()) {
    error("OBJECT_WRITE_ABSENCE_REFERENCE_TRANSACTION_REQUIRED");
  }
}

async function context(trx: Knex.Transaction): Promise<{ schema: string; backendPid: number }> {
  const rows = rawRows<{ schema: string; backendPid: number; isolation: string }>(await trx.raw(
    `SELECT current_schema() AS schema, pg_backend_pid() AS "backendPid", current_setting('transaction_isolation') AS isolation`,
  ));
  if (rows.length !== 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(rows[0].schema || "")
    || !Number.isSafeInteger(rows[0].backendPid) || rows[0].isolation !== "read committed") {
    error("OBJECT_WRITE_ABSENCE_REFERENCE_CONTEXT_INVALID");
  }
  return { schema: rows[0].schema, backendPid: rows[0].backendPid };
}

async function checkColumns(trx: Knex.Transaction, schema: string): Promise<void> {
  const rows = rawRows<{ table: string; column: string; kind: string; rls: boolean }>(await trx.raw(
    `SELECT c.relname AS "table", a.attname AS "column", c.relkind AS kind, c.relrowsecurity AS rls
     FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
     WHERE n.nspname = ? AND c.relname = ANY(?::text[])`,
    [schema, requiredTables.map(entry => entry.table)],
  ));
  for (const entry of requiredTables) {
    const found = rows.filter(row => row.table === entry.table);
    if (!found.length) error("OBJECT_WRITE_ABSENCE_REFERENCE_TABLE_MISSING", { table: entry.table });
    if (found.some(row => !["r", "p"].includes(row.kind) || row.rls !== false)) {
      error("OBJECT_WRITE_ABSENCE_REFERENCE_TABLE_UNSAFE", { table: entry.table });
    }
    const actual = new Set(found.map(row => row.column));
    const missingColumns = entry.columns.filter(column => !actual.has(column));
    if (missingColumns.length) error("OBJECT_WRITE_ABSENCE_REFERENCE_COLUMN_MISSING", { table: entry.table, missingColumns });
  }
}

/** No user-data reads before the fixed schema is checked. NOWAIT never queues an unbounded maintenance lock. */
export async function lockObjectWriteAbsenceReferences(trx: Knex.Transaction): Promise<void> {
  requireTransaction(trx);
  lockContexts.delete(trx);
  try {
    const current = await context(trx);
    await checkColumns(trx, current.schema);
    try {
      await trx.raw(`LOCK TABLE ${requiredTables.map(entry => relation(current.schema, entry.table)).join(", ")} IN SHARE MODE NOWAIT`);
    } catch {
      error("OBJECT_WRITE_ABSENCE_REFERENCE_LOCK_UNAVAILABLE");
    }
    // A schema change between the initial inspection and acquiring the lock is not accepted.
    await checkColumns(trx, current.schema);
    lockContexts.set(trx, current);
  } catch (failure) {
    if (failure instanceof ObjectWriteAbsenceReferencesError) throw failure;
    error("OBJECT_WRITE_ABSENCE_REFERENCE_QUERY_FAILED");
  }
}

function normalizeIntents(intents: readonly ObjectWriteAbsenceReferenceIntent[]): ObjectWriteAbsenceReferenceIntent[] {
  if (!Array.isArray(intents) || intents.length < 1 || intents.length > 9) error("OBJECT_WRITE_ABSENCE_REFERENCE_INTENTS_INVALID");
  const normalized = intents.map((intent: ObjectWriteAbsenceReferenceIntent) => {
    if (!intent || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(intent.id)
      || !Number.isSafeInteger(intent.projectId) || intent.projectId < 1 || typeof intent.objectKey !== "string"
      || !intent.objectKey.startsWith(`${intent.projectId}/`) || intent.objectKey.length > 2048
      || intent.objectKey.split("/").some(part => !part || part === "." || part === "..")
      || /[\\\x00-\x1f]/u.test(intent.objectKey)
      || !intent.objectKey.split("/").some(part => part === intent.id || part.startsWith(`${intent.id}.`))) {
      error("OBJECT_WRITE_ABSENCE_REFERENCE_INTENTS_INVALID");
    }
    return { id: intent.id, objectKey: intent.objectKey, projectId: intent.projectId };
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (new Set(normalized.map(item => item.id)).size !== normalized.length
    || new Set(normalized.map(item => item.objectKey)).size !== normalized.length) {
    error("OBJECT_WRITE_ABSENCE_REFERENCE_INTENTS_INVALID");
  }
  return normalized;
}

/**
 * Keys are already required to contain the exclusive intent UUID. Fold only
 * that UUID's ASCII alphabet, so JSON/stringified JSON and percent-encoded
 * URLs cannot hide it. Overmatches fail closed; no payload is returned.
 */
function uuidText(columns: readonly string[], alias = "t"): string {
  let sql = `lower(jsonb_build_array(${columns.map(column => `${alias}.${identifier(column)}`).join(", ")})::text)`;
  sql = `replace(${sql}, chr(92), '')`;
  sql = `regexp_replace(${sql}, '%(25)+', '%', 'g')`;
  for (const token of ["%5c", "u005c"]) sql = `replace(${sql}, '${token}', '')`;
  for (const char of "0123456789abcdef-ABCDEF") {
    const ascii = char.charCodeAt(0).toString(16);
    for (const encoded of [`%${ascii}`, `u00${ascii}`]) sql = `replace(${sql}, '${encoded}', '${char.toLowerCase()}')`;
  }
  return sql;
}

function payloadPredicate(columns: readonly string[], alias = "t"): string {
  return columns.length ? `strpos(${uuidText(columns, alias)}, i.id) > 0` : "FALSE";
}

function referencePredicate(entry: ObjectWriteAbsenceReferenceTable): string {
  const payload = payloadPredicate(entry.columns);
  if (!entry.link || entry.link === "image") return payload;
  if (entry.link === "asset") return `(${payload} OR EXISTS (SELECT 1 FROM matched_images m WHERE m."intentId" = i.id
    AND (t.id::text = m."assetId" OR t."imageId"::text = m."imageId")))`;
  const asset = `EXISTS (SELECT 1 FROM matched_assets m WHERE m."intentId" = i.id AND t."assetId"::text = m."assetId")`;
  if (entry.link === "project_asset") return `(${payload} OR ${asset} OR EXISTS (SELECT 1 FROM matched_images m
    WHERE m."intentId" = i.id AND t."assetVersionId" = 'image:' || m."imageId"))`;
  if (entry.link === "portrait") return `(${payload} OR ${asset} OR EXISTS (SELECT 1 FROM matched_images m
    WHERE m."intentId" = i.id AND t."assetVersionId"::text = m."imageId"))`;
  return `(${payload} OR ${asset})`;
}

function countStatement(schema: string): string {
  const tables = OBJECT_WRITE_ABSENCE_REFERENCE_MANIFEST.map(entry => `SELECT '${entry.table}' AS "table", i.id AS "intentId",
    (SELECT count(*)::text FROM ${relation(schema, entry.table)} t WHERE ${referencePredicate(entry)}) AS count FROM intents i`);
  tables.push(`SELECT 'o_deletion_operation' AS "table", i.id AS "intentId", (SELECT count(*)::text FROM ${relation(schema, "o_deletion_operation")} t
    WHERE t."projectId"::text = i."projectId"::text AND COALESCE(t.status, '') <> 'completed') AS count FROM intents i`);
  tables.push(`SELECT 'o_deletion_outbox' AS "table", i.id AS "intentId", (SELECT count(*)::text FROM ${relation(schema, "o_deletion_outbox")} t
    WHERE (${payloadPredicate(["objectKey"])}) AND COALESCE(t.status, '') <> 'completed') AS count FROM intents i`);
  return `WITH intents AS MATERIALIZED (SELECT * FROM jsonb_to_recordset(?::jsonb) AS v(id text, "objectKey" text, "projectId" bigint)),
    matched_images AS MATERIALIZED (SELECT i.id AS "intentId", t.id::text AS "imageId", t."assetsId"::text AS "assetId"
      FROM intents i JOIN ${relation(schema, "o_image")} t ON ${payloadPredicate(["storageKey", "filePath"])}),
    matched_assets AS MATERIALIZED (SELECT i.id AS "intentId", t.id::text AS "assetId" FROM intents i
      JOIN ${relation(schema, "o_assets")} t ON ${referencePredicate(OBJECT_WRITE_ABSENCE_REFERENCE_MANIFEST.find(entry => entry.table === "o_assets")!)})
    ${tables.join("\nUNION ALL\n")}`;
}

/** Must run after project/intent locks and lockObjectWriteAbsenceReferences, in the same READ COMMITTED transaction. */
export async function collectObjectWriteAbsenceReferences(
  trx: Knex.Transaction,
  intents: readonly ObjectWriteAbsenceReferenceIntent[],
): Promise<ObjectWriteAbsenceReferenceScan> {
  requireTransaction(trx);
  const input = normalizeIntents(intents);
  const locked = lockContexts.get(trx);
  if (!locked) error("OBJECT_WRITE_ABSENCE_REFERENCE_LOCK_REQUIRED");
  try {
    const current = await context(trx);
    if (current.schema !== locked.schema || current.backendPid !== locked.backendPid) error("OBJECT_WRITE_ABSENCE_REFERENCE_CONTEXT_CHANGED");
    const held = rawRows<{ table: string }>(await trx.raw(
      `SELECT DISTINCT c.relname AS "table" FROM pg_catalog.pg_locks l
       JOIN pg_catalog.pg_class c ON c.oid = l.relation JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE l.pid = pg_backend_pid() AND l.granted AND l.locktype = 'relation'
         AND l.mode IN ('ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')
         AND n.nspname = ? AND c.relname = ANY(?::text[])`,
      [locked.schema, requiredTables.map(entry => entry.table)],
    ));
    const heldTables = new Set(held.map(row => row.table));
    if (requiredTables.some(entry => !heldTables.has(entry.table))) error("OBJECT_WRITE_ABSENCE_REFERENCE_LOCK_REQUIRED");
    const rows = rawRows<{ table: string; intentId: string; count: string }>(await trx.raw(countStatement(locked.schema), [JSON.stringify(input)]));
    const expected = input.length * requiredTables.length;
    if (rows.length !== expected || new Set(rows.map(row => `${row.intentId}/${row.table}`)).size !== expected) {
      error("OBJECT_WRITE_ABSENCE_REFERENCE_RESULT_INCOMPLETE");
    }
    const byId = new Map(input.map(intent => [intent.id, {
      intentId: intent.id, counts: {} as Record<string, number>, totalReferences: 0, activeDeletionOperations: 0, activeDeletionObjects: 0,
    }]));
    const allowed = new Set(requiredTables.map(entry => entry.table));
    for (const row of rows) {
      const item = byId.get(row.intentId);
      const count = Number(row.count);
      if (!item || !allowed.has(row.table) || !/^\d+$/u.test(String(row.count)) || !Number.isSafeInteger(count) || count < 0) {
        error("OBJECT_WRITE_ABSENCE_REFERENCE_RESULT_INVALID");
      }
      if (row.table === "o_deletion_operation") item.activeDeletionOperations = count;
      else if (row.table === "o_deletion_outbox") item.activeDeletionObjects = count;
      else { item.counts[row.table] = count; item.totalReferences += count; }
      if (!Number.isSafeInteger(item.totalReferences)) error("OBJECT_WRITE_ABSENCE_REFERENCE_RESULT_INVALID");
    }
    const result: ObjectWriteAbsenceReferenceScan = {
      format: "object-write-absence-reference-scan.v1",
      manifestSha256: OBJECT_WRITE_ABSENCE_REFERENCE_MANIFEST_SHA256,
      schema: locked.schema,
      checkedTables: requiredTables.map(entry => entry.table),
      intents: [...byId.values()],
    };
    if (result.intents.some(item => item.totalReferences > 0)) error("OBJECT_WRITE_ABSENCE_REFERENCE_FOUND", { scan: result });
    if (result.intents.some(item => item.activeDeletionOperations > 0 || item.activeDeletionObjects > 0)) {
      error("OBJECT_WRITE_ABSENCE_DELETION_UNSETTLED", { scan: result });
    }
    return result;
  } catch (failure) {
    if (failure instanceof ObjectWriteAbsenceReferencesError) throw failure;
    // Driver errors can contain query text, bound values and connection details.
    error("OBJECT_WRITE_ABSENCE_REFERENCE_QUERY_FAILED");
  }
}
