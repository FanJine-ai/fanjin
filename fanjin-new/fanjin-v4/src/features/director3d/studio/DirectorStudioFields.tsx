"use client";

import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { DecimalNumberInput } from "./DecimalNumberInput";
import { DIRECTOR_STAGE } from "./types";

export function TransformFields({
  label,
  value,
  step = "0.1",
  suffix,
  className,
  limits,
  onChange,
}: {
  label: string;
  value: [number, number, number];
  step?: string;
  suffix?: string;
  className?: string;
  limits?: [[number, number], [number, number], [number, number]];
  onChange: (value: [number, number, number]) => void;
}) {
  return (
    <fieldset className={`mt-3 ${className ?? ""}`}>
      <legend className="text-[11px] text-[var(--director-text-muted)]">{label}</legend>
      <div className="mt-1.5 grid grid-cols-3 gap-1.5">
        {(["X", "Y", "Z"] as const).map((axis, index) => (
          <label key={axis} className="relative">
            <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[10px] text-[var(--director-text-dim)]">
              {axis}
            </span>
            <DecimalNumberInput
              value={value[index]}
              min={limits?.[index][0] ?? -9999}
              max={limits?.[index][1] ?? 9999}
              step={step === "0.1" ? DIRECTOR_STAGE.coordinateStep : step}
              precision={2}
              onValueChange={(nextValue) => {
                const next = [...value] as [number, number, number];
                next[index] = nextValue;
                onChange(next);
              }}
              className="w-full rounded-lg border border-[var(--director-border)] bg-[var(--director-panel-alt)] py-2 pl-5 pr-1 text-right text-[11px] text-[var(--director-text-secondary)] outline-none transition focus:border-[var(--director-accent)] focus:ring-2 focus:ring-[var(--director-accent-soft)]"
              ariaLabel={`${label} ${axis}`}
            />
            {suffix && <span className="sr-only">{suffix}</span>}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function CameraTextField({
  label,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <label className="mb-3 block text-[11px] text-[var(--director-text-muted)]">
      {label}
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        className="mt-1.5 w-full rounded-xl border border-[var(--director-border)] bg-[var(--director-panel-alt)] px-3 py-2.5 text-xs font-medium text-[var(--director-text)] outline-none transition focus:border-[var(--director-accent)] focus:ring-2 focus:ring-[var(--director-accent-soft)] disabled:text-[var(--director-text-muted)]"
      />
    </label>
  );
}

export function CameraSelectField({
  label,
  value,
  onChange,
  disabled = false,
  children,
}: {
  label: string;
  value: string;
  onChange?: (value: string) => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="mb-3 block text-[11px] text-[var(--director-text-muted)]">
      {label}
      <span className="relative mt-1.5 block">
        <select
          value={value}
          onChange={(event) => onChange?.(event.target.value)}
          disabled={disabled}
          className="w-full appearance-none rounded-xl border border-[var(--director-border)] bg-[var(--director-panel-alt)] px-3 py-2.5 text-xs font-medium text-[var(--director-text)] outline-none transition focus:border-[var(--director-accent)] focus:ring-2 focus:ring-[var(--director-accent-soft)] disabled:text-[var(--director-text-muted)]"
        >
          {children}
        </select>
        <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--director-text-muted)]" />
      </span>
    </label>
  );
}
