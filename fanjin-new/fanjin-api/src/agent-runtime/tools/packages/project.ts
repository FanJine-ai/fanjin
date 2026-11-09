import { z } from "zod";
import { hashIdempotencyRequest } from "@/agent-runtime/idempotency";
import { AgentToolGatewayError } from "@/agent-runtime/tools/errors";
import {
  defineAgentTool,
  type AgentToolAuthorizationContext,
} from "@/agent-runtime/tools/registry";
import { PROJECT_MUTATION_TABLE } from "@/lib/migrations/projectRevision";

const PROJECT_SAFE_FIELDS = [
  "name",
  "intro",
  "type",
  "artStyle",
  "projectType",
  "videoRatio",
] as const;

type ProjectSafeField = (typeof PROJECT_SAFE_FIELDS)[number];
type ProjectSafeSnapshot = Record<ProjectSafeField, string | null>;

const PROJECT_FIELD_MAX_LENGTH: Readonly<Record<ProjectSafeField, number>> = Object.freeze({
  name: 200,
  intro: 20_000,
  type: 500,
  artStyle: 2_000,
  projectType: 200,
  videoRatio: 100,
});

const projectEditSchema = z.object({
  field: z.enum(PROJECT_SAFE_FIELDS),
  value: z.string().nullable(),
}).strict();

/**
 * A single required object is intentional: OpenAI strict tools reject optional
 * object properties and root unions. `edits` preserves patch semantics without
 * making any safe project field optional: a missing edit means keep, while an
 * explicit null value means clear.
 */
export const projectUpdateInputSchema = z.object({
  operation: z.enum(["update", "undo"]),
  expectedRevision: z.number().int().positive(),
  edits: z.array(projectEditSchema).max(PROJECT_SAFE_FIELDS.length),
  undoToken: z.string().trim().min(1).max(200).nullable(),
}).strict().superRefine((input, context) => {
  if (input.operation === "update") {
    if (input.edits.length === 0) {
      context.addIssue({ code: "custom", path: ["edits"], message: "update 至少需要一个项目编辑" });
    }
    if (input.undoToken !== null) {
      context.addIssue({ code: "custom", path: ["undoToken"], message: "update 不能携带撤销令牌" });
    }
  } else {
    if (input.edits.length !== 0) {
      context.addIssue({ code: "custom", path: ["edits"], message: "undo 不能携带项目编辑" });
    }
    if (input.undoToken === null) {
      context.addIssue({ code: "custom", path: ["undoToken"], message: "undo 必须携带撤销令牌" });
    }
  }

  const seen = new Set<ProjectSafeField>();
  input.edits.forEach((edit, index) => {
    if (seen.has(edit.field)) {
      context.addIssue({
        code: "custom",
        path: ["edits", index, "field"],
        message: "同一项目字段不能重复编辑",
      });
    }
    seen.add(edit.field);
    if (edit.value !== null && edit.value.length > PROJECT_FIELD_MAX_LENGTH[edit.field]) {
      context.addIssue({
        code: "custom",
        path: ["edits", index, "value"],
        message: `项目字段 ${edit.field} 超过长度上限`,
      });
    }
  });
});

export const projectUpdateOutputSchema = z.object({
  revision: z.number().int().positive(),
  changedFields: z.array(z.enum(PROJECT_SAFE_FIELDS)),
  undoToken: z.string().min(1).nullable(),
}).strict();

export const projectGetInputSchema = z.object({}).strict();

export const projectGetOutputSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().max(200).nullable(),
  intro: z.string().max(20_000).nullable(),
  type: z.string().max(500).nullable(),
  artStyle: z.string().max(2_000).nullable(),
  projectType: z.string().max(200).nullable(),
  mode: z.string().max(100).nullable(),
  videoRatio: z.string().max(100).nullable(),
  revision: z.number().int().positive(),
}).strict();

function nullableString(value: unknown): string | null {
  return value == null ? null : String(value);
}

function boundedNullableString(value: unknown, maxLength: number): string | null {
  return value == null ? null : String(value).slice(0, maxLength);
}

function positiveRevision(value: unknown): number {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new AgentToolGatewayError("project_revision_invalid", "项目 revision 无效", { status: 409 });
  }
  return revision;
}

function snapshotFromRow(row: Record<string, unknown>): ProjectSafeSnapshot {
  return {
    name: nullableString(row.name),
    intro: nullableString(row.intro),
    type: nullableString(row.type),
    artStyle: nullableString(row.artStyle),
    projectType: nullableString(row.projectType),
    videoRatio: nullableString(row.videoRatio),
  };
}

function snapshotsEqual(left: ProjectSafeSnapshot, right: ProjectSafeSnapshot): boolean {
  return hashIdempotencyRequest(left) === hashIdempotencyRequest(right);
}

async function loadProjectUpdateSnapshot(context: AgentToolAuthorizationContext) {
  const row = await context.database("o_project")
    .where({
      id: context.projectId,
      workspaceId: context.workspaceId,
      deletionState: "active",
    })
    .select(...PROJECT_SAFE_FIELDS, "revision")
    .first();
  if (!row) {
    throw new AgentToolGatewayError("project_scope_invalid", "项目不存在或不属于当前工作区", { status: 404 });
  }
  return {
    revision: positiveRevision(row.revision),
    snapshot: snapshotFromRow(row),
  };
}

function parseStoredSnapshot(value: unknown): ProjectSafeSnapshot {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      throw new AgentToolGatewayError("project_undo_record_invalid", "项目撤销记录无效", { status: 409 });
    }
  }
  const result = z.object({
    name: z.string().nullable(),
    intro: z.string().nullable(),
    type: z.string().nullable(),
    artStyle: z.string().nullable(),
    projectType: z.string().nullable(),
    videoRatio: z.string().nullable(),
  }).strict().safeParse(parsed);
  if (!result.success) {
    throw new AgentToolGatewayError("project_undo_record_invalid", "项目撤销记录无效", { status: 409 });
  }
  return result.data;
}

function changedFields(
  before: ProjectSafeSnapshot,
  after: ProjectSafeSnapshot,
): ProjectSafeField[] {
  return PROJECT_SAFE_FIELDS.filter((field) => before[field] !== after[field]);
}

function projectPatchFromEdits(
  edits: ReadonlyArray<{ field: ProjectSafeField; value: string | null }>,
): Partial<ProjectSafeSnapshot> {
  return Object.fromEntries(edits.map((edit) => [edit.field, edit.value]));
}

function affectedRows(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value) || 0;
  if (Array.isArray(value)) return value.length;
  return 0;
}

function revisionConflict(expectedRevision: number, currentRevision: number): AgentToolGatewayError {
  return new AgentToolGatewayError(
    "project_revision_conflict",
    `项目已发生变化（期望 revision ${expectedRevision}，当前 ${currentRevision}）`,
    { status: 409 },
  );
}

function projectSnapshot(row: Record<string, unknown>) {
  return {
    id: Number(row.id),
    name: boundedNullableString(row.name, 200),
    intro: boundedNullableString(row.intro, 20_000),
    type: boundedNullableString(row.type, 500),
    artStyle: boundedNullableString(row.artStyle, 2_000),
    projectType: boundedNullableString(row.projectType, 200),
    mode: boundedNullableString(row.mode, 100),
    videoRatio: boundedNullableString(row.videoRatio, 100),
    revision: positiveRevision(row.revision),
  };
}

async function loadProjectSnapshot(context: AgentToolAuthorizationContext) {
  const row = await context.database("o_project")
    .where({
      id: context.projectId,
      workspaceId: context.workspaceId,
      deletionState: "active",
    })
    .select("id", "name", "intro", "type", "artStyle", "projectType", "mode", "videoRatio", "revision")
    .first();
  if (!row) {
    throw new AgentToolGatewayError("project_scope_invalid", "项目不存在或不属于当前工作区", { status: 404 });
  }
  return projectSnapshot(row);
}

export const PROJECT_GET_TOOL = defineAgentTool({
  manifest: {
    name: "project.get",
    version: "1.2.0",
    displayName: "读取当前项目",
    description: "读取当前 Agent Thread 所属项目的安全摘要。",
    riskClass: "R0",
    availability: { state: "available", sincePhase: "A2" },
    requiredPermissions: ["project:read"],
    resourceTypes: ["project"],
    mutatesState: false,
    metered: false,
  },
  inputSchema: projectGetInputSchema,
  outputSchema: projectGetOutputSchema,
  async resolveAuthorizationEvidence(_input, context) {
    const snapshot = await loadProjectSnapshot(context);
    return {
      resourceVersions: {
        [`project:${context.projectId}`]: String(snapshot.revision),
        [`project_snapshot:${context.projectId}`]: hashIdempotencyRequest(snapshot),
      },
    };
  },
  async execute(_input, context) {
    return loadProjectSnapshot(context);
  },
});

export const PROJECT_UPDATE_TOOL = defineAgentTool({
  manifest: {
    name: "project.update",
    version: "2.0.0",
    displayName: "更新当前项目简介",
    description: "以 revision 乐观锁更新当前项目的安全简介字段，或显式撤销最后一次仍处于当前 revision 的更新。",
    riskClass: "R1",
    availability: { state: "available", sincePhase: "A2" },
    requiredPermissions: ["project:write"],
    resourceTypes: ["project", "project_mutation"],
    mutatesState: true,
    metered: false,
  },
  inputSchema: projectUpdateInputSchema,
  outputSchema: projectUpdateOutputSchema,
  async resolveAuthorizationEvidence(input, context) {
    const current = await loadProjectUpdateSnapshot(context);
    const ownMutation = await context.database(PROJECT_MUTATION_TABLE)
      .where({
        workspaceId: context.workspaceId,
        projectId: context.projectId,
        runId: context.runId,
        stepId: context.stepId,
      })
      .first();

    let before: ProjectSafeSnapshot;
    let after: ProjectSafeSnapshot;
    let boundRevision: number;
    if (ownMutation) {
      before = parseStoredSnapshot(ownMutation.beforeSnapshot);
      after = parseStoredSnapshot(ownMutation.afterSnapshot);
      boundRevision = positiveRevision(ownMutation.baseRevision);
      if (
        current.revision !== positiveRevision(ownMutation.newRevision)
        || !snapshotsEqual(current.snapshot, after)
      ) {
        throw new AgentToolGatewayError(
          "tool_replay_scope_changed",
          "项目在工具完成后已发生变化，旧结果不能重放",
          { status: 409 },
        );
      }
    } else if (input.operation === "update") {
      before = current.snapshot;
      after = { ...before, ...projectPatchFromEdits(input.edits) };
      boundRevision = current.revision;
    } else {
      const target = await context.database(PROJECT_MUTATION_TABLE)
        .where({
          mutationId: input.undoToken,
          workspaceId: context.workspaceId,
          projectId: context.projectId,
          operation: "update",
        })
        .first();
      if (!target) {
        throw new AgentToolGatewayError(
          "project_undo_not_found",
          "项目撤销令牌不存在或不属于当前项目",
          { status: 404 },
        );
      }
      before = current.snapshot;
      after = parseStoredSnapshot(target.beforeSnapshot);
      boundRevision = current.revision;
    }

    return {
      resourceVersions: {
        [`project:${context.projectId}`]: String(boundRevision),
        [`project_snapshot_before:${context.projectId}`]: hashIdempotencyRequest(before),
        [`project_snapshot_after:${context.projectId}`]: hashIdempotencyRequest(after),
      },
    };
  },
  async execute(input, context) {
    // A savepoint makes domain data + the mutation journal atomic while still
    // allowing the outer Gateway transaction to persist a redacted failed Step.
    return context.database.transaction(async (trx) => {
      const project = await trx("o_project")
        .where({ id: context.projectId, workspaceId: context.workspaceId })
        .select(...PROJECT_SAFE_FIELDS, "revision")
        .forUpdate()
        .first();
      if (!project) {
        throw new AgentToolGatewayError("project_scope_invalid", "项目不存在或不属于当前工作区", { status: 404 });
      }

      const currentRevision = positiveRevision(project.revision);
      if (currentRevision !== input.expectedRevision) {
        throw revisionConflict(input.expectedRevision, currentRevision);
      }
      const before = snapshotFromRow(project);

      if (input.operation === "update") {
        const after: ProjectSafeSnapshot = { ...before, ...projectPatchFromEdits(input.edits) };
        const fields = changedFields(before, after);
        if (fields.length === 0) {
          return { revision: currentRevision, changedFields: [], undoToken: null };
        }

        const nextRevision = currentRevision + 1;
        const patch = Object.fromEntries(fields.map((field) => [field, after[field]]));
        const updated = await trx("o_project")
          .where({
            id: context.projectId,
            workspaceId: context.workspaceId,
            revision: currentRevision,
          })
          .update({
            ...patch,
            revision: nextRevision,
            updatedAt: context.now,
          });
        if (affectedRows(updated) !== 1) {
          const latest = await trx("o_project")
            .where({ id: context.projectId, workspaceId: context.workspaceId })
            .select("revision")
            .first();
          throw revisionConflict(currentRevision, positiveRevision(latest?.revision));
        }

        const mutationId = context.stepId;
        await trx(PROJECT_MUTATION_TABLE).insert({
          mutationId,
          workspaceId: context.workspaceId,
          projectId: context.projectId,
          runId: context.runId,
          stepId: context.stepId,
          actorUserId: context.actorUserId,
          operation: "update",
          baseRevision: currentRevision,
          newRevision: nextRevision,
          changedFields: JSON.stringify(fields),
          beforeSnapshot: JSON.stringify(before),
          afterSnapshot: JSON.stringify(after),
          undoOfMutationId: null,
          undoneByMutationId: null,
          createdAt: context.now,
        });

        return { revision: nextRevision, changedFields: fields, undoToken: mutationId };
      }

      const target = await trx(PROJECT_MUTATION_TABLE)
        .where({
          mutationId: input.undoToken,
          workspaceId: context.workspaceId,
          projectId: context.projectId,
          operation: "update",
        })
        .forUpdate()
        .first();
      if (!target) {
        throw new AgentToolGatewayError("project_undo_not_found", "项目撤销令牌不存在或不属于当前项目", { status: 404 });
      }
      if (target.undoneByMutationId != null) {
        throw new AgentToolGatewayError("project_undo_unavailable", "该项目变更已经撤销", { status: 409 });
      }
      const targetRevision = positiveRevision(target.newRevision);
      if (targetRevision !== currentRevision) {
        throw new AgentToolGatewayError(
          "project_undo_revision_conflict",
          "项目在该变更后已继续修改，不能安全撤销",
          { status: 409 },
        );
      }

      const after = parseStoredSnapshot(target.beforeSnapshot);
      const fields = changedFields(before, after);
      if (fields.length === 0) {
        throw new AgentToolGatewayError("project_undo_record_invalid", "项目撤销记录不包含可恢复变化", { status: 409 });
      }
      const nextRevision = currentRevision + 1;
      const restored = await trx("o_project")
        .where({
          id: context.projectId,
          workspaceId: context.workspaceId,
          revision: currentRevision,
        })
        .update({
          ...after,
          revision: nextRevision,
          updatedAt: context.now,
        });
      if (affectedRows(restored) !== 1) {
        const latest = await trx("o_project")
          .where({ id: context.projectId, workspaceId: context.workspaceId })
          .select("revision")
          .first();
        throw revisionConflict(currentRevision, positiveRevision(latest?.revision));
      }

      const undoMutationId = context.stepId;
      const claimed = await trx(PROJECT_MUTATION_TABLE)
        .where({ mutationId: input.undoToken })
        .whereNull("undoneByMutationId")
        .update({ undoneByMutationId: undoMutationId });
      if (affectedRows(claimed) !== 1) {
        throw new AgentToolGatewayError("project_undo_unavailable", "该项目变更已经撤销", { status: 409 });
      }
      await trx(PROJECT_MUTATION_TABLE).insert({
        mutationId: undoMutationId,
        workspaceId: context.workspaceId,
        projectId: context.projectId,
        runId: context.runId,
        stepId: context.stepId,
        actorUserId: context.actorUserId,
        operation: "undo",
        baseRevision: currentRevision,
        newRevision: nextRevision,
        changedFields: JSON.stringify(fields),
        beforeSnapshot: JSON.stringify(before),
        afterSnapshot: JSON.stringify(after),
        undoOfMutationId: input.undoToken,
        undoneByMutationId: null,
        createdAt: context.now,
      });

      return { revision: nextRevision, changedFields: fields, undoToken: null };
    });
  },
});
