import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Activity, Clapperboard, Pencil, Plus, RefreshCcw, Search } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import {
  Alert,
  Badge,
  Button,
  ConsolePage,
  DataTable,
  Drawer,
  FilterBar,
  FormField,
  Input,
  MetricStrip,
  Select,
  useToast,
  type DataTableColumn,
} from "../../../ui/console";
import { saveModelRouteGroup, simulateModelRouteGroup } from "./api";
import { useModelOperations } from "./hooks";
import { editableLogicalPriceRuleConfig } from "./pricingAudience";
import { ModelFlowNav } from "./ModelFlowNav";
import { emptyRouteGroupDraft, RouteGroupWizard } from "./RouteGroupWizard";
import {
  endpointLabels,
  microsToGu,
  type ModelPoolItem,
  type ModelPublicationStatus,
  type ModelRouteGroup,
  type ModelRouteGroupDraft,
} from "./types";
import "./styles.css";

const publicationLabels: Record<ModelPublicationStatus, { label: string; tone: "success" | "warning" | "danger" | "neutral" }> = {
  published: { label: "已发布", tone: "success" },
  degraded: { label: "降级可用", tone: "warning" },
  ready: { label: "待启用", tone: "neutral" },
  draft: { label: "草稿", tone: "neutral" },
  needs_attention: { label: "需要处理", tone: "danger" },
  unavailable: { label: "不可用", tone: "danger" },
};

function PublicationBadge({ status }: { status: ModelPublicationStatus }) {
  const value = publicationLabels[status];
  return <Badge tone={value.tone}>{value.label}</Badge>;
}

export interface ModelRouteGroupsPageProps {
  title?: string;
  description?: string;
  sectionNavigation?: ReactNode;
  onConfigureVideoRecipes?: (group: ModelRouteGroup) => void;
}

export function draftFromGroup(group: ModelRouteGroup): ModelRouteGroupDraft {
  return {
    existingGroupKey: group.groupKey,
    scope: group.scope,
    workspaceId: group.workspaceId,
    endpointType: group.endpointType,
    publicModel: group.publicModel,
    displayName: group.displayName,
    disabled: group.disabled,
    targets: group.targets.map((target) => ({
      id: target.id,
      channelId: target.channelId,
      upstreamModel: target.upstreamModel,
      tier: target.tier,
      trafficWeight: target.trafficWeight,
    })),
    pricing: group.pricing ? {
      unit: group.pricing.unit,
      unitPriceMicros: group.pricing.unitPriceMicros,
      currency: "GU",
      ruleConfig: editableLogicalPriceRuleConfig(group.pricing.ruleConfig),
    } : null,
  };
}

export default function ModelRouteGroupsPage({
  title = "模型路由",
  description = "一个公开模型对应一个逻辑路由组；组内配置多上游的优先层级、负载权重与首次售价。",
  sectionNavigation,
  onConfigureVideoRecipes,
}: ModelRouteGroupsPageProps = {}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const state = useModelOperations();
  const { toast } = useToast();
  const [query, setQuery] = useState("");
  const [endpointType, setEndpointType] = useState("");
  const [status, setStatus] = useState("");
  const [wizardDraft, setWizardDraft] = useState<ModelRouteGroupDraft | null>(null);
  const [wizardKey, setWizardKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [simulation, setSimulation] = useState<Awaited<ReturnType<typeof simulateModelRouteGroup>> | null>(null);
  const [simulating, setSimulating] = useState(false);

  useEffect(() => {
    const sourcePoolId = searchParams.get("sourcePoolId");
    if (!sourcePoolId || state.loading || wizardDraft) return;
    const source = state.pool.find((item) => item.poolId === sourcePoolId);
    if (!source) return;
    setWizardDraft(emptyRouteGroupDraft(source));
    setWizardKey((value) => value + 1);
    const next = new URLSearchParams(searchParams);
    next.delete("sourcePoolId");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, state.loading, state.pool, wizardDraft]);

  const endpoints = useMemo(() => [...new Set(state.groups.map((group) => group.endpointType))].sort(), [state.groups]);
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return state.groups.filter((group) => (
      (!needle || [group.publicModel, group.displayName, ...group.targets.flatMap((target) => [target.provider, target.channelName])].some((value) => value.toLowerCase().includes(needle)))
      && (!endpointType || group.endpointType === endpointType)
      && (!status || group.publication.status === status)
    ));
  }, [endpointType, query, state.groups, status]);
  const published = state.groups.filter((group) => ["published", "degraded"].includes(group.publication.status)).length;
  const targetCount = state.groups.reduce((sum, group) => sum + group.targets.length, 0);
  const unpriced = state.groups.filter((group) => !group.pricing).length;

  const openCreate = (source?: ModelPoolItem) => {
    setWizardDraft(emptyRouteGroupDraft(source));
    setWizardKey((value) => value + 1);
    setSaveError("");
  };
  const openEdit = (group: ModelRouteGroup) => {
    setWizardDraft(draftFromGroup(group));
    setWizardKey((value) => value + 1);
    setSaveError("");
  };
  const save = async (draft: ModelRouteGroupDraft) => {
    setSaving(true);
    setSaveError("");
    try {
      const saved = await saveModelRouteGroup(draft);
      toast({
        title: draft.existingGroupKey ? "模型路由已更新" : "模型路由已创建",
        message: `${saved.displayName} 已保存 ${saved.targets.length} 个上游目标和统一售价。`,
        tone: "success",
      });
      setWizardDraft(null);
      state.reload();
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : "模型路由组保存失败");
    } finally { setSaving(false); }
  };
  const simulate = async (group: ModelRouteGroup) => {
    setSimulating(true);
    try {
      setSimulation(await simulateModelRouteGroup(group.groupKey));
    } catch (caught) {
      toast({ title: "模拟失败", message: caught instanceof Error ? caught.message : "无法模拟当前路由", tone: "danger" });
    } finally { setSimulating(false); }
  };

  const columns = useMemo<DataTableColumn<ModelRouteGroup>[]>(() => [
    {
      id: "model", header: "逻辑模型", priority: "primary", sortable: true, minWidth: "230px",
      sortValue: (row) => row.publicModel,
      cell: (row) => <div className="modelOpsIdentity"><strong>{row.displayName}</strong><code>{row.publicModel}</code></div>,
    },
    {
      id: "capability", header: "能力", priority: "primary", sortable: true,
      sortValue: (row) => row.endpointType,
      cell: (row) => <div className="modelOpsIdentity"><strong>{endpointLabels[row.endpointType] || row.endpointType}</strong><span>{row.endpointType}</span></div>,
    },
    {
      id: "targets", header: "上游策略", priority: "primary", sortable: true,
      sortValue: (row) => row.targets.length,
      cell: (row) => <div className="modelOpsIdentity"><strong>{row.targets.length} 个目标</strong><span>{(["P0", "P1", "P2"] as const).map((tier) => { const count = row.targets.filter((target) => target.tier === tier).length; return count ? `${tier} ${count}` : ""; }).filter(Boolean).join(" · ")}</span></div>,
    },
    {
      id: "price", header: "统一售价", priority: "primary", sortable: true,
      sortValue: (row) => row.pricing?.unitPriceMicros || 0,
      cell: (row) => row.pricing ? <div className="modelOpsIdentity"><strong>{microsToGu(row.pricing.unitPriceMicros, row.pricing.unit)} GU</strong><span>{row.pricing.unit === "token" ? "每百万 Token" : row.pricing.unit}</span></div> : <Badge tone="warning">待设置</Badge>,
    },
    { id: "scope", header: "范围", priority: "secondary", cell: (row) => row.scope === "workspace" ? `工作区 · ${row.workspaceId}` : "平台" },
    { id: "status", header: "发布状态", priority: "primary", sortable: true, sortValue: (row) => row.publication.status, cell: (row) => <PublicationBadge status={row.publication.status} /> },
    {
      id: "actions", header: "操作", headerLabel: "行操作", priority: "primary", hideable: false, minWidth: "210px",
      cell: (row) => <div className="modelOpsRowActions">
        <Button size="compact" variant="secondary" icon={<Activity size={15} />} loading={simulating} onClick={(event) => { event.stopPropagation(); void simulate(row); }}>模拟</Button>
        <Button size="compact" variant="secondary" icon={<Pencil size={15} />} onClick={(event) => { event.stopPropagation(); openEdit(row); }}>编辑</Button>
        {row.endpointType === "video_generation" && onConfigureVideoRecipes ? <Button size="compact" variant="ghost" icon={<Clapperboard size={15} />} onClick={(event) => { event.stopPropagation(); onConfigureVideoRecipes(row); }}>配方</Button> : null}
      </div>,
    },
  ], [onConfigureVideoRecipes, simulating]);

  return (
    <ConsolePage
      title={title}
      description={description}
      primaryAction={<div className="modelOpsRowActions"><Button variant="secondary" icon={<RefreshCcw size={16} />} loading={state.loading} onClick={state.reload}>刷新</Button><Button icon={<Plus size={16} />} onClick={() => openCreate()}>添加模型路由</Button></div>}
      layoutWidth="dashboard"
    >
      {sectionNavigation}
      <ModelFlowNav active="route" />
      {state.groups.some((group) => group.publication.status === "needs_attention") ? <Alert tone="warning" title="历史路由需要确认">检测到展示名、能力或启停状态不一致的旧路由组；系统只读聚合，不会自动覆盖生产数据。</Alert> : null}
      <MetricStrip metrics={[
        { id: "groups", label: "逻辑模型", value: state.loading ? "-" : state.groups.length.toLocaleString(), hint: "列表每行一个公开模型" },
        { id: "targets", label: "上游目标", value: state.loading ? "-" : targetCount.toLocaleString(), hint: "参与负载或故障切换" },
        { id: "published", label: "用户侧可用", value: state.loading ? "-" : published.toLocaleString(), hint: "三端统一投影", tone: "positive" },
        { id: "unpriced", label: "待定价", value: state.loading ? "-" : unpriced.toLocaleString(), hint: "不会对用户展示" },
      ]} />
      <FilterBar actions={<Button icon={<Search size={16} />}>筛选</Button>}>
        <FormField label="模型、渠道或供应商" optionalLabel={null} className="modelOpsFilter--wide"><Input value={query} placeholder="搜索逻辑模型或上游" onChange={(event) => setQuery(event.currentTarget.value)} /></FormField>
        <FormField label="能力" optionalLabel={null}><Select value={endpointType} onChange={(event) => setEndpointType(event.currentTarget.value)}><option value="">全部能力</option>{endpoints.map((endpoint) => <option key={endpoint} value={endpoint}>{endpointLabels[endpoint] || endpoint}</option>)}</Select></FormField>
        <FormField label="发布状态" optionalLabel={null}><Select value={status} onChange={(event) => setStatus(event.currentTarget.value)}><option value="">全部状态</option>{Object.entries(publicationLabels).map(([value, config]) => <option key={value} value={value}>{config.label}</option>)}</Select></FormField>
      </FilterBar>
      <DataTable columns={columns} rows={rows} getRowId={(row) => row.groupKey} ariaLabel="逻辑模型路由列表" loading={state.loading} error={state.error || undefined} onRetry={state.reload} emptyState="尚未创建逻辑模型路由；请从模型池选择上游模型。" onRowClick={openEdit} getRowAriaLabel={(row) => `编辑逻辑模型 ${row.displayName}`} defaultSort={{ columnId: "model", direction: "ascending" }} />
      {wizardDraft ? <RouteGroupWizard key={wizardKey} open pool={state.pool} initialDraft={wizardDraft} saving={saving} serverError={saveError} onSave={(draft) => void save(draft)} onOpenChange={(open) => { if (!open && !saving) setWizardDraft(null); }} /> : null}
      <Drawer open={Boolean(simulation)} title="无副作用路由模拟" description="只计算当前健康、层级和权重，不请求上游、不产生费用。" size="min(640px, 100vw)" onOpenChange={(open) => { if (!open) setSimulation(null); }}>
        {simulation ? <div className="modelOpsSimulation"><Alert tone="info" title={`当前生效层级：${simulation.activeTier || "无"}`}>同层按归一化比例分流；只有该层全部不可用时才进入下一层。</Alert>{simulation.targets.map((target) => <div key={target.id}><span><strong>{target.channelName}</strong><small>{target.provider} · {target.tier}</small></span><Badge tone={target.selectedTier ? "success" : target.eligible ? "neutral" : "danger"}>{target.selectedTier ? `${target.normalizedTrafficPercent}%` : target.eligible ? "备用" : "过滤"}</Badge></div>)}</div> : null}
      </Drawer>
    </ConsolePage>
  );
}
