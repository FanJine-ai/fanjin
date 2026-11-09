import { useCallback, useEffect, useState } from "react";
import { toApiErrorView } from "../../../api/http";
import { listPricingGroups } from "./api";
import type { PricingGroup } from "./types";

export function usePricingGroups() {
  const [groups, setGroups] = useState<PricingGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setGroups(await listPricingGroups());
    } catch (caught) {
      setError(toApiErrorView(caught).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);
  return { groups, loading, error, reload };
}
