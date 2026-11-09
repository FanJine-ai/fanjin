import { GU_MICROS_PER_GU } from "@/utils/billingUnits";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FileCheck2, LockKeyhole, RefreshCcw, ShieldAlert } from "lucide-react";

import { toApiErrorView } from "../../../api/http";
import {
  Alert,
  Badge,
  Button,
  ConsolePage,
  DataTable,
  DescriptionList,
  Drawer,
  FieldGroup,
  FilterBar,
  FormField,
  Input,
  MetricStrip,
  Section,
  Select,
  useToast,
  type BadgeTone,
  type DataTableColumn,
} from "../../../ui/console";
import {
  closeSettlementPeriod,
  exportSettlementPeriod,
  fetchReconciliationSummary,
  fetchSettlementPeriods,
  importProviderInvoices,
  preflightSettlementPeriod,
  type ConsumptionDimensionSummary,
  type PeriodPreflightPayload,
  type ReconciliationSummaryPayload,
  type SettlementPeriodRecord,
  type ShadowAlignmentRow,
} from "./api";

function formatCny(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "-";
  return `${(numeric / 1_000_000).toLocaleString("zh-CN", { maximumFractionDigits: 2 })} 元`;
}

function formatGu(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? `${(numeric / GU_MICROS_PER_GU).toLocaleString("zh-CN", { maximumFractionDigits: 2 })} GU` : "-";
}

function formatDate(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(numeric));
}

function modeTone(mode: string): BadgeTone {
  if (mode === "active") return "success";
  if (mode === "shadow") return "info";
  return "neutral";
}

const modeLabels: Record<string, string> = {
  off: "关闭（沿用充值时结算）",
  shadow: "影子并行",
  active: "消费后结算",
};

type ConsumptionRow = ConsumptionDimensionSummary & { dimension: string };

type AlignmentRow = ShadowAlignmentRow;

type PeriodRow = SettlementPeriodRecord & { statusLabel: string };

function currentPeriodKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function previousPeriodKey(): string {
  const now = new Date();
  now.setMonth(now.getMonth() - 1);
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

export default function TenantReconciliationPage() {
  const { toast } = useToast();
  const [summary, setSummary] = useState<ReconciliationSummaryPayload | null>(null);
  const [periods, setPeriods] = useState<SettlementPeriodRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [dimension, setDimension] = useState<"collector" | "registered" | "owner">("collector");
  const [preflight, setPreflight] = useState<PeriodPreflightPayload | null>(null);
  const [periodKey, setPeriodKey] = useState(previousPeriodKey());
  const [closing, setClosing] = useState(false);
  const [policyId, setPolicyId] = useState("settlement-policy-v1");
  const [exportedPeriod, setExportedPeriod] = useState<{ periodKey: string; payload: Record<string, unknown> } | null>(null);
  const [invoiceDraft, setInvoiceDraft] = useState({ usageId: "", provider: "volcengine_ark", officialCostYuan: "" });
  const [invoiceBusy, setInvoiceBusy] = useState(false);
  const [invoiceError, setInvoiceError] = useState("");

  const reload = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [summaryPayload, periodsPayload] = await Promise.all([
        fetchReconciliationSummary(),
        fetchSettlementPeriods(),
      ]);
      setSummary(summaryPayload);
      setPeriods(periodsPayload.items || []);
    } catch (caught) {
      setError(toApiErrorView(caught).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const consumptionRows = useMemo<ConsumptionRow[]>(() => {
    if (!summary) return [];
    const source = dimension === "collector"
      ? summary.consumptionByCollector
      : dimension === "registered"
        ? summary.consumptionByRegistered
        : summary.consumptionByOwner;
    const dimensionLabel = dimension === "collector" ? "实际收款租户" : dimension === "registered" ? "注册租户" : "当前所属租户";
    return source.map((row) => ({ ...row, dimension: dimensionLabel }));
  }, [summary, dimension]);

  const alignmentRows = useMemo<AlignmentRow[]>(() => summary?.shadowAlignment.rows || [], [summary]);
  const periodRows = useMemo<PeriodRow[]>(() => periods.map((period) => ({
    ...period,
    statusLabel: period.status === "closed" ? "已关账" : "未关账",
  })), [periods]);

  const consumptionColumns = useMemo<DataTableColumn<ConsumptionRow>[]>(() => [
    { id: "tenant", header: "租户", priority: "primary", accessor: "tenantId", sortable: true },
    { id: "dimension", header: "口径", priority: "primary", accessor: "dimension" },
    { id: "allocations", header: "分摊笔数", priority: "secondary", accessor: "allocations", sortable: true },
    { id: "chargedGu", header: "消费 GU", priority: "secondary", cell: (row) => formatGu(row.chargedGuMicros), sortValue: (row) => row.chargedGuMicros },
    { id: "retail", header: "零售口径", priority: "secondary", cell: (row) => formatCny(row.retailPortionMicros), sortValue: (row) => row.retailPortionMicros },
    { id: "wholesale", header: "批发应计", priority: "primary", cell: (row) => formatCny(row.wholesaleAccrualMicros), sortValue: (row) => row.wholesaleAccrualMicros },
  ], []);

  const alignmentColumns = useMemo<DataTableColumn<AlignmentRow>[]>(() => [
    { id: "tenant", header: "租户", priority: "primary", accessor: "tenantId", sortable: true },
    { id: "legacy", header: "旧账：充值时已扣", priority: "primary", cell: (row) => formatCny(row.legacyChargedMicros), sortValue: (row) => row.legacyChargedMicros },
    { id: "shadow", header: "新账：消费应计", priority: "primary", cell: (row) => formatCny(row.shadowAccruedMicros), sortValue: (row) => row.shadowAccruedMicros },
    { id: "unconsumed", header: "未消费部分", priority: "secondary", cell: (row) => formatCny(row.unconsumedMicros), sortValue: (row) => row.unconsumedMicros },
    {
      id: "difference",
      header: "差异",
      priority: "primary",
      cell: (row) => (
        <Badge tone={row.differenceMicros === 0 ? "success" : row.differenceMicros > 0 ? "warning" : "danger"}>
          {formatCny(row.differenceMicros)}
        </Badge>
      ),
      sortValue: (row) => row.differenceMicros,
    },
  ], []);

  const periodColumns = useMemo<DataTableColumn<PeriodRow>[]>(() => [
    { id: "periodKey", header: "账期", priority: "primary", accessor: "periodKey", sortable: true },
    {
      id: "status",
      header: "状态",
      priority: "primary",
      cell: (row) => <Badge tone={row.status === "closed" ? "success" : "neutral"}>{row.statusLabel}</Badge>,
      sortValue: (row) => row.status,
    },
    { id: "policy", header: "结算策略", priority: "secondary", cell: (row) => row.settlementPolicyId ? `${row.settlementPolicyId} · v${row.settlementPolicyRevision}` : "-" },
    { id: "closedAt", header: "关账时间", priority: "secondary", cell: (row) => formatDate(row.closedAt), sortValue: (row) => row.closedAt ?? 0 },
    {
      id: "actions",
      header: "操作",
      priority: "primary",
      hideable: false,
      width: "120px",
      cell: (row) => row.status === "closed" ? (
        <Button variant="secondary" size="compact" onClick={() => void exportPeriod(row.periodKey)}>导出</Button>
      ) : (
        <Button variant="secondary" size="compact" onClick={() => { setPeriodKey(row.periodKey); setPreflight(null); }}>处理</Button>
      ),
    },
  ], []);

  async function runPreflight() {
    setError("");
    try {
      const payload = await preflightSettlementPeriod(periodKey);
      setPreflight(payload);
    } catch (caught) {
      setError(toApiErrorView(caught).message);
    }
  }

  async function closePeriod() {
    setClosing(true);
    setError("");
    try {
      await closeSettlementPeriod(periodKey, {
        settlementPolicyId: policyId.trim() || undefined,
        settlementPolicyRevision: policyId.trim() ? 1 : undefined,
      });
      toast({ title: "账期已关闭", message: `${periodKey} 已生成正式结算单。`, tone: "success" });
      setPreflight(null);
      await reload();
    } catch (caught) {
      setError(toApiErrorView(caught).message);
    } finally {
      setClosing(false);
    }
  }

  async function exportPeriod(key: string) {
    setError("");
    try {
      const payload = await exportSettlementPeriod(key);
      setExportedPeriod({ periodKey: key, payload });
    } catch (caught) {
      setError(toApiErrorView(caught).message);
    }
  }

  async function submitInvoice() {
    const usageId = invoiceDraft.usageId.trim();
    const officialCostMicros = Math.round(Number(invoiceDraft.officialCostYuan || 0) * 1_000_000);
    if (!usageId || !Number.isFinite(officialCostMicros) || officialCostMicros <= 0) {
      setInvoiceError("请填写 usageId 与有效的官方成本金额。");
      return;
    }
    setInvoiceBusy(true);
    setInvoiceError("");
    try {
      await importProviderInvoices([{
        usageId,
        provider: invoiceDraft.provider,
        officialCostMicros,
        invoiceId: `INV-${currentPeriodKey()}`,
        billingPeriod: currentPeriodKey(),
      }]);
      toast({ title: "账单已导入", message: `${usageId} 已按官方成本确认。`, tone: "success" });
      setInvoiceDraft((current) => ({ ...current, usageId: "", officialCostYuan: "" }));
      await reload();
    } catch (caught) {
      setInvoiceError(toApiErrorView(caught).message);
    } finally {
      setInvoiceBusy(false);
    }
  }

  return (
    <ConsolePage
      title="租户对账中心"
      description="按注册租户、当前所属租户、实际收款租户与实际消费/官方成本四种口径核对账务；影子账与旧账并行展示。"
      primaryAction={<Button variant="secondary" icon={<RefreshCcw size={16} />} loading={loading} onClick={() => void reload()}>刷新</Button>}
      layoutWidth="dashboard"
    >
      {error ? <Alert tone="danger" title="对账数据读取失败">{error}</Alert> : null}
      <MetricStrip metrics={[
        { id: "mode", label: "结算模式", value: summary ? modeLabels[summary.mode] : "-", hint: "FANJIN_SETTLEMENT_V2_MODE" },
        { id: "aligned", label: "影子对齐", value: summary ? (summary.shadowAlignment.aligned ? "已对齐" : "存在差异") : "-", tone: summary?.shadowAlignment.aligned ? "positive" : "warning" },
        { id: "collectors", label: "收款租户数", value: summary ? String(summary.byCollector.length) : "-" },
        { id: "pendingCosts", label: "待确认成本", value: summary ? String(summary.providerCosts.reduce((sum, item) => sum + item.pendingConfirmation, 0)) : "-", tone: "warning" },
      ]} />

      <Section title="消费分摊（可切换口径）">
        <FilterBar>
          <Select aria-label="对账口径" value={dimension} onChange={(event) => setDimension(event.currentTarget.value as typeof dimension)}>
            <option value="collector">按实际收款租户</option>
            <option value="registered">按注册租户</option>
            <option value="owner">按当前所属租户</option>
          </Select>
        </FilterBar>
        <DataTable
          rows={consumptionRows}
          columns={consumptionColumns}
          getRowId={(row) => `${row.dimension}-${row.tenantId}`}
          ariaLabel="消费分摊表"
          loading={loading}
          emptyState="暂无消费分摊数据"
        />
      </Section>

      <Section title="影子账对齐（旧账 vs 新账）">
        {summary ? <Alert tone="info" title="口径说明">{summary.shadowAlignment.note}</Alert> : null}
        <DataTable
          rows={alignmentRows}
          columns={alignmentColumns}
          getRowId={(row) => row.tenantId}
          ariaLabel="影子对齐表"
          loading={loading}
          emptyState="暂无对齐数据"
        />
      </Section>

      <Section title="账期管理">
        <DataTable
          rows={periodRows}
          columns={periodColumns}
          getRowId={(row) => row.id}
          ariaLabel="账期列表"
          loading={loading}
          emptyState="暂无账期记录"
        />
        <FieldGroup variant="section" legend="账期预检与关账" description="关账需要 MFA 二次验证；未确认成本、支付争议或负差异会阻断关账。">
          <FilterBar>
            <Input
              aria-label="账期"
              placeholder="YYYY-MM"
              value={periodKey}
              onChange={(event) => { setPeriodKey(event.currentTarget.value); setPreflight(null); }}
            />
            <Button variant="secondary" icon={<FileCheck2 size={16} />} onClick={() => void runPreflight()}>预检</Button>
            <FormField label="结算策略">
              <Input aria-label="结算策略" value={policyId} onChange={(event) => setPolicyId(event.currentTarget.value)} />
            </FormField>
            <Button
              icon={<LockKeyhole size={16} />}
              disabled={!preflight?.passed || closing}
              loading={closing}
              onClick={() => void closePeriod()}
            >
              关闭账期
            </Button>
          </FilterBar>
          {preflight ? (
            preflight.passed ? (
              <Alert tone="success" title="预检通过">账期 {preflight.periodKey} 可以关账。</Alert>
            ) : (
              <Alert tone="warning" title="预检存在阻断项">
                <ul className="reconciliationBlockers">
                  {preflight.blockers.map((blocker) => (
                    <li key={blocker.code}><ShieldAlert aria-hidden="true" size={14} /><strong>{blocker.code}</strong><span>{blocker.detail}（{blocker.count} 项）</span></li>
                  ))}
                </ul>
              </Alert>
            )
          ) : null}
        </FieldGroup>
      </Section>

      <Section title="官方账单导入">
        <FieldGroup variant="section" legend="按 usageId 确认官方成本" description="导入后估算成本被确认为正式成本，差异形成独立流水；重复导入幂等。">
          <FilterBar>
            <Input aria-label="usageId" placeholder="usageId" value={invoiceDraft.usageId} onChange={(event) => setInvoiceDraft((current) => ({ ...current, usageId: event.currentTarget.value }))} />
            <Select aria-label="供应商" value={invoiceDraft.provider} onChange={(event) => setInvoiceDraft((current) => ({ ...current, provider: event.currentTarget.value }))}>
              <option value="volcengine_ark">火山方舟</option>
              <option value="volcengine_certificate_center">证书中心</option>
              <option value="volcengine_alb">ALB</option>
            </Select>
            <Input aria-label="官方成本（元）" placeholder="官方成本（元）" value={invoiceDraft.officialCostYuan} onChange={(event) => setInvoiceDraft((current) => ({ ...current, officialCostYuan: event.currentTarget.value }))} />
            <Button disabled={invoiceBusy} loading={invoiceBusy} onClick={() => void submitInvoice()}>导入账单</Button>
          </FilterBar>
          {invoiceError ? <Alert tone="danger">{invoiceError}</Alert> : null}
        </FieldGroup>
      </Section>

      <Drawer
        open={Boolean(exportedPeriod)}
        title={exportedPeriod ? `账期 ${exportedPeriod.periodKey} 结算单` : "结算单"}
        description="关账时冻结的不可变快照"
        size="min(680px, 100vw)"
        onOpenChange={(open) => { if (!open) setExportedPeriod(null); }}
      >
        {exportedPeriod ? (
          <Section title="结算快照">
            <DescriptionList items={[
              { label: "账期", value: exportedPeriod.periodKey },
              { label: "收款笔数", value: String((exportedPeriod.payload.payments as unknown[] | undefined)?.length || 0) },
              { label: "消费分摊笔数", value: String((exportedPeriod.payload.consumptionAllocations as unknown[] | undefined)?.length || 0) },
              { label: "成本记录", value: String((exportedPeriod.payload.providerCosts as unknown[] | undefined)?.length || 0) },
              { label: "结算策略", value: String(exportedPeriod.payload.settlementPolicyId || "-") },
            ]} />
          </Section>
        ) : null}
      </Drawer>
    </ConsolePage>
  );
}
