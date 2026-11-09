// /v1/audio/speech — OpenAI 兼容 TTS 中转
import express from "express";
import { apiKeyAuth } from "@/middleware/apiKeyAuth";
import { executeRelayTTS, RelayMediaError } from "@/lib/relayMedia";
import { BillingError } from "@/lib/billing";
import { resolveRelayPrincipalId, resolveRelayWorkspaceId } from "@/lib/relayUtils";

const router = express.Router();


router.post("/", apiKeyAuth({ optional: true, permission: "relay:text", reserveRequestQuota: true }), async (req, res) => {
  const body = req.body ?? {};
  const model = typeof body.model === "string" ? body.model.trim() : "";
  const input = typeof body.input === "string" ? body.input : "";
  if (!model) return res.status(400).json({ error: { message: "model is required", type: "invalid_request_error" } });
  if (!input) return res.status(400).json({ error: { message: "input is required", type: "invalid_request_error" } });
  const format = body.response_format || "mp3";
  if (!["mp3", "opus", "aac", "flac", "wav"].includes(format)) {
    return res.status(400).json({ error: { message: "response_format is invalid", type: "invalid_request_error" } });
  }
  if (body.speed !== undefined && (typeof body.speed !== "number" || !Number.isFinite(body.speed) || body.speed <= 0)) {
    return res.status(400).json({ error: { message: "speed must be a positive number", type: "invalid_request_error" } });
  }

  const workspaceId = resolveRelayWorkspaceId(req);
  const apiKey = (req as any).apiKey;
  if (!apiKey && !workspaceId) {
    return res.status(403).json({ error: { message: "缺少工作区上下文", type: "authentication_error" } });
  }
  const idempotencyKey = String(req.header("idempotency-key") || "").trim();
  if (idempotencyKey && !/^[A-Za-z0-9_.:-]{1,128}$/.test(idempotencyKey)) {
    return res.status(400).json({ error: { message: "Idempotency-Key 格式无效", type: "invalid_request_error" } });
  }

  try {
    const buffer = await executeRelayTTS(
      { model, input, voice: body.voice, response_format: format, speed: body.speed },
      {
        workspaceId: workspaceId!,
        apiKeyId: apiKey?.id ?? null,
        principalId: resolveRelayPrincipalId(req),
        requestId: String((req as any).requestId || req.header("x-request-id") || "").trim() || null,
        idempotencyKey: idempotencyKey || null,
      },
    );
    const mimeTypes: Record<string, string> = { mp3: "audio/mpeg", opus: "audio/opus", aac: "audio/aac", flac: "audio/flac", wav: "audio/wav" };
    res.setHeader("Content-Type", mimeTypes[format] || "audio/mpeg");
    res.send(buffer);
  } catch (err: any) {
    if (err instanceof BillingError) {
      return res.status(err.status).json({ error: { message: err.message, type: "billing_error" } });
    }
    if (err instanceof RelayMediaError) {
      return res.status(err.statusCode).json({ error: { message: err.message, type: "api_error" } });
    }
    return res.status(500).json({ error: { message: err?.message || "internal error", type: "server_error" } });
  }
});

export default router;
