// Midjourney 中转端点
import express from "express";
import { apiKeyAuth } from "@/middleware/apiKeyAuth";
import { executeMJSubmit, executeMJTaskFetch, RelayMJError } from "@/lib/relayMidjourney";
import { BillingError } from "@/lib/billing";
import { resolveRelayPrincipalId, resolveRelayWorkspaceId } from "@/lib/relayUtils";
import {
  LEGACY_ASYNC_RELAY_UNAVAILABLE_MESSAGE,
  legacyAsyncRelayAvailable,
} from "@/lib/legacyAsyncRelaySafety";

const router = express.Router();

router.use((_req, res, next) => {
  if (!legacyAsyncRelayAvailable()) {
    return res.status(503).json({
      error: { message: LEGACY_ASYNC_RELAY_UNAVAILABLE_MESSAGE, type: "feature_unavailable" },
    });
  }
  next();
});

// /mj/submit/:action（imagine / upscale / variation / describe / blend）
router.post("/submit/:action", apiKeyAuth({ optional: true, permission: "relay:image_generation", reserveRequestQuota: true }), async (req, res) => {
  const workspaceId = resolveRelayWorkspaceId(req);
  const apiKey = (req as any).apiKey;
  if (!apiKey && !workspaceId) return res.status(403).json({ error: { message: "缺少工作区上下文" } });
  try {
    const result = await executeMJSubmit(String(req.params.action), req.body, {
      workspaceId: workspaceId!,
      apiKeyId: apiKey?.id ?? null,
      principalId: resolveRelayPrincipalId(req),
      requestId: String((req as any).requestId || req.header("x-request-id") || "").trim() || null,
      idempotencyKey: String(req.header("idempotency-key") || "").trim() || null,
    });
    res.json(result);
  } catch (err: any) {
    if (err instanceof BillingError) return res.status(err.status).json({ error: { message: err.message } });
    if (err instanceof RelayMJError) return res.status(err.statusCode).json({ error: { message: err.message } });
    return res.status(500).json({ error: { message: err?.message || "internal error" } });
  }
});

// /mj/task/:id/fetch
router.get("/task/:id/fetch", apiKeyAuth({ optional: true, permission: "relay:image_generation", reserveRequestQuota: true }), async (req, res) => {
  const workspaceId = resolveRelayWorkspaceId(req);
  const apiKey = (req as any).apiKey;
  if (!apiKey && !workspaceId) return res.status(403).json({ error: { message: "缺少工作区上下文" } });
  try {
    const result = await executeMJTaskFetch(String(req.params.id), { workspaceId: workspaceId!, apiKeyId: apiKey?.id ?? null });
    res.json(result);
  } catch (err: any) {
    if (err instanceof RelayMJError) return res.status(err.statusCode).json({ error: { message: err.message } });
    return res.status(500).json({ error: { message: err?.message || "internal error" } });
  }
});

export default router;
