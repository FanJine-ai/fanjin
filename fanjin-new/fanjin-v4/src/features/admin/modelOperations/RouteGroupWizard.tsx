import { useMemo, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Save, ShieldCheck } from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  Drawer,
  FieldGroup,
  FormField,
  Input,
  NumberInput,
  Select,
  Switch,
} from "../../../ui/console";
import { preflightModelRouteGroup } from "./api";
import {
  defaultPricingUnit,
  endpointLabels,
  endpointPricingUnits,
  guToMicros,
  microsToGu,
  type ModelPoolItem,
  type ModelRouteGroupDraft,
  type ModelRouteGroupPreflight,
} from "./types";

interface RouteGroupWizardProps {
  open: boolean;
  pool: ModelPoolItem[];
  initialDraft: ModelRouteGroupDraft;
  saving: boolean;
  serverError: string;
  onSave: (draft: ModelRouteGroupDraft) => void;
  onOpenChange: (open: boolean) => void;
}

const steps = [
  { label: "选择模型", description: "从模型池选择能力等价的上游来源。" },
  { label: "公开信息", description: "定义用户看到的模型标识、名称和范围。" },
  { label: "流量策略", description: "设置 P0/P1/P2 层级和同层权重。" },
  { label: "首次定价", description: "设置模型广场、创作台和中转站统一售价。" },
  { label: "预检发布", description: "检查完整配置后原子保存路由与价格。" },
] as const;

function targetKey(item: Pick<ModelPoolItem, "channelId" | "upstreamModel">) {
  return `${item.channelId}|${item.upstreamModel}`;
}

export function emptyRouteGroupDraft(source?: ModelPoolItem | null): ModelRouteGroupDraft {
  const endpointType = source?.endpointType || "text";
  return {
    existingGroupKey: null,
    scope: source?.scope || "platform",
    workspaceId: source?.workspaceId || null,
    endpointType,
    publicModel: source?.upstreamModel || "",
    displayName: source?.upstreamModel || "",
    disabled: false,
    targets: source ? [{ channelId: source.channelId, upstreamModel: source.upstreamModel, tier: "P0", trafficWeight: 100 }] : [],
    pricing: {
      unit: defaultPricingUnit(endpointType),
      unitPriceMicros: 0,
      currency: "GU",
      ruleConfig: {},
    },
  };
}

export function RouteGroupWizard({
  open,
  pool,
  initialDraft,
  saving,
  serverError,
  onSave,
  onOpenChange,
}: RouteGroupWizardProps) {
  const [draft, setDraft] = useState(initialDraft);
  const [activeStep, setActiveStep] = useState(0);
  const [furthestStep, setFurthestStep] = useState(0);
  const [query, setQuery] = useState("");
  const [preflight, setPreflight] = useState<ModelRouteGroupPreflight | null>(null);
  const [preflighting, setPreflighting] = useState(false);
  const [localError, setLocalError] = useState("");
  const firstInputRef = useRef<HTMLInputElement>(null);
  const selectedKeys = useMemo(() => new Set(draft.targets.map(targetKey)), [draft.targets]);
  const selectedPool = useMemo(() => pool.filter((item) => selectedKeys.has(targetKey(item))), [pool, selectedKeys]);
  const capabilityFingerprint = selectedPool[0]?.capabilityFingerprint || "";
  const compatiblePool = useMemo(() => pool.filter((item) => (
    (!draft.targets.length || (
      item.endpointType === draft.endpointType
      && item.capabilityFingerprint === capabilityFingerprint
      && (draft.scope === "platform"
        ? item.scope === "platform"
        : item.scope === "platform" || (item.scope === "workspace"
          && String(item.workspaceId || "") === String(draft.workspaceId || "")))
    ))
    && (!query.trim() || [item.upstreamModel, item.provider, item.channelName]
      .some((value) => value.toLowerCase().includes(query.trim().toLowerCase())))
  )), [capabilityFingerprint, draft.endpointType, draft.scope, draft.targets.length, draft.workspaceId, pool, query]);
  const priceGu = microsToGu(draft.pricing?.unitPriceMicros, draft.pricing?.unit);

  const updateDraft = (next: ModelRouteGroupDraft) => {
    setDraft(next);
    setPreflight(null);
    setLocalError("");
  };

  const togglePoolItem = (item: ModelPoolItem) => {
    const key = targetKey(item);
    if (selectedKeys.has(key)) {
      if (draft.targets.length === 1) return;
      updateDraft({ ...draft, targets: draft.targets.filter((target) => targetKey(target) !== key) });
      return;
    }
    const endpointChanged = draft.targets.length === 0 && draft.endpointType !== item.endpointType;
    updateDraft({
      ...draft,
      scope: draft.targets.length ? draft.scope : item.scope,
      workspaceId: draft.targets.length ? draft.workspaceId : item.workspaceId,
      endpointType: draft.targets.length ? draft.endpointType : item.endpointType,
      publicModel: draft.publicModel || item.upstreamModel,
      displayName: draft.displayName || item.upstreamModel,
      targets: [...draft.targets, {
        channelId: item.channelId,
        upstreamModel: item.upstreamModel,
        tier: "P0",
        trafficWeight: 100,
      }],
      pricing: endpointChanged ? {
        unit: defaultPricingUnit(item.endpointType), unitPriceMicros: 0, currency: "GU", ruleConfig: {},
      } : draft.pricing,
    });
  };

  const stepError = (step: number): string => {
    if (step === 0 && !draft.targets.length) return "请至少选择一个模型池来源。";
    if (step === 1 && !draft.publicModel.trim()) return "请填写公开模型标识。";
    if (step === 1 && draft.scope === "workspace" && !draft.workspaceId?.trim()) return "工作区路由必须填写 Workspace ID。";
    if (step === 2 && !draft.targets.some((target) => target.tier === "P0")) return "至少需要一个 P0 主用目标。";
    if (step === 2 && draft.targets.some((target) => target.trafficWeight < 1 || target.trafficWeight > 1000)) return "权重必须在 1–1000 之间。";
    if (step === 3 && !draft.pricing) return "请设置首次售价。";
    if (step === 3 && !draft.disabled && Number(draft.pricing?.unitPriceMicros || 0) <= 0) return "立即启用时，售价必须大于 0 GU。";
    if (step === 3 && draft.endpointType === "video_generation" && draft.pricing?.unit === "token"
      && Number(draft.pricing.ruleConfig.reservationUpperBoundTokens || 0) <= 0) return "视频 Token 定价必须填写单任务最大预留 Token。";
    return "";
  };

  const moveNext = () => {
    const error = stepError(activeStep);
    if (error) { setLocalError(error); return; }
    const next = Math.min(activeStep + 1, steps.length - 1);
    setActiveStep(next);
    setFurthestStep((value) => Math.max(value, next));
    setLocalError("");
  };

  const runPreflight = async () => {
    setPreflighting(true);
    setLocalError("");
    try {
      const result = await preflightModelRouteGroup(draft);
      setPreflight(result);
      if (!result.valid) setLocalError(result.issues.map((issue) => issue.message).join("；"));
    } catch (caught) {
      setPreflight(null);
      setLocalError(caught instanceof Error ? caught.message : "路由组预检失败");
    } finally {
      setPreflighting(false);
    }
  };

  return (
    <Drawer
      open={open}
      title={draft.existingGroupKey ? "编辑逻辑模型路由" : "创建逻辑模型路由"}
      description="一个公开模型可以连接多个上游；路由、负载策略和首次售价在同一次事务中保存。"
      size="min(920px, 100vw)"
      dirty
      loading={saving || preflighting}
      initialFocusRef={firstInputRef}
      closeGuardTitle="放弃未保存的模型路由？"
      closeGuardDescription="当前选择的上游、流量策略与首次售价将丢失。"
      onOpenChange={onOpenChange}
      footer={(
        <div className="modelOpsWizard__actions">
          {activeStep > 0 ? <Button variant="ghost" icon={<ChevronLeft size={16} />} disabled={saving || preflighting} onClick={() => setActiveStep((value) => value - 1)}>上一步</Button> : null}
          {activeStep < steps.length - 1 ? (
            <Button icon={<ChevronRight size={16} />} iconPosition="end" disabled={saving || preflighting} onClick={moveNext}>下一步</Button>
          ) : (
            <>
              <Button variant="secondary" icon={<ShieldCheck size={16} />} loading={preflighting} disabled={saving} onClick={() => void runPreflight()}>运行预检</Button>
              <Button icon={<Save size={16} />} loading={saving} disabled={!preflight?.valid || preflighting} onClick={() => onSave(draft)}>保存路由与价格</Button>
            </>
          )}
        </div>
      )}
    >
      <div className="modelOpsWizard">
        <nav className="modelOpsWizard__steps" aria-label="模型路由配置步骤">
          <ol>{steps.map((step, index) => (
            <li key={step.label} data-state={index === activeStep ? "active" : index < activeStep ? "complete" : "pending"}>
              <button type="button" disabled={index > furthestStep} aria-current={index === activeStep ? "step" : undefined} onClick={() => setActiveStep(index)}>
                <span>{index < activeStep ? <Check size={12} /> : index + 1}</span>{step.label}
              </button>
            </li>
          ))}</ol>
          <p><strong>步骤 {activeStep + 1}/{steps.length}</strong>{steps[activeStep].description}</p>
        </nav>
        {serverError || localError ? <Alert tone="danger" title="当前配置需要处理">{serverError || localError}</Alert> : null}

        {activeStep === 0 ? (
          <div className="modelOpsWizard__panel">
            <FormField label="搜索模型池" optionalLabel={null}><Input ref={firstInputRef} value={query} placeholder="模型、渠道或供应商" onChange={(event) => setQuery(event.currentTarget.value)} /></FormField>
            <div className="modelOpsPoolPicker" role="listbox" aria-label="选择模型池来源" aria-multiselectable="true">
              {compatiblePool.map((item) => {
                const selected = selectedKeys.has(targetKey(item));
                return (
                  <button key={item.poolId} type="button" role="option" aria-selected={selected} className={selected ? "is-selected" : ""} onClick={() => togglePoolItem(item)}>
                    <span className="modelOpsPoolPicker__check">{selected ? <Check size={13} /> : null}</span>
                    <span><strong>{item.upstreamModel}</strong><small>{item.channelName} · {item.provider}</small></span>
                    <Badge tone={item.health === "healthy" ? "success" : item.health === "unhealthy" ? "danger" : "warning"}>{item.health === "healthy" ? "健康" : item.health === "unhealthy" ? "不可用" : "需关注"}</Badge>
                  </button>
                );
              })}
              {!compatiblePool.length ? <div className="modelOpsEmpty"><strong>没有能力等价的模型池来源</strong><span>同一路由组只能选择能力合同一致的模型。</span></div> : null}
            </div>
            <p className="modelOpsHint">已选择 {draft.targets.length} 个来源。选择第一个模型后，只显示范围、能力合同完全一致的其他来源。</p>
          </div>
        ) : null}

        {activeStep === 1 ? (
          <div className="modelOpsWizard__panel">
            <FieldGroup legend="公开模型信息" description="这些信息会被创作台、中转站和模型广场共同使用。" variant="section">
              <div className="modelOpsFormGrid">
                <FormField label="公开模型标识" required optionalLabel={null}><Input ref={firstInputRef} value={draft.publicModel} disabled={Boolean(draft.existingGroupKey)} placeholder="例如 seedance-2.0" onChange={(event) => updateDraft({ ...draft, publicModel: event.currentTarget.value })} /></FormField>
                <FormField label="展示名称" required optionalLabel={null}><Input value={draft.displayName || ""} placeholder="用户可见名称" onChange={(event) => updateDraft({ ...draft, displayName: event.currentTarget.value })} /></FormField>
                <FormField label="能力" required optionalLabel={null}><Input value={endpointLabels[draft.endpointType] || draft.endpointType} disabled /></FormField>
                <FormField label="范围" required optionalLabel={null}>
                  <Select value={draft.scope} disabled={Boolean(draft.existingGroupKey)} onChange={(event) => updateDraft({ ...draft, scope: event.currentTarget.value as "platform" | "workspace", workspaceId: event.currentTarget.value === "platform" ? null : draft.workspaceId })}><option value="platform">平台</option><option value="workspace">工作区</option></Select>
                </FormField>
                {draft.scope === "workspace" ? <FormField className="modelOpsFormGrid__wide" label="Workspace ID" required optionalLabel={null}><Input value={draft.workspaceId || ""} disabled={Boolean(draft.existingGroupKey)} onChange={(event) => updateDraft({ ...draft, workspaceId: event.currentTarget.value })} /></FormField> : null}
              </div>
            </FieldGroup>
          </div>
        ) : null}

        {activeStep === 2 ? (
          <div className="modelOpsWizard__panel">
            <div className="modelOpsTargetTable" role="table" aria-label="路由目标流量策略">
              <div className="modelOpsTargetTable__head" role="row"><span>上游目标</span><span>层级</span><span>权重</span><span>实际比例</span></div>
              {draft.targets.map((target, index) => {
                const item = pool.find((candidate) => targetKey(candidate) === targetKey(target));
                const peers = draft.targets.filter((candidate) => candidate.tier === target.tier);
                const total = peers.reduce((sum, candidate) => sum + candidate.trafficWeight, 0);
                const percent = total ? Math.round(target.trafficWeight / total * 10_000) / 100 : 0;
                return (
                  <div className="modelOpsTargetTable__row" role="row" key={targetKey(target)}>
                    <span><strong>{target.upstreamModel}</strong><small>{item?.channelName || target.channelId}</small></span>
                    <Select aria-label={`${target.upstreamModel} 优先层级`} value={target.tier} onChange={(event) => updateDraft({ ...draft, targets: draft.targets.map((value, targetIndex) => targetIndex === index ? { ...value, tier: event.currentTarget.value as "P0" | "P1" | "P2" } : value) })}><option value="P0">P0 主用</option><option value="P1">P1 备用</option><option value="P2">P2 兜底</option></Select>
                    <NumberInput aria-label={`${target.upstreamModel} 路由权重`} value={target.trafficWeight} min={1} max={1000} step={1} onValueChange={(value) => updateDraft({ ...draft, targets: draft.targets.map((current, targetIndex) => targetIndex === index ? { ...current, trafficWeight: Number(value || 0) } : current) })} />
                    <strong>{percent}%</strong>
                  </div>
                );
              })}
            </div>
            <Alert tone="info" title="负载规则">只在同一 P 层内按权重分流；P0 全部不可用时才进入 P1。上游已接受或结果未知时禁止切换，避免重复生成和重复费用。</Alert>
          </div>
        ) : null}

        {activeStep === 3 && draft.pricing ? (
          <div className="modelOpsWizard__panel">
            <FieldGroup legend="首次售价" description="这里设置的价格会成为逻辑模型唯一售价；模型定价页只负责后续调整。" variant="section">
              <div className="modelOpsFormGrid">
                <FormField label="计费单位" required optionalLabel={null}><Select value={draft.pricing.unit} onChange={(event) => updateDraft({ ...draft, pricing: { ...draft.pricing!, unit: event.currentTarget.value, unitPriceMicros: 0, ruleConfig: {} } })}>{(endpointPricingUnits[draft.endpointType] || []).map((unit) => <option key={unit.value} value={unit.value}>{unit.label}</option>)}</Select></FormField>
                <FormField label={draft.pricing.unit === "token" ? "销售价格（GU / M tokens）" : "销售价格（GU）"} required optionalLabel={null}><Input inputMode="decimal" value={priceGu} placeholder="0.00" onChange={(event) => updateDraft({ ...draft, pricing: { ...draft.pricing!, unitPriceMicros: guToMicros(event.currentTarget.value, draft.pricing!.unit) } })} /></FormField>
                {draft.endpointType === "video_generation" && draft.pricing.unit === "token" ? <FormField className="modelOpsFormGrid__wide" label="单任务最大预留 Token" required optionalLabel={null}><NumberInput value={Number(draft.pricing.ruleConfig.reservationUpperBoundTokens || 0)} min={1} step={1} onValueChange={(value) => updateDraft({ ...draft, pricing: { ...draft.pricing!, ruleConfig: { ...draft.pricing!.ruleConfig, reservationUpperBoundTokens: Number(value || 0) } } })} /></FormField> : null}
                <FormField className="modelOpsFormGrid__wide" label="发布状态" optionalLabel={null}>
                  <div className="modelOpsSwitchRow"><Switch checked={!draft.disabled} onCheckedChange={(checked) => updateDraft({ ...draft, disabled: !checked })} label="保存后立即启用" /><span>{draft.disabled ? "将保存为草稿，不进入用户侧" : "预检通过后参与统一发布投影"}</span></div>
                </FormField>
              </div>
            </FieldGroup>
            <div className="modelOpsPricePreview"><span>模型广场价格预览</span><strong>{priceGu || "0"} GU</strong><small>{endpointPricingUnits[draft.endpointType]?.find((unit) => unit.value === draft.pricing?.unit)?.label || draft.pricing.unit}</small></div>
          </div>
        ) : null}

        {activeStep === 4 ? (
          <div className="modelOpsWizard__panel">
            <div className="modelOpsReviewGrid">
              <section><span>公开模型</span><strong>{draft.displayName || draft.publicModel}</strong><code>{draft.publicModel}</code></section>
              <section><span>上游目标</span><strong>{draft.targets.length} 个</strong><small>{draft.targets.map((target) => `${target.tier} ${target.trafficWeight}`).join(" · ")}</small></section>
              <section><span>统一售价</span><strong>{microsToGu(draft.pricing?.unitPriceMicros, draft.pricing?.unit)} GU</strong><small>{draft.pricing?.unit === "token" ? "每百万 Token" : draft.pricing?.unit}</small></section>
              <section><span>保存后</span><strong>{draft.disabled ? "草稿" : "启用"}</strong><small>{draft.scope === "workspace" ? `工作区 ${draft.workspaceId}` : "平台"}</small></section>
            </div>
            {preflight ? (
              <Alert tone={preflight.valid ? "success" : "danger"} title={preflight.valid ? "预检通过，可以原子保存" : "预检未通过"}>
                {preflight.valid ? `将创建/更新 ${preflight.normalizedTargets.length} 个路由目标和一条统一售价。` : preflight.issues.map((issue) => issue.message).join("；")}
              </Alert>
            ) : <Alert tone="warning" title="尚未运行预检">保存前需要重新确认模型池引用、能力一致性、权重、价格和范围。</Alert>}
          </div>
        ) : null}
      </div>
    </Drawer>
  );
}
