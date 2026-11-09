import { isValueVideoModel, valueVideoPair } from "./valueVideo";
import { useMemo, useRef, useState } from "react";
import { Save } from "lucide-react";
import {
  Alert,
  Button,
  Drawer,
  FieldGroup,
  FormField,
  Input,
  NumberInput,
  Select,
  Switch,
} from "../../../ui/console";
import type { RecipeForm, RecipeFormErrors, VideoChannelOption } from "./types";
import {
  INTERNAL_VIDEO_RESOLUTIONS,
} from "./types";
import { resLabel, validateRecipeForm } from "./utils";

interface RecipeDrawerProps {
  open: boolean;
  form: RecipeForm;
  initialForm: RecipeForm;
  saving: boolean;
  error: string;
  warnings: string[];
  publicModel: string;
  targetResolution: string;
  generateChannels: VideoChannelOption[];
  upscaleChannels: VideoChannelOption[];
  onChange: (form: RecipeForm) => void;
  onSave: () => void;
  onOpenChange: (open: boolean) => void;
}

export function RecipeDrawer({
  open,
  form,
  initialForm,
  saving,
  error,
  warnings,
  publicModel,
  targetResolution,
  generateChannels,
  upscaleChannels,
  onChange,
  onSave,
  onOpenChange,
}: RecipeDrawerProps) {
  const formRef = useRef<HTMLFormElement>(null);
  const channelRef = useRef<HTMLSelectElement>(null);
  const [touched, setTouched] = useState<Partial<Record<keyof RecipeFormErrors, boolean>>>({});
  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(initialForm), [form, initialForm]);
  const errors = validateRecipeForm(form, targetResolution, publicModel);
  const hasErrors = Object.keys(errors).length > 0;
  const update = <Key extends keyof RecipeForm>(key: Key, value: RecipeForm[Key]) => {
    onChange({ ...form, [key]: value });
  };
  const markTouched = (field: keyof RecipeFormErrors) => {
    setTouched((current) => (current[field] ? current : { ...current, [field]: true }));
  };
  const visibleError = (field: keyof RecipeFormErrors) => (
    touched[field] || Boolean(form.id) ? errors[field] : undefined
  );
  const channelLabel = (channel: VideoChannelOption) => {
    const suffix = channel.disabled ? "(已停用)" : "";
    return `${channel.name} · ${channel.provider} ${suffix}`;
  };

  return (
    <Drawer
      open={open}
      title={form.id ? "编辑配方" : "新建配方"}
      description={`${publicModel} · 目标档 ${resLabel(targetResolution)}。多条配方按权重轮询,失败按次序切换;保存需要管理员二次验证。`}
      size="min(640px, 100vw)"
      dirty={dirty}
      loading={saving}
      initialFocusRef={channelRef}
      closeGuardTitle={form.id ? "放弃配方修改?" : "放弃新建配方?"}
      closeGuardDescription="关闭后,当前表单中尚未保存的配方配置将丢失。"
      onOpenChange={onOpenChange}
      footer={(
        <div className="vfDrawerActions">
          <Button
            type="submit"
            form="vf-recipe-form"
            icon={<Save size={17} />}
            loading={saving}
            disabled={!dirty || hasErrors}
          >
            {form.id ? "保存配方" : "创建配方"}
          </Button>
        </div>
      )}
    >
      <form
        ref={formRef}
        id="vf-recipe-form"
        className="vfForm"
        onSubmit={(event) => {
          event.preventDefault();
          if (!hasErrors) onSave();
        }}
      >
        {error ? <Alert tone="danger" title={form.id ? "配方保存失败" : "配方创建失败"}>{error}</Alert> : null}
        {warnings.length > 0 ? (
          <Alert tone="warning" title="保存成功,但请注意">
            <ul className="vfWarningList">
              {warnings.map((item) => <li key={item}>{item}</li>)}
            </ul>
          </Alert>
        ) : null}

        <FieldGroup variant="section" legend="生成" description="打给生成通道的原生分辨率;可 480 起分。">
          <div className="vfFormGrid">
            <FormField className="vfFormField--wide" label="配方名" optionalLabel="可选" help="运维备注,用户不可见。">
              <Input value={form.name} placeholder="例如:480起分+超分甲" onChange={(event) => update("name", event.currentTarget.value)} />
            </FormField>
            <FormField className="vfFormField--wide" label="生成通道" required optionalLabel={null} error={visibleError("generateChannelId")}>
              <Select
                ref={channelRef}
                value={form.generateChannelId}
                onBlur={() => markTouched("generateChannelId")}
                onChange={(event) => update("generateChannelId", event.currentTarget.value)}
              >
                <option value="">请选择 video_generation 通道</option>
                {generateChannels.map((channel) => (
                  <option key={channel.id} value={channel.id}>{channelLabel(channel)}</option>
                ))}
                {form.generateChannelId && !generateChannels.some((channel) => channel.id === form.generateChannelId) ? (
                  <option value={form.generateChannelId}>未知通道 · {form.generateChannelId}</option>
                ) : null}
              </Select>
            </FormField>
            <FormField label="原生分辨率" required optionalLabel={null} error={visibleError("generateResolution")}
              help={form.enhanceEnabled ? `须低于目标档 ${resLabel(targetResolution)}` : `不开超分时须等于目标档 ${resLabel(targetResolution)}`}
            >
              <Select
                value={form.generateResolution}
                onBlur={() => markTouched("generateResolution")}
                onChange={(event) => update("generateResolution", event.currentTarget.value)}
              >
                {INTERNAL_VIDEO_RESOLUTIONS.filter(res => !isValueVideoModel(publicModel) || res === valueVideoPair(publicModel, targetResolution)?.source).map((res) => (
                  <option key={res} value={res}>{resLabel(res)}{res === "480p" ? "(仅内部起分)" : ""}</option>
                ))}
              </Select>
            </FormField>
            <FormField label="上游模型 ID" optionalLabel="可选" help="打给通道的真实 model id;留空用请求模型映射。">
              <Input value={form.upstreamModel} placeholder="例如:seedance-2-0" autoCapitalize="off" autoCorrect="off" onChange={(event) => update("upstreamModel", event.currentTarget.value)} />
            </FormField>
          </div>
        </FieldGroup>

        <FieldGroup variant="section" legend="超分(可选)" description="开启后先低分辨率生成、再超分到目标档,用户无感。">
          <Switch
            disabled={isValueVideoModel(publicModel)}
            checked={form.enhanceEnabled}
            onCheckedChange={(checked) => update("enhanceEnabled", checked)}
            label="启用无感超分"
            description="费用含在生成一口价内,不向用户单列。"
          />
          {form.enhanceEnabled ? (
            <FormField label="超分服务" required optionalLabel={null} error={visibleError("enhanceChannelId")}>
              <Select
                value={form.enhanceChannelId}
                onBlur={() => markTouched("enhanceChannelId")}
                onChange={(event) => update("enhanceChannelId", event.currentTarget.value)}
              >
                <option value="">请选择 媒体服务</option>
                {upscaleChannels.map((channel) => (
                  <option key={channel.id} value={channel.id}>{channelLabel(channel)}</option>
                ))}
                {form.enhanceChannelId && !upscaleChannels.some((channel) => channel.id === form.enhanceChannelId) ? (
                  <option value={form.enhanceChannelId}>未知通道 · {form.enhanceChannelId}</option>
                ) : null}
              </Select>
            </FormField>
          ) : null}
        </FieldGroup>

        <FieldGroup variant="section" legend="调度" description="权重用于轮询,次序号小的优先兜底。">
          <div className="vfFormGrid">
            <FormField label="权重" required optionalLabel={null} error={visibleError("weight")}>
              <NumberInput value={form.weight} min={0} step={1} onBlur={() => markTouched("weight")} onValueChange={(value) => update("weight", value ?? 0)} />
            </FormField>
            <FormField label="次序" required optionalLabel={null} error={visibleError("priority")}>
              <NumberInput value={form.priority} step={1} onBlur={() => markTouched("priority")} onValueChange={(value) => update("priority", value ?? 100)} />
            </FormField>
          </div>
          <Switch
            checked={form.enabled}
            onCheckedChange={(checked) => update("enabled", checked)}
            label="启用该配方"
            description="停用配方不参与轮询;同档至少保留一条启用配方再对用户开放。"
          />
        </FieldGroup>
      </form>
    </Drawer>
  );
}
