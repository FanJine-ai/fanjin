/**
 * 只读快照查询函数：从持久化 Steps 构建 Agent 工具循环的上下文。
 * 
 * 这些函数从 AgentToolLoopProcessor 提取，供新旧 processor 共用。
 * 特点：纯查询，无副作用，只依赖 database 参数。
 */
import type { Knex } from "knex";
import type { AgentContentPart } from "./types";
import type { AgentToolLoopToolCall, AgentToolLoopToolResult, RawStep } from "./toolLoopProcessor";

/** 常量：模型 Step 幂等键前缀 */
const MODEL_STEP_PREFIX = "agent-model";

/** 常量：StoredModelTurnResult 类型标识 */
const TOOL_LOOP_RESULT_REF = "model_turn_result";

/** Agent 对话上下文项（喂给模型的历史消息）。 */
export type AgentToolLoopTranscriptItem =
  | { role: "user"; content: AgentContentPart[] }
  | { role: "assistant"; text: string; reasoningContent?: string; toolCalls: AgentToolLoopToolCall[] }
  | { role: "tool"; callId: string; name: string; output: unknown };

/** StoredModelTurnResult：模型 Step 的 result 结构。 */
interface StoredModelTurnResult {
  type: typeof TOOL_LOOP_RESULT_REF;
  turn: number;
  outcome: "tool_calls" | "final";
  assistantText: string;
  reasoningContent?: string;
  calls: AgentToolLoopToolCall[];
  toolResults: AgentToolLoopToolResult[];
  content: AgentContentPart[];
  approvalId: string | null;
  argumentsRevised?: { approvalId: string; revision: number; at: number } | null;
}

/**
 * 解析 JSON 数组，失败返回空数组。
 */
function parseArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

/**
 * 从 Step.outputRefs 提取 StoredModelTurnResult。
 */
function storedTurnResult(step: Pick<RawStep, "outputRefs">): StoredModelTurnResult | null {
  const ref = parseArray<Record<string, unknown>>(step.outputRefs)
    .find((item) => item?.type === TOOL_LOOP_RESULT_REF);
  if (!ref) return null;
  const turn = Number(ref.turn);
  const outcome = ref.outcome;
  if (!Number.isSafeInteger(turn) || turn <= 0 || (outcome !== "tool_calls" && outcome !== "final")) return null;
  
  // 提取 argumentsRevised marker
  let argumentsRevised: StoredModelTurnResult["argumentsRevised"] = null;
  if (ref.argumentsRevised && typeof ref.argumentsRevised === "object") {
    const marker = ref.argumentsRevised as Record<string, unknown>;
    if (typeof marker.approvalId === "string" && typeof marker.revision === "number" && typeof marker.at === "number") {
      argumentsRevised = {
        approvalId: marker.approvalId,
        revision: marker.revision,
        at: marker.at,
      };
    }
  }
  
  return {
    type: TOOL_LOOP_RESULT_REF,
    turn,
    outcome,
    assistantText: typeof ref.assistantText === "string" ? ref.assistantText : "",
    reasoningContent: typeof ref.reasoningContent === "string" ? ref.reasoningContent : "",
    calls: Array.isArray(ref.calls) ? ref.calls as AgentToolLoopToolCall[] : [],
    toolResults: Array.isArray(ref.toolResults) ? ref.toolResults as AgentToolLoopToolResult[] : [],
    content: Array.isArray(ref.content) ? ref.content as AgentContentPart[] : [],
    approvalId: typeof ref.approvalId === "string" && ref.approvalId ? ref.approvalId : null,
    argumentsRevised,
  };
}

/**
 * 构造模型 Step 的幂等键。
 */
function modelStepKey(runId: string, turn: number): string {
  return `${MODEL_STEP_PREFIX}:${runId}:turn:${turn}`;
}

/**
 * 从持久化 Steps 构建对话上下文（transcript）。
 * 用于喂给模型的历史消息列表。
 * 
 * @param database - Knex 实例
 * @param runId - Run ID
 * @param triggerContent - 用户触发消息的 content
 * @param beforeTurn - 截止 turn（不含），只返回 turn < beforeTurn 的历史
 * @returns 对话上下文数组
 */
export async function buildToolLoopTranscript(
  database: Knex,
  runId: string,
  triggerContent: AgentContentPart[],
  beforeTurn: number,
): Promise<AgentToolLoopTranscriptItem[]> {
  const transcript: AgentToolLoopTranscriptItem[] = [{
    role: "user",
    content: triggerContent,
  }];
  
  const steps = await database<RawStep>("o_agent_step")
    .where({ runId, kind: "model", status: "succeeded" })
    .orderBy("seq", "asc");
  
  for (const step of steps) {
    const result = storedTurnResult(step);
    if (!result || result.turn >= beforeTurn) continue;
    if (result.outcome === "final") continue;
    
    transcript.push({
      role: "assistant",
      text: result.assistantText,
      reasoningContent: result.reasoningContent,
      toolCalls: result.calls,
    });
    
    for (const toolResult of result.toolResults) {
      transcript.push({
        role: "tool",
        callId: toolResult.callId,
        name: toolResult.name,
        output: toolResult.output,
      });
    }
  }
  
  return transcript;
}

/**
 * 查找指定 turn 的模型 Step（如果存在）。
 * 用于检查「上一轮模型是否已 commit」。
 * 
 * @param database - Knex 实例
 * @param runId - Run ID
 * @param turn - turn 编号
 * @returns RawStep 或 null
 */
export async function findModelStep(
  database: Knex,
  runId: string,
  turn: number,
): Promise<RawStep | null> {
  return await database<RawStep>("o_agent_step")
    .where({ runId, idempotencyKey: modelStepKey(runId, turn), kind: "model" })
    .first() ?? null;
}

/**
 * 统计 Run 已使用的工具调用总数（跨 turn）。
 * 用于限额检查（maxToolCalls）。
 * 
 * @param database - Knex 实例
 * @param runId - Run ID
 * @returns 已使用的工具调用数量
 */
export async function countPersistedToolCalls(
  database: Knex,
  runId: string,
): Promise<number> {
  const steps = await database<RawStep>("o_agent_step")
    .where({ runId, kind: "model", status: "succeeded" })
    .select("outputRefs");
  
  return steps.reduce((total, step) => total + (storedTurnResult(step)?.toolResults.length ?? 0), 0);
}
