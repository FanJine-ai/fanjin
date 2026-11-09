import { GU_MICROS_PER_GU } from "@/utils/billingUnits";
import { useMemo, useRef, useState } from "react";
import { Inbox, RefreshCcw, Search } from "lucide-react";
import {
  Alert,
  Badge,
  Button,
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
  Skeleton,
  useToast,
} from "../../../ui/console";
import { useFinanceQuery } from "../finance/hooks";
import { listServiceRequests, loadServiceRequestSummary, updateServiceRequest } from "./api";
import type { ServiceRequestPage, ServiceRequestRecord, ServiceRequestStatus, ServiceRequestType } from "./types";
import "./styles.css";

const typeLabels: Record<ServiceRequestType, string> = {
  invoice: "发票申请",
  credit_limit: "信用额度",
  offline_payment: "线下付款",
};

const statusLabels: Record<ServiceRequestStatus, string> = {
  pending: "待处理",
  approved: "已通过",
  rejected: "已驳回",
  issued: "已开具",
  cancelled: "已取消",
};

function statusTone(status: ServiceRequestStatus) {
  if (status === "approved" || status === "issued") return "success" as const;
  if (status === "pending") return "warning" as const;
  if (status === "rejected") return "danger" as const;
  return "neutral" as const;
}

function formatAmount(item: ServiceRequestRecord) {
  const amount = Number(item.amountMicros || 0) / (item.currency === "CNY" ? 1_000_000 : GU_MICROS_PER_GU);
  if (item.currency === "CNY") {
    return new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", maximumFractionDigits: 2 }).format(amount);
  }
  return `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 6 }).format(amount)} ${item.currency || "GU"}`;
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
    hour12: false,
  }).format(date);
}

function reviewOptions(type: ServiceRequestType): ServiceRequestStatus[] {
  return type === "invoice"
    ? ["issued", "rejected", "cancelled"]
    : ["approved", "rejected", "cancelled"];
}

function metricValue(loading: boolean, value: string) {
  return loading ? <Skeleton width="4.5rem" height="1.5rem" /> : value;
}

export default function ServiceRequestsPage() {
  const { toast } = useToast();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [workspaceDraft, setWorkspaceDraft] = useState("");
  const [filters, setFilters] = useState<{ workspaceId: string; type: "all" | ServiceRequestType; status: "all" | ServiceRequestStatus }>({
    workspaceId: "",
    type: "all",
    status: "all",
  });
  const [detail, setDetail] = useState<ServiceRequestRecord | null>(null);
  const [reviewing, setReviewing] = useState<ServiceRequestRecord | null>(null);
  const [reviewStatus, setReviewStatus] = useState<ServiceRequestStatus>("approved");
  const [reviewNote, setReviewNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const reviewSelectRef = useRef<HTMLSelectElement>(null);
  const submittingRef = useRef(false);

  const payload = useMemo(() => ({
    pageNum: page,
    pageSize,
    workspaceId: filters.workspaceId || null,
    type: filters.type === "all" ? null : filters.type,
    status: filters.status === "all" ? null : filters.status,
  }), [filters, page, pageSize]);
  const query = useFinanceQuery<ServiceRequestPage>(
    () => listServiceRequests(payload),
    JSON.stringify(payload),
    { items: [], total: 0, pageNum: 1, pageSize: 20 },
  );
  const summary = useFinanceQuery(loadServiceRequestSummary, "service-request-summary", {
    total: 0,
    pending: 0,
    approved: 0,
    rejected: 0,
    issued: 0,
    cancelled: 0,
  });

  function applyWorkspace() {
    setPage(1);
    setFilters((current) => ({ ...current, workspaceId: workspaceDraft.trim() }));
  }

  function openReview(row: ServiceRequestRecord) {
    const [initialStatus] = reviewOptions(row.type);
    setReviewing(row);
    setReviewStatus(initialStatus);
    setReviewNote(row.reviewNote || "");
    setFormError("");
    submittingRef.current = false;
  }

  async function submitReview() {
    if (!reviewing || submittingRef.current) return;
    submittingRef.current = true;
    setSaving(true);
    setFormError("");
    try {
      await updateServiceRequest(reviewing.id, reviewStatus, reviewNote);
      toast({
        title: "服务申请已更新",
        message: `申请 ${reviewing.id} 已标记为${statusLabels[reviewStatus]}。`,
        tone: "success",
      });
      setReviewing(null);
      await Promise.all([query.reload(), summary.reload()]);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "服务申请处理失败");
    } finally {
      submittingRef.current = false;
      setSaving(false);
    }
  }

  const rows = query.data.items || [];
  return (
    <ConsolePage
      className="serviceRequestsPage"
      breadcrumbs={[{ label: "运营" }, { label: "服务申请" }]}
      title="服务申请"
      description="集中处理发票、企业授信和线下付款申请；所有状态变更均通过管理员身份复核。"
      primaryAction={(
        <Button
          variant="secondary"
          icon={<RefreshCcw size={17} />}
          loading={query.loading || summary.loading}
          onClick={() => void Promise.all([query.reload(), summary.reload()])}
        >
          刷新
        </Button>
      )}
      layoutWidth="dashboard"
    >
      {summary.error ? <Alert tone="warning" title="汇总读取失败">{summary.error}</Alert> : null}
      <MetricStrip metrics={[
        { id: "total", label: "申请总数", value: metricValue(summary.loading, summary.data.total.toLocaleString()), hint: "全部历史申请" },
        { id: "pending", label: "待处理", value: metricValue(summary.loading, summary.data.pending.toLocaleString()), hint: "需要管理员决策", tone: "warning" },
        { id: "completed", label: "通过 / 已开具", value: metricValue(summary.loading, (summary.data.approved + summary.data.issued).toLocaleString()), hint: `通过 ${summary.data.approved} · 已开具 ${summary.data.issued}`, tone: "positive" },
        { id: "rejected", label: "驳回 / 取消", value: metricValue(summary.loading, (summary.data.rejected + summary.data.cancelled).toLocaleString()), hint: `驳回 ${summary.data.rejected} · 取消 ${summary.data.cancelled}`, tone: "neutral" },
      ]} />

      <section className="serviceRequestsData" aria-label="服务申请数据">
        <FilterBar
          actions={<Button variant="secondary" icon={<Search size={16} />} onClick={applyWorkspace}>查询</Button>}
        >
          <label className="serviceRequestFilter serviceRequestFilterSearch">
            <span>工作区 ID</span>
            <Input value={workspaceDraft} onChange={(event) => setWorkspaceDraft(event.target.value)} placeholder="输入完整工作区 ID" />
          </label>
          <label className="serviceRequestFilter">
            <span>申请类型</span>
            <Select value={filters.type} onChange={(event) => { setPage(1); setFilters((current) => ({ ...current, type: event.target.value as typeof filters.type })); }}>
              <option value="all">全部类型</option>
              {Object.entries(typeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </Select>
          </label>
          <label className="serviceRequestFilter">
            <span>申请状态</span>
            <Select value={filters.status} onChange={(event) => { setPage(1); setFilters((current) => ({ ...current, status: event.target.value as typeof filters.status })); }}>
              <option value="all">全部状态</option>
              {Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </Select>
          </label>
        </FilterBar>
        <DataTable<ServiceRequestRecord>
          className="serviceRequestsTable"
          ariaLabel="服务申请列表"
          caption="服务申请"
          captionMode="visible"
          scrollMode="contained"
          rows={rows}
          getRowId={(row) => row.id}
          loading={query.loading}
          error={query.error || undefined}
          onRetry={query.reload}
          emptyState={<EmptyState icon={Inbox} title="暂无服务申请" description="用户提交发票、授信或线下付款申请后会显示在这里。" />}
          onRowClick={setDetail}
          getRowAriaLabel={(row) => `查看服务申请 ${row.id}`}
          page={page}
          pageSize={pageSize}
          totalRows={Number(query.data.total || 0)}
          manualPagination
          onPageChange={setPage}
          onPageSizeChange={(value) => { setPage(1); setPageSize(value); }}
          columns={[
            {
              id: "request",
              header: "申请",
              priority: "primary",
              minWidth: "210px",
              cell: (row) => <span className="serviceRequestPrimary"><strong>{typeLabels[row.type]}</strong><span>{row.id}</span></span>,
            },
            { id: "workspace", header: "工作区", accessor: "workspaceId", priority: "primary", minWidth: "180px" },
            { id: "tenant", header: "收款租户", accessor: "sellerTenantId", priority: "primary", minWidth: "110px" },
            { id: "amount", header: "申请金额", priority: "primary", align: "end", cell: formatAmount },
            {
              id: "contact",
              header: "联系人",
              priority: "secondary",
              cell: (row) => <span className="serviceRequestPrimary"><strong>{row.contactName || "-"}</strong><span>{row.contactEmail || row.contactPhone || "未填写联系方式"}</span></span>,
            },
            { id: "status", header: "状态", priority: "primary", cell: (row) => <Badge tone={statusTone(row.status)}>{statusLabels[row.status]}</Badge> },
            { id: "created", header: "提交时间", priority: "detail", cell: (row) => formatDate(row.createdAt) },
            {
              id: "action",
              header: "操作",
              priority: "primary",
              hideable: false,
              width: "96px",
              cell: (row) => <Button variant="secondary" disabled={row.status !== "pending"} onClick={() => openReview(row)}>{row.status === "pending" ? "处理" : "已处理"}</Button>,
            },
          ]}
        />
      </section>

      <Dialog
        open={Boolean(reviewing)}
        title="处理服务申请"
        description={reviewing ? `${typeLabels[reviewing.type]} · ${reviewing.id}` : "核对申请信息后更新状态。"}
        size="md"
        loading={saving}
        dirty={Boolean(reviewing)}
        initialFocusRef={reviewSelectRef}
        onOpenChange={(open) => { if (!open && !saving) setReviewing(null); }}
        footer={({ requestClose, pending }) => (
          <div className="serviceRequestDialogFooter">
            {formError ? <Alert tone="danger">{formError}</Alert> : null}
            <div>
              <Button variant="secondary" disabled={pending} onClick={() => requestClose("cancel")}>取消</Button>
              <Button type="submit" form="service-request-review-form" loading={saving}>确认提交</Button>
            </div>
          </div>
        )}
      >
        <form id="service-request-review-form" className="serviceRequestForm" onSubmit={(event) => { event.preventDefault(); void submitReview(); }}>
          {reviewing ? (
            <DescriptionList items={[
              { label: "工作区", value: reviewing.workspaceId },
              { label: "收款租户", value: reviewing.sellerTenantId },
              { label: "申请金额", value: formatAmount(reviewing) },
              { label: "联系人", value: reviewing.contactName || "-" },
              { label: "申请说明", value: reviewing.note || "-" },
            ]} />
          ) : null}
          <FormField label="处理结果" required optionalLabel={null}>
            <Select ref={reviewSelectRef} value={reviewStatus} onChange={(event) => setReviewStatus(event.target.value as ServiceRequestStatus)}>
              {(reviewing ? reviewOptions(reviewing.type) : []).map((status) => <option key={status} value={status}>{statusLabels[status]}</option>)}
            </Select>
          </FormField>
          <FormField label="处理备注" help="说明核验依据或驳回原因，便于后续审计。">
            <textarea rows={4} maxLength={1000} value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} placeholder="填写处理意见" />
          </FormField>
        </form>
      </Dialog>

      <Drawer
        open={Boolean(detail)}
        title="服务申请详情"
        description={detail?.id || "查看申请上下文与处理记录。"}
        size="640px"
        onOpenChange={(open) => { if (!open) setDetail(null); }}
        footer={<div className="serviceRequestDrawerFooter"><Button variant="secondary" onClick={() => setDetail(null)}>关闭</Button></div>}
      >
        {detail ? (
          <div className="serviceRequestDetail">
            <DescriptionList items={[
              { label: "申请类型", value: typeLabels[detail.type] },
              { label: "状态", value: <Badge tone={statusTone(detail.status)}>{statusLabels[detail.status]}</Badge> },
              { label: "工作区 ID", value: detail.workspaceId },
              { label: "收款租户", value: detail.sellerTenantId },
              { label: "申请金额", value: formatAmount(detail) },
              { label: "主体名称", value: detail.subjectName || "-" },
              { label: "税号", value: detail.taxId || "-" },
              { label: "联系人", value: detail.contactName || "-" },
              { label: "联系邮箱", value: detail.contactEmail || "-" },
              { label: "联系电话", value: detail.contactPhone || "-" },
              { label: "申请说明", value: detail.note || "-" },
              { label: "处理备注", value: detail.reviewNote || "-" },
              { label: "提交时间", value: formatDate(detail.createdAt) },
              { label: "处理时间", value: formatDate(detail.reviewedAt) },
            ]} />
          </div>
        ) : null}
      </Drawer>
    </ConsolePage>
  );
}
