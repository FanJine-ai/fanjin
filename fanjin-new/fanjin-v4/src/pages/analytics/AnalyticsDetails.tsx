import { AnalyticsExports } from "./AnalyticsExports";
import { useEffect, useRef, useState } from "react";
import { RefreshCw, TerminalSquare } from "lucide-react";
import { Button, DataTable, Dialog, Drawer, type DataTableColumn } from "../../ui/console";
import { apiPost } from "../../api/http";
import { date, gu, guRate, label, failureLabels, useAnalytics, type Filters } from "./analytics";
import "./Analytics.css";

type Row = Record<string, any>;
type Page = { items: Row[]; nextCursor: string | null; financialVisible: boolean; snapshotAt: number };
export function AnalyticsDetails({ filters, kind = "usage", compact = false }: { filters: Filters; kind?: "usage" | "ledger"; compact?: boolean }) {
  const [search, setSearch] = useState(String(filters.query || ""));
  const [appliedSearch, setAppliedSearch] = useState(String(filters.query || ""));
  const [model, setModel] = useState(String(filters.model || ""));
  const [source, setSource] = useState(String(filters.source || ""));
  const [status, setStatus] = useState(String(filters.status || ""));
  const [executionStatus, setExecutionStatus] = useState(String(filters.executionStatus || ""));
  const [failureCategory, setFailureCategory] = useState(String(filters.failureCategory || ""));
  const [member, setMember] = useState(String(filters.memberId || ""));
  const [project, setProject] = useState(String(filters.projectId || ""));
  const [keyId, setKeyId] = useState(String(filters.apiKeyId || ""));
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  const [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState<string>();
  const [connect, setConnect] = useState(false);
  const query: Filters = { ...filters, query: appliedSearch || undefined, ...(kind === "usage" ? { model: model || undefined, source: source || undefined, status: status || undefined, executionStatus: executionStatus || undefined, failureCategory: failureCategory || undefined, memberId: member ? Number(member) : undefined, projectId: project ? Number(project) : undefined, apiKeyId: keyId || undefined } : {}) };
  const queryKey = JSON.stringify([query, kind]);
  const previousQuery = useRef(queryKey);
  const activeCursor = previousQuery.current === queryKey ? cursors.at(-1) : undefined;
  useEffect(() => { previousQuery.current = queryKey; setCursors([undefined]); setSelected(undefined); }, [queryKey]);
  const page = useAnalytics<Page>(kind, { ...query, cursor: activeCursor, limit: compact ? 5 : 20 }, refresh);
  const [detail, setDetail] = useState<{ data?: Row; error?: string; loading?: boolean }>({});
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController(); setDetail({ loading: true });
    apiPost<Row>(`/analytics/${kind}-detail`, { ...query, id: selected }, undefined, { signal: controller.signal }).then(data => { if (!controller.signal.aborted) setDetail({ data }); }).catch(error => { if (!controller.signal.aborted) setDetail({ error: error.message }); });
    return () => controller.abort();
  }, [selected, queryKey]);
  const financial = page.data?.financialVisible;
  const columns: DataTableColumn<Row>[] = kind === "usage" ? [
    { id: "createdAt", priority: "primary", hideable: false, header: "时间 / 调用", cell: r => <button className="analyticsRowLink" onClick={() => setSelected(r.id)}><span>{date(r.createdAt)}</span><small>{r.requestId || r.id}</small></button> },
    { id: "model", priority: "primary", header: "模型", accessor: "model" },
    { id: "source", header: "来源", cell: r => label(r.source) },
    { id: "units", header: "用量", cell: r => `${r.units} ${label(r.unit)}` },
    { id: "status", header: "状态", cell: r => <span className={`analyticsStatus ${r.executionStatus === "failed" ? "isError" : ""}`}>{label(r.executionStatus)}<small>{label(r.billingStatus)}</small></span> },
    ...(financial ? [{ id: "net", priority: "primary" as const, header: "净消耗", align: "end" as const, cell: (r: Row) => gu(r.net) }] : []),
  ] : [
    { id: "createdAt", priority: "primary", hideable: false, header: "时间 / 流水", cell: r => <button className="analyticsRowLink" onClick={() => setSelected(r.id)}><span>{date(r.createdAt)}</span><small>{r.id}</small></button> },
    { id: "type", header: "类型", cell: r => label(r.type) },
    { id: "direction", header: "方向", cell: r => label(r.direction || "unknown") },
    { id: "amount", priority: "primary", header: "变动额度", cell: r => gu(r.amount) },
    { id: "balanceAfter", header: filters.scope === "account" ? "变动后通用余额" : "变动后额度", cell: r => gu(r.balanceAfter, "down") },
  ];
  const cliQuery = Object.entries({ scope: query.scope, from: query.from, to: query.to, model: query.model, source: query.source, status: query.status, "execution-status": query.executionStatus, "failure-category": query.failureCategory, member: query.memberId, project: query.projectId, "key-id": query.apiKeyId, query: query.query })
    .filter(([, value]) => value != null && value !== "").map(([flag, value]) => ` --${flag} '${String(value).split("'").join("'\\''")}'`).join("");
  const toolInput = { action: kind, ...query, limit: 20 };
  return <section className="analyticsDetails">
    <div className="analyticsSectionHead"><div><h2>{kind === "usage" ? "调用明细" : "资金流水"}</h2><p>{kind === "usage" ? "按调用查看模型、用量与结算结果" : "冻结与释放单独记录，不重复计入消费"}</p></div><div className="analyticsActions"><Button variant="secondary" icon={<TerminalSquare size={15} />} onClick={() => setConnect(true)}>接入查询</Button><AnalyticsExports key={queryKey} filters={query} kind={kind} disabled={page.loading || Boolean(page.error)} /><Button variant="ghost" aria-label="刷新明细" onClick={() => { setCursors([undefined]); setRefresh(v => v + 1); }}><RefreshCw size={16} /></Button></div></div>
    {!compact && <form className="analyticsFilters" onSubmit={e => { e.preventDefault(); setAppliedSearch(search); }}><input aria-label="搜索明细 ID" placeholder="请求、任务或明细 ID" value={search} onChange={e => setSearch(e.target.value)} /><Button type="submit" variant="secondary">查询</Button>{kind === "usage" && <><input aria-label="筛选模型" placeholder="模型名称" value={model} onChange={e => setModel(e.target.value)} /><select aria-label="筛选来源" value={source} onChange={e => setSource(e.target.value)}><option value="">全部来源</option>{["web", "api", "mcp", "cli", "unknown"].map(v => <option key={v} value={v}>{label(v)}</option>)}</select><select aria-label="筛选执行状态" value={executionStatus} onChange={e => setExecutionStatus(e.target.value)}><option value="">全部执行状态</option>{["succeeded", "failed", "cancelled", "expired", "queued", "running", "unknown", "unsuccessful", "unfinished"].map(v => <option key={v} value={v}>{label(v)}</option>)}</select><select aria-label="筛选结算状态" value={status} onChange={e => setStatus(e.target.value)}><option value="">全部结算状态</option>{["charged", "reserved", "refunded", "free", "pending_reconcile"].map(v => <option key={v} value={v}>{label(v)}</option>)}</select><details><summary>更多筛选</summary><div className="analyticsFilters"><select aria-label="筛选失败原因" value={failureCategory} onChange={e => setFailureCategory(e.target.value)}><option value="">全部失败原因</option>{Object.entries(failureLabels).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select><input type="number" min="1" aria-label="成员 ID" placeholder="成员 ID" value={member} onChange={e => setMember(e.target.value)} /><input type="number" min="1" aria-label="项目 ID" placeholder="项目 ID" value={project} onChange={e => setProject(e.target.value)} /><input aria-label="密钥 ID" placeholder="密钥 ID" value={keyId} onChange={e => setKeyId(e.target.value)} /></div></details></>}</form>}
    <DataTable key={`${kind}-${Boolean(financial)}`} columns={columns} rows={page.data?.items || []} getRowId={r => r.id} loading={page.loading} error={page.error ? <span role="alert">{page.error} <button onClick={() => setRefresh(v => v + 1)}>重试</button></span> : undefined} emptyState="所选范围内暂无记录" ariaLabel={kind === "usage" ? "调用明细" : "资金流水"} />
    {!compact && <div className="analyticsPagination"><small>第 {cursors.length} 页 · 北京时间 · 1 元 = 10 GU</small><Button variant="secondary" disabled={cursors.length === 1 || page.loading} onClick={() => setCursors(v => v.slice(0, -1))}>上一页</Button><Button variant="secondary" disabled={!page.data?.nextCursor || page.loading} onClick={() => setCursors(v => [...v, page.data!.nextCursor!])}>下一页</Button></div>}
    <Drawer open={Boolean(selected)} onOpenChange={open => { if (!open) setSelected(undefined); }} title={kind === "usage" ? "调用详情" : "流水详情"} size="520px"><div className="analyticsDetailBody">{detail.loading ? <p role="status">正在读取详情…</p> : detail.error ? <p role="alert">{detail.error}</p> : detail.data && <><dl>{Object.entries(detail.data.item).filter(([k]) => !["apiKeyId", "workspaceId"].includes(k)).map(([k, v]) => <div key={k}><dt>{{ id: "明细 ID", taskId: "任务 ID", requestId: "请求 ID", projectId: "项目", memberId: "成员", keyName: "密钥", model: "模型", endpointType: "调用类型", source: "来源", unit: "计费单位", units: "用量", billingStatus: "结算状态", executionStatus: "执行状态", durationMs: "执行耗时（毫秒）", queueMs: "排队耗时（毫秒）", failureCategory: "失败原因", createdAt: "时间", charged: "已扣费", refunded: "已退款", net: "净消耗", amount: "金额", type: "类型", direction: "方向", currency: "单位", status: "状态", usageId: "调用 ID", balanceBefore: filters.scope === "account" ? "变动前通用余额" : "变动前额度", balanceAfter: filters.scope === "account" ? "变动后通用余额" : "变动后额度", reservedBefore: "变动前冻结", reservedAfter: "变动后冻结" }[k] || k}</dt><dd>{k === "createdAt" ? date(Number(v)) : k === "failureCategory" ? (v ? failureLabels[String(v)] || "未分类" : "—") : v && typeof v === "object" ? gu(v as any) : label(String(v ?? "—"))}</dd></div>)}</dl>{detail.data.billingEvidence && <section className="analyticsBillingEvidence"><h3>计费依据</h3>{detail.data.billingEvidence.pricing ? <dl><div><dt>价格快照</dt><dd>{detail.data.billingEvidence.pricing.snapshotId}</dd></div><div><dt>当时单价</dt><dd>{guRate(detail.data.billingEvidence.pricing.unitPrice)} / {label(detail.data.billingEvidence.pricing.unit)}</dd></div>{detail.data.billingEvidence.pricing.multiplier != null && <div><dt>计价倍率</dt><dd>{detail.data.billingEvidence.pricing.multiplier}</dd></div>}<div><dt>价格版本时间</dt><dd>{date(detail.data.billingEvidence.pricing.updatedAt)}</dd></div></dl> : <p>这笔记录未保存可展示的历史价格快照。</p>}<h3>积分来源</h3>{detail.data.billingEvidence.funding.length ? detail.data.billingEvidence.funding.map((entry: Row) => <div className="analyticsFundingRow" key={entry.ledgerId}><strong>{label(entry.type)} · {gu(entry.amount)}</strong><p>{entry.known ? entry.pools.map((pool: Row) => `${({ cash: "通用余额", gift: "赠送积分", credit: "授信" } as Record<string, string>)[pool.source]} ${gu(pool.amount)}`).join(" · ") : "历史来源未完整记录"}</p></div>) : <p>暂无扣费来源记录。</p>}</section>}{detail.data.lifecycle?.length > 0 && <><h3>结算过程</h3><ol className="analyticsLifecycle">{detail.data.lifecycle.map((r: Row) => <li key={r.id}><strong>{label(r.type)} · {gu(r.amount)}</strong><small>{date(r.createdAt)}</small></li>)}</ol>{detail.data.lifecycleTruncated && <p>仅展示前 100 条结算流水，请在资金流水中继续查询。</p>}</>}</>}</div></Drawer>
    <Dialog open={connect} onOpenChange={setConnect} title="接入查询" description="网页、API、MCP 与 CLI 共用相同的数据范围和权限。" size="lg"><div className="analyticsDetailBody"><p>密钥需授权用量读取；读取资金需额外的账单权限，跨工作区查询本人的账号数据需单独授权账号读取。工作区密钥不能查询其他工作区。</p><h3>API</h3><pre>{`POST /api/tools/v1/fanjin_analytics_query\nAuthorization: Bearer $FANJIN_API_KEY\nContent-Type: application/json\n\n${JSON.stringify(toolInput, null, 2)}`}</pre><h3>MCP</h3><p>调用 <code>fanjin_analytics_query</code>，传入以上 JSON 参数。</p><h3>CLI</h3><pre>{`fanjin ${kind === "usage" ? "usage list" : "billing ledger"}${cliQuery}`}</pre><p>响应中的 nextCursor 用于下一页；导出使用 action: export，传入 kind。直到 nextCursor 为空才是完整导出。</p></div></Dialog>
  </section>;
}
