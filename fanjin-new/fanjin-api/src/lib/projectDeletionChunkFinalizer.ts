import crypto from "node:crypto";
import type { Knex } from "knex";

export const PROJECT_DELETION_FINALIZER_BATCH_SIZE = 500;

// Leaves room below SQLite's traditional 999 bind-parameter ceiling for
// scope and eligibility predicates.
const SINGLE_KEY_MUTATION_SLICE_SIZE = 400;
const COMPOSITE_KEY_MUTATION_SLICE_SIZE = 200;

export type ProjectDeletionFinalizerStepCategory =
  | "relationship"
  | "child"
  | "scrub"
  | "direct";

export type ProjectDeletionFinalizerAction = "delete" | "scrub";

export interface ProjectDeletionFinalizerStep {
  readonly ordinal: number;
  readonly name: string;
  readonly category: ProjectDeletionFinalizerStepCategory;
  readonly action: ProjectDeletionFinalizerAction;
  readonly physicalTables: readonly string[];
}

/**
 * This order is part of the durable db_finalize checkpoint contract.
 *
 * Relationship and child rows must disappear before their direct project
 * content. Content-bearing Agent replay rows are deleted, while the immutable
 * evidence tables listed in PROJECT_DELETION_FINALIZER_RETAINED_TABLES are
 * deliberately absent.
 */
export const PROJECT_DELETION_FINALIZER_STEPS = [
  {
    ordinal: 0,
    name: "relations.script_assets_by_script",
    category: "relationship",
    action: "delete",
    physicalTables: ["o_scriptAssets"],
  },
  {
    ordinal: 1,
    name: "relations.script_assets_by_asset",
    category: "relationship",
    action: "delete",
    physicalTables: ["o_scriptAssets"],
  },
  {
    ordinal: 2,
    name: "relations.assets_storyboard_by_storyboard",
    category: "relationship",
    action: "delete",
    physicalTables: ["o_assets2Storyboard"],
  },
  {
    ordinal: 3,
    name: "relations.assets_storyboard_by_asset",
    category: "relationship",
    action: "delete",
    physicalTables: ["o_assets2Storyboard"],
  },
  {
    ordinal: 4,
    name: "relations.asset_audio_by_role",
    category: "relationship",
    action: "delete",
    physicalTables: ["o_assetsRole2Audio"],
  },
  {
    ordinal: 5,
    name: "relations.asset_audio_by_audio",
    category: "relationship",
    action: "delete",
    physicalTables: ["o_assetsRole2Audio"],
  },
  {
    ordinal: 6,
    name: "children.images",
    category: "child",
    action: "delete",
    physicalTables: ["o_image"],
  },
  {
    ordinal: 7,
    name: "children.event_chapters",
    category: "child",
    action: "delete",
    physicalTables: ["o_eventChapter", "o_event"],
  },
  {
    ordinal: 8,
    name: "children.agent_events",
    category: "child",
    action: "delete",
    physicalTables: ["o_agent_event"],
  },
  {
    ordinal: 9,
    name: "children.agent_messages",
    category: "child",
    action: "delete",
    physicalTables: ["o_agent_message"],
  },
  {
    ordinal: 10,
    name: "scrub.relay_callbacks",
    category: "scrub",
    action: "scrub",
    physicalTables: ["o_relay_callback_delivery"],
  },
  {
    ordinal: 11,
    name: "scrub.relay_tasks",
    category: "scrub",
    action: "scrub",
    physicalTables: ["o_relay_task"],
  },
  {
    ordinal: 12,
    name: "scrub.user_video_enhance_tasks",
    category: "scrub",
    action: "scrub",
    physicalTables: ["o_user_video_enhance_task"],
  },
  {
    ordinal: 13,
    name: "direct.agent_threads",
    category: "direct",
    action: "delete",
    physicalTables: ["o_agent_thread"],
  },
  {
    ordinal: 14,
    name: "direct.creation_sessions",
    category: "direct",
    action: "delete",
    physicalTables: ["o_creation_session"],
  },
  {
    ordinal: 15,
    name: "direct.canvas_assets",
    category: "direct",
    action: "delete",
    physicalTables: ["o_canvas_asset"],
  },
  {
    ordinal: 16,
    name: "direct.workflow_graphs",
    category: "direct",
    action: "delete",
    physicalTables: ["o_workflow_graph"],
  },
  {
    ordinal: 17,
    name: "direct.agent_work_data",
    category: "direct",
    action: "delete",
    physicalTables: ["o_agentWorkData"],
  },
  {
    ordinal: 18,
    name: "direct.novels",
    category: "direct",
    action: "delete",
    physicalTables: ["o_novel"],
  },
  {
    ordinal: 19,
    name: "direct.scripts",
    category: "direct",
    action: "delete",
    physicalTables: ["o_script"],
  },
  {
    ordinal: 20,
    name: "direct.tasks",
    category: "direct",
    action: "delete",
    physicalTables: ["o_tasks"],
  },
  {
    ordinal: 21,
    name: "direct.storyboards",
    category: "direct",
    action: "delete",
    physicalTables: ["o_storyboard", "o_imageFlow"],
  },
  {
    ordinal: 22,
    name: "direct.assets",
    category: "direct",
    action: "delete",
    physicalTables: ["o_assets", "o_imageFlow"],
  },
  {
    ordinal: 23,
    name: "direct.videos",
    category: "direct",
    action: "delete",
    physicalTables: ["o_video"],
  },
  {
    ordinal: 24,
    name: "direct.video_tracks",
    category: "direct",
    action: "delete",
    physicalTables: ["o_videoTrack"],
  },
  {
    ordinal: 25,
    name: "direct.media_assets",
    category: "direct",
    action: "delete",
    physicalTables: ["o_media_asset"],
  },
  {
    ordinal: 26,
    name: "direct.memories",
    category: "direct",
    action: "delete",
    physicalTables: ["memories"],
  },
  {
    ordinal: 27,
    name: "tombstone.project",
    category: "scrub",
    action: "scrub",
    physicalTables: ["o_project"],
  },
] as const satisfies readonly ProjectDeletionFinalizerStep[];

export type ProjectDeletionFinalizerPhysicalTable =
  typeof PROJECT_DELETION_FINALIZER_STEPS[number]["physicalTables"][number];

const PROJECT_DELETION_FINALIZER_REQUIRED_COLUMNS = {
  o_scriptAssets: ["scriptId", "assetId"],
  o_assets2Storyboard: ["storyboardId", "assetId"],
  o_assetsRole2Audio: ["assetsRoleId", "assetsAudioId"],
  o_image: ["id", "assetsId"],
  o_eventChapter: ["id", "eventId", "novelId"],
  o_event: ["id"],
  o_agent_event: ["id", "workspaceId", "projectId"],
  o_agent_message: ["id", "workspaceId", "projectId"],
  o_relay_callback_delivery: [
    "id",
    "taskId",
    "callbackUrl",
    "secretCiphertext",
    "payload",
    "lastError",
  ],
  o_relay_task: [
    "id",
    "workspaceId",
    "projectId",
    "requestPayload",
    "providerPayload",
    "resultPayload",
    "errorMessage",
  ],
  o_user_video_enhance_task: [
    "id",
    "workspaceId",
    "projectId",
    "sourceUrl",
    "resultUrl",
    "errorMessage",
  ],
  o_agent_thread: ["id", "workspaceId", "projectId"],
  o_creation_session: ["id", "workspaceId", "projectId"],
  o_canvas_asset: ["id", "workspaceId", "projectId"],
  o_workflow_graph: ["id", "projectId"],
  o_agentWorkData: ["id", "projectId"],
  o_novel: ["id", "projectId"],
  o_script: ["id", "projectId"],
  o_tasks: ["id", "projectId"],
  o_storyboard: ["id", "projectId", "flowId"],
  o_imageFlow: ["id"],
  o_assets: ["id", "projectId", "flowId"],
  o_video: ["id", "projectId"],
  o_videoTrack: ["id", "projectId"],
  o_media_asset: ["id", "workspaceId", "projectId"],
  memories: ["id", "isolationKey"],
  o_project: [
    "id",
    "workspaceId",
    "deletionState",
    "deletionOperationId",
    "deletionRequestedAt",
    "deletionFinalizeFence",
    "projectType",
    "imageModel",
    "imageQuality",
    "videoModel",
    "name",
    "intro",
    "type",
    "artStyle",
    "directorManual",
    "mode",
    "videoRatio",
    "coverImageUrl",
    "coverStorageKey",
    "agentBudgetMicros",
    "agentBudgetReservedMicros",
    "revision",
    "updatedAt",
  ],
} as const satisfies Record<
  ProjectDeletionFinalizerPhysicalTable,
  readonly string[]
>;

/**
 * Required runtime schema for every physical table the stable 28-step
 * finalizer accesses. The table set is derived exclusively from
 * PROJECT_DELETION_FINALIZER_STEPS so migration and runtime cannot silently
 * diverge when a step adds another physical table.
 */
export const PROJECT_DELETION_FINALIZER_REQUIRED_SCHEMA = Object.freeze(
  [...new Set(
  PROJECT_DELETION_FINALIZER_STEPS.flatMap((step) => step.physicalTables),
  )].map((table) => Object.freeze({
    table,
    columns: Object.freeze([
      ...PROJECT_DELETION_FINALIZER_REQUIRED_COLUMNS[table],
    ]),
  })),
);

/**
 * These rows are durable audit, recovery, usage, or finance evidence. This
 * module never mutates them during project finalization.
 */
export const PROJECT_DELETION_FINALIZER_RETAINED_TABLES = [
  "o_agent_approval",
  "o_agent_delegation",
  "o_agent_delegation_usage",
  "o_agent_generation_quote",
  "o_agent_generation_review",
  "o_agent_review_report",
  "o_agent_run",
  "o_agent_step",
  "o_canvas_command_mutation",
  "o_creation_session_mutation",
  "o_project_mutation",
  "o_usage_record",
  "o_object_write_intent",
] as const;

export interface ProjectDeletionFinalizerCursor {
  batch: number;
}

export interface ProjectDeletionFinalizerPosition {
  tableOrdinal: number;
  tableName: string;
  cursor: ProjectDeletionFinalizerCursor;
}

export interface ProjectDeletionFinalizerScope {
  projectId: number;
  workspaceId: string;
}

export interface ProjectDeletionFinalizerAuthority {
  operationId: string;
  requestedAt: number;
  fence: number;
  finalizedAt: number;
}

export interface ProjectDeletionFinalizerAuditChunk {
  tableOrdinal: number;
  tableName: string;
  inputCursor: ProjectDeletionFinalizerCursor;
  outputCursor: ProjectDeletionFinalizerCursor;
  rowCount: number;
  rowsHash: string;
}

export interface RunProjectDeletionFinalizerBatchInput
  extends ProjectDeletionFinalizerPosition {
  scope: ProjectDeletionFinalizerScope;
  authority: ProjectDeletionFinalizerAuthority;
  batchSize?: number;
  beforeApply: (
    transaction: Knex.Transaction,
    audit: Readonly<ProjectDeletionFinalizerAuditChunk>,
  ) => Promise<void>;
}

export type ProjectDeletionFinalizerBatchResult =
  | {
    kind: "applied";
    step: ProjectDeletionFinalizerStep;
    audit: ProjectDeletionFinalizerAuditChunk;
    next: ProjectDeletionFinalizerPosition;
  }
  | {
    kind: "step_complete";
    step: ProjectDeletionFinalizerStep;
    next: ProjectDeletionFinalizerPosition;
  }
  | {
    kind: "complete";
    step: ProjectDeletionFinalizerStep;
    next: null;
  }
  | {
    kind: "completed";
    step: ProjectDeletionFinalizerStep;
    audit: ProjectDeletionFinalizerAuditChunk;
    next: null;
  };

export type ProjectDeletionChunkFinalizerErrorCode =
  | "PROJECT_DELETION_FINALIZER_TRANSACTION_REQUIRED"
  | "PROJECT_DELETION_FINALIZER_INPUT_INVALID"
  | "PROJECT_DELETION_FINALIZER_SCOPE_LOST"
  | "PROJECT_DELETION_FINALIZER_MUTATION_CONFLICT";

export class ProjectDeletionChunkFinalizerError extends Error {
  readonly code: ProjectDeletionChunkFinalizerErrorCode;
  readonly status: number;

  constructor(
    message: string,
    code: ProjectDeletionChunkFinalizerErrorCode,
    status: number,
  ) {
    super(message);
    this.name = "ProjectDeletionChunkFinalizerError";
    this.code = code;
    this.status = status;
  }
}

type RawRow = Record<string, unknown>;

interface BatchMutation {
  evidence: Readonly<{
    table: string;
    identity: RawRow;
    before: RawRow;
    action: RawRow;
  }>;
}

interface SelectedMutationBatch {
  mutations: BatchMutation[];
  apply: () => Promise<void>;
}

type StepSelector = (
  transaction: Knex.Transaction,
  scope: Readonly<ProjectDeletionFinalizerScope>,
  limit: number,
  authority: Readonly<ProjectDeletionFinalizerAuthority>,
) => Promise<SelectedMutationBatch>;

function fail(
  message: string,
  code: ProjectDeletionChunkFinalizerErrorCode,
  status: number,
): never {
  throw new ProjectDeletionChunkFinalizerError(message, code, status);
}

function inputInvalid(message: string): never {
  fail(message, "PROJECT_DELETION_FINALIZER_INPUT_INVALID", 400);
}

function mutationConflict(tableName: string): never {
  fail(
    `${tableName} 在审计写入与终结动作之间发生变化`,
    "PROJECT_DELETION_FINALIZER_MUTATION_CONFLICT",
    409,
  );
}

function assertCallerTransaction(transaction: Knex.Transaction): void {
  if (!(transaction as unknown as { isTransaction?: boolean }).isTransaction) {
    fail(
      "项目删除分块终结器必须使用调用方提供的 transaction",
      "PROJECT_DELETION_FINALIZER_TRANSACTION_REQUIRED",
      500,
    );
  }
}

function normalizeScope(
  scope: ProjectDeletionFinalizerScope,
): ProjectDeletionFinalizerScope {
  const projectId = Number(scope?.projectId);
  const workspaceId = String(scope?.workspaceId || "").trim();
  if (!Number.isSafeInteger(projectId) || projectId <= 0) {
    inputInvalid("projectId 必须是正安全整数");
  }
  if (!workspaceId || workspaceId.length > 255) {
    inputInvalid("workspaceId 无效");
  }
  return { projectId, workspaceId };
}

function normalizeAuthority(
  authority: ProjectDeletionFinalizerAuthority,
): ProjectDeletionFinalizerAuthority {
  const operationId = String(authority?.operationId || "").trim();
  const requestedAt = Number(authority?.requestedAt);
  const fence = Number(authority?.fence);
  const finalizedAt = Number(authority?.finalizedAt);
  if (
    !operationId
    || operationId.length > 255
    || /[\u0000-\u001f\u007f]/u.test(operationId)
    || !Number.isSafeInteger(requestedAt)
    || requestedAt < 0
    || !Number.isSafeInteger(fence)
    || fence <= 0
    || !Number.isSafeInteger(finalizedAt)
    || finalizedAt < requestedAt
  ) {
    inputInvalid("项目终结 authority 无效");
  }
  return { operationId, requestedAt, fence, finalizedAt };
}

function normalizeCursor(value: unknown): ProjectDeletionFinalizerCursor {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    inputInvalid("db_finalize cursor 必须是 {batch} 对象");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 1
    || !Object.prototype.hasOwnProperty.call(record, "batch")
    || !Number.isSafeInteger(record.batch)
    || Number(record.batch) < 0
  ) {
    inputInvalid("db_finalize cursor 必须只包含非负整数 batch");
  }
  return { batch: Number(record.batch) };
}

function normalizeBatchSize(value: number | undefined): number {
  if (value === undefined) return PROJECT_DELETION_FINALIZER_BATCH_SIZE;
  if (
    !Number.isSafeInteger(value)
    || value <= 0
    || value > PROJECT_DELETION_FINALIZER_BATCH_SIZE
  ) {
    inputInvalid(
      `batchSize 必须是 1-${PROJECT_DELETION_FINALIZER_BATCH_SIZE} 的整数`,
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  const normalize = (entry: unknown, depth: number): unknown => {
    if (depth > 32) inputInvalid("终结审计证据嵌套过深");
    if (
      entry === null
      || typeof entry === "string"
      || typeof entry === "boolean"
    ) {
      return entry;
    }
    if (typeof entry === "number") {
      if (!Number.isFinite(entry)) inputInvalid("终结审计证据包含无效数字");
      return entry;
    }
    if (typeof entry === "bigint") {
      return { $bigint: entry.toString() };
    }
    if (entry instanceof Date) {
      return { $date: entry.toISOString() };
    }
    if (Buffer.isBuffer(entry)) {
      return { $bytes: entry.toString("base64") };
    }
    if (Array.isArray(entry)) {
      if (seen.has(entry)) inputInvalid("终结审计证据不能包含循环引用");
      seen.add(entry);
      const result = entry.map((item) => normalize(item, depth + 1));
      seen.delete(entry);
      return result;
    }
    if (entry && typeof entry === "object") {
      if (seen.has(entry)) inputInvalid("终结审计证据不能包含循环引用");
      seen.add(entry);
      const normalized: RawRow = {};
      for (const key of Object.keys(entry as RawRow).sort()) {
        const item = (entry as RawRow)[key];
        if (
          item === undefined
          || typeof item === "function"
          || typeof item === "symbol"
        ) {
          continue;
        }
        normalized[key] = normalize(item, depth + 1);
      }
      seen.delete(entry);
      return normalized;
    }
    inputInvalid("终结审计证据包含不可序列化值");
  };
  return JSON.stringify(normalize(value, 0));
}

function hashBatch(
  step: ProjectDeletionFinalizerStep,
  scope: Readonly<ProjectDeletionFinalizerScope>,
  mutations: readonly BatchMutation[],
): string {
  return crypto.createHash("sha256").update(canonicalJson({
    version: "project-deletion-finalizer-batch.v1",
    step: {
      ordinal: step.ordinal,
      name: step.name,
      category: step.category,
      action: step.action,
      physicalTables: step.physicalTables,
    },
    scope,
    rows: mutations.map((mutation) => mutation.evidence),
  })).digest("hex");
}

function identityFrom(row: RawRow, keys: readonly string[]): RawRow {
  const identity: RawRow = {};
  for (const key of keys) {
    const value = row[key];
    if (value === undefined || value === null || value === "") {
      fail(
        `终结目标缺少稳定身份字段 ${key}`,
        "PROJECT_DELETION_FINALIZER_MUTATION_CONFLICT",
        409,
      );
    }
    identity[key] = value;
  }
  return identity;
}

function relatedIdentityKey(value: unknown): string {
  return canonicalJson(value);
}

function uniqueValues(values: readonly unknown[]): unknown[] {
  const seen = new Set<string>();
  const result: unknown[] = [];
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const key = relatedIdentityKey(value);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function bindValues(values: readonly unknown[]): Array<string | number> {
  return values.map((value) => {
    if (typeof value === "string" || typeof value === "number") return value;
    if (typeof value === "bigint") return value.toString();
    fail(
      "终结目标身份字段不是可绑定的标量",
      "PROJECT_DELETION_FINALIZER_MUTATION_CONFLICT",
      409,
    );
  });
}

function slices<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    result.push(values.slice(offset, offset + size));
  }
  return result;
}

async function lockRelatedRowsById(
  transaction: Knex.Transaction,
  tableName: string,
  values: readonly unknown[],
): Promise<Map<string, RawRow>> {
  const rows = new Map<string, RawRow>();
  for (const valueSlice of slices(
    uniqueValues(values),
    SINGLE_KEY_MUTATION_SLICE_SIZE,
  )) {
    const selected = await transaction<RawRow>(tableName)
      .whereIn("id", bindValues(valueSlice))
      .select("*")
      .orderBy("id", "asc")
      .forUpdate();
    for (const row of selected as unknown as RawRow[]) {
      rows.set(relatedIdentityKey(row.id), row);
    }
  }
  return rows;
}

function whereCompositeIdentities(
  query: Knex.QueryBuilder,
  identities: readonly RawRow[],
): void {
  query.andWhere(function exactCompositeIdentities() {
    identities.forEach((identity, index) => {
      if (index === 0) this.where(identity);
      else this.orWhere(identity);
    });
  });
}

function projectIdSubquery(
  transaction: Knex.Transaction,
  scope: Readonly<ProjectDeletionFinalizerScope>,
): Knex.QueryBuilder {
  return transaction("o_project")
    .select("id")
    .where({
      id: scope.projectId,
      workspaceId: scope.workspaceId,
    });
}

function scopedParentIdSubquery(
  transaction: Knex.Transaction,
  scope: Readonly<ProjectDeletionFinalizerScope>,
  tableName: string,
  excludeLibraryOwnedAssets = false,
): Knex.QueryBuilder {
  const query = transaction(`${tableName} as parent`)
    .select("parent.id")
    .whereIn("parent.projectId", projectIdSubquery(transaction, scope));
  if (tableName === "o_assets" && excludeLibraryOwnedAssets) {
    query.whereNotExists(
      transaction("o_asset_ownership as retained_ownership")
        .select(transaction.raw("1"))
        .whereRaw("?? = ??", [
          "retained_ownership.assetId",
          "parent.id",
        ]),
    );
  }
  return query;
}

async function assertProjectScope(
  transaction: Knex.Transaction,
  scope: Readonly<ProjectDeletionFinalizerScope>,
  authority: Readonly<ProjectDeletionFinalizerAuthority>,
): Promise<void> {
  const project = await transaction("o_project")
    .where({
      id: scope.projectId,
      workspaceId: scope.workspaceId,
      deletionState: "finalizing",
      deletionOperationId: authority.operationId,
      deletionRequestedAt: authority.requestedAt,
      deletionFinalizeFence: authority.fence,
    })
    .select("id")
    .forUpdate()
    .first();
  if (!project) {
    fail(
      "项目删除终结作用域或 authority 已失效",
      "PROJECT_DELETION_FINALIZER_SCOPE_LOST",
      409,
    );
  }
}

function makeRelationDeleteSelector(input: Readonly<{
  tableName: string;
  identityKeys: readonly string[];
  foreignKey: string;
  parentTable: string;
}>): StepSelector {
  return async (transaction, scope, limit) => {
    const excludeLibraryOwnedAssets = input.parentTable === "o_assets"
      && await transaction.schema.hasTable("o_asset_ownership");
    const rows = await transaction<RawRow>(`${input.tableName} as target`)
      .select("target.*")
      .whereIn(
        `target.${input.foreignKey}`,
        scopedParentIdSubquery(
          transaction,
          scope,
          input.parentTable,
          excludeLibraryOwnedAssets,
        ),
      )
      .orderBy(input.identityKeys.map((column) => ({
        column: `target.${column}`,
        order: "asc" as const,
      })))
      .limit(limit)
      .forUpdate();
    const normalizedRows = rows as unknown as RawRow[];
    const identities = normalizedRows.map((row) => (
      identityFrom(row, input.identityKeys)
    ));
    const mutations = normalizedRows.map((row, index) => {
      const identity = identities[index];
      return {
        evidence: {
          table: input.tableName,
          identity,
          before: row,
          action: {
            kind: "delete",
            table: input.tableName,
            identity,
          },
        },
      };
    });
    return {
      mutations,
      apply: async () => {
        let affectedTotal = 0;
        for (const identitySlice of slices(
          identities,
          COMPOSITE_KEY_MUTATION_SLICE_SIZE,
        )) {
          const deletion = transaction(input.tableName)
            .whereIn(
              input.foreignKey,
              scopedParentIdSubquery(
                transaction,
                scope,
                input.parentTable,
                excludeLibraryOwnedAssets,
              ),
            );
          whereCompositeIdentities(deletion, identitySlice);
          affectedTotal += Number(await deletion.delete());
        }
        if (affectedTotal !== normalizedRows.length) {
          mutationConflict(input.tableName);
        }
      },
    };
  };
}

function makeScopedDirectDeleteSelector(input: Readonly<{
  tableName: string;
  workspaceScoped?: boolean;
  deleteUnreferencedFlow?: boolean;
  retainLibraryOwnedAssets?: boolean;
}>): StepSelector {
  return async (transaction, scope, limit) => {
    const retainLibraryOwnedAssets = input.retainLibraryOwnedAssets === true
      && await transaction.schema.hasTable("o_asset_ownership");
    let query = transaction<RawRow>(`${input.tableName} as target`)
      .select("target.*")
      .where("target.projectId", scope.projectId);
    if (input.workspaceScoped) {
      query = query.where("target.workspaceId", scope.workspaceId);
    } else {
      query = query.whereIn(
        "target.projectId",
        projectIdSubquery(transaction, scope),
      );
    }
    if (retainLibraryOwnedAssets) {
      query = query.whereNotExists(
        transaction("o_asset_ownership as retained_ownership")
          .select(transaction.raw("1"))
          .whereRaw("?? = ??", [
            "retained_ownership.assetId",
            "target.id",
          ]),
      );
    }
    const rows = await query
      .orderBy("target.id", "asc")
      .limit(limit)
      .forUpdate();
    const normalizedRows = rows as unknown as RawRow[];
    const identities = normalizedRows.map((row) => identityFrom(row, ["id"]));
    const flowPlan = input.deleteUnreferencedFlow
      ? await planFlowCleanup(
        transaction,
        input.tableName,
        normalizedRows,
      )
      : null;
    const mutations = normalizedRows.map((row, index) => {
      const identity = identities[index];
      const flowId = input.deleteUnreferencedFlow
        && row.flowId !== null
        && row.flowId !== undefined
        ? row.flowId
        : null;
      const action: RawRow = {
        kind: "delete",
        table: input.tableName,
        identity,
      };
      if (flowId !== null) {
        action.after = {
          kind: "delete_if_unreferenced",
          table: "o_imageFlow",
          identity: { id: flowId },
          references: ["o_assets.flowId", "o_storyboard.flowId"],
          before: flowPlan?.beforeRows.get(relatedIdentityKey(flowId)) ?? null,
          willDeleteInBatch: flowPlan?.expectedDeleteKeys.has(
            relatedIdentityKey(flowId),
          ) ?? false,
        };
      }
      return {
        evidence: {
          table: input.tableName,
          identity,
          before: row,
          action,
        },
      };
    });
    return {
      mutations,
      apply: async () => {
        let affectedTotal = 0;
        const ids = identities.map((identity) => identity.id);
        for (const idSlice of slices(ids, SINGLE_KEY_MUTATION_SLICE_SIZE)) {
          let deletion = transaction(input.tableName)
            .whereIn("id", bindValues(idSlice))
            .where({ projectId: scope.projectId });
          if (input.workspaceScoped) {
            deletion = deletion.where({ workspaceId: scope.workspaceId });
          } else {
            deletion = deletion.whereIn(
              "projectId",
              projectIdSubquery(transaction, scope),
            );
          }
          if (retainLibraryOwnedAssets) {
            deletion = deletion.whereNotExists(
              transaction("o_asset_ownership as retained_ownership")
                .select(transaction.raw("1"))
                .whereRaw("?? = ??", [
                  "retained_ownership.assetId",
                  `${input.tableName}.id`,
                ]),
            );
          }
          affectedTotal += Number(await deletion.delete());
        }
        if (affectedTotal !== normalizedRows.length) {
          mutationConflict(input.tableName);
        }
        if (flowPlan) {
          await applyFlowCleanup(transaction, flowPlan);
        }
      },
    };
  };
}

interface SharedCleanupPlan {
  beforeRows: Map<string, RawRow>;
  candidateIds: unknown[];
  expectedDeleteKeys: Set<string>;
}

async function planFlowCleanup(
  transaction: Knex.Transaction,
  sourceTable: string,
  selectedRows: readonly RawRow[],
): Promise<SharedCleanupPlan> {
  const candidateValues = uniqueValues(selectedRows.map((row) => row.flowId));
  const beforeRows = await lockRelatedRowsById(
    transaction,
    "o_imageFlow",
    candidateValues,
  );
  const candidateIds = [...beforeRows.values()].map((row) => row.id);
  const expectedDeleteKeys = new Set<string>();
  for (const candidateSlice of slices(
    candidateIds,
    COMPOSITE_KEY_MUTATION_SLICE_SIZE,
  )) {
    const candidateKeys = new Set(candidateSlice.map(relatedIdentityKey));
    const selectedIds = selectedRows
      .filter((row) => candidateKeys.has(relatedIdentityKey(row.flowId)))
      .map((row) => identityFrom(row, ["id"]).id);
    let query = transaction<RawRow>("o_imageFlow as shared")
      .select("shared.id")
      .whereIn("shared.id", bindValues(candidateSlice));
    const assetReferences = transaction("o_assets as reference")
      .select(transaction.raw("1"))
      .whereRaw("?? = ??", ["reference.flowId", "shared.id"]);
    if (sourceTable === "o_assets") {
      assetReferences.whereNotIn("reference.id", bindValues(selectedIds));
    }
    query = query.whereNotExists(assetReferences);
    const storyboardReferences = transaction("o_storyboard as reference")
      .select(transaction.raw("1"))
      .whereRaw("?? = ??", ["reference.flowId", "shared.id"]);
    if (sourceTable === "o_storyboard") {
      storyboardReferences.whereNotIn(
        "reference.id",
        bindValues(selectedIds),
      );
    }
    query = query.whereNotExists(storyboardReferences);
    const expectedRows = await query.orderBy("shared.id", "asc");
    for (const row of expectedRows as unknown as RawRow[]) {
      expectedDeleteKeys.add(relatedIdentityKey(row.id));
    }
  }
  return { beforeRows, candidateIds, expectedDeleteKeys };
}

async function applyFlowCleanup(
  transaction: Knex.Transaction,
  plan: Readonly<SharedCleanupPlan>,
): Promise<void> {
  let affectedTotal = 0;
  for (const candidateSlice of slices(
    plan.candidateIds,
    SINGLE_KEY_MUTATION_SLICE_SIZE,
  )) {
    affectedTotal += Number(await transaction("o_imageFlow")
      .whereIn("id", bindValues(candidateSlice))
      .whereNotExists(
        transaction("o_assets")
          .select(transaction.raw("1"))
          .whereRaw("?? = ??", ["o_assets.flowId", "o_imageFlow.id"]),
      )
      .whereNotExists(
        transaction("o_storyboard")
          .select(transaction.raw("1"))
          .whereRaw("?? = ??", [
            "o_storyboard.flowId",
            "o_imageFlow.id",
          ]),
      )
      .delete());
  }
  if (affectedTotal !== plan.expectedDeleteKeys.size) {
    mutationConflict("o_imageFlow");
  }
}

const imageSelector: StepSelector = async (transaction, scope, limit) => {
  const excludeLibraryOwnedAssets = await transaction.schema.hasTable(
    "o_asset_ownership",
  );
  const rows = await transaction<RawRow>("o_image as target")
    .select("target.*")
    .whereIn(
      "target.assetsId",
      scopedParentIdSubquery(
        transaction,
        scope,
        "o_assets",
        excludeLibraryOwnedAssets,
      ),
    )
    .orderBy("target.id", "asc")
    .limit(limit)
    .forUpdate();
  const normalizedRows = rows as unknown as RawRow[];
  const identities = normalizedRows.map((row) => identityFrom(row, ["id"]));
  return {
    mutations: normalizedRows.map((row, index) => {
      const identity = identities[index];
      return {
        evidence: {
          table: "o_image",
          identity,
          before: row,
          action: { kind: "delete", table: "o_image", identity },
        },
      };
    }),
    apply: async () => {
      let affectedTotal = 0;
      for (const idSlice of slices(
        identities.map((identity) => identity.id),
        SINGLE_KEY_MUTATION_SLICE_SIZE,
      )) {
        affectedTotal += Number(await transaction("o_image")
          .whereIn("id", bindValues(idSlice))
          .whereIn(
            "assetsId",
            scopedParentIdSubquery(
              transaction,
              scope,
              "o_assets",
              excludeLibraryOwnedAssets,
            ),
          )
          .delete());
      }
      if (affectedTotal !== normalizedRows.length) {
        mutationConflict("o_image");
      }
    },
  };
};

async function planEventCleanup(
  transaction: Knex.Transaction,
  selectedRows: readonly RawRow[],
): Promise<SharedCleanupPlan> {
  const candidateValues = uniqueValues(selectedRows.map((row) => row.eventId));
  const beforeRows = await lockRelatedRowsById(
    transaction,
    "o_event",
    candidateValues,
  );
  const candidateIds = [...beforeRows.values()].map((row) => row.id);
  const expectedDeleteKeys = new Set<string>();
  for (const candidateSlice of slices(
    candidateIds,
    COMPOSITE_KEY_MUTATION_SLICE_SIZE,
  )) {
    const candidateKeys = new Set(candidateSlice.map(relatedIdentityKey));
    const selectedIds = selectedRows
      .filter((row) => candidateKeys.has(relatedIdentityKey(row.eventId)))
      .map((row) => identityFrom(row, ["id"]).id);
    const expectedRows = await transaction<RawRow>("o_event as shared")
      .select("shared.id")
      .whereIn("shared.id", bindValues(candidateSlice))
      .whereNotExists(
        transaction("o_eventChapter as reference")
          .select(transaction.raw("1"))
          .whereRaw("?? = ??", ["reference.eventId", "shared.id"])
          .whereNotIn("reference.id", bindValues(selectedIds)),
      )
      .orderBy("shared.id", "asc");
    for (const row of expectedRows as unknown as RawRow[]) {
      expectedDeleteKeys.add(relatedIdentityKey(row.id));
    }
  }
  return { beforeRows, candidateIds, expectedDeleteKeys };
}

async function applyEventCleanup(
  transaction: Knex.Transaction,
  plan: Readonly<SharedCleanupPlan>,
): Promise<void> {
  let affectedTotal = 0;
  for (const candidateSlice of slices(
    plan.candidateIds,
    SINGLE_KEY_MUTATION_SLICE_SIZE,
  )) {
    affectedTotal += Number(await transaction("o_event")
      .whereIn("id", bindValues(candidateSlice))
      .whereNotExists(
        transaction("o_eventChapter")
          .select(transaction.raw("1"))
          .whereRaw("?? = ??", ["o_eventChapter.eventId", "o_event.id"]),
      )
      .delete());
  }
  if (affectedTotal !== plan.expectedDeleteKeys.size) {
    mutationConflict("o_event");
  }
}

const eventChapterSelector: StepSelector = async (
  transaction,
  scope,
  limit,
) => {
  const rows = await transaction<RawRow>("o_eventChapter as target")
    .select("target.*")
    .whereIn(
      "target.novelId",
      scopedParentIdSubquery(transaction, scope, "o_novel"),
    )
    .orderBy("target.id", "asc")
    .limit(limit)
    .forUpdate();
  const normalizedRows = rows as unknown as RawRow[];
  const identities = normalizedRows.map((row) => identityFrom(row, ["id"]));
  const eventPlan = await planEventCleanup(transaction, normalizedRows);
  const mutations = normalizedRows.map((row, index) => {
    const identity = identities[index];
    const eventId = row.eventId === null || row.eventId === undefined
      ? null
      : row.eventId;
    const action: RawRow = {
      kind: "delete",
      table: "o_eventChapter",
      identity,
    };
    if (eventId !== null) {
      action.after = {
        kind: "delete_if_unreferenced",
        table: "o_event",
        identity: { id: eventId },
        references: ["o_eventChapter.eventId"],
        before: eventPlan.beforeRows.get(relatedIdentityKey(eventId)) ?? null,
        willDeleteInBatch: eventPlan.expectedDeleteKeys.has(
          relatedIdentityKey(eventId),
        ),
      };
    }
    return {
      evidence: {
        table: "o_eventChapter",
        identity,
        before: row,
        action,
      },
    };
  });
  return {
    mutations,
    apply: async () => {
      let affectedTotal = 0;
      for (const idSlice of slices(
        identities.map((identity) => identity.id),
        SINGLE_KEY_MUTATION_SLICE_SIZE,
      )) {
        affectedTotal += Number(await transaction("o_eventChapter")
          .whereIn("id", bindValues(idSlice))
          .whereIn(
            "novelId",
            scopedParentIdSubquery(transaction, scope, "o_novel"),
          )
          .delete());
      }
      if (affectedTotal !== normalizedRows.length) {
        mutationConflict("o_eventChapter");
      }
      await applyEventCleanup(transaction, eventPlan);
    },
  };
};

function addRelayCallbackEligibility(query: Knex.QueryBuilder): void {
  query.andWhere(function relayCallbackEligibility() {
    this.whereNot("callbackUrl", "[deleted]")
      .orWhereNotNull("secretCiphertext")
      .orWhereNot("payload", "{}")
      .orWhereNotNull("lastError");
  });
}

const relayCallbackSelector: StepSelector = async (
  transaction,
  scope,
  limit,
) => {
  let query = transaction<RawRow>("o_relay_callback_delivery as target")
    .select("target.*")
    .whereIn(
      "target.taskId",
      transaction("o_relay_task as relay")
        .select("relay.id")
        .where({
          "relay.projectId": scope.projectId,
          "relay.workspaceId": scope.workspaceId,
        }),
    );
  addRelayCallbackEligibility(query);
  const rows = await query
    .orderBy("target.id", "asc")
    .limit(limit)
    .forUpdate();
  const patch: RawRow = {
    callbackUrl: "[deleted]",
    secretCiphertext: null,
    payload: "{}",
    lastError: null,
  };
  const normalizedRows = rows as unknown as RawRow[];
  const identities = normalizedRows.map((row) => identityFrom(row, ["id"]));
  return {
    mutations: normalizedRows.map((row, index) => {
      const identity = identities[index];
      return {
        evidence: {
          table: "o_relay_callback_delivery",
          identity,
          before: row,
          action: {
            kind: "scrub",
            table: "o_relay_callback_delivery",
            identity,
            patch,
          },
        },
      };
    }),
    apply: async () => {
      let affectedTotal = 0;
      for (const idSlice of slices(
        identities.map((identity) => identity.id),
        SINGLE_KEY_MUTATION_SLICE_SIZE,
      )) {
        const update = transaction("o_relay_callback_delivery")
          .whereIn("id", bindValues(idSlice))
          .whereIn(
            "taskId",
            transaction("o_relay_task")
              .select("id")
              .where({
                projectId: scope.projectId,
                workspaceId: scope.workspaceId,
              }),
          );
        addRelayCallbackEligibility(update);
        affectedTotal += Number(await update.update(patch));
      }
      if (affectedTotal !== normalizedRows.length) {
        mutationConflict("o_relay_callback_delivery");
      }
    },
  };
};

function addRelayTaskEligibility(query: Knex.QueryBuilder): void {
  query.andWhere(function relayTaskEligibility() {
    this.whereNot("requestPayload", "{}")
      .orWhereNot("providerPayload", "{}")
      .orWhereNot("resultPayload", "{}")
      .orWhereNotNull("errorMessage");
  });
}

const relayTaskSelector: StepSelector = async (
  transaction,
  scope,
  limit,
) => {
  let query = transaction<RawRow>("o_relay_task as target")
    .select("target.*")
    .where({
      "target.projectId": scope.projectId,
      "target.workspaceId": scope.workspaceId,
    });
  addRelayTaskEligibility(query);
  const rows = await query
    .orderBy("target.id", "asc")
    .limit(limit)
    .forUpdate();
  const patch: RawRow = {
    requestPayload: "{}",
    providerPayload: "{}",
    resultPayload: "{}",
    errorMessage: null,
  };
  const normalizedRows = rows as unknown as RawRow[];
  const identities = normalizedRows.map((row) => identityFrom(row, ["id"]));
  return {
    mutations: normalizedRows.map((row, index) => {
      const identity = identities[index];
      return {
        evidence: {
          table: "o_relay_task",
          identity,
          before: row,
          action: {
            kind: "scrub",
            table: "o_relay_task",
            identity,
            patch,
          },
        },
      };
    }),
    apply: async () => {
      let affectedTotal = 0;
      for (const idSlice of slices(
        identities.map((identity) => identity.id),
        SINGLE_KEY_MUTATION_SLICE_SIZE,
      )) {
        const update = transaction("o_relay_task")
          .whereIn("id", bindValues(idSlice))
          .where({
            projectId: scope.projectId,
            workspaceId: scope.workspaceId,
          });
        addRelayTaskEligibility(update);
        affectedTotal += Number(await update.update(patch));
      }
      if (affectedTotal !== normalizedRows.length) {
        mutationConflict("o_relay_task");
      }
    },
  };
};

function addEnhanceTaskEligibility(query: Knex.QueryBuilder): void {
  query.andWhere(function enhanceTaskEligibility() {
    this.whereNot("sourceUrl", "[deleted]")
      .orWhereNotNull("resultUrl")
      .orWhereNotNull("errorMessage");
  });
}

const enhanceTaskSelector: StepSelector = async (
  transaction,
  scope,
  limit,
) => {
  let query = transaction<RawRow>("o_user_video_enhance_task as target")
    .select("target.*")
    .where({
      "target.projectId": scope.projectId,
      "target.workspaceId": scope.workspaceId,
    });
  addEnhanceTaskEligibility(query);
  const rows = await query
    .orderBy("target.id", "asc")
    .limit(limit)
    .forUpdate();
  const patch: RawRow = {
    sourceUrl: "[deleted]",
    resultUrl: null,
    errorMessage: null,
  };
  const normalizedRows = rows as unknown as RawRow[];
  const identities = normalizedRows.map((row) => identityFrom(row, ["id"]));
  return {
    mutations: normalizedRows.map((row, index) => {
      const identity = identities[index];
      return {
        evidence: {
          table: "o_user_video_enhance_task",
          identity,
          before: row,
          action: {
            kind: "scrub",
            table: "o_user_video_enhance_task",
            identity,
            patch,
          },
        },
      };
    }),
    apply: async () => {
      let affectedTotal = 0;
      for (const idSlice of slices(
        identities.map((identity) => identity.id),
        SINGLE_KEY_MUTATION_SLICE_SIZE,
      )) {
        const update = transaction("o_user_video_enhance_task")
          .whereIn("id", bindValues(idSlice))
          .where({
            projectId: scope.projectId,
            workspaceId: scope.workspaceId,
          });
        addEnhanceTaskEligibility(update);
        affectedTotal += Number(await update.update(patch));
      }
      if (affectedTotal !== normalizedRows.length) {
        mutationConflict("o_user_video_enhance_task");
      }
    },
  };
};

const memorySelector: StepSelector = async (transaction, scope, limit) => {
  const isolationPrefix = `${scope.projectId}:%`;
  const rows = await transaction<RawRow>("memories as target")
    .select("target.*")
    .where("target.isolationKey", "like", isolationPrefix)
    .orderBy("target.id", "asc")
    .limit(limit)
    .forUpdate();
  const normalizedRows = rows as unknown as RawRow[];
  const identities = normalizedRows.map((row) => identityFrom(row, ["id"]));
  return {
    mutations: normalizedRows.map((row, index) => {
      const identity = identities[index];
      return {
        evidence: {
          table: "memories",
          identity,
          before: row,
          action: { kind: "delete", table: "memories", identity },
        },
      };
    }),
    apply: async () => {
      let affectedTotal = 0;
      for (const idSlice of slices(
        identities.map((identity) => identity.id),
        SINGLE_KEY_MUTATION_SLICE_SIZE,
      )) {
        affectedTotal += Number(await transaction("memories")
          .whereIn("id", bindValues(idSlice))
          .where("isolationKey", "like", isolationPrefix)
          .delete());
      }
      if (affectedTotal !== normalizedRows.length) {
        mutationConflict("memories");
      }
    },
  };
};

const projectTombstoneSelector: StepSelector = async (
  transaction,
  scope,
  _limit,
  authority,
) => {
  const row = await transaction<RawRow>("o_project")
    .where({
      id: scope.projectId,
      workspaceId: scope.workspaceId,
      deletionState: "finalizing",
      deletionOperationId: authority.operationId,
      deletionRequestedAt: authority.requestedAt,
      deletionFinalizeFence: authority.fence,
    })
    .select("*")
    .forUpdate()
    .first();
  if (!row) {
    fail(
      "项目 tombstone 不再属于当前终结 authority",
      "PROJECT_DELETION_FINALIZER_SCOPE_LOST",
      409,
    );
  }
  const revision = Number(row.revision);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    mutationConflict("o_project");
  }
  const identity = identityFrom(row, ["id", "workspaceId"]);
  const patch: RawRow = {
    projectType: null,
    imageModel: null,
    imageQuality: null,
    videoModel: null,
    name: null,
    intro: null,
    type: null,
    artStyle: null,
    directorManual: null,
    mode: null,
    videoRatio: null,
    coverImageUrl: null,
    coverStorageKey: null,
    agentBudgetMicros: null,
    agentBudgetReservedMicros: 0,
    deletionState: "deleted",
    revision: {
      from: revision,
      to: revision + 1,
    },
    updatedAt: authority.finalizedAt,
  };
  return {
    mutations: [{
      evidence: {
        table: "o_project",
        identity,
        before: row,
        action: {
          kind: "scrub_and_tombstone",
          table: "o_project",
          identity,
          patch,
          retainedEvidenceTables:
            PROJECT_DELETION_FINALIZER_RETAINED_TABLES,
        },
      },
    }],
    apply: async () => {
      const affected = await transaction("o_project")
        .where({
          id: scope.projectId,
          workspaceId: scope.workspaceId,
          deletionState: "finalizing",
          deletionOperationId: authority.operationId,
          deletionRequestedAt: authority.requestedAt,
          deletionFinalizeFence: authority.fence,
          revision,
        })
        .update({
          projectType: null,
          imageModel: null,
          imageQuality: null,
          videoModel: null,
          name: null,
          intro: null,
          type: null,
          artStyle: null,
          directorManual: null,
          mode: null,
          videoRatio: null,
          coverImageUrl: null,
          coverStorageKey: null,
          agentBudgetMicros: null,
          agentBudgetReservedMicros: 0,
          deletionState: "deleted",
          revision: transaction.raw("\"revision\" + 1"),
          updatedAt: authority.finalizedAt,
        });
      if (Number(affected) !== 1) mutationConflict("o_project");
    },
  };
};

const stepSelectors: readonly StepSelector[] = [
  makeRelationDeleteSelector({
    tableName: "o_scriptAssets",
    identityKeys: ["scriptId", "assetId"],
    foreignKey: "scriptId",
    parentTable: "o_script",
  }),
  makeRelationDeleteSelector({
    tableName: "o_scriptAssets",
    identityKeys: ["scriptId", "assetId"],
    foreignKey: "assetId",
    parentTable: "o_assets",
  }),
  makeRelationDeleteSelector({
    tableName: "o_assets2Storyboard",
    identityKeys: ["storyboardId", "assetId"],
    foreignKey: "storyboardId",
    parentTable: "o_storyboard",
  }),
  makeRelationDeleteSelector({
    tableName: "o_assets2Storyboard",
    identityKeys: ["storyboardId", "assetId"],
    foreignKey: "assetId",
    parentTable: "o_assets",
  }),
  makeRelationDeleteSelector({
    tableName: "o_assetsRole2Audio",
    identityKeys: ["assetsAudioId", "assetsRoleId"],
    foreignKey: "assetsRoleId",
    parentTable: "o_assets",
  }),
  makeRelationDeleteSelector({
    tableName: "o_assetsRole2Audio",
    identityKeys: ["assetsAudioId", "assetsRoleId"],
    foreignKey: "assetsAudioId",
    parentTable: "o_assets",
  }),
  imageSelector,
  eventChapterSelector,
  makeScopedDirectDeleteSelector({
    tableName: "o_agent_event",
    workspaceScoped: true,
  }),
  makeScopedDirectDeleteSelector({
    tableName: "o_agent_message",
    workspaceScoped: true,
  }),
  relayCallbackSelector,
  relayTaskSelector,
  enhanceTaskSelector,
  makeScopedDirectDeleteSelector({
    tableName: "o_agent_thread",
    workspaceScoped: true,
  }),
  makeScopedDirectDeleteSelector({
    tableName: "o_creation_session",
    workspaceScoped: true,
  }),
  makeScopedDirectDeleteSelector({
    tableName: "o_canvas_asset",
    workspaceScoped: true,
  }),
  makeScopedDirectDeleteSelector({ tableName: "o_workflow_graph" }),
  makeScopedDirectDeleteSelector({ tableName: "o_agentWorkData" }),
  makeScopedDirectDeleteSelector({ tableName: "o_novel" }),
  makeScopedDirectDeleteSelector({ tableName: "o_script" }),
  makeScopedDirectDeleteSelector({ tableName: "o_tasks" }),
  makeScopedDirectDeleteSelector({
    tableName: "o_storyboard",
    deleteUnreferencedFlow: true,
  }),
  makeScopedDirectDeleteSelector({
    tableName: "o_assets",
    deleteUnreferencedFlow: true,
    retainLibraryOwnedAssets: true,
  }),
  makeScopedDirectDeleteSelector({ tableName: "o_video" }),
  makeScopedDirectDeleteSelector({ tableName: "o_videoTrack" }),
  makeScopedDirectDeleteSelector({
    tableName: "o_media_asset",
    workspaceScoped: true,
  }),
  memorySelector,
  projectTombstoneSelector,
];

if (stepSelectors.length !== PROJECT_DELETION_FINALIZER_STEPS.length) {
  throw new Error("Project deletion finalizer step implementation drift");
}

export function firstProjectDeletionFinalizerCursor(): ProjectDeletionFinalizerPosition {
  const first = PROJECT_DELETION_FINALIZER_STEPS[0];
  return {
    tableOrdinal: first.ordinal,
    tableName: first.name,
    cursor: { batch: 0 },
  };
}

/**
 * Selects and locks one bounded eligibility batch, invokes beforeApply so the
 * caller can append its audit chunk, then applies exactly those selected
 * actions. The caller owns transaction commit/rollback.
 */
export async function runProjectDeletionFinalizerBatchInTransaction(
  transaction: Knex.Transaction,
  input: RunProjectDeletionFinalizerBatchInput,
): Promise<ProjectDeletionFinalizerBatchResult> {
  assertCallerTransaction(transaction);
  const scope = normalizeScope(input.scope);
  const authority = normalizeAuthority(input.authority);
  const batchSize = normalizeBatchSize(input.batchSize);
  const cursor = normalizeCursor(input.cursor);
  if (typeof input.beforeApply !== "function") {
    inputInvalid("beforeApply audit 回调不能为空");
  }
  if (
    !Number.isSafeInteger(input.tableOrdinal)
    || input.tableOrdinal < 0
    || input.tableOrdinal >= PROJECT_DELETION_FINALIZER_STEPS.length
  ) {
    inputInvalid("db_finalize tableOrdinal 无效");
  }
  const step = PROJECT_DELETION_FINALIZER_STEPS[input.tableOrdinal];
  if (input.tableName !== step.name) {
    inputInvalid("db_finalize tableName 与稳定步骤目录不匹配");
  }

  await assertProjectScope(transaction, scope, authority);
  const selectedBatch = await stepSelectors[step.ordinal](
    transaction,
    scope,
    batchSize,
    authority,
  );
  const { mutations } = selectedBatch;
  if (mutations.length > batchSize || mutations.length > 500) {
    fail(
      "项目删除终结器选择了超过上限的 eligibility rows",
      "PROJECT_DELETION_FINALIZER_MUTATION_CONFLICT",
      500,
    );
  }
  if (mutations.length === 0) {
    const nextStep = PROJECT_DELETION_FINALIZER_STEPS[step.ordinal + 1];
    if (!nextStep) {
      return { kind: "complete", step, next: null };
    }
    return {
      kind: "step_complete",
      step,
      next: {
        tableOrdinal: nextStep.ordinal,
        tableName: nextStep.name,
        cursor: { batch: 0 },
      },
    };
  }

  const outputCursor = { batch: cursor.batch + 1 };
  const audit: ProjectDeletionFinalizerAuditChunk = {
    tableOrdinal: step.ordinal,
    tableName: step.name,
    inputCursor: cursor,
    outputCursor,
    rowCount: mutations.length,
    rowsHash: hashBatch(step, scope, mutations),
  };
  await input.beforeApply(transaction, audit);
  await selectedBatch.apply();
  if (step.ordinal === PROJECT_DELETION_FINALIZER_STEPS.length - 1) {
    return {
      kind: "completed",
      step,
      audit,
      next: null,
    };
  }
  return {
    kind: "applied",
    step,
    audit,
    next: {
      tableOrdinal: step.ordinal,
      tableName: step.name,
      cursor: outputCursor,
    },
  };
}
