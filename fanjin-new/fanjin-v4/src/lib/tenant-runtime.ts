import { useSyncExternalStore } from "react";

export type TenantRuntime = {
  id: string;
  name: string;
  operatorName: string;
  icpNumber: string | null;
  valueAddedTelecomLicense: string | null;
  publicSecurityRegistration: string | null;
  customerServiceEmail: string | null;
  rechargeEnabled: boolean;
  identityOrigin: string | null;
  currency: string;
};

const fallbackRuntime: TenantRuntime = {
  id: "FANJIN",
  name: "繁境",
  operatorName: "繁境（北京）科技有限公司",
  icpNumber: "京ICP备2026038668号",
  valueAddedTelecomLicense: null,
  publicSecurityRegistration: null,
  customerServiceEmail: "auth@fanjin.top",
  rechargeEnabled: true,
  identityOrigin: null,
  currency: "GU",
};

let currentRuntime = fallbackRuntime;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function getTenantRuntime() {
  return currentRuntime;
}

export async function loadTenantRuntime(): Promise<TenantRuntime> {
  try {
    const response = await fetch("/api/runtime/tenant", { headers: { Accept: "application/json" } });
    if (!response.ok) return currentRuntime;
    const payload = await response.json();
    const data = payload?.data ?? payload;
    if (!data?.id || !data?.operatorName) return currentRuntime;
    currentRuntime = {
      ...fallbackRuntime,
      ...data,
      icpNumber: data.icpNumber || fallbackRuntime.icpNumber,
      valueAddedTelecomLicense: data.valueAddedTelecomLicense || null,
      publicSecurityRegistration: data.publicSecurityRegistration || null,
      customerServiceEmail: data.customerServiceEmail || null,
    };
    document.documentElement.dataset.commercialTenant = currentRuntime.id.toLowerCase();
    document.title = `Fanjin ${currentRuntime.name}`;
    emit();
  } catch {
    // Runtime branding must never prevent the creation tools from booting.
  }
  return currentRuntime;
}

export function useTenantRuntime(): TenantRuntime {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getTenantRuntime,
    () => fallbackRuntime,
  );
}
