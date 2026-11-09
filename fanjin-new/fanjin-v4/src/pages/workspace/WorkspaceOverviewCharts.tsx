import { GU_MICROS_PER_GU } from "@/utils/billingUnits";
import { Activity } from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  XAxis,
  YAxis,
  Pie,
  PieChart,
  Cell,
} from "recharts";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "../../components/ui/chart";
import type { ReactNode } from "react";

type Day = {
  date: string;
  requests: number;
  errors: number;
  costMicros: number;
};
type Model = { model: string; calls: number };
export function compactChartNumber(value: number) {
  return value >= 1_000_000
    ? `${Number((value / 1_000_000).toFixed(1))}m`
    : value >= 1000
      ? `${Number((value / 1000).toFixed(1))}k`
      : String(value);
}

function ChartPanel({
  title,
  description,
  children,
  empty,
}: {
  title: string;
  description: string;
  children: ReactNode;
  empty?: boolean;
}) {
  return (
    <Card className="workspaceChartPanel">
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {empty ? (
          <div className="workspaceChartEmpty">
            <Activity size={22} aria-hidden="true" />
            <strong>暂无数据</strong>
            <span>所选时间范围内没有可展示的记录</span>
          </div>
        ) : (
          children
        )}
      </CardContent>
    </Card>
  );
}

export function WorkspaceOverviewCharts({
  byDay,
  byModel,
  days,
}: {
  byDay: Day[];
  byModel: Model[];
  days: number;
}) {
  const trend = byDay.map((day) => ({
    date: day.date.slice(5).replace("-", "/"),
    requests: day.requests,
    success: day.requests - day.errors,
    errors: day.errors,
    cost: Number((day.costMicros / GU_MICROS_PER_GU).toFixed(2)),
  }));
  const ranking = byModel.slice(0, 8);
  const distribution = byModel
    .slice(0, 5)
    .map((model, index) => ({
      ...model,
      fill: `hsl(var(--chart-${index + 1}))`,
    }));
  const total = distribution.reduce((sum, model) => sum + model.calls, 0);
  const requestConfig = {
    requests: { label: "总请求", color: "var(--cui-chart-request)" },
    success: { label: "成功", color: "var(--cui-chart-success)" },
    errors: { label: "错误", color: "var(--cui-chart-error)" },
  };
  return (
    <div className="workspaceOverviewCharts">
      <ChartPanel
        title="请求趋势"
        description={`最近 ${days} 天的请求量与成功情况`}
        empty={!trend.length}
      >
        <div className="workspaceChartLegend" aria-label="请求趋势图例">
          <span>
            <i data-series="requests" />
            总请求
          </span>
          <span>
            <i data-series="success" />
            成功
          </span>
          <span>
            <i data-series="errors" />
            错误
          </span>
        </div>
        <ChartContainer
          config={requestConfig}
          className="workspaceChart"
          role="group"
          aria-label="请求趋势图"
        >
          <LineChart
            data={trend}
            accessibilityLayer
            margin={{ top: 12, right: 12, bottom: 0, left: 0 }}
          >
            <CartesianGrid vertical={false} strokeDasharray="3 5" />
            <XAxis
              dataKey="date"
              axisLine={false}
              tickLine={false}
              minTickGap={24}
              tickMargin={10}
            />
            <YAxis
              width={46}
              axisLine={false}
              tickLine={false}
              tickFormatter={compactChartNumber}
              allowDecimals={false}
            />
            <ChartTooltip content={<ChartTooltipContent indicator="line" />} />
            <Line
              dataKey="requests"
              type="monotone"
              stroke="var(--color-requests)"
              strokeWidth={2.5}
              dot={false}
              isAnimationActive={false}
            />
            <Line
              dataKey="success"
              type="monotone"
              stroke="var(--color-success)"
              strokeWidth={1.5}
              strokeDasharray="6 4"
              dot={false}
              isAnimationActive={false}
            />
            <Line
              dataKey="errors"
              type="monotone"
              stroke="var(--color-errors)"
              strokeWidth={1.5}
              strokeDasharray="2 4"
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ChartContainer>
      </ChartPanel>
      <ChartPanel
        title="消耗趋势"
        description={`最近 ${days} 天的 API 调用消耗 · GU`}
        empty={!trend.length}
      >
        <div className="workspaceChartLegend">
          <span>
            <i data-series="requests" />
            消耗（GU）
          </span>
        </div>
        <ChartContainer
          config={{
            cost: { label: "消耗（GU）", color: "var(--cui-chart-request)" },
          }}
          className="workspaceChart"
          role="group"
          aria-label="消耗趋势图"
        >
          <AreaChart
            data={trend}
            accessibilityLayer
            margin={{ top: 12, right: 12, bottom: 0, left: 0 }}
          >
            <CartesianGrid vertical={false} strokeDasharray="3 5" />
            <XAxis
              dataKey="date"
              axisLine={false}
              tickLine={false}
              minTickGap={24}
              tickMargin={10}
            />
            <YAxis
              width={46}
              axisLine={false}
              tickLine={false}
              tickFormatter={compactChartNumber}
            />
            <ChartTooltip content={<ChartTooltipContent indicator="line" />} />
            <Area
              dataKey="cost"
              type="monotone"
              stroke="var(--color-cost)"
              fill="var(--color-cost)"
              fillOpacity={0.1}
              strokeWidth={2.5}
              isAnimationActive={false}
            />
          </AreaChart>
        </ChartContainer>
      </ChartPanel>
      <ChartPanel
        title="热门模型"
        description="按调用次数排序 · Top 8"
        empty={!ranking.length}
      >
        <ChartContainer
          config={{
            calls: { label: "调用次数", color: "var(--cui-chart-request)" },
          }}
          className="workspaceChart workspaceChartRanking"
          role="group"
          aria-label="热门模型调用次数"
        >
          <BarChart
            data={ranking}
            layout="vertical"
            accessibilityLayer
            margin={{ top: 0, right: 20, bottom: 0, left: 0 }}
          >
            <CartesianGrid horizontal={false} strokeDasharray="3 5" />
            <XAxis
              type="number"
              axisLine={false}
              tickLine={false}
              tickFormatter={compactChartNumber}
              allowDecimals={false}
            />
            <YAxis
              type="category"
              dataKey="model"
              width={112}
              axisLine={false}
              tickLine={false}
              tickFormatter={(value: string) =>
                value.length > 17 ? value.slice(0, 16) + "…" : value
              }
            />
            <ChartTooltip
              cursor={{ fill: "var(--cui-surface-subtle)" }}
              content={<ChartTooltipContent />}
            />
            <Bar
              dataKey="calls"
              fill="var(--color-calls)"
              radius={[0, 5, 5, 0]}
              maxBarSize={18}
              isAnimationActive={false}
            />
          </BarChart>
        </ChartContainer>
      </ChartPanel>
      <ChartPanel
        title="模型分布"
        description="Top 5 模型之间的调用占比"
        empty={!total}
      >
        <div className="workspaceDistribution">
          <ChartContainer
            config={{ calls: { label: "调用次数" } }}
            className="workspaceDonut"
            role="group"
            aria-label="Top 5 模型调用占比"
          >
            <PieChart>
              <ChartTooltip
                content={<ChartTooltipContent nameKey="model" hideLabel />}
              />
              <Pie
                data={distribution}
                dataKey="calls"
                nameKey="model"
                innerRadius="63%"
                outerRadius="85%"
                paddingAngle={3}
                stroke="var(--cui-surface)"
                strokeWidth={3}
                isAnimationActive={false}
              >
                {distribution.map((model) => (
                  <Cell key={model.model} fill={model.fill} />
                ))}
              </Pie>
            </PieChart>
          </ChartContainer>
          <ul className="workspaceDistributionLegend" aria-label="模型占比明细">
            {distribution.map((model) => (
              <li key={model.model}>
                <i style={{ background: model.fill }} aria-hidden="true" />
                <span title={model.model}>{model.model}</span>
                <strong>{((model.calls / total) * 100).toFixed(1)}%</strong>
              </li>
            ))}
          </ul>
        </div>
      </ChartPanel>
    </div>
  );
}
