// Midjourney 中转（MJ Proxy 格式）
// 支持 /mj/submit/imagine、/mj/task/:id/fetch 等端点
import axios from "axios";
import type { RelayChannel } from "@/lib/relay";
import { withChannelRetry } from "@/lib/channelRouter";
import { BillingError } from "@/lib/billing";
import {
  beginRelayUnitBilling,
  markRelayBillingDispatchStarted,
  markRelayBillingPending,
  releaseRelayBillingSession,
  settleRelayUnitBilling,
  type RelayBillingContext,
  type RelayBillingSession,
} from "@/lib/relayBillingSession";
import { resolveChannelApiKey, resolveChannelBaseUrl } from "@/lib/relayChannelCredential";
import { db } from "@/utils/db";

export class RelayMJError extends Error {
  statusCode: number;
  upstreamMayHaveAccepted: boolean;
  constructor(message: string, statusCode: number, upstreamMayHaveAccepted = true) {
    super(message);
    this.name = "RelayMJError";
    this.statusCode = statusCode;
    this.upstreamMayHaveAccepted = upstreamMayHaveAccepted;
  }
}

function upstreamMayHaveAcceptedStatus(status: number): boolean {
  return ![400, 401, 402, 403, 404, 405, 406, 411, 413, 414, 415, 422, 429].includes(status);
}

function asMJUpstreamError(error: unknown): RelayMJError {
  const value = error as any;
  const status = Number(value?.statusCode ?? value?.status ?? value?.response?.status);
  const message = value?.response?.data?.description
    || value?.response?.data?.error?.message
    || value?.message
    || "MJ 供应商调用失败";
  const statusCode = Number.isFinite(status) ? status : 502;
  return new RelayMJError(String(message), statusCode, upstreamMayHaveAcceptedStatus(statusCode));
}

export async function executeMJSubmit(
  action: string, // imagine / upscale / variation / describe / blend
  body: any,
  ctx: RelayBillingContext,
): Promise<any> {
  // action 白名单校验，防止路径穿越
  const allowedActions = ["imagine", "upscale", "variation", "describe", "blend", "shorten", "mjapi", "action"];
  if (!allowedActions.includes(action)) throw new RelayMJError("不支持的 MJ action", 400);

  const requestPayload = { action, body };
  const billingState: { current: RelayBillingSession | null } = { current: null };
  let activeChannel: RelayChannel | null = null;
  let upstreamCompleted = false;
  try {
    const routed = await withChannelRetry(
      {
        endpointType: "image_generation",
        model: "midjourney",
        workspaceId: ctx.workspaceId,
        retryPolicy: "disabled",
      },
      0,
      async (channel: RelayChannel) => {
        activeChannel = channel;
        const apiKey = resolveChannelApiKey(channel);
        const baseUrl = resolveChannelBaseUrl(channel);
        if (!apiKey) throw new RelayMJError("供应商通道未配置 apiKey", 500, false);
        if (!baseUrl) throw new RelayMJError("供应商通道未配置 baseUrl", 500, false);

        billingState.current = await beginRelayUnitBilling({
          source: "relay-mj",
          endpointType: "image_generation",
          model: "midjourney",
          channel,
          context: ctx,
          requestPayload,
          units: 1,
          unit: "image",
          metadata: { action },
        });
        await markRelayBillingDispatchStarted(billingState.current, channel);
        try {
          const res = await axios.post(`${baseUrl}/mj/submit/${action}`, body, {
            headers: {
              "mj-api-secret": apiKey,
              "Idempotency-Key": billingState.current.requestId,
              "X-Request-Id": billingState.current.requestId,
            },
            timeout: channel.timeoutMs || 30000,
          });
          upstreamCompleted = true;
          return res.data;
        } catch (error) {
          throw asMJUpstreamError(error);
        }
      },
    );
    if (!billingState.current) throw new BillingError("MJ 计费预扣会话未创建", 500);
    await settleRelayUnitBilling(billingState.current, routed.channel, {
      units: 1,
      unit: "image",
      metadata: { action, upstreamAccepted: true },
    });
    return routed.result;
  } catch (error) {
    const session = billingState.current;
    if (session && !session.finalized) {
      if (!session.dispatchStarted) {
        await releaseRelayBillingSession(session, "MJ 调用上游前失败，释放预扣", "not_dispatched");
      } else if (error instanceof RelayMJError && !error.upstreamMayHaveAccepted) {
        await releaseRelayBillingSession(session, "MJ 上游明确拒绝且未产生成本，释放预扣", "definitive_not_billable");
      } else if (activeChannel) {
        try {
          await markRelayBillingPending(session, activeChannel, {
            units: 1,
            unit: "image",
            costMicros: 0,
            reason: upstreamCompleted ? "mj_settlement_failed" : "mj_upstream_outcome_unknown",
            metadata: { action, upstreamCompleted },
          });
        } catch (billingError) {
          console.error("[relay-mj] 保存待核账状态失败", billingError);
        }
      }
    }
    throw error;
  }
}

export async function executeMJTaskFetch(
  taskId: string,
  ctx: { workspaceId: string; apiKeyId: string | null },
): Promise<any> {
  // 校验任务归属，防止 IDOR
  const relayTask = await db("o_relay_task").where({ id: taskId }).first();
  if (!relayTask) throw new RelayMJError("任务不存在", 404);
  if (relayTask.workspaceId && ctx.workspaceId && relayTask.workspaceId !== ctx.workspaceId) {
    throw new RelayMJError("无权访问该任务", 403);
  }

  const { result } = await withChannelRetry(
    { endpointType: "image_generation", model: "midjourney", workspaceId: ctx.workspaceId },
    0, // 查询不重试
    async (channel: RelayChannel) => {
      const apiKey = resolveChannelApiKey(channel);
      const baseUrl = resolveChannelBaseUrl(channel);
      if (!apiKey) throw new RelayMJError("供应商通道未配置 apiKey", 500);

      const res = await axios.get(`${baseUrl}/mj/task/${taskId}/fetch`, {
        headers: { "mj-api-secret": apiKey },
        timeout: 10000,
      });
      return res.data;
    },
  );
  return result;
}
