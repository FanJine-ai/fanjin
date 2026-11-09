import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Activity,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Edit3,
  Eye,
  Plus,
  RefreshCcw,
  ToggleLeft,
} from "lucide-react";
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
  Drawer,
  FilterBar,
  Input,
  MetricStrip,
  Select,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  useToast,
  type BadgeTone,
  type DataTableColumn,
} from "../../../ui/console";
import {
  checkProviderChannelHealth,
  discoverProviderChannelModels,
  providerFormErrorsFromApiError,
  saveProviderChannel,
  setProviderChannelDisabled,
  testProviderChannelDraft,
} from "./api";
import { useProviderChannels } from "./hooks";
import { ProviderFormDrawer } from "./ProviderFormDrawer";
import {
  buildProviderPayload,
  buildProviderHealthDraft,
  createFanjinProviderForm,
  endpointLabels,
  providerFormFromChannel,
  providerLabels,
  providerOptions,
  scopeLabels,
  type ProviderChannel,
  type ProviderChannelEndpoint,
  type ProviderChannelForm,
  type ProviderChannelFormErrors,
  type ProviderChannelProvider,
  type ProviderChannelScope,
} from "./types";
import "./providers.css";

interface ProviderRow {
  id: string;
  source: ProviderChannel;
  name: string;
  provider: string;
  scope: string;
  capability: string;
  modelCount: number;
  models: string[];
  priority: number;
  weight: number;
  healthStatus: string;
  healthTime: string;
  healthLatency: string;
  healthError: string;
  status: "enabled" | "disabled";
}

interface ProviderListState {
  query: string;
  provider: string;
  status: string;
  page: number;
  pageSize: number;
}

type ProviderListStateUpdater = (current: ProviderListState) => ProviderListState;

const providerStatusFilters = ["enabled", "disabled", "ok", "degraded", "failed", "stale", "unchecked"] as const;
const providerPageSizes = [20, 50, 100] as const;

function positiveInteger(value: string | null, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readProviderListState(params: URLSearchParams): ProviderListState {
  const provider = params.get("provider") || "";
  const status = params.get("status") || "";
  const requestedPageSize = positiveInteger(params.get("size"), 20);
  return {
    query: params.get("q") || "",
    provider: providerOptions.includes(provider as ProviderChannelProvider) ? provider : "",
    status: providerStatusFilters.includes(status as (typeof providerStatusFilters)[number]) ? status : "",
    page: positiveInteger(params.get("page"), 1),
    pageSize: providerPageSizes.includes(requestedPageSize as (typeof providerPageSizes)[number]) ? requestedPageSize : 20,
  };
}

function providerListStateToParams(state: ProviderListState) {
  const params = new URLSearchParams();
  if (state.query.trim()) params.set("q", state.query);
  if (state.provider) params.set("provider", state.provider);
  if (state.status) params.set("status", state.status);
  if (state.page > 1) params.set("page", String(state.page));
  if (state.pageSize !== 20) params.set("size", String(state.pageSize));
  return params;
}

function formatDate(value?: string | number | null) {
  if (!value) return "未检查";
  const date = new Date(typeof value === "number" && value < 10_000_000_000 ? value * 1000 : value);
  if (Number.isNaN(date.getTime())) return "未检查";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function providerName(value: ProviderChannel["provider"]) {
  return providerLabels[value as ProviderChannelProvider] || String(value || "未知供应商");
}

function endpointName(value: ProviderChannel["endpointType"]) {
  return endpointLabels[value as ProviderChannelEndpoint] || String(value || "未知能力");
}

function scopeName(channel: ProviderChannel) {
  const scope = scopeLabels[channel.scope as ProviderChannelScope] || "平台";
  return channel.scope === "workspace" && channel.workspaceId ? `${scope} · ${channel.workspaceId}` : scope;
}

function healthPresentation(status: string): { label: string; tone: BadgeTone; icon: ReactNode } {
  if (status === "ok") return { label: "健康", tone: "success", icon: <CheckCircle2 size={14} /> };
  if (status === "degraded") return { label: "降级", tone: "warning", icon: <CircleAlert size={14} /> };
  if (status === "failed") return { label: "失败", tone: "danger", icon: <CircleAlert size={14} /> };
  if (status === "disabled") return { label: "停用", tone: "neutral", icon: <ToggleLeft size={14} /> };
  if (status === "stale") return { label: "已过期", tone: "warning", icon: <CircleAlert size={14} /> };
  if (status === "unchecked") return { label: "待检查", tone: "warning", icon: <Activity size={14} /> };
  return { label: "未检查", tone: "warning", icon: <Activity size={14} /> };
}

function toRow(channel: ProviderChannel, index: number): ProviderRow {
  const models = Array.isArray(channel.modelNames)
    ? channel.modelNames.map(String)
    : typeof channel.modelNames === "string"
      ? channel.modelNames.split(/[\n,]/).map((item) => item.trim()).filter(Boolean)
      : [];
  const healthStatus = String(channel.healthStatus || channel.health?.status || (channel.disabled ? "disabled" : ""));
  const checkedAt = channel.lastHealthCheckAt || channel.health?.checkedAt;
  const latency = channel.lastHealthLatencyMs ?? channel.health?.latencyMs;
  return {
    id: String(channel.id || channel.name || index),
    source: channel,
    name: String(channel.name || channel.channelName || channel.provider || "未命名通道"),
    provider: providerName(channel.provider),
    scope: scopeName(channel),
    capability: endpointName(channel.endpointType),
    modelCount: models.length,
    models,
    priority: Number(channel.priority ?? 100),
    weight: Number(channel.weight ?? 1),
    healthStatus,
    healthTime: formatDate(checkedAt),
    healthLatency: latency == null ? "-" : `${latency} ms`,
    healthError: String(channel.lastHealthError || channel.health?.errorMessage || ""),
    status: channel.disabled ? "disabled" : "enabled",
  };
}

export function ProviderChannelsPage() {
  const { channels, loading, error, reload } = useProviderChannels();
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const paramsKey = searchParams.toString();
  const listState = useMemo(() => readProviderListState(searchParams), [paramsKey]);
  const { query, provider: providerFilter, status: statusFilter, page, pageSize } = listState;
  const listStateRef = useRef(listState);
  listStateRef.current = listState;
  const pageSizeRef = useRef(pageSize);
  pageSizeRef.current = pageSize;
  const [editorOpen, setEditorOpen] = useState(false);
  const [form, setForm] = useState<ProviderChannelForm>(() => createFanjinProviderForm());
  const [initialForm, setInitialForm] = useState<ProviderChannelForm>(() => createFanjinProviderForm());
  const [formError, setFormError] = useState("");
  const [formFieldErrors, setFormFieldErrors] = useState<ProviderChannelFormErrors>({});
  const [saving, setSaving] = useState(false);
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [testingForm, setTestingForm] = useState(false);
  const [discoveringModels, setDiscoveringModels] = useState(false);
  const [detailRow, setDetailRow] = useState<ProviderRow | null>(null);
  const [confirmState, setConfirmState] = useState<{ row: ProviderRow; disabled: boolean } | null>(null);

  const allRows = useMemo(() => channels.map(toRow), [channels]);
  const rows = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return allRows.filter((row) => {
      const matchesQuery = !needle || [row.name, row.provider, row.scope, row.capability, ...row.models]
        .some((value) => value.toLocaleLowerCase().includes(needle));
      const matchesProvider = !providerFilter || row.source.provider === providerFilter;
      const matchesStatus = !statusFilter || row.status === statusFilter || row.healthStatus === statusFilter;
      return matchesQuery && matchesProvider && matchesStatus;
    });
  }, [allRows, providerFilter, query, statusFilter]);
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));

  function updateListState(updater: ProviderListStateUpdater, replace = false) {
    const next = updater(listStateRef.current);
    listStateRef.current = next;
    setSearchParams(providerListStateToParams(next), { replace });
  }

  function updateFilters(patch: Partial<Pick<ProviderListState, "query" | "provider" | "status">>, replace = false) {
    updateListState((current) => ({ ...current, ...patch, page: 1 }), replace);
  }

  useEffect(() => {
    if (loading || page <= totalPages) return;
    updateListState((current) => ({ ...current, page: Math.min(current.page, totalPages) }), true);
  }, [loading, page, paramsKey, totalPages]);

  const openCreate = () => {
    const next = createFanjinProviderForm();
    setForm(next);
    setInitialForm({ ...next, modelNames: [...next.modelNames] });
    setFormError("");
    setFormFieldErrors({});
    setEditorOpen(true);
  };

  const openEdit = (channel: ProviderChannel) => {
    const next = providerFormFromChannel(channel);
    setForm(next);
    setInitialForm({ ...next, modelNames: [...next.modelNames] });
    setFormError("");
    setFormFieldErrors({});
    setEditorOpen(true);
  };

  const save = async () => {
    setSaving(true);
    setFormError("");
    try {
      await saveProviderChannel(form.id, buildProviderPayload(form));
      toast({ title: form.id ? "供应商通道已更新" : "供应商通道已创建", tone: "success" });
      setEditorOpen(false);
      await reload();
    } catch (caught: unknown) {
      const message = caught instanceof Error ? caught.message : "供应商通道保存失败";
      setFormError(message);
      setFormFieldErrors(providerFormErrorsFromApiError(caught));
    } finally {
      setSaving(false);
    }
  };

  const checkHealth = async (row: ProviderRow, live: boolean) => {
    setCheckingId(row.id);
    try {
      const result = await checkProviderChannelHealth(row.id, live);
      const passed = result.healthStatus === "ok";
      const unavailable = result.healthStatus === "failed" || result.healthStatus === "degraded";
      toast({
        title: live
          ? passed ? "连接测试通过" : unavailable ? "连接测试未通过" : "连接测试已跳过"
          : "配置检查完成",
        message: result.lastHealthError || `已检查「${row.name}」`,
        tone: passed ? "success" : unavailable ? "danger" : "warning",
      });
      await reload();
    } catch (caught: unknown) {
      toast({
        title: live ? "连接测试失败" : "健康检查失败",
        message: caught instanceof Error ? caught.message : "请稍后重试",
        tone: "danger",
      });
    } finally {
      setCheckingId(null);
    }
  };

  const testCurrentConnection = async () => {
    setTestingForm(true);
    try {
      const result = await testProviderChannelDraft(buildProviderHealthDraft(form));
      const passed = result.healthStatus === "ok";
      const unavailable = result.healthStatus === "failed" || result.healthStatus === "degraded";
      toast({
        title: passed ? "连接测试通过" : unavailable ? "连接测试未通过" : "连接测试已跳过",
        message: result.lastHealthError || "当前表单中的连接配置可用，配置尚未保存。",
        tone: passed ? "success" : unavailable ? "danger" : "warning",
      });
    } catch (caught: unknown) {
      toast({
        title: "连接测试失败",
        message: caught instanceof Error ? caught.message : "请稍后重试",
        tone: "danger",
      });
    } finally {
      setTestingForm(false);
    }
  };

  const discoverCurrentModels = async () => {
    setDiscoveringModels(true);
    try {
      return await discoverProviderChannelModels(buildProviderHealthDraft(form));
    } finally {
      setDiscoveringModels(false);
    }
  };

  const columns = useMemo<DataTableColumn<ProviderRow>[]>(() => [
    {
      id: "channel",
      header: "通道",
      sortable: true,
      priority: "primary",
      minWidth: "210px",
      sortValue: (row) => row.name,
      cell: (row) => (
        <div className="providerChannelCell">
          <strong>{row.name}</strong>
          <span>{row.provider} · {row.scope}</span>
        </div>
      ),
    },
    {
      id: "capability",
      header: "能力",
      priority: "secondary",
      accessor: "capability",
      cell: (row) => <Badge tone="info">{row.capability}</Badge>,
    },
    { id: "modelCount", header: "模型数", priority: "detail", align: "end", sortable: true, accessor: "modelCount" },
    {
      id: "route",
      header: "路由",
      headerLabel: "路由优先级和权重",
      priority: "secondary",
      sortValue: (row) => row.priority,
      sortable: true,
      cell: (row) => <span className="adminFeatureNumeric">P{row.priority} · W{row.weight}</span>,
    },
    {
      id: "health",
      header: "健康",
      priority: "primary",
      sortValue: (row) => row.healthStatus,
      sortable: true,
      cell: (row) => {
        const health = healthPresentation(row.healthStatus);
        return (
          <div className="providerHealthCell">
            <Badge tone={health.tone} icon={health.icon}>{health.label}</Badge>
            {row.healthError && (
              <Tooltip>
                <TooltipTrigger className="providerHealthError">{row.healthError}</TooltipTrigger>
                <TooltipContent align="start">{row.healthError}</TooltipContent>
              </Tooltip>
            )}
          </div>
        );
      },
    },
    {
      id: "status",
      header: "状态",
      priority: "secondary",
      sortValue: (row) => row.status,
      sortable: true,
      cell: (row) => <Badge tone={row.status === "enabled" ? "success" : "neutral"}>{row.status === "enabled" ? "启用" : "停用"}</Badge>,
    },
    { id: "lastCheck", header: "最近检查", priority: "detail", accessor: "healthTime", minWidth: "150px" },
    {
      id: "actions",
      header: "操作",
      priority: "primary",
      hideable: false,
      minWidth: "190px",
      cell: (row) => (
        <div className="adminFeatureRowActions">
          <Button
            variant="secondary"
            size="compact"
            loading={checkingId === row.id}
            disabled={Boolean(checkingId)}
            onClick={() => void checkHealth(row, true)}
          >
            探测
          </Button>
          <span className="adminFeatureMoreMenu">
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label={`更多操作：${row.name}`}
                render={(
                  <Button
                    variant="secondary"
                    size="compact"
                    icon={<ChevronDown aria-hidden="true" size={15} />}
                    iconPosition="end"
                  />
                )}
              >
                更多
              </DropdownMenuTrigger>
              <DropdownMenuContent className="adminFeatureMoreMenu" align="end">
                <DropdownMenuItem nativeButton role="button" render={<button type="button" />} onClick={() => openEdit(row.source)}><Edit3 aria-hidden="true" size={16} />编辑通道</DropdownMenuItem>
                <DropdownMenuItem nativeButton role="button" render={<button type="button" />} onClick={() => setDetailRow(row)}><Eye aria-hidden="true" size={16} />查看详情</DropdownMenuItem>
                <DropdownMenuItem
                  nativeButton
                  role="button"
                  render={<button type="button" />}
                  tone={row.status === "enabled" ? "danger" : "default"}
                  onClick={() => setConfirmState({ row, disabled: row.status === "enabled" })}
                >
                  <ToggleLeft aria-hidden="true" size={16} />{row.status === "enabled" ? "停用通道" : "启用通道"}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
        </div>
      ),
    },
  ], [checkingId]);

  const healthy = allRows.filter((row) => row.healthStatus === "ok").length;
  const enabled = allRows.filter((row) => row.status === "enabled").length;
  const unhealthy = allRows.filter((row) => ["failed", "degraded", "stale", "unchecked"].includes(row.healthStatus)).length;

  return (
    <ConsolePage
      breadcrumbs={[{ label: "模型管理" }, { label: "供应商渠道" }]}
      title="供应商通道"
      description="接入上游服务并发现可用模型；完成后先配置模型路由，再设置对外价格。"
      primaryAction={<Button icon={<Plus size={18} />} onClick={openCreate}>新增通道</Button>}
      layoutWidth="dashboard"
    >

      <MetricStrip metrics={[
        { id: "total", label: "通道总数", value: loading ? "-" : allRows.length, hint: "包含停用通道" },
        { id: "enabled", label: "已启用", value: loading ? "-" : enabled, tone: "positive", hint: "当前参与路由" },
        { id: "healthy", label: "健康通道", value: loading ? "-" : healthy, tone: "info", hint: "最近检查状态正常" },
        { id: "unhealthy", label: "异常待处理", value: loading ? "-" : unhealthy, tone: unhealthy ? "danger" : "neutral", hint: "失败或降级" },
      ]} />

      <FilterBar
        actions={<Button variant="secondary" icon={<RefreshCcw size={17} />} loading={loading} onClick={() => void reload()}>刷新</Button>}
      >
        <Input aria-label="搜索供应商通道" placeholder="搜索名称、供应商、模型" value={query} onChange={(event) => updateFilters({ query: event.currentTarget.value }, true)} />
        <Select aria-label="按供应商筛选" value={providerFilter} onChange={(event) => updateFilters({ provider: event.currentTarget.value })}>
          <option value="">全部供应商</option>
          {providerOptions.map((provider) => <option value={provider} key={provider}>{providerLabels[provider]}</option>)}
        </Select>
        <Select aria-label="按状态筛选" value={statusFilter} onChange={(event) => updateFilters({ status: event.currentTarget.value })}>
          <option value="">全部状态</option>
          <option value="enabled">已启用</option>
          <option value="disabled">已停用</option>
          <option value="ok">健康</option>
          <option value="degraded">降级</option>
          <option value="failed">失败</option>
          <option value="stale">检查已过期</option>
          <option value="unchecked">待检查</option>
        </Select>
      </FilterBar>

      <DataTable
        rows={rows}
        columns={columns}
        getRowId={(row) => row.id}
        ariaLabel="供应商通道列表"
        loading={loading}
        error={error || undefined}
        onRetry={() => void reload()}
        emptyState={query || providerFilter || statusFilter ? "没有匹配当前筛选条件的通道" : "暂无供应商通道，请先新增通道"}
        onRowClick={setDetailRow}
        getRowAriaLabel={(row) => `查看供应商通道 ${row.name} 详情`}
        page={page}
        pageSize={pageSize}
        onPageChange={(nextPage) => updateListState((current) => ({ ...current, page: nextPage, pageSize: pageSizeRef.current }))}
        onPageSizeChange={(nextPageSize) => {
          pageSizeRef.current = nextPageSize;
          updateListState((current) => ({ ...current, page: 1, pageSize: nextPageSize }));
        }}
      />

      <ProviderFormDrawer
        open={editorOpen}
        form={form}
        initialForm={initialForm}
        saving={saving}
        testing={testingForm}
        discoveringModels={discoveringModels}
        error={formError}
        fieldErrors={formFieldErrors}
        onChange={(nextForm) => {
          setForm(nextForm);
          if (Object.keys(formFieldErrors).length > 0) setFormFieldErrors({});
        }}
        onSave={() => void save()}
        onTestConnection={() => void testCurrentConnection()}
        onDiscoverModels={discoverCurrentModels}
        onOpenChange={setEditorOpen}
      />

      <Drawer
        open={Boolean(detailRow)}
        title={detailRow?.name || "通道详情"}
        description="连接、凭据状态、完整模型和运行限制仅在详情中展示；密钥本身永不回显。"
        size="min(640px, 100vw)"
        onOpenChange={(open) => {
          if (!open) setDetailRow(null);
        }}
      >
        {detailRow && (
          <div className="adminFeatureDetails">
            <section><h3>基本信息</h3><dl>
              <div><dt>供应商</dt><dd>{detailRow.provider}</dd></div>
              <div><dt>范围</dt><dd>{detailRow.scope}</dd></div>
              <div><dt>能力</dt><dd>{detailRow.capability}</dd></div>
              <div><dt>状态</dt><dd>{detailRow.status === "enabled" ? "启用" : "停用"}</dd></div>
            </dl></section>
            <section><h3>连接与路由</h3><dl>
              <div><dt>Base URL</dt><dd><code>{detailRow.source.baseUrl || "未配置"}</code></dd></div>
              <div><dt>凭据状态</dt><dd>{detailRow.source.credentialConfigured || detailRow.source.credentialRef ? "已安全配置" : "未配置"}</dd></div>
              <div><dt>人像资产</dt><dd>{detailRow.source.portraitAssetsEnabled
                ? detailRow.source.portraitCredentialConfigured
                  ? `已启用 · 凭据代际 ${detailRow.source.portraitCredentialGeneration ?? "—"}`
                  : "已启用 · 凭据无效"
                : "未启用"}</dd></div>
              <div><dt>火山账号标识</dt><dd><code>{detailRow.source.providerAccountId || "未配置"}</code></dd></div>
              <div><dt>人像 ProjectName</dt><dd><code>{detailRow.source.assetsProjectName || "未配置"}</code></dd></div>
              <div><dt>ImageX 安全预检</dt><dd>{detailRow.source.imagexPortraitReviewEnabled
                ? detailRow.source.imagexReviewCredentialConfigured
                  ? `已启用 · 凭据代际 ${detailRow.source.imagexReviewCredentialGeneration ?? "—"}`
                  : "已启用 · 凭据无效"
                : "未启用"}</dd></div>
              {detailRow.source.credentialRef ? <div><dt>环境变量引用</dt><dd><code>{detailRow.source.credentialRef}</code></dd></div> : null}
              <div><dt>优先级 / 权重</dt><dd className="adminFeatureNumeric">{detailRow.priority} / {detailRow.weight}</dd></div>
              <div><dt>超时</dt><dd className="adminFeatureNumeric">{detailRow.source.timeoutMs ?? 600000} ms</dd></div>
              <div><dt>并发上限</dt><dd>{detailRow.source.concurrencyLimit == null ? "不限" : detailRow.source.concurrencyLimit}</dd></div>
            </dl></section>
            <section><h3>模型能力</h3><div className="providerDetailModels">
              {detailRow.models.length ? detailRow.models.map((model) => <code key={model}>{model}</code>) : <span>未配置模型</span>}
            </div></section>
            <section><h3>最近健康检查</h3><dl>
              <div><dt>检查时间</dt><dd>{detailRow.healthTime}</dd></div>
              <div><dt>延迟</dt><dd className="adminFeatureNumeric">{detailRow.healthLatency}</dd></div>
              <div><dt>错误</dt><dd>{detailRow.healthError || "无"}</dd></div>
              <div><dt>检查有效性</dt><dd>{detailRow.source.healthFreshness === "fresh" ? "有效" : detailRow.source.healthFreshness === "stale" ? "已过期，请重新探测" : "尚未执行探测"}</dd></div>
            </dl></section>
          </div>
        )}
      </Drawer>

      <ConfirmDialog
        open={Boolean(confirmState)}
        title={confirmState?.disabled ? "停用供应商通道" : "启用供应商通道"}
        description={confirmState?.disabled
          ? `停用「${confirmState.row.name}」后，该通道不再参与新请求路由。`
          : `启用「${confirmState?.row.name || ""}」后，该通道将按当前优先级和权重参与路由。`}
        confirmLabel={confirmState?.disabled ? "停用通道" : "启用通道"}
        tone={confirmState?.disabled ? "danger" : "default"}
        onCancel={() => setConfirmState(null)}
        onConfirm={async () => {
          if (!confirmState) return false;
          await setProviderChannelDisabled(confirmState.row.id, confirmState.disabled);
          toast({ title: confirmState.disabled ? "供应商通道已停用" : "供应商通道已启用", tone: "success" });
          await reload();
          return true;
        }}
        onConfirmError={(caught) => toast({
          title: "通道状态更新失败",
          message: caught instanceof Error ? caught.message : "请稍后重试",
          tone: "danger",
        })}
      />
    </ConsolePage>
  );
}
