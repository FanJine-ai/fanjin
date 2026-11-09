import { GU_MICROS_PER_GU } from "@/utils/billingUnits";
import type { PricingModel, TokenUnit } from "../types";

const MICROS_PER_UNIT = 1_000_000;

function decimalAmount(value: number): string {
  if (!Number.isFinite(value)) return "";
  return value.toFixed(10).replace(/\.?0+$/, "");
}

function isTokenRate(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

function formatCurrencyAmount(amount: number, currency: string): string {
  const normalizedCurrency = currency.trim().toUpperCase();
  const formattedAmount = decimalAmount(amount);
  if (!formattedAmount || !normalizedCurrency) return "—";
  if (normalizedCurrency === "CNY") return `¥${formattedAmount}`;
  if (normalizedCurrency === "USD") return `$${formattedAmount}`;
  return `${formattedAmount} ${normalizedCurrency}`;
}

/** Format a server-provided price without inventing a GU-to-fiat exchange rate. */
export function formatUnitPrice(priceMicros: number, currency: string): string {
  if (!Number.isSafeInteger(priceMicros) || priceMicros < 0) return "—";
  return formatCurrencyAmount(priceMicros / (currency.toUpperCase() === "GU" ? GU_MICROS_PER_GU : MICROS_PER_UNIT), currency);
}

/** Format a per-token price for the selected token quantity. */
export function formatTokenPrice(
  priceMicrosPerToken: number,
  currency: string,
  tokenUnit: TokenUnit = "M",
): string {
  if (!isTokenRate(priceMicrosPerToken)) return "—";
  // micro-currency/token × 1M tokens = the same numeric amount in currency.
  // Avoid multiplying a safe integer by 1M, which could lose precision.
  const amount = tokenUnit === "K" ? priceMicrosPerToken / 1_000 : priceMicrosPerToken;
  return formatCurrencyAmount(currency.toUpperCase() === "GU" ? amount * (MICROS_PER_UNIT / GU_MICROS_PER_GU) : amount, currency);
}

function configuredPrice(model: PricingModel): boolean {
  if (model.pricing_configured === false) return false;
  return (model.unit === "token" ? isTokenRate(model.unit_price_micros) : Number.isSafeInteger(model.unit_price_micros))
    && model.unit_price_micros > 0;
}

/**
 * Build the model price display strictly from the public pricing contract.
 * Per-token rates may be fractional; only settled ledger charges are integers.
 * GU is shown as GU and is never relabelled as CNY.
 */
export function getModelPriceDisplay(
  model: PricingModel,
  tokenUnit: TokenUnit = "M",
): {
  inputPrice: string;
  outputPrice: string;
  unit: string;
  configured: boolean;
  mediaInputPrice?: string;
} {
  if (!configuredPrice(model) || !model.currency?.trim()) {
    return {
      inputPrice: "—",
      outputPrice: "—",
      unit: "",
      configured: false,
    };
  }

  if (model.unit === "token") {
    if (model.endpoint_type === "multimodal_embedding") {
      return {
        inputPrice: model.text_input_price_micros == null ? "—" : formatTokenPrice(model.text_input_price_micros, model.currency, tokenUnit),
        outputPrice: "—",
        mediaInputPrice: model.media_input_price_micros == null ? "—" : formatTokenPrice(model.media_input_price_micros, model.currency, tokenUnit),
        unit: tokenUnit === "K" ? "1K tokens" : "1M tokens",
        configured: true,
      };
    }
    const inputPriceMicros = model.input_price_micros ?? model.unit_price_micros;
    const outputPriceMicros = model.output_price_micros ?? model.unit_price_micros;
    return {
      inputPrice: formatTokenPrice(inputPriceMicros, model.currency, tokenUnit),
      outputPrice: formatTokenPrice(outputPriceMicros, model.currency, tokenUnit),
      unit: tokenUnit === "K" ? "1K tokens" : "1M tokens",
      configured: true,
    };
  }

  return {
    inputPrice: formatUnitPrice(model.unit_price_micros, model.currency),
    outputPrice: "—",
    unit: model.unit === "second" ? "秒" : model.unit || "",
    configured: true,
  };
}

/** Remove insignificant decimal zeroes from a plain numeric string. */
export function stripTrailingZeros(price: string): string {
  return price.replace(/\.?0+$/, "");
}
