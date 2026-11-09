import { useEffect, useId, useState, type KeyboardEvent } from "react";
import { Download, Plus, X } from "lucide-react";
import { Alert, Button, IconButton, Input, Tooltip, TooltipContent, TooltipTrigger } from "../../../ui/console";

interface ModelTagEditorProps {
  value: string[];
  capabilityLabel?: string;
  onChange: (value: string[]) => void;
  disabled?: boolean;
  discovering?: boolean;
  discoveryDisabled?: boolean;
  discoveredModels?: string[] | null;
  discoveryError?: string;
  onDiscover?: () => void;
}

export function ModelTagEditor({
  value,
  capabilityLabel = "当前通道能力",
  onChange,
  disabled = false,
  discovering = false,
  discoveryDisabled = false,
  discoveredModels = null,
  discoveryError = "",
  onDiscover,
}: ModelTagEditorProps) {
  const id = useId();
  const [draft, setDraft] = useState("");
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  useEffect(() => { setSelectedModels([]); }, [discoveredModels, capabilityLabel]);
  const pendingModels = discoveredModels?.filter((model) => !value.includes(model)) || [];

  const importModels = pendingModels.filter((model) => selectedModels.includes(model));

  const addDraft = () => {
    const candidates = draft.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
    if (!candidates.length) return;
    onChange([...new Set([...value, ...candidates])]);
    setDraft("");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" && event.key !== ",") return;
    event.preventDefault();
    addDraft();
  };

  return (
    <div className="providerModelEditor">
      <div className="providerModelEditor__heading">
        <div>
          <label className="providerFieldLabel" htmlFor={id}>模型名称</label>
          <p className="providerFieldHelp" id={`${id}-help`}>获取仅预览。导入后需保存通道，刷新后才会保留。仅保留支持当前能力的模型；列表不代表生成权限、认证或价格已配置。</p>
        </div>
        {onDiscover ? (
          <Button
            type="button"
            variant="secondary"
            size="compact"
            icon={<Download size={16} />}
            loading={discovering}
            disabled={disabled || discoveryDisabled}
            onClick={onDiscover}
          >
            从上游获取
          </Button>
        ) : null}
      </div>
      {discoveryError ? <Alert tone="danger" title="获取上游模型失败">{discoveryError}</Alert> : null}
      {discoveredModels !== null && !discoveryError ? (
        <section className="providerModelDiscovery" aria-live="polite" aria-label="上游模型获取结果">
          <div className="providerModelDiscovery__summary">
            <div>
              <strong>上游返回 {discoveredModels.length} 个模型</strong>
              <span>{pendingModels.length ? `其中 ${pendingModels.length} 个尚未加入当前通道。` : discoveredModels.length ? "这些模型已在待保存列表中。" : "未返回模型，现有配置不会被清空。"}</span>
            </div>
            <Button
              type="button"
              variant="secondary"
              size="compact"
              disabled={disabled || discovering || !importModels.length}
              onClick={() => { onChange([...new Set([...value, ...importModels])]); setSelectedModels([]); }}
            >
              导入所选 {importModels.length} 个模型
            </Button>
          </div>
          {discoveredModels.length ? (
            <fieldset style={{ maxHeight: 240, overflowY: "auto" }} disabled={disabled || discovering}>
              <legend>选择已确认支持「{capabilityLabel}」的模型</legend>
              <p className="providerFieldHelp">类型未验证：模型目录可能混合文本、图片、视频和多模态模型。请依据供应商文档逐项确认后勾选，不按名称猜测；不会自动分类、定价或启用。</p>
              {discoveredModels.map((model) => (
                <label key={model} style={{ display: "block", overflowWrap: "anywhere" }}>
                  <input type="checkbox" aria-label={`选择模型 ${model}`}
                    disabled={value.includes(model)}
                    checked={!value.includes(model) && selectedModels.includes(model)}
                    onChange={(event) => {
                      const checked = event.currentTarget.checked;
                      setSelectedModels((current) => checked ? [...new Set([...current, model])] : current.filter((item) => item !== model));
                    }} />
                  <code>{model}</code>{value.includes(model) ? "（已在待保存列表）" : "（类型未验证）"}
                </label>
              ))}
            </fieldset>
          ) : <p>上游接口可访问，但没有返回可识别的模型。</p>}
        </section>
      ) : null}
      <div className="providerModelEditor__inputRow">
        <Input
          id={id}
          value={draft}
          disabled={disabled}
          aria-describedby={`${id}-help`}
          placeholder="例如 seedance-2-0"
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={onKeyDown}
        />
        <Button type="button" variant="secondary" icon={<Plus size={17} />} disabled={disabled || !draft.trim()} onClick={addDraft}>
          添加
        </Button>
      </div>
      <div className="providerModelEditor__tags" aria-live="polite">
        {value.length ? value.map((model) => (
          <span className="providerModelTag" key={model}>
            <code>{model}</code>
            <Tooltip>
              <TooltipTrigger
                render={(
                  <IconButton
                    aria-label={`移除模型 ${model}`}
                    icon={<X size={15} />}
                    size="compact"
                    disabled={disabled}
                    onClick={() => onChange(value.filter((item) => item !== model))}
                  />
                )}
              />
              <TooltipContent>移除 {model}</TooltipContent>
            </Tooltip>
          </span>
        )) : <span className="providerModelEditor__empty">尚未配置模型；通道将依赖高级配置或供应商默认模型。</span>}
      </div>
    </div>
  );
}
