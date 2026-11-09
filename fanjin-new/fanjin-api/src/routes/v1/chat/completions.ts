// OpenAI 兼容的 chat/completions 中转端点。
// 支持流式（stream: true，SSE）和非流式两种模式。
// 通过 API Key 鉴权（需 relay:text 权限），按输入/输出/缓存分价扣费。
import express from "express";
import { apiKeyAuth } from "@/middleware/apiKeyAuth";
import { executeRelayChat, RelayChatError, type RelayChatRequest } from "@/lib/relayChat";
import { resolveRelayPrincipalId, resolveRelayWorkspaceId } from "@/lib/relayUtils";
import { BillingError } from "@/lib/billing";
import { pipeRelayWebStreamToResponse } from "@/lib/relayStreamResponse";

const router = express.Router();

export default router.post("/", apiKeyAuth({ optional: true, permission: "relay:text", reserveRequestQuota: true }), async (req, res) => {
  const body = req.body ?? {};
  const model = typeof body.model === "string" ? body.model : "";
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!model) return res.status(400).send({ error: { message: "model is required", type: "invalid_request_error" } });
  if (messages.length === 0) return res.status(400).send({ error: { message: "messages is required and must be non-empty", type: "invalid_request_error" } });
  if (body.stream !== undefined && typeof body.stream !== "boolean") {
    return res.status(400).send({ error: { message: "stream must be a boolean", type: "invalid_request_error" } });
  }

  const apiKey = (req as any).apiKey;
  const auth = (req as any).auth;
  const workspaceId = resolveRelayWorkspaceId(req);
  if (!apiKey && !workspaceId) return res.status(403).send({ error: { message: "缺少工作区上下文", type: "authentication_error" } });
  const idempotencyKey = String(req.header("idempotency-key") || "").trim();
  if (idempotencyKey && !/^[A-Za-z0-9_.:-]{1,128}$/.test(idempotencyKey)) {
    return res.status(400).send({ error: { message: "Idempotency-Key 格式无效", type: "invalid_request_error" } });
  }

  // Keep the OpenAI request surface intact.  The relay layer validates the
  // fields it needs for billing, then forwards the remaining protocol fields
  // (tools, response_format, stream_options, reasoning options, and vendor
  // extensions) to compatible upstreams instead of silently discarding them.
  const chatRequest: RelayChatRequest = {
    ...body,
    model,
    messages,
    stream: body.stream === true,
  };

  try {
    const result = await executeRelayChat(chatRequest, {
      workspaceId: workspaceId!,
      apiKeyId: apiKey?.id ?? null,
      principalId: resolveRelayPrincipalId(req),
      requestId: String((req as any).requestId || req.header("x-request-id") || "").trim() || null,
      idempotencyKey: idempotencyKey || null,
    });

    if (result.stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      // Native Responses may emit reasoning/lifecycle events long before any
      // chat delta. Keep the downstream alive even when the converter has no
      // user-visible text to forward, without inventing content or retrying.
      pipeRelayWebStreamToResponse({
        stream: result.stream,
        res,
        sseHeartbeat: true,
        clientDisconnectMessage: "客户端在响应流结束前断开连接",
        onErrorBeforeHeaders: (error) => {
          const status = error instanceof BillingError
            ? error.status
            : error instanceof RelayChatError ? error.statusCode : 502;
          res.status(status).json({ error: { message: error.message, type: "api_error" } });
        },
      });
      return;
    }

    res.status(200).json(result.response);
  } catch (err: any) {
    if (err instanceof RelayChatError || err instanceof BillingError) {
      const status = err instanceof RelayChatError ? err.statusCode : err.status;
      const type = status === 402 ? "insufficient_quota" : status === 409 ? "idempotency_conflict" : "api_error";
      res.status(status).send({ error: { message: err.message, type } });
      return;
    }
    console.error("[relay-chat] error:", err);
    res.status(500).send({ error: { message: err?.message || "internal error", type: "server_error" } });
  }
});
