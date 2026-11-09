import type { Knex } from "knex";

import {
  isPostgresClient,
  quoteSqlIdentifier,
  rawRows,
  tableIndexRows,
} from "@/lib/dbDialect";
import { DELETION_OUTBOX_TABLE } from "@/lib/deletionOutbox";
import { upDeletionChunkStoreSchema } from "@/lib/migrations/deletionChunkStore";
import { upObjectWriteIntent } from "@/lib/migrations/objectWriteIntent";
import {
  PROJECT_DELETION_FINALIZER_REQUIRED_SCHEMA,
} from "@/lib/projectDeletionChunkFinalizer";

export const DELETION_OPERATION_TABLE = "o_deletion_operation";
export const DELETION_RESOURCE_ALIAS_TABLE = "o_deletion_resource_alias";

export const DELETION_WORKFLOW_INDEXES = {
  operationKey: "uq_o_deletion_operation_key",
  operationStatusDue: "idx_o_deletion_operation_status_due",
  operationProject: "idx_o_deletion_operation_project",
  resourceAliasOperation: "idx_o_deletion_resource_alias_operation",
  mediaAssetProject: "idx_o_media_asset_project",
  relayTaskProject: "idx_o_relay_task_project",
  userVideoEnhanceProject: "idx_o_user_video_enhance_task_project",
  outboxDedupe: "uq_o_deletion_outbox_dedupe",
  outboxOperation: "idx_o_deletion_outbox_operation",
  outboxDispatchDue: "idx_o_deletion_outbox_dispatch_due",
  outboxReconcileDue: "idx_o_deletion_outbox_reconcile_due",
} as const;

export const PROJECT_DELETION_FINALIZER_INDEXES = {
  scriptAssetsByAsset: "idx_o_script_assets_asset_script",
  storyboardAssetsByAsset: "idx_o_assets_storyboard_asset_storyboard",
  roleAudioByRole: "idx_o_assets_role_audio_role_audio",
  assetsByFlow: "idx_o_assets_flow_id",
  storyboardsByFlow: "idx_o_storyboard_flow_id",
  imagesByAsset: "idx_o_image_assets_id",
  eventChaptersByEvent: "idx_o_event_chapter_event_id",
  eventChaptersByNovel: "idx_o_event_chapter_novel_id",
  agentEventsByProject: "idx_o_agent_event_project_id",
  agentMessagesByProject: "idx_o_agent_message_project_id",
  agentThreadsByProject: "idx_o_agent_thread_project_id",
  relayCallbacksByTask: "idx_o_relay_callback_task_id",
  relayTasksByProject: "idx_o_relay_task_project_id",
  enhanceTasksByProject: "idx_o_enhance_task_project_id",
  creationSessionsByProject: "idx_o_creation_session_project_id",
  canvasAssetsByProject: "idx_o_canvas_asset_project_id",
  workflowGraphsByProject: "idx_o_workflow_graph_project_id",
  agentWorkDataByProject: "idx_o_agent_work_data_project_id",
  novelsByProject: "idx_o_novel_project_id",
  scriptsByProject: "idx_o_script_project_id",
  tasksByProject: "idx_o_tasks_project_id",
  storyboardsByProject: "idx_o_storyboard_project_id",
  assetsByProject: "idx_o_assets_project_id",
  videosByProject: "idx_o_video_project_id",
  videoTracksByProject: "idx_o_video_track_project_id",
  mediaAssetsByProject: "idx_o_media_asset_project_id",
  memoriesByIsolation: "idx_memories_isolation_id",
} as const;

export const PROJECT_DELETION_FINALIZER_INDEX_SPECS = [
  {
    table: "o_scriptAssets",
    columns: ["assetId", "scriptId"],
    name: PROJECT_DELETION_FINALIZER_INDEXES.scriptAssetsByAsset,
  },
  {
    table: "o_assets2Storyboard",
    columns: ["assetId", "storyboardId"],
    name: PROJECT_DELETION_FINALIZER_INDEXES.storyboardAssetsByAsset,
  },
  {
    table: "o_assetsRole2Audio",
    columns: ["assetsRoleId", "assetsAudioId"],
    name: PROJECT_DELETION_FINALIZER_INDEXES.roleAudioByRole,
  },
  {
    table: "o_assets",
    columns: ["flowId", "id"],
    name: PROJECT_DELETION_FINALIZER_INDEXES.assetsByFlow,
  },
  {
    table: "o_storyboard",
    columns: ["flowId", "id"],
    name: PROJECT_DELETION_FINALIZER_INDEXES.storyboardsByFlow,
  },
  {
    table: "o_image",
    columns: ["assetsId", "id"],
    name: PROJECT_DELETION_FINALIZER_INDEXES.imagesByAsset,
  },
  {
    table: "o_eventChapter",
    columns: ["eventId", "id"],
    name: PROJECT_DELETION_FINALIZER_INDEXES.eventChaptersByEvent,
  },
  {
    table: "o_eventChapter",
    columns: ["novelId", "id"],
    name: PROJECT_DELETION_FINALIZER_INDEXES.eventChaptersByNovel,
  },
  {
    table: "o_agent_event",
    columns: ["workspaceId", "projectId", "id"],
    name: PROJECT_DELETION_FINALIZER_INDEXES.agentEventsByProject,
  },
  {
    table: "o_agent_message",
    columns: ["workspaceId", "projectId", "id"],
    name: PROJECT_DELETION_FINALIZER_INDEXES.agentMessagesByProject,
  },
  {
    table: "o_agent_thread",
    columns: ["workspaceId", "projectId", "id"],
    name: PROJECT_DELETION_FINALIZER_INDEXES.agentThreadsByProject,
  },
  {
    table: "o_relay_callback_delivery",
    columns: ["taskId", "id"],
    name: PROJECT_DELETION_FINALIZER_INDEXES.relayCallbacksByTask,
  },
  {
    table: "o_relay_task",
    columns: ["workspaceId", "projectId", "id"],
    name: PROJECT_DELETION_FINALIZER_INDEXES.relayTasksByProject,
  },
  {
    table: "o_user_video_enhance_task",
    columns: ["workspaceId", "projectId", "id"],
    name: PROJECT_DELETION_FINALIZER_INDEXES.enhanceTasksByProject,
  },
  {
    table: "o_creation_session",
    columns: ["workspaceId", "projectId", "id"],
    name: PROJECT_DELETION_FINALIZER_INDEXES.creationSessionsByProject,
  },
  {
    table: "o_canvas_asset",
    columns: ["workspaceId", "projectId", "id"],
    name: PROJECT_DELETION_FINALIZER_INDEXES.canvasAssetsByProject,
  },
  {
    table: "o_workflow_graph",
    columns: ["projectId", "id"],
    name: PROJECT_DELETION_FINALIZER_INDEXES.workflowGraphsByProject,
  },
  {
    table: "o_agentWorkData",
    columns: ["projectId", "id"],
    name: PROJECT_DELETION_FINALIZER_INDEXES.agentWorkDataByProject,
  },
  {
    table: "o_novel",
    columns: ["projectId", "id"],
    name: PROJECT_DELETION_FINALIZER_INDEXES.novelsByProject,
  },
  {
    table: "o_script",
    columns: ["projectId", "id"],
    name: PROJECT_DELETION_FINALIZER_INDEXES.scriptsByProject,
  },
  {
    table: "o_tasks",
    columns: ["projectId", "id"],
    name: PROJECT_DELETION_FINALIZER_INDEXES.tasksByProject,
  },
  {
    table: "o_storyboard",
    columns: ["projectId", "id"],
    name: PROJECT_DELETION_FINALIZER_INDEXES.storyboardsByProject,
  },
  {
    table: "o_assets",
    columns: ["projectId", "id"],
    name: PROJECT_DELETION_FINALIZER_INDEXES.assetsByProject,
  },
  {
    table: "o_video",
    columns: ["projectId", "id"],
    name: PROJECT_DELETION_FINALIZER_INDEXES.videosByProject,
  },
  {
    table: "o_videoTrack",
    columns: ["projectId", "id"],
    name: PROJECT_DELETION_FINALIZER_INDEXES.videoTracksByProject,
  },
  {
    table: "o_media_asset",
    columns: ["workspaceId", "projectId", "id"],
    name: PROJECT_DELETION_FINALIZER_INDEXES.mediaAssetsByProject,
  },
  {
    table: "memories",
    columns: ["isolationKey", "id"],
    name: PROJECT_DELETION_FINALIZER_INDEXES.memoriesByIsolation,
  },
] as const;

export type ProjectDeletionFinalizerIndexSpec =
  (typeof PROJECT_DELETION_FINALIZER_INDEX_SPECS)[number];

export interface PostgresIndexCatalogRow {
  indexName?: unknown;
  relationKind?: unknown;
  tableName?: unknown;
  tableInCurrentSchema?: unknown;
  accessMethod?: unknown;
  isUnique?: unknown;
  isValid?: unknown;
  isReady?: unknown;
  isLive?: unknown;
  isPartial?: unknown;
  hasExpressions?: unknown;
  keyAttributeCount?: unknown;
  totalAttributeCount?: unknown;
  keyColumns?: unknown;
  usesDefaultKeyDefinitions?: unknown;
}

function postgresCatalogBoolean(value: unknown): boolean | null {
  if (value === true || value === "t" || value === "true" || value === 1) {
    return true;
  }
  if (value === false || value === "f" || value === "false" || value === 0) {
    return false;
  }
  return null;
}

function postgresCatalogColumns(value: unknown): string[] | null {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (
    !Array.isArray(parsed)
    || parsed.some((column) => typeof column !== "string")
  ) {
    return null;
  }
  return [...parsed] as string[];
}

function rejectPostgresFinalizerIndex(
  spec: ProjectDeletionFinalizerIndexSpec,
  reason: string,
): never {
  throw new Error(
    `Migration deletion_workflow rejects existing index ${spec.name}: ${reason}`,
  );
}

export function assertExactPostgresFinalizerIndex(
  spec: ProjectDeletionFinalizerIndexSpec,
  row: PostgresIndexCatalogRow,
): void {
  if (String(row.indexName || "") !== spec.name) {
    rejectPostgresFinalizerIndex(spec, "catalog identity mismatch");
  }
  if (String(row.relationKind || "") !== "i") {
    rejectPostgresFinalizerIndex(spec, "same-name relation is not a regular index");
  }
  if (
    String(row.tableName || "") !== spec.table
    || postgresCatalogBoolean(row.tableInCurrentSchema) !== true
  ) {
    rejectPostgresFinalizerIndex(spec, `expected table ${spec.table}`);
  }
  if (String(row.accessMethod || "") !== "btree") {
    rejectPostgresFinalizerIndex(spec, "access method must be btree");
  }
  if (postgresCatalogBoolean(row.isUnique) !== false) {
    rejectPostgresFinalizerIndex(spec, "index must be non-unique");
  }
  if (postgresCatalogBoolean(row.isPartial) !== false) {
    rejectPostgresFinalizerIndex(spec, "partial indexes are not accepted");
  }
  if (postgresCatalogBoolean(row.hasExpressions) !== false) {
    rejectPostgresFinalizerIndex(spec, "expression indexes are not accepted");
  }
  if (
    postgresCatalogBoolean(row.isValid) !== true
    || postgresCatalogBoolean(row.isReady) !== true
    || postgresCatalogBoolean(row.isLive) !== true
  ) {
    rejectPostgresFinalizerIndex(spec, "index must be valid, ready and live");
  }
  const keyAttributeCount = Number(row.keyAttributeCount);
  const totalAttributeCount = Number(row.totalAttributeCount);
  if (
    !Number.isSafeInteger(keyAttributeCount)
    || !Number.isSafeInteger(totalAttributeCount)
    || keyAttributeCount !== spec.columns.length
    || totalAttributeCount !== keyAttributeCount
  ) {
    rejectPostgresFinalizerIndex(
      spec,
      "key count must be exact and INCLUDE columns are not accepted",
    );
  }
  const keyColumns = postgresCatalogColumns(row.keyColumns);
  if (
    keyColumns === null
    || keyColumns.length !== spec.columns.length
    || keyColumns.some((column, index) => column !== spec.columns[index])
  ) {
    rejectPostgresFinalizerIndex(
      spec,
      `expected key columns (${spec.columns.join(", ")}) in exact order`,
    );
  }
  if (postgresCatalogBoolean(row.usesDefaultKeyDefinitions) !== true) {
    rejectPostgresFinalizerIndex(
      spec,
      "every key must use its plain column definition with PostgreSQL default sort, NULL ordering, operator class and collation",
    );
  }
}

async function postgresIndexCatalogRows(
  trx: Knex.Transaction,
  indexName: string,
): Promise<PostgresIndexCatalogRow[]> {
  const result = await trx.raw(
    `
      SELECT
        index_class.relname AS "indexName",
        index_class.relkind AS "relationKind",
        table_class.relname AS "tableName",
        table_namespace.nspname = current_schema()
          AS "tableInCurrentSchema",
        access_method.amname AS "accessMethod",
        index_meta.indisunique AS "isUnique",
        index_meta.indisvalid AS "isValid",
        index_meta.indisready AS "isReady",
        index_meta.indislive AS "isLive",
        index_meta.indpred IS NOT NULL AS "isPartial",
        index_meta.indexprs IS NOT NULL AS "hasExpressions",
        index_meta.indnkeyatts AS "keyAttributeCount",
        index_meta.indnatts AS "totalAttributeCount",
        COALESCE((
          SELECT json_agg(attribute.attname ORDER BY key_column.ordinality)
          FROM unnest(index_meta.indkey) WITH ORDINALITY
            AS key_column(attnum, ordinality)
          LEFT JOIN pg_catalog.pg_attribute AS attribute
            ON attribute.attrelid = table_class.oid
           AND attribute.attnum = key_column.attnum
          WHERE key_column.ordinality <= index_meta.indnkeyatts
        ), '[]'::json) AS "keyColumns",
        COALESCE((
          SELECT bool_and(
            pg_catalog.pg_get_indexdef(
              index_class.oid,
              key_column.ordinality::integer,
              TRUE
            ) = pg_catalog.quote_ident(attribute.attname)
          )
          FROM unnest(index_meta.indkey) WITH ORDINALITY
            AS key_column(attnum, ordinality)
          LEFT JOIN pg_catalog.pg_attribute AS attribute
            ON attribute.attrelid = table_class.oid
           AND attribute.attnum = key_column.attnum
          WHERE key_column.ordinality <= index_meta.indnkeyatts
        ), FALSE) AS "usesDefaultKeyDefinitions"
      FROM pg_catalog.pg_class AS index_class
      JOIN pg_catalog.pg_namespace AS index_namespace
        ON index_namespace.oid = index_class.relnamespace
      LEFT JOIN pg_catalog.pg_index AS index_meta
        ON index_meta.indexrelid = index_class.oid
      LEFT JOIN pg_catalog.pg_class AS table_class
        ON table_class.oid = index_meta.indrelid
      LEFT JOIN pg_catalog.pg_namespace AS table_namespace
        ON table_namespace.oid = table_class.relnamespace
      LEFT JOIN pg_catalog.pg_am AS access_method
        ON access_method.oid = index_class.relam
      WHERE index_namespace.nspname = current_schema()
        AND index_class.relname = ?
    `,
    [indexName],
  );
  return rawRows<PostgresIndexCatalogRow>(result);
}

export async function ensureExactPostgresFinalizerIndex(
  trx: Knex.Transaction,
  spec: ProjectDeletionFinalizerIndexSpec,
): Promise<void> {
  const existing = await postgresIndexCatalogRows(trx, spec.name);
  if (existing.length > 1) {
    rejectPostgresFinalizerIndex(spec, "catalog returned duplicate identities");
  }
  if (existing.length === 1) {
    assertExactPostgresFinalizerIndex(spec, existing[0]);
    return;
  }
  await trx.raw(
    `CREATE INDEX ${quoteSqlIdentifier(spec.name)}`
      + ` ON ${quoteSqlIdentifier(spec.table)}`
      + ` (${spec.columns.map(quoteSqlIdentifier).join(", ")})`,
  );
  const created = await postgresIndexCatalogRows(trx, spec.name);
  if (created.length !== 1) {
    rejectPostgresFinalizerIndex(spec, "created index is not uniquely visible");
  }
  assertExactPostgresFinalizerIndex(spec, created[0]);
}

async function validateExistingPostgresFinalizerIndexes(
  trx: Knex.Transaction,
): Promise<void> {
  if (!isPostgresClient(trx)) return;
  for (const spec of PROJECT_DELETION_FINALIZER_INDEX_SPECS) {
    const existing = await postgresIndexCatalogRows(trx, spec.name);
    if (existing.length > 1) {
      rejectPostgresFinalizerIndex(
        spec,
        "catalog returned duplicate identities",
      );
    }
    if (existing.length === 1) {
      assertExactPostgresFinalizerIndex(spec, existing[0]);
    }
  }
}

const DELETION_MARKER_TABLES = [
  "o_project",
  "o_assets",
  "o_image",
  "o_media_asset",
] as const;

const STORAGE_KEY_COLUMNS = [
  { table: "o_project", columns: ["coverStorageKey"] },
  { table: "o_image", columns: ["storageKey"] },
  { table: "o_storyboard", columns: ["storageKey"] },
  { table: "o_video", columns: ["storageKey"] },
  { table: "o_workflow_graph", columns: ["coverStorageKey"] },
  { table: "o_canvas_asset", columns: ["coverStorageKey", "saveStorageKey"] },
  { table: "o_media_asset", columns: ["storageKey"] },
] as const;
const MAX_INLINE_MEDIA_ASSET_BACKFILL = 10_000;
const MAX_INLINE_PROJECT_OWNERSHIP_BACKFILL = 10_000;
const DELETION_OPERATION_GUARD_TRIGGER =
  "trg_o_deletion_operation_evidence_guard";
const DELETION_OPERATION_GUARD_FUNCTION =
  "fanjin_guard_deletion_operation_evidence";
const DELETION_RESOURCE_ALIAS_GUARD_TRIGGER =
  "trg_o_deletion_resource_alias_evidence_guard";
const DELETION_RESOURCE_ALIAS_GUARD_FUNCTION =
  "fanjin_guard_deletion_resource_alias_evidence";
const DELETION_OUTBOX_GUARD_TRIGGER =
  "trg_o_deletion_outbox_evidence_guard";
const DELETION_OUTBOX_GUARD_FUNCTION =
  "fanjin_guard_deletion_outbox_evidence";
const PROJECT_STATE_GUARD_TRIGGER = "trg_o_project_deletion_state_guard";
const PROJECT_STATE_GUARD_FUNCTION = "fanjin_guard_project_deletion_state";
const PROJECT_WRITE_GUARD_FUNCTION = "fanjin_require_active_project";
const IMAGE_WRITE_GUARD_FUNCTION = "fanjin_require_active_image_project";
const ASSET_STATE_GUARD_TRIGGER = "trg_o_assets_deletion_state_guard";
const ASSET_STATE_GUARD_FUNCTION = "fanjin_guard_asset_deletion_state";
const MEDIA_ASSET_STATE_GUARD_TRIGGER =
  "trg_o_media_asset_deletion_state_guard";
const MEDIA_ASSET_STATE_GUARD_FUNCTION =
  "fanjin_guard_media_asset_deletion_state";
const ASSET_IMAGE_REFERENCE_GUARD_FUNCTION =
  "fanjin_guard_asset_image_reference";
const INDIRECT_PROJECT_RELATION_GUARD_FUNCTION =
  "fanjin_guard_indirect_project_relation";
const IMAGE_FLOW_WRITE_GUARD_FUNCTION =
  "fanjin_guard_image_flow_project_write";
const IMAGE_FLOW_REFERENCE_GUARD_FUNCTION =
  "fanjin_guard_image_flow_reference";
const IMAGE_DELETION_STORAGE_KEY_GUARD_FUNCTION =
  "fanjin_guard_image_deletion_storage_key";
const USER_ENHANCE_BILLING_GUARD_TRIGGER =
  "trg_o_user_video_enhance_billing_guard";
const USER_ENHANCE_BILLING_GUARD_FUNCTION =
  "fanjin_guard_user_video_enhance_billing";
const USER_ENHANCE_BILLING_STATE_INDEX =
  "idx_o_user_video_enhance_task_billing_state";
const USER_ENHANCE_FINALIZATION_LEASE_INDEX =
  "idx_o_user_video_enhance_task_finalization_lease";
const TASK_OUTPUT_EVIDENCE_GUARD_TRIGGER =
  "trg_o_tasks_output_evidence_guard";
const TASK_OUTPUT_EVIDENCE_GUARD_FUNCTION =
  "fanjin_guard_task_output_evidence";

type StorageKeyReservationTarget = {
  table: string;
  projectScope: "project" | "image" | "direct";
  keys: Array<{
    authoritative: string;
    legacy?: string;
  }>;
};

const IMAGE_DELETION_STORAGE_KEY_RESERVATION_TARGETS: readonly StorageKeyReservationTarget[] = [
  {
    table: "o_project",
    projectScope: "project",
    keys: [{ authoritative: "coverStorageKey" }],
  },
  {
    table: "o_image",
    projectScope: "image",
    keys: [{ authoritative: "storageKey", legacy: "filePath" }],
  },
  {
    table: "o_storyboard",
    projectScope: "direct",
    keys: [{ authoritative: "storageKey", legacy: "filePath" }],
  },
  {
    table: "o_video",
    projectScope: "direct",
    keys: [{ authoritative: "storageKey", legacy: "filePath" }],
  },
  {
    table: "o_workflow_graph",
    projectScope: "direct",
    keys: [{ authoritative: "coverStorageKey" }],
  },
  {
    table: "o_canvas_asset",
    projectScope: "direct",
    keys: [
      { authoritative: "coverStorageKey" },
      { authoritative: "saveStorageKey" },
    ],
  },
  {
    table: "o_media_asset",
    projectScope: "direct",
    keys: [{ authoritative: "storageKey", legacy: "localPath" }],
  },
] as const;

const INDIRECT_PROJECT_RELATION_TABLES = [
  "o_scriptAssets",
  "o_assets2Storyboard",
  "o_assetsRole2Audio",
  "o_eventChapter",
  "o_relay_callback_delivery",
] as const;

const INDIRECT_PROJECT_PARENT_TABLES = [
  "o_script",
  "o_novel",
  "o_event",
  "o_imageFlow",
] as const;

const PROJECT_CONTENT_WRITE_TABLES = [
  "o_agentWorkData",
  "o_agent_approval",
  "o_agent_delegation",
  "o_agent_delegation_usage",
  "o_agent_event",
  "o_agent_generation_quote",
  "o_agent_generation_review",
  "o_agent_message",
  "o_agent_review_report",
  "o_agent_run",
  "o_agent_step",
  "o_agent_thread",
  "o_assets",
  "o_canvas_asset",
  "o_canvas_command_mutation",
  "o_creation_session",
  "o_creation_session_mutation",
  "o_media_asset",
  "o_novel",
  "o_project_mutation",
  "o_relay_task",
  "o_script",
  "o_storyboard",
  "o_tasks",
  "o_user_video_enhance_task",
  "o_video",
  "o_videoTrack",
  "o_workflow_graph",
] as const;

async function ensureDeletionEvidenceGuards(
  database: Knex | Knex.Transaction,
): Promise<void> {
  const operationTable = quoteSqlIdentifier(DELETION_OPERATION_TABLE);
  const resourceAliasTable = quoteSqlIdentifier(
    DELETION_RESOURCE_ALIAS_TABLE,
  );
  const outboxTable = quoteSqlIdentifier(DELETION_OUTBOX_TABLE);
  if (isPostgresClient(database)) {
    const operationTrigger = quoteSqlIdentifier(
      DELETION_OPERATION_GUARD_TRIGGER,
    );
    const operationFunction = quoteSqlIdentifier(
      DELETION_OPERATION_GUARD_FUNCTION,
    );
    const resourceAliasTrigger = quoteSqlIdentifier(
      DELETION_RESOURCE_ALIAS_GUARD_TRIGGER,
    );
    const resourceAliasFunction = quoteSqlIdentifier(
      DELETION_RESOURCE_ALIAS_GUARD_FUNCTION,
    );
    const outboxTrigger = quoteSqlIdentifier(DELETION_OUTBOX_GUARD_TRIGGER);
    const outboxFunction = quoteSqlIdentifier(DELETION_OUTBOX_GUARD_FUNCTION);
    await database.raw(`
      CREATE OR REPLACE FUNCTION ${operationFunction}()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION '${DELETION_OPERATION_TABLE} is durable evidence'
            USING ERRCODE = '55000';
        END IF;
        IF OLD."status" = 'completed' THEN
          RAISE EXCEPTION 'completed deletion operation is immutable'
            USING ERRCODE = '55000';
        END IF;
        IF NEW."id" IS DISTINCT FROM OLD."id"
          OR NEW."operationKey" IS DISTINCT FROM OLD."operationKey"
          OR NEW."kind" IS DISTINCT FROM OLD."kind"
          OR NEW."workspaceId" IS DISTINCT FROM OLD."workspaceId"
          OR NEW."projectId" IS DISTINCT FROM OLD."projectId"
          OR NEW."resourceId" IS DISTINCT FROM OLD."resourceId"
          OR NEW."requestHash" IS DISTINCT FROM OLD."requestHash"
          OR NEW."requestedBy" IS DISTINCT FROM OLD."requestedBy"
          OR NEW."requestedAt" IS DISTINCT FROM OLD."requestedAt"
          OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
        THEN
          RAISE EXCEPTION 'deletion operation identity is immutable'
            USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await database.raw(
      `DROP TRIGGER IF EXISTS ${operationTrigger} ON ${operationTable}`,
    );
    await database.raw(`
      CREATE TRIGGER ${operationTrigger}
      BEFORE UPDATE OR DELETE ON ${operationTable}
      FOR EACH ROW EXECUTE FUNCTION ${operationFunction}()
    `);
    await database.raw(`
      CREATE OR REPLACE FUNCTION ${resourceAliasFunction}()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION '${DELETION_RESOURCE_ALIAS_TABLE} is durable evidence'
            USING ERRCODE = '55000';
        END IF;
        IF TG_OP = 'UPDATE' THEN
          RAISE EXCEPTION 'deletion resource alias is immutable'
            USING ERRCODE = '55000';
        END IF;
        PERFORM 1
        FROM ${operationTable} AS operation
        WHERE operation."id" = NEW."operationId"
          AND operation."kind" = 'asset'
          AND operation."workspaceId" = NEW."workspaceId"
          AND operation."projectId" = NEW."projectId"
        FOR SHARE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'deletion resource alias authority is invalid'
            USING ERRCODE = '23503';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await database.raw(
      `DROP TRIGGER IF EXISTS ${resourceAliasTrigger} ON ${resourceAliasTable}`,
    );
    await database.raw(`
      CREATE TRIGGER ${resourceAliasTrigger}
      BEFORE INSERT OR UPDATE OR DELETE ON ${resourceAliasTable}
      FOR EACH ROW EXECUTE FUNCTION ${resourceAliasFunction}()
    `);
    await database.raw(`
      CREATE OR REPLACE FUNCTION ${outboxFunction}()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          PERFORM 1
          FROM ${operationTable} AS operation
          WHERE operation."id" = NEW."operationId"
            AND operation."status" IN ('preparing', 'deleting')
          FOR SHARE;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'deletion outbox parent operation is not writable'
              USING ERRCODE = '55000';
          END IF;
          RETURN NEW;
        END IF;
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION '${DELETION_OUTBOX_TABLE} is durable evidence'
            USING ERRCODE = '55000';
        END IF;
        IF OLD."status" IN ('completed', 'dead') THEN
          RAISE EXCEPTION 'terminal deletion outbox row is immutable'
            USING ERRCODE = '55000';
        END IF;
        IF NEW."id" IS DISTINCT FROM OLD."id"
          OR NEW."operationId" IS DISTINCT FROM OLD."operationId"
          OR NEW."dedupeKey" IS DISTINCT FROM OLD."dedupeKey"
          OR NEW."payloadHash" IS DISTINCT FROM OLD."payloadHash"
          OR NEW."resourceType" IS DISTINCT FROM OLD."resourceType"
          OR NEW."resourceId" IS DISTINCT FROM OLD."resourceId"
          OR NEW."bucket" IS DISTINCT FROM OLD."bucket"
          OR NEW."objectKey" IS DISTINCT FROM OLD."objectKey"
          OR NEW."deleteType" IS DISTINCT FROM OLD."deleteType"
          OR NEW."targetGeneration" IS DISTINCT FROM OLD."targetGeneration"
          OR NEW."conditionalToken" IS DISTINCT FROM OLD."conditionalToken"
          OR NEW."maxRetries" IS DISTINCT FROM OLD."maxRetries"
          OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
        THEN
          RAISE EXCEPTION 'deletion outbox target evidence is immutable'
            USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await database.raw(
      `DROP TRIGGER IF EXISTS ${outboxTrigger} ON ${outboxTable}`,
    );
    await database.raw(`
      CREATE TRIGGER ${outboxTrigger}
      BEFORE INSERT OR UPDATE OR DELETE ON ${outboxTable}
      FOR EACH ROW EXECUTE FUNCTION ${outboxFunction}()
    `);
    return;
  }

  await database.raw(`
    CREATE TRIGGER IF NOT EXISTS ${quoteSqlIdentifier(`${DELETION_OPERATION_GUARD_TRIGGER}_identity`)}
    BEFORE UPDATE OF
      "id", "operationKey", "kind", "workspaceId", "projectId",
      "resourceId", "requestHash", "requestedBy", "requestedAt", "createdAt"
    ON ${operationTable}
    BEGIN
      SELECT RAISE(ABORT, 'deletion operation identity is immutable');
    END
  `);
  await database.raw(`
    CREATE TRIGGER IF NOT EXISTS ${quoteSqlIdentifier(`${DELETION_OPERATION_GUARD_TRIGGER}_terminal`)}
    BEFORE UPDATE ON ${operationTable}
    FOR EACH ROW WHEN OLD."status" = 'completed'
    BEGIN
      SELECT RAISE(ABORT, 'completed deletion operation is immutable');
    END
  `);
  await database.raw(`
    CREATE TRIGGER IF NOT EXISTS ${quoteSqlIdentifier(`${DELETION_OPERATION_GUARD_TRIGGER}_delete`)}
    BEFORE DELETE ON ${operationTable}
    BEGIN
      SELECT RAISE(ABORT, '${DELETION_OPERATION_TABLE} is durable evidence');
    END
  `);
  await database.raw(`
    CREATE TRIGGER IF NOT EXISTS ${quoteSqlIdentifier(`${DELETION_RESOURCE_ALIAS_GUARD_TRIGGER}_parent`)}
    BEFORE INSERT ON ${resourceAliasTable}
    FOR EACH ROW WHEN NOT EXISTS (
      SELECT 1
      FROM ${operationTable} AS operation
      WHERE operation."id" = NEW."operationId"
        AND operation."kind" = 'asset'
        AND operation."workspaceId" = NEW."workspaceId"
        AND operation."projectId" = NEW."projectId"
    )
    BEGIN
      SELECT RAISE(
        ABORT,
        'deletion resource alias authority is invalid'
      );
    END
  `);
  await database.raw(`
    CREATE TRIGGER IF NOT EXISTS ${quoteSqlIdentifier(`${DELETION_RESOURCE_ALIAS_GUARD_TRIGGER}_update`)}
    BEFORE UPDATE ON ${resourceAliasTable}
    BEGIN
      SELECT RAISE(ABORT, 'deletion resource alias is immutable');
    END
  `);
  await database.raw(`
    CREATE TRIGGER IF NOT EXISTS ${quoteSqlIdentifier(`${DELETION_RESOURCE_ALIAS_GUARD_TRIGGER}_delete`)}
    BEFORE DELETE ON ${resourceAliasTable}
    BEGIN
      SELECT RAISE(
        ABORT,
        '${DELETION_RESOURCE_ALIAS_TABLE} is durable evidence'
      );
    END
  `);
  await database.raw(`
    CREATE TRIGGER IF NOT EXISTS ${quoteSqlIdentifier(`${DELETION_OUTBOX_GUARD_TRIGGER}_parent`)}
    BEFORE INSERT ON ${outboxTable}
    FOR EACH ROW WHEN NOT EXISTS (
      SELECT 1
      FROM ${operationTable} AS operation
      WHERE operation."id" = NEW."operationId"
        AND operation."status" IN ('preparing', 'deleting')
    )
    BEGIN
      SELECT RAISE(
        ABORT,
        'deletion outbox parent operation is not writable'
      );
    END
  `);
  await database.raw(`
    CREATE TRIGGER IF NOT EXISTS ${quoteSqlIdentifier(`${DELETION_OUTBOX_GUARD_TRIGGER}_identity`)}
    BEFORE UPDATE OF
      "id", "operationId", "dedupeKey", "payloadHash", "resourceType",
      "resourceId", "bucket", "objectKey", "deleteType", "targetGeneration",
      "conditionalToken", "maxRetries", "createdAt"
    ON ${outboxTable}
    BEGIN
      SELECT RAISE(ABORT, 'deletion outbox target evidence is immutable');
    END
  `);
  await database.raw(`
    CREATE TRIGGER IF NOT EXISTS ${quoteSqlIdentifier(`${DELETION_OUTBOX_GUARD_TRIGGER}_terminal`)}
    BEFORE UPDATE ON ${outboxTable}
    FOR EACH ROW WHEN OLD."status" IN ('completed', 'dead')
    BEGIN
      SELECT RAISE(ABORT, 'terminal deletion outbox row is immutable');
    END
  `);
  await database.raw(`
    CREATE TRIGGER IF NOT EXISTS ${quoteSqlIdentifier(`${DELETION_OUTBOX_GUARD_TRIGGER}_delete`)}
    BEFORE DELETE ON ${outboxTable}
    BEGIN
      SELECT RAISE(ABORT, '${DELETION_OUTBOX_TABLE} is durable evidence');
    END
  `);
}

async function storageReservationKeysForTarget(
  database: Knex | Knex.Transaction,
  target: StorageKeyReservationTarget,
): Promise<StorageKeyReservationTarget["keys"]> {
  const keys: StorageKeyReservationTarget["keys"] = [];
  for (const key of target.keys) {
    if (!(await database.schema.hasColumn(
      target.table,
      key.authoritative,
    ))) continue;
    if (
      key.legacy
      && !(await database.schema.hasColumn(target.table, key.legacy))
    ) {
      keys.push({ authoritative: key.authoritative });
      continue;
    }
    keys.push(key);
  }
  return keys;
}

function sqliteStorageReservationPredicate(
  keys: StorageKeyReservationTarget["keys"],
): string {
  return keys.map((key) => {
    const authoritative = `NEW.${quoteSqlIdentifier(key.authoritative)}`;
    const authoritativeMatch =
      `(NULLIF(TRIM(${authoritative}), '') IS NOT NULL`
      + ` AND outbox."objectKey" = ${authoritative})`;
    if (!key.legacy) return authoritativeMatch;
    const legacy = `NEW.${quoteSqlIdentifier(key.legacy)}`;
    return `(${authoritativeMatch} OR (`
      + `NULLIF(TRIM(${authoritative}), '') IS NULL`
      + ` AND NULLIF(TRIM(${legacy}), '') IS NOT NULL`
      + ` AND (${legacy} = outbox."objectKey"`
      + ` OR ${legacy} = '/' || outbox."objectKey")))`;
  }).join("\n            OR ");
}

async function ensureImageDeletionStorageKeyReservationGuards(
  database: Knex | Knex.Transaction,
): Promise<void> {
  const operationTable = quoteSqlIdentifier(DELETION_OPERATION_TABLE);
  const outboxTable = quoteSqlIdentifier(DELETION_OUTBOX_TABLE);

  if (isPostgresClient(database)) {
    const guardFunction = quoteSqlIdentifier(
      IMAGE_DELETION_STORAGE_KEY_GUARD_FUNCTION,
    );
    await database.raw(`
      CREATE OR REPLACE FUNCTION ${guardFunction}()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      DECLARE
        target_project_id bigint;
        target_resource_id text;
        argument_index integer;
        authoritative_column text;
        legacy_column text;
        authoritative_value text;
        legacy_value text;
        allow_target_tombstone_update boolean;
      BEGIN
        IF TG_ARGV[0] = 'project' THEN
          target_project_id := NULLIF(to_jsonb(NEW) ->> 'id', '')::bigint;
        ELSIF TG_ARGV[0] = 'image' THEN
          target_resource_id := to_jsonb(NEW) ->> 'id';
          SELECT asset."projectId"
          INTO target_project_id
          FROM "o_assets" AS asset
          INNER JOIN "o_project" AS project
            ON project."id" = asset."projectId"
          WHERE asset."id" = NULLIF(
            to_jsonb(NEW) ->> 'assetsId',
            ''
          )::bigint
          FOR SHARE OF asset, project;
        ELSE
          target_project_id := NULLIF(
            to_jsonb(NEW) ->> 'projectId',
            ''
          )::bigint;
          PERFORM 1
          FROM "o_project" AS project
          WHERE project."id" = target_project_id
          FOR SHARE;
        END IF;

        IF target_project_id IS NULL THEN
          RETURN NEW;
        END IF;
        IF TG_ARGV[0] = 'project' THEN
          PERFORM 1
          FROM "o_project" AS project
          WHERE project."id" = target_project_id
          FOR SHARE;
        END IF;

        FOR argument_index IN 1..(TG_NARGS - 1) BY 2 LOOP
          authoritative_column := TG_ARGV[argument_index];
          legacy_column := TG_ARGV[argument_index + 1];
          authoritative_value :=
            to_jsonb(NEW) ->> authoritative_column;
          IF authoritative_value IS NOT NULL
            AND btrim(authoritative_value) = ''
          THEN
            authoritative_value := NULL;
          END IF;
          legacy_value := CASE
            WHEN legacy_column = '' THEN NULL
            ELSE to_jsonb(NEW) ->> legacy_column
          END;
          IF legacy_value IS NOT NULL AND btrim(legacy_value) = '' THEN
            legacy_value := NULL;
          END IF;

          allow_target_tombstone_update := FALSE;
          IF TG_OP = 'UPDATE'
            AND NULLIF(
              to_jsonb(NEW) ->> 'deletionOperationId',
              ''
            ) IS NOT NULL
          THEN
            allow_target_tombstone_update :=
              (to_jsonb(NEW) ->> authoritative_column)
                IS NOT DISTINCT FROM
              (to_jsonb(OLD) ->> authoritative_column)
              AND (
                legacy_column = ''
                OR (to_jsonb(NEW) ->> legacy_column)
                  IS NOT DISTINCT FROM
                (to_jsonb(OLD) ->> legacy_column)
              );
          END IF;

          PERFORM 1
          FROM ${operationTable} AS operation
          INNER JOIN ${outboxTable} AS outbox
            ON outbox."operationId" = operation."id"
          WHERE operation."kind" IN ('image', 'asset')
            AND operation."status" IN ('preparing', 'deleting')
            AND operation."projectId" = target_project_id
            AND (
              (
                authoritative_value IS NOT NULL
                AND outbox."objectKey" = authoritative_value
              )
              OR (
                authoritative_value IS NULL
                AND legacy_value IS NOT NULL
                AND (
                  legacy_value = outbox."objectKey"
                  OR legacy_value = '/' || outbox."objectKey"
                )
              )
            )
            AND NOT (
              allow_target_tombstone_update
              AND operation."id" = (
                to_jsonb(NEW) ->> 'deletionOperationId'
              )
            )
          LIMIT 1
          FOR SHARE OF operation, outbox;
          IF FOUND THEN
            RAISE EXCEPTION
              'storage key is reserved by an active image deletion'
              USING ERRCODE = '55000';
          END IF;
        END LOOP;
        RETURN NEW;
      END;
      $$
    `);

    for (const target of IMAGE_DELETION_STORAGE_KEY_RESERVATION_TARGETS) {
      if (!(await database.schema.hasTable(target.table))) continue;
      const keys = await storageReservationKeysForTarget(database, target);
      if (!keys.length) continue;
      const table = quoteSqlIdentifier(target.table);
      const trigger = quoteSqlIdentifier(
        `trg_${target.table.slice(2)}_storage_key_reservation_guard`,
      );
      const argumentsSql = [
        target.projectScope,
        ...keys.flatMap((key) => [
          key.authoritative,
          key.legacy ?? "",
        ]),
      ].map((value) => `'${value.replaceAll("'", "''")}'`).join(", ");
      await database.raw(`DROP TRIGGER IF EXISTS ${trigger} ON ${table}`);
      await database.raw(`
        CREATE TRIGGER ${trigger}
        BEFORE INSERT OR UPDATE ON ${table}
        FOR EACH ROW EXECUTE FUNCTION ${guardFunction}(${argumentsSql})
      `);
    }
    return;
  }

  for (const target of IMAGE_DELETION_STORAGE_KEY_RESERVATION_TARGETS) {
    if (!(await database.schema.hasTable(target.table))) continue;
    const keys = await storageReservationKeysForTarget(database, target);
    if (!keys.length) continue;
    const table = quoteSqlIdentifier(target.table);
    const projectId = target.projectScope === "project"
      ? 'NEW."id"'
      : target.projectScope === "image"
      ? '(SELECT asset."projectId" FROM "o_assets" AS asset'
        + ' WHERE asset."id" = NEW."assetsId")'
      : 'NEW."projectId"';
    const keyPredicate = sqliteStorageReservationPredicate(keys);
    const unchangedKeyPredicate = keys
      .flatMap((key) => [key.authoritative, key.legacy].filter(
        (columnName): columnName is string => Boolean(columnName),
      ))
      .map((columnName) =>
        `OLD.${quoteSqlIdentifier(columnName)}`
          + ` IS NEW.${quoteSqlIdentifier(columnName)}`)
      .join("\n              AND ");
    const triggerBase =
      `trg_${target.table.slice(2)}_storage_key_reservation_guard`;
    const hasDeletionOperationId = await database.schema.hasColumn(
      target.table,
      "deletionOperationId",
    );
    const reservationExists = (allowTargetTombstoneUpdate: boolean) => `
      EXISTS (
        SELECT 1
        FROM ${operationTable} AS operation
        INNER JOIN ${outboxTable} AS outbox
          ON outbox."operationId" = operation."id"
        WHERE operation."kind" IN ('image', 'asset')
          AND operation."status" IN ('preparing', 'deleting')
          AND operation."projectId" = ${projectId}
          AND (
            ${keyPredicate}
          )
          ${allowTargetTombstoneUpdate
            ? `AND NOT (
              operation."id" = NEW."deletionOperationId"
              AND ${unchangedKeyPredicate}
            )`
            : ""}
      )
    `;
    await database.raw(`
      CREATE TRIGGER IF NOT EXISTS ${quoteSqlIdentifier(`${triggerBase}_insert`)}
      BEFORE INSERT ON ${table}
      FOR EACH ROW WHEN ${reservationExists(false)}
      BEGIN
        SELECT RAISE(
          ABORT,
          'storage key is reserved by an active image deletion'
        );
      END
    `);
    await database.raw(`
      CREATE TRIGGER IF NOT EXISTS ${quoteSqlIdentifier(`${triggerBase}_update`)}
      BEFORE UPDATE ON ${table}
      FOR EACH ROW WHEN ${reservationExists(
        hasDeletionOperationId,
      )}
      BEGIN
        SELECT RAISE(
          ABORT,
          'storage key is reserved by an active image deletion'
        );
      END
    `);
  }
}

async function ensureProjectDeletionWriteGuards(
  database: Knex | Knex.Transaction,
): Promise<void> {
  for (const tableName of PROJECT_CONTENT_WRITE_TABLES) {
    if (
      !(await database.schema.hasTable(tableName))
      || !(await database.schema.hasColumn(tableName, "projectId"))
      || !(await database.schema.hasColumn(tableName, "workspaceId"))
    ) continue;
    const mismatch = await database(`${tableName} as scoped`)
      .leftJoin(
        "o_project as project",
        "project.id",
        "scoped.projectId",
      )
      .whereNotNull("scoped.projectId")
      .andWhere((query) => {
        query.whereNull("project.id").orWhereRaw(
          isPostgresClient(database)
            ? "?? IS DISTINCT FROM ??"
            : "?? IS NOT ??",
          ["scoped.workspaceId", "project.workspaceId"],
        );
      })
      .select("scoped.projectId", "scoped.workspaceId")
      .first();
    if (mismatch) {
      throw new Error(
        `Migration deletion_workflow found cross-workspace project ownership in ${tableName}`,
      );
    }
  }
  const projectTable = quoteSqlIdentifier("o_project");
  const operationTable = quoteSqlIdentifier(DELETION_OPERATION_TABLE);
  if (isPostgresClient(database)) {
    const stateFunction = quoteSqlIdentifier(PROJECT_STATE_GUARD_FUNCTION);
    const stateTrigger = quoteSqlIdentifier(PROJECT_STATE_GUARD_TRIGGER);
    const writeFunction = quoteSqlIdentifier(PROJECT_WRITE_GUARD_FUNCTION);
    const imageFunction = quoteSqlIdentifier(IMAGE_WRITE_GUARD_FUNCTION);
    const assetStateFunction = quoteSqlIdentifier(
      ASSET_STATE_GUARD_FUNCTION,
    );
    const assetImageFunction = quoteSqlIdentifier(
      ASSET_IMAGE_REFERENCE_GUARD_FUNCTION,
    );
    await database.raw(`
      CREATE OR REPLACE FUNCTION ${stateFunction}()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'o_project deletion requires durable tombstone workflow'
            USING ERRCODE = '55000';
        END IF;
        IF TG_OP = 'INSERT' THEN
          IF COALESCE(NEW."deletionState", 'active') <> 'active'
            OR NEW."deletionOperationId" IS NOT NULL
            OR NEW."deletionRequestedAt" IS NOT NULL
            OR NEW."deletionFinalizeFence" IS NOT NULL
          THEN
            RAISE EXCEPTION 'new project must be active' USING ERRCODE = '55000';
          END IF;
          RETURN NEW;
        END IF;
        IF NEW."id" IS DISTINCT FROM OLD."id"
          OR NEW."workspaceId" IS DISTINCT FROM OLD."workspaceId"
          OR NOT (
            (
              OLD."deletionState" = 'active'
              AND NEW."deletionState" = 'active'
              AND NEW."deletionOperationId" IS NULL
              AND NEW."deletionRequestedAt" IS NULL
              AND NEW."deletionFinalizeFence" IS NULL
            )
            OR (
              OLD."deletionState" = 'active'
              AND NEW."deletionState" = 'deleting'
              AND NEW."deletionOperationId" IS NOT NULL
              AND NEW."deletionRequestedAt" IS NOT NULL
              AND NEW."deletionFinalizeFence" IS NULL
              AND EXISTS (
                SELECT 1
                FROM ${operationTable} AS operation
                WHERE operation."id" = NEW."deletionOperationId"
                  AND operation."kind" = 'project'
                  AND operation."workspaceId" = OLD."workspaceId"
                  AND operation."projectId" = OLD."id"
                  AND operation."resourceId" = OLD."id"::text
                  AND operation."status" = 'preparing'
                  AND operation."requestedAt" = NEW."deletionRequestedAt"
              )
            )
            OR (
              OLD."deletionState" = 'deleting'
              AND NEW."deletionState" = 'finalizing'
              AND NEW."deletionOperationId" = OLD."deletionOperationId"
              AND NEW."deletionRequestedAt" = OLD."deletionRequestedAt"
              AND NEW."deletionFinalizeFence" IS NOT NULL
              AND EXISTS (
                SELECT 1
                FROM ${operationTable} AS operation
                WHERE operation."id" = OLD."deletionOperationId"
                  AND operation."kind" = 'project'
                  AND operation."projectId" = OLD."id"
                  AND operation."status" = 'deleting'
                  AND operation."coordinatorLeaseOwner" IS NOT NULL
                  AND operation."coordinatorFence" = NEW."deletionFinalizeFence"
                  AND operation."coordinatorLeaseExpiresAt"
                    > floor(extract(epoch FROM clock_timestamp()) * 1000)
              )
            )
            OR (
              OLD."deletionState" = 'finalizing'
              AND NEW."deletionState" = 'finalizing'
              AND NEW."deletionOperationId" = OLD."deletionOperationId"
              AND NEW."deletionRequestedAt" = OLD."deletionRequestedAt"
              AND OLD."deletionFinalizeFence" IS NOT NULL
              AND NEW."deletionFinalizeFence" > OLD."deletionFinalizeFence"
              AND EXISTS (
                SELECT 1
                FROM ${operationTable} AS operation
                WHERE operation."id" = OLD."deletionOperationId"
                  AND operation."kind" = 'project'
                  AND operation."workspaceId" = OLD."workspaceId"
                  AND operation."projectId" = OLD."id"
                  AND operation."resourceId" = OLD."id"::text
                  AND operation."requestedAt" = OLD."deletionRequestedAt"
                  AND operation."status" = 'deleting'
                  AND operation."coordinatorLeaseOwner" IS NOT NULL
                  AND operation."coordinatorFence" = NEW."deletionFinalizeFence"
                  AND operation."coordinatorLeaseExpiresAt"
                    > floor(extract(epoch FROM clock_timestamp()) * 1000)
              )
            )
            OR (
              OLD."deletionState" = 'finalizing'
              AND NEW."deletionState" = 'deleted'
              AND NEW."deletionOperationId" = OLD."deletionOperationId"
              AND NEW."deletionRequestedAt" = OLD."deletionRequestedAt"
              AND NEW."deletionFinalizeFence" = OLD."deletionFinalizeFence"
              AND EXISTS (
                SELECT 1
                FROM ${operationTable} AS operation
                WHERE operation."id" = OLD."deletionOperationId"
                  AND operation."kind" = 'project'
                  AND operation."workspaceId" = OLD."workspaceId"
                  AND operation."projectId" = OLD."id"
                  AND operation."resourceId" = OLD."id"::text
                  AND operation."requestedAt" = OLD."deletionRequestedAt"
                  AND operation."status" = 'deleting'
                  AND operation."coordinatorLeaseOwner" IS NOT NULL
                  AND operation."coordinatorFence" = OLD."deletionFinalizeFence"
                  AND operation."coordinatorLeaseExpiresAt"
                    > floor(extract(epoch FROM clock_timestamp()) * 1000)
              )
            )
          )
        THEN
          RAISE EXCEPTION 'invalid project deletion-state transition'
            USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await database.raw(`DROP TRIGGER IF EXISTS ${stateTrigger} ON ${projectTable}`);
    await database.raw(`
      CREATE TRIGGER ${stateTrigger}
      BEFORE INSERT OR UPDATE OR DELETE ON ${projectTable}
      FOR EACH ROW EXECUTE FUNCTION ${stateFunction}()
    `);
    await database.raw(`
      CREATE OR REPLACE FUNCTION ${writeFunction}()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      DECLARE
        project_state text;
        project_workspace_id text;
        target_project_id bigint;
        target_workspace_id text;
        project_finalizer_live boolean;
      BEGIN
        target_project_id := CASE
          WHEN TG_OP = 'DELETE' THEN OLD."projectId"
          ELSE NEW."projectId"
        END;
        IF TG_NARGS > 0 AND TG_ARGV[0] = 'workspace' THEN
          target_workspace_id := CASE
            WHEN TG_OP = 'DELETE' THEN OLD."workspaceId"
            ELSE NEW."workspaceId"
          END;
        END IF;
        IF TG_TABLE_NAME = 'o_user_video_enhance_task' THEN
          IF (
            (TG_OP = 'INSERT' AND NEW."projectId" IS NULL)
            OR (
              TG_OP = 'UPDATE'
              AND NEW."projectId" IS NULL
              AND NEW."status" IN ('created', 'enhancing')
            )
          ) THEN
            RAISE EXCEPTION 'active user enhance task requires project ownership'
              USING ERRCODE = '55000';
          END IF;
        END IF;
        IF target_project_id IS NOT NULL THEN
          project_state := NULL;
          project_workspace_id := NULL;
          project_finalizer_live := FALSE;
          SELECT
            project."deletionState",
            project."workspaceId",
            (
              project."deletionState" <> 'finalizing'
              OR EXISTS (
                SELECT 1
                FROM ${operationTable} AS operation
                WHERE operation."id" = project."deletionOperationId"
                  AND operation."kind" = 'project'
                  AND operation."workspaceId" = project."workspaceId"
                  AND operation."projectId" = project."id"
                  AND operation."resourceId" = project."id"::text
                  AND operation."requestedAt" =
                    project."deletionRequestedAt"
                  AND operation."status" = 'deleting'
                  AND operation."coordinatorLeaseOwner" IS NOT NULL
                  AND operation."coordinatorFence" =
                    project."deletionFinalizeFence"
                  AND operation."coordinatorLeaseExpiresAt"
                    > floor(
                      extract(epoch FROM clock_timestamp()) * 1000
                    )
              )
            )
          INTO
            project_state,
            project_workspace_id,
            project_finalizer_live
          FROM "o_project" AS project
          WHERE project."id" = target_project_id
          FOR SHARE OF project;
          IF TG_NARGS > 0
            AND TG_ARGV[0] = 'workspace'
            AND target_workspace_id IS DISTINCT FROM project_workspace_id
          THEN
            RAISE EXCEPTION 'project workspace ownership mismatch'
              USING ERRCODE = '55000';
          END IF;
          IF TG_OP = 'DELETE' THEN
            IF project_state IS NULL
              OR project_state NOT IN ('active', 'finalizing')
              OR (
                project_state = 'finalizing'
                AND NOT project_finalizer_live
              )
            THEN
              RAISE EXCEPTION 'project is not active'
                USING ERRCODE = '55000';
            END IF;
          ELSIF TG_OP = 'INSERT' AND project_state IS DISTINCT FROM 'active' THEN
            RAISE EXCEPTION 'project is not active' USING ERRCODE = '55000';
          ELSIF TG_OP = 'UPDATE'
            AND (
              project_state IS NULL
              OR project_state NOT IN ('active', 'finalizing')
              OR (
                project_state = 'finalizing'
                AND NOT project_finalizer_live
              )
            )
          THEN
            RAISE EXCEPTION 'project is not active' USING ERRCODE = '55000';
          END IF;
        END IF;
        IF (
          TG_OP = 'UPDATE'
          AND OLD."projectId" IS NOT NULL
          AND OLD."projectId" IS DISTINCT FROM NEW."projectId"
        ) THEN
          project_state := NULL;
          project_finalizer_live := FALSE;
          SELECT
            project."deletionState",
            (
              project."deletionState" <> 'finalizing'
              OR EXISTS (
                SELECT 1
                FROM ${operationTable} AS operation
                WHERE operation."id" = project."deletionOperationId"
                  AND operation."kind" = 'project'
                  AND operation."workspaceId" = project."workspaceId"
                  AND operation."projectId" = project."id"
                  AND operation."resourceId" = project."id"::text
                  AND operation."requestedAt" =
                    project."deletionRequestedAt"
                  AND operation."status" = 'deleting'
                  AND operation."coordinatorLeaseOwner" IS NOT NULL
                  AND operation."coordinatorFence" =
                    project."deletionFinalizeFence"
                  AND operation."coordinatorLeaseExpiresAt"
                    > floor(
                      extract(epoch FROM clock_timestamp()) * 1000
                    )
              )
            )
          INTO project_state, project_finalizer_live
          FROM "o_project" AS project
          WHERE project."id" = OLD."projectId"
          FOR SHARE OF project;
          IF project_state IS NULL
            OR project_state NOT IN ('active', 'finalizing')
            OR (
              project_state = 'finalizing'
              AND NOT project_finalizer_live
            )
          THEN
            RAISE EXCEPTION 'project is not active' USING ERRCODE = '55000';
          END IF;
        END IF;
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
      END;
      $$
    `);
    for (const tableName of PROJECT_CONTENT_WRITE_TABLES) {
      if (
        !(await database.schema.hasTable(tableName))
        || !(await database.schema.hasColumn(tableName, "projectId"))
      ) continue;
      const table = quoteSqlIdentifier(tableName);
      const trigger = quoteSqlIdentifier(
        `trg_${tableName.slice(2)}_active_project_write`,
      );
      const hasWorkspaceId = await database.schema.hasColumn(
        tableName,
        "workspaceId",
      );
      await database.raw(`DROP TRIGGER IF EXISTS ${trigger} ON ${table}`);
      await database.raw(`
        CREATE TRIGGER ${trigger}
        BEFORE INSERT OR UPDATE OR DELETE ON ${table}
        FOR EACH ROW EXECUTE FUNCTION ${writeFunction}(
          ${hasWorkspaceId ? "'workspace'" : ""}
        )
      `);
    }
    if (await database.schema.hasTable("o_tasks")) {
      const taskTable = quoteSqlIdentifier("o_tasks");
      const taskTrigger = quoteSqlIdentifier(
        TASK_OUTPUT_EVIDENCE_GUARD_TRIGGER,
      );
      const taskFunction = quoteSqlIdentifier(
        TASK_OUTPUT_EVIDENCE_GUARD_FUNCTION,
      );
      await database.raw(`
        CREATE OR REPLACE FUNCTION ${taskFunction}()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        DECLARE
          old_evidence jsonb;
          old_output_key text;
        BEGIN
          BEGIN
            old_evidence := OLD."relatedObjects"::jsonb;
          EXCEPTION WHEN invalid_text_representation THEN
            RETURN NEW;
          END;
          old_output_key := NULLIF(
            btrim(old_evidence->>'outputStorageKey'),
            ''
          );
          IF old_output_key IS NOT NULL
            AND (
              NEW."projectId" IS DISTINCT FROM OLD."projectId"
              OR NEW."relatedObjects" IS DISTINCT FROM OLD."relatedObjects"
            )
          THEN
            RAISE EXCEPTION 'task output evidence is immutable'
              USING ERRCODE = '55000';
          END IF;
          RETURN NEW;
        END;
        $$
      `);
      await database.raw(
        `DROP TRIGGER IF EXISTS ${taskTrigger} ON ${taskTable}`,
      );
      await database.raw(`
        CREATE TRIGGER ${taskTrigger}
        BEFORE UPDATE ON ${taskTable}
        FOR EACH ROW EXECUTE FUNCTION ${taskFunction}()
      `);
    }
    if (await database.schema.hasTable("o_image")) {
      const imageTable = quoteSqlIdentifier("o_image");
      const imageTrigger = quoteSqlIdentifier(
        "trg_o_image_active_project_write",
      );
      await database.raw(`
        CREATE OR REPLACE FUNCTION ${imageFunction}()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        DECLARE
          image_project_id bigint;
          project_state text;
          asset_state text;
          image_state text;
          operation_id text;
          requested_at bigint;
          finalize_fence bigint;
          project_finalizer_live boolean;
        BEGIN
          IF TG_OP = 'DELETE' THEN
            image_state := OLD."deletionState";
            operation_id := OLD."deletionOperationId";
            requested_at := OLD."deletionRequestedAt";
            finalize_fence := OLD."deletionFinalizeFence";
          ELSE
            image_state := NEW."deletionState";
            operation_id := NEW."deletionOperationId";
            requested_at := NEW."deletionRequestedAt";
            finalize_fence := NEW."deletionFinalizeFence";
          END IF;

          SELECT
            asset."projectId",
            project."deletionState",
            asset."deletionState",
            (
              project."deletionState" <> 'finalizing'
              OR EXISTS (
                SELECT 1
                FROM ${operationTable} AS project_operation
                WHERE project_operation."id" =
                    project."deletionOperationId"
                  AND project_operation."kind" = 'project'
                  AND project_operation."workspaceId" =
                    project."workspaceId"
                  AND project_operation."projectId" = project."id"
                  AND project_operation."resourceId" =
                    project."id"::text
                  AND project_operation."requestedAt" =
                    project."deletionRequestedAt"
                  AND project_operation."status" = 'deleting'
                  AND project_operation."coordinatorLeaseOwner" IS NOT NULL
                  AND project_operation."coordinatorFence" =
                    project."deletionFinalizeFence"
                  AND project_operation."coordinatorLeaseExpiresAt"
                    > floor(
                      extract(epoch FROM clock_timestamp()) * 1000
                    )
              )
            )
          INTO
            image_project_id,
            project_state,
            asset_state,
            project_finalizer_live
          FROM "o_assets" AS asset
          INNER JOIN "o_project" AS project ON project."id" = asset."projectId"
          WHERE asset."id" = CASE
            WHEN TG_OP = 'DELETE' THEN OLD."assetsId"
            ELSE NEW."assetsId"
          END
          FOR SHARE OF asset, project;
          IF image_project_id IS NULL THEN
            RAISE EXCEPTION 'image project ownership is invalid'
              USING ERRCODE = '55000';
          END IF;

          IF TG_OP = 'INSERT' THEN
            IF project_state <> 'active'
              OR asset_state <> 'active'
              OR COALESCE(image_state, 'active') <> 'active'
              OR operation_id IS NOT NULL
              OR requested_at IS NOT NULL
              OR finalize_fence IS NOT NULL
            THEN
              RAISE EXCEPTION 'new image must belong to an active project'
                USING ERRCODE = '55000';
            END IF;
            RETURN NEW;
          END IF;

          IF TG_OP = 'DELETE' THEN
            IF project_state = 'finalizing'
              AND project_finalizer_live
            THEN
              RETURN OLD;
            END IF;
            IF image_state <> 'finalizing'
              OR finalize_fence IS NULL
              OR NOT EXISTS (
                SELECT 1
                FROM ${operationTable} AS operation
                WHERE operation."id" = operation_id
                  AND operation."projectId" = image_project_id
                  AND (
                    (
                      operation."kind" = 'image'
                      AND operation."resourceId" = OLD."id"::text
                    )
                    OR (
                      operation."kind" = 'asset'
                      AND (
                        operation."resourceId" = OLD."assetsId"::text
                        OR operation."resourceId" = (
                          SELECT parent."assetsId"::text
                          FROM "o_assets" AS parent
                          WHERE parent."id" = OLD."assetsId"
                        )
                      )
                    )
                  )
                  AND operation."status" = 'deleting'
                  AND operation."coordinatorLeaseOwner" IS NOT NULL
                  AND operation."coordinatorFence" = finalize_fence
                  AND operation."coordinatorLeaseExpiresAt"
                    > floor(extract(epoch FROM clock_timestamp()) * 1000)
              )
            THEN
              RAISE EXCEPTION 'image delete requires durable finalizer'
                USING ERRCODE = '55000';
            END IF;
            RETURN OLD;
          END IF;

          IF project_state <> 'active'
            OR NEW."id" IS DISTINCT FROM OLD."id"
            OR NEW."assetsId" IS DISTINCT FROM OLD."assetsId"
            OR NOT (
              (
                OLD."deletionState" = 'active'
                AND NEW."deletionState" = 'active'
                AND asset_state = 'active'
                AND NEW."deletionOperationId" IS NULL
                AND NEW."deletionRequestedAt" IS NULL
                AND NEW."deletionFinalizeFence" IS NULL
              )
              OR (
                OLD."deletionState" = 'active'
                AND NEW."deletionState" = 'deleting'
                AND NEW."deletionOperationId" IS NOT NULL
                AND NEW."deletionRequestedAt" IS NOT NULL
                AND NEW."deletionFinalizeFence" IS NULL
                AND EXISTS (
                  SELECT 1
                  FROM ${operationTable} AS operation
                  WHERE operation."id" = NEW."deletionOperationId"
                    AND operation."projectId" = image_project_id
                    AND (
                      (
                        operation."kind" = 'image'
                        AND operation."resourceId" = NEW."id"::text
                      )
                      OR (
                        operation."kind" = 'asset'
                        AND (
                          operation."resourceId" = NEW."assetsId"::text
                          OR operation."resourceId" = (
                            SELECT parent."assetsId"::text
                            FROM "o_assets" AS parent
                            WHERE parent."id" = NEW."assetsId"
                          )
                        )
                      )
                    )
                    AND operation."status" = 'deleting'
                )
              )
              OR (
                OLD."deletionState" = 'deleting'
                AND NEW."deletionState" = 'finalizing'
                AND NEW."deletionOperationId" = OLD."deletionOperationId"
                AND NEW."deletionRequestedAt" = OLD."deletionRequestedAt"
                AND NEW."deletionFinalizeFence" IS NOT NULL
                AND EXISTS (
                  SELECT 1
                  FROM ${operationTable} AS operation
                  WHERE operation."id" = NEW."deletionOperationId"
                    AND operation."projectId" = image_project_id
                    AND (
                      (
                        operation."kind" = 'image'
                        AND operation."resourceId" = NEW."id"::text
                      )
                      OR (
                        operation."kind" = 'asset'
                        AND (
                          operation."resourceId" = NEW."assetsId"::text
                          OR operation."resourceId" = (
                            SELECT parent."assetsId"::text
                            FROM "o_assets" AS parent
                            WHERE parent."id" = NEW."assetsId"
                          )
                        )
                      )
                    )
                    AND operation."status" = 'deleting'
                    AND operation."coordinatorLeaseOwner" IS NOT NULL
                    AND operation."coordinatorFence" = NEW."deletionFinalizeFence"
                    AND operation."coordinatorLeaseExpiresAt"
                      > floor(extract(epoch FROM clock_timestamp()) * 1000)
                )
              )
            )
          THEN
            RAISE EXCEPTION 'invalid image deletion-state transition'
              USING ERRCODE = '55000';
          END IF;
          RETURN NEW;
        END;
        $$
      `);
      await database.raw(`DROP TRIGGER IF EXISTS ${imageTrigger} ON ${imageTable}`);
      await database.raw(`
        CREATE TRIGGER ${imageTrigger}
        BEFORE INSERT OR UPDATE OR DELETE ON ${imageTable}
        FOR EACH ROW EXECUTE FUNCTION ${imageFunction}()
      `);
    }
    if (await database.schema.hasTable("o_assets")) {
      const assetTable = quoteSqlIdentifier("o_assets");
      const assetStateTrigger = quoteSqlIdentifier(
        ASSET_STATE_GUARD_TRIGGER,
      );
      const assetTrigger = quoteSqlIdentifier(
        "trg_o_assets_image_reference_guard",
      );
      await database.raw(`
        CREATE OR REPLACE FUNCTION ${assetStateFunction}()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          IF TG_OP = 'INSERT' THEN
            IF COALESCE(NEW."deletionState", 'active') <> 'active'
              OR NEW."deletionOperationId" IS NOT NULL
              OR NEW."deletionRequestedAt" IS NOT NULL
              OR NEW."deletionFinalizeFence" IS NOT NULL
            THEN
              RAISE EXCEPTION 'new asset must be active'
                USING ERRCODE = '55000';
            END IF;
            RETURN NEW;
          END IF;

          IF TG_OP = 'UPDATE' THEN
            IF NEW."id" IS DISTINCT FROM OLD."id"
              OR NEW."projectId" IS DISTINCT FROM OLD."projectId"
              OR NEW."assetsId" IS DISTINCT FROM OLD."assetsId"
              OR NOT (
                (
                  OLD."deletionState" = 'active'
                  AND NEW."deletionState" = 'active'
                  AND NEW."deletionOperationId" IS NULL
                  AND NEW."deletionRequestedAt" IS NULL
                  AND NEW."deletionFinalizeFence" IS NULL
                )
                OR (
                  OLD."deletionState" = 'active'
                  AND NEW."deletionState" = 'deleting'
                  AND NEW."deletionOperationId" IS NOT NULL
                  AND NEW."deletionRequestedAt" IS NOT NULL
                  AND NEW."deletionFinalizeFence" IS NULL
                  AND EXISTS (
                    SELECT 1
                    FROM ${operationTable} AS operation
                    INNER JOIN "o_project" AS project
                      ON project."id" = OLD."projectId"
                    WHERE operation."id" = NEW."deletionOperationId"
                      AND operation."kind" = 'asset'
                      AND operation."workspaceId" = project."workspaceId"
                      AND operation."projectId" = OLD."projectId"
                      AND (
                        operation."resourceId" = OLD."id"::text
                        OR operation."resourceId" = OLD."assetsId"::text
                      )
                      AND operation."requestedAt" =
                        NEW."deletionRequestedAt"
                      AND operation."status" = 'deleting'
                  )
                )
                OR (
                  OLD."deletionState" = 'deleting'
                  AND NEW."deletionState" = 'finalizing'
                  AND NEW."deletionOperationId" =
                    OLD."deletionOperationId"
                  AND NEW."deletionRequestedAt" =
                    OLD."deletionRequestedAt"
                  AND NEW."deletionFinalizeFence" IS NOT NULL
                  AND EXISTS (
                    SELECT 1
                    FROM ${operationTable} AS operation
                    WHERE operation."id" = NEW."deletionOperationId"
                      AND operation."kind" = 'asset'
                      AND operation."projectId" = OLD."projectId"
                      AND (
                        operation."resourceId" = OLD."id"::text
                        OR operation."resourceId" = OLD."assetsId"::text
                      )
                      AND operation."status" = 'deleting'
                      AND operation."coordinatorLeaseOwner" IS NOT NULL
                      AND operation."coordinatorFence" =
                        NEW."deletionFinalizeFence"
                      AND operation."coordinatorLeaseExpiresAt"
                        > floor(
                          extract(epoch FROM clock_timestamp()) * 1000
                        )
                  )
                )
              )
            THEN
              RAISE EXCEPTION 'asset deletion markers are immutable or transition is invalid'
                USING ERRCODE = '55000';
            END IF;
            RETURN NEW;
          END IF;

          IF NOT (
            (
              OLD."deletionState" = 'active'
              AND OLD."deletionOperationId" IS NULL
              AND OLD."deletionRequestedAt" IS NULL
              AND OLD."deletionFinalizeFence" IS NULL
              AND EXISTS (
                SELECT 1
                FROM "o_project" AS project
                INNER JOIN ${operationTable} AS operation
                  ON operation."id" = project."deletionOperationId"
                WHERE project."id" = OLD."projectId"
                  AND project."deletionState" = 'finalizing'
                  AND project."deletionFinalizeFence" IS NOT NULL
                  AND operation."kind" = 'project'
                  AND operation."workspaceId" = project."workspaceId"
                  AND operation."projectId" = project."id"
                  AND operation."resourceId" = project."id"::text
                  AND operation."requestedAt" =
                    project."deletionRequestedAt"
                  AND operation."status" = 'deleting'
                  AND operation."coordinatorLeaseOwner" IS NOT NULL
                  AND operation."coordinatorFence" =
                    project."deletionFinalizeFence"
                  AND operation."coordinatorLeaseExpiresAt"
                    > floor(
                      extract(epoch FROM clock_timestamp()) * 1000
                    )
              )
            )
            OR (
              OLD."deletionState" = 'finalizing'
              AND OLD."deletionOperationId" IS NOT NULL
              AND OLD."deletionFinalizeFence" IS NOT NULL
              AND EXISTS (
                SELECT 1
                FROM ${operationTable} AS operation
                WHERE operation."id" = OLD."deletionOperationId"
                  AND operation."kind" = 'asset'
                  AND operation."projectId" = OLD."projectId"
                  AND (
                    operation."resourceId" = OLD."id"::text
                    OR operation."resourceId" = OLD."assetsId"::text
                  )
                  AND operation."status" = 'deleting'
                  AND operation."coordinatorLeaseOwner" IS NOT NULL
                  AND operation."coordinatorFence" =
                    OLD."deletionFinalizeFence"
                  AND operation."coordinatorLeaseExpiresAt"
                    > floor(
                      extract(epoch FROM clock_timestamp()) * 1000
                    )
              )
            )
          ) THEN
            RAISE EXCEPTION 'asset delete requires durable project finalizer or asset finalizer'
              USING ERRCODE = '55000';
          END IF;
          RETURN OLD;
        END;
        $$
      `);
      await database.raw(
        `DROP TRIGGER IF EXISTS ${assetStateTrigger} ON ${assetTable}`,
      );
      await database.raw(`
        CREATE TRIGGER ${assetStateTrigger}
        BEFORE INSERT OR UPDATE OR DELETE ON ${assetTable}
        FOR EACH ROW EXECUTE FUNCTION ${assetStateFunction}()
      `);
      await database.raw(`
        CREATE OR REPLACE FUNCTION ${assetImageFunction}()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        DECLARE
          owner_project_id bigint;
          target_state text;
        BEGIN
          IF TG_OP <> 'DELETE' AND NEW."imageId" IS NOT NULL THEN
            SELECT owner."projectId", image."deletionState"
            INTO owner_project_id, target_state
            FROM "o_image" AS image
            INNER JOIN "o_assets" AS owner ON owner."id" = image."assetsId"
            WHERE image."id" = NEW."imageId"
            FOR SHARE OF image, owner;
            IF owner_project_id IS NULL
              OR owner_project_id IS DISTINCT FROM NEW."projectId"
              OR target_state IS DISTINCT FROM 'active'
            THEN
              RAISE EXCEPTION 'asset image reference crosses authority or deletion boundary'
                USING ERRCODE = '55000';
            END IF;
          END IF;
          RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
        END;
        $$
      `);
      await database.raw(`DROP TRIGGER IF EXISTS ${assetTrigger} ON ${assetTable}`);
      await database.raw(`
        CREATE TRIGGER ${assetTrigger}
        BEFORE INSERT OR UPDATE OF "imageId", "projectId" ON ${assetTable}
        FOR EACH ROW EXECUTE FUNCTION ${assetImageFunction}()
      `);
    }
    return;
  }

  await database.raw(`
    CREATE TRIGGER IF NOT EXISTS ${quoteSqlIdentifier(`${PROJECT_STATE_GUARD_TRIGGER}_insert`)}
    BEFORE INSERT ON ${projectTable}
    FOR EACH ROW WHEN COALESCE(NEW."deletionState", 'active') <> 'active'
      OR NEW."deletionOperationId" IS NOT NULL
      OR NEW."deletionRequestedAt" IS NOT NULL
      OR NEW."deletionFinalizeFence" IS NOT NULL
    BEGIN
      SELECT RAISE(ABORT, 'new project must be active');
    END
  `);
  await database.raw(`
    CREATE TRIGGER IF NOT EXISTS ${quoteSqlIdentifier(`${PROJECT_STATE_GUARD_TRIGGER}_update`)}
    BEFORE UPDATE ON ${projectTable}
    FOR EACH ROW WHEN
      NEW."id" <> OLD."id"
      OR NEW."workspaceId" <> OLD."workspaceId"
      OR NOT (
        (
          OLD."deletionState" = 'active'
          AND NEW."deletionState" = 'active'
          AND NEW."deletionOperationId" IS NULL
          AND NEW."deletionRequestedAt" IS NULL
          AND NEW."deletionFinalizeFence" IS NULL
        )
        OR (
          OLD."deletionState" = 'active'
          AND NEW."deletionState" = 'deleting'
          AND NEW."deletionOperationId" IS NOT NULL
          AND NEW."deletionRequestedAt" IS NOT NULL
          AND NEW."deletionFinalizeFence" IS NULL
          AND EXISTS (
            SELECT 1
            FROM ${operationTable} AS operation
            WHERE operation."id" = NEW."deletionOperationId"
              AND operation."kind" = 'project'
              AND operation."workspaceId" = OLD."workspaceId"
              AND operation."projectId" = OLD."id"
              AND operation."resourceId" = CAST(OLD."id" AS TEXT)
              AND operation."status" = 'preparing'
              AND operation."requestedAt" = NEW."deletionRequestedAt"
          )
        )
        OR (
          OLD."deletionState" = 'deleting'
          AND NEW."deletionState" = 'finalizing'
          AND NEW."deletionOperationId" = OLD."deletionOperationId"
          AND NEW."deletionRequestedAt" = OLD."deletionRequestedAt"
          AND NEW."deletionFinalizeFence" IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM ${operationTable} AS operation
            WHERE operation."id" = OLD."deletionOperationId"
              AND operation."kind" = 'project'
              AND operation."projectId" = OLD."id"
              AND operation."status" = 'deleting'
              AND operation."coordinatorLeaseOwner" IS NOT NULL
              AND operation."coordinatorFence" = NEW."deletionFinalizeFence"
              AND operation."coordinatorLeaseExpiresAt"
                > CAST(strftime('%s', 'now') AS INTEGER) * 1000
          )
        )
        OR (
          OLD."deletionState" = 'finalizing'
          AND NEW."deletionState" = 'finalizing'
          AND NEW."deletionOperationId" = OLD."deletionOperationId"
          AND NEW."deletionRequestedAt" = OLD."deletionRequestedAt"
          AND OLD."deletionFinalizeFence" IS NOT NULL
          AND NEW."deletionFinalizeFence" > OLD."deletionFinalizeFence"
          AND EXISTS (
            SELECT 1
            FROM ${operationTable} AS operation
            WHERE operation."id" = OLD."deletionOperationId"
              AND operation."kind" = 'project'
              AND operation."workspaceId" = OLD."workspaceId"
              AND operation."projectId" = OLD."id"
              AND operation."resourceId" = CAST(OLD."id" AS TEXT)
              AND operation."requestedAt" = OLD."deletionRequestedAt"
              AND operation."status" = 'deleting'
              AND operation."coordinatorLeaseOwner" IS NOT NULL
              AND operation."coordinatorFence" = NEW."deletionFinalizeFence"
              AND operation."coordinatorLeaseExpiresAt"
                > CAST(strftime('%s', 'now') AS INTEGER) * 1000
          )
        )
        OR (
          OLD."deletionState" = 'finalizing'
          AND NEW."deletionState" = 'deleted'
          AND NEW."deletionOperationId" = OLD."deletionOperationId"
          AND NEW."deletionRequestedAt" = OLD."deletionRequestedAt"
          AND NEW."deletionFinalizeFence" = OLD."deletionFinalizeFence"
          AND EXISTS (
            SELECT 1
            FROM ${operationTable} AS operation
            WHERE operation."id" = OLD."deletionOperationId"
              AND operation."kind" = 'project'
              AND operation."workspaceId" = OLD."workspaceId"
              AND operation."projectId" = OLD."id"
              AND operation."resourceId" = CAST(OLD."id" AS TEXT)
              AND operation."requestedAt" = OLD."deletionRequestedAt"
              AND operation."status" = 'deleting'
              AND operation."coordinatorLeaseOwner" IS NOT NULL
              AND operation."coordinatorFence" = OLD."deletionFinalizeFence"
              AND operation."coordinatorLeaseExpiresAt"
                > CAST(strftime('%s', 'now') AS INTEGER) * 1000
          )
        )
      )
    BEGIN
      SELECT RAISE(ABORT, 'invalid project deletion-state transition');
    END
  `);
  await database.raw(`
    CREATE TRIGGER IF NOT EXISTS ${quoteSqlIdentifier(`${PROJECT_STATE_GUARD_TRIGGER}_delete`)}
    BEFORE DELETE ON ${projectTable}
    BEGIN
      SELECT RAISE(ABORT, 'o_project deletion requires durable tombstone workflow');
    END
  `);
  for (const tableName of PROJECT_CONTENT_WRITE_TABLES) {
    if (
      !(await database.schema.hasTable(tableName))
      || !(await database.schema.hasColumn(tableName, "projectId"))
    ) continue;
    const table = quoteSqlIdentifier(tableName);
    const triggerBase = `trg_${tableName.slice(2)}_active_project_write`;
    const hasWorkspaceId = await database.schema.hasColumn(
      tableName,
      "workspaceId",
    );
    const newWorkspaceMatch = hasWorkspaceId
      ? ' AND project."workspaceId" IS NEW."workspaceId"'
      : "";
    const oldWorkspaceMatch = hasWorkspaceId
      ? ' AND project."workspaceId" IS OLD."workspaceId"'
      : "";
    const insertTrigger = quoteSqlIdentifier(`${triggerBase}_insert`);
    const updateTrigger = quoteSqlIdentifier(`${triggerBase}_update`);
    const deleteTrigger = quoteSqlIdentifier(`${triggerBase}_delete`);
    await database.raw(`
      CREATE TRIGGER IF NOT EXISTS ${insertTrigger}
      BEFORE INSERT ON ${table}
      FOR EACH ROW WHEN NEW."projectId" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM ${projectTable} AS project
          WHERE project."id" = NEW."projectId"
            AND project."deletionState" = 'active'
            ${newWorkspaceMatch}
        )
      BEGIN
        SELECT RAISE(ABORT, 'project is not active');
      END
    `);
    await database.raw(`
      CREATE TRIGGER IF NOT EXISTS ${updateTrigger}
      BEFORE UPDATE ON ${table}
      FOR EACH ROW WHEN (
        NEW."projectId" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM ${projectTable} AS project
          WHERE project."id" = NEW."projectId"
            ${newWorkspaceMatch}
            AND (
              project."deletionState" = 'active'
              OR (
                project."deletionState" = 'finalizing'
                AND EXISTS (
                  SELECT 1
                  FROM ${operationTable} AS operation
                  WHERE operation."id" =
                    project."deletionOperationId"
                    AND operation."kind" = 'project'
                    AND operation."workspaceId" =
                      project."workspaceId"
                    AND operation."projectId" = project."id"
                    AND operation."resourceId" =
                      CAST(project."id" AS TEXT)
                    AND operation."requestedAt" =
                      project."deletionRequestedAt"
                    AND operation."status" = 'deleting'
                    AND operation."coordinatorLeaseOwner" IS NOT NULL
                    AND operation."coordinatorFence" =
                      project."deletionFinalizeFence"
                    AND operation."coordinatorLeaseExpiresAt"
                      > CAST(strftime('%s', 'now') AS INTEGER) * 1000
                )
              )
            )
        )
      ) OR (
        OLD."projectId" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM ${projectTable} AS project
          WHERE project."id" = OLD."projectId"
            ${oldWorkspaceMatch}
            AND (
              project."deletionState" = 'active'
              OR (
                project."deletionState" = 'finalizing'
                AND EXISTS (
                  SELECT 1
                  FROM ${operationTable} AS operation
                  WHERE operation."id" =
                    project."deletionOperationId"
                    AND operation."kind" = 'project'
                    AND operation."workspaceId" =
                      project."workspaceId"
                    AND operation."projectId" = project."id"
                    AND operation."resourceId" =
                      CAST(project."id" AS TEXT)
                    AND operation."requestedAt" =
                      project."deletionRequestedAt"
                    AND operation."status" = 'deleting'
                    AND operation."coordinatorLeaseOwner" IS NOT NULL
                    AND operation."coordinatorFence" =
                      project."deletionFinalizeFence"
                    AND operation."coordinatorLeaseExpiresAt"
                      > CAST(strftime('%s', 'now') AS INTEGER) * 1000
                )
              )
            )
        )
      )
      BEGIN
        SELECT RAISE(ABORT, 'project is not active');
      END
    `);
    await database.raw(`
      CREATE TRIGGER IF NOT EXISTS ${deleteTrigger}
      BEFORE DELETE ON ${table}
      FOR EACH ROW WHEN OLD."projectId" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM ${projectTable} AS project
          WHERE project."id" = OLD."projectId"
            ${oldWorkspaceMatch}
            AND (
              project."deletionState" = 'active'
              OR (
                project."deletionState" = 'finalizing'
                AND EXISTS (
                  SELECT 1
                  FROM ${operationTable} AS operation
                  WHERE operation."id" =
                    project."deletionOperationId"
                    AND operation."kind" = 'project'
                    AND operation."workspaceId" =
                      project."workspaceId"
                    AND operation."projectId" = project."id"
                    AND operation."resourceId" =
                      CAST(project."id" AS TEXT)
                    AND operation."requestedAt" =
                      project."deletionRequestedAt"
                    AND operation."status" = 'deleting'
                    AND operation."coordinatorLeaseOwner" IS NOT NULL
                    AND operation."coordinatorFence" =
                      project."deletionFinalizeFence"
                    AND operation."coordinatorLeaseExpiresAt"
                      > CAST(strftime('%s', 'now') AS INTEGER) * 1000
                )
              )
            )
        )
      BEGIN
        SELECT RAISE(ABORT, 'project is not active');
      END
    `);
  }
  if (await database.schema.hasTable("o_tasks")) {
    await database.raw(`
      CREATE TRIGGER IF NOT EXISTS ${quoteSqlIdentifier(TASK_OUTPUT_EVIDENCE_GUARD_TRIGGER)}
      BEFORE UPDATE ON "o_tasks"
      FOR EACH ROW WHEN (
        CASE
          WHEN json_valid(OLD."relatedObjects") = 1
          THEN json_type(
            OLD."relatedObjects",
            '$.outputStorageKey'
          ) = 'text'
            AND NULLIF(
              trim(json_extract(
                OLD."relatedObjects",
                '$.outputStorageKey'
              )),
              ''
            ) IS NOT NULL
          ELSE 0
        END
      ) AND (
        NEW."projectId" IS NOT OLD."projectId"
        OR NEW."relatedObjects" IS NOT OLD."relatedObjects"
      )
      BEGIN
        SELECT RAISE(ABORT, 'task output evidence is immutable');
      END
    `);
  }
  if (
    await database.schema.hasTable("o_user_video_enhance_task")
    && await database.schema.hasColumn(
      "o_user_video_enhance_task",
      "projectId",
    )
  ) {
    await database.raw(`
      CREATE TRIGGER IF NOT EXISTS "trg_o_user_video_enhance_project_required_insert"
      BEFORE INSERT ON "o_user_video_enhance_task"
      FOR EACH ROW WHEN NEW."projectId" IS NULL
      BEGIN
        SELECT RAISE(
          ABORT,
          'active user enhance task requires project ownership'
        );
      END
    `);
    await database.raw(`
      CREATE TRIGGER IF NOT EXISTS "trg_o_user_video_enhance_project_required_update"
      BEFORE UPDATE ON "o_user_video_enhance_task"
      FOR EACH ROW WHEN NEW."projectId" IS NULL
        AND NEW."status" IN ('created', 'enhancing')
      BEGIN
        SELECT RAISE(
          ABORT,
          'active user enhance task requires project ownership'
        );
      END
    `);
  }
  if (await database.schema.hasTable("o_image")) {
    const imageTable = quoteSqlIdentifier("o_image");
    await database.raw(`
      CREATE TRIGGER IF NOT EXISTS "trg_o_image_active_project_insert"
      BEFORE INSERT ON ${imageTable}
      FOR EACH ROW WHEN NEW."assetsId" IS NULL
        OR COALESCE(NEW."deletionState", 'active') <> 'active'
        OR NEW."deletionOperationId" IS NOT NULL
        OR NEW."deletionRequestedAt" IS NOT NULL
        OR NEW."deletionFinalizeFence" IS NOT NULL
        OR NOT EXISTS (
          SELECT 1
          FROM "o_assets" AS asset
          INNER JOIN ${projectTable} AS project ON project."id" = asset."projectId"
          WHERE asset."id" = NEW."assetsId"
            AND asset."deletionState" = 'active'
            AND project."deletionState" = 'active'
        )
      BEGIN
        SELECT RAISE(ABORT, 'image project is not active');
      END
    `);
    await database.raw(`
      CREATE TRIGGER IF NOT EXISTS "trg_o_image_active_project_update"
      BEFORE UPDATE ON ${imageTable}
      FOR EACH ROW WHEN NEW."id" <> OLD."id"
        OR NEW."assetsId" IS NOT OLD."assetsId"
        OR (
          NOT EXISTS (
            SELECT 1 FROM "o_assets" AS asset
            INNER JOIN ${projectTable} AS project ON project."id" = asset."projectId"
            WHERE asset."id" = NEW."assetsId" AND project."deletionState" = 'active'
          )
        )
        OR NOT (
          (
            OLD."deletionState" = 'active'
            AND NEW."deletionState" = 'active'
            AND EXISTS (
              SELECT 1
              FROM "o_assets" AS active_owner
              WHERE active_owner."id" = NEW."assetsId"
                AND active_owner."deletionState" = 'active'
            )
            AND NEW."deletionOperationId" IS NULL
            AND NEW."deletionRequestedAt" IS NULL
            AND NEW."deletionFinalizeFence" IS NULL
          )
          OR (
            OLD."deletionState" = 'active'
            AND NEW."deletionState" = 'deleting'
            AND NEW."deletionOperationId" IS NOT NULL
            AND NEW."deletionRequestedAt" IS NOT NULL
            AND NEW."deletionFinalizeFence" IS NULL
            AND EXISTS (
              SELECT 1
              FROM ${operationTable} AS operation
              INNER JOIN "o_assets" AS asset ON asset."id" = NEW."assetsId"
              WHERE operation."id" = NEW."deletionOperationId"
                AND operation."projectId" = asset."projectId"
                AND (
                  (
                    operation."kind" = 'image'
                    AND operation."resourceId" =
                      CAST(NEW."id" AS TEXT)
                  )
                  OR (
                    operation."kind" = 'asset'
                    AND (
                      operation."resourceId" =
                        CAST(NEW."assetsId" AS TEXT)
                      OR operation."resourceId" = CAST(
                        asset."assetsId" AS TEXT
                      )
                    )
                  )
                )
                AND operation."status" = 'deleting'
            )
          )
          OR (
            OLD."deletionState" = 'deleting'
            AND NEW."deletionState" = 'finalizing'
            AND NEW."deletionOperationId" = OLD."deletionOperationId"
            AND NEW."deletionRequestedAt" = OLD."deletionRequestedAt"
            AND NEW."deletionFinalizeFence" IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM ${operationTable} AS operation
              INNER JOIN "o_assets" AS asset ON asset."id" = NEW."assetsId"
              WHERE operation."id" = NEW."deletionOperationId"
                AND operation."projectId" = asset."projectId"
                AND (
                  (
                    operation."kind" = 'image'
                    AND operation."resourceId" =
                      CAST(NEW."id" AS TEXT)
                  )
                  OR (
                    operation."kind" = 'asset'
                    AND (
                      operation."resourceId" =
                        CAST(NEW."assetsId" AS TEXT)
                      OR operation."resourceId" = CAST(
                        asset."assetsId" AS TEXT
                      )
                    )
                  )
                )
                AND operation."status" = 'deleting'
                AND operation."coordinatorLeaseOwner" IS NOT NULL
                AND operation."coordinatorFence" = NEW."deletionFinalizeFence"
                AND operation."coordinatorLeaseExpiresAt"
                  > CAST(strftime('%s', 'now') AS INTEGER) * 1000
            )
          )
        )
      BEGIN
        SELECT RAISE(ABORT, 'invalid image deletion-state transition');
      END
    `);
    await database.raw(`
      CREATE TRIGGER IF NOT EXISTS "trg_o_image_active_project_delete"
      BEFORE DELETE ON ${imageTable}
      FOR EACH ROW WHEN NOT EXISTS (
        SELECT 1
        FROM "o_assets" AS asset
        INNER JOIN ${projectTable} AS project ON project."id" = asset."projectId"
          WHERE asset."id" = OLD."assetsId"
          AND (
            (
              project."deletionState" = 'finalizing'
              AND project."deletionFinalizeFence" IS NOT NULL
              AND EXISTS (
                SELECT 1
                FROM ${operationTable} AS project_operation
                WHERE project_operation."id" =
                    project."deletionOperationId"
                  AND project_operation."kind" = 'project'
                  AND project_operation."workspaceId" =
                    project."workspaceId"
                  AND project_operation."projectId" = project."id"
                  AND project_operation."resourceId" =
                    CAST(project."id" AS TEXT)
                  AND project_operation."requestedAt" =
                    project."deletionRequestedAt"
                  AND project_operation."status" = 'deleting'
                  AND project_operation."coordinatorLeaseOwner" IS NOT NULL
                  AND project_operation."coordinatorFence" =
                    project."deletionFinalizeFence"
                  AND project_operation."coordinatorLeaseExpiresAt"
                    > CAST(strftime('%s', 'now') AS INTEGER) * 1000
              )
            )
            OR (
              OLD."deletionState" = 'finalizing'
              AND OLD."deletionFinalizeFence" IS NOT NULL
              AND EXISTS (
                SELECT 1
                FROM ${operationTable} AS operation
                WHERE operation."id" = OLD."deletionOperationId"
                  AND operation."projectId" = asset."projectId"
                  AND (
                    (
                      operation."kind" = 'image'
                      AND operation."resourceId" =
                        CAST(OLD."id" AS TEXT)
                    )
                    OR (
                      operation."kind" = 'asset'
                      AND (
                        operation."resourceId" =
                          CAST(OLD."assetsId" AS TEXT)
                        OR operation."resourceId" = CAST(
                          asset."assetsId" AS TEXT
                        )
                      )
                    )
                  )
                  AND operation."status" = 'deleting'
                  AND operation."coordinatorLeaseOwner" IS NOT NULL
                  AND operation."coordinatorFence" = OLD."deletionFinalizeFence"
                  AND operation."coordinatorLeaseExpiresAt"
                    > CAST(strftime('%s', 'now') AS INTEGER) * 1000
              )
            )
          )
      )
      BEGIN
        SELECT RAISE(ABORT, 'image delete requires durable finalizer');
      END
    `);
  }
  if (await database.schema.hasTable("o_assets")) {
    await database.raw(`
      CREATE TRIGGER IF NOT EXISTS ${quoteSqlIdentifier(`${ASSET_STATE_GUARD_TRIGGER}_insert`)}
      BEFORE INSERT ON "o_assets"
      FOR EACH ROW WHEN COALESCE(NEW."deletionState", 'active') <> 'active'
        OR NEW."deletionOperationId" IS NOT NULL
        OR NEW."deletionRequestedAt" IS NOT NULL
        OR NEW."deletionFinalizeFence" IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'new asset must be active');
      END
    `);
    await database.raw(`
      CREATE TRIGGER IF NOT EXISTS ${quoteSqlIdentifier(`${ASSET_STATE_GUARD_TRIGGER}_update`)}
      BEFORE UPDATE ON "o_assets"
      FOR EACH ROW WHEN NEW."id" IS NOT OLD."id"
        OR NEW."projectId" IS NOT OLD."projectId"
        OR NEW."assetsId" IS NOT OLD."assetsId"
        OR NOT (
          (
            OLD."deletionState" = 'active'
            AND NEW."deletionState" = 'active'
            AND NEW."deletionOperationId" IS NULL
            AND NEW."deletionRequestedAt" IS NULL
            AND NEW."deletionFinalizeFence" IS NULL
          )
          OR (
            OLD."deletionState" = 'active'
            AND NEW."deletionState" = 'deleting'
            AND NEW."deletionOperationId" IS NOT NULL
            AND NEW."deletionRequestedAt" IS NOT NULL
            AND NEW."deletionFinalizeFence" IS NULL
            AND EXISTS (
              SELECT 1
              FROM ${operationTable} AS operation
              INNER JOIN "o_project" AS project
                ON project."id" = OLD."projectId"
              WHERE operation."id" = NEW."deletionOperationId"
                AND operation."kind" = 'asset'
                AND operation."workspaceId" = project."workspaceId"
                AND operation."projectId" = OLD."projectId"
                AND (
                  operation."resourceId" = CAST(OLD."id" AS TEXT)
                  OR operation."resourceId" =
                    CAST(OLD."assetsId" AS TEXT)
                )
                AND operation."requestedAt" =
                  NEW."deletionRequestedAt"
                AND operation."status" = 'deleting'
            )
          )
          OR (
            OLD."deletionState" = 'deleting'
            AND NEW."deletionState" = 'finalizing'
            AND NEW."deletionOperationId" =
              OLD."deletionOperationId"
            AND NEW."deletionRequestedAt" =
              OLD."deletionRequestedAt"
            AND NEW."deletionFinalizeFence" IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM ${operationTable} AS operation
              WHERE operation."id" = NEW."deletionOperationId"
                AND operation."kind" = 'asset'
                AND operation."projectId" = OLD."projectId"
                AND (
                  operation."resourceId" = CAST(OLD."id" AS TEXT)
                  OR operation."resourceId" =
                    CAST(OLD."assetsId" AS TEXT)
                )
                AND operation."status" = 'deleting'
                AND operation."coordinatorLeaseOwner" IS NOT NULL
                AND operation."coordinatorFence" =
                  NEW."deletionFinalizeFence"
                AND operation."coordinatorLeaseExpiresAt"
                  > CAST(strftime('%s', 'now') AS INTEGER) * 1000
            )
          )
        )
      BEGIN
        SELECT RAISE(
          ABORT,
          'asset deletion markers are immutable or transition is invalid'
        );
      END
    `);
    await database.raw(`
      CREATE TRIGGER IF NOT EXISTS ${quoteSqlIdentifier(`${ASSET_STATE_GUARD_TRIGGER}_delete`)}
      BEFORE DELETE ON "o_assets"
      FOR EACH ROW WHEN NOT (
        (
          OLD."deletionState" = 'active'
          AND OLD."deletionOperationId" IS NULL
          AND OLD."deletionRequestedAt" IS NULL
          AND OLD."deletionFinalizeFence" IS NULL
          AND EXISTS (
            SELECT 1
            FROM "o_project" AS project
            INNER JOIN ${operationTable} AS operation
              ON operation."id" = project."deletionOperationId"
            WHERE project."id" = OLD."projectId"
              AND project."deletionState" = 'finalizing'
              AND project."deletionFinalizeFence" IS NOT NULL
              AND operation."kind" = 'project'
              AND operation."workspaceId" = project."workspaceId"
              AND operation."projectId" = project."id"
              AND operation."resourceId" =
                CAST(project."id" AS TEXT)
              AND operation."requestedAt" =
                project."deletionRequestedAt"
              AND operation."status" = 'deleting'
              AND operation."coordinatorLeaseOwner" IS NOT NULL
              AND operation."coordinatorFence" =
                project."deletionFinalizeFence"
              AND operation."coordinatorLeaseExpiresAt"
                > CAST(strftime('%s', 'now') AS INTEGER) * 1000
          )
        )
        OR (
          OLD."deletionState" = 'finalizing'
          AND OLD."deletionOperationId" IS NOT NULL
          AND OLD."deletionFinalizeFence" IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM ${operationTable} AS operation
            WHERE operation."id" = OLD."deletionOperationId"
              AND operation."kind" = 'asset'
              AND operation."projectId" = OLD."projectId"
              AND (
                operation."resourceId" = CAST(OLD."id" AS TEXT)
                OR operation."resourceId" =
                  CAST(OLD."assetsId" AS TEXT)
              )
              AND operation."status" = 'deleting'
              AND operation."coordinatorLeaseOwner" IS NOT NULL
              AND operation."coordinatorFence" =
                OLD."deletionFinalizeFence"
              AND operation."coordinatorLeaseExpiresAt"
                > CAST(strftime('%s', 'now') AS INTEGER) * 1000
          )
        )
      )
      BEGIN
        SELECT RAISE(
          ABORT,
          'asset delete requires durable project finalizer or asset finalizer'
        );
      END
    `);
    for (const suffix of ["insert", "update"] as const) {
      const event = suffix === "insert"
        ? "INSERT"
        : "UPDATE OF \"imageId\", \"projectId\"";
      await database.raw(`
        CREATE TRIGGER IF NOT EXISTS ${quoteSqlIdentifier(`trg_o_assets_image_reference_guard_${suffix}`)}
        BEFORE ${event} ON "o_assets"
        FOR EACH ROW WHEN NEW."imageId" IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM "o_image" AS image
            INNER JOIN "o_assets" AS owner ON owner."id" = image."assetsId"
            WHERE image."id" = NEW."imageId"
              AND image."deletionState" = 'active'
              AND owner."projectId" = NEW."projectId"
          )
        BEGIN
          SELECT RAISE(
            ABORT,
            'asset image reference crosses authority or deletion boundary'
          );
        END
      `);
    }
  }
}

async function ensureMediaAssetDeletionGuards(
  database: Knex | Knex.Transaction,
): Promise<void> {
  if (!(await database.schema.hasTable("o_media_asset"))) return;
  const mediaTable = quoteSqlIdentifier("o_media_asset");
  const operationTable = quoteSqlIdentifier(DELETION_OPERATION_TABLE);
  if (isPostgresClient(database)) {
    const stateFunction = quoteSqlIdentifier(
      MEDIA_ASSET_STATE_GUARD_FUNCTION,
    );
    const stateTrigger = quoteSqlIdentifier(
      MEDIA_ASSET_STATE_GUARD_TRIGGER,
    );
    await database.raw(`
      CREATE OR REPLACE FUNCTION ${stateFunction}()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      DECLARE
        old_linked_asset_id bigint;
        new_linked_asset_id bigint;
      BEGIN
        IF TG_OP <> 'INSERT' THEN
          BEGIN
            old_linked_asset_id := NULLIF(
              OLD."metadata"::jsonb ->> 'assetId',
              ''
            )::bigint;
          EXCEPTION
            WHEN invalid_text_representation OR numeric_value_out_of_range
            THEN old_linked_asset_id := NULL;
          END;
        END IF;
        IF TG_OP <> 'DELETE' THEN
          BEGIN
            new_linked_asset_id := NULLIF(
              NEW."metadata"::jsonb ->> 'assetId',
              ''
            )::bigint;
          EXCEPTION
            WHEN invalid_text_representation OR numeric_value_out_of_range
            THEN new_linked_asset_id := NULL;
          END;
        END IF;

        IF TG_OP = 'INSERT' THEN
          IF COALESCE(NEW."deletionState", 'active') <> 'active'
            OR NEW."deletionOperationId" IS NOT NULL
            OR NEW."deletionRequestedAt" IS NOT NULL
            OR NEW."deletionFinalizeFence" IS NOT NULL
            OR (
              new_linked_asset_id IS NOT NULL
              AND NOT EXISTS (
                SELECT 1
                FROM "o_assets" AS asset
                WHERE asset."id" = new_linked_asset_id
                  AND asset."projectId" = NEW."projectId"
                  AND asset."deletionState" = 'active'
              )
            )
          THEN
            RAISE EXCEPTION 'new media asset must be active and owned'
              USING ERRCODE = '55000';
          END IF;
          RETURN NEW;
        END IF;

        IF TG_OP = 'UPDATE' THEN
          IF NEW."id" IS DISTINCT FROM OLD."id"
            OR NEW."workspaceId" IS DISTINCT FROM OLD."workspaceId"
            OR NEW."projectId" IS DISTINCT FROM OLD."projectId"
            OR NOT (
              (
                OLD."deletionState" = 'active'
                AND NEW."deletionState" = 'active'
                AND NEW."deletionOperationId" IS NULL
                AND NEW."deletionRequestedAt" IS NULL
                AND NEW."deletionFinalizeFence" IS NULL
                AND (
                  old_linked_asset_id IS NULL
                  OR EXISTS (
                    SELECT 1
                    FROM "o_assets" AS asset
                    WHERE asset."id" = old_linked_asset_id
                      AND asset."projectId" = OLD."projectId"
                      AND asset."deletionState" = 'active'
                  )
                )
                AND (
                  new_linked_asset_id IS NULL
                  OR EXISTS (
                    SELECT 1
                    FROM "o_assets" AS asset
                    WHERE asset."id" = new_linked_asset_id
                      AND asset."projectId" = NEW."projectId"
                      AND asset."deletionState" = 'active'
                  )
                )
              )
              OR (
                OLD."deletionState" = 'active'
                AND NEW."deletionState" = 'deleting'
                AND NEW."deletionOperationId" IS NOT NULL
                AND NEW."deletionRequestedAt" IS NOT NULL
                AND NEW."deletionFinalizeFence" IS NULL
                AND NEW."metadata" IS NOT DISTINCT FROM OLD."metadata"
                AND EXISTS (
                  SELECT 1
                  FROM ${operationTable} AS operation
                  WHERE operation."id" = NEW."deletionOperationId"
                    AND operation."kind" = 'asset'
                    AND operation."workspaceId" = OLD."workspaceId"
                    AND operation."projectId" = OLD."projectId"
                    AND operation."requestedAt" =
                      NEW."deletionRequestedAt"
                    AND operation."status" = 'deleting'
                    AND (
                      operation."resourceId" =
                        'media:' || OLD."id"
                      OR (
                        old_linked_asset_id IS NOT NULL
                        AND EXISTS (
                          SELECT 1
                          FROM "o_assets" AS linked
                          WHERE linked."id" = old_linked_asset_id
                            AND linked."projectId" = OLD."projectId"
                            AND (
                              operation."resourceId" =
                                linked."id"::text
                              OR operation."resourceId" =
                                linked."assetsId"::text
                            )
                        )
                      )
                    )
                )
              )
              OR (
                OLD."deletionState" = 'deleting'
                AND NEW."deletionState" = 'finalizing'
                AND NEW."deletionOperationId" =
                  OLD."deletionOperationId"
                AND NEW."deletionRequestedAt" =
                  OLD."deletionRequestedAt"
                AND NEW."deletionFinalizeFence" IS NOT NULL
                AND NEW."metadata" IS NOT DISTINCT FROM OLD."metadata"
                AND EXISTS (
                  SELECT 1
                  FROM ${operationTable} AS operation
                  WHERE operation."id" = NEW."deletionOperationId"
                    AND operation."kind" = 'asset'
                    AND operation."workspaceId" = OLD."workspaceId"
                    AND operation."projectId" = OLD."projectId"
                    AND operation."status" = 'deleting'
                    AND operation."coordinatorLeaseOwner" IS NOT NULL
                    AND operation."coordinatorFence" =
                      NEW."deletionFinalizeFence"
                    AND operation."coordinatorLeaseExpiresAt"
                      > floor(
                        extract(epoch FROM clock_timestamp()) * 1000
                      )
                    AND (
                      operation."resourceId" =
                        'media:' || OLD."id"
                      OR (
                        old_linked_asset_id IS NOT NULL
                        AND EXISTS (
                          SELECT 1
                          FROM "o_assets" AS linked
                          WHERE linked."id" = old_linked_asset_id
                            AND linked."projectId" = OLD."projectId"
                            AND (
                              operation."resourceId" =
                                linked."id"::text
                              OR operation."resourceId" =
                                linked."assetsId"::text
                            )
                        )
                      )
                    )
                )
              )
            )
          THEN
            RAISE EXCEPTION 'invalid media asset deletion-state transition'
              USING ERRCODE = '55000';
          END IF;
          RETURN NEW;
        END IF;

        IF NOT (
          (
            OLD."deletionState" = 'active'
            AND OLD."deletionOperationId" IS NULL
            AND OLD."deletionRequestedAt" IS NULL
            AND OLD."deletionFinalizeFence" IS NULL
            AND EXISTS (
              SELECT 1
              FROM "o_project" AS project
              INNER JOIN ${operationTable} AS operation
                ON operation."id" = project."deletionOperationId"
              WHERE project."id" = OLD."projectId"
                AND project."workspaceId" = OLD."workspaceId"
                AND project."deletionState" = 'finalizing'
                AND project."deletionFinalizeFence" IS NOT NULL
                AND operation."kind" = 'project'
                AND operation."status" = 'deleting'
                AND operation."coordinatorLeaseOwner" IS NOT NULL
                AND operation."coordinatorFence" =
                  project."deletionFinalizeFence"
                AND operation."coordinatorLeaseExpiresAt"
                  > floor(
                    extract(epoch FROM clock_timestamp()) * 1000
                  )
            )
          )
          OR (
            OLD."deletionState" = 'finalizing'
            AND OLD."deletionOperationId" IS NOT NULL
            AND OLD."deletionFinalizeFence" IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM ${operationTable} AS operation
              WHERE operation."id" = OLD."deletionOperationId"
                AND operation."kind" = 'asset'
                AND operation."workspaceId" = OLD."workspaceId"
                AND operation."projectId" = OLD."projectId"
                AND operation."status" = 'deleting'
                AND operation."coordinatorLeaseOwner" IS NOT NULL
                AND operation."coordinatorFence" =
                  OLD."deletionFinalizeFence"
                AND operation."coordinatorLeaseExpiresAt"
                  > floor(
                    extract(epoch FROM clock_timestamp()) * 1000
                  )
                AND (
                  operation."resourceId" = 'media:' || OLD."id"
                  OR (
                    old_linked_asset_id IS NOT NULL
                    AND EXISTS (
                      SELECT 1
                      FROM "o_assets" AS linked
                      WHERE linked."id" = old_linked_asset_id
                        AND linked."projectId" = OLD."projectId"
                        AND (
                          operation."resourceId" =
                            linked."id"::text
                          OR operation."resourceId" =
                            linked."assetsId"::text
                        )
                    )
                  )
                )
            )
          )
        ) THEN
          RAISE EXCEPTION 'media asset delete requires durable finalizer'
            USING ERRCODE = '55000';
        END IF;
        RETURN OLD;
      END;
      $$
    `);
    await database.raw(
      `DROP TRIGGER IF EXISTS ${stateTrigger} ON ${mediaTable}`,
    );
    await database.raw(`
      CREATE TRIGGER ${stateTrigger}
      BEFORE INSERT OR UPDATE OR DELETE ON ${mediaTable}
      FOR EACH ROW EXECUTE FUNCTION ${stateFunction}()
    `);
    return;
  }

  const insertTrigger = quoteSqlIdentifier(
    `${MEDIA_ASSET_STATE_GUARD_TRIGGER}_insert`,
  );
  const updateTrigger = quoteSqlIdentifier(
    `${MEDIA_ASSET_STATE_GUARD_TRIGGER}_update`,
  );
  const deleteTrigger = quoteSqlIdentifier(
    `${MEDIA_ASSET_STATE_GUARD_TRIGGER}_delete`,
  );
  await database.raw(`DROP TRIGGER IF EXISTS ${insertTrigger}`);
  await database.raw(`DROP TRIGGER IF EXISTS ${updateTrigger}`);
  await database.raw(`DROP TRIGGER IF EXISTS ${deleteTrigger}`);
  const newLinkedAssetId = `
    CASE WHEN json_valid(NEW."metadata") = 1
      THEN CAST(json_extract(NEW."metadata", '$.assetId') AS INTEGER)
      ELSE NULL
    END
  `;
  const oldLinkedAssetId = `
    CASE WHEN json_valid(OLD."metadata") = 1
      THEN CAST(json_extract(OLD."metadata", '$.assetId') AS INTEGER)
      ELSE NULL
    END
  `;
  await database.raw(`
    CREATE TRIGGER ${insertTrigger}
    BEFORE INSERT ON ${mediaTable}
    FOR EACH ROW WHEN COALESCE(NEW."deletionState", 'active') <> 'active'
      OR NEW."deletionOperationId" IS NOT NULL
      OR NEW."deletionRequestedAt" IS NOT NULL
      OR NEW."deletionFinalizeFence" IS NOT NULL
      OR (
        (${newLinkedAssetId}) IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM "o_assets" AS asset
          WHERE asset."id" = (${newLinkedAssetId})
            AND asset."projectId" = NEW."projectId"
            AND asset."deletionState" = 'active'
        )
      )
    BEGIN
      SELECT RAISE(
        ABORT,
        'new media asset must be active and owned'
      );
    END
  `);
  await database.raw(`
    CREATE TRIGGER ${updateTrigger}
    BEFORE UPDATE ON ${mediaTable}
    FOR EACH ROW WHEN NEW."id" IS NOT OLD."id"
      OR NEW."workspaceId" IS NOT OLD."workspaceId"
      OR NEW."projectId" IS NOT OLD."projectId"
      OR NOT (
        (
          OLD."deletionState" = 'active'
          AND NEW."deletionState" = 'active'
          AND NEW."deletionOperationId" IS NULL
          AND NEW."deletionRequestedAt" IS NULL
          AND NEW."deletionFinalizeFence" IS NULL
          AND (
            (${oldLinkedAssetId}) IS NULL
            OR EXISTS (
              SELECT 1 FROM "o_assets" AS asset
              WHERE asset."id" = (${oldLinkedAssetId})
                AND asset."projectId" = OLD."projectId"
                AND asset."deletionState" = 'active'
            )
          )
          AND (
            (${newLinkedAssetId}) IS NULL
            OR EXISTS (
              SELECT 1 FROM "o_assets" AS asset
              WHERE asset."id" = (${newLinkedAssetId})
                AND asset."projectId" = NEW."projectId"
                AND asset."deletionState" = 'active'
            )
          )
        )
        OR (
          OLD."deletionState" = 'active'
          AND NEW."deletionState" = 'deleting'
          AND NEW."deletionOperationId" IS NOT NULL
          AND NEW."deletionRequestedAt" IS NOT NULL
          AND NEW."deletionFinalizeFence" IS NULL
          AND NEW."metadata" IS OLD."metadata"
          AND EXISTS (
            SELECT 1
            FROM ${operationTable} AS operation
            WHERE operation."id" = NEW."deletionOperationId"
              AND operation."kind" = 'asset'
              AND operation."workspaceId" = OLD."workspaceId"
              AND operation."projectId" = OLD."projectId"
              AND operation."requestedAt" =
                NEW."deletionRequestedAt"
              AND operation."status" = 'deleting'
              AND (
                operation."resourceId" = 'media:' || OLD."id"
                OR EXISTS (
                  SELECT 1
                  FROM "o_assets" AS linked
                  WHERE linked."id" = (${oldLinkedAssetId})
                    AND linked."projectId" = OLD."projectId"
                    AND (
                      operation."resourceId" =
                        CAST(linked."id" AS TEXT)
                      OR operation."resourceId" =
                        CAST(linked."assetsId" AS TEXT)
                    )
                )
              )
          )
        )
        OR (
          OLD."deletionState" = 'deleting'
          AND NEW."deletionState" = 'finalizing'
          AND NEW."deletionOperationId" =
            OLD."deletionOperationId"
          AND NEW."deletionRequestedAt" =
            OLD."deletionRequestedAt"
          AND NEW."deletionFinalizeFence" IS NOT NULL
          AND NEW."metadata" IS OLD."metadata"
          AND EXISTS (
            SELECT 1
            FROM ${operationTable} AS operation
            WHERE operation."id" = NEW."deletionOperationId"
              AND operation."kind" = 'asset'
              AND operation."workspaceId" = OLD."workspaceId"
              AND operation."projectId" = OLD."projectId"
              AND operation."status" = 'deleting'
              AND operation."coordinatorLeaseOwner" IS NOT NULL
              AND operation."coordinatorFence" =
                NEW."deletionFinalizeFence"
              AND operation."coordinatorLeaseExpiresAt"
                > CAST(strftime('%s', 'now') AS INTEGER) * 1000
              AND (
                operation."resourceId" = 'media:' || OLD."id"
                OR EXISTS (
                  SELECT 1
                  FROM "o_assets" AS linked
                  WHERE linked."id" = (${oldLinkedAssetId})
                    AND linked."projectId" = OLD."projectId"
                    AND (
                      operation."resourceId" =
                        CAST(linked."id" AS TEXT)
                      OR operation."resourceId" =
                        CAST(linked."assetsId" AS TEXT)
                    )
                )
              )
          )
        )
      )
    BEGIN
      SELECT RAISE(
        ABORT,
        'invalid media asset deletion-state transition'
      );
    END
  `);
  await database.raw(`
    CREATE TRIGGER ${deleteTrigger}
    BEFORE DELETE ON ${mediaTable}
    FOR EACH ROW WHEN NOT (
      (
        OLD."deletionState" = 'active'
        AND OLD."deletionOperationId" IS NULL
        AND OLD."deletionRequestedAt" IS NULL
        AND OLD."deletionFinalizeFence" IS NULL
        AND EXISTS (
          SELECT 1
          FROM "o_project" AS project
          INNER JOIN ${operationTable} AS operation
            ON operation."id" = project."deletionOperationId"
          WHERE project."id" = OLD."projectId"
            AND project."workspaceId" = OLD."workspaceId"
            AND project."deletionState" = 'finalizing'
            AND project."deletionFinalizeFence" IS NOT NULL
            AND operation."kind" = 'project'
            AND operation."status" = 'deleting'
            AND operation."coordinatorLeaseOwner" IS NOT NULL
            AND operation."coordinatorFence" =
              project."deletionFinalizeFence"
            AND operation."coordinatorLeaseExpiresAt"
              > CAST(strftime('%s', 'now') AS INTEGER) * 1000
        )
      )
      OR (
        OLD."deletionState" = 'finalizing'
        AND OLD."deletionOperationId" IS NOT NULL
        AND OLD."deletionFinalizeFence" IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM ${operationTable} AS operation
          WHERE operation."id" = OLD."deletionOperationId"
            AND operation."kind" = 'asset'
            AND operation."workspaceId" = OLD."workspaceId"
            AND operation."projectId" = OLD."projectId"
            AND operation."status" = 'deleting'
            AND operation."coordinatorLeaseOwner" IS NOT NULL
            AND operation."coordinatorFence" =
              OLD."deletionFinalizeFence"
            AND operation."coordinatorLeaseExpiresAt"
              > CAST(strftime('%s', 'now') AS INTEGER) * 1000
            AND (
              operation."resourceId" = 'media:' || OLD."id"
              OR EXISTS (
                SELECT 1
                FROM "o_assets" AS linked
                WHERE linked."id" = (${oldLinkedAssetId})
                  AND linked."projectId" = OLD."projectId"
                  AND (
                    operation."resourceId" =
                      CAST(linked."id" AS TEXT)
                    OR operation."resourceId" =
                      CAST(linked."assetsId" AS TEXT)
                  )
              )
            )
        )
      )
    )
    BEGIN
      SELECT RAISE(
        ABORT,
        'media asset delete requires durable finalizer'
      );
    END
  `);
}

async function assertIndirectProjectRelationHistory(
  database: Knex | Knex.Transaction,
): Promise<void> {
  const distinctColumns = isPostgresClient(database)
    ? "?? IS DISTINCT FROM ??"
    : "?? IS NOT ??";
  const invalidScriptAsset = await database("o_scriptAssets as relation")
    .leftJoin("o_script as script", "script.id", "relation.scriptId")
    .leftJoin("o_assets as asset", "asset.id", "relation.assetId")
    .leftJoin("o_project as project", "project.id", "script.projectId")
    .where((query) => {
      query
        .whereNull("script.id")
        .orWhereNull("asset.id")
        .orWhereNull("project.id")
        .orWhereRaw(distinctColumns, [
          "script.projectId",
          "asset.projectId",
        ]);
    })
    .select("relation.scriptId")
    .first();
  if (invalidScriptAsset) {
    throw new Error(
      "Migration deletion_workflow found unresolvable or cross-project o_scriptAssets history",
    );
  }

  const invalidStoryboardAsset = await database(
    "o_assets2Storyboard as relation",
  )
    .leftJoin(
      "o_storyboard as storyboard",
      "storyboard.id",
      "relation.storyboardId",
    )
    .leftJoin("o_assets as asset", "asset.id", "relation.assetId")
    .leftJoin(
      "o_project as project",
      "project.id",
      "storyboard.projectId",
    )
    .where((query) => {
      query
        .whereNull("storyboard.id")
        .orWhereNull("asset.id")
        .orWhereNull("project.id")
        .orWhereRaw(distinctColumns, [
          "storyboard.projectId",
          "asset.projectId",
        ]);
    })
    .select("relation.storyboardId")
    .first();
  if (invalidStoryboardAsset) {
    throw new Error(
      "Migration deletion_workflow found unresolvable or cross-project o_assets2Storyboard history",
    );
  }

  const invalidRoleAudio = await database("o_assetsRole2Audio as relation")
    .leftJoin(
      "o_assets as role_asset",
      "role_asset.id",
      "relation.assetsRoleId",
    )
    .leftJoin(
      "o_assets as audio_asset",
      "audio_asset.id",
      "relation.assetsAudioId",
    )
    .leftJoin(
      "o_project as project",
      "project.id",
      "role_asset.projectId",
    )
    .where((query) => {
      query
        .whereNull("role_asset.id")
        .orWhereNull("audio_asset.id")
        .orWhereNull("project.id")
        .orWhereRaw(distinctColumns, [
          "role_asset.projectId",
          "audio_asset.projectId",
        ]);
    })
    .select("relation.assetsRoleId")
    .first();
  if (invalidRoleAudio) {
    throw new Error(
      "Migration deletion_workflow found unresolvable or cross-project o_assetsRole2Audio history",
    );
  }

  const invalidEventChapter = await database("o_eventChapter as relation")
    .leftJoin("o_event as event", "event.id", "relation.eventId")
    .leftJoin("o_novel as novel", "novel.id", "relation.novelId")
    .leftJoin("o_project as project", "project.id", "novel.projectId")
    .where((query) => {
      query
        .whereNull("event.id")
        .orWhereNull("novel.id")
        .orWhereNull("project.id");
    })
    .select("relation.id")
    .first();
  if (invalidEventChapter) {
    throw new Error(
      "Migration deletion_workflow found unresolvable o_eventChapter history",
    );
  }
  const crossProjectEvent = await database("o_eventChapter as left_relation")
    .innerJoin(
      "o_eventChapter as right_relation",
      "right_relation.eventId",
      "left_relation.eventId",
    )
    .innerJoin(
      "o_novel as left_novel",
      "left_novel.id",
      "left_relation.novelId",
    )
    .innerJoin(
      "o_novel as right_novel",
      "right_novel.id",
      "right_relation.novelId",
    )
    .whereRaw(distinctColumns, [
      "left_novel.projectId",
      "right_novel.projectId",
    ])
    .select("left_relation.eventId")
    .first();
  if (crossProjectEvent) {
    throw new Error(
      "Migration deletion_workflow found cross-project o_eventChapter history",
    );
  }

  const invalidCallback = await database(
    "o_relay_callback_delivery as delivery",
  )
    .leftJoin("o_relay_task as task", "task.id", "delivery.taskId")
    .leftJoin("o_project as project", "project.id", "task.projectId")
    .where((query) => {
      query.whereNull("task.id").orWhere((owned) => {
        owned.whereNotNull("task.projectId").whereNull("project.id");
      });
    })
    .select("delivery.id")
    .first();
  if (invalidCallback) {
    throw new Error(
      "Migration deletion_workflow found unresolvable o_relay_callback_delivery history",
    );
  }

  for (const parentTable of ["o_assets", "o_storyboard"] as const) {
    const invalidFlowReference = await database(`${parentTable} as parent`)
      .leftJoin("o_imageFlow as flow", "flow.id", "parent.flowId")
      .leftJoin("o_project as project", "project.id", "parent.projectId")
      .whereNotNull("parent.flowId")
      .andWhere((query) => {
        query.whereNull("flow.id").orWhereNull("project.id");
      })
      .select("parent.flowId")
      .first();
    if (invalidFlowReference) {
      throw new Error(
        `Migration deletion_workflow found unresolvable ${parentTable}.flowId history`,
      );
    }
  }
  const crossProjectFlow = rawRows<{ flowId: unknown }>(
    await database.raw(`
      SELECT flow_refs."flowId"
      FROM (
        SELECT "flowId", "projectId"
        FROM "o_assets"
        WHERE "flowId" IS NOT NULL
        UNION ALL
        SELECT "flowId", "projectId"
        FROM "o_storyboard"
        WHERE "flowId" IS NOT NULL
      ) AS flow_refs
      GROUP BY flow_refs."flowId"
      HAVING COUNT(DISTINCT flow_refs."projectId") <> 1
      LIMIT 1
    `),
  )[0];
  if (crossProjectFlow) {
    throw new Error(
      "Migration deletion_workflow found cross-project o_imageFlow history",
    );
  }
}

type IndirectRelationKind =
  | "script_assets"
  | "storyboard_assets"
  | "role_audio"
  | "event_chapter"
  | "relay_callback";

const INDIRECT_RELATION_KINDS: ReadonlyArray<{
  tableName: typeof INDIRECT_PROJECT_RELATION_TABLES[number];
  kind: IndirectRelationKind;
}> = [
  { tableName: "o_scriptAssets", kind: "script_assets" },
  { tableName: "o_assets2Storyboard", kind: "storyboard_assets" },
  { tableName: "o_assetsRole2Audio", kind: "role_audio" },
  { tableName: "o_eventChapter", kind: "event_chapter" },
  { tableName: "o_relay_callback_delivery", kind: "relay_callback" },
];

function sqliteIndirectRelationIsWritable(
  kind: IndirectRelationKind,
  row: "NEW" | "OLD",
  states: readonly string[],
): string {
  const allowedStates = states.map((state) => `'${state}'`).join(", ");
  const finalizingAuthority = `(
    project."deletionState" <> 'finalizing'
    OR EXISTS (
      SELECT 1
      FROM "${DELETION_OPERATION_TABLE}" AS operation
      WHERE operation."id" = project."deletionOperationId"
        AND operation."kind" = 'project'
        AND operation."workspaceId" = project."workspaceId"
        AND operation."projectId" = project."id"
        AND operation."resourceId" = CAST(project."id" AS TEXT)
        AND operation."requestedAt" = project."deletionRequestedAt"
        AND operation."status" = 'deleting'
        AND operation."coordinatorLeaseOwner" IS NOT NULL
        AND operation."coordinatorFence" =
          project."deletionFinalizeFence"
        AND operation."coordinatorLeaseExpiresAt"
          > CAST(strftime('%s', 'now') AS INTEGER) * 1000
    )
  )`;
  if (kind === "script_assets") {
    return `EXISTS (
      SELECT 1
      FROM "o_script" AS script
      INNER JOIN "o_assets" AS asset ON asset."id" = ${row}."assetId"
      INNER JOIN "o_project" AS project ON project."id" = script."projectId"
      WHERE script."id" = ${row}."scriptId"
        AND asset."projectId" IS script."projectId"
        AND project."deletionState" IN (${allowedStates})
        AND ${finalizingAuthority}
    )`;
  }
  if (kind === "storyboard_assets") {
    return `EXISTS (
      SELECT 1
      FROM "o_storyboard" AS storyboard
      INNER JOIN "o_assets" AS asset ON asset."id" = ${row}."assetId"
      INNER JOIN "o_project" AS project
        ON project."id" = storyboard."projectId"
      WHERE storyboard."id" = ${row}."storyboardId"
        AND asset."projectId" IS storyboard."projectId"
        AND project."deletionState" IN (${allowedStates})
        AND ${finalizingAuthority}
    )`;
  }
  if (kind === "role_audio") {
    return `EXISTS (
      SELECT 1
      FROM "o_assets" AS role_asset
      INNER JOIN "o_assets" AS audio_asset
        ON audio_asset."id" = ${row}."assetsAudioId"
      INNER JOIN "o_project" AS project
        ON project."id" = role_asset."projectId"
      WHERE role_asset."id" = ${row}."assetsRoleId"
        AND audio_asset."projectId" IS role_asset."projectId"
        AND project."deletionState" IN (${allowedStates})
        AND ${finalizingAuthority}
    )`;
  }
  if (kind === "event_chapter") {
    return `EXISTS (
      SELECT 1
      FROM "o_event" AS event
      INNER JOIN "o_novel" AS novel ON novel."id" = ${row}."novelId"
      INNER JOIN "o_project" AS project ON project."id" = novel."projectId"
      WHERE event."id" = ${row}."eventId"
        AND project."deletionState" IN (${allowedStates})
        AND ${finalizingAuthority}
        AND NOT EXISTS (
          SELECT 1
          FROM "o_eventChapter" AS existing_relation
          INNER JOIN "o_novel" AS existing_novel
            ON existing_novel."id" = existing_relation."novelId"
          WHERE existing_relation."eventId" = ${row}."eventId"
            AND existing_novel."projectId" IS NOT novel."projectId"
        )
    )`;
  }
  return `EXISTS (
    SELECT 1
    FROM "o_relay_task" AS task
    LEFT JOIN "o_project" AS project ON project."id" = task."projectId"
    WHERE task."id" = ${row}."taskId"
      AND (
        task."projectId" IS NULL
        OR (
          project."deletionState" IN (${allowedStates})
          AND ${finalizingAuthority}
        )
      )
  )`;
}

async function ensureIndirectProjectDeletionWriteGuards(
  database: Knex | Knex.Transaction,
): Promise<void> {
  const relationPresence = await Promise.all(
    INDIRECT_PROJECT_RELATION_TABLES.map(
      (tableName) => database.schema.hasTable(tableName),
    ),
  );
  if (!relationPresence.some(Boolean)) return;
  const requiredTables = [
    ...INDIRECT_PROJECT_RELATION_TABLES,
    ...INDIRECT_PROJECT_PARENT_TABLES,
    "o_assets",
    "o_storyboard",
    "o_project",
    "o_relay_task",
  ] as const;
  const missingTables: string[] = [];
  for (const tableName of requiredTables) {
    if (!(await database.schema.hasTable(tableName))) {
      missingTables.push(tableName);
    }
  }
  if (missingTables.length) {
    throw new Error(
      "Migration deletion_workflow cannot install indirect project guards; "
        + `missing tables: ${missingTables.join(", ")}`,
    );
  }
  await assertIndirectProjectRelationHistory(database);
  const relationFunction = quoteSqlIdentifier(
    INDIRECT_PROJECT_RELATION_GUARD_FUNCTION,
  );
  const flowFunction = quoteSqlIdentifier(IMAGE_FLOW_WRITE_GUARD_FUNCTION);
  const flowReferenceFunction = quoteSqlIdentifier(
    IMAGE_FLOW_REFERENCE_GUARD_FUNCTION,
  );
  const operationTable = quoteSqlIdentifier(DELETION_OPERATION_TABLE);
  if (isPostgresClient(database)) {
    const liveProjectFinalizer = `EXISTS (
      SELECT 1
      FROM ${operationTable} AS operation
      WHERE operation."id" = project."deletionOperationId"
        AND operation."kind" = 'project'
        AND operation."workspaceId" = project."workspaceId"
        AND operation."projectId" = project."id"
        AND operation."resourceId" = project."id"::text
        AND operation."requestedAt" = project."deletionRequestedAt"
        AND operation."status" = 'deleting'
        AND operation."coordinatorLeaseOwner" IS NOT NULL
        AND operation."coordinatorFence" = project."deletionFinalizeFence"
        AND operation."coordinatorLeaseExpiresAt"
          > floor(extract(epoch FROM clock_timestamp()) * 1000)
    )`;
    await database.raw(`
      CREATE OR REPLACE FUNCTION ${relationFunction}()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      DECLARE
        relation_kind text := TG_ARGV[0];
        relation_row jsonb;
        row_versions jsonb[];
        project_id bigint;
        peer_project_id bigint;
        project_state text;
        event_id bigint;
        project_finalizer_live boolean;
      BEGIN
        IF TG_OP = 'INSERT' THEN
          row_versions := ARRAY[to_jsonb(NEW)];
        ELSIF TG_OP = 'DELETE' THEN
          row_versions := ARRAY[to_jsonb(OLD)];
        ELSE
          row_versions := ARRAY[to_jsonb(OLD), to_jsonb(NEW)];
        END IF;

        FOREACH relation_row IN ARRAY row_versions LOOP
          project_id := NULL;
          peer_project_id := NULL;
          project_state := NULL;
          event_id := NULL;
          project_finalizer_live := FALSE;

          IF relation_kind = 'script_assets' THEN
            SELECT script."projectId", asset."projectId",
              project."deletionState"
            INTO project_id, peer_project_id, project_state
            FROM "o_script" AS script
            INNER JOIN "o_assets" AS asset
              ON asset."id" = (relation_row ->> 'assetId')::bigint
            INNER JOIN "o_project" AS project
              ON project."id" = script."projectId"
            WHERE script."id" = (relation_row ->> 'scriptId')::bigint
            FOR SHARE OF script, asset, project;
          ELSIF relation_kind = 'storyboard_assets' THEN
            SELECT storyboard."projectId", asset."projectId",
              project."deletionState"
            INTO project_id, peer_project_id, project_state
            FROM "o_storyboard" AS storyboard
            INNER JOIN "o_assets" AS asset
              ON asset."id" = (relation_row ->> 'assetId')::bigint
            INNER JOIN "o_project" AS project
              ON project."id" = storyboard."projectId"
            WHERE storyboard."id" =
              (relation_row ->> 'storyboardId')::bigint
            FOR SHARE OF storyboard, asset, project;
          ELSIF relation_kind = 'role_audio' THEN
            SELECT role_asset."projectId", audio_asset."projectId",
              project."deletionState"
            INTO project_id, peer_project_id, project_state
            FROM "o_assets" AS role_asset
            INNER JOIN "o_assets" AS audio_asset
              ON audio_asset."id" =
                (relation_row ->> 'assetsAudioId')::bigint
            INNER JOIN "o_project" AS project
              ON project."id" = role_asset."projectId"
            WHERE role_asset."id" =
              (relation_row ->> 'assetsRoleId')::bigint
            FOR SHARE OF role_asset, audio_asset, project;
          ELSIF relation_kind = 'event_chapter' THEN
            event_id := (relation_row ->> 'eventId')::bigint;
            SELECT novel."projectId", novel."projectId",
              project."deletionState"
            INTO project_id, peer_project_id, project_state
            FROM "o_event" AS event
            INNER JOIN "o_novel" AS novel
              ON novel."id" = (relation_row ->> 'novelId')::bigint
            INNER JOIN "o_project" AS project
              ON project."id" = novel."projectId"
            WHERE event."id" = event_id
            FOR UPDATE OF event
            FOR SHARE OF novel, project;
            IF FOUND AND EXISTS (
              SELECT 1
              FROM "o_eventChapter" AS existing_relation
              INNER JOIN "o_novel" AS existing_novel
                ON existing_novel."id" = existing_relation."novelId"
              WHERE existing_relation."eventId" = event_id
                AND existing_novel."projectId" IS DISTINCT FROM project_id
            ) THEN
              RAISE EXCEPTION 'event relation crosses project authority'
                USING ERRCODE = '55000';
            END IF;
          ELSIF relation_kind = 'relay_callback' THEN
            SELECT task."projectId"
            INTO project_id
            FROM "o_relay_task" AS task
            WHERE task."id" = relation_row ->> 'taskId'
            FOR SHARE OF task;
            IF NOT FOUND THEN
              RAISE EXCEPTION 'relay callback parent task is missing'
                USING ERRCODE = '55000';
            END IF;
            IF project_id IS NULL THEN
              CONTINUE;
            END IF;
            peer_project_id := project_id;
            SELECT project."deletionState"
            INTO project_state
            FROM "o_project" AS project
            WHERE project."id" = project_id
            FOR SHARE OF project;
          ELSE
            RAISE EXCEPTION 'unsupported indirect relation guard %',
              relation_kind
              USING ERRCODE = '55000';
          END IF;

          IF project_state = 'finalizing' THEN
            SELECT EXISTS (
              SELECT 1
              FROM "o_project" AS project
              INNER JOIN ${operationTable} AS operation
                ON operation."id" = project."deletionOperationId"
              WHERE project."id" = project_id
                AND project."deletionState" = 'finalizing'
                AND operation."kind" = 'project'
                AND operation."workspaceId" = project."workspaceId"
                AND operation."projectId" = project."id"
                AND operation."resourceId" = project."id"::text
                AND operation."requestedAt" =
                  project."deletionRequestedAt"
                AND operation."status" = 'deleting'
                AND operation."coordinatorLeaseOwner" IS NOT NULL
                AND operation."coordinatorFence" =
                  project."deletionFinalizeFence"
                AND operation."coordinatorLeaseExpiresAt"
                  > floor(
                    extract(epoch FROM clock_timestamp()) * 1000
                  )
            ) INTO project_finalizer_live;
          ELSE
            project_finalizer_live := TRUE;
          END IF;

          IF project_id IS NULL
            OR peer_project_id IS DISTINCT FROM project_id
            OR project_state IS NULL
            OR (
              TG_OP = 'INSERT'
              AND project_state IS DISTINCT FROM 'active'
            )
            OR (
              TG_OP <> 'INSERT'
              AND (
                project_state NOT IN ('active', 'finalizing')
                OR (
                  project_state = 'finalizing'
                  AND NOT project_finalizer_live
                )
              )
              AND NOT (
                relation_kind = 'relay_callback'
                AND TG_OP = 'DELETE'
                AND project_state = 'deleted'
              )
            )
          THEN
            RAISE EXCEPTION 'indirect project relation % is not writable',
              relation_kind
              USING ERRCODE = '55000';
          END IF;
        END LOOP;
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
      END;
      $$
    `);
    for (const relation of INDIRECT_RELATION_KINDS) {
      const table = quoteSqlIdentifier(relation.tableName);
      const trigger = quoteSqlIdentifier(
        `trg_${relation.tableName.slice(2)}_indirect_project_write`,
      );
      await database.raw(`DROP TRIGGER IF EXISTS ${trigger} ON ${table}`);
      await database.raw(`
        CREATE TRIGGER ${trigger}
        BEFORE INSERT OR UPDATE OR DELETE ON ${table}
        FOR EACH ROW EXECUTE FUNCTION ${relationFunction}('${relation.kind}')
      `);
    }

    await database.raw(`
      CREATE OR REPLACE FUNCTION ${flowFunction}()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      DECLARE
        target_flow_id bigint;
        referenced_project_count bigint;
      BEGIN
        IF TG_OP = 'INSERT' THEN
          RETURN NEW;
        END IF;
        IF TG_OP = 'UPDATE' AND NEW."id" IS DISTINCT FROM OLD."id" THEN
          RAISE EXCEPTION 'image flow identity is immutable'
            USING ERRCODE = '55000';
        END IF;
        target_flow_id := OLD."id";
        IF EXISTS (
          SELECT 1 FROM "o_assets" WHERE "flowId" = target_flow_id
          UNION ALL
          SELECT 1 FROM "o_storyboard" WHERE "flowId" = target_flow_id
        ) THEN
          PERFORM 1
          FROM "o_project" AS project
          WHERE project."id" IN (
            SELECT "projectId" FROM "o_assets"
            WHERE "flowId" = target_flow_id
            UNION
            SELECT "projectId" FROM "o_storyboard"
            WHERE "flowId" = target_flow_id
          )
          ORDER BY project."id"
          FOR SHARE OF project;

          IF EXISTS (
            SELECT 1
            FROM "o_assets" AS parent
            LEFT JOIN "o_project" AS project
              ON project."id" = parent."projectId"
            WHERE parent."flowId" = target_flow_id
              AND (
                project."id" IS NULL
                OR project."deletionState" NOT IN ('active', 'finalizing')
                OR (
                  project."deletionState" = 'finalizing'
                  AND NOT (${liveProjectFinalizer})
                )
              )
            UNION ALL
            SELECT 1
            FROM "o_storyboard" AS parent
            LEFT JOIN "o_project" AS project
              ON project."id" = parent."projectId"
            WHERE parent."flowId" = target_flow_id
              AND (
                project."id" IS NULL
                OR project."deletionState" NOT IN ('active', 'finalizing')
                OR (
                  project."deletionState" = 'finalizing'
                  AND NOT (${liveProjectFinalizer})
                )
              )
          ) THEN
            RAISE EXCEPTION 'image flow project is not writable'
              USING ERRCODE = '55000';
          END IF;
          SELECT COUNT(DISTINCT flow_refs."projectId")
          INTO referenced_project_count
          FROM (
            SELECT "projectId" FROM "o_assets"
            WHERE "flowId" = target_flow_id
            UNION ALL
            SELECT "projectId" FROM "o_storyboard"
            WHERE "flowId" = target_flow_id
          ) AS flow_refs;
          IF referenced_project_count <> 1 THEN
            RAISE EXCEPTION 'image flow crosses project authority'
              USING ERRCODE = '55000';
          END IF;
        END IF;
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
      END;
      $$
    `);
    const flowTable = quoteSqlIdentifier("o_imageFlow");
    const flowTrigger = quoteSqlIdentifier(
      "trg_o_imageFlow_indirect_project_write",
    );
    await database.raw(`DROP TRIGGER IF EXISTS ${flowTrigger} ON ${flowTable}`);
    await database.raw(`
      CREATE TRIGGER ${flowTrigger}
      BEFORE INSERT OR UPDATE OR DELETE ON ${flowTable}
      FOR EACH ROW EXECUTE FUNCTION ${flowFunction}()
    `);

    await database.raw(`
      CREATE OR REPLACE FUNCTION ${flowReferenceFunction}()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      DECLARE
        target_flow_id bigint;
        target_project_id bigint;
        project_state text;
      BEGIN
        target_flow_id := (to_jsonb(NEW) ->> 'flowId')::bigint;
        target_project_id := (to_jsonb(NEW) ->> 'projectId')::bigint;
        IF target_flow_id IS NULL THEN
          RETURN NEW;
        END IF;
        PERFORM 1
        FROM "o_imageFlow" AS flow
        WHERE flow."id" = target_flow_id
        FOR UPDATE OF flow;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'image flow parent is missing'
            USING ERRCODE = '55000';
        END IF;
        SELECT project."deletionState"
        INTO project_state
        FROM "o_project" AS project
        WHERE project."id" = target_project_id
        FOR SHARE OF project;
        IF project_state IS DISTINCT FROM 'active' THEN
          RAISE EXCEPTION 'image flow project is not active'
            USING ERRCODE = '55000';
        END IF;
        IF EXISTS (
          SELECT 1 FROM "o_assets" AS parent
          WHERE parent."flowId" = target_flow_id
            AND parent."projectId" IS DISTINCT FROM target_project_id
          UNION ALL
          SELECT 1 FROM "o_storyboard" AS parent
          WHERE parent."flowId" = target_flow_id
            AND parent."projectId" IS DISTINCT FROM target_project_id
        ) THEN
          RAISE EXCEPTION 'image flow crosses project authority'
            USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    for (const tableName of ["o_assets", "o_storyboard"] as const) {
      const table = quoteSqlIdentifier(tableName);
      for (const suffix of ["insert", "update"] as const) {
        const trigger = quoteSqlIdentifier(
          `trg_${tableName.slice(2)}_image_flow_reference_${suffix}`,
        );
        const event = suffix === "insert"
          ? "INSERT"
          : "UPDATE OF \"flowId\", \"projectId\"";
        await database.raw(`DROP TRIGGER IF EXISTS ${trigger} ON ${table}`);
        await database.raw(`
          CREATE TRIGGER ${trigger}
          BEFORE ${event} ON ${table}
          FOR EACH ROW EXECUTE FUNCTION ${flowReferenceFunction}()
        `);
      }
    }
    return;
  }

  const liveProjectFinalizer = `EXISTS (
    SELECT 1
    FROM ${operationTable} AS operation
    WHERE operation."id" = project."deletionOperationId"
      AND operation."kind" = 'project'
      AND operation."workspaceId" = project."workspaceId"
      AND operation."projectId" = project."id"
      AND operation."resourceId" = CAST(project."id" AS TEXT)
      AND operation."requestedAt" = project."deletionRequestedAt"
      AND operation."status" = 'deleting'
      AND operation."coordinatorLeaseOwner" IS NOT NULL
      AND operation."coordinatorFence" = project."deletionFinalizeFence"
      AND operation."coordinatorLeaseExpiresAt"
        > CAST(strftime('%s', 'now') AS INTEGER) * 1000
  )`;
  for (const relation of INDIRECT_RELATION_KINDS) {
    const table = quoteSqlIdentifier(relation.tableName);
    const triggerBase =
      `trg_${relation.tableName.slice(2)}_indirect_project_write`;
    const insertValid = sqliteIndirectRelationIsWritable(
      relation.kind,
      "NEW",
      ["active"],
    );
    const updateNewValid = sqliteIndirectRelationIsWritable(
      relation.kind,
      "NEW",
      ["active", "finalizing"],
    );
    const updateOldValid = sqliteIndirectRelationIsWritable(
      relation.kind,
      "OLD",
      ["active", "finalizing"],
    );
    const deleteStates = relation.kind === "relay_callback"
      ? ["active", "finalizing", "deleted"]
      : ["active", "finalizing"];
    const deleteValid = sqliteIndirectRelationIsWritable(
      relation.kind,
      "OLD",
      deleteStates,
    );
    await database.raw(`
      CREATE TRIGGER IF NOT EXISTS ${quoteSqlIdentifier(`${triggerBase}_insert`)}
      BEFORE INSERT ON ${table}
      FOR EACH ROW WHEN NOT (${insertValid})
      BEGIN
        SELECT RAISE(ABORT, 'indirect project relation is not writable');
      END
    `);
    await database.raw(`
      CREATE TRIGGER IF NOT EXISTS ${quoteSqlIdentifier(`${triggerBase}_update`)}
      BEFORE UPDATE ON ${table}
      FOR EACH ROW WHEN NOT (${updateNewValid}) OR NOT (${updateOldValid})
      BEGIN
        SELECT RAISE(ABORT, 'indirect project relation is not writable');
      END
    `);
    await database.raw(`
      CREATE TRIGGER IF NOT EXISTS ${quoteSqlIdentifier(`${triggerBase}_delete`)}
      BEFORE DELETE ON ${table}
      FOR EACH ROW WHEN NOT (${deleteValid})
      BEGIN
        SELECT RAISE(ABORT, 'indirect project relation is not writable');
      END
    `);
  }

  await database.raw(`
    CREATE TRIGGER IF NOT EXISTS "trg_o_imageFlow_indirect_project_update"
    BEFORE UPDATE ON "o_imageFlow"
    FOR EACH ROW WHEN NEW."id" IS NOT OLD."id"
      OR (
        (
          EXISTS (SELECT 1 FROM "o_assets" WHERE "flowId" = OLD."id")
          OR EXISTS (
            SELECT 1 FROM "o_storyboard" WHERE "flowId" = OLD."id"
          )
        )
        AND (
          EXISTS (
            SELECT 1
            FROM "o_assets" AS parent
            LEFT JOIN "o_project" AS project
              ON project."id" = parent."projectId"
            WHERE parent."flowId" = OLD."id"
              AND (
                project."id" IS NULL
                OR project."deletionState" NOT IN ('active', 'finalizing')
                OR (
                  project."deletionState" = 'finalizing'
                  AND NOT (${liveProjectFinalizer})
                )
              )
          )
          OR EXISTS (
            SELECT 1
            FROM "o_storyboard" AS parent
            LEFT JOIN "o_project" AS project
              ON project."id" = parent."projectId"
            WHERE parent."flowId" = OLD."id"
              AND (
                project."id" IS NULL
                OR project."deletionState" NOT IN ('active', 'finalizing')
                OR (
                  project."deletionState" = 'finalizing'
                  AND NOT (${liveProjectFinalizer})
                )
              )
          )
          OR (
            SELECT COUNT(DISTINCT flow_refs."projectId")
            FROM (
              SELECT "projectId" FROM "o_assets"
              WHERE "flowId" = OLD."id"
              UNION ALL
              SELECT "projectId" FROM "o_storyboard"
              WHERE "flowId" = OLD."id"
            ) AS flow_refs
          ) <> 1
        )
      )
    BEGIN
      SELECT RAISE(ABORT, 'image flow project is not writable');
    END
  `);
  await database.raw(`
    CREATE TRIGGER IF NOT EXISTS "trg_o_imageFlow_indirect_project_delete"
    BEFORE DELETE ON "o_imageFlow"
    FOR EACH ROW WHEN (
      EXISTS (SELECT 1 FROM "o_assets" WHERE "flowId" = OLD."id")
      OR EXISTS (SELECT 1 FROM "o_storyboard" WHERE "flowId" = OLD."id")
    )
    AND (
      EXISTS (
        SELECT 1
        FROM "o_assets" AS parent
        LEFT JOIN "o_project" AS project
          ON project."id" = parent."projectId"
        WHERE parent."flowId" = OLD."id"
          AND (
            project."id" IS NULL
            OR project."deletionState" NOT IN ('active', 'finalizing')
            OR (
              project."deletionState" = 'finalizing'
              AND NOT (${liveProjectFinalizer})
            )
          )
      )
      OR EXISTS (
        SELECT 1
        FROM "o_storyboard" AS parent
        LEFT JOIN "o_project" AS project
          ON project."id" = parent."projectId"
        WHERE parent."flowId" = OLD."id"
          AND (
            project."id" IS NULL
            OR project."deletionState" NOT IN ('active', 'finalizing')
            OR (
              project."deletionState" = 'finalizing'
              AND NOT (${liveProjectFinalizer})
            )
          )
      )
      OR (
        SELECT COUNT(DISTINCT flow_refs."projectId")
        FROM (
          SELECT "projectId" FROM "o_assets"
          WHERE "flowId" = OLD."id"
          UNION ALL
          SELECT "projectId" FROM "o_storyboard"
          WHERE "flowId" = OLD."id"
        ) AS flow_refs
      ) <> 1
    )
    BEGIN
      SELECT RAISE(ABORT, 'image flow project is not writable');
    END
  `);
  for (const tableName of ["o_assets", "o_storyboard"] as const) {
    const table = quoteSqlIdentifier(tableName);
    for (const suffix of ["insert", "update"] as const) {
      const event = suffix === "insert"
        ? "INSERT"
        : "UPDATE OF \"flowId\", \"projectId\"";
      await database.raw(`
        CREATE TRIGGER IF NOT EXISTS ${quoteSqlIdentifier(`trg_${tableName.slice(2)}_image_flow_reference_${suffix}`)}
        BEFORE ${event} ON ${table}
        FOR EACH ROW WHEN NEW."flowId" IS NOT NULL
          AND (
            NOT EXISTS (
              SELECT 1 FROM "o_imageFlow"
              WHERE "id" = NEW."flowId"
            )
            OR NOT EXISTS (
              SELECT 1 FROM "o_project"
              WHERE "id" = NEW."projectId"
                AND "deletionState" = 'active'
            )
            OR EXISTS (
              SELECT 1 FROM "o_assets" AS parent
              WHERE parent."flowId" = NEW."flowId"
                AND parent."projectId" IS NOT NEW."projectId"
            )
            OR EXISTS (
              SELECT 1 FROM "o_storyboard" AS parent
              WHERE parent."flowId" = NEW."flowId"
                AND parent."projectId" IS NOT NEW."projectId"
            )
          )
        BEGIN
          SELECT RAISE(ABORT, 'image flow crosses project authority');
        END
      `);
    }
  }
}

async function requireTables(
  trx: Knex.Transaction,
  tableNames: readonly string[],
): Promise<void> {
  const missing: string[] = [];
  for (const tableName of tableNames) {
    if (!(await trx.schema.hasTable(tableName))) missing.push(tableName);
  }
  if (missing.length) {
    throw new Error(
      `Migration deletion_workflow requires existing tables: ${missing.join(", ")}`,
    );
  }
}

async function requireProjectDeletionFinalizerTables(
  trx: Knex.Transaction,
): Promise<void> {
  await requireTables(
    trx,
    PROJECT_DELETION_FINALIZER_REQUIRED_SCHEMA.map(({ table }) => table),
  );
}

async function requireProjectDeletionFinalizerColumns(
  trx: Knex.Transaction,
): Promise<void> {
  const missing: string[] = [];
  for (const requirement of PROJECT_DELETION_FINALIZER_REQUIRED_SCHEMA) {
    for (const column of requirement.columns) {
      if (!(await trx.schema.hasColumn(requirement.table, column))) {
        missing.push(`${requirement.table}.${column}`);
      }
    }
  }
  if (missing.length) {
    throw new Error(
      "Migration deletion_workflow requires existing finalizer columns: "
        + missing.join(", "),
    );
  }
}

async function addBusinessDeletionMarker(
  trx: Knex.Transaction,
  tableName: string,
): Promise<void> {
  const hasState = await trx.schema.hasColumn(tableName, "deletionState");
  const hasOperationId = await trx.schema.hasColumn(
    tableName,
    "deletionOperationId",
  );
  const hasRequestedAt = await trx.schema.hasColumn(
    tableName,
    "deletionRequestedAt",
  );
  const needsFinalizeFence = [
    "o_project",
    "o_assets",
    "o_image",
    "o_media_asset",
  ].includes(tableName);
  const hasFinalizeFence = !needsFinalizeFence
    || await trx.schema.hasColumn(tableName, "deletionFinalizeFence");
  if (hasState && hasOperationId && hasRequestedAt && hasFinalizeFence) return;
  if (hasState || hasOperationId || hasRequestedAt) {
    if (!(hasState && hasOperationId && hasRequestedAt && !hasFinalizeFence)) {
      throw new Error(
        `Migration deletion_workflow found a partial deletion marker on ${tableName}`,
      );
    }
  } else if (!isPostgresClient(trx)) {
    const table = quoteSqlIdentifier(tableName);
    await trx.raw(
      `ALTER TABLE ${table}`
        + ` ADD COLUMN ${quoteSqlIdentifier("deletionState")}`
        + " TEXT NOT NULL DEFAULT 'active'",
    );
    await trx.raw(
      `ALTER TABLE ${table}`
        + ` ADD COLUMN ${quoteSqlIdentifier("deletionOperationId")} TEXT`,
    );
    await trx.raw(
      `ALTER TABLE ${table}`
        + ` ADD COLUMN ${quoteSqlIdentifier("deletionRequestedAt")} INTEGER`,
    );
    await trx.raw(
      `CREATE INDEX IF NOT EXISTS ${quoteSqlIdentifier(`idx_${tableName.slice(2)}_deletion_state`)}`
        + ` ON ${table} (${quoteSqlIdentifier("deletionState")},`
        + ` ${quoteSqlIdentifier("deletionRequestedAt")})`,
    );
    await trx.raw(
      `CREATE INDEX IF NOT EXISTS ${quoteSqlIdentifier(`idx_${tableName.slice(2)}_deletion_operation`)}`
        + ` ON ${table} (${quoteSqlIdentifier("deletionOperationId")})`,
    );
  } else {
    await trx.schema.alterTable(tableName, (table) => {
      table
        .text("deletionState")
        .notNullable()
        .defaultTo("active")
        .checkIn(
          ["active", "deleting", "finalizing", "deleted"],
          `chk_${tableName.slice(2)}_deletion_state`,
        );
      table
        .text("deletionOperationId")
        .references("id")
        .inTable(DELETION_OPERATION_TABLE)
        .onDelete("RESTRICT");
      table.bigInteger("deletionRequestedAt");
      table.index(
        ["deletionState", "deletionRequestedAt"],
        `idx_${tableName.slice(2)}_deletion_state`,
      );
      table.index(
        ["deletionOperationId"],
        `idx_${tableName.slice(2)}_deletion_operation`,
      );
    });
  }
  if (needsFinalizeFence && !hasFinalizeFence) {
    if (isPostgresClient(trx)) {
      await trx.schema.alterTable(tableName, (table) => {
        table.bigInteger("deletionFinalizeFence");
      });
    } else {
      await trx.raw(
        `ALTER TABLE ${quoteSqlIdentifier(tableName)}`
          + ` ADD COLUMN ${quoteSqlIdentifier("deletionFinalizeFence")} INTEGER`,
      );
    }
  }
}

async function addStorageKeyColumn(
  trx: Knex.Transaction,
  tableName: string,
  columnName: string,
): Promise<void> {
  if (await trx.schema.hasColumn(tableName, columnName)) return;
  await trx.schema.alterTable(tableName, (table) => {
    table.text(columnName);
    table.index(
      [columnName],
      `idx_${tableName.slice(2)}_${columnName.replace(/[A-Z]/gu, (value) => `_${value.toLowerCase()}`)}`,
    );
  });
}

async function addAssetHierarchyColumn(
  trx: Knex.Transaction,
): Promise<void> {
  if (!(await trx.schema.hasColumn("o_assets", "assetsId"))) {
    await trx.schema.alterTable("o_assets", (table) => {
      table.bigInteger("assetsId");
      table.index(["assetsId"], "idx_o_assets_parent_asset");
    });
  }
  const indexes = await tableIndexRows(trx, "o_assets");
  if (!indexes.some((index) => index.name === "idx_o_assets_parent_asset")) {
    await trx.schema.alterTable("o_assets", (table) => {
      table.index(["assetsId"], "idx_o_assets_parent_asset");
    });
  }
  if (!(await trx.schema.hasColumn("o_assets", "flowId"))) {
    await trx.schema.alterTable("o_assets", (table) => {
      table.bigInteger("flowId");
    });
  }
  if (!(await trx.schema.hasColumn("o_image", "state"))) {
    await trx.schema.alterTable("o_image", (table) => {
      table.text("state");
    });
  }
}

async function ensureProjectDeletionFinalizerIndexes(
  trx: Knex.Transaction,
): Promise<void> {
  for (const spec of PROJECT_DELETION_FINALIZER_INDEX_SPECS) {
    if (isPostgresClient(trx)) {
      await ensureExactPostgresFinalizerIndex(trx, spec);
      continue;
    }
    const indexes = await tableIndexRows(trx, spec.table);
    if (indexes.some((index) => index.name === spec.name)) continue;
    await trx.schema.alterTable(spec.table, (table) => {
      table.index([...spec.columns], spec.name);
    });
  }
}

async function addMediaAssetProjectOwnership(
  trx: Knex.Transaction,
): Promise<void> {
  if (!(await trx.schema.hasColumn("o_media_asset", "projectId"))) {
    await trx.schema.alterTable("o_media_asset", (table) => {
      table.bigInteger("projectId");
      table.index(
        ["workspaceId", "projectId"],
        DELETION_WORKFLOW_INDEXES.mediaAssetProject,
      );
    });
  }

  // Historical rows can only be backfilled when the existing assetId link is
  // corroborated by the authoritative o_assets row. Unprovable rows remain
  // unowned and therefore cannot be swept by a project deletion.
  const historical = await trx("o_media_asset")
    .whereNull("projectId")
    .select("id", "workspaceId", "metadata")
    .limit(MAX_INLINE_MEDIA_ASSET_BACKFILL + 1);
  if (historical.length > MAX_INLINE_MEDIA_ASSET_BACKFILL) {
    throw new Error(
      "Migration deletion_workflow found more than 10000 unowned media assets; "
        + "run the audited offline projectId backfill before retrying",
    );
  }
  const mediaByAssetId = new Map<number, string[]>();
  for (const row of historical) {
    let metadata: Record<string, unknown>;
    try {
      const parsed = JSON.parse(String(row.metadata || "{}"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        continue;
      }
      metadata = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    const assetId = Number(metadata.assetId);
    if (!Number.isSafeInteger(assetId) || assetId <= 0) continue;
    const ids = mediaByAssetId.get(assetId) ?? [];
    ids.push(String(row.id));
    mediaByAssetId.set(assetId, ids);
  }
  const projectByAssetId = new Map<number, number>();
  const assetIds = [...mediaByAssetId.keys()];
  for (let offset = 0; offset < assetIds.length; offset += 500) {
    const rows = await trx("o_assets")
      .whereIn("id", assetIds.slice(offset, offset + 500))
      .select("id", "projectId");
    for (const row of rows) {
      const assetId = Number(row.id);
      const projectId = Number(row.projectId);
      if (
        Number.isSafeInteger(assetId)
        && assetId > 0
        && Number.isSafeInteger(projectId)
        && projectId > 0
      ) {
        projectByAssetId.set(assetId, projectId);
      }
    }
  }
  const mediaByProjectId = new Map<number, string[]>();
  for (const [assetId, mediaIds] of mediaByAssetId) {
    const projectId = projectByAssetId.get(assetId);
    if (!projectId) continue;
    mediaByProjectId.set(
      projectId,
      [...(mediaByProjectId.get(projectId) ?? []), ...mediaIds],
    );
  }
  const projectIds = [...mediaByProjectId.keys()];
  const projectRows = projectIds.length
    ? await trx("o_project")
      .whereIn("id", projectIds)
      .select("id", "workspaceId")
    : [];
  const workspaceByProjectId = new Map(
    projectRows.map((row) => [
      Number(row.id),
      String(row.workspaceId || ""),
    ]),
  );
  const historicalById = new Map(
    historical.map((row) => [String(row.id), row]),
  );
  for (const [projectId, mediaIds] of mediaByProjectId) {
    const projectWorkspaceId = workspaceByProjectId.get(projectId);
    if (!projectWorkspaceId) {
      throw new Error(
        `Migration deletion_workflow cannot prove workspace for media project ${projectId}`,
      );
    }
    for (const mediaId of mediaIds) {
      const media = historicalById.get(mediaId);
      const mediaWorkspaceId = String(media?.workspaceId || "");
      if (mediaWorkspaceId && mediaWorkspaceId !== projectWorkspaceId) {
        throw new Error(
          `Migration deletion_workflow found cross-workspace media ownership for ${mediaId}`,
        );
      }
    }
    for (let offset = 0; offset < mediaIds.length; offset += 500) {
      await trx("o_media_asset")
        .whereIn("id", mediaIds.slice(offset, offset + 500))
        .whereNull("projectId")
        .update({
          projectId,
          workspaceId: projectWorkspaceId,
        });
    }
  }
}

function addProjectCandidate(
  candidates: Map<string, Set<number>>,
  taskId: unknown,
  projectId: unknown,
): void {
  const normalizedTaskId = String(taskId || "").trim();
  const normalizedProjectId = Number(projectId);
  if (
    !normalizedTaskId
    || !Number.isSafeInteger(normalizedProjectId)
    || normalizedProjectId <= 0
  ) return;
  const values = candidates.get(normalizedTaskId) ?? new Set<number>();
  values.add(normalizedProjectId);
  candidates.set(normalizedTaskId, values);
}

async function ensureProjectOwnershipIndex(
  trx: Knex.Transaction,
  tableName: string,
  indexName: string,
): Promise<void> {
  const indexes = await tableIndexRows(trx, tableName);
  if (indexes.some((index) => index.name === indexName)) return;
  await trx.raw(
    `CREATE INDEX ${quoteSqlIdentifier(indexName)}`
      + ` ON ${quoteSqlIdentifier(tableName)}`
      + ` (${quoteSqlIdentifier("workspaceId")}, ${quoteSqlIdentifier("projectId")})`,
  );
}

async function addRelayTaskProjectOwnership(
  trx: Knex.Transaction,
): Promise<void> {
  if (!(await trx.schema.hasColumn("o_relay_task", "projectId"))) {
    await trx.schema.alterTable("o_relay_task", (table) => {
      table.bigInteger("projectId");
    });
  }
  await ensureProjectOwnershipIndex(
    trx,
    "o_relay_task",
    DELETION_WORKFLOW_INDEXES.relayTaskProject,
  );

  const tasks = await trx("o_relay_task")
    .whereNull("projectId")
    .select("id", "workspaceId", "status")
    .limit(MAX_INLINE_PROJECT_OWNERSHIP_BACKFILL + 1);
  if (tasks.length > MAX_INLINE_PROJECT_OWNERSHIP_BACKFILL) {
    throw new Error(
      "Migration deletion_workflow found more than 10000 unowned relay tasks; "
        + "run the audited offline projectId backfill before retrying",
    );
  }
  const taskIds = tasks
    .map((row) => String(row.id || "").trim())
    .filter(Boolean);
  if (!taskIds.length) return;

  const candidates = new Map<string, Set<number>>();
  const [videos, mediaAssets] = await Promise.all([
    trx("o_video")
      .whereIn("relayTaskId", taskIds)
      .whereNotNull("projectId")
      .select("relayTaskId", "projectId"),
    trx("o_media_asset")
      .whereIn("taskId", taskIds)
      .whereNotNull("projectId")
      .select("taskId", "projectId"),
  ]);
  for (const row of videos) {
    addProjectCandidate(candidates, row.relayTaskId, row.projectId);
  }
  for (const row of mediaAssets) {
    addProjectCandidate(candidates, row.taskId, row.projectId);
  }

  const candidateProjectIds = [...new Set(
    [...candidates.values()].flatMap((values) => [...values]),
  )];
  const projects = candidateProjectIds.length
    ? await trx("o_project")
      .whereIn("id", candidateProjectIds)
      .select("id", "workspaceId")
    : [];
  const workspaceByProjectId = new Map(
    projects.map((project) => [
      Number(project.id),
      String(project.workspaceId || ""),
    ]),
  );
  for (const task of tasks) {
    const taskId = String(task.id || "").trim();
    const values = candidates.get(taskId);
    if (!values?.size) {
      if (
        ["queued", "running", "enhancing"].includes(
          String(task.status || ""),
        )
      ) {
        throw new Error(
          `Migration deletion_workflow cannot prove project ownership for active relay task ${taskId}`,
        );
      }
      continue;
    }
    if (values.size !== 1) {
      throw new Error(
        `Migration deletion_workflow found conflicting project ownership for relay task ${taskId}`,
      );
    }
    const [projectId] = values;
    const projectWorkspaceId = workspaceByProjectId.get(projectId);
    const taskWorkspaceId = String(task.workspaceId || "");
    if (
      !projectWorkspaceId
      || (taskWorkspaceId && taskWorkspaceId !== projectWorkspaceId)
    ) {
      throw new Error(
        `Migration deletion_workflow found invalid workspace ownership for relay task ${taskId}`,
      );
    }
    await trx("o_relay_task")
      .where({ id: taskId })
      .whereNull("projectId")
      .update({
        projectId,
        workspaceId: projectWorkspaceId,
      });
  }
}

async function addUserVideoEnhanceBillingReconciliation(
  trx: Knex.Transaction,
): Promise<void> {
  const tableName = "o_user_video_enhance_task";
  const table = quoteSqlIdentifier(tableName);
  const additions = [
    {
      name: "billingReconciliationState",
      sql: `TEXT NOT NULL DEFAULT 'unknown'`,
    },
    {
      name: "billingReconciliationEvidenceJson",
      sql: `TEXT NOT NULL DEFAULT '{}'`,
    },
    { name: "billingReconciliationError", sql: "TEXT" },
    {
      name: "billingReconciliationUpdatedAt",
      sql: "BIGINT NOT NULL DEFAULT 0",
    },
    { name: "finalizationLeaseOwner", sql: "TEXT" },
    { name: "finalizationLeaseExpiresAt", sql: "BIGINT" },
    {
      name: "finalizationFence",
      sql: "BIGINT NOT NULL DEFAULT 0",
    },
  ] as const;
  for (const addition of additions) {
    if (await trx.schema.hasColumn(tableName, addition.name)) continue;
    await trx.raw(
      `ALTER TABLE ${table} ADD COLUMN ${quoteSqlIdentifier(addition.name)} ${addition.sql}`,
    );
  }

  const indexes = await tableIndexRows(trx, tableName);
  if (!indexes.some((index) => index.name === USER_ENHANCE_BILLING_STATE_INDEX)) {
    await trx.raw(
      `CREATE INDEX ${quoteSqlIdentifier(USER_ENHANCE_BILLING_STATE_INDEX)}`
        + ` ON ${table} (${quoteSqlIdentifier("billingReconciliationState")})`,
    );
  }
  if (!indexes.some((index) =>
    index.name === USER_ENHANCE_FINALIZATION_LEASE_INDEX)) {
    await trx.raw(
      `CREATE INDEX ${quoteSqlIdentifier(USER_ENHANCE_FINALIZATION_LEASE_INDEX)}`
        + ` ON ${table} (${quoteSqlIdentifier("finalizationLeaseExpiresAt")})`,
    );
  }

  if (isPostgresClient(trx)) {
    const guardFunction = quoteSqlIdentifier(
      USER_ENHANCE_BILLING_GUARD_FUNCTION,
    );
    const guardTrigger = quoteSqlIdentifier(
      USER_ENHANCE_BILLING_GUARD_TRIGGER,
    );
    await trx.raw(`
      CREATE OR REPLACE FUNCTION ${guardFunction}()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          IF OLD."reservationId" IS NOT NULL
            OR OLD."billingReconciliationState" NOT IN ('pending', 'not_billed')
          THEN
            RAISE EXCEPTION 'user enhance billing evidence is durable'
              USING ERRCODE = '55000';
          END IF;
          RETURN OLD;
        END IF;

        IF NEW."billingReconciliationState" NOT IN (
          'pending',
          'not_billed',
          'reserved',
          'settlement_pending',
          'settled',
          'release_pending',
          'released',
          'unknown'
        ) THEN
          RAISE EXCEPTION 'invalid user enhance billing reconciliation state'
            USING ERRCODE = '23514';
        END IF;
        IF NEW."billingReconciliationUpdatedAt" < 0
          OR jsonb_typeof(NEW."billingReconciliationEvidenceJson"::jsonb)
            IS DISTINCT FROM 'object'
        THEN
          RAISE EXCEPTION 'invalid user enhance billing reconciliation evidence'
            USING ERRCODE = '23514';
        END IF;
        IF NEW."finalizationFence" < 0
          OR (
            (NEW."finalizationLeaseOwner" IS NULL)
              IS DISTINCT FROM
            (NEW."finalizationLeaseExpiresAt" IS NULL)
          )
          OR (
            NEW."finalizationLeaseOwner" IS NOT NULL
            AND (
              length(NEW."finalizationLeaseOwner") NOT BETWEEN 1 AND 255
              OR NEW."finalizationLeaseOwner"
                IS DISTINCT FROM trim(NEW."finalizationLeaseOwner")
              OR NEW."finalizationLeaseExpiresAt" < 0
            )
          )
        THEN
          RAISE EXCEPTION 'invalid user enhance finalization lease'
            USING ERRCODE = '23514';
        END IF;
        IF NEW."billingReconciliationState" IN (
          'reserved',
          'settlement_pending',
          'settled',
          'release_pending',
          'released'
        ) AND (
          NEW."reservationId" IS NULL
          OR NEW."usageRecordId" IS NULL
        ) THEN
          RAISE EXCEPTION 'reconciled user enhance billing requires ledger identity'
            USING ERRCODE = '23514';
        END IF;
        IF NEW."billingReconciliationState" IN ('pending', 'not_billed')
          AND (
            NEW."reservationId" IS NOT NULL
            OR NEW."usageRecordId" IS NOT NULL
          )
        THEN
          RAISE EXCEPTION 'unreserved user enhance billing cannot carry ledger identity'
            USING ERRCODE = '23514';
        END IF;
        IF NEW."billingReconciliationState" IN ('not_billed', 'settled', 'released')
          AND NEW."billingReconciliationEvidenceJson"::jsonb = '{}'::jsonb
        THEN
          RAISE EXCEPTION 'terminal user enhance billing requires evidence'
            USING ERRCODE = '23514';
        END IF;

        IF TG_OP = 'UPDATE' THEN
          IF OLD."reservationId" IS NOT NULL
            AND NEW."reservationId" IS DISTINCT FROM OLD."reservationId"
          THEN
            RAISE EXCEPTION 'user enhance reservation identity is immutable'
              USING ERRCODE = '55000';
          END IF;
          IF OLD."usageRecordId" IS NOT NULL
            AND NEW."usageRecordId" IS DISTINCT FROM OLD."usageRecordId"
          THEN
            RAISE EXCEPTION 'user enhance usage identity is immutable'
              USING ERRCODE = '55000';
          END IF;
          IF NEW."billingReconciliationUpdatedAt"
            < OLD."billingReconciliationUpdatedAt"
          THEN
            RAISE EXCEPTION 'user enhance billing evidence time cannot regress'
              USING ERRCODE = '23514';
          END IF;
          IF NEW."finalizationFence" < OLD."finalizationFence"
            OR NEW."finalizationFence" > OLD."finalizationFence" + 1
          THEN
            RAISE EXCEPTION 'invalid user enhance finalization fence'
              USING ERRCODE = '23514';
          END IF;
          IF NEW."finalizationFence" = OLD."finalizationFence" + 1
            AND (
              NEW."finalizationLeaseOwner" IS NULL
              OR NEW."finalizationLeaseExpiresAt" IS NULL
              OR NEW."status" IS DISTINCT FROM 'reconciling'
            )
          THEN
            RAISE EXCEPTION 'finalization claim requires owner and lease'
              USING ERRCODE = '23514';
          END IF;
          IF NEW."finalizationLeaseOwner"
              IS DISTINCT FROM OLD."finalizationLeaseOwner"
            AND NEW."finalizationLeaseOwner" IS NOT NULL
            AND NEW."finalizationFence" <> OLD."finalizationFence" + 1
          THEN
            RAISE EXCEPTION 'finalization owner change requires next fence'
              USING ERRCODE = '23514';
          END IF;
          IF NEW."finalizationLeaseOwner" IS NULL
            AND OLD."finalizationLeaseOwner" IS NOT NULL
            AND NEW."billingReconciliationState"
              NOT IN ('settled', 'released', 'unknown')
          THEN
            RAISE EXCEPTION 'finalization lease can clear only at billing terminal'
              USING ERRCODE = '23514';
          END IF;
          IF OLD."billingReconciliationState" IN (
            'not_billed',
            'settled',
            'released'
          ) AND (
            NEW."billingReconciliationState"
              IS DISTINCT FROM OLD."billingReconciliationState"
            OR NEW."billingReconciliationEvidenceJson"
              IS DISTINCT FROM OLD."billingReconciliationEvidenceJson"
            OR NEW."billingReconciliationError"
              IS DISTINCT FROM OLD."billingReconciliationError"
            OR NEW."billingReconciliationUpdatedAt"
              IS DISTINCT FROM OLD."billingReconciliationUpdatedAt"
          ) THEN
            RAISE EXCEPTION 'terminal user enhance billing evidence is immutable'
              USING ERRCODE = '55000';
          END IF;
          IF NEW."billingReconciliationState"
            IS DISTINCT FROM OLD."billingReconciliationState"
            AND NOT (
              (OLD."billingReconciliationState" = 'pending'
                AND NEW."billingReconciliationState"
                  IN ('not_billed', 'reserved', 'unknown'))
              OR (OLD."billingReconciliationState" = 'reserved'
                AND NEW."billingReconciliationState"
                  IN ('settlement_pending', 'release_pending', 'unknown'))
              OR (OLD."billingReconciliationState" = 'settlement_pending'
                AND NEW."billingReconciliationState" IN ('settled', 'unknown'))
              OR (OLD."billingReconciliationState" = 'release_pending'
                AND NEW."billingReconciliationState" IN ('released', 'unknown'))
              OR (OLD."billingReconciliationState" = 'unknown'
                AND NEW."billingReconciliationState" IN (
                  'settlement_pending',
                  'settled',
                  'release_pending',
                  'released'
                ))
            )
          THEN
            RAISE EXCEPTION 'invalid user enhance billing reconciliation transition'
              USING ERRCODE = '23514';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await trx.raw(`DROP TRIGGER IF EXISTS ${guardTrigger} ON ${table}`);
    await trx.raw(`
      CREATE TRIGGER ${guardTrigger}
      BEFORE INSERT OR UPDATE OR DELETE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION ${guardFunction}()
    `);
    return;
  }

  const validation = `
    NEW."billingReconciliationState" NOT IN (
      'pending',
      'not_billed',
      'reserved',
      'settlement_pending',
      'settled',
      'release_pending',
      'released',
      'unknown'
    )
    OR NEW."billingReconciliationUpdatedAt" < 0
    OR NEW."finalizationFence" < 0
    OR (
      (NEW."finalizationLeaseOwner" IS NULL)
        IS NOT
      (NEW."finalizationLeaseExpiresAt" IS NULL)
    )
    OR (
      NEW."finalizationLeaseOwner" IS NOT NULL
      AND (
        length(NEW."finalizationLeaseOwner") NOT BETWEEN 1 AND 255
        OR NEW."finalizationLeaseOwner"
          IS NOT trim(NEW."finalizationLeaseOwner")
        OR NEW."finalizationLeaseExpiresAt" < 0
      )
    )
    OR json_valid(NEW."billingReconciliationEvidenceJson") <> 1
    OR json_type(NEW."billingReconciliationEvidenceJson") <> 'object'
    OR (
      NEW."billingReconciliationState" IN (
        'reserved',
        'settlement_pending',
        'settled',
        'release_pending',
        'released'
      )
      AND (NEW."reservationId" IS NULL OR NEW."usageRecordId" IS NULL)
    )
    OR (
      NEW."billingReconciliationState" IN ('pending', 'not_billed')
      AND (NEW."reservationId" IS NOT NULL OR NEW."usageRecordId" IS NOT NULL)
    )
    OR (
      NEW."billingReconciliationState" IN ('not_billed', 'settled', 'released')
      AND json(NEW."billingReconciliationEvidenceJson") = json('{}')
    )
  `;
  for (const operation of ["INSERT", "UPDATE"] as const) {
    await trx.raw(`
      CREATE TRIGGER IF NOT EXISTS ${quoteSqlIdentifier(
        `${USER_ENHANCE_BILLING_GUARD_TRIGGER}_${operation.toLowerCase()}_validation`,
      )}
      BEFORE ${operation} ON ${table}
      FOR EACH ROW WHEN ${validation}
      BEGIN
        SELECT RAISE(
          ABORT,
          'invalid user enhance billing reconciliation evidence'
        );
      END
    `);
  }
  await trx.raw(`
    CREATE TRIGGER IF NOT EXISTS ${quoteSqlIdentifier(
      `${USER_ENHANCE_BILLING_GUARD_TRIGGER}_update_identity`,
    )}
    BEFORE UPDATE ON ${table}
    FOR EACH ROW WHEN
      (OLD."reservationId" IS NOT NULL
        AND NEW."reservationId" IS NOT OLD."reservationId")
      OR (OLD."usageRecordId" IS NOT NULL
        AND NEW."usageRecordId" IS NOT OLD."usageRecordId")
      OR NEW."billingReconciliationUpdatedAt"
        < OLD."billingReconciliationUpdatedAt"
    BEGIN
      SELECT RAISE(ABORT, 'user enhance billing identity is immutable');
    END
  `);
  await trx.raw(`
    CREATE TRIGGER IF NOT EXISTS ${quoteSqlIdentifier(
      `${USER_ENHANCE_BILLING_GUARD_TRIGGER}_update_finalization`,
    )}
    BEFORE UPDATE ON ${table}
    FOR EACH ROW WHEN
      NEW."finalizationFence" < OLD."finalizationFence"
      OR NEW."finalizationFence" > OLD."finalizationFence" + 1
      OR (
        NEW."finalizationFence" = OLD."finalizationFence" + 1
        AND (
          NEW."finalizationLeaseOwner" IS NULL
          OR NEW."finalizationLeaseExpiresAt" IS NULL
          OR NEW."status" IS NOT 'reconciling'
        )
      )
      OR (
        NEW."finalizationLeaseOwner" IS NOT OLD."finalizationLeaseOwner"
        AND NEW."finalizationLeaseOwner" IS NOT NULL
        AND NEW."finalizationFence" <> OLD."finalizationFence" + 1
      )
      OR (
        NEW."finalizationLeaseOwner" IS NULL
        AND OLD."finalizationLeaseOwner" IS NOT NULL
        AND NEW."billingReconciliationState"
          NOT IN ('settled', 'released', 'unknown')
      )
    BEGIN
      SELECT RAISE(ABORT, 'invalid user enhance finalization lease transition');
    END
  `);
  await trx.raw(`
    CREATE TRIGGER IF NOT EXISTS ${quoteSqlIdentifier(
      `${USER_ENHANCE_BILLING_GUARD_TRIGGER}_update_terminal`,
    )}
    BEFORE UPDATE ON ${table}
    FOR EACH ROW WHEN OLD."billingReconciliationState" IN (
      'not_billed',
      'settled',
      'released'
    ) AND (
      NEW."billingReconciliationState" IS NOT OLD."billingReconciliationState"
      OR NEW."billingReconciliationEvidenceJson"
        IS NOT OLD."billingReconciliationEvidenceJson"
      OR NEW."billingReconciliationError"
        IS NOT OLD."billingReconciliationError"
      OR NEW."billingReconciliationUpdatedAt"
        IS NOT OLD."billingReconciliationUpdatedAt"
    )
    BEGIN
      SELECT RAISE(ABORT, 'terminal user enhance billing evidence is immutable');
    END
  `);
  await trx.raw(`
    CREATE TRIGGER IF NOT EXISTS ${quoteSqlIdentifier(
      `${USER_ENHANCE_BILLING_GUARD_TRIGGER}_update_transition`,
    )}
    BEFORE UPDATE ON ${table}
    FOR EACH ROW WHEN
      NEW."billingReconciliationState" IS NOT OLD."billingReconciliationState"
      AND NOT (
        (OLD."billingReconciliationState" = 'pending'
          AND NEW."billingReconciliationState"
            IN ('not_billed', 'reserved', 'unknown'))
        OR (OLD."billingReconciliationState" = 'reserved'
          AND NEW."billingReconciliationState"
            IN ('settlement_pending', 'release_pending', 'unknown'))
        OR (OLD."billingReconciliationState" = 'settlement_pending'
          AND NEW."billingReconciliationState" IN ('settled', 'unknown'))
        OR (OLD."billingReconciliationState" = 'release_pending'
          AND NEW."billingReconciliationState" IN ('released', 'unknown'))
        OR (OLD."billingReconciliationState" = 'unknown'
          AND NEW."billingReconciliationState" IN (
            'settlement_pending',
            'settled',
            'release_pending',
            'released'
          ))
      )
    BEGIN
      SELECT RAISE(
        ABORT,
        'invalid user enhance billing reconciliation transition'
      );
    END
  `);
  await trx.raw(`
    CREATE TRIGGER IF NOT EXISTS ${quoteSqlIdentifier(
      `${USER_ENHANCE_BILLING_GUARD_TRIGGER}_delete`,
    )}
    BEFORE DELETE ON ${table}
    FOR EACH ROW WHEN OLD."reservationId" IS NOT NULL
      OR OLD."billingReconciliationState" NOT IN ('pending', 'not_billed')
    BEGIN
      SELECT RAISE(ABORT, 'user enhance billing evidence is durable');
    END
  `);
}

async function addUserVideoEnhanceProjectOwnership(
  trx: Knex.Transaction,
): Promise<void> {
  const tableName = "o_user_video_enhance_task";
  if (!(await trx.schema.hasColumn(tableName, "projectId"))) {
    await trx.schema.alterTable(tableName, (table) => {
      table.bigInteger("projectId");
    });
  }
  await ensureProjectOwnershipIndex(
    trx,
    tableName,
    DELETION_WORKFLOW_INDEXES.userVideoEnhanceProject,
  );

  const tasks = await trx(tableName)
    .whereNull("projectId")
    .select(
      "id",
      "workspaceId",
      "sourceAssetId",
      "resultAssetId",
      "status",
    )
    .limit(MAX_INLINE_PROJECT_OWNERSHIP_BACKFILL + 1);
  if (tasks.length > MAX_INLINE_PROJECT_OWNERSHIP_BACKFILL) {
    throw new Error(
      "Migration deletion_workflow found more than 10000 unowned user video enhance tasks; "
        + "run the audited offline projectId backfill before retrying",
    );
  }
  const taskIds = tasks
    .map((row) => String(row.id || "").trim())
    .filter(Boolean);
  if (!taskIds.length) return;

  const referencedAssetIds = [...new Set(tasks
    .flatMap((task) => [task.sourceAssetId, task.resultAssetId])
    .map((value) => String(value || "").trim())
    .filter(Boolean))];
  const [referencedAssets, taskAssets] = await Promise.all([
    referencedAssetIds.length
      ? trx("o_media_asset")
        .whereIn("id", referencedAssetIds)
        .select("id", "workspaceId", "projectId")
      : [],
    trx("o_media_asset")
      .whereIn("taskId", taskIds)
      .select("id", "taskId", "workspaceId", "projectId"),
  ]);
  const referencedById = new Map(
    referencedAssets.map((asset) => [String(asset.id), asset]),
  );
  const candidates = new Map<string, Set<number>>();
  for (const task of tasks) {
    const taskId = String(task.id || "").trim();
    for (const assetId of [task.sourceAssetId, task.resultAssetId]) {
      const normalizedAssetId = String(assetId || "").trim();
      if (!normalizedAssetId) continue;
      const asset = referencedById.get(normalizedAssetId);
      if (
        !asset
        && normalizedAssetId === String(task.sourceAssetId || "").trim()
        && ["created", "enhancing"].includes(String(task.status || ""))
      ) {
        throw new Error(
          `Migration deletion_workflow cannot prove the active source asset for user enhance task ${taskId}`,
        );
      }
      if (asset) addProjectCandidate(candidates, taskId, asset.projectId);
    }
  }
  for (const asset of taskAssets) {
    addProjectCandidate(candidates, asset.taskId, asset.projectId);
  }

  const candidateProjectIds = [...new Set(
    [...candidates.values()].flatMap((values) => [...values]),
  )];
  const projects = candidateProjectIds.length
    ? await trx("o_project")
      .whereIn("id", candidateProjectIds)
      .select("id", "workspaceId")
    : [];
  const workspaceByProjectId = new Map(
    projects.map((project) => [
      Number(project.id),
      String(project.workspaceId || ""),
    ]),
  );
  for (const task of tasks) {
    const taskId = String(task.id || "").trim();
    const values = candidates.get(taskId);
    if (!values?.size) {
      if (["created", "enhancing"].includes(String(task.status || ""))) {
        throw new Error(
          `Migration deletion_workflow cannot prove project ownership for active user enhance task ${taskId}`,
        );
      }
      continue;
    }
    if (values.size !== 1) {
      throw new Error(
        `Migration deletion_workflow found conflicting project ownership for user enhance task ${taskId}`,
      );
    }
    const [projectId] = values;
    const projectWorkspaceId = workspaceByProjectId.get(projectId);
    if (
      !projectWorkspaceId
      || String(task.workspaceId || "") !== projectWorkspaceId
    ) {
      throw new Error(
        `Migration deletion_workflow found invalid workspace ownership for user enhance task ${taskId}`,
      );
    }
    await trx(tableName)
      .where({ id: taskId })
      .whereNull("projectId")
      .update({ projectId });
  }
}

async function createDeletionOperationTable(
  trx: Knex.Transaction,
): Promise<void> {
  if (await trx.schema.hasTable(DELETION_OPERATION_TABLE)) return;
  await trx.schema.createTable(DELETION_OPERATION_TABLE, (table) => {
    table.text("id").notNullable().primary();
    table.text("operationKey").notNullable();
    table.text("kind").notNullable();
    table.text("workspaceId").notNullable();
    table.bigInteger("projectId").notNullable();
    table.text("resourceId").notNullable();
    table.text("status").notNullable().defaultTo("preparing");
    table.text("requestHash").notNullable();
    table.text("manifestHash");
    table.bigInteger("manifestRevision").notNullable().defaultTo(0);
    table.bigInteger("expectedItemCount");
    table.bigInteger("requestedBy").notNullable();
    table.bigInteger("requestedAt").notNullable();
    table.bigInteger("finalizedAt");
    table.text("auditSnapshot");
    table.text("auditSnapshotHash");
    table.text("errorCode");
    table.text("coordinatorLeaseOwner");
    table.bigInteger("coordinatorLeaseExpiresAt");
    table.bigInteger("coordinatorFence").notNullable().defaultTo(0);
    table.bigInteger("retryCount").notNullable().defaultTo(0);
    table.bigInteger("nextAttemptAt").notNullable();
    table.bigInteger("createdAt").notNullable();
    table.bigInteger("updatedAt").notNullable();

    table.unique(
      ["operationKey"],
      DELETION_WORKFLOW_INDEXES.operationKey,
    );
    table.index(
      ["status", "nextAttemptAt", "coordinatorLeaseExpiresAt"],
      DELETION_WORKFLOW_INDEXES.operationStatusDue,
    );
    table.index(
      ["workspaceId", "projectId", "requestedAt"],
      DELETION_WORKFLOW_INDEXES.operationProject,
    );
    table.check(
      "\"kind\" IN ('image', 'asset', 'project')",
      {},
      "chk_o_deletion_operation_kind",
    );
    table.check(
      "\"status\" IN ('preparing', 'deleting', 'completed', 'blocked')",
      {},
      "chk_o_deletion_operation_status",
    );
    table.check(
      "length(\"requestHash\") = 64"
        + " AND (\"manifestHash\" IS NULL OR length(\"manifestHash\") = 64)"
        + " AND (\"auditSnapshotHash\" IS NULL"
        + " OR length(\"auditSnapshotHash\") = 64)",
      {},
      "chk_o_deletion_operation_hashes",
    );
    table.check(
      "(\"kind\" = 'project' AND \"status\" = 'completed'"
        + " AND \"auditSnapshot\" IS NOT NULL"
        + " AND length(\"auditSnapshot\") BETWEEN 2 AND 262144"
        + " AND \"auditSnapshotHash\" IS NOT NULL)"
        + " OR (NOT (\"kind\" = 'project' AND \"status\" = 'completed')"
        + " AND \"auditSnapshot\" IS NULL"
        + " AND \"auditSnapshotHash\" IS NULL)",
      {},
      "chk_o_deletion_operation_audit_snapshot",
    );
    table.check(
      "\"manifestRevision\" >= 0"
        + " AND (\"expectedItemCount\" IS NULL OR \"expectedItemCount\" >= 0)"
        + " AND \"coordinatorFence\" >= 0"
        + " AND \"retryCount\" >= 0",
      {},
      "chk_o_deletion_operation_counters",
    );
    table.check(
      "(\"coordinatorLeaseOwner\" IS NULL AND \"coordinatorLeaseExpiresAt\" IS NULL)"
        + " OR (\"status\" IN ('preparing', 'deleting')"
        + " AND \"coordinatorLeaseOwner\" IS NOT NULL"
        + " AND \"coordinatorLeaseExpiresAt\" IS NOT NULL)",
      {},
      "chk_o_deletion_operation_lease",
    );
    table.check(
      "(\"status\" = 'preparing'"
        + " AND \"manifestHash\" IS NULL"
        + " AND \"expectedItemCount\" IS NULL"
        + " AND \"finalizedAt\" IS NULL)"
        + " OR (\"status\" = 'deleting'"
        + " AND \"manifestHash\" IS NOT NULL"
        + " AND \"expectedItemCount\" IS NOT NULL"
        + " AND \"finalizedAt\" IS NULL)"
        + " OR (\"status\" = 'completed'"
        + " AND \"manifestHash\" IS NOT NULL"
        + " AND \"expectedItemCount\" IS NOT NULL"
        + " AND \"finalizedAt\" IS NOT NULL"
        + " AND \"errorCode\" IS NULL)"
        + " OR (\"status\" = 'blocked'"
        + " AND \"finalizedAt\" IS NULL"
        + " AND \"errorCode\" IS NOT NULL)",
      {},
      "chk_o_deletion_operation_lifecycle",
    );
    table.check(
      "\"projectId\" > 0 AND \"requestedBy\" > 0"
        + " AND \"requestedAt\" >= 0"
        + " AND \"nextAttemptAt\" >= 0"
        + " AND \"createdAt\" >= 0"
        + " AND \"updatedAt\" >= 0"
        + " AND (\"finalizedAt\" IS NULL OR \"finalizedAt\" >= \"requestedAt\")",
      {},
      "chk_o_deletion_operation_times",
    );
  });
}

async function createDeletionResourceAliasTable(
  trx: Knex.Transaction,
): Promise<void> {
  if (await trx.schema.hasTable(DELETION_RESOURCE_ALIAS_TABLE)) return;
  await trx.schema.createTable(DELETION_RESOURCE_ALIAS_TABLE, (table) => {
    table.text("resourceType").notNullable();
    table.text("resourceId").notNullable();
    table
      .text("operationId")
      .notNullable()
      .references("id")
      .inTable(DELETION_OPERATION_TABLE)
      .onDelete("RESTRICT");
    table.text("workspaceId").notNullable();
    table.bigInteger("projectId").notNullable();
    table.bigInteger("createdAt").notNullable();

    table.primary(["resourceType", "resourceId"]);
    table.index(
      ["operationId"],
      DELETION_WORKFLOW_INDEXES.resourceAliasOperation,
    );
    table.check(
      "\"resourceType\" IN ('asset', 'media_asset')"
        + " AND length(\"resourceId\") BETWEEN 1 AND 255",
      {},
      "chk_o_deletion_resource_alias_identity",
    );
    table.check(
      "\"projectId\" > 0 AND \"createdAt\" >= 0",
      {},
      "chk_o_deletion_resource_alias_values",
    );
  });
}

async function createDeletionOutboxTable(
  trx: Knex.Transaction,
): Promise<void> {
  if (await trx.schema.hasTable(DELETION_OUTBOX_TABLE)) return;
  await trx.schema.createTable(DELETION_OUTBOX_TABLE, (table) => {
    table.text("id").notNullable().primary();
    table
      .text("operationId")
      .notNullable()
      .references("id")
      .inTable(DELETION_OPERATION_TABLE)
      .onDelete("RESTRICT");
    table.text("dedupeKey").notNullable();
    table.text("payloadHash").notNullable();
    table.text("resourceType").notNullable();
    table.text("resourceId").notNullable();
    table.text("bucket").notNullable();
    table.text("objectKey").notNullable();
    table.text("deleteType").notNullable();
    table.text("targetGeneration").notNullable();
    table.text("conditionalToken").notNullable();
    table.text("status").notNullable();
    table.text("errorCode");
    table.bigInteger("retryCount").notNullable();
    table.bigInteger("maxRetries").notNullable();
    table.bigInteger("nextAttemptAt").notNullable();
    table.text("leaseOwner");
    table.bigInteger("leaseExpiresAt");
    table.bigInteger("leaseFence").notNullable();
    table.text("reconcileOwner");
    table.bigInteger("reconcileExpiresAt");
    table.bigInteger("reconcileFence").notNullable().defaultTo(0);
    table.bigInteger("reconcileRetryCount").notNullable().defaultTo(0);
    table.text("dispatchProviderId");
    table.text("dispatchIdempotencyKey");
    table.text("dispatchTargetFingerprint");
    table.bigInteger("dispatchMarkedAt");
    table.bigInteger("providerDispatchAt");
    table.text("providerReceiptOutcome");
    table.text("providerReceiptCode");
    table.text("providerRequestId");
    table.bigInteger("providerReceiptAt");
    table.bigInteger("createdAt").notNullable();
    table.bigInteger("updatedAt").notNullable();
    table.bigInteger("completedAt");

    table.unique(["dedupeKey"], DELETION_WORKFLOW_INDEXES.outboxDedupe);
    table.index(
      ["operationId"],
      DELETION_WORKFLOW_INDEXES.outboxOperation,
    );
    table.index(
      ["status", "nextAttemptAt", "leaseExpiresAt"],
      DELETION_WORKFLOW_INDEXES.outboxDispatchDue,
    );
    table.index(
      ["status", "nextAttemptAt", "reconcileExpiresAt"],
      DELETION_WORKFLOW_INDEXES.outboxReconcileDue,
    );
    table.check(
      "\"deleteType\" IN ('file', 'prefix')",
      {},
      "chk_o_deletion_outbox_delete_type",
    );
    table.check(
      "\"status\" IN ('pending', 'leased', 'dispatching',"
        + " 'pending_reconcile', 'failed_retryable', 'completed', 'dead')",
      {},
      "chk_o_deletion_outbox_status",
    );
    table.check(
      "\"retryCount\" BETWEEN 0 AND 101"
        + " AND \"maxRetries\" BETWEEN 0 AND 100"
        + " AND \"leaseFence\" >= 0"
        + " AND \"reconcileFence\" >= 0"
        + " AND \"reconcileRetryCount\" BETWEEN 0 AND 101",
      {},
      "chk_o_deletion_outbox_counters",
    );
    table.check(
      "(\"reconcileOwner\" IS NULL AND \"reconcileExpiresAt\" IS NULL)"
        + " OR (\"reconcileOwner\" IS NOT NULL AND \"reconcileExpiresAt\" IS NOT NULL)",
      {},
      "chk_o_deletion_outbox_reconcile_lease_pair",
    );
    table.check(
      "(\"status\" IN ('leased', 'dispatching')"
        + " AND \"leaseOwner\" IS NOT NULL AND \"leaseExpiresAt\" IS NOT NULL)"
        + " OR (\"status\" = 'pending_reconcile'"
        + " AND ((\"leaseOwner\" IS NULL AND \"leaseExpiresAt\" IS NULL)"
        + " OR (\"leaseOwner\" IS NOT NULL AND \"leaseExpiresAt\" IS NOT NULL)))"
        + " OR (\"status\" NOT IN ('leased', 'dispatching', 'pending_reconcile')"
        + " AND \"leaseOwner\" IS NULL AND \"leaseExpiresAt\" IS NULL)",
      {},
      "chk_o_deletion_outbox_dispatch_lease_state",
    );
    table.check(
      "\"status\" = 'pending_reconcile'"
        + " OR (\"reconcileOwner\" IS NULL AND \"reconcileExpiresAt\" IS NULL)",
      {},
      "chk_o_deletion_outbox_reconcile_lease_state",
    );
    table.check(
      "(\"dispatchProviderId\" IS NULL"
        + " AND \"dispatchIdempotencyKey\" IS NULL"
        + " AND \"dispatchTargetFingerprint\" IS NULL"
        + " AND \"dispatchMarkedAt\" IS NULL)"
        + " OR (\"dispatchProviderId\" IS NOT NULL"
        + " AND \"dispatchIdempotencyKey\" IS NOT NULL"
        + " AND \"dispatchTargetFingerprint\" IS NOT NULL"
        + " AND \"dispatchMarkedAt\" IS NOT NULL)",
      {},
      "chk_o_deletion_outbox_dispatch_evidence_pair",
    );
    table.check(
      "(\"status\" NOT IN ('pending', 'leased', 'failed_retryable')"
        + " OR \"dispatchProviderId\" IS NULL)",
      {},
      "chk_o_deletion_outbox_dispatch_evidence_state",
    );
    table.check(
      "(\"providerDispatchAt\" IS NULL OR (\"dispatchMarkedAt\" IS NOT NULL"
        + " AND \"providerDispatchAt\" >= \"dispatchMarkedAt\"))",
      {},
      "chk_o_deletion_outbox_provider_dispatch_time",
    );
    table.check(
      "(\"dispatchProviderId\" IS NULL OR (length(\"dispatchProviderId\") BETWEEN 1 AND 255"
        + " AND \"dispatchProviderId\" = trim(\"dispatchProviderId\")))"
        + " AND (\"dispatchIdempotencyKey\" IS NULL"
        + " OR length(\"dispatchIdempotencyKey\") = 64)"
        + " AND (\"dispatchTargetFingerprint\" IS NULL"
        + " OR length(\"dispatchTargetFingerprint\") = 64)"
        + " AND (\"providerRequestId\" IS NULL"
        + " OR (length(\"providerRequestId\") BETWEEN 1 AND 512"
        + " AND \"providerRequestId\" = trim(\"providerRequestId\")))",
      {},
      "chk_o_deletion_outbox_evidence_lengths",
    );
    table.check(
      "(\"dispatchMarkedAt\" IS NULL OR \"dispatchMarkedAt\" >= 0)"
        + " AND (\"providerDispatchAt\" IS NULL OR \"providerDispatchAt\" >= 0)"
        + " AND (\"providerReceiptAt\" IS NULL OR \"providerReceiptAt\" >= 0)"
        + " AND (\"reconcileExpiresAt\" IS NULL OR \"reconcileExpiresAt\" >= 0)",
      {},
      "chk_o_deletion_outbox_evidence_times",
    );
    table.check(
      "(\"providerReceiptOutcome\" IS NULL"
        + " AND \"providerReceiptCode\" IS NULL"
        + " AND \"providerRequestId\" IS NULL"
        + " AND \"providerReceiptAt\" IS NULL)"
        + " OR (\"providerReceiptOutcome\" IS NOT NULL"
        + " AND \"providerReceiptCode\" IS NOT NULL"
        + " AND \"providerRequestId\" IS NOT NULL"
        + " AND \"providerReceiptAt\" IS NOT NULL"
        + " AND \"providerDispatchAt\" IS NOT NULL"
        + " AND \"providerReceiptAt\" >= \"providerDispatchAt\""
        + " AND ((\"providerReceiptOutcome\" = 'deleted'"
        + " AND \"providerReceiptCode\" = 'TARGET_DELETED')"
        + " OR (\"providerReceiptOutcome\" = 'target_already_absent'"
        + " AND \"providerReceiptCode\" = 'TARGET_ALREADY_ABSENT')))",
      {},
      "chk_o_deletion_outbox_receipt_evidence",
    );
    table.check(
      "\"providerReceiptAt\" IS NULL OR \"status\" = 'completed'",
      {},
      "chk_o_deletion_outbox_receipt_terminal",
    );
    table.check(
      "\"status\" <> 'pending_reconcile'"
        + " OR \"errorCode\" = 'dispatch_outcome_unknown'",
      {},
      "chk_o_deletion_outbox_reconcile_error",
    );
  });
}

/** Registered as the contiguous deletion_workflow migration in the central chain. */
export async function upDeletionWorkflow(
  trx: Knex.Transaction,
): Promise<void> {
  await requireProjectDeletionFinalizerTables(trx);
  // Reject a bad/invalid concurrent prebuild before this migration performs
  // any DDL. Missing indexes are created (and re-verified) later.
  await validateExistingPostgresFinalizerIndexes(trx);
  await requireTables(
    trx,
    [...new Set([
      ...DELETION_MARKER_TABLES,
      ...STORAGE_KEY_COLUMNS.map(({ table }) => table),
      "o_relay_task",
      "o_user_video_enhance_task",
    ])],
  );
  await createDeletionOperationTable(trx);
  await upDeletionChunkStoreSchema(trx);
  await createDeletionResourceAliasTable(trx);
  await createDeletionOutboxTable(trx);
  await upObjectWriteIntent(trx);
  await addAssetHierarchyColumn(trx);
  for (const tableName of DELETION_MARKER_TABLES) {
    await addBusinessDeletionMarker(trx, tableName);
  }
  for (const storage of STORAGE_KEY_COLUMNS) {
    for (const columnName of storage.columns) {
      await addStorageKeyColumn(trx, storage.table, columnName);
    }
  }
  await addMediaAssetProjectOwnership(trx);
  await addRelayTaskProjectOwnership(trx);
  await addUserVideoEnhanceBillingReconciliation(trx);
  await addUserVideoEnhanceProjectOwnership(trx);
  await requireProjectDeletionFinalizerColumns(trx);
  await ensureProjectDeletionFinalizerIndexes(trx);
  await ensureProjectDeletionWriteGuards(trx);
  await ensureMediaAssetDeletionGuards(trx);
  await ensureIndirectProjectDeletionWriteGuards(trx);
  await ensureDeletionEvidenceGuards(trx);
  await ensureImageDeletionStorageKeyReservationGuards(trx);
}

export async function downDeletionWorkflow(): Promise<void> {
  throw new Error(
    "Migration deletion_workflow cannot be rolled back safely because deletion tombstones, generation-bound targets and provider receipts are audit evidence.",
  );
}
