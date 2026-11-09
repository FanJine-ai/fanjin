import { GU_MICROS_PER_GU } from "@/utils/billingUnits";
import type { AiModelOption } from "@/lib/api";
import { getCatalogModelPrice } from "./modelCatalog";

export function formatPointPrice(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (Math.abs(value - Math.round(value)) < 0.001) return String(Math.round(value));
  return value.toFixed(2).replace(/\.?0+$/, "");
}

export function formatCanvasBalanceGu(micros: number) {
  const gu = Math.max(0, Number(micros || 0)) / GU_MICROS_PER_GU;
  return gu.toLocaleString("zh-CN", {
    minimumFractionDigits: 0,
    maximumFractionDigits: gu >= 100 ? 0 : 2,
  });
}

export function catalogModelPriceText(model: AiModelOption | null | undefined) {
  const price = getCatalogModelPrice(model);
  return price === null ? "" : formatPointPrice(price);
}
