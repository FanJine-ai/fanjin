import { useEffect, useMemo, useRef, useState } from "react";
import { CircleDollarSign, EyeOff, Pencil, Plus, RefreshCcw, Save, Search, Tags, Trash2 } from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  ConsolePage,
  DataTable,
  Drawer,
  FieldGroup,
  FilterBar,
  FormField,
  Input,
  MetricStrip,
  NumberInput,
  Select,
  Switch,
  useToast,
  type DataTableColumn,
} from "../../../../ui/console";
import { unpublishModelRouteGroup } from "../../modelOperations/api";
import { useModelOperations } from "../../modelOperations/hooks";
import { ModelFlowNav } from "../../modelOperations/ModelFlowNav";
import {
  endpointLabels,
  endpointPricingUnits,
  guToMicros,
  microsToGu,
  type ModelRouteGroup,
  type ModelPublicationStatus,
} from "../../modelOperations/types";
import {
  discountedPriceMicros,
  discountLabel,
  editableLogicalPriceRuleConfig,
  pricingAudienceDraftFromRuleConfig,
  validatePricingAudienceDraft,
  writePricingAudienceDraft,
  type PricingAudienceDraft,
} from "../../modelOperations/pricingAudience";
import "../../modelOperations/styles.css";
import { PricingGroupManagerDrawer } from "../../pricingGroups/PricingGroupManagerDrawer";
import { usePricingGroups } from "../../pricingGroups/hooks";
import { updateLogicalModelPricing } from "./api";
import { ModelPricingEditor } from "./ModelPricingEditor";
import {
  buildDirectModelPricingPayload,
  isPricingEndpoint,
  pricingFormFromRule,
  type PricingRuleForm,
} from "./types";

const publicationLabels: Record<ModelPublicationStatus, { label: string; tone: "success" | "warning" | "danger" | "neutral" }> = {
  published: { label: "已发布", tone: "success" },
  degraded: { label: "降级可用", tone: "warning" },
  ready: { label: "待启用", tone: "neutral" },
  draft: { label: "草稿", tone: "neutral" },
  needs_attention: { label: "需要处理", tone: "danger" },
  unavailable: { label: "不可用", tone: "danger" },
};

function unitLabel(endpointType: string, unit: string) {
  return endpointPricingUnits[endpointType]?.find((candidate) => candidate.value === unit)?.label || unit;
}

function pricingFormForGroup(group: ModelRouteGroup): PricingRuleForm {
  const unit = group.pricing?.unit || endpointPricingUnits[group.endpointType]?.[0]?.value || "task";
  const providers = [...new Set(group.targets.map((target) => target.provider).filter(Boolean))];
  return pricingFormFromRule({
    id: group.pricing?.id || "",
    name: group.pricing?.name || `${group.displayName} 统一售价`,
    scope: group.scope,
    workspaceId: group.workspaceId,
    endpointType: group.endpointType,
    provider: providers.length === 1 ? providers[0] : null,
    model: group.publicModel,
    unit,
    unitPriceMicros: group.pricing?.unitPriceMicros || 0,
    currency: group.pricing?.currency || "GU",
    ruleConfig: editableLogicalPriceRuleConfig(group.pricing?.ruleConfig),
    disabled: group.pricing?.disabled || false,
  });
}

export function PricingRulesPage() {
  const state = useModelOperations();
  const { toast } = useToast();
  const priceInputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [endpointFilter, setEndpointFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [selected, setSelected] = useState<ModelRouteGroup | null>(null);
  const [unit, setUnit] = useState("");
  const [priceGu, setPriceGu] = useState("");
  const [reservationTokens, setReservationTokens] = useState(0);
  const [pricingForm, setPricingForm] = useState<PricingRuleForm | null>(null);
  const [initialPricingForm, setInitialPricingForm] = useState<PricingRuleForm | null>(null);
  const [audiencePricing, setAudiencePricing] = useState<PricingAudienceDraft>({ defaultVisible: true, groups: [] });
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState<ModelRouteGroup | null>(null);
  const [saveError, setSaveError] = useState("");
  const [groupManagerOpen, setGroupManagerOpen] = useState(false);
  const pricingGroupsState = usePricingGroups();

  useEffect(() => {
    if (!selected) return;
    const nextUnit = selected.pricing?.unit || endpointPricingUnits[selected.endpointType]?.[0]?.value || "task";
    setUnit(nextUnit);
    setPriceGu(selected.pricing ? microsToGu(selected.pricing.unitPriceMicros, nextUnit).split(",").join("") : "");
    setReservationTokens(Number(selected.pricing?.ruleConfig?.reservationUpperBoundTokens || 0));
    const nextPricingForm = pricingFormForGroup(selected);
    setPricingForm(nextPricingForm);
    setInitialPricingForm(nextPricingForm);
    setAudiencePricing(pricingAudienceDraftFromRuleConfig(selected.pricing?.ruleConfig));
    setSaveError("");
  }, [selected]);

  const managedGroups = useMemo(() => state.groups.filter((group) => ["published", "degraded"].includes(group.publication.status)), [state.groups]);
  const endpointOptions = useMemo(() => [...new Set(managedGroups.map((group) => group.endpointType))].sort(), [managedGroups]);
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return managedGroups.filter((group) => (
      (!needle || [group.publicModel, group.displayName, ...group.targets.flatMap((target) => [target.provider, target.channelName])]
        .some((value) => value.toLowerCase().includes(needle)))
      && (!endpointFilter || group.endpointType === endpointFilter)
      && (!statusFilter || (statusFilter === "priced" ? Boolean(group.pricing) : !group.pricing))
    ));
  }, [endpointFilter, managedGroups, query, statusFilter]);
  const priced = managedGroups.filter((group) => Boolean(group.pricing)).length;
  const published = managedGroups.length;
  const usesVisualPricing = Boolean(selected && isPricingEndpoint(selected.endpointType));
  const previewUnit = usesVisualPricing && pricingForm ? pricingForm.unit : unit;
  const previewPriceGu = usesVisualPricing && pricingForm ? String(pricingForm.unitPriceGu) : priceGu;

  const openEditor = (group: ModelRouteGroup) => setSelected(group);
  const save = async () => {
    if (!selected) return;
    const audienceError = validatePricingAudienceDraft(audiencePricing);
    if (audienceError) {
      setSaveError(audienceError);
      return;
    }
    setSaving(true);
    setSaveError("");
    try {
      let nextUnit: string;
      let unitPriceMicros: number;
      let baseRuleConfig: Record<string, unknown>;
      if (isPricingEndpoint(selected.endpointType)) {
        if (!pricingForm) throw new Error("定价表单尚未就绪，请重新打开后再试。");
        const payload = buildDirectModelPricingPayload(pricingForm);
        nextUnit = payload.unit;
        unitPriceMicros = payload.unitPriceMicros;
        baseRuleConfig = editableLogicalPriceRuleConfig(payload.ruleConfig);
      } else {
        nextUnit = unit;
        unitPriceMicros = guToMicros(priceGu, unit);
        if (unitPriceMicros <= 0) throw new Error("销售价格必须大于 0。");
        if (selected.endpointType === "video_generation" && unit === "token" && reservationTokens <= 0) {
          throw new Error("视频 Token 定价必须填写单任务最大预留 Token。");
        }
        baseRuleConfig = editableLogicalPriceRuleConfig(selected.pricing?.ruleConfig);
        if (selected.endpointType === "video_generation" && unit === "token") {
          baseRuleConfig.reservationUpperBoundTokens = reservationTokens;
        } else {
          delete baseRuleConfig.reservationUpperBoundTokens;
        }
      }
      const saved = await updateLogicalModelPricing(selected.groupKey, {
        unit: nextUnit,
        unitPriceMicros,
        currency: "GU",
        ruleConfig: writePricingAudienceDraft(baseRuleConfig, audiencePricing),
      });
      toast({
        title: "发布目标售价已更新",
        message: `${saved.displayName} 的模型广场与运行时价格镜像已同步。`,
        tone: "success",
      });
      setSelected(null);
      state.reload();
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : "发布目标售价更新失败");
    } finally {
      setSaving(false);
    }
  };

  const columns = useMemo<DataTableColumn<ModelRouteGroup>[]>(() => [
    {
      id: "model", header: "发布目标", priority: "primary", sortable: true, minWidth: "240px",
      sortValue: (row) => row.publicModel,
      cell: (row) => <div className="modelOpsIdentity"><strong>{row.displayName}</strong><code>{row.publicModel}</code></div>,
    },
    {
      id: "capability", header: "能力", priority: "primary", sortable: true,
      sortValue: (row) => row.endpointType,
      cell: (row) => <div className="modelOpsIdentity"><strong>{endpointLabels[row.endpointType] || row.endpointType}</strong><span>{row.targets.length} 个上游目标</span></div>,
    },
    {
      id: "price", header: "当前统一售价", priority: "primary", sortable: true,
      sortValue: (row) => row.pricing?.unitPriceMicros || 0,
      cell: (row) => row.pricing
        ? <div className="modelOpsIdentity"><strong>{microsToGu(row.pricing.unitPriceMicros, row.pricing.unit)} GU</strong><span>{unitLabel(row.endpointType, row.pricing.unit)} · {pricingAudienceDraftFromRuleConfig(row.pricing.ruleConfig).groups.length} 个分组规则</span></div>
        : <Badge tone="warning">待设置</Badge>,
    },
    {
      id: "publication", header: "发布状态", priority: "primary", sortable: true,
      sortValue: (row) => row.publication.status,
      cell: (row) => <Badge tone={publicationLabels[row.publication.status].tone}>{publicationLabels[row.publication.status].label}</Badge>,
    },
    {
      id: "scope", header: "范围", priority: "secondary",
      cell: (row) => row.scope === "workspace" ? `工作区 · ${row.workspaceId}` : "平台",
    },
    {
      id: "actions", header: "操作", headerLabel: "行操作", priority: "primary", hideable: false, minWidth: "110px",
      cell: (row) => <div className="modelOpsRowActions">
        <Button size="compact" variant="secondary" icon={<Pencil size={15} />} onClick={(event) => { event.stopPropagation(); openEditor(row); }}>调整价格</Button>
        <Button size="compact" variant="danger" icon={<EyeOff size={15} />} onClick={(event) => { event.stopPropagation(); setRemoving(row); }}>下架</Button>
      </div>,
    },
  ], []);

  return (
    <ConsolePage
      breadcrumbs={[{ label: "模型管理" }, { label: "最终发布目标" }]}
      title="模型管理"
      description="只管理路径完整且已发布的用户模型；可统一调整价格或下架，模型广场、用户后台、创作台与中转站同步生效。"
      primaryAction={<div className="modelOpsRowActions"><Button variant="secondary" icon={<Tags size={16} />} onClick={() => setGroupManagerOpen(true)}>管理定价分组</Button><Button variant="secondary" icon={<RefreshCcw size={16} />} loading={state.loading} onClick={state.reload}>刷新</Button></div>}
      layoutWidth="dashboard"
    >
      <ModelFlowNav active="price" />
      {state.error ? <Alert tone="danger" title="模型管理读取失败">{state.error}</Alert> : null}
      {pricingGroupsState.error ? <Alert tone="danger" title="定价分组读取失败">{pricingGroupsState.error}</Alert> : null}
      <MetricStrip metrics={[
        { id: "models", label: "发布目标", value: state.loading ? "-" : managedGroups.length.toLocaleString(), hint: "完整且已发布的用户模型" },
        { id: "priced", label: "已定价", value: state.loading ? "-" : priced.toLocaleString(), hint: "每个发布目标只有一个售价", tone: "positive" },
        { id: "unpriced", label: "异常目标", value: state.loading ? "-" : (managedGroups.length - priced).toLocaleString(), hint: "异常时自动从用户侧隐藏" },
        { id: "published", label: "用户侧可见", value: state.loading ? "-" : published.toLocaleString(), hint: "创作台、中转站、模型广场一致" },
      ]} />
      <FilterBar actions={<Button icon={<Search size={16} />}>筛选</Button>}>
        <FormField label="发布目标或上游" optionalLabel={null} className="modelOpsFilter--wide"><Input value={query} placeholder="搜索发布名称、渠道或供应商" onChange={(event) => setQuery(event.currentTarget.value)} /></FormField>
        <FormField label="能力" optionalLabel={null}><Select value={endpointFilter} onChange={(event) => setEndpointFilter(event.currentTarget.value)}><option value="">全部能力</option>{endpointOptions.map((endpoint) => <option key={endpoint} value={endpoint}>{endpointLabels[endpoint] || endpoint}</option>)}</Select></FormField>
        <FormField label="定价状态" optionalLabel={null}><Select value={statusFilter} onChange={(event) => setStatusFilter(event.currentTarget.value)}><option value="">全部状态</option><option value="priced">已定价</option><option value="unpriced">待定价</option></Select></FormField>
      </FilterBar>
      <DataTable columns={columns} rows={rows} getRowId={(row) => row.groupKey} ariaLabel="最终发布目标列表" loading={state.loading} error={state.error || undefined} onRetry={state.reload} emptyState="没有完整且已发布的模型；请先在模型路由画布中补全路径、定价并发布。" onRowClick={openEditor} getRowAriaLabel={(row) => `管理 ${row.displayName}`} defaultSort={{ columnId: "model", direction: "ascending" }} />
      <div className="modelOpsPriceFootnote"><CircleDollarSign size={15} /><span>这里是最终发布目标的统一管理处；不完整、未定价或已下架的路径不会出现在任何用户入口。</span></div>

      <ConfirmDialog
        open={Boolean(removing)}
        title="下架并移出模型管理？"
        description={removing ? `${removing.displayName} 将立即从模型广场、用户后台、创作台与中转站隐藏；路由画布和审计记录会保留，之后可以重新发布。` : undefined}
        confirmLabel="确认下架"
        tone="danger"
        onCancel={() => setRemoving(null)}
        onConfirm={async () => {
          if (!removing) return false;
          await unpublishModelRouteGroup(removing);
          toast({ title: "模型已下架", message: `${removing.displayName} 已从全部用户入口移除。`, tone: "success" });
          state.reload();
          return true;
        }}
        onConfirmError={(caught) => toast({ title: "下架失败", message: caught instanceof Error ? caught.message : "请稍后重试", tone: "danger" })}
      />

      <Drawer
        open={Boolean(selected)}
        title={selected ? `调整统一售价 · ${selected.displayName}` : "调整统一售价"}
        description={selected ? `${selected.publicModel} · ${endpointLabels[selected.endpointType] || selected.endpointType}` : undefined}
        size={usesVisualPricing ? "min(1180px, 100vw)" : "min(760px, 100vw)"}
        dirty
        loading={saving}
        initialFocusRef={usesVisualPricing ? undefined : priceInputRef}
        closeGuardTitle="放弃未保存的价格？"
        closeGuardDescription="当前价格修改尚未同步到逻辑模型与运行时镜像。"
        onOpenChange={(open) => { if (!open && !saving) setSelected(null); }}
        footer={<div className="modelOpsWizard__actions">
          <Button variant="secondary" disabled={saving} onClick={() => setSelected(null)}>取消</Button>
          {usesVisualPricing ? null : <Button icon={<Save size={16} />} loading={saving} onClick={() => void save()}>保存并同步价格</Button>}
        </div>}
      >
        {selected ? <div className="modelOpsWizard">
          {usesVisualPricing && pricingForm && initialPricingForm ? <ModelPricingEditor
            form={pricingForm}
            initialForm={initialPricingForm}
            channels={[]}
            channelId=""
            saving={saving}
            error={saveError}
            conflicts={[]}
            identityLocked
            onChange={setPricingForm}
            onChannelChange={() => {}}
            onSave={() => void save()}
          /> : <>
            {saveError ? <Alert tone="danger" title="价格无法保存">{saveError}</Alert> : null}
            <FieldGroup legend="发布目标售价" description="这与模型路由画布中的发布定价是同一条价格；上游渠道只参与路由，不各自展示售价。" variant="section">
              <div className="modelOpsFormGrid">
                <FormField label="计费单位" required optionalLabel={null}><Select value={unit} onChange={(event) => { setUnit(event.currentTarget.value); setPriceGu(""); setReservationTokens(0); }}>{(endpointPricingUnits[selected.endpointType] || []).map((candidate) => <option key={candidate.value} value={candidate.value}>{candidate.label}</option>)}</Select></FormField>
                <FormField label={unit === "token" ? "销售价格（GU / M tokens）" : "销售价格（GU）"} required optionalLabel={null}><Input ref={priceInputRef} inputMode="decimal" value={priceGu} placeholder="0.00" onChange={(event) => setPriceGu(event.currentTarget.value)} /></FormField>
                {selected.endpointType === "video_generation" && unit === "token" ? <FormField className="modelOpsFormGrid__wide" label="单任务最大预留 Token" required optionalLabel={null}><NumberInput value={reservationTokens} min={1} step={1} onValueChange={(value) => setReservationTokens(Number(value || 0))} /></FormField> : null}
              </div>
            </FieldGroup>
          </>}
          <FieldGroup legend="用户分组可见性与折扣" description="按照工作区付款方的 pricingGroup 判定。隐藏会从模型广场、用户后台、创作台和中转站同时移除；折扣会同步用于报价、预扣和最终扣费。" variant="section">
            <div className="modelOpsAudienceDefault">
              <Switch
                checked={audiencePricing.defaultVisible}
                onCheckedChange={(checked) => setAudiencePricing((current) => ({ ...current, defaultVisible: checked }))}
                label="未单独配置的用户可以看到并按原价使用"
                description="关闭后，只有下方明确设置为可见的定价分组才能使用该模型。"
              />
            </div>
            <div className="modelOpsAudienceRules" aria-label="用户分组价格规则">
              {audiencePricing.groups.map((rule, index) => (
                <div className="modelOpsAudienceRule" key={index}>
                  <FormField label="定价分组代码" required optionalLabel={null}>
                    <Select
                      aria-label={`定价分组代码 ${index + 1}`}
                      value={rule.group}
                      disabled={pricingGroupsState.loading || Boolean(pricingGroupsState.error)}
                      onChange={(event) => {
                        const group = event.currentTarget.value;
                        setAudiencePricing((current) => ({
                          ...current,
                          groups: current.groups.map((candidate, candidateIndex) => candidateIndex === index
                            ? { ...candidate, group }
                            : candidate),
                        }));
                      }}
                    >
                      <option value="">请选择已创建分组</option>
                      {pricingGroupsState.groups.filter((group) => !group.isDefault && (group.status === "active" || group.code === rule.group)).map((group) => (
                        <option key={group.code} value={group.code}>{group.name} · {group.code}{group.status === "disabled" ? "（已停用）" : ""}</option>
                      ))}
                      {rule.group && !pricingGroupsState.groups.some((group) => group.code === rule.group)
                        ? <option value={rule.group}>{rule.group}（待迁移）</option>
                        : null}
                    </Select>
                  </FormField>
                  <Switch
                    checked={rule.visible}
                    onCheckedChange={(checked) => setAudiencePricing((current) => ({
                      ...current,
                      groups: current.groups.map((candidate, candidateIndex) => candidateIndex === index
                        ? { ...candidate, visible: checked }
                        : candidate),
                    }))}
                    label={rule.visible ? "允许看到和使用" : "对该分组隐藏"}
                  />
                  <FormField label="实付比例" required optionalLabel={null}>
                    <NumberInput
                      aria-label={`实付比例 ${index + 1}`}
                      value={rule.discountBps / 100}
                      min={0.01}
                      max={100}
                      step={0.5}
                      disabled={!rule.visible}
                      onValueChange={(value) => setAudiencePricing((current) => ({
                        ...current,
                        groups: current.groups.map((candidate, candidateIndex) => candidateIndex === index
                          ? { ...candidate, discountBps: Math.round(Number(value || 0) * 100) }
                          : candidate),
                      }))}
                    />
                  </FormField>
                  <span className="modelOpsAudienceRule__unit">%</span>
                  <Button
                    variant="danger"
                    size="compact"
                    icon={<Trash2 size={15} />}
                    aria-label={`删除分组规则 ${rule.group || index + 1}`}
                    onClick={() => setAudiencePricing((current) => ({
                      ...current,
                      groups: current.groups.filter((_, candidateIndex) => candidateIndex !== index),
                    }))}
                  >删除</Button>
                </div>
              ))}
              <Button
                variant="secondary"
                size="compact"
                icon={<Plus size={15} />}
                disabled={pricingGroupsState.loading || Boolean(pricingGroupsState.error)}
                onClick={() => setAudiencePricing((current) => ({
                  ...current,
                  groups: [...current.groups, { group: "", visible: true, discountBps: 10_000 }],
                }))}
              >新增分组规则</Button>
            </div>
          </FieldGroup>
          <div className="modelOpsPricePreview"><span>模型广场价格预览</span><strong>{previewPriceGu || "0"} GU</strong><small>{unitLabel(selected.endpointType, previewUnit)}</small></div>
          {audiencePricing.groups.length || !audiencePricing.defaultVisible ? <div className="modelOpsAudiencePreview" aria-label="分组价格预览">
            <div><span>默认用户</span><strong>{audiencePricing.defaultVisible ? `${previewPriceGu || "0"} GU` : "不可见"}</strong><small>未设置 pricingGroup</small></div>
            {audiencePricing.groups.map((rule, index) => {
              const effectiveMicros = discountedPriceMicros(guToMicros(previewPriceGu, previewUnit), rule.discountBps);
              return <div key={`${rule.group}-${index}`}><span>{rule.group || "未填写分组"}</span><strong>{rule.visible ? `${microsToGu(effectiveMicros, previewUnit)} GU` : "不可见"}</strong><small>{rule.visible ? discountLabel(rule.discountBps) : "无使用权限"}</small></div>;
            })}
          </div> : null}
          <Alert tone="info" title="同步范围">保存会同时更新模型广场显示价格、用户后台模型目录、创作台/中转站选择器、报价、预扣与最终扣费，以及当前路由组所有供应商镜像；不会修改供应商渠道配置。</Alert>
        </div> : null}
      </Drawer>
      <PricingGroupManagerDrawer
        open={groupManagerOpen}
        groups={pricingGroupsState.groups}
        loading={pricingGroupsState.loading}
        error={pricingGroupsState.error}
        onClose={() => setGroupManagerOpen(false)}
        onReload={pricingGroupsState.reload}
      />
    </ConsolePage>
  );
}
