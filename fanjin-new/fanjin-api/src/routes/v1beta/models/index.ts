// /v1beta/models/:model:generateContent — Gemini 协议中转端点
import express from "express";
import { Readable } from "node:stream";
import { apiKeyAuth } from "@/middleware/apiKeyAuth";
import { executeGeminiDirect, RelayGeminiError } from "@/lib/relayGemini";
import { BillingError } from "@/lib/billing";
import { resolveRelayWorkspaceId } from "@/lib/relayUtils";

const router = express.Router();


// 匹配 /v1beta/models/:model:generateContent 和 :streamGenerateContent
router.post("/:model\\::action", apiKeyAuth({ optional: true, permission: "relay:text", reserveRequestQuota: true }), async (req, res) => {
  const model = String(req.params.model || "");
  const action = String(req.params.action || "");
  if (!model) return res.status(400).json({ error: { message: "model is required" } });
  if (action !== "generateContent" && action !== "streamGenerateContent") {
    return res.status(400).json({ error: { message: "action must be generateContent or streamGenerateContent" } });
  }
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    return res.status(400).json({ error: { message: "request body must be an object" } });
  }
  if (!Array.isArray(req.body.contents) || req.body.contents.length === 0) {
    return res.status(400).json({ error: { message: "contents is required and must be non-empty" } });
  }

  const isStream = action === "streamGenerateContent";
  const workspaceId = resolveRelayWorkspaceId(req);
  const apiKey = (req as any).apiKey;
  const auth = (req as any).auth;
  if (!apiKey && !workspaceId) return res.status(403).json({ error: { message: "缺少工作区上下文" } });
  const requestId = String((req as any).requestId || req.header("x-request-id") || "").trim();
  const idempotencyKey = String(req.header("idempotency-key") || "").trim();
  const identityPattern = /^[A-Za-z0-9_.:-]{1,128}$/;
  if (requestId && !identityPattern.test(requestId)) {
    return res.status(400).json({ error: { message: "X-Request-Id 格式无效" } });
  }
  if (idempotencyKey && !identityPattern.test(idempotencyKey)) {
    return res.status(400).json({ error: { message: "Idempotency-Key 格式无效" } });
  }

  try {
    const result = await executeGeminiDirect(model, req.body, isStream, {
      workspaceId: workspaceId!,
      apiKeyId: apiKey?.id ?? null,
      principalId: auth?.user?.id == null ? null : String(auth.user.id),
      requestId: requestId || null,
      idempotencyKey: idempotencyKey || null,
    });
    if (result.stream) {
      res.setHeader("Content-Type", "application/x-ndjson");
      const nodeStream = Readable.fromWeb(result.stream as any);
      let responseFinished = false;
      res.once("finish", () => {
        responseFinished = true;
      });
      res.once("close", () => {
        if (!responseFinished && !nodeStream.destroyed) {
          nodeStream.destroy(new Error("Gemini 客户端在响应流结束前断开连接"));
        }
      });
      nodeStream.once("error", (streamError: any) => {
        if (!res.headersSent) {
          const status = streamError instanceof BillingError
            ? streamError.status
            : streamError instanceof RelayGeminiError
              ? streamError.statusCode
              : 502;
          res.status(status).json({ error: { message: streamError?.message || "Gemini stream error" } });
        } else if (!res.destroyed) {
          res.destroy(streamError);
        }
      });
      nodeStream.pipe(res);
      return;
    }
    res.json(result.response);
  } catch (err: any) {
    if (err instanceof BillingError) return res.status(err.status).json({ error: { message: err.message } });
    if (err instanceof RelayGeminiError) return res.status(err.statusCode).json({ error: { message: err.message } });
    return res.status(500).json({ error: { message: err?.message || "internal error" } });
  }
});

export default router;
