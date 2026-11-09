import { useEffect, useMemo, useRef, useState } from "react";
import { Cable, ChevronLeft, ChevronRight, Save } from "lucide-react";
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
import { ModelTagEditor } from "./ModelTagEditor";
import type { ProviderChannelModelDiscoveryResult } from "./api";
import {
  createFanjinProviderForm,
  endpointLabels,
  endpointOptions,
  providerLabels,
  providerOptions,
  scopeLabels,
  scopeOptions,
  type ProviderChannelEndpoint,
  type ProviderChannelForm,
  type ProviderChannelFormErrors,
  type ProviderChannelFormField,
  type ProviderChannelProvider,
  type ProviderChannelScope,
} from "./types";

interface ProviderFormDrawerProps {
  open: boolean;
  form: ProviderChannelForm;
  initialForm: ProviderChannelForm;
  saving: boolean;
  testing: boolean;
  discoveringModels: boolean;
  error: string;
  fieldErrors?: ProviderChannelFormErrors;
  onChange: (form: ProviderChannelForm) => void;
  onSave: () => void;
  onTestConnection: () => void;
  onDiscoverModels: () => Promise<ProviderChannelModelDiscoveryResult>;
  onOpenChange: (open: boolean) => void;
}

function validateJson(value: string) {
  try {
    const parsed = JSON.parse(value.trim() || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? "" : "配置必须是 JSON 对象";
  } catch {
    return "JSON 格式错误，请检查引号、逗号和括号";
  }
}

function withResponsesTransport(configText: string, value: string | null): string {
  try {
    const config = JSON.parse(configText.trim() || "{}");
    if (!config || typeof config !== "object" || Array.isArray(config)) return configText;
    if (value === null) delete config.responsesTransport;
    else config.responsesTransport = value;
    return JSON.stringify(config, null, 2);
  } catch { return configText; }
}

export function ProviderFormDrawer({
  open,
  form,
  initialForm,
  saving,
  testing,
  discoveringModels,
  error,
  fieldErrors = {},
  onChange,
  onSave,
  onTestConnection,
  onDiscoverModels,
  onOpenChange,
}: ProviderFormDrawerProps) {
  const [activeStep, setActiveStep] = useState(0);
  const [furthestStep, setFurthestStep] = useState(0);
  const [touched, setTouched] = useState<Partial<Record<ProviderChannelFormField, boolean>>>({});
  const [discoveredModels, setDiscoveredModels] = useState<string[] | null>(null);
  const [modelDiscoveryError, setModelDiscoveryError] = useState("");
  const formRef = useRef<HTMLFormElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const discoveryVersion = useRef(0);
  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(initialForm), [form, initialForm]);
  const jsonError = validateJson(form.configJsonText);
  const responsesTransport = useMemo(() => {
    try { return JSON.parse(form.configJsonText || "{}").responsesTransport || "chat_completions"; }
    catch { return "chat_completions"; }
  }, [form.configJsonText]);
  const endpointError = endpointOptions.includes(form.endpointType as ProviderChannelEndpoint)
    ? ""
    : `不支持的能力类型「${form.endpointType || "空值"}」，请选择有效能力。`;
  const storedCredentialReusable = Boolean(form.id && form.credentialConfigured)
    && form.provider === initialForm.provider
    && form.baseUrl.trim() === initialForm.baseUrl.trim();
  const portraitEligible = form.provider === "volcano" && form.endpointType === "video_generation";
  const portraitCredentialReusable = Boolean(form.id && form.portraitCredentialConfigured)
    && portraitEligible
    && initialForm.provider === "volcano"
    && initialForm.endpointType === "video_generation";
  const portraitCredentialSubmitted = Boolean(
    form.portraitAccessKeyId.trim()
    || form.portraitSecretAccessKey
    || form.portraitSessionToken,
  );
  const portraitNamespaceRequired = Boolean(
    form.portraitAssetsEnabled
    || portraitCredentialSubmitted
    || form.providerAccountId.trim()
    || form.assetsProjectName.trim(),
  );
  const providerAccountIdImmutable = Boolean(form.id && initialForm.providerAccountId.trim());
  const assetsProjectNameImmutable = Boolean(form.id && initialForm.assetsProjectName.trim());
  const connectionReady = Boolean(form.baseUrl.trim())
    && Boolean(form.apiKey.trim() || storedCredentialReusable || form.credentialRef.trim())
    && !endpointError
    && !jsonError;
  const update = <Key extends keyof ProviderChannelForm>(key: Key, value: ProviderChannelForm[Key]) => {
    onChange({ ...form, [key]: value });
  };
  const clientErrors: ProviderChannelFormErrors = {
    ...(!form.name.trim() ? { name: "请输入通道名称。" } : {}),
    ...(!providerOptions.includes(form.provider as ProviderChannelProvider) ? { provider: "请选择有效供应商。" } : {}),
    ...(endpointError ? { endpointType: endpointError } : {}),
    ...(!scopeOptions.includes(form.scope as ProviderChannelScope) ? { scope: "请选择有效范围。" } : {}),
    ...(form.scope === "workspace" && !form.workspaceId.trim() ? { workspaceId: "请输入 Workspace ID。" } : {}),
    ...(!form.apiKey.trim() && !storedCredentialReusable && !form.credentialRef.trim()
      ? { apiKey: "请输入 API Key，或填写环境变量引用。" }
      : {}),
    ...(portraitNamespaceRequired && !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u.test(form.providerAccountId.trim())
      ? { providerAccountId: "请输入有效的火山账号标识。" }
      : {}),
    ...(portraitNamespaceRequired && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(form.assetsProjectName.trim())
      ? { assetsProjectName: "请输入有效的人像资产 ProjectName。" }
      : {}),
    ...(portraitCredentialSubmitted && !form.portraitAccessKeyId.trim()
      ? { portraitAccessKeyId: "请输入人像资产 Access Key ID。" }
      : {}),
    ...(portraitCredentialSubmitted && !form.portraitSecretAccessKey
      ? { portraitSecretAccessKey: "请输入人像资产 Secret Access Key。" }
      : {}),
    ...(form.portraitAssetsEnabled && !portraitCredentialSubmitted && !portraitCredentialReusable
      ? { portraitSecretAccessKey: "启用人像资产前必须配置独立 AK/SK。" }
      : {}),
    ...(!Number.isInteger(form.priority) ? { priority: "优先级必须为整数。" } : {}),
    ...(!Number.isInteger(form.weight) || form.weight < 0 ? { weight: "权重必须为不小于 0 的整数。" } : {}),
    ...(!Number.isInteger(form.timeoutMs) || form.timeoutMs < 1000 ? { timeoutMs: "超时必须为不小于 1000 ms 的整数。" } : {}),
    ...(form.concurrencyLimit !== null && (!Number.isInteger(form.concurrencyLimit) || form.concurrencyLimit < 0)
      ? { concurrencyLimit: "并发上限必须留空或填写不小于 0 的整数。" }
      : {}),
    ...(jsonError ? { configJsonText: jsonError } : {}),
  };
  const errors: ProviderChannelFormErrors = { ...clientErrors, ...fieldErrors };
  const markTouched = (field: ProviderChannelFormField) => {
    setTouched((current) => current[field] ? current : { ...current, [field]: true });
  };
  const visibleError = (field: ProviderChannelFormField) => (
    fieldErrors[field] || (touched[field] || Boolean(form.id) ? clientErrors[field] : undefined)
  );
  const steps = [
    { label: "基本与连接", description: "定义通道身份、范围和服务端连接。" },
    { label: "路由与模型", description: "设置调度限制和可用模型。" },
    { label: "高级配置", description: "校验扩展 JSON 后提交。" },
  ] as const;
  const formInvalid = Object.keys(errors).length > 0;
  const stepFields: ReadonlyArray<ReadonlyArray<ProviderChannelFormField>> = [
    [
      "name",
      "provider",
      "endpointType",
      "scope",
      "workspaceId",
      "apiKey",
      "providerAccountId",
      "assetsProjectName",
      "portraitAccessKeyId",
      "portraitSecretAccessKey",
      "portraitSessionToken",
      "imagexServiceId",
      "imagexAccessKeyId",
      "imagexSecretAccessKey",
      "imagexSessionToken",
    ],
    ["priority", "weight", "timeoutMs", "concurrencyLimit"],
    ["configJsonText"],
  ];

  useEffect(() => {
    if (!open) return;
    setActiveStep(0);
    setFurthestStep(0);
    setTouched({});
    discoveryVersion.current += 1;
    setDiscoveredModels(null);
    setModelDiscoveryError("");
  }, [form.id, open]);

  useEffect(() => {
    discoveryVersion.current += 1;
    setDiscoveredModels(null);
    setModelDiscoveryError("");
  }, [
    open,
    form.id,
    form.provider,
    form.endpointType,
    form.baseUrl,
    form.apiKey,
    form.credentialRef,
    form.configJsonText,
  ]);

  const discoverModels = async () => {
    setDiscoveredModels(null);
    setModelDiscoveryError("");
    const version = ++discoveryVersion.current;
    try {
      const result = await onDiscoverModels();
      if (version !== discoveryVersion.current) return;
      setDiscoveredModels(result.models);
    } catch (caught) {
      if (version !== discoveryVersion.current) return;
      setDiscoveredModels(null);
      setModelDiscoveryError(caught instanceof Error ? caught.message : "获取上游模型失败");
    }
  };

  const moveToStep = (nextStep: number) => {
    setActiveStep(nextStep);
    setFurthestStep((current) => Math.max(current, nextStep));
    window.requestAnimationFrame(() => {
      const panel = formRef.current?.querySelector<HTMLElement>(`[data-provider-step="${nextStep}"]`);
      formRef.current?.closest<HTMLElement>(".consoleOverlayContent")?.scrollTo({ top: 0 });
      panel?.querySelector<HTMLElement>("input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])")?.focus({ preventScroll: true });
    });
  };

  const nextStep = () => {
    const invalidFields = stepFields[activeStep].filter((field) => Boolean(errors[field]));
    if (invalidFields.length > 0) {
      setTouched((current) => ({ ...current, ...Object.fromEntries(invalidFields.map((field) => [field, true])) }));
      window.requestAnimationFrame(() => {
        formRef.current
          ?.querySelector<HTMLElement>(`[data-provider-step="${activeStep}"] [aria-invalid="true"]`)
          ?.focus({ preventScroll: true });
      });
      return;
    }
    moveToStep(Math.min(activeStep + 1, steps.length - 1));
  };

  return (
    <Drawer
      open={open}
      title={form.id ? "编辑供应商通道" : "新增供应商通道"}
      description="按连接、路由、模型和高级配置分组维护；未保存关闭时会要求确认。"
      size="min(720px, 100vw)"
      dirty={dirty}
      loading={saving}
      initialFocusRef={nameRef}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          setActiveStep(0);
          setFurthestStep(0);
        }
        onOpenChange(nextOpen);
      }}
      footer={
        <div className="providerDrawerActions">
          {activeStep > 0 ? (
            <Button type="button" variant="ghost" icon={<ChevronLeft size={16} />} disabled={saving} onClick={() => moveToStep(activeStep - 1)}>
              上一步
            </Button>
          ) : null}
          {activeStep < steps.length - 1 ? (
            <Button
              key="provider-next-step"
              type="button"
              icon={<ChevronRight size={16} />}
              iconPosition="end"
              disabled={saving}
              onClick={(event) => {
                event.preventDefault();
                nextStep();
              }}
            >
              下一步
            </Button>
          ) : (
            <Button
              key="provider-save"
              type="submit"
              form="provider-channel-form"
              icon={<Save size={17} />}
              loading={saving}
              disabled={formInvalid}
            >
              保存通道
            </Button>
          )}
        </div>
      }
    >
      <form
        ref={formRef}
        id="provider-channel-form"
        className="providerForm"
        onSubmit={(event) => {
          event.preventDefault();
          if (activeStep < steps.length - 1) nextStep();
          else onSave();
        }}
      >
        <fieldset className="providerFormLock" disabled={saving}>
          <legend className="cuiVisuallyHidden">供应商通道配置</legend>
          {error && <Alert tone="danger" title="供应商通道保存失败">{error}</Alert>}

        <nav className="providerFormSteps" aria-label="供应商通道配置步骤">
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

        {activeStep === 0 ? <div className="providerFormStep" data-provider-step="0">
        {!form.id ? <FieldGroup variant="section" legend="繁境中转预设" description="选择能力后填写自己的 Key。预设不带密钥、不自动启用；地址可编辑。已填写凭据或模型时不能重置预设。">
          {(["text", "image_generation", "video_generation"] as const).map((endpoint) => (
            <Button key={endpoint} type="button" variant="secondary"
              disabled={Boolean(form.apiKey || form.credentialRef || form.modelNames.length || discoveringModels)}
              onClick={() => onChange({ ...createFanjinProviderForm(endpoint), scope: form.scope, workspaceId: form.workspaceId })}>
              {endpoint === "text" ? "繁境文本" : endpoint === "image_generation" ? "繁境图片" : "繁境视频"}
            </Button>
          ))}
          <p className="providerFieldHelp">模型发现走 /v1/models；视频生成走 /api/v3。更换站点时，请同步修改高级配置中的模型发现与探测地址。</p>
        </FieldGroup> : null}

        <FieldGroup variant="section" className="providerFormSection" legend="基本信息" description="名称、范围与能力类型用于路由匹配和列表扫读。">
          <div className="adminFeatureFormGrid adminFeatureFormGrid--identity">
            <FormField className="adminFeatureFormField--wide" label="通道名称" required optionalLabel={null} error={visibleError("name")}>
              <Input ref={nameRef} value={form.name} placeholder="Volcano Seedance Video" onBlur={() => markTouched("name")} onChange={(event) => update("name", event.currentTarget.value)} />
            </FormField>
            <FormField label="供应商" required optionalLabel={null} error={visibleError("provider")}>
              <Select value={form.provider} onBlur={() => markTouched("provider")} onChange={(event) => {
                const provider = event.currentTarget.value as ProviderChannelProvider;
                onChange({
                  ...form,
                  provider,
                  configJsonText: provider === "openai" ? form.configJsonText : withResponsesTransport(form.configJsonText, null),
                  ...(!(provider === "volcano" && form.endpointType === "video_generation")
                    ? {
                        portraitAssetsEnabled: false,
                        providerAccountId: "",
                        assetsProjectName: "",
                        portraitAccessKeyId: "",
                        portraitSecretAccessKey: "",
                        portraitSessionToken: "",
                        imagexPortraitReviewEnabled: false,
                        imagexServiceId: "",
                        imagexAccessKeyId: "",
                        imagexSecretAccessKey: "",
                        imagexSessionToken: "",
                      }
                    : {}),
                });
              }}>
                {providerOptions.map((provider) => <option value={provider} key={provider}>{providerLabels[provider]}</option>)}
              </Select>
            </FormField>
            <FormField label="能力类型" required optionalLabel={null} error={visibleError("endpointType")}>
              <Select value={form.endpointType} onBlur={() => markTouched("endpointType")} onChange={(event) => {
                const endpointType = event.currentTarget.value as ProviderChannelEndpoint;
                onChange({
                  ...form,
                  endpointType,
                  configJsonText: endpointType === "text" ? form.configJsonText : withResponsesTransport(form.configJsonText, null),
                  ...(!(form.provider === "volcano" && endpointType === "video_generation")
                    ? {
                        portraitAssetsEnabled: false,
                        providerAccountId: "",
                        assetsProjectName: "",
                        portraitAccessKeyId: "",
                        portraitSecretAccessKey: "",
                        portraitSessionToken: "",
                        imagexPortraitReviewEnabled: false,
                        imagexServiceId: "",
                        imagexAccessKeyId: "",
                        imagexSecretAccessKey: "",
                        imagexSessionToken: "",
                      }
                    : {}),
                });
              }}>
                {endpointError && <option value={form.endpointType}>不支持 · {form.endpointType || "空值"}</option>}
                {endpointOptions.map((endpoint) => <option value={endpoint} key={endpoint}>{endpointLabels[endpoint]}</option>)}
              </Select>
            </FormField>
            <FormField className="adminFeatureFormField--short" label="范围" required optionalLabel={null} error={visibleError("scope")}>
              <Select value={form.scope} onBlur={() => markTouched("scope")} onChange={(event) => update("scope", event.currentTarget.value as ProviderChannelScope)}>
                {scopeOptions.map((scope) => <option value={scope} key={scope}>{scopeLabels[scope]}</option>)}
              </Select>
            </FormField>
            {form.scope === "workspace" && (
              <FormField className="adminFeatureFormField--wide" label="Workspace ID" required optionalLabel={null} error={visibleError("workspaceId")}>
                <Input value={form.workspaceId} placeholder="workspace id" onBlur={() => markTouched("workspaceId")} onChange={(event) => update("workspaceId", event.currentTarget.value)} />
              </FormField>
            )}
          </div>
        </FieldGroup>

        <FieldGroup variant="section" className="providerFormSection" legend="连接与凭据" description="API Key 会在服务端加密保存，保存后不可回显；连接测试会探测当前表单内容。">
          <div className="adminFeatureFormGrid">
            {form.provider === "openai" && form.endpointType === "text" ? (
              <FormField className="adminFeatureFormField--wide" label="Responses 接入方式" optionalLabel={null}
                help="原生模式保留推理、工具调用及流式事件，要求上游支持 /v1/responses；原有通道默认使用 Chat Completions 转换。">
                <Select value={responsesTransport} disabled={Boolean(jsonError)}
                  onChange={(event) => update("configJsonText", withResponsesTransport(form.configJsonText, event.currentTarget.value))}>
                  <option value="chat_completions">Chat Completions 兼容转换</option>
                  <option value="native">原生 Responses</option>
                </Select>
              </FormField>
            ) : null}
            <FormField className="adminFeatureFormField--wide" label="Base URL" help="填写需要探测的供应商 API 根地址。">
              <Input value={form.baseUrl} inputMode="url" placeholder="https://ark.cn-beijing.volces.com" onChange={(event) => update("baseUrl", event.currentTarget.value)} />
            </FormField>
            <FormField
              className="adminFeatureFormField--wide"
              label="API Key"
              required={!storedCredentialReusable && !form.credentialRef.trim()}
              optionalLabel={storedCredentialReusable ? "已安全保存" : null}
              error={visibleError("apiKey")}
              help={storedCredentialReusable
                ? "已保存的密钥不会回显；留空保持原密钥，输入新值会覆盖。"
                : form.credentialConfigured
                  ? "供应商或 Base URL 已变化，请重新输入 API Key，避免把原密钥发送到新地址。"
                : "密钥仅通过 HTTPS 提交，数据库只保存 AES-256-GCM 密文。"}
            >
              <Input
                type="password"
                value={form.apiKey}
                autoComplete="new-password"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder={storedCredentialReusable ? "••••••••••••（留空保持不变）" : "粘贴供应商 API Key"}
                onBlur={() => markTouched("apiKey")}
                onChange={(event) => update("apiKey", event.currentTarget.value)}
              />
            </FormField>
            <FormField className="adminFeatureFormField--wide" label="环境变量引用" help="可选兼容方式：填写服务端环境变量名，不要在此粘贴密钥。">
              <Input value={form.credentialRef} autoCapitalize="off" autoCorrect="off" placeholder="例如 VOLCANO_ARK_API_KEY（可选）" onChange={(event) => update("credentialRef", event.currentTarget.value)} />
            </FormField>
          </div>
          {portraitEligible ? (
            <div className="providerPortraitCredential">
              <Switch
                checked={form.portraitAssetsEnabled}
                onCheckedChange={(checked) => update("portraitAssetsEnabled", checked)}
                label="启用人像资产能力"
                description="仅供真人/虚拟人像资产 API 的 AK/SK 签名使用，与上方视频生成 Bearer 凭据完全隔离。"
              />
              {(form.portraitAssetsEnabled || form.portraitCredentialConfigured) ? (
                <div className="adminFeatureFormGrid">
                  <FormField
                    className="adminFeatureFormField--wide"
                    label={providerAccountIdImmutable ? "火山账号标识（永久归属）" : "火山账号标识"}
                    required={form.portraitAssetsEnabled}
                    optionalLabel={providerAccountIdImmutable ? "永久归属" : form.portraitAssetsEnabled ? null : "停用时保留"}
                    error={visibleError("providerAccountId")}
                    help={providerAccountIdImmutable
                      ? "已形成永久历史归属，不能修改或清空；需要轮换时请停用旧通道，并在同一工作区新建通道。"
                      : "用于租户隔离与幂等命名空间；同一账号与 ProjectName 不能被其他工作区复用。保存后不可修改。"}
                  >
                    <Input
                      value={form.providerAccountId}
                      disabled={providerAccountIdImmutable}
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                      placeholder="例如 volc-account-001"
                      onBlur={() => markTouched("providerAccountId")}
                      onChange={(event) => update("providerAccountId", event.currentTarget.value)}
                    />
                  </FormField>
                  <FormField
                    className="adminFeatureFormField--wide"
                    label={assetsProjectNameImmutable ? "人像资产 ProjectName（永久归属）" : "人像资产 ProjectName"}
                    required={form.portraitAssetsEnabled}
                    optionalLabel={assetsProjectNameImmutable ? "永久归属" : form.portraitAssetsEnabled ? null : "停用时保留"}
                    error={visibleError("assetsProjectName")}
                    help={assetsProjectNameImmutable
                      ? "已形成永久历史归属，不能修改或清空；需要轮换时请停用旧通道，并在同一工作区新建通道。"
                      : "服务端固定注入到火山 Assets API；调用方不能切换该命名空间，保存后不可修改。"}
                  >
                    <Input
                      value={form.assetsProjectName}
                      disabled={assetsProjectNameImmutable}
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                      placeholder="例如 fanjin-portrait-production"
                      onBlur={() => markTouched("assetsProjectName")}
                      onChange={(event) => update("assetsProjectName", event.currentTarget.value)}
                    />
                  </FormField>
                  <FormField
                    className="adminFeatureFormField--wide"
                    label="人像 Access Key ID"
                    required={form.portraitAssetsEnabled && !portraitCredentialReusable}
                    optionalLabel={portraitCredentialReusable ? "已安全保存" : null}
                    error={visibleError("portraitAccessKeyId")}
                    help={portraitCredentialReusable
                      ? `凭据代际 ${form.portraitCredentialGeneration ?? "—"}；留空保持原值，轮换时 AK/SK 必须成对输入。`
                      : "只用于火山人像资产 HMAC 签名，不会作为视频 Bearer 发送。"}
                  >
                    <Input
                      value={form.portraitAccessKeyId}
                      autoComplete="off"
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                      placeholder={portraitCredentialReusable ? "••••••••（留空保持不变）" : "AKLT…"}
                      onBlur={() => markTouched("portraitAccessKeyId")}
                      onChange={(event) => update("portraitAccessKeyId", event.currentTarget.value)}
                    />
                  </FormField>
                  <FormField
                    className="adminFeatureFormField--wide"
                    label="人像 Secret Access Key"
                    required={form.portraitAssetsEnabled && !portraitCredentialReusable}
                    optionalLabel={portraitCredentialReusable ? "已安全保存" : null}
                    error={visibleError("portraitSecretAccessKey")}
                    help="保存后不回显；输入新 AK/SK 会生成新代际，并使旧账号绑定安全失效。"
                  >
                    <Input
                      type="password"
                      value={form.portraitSecretAccessKey}
                      autoComplete="new-password"
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                      placeholder={portraitCredentialReusable ? "••••••••（留空保持不变）" : "粘贴 Secret Access Key"}
                      onBlur={() => markTouched("portraitSecretAccessKey")}
                      onChange={(event) => update("portraitSecretAccessKey", event.currentTarget.value)}
                    />
                  </FormField>
                  <FormField
                    className="adminFeatureFormField--wide"
                    label="临时 Session Token"
                    error={visibleError("portraitSessionToken")}
                    help="仅临时 STS 凭据需要；与 AK/SK 一起轮换，长期 AK/SK 留空。"
                  >
                    <Input
                      type="password"
                      value={form.portraitSessionToken}
                      autoComplete="new-password"
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                      placeholder="可选"
                      onBlur={() => markTouched("portraitSessionToken")}
                      onChange={(event) => update("portraitSessionToken", event.currentTarget.value)}
                    />
                  </FormField>
                </div>
              ) : null}
            </div>
          ) : null}
          <p className="providerFieldHelp">超分和 ImageX 凭据请在“媒体服务”页面独立配置。</p>
          <Button
            type="button"
            variant="secondary"
            icon={<Cable size={17} />}
            loading={testing}
            disabled={!connectionReady || saving}
            onClick={onTestConnection}
          >
            测试连接
          </Button>
          <p className="providerFieldHelp">
            {connectionReady
              ? "将使用当前输入或已安全保存的凭据进行真实探测，不会自动保存配置。"
              : "填写 Base URL 和 API Key，并确保高级配置 JSON 有效后即可测试。"}
          </p>
        </FieldGroup>
        </div> : null}

        {activeStep === 1 ? <div className="providerFormStep" data-provider-step="1">
        <FieldGroup variant="section" className="providerFormSection" legend="路由与限制" description="优先级越小越靠前；权重、超时和并发共同控制路由。">
          <div className="adminFeatureFormGrid adminFeatureFormGrid--numbers">
            <FormField label="优先级" required optionalLabel={null} error={visibleError("priority")}>
              <NumberInput value={form.priority} step={1} onBlur={() => markTouched("priority")} onValueChange={(value) => update("priority", value ?? 100)} />
            </FormField>
            <FormField label="权重" required optionalLabel={null} error={visibleError("weight")}>
              <NumberInput value={form.weight} min={0} step={1} onBlur={() => markTouched("weight")} onValueChange={(value) => update("weight", value ?? 1)} />
            </FormField>
            <FormField label="超时（ms）" required optionalLabel={null} error={visibleError("timeoutMs")}>
              <NumberInput value={form.timeoutMs} min={1000} step={1000} onBlur={() => markTouched("timeoutMs")} onValueChange={(value) => update("timeoutMs", value ?? 600000)} />
            </FormField>
            <FormField label="并发上限" help="留空代表不限制。" error={visibleError("concurrencyLimit")}>
              <NumberInput value={form.concurrencyLimit} min={0} step={1} onBlur={() => markTouched("concurrencyLimit")} onValueChange={(value) => update("concurrencyLimit", value)} />
            </FormField>
          </div>
          <Switch
            checked={form.disabled}
            onCheckedChange={(checked) => update("disabled", checked)}
            label="保存为停用状态"
            description="停用通道不会参与新请求路由。"
          />
        </FieldGroup>

        <FieldGroup variant="section" className="providerFormSection" legend="模型能力" description="模型用标签逐个管理，避免手工维护逗号或换行文本。">
          <ModelTagEditor
            capabilityLabel={endpointLabels[form.endpointType as ProviderChannelEndpoint] || form.endpointType}
            value={form.modelNames}
            onChange={(value) => update("modelNames", value)}
            disabled={saving}
            discovering={discoveringModels}
            discoveryDisabled={!connectionReady || saving}
            discoveredModels={discoveredModels}
            discoveryError={modelDiscoveryError}
            onDiscover={() => void discoverModels()}
          />
        </FieldGroup>
        </div> : null}

        {activeStep === 2 ? <div className="providerFormStep" data-provider-step="2">
        <Accordion className="providerAdvanced">
          <AccordionItem value="provider-advanced-json">
            <AccordionTrigger>高级配置 JSON</AccordionTrigger>
            <AccordionContent contentClassName="providerAdvancedContent">
              <p>仅填写供应商扩展参数；配置默认折叠，保存前会校验为 JSON 对象。</p>
              <FormField
                label="配置 JSON"
                help={!jsonError ? "JSON 格式正确" : undefined}
                error={visibleError("configJsonText")}
                optionalLabel={null}
              >
                <CodeEditor
                  language="json"
                  minRows={9}
                  value={form.configJsonText}
                  onBlur={() => markTouched("configJsonText")}
                  onChange={(event) => update("configJsonText", event.currentTarget.value)}
                />
              </FormField>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
        </div> : null}
        </fieldset>
      </form>
    </Drawer>
  );
}
