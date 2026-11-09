import { useMemo, useRef, useState } from "react";
import { RefreshCcw, Search } from "lucide-react";
import {
  Alert,
  Button,
  ConfirmDialog,
  ConsolePage,
  DataTable,
  Dialog,
  FieldGroup,
  FilterBar,
  FormField,
  Input,
  MetricStrip,
  Select,
  Skeleton,
  Tabs,
  useToast,
} from "../../../ui/console";
import { loadFinanceOverview, loadFinancePage, revokeGiftGrant, updateFinanceCase } from "./api";
import { useFinanceQuery } from "./hooks";
import type {
  AccountRow,
  FinanceCaseRow,
  FinanceCaseStatus,
  FinanceOverview,
  FinanceRecord,
  FinanceTab,
  GiftGrantRow,
  LedgerRow,
  PagePayload,
} from "./types";
import {
  displayValue,
  extractItems,
  formatCny,
  formatGu,
  toAccountRows,
  toCaseRows,
  toGiftRows,
  toLedgerRows,
} from "./utils";
import { AdjustmentDrawer } from "./components/AdjustmentDrawer";
import { useAuthStore } from "../../../stores/authStore";
import { canApproveFinance } from "../../../utils/permissions";
import {
  DetailDrawer,
  DetailList,
  EmptyView,
  MoneyCell,
  PrimaryCell,
  StatusBadge,
} from "./components/FinanceShared";
import "./styles.css";

const caseTypeLabels: Record<string, string> = {
  invoice: "发票",
  credit_limit: "信用额度",
  offline_payment: "线下支付",
};

const caseStatusLabels: Record<FinanceCaseStatus, string> = {
  pending: "待处理",
  approved: "已通过",
  rejected: "已驳回",
  issued: "已开具",
  cancelled: "已取消",
};

const caseStatusOptions = Object.keys(caseStatusLabels) as FinanceCaseStatus[];

const tabItems = [
  { value: "accounts", label: "账户额度", panelId: "finance-panel-accounts" },
  { value: "ledger", label: "账单流水", panelId: "finance-panel-ledger" },
  { value: "cases", label: "审批工单", panelId: "finance-panel-cases" },
  { value: "gifts", label: "赠送额度", panelId: "finance-panel-gifts" },
];

const tabDescriptions: Record<FinanceTab, string> = {
  accounts: "核对余额与信用额度，进入账户详情或发起调账。",
  ledger: "追踪每笔额度变化、操作人和审计说明。",
  cases: "处理发票、信用额度和线下支付申请。",
  gifts: "查看赠送批次、剩余额度与有效期。",
};

function metricValue(loading: boolean, value: string) {
  return loading ? <Skeleton width="6rem" height="1.65rem" /> : value;
}

function FinancePageContent() {
  const [tab, setTab] = useState<FinanceTab>("accounts");
  const overview = useFinanceQuery<FinanceOverview>(() => loadFinanceOverview(), "finance-overview", {});
  const account = overview.data.account || {};
  const cases = overview.data.cases || {};
  const income = overview.data.income || {};
  const ledger = overview.data.ledger || {};
  const user = useAuthStore((store) => store.user);
  const workspace = useAuthStore((store) => store.currentWorkspace);
  const platformPermissions = useAuthStore((store) => store.platformPermissions);
  const canApprove = canApproveFinance({ user, workspace });
  const canReadFinanceDetails = canApprove
    || platformPermissions.includes("fjadmin:finance:accounts:read");

  return (
    <ConsolePage
      className="financePage"
      title="财务中心"
      description="集中核对账户额度、账单流水、审批工单和赠送额度，并以可审计流程执行调账。"
      primaryAction={(
        <Button variant="secondary" icon={<RefreshCcw size={17} />} loading={overview.loading} onClick={() => void overview.reload()}>
          刷新概览
        </Button>
      )}
      layoutWidth="dashboard"
    >

      {overview.error ? <Alert tone="danger" title="概览读取失败">{overview.error}</Alert> : null}

      <MetricStrip className="financeMetrics" metrics={[
        {
          id: "accounts",
          label: "账户总数",
          value: metricValue(overview.loading, Number(account.total || 0).toLocaleString()),
          hint: `活跃 ${Number(account.active || 0).toLocaleString()}`,
        },
        {
          id: "available",
          label: "可用额度",
          value: metricValue(overview.loading, formatGu(account.availableMicros, "down")),
          hint: `信用额度 ${formatGu(account.creditLimitMicros, "down")}`,
          tone: "positive",
        },
        {
          id: "pending",
          label: "待审批工单",
          value: metricValue(overview.loading, Number(cases.pending || 0).toLocaleString()),
          hint: `工单合计 ${Number(cases.total || 0).toLocaleString()}`,
          tone: "warning",
        },
        {
          id: "income",
          label: "今日入账",
          value: metricValue(overview.loading, formatCny(income.todayCnyMicros)),
          hint: `今日流水 ${Number(ledger.todayCount || 0).toLocaleString()} 笔`,
          tone: "info",
        },
      ]} />

      {canReadFinanceDetails ? (
        <section className="financeContent" aria-label="财务业务数据">
          <div className="financeContentTabs">
            <Tabs className="financeTabs" items={tabItems} value={tab} onValueChange={(value) => setTab(value as FinanceTab)} ariaLabel="财务中心模块" />
            <p className="financeTabContext" aria-live="polite">{tabDescriptions[tab]}</p>
          </div>
          <div className="financePanel" id={`finance-panel-${tab}`} role="tabpanel" aria-label={tabItems.find((item) => item.value === tab)?.label}>
            {!canApprove ? <Alert className="financePermissionAlert" tone="info">当前角色可读取财务明细；调账、审批与撤销赠送额度需要财务审批权限。</Alert> : null}
            {tab === "accounts" ? <AccountsView onChanged={overview.reload} canApprove={canApprove} /> : null}
            {tab === "ledger" ? <LedgerView /> : null}
            {tab === "cases" ? <CasesView onChanged={overview.reload} canApprove={canApprove} /> : null}
            {tab === "gifts" ? <GiftsView onChanged={overview.reload} canApprove={canApprove} /> : null}
          </div>
        </section>
      ) : (
        <Alert tone="info" title="当前角色仅可查看财务概览">
          账户额度、账单流水、审批工单与赠送额度需要财务管理员权限。
        </Alert>
      )}
    </ConsolePage>
  );
}

export default function FinancePage() {
  return <FinancePageContent />;
}

function AccountsView({ onChanged, canApprove }: { onChanged: () => Promise<void>; canApprove: boolean }) {
  const { toast } = useToast();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [keywordDraft, setKeywordDraft] = useState("");
  const [filters, setFilters] = useState({ keyword: "", status: "all", billingMode: "all" });
  const [detailRow, setDetailRow] = useState<AccountRow | null>(null);
  const [adjustmentAccount, setAdjustmentAccount] = useState<AccountRow | null>(null);
  const payload = useMemo(() => ({ pageNum: page, pageSize, ...filters }), [filters, page, pageSize]);
  const query = useFinanceQuery<PagePayload>(
    () => loadFinancePage("/admin/finance/accounts/list", payload),
    JSON.stringify(payload),
    {},
  );
  const rows = useMemo(() => toAccountRows(extractItems(query.data)), [query.data]);
  const total = Number(query.data.total ?? rows.length);

  function applyFilters() {
    setPage(1);
    setFilters((current) => ({ ...current, keyword: keywordDraft.trim() }));
  }

  async function handleAdjustmentCompleted() {
    toast({ title: "调账已提交", message: "账户额度和财务流水已刷新。", tone: "success" });
    await Promise.all([query.reload(), onChanged()]);
  }

  return (
    <div className="financeViewStack">
      <FilterBar
        className="financeFilterBar"
        actions={<Button variant="secondary" icon={<Search size={16} />} onClick={applyFilters}>应用筛选</Button>}
        advanced={
          <>
            <label className="financeFilterField">
              <span>账户状态</span>
              <Select value={filters.status} onChange={(event) => { setPage(1); setFilters((current) => ({ ...current, status: event.target.value })); }}>
                <option value="all">全部状态</option>
                <option value="active">正常</option>
                <option value="suspended">已暂停</option>
                <option value="closed">已关闭</option>
              </Select>
            </label>
            <label className="financeFilterField">
              <span>计费模式</span>
              <Select value={filters.billingMode} onChange={(event) => { setPage(1); setFilters((current) => ({ ...current, billingMode: event.target.value })); }}>
                <option value="all">全部模式</option>
                <option value="prepaid">预付费</option>
                <option value="postpaid">后付费</option>
                <option value="hybrid">混合</option>
              </Select>
            </label>
          </>
        }
        activeAdvancedCount={Number(filters.status !== "all") + Number(filters.billingMode !== "all")}
      >
        <label className="financeFilterField financeFilterFieldSearch">
          <span>搜索账户</span>
          <Input value={keywordDraft} onChange={(event) => setKeywordDraft(event.target.value)} placeholder="工作区 / 负责人 / 邮箱" />
        </label>
      </FilterBar>

      <DataTable<AccountRow>
        className="financeTable"
        scrollMode="contained"
        ariaLabel="账户额度列表"
        caption="账户额度"
        rows={rows}
        getRowId={(row) => row.id}
        loading={query.loading}
        error={query.error || undefined}
        onRetry={query.reload}
        emptyState={<EmptyView title="暂无账户" description="创建工作区并开通账单账户后会显示在这里。" />}
        onRowClick={setDetailRow}
        getRowAriaLabel={(row) => `查看 ${row.workspaceName} 的账户额度详情`}
        page={page}
        pageSize={pageSize}
        totalRows={total}
        manualPagination
        onPageChange={setPage}
        onPageSizeChange={(value) => { setPage(1); setPageSize(value); }}
        columns={[
          {
            id: "workspace",
            header: "工作区",
            headerLabel: "工作区",
            priority: "primary",
            align: "center",
            minWidth: "180px",
            sortable: true,
            sortValue: (row) => row.workspaceName,
            cell: (row) => <PrimaryCell title={row.workspaceName} detail={row.owner} />,
          },
          { id: "available", header: "可用额度", accessor: "available", priority: "primary", align: "center", sortable: true, sortValue: (row) => Number(row.source.availableMicros || 0) },
          { id: "balance", header: "余额", accessor: "balance", priority: "secondary", align: "center", sortable: true, sortValue: (row) => Number(row.source.balanceMicros || 0) },
          { id: "credit", header: "信用额度", accessor: "credit", priority: "detail", align: "center", sortable: true, sortValue: (row) => Number(row.source.creditLimitMicros || 0) },
          { id: "status", header: "状态", priority: "primary", align: "center", cell: (row) => <StatusBadge status={row.status} /> },
          {
            id: "action",
            header: "操作",
            priority: "primary",
            hideable: false,
            align: "center",
            width: "104px",
            cell: (row) => canApprove ? <Button variant="secondary" onClick={() => setAdjustmentAccount(row)}>调账</Button> : <span aria-label="无调账权限">-</span>,
          },
        ]}
      />

      {canApprove ? <AdjustmentDrawer account={adjustmentAccount} onClose={() => setAdjustmentAccount(null)} onCompleted={handleAdjustmentCompleted} /> : null}

      <DetailDrawer
        open={Boolean(detailRow)}
        title="账户额度详情"
        description="查看账户归属、计费模式及完整额度上下文。"
        onClose={() => setDetailRow(null)}
      >
        <FieldGroup legend="账户信息" variant="section">
          <DetailList rows={[
            ["工作区", detailRow?.workspaceName],
            ["工作区 ID", detailRow?.workspaceId],
            ["负责人", detailRow?.owner],
            ["计费模式", detailRow?.billingMode],
            ["状态", detailRow ? <StatusBadge status={detailRow.status} /> : "-"],
          ]} />
        </FieldGroup>
        <FieldGroup legend="额度信息" variant="section">
          <DetailList rows={[
            ["可用额度", detailRow?.available],
            ["余额", detailRow?.balance],
            ["信用额度", detailRow?.credit],
            ["冻结额度", detailRow?.reserved],
          ]} />
        </FieldGroup>
      </DetailDrawer>
    </div>
  );
}

function LedgerView() {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [keywordDraft, setKeywordDraft] = useState("");
  const [filters, setFilters] = useState({ keyword: "", status: "all" });
  const [detailRow, setDetailRow] = useState<LedgerRow | null>(null);
  const payload = useMemo(() => ({ pageNum: page, pageSize, ...filters }), [filters, page, pageSize]);
  const query = useFinanceQuery<PagePayload>(() => loadFinancePage("/admin/finance/ledger/list", payload), JSON.stringify(payload), {});
  const rows = useMemo(() => toLedgerRows(extractItems(query.data)), [query.data]);
  const total = Number(query.data.total ?? rows.length);

  function applyFilters() {
    setPage(1);
    setFilters((current) => ({ ...current, keyword: keywordDraft.trim() }));
  }

  return (
    <div className="financeViewStack">
      <FilterBar className="financeFilterBar" actions={<Button variant="secondary" icon={<Search size={16} />} onClick={applyFilters}>应用筛选</Button>}>
        <label className="financeFilterField financeFilterFieldSearch">
          <span>搜索流水</span>
          <Input value={keywordDraft} onChange={(event) => setKeywordDraft(event.target.value)} placeholder="流水 ID / 说明 / 工作区" />
        </label>
        <label className="financeFilterField">
          <span>流水状态</span>
          <Select value={filters.status} onChange={(event) => { setPage(1); setFilters((current) => ({ ...current, status: event.target.value })); }}>
            <option value="all">全部状态</option>
            <option value="succeeded">已完成</option>
            <option value="frozen">已冻结</option>
            <option value="released">已释放</option>
            <option value="captured">已扣款</option>
          </Select>
        </label>
      </FilterBar>
      <DataTable<LedgerRow>
        className="financeTable"
        scrollMode="contained"
        ariaLabel="账单流水列表"
        caption="账单流水"
        rows={rows}
        getRowId={(row) => row.id}
        loading={query.loading}
        error={query.error || undefined}
        onRetry={query.reload}
        emptyState={<EmptyView title="暂无账单流水" description="发生扣费或充值后会显示在这里。" />}
        onRowClick={setDetailRow}
        getRowAriaLabel={(row) => `查看 ${row.workspace} 的 ${row.type} 流水详情`}
        page={page}
        pageSize={pageSize}
        totalRows={total}
        manualPagination
        onPageChange={setPage}
        onPageSizeChange={(value) => { setPage(1); setPageSize(value); }}
        columns={[
          { id: "workspace", header: "工作区", accessor: "workspace", priority: "primary", align: "center", minWidth: "170px", sortable: true },
          { id: "type", header: "类型", priority: "primary", align: "center", cell: (row) => <PrimaryCell title={row.type} detail={row.direction} />, sortable: true, sortValue: (row) => row.type },
          { id: "amount", header: "金额", accessor: "amount", priority: "primary", align: "center", sortable: true },
          { id: "balance", header: "变更后余额", accessor: "balance", priority: "secondary", align: "center" },
          { id: "time", header: "时间", accessor: "time", priority: "secondary", align: "center", sortable: true },
        ]}
      />
      <DetailDrawer open={Boolean(detailRow)} title="账单流水详情" description="核对金额链路、操作者和审计说明。" onClose={() => setDetailRow(null)}>
        <FieldGroup legend="流水信息" variant="section">
          <DetailList rows={[
            ["工作区", detailRow?.workspace],
            ["类型", detailRow?.type],
            ["方向", detailRow?.direction],
            ["金额", detailRow?.amount],
            ["变更后余额", detailRow?.balance],
            ["操作者", detailRow?.operator],
            ["时间", detailRow?.time],
          ]} />
        </FieldGroup>
        <FieldGroup legend="审计说明" variant="section"><p className="financeDetailCopy">{detailRow?.description}</p></FieldGroup>
      </DetailDrawer>
    </div>
  );
}

function CasesView({ onChanged, canApprove }: { onChanged: () => Promise<void>; canApprove: boolean }) {
  const { toast } = useToast();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [filters, setFilters] = useState({ category: "all", status: "all" });
  const [detailRow, setDetailRow] = useState<FinanceCaseRow | null>(null);
  const [reviewRow, setReviewRow] = useState<FinanceRecord | null>(null);
  const [reviewStatus, setReviewStatus] = useState<FinanceCaseStatus>("approved");
  const [reviewNote, setReviewNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const reviewSelectRef = useRef<HTMLSelectElement>(null);
  const reviewSubmittingRef = useRef(false);
  const payload = useMemo(() => ({ pageNum: page, pageSize, ...filters }), [filters, page, pageSize]);
  const query = useFinanceQuery<PagePayload>(() => loadFinancePage("/admin/finance/cases/list", payload), JSON.stringify(payload), {});
  const rows = useMemo(() => toCaseRows(extractItems(query.data), caseTypeLabels), [query.data]);
  const total = Number(query.data.total ?? rows.length);

  function openReview(row: FinanceRecord) {
    reviewSubmittingRef.current = false;
    setReviewRow(row);
    setReviewStatus(caseStatusOptions.includes(row.status) ? row.status : "approved");
    setReviewNote(String(row.reviewNote || ""));
    setFormError("");
  }

  async function submitReview() {
    if (!reviewRow || reviewSubmittingRef.current) return;
    reviewSubmittingRef.current = true;
    setSaving(true);
    setFormError("");
    try {
      await updateFinanceCase(String(reviewRow.id), reviewStatus, reviewNote);
      toast({ title: "审批工单已更新", message: `当前状态：${caseStatusLabels[reviewStatus]}`, tone: "success" });
      setReviewRow(null);
      await Promise.all([query.reload(), onChanged()]);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "工单审批失败");
    } finally {
      reviewSubmittingRef.current = false;
      setSaving(false);
    }
  }

  return (
    <div className="financeViewStack">
      <FilterBar className="financeFilterBar">
        <label className="financeFilterField">
          <span>工单类型</span>
          <Select value={filters.category} onChange={(event) => { setPage(1); setFilters((current) => ({ ...current, category: event.target.value })); }}>
            <option value="all">全部类型</option>
            <option value="invoice">发票</option>
            <option value="credit_limit">信用额度</option>
            <option value="offline_payment">线下支付</option>
          </Select>
        </label>
        <label className="financeFilterField">
          <span>工单状态</span>
          <Select value={filters.status} onChange={(event) => { setPage(1); setFilters((current) => ({ ...current, status: event.target.value })); }}>
            <option value="all">全部状态</option>
            {caseStatusOptions.map((status) => <option key={status} value={status}>{caseStatusLabels[status]}</option>)}
          </Select>
        </label>
      </FilterBar>
      <DataTable<FinanceCaseRow>
        className="financeTable"
        scrollMode="contained"
        ariaLabel="审批工单列表"
        caption="审批工单"
        rows={rows}
        getRowId={(row) => row.id}
        loading={query.loading}
        error={query.error || undefined}
        onRetry={query.reload}
        emptyState={<EmptyView title="暂无审批工单" description="用户提交发票、信用额度或线下支付申请后会显示在这里。" />}
        onRowClick={setDetailRow}
        getRowAriaLabel={(row) => `查看工单 ${row.caseNo} 详情`}
        page={page}
        pageSize={pageSize}
        totalRows={total}
        manualPagination
        onPageChange={setPage}
        onPageSizeChange={(value) => { setPage(1); setPageSize(value); }}
        columns={[
          { id: "caseNo", header: "工单号", accessor: "caseNo", priority: "primary", align: "center", sortable: true, minWidth: "150px" },
          { id: "workspace", header: "工作区", accessor: "workspace", priority: "primary", align: "center", sortable: true, minWidth: "160px" },
          { id: "type", header: "类型", accessor: "type", priority: "secondary", align: "center", sortable: true },
          { id: "amount", header: "金额", priority: "primary", align: "center", cell: (row) => <MoneyCell primary={row.amount} secondary={row.amountCny} /> },
          { id: "status", header: "状态", priority: "primary", align: "center", cell: (row) => <StatusBadge status={row.status} /> },
          { id: "time", header: "提交时间", accessor: "time", priority: "detail", align: "center", sortable: true },
          { id: "action", header: "操作", priority: "primary", align: "center", hideable: false, width: "104px", cell: (row) => canApprove ? <Button variant="secondary" onClick={() => openReview(row.source)}>审批</Button> : <span aria-label="无审批权限">-</span> },
        ]}
      />

      <Dialog
        open={Boolean(reviewRow)}
        title="审批工单"
        description="核对工单与金额后更新审批状态。"
        size="md"
        loading={saving}
        dirty={Boolean(reviewRow) && (reviewStatus !== String(reviewRow?.status || "approved") || reviewNote !== String(reviewRow?.reviewNote || ""))}
        initialFocusRef={reviewSelectRef}
        onOpenChange={(nextOpen) => { if (!nextOpen && !saving) setReviewRow(null); }}
        footer={({ requestClose, pending }) => (
          <div className="financeDrawerFooter">
            {formError ? <Alert tone="danger">{formError}</Alert> : null}
            <div className="financeDrawerActions">
              <Button variant="secondary" onClick={() => requestClose("cancel")} disabled={pending}>取消</Button>
              <Button type="submit" form="finance-case-review-form" loading={saving}>提交审批</Button>
            </div>
          </div>
        )}
      >
        <form
          id="finance-case-review-form"
          className="financeDrawerStack"
          onSubmit={(event) => {
            event.preventDefault();
            void submitReview();
          }}
        >
          <DetailList rows={[
            ["工单号", displayValue(reviewRow?.caseNo)],
            ["工作区", displayValue(reviewRow?.workspaceName || reviewRow?.workspaceId)],
            ["类型", caseTypeLabels[String(reviewRow?.type)] || displayValue(reviewRow?.type)],
            ["GU 金额", formatGu(reviewRow?.amountGuMicros)],
          ]} />
          <FormField label="审批状态" required optionalLabel={null}>
            <Select ref={reviewSelectRef} value={reviewStatus} onChange={(event) => setReviewStatus(event.target.value as FinanceCaseStatus)}>
              {caseStatusOptions.map((status) => <option key={status} value={status}>{caseStatusLabels[status]}</option>)}
            </Select>
          </FormField>
          <FormField label="审批备注">
            <textarea maxLength={1000} value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} rows={4} placeholder="填写审批意见" />
          </FormField>
        </form>
      </Dialog>

      <DetailDrawer open={Boolean(detailRow)} title="审批工单详情" description="查看工单上下文、提交人和折合金额。" onClose={() => setDetailRow(null)}>
        <FieldGroup legend="工单信息" variant="section">
          <DetailList rows={[
            ["工单号", detailRow?.caseNo],
            ["工作区", detailRow?.workspace],
            ["类型", detailRow?.type],
            ["GU 金额", detailRow?.amount],
            ["折合金额", detailRow?.amountCny],
            ["提交人", detailRow?.submittedBy],
            ["状态", detailRow ? <StatusBadge status={detailRow.status} /> : "-"],
            ["提交时间", detailRow?.time],
          ]} />
        </FieldGroup>
      </DetailDrawer>
    </div>
  );
}

function GiftsView({ onChanged, canApprove }: { onChanged: () => Promise<void>; canApprove: boolean }) {
  const { toast } = useToast();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [status, setStatus] = useState("active");
  const [confirmRow, setConfirmRow] = useState<GiftGrantRow | null>(null);
  const [detailRow, setDetailRow] = useState<GiftGrantRow | null>(null);
  const payload = useMemo(() => ({ pageNum: page, pageSize, status }), [page, pageSize, status]);
  const query = useFinanceQuery<PagePayload>(() => loadFinancePage("/admin/finance/gift-grants/list", payload), JSON.stringify(payload), {});
  const rows = useMemo(() => toGiftRows(extractItems(query.data)), [query.data]);
  const total = Number(query.data.total ?? rows.length);

  async function revoke(row: GiftGrantRow) {
    await revokeGiftGrant(row.id);
    toast({ title: "赠送额度已撤销", message: "剩余额度已回收并写入财务流水。", tone: "success" });
    setConfirmRow(null);
    await Promise.all([query.reload(), onChanged()]);
  }

  return (
    <div className="financeViewStack">
      <FilterBar className="financeFilterBar">
        <label className="financeFilterField">
          <span>额度状态</span>
          <Select value={status} onChange={(event) => { setPage(1); setStatus(event.target.value); }}>
            <option value="all">全部状态</option>
            <option value="active">生效中</option>
            <option value="expired">已过期</option>
            <option value="exhausted">已用完</option>
            <option value="revoked">已撤销</option>
          </Select>
        </label>
      </FilterBar>
      <DataTable<GiftGrantRow>
        className="financeTable"
        scrollMode="contained"
        ariaLabel="赠送额度列表"
        caption="赠送额度"
        rows={rows}
        getRowId={(row) => row.id}
        loading={query.loading}
        error={query.error || undefined}
        onRetry={query.reload}
        emptyState={<EmptyView title="暂无赠送额度" description="在账户调账中执行赠送额度后会显示在这里。" />}
        onRowClick={setDetailRow}
        getRowAriaLabel={(row) => `查看用户 ${row.userId} 的赠送额度详情`}
        page={page}
        pageSize={pageSize}
        totalRows={total}
        manualPagination
        onPageChange={setPage}
        onPageSizeChange={(value) => { setPage(1); setPageSize(value); }}
        columns={[
          { id: "userId", header: "用户 ID", accessor: "userId", priority: "primary", align: "center", sortable: true, minWidth: "150px" },
          { id: "workspace", header: "工作区", accessor: "workspace", priority: "primary", align: "center", sortable: true, minWidth: "160px" },
          { id: "amount", header: "赠送额度", accessor: "amount", priority: "primary", align: "center" },
          { id: "remaining", header: "剩余额度", accessor: "remaining", priority: "secondary", align: "center" },
          { id: "campaign", header: "活动", accessor: "campaign", priority: "secondary", align: "center", sortable: true },
          { id: "expiresAt", header: "到期时间", accessor: "expiresAt", priority: "detail", align: "center", sortable: true },
          { id: "status", header: "状态", priority: "primary", align: "center", cell: (row) => <StatusBadge status={row.status} /> },
          { id: "createdAt", header: "创建时间", accessor: "createdAt", priority: "detail", align: "center", sortable: true },
          { id: "action", header: "操作", priority: "primary", align: "center", hideable: false, width: "104px", cell: (row) => canApprove ? <Button variant="danger" onClick={() => setConfirmRow(row)} disabled={row.status !== "active"}>撤销</Button> : <span aria-label="无撤销权限">-</span> },
        ]}
      />
      <ConfirmDialog
        open={Boolean(confirmRow)}
        title="撤销赠送额度"
        description={`撤销用户 ${confirmRow?.userId || "-"} 的赠送额度后，剩余额度将被回收并写入财务流水。`}
        confirmLabel="撤销额度"
        tone="danger"
        onCancel={() => setConfirmRow(null)}
        onConfirm={() => confirmRow ? revoke(confirmRow) : false}
        onConfirmError={(error) => toast({ title: "撤销失败", message: error instanceof Error ? error.message : "请稍后重试", tone: "danger" })}
      />
      <DetailDrawer open={Boolean(detailRow)} title="赠送额度详情" description="查看批次面值、剩余额度、活动和有效期。" onClose={() => setDetailRow(null)}>
        <FieldGroup legend="额度批次" variant="section">
          <DetailList rows={[
            ["用户 ID", detailRow?.userId],
            ["工作区", detailRow?.workspace],
            ["赠送额度", detailRow?.amount],
            ["剩余额度", detailRow?.remaining],
            ["活动", detailRow?.campaign],
            ["状态", detailRow ? <StatusBadge status={detailRow.status} /> : "-"],
            ["到期时间", detailRow?.expiresAt],
            ["创建时间", detailRow?.createdAt],
          ]} />
        </FieldGroup>
      </DetailDrawer>
    </div>
  );
}
