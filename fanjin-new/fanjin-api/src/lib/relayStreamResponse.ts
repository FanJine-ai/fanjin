import { Readable } from "node:stream";
import type { Response } from "express";

export interface PipeRelayWebStreamOptions {
  stream: ReadableStream<Uint8Array>;
  res: Response;
  clientDisconnectMessage: string;
  onErrorBeforeHeaders: (error: Error) => void;
  /** Enable only for SSE after the upstream response status has been accepted. */
  sseHeartbeat?: boolean;
}

function normalizeStreamError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error || "relay stream failed"));
}

/**
 * Bridge a Web ReadableStream into an Express response without orphaning the
 * upstream stream when the HTTP client disconnects. Destroying the Node
 * wrapper propagates cancellation back through Readable.fromWeb().
 */
export function pipeRelayWebStreamToResponse(options: PipeRelayWebStreamOptions): Readable {
  const { stream, res, clientDisconnectMessage, onErrorBeforeHeaders } = options;
  const nodeStream = Readable.fromWeb(stream as any);
  let responseFinished = false;
  let clientClosedEarly = false;
  let streamErrorHandled = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let lastActivityAt = Date.now();
  let atEventBoundary = true;
  let lineHasContent = false;
  let previousWasCr = false;

  const stopHeartbeat = () => {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = undefined;
  };

  if (options.sseHeartbeat) {
    res.setHeader("X-Accel-Buffering", "no");
    // Network chunks can split an SSE data line, JSON, UTF-8, or CRLF pair.
    // Insert comments only between whole events, never into upstream bytes.
    nodeStream.on("data", (chunk: Buffer) => {
      lastActivityAt = Date.now();
      for (const byte of chunk) {
        if (byte === 13 || byte === 10) {
          if (byte === 13 || !previousWasCr) {
            atEventBoundary = !lineHasContent;
            lineHasContent = false;
          }
          previousWasCr = byte === 13;
        } else {
          lineHasContent = true;
          atEventBoundary = false;
          previousWasCr = false;
        }
      }
    });
    heartbeat = setInterval(() => {
      if (responseFinished || res.destroyed || res.writableEnded || nodeStream.destroyed) {
        stopHeartbeat();
        return;
      }
      if (!atEventBoundary || previousWasCr || res.writableNeedDrain || Date.now() - lastActivityAt < 15_000) return;
      // write() flushes the already accepted SSE headers, including while
      // awaiting its first event. Errors before this retain their HTTP status.
      res.write(": keep-alive\n\n");
      lastActivityAt = Date.now();
    }, 15_000);
    heartbeat.unref();
    nodeStream.once("end", stopHeartbeat);
    nodeStream.once("close", stopHeartbeat);
  }

  res.once("finish", () => {
    stopHeartbeat();
    responseFinished = true;
  });

  res.once("close", () => {
    stopHeartbeat();
    if (responseFinished || res.writableEnded) return;
    clientClosedEarly = true;
    if (!nodeStream.destroyed) {
      nodeStream.destroy(new Error(clientDisconnectMessage));
    }
  });

  // Readable.pipe() does not forward source errors to the destination. Always
  // consume the error event so a failed upstream stream cannot become an
  // uncaught process-level exception.
  nodeStream.once("error", (rawError) => {
    stopHeartbeat();
    if (streamErrorHandled) return;
    streamErrorHandled = true;
    if (clientClosedEarly || res.destroyed || res.writableEnded) return;

    const error = normalizeStreamError(rawError);
    if (!res.headersSent) {
      try {
        onErrorBeforeHeaders(error);
      } catch {
        if (!res.destroyed) res.destroy();
      }
      return;
    }

    // Streaming bytes already fixed the status and body format. Close without
    // passing an Error to destroy(), which would need another error listener.
    if (!res.destroyed) res.destroy();
  });

  nodeStream.pipe(res);
  return nodeStream;
}
