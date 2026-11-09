// locales/index.ts — migrated from fanjin-web (vue-i18n → standalone).
// react-i18next is not yet installed; this provides a lightweight drop-in.
// When ready, replace with: import i18n from "i18next"; import { initReactI18next } from "react-i18next";
import zhCN from "./language/zh-CN.json";
import en from "./language/en.json";

export const languageList = [
  { label: "简体中文", tips: "Chinese (Simplified)", value: "zh-CN" },
  { label: "English", tips: "English", value: "en" },
];

const LOCALE_STORAGE_KEY = "locale";

function getLocale(): string {
  try {
    return localStorage.getItem(LOCALE_STORAGE_KEY) || "zh-CN";
  } catch {
    return "zh-CN";
  }
}

export function setLocale(locale: string) {
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    // Force page reload to apply new locale
    window.location.reload();
  } catch {
    // ignore
  }
}

const messages: Record<string, Record<string, any>> = {
  "zh-CN": zhCN,
  en,
};

/** Deep-lookup a nested key like "workbench.production.chatBox.welcomeMessage" */
function lookupKey(obj: any, key: string): string | undefined {
  return key.split(".").reduce((acc, part) => (acc != null ? acc[part] : undefined), obj) as string | undefined;
}

/**
 * Simple translation function — same signature as vue-i18n's `t()`.
 * Replaces {name} placeholders if an object is passed as the second arg.
 */
export function t(key: string, params?: Record<string, unknown>): string {
  const locale = getLocale();
  let result = lookupKey(messages[locale], key);
  if (result === undefined && locale !== "zh-CN") {
    result = lookupKey(messages["zh-CN"], key);
  }
  if (result === undefined) {
    result = lookupKey(messages["en"], key);
  }
  if (result === undefined) return key;
  if (params) {
    Object.entries(params).forEach(([k, v]) => {
      result = (result as string).replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    });
  }
  return result;
}

/** Current locale value */
export const cachedLocale = getLocale();

// Attach to window for backward compatibility (used by old global.ts pattern)
if (typeof window !== "undefined") {
  (window as any).$t = t;
}

export default { t, languageList, setLocale, cachedLocale };
