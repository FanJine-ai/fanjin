export type PricingVendor = {
  id: number;
  name: string;
  icon?: string;
  description?: string;
};

export type PricingTimePeriod = {
  id: string;
  name: string;
  daysOfWeek: number[];
  startMinute: number;
  endMinute: number;
  multiplierBps: number;
};

export type PricingTimePricing = {
  enabled: true;
  timezone: string;
  evaluated_at: number;
  multiplier_bps: number;
  multiplier: number;
  current_period_id: string | null;
  current_period_name: string | null;
  periods: PricingTimePeriod[];
};

export type PricingModel = {
  id: string;
  model_name: string;
  name: string;
  description?: string | null;
  vendor_id?: number | null;
  vendor_name?: string;
  vendor_icon?: string;
  category: string;
  endpoint_type: string;
  api_style: string;
  modalities: string[];
  output: string;
  status: "active" | "disabled" | "unconfigured" | "planned";
  quota_type: 0 | 1; // 0: usage-based, 1: per-request
  unit: string;
  currency: string;
  unit_price_micros: number;
  list_unit_price_micros?: number;
  pricing_group?: string;
  discount_bps?: number;
  base_unit_price_micros?: number;
  pricing_configured?: boolean;
  input_price_micros?: number | null;
  output_price_micros?: number | null;
  text_input_price_micros?: number | null;
  media_input_price_micros?: number | null;
  base_input_price_micros?: number | null;
  base_output_price_micros?: number | null;
  time_pricing?: PricingTimePricing | null;
  model_ratio: number;
  completion_ratio: number;
  capabilities?: string[];
  resolutions?: string[];
  default_resolution?: string | null;
  qualities?: string[];
  default_quality?: string | null;
  context_length?: number | null;
  max_output_tokens?: number | null;
  tags?: string;
  enable_groups: string[];
  supported_endpoint_types: string[];
};

export type PricingData = {
  success?: boolean;
  message?: string;
  data: PricingModel[];
  vendors: PricingVendor[];
  group_ratio: Record<string, number>;
  usable_group: Record<string, { desc: string; ratio: number }>;
  supported_endpoint: Record<string, string>;
  auto_groups: string[];
};

export type TokenUnit = "M" | "K";
export type QuotaType = 0 | 1; // 0: token-based, 1: per-request
