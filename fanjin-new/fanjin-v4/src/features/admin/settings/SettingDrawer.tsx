import { useMemo, useRef } from "react";
import { Clock3, History, KeyRound, Save, ShieldAlert, Zap } from "lucide-react";
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
import {
  formatSettingValue,
  isCustomizedSetting,
  isSecretSetting,
  type PlatformSettingItem,
  type PlatformSettingValue,
} from "./types";

interface SettingDrawerProps {
  open: boolean;
  item: PlatformSettingItem | null;
  sectionTitle?: string;
  value: PlatformSettingValue;
  initialValue: PlatformSettingValue;
  saving: boolean;
  error: string;
  onValueChange: (value: PlatformSettingValue) => void;
  onSave: () => void;
  onOpenChange: (open: boolean) => void;
}

export function SettingDrawer({
  open,
  item,
  sectionTitle,
  value,
  initialValue,
  saving,
  error,
  onValueChange,
  onSave,
  onOpenChange,
}: SettingDrawerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const selectRef = useRef<HTMLSelectElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const switchRef = useRef<HTMLButtonElement>(null);
  const dirty = useMemo(() => value !== initialValue, [initialValue, value]);

  if (!item) return null;

  const secret = isSecretSetting(item);
  const customized = isCustomizedSetting(item);
  const currentValue = secret
    ? (item.configured ? "已安全配置" : "未配置")
    : formatSettingValue(item, item.value);
  const pendingValue = !dirty
    ? "尚未修改"
    : secret
      ? "新敏感值（保存后不回显）"
      : formatSettingValue(item, value);
  const defaultValue = secret ? "受保护，不提供明文默认值" : formatSettingValue(item, item.defaultValue);
  const initialFocusRef = item.type === "boolean"
    ? switchRef
    : item.type === "select"
      ? selectRef
      : item.type === "textarea"
        ? textareaRef
        : inputRef;

  const field = item.type === "boolean" ? (
    <Switch
      ref={switchRef}
      checked={Boolean(value)}
      onCheckedChange={onValueChange}
      label={item.label}
      description="切换后保存才会写入平台配置。"
    />
  ) : item.type === "number" ? (
    <FormField
      label={item.label}
      help={[
        item.min !== undefined ? `最小 ${item.min}` : "",
        item.max !== undefined ? `最大 ${item.max}` : "",
        item.suffix ? `单位 ${item.suffix}` : "",
      ].filter(Boolean).join(" · ") || "输入平台级数值。"}
      required
      optionalLabel={null}
    >
      <NumberInput
        ref={inputRef}
        value={typeof value === "number" ? value : Number(value) || 0}
        min={item.min}
        max={item.max}
        step={item.step || 1}
        onValueChange={(next) => onValueChange(next ?? Number(item.defaultValue))}
      />
    </FormField>
  ) : item.type === "select" ? (
    <FormField label={item.label} help="选择一个平台级默认策略。" required optionalLabel={null}>
      <Select
        ref={selectRef}
        value={String(value)}
        onChange={(event) => onValueChange(event.currentTarget.value)}
      >
        {(item.options || []).map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </Select>
    </FormField>
  ) : item.type === "textarea" ? (
    <FormField label={item.label} help="支持多行文本；保存后立即替换当前配置。">
      <textarea
        ref={textareaRef}
        rows={7}
        value={String(value)}
        onChange={(event) => onValueChange(event.currentTarget.value)}
      />
    </FormField>
  ) : (
    <FormField
      label={item.label}
      help={secret
        ? "已保存值不会回显；只有输入新值并保存时才会替换。"
        : "保存后替换当前平台配置。"}
    >
      <Input
        ref={inputRef}
        type={secret ? "password" : "text"}
        autoComplete={secret ? "new-password" : undefined}
        value={String(value)}
        onChange={(event) => onValueChange(event.currentTarget.value)}
      />
    </FormField>
  );

  return (
    <Drawer
      open={open}
      title={`编辑设置 · ${item.label}`}
      description={`${sectionTitle || item.section} / ${item.key}`}
      size="min(560px, 100vw)"
      dirty={dirty}
      loading={saving}
      initialFocusRef={initialFocusRef}
      closeGuardTitle="放弃设置修改？"
      closeGuardDescription="尚未保存的配置值会被丢弃，平台当前设置不会改变。"
      onOpenChange={(nextOpen) => onOpenChange(nextOpen)}
      footer={({ requestClose }) => (
        <div className="settingsDrawerActions">
          <Button
            type="button"
            variant="secondary"
            disabled={saving}
            onClick={() => requestClose("cancel")}
          >
            取消
          </Button>
          <Button
            type="submit"
            form="platform-setting-form"
            icon={<Save size={16} />}
            loading={saving}
            disabled={!dirty || (secret && !String(value).trim())}
          >
            保存设置
          </Button>
        </div>
      )}
    >
      <form
        id="platform-setting-form"
        className="settingsForm"
        onSubmit={(event) => {
          event.preventDefault();
          onSave();
        }}
      >
        <section className="settingsDrawerContext" aria-label="设置上下文">
          <div className="settingsDrawerBadges">
            <Badge tone={customized ? "info" : "neutral"}>{customized ? "当前为自定义值" : "当前使用默认值"}</Badge>
            {secret && <Badge icon={<KeyRound size={13} />} tone="warning">敏感设置</Badge>}
            {item.restartRequired && <Badge icon={<Clock3 size={13} />} tone="warning">需要重启</Badge>}
          </div>
          <p>{item.description}</p>
        </section>

        {error && <Alert tone="danger" title="设置保存失败">{error}</Alert>}
        {(secret || item.restartRequired) && (
          <Alert tone="warning" title="变更影响">
            {secret && <span><ShieldAlert aria-hidden="true" size={15} />敏感值只允许替换，不会在界面或审计记录中回显。</span>}
            {item.restartRequired && <span><Clock3 aria-hidden="true" size={15} />保存成功后还需重启相关服务才能完全生效。</span>}
          </Alert>
        )}

        <FieldGroup
          legend="配置值"
          description="修改只影响当前设置键；保存时需要通过管理员 step-up 验证。"
          variant="section"
        >
          {field}
          <dl className="settingsChangePreview">
            <div><dt>当前状态</dt><dd>{currentValue}</dd></div>
            <div data-changed={dirty || undefined}><dt>保存后</dt><dd>{pendingValue}</dd></div>
          </dl>
        </FieldGroup>

        <section className="settingsGovernanceDetails" aria-labelledby="settings-governance-title">
          <header>
            <div>
              <h3 id="settings-governance-title">治理与审计</h3>
              <p>用于复核默认值、变更来源和实际生效方式。</p>
            </div>
            <History aria-hidden="true" size={16} />
          </header>
          <dl className="settingsMeta">
            <div><dt>设置键</dt><dd><code>{item.key}</code></dd></div>
            <div><dt>治理分区</dt><dd>{sectionTitle || item.section}</dd></div>
            <div><dt>默认值</dt><dd>{defaultValue}</dd></div>
            <div><dt>配置来源</dt><dd>{customized ? "自定义配置" : "系统默认值"}</dd></div>
            <div>
              <dt>生效方式</dt>
              <dd className="settingsEffectValue">
                {item.restartRequired
                  ? <><Clock3 aria-hidden="true" size={14} />保存后重启生效</>
                  : <><Zap aria-hidden="true" size={14} />保存后即时生效</>}
              </dd>
            </div>
            <div><dt>审计事件</dt><dd><code>admin.system_settings.update</code> / changedKeys</dd></div>
          </dl>
        </section>
      </form>
    </Drawer>
  );
}
