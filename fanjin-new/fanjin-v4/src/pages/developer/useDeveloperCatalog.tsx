import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { apiPost } from "../../api/http";
import { useWorkspaceStore } from "../../stores/workspaceStore";

export const DEVELOPER_ENDPOINT_TYPES = [
  "text",
  "embedding",
  "multimodal_embedding",
  "transcription",
  "tts",
  "rerank",
  "video_generation",
  "image_generation",
] as const;

export type DeveloperEndpointType = (typeof DEVELOPER_ENDPOINT_TYPES)[number];
export type CatalogStatus = "active" | "unavailable";

export type CatalogItem = {
  model: string;
  name: string;
  endpointType: DeveloperEndpointType;
  status: CatalogStatus;
  resolutions: string[];
  defaultResolution: string | null;
  qualities: string[];
  defaultQuality: string | null;
  pricing: {
    unit: string;
    currency: string;
    unitPriceMicros: number;
  } | null;
};

export type CatalogSummary = {
  total: number;
  active: number;
  unavailable: number;
};

export type DeveloperCatalog = {
  items: CatalogItem[];
  summary: CatalogSummary;
};

export type CatalogLoadState = {
  loading: boolean;
  error: string;
  catalog: DeveloperCatalog;
  workspaceId: string;
  retry: () => void;
};

const endpointTypeSet = new Set<string>(DEVELOPER_ENDPOINT_TYPES);
const emptySummary: CatalogSummary = { total: 0, active: 0, unavailable: 0 };
export const emptyCatalog: DeveloperCatalog = { items: [], summary: emptySummary };

type OwnDataResult =
  | { ok: true; value: unknown }
  | { ok: false };

export class DeveloperCatalogContractError extends Error {
  constructor() {
    super("模型目录返回了不受支持的数据，已停止显示。");
    this.name = "DeveloperCatalogContractError";
  }
}

function contractError(): never {
  throw new DeveloperCatalogContractError();
}

function ownDataProperty(value: unknown, key: string): OwnDataResult {
  if (
    value === null
    || (typeof value !== "object" && typeof value !== "function")
  ) {
    return { ok: false };
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return { ok: false };
    return { ok: true, value: descriptor.value };
  } catch {
    return { ok: false };
  }
}

function ownArrayItems(value: unknown): unknown[] {
  if (!Array.isArray(value)) return contractError();
  const lengthProperty = ownDataProperty(value, "length");
  if (
    !lengthProperty.ok
    || typeof lengthProperty.value !== "number"
    || !Number.isSafeInteger(lengthProperty.value)
    || lengthProperty.value < 0
    || lengthProperty.value > 10_000
  ) {
    return contractError();
  }

  const result: unknown[] = [];
  for (let index = 0; index < lengthProperty.value; index += 1) {
    const item = ownDataProperty(value, String(index));
    if (!item.ok) return contractError();
    result.push(item.value);
  }
  return result;
}

function requiredString(
  value: unknown,
  options: { maxLength: number },
): string {
  if (typeof value !== "string") return contractError();
  const normalized = value.trim();
  if (!normalized || normalized.length > options.maxLength) return contractError();
  return normalized;
}

function requiredCount(value: unknown): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 0
  ) {
    return contractError();
  }
  return value;
}

function optionalStringList(raw: unknown, key: string): string[] {
  const property = ownDataProperty(raw, key);
  if (!property.ok) return [];
  const result: string[] = [];
  for (const item of ownArrayItems(property.value)) {
    const value = requiredString(item, { maxLength: 40 });
    if (!result.includes(value)) result.push(value);
  }
  return result;
}

function optionalDefault(raw: unknown, key: string, values: string[]): string | null {
  const property = ownDataProperty(raw, key);
  if (!property.ok || property.value === null) return null;
  const value = requiredString(property.value, { maxLength: 40 });
  if (!values.includes(value)) return contractError();
  return value;
}

function optionalPricing(raw: unknown): CatalogItem["pricing"] {
  const property = ownDataProperty(raw, "pricing");
  if (!property.ok || property.value === null) return null;
  const unit = ownDataProperty(property.value, "unit");
  const currency = ownDataProperty(property.value, "currency");
  const unitPriceMicros = ownDataProperty(property.value, "unitPriceMicros");
  if (!unit.ok || !currency.ok || !unitPriceMicros.ok) return contractError();
  const price = requiredCount(unitPriceMicros.value);
  if (price <= 0) return contractError();
  return {
    unit: requiredString(unit.value, { maxLength: 40 }),
    currency: requiredString(currency.value, { maxLength: 16 }),
    unitPriceMicros: price,
  };
}

function parseCatalogItem(raw: unknown): CatalogItem {
  const modelProperty = ownDataProperty(raw, "model");
  const nameProperty = ownDataProperty(raw, "name");
  const endpointProperty = ownDataProperty(raw, "endpointType");
  const statusProperty = ownDataProperty(raw, "status");
  if (
    !modelProperty.ok
    || !nameProperty.ok
    || !endpointProperty.ok
    || !statusProperty.ok
  ) {
    return contractError();
  }

  const model = requiredString(modelProperty.value, { maxLength: 200 });
  const name = requiredString(nameProperty.value, { maxLength: 120 });
  const endpointType = requiredString(endpointProperty.value, { maxLength: 40 });
  const status = requiredString(statusProperty.value, { maxLength: 20 });
  if (!endpointTypeSet.has(endpointType)) return contractError();
  if (status !== "active" && status !== "unavailable") return contractError();

  const resolutions = optionalStringList(raw, "resolutions");
  const qualities = optionalStringList(raw, "qualities");

  // Project only the public publication contract consumed by Developer pages.
  // Provider, channel and credential fields can never reach React state.
  return {
    model,
    name,
    endpointType: endpointType as DeveloperEndpointType,
    status,
    resolutions,
    defaultResolution: optionalDefault(raw, "defaultResolution", resolutions),
    qualities,
    defaultQuality: optionalDefault(raw, "defaultQuality", qualities),
    pricing: optionalPricing(raw),
  };
}

export function parseDeveloperCatalog(
  raw: unknown,
  expectedWorkspaceId = "",
): DeveloperCatalog {
  const itemsProperty = ownDataProperty(raw, "items");
  const summaryProperty = ownDataProperty(raw, "summary");
  if (!itemsProperty.ok || !summaryProperty.ok) return contractError();

  const items = ownArrayItems(itemsProperty.value).map(parseCatalogItem);
  const seen = new Set<string>();
  for (const item of items) {
    const key = `${item.endpointType}\u0000${item.model}`;
    if (seen.has(key)) return contractError();
    seen.add(key);
  }

  const totalProperty = ownDataProperty(summaryProperty.value, "total");
  const activeProperty = ownDataProperty(summaryProperty.value, "active");
  const unavailableProperty = ownDataProperty(summaryProperty.value, "unavailable");
  if (!totalProperty.ok || !activeProperty.ok || !unavailableProperty.ok) {
    return contractError();
  }

  const summary = {
    total: requiredCount(totalProperty.value),
    active: requiredCount(activeProperty.value),
    unavailable: requiredCount(unavailableProperty.value),
  };
  const activeCount = items.filter((item) => item.status === "active").length;
  const unavailableCount = items.length - activeCount;
  if (
    summary.total !== items.length
    || summary.active !== activeCount
    || summary.unavailable !== unavailableCount
    || summary.active + summary.unavailable !== summary.total
  ) {
    return contractError();
  }

  const workspaceProperty = ownDataProperty(raw, "workspaceId");
  if (expectedWorkspaceId && !workspaceProperty.ok) return contractError();
  if (workspaceProperty.ok) {
    const responseWorkspaceId = requiredString(
      workspaceProperty.value,
      { maxLength: 200 },
    );
    if (expectedWorkspaceId && responseWorkspaceId !== expectedWorkspaceId) {
      return contractError();
    }
  }

  return { items, summary };
}

function errorStatus(error: unknown): number | undefined {
  const status = ownDataProperty(error, "status");
  return status.ok && typeof status.value === "number"
    ? status.value
    : undefined;
}

export function developerCatalogErrorMessage(error: unknown): string {
  if (error instanceof DeveloperCatalogContractError) return error.message;
  const status = errorStatus(error);
  if (status === 401) return "登录状态已失效，无法读取当前工作区模型目录（401）。";
  if (status === 403) return "无权读取当前工作区模型目录（403）。";
  if (status === 503) return "模型目录服务暂不可用（503），请稍后重试。";
  return "模型目录读取失败，请稍后重试。";
}

function workspaceKey(value: string | number | null): string {
  return value == null ? "" : String(value).trim();
}

type InternalCatalogState = Omit<CatalogLoadState, "retry">;

const DeveloperCatalogContext = createContext<CatalogLoadState | null>(null);

export function DeveloperCatalogProvider({ children }: { children: ReactNode }) {
  const currentWorkspaceId = useWorkspaceStore((state) => state.currentWorkspaceId);
  const requestedWorkspaceId = workspaceKey(currentWorkspaceId);
  const requestGeneration = useRef(0);
  const [retryKey, setRetryKey] = useState(0);
  const [state, setState] = useState<InternalCatalogState>({
    loading: true,
    error: "",
    catalog: emptyCatalog,
    workspaceId: requestedWorkspaceId,
  });

  const retry = useCallback(() => setRetryKey((key) => key + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    const generation = ++requestGeneration.current;
    setState({
      loading: true,
      error: "",
      catalog: emptyCatalog,
      workspaceId: requestedWorkspaceId,
    });

    const payload: Record<string, unknown> = {};
    if (requestedWorkspaceId) payload.workspaceId = requestedWorkspaceId;

    void apiPost<unknown>(
      "/developer/models",
      payload,
      undefined,
      { signal: controller.signal },
    )
      .then((raw) => {
        if (
          controller.signal.aborted
          || generation !== requestGeneration.current
        ) {
          return;
        }
        const catalog = parseDeveloperCatalog(raw, requestedWorkspaceId);
        setState({
          loading: false,
          error: "",
          catalog,
          workspaceId: requestedWorkspaceId,
        });
      })
      .catch((error: unknown) => {
        if (
          controller.signal.aborted
          || generation !== requestGeneration.current
        ) {
          return;
        }
        setState({
          loading: false,
          error: developerCatalogErrorMessage(error),
          catalog: emptyCatalog,
          workspaceId: requestedWorkspaceId,
        });
      });

    return () => {
      controller.abort();
    };
  }, [requestedWorkspaceId, retryKey]);

  // A store update renders before the effect for the new workspace runs.
  // Never expose the previous workspace's catalog during that render.
  const visibleState = state.workspaceId === requestedWorkspaceId
    ? state
    : {
        loading: true,
        error: "",
        catalog: emptyCatalog,
        workspaceId: requestedWorkspaceId,
      };
  const value = useMemo(
    () => ({ ...visibleState, retry }),
    [retry, visibleState],
  );

  return (
    <DeveloperCatalogContext.Provider value={value}>
      {children}
    </DeveloperCatalogContext.Provider>
  );
}

export function useDeveloperCatalog(): CatalogLoadState {
  const context = useContext(DeveloperCatalogContext);
  if (!context) {
    throw new Error("useDeveloperCatalog 必须在 DeveloperCatalogProvider 内使用");
  }
  return context;
}

export function activeModels(
  catalog: DeveloperCatalog,
  endpointTypes?: readonly DeveloperEndpointType[],
): CatalogItem[] {
  return catalog.items.filter((item) => {
    if (item.status !== "active") return false;
    if (!endpointTypes || endpointTypes.length === 0) return true;
    return endpointTypes.includes(item.endpointType);
  });
}

export function firstActiveModel(
  catalog: DeveloperCatalog,
  endpointTypes: readonly DeveloperEndpointType[],
): string {
  return activeModels(catalog, endpointTypes)[0]?.model ?? "";
}
