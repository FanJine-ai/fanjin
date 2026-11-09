import { useCallback, useEffect, useState } from "react";
import { listLogicalModelPricing, listPricingRules, type LogicalModelPricingView } from "./api";
import type { PricingRule } from "./types";

export function usePricingRules() {
  const [rules, setRules] = useState<PricingRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const reload = useCallback(async () => {
    setLoading(true); setError("");
    try { setRules(await listPricingRules()); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "模型定价读取失败"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  return { rules, loading, error, reload };
}

export function useLogicalModelPricing() {
  const [groups, setGroups] = useState<LogicalModelPricingView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const reload = useCallback(async () => {
    setLoading(true); setError("");
    try { setGroups(await listLogicalModelPricing()); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "模型定价读取失败"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  return { groups, loading, error, reload };
}
