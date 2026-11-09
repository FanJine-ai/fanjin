import { AsyncLocalStorage } from "node:async_hooks";

// 创作台调用统一计费的请求上下文。
// 通过 AsyncLocalStorage 在 Express 中间件 / Socket 处理器中注入，
// 让深层的 u.Ai.Text/Image/Audio 调用无需改动签名即可读取工作区归属并扣费。
export interface BillingContext {
  workspaceId: string | null;
  userId: number | null;
  projectId?: number | null;
  /** Stable request/turn identity used to derive idempotent creation charges. */
  requestId?: string | null;
  /** Internal per-context sequence; callers should not set this directly. */
  creationOperationSequence?: number;
  // 模型连通性测试等管理诊断路径不参与扣费
  skipBilling?: boolean;
}

const billingAls = new AsyncLocalStorage<BillingContext>();

export function runBillingContext<T>(ctx: BillingContext, fn: () => T): T {
  return billingAls.run(ctx, fn);
}

export function getBillingContext(): BillingContext | undefined {
  return billingAls.getStore();
}

export function isBillingSkipped(): boolean {
  return Boolean(billingAls.getStore()?.skipBilling);
}
