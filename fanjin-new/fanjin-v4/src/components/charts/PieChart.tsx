import {
  PieChart as RechartsPieChart,
  Pie,
  Cell,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

interface PieChartProps {
  data: any[];
  dataKey: string;
  nameKey: string;
  height?: number;
  colors?: string[];
}

const DEFAULT_COLORS = [
  "hsl(var(--chart-1))",
  "hsl(var(--chart-2))",
  "hsl(var(--chart-3))",
  "hsl(var(--chart-4))",
  "hsl(var(--chart-5))",
];

export function PieChart({
  data,
  dataKey,
  nameKey,
  height = 300,
  colors = DEFAULT_COLORS,
}: PieChartProps) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <RechartsPieChart margin={{ top: 5, right: 5, left: 5, bottom: 5 }}>
        <Pie
          data={data}
          dataKey={dataKey}
          nameKey={nameKey}
          cx="50%"
          cy="50%"
          innerRadius="52%"
          outerRadius="76%"
          paddingAngle={3}
          stroke="var(--cui-surface)"
          strokeWidth={3}
          isAnimationActive={false}
        >
          {data.map((_, index) => (
            <Cell key={`cell-${index}`} fill={colors[index % colors.length]} />
          ))}
        </Pie>
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
      </RechartsPieChart>
    </ResponsiveContainer>
  );
}
