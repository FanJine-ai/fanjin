import type { LucideIcon } from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";
import { PageHeader, type BreadcrumbItem } from "./layout";
import { consoleClassNames } from "./class-names";
import "./recipes.css";

export interface ConsolePageProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  title: ReactNode;
  description?: ReactNode;
  breadcrumbs?: BreadcrumbItem[];
  eyebrow?: string;
  primaryAction?: ReactNode;
  layoutWidth?: "data" | "dashboard" | "content";
  /** Parent route shells can supply navigation while the child owns the page heading. */
  showHeader?: boolean;
  children: ReactNode;
}

/** Canonical content wrapper for every console route. */
export function ConsolePage({
  title,
  description,
  breadcrumbs,
  eyebrow,
  primaryAction,
  layoutWidth = "data",
  showHeader = true,
  children,
  className,
  ...props
}: ConsolePageProps) {
  const resolvedBreadcrumbs = breadcrumbs ?? (eyebrow ? [{ label: eyebrow }, { label: title }] : undefined);
  return (
    <div
      {...props}
      className={consoleClassNames("cuiPage", className)}
      data-page-width={layoutWidth}
    >
      {showHeader && <PageHeader
        breadcrumbs={resolvedBreadcrumbs}
        title={title}
        description={description}
        primaryAction={primaryAction}
      />}
      {children}
    </div>
  );
}

export interface SectionProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  title?: ReactNode;
  description?: ReactNode;
  icon?: LucideIcon;
  action?: ReactNode;
  surface?: "flat" | "outlined" | "subtle";
  children: ReactNode;
}

/** A semantic content section. Flat is the default; add a surface only for a real boundary. */
export function Section({
  title,
  description,
  icon: Icon,
  action,
  surface = "flat",
  children,
  className,
  ...props
}: SectionProps) {
  const hasHeader = Boolean(title || description || action);
  return (
    <section {...props} className={consoleClassNames("cuiSection", `cuiSection--${surface}`, className)}>
      {hasHeader ? (
        <header className="cuiSection__header">
          <div className="cuiSection__heading">
            {Icon ? <Icon className="cuiSection__icon" aria-hidden="true" size={16} strokeWidth={1.75} /> : null}
            <div className="cuiSection__copy">
              {title ? <h2>{title}</h2> : null}
              {description ? <p>{description}</p> : null}
            </div>
          </div>
          {action ? <div className="cuiSection__action">{action}</div> : null}
        </header>
      ) : null}
      <div className="cuiSection__content">{children}</div>
    </section>
  );
}

export function Toolbar({ children, className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={consoleClassNames("cuiToolbar", className)}>{children}</div>;
}

export function ResponsiveSplit({
  primary,
  secondary,
  ratio = "default",
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  primary: ReactNode;
  secondary: ReactNode;
  ratio?: "default" | "aside-first" | "balanced";
}) {
  return (
    <div {...props} className={consoleClassNames("cuiResponsiveSplit", className)} data-ratio={ratio}>
      {primary}
      {secondary}
    </div>
  );
}

export function FormGrid({
  children,
  columns = 2,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { columns?: 1 | 2 | 3 }) {
  return <div {...props} className={consoleClassNames("cuiFormGrid", className)} data-columns={columns}>{children}</div>;
}

export interface DescriptionItem {
  label: ReactNode;
  value: ReactNode;
  id?: string;
}

export function DescriptionList({
  items,
  className,
  ...props
}: HTMLAttributes<HTMLDListElement> & { items: DescriptionItem[] }) {
  return (
    <dl {...props} className={consoleClassNames("cuiDescriptionList", className)}>
      {items.map((item, index) => (
        <div className="cuiDescriptionList__item" key={item.id ?? `${index}-${String(item.label)}`}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export type AlertTone = "neutral" | "info" | "success" | "warning" | "danger";

export function Alert({
  tone = "neutral",
  title,
  children,
  className,
  role,
  ...props
}: Omit<HTMLAttributes<HTMLDivElement>, "title"> & { tone?: AlertTone; title?: ReactNode }) {
  return (
    <div
      {...props}
      className={consoleClassNames("cuiAlert", `cuiAlert--${tone}`, className)}
      role={role ?? (tone === "danger" ? "alert" : "status")}
    >
      {title ? <strong>{title}</strong> : null}
      <div className="cuiAlert__content">{children}</div>
    </div>
  );
}

export function EmptyState({
  title = "暂无数据",
  description,
  action,
  icon: Icon,
  className,
  ...props
}: Omit<HTMLAttributes<HTMLDivElement>, "title"> & {
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  icon?: LucideIcon;
}) {
  return (
    <div {...props} className={consoleClassNames("cuiEmptyState", className)}>
      {Icon ? <Icon aria-hidden="true" size={24} strokeWidth={1.75} /> : null}
      <strong>{title}</strong>
      {description ? <p>{description}</p> : null}
      {action ? <div className="cuiEmptyState__action">{action}</div> : null}
    </div>
  );
}

export function CodeBlock({
  children,
  language,
  className,
  ...props
}: HTMLAttributes<HTMLPreElement> & { children: string; language?: string }) {
  return (
    <pre {...props} className={consoleClassNames("cuiCodeBlock", className)} data-language={language}>
      <code>{children}</code>
    </pre>
  );
}

export function ProgressBar({
  value,
  tone = "info",
  label,
  className,
}: {
  value: number;
  tone?: "info" | "success" | "warning" | "danger" | "neutral";
  label?: string;
  className?: string;
}) {
  const normalized = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  return (
    <progress
      className={consoleClassNames("cuiProgress", `cuiProgress--${tone}`, className)}
      value={normalized}
      max={100}
      aria-label={label}
    >
      {normalized}%
    </progress>
  );
}
