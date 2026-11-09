import { useCallback, useEffect, useState } from "react";
import { listBillingPlans } from "./api";
import type { BillingPlan } from "./types";

export function useBillingPlans() {
  const [plans, setPlans] = useState<BillingPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setPlans(await listBillingPlans());
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "套餐读取失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { plans, loading, error, reload };
}
