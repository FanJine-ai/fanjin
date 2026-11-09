import {
  resolveStableSubmissionAttempt,
  type StableSubmissionAttempt,
} from "../../features/quick-create/submissionAttempt";

function responseRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requireMessage(source: Record<string, unknown> | null, operation: string): string {
  const message = typeof source?.message === "string" ? source.message.trim() : "";
  if (!source || !message) {
    throw new Error(`${operation}响应格式无效，未确认数据是否写入`);
  }
  return message;
}

function positiveId(value: unknown): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function positiveIds(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const ids = value.map(positiveId);
  return ids.every((id): id is number => id !== null) ? ids : null;
}

function randomAttemptId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function resolveWritingSubmissionAttempt(
  current: StableSubmissionAttempt | null,
  prefix: string,
  payload: unknown,
): StableSubmissionAttempt {
  return resolveStableSubmissionAttempt(current, prefix, payload, randomAttemptId);
}

export function normalizeNovelImportAcknowledgement(
  value: unknown,
  expectedCount: number,
): { message: string; ids: number[]; eventState: string } {
  const source = responseRecord(value);
  const message = requireMessage(source, "小说导入");
  const ids = positiveIds(source?.ids);
  const eventState = typeof source?.eventState === "string" ? source.eventState.trim() : "";
  if (!ids || ids.length !== expectedCount || !eventState) {
    throw new Error("小说导入响应与提交章节不一致，未确认数据是否完整写入");
  }
  return { message, ids, eventState };
}

export function normalizeNovelUpdateAcknowledgement(
  value: unknown,
): { message: string; eventInvalidated: boolean } {
  const source = responseRecord(value);
  const message = requireMessage(source, "小说编辑");
  if (typeof source?.eventInvalidated !== "boolean") {
    throw new Error("小说编辑响应格式无效，未确认事件分析状态是否同步");
  }
  return { message, eventInvalidated: source.eventInvalidated };
}

export function normalizeScriptAddAcknowledgement(
  value: unknown,
): { message: string; id: number } {
  const source = responseRecord(value);
  const message = requireMessage(source, "剧本新增");
  const id = positiveId(source?.id);
  if (id === null) {
    throw new Error("剧本新增响应缺少有效 ID，未确认数据是否写入");
  }
  return { message, id };
}

export function normalizeScriptBatchAcknowledgement(
  value: unknown,
  expectedCount: number,
): { message: string; ids: number[]; count: number } {
  const source = responseRecord(value);
  const message = requireMessage(source, "剧本批量导入");
  const ids = positiveIds(source?.ids);
  const count = Number(source?.count);
  if (
    !ids
    || ids.length !== expectedCount
    || !Number.isSafeInteger(count)
    || count !== expectedCount
  ) {
    throw new Error("剧本批量导入响应与提交数量不一致，未确认数据是否完整写入");
  }
  return { message, ids, count };
}

export function normalizeScriptUpdateAcknowledgement(
  value: unknown,
  expectedId: number,
): { message: string; id: number } {
  const source = responseRecord(value);
  const message = requireMessage(source, "剧本编辑");
  const id = positiveId(source?.id);
  if (id !== expectedId) {
    throw new Error("剧本编辑响应与目标剧本不一致，未确认数据是否写入");
  }
  return { message, id };
}

export function writingSubmissionError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}
