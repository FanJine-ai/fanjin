// creativeLibraryApi — migrated from fanjin-web. axios → fetch (apiPost).
import { apiPost } from "./http";
import { normalizeCreativeTaskStatus } from "../utils/creativeTaskStatus";
import type { CreativeTaskStatus } from "../utils/creativeTaskStatus";

export type PublicCreationCorrelation = {
  version: 1;
  projectDigest: string | null;
  generationDigest: string;
  taskDigest: string;
  assetDigest?: string;
};

export type PublicGenerationOperation = "generate" | "extend" | "edit" | "upscale";
export type PublicGenerationBillingState = "captured" | "free" | "pending" | "released" | "unavailable";

export type PublicGenerationHistory = {
  version: 1;
  operation: PublicGenerationOperation;
  derivedFromSource: boolean;
  parentVersionDigest?: string;
  parameters: Partial<{
    sourceResolution: string;
    targetResolution: string;
    outputResolution: string;
    quality: string;
    aspectRatio: string;
    durationSeconds: number;
    audio: boolean;
  }>;
  billing: {
    state: PublicGenerationBillingState;
    currency: "GU";
    costMicros: number | null;
  };
};

export interface CreativeLibraryQuery {
  hidden?: boolean;
  correlation?: string;
  page: number;
  limit: number;
  projectId?: number;
  type?: string;
  status?: string;
  keyword?: string;
}

export interface CreativeLibraryItem {
  id: string;
  taskId?: string | null;
  assetType: "video" | "image" | "audio" | "file" | string;
  url: string;
  mimeType?: string;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
  status: CreativeTaskStatus;
  preparationStage?: "portrait_registration" | null;
  statusMessage?: string | null;
  endpointType?: string;
  model?: string;
  source: string;
  requestId?: string;
  prompt?: string;
  projectId?: number | null;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
  correlation?: PublicCreationCorrelation;
  generationHistory?: PublicGenerationHistory;
  contentSha256?: string;
  createdAt: number;
}

export interface CreativeLibraryResult {
  data: CreativeLibraryItem[];
  total: number;
  page: number;
  limit: number;
}

export const CREATIVE_LIBRARY_PAGE_SIZE = 60 as const;
const CREATIVE_LIBRARY_MAX_PAGES = 1_000;

function responseRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requiredText(
  source: Record<string, unknown>,
  field: string,
  rowNumber: number,
): string {
  const value = source[field];
  if ((typeof value !== "string" && typeof value !== "number") || !String(value).trim()) {
    throw new Error(`创意库第 ${rowNumber} 条记录缺少 ${field}，已阻止展示不完整数据`);
  }
  return String(value);
}

function optionalNumber(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (value === undefined || value === "") return undefined;
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : undefined;
}

function sha256Value(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : undefined;
}

function correlationValue(value: unknown): PublicCreationCorrelation | undefined {
  const record = responseRecord(value);
  if (!record || record.version !== 1) return undefined;
  const generationDigest = sha256Value(record.generationDigest);
  const taskDigest = sha256Value(record.taskDigest);
  const projectDigest = record.projectDigest === null
    ? null
    : sha256Value(record.projectDigest);
  const assetDigest = sha256Value(record.assetDigest);
  if (!generationDigest || !taskDigest || projectDigest === undefined) return undefined;
  return {
    version: 1,
    projectDigest,
    generationDigest,
    taskDigest,
    ...(assetDigest ? { assetDigest } : {}),
  };
}

const GENERATION_OPERATIONS = new Set<PublicGenerationOperation>([
  "generate",
  "extend",
  "edit",
  "upscale",
]);
const GENERATION_BILLING_STATES = new Set<PublicGenerationBillingState>([
  "captured",
  "free",
  "pending",
  "released",
  "unavailable",
]);
const GENERATION_PARAMETER_FIELDS = new Set([
  "sourceResolution",
  "targetResolution",
  "outputResolution",
  "quality",
  "aspectRatio",
  "durationSeconds",
  "audio",
]);

function generationHistoryValue(
  value: unknown,
  rowNumber: number,
): PublicGenerationHistory | undefined {
  if (value === undefined || value === null) return undefined;
  const history = responseRecord(value);
  const parameters = responseRecord(history?.parameters);
  const billing = responseRecord(history?.billing);
  const operation = history?.operation;
  const billingState = billing?.state;
  const digest = history?.parentVersionDigest === undefined
    ? undefined
    : sha256Value(history.parentVersionDigest);
  const costMicros = billing?.costMicros === null
    ? null
    : Number(billing?.costMicros);
  const validCostMicros = costMicros === null
    || (Number.isSafeInteger(costMicros) && costMicros >= 0);
  if (
    !history
    || history.version !== 1
    || typeof operation !== "string"
    || !GENERATION_OPERATIONS.has(operation as PublicGenerationOperation)
    || typeof history.derivedFromSource !== "boolean"
    || !parameters
    || Object.keys(parameters).some((key) => !GENERATION_PARAMETER_FIELDS.has(key))
    || !billing
    || typeof billingState !== "string"
    || !GENERATION_BILLING_STATES.has(billingState as PublicGenerationBillingState)
    || billing.currency !== "GU"
    || !validCostMicros
    || (history.parentVersionDigest !== undefined && !digest)
    || (history.derivedFromSource && !digest)
    || (!history.derivedFromSource && history.parentVersionDigest !== undefined)
  ) {
    throw new Error(`创意库第 ${rowNumber} 条记录 generationHistory 格式无效，已阻止展示不完整数据`);
  }

  const normalizedParameters: PublicGenerationHistory["parameters"] = {};
  for (const [key, parameterValue] of Object.entries(parameters)) {
    if (
      (key === "durationSeconds" && typeof parameterValue === "number" && Number.isFinite(parameterValue) && parameterValue >= 0)
      || (key === "audio" && typeof parameterValue === "boolean")
      || (!["durationSeconds", "audio"].includes(key) && typeof parameterValue === "string" && parameterValue.trim())
    ) {
      (normalizedParameters as Record<string, string | number | boolean>)[key] = parameterValue as string | number | boolean;
    } else {
      throw new Error(`创意库第 ${rowNumber} 条记录 generationHistory 参数无效，已阻止展示不完整数据`);
    }
  }
  return {
    version: 1,
    operation: operation as PublicGenerationOperation,
    derivedFromSource: history.derivedFromSource,
    ...(digest ? { parentVersionDigest: digest } : {}),
    parameters: normalizedParameters,
    billing: {
      state: billingState as PublicGenerationBillingState,
      currency: "GU",
      costMicros,
    },
  };
}

const CREATIVE_LIBRARY_STATUSES = new Set([
  "queued",
  "running",
  "enhancing",
  "succeeded",
  "failed",
  "cancelled",
  "mocked",
]);

export function normalizeCreativeLibraryResponse(value: unknown): CreativeLibraryResult {
  const source = responseRecord(value);
  if (!source || !Array.isArray(source.data)) {
    throw new Error("创意库响应格式无效，已阻止展示空数据");
  }

  const total = Number(source.total);
  const page = Number(source.page);
  const limit = Number(source.limit);
  if (
    !Number.isSafeInteger(total)
    || total < 0
    || !Number.isSafeInteger(page)
    || page <= 0
    || !Number.isSafeInteger(limit)
    || limit <= 0
  ) {
    throw new Error("创意库分页响应格式无效，已阻止展示不完整数据");
  }

  const normalizedRows = source.data.map((entry, index): {
    item: CreativeLibraryItem;
    mocked: boolean;
  } => {
    const row = responseRecord(entry);
    if (!row) {
      throw new Error(`创意库第 ${index + 1} 条记录格式无效，已阻止展示不完整数据`);
    }
    const rawStatus = requiredText(row, "status", index + 1);
    if (!CREATIVE_LIBRARY_STATUSES.has(rawStatus.trim().toLowerCase())) {
      throw new Error(`创意库第 ${index + 1} 条记录 status 无效，已阻止展示不完整数据`);
    }
    const createdAt = Number(row.createdAt);
    if (!Number.isFinite(createdAt) || createdAt < 0) {
      throw new Error(`创意库第 ${index + 1} 条记录缺少有效 createdAt，已阻止展示不完整数据`);
    }
    if (
      row.metadata !== undefined
      && row.metadata !== null
      && !responseRecord(row.metadata)
    ) {
      throw new Error(`创意库第 ${index + 1} 条记录 metadata 格式无效，已阻止展示不完整数据`);
    }

    const taskId = row.taskId === null || row.taskId === undefined || row.taskId === ""
      ? null
      : String(row.taskId);
    const projectId = optionalNumber(row.projectId);
    if (typeof row.url !== "string") {
      throw new Error(`创意库第 ${index + 1} 条记录缺少有效 url，已阻止展示不完整数据`);
    }
    return {
      mocked: rawStatus.trim().toLowerCase() === "mocked",
      item: {
        ...row,
        id: requiredText(row, "id", index + 1),
        taskId,
        assetType: requiredText(row, "assetType", index + 1),
        url: row.url,
        mimeType: typeof row.mimeType === "string" ? row.mimeType : undefined,
        width: optionalNumber(row.width),
        height: optionalNumber(row.height),
        durationMs: optionalNumber(row.durationMs),
        status: normalizeCreativeTaskStatus(rawStatus),
        preparationStage: row.preparationStage === "portrait_registration" ? "portrait_registration" as const : null,
        statusMessage: typeof row.statusMessage === "string" ? row.statusMessage : null,
        endpointType: typeof row.endpointType === "string" ? row.endpointType : undefined,
        model: typeof row.model === "string" ? row.model : undefined,
        source: requiredText(row, "source", index + 1),
        requestId: typeof row.requestId === "string" ? row.requestId : undefined,
        prompt: typeof row.prompt === "string" ? row.prompt : undefined,
        projectId: projectId === undefined ? null : projectId,
        errorMessage: typeof row.errorMessage === "string" ? row.errorMessage : undefined,
        metadata: responseRecord(row.metadata) ?? undefined,
        correlation: correlationValue(row.correlation),
        generationHistory: generationHistoryValue(row.generationHistory, index + 1),
        contentSha256: sha256Value(row.contentSha256),
        createdAt,
      },
    };
  });

  return {
    data: normalizedRows.filter((row) => !row.mocked).map((row) => row.item),
    total,
    page,
    limit,
  };
}

export type CreativeLibraryDeleteItemResult =
  | {
      id: string;
      status: "accepted";
      operation?: unknown;
    }
  | {
      id: string;
      status: "rejected";
      code?: string;
      httpStatus?: number;
      message?: string;
    };

export interface CreativeLibraryDeleteResult {
  requested: number;
  accepted: number;
  rejected: number;
  results: CreativeLibraryDeleteItemResult[];
}

export async function listCreativeLibrary(payload: CreativeLibraryQuery, signal?: AbortSignal): Promise<CreativeLibraryResult> {
  if (
    !Number.isSafeInteger(payload.page)
    || payload.page <= 0
    || !Number.isSafeInteger(payload.limit)
    || payload.limit <= 0
    || payload.limit > CREATIVE_LIBRARY_PAGE_SIZE
  ) {
    throw new Error(`创意库分页参数无效；单页最多 ${CREATIVE_LIBRARY_PAGE_SIZE} 条`);
  }
  const body = payload as unknown as Record<string, unknown>;
  const result = signal
    ? await apiPost<unknown>("/workbench/library/list", body, undefined, { signal })
    : await apiPost<unknown>("/workbench/library/list", body);
  return normalizeCreativeLibraryResponse(result);
}

export type CompleteCreativeLibraryQuery = Omit<CreativeLibraryQuery, "page" | "limit">;

/** Load every page using the API route's real, fixed maximum page width. */
export async function listCompleteCreativeLibrary(
  payload: CompleteCreativeLibraryQuery = {},
): Promise<CreativeLibraryItem[]> {
  const rows: CreativeLibraryItem[] = [];
  const seenIds = new Set<string>();
  let expectedTotal: number | null = null;
  for (let page = 1; page <= CREATIVE_LIBRARY_MAX_PAGES; page += 1) {
    const result = await listCreativeLibrary({
      ...payload,
      page,
      limit: CREATIVE_LIBRARY_PAGE_SIZE,
    });
    if (result.page !== page || result.limit !== CREATIVE_LIBRARY_PAGE_SIZE) {
      throw new Error("创意库分页游标与服务端响应不一致，已阻止展示不完整数据");
    }
    if (expectedTotal === null) expectedTotal = result.total;
    if (result.total !== expectedTotal) {
      throw new Error("创意库分页总数在读取期间发生变化，已阻止展示不完整数据");
    }
    if (result.data.length > CREATIVE_LIBRARY_PAGE_SIZE) {
      throw new Error("创意库单页返回数量超限，已阻止展示不完整数据");
    }
    for (const item of result.data) {
      if (seenIds.has(item.id)) {
        throw new Error("创意库分页返回重复记录，已阻止展示不完整数据");
      }
      seenIds.add(item.id);
      rows.push(item);
    }
    if (rows.length > expectedTotal) {
      throw new Error("创意库分页返回数量超过总数，已阻止展示不完整数据");
    }
    if (rows.length === expectedTotal) return rows;
    if (result.data.length < CREATIVE_LIBRARY_PAGE_SIZE) {
      throw new Error("创意库分页提前结束，已阻止展示不完整数据");
    }
  }
  throw new Error("创意库分页超过安全上限，已阻止展示不完整数据");
}

export async function deleteCreativeLibraryItems(ids: string[]): Promise<CreativeLibraryDeleteResult> {
  return apiPost<CreativeLibraryDeleteResult>("/workbench/library/delete", { ids });
}
