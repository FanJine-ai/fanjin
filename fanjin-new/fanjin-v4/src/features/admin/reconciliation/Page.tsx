import { GU_MICROS_PER_GU } from "@/utils/billingUnits";
import { useMemo, useRef, useState } from "react";
import { Play, RefreshCcw, Scale, Search } from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  CodeBlock,
  ConfirmDialog,
  ConsolePage,
  DataTable,
  DescriptionList,
  Dialog,
  Drawer,
  EmptyState,
  FilterBar,
  FormField,
  Input,
  MetricStrip,
  Select,
  useToast,
} from "../../../ui/console";
import { useFinanceQuery } from "../finance/hooks";
import { formatGu } from "../finance/utils";
import { listReconciliationJobs, resolveReconciliationJob, runReconciliationBatch } from "./api";
import type { ReconciliationJob, ReconciliationList, ReconciliationStatus } from "./types";
import "./styles.css";

const statusLabels: Record<ReconciliationStatus, string> = {
  pending: "待执行",
  leased: "处理中",
  manual_required: "需要人工处理",
  resolved: "已解决",
};

const reasonLabels: Record<string, string> = {
  dispatch_watchdog: "分发超时监控",
  dispatch_watchdog_expired: "分发结果未知",
  settlement_failed: "自动结算失败",
  chat_upstream_outcome_unknown: "文本请求上游结果待核对",
  actual_cost_exceeds_reservation: "实际费用超过预扣",
};

const decisionLabels: Record<string, string> = {
  already_finalized: "账务已完成",
  auto_settled_authoritative_evidence: "已按权威凭证自动结算",
  manual_settlement: "人工结算",
  manual_release_confirmed: "人工确认释放",
  platform_absorb_release: "平台承担并释放",
  reservation_missing: "冻结流水缺失",
  ledger_invariant_failed: "账务一致性异常",
  dispatch_outcome_unknown: "上游结果未知",
  automatic_settlement_failed: "自动结算失败",
};

function statusTone(status: ReconciliationStatus) {
  if (status === "resolved") return "success" as const;
  if (status === "manual_required") return "danger" as const;
  if (status === "pending" || status === "leased") return "warning" as const;
  return "neutral" as const;
}

function formatDate(value: number | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function displayReason(reason: string) {
  return reasonLabels[reason] || reason || "未知原因";
}

function displayDecision(decision: string | null) {
  if (!decision) return "尚未决策";
  return decisionLabels[decision] || decision;
}

function microsFromGu(value: string) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return null;
  const micros = Math.round(amount * GU_MICROS_PER_GU);
  return Number.isSafeInteger(micros) ? micros : null;
}

function formatOptionalGu(value: number | null | undefined) {
  return value == null ? "-" : formatGu(value);
}

type ResolutionForm = {
  action: "settle" | "release" | "platform_absorb_release";
  scriptAssetCommandId: string;
  actualCost: string;
  units: string;
  unit: string;
  note: string;
};

const emptyResolution: ResolutionForm = {
  action: "settle",
  scriptAssetCommandId: "",
  actualCost: "",
  units: "",
  unit: "request",
  note: "",
};

export default function ReconciliationPage() {
  const { toast } = useToast();
  const [workspaceDraft, setWorkspaceDraft] = useState("");
  const [filters, setFilters] = useState<{ workspaceId: string; status: "all" | ReconciliationStatus; limit: number }>({
    workspaceId: "",
    status: "all",
    limit: 100,
  });
  const [detail, setDetail] = useState<ReconciliationJob | null>(null);
  const [resolving, setResolving] = useState<ReconciliationJob | null>(null);
  const [resolution, setResolution] = useState<ResolutionForm>(emptyResolution);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmRun, setConfirmRun] = useState(false);
  const actionRef = useRef<HTMLSelectElement>(null);
  const submittingRef = useRef(false);

  const payload = useMemo(() => ({
    workspaceId: filters.workspaceId || null,
    status: filters.status === "all" ? null : filters.status,
    limit: filters.limit,
  }), [filters]);
  const query = useFinanceQuery<ReconciliationList>(
    () => listReconciliationJobs(payload),
    JSON.stringify(payload),
    { items: [], total: 0 },
  );
  const jobs = query.data.items || [];
  const counts = useMemo(() => jobs.reduce((result, job) => {
    result[job.status] += 1;
    return result;
  }, { pending: 0, leased: 0, manual_required: 0, resolved: 0 } satisfies Record<ReconciliationStatus, number>), [jobs]);

  function applyWorkspace() {
    setFilters((current) => ({ ...current, workspaceId: workspaceDraft.trim() }));
  }

  function openResolution(job: ReconciliationJob) {
    setResolving(job);
    setResolution(emptyResolution);
    setFormError("");
    submittingRef.current = false;
  }

  async function submitResolution() {
    if (!resolving || submittingRef.current) return;
    const note = resolution.note.trim();
    if (note.length < 4) {
      setFormError("人工处理备注至少需要 4 个字符。");
      return;
    }
    const actualCostMicros = resolution.action === "settle" ? microsFromGu(resolution.actualCost) : undefined;
    const units = resolution.action === "settle" ? Number(resolution.units) : undefined;
    if (resolution.action === "settle" && (actualCostMicros == null || !Number.isSafeInteger(units) || Number(units) < 0 || !resolution.unit.trim())) {
      setFormError("结算时必须填写有效的实际扣费、整数用量和用量单位。");
      return;
    }
    if (resolution.action === "platform_absorb_release" && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(resolution.scriptAssetCommandId.trim())) {
      setFormError("请填写对应资产提取的请求编号。");
      return;
    }
    submittingRef.current = true;
    setSaving(true);
    setFormError("");
    try {
      await resolveReconciliationJob({
        jobId: resolving.id,
        action: resolution.action,
        scriptAssetCommandId: resolution.action === "platform_absorb_release" ? resolution.scriptAssetCommandId.trim() : undefined,
        actualCostMicros: actualCostMicros ?? undefined,
        units,
        unit: resolution.action === "settle" ? resolution.unit.trim() : undefined,
        resolutionNote: note,
      });
      toast({
        title: "计费对账已处理",
        message: resolution.action === "settle" ? "冻结额度已按人工核定结果结算。" : resolution.action === "platform_absorb_release" ? "用户预扣已释放，可能的上游费用由平台承担并保留核账记录。" : "已确认上游未计费并释放冻结额度。",
        tone: "success",
      });
      setResolving(null);
      await query.reload();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "人工对账处理失败");
    } finally {
      submittingRef.current = false;
      setSaving(false);
    }
  }

  async function runBatch() {
    const result = await runReconciliationBatch();
    toast({
      title: "自动对账执行完成",
      message: `领取 ${result.claimed} 个任务，完成处理 ${result.processed} 个。`,
      tone: "success",
    });
    await query.reload();
  }

  return (
    <ConsolePage
      className="reconciliationPage"
      breadcrumbs={[{ label: "计费与财务" }, { label: "计费对账" }]}
      title="计费对账"
      description="处理调用中断、结算失败和冻结流水不一致等账务异常；人工决策会写入完整证据链。"
      primaryAction={<Button icon={<Play size={17} />} onClick={() => setConfirmRun(true)}>执行自动对账</Button>}
      layoutWidth="dashboard"
    >
      <Alert tone="info" title="账务安全边界">
        自动对账只处理具备权威凭证的任务；上游结果未知或账务不一致时会停在“需要人工处理”，不会自动扣费或释放。
      </Alert>

      <MetricStrip metrics={[
        { id: "loaded", label: "当前加载", value: query.loading ? "-" : jobs.length.toLocaleString(), hint: `最多读取 ${filters.limit} 条` },
        { id: "manual", label: "需要人工处理", value: query.loading ? "-" : counts.manual_required.toLocaleString(), hint: "需要核验上游凭证", tone: counts.manual_required ? "danger" : "positive" },
        { id: "pending", label: "待执行 / 处理中", value: query.loading ? "-" : (counts.pending + counts.leased).toLocaleString(), hint: `待执行 ${counts.pending} · 处理中 ${counts.leased}`, tone: counts.pending + counts.leased ? "warning" : "neutral" },
        { id: "resolved", label: "已解决", value: query.loading ? "-" : counts.resolved.toLocaleString(), hint: "当前筛选范围", tone: "positive" },
      ]} />

      <section className="reconciliationData" aria-label="计费对账任务">
        <FilterBar actions={(
          <div className="reconciliationFilterActions">
            <Button variant="secondary" icon={<Search size={16} />} onClick={applyWorkspace}>查询</Button>
            <Button variant="ghost" icon={<RefreshCcw size={16} />} loading={query.loading} onClick={() => void query.reload()}>刷新</Button>
          </div>
        )}>
          <label className="reconciliationFilter reconciliationFilterSearch">
            <span>工作区 ID</span>
            <Input value={workspaceDraft} onChange={(event) => setWorkspaceDraft(event.target.value)} placeholder="输入完整工作区 ID" />
          </label>
          <label className="reconciliationFilter">
            <span>任务状态</span>
            <Select value={filters.status} onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value as typeof filters.status }))}>
              <option value="all">全部状态</option>
              {Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </Select>
          </label>
          <label className="reconciliationFilter">
            <span>读取上限</span>
            <Select value={filters.limit} onChange={(event) => setFilters((current) => ({ ...current, limit: Number(event.target.value) }))}>
              <option value={100}>100 条</option>
              <option value={250}>250 条</option>
              <option value={500}>500 条</option>
            </Select>
          </label>
        </FilterBar>

        <DataTable<ReconciliationJob>
          className="reconciliationTable"
          ariaLabel="计费对账任务列表"
          caption="计费对账任务"
          captionMode="visible"
          scrollMode="contained"
          rows={jobs}
          getRowId={(row) => row.id}
          loading={query.loading}
          error={query.error || undefined}
          onRetry={query.reload}
          emptyState={<EmptyState icon={Scale} title="暂无对账任务" description="当前没有需要自动或人工处理的计费异常。" />}
          onRowClick={setDetail}
          getRowAriaLabel={(row) => `查看对账任务 ${row.id}`}
          defaultPageSize={20}
          columns={[
            {
              id: "job",
              header: "对账任务",
              priority: "primary",
              minWidth: "220px",
              cell: (row) => <span className="reconciliationPrimary"><strong>{displayReason(row.reason)}</strong><span>{row.id}</span></span>,
            },
            { id: "workspace", header: "工作区", accessor: "workspaceId", priority: "primary", minWidth: "180px" },
            {
              id: "upstream",
              header: "上游",
              priority: "secondary",
              cell: (row) => <span className="reconciliationPrimary"><strong>{row.provider || "未知供应商"}</strong><span>{row.endpointType || row.channelId || "未标注能力"}</span></span>,
            },
            {
              id: "amount",
              header: "预扣 / 剩余冻结",
              priority: "primary",
              minWidth: "160px",
              cell: (row) => <span className="reconciliationPrimary"><strong>{formatOptionalGu(row.billingProjection?.reservation?.amountMicros)}</strong><span>{formatOptionalGu(row.billingProjection?.reservation?.remainingMicros)}</span></span>,
            },
            { id: "status", header: "状态", priority: "primary", cell: (row) => <Badge tone={statusTone(row.status)}>{statusLabels[row.status]}</Badge> },
            { id: "attempts", header: "尝试次数", accessor: "attempts", priority: "secondary", align: "end" },
            { id: "updated", header: "更新时间", priority: "detail", cell: (row) => formatDate(row.updateTime) },
            {
              id: "action",
              header: "操作",
              priority: "primary",
              hideable: false,
              width: "112px",
              cell: (row) => <Button variant="secondary" disabled={row.status === "resolved" || row.status === "leased"} onClick={() => openResolution(row)}>人工处理</Button>,
            },
          ]}
        />
      </section>

      <ConfirmDialog
        open={confirmRun}
        title="执行一次自动对账"
        description="系统将领取最多 100 个到期任务，并只在凭证充分时自动结算。此操作需要管理员身份复核。"
        confirmLabel="开始执行"
        onCancel={() => setConfirmRun(false)}
        onConfirm={runBatch}
        onConfirmError={(error) => toast({ title: "自动对账失败", message: error instanceof Error ? error.message : "请稍后重试", tone: "danger" })}
      />

      <Dialog
        open={Boolean(resolving)}
        title="人工处理计费对账"
        description={resolving ? `${displayReason(resolving.reason)} · ${resolving.id}` : "核对凭证后选择结算或释放。"}
        size="lg"
        loading={saving}
        dirty={Boolean(resolving)}
        initialFocusRef={actionRef}
        onOpenChange={(open) => { if (!open && !saving) setResolving(null); }}
        footer={({ requestClose, pending }) => (
          <div className="reconciliationDialogFooter">
            {formError ? <Alert tone="danger">{formError}</Alert> : null}
            <div>
              <Button variant="secondary" disabled={pending} onClick={() => requestClose("cancel")}>取消</Button>
              <Button type="submit" form="reconciliation-resolution-form" loading={saving}>确认处理</Button>
            </div>
          </div>
        )}
      >
        <form id="reconciliation-resolution-form" className="reconciliationForm" onSubmit={(event) => { event.preventDefault(); void submitResolution(); }}>
          {resolving ? <DescriptionList items={[
            { label: "工作区", value: resolving.workspaceId },
            { label: "冻结流水", value: resolving.reservationId },
            { label: "预扣 / 剩余冻结", value: `${formatOptionalGu(resolving.billingProjection?.reservation?.amountMicros)} / ${formatOptionalGu(resolving.billingProjection?.reservation?.remainingMicros)}` },
            { label: "用量状态 / 已入账", value: `${resolving.billingProjection?.usage?.status || "-"} / ${formatOptionalGu(resolving.billingProjection?.usage?.costMicros)}` },
            { label: "请求 ID", value: resolving.requestId || "-" },
            { label: "异常说明", value: resolving.lastError || displayReason(resolving.reason) },
          ]} /> : null}
          <FormField label="处理方式" required optionalLabel={null}>
            <Select ref={actionRef} value={resolution.action} onChange={(event) => setResolution((current) => ({ ...current, action: event.target.value as ResolutionForm["action"] }))}>
              <option value="settle">按核定结果结算</option>
              <option value="release">确认上游未计费并释放</option>
              {resolving?.endpointType === "text" && resolving.reason === "chat_upstream_outcome_unknown" ? <option value="platform_absorb_release">平台承担并释放资产提取预扣</option> : null}
            </Select>
          </FormField>
          {resolution.action === "settle" ? (
            <div className="reconciliationSettlementGrid">
              <FormField label="实际扣费（GU）" required optionalLabel={null}>
                <Input type="number" min="0" step="0.000001" inputMode="decimal" value={resolution.actualCost} onChange={(event) => setResolution((current) => ({ ...current, actualCost: event.target.value }))} placeholder="0.000000" />
              </FormField>
              <FormField label="实际用量" required optionalLabel={null}>
                <Input type="number" min="0" step="1" inputMode="numeric" value={resolution.units} onChange={(event) => setResolution((current) => ({ ...current, units: event.target.value }))} placeholder="0" />
              </FormField>
              <FormField label="用量单位" required optionalLabel={null}>
                <Input value={resolution.unit} onChange={(event) => setResolution((current) => ({ ...current, unit: event.target.value }))} placeholder="request / token / second" />
              </FormField>
            </div>
          ) : resolution.action === "platform_absorb_release" ? (
            <>
              <Alert tone="warning">平台承担本次可能的上游费用。系统会核对原提取请求未交付结果，再释放用户预扣；不会重新调用模型。</Alert>
              <FormField label="资产提取请求编号" required optionalLabel={null} help="填写剧本页显示的请求编号，系统将校验它与当前冻结流水的关联。">
                <Input value={resolution.scriptAssetCommandId} onChange={(event) => setResolution((current) => ({ ...current, scriptAssetCommandId: event.target.value }))} />
              </FormField>
            </>
          ) : (
            <Alert tone="warning">只有确认供应商未产生费用时才能释放冻结额度；如果结果未知，请保留任务等待进一步凭证。</Alert>
          )}
          <FormField label="人工处理备注" required optionalLabel={null} help="至少 4 个字符，说明凭证来源与判断依据。">
            <textarea rows={4} maxLength={1000} value={resolution.note} onChange={(event) => setResolution((current) => ({ ...current, note: event.target.value }))} placeholder="例如：已核对供应商账单，确认请求未进入执行阶段" />
          </FormField>
        </form>
      </Dialog>

      <Drawer
        open={Boolean(detail)}
        title="计费对账详情"
        description={detail?.id || "查看对账上下文与证据。"}
        size="720px"
        onOpenChange={(open) => { if (!open) setDetail(null); }}
        footer={<div className="reconciliationDrawerFooter"><Button variant="secondary" onClick={() => setDetail(null)}>关闭</Button></div>}
      >
        {detail ? (
          <div className="reconciliationDetail">
            <DescriptionList items={[
              { label: "状态", value: <Badge tone={statusTone(detail.status)}>{statusLabels[detail.status]}</Badge> },
              { label: "异常原因", value: displayReason(detail.reason) },
              { label: "处理决策", value: displayDecision(detail.decision) },
              { label: "工作区", value: detail.workspaceId },
              { label: "冻结流水", value: detail.reservationId },
              { label: "用量记录", value: detail.usageRecordId || "-" },
              { label: "预扣金额", value: formatOptionalGu(detail.billingProjection?.reservation?.amountMicros) },
              { label: "剩余冻结", value: formatOptionalGu(detail.billingProjection?.reservation?.remainingMicros) },
              { label: "用量状态 / 已入账", value: `${detail.billingProjection?.usage?.status || "-"} / ${formatOptionalGu(detail.billingProjection?.usage?.costMicros)}` },
              { label: "实际用量", value: detail.billingProjection?.usage ? `${detail.billingProjection.usage.units.toLocaleString()} ${detail.billingProjection.usage.unit}` : "-" },
              { label: "已扣 / 已释放", value: `${formatOptionalGu(detail.billingProjection?.deductedMicros)} / ${formatOptionalGu(detail.billingProjection?.releasedMicros)}` },
              { label: "关联结算流水", value: detail.billingProjection?.relatedLedgers?.map((ledger) => `${ledger.type}:${ledger.id}`).join(" · ") || "-" },
              { label: "请求 ID", value: detail.requestId || "-" },
              { label: "供应商 / 通道", value: `${detail.provider || "-"} / ${detail.channelId || "-"}` },
              { label: "尝试次数", value: detail.attempts.toLocaleString() },
              { label: "最后错误", value: detail.lastError || "-" },
              { label: "创建时间", value: formatDate(detail.createTime) },
              { label: "解决时间", value: formatDate(detail.resolvedAt) },
            ]} />
            <section className="reconciliationEvidence">
              <h3>对账证据</h3>
              <CodeBlock language="json">{JSON.stringify(detail.evidence || {}, null, 2)}</CodeBlock>
            </section>
          </div>
        ) : null}
      </Drawer>
    </ConsolePage>
  );
}
