import { useMemo, useRef } from "react";
import { Save } from "lucide-react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Alert,
  Button,
  CodeEditor,
  Drawer,
  FieldGroup,
  FormGrid,
  FormField,
  Input,
  NumberInput,
  Select,
  Switch,
} from "../../../../ui/console";
import {
  endpointLabels,
  isPricingUnitForEndpoint,
  pricingEndpoints,
  pricingProviders,
  pricingScopes,
  pricingUnitsForEndpoint,
  unitLabels,
  type PricingEndpoint,
  type PricingRuleForm,
  type PricingScope,
} from "./types";

export function PricingRuleDrawer({ open, form, initialForm, saving, error, conflicts, onChange, onSave, onOpenChange }: {
  open: boolean; form: PricingRuleForm; initialForm: PricingRuleForm; saving: boolean; error: string; conflicts: string[];
  onChange: (form: PricingRuleForm) => void; onSave: () => void; onOpenChange: (open: boolean) => void;
}) {
  const nameRef = useRef<HTMLInputElement>(null);
  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(initialForm), [form, initialForm]);
  const update = <K extends keyof PricingRuleForm>(key: K, value: PricingRuleForm[K]) => onChange({ ...form, [key]: value });
  let jsonError = "";
  try { const parsed = JSON.parse(form.ruleConfigText || "{}"); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) jsonError = "配置必须是 JSON 对象"; }
  catch { jsonError = "JSON 格式错误"; }
  const endpointError = pricingEndpoints.includes(form.endpointType as PricingEndpoint)
    ? ""
    : `不支持的能力类型「${form.endpointType || "空值"}」，请选择有效能力。`;
  const allowedUnits = pricingUnitsForEndpoint(form.endpointType);
  const unitError = (endpointError || isPricingUnitForEndpoint(form.endpointType, form.unit))
    ? ""
    : `计费单位「${form.unit || "空值"}」无效；${endpointLabels[form.endpointType as PricingEndpoint]}仅支持：${allowedUnits.join("、")}`;
  const priceError = !Number.isFinite(form.unitPriceGu) || form.unitPriceGu < 0
    ? "单价必须是非负数"
    : !form.disabled && form.unitPriceGu <= 0
      ? "启用规则的单价必须大于 0 GU"
      : "";
  return <Drawer open={open} className="pricingRuleDrawer" title={form.id ? "编辑价格规则" : "新增价格规则"} description="明确匹配范围、计费单位和 GU 单价；重复启用选择器会被阻止。" size="min(760px, 100vw)" dirty={dirty} loading={saving} initialFocusRef={nameRef} onOpenChange={onOpenChange}
    footer={<div className="pricingDrawerActions"><Button type="submit" form="pricing-rule-form" icon={<Save size={17} />} loading={saving} disabled={!form.name.trim() || Boolean(jsonError) || Boolean(priceError) || Boolean(endpointError) || Boolean(unitError) || (!form.disabled && conflicts.length > 0)}>保存规则</Button></div>}>
    <form id="pricing-rule-form" className="pricingForm" onSubmit={(event) => { event.preventDefault(); onSave(); }}>
      {error && <Alert tone="danger" title="规则保存失败">{error}</Alert>}
      {conflicts.length > 0 && <Alert tone="warning" title="存在重复启用选择器"><span>{conflicts.join("、")}</span><small>请修改匹配条件，或先保存为停用规则。</small></Alert>}
      <FieldGroup variant="section" legend="规则信息" description="名称用于后台识别；范围决定规则对平台或指定工作区生效。"><FormGrid>
        <FormField label="规则名称" required optionalLabel={null}><Input ref={nameRef} value={form.name} onChange={(e) => update("name", e.currentTarget.value)} /></FormField>
        <FormField label="范围" required optionalLabel={null}><Select value={form.scope} onChange={(e) => update("scope", e.currentTarget.value as PricingScope)}>{pricingScopes.map((value) => <option key={value} value={value}>{value === "platform" ? "平台" : "工作区"}</option>)}</Select></FormField>
        {form.scope === "workspace" && <FormField label="Workspace ID" required optionalLabel={null}><Input value={form.workspaceId} onChange={(e) => update("workspaceId", e.currentTarget.value)} /></FormField>}
      </FormGrid></FieldGroup>
      <FieldGroup variant="section" legend="匹配条件" description="供应商或模型留空代表通配；更具体的规则应避免与现有选择器重复。"><FormGrid>
        <FormField label="能力" required optionalLabel={null} error={endpointError || undefined}><Select value={form.endpointType} onChange={(e) => {
          const endpointType = e.currentTarget.value as PricingEndpoint;
          const nextUnits = pricingUnitsForEndpoint(endpointType);
          onChange({
            ...form,
            endpointType,
            unit: isPricingUnitForEndpoint(endpointType, form.unit) ? form.unit : nextUnits[0] || "",
          });
        }}>{endpointError && <option value={form.endpointType}>不支持 · {form.endpointType || "空值"}</option>}{pricingEndpoints.map((value) => <option key={value} value={value}>{endpointLabels[value]}</option>)}</Select></FormField>
        <FormField label="供应商" help="留空匹配全部供应商。"><Select value={form.provider} onChange={(e) => update("provider", e.currentTarget.value)}>{pricingProviders.map((value) => <option key={value || "all"} value={value}>{value || "全部供应商"}</option>)}</Select></FormField>
        <FormField label="模型" help="留空匹配该能力下全部模型。"><Input value={form.model} placeholder="例如 seedance-2-0" onChange={(e) => update("model", e.currentTarget.value)} /></FormField>
      </FormGrid></FieldGroup>
      <FieldGroup variant="section" legend="价格与计费单位" description="单价统一以 GU 展示，接口继续按 micros 保存。"><FormGrid>
        <FormField label="计费单位" required optionalLabel={null} error={unitError || undefined} help={!unitError ? "可选单位随能力类型自动限制。" : undefined}><Select value={form.unit} onChange={(e) => update("unit", e.currentTarget.value)}>{allowedUnits.map((value) => <option key={value} value={value}>{unitLabels[value]}（{value}）</option>)}</Select></FormField>
        <FormField label="单价（GU）" required optionalLabel={null} error={priceError || undefined}><NumberInput value={form.unitPriceGu} min={0} step={0.000001} onValueChange={(value) => update("unitPriceGu", value ?? 0)} /></FormField>
      </FormGrid><Switch checked={form.disabled} onCheckedChange={(checked) => update("disabled", checked)} label="保存为停用规则" description="停用后不参与计费匹配。" /></FieldGroup>
      <Accordion className="pricingAdvanced">
        <AccordionItem value="pricing-advanced-rule-config">
          <AccordionTrigger>高级规则配置</AccordionTrigger>
          <AccordionContent contentClassName="pricingAdvancedContent">
            <FormField label="Rule Config JSON" error={jsonError || undefined} help={!jsonError ? "JSON 格式正确" : undefined} optionalLabel={null}>
              <CodeEditor language="json" minRows={8} value={form.ruleConfigText} onChange={(e) => update("ruleConfigText", e.currentTarget.value)} />
            </FormField>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </form>
  </Drawer>;
}
