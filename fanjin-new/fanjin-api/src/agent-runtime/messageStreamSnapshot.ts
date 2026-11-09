import type { Knex } from "knex";

const DEFAULT_FLUSH_INTERVAL_MS = 120;
const MAX_STREAM_SNAPSHOT_TEXT_CHARS = 128 * 1_024;

/**
 * Coalesces upstream token deltas into the pending assistant message row.
 * This is the cross-process bridge between a Worker and the API process that
 * owns the browser SSE connection. The terminal message write remains the
 * authoritative result and always replaces this preview snapshot.
 */
export class AgentMessageStreamSnapshotWriter {
  private content = "";
  private persistedContent = "";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly input: {
    database: Knex;
    workspaceId: string;
    threadId: string;
    runId: string;
    messageId: string;
    clock: () => number;
    flushIntervalMs?: number;
  }) {}

  append(delta: string): void {
    if (this.closed || !delta) return;
    this.content = `${this.content}${delta}`.slice(0, MAX_STREAM_SNAPSHOT_TEXT_CHARS);
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.enqueueWrite();
    }, this.input.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS);
  }

  private enqueueWrite(): void {
    const snapshot = this.content;
    if (!snapshot || snapshot === this.persistedContent) return;
    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(async () => {
        const updated = await this.input.database("o_agent_message")
          .where({
            id: this.input.messageId,
            workspaceId: this.input.workspaceId,
            threadId: this.input.threadId,
            runId: this.input.runId,
            role: "assistant",
            status: "pending",
          })
          .update({
            content: JSON.stringify([{ type: "text", text: snapshot }]),
            updatedAt: this.input.clock(),
          });
        if (Number(updated || 0) > 0) this.persistedContent = snapshot;
      });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.enqueueWrite();
    await this.writeChain.catch(() => undefined);
  }
}
