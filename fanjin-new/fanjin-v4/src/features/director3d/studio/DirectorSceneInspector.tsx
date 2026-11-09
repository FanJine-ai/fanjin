"use client";

import { ChevronDown, RotateCcw } from "lucide-react";
import { DecimalNumberInput } from "./DecimalNumberInput";
import type { DirectorStudioState } from "./types";

interface DirectorSceneInspectorProps {
  studio: DirectorStudioState;
  onChange: (studio: DirectorStudioState) => void;
  onReset: () => void;
}

export function DirectorSceneInspector({
  studio,
  onChange,
  onReset,
}: DirectorSceneInspectorProps) {
  const scene = studio.scene;
  const updateScene = (patch: Partial<DirectorStudioState["scene"]>) =>
    onChange({ ...studio, scene: { ...scene, ...patch } });

  return (
    <section className="bg-[var(--director-panel)] p-5 pb-6">
      <div className="flex items-center justify-between border-b border-[var(--director-border)] pb-5">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--director-accent)]">属性面板</p>
          <p className="mt-1.5 text-base font-semibold tracking-tight text-[var(--director-text)]">3D 场景</p>
          <p className="mt-1 text-[11px] text-[var(--director-text-muted)]">全局构图与场景环境</p>
        </div>
        <button
          type="button"
          title="重置场景设置"
          onClick={onReset}
          className="rounded-xl border border-[var(--director-border)] p-2 text-[var(--director-text-muted)] transition hover:border-[var(--director-accent)] hover:bg-[var(--director-hover)] hover:text-[var(--director-text)]"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </button>
      </div>

      <RangeField
        label="场景缩放"
        value={Number((scene.scale * 100).toFixed(1))}
        min={20}
        max={3000}
        step={0.1}
        suffix="%"
        onChange={(value) => updateScene({ scale: value / 100 })}
      />
      <VectorFields
        label="场景平移"
        value={scene.position}
        onChange={(position) => updateScene({ position })}
      />
      <VectorFields
        label="场景旋转"
        value={
          scene.rotation.map((value) =>
            Math.round((value * 180) / Math.PI),
          ) as [number, number, number]
        }
        suffix="°"
        onChange={(rotation) =>
          updateScene({
            rotation: rotation.map((value) => (value * Math.PI) / 180) as [
              number,
              number,
              number,
            ],
          })
        }
      />

      <InspectorSection title="全景背景">
        <div className="rounded-lg border border-dashed border-[var(--director-border-strong)] bg-[var(--director-panel-alt)] px-3 py-3 text-center">
          <p className="text-[11px] font-medium text-[var(--director-text-secondary)]">未连接全景图</p>
          <p className="mt-1 text-[10px] leading-4 text-[var(--director-text-dim)]">
            全景图渲染链路尚未接入，当前可先使用天空颜色构图
          </p>
        </div>
        <label className="mt-3 flex items-center justify-between gap-3 text-[11px] text-[var(--director-text-dim)]">
          天空颜色
          <span className="flex items-center gap-2 rounded-md border border-[var(--director-border-strong)] bg-[var(--director-panel-alt)] py-1 pl-1 pr-2">
            <input
              type="color"
              value={scene.skyColor}
              onChange={(event) =>
                updateScene({ skyColor: event.target.value })
              }
              className="h-5 w-5 cursor-pointer rounded-sm border-0 bg-transparent p-0"
            />
            <input
              value={scene.skyColor.toUpperCase()}
              maxLength={7}
              onChange={(event) => {
                const value = event.target.value;
                if (/^#[0-9A-Fa-f]{6}$/.test(value))
                  updateScene({ skyColor: value });
              }}
              className="w-[58px] bg-transparent text-[10px] uppercase text-[var(--director-text-secondary)] outline-none"
              aria-label="天空颜色十六进制值"
            />
          </span>
        </label>
      </InspectorSection>

      <InspectorSection title="全景球">
        <RangeField
          label="水平旋转"
          value={Math.round(scene.panoramaRotation)}
          min={-180}
          max={180}
          suffix="°"
          onChange={(panoramaRotation) => updateScene({ panoramaRotation })}
        />
        <RangeField
          label="球体半径"
          value={Math.round(scene.panoramaRadius)}
          min={10}
          max={120}
          onChange={(panoramaRadius) => updateScene({ panoramaRadius })}
        />
      </InspectorSection>

      <InspectorSection title="场景辅助">
        <SwitchField
          label="角色标签"
          checked={scene.showCharacterLabels}
          onCheckedChange={(showCharacterLabels) =>
            updateScene({ showCharacterLabels })
          }
        />
        <SwitchField
          label="网格吸附"
          checked={scene.snapToGrid}
          onCheckedChange={(snapToGrid) => updateScene({ snapToGrid })}
        />
        <SwitchField
          label="高斯地面吸附"
          checked={scene.snapToGround}
          onCheckedChange={(snapToGround) => updateScene({ snapToGround })}
        />
      </InspectorSection>

      <InspectorSection title="地面">
        <SwitchField
          label="显示地面"
          checked={scene.groundVisible}
          onCheckedChange={(groundVisible) => updateScene({ groundVisible })}
        />
        <RangeField
          label="透明度"
          value={Number(scene.groundOpacity.toFixed(2))}
          min={0}
          max={1}
          step={0.05}
          onChange={(groundOpacity) => updateScene({ groundOpacity })}
        />
        <p className="mt-3 text-[10px] leading-4 text-[var(--director-text-muted)]">
          地面固定在 Y = 0，舞台边界为 X/Z ±10。
        </p>
      </InspectorSection>
    </section>
  );
}

function InspectorSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-5 overflow-hidden rounded-xl border border-[var(--director-border)] bg-[var(--director-panel-alt)]">
      <div className="flex items-center justify-between border-b border-[var(--director-border)] px-3 py-3">
        <p className="text-xs font-semibold text-[var(--director-text-secondary)]">{title}</p>
        <ChevronDown className="h-3.5 w-3.5 text-[var(--director-text-dim)]" />
      </div>
      <div className="px-3 pb-3 pt-1">{children}</div>
    </section>
  );
}

function RangeField({
  label,
  value,
  min,
  max,
  step = 1,
  suffix = "",
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="mt-4 block text-[11px] text-[var(--director-text-dim)]">
      <span className="flex items-center justify-between gap-3">
        {label}
        <span className="flex min-w-12 items-center rounded-md bg-[var(--director-active)] px-1.5 py-1 font-mono text-[10px] text-[var(--director-text-secondary)]">
          <DecimalNumberInput
            value={value}
            min={min}
            max={max}
            step={step}
            precision={step < 1 ? 2 : 0}
            onValueChange={onChange}
            className="min-w-0 flex-1 bg-transparent text-right outline-none"
            ariaLabel={label}
          />
          {suffix}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="mt-2 w-full accent-[var(--director-accent)]"
      />
    </label>
  );
}

function VectorFields({
  label,
  value,
  suffix,
  onChange,
}: {
  label: string;
  value: [number, number, number];
  suffix?: string;
  onChange: (value: [number, number, number]) => void;
}) {
  return (
    <fieldset className="mt-4">
      <legend className="text-[11px] text-[var(--director-text-dim)]">{label}</legend>
      <div className="mt-2 grid grid-cols-3 gap-2">
        {(["X", "Y", "Z"] as const).map((axis, index) => (
          <label key={axis} className="relative">
            <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[10px] text-[var(--director-text-dim)]">
              {axis}
            </span>
            <DecimalNumberInput
              value={value[index]}
              min={-9999}
              max={9999}
              step={0.01}
              precision={2}
              onValueChange={(nextValue) => {
                const next = [...value] as [number, number, number];
                next[index] = nextValue;
                onChange(next);
              }}
              className="w-full rounded-lg border border-[var(--director-border)] bg-[var(--director-panel)] py-2 pl-5 pr-1 text-right text-[11px] text-[var(--director-text-secondary)] outline-none transition focus:border-[var(--director-accent)] focus:ring-2 focus:ring-[var(--director-accent-soft)]"
              ariaLabel={`${label} ${axis}${suffix ?? ""}`}
            />
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function SwitchField({
  label,
  checked,
  onCheckedChange,
}: {
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label className="mt-3 flex items-center justify-between text-[11px] text-[var(--director-text-dim)]">
      {label}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onCheckedChange(!checked)}
        className={`relative h-5 w-9 rounded-full transition ${
          checked ? "bg-[var(--director-accent)]" : "bg-[#454545]"
        }`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full transition ${
            checked ? "left-[18px] bg-[#17171b]" : "left-0.5 bg-zinc-300"
          }`}
        />
      </button>
    </label>
  );
}
