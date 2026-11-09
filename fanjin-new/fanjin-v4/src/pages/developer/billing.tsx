import { WorkspaceOverviewCharts } from "../workspace/WorkspaceOverviewCharts";
import "../workspace/WorkspaceHomePage.css";
import { GU_MICROS_PER_GU } from "@/utils/billingUnits";
import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, Clock, DollarSign, TrendingUp } from "lucide-react";
import { apiPost } from "../../api/http";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Alert, Button, ConsolePage } from "../../ui/console";
import { useWorkspaceStore } from "../../stores/workspaceStore";

type OverviewData = {
  summary: {
    activeKeys: number;
    totalKeys: number;
    activeMembers: number;
    monthRequests: number;
    errorRate: number;
    avgDurationMs: number;
    p95DurationMs: number;
    availableMicros: number;
    apiQuota: number;
  };
  analytics: {
    days: number;
    totalRequests: number;
    totalErrors: number;
    totalCostMicros: number;
    totalUnits: number;
    avgRpm: number;
    avgTpm: number;
    successRate: number;
    byDay: Array<{
      date: string;
      requests: number;
      errors: number;
      costMicros: number;
      units: number;
    }>;
    byModel: Array<{
      model: string;
      calls: number;
      errors: number;
      successRate: number;
      avgDurationMs: number;
      costMicros: number;
      units: number;
    }>;
    byCaller: Array<{
      name: string;
      calls: number;
      errors: number;
      successRate: number;
      avgDurationMs: number;
    }>;
  };
};

type BillingOverviewState = {
  loading: boolean;
  error: string;
  data: OverviewData | null;
  workspaceId: string;
  days: number;
};

function normalizeOverviewData(payload: Partial<OverviewData> | null | undefined, days: number): OverviewData {
  const summary = payload?.summary;
  const analytics = payload?.analytics;
  return {
    summary: {
      activeKeys: Number(summary?.activeKeys || 0),
      totalKeys: Number(summary?.totalKeys || 0),
      activeMembers: Number(summary?.activeMembers || 0),
      monthRequests: Number(summary?.monthRequests || 0),
      errorRate: Number(summary?.errorRate || 0),
      avgDurationMs: Number(summary?.avgDurationMs || 0),
      p95DurationMs: Number(summary?.p95DurationMs || 0),
      availableMicros: Number(summary?.availableMicros || 0),
      apiQuota: Number(summary?.apiQuota || 0),
    },
    analytics: {
      days: Number(analytics?.days || days),
      totalRequests: Number(analytics?.totalRequests || 0),
      totalErrors: Number(analytics?.totalErrors || 0),
      totalCostMicros: Number(analytics?.totalCostMicros || 0),
      totalUnits: Number(analytics?.totalUnits || 0),
      avgRpm: Number(analytics?.avgRpm || 0),
      avgTpm: Number(analytics?.avgTpm || 0),
      successRate: Number(analytics?.successRate || 0),
      byDay: Array.isArray(analytics?.byDay) ? analytics.byDay : [],
      byModel: Array.isArray(analytics?.byModel) ? analytics.byModel : [],
      byCaller: Array.isArray(analytics?.byCaller) ? analytics.byCaller : [],
    },
  };
}

function formatCurrency(micros: number): string {
  return `${(micros / GU_MICROS_PER_GU).toLocaleString("zh-CN", { maximumFractionDigits: 6 })} GU`;
}

function formatNumber(num: number): string {
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
  return num.toString();
}

export default function DeveloperBillingPage() {
  const currentWorkspaceId = useWorkspaceStore((state) => state.currentWorkspaceId);
  const requestedWorkspaceId = currentWorkspaceId == null
    ? ""
    : String(currentWorkspaceId).trim();
  const requestGeneration = useRef(0);
  const [retryKey, setRetryKey] = useState(0);
  const [days, setDays] = useState(7);
  const [state, setState] = useState<BillingOverviewState>({
    loading: true,
    error: "",
    data: null,
    workspaceId: requestedWorkspaceId,
    days,
  });
  const retry = useCallback(() => setRetryKey((key) => key + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    const generation = ++requestGeneration.current;
    setState({
      loading: true,
      error: "",
      data: null,
      workspaceId: requestedWorkspaceId,
      days,
    });
    const payload: Record<string, unknown> = { days };
    if (requestedWorkspaceId) payload.workspaceId = requestedWorkspaceId;
    void apiPost<Partial<OverviewData>>(
      "/developer/overview",
      payload,
      undefined,
      { signal: controller.signal },
    )
      .then((result) => {
        if (controller.signal.aborted || generation !== requestGeneration.current) return;
        setState({
          loading: false,
          error: "",
          data: normalizeOverviewData(result, days),
          workspaceId: requestedWorkspaceId,
          days,
        });
      })
      .catch(() => {
        if (controller.signal.aborted || generation !== requestGeneration.current) return;
        setState({
          loading: false,
          error: "用量与账单读取失败，请稍后重试。",
          data: null,
          workspaceId: requestedWorkspaceId,
          days,
        });
      });
    return () => controller.abort();
  }, [days, requestedWorkspaceId, retryKey]);

  const visibleState = state.workspaceId === requestedWorkspaceId
    && state.days === days
    ? state
    : {
        loading: true,
        error: "",
        data: null,
        workspaceId: requestedWorkspaceId,
        days,
      };
  const { loading, error, data } = visibleState;

  if (loading) {
    return (
      <ConsolePage className="developerBillingPage" layoutWidth="dashboard" eyebrow="Developer API" title="用量与账单" description="API 调用量、成本和稳定性概览。">
        <div className="flex items-center justify-center h-64">
          <div className="flex items-center gap-2 text-[var(--cui-text-muted)]">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-[var(--cui-border)] border-t-[var(--cui-accent)]" />
            <span className="text-sm">正在加载数据...</span>
          </div>
        </div>
      </ConsolePage>
    );
  }

  if (error || !data) {
    return (
      <ConsolePage className="developerBillingPage" layoutWidth="dashboard" eyebrow="Developer API" title="用量与账单" description="API 调用量、成本和稳定性概览。">
        <Alert tone="danger">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>{error || "数据加载失败"}</span>
            <Button variant="secondary" size="compact" onClick={retry}>重试</Button>
          </div>
        </Alert>
      </ConsolePage>
    );
  }

  return (
    <ConsolePage className="developerBillingPage" layoutWidth="dashboard" eyebrow="Developer API" title="用量与账单" description="API 调用量、成本和稳定性概览。">

      <div className="workspaceHomeToolbar">
        <span>用量概览</span>
        <div className="workspaceTimeRange" role="group" aria-label="统计时间范围">
          {([7, 14, 30] as const).map(day => <button key={day} type="button" aria-pressed={days === day} onClick={() => setDays(day)}>{day} 天</button>)}
        </div>
      </div>
      {/* 关键指标卡片 */}
      <div className="workspaceMetricGrid">
        <Card className="border-[var(--cui-border)] bg-[var(--cui-surface)]">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-[var(--cui-text-muted)]">总请求数</CardTitle>
            <Activity className="h-4 w-4 text-[var(--cui-accent)]" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-[var(--cui-text)]">{formatNumber(data.analytics.totalRequests)}</div>
            <p className="text-xs text-[var(--cui-text-muted)] mt-1">最近 {days} 天</p>
          </CardContent>
        </Card>

        <Card className="border-[var(--cui-border)] bg-[var(--cui-surface)]">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-[var(--cui-text-muted)]">成功率</CardTitle>
            <TrendingUp className="h-4 w-4 text-[var(--cui-success-text)]" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-[var(--cui-text)]">{data.analytics.successRate.toFixed(2)}%</div>
            <p className="text-xs text-[var(--cui-text-muted)] mt-1">{data.analytics.totalErrors} 个错误</p>
          </CardContent>
        </Card>

        <Card className="border-[var(--cui-border)] bg-[var(--cui-surface)]">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-[var(--cui-text-muted)]">总成本</CardTitle>
            <DollarSign className="h-4 w-4 text-[var(--cui-warning-text)]" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-[var(--cui-text)]">{formatCurrency(data.analytics.totalCostMicros)}</div>
            <p className="text-xs text-[var(--cui-text-muted)] mt-1">余额: {formatCurrency(data.summary.availableMicros)}</p>
          </CardContent>
        </Card>

        <Card className="border-[var(--cui-border)] bg-[var(--cui-surface)]">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-[var(--cui-text-muted)]">平均延迟</CardTitle>
            <Clock className="h-4 w-4 text-[var(--cui-info-text)]" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-[var(--cui-text)]">{data.summary.avgDurationMs}ms</div>
            <p className="text-xs text-[var(--cui-text-muted)] mt-1">P95: {data.summary.p95DurationMs}ms</p>
          </CardContent>
        </Card>
      </div>

      <WorkspaceOverviewCharts byDay={data.analytics.byDay} byModel={data.analytics.byModel} days={days} />
    </ConsolePage>
  );
}
