import { randomUUID } from "node:crypto";
import type { Knex } from "knex";

import {
  beginDurableCommand,
  completeDurableCommand,
  DurableCommandIdempotencyError,
  mutateDurableCommandCheckpoint,
  type DurableCommandReservation,
} from "@/lib/durableCommandIdempotency";
import { insertAndReturnId, isPostgresClient } from "@/lib/dbDialect";
import {
  executeRelayChat,
  RelayChatError,
  type RelayChatResult,
} from "@/lib/relayChat";
import { listWorkbenchTextModels } from "@/lib/workbenchTextModelCatalog";
import { stripThink } from "@/utils/stripThink";
import { db } from "@/utils/db";
import u from "@/utils";

export const NOVEL_EVENT_TASK_VERSION = "novel-event-analysis.v1" as const;
export const NOVEL_EVENT_TASK_RESOURCE_TYPE = "novel_event_analysis_task";

type NovelEventTaskPhase =
  | "queued"
  | "between_chapters"
  | "dispatching"
  | "provider_succeeded"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "pending_reconcile";

type NovelChapter = {
  id: number;
  projectId: number;
  chapterIndex?: number | null;
  reel?: string | null;
  chapter?: string | null;
  chapterData?: string | null;
  event?: string | null;
  eventState?: number | null;
};

export type NovelEventTaskCheckpoint = {
  version: typeof NOVEL_EVENT_TASK_VERSION;
  phase: NovelEventTaskPhase;
  taskId: number | null;
  commandId: string | null;
  workspaceId: string;
  actorUserId: number;
  projectId: number;
  novelIds: number[];
  model: string;
  force: boolean;
  completedIds: number[];
  cachedIds: number[];
  failedIds: number[];
  currentNovelId: number | null;
  providerIdempotencyKey: string | null;
  dispatchClaimToken: string | null;
  dispatchStartedAt: number | null;
  providerEvent: string | null;
  failureCode: string | null;
  failureMessage: string | null;
};

export type NovelEventTaskPublic = {
  taskId: number;
  projectId: number;
  state:
    | "queued"
    | "running"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "pending_reconcile";
  phase: NovelEventTaskPhase;
  cancelAllowed: boolean;
  retryAllowed: boolean;
  model: string;
  novelIds: number[];
  completedIds: number[];
  cachedIds: number[];
  failedIds: number[];
  currentNovelId: number | null;
  reason: string | null;
};

type TaskResponse = {
  task: NovelEventTaskPublic;
};

type NovelEventTaskReservation = {
  reservation: DurableCommandReservation<TaskResponse>;
  checkpoint: NovelEventTaskCheckpoint;
};

export type BeginNovelEventTaskResult =
  | {
      kind: "replay";
      responseStatus: number;
      responseBody: TaskResponse;
    }
  | ({
      kind: "task";
    } & NovelEventTaskReservation);

export type NovelEventTaskDependencies = {
  database?: Knex | Knex.Transaction | any;
  listModels?: (workspaceId: string) => Promise<Array<{ id: string }>>;
  executeText?: (
    chapter: NovelChapter,
    checkpoint: NovelEventTaskCheckpoint,
  ) => Promise<string>;
};

export class NovelEventTaskError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly task?: NovelEventTaskPublic,
  ) {
    super(message);
    this.name = "NovelEventTaskError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizedIds(values: unknown[]): number[] {
  const ids = values.map(Number);
  if (
    !ids.length
    || ids.length > 100
    || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)
    || new Set(ids).size !== ids.length
  ) {
    throw new NovelEventTaskError(
      400,
      "novel_event_invalid_ids",
      "请选择 1-100 个不重复的有效小说章节",
    );
  }
  return ids;
}

function normalizedIdempotencyKey(value: string | null | undefined): string {
  const key = String(value || "").trim();
  if (!key) {
    throw new NovelEventTaskError(
      400,
      "idempotency_key_required",
      "事件分析必须提供 Idempotency-Key，才能安全恢复且避免重复扣费",
    );
  }
  if (key.length > 200) {
    throw new NovelEventTaskError(
      400,
      "idempotency_key_invalid",
      "Idempotency-Key 不能超过 200 字符",
    );
  }
  return key;
}

export function parseNovelEventTaskCheckpoint(
  value: unknown,
): NovelEventTaskCheckpoint | null {
  if (!isRecord(value) || value.version !== NOVEL_EVENT_TASK_VERSION) return null;
  const phase = String(value.phase || "") as NovelEventTaskPhase;
  const taskId = value.taskId === null ? null : Number(value.taskId);
  if (
    ![
      "queued",
      "between_chapters",
      "dispatching",
      "provider_succeeded",
      "succeeded",
      "failed",
      "cancelled",
      "pending_reconcile",
    ].includes(phase)
    || (taskId !== null && (!Number.isSafeInteger(taskId) || taskId <= 0))
    || !Number.isSafeInteger(Number(value.actorUserId))
    || Number(value.actorUserId) <= 0
    || !Number.isSafeInteger(Number(value.projectId))
    || Number(value.projectId) <= 0
    || !String(value.workspaceId || "").trim()
    || !String(value.model || "").trim()
    || !Array.isArray(value.novelIds)
  ) {
    return null;
  }
  return value as unknown as NovelEventTaskCheckpoint;
}

function publicState(phase: NovelEventTaskPhase): NovelEventTaskPublic["state"] {
  if (phase === "queued") return "queued";
  if (
    phase === "between_chapters"
    || phase === "dispatching"
    || phase === "provider_succeeded"
  ) return "running";
  if (phase === "pending_reconcile") return "pending_reconcile";
  return phase;
}

export function toPublicNovelEventTask(
  checkpoint: NovelEventTaskCheckpoint,
  reason?: string | null,
): NovelEventTaskPublic {
  if (checkpoint.taskId === null) {
    throw new NovelEventTaskError(
      500,
      "novel_event_task_invalid",
      "事件分析任务缺少持久任务标识",
    );
  }
  return {
    taskId: checkpoint.taskId,
    projectId: checkpoint.projectId,
    state: publicState(checkpoint.phase),
    phase: checkpoint.phase,
    cancelAllowed: checkpoint.phase === "queued",
    retryAllowed: checkpoint.phase === "failed",
    model: checkpoint.model,
    novelIds: checkpoint.novelIds,
    completedIds: checkpoint.completedIds,
    cachedIds: checkpoint.cachedIds,
    failedIds: checkpoint.failedIds,
    currentNovelId: checkpoint.currentNovelId,
    reason: checkpoint.failureMessage || reason || null,
  };
}

function parseAssistantText(result: RelayChatResult): string {
  const content = result.response?.choices?.[0]?.message?.content;
  if (typeof content === "string") return stripThink(content).trim();
  if (!Array.isArray(content)) return "";
  return stripThink(
    content
      .map((part: unknown) => {
        if (typeof part === "string") return part;
        if (!isRecord(part)) return "";
        return typeof part.text === "string" ? part.text : "";
      })
      .join(""),
  ).trim();
}

async function buildPrompt(
  chapter: NovelChapter,
  database: Knex | Knex.Transaction | any,
): Promise<{ system: string; user: string }> {
  const configured = await database("o_prompt")
    .where("type", "eventExtraction")
    .first();
  const configuredPrompt = String(
    configured?.useData || configured?.data || "",
  ).trim();
  const system = configuredPrompt || String(await u.getPrompts("event") || "").trim();
  if (!system) {
    throw new NovelEventTaskError(
      503,
      "novel_event_prompt_unavailable",
      "事件分析系统提示词尚未配置",
    );
  }
  return {
    system,
    user: [
      `小说章节序号：${chapter.chapterIndex ?? ""}`,
      `小说卷：${chapter.reel || ""}`,
      `小说章节名称：${chapter.chapter || ""}`,
      "请根据以下小说章节内容生成事件摘要：",
      String(chapter.chapterData || ""),
    ].join("\n"),
  };
}

async function executeRelayText(
  chapter: NovelChapter,
  checkpoint: NovelEventTaskCheckpoint,
  database: Knex | Knex.Transaction | any,
): Promise<string> {
  const prompt = await buildPrompt(chapter, database);
  const idempotencyKey = String(checkpoint.providerIdempotencyKey || "");
  const result = await executeRelayChat(
    {
      model: checkpoint.model,
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
      temperature: 0.2,
      max_tokens: 2_048,
      stream: false,
      user: `novel-event:${checkpoint.actorUserId}`,
    },
    {
      workspaceId: checkpoint.workspaceId,
      apiKeyId: null,
      principalId: `user:${checkpoint.actorUserId}`,
      requestId: idempotencyKey,
      idempotencyKey,
    },
  );
  const text = parseAssistantText(result);
  if (!text) {
    throw new RelayChatError("文本上游返回空事件分析结果", 502, true);
  }
  return text;
}

async function lockProject(
  transaction: Knex.Transaction,
  workspaceId: string,
  projectId: number,
): Promise<void> {
  let query = transaction("o_project")
    .where({
      id: projectId,
      workspaceId,
      deletionState: "active",
    })
    .select("id");
  if (isPostgresClient(transaction)) query = query.forUpdate();
  if (!await query.first()) {
    throw new NovelEventTaskError(
      409,
      "novel_event_project_not_active",
      "项目正在删除或已不可用，不能启动事件分析",
    );
  }
}

export async function beginNovelEventAnalysisTask(input: {
  workspaceId: string;
  actorUserId: number;
  projectId: number;
  novelIds: number[];
  model?: string | null;
  force?: boolean;
  idempotencyKey?: string | null;
}, dependencies: NovelEventTaskDependencies = {}): Promise<BeginNovelEventTaskResult> {
  const database = dependencies.database || db;
  const novelIds = normalizedIds(input.novelIds);
  const idempotencyKey = normalizedIdempotencyKey(input.idempotencyKey);
  const chapters = await database("o_novel")
    .where({ projectId: input.projectId })
    .whereIn("id", novelIds)
    .select("id");
  if (chapters.length !== novelIds.length) {
    throw new NovelEventTaskError(
      404,
      "novel_event_chapter_not_found",
      "小说章节不存在或不属于当前项目",
    );
  }
  const models = await (dependencies.listModels || listWorkbenchTextModels)(
    input.workspaceId,
  );
  const requestedModel = String(input.model || "").trim();
  const model = requestedModel
    ? models.find((item) => item.id === requestedModel)?.id
    : models[0]?.id;
  if (!model) {
    throw new NovelEventTaskError(
      503,
      "novel_event_text_model_unavailable",
      "当前工作区没有同时具备真实通道和正式 GU 定价的文本模型",
    );
  }
  const initialCheckpoint: NovelEventTaskCheckpoint = {
    version: NOVEL_EVENT_TASK_VERSION,
    phase: "queued",
    taskId: null,
    commandId: null,
    workspaceId: input.workspaceId,
    actorUserId: input.actorUserId,
    projectId: input.projectId,
    novelIds,
    model,
    force: Boolean(input.force),
    completedIds: [],
    cachedIds: [],
    failedIds: [],
    currentNovelId: null,
    providerIdempotencyKey: null,
    dispatchClaimToken: null,
    dispatchStartedAt: null,
    providerEvent: null,
    failureCode: null,
    failureMessage: null,
  };
  let reservation: DurableCommandReservation<TaskResponse>;
  try {
    reservation = await beginDurableCommand<TaskResponse>({
      database,
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      scope: "novel:event-analysis",
      idempotencyKey,
      request: {
        projectId: input.projectId,
        novelIds,
        model,
        force: Boolean(input.force),
      },
      initialCheckpoint,
    });
  } catch (error) {
    if (error instanceof DurableCommandIdempotencyError) {
      throw new NovelEventTaskError(error.status, error.code, error.message);
    }
    throw error;
  }
  if (reservation.kind === "replay") return reservation;
  if (reservation.kind !== "resume") {
    throw new NovelEventTaskError(
      500,
      "novel_event_checkpoint_missing",
      "事件分析任务未建立恢复检查点",
    );
  }
  const mutation = await mutateDurableCommandCheckpoint<
    TaskResponse,
    NovelEventTaskCheckpoint
  >(
    reservation,
    async (current, transaction) => {
      const checkpoint = parseNovelEventTaskCheckpoint(current);
      if (!checkpoint) {
        throw new NovelEventTaskError(
          500,
          "novel_event_checkpoint_invalid",
          "事件分析任务恢复检查点无效",
        );
      }
      if (checkpoint.taskId !== null) return checkpoint;
      await lockProject(transaction, checkpoint.workspaceId, checkpoint.projectId);
      const taskId = await insertAndReturnId(transaction, "o_tasks", {
        projectId: checkpoint.projectId,
        taskClass: "小说事件分析",
        relatedObjects: JSON.stringify({
          version: NOVEL_EVENT_TASK_VERSION,
          commandId: reservation.id,
          novelIds: checkpoint.novelIds,
        }),
        model: checkpoint.model,
        describe: `分析 ${checkpoint.novelIds.length} 个小说章节`,
        state: "进行中",
        startTime: Date.now(),
        reason: "",
      });
      await transaction("o_agent_idempotency")
        .where({ id: reservation.id, status: "checkpointed" })
        .update({
          resourceType: NOVEL_EVENT_TASK_RESOURCE_TYPE,
          resourceId: String(taskId),
        });
      return {
        ...checkpoint,
        taskId,
        commandId: reservation.id,
      };
    },
    { database },
  );
  if (mutation.kind === "replay") return mutation;
  const checkpoint = parseNovelEventTaskCheckpoint(mutation.checkpoint);
  if (!checkpoint || checkpoint.taskId === null) {
    throw new NovelEventTaskError(
      500,
      "novel_event_checkpoint_invalid",
      "事件分析任务缺少持久任务标识",
    );
  }
  return {
    kind: "task",
    reservation: {
      kind: "resume",
      id: mutation.id,
      checkpoint,
    },
    checkpoint,
  };
}

async function updateCheckpoint(
  task: NovelEventTaskReservation,
  mutate: (
    checkpoint: NovelEventTaskCheckpoint,
    transaction: Knex.Transaction,
  ) => Promise<NovelEventTaskCheckpoint> | NovelEventTaskCheckpoint,
  database: Knex | Knex.Transaction | any,
): Promise<NovelEventTaskReservation> {
  const mutation = await mutateDurableCommandCheckpoint<
    TaskResponse,
    NovelEventTaskCheckpoint
  >(task.reservation, mutate, { database });
  if (mutation.kind === "replay") {
    throw new NovelEventTaskError(
      409,
      "novel_event_task_completed",
      "事件分析任务已经完成",
    );
  }
  const checkpoint = parseNovelEventTaskCheckpoint(mutation.checkpoint);
  if (!checkpoint) {
    throw new NovelEventTaskError(
      500,
      "novel_event_checkpoint_invalid",
      "事件分析任务恢复检查点无效",
    );
  }
  return {
    reservation: {
      kind: "resume",
      id: mutation.id,
      checkpoint,
    },
    checkpoint,
  };
}

async function finishTask(
  task: NovelEventTaskReservation,
  phase: "succeeded" | "failed",
  database: Knex | Knex.Transaction | any,
): Promise<NovelEventTaskPublic> {
  const next = await updateCheckpoint(
    task,
    async (checkpoint, transaction) => {
      const failureMessage = phase === "failed"
        ? checkpoint.failureMessage || "事件分析失败"
        : null;
      await transaction("o_tasks")
        .where({ id: checkpoint.taskId, projectId: checkpoint.projectId })
        .update({
          state: phase === "succeeded" ? "已完成" : "生成失败",
          reason: failureMessage || "",
        });
      return {
        ...checkpoint,
        phase,
        currentNovelId: null,
        providerIdempotencyKey: null,
        dispatchClaimToken: null,
        dispatchStartedAt: null,
        providerEvent: null,
        failureMessage,
      };
    },
    database,
  );
  const publicTask = toPublicNovelEventTask(next.checkpoint);
  await completeDurableCommand(
    next.reservation,
    { task: publicTask },
    200,
    { database },
  );
  return publicTask;
}

export async function runNovelEventAnalysisTask(
  initialTask: NovelEventTaskReservation,
  dependencies: NovelEventTaskDependencies = {},
): Promise<NovelEventTaskPublic> {
  const database = dependencies.database || db;
  let task = initialTask;
  while (true) {
    if (task.checkpoint.phase === "provider_succeeded") {
      const novelId = task.checkpoint.currentNovelId;
      const providerEvent = String(task.checkpoint.providerEvent || "").trim();
      if (!novelId || !providerEvent) {
        throw new NovelEventTaskError(
          500,
          "novel_event_provider_checkpoint_invalid",
          "事件分析上游成功检查点无效",
        );
      }
      task = await updateCheckpoint(
        task,
        async (checkpoint, transaction) => {
          const updated = await transaction("o_novel")
            .where({ id: novelId, projectId: checkpoint.projectId })
            .update({
              event: providerEvent,
              eventState: 1,
              errorReason: null,
            });
          if (Number(updated) !== 1) {
            throw new Error(`小说章节 ${novelId} 的事件分析结果写入失败`);
          }
          return {
            ...checkpoint,
            phase: "between_chapters",
            completedIds: [...checkpoint.completedIds, novelId],
            currentNovelId: null,
            providerIdempotencyKey: null,
            dispatchClaimToken: null,
            dispatchStartedAt: null,
            providerEvent: null,
          };
        },
        database,
      );
      continue;
    }
    if (task.checkpoint.phase === "dispatching") {
      const stale = Number(task.checkpoint.dispatchStartedAt || 0)
        <= Date.now() - 3 * 60 * 1_000;
      if (!stale) return toPublicNovelEventTask(task.checkpoint);
      task = await updateCheckpoint(
        task,
        async (checkpoint, transaction) => {
          const reason = "事件分析进程在上游派发后中断，结果与账务待核对，禁止自动重发";
          if (checkpoint.currentNovelId !== null) {
            await transaction("o_novel")
              .where({
                id: checkpoint.currentNovelId,
                projectId: checkpoint.projectId,
              })
              .update({
                eventState: -1,
                errorReason: reason,
              });
          }
          await transaction("o_tasks")
            .where({ id: checkpoint.taskId, projectId: checkpoint.projectId })
            .update({ state: "进行中", reason });
          return {
            ...checkpoint,
            phase: "pending_reconcile",
            failedIds: checkpoint.currentNovelId === null
              ? checkpoint.failedIds
              : Array.from(new Set([
                  ...checkpoint.failedIds,
                  checkpoint.currentNovelId,
                ])),
            failureCode: "novel_event_pending_reconcile",
            failureMessage: reason,
          };
        },
        database,
      );
      return toPublicNovelEventTask(task.checkpoint);
    }
    if (!["queued", "between_chapters"].includes(task.checkpoint.phase)) {
      return toPublicNovelEventTask(task.checkpoint);
    }
    const nextNovelId = task.checkpoint.novelIds.find(
      (id) => !task.checkpoint.completedIds.includes(id)
        && !task.checkpoint.failedIds.includes(id),
    );
    if (!nextNovelId) return await finishTask(task, "succeeded", database);

    const chapter = await database("o_novel")
      .where({
        id: nextNovelId,
        projectId: task.checkpoint.projectId,
      })
      .first() as NovelChapter | undefined;
    if (!chapter) {
      task = await updateCheckpoint(
        task,
        (checkpoint) => ({
          ...checkpoint,
          phase: "failed",
          failedIds: Array.from(new Set([...checkpoint.failedIds, nextNovelId])),
          failureCode: "novel_event_chapter_not_found",
          failureMessage: "小说章节在任务执行期间已不可用",
        }),
        database,
      );
      return await finishTask(task, "failed", database);
    }
    if (
      !task.checkpoint.force
      && Number(chapter.eventState) === 1
      && String(chapter.event || "").trim()
    ) {
      task = await updateCheckpoint(
        task,
        (checkpoint) => ({
          ...checkpoint,
          phase: "between_chapters",
          completedIds: [...checkpoint.completedIds, nextNovelId],
          cachedIds: [...checkpoint.cachedIds, nextNovelId],
        }),
        database,
      );
      continue;
    }

    const providerIdempotencyKey =
      `${task.checkpoint.commandId}:novel:${nextNovelId}`;
    const dispatchClaimToken = randomUUID();
    task = await updateCheckpoint(
      task,
      async (checkpoint, transaction) => {
        if (!["queued", "between_chapters"].includes(checkpoint.phase)) {
          return checkpoint;
        }
        await transaction("o_novel")
          .where({ id: nextNovelId, projectId: checkpoint.projectId })
          .update({
            eventState: 0,
            errorReason: null,
            ...(checkpoint.force ? { event: null } : {}),
          });
        await transaction("o_tasks")
          .where({ id: checkpoint.taskId, projectId: checkpoint.projectId })
          .update({
            state: "进行中",
            reason: `正在分析章节 ${nextNovelId}`,
          });
        return {
          ...checkpoint,
          phase: "dispatching",
          currentNovelId: nextNovelId,
          providerIdempotencyKey,
          dispatchClaimToken,
          dispatchStartedAt: Date.now(),
          providerEvent: null,
          failureCode: null,
          failureMessage: null,
        };
      },
      database,
    );
    if (
      task.checkpoint.phase !== "dispatching"
      || task.checkpoint.currentNovelId !== nextNovelId
      || task.checkpoint.dispatchClaimToken !== dispatchClaimToken
    ) {
      return toPublicNovelEventTask(task.checkpoint);
    }

    let event: string;
    try {
      event = await (
        dependencies.executeText
        || ((item, checkpoint) => executeRelayText(item, checkpoint, database))
      )(chapter, task.checkpoint);
    } catch (error) {
      const outcomeUnknown = error instanceof RelayChatError
        && error.upstreamMayHaveAccepted;
      const message = error instanceof Error
        ? error.message.slice(0, 1_000)
        : "事件分析失败";
      task = await updateCheckpoint(
        task,
        async (checkpoint, transaction) => {
          await transaction("o_novel")
            .where({ id: nextNovelId, projectId: checkpoint.projectId })
            .update({
              eventState: -1,
              errorReason: outcomeUnknown
                ? "上游结果与账务待核对，禁止自动重试"
                : message,
            });
          await transaction("o_tasks")
            .where({ id: checkpoint.taskId, projectId: checkpoint.projectId })
            .update({
              state: outcomeUnknown ? "进行中" : "生成失败",
              reason: outcomeUnknown
                ? "上游结果与账务待核对，禁止自动重试"
                : message,
            });
          return {
            ...checkpoint,
            phase: outcomeUnknown ? "pending_reconcile" : "failed",
            failedIds: Array.from(new Set([...checkpoint.failedIds, nextNovelId])),
            failureCode: outcomeUnknown
              ? "novel_event_pending_reconcile"
              : "novel_event_analysis_failed",
            failureMessage: outcomeUnknown
              ? "上游结果与账务待核对，禁止自动重试"
              : message,
          };
        },
        database,
      );
      if (outcomeUnknown) return toPublicNovelEventTask(task.checkpoint);
      return await finishTask(task, "failed", database);
    }
    task = await updateCheckpoint(
      task,
      (checkpoint) => {
        if (
          checkpoint.phase !== "dispatching"
          || checkpoint.currentNovelId !== nextNovelId
          || checkpoint.providerIdempotencyKey !== providerIdempotencyKey
          || checkpoint.dispatchClaimToken !== dispatchClaimToken
        ) {
          throw new NovelEventTaskError(
            409,
            "novel_event_dispatch_claim_lost",
            "事件分析任务派发权已变化，禁止写入上游成功结果",
          );
        }
        return {
          ...checkpoint,
          phase: "provider_succeeded",
          dispatchStartedAt: null,
          providerEvent: event,
        };
      },
      database,
    );
  }
}

export async function readNovelEventAnalysisTasks(input: {
  workspaceId: string;
  projectId: number;
  taskIds?: number[];
}, dependencies: NovelEventTaskDependencies = {}): Promise<NovelEventTaskPublic[]> {
  const database = dependencies.database || db;
  const project = await database("o_project")
    .where({
      id: input.projectId,
      workspaceId: input.workspaceId,
      deletionState: "active",
    })
    .first();
  if (!project) {
    throw new NovelEventTaskError(
      404,
      "novel_event_project_not_found",
      "项目不存在或已不可用",
    );
  }
  let query = database("o_tasks")
    .where({
      projectId: input.projectId,
      taskClass: "小说事件分析",
    })
    .orderBy("id", "desc");
  if (input.taskIds?.length) query = query.whereIn("id", input.taskIds);
  const rows = await query;
  if (!rows.length) return [];
  const commands = await database("o_agent_idempotency")
    .where({
      workspaceId: input.workspaceId,
      resourceType: NOVEL_EVENT_TASK_RESOURCE_TYPE,
    })
    .whereIn("resourceId", rows.map((row: any) => String(row.id)));
  const commandByTask = new Map(
    commands.map((row: any) => [String(row.resourceId), row]),
  );
  const result: NovelEventTaskPublic[] = [];
  for (const row of rows) {
    const command = commandByTask.get(String(row.id)) as any;
    if (!command) continue;
    if (String(command.status) === "completed") {
      try {
        const body = JSON.parse(String(command.responseBody || ""));
        if (body?.task) result.push(body.task as NovelEventTaskPublic);
      } catch {
        // Invalid durable evidence is not exposed as a usable task.
      }
      continue;
    }
    try {
      const checkpoint = parseNovelEventTaskCheckpoint(
        JSON.parse(String(command.responseBody || "")),
      );
      if (checkpoint) result.push(toPublicNovelEventTask(checkpoint, row.reason));
    } catch {
      // Invalid durable evidence is not exposed as a usable task.
    }
  }
  return result;
}

export async function cancelNovelEventAnalysisTask(input: {
  workspaceId: string;
  projectId: number;
  taskId: number;
}, dependencies: NovelEventTaskDependencies = {}): Promise<{
  cancelled: boolean;
  task: NovelEventTaskPublic;
}> {
  const database = dependencies.database || db;
  const [task] = await readNovelEventAnalysisTasks({
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    taskIds: [input.taskId],
  }, dependencies);
  if (!task) {
    throw new NovelEventTaskError(
      404,
      "novel_event_task_not_found",
      "事件分析任务不存在",
    );
  }
  if (!task.cancelAllowed) return { cancelled: false, task };
  const command = await database("o_agent_idempotency")
    .where({
      workspaceId: input.workspaceId,
      resourceType: NOVEL_EVENT_TASK_RESOURCE_TYPE,
      resourceId: String(input.taskId),
      status: "checkpointed",
    })
    .first();
  if (!command) return { cancelled: false, task };
  const checkpoint = parseNovelEventTaskCheckpoint(
    JSON.parse(String(command.responseBody || "")),
  );
  if (!checkpoint) {
    throw new NovelEventTaskError(
      500,
      "novel_event_checkpoint_invalid",
      "事件分析任务恢复检查点无效",
    );
  }
  const active: NovelEventTaskReservation = {
    reservation: {
      kind: "resume",
      id: String(command.id),
      checkpoint,
    },
    checkpoint,
  };
  let cancelled = false;
  const next = await updateCheckpoint(
    active,
    async (current, transaction) => {
      if (current.phase !== "queued") return current;
      cancelled = true;
      await transaction("o_tasks")
        .where({ id: input.taskId, projectId: input.projectId })
        .update({
          state: "已取消",
          reason: "任务已在首次上游派发前取消，未产生模型费用",
        });
      return {
        ...current,
        phase: "cancelled",
        failureCode: "novel_event_task_cancelled",
        failureMessage: "任务已在首次上游派发前取消，未产生模型费用",
      };
    },
    database,
  );
  const publicTask = toPublicNovelEventTask(next.checkpoint);
  if (cancelled) {
    await completeDurableCommand(
      next.reservation,
      { task: publicTask },
      200,
      { database },
    );
  }
  return { cancelled, task: publicTask };
}
