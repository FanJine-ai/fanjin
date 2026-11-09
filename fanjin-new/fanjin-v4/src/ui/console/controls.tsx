import React, { forwardRef, useId } from "react";
import type {
  ButtonHTMLAttributes,
  CSSProperties,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from "react";
import "./tokens.css";
import "./controls.css";

function classes(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ControlSize = "compact" | "default";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ControlSize;
  loading?: boolean;
  icon?: ReactNode;
  iconPosition?: "start" | "end";
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    children,
    className,
    variant = "primary",
    size = "default",
    loading = false,
    icon,
    iconPosition = "start",
    disabled,
    type = "button",
    ...props
  },
  ref,
) {
  const isDisabled = disabled || loading;
  const visualIcon = loading ? <span className="cuiSpinner" aria-hidden="true" /> : icon;

  return (
    <button
      {...props}
      ref={ref}
      type={type}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      className={classes("cuiButton", `cuiButton--${variant}`, `cuiControl--${size}`, className)}
    >
      {visualIcon && iconPosition === "start" ? <span className="cuiButton__icon">{visualIcon}</span> : null}
      <span className="cuiButton__label">{children}</span>
      {visualIcon && iconPosition === "end" ? <span className="cuiButton__icon">{visualIcon}</span> : null}
      {loading ? <span className="cuiVisuallyHidden">加载中</span> : null}
    </button>
  );
});

export type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "children"> & {
  "aria-label": string;
  icon: ReactNode;
  variant?: ButtonVariant;
  size?: ControlSize;
  loading?: boolean;
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    "aria-label": ariaLabel,
    icon,
    className,
    variant = "ghost",
    size = "default",
    loading = false,
    disabled,
    type = "button",
    ...props
  },
  ref,
) {
  return (
    <button
      {...props}
      ref={ref}
      type={type}
      aria-label={ariaLabel}
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      className={classes("cuiIconButton", `cuiButton--${variant}`, `cuiControl--${size}`, className)}
    >
      {loading ? <span className="cuiSpinner" aria-hidden="true" /> : icon}
    </button>
  );
});

export type BadgeTone = "neutral" | "info" | "success" | "warning" | "danger";

export function Badge({
  children,
  icon,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  icon?: ReactNode;
  tone?: BadgeTone;
  className?: string;
}) {
  return (
    <span className={classes("cuiBadge", `cuiBadge--${tone}`, className)}>
      {icon ? <span className="cuiBadge__icon" aria-hidden="true">{icon}</span> : null}
      <span>{children}</span>
    </span>
  );
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
  startIcon?: ReactNode;
  endAdornment?: ReactNode;
  containerClassName?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    className,
    containerClassName,
    invalid = false,
    startIcon,
    endAdornment,
    disabled,
    "aria-invalid": ariaInvalid,
    ...props
  },
  ref,
) {
  return (
    <span className={classes("cuiInputFrame", invalid && "is-invalid", disabled && "is-disabled", containerClassName)}>
      {startIcon ? <span className="cuiInputFrame__adornment" aria-hidden="true">{startIcon}</span> : null}
      <input
        {...props}
        ref={ref}
        disabled={disabled}
        aria-invalid={ariaInvalid ?? (invalid || undefined)}
        className={classes("cuiInput", className)}
      />
      {endAdornment ? <span className="cuiInputFrame__adornment">{endAdornment}</span> : null}
    </span>
  );
});

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, invalid = false, disabled, "aria-invalid": ariaInvalid, children, ...props },
  ref,
) {
  return (
    <select
      {...props}
      ref={ref}
      disabled={disabled}
      aria-invalid={ariaInvalid ?? (invalid || undefined)}
      className={classes("cuiSelect", invalid && "is-invalid", className)}
    >
      {children}
    </select>
  );
});

export interface TabItem {
  value: string;
  label: ReactNode;
  disabled?: boolean;
  panelId?: string;
}

export function Tabs({
  items,
  value,
  onValueChange,
  ariaLabel,
  className,
}: {
  items: TabItem[];
  value: string;
  onValueChange: (value: string) => void;
  ariaLabel: string;
  className?: string;
}) {
  const generatedId = useId();

  function moveFocus(event: React.KeyboardEvent<HTMLButtonElement>, currentIndex: number) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const enabledIndexes = items.map((item, index) => item.disabled ? -1 : index).filter((index) => index >= 0);
    if (!enabledIndexes.length) return;
    const enabledPosition = enabledIndexes.indexOf(currentIndex);
    let targetIndex = currentIndex;
    if (event.key === "Home") targetIndex = enabledIndexes[0];
    if (event.key === "End") targetIndex = enabledIndexes[enabledIndexes.length - 1];
    if (event.key === "ArrowRight") targetIndex = enabledIndexes[(enabledPosition + 1) % enabledIndexes.length];
    if (event.key === "ArrowLeft") targetIndex = enabledIndexes[(enabledPosition - 1 + enabledIndexes.length) % enabledIndexes.length];
    onValueChange(items[targetIndex].value);
    document.getElementById(`${generatedId}-tab-${targetIndex}`)?.focus();
  }

  return (
    <div role="tablist" aria-label={ariaLabel} className={classes("cuiTabs", className)}>
      {items.map((item, index) => {
        const selected = item.value === value;
        return (
          <button
            key={item.value}
            id={`${generatedId}-tab-${index}`}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={item.panelId}
            tabIndex={selected ? 0 : -1}
            disabled={item.disabled}
            className="cuiTabs__tab"
            onClick={() => onValueChange(item.value)}
            onKeyDown={(event) => moveFocus(event, index)}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

export function Skeleton({
  width = "100%",
  height = "1rem",
  radius = "var(--cui-radius-sm)",
  label = "内容加载中",
  className,
}: {
  width?: CSSProperties["width"];
  height?: CSSProperties["height"];
  radius?: CSSProperties["borderRadius"];
  label?: string;
  className?: string;
}) {
  return (
    <span
      role="status"
      aria-label={label}
      className={classes("cuiSkeleton", className)}
      style={{
        "--cui-skeleton-width": width,
        "--cui-skeleton-height": height,
        "--cui-skeleton-radius": radius,
      } as CSSProperties}
    />
  );
}

