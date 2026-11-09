import type { Knex } from "knex";
import { z } from "zod";
import { canonicalizeIdempotencyRequest, hashIdempotencyRequest } from "@/agent-runtime/idempotency";
import { AgentToolGatewayError } from "@/agent-runtime/tools/errors";
import {
  defineAgentTool,
  type AgentToolAuthorizationContext,
} from "@/agent-runtime/tools/registry";
import { CREATION_SESSION_MUTATION_TABLE } from "@/lib/migrations/creationSessionMutation";

const SESSION_MODES = ["agent", "quick_create", "canvas"] as const;
const SESSION_SAFE_FIELDS = [
  "goal",
  "mode",
  "parameters",
  "selectedAssetVersionIds",
  "canvasId",
] as const;

const MAX_GOAL_LENGTH = 20_000;
const MAX_PARAMETERS_BYTES = 32 * 1_024;
const MAX_PARAMETERS_DEPTH = 6;
const MAX_PARAMETERS_NODES = 1_000;
const MAX_OBJECT_KEYS = 200;
const MAX_ARRAY_ITEMS = 200;
const MAX_PARAMETER_KEY_LENGTH = 100;
const MAX_ASSET_VERSION_IDS = 100;
const MAX_REFERENCE_LENGTH = 200;

type SessionMode = (typeof SESSION_MODES)[number];
type SessionSafeField = (typeof SESSION_SAFE_FIELDS)[number];

interface SessionSafeSnapshot {
  goal: string;
  mode: SessionMode;
  parameters: Record<string, unknown>;
  selectedAssetVersionIds: string[];
  canvasId: string | null;
}

interface BoundSession extends SessionSafeSnapshot {
  id: string;
  version: number;
  updatedAt: number;
}

function inspectBoundedJson(value: unknown): boolean {
  const ancestors = new Set<object>();
  let nodes = 0;

  function visit(current: unknown, depth: number): boolean {
    nodes += 1;
    if (nodes > MAX_PARAMETERS_NODES || depth > MAX_PARAMETERS_DEPTH) return false;
    if (current === null || typeof current === "string" || typeof current === "boolean") return true;
    if (typeof current === "number") return Number.isFinite(current);
    if (typeof current !== "object") return false;

    const objectValue = current as object;
    if (ancestors.has(objectValue)) return false;
    ancestors.add(objectValue);
    try {
      if (Array.isArray(current)) {
        return current.length <= MAX_ARRAY_ITEMS
          && current.every((item) => visit(item, depth + 1));
      }
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) return false;
      const entries = Object.entries(current as Record<string, unknown>);
      return entries.length <= MAX_OBJECT_KEYS
        && entries.every(([key, item]) => (
          key.length > 0
          && key.length <= MAX_PARAMETER_KEY_LENGTH
          && key !== "__proto__"
          && key !== "prototype"
          && key !== "constructor"
          && visit(item, depth + 1)
        ));
    } finally {
      ancestors.delete(objectValue);
    }
  }

  if (!visit(value, 0)) return false;
  try {
    return Buffer.byteLength(canonicalizeIdempotencyRequest(value), "utf8") <= MAX_PARAMETERS_BYTES;
  } catch {
    return false;
  }
}

const sessionModeSchema = z.enum(SESSION_MODES);
const parametersSchema = z.record(
  z.string().min(1).max(MAX_PARAMETER_KEY_LENGTH),
  z.unknown(),
).superRefine((value, context) => {
  if (!inspectBoundedJson(value)) {
    context.addIssue({
      code: "custom",
      message: "parameters 必须是有界 JSON 对象",
    });
  }
});
const selectedAssetVersionIdsSchema = z.array(
  z.string().trim().min(1).max(MAX_REFERENCE_LENGTH),
).max(MAX_ASSET_VERSION_IDS).refine((value) => new Set(value).size === value.length, {
  message: "selectedAssetVersionIds 不能重复",
});
const canvasIdSchema = z.string().trim().min(1).max(MAX_REFERENCE_LENGTH).nullable();

const sessionSafeSnapshotSchema = z.object({
  goal: z.string().max(MAX_GOAL_LENGTH),
  mode: sessionModeSchema,
  parameters: parametersSchema,
  selectedAssetVersionIds: selectedAssetVersionIdsSchema,
  canvasId: canvasIdSchema,
}).strict();

export const sessionGetInputSchema = z.object({}).strict();

export const sessionGetOutputSchema = sessionSafeSnapshotSchema.extend({
  id: z.string().min(1).max(MAX_REFERENCE_LENGTH),
  version: z.number().int().positive(),
  updatedAt: z.number().int().nonnegative(),
}).strict();

const goalUpdateSlotSchema = z.object({
  action: z.enum(["keep", "set", "clear"]),
  value: z.string().trim().max(MAX_GOAL_LENGTH).nullable(),
}).strict().superRefine((slot, context) => {
  if (slot.action !== "set" && slot.value !== null) {
    context.addIssue({ code: "custom", path: ["value"], message: `goal ${slot.action} 时 value 必须为 null` });
  }
  if (slot.action === "set" && (slot.value === null || slot.value.length === 0)) {
    context.addIssue({ code: "custom", path: ["value"], message: "goal set 时必须提供非空 value" });
  }
});

const modeUpdateSlotSchema = z.object({
  action: z.enum(["keep", "set"]),
  value: sessionModeSchema.nullable(),
}).strict().superRefine((slot, context) => {
  if (slot.action === "keep" && slot.value !== null) {
    context.addIssue({ code: "custom", path: ["value"], message: "mode keep 时 value 必须为 null" });
  }
  if (slot.action === "set" && slot.value === null) {
    context.addIssue({ code: "custom", path: ["value"], message: "mode set 时必须提供 value" });
  }
});

const parametersUpdateSlotSchema = z.object({
  action: z.enum(["keep", "replace", "clear"]),
  valueJson: z.string().max(MAX_PARAMETERS_BYTES).nullable(),
}).strict().superRefine((slot, context) => {
  if (slot.action !== "replace") {
    if (slot.valueJson !== null) {
      context.addIssue({
        code: "custom",
        path: ["valueJson"],
        message: `parameters ${slot.action} 时 valueJson 必须为 null`,
      });
    }
    return;
  }
  if (slot.valueJson === null) {
    context.addIssue({ code: "custom", path: ["valueJson"], message: "parameters replace 时必须提供 valueJson" });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(slot.valueJson);
  } catch {
    context.addIssue({ code: "custom", path: ["valueJson"], message: "parameters valueJson 必须是有效 JSON" });
    return;
  }
  if (!inspectBoundedJson(parsed) || !parametersSchema.safeParse(parsed).success) {
    context.addIssue({
      code: "custom",
      path: ["valueJson"],
      message: "parameters valueJson 必须解析为有界且安全的 JSON 对象",
    });
  }
});

const selectedAssetVersionIdsUpdateSlotSchema = z.object({
  action: z.enum(["keep", "replace", "clear"]),
  value: selectedAssetVersionIdsSchema.nullable(),
}).strict().superRefine((slot, context) => {
  if (slot.action === "replace" && slot.value === null) {
    context.addIssue({
      code: "custom",
      path: ["value"],
      message: "selectedAssetVersionIds replace 时必须提供 value",
    });
  }
  if (slot.action !== "replace" && slot.value !== null) {
    context.addIssue({
      code: "custom",
      path: ["value"],
      message: `selectedAssetVersionIds ${slot.action} 时 value 必须为 null`,
    });
  }
});

const canvasUpdateSlotSchema = z.object({
  action: z.enum(["keep", "set", "clear"]),
  value: canvasIdSchema,
}).strict().superRefine((slot, context) => {
  if (slot.action === "set" && slot.value === null) {
    context.addIssue({ code: "custom", path: ["value"], message: "canvasId set 时必须提供 value" });
  }
  if (slot.action !== "set" && slot.value !== null) {
    context.addIssue({
      code: "custom",
      path: ["value"],
      message: `canvasId ${slot.action} 时 value 必须为 null`,
    });
  }
});

/** All root properties and every slot property are required for OpenAI strict tools. */
export const sessionUpdateInputSchema = z.object({
  operation: z.enum(["update", "undo"]),
  expectedVersion: z.number().int().positive(),
  goal: goalUpdateSlotSchema,
  mode: modeUpdateSlotSchema,
  parameters: parametersUpdateSlotSchema,
  selectedAssetVersionIds: selectedAssetVersionIdsUpdateSlotSchema,
  canvasId: canvasUpdateSlotSchema,
  undoToken: z.string().trim().min(1).max(MAX_REFERENCE_LENGTH).nullable(),
}).strict().superRefine((input, context) => {
  const slots = [input.goal, input.mode, input.parameters, input.selectedAssetVersionIds, input.canvasId];
  if (input.operation === "update") {
    if (input.undoToken !== null) {
      context.addIssue({ code: "custom", path: ["undoToken"], message: "update 不能携带撤销令牌" });
    }
    if (slots.every((slot) => slot.action === "keep")) {
      context.addIssue({ code: "custom", message: "update 至少需要一个非 keep 字段" });
    }
  } else {
    if (input.undoToken === null) {
      context.addIssue({ code: "custom", path: ["undoToken"], message: "undo 必须携带撤销令牌" });
    }
    if (slots.some((slot) => slot.action !== "keep")) {
      context.addIssue({ code: "custom", message: "undo 的所有字段 action 必须为 keep" });
    }
  }
});

export const sessionUpdateOutputSchema = z.object({
  version: z.number().int().positive(),
  changedFields: z.array(z.enum(SESSION_SAFE_FIELDS)),
  undoToken: z.string().min(1).nullable(),
}).strict();

function parseStoredJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new AgentToolGatewayError(
      "session_snapshot_invalid",
      "当前创作会话无法安全读取",
      { status: 409 },
    );
  }
}

function positiveVersion(value: unknown): number {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new AgentToolGatewayError("session_version_invalid", "创作会话 version 无效", { status: 409 });
  }
  return version;
}

function nonnegativeTimestamp(value: unknown): number {
  const timestamp = Number(value);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new AgentToolGatewayError("session_snapshot_invalid", "创作会话更新时间无效", { status: 409 });
  }
  return timestamp;
}

function snapshotFromRow(row: Record<string, unknown>): BoundSession {
  const parsed = sessionGetOutputSchema.safeParse({
    id: String(row.id || ""),
    goal: String(row.goal || ""),
    mode: row.mode,
    parameters: parseStoredJson(row.parameters),
    selectedAssetVersionIds: parseStoredJson(row.selectedAssetVersionIds),
    canvasId: row.canvasId == null ? null : String(row.canvasId),
    version: positiveVersion(row.version),
    updatedAt: nonnegativeTimestamp(row.updatedAt),
  });
  if (!parsed.success) {
    throw new AgentToolGatewayError(
      "session_snapshot_invalid",
      "当前创作会话包含无效或超限字段",
      { status: 409 },
    );
  }
  return parsed.data;
}

function parseJournalSnapshot(value: unknown): SessionSafeSnapshot {
  const result = sessionSafeSnapshotSchema.safeParse(parseStoredJson(value));
  if (!result.success) {
    throw new AgentToolGatewayError("session_undo_record_invalid", "创作会话撤销记录无效", { status: 409 });
  }
  return result.data;
}

async function loadBoundSession(
  database: Knex.Transaction,
  context: Pick<AgentToolAuthorizationContext, "workspaceId" | "projectId" | "threadId">,
  forUpdate = false,
): Promise<BoundSession> {
  let threadQuery = database("o_agent_thread")
    .where({
      id: context.threadId,
      workspaceId: context.workspaceId,
      projectId: context.projectId,
      status: "active",
    })
    .whereNull("archivedAt")
    .select("sessionId");
  if (forUpdate) threadQuery = threadQuery.forUpdate();
  const thread = await threadQuery.first();
  const sessionId = thread?.sessionId == null ? "" : String(thread.sessionId).trim();
  if (!thread || !sessionId) {
    throw new AgentToolGatewayError(
      "session_scope_invalid",
      "当前 Run 的 Thread 未绑定可用创作会话",
      { status: 409 },
    );
  }

  let sessionQuery = database("o_creation_session")
    .where({
      id: sessionId,
      workspaceId: context.workspaceId,
      projectId: context.projectId,
      status: "active",
    })
    .whereNull("archivedAt")
    .select(
      "id",
      "goal",
      "mode",
      "parameters",
      "selectedAssetVersionIds",
      "canvasId",
      "version",
      "updatedAt",
    );
  if (forUpdate) sessionQuery = sessionQuery.forUpdate();
  const session = await sessionQuery.first();
  if (!session) {
    throw new AgentToolGatewayError(
      "session_scope_invalid",
      "当前 Thread 绑定的创作会话不存在、已归档或范围不一致",
      { status: 409 },
    );
  }
  return snapshotFromRow(session);
}

function safeSnapshot(session: BoundSession): SessionSafeSnapshot {
  return {
    goal: session.goal,
    mode: session.mode,
    parameters: session.parameters,
    selectedAssetVersionIds: session.selectedAssetVersionIds,
    canvasId: session.canvasId,
  };
}

function sessionResourceRefs(snapshot: Pick<SessionSafeSnapshot, "selectedAssetVersionIds" | "canvasId">) {
  return [
    ...snapshot.selectedAssetVersionIds.map((id) => ({ type: "assetVersionIds" as const, id })),
    ...(snapshot.canvasId == null ? [] : [{ type: "canvasIds" as const, id: snapshot.canvasId }]),
  ];
}

function uniqueSessionResourceRefs(
  ...snapshots: Array<Pick<SessionSafeSnapshot, "selectedAssetVersionIds" | "canvasId">>
) {
  const refs = snapshots.flatMap(sessionResourceRefs);
  return Array.from(new Map(refs.map((ref) => [`${ref.type}:${ref.id}`, ref])).values());
}

async function assertSessionReferencesBelongToProject(
  database: Knex.Transaction,
  projectId: number,
  snapshots: Array<Pick<SessionSafeSnapshot, "selectedAssetVersionIds" | "canvasId">>,
): Promise<void> {
  const refs = uniqueSessionResourceRefs(...snapshots);
  const assetVersionIds = refs
    .filter((ref) => ref.type === "assetVersionIds")
    .map((ref) => ref.id);
  const canvasIds = refs
    .filter((ref) => ref.type === "canvasIds")
    .map((ref) => ref.id);

  if (assetVersionIds.length > 0) {
    const rows = await database("o_image as asset_version")
      .innerJoin("o_assets as asset", "asset.id", "asset_version.assetsId")
      .where("asset.projectId", projectId)
      .whereRaw(
        `CAST(?? AS TEXT) IN (${assetVersionIds.map(() => "?").join(", ")})`,
        ["asset_version.id", ...assetVersionIds],
      )
      .select(database.raw("CAST(?? AS TEXT) AS ??", ["asset_version.id", "id"]));
    const found = new Set(rows.map((row) => String(row.id)));
    if (found.size !== assetVersionIds.length || assetVersionIds.some((id) => !found.has(id))) {
      throw new AgentToolGatewayError(
        "session_reference_scope_invalid",
        "创作会话引用不存在或不属于当前项目",
        { status: 409 },
      );
    }
  }

  if (canvasIds.length > 0) {
    const rows = await database("o_workflow_graph as canvas")
      .where("canvas.projectId", projectId)
      .whereRaw(
        `CAST(?? AS TEXT) IN (${canvasIds.map(() => "?").join(", ")})`,
        ["canvas.id", ...canvasIds],
      )
      .select(database.raw("CAST(?? AS TEXT) AS ??", ["canvas.id", "id"]));
    const found = new Set(rows.map((row) => String(row.id)));
    if (found.size !== canvasIds.length || canvasIds.some((id) => !found.has(id))) {
      throw new AgentToolGatewayError(
        "session_reference_scope_invalid",
        "创作会话引用不存在或不属于当前项目",
        { status: 409 },
      );
    }
  }
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return canonicalizeIdempotencyRequest(left) === canonicalizeIdempotencyRequest(right);
}

function changedFields(
  before: SessionSafeSnapshot,
  after: SessionSafeSnapshot,
): SessionSafeField[] {
  return SESSION_SAFE_FIELDS.filter((field) => !valuesEqual(before[field], after[field]));
}

function affectedRows(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value) || 0;
  if (Array.isArray(value)) return value.length;
  return 0;
}

function versionConflict(expectedVersion: number, currentVersion: number): AgentToolGatewayError {
  return new AgentToolGatewayError(
    "session_version_conflict",
    `创作会话已发生变化（期望 version ${expectedVersion}，当前 ${currentVersion}）`,
    { status: 409 },
  );
}

function storagePatch(
  after: SessionSafeSnapshot,
  fields: readonly SessionSafeField[],
): Record<string, unknown> {
  return Object.fromEntries(fields.map((field) => {
    if (field === "parameters" || field === "selectedAssetVersionIds") {
      return [field, JSON.stringify(after[field])];
    }
    return [field, after[field]];
  }));
}

function parsedParametersValueJson(valueJson: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(valueJson);
  } catch {
    throw new AgentToolGatewayError("invalid_tool_arguments", "parameters valueJson 无效", { status: 400 });
  }
  const result = parametersSchema.safeParse(parsed);
  if (!inspectBoundedJson(parsed) || !result.success) {
    throw new AgentToolGatewayError("invalid_tool_arguments", "parameters valueJson 超出安全边界", { status: 400 });
  }
  return result.data;
}

function sessionPatchFromSlots(input: z.infer<typeof sessionUpdateInputSchema>): Partial<SessionSafeSnapshot> {
  const patch: Partial<SessionSafeSnapshot> = {};
  if (input.goal.action === "set") {
    patch.goal = input.goal.value!;
  } else if (input.goal.action === "clear") {
    patch.goal = "";
  }
  if (input.mode.action === "set") patch.mode = input.mode.value!;
  if (input.parameters.action === "replace") {
    patch.parameters = parsedParametersValueJson(input.parameters.valueJson!);
  } else if (input.parameters.action === "clear") {
    patch.parameters = {};
  }
  if (input.selectedAssetVersionIds.action === "replace") {
    patch.selectedAssetVersionIds = input.selectedAssetVersionIds.value!;
  } else if (input.selectedAssetVersionIds.action === "clear") {
    patch.selectedAssetVersionIds = [];
  }
  if (input.canvasId.action === "set") {
    patch.canvasId = input.canvasId.value!;
  } else if (input.canvasId.action === "clear") {
    patch.canvasId = null;
  }
  return patch;
}

function updateReceipt(
  version: number,
  fields: SessionSafeField[],
  undoToken: string | null,
) {
  return { version, changedFields: fields, undoToken };
}

export const SESSION_GET_TOOL = defineAgentTool({
  manifest: {
    name: "session.get",
    version: "1.1.0",
    displayName: "读取当前创作会话",
    description: "读取当前 Agent Run 的 Thread 所绑定 CreationSession 安全字段。",
    riskClass: "R0",
    availability: { state: "available", sincePhase: "A2" },
    requiredPermissions: ["project:read"],
    resourceTypes: ["creation_session"],
    mutatesState: false,
    metered: false,
  },
  inputSchema: sessionGetInputSchema,
  outputSchema: sessionGetOutputSchema,
  async resolveAuthorizationEvidence(_input, context) {
    const session = await loadBoundSession(context.database, context);
    return {
      resourceRefs: sessionResourceRefs(session),
      resourceVersions: {
        [`creation_session:${session.id}`]: String(session.version),
        [`creation_session_snapshot:${session.id}`]: hashIdempotencyRequest(session),
      },
    };
  },
  async execute(_input, context) {
    return loadBoundSession(context.database, context);
  },
});

export const SESSION_UPDATE_TOOL = defineAgentTool({
  manifest: {
    name: "session.update",
    version: "2.0.0",
    displayName: "更新当前创作会话",
    description: "以 version 乐观锁更新当前 Thread 绑定的安全会话字段，或显式一次性撤销本 Run 的最近变更；返回紧凑回执，完整状态需调用 session.get。",
    riskClass: "R1",
    availability: { state: "available", sincePhase: "A2" },
    requiredPermissions: ["project:write"],
    resourceTypes: ["creation_session", "creation_session_mutation"],
    mutatesState: true,
    metered: false,
  },
  inputSchema: sessionUpdateInputSchema,
  outputSchema: sessionUpdateOutputSchema,
  async resolveAuthorizationEvidence(input, context) {
    const session = await loadBoundSession(context.database, context);
    const ownMutation = await context.database(CREATION_SESSION_MUTATION_TABLE)
      .where({
        workspaceId: context.workspaceId,
        projectId: context.projectId,
        sessionId: session.id,
        runId: context.runId,
        stepId: context.stepId,
      })
      .first();

    let authorizationSnapshots: SessionSafeSnapshot[];
    if (ownMutation) {
      // A successful mutation legitimately changes the very refs/version used
      // for its first authorization. Rebuild the original old+new evidence
      // from the immutable journal so exact replay remains stable, while still
      // rejecting replay after a later mutation of the bound Session.
      const before = parseJournalSnapshot(ownMutation.beforeSnapshot);
      const after = parseJournalSnapshot(ownMutation.afterSnapshot);
      if (
        session.version !== positiveVersion(ownMutation.newVersion)
        || !valuesEqual(safeSnapshot(session), after)
      ) {
        throw new AgentToolGatewayError(
          "tool_replay_scope_changed",
          "创作会话在工具完成后已发生变化，旧结果不能重放",
          { status: 409 },
        );
      }
      authorizationSnapshots = [before, after];
    } else if (input.operation === "update") {
      authorizationSnapshots = [session, { ...safeSnapshot(session), ...sessionPatchFromSlots(input) }];
    } else {
      const target = await context.database(CREATION_SESSION_MUTATION_TABLE)
        .where({
          mutationId: input.undoToken,
          workspaceId: context.workspaceId,
          projectId: context.projectId,
          sessionId: session.id,
          runId: context.runId,
          operation: "update",
        })
        .first();
      if (!target) {
        throw new AgentToolGatewayError(
          "session_undo_not_found",
          "创作会话撤销令牌不存在或不属于当前 Session/Run",
          { status: 404 },
        );
      }
      authorizationSnapshots = [session, parseJournalSnapshot(target.beforeSnapshot)];
    }
    await assertSessionReferencesBelongToProject(
      context.database,
      context.projectId,
      authorizationSnapshots,
    );
    return {
      resourceRefs: uniqueSessionResourceRefs(...authorizationSnapshots),
      resourceVersions: {
        [`creation_session:${session.id}`]: String(input.expectedVersion),
      },
    };
  },
  async execute(input, context) {
    return context.database.transaction(async (trx) => {
      const current = await loadBoundSession(trx, context, true);
      if (current.version !== input.expectedVersion) {
        throw versionConflict(input.expectedVersion, current.version);
      }
      const before = safeSnapshot(current);

      if (input.operation === "update") {
        const after: SessionSafeSnapshot = { ...before, ...sessionPatchFromSlots(input) };
        await assertSessionReferencesBelongToProject(trx, context.projectId, [before, after]);
        const fields = changedFields(before, after);
        if (fields.length === 0) return updateReceipt(current.version, [], null);

        const nextVersion = current.version + 1;
        const updated = await trx("o_creation_session")
          .where({
            id: current.id,
            workspaceId: context.workspaceId,
            projectId: context.projectId,
            status: "active",
            version: current.version,
          })
          .whereNull("archivedAt")
          .update({
            ...storagePatch(after, fields),
            version: nextVersion,
            updatedAt: context.now,
          });
        if (affectedRows(updated) !== 1) {
          const latest = await loadBoundSession(trx, context);
          throw versionConflict(current.version, latest.version);
        }

        const next: BoundSession = {
          id: current.id,
          ...after,
          version: nextVersion,
          updatedAt: context.now,
        };
        const mutationId = context.stepId;
        await trx(CREATION_SESSION_MUTATION_TABLE).insert({
          mutationId,
          workspaceId: context.workspaceId,
          projectId: context.projectId,
          sessionId: current.id,
          runId: context.runId,
          stepId: context.stepId,
          actorUserId: context.actorUserId,
          operation: "update",
          baseVersion: current.version,
          newVersion: nextVersion,
          changedFields: JSON.stringify(fields),
          beforeSnapshot: JSON.stringify(before),
          afterSnapshot: JSON.stringify(after),
          undoOfMutationId: null,
          undoneByMutationId: null,
          createdAt: context.now,
        });
        return updateReceipt(next.version, fields, mutationId);
      }

      const target = await trx(CREATION_SESSION_MUTATION_TABLE)
        .where({
          mutationId: input.undoToken,
          workspaceId: context.workspaceId,
          projectId: context.projectId,
          sessionId: current.id,
          runId: context.runId,
          operation: "update",
        })
        .forUpdate()
        .first();
      if (!target) {
        throw new AgentToolGatewayError(
          "session_undo_not_found",
          "创作会话撤销令牌不存在或不属于当前 Session/Run",
          { status: 404 },
        );
      }
      if (target.undoneByMutationId != null) {
        throw new AgentToolGatewayError("session_undo_unavailable", "该创作会话变更已经撤销", { status: 409 });
      }
      const targetVersion = positiveVersion(target.newVersion);
      if (targetVersion !== current.version) {
        throw new AgentToolGatewayError(
          "session_undo_version_conflict",
          "创作会话在该变更后已继续修改，不能安全撤销",
          { status: 409 },
        );
      }

      const after = parseJournalSnapshot(target.beforeSnapshot);
      await assertSessionReferencesBelongToProject(trx, context.projectId, [before, after]);
      const fields = changedFields(before, after);
      if (fields.length === 0) {
        throw new AgentToolGatewayError(
          "session_undo_record_invalid",
          "创作会话撤销记录不包含可恢复变化",
          { status: 409 },
        );
      }
      const nextVersion = current.version + 1;
      const restored = await trx("o_creation_session")
        .where({
          id: current.id,
          workspaceId: context.workspaceId,
          projectId: context.projectId,
          status: "active",
          version: current.version,
        })
        .whereNull("archivedAt")
        .update({
          ...storagePatch(after, fields),
          version: nextVersion,
          updatedAt: context.now,
        });
      if (affectedRows(restored) !== 1) {
        const latest = await loadBoundSession(trx, context);
        throw versionConflict(current.version, latest.version);
      }

      const undoMutationId = context.stepId;
      const claimed = await trx(CREATION_SESSION_MUTATION_TABLE)
        .where({
          mutationId: input.undoToken,
          workspaceId: context.workspaceId,
          projectId: context.projectId,
          sessionId: current.id,
          runId: context.runId,
        })
        .whereNull("undoneByMutationId")
        .update({ undoneByMutationId: undoMutationId });
      if (affectedRows(claimed) !== 1) {
        throw new AgentToolGatewayError("session_undo_unavailable", "该创作会话变更已经撤销", { status: 409 });
      }
      await trx(CREATION_SESSION_MUTATION_TABLE).insert({
        mutationId: undoMutationId,
        workspaceId: context.workspaceId,
        projectId: context.projectId,
        sessionId: current.id,
        runId: context.runId,
        stepId: context.stepId,
        actorUserId: context.actorUserId,
        operation: "undo",
        baseVersion: current.version,
        newVersion: nextVersion,
        changedFields: JSON.stringify(fields),
        beforeSnapshot: JSON.stringify(before),
        afterSnapshot: JSON.stringify(after),
        undoOfMutationId: input.undoToken,
        undoneByMutationId: null,
        createdAt: context.now,
      });

      const next: BoundSession = {
        id: current.id,
        ...after,
        version: nextVersion,
        updatedAt: context.now,
      };
      return updateReceipt(next.version, fields, null);
    });
  },
});

export const SESSION_TOOLS = Object.freeze([SESSION_GET_TOOL, SESSION_UPDATE_TOOL]);
