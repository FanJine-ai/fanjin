import { useEffect, useState, type ChangeEvent } from "react";

import {
  buildCommerceVariants,
  createCommerceVariantBatch,
  type CommerceVariantBatch,
  type QuickWorkflowBrief,
  updateCommerceVariantBatchItem,
  validateCommerceBrief,
} from "./quickModeWorkflow";

type QuickWorkflowBriefPanelProps = {
  value: QuickWorkflowBrief;
  onChange: (value: QuickWorkflowBrief) => void;
  batch?: CommerceVariantBatch | null;
  onBatchChange?: (value: CommerceVariantBatch) => void;
};

function lines(value: string) {
  return value
    .split(/[\n；;]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 20);
}

function inlineValues(value: string) {
  return value
    .split(/[\n,，；;]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 6);
}

const commerceBatchStatusLabels = {
  ready: "待执行",
  editing: "编辑中",
  completed: "已完成",
  failed: "失败",
} as const;

export function QuickWorkflowBriefPanel({ value, onChange, batch = null, onBatchChange }: QuickWorkflowBriefPanelProps) {
  const issues = validateCommerceBrief(value);
  const deliveryVariants = buildCommerceVariants(value);
  const [ratioDraft, setRatioDraft] = useState(() => value.deliveryRatios.join("、"));
  const [durationDraft, setDurationDraft] = useState(() => value.deliveryDurations.join("、"));
  const [toneDraft, setToneDraft] = useState(() => value.deliveryTones.join("、"));
  const [audienceDraft, setAudienceDraft] = useState(() => value.deliveryAudiences.join("、"));
  const ratioValue = value.deliveryRatios.join("、");
  const durationValue = value.deliveryDurations.join("、");
  const toneValue = value.deliveryTones.join("、");
  const audienceValue = value.deliveryAudiences.join("、");
  useEffect(() => setRatioDraft(ratioValue), [ratioValue]);
  useEffect(() => setDurationDraft(durationValue), [durationValue]);
  useEffect(() => setToneDraft(toneValue), [toneValue]);
  useEffect(() => setAudienceDraft(audienceValue), [audienceValue]);
  const patch = <Key extends keyof QuickWorkflowBrief>(key: Key, next: QuickWorkflowBrief[Key]) => {
    onChange({ ...value, [key]: next });
  };
  const stringChange = (key: keyof QuickWorkflowBrief) => (
    event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>,
  ) => patch(key, event.target.value as never);

  return (
    <section className="quickWorkflowBrief" data-testid="quick-workflow-brief" aria-label="导演与交付策划">
      <div className="quickWorkflowBriefGrid">
        <label className="quickWorkflowField wide">
          <span>创作主题</span>
          <input
            aria-label="创作主题"
            value={value.theme}
            onChange={stringChange("theme")}
            placeholder="一句话说明故事、商品或核心创意"
          />
        </label>
        <label className="quickWorkflowField wide">
          <span>剧本 / 创意来源</span>
          <textarea
            aria-label="剧本或创意来源"
            value={value.sourceScript}
            onChange={stringChange("sourceScript")}
            rows={2}
            placeholder="粘贴剧本片段、创意说明或商品内容"
          />
        </label>
        <label className="quickWorkflowField wide">
          <span>真实卖点</span>
          <textarea
            aria-label="真实卖点"
            value={value.sellingPoints.join("\n")}
            onChange={(event) => patch("sellingPoints", lines(event.target.value))}
            rows={2}
            placeholder="每行一个卖点；只填写可核对事实"
          />
        </label>
        <label className="quickWorkflowField">
          <span>目标时长</span>
          <input
            aria-label="目标时长"
            type="number"
            min={5}
            max={300}
            value={value.targetDuration}
            onChange={(event) => patch("targetDuration", Math.min(300, Math.max(5, Number(event.target.value) || 5)))}
          />
        </label>
        <label className="quickWorkflowField">
          <span>剪辑节奏</span>
          <select aria-label="剪辑节奏" value={value.pace} onChange={stringChange("pace")}>
            <option value="slow">舒缓</option>
            <option value="balanced">均衡</option>
            <option value="fast">快速</option>
          </select>
        </label>
        <label className="quickWorkflowField">
          <span>原声偏好</span>
          <select aria-label="原声偏好" value={value.originalAudio} onChange={stringChange("originalAudio")}>
            <option value="keep">完整保留</option>
            <option value="duck">配乐下压低</option>
            <option value="mute">静音</option>
          </select>
        </label>
      </div>

      <details className="quickWorkflowCommerce">
        <summary>电商与合规</summary>
        <div className="quickWorkflowBriefGrid">
          <label className="quickWorkflowField">
            <span>商品名称</span>
            <input aria-label="商品名称" value={value.productName} onChange={stringChange("productName")} />
          </label>
          <label className="quickWorkflowField">
            <span>目标人群</span>
            <input aria-label="目标人群" value={value.audience} onChange={stringChange("audience")} />
          </label>
          <label className="quickWorkflowField">
            <span>投放渠道</span>
            <input aria-label="投放渠道" value={value.channel} onChange={stringChange("channel")} />
          </label>
          <label className="quickWorkflowField">
            <span>语气</span>
            <input aria-label="语气" value={value.tone} onChange={stringChange("tone")} />
          </label>
          <label className="quickWorkflowField wide">
            <span>价格表述</span>
            <input aria-label="价格表述" value={value.priceClaim} onChange={stringChange("priceClaim")} placeholder="如：活动到手价 99 元" />
          </label>
          <label className="quickWorkflowField wide">
            <span>功效表述</span>
            <textarea aria-label="功效表述" value={value.efficacyClaims.join("\n")} onChange={(event) => patch("efficacyClaims", lines(event.target.value))} rows={2} placeholder="每行一条，避免未经证明的绝对化表述" />
          </label>
          <label className="quickWorkflowField wide">
            <span>事实来源</span>
            <input aria-label="事实来源" value={value.factSource} onChange={stringChange("factSource")} placeholder="商品页、价目表、批准文件或检测报告" />
          </label>
          <label className="quickWorkflowField">
            <span>敏感品类</span>
            <select aria-label="敏感品类" value={value.sensitiveCategory} onChange={stringChange("sensitiveCategory")}>
              <option value="none">非敏感品类</option>
              <option value="cosmetics">化妆品</option>
              <option value="health">健康 / 医疗</option>
              <option value="finance">金融</option>
              <option value="food">食品</option>
            </select>
          </label>
          <label className="quickWorkflowField wide">
            <span>合规说明</span>
            <textarea aria-label="合规说明" value={value.complianceNote} onChange={stringChange("complianceNote")} rows={2} placeholder="填写禁用表述、证据边界与人工复核要求" />
          </label>
          <label className="quickWorkflowField wide">
            <span>批量画幅</span>
            <input
              aria-label="批量画幅"
              value={ratioDraft}
              onChange={(event) => {
                const raw = event.target.value;
                setRatioDraft(raw);
                const next = inlineValues(raw).filter((item) => /^\d+:\d+$/.test(item)) as QuickWorkflowBrief["deliveryRatios"];
                if (!raw.trim() || next.length) patch("deliveryRatios", next);
              }}
              placeholder="9:16、16:9、1:1"
            />
          </label>
          <label className="quickWorkflowField wide">
            <span>批量时长（秒）</span>
            <input
              aria-label="批量时长"
              value={durationDraft}
              onChange={(event) => {
                const raw = event.target.value;
                setDurationDraft(raw);
                const next = inlineValues(raw).map(Number).filter((item) => Number.isFinite(item) && item >= 5 && item <= 300);
                if (!raw.trim() || next.length) patch("deliveryDurations", next);
              }}
              placeholder="15、30、60"
            />
          </label>
          <label className="quickWorkflowField wide">
            <span>批量语气</span>
            <input aria-label="批量语气" value={toneDraft} onChange={(event) => { setToneDraft(event.target.value); patch("deliveryTones", inlineValues(event.target.value)); }} placeholder="清爽、专业、热情" />
          </label>
          <label className="quickWorkflowField wide">
            <span>批量受众</span>
            <input aria-label="批量受众" value={audienceDraft} onChange={(event) => { setAudienceDraft(event.target.value); patch("deliveryAudiences", inlineValues(event.target.value)); }} placeholder="通勤人群、学生、新客" />
          </label>
        </div>
        {issues.length ? (
          <div className="quickWorkflowIssues" role="alert">
            {issues.map((issue) => <span key={issue.code}>{issue.message}</span>)}
          </div>
        ) : null}
        <div className="quickWorkflowVariants" aria-label="多规格交付版本">
          <header>
            <span>
              <strong>多规格版本</strong>
              <small>组合预览最多 12 个；保存后逐项载入，不会自动触发付费生成。</small>
            </span>
            {onBatchChange ? (
              <button
                type="button"
                className="quickWorkflowBatchSave"
                aria-label="保存多规格批次"
                disabled={issues.length > 0 || deliveryVariants.length === 0}
                onClick={() => onBatchChange(createCommerceVariantBatch(value, batch))}
              >
                {batch ? "更新批次" : "保存为批次"}
              </button>
            ) : null}
          </header>
          <div className="quickWorkflowVariantPreview">
            {deliveryVariants.map((variant) => (
              <button
                key={variant.id}
                type="button"
                data-testid="commerce-delivery-variant"
                aria-label={`载入 ${variant.label}`}
                onClick={() => onChange({
                  ...value,
                  targetDuration: variant.duration,
                  ratio: variant.ratio,
                  tone: variant.tone,
                  audience: variant.audience,
                })}
              >
                <strong>{variant.duration} 秒 · {variant.ratio}</strong>
                <span>{[variant.tone, variant.audience].filter(Boolean).join(" · ") || "默认语气与受众"}</span>
              </button>
            ))}
          </div>
          {batch ? (
            <div className="quickWorkflowBatch" aria-label="已保存多规格批次">
              <div className="quickWorkflowBatchSummary">
                <strong>批次进度</strong>
                <span>{batch.items.filter((item) => item.status === "completed").length} / {batch.items.length} 已完成</span>
              </div>
              <div className="quickWorkflowBatchList">
                {batch.items.map((item) => (
                  <div key={item.id} className="quickWorkflowBatchItem" data-testid="commerce-batch-item">
                    <span className={`quickWorkflowBatchStatus is-${item.status}`}>
                      {commerceBatchStatusLabels[item.status]}
                    </span>
                    <span className="quickWorkflowBatchSpec">
                      <strong>{item.duration} 秒 · {item.ratio}</strong>
                      <small>{[item.tone, item.audience].filter(Boolean).join(" · ") || "默认语气与受众"}</small>
                    </span>
                    <span className="quickWorkflowBatchActions">
                      <button
                        type="button"
                        aria-label={`载入执行 ${item.label}`}
                        onClick={() => {
                          onChange({
                            ...value,
                            targetDuration: item.duration,
                            ratio: item.ratio,
                            tone: item.tone,
                            audience: item.audience,
                          });
                          onBatchChange?.(updateCommerceVariantBatchItem(batch, item.id, "editing"));
                        }}
                      >
                        {item.status === "editing" ? "继续编辑" : "载入执行"}
                      </button>
                    </span>
                    {item.taskIds?.length ? (
                      <small>{item.taskIds.length} 个真实任务{item.resultUrls?.length ? ` · ${item.resultUrls.length} 个结果` : " · 等待结果"}</small>
                    ) : item.status === "editing" ? <small>生成任务提交后将自动同步状态</small> : null}
                    {item.resultUrls?.length ? (
                      <span className="commerceBatchResults">
                        {item.resultUrls.map((url, resultIndex) => (
                          <a key={url} href={url} target="_blank" rel="noreferrer" aria-label={`查看结果 ${resultIndex + 1}`}>查看结果 {resultIndex + 1}</a>
                        ))}
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </details>
    </section>
  );
}

export default QuickWorkflowBriefPanel;
