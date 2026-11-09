import { Agent, type Dispatcher } from "undici";

type ProviderSubmissionFetch = (
  input: string | URL | Request,
  init?: RequestInit & { dispatcher?: Dispatcher },
) => Promise<Response>;

export interface ProviderSubmissionTransportTestHooks {
  fetch?: ProviderSubmissionFetch;
  createDispatcher?: (options: ProviderSubmissionDispatcherOptions) => Dispatcher;
}

export interface ProviderSubmissionDispatcherOptions {
  connections: 1;
  pipelining: 0;
  headersTimeout: number;
  bodyTimeout: number;
}

const PROVIDER_SUBMISSION_TIMEOUT_GRACE_MS = 5_000;
const MAX_NODE_TIMER_MS = 2_147_483_647;
const SAFE_PROVIDER_TRANSPORT_ERROR_CODES = new Set([
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_DESTROYED",
  "UND_ERR_CLOSED",
  "UND_ERR_ABORTED",
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETDOWN",
  "ENETUNREACH",
  "EHOSTDOWN",
  "EHOSTUNREACH",
  "EPIPE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

export function providerSubmissionTransportErrorCode(error: unknown): string | null {
  const candidate = String(
    (error as any)?.cause?.code
    || (error as any)?.code
    || "",
  ).trim().toUpperCase();
  return SAFE_PROVIDER_TRANSPORT_ERROR_CODES.has(candidate) ? candidate : null;
}

/**
 * Executes one non-idempotent provider POST on a dedicated, non-pipelined
 * connection and consumes its body before closing that connection.
 *
 * This helper deliberately contains no retry loop. Redirect following is also
 * disabled because a 307/308 could otherwise replay the POST at a second URL.
 */
export async function fetchProviderSubmissionWithFreshConnection<T>(input: {
  url: string;
  init: RequestInit;
  timeoutMs: number;
  consume: (response: Response) => Promise<T>;
  testHooks?: ProviderSubmissionTransportTestHooks;
}): Promise<{ response: Response; value: T }> {
  const method = String(input.init.method || "GET").toUpperCase();
  if (method !== "POST") {
    throw new Error("Provider submission transport only accepts POST requests");
  }
  const timeoutMs = Math.ceil(input.timeoutMs);
  if (
    !Number.isSafeInteger(timeoutMs)
    || timeoutMs <= 0
    || timeoutMs > MAX_NODE_TIMER_MS - PROVIDER_SUBMISSION_TIMEOUT_GRACE_MS
  ) {
    throw new Error("Provider submission timeout is outside the supported timer range");
  }

  const fetchImpl = input.testHooks?.fetch || (globalThis.fetch as ProviderSubmissionFetch);
  const dispatcherTimeoutMs = timeoutMs + PROVIDER_SUBMISSION_TIMEOUT_GRACE_MS;
  const dispatcherOptions: ProviderSubmissionDispatcherOptions = {
    connections: 1,
    // Undici documents pipelining=0 as disabling persistent connections.
    // A new Agent per call also prevents reuse of a socket previously used
    // by polling or another long-running matrix item.
    pipelining: 0,
    // Node's built-in Undici defaults these to roughly 300 seconds. Provider
    // video acceptance can legitimately take longer. Keep the transport
    // deadline slightly beyond the business AbortController deadline so the
    // latter remains authoritative and is classified as submit_timeout.
    headersTimeout: dispatcherTimeoutMs,
    bodyTimeout: dispatcherTimeoutMs,
  };
  const dispatcher = input.testHooks?.createDispatcher?.(dispatcherOptions)
    || new Agent(dispatcherOptions);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(input.url, {
      ...input.init,
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      dispatcher,
    });
    const value = await input.consume(response);
    return { response, value };
  } catch (error: any) {
    if (error?.name === "AbortError") {
      throw new Error(`Provider request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    // The response body has either been consumed or failed. Dispatcher cleanup
    // must never replace the provider outcome with a secondary close error.
    try {
      await dispatcher.close();
    } catch {
      // Cleanup is best effort; the primary provider outcome wins.
    }
  }
}
