const TOKEN_STORAGE_KEY = "fanjin-react-v4:token";
const AUTH_STORE_STORAGE_KEY = "fanjin-auth";

let unauthorizedSessionHandler: ((token: string) => void) | undefined;

/** The auth store revalidates a rejected session without retrying the operation. */
export function setUnauthorizedSessionHandler(handler: (token: string) => void) {
  unauthorizedSessionHandler = handler;
}

export type ApiSettings = {
  baseUrl: string;
  token: string;
};

export type ApiRequestOptions = {
  signal?: AbortSignal;
  headers?: HeadersInit;
  keepalive?: boolean;
  /** Actual request-body upload percentage; enables XHR for upload requests. */
  onUploadProgress?: (percent: number) => void;
};

/** 统一给页面消费的错误视图，页面不要自己解析后端错误结构。 */
export type ApiErrorView = {
  message: string;
  code?: string;
  status?: number;
  requestId?: string;
};

/** 携带后端状态码/错误码的错误，继承 Error 以兼容既有 `instanceof Error` 处理。 */
export class ApiError extends Error {
  status?: number;
  code?: string;
  requestId?: string;
  details?: unknown;

  constructor(message: string, options?: {
    status?: number;
    code?: string;
    requestId?: string;
    details?: unknown;
  }) {
    super(message);
    this.name = "ApiError";
    this.status = options?.status;
    this.code = options?.code;
    this.requestId = options?.requestId;
    this.details = options?.details;
  }
}

/** 把任意 catch 到的异常归一成页面可直接渲染的错误视图。 */
export function toApiErrorView(error: unknown): ApiErrorView {
  if (error instanceof ApiError) {
    return {
      message: error.message,
      code: error.code,
      status: error.status,
      ...(error.requestId ? { requestId: error.requestId } : {}),
    };
  }
  if (error instanceof Error) {
    return { message: error.message };
  }
  return { message: "请求失败" };
}

export function defaultApiBaseUrl() {
  if (typeof window === "undefined") return "http://127.0.0.1:10588/api";
  return `${window.location.origin.replace(/\/+$/, "")}/api`;
}

export function normalizeBaseUrl(value?: string | null) {
  const raw = String(value || "").trim();
  return (raw || defaultApiBaseUrl()).replace(/\/+$/, "");
}

function readPersistedAuthStoreToken(): string {
  try {
    const persisted = JSON.parse(localStorage.getItem(AUTH_STORE_STORAGE_KEY) || "null");
    return String(persisted?.state?.token || "").trim();
  } catch {
    return "";
  }
}

/**
 * Return the browser session token from the canonical HTTP key, while
 * migrating sessions created by builds that only persisted the Zustand auth
 * store. Without this bridge the route guard can be authenticated through
 * `fanjin-auth` while ordinary API requests are sent without Authorization.
 */
export function readAuthToken(): string {
  const directToken = String(
    localStorage.getItem(TOKEN_STORAGE_KEY) || localStorage.getItem("token") || "",
  ).trim();
  if (directToken) return directToken;

  const persistedToken = readPersistedAuthStoreToken();
  if (persistedToken) localStorage.setItem(TOKEN_STORAGE_KEY, persistedToken);
  return persistedToken;
}

export function readApiSettings(): ApiSettings {
  return {
    // The site owns its API route. Ignore endpoint overrides saved by older builds.
    baseUrl: defaultApiBaseUrl(),
    token: readAuthToken(),
  };
}

/** 仅写入/清除登录 token；接口地址由站点确定。 */
export function saveToken(token: string) {
  localStorage.setItem(TOKEN_STORAGE_KEY, token.trim());
}

export function clearToken() {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
  localStorage.removeItem("token");
}

function joinUrl(baseUrl: string, path: string) {
  return `${normalizeBaseUrl(baseUrl)}/${path.replace(/^\/+/, "")}`;
}

function uploadJsonRequest(url: string, body: string, headers: HeadersInit, options: ApiRequestOptions) {
  return new Promise<Pick<Response, "ok" | "status" | "json" | "headers">>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(options.signal.reason ?? new DOMException("已取消", "AbortError"));
      return;
    }
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const cleanup = () => options.signal?.removeEventListener("abort", abort);
    xhr.open("POST", url, true);
    xhr.timeout = 10 * 60 * 1000;
    // Same-origin cookies are sent normally; never enable cross-origin cookies.
    xhr.withCredentials = false;
    new Headers(headers).forEach((value, name) => xhr.setRequestHeader(name, value));
    xhr.upload.onprogress = event => {
      if (event.lengthComputable && event.total > 0) {
        options.onUploadProgress?.(Math.min(100, Math.round(event.loaded / event.total * 100)));
      }
    };
    xhr.upload.onload = () => options.onUploadProgress?.(100);
    xhr.onload = () => {
      cleanup();
      resolve({
        ok: xhr.status >= 200 && xhr.status < 300,
        status: xhr.status,
        json: async () => JSON.parse(xhr.responseText),
        headers: new Headers({"X-Request-Id": xhr.getResponseHeader("X-Request-Id") || ""}),
      });
    };
    xhr.onerror = () => { cleanup(); reject(new ApiError("上传网络中断，请重试")); };
    xhr.ontimeout = () => { cleanup(); reject(new ApiError("上传超时，请重试")); };
    xhr.onabort = () => { cleanup(); reject(options.signal?.reason ?? new DOMException("已取消", "AbortError")); };
    options.signal?.addEventListener("abort", abort, {once: true});
    try { xhr.send(body); } catch (error) { cleanup(); reject(error); }
  });
}

async function apiRequest<TResponse>(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  payload: unknown,
  settings: ApiSettings,
  options?: ApiRequestOptions,
  providerRetryCount = 0,
): Promise<TResponse> {
  // Settings may have been captured before an auth-store hydration or a
  // step-up dialog. Recover an empty snapshot from the canonical session at
  // dispatch time so a valid browser session never emits an unauthenticated
  // administrator request.
  const requestToken = settings.token.trim() || readAuthToken();
  const headers = {
    "Content-Type": "application/json",
    ...(requestToken ? { Authorization: requestToken } : {}),
    ...(options?.headers || {}),
  };
  const response = method === "POST" && options?.onUploadProgress
    ? await uploadJsonRequest(joinUrl(settings.baseUrl, path), JSON.stringify(payload ?? {}), headers, options)
    : await fetch(joinUrl(settings.baseUrl, path), {
    method,
    credentials: "same-origin",
    signal: options?.signal,
    keepalive: options?.keepalive,
    headers,
    body: method === "GET" || method === "DELETE" ? undefined : JSON.stringify(payload ?? {}),
  });

  const data = await response.json().catch(() => ({}));
  // Resume only a durable image command with its original identity. A quota wait
  // is not a failed generation, and never creates a fresh user submission.
  if (method === "POST" && path === "/workbench/create/images"
    && new Headers(options?.headers).has("Idempotency-Key")
    && [
      "WORKSPACE_GENERATION_QUEUED",
      "image_task_in_progress",
      // The provider explicitly asks for the same idempotency key after a
      // transient 503. Replaying the durable command is safe and avoids a
      // second charge or a second upstream order.
      "image_task_retryable_provider_503",
    ].includes(data?.code)
    && (data?.code !== "image_task_retryable_provider_503" || providerRetryCount < 1)) {
    const delay = Math.max(1000, Math.min(10000, Number(data.retryAfterMs) || 2000));
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => { clearTimeout(timer); reject(options?.signal?.reason ?? new DOMException("已取消", "AbortError")); };
      const timer = setTimeout(() => { options?.signal?.removeEventListener("abort", onAbort); resolve(); }, delay);
      if (options?.signal?.aborted) onAbort();
      else options?.signal?.addEventListener("abort", onAbort, { once: true });
    });
    return apiRequest<TResponse>(method, path, payload, settings, options,
      providerRetryCount + (data?.code === "image_task_retryable_provider_503" ? 1 : 0));
  }
  if (!response.ok) {
    if (response.status === 401
      && normalizeBaseUrl(settings.baseUrl) === defaultApiBaseUrl()
      && !/^\/?auth\//.test(path)) {
      const sentToken = new Headers(headers).get("Authorization")?.trim();
      if (sentToken) unauthorizedSessionHandler?.(sentToken);
    }
    const message = data?.message || data?.error?.message || `请求失败：${response.status}`;
    const bodyRequestId = typeof data?.requestId === "string" ? data.requestId.trim() : "";
    const headerRequestId = response.headers?.get?.("X-Request-Id")?.trim() || "";
    const structuredData = data?.data && typeof data.data === "object" && !Array.isArray(data.data)
      ? data.data as Record<string, unknown>
      : undefined;
    const responseErrors = Array.isArray(data?.errors) ? data.errors : undefined;
    throw new ApiError(message, {
      status: response.status,
      code:
        data?.data?.code
        ?? data?.error?.code
        ?? (typeof data?.code === "string" ? data.code : undefined),
      requestId: bodyRequestId || headerRequestId || undefined,
      details: responseErrors
        ? { ...(structuredData || {}), errors: responseErrors }
        : structuredData,
    });
  }
  return (data?.data ?? data) as TResponse;
}

export async function apiPost<TResponse, TPayload extends Record<string, unknown> = Record<string, unknown>>(
  path: string,
  payload: TPayload,
  settings = readApiSettings(),
  options?: ApiRequestOptions,
): Promise<TResponse> {
  return apiRequest<TResponse>("POST", path, payload, settings, options);
}

export async function apiGet<TResponse>(
  path: string,
  settings = readApiSettings(),
  options?: ApiRequestOptions,
): Promise<TResponse> {
  return apiRequest<TResponse>("GET", path, undefined, settings, options);
}

export async function apiPut<TResponse, TPayload extends Record<string, unknown> = Record<string, unknown>>(
  path: string,
  payload: TPayload,
  settings = readApiSettings(),
  options?: ApiRequestOptions,
): Promise<TResponse> {
  return apiRequest<TResponse>("PUT", path, payload, settings, options);
}

export async function apiDelete<TResponse>(
  path: string,
  settings = readApiSettings(),
  options?: ApiRequestOptions,
): Promise<TResponse> {
  return apiRequest<TResponse>("DELETE", path, undefined, settings, options);
}
