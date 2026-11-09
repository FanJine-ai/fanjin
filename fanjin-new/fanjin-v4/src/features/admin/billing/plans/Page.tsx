import { MembershipAdmin } from "./MembershipAdmin";
import { GU_MICROS_PER_GU } from "@/utils/billingUnits";
import { useMemo, useState } from "react";
import { Archive, ChevronDown, Edit3, Plus, RefreshCcw } from "lucide-react";
import {
  Badge,
  Button,
  ConfirmDialog,
  ConsolePage,
  DataTable,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  FilterBar,
  Input,
  MetricStrip,
  Select,
  useToast,
  type DataTableColumn,
} from "../../../../ui/console";
import { archiveBillingPlan, saveBillingPlan } from "./api";
import { useBillingPlans } from "./hooks";
import { PlanFormDrawer } from "./PlanFormDrawer";
import { buildPlanPayload, createEmptyPlanForm, planFormFromPlan, type BillingPlan, type BillingPlanForm } from "./types";
import "./plans.css";

interface PlanRow {
  id: string;
  source: BillingPlan;
  code: string;
  name: string;
  monthlyFee: string;
  monthlyFeeMicros: number;
  includedCredits: string;
  apiQuota: string;
  memberLimit: string;
  keyLimit: string;
  status: "active" | "archived";
  updatedAt: string;
}

function formatGu(value?: number | null) {
  const micros = Number(value ?? 0);
  const gu = Number.isFinite(micros) ? micros / GU_MICROS_PER_GU : 0;
  return `${gu.toLocaleString("zh-CN", { maximumFractionDigits: 2 })} GU`;
}

function formatDate(value?: string | number | null) {
  if (!value) return "-";
  const date = new Date(typeof value === "number" && value < 10_000_000_000 ? value * 1000 : value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

function toRow(plan: BillingPlan, index: number): PlanRow {
  return {
    id: String(plan.id || plan.code || index),
    source: plan,
    code: String(plan.code || "-"),
    name: String(plan.name || "未命名套餐"),
    monthlyFee: formatGu(plan.monthlyFeeMicros),
    monthlyFeeMicros: Number(plan.monthlyFeeMicros || 0),
    includedCredits: formatGu(plan.includedCreditsMicros),
    apiQuota: plan.apiQuota == null ? "不限" : Number(plan.apiQuota).toLocaleString("zh-CN"),
    memberLimit: plan.memberLimit == null ? "不限" : Number(plan.memberLimit).toLocaleString("zh-CN"),
    keyLimit: plan.keyLimit == null ? "不限" : Number(plan.keyLimit).toLocaleString("zh-CN"),
    status: plan.status === "archived" ? "archived" : "active",
    updatedAt: formatDate(plan.updatedAt || plan.createdAt),
  };
}

export function BillingPlansPage() {
  const { plans, loading, error, reload } = useBillingPlans();
  const { toast } = useToast();
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [form, setForm] = useState<BillingPlanForm>(() => createEmptyPlanForm());
  const [initialForm, setInitialForm] = useState<BillingPlanForm>(() => createEmptyPlanForm());
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [archiveRow, setArchiveRow] = useState<PlanRow | null>(null);

  const allRows = useMemo(() => plans.map(toRow), [plans]);
  const rows = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return allRows.filter((row) => (!needle || row.name.toLocaleLowerCase().includes(needle) || row.code.toLocaleLowerCase().includes(needle)) && (!statusFilter || row.status === statusFilter));
  }, [allRows, query, statusFilter]);

  const openCreate = () => {
    const next = createEmptyPlanForm();
    setForm(next);
    setInitialForm({ ...next });
    setFormError("");
    setEditorOpen(true);
  };

  const openEdit = (plan: BillingPlan) => {
    const next = planFormFromPlan(plan);
    setForm(next);
    setInitialForm({ ...next });
    setFormError("");
    setEditorOpen(true);
  };

  const save = async () => {
    setSaving(true);
    setFormError("");
    try {
      await saveBillingPlan(form.id, buildPlanPayload(form));
      toast({ title: form.id ? "套餐已更新" : "套餐已创建", tone: "success" });
      setEditorOpen(false);
      await reload();
    } catch (caught: unknown) {
      const message = caught instanceof Error ? caught.message : "套餐保存失败";
      setFormError(message);
    } finally {
      setSaving(false);
    }
  };

  const columns = useMemo<DataTableColumn<PlanRow>[]>(() => [
    { id: "plan", header: "套餐", priority: "primary", minWidth: "190px", sortable: true, sortValue: (row) => row.name, cell: (row) => <div className="planNameCell"><strong>{row.name}</strong><code>{row.code}</code></div> },
    { id: "monthlyFee", header: "月费", priority: "primary", align: "end", sortable: true, sortValue: (row) => row.monthlyFeeMicros, accessor: "monthlyFee" },
    { id: "includedCredits", header: "含额度", priority: "secondary", align: "end", accessor: "includedCredits" },
    { id: "apiQuota", header: "API 配额", priority: "secondary", align: "end", accessor: "apiQuota" },
    { id: "memberLimit", header: "成员上限", priority: "detail", align: "end", accessor: "memberLimit" },
    { id: "keyLimit", header: "密钥上限", priority: "detail", align: "end", accessor: "keyLimit" },
    { id: "status", header: "状态", priority: "primary", sortable: true, sortValue: (row) => row.status, cell: (row) => <Badge tone={row.status === "active" ? "success" : "neutral"}>{row.status === "active" ? "在售" : "已归档"}</Badge> },
    { id: "updatedAt", header: "更新时间", priority: "detail", accessor: "updatedAt", minWidth: "150px" },
    {
      id: "actions", header: "操作", priority: "primary", hideable: false, minWidth: "170px",
      cell: (row) => <div className="planRowActions">
        <Button variant="secondary" size="compact" icon={<Edit3 size={15} />} onClick={() => openEdit(row.source)}>编辑</Button>
        {row.status === "active" && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={(
                <Button
                  variant="secondary"
                  size="compact"
                  icon={<ChevronDown aria-hidden="true" size={15} />}
                  iconPosition="end"
                  aria-label={`更多操作：${row.name}`}
                >
                  更多
                </Button>
              )}
            />
            <DropdownMenuContent align="end">
              <DropdownMenuItem tone="danger" onClick={() => setArchiveRow(row)}>
                <Archive aria-hidden="true" size={16} />
                归档套餐
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>,
    },
  ], []);

  const activeCount = allRows.filter((row) => row.status === "active").length;
  const archivedCount = allRows.length - activeCount;
  const averageFee = activeCount ? allRows.filter((row) => row.status === "active").reduce((sum, row) => sum + row.monthlyFeeMicros, 0) / activeCount : 0;

  return (
    <ConsolePage
      title="套餐管理"
      description="维护套餐价格、额度、权益限制和上架状态。"
      primaryAction={<Button icon={<Plus size={18} />} onClick={openCreate}>新建套餐</Button>}
      layoutWidth="dashboard"
    >
      <MembershipAdmin />
      <div className="billingPlansWorkbench">
        <MetricStrip metrics={[
          { id: "total", label: "套餐总数", value: loading ? "-" : allRows.length, hint: "包含归档套餐" },
          { id: "active", label: "在售套餐", value: loading ? "-" : activeCount, tone: "positive", hint: "可用于新购买" },
          { id: "archived", label: "已归档", value: loading ? "-" : archivedCount, tone: archivedCount ? "warning" : "neutral", hint: "不再对新购买展示" },
          { id: "average", label: "平均月费", value: loading ? "-" : formatGu(averageFee), tone: "info", hint: "仅统计在售套餐" },
        ]} />
        <FilterBar actions={<Button variant="secondary" icon={<RefreshCcw size={17} />} loading={loading} onClick={() => void reload()}>刷新</Button>}>
          <Input aria-label="搜索套餐" placeholder="搜索套餐名称或标识" value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
          <Select aria-label="按套餐状态筛选" value={statusFilter} onChange={(event) => setStatusFilter(event.currentTarget.value)}><option value="">全部状态</option><option value="active">在售</option><option value="archived">已归档</option></Select>
        </FilterBar>
        <DataTable rows={rows} columns={columns} getRowId={(row) => row.id} ariaLabel="套餐列表" loading={loading} error={error || undefined} onRetry={() => void reload()} emptyState={query || statusFilter ? "没有匹配当前筛选条件的套餐" : "暂无套餐，请先新建套餐"} onRowClick={(row) => openEdit(row.source)} getRowAriaLabel={(row) => `编辑套餐 ${row.name}`} defaultPageSize={20} />
      </div>
      <PlanFormDrawer open={editorOpen} form={form} initialForm={initialForm} saving={saving} error={formError} onChange={setForm} onSave={() => void save()} onOpenChange={setEditorOpen} />
      <ConfirmDialog
        open={Boolean(archiveRow)}
        title="归档套餐"
        description={`归档「${archiveRow?.name || ""}」后，它不会再作为新的购买选项展示；历史订阅和账单数据不会删除。`}
        confirmLabel="归档套餐"
        tone="danger"
        onCancel={() => setArchiveRow(null)}
        onConfirm={async () => {
          if (!archiveRow) return false;
          await archiveBillingPlan(archiveRow.id);
          toast({ title: "套餐已归档", message: archiveRow.name, tone: "success" });
          await reload();
          return true;
        }}
        onConfirmError={(caught) => toast({ title: "套餐归档失败", message: caught instanceof Error ? caught.message : "请稍后重试", tone: "danger" })}
      />
    </ConsolePage>
  );
}
