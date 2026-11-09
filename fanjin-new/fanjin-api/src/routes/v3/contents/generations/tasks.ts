import { publicH3Text } from "@/lib/minimaxH3PublicIdentity";
import express from "express";
import { z } from "zod";
import { apiKeyAuth } from "@/middleware/apiKeyAuth";
import {
  assertRelayTaskProjectAuthority,
  createRelayTask,
  formatPublicRelayTask,
  listRelayTasks,
  recoverPublicLegacyTextRelayTask,
  relayProviders,
} from "@/lib/relay";
import { prepareRelayCallbackRequestPayload, RelayCallbackUrlError } from "@/lib/relayCallback";
import {
  RelayProjectBindingError,
  removeRelayProjectIdAliases,
  resolveRequiredRelayProjectId,
} from "@/lib/relayProjectBinding";
import { preparePublicCanonicalVideoGeneration, preparePublicLegacyTextVideoGeneration } from "@/lib/publicVideoGenerationContract";
import {
  containsLegacyVideoMediaRequest,
  PUBLIC_V3_LEGACY_MEDIA_UPGRADE_ERROR,
} from "@/lib/publicV3LegacyMediaAdmission";
import {
  VIDEO_GENERATION_REQUEST_VERSION,
  VIDEO_OPERATIONS,
  VIDEO_REFERENCE_MEDIA_TYPES,
  VIDEO_REFERENCE_ROLES,
  type VideoGenerationRequest,
} from "@/lib/videoGenerationContract";
import type { TrustedVideoAssetPolicyEvidence } from "@/lib/videoAssetPolicy";
import { isSeedance25ModelId } from "@/lib/seedance25ModelIds";
import { ARK_VIDEO_PROTOCOL, parseArkVideoRequest } from "@/lib/arkVideoProtocol";

const router = express.Router();

const canonicalTrimSchema = z.object({
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
}).strict();

const canonicalRequestSchema = z.object({
  version: z.literal(VIDEO_GENERATION_REQUEST_VERSION),
  operation: z.enum(VIDEO_OPERATIONS),
  modelRouteId: z.string().min(1),
  prompt: z.string(),
  aspectRatio: z.string().min(1),
  durationSeconds: z.union([z.literal(-1), z.number().positive()]),
  outputResolution: z.string().min(1),
  outputFormat: z.enum(["mp4", "mov"]).optional(),
  generateAudio: z.boolean(),
  preserveSourceAudio: z.boolean(),
  inputs: z.array(z.object({
    assetVersionId: z.string().min(1),
    mediaType: z.enum(VIDEO_REFERENCE_MEDIA_TYPES),
    role: z.enum(VIDEO_REFERENCE_ROLES),
    order: z.number().int().nonnegative(),
    trim: canonicalTrimSchema.optional(),
  }).strict()),
  source: z.object({
    assetVersionId: z.string().min(1).optional(),
    taskId: z.string().min(1).optional(),
  }).strict().optional(),
  edit: z.object({
    startMs: z.number().int().nonnegative().optional(),
    endMs: z.number().int().positive().optional(),
    maskAssetVersionId: z.string().min(1).optional(),
    instruction: z.string(),
    preserve: z.array(z.string()),
  }).strict().optional(),
}).strict();

const createBodySchema = z
  .object({
    model: z.string().min(1),
    content: z.array(z.record(z.string(), z.unknown())).optional(),
    prompt: z.string().optional(),
    projectId: z.unknown().optional(),
    project_id: z.unknown().optional(),
    workspaceId: z.string().optional().nullable(),
    requestId: z.string().optional().nullable(),
    provider: z.enum(relayProviders).optional().nullable(),
    callback_url: z.string().optional().nullable(),
    callbackUrl: z.string().optional().nullable(),
    callback_secret: z.string().max(512).optional().nullable(),
    callbackSecret: z.string().max(512).optional().nullable(),
    canonicalRequest: canonicalRequestSchema.optional(),
  })
  .passthrough();

export function normalizeVideoGenerationRequest(
  input: z.infer<typeof createBodySchema>,
): Record<string, unknown> | null {
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  const content = Array.isArray(input.content) && input.content.length
    ? input.content
    : prompt
      ? [{ type: "text", text: prompt }]
      : [];
  if (!content.length) return null;

  // `prompt` was an early preview alias. Upstream accepts only canonical
  // `content[]`, so legacy callers are normalized before durable dispatch.
  const normalized: Record<string, unknown> = { ...input, content };
  delete normalized.prompt;
  return normalized;
}

function readFilterValue(value: unknown): string | null {
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : null;
  return typeof value === "string" && value ? value : null;
}

function readTaskIds(value: unknown): string[] {
  // Ark repeats filter.task_ids; retain comma-separated legacy callers too.
  return (Array.isArray(value) ? value : [value]).flatMap(item =>
    typeof item === "string" ? item.split(",").map(id => id.trim()).filter(Boolean) : []);
}

function resolveApiKeyWorkspaceId(req: express.Request, requestedWorkspaceId?: string | null): string | null {
  const apiKey = (req as any).apiKey;
  if (apiKey?.scope === "workspace") return apiKey.workspaceId ?? null;
  return requestedWorkspaceId ?? null;
}

router.post("/", apiKeyAuth({ permission: "relay:video_generation" }), async (req, res) => {
  // Official clients send only Ark fields. Keep the explicit project/canonical
  // extension for existing Canvas/MCP clients during migration.
  if (!req.body?.canonicalRequest && req.body?.projectId == null && req.body?.project_id == null) {
    try {
      const body = parseArkVideoRequest(req.body);
      const apiKey = (req as any).apiKey;
      const requestPayload = await prepareRelayCallbackRequestPayload(body, { requireClientSecret: false });
      const { task } = await createRelayTask({
        endpointType: "video_generation", model: body.model, provider: "volcano",
        workspaceId: apiKey.workspaceId, projectId: null, apiKeyId: apiKey.id,
        actorUserId: apiKey.ownerUserId, principalId: `api-key:${apiKey.id}`,
        requestId: req.header("idempotency-key")?.trim() || null, requestPayload,
      }, { trustedArkVideoProtocol: ARK_VIDEO_PROTOCOL });
      return res.status(200).send({ id: task.id });
    } catch (error: any) {
      const status = Number(error?.statusCode || error?.status || 500);
      return res.status(status >= 400 && status < 600 ? status : 500).send({ error: {
        code: String(error?.code || (status < 500 ? "InvalidParameter" : "InternalServiceError")),
        message: status < 500 ? error.message : "视频中转暂不可用，请稍后重试",
      } });
    }
  }
  const parsed = createBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ error: { message: "参数错误", details: parsed.error.issues } });

  if (isSeedance25ModelId(parsed.data.model) && !parsed.data.canonicalRequest) {
    return res.status(409).send({
      error: {
        code: "seedance25_canonical_request_required",
        message: "Seedance 2.5 精确模型必须提交 canonicalRequest 并通过正式 Adapter 预检",
      },
    });
  }

  if (
    !parsed.data.canonicalRequest
    && containsLegacyVideoMediaRequest(parsed.data as Record<string, unknown>)
  ) {
    return res.status(409).send({
      error: PUBLIC_V3_LEGACY_MEDIA_UPGRADE_ERROR,
    });
  }

  let projectId: number;
  try {
    projectId = resolveRequiredRelayProjectId(parsed.data);
  } catch (error) {
    if (error instanceof RelayProjectBindingError) {
      return res.status(error.status).send({
        error: { code: error.code, message: error.message },
      });
    }
    throw error;
  }

  const apiKey = (req as any).apiKey;
  const workspaceId = resolveApiKeyWorkspaceId(req, parsed.data.workspaceId);
  try {
    // Fail closed before callback URL validation can resolve DNS.
    await assertRelayTaskProjectAuthority({
      endpointType: "video_generation",
      workspaceId,
      projectId,
    });
  } catch (error: any) {
    const status = Number(error?.statusCode ?? error?.status);
    if (Number.isInteger(status) && status >= 400 && status < 500) {
      return res.status(status).send({
        error: {
          ...(error?.code ? { code: publicH3Text(String(error.code)) } : {}),
          message: publicH3Text(error?.message || "视频生成任务创建失败"),
        },
      });
    }
    throw error;
  }
  let requestPayload;
  try {
    const prepared = await prepareRelayCallbackRequestPayload(parsed.data);
    const normalized = parsed.data.canonicalRequest
      ? prepared
      : normalizeVideoGenerationRequest(prepared);
    if (!normalized) {
      return res.status(400).send({
        error: {
          code: "content_required",
          message: "content 至少需要一条输入内容",
        },
      });
    }
    requestPayload = removeRelayProjectIdAliases(normalized);
  } catch (error: any) {
    const configurationError = error instanceof RelayCallbackUrlError &&
      ["callback_signing_secret_missing", "insecure_callback_policy"].includes(error.code);
    const requestFieldError = error instanceof RelayCallbackUrlError &&
      ["callback_secret_required", "invalid_callback_secret", "callback_secret_conflict", "callback_url_required"].includes(error.code);
    return res.status(configurationError ? 503 : 400).send({
      error: {
        code: configurationError ? "callback_unavailable" : requestFieldError ? error.code : "invalid_callback_url",
        message: configurationError ? "回调投递服务尚未安全配置" : error?.message || "callback 配置无效",
      },
    });
  }
  const originalLegacyRequestPayload = requestPayload;
  let relayModel = parsed.data.model;
  let canonicalVideoGeneration: {
    request: VideoGenerationRequest;
    digest: string;
  } | null = null;
  let videoAssetPolicyEvidence: TrustedVideoAssetPolicyEvidence | null = null;
  let videoProviderAdapter: import("@/lib/relay").CreateRelayTaskOptions["trustedVideoProviderAdapter"] = null;
  {
    if (!workspaceId) {
      return res.status(403).send({
        error: { code: "workspace_context_required", message: "统一视频请求需要工作区上下文" },
      });
    }
    try {
      const prepared = parsed.data.canonicalRequest
        ? await preparePublicCanonicalVideoGeneration({
            workspaceId,
            projectId,
            model: parsed.data.model,
            request: parsed.data.canonicalRequest,
          })
        : await preparePublicLegacyTextVideoGeneration({
            workspaceId,
            projectId,
            model: parsed.data.model,
            requestPayload,
          });
      const callbackUrl = requestPayload.callback_url;
      const callbackSecretCiphertext = requestPayload.callback_secret_ciphertext;
      requestPayload = {
        ...prepared.requestPayload,
        ...(typeof callbackUrl === "string" ? { callback_url: callbackUrl } : {}),
        ...(typeof callbackSecretCiphertext === "string"
          ? { callback_secret_ciphertext: callbackSecretCiphertext }
          : {}),
      };
      relayModel = prepared.model;
      canonicalVideoGeneration = {
        request: prepared.canonicalRequest,
        digest: prepared.canonicalDigest,
      };
      videoAssetPolicyEvidence = prepared.trustedVideoAssetPolicyEvidence;
      videoProviderAdapter = prepared.relayAdapterBinding ?? null;
    } catch (error: any) {
      const status = Number(error?.statusCode ?? error?.status);
      if (Number.isInteger(status) && status >= 400 && status < 500) {
        return res.status(status).send({
          error: {
            ...(error?.code ? { code: publicH3Text(String(error.code)) } : {}),
            message: publicH3Text(error?.message || "统一视频请求预检失败"),
          },
        });
      }
      throw error;
    }
  }
  const idempotencyKey = req.header("idempotency-key")?.trim();
  const requestId = parsed.data.requestId ?? (idempotencyKey ? `${apiKey?.id || "public"}:${idempotencyKey}` : null);
  let task;
  try {
    const relayInput = {
      endpointType: "video_generation",
      model: relayModel,
      provider: parsed.data.provider ?? null,
      workspaceId,
      projectId,
      actorUserId: apiKey?.ownerUserId ?? null,
      apiKeyId: apiKey?.id ?? null,
      principalId: apiKey?.id ? `api-key:${apiKey.id}` : workspaceId ? `workspace:${workspaceId}` : null,
      requestId,
      requestPayload,
    } as const;
    const trustedOptions = canonicalVideoGeneration
      ? {
          trustedCanonicalVideoGeneration: canonicalVideoGeneration,
          trustedVideoAssetPolicyEvidence: videoAssetPolicyEvidence,
          ...(videoProviderAdapter
            ? { trustedVideoProviderAdapter: videoProviderAdapter }
            : {}),
        }
      : {};
    const recovered = !parsed.data.canonicalRequest
      ? await recoverPublicLegacyTextRelayTask({
          ...relayInput,
          model: parsed.data.model,
          requestPayload: originalLegacyRequestPayload,
        }, trustedOptions)
      : null;
    if (recovered) task = recovered;
    else ({ task } = await createRelayTask(relayInput, trustedOptions));
  } catch (error: any) {
    const status = Number(error?.statusCode ?? error?.status);
    if (Number.isInteger(status) && status >= 400 && status < 500) {
      return res.status(status).send({
        error: {
          ...(error?.code ? { code: publicH3Text(String(error.code)) } : {}),
          message: publicH3Text(error?.message || "视频生成任务创建失败"),
        },
      });
    }
    throw error;
  }

  res.status(200).send(await formatPublicRelayTask(task));
});

router.get("/", apiKeyAuth({ permission: "relay:video_generation", checkQuota: false }), async (req, res) => {
  const apiKey = (req as any).apiKey;
  const query = z.object({
    page_num: z.coerce.number().int().min(1).max(500).default(1),
    page_size: z.coerce.number().int().min(1).max(500).default(20),
    "filter.service_tier": z.enum(["default", "flex"]).default("default"),
    "filter.status": z.enum(["queued", "running", "succeeded", "failed", "cancelled", "expired"]).optional(),
  }).safeParse(req.query);
  if (!query.success) return res.status(400).send({ error: {
    code: "InvalidParameter", message: "列表分页或筛选参数无效",
  } });
  const pageNum = query.data.page_num;
  const pageSize = query.data.page_size;
  const status = readFilterValue(req.query["filter.status"]);
  const model = readFilterValue(req.query["filter.model"]);
  const taskIds = readTaskIds(req.query["filter.task_ids"]);

  const result = await listRelayTasks({
    endpointType: "video_generation",
    status,
    model,
    serviceTier: query.data["filter.service_tier"],
    publicVideoStatus: true,
    taskIds,
    workspaceId: apiKey?.workspaceId ?? null,
    apiKeyId: apiKey?.id ?? null,
    pageNum,
    pageSize,
  });

  const items = await Promise.all(result.items.map((task) => formatPublicRelayTask(task)));
  res.status(200).send({
    items,
    object: "list",
    // Keep the previous alias for existing Fanjin clients during migration.
    data: items,
    page_num: result.pageNum,
    page_size: result.pageSize,
    total: result.total,
  });
});

export default router;
