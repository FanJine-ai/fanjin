export const PORTRAIT_PREPARATION_PENDING = "portrait_provider_binding_pending";

export function isPortraitPreparationPending(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { status?: unknown; code?: unknown };
  return value.status === 409 && value.code === PORTRAIT_PREPARATION_PENDING;
}

/** Resume the exact captured request/key only for the server's pre-dispatch
 * preparation response. Network errors, reconciliation and price changes stop. */
export async function submitAfterPortraitPreparation<T>(input: {
  submit: () => Promise<T>;
  isCurrent: () => boolean;
  onProgress: (message: string) => void;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<T> {
  const deadline = Date.now() + (input.timeoutMs ?? 180_000);
  const assertCurrent = () => {
    if (!input.isCurrent()) throw new DOMException("已取消本次生成", "AbortError");
  };
  while (true) {
    assertCurrent();
    try {
      return await input.submit();
    } catch (error) {
      if (!isPortraitPreparationPending(error)) throw error;
      assertCurrent();
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw error;
      input.onProgress("正在为当前模型准备人物素材，完成后自动继续生成");
      await new Promise((resolve) => globalThis.setTimeout(resolve, Math.min(input.intervalMs ?? 2500, remaining)));
    }
  }
}
