import { RelayImageError } from "./relayImage";

export function quickCreateImagePendingReconcileBody(error?: unknown) {
  const upstreamStatus = error instanceof RelayImageError ? error.statusCode : undefined;
  const transportTimedOut = error instanceof RelayImageError
    && error.reconciliationMetadata.transportTimedOut === true;
  return {
    message: transportTimedOut
      ? "等待图片服务响应超时，本地未收到图片结果。你已确认消费，无需再次确认；请查询原任务，费用记录可在账单中查看，不会重新生成，也不保证能取回上游图片。"
      : upstreamStatus && upstreamStatus >= 500
      ? `图片服务返回 ${upstreamStatus}，本次未取得可交付图片。费用记录可在账单中查看；查询旧请求不会重新生成。`
      : "图片请求已提交，但结果和费用尚未确认；费用记录可在账单中查看，查询旧请求不会重新生成或重复扣费",
    code: "image_task_pending_reconcile",
    deliveryTraceVersion: "quick-create-image-no-delivery.v1" as const,
    ...(upstreamStatus ? { upstreamStatus } : {}),
  };
}
