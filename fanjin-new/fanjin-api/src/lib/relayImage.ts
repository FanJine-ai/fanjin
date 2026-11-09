import { imageReferenceCount } from "./imageReferencePricing";
// 图像生成中转：OpenAI 兼容的 /v1/images/generations 同步调用。
// 与 LLM 中转类似，图像是同步返回，不走 relay 异步任务表。
// 调用供应商后按张扣费（image_generation 端点）。
//
// 计费链路与创作台、LLM 中转、视频中转共用同一套 o_pricing_rule + billApiTask。
import axios from "axios";
import crypto from "node:crypto";
import type { Knex } from "knex";
import type { RelayChannel } from "@/lib/relay";
import { withChannelRetry, joinProviderApiPath } from "@/lib/channelRouter";
import { isJwsImageChannel, prepareJwsImageRequest } from "./jwsImageTransport";
import {isJwsAsyncImage,prepareJwsAsyncImage,executeJwsAsyncImage,JwsImageError,type PreparedJwsImage} from "./jwsAsyncImage";
import type {JwsImageCharge} from "./jwsImagePricing";
import { BillingError, type ApiTaskDispatchBoundary } from "@/lib/billing";
import {
  beginRelayUnitBilling,
  createRelayUnitBillingCheckpoint,
  markRelayBillingDispatchStarted,
  markRelayBillingPending,
  releaseRelayBillingSession,
  settleRelayUnitBilling,
  type RelayBillingContext,
  type RelayBillingSession,
  type RelayUnitBillingCheckpoint,
} from "@/lib/relayBillingSession";
import {
  resolveChannelBaseUrl,
  withChannelApiKeyForDispatch,
} from "@/lib/relayChannelCredential";
import {
  relayImageProviderReadbackBillingMetadata,
  relayImageProviderReadbackDispatchHeaders,
  resolveRelayImageProviderReadbackAdmission,
  type RelayImageProviderReadbackCapability,
} from "@/lib/relayImageProviderReadback";
import {
  resolvePortraitProviderReferencesForChannel,
  VideoAssetPolicyError,
  type PortraitProviderReferenceBinding,
} from "@/lib/videoAssetPolicy";
import { createVolcanoProviderAccountEvidence } from "@/lib/volcanoProviderAccount";
import { db } from "@/utils/db";

export interface RelayImageRequest {
  model: string;
  prompt: string;
  n?: number; // 生成数量，默认 1
  size?: string; // 如 "1024x1024"
  response_format?: "url" | "b64_json";
  quality?: string; // "standard" | "hd"
  style?: string;
  // 报价阶段钉定的上游供应商；传入后 withChannelRetry 仅在该 provider 的
  // 候选通道中选路，避免并发满时漂移到定价更高的供应商（E08-AG-03）。
  provider?: string;
  // 扩展：参考图（图生图）
  image?: string | string[]; // base64 或 URL
  // Volcano Ark / Seedream extensions. These are intentionally explicit so
  // tenant, callback and credential fields can never be forwarded by accident.
  seed?: number;
  guidance_scale?: number;
  watermark?: boolean;
  optimize_prompt?: boolean;
  sequential_image_generation?: "auto" | "disabled";
  sequential_image_generation_options?: { max_images: number };
  optimize_prompt_options?: { mode: "standard" | "fast" };
  output_format?: "png" | "jpeg";
  /** Non-empty tools are rejected until their provider cost has an explicit price. */
  tools?: Array<Record<string, unknown>>;
  user?: string;
}

export interface RelayImageResult {
  created: number;
  data: Array<{ url?: string; b64_json?: string }>;
  /** Trusted upstream task receipt, not a client-supplied price. */
  upstreamCharge?: JwsImageCharge;
  /** 上游返回的 token usage（部分提供商支持） */
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    image_tokens?: number;
    total_tokens?: number;
  };
}

export interface RelayImageStreamResult {
  stream: ReadableStream<Uint8Array>;
  contentType: string;
}

export const PORTRAIT_IMAGE_REFERENCE_PROTOCOL_UNSUPPORTED_CODE =
  "portrait_image_reference_protocol_unsupported" as const;

/**
 * Trusted server-side routing constraint. Public image request bodies cannot
 * set this value; Agent generation uses it to keep execution on the provider
 * captured in the approved quote.
 */
export interface RelayImageExecutionContext extends RelayBillingContext {
  provider?: string | null;
  /**
   * Trusted, server-created identity for every ordered reference in
   * `RelayImageRequest.image`. Public request bodies never populate this
   * field. Keeping the canonical asset versions beside (rather than inside)
   * the provider request prevents a caller supplied URL/base64 value from
   * impersonating an admitted portrait asset.
   */
  portraitReferenceScope?: {
    projectId: string;
    orderedAssetVersionIds: readonly string[];
    /**
     * Image generation providers consume the original project-owned image
     * bytes/URLs. They do not support Volcano's video-only `asset://`
     * portrait binding protocol, so those references must not start a
     * portrait registration workflow.
     */
    requiresPortraitAdmission?: boolean;
  } | null;
  /**
   * Immutable identity of the durable workbench command that owns this paid
   * dispatch. It is persisted into the reservation evidence so a later
   * reconciliation can bind to the exact command row without treating the
   * transport request id as an idempotency key.
   */
  durableCommandIdentity?: {
    contractVersion: "workbench-generation-command.v1";
    commandId: string;
    workspaceId: string;
    actorUserId: number;
    scopeKey: string;
    idempotencyKey: string;
    requestHash: string;
  } | null;
  /**
   * Optional trusted durability bridge used by synchronous workbench commands.
   * The dispatch intent is committed atomically with the billing watchdog
   * before the provider POST. The result hook runs before customer settlement.
   */
  onBeforeProviderDispatchCommit?: (
    boundary: ApiTaskDispatchBoundary,
    transaction: Knex.Transaction,
    providerRequest?: RelayImageRequest,
  ) => Promise<void>;
  onProviderDispatchCommitted?: (boundary: ApiTaskDispatchBoundary) => void;
  onProviderResult?: (
    result: RelayImageResult,
    billingCheckpoint: RelayUnitBillingCheckpoint,
  ) => Promise<void>;
}

export class RelayImageError extends Error {
  statusCode: number;
  upstreamMayHaveAccepted: boolean;
  reconcileReason: string | null;
  reconciliationMetadata: Record<string, unknown>;
  upstreamRefundConfirmed: boolean;
  constructor(
    message: string,
    statusCode: number,
    upstreamMayHaveAccepted = true,
    reconciliation?: { reason?: string; metadata?: Record<string, unknown>; refundConfirmed?: boolean },
  ) {
    super(message);
    this.name = "RelayImageError";
    this.statusCode = statusCode;
    this.upstreamMayHaveAccepted = upstreamMayHaveAccepted;
    this.reconcileReason = reconciliation?.reason || null;
    this.reconciliationMetadata = reconciliation?.metadata || {};
    this.upstreamRefundConfirmed = reconciliation?.refundConfirmed === true;
  }
}

function assertImageToolsPriced(tools: RelayImageRequest["tools"]): void {
  if (!tools?.length) return;
  throw new RelayImageError(
    "图片生成 tools 尚无可结算价格；请求未发送到上游",
    422,
    false,
    { reason: "unsupported_image_tool_billing" },
  );
}

function imageReservationCount(input: RelayImageRequest, fallbackCount: number): number {
  if (input.sequential_image_generation !== "auto") return fallbackCount;
  const maxImages = Number(input.sequential_image_generation_options?.max_images ?? fallbackCount);
  if (!Number.isSafeInteger(maxImages) || maxImages < 1 || maxImages > 15) {
    throw new RelayImageError(
      "sequential_image_generation_options.max_images 必须是 1 到 15 的整数",
      400,
      false,
    );
  }
  return maxImages;
}

function assertImageExtensionProvider(channel: RelayChannel, input: RelayImageRequest): void {
  const hasVolcanoOnlyExtension = input.sequential_image_generation !== undefined
    || input.sequential_image_generation_options !== undefined
    || input.optimize_prompt_options !== undefined;
  if (hasVolcanoOnlyExtension && String(channel.provider || "").toLowerCase() !== "volcano") {
    throw new RelayImageError("当前供应商不支持火山图片扩展参数", 422, false);
  }
}

const OPAQUE_REFERENCE_ID = /^[^\u0000-\u001f\u007f\s]{1,256}$/u;

function imageReferenceValues(
  value: RelayImageRequest["image"],
): { values: string[]; scalar: boolean } {
  if (typeof value === "string") return { values: [value], scalar: true };
  if (Array.isArray(value)) return { values: [...value], scalar: false };
  return { values: [], scalar: false };
}

/**
 * ImageGenerations only documents URL/Base64 references. Volcano private
 * `asset://` bindings are a Seedance video contract, so image execution must
 * never substitute them even if an operator placed a legacy boolean in the
 * channel configuration.
 */
export function bindRelayImagePortraitReferences(input: {
  image: RelayImageRequest["image"];
  orderedAssetVersionIds: readonly string[];
  portraitBindings: readonly PortraitProviderReferenceBinding[];
}): RelayImageRequest["image"] {
  const references = imageReferenceValues(input.image);
  const orderedAssetVersionIds = input.orderedAssetVersionIds.map((value) =>
    String(value || "").trim()
  );
  if (
    references.values.length === 0
    || references.values.length !== orderedAssetVersionIds.length
    || orderedAssetVersionIds.some((value) => !OPAQUE_REFERENCE_ID.test(value))
  ) {
    throw new RelayImageError(
      "图片参考与受控素材版本不一致，请重新选择参考素材",
      409,
      false,
      { reason: "portrait_reference_scope_mismatch" },
    );
  }

  if (input.portraitBindings.length > 0) {
    throw new RelayImageError(
      "当前图片生成协议不支持受信人像资产引用，请改用已支持的人像视频流程",
      409,
      false,
      {
        reason: PORTRAIT_IMAGE_REFERENCE_PROTOCOL_UNSUPPORTED_CODE,
        metadata: { retryable: false },
      },
    );
  }
  return input.image;
}

function portraitAdmissionPublicError(error: unknown): RelayImageError {
  const sourceCode = error instanceof VideoAssetPolicyError
    ? error.code
    : "portrait_provider_binding_pending";
  const retryable = error instanceof VideoAssetPolicyError
    ? error.retryable
    : true;
  const status = error instanceof VideoAssetPolicyError ? error.status : 409;
  const denied = [
    "video_asset_policy_denied",
    "portrait_admission_denied",
    "portrait_rejected",
  ].includes(sourceCode);
  // The durable image workers share one retry contract. Provider preparation
  // can expose more specific internal codes, but every retryable admission
  // outcome must cross this boundary as the canonical pending reason.
  const reason = !denied && retryable
    ? "portrait_provider_binding_pending"
    : sourceCode;
  return new RelayImageError(
    denied
      ? "图片参考未通过人像准入校验"
      : "图片参考的人像资产尚未就绪，请稍后重试",
    status >= 400 && status < 600 ? status : 409,
    false,
    {
      reason,
      metadata: {
        retryable: denied ? false : retryable,
        portraitAdmissionCode: sourceCode,
      },
    },
  );
}

async function bindRelayImageInputForChannel(input: {
  request: RelayImageRequest;
  context: RelayImageExecutionContext;
  channel: RelayChannel;
}): Promise<RelayImageRequest> {
  const references = imageReferenceValues(input.request.image);
  const scope = input.context.portraitReferenceScope;
  if (references.values.length === 0) {
    if (scope?.orderedAssetVersionIds.length) {
      throw new RelayImageError(
        "图片参考与受控素材版本不一致，请重新选择参考素材",
        409,
        false,
        { reason: "portrait_reference_scope_mismatch" },
      );
    }
    return input.request;
  }
  if (!scope) {
    throw new RelayImageError(
      "图片参考必须先上传到 Fanjin 受控资产，并通过 assetVersionId 提交",
      409,
      false,
      { reason: "controlled_media_requires_asset_version" },
    );
  }
  const projectId = String(scope.projectId || "").trim();
  const orderedAssetVersionIds = scope.orderedAssetVersionIds.map((value) =>
    String(value || "").trim()
  );
  if (
    !/^\d+$/u.test(projectId)
    || Number(projectId) <= 0
    || orderedAssetVersionIds.length !== references.values.length
    || orderedAssetVersionIds.some((value) => !OPAQUE_REFERENCE_ID.test(value))
  ) {
    throw new RelayImageError(
      "图片参考与受控素材版本不一致，请重新选择参考素材",
      409,
      false,
      { reason: "portrait_reference_scope_mismatch" },
    );
  }

  // The scope is still checked above so a client cannot attach arbitrary
  // media. Ordinary image-to-image and storyboard generation use the
  // project-owned source images directly; only video/portrait workflows need
  // the provider-specific admission and asset binding below.
  if (scope.requiresPortraitAdmission === false) return input.request;

  // Preserve ordinary URL/Base64 inputs when local portrait checks or asset
  // registration are incomplete. The shared resolver still checks ownership,
  // explicit denials and rights; image channels never receive asset:// URIs.
  let resolution;
  try {
    resolution = await resolvePortraitProviderReferencesForChannel({
      database: input.context.database ?? undefined,
      workspaceId: input.context.workspaceId,
      projectId,
      assetVersionIds: orderedAssetVersionIds,
      providerChannelId: input.channel.id,
    });
  } catch (error) {
    throw portraitAdmissionPublicError(error);
  }
  if (!resolution.schemaAvailable) {
    throw new RelayImageError(
      "图片参考的人像准入服务尚未就绪，请稍后重试",
      503,
      false,
      { reason: "portrait_admission_schema_unavailable" },
    );
  }
  if (
    resolution.bindings.some((binding) =>
      String(binding.channelId || "").trim() !== input.channel.id
    )
  ) {
    throw new RelayImageError(
      "图片参考的人像资产绑定无效，请稍后重试",
      409,
      false,
      { reason: "portrait_provider_binding_invalid" },
    );
  }
  return {
    ...input.request,
    image: bindRelayImagePortraitReferences({
      image: input.request.image,
      orderedAssetVersionIds,
      portraitBindings: resolution.bindings,
    }),
  };
}

/**
 * Builds the provider wire payload without dispatching it.
 *
 * Volcano Ark does not define OpenAI's `n` for `/api/v3/images/generations`.
 * Quick Create 0.0.8 deliberately exposes only one real image per request.
 * Rejecting a larger count here keeps every Volcano entry point fail-closed
 * before its durable billing dispatch checkpoint. We deliberately do not
 * fan out or retry POSTs: partial fan-out cannot be recovered safely without
 * a per-output durable dispatch checkpoint.
 *
 * Volcano's documented sequential-image parameters remain a future capability
 * design; they are not part of the 0.0.8 public contract.
 */
export function buildRelayImageProviderRequestBody(input: {
  request: RelayImageRequest;
  count: number;
  channel: RelayChannel;
  upstreamModel: string;
  responseFormat: "url" | "b64_json";
}): Record<string, unknown> {
  const { request, count, channel, upstreamModel, responseFormat } = input;
  const isVolcano = String(channel.provider || "").trim().toLowerCase() === "volcano";
  const requestBody: Record<string, unknown> = {
    model: upstreamModel,
    prompt: request.prompt,
    response_format: responseFormat,
    ...(!isVolcano ? { n: count } : {}),
  };

  if (isVolcano) {
    if (count > 1) {
      throw new RelayImageError(
        "当前图片生成能力每次只能生成 1 张",
        422,
        false,
      );
    }
    requestBody.stream = false;
  }

  if (request.size) requestBody.size = request.size;
  if (request.quality) requestBody.quality = request.quality;
  if (request.style) requestBody.style = request.style;
  if (request.image) requestBody.image = request.image;
  if (request.seed !== undefined) requestBody.seed = request.seed;
  if (request.guidance_scale !== undefined) requestBody.guidance_scale = request.guidance_scale;
  if (request.watermark !== undefined) requestBody.watermark = request.watermark;
  if (request.optimize_prompt !== undefined) requestBody.optimize_prompt = request.optimize_prompt;
  if (request.sequential_image_generation) {
    requestBody.sequential_image_generation = request.sequential_image_generation;
  }
  if (request.sequential_image_generation_options) {
    requestBody.sequential_image_generation_options = request.sequential_image_generation_options;
  }
  if (request.optimize_prompt_options) {
    requestBody.optimize_prompt_options = request.optimize_prompt_options;
  }
  if (request.output_format) requestBody.output_format = request.output_format;
  if (request.user) requestBody.user = request.user;
  return requestBody;
}

function assertRelayImageProviderOutputCount(
  provider: unknown,
  count: number,
): void {
  if (String(provider || "").trim().toLowerCase() === "volcano" && count > 1) {
    throw new RelayImageError(
      "当前图片生成能力每次只能生成 1 张",
      422,
      false,
    );
  }
}

function isValidImageEntry(item: unknown): item is { url?: string; b64_json?: string } {
  if (!item || typeof item !== "object") return false;
  const value = item as Record<string, unknown>;
  return (typeof value.url === "string" && Boolean(value.url.trim())) ||
    (typeof value.b64_json === "string" && Boolean(value.b64_json.trim()));
}

function upstreamMayHaveAcceptedStatus(status: number): boolean {
  return ![400, 401, 402, 403, 404, 405, 406, 411, 413, 414, 415, 422, 429].includes(status);
}

function isDefinitiveImageGatewayRejection(
  status: number,
  upstreamCode: string | null,
  upstreamType: string | null,
): boolean {
  // Sine's OpenAI-compatible gateway returns this complete error envelope when
  // its upstream rejects the request before creating an image task. A bare 502
  // remains uncertain: it can still represent a response lost after dispatch.
  return status === 502
    && upstreamCode === "bad_response_status_code"
    && upstreamType === "bad_response_status_code";
}

function uncertainImageUpstreamError(error: unknown, fallback: string): RelayImageError {
  const value = error as any;
  const status = Number(value?.statusCode ?? value?.status ?? value?.response?.status);
  const message = value?.response?.data?.error?.message || value?.message || fallback;
  const upstreamError = value?.response?.data?.error;
  const safeIdentifier = (identifier: unknown) => typeof identifier === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(identifier)
    ? identifier : null;
  const upstreamCode = safeIdentifier(upstreamError?.code);
  const upstreamType = safeIdentifier(upstreamError?.type);
  return new RelayImageError(
    String(message),
    Number.isFinite(status) ? status : 502,
    upstreamMayHaveAcceptedStatus(status)
      && !isDefinitiveImageGatewayRejection(status, upstreamCode, upstreamType),
    { metadata: {
      upstreamCode,
      upstreamType,
      ...(!value?.response && (
        ["ECONNABORTED", "ETIMEDOUT"].includes(value?.code)
        || value?.name === "TimeoutError"
      ) ? { transportTimedOut: true } : {}),
    } },
  );
}

export function normalizeRelayImageProviderDispatchError(error: unknown): RelayImageError {
  return error instanceof RelayImageError
    ? error
    : uncertainImageUpstreamError(error, "图片供应商调用失败");
}

export function shouldRetryIdempotentImageRequest(error: unknown): boolean {
  const value = error as any;
  const status = Number(value?.response?.status ?? value?.statusCode ?? value?.status);
  const message = String(value?.response?.data?.error?.message || value?.message || "");
  // Do not replay an unknown dispatch merely because we sent an idempotency
  // header. Only an explicit provider instruction permits this recovery path.
  return status === 503 && /idempotency-key/i.test(message) && /same|相同|原请求/i.test(message);
}

function idempotentImageRetryDelays(error: unknown): number[] {
  const value = error as any;
  const status = Number(value?.response?.status ?? value?.statusCode ?? value?.status);
  const message = String(value?.response?.data?.error?.message || value?.message || "");
  // A bare 503 means the relay has no useful recovery guidance. Replaying the
  // same key once handles a short gateway blip, then lets the durable task
  // enter recovery instead of holding the browser request for many minutes.
  return status === 503 && /idempotency-key/i.test(message)
    ? [1500, 3000, 6000, 12000, 24000]
    : [1500];
}

function waitForIdempotentImageRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/**
 * 执行图像生成中转调用。
 * 调用成功后按张扣费（n 张 × 单价）。
 *
 * 连接注入边界(REVAMP-PLAN 风险 #7):以下环节架构上必须留在全局连接池,
 * 不可注入调用方长事务:
 * 1. withChannelRetry(channelRouter)的通道槽位租约——跨请求并发信号量,
 *    必须即时独立提交;注入后租约对并发请求不可见且随 Gateway 回滚消失,
 *    会造成通道容量超卖;
 * 2. 计费会话生命周期(beginRelayUnitBilling/settle/release/mark →
 *    billing.ts 的 billApiTask 等独立原子事务)——预扣必须独立于 Gateway
 *    事务提交并留存待核账,详见 billing.ts billApiTask 注释。
 * SQLite 只有一个写者，扩大连接池或开启 WAL 都不能解除外层写事务等待
 * 独立计费写事务的自锁。因此 Agent 付费写工具必须先提交 Gateway prepare
 * 短事务，再在事务外调用本函数，最后用另一个短事务写回 Tool Step 终态。
 */
export async function executeRelayImage(
  input: RelayImageRequest,
  ctx: RelayImageExecutionContext,
): Promise<RelayImageResult> {
  assertImageToolsPriced(input.tools);
  const count = input.n == null ? 1 : Number(input.n);
  if (!Number.isSafeInteger(count) || count < 1 || count > 10) {
    throw new RelayImageError("n 必须是 1 到 10 的整数", 400, false);
  }
  const reservationCount = imageReservationCount(input, count);
  const normalizedInput = { ...input, n: count };
  const billingState: { current: RelayBillingSession | null } = { current: null };
  let activeChannel: RelayChannel | null = null;
  let upstreamCompleted = false;
  let returnedCount: number | null = null;

  try {
    const routed = await withChannelRetry(
      {
        endpointType: "image_generation",
        model: input.model,
        provider: ctx.provider,
        workspaceId: ctx.workspaceId,
        retryPolicy: "disabled",
      },
      0,
      async (channel: RelayChannel) => {
        activeChannel = channel;
        assertImageExtensionProvider(channel, normalizedInput);
        // Provider-specific admission must run before creating a billing
        // reservation. The request therefore has zero billing/upstream side
        // effects when the public count contract is unsupported.
        assertRelayImageProviderOutputCount(channel.provider, count);
        const readbackAdmission = resolveRelayImageProviderReadbackAdmission(
          channel,
        );
        if (!readbackAdmission.allowed) {
          throw new RelayImageError(
            "当前图片路由要求权威上游回查，但供应商通道未配置可执行回查适配器",
            409,
            false,
            {
              reason: "image_provider_readback_unsupported",
              metadata: {
                channelId: channel.id,
                provider: channel.provider,
                providerReadback: relayImageProviderReadbackBillingMetadata(
                  readbackAdmission.capability,
                ),
              },
            },
          );
        }
        // The exact generation channel is known only inside this callback.
        // Resolve/queue its channel-scoped portrait assets before a GU
        // reservation, durable task checkpoint, or provider POST exists.
        const channelInput = await bindRelayImageInputForChannel({
          request: normalizedInput,
          context: ctx,
          channel,
        });
        let jwsRequest: Awaited<ReturnType<typeof prepareJwsImageRequest>> | undefined;
        let jwsAsync: PreparedJwsImage | undefined;
        if(isJwsAsyncImage(channel)) {
          try {jwsAsync=await prepareJwsAsyncImage(channelInput,channel,resolveUpstreamModel(channel,input.model),count,undefined,JSON.stringify([ctx.workspaceId,ctx.apiKeyId,ctx.principalId,channel.id,ctx.idempotencyKey || ctx.requestId || crypto.randomUUID()]));}
          catch(error){throw new RelayImageError(error instanceof JwsImageError?error.message:"图片参数或报价暂不可用",422,false);}
        }
        if (isJwsImageChannel(channel)) {
          try { jwsRequest = await prepareJwsImageRequest(channelInput, resolveUpstreamModel(channel, input.model), count); }
          catch { throw new RelayImageError("图片参数或参考图片不符合当前模型要求，请检查尺寸、质量和文件格式", 422, false); }
        }
        const trustedOutputProviderAccount = channel.provider === "volcano"
          ? createVolcanoProviderAccountEvidence(channel.config)
          : null;
        if (!billingState.current) {
          billingState.current = await beginRelayUnitBilling({
            source: "relay-image",
            endpointType: "image_generation",
            model: input.model,
            channel,
            context: ctx,
            requestPayload: channelInput,
            units: reservationCount,
            unit: "image",
            expectedProvider: input.provider,
            upstreamQuote: jwsAsync?.quote,
            metadata: {
              requestedCount: count,
              reservedCount: reservationCount,
              size: input.size || null,
              quality: input.quality || null,
              style: input.style || null,
              providerReadback: relayImageProviderReadbackBillingMetadata(
                readbackAdmission.capability,
              ),
              ...(trustedOutputProviderAccount
                ? { trustedOutputProviderAccount }
                : {}),
              ...(ctx.durableCommandIdentity
                ? { durableCommandIdentity: ctx.durableCommandIdentity }
                : {}),
            },
          });
        } else if (billingState.current.provider !== channel.provider) {
          throw new BillingError("跨供应商 fallback 的价格快照结算尚未开放", 409);
        }
        return await executeImageCall(
          channelInput,
          count,
          reservationCount,
          channel,
          billingState.current,
          ctx,
          readbackAdmission.capability,
          jwsRequest,
          jwsAsync,
        );
      },
    );
    upstreamCompleted = true;
    returnedCount = routed.result.data.length;
    if (!billingState.current) throw new BillingError("图片计费预扣会话未创建", 500);
    if (ctx.onProviderResult) {
      try {
        await ctx.onProviderResult(
          routed.result,
          createRelayUnitBillingCheckpoint(billingState.current),
        );
      } catch {
        throw new RelayImageError(
          "图片上游结果未能写入恢复检查点，已转入待核账且不会自动重发",
          503,
          true,
          {
            reason: "image_provider_result_checkpoint_failed",
            metadata: {
              returnedCount: routed.result.data.length,
              validReturnedCount: routed.result.data.filter(isValidImageEntry).length,
            },
          },
        );
      }
    }
    await settleRelayUnitBilling(billingState.current, routed.channel, {
      upstreamCharge: routed.result.upstreamCharge,
      units: routed.result.data.length,
      unit: "image",
      tokenParams: routed.result.usage ? {
        p: routed.result.usage.prompt_tokens || 0,
        c: routed.result.usage.completion_tokens || 0,
        img: routed.result.usage.image_tokens || 0,
      } : undefined,
      metadata: {
        requestedCount: count,
        reservedCount: reservationCount,
        returnedCount: routed.result.data.length,
        referenceImageCount: imageReferenceCount(input),
        size: input.size || null,
        quality: input.quality || null,
      },
    });
    const {upstreamCharge: _upstreamCharge, ...publicResult} = routed.result;
    return publicResult;
  } catch (error: any) {
    if (billingState.current && !billingState.current.finalized) {
      if (!billingState.current.dispatchStarted) {
        await releaseRelayBillingSession(billingState.current, "图片调用上游前失败，释放预扣", "not_dispatched");
      } else if (!upstreamCompleted && error instanceof RelayImageError && error.upstreamRefundConfirmed) {
        await releaseRelayBillingSession(billingState.current, "图片生成失败且上游已确认退款，释放预扣", "definitive_not_billable");
      } else if (!upstreamCompleted && error instanceof RelayImageError && !error.upstreamMayHaveAccepted) {
        await releaseRelayBillingSession(
          billingState.current,
          "图片上游明确拒绝且未产生成本，释放预扣",
          "definitive_not_billable",
        );
      } else if (activeChannel) {
        try {
          await markRelayBillingPending(billingState.current, activeChannel, {
            units: reservationCount,
            unit: "image",
            costMicros: 0,
            reason: error instanceof RelayImageError && error.reconcileReason
              ? error.reconcileReason
              : upstreamCompleted
                ? "image_settlement_failed"
                : "image_upstream_outcome_unknown",
            metadata: {
              requestedCount: count,
              reservedCount: reservationCount,
              returnedCount,
              errorStatus: error?.statusCode || null,
              ...(error instanceof RelayImageError ? error.reconciliationMetadata : {}),
            },
          });
        } catch (billingError: any) {
          console.error("[relayImage] 保存待核账状态失败", billingError?.message || billingError);
        }
      }
    }
    throw error;
  }
}

/**
 * Volcano Seedream native SSE bridge. The reservation uses the declared
 * sequential upper bound; only a completed terminal event with a valid
 * partial_succeeded count is settled. Disconnects and missing terminals stay
 * pending for reconciliation and are never automatically redispatched.
 */
export async function executeRelayImageStream(
  input: RelayImageRequest,
  ctx: RelayImageExecutionContext,
): Promise<RelayImageStreamResult> {
  assertImageToolsPriced(input.tools);
  if (input.sequential_image_generation !== "auto") {
    throw new RelayImageError("stream=true 要求 sequential_image_generation=auto", 400, false);
  }
  if (ctx.onProviderResult || ctx.onBeforeProviderDispatchCommit || ctx.durableCommandIdentity) {
    throw new RelayImageError("持久化创作命令暂不支持图片 SSE；请求未发送到上游", 409, false);
  }
  const requestedCount = input.n == null ? 1 : Number(input.n);
  if (!Number.isSafeInteger(requestedCount) || requestedCount < 1 || requestedCount > 10) {
    throw new RelayImageError("n 必须是 1 到 10 的整数", 400, false);
  }
  const reservationCount = imageReservationCount(input, requestedCount);
  const normalizedInput = { ...input, n: requestedCount };
  const billingState: { current: RelayBillingSession | null } = { current: null };
  let activeChannel: RelayChannel | null = null;

  try {
    const routed = await withChannelRetry(
      {
        endpointType: "image_generation",
        model: input.model,
        provider: ctx.provider,
        workspaceId: ctx.workspaceId,
        retryPolicy: "disabled",
      },
      0,
      async (channel: RelayChannel) => {
        activeChannel = channel;
        assertImageExtensionProvider(channel, normalizedInput);
        if (String(channel.provider || "").toLowerCase() !== "volcano") {
          throw new RelayImageError("图片 SSE 仅支持 Volcano Seedream 通道", 422, false);
        }
        assertRelayImageProviderOutputCount(channel.provider, requestedCount);
        const readbackAdmission = resolveRelayImageProviderReadbackAdmission(channel);
        if (!readbackAdmission.allowed) {
          throw new RelayImageError(
            "当前图片路由要求权威上游回查，但供应商通道未配置可执行回查适配器",
            409,
            false,
            {
              reason: "image_provider_readback_unsupported",
              metadata: {
                channelId: channel.id,
                provider: channel.provider,
                providerReadback: relayImageProviderReadbackBillingMetadata(readbackAdmission.capability),
              },
            },
          );
        }
        const channelInput = await bindRelayImageInputForChannel({
          request: normalizedInput,
          context: ctx,
          channel,
        });
        const trustedOutputProviderAccount = createVolcanoProviderAccountEvidence(channel.config);
        billingState.current = await beginRelayUnitBilling({
          source: "relay-image-stream",
          endpointType: "image_generation",
          model: input.model,
          channel,
          context: ctx,
          requestPayload: channelInput,
          units: reservationCount,
          unit: "image",
          expectedProvider: input.provider,
          metadata: {
            requestedCount,
            reservedCount: reservationCount,
            stream: true,
            providerReadback: relayImageProviderReadbackBillingMetadata(readbackAdmission.capability),
            trustedOutputProviderAccount,
          },
        });
        return executeImageStreamCall(
          channelInput,
          reservationCount,
          channel,
          billingState.current,
          ctx,
          readbackAdmission.capability,
        );
      },
    );
    return routed.result;
  } catch (error: any) {
    const session = billingState.current;
    if (session && !session.finalized) {
      if (!session.dispatchStarted) {
        await releaseRelayBillingSession(session, "图片流式调用上游前失败，释放预扣", "not_dispatched");
      } else if (error instanceof RelayImageError && !error.upstreamMayHaveAccepted) {
        await releaseRelayBillingSession(session, "图片流式上游明确拒绝，释放预扣", "definitive_not_billable");
      } else if (activeChannel) {
        await markRelayBillingPending(session, activeChannel, {
          units: reservationCount,
          unit: "image",
          costMicros: 0,
          reason: "image_stream_upstream_outcome_unknown",
          metadata: { requestedCount, reservedCount: reservationCount },
        });
      }
    }
    throw error;
  }
}

// 实际调用供应商的图像生成 API
async function executeImageCall(
  input: RelayImageRequest,
  count: number,
  reservationCount: number,
  channel: RelayChannel,
  billingSession: RelayBillingSession,
  context: RelayImageExecutionContext,
  readbackCapability: RelayImageProviderReadbackCapability,
  jwsRequest?: Awaited<ReturnType<typeof prepareJwsImageRequest>>,
  jwsAsync?: PreparedJwsImage,
): Promise<RelayImageResult> {
  const baseUrl = resolveChannelBaseUrl(channel);
  if (!baseUrl) throw new RelayImageError("供应商通道未配置 baseUrl", 500, false);

  // 调用供应商（OpenAI 兼容的 /images/generations；火山方舟使用 /api/v3/images/generations）
  const upstreamModel = resolveUpstreamModel(channel, input.model);
  const responseFormat = input.response_format || "url";
  const requestBody = jwsRequest?.body ?? buildRelayImageProviderRequestBody({
    request: input,
    count,
    channel,
    upstreamModel,
    responseFormat,
  });
  const multipartRequestBody = jwsRequest?.body
    && typeof (jwsRequest.body as any).getBuffer === "function"
    ? jwsRequest.body as { getBuffer: () => Buffer }
    : null;
  const multipartRequestBuffer = multipartRequestBody?.getBuffer() || null;
  const replayableJwsBody = multipartRequestBuffer || requestBody;
  const replayableJwsHeaders = multipartRequestBuffer
    ? { ...jwsRequest?.headers, "Content-Length": String(multipartRequestBuffer.length) }
    : jwsRequest?.headers;

  let providerResponse: any;
  const dispatchBoundary = await markRelayBillingDispatchStarted(
    billingSession,
    channel,
    context.onBeforeProviderDispatchCommit
      ? {
          trustedBeforeCommit: async (transaction, boundary) => {
            await context.onBeforeProviderDispatchCommit!(
              boundary,
              transaction,
              input,
            );
          },
        }
      : {},
  );
  context.onProviderDispatchCommitted?.(dispatchBoundary);
  if(jwsAsync) {
    try {
      return await executeJwsAsyncImage(jwsAsync,billingSession.requestId,async task=>{
        // Keep the upstream ID alongside the durable billing dispatch receipt.
        // Unknown outcomes are queried by this ID; never create a second task.
        await db.transaction(async transaction=>{
          const row=await transaction("o_billing_ledger").where({id:billingSession.reservationId,workspaceId:billingSession.workspaceId}).first();
          if(!row)throw new Error("JWS_DISPATCH_LEDGER_MISSING");
          const metadata=typeof row.metadata==="string"?JSON.parse(row.metadata):row.metadata||{};
          if(metadata.jwsImageTask && metadata.jwsImageTask.id!==task.id)throw new Error("JWS_DISPATCH_RECEIPT_CONFLICT");
          const updated=await transaction("o_billing_ledger").where({id:row.id,metadata:row.metadata}).update({metadata:JSON.stringify({...metadata,jwsImageTask:task})});
          if(updated!==1)throw new Error("JWS_DISPATCH_RECEIPT_CONFLICT");
        });
      },{timeoutMs:channel.timeoutMs||600000});
    } catch(error) {
      if(error instanceof JwsImageError)throw new RelayImageError(error.message,error.statusCode,error.upstreamMayHaveAccepted,{refundConfirmed:error.upstreamRefundConfirmed});
      throw new RelayImageError("图片任务结果待确认，请稍后刷新状态",502,true);
    }
  }
  try {
    const dispatched = withChannelApiKeyForDispatch(
      channel,
      {
        channelId: channel.id,
        provider: channel.provider,
        endpointType: "image_generation",
        model: input.model,
      },
      (apiKey) => {
        if (!apiKey) {
          throw new RelayImageError("供应商通道未配置 apiKey", 500, false);
        }
        // Axios' socket timeout can restart when the gateway sends data, and
        // each replay otherwise gets a fresh timeout. Bound the entire call.
        const dispatchDeadline = AbortSignal.timeout(channel.timeoutMs || 120000);
        const dispatch = () => axios.post(
          jwsRequest ? joinProviderApiPath(baseUrl, `v1/${jwsRequest.path}`) : resolveImageGenerationUrl(channel, baseUrl),
          jwsRequest ? replayableJwsBody : requestBody,
          {
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
              ...replayableJwsHeaders,
              "Idempotency-Key": billingSession.requestId,
              "X-Request-Id": billingSession.requestId,
              ...(readbackCapability.readbackSupported
                ? relayImageProviderReadbackDispatchHeaders({
                    channel,
                    providerRequestId: billingSession.requestId,
                    requestHash: billingSession.requestHash,
                  })
                : {}),
            },
            timeout: channel.timeoutMs || 120000,
            signal: dispatchDeadline,
          },
        );
        return {
          promise: dispatch().catch(async (error: unknown) => {
            if (dispatchDeadline.aborted) throw new RelayImageError(`timeout of ${channel.timeoutMs || 120000}ms exceeded`, 504, true, { metadata: { transportTimedOut: true } });
            if (!shouldRetryIdempotentImageRequest(error)) throw error;
            let retryError = error;
            for (const delayMs of idempotentImageRetryDelays(error)) {
              await waitForIdempotentImageRetry(delayMs);
              if (dispatchDeadline.aborted) throw retryError;
              try {
                return await dispatch();
              } catch (nextError) {
                retryError = nextError;
                if (!shouldRetryIdempotentImageRequest(nextError)) throw nextError;
              }
            }
            throw retryError;
          }),
        };
      },
    );
    const res = await dispatched.promise;
    providerResponse = res.data;
  } catch (err: any) {
    // Local validation failures raised before axios owns a request (for
    // example a credential disappearing between catalog admission and the
    // dispatch boundary) already carry an authoritative acceptance verdict.
    // Re-wrapping them as transport failures would erase
    // upstreamMayHaveAccepted=false and retain a reservation for a POST that
    // provably never existed.
    throw normalizeRelayImageProviderDispatchError(err);
  }

  const responseData = providerResponse?.data;
  const returnedCount = Array.isArray(responseData) ? responseData.length : null;
  const validReturnedCount = Array.isArray(responseData)
    ? responseData.filter(isValidImageEntry).length
    : 0;
  const reconciliationMetadata = { returnedCount, validReturnedCount };
  if (!Array.isArray(responseData) || responseData.length === 0) {
    throw new RelayImageError(
      "图片上游返回 2xx，但缺少有效图片结果",
      502,
      true,
      { reason: "image_upstream_result_invalid", metadata: reconciliationMetadata },
    );
  }
  if (validReturnedCount !== responseData.length) {
    throw new RelayImageError(
      "图片上游返回 2xx，但图片条目格式无效",
      502,
      true,
      { reason: "image_upstream_result_invalid", metadata: reconciliationMetadata },
    );
  }
  const sequential = input.sequential_image_generation === "auto";
  if ((!sequential && responseData.length !== count) || (sequential && responseData.length > reservationCount)) {
    throw new RelayImageError(
      `图片上游返回数量不符合请求边界（请求 ${count}，预扣上限 ${reservationCount}，返回 ${responseData.length}），需核账`,
      502,
      true,
      { reason: "image_upstream_count_mismatch", metadata: reconciliationMetadata },
    );
  }

  return {
    created: Math.floor(Date.now() / 1000),
    data: responseData,
    // 提取上游 token usage（部分提供商如火山方舟支持）
    usage: providerResponse?.usage ? {
      prompt_tokens: providerResponse.usage.prompt_tokens,
      completion_tokens: providerResponse.usage.completion_tokens,
      image_tokens: providerResponse.usage.image_tokens || providerResponse.usage.input_tokens_details?.image_tokens,
      total_tokens: providerResponse.usage.total_tokens,
    } : undefined,
  };
}

async function executeImageStreamCall(
  input: RelayImageRequest,
  reservationCount: number,
  channel: RelayChannel,
  billingSession: RelayBillingSession,
  context: RelayImageExecutionContext,
  readbackCapability: RelayImageProviderReadbackCapability,
): Promise<RelayImageStreamResult> {
  const baseUrl = resolveChannelBaseUrl(channel);
  if (!baseUrl) throw new RelayImageError("供应商通道未配置 baseUrl", 500, false);

  const requestBody = buildRelayImageProviderRequestBody({
    request: input,
    count: Number(input.n || 1),
    channel,
    upstreamModel: resolveUpstreamModel(channel, input.model),
    responseFormat: input.response_format || "url",
  });
  requestBody.stream = true;

  const upstreamAbort = new AbortController();
  const dispatchBoundary = await markRelayBillingDispatchStarted(
    billingSession,
    channel,
    context.onBeforeProviderDispatchCommit
      ? {
          trustedBeforeCommit: async (transaction, boundary) => {
            await context.onBeforeProviderDispatchCommit!(boundary, transaction, input);
          },
        }
      : {},
  );
  context.onProviderDispatchCommitted?.(dispatchBoundary);

  let response: Response;
  try {
    const dispatched = withChannelApiKeyForDispatch(
      channel,
      {
        channelId: channel.id,
        provider: channel.provider,
        endpointType: "image_generation",
        model: input.model,
      },
      (apiKey) => {
        if (!apiKey) throw new RelayImageError("供应商通道未配置 apiKey", 500, false);
        return {
          promise: fetch(resolveImageGenerationUrl(channel, baseUrl), {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
              "Idempotency-Key": billingSession.requestId,
              "X-Request-Id": billingSession.requestId,
              ...(readbackCapability.readbackSupported
                ? relayImageProviderReadbackDispatchHeaders({
                    channel,
                    providerRequestId: billingSession.requestId,
                    requestHash: billingSession.requestHash,
                  })
                : {}),
            },
            body: JSON.stringify(requestBody),
            signal: AbortSignal.any([
              upstreamAbort.signal,
              AbortSignal.timeout(channel.timeoutMs || 120_000),
            ]),
          }),
        };
      },
    );
    response = await dispatched.promise;
  } catch (error) {
    throw normalizeRelayImageProviderDispatchError(error);
  }

  if (!response.ok) {
    throw new RelayImageError(
      (await response.text()).slice(0, 2_000),
      response.status,
      upstreamMayHaveAcceptedStatus(response.status),
    );
  }
  if (!response.body) throw new RelayImageError("图片上游未返回响应流", 502, true);
  return {
    stream: trackImageStreamBilling(
      response.body,
      channel,
      billingSession,
      upstreamAbort,
      reservationCount,
    ),
    contentType: response.headers.get("content-type") || "text/event-stream; charset=utf-8",
  };
}

function trackImageStreamBilling(
  responseBody: ReadableStream<Uint8Array>,
  channel: RelayChannel,
  billingSession: RelayBillingSession,
  upstreamAbort: AbortController,
  reservationCount: number,
): ReadableStream<Uint8Array> {
  let succeededCount = 0;
  let sawCompleted = false;
  let clientCancelled = false;
  let upstreamReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let pendingPromise: Promise<void> | null = null;

  const markPendingOnce = (reason: string) => {
    if (billingSession.finalized) return Promise.resolve();
    if (!pendingPromise) {
      pendingPromise = markRelayBillingPending(billingSession, channel, {
        units: reservationCount,
        unit: "image",
        costMicros: 0,
        reason,
        metadata: { reservedCount: reservationCount, succeededCount, sawCompleted },
      });
    }
    return pendingPromise;
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = responseBody.getReader();
      upstreamReader = reader;
      const decoder = new TextDecoder();
      let buffer = "";
      const inspectLine = (line: string) => {
        if (!line.startsWith("data:")) return;
        try {
          const event = JSON.parse(line.slice(5).trimStart());
          if (event?.type === "image_generation.partial_succeeded") succeededCount += 1;
          if (event?.type === "image_generation.completed") sawCompleted = true;
        } catch {
          // Preserve non-JSON SSE lines byte-for-byte.
        }
      };
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) inspectLine(line);
          controller.enqueue(value);
        }
        buffer += decoder.decode();
        if (buffer) inspectLine(buffer);
        if (clientCancelled) return;
        if (!sawCompleted || succeededCount < 1 || succeededCount > reservationCount) {
          await markPendingOnce(!sawCompleted
            ? "image_stream_terminal_event_missing"
            : "image_stream_success_count_invalid");
          throw new BillingError("图片响应流终态或成功张数无效，预扣已保留待核账", 502);
        }
        await settleRelayUnitBilling(billingSession, channel, {
          units: succeededCount,
          unit: "image",
          metadata: { reservedCount: reservationCount, returnedCount: succeededCount, stream: true },
        });
      } catch (error: any) {
        if (!billingSession.finalized) {
          try {
            await markPendingOnce(clientCancelled
              ? "image_stream_client_cancelled"
              : "image_stream_ended_without_settlement");
          } catch (billingError: any) {
            console.error("[relayImage] 图片流式账务状态保存失败", billingError?.message || billingError);
          }
        }
        if (!clientCancelled) {
          const message = String(error?.message || "stream error").slice(0, 500);
          try {
            controller.enqueue(new TextEncoder().encode(
              `event: error\ndata: ${JSON.stringify({ error: { message } })}\n\n`,
            ));
          } catch {
            // Client may already have closed the readable side.
          }
        }
      } finally {
        upstreamReader = null;
        try { controller.close(); } catch { /* already closed */ }
      }
    },
    async cancel(reason) {
      clientCancelled = true;
      upstreamAbort.abort(reason);
      try { await upstreamReader?.cancel(reason); } catch { /* already closed */ }
      if (!billingSession.finalized) {
        try { await markPendingOnce("image_stream_client_cancelled"); } catch { /* reconciler will retain reservation */ }
      }
    },
  });
}

function resolveImageGenerationUrl(channel: RelayChannel, baseUrl: string): string {
  const root = baseUrl.replace(/\/+$/, "");
  const provider = String(channel.provider || "").toLowerCase();
  if (provider === "volcano" && !/\/api\/v3$/i.test(root)) {
    return `${root}/api/v3/images/generations`;
  }
  return `${root}/images/generations`;
}

function resolveUpstreamModel(channel: RelayChannel, requestedModel: string): string {
  const mapping = channel.config?.modelMapping as Record<string, string> | undefined;
  if (mapping && mapping[requestedModel]) return mapping[requestedModel];
  return requestedModel;
}
