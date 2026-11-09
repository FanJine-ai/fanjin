/** Older generation surfaces use a browser confirmation instead of a result-screen action. */
export async function confirmPricingRetry<T>(
  submit: () => Promise<T>,
  submitConfirmed: () => Promise<T>,
): Promise<T> {
  try { return await submit(); }
  catch (error) {
    const detail = error as { status?: number; code?: string; message?: string } | null;
    if (detail?.status !== 409 || detail.code !== "pricing_confirmation_required") throw error;
    if (!window.confirm(`${detail.message || "请核对本次生成费用"}\n\n确认费用并生成？取消将不提交生成。`)) throw error;
    // This closure retains the original payload and idempotency key. A second
    // changed/expired quote is returned to the UI, never confirmed automatically.
    return submitConfirmed();
  }
}
