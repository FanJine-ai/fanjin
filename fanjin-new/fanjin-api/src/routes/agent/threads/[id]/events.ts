import express from "express";
import { z } from "zod";
import { toAgentEventDto, toAgentMessageDeltaEventDto } from "@/agent-runtime/dto";
import { requireAgentRuntimePreview } from "@/agent-runtime/featureFlags";
import { assertAgentProjectAccess, getAgentRequestActor } from "@/agent-runtime/httpAccess";
import { requireResource, sendAgentRuntimeError } from "@/agent-runtime/http";
import {
  getAgentThread,
  getLatestAgentStreamingMessage,
  listAgentEvents,
} from "@/agent-runtime/repository";
import { subscribeAgentMessageDeltas } from "@/agent-runtime/streamBus";

const router = express.Router({ mergeParams: true });
router.use(requireAgentRuntimePreview);

const querySchema = z.object({
  after: z.coerce.number().int().min(0).optional(),
  once: z.enum(["0", "1"]).optional(),
  format: z.enum(["sse", "json"]).optional(),
});

type PublicAgentEvent = NonNullable<ReturnType<typeof toAgentEventDto>>;
type PublicDeltaEvent = ReturnType<typeof toAgentMessageDeltaEventDto>;

function writeEvent(res: express.Response, event: PublicAgentEvent) {
  res.write(`id: ${event.seq}\n`);
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

// 瞬态增量(REVAMP-PLAN 4.1):故意不写 SSE id 行,客户端 Last-Event-ID 只跟随
// 持久事件推进;delta 丢失由 750ms 轮询 + message.completed 全量正文兜底。
function writeDeltaEvent(res: express.Response, event: PublicDeltaEvent) {
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function streamingMessageText(content: Array<{ type?: string; text?: string }>): string {
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text || "")
    .join("");
}

router.get("/", async (req, res) => {
  try {
    const parsed = querySchema.safeParse(req.query ?? {});
    if (!parsed.success) return res.status(400).send({ code: "invalid_request", message: "参数错误", errors: parsed.error.issues });
    const actor = getAgentRequestActor(req);
    const thread = requireResource(
      await getAgentThread({ id: String((req.params as any).id || ""), workspaceId: actor.workspaceId }),
      "thread_not_found",
      "Agent Thread 不存在",
    );
    await assertAgentProjectAccess(req, thread.projectId, "project:read");

    const rawHeaderCursor = req.headers["last-event-id"];
    const parsedHeaderCursor = Number(Array.isArray(rawHeaderCursor) ? rawHeaderCursor.at(-1) : rawHeaderCursor);
    const headerCursor = Number.isSafeInteger(parsedHeaderCursor) && parsedHeaderCursor >= 0
      ? parsedHeaderCursor
      : 0;
    // A browser reconnects EventSource with Last-Event-ID but keeps the original
    // URL. Use the newest acknowledged cursor so a stale `after` query cannot
    // replay already-consumed events, while a newer explicit query still wins.
    let cursor = Math.max(0, parsed.data.after ?? 0, headerCursor);

    const replay = await listAgentEvents({
      threadId: thread.id,
      workspaceId: actor.workspaceId,
      after: cursor,
      limit: 500,
    });
    const cursorHasGap =
      cursor > 0 &&
      thread.eventSeq > cursor &&
      (replay.length === 0 || replay[0].seq !== cursor + 1);
    if (cursorHasGap) {
      return res.status(410).send({
        code: "event_cursor_expired",
        message: "事件游标已过期，请先重新获取 Thread 快照",
        details: { snapshotRequired: true, latestSequence: thread.eventSeq },
      });
    }

    if (parsed.data.format === "json") {
      return res.status(200).json({ data: { events: replay.map(toAgentEventDto).filter(Boolean),
        nextCursor: replay.at(-1)?.seq ?? cursor, hasMore: (replay.at(-1)?.seq ?? cursor) < thread.eventSeq } });
    }
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    for (const event of replay) {
      cursor = event.seq;
      const publicEvent = toAgentEventDto(event);
      if (publicEvent) writeEvent(res, publicEvent);
    }

    if (parsed.data.once === "1") {
      res.end();
      return;
    }

    res.write(": connected\n\n");
    let polling = false;
    let snapshotPolling = false;
    let closed = false;
    const deliveredContent = new Map<string, string>();
    const directMessageIds = new Set<string>();
    // 同进程走低延迟直推；API/Worker 分进程时由 250ms pending 消息快照
    // 轮询桥接。两者都不占持久事件游标。
    const unsubscribeDeltas = subscribeAgentMessageDeltas(thread.id, (delta) => {
      if (closed || res.writableEnded || res.destroyed) return;
      try {
        directMessageIds.add(delta.messageId);
        deliveredContent.set(delta.messageId, `${deliveredContent.get(delta.messageId) || ""}${delta.delta}`);
        writeDeltaEvent(res, toAgentMessageDeltaEventDto(delta));
      } catch {
        // 写盘异常交由 close/aborted 清理路径处理,轮询兜底仍在。
      }
    });
    const pollSnapshot = setInterval(async () => {
      if (snapshotPolling || closed || res.writableEnded || res.destroyed) return;
      snapshotPolling = true;
      try {
        const message = await getLatestAgentStreamingMessage({
          threadId: thread.id,
          workspaceId: actor.workspaceId,
        });
        if (!message?.runId) return;
        const content = streamingMessageText(message.content);
        const previous = deliveredContent.get(message.id) || "";
        if (!content || content === previous) return;
        // When the in-process bus is active, never let a lagging DB snapshot
        // replay or shorten already delivered text. In split-process mode no
        // direct delta exists, so a full snapshot may replace the prior turn.
        if (directMessageIds.has(message.id) && (!content.startsWith(previous) || content.length <= previous.length)) {
          return;
        }
        deliveredContent.set(message.id, content);
        writeDeltaEvent(res, toAgentMessageDeltaEventDto({
          threadId: thread.id,
          runId: message.runId,
          messageId: message.id,
          delta: content,
          snapshot: true,
          createdAt: message.updatedAt,
        }));
      } catch {
        // Preview snapshots are best effort; durable event polling and the
        // terminal message snapshot remain authoritative.
      } finally {
        snapshotPolling = false;
      }
    }, 250);
    const poll = setInterval(async () => {
      if (polling || closed || res.writableEnded || res.destroyed) return;
      polling = true;
      try {
        const events = await listAgentEvents({
          threadId: thread.id,
          workspaceId: actor.workspaceId,
          after: cursor,
          limit: 500,
        });
        for (const event of events) {
          if (closed || res.writableEnded || res.destroyed) break;
          cursor = event.seq;
          const publicEvent = toAgentEventDto(event);
          if (publicEvent) writeEvent(res, publicEvent);
        }
      } catch {
        if (!closed && !res.writableEnded && !res.destroyed) {
          res.write(`event: error\ndata: ${JSON.stringify({ code: "event_replay_failed", message: "事件回放失败" })}\n\n`);
          res.end();
        }
      } finally {
        polling = false;
      }
    }, 750);
    const heartbeat = setInterval(() => {
      if (!closed && !res.writableEnded && !res.destroyed) res.write(`: heartbeat ${Date.now()}\n\n`);
    }, 15_000);
    const absoluteTimeout = setTimeout(() => {
      if (!closed && !res.writableEnded && !res.destroyed) {
        res.write("event: reconnect\ndata: {\"reason\":\"connection_lifetime_reached\"}\n\n");
        res.end();
      }
    }, 300_000);

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(poll);
      clearInterval(pollSnapshot);
      clearInterval(heartbeat);
      clearTimeout(absoluteTimeout);
      unsubscribeDeltas?.();
    };
    req.on("aborted", cleanup);
    res.on("close", cleanup);
  } catch (error) {
    if (res.headersSent) {
      if (!res.writableEnded) res.end();
      return;
    }
    return sendAgentRuntimeError(res, error);
  }
});

export default router;
