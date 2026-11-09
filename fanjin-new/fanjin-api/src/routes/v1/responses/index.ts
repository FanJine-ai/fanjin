// OpenAI Responses 协议中转端点 /v1/responses（Codex CLI 用的协议）
// 自动识别上游通道：Codex 通道直通（ChatGPT 后端），OpenAI 通道按配置直通或转换。
import express from "express";
import { apiKeyAuth } from "@/middleware/apiKeyAuth";
import { executeRelayResponses, RelayResponsesError } from "@/lib/relayResponses";
import { BillingError } from "@/lib/billing";
import { resolveRelayPrincipalId, resolveRelayWorkspaceId } from "@/lib/relayUtils";
import { pipeRelayWebStreamToResponse } from "@/lib/relayStreamResponse";
import {
  proxyStoredNativeResponse,
  ResponsesResourceError,
  type StoredResponsesRequestContext,
} from "@/lib/responsesResourceBinding";
import type { ResponsesRequest } from "@/lib/protocolConverter";
import { VolcanoFileError } from "@/lib/volcanoFileProxy";

const router = express.Router();
const responsesResourceAuth = apiKeyAuth({ optional: true, permission: "relay:text" });
const INTERNAL_RESPONSES_FIELDS = new Set([
  "workspaceId", "workspace_id", "projectId", "project_id",
  "provider", "providerId", "provider_id", "channel", "channelId", "channel_id",
  "apiKey", "api_key", "apiKeyId", "api_key_id", "credential", "credentialRef", "credential_ref",
  "baseUrl", "base_url", "endpointType", "endpoint_type",
  "requestId", "request_id", "idempotencyKey", "idempotency_key",
  "principalId", "principal_id", "authorization", "headers",
  "callback_url", "callbackUrl", "callback_secret", "callbackSecret",
  "webhook_url", "webhookUrl", "webhook_secret", "webhookSecret",
].map((key) => key.toLowerCase()));

function responsesProtocolBody(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(body).filter(([key]) => !INTERNAL_RESPONSES_FIELDS.has(key.toLowerCase())),
  );
}

function readResponsesResourceContext(req: express.Request): StoredResponsesRequestContext | null {
  const apiKey = (req as any).apiKey;
  const workspaceId = resolveRelayWorkspaceId(req);
  const principalId = resolveRelayPrincipalId(req);
  if (!workspaceId || (!apiKey?.id && !principalId)) return null;
  return {
    workspaceId,
    apiKeyId: apiKey?.id ?? null,
    principalId,
    requestId: String((req as any).requestId || req.header("x-request-id") || "").trim() || null,
    idempotencyKey: String(req.header("idempotency-key") || "").trim() || null,
  };
}

function sendResponsesResourceError(res: express.Response, error: unknown) {
  if (error instanceof ResponsesResourceError) {
    return res.status(error.statusCode).send({
      code: error.code,
      error: { message: error.message, type: error.code, code: error.code },
    });
  }
  return res.status(500).send({ error: { message: "internal error", type: "server_error" } });
}

async function handleStoredResponseRequest(
  req: express.Request,
  res: express.Response,
  action: "retrieve" | "delete" | "input_items",
) {
  const context = readResponsesResourceContext(req);
  if (!context) {
    return res.status(403).send({ error: { message: "缺少工作区或调用主体上下文", type: "authentication_error" } });
  }
  if (context.idempotencyKey && !/^[A-Za-z0-9_.:-]{1,128}$/.test(context.idempotencyKey)) {
    return res.status(400).send({ error: { message: "Idempotency-Key 格式无效", type: "invalid_request_error" } });
  }
  try {
    const result = await proxyStoredNativeResponse({
      responseId: String(req.params.id || ""),
      action,
      owner: context,
      query: req.query as Record<string, unknown>,
    });
    res.status(result.statusCode);
    if (!result.body) return res.end();
    res.setHeader("Content-Type", result.contentType);
    return typeof result.body === "string" ? res.send(result.body) : res.send(result.body);
  } catch (error) {
    return sendResponsesResourceError(res, error);
  }
}

router.post("/", apiKeyAuth({ optional: true, permission: "relay:text", reserveRequestQuota: true }), async (req, res) => {
  const body = req.body ?? {};
  const model = typeof body.model === "string" ? body.model : "";
  if (!model) return res.status(400).send({ error: { message: "model is required", type: "invalid_request_error" } });
  if (body.input === undefined) return res.status(400).send({ error: { message: "input is required", type: "invalid_request_error" } });

  const apiKey = (req as any).apiKey;
  const workspaceId = resolveRelayWorkspaceId(req);
  if (!apiKey && !workspaceId) return res.status(403).send({ error: { message: "缺少工作区上下文", type: "authentication_error" } });
  const idempotencyKey = String(req.header("idempotency-key") || "").trim();
  if (idempotencyKey && !/^[A-Za-z0-9_.:-]{1,128}$/.test(idempotencyKey)) {
    return res.status(400).send({ error: { message: "Idempotency-Key 格式无效", type: "invalid_request_error" } });
  }

  // Volcano Ark exposes native Responses extensions (for example thinking,
  // caching, text and service_tier). Preserve the client protocol payload and
  // remove Fanjin routing, identity, callback and credential fields; the relay
  // replaces model with the configured upstream mapping after channel selection.
  const protocolBody = responsesProtocolBody(body);
  const responsesRequest: ResponsesRequest = {
    ...protocolBody,
    model,
    input: body.input,
    stream: body.stream === true,
  };

  try {
    const result = await executeRelayResponses(responsesRequest, {
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
      pipeRelayWebStreamToResponse({
        stream: result.stream,
        res,
        sseHeartbeat: true,
        clientDisconnectMessage: "Responses 客户端在响应流结束前断开连接",
        onErrorBeforeHeaders: (streamError) => {
          const status = streamError instanceof BillingError
            ? streamError.status
            : streamError instanceof RelayResponsesError
              ? streamError.statusCode
              : 502;
          res.status(status).send({
            error: { message: streamError.message || "Responses stream error", type: "api_error" },
          });
        },
      });
      return;
    }

    res.json(result.response);
  } catch (err: any) {
    if (err instanceof BillingError) {
      return res.status(err.status).send({ error: { message: err.message, type: "billing_error" } });
    }
    if (err instanceof RelayResponsesError) {
      return res.status(err.statusCode).send({
        code: err.code,
        error: { message: err.message, type: err.code, code: err.code },
      });
    }
    if (err instanceof ResponsesResourceError) {
      return sendResponsesResourceError(res, err);
    }
    if (err instanceof VolcanoFileError) {
      return res.status(err.statusCode).send({
        code: err.code,
        error: { message: err.message, type: err.code, code: err.code },
      });
    }
    return res.status(500).send({ error: { message: "internal error", type: "server_error" } });
  }
});

router.get("/:id/input_items", responsesResourceAuth, async (req, res) => {
  return handleStoredResponseRequest(req, res, "input_items");
});

router.get("/:id", responsesResourceAuth, async (req, res) => {
  return handleStoredResponseRequest(req, res, "retrieve");
});

router.delete("/:id", responsesResourceAuth, async (req, res) => {
  return handleStoredResponseRequest(req, res, "delete");
});

export default router;
