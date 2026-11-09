import { useEffect, useId, useState, type CSSProperties } from "react";
import type { VideoDurationCapability } from "./modelCatalog";
import "./VideoDurationControl.css";
import { AutoVideoDurationButton } from "./AutoVideoDurationButton";

type Props = {
  duration: VideoDurationCapability;
  value: number;
  onChange: (seconds: number) => void;
  label?: string;
};

/** Both controls emit only durations supported by the current model. */
export default function VideoDurationControl({ duration, value, onChange, label = "视频生成时长" }: Props) {
  const hintId = useId();
  const allowed = [...new Set(duration.allowed || [])].sort((a, b) => a - b);
  const discrete = allowed.length > 0;
  const min = discrete ? allowed[0] : duration.min;
  const step = duration.step > 0 ? duration.step : 1;
  const max = discrete ? allowed[allowed.length - 1]
    : Number((min + Math.floor((duration.max - min) / step + 1e-9) * step).toFixed(3));
  const normalize = (requested: number) => discrete
    ? allowed.reduce((best, option) => Math.abs(option - requested) < Math.abs(best - requested) ? option : best)
    : Number(Math.min(max, Math.max(min, min + Math.round((requested - min) / step) * step)).toFixed(3));
  const automatic = duration.auto === true && value === -1;
  const current = normalize(automatic || !Number.isFinite(value) ? duration.default : value);
  const [draft, setDraft] = useState(String(current));
  const constraintsKey = `${min}:${max}:${step}:${allowed.join(",")}`;
  useEffect(() => setDraft(String(current)), [current, constraintsKey]);

  const update = (next: number) => {
    setDraft(String(next));
    if (next !== value) onChange(next);
  };
  const commit = () => update(draft.trim() && Number.isFinite(Number(draft)) ? normalize(Number(draft)) : current);
  const sliderValue = discrete ? allowed.indexOf(current) : current;
  const sliderMin = discrete ? 0 : min;
  const sliderMax = discrete ? allowed.length - 1 : max;
  const progress = sliderMax > sliderMin ? (sliderValue - sliderMin) / (sliderMax - sliderMin) * 100 : 0;

  return (
    <div className="videoDurationControl" role="group" aria-label={label}>
      {duration.auto ? <div className="videoDurationMode">
        <AutoVideoDurationButton supported selected={automatic} onSelect={() => onChange(-1)} />
        <button type="button" className={`autoVideoDurationButton${!automatic ? " selected" : ""}`} aria-pressed={!automatic} onClick={() => { if (automatic) onChange(current); }}>指定时长</button>
      </div> : null}
      {automatic ? <p className="videoDurationBounds">由模型决定时长，费用按实际生成用量结算。</p> : <>
      <div className="videoDurationControlRow">
        <input
          className="videoDurationRange"
          type="range"
          min={sliderMin}
          max={sliderMax}
          step={discrete ? 1 : step}
          value={sliderValue}
          disabled={min === max}
          aria-label={`${label}滑杆`}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={current}
          aria-valuetext={`${current} 秒`}
          aria-describedby={hintId}
          style={{ "--duration-progress": `${progress}%` } as CSSProperties}
          onChange={(event) => update(discrete ? allowed[Number(event.target.value)] : normalize(Number(event.target.value)))}
        />
        <label className="videoDurationNumber">
          <input
            type="number"
            inputMode={step % 1 ? "decimal" : "numeric"}
            aria-label={`${label}秒数`}
            aria-describedby={hintId}
            min={min}
            max={max}
            step={discrete ? "any" : step}
            value={draft}
            disabled={min === max}
            onChange={(event) => {
              const text = event.target.value;
              setDraft(text);
              const requested = Number(text);
              // Keep partial input editable; snap invalid values on blur/Enter.
              if (text.trim() && Number.isFinite(requested) && normalize(requested) === requested && requested !== value) onChange(requested);
            }}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commit();
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setDraft(String(current));
              } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                event.preventDefault();
                const direction = event.key === "ArrowUp" ? 1 : -1;
                update(discrete ? allowed[Math.min(allowed.length - 1, Math.max(0, allowed.indexOf(current) + direction))] : normalize(current + direction * step));
              }
            }}
          />
          <span>秒</span>
        </label>
      </div>
      <div className="videoDurationBounds" id={hintId}>
        <span>{min} 秒</span>
        <span>{min === max ? "固定时长" : discrete ? "按模型支持的时长调整" : `每次 ${step} 秒`}</span>
        <span>{max} 秒</span>
      </div>
      </>}
    </div>
  );
}
