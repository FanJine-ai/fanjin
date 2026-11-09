import { useId, useState, type ReactNode } from "react";
import { ChevronDown, SlidersHorizontal } from "lucide-react";
import "./data.css";

export interface BreadcrumbItem {
  label: ReactNode;
  href?: string;
  onClick?: () => void;
}

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  breadcrumbs?: BreadcrumbItem[];
  primaryAction?: ReactNode;
  className?: string;
}

/** Flat, content-first heading for console pages. Keep `primaryAction` to one CTA. */
export function PageHeader({
  title,
  description,
  breadcrumbs = [],
  primaryAction,
  className,
}: PageHeaderProps) {
  return (
    <header className={["consolePageHeading", className].filter(Boolean).join(" ")}>
      <div className="consolePageHeading__copy">
        {breadcrumbs.length > 0 && (
          <nav className="consoleBreadcrumbs" aria-label="面包屑">
            <ol>
              {breadcrumbs.map((item, index) => {
                const isCurrent = index === breadcrumbs.length - 1;
                return (
                  <li key={`${index}-${String(item.label)}`}>
                    {item.href && !isCurrent ? (
                      <a href={item.href}>{item.label}</a>
                    ) : item.onClick && !isCurrent ? (
                      <button type="button" onClick={item.onClick}>
                        {item.label}
                      </button>
                    ) : (
                      <span aria-current={isCurrent ? "page" : undefined}>{item.label}</span>
                    )}
                  </li>
                );
              })}
            </ol>
          </nav>
        )}
        <h1>{title}</h1>
        {description && <div className="consolePageHeading__description">{description}</div>}
      </div>
      {primaryAction && <div className="consolePageHeading__primaryAction">{primaryAction}</div>}
    </header>
  );
}

export type MetricTone = "neutral" | "positive" | "warning" | "danger" | "info";

export interface MetricItem {
  id: string;
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  trend?: ReactNode;
  tone?: MetricTone;
}

export interface MetricStripProps {
  metrics: MetricItem[];
  ariaLabel?: string;
  className?: string;
}

/** A compact decision-support strip; callers should normally provide three or four metrics. */
export function MetricStrip({ metrics, ariaLabel = "关键指标", className }: MetricStripProps) {
  return (
    <section
      className={["consoleMetricStrip", className].filter(Boolean).join(" ")}
      aria-label={ariaLabel}
    >
      <dl>
        {metrics.map((metric) => (
          <div
            className="consoleMetricStrip__item"
            data-tone={metric.tone ?? "neutral"}
            key={metric.id}
          >
            <dt>{metric.label}</dt>
            <dd>
              <span className="consoleMetricStrip__value">{metric.value}</span>
              {metric.trend && <span className="consoleMetricStrip__trend">{metric.trend}</span>}
            </dd>
            {metric.hint && <div className="consoleMetricStrip__hint">{metric.hint}</div>}
          </div>
        ))}
      </dl>
    </section>
  );
}

export interface FilterBarProps {
  children: ReactNode;
  advanced?: ReactNode;
  actions?: ReactNode;
  ariaLabel?: string;
  advancedLabel?: string;
  activeAdvancedCount?: number;
  expanded?: boolean;
  defaultExpanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  className?: string;
}

/** Core filters stay visible; optional advanced filters use progressive disclosure. */
export function FilterBar({
  children,
  advanced,
  actions,
  ariaLabel = "筛选条件",
  advancedLabel = "高级筛选",
  activeAdvancedCount = 0,
  expanded,
  defaultExpanded = false,
  onExpandedChange,
  className,
}: FilterBarProps) {
  const advancedId = useId();
  const [uncontrolledExpanded, setUncontrolledExpanded] = useState(defaultExpanded);
  const isExpanded = expanded ?? uncontrolledExpanded;

  const toggleAdvanced = () => {
    const next = !isExpanded;
    if (expanded === undefined) setUncontrolledExpanded(next);
    onExpandedChange?.(next);
  };

  return (
    <section
      className={["consoleFilterBar", className].filter(Boolean).join(" ")}
      aria-label={ariaLabel}
    >
      <div className="consoleFilterBar__main">
        <div className="consoleFilterBar__fields">{children}</div>
        <div className="consoleFilterBar__actions">
          {advanced && (
            <button
              className="consoleFilterBar__advancedToggle"
              type="button"
              aria-controls={advancedId}
              aria-expanded={isExpanded}
              onClick={toggleAdvanced}
            >
              <SlidersHorizontal aria-hidden="true" size={17} />
              <span>{advancedLabel}</span>
              {activeAdvancedCount > 0 && (
                <span className="consoleFilterBar__count" aria-label={`${activeAdvancedCount} 个已启用`}>
                  {activeAdvancedCount}
                </span>
              )}
              <ChevronDown className="consoleFilterBar__chevron" aria-hidden="true" size={16} />
            </button>
          )}
          {actions}
        </div>
      </div>
      {advanced && isExpanded && (
        <div className="consoleFilterBar__advanced" id={advancedId}>
          {advanced}
        </div>
      )}
    </section>
  );
}
