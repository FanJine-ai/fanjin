import { apiGet, apiPost } from "../api/http";
import { THEME_CHANGE_EVENT, setThemeMode } from "./theme";
import { applyFontSizePreference, savePreferences } from "../components/setting/preferencesStorage";
export type SyncedUiState = { revision: number; theme: "light" | "dark" | null; fontSize: number | null; readIds: string[];
  notifications?: { kind: string; body: string }[] };
type Patch = { theme?: "light" | "dark"; fontSize?: number; readIds?: string[] };

function isUiState(value: unknown): value is SyncedUiState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return Number.isSafeInteger(state.revision) && Number(state.revision) >= 0
    && (state.theme === null || state.theme === "light" || state.theme === "dark")
    && (state.fontSize === null || [12, 13, 14, 16, 18, 20, 22].includes(Number(state.fontSize)) && typeof state.fontSize === "number")
    && Array.isArray(state.readIds) && state.readIds.every(id => typeof id === "string")
    && (state.notifications === undefined || Array.isArray(state.notifications) && state.notifications.every(item =>
      item && typeof item === "object" && typeof item.kind === "string" && typeof item.body === "string"));
}

// Serialize reads and writes so a slow poll cannot overwrite a newer local edit.
// Stopping on account/workspace switch also cancels all not-yet-started calls.
export function startUiStateSync(apply: (state: SyncedUiState) => void, previousReadIds: string[] = []) {
  let stopped = false, queue = Promise.resolve(), polling = false, first = true;
  const accept = (state: unknown) => {
    // A missing/older endpoint or malformed reply must leave local UI state intact.
    if (stopped || !isUiState(state)) return;
    if (state.theme) setThemeMode(state.theme, true);
    if (state.fontSize) applyFontSizePreference(savePreferences({ fontSize: state.fontSize }, true).fontSize);
    apply(state);
  };
  const enqueue = (action: () => Promise<void>) => {
    queue = queue.then(async () => { if (!stopped) await action(); }).catch(() => {});
    return queue;
  };
  const patch = (value: Patch) => enqueue(async () => { accept(await apiPost<unknown>("/account/uiState", value)); });
  const poll = () => {
    if (polling || stopped) return;
    polling = true;
    void enqueue(async () => {
      let state = await apiGet<unknown>("/account/uiState");
      if (!isUiState(state)) return;
      if (!stopped && first && state.revision === 0 && previousReadIds.length) {
        state = await apiPost<unknown>("/account/uiState", { readIds: previousReadIds.slice(-2000) });
        if (!isUiState(state)) return;
      }
      first = false; accept(state);
    }).finally(() => { polling = false; });
  };
  const theme = (event: Event) => { const d = (event as CustomEvent).detail; if (!d?.remote && ["light", "dark"].includes(d?.mode)) void patch({ theme: d.mode }); };
  const font = (event: Event) => { const d = (event as CustomEvent).detail; if (!d?.remote && d?.fontSize) void patch({ fontSize: d.fontSize }); };
  window.addEventListener(THEME_CHANGE_EVENT, theme);
  window.addEventListener("fanjin-preferences-change", font);
  window.addEventListener("focus", poll);
  const timer = window.setInterval(poll, 10_000); poll();
  return { patch, stop() { stopped = true; window.clearInterval(timer); window.removeEventListener("focus", poll);
    window.removeEventListener(THEME_CHANGE_EVENT, theme); window.removeEventListener("fanjin-preferences-change", font); } };
}
