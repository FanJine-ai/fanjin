import { useCallback, useEffect, useMemo, useState } from "react";
import { Archive, Building2, DownloadCloud, PauseCircle, PlayCircle, Plus, RefreshCcw } from "lucide-react";

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
  archiveTenant,
  createTenant,
  fetchTenantBrand,
  fetchTenantDirectory,
  importTenantDirectory,
  resumeTenant,
  suspendTenant,
  updateTenantBrand,
  type TenantDirectoryEntry,
  type TenantLifecycleBlocker,
} from "./api";

const statusLabels: Record<string, string> = {
  draft: "草稿",
  active: "生效中",
  suspended: "已暂停",
  archived: "已归档",
};

function statusTone(status: string): BadgeTone {
  if (status === "active") return "success";
  if (status === "suspended") return "warning";
  if (status === "archived") return "neutral";
  return "info";
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

interface TenantRow {
  id: string;
  name: string;
  operatorName: string;
  status: string;
  statusLabel: string;
  rechargeEnabled: string;
  wholesaleRatePpm: string;
  configRevision: number;
  updatedAt: string;
  source: TenantDirectoryEntry;
}

export default function TenantDirectoryPage() {
  const { toast } = useToast();
  const [items, setItems] = useState<TenantDirectoryEntry[]>([]);
  const [mode, setMode] = useState("env");
  const [diff, setDiff] = useState<{ dbOnly: string[]; envOnly: string[] }>({ dbOnly: [], envOnly: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [busyAction, setBusyAction] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState({ tenantId: "", name: "", operatorName: "" });
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState("");
  const [lifecycleIntent, setLifecycleIntent] = useState<{ action: "suspend" | "resume" | "archive"; tenant: TenantDirectoryEntry } | null>(null);
  const [lifecycleReason, setLifecycleReason] = useState("");
  const [lifecycleError, setLifecycleError] = useState("");
  const [blockers, setBlockers] = useState<TenantLifecycleBlocker[] | null>(null);
  const [brandTenant, setBrandTenant] = useState<TenantDirectoryEntry | null>(null);
  const [brand, setBrand] = useState({ theme: "", logoUrl: "", customerServiceEmail: "", customerServiceUrl: "", agreementVersion: "", alertContacts: "" });
  const [brandBusy, setBrandBusy] = useState(false);
  const [brandError, setBrandError] = useState("");

  const reload = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const payload = await fetchTenantDirectory();
      setItems(payload.items || []);
      setMode(payload.mode || "env");
      setDiff(payload.diff || { dbOnly: [], envOnly: [] });
    } catch (caught) {
      setError(toApiErrorView(caught).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const openBrand = useCallback(async (tenant: TenantDirectoryEntry) => {
    setBrandTenant(tenant);
    setBrandError("");
    try {
      const payload = await fetchTenantBrand(tenant.id);
      setBrand({
        theme: payload.brand.theme || "",
        logoUrl: payload.brand.logoUrl || "",
        customerServiceEmail: payload.brand.customerServiceEmail || "",
        customerServiceUrl: payload.brand.customerServiceUrl || "",
        agreementVersion: payload.brand.agreementVersion || "",
        alertContacts: (payload.brand.alertContacts || []).join(", "),
      });
    } catch (caught) {
      setBrandError(toApiErrorView(caught).message);
    }
  }, []);

  const rows = useMemo<TenantRow[]>(() => items.map((tenant) => ({
    id: tenant.id,
    name: tenant.name,
    operatorName: tenant.operatorName,
    status: tenant.status,
    statusLabel: statusLabels[tenant.status] || tenant.status,
    rechargeEnabled: tenant.rechargeEnabled ? "开放" : "关闭",
    wholesaleRatePpm: `${(Number(tenant.wholesaleRatePpm) / 10_000).toFixed(2)}%`,
    configRevision: Number(tenant.configRevision || 1),
    updatedAt: formatDate(tenant.updatedAt),
    source: tenant,
  })), [items]);

  const columns = useMemo<DataTableColumn<TenantRow>[]>(() => [
    {
      id: "tenant",
      header: "商业租户",
      priority: "primary",
      sortable: true,
      sortValue: (row) => row.id,
      cell: (row) => (
        <div className="adminUsersNameCell">
          <strong>{row.name}</strong>
          <span>{row.id} · {row.operatorName}</span>
        </div>
      ),
    },
    {
      id: "status",
      header: "状态",
      priority: "primary",
      cell: (row) => <Badge tone={statusTone(row.status)}>{row.statusLabel}</Badge>,
      sortValue: (row) => row.status,
    },
    { id: "recharge", header: "充值", priority: "secondary", accessor: "rechargeEnabled" },
    { id: "rate", header: "批发结算率", priority: "secondary", accessor: "wholesaleRatePpm", sortable: true, sortValue: (row) => row.source.wholesaleRatePpm },
    { id: "revision", header: "配置版本", priority: "detail", accessor: "configRevision", sortable: true },
    { id: "updatedAt", header: "更新时间", priority: "detail", accessor: "updatedAt", sortable: true },
    {
      id: "actions",
      header: "操作",
      priority: "primary",
      hideable: false,
      width: "260px",
      cell: (row) => (
        <div className="usersDrawerActions">
          <Button variant="secondary" size="compact" icon={<Building2 size={14} />} onClick={() => void openBrand(row.source)}>品牌</Button>
          {row.status === "active" && row.id !== "FANJIN" ? (
            <Button variant="secondary" size="compact" icon={<PauseCircle size={14} />} onClick={() => { setLifecycleIntent({ action: "suspend", tenant: row.source }); setLifecycleReason(""); setLifecycleError(""); setBlockers(null); }}>暂停</Button>
          ) : null}
          {row.status === "suspended" ? (
            <Button variant="secondary" size="compact" icon={<PlayCircle size={14} />} onClick={() => { setLifecycleIntent({ action: "resume", tenant: row.source }); setLifecycleReason(""); setLifecycleError(""); setBlockers(null); }}>恢复</Button>
          ) : null}
          {row.status !== "archived" && row.id !== "FANJIN" ? (
            <Button variant="danger" size="compact" icon={<Archive size={14} />} onClick={() => { setLifecycleIntent({ action: "archive", tenant: row.source }); setLifecycleReason(""); setLifecycleError(""); setBlockers(null); }}>归档</Button>
          ) : null}
        </div>
      ),
    },
  ], [openBrand]);

  async function submitCreate() {
    if (!createForm.tenantId.trim() || !createForm.name.trim() || !createForm.operatorName.trim()) {
      setCreateError("租户 ID、名称与运营主体均必填。");
      return;
    }
    setCreateBusy(true);
    setCreateError("");
    try {
      await createTenant({
        tenantId: createForm.tenantId.trim().toUpperCase(),
        name: createForm.name.trim(),
        operatorName: createForm.operatorName.trim(),
      });
      toast({ title: "租户已创建", message: "草稿状态，可在域名管理页登记域名。", tone: "success" });
      setCreateOpen(false);
      setCreateForm({ tenantId: "", name: "", operatorName: "" });
      await reload();
    } catch (caught) {
      setCreateError(toApiErrorView(caught).message);
    } finally {
      setCreateBusy(false);
    }
  }

  async function runLifecycle() {
    if (!lifecycleIntent) return;
    const reason = lifecycleReason.trim();
    if (reason.length < 5) {
      setLifecycleError("原因必填（至少 5 字符）。");
      return;
    }
    setBusyAction(lifecycleIntent.action);
    setLifecycleError("");
    try {
      const input = { tenantId: lifecycleIntent.tenant.id, expectedRevision: Number(lifecycleIntent.tenant.configRevision), reason };
      if (lifecycleIntent.action === "suspend") {
        const result = await suspendTenant(input);
        toast({ title: "租户已暂停", message: `联动暂停 ${result.domainsSuspended} 个域名入口，充值已关闭。`, tone: "success" });
      } else if (lifecycleIntent.action === "resume") {
        await resumeTenant(input);
        toast({ title: "租户已恢复", message: "域名入口需在域名管理页单独恢复。", tone: "success" });
      } else {
        const result = await archiveTenant(input);
        setBlockers(result.blockers || []);
        toast({ title: "租户已归档", message: "退租完成；全局用户数据已保留。", tone: "success" });
      }
      setLifecycleIntent(null);
      await reload();
    } catch (caught) {
      setLifecycleError(toApiErrorView(caught).message);
    } finally {
      setBusyAction("");
    }
  }

  async function submitBrand() {
    if (!brandTenant) return;
    setBrandBusy(true);
    setBrandError("");
    try {
      const contacts = brand.alertContacts
        .split(/[,，\s]+/)
        .map((item) => item.trim())
        .filter(Boolean);
      await updateTenantBrand({
        tenantId: brandTenant.id,
        expectedRevision: Number(brandTenant.configRevision),
        theme: brand.theme.trim() || null,
        logoUrl: brand.logoUrl.trim() || null,
        customerServiceEmail: brand.customerServiceEmail.trim() || null,
        customerServiceUrl: brand.customerServiceUrl.trim() || null,
        agreementVersion: brand.agreementVersion.trim() || null,
        alertContacts: contacts,
      });
      toast({ title: "品牌配置已更新", message: brandTenant.id, tone: "success" });
      setBrandTenant(null);
      await reload();
    } catch (caught) {
      setBrandError(toApiErrorView(caught).message);
    } finally {
      setBrandBusy(false);
    }
  }

  async function runImport() {
    setBusyAction("import");
    setError("");
    try {
      const report = await importTenantDirectory();
      toast({
        title: "环境导入完成",
        message: `新增 ${report.created.length}，更新 ${report.updated.length}，未变 ${report.unchanged.length}`,
        tone: "success",
      });
      await reload();
    } catch (caught) {
      setError(toApiErrorView(caught).message);
    } finally {
      setBusyAction("");
    }
  }

  const activeCount = rows.filter((row) => row.status === "active").length;
  const suspendedCount = rows.filter((row) => row.status === "suspended").length;

  return (
    <ConsolePage
      title="租户目录"
      description="商业租户数据库目录：创建、生命周期（暂停/恢复/退租归档）、品牌与告警联系人配置。"
      primaryAction={
        <div className="usersPageActions">
          <Button variant="secondary" icon={<RefreshCcw size={16} />} loading={loading} onClick={() => void reload()}>刷新</Button>
          <Button variant="secondary" icon={<DownloadCloud size={16} />} loading={busyAction === "import"} onClick={() => void runImport()}>环境导入</Button>
          <Button icon={<Plus size={18} />} onClick={() => setCreateOpen(true)}>创建租户</Button>
        </div>
      }
      layoutWidth="dashboard"
    >
      {error ? <Alert tone="danger" title="目录读取失败">{error}</Alert> : null}
      <MetricStrip metrics={[
        { id: "mode", label: "目录模式", value: mode === "db" ? "数据库权威" : "环境变量（兼容）", hint: "FANJIN_TENANT_DIRECTORY_MODE" },
        { id: "total", label: "租户总数", value: String(rows.length) },
        { id: "active", label: "生效中", value: String(activeCount), tone: "positive" },
        { id: "suspended", label: "已暂停", value: String(suspendedCount), tone: "warning" },
      ]} />
      {diff.dbOnly.length || diff.envOnly.length ? (
        <Alert tone="info" title="双读差异">
          仅数据库：{diff.dbOnly.join("、") || "无"}；仅环境变量：{diff.envOnly.join("、") || "无"}
        </Alert>
      ) : null}
      <DataTable
        rows={rows}
        columns={columns}
        getRowId={(row) => row.id}
        ariaLabel="商业租户目录"
        loading={loading}
        emptyState="暂无租户，可从环境变量导入或手动创建"
      />

      <Drawer
        open={Boolean(lifecycleIntent)}
        title={lifecycleIntent ? `${lifecycleIntent.action === "suspend" ? "暂停" : lifecycleIntent.action === "resume" ? "恢复" : "归档（退租）"} ${lifecycleIntent.tenant.name}` : ""}
        description={lifecycleIntent ? `${lifecycleIntent.tenant.id} · 当前版本 ${lifecycleIntent.tenant.configRevision}` : undefined}
        size="min(560px, 100vw)"
        onOpenChange={(open) => { if (!open && !busyAction) setLifecycleIntent(null); }}
        footer={
          <>
            <Button variant="ghost" disabled={busyAction !== ""} onClick={() => setLifecycleIntent(null)}>取消</Button>
            <Button
              variant={lifecycleIntent?.action === "archive" ? "danger" : "primary"}
              loading={busyAction !== ""}
              disabled={busyAction !== "" || lifecycleReason.trim().length < 5}
              onClick={() => void runLifecycle()}
            >
              确认{lifecycleIntent?.action === "suspend" ? "暂停" : lifecycleIntent?.action === "resume" ? "恢复" : "归档"}
            </Button>
          </>
        }
      >
        {lifecycleError ? <Alert tone="danger">{lifecycleError}</Alert> : null}
        {blockers?.length ? (
          <Alert tone="warning" title="归档阻断项">
            {blockers.map((blocker) => `${blocker.code}：${blocker.detail}（${blocker.count}）`).join("；")}
          </Alert>
        ) : null}
        {lifecycleIntent?.action === "suspend" ? (
          <Alert tone="warning" title="暂停影响">
            充值立即关闭，全部生效域名入口联动暂停（可恢复）；用户账号、数据与全局余额不受影响。
          </Alert>
        ) : null}
        {lifecycleIntent?.action === "archive" ? (
          <Alert tone="danger" title="退租归档">
            归档前依赖检查：需无生效域名、无未关账账期、无未消费现金 GU 批次。归档后禁止新增域名与收款；全局用户数据永不删除。
          </Alert>
        ) : null}
        <FormField label="操作原因" required help="至少 5 字符，写入不可变审计记录。">
          <textarea
            rows={3}
            maxLength={500}
            aria-label="操作原因"
            placeholder="例如：合作暂停一个周期 / 财务确认后的退租归档"
            value={lifecycleReason}
            onChange={(event) => setLifecycleReason(event.target.value)}
          />
        </FormField>
      </Drawer>

      <Drawer
        open={Boolean(brandTenant)}
        title={brandTenant ? `品牌与告警 · ${brandTenant.name}` : ""}
        description={brandTenant ? `${brandTenant.id} · 配置版本 ${brandTenant.configRevision}` : undefined}
        size="min(620px, 100vw)"
        onOpenChange={(open) => { if (!open && !brandBusy) setBrandTenant(null); }}
        footer={
          <>
            <Button variant="ghost" disabled={brandBusy} onClick={() => setBrandTenant(null)}>取消</Button>
            <Button loading={brandBusy} disabled={brandBusy} onClick={() => void submitBrand()}>保存品牌配置</Button>
          </>
        }
      >
        {brandError ? <Alert tone="danger">{brandError}</Alert> : null}
        <FieldGroup variant="section" legend="品牌配置">
          <FormField label="主题标识">
            <Input aria-label="主题标识" value={brand.theme} onChange={(event) => setBrand((current) => ({ ...current, theme: event.currentTarget.value }))} />
          </FormField>
          <FormField label="Logo URL">
            <Input aria-label="Logo URL" value={brand.logoUrl} onChange={(event) => setBrand((current) => ({ ...current, logoUrl: event.currentTarget.value }))} />
          </FormField>
          <FormField label="客服邮箱">
            <Input aria-label="客服邮箱" value={brand.customerServiceEmail} onChange={(event) => setBrand((current) => ({ ...current, customerServiceEmail: event.currentTarget.value }))} />
          </FormField>
          <FormField label="客服链接">
            <Input aria-label="客服链接" value={brand.customerServiceUrl} onChange={(event) => setBrand((current) => ({ ...current, customerServiceUrl: event.currentTarget.value }))} />
          </FormField>
          <FormField label="协议版本">
            <Input aria-label="协议版本" value={brand.agreementVersion} onChange={(event) => setBrand((current) => ({ ...current, agreementVersion: event.currentTarget.value }))} />
          </FormField>
        </FieldGroup>
        <FieldGroup variant="section" legend="告警联系人" description="证书到期/入口异常/账期告警的接收邮箱，逗号分隔，最多 10 个。">
          <FormField label="邮箱列表">
            <Input aria-label="告警联系人邮箱" placeholder="ops@example.cn, finance@example.cn" value={brand.alertContacts} onChange={(event) => setBrand((current) => ({ ...current, alertContacts: event.currentTarget.value }))} />
          </FormField>
        </FieldGroup>
      </Drawer>

      <Drawer
        open={createOpen}
        title="创建商业租户"
        description="创建后进入草稿状态，需在域名管理页完成域名登记与验证"
        size="min(560px, 100vw)"
        onOpenChange={(open) => { if (!open && !createBusy) setCreateOpen(false); }}
        footer={
          <>
            <Button variant="ghost" disabled={createBusy} onClick={() => setCreateOpen(false)}>取消</Button>
            <Button icon={<Plus size={16} />} loading={createBusy} disabled={createBusy} onClick={() => void submitCreate()}>创建</Button>
          </>
        }
      >
        {createError ? <Alert tone="danger">{createError}</Alert> : null}
        <FieldGroup variant="section" legend="基本信息">
          <FormField label="租户 ID" required help="大写字母开头，2-64 字符（A-Z 0-9 _ -），创建后不可修改。">
            <Input aria-label="租户 ID" placeholder="NEWCO" value={createForm.tenantId} onChange={(event) => setCreateForm((current) => ({ ...current, tenantId: event.currentTarget.value.toUpperCase() }))} />
          </FormField>
          <FormField label="租户名称" required>
            <Input aria-label="租户名称" value={createForm.name} onChange={(event) => setCreateForm((current) => ({ ...current, name: event.currentTarget.value }))} />
          </FormField>
          <FormField label="运营主体" required>
            <Input aria-label="运营主体" value={createForm.operatorName} onChange={(event) => setCreateForm((current) => ({ ...current, operatorName: event.currentTarget.value }))} />
          </FormField>
        </FieldGroup>
      </Drawer>
    </ConsolePage>
  );
}
