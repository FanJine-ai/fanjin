import type { Knex } from "knex";

import {
  insertAndReturnId,
  isPostgresClient,
} from "@/lib/dbDialect";
import { normalizeObjectKey } from "@/lib/objectStorage";

const taskStateMap = {
  "0": "进行中",
  "1": "已完成",
  "-1": "生成失败",
} as const;

export interface ProjectTaskRecordInput {
  projectId: number;
  imageId?: number;
  outputStorageKey?: string;
  taskClass: string;
  modelName: string;
  describe?: string;
  content?: unknown;
}

export interface ProjectTaskCompletion {
  (state: 1 | -1, reason?: string): Promise<void>;
  readonly taskId: number;
}

export class ProjectTaskFenceError extends Error {
  readonly code = "PROJECT_TASK_PROJECT_NOT_ACTIVE";
  readonly status = 409;

  constructor() {
    super("项目正在删除或已不可用，不能启动生成任务");
    this.name = "ProjectTaskFenceError";
  }
}

export class ProjectTaskImageFenceError extends Error {
  readonly code = "PROJECT_TASK_IMAGE_NOT_ACTIVE";
  readonly status = 409;

  constructor() {
    super("图片正在删除或已不可用，不能启动生成任务");
    this.name = "ProjectTaskImageFenceError";
  }
}

export class ProjectTaskOutputCleanupError extends Error {
  readonly code = "PROJECT_TASK_OUTPUT_CLEANUP_FAILED";
  readonly status = 500;

  constructor(primary: unknown, cleanup: unknown) {
    const primaryMessage = primary instanceof Error
      ? primary.message
      : String(primary);
    const cleanupMessage = cleanup instanceof Error
      ? cleanup.message
      : String(cleanup);
    super(
      `生成结果持久化失败且对象清理失败：${primaryMessage}；清理错误：${cleanupMessage}`,
      { cause: primary },
    );
    this.name = "ProjectTaskOutputCleanupError";
  }
}

function serializeRelatedObjects(
  content: unknown,
  imageId?: number,
  outputStorageKey?: string,
): string | undefined {
  let normalizedContent = content;
  if (imageId !== undefined || outputStorageKey !== undefined) {
    if (
      imageId !== undefined
      && (!Number.isSafeInteger(imageId) || imageId <= 0)
    ) {
      throw new Error("imageId 必须是正整数");
    }
    let parsed: unknown = content;
    if (typeof content === "string") {
      try {
        parsed = JSON.parse(content);
      } catch {
        parsed = { value: content };
      }
    }
    if (
      parsed !== null
      && typeof parsed === "object"
      && !Array.isArray(parsed)
      && Object.hasOwn(parsed, "imageId")
      && Number((parsed as Record<string, unknown>).imageId) !== imageId
    ) {
      throw new Error("任务关联的 imageId 与生产者栅栏不一致");
    }
    if (
      parsed !== null
      && typeof parsed === "object"
      && !Array.isArray(parsed)
      && Object.hasOwn(parsed, "outputStorageKey")
      && String(
        (parsed as Record<string, unknown>).outputStorageKey || "",
      ) !== outputStorageKey
    ) {
      throw new Error("任务关联的 outputStorageKey 与生产者栅栏不一致");
    }
    normalizedContent = {
      ...(parsed !== null
          && typeof parsed === "object"
          && !Array.isArray(parsed)
        ? parsed
        : { value: parsed }),
      ...(imageId === undefined ? {} : { imageId }),
      ...(outputStorageKey === undefined
        ? {}
        : { outputStorageKey }),
    };
  }

  if (normalizedContent === undefined || normalizedContent === null) {
    return undefined;
  }
  if (typeof normalizedContent === "string") return normalizedContent;
  if (typeof normalizedContent === "function") throw new Error("不支持的类型");
  try {
    return JSON.stringify(normalizedContent);
  } catch {
    return String(normalizedContent);
  }
}

/**
 * Persist an active producer while holding the authoritative project row.
 *
 * The lock orders task creation against project deletion:
 * - if generation wins, deletion observes the active o_tasks row and stops;
 * - if deletion wins, the active-project recheck rejects generation before
 *   any provider or object-storage side effect can begin.
 */
export async function startProjectTaskRecord(
  database: Knex | Knex.Transaction | any,
  input: ProjectTaskRecordInput,
): Promise<ProjectTaskCompletion> {
  const outputStorageKey = input.outputStorageKey === undefined
    ? undefined
    : normalizeObjectKey(input.outputStorageKey);
  if (
    outputStorageKey !== undefined
    && !outputStorageKey.startsWith(`${input.projectId}/`)
  ) {
    throw new Error("生成结果必须写入所属项目的对象存储命名空间");
  }
  const opteorContent = serializeRelatedObjects(
    input.content,
    input.imageId,
    outputStorageKey,
  );
  const id = await database.transaction(
    async (transaction: Knex.Transaction) => {
      let projectQuery = transaction("o_project")
        .where({
          id: input.projectId,
          deletionState: "active",
        })
        .select("id", "deletionState");
      if (isPostgresClient(transaction)) {
        projectQuery = projectQuery.forUpdate();
      }
      const project = await projectQuery.first();
      if (!project) throw new ProjectTaskFenceError();

      if (input.imageId !== undefined) {
        let imageQuery = transaction("o_image as image")
          .innerJoin("o_assets as asset", "asset.id", "image.assetsId")
          .where({
            "image.id": input.imageId,
            "image.deletionState": "active",
            "asset.projectId": input.projectId,
            "asset.deletionState": "active",
          })
          .select("image.id");
        if (isPostgresClient(transaction)) {
          imageQuery = imageQuery.forUpdate();
        }
        if (!await imageQuery.first()) {
          throw new ProjectTaskImageFenceError();
        }
      }

      return await insertAndReturnId(transaction, "o_tasks", {
        projectId: input.projectId,
        taskClass: input.taskClass,
        relatedObjects: opteorContent,
        model: input.modelName,
        describe: input.describe ?? "",
        state: taskStateMap[0],
        startTime: Date.now(),
      });
    },
  );

  let terminalState: 1 | -1 | null = null;
  const done = async function done(state: 1 | -1, reason?: string) {
    if (terminalState !== null) {
      if (terminalState === state) return;
      throw new Error(`任务 ${id} 已进入终态，不能再次改写`);
    }
    const updated = await database("o_tasks")
      .where({
        id,
        state: taskStateMap[0],
      })
      .update({
        state: taskStateMap[state],
        reason: state === -1 ? (reason ?? "") : null,
      });
    if (Number(updated) !== 1) {
      throw new Error(`任务 ${id} 的活动生产者状态已丢失`);
    }
    terminalState = state;
  };
  Object.defineProperty(done, "taskId", {
    configurable: false,
    enumerable: true,
    writable: false,
    value: id,
  });
  return done as ProjectTaskCompletion;
}

export async function runWithProjectTaskRecord<T>(
  database: Knex | Knex.Transaction | any,
  input: ProjectTaskRecordInput,
  work: (taskId: number) => Promise<T>,
): Promise<T> {
  const done = await startProjectTaskRecord(database, input);
  try {
    const result = await work(done.taskId);
    await done(1);
    return result;
  } catch (cause) {
    await done(
      -1,
      cause instanceof Error ? cause.message : String(cause),
    );
    throw cause;
  }
}

export async function runWithProjectTaskOutput<T>(
  database: Knex | Knex.Transaction | any,
  input: ProjectTaskRecordInput & { outputStorageKey: string },
  callbacks: {
    write: () => Promise<void>;
    persist: (
      transaction: Knex.Transaction,
      storageKey: string,
      taskId: number,
    ) => Promise<T>;
    cleanup: () => Promise<void>;
  },
): Promise<T> {
  const storageKey = normalizeObjectKey(input.outputStorageKey);
  if (!storageKey.startsWith(`${input.projectId}/`)) {
    throw new Error("生成结果必须写入所属项目的对象存储命名空间");
  }
  return await runWithProjectTaskRecord(
    database,
    {
      ...input,
      outputStorageKey: storageKey,
    },
    async (taskId) => {
      try {
        await callbacks.write();
        return await database.transaction(
          async (transaction: Knex.Transaction) => {
            let projectQuery = transaction("o_project")
              .where({
                id: input.projectId,
                deletionState: "active",
              })
              .select("id", "deletionState");
            if (isPostgresClient(transaction)) {
              projectQuery = projectQuery.forUpdate();
            }
            const project = await projectQuery.first();
            if (!project) throw new ProjectTaskFenceError();
            return await callbacks.persist(
              transaction,
              storageKey,
              taskId,
            );
          },
        );
      } catch (primaryError) {
        try {
          await callbacks.cleanup();
        } catch (cleanupError) {
          throw new ProjectTaskOutputCleanupError(
            primaryError,
            cleanupError,
          );
        }
        throw primaryError;
      }
    },
  );
}

/**
 * 记录任务并返回结束函数
 * @param projectId  项目 ID
 * @param taskClass  任务分类
 * @param modelName   模型名称
 * @param opts       可选项：关联对象、任务描
 */
export default async function taskRecord(
  projectId: number,
  taskClass: string,
  modelName: string,
  opts: {
    describe?: string;
    content?: any;
  } = {},
) {
  const { default: database } = await import("@/utils/db");
  return await startProjectTaskRecord(database, {
    projectId,
    taskClass,
    modelName,
    describe: opts.describe,
    content: opts.content,
  });
}
