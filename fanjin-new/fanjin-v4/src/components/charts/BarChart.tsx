import {
  BarChart as RechartsBarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

interface BarChartProps {
  data: any[];
  bars: {
    dataKey: string;
    name: string;
    color: string;
  }[];
  xAxisKey: string;
  height?: number;
  layout?: "vertical" | "horizontal";
}

export function BarChart({
  data,
  bars,
  xAxisKey,
  height = 300,
  layout = "horizontal",
}: BarChartProps) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <RechartsBarChart
        data={data}
        margin={{ top: 5, right: 20, left: 4, bottom: 5 }}
        layout={layout}
      >
        <CartesianGrid
          strokeDasharray="3 5"
          stroke="var(--cui-border-subtle)"
          vertical={layout === "vertical"}
          horizontal={layout === "horizontal"}
        />
        {layout === "horizontal" ? (
          <>
            <XAxis
              dataKey={xAxisKey}
              stroke="var(--cui-text-muted)"
              axisLine={false}
              tickLine={false}
              tickMargin={8}
              style={{ fontSize: "12px" }}
            />
            <YAxis
              stroke="var(--cui-text-muted)"
              axisLine={false}
              tickLine={false}
              tickMargin={8}
              style={{ fontSize: "12px" }}
            />
          </>
        ) : (
          <>
            <XAxis
              type="number"
              stroke="var(--cui-text-muted)"
              axisLine={false}
              tickLine={false}
              tickMargin={8}
              style={{ fontSize: "12px" }}
            />
            <YAxis
              type="category"
              dataKey={xAxisKey}
              stroke="var(--cui-text-muted)"
              axisLine={false}
              tickLine={false}
              tickMargin={8}
              style={{ fontSize: "12px" }}
              width={112}
              tickFormatter={(value: string) =>
                value.length > 17 ? value.slice(0, 16) + "…" : value
              }
            />
          </>
        )}
        <Tooltip
          contentStyle={{
            backgroundColor: "var(--cui-surface)",
            border: "1px solid var(--cui-border)",
            borderRadius: "12px",
            color: "var(--cui-text)",
            boxShadow: "var(--cui-shadow-popover)",
            padding: "10px 12px",
            fontSize: "12px",
          }}
        />
        <Legend
          iconType="circle"
          iconSize={7}
          wrapperStyle={{
            fontSize: "12px",
            paddingTop: "16px",
            color: "var(--cui-text-muted)",
          }}
        />
        {bars.map((bar) => (
          <Bar
            key={bar.dataKey}
            dataKey={bar.dataKey}
            name={bar.name}
            fill={bar.color}
            radius={layout === "vertical" ? [0, 5, 5, 0] : [5, 5, 0, 0]}
            maxBarSize={28}
            isAnimationActive={false}
          />
        ))}
      </RechartsBarChart>
    </ResponsiveContainer>
  );
}
