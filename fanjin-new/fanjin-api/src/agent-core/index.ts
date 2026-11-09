/**
 * Agent Core 统一导出。
 */
export * from "./types";
export * from "./snapshot";
export * from "./decision";
export * from "./reducer";
export * from "./clamp";
export * from "./errors";

// ── 编译期断言：core 契约必须与 runtime 现有契约结构兼容 ──
// 若有人改了 runtime 侧字段而没同步 core，tsc --noEmit 立刻红。
import type {
  AgentToolLoopToolCall,
  AgentToolLoopToolResult,
  AgentToolLoopModelResult,
  AgentToolLoopTranscriptItem,
} from "@/agent-runtime/toolLoopProcessor";
import type { AgentContentPart } from "@/agent-runtime/types";
import type { CoreToolCall, CoreToolResult, CoreModelResult, CoreTranscriptItem, CoreContentPart } from "./types";

type _AssertToolCall = CoreToolCall extends AgentToolLoopToolCall ? true : never;
const _assertToolCall: _AssertToolCall = true as _AssertToolCall;

type _AssertToolResult = CoreToolResult extends AgentToolLoopToolResult ? true : never;
const _assertToolResult: _AssertToolResult = true as _AssertToolResult;

type _AssertModelResult = CoreModelResult extends AgentToolLoopModelResult ? true : never;
const _assertModelResult: _AssertModelResult = true as _AssertModelResult;

type _AssertTranscriptItem = CoreTranscriptItem extends AgentToolLoopTranscriptItem ? true : never;
const _assertTranscriptItem: _AssertTranscriptItem = true as _AssertTranscriptItem;

type _AssertContentPart = CoreContentPart extends AgentContentPart ? true : never;
const _assertContentPart: _AssertContentPart = true as _AssertContentPart;
