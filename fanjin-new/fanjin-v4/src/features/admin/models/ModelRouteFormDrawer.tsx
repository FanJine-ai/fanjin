import { useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Save, ShieldCheck } from "lucide-react";
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
  FormField,
  Input,
  NumberInput,
  Select,
  Switch,
} from "../../../ui/console";
import { ModelRouteReadinessPanel } from "./ModelRouteReadiness";
import type { ModelRouteForm, ModelRouteReadiness } from "./types";
import {
  endpointLabel,
  modelRouteEndpointTypes,
  modelRouteProviders,
  modelRouteScopes,
  validateModelRouteForm,
  type ModelRouteFormErrors,
} from "./utils";

interface ModelRouteFormDrawerProps {
  open: boolean;
  form: ModelRouteForm;
  initialForm: ModelRouteForm;
  saving: boolean;
  preflighting: boolean;
  preflight: ModelRouteReadiness | null;
  error: string;
  onChange: (form: ModelRouteForm) => void;
  onPreflight: () => void;
  onSave: () => void;
  onOpenChange: (open: boolean) => void;
}

const providerLabels: Record<string, string> = {
  "": "自动匹配 / 未指定",
  volcano: "Volcano",
  custom: "Custom",
  openai: "OpenAI",
  anthropic: "Anthropic",
  codex: "Codex",
  gemini: "Gemini",
  azure: "Azure",
};

export function ModelRouteFormDrawer({
  open,
  form,
  initialForm,
  saving,
  preflighting,
  preflight,
  error,
  onChange,
  onPreflight,
  onSave,
  onOpenChange,
}: ModelRouteFormDrawerProps) {
  const [activeStep, setActiveStep] = useState(0);
  const [furthestStep, setFurthestStep] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const [touched, setTouched] = useState<Partial<Record<keyof ModelRouteFormErrors, boolean>>>({});
  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(initialForm), [form, initialForm]);
  const errors = validateModelRouteForm(form);
  const hasErrors = Object.keys(errors).length > 0;
  const scopeSupported = modelRouteScopes.includes(form.scope as (typeof modelRouteScopes)[number]);
  const endpointSupported = modelRouteEndpointTypes.includes(form.endpointType as (typeof modelRouteEndpointTypes)[number]);
  const providerSupported = modelRouteProviders.includes(form.provider as (typeof modelRouteProviders)[number]);
  const update = <Key extends keyof ModelRouteForm>(key: Key, value: ModelRouteForm[Key]) => {
    onChange({ ...form, [key]: value });
  };
  const markTouched = (field: keyof ModelRouteFormErrors) => {
    setTouched((current) => current[field] ? current : { ...current, [field]: true });
  };
  const visibleError = (field: keyof ModelRouteFormErrors) => (
    touched[field] || Boolean(form.id) ? errors[field] : undefined
  );
  const steps = [
    { label: "匹配对象", description: "定义路由名称、模型、范围与能力。" },
    { label: "路由拓扑", description: "设置供应商、通道和匹配顺序。" },
    { label: "高级配置", description: "校验 Route Config 后提交。" },
  ] as const;
  const stepFields: ReadonlyArray<ReadonlyArray<keyof ModelRouteFormErrors>> = [
    ["name", "model", "scope", "workspaceId", "endpointType"],
    ["provider", "priority", "fallbackOrder"],
    ["routeConfigText"],
  ];

  const moveToStep = (nextStep: number) => {
    setActiveStep(nextStep);
    setFurthestStep((current) => Math.max(current, nextStep));
    window.requestAnimationFrame(() => {
      const panel = formRef.current?.querySelector<HTMLElement>(`[data-model-route-step="${nextStep}"]`);
      formRef.current?.closest<HTMLElement>(".consoleOverlayContent")?.scrollTo({ top: 0 });
      panel?.querySelector<HTMLElement>("input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])")?.focus({ preventScroll: true });
    });
  };

  const nextStep = () => {
    const fields = stepFields[activeStep];
    const invalidFields = fields.filter((field) => Boolean(errors[field]));
    if (invalidFields.length > 0) {
      setTouched((current) => ({ ...current, ...Object.fromEntries(invalidFields.map((field) => [field, true])) }));
      window.requestAnimationFrame(() => {
        formRef.current
          ?.querySelector<HTMLElement>(`[data-model-route-step="${activeStep}"] [aria-invalid="true"]`)
          ?.focus({ preventScroll: true });
      });
      return;
    }
    moveToStep(Math.min(activeStep + 1, steps.length - 1));
  };

  return (
    <Drawer
      open={open}
      title={form.id ? "编辑模型路由" : "新增模型路由"}
      description="维护模型、范围、供应商通道、优先级和完整 Route Config；保存需要管理员二次验证。"
      size="min(720px, 100vw)"
      dirty={dirty}
      loading={saving || preflighting}
      initialFocusRef={nameRef}
      closeGuardTitle={form.id ? "放弃模型路由修改？" : "放弃创建模型路由？"}
      closeGuardDescription="关闭后，当前表单中尚未保存的拓扑配置将丢失。"
      onOpenChange={onOpenChange}
      footer={(
        <div className="adminModelsDrawerActions">
          {activeStep > 0 ? (
            <Button type="button" variant="ghost" icon={<ChevronLeft size={16} />} disabled={saving || preflighting} onClick={() => moveToStep(activeStep - 1)}>
              上一步
            </Button>
          ) : null}
          {activeStep < steps.length - 1 ? (
            <Button
              key="model-route-next-step"
              type="button"
              icon={<ChevronRight size={16} />}
              iconPosition="end"
              disabled={saving || preflighting}
              onClick={(event) => {
                event.preventDefault();
                nextStep();
              }}
            >
              下一步
            </Button>
          ) : (
            <>
              <Button
                key="model-route-preflight"
                type="button"
                variant="secondary"
                icon={<ShieldCheck size={17} />}
                loading={preflighting}
                disabled={saving || hasErrors}
                onClick={onPreflight}
              >
                只读预检
              </Button>
              <Button
                key="model-route-save"
                type="submit"
                form="model-route-form"
                icon={<Save size={17} />}
                loading={saving}
                disabled={!dirty || hasErrors || preflighting}
              >
                {form.id ? "保存路由" : "创建路由"}
              </Button>
            </>
          )}
        </div>
      )}
    >
      <form
        ref={formRef}
        id="model-route-form"
        className="adminModelsForm"
        inert={preflighting ? true : undefined}
        onSubmit={(event) => {
          event.preventDefault();
          if (activeStep < steps.length - 1) nextStep();
          else onSave();
        }}
      >
        {error ? <Alert tone="danger" title={form.id ? "模型路由保存失败" : "模型路由创建失败"}>{error}</Alert> : null}

        <nav className="adminModelsFormSteps" aria-label="模型路由配置步骤">
          <ol>
            {steps.map((step, index) => (
              <li key={step.label} data-state={index === activeStep ? "active" : index < activeStep ? "complete" : "pending"}>
                <button
                  type="button"
                  aria-current={index === activeStep ? "step" : undefined}
                  disabled={index > furthestStep}
                  onClick={() => moveToStep(index)}
                >
                  <span aria-hidden="true">{index + 1}</span>
                  {step.label}
                </button>
              </li>
            ))}
          </ol>
          <p><strong>步骤 {activeStep + 1}/{steps.length}</strong>{steps[activeStep].description}</p>
        </nav>

        {activeStep === 0 ? <div className="adminModelsFormStep" data-model-route-step="0">
        <FieldGroup variant="section" className="adminModelsFormSection" legend="基本信息" description="名称、范围、能力和模型共同定义该路由匹配的对象。">
          <div className="adminModelsFormGrid">
            <FormField className="adminModelsFormField--wide" label="路由名称" required optionalLabel={null} error={visibleError("name")}>
              <Input ref={nameRef} value={form.name} placeholder="例如：Seedance 主路由" onBlur={() => markTouched("name")} onChange={(event) => update("name", event.currentTarget.value)} />
            </FormField>
            <FormField label="显示名" optionalLabel="可选" help="前台目录与画布展示给用户看的映射名。">
              <Input value={form.displayName} placeholder="留空显示原名" onChange={(event) => update("displayName", event.currentTarget.value)} />
            </FormField>
            <FormField label="超分组合显示名" optionalLabel="可选" help="超分/增强组合的映射名，写入 Route Config 的 enhanceDisplayName。">
              <Input value={form.enhanceDisplayName} placeholder="留空按「显示名 + 超分」展示" onChange={(event) => update("enhanceDisplayName", event.currentTarget.value)} />
            </FormField>
            <FormField className="adminModelsFormField--wide" label="模型 ID" required optionalLabel={null} error={visibleError("model")}>
              <Input value={form.model} placeholder="例如：seedance-2-0" autoCapitalize="off" autoCorrect="off" onBlur={() => markTouched("model")} onChange={(event) => update("model", event.currentTarget.value)} />
            </FormField>
            <FormField label="范围" required optionalLabel={null} error={visibleError("scope")}>
              <Select value={form.scope} onBlur={() => markTouched("scope")} onChange={(event) => update("scope", event.currentTarget.value)}>
                {!scopeSupported ? <option value={form.scope}>不支持 · {form.scope || "空值"}</option> : null}
                <option value="platform">平台</option>
                <option value="workspace">工作区</option>
              </Select>
            </FormField>
            <FormField label="能力类型" required optionalLabel={null} error={visibleError("endpointType")}>
              <Select value={form.endpointType} onBlur={() => markTouched("endpointType")} onChange={(event) => update("endpointType", event.currentTarget.value)}>
                {!endpointSupported ? <option value={form.endpointType}>不支持 · {form.endpointType || "空值"}</option> : null}
                {modelRouteEndpointTypes.map((endpoint) => <option value={endpoint} key={endpoint}>{endpointLabel(endpoint)}</option>)}
              </Select>
            </FormField>
            {form.scope === "workspace" ? (
              <FormField className="adminModelsFormField--wide" label="Workspace ID" required optionalLabel={null} error={visibleError("workspaceId")}>
                <Input value={form.workspaceId} placeholder="workspace id" onBlur={() => markTouched("workspaceId")} onChange={(event) => update("workspaceId", event.currentTarget.value)} />
              </FormField>
            ) : null}
          </div>
        </FieldGroup>
        </div> : null}

        {activeStep === 1 ? <div className="adminModelsFormStep" data-model-route-step="1">
        <FieldGroup variant="section" className="adminModelsFormSection" legend="路由拓扑" description="供应商与通道可留空由后端匹配；数字越小越优先。">
          <div className="adminModelsFormGrid">
            <FormField className="adminModelsFormField--short" label="供应商" error={visibleError("provider")}>
              <Select value={form.provider} onBlur={() => markTouched("provider")} onChange={(event) => update("provider", event.currentTarget.value)}>
                {!providerSupported ? <option value={form.provider}>不支持 · {form.provider}</option> : null}
                {modelRouteProviders.map((provider) => <option value={provider} key={provider || "auto"}>{providerLabels[provider] || provider}</option>)}
              </Select>
            </FormField>
            <FormField className="adminModelsFormField--wide" label="通道 ID" help="留空时按供应商与能力自动选择通道。">
              <Input value={form.channelId} placeholder="provider channel id" autoCapitalize="off" autoCorrect="off" onChange={(event) => update("channelId", event.currentTarget.value)} />
            </FormField>
            <FormField label="优先级" required optionalLabel={null} error={visibleError("priority")}>
              <NumberInput value={form.priority} step={1} onBlur={() => markTouched("priority")} onValueChange={(value) => update("priority", value ?? 100)} />
            </FormField>
            <FormField label="回退顺序" required optionalLabel={null} error={visibleError("fallbackOrder")}>
              <NumberInput value={form.fallbackOrder} step={1} onBlur={() => markTouched("fallbackOrder")} onValueChange={(value) => update("fallbackOrder", value ?? 0)} />
            </FormField>
          </div>
          <Switch
            checked={form.disabled}
            onCheckedChange={(checked) => update("disabled", checked)}
            label="保存为停用状态"
            description="停用路由不会参与新的模型匹配。"
          />
        </FieldGroup>
        </div> : null}

        {activeStep === 2 ? <div className="adminModelsFormStep" data-model-route-step="2">
        {preflight
          ? <ModelRouteReadinessPanel readiness={preflight} />
          : <Alert tone="info" title="保存前生产预检">只读预检会检查用户目录是否可提交，以及通道健康、凭据、GU 定价、Adapter 和 Capability；不会修改线上配置。保存时也会自动重新预检。</Alert>}
        <Accordion className="adminModelsAdvanced">
          <AccordionItem value="model-route-config">
            <AccordionTrigger>Route Config JSON</AccordionTrigger>
            <AccordionContent contentClassName="adminModelsAdvancedContent">
              <FormField
                label="Route Config JSON"
                optionalLabel={null}
                help={!errors.routeConfigText ? "配置将作为 JSON 对象原样提交。" : undefined}
                error={visibleError("routeConfigText")}
              >
                <CodeEditor
                  language="json"
                  minRows={10}
                  value={form.routeConfigText}
                  onBlur={() => markTouched("routeConfigText")}
                  onChange={(event) => update("routeConfigText", event.currentTarget.value)}
                />
              </FormField>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
        </div> : null}
      </form>
    </Drawer>
  );
}
