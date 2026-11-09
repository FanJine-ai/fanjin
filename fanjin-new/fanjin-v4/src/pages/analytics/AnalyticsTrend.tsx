import { useMemo, useState } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export type ModelSeries = { id: string; name: string; calls: number };
export const modelColor = (index: number) => `var(--analytics-model-${index % 10})`;

export function AnalyticsTrend({ series = [], rows = [], loading, calls = 0, custom, days }: {
  series?: ModelSeries[]; rows?: Array<{ day: number; values: Record<string, number> }>;
  loading: boolean; calls?: number; custom: boolean; days: number;
}) {
  const [hidden, setHidden] = useState<string[]>([]);
  const [showTotal, setShowTotal] = useState(true);
  const selected = series.filter(model => !hidden.includes(model.id));
  const allSelected = showTotal && selected.length === series.length;
  const chartRows = useMemo(() => rows.map(row => ({ ...row, total: Object.values(row.values).reduce((sum, count) => sum + count, 0) })), [rows]);
  return <section className="analyticsPanel analyticsTrendPanel">
    <div className="analyticsSectionHead"><div><h2>调用趋势</h2><p>{custom ? "所选范围" : `${days} 天内`}全部模型总计、前五模型与其他 · 北京时间</p></div></div>
    {!loading && calls > 0 && <div className="analyticsModelLegend" role="group" aria-label="选择趋势模型">
      <button aria-pressed={showTotal} title="全部模型调用量之和，不随模型勾选变化" onClick={() => setShowTotal(current => !current)}>
        <i style={{ backgroundColor: "var(--cui-text)" }} /><span>总计</span><small>{calls.toLocaleString("zh-CN")}</small>
      </button>
      {series.map((model, index) => <button key={model.id} aria-pressed={!hidden.includes(model.id)} title={`${model.name} · ${model.calls.toLocaleString("zh-CN")} 次${model.id === "other" ? "（前五以外的所有模型）" : ""}`} onClick={() => setHidden(current => current.includes(model.id) ? current.filter(id => id !== model.id) : [...current, model.id])}>
        <i style={{ backgroundColor: model.id === "other" ? "var(--analytics-model-other)" : modelColor(index) }} /><span>{model.name}</span><small>{model.calls.toLocaleString("zh-CN")}</small>
      </button>)}
      <button className="analyticsModelSelectAll" onClick={() => { setHidden(series.map(model => model.id)); setShowTotal(true); }}>仅看总计</button>
      <button className="analyticsModelSelectAll" onClick={() => { setHidden(allSelected ? series.map(model => model.id) : []); setShowTotal(!allSelected); }}>{allSelected ? "清空" : "全选"}</button>
    </div>}
    <div className="analyticsChart">{loading ? <div className="analyticsSkeleton" role="status">正在读取趋势…</div> : !calls ? <div className="analyticsEmpty">开始创作后，这里将展示你的使用趋势</div> : !selected.length && !showTotal ? <div className="analyticsEmpty">选择上方总计或模型，查看调用趋势</div> : <ResponsiveContainer width="100%" height="100%">
      <LineChart data={chartRows} margin={{ top: 12, right: 14, left: -20, bottom: 4 }}>
        <CartesianGrid vertical={false} stroke="var(--cui-border)" strokeDasharray="3 5" />
        <XAxis dataKey="day" tickFormatter={value => new Date(value).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit", timeZone: "Asia/Shanghai" })} axisLine={false} tickLine={false} tick={{ fill: "var(--cui-text-muted)", fontSize: 11 }} minTickGap={30} />
        <YAxis allowDecimals={false} axisLine={false} tickLine={false} tick={{ fill: "var(--cui-text-muted)", fontSize: 11 }} />
        <Tooltip labelFormatter={value => new Date(Number(value)).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" })} formatter={(value, name) => [`${value} 次`, name]} contentStyle={{ background: "var(--cui-surface)", border: "1px solid var(--cui-border)", borderRadius: 10, color: "var(--cui-text)" }} />
        {series.map((model, index) => hidden.includes(model.id) ? null : <Line key={model.id} dataKey={row => row.values[model.id] || 0} name={model.name} type="monotone" stroke={model.id === "other" ? "var(--analytics-model-other)" : modelColor(index)} strokeDasharray={model.id === "other" ? "4 4" : undefined} strokeWidth={2} dot={false} activeDot={{ r: 3 }} isAnimationActive={false} />)}
        {showTotal && <Line className="analyticsTotalLine" dataKey="total" name="总计（全部模型）" type="monotone" stroke="var(--cui-text)" strokeWidth={3} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />}
      </LineChart>
    </ResponsiveContainer>}</div>
  </section>;
}
