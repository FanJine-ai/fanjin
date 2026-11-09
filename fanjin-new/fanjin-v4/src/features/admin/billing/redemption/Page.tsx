import { GU_MICROS_PER_GU } from "@/utils/billingUnits";
import { useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Copy, Download, Eye, Plus, RefreshCcw } from "lucide-react";
import { Badge, Button, ConfirmDialog, ConsolePage, DataTable, Dialog, Drawer, FilterBar, Input, MetricStrip, Select, Tooltip, TooltipContent, TooltipTrigger, useToast, type DataTableColumn } from "../../../../ui/console";
import { disableRedemptionCode, generateRedemptionCodes, listAllRedemptionCodesByBatch } from "./api";
import { GenerateDialog } from "./GenerateDialog";
import { useRedemptionCodes } from "./hooks";
import { buildGeneratePayload, emptyRedemptionForm, groupBatches, type RedemptionBatch, type RedemptionCode, type RedemptionForm } from "./types";
import "./redemption.css";

const gu = (value?: number | null) => `${(Number(value || 0) / GU_MICROS_PER_GU).toLocaleString("zh-CN", { maximumFractionDigits: 2 })} GU`;
function date(value?: number | null) { if (!value) return "永久"; const d = new Date(value); return Number.isNaN(d.getTime()) ? "-" : new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(d); }
function statusView(status?: string | null) { if (status === "unused") return { label: "未使用", tone: "success" as const }; if (status === "redeemed") return { label: "已兑换", tone: "neutral" as const }; return { label: "已禁用", tone: "danger" as const }; }
function downloadCodesCsv(codes: string[], filename: string) { const csv = `code\n${codes.map((code) => `"${code.replace(/"/g, '""')}"`).join("\n")}`; const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" })); const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; anchor.click(); URL.revokeObjectURL(url); }

export function RedemptionPage() {
  const [page, setPage] = useState(1); const [status, setStatus] = useState(""); const [batchQuery, setBatchQuery] = useState("");
  const { total, items, loading, error, reload } = useRedemptionCodes(page, status, batchQuery);
  const { toast } = useToast(); const [generateOpen, setGenerateOpen] = useState(false); const [form, setForm] = useState<RedemptionForm>(() => emptyRedemptionForm()); const [initial, setInitial] = useState<RedemptionForm>(() => emptyRedemptionForm()); const [saving, setSaving] = useState(false); const [formError, setFormError] = useState(""); const [generated, setGenerated] = useState<string[]>([]); const [resultOpen, setResultOpen] = useState(false);
  const [detail, setDetail] = useState<RedemptionBatch | null>(null); const [detailCodes, setDetailCodes] = useState<RedemptionCode[]>([]); const [detailLoading, setDetailLoading] = useState(false); const [detailError, setDetailError] = useState(""); const [disableRow, setDisableRow] = useState<RedemptionCode | null>(null);
  const detailRequestRef = useRef<AbortController | null>(null);
  const batches = useMemo(() => groupBatches(items), [items]);
  const openGenerate = () => { const next = emptyRedemptionForm(); setForm(next); setInitial({ ...next }); setFormError(""); setGenerateOpen(true); };
  const generate = async () => { setSaving(true); setFormError(""); try { const codes = await generateRedemptionCodes(buildGeneratePayload(form)); setGenerated(codes); setGenerateOpen(false); setResultOpen(true); setPage(1); toast({ title: `已生成 ${codes.length} 张兑换码`, tone: "success" }); await reload(); } catch (caught) { const message = caught instanceof Error ? caught.message : "兑换码生成失败"; setFormError(message); } finally { setSaving(false); } };
  const copyCodes = async () => { try { await navigator.clipboard.writeText(generated.join("\n")); toast({ title: "兑换码已复制", tone: "success" }); } catch { toast({ title: "复制失败", message: "请手动选择并复制结果", tone: "danger" }); } };
  const exportCodes = () => downloadCodesCsv(generated, `redemption-codes-${Date.now()}.csv`);
  const exportDetailCodes = () => { if (!detail || detailLoading || detailError) return; const codes = detailCodes.flatMap((item) => item.code ? [item.code] : []); downloadCodesCsv(codes, `redemption-batch-${detail.id.replace(/[^a-zA-Z0-9_-]/g, "-")}.csv`); };
  const openBatch = async (batch: RedemptionBatch) => { detailRequestRef.current?.abort(); const controller = new AbortController(); detailRequestRef.current = controller; setDetail(batch); setDetailCodes([]); setDetailError(""); setDetailLoading(true); try { const result = await listAllRedemptionCodesByBatch(batch.id, controller.signal); if (detailRequestRef.current !== controller) return; setDetailCodes(result.items); } catch (caught) { if (controller.signal.aborted || detailRequestRef.current !== controller) return; setDetailError(caught instanceof Error ? caught.message : "批次详情读取失败"); } finally { if (detailRequestRef.current === controller) { detailRequestRef.current = null; setDetailLoading(false); } } };
  const batchColumns = useMemo<DataTableColumn<RedemptionBatch>[]>(() => [
    { id: "batch", header: "批次", priority: "primary", minWidth: "220px", sortable: true, sortValue: (r) => r.note, cell: (r) => <div className="redemptionBatchCell"><strong>{r.note}</strong><Tooltip><TooltipTrigger className="redemptionBatchId"><code>{r.id}</code></TooltipTrigger><TooltipContent align="start">{r.id}</TooltipContent></Tooltip></div> },
    { id: "amount", header: "面值", priority: "primary", align: "end", sortable: true, sortValue: (r) => r.amountMicros, cell: (r) => gu(r.amountMicros) },
    { id: "count", header: "本页数量", priority: "secondary", align: "end", cell: (r) => r.codes.length },
    { id: "status", header: "状态构成", priority: "secondary", minWidth: "190px", cell: (r) => <div className="redemptionStatusGroup" aria-label={`未使用 ${r.unused}，已兑换 ${r.redeemed}${r.disabled > 0 ? `，已禁用 ${r.disabled}` : ""}`}><span data-tone="positive">未用 <strong>{r.unused}</strong></span><span data-tone="neutral">已兑 <strong>{r.redeemed}</strong></span>{r.disabled > 0 && <span data-tone="danger">禁用 <strong>{r.disabled}</strong></span>}</div> },
    { id: "expires", header: "到期", priority: "detail", cell: (r) => date(r.expiresAt), minWidth: "150px" },
    { id: "created", header: "创建时间", priority: "detail", cell: (r) => date(r.createdAt), minWidth: "150px" },
    { id: "actions", header: "操作", priority: "primary", hideable: false, cell: (r) => <Button variant="secondary" size="compact" icon={<Eye size={15} />} onClick={() => void openBatch(r)}>查看批次</Button> },
  ], []);
  const codeColumns = useMemo<DataTableColumn<RedemptionCode>[]>(() => [
    { id: "code", header: "兑换码", priority: "primary", minWidth: "190px", cell: (r) => <code>{r.code || "-"}</code> },
    { id: "status", header: "状态", priority: "primary", cell: (r) => { const view = statusView(r.status); return <Badge tone={view.tone}>{view.label}</Badge>; } },
    { id: "redeemedBy", header: "兑换用户", priority: "detail", accessor: (r) => r.redeemedBy == null ? "-" : String(r.redeemedBy) },
    { id: "expires", header: "到期", priority: "secondary", cell: (r) => date(r.expiresAt) },
    { id: "action", header: "操作", priority: "primary", hideable: false, cell: (r) => <Button variant="danger" size="compact" disabled={r.status !== "unused"} onClick={() => setDisableRow(r)}>禁用</Button> },
  ], []);
  const unused = items.filter((item) => item.status === "unused").length; const redeemed = items.filter((item) => item.status === "redeemed").length; const maxPage = Math.max(1, Math.ceil(total / 100));
  return <ConsolePage
    title="兑换码管理"
    description="以批次为主视图生成、追踪、导出和禁用兑换码。"
    primaryAction={<Button icon={<Plus size={18} />} onClick={openGenerate}>批量生成</Button>}
    layoutWidth="dashboard"
  >
    <div className="redemptionWorkbench">
      <MetricStrip metrics={[{ id: "total", label: "兑换码总量", value: loading ? "-" : total }, { id: "batches", label: "当前页批次", value: loading ? "-" : batches.length, tone: "info" }, { id: "unused", label: "本页未使用", value: loading ? "-" : unused, tone: "positive" }, { id: "redeemed", label: "本页已兑换", value: loading ? "-" : redeemed }]} />
      <FilterBar actions={<Button variant="secondary" icon={<RefreshCcw size={17} />} loading={loading} onClick={() => void reload()}>刷新</Button>}><Input aria-label="按批次 ID 筛选" placeholder="输入完整批次 ID" value={batchQuery} onChange={(e) => { setPage(1); setBatchQuery(e.currentTarget.value); }} /><Select aria-label="兑换码状态" value={status} onChange={(e) => { setPage(1); setStatus(e.currentTarget.value); }}><option value="">全部状态</option><option value="unused">未使用</option><option value="redeemed">已兑换</option><option value="disabled">已禁用</option></Select></FilterBar>
      <div className="redemptionTableFrame">
        <DataTable className="redemptionBatchTable" rows={batches} columns={batchColumns} getRowId={(r) => r.id} ariaLabel="兑换码批次列表" loading={loading} error={error || undefined} onRetry={() => void reload()} emptyState="暂无匹配的兑换码批次" onRowClick={(r) => void openBatch(r)} getRowAriaLabel={(r) => `查看兑换码批次 ${r.note}`} pageSize={Math.max(1, batches.length)} pagination="hidden" />
        <nav className="redemptionServerPagination" aria-label="兑换码代码页">
          <span><strong>代码页 {page} / {maxPage}</strong><small>共 {total.toLocaleString("zh-CN")} 张 · 每页读取 100 张后按批次聚合</small></span>
          <div><Button variant="secondary" size="compact" icon={<ChevronLeft size={15} />} disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>上一页</Button><Button variant="secondary" size="compact" icon={<ChevronRight size={15} />} iconPosition="end" disabled={page >= maxPage} onClick={() => setPage((p) => p + 1)}>下一页</Button></div>
        </nav>
      </div>
    </div>
    <GenerateDialog open={generateOpen} form={form} initial={initial} saving={saving} error={formError} onChange={setForm} onGenerate={() => void generate()} onOpenChange={setGenerateOpen} />
    <Dialog open={resultOpen} className="redemptionResultDialog" title={`生成结果 · ${generated.length} 张`} description="兑换码已写入批次列表；建议立即复制或导出用于分发。" size="lg" onOpenChange={setResultOpen} footer={<div className="redemptionDialogActions"><Button variant="secondary" icon={<Copy size={17} />} onClick={() => void copyCodes()}>复制全部</Button><Button icon={<Download size={17} />} onClick={exportCodes}>导出 CSV</Button></div>}>
      <div className="redemptionResult" role="region" aria-label="本次生成的兑换码">
        <div className="redemptionResultHeader" aria-hidden="true"><span>序号</span><span>兑换码</span></div>
        <ol>{generated.map((code, index) => <li key={`${index}-${code}`}><span aria-hidden="true">{String(index + 1).padStart(String(generated.length).length, "0")}</span><code>{code}</code></li>)}</ol>
      </div>
    </Dialog>
    <Drawer open={Boolean(detail)} className="redemptionBatchDrawer" title={detail?.note || "兑换码批次"} description={detail ? `批次 ${detail.id} · ${gu(detail.amountMicros)} / 张` : undefined} size="min(820px, 100vw)" onOpenChange={(next) => { if (!next) { detailRequestRef.current?.abort(); detailRequestRef.current = null; setDetail(null); } }} footer={detail ? <div className="redemptionDialogActions"><Button icon={<Download size={17} />} disabled={detailLoading || Boolean(detailError) || detailCodes.length === 0} onClick={exportDetailCodes}>导出全部 CSV</Button></div> : undefined}><DataTable rows={detailCodes} columns={codeColumns} getRowId={(r, i) => r.id || i} ariaLabel="批次兑换码列表" loading={detailLoading} error={detailError || undefined} onRetry={() => { if (detail) void openBatch(detail); }} emptyState="该批次暂无兑换码" defaultPageSize={20} /></Drawer>
    <ConfirmDialog open={Boolean(disableRow)} title="禁用兑换码" description={`禁用 ${disableRow?.code || "该兑换码"} 后将不可再兑换；已兑换记录不会回滚。`} confirmLabel="禁用兑换码" tone="danger" onCancel={() => setDisableRow(null)} onConfirm={async () => { if (!disableRow) return false; await disableRedemptionCode(disableRow.id); toast({ title: "兑换码已禁用", tone: "success" }); if (detail) await openBatch(detail); await reload(); return true; }} onConfirmError={(caught) => toast({ title: "禁用失败", message: caught instanceof Error ? caught.message : "请稍后重试", tone: "danger" })} />
  </ConsolePage>;
}
