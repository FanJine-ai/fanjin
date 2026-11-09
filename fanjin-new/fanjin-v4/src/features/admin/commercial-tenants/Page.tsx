import { useMemo, useRef, useState } from "react";
import { Building2, Landmark, RefreshCcw, ShieldCheck, WalletCards } from "lucide-react";
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
  FormField,
  Input,
  MetricStrip,
  useToast,
} from "../../../ui/console";
import { useFinanceQuery } from "../finance/hooks";
import { formatCny, formatDate, formatGu, yuanToMicros } from "../finance/utils";
import {
  creditTenantSettlement,
  listCommercialTenants,
  updateCommercialTenantLegalProfile,
} from "./api";
import type { CommercialTenantSummary, TenantSettlementLedger } from "./types";
import "./styles.css";

function rateLabel(ratePpm: number) {
  const value = Number(ratePpm);
  if (!Number.isFinite(value)) return "-";
  return `${(value / 10_000).toLocaleString("zh-CN", { maximumFractionDigits: 4 })}%`;
}

function ledgerTypeLabel(type: string) {
  const labels: Record<string, string> = {
    deposit: "结算金入金",
    wholesale_charge: "充值批发结算",
    refund: "退款返还",
  };
  return labels[type] || type || "未知流水";
}

function ledgerTone(row: TenantSettlementLedger) {
  return row.direction === "credit" ? "success" as const : "warning" as const;
}

function tenantState(tenant: CommercialTenantSummary) {
  if (!tenant.rechargeEnabled) return { label: "充值关闭", tone: "neutral" as const };
  if (tenant.settlementRequired && tenant.settlementAccount.status !== "active") {
    return { label: "结算停用", tone: "danger" as const };
  }
  if (tenant.settlementRequired && Number(tenant.settlementAccount.balanceMicros) <= 0) {
    return { label: "结算金不足", tone: "warning" as const };
  }
  return { label: "可充值", tone: "success" as const };
}

function settlementIdempotencyKey(tenantId: string) {
  const suffix = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `tenant-settlement:${tenantId}:${suffix}`;
}

export default function CommercialTenantsPage() {
  const { toast } = useToast();
  const query = useFinanceQuery(listCommercialTenants, "commercial-tenants", { items: [] });
  const tenants = query.data.items || [];
  const [detail, setDetail] = useState<CommercialTenantSummary | null>(null);
  const [crediting, setCrediting] = useState<CommercialTenantSummary | null>(null);
  const [amountYuan, setAmountYuan] = useState("");
  const [description, setDescription] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [legalEditing, setLegalEditing] = useState<CommercialTenantSummary | null>(null);
  const [legalForm, setLegalForm] = useState({
    icpNumber: "",
    valueAddedTelecomLicense: "",
    publicSecurityRegistration: "",
  });
  const [legalSaving, setLegalSaving] = useState(false);
  const [legalError, setLegalError] = useState("");
  const amountRef = useRef<HTMLInputElement>(null);
  const submittingRef = useRef(false);

  const totals = useMemo(() => tenants.reduce((result, tenant) => ({
    settlementMicros: result.settlementMicros + Number(tenant.settlementAccount.balanceMicros || 0),
    soldMicros: result.soldMicros + Number(tenant.lots.soldMicros || 0),
    rechargeEnabled: result.rechargeEnabled + (tenant.rechargeEnabled ? 1 : 0),
  }), { settlementMicros: 0, soldMicros: 0, rechargeEnabled: 0 }), [tenants]);

  function openCredit(tenant: CommercialTenantSummary) {
    setCrediting(tenant);
    setAmountYuan("");
    setDescription(`${tenant.name}结算金入金`);
    setIdempotencyKey(settlementIdempotencyKey(tenant.id));
    setFormError("");
    submittingRef.current = false;
  }

  async function submitCredit() {
    if (!crediting || submittingRef.current) return;
    const amountMicros = yuanToMicros(amountYuan);
    if (!amountMicros || amountMicros <= 0) {
      setFormError("请输入大于 0、最多 6 位小数的人民币金额。");
      return;
    }
    if (description.trim().length < 2) {
      setFormError("入金说明至少需要 2 个字符。");
      return;
    }
    submittingRef.current = true;
    setSaving(true);
    setFormError("");
    try {
      const result = await creditTenantSettlement({
        tenantId: crediting.id,
        amountMicros,
        idempotencyKey,
        description: description.trim(),
      });
      toast({
        title: result.idempotent ? "结算金入金已确认" : "结算金入金成功",
        message: `${crediting.name}当前结算余额为 ${formatCny(result.account.balanceMicros)}。`,
        tone: "success",
      });
      setCrediting(null);
      await query.reload();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "租户结算金入金失败");
    } finally {
      submittingRef.current = false;
      setSaving(false);
    }
  }

  function openLegalEditor(tenant: CommercialTenantSummary) {
    setLegalEditing(tenant);
    setLegalForm({
      icpNumber: tenant.icpNumber || "",
      valueAddedTelecomLicense: tenant.valueAddedTelecomLicense || "",
      publicSecurityRegistration: tenant.publicSecurityRegistration || "",
    });
    setLegalError("");
  }

  async function submitLegalProfile() {
    if (!legalEditing || legalSaving) return;
    setLegalSaving(true);
    setLegalError("");
    try {
      const result = await updateCommercialTenantLegalProfile({
        tenantId: legalEditing.id,
        expectedRevision: legalEditing.legalProfileRevision,
        icpNumber: legalForm.icpNumber.trim() || null,
        valueAddedTelecomLicense: legalForm.valueAddedTelecomLicense.trim() || null,
        publicSecurityRegistration: legalForm.publicSecurityRegistration.trim() || null,
      });
      const updated = {
        ...legalEditing,
        icpNumber: result.icpNumber,
        valueAddedTelecomLicense: result.valueAddedTelecomLicense,
        publicSecurityRegistration: result.publicSecurityRegistration,
        legalProfileRevision: result.revision,
        legalProfileUpdatedAt: result.updatedAt,
        configurationSource: result.configurationSource,
      };
      setDetail((current) => current?.id === updated.id ? updated : current);
      setLegalEditing(null);
      toast({
        title: "合规资料已保存",
        message: "数据库记录将跨版本升级保留，前台不再使用构建占位值。",
        tone: "success",
      });
      await query.reload();
    } catch (error) {
      setLegalError(error instanceof Error ? error.message : "合规资料保存失败");
    } finally {
      setLegalSaving(false);
    }
  }

  return (
    <ConsolePage
      className="commercialTenantsPage"
      breadcrumbs={[{ label: "平台管理" }, { label: "商业租户" }]}
      title="商业租户"
      description="管理繁境、器灵及后续合作主体的充值状态、批发结算金和 GU 销售批次；用户业务数据仍保持全局互通。"
      primaryAction={(
        <Button variant="secondary" icon={<RefreshCcw size={17} />} loading={query.loading} onClick={() => void query.reload()}>
          刷新
        </Button>
      )}
      layoutWidth="dashboard"
    >
      <Alert tone="info" title="0.1.0 商业边界">
        当前访问域名只决定新充值的收款主体。用户账号、工作区、项目、素材和全局 GU 可跨租户使用；租户域名、法律信息和支付资料由部署配置维护，结算金变更需要管理员二次验证并写入审计流水。
      </Alert>

      <MetricStrip metrics={[
        { id: "tenants", label: "已登记租户", value: query.loading ? "-" : tenants.length.toLocaleString(), hint: "包含平台默认主体" },
        { id: "enabled", label: "开放充值", value: query.loading ? "-" : totals.rechargeEnabled.toLocaleString(), hint: `${Math.max(0, tenants.length - totals.rechargeEnabled)} 个入口关闭` },
        { id: "settlement", label: "租户结算金", value: query.loading ? "-" : formatCny(totals.settlementMicros), hint: "外部租户可用结算余额", tone: totals.settlementMicros > 0 ? "positive" : "neutral" },
        { id: "sold", label: "累计销售 GU", value: query.loading ? "-" : formatGu(totals.soldMicros), hint: "按原销售租户追溯" },
      ]} />

      <section className="commercialTenantsData" aria-label="商业租户数据">
        <DataTable<CommercialTenantSummary>
          className="commercialTenantsTable"
          ariaLabel="商业租户列表"
          caption="商业租户"
          captionMode="visible"
          scrollMode="contained"
          rows={tenants}
          getRowId={(row) => row.id}
          loading={query.loading}
          error={query.error || undefined}
          onRetry={query.reload}
          emptyState={<EmptyState icon={Building2} title="暂无商业租户" description="请先在部署配置中登记可信域名和运营主体。" />}
          onRowClick={setDetail}
          getRowAriaLabel={(row) => `查看商业租户 ${row.name}`}
          defaultPageSize={20}
          columns={[
            {
              id: "tenant",
              header: "租户 / 运营主体",
              priority: "primary",
              minWidth: "240px",
              cell: (row) => <span className="commercialTenantPrimary"><strong>{row.name}</strong><span>{row.operatorName}</span><small>{row.id}</small></span>,
            },
            {
              id: "hosts",
              header: "可信域名",
              priority: "secondary",
              minWidth: "200px",
              cell: (row) => row.hosts.length ? row.hosts.join("、") : "未配置",
            },
            {
              id: "status",
              header: "充值状态",
              priority: "primary",
              cell: (row) => {
                const state = tenantState(row);
                return <Badge tone={state.tone}>{state.label}</Badge>;
              },
            },
            { id: "rate", header: "批发结算率", priority: "secondary", align: "end", cell: (row) => row.settlementRequired ? rateLabel(row.wholesaleRatePpm) : "平台自营" },
            { id: "settlement", header: "结算金余额", priority: "primary", align: "end", cell: (row) => row.settlementRequired ? formatCny(row.settlementAccount.balanceMicros) : "不适用" },
            { id: "lots", header: "销售批次", priority: "secondary", align: "end", cell: (row) => row.lots.count.toLocaleString() },
            {
              id: "action",
              header: "操作",
              priority: "primary",
              hideable: false,
              width: "124px",
              cell: (row) => row.settlementRequired ? (
                <Button
                  variant="secondary"
                  icon={<WalletCards size={15} />}
                  disabled={row.settlementAccount.status !== "active"}
                  onClick={(event) => { event.stopPropagation(); openCredit(row); }}
                >
                  增加结算金
                </Button>
              ) : <span className="commercialTenantMuted">平台自营</span>,
            },
          ]}
        />
      </section>

      <Dialog
        open={Boolean(crediting)}
        title="增加租户结算金"
        description={crediting ? `${crediting.name} · ${crediting.operatorName}` : "为外部租户增加可用于新充值的结算余额。"}
        size="md"
        loading={saving}
        dirty={Boolean(crediting && (amountYuan || description !== `${crediting.name}结算金入金`))}
        initialFocusRef={amountRef}
        onOpenChange={(open) => { if (!open && !saving) setCrediting(null); }}
        footer={({ requestClose, pending }) => (
          <div className="commercialTenantDialogFooter">
            {formError ? <Alert tone="danger">{formError}</Alert> : null}
            <div>
              <Button variant="secondary" disabled={pending} onClick={() => requestClose("cancel")}>取消</Button>
              <Button type="submit" form="tenant-settlement-credit-form" loading={saving}>确认入金</Button>
            </div>
          </div>
        )}
      >
        <form id="tenant-settlement-credit-form" className="commercialTenantForm" onSubmit={(event) => { event.preventDefault(); void submitCredit(); }}>
          {crediting ? <DescriptionList items={[
            { label: "租户", value: `${crediting.name} (${crediting.id})` },
            { label: "当前结算余额", value: formatCny(crediting.settlementAccount.balanceMicros) },
            { label: "批发结算率", value: rateLabel(crediting.wholesaleRatePpm) },
          ]} /> : null}
          <Alert tone="warning" title="资金操作确认">
            该操作只增加租户结算金，不直接增加任何用户 GU；用户充值审核通过时才会按批发结算率扣减此余额。
          </Alert>
          <FormField label="入金金额（人民币）" required optionalLabel={null} help="支持最多 6 位小数，将以人民币 micros 精确记账。">
            <Input ref={amountRef} type="text" inputMode="decimal" value={amountYuan} onChange={(event) => setAmountYuan(event.target.value)} placeholder="例如 10000.00" />
          </FormField>
          <FormField label="入金说明" required optionalLabel={null} help="请填写银行流水、合同或内部审批依据，便于审计追踪。">
            <Input value={description} onChange={(event) => setDescription(event.target.value)} maxLength={500} />
          </FormField>
        </form>
      </Dialog>

      <Dialog
        open={Boolean(legalEditing)}
        title="编辑合规公示资料"
        description={legalEditing ? `${legalEditing.name} · ${legalEditing.operatorName}` : "保存网站合规公示资料。"}
        size="md"
        loading={legalSaving}
        dirty={Boolean(legalEditing)}
        onOpenChange={(open) => { if (!open && !legalSaving) setLegalEditing(null); }}
        footer={({ requestClose, pending }) => (
          <div className="commercialTenantDialogFooter">
            {legalError ? <Alert tone="danger">{legalError}</Alert> : null}
            <div>
              <Button variant="secondary" disabled={pending} onClick={() => requestClose("cancel")}>取消</Button>
              <Button type="submit" form="tenant-legal-profile-form" loading={legalSaving}>保存合规资料</Button>
            </div>
          </div>
        )}
      >
        <form id="tenant-legal-profile-form" className="commercialTenantForm" onSubmit={(event) => { event.preventDefault(); void submitLegalProfile(); }}>
          <Alert tone="info" title="升级保留规则">
            保存后以数据库为权威来源；镜像、前端构建和环境模板更新都不会覆盖该记录。清空某项会停止前台展示，不会显示“XXXXXXXX”。
          </Alert>
          <FormField label="ICP备案" help="例如：京ICP备XXXXXXXX号">
            <Input value={legalForm.icpNumber} maxLength={500} onChange={(event) => setLegalForm((current) => ({ ...current, icpNumber: event.target.value }))} />
          </FormField>
          <FormField label="增值电信业务经营许可证" help="填写监管机关核发的完整许可证编号。">
            <Input value={legalForm.valueAddedTelecomLicense} maxLength={500} onChange={(event) => setLegalForm((current) => ({ ...current, valueAddedTelecomLicense: event.target.value }))} />
          </FormField>
          <FormField label="公安联网备案" help="填写公安联网备案完整编号。">
            <Input value={legalForm.publicSecurityRegistration} maxLength={500} onChange={(event) => setLegalForm((current) => ({ ...current, publicSecurityRegistration: event.target.value }))} />
          </FormField>
        </form>
      </Dialog>

      <Drawer
        open={Boolean(detail)}
        title="商业租户详情"
        description={detail ? `${detail.name} · ${detail.id}` : "查看租户配置和结算流水。"}
        size="760px"
        onOpenChange={(open) => { if (!open) setDetail(null); }}
        footer={<div className="commercialTenantDrawerFooter"><Button variant="secondary" onClick={() => setDetail(null)}>关闭</Button><Button icon={<ShieldCheck size={16} />} onClick={() => detail && openLegalEditor(detail)}>编辑合规信息</Button></div>}
      >
        {detail ? (
          <div className="commercialTenantDetail">
            <DescriptionList items={[
              { label: "运营主体", value: detail.operatorName },
              { label: "租户 ID", value: detail.id },
              { label: "可信域名", value: detail.hosts.length ? detail.hosts.join("、") : "未配置" },
              { label: "ICP备案", value: detail.icpNumber || "未配置" },
              { label: "增值电信业务经营许可证", value: detail.valueAddedTelecomLicense || "未配置" },
              { label: "公安联网备案", value: detail.publicSecurityRegistration || "未配置" },
              { label: "客服邮箱", value: detail.customerServiceEmail || "未配置" },
              { label: "充值状态", value: tenantState(detail).label },
              { label: "配置来源", value: detail.configurationSource === "database" ? "数据库（升级保留）" : "部署默认（尚未持久保存）" },
              { label: "结算账户", value: detail.settlementRequired ? `${formatCny(detail.settlementAccount.balanceMicros)} · ${detail.settlementAccount.status}` : "平台自营，不单独结算" },
              { label: "销售批次", value: `${detail.lots.count.toLocaleString()} 个 · 累计 ${formatGu(detail.lots.soldMicros)}` },
              { label: "剩余 / 冻结 GU", value: `${formatGu(detail.lots.remainingMicros)} / ${formatGu(detail.lots.reservedMicros)}` },
            ]} />
            <section className="commercialTenantLedger" aria-labelledby="commercial-tenant-ledger-title">
              <div className="commercialTenantSectionHeading">
                <div>
                  <span><Landmark size={16} /></span>
                  <h3 id="commercial-tenant-ledger-title">最近结算流水</h3>
                </div>
                <small>最多 20 条</small>
              </div>
              {detail.latestSettlementLedgers.length ? (
                <div className="commercialTenantLedgerList">
                  {detail.latestSettlementLedgers.map((row) => (
                    <article key={row.id}>
                      <div><strong>{ledgerTypeLabel(row.type)}</strong><span>{row.description || row.sourceType || "-"}</span></div>
                      <div><Badge tone={ledgerTone(row)}>{row.direction === "credit" ? "入账" : "出账"}</Badge><strong>{formatCny(row.amountMicros)}</strong><span>{formatDate(row.createdAt)}</span></div>
                    </article>
                  ))}
                </div>
              ) : <EmptyState icon={Landmark} title="暂无结算流水" description="增加结算金或发生租户充值结算后会显示在这里。" />}
            </section>
          </div>
        ) : null}
      </Drawer>
    </ConsolePage>
  );
}
