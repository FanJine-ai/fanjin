// OpenAI 兼容的图像生成中转端点。
// POST /v1/images/generations
// 通过 API Key 鉴权（需 relay:image 权限），按张扣费。
import express from "express";
import { apiKeyAuth } from "@/middleware/apiKeyAuth";
import { MembershipError } from "@/lib/membershipCatalog";
import {
  executeRelayImage,
  executeRelayImageStream,
  RelayImageError,
  type RelayImageRequest,
} from "@/lib/relayImage";
import { BillingError } from "@/lib/billing";
import { resolveRelayPrincipalId, resolveRelayWorkspaceId } from "@/lib/relayUtils";
import { pipeRelayWebStreamToResponse } from "@/lib/relayStreamResponse";

const router = express.Router();

export default router.post("/", apiKeyAuth({ optional: true, permission: "relay:image_generation", reserveRequestQuota: true }), async (req, res) => {
  const body = req.body ?? {};
  const model = typeof body.model === "string" ? body.model : "";
  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  if (!model) return res.status(400).send({ error: { message: "model is required", type: "invalid_request_error" } });
  if (!prompt) return res.status(400).send({ error: { message: "prompt is required", type: "invalid_request_error" } });
  // The public synchronous endpoint cannot safely expose partial multi-output
  // results until every caller has a durable no-delivery reconciliation proof.
  // Keep Relay's internal multi-output contract intact, but fail closed here
  // before billing reservation or provider dispatch.
  if (body.n !== undefined && body.n !== 1) {
    return res.status(400).send({ error: { message: "n must be 1; multiple image outputs are not supported", type: "invalid_request_error" } });
  }
  if (body.stream !== undefined && typeof body.stream !== "boolean") {
    return res.status(400).send({ error: { message: "stream must be a boolean", type: "invalid_request_error" } });
  }
  if (body.seed !== undefined && !Number.isSafeInteger(body.seed)) {
    return res.status(400).send({ error: { message: "seed must be an integer", type: "invalid_request_error" } });
  }
  if (body.guidance_scale !== undefined && (typeof body.guidance_scale !== "number" || !Number.isFinite(body.guidance_scale))) {
    return res.status(400).send({ error: { message: "guidance_scale must be a finite number", type: "invalid_request_error" } });
  }
  if (body.watermark !== undefined && typeof body.watermark !== "boolean") {
    return res.status(400).send({ error: { message: "watermark must be a boolean", type: "invalid_request_error" } });
  }
  if (body.optimize_prompt !== undefined && typeof body.optimize_prompt !== "boolean") {
    return res.status(400).send({ error: { message: "optimize_prompt must be a boolean", type: "invalid_request_error" } });
  }
  if (
    body.sequential_image_generation !== undefined
    && !["auto", "disabled"].includes(body.sequential_image_generation)
  ) {
    return res.status(400).send({ error: { message: "sequential_image_generation must be auto or disabled", type: "invalid_request_error" } });
  }
  if (body.sequential_image_generation_options !== undefined) {
    const options = body.sequential_image_generation_options;
    if (
      !options
      || typeof options !== "object"
      || Array.isArray(options)
      || Object.keys(options).some((key) => key !== "max_images")
      || !Number.isSafeInteger(options.max_images)
      || options.max_images < 1
      || options.max_images > 15
    ) {
      return res.status(400).send({ error: { message: "sequential_image_generation_options.max_images must be an integer between 1 and 15", type: "invalid_request_error" } });
    }
    if (body.sequential_image_generation !== "auto") {
      return res.status(400).send({ error: { message: "sequential_image_generation_options requires sequential_image_generation=auto", type: "invalid_request_error" } });
    }
  }
  if (body.stream === true && body.sequential_image_generation !== "auto") {
    return res.status(400).send({ error: { message: "stream=true requires sequential_image_generation=auto", type: "invalid_request_error" } });
  }
  if (body.optimize_prompt_options !== undefined) {
    const options = body.optimize_prompt_options;
    if (
      !options
      || typeof options !== "object"
      || Array.isArray(options)
      || Object.keys(options).some((key) => key !== "mode")
      || !["standard", "fast"].includes(options.mode)
    ) {
      return res.status(400).send({ error: { message: "optimize_prompt_options.mode must be standard or fast", type: "invalid_request_error" } });
    }
  }
  if (body.output_format !== undefined && !["png", "jpeg"].includes(body.output_format)) {
    return res.status(400).send({ error: { message: "output_format must be png or jpeg", type: "invalid_request_error" } });
  }
  if (body.tools !== undefined && !Array.isArray(body.tools)) {
    return res.status(400).send({ error: { message: "tools must be an array", type: "invalid_request_error" } });
  }
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    return res.status(422).send({
      error: {
        message: "image tools are unavailable until tool usage has an explicit price",
        type: "unsupported_image_tool_billing",
        code: "unsupported_image_tool_billing",
      },
    });
  }
  if (body.user !== undefined && (typeof body.user !== "string" || !body.user.trim() || body.user.length > 128)) {
    return res.status(400).send({ error: { message: "user must be a non-empty string up to 128 characters", type: "invalid_request_error" } });
  }
  if (body.image !== undefined) {
    // This compatibility endpoint has no project-bound asset identity, so a
    // URL/base64 reference cannot be checked against portrait admission or an
    // exact provider binding. Keep text-to-image compatible, but close media
    // references before routing, pricing, reservation, or provider IO. New
    // callers must use a controlled project surface that submits
    // assetVersionId references.
    return res.status(409).send({
      error: {
        code: "controlled_media_requires_asset_version",
        message: "图片参考必须先上传到 Fanjin 受控资产，并通过 assetVersionId 提交",
        type: "invalid_request_error",
      },
    });
  }

  const apiKey = (req as any).apiKey;
  const workspaceId = resolveRelayWorkspaceId(req);
  if (!apiKey && !workspaceId) return res.status(403).send({ error: { message: "缺少工作区上下文", type: "authentication_error" } });
  const idempotencyKey = String(req.header("idempotency-key") || "").trim();
  if (idempotencyKey && !/^[A-Za-z0-9_.:-]{1,128}$/.test(idempotencyKey)) {
    return res.status(400).send({ error: { message: "Idempotency-Key 格式无效", type: "invalid_request_error" } });
  }

  const imageRequest: RelayImageRequest = {
    model,
    prompt,
    n: 1,
    size: typeof body.size === "string" ? body.size : undefined,
    response_format: body.response_format === "b64_json" ? "b64_json" : "url",
    quality: typeof body.quality === "string" ? body.quality : undefined,
    style: typeof body.style === "string" ? body.style : undefined,
    image: body.image,
    seed: typeof body.seed === "number" ? body.seed : undefined,
    guidance_scale: typeof body.guidance_scale === "number" ? body.guidance_scale : undefined,
    watermark: typeof body.watermark === "boolean" ? body.watermark : undefined,
    optimize_prompt: typeof body.optimize_prompt === "boolean" ? body.optimize_prompt : undefined,
    sequential_image_generation: body.sequential_image_generation === "auto" || body.sequential_image_generation === "disabled"
      ? body.sequential_image_generation
      : undefined,
    sequential_image_generation_options: body.sequential_image_generation_options,
    optimize_prompt_options: body.optimize_prompt_options,
    output_format: body.output_format === "png" || body.output_format === "jpeg" ? body.output_format : undefined,
    user: typeof body.user === "string" ? body.user.trim() : undefined,
  };

  try {
    const billingContext = {
      workspaceId: workspaceId!,
      apiKeyId: apiKey?.id ?? null,
      principalId: resolveRelayPrincipalId(req),
      requestId: String((req as any).requestId || req.header("x-request-id") || "").trim() || null,
      idempotencyKey: idempotencyKey || null,
    };
    if (body.stream === true) {
      const result = await executeRelayImageStream(imageRequest, billingContext);
      res.status(200);
      res.setHeader("Content-Type", result.contentType);
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      pipeRelayWebStreamToResponse({
        stream: result.stream,
        res,
        clientDisconnectMessage: "image stream client disconnected",
        onErrorBeforeHeaders: (error) => {
          res.status(502).json({ error: { message: error.message, type: "api_error" } });
        },
      });
      return;
    }
    const result = await executeRelayImage(imageRequest, billingContext);
    res.status(200).json(result);
  } catch (err: any) {
    if (err instanceof MembershipError) {
      if (err.code === "WORKSPACE_GENERATION_QUEUED") res.setHeader("Retry-After", "2");
      return res.status(err.status).send({ error: { message: err.message, code: err.code, type: "resource_limit" } });
    }
    if (err instanceof BillingError) {
      return res.status(err.status).send({ error: { message: err.message, type: "billing_error" } });
    }
    if (err instanceof RelayImageError) {
      res.status(err.statusCode).send({ error: { message: err.message, type: err.statusCode === 402 ? "insufficient_quota" : "api_error" } });
      return;
    }
    console.error("[relay-image] error:", err);
    res.status(500).send({ error: { message: err?.message || "internal error", type: "server_error" } });
  }
});
