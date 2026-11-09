export const VIDEO_PERSISTENCE_RETRY_MESSAGE =
  "视频已生成，保存失败，正在自动重试保存。请勿重复生成。";

export function hasVideoPersistenceFailure(poll: unknown): poll is Record<string, unknown> {
  return !!poll && typeof poll === "object" && !Array.isArray(poll)
    && (poll as Record<string, unknown>).reason === "final_asset_persistence_failed";
}

export function nextVideoPersistenceRetry(previous: unknown, now: number) {
  const previousAttempt = hasVideoPersistenceFailure(previous)
    ? Number(previous.attempt || 0)
    : 0;
  const attempt = Math.min(20, Math.max(0, Number.isFinite(previousAttempt) ? Math.floor(previousAttempt) : 0) + 1);
  return { attempt, retryAt: now + Math.min(300_000, 30_000 * 2 ** (attempt - 1)) };
}

export function isVideoPersistenceRetryWaiting(poll: unknown, now: number) {
  return hasVideoPersistenceFailure(poll)
    && Number.isFinite(Number(poll.retryAt))
    && Number(poll.retryAt) > now
    && Number(poll.retryAt) <= now + 300_000;
}
