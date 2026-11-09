// /v1/rerank — Rerank 中转端点（Cohere/Jina 兼容）
import express from "express";
import { apiKeyAuth } from "@/middleware/apiKeyAuth";
import { executeRelayRerank, RelayRerankError } from "@/lib/relayRerank";
import { BillingError } from "@/lib/billing";
import { resolveRelayPrincipalId, resolveRelayWorkspaceId } from "@/lib/relayUtils";

const router = express.Router();


router.post("/", apiKeyAuth({ optional: true, permission: "relay:text", reserveRequestQuota: true }), async (req, res) => {
  const body = req.body ?? {};
  const { model, query, documents } = body;
  if (typeof model !== "string" || !model.trim()) return res.status(400).json({ error: { message: "model is required" } });
  if (typeof query !== "string" || !query.trim()) return res.status(400).json({ error: { message: "query is required" } });
  if (!Array.isArray(documents) || !documents.length) return res.status(400).json({ error: { message: "documents is required" } });

  const workspaceId = resolveRelayWorkspaceId(req);
  const apiKey = (req as any).apiKey;
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
    const result = await executeRelayRerank(
      { ...body, model, query, documents },
      {
        workspaceId: workspaceId!,
        apiKeyId: apiKey?.id ?? null,
        principalId: resolveRelayPrincipalId(req),
        requestId: requestId || null,
        idempotencyKey: idempotencyKey || null,
      },
    );
    res.json(result);
  } catch (err: any) {
    if (err instanceof BillingError) return res.status(err.status).json({ error: { message: err.message } });
    if (err instanceof RelayRerankError) return res.status(err.statusCode).json({ error: { message: err.message } });
    return res.status(500).json({ error: { message: err?.message || "internal error" } });
  }
});

export default router;
