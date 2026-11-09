import {
  cloneElement,
  forwardRef,
  useId,
  useMemo,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";

import "./overlays.css";

function joinClassNames(...names: Array<string | false | null | undefined>) {
  return names.filter(Boolean).join(" ");
}

function joinIds(...ids: Array<string | null | undefined>) {
  return ids.filter(Boolean).join(" ") || undefined;
}

interface FieldControlProps {
  id?: string;
  disabled?: boolean;
  required?: boolean;
  "aria-describedby"?: string;
  "aria-errormessage"?: string;
  "aria-invalid"?: boolean | "false" | "true";
}

export interface FormFieldProps {
  label: ReactNode;
  children: ReactElement<FieldControlProps>;
  help?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  optionalLabel?: ReactNode;
  disabled?: boolean;
  id?: string;
  className?: string;
}

export function FormField({
  label,
  children,
  help,
  error,
  required = false,
  optionalLabel = "可选",
  disabled = false,
  id,
  className,
}: FormFieldProps) {
  const generatedId = useId();
  const hasError = error !== undefined && error !== null && error !== false;
  const controlId = children.props.id ?? id ?? `console-field-${generatedId}`;
  const helpId = help ? `${controlId}-help` : undefined;
  const errorId = hasError ? `${controlId}-error` : undefined;
  const control = cloneElement(children, {
    id: controlId,
    disabled: children.props.disabled ?? disabled,
    required: children.props.required ?? required,
    "aria-invalid": hasError ? true : children.props["aria-invalid"],
    "aria-errormessage": errorId ?? children.props["aria-errormessage"],
    "aria-describedby": joinIds(children.props["aria-describedby"], helpId, errorId),
  });

  return (
    <div className={joinClassNames("consoleFormField", hasError && "consoleFormFieldInvalid", disabled && "consoleFormFieldDisabled", className)}>
      <label className="consoleFieldLabel" htmlFor={controlId}>
        <span>{label}</span>
        {required ? <span className="consoleFieldRequired" aria-hidden="true">*</span> : optionalLabel ? <span className="consoleFieldOptional">{optionalLabel}</span> : null}
      </label>
      {control}
      {help && <div id={helpId} className="consoleFieldHelp">{help}</div>}
      {hasError && <FieldError id={errorId}>{error}</FieldError>}
    </div>
  );
}

export interface FieldGroupProps {
  legend: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  disabled?: boolean;
  variant?: "boxed" | "section" | "plain";
  className?: string;
}

export function FieldGroup({ legend, description, children, disabled = false, variant = "boxed", className }: FieldGroupProps) {
  const descriptionId = useId();
  return (
    <fieldset
      className={joinClassNames("consoleFieldGroup", `consoleFieldGroup--${variant}`, className)}
      disabled={disabled}
      aria-describedby={description ? descriptionId : undefined}
    >
      <legend>{legend}</legend>
      {description && <p id={descriptionId} className="consoleFieldGroupDescription">{description}</p>}
      <div className="consoleFieldGroupContent">{children}</div>
    </fieldset>
  );
}

export function FieldError({ id, children, className }: { id?: string; children: ReactNode; className?: string }) {
  return <div id={id} className={joinClassNames("consoleFieldError", className)} role="alert" aria-live="polite">{children}</div>;
}

export interface SwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "role" | "value"> {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
}

export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  { checked, onCheckedChange, label, description, disabled, className, id, ...buttonProps },
  ref,
) {
  const generatedId = useId();
  const switchId = id ?? `console-switch-${generatedId}`;
  const labelId = `${switchId}-label`;
  const descriptionId = description ? `${switchId}-description` : undefined;
  return (
    <div className={joinClassNames("consoleSwitchField", disabled && "consoleSwitchFieldDisabled", className)}>
      <button
        {...buttonProps}
        ref={ref}
        id={switchId}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        aria-describedby={descriptionId}
        disabled={disabled}
        className="consoleSwitchControl"
        onClick={() => onCheckedChange(!checked)}
      >
        <span aria-hidden="true" className="consoleSwitchThumb" />
      </button>
      <div className="consoleSwitchCopy">
        <label id={labelId} htmlFor={switchId}>{label}</label>
        {description && <p id={descriptionId}>{description}</p>}
      </div>
    </div>
  );
});

export interface NumberInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "defaultValue" | "onChange" | "step"> {
  value: number | null;
  onValueChange: (value: number | null) => void;
  step?: number;
  decrementLabel?: string;
  incrementLabel?: string;
}

function precisionForStep(step: number) {
  const text = String(step);
  return text.includes(".") ? text.length - text.indexOf(".") - 1 : 0;
}

export const NumberInput = forwardRef<HTMLInputElement, NumberInputProps>(function NumberInput(
  {
    value,
    onValueChange,
    min,
    max,
    step = 1,
    disabled,
    readOnly,
    className,
    decrementLabel = "减少数值",
    incrementLabel = "增加数值",
    ...inputProps
  },
  ref,
) {
  const clamp = (nextValue: number) => {
    const minimum = typeof min === "number" ? min : min === undefined ? undefined : Number(min);
    const maximum = typeof max === "number" ? max : max === undefined ? undefined : Number(max);
    const lowerBounded = minimum !== undefined && Number.isFinite(minimum) ? Math.max(minimum, nextValue) : nextValue;
    return maximum !== undefined && Number.isFinite(maximum) ? Math.min(maximum, lowerBounded) : lowerBounded;
  };

  const move = (direction: -1 | 1) => {
    const baseline = value ?? (direction > 0 ? Number(min ?? 0) : Number(max ?? 0));
    const finiteBaseline = Number.isFinite(baseline) ? baseline : 0;
    const nextValue = clamp(Number((finiteBaseline + direction * step).toFixed(precisionForStep(step))));
    onValueChange(nextValue);
  };

  const atMinimum = value !== null && min !== undefined && value <= Number(min);
  const atMaximum = value !== null && max !== undefined && value >= Number(max);

  return (
    <div className={joinClassNames("consoleNumberInput", disabled && "consoleNumberInputDisabled", className)}>
      <button type="button" aria-label={decrementLabel} onClick={() => move(-1)} disabled={disabled || readOnly || atMinimum}>−</button>
      <input
        {...inputProps}
        ref={ref}
        type="number"
        inputMode="decimal"
        value={value ?? ""}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        readOnly={readOnly}
        onChange={(event) => {
          const nextValue = event.currentTarget.valueAsNumber;
          onValueChange(Number.isNaN(nextValue) ? null : nextValue);
        }}
      />
      <button type="button" aria-label={incrementLabel} onClick={() => move(1)} disabled={disabled || readOnly || atMaximum}>+</button>
    </div>
  );
});

export interface CodeEditorProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  language?: string;
  minRows?: number;
}

export const CodeEditor = forwardRef<HTMLTextAreaElement, CodeEditorProps>(function CodeEditor(
  { language = "text", minRows = 8, className, style, "aria-label": ariaLabel, ...textareaProps },
  ref,
) {
  const editorStyle = useMemo(() => ({ ...style, "--cui-code-min-rows": minRows } as React.CSSProperties), [minRows, style]);
  return (
    <div className={joinClassNames("consoleCodeEditor", className)} data-language={language}>
      <span className="consoleCodeLanguage" aria-hidden="true">{language}</span>
      <textarea
        {...textareaProps}
        ref={ref}
        aria-label={ariaLabel ?? (!textareaProps.id ? `${language} code editor` : undefined)}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        style={editorStyle}
      />
    </div>
  );
});
