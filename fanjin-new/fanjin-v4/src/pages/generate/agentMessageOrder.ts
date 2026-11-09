/** Preserve turn order across upload latency and differences between client/server clocks. */
export function confirmAgentMessage<T extends { id: string; createdAt: number; runId?: string | null }>(
  messages: readonly T[], confirmed: T, clientMessageId: string, assistantMessageId: string, runId: string,
): T[] {
  const next: T[] = [];
  let inserted = false;
  for (const message of messages) {
    if (message.id === clientMessageId || message.id === confirmed.id) {
      if (!inserted) next.push(confirmed);
      inserted = true;
    } else if (message.id === assistantMessageId) {
      if (!inserted) next.push(confirmed);
      inserted = true;
      next.push({ ...message, runId, createdAt: Math.max(message.createdAt, confirmed.createdAt + 1) });
    } else {
      next.push(message);
    }
  }
  if (!inserted) next.push(confirmed);
  return next;
}
