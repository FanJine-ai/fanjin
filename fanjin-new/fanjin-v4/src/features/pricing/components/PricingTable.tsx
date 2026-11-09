import { useMemo } from "react";
import type { PricingModel, TokenUnit } from "../types";
import { pricingModelCapabilities } from "../lib/capabilities";
import { getModelPriceDisplay } from "../lib/price";

interface PricingTableProps {
  models: PricingModel[];
  tokenUnit?: TokenUnit;
  onModelClick?: (modelName: string) => void;
}

export function PricingTable({ models, tokenUnit = "M", onModelClick }: PricingTableProps) {
  return (
    <div className="rounded-lg border border-[var(--cui-border)] bg-[var(--cui-surface)] overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-[var(--cui-border)] bg-[var(--cui-surface-secondary)]">
              <th className="px-4 py-3 text-left text-sm font-medium text-[var(--cui-text)]">
                模型名称
              </th>
              <th className="px-4 py-3 text-left text-sm font-medium text-[var(--cui-text)]">
                类型
              </th>
              <th className="px-4 py-3 text-left text-sm font-medium text-[var(--cui-text)]">
                供应商
              </th>
              <th className="px-4 py-3 text-left text-sm font-medium text-[var(--cui-text)]">
                输入价格
              </th>
              <th className="px-4 py-3 text-left text-sm font-medium text-[var(--cui-text)]">
                输出 / 媒体输入价格
              </th>
              <th className="px-4 py-3 text-left text-sm font-medium text-[var(--cui-text)]">
                能力
              </th>
              <th className="px-4 py-3 text-left text-sm font-medium text-[var(--cui-text)]">
                状态
              </th>
            </tr>
          </thead>
          <tbody>
            {models.map((model) => {
              const pricing = getModelPriceDisplay(model, tokenUnit);
              return (
                <tr
                  key={model.id}
                  className="border-b border-[var(--cui-border)] hover:bg-[var(--cui-surface-hover)] cursor-pointer transition-colors"
                  onClick={() => onModelClick?.(model.model_name)}
                >
                  <td className="px-4 py-3">
                    <div className="flex flex-col">
                      <span className="font-mono text-sm font-medium text-[var(--cui-text)]">
                        {model.model_name}
                      </span>
                      <span className="text-xs text-[var(--cui-text-muted)]">{model.name}</span>
                      {Number(model.discount_bps || 10_000) < 10_000 ? <span className="text-xs text-[var(--cui-primary)]">{model.pricing_group || "专属分组"} · {Number(model.discount_bps) / 100}% 实付</span> : null}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center rounded-full bg-[var(--cui-primary)]/10 px-2 py-1 text-xs font-medium text-[var(--cui-primary)]">
                      {model.unit === "second" ? "按时长计费" : model.quota_type === 0 ? "按量计费" : "按次计费"}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-sm text-[var(--cui-text)]">{model.vendor_name}</span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-col">
                      <span className="text-sm font-medium text-[var(--cui-text)]">
                        {pricing.mediaInputPrice !== undefined ? "文本输入 " : ""}{pricing.inputPrice}
                      </span>
                      {pricing.configured && pricing.unit && (
                        <span className="text-xs text-[var(--cui-text-muted)]">
                          / {pricing.unit}
                        </span>
                      )}
                      {!pricing.configured && (
                        <span className="text-xs text-[var(--cui-text-muted)]">未提供价格</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-col">
                      <span className="text-sm font-medium text-[var(--cui-text)]">
                        {pricing.mediaInputPrice !== undefined ? "图片/视频输入 " : ""}{pricing.mediaInputPrice ?? pricing.outputPrice}
                      </span>
                      {pricing.configured && (pricing.mediaInputPrice ?? pricing.outputPrice) !== "—" && pricing.unit && (
                        <span className="text-xs text-[var(--cui-text-muted)]">
                          / {pricing.unit}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {pricingModelCapabilities(model).slice(0, 3).map((cap) => (
                        <span
                          key={cap}
                          className="inline-flex items-center rounded bg-[var(--cui-surface-secondary)] px-1.5 py-0.5 text-xs text-[var(--cui-text-muted)]"
                        >
                          {cap}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={model.status} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {models.length === 0 && (
        <div className="py-12 text-center text-sm text-[var(--cui-text-muted)]">
          没有找到模型
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const statusConfig = {
    active: { label: "可用", className: "bg-green-500/10 text-green-600 dark:text-green-400" },
    disabled: { label: "已禁用", className: "bg-gray-500/10 text-gray-600 dark:text-gray-400" },
    unconfigured: { label: "未配置", className: "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400" },
    planned: { label: "计划中", className: "bg-blue-500/10 text-blue-600 dark:text-blue-400" },
  };

  const config = statusConfig[status as keyof typeof statusConfig] || statusConfig.unconfigured;

  return (
    <span className={`inline-flex items-center rounded-full px-2 py-1 text-xs font-medium ${config.className}`}>
      {config.label}
    </span>
  );
}
