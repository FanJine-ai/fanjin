import { useCallback, useEffect, useState } from "react";
import { apiGet } from "../../api/http";
import { shouldInstallRecurringProofPageRefresh } from "../../utils/isolatedSessionProofMode";

export type FrontstageBalanceState = {
  loading: boolean;
  error: string;
  availableMicros: number;
  reservedMicros: number;
  baselineMicros: number;
  spentMicros: number;
  percent: number;
  lastRechargeAt: number | null;
};

function requireFiniteNonNegative(value: unknown, field: string) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`余额响应缺少有效 ${field}`);
  }
  return number;
}

export function projectFrontstageBalance(
  account: Record<string, unknown>,
  ledgerItems: any[],
): Omit<FrontstageBalanceState, "loading" | "error"> {
  const latestRecharge = [...ledgerItems]
    .filter((item) => item?.type === "recharge" && (!item?.status || item.status === "succeeded"))
    .sort((left, right) => Number(right?.createTime || right?.createdAt || 0) - Number(left?.createTime || left?.createdAt || 0))[0];
  const availableMicros = requireFiniteNonNegative(account.availableMicros, "availableMicros");
  const balanceMicros = requireFiniteNonNegative(
    account.balanceMicros ?? account.allocatedQuotaMicros,
    "balanceMicros",
  );
  const reservedMicros = requireFiniteNonNegative(
    account.reservedMicros ?? account.frozenMicros,
    "reservedMicros",
  );
  const fallbackBaseline = Math.max(
    availableMicros,
    balanceMicros,
    Number(account.allocatedQuotaMicros || 0),
  );
  const baselineMicros = Math.max(
    0,
    Number(latestRecharge?.balanceAfterMicros || latestRecharge?.balanceAfter || 0) || fallbackBaseline,
  );
  const percent = baselineMicros > 0
    ? Math.max(0, Math.min(100, Math.round((availableMicros / baselineMicros) * 100)))
    : 0;
  return {
    availableMicros,
    reservedMicros,
    baselineMicros,
    // Workspace balance is reduced only by posted deductions. A reservation
    // lowers availableMicros but must not be presented as already consumed.
    spentMicros: Math.max(0, baselineMicros - balanceMicros),
    percent,
    lastRechargeAt: latestRecharge
      ? Number(latestRecharge.createTime || latestRecharge.createdAt || 0) || null
      : null,
  };
}

export function useFrontstageBalance(workspaceId: string | number | null, enabled = true) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [state, setState] = useState<FrontstageBalanceState>({
    loading: true,
    error: "",
    availableMicros: 0,
    reservedMicros: 0,
    baselineMicros: 0,
    spentMicros: 0,
    percent: 0,
    lastRechargeAt: null,
  });

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let requestSequence = 0;
    let activeController: AbortController | null = null;

    async function loadBalance(showLoading: boolean) {
      const sequence = ++requestSequence;
      activeController?.abort();
      const controller = new AbortController();
      activeController = controller;
      if (showLoading) {
        setState((current) => ({ ...current, loading: true, error: "" }));
      }
      try {
        const workspaceQuery = new URLSearchParams();
        if (workspaceId) workspaceQuery.set("workspaceId", String(workspaceId));
        const overviewQuery = workspaceQuery.toString();
        const overview = await apiGet<any>(
          `/billing/overview${overviewQuery ? `?${overviewQuery}` : ""}`,
          undefined,
          { signal: controller.signal },
        );
        if (!alive || sequence !== requestSequence) return;
        const account = overview?.account;
        if (!account || typeof account !== "object") {
          throw new Error("余额响应缺少工作区账户");
        }
        const ledgerItems = overview?.latestRecharge
          ? [overview.latestRecharge]
          : [];
        setState({
          loading: false,
          error: "",
          ...projectFrontstageBalance(account, ledgerItems),
        });
      } catch (error) {
        if (
          !alive
          || sequence !== requestSequence
          || controller.signal.aborted
          || (error instanceof DOMException && error.name === "AbortError")
        ) return;
        setState((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : "余额读取失败",
        }));
      }
    }

    void loadBalance(true);
    // The isolated two-tab CAS proof has an exact request multiset. Keep its
    // single initial balance read deterministic: a focus transition between
    // the two runner-owned pages, or a slow debug pause crossing 60 seconds,
    // must not manufacture an unrelated fourth balance request. This branch
    // is unreachable in public builds and on every non-exact proof URL.
    const installRecurringRefresh = typeof window === "undefined"
      || shouldInstallRecurringProofPageRefresh(
        window.location,
        import.meta.env.DEV,
      );
    if (!installRecurringRefresh) {
      return () => {
        alive = false;
        requestSequence += 1;
        activeController?.abort();
      };
    }
    const handleFocus = () => void loadBalance(false);
    const refreshTimer = window.setInterval(() => void loadBalance(false), 60_000);
    window.addEventListener("focus", handleFocus);
    return () => {
      alive = false;
      requestSequence += 1;
      activeController?.abort();
      window.clearInterval(refreshTimer);
      window.removeEventListener("focus", handleFocus);
    };
  }, [enabled, refreshKey, workspaceId]);

  const refresh = useCallback(() => setRefreshKey((current) => current + 1), []);
  return {
    ...state,
    refresh,
  };
}
