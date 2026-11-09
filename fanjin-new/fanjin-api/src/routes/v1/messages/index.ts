// Claude / Anthropic 协议中转端点 /v1/messages
// 自动识别上游通道类型：Anthropic 通道直通，OpenAI 兼容通道自动转换。
import express from "express";
import { apiKeyAuth } from "@/middleware/apiKeyAuth";
import { executeRelayMessages, RelayMessagesError } from "@/lib/relayMessages";
import { BillingError } from "@/lib/billing";
import { resolveRelayPrincipalId, resolveRelayWorkspaceId } from "@/lib/relayUtils";
import { pipeRelayWebStreamToResponse } from "@/lib/relayStreamResponse";
import { openAIErrorToClaude, type ClaudeRequest } from "@/lib/protocolConverter";

const router = express.Router();

function sendClaudeError(res: express.Response, statusCode: number, message: string) {
  res.status(statusCode).send(openAIErrorToClaude(statusCode, message));
}

router.post("/", apiKeyAuth({ optional: true, permission: "relay:text", reserveRequestQuota: true }), async (req, res) => {
  const body = req.body ?? {};
  const model = typeof body.model === "string" ? body.model : "";
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!model) return sendClaudeError(res, 400, "model is required");
  if (messages.length === 0) return sendClaudeError(res, 400, "messages is required and must be non-empty");

  const apiKey = (req as any).apiKey;
  const workspaceId = resolveRelayWorkspaceId(req);
  if (!apiKey && !workspaceId) return sendClaudeError(res, 403, "缺少工作区上下文");
  const idempotencyKey = String(req.header("idempotency-key") || "").trim();
  if (idempotencyKey && !/^[A-Za-z0-9_.:-]{1,128}$/.test(idempotencyKey)) {
    return sendClaudeError(res, 400, "Idempotency-Key 格式无效");
  }

  const claudeRequest: ClaudeRequest = {
    model,
    messages,
    system: body.system,
    max_tokens: body.max_tokens ?? 4096,
    temperature: body.temperature,
    top_p: body.top_p,
    top_k: body.top_k,
    stream: body.stream === true,
    stop_sequences: body.stop_sequences,
    tools: body.tools,
    tool_choice: body.tool_choice,
    thinking: body.thinking,
  };

  try {
    const result = await executeRelayMessages(claudeRequest, {
      workspaceId: workspaceId!,
      apiKeyId: apiKey?.id ?? null,
      principalId: resolveRelayPrincipalId(req),
      requestId: String((req as any).requestId || req.header("x-request-id") || "").trim() || null,
      idempotencyKey: idempotencyKey || null,
    });

    if (result.stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      pipeRelayWebStreamToResponse({
        stream: result.stream,
        res,
        clientDisconnectMessage: "Messages 客户端在响应流结束前断开连接",
        onErrorBeforeHeaders: (streamError) => {
          const status = streamError instanceof BillingError
            ? streamError.status
            : streamError instanceof RelayMessagesError
              ? streamError.statusCode
              : 502;
          sendClaudeError(res, status, streamError.message || "Messages stream error");
        },
      });
      return;
    }

    res.json(result.response);
  } catch (err: any) {
    if (err instanceof BillingError) {
      return sendClaudeError(res, err.status, err.message);
    }
    if (err instanceof RelayMessagesError) {
      return sendClaudeError(res, err.statusCode, err.message);
    }
    return sendClaudeError(res, 500, err?.message || "internal error");
  }
});

export default router;
