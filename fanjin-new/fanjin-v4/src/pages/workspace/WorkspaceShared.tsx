import { AnalyticsDashboard } from "../analytics/AnalyticsDashboard";
import { AnalyticsDetails } from "../analytics/AnalyticsDetails";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import QRCode from "qrcode";
import { MembershipPanel, normalizeMembershipQuote, normalizeMembershipState, type MembershipQuote, type MembershipState } from "./MembershipPanel";
import {
  BarChart3,
  Building2,
  CheckCircle2,
  ChevronRight,
  Coins,
  Gift,
  Moon,
  Sun,
  CreditCard,
  Clock3,
  ArrowLeft,
  ArrowUpRight,
  Landmark,
  ListChecks,
  Plus,
  Save,
} from "lucide-react";
import { apiPost, toApiErrorView } from "../../api/http";
import * as workspaceApi from "../../api/workspace";
import { useAuthStore } from "../../stores/authStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { isWorkspaceManager, canCreateBillingRequest } from "../../utils/permissions";
import { getConsoleAccess } from "../../routes/consoleAccess";
import EnterpriseSubaccounts from "../../components/setting/components/enterpriseSubaccounts";
import {
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  ConsolePage,
  DataTable,
  DescriptionList,
  Dialog,
  EmptyState,
  FormField,
  Input,
  MetricStrip,
  ProgressBar,
  ResponsiveSplit,
  Section,
  useToast,
  type DataTableColumn,
} from "../../ui/console";
import {
  extractItems,
  formatDate,
  formatGu,
  unwrapPayload,
} from "../console/ConsoleAdminShared";
import { useV4Theme } from "../../ui/useV4Theme";
import fanjinLogo from "../../assets/fanjin-logo-fj.svg";
import "./WorkspaceConsole.css";
import "./RechargeCenter.css";

type LoadState<T> = {
  loading: boolean;
  error: string;
  data: T;
};

type WorkspaceSnapshot = {
  overview: any;
  ledger: any[];
  members: any[];
  apiKeys: any[];
  tasks: any[];
  models: any[];
};

const emptySnapshot: WorkspaceSnapshot = {
  overview: null,
  ledger: [],
  members: [],
  apiKeys: [],
  tasks: [],
  models: [],
};

function roleLabel(role?: string | null) {
  const map: Record<string, string> = {
    root: "超级管理员",
    admin: "管理员",
    super_admin: "超级管理员",
    owner: "所有者",
    workspace_admin: "管理员",
    developer: "开发者",
    creator: "创作者",
    billing: "财务",
    viewer: "只读",
    member: "成员",
  };
  return map[String(role || "")] || role || "成员";
}

function useWorkspaceSnapshot(scope: "overview" | "billing" = "overview") {
  const { currentWorkspaceId } = useWorkspaceStore();
  const currentUser = useAuthStore((state) => state.user);
  const currentWorkspace = useAuthStore((state) => state.currentWorkspace);
  const access = getConsoleAccess(
    currentUser?.role,
    currentWorkspace?.memberRole || currentWorkspace?.role,
    currentWorkspace?.permissions,
  );
  const [state, setState] = useState<LoadState<WorkspaceSnapshot>>({ loading: true, error: "", data: emptySnapshot });
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let alive = true;
    async function load() {
      setState({ loading: true, error: "", data: emptySnapshot });
      const workspacePayload = currentWorkspaceId ? { workspaceId: currentWorkspaceId } : {};
      const [overview, members, apiKeys, tasks, models] = await Promise.allSettled([
        access.billing ? apiPost<any>("/billing/overview", workspacePayload) : Promise.resolve(null),
        scope === "overview" && access.workspaceMembers ? apiPost<any>("/workspace/subaccounts/list", workspacePayload) : Promise.resolve(null),
        scope === "overview" && access.developer ? apiPost<any>("/apiKeys/list", workspacePayload) : Promise.resolve(null),
        scope === "overview" && access.developer ? apiPost<any>("/developer/tasks", { ...workspacePayload, pageNum: 1, pageSize: 20 }) : Promise.resolve(null),
        scope === "overview" && access.developer ? apiPost<any>("/developer/models", workspacePayload) : Promise.resolve(null),
      ]);
      if (!alive) return;
      const failures = [overview, members, apiKeys, tasks, models].filter((item) => item.status === "rejected").length;
      const overviewData = overview.status === "fulfilled" ? unwrapPayload(overview.value) : null;
      setState({
        loading: false,
        error: scope === "billing"
          ? overview.status === "rejected" ? toApiErrorView(overview.reason).message : ""
          : failures ? `${failures} 个接口读取失败` : "",
        data: {
          overview: overviewData,
          ledger: Array.isArray(overviewData?.ledger?.items) ? overviewData.ledger.items : [],
          members: members.status === "fulfilled" ? extractItems(members.value) : [],
          apiKeys: apiKeys.status === "fulfilled" ? extractItems(apiKeys.value) : [],
          tasks: tasks.status === "fulfilled" ? extractItems(tasks.value) : [],
          models: models.status === "fulfilled" ? extractItems(models.value) : [],
        },
      });
    }
    void load();
    return () => {
      alive = false;
    };
  }, [access.billing, access.developer, access.workspaceMembers, currentWorkspaceId, revision, scope]);

  return { ...state, reload: () => setRevision((value) => value + 1) };
}

function WorkspaceMetricGrid() {
  const { loading, error, data } = useWorkspaceSnapshot();
  const overview = data.overview || {};
  const account = overview.account || {};
  const usage = overview.usage || {};
  const runningTasks = data.tasks.filter((task) => /running|进行中|queued|pending/i.test(String(task.state || task.status || ""))).length;
  const value = (fallback: ReactNode) => loading ? "加载中" : fallback;
  return (
    <>
      {error && <Alert tone="warning" title="部分统计暂不可用">{error}，已隐藏不可读取的统计项。</Alert>}
      <MetricStrip
        ariaLabel="工作区概览"
        metrics={[
          { id: "members", label: "成员数", value: value(data.members.length), hint: "来自成员接口" },
          { id: "api-keys", label: "API 密钥", value: value(data.apiKeys.filter((key) => !key.revokedAt).length), hint: "来自密钥接口" },
          { id: "monthly-usage", label: "最近已入账", value: value(formatGu(usage.totalCostMicros)), hint: `冻结中 ${formatGu(account.reservedMicros)}`, tone: "warning" },
          { id: "running-tasks", label: "进行中任务", value: value(runningTasks), hint: `可用额度 ${formatGu(account.availableMicros, "down")}`, tone: "positive" },
        ]}
      />
    </>
  );
}

function BillingMetricGrid({ snapshot }: { snapshot: LoadState<WorkspaceSnapshot> }) {
  const { loading, error, data } = snapshot;
  const overview = data.overview || {};
  const account = overview.account || {};
  const usage = overview.usage || {};
  const ready = !error && data.overview !== null;
  const value = (fallback: ReactNode) => loading ? "加载中" : ready ? fallback : "暂不可用";
  return (
    <>
      {error && <Alert tone="danger" title="账单概览读取失败">{error}。余额和流水暂不可用，请重试。</Alert>}
      <MetricStrip
        ariaLabel="账单概览"
        metrics={[
          { id: "available-balance", label: "可用额度", value: value(formatGu(account.availableMicros, "down")), hint: "工作区余额", tone: "positive" },
          { id: "monthly-usage", label: "最近已入账", value: value(formatGu(usage.totalCostMicros)), hint: loading || !ready ? "冻结金额暂不可用" : `冻结中 ${formatGu(account.reservedMicros)}` },
          { id: "ledger-count", label: "流水记录", value: value(data.ledger.length), hint: "最近账单流水", tone: "warning" },
          { id: "credit-limit", label: "信用额度", value: value(formatGu(account.creditLimitMicros, "down")), hint: "后端账单账户" },
        ]}
      />
    </>
  );
}

export function WorkspaceMembersPage() {
  return (
    <ConsolePage
      eyebrow="工作区"
      title="工作区成员"
      description="邀请成员、分配角色、查看账号状态，保持团队权限清晰可控。"
    >
      <Section aria-label="成员管理">
        <EnterpriseSubaccounts />
      </Section>
    </ConsolePage>
  );
}

export function WorkspaceManagePage() {
  const authStore = useAuthStore();
  const { toast } = useToast();
  const currentWorkspace = authStore.currentWorkspace;
  const canSave = isWorkspaceManager({ user: authStore.user, workspace: currentWorkspace });
  const [nameDraft, setNameDraft] = useState(currentWorkspace?.name || "");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  useEffect(() => {
    setNameDraft(currentWorkspace?.name || "");
  }, [currentWorkspace?.id, currentWorkspace?.name]);

  async function handleSaveWorkspace() {
    const name = nameDraft.trim();
    if (!canSave || !currentWorkspace?.id || !name) return;
    setSaving(true);
    setSaveError("");
    try {
      await workspaceApi.updateWorkspace({ workspaceId: String(currentWorkspace.id), name });
      await authStore.fetchMe();
      toast({ title: "工作区资料已保存", tone: "success" });
    } catch (err: any) {
      setSaveError(err?.message || "保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <ConsolePage
      eyebrow="工作区"
      title="工作区管理"
      description="维护工作区资料、组织边界、默认能力和快捷入口。"
      primaryAction={(
          <Button
            icon={<Save size={16} strokeWidth={1.75} />}
            loading={saving}
            onClick={handleSaveWorkspace}
            disabled={!canSave || !currentWorkspace?.id || !nameDraft.trim()}
          >
            {saving ? "保存中" : "保存变更"}
          </Button>
      )}
    >
      {saveError && <Alert tone="danger">{saveError}</Alert>}
      <ResponsiveSplit
        primary={(
          <Section surface="outlined" title="基础资料" description="当前工作区身份信息" icon={Building2}>
            <div className="workspaceConsoleFormStack">
              <FormField label="工作区名称" required optionalLabel={null}>
                <Input
                  value={nameDraft}
                  onChange={(event) => setNameDraft(event.target.value)}
                  placeholder="请输入工作区名称"
                  autoComplete="organization"
                  disabled={saving || !canSave}
                />
              </FormField>
              <DescriptionList
                items={[
                  { id: "workspace-id", label: "工作区 ID", value: currentWorkspace?.id || "-" },
                  {
                    id: "current-role",
                    label: "当前角色",
                    value: roleLabel(currentWorkspace?.role || currentWorkspace?.memberRole),
                  },
                  { id: "plan", label: "套餐标识", value: currentWorkspace?.plan || "-" },
                  { id: "region", label: "区域", value: currentWorkspace?.region || "-" },
                  { id: "created-at", label: "创建时间", value: formatDate(currentWorkspace?.createdAt) },
                  {
                    id: "status",
                    label: "状态",
                    value: (
                      <Badge tone={currentWorkspace?.status === "suspended" ? "danger" : "success"}>
                        {currentWorkspace?.status || "active"}
                      </Badge>
                    ),
                  },
                ]}
              />
            </div>
          </Section>
        )}
        secondary={(
          <Section surface="outlined" title="快捷操作" description="常用管理入口" icon={ListChecks}>
            <DataTable
              ariaLabel="工作区快捷入口"
              rows={[
                { name: "工作区成员", description: "邀请成员、分配角色", path: "/workspace/members" },
                { name: "API 管理", description: "密钥、文档和请求调试", path: "/developer/api/keys" },
                { name: "账单与用量", description: "额度、流水与发票", path: "/workspace/billing" },
              ]}
              getRowId={(row) => row.path}
              columns={[
                {
                  id: "name",
                  header: "入口",
                  accessor: "name",
                  priority: "primary",
                  hideable: false,
                },
                {
                  id: "description",
                  header: "说明",
                  accessor: "description",
                  priority: "secondary",
                },
                {
                  id: "action",
                  header: "操作",
                  cell: (row) => <NavigateAction path={row.path} />,
                  priority: "primary",
                  hideable: false,
                  align: "end",
                },
              ]}
            />
          </Section>
        )}
      />
      <WorkspaceMetricGrid />
    </ConsolePage>
  );
}

export function BillingPage() {
  const snapshot = useWorkspaceSnapshot("billing");
  const [searchParams, setSearchParams] = useSearchParams();
  const [rechargeOpen, setRechargeOpen] = useState(searchParams.get("recharge") === "1");
  const currentWorkspaceId = useWorkspaceStore(state => state.currentWorkspaceId);
  const [ordersView, setOrdersView] = useState(false);
  const [days, setDays] = useState(30);
  const tab = searchParams.get("tab") || "overview";
  const range = useMemo(() => { const to = Date.now(); return { from: to - days * 86400000, to }; }, [days]);
  const detailFilters = { scope: "workspace" as const, workspaceId: currentWorkspaceId ? String(currentWorkspaceId) : undefined,
    from: searchParams.has("from") ? Number(searchParams.get("from")) : range.from,
    to: searchParams.has("to") ? Number(searchParams.get("to")) : range.to,
    query: searchParams.get("query") || undefined,
    ...(tab === "usage" ? { model: searchParams.get("model") || undefined, source: searchParams.get("source") || undefined, memberId: searchParams.has("memberId") ? Number(searchParams.get("memberId")) : undefined, projectId: searchParams.has("projectId") ? Number(searchParams.get("projectId")) : undefined, apiKeyId: searchParams.get("apiKeyId") || undefined } : {}),
  };

  useEffect(() => {
    if (searchParams.get("recharge") === "1") setRechargeOpen(true);
  }, [searchParams]);

  function handleRechargeOpenChange(open: boolean) {
    setRechargeOpen(open);
    if (!open) setOrdersView(false);
    if (!open && searchParams.has("recharge")) {
      const next = new URLSearchParams(searchParams);
      next.delete("recharge");
      setSearchParams(next, { replace: true });
    }
  }

  return (
    <ConsolePage
      eyebrow="工作区财务"
      title="账单与用量"
      description="查看可用额度、实际消耗与账单流水，并提交充值申请。"
      className="workspaceBillingPage"
      primaryAction={(
        <Button icon={<Plus size={17} strokeWidth={1.8} />} onClick={() => {
          const next = new URLSearchParams(searchParams);
          next.set("recharge", "1");
          setSearchParams(next);
        }}>
          充值 GU
        </Button>
      )}
    >
      <div className="analyticsTabs" aria-label="账单视图">
        {[["overview", "用量概览"], ["usage", "调用明细"], ["ledger", "资金流水"], ["orders", "充值订单"]].map(([id, name]) => <button key={id} aria-pressed={tab === id} onClick={() => {
          if (id === "orders") { setOrdersView(true); setRechargeOpen(true); return; }
          const next = new URLSearchParams(searchParams); next.set("tab", id); setSearchParams(next);
        }}>{name}</button>)}
      </div>
      {tab === "overview" ? <AnalyticsDashboard embedded /> : <>
        <div className="analyticsPeriod" style={{ alignSelf: "start", marginBottom: 20 }} aria-label="明细时间范围">{[7, 30, 90].map(value => <button key={value} aria-pressed={!searchParams.has("from") && days === value} onClick={() => { setDays(value); const next = new URLSearchParams(searchParams); next.delete("from"); next.delete("to"); setSearchParams(next); }}>{value} 天</button>)}</div>
        <AnalyticsDetails key={`${tab}-${currentWorkspaceId}`} filters={detailFilters} kind={tab === "ledger" ? "ledger" : "usage"} />
      </>}
      <RechargeDialog
        open={rechargeOpen}
        initialView={ordersView ? "orders" : "recharge"}
        availableMicros={snapshot.data.overview?.account?.availableMicros == null
          ? null
          : Number(snapshot.data.overview.account.availableMicros)}
        onOpenChange={handleRechargeOpenChange}
      />
    </ConsolePage>
  );
}

export function projectWorkspaceBillingLedgerRows(items: any[]) {
  const statusLabels: Record<string, string> = {
    frozen: "已冻结",
    pending_reconcile: "待核账",
    charged: "已扣费",
    captured: "已结算",
    released: "已释放",
    succeeded: "已完成",
    failed: "失败",
  };
  return items.map((item, index) => {
    const metadata = item?.metadata && typeof item.metadata === "object"
      ? item.metadata
      : {};
    const status = String(
      metadata.billingLifecycleState === "pending_reconcile"
        ? "pending_reconcile"
        : item.status || "unknown",
    );
    return {
      id: item.id ?? index,
      event: item.type || item.event || item.description || item.reason || "-",
      status: statusLabels[status] || status,
      amount: item.amountMicros != null ? formatGu(item.amountMicros) : (item.amount || item.costMicros ? formatGu(item.costMicros) : "-"),
      remaining: item.remainingMicros == null ? "-" : formatGu(item.remainingMicros, "down"),
      reconcileIdentity: String(metadata.reconcileJobId || item.reconcileJobId || "-"),
      usageIdentity: String(item.usageRecordId || metadata.usageRecordId || "-"),
      source: [
        item.model || metadata.model || metadata.modelName,
        item.taskId ? `任务 ${item.taskId}` : null,
        item.description || item.owner || item.source || item.operator,
      ].filter(Boolean).join(" · ") || (item.operatorUserId ? `操作人 #${item.operatorUserId}` : "系统账务"),
      time: formatDate(item.createTime || item.createdAt || item.time),
    };
  });
}

export type PaymentChannel = {
  key: string;
  name: string;
  method: "online" | "offline" | "manual";
  protocol?: string;
  accountName?: string;
  accountNo?: string;
  bankName?: string;
  qrCodeUrl?: string;
  remark?: string;
};

type CreditPackage = { id: string; kind: "credits" | "membership"; name: string; priceYuan: number; creditsGu: number; giftGu: number };

export type PaymentConfig = {
  membershipState: MembershipState | null;
  packages?: CreditPackage[];
  membership?: { name: string; expiresAt: number; active: boolean } | null;
  gatewayEnabled: boolean;
  rechargeEnabled: boolean;
  minTopupYuan: number;
  amountOptions: number[];
  settlementNote?: string;
  guPerYuan: number;
  sellerTenantId: string;
  sellerTenantName: string;
  operatorName: string;
  channels: PaymentChannel[];
};

type RechargeRequest = {
  id: string;
  status: string;
  amountMicros: number;
  sellerTenantId: string;
  createdAt: number;
};
function normalizeRechargeRequests(payload: unknown): RechargeRequest[] {
  return extractItems(payload).flatMap((item) => {
    const request = {
      id: String(item.id || "").trim(), status: String(item.status || "").trim(),
      amountMicros: Number(item.amountMicros), sellerTenantId: String(item.sellerTenantId || "").trim().toUpperCase(),
      createdAt: Number(item.createdAt),
    };
    return request.id && request.status && Number.isFinite(request.amountMicros) && request.amountMicros > 0
      && request.sellerTenantId && Number.isFinite(request.createdAt) && request.createdAt > 0 ? [request] : [];
  });
}


type OnlinePaymentOrder = {
  membership: MembershipQuote | null;
  membershipFulfillment: string | null;
  membershipStartsAt: number | null;
  id: string;
  outTradeNo: string;
  sellerTenantId: string;
  status: "created" | "pending" | "pending_reconcile" | "paid" | "failed" | "closed" | "refunding" | "refunded";
  amountMicros: number;
  creditedGu: number;
  packageId: string | null;
  paymentUrl: string | null;
  qrCodeUrl: string | null;
  expiresAt: number;
  createdAt: number;
};

export function normalizePaymentConfig(value: unknown): PaymentConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("充值配置响应为空");
  }
  const record = value as Record<string, unknown>;
  const minTopupYuan = Number(record.minTopupYuan);
  const guPerYuan = Number(record.guPerYuan);
  const sellerTenantId = String(record.sellerTenantId || "").trim().toUpperCase();
  const sellerTenantName = String(record.sellerTenantName || "").trim();
  const operatorName = String(record.operatorName || "").trim();
  if (!Number.isFinite(minTopupYuan) || minTopupYuan <= 0 || !Number.isFinite(guPerYuan) || guPerYuan <= 0) {
    throw new Error("充值配置缺少有效的最低充值金额或 GU 兑换比例");
  }
  if (!/^[A-Z][A-Z0-9_-]{1,63}$/.test(sellerTenantId) || !sellerTenantName || !operatorName) {
    throw new Error("充值配置缺少明确的销售租户或收款主体");
  }
  const amountOptions = Array.isArray(record.amountOptions)
    ? Array.from(new Set(record.amountOptions
      .map(Number)
      .filter((amount) => Number.isFinite(amount) && amount >= minTopupYuan)))
      .slice(0, 6)
    : [];
  const gatewayEnabled = Boolean(record.gatewayEnabled);
  const rechargeEnabled = record.rechargeEnabled === true;
  const channels = Array.isArray(record.channels)
    ? record.channels.filter((item): item is PaymentChannel => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return false;
      const channel = item as Partial<PaymentChannel>;
      if (typeof channel.key !== "string" || !channel.key.trim()) return false;
      if (typeof channel.name !== "string" || !channel.name.trim()) return false;
      if (channel.method === "online") return gatewayEnabled && rechargeEnabled;
      if (channel.method !== "offline" || !rechargeEnabled) return false;
      const hasAccountName = Boolean(String(channel.accountName || "").trim());
      const hasBankAccount = Boolean(String(channel.accountNo || "").trim())
        && Boolean(String(channel.bankName || "").trim());
      const hasQrCode = Boolean(String(channel.qrCodeUrl || "").trim());
      return hasQrCode || (hasAccountName && hasBankAccount);
    })
    : [];
  return {
    gatewayEnabled,
    rechargeEnabled,
    membershipState: normalizeMembershipState(record.membershipState),
    membership: record.membership && typeof record.membership === "object" && Number.isFinite((record.membership as any).expiresAt) ? record.membership as PaymentConfig["membership"] : null,
    packages: Array.isArray(record.packages) ? record.packages.filter((pack: any) => typeof pack?.id === "string" && typeof pack?.name === "string" && Number.isFinite(pack.priceYuan) && pack.priceYuan >= minTopupYuan && Number.isFinite(pack.creditsGu) && pack.creditsGu > 0 && ["credits", "membership"].includes(pack.kind) && Number.isFinite(pack.giftGu) && pack.giftGu >= 0) as CreditPackage[] : [],
    minTopupYuan,
    amountOptions,
    settlementNote: typeof record.settlementNote === "string" ? record.settlementNote.trim() || undefined : undefined,
    guPerYuan,
    sellerTenantId,
    sellerTenantName,
    operatorName,
    channels,
  };
}

export function validateCreatedRechargeRequest(
  value: unknown,
  expectedAmountMicros: number,
  expectedSellerTenantId?: string,
): RechargeRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("充值申请响应为空，无法确认是否创建；请勿重复提交并联系管理员核对");
  }
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const status = typeof record.status === "string" ? record.status.trim() : "";
  const type = typeof record.type === "string" ? record.type.trim() : "";
  const currency = typeof record.currency === "string" ? record.currency.trim().toUpperCase() : "";
  const amountMicros = Number(record.amountMicros);
  const sellerTenantId = typeof record.sellerTenantId === "string" ? record.sellerTenantId.trim().toUpperCase() : "";
  const createdAt = Number(record.createdAt);
  if (
    !id
    || status !== "pending"
    || type !== "offline_payment"
    || currency !== "CNY"
    || !Number.isSafeInteger(amountMicros)
    || amountMicros !== expectedAmountMicros
    || !sellerTenantId
    || (expectedSellerTenantId && sellerTenantId !== expectedSellerTenantId.trim().toUpperCase())
    || !Number.isFinite(createdAt)
    || createdAt <= 0
  ) {
    throw new Error("充值申请响应缺少有效编号、状态、币种、金额或创建时间，无法确认成功；请勿重复提交并联系管理员核对");
  }
  return { id, status, amountMicros, sellerTenantId, createdAt };
}

export function normalizeOnlinePaymentOrder(value: unknown): OnlinePaymentOrder {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("支付订单响应为空");
  const record = value as Record<string, unknown>;
  const status = String(record.status || "") as OnlinePaymentOrder["status"];
  const allowed = ["created", "pending", "pending_reconcile", "paid", "failed", "closed", "refunding", "refunded"];
  const order: OnlinePaymentOrder = {
    id: String(record.id || "").trim(),
    outTradeNo: String(record.outTradeNo || "").trim(),
    sellerTenantId: String(record.sellerTenantId || "").trim().toUpperCase(),
    status,
    membership: record.membership ? normalizeMembershipQuote(record.membership) : null,
    membershipFulfillment: typeof record.membershipFulfillment === "string" ? record.membershipFulfillment : null,
    membershipStartsAt: record.membershipStartsAt == null ? null : Number(record.membershipStartsAt),
    amountMicros: Number(record.amountMicros),
    creditedGu: Number(record.creditedGu),
    packageId: record.package && typeof record.package === "object" && "id" in record.package ? String(record.package.id) : null,
    paymentUrl: typeof record.paymentUrl === "string" && record.paymentUrl.trim() ? record.paymentUrl.trim() : null,
    qrCodeUrl: typeof record.qrCodeUrl === "string" && record.qrCodeUrl.trim() ? record.qrCodeUrl.trim() : null,
    expiresAt: Number(record.expiresAt),
    createdAt: Number(record.createdAt),
  };
  if (
    !order.id || !order.outTradeNo || !/^[A-Z][A-Z0-9_-]{1,63}$/.test(order.sellerTenantId)
    || !allowed.includes(order.status) || !Number.isSafeInteger(order.amountMicros) || order.amountMicros <= 0
    || !Number.isFinite(order.creditedGu) || (order.membership ? order.creditedGu !== 0 || order.membership.amountMicros !== order.amountMicros : order.creditedGu <= 0) || !Number.isFinite(order.expiresAt)
    || !Number.isFinite(order.createdAt) || order.createdAt <= 0
  ) throw new Error("支付订单响应不完整，请勿重复付款并联系管理员核对");
  return order;
}

function onlinePaymentReturnUrl(): string {
  const value = new URL(window.location.href);
  value.searchParams.set("recharge", "1");
  return value.toString();
}

export function RechargeDialog({
  open,
  availableMicros,
  onOpenChange,
  initialView = "recharge",
}: {
  initialView?: "recharge" | "orders";
  open: boolean;
  availableMicros: number | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const currentWorkspaceId = useWorkspaceStore((state) => state.currentWorkspaceId);
  const currentWorkspace = useAuthStore((state) => state.currentWorkspace);
  const user = useAuthStore((state) => state.user);
  const canSubmitBilling = canCreateBillingRequest({ user, workspace: currentWorkspace });
  const screenRef = useRef<HTMLDivElement>(null);
  const theme = useV4Theme();
  const [view, setView] = useState<"recharge" | "membership" | "orders">("recharge");
  const [config, setConfig] = useState<PaymentConfig | null>(null);
  const [membershipQuote, setMembershipQuote] = useState<MembershipQuote | null>(null);
  const [configLoading, setConfigLoading] = useState(false);
  const [configError, setConfigError] = useState("");
  const [selectedAmount, setSelectedAmount] = useState(0);
  const [customAmount, setCustomAmount] = useState("");
  const [selectedChannelKey, setSelectedChannelKey] = useState("");
  const [contactName, setContactName] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [refundConfirmationOpen, setRefundConfirmationOpen] = useState(false);
  const [createdRequestId, setCreatedRequestId] = useState("");
  const [onlineOrder, setOnlineOrder] = useState<OnlinePaymentOrder | null>(null);
  const [onlineQrDataUrl, setOnlineQrDataUrl] = useState("");
  const [paymentAttemptKey, setPaymentAttemptKey] = useState("");
  const [recentRequests, setRecentRequests] = useState<RechargeRequest[]>([]);
  const [recentRequestsLoading, setRecentRequestsLoading] = useState(false);
  const [recentRequestsError, setRecentRequestsError] = useState("");
  const [recentOnlineOrders, setRecentOnlineOrders] = useState<OnlinePaymentOrder[]>([]);
  const [recentOnlineOrdersLoading, setRecentOnlineOrdersLoading] = useState(false);
  const [recentOnlineOrdersError, setRecentOnlineOrdersError] = useState("");
  const [orderCursor, setOrderCursor] = useState<string | null>(null);
  const [requestPage, setRequestPage] = useState(1);
  const [requestsHasMore, setRequestsHasMore] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const historyEpoch = useRef(0);
  async function loadHistory(kind: "online" | "offline") {
    const epoch = historyEpoch.current;
    setHistoryLoading(true); setHistoryError("");
    const workspaceId = String(currentWorkspaceId || currentWorkspace?.id || "");
    try {
      const payload = await apiPost<any>(kind === "online" ? "/billing/payment/orders/list" : "/billing/serviceRequests/list", kind === "online" ? { workspaceId, limit: 20, cursor: orderCursor } : { workspaceId, type: "offline_payment", pageNum: requestPage + 1, pageSize: 4 });
      if (historyEpoch.current !== epoch) return;
      if (kind === "online") {
        const next = extractItems(payload).map(normalizeOnlinePaymentOrder);
        setRecentOnlineOrders(current => [...new Map([...current, ...next].map(order => [order.id, order])).values()]);
        setOrderCursor(payload.nextCursor || null);
      } else {
        const next = normalizeRechargeRequests(payload);
        setRecentRequests(current => [...new Map([...current, ...next].map(request => [request.id, request])).values()]);
        setRequestPage(page => page + 1); setRequestsHasMore(Number.isFinite(payload.total) ? (requestPage + 1) * 4 < payload.total : next.length === 4);
      }
    } catch (error) { if (historyEpoch.current === epoch) setHistoryError(error instanceof Error ? error.message : "订单读取失败，请重试"); }
    finally { if (historyEpoch.current === epoch) setHistoryLoading(false); }
  }


  useEffect(() => {
    const scrollContainer = screenRef.current?.parentElement;
    if (scrollContainer) scrollContainer.scrollTop = 0;
  }, [view, onlineOrder?.id, createdRequestId]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    historyEpoch.current += 1; setHistoryError(""); setHistoryLoading(false); setOrderCursor(null); setRequestPage(1); setRequestsHasMore(false);
    setView(initialView);
    setConfig(null);
    setMembershipQuote(null);
    setConfigLoading(true);
    setConfigError("");
    setSubmitError("");
    setRefundConfirmationOpen(false);
    setCreatedRequestId("");
    setOnlineOrder(null);
    setOnlineQrDataUrl("");
    setPaymentAttemptKey(globalThis.crypto.randomUUID());
    setSelectedAmount(0);
    setSelectedPackageId("");
    setCustomAmount("");
    setSelectedChannelKey("");
    setRecentRequests([]);
    setRecentRequestsLoading(true);
    setRecentRequestsError("");
    setRecentOnlineOrders([]);
    setRecentOnlineOrdersLoading(true);
    setRecentOnlineOrdersError("");
    const workspaceId = currentWorkspaceId || currentWorkspace?.id;
    const workspacePayload = workspaceId ? { workspaceId: String(workspaceId) } : {};
    void apiPost<unknown>("/billing/payment/config", workspaceId ? { workspaceId: String(workspaceId) } : {})
      .then((next) => {
        if (!alive) return;
        let normalized: PaymentConfig;
        try {
          normalized = normalizePaymentConfig(next);
        } catch (error) {
          setConfigError(error instanceof Error ? error.message : "充值配置无效");
          return;
        }
        setConfig(normalized);
        setSelectedAmount(normalized.amountOptions[1] ?? normalized.amountOptions[0] ?? normalized.minTopupYuan);
        const preferredChannel = normalized.channels.find((channel) => channel.method === "online") || normalized.channels[0];
        setSelectedChannelKey(preferredChannel?.key || "");
      })
      .catch((error) => {
        if (!alive) return;
        setConfig(null);
        setConfigError(error instanceof Error ? error.message : "充值配置读取失败");
      })
      .finally(() => {
        if (alive) setConfigLoading(false);
      });
    void apiPost<any>("/billing/serviceRequests/list", {
      ...workspacePayload,
      type: "offline_payment",
      pageNum: 1,
      pageSize: 4,
    })
      .then((payload) => {
        if (!alive) return;
        const requests = normalizeRechargeRequests(payload);
        setRecentRequests(requests); setRequestsHasMore(Number.isFinite(payload.total) ? payload.total > 4 : requests.length === 4);
      })
      .catch((error) => {
        if (!alive) return;
        setRecentRequests([]);
        setRecentRequestsError(error instanceof Error ? error.message : "最近充值申请读取失败");
      })
      .finally(() => {
        if (alive) setRecentRequestsLoading(false);
      });
    void apiPost<any>("/billing/payment/orders/list", { ...workspacePayload, limit: 20 })
      .then((payload) => {
        if (!alive) return;
        const orders = extractItems(payload).flatMap((item) => {
          try {
            return [normalizeOnlinePaymentOrder(item)];
          } catch {
            return [];
          }
        });
        setRecentOnlineOrders(orders); setOrderCursor(payload.nextCursor || null);
      })
      .catch((error) => {
        if (!alive) return;
        setRecentOnlineOrders([]);
        setRecentOnlineOrdersError(error instanceof Error ? error.message : "最近线上订单读取失败");
      })
      .finally(() => {
        if (alive) setRecentOnlineOrdersLoading(false);
      });
    return () => {
      alive = false; historyEpoch.current += 1;
    };
  }, [currentWorkspace?.id, currentWorkspaceId, initialView, open]);

  useEffect(() => {
    if (!onlineOrder?.qrCodeUrl) {
      setOnlineQrDataUrl("");
      return;
    }
    let alive = true;
    void QRCode.toDataURL(onlineOrder.qrCodeUrl, { width: 280, margin: 4, errorCorrectionLevel: "M" })
      .then((value) => { if (alive) setOnlineQrDataUrl(value); })
      .catch(() => { if (alive) setOnlineQrDataUrl(""); });
    return () => { alive = false; };
  }, [onlineOrder?.qrCodeUrl]);

  useEffect(() => {
    // A concurrent retry may briefly observe the durable order before the
    // provider-create response is persisted. Keep polling that `created`
    // state so the user receives the QR/link as soon as the first request
    // finishes instead of being left with an apparently empty order.
    if (!open || !onlineOrder || !(["created", "pending", "pending_reconcile", "refunding"].includes(onlineOrder.status) || (onlineOrder.status === "paid" && onlineOrder.membershipFulfillment === "pending"))) return;
    let alive = true;
    const timer = window.setInterval(() => {
      void apiPost<unknown>(`/billing/payment/orders/query/${encodeURIComponent(onlineOrder.id)}`, {})
        .then((value) => {
          if (!alive) return;
          const next = normalizeOnlinePaymentOrder(value);
          setOnlineOrder(next);
          setRecentOnlineOrders((current) => [next, ...current.filter((item) => item.id !== next.id)]);
          if (next.status === "paid" && (!next.membership || next.membershipFulfillment !== "pending")) {
            toast({ title: next.membership ? "会员支付成功" : "充值已到账", message: next.membership ? (next.membershipFulfillment === "scheduled" ? "已安排续费，将在当前会员结束后生效。" : "本期专属额度已到账。") : `${next.creditedGu.toLocaleString("zh-CN")} GU 已进入全局余额。`, tone: "success" });
          } else if (next.status === "refunded") {
            toast({ title: "退款已完成", message: "该笔未使用充值已原路退回。", tone: "success" });
          }
        })
        .catch((error) => { if (alive) setSubmitError(error instanceof Error ? error.message : "支付状态查询失败"); });
    }, 2500);
    return () => { alive = false; window.clearInterval(timer); };
  }, [open, onlineOrder?.id, onlineOrder?.status, onlineOrder?.membershipFulfillment, toast]);

  useEffect(() => {
    if (!open || !onlineOrder || !["paid", "refunded"].includes(onlineOrder.status) || onlineOrder.membershipFulfillment === "pending") return;
    let alive = true;
    void apiPost<unknown>("/billing/payment/config", {}).then(value => { if (alive) setConfig(normalizePaymentConfig(value)); })
      .catch(() => { if (alive) setConfigError("支付状态已确认，余额刷新失败，请重新打开充值中心查看。"); });
    return () => { alive = false; };
  }, [open, onlineOrder?.id, onlineOrder?.status, onlineOrder?.membershipFulfillment]);

  const [selectedPackageId, setSelectedPackageId] = useState("");
  const selectedPackage = config?.packages?.find((pack) => pack.id === selectedPackageId);
  const amount = customAmount ? Number(customAmount) : selectedAmount;
  const minAmount = config?.minTopupYuan ?? null;
  const amountValid = minAmount !== null && Number.isFinite(amount) && amount >= minAmount;
  const guAmount = amountValid && config ? (selectedPackage?.creditsGu ?? Math.round(amount * config.guPerYuan)) : null;
  const availableChannels = config?.channels.filter((channel) => channel.method === "online" || (!selectedPackage && channel.method === "offline")) ?? [];
  const unavailableChannels = config?.channels.filter((channel) => channel.method === "manual") ?? [];
  const selectedChannel = availableChannels.find((channel) => channel.key === selectedChannelKey) || availableChannels[0];
  const selectedPaymentLabel = selectedChannel?.name || "—";
  const onlineCanPay = onlineOrder ? ["created", "pending"].includes(onlineOrder.status) : false;

  const membershipAttempt = useRef<{ hash: string; key: string } | null>(null);
  async function submitMembershipOrder(quote: MembershipQuote) {
    if (!canSubmitBilling || !config || submitting) return;
    const channel = config.channels.find(channel => channel.method === "online");
    if (!channel) return;
    const workspaceId = String(currentWorkspaceId || currentWorkspace?.id || "");
    const identity = `${workspaceId}:${channel.key}:${quote.quoteHash}`;
    if (membershipAttempt.current?.hash !== identity) membershipAttempt.current = { hash: identity, key: globalThis.crypto.randomUUID() };
    setSubmitting(true); setSubmitError("");
    try {
      const order = normalizeOnlinePaymentOrder(await apiPost<unknown>("/billing/payment/orders/create", {
        workspaceId, channelKey: channel.key, amountMicros: quote.amountMicros,
        membership: { planId: quote.planId, months: quote.months, seedanceShare: quote.seedanceShare, version: quote.version },
        idempotencyKey: membershipAttempt.current.key, returnUrl: onlinePaymentReturnUrl(),
      }));
      if (order.sellerTenantId !== config.sellerTenantId || order.amountMicros !== quote.amountMicros || order.membership?.quoteHash !== quote.quoteHash) throw new Error("会员订单与选择不一致，请勿付款");
      setOnlineOrder(order);
      membershipAttempt.current = null;
      setRecentOnlineOrders(current => [order, ...current.filter(item => item.id !== order.id)]);
    } catch (reason) { setSubmitError(reason instanceof Error ? reason.message : "会员订单创建失败"); }
    finally { setSubmitting(false); }
  }

  async function submitRechargeRequest() {
    if (!canSubmitBilling || !config || !selectedChannel || !amountValid || submitting) return;
    const workspaceId = currentWorkspaceId || currentWorkspace?.id;
    setSubmitting(true);
    setSubmitError("");
    try {
      const expectedAmountMicros = Math.round(amount * 1_000_000);
      if (selectedChannel.method === "online") {
        const response = await apiPost<unknown>("/billing/payment/orders/create", {
          ...(workspaceId ? { workspaceId: String(workspaceId) } : {}),
          channelKey: selectedChannel.key,
          amountMicros: expectedAmountMicros,
          ...(selectedPackage ? { packageId: selectedPackage.id } : {}),
          idempotencyKey: paymentAttemptKey,
          returnUrl: onlinePaymentReturnUrl(),
        });
        const order = normalizeOnlinePaymentOrder(response);
        if (order.sellerTenantId !== config.sellerTenantId || order.amountMicros !== expectedAmountMicros) {
          throw new Error("支付订单租户或金额与本次充值不一致，请勿付款");
        }
        if (order.packageId !== (selectedPackage?.id ?? null) || (selectedPackage && order.creditedGu !== selectedPackage.creditsGu)) {
          throw new Error("支付订单套餐或到账积分与选择不一致，请勿付款");
        }
        setOnlineOrder(order);
        setRecentOnlineOrders((current) => [order, ...current.filter((item) => item.id !== order.id)]);
        return;
      }
      if (selectedPackage) throw new Error("创作套餐请使用在线支付渠道");
      const response = await apiPost<unknown>("/billing/serviceRequests/create", {
        ...(workspaceId ? { workspaceId: String(workspaceId) } : {}),
        type: "offline_payment",
        amountMicros: expectedAmountMicros,
        currency: "CNY",
        contactName: contactName.trim() || null,
        contactPhone: contactPhone.trim() || null,
        note: [
          `付款渠道：${selectedChannel.name}`,
          note.trim(),
        ].filter(Boolean).join("\n"),
      });
      const created = validateCreatedRechargeRequest(response, expectedAmountMicros, config.sellerTenantId);
      setCreatedRequestId(created.id);
      setRecentRequests((current) => [
        created,
        ...current.filter((item) => item.id !== created.id),
      ]);
      toast({
        title: "充值申请已提交",
        message: "财务审核并确认到账后，GU 将自动进入当前工作区。",
        tone: "success",
      });
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "充值申请提交失败");
    } finally {
      setSubmitting(false);
    }
  }

  function requestOnlineRefund() {
    if (!canSubmitBilling || !onlineOrder || onlineOrder.status !== "paid" || submitting) return;
    setSubmitError("");
    setRefundConfirmationOpen(true);
  }

  async function confirmOnlineRefund() {
    if (!canSubmitBilling || !onlineOrder || onlineOrder.status !== "paid" || submitting) return false;
    setSubmitting(true);
    setSubmitError("");
    try {
      const response = await apiPost<unknown>(`/billing/payment/orders/refund/${encodeURIComponent(onlineOrder.id)}`, {});
      const next = normalizeOnlinePaymentOrder(response);
      setOnlineOrder(next);
      setRecentOnlineOrders((current) => [next, ...current.filter((item) => item.id !== next.id)]);
      if (next.status === "refunded") {
        toast({ title: "退款已完成", message: "该笔未使用充值已原路退回。", tone: "success" });
      }
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "退款申请失败";
      setSubmitError(message);
      throw error;
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <Dialog
        open={open}
        size="xl"
        className={`workspaceRechargeDialog rechargeCenter${onlineOrder || createdRequestId ? " workspaceRechargeDialog--checkout" : ""}`}
        contentClassName="workspaceRechargeDialogContent"
        title={onlineOrder ? "支付详情" : createdRequestId ? "充值申请已提交" : <span className="rechargeCenterBrand"><img src={fanjinLogo} alt="" /><span>充值中心<small aria-hidden="true">FANJIN</small></span></span>}
        description={onlineOrder ? "查看付款信息与到账进度" : createdRequestId ? "财务确认到账后会增加 GU 余额。" : undefined}
        onOpenChange={onOpenChange}
        loading={submitting}
        footer={createdRequestId || onlineOrder ? (
          <div className="workspaceRechargeFooter workspaceRechargeFooter--result">
            <Button variant="ghost" icon={<ArrowLeft size={16} />} onClick={() => { setOnlineOrder(null); setCreatedRequestId(""); setSubmitError(""); setView("orders"); }}>订单记录</Button>
            <Button onClick={() => onOpenChange(false)}>{onlineCanPay ? "稍后支付" : "完成"}</Button>
          </div>
        ) : view === "membership" ? (
          <div className="workspaceRechargeFooter">
            <div className="workspaceRechargeFooterAmount" aria-live="polite"><span>会员实付金额</span><strong>{membershipQuote ? `¥${(membershipQuote.amountMicros / 1_000_000).toLocaleString("zh-CN")}` : "—"}</strong>
              <small>{membershipQuote ? `${membershipQuote.months} 个月 · 按月发放 · 每期赠额一年有效` : "请选择可购买的会员方案"}</small></div>
            <Button loading={submitting} disabled={!canSubmitBilling || !membershipQuote || !config?.channels.some(channel => channel.method === "online")}
              onClick={() => { if (membershipQuote) void submitMembershipOrder(membershipQuote); }}>确认方案并付款</Button>
          </div>
        ) : view === "orders" ? <Button onClick={() => setView("recharge")}>继续充值</Button> : (
          <div className="workspaceRechargeFooter">
            <div className="workspaceRechargeFooterAmount" aria-live="polite">
              <span>实付金额</span><strong>¥{amountValid ? amount.toLocaleString("zh-CN") : "—"}</strong>
              <small>{selectedPaymentLabel} · {guAmount?.toLocaleString("zh-CN") ?? "—"} GU</small>
            </div>
            {config && selectedChannel ? (
              <Button
                icon={<CreditCard size={16} strokeWidth={1.8} />}
                loading={submitting}
                disabled={!canSubmitBilling || !amountValid || configLoading}
                onClick={() => void submitRechargeRequest()}
              >
                {selectedChannel.method === "online" ? "确认支付" : "提交充值申请"}
              </Button>
            ) : null}
          </div>
        )}
      >
      <div ref={screenRef} className="workspaceRechargeScreen">
      {!onlineOrder && !createdRequestId ? <div className="workspaceRechargeTabs" aria-label="充值中心导航">
        <button type="button" aria-pressed={view === "membership"} onClick={() => setView("membership")}>会员订阅</button>
        <button type="button" aria-pressed={view === "recharge"} onClick={() => setView("recharge")}>积分充值</button>
        <button type="button" aria-pressed={view === "orders"} onClick={() => setView("orders")}>订单记录</button>
        <button type="button" className="rechargeCenterTheme" onClick={theme.toggle} aria-label={theme.mode === "dark" ? "切换浅色主题" : "切换深色主题"}>{theme.mode === "dark" ? <Sun size={18} /> : <Moon size={18} />}</button>
      </div> : null}
      {onlineOrder ? (
        <div className="workspaceRechargeSuccess" data-tone={onlinePaymentStatus(onlineOrder.status).tone}>
          <span>{onlineOrder.status === "paid" ? <CheckCircle2 size={30} strokeWidth={1.7} /> : <Clock3 size={30} strokeWidth={1.7} />}</span>
          <h3>{onlineOrder.membership && onlineOrder.status === "paid" ? "会员支付成功" : onlinePaymentStatus(onlineOrder.status).title}</h3>
          <p>{onlineOrder.status === "paid" ? (onlineOrder.membership ? onlineOrder.membershipFulfillment === "pending" ? "付款成功，正在发放会员额度，请稍候。" : onlineOrder.membershipFulfillment === "scheduled" ? "付款成功，会员将接续在已购会员之后生效。" : "会员已生效，本期专属额度已到账。" : "GU 已进入余额，可以继续创作了。") : onlineOrder.status === "refunding" ? "正在处理原路退款，结果将在这里更新。" : onlineOrder.status === "pending_reconcile" ? "正在确认付款结果，请勿重复付款。" : onlineCanPay ? "请使用下方付款入口。支付完成后，这里会自动更新到账状态。" : onlineOrder.status === "refunded" ? "本单款项已原路退回，对应 GU 已扣回。" : "本单已结束。如需充值，请返回重新选择金额。"}</p>
          <div className="workspaceCheckoutAmount"><span>支付金额</span><strong>¥{(onlineOrder.amountMicros / 1_000_000).toLocaleString("zh-CN")}</strong></div>
          {onlineCanPay && onlineQrDataUrl ? (
            <div className="workspaceCheckoutQr"><img src={onlineQrDataUrl} alt="微信支付二维码" width={220} height={220} /><span>使用微信扫一扫付款</span></div>
          ) : null}
          {onlineCanPay && onlineOrder.paymentUrl ? (
            <Button icon={<ArrowUpRight size={17} />} onClick={() => window.location.assign(onlineOrder.paymentUrl!)}>前往支付宝付款</Button>
          ) : null}
          {onlineCanPay ? <p className="workspaceCheckoutStatus"><Clock3 size={15} /> 等待付款，自动查询中</p> : null}
          <dl>
            <div><dt>订单号</dt><dd>{onlineOrder.outTradeNo}</dd></div>
            <div><dt>支付金额</dt><dd>¥{(onlineOrder.amountMicros / 1_000_000).toLocaleString("zh-CN")}</dd></div>
            <div><dt>{onlineOrder.membership ? "每期赠额" : onlineOrder.status === "paid" ? "已到账" : onlineOrder.status === "refunded" ? "已退回 GU" : "订单额度"}</dt><dd>{onlineOrder.membership ? `每月 ${onlineOrder.membership.seedanceGu.toLocaleString("zh-CN")} GU Seedance + ${onlineOrder.membership.h3Gu.toLocaleString("zh-CN")} GU H3，共 ${onlineOrder.membership.months} 期` : `${onlineOrder.creditedGu.toLocaleString("zh-CN")} GU`}</dd></div>
            <div><dt>状态</dt><dd>{onlinePaymentStatus(onlineOrder.status).label}</dd></div>
          </dl>
          {onlineOrder.status === "paid" ? (
            <Button variant="ghost" loading={submitting} disabled={!canSubmitBilling} onClick={() => void requestOnlineRefund()}>
              {onlineOrder.membership ? "申请退回本单会员" : "退回本单未使用充值"}
            </Button>
          ) : null}
          {submitError ? <Alert tone="danger">{submitError}</Alert> : null}
        </div>
      ) : createdRequestId ? (
        <div className="workspaceRechargeSuccess">
          <span><CheckCircle2 size={30} strokeWidth={1.7} /></span>
          <h3>申请提交成功</h3>
          <p>本次申请充值 {guAmount?.toLocaleString("zh-CN") ?? "—"} GU，款项由 {config?.operatorName || "当前入口运营主体"} 收取，请按照付款信息完成转账并等待财务审核。</p>
          <dl>
            <div><dt>申请编号</dt><dd>{createdRequestId}</dd></div>
            <div><dt>收款主体</dt><dd>{config?.operatorName || "—"}</dd></div>
            <div><dt>充值金额</dt><dd>¥{amount.toLocaleString("zh-CN")}</dd></div>
            <div><dt>预计到账</dt><dd>{guAmount?.toLocaleString("zh-CN") ?? "—"} GU</dd></div>
          </dl>
        </div>
      ) : view === "orders" ? (
        <div className="workspaceRechargeOrderHistory">
          <p>查看充值订单，继续付款或确认到账结果。可加载更早记录。</p>
          {recentOnlineOrdersLoading ? <p>正在读取订单…</p> : recentOnlineOrdersError ? <Alert tone="danger">{recentOnlineOrdersError}</Alert> : recentOnlineOrders.length ? <div className="workspaceRechargeRecentList">
            {recentOnlineOrders.map(order => {
              const status = onlinePaymentStatus(order.status);
              return <button key={order.id} type="button" className="workspaceRechargeRecentOrder" onClick={() => { setSubmitError(""); setOnlineOrder(order); }}>
                <span><strong>¥{(order.amountMicros / 1_000_000).toLocaleString("zh-CN")}</strong><small>{order.outTradeNo}</small><small>{formatDate(order.createdAt)}</small></span>
                <Badge tone={status.tone}>{status.label}</Badge><ChevronRight size={17} />
              </button>;
            })}
          </div> : <EmptyState icon={CreditCard} title="暂无线上订单" description="完成充值后，可在这里查看订单与到账状态。" />}
          {orderCursor && <Button variant="secondary" disabled={historyLoading} onClick={() => void loadHistory("online")}>{historyLoading ? "正在读取…" : "加载更早订单"}</Button>}
          {historyError && <Alert tone="danger">{historyError}</Alert>}
          <h3>线下充值申请</h3>
          {recentRequestsLoading ? <p>正在读取申请…</p> : recentRequestsError ? <Alert tone="danger">{recentRequestsError}</Alert> : recentRequests.length ? <div className="workspaceRechargeRecentList">
            {recentRequests.map(request => <div key={request.id}><span><strong>¥{(request.amountMicros / 1_000_000).toLocaleString("zh-CN")}</strong><small>{formatDate(request.createdAt)}</small></span><Badge tone={rechargeRequestStatus(request.status).tone}>{rechargeRequestStatus(request.status).label}</Badge></div>)}
          </div> : <p>暂无充值申请。</p>}
          {requestsHasMore && <Button variant="secondary" disabled={historyLoading} onClick={() => void loadHistory("offline")}>{historyLoading ? "正在读取…" : "加载更早申请"}</Button>}
        </div>
      ) : configLoading ? (
        <EmptyState
          icon={CreditCard}
          title="正在读取充值配置"
          description="正在确认当前工作区真实可用的付款方式和兑换比例。"
        />
      ) : configError ? (
        <div>
          <Alert tone="danger" title="充值配置读取失败">{configError}</Alert>
          <EmptyState
            icon={CreditCard}
            title="暂时无法充值"
            description="未获得真实充值配置，因此不会展示默认金额、兑换比例或模拟付款方式。"
          />
        </div>
      ) : !config ? (
        <EmptyState
          icon={CreditCard}
          title="充值配置不可用"
          description="当前工作区未返回可用的充值配置。"
        />
      ) : !config.rechargeEnabled ? (
        <EmptyState
          icon={CreditCard}
          title="当前入口暂未开放充值"
          description={`${config.sellerTenantName}入口的收款和结算配置尚未启用；已有 GU、创作数据和工具使用不受影响。`}
        />
      ) : view === "membership" ? (
        <>
          <MembershipPanel state={config.membershipState} workspaceId={String(currentWorkspaceId || currentWorkspace?.id || "")}
            canPay={config.channels.some(channel => channel.method === "online")} submitting={submitting} onQuoteChange={setMembershipQuote} />
          {submitError ? <Alert tone="danger">{submitError}</Alert> : null}
        </>
      ) : availableChannels.length === 0 ? (
        <EmptyState
          icon={CreditCard}
          title="暂无可用的充值方式"
          description={unavailableChannels.length
            ? `${unavailableChannels.map((channel) => channel.name).join("、")} 当前需通过其他已批准的付款流程办理；本页不会生成付款码。`
            : "管理员尚未配置可用的付款渠道。"}
        />
      ) : (
        <>
          <div className="workspaceRechargeIdentity" aria-label="充值账户概览">
            <span className="workspaceRechargeIdentityIcon"><Building2 size={21} /></span>
            <div><strong>{currentWorkspace?.name || "当前工作区"}</strong><small>工作区共享额度</small></div>
            <div className="workspaceRechargeBalance"><small>当前余额</small><strong>{availableMicros !== null && Number.isFinite(availableMicros) ? formatGu(availableMicros, "down") : "—"}</strong></div>
          </div>
          <div className="rechargeCenterIntro"><h3>为下一份灵感，补充创作能量</h3><p>通用积分永久有效，按模型实际用量扣减。</p><span><CheckCircle2 size={15} />一次充值，持续创作</span></div>
          <div className="workspaceRechargeBody">
          <div className="workspaceRechargeMain">

            {unavailableChannels.length > 0 ? (
              <Alert tone="neutral" title="部分渠道暂不可在此页面使用">
                {unavailableChannels.map((channel) => channel.name).join("、")} 请通过对应的已批准付款流程办理；本页不会展示或生成付款码。
              </Alert>
            ) : null}

            <section className="workspaceRechargeSection" aria-labelledby="workspace-recharge-amount">
              <div className="workspaceRechargeSectionHeading">
                <span>1</span>
                <div>
                  <h3 id="workspace-recharge-amount">选择积分套餐</h3>
                  <p>¥1 = {config.guPerYuan.toLocaleString("zh-CN")} GU</p>
                </div>
              </div>
              {(config.packages?.length || 0) > 0 ? (
                <div>
                  <p>积分包与会员 · 模型按官方刊例价计费，购买时享受赠分</p>
                  {config.membership ? <p>{config.membership.name} · {config.membership.active ? "有效至" : "已到期"} {new Date(config.membership.expiresAt).toLocaleDateString("zh-CN")}，本金余额永久保留</p> : null}
                  <div className="workspaceRechargeAmounts">
                    {config.packages!.filter(pack => pack.kind === "credits" || pack.id === selectedPackageId).map((pack) => (
                      <button key={pack.id} type="button" className={selectedPackageId === pack.id ? "is-selected" : ""} aria-pressed={selectedPackageId === pack.id}
                        onClick={() => { setSelectedPackageId(pack.id); setSelectedAmount(pack.priceYuan); setCustomAmount(""); setSelectedChannelKey(availableChannels.find((channel) => channel.method === "online")?.key || ""); setPaymentAttemptKey(globalThis.crypto.randomUUID()); }}>
                        <span>{pack.name}</span><strong>¥{pack.priceYuan}</strong><span>{pack.creditsGu.toLocaleString("zh-CN")} GU</span>
                        <span className="rechargeCardValidity">{pack.kind === "membership" ? `本金 ${(pack.creditsGu - pack.giftGu).toLocaleString("zh-CN")} GU 永久 + 赠送 ${pack.giftGu} GU（一年有效）` : "全部积分永久有效"}</span>
                      </button>
                    ))}
                  </div>
                  <p>月会员不自动续费；会员到期不清余额。会员赠分自到账起一年内有效，优先消费。整单退款须本金与赠分均未使用，退款时一并退回。</p>
                </div>
              ) : null}
              {config.amountOptions.length > 0 ? (
                <div className="workspaceRechargeAmounts">
                  {config.amountOptions.map((option) => {
                    const selected = !selectedPackageId && !customAmount && selectedAmount === option;
                    return (
                      <button
                        key={option}
                        type="button"
                        className={selected ? "is-selected" : ""}
                        aria-pressed={selected}
                        onClick={() => {
                          setCustomAmount("");
                          setSelectedAmount(option);
                          setSelectedPackageId("");
                          setPaymentAttemptKey(globalThis.crypto.randomUUID());
                        }}
                      >
                        {selected ? <CheckCircle2 className="workspaceRechargeSelectedMark" size={18} aria-hidden="true" /> : null}
                        <span className="rechargeCardTitle">通用积分</span>
                        <strong>¥{option.toLocaleString("zh-CN")}</strong>
                        <span className="rechargeCardCredits">{Math.round(option * config.guPerYuan).toLocaleString("zh-CN")} <small>GU</small></span>
                        <span className="rechargeCardValidity">永久有效</span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <Alert tone="neutral">当前未配置快捷充值金额，请填写自定义金额。</Alert>
              )}
              <details className="workspaceRechargeDisclosure" open={!config.amountOptions.length || undefined}>
              <summary>自定义充值金额</summary>
              <FormField
                label="自定义金额"
                help={`请输入不少于 ¥${config.minTopupYuan.toLocaleString("zh-CN")} 的整数金额`}
                error={customAmount && !amountValid ? `最低充值金额为 ¥${config.minTopupYuan.toLocaleString("zh-CN")}` : undefined}
              >
                <Input
                  type="number"
                  inputMode="numeric"
                  min={config.minTopupYuan}
                  step={1}
                  value={customAmount}
                  placeholder={`最低 ¥${config.minTopupYuan.toLocaleString("zh-CN")}`}
                  startIcon={<span>¥</span>}
                  onChange={(event) => {
                    setCustomAmount(event.currentTarget.value);
                    setSelectedPackageId("");
                    setPaymentAttemptKey(globalThis.crypto.randomUUID());
                  }}
                />
              </FormField>
              </details>
            </section>
            <p className="workspaceRechargeOperator">收款方：{config.operatorName}</p>
            <details className="workspaceRechargeDisclosure workspaceRechargeRules">
              <summary>充值说明</summary>
              <p>最低充值 ¥{config.minTopupYuan.toLocaleString("zh-CN")}。由 {config.operatorName} 负责收款、开票与退款。</p>
              {config.settlementNote ? <p>{config.settlementNote}</p> : null}
              <p>支付成功后到账；可在订单记录中查看付款与退款状态。</p>
            </details>
          </div>
          <aside className="workspaceRechargeSummary workspaceRechargePayment">
            <div className="workspaceRechargeCreditPreview" aria-live="polite"><span>本次到账</span><strong>{guAmount?.toLocaleString("zh-CN") ?? "—"} <small>GU</small></strong><p>{selectedPackage?.kind === "membership" ? "本金永久有效，会员赠分一年有效" : "通用积分 · 永久有效"}</p></div>
            <section className="workspaceRechargeSection" aria-labelledby="workspace-recharge-method">
              <div className="workspaceRechargeSectionHeading">
                <span>2</span>
                <div>
                  <h3 id="workspace-recharge-method">付款方式</h3>
                  <p>{selectedChannel?.method === "online" ? "确认支付成功后到账" : "提交后由财务核验付款并入账"}</p>
                </div>
              </div>
              <div className="workspaceRechargeMethodGrid">
                {availableChannels.map((channel) => {
                  const selected = selectedChannel?.key === channel.key;
                  return (
                    <button
                      key={channel.key}
                      type="button"
                      className={selected ? "is-selected" : ""}
                      aria-pressed={selected}
                      onClick={() => {
                        setSelectedChannelKey(channel.key);
                        setPaymentAttemptKey(globalThis.crypto.randomUUID());
                      }}
                    >
                      <span className={`workspaceRechargeMethodIcon workspaceRechargeMethodIcon--${channel.method}`}>
                        {channel.method === "online" ? <CreditCard size={21} strokeWidth={1.7} /> : <Landmark size={21} strokeWidth={1.7} />}
                      </span>
                      <span><strong>{channel.name}</strong>{channel.remark ? <small>{channel.remark}</small> : null}</span>
                      <Badge tone={channel.method === "online" ? "success" : "warning"}>{channel.method === "online" ? "即时到账" : "线下审核"}</Badge>
                    </button>
                  );
                })}
              </div>

              {selectedChannel?.method === "offline" ? <div className="workspaceRechargeOfflineFields">
                {selectedChannel && (selectedChannel.accountName || selectedChannel.accountNo || selectedChannel.bankName) ? (
                  <dl className="workspaceRechargeBankDetails">
                    {selectedChannel.accountName ? <div><dt>账户名称</dt><dd>{selectedChannel.accountName}</dd></div> : null}
                    {selectedChannel.bankName ? <div><dt>开户银行</dt><dd>{selectedChannel.bankName}</dd></div> : null}
                    {selectedChannel.accountNo ? <div><dt>银行账号</dt><dd>{selectedChannel.accountNo}</dd></div> : null}
                  </dl>
                ) : null}

                {selectedChannel?.qrCodeUrl ? (
                  <div className="workspaceRechargeBankDetails">
                    <strong>收款码</strong>
                    <img
                      src={selectedChannel.qrCodeUrl}
                      alt={`${selectedChannel.name}收款码`}
                      style={{ display: "block", width: "min(12rem, 100%)", marginTop: "0.75rem" }}
                    />
                  </div>
                ) : null}

                <div className="workspaceRechargeContactGrid">
                  <FormField label="联系人">
                    <Input value={contactName} placeholder="付款联系人姓名" onChange={(event) => setContactName(event.currentTarget.value)} />
                  </FormField>
                  <FormField label="联系电话">
                    <Input type="tel" autoComplete="tel" value={contactPhone} placeholder="便于财务核对" onChange={(event) => setContactPhone(event.currentTarget.value)} />
                  </FormField>
                </div>
                <FormField label="付款备注">
                  <textarea
                    className="workspaceRechargeNote"
                    rows={3}
                    value={note}
                    placeholder="可填写付款账户、转账时间或其他核对信息"
                    onChange={(event) => setNote(event.currentTarget.value)}
                  />
                </FormField>
              </div> : (
                <p className="workspaceRechargePaymentHint">付款结果自动更新。如遇网络中断，可从“订单记录”继续查看。</p>
              )}
            </section>

            {submitError ? <Alert tone="danger" title="提交失败">{submitError}</Alert> : null}
          </aside>
        </div>
        <section className="rechargeCenterRules" aria-label="积分使用说明">
          <div><Coins size={20} /><h3>充值积分，永久有效</h3><p>非会员也可单独购买。会员到期后，已充值的通用积分仍可使用。</p></div>
          <div><CreditCard size={20} /><h3>付款与到账，随时查看</h3><p>支付结果自动更新；中途关闭页面后，可从订单记录继续查看。</p></div>
        </section>
        </>
      )}
      </div>
      </Dialog>
      <ConfirmDialog
        open={open && refundConfirmationOpen && onlineOrder?.status === "paid"}
        title="退回本单未使用充值？"
        description={onlineOrder?.membership ? "仅当本单已发赠额全部未使用、未冻结时可整单退款。退款成功后收回本单赠额，并停止后续发放；其他会员订单按原定日期生效。" : "仅当本单充值的 GU 全部未使用、未冻结时，才能整单原路退款。退款成功后会冲减对应 GU。"}
        confirmLabel="确认原路退款"
        tone="danger"
        loading={submitting}
        onCancel={() => setRefundConfirmationOpen(false)}
        onConfirm={confirmOnlineRefund}
        onConfirmError={(error) => toast({
          title: "退款申请失败",
          message: error instanceof Error ? error.message : "请稍后重试。",
          tone: "danger",
        })}
      />
    </>
  );
}

function rechargeRequestStatus(status: string): { label: string; tone: "neutral" | "info" | "success" | "warning" | "danger" } {
  if (status === "approved" || status === "issued") return { label: "已到账", tone: "success" };
  if (status === "rejected") return { label: "未通过", tone: "danger" };
  if (status === "cancelled") return { label: "已取消", tone: "neutral" };
  return { label: "审核中", tone: "warning" };
}

function onlinePaymentStatus(status: OnlinePaymentOrder["status"]): {
  title: string;
  label: string;
  tone: "neutral" | "info" | "success" | "warning" | "danger";
} {
  if (status === "paid") return { title: "支付成功，GU 已到账", label: "已到账", tone: "success" };
  if (status === "refunded") return { title: "本单已退款", label: "已退款", tone: "neutral" };
  if (status === "refunding") return { title: "退款处理中", label: "退款中", tone: "warning" };
  if (status === "failed") return { title: "支付订单创建失败", label: "失败", tone: "danger" };
  if (status === "closed") return { title: "支付订单已关闭", label: "已关闭", tone: "neutral" };
  if (status === "pending_reconcile") return { title: "正在核对支付结果", label: "核对中", tone: "warning" };
  return { title: "请完成支付", label: "等待付款", tone: "info" };
}

function NavigateAction({ path }: { path: string }) {
  const navigate = useNavigate();
  return (
    <Button
      variant="ghost"
      size="compact"
      icon={<ChevronRight size={16} strokeWidth={1.75} />}
      iconPosition="end"
      onClick={() => navigate(path)}
    >
      进入
    </Button>
  );
}
