import { useEffect, useState } from "react";
import { formatGuMicros } from "../../utils/billingUnits";
import { apiPost } from "../../api/http";
export type Scope = "workspace" | "account";
export type Amount = { gu: string; guMicros: string };
export type Filters = { scope: Scope; workspaceId?: string; from?: number; to?: number; [key: string]: unknown };
export const gu = (value?: Amount | null, rounding: "up" | "down" = "up") => value ? formatGuMicros(value.guMicros, 2, rounding) : "—";
export const guRate = (value?: Amount | null) => value ? formatGuMicros(value.guMicros, 8) : "—";
export const date = (value?: number | null) => value ? new Date(value).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" }) : "—";
export const labels: Record<string, string> = { web: "网页", api: "API", mcp: "MCP", cli: "CLI", unknown: "未知", expired: "已过期", unsuccessful: "失败 / 取消 / 过期", unfinished: "进行中 / 未知", image_generation: "图片生成", video_generation: "视频生成", text: "文本生成", second: "秒", image: "张", token: "Token", credit: "增加", debit: "减少", charged: "已扣费", reserved: "已冻结", free: "免扣费", pending_reconcile: "待核账", refunded: "已退款", succeeded: "已成功", completed: "已完成", failed: "失败", cancelled: "已取消", queued: "排队中", running: "执行中", submitted: "已提交", deduct: "扣费", refund: "退款", freeze: "冻结", release: "释放", recharge: "充值", spend_capture: "消费结算", spend_reserve: "消费冻结", spend_release: "消费释放", allocate_to_workspace: "工作区额度分配", auto_allocate_to_default_workspace: "默认工作区额度", gift_grant: "赠送", gift_expire: "赠额到期", gift_revoke: "收回赠额", credit_set: "授信调整", manual_credit: "余额增加", manual_debit: "余额减少" };
export const label = (value: string) => labels[value] || value || "—";
export function useAnalytics<T>(action: string, input: Filters, refresh = 0) {
  const [state, setState] = useState<{ key?: string; data?: T; loading: boolean; error?: string }>({ loading: true });
  const key = JSON.stringify(input);
  const requestKey = `${action}:${refresh}:${key}`;
  useEffect(() => {
    const controller = new AbortController();
    setState({ key: requestKey, loading: true });
    apiPost<T>(`/analytics/${action}`, JSON.parse(key), undefined, { signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) setState({ key: requestKey, data, loading: false }); })
      .catch(error => { if (!controller.signal.aborted) setState({ key: requestKey, loading: false, error: error.message || "读取失败，请重试" }); });
    return () => controller.abort();
  }, [action, key, refresh]);
  return state.key === requestKey ? state : { loading: true, data: undefined, error: undefined };
}

export const failureLabels: Record<string, string> = { policy: "内容审核", invalid_input: "参数或素材", rate_limit: "请求限流", timeout: "任务超时", upstream: "服务异常", cancelled: "主动取消", expired: "任务过期", unknown: "未分类" };
export const duration = (ms: number | null | undefined) => ms == null ? "—" : ms < 1000 ? `${Math.round(ms)} 毫秒` : ms < 60000 ? `${(ms / 1000).toFixed(1)} 秒` : `${(ms / 60000).toFixed(1)} 分钟`;
