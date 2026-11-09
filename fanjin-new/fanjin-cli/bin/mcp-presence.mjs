import { randomUUID } from "node:crypto";

// Liveness traffic stays outside MCP stdout and never starts a paid tool.
export function createMcpPresence({ url, key, intervalMs = 15_000, timeoutMs = 4_000, request = fetch }) {
  const target = new URL(url); target.pathname = "/api/mcp/presence";
  const connectionId = randomUUID();
  let timer, pending, stopping, started = false, closed = false;
  async function send(action) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await request(target, {
        method: "POST", redirect: "error", signal: controller.signal,
        headers: { "Content-Type": "application/json", "X-API-Key": key },
        body: JSON.stringify({ connectionId, transport: "stdio", action }),
      });
      await response.body?.cancel();
    } catch { /* Presence must not interrupt an MCP operation or leak credentials. */ }
    finally { clearTimeout(timeout); }
  }
  function pulse() {
    if (pending || closed) return;
    pending = send("heartbeat").finally(() => { pending = undefined; });
  }
  return {
    start() {
      if (started || closed) return;
      started = true;
      pulse();
      timer = setInterval(pulse, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (stopping) return stopping;
      closed = true;
      clearInterval(timer);
      // Complete a pending renewal before removal, so it cannot resurrect a closed client.
      stopping = (async () => { await pending; if (started) await send("disconnect"); })();
      return stopping;
    },
  };
}
