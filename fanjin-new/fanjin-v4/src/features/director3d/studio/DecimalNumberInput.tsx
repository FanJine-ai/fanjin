"use client";

import { useState } from "react";

interface DecimalNumberInputProps {
  value: number;
  min: number;
  max: number;
  step: number | string;
  precision: number;
  onValueChange: (value: number) => void;
  className?: string;
  ariaLabel: string;
}

function formatValue(value: number, precision: number) {
  return Number(value.toFixed(precision)).toString();
}

export function DecimalNumberInput({
  value,
  min,
  max,
  step,
  precision,
  onValueChange,
  className,
  ariaLabel,
}: DecimalNumberInputProps) {
  const [inputValue, setInputValue] = useState("");
  const [isEditing, setIsEditing] = useState(false);

  const commit = () => {
    const parsedValue = Number(inputValue);
    const nextValue = Number.isFinite(parsedValue)
      ? Math.round(
          Math.min(max, Math.max(min, parsedValue)) * 10 ** precision,
        ) /
        10 ** precision
      : value;
    setIsEditing(false);
    if (nextValue !== value) onValueChange(nextValue);
  };

  return (
    <input
      type="number"
      min={min}
      max={max}
      step={step}
      value={isEditing ? inputValue : formatValue(value, precision)}
      onFocus={() => {
        setInputValue(formatValue(value, precision));
        setIsEditing(true);
      }}
      onChange={(event) => setInputValue(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
      className={className}
      aria-label={ariaLabel}
    />
  );
}
