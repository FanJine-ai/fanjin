import { Agent, type Dispatcher } from "undici";

/** One POST, with transport deadlines that do not shorten the channel deadline. */
export async function fetchRelayTextResponse(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_478_647) {
    throw new Error("Invalid relay text timeout");
  }
  // AbortSignal controls the total request lifetime. Undici's independent
  // 300-second header/body defaults otherwise cut a configured 10-minute
  // analysis short even though the channel deadline has not expired.
  const dispatcher = new Agent({connections: 1, pipelining: 0,
    headersTimeout: timeoutMs + 5_000, bodyTimeout: timeoutMs + 5_000});
  try {
    const response = await fetch(url, {...init, redirect: "error", dispatcher} as RequestInit & {dispatcher: Dispatcher});
    // close() prevents new requests and waits for this response body to finish.
    // Awaiting it here would deadlock the caller that must consume the stream.
    void dispatcher.close().catch(() => dispatcher.destroy().catch(() => undefined));
    return response;
  } catch (error) {
    await dispatcher.destroy().catch(() => undefined);
    throw error;
  }
}
