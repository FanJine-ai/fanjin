// theme.ts — migrated from fanjin-web.
// Vue Pinia storeToRefs removed; reads font size from settings or localStorage directly.

const SETTINGS_STORAGE_KEY = "fanjin-react-v4:settings";

interface ThemeSettings {
  fontSize?: number;
}

function readThemeSettings(): ThemeSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // ignore
  }
  return {};
}

/** 初始化主题（在 App 组件 mount 时调用） */
export const initTheme = () => {
  const { fontSize } = readThemeSettings();
  // 强制浅色模式：移除任何 dark 标记
  document.documentElement.removeAttribute("theme-mode");
  document.documentElement.classList.remove("dark");
  if (fontSize) {
    document.documentElement.style.fontSize = `${fontSize}px`;
  }
};
