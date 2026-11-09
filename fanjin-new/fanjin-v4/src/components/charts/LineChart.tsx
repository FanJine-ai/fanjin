import {
  LineChart as RechartsLineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

interface LineChartProps {
  data: any[];
  lines: {
    dataKey: string;
    name: string;
    color: string;
  }[];
  xAxisKey: string;
  height?: number;
}

export function LineChart({
  data,
  lines,
  xAxisKey,
  height = 300,
}: LineChartProps) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <RechartsLineChart
        data={data}
        margin={{ top: 12, right: 16, left: 4, bottom: 8 }}
      >
        <CartesianGrid
          strokeDasharray="3 5"
          stroke="var(--cui-border-subtle)"
          vertical={false}
        />
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
        {lines.map((line, index) => (
          <Line
            key={line.dataKey}
            type="monotone"
            dataKey={line.dataKey}
            name={line.name}
            stroke={line.color}
            strokeWidth={2.5}
            strokeDasharray={
              index === 0 ? undefined : index === 1 ? "6 4" : "2 4"
            }
            isAnimationActive={false}
            dot={false}
            activeDot={{ r: 5 }}
          />
        ))}
      </RechartsLineChart>
    </ResponsiveContainer>
  );
}
