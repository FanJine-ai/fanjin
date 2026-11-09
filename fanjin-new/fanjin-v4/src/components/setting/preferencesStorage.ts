export type FanjinPreferences = {
  fontSize: number;
};

export const preferencesStorageKey = "fanjin-settings-preferences";
export const supportedFontSizes = [12, 13, 14, 16, 18, 20, 22] as const;

export const defaultPreferences: FanjinPreferences = {
  fontSize: 14,
};

function normalizeFontSize(value: unknown) {
  return typeof value === "number" && supportedFontSizes.includes(value as (typeof supportedFontSizes)[number])
    ? value
    : defaultPreferences.fontSize;
}

export function readPreferences(): FanjinPreferences {
  if (typeof window === "undefined") return defaultPreferences;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(preferencesStorageKey) || "{}");
    return {
      fontSize: normalizeFontSize(parsed && typeof parsed === "object" ? parsed.fontSize : undefined),
    };
  } catch {
    return defaultPreferences;
  }
}

export function savePreferences(patch: Partial<FanjinPreferences>, remote = false) {
  if (typeof window === "undefined") return defaultPreferences;
  const current = readPreferences();
  const next = { fontSize: normalizeFontSize(patch.fontSize ?? current.fontSize) };
  window.localStorage.setItem(preferencesStorageKey, JSON.stringify(next));
  window.dispatchEvent(new CustomEvent("fanjin-preferences-change", { detail: { ...next, remote } }));
  return next;
}

export function applyFontSizePreference(fontSize = readPreferences().fontSize) {
  if (typeof document !== "undefined") {
    document.documentElement.style.fontSize = `${fontSize}px`;
  }
  return fontSize;
}
