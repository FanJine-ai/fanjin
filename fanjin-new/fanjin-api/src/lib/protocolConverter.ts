// 协议转换层：Claude ↔ OpenAI 双向转换。
// 设计参考 NewAPI 的 adaptor 模式——请求进来识别客户端协议，
// 选通道后按上游协议做转换，响应再转回客户端期望的格式。
//
// 支持的转换路径：
//   Claude 请求 → OpenAI 请求（当上游是 OpenAI 兼容通道时）
//   OpenAI 响应 → Claude 响应（流式 SSE + 非流式 JSON）
//   Anthropic 通道直通（格式相同，不转换）

// ============ Claude 请求类型 ============
export interface ClaudeMessage {
  role: "user" | "assistant";
  content: string | ClaudeContentBlock[];
}

export interface ClaudeContentBlock {
  type: "text" | "image" | "tool_use" | "tool_result";
  text?: string;
  source?: { type: string; media_type: string; data: string };
  id?: string;
  name?: string;
  input?: any;
  tool_use_id?: string;
  content?: string | ClaudeContentBlock[];
}

export interface ClaudeTool {
  name: string;
  description?: string;
  input_schema: any;
}

export interface ClaudeRequest {
  model: string;
  messages: ClaudeMessage[];
  system?: string | Array<{ type: string; text: string }>;
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stream?: boolean;
  stop_sequences?: string[];
  tools?: ClaudeTool[];
  tool_choice?: { type: "auto" | "any" | "tool"; name?: string };
  // Claude 思考/推理
  thinking?: { type: "enabled"; budget_tokens: number };
}

// ============ OpenAI 请求类型 ============
export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  stream_options?: { include_usage: boolean };
  stop?: string | string[];
  tools?: OpenAITool[];
  tool_choice?: string | { type: "function"; function: { name: string } };
  frequency_penalty?: number;
  presence_penalty?: number;
}

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

export interface OpenAITool {
  type: "function";
  function: { name: string; description?: string; parameters: any };
}

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

// ============ Claude → OpenAI 请求转换 ============
export function claudeRequestToOpenAI(req: ClaudeRequest): OpenAIChatRequest {
  const messages: OpenAIMessage[] = [];

  // system 字段 → OpenAI system message
  if (req.system) {
    const systemText = typeof req.system === "string"
      ? req.system
      : req.system.map((b) => b.text).join("\n");
    messages.push({ role: "system", content: systemText });
  }

  // 转换 messages
  for (const msg of req.messages) {
    if (msg.role === "user") {
      messages.push(...claudeUserToOpenAI(msg));
    } else if (msg.role === "assistant") {
      messages.push(claudeAssistantToOpenAI(msg));
    }
  }

  const openaiReq: OpenAIChatRequest = {
    model: req.model,
    messages,
    max_tokens: req.max_tokens,
    temperature: req.temperature,
    top_p: req.top_p,
    stream: req.stream,
    ...(req.stream && { stream_options: { include_usage: true } }),
    ...(req.stop_sequences && { stop: req.stop_sequences }),
  };

  // tools 转换：Claude input_schema → OpenAI function.parameters
  if (req.tools?.length) {
    openaiReq.tools = req.tools.map((t) => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
  }

  // tool_choice 转换
  if (req.tool_choice) {
    if (req.tool_choice.type === "auto") openaiReq.tool_choice = "auto";
    else if (req.tool_choice.type === "any") openaiReq.tool_choice = "required";
    else if (req.tool_choice.type === "tool" && req.tool_choice.name) {
      openaiReq.tool_choice = { type: "function", function: { name: req.tool_choice.name } };
    }
  }

  return openaiReq;
}

function claudeUserToOpenAI(msg: ClaudeMessage): OpenAIMessage[] {
  if (typeof msg.content === "string") {
    return [{ role: "user", content: msg.content }];
  }
  // 处理 content blocks：tool_result → tool role，text → 合并
  const blocks = msg.content as ClaudeContentBlock[];
  const toolResults = blocks.filter((b) => b.type === "tool_result");
  const textParts = blocks.filter((b) => b.type === "text").map((b) => b.text || "");

  if (toolResults.length > 0) {
    // 每个 tool_result 块 → 独立的 OpenAI tool message（支持并行工具调用）
    // OpenAI 要求每个 tool_call 都有对应的 tool message
    const messages: OpenAIMessage[] = toolResults.map((tr) => {
      const content = typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content);
      return { role: "tool", content, tool_call_id: tr.tool_use_id || "" };
    });
    // 若还有文本内容，作为额外的 user message 追加（tool message 之后）
    const text = textParts.join("\n");
    if (text) messages.push({ role: "user", content: text });
    return messages;
  }

  return [{ role: "user", content: textParts.join("\n") || "" }];
}

function claudeAssistantToOpenAI(msg: ClaudeMessage): OpenAIMessage {
  if (typeof msg.content === "string") {
    return { role: "assistant", content: msg.content };
  }

  const blocks = msg.content as ClaudeContentBlock[];
  const textParts = blocks.filter((b) => b.type === "text").map((b) => b.text || "");
  const toolUses = blocks.filter((b) => b.type === "tool_use");

  const openaiMsg: OpenAIMessage = {
    role: "assistant",
    content: textParts.join("\n") || null,
  };

  if (toolUses.length > 0) {
    openaiMsg.tool_calls = toolUses.map((tu) => ({
      id: tu.id || "",
      type: "function" as const,
      function: { name: tu.name || "", arguments: JSON.stringify(tu.input || {}) },
    }));
  }

  return openaiMsg;
}

// ============ OpenAI 响应 → Claude 响应（非流式） ============
export function openAIResponseToClaude(openaiResp: any, model: string): any {
  const choice = openaiResp.choices?.[0];
  const message = choice?.message || {};
  const content: any[] = [];

  // 文本内容
  if (message.content) {
    content.push({ type: "text", text: message.content });
  }

  // 工具调用 → tool_use blocks
  if (message.tool_calls?.length) {
    for (const tc of message.tool_calls) {
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function?.name,
        input: safeParseJSON(tc.function?.arguments),
      });
    }
  }

  const usage = openaiResp.usage || {};
  const stopReason = openAIToClaudeStopReason(choice?.finish_reason);

  return {
    id: openaiResp.id || `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    content,
    model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
    },
  };
}

function openAIToClaudeStopReason(reason: string | undefined): string {
  switch (reason) {
    case "stop": return "end_turn";
    case "length": return "max_tokens";
    case "tool_calls":
    case "function_call": return "tool_use";
    default: return "end_turn";
  }
}

// ============ OpenAI 流式 → Claude 流式（SSE 事件转换） ============
// 输入是 OpenAI 的 SSE chunk，输出对应的 Claude SSE 事件
export function createClaudeStreamConverter(model: string) {
  let messageStarted = false;
  let contentBlockStarted = false;
  let contentBlockIndex = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  return {
    // 处理一个 OpenAI chunk，返回 0 或多个 Claude SSE 事件字符串
    convertChunk(chunk: any): string[] {
      const events: string[] = [];
      const choice = chunk?.choices?.[0];
      const delta = choice?.delta || {};

      // 第一个 chunk：发送 message_start + content_block_start
      if (!messageStarted) {
        messageStarted = true;
        inputTokens = chunk?.usage?.prompt_tokens || 0;
        events.push(formatClaudeEvent("message_start", {
          type: "message_start",
          message: {
            id: chunk?.id || `msg_${Date.now()}`,
            type: "message",
            role: "assistant",
            content: [],
            model,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: inputTokens, output_tokens: 0 },
          },
        }));
      }

      // 文本 delta
      if (delta.content) {
        if (!contentBlockStarted) {
          contentBlockStarted = true;
          events.push(formatClaudeEvent("content_block_start", {
            type: "content_block_start",
            index: contentBlockIndex,
            content_block: { type: "text", text: "" },
          }));
        }
        events.push(formatClaudeEvent("content_block_delta", {
          type: "content_block_delta",
          index: contentBlockIndex,
          delta: { type: "text_delta", text: delta.content },
        }));
      }

      // 工具调用 delta
      if (delta.tool_calls?.length) {
        for (const tc of delta.tool_calls) {
          if (tc.id) {
            // 新工具调用开始：先关闭前一个 block
            if (contentBlockStarted) {
              events.push(formatClaudeEvent("content_block_stop", {
                type: "content_block_stop",
                index: contentBlockIndex,
              }));
              contentBlockIndex++;
            }
            contentBlockStarted = true;
            events.push(formatClaudeEvent("content_block_start", {
              type: "content_block_start",
              index: contentBlockIndex,
              content_block: { type: "tool_use", id: tc.id, name: tc.function?.name, input: {} },
            }));
          }
          if (tc.function?.arguments) {
            events.push(formatClaudeEvent("content_block_delta", {
              type: "content_block_delta",
              index: contentBlockIndex,
              delta: { type: "input_json_delta", partial_json: tc.function.arguments },
            }));
          }
        }
      }

      // finish_reason：关闭 block + message_delta + message_stop
      if (choice?.finish_reason) {
        outputTokens = chunk?.usage?.completion_tokens || 0;
        if (contentBlockStarted) {
          events.push(formatClaudeEvent("content_block_stop", {
            type: "content_block_stop",
            index: contentBlockIndex,
          }));
        }
        events.push(formatClaudeEvent("message_delta", {
          type: "message_delta",
          delta: { stop_reason: openAIToClaudeStopReason(choice.finish_reason), stop_sequence: null },
          usage: { output_tokens: outputTokens },
        }));
        events.push(formatClaudeEvent("message_stop", { type: "message_stop" }));
      }

      return events;
    },
  };
}

function formatClaudeEvent(eventType: string, data: any): string {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}

function safeParseJSON(str: string | undefined): any {
  if (!str) return {};
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}

// ============ OpenAI 错误 → Claude 错误格式 ============
export function openAIErrorToClaude(statusCode: number, message: string): any {
  return {
    type: "error",
    error: {
      type: statusCode === 402 ? "payment_required" : "api_error",
      message,
    },
  };
}

// ================================================================
// Responses API（/v1/responses，Codex 用的协议）
// 与 Chat Completions 的核心区别：
//   请求：input（字符串或数组）+ instructions（系统提示） vs messages
//   响应：output 数组（message 项含 output_text 块） vs choices
//   流式：response.created/output_text.delta/completed vs chat.completion.chunk
// ================================================================

export interface ResponsesRequest {
  [key: string]: unknown;
  model: string;
  input: string | ResponsesInputItem[];
  instructions?: string;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  tools?: any[];
  tool_choice?: any;
  reasoning?: { effort?: string };
  previous_response_id?: string;
  conversation?: unknown;
  // Codex 特有
  store?: boolean;
}

export interface ResponsesInputItem {
  type: "message" | "function_call" | "function_call_output";
  role?: "user" | "assistant" | "system" | "developer";
  content?: string | ResponsesContentBlock[];
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  output?: string;
}

export interface ResponsesContentBlock {
  type: "input_text" | "output_text" | "input_image" | "input_file";
  text?: string;
}

// ============ Responses 请求 → OpenAI Chat 请求 ============
export function responsesRequestToOpenAI(req: ResponsesRequest): OpenAIChatRequest {
  const messages: OpenAIMessage[] = [];

  // instructions → system message
  if (req.instructions) {
    messages.push({ role: "system", content: req.instructions });
  }

  // input → messages
  if (typeof req.input === "string") {
    messages.push({ role: "user", content: req.input });
  } else if (Array.isArray(req.input)) {
    for (const item of req.input) {
      if (item.type === "message") {
        const role = item.role === "developer" ? "system" : (item.role as any) || "user";
        const content = extractContentText(item.content);
        messages.push({ role, content });
      } else if (item.type === "function_call") {
        // 上一步的工具调用
        messages.push({
          role: "assistant",
          content: null,
          tool_calls: [{ id: item.call_id || item.id || "", type: "function", function: { name: item.name || "", arguments: item.arguments || "" } }],
        });
      } else if (item.type === "function_call_output") {
        messages.push({ role: "tool", content: item.output || "", tool_call_id: item.call_id || "" });
      }
    }
  }

  const openaiReq: OpenAIChatRequest = {
    model: req.model,
    messages,
    temperature: req.temperature,
    top_p: req.top_p,
    max_tokens: req.max_output_tokens,
    stream: req.stream,
    ...(req.stream && { stream_options: { include_usage: true } }),
  };

  // tools 转换（Responses 的 function tool → OpenAI function tool）
  if (req.tools?.length) {
    openaiReq.tools = req.tools
      .filter((t) => t.type === "function" || t.type === undefined)
      .map((t) => {
        const fn = t.function || t;
        return { type: "function" as const, function: { name: fn.name, description: fn.description, parameters: fn.parameters || fn.input_schema || {} } };
      });
  }

  return openaiReq;
}

function extractContentText(content: string | ResponsesContentBlock[] | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b) => b.type === "input_text" || b.type === "output_text").map((b) => b.text || "").join("\n");
}

// ============ OpenAI Chat 响应 → Responses 响应（非流式） ============
export function openAIResponseToResponses(openaiResp: any, model: string): any {
  const choice = openaiResp.choices?.[0];
  const message = choice?.message || {};
  const usage = openaiResp.usage || {};

  const output: any[] = [];
  // 文本内容 → message output item
  if (message.content) {
    output.push({
      type: "message",
      id: `msg_${Date.now()}`,
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: message.content }],
    });
  }
  // 工具调用 → function_call output items
  if (message.tool_calls?.length) {
    for (const tc of message.tool_calls) {
      output.push({
        type: "function_call",
        id: tc.id,
        call_id: tc.id,
        name: tc.function?.name,
        arguments: tc.function?.arguments || "",
      });
    }
  }

  const status = choice?.finish_reason === "length" ? "incomplete" : "completed";

  return {
    id: openaiResp.id || `resp_${Date.now()}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    model,
    output,
    usage: {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
      total_tokens: usage.total_tokens || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
    },
  };
}

// ============ OpenAI 流式 → Responses 流式（SSE 事件转换） ============
export function createResponsesStreamConverter(model: string) {
  let responseCreated = false;
  let messageStarted = false;
  let inputTokens = 0;
  let outputTokens = 0;
  const responseId = `resp_${Date.now()}`;

  return {
    convertChunk(chunk: any): string[] {
      const events: string[] = [];
      const choice = chunk?.choices?.[0];
      const delta = choice?.delta || {};

      // 第一个 chunk：response.created
      if (!responseCreated) {
        responseCreated = true;
        inputTokens = chunk?.usage?.prompt_tokens || 0;
        events.push(formatResponsesEvent("response.created", {
          type: "response.created",
          response: {
            id: responseId,
            object: "response",
            created_at: Math.floor(Date.now() / 1000),
            status: "in_progress",
            model,
            output: [],
          },
        }));
      }

      // 文本 delta → response.output_text.delta
      if (delta.content) {
        if (!messageStarted) {
          messageStarted = true;
          events.push(formatResponsesEvent("response.output_item.added", {
            type: "response.output_item.added",
            output_index: 0,
            item: { type: "message", id: `msg_${Date.now()}`, status: "in_progress", role: "assistant", content: [] },
          }));
          events.push(formatResponsesEvent("response.content_part.added", {
            type: "response.content_part.added",
            item_id: `msg_${Date.now()}`,
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: "" },
          }));
        }
        events.push(formatResponsesEvent("response.output_text.delta", {
          type: "response.output_text.delta",
          item_id: `msg_${Date.now()}`,
          output_index: 0,
          content_index: 0,
          delta: delta.content,
        }));
      }

      // 工具调用 delta → response.function_call_arguments.delta
      if (delta.tool_calls?.length) {
        for (const tc of delta.tool_calls) {
          if (tc.id) {
            events.push(formatResponsesEvent("response.output_item.added", {
              type: "response.output_item.added",
              output_index: 1,
              item: { type: "function_call", id: tc.id, call_id: tc.id, name: tc.function?.name, arguments: "" },
            }));
          }
          if (tc.function?.arguments) {
            events.push(formatResponsesEvent("response.function_call_arguments.delta", {
              type: "response.function_call_arguments.delta",
              item_id: tc.id,
              output_index: 1,
              delta: tc.function.arguments,
            }));
          }
        }
      }

      // finish → response.completed
      if (choice?.finish_reason) {
        outputTokens = chunk?.usage?.completion_tokens || 0;
        if (messageStarted) {
          events.push(formatResponsesEvent("response.output_text.done", {
            type: "response.output_text.done",
            output_index: 0,
            content_index: 0,
            text: "",
          }));
          events.push(formatResponsesEvent("response.output_item.done", {
            type: "response.output_item.done",
            output_index: 0,
            item: { type: "message", id: `msg_${Date.now()}`, status: "completed", role: "assistant", content: [{ type: "output_text", text: "" }] },
          }));
        }
        events.push(formatResponsesEvent("response.completed", {
          type: "response.completed",
          response: {
            id: responseId,
            object: "response",
            status: choice.finish_reason === "length" ? "incomplete" : "completed",
            model,
            output: [],
            usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
          },
        }));
      }

      return events;
    },
  };
}

function formatResponsesEvent(eventType: string, data: any): string {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}

// ================================================================
// 反向转换：补全转换矩阵
// ================================================================

// ============ OpenAI Chat 请求 → Claude 请求 ============
// 当用户用 OpenAI SDK 调，但上游通道是 Anthropic 时
export function openAIRequestToClaude(req: OpenAIChatRequest): ClaudeRequest {
  const messages: ClaudeMessage[] = [];
  let system: string | undefined;

  for (const msg of req.messages) {
    if (msg.role === "system") {
      system = (system ? system + "\n" : "") + (msg.content || "");
    } else if (msg.role === "user") {
      messages.push({ role: "user", content: msg.content || "" });
    } else if (msg.role === "assistant") {
      const blocks: ClaudeContentBlock[] = [];
      if (msg.content) blocks.push({ type: "text", text: msg.content });
      if (msg.tool_calls?.length) {
        for (const tc of msg.tool_calls) {
          blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input: safeParseJSON(tc.function.arguments) });
        }
      }
      messages.push({ role: "assistant", content: blocks.length ? blocks : "" });
    } else if (msg.role === "tool") {
      messages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: msg.tool_call_id || "", content: msg.content || "" }],
      });
    }
  }

  const claudeReq: ClaudeRequest = {
    model: req.model,
    messages,
    max_tokens: req.max_tokens || 4096,
    temperature: req.temperature,
    top_p: req.top_p,
    stream: req.stream,
    stop_sequences: req.stop ? (Array.isArray(req.stop) ? req.stop : [req.stop]) : undefined,
  };
  if (system) claudeReq.system = system;

  // tools 转换
  if (req.tools?.length) {
    claudeReq.tools = req.tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
    }));
  }
  // tool_choice
  if (req.tool_choice) {
    if (req.tool_choice === "auto") claudeReq.tool_choice = { type: "auto" };
    else if (req.tool_choice === "required") claudeReq.tool_choice = { type: "any" };
    else if (typeof req.tool_choice === "object") claudeReq.tool_choice = { type: "tool", name: req.tool_choice.function.name };
  }

  return claudeReq;
}

// ============ Claude 响应 → OpenAI Chat 响应（非流式） ============
// 当用户用 OpenAI SDK 调，上游返回 Claude 格式时
export function claudeResponseToOpenAI(claudeResp: any, model: string): any {
  const content = claudeResp.content || [];
  const textParts = content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
  const toolUses = content.filter((b: any) => b.type === "tool_use");

  const message: any = { role: "assistant", content: textParts || null };
  if (toolUses.length) {
    message.tool_calls = toolUses.map((tu: any) => ({
      id: tu.id,
      type: "function",
      function: { name: tu.name, arguments: JSON.stringify(tu.input || {}) },
    }));
  }

  const finishReason = claudeToOpenAIStopReason(claudeResp.stop_reason);

  return {
    id: claudeResp.id || `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: {
      prompt_tokens: claudeResp.usage?.input_tokens || 0,
      completion_tokens: claudeResp.usage?.output_tokens || 0,
      total_tokens: (claudeResp.usage?.input_tokens || 0) + (claudeResp.usage?.output_tokens || 0),
    },
  };
}

function claudeToOpenAIStopReason(reason: string | undefined): string {
  switch (reason) {
    case "end_turn": return "stop";
    case "max_tokens": return "length";
    case "tool_use": return "tool_calls";
    default: return "stop";
  }
}

// ============ Claude 流式 → OpenAI 流式（SSE 事件转换） ============
export function createOpenAIStreamFromClaude(model: string) {
  let messageStarted = false;
  let inputTokens = 0;
  let outputTokens = 0;

  return {
    convertEvent(eventType: string, data: any): string[] {
      const events: string[] = [];

      if (eventType === "message_start") {
        messageStarted = true;
        inputTokens = data?.message?.usage?.input_tokens || 0;
        events.push(`data: ${JSON.stringify({
          id: data?.message?.id || `chatcmpl-${Date.now()}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
        })}\n\n`);
      } else if (eventType === "content_block_start") {
        // tool_use 块首部携带 id/name:补发 OpenAI 风格的首个 tool_calls chunk,
        // 否则流式消费方只能拿到 input_json_delta 的参数碎片,无法还原调用身份。
        const block = data?.content_block;
        if (block?.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
          events.push(`data: ${JSON.stringify({
            id: `chatcmpl-${Date.now()}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: { tool_calls: [{ index: data.index, id: block.id, type: "function", function: { name: block.name, arguments: "" } }] }, finish_reason: null }],
          })}\n\n`);
        }
      } else if (eventType === "content_block_delta") {
        if (data?.delta?.type === "text_delta") {
          events.push(`data: ${JSON.stringify({
            id: `chatcmpl-${Date.now()}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: { content: data.delta.text }, finish_reason: null }],
          })}\n\n`);
        } else if (data?.delta?.type === "input_json_delta") {
          events.push(`data: ${JSON.stringify({
            id: `chatcmpl-${Date.now()}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: { tool_calls: [{ index: data.index, function: { arguments: data.delta.partial_json } }] }, finish_reason: null }],
          })}\n\n`);
        }
      } else if (eventType === "message_delta") {
        outputTokens = data?.usage?.output_tokens || 0;
        events.push(`data: ${JSON.stringify({
          id: `chatcmpl-${Date.now()}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: {}, finish_reason: claudeToOpenAIStopReason(data?.delta?.stop_reason) }],
          usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
        })}\n\n`);
      } else if (eventType === "message_stop") {
        events.push("data: [DONE]\n\n");
      }

      return events;
    },
  };
}

// ============ OpenAI Chat 请求 → Responses 请求 ============
export function openAIRequestToResponses(req: OpenAIChatRequest): ResponsesRequest {
  const input: ResponsesInputItem[] = [];
  let instructions: string | undefined;

  for (const msg of req.messages) {
    if (msg.role === "system" || (msg.role as string) === "developer") {
      instructions = (instructions ? instructions + "\n" : "") + (msg.content || "");
    } else {
      input.push({
        type: "message",
        role: msg.role as any,
        content: msg.content || "",
      });
    }
  }

  return {
    model: req.model,
    input,
    instructions,
    stream: req.stream,
    temperature: req.temperature,
    top_p: req.top_p,
    max_output_tokens: req.max_tokens,
  };
}

// ============ Responses 响应 → OpenAI Chat 响应 ============
export function responsesResponseToOpenAI(resp: any, model: string): any {
  const output = resp.output || [];
  const messageItem = output.find((o: any) => o.type === "message");
  const text = messageItem?.content?.find((c: any) => c.type === "output_text")?.text || "";
  const toolCalls = output.filter((o: any) => o.type === "function_call");

  const message: any = { role: "assistant", content: text || null };
  if (toolCalls.length) {
    message.tool_calls = toolCalls.map((tc: any) => ({
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: tc.arguments || "" },
    }));
  }

  return {
    id: resp.id || `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: toolCalls.length ? "tool_calls" : "stop" }],
    usage: {
      prompt_tokens: resp.usage?.input_tokens || 0,
      completion_tokens: resp.usage?.output_tokens || 0,
      total_tokens: resp.usage?.total_tokens || 0,
    },
  };
}

// ============ Claude 请求 → Responses 请求 ============
export function claudeRequestToResponses(req: ClaudeRequest): ResponsesRequest {
  const openaiReq = claudeRequestToOpenAI(req);
  return openAIRequestToResponses(openaiReq);
}

// ============ Responses 请求 → Claude 请求 ============
export function responsesRequestToClaude(req: ResponsesRequest): ClaudeRequest {
  const openaiReq = responsesRequestToOpenAI(req);
  return openAIRequestToClaude(openaiReq);
}

// ============ Responses 响应 → Claude 响应 ============
export function responsesResponseToClaude(resp: any, model: string): any {
  const openaiResp = responsesResponseToOpenAI(resp, model);
  return openAIResponseToClaude(openaiResp, model);
}

// ============ Claude 响应 → Responses 响应 ============
export function claudeResponseToResponses(claudeResp: any, model: string): any {
  const openaiResp = claudeResponseToOpenAI(claudeResp, model);
  return openAIResponseToResponses(openaiResp, model);
}

// ================================================================
// Gemini 协议（/v1beta/models/*）
// ================================================================

export interface GeminiRequest {
  contents: GeminiContent[];
  systemInstruction?: { parts: { text: string }[] };
  generationConfig?: {
    temperature?: number;
    topP?: number;
    maxOutputTokens?: number;
    stopSequences?: string[];
  };
  tools?: GeminiTool[];
}

export interface GeminiContent {
  role: "user" | "model" | "function";
  parts: GeminiPart[];
}

export interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: any };
  functionResponse?: { name: string; response: any };
}

export interface GeminiTool {
  functionDeclarations: Array<{ name: string; description?: string; parameters?: any }>;
}

// OpenAI Chat 请求 → Gemini 请求
export function openAIRequestToGemini(req: OpenAIChatRequest): GeminiRequest {
  const contents: GeminiContent[] = [];
  let systemInstruction: { parts: { text: string }[] } | undefined;
  // Gemini 的 functionResponse.name 必须是函数名（与 functionCall.name 对应），
  // 而 OpenAI tool message 只带 tool_call_id，需要从之前的 tool_calls 建立映射
  const toolCallIdToName = new Map<string, string>();

  for (const msg of req.messages) {
    if (msg.role === "system") {
      systemInstruction = { parts: [{ text: msg.content || "" }] };
    } else if (msg.role === "user") {
      contents.push({ role: "user", parts: [{ text: msg.content || "" }] });
    } else if (msg.role === "assistant") {
      const parts: GeminiPart[] = [];
      if (msg.content) parts.push({ text: msg.content });
      if (msg.tool_calls?.length) {
        for (const tc of msg.tool_calls) {
          if (tc.id && tc.function.name) toolCallIdToName.set(tc.id, tc.function.name);
          parts.push({ functionCall: { name: tc.function.name, args: safeParseJSON(tc.function.arguments) } });
        }
      }
      contents.push({ role: "model", parts: parts.length ? parts : [{ text: "" }] });
    } else if (msg.role === "tool") {
      const fnName = (msg.tool_call_id && toolCallIdToName.get(msg.tool_call_id)) || msg.tool_call_id || "";
      contents.push({ role: "function", parts: [{ functionResponse: { name: fnName, response: { result: msg.content } } }] });
    }
  }

  const geminiReq: GeminiRequest = {
    contents,
    generationConfig: {
      temperature: req.temperature,
      topP: req.top_p,
      maxOutputTokens: req.max_tokens,
      stopSequences: req.stop ? (Array.isArray(req.stop) ? req.stop : [req.stop]) : undefined,
    },
  };
  if (systemInstruction) geminiReq.systemInstruction = systemInstruction;

  if (req.tools?.length) {
    geminiReq.tools = [{
      functionDeclarations: req.tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      })),
    }];
  }

  return geminiReq;
}

// Gemini 响应 → OpenAI Chat 响应
export function geminiResponseToOpenAI(geminiResp: any, model: string): any {
  const candidates = geminiResp.candidates || [];
  const candidate = candidates[0] || {};
  const parts = candidate.content?.parts || [];
  const textParts = parts.filter((p: any) => p.text).map((p: any) => p.text).join("\n");
  const functionCalls = parts.filter((p: any) => p.functionCall);

  const message: any = { role: "assistant", content: textParts || null };
  if (functionCalls.length) {
    message.tool_calls = functionCalls.map((fc: any, i: number) => ({
      id: `call_${i}`,
      type: "function",
      function: { name: fc.functionCall.name, arguments: JSON.stringify(fc.functionCall.args || {}) },
    }));
  }

  const finishReason = candidate.finishReason === "MAX_TOKENS" ? "length" : functionCalls.length ? "tool_calls" : "stop";

  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: {
      prompt_tokens: geminiResp.usageMetadata?.promptTokenCount || 0,
      completion_tokens: geminiResp.usageMetadata?.candidatesTokenCount || 0,
      total_tokens: geminiResp.usageMetadata?.totalTokenCount || 0,
    },
  };
}

// Gemini 流式 → OpenAI 流式
export function createOpenAIStreamFromGemini(model: string) {
  let inputTokens = 0;
  let outputTokens = 0;

  return {
    convertChunk(chunk: any): string[] {
      const events: string[] = [];
      const candidates = chunk?.candidates || [];
      const candidate = candidates[0];
      if (!candidate) return events;

      const parts = candidate.content?.parts || [];
      for (const part of parts) {
        if (part.text) {
          events.push(`data: ${JSON.stringify({
            id: `chatcmpl-${Date.now()}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: { content: part.text }, finish_reason: null }],
          })}\n\n`);
        }
        if (part.functionCall) {
          events.push(`data: ${JSON.stringify({
            id: `chatcmpl-${Date.now()}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args || {}) } }] }, finish_reason: null }],
          })}\n\n`);
        }
      }

      if (candidate.finishReason && candidate.finishReason !== "FINISH_REASON_UNSPECIFIED") {
        inputTokens = chunk?.usageMetadata?.promptTokenCount || inputTokens;
        outputTokens = chunk?.usageMetadata?.candidatesTokenCount || outputTokens;
        const finishReason = candidate.finishReason === "MAX_TOKENS" ? "length" : "stop";
        events.push(`data: ${JSON.stringify({
          id: `chatcmpl-${Date.now()}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
          usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
        })}\n\n`);
        events.push("data: [DONE]\n\n");
      }

      return events;
    },
  };
}

// ================================================================
// Thinking-to-content：思考内容转正文
// ================================================================

// 将 OpenAI/Claude 响应中的 reasoning_content / thinking 内容合并到正文
export function thinkingToContent(resp: any): any {
  const choices = resp?.choices || [];
  for (const choice of choices) {
    const msg = choice?.message;
    if (!msg) continue;
    // OpenAI 风格的 reasoning_content
    if (msg.reasoning_content) {
      msg.content = (msg.content || "") + "\n\n" + msg.reasoning_content;
      delete msg.reasoning_content;
    }
  }
  // Claude 风格的 thinking content block
  if (Array.isArray(resp?.content)) {
    const thinkingBlocks = resp.content.filter((b: any) => b.type === "thinking");
    const textBlocks = resp.content.filter((b: any) => b.type === "text");
    const mergedText = [...thinkingBlocks.map((b: any) => b.thinking || b.text || ""), ...textBlocks.map((b: any) => b.text || "")].filter(Boolean).join("\n\n");
    if (thinkingBlocks.length) {
      resp.content = [{ type: "text", text: mergedText }];
    }
  }
  return resp;
}

// 流式 thinking-to-content：把 reasoning_content delta 转成 content delta
export function wrapStreamForThinkingToContent(): (chunk: any) => any {
  return (chunk: any) => {
    const choices = chunk?.choices;
    if (!Array.isArray(choices)) return chunk;
    for (const choice of choices) {
      const delta = choice?.delta;
      if (!delta) continue;
      if (delta.reasoning_content) {
        delta.content = (delta.content || "") + delta.reasoning_content;
        delete delta.reasoning_content;
      }
    }
    return chunk;
  };
}

// ================================================================
// Reasoning Effort 后缀解析
// o3-mini-high → { model: "o3-mini", reasoningEffort: "high" }
// gpt-5-low → { model: "gpt-5", reasoningEffort: "low" }
// claude-3-7-sonnet-thinking → { model: "claude-3-7-sonnet", thinking: true }
// gemini-2.5-flash-thinking → { model: "gemini-2.5-flash", thinking: true }
// ================================================================
export function parseReasoningEffort(model: string): {
  model: string;
  reasoningEffort?: string;
  thinking?: boolean;
  thinkingBudget?: number;
} {
  // o3-mini-high / gpt-5-high / gpt-5-medium / gpt-5-low
  const effortMatch = model.match(/^(.+)-(high|medium|low)$/);
  if (effortMatch && /^(o\d|gpt-\d)/.test(effortMatch[1])) {
    return { model: effortMatch[1], reasoningEffort: effortMatch[2] };
  }

  // claude-*-thinking
  if (model.endsWith("-thinking")) {
    return { model: model.slice(0, -"-thinking".length), thinking: true };
  }

  // gemini-*-thinking-128（带 token 预算）
  const geminiThinkingMatch = model.match(/^(.+)-thinking-(\d+)$/);
  if (geminiThinkingMatch) {
    return { model: geminiThinkingMatch[1], thinking: true, thinkingBudget: Number(geminiThinkingMatch[2]) };
  }

  // gemini-*-thinking
  if (model.includes("-thinking")) {
    const base = model.split("-thinking")[0];
    return { model: base, thinking: true };
  }

  return { model };
}
