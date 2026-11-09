import { useMemo } from "react";
import { Boxes, Check, CircleDollarSign, Clock3, Database, Gauge, Plus, Save, Trash2 } from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  FieldGroup,
  FormField,
  Input,
  NumberInput,
  Select,
  Switch,
} from "../../../../ui/console";
import {
  endpointLabels as channelEndpointLabels,
  parseProviderModelNames,
  providerLabels,
  type ProviderChannel,
  type ProviderChannelProvider,
} from "../../providers/types";
import {
  endpointLabels,
  isPricingUnitForEndpoint,
  pricingEndpoints,
  readVideoInputPricingFormState,
  pricingProviders,
  pricingUnitsForEndpoint,
  pricingAmountFromMicros,
  unitLabels,
  validateTimePricingRuleConfig,
  writeVideoInputPricingEnabled,
  writeVideoInputPricingTierPrice,
  type PricingEndpoint,
  type PricingRuleForm,
  type PricingScope,
} from "./types";
import "./pricing.css";

type OptionalPriceKey = "outputPriceMicros" | "cacheReadPriceMicros" | "cacheWritePriceMicros";

interface TimePricingPeriodForm {
  id: string;
  name: string;
  daysOfWeek: number[];
  startMinute: number;
  endMinute: number;
  multiplierBps: number;
}

interface TimePricingForm {
  enabled: boolean;
  timezone: string;
  periods: TimePricingPeriodForm[];
}

const weekdayLabels = ["日", "一", "二", "三", "四", "五", "六"];

function readConfig(text: string) {
  try {
    const parsed = JSON.parse(text || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function priceFromConfig(text: string, key: OptionalPriceKey) {
  const raw = readConfig(text)[key];
  if (raw == null || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? pricingAmountFromMicros(value, "token") : null;
}

function positiveTokenPriceFromConfig(text: string, key: OptionalPriceKey) {
  const value = priceFromConfig(text, key);
  return value != null && value > 0 ? value : null;
}

function writeConfigPrice(text: string, key: OptionalPriceKey, value: number | null) {
  const config = readConfig(text);
  if (value == null || !Number.isFinite(value) || value < 0 || (key === "outputPriceMicros" && value <= 0)) delete config[key];
  else config[key] = Number((value * 100).toPrecision(15));
  return JSON.stringify(config, null, 2);
}

function positiveIntegerFromConfig(text: string, key: string) {
  const value = Number(readConfig(text)[key]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function writeConfigInteger(text: string, key: string, value: number | null) {
  const config = readConfig(text);
  if (value == null || !Number.isFinite(value)) delete config[key];
  else config[key] = Math.max(0, Math.trunc(value));
  return JSON.stringify(config, null, 2);
}

function readTimePricing(text: string): TimePricingForm {
  const raw = readConfig(text).timePricing;
  const config = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const periods = Array.isArray(config.periods) ? config.periods.flatMap((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const period = value as Record<string, unknown>;
    return [{
      id: String(period.id || `period-${index + 1}`),
      name: String(period.name || `时段 ${index + 1}`),
      daysOfWeek: Array.isArray(period.daysOfWeek)
        ? period.daysOfWeek.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
        : [0, 1, 2, 3, 4, 5, 6],
      startMinute: Number.isInteger(Number(period.startMinute)) ? Number(period.startMinute) : 0,
      endMinute: Number.isInteger(Number(period.endMinute)) ? Number(period.endMinute) : 8 * 60,
      multiplierBps: Number.isInteger(Number(period.multiplierBps)) ? Number(period.multiplierBps) : 8_000,
    }];
  }) : [];
  return {
    enabled: config.enabled === true,
    timezone: String(config.timezone || "Asia/Shanghai"),
    periods,
  };
}

function writeTimePricing(text: string, timePricing: TimePricingForm) {
  const config = readConfig(text);
  config.timePricing = timePricing;
  return JSON.stringify(config, null, 2);
}

function minuteText(value: number) {
  const minute = Math.min(1_439, Math.max(0, Math.trunc(value || 0)));
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

function minuteValue(value: string) {
  const [hour, minute] = value.split(":").map(Number);
  return Math.min(1_439, Math.max(0, (Number.isFinite(hour) ? hour : 0) * 60 + (Number.isFinite(minute) ? minute : 0)));
}

function channelName(channel: ProviderChannel) {
  return String(channel.name || channel.channelName || channel.provider || "未命名渠道");
}

function providerName(value: unknown) {
  return providerLabels[value as ProviderChannelProvider] || String(value || "自定义");
}

function priceLabel(value: number | null, fallback?: number, tokenPricing = false) {
  const resolved = value == null ? fallback : value;
  if (resolved == null || !Number.isFinite(resolved)) return "未设置";
  return `${resolved.toLocaleString("zh-CN", { maximumFractionDigits: 6 })} ${tokenPricing ? "GU / M tokens" : "GU"}`;
}

function hasActiveAdvancedPricing(text: string) {
  const config = readConfig(text);
  return typeof config.pricingExpr === "string" && config.pricingExpr.trim().length > 0
    || Number(config.multiplier ?? 1) !== 1
    || Number(config.minimumMicros ?? 0) > 0
    || Number(config.groupRatio ?? 1) !== 1;
}

export function ModelPricingEditor({
  form,
  initialForm,
  channels,
  channelId,
  saving,
  error,
  conflicts,
  identityLocked = false,
  onChange,
  onChannelChange,
  onSave,
}: {
  form: PricingRuleForm;
  initialForm: PricingRuleForm;
  channels: ProviderChannel[];
  channelId: string;
  saving: boolean;
  error: string;
  conflicts: string[];
  identityLocked?: boolean;
  onChange: (form: PricingRuleForm) => void;
  onChannelChange: (channelId: string) => void;
  onSave: () => void;
}) {
  const dirty = JSON.stringify(form) !== JSON.stringify(initialForm);
  const compatibleChannels = useMemo(() => channels.filter((channel) => {
    if (!pricingEndpoints.includes(String(channel.endpointType) as PricingEndpoint)) return false;
    if (form.scope === "workspace") {
      const isPlatformChannel = channel.scope !== "workspace";
      const isSameWorkspace = channel.scope === "workspace"
        && String(channel.workspaceId || "") === form.workspaceId;
      if (!isPlatformChannel && !isSameWorkspace) return false;
    } else if (channel.scope === "workspace") {
      return false;
    }
    if (channel.disabled && String(channel.id) !== channelId) return false;
    return true;
  }), [channelId, channels, form.scope, form.workspaceId]);
  const selectedChannel = compatibleChannels.find((channel) => String(channel.id) === channelId) || null;
  const relevantChannels = useMemo(() => compatibleChannels.filter((channel) => (
    (!form.endpointType || channel.endpointType === form.endpointType)
    && (!form.provider || channel.provider === form.provider)
  )), [compatibleChannels, form.endpointType, form.provider]);
  const modelOptions = useMemo(() => {
    const source = selectedChannel ? [selectedChannel] : relevantChannels;
    const models = source.flatMap((channel) => parseProviderModelNames(channel.modelNames))
      .filter((model) => model && model !== "*");
    if (form.model) models.push(form.model);
    return [...new Set(models)].sort((left, right) => left.localeCompare(right));
  }, [form.model, relevantChannels, selectedChannel]);
  const allowedUnits = pricingUnitsForEndpoint(form.endpointType);
  const isTokenPricing = form.endpointType === "text" && form.unit === "token";
  const isVideoPricing = form.endpointType === "video_generation";
  const isVideoTokenPricing = form.endpointType === "video_generation" && form.unit === "token";
  const isAnyTokenPricing = form.unit === "token";
  const outputPrice = positiveTokenPriceFromConfig(form.ruleConfigText, "outputPriceMicros");
  const cacheReadPrice = priceFromConfig(form.ruleConfigText, "cacheReadPriceMicros");
  const cacheWritePrice = priceFromConfig(form.ruleConfigText, "cacheWritePriceMicros");
  const timePricing = readTimePricing(form.ruleConfigText);
  const scheduleError = useMemo(
    () => validateTimePricingRuleConfig(readConfig(form.ruleConfigText)),
    [form.ruleConfigText],
  );
  const videoTokenUpperBound = positiveIntegerFromConfig(form.ruleConfigText, "reservationUpperBoundTokens");
  const videoInputPricing = readVideoInputPricingFormState(
    form.ruleConfigText,
    form.unit,
    form.unitPriceGu,
  );
  const advancedPricingActive = hasActiveAdvancedPricing(form.ruleConfigText);
  const update = <K extends keyof PricingRuleForm>(key: K, value: PricingRuleForm[K]) => onChange({ ...form, [key]: value });
  const setOptionalPrice = (key: OptionalPriceKey, value: number | null) => update("ruleConfigText", writeConfigPrice(form.ruleConfigText, key, value));
  const setTimePricing = (value: TimePricingForm) => update("ruleConfigText", writeTimePricing(form.ruleConfigText, value));
  const priceError = !Number.isFinite(form.unitPriceGu) || form.unitPriceGu < 0
    ? "单价必须是非负数"
    : !form.disabled && form.unitPriceGu <= 0
      ? "启用中的模型定价必须大于 0 GU"
      : "";
  const endpointError = pricingEndpoints.includes(form.endpointType as PricingEndpoint)
    ? ""
    : `不支持的能力类型「${form.endpointType || "空值"}」`;
  const unitError = endpointError || isPricingUnitForEndpoint(form.endpointType, form.unit)
    ? ""
    : "当前计费单位与模型能力不匹配";
  const videoTokenUpperBoundError = isVideoTokenPricing && !form.disabled && videoTokenUpperBound == null
    ? "请输入大于 0 的整数；系统会按此上限预扣，任务完成后按真实用量结算"
    : "";
  const videoTokenProviderError = isVideoTokenPricing && !form.disabled && form.provider !== "volcano"
    ? "视频 Token 计费目前仅支持能返回权威 Token 用量的火山引擎渠道"
    : "";
  const videoInputPricingError = isVideoPricing && videoInputPricing.enabled && !videoInputPricing.valid
    ? "有视频输入和无视频输入必须同时配置大于 0 的单价"
    : "";
  const saveBlocked = !form.name.trim()
    || Boolean(priceError)
    || Boolean(endpointError)
    || Boolean(unitError)
    || Boolean(videoTokenUpperBoundError)
    || Boolean(videoTokenProviderError)
    || Boolean(videoInputPricingError)
    || Boolean(scheduleError)
    || (!form.disabled && conflicts.length > 0);

  function requestSave() {
    if (!saving && !saveBlocked) onSave();
  }

  function selectChannel(nextChannelId: string) {
    onChannelChange(nextChannelId);
    const channel = channels.find((item) => String(item.id) === nextChannelId);
    if (!channel) return;
    const endpointType = String(channel.endpointType || "") as PricingEndpoint;
    const nextUnits = pricingUnitsForEndpoint(endpointType);
    const models = parseProviderModelNames(channel.modelNames);
    onChange({
      ...form,
      endpointType,
      provider: String(channel.provider || ""),
      model: models.includes(form.model) ? form.model : models[0] || "",
      unit: isPricingUnitForEndpoint(endpointType, form.unit) ? form.unit : nextUnits[0] || "",
    });
  }

  return (
    <section className="modelPricingEditor" aria-label="模型定价编辑器">
      <header className="modelPricingEditor__header">
        <div>
          <span className="modelPricingEditor__eyebrow">{form.id ? "编辑模型定价" : "新增模型定价"}</span>
          <h2>{form.model || form.name || "选择一个模型开始定价"}</h2>
          <p>渠道负责承载多个模型；这里为公开模型设置独立 GU 价格。</p>
        </div>
        <div className="modelPricingEditor__headerActions">
          {dirty ? <Badge tone="warning">有未保存更改</Badge> : <Badge tone="neutral" icon={<Check size={13} />}>已同步</Badge>}
          <Button
            icon={<Save size={16} />}
            loading={saving}
            disabled={saveBlocked}
            onClick={requestSave}
          >
            保存模型定价
          </Button>
        </div>
      </header>

      <div className="modelPricingEditor__content">
        <div className="modelPricingEditor__alerts">
          {error ? <Alert tone="danger" title="模型定价保存失败">{error}</Alert> : null}
          {conflicts.length ? <Alert tone="warning" title="存在重复模型定价">{conflicts.join("、")} 已使用相同模型与计费单位，请先调整选择条件。</Alert> : null}
          {advancedPricingActive ? (
            <Alert tone="warning" title="当前记录使用高级计费">
              保存后会切换为本页展示的直接模型定价；原表达式、倍率和最低消费将保存在 directPricingBackup 中。
            </Alert>
          ) : null}
          {videoInputPricingError ? <Alert tone="danger" title="视频输入分档定价不完整">{videoInputPricingError}</Alert> : null}
        </div>

        <div className="modelPricingEditor__body">
        <form className="modelPricingEditor__form" onSubmit={(event) => { event.preventDefault(); requestSave(); }}>
          <FieldGroup variant="section" legend="模型归属" description="从渠道选择模型，避免手工输入不存在的供应商或模型标识。">
            <div className="modelPricingEditor__formGrid">
              <FormField className="modelPricingEditor__wide" label="渠道" help={selectedChannel ? `${providerName(selectedChannel.provider)} · ${parseProviderModelNames(selectedChannel.modelNames).length} 个模型` : "可不限定具体渠道，按供应商和能力定价。"}>
                <Select disabled={identityLocked} value={selectedChannel ? channelId : ""} onChange={(event) => selectChannel(event.currentTarget.value)}>
                  <option value="">不限具体渠道</option>
                  {compatibleChannels.map((channel) => (
                    <option key={String(channel.id)} value={String(channel.id)}>
                      {channelName(channel)} · {parseProviderModelNames(channel.modelNames).length} 个模型
                    </option>
                  ))}
                </Select>
              </FormField>
              <FormField label="模型" optionalLabel="留空通配" help={modelOptions.length ? `当前来源共 ${modelOptions.length} 个模型。` : "当前渠道尚未配置模型，可保留历史模型或先到渠道页添加。"}>
                <Select disabled={identityLocked} value={form.model} onChange={(event) => update("model", event.currentTarget.value)}>
                  <option value="">全部模型（通配）</option>
                  {modelOptions.map((model) => <option key={model} value={model}>{model}</option>)}
                </Select>
              </FormField>
              <FormField label="能力" required optionalLabel={null} error={endpointError || undefined}>
                <Select disabled={identityLocked} value={form.endpointType} onChange={(event) => {
                  const endpointType = event.currentTarget.value as PricingEndpoint;
                  const units = pricingUnitsForEndpoint(endpointType);
                  onChannelChange("");
                  onChange({
                    ...form,
                    endpointType,
                    model: "",
                    unit: isPricingUnitForEndpoint(endpointType, form.unit) ? form.unit : units[0] || "",
                  });
                }}>
                  {endpointError ? <option value={form.endpointType}>不支持 · {form.endpointType || "空值"}</option> : null}
                  {pricingEndpoints.map((value) => <option key={value} value={value}>{endpointLabels[value]}</option>)}
                </Select>
              </FormField>
              <FormField label="供应商" help="用于计费匹配；选择渠道后自动带入。" error={videoTokenProviderError || undefined}>
                <Select disabled={identityLocked} value={form.provider} onChange={(event) => { onChannelChange(""); update("provider", event.currentTarget.value); }}>
                  {form.provider && !pricingProviders.some((value) => value === form.provider)
                    ? <option value={form.provider}>{providerName(form.provider)}</option>
                    : null}
                  {pricingProviders.map((value) => <option key={value || "all"} value={value}>{value ? providerName(value) : "全部供应商"}</option>)}
                </Select>
              </FormField>
              <FormField label="定价名称" required optionalLabel={null}>
                <Input disabled={identityLocked} value={form.name} onChange={(event) => update("name", event.currentTarget.value)} />
              </FormField>
              <FormField label="范围" required optionalLabel={null}>
                <Select disabled={identityLocked} value={form.scope} onChange={(event) => {
                  onChannelChange("");
                  update("scope", event.currentTarget.value as PricingScope);
                }}>
                  <option value="platform">平台</option>
                  <option value="workspace">工作区</option>
                </Select>
              </FormField>
              {form.scope === "workspace" ? (
                <FormField className="modelPricingEditor__wide" label="Workspace ID" required optionalLabel={null}>
                  <Input disabled={identityLocked} value={form.workspaceId} onChange={(event) => update("workspaceId", event.currentTarget.value)} />
                </FormField>
              ) : null}
            </div>
          </FieldGroup>

          <FieldGroup variant="section" legend="计费方式" description="根据模型能力选择合法计费单位；价格统一使用 GU。">
            <div className="modelPricingEditor__pricingMode" role="radiogroup" aria-label="计费单位">
              {allowedUnits.map((unit) => (
                <button
                  key={unit}
                  type="button"
                  role="radio"
                  aria-checked={form.unit === unit}
                  className={form.unit === unit ? "is-active" : undefined}
                  onClick={() => update("unit", unit)}
                >
                  {unitLabels[unit]}
                </button>
              ))}
            </div>

            <div className="modelPricingEditor__priceGrid">
              <article className="modelPricingPriceCard modelPricingPriceCard--primary">
                <div className="modelPricingPriceCard__heading">
                  <span><CircleDollarSign size={16} />{isTokenPricing ? "输入价格" : isVideoTokenPricing ? "Token 价格" : "基础价格"}</span>
                  <Badge tone="info">必填</Badge>
                </div>
                <p>{isTokenPricing
                  ? "每 100 万个输入 Token 的 GU 价格。"
                  : isVideoTokenPricing
                    ? "按上游视频生成 Token 用量结算，界面统一按每 100 万 Token 展示。"
                    : `${unitLabels[form.unit] || form.unit}的 GU 价格。`}</p>
                <FormField label={isAnyTokenPricing ? "单价（GU / M tokens）" : "单价（GU）"} required optionalLabel={null} error={priceError || undefined}>
                  <NumberInput value={form.unitPriceGu} min={0} step={0.000001} onValueChange={(value) => update("unitPriceGu", value ?? 0)} />
                </FormField>
              </article>

              {isVideoTokenPricing ? (
                <article className="modelPricingPriceCard">
                  <div className="modelPricingPriceCard__heading">
                    <span><Gauge size={16} />单次预扣上限</span>
                    <Badge tone="info">必填</Badge>
                  </div>
                  <p>提交前按此 Token 上限冻结额度；终态按上游真实用量扣费，并自动释放差额。</p>
                  <FormField label="最大预扣 Token" required optionalLabel={null} error={videoTokenUpperBoundError || undefined}>
                    <NumberInput
                      value={videoTokenUpperBound ?? 0}
                      min={1}
                      step={1}
                      onValueChange={(value) => update("ruleConfigText", writeConfigInteger(form.ruleConfigText, "reservationUpperBoundTokens", value))}
                    />
                  </FormField>
                </article>
              ) : null}

              {isTokenPricing ? (
                <>
                  <article className="modelPricingPriceCard modelPricingPriceCard--output">
                    <div className="modelPricingPriceCard__heading">
                      <span><CircleDollarSign size={16} />输出价格</span>
                      <Badge tone="info">必填</Badge>
                    </div>
                    <p>模型生成内容所消耗的输出 Token，与输入价格独立。</p>
                    <FormField label="单价（GU / M tokens）" required optionalLabel={null}>
                      <NumberInput value={outputPrice ?? form.unitPriceGu} min={0.000001} step={0.000001} onValueChange={(value) => setOptionalPrice("outputPriceMicros", value)} />
                    </FormField>
                  </article>
                  <OptionalPriceCard title="缓存读取价格" description="命中上下文缓存时的输入 Token。" value={cacheReadPrice} fallback={form.unitPriceGu} onChange={(value) => setOptionalPrice("cacheReadPriceMicros", value)} tokenPricing />
                  <OptionalPriceCard title="缓存写入价格" description="创建或写入上下文缓存的 Token。" value={cacheWritePrice} fallback={form.unitPriceGu} onChange={(value) => setOptionalPrice("cacheWritePriceMicros", value)} tokenPricing />
                </>
              ) : null}
            </div>
            {isVideoPricing ? (
              <section className="modelPricingInputTiers" aria-label="视频输入分档定价">
                <div className="modelPricingInputTiers__heading">
                  <div>
                    <strong>按输入模态分档</strong>
                    <p>分别设置“有视频输入”与“无视频输入”的价格，报价和最终执行会绑定同一档。</p>
                  </div>
                  <Switch
                    checked={videoInputPricing.enabled}
                    disabled={!videoInputPricing.enabled && (!Number.isFinite(form.unitPriceGu) || form.unitPriceGu <= 0)}
                    onCheckedChange={(checked) => update(
                      "ruleConfigText",
                      writeVideoInputPricingEnabled(
                        form.ruleConfigText,
                        form.unit,
                        form.unitPriceGu,
                        checked,
                      ),
                    )}
                    label="启用视频输入分档定价"
                    description="未启用时两种输入共用基础价格。"
                  />
                </div>
                {videoInputPricing.enabled ? (
                  <div className="modelPricingEditor__priceGrid">
                    <VideoInputTierPriceCard
                      title="有视频输入"
                      description="请求内实际包含 video_url 参考时使用。"
                      value={videoInputPricing.withVideoInputPriceGu}
                      tokenPricing={isAnyTokenPricing}
                      onChange={(value) => update(
                        "ruleConfigText",
                        writeVideoInputPricingTierPrice(
                          form.ruleConfigText,
                          form.unit,
                          "withVideoInput",
                          value,
                        ),
                      )}
                    />
                    <VideoInputTierPriceCard
                      title="无视频输入"
                      description="纯文本、图片参考或其他不含视频的请求使用。"
                      value={videoInputPricing.withoutVideoInputPriceGu}
                      tokenPricing={isAnyTokenPricing}
                      onChange={(value) => update(
                        "ruleConfigText",
                        writeVideoInputPricingTierPrice(
                          form.ruleConfigText,
                          form.unit,
                          "withoutVideoInput",
                          value,
                        ),
                      )}
                    />
                  </div>
                ) : null}
              </section>
            ) : null}
            {identityLocked ? null : <Switch checked={form.disabled} onCheckedChange={(checked) => update("disabled", checked)} label="保存为停用定价" description="停用后不参与新任务计费匹配。" />}
          </FieldGroup>

          <FieldGroup
            variant="section"
            legend="分时定价"
            description="按指定时区、星期与时间段调整价格；新请求在开始时冻结命中的倍率。"
          >
            <div className="timePricingHeader">
              <Switch
                checked={timePricing.enabled}
                onCheckedChange={(enabled) => setTimePricing({
                  ...timePricing,
                  enabled,
                  periods: enabled && !timePricing.periods.length
                    ? [{ id: `period-${Date.now()}`, name: "谷时", daysOfWeek: [0, 1, 2, 3, 4, 5, 6], startMinute: 0, endMinute: 8 * 60, multiplierBps: 8_000 }]
                    : timePricing.periods,
                })}
                label="启用分时定价"
                description="未命中任何时段时使用基础价格。"
              />
              <FormField label="计费时区" optionalLabel={null} help="IANA 时区，例如 Asia/Shanghai">
                <Input
                  value={timePricing.timezone}
                  disabled={!timePricing.enabled}
                  onChange={(event) => setTimePricing({ ...timePricing, timezone: event.currentTarget.value })}
                />
              </FormField>
            </div>

            {scheduleError ? <Alert tone="warning" title="分时配置待完善">{scheduleError}</Alert> : null}

            {timePricing.enabled ? (
              <div className="timePricingPeriods">
                {timePricing.periods.map((period, periodIndex) => (
                  <article className="timePricingPeriod" key={period.id}>
                    <div className="timePricingPeriod__title">
                      <Clock3 size={15} />
                      <Input
                        aria-label={`时段 ${periodIndex + 1} 名称`}
                        value={period.name}
                        onChange={(event) => setTimePricing({
                          ...timePricing,
                          periods: timePricing.periods.map((item) => item.id === period.id ? { ...item, name: event.currentTarget.value } : item),
                        })}
                      />
                      <Button
                        variant="ghost"
                        size="compact"
                        icon={<Trash2 size={14} />}
                        aria-label={`删除${period.name || `时段 ${periodIndex + 1}`}`}
                        onClick={() => setTimePricing({ ...timePricing, periods: timePricing.periods.filter((item) => item.id !== period.id) })}
                      />
                    </div>
                    <div className="timePricingPeriod__fields">
                      <FormField label="开始" optionalLabel={null}>
                        <Input
                          type="time"
                          value={minuteText(period.startMinute)}
                          onChange={(event) => setTimePricing({
                            ...timePricing,
                            periods: timePricing.periods.map((item) => item.id === period.id ? { ...item, startMinute: minuteValue(event.currentTarget.value) } : item),
                          })}
                        />
                      </FormField>
                      <FormField label="结束" optionalLabel={null} help={period.endMinute <= period.startMinute ? "跨至次日" : undefined}>
                        <Input
                          type="time"
                          value={minuteText(period.endMinute)}
                          onChange={(event) => setTimePricing({
                            ...timePricing,
                            periods: timePricing.periods.map((item) => item.id === period.id ? { ...item, endMinute: minuteValue(event.currentTarget.value) } : item),
                          })}
                        />
                      </FormField>
                      <FormField label="价格倍率" optionalLabel={null} help={`${(period.multiplierBps / 100).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}%`}>
                        <NumberInput
                          value={period.multiplierBps / 10_000}
                          min={0.01}
                          max={100}
                          step={0.05}
                          onValueChange={(value) => setTimePricing({
                            ...timePricing,
                            periods: timePricing.periods.map((item) => item.id === period.id ? { ...item, multiplierBps: Math.round((value ?? 1) * 10_000) } : item),
                          })}
                        />
                      </FormField>
                    </div>
                    <div className="timePricingWeekdays" aria-label={`${period.name}生效星期`}>
                      {weekdayLabels.map((label, day) => {
                        const active = period.daysOfWeek.includes(day);
                        return (
                          <button
                            key={day}
                            type="button"
                            aria-pressed={active}
                            className={active ? "is-active" : undefined}
                            onClick={() => setTimePricing({
                              ...timePricing,
                              periods: timePricing.periods.map((item) => item.id === period.id ? {
                                ...item,
                                daysOfWeek: active ? item.daysOfWeek.filter((value) => value !== day) : [...item.daysOfWeek, day].sort(),
                              } : item),
                            })}
                          >{label}</button>
                        );
                      })}
                    </div>
                  </article>
                ))}
                <Button
                  variant="secondary"
                  size="compact"
                  icon={<Plus size={14} />}
                  onClick={() => setTimePricing({
                    ...timePricing,
                    periods: [...timePricing.periods, {
                      id: `period-${Date.now()}`,
                      name: `时段 ${timePricing.periods.length + 1}`,
                      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
                      startMinute: 8 * 60,
                      endMinute: 18 * 60,
                      multiplierBps: 10_000,
                    }],
                  })}
                >添加时段</Button>
              </div>
            ) : null}
          </FieldGroup>
        </form>

        <aside className="modelPricingPreview" aria-label="模型定价预览">
          <header><Database size={16} /><strong>定价预览</strong></header>
          <dl>
            <div><dt>模型</dt><dd>{form.model || "全部模型"}</dd></div>
            <div><dt>渠道</dt><dd>{selectedChannel ? channelName(selectedChannel) : "不限渠道"}</dd></div>
            <div><dt>能力</dt><dd>{endpointLabels[form.endpointType as PricingEndpoint] || channelEndpointLabels[form.endpointType as keyof typeof channelEndpointLabels] || form.endpointType || "-"}</dd></div>
            <div><dt>计费单位</dt><dd>{unitLabels[form.unit] || form.unit || "-"}</dd></div>
            <div><dt>{isTokenPricing ? "输入价格" : isVideoTokenPricing ? "Token 价格" : "基础价格"}</dt><dd>{priceLabel(form.unitPriceGu, undefined, isAnyTokenPricing)}</dd></div>
            {isVideoTokenPricing ? <>
              <div><dt>预扣上限</dt><dd>{videoTokenUpperBound?.toLocaleString("zh-CN") || "未设置"} Token</dd></div>
              <div><dt>最大冻结</dt><dd>{videoTokenUpperBound ? priceLabel(form.unitPriceGu * videoTokenUpperBound / 1_000_000) : "未设置"}</dd></div>
            </> : null}
            {isVideoPricing && videoInputPricing.enabled ? <>
              <div><dt>有视频输入</dt><dd>{priceLabel(videoInputPricing.withVideoInputPriceGu, undefined, isAnyTokenPricing)}</dd></div>
              <div><dt>无视频输入</dt><dd>{priceLabel(videoInputPricing.withoutVideoInputPriceGu, undefined, isAnyTokenPricing)}</dd></div>
            </> : null}
            {isTokenPricing ? <>
              <div><dt>输出价格</dt><dd>{priceLabel(outputPrice, form.unitPriceGu, true)}</dd></div>
              <div><dt>缓存读取</dt><dd>{priceLabel(cacheReadPrice, form.unitPriceGu, true)}</dd></div>
              <div><dt>缓存写入</dt><dd>{priceLabel(cacheWritePrice, form.unitPriceGu, true)}</dd></div>
            </> : null}
            <div><dt>分时定价</dt><dd>{timePricing.enabled ? `${timePricing.timezone} · ${timePricing.periods.length} 个时段` : "未启用"}</dd></div>
            <div><dt>状态</dt><dd><Badge tone={form.disabled ? "neutral" : "success"}>{form.disabled ? "停用" : "启用"}</Badge></dd></div>
          </dl>
          <p><Boxes size={14} />一个渠道可以承载多个模型；每个模型保留独立定价记录。</p>
        </aside>
        </div>
      </div>
    </section>
  );
}

function VideoInputTierPriceCard({ title, description, value, tokenPricing, onChange }: {
  title: string;
  description: string;
  value: number;
  tokenPricing: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <article className="modelPricingPriceCard is-enabled">
      <div className="modelPricingPriceCard__heading">
        <span>{title}</span>
        <Badge tone="info">必填</Badge>
      </div>
      <p>{description}</p>
      <FormField label={tokenPricing ? "单价（GU / M tokens）" : "单价（GU）"} required optionalLabel={null}>
        <NumberInput
          value={value}
          min={tokenPricing ? 1 : 0.000001}
          step={tokenPricing ? 1 : 0.000001}
          onValueChange={(next) => {
            if (next != null && Number.isFinite(next) && next > 0) onChange(next);
          }}
        />
      </FormField>
    </article>
  );
}

function OptionalPriceCard({ title, description, value, fallback, onChange, tokenPricing = false }: {
  title: string;
  description: string;
  value: number | null;
  fallback: number;
  onChange: (value: number | null) => void;
  tokenPricing?: boolean;
}) {
  const enabled = value != null;
  return (
    <article className={`modelPricingPriceCard${enabled ? " is-enabled" : ""}`}>
      <div className="modelPricingPriceCard__heading">
        <span>{title}</span>
        <Switch className="modelPricingPriceCard__switch" checked={enabled} onCheckedChange={(checked) => onChange(checked ? fallback : null)} label={`启用${title}`} />
      </div>
      <p>{description}</p>
      <FormField label={tokenPricing ? "单价（GU / M tokens）" : "单价（GU）"} optionalLabel={null}>
        <NumberInput value={value ?? fallback} min={0} step={0.000001} disabled={!enabled} onValueChange={(next) => onChange(next ?? 0)} />
      </FormField>
    </article>
  );
}
