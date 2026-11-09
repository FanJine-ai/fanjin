import { useEffect, useMemo, useState } from "react";
import { Building2, Edit3, Plus, RefreshCcw, Search, Tags, UserCheck, UserRoundCog, UserRoundX, UsersRound } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { toApiErrorView } from "../../../api/http";
import { useAuthStore } from "../../../stores/authStore";
import { isPlatformAdmin } from "../../../utils/permissions";
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  ConfirmDialog,
  ConsolePage,
  DataTable,
  DescriptionList,
  Drawer,
  FilterBar,
  IconButton,
  Input,
  MetricStrip,
  Section,
  Select,
  useToast,
  type BadgeTone,
  type DataTableColumn,
} from "../../../ui/console";
import { createAdminUser, updateAdminUserCategories, updateAdminUsersStatus, type ScopedAdminUserUpdate } from "./api";
import { ChangeOwnerTenantDialog } from "./components/ChangeOwnerTenantDialog";
import { UserFormDrawer } from "./components/UserFormDrawer";
import { useAdminUsers } from "./hooks";
import { useFinanceQuery } from "../finance/hooks";
import { listCommercialTenants } from "../commercial-tenants/api";
import { PricingGroupManagerDrawer } from "../pricingGroups/PricingGroupManagerDrawer";
import { usePricingGroups } from "../pricingGroups/hooks";
import {
  accountTypeLabels,
  accountTypeOptions,
  billingModeLabels,
  emptyUserForm,
  userFormFromRecord,
  userRoleLabels,
  userRoleOptions,
  userStatusLabels,
  userStatusOptions,
  settlementTypeLabels,
  type AdminUserRecord,
  type UserFormState,
  type UsersListInput,
} from "./types";
import "./users.css";

interface UserRow {
  id: string;
  numericId: number;
  source: AdminUserRecord;
  name: string;
  email: string;
  role: string;
  roleLabel: string;
  status: string;
  accountType: string;
  accountTypeLabel: string;
  workspace: string;
  team: string;
  billing: string;
  createdAt: string;
  pricingGroup: string;
  ownerTenantId: string;
  registeredTenantId: string;
  registrationHostname: string;
}

type UserFilters = Pick<UsersListInput, "keyword" | "status" | "accountType" | "role" | "pricingGroup" | "ownerTenantId">;

interface StatusIntent {
  userIds: number[];
  names: string[];
  status: "active" | "disabled";
}

function display(value: unknown) {
  if (value == null || value === "") return "-";
  return String(value);
}

function formatDate(value?: string | number | null) {
  if (!value) return "-";
  const date = new Date(typeof value === "number" && value < 10_000_000_000 ? value * 1000 : value);
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

function formatGu(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? `${numeric.toLocaleString("zh-CN", { maximumFractionDigits: 2 })} GU` : "-";
}

function statusTone(status: string): BadgeTone {
  if (status === "active") return "success";
  if (status === "locked") return "warning";
  if (status === "disabled") return "danger";
  return "neutral";
}

function readPositiveInteger(value: string | null, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readFilters(params: URLSearchParams): UserFilters {
  const role = params.get("role");
  const status = params.get("status");
  const accountType = params.get("account");
  const ownerTenantId = params.get("ownerTenant") || "";
  return {
    keyword: params.get("q") || "",
    role: userRoleOptions.includes(role as (typeof userRoleOptions)[number]) ? role as UserFilters["role"] : "all",
    status: userStatusOptions.includes(status as (typeof userStatusOptions)[number]) ? status as UserFilters["status"] : "all",
    accountType: accountTypeOptions.includes(accountType as (typeof accountTypeOptions)[number]) ? accountType as UserFilters["accountType"] : "all",
    pricingGroup: params.get("group") || "all",
    ownerTenantId: /^[A-Z][A-Z0-9_-]{0,63}$/.test(ownerTenantId) ? ownerTenantId : "all",
  };
}

function filtersToParams(filters: UserFilters, page: number, pageSize: number) {
  const params = new URLSearchParams();
  if (filters.keyword?.trim()) params.set("q", filters.keyword.trim());
  if (filters.role && filters.role !== "all") params.set("role", filters.role);
  if (filters.status && filters.status !== "all") params.set("status", filters.status);
  if (filters.accountType && filters.accountType !== "all") params.set("account", filters.accountType);
  if (filters.pricingGroup && filters.pricingGroup !== "all") params.set("group", filters.pricingGroup);
  if (filters.ownerTenantId && filters.ownerTenantId !== "all") params.set("ownerTenant", filters.ownerTenantId);
  if (page > 1) params.set("page", String(page));
  if (pageSize !== 20) params.set("size", String(pageSize));
  return params;
}

function toRow(user: AdminUserRecord, index: number): UserRow {
  const status = String(user.status || "active");
  const role = String(user.role || "member");
  const accountType = String(user.commercial?.accountType || user.accountType || "personal");
  return {
    id: String(user.id ?? index),
    numericId: Number(user.id ?? 0),
    source: user,
    name: display(user.displayName || user.name || user.email || user.id),
    email: display(user.email),
    role,
    roleLabel: userRoleLabels[role as keyof typeof userRoleLabels] || `未知角色（${role}）`,
    status,
    accountType,
    accountTypeLabel: accountTypeLabels[accountType as keyof typeof accountTypeLabels] || accountType,
    workspace: display(user.currentWorkspaceName || user.currentWorkspaceId),
    team: `${Number(user.team?.ownedWorkspaceCount || 0)} 拥有 / ${Number(user.team?.joinedWorkspaceCount || 0)} 加入`,
    billing: user.billing?.planName || user.billing?.billingMode ? `${display(user.billing?.planName)} · ${display(billingModeLabels[user.billing?.billingMode as keyof typeof billingModeLabels] || user.billing?.billingMode)}` : "-",
    createdAt: formatDate(user.createdAt),
    pricingGroup: String(user.commercial?.pricingGroup || "default"),
    ownerTenantId: String(user.attribution?.ownerTenantId || "-"),
    registeredTenantId: String(user.attribution?.registeredTenantId || "-"),
    registrationHostname: String(user.attribution?.registrationHostname || ""),
  };
}

function buildCreatePayload(form: UserFormState) {
  return {
    name: form.name.trim(),
    displayName: form.displayName.trim() || null,
    email: form.email.trim() || null,
    password: form.password,
    workspaceName: form.workspaceName.trim() || null,
    accountType: form.accountType,
    commercialGroup: form.commercialGroup.trim(),
    pricingGroup: form.pricingGroup.trim() || null,
    rechargeDiscountBps: form.rechargeDiscountBps,
    billingMode: form.billingMode,
    settlementType: form.settlementType,
    notes: form.notes.trim() || null,
  };
}

function commercialPayload(form: UserFormState) {
  return {
    accountType: form.accountType,
    commercialGroup: form.commercialGroup.trim(),
    pricingGroup: form.pricingGroup.trim() || null,
    rechargeDiscountBps: form.rechargeDiscountBps,
    billingMode: form.billingMode,
    settlementType: form.settlementType,
    notes: form.notes.trim() || null,
  };
}

function buildUpdateOperations(userId: number, before: UserFormState, after: UserFormState): ScopedAdminUserUpdate[] {
  const operations: ScopedAdminUserUpdate[] = [];
  const beforeProfile = { displayName: before.displayName.trim() || null, email: before.email.trim() || null };
  const afterProfile = { displayName: after.displayName.trim() || null, email: after.email.trim() || null };
  if (JSON.stringify(beforeProfile) !== JSON.stringify(afterProfile)) {
    operations.push({ input: { userId, ...afterProfile }, scope: "admin.user.profile" });
  }
  if (before.status !== after.status) {
    operations.push({ input: { userId, status: after.status }, scope: "admin.user.status" });
  }
  if (before.role !== after.role) {
    operations.push({ input: { userId, role: after.role }, scope: "admin.user.role" });
  }
  const beforeCommercial = commercialPayload(before);
  const afterCommercial = commercialPayload(after);
  if (JSON.stringify(beforeCommercial) !== JSON.stringify(afterCommercial)) {
    operations.push({ input: { userId, commercial: afterCommercial }, scope: "admin.user.commercial" });
  }
  return operations;
}

export default function AdminUsersPage() {
  const { toast } = useToast();
  const currentUser = useAuthStore((store) => store.user);
  const currentWorkspace = useAuthStore((store) => store.currentWorkspace);
  const canUseRootRole = isPlatformAdmin({ user: currentUser, workspace: currentWorkspace }) && String(currentUser?.role || "").toLowerCase() === "root";
  const [searchParams, setSearchParams] = useSearchParams();
  const paramsKey = searchParams.toString();
  const filters = useMemo(() => readFilters(searchParams), [paramsKey]);
  const page = readPositiveInteger(searchParams.get("page"), 1);
  const requestedPageSize = readPositiveInteger(searchParams.get("size"), 20);
  const pageSize = [20, 50, 100].includes(requestedPageSize) ? requestedPageSize : 20;
  const [keywordDraft, setKeywordDraft] = useState(filters.keyword || "");
  const queryInput = useMemo<UsersListInput>(() => ({
    pageNum: page,
    pageSize,
    keyword: filters.keyword,
    status: filters.status,
    accountType: filters.accountType,
    role: filters.role,
    pricingGroup: filters.pricingGroup,
    ownerTenantId: filters.ownerTenantId,
  }), [filters, page, pageSize]);
  const state = useAdminUsers(queryInput);
  const pricingGroupsState = usePricingGroups();
  const tenantSummary = useFinanceQuery(listCommercialTenants, "users-tenant-options", { items: [] });
  const tenantOptions = useMemo(
    () => (tenantSummary.data?.items || []).map((tenant: { id: string; name: string }) => ({ id: tenant.id, name: tenant.name })),
    [tenantSummary.data],
  );
  const tenantNameById = useMemo(
    () => new Map(tenantOptions.map((tenant) => [tenant.id, tenant.name])),
    [tenantOptions],
  );
  const allRows = useMemo(() => state.data.items.map(toRow), [state.data.items]);
  const summary = state.data.summary || {};
  const total = Number(state.data.total || allRows.length);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerMode, setDrawerMode] = useState<"create" | "edit">("create");
  const [editingRow, setEditingRow] = useState<UserRow | null>(null);
  const [form, setForm] = useState<UserFormState>(() => emptyUserForm());
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [detailRow, setDetailRow] = useState<UserRow | null>(null);
  const [statusIntent, setStatusIntent] = useState<StatusIntent | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState("");
  const [pendingDangerForm, setPendingDangerForm] = useState<UserFormState | null>(null);
  const [groupManagerOpen, setGroupManagerOpen] = useState(false);
  const [ownerTenantIntent, setOwnerTenantIntent] = useState<UserRow | null>(null);
  const pricingGroupNames = useMemo(
    () => new Map(pricingGroupsState.groups.map((group) => [group.code, group.name])),
    [pricingGroupsState.groups],
  );

  useEffect(() => {
    setKeywordDraft(filters.keyword || "");
    setSelectedIds(new Set());
  }, [paramsKey]);

  function updateUrl(nextFilters: UserFilters, nextPage = 1, nextPageSize = pageSize) {
    setSearchParams(filtersToParams(nextFilters, nextPage, nextPageSize));
  }

  function applyFilters() {
    updateUrl({ ...filters, keyword: keywordDraft.trim() });
  }

  function openCreate() {
    setDrawerMode("create");
    setEditingRow(null);
    setForm(emptyUserForm());
    setFormError("");
    setDrawerOpen(true);
  }

  function openEdit(row: UserRow) {
    setDetailRow(null);
    setDrawerMode("edit");
    setEditingRow(row);
    setForm(userFormFromRecord(row.source));
    setFormError("");
    setDrawerOpen(true);
  }

  function closeDrawer() {
    if (saving) return;
    setDrawerOpen(false);
    setEditingRow(null);
    setForm(emptyUserForm());
    setFormError("");
  }

  async function persistForm(nextForm: UserFormState) {
    setSaving(true);
    setFormError("");
    try {
      if (drawerMode === "create") {
        await createAdminUser(buildCreatePayload(nextForm));
        toast({ title: "用户已创建", message: "用户列表已刷新。", tone: "success" });
        updateUrl(filters, 1);
      } else if (editingRow) {
        const operations = buildUpdateOperations(editingRow.numericId, userFormFromRecord(editingRow.source), nextForm);
        if (operations.length) {
          await updateAdminUserCategories(operations);
          toast({ title: "用户已更新", message: `${editingRow.name} · ${operations.length} 类变更`, tone: "success" });
        } else {
          toast({ title: "没有需要保存的变更", message: editingRow.name, tone: "info" });
        }
      }
      setDrawerOpen(false);
      setEditingRow(null);
      setPendingDangerForm(null);
      setForm(emptyUserForm());
      await state.reload();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "用户保存失败";
      setFormError(message);
    } finally {
      setSaving(false);
    }
  }

  async function submit(nextForm: UserFormState) {
    if (drawerMode === "edit" && editingRow && editingRow.status !== "disabled" && nextForm.status === "disabled") {
      setPendingDangerForm(nextForm);
      return;
    }
    await persistForm(nextForm);
  }

  function toggleUser(userId: number, checked: boolean) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) next.add(userId); else next.delete(userId);
      return next;
    });
  }

  const pageIds = allRows.map((row) => row.numericId).filter((id) => Number.isFinite(id) && id > 0);
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selectedIds.has(id));
  const somePageSelected = !allPageSelected && pageIds.some((id) => selectedIds.has(id));

  function togglePage(checked: boolean) {
    setSelectedIds((current) => {
      const next = new Set(current);
      pageIds.forEach((id) => checked ? next.add(id) : next.delete(id));
      return next;
    });
  }

  async function runStatusUpdate() {
    if (!statusIntent) return;
    setStatusLoading(true);
    setStatusError("");
    try {
      const result = await updateAdminUsersStatus(statusIntent.userIds, statusIntent.status);
      if (result.failed.length) {
        const message = `成功 ${result.succeeded} 个，失败 ${result.failed.length} 个；失败对象仍保持选中。`;
        setStatusError(message);
        setSelectedIds(new Set(result.failed.map((item) => item.userId)));
        toast({ title: "状态更新部分完成", message, tone: "warning" });
      } else {
        setSelectedIds(new Set());
        toast({
          title: statusIntent.status === "disabled" ? "用户已停用" : "用户已启用",
          message: `已更新 ${result.succeeded} 个用户。`,
          tone: "success",
        });
      }
      setDetailRow(null);
      await state.reload();
    } catch (caught) {
      const message = toApiErrorView(caught).message;
      setStatusError(message);
      toast({ title: "状态更新失败", message, tone: "danger" });
    } finally {
      setStatusLoading(false);
      setStatusIntent(null);
    }
  }

  const columns = useMemo<DataTableColumn<UserRow>[]>(() => [
    {
      id: "select",
      header: <Checkbox aria-label="选择当前页全部用户" checked={allPageSelected} indeterminate={somePageSelected} onCheckedChange={togglePage} />,
      headerLabel: "选择",
      priority: "secondary",
      hideable: false,
      width: "52px",
      cell: (row) => <Checkbox aria-label={`选择用户 ${row.name}`} checked={selectedIds.has(row.numericId)} onCheckedChange={(checked) => toggleUser(row.numericId, checked)} />,
    },
    {
      id: "user",
      header: "用户",
      priority: "primary",
      sortable: true,
      sortValue: (row) => row.name,
      minWidth: "200px",
      cell: (row) => (
        <div className="adminUsersNameCell">
          <strong>{row.name}</strong>
          <span>{row.email}</span>
        </div>
      ),
    },
    { id: "role", header: "角色", priority: "secondary", accessor: "roleLabel", sortable: true },
    {
      id: "status",
      header: "状态",
      priority: "primary",
      sortable: true,
      sortValue: (row) => row.status,
      cell: (row) => <Badge tone={statusTone(row.status)}>{userStatusLabels[row.status as keyof typeof userStatusLabels] || row.status}</Badge>,
    },
    { id: "accountType", header: "账户类型", priority: "secondary", accessor: "accountTypeLabel", sortable: true },
    {
      id: "pricingGroup",
      header: "定价分组",
      priority: "secondary",
      sortable: true,
      sortValue: (row) => row.pricingGroup,
      cell: (row) => <div className="adminUsersNameCell"><strong>{pricingGroupNames.get(row.pricingGroup) || row.pricingGroup}</strong>{pricingGroupNames.get(row.pricingGroup) && pricingGroupNames.get(row.pricingGroup) !== row.pricingGroup ? <span>{row.pricingGroup}</span> : null}</div>,
    },
    {
      id: "ownerTenant",
      defaultVisible: false,
      header: "所属租户",
      priority: "secondary",
      sortable: true,
      sortValue: (row) => row.ownerTenantId,
      cell: (row) => (
        <div className="adminUsersNameCell">
          <strong>{tenantNameById.get(row.ownerTenantId) || row.ownerTenantId}</strong>
          <span>注册：{tenantNameById.get(row.registeredTenantId) || row.registeredTenantId}{row.registrationHostname ? ` · ${row.registrationHostname}` : ""}</span>
        </div>
      ),
    },
    { id: "workspace", header: "当前工作区", priority: "secondary", accessor: "workspace" },
    { id: "team", defaultVisible: false, header: "团队", priority: "detail", accessor: "team" },
    { id: "billing", defaultVisible: false, header: "套餐/计费", priority: "detail", accessor: "billing" },
    { id: "createdAt", defaultVisible: false, header: "创建时间", priority: "detail", accessor: "createdAt", sortable: true },
    {
      id: "actions",
      header: "操作",
      priority: "primary",
      hideable: false,
      width: "92px",
      cell: (row) => <IconButton aria-label="编辑" size="compact" icon={<Edit3 size={15} />} onClick={() => openEdit(row)} />,
    },
  ], [allPageSelected, pricingGroupNames, selectedIds, somePageSelected]);

  return (
    <ConsolePage
      title="用户管理"
      description="管理用户权限、账户状态与商业归属，点击用户查看完整资料。"
      primaryAction={<div className="usersPageActions"><Button variant="secondary" icon={<Tags size={17} />} onClick={() => setGroupManagerOpen(true)}>定价分组</Button><Button icon={<Plus size={18} />} onClick={openCreate}>创建用户</Button></div>}
      layoutWidth="dashboard"
    >
      {pricingGroupsState.error ? <Alert tone="danger" title="定价分组读取失败">{pricingGroupsState.error}</Alert> : null}
      <section className="adminUsersWorkbench" aria-label="用户运营工作台">
        <MetricStrip metrics={[
          { id: "total", label: "用户总数", value: state.loading ? "-" : Number(summary.total ?? total).toLocaleString("zh-CN"), hint: "全部注册用户" },
          { id: "active", label: "正常账户", value: state.loading ? "-" : Number(summary.active ?? allRows.filter((row) => row.status === "active").length).toLocaleString("zh-CN"), tone: "positive", hint: "账户状态正常" },
          { id: "enterprise", label: "企业账户", value: state.loading ? "-" : Number(summary.enterprise ?? allRows.filter((row) => row.accountType === "enterprise").length).toLocaleString("zh-CN") },
          { id: "personal", label: "个人账户", value: state.loading ? "-" : Number(summary.personal ?? allRows.filter((row) => row.accountType === "personal").length).toLocaleString("zh-CN") },
        ]} />
        <FilterBar
          advancedLabel="更多筛选"
          activeAdvancedCount={[filters.accountType, filters.pricingGroup, filters.ownerTenantId].filter((value) => value && value !== "all").length}
          advanced={<>
          <Select aria-label="账户类型筛选" value={filters.accountType} onChange={(event) => updateUrl({ ...filters, accountType: event.currentTarget.value as UsersListInput["accountType"] })}>
            <option value="all">全部账户</option>
            {accountTypeOptions.map((value) => <option key={value} value={value}>{accountTypeLabels[value]}</option>)}
          </Select>
          <Select aria-label="定价分组筛选" value={filters.pricingGroup || "all"} onChange={(event) => updateUrl({ ...filters, pricingGroup: event.currentTarget.value })}>
            <option value="all">全部定价分组</option>
            {pricingGroupsState.groups.map((group) => <option key={group.code} value={group.code}>{group.name === group.code ? group.name : `${group.name} · ${group.code}`}</option>)}
          </Select>
          <Select aria-label="所属租户筛选" value={filters.ownerTenantId || "all"} onChange={(event) => updateUrl({ ...filters, ownerTenantId: event.currentTarget.value })}>
            <option value="all">全部所属租户</option>
            {tenantOptions.map((tenant) => <option key={tenant.id} value={tenant.id}>{tenant.name} · {tenant.id}</option>)}
          </Select>
          </>}
          actions={<Button variant="secondary" icon={<RefreshCcw size={16} />} loading={state.loading} onClick={() => void state.reload()}>刷新</Button>}>
          <Input aria-label="搜索用户" startIcon={<Search size={16} />} placeholder="搜索名称、邮箱、用户 ID" value={keywordDraft} onChange={(event) => setKeywordDraft(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter") applyFilters(); }} />
          <Select aria-label="角色筛选" value={filters.role} onChange={(event) => updateUrl({ ...filters, role: event.currentTarget.value as UsersListInput["role"] })}>
            <option value="all">全部角色</option>
            {userRoleOptions.map((role) => <option key={role} value={role}>{userRoleLabels[role]}</option>)}
          </Select>
          <Select aria-label="状态筛选" value={filters.status} onChange={(event) => updateUrl({ ...filters, status: event.currentTarget.value as UsersListInput["status"] })}>
            <option value="all">全部状态</option>
            {userStatusOptions.map((status) => <option key={status} value={status}>{userStatusLabels[status]}</option>)}
          </Select>
          <Button variant="secondary" icon={<Search size={16} />} onClick={applyFilters}>筛选</Button>
        </FilterBar>
        {statusError ? <Alert tone="danger">{statusError}</Alert> : null}
        {selectedIds.size > 0 ? (
          <section className="usersBatchBar" aria-label="批量操作">
            <div className="usersBatchSummary"><UsersRound aria-hidden="true" size={17} /><strong>已选择 {selectedIds.size} 个用户</strong><span>逐项执行并汇总结果</span></div>
            <div className="usersBatchActions">
              <Button variant="secondary" icon={<UserRoundCog size={16} />} disabled={statusLoading} onClick={() => setGroupManagerOpen(true)}>批量归组</Button>
              <Button variant="secondary" icon={<UserCheck size={16} />} disabled={statusLoading} onClick={() => setStatusIntent({ userIds: [...selectedIds], names: [], status: "active" })}>批量启用</Button>
              <Button variant="danger" icon={<UserRoundX size={16} />} disabled={statusLoading} onClick={() => setStatusIntent({ userIds: [...selectedIds], names: [], status: "disabled" })}>批量停用</Button>
              <Button variant="ghost" disabled={statusLoading} onClick={() => setSelectedIds(new Set())}>取消选择</Button>
            </div>
          </section>
        ) : null}
        <DataTable
          rows={allRows}
          columns={columns}
          getRowId={(row) => row.id}
          ariaLabel="用户列表"
          loading={state.loading}
          error={state.error || undefined}
          onRetry={() => void state.reload()}
          emptyState="暂无匹配的用户"
          onRowClick={setDetailRow}
          getRowAriaLabel={(row) => `查看用户 ${row.name} 详情`}
          manualPagination
          page={page}
          pageSize={pageSize}
          totalRows={total}
          onPageChange={(nextPage) => updateUrl(filters, nextPage)}
          onPageSizeChange={(nextSize) => updateUrl(filters, 1, nextSize)}
        />
      </section>
      <UserFormDrawer
        open={drawerOpen}
        mode={drawerMode}
        initialValue={form}
        actorIsRoot={canUseRootRole}
        loading={saving}
        pricingGroups={pricingGroupsState.groups}
        pricingGroupsLoading={pricingGroupsState.loading || Boolean(pricingGroupsState.error)}
        submitError={formError}
        onClose={closeDrawer}
        onSubmit={submit}
      />
      <PricingGroupManagerDrawer
        open={groupManagerOpen}
        groups={pricingGroupsState.groups}
        loading={pricingGroupsState.loading}
        error={pricingGroupsState.error}
        selectedUserIds={[...selectedIds]}
        onClose={() => setGroupManagerOpen(false)}
        onReload={pricingGroupsState.reload}
        onUsersAssigned={async () => {
          setSelectedIds(new Set());
          setDetailRow(null);
          await state.reload();
        }}
      />
      <ChangeOwnerTenantDialog
        open={Boolean(ownerTenantIntent)}
        userId={ownerTenantIntent?.numericId ?? null}
        userName={ownerTenantIntent?.name}
        tenants={tenantOptions}
        onClose={() => setOwnerTenantIntent(null)}
        onChanged={async () => {
          await state.reload();
        }}
      />
      <Drawer
        open={Boolean(detailRow)}
        title={detailRow?.name || "用户详情"}
        description={detailRow ? `${detailRow.roleLabel} · ${detailRow.accountTypeLabel}` : undefined}
        size="min(620px, 100vw)"
        onOpenChange={(open) => { if (!open) setDetailRow(null); }}
        footer={detailRow ? (
          <div className="usersDrawerActions">
            <Button variant="secondary" icon={<Edit3 size={16} />} onClick={() => openEdit(detailRow)}>编辑资料</Button>
            <Button variant="secondary" icon={<Building2 size={16} />} onClick={() => { setOwnerTenantIntent(detailRow); setDetailRow(null); }}>修改所属租户</Button>
            {detailRow.status === "disabled" ? (
              <Button icon={<UserCheck size={16} />} disabled={statusLoading} onClick={() => setStatusIntent({ userIds: [detailRow.numericId], names: [detailRow.name], status: "active" })}>启用账户</Button>
            ) : (
              <Button variant="danger" icon={<UserRoundX size={16} />} disabled={statusLoading} onClick={() => setStatusIntent({ userIds: [detailRow.numericId], names: [detailRow.name], status: "disabled" })}>停用账户</Button>
            )}
          </div>
        ) : undefined}
      >
        {detailRow ? (
          <div className="usersDetailSections">
            <Section title="身份与权限">
              <DescriptionList className="usersDetailList" items={[
                { label: "用户 ID", value: detailRow.numericId },
                { label: "用户名", value: detailRow.source.name },
                { label: "邮箱", value: detailRow.source.email || "-" },
                { label: "角色", value: detailRow.roleLabel },
                { label: "状态", value: <Badge tone={statusTone(detailRow.status)}>{userStatusLabels[detailRow.status as keyof typeof userStatusLabels] || detailRow.status}</Badge> },
                { label: "最近登录", value: formatDate(detailRow.source.lastLoginAt) },
                { label: "创建时间", value: detailRow.createdAt },
              ]} />
            </Section>
            <Section title="租户归属">
              <DescriptionList className="usersDetailList" items={[
                { label: "注册租户", value: `${tenantNameById.get(detailRow.registeredTenantId) || detailRow.registeredTenantId}（不可修改）` },
                { label: "注册入口", value: detailRow.registrationHostname || "历史数据未记录" },
                { label: "当前所属租户", value: tenantNameById.get(detailRow.ownerTenantId) || detailRow.ownerTenantId },
                { label: "全局余额", value: formatGu(detailRow.source.billing?.balanceGu ?? detailRow.source.billing?.balanceGu) },
              ]} />
            </Section>
            <Section title="工作区与商业身份">
              <DescriptionList className="usersDetailList" items={[
                { label: "当前工作区", value: detailRow.workspace },
                { label: "拥有工作区", value: Number(detailRow.source.team?.ownedWorkspaceCount || 0).toLocaleString("zh-CN") },
                { label: "加入工作区", value: Number(detailRow.source.team?.joinedWorkspaceCount || 0).toLocaleString("zh-CN") },
                { label: "团队成员", value: Number(detailRow.source.team?.memberCount || 0).toLocaleString("zh-CN") },
                { label: "账户类型", value: detailRow.accountTypeLabel },
                { label: "认证状态", value: detailRow.source.verification?.statusText || "未认证" },
                { label: "认证主体", value: detailRow.source.verification?.subjectName || "-" },
              ]} />
            </Section>
            <Section title="计费上下文">
              <DescriptionList className="usersDetailList" items={[
                { label: "套餐", value: detailRow.source.billing?.planName || detailRow.source.billing?.planId || "-" },
                { label: "定价分组", value: pricingGroupNames.get(detailRow.pricingGroup) && pricingGroupNames.get(detailRow.pricingGroup) !== detailRow.pricingGroup ? `${pricingGroupNames.get(detailRow.pricingGroup)} · ${detailRow.pricingGroup}` : detailRow.pricingGroup },
                { label: "计费模式", value: billingModeLabels[(detailRow.source.billing?.billingMode === "postpaid" || detailRow.source.billing?.billingMode === "hybrid") ? detailRow.source.billing.billingMode : "prepaid"] },
                { label: "余额", value: formatGu(detailRow.source.billing?.balanceGu) },
                { label: "信用额度", value: formatGu(detailRow.source.billing?.creditLimitGu) },
                { label: "冻结额度", value: formatGu(detailRow.source.billing?.reservedGu) },
                { label: "结算方式", value: settlementTypeLabels[(detailRow.source.commercial?.settlementType === "offline" || detailRow.source.commercial?.settlementType === "contract") ? detailRow.source.commercial.settlementType : "online"] },
              ]} />
            </Section>
          </div>
        ) : null}
      </Drawer>
      <ConfirmDialog
        open={Boolean(statusIntent)}
        title={statusIntent?.status === "disabled" ? `停用 ${statusIntent.userIds.length} 个用户？` : `启用 ${statusIntent?.userIds.length || 0} 个用户？`}
        description={statusIntent?.status === "disabled"
          ? `${statusIntent.names.length ? `用户「${statusIntent.names.join("、")}」` : "所选用户"}将无法继续登录。Root 管理限制和至少保留一个 Root 的规则仍由后端强制执行。`
          : `${statusIntent?.names.length ? `用户「${statusIntent.names.join("、")}」` : "所选用户"}将恢复为可登录状态，角色和商业配置保持不变。`}
        confirmLabel={statusIntent?.status === "disabled" ? "确认停用" : "确认启用"}
        tone={statusIntent?.status === "disabled" ? "danger" : "default"}
        loading={statusLoading}
        onCancel={() => { if (!statusLoading) setStatusIntent(null); }}
        onConfirm={runStatusUpdate}
        onConfirmError={(caught) => setStatusError(toApiErrorView(caught).message)}
      />
      <ConfirmDialog
        open={Boolean(pendingDangerForm)}
        title={`停用用户「${editingRow?.name || ""}」？`}
        description="保存后该用户将无法继续登录。用户资料、工作区关系和审计记录会保留，可由管理员重新启用。"
        confirmLabel="停用并保存"
        tone="danger"
        loading={saving}
        onCancel={() => { if (!saving) setPendingDangerForm(null); }}
        onConfirm={async () => { if (pendingDangerForm) await persistForm(pendingDangerForm); }}
        onConfirmError={(caught) => setFormError(toApiErrorView(caught).message)}
      />
    </ConsolePage>
  );
}
