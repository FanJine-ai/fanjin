import { useCallback, useEffect, useMemo, useState } from "react";
import { Globe2, Plus, RefreshCcw, ShieldCheck } from "lucide-react";

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
import { useFinanceQuery } from "../finance/hooks";
import { listCommercialTenants } from "../commercial-tenants/api";
import {
  bindDomainCertificate,
  checkDomainVerification,
  createTenantDomain,
  deleteTenantDomain,
  fetchTenantDomain,
  listTenantCertificates,
  listTenantDomains,
  preflightTenantDomain,
  publishTenantDomain,
  restoreTenantDomain,
  startDomainVerification,
  suspendTenantDomain,
  updateDomainIcpState,
  type DomainDetailPayload,
  type DomainPreflightPayload,
  type TenantDomainRecord,
} from "./api";

const lifecycleLabels: Record<string, string> = {
  draft: "草稿",
  ownership_pending: "待所有权验证",
  verified: "已验证",
  certificate_pending: "待证书",
  ready: "可发布",
  activating: "激活中",
  active: "已生效",
  expiring: "证书临期",
  suspending: "暂停中",
  suspended: "已暂停",
  failed: "失败",
  archived: "已归档",
};

const icpLabels: Record<string, string> = {
  not_required: "无需备案",
  pending: "备案中",
  verified: "备案已核验",
  rejected: "备案驳回",
  unknown: "未录入",
};

function lifecycleTone(state: string): BadgeTone {
  if (state === "active") return "success";
  if (state === "failed") return "danger";
  if (["ownership_pending", "certificate_pending", "suspending", "expiring"].includes(state)) return "warning";
  if (state === "suspended" || state === "archived") return "neutral";
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

interface DomainRow {
  id: string;
  hostname: string;
  tenantId: string;
  tenantName: string;
  lifecycleState: string;
  lifecycleLabel: string;
  icpState: string;
  ownershipState: string;
  certificateBound: boolean;
  updatedAt: string;
  source: TenantDomainRecord;
}

export default function TenantDomainsPage() {
  const { toast } = useToast();
  const tenantQuery = useFinanceQuery(listCommercialTenants, "tenant-domains-tenants", { items: [] });
  const tenantOptions = useMemo(
    () => (tenantQuery.data?.items || []).map((tenant: { id: string; name: string }) => ({ id: tenant.id, name: tenant.name })),
    [tenantQuery.data],
  );
  const [tenantFilter, setTenantFilter] = useState("all");
  const [domains, setDomains] = useState<TenantDomainRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [detail, setDetail] = useState<DomainDetailPayload | null>(null);
  const [preflight, setPreflight] = useState<DomainPreflightPayload | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState({ tenantId: "", hostname: "", purpose: "web_api", isPrimary: false });
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState("");
  const [busyAction, setBusyAction] = useState("");
  const [verificationToken, setVerificationToken] = useState<{ recordName: string; token: string } | null>(null);
  const [certificates, setCertificates] = useState<Array<{ id: string; commonName: string | null; status: string; notAfter: number | null }>>([]);
  const [selectedCertId, setSelectedCertId] = useState("");

  const reload = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const payload = await listTenantDomains(tenantFilter === "all" ? {} : { tenantId: tenantFilter });
      setDomains(payload.items || []);
    } catch (caught) {
      setError(toApiErrorView(caught).message);
    } finally {
      setLoading(false);
    }
  }, [tenantFilter]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const openDetail = useCallback(async (domainId: string) => {
    setError("");
    try {
      const payload = await fetchTenantDomain(domainId);
      setDetail(payload);
      setPreflight(null);
      setVerificationToken(null);
      const certPayload = await listTenantCertificates(payload.domain.tenantId);
      setCertificates(certPayload.items || []);
      setSelectedCertId(payload.domain.certificateId || "");
    } catch (caught) {
      setError(toApiErrorView(caught).message);
    }
  }, []);

  const rows = useMemo<DomainRow[]>(() => domains.map((domain) => ({
    id: domain.id,
    hostname: domain.hostname,
    tenantId: domain.tenantId,
    tenantName: tenantOptions.find((tenant) => tenant.id === domain.tenantId)?.name || domain.tenantId,
    lifecycleState: domain.lifecycleState,
    lifecycleLabel: lifecycleLabels[domain.lifecycleState] || domain.lifecycleState,
    icpState: domain.icpState,
    ownershipState: domain.ownershipState,
    certificateBound: Boolean(domain.certificateId),
    updatedAt: formatDate(domain.updatedAt),
    source: domain,
  })), [domains, tenantOptions]);

  const columns = useMemo<DataTableColumn<DomainRow>[]>(() => [
    {
      id: "hostname",
      header: "域名",
      priority: "primary",
      sortable: true,
      cell: (row) => (
        <div className="adminUsersNameCell">
          <strong>{row.hostname}</strong>
          <span>{row.tenantName} · {row.tenantId}{row.source.isPrimary ? " · 主域名" : ""}</span>
        </div>
      ),
      sortValue: (row) => row.hostname,
    },
    {
      id: "lifecycle",
      header: "生命周期",
      priority: "primary",
      cell: (row) => <Badge tone={lifecycleTone(row.lifecycleState)}>{row.lifecycleLabel}</Badge>,
      sortValue: (row) => row.lifecycleState,
    },
    { id: "ownership", header: "所有权", priority: "secondary", cell: (row) => <Badge tone={row.ownershipState === "verified" ? "success" : "warning"}>{row.ownershipState === "verified" ? "已验证" : "待验证"}</Badge> },
    { id: "icp", header: "备案门禁", priority: "secondary", cell: (row) => icpLabels[row.icpState] || row.icpState, sortValue: (row) => row.icpState },
    { id: "certificate", header: "证书", priority: "secondary", cell: (row) => <Badge tone={row.certificateBound ? "success" : "neutral"}>{row.certificateBound ? "已绑定" : "未绑定"}</Badge> },
    { id: "revision", header: "期望/观测版本", priority: "detail", cell: (row) => `${row.source.desiredRevision} / ${row.source.observedRevision}` },
    { id: "updatedAt", header: "更新时间", priority: "detail", accessor: "updatedAt", sortable: true },
  ], []);

  async function runAction(name: string, action: () => Promise<unknown>, successTitle: string) {
    setBusyAction(name);
    setError("");
    try {
      await action();
      toast({ title: successTitle, tone: "success" });
      await reload();
      if (detail) await openDetail(detail.domain.id);
    } catch (caught) {
      setError(toApiErrorView(caught).message);
    } finally {
      setBusyAction("");
    }
  }

  async function submitCreate() {
    if (!createForm.tenantId || !createForm.hostname.trim()) {
      setCreateError("请选择租户并填写域名。");
      return;
    }
    setCreateBusy(true);
    setCreateError("");
    try {
      await createTenantDomain({
        tenantId: createForm.tenantId,
        hostname: createForm.hostname.trim(),
        purpose: createForm.purpose,
        isPrimary: createForm.isPrimary,
      });
      toast({ title: "域名已登记", message: "请按提示完成 TXT 所有权验证。", tone: "success" });
      setCreateOpen(false);
      setCreateForm({ tenantId: "", hostname: "", purpose: "web_api", isPrimary: false });
      await reload();
    } catch (caught) {
      setCreateError(toApiErrorView(caught).message);
    } finally {
      setCreateBusy(false);
    }
  }

  const activeCount = rows.filter((row) => row.lifecycleState === "active").length;
  const pendingVerification = rows.filter((row) => row.lifecycleState === "ownership_pending").length;

  return (
    <ConsolePage
      title="租户域名与证书"
      description="多租户入口控制面：域名登记、TXT 所有权验证、备案门禁、证书绑定与入口发布。"
      primaryAction={
        <div className="usersPageActions">
          <Button variant="secondary" icon={<RefreshCcw size={16} />} loading={loading} onClick={() => void reload()}>刷新</Button>
          <Button icon={<Plus size={18} />} onClick={() => setCreateOpen(true)}>登记域名</Button>
        </div>
      }
      layoutWidth="dashboard"
    >
      {error ? <Alert tone="danger" title="操作失败">{error}</Alert> : null}
      <MetricStrip metrics={[
        { id: "total", label: "域名总数", value: String(rows.length) },
        { id: "active", label: "生效中", value: String(activeCount), tone: "positive" },
        { id: "pending", label: "待验证", value: String(pendingVerification), tone: "warning" },
      ]} />
      <FilterBar>
        <Select aria-label="租户筛选" value={tenantFilter} onChange={(event) => setTenantFilter(event.currentTarget.value)}>
          <option value="all">全部租户</option>
          {tenantOptions.map((tenant) => <option key={tenant.id} value={tenant.id}>{tenant.name} · {tenant.id}</option>)}
        </Select>
      </FilterBar>
      <DataTable
        rows={rows}
        columns={columns}
        getRowId={(row) => row.id}
        ariaLabel="租户域名列表"
        loading={loading}
        error={tenantQuery.error || undefined}
        emptyState="暂无域名，点击右上角登记"
        onRowClick={(row) => void openDetail(row.id)}
        getRowAriaLabel={(row) => `查看域名 ${row.hostname} 详情`}
      />

      <Drawer
        open={Boolean(detail)}
        title={detail ? detail.domain.hostname : "域名详情"}
        description={detail ? `${detail.domain.tenantId} · ${lifecycleLabels[detail.domain.lifecycleState] || detail.domain.lifecycleState}` : undefined}
        size="min(720px, 100vw)"
        onOpenChange={(open) => { if (!open) setDetail(null); }}
      >
        {detail ? (
          <div className="usersDetailSections">
            <Section title="域名状态">
              <DescriptionList items={[
                { label: "生命周期", value: <Badge tone={lifecycleTone(detail.domain.lifecycleState)}>{lifecycleLabels[detail.domain.lifecycleState] || detail.domain.lifecycleState}</Badge> },
                { label: "所有权", value: detail.domain.ownershipState === "verified" ? `已验证 · ${formatDate(detail.domain.lastVerifiedAt)}` : "待验证" },
                { label: "备案门禁", value: icpLabels[detail.domain.icpState] || detail.domain.icpState },
                { label: "期望/观测版本", value: `${detail.domain.desiredRevision} / ${detail.domain.observedRevision}` },
                { label: "失败原因", value: detail.domain.failureMessage || "-" },
              ]} />
            </Section>
            <Section title="所有权验证（DNS TXT）">
              {verificationToken ? (
                <Alert tone="info" title="验证记录（令牌仅本次显示）">
                  <p>记录名：<code>{verificationToken.recordName}</code></p>
                  <p>记录值：<code>{verificationToken.token}</code></p>
                </Alert>
              ) : null}
              <div className="usersDrawerActions">
                <Button
                  variant="secondary"
                  icon={<Globe2 size={16} />}
                  disabled={busyAction === "verification"}
                  loading={busyAction === "verification"}
                  onClick={() => void runAction("verification", async () => {
                    const payload = await startDomainVerification(detail.domain.id);
                    setVerificationToken({ recordName: payload.recordName, token: payload.token });
                  }, "验证记录已生成")}
                >
                  生成验证记录
                </Button>
                <Button
                  variant="secondary"
                  icon={<ShieldCheck size={16} />}
                  disabled={busyAction === "check"}
                  loading={busyAction === "check"}
                  onClick={() => void runAction("check", () => checkDomainVerification(detail.domain.id), "已触发 TXT 检查")}
                >
                  检查验证结果
                </Button>
                <Select
                  aria-label="备案状态"
                  value={detail.domain.icpState}
                  onChange={(event) => void runAction("icp", () => updateDomainIcpState(detail.domain.id, event.currentTarget.value), "备案状态已更新")}
                >
                  {Object.entries(icpLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </Select>
              </div>
            </Section>
            <Section title="证书">
              <FilterBar>
                <Select aria-label="选择证书" value={selectedCertId} onChange={(event) => setSelectedCertId(event.currentTarget.value)}>
                  <option value="">选择要绑定的证书</option>
                  {certificates.map((certificate) => (
                    <option key={certificate.id} value={certificate.id}>
                      {certificate.commonName || certificate.id} · 到期 {formatDate(certificate.notAfter)}
                    </option>
                  ))}
                </Select>
                <Button
                  variant="secondary"
                  disabled={!selectedCertId || selectedCertId === detail.domain.certificateId || busyAction === "bind"}
                  loading={busyAction === "bind"}
                  onClick={() => void runAction("bind", () => bindDomainCertificate(detail.domain.id, selectedCertId), "证书已绑定")}
                >
                  绑定证书
                </Button>
              </FilterBar>
            </Section>
            <Section title="入口生命周期">
              {preflight ? (
                preflight.passed ? (
                  <Alert tone="success" title="预检通过">所有门禁检查均已通过，可以发布。</Alert>
                ) : (
                  <Alert tone="warning" title="预检阻断项">
                    {preflight.checks.filter((check) => !check.passed).map((check) => `${check.label}：${check.detail}`).join("；")}
                  </Alert>
                )
              ) : null}
              <div className="usersDrawerActions">
                <Button variant="secondary" disabled={busyAction === "preflight"} loading={busyAction === "preflight"} onClick={() => void runAction("preflight", async () => {
                  setPreflight(await preflightTenantDomain(detail.domain.id));
                }, "预检完成")}>预检</Button>
                <Button
                  icon={<ShieldCheck size={16} />}
                  disabled={busyAction === "publish"}
                  loading={busyAction === "publish"}
                  onClick={() => void runAction("publish", () => publishTenantDomain(detail.domain.id), "域名已发布")}
                >
                  发布
                </Button>
                <Button variant="secondary" disabled={busyAction === "suspend"} loading={busyAction === "suspend"} onClick={() => void runAction("suspend", () => suspendTenantDomain(detail.domain.id), "域名已暂停")}>暂停</Button>
                <Button variant="secondary" disabled={busyAction === "restore"} loading={busyAction === "restore"} onClick={() => void runAction("restore", () => restoreTenantDomain(detail.domain.id), "域名已恢复")}>恢复</Button>
                <Button variant="danger" disabled={busyAction === "delete"} loading={busyAction === "delete"} onClick={() => void runAction("delete", () => deleteTenantDomain(detail.domain.id), "域名已删除")}>删除</Button>
              </div>
            </Section>
          </div>
        ) : null}
      </Drawer>

      <Drawer
        open={createOpen}
        title="登记域名"
        description="登记后进入所有权验证（TXT）阶段"
        size="min(560px, 100vw)"
        onOpenChange={(open) => { if (!open && !createBusy) setCreateOpen(false); }}
        footer={
          <>
            <Button variant="ghost" disabled={createBusy} onClick={() => setCreateOpen(false)}>取消</Button>
            <Button icon={<Plus size={16} />} loading={createBusy} disabled={createBusy} onClick={() => void submitCreate()}>登记</Button>
          </>
        }
      >
        {createError ? <Alert tone="danger">{createError}</Alert> : null}
        <FieldGroup variant="section" legend="基本信息">
          <FormField label="所属租户" required>
            <Select aria-label="所属租户" value={createForm.tenantId} onChange={(event) => setCreateForm((current) => ({ ...current, tenantId: event.currentTarget.value }))}>
              <option value="">请选择租户</option>
              {tenantOptions.map((tenant) => <option key={tenant.id} value={tenant.id}>{tenant.name} · {tenant.id}</option>)}
            </Select>
          </FormField>
          <FormField label="域名" required help="仅域名本身；不接收 URL、端口、IP 或泛域名。">
            <Input aria-label="域名" placeholder="example.com" value={createForm.hostname} onChange={(event) => setCreateForm((current) => ({ ...current, hostname: event.currentTarget.value }))} />
          </FormField>
          <FormField label="用途">
            <Select aria-label="用途" value={createForm.purpose} onChange={(event) => setCreateForm((current) => ({ ...current, purpose: event.currentTarget.value }))}>
              <option value="web_api">网站 / API</option>
              <option value="auth">认证</option>
              <option value="callback">回调</option>
              <option value="media">媒体</option>
            </Select>
          </FormField>
        </FieldGroup>
      </Drawer>
    </ConsolePage>
  );
}
