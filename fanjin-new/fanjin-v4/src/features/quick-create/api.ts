import { GU_MICROS_PER_GU, formatYuanFromGuMicros } from "@/utils/billingUnits";
import { apiDelete, apiGet, apiPost } from "../../api/http";
import type { UploadedReferenceAsset } from "./attachments/api";
import { normalizeCreativeTaskStatus } from "./status";
import type {
  QuickCreateDirectorPayload,
  QuickCreateDirectorPlan,
  QuickCreateImagePayload,
  QuickCreateImageResult,
  QuickCreateMaterializePayload,
  QuickCreateMaterializedProject,
  QuickCreateVideoPayload,
  QuickCreateVideoTask,
} from "./types";

export type QuickCreatePricingSubmissionOptions = Readonly<{
  acceptedUnitMaximumCostMicros?: number;
  /** Set only by the explicit price confirmation action. Receiving a quote is not consent. */
  confirmPricing?: boolean;
}>;

type PricingConfirmationCacheEntry = {
  token: string;
  expiresAt: number;
  requestFingerprint: string;
};

type ImagePricingContext = {
  batchIdempotencyKey: string;
  batchSize: number;
  itemIndex: number;
};

const pricingConfirmationCache = new Map<string, PricingConfirmationCacheEntry>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function pricingCacheKey(kind: "image" | "video", idempotencyKey?: string): string | null {
  const normalizedKey = String(idempotencyKey || "").trim();
  return normalizedKey ? `${kind}:${normalizedKey}` : null;
}

function acceptedMaximumCost(options?: QuickCreatePricingSubmissionOptions): number | undefined {
  const value = options?.acceptedUnitMaximumCostMicros;
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("已接受的最高费用必须是正整数");
  }
  return value;
}

function activePricingConfirmation(cacheKey: string | null, requestFingerprint?: string): PricingConfirmationCacheEntry | null {
  if (!cacheKey) return null;
  const cached = pricingConfirmationCache.get(cacheKey);
  if (!cached) return null;
  if (Date.now() >= cached.expiresAt || (requestFingerprint !== undefined && cached.requestFingerprint !== requestFingerprint)) {
    pricingConfirmationCache.delete(cacheKey);
    return null;
  }
  return cached;
}

function pricingAuthorization(
  cacheKey: string | null,
  requestFingerprint: string,
  options?: QuickCreatePricingSubmissionOptions,
): { token?: string; acceptedUnitMaximumCostMicros?: number } {
  const cached = activePricingConfirmation(cacheKey, requestFingerprint);
  if (options?.confirmPricing) return cached ? { token: cached.token } : {};
  const accepted = acceptedMaximumCost(options);
  return accepted === undefined ? {} : { acceptedUnitMaximumCostMicros: accepted };
}

function capturePricingConfirmation(error: unknown, cacheKey: string | null, requestFingerprint: string): void {
  if (!cacheKey || !isRecord(error)) return;
  const status = Number(error.status || 0);
  const code = String(error.code || "");
  if (status !== 409) return;
  if (code === "pricing_confirmation_invalid") {
    pricingConfirmationCache.delete(cacheKey);
    return;
  }
  if (code !== "pricing_confirmation_required" || !isRecord(error.details)) return;
  const token = typeof error.details.pricingConfirmationToken === "string"
    ? error.details.pricingConfirmationToken.trim()
    : "";
  const expiresAt = Number(error.details.expiresAt);
  const totalMaximumCostMicros = Number(error.details.totalMaximumCostMicros);
  if (
    !token
    || token.length > 16_384
    || !Number.isSafeInteger(expiresAt)
    || expiresAt <= Date.now()
    || !Number.isSafeInteger(totalMaximumCostMicros)
    || totalMaximumCostMicros <= 0
    || String(error.details.currency || "") !== "GU"
  ) {
    pricingConfirmationCache.delete(cacheKey);
    return;
  }
  const maximumCostGu = Number((totalMaximumCostMicros / GU_MICROS_PER_GU).toFixed(6));
  try {
    error.message = cacheKey.startsWith("video:")
      ? `本批次预扣 ${maximumCostGu} GU（约 ${formatYuanFromGuMicros(totalMaximumCostMicros)}）；完成后按实际用量结算并退回差额，请确认后生成`
      : `价格已更新，本批次最高 ${maximumCostGu} GU；请再次点击确认`;
  } catch {
    // A frozen third-party error still carries a valid cached confirmation;
    // the original server message remains available to the UI.
  }
  pricingConfirmationCache.set(cacheKey, { token, expiresAt, requestFingerprint });
}

function clearPricingConfirmation(cacheKey: string | null): void {
  if (cacheKey) pricingConfirmationCache.delete(cacheKey);
}

export type InspirationWorkspaceState = {
  projectId: number | null;
  references: UploadedReferenceAsset[];
};

export function getInspirationWorkspaceState(): Promise<InspirationWorkspaceState> {
  return apiGet<InspirationWorkspaceState>("/workbench/create/inspirationWorkspace");
}

export async function generateDirectorPlan(
  payload: QuickCreateDirectorPayload,
  signal?: AbortSignal,
  idempotencyKey?: string,
): Promise<QuickCreateDirectorPlan> {
  const response = await apiPost<{ plan: QuickCreateDirectorPlan }, QuickCreateDirectorPayload>(
    "/workbench/create/directorPlan",
    payload,
    undefined,
    {
      signal,
      ...(idempotencyKey
        ? { headers: { "Idempotency-Key": idempotencyKey } }
        : {}),
    },
  );
  return response.plan;
}

export function materializeDirectorPlan(
  payload: QuickCreateMaterializePayload,
  idempotencyKey?: string,
): Promise<QuickCreateMaterializedProject> {
  return apiPost<QuickCreateMaterializedProject, QuickCreateMaterializePayload>(
    "/workbench/create/materialize",
    payload,
    undefined,
    idempotencyKey
      ? { headers: { "Idempotency-Key": idempotencyKey } }
      : undefined,
  );
}

export async function generateQuickCreateVideos(
  payload: QuickCreateVideoPayload,
  idempotencyKey?: string,
  pricingOptions?: QuickCreatePricingSubmissionOptions,
): Promise<QuickCreateVideoTask[]> {
  const cacheKey = pricingCacheKey("video", idempotencyKey);
  const requestFingerprint = JSON.stringify(payload);
  const authorization = pricingAuthorization(cacheKey, requestFingerprint, pricingOptions);
  const requestPayload = Object.keys(authorization).length
    ? { ...payload, pricingConfirmation: authorization }
    : payload;
  let response: Array<Partial<QuickCreateVideoTask>>;
  try {
    response = await apiPost<
      Array<Partial<QuickCreateVideoTask>>,
      QuickCreateVideoPayload & {
        pricingConfirmation?: {
          token?: string;
          acceptedUnitMaximumCostMicros?: number;
        };
      }
    >(
      "/workbench/create/videos",
      requestPayload,
      undefined,
      idempotencyKey
        ? { headers: { "Idempotency-Key": idempotencyKey } }
        : undefined,
    );
  } catch (error) {
    capturePricingConfirmation(error, cacheKey, requestFingerprint);
    throw error;
  }
  clearPricingConfirmation(cacheKey);
  return response.map((item) => ({
    ...item,
    videoId: Number(item.videoId),
    trackId: Number(item.trackId),
    status: normalizeCreativeTaskStatus(item.status || item.state || (item.errorReason ? "failed" : "queued")),
  }));
}

export async function listQuickCreateTasks(projectId: number): Promise<QuickCreateVideoTask[]> {
  const response = await apiPost<Array<Partial<QuickCreateVideoTask>>, { projectId: number }>("/workbench/create/tasks", { projectId });
  return response.map((item) => ({
    ...item,
    videoId: Number(item.videoId),
    trackId: Number(item.trackId),
    status: normalizeCreativeTaskStatus(item.status || item.state),
  }));
}

export function cancelQuickCreateTask(relayTaskId: string): Promise<Record<string, unknown>> {
  return apiDelete<Record<string, unknown>>(
    `/workbench/canvas/tasks/${encodeURIComponent(relayTaskId)}`,
  );
}

async function generateQuickCreateImageUnit(
  payload: QuickCreateImagePayload,
  idempotencyKey: string | undefined,
  pricingContext: ImagePricingContext | null,
  pricingOptions?: QuickCreatePricingSubmissionOptions,
): Promise<QuickCreateImageResult> {
  const cacheKey = pricingCacheKey("image", pricingContext?.batchIdempotencyKey || idempotencyKey);
  const requestFingerprint = JSON.stringify({ payload, batchSize: pricingContext?.batchSize || 1 });
  const authorization = pricingAuthorization(cacheKey, requestFingerprint, pricingOptions);
  const pricingConfirmation = pricingContext
    ? { ...authorization, ...pricingContext }
    : Object.keys(authorization).length
      ? authorization
      : null;
  const requestPayload = pricingConfirmation
    ? { ...payload, pricingConfirmation }
    : payload;
  try {
    return await apiPost<
      QuickCreateImageResult,
      QuickCreateImagePayload & {
        pricingConfirmation?: {
          token?: string;
          acceptedUnitMaximumCostMicros?: number;
          batchIdempotencyKey?: string;
          batchSize?: number;
          itemIndex?: number;
        };
      }
    >(
      "/workbench/create/images",
      requestPayload,
      undefined,
      idempotencyKey
        ? { headers: { "Idempotency-Key": idempotencyKey } }
        : undefined,
    );
  } catch (error) {
    capturePricingConfirmation(error, cacheKey, requestFingerprint);
    throw error;
  }
}

export async function generateQuickCreateImages(
  payload: QuickCreateImagePayload,
  idempotencyKey?: string,
  pricingOptions?: QuickCreatePricingSubmissionOptions,
): Promise<QuickCreateImageResult> {
  const cacheKey = pricingCacheKey("image", idempotencyKey);
  const hasPricingAuthorization = (
    acceptedMaximumCost(pricingOptions) !== undefined
    || Boolean(pricingOptions?.confirmPricing && activePricingConfirmation(cacheKey, JSON.stringify({ payload, batchSize: 1 })))
  );
  const result = await generateQuickCreateImageUnit(
    payload,
    idempotencyKey,
    idempotencyKey && hasPricingAuthorization
      ? { batchIdempotencyKey: idempotencyKey, batchSize: 1, itemIndex: 1 }
      : null,
    pricingOptions,
  );
  clearPricingConfirmation(cacheKey);
  return result;
}

/**
 * Volcano image generation accepts exactly one output per provider request.
 * Quick Create still offers a JiMeng-style 1-8 batch by issuing independent,
 * durably idempotent unit requests and merging their persisted assets.
 */
export async function generateQuickCreateImageBatch(
  payload: QuickCreateImagePayload,
  idempotencyKey?: string,
  pricingOptions?: QuickCreatePricingSubmissionOptions,
): Promise<QuickCreateImageResult> {
  const requestedCount = Number(payload.count ?? 1);
  if (!Number.isSafeInteger(requestedCount) || requestedCount < 1 || requestedCount > 8) {
    throw new Error("图片生成数量必须是 1 到 8 的整数");
  }
  if (requestedCount === 1) {
    return generateQuickCreateImages(payload, idempotencyKey, pricingOptions);
  }
  if (!idempotencyKey) {
    throw new Error("图片批次生成需要稳定的幂等标识");
  }

  const unitPayload: QuickCreateImagePayload = { ...payload, count: 1 };
  const cacheKey = pricingCacheKey("image", idempotencyKey);
  const hasAcceptedPrice = acceptedMaximumCost(pricingOptions) !== undefined;
  const hasCachedConfirmation = Boolean(pricingOptions?.confirmPricing && activePricingConfirmation(cacheKey, JSON.stringify({ payload: unitPayload, batchSize: requestedCount })));
  const submitUnit = (index: number) => generateQuickCreateImageUnit(
    unitPayload,
    `${idempotencyKey}:item:${index + 1}`,
    {
      batchIdempotencyKey: idempotencyKey,
      batchSize: requestedCount,
      itemIndex: index + 1,
    },
    pricingOptions,
  );
  let results: QuickCreateImageResult[];
  if (hasAcceptedPrice || hasCachedConfirmation) {
    results = await Promise.all(Array.from({ length: requestedCount }, (_, index) => submitUnit(index)));
  } else {
    // A batch without a price accepted by the user probes one deterministic
    // item only. The expected 409 caches a batch-bound token; no other local
    // task is created until the user explicitly confirms and retries.
    results = [await submitUnit(0)];
    for (let index = 1; index < requestedCount; index += 1) {
      results.push(await submitUnit(index));
    }
  }
  clearPricingConfirmation(cacheKey);
  const assets = results.flatMap((result) => result.assets || []);
  if (assets.length !== requestedCount) {
    throw new Error(`图片批次结果不完整：预计 ${requestedCount} 张，实际 ${assets.length} 张`);
  }
  return {
    model: results[0]?.model || String(payload.model || ""),
    count: assets.length,
    assets,
  };
}
